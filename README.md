# Message Flow

A routing map and message tracer for the OIE web administrator.

An engine with a few dozen channels feeding each other has no view of its own
shape. Nothing shows which channels route to which, which routes are dead, or
where a particular message went. Message Flow reads that out of the channels
and draws it.

Runs inside the web administrator, installed alongside Web Support.

## The routing map

Select a channel and the map draws what routes into it and what it routes to.
Each channel is a card with its name and source connector. Each route is a curve
from one card to the next.

Both kinds of routing count: Channel Writer destinations, and `routeMessage()` /
`routeMessageByChannelId()` calls in scripts. Scripts are read wherever they
appear in the channel: source and destination transformers, filters, response
transformers, and the preprocessor, postprocessor, deploy and undeploy scripts.

Colour says what a thing is. The legend under the map names every one.

| | |
|---|---|
| Gold card | the channel you are viewing |
| Blue card | another channel on this engine |
| Grey dashed card | unknown, deleted, or not visible to you |
| Slate dashed card | a destination that is not a channel route |
| Violet dashed card | a channel chosen at run time |
| Violet line | Channel Writer route |
| Blue dotted line | script route, traceable |
| Amber dashed line | script route that writes no source map |
| Grey dashed line | disabled |

Hover works both ways. Point at a route and it is picked out alone. Every other
route fades, a tooltip names the kind and the target, and any card the line
crosses fades so the line stays readable. Point at a legend entry instead and
every route or channel of that kind is picked out at once. That answers "show me
everything that writes no source map" without tracing lines by eye.

Every channel name is a link. On a card, in a table, in a trace chain, or in the
text of a note. The name opens that channel in Message Flow. The `edit` chip
beside it opens the channel in the editor.

The map shows direct routes by default. A channel that reaches the selected one
through an intermediary is left out, and a line beneath says how many and offers
to include them.

### When the routing is broken

- A route to a deleted channel draws as a broken route rather than vanishing.
- A route to a channel your role excludes is marked as somebody else's, not as
  broken.
- A Channel Writer set to None draws as a route to `None`. It reports SENT and
  delivers nowhere.
- A route naming a channel this engine does not have is drawn and labelled "no
  channel of this name on this engine".
- A target the script builds is shown as the expression that builds it,
  `'MF_SITE_' + site`, not as the literal fragment a parser matched first.
- A route that writes no source map draws in amber. That is the one that matters
  the day you need to trace something.
- There is never an empty diagram. The selected channel is always drawn, even
  when nothing routes to or from it.

[Reading the graph](docs/reading-the-graph.md) covers every state and what to do
about it.

## The overview

Message Flow opens on three figures, each shown against the channel count.

| | |
|---|---|
| channel-to-channel routes | the full routing list |
| no inbound route found | nothing the map can see routes to these |
| cannot be traced | routing that leaves no record of where a message came from |

Choosing one lists the channels it counts.

The no-inbound-route list sets out what it is and is not worth as labelled lines:
what was found, what could still reach them, why the source connector matters,
and what to check next. Message counts come from engine statistics, so a channel
that has plainly received messages is not reported as unreachable without
comment.

Tables group by channel. A channel with four routes out and two reasons a trace
will fail appears once in each table, with everything it is listed for beside it.

## Tracing one message

Right-click a message in the Messages view and choose **Trace in Message Flow**,
or select a channel in Message Flow, paste a message ID, and see where that
message went. Not the routes it might have taken. The chain is drawn like the
map, and every channel in it opens that channel or its editor.

Ancestors come from the message's own source map: exact, one lookup. Descendants
need a bounded forward scan, because the engine has no index for "which message
came from this one". The scan is capped by depth, per-channel sample and total
reads.

The trace says why it stopped. Where the routing map knows what comes next but no
trace can prove this message took it, that channel is drawn as an extra node
marked "not confirmed", joined by the line the routing map uses for that route,
with a `?` carrying the reason. Three reasons, checked in this order:

1. **Every route onward is disabled.** Nothing was dispatched, so there is no
   downstream message to find. Names each destination and its target. Says
   plainly that it reads the channel as configured now, not as it was when the
   message ran.
2. **The route onward writes no source map.** The hop exists and the message may
   have taken it, but nothing downstream records where it came from.
3. **The target is built at run time.** The map cannot say which channel the
   message went to, so it does not guess.

Other limits are reported too. An incomplete chain says so rather than looking
like an empty result. A hop through a channel you cannot see is marked restricted
rather than dropped. A pruned message is distinguished from one that never
existed.

## Source maps, and why some traces stop

`router.routeMessage()` does not send the source map to the downstream channel. A
message routed that way arrives with nothing saying where it came from, and a
trace of it stops at that hop. A Channel Writer does send it. This is a known gap
in the engine
([issue #402](https://github.com/OpenIntegrationEngine/engine/issues/402)), not
something this plugin can fix from outside it.

What it can do is tell you where you are affected. A **Where message tracing will
fail** table lists every channel whose routing or storage settings mean a trace
comes up empty. Channels are grouped, so each appears once with every reason and
the fix for each beside it.

For script routing the fix is Tony Germano's
[Route with Sources](https://github.com/nextgenhealthcare/connect-examples/tree/master/Code%20Templates/Route%20with%20Sources)
code template library. Its functions are drop-in replacements that write the same
source map a Channel Writer does. Message Flow recognises both forms, so a
converted channel drops off the table.

A storage gap counts only where something routes to the channel. A channel fed
only from outside the engine never had a source map to keep.

## With Source Code Search

If [OIE Source Code Search](https://github.com/diridium-com/oie-source-code-search)
is installed, Message Flow uses it for what it cannot answer itself.

**Location and line number** for a script route: "Preprocessing Script line 2",
"Source Transformer line 14". Channel export XML says a route call exists but not
where in the channel it sits. This is the difference between knowing a channel
routes by script and knowing where to change it.

**Routing inside code templates.** Code templates are not part of any channel's
configuration, so routing written in shared code is invisible to the map. Source
Code Search reads them. Which channels those calls affect depends on which
libraries each channel enables, and the table says so.

**Computed targets** are shown as the expression that builds them.

**Route calls read only in part** is its own section. The search matches one line
at a time, so a call whose arguments continue onto the next line arrives cut off.
That line cannot be told from a computed target, and calling it one is wrong
whenever the target is a plain name on the next line. Each such call is listed
with its location, line number and the line as matched, along with the fix: put
the call and its first argument on one line.

The integration is optional. If the plugin is absent, or the user lacks its
search permission, the tables render without the extra detail and nothing reports
an error. The overview says so once, naming what is hidden. A missing search
permission produces the same silence as a missing plugin, and the two need
different action.

## Where it appears

**Message Flow**, under Plugins in the left rail, opening on the overview.

**View in Message Flow**, on a channel's right-click menu in the Channels view,
which opens the tab with that channel selected.

**Trace in Message Flow**, on a message row's right-click menu in the Messages
view, and in the Message Tasks pane for the selected row. It opens Message Flow
with the channel and message ID filled in and the trace already run. This needs
Web Support 1.2.x or later. On an older Web Support the item is not added and the
rest of the plugin works as before.

Older Web Support has no message-scoped extension point.
[`messageflow-trace.user.js`](messageflow-trace.user.js) is a userscript that
adds the same right-click item from outside the plugin system. It reads the page
directly, so it is a workaround, and it is only needed on Web Support older than
1.2.

## Permissions

One extension permission, **Message Flow**, covering both operations. Both are
read-only. Tracing is audited, since it reads message content.

Channels are filtered to what the user may see, in the map and in traces alike.
That filtering is inert on a stock engine, which applies no channel restrictions,
and becomes live with the Role Based Access Control plugin installed.

## Requirements

**Web Support**, installed and enabled. Version 1.2.x or later is needed for the
message right-click action. **OIE Source Code Search** is optional but
recommended.

Source Code Search makes script routing legible. Channel configuration records
that a route call exists and what literal it matched. It does not record where in
the channel the call is written, what the call says, whether its target is
computed, or that a call exists inside a code template at all. Rather than
reimplement a code search, this plugin asks the one already on the engine.

Without it the map still draws Channel Writer routing and says plainly that the
rest is missing.

Web Support serves the web administrator and discovers this plugin's UI
automatically. Nothing enforces the dependency, so without it Message Flow
installs and shows nothing.

No third-party JavaScript ships in the extension. The only web asset is
`plugin.js`, and nothing is fetched at run time. Air-gapped installs need that.

## Build

The engine jars are not published to any resolvable repository, so install them
into the local Maven repository first, from an engine checkout or an unpacked OIE
distribution:

```
mvn -N -Pengine-checkout,install-engine-jars -Dengine.dir=/path/to/engine initialize
mvn clean package
```

Use `-Pengine-dist` for an unpacked distribution. The extension lands at
`package/target/message-flow-<version>.zip`.

Point `-Dengine.dir` at an OIE 4.7.0 engine. The plugin compiles against 4.7.0
and declares support for 4.6.0 and 4.7.0.

The client suite is a separate step, as it is in CI:

```
node --test 'webadmin/test/*.test.mjs'
```

The version lives only in the root pom's `<revision>`. Everything else derives
from it, and the build fails if `oie.json` disagrees.

Install the zip from the Extensions page and restart the engine.

## Documentation

| | |
|---|---|
| [Reading the graph](docs/reading-the-graph.md) | What each state on screen means, and what to do about it |
| [Design notes](docs/design-notes.md) | Why the code is shaped this way, what was tried and rejected, and what the tests do not cover |
| [Releasing](RELEASING.md) | Cutting a release |

## Acknowledgements

Thanks to [@gibson9583](https://github.com/gibson9583) for the Web Support plugin
this runs inside, and to [@pacmano1](https://github.com/pacmano1) for the support
and work around Open Integration Engine.

## Version

| | |
|---|---|
| Plugin version | 1.0.0 |
| Minimum engine version | 4.6.0 |
| Supported engine versions | 4.6.0, 4.7.0 |
| Requires | Web Support (1.2.x or later for the message right-click) |
| Optional | OIE Source Code Search |
| Restart required | Yes |
| License | MPL-2.0 |

Copyright Synthesis Health and Keith Smith. Developed with the moral support of
Finnegan the dog.
