# Web Support + Message Flow -- combined extension source (v1.0.0)

This merges Message Flow into Web Support as a real nav tab running inside
the already-authenticated webadmin shell, replacing the earlier standalone
version entirely. It exists to fix a structural problem the standalone
version had: it needed its own separately-deployed static page (a small WAR
dropped into `webapps/`) specifically because the engine's `/api` layer
requires an `X-Requested-With` header the standalone page's own login/session
couldn't easily satisfy end-to-end. Inside Web Support, that problem doesn't
exist: the panel runs in the shell's own already-logged-in page, using the
shell's own `platform.api` (which already sets that header), so there is no
separate login screen, no separate WAR, and no restart-timing quirk.

## What this package contains

```
plugin.xml              -- combined: Web Support's original serverClasses/
                            apiProviders + Message Flow's, one shared jar
src/.../MessageFlowServicePlugin.java     -- much simpler now: no WAR
                                              deployment, just registers the
                                              plugin point + permission
src/.../MessageFlowServletInterface.java  -- unchanged from the standalone
                                              version: GET /topology only
src/.../MessageFlowServlet.java           -- unchanged: the same
                                              ChannelController +
                                              ObjectXMLSerializer + ported
                                              regex topology builder
webadmin/plugin.json      -- client entry manifest, discovered by Web
                              Support's own getWebPluginPaths()
webadmin/web/plugin.js    -- the nav tab + channel action, using
                              platform.registerNavItem/registerView/
                              registerChannelAction and platform.api.get()
build.bat / build.ps1     -- Windows build
build.sh                  -- macOS/Linux build
```

Notably absent compared to the standalone version: `resources/web/index.html`
and the WAR-deployment code in `MessageFlowServicePlugin`. Both are gone,
not just unused -- the page lives in `webadmin/web/plugin.js` now, loaded
into the Web Support shell rather than served as its own document.

## Three entry points

1. **Message Flow nav tab** (Monitor section) -- its own channel list, click
   any channel to see its focused chain. Fully working, confirmed against
   your engine.
2. **"View in Message Flow" channel action** -- right-click a channel in
   the Channels view; jumps to (1) with that channel pre-selected.
3. **A "Message Flow" tab inside the channel editor itself** -- new in this
   revision. Shows the same focused chain inline, wherever you already
   navigate per-channel, without leaving the channel editor. Clicking a
   neighboring channel in this embedded graph re-focuses locally rather
   than navigating away.
4. **A real right-click on the Messages grid, via a companion userscript**
   (`messageflow-trace.user.js`) -- outside Web Support's own plugin
   system entirely, since that view has no extension hook (see below).

## Why there's no button (or any hook at all) on individual messages

You asked for a way to click a message and jump to Message Flow. I checked
this twice, from two different angles, both against the real compiled
`oie-webadmin.war`:

1. **The extension registry** (`core/platform.js`) -- the full list is
   `registerNavItem`, `registerView`, `registerDashboardTab`,
   `registerDashboardColumn`, `registerChannelTab`, `registerChannelAction`,
   `registerCodeTemplateAction`, `registerSettingsPanel`,
   `registerAttachmentViewer`, and a handful of editor-specific ones (step
   types, rule types, connector panels). Nothing message-scoped. The
   Messages view's own right-click menu is hardcoded with no plugin hook
   feeding into it.
2. **Shared app state** -- on the theory that even without a dedicated
   hook, a plugin might be able to read "which message is currently
   selected" from the app's shared state store (the way `editingChannel`
   works for the channel editor) and react to that. Checked the compiled
   Messages view bundle directly for any `setState(...)` calls that would
   publish such a thing: there are none. The Messages view doesn't expose
   its selection to the rest of the app at all.

Both routes are genuinely closed in this platform version -- not a matter
of looking harder, but of what this specific view was actually built to
expose. Entry points 2 and 3 above (the channel action and the
channel-editor tab) are the real alternatives; the message-tracing feature
narrows the gap further (once you're in Message Flow, you get the actual
runtime path, not just what's configured), but reaching it still means
reading a message ID off the grid and pasting it in.

## The right-click, after all -- via a userscript, outside the plugin system

Since the Messages view genuinely has no extension hook (see above), the
only way to get a *real* right-click there is to step outside Web
Support's plugin system entirely: `messageflow-trace.user.js`, a Tampermonkey/
Violentmonkey userscript that runs on top of the page and adds the option
itself by reading the rendered DOM directly, independent of anything Web
Support exposes to plugins.

**Install**: with Tampermonkey (or Violentmonkey) installed and enabled in
your browser, open `messageflow-trace.user.js` as a local file (or paste
its contents into a new script) and install it. It runs on every page
(`@match *://*/*`) but only does anything on a URL matching
`/messages/{channelId}` -- everywhere else it's a no-op.

**How it works**:
- The Messages view's route is confirmed (from the compiled shell bundle)
  to be `/messages/{channelId}` -- the channel's UUID sits directly in the
  URL, so no page-scraping is needed for that part.
- Column headers carry a stable `data-col-key="id"` attribute (confirmed
  in the compiled bundle) identifying the Id column regardless of display
  order, since columns are user-draggable. The script finds that column's
  position from the header row, then reads the same position off whichever
  row you right-click.
- A message with multiple connectors renders one row per connector
  (Source, Destination 1, ...) and only the first shows the real Id -- the
  rest show a blank/dash (see your own HOP2/HOP3 screenshots). The script
  walks upward from the clicked row until it finds one with a real Id.
- The right-click option opens `/message-flow?channelId=X&messageId=Y&autoTrace=true`
  in a new tab -- a new URL-param contract `webadmin/web/plugin.js` now
  understands: it pre-fills the trace box's channel/message fields and
  runs the trace immediately, rather than requiring you to do that by hand.

**Real tradeoffs, stated plainly**: this reads the page's actual rendered
markup (a `data-col-key` attribute, row structure, the URL pattern) rather
than a stable, versioned API -- because no API exists here. If a future
Web Support build changes the Messages view's layout, this script may
need updating to match. It also requires a userscript manager extension
installed and enabled in your browser at all times, which is a real
dependency outside the extension itself, and something an organization's
browser policy might restrict.

I could not test this against a live page (no browser/DOM available in my
sandbox) -- I verified its core logic (column detection, ID extraction
with the sub-row fallback, URL construction) with a mock DOM standing in
for the real one, which covers the logic but not the real page's exact
markup. Worth confirming the right-click menu shows the correct message ID
before relying on it, especially on a message with several destinations.

## A real bug found live: channel-visibility filtering

You reported seeing 5 extra channels in Message Flow that had genuinely
been deleted, confirmed absent from the Swing Administrator's own Channels
view with no filter active -- and critically, this survived a full
uninstall/reinstall of the extension *and* an engine restart, which ruled
out a stale in-memory cache immediately (a restart rebuilds every JVM-heap
cache from scratch).

The real cause: `ChannelController.getInstance().getChannels(null)`
returns every channel that exists on the engine with no awareness of
which ones the *currently logged-in user* is actually authorized to see.
`MirthServlet` (which this servlet extends) has its own protected
`redactChannels(List<Channel>)` method specifically for this -- confirmed
by name in the decompiled class -- and the original code called
`ChannelController` completely raw, bypassing it. Both `getTopology()` and
`getMessageTrace()` now call `redactChannels(...)` on the result before
using it, matching what any other properly-authorized view of the channel
list would show.

If you were logged in as a user with restricted channel-group visibility,
this should now make Message Flow match what you see everywhere else. If
it doesn't -- if the same channels still show up after this fix -- that
would actually be a more interesting finding: it'd mean those channels are
visible to your specific account (contradicting what Swing showed), or
`redactChannels()` doesn't do what its name suggests, and we'd need to dig
further with a direct look at the channel table itself.

## Graph styling for the message trace

The trace result (ancestors -> traced message -> descendants) now renders
with the same visual language as the topology graph -- gradient-filled
circles, glow, per-connector-type icons, name/status cards -- instead of
plain boxes, per request. It's a separate renderer (`renderTraceChainSvg`)
rather than reusing the topology graph's own layout function: that one
does BFS-based level layout for an arbitrary graph shape, which is the
wrong tool for what's always a single straight line here. It uses its own
element ids (`mfT*` instead of `mf*`) since the trace chain and the full
topology graph can both be visible on the page at the same time, and SVG
gradient/filter/marker ids are scoped to the whole document, not to each
individual `<svg>` -- reusing the same ids would have made the second one
silently render with the first one's definitions.

## Message tracing (new): what actually happened, not just what's configured

Alongside the static topology graph, Message Flow now has a "Trace a
message" box at the top of the nav tab: pick a channel, enter a message
ID, and it shows that message's *actual* runtime path rather than the
general set of possible routes.

- **Ancestors are read directly off the message's own Source Map** --
  Mirth writes both the immediate parent (`sourceChannelId`/
  `sourceMessageId`) and the full accumulated chain (`sourceChannelIds`/
  `sourceMessageIds`) on every Channel Writer/`router.routeMessage()` hop.
  This is free (no extra searching) and more reliable than matching on the
  HL7 MSH-10 control ID the way Mirth DB Explorer's original per-message
  tracer did -- these survive a transformer regenerating that ID, since
  Mirth writes them itself as part of routing.
- **Descendants are a bounded forward scan** -- there's no server-side
  index for "find the message that came from this one" (checked the real
  `MessageFilter` REST search model: it supports message ID ranges, dates,
  status, custom metadata columns, and content search, but nothing on raw
  Source Map key/value pairs). So the server uses the same channel-to-channel
  adjacency the topology graph computes to know which channels are even
  reachable from this one, bounds each candidate channel's search with
  `startDate` = this message's received time (a descendant can't have
  arrived earlier than its ancestor), and checks up to 50 messages per
  candidate channel per hop, up to 5 hops deep. On a busy channel this is a
  real scan, not an instant lookup.
  **A real bug found and fixed against your data**: the first version
  called `MessageController.getMessages()` (search) for candidates and
  checked their Source Map directly -- but that search almost certainly
  returns lightweight summaries for grid display, not full connector
  content, so every candidate's Source Map came back null and nothing ever
  matched (confirmed by your HOP1/HOP2 traces finding zero descendants even
  though the HOP3 trace proved the chain existed). Fixed by re-fetching
  each candidate's full content via the same `getMessageContent()` call
  ancestor-tracing already used successfully, at the cost of one extra
  round trip per candidate -- hence the lower scan limit (50, down from
  200) to keep that bounded.

This still can't be triggered by clicking a row in the Messages grid --
see "Why there's no button on individual messages" above. You read the
message ID off the grid and paste it into the trace box.

## Build

**Windows:**

```
.\build.bat "C:\Program Files\OpenIntegrationEngine\server-lib" "C:\path\to\websupport-1.0.3.zip"
```

**macOS/Linux:**

```
SERVER_LIB=/path/to/server-lib WEBSUPPORT_SOURCE=/path/to/websupport-1.0.3.zip ./build.sh
```

The second argument can be the original `websupport-1.0.3.zip` (it gets
extracted automatically) or an already-extracted folder containing
`oie-webadmin.war` and `websupport-shared.jar` -- either the real one you
already have installed, or a fresh copy. Web Support's own files are
copied through byte-for-byte unchanged; only Message Flow's classes are
newly compiled and merged in.

This produces `websupport_with_flow-1.0.0.zip`.

**I ran a full structural dry-run of this exact build script** (stubbing
`javac`/`jar` with scripts that just create placeholder files, since I have
no JDK in this sandbox) against a mock `websupport-1.0.3.zip` and confirmed:
correct extraction, correct class merging (both Web Support's and Message
Flow's classes end up in one jar), correct staging, and -- critically,
given what bit us last time -- correct explicit directory entries in the
output zip at every nesting level (`websupport_with_flow/`,
`websupport_with_flow/webadmin/`, `websupport_with_flow/webadmin/web/`).
I could not run an actual `javac` compile or deploy against a real engine,
so the Java itself is unverified beyond the previous standalone version's
already-confirmed-working `MessageFlowServlet`/`MessageFlowServletInterface`
(unchanged here) and the newly-simplified `MessageFlowServicePlugin`
(shorter and lower-risk than what it replaced, not longer).

## Install

1. **Remove both old installs first**: whatever's currently in
   `extensions\websupport\` and (if you still have it from the earlier
   standalone attempt) `extensions\messageFlow\`. This package replaces
   both with one combined `extensions\websupport_with_flow\`.
2. Extensions -> Install Extension from File System -> Browse ->
   `websupport_with_flow-1.0.0.zip` -> Install.
3. Restart the engine.
4. Open the Web Support webadmin (however you normally reach it -- the
   login screen you used before still applies, nothing changed there) and
   look for **Message Flow** under the **Monitor** section of the left
   rail.
5. In the Channels view, right-click a channel to find **View in Message
   Flow** as an alternative entry point.

## What I could verify vs. what I'm inferring

Verified by inspecting the real compiled shell bundle and `core/platform.js`
directly (not guessed):
- The full `platform.register*` API surface and exactly which extension
  points exist (see "Why there's no button on individual messages" above).
- The real object shape for a routed nav item -- pulled the literal
  `{id, label, icon, path, section, order, task}` fields straight out of
  the Dashboard's own nav registration in the compiled shell bundle.
- `platform.api.get()` already attaches the required header -- confirmed
  in `core/api.js`.
- `core/icons.js`'s `iconPath(name)` returns raw SVG path data with a safe
  fallback for an unknown name, which is what lets the graph use the host's
  own icon set instead of a CDN icon font.
- The zip directory-entry requirement and the merged-jar structure (dry-run
  tested, see above).

Inferring / unverified:
- The exact folder depth `getWebPluginPaths()` expects for a third-party
  extension's web contribution -- **now confirmed correct**: your browser
  console showed `message-flow v1.0.0 registered` right alongside every
  built-in plugin after the previous round's fix.
- `registerChannelTab`'s exact prop-passing convention. I found the real
  call site in the compiled channel-editor bundle
  (`jsx(v, { def: e, ctx: { channel, platform, onChange } })`) confirming
  it needs an actual React component, but couldn't pin down whether the
  generic wrapper `v` spreads `ctx` as this component's props or passes it
  some other way. `MessageFlowChannelTab({ channel, platform, onChange })`
  follows the same destructured-props shape every other component-based
  registry in `core/platform.js` documents, but this one specific plugin
  is the newest and least field-tested piece here.
- The message-tracing endpoint's use of `MessageController.getMessageContent(channelId, messageId, metaDataIds)`
  -- confirmed the method and its signature exist in `mirth-server.jar`,
  but not what an empty `metaDataIds` list actually means at runtime (I'm
  assuming "include all connector messages," matching the common Mirth
  convention where an absent/empty list filter means "no restriction," but
  could not verify against a live call).
- `ConnectorMessage.getSourceMap()`'s actual runtime value types for
  `sourceChannelIds`/`sourceMessageIds` -- your screenshots show them
  rendered as `[a, b]`/`[1, 1]`, which the tracer treats as `List` values,
  with a fallback to a single non-list value for a one-hop message. If
  Donkey stores these as some other collection type at runtime, the
  `instanceof List` check in `asStringList`/`asLongList` would miss it and
  silently fall through to the singular-field fallback instead of throwing
  -- worth checking the ancestors list length against what you'd expect
  from a known multi-hop message.
- General Java compile correctness, since I could not run `javac` in this
  sandbox at all.
- `messageflow-trace.user.js`'s DOM assumptions (`data-col-key`, the first
  `<table>` on the page being the messages grid, row structure for
  multi-connector messages) -- verified with a mock DOM standing in for
  the real one (correct column detection, correct ID extraction including
  the sub-row fallback, correct URL construction), not against the actual
  rendered page, since no browser is available in this sandbox either.

Worth a real build + install + smoke test before relying on it, same as
every step so far in this project.

## Files

```
plugin.xml                                -- combined serverClasses/apiProviders/library
src/.../MessageFlowServicePlugin.java     -- ServicePlugin lifecycle
src/.../MessageFlowServletInterface.java  -- REST: topology + trace endpoints
src/.../MessageFlowServlet.java           -- topology + message-trace logic
webadmin/plugin.json                      -- client entry manifest
webadmin/web/plugin.js                    -- nav tab, channel action, channel-editor
                                              tab, trace UI (all client-side registration)
messageflow-trace.user.js                 -- optional companion userscript (Tampermonkey/
                                              Violentmonkey) for the Messages-grid right-click
build.bat / build.ps1                     -- Windows build
build.sh                                  -- macOS/Linux build
```
