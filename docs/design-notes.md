# Design notes

Why the code is shaped this way. For what the states on screen mean and what to
do about them, see [Reading the graph](reading-the-graph.md); this file is the
reasoning behind the code rather than a guide to using it. Written for whoever picks this up next, so the
decisions that look wrong on first read don't get "fixed" back into the bugs
they were working around.

Dated sections. Later passes append rather than rewrite.

---

## Why this is its own extension and not part of Web Support (2026-09-11)

Message Flow needs the web administrator to host its UI, so an earlier version
shipped as a fork of the Web Support plugin: it repackaged `oie-webadmin.war`,
merged `websupport-shared.jar`'s classes with its own into a single jar,
declared Web Support's server classes in its own `plugin.xml`, and replaced Web
Support on install.

Two premises justified that, and neither holds.

**Web Support already discovers other extensions' web UIs.** Its
`getWebPluginPaths()` iterates `ExtensionController.getPluginMetaData()` and
`getConnectorMetaData()`, which is every installed extension, not its own
metadata. For each one it checks `<extensions>/<path>/webadmin/plugin.json`,
gated on the extension being enabled and its path matching `[A-Za-z0-9._-]+`.
`getWebPluginResource()` serves files from the same place, canonicalized and
prefix-checked against the extensions directory. So any extension that ships a
`webadmin/plugin.json` is picked up without being merged into anything.

**Multiple `<library>` elements on one `pluginMetaData` work.** The fork's
`plugin.xml` recorded the opposite as an open question and merged jars to avoid
depending on it. `simple-channel-history` has shipped four `<library>` entries
across three types since 2.8.0.

Consequences of the fork that went away with it: a rebuild and reship on every
Web Support release, no ability to install plain Web Support alongside it, an
uninstall-Web-Support-first step, and a 6.3MB package that is now 45KB.

**What this costs:** Message Flow is useless without Web Support installed, and
nothing enforces that. The `plugin.xml` description says so; the engine has no
inter-extension dependency mechanism to express it.

## Why the topology is parsed out of export XML with regular expressions (2026-09-11)

The routing parsers read each channel's serialized export XML rather than
walking `Channel`'s model objects. That is inherited: this logic is a port of
Mirth DB Explorer's Topology tab, which read channel XML out of Postgres because
that was all it had. Running in-process, the XML now comes from
`ObjectXMLSerializer` instead of a database, but the parsing is unchanged.

Keeping it that way is deliberate. The regexes were already correct against real
channel exports, and rewriting them into model traversal would be a behaviour
change with no visible benefit and several ways to silently lose an edge. The
tests in `MessageFlowParsingTest` exist to pin the behaviour so that rewrite
stays optional.

The parsers carry two rules that look arbitrary:

**`<enabled>` is taken as the last match in a connector block.** It appears once
per transformer step as well as once for the connector, and only the connector's
own value decides whether the destination runs. A disabled transformer step
ahead of an enabled connector must not win.

**Quotes are matched both literally and entity-escaped.** Scripts arrive as XML
text content, so `router.routeMessage('X')` may appear with `'` or `&apos;`.

`isPositionCommentedOut()` tracks string-literal state while scanning for
comment markers. Without it, a `//` inside an ordinary string, a logged URL for
instance, reads as a comment opener and silently drops every routing call after
it. It is not a full tokenizer: template literals and regex literals are not
handled.

## Why ancestors come from the Source Map and descendants from a scan (2026-09-11)

**Ancestors are free.** The engine writes both the immediate parent
(`sourceChannelId`/`sourceMessageId`) and the accumulated chain
(`sourceChannelIds`/`sourceMessageIds`) into a routed message's Source Map on
every Channel Writer and `router.routeMessage()` hop. Reading them is one lookup
and no searching. This is more reliable than matching on the HL7 MSH-10 control
ID, which is what the original per-message tracer did: a transformer that
regenerates that ID breaks control-ID matching, while the Source Map entries
survive because the engine writes them itself as part of routing.

**Descendants have no index.** There is no server-side way to ask "which message
came from this one": `MessageFilter` supports message ID ranges, dates, status,
custom metadata columns and content search, but nothing over raw Source Map
keys. So the trace uses the topology adjacency to know which channels are even
reachable, bounds each candidate search by `startDate` = this message's received
time, since a descendant cannot predate its ancestor, and checks candidates
per channel per hop.

**Each candidate costs two reads, not one.** `getMessages()` returns lightweight
summaries for grid display without connector-message content, so every
candidate's Source Map reads as null and nothing ever matches. The scan
re-fetches each candidate through `getMessageContent()`. The symptom when this
was wrong: ancestors always worked, descendants never found anything, even for a
chain known to exist.

**The ceiling is on total lookups, not just depth.** Depth and per-channel
limits do not bound the work, because the walk recurses per match and a wide
graph multiplies them together. `MAX_TRACE_LOOKUPS` caps reads for the whole
request, and the response carries `truncated` so an incomplete chain is
distinguishable from an empty one in the UI.

## Parsed routing is memoized per channel revision (2026-09-11)

Serializing a channel and running the routing regexes over the result is the
expensive part of every request here, and both the topology graph and the
trace's adjacency need it. Done naively that is a full serialization of every
channel on the engine per request, twice during a trace, and once more every
time someone opens the Message Flow tab in the channel editor.

`ROUTING_CACHE` holds the parsed result keyed by channel id, valid only for the
revision it was parsed from. The engine bumps a channel's revision on every
save, so a stale entry cannot be served: a channel that changed has a different
revision and is reparsed. A channel carrying no revision is never cached.

The cache is cleared wholesale when it exceeds a fixed size. That is crude on
purpose. Entries are small, the only thing it guards against is unbounded growth
as channels are created and deleted over a long uptime, and the next request
repopulates what it needs. It is not pruned against the current channel list,
because that list is redacted per user and pruning it would evict entries
belonging to other users.

## Errors carry a reference, not a cause (2026-09-11)

`serverError()` logs the exception server-side against a short random reference
and returns only that reference to the caller. An exception message can carry
SQL text, internal paths, or message content, none of which belongs in an HTTP
response that reaches a browser. The reference is what ties the user's report to
the log line.

`notFound` and `badRequest` still carry their own text, because that text is
written here and says nothing the caller does not already know.

## Any channel can be routed to (2026-09-12)

A Channel Writer or router call dispatches into the target channel regardless of
its source connector type. Verified on a live engine: four JavaScript Reader
channels are routed to, and one of them received and processed routed messages
that were then traced back to their sender.

This matters because the overview distinguishes channels nothing routes to by
source connector, and the reason is easy to state wrongly. It is not that a
Channel Reader is the only thing that can be routed to. It is that a Channel
Reader has no other way in, so nothing routing to it means nothing reaches it,
while a listener or reader has its own input and may be routed to as well.

Not verified: whether a File Reader can be routed to. It is the one type where
this may not hold, and nothing here depends on the answer.

## One question, one place on the overview (2026-09-12)

The landing page described the same fact twice and in two shapes. A card called
"lose the trail" drew its own table of channels, while *Where message tracing
will fail* sat below it saying the same thing with different columns. Neither
name matched the engine-stats line at the top, which said "cannot be traced".
Three phrasings, two tables, one fact.

The card now has no table of its own. It narrows the page to the section that
was already there, the way the routes card narrows to the routing table, and it
carries the same name the stats line uses. The section is the one worth keeping
because naming a channel is not enough: the two ways a trail is lost have
different remedies, so a row needs a cause and a fix, and the card's own table
had one unlabelled column for both.

That column is the second defect, and it is worse than a presentational one. It
was headed "Messages received" and rendered `traceGapCause` whenever the channel
had one, so a channel on METADATA storage showed its storage setting where its
count belonged. The header was added to a column that already held the cause and
the cause kept winning the ternary. It reached the no-inbound-route list too,
because the server sets `traceGapCause` from storage properties alone, with no
reference to routing, so any channel in that list could carry one. The prose
above that table counts the same channels and tells the reader that N of them
have received messages, then the table hid the numbers it had just cited.

A storage setting is not a message count, and it is not a reason a count is
missing either. The counts are engine statistics, which are counters: a channel
keeps them whatever its storage mode does, including DISABLED. There is no case
where the storage setting explains an absent count. The column holds the count
and nothing else.

## The no-inbound-route caveat is four answers, not one paragraph (2026-09-12)

`noRouteInCaveat` built its parts as an array and returned `parts.join(" ")`. On
the live engine that came out as six sentences and about 700 characters of
11.5px text in a single block. Because `.mf-section-note` caps at `80ch` and the
table directly under it is `width:100%`, the paragraph stopped well short of the
table's right edge and read as a narrow left-hand column that nothing had asked
for. The width cap was not wrong on its own; it stopped matching what sits next
to it once the text grew.

The four parts answer four different questions, so they are labelled and shown
as rows of a two-column grid: what was found, what could still reach them, why
the source connector matters, what to check next. A reader who only wants the
last one no longer has to read the other three to find it, and a part with
nothing to say is left out rather than appearing as an empty label.

A `?` tooltip was considered for the detail and rejected: about 600 characters
is too much to put behind a hover. Nothing is hidden, it is only sorted.

## The routing graph draws cards, not orbs (2026-09-12)

The graph drew each channel as a glossy radial-gradient circle with a blurred
glow halo and its label parked in a translucent card underneath. Two
consequences, both visible on any real engine: the labels collided with each
other at any workable node spacing, and because the edges were appended to the
SVG after the nodes they were painted over the labels, so a channel's own name
was unreadable in the middle of its own fan-in.

A node is a card now, with the name and connector inside it and the colour moved
to a stripe down the left edge, which makes the node the size of its own label
and means nothing can overlap by construction. Edges are drawn in a group before
the nodes. The node icon went with the circles: the card already names the
source connector directly underneath, so the glyph repeated the label, and on an
engine whose channels are all one connector type it drew the same symbol on
every node.

Widths are measured in pixels at the size each line is actually drawn. The first
attempt counted a name character as 0.64 of a subtitle character, when the name
is 12.5px bold and the subtitle 10.5px regular, so names were ellipsized on
cards with room to spare. The budget also has to exclude the 44px reserved for
the edit chip, which is a second thing that same arithmetic got wrong.

Every card carries both actions a channel name carries in the tables: the name
opens that channel here, an edit chip opens it in the editor. The trace chain
had no click handling at all before this, so a reader who traced a message and
wanted the channel it landed in had to go and find it in a table.

## Ten routes into one channel (2026-09-12)

A fan-in was the shape every defect showed up in. Ten straight edges converging
on a point from ten angles piled ten arrowheads into a spiky star, and the row
pitch was set by the tallest card in the graph, so ten 46px cards were spaced as
though all of them were as tall as the one grown target.

Edges leave and arrive horizontally, so every arrowhead points the same way.
Arrivals are spread down the target's left edge at a fixed pitch, and the target
grows to `max(46, (n-1) * 12 + 26)` so that every arrival lands on the card's own
edge rather than in the space beside it; capped, because a hub with forty
inbound routes would otherwise be a ribbon. Columns pack by each card's own
height.

Ports are handed out in the order the edges approach, which is not the same as
the order their sources sit in whenever an edge is routed anywhere but straight.
Getting that backwards was the crossing that survived several rounds of curve
work: an edge that went around something got a port matching where it started
rather than where it was coming from, and had to cross its neighbours in the
last few pixels to reach it.

## dagre, and why it is not here (2026-09-12)

@dagrejs/dagre was added for layout and then removed, and the reason is worth
keeping because the same argument will be made again.

It was the right instinct. What was here was BFS levels with a barycentre
ordering pass, which is the crossing-reduction half of a layered layout and no
more, and dagre does rank assignment, ordering and edge routing properly. It is
MIT, its ESM build bundles graphlib so it has no imports of its own, and Web
Support serves any file under an extension's `webadmin/`, so vendoring it beside
`plugin.js` shipped it inside our own zip with nothing to fetch at run time.
That mattered: OIE runs air-gapped.

It made the graph worse, twice, and both times the fault was in how it was used.
First only its coordinates were taken and the edges were drawn as direct curves,
which put them through the cards dagre had reserved space to route around.
Then its bend points were followed for every edge, including ones with a clear
run, which detoured around nothing: that was the swooping.

What actually fixed the picture was not a better integration. It was capping the
graph at one hop and letting a line cross a card. With one hop every node is at
-1, 0 or +1, so there are no multi-rank spans to route around, and with crossing
allowed there is nothing to route around anyway. Both of dagre's contributions
had been made unnecessary by making the question smaller, so 50KB of vendored
dependency was earning nothing and went back out.

The lesson is the ordering, not the library: the question was narrowed after the
dependency was added rather than before, and narrowing it first would have meant
never reaching for one. dagre remains the right answer for a graph that genuinely
needs layered layout with multi-rank edges. This one does not.

## Crossing a card, rather than avoiding it (2026-09-12)

Routing around obstacles produced every swooping curve in the graph, and it was
solving a problem the reader does not have: a line crossing a card is only a
problem if you cannot tell which line it is. So nothing is routed around
anything. Every route is one curve from its source's right face to its arrival
port, and hovering a route picks out that route alone, fading every other edge
and any card it passes over so the line can be read across them. Each edge
records what it crosses at render time, so the hover is a lookup rather than a
hit test.

Hovering a route highlights that one route, not every route of its kind.
Following a single line through a busy graph is what a reader actually does; the
kind-wide highlight lives on the legend, which is where "show me everything that
writes no source map" belongs.

## The canvas is measured, not calculated (2026-09-12)

The SVG was sized from the column count, the column gap and the widest label.
That is a guess about the drawing rather than a measurement of it, and it was
wrong in both directions at once: 274px of empty space on the right and 58px of
the drawing clipped off the left. Two things are drawn outside every card's box,
which no formula over the cards alone can see: a route between two channels in
the same column bows out past the first column, and a self-loop reaches past the
right of its card. Anything drawing outside a card now reports its extent, and
the viewBox comes from that plus 16px.

The bow depth was its own bug. It was proportional to the vertical distance with
nothing bounding it, so two channels at opposite ends of a tall column produced
a 244px arc swinging clear of the drawing. It is capped: past a point a deeper
bow adds width without making the route any easier to follow.

## A route call read only in part (2026-09-12)

Source Code Search matches one line at a time. A call whose arguments run onto
the next line therefore arrives cut off at the break, and read alone that line
is indistinguishable from a computed target: `routeMessage(` and
`routeMessage(target,` both have no literal first argument. It was classified as
computed, so a plain literal target sitting on the next line was reported as
"determined at run time".

The server does not have this problem. It parses the channel's script as one
string and the `\s*` after the paren spans the line break, so it resolves the
target and draws the edge. The two halves of the plugin then disagreed about the
same call: the map showed a resolved route while the table beside it called the
target computed.

A call whose argument list is still open at the end of the line is now its own
case. It is not shown as computed, because saying the target was not read is
true and saying it is computed is a guess that is wrong on a split literal. The
depth counter that decides this is quote-aware, so `routeMessage('A(B', ...)`
reads its target rather than seeing an unbalanced paren.

Two things followed from getting this wrong the first time. Excluding these
calls from the unresolvable list also dropped them from the routing table's
orphan rows, so a call the map could not draw at all became invisible: correct
classification is not the same as correct handling, and the second was missed.
And the routing row for a resolved one said "not found by Source Code Search",
which is false -- the search found the call; `callFor` could not tie it to the
edge because the split had taken away the target there was anything to match on.
It now says the call was found but split, which sends the reader somewhere
useful.

The limitation is stated in the UI rather than left to be inferred. A section
lists every such call with its location, its line number and the line as
matched, and says what to change: writing the call and its first argument on one
line is all it takes. They are listed on their own rather than among the routes,
because the one thing that can be said about all of them is about the source
rather than about the routing. The graph draws the route where the parser
resolved one and nothing where it did not; it invents no node for an unread
target, because the reason and the remedy do not fit on one.

## What the fork left behind (2026-09-12)

The fork of Web Support was abandoned some time ago and the reasoning is
recorded above, but its files stayed in the tree and went on describing an
arrangement that no longer exists:

- `build.sh`, `build.ps1` and `build.bat` built `websupport_with_flow-1.0.0.zip`,
  merging Web Support's own jar with this plugin's classes. Referenced by
  nothing, and they would produce the 6.3MB package the fork was dropped to
  avoid.
- A `plugin.xml` at the repository root declared Web Support's own
  `WebSupportServlet` as an `apiProvider` and one merged shared jar, with a
  comment explaining that multiple `<library>` elements could not be confirmed
  to work. They do; the note above records checking. The file the build actually
  packages is `package/resources/plugin.xml`, which differs from the packaged
  copy only by Maven's version filtering.
- `src/` held the flat source tree as first received, superseded by `server/`
  and `shared/` and diverged from both. Two copies of `MessageFlowServlet.java`
  in one repository is a trap for whoever edits the wrong one.

All removed. The build is unchanged by it: same 39 Java tests, same five files
in the zip. Deleting dead build scripts is safe in a way deleting dead code is
not, because a build script that is never run cannot be quietly depended upon,
and running the build afterwards proves it.

## Comments, on both sides of the plugin (2026-09-12)

The server has a real scanner. `isPositionCommentedOut` tracks line comments,
block comments and string literals, including the entity-escaped `&apos;` and
`&quot;` forms it meets in serialized channel XML, and every script route runs
through it: `collectRoutes` is the only place routes are gathered and it skips
any match whose position is commented. It is unit-tested and covered end to end.
Its stated limit is that it is not a full tokenizer, so a comment opener inside
a template literal or a regex literal is not understood.

The client had one line: a pattern anchored at the start of the trimmed text,
catching a line that begins with a line-comment marker and a continuation line
of a block, and nothing else. A call wrapped in a block comment on one line
begins with a single slash, which is neither, and a call after a trailing line
comment does not begin the line at all. Both were reported as real calls, and
because the server correctly gives them no edge, they arrived in the routing
table as routes the map could not account for: dead code presented as routing.

It scans to the call now, tracking quotes, so a URL in a string is not a comment
opener and a call quoted inside a string is not a call. What a single line
cannot settle is a call inside a multi-line block comment whose own line carries
no marker: nothing in that line says so and the search returns no surrounding
context. The server excludes it from the edges regardless, so the graph is right
and only the table can be fooled.

Worth recording how this was nearly got wrong twice. "The server is fine, it has
`isPositionCommentedOut`" was said from a grep that found the definition, which
proves a function exists and not that anything calls it -- the same mistake as
reading `builder.save()` and reporting that a file is rewritten. It is called,
checked afterwards at the call site. And the comment explaining the fix quoted a
block-comment terminator as an example, which closed the comment early and took
the module and twenty-nine tests down until the example was described instead of
quoted.

## The search asks for exactly what it accepts (2026-09-12)

`fetchRouteCalls` queried Source Code Search for the substring "routeMessage"
and filtered the results with `ROUTE_CALL`. Measured against a live engine, that
query is a case-insensitive contains, loose in both directions: "ROUTEMESSAGE"
matches, and so does the tail of `myRouteMessageHelper(`. Neither is a statement
that can run, and every one of them crossed the wire only to be discarded on
arrival.

The search takes a Java regex, and `\b`, `(?:...)` and `\s` mean there what they
mean here, so `ROUTE_CALL` itself is now the query, sent case-sensitively
because the language is. A test asserts the pattern sent equals the pattern
applied, which is the whole point: two copies of one pattern will drift.

Verified rather than assumed. The regex mode is an unanchored find matched per
line (`^routeMessage` returns fewer, a literal newline returns none), and the
pattern and the loosest possible query return the same fourteen distinct lines
on that engine, including `routeMessageByChannelId` and the `router.` forms.

The change provably loses nothing, and that argument is structural rather than
empirical: `ROUTE_CALL` filters client-side either way, so anything the query
stops transporting was already being thrown away.

A first attempt also added a fallback to the old query "for an older Source Code
Search without regex support". No such version is known to exist, the repo
records no minimum version, and the claim was invented and then written into a
comment as fact. It was removed. A search that cannot be reached is unavailable,
which the UI already says plainly, and a retry would defend a failure nobody has
seen.

## The legend was there and invisible (2026-09-12)

Commit `e2ddb63` deleted `.mf-legend`, `.mf-legend-line` and `.mf-legend-dot`
from the stylesheet and left the markup that depends on them. A swatch is an
empty `<span>` carrying only a background, so with no `display`, `width` or
`height` it renders at zero size, and the container losing `display:flex` and
`gap` ran seven entries together into one unbroken line that overflowed the
pane. The graph therefore looked as though it had never had a legend, which is
how it was reported: coloured and dashed lines with nothing saying what they
meant. A legend nobody can see is worse than none, because it stops anyone
asking for one.

The rules are back, and the entries now cover the nodes as well as the lines.
They never did: the two solid fills a reader sees most often, the channel being
viewed and every other channel on the engine, had no entry at all while three
rarer dashed states did. The swatches use the same colour literals the
gradients draw with, so changing a node's colour without the legend shows up
rather than passing silently, and the tests assert both the rules and the
entries because the markup alone looked perfectly healthy in review.

## A channel appears once per table, not once per edge (2026-09-12)

*Where message tracing will fail* emitted one row per untraceable edge, and the
row carried nothing that distinguished one edge from another: channel name,
fixed cause, fixed remedy paragraph. A channel with three `router.routeMessage`
calls printed three identical rows and the remedy three times. Measured rather
than reasoned about, by rendering a four-channel engine with three calls out of
one channel: four rows, three byte-identical.

The two causes were also emitted as separate blocks, every routing row and then
every storage row, so a channel with both had its rows at opposite ends of the
table on any engine with more than one channel.

Rows are grouped by channel now, each reason stacked against its own fix in the
same order, following what *Other destinations* already does with a channel's
destinations. The calls are named in the cause, because the call is the part
that actually differed between the rows this used to print, and the count is
what tells a reader how much there is to change.

The routing table had the same defect and a wider spread of it, found by asking
where else on the landing page one channel appears more than once. It groups its
rows by source channel, but only over the resolved edges. The routes whose
target could not be resolved and the Channel Writers with a template target were
built as two further blocks and concatenated after that grouping, so a channel
with all three headed a group near the top of the table and then reappeared
twice further down, under other channels' names, in the same table.

Measured the same way: a channel routing three ways produced four linked
mentions in the routing table, at three separate places. Each kind is turned
into a row of the same shape now and the grouping happens once over all of them,
so the channel heads one group holding all four of its routes, keyed by id so
two channels sharing a name are not merged.

What is left is one group header and one mention in another channel's *To* cell,
because that channel routes to it. That one is not a duplicate. It is the table
saying where a message goes, and the test pins it so a later attempt at
deduplication does not remove it.

## A trace says why it stopped, and draws what it cannot confirm (2026-09-12)

A trace from MF_Source for message 4 drew MF_Source to MF_Billing and ended
there, with no explanation. The picture was right and said nothing, so it read
as though the message simply stopped.

The first diagnosis of this was wrong and the way it was wrong is the point. The
dashed MF_Billing to MF_Archive line was read as the warn-coloured dash the
legend calls a script route that writes no source map. It was the `text-faint`
dash next to it in the same legend, which means disabled. Three dash patterns
sit within a few pixels of each other in that legend and two of them are close
in colour on a dark ground, so the map was reporting a switched-off destination
and the fix that got written explained unsent source maps. The landing page had
already labelled the destination "disabled" in its routing table, which is where
this should have been settled, and was not.

The two causes need different words because they are different facts. A route
that writes no source map dispatches the message and loses the record of it, so
something downstream exists and cannot be linked. A disabled route dispatches
nothing at all, so there is no downstream message for a trace to fail to find.
The second is the definite one and is checked first. A script route has no
enable switch, so it never counts toward "every route onward is disabled", which
keeps the two from being confused in the code the way they were by eye.

Two faults behind it. Every "why it stopped" note was gated on
`descendants.length === 0`, so a trace that moved one hop and then hit the gap
explained nothing. And all three checks asked about `traceResult.channelId`, the
channel traced *from*, rather than the channel the chain ended at. Those are the
same only when the scan moved nowhere, which is the one case the gate allowed
through, so the second fault was invisible behind the first.

Both now key off the last node in the chain. Where the routing map knows what
comes next, that channel is drawn as an extra node with a `?` carrying the
reason, joined by the line the routing map uses for that same route: the
`text-faint` 4,3 dash for a disabled destination, the warn 6,3 dash for a route
writing no source map, the violet 2,3 dash for a target chosen at run time. One
table decides it, so the two diagrams cannot drift apart, and a reader who has
just looked at the map above does not have to work out that these are the same
thing. Given how this was misdiagnosed, having the trace draw a hop in a
different style from the map would have hidden it for longer.

The claim is deliberately narrow. Drawing MF_Archive says the route exists and
the trail ends before it. It never says message 4 went there, which is exactly
what no one can know once the source map is not sent, so the node carries no
message id and a word for its condition rather than a status. The disabled case
carries its own hedge: the map reads the channel as configured now, not as it
was when the message ran, and the wording says so rather than asserting that
nothing was dispatched months ago. A computed target
gets the same treatment with the node named "determined at run time", since the
map cannot even say which channel it is.

Where a channel has several untraceable onward routes the node is labelled with
the count and the `?` names them all, rather than branching a chain whose whole
shape is a straight line.

Verified against the live engine rather than against a fixture, and the fixture
was the weaker test. MF_Billing really does have two disabled destinations: one
pointing at MF_Archive and one a Channel Writer with no target at all. That
second one caught a wording bug the invented fixture could not, because falling
back on a missing `toName` described a Channel Writer set to None as "a channel
the map cannot resolve", which is a different thing, and the phrase ran straight
into the clause after it. Each destination is now named with what it points at,
through one `routeTargetLabel` that separates None, restricted and genuinely
unresolvable, and the node is labelled for the real channel among the targets
rather than counting None as one of them.

The engine also settled the question the earlier pass could not answer from the
screenshot: both of MF_Billing's destinations are off, so the trail really does
end there for the reason the note gives. The topology came from the plugin's own
endpoint, so what was checked is what the plugin produces, not a reading of the
channel XML that happens to agree with it.

## Only Channel Writer records lineage (2026-09-11)

`VmDispatcher`, the Channel Writer connector, is the only thing that writes
`sourceChannelId`/`sourceChannelIds` and the matching message ids. It appends
the current channel to the list on every hop.

`VMRouter` writes none of it. `routeMessage()` and `routeMessageByChannelId()`
forward whatever source map the caller attached to the `RawMessage` and add
nothing:

    return new RawMessage(message.getRawBytes(), message.getDestinationMetaDataIds(), message.getSourceMap());

So a hop made by `router.route*` leaves no trace in the destination, and the
trace's ancestor chain stops there. This is not a display gap, it is missing
data. The engine PR that mentions `sourceChannelId` (`fc08297b9`, Dec 2025) adds
a tooltip to the Swing message browser and records nothing new.

Two consequences worth holding onto.

Harvesting Source Maps across channels to derive "observed" routing edges would
only ever rediscover Channel Writer routes, which the static parser already
finds. It would not resolve dynamic targets or code-template routing, because
those are `router.route*` calls that record nothing. That idea was considered
and dropped for this reason.

A channel author can opt in: `RawMessage` takes a source map as its third
argument, so passing `sourceChannelId` and `sourceMessageId` explicitly makes a
`router.route*` hop traceable. Worth documenting for users who care about
lineage more than about brevity.

## No changes to OIE core (2026-09-11)

A constraint on this plugin, decided deliberately rather than by accident.

The clean fix for script routing not recording lineage is in the engine: give
`VMRouter` the calling channel's context and have it stamp the source map the way
`VmDispatcher` does. That was designed out and rejected on scope. `VMRouter` is
core message-routing machinery, a change there lands in every channel on every
engine, and a tool that depends on it is unusable until the change ships and each
site upgrades to it.

So this plugin works with a stock engine and defines what it can verify instead.
Where the engine cannot record something, the plugin says so and names the fix,
rather than showing an incomplete picture as though it were complete.

If the engine change is ever written, the shape is already established by the
Route with Sources library, including one place it differs from `VmDispatcher`:
it creates the plural `sourceChannelIds`/`sourceMessageIds` lists on the first
hop, where `VmDispatcher` only creates them from the second. Either is fine, but
it should be chosen rather than stumbled into. This plugin reads both.

## Recognising the Route with Sources convention (2026-09-11)

Tony Germano's Route with Sources library (MPL-2.0, in
nextgenhealthcare/connect-examples) is the community answer to script routing
recording no lineage. It wraps the router and stamps exactly the four keys this
plugin reads: `sourceChannelId`, `sourceChannelIds`, `sourceMessageId`,
`sourceMessageIds`.

Its functions are called **bare**: `routeMessage('X', msg)`, with no `router.`
prefix. The parser originally matched only `router\.routeMessage\(`, so every
call made through the library was missed and a channel following the traceable
convention drew no edges at all. The channels doing the right thing rendered as
dead ends. A negative lookbehind now separates the two forms, and the edge
carries whether the hop records lineage.

Matching a bare `routeMessage(` is looser than matching the prefixed form, and
someone's unrelated function of that name would produce a phantom edge. The first
argument still has to be a quoted literal that resolves to a real channel, which
keeps that surface small, and such edges are labelled as coming from the
convention rather than asserted identically.

The library substitutes `"NONE"` for the channel id and `-1` for the message id
when called with no message in scope, such as from a deploy script. Those name
nothing real and are dropped from the front of a chain rather than reported as a
deleted channel.

## Six reasons a trace comes back empty (2026-09-11)

Reporting all of them as "no descendants found" sends the reader hunting for a
routing bug that may not exist. Three are detectable from data already in hand
and are surfaced as traceability gaps:

- the hop used `router.route*`, which records no lineage (detected: the edge
  carries `traceable: false`)
- the channel's storage mode is `RAW`, `METADATA` or `DISABLED`, none of which
  store maps (detected from `ChannelProperties`; verified against
  `DonkeyEngineController`, where `RAW` and `METADATA` both call
  `setStoreMaps(false)`)
- the channel removes content on completion, which deletes the source map,
  since lineage is content rather than metadata (detected)

The other three are stated in the empty-result message because they cannot be
detected here: the message genuinely was not routed onward, a downstream message
was pruned, or the scan limits were reached (this last one is reported
separately as `truncated`).

## What a destination does is not knowable from configuration (2026-09-12)

A table of every non-Channel-Writer destination was headed "External
destinations (where data leaves the engine)". That asserts something the
configuration does not say.

On the engine this was built against, sixteen of seventeen entries are
JavaScript Writers named Hold, Reprocess, Apply Status and Route Cancellation. A
JavaScript Writer runs whatever its script says: it may call out of the engine,
write locally, do nothing, or route onward with router.routeMessage, in which
case the same connector appears in the routing table too. The seventeenth entry
was a Channel Writer, which by definition does not leave the engine at all, so
the heading contradicted a row of its own table.

The honest statement is what the map actually knows: this is a destination that
is not a channel-to-channel route. What it does is a property of the connector
and, for the script-based ones, of the script. The section says so and does not
guess.

Same correction applied to the graph tooltip, the legend, and the "no
destinations at all" figure, all of which repeated the claim.

## The platform client opens the XStream envelope (2026-09-12)

`core/api.js` parses every response through `unwrap()`, which strips a single
root key. So a caller of `platform.api.get` receives the *contents* of
`SearchResults`, while curl shows the envelope
`{"com.diridium.sourcecodesearch.SearchResults": {...}}`.

Reading only the envelope form meant `byChannel` was empty in the browser and
every script route reported "not found by Source Code Search", while every
harness here passed, because each one replayed a raw body fetched with curl. The
test reproduced the transport, not the client.

Both shapes are accepted now, and the test uses the opened form first, since that
is the one the product actually receives. The general lesson: a fixture captured
from curl is not a fixture of what the page sees, and any client that normalizes
responses makes the two genuinely different.

## Source Code Search is a dependency, not an enhancement (2026-09-12)

Decided deliberately, reversing an earlier position.

The routing map reads channel configuration. That tells it a route call exists
and what literal it matched, and nothing else about it: not where in the channel
it is written, not what the call says, not whether the target is computed, and
not that a call exists inside a code template at all. Every one of those is
something a reader needs before they can act.

Version 1.7.0 derived the location server-side, from the offset the parser
already had, so the plugin could answer it alone. That code is deleted. Source
Code Search returns a richer breadcrumb than it produced ("Source > Transformer >
Step 2 (JavaScript): name" against "Source Transformer"), plus the line number
and the source line itself, and keeping a second, worse answer alongside it is
two sources of truth for one fact.

The trade is that script routing is unreadable without a second plugin. Accepted
knowingly: it is free, fast, on the same engine, and the alternative is
reimplementing a code search inside a routing map. The UI states the requirement
rather than quietly showing less.

What remains built in: Channel Writer routing, which is configuration and always
available, and the script parser, which still resolves targets to draw edges and
to build the trace's adjacency server-side.

Also replaced a hand-rolled XStream list unwrapper with `api.asList`, which the
platform provides and which Source Code Search itself uses. Writing it twice was
the mistake; the platform helper also handles cases mine did not.

## Where a route is written (2026-09-11)

A route reaches another channel from one of two quite different places: a
Channel Writer destination, which is configuration, or a line of script. The
script can be almost anywhere a script runs, which is both transformers, both
filters, a destination's response transformer, and the preprocessor,
postprocessor, deploy and undeploy scripts.

The routing table used to label this column "Via destination" and put the
destination connector's name in it for a Channel Writer and the call text in it
for a script. That fitted one of the two cases and misdescribed the other, and
said nothing about where a script route actually lives.

`sectionsOf()` builds the spans of a channel's XML that correspond to each place
a script can run, and a route is reported against the **smallest** span
containing its match offset, so a call in a destination's response transformer
reads as "Billing: Response Transformer" rather than merely as being somewhere in that destination. The
parser already had the offsets; it was throwing them away.

Declaration order matters here and bit once. `NO_ROUTING` is constructed during
class initialization and its constructor parses, so every pattern that parsing
reaches has to be assigned before it. The span patterns are therefore declared
with the others at the top of the class rather than beside the method that uses
them.

This makes the location available without Source Code Search, which then adds
only the line number and the code-template reach rather than being the sole
source of the answer.

## Borrowing from Source Code Search rather than reimplementing it (2026-09-11)

Two things this plugin cannot do from channel export XML: say where in a channel
a route call is written, and see routing inside code templates, which are
separate objects and not part of any channel's configuration. The design notes
previously recorded the second as a blind spot with no fix.

OIE Source Code Search answers both. Its `SearchMatch` carries `channelId`,
`channelName`, `groupType`, `location`, `lineNumber` and `lineText`, and it
searches code templates as well as channels.

The call is made from the client through `platform.api`, not from the server.
That keeps the coupling at zero: no entry in `plugin.xml`, no compile-time
reference, no server-side import, and feature detection is simply whether the
call succeeds. Absent plugin, missing `PERMISSION_SEARCH`, or a changed response
shape all degrade to the unenriched table.

Two shapes to respect. The response is XStream JSON, so it nests under
`com.diridium.sourcecodesearch.SearchResults` and a single match arrives as an
object where several arrive as an array; parsing only the array case loses
everything on an engine with exactly one hit. And code-template matches are
filtered to calls with a quoted first argument, which excludes the Route with
Sources library's own definition and its internal delegation to `router` from
being reported as somebody's routing.

Matching a location to a specific edge prefers the line mentioning that edge's
own target, since a channel can route to several places, and falls back to
listing every location in the channel when they cannot be told apart.

## Trace chains are not bounded by the number of channels (2026-09-11)

A message can route back into its own upstream, and Channel Writer appends a hop
per lap, so A to B to A to B grows `sourceChannelIds` without limit. Nothing
about the channel count bounds it.

The ancestor list is read from the map rather than walked, so the lookup budget
does not bound its length: the budget stops the reads, not the entries.
`MAX_TRACE_HOPS` caps each direction at 50 and keeps the most recent hops, since
the far end of a long chain is the loop's history and the near end is what the
reader is looking at.

The client caps again at `MAX_RENDERED_HOPS`, because the trace canvas is sized
per node: a few hundred hops asks the browser for an SVG tens of thousands of
pixels wide. It renders a window around the traced message and says how many
hops were left out, with the observation that a chain that long usually means a
routing loop.

## Authorization (2026-09-11)

`ChannelController.getChannels(null)` returns every channel on the engine with
no awareness of what the calling user may see. `MirthServlet.redactChannels()`
is that filter, and both endpoints apply it.

Redacting the channel list is not on its own enough for the trace: the caller
names a channel directly, so `getMessageTrace()` checks it with
`MirthServlet.isChannelRedacted()` before reading any message content.

A channel outside the visible set gets a 404 rather than a 403, so the response
does not disclose that it exists.

Ancestor hops are the awkward case. The Source Map records the real routing
chain regardless of who reads it, so a hop can name a channel the caller cannot
see. Those hops are reported as `restricted` with no content read: the shape of
the chain is already implied by the message the user can see, but its contents
are not theirs.

A hop naming a channel that no longer exists is a different thing and is
reported as `notFound`, not `restricted`. Deriving visibility from membership of
the channel list conflated the two.

`getMessageTrace` is `auditable = true`. The web administrator posts a PHI
access audit when a message is opened, so an endpoint that reads message content
should be audited too. `getTopology` is not: it reads channel configuration.

## RBAC, and what it does on a stock engine (2026-09-11)

Worth knowing before reading the authorization code above: a stock OIE engine
enforces none of it. Disassembling `DefaultAuthorizationController` shows
`isUserAuthorized()` returning true unconditionally,
`doesUserHaveChannelRestrictions()` returning false, and `getChannelAuthorizer()`
returning null. So `redactChannels()` returns the list untouched and
`isChannelRedacted()` is false for everything.

Real RBAC arrives with the `role-based-access-control` plugin, which replaces
that controller. Every redaction check here is written for that case and is inert
without it. The declared `ExtensionPermission` is likewise what makes these
operations appear in that plugin's role editor: without it an administrator has
no way to restrict Message Flow for a role, which is worse than ungated.

**The descendant scan had a real hole.** `buildDownstreamAdjacency()` redacted
the source channels but not the targets, so a visible channel naming a
restricted target put that target in the adjacency map, and the forward scan
called `getMessages()` on it. That read message data out of channels the caller
could not see. `addReachable()` now drops any target outside the visible set.

**The topology graph does not leak identifiers, and it is worth being precise
about why.** A Channel Writer's target `<channelId>` lives in the source
channel's own configuration, which a reader who can see that channel can already
export; a script route's target is literal text in that channel's own script.
Neither is a new disclosure. What is never done is resolve a restricted
channel's id to its name: `idToName` is built from the redacted list only.

Edges to a channel the reader cannot see carry `toRestricted`, and render as "a
channel you cannot see" rather than "unknown/deleted channel". The distinction
matters to the reader: one is somebody else's channel, the other is a broken
route they should fix.

## Why the message trace has its own renderer (2026-09-11)

`renderTraceChainSvg` duplicates some of `renderFocusSvgInto`'s visual language
rather than calling it. The topology renderer lays out an arbitrary graph by BFS
level, which is the wrong shape for a trace, which is always a straight line.

Its element ids are `mfT*` rather than `mf*` because SVG gradient, filter and
marker ids are scoped to the document, not to each `<svg>`. Both graphs can be
on the page at once, and reusing ids makes the second one silently render with
the first one's definitions.

## Escaping (2026-09-11)

`esc()` escapes quotes as well as `&`, `<` and `>`, because its output is
interpolated into HTML attributes (`title=`, `value=`, `data-select-channel=`)
as well as text. Channel and destination names reach those attributes directly,
and anyone able to create a channel can choose its name. Do not narrow this back
to the three text-context characters.

## There is no per-message extension point (2026-09-11)

The webadmin platform registry has 17 `register*` methods and none of them is
message-scoped. `registerChannelAction` covers channels,
`registerChannelTab` the channel editor, and the Messages view's right-click
menu is a hardcoded array in `messageRowMenu()` with no registry feeding it.
Checked against `oie-web-client` `origin/main` at 2026-09-09.

So reaching a trace means reading a message ID off the grid and pasting it into
the trace box. `/message-flow?channelId=X&messageId=Y&autoTrace=true` exists so
a link can land on a result directly.

An earlier revision shipped a Tampermonkey userscript that added the right-click
by scraping the rendered grid. It was dropped: it matched every page in the
browser, depended on markup rather than an API, and saved one paste.

**The real fix is upstream.** `registerMessageAction` in `oie-web-client` is the
same shape as the channel version: a `messageActions` registry entry, a register
method and accessor in both `platform.js` and `platform.ts`, `MessageAction` and
`MessageActionContext` interfaces, and in `messageRowMenu()` the same twelve
lines `channels.tsx` already uses to mix plugin items into its menu. Not yet
done.

## What is not covered by tests

Covered: the routing parsers, the Source Map coercion helpers, the trace budget
ceiling, and the client's `esc()`. The escaper's tests read the function out of
the shipped `plugin.js` and evaluate it, rather than importing the module, which
would need the `@oie/web-shell` import to resolve. That keeps the test on the
code that actually ships without restructuring the module around it.

Not covered: anything reaching `ChannelController`, `MessageController` or
`isChannelRedacted()`, which need a running engine. The authorization behaviour
above is therefore unit-untested and has to be checked against a real engine
with a user whose channel group visibility is restricted. The routing cache's
invalidation is likewise untested, since it needs real `Channel` objects with
revisions.

The overview's own tables are covered too, rendered rather than reasoned about:
the count column against a channel that also has a storage gap, the grouping of a
channel that loses the trail several ways at once, the grouping of a channel
whose outbound routes are of three different kinds, the labelling of the
no-inbound-route caveat, the legend's swatch rules and entries, and a trace that
stops at a hop writing no source map.

The routing graph is covered too, on the fan-in shape every one of its defects
appeared in: that cards are uniform and hold their names whole, that arrivals
land in the order they approach on a target grown to fit them, that the canvas
contains everything drawn including a left-bowing route, that a channel two hops
away is excluded and the count of what was left out is reported, and that every
route names cards that exist so hovering can fade them. Four of those five fail
against the code before the rewrite. The canvas one does not: the old renderer
drew `<line>` elements with no card ids, so its selectors match nothing and the
assertions hold over empty sets. It is a guard against regression, not evidence
of a fix, and is kept on that basis. That last one drives the real trace: the stub keeps a
node per selector so the handler on the Trace button can be found and invoked,
which is the only way to reach a rendered trace result. Both tests were run
against the code before the fix and observed to fail, which is the only thing
that makes a passing test worth anything here. The stub resolves `[data-filter]`
out of the HTML it was handed and invokes the recorded click, because the chosen
card is closure state with no other way in.

One of those assertions was wrong on its first run, and the way it was wrong is
worth keeping: it counted occurrences of "Route with Sources" to prove the
remedy paragraph appears once, and got three. The paragraph does appear once.
The phrase is in it three times, once as text and twice inside the help link's
title tooltip. It now counts a phrase that occurs once per paragraph.

Nothing else in the web administrator half is covered.

## Standing result (2026-09-12)

`mvn clean package`, with the engine jars installed by the
`install-engine-jars` profile: 39 tests, no failures, `message-flow-2.6.13.zip`
at 60,689 bytes. The client suite is a separate step, as it is in CI:
`node --test 'webadmin/test/*.test.mjs'`, 58 tests, no failures. The zip carries
no third-party code: its only web asset is `plugin.js`.

The figures this replaces were stale and had drifted a long way: 26 tests, and a
zip named for version 1.0.0 at roughly 29KB. Both were quoted for months while
the real numbers moved, which is the argument for measuring this section on
every release rather than carrying it forward.

Expected build noise: `ERROR StatusLogger Log4j2 could not find a logging
implementation` during the test run. Log4j is a `provided` dependency supplied by
the engine at runtime, and the tests do not exercise logging. Not a failure and
not worth re-investigating.

The engine jars are not published anywhere resolvable, so
the `install-engine-jars` Maven profile installs them from a local engine
checkout or an unpacked distribution.
Everything else comes from Maven Central.

This pom declares no extra repositories. The sibling plugin repos all carry a
`mirth-libs` repsy mirror, and it is vestigial: a build against an empty local
repository fails there on `mirth-server`, `mirth-client-core` and
`donkey-server` at 4.6.0, and succeeds with the mirror removed once the install
script has run. Verified by seeding an empty `-Dmaven.repo.local` with the
script and building against it.

The first measurement of this was wrong and is worth recording. `curl -I`
against the repsy URLs returned 200 for every artifact, including versions that
do not exist, because repsy answers 200 for missing paths. A warm `~/.m2` hides
a missing entry in the install script the same way. Only an empty cache tells
the truth about either.

CI follows `simple-channel-history`'s released `release.yml`: the engine jars
come from the OIE distribution tarball, downloaded from the engine's GitHub
releases and cached, rather than built from an engine source checkout. Pinned to
`v4.6.0` GA. The `engine-checkout` and `engine-dist` profiles carry the two layouts' paths,
so CI runs the same command a developer runs rather than a second copy of the
jar list.

`build.yml` runs on pushes and pull requests and fails when no surefire reports
were produced. `release.yml` fires only on a `v*` tag, checks the tag against
`oie.json`, and leaves a draft for a human to publish.

Neither workflow has been executed. The distribution's internal jar paths are
taken from that released workflow rather than measured here, and the install
script fails loudly on a missing jar rather than silently skipping it, so a
wrong path shows up as a failed step.

Never deployed to a running engine as of this date. The Java compiles, the tests
pass and the package assembles; nothing here has been installed and
smoke-tested.
