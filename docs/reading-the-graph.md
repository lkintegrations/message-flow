# Reading the graph

Message Flow has two views. **Overview**, the landing page, describes the whole
engine: the routing tables, the external destinations, and the traceability
gaps. Picking a channel from the selector at the top switches to the **channel
view**, which draws that channel's routing chain, scopes the tables to it, and
offers the message trace.

The split matters because almost everything on the overview is engine-wide. Read
under a selected channel, an engine-wide count reads as that channel's count.

What each thing on screen means, and what to do about it. Most of this matters
only when something is wrong, which is when the picture is worth the most and
when it is easiest to misread.

There are two graphs. The **routing map** shows what a channel *can* do, read
from configuration. The **message trace** shows what one message *did*, read
from its own source map. They fail in different ways and for different reasons.

Both draw a channel as a card carrying its name and source connector, with the
colour on its left stripe: gold for the channel being viewed, blue for another
channel on this engine, dashed and grey for one that is unknown, deleted or not
visible to you. The legend under the map names every colour and dash, for the
lines and for the cards.

The map shows direct routes only. A channel that reaches this one through
another channel is left out, and a line under the graph says how many and offers
to include them. Hovering a route picks out that one route and fades the cards
it passes over, so a line that crosses a card can still be followed; hovering a
legend entry picks out every route or channel of that kind instead. A channel
name is a link wherever it appears, in a table, on a card, in a trace chain or
in the prose of a note: the name opens that channel here, the edit chip opens it
in the channel editor.

## The overview

The landing page answers two questions and then gets out of the way:

- **no inbound route found** means no Channel Writer destination and no
  `routeMessage` call on the engine names them as a target. A route that builds
  its target at run time could still be reaching any of them, and the map cannot
  show that, so this is a statement about what was found rather than about what
  exists. The list gives the source connector and the message count: a Channel
  Reader receives only what another channel routes to it, a listener takes
  messages from outside, and a channel that has received messages is plainly
  being reached by something. A checkbox narrows it to the Channel Readers.
  What the list is and is not worth is set out above it as labelled lines
  rather than a paragraph: what was found, what could still reach them, why the
  source connector matters, and what to check next
- **cannot be traced** means routing that leaves no record of where a message
  came from: a channel that sends onward with `router.routeMessage`, so nothing
  downstream can be linked back to it, or one that receives routed messages and
  does not keep the source map they arrived with. A channel whose messages only
  come from outside the engine is not listed even if its storage discards maps,
  because it never had a trail to lose

Both figures are shown against the channel count, so a number reads against the
size of the engine rather than in isolation. Choosing one lists the channels it
counts, and every channel name opens that channel.

The two figures behave differently when chosen, because they are answering
different kinds of question. **no inbound route found** draws its own list, of
channels and nothing else. **cannot be traced** has no list of its own: it
narrows the page to *Where message tracing will fail* at the bottom, which was
already there, because naming a channel is not enough on its own. The two ways
a trail is lost have different remedies, so that table gives each row its cause
and what to change about it.

Earlier versions also reported terminals, channels with no destinations, and
hubs. Those were the in-degree and out-degree combinations of a graph, which are
easy to compute and answer nothing anyone asks, so they are gone. A channel that
ends a chain is the normal end of a chain, and a channel with no destinations is
a perfectly ordinary thing to build.

### Destinations set to None

A Channel Writer with no channel selected is drawn as a route to **None**.
Earlier versions counted these and hid them. That was wrong: the destination
reports SENT and the message goes nowhere, so nothing else on the engine will
ever tell you, which makes it exactly the sort of thing a routing map should
show.

## The routing map

### Normal routing

A solid violet line with an arrowhead from one channel to another is a Channel
Writer destination. Both channels are drawn as filled circles with an icon for
their source connector type. The selected channel is gold; everything reachable
upstream or downstream of it is blue.

### Disabled destinations are still drawn

Greyed and dashed rather than hidden. Somebody disabled it deliberately and that
is worth seeing. The routing table says `disabled`.

### Script routing

A blue dashed line rather than a violet solid one. Script routes are drawn
differently because the edge means "this can happen", not "this always happens":
a Channel Writer destination has an enable switch and either runs or does not,
while a line of script runs if the script reaches it.

The routing table has no enabled column, because being enabled is a property of
a destination connector and a script route simply does not have one. A disabled
Channel Writer is tagged `disabled` beside the connector; a script route is
tagged nothing, and whether its line runs depends on the code around it, which
nothing here inspects. A bare top-level call and one buried in an `if` look
identical to the routing map.

An **amber dashed line** is a script route that writes no source map, meaning a
`router.routeMessage()` call rather than the library's `routeMessage()`. The
route works; a trace of a message taking that hop simply stops there. The routing
table tags the route `no source map`, and the channel appears under
[Where message tracing will fail](#where-message-tracing-will-fail).

Whether a route runs and whether it writes the source map are separate questions, and
both are tagged beside the route rather than shoehorned into one column.

### The target channel no longer exists

A grey dashed circle with an information icon, subtitled `unknown/deleted
channel`. The table shows `(unknown channel - id: ...)` with the id the source
channel is still pointing at.

**What it means:** a Channel Writer destination naming a channel that has been
deleted. The route is broken and messages hitting that destination will fail.

**What to do:** fix or remove the destination in the source channel.

### The target is a channel you are not allowed to see

A grey dashed circle with a crossed-out-eye icon, subtitled `you do not have access`. The
table shows `a channel you cannot see`.

**What it means:** the route is fine. Somebody else's channel is on the other end
of it, and your role does not include it.

**What to do:** nothing. This is deliberately drawn differently from a deleted
channel so that "not mine" is never mistaken for "broken".

You will only ever see this with the Role Based Access Control plugin installed.
A stock engine applies no channel restrictions at all, so every channel is
visible to every authenticated user.

### A script route to a name that does not resolve

The edge does not appear in the graph. It appears in the routing table, showing
the name the script asked for, followed by `(name not found among known
channels)` in amber.

It is absent from the graph because there is nothing to place: the target could
not be identified, so it has no node. The table is the honest record.

**What it means:** one of two quite different things.

Either a channel was **renamed**. `router.routeMessage()` and the library's
`routeMessage()` both match on channel *name*, so renaming a channel silently
breaks every script that routes to it. This is a real outage waiting to happen
and the table is telling you about it.

Or the target name is **built at runtime**, as in `routeMessage('SITE_' + site,
msg)`. The parser can only read the literal part, `SITE_`, which was never meant
to be a channel name. Nothing is broken; the graph simply cannot know where this
goes.

**What to do:** check whether a channel by that name used to exist. If the name
is assembled in the script, the routing table names the expression that decides it,
line, and the message trace is the tool for that question because it reports
where a message actually went rather than where it might go.

### A route the map cannot resolve at all

Nothing appears on the graph, and a row appears in the routing table saying
"target computed at runtime", with the line of source that does it.

**What it means:** the channel routes by script to a target it builds while
processing, `router.routeMessage(target, msg)` or
`routeMessage('SITE_' + site, msg)`. A target that is not a literal cannot be
read off configuration, so no edge is possible. Without this row such a channel
simply looked like a channel that does not route, and a concatenated name was
worse: the literal prefix drew an edge to a channel that never existed.

This is found by asking OIE Source Code Search where route calls are written,
and comparing that against what the map managed to resolve. Without that plugin
installed, these stay invisible.

**What to do:** trace a message from that channel. The Source Map records the
hop that really happened, whatever the target was called, provided the call went
through the Route with Sources library.

### A Channel Writer whose target is chosen at runtime

A circle outlined in violet with a wand icon, subtitled "channel chosen
at runtime", joined by a violet dotted line. It is listed under "Routes to a
channel chosen at runtime" rather than among the external destinations.

**What it means:** the destination's channel id is a template such as
`${targetChannel}`, resolved per message. The route stays inside the engine. The
graph cannot say which channel it reaches because that is not decided until a
message arrives.

**What to do:** nothing, if that is intentional. To see where a particular
message actually went, trace it: the message trace reports the hop that really
happened, which is exactly the question the routing map cannot answer here.

### Unconfigured destinations are hidden

A Channel Writer with no channel selected is counted, not drawn. The summary line
says how many were hidden. They are stubs rather than routes, and drawing them
would add nodes that mean nothing.

### A channel with nothing configured

"This channel has no channel-to-channel routing and no external destinations
configured." The channel exists and receives messages; it just does not send
anywhere this tool can see.

## Where message tracing will fail

A trace follows the source map the engine writes on each hop. This table lists
the channels that either never write it or do not keep it, so a trace that
reaches them stops. They route correctly either way; only the record is missing.

### Routes with `router.routeMessage`

**What it means:** `router.routeMessage` does not send the source map to the
downstream channel. `VMRouter` forwards whatever source map the caller gave it
and adds nothing of its own, so the message arrives with nothing saying where it
came from and a trace stops at that hop. A Channel Writer does send it, which is
why connector routing traces and script routing does not. This is a known gap in the engine,
[issue #402](https://github.com/OpenIntegrationEngine/engine/issues/402).

**What to change:** import the **Route with Sources** code template library
([Tony Germano's, from connect-examples](https://github.com/nextgenhealthcare/connect-examples/tree/master/Code%20Templates/Route%20with%20Sources)),
then drop the `router.` prefix from the call. That is the whole change: the code
template writes the same source map fields a Channel Writer does.

```javascript
routeMessage('ADT Processor', connectorMessage.getRawData());
```

Message Flow recognises both forms, so once converted the channel drops off this
table.

### The channel's storage settings do not keep the source map

**What it means:** the source map is stored as message *content*. A channel whose message storage mode
is `RAW`, `METADATA` or `DISABLED` does not store maps at all, and a channel with
"remove content on completion" enabled deletes them once a message finishes. In
either case there is nothing to trace, permanently, by configuration.

**What to do:** nothing, unless you want traces through this channel. Those
settings are usually chosen on purpose, for volume or for data retention reasons,
and tracing is rarely a good enough reason to change them.

## The message trace

### A hop that cannot be read

`not found` means the source map says the hop happened but the message is no longer
there, normally because it was pruned. The hop is real; the evidence is gone.

`not visible to you` means the hop went through a channel your role does not
include. Nothing is read from it.

`lookup failed` means the read itself errored. The reference in the error box
ties it to a line in the server log.

### The chain stops earlier than expected

Four possible reasons, and the note under the graph names them:

- the message genuinely has not been routed onward yet
- a downstream message was pruned
- the hop used `router.routeMessage`, which records nothing
- a downstream channel does not store maps

The third and fourth are listed under Where message tracing will fail, so check there first.

### The trace says it was cut short

Either the scan hit its lookup ceiling, or the chain was longer than the graph
draws.

Descendants have no index. There is no way to ask the engine "which message came
from this one", so the trace works forwards by scanning the channels this one can
reach, bounded by message count, depth and total reads. On a busy channel it will
reach that bound.

### A very long chain

Messages can route in circles. `A` to `B` to `A` is a legitimate configuration,
and each lap adds a hop, so a looping message produces a chain limited by nothing
except how long it kept going. The trace caps what it returns and the graph draws
a window around the message you asked about, telling you how many hops it left
out.

A chain of dozens of hops is almost always a routing loop worth investigating in
its own right.
