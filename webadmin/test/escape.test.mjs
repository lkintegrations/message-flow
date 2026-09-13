// SPDX-FileCopyrightText: Copyright 2026 Synthesis Health
// SPDX-FileCopyrightText: Copyright 2026 Keith Smith
// SPDX-License-Identifier: MPL-2.0
//
// Run with: node --test 'webadmin/test/*.test.mjs'
//
// esc() is the only security-relevant pure function in the client, and its
// output lands in HTML attributes as well as text. These tests read the
// escaper out of the shipped plugin.js and evaluate it in isolation rather
// than importing the module: plugin.js imports "@oie/web-shell", which only
// exists inside the web administrator. Extracting keeps the test honest about
// what actually ships without restructuring the module around the test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function loadEsc() {
  const source = readFileSync(new URL("../web/plugin.js", import.meta.url), "utf8");
  const match = source.match(/const esc = \(s\) =>[\s\S]*?;\n/);
  assert.ok(match, "could not find esc() in plugin.js; the test needs updating");
  return new Function(`${match[0]} return esc;`)();
}

const esc = loadEsc();

test("escapes the text-context characters", () => {
  assert.equal(esc("a & b"), "a &amp; b");
  assert.equal(esc("<script>"), "&lt;script&gt;");
});

test("escapes quotes, because output lands in HTML attributes", () => {
  assert.equal(esc('say "hi"'), "say &quot;hi&quot;");
  assert.equal(esc("it's"), "it&#39;s");
});

// The actual attack: channel names are chosen by anyone who can create a
// channel, and they are interpolated into title=, value= and
// data-select-channel=. Without quote escaping this breaks out of the
// attribute and runs.
test("a channel name cannot break out of an attribute", () => {
  const hostile = 'x" onmouseover="alert(1)';
  const escaped = esc(hostile);
  assert.ok(!escaped.includes('"'), "no bare double quote may survive");
  const rendered = `<div title="${escaped}">`;
  assert.equal(rendered, '<div title="x&quot; onmouseover=&quot;alert(1)">');
});

test("a single-quoted attribute cannot be broken out of either", () => {
  const escaped = esc("x' onmouseover='alert(1)");
  assert.ok(!escaped.includes("'"), "no bare single quote may survive");
});

test("ampersands are escaped before the entities they would corrupt", () => {
  // Escaping & last would turn &lt; into &amp;lt; and render the tag as text
  // in one pass and as markup in another.
  assert.equal(esc("&lt;"), "&amp;lt;");
});

test("coerces non-strings rather than throwing", () => {
  assert.equal(esc(42), "42");
  assert.equal(esc(null), "null");
  assert.equal(esc(undefined), "undefined");
});

test("leaves ordinary text alone", () => {
  assert.equal(esc("Billing Feed 2"), "Billing Feed 2");
});

// The Maven build never parses plugin.js, so a syntax error in it would ship
// silently: the extension zip would assemble and the nav tab would simply fail
// to load. Loading the module here is the only thing that catches that.
test("plugin.js is a loadable module exporting register()", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const source = readFileSync(new URL("../web/plugin.js", import.meta.url), "utf8")
    // "@oie/web-shell" only resolves inside the web administrator.
    .replace(/^import \{ platform \} from "@oie\/web-shell";$/m, "const platform = {};");
  const file = join(mkdtempSync(join(tmpdir(), "mf-")), "plugin.mjs");
  writeFileSync(file, source);

  globalThis.document = {
    createElement: () => ({ setAttribute() {}, style: {}, appendChild() {} }),
    head: { appendChild() {} },
    body: { appendChild() {} },
  };
  const module = await import(`file://${file}`);
  assert.equal(typeof module.register, "function");
});

// A script route whose target name resolves to no known channel carries a null
// toId. Left in the layout it became an object key, and the graph drew a
// floating circle labelled "null" with no edge attached.
test("an unresolvable route target does not become a phantom node", async () => {
  const source = readFileSync(new URL("../web/plugin.js", import.meta.url), "utf8");
  const fn = source.match(/function computeFocus[\s\S]*?\n}\n/);
  assert.ok(fn, "could not find computeFocus in plugin.js; the test needs updating");
  const computeFocus = new Function(`${fn[0]} return computeFocus;`)();

  const focus = computeFocus("A", [
    { fromId: "A", toId: "B" },
    { fromId: "A", toId: null, viaScript: true },
  ]);

  assert.deepEqual([...focus.nodeIds].sort(), ["A", "B"]);
  assert.equal(focus.relevantEdges.length, 1);
});

// nav-layout puts an item with no section into "Plugins". Setting section:
// "Monitor" put this third-party view among the shell's own operational ones.
test("the nav item registers with no section, so it lands under Plugins", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const source = readFileSync(new URL("../web/plugin.js", import.meta.url), "utf8")
    .replace(/^import \{ platform \} from "@oie\/web-shell";$/m, "const platform = {};");
  const file = join(mkdtempSync(join(tmpdir(), "mf-")), "plugin.mjs");
  writeFileSync(file, source);
  globalThis.document = {
    createElement: () => ({ setAttribute() {}, style: {}, appendChild() {} }),
    head: { appendChild() {} }, body: { appendChild() {} },
  };

  const { register } = await import(`file://${file}`);
  const navItems = [], channelActions = [], views = [];
  register({
    registerNavItem: (i) => navItems.push(i),
    registerView: (p, h, m) => views.push({ p, m }),
    registerChannelAction: (a) => channelActions.push(a),
  });

  assert.equal(navItems.length, 1);
  assert.equal(navItems[0].section, undefined, "a section would override the Plugins grouping");
  assert.equal(navItems[0].path, "/message-flow");
  assert.equal(channelActions.length, 1, "the channel right-click action is still registered");
  assert.equal(views.length, 1);
});

// OIE Source Code Search returns XStream-shaped JSON: a fully-qualified
// wrapper, and a single match as an object where several come back as an array.
// Getting that wrong loses every result on an engine with exactly one hit.
/* Pulls named functions out of the shipped plugin.js and evaluates them. The
   module imports "@oie/web-shell", which only resolves inside the web
   administrator, so it cannot simply be imported here. `also` names the helpers
   and constants a function depends on. */
function loadFn(name, also = []) {
  const src = readFileSync(new URL("../web/plugin.js", import.meta.url), "utf8");
  const grab = (pattern, label) => {
    const m = src.match(pattern);
    assert.ok(m, `could not find ${label} in plugin.js; the test needs updating`);
    return m[0];
  };
  /* A constant is taken to the end of its own statement, not to the next blank
     line. The blank-line form broke twice: once when the constants were split
     into two blocks, and again when a comment between them contained a blank
     line of its own, which ended the match inside the comment and handed
     new Function an unterminated one. */
  const deps = also.map((d) => grab(
    d.startsWith("const ") ? new RegExp(`${d}[\\s\\S]*?;\\n`) : new RegExp(`function ${d}[\\s\\S]*?\\n}\\n`), d));
  const body = grab(new RegExp(`function ${name}[\\s\\S]*?\\n}\\n`), name);
  return new Function(`${deps.join("")}${body} return ${name};`)();
}

/* Named one at a time. "const SCS_PATH" used to stand in for the whole block,
   because the extraction ran to the next blank line and swallowed everything
   after it; a dependency that arrives by accident is one nobody maintains. */
/* The search pipeline, built once. Three tests used to hand-list the same
   grabs, and each time a function gained a dependency they drifted apart one at
   a time. Whatever fetchRouteCalls needs is listed here and nowhere else. */
function loadSearchPipeline() {
  const src = readFileSync(new URL("../web/plugin.js", import.meta.url), "utf8");
  const grab = (re) => { const m = src.match(re); assert.ok(m, `missing ${re} in plugin.js`); return m[0]; };
  return new Function([
    /const SCS_PATH[\s\S]*?;\n/, /const ROUTE_CALL = [\s\S]*?;\n/,
    /const ROUTE_CALL_PATTERN[\s\S]*?;\n/, /const LITERAL_ARG[\s\S]*?;\n/,
    /const CONCATENATED[\s\S]*?;\n/, /const FIRST_LITERAL[\s\S]*?;\n/,
    /function unavailableReason[\s\S]*?\n}\n/, /function callIsCommented[\s\S]*?\n}\n/,
    /function callRunsOn[\s\S]*?\n}\n/,
    /function describeCall[\s\S]*?\n}\n/, /async function fetchRouteCalls[\s\S]*?\n}\n/,
  ].map(grab).join("") +
    " return { fetchRouteCalls, describeCall, callIsCommented, ROUTE_CALL, PATTERN: ROUTE_CALL_PATTERN };")();
}

const CALL_CONSTANTS = ["const ROUTE_CALL", "const LITERAL_ARG", "const CONCATENATED", "const FIRST_LITERAL"];

const CHARACTERIZE_DEPS = [...CALL_CONSTANTS, "callRunsOn", "unresolvableRoutes"];

const CALL_DEPS = [...CALL_CONSTANTS, "callRunsOn"];

test("a call's target and shape are read from the source line", () => {
  const describeCall = loadFn("describeCall", CALL_DEPS);

  const literal = describeCall({ lineText: "routeMessage('Billing', msg);" });
  assert.equal(literal.target, "Billing");
  assert.equal(literal.dynamic, null);
  assert.equal(literal.traced, true, "the library call records lineage");

  const viaRouter = describeCall({ lineText: "router.routeMessage('Billing', msg);" });
  assert.equal(viaRouter.traced, false, "the bare router call records none");

  const built = describeCall({ lineText: "routeMessage('SITE_' + site, msg);" });
  assert.equal(built.dynamic, "concatenated");
  assert.equal(built.target, "SITE_", "only the literal part is readable, which is why it cannot be trusted");

  const variable = describeCall({ lineText: "router.routeMessage(target, msg);" });
  assert.equal(variable.dynamic, "variable");
  assert.equal(variable.target, null);
});

test("a call is matched to its edge by target, or by being the only one", () => {
  const callFor = loadFn("callFor", CALL_DEPS);
  const two = { byChannel: { c1: [
    { target: "Alpha", location: "Source Transformer", lineNumber: 4 },
    { target: "Beta", location: "Postprocessor", lineNumber: 9 },
  ] } };
  assert.equal(callFor(two, { fromId: "c1", viaScript: true, destName: "routeMessage('Beta')" }).lineNumber, 9);

  const one = { byChannel: { c1: [{ target: null, location: "Preprocessor", lineNumber: 2 }] } };
  assert.equal(callFor(one, { fromId: "c1", viaScript: true, destName: "routeMessage('Whatever')" }).lineNumber, 2,
    "a single call in the channel needs no disambiguation");

  assert.equal(callFor(two, { fromId: "c1", viaScript: true, destName: "routeMessage('Unknown')" }), null,
    "guessing between two calls would attach the wrong line");
  assert.equal(callFor(two, { fromId: "c1", destName: "Billing" }), null, "a connector route has no call");
  assert.equal(callFor({ unavailable: "absent" }, { fromId: "c1", viaScript: true, destName: "x" }), null);
});

test("rendering a call marks everything that is not a quoted literal", () => {
  const renderCall = loadFn("renderCall", ["const esc"]);

  const plain = renderCall("routeMessage('Billing', msg)");
  assert.ok(plain.includes("&#39;Billing&#39;"), "the literal target is shown as written");
  assert.ok(plain.includes('class="mf-dyn"'), "the function name and msg argument are not literals");

  const built = renderCall("routeMessage('SITE_' + site, msg)");
  const marked = [...built.matchAll(/<span class="mf-dyn">([^<]*)<\/span>/g)].map((m) => m[1]).join("");
  assert.ok(marked.includes("site"), "the variable half of a built name must be visible as such");
  assert.ok(built.includes("&#39;SITE_&#39;"), "the literal half stays plain");

  assert.equal(renderCall(""), "", "nothing to render is not an error");
});

test("escaping survives the call renderer", () => {
  const renderCall = loadFn("renderCall", ["const esc"]);
  const out = renderCall("routeMessage('<img src=x onerror=alert(1)>', msg)");
  assert.ok(!out.includes("<img"), "source text is escaped before it reaches the page");
  assert.ok(out.includes("&lt;img"));
});

test("unresolvable routes are the calls whose target is computed", () => {
  const unresolvableRoutes = loadFn("unresolvableRoutes", CALL_DEPS);
  const idx = { byChannel: { c1: [
    { target: "Billing", dynamic: null },
    { target: null, dynamic: "variable" },
    { target: "SITE_", dynamic: "concatenated" },
  ] } };
  assert.equal(unresolvableRoutes(idx, "c1").length, 2);
  assert.deepEqual(unresolvableRoutes({ unavailable: "absent" }, "c1"), []);
});

// What the overview says about an engine. The figures that survived are the two
// that name something to go and look at; the in/out-degree shapes were cut.
test("channels with no route in are split by how they can receive", () => {
  const characterize = loadFn("characterize", CHARACTERIZE_DEPS);
  const c = characterize({
    nodes: [
      { id: "listener", name: "Listener", sourceTransport: "TCP Listener" },
      { id: "reader", name: "Reader", sourceTransport: "Channel Reader" },
      { id: "fed", name: "Fed", sourceTransport: "Channel Reader" },
    ],
    edges: [{ fromId: "listener", toId: "fed" }],
    externalDestinations: [],
  }, null);

  assert.deepEqual(c.entry.map((n) => n.name), ["Listener"],
    "a listener nothing routes to takes messages from outside, which is expected");
  assert.deepEqual(c.unfed.map((n) => n.name), ["Reader"],
    "a Channel Reader nothing routes to has nothing reaching it at all");
});

test("computed targets are counted, because any of them could explain an unreached channel", () => {
  const characterize = loadFn("characterize", CHARACTERIZE_DEPS);
  const codeIndex = { byChannel: { a: [{ dynamic: "variable" }] } };
  const c = characterize({
    nodes: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    edges: [],
    externalDestinations: [{ channelId: "b", dynamicRouting: true }],
  }, codeIndex);

  assert.equal(c.computedTargets, 2, "one script route and one Channel Writer template");
  assert.equal(characterize({ nodes: [], edges: [], externalDestinations: [] }, null).computedTargets, 0);
});

test("channels a trace cannot follow are counted from every cause, without double counting", () => {
  const characterize = loadFn("characterize", CHARACTERIZE_DEPS);
  const c = characterize({
    nodes: [{ id: "a", name: "A", traceGap: "stores no maps" }, { id: "b", name: "B" }, { id: "c", name: "C" }],
    // A has both a storage gap and a route that sends no source map: still one channel
    edges: [{ fromId: "a", toId: "b", traceable: false }, { fromId: "b", toId: "c", traceable: true }],
    externalDestinations: [],
  }, null);
  assert.deepEqual(c.gaps.map((n) => n.name), ["A"]);
});



// The parser's reconstruction must never be dressed as source. Rendering it in
// the same monospace as a located call claimed evidence that was not there, and
// next to an empty location it read as a contradiction: here is the call, and
// no, we cannot find the call.
test("an unlocated call is visibly not source code", () => {
  const renderCall = loadFn("renderCall", ["const esc"]);
  const located = renderCall("routeMessage('MF_LoopB', message);");
  assert.ok(located.includes('class="mf-call"'), "a located call is shown as code");
  assert.ok(located.includes("message"), "including the arguments actually written");
  // The unlocated branch builds a plain description from destName rather than
  // calling renderCall at all, so the two can never be confused.
  assert.ok(!located.startsWith("<span style=\"color:var(--text-dim)\">"));
});

// The Route with Sources library defines routeMessage; it does not route
// anywhere. Listing its own definition and its internal delegation to router as
// "routing inside code templates" reports the plumbing as traffic.
test("a code template defining the helpers is not reported as routing", async () => {
  const { fetchRouteCalls } = loadSearchPipeline();

  const matches = [
    { groupType: "CODE_TEMPLATE", channelId: "t1", lineText: "function routeMessage(channelName, message, sourceMap, destinationSet) {" },
    { groupType: "CODE_TEMPLATE", channelId: "t1", lineText: "return router.routeMessage(channelName, createRawMessage(message, sourceMap, destinationSet))" },
    { groupType: "CODE_TEMPLATE", channelId: "t2", lineText: "routeMessage('Billing', msg);" },
    { groupType: "CHANNEL", channelId: "c1", lineText: "routeMessage('Archive', msg);" },
  ];
  const api = {
    get: async () => ({ "com.diridium.sourcecodesearch.SearchResults": {
      matches: { "com.diridium.sourcecodesearch.SearchMatch": matches } } }),
    asList: (v, k) => (v && v[k]) || [],
  };

  const idx = await fetchRouteCalls(api);
  assert.equal(idx.inCodeTemplates.length, 1, "only the call with a real target counts");
  assert.equal(idx.inCodeTemplates[0].target, "Billing");
  assert.equal(Object.keys(idx.byChannel).length, 1, "channel calls are indexed separately");
});

// core/api.js strips a single XStream root key before a caller sees the body,
// so the platform client hands back the contents of SearchResults while curl
// shows the envelope. Reading only the envelope form found nothing in the
// browser while every harness that replayed a raw body passed.
test("search results parse whether the envelope was already opened", async () => {
  const { fetchRouteCalls } = loadSearchPipeline();

  // the real asList, from core/api.js
  const asList = (value, key) => {
    if (value === null || value === undefined || value === "") return [];
    if (key !== undefined && value && typeof value === "object" && !Array.isArray(value)) {
      if (value[key] !== undefined) value = value[key];
      if (value === null || value === undefined || value === "") return [];
    }
    return Array.isArray(value) ? value : [value];
  };
  const matches = [{ groupType: "CHANNEL", channelId: "c1", lineNumber: 2,
                     location: "Preprocessing Script", lineText: "routeMessage('Archive', msg);" }];
  const inner = { matches: { "com.diridium.sourcecodesearch.SearchMatch": matches } };

  const opened = await fetchRouteCalls({ get: async () => inner, asList });
  assert.equal(opened.byChannel.c1?.length, 1, "the shape the platform client actually delivers");

  const enveloped = await fetchRouteCalls({
    get: async () => ({ "com.diridium.sourcecodesearch.SearchResults": inner }), asList });
  assert.equal(enveloped.byChannel.c1?.length, 1, "and the raw body, for anything that bypasses the client");
});

// The target argument is often itself a call, so the first bracket or comma is
// not the end of it. Truncating $c('routeTo') to $c('routeTo names the wrong
// thing as what decides the route.
test("the deciding expression survives nesting, quotes and brackets", () => {
  const targetExpression = loadFn("targetExpression");
  const cases = [
    ["router.routeMessage(target, message);", "target"],
    ["routeMessage($c('routeTo'), msg);", "$c('routeTo')"],
    ["routeMessage('SITE_' + site, msg);", "'SITE_' + site"],
    ["routeMessage(map.get('a,b'), msg);", "map.get('a,b')"],
    ["routeMessage(list[0], msg);", "list[0]"],
    ["routeMessage(pick(a, b), msg);", "pick(a, b)"],
    ["routeMessage('Billing');", "'Billing'"],
    ["routeMessage('Billing', msg);", "'Billing'"],
    ["routeMessageByChannelId(id, msg);", "id"],
  ];
  for (const [line, expected] of cases) {
    assert.equal(targetExpression(line), expected, line);
  }
  assert.equal(targetExpression("var x = 1;"), null, "no call, no expression");
  assert.equal(targetExpression(""), null);
});

// Statistics are cumulative since they were last cleared, and the API returns
// nothing for undeployed channels unless asked, so a missing row is not a zero.
test("received counts index by channel and survive an unavailable endpoint", async () => {
  const src = readFileSync(new URL("../web/plugin.js", import.meta.url), "utf8");
  const m = src.match(/async function fetchReceivedCounts[\s\S]*?\n}\n/);
  assert.ok(m, "could not find fetchReceivedCounts");
  const fetchReceivedCounts = new Function(`${m[0]} return fetchReceivedCounts;`)();

  const ok = await fetchReceivedCounts({ statistics: { list: async (ids, includeUndeployed) => {
    assert.equal(includeUndeployed, true, "undeployed channels must be included or most rows are missing");
    return [{ channelId: "a", received: 12 }, { channelId: "b", received: 0 }];
  } } });
  assert.deepEqual(ok, { a: 12, b: 0 });

  const failed = await fetchReceivedCounts({ statistics: { list: async () => { throw new Error("403"); } } });
  assert.equal(failed, null, "unavailable statistics must read as unknown, never as zero");

  const empty = await fetchReceivedCounts({ statistics: { list: async () => null } });
  assert.deepEqual(empty, {}, "no rows is not an error");
});

// Loading the module proves it parses; it does not prove the view renders. A
// function deleted by an over-wide edit stays invisible until a browser calls
// it, and every other test here passed while the overview threw on every load.
// This renders both views against real payload shapes with a stub DOM.
test("both views render without throwing", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const source = readFileSync(new URL("../web/plugin.js", import.meta.url), "utf8")
    .replace(/^import \{ platform \} from "@oie\/web-shell";$/m, "const platform = {};");
  const file = join(mkdtempSync(join(tmpdir(), "mf-")), "plugin.mjs");
  writeFileSync(file, source);

  const node = () => ({
    _html: "", className: "", style: {}, hidden: false,
    setAttribute() {}, getAttribute() { return null; }, appendChild() {},
    addEventListener() {}, querySelector() { return node(); }, querySelectorAll() { return []; },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
  });
  globalThis.document = { createElement: node, head: { appendChild() {} }, body: { appendChild() {} } };

  const topology = {
    nodes: [
      { id: "a", name: "A", sourceTransport: "TCP Listener" },
      { id: "b", name: "B", sourceTransport: "Channel Reader", traceGap: "no maps", traceGapCause: "Storage mode is METADATA" },
    ],
    edges: [
      { fromId: "a", fromName: "A", toId: "b", toName: "B", destName: "B", via: "connector", destinationId: 1, enabled: true },
      { fromId: "a", fromName: "A", toId: null, toName: null, toNone: true, destName: "Parked", via: "connector", destinationId: 2, enabled: true },
      { fromId: "b", fromName: "B", toId: "a", toName: "A", destName: "router.routeMessage('A')", via: "script", viaScript: true, traceable: false, enabled: null },
    ],
    externalDestinations: [
      { channelId: "a", channelName: "A", destName: "Vendor", transportName: "TCP Sender", enabled: true },
      { channelId: "b", channelName: "B", destName: "Site", transportName: "Channel Writer", enabled: true, dynamicRouting: true, dynamicTarget: "${site}", destinationId: 3 },
    ],
    unconfiguredCount: 1,
  };
  const searchResults = { matches: { "com.diridium.sourcecodesearch.SearchMatch": [
    { groupType: "CHANNEL", channelId: "b", location: "Preprocessing Script", lineNumber: 2,
      lineText: "router.routeMessage('A', msg);" },
  ] } };

  const api = {
    get: async (path) => (path.includes("messageFlow") ? topology : searchResults),
    asList: (v, k) => {
      if (v == null) return [];
      if (k && v && typeof v === "object" && !Array.isArray(v) && v[k] !== undefined) v = v[k];
      return Array.isArray(v) ? v : [v];
    },
    statistics: { list: async () => [{ channelId: "b", received: 0 }] },
  };

  let handler = null;
  const { register } = await import(`file://${file}`);
  register({
    api,
    ui: { icon: () => ({ setAttribute() {}, outerHTML: "<svg/>" }) },
    registerNavItem() {}, registerChannelAction() {},
    registerView: (path, h) => { handler = h; },
  });
  assert.ok(handler, "the view must be registered");

  const overview = await handler({ query: {} });
  assert.ok(overview, "the overview must render");

  const channel = await handler({ query: { channelId: "a" } });
  assert.ok(channel, "a channel view must render");
});

// A storage setting that discards the source map costs nothing on a channel
// nothing routes to: its messages come from outside the engine and never had an
// ancestor to lose. Counting it there reports a condition with no consequence.
test("a storage gap counts only where something routes to the channel", () => {
  const characterize = loadFn("characterize", CHARACTERIZE_DEPS);
  const c = characterize({
    nodes: [
      { id: "src", name: "Source", sourceTransport: "JavaScript Reader" },
      { id: "fed", name: "Fed", sourceTransport: "Channel Reader", traceGap: "storage mode is METADATA" },
      { id: "alone", name: "Alone", sourceTransport: "JavaScript Reader", traceGap: "storage mode is METADATA" },
    ],
    edges: [{ fromId: "src", toId: "fed", traceable: true }],
    externalDestinations: [],
  }, null);

  assert.deepEqual(c.gaps.map((n) => n.name), ["Fed"],
    "Alone has the same setting and nothing routes to it, so nothing is lost");
});

test("a channel that sends without a source map always loses the trail", () => {
  const characterize = loadFn("characterize", CHARACTERIZE_DEPS);
  const c = characterize({
    nodes: [{ id: "a", name: "Sender", sourceTransport: "JavaScript Reader" }, { id: "b", name: "B" }],
    edges: [{ fromId: "a", toId: "b", traceable: false }],
    externalDestinations: [],
  }, null);

  assert.deepEqual(c.gaps.map((n) => n.name), ["Sender"],
    "nothing routes to it either, but what it sends onward arrives with no source map");
});

// The landing page's own tables, rendered rather than reasoned about. The
// defect these cover shipped through a green suite: the third column of the
// "no inbound route" table was headed "Messages received" but rendered
// n.traceGapCause when the channel had one, so a channel on METADATA storage
// showed its storage setting where its count belonged. A storage setting is
// neither a count nor a reason a count is missing, and the caveat above the
// table cites the very counts the column was hiding.
//
// Driving it needs the filter cards to be clickable, so the stub resolves
// [data-filter] out of the HTML it was just given and hands back elements that
// record their listeners. That is the only way to reach the filtered views:
// the filter is closure state, set by a click and by nothing else.
async function renderOverviewFiltered(topology, statRows, filterKey, searchResults = { matches: {} }) {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const source = readFileSync(new URL("../web/plugin.js", import.meta.url), "utf8")
    .replace(/^import \{ platform \} from "@oie\/web-shell";$/m, "const platform = {};");
  const file = join(mkdtempSync(join(tmpdir(), "mf-")), "plugin.mjs");
  writeFileSync(file, source);

  let made = [];
  const node = () => {
    const el = {
      _html: "", _attrs: {}, _clicks: [], className: "", style: {}, hidden: false,
      setAttribute(k, v) { this._attrs[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
      appendChild() {},
      addEventListener(type, fn) { if (type === "click") this._clicks.push(fn); },
      querySelector() { return node(); },
      querySelectorAll(sel) {
        if (sel !== "[data-filter]") return [];
        return [...this._html.matchAll(/data-filter="([^"]*)"/g)].map((m) => {
          const b = node();
          b.setAttribute("data-filter", m[1]);
          return b;
        });
      },
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = String(v); },
    };
    made.push(el);
    return el;
  };
  globalThis.document = { createElement: node, head: { appendChild() {} }, body: { appendChild() {} } };

  const api = {
    get: async (path) => (path.includes("messageFlow") ? topology : searchResults),
    asList: (v, k) => {
      if (v == null) return [];
      if (k && v && typeof v === "object" && !Array.isArray(v) && v[k] !== undefined) v = v[k];
      return Array.isArray(v) ? v : [v];
    },
    statistics: { list: async () => statRows },
  };

  let handler = null;
  const { register } = await import(`file://${file}`);
  register({
    api,
    ui: { icon: () => ({ setAttribute() {}, outerHTML: "<svg/>" }) },
    registerNavItem() {}, registerChannelAction() {},
    registerView: (path, h) => { handler = h; },
  });
  await handler({ query: {} });

  const card = made.find((el) => el.getAttribute("data-filter") === filterKey && el._clicks.length);
  assert.ok(card, `no clickable card for "${filterKey}"; the overview cards have changed`);
  made = [];               // so only the re-render after the click is read back
  card._clicks[0]();
  return made.map((el) => el._html).filter(Boolean).join("\n");
}

// reader is the case that broke: no route in, and a storage setting that used
// to win the column. sender loses the trail by routing, sink by storage, so
// the trace view has to carry both causes at once.
const overviewTopology = {
  nodes: [
    { id: "reader", name: "Reader", sourceTransport: "Channel Reader",
      traceGapCause: "Storage mode is METADATA", traceGap: "This mode does not store maps." },
    { id: "sender", name: "Sender", sourceTransport: "TCP Listener" },
    { id: "sink", name: "Sink", sourceTransport: "Channel Reader",
      traceGapCause: "Storage mode is RAW", traceGap: "This mode does not store maps." },
  ],
  edges: [
    { fromId: "sender", fromName: "Sender", toId: "sink", toName: "Sink",
      destName: "routeMessage('Sink')", via: "script", viaScript: true, traceable: false, enabled: null },
  ],
  externalDestinations: [],
  unconfiguredCount: 0,
};
const overviewStats = [
  { channelId: "reader", received: 42 },
  { channelId: "sender", received: 7 },
  { channelId: "sink", received: 3 },
];

test("Messages received holds the count, never a storage setting", async () => {
  const html = await renderOverviewFiltered(overviewTopology, overviewStats, "noroutein");

  assert.match(html, />Messages received</, "the count column must still be there and labelled");
  assert.match(html, />42</, "the channel's received count must be what the column shows");
  assert.doesNotMatch(html, /Storage mode is/,
    "a storage setting is not a message count, and not a reason one is missing");
});

test("the trace card opens the section that gives each gap its own cause and fix", async () => {
  const html = await renderOverviewFiltered(overviewTopology, overviewStats, "trace");

  assert.match(html, /Where message tracing will fail/, "the trace card must open the existing section");
  assert.match(html, /Storage mode is RAW/, "a storage gap must name the setting responsible");
  assert.match(html, /Routes with/, "a routing gap must name the call responsible");
  assert.doesNotMatch(html, />Messages received</,
    "the trace view answers why a trail is lost, so it must not draw the count table too");
});

// A channel used to get one row per route call, in a table whose row said
// nothing about which call it was, so three calls printed three identical rows
// and the remedy paragraph three times. The two kinds of cause were also
// emitted in separate blocks, which put a channel's storage row a long way from
// its routing rows on any engine with more than one channel.
const multiGapTopology = {
  nodes: [
    { id: "hub", name: "Hub", sourceTransport: "TCP Listener",
      traceGapCause: "Storage mode is RAW", traceGap: "This mode does not store maps." },
    { id: "x", name: "X", sourceTransport: "Channel Reader" },
    { id: "y", name: "Y", sourceTransport: "Channel Reader" },
    { id: "z", name: "Z", sourceTransport: "Channel Reader" },
  ],
  edges: [
    { fromId: "hub", fromName: "Hub", toId: "x", toName: "X", destName: "router.routeMessage('X')", via: "script", viaScript: true, traceable: false },
    { fromId: "hub", fromName: "Hub", toId: "y", toName: "Y", destName: "router.routeMessage('Y')", via: "script", viaScript: true, traceable: false },
    { fromId: "hub", fromName: "Hub", toId: "z", toName: "Z", destName: "router.routeMessage('Z')", via: "script", viaScript: true, traceable: false },
    { fromId: "x", fromName: "X", toId: "hub", toName: "Hub", destName: "To Hub", via: "connector", destinationId: 1, enabled: true },
  ],
  externalDestinations: [],
  unconfiguredCount: 0,
};

test("a channel appears once in the tracing table, however many ways it loses the trail", async () => {
  const html = await renderOverviewFiltered(multiGapTopology, [], "trace");
  const section = html.slice(html.indexOf("Where message tracing will fail"));
  const rows = [...section.matchAll(/<tr>(?:(?!<\/tr>)[\s\S])*?<\/tr>/g)].map((m) => m[0]);
  const hubRows = rows.filter((r) => r.includes('data-open="hub"'));

  assert.equal(hubRows.length, 1,
    `Hub loses the trail three ways by routing and once by storage, and must still be one row; got ${hubRows.length}`);

  // Both reasons on that row, each with its own remedy beside it.
  assert.match(hubRows[0], /Routes with/, "the routing cause must be on the row");
  assert.match(hubRows[0], /Storage mode is RAW/, "the storage cause must be on the same row");
  assert.match(hubRows[0], /Route with Sources/, "the routing remedy must be there");
  assert.match(hubRows[0], /Production or Development|does not store maps/, "the storage remedy must be there");

  // The calls are what differs between the rows this used to print, so they are
  // named rather than dropped.
  assert.match(hubRows[0], /3 calls:/, "the row must say how many calls there are to change");
  ["X", "Y", "Z"].forEach((t) => assert.match(hubRows[0], new RegExp(`routeMessage\\(&#39;${t}&#39;\\)`),
    `the call routing to ${t} must be named`));

  // And the remedy is stated once, not once per call. Counted on a phrase
  // unique to the paragraph body: "Route with Sources" is in it three times on
  // its own, once as text and twice inside the help link's title tooltip.
  assert.equal(section.split("prefix is the whole change").length - 1, 1,
    "the remedy paragraph must appear once, not once per route call");
});

// A channel routes three different ways: a Channel Writer to a known channel, a
// call whose target is a variable, and a Channel Writer whose target is a
// template. Each kind was rendered as its own block and the blocks were
// concatenated, so the channel headed a group near the top of the routing table
// and then appeared twice more further down, under other channels' names. They
// are one channel's outbound routing and belong in one group.
const scatteredTopology = {
  nodes: [
    { id: "dyn", name: "MF_DynamicScript", sourceTransport: "JavaScript Reader" },
    { id: "down", name: "Downstream", sourceTransport: "Channel Reader" },
    { id: "other", name: "Other", sourceTransport: "TCP Listener" },
  ],
  edges: [
    { fromId: "dyn", fromName: "MF_DynamicScript", toId: "down", toName: "Downstream", destName: "To Downstream", via: "connector", destinationId: 1, enabled: true },
    { fromId: "dyn", fromName: "MF_DynamicScript", toId: "other", toName: "Other", destName: "router.routeMessage('Other')", via: "script", viaScript: true, traceable: false },
    { fromId: "other", fromName: "Other", toId: "dyn", toName: "MF_DynamicScript", destName: "To Dyn", via: "connector", destinationId: 1, enabled: true },
  ],
  externalDestinations: [
    { channelId: "dyn", channelName: "MF_DynamicScript", destName: "Site router", transportName: "Channel Writer",
      enabled: true, dynamicRouting: true, dynamicTarget: "${site}", destinationId: 3 },
  ],
  unconfiguredCount: 0,
};
const scatteredSearch = { matches: { "com.diridium.sourcecodesearch.SearchMatch": [
  { groupType: "CHANNEL", channelId: "dyn", channelName: "MF_DynamicScript", location: "Source Transformer", lineNumber: 12,
    lineText: "routeMessage(targetName, msg);" },
  { groupType: "CHANNEL", channelId: "dyn", channelName: "MF_DynamicScript", location: "Destination 2 Script", lineNumber: 4,
    lineText: "router.routeMessage('Other', msg);" },
] } };

test("a channel's outbound routes are one group, whatever kind of route they are", async () => {
  const html = await renderOverviewFiltered(scatteredTopology, [], "routes", scatteredSearch);
  const start = html.indexOf("channel routing");
  const next = html.indexOf("mf-section-title", start + 10);
  const table = html.slice(start, next === -1 ? undefined : next);
  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((t) => t[1]))
    .filter((cells) => cells.length === 4);

  // The Channel cell names the channel once per group, so counting it counts groups.
  const headers = rows.filter((cells) => cells[0].includes('data-open="dyn"'));
  assert.equal(headers.length, 1,
    `MF_DynamicScript routes three different ways and must head one group; it headed ${headers.length}`);

  // All four of its routes sit in that group: the rows after the header, up to
  // the next named channel, are its and there are no others anywhere else.
  const at = rows.findIndex((cells) => cells[0].includes('data-open="dyn"'));
  let size = 1;
  while (at + size < rows.length && !/data-open=/.test(rows[at + size][0])) size++;
  assert.equal(size, 4,
    `all four of its routes belong to the one group; the group held ${size}`);

  const group = rows.slice(at, at + size).map((cells) => cells.join(" "));
  assert.ok(group.some((r) => r.includes("Downstream")), "the Channel Writer route must be in the group");
  assert.ok(group.some((r) => r.includes("routeMessage(targetName")), "the variable-target call must be in the group");
  assert.ok(group.some((r) => r.includes("site")), "the template-target Channel Writer must be in the group");

  // A channel named as somebody else's destination is a different thing, and
  // must not be swept into the grouping.
  const asTarget = rows.filter((cells) => cells[2].includes('data-open="dyn"'));
  assert.equal(asTarget.length, 1, "Other routes to it, so it stays linked in that row's To cell");
});

// A trace that runs one hop and then meets a route writing no source map used
// to stop with no explanation at all: every "why it stopped" note was gated on
// finding zero descendants, and each one asked about the channel the trace
// started from rather than the channel the chain ended at. The reason was drawn
// in the routing map directly above and never said here.
//
// Driving a trace needs stable nodes per selector, so the handler attached to
// "#mfTraceBtn" can be found and invoked.
async function runTraceView(topology, traceReply) {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const source = readFileSync(new URL("../web/plugin.js", import.meta.url), "utf8")
    .replace(/^import \{ platform \} from "@oie\/web-shell";$/m, "const platform = {};");
  const file = join(mkdtempSync(join(tmpdir(), "mf-")), "plugin.mjs");
  writeFileSync(file, source);

  const registry = new Map();
  const made = [];
  const node = (key) => {
    if (key && registry.has(key)) return registry.get(key);
    const el = {
      _html: "", _attrs: {}, _handlers: {}, value: "", className: "", style: {}, hidden: false,
      setAttribute(k, v) { this._attrs[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
      appendChild() {},
      addEventListener(t, fn) { (this._handlers[t] ||= []).push(fn); },
      querySelector(sel) { return node(sel); },
      querySelectorAll() { return []; },
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = String(v); },
    };
    if (key) registry.set(key, el);
    made.push(el);
    return el;
  };
  globalThis.document = { createElement: () => node(null), head: { appendChild() {} }, body: { appendChild() {} } };

  const api = {
    get: async (path) => (path.includes("/trace") ? traceReply
      : path.includes("messageFlow") ? topology : { matches: {} }),
    asList: (v, k) => {
      if (v == null) return [];
      if (k && v && typeof v === "object" && !Array.isArray(v) && v[k] !== undefined) v = v[k];
      return Array.isArray(v) ? v : [v];
    },
    statistics: { list: async () => [] },
  };

  let handler = null;
  const { register } = await import(`file://${file}`);
  register({
    api,
    ui: { icon: () => ({ setAttribute() {}, outerHTML: "<svg/>" }) },
    registerNavItem() {}, registerChannelAction() {},
    registerView: (path, h) => { handler = h; },
  });
  await handler({ query: { channelId: traceReply.channelId } });
  registry.get("#mfTraceMsgId").value = String(traceReply.messageId);
  await registry.get("#mfTraceBtn")._handlers.click[0]();
  return made.map((el) => el._html).filter(Boolean).join("\n");
}

/* The reason hanging off the unconfirmed node's question mark. Matched through
   the badge's own cursor:help group rather than by taking the first <title> in
   the view: the topology graph puts a <title> on every route line it draws, so
   the first one belongs to an edge and has nothing to do with the trace. */
function whyBadge(html) {
  const m = html.match(/cursor:help"[\s\S]*?<title>([\s\S]*?)<\/title>/);
  return m ? [m[0], m[1]] : null;
}

const billingTopology = {
  nodes: [
    { id: "src", name: "MF_Source", sourceTransport: "JavaScript Reader" },
    { id: "bill", name: "MF_Billing", sourceTransport: "JavaScript Reader" },
    { id: "arch", name: "MF_Archive", sourceTransport: "JavaScript Reader" },
  ],
  edges: [
    { fromId: "src", fromName: "MF_Source", toId: "bill", toName: "MF_Billing", destName: "To Billing", via: "connector", destinationId: 1, enabled: true },
    { fromId: "bill", fromName: "MF_Billing", toId: "arch", toName: "MF_Archive", destName: "router.routeMessage('MF_Archive')", via: "script", viaScript: true, traceable: false },
  ],
  externalDestinations: [],
  unconfiguredCount: 0,
};

test("a trace that stops at an untraceable hop says so, and draws where it would have gone", async () => {
  const html = await runTraceView(billingTopology, {
    channelId: "src", channelName: "MF_Source", messageId: 4,
    ancestors: [],
    descendants: [{ channelId: "bill", channelName: "MF_Billing", messageId: 1, status: "TRANSFORMED" }],
    truncated: false, scanErrors: 0,
  });

  // The chain reaches MF_Billing and the scan can go no further, so the channel
  // the map says is next is drawn, and drawn as unconfirmed.
  assert.match(html, /MF_Archive/, "the channel the trail leads to must be drawn");
  assert.match(html, /not confirmed/, "and must be marked unconfirmed, because no source map links this message to it");

  // Same hop, same line as the routing map draws it.
  assert.match(html, /stroke-dasharray="6,3"/, "the untraceable hop must be dashed as the routing map draws it");

  // The question mark carries the reason.
  const title = whyBadge(html);
  assert.ok(title, "the unconfirmed node must carry a ? explaining why");
  assert.match(title[1], /MF_Billing/, "the reason must name the channel the trail ends at, not the one traced from");
  assert.match(title[1], /router\.routeMessage/, "and must name what breaks the trail");

  // The reason is named for the channel the chain ended at. Naming MF_Source
  // here is the original defect: it was the channel traced from, not the one
  // the trail actually ended at.
  assert.doesNotMatch(title[1], /trail ends at MF_Source/,
    "the trail ends at MF_Billing; MF_Source is merely where the trace started");
});

test("a trace with somewhere left to go says nothing about trails ending", async () => {
  // Same engine, but traced from MF_Billing with no descendants recorded yet
  // and the untraceable hop still ahead of it: the note belongs here too.
  const html = await runTraceView(billingTopology, {
    channelId: "bill", channelName: "MF_Billing", messageId: 1,
    ancestors: [{ channelId: "src", channelName: "MF_Source", messageId: 4, status: "SENT" }],
    descendants: [], truncated: false, scanErrors: 0,
  });
  assert.match(html, /trail ends at MF_Billing/, "the channel traced from is also where the trail ends here");

  // And a channel whose onward routes are all traceable must not claim a gap.
  const clean = await runTraceView({ ...billingTopology, edges: [billingTopology.edges[0]] }, {
    channelId: "src", channelName: "MF_Source", messageId: 4,
    ancestors: [],
    descendants: [{ channelId: "bill", channelName: "MF_Billing", messageId: 1, status: "TRANSFORMED" }],
    truncated: false, scanErrors: 0,
  });
  assert.doesNotMatch(clean, /not confirmed/, "nothing unconfirmed may be drawn when no route writes off the trail");
  assert.doesNotMatch(clean, /trail ends/, "and no gap may be claimed");
});

// The case that prompted all of this, and the one the first attempt got wrong.
// MF_Billing's route onward is a Channel Writer destination that is switched
// off, not a script route. Reading the map's dashed line as the "writes no
// source map" dash rather than the "disabled" dash produced an explanation
// about source maps for a channel that never dispatched anything. A disabled
// route is the definite case: nothing was sent, so there is no downstream
// message that a trace failed to link, and it is checked before the rest.
const disabledOnwardTopology = {
  nodes: [
    { id: "src", name: "MF_Source", sourceTransport: "JavaScript Reader" },
    { id: "bill", name: "MF_Billing", sourceTransport: "JavaScript Reader" },
    { id: "arch", name: "MF_Archive", sourceTransport: "JavaScript Reader" },
  ],
  edges: [
    { fromId: "src", fromName: "MF_Source", toId: "bill", toName: "MF_Billing", destName: "To Billing", via: "connector", destinationId: 1, enabled: true },
    { fromId: "bill", fromName: "MF_Billing", toId: "arch", toName: "MF_Archive", destName: "To Archive", via: "connector", destinationId: 1, enabled: false },
  ],
  externalDestinations: [],
  unconfiguredCount: 0,
};

test("a trail that ends because the route onward is switched off says exactly that", async () => {
  const html = await runTraceView(disabledOnwardTopology, {
    channelId: "src", channelName: "MF_Source", messageId: 4,
    ancestors: [],
    descendants: [{ channelId: "bill", channelName: "MF_Billing", messageId: 1, status: "TRANSFORMED" }],
    truncated: false, scanErrors: 0,
  });

  assert.match(html, /route disabled/, "the node must be marked as a disabled route, not as unconfirmed");
  const title = whyBadge(html);
  assert.ok(title, "it must carry a ? explaining why");
  assert.match(title[1], /is disabled/, "the reason must be the disabled route");
  assert.match(title[1], /Destination 1: To Archive/, "and must name the destination to go and look at");

  // The wrong explanation, and the one this test exists to keep out: nothing
  // was dispatched, so no source map failed to travel with anything.
  assert.doesNotMatch(title[1], /source map/,
    "a disabled route dispatches nothing, so the source map is not why the trail ended");
  assert.doesNotMatch(html, /stroke-dasharray="6,3"/,
    "the hop must use the map's disabled dash, not its writes-no-source-map dash");
  assert.match(html, /stroke-dasharray="4,3"/, "the map draws a disabled route with a 4,3 dash");

  // Current configuration is not a record of what was true when the message
  // ran, and the wording has to admit that.
  assert.match(title[1], /configured now/, "it must not claim to know the setting at the time the message ran");
});

test("one disabled route among working ones does not explain a trail ending", async () => {
  // MF_Billing also has an enabled route, so a stopped trail is not accounted
  // for by the disabled one and nothing may be asserted about it.
  const mixed = {
    ...disabledOnwardTopology,
    nodes: [...disabledOnwardTopology.nodes, { id: "live", name: "MF_Live", sourceTransport: "Channel Reader" }],
    edges: [...disabledOnwardTopology.edges,
      { fromId: "bill", fromName: "MF_Billing", toId: "live", toName: "MF_Live", destName: "To Live", via: "connector", destinationId: 2, enabled: true }],
  };
  const html = await runTraceView(mixed, {
    channelId: "src", channelName: "MF_Source", messageId: 4,
    ancestors: [],
    descendants: [{ channelId: "bill", channelName: "MF_Billing", messageId: 1, status: "TRANSFORMED" }],
    truncated: false, scanErrors: 0,
  });
  assert.doesNotMatch(html, /route disabled/,
    "a live route out of the channel means the disabled one is not why the trail stopped");
  assert.doesNotMatch(html, /trail ends/, "and no cause may be claimed");
});

// Taken from the live engine rather than invented: MF_Billing has two disabled
// destinations, one pointing at MF_Archive and one a Channel Writer with no
// target at all. The second is what caught a wording bug that a made-up fixture
// did not: falling back on a missing toName described a Channel Writer set to
// None as "a channel the map cannot resolve", which is a different thing and
// ran straight into the next clause of the sentence.
const liveBillingTopology = {
  nodes: [
    { id: "src", name: "MF_Source", sourceTransport: "JavaScript Reader" },
    { id: "bill", name: "MF_Billing", sourceTransport: "JavaScript Reader" },
    { id: "arch", name: "MF_Archive", sourceTransport: "JavaScript Reader" },
  ],
  edges: [
    { fromId: "src", fromName: "MF_Source", toId: "bill", toName: "MF_Billing", destName: "Billing", via: "connector", destinationId: 1, enabled: true },
    { fromId: "bill", fromName: "MF_Billing", toId: "arch", toName: "MF_Archive", destName: "Archive", via: "connector", destinationId: 1, enabled: false },
    { fromId: "bill", fromName: "MF_Billing", toId: null, toName: null, toNone: true, destName: "Destination 2", via: "connector", destinationId: 2, enabled: false },
  ],
  externalDestinations: [],
  unconfiguredCount: 0,
};

test("a disabled Channel Writer with no target is named as None, not as unresolvable", async () => {
  const html = await runTraceView(liveBillingTopology, {
    channelId: "src", channelName: "MF_Source", messageId: 4,
    ancestors: [],
    descendants: [{ channelId: "bill", channelName: "MF_Billing", messageId: 1, status: "TRANSFORMED" }],
    truncated: false, scanErrors: 0,
  });
  const title = whyBadge(html);
  assert.ok(title, "the unconfirmed node must carry a ? explaining why");

  assert.match(title[1], /both of its routes onward are disabled/, "two disabled routes, said as two");
  assert.match(title[1], /Destination 1: Archive → MF_Archive/, "each destination is named with what it points at");
  assert.match(title[1], /Destination 2: Destination 2 → None/, "and a Channel Writer with no target says None");
  assert.doesNotMatch(title[1], /None \(a Channel Writer with no target set\) and there is/,
    "the target list must not run into the following clause");
  assert.doesNotMatch(title[1], /MF_Archive, a channel the map cannot resolve/,
    "a Channel Writer set to None is not an unresolvable channel");

  // The node is labelled for the one real channel among the targets, because
  // "2 channels" counts a thing that is not a channel.
  assert.match(html, /MF_Archive/, "the one real target names the node");
  assert.doesNotMatch(html, /2 channels/, "None is not a channel and must not be counted as one");
});

// The caveat above the no-inbound-route list is four answers to four different
// questions. Joined with spaces they became one six-sentence paragraph, roughly
// 700 characters of 11.5px text on a real engine, and the note's 80ch cap above
// a full-width table made that read as a narrow left-hand column. Labelled and
// full width now, with nothing dropped.
const caveatTopology = {
  nodes: [
    { id: "reader", name: "Lonely Reader", sourceTransport: "Channel Reader" },
    { id: "listener", name: "Front Door", sourceTransport: "TCP Listener" },
  ],
  edges: [],
  externalDestinations: [],
  unconfiguredCount: 0,
};

test("the no-inbound-route caveat is labelled lines, not one paragraph", async () => {
  const html = await renderOverviewFiltered(caveatTopology, [{ channelId: "reader", received: 5 }], "noroutein");

  const rows = [...html.matchAll(/<div class="mf-note-label">([^<]*)<\/div>\s*<div>([\s\S]*?)<\/div>/g)];
  assert.equal(rows.length, 4, `four questions, four labelled lines; got ${rows.length}`);
  assert.deepEqual(rows.map((m) => m[1]), [
    "What was found",
    "What could still reach them",
    "Why the source connector matters",
    "What to check next",
  ]);

  // Every sentence the paragraph carried is still here; labelling is not an
  // excuse to drop the parts that were hard to place.
  const all = rows.map((m) => m[2]).join(" ");
  assert.match(all, /No Channel Writer destination and no routeMessage call/);
  assert.match(all, /builds its target at run time could still be routing/);
  assert.match(all, /No route on this engine builds its target at run time/);
  assert.match(all, /a Channel Reader has no other way in/);
  assert.match(all, /1 of them has received messages/);

  // And it no longer renders through the capped note class that produced the
  // column, which is the layout half of the complaint.
  assert.doesNotMatch(html, /class="mf-section-note">No Channel Writer/,
    "the caveat must not go back to the 80ch-capped single paragraph");
});

test("caveat lines that have nothing to say are left out", async () => {
  // No Channel Readers among them and no statistics, so two of the four
  // questions do not arise and must not appear as empty labels.
  const html = await renderOverviewFiltered(
    { ...caveatTopology, nodes: [caveatTopology.nodes[1]] }, null, "noroutein");
  const labels = [...html.matchAll(/<div class="mf-note-label">([^<]*)<\/div>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ["What was found", "What could still reach them"]);
});

// The legend's CSS was deleted while its markup stayed, so every swatch was an
// empty inline span with a background and no box: zero width, invisible, and
// the entries ran together into one line with no gap. The graph looked as
// though it had never had a legend. These assert the rules exist and that the
// entries cover what the graphs actually draw.
test("the legend's swatches have a box to draw in", () => {
  const source = readFileSync(new URL("../web/plugin.js", import.meta.url), "utf8");
  const css = source.slice(source.indexOf("ensureStyles"), source.indexOf("defsInjected"));

  for (const rule of [".mf-legend{", ".mf-legend-line{", ".mf-legend-dot{"]) {
    assert.ok(css.includes(rule), `${rule} is used by the markup and must be defined, or its swatches render at zero width`);
  }
  const swatch = css.slice(css.indexOf(".mf-legend-line{"));
  assert.match(swatch, /display:inline-block/, "a swatch span has no content, so it needs a box");
  assert.match(swatch, /width:\d/, "and a width");
  assert.match(swatch, /height:\d/, "and a height");
  assert.match(css.slice(css.indexOf(".mf-legend{")), /flex-wrap:wrap/,
    "seven entries on one unwrapped line overflow the pane");
});

test("the legend names the node fills, not only the route lines", async () => {
  const html = await runTraceView(liveBillingTopology, {
    channelId: "src", channelName: "MF_Source", messageId: 4,
    ancestors: [], descendants: [], truncated: false, scanErrors: 0,
  });
  const legend = html.slice(html.indexOf('class="mf-legend"'));

  // Routes: every line style the topology graph can draw.
  assert.match(legend, /Channel Writer route/);
  assert.match(legend, /Script route \(traceable\)/);
  assert.match(legend, /writes no source map/);
  assert.match(legend, />Disabled</);

  // Channels: the two solid fills a reader sees most often had no entry at all.
  assert.match(legend, /The channel you are viewing/, "the gold node is the commonest thing on screen and was unlabelled");
  assert.match(legend, /A channel on this engine/, "so was the blue one");
  assert.match(legend, /Unknown, deleted, or not visible to you/);
  assert.match(legend, /Channel chosen at run time/);

  // The swatch colours must be the ones the graph actually draws with.
  assert.match(legend, /#d4a656/, "the gold swatch uses the selected gradient's own colour");
  assert.match(legend, /#6f8fd9/, "and the blue swatch the known gradient's");
});

// The trace chain had no click handling at all: a reader who traced a message
// and wanted the channel it landed in had to go and find it in a table. It now
// carries both actions every other channel name carries.
test("channels in a trace chain are somewhere to go", async () => {
  const html = await runTraceView(billingTopology, {
    channelId: "src", channelName: "MF_Source", messageId: 4,
    ancestors: [],
    descendants: [{ channelId: "bill", channelName: "MF_Billing", messageId: 1, status: "TRANSFORMED" }],
    truncated: false, scanErrors: 0,
  });
  const chain = html.slice(html.indexOf("mfTraceGraph"));

  assert.match(chain, /data-select-channel="bill"/, "a channel in the chain opens here");
  assert.match(chain, /data-edit="bill"/, "and opens in the editor");
  // The traced channel itself is already open, so it is not a link to itself,
  // but it still offers the editor.
  assert.match(chain, /data-edit="src"/, "including the channel being traced");

  // Same visual language as the routing map: cards, not the old circles.
  assert.match(chain, /<rect width="\d+" height="46" rx="9"/, "the chain draws cards");
  assert.doesNotMatch(chain, /url\(#mfNodeGlow\)/, "and not the glossy orbs the map moved away from");
});

test("a channel named in a trace note is a link to it", async () => {
  const html = await runTraceView(disabledOnwardTopology, {
    channelId: "src", channelName: "MF_Source", messageId: 4,
    ancestors: [],
    descendants: [{ channelId: "bill", channelName: "MF_Billing", messageId: 1, status: "TRANSFORMED" }],
    truncated: false, scanErrors: 0,
  });
  // The first .mf-section-note in the view is the static blurb under the Trace
  // button, so the one carrying the result has to be picked out by its content.
  const note = [...html.matchAll(/<div class="mf-section-note"[^>]*>([\s\S]*?)<\/div>/g)]
    .map((m) => m[1]).find((t) => t.includes("trail ends"));
  assert.ok(note, "the trace must produce a note saying why the trail ended");

  assert.match(note, /<a[^>]*data-open="bill"[^>]*>MF_Billing<\/a>/,
    "the note says the trail ends at MF_Billing, so MF_Billing is a link");
  // Once, not every time it appears: a sentence with the same channel linked
  // four times reads as a list of links rather than as a sentence.
  assert.equal((note.match(/data-open="bill"/g) || []).length, 1, "linked on first mention only");
});

// A note is escaped whole and then names inside it are replaced with links.
// The order matters: escape first, match the escaped name, so nothing in a
// channel name can reach the output unescaped however it is spelled.
test("linkifying a note cannot smuggle markup out of a channel name", async () => {
  const nasty = '<img src=x onerror="alert(1)">';
  const topo = {
    nodes: [
      { id: "src", name: "MF_Source", sourceTransport: "JavaScript Reader" },
      { id: "evil", name: nasty, sourceTransport: "Channel Reader" },
    ],
    edges: [
      { fromId: "src", fromName: "MF_Source", toId: "evil", toName: nasty, destName: "To it", via: "connector", destinationId: 1, enabled: true },
      { fromId: "evil", fromName: nasty, toId: "src", toName: "MF_Source", destName: "Back", via: "connector", destinationId: 1, enabled: false },
    ],
    externalDestinations: [], unconfiguredCount: 0,
  };
  const html = await runTraceView(topo, {
    channelId: "src", channelName: "MF_Source", messageId: 1,
    ancestors: [],
    descendants: [{ channelId: "evil", channelName: nasty, messageId: 2, status: "TRANSFORMED" }],
    truncated: false, scanErrors: 0,
  });

  assert.doesNotMatch(html, /<img/i, "a channel name must never reach the output as a tag");
  assert.doesNotMatch(html, /onerror="/i, "nor as a live attribute");
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/,
    "it is rendered as the text it is");

  // And it is still linked, escaped: the linkifier matches the escaped name, so
  // replacing it cannot reintroduce the markup escaping just removed.
  const note = [...html.matchAll(/<div class="mf-section-note"[^>]*>([\s\S]*?)<\/div>/g)]
    .map((m) => m[1]).find((t) => t.includes("trail ends"));
  assert.ok(note, "the trail-ends note must be there");
  assert.match(note, /data-open="evil"[^>]*>&lt;img src=x/, "escaped, and still a link");
});

// ── the routing graph ───────────────────────────────────────────────────────
// Everything below covers a defect that happened during the rewrite rather than
// a hypothetical one: names cut off on cards wide enough to hold them, arrivals
// landing in a different order from the one they approached in, and a canvas
// sized by formula that clipped the drawing.
async function renderChannelView(topology, channelId, searchResults = { matches: {} }) {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const source = readFileSync(new URL("../web/plugin.js", import.meta.url), "utf8")
    .replace(/^import \{ platform \} from "@oie\/web-shell";$/m, "const platform = {};");
  const file = join(mkdtempSync(join(tmpdir(), "mf-")), "plugin.mjs");
  writeFileSync(file, source);

  const registry = new Map();
  const made = [];
  const node = (key) => {
    if (key && registry.has(key)) return registry.get(key);
    const el = {
      _html: "", _attrs: {}, _handlers: {}, value: "", className: "", style: {}, hidden: false,
      setAttribute(k, v) { this._attrs[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
      appendChild() {}, addEventListener(t, fn) { (this._handlers[t] ||= []).push(fn); },
      querySelector(s) { return node(s); }, querySelectorAll() { return []; },
      get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
    };
    if (key) registry.set(key, el);
    made.push(el);
    return el;
  };
  globalThis.document = { createElement: () => node(null), head: { appendChild() {} }, body: { appendChild() {} } };

  const api = {
    get: async (path) => (path.includes("messageFlow") ? topology : searchResults),
    asList: (v, k) => {
      if (v == null) return [];
      if (k && v && typeof v === "object" && !Array.isArray(v) && v[k] !== undefined) v = v[k];
      return Array.isArray(v) ? v : [v];
    },
    statistics: { list: async () => [] },
  };
  let handler = null;
  const { register } = await import(`file://${file}`);
  register({
    api, ui: { icon: () => ({ setAttribute() {}, outerHTML: "<svg/>" }) },
    registerNavItem() {}, registerChannelAction() {}, registerView: (p, h) => { handler = h; },
  });
  await handler({ query: { channelId } });
  // With no channelId the view renders the landing page, which has no graph.
  const wrap = registry.get("#mfGraphWrap");
  return {
    graph: wrap ? wrap._html : "",
    // Set as an attribute on the wrap, not written into its markup.
    beyond: wrap ? wrap.getAttribute("data-beyond") : null,
    all: made.map((e) => e._html).filter(Boolean).join("\n"),
  };
}

// Ten channels into one, which is the shape every graph defect showed up in.
const fanInTopology = {
  nodes: [
    { id: "hub", name: "MF_Archive", sourceTransport: "JavaScript Reader" },
    ...["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"].map((n, i) => (
      { id: `s${i}`, name: `MF_${n}`, sourceTransport: "JavaScript Reader" })),
    { id: "long", name: "ORM-01 Pharmacy Orders Inbound", sourceTransport: "JavaScript Reader" },
  ],
  edges: [
    ...[0, 1, 2, 3, 4, 5].map((i) => (
      { fromId: `s${i}`, fromName: `s${i}`, toId: "hub", toName: "MF_Archive",
        destName: `D${i}`, via: "connector", destinationId: 1, enabled: true })),
    { fromId: "long", fromName: "ORM-01 Pharmacy Orders Inbound", toId: "hub", toName: "MF_Archive",
      destName: "D6", via: "connector", destinationId: 1, enabled: true },
  ],
  externalDestinations: [],
  unconfiguredCount: 0,
};

function cardsOf(svg) {
  return [...svg.matchAll(
    /data-node-id="([^"]*)"[^>]*transform="translate\((-?[\d.]+),(-?[\d.]+)\)">\s*<rect width="([\d.]+)" height="([\d.]+)"/g
  )].map((m) => ({ id: m[1], x: +m[2], y: +m[3], w: +m[4], h: +m[5] }));
}

test("a card is sized to hold its name, and every card in a graph matches", async () => {
  const { graph } = await renderChannelView(fanInTopology, "hub");
  const cards = cardsOf(graph);
  assert.ok(cards.length >= 7, `expected the fan-in to draw its channels; got ${cards.length}`);

  // Ragged widths made the columns look accidental.
  assert.equal(new Set(cards.map((c) => c.w)).size, 1, "one width for every card in a graph");

  // The defect: a name character was counted as 0.64 of a subtitle character
  // while it renders at 12.5px bold against 10.5px regular, so names were
  // ellipsized on cards with room to spare.
  const shown = [...graph.matchAll(/title="([^"]+)">([^<]+)<\/div>/g)].map((m) => [m[1], m[2]]);
  const cut = shown.filter(([full, vis]) => full !== vis);
  assert.deepEqual(cut, [], `no name may be cut off; ${JSON.stringify(cut)}`);
  assert.ok(graph.includes("ORM-01 Pharmacy Orders Inbound"), "including a long real-world name");
});

test("arrivals land in the order they approach, on a target grown to hold them", async () => {
  const { graph } = await renderChannelView(fanInTopology, "hub");
  const hub = cardsOf(graph).find((c) => c.id === "hub");

  // Every edge's start y (its source) against its end y (its port).
  const pairs = [...graph.matchAll(/class="mf-edge[^"]*"[^>]*?\sd="M([-\d.]+),([-\d.]+)[^"]*?([-\d.]+),([-\d.]+)"/g)]
    .map((m) => ({ from: +m[2], to: +m[4] }))
    .sort((a, b) => a.from - b.from);
  const ports = pairs.map((p) => p.to);
  const inversions = ports.reduce((n, _, i) =>
    n + ports.slice(i + 1).filter((p) => p < ports[i]).length, 0);
  assert.equal(inversions, 0, "an edge arriving from higher up must land higher up");

  // And the card grew so those ports are on its own edge, not beside it.
  assert.ok(hub.h > 46, `a fan-in target grows past the single-arrival height; got ${hub.h}`);
  ports.forEach((y) => assert.ok(y >= hub.y && y <= hub.y + hub.h,
    `every arrival lands on the card (${y} outside ${hub.y}..${hub.y + hub.h})`));
});

test("the canvas is sized from what was drawn, not from a formula", async () => {
  // A same-column route bows out past the first column, which no formula over
  // the cards alone can see: the old one clipped 58px off the left while
  // leaving 274px empty on the right.
  const sameColumn = {
    nodes: [
      { id: "hub", name: "MF_Archive", sourceTransport: "JavaScript Reader" },
      { id: "a", name: "MF_Top", sourceTransport: "JavaScript Reader" },
      { id: "b", name: "MF_Bottom", sourceTransport: "JavaScript Reader" },
    ],
    edges: [
      { fromId: "a", fromName: "MF_Top", toId: "hub", toName: "MF_Archive", destName: "D1", via: "connector", destinationId: 1, enabled: true },
      { fromId: "b", fromName: "MF_Bottom", toId: "hub", toName: "MF_Archive", destName: "D2", via: "connector", destinationId: 1, enabled: true },
      { fromId: "b", fromName: "MF_Bottom", toId: "a", toName: "MF_Top", destName: "D3", via: "connector", destinationId: 2, enabled: true },
    ],
    externalDestinations: [], unconfiguredCount: 0,
  };
  const { graph } = await renderChannelView(sameColumn, "hub");
  const vb = graph.match(/viewBox="(-?\d+) (-?\d+) (\d+) (\d+)"/);
  assert.ok(vb, "the graph must declare a viewBox");
  const [vx, vy, vw, vh] = vb.slice(1).map(Number);

  const cards = cardsOf(graph);
  cards.forEach((c) => {
    assert.ok(c.x >= vx && c.x + c.w <= vx + vw, `${c.id} is inside the canvas horizontally`);
    assert.ok(c.y >= vy && c.y + c.h <= vy + vh, `${c.id} is inside the canvas vertically`);
  });

  // The bow's own control point, which is the thing the formula could not see.
  const xs = [...graph.matchAll(/class="mf-edge[^"]*"[^>]*?\sd="([^"]+)"/g)]
    .flatMap((m) => [...m[1].matchAll(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g)].map((n) => +n[1]));
  assert.ok(Math.min(...xs) >= vx, `a left-bowing route must not fall outside the canvas (${Math.min(...xs)} < ${vx})`);
});

test("the graph shows direct routes and says what it is leaving out", async () => {
  // MF_Far reaches the hub only through MF_Mid, so one hop excludes it.
  const twoHop = {
    nodes: [
      { id: "hub", name: "MF_Archive", sourceTransport: "JavaScript Reader" },
      { id: "mid", name: "MF_Mid", sourceTransport: "JavaScript Reader" },
      { id: "far", name: "MF_Far", sourceTransport: "JavaScript Reader" },
    ],
    edges: [
      { fromId: "mid", fromName: "MF_Mid", toId: "hub", toName: "MF_Archive", destName: "D1", via: "connector", destinationId: 1, enabled: true },
      { fromId: "far", fromName: "MF_Far", toId: "mid", toName: "MF_Mid", destName: "D2", via: "connector", destinationId: 1, enabled: true },
    ],
    externalDestinations: [], unconfiguredCount: 0,
  };
  const { graph, all, beyond } = await renderChannelView(twoHop, "hub");
  assert.ok(graph.includes("MF_Mid"), "a direct neighbour is drawn");
  assert.doesNotMatch(graph, /MF_Far/, "a channel two hops away is not");

  // And the reader is told, rather than the radius being a hidden ceiling.
  assert.equal(beyond, "1", "the graph reports how many channels it left out");
  assert.match(all, /reach(es)? this one through another channel/, "and the control says so");
});

test("every route knows which cards it passes over, and every card can be addressed", async () => {
  // Hovering a route fades the cards it crosses; that is what makes crossing a
  // card acceptable, and why nothing routes around them.
  const { graph } = await renderChannelView(fanInTopology, "hub");
  const edges = [...graph.matchAll(/class="mf-edge[^"]*"[^>]*?data-crosses="([^"]*)"/g)];
  assert.ok(edges.length, "routes must record what they cross");

  const ids = new Set(cardsOf(graph).map((c) => c.id));
  edges.forEach((m) => m[1].split(" ").filter(Boolean).forEach((id) =>
    assert.ok(ids.has(id), `a route names card ${id}, which must exist to be faded`)));
});

// A route whose target is not a node still happened. computeFocus drops any
// edge with a null toId, which is right — leaving it in makes the BFS discover
// a node keyed "null" — but it meant a channel whose only routes were of that
// kind drew an empty box, under a message saying it had no destinations
// configured when it had two. Five of the thirty-eight channels on the engine
// this was found on were in that state.
const unresolvableTargets = {
  nodes: [{ id: "c", name: "MF_ConcatScript", sourceTransport: "JavaScript Reader" }],
  edges: [
    // A Channel Writer set to None: reports SENT, delivers nowhere.
    { fromId: "c", fromName: "MF_ConcatScript", toId: null, toName: null, toNone: true,
      destName: "Not configured", via: "connector", destinationId: 1, enabled: true },
    // A script route naming something that is not a channel on this engine.
    { fromId: "c", fromName: "MF_ConcatScript", toId: null, toName: "MF_SITE_",
      destName: "routeMessage('MF_SITE_')", via: "script", viaScript: true, traceable: true, enabled: null },
  ],
  externalDestinations: [],
  unconfiguredCount: 1,
};

test("a route with no resolvable target is still drawn", async () => {
  const { graph } = await renderChannelView(unresolvableTargets, "c");

  assert.doesNotMatch(graph, /mf-placeholder/,
    "two outbound routes is not 'no channel-to-channel routing and no external destinations'");
  assert.match(graph, />None</, "a Channel Writer with no target is a route to nowhere, which is worth drawing");
  assert.match(graph, /MF_SITE_/, "and a script route names what it asked for");
  // Anchored on <path, because class="mf-edge" is a prefix of the group's
  // class="mf-edges" and a loose match counts the wrapper as a route.
  assert.equal((graph.match(/<path class="mf-edge/g) || []).length, 2, "one line per route");

  // What the subtitle may claim is bounded by what the topology knows: a name
  // the parser matched could be a deleted channel or the literal head of a
  // target built at run time, and both arrive here identically.
  assert.match(graph, /no channel of this name on this engine/,
    "so it says the one thing true of both");
  assert.doesNotMatch(graph, /MF_SITE_[\s\S]{0,200}chosen at run time/,
    "and does not assert the target is computed, which it cannot know");

  // Nothing keyed null, which is why these were dropped in the first place.
  assert.doesNotMatch(graph, />null</, "no node labelled null");
});

test("a channel with nothing attached still draws itself", async () => {
  // There is never nothing to draw: the channel being viewed is always a node.
  // An empty box with a sentence in it was the wrong answer, and the sentence
  // was wrong besides.
  const alone = {
    nodes: [{ id: "solo", name: "MF_Alone", sourceTransport: "TCP Listener" }],
    edges: [], externalDestinations: [], unconfiguredCount: 0,
  };
  const { graph } = await renderChannelView(alone, "solo");

  assert.doesNotMatch(graph, /mf-placeholder/, "no empty box");
  assert.match(graph, /MF_Alone/, "the channel being viewed is drawn");
  assert.match(graph, /TCP Listener/, "with what it is");
  assert.equal((graph.match(/<path class="mf-edge/g) || []).length, 0, "and no routes, because it has none");
});

test("a target the script builds is named by the expression that builds it", async () => {
  // The topology reports the first string literal the parser matched, so
  // routeMessage('MF_SITE_' + site) arrives as "MF_SITE_": it reads as a
  // channel and is half of one. Source Code Search has the line as written.
  const topo = {
    nodes: [{ id: "c", name: "MF_ConcatScript", sourceTransport: "JavaScript Reader" }],
    edges: [{ fromId: "c", fromName: "MF_ConcatScript", toId: null, toName: "MF_SITE_",
      destName: "routeMessage('MF_SITE_')", via: "script", viaScript: true, traceable: true, enabled: null }],
    externalDestinations: [], unconfiguredCount: 0,
  };
  const scs = { matches: { "com.diridium.sourcecodesearch.SearchMatch": [
    { groupType: "CHANNEL", channelId: "c", channelName: "MF_ConcatScript", location: "Source Transformer",
      lineNumber: 7, lineText: "routeMessage('MF_SITE_' + site, message);" },
  ] } };

  const { graph } = await renderChannelView(topo, "c", scs);
  assert.match(graph, /&#39;MF_SITE_&#39; \+ site/, "the whole expression names the node");
  assert.match(graph, /channel name built at run time/, "and says the name is built when the message runs");

  // The half-name must not be presented as if it were the target.
  assert.doesNotMatch(graph, />MF_SITE_</, "the matched literal alone is never the label");

  // Without Source Code Search there is no expression to show, so it falls back
  // to the literal and says only what is then known about it.
  const { graph: bare } = await renderChannelView(topo, "c", { matches: {} });
  assert.match(bare, />MF_SITE_</, "the literal is all that is left");
  assert.match(bare, /no channel of this name on this engine/, "and that is all it may claim");
  assert.doesNotMatch(bare, /built at run time/, "it must not guess that the target is computed");
});

// The search asks for exactly what it accepts. Source Code Search's plain query
// is a case-insensitive contains, loose in both directions: "ROUTEMESSAGE"
// matched and so did the tail of myRouteMessageHelper(, neither of which is a
// statement that can run. Its regex mode takes a Java pattern, and \b, (?:...)
// and \s mean there what they mean here, so one pattern serves both.
test("route calls are asked for by the pattern that filters them", async () => {
  const { fetchRouteCalls, ROUTE_CALL, PATTERN } = loadSearchPipeline();

  // Sent and applied are the same pattern, so they cannot drift apart. This is
  // the whole reason for querying by pattern rather than by substring.
  assert.equal(PATTERN, ROUTE_CALL.source, "one pattern, sent and applied");
  assert.ok(ROUTE_CALL.test("routeMessage('A', m)"), "it matches a call");
  assert.ok(!ROUTE_CALL.test("myRouteMessageHelper('A')"), "not a name that merely ends in one");

  const asList = (v, k) => {
    if (v == null) return [];
    if (k && v && typeof v === "object" && !Array.isArray(v) && v[k] !== undefined) v = v[k];
    return Array.isArray(v) ? v : [v];
  };
  const seen = [];
  const idx = await fetchRouteCalls({
    asList,
    get: async (_p, params) => {
      seen.push(params);
      return { matches: { "com.diridium.sourcecodesearch.SearchMatch": [{
        groupType: "CHANNEL", channelId: "c", channelName: "C",
        location: "Source Transformer", lineNumber: 1, lineText: "routeMessage('A', msg);",
      }] } };
    },
  });

  assert.equal(seen.length, 1, "one request");
  assert.equal(seen[0].query, PATTERN);
  assert.equal(seen[0].regex, true);
  assert.equal(seen[0].caseSensitive, true, "the language is case-sensitive, so the search is");
  assert.equal(idx.byChannel.c.length, 1);

  // A search that cannot be reached is unavailable, which the UI already says
  // plainly. There is no second query: a retry here would be defending a
  // failure nobody has seen.
  const dead = await fetchRouteCalls({
    asList, get: async () => { const e = new Error("forbidden"); e.status = 403; throw e; },
  });
  assert.equal(dead.unavailable, "permission");
});

// Source Code Search matches a line at a time, so a call whose arguments run
// onto the next line arrives cut off at the break. Read alone, that line is
// indistinguishable from a computed target -- "routeMessage(" and
// "routeMessage(target," both have no literal first argument -- and it was
// reported as one, so a plain literal target sitting on the next line was
// asserted to be determined at run time. The server has no such problem: it
// parses the script whole and \s* after the paren spans the break, so it
// resolves the target and draws the edge. The two halves disagreed.
test("a call cut off by a line break is not a computed target", () => {
  const { describeCall } = loadSearchPipeline();
  const shape = (lineText) => describeCall({ lineText, channelId: "c", channelName: "C" });

  assert.equal(shape("routeMessage('MF_Billing', message);").dynamic, null, "whole call, literal target");
  assert.equal(shape("routeMessage('MF_Billing',").dynamic, null,
    "split after the first argument still reads the target");
  assert.equal(shape("routeMessage('MF_Billing',").target, "MF_Billing");

  // The cases that were being misreported.
  assert.equal(shape("routeMessage(").dynamic, "split", "an argument list still open at the line break");
  assert.equal(shape("router.routeMessage(test,").dynamic, "split");

  // And what must stay distinguishable from them.
  assert.equal(shape("router.routeMessage(target, message);").dynamic, "variable", "genuinely computed");
  assert.equal(shape("routeMessage('MF_SITE_' + site, message);").dynamic, "concatenated");

  // A nested call that closes on the line is not split.
  assert.equal(shape("routeMessage(nameFor(msg), message);").dynamic, "variable");
  // A paren inside a string must not be counted as structure.
  assert.equal(shape("routeMessage('A(B', message);").dynamic, null);
  assert.equal(shape("routeMessage('A(B', message);").target, "A(B");
});

test("a split call is not listed as a route the map cannot account for", () => {
  const unresolvableRoutes = loadFn("unresolvableRoutes", CALL_DEPS);
  const index = { byChannel: { c: [
    { channelId: "c", text: "routeMessage(", dynamic: "split" },
    { channelId: "c", text: "router.routeMessage(target, m);", dynamic: "variable" },
    { channelId: "c", text: "routeMessage('A', m);", dynamic: null },
  ] } };
  const out = unresolvableRoutes(index, "c");
  assert.deepEqual(out.map((c) => c.dynamic), ["variable"],
    "only a target the code computes is unresolvable; a cut-off one was probably resolved by the server");
});

// What the two surfaces do with a call the search could only read in part.
const splitCallTopology = {
  nodes: [
    { id: "a", name: "MF_Splitter", sourceTransport: "JavaScript Reader" },
    { id: "b", name: "MF_Billing", sourceTransport: "Channel Reader" },
  ],
  // The server parses the script whole, so it resolved the literal that sits on
  // the next line and drew this edge. The second call it could not resolve, so
  // there is no edge for it at all.
  edges: [{ fromId: "a", fromName: "MF_Splitter", toId: "b", toName: "MF_Billing",
    destName: "routeMessage('MF_Billing')", via: "script", viaScript: true, traceable: true, enabled: null }],
  externalDestinations: [], unconfiguredCount: 0,
};
const splitCallSearch = { matches: { "com.diridium.sourcecodesearch.SearchMatch": [
  { groupType: "CHANNEL", channelId: "a", channelName: "MF_Splitter", location: "Source Transformer",
    lineNumber: 12, lineText: "routeMessage(" },
  { groupType: "CHANNEL", channelId: "a", channelName: "MF_Splitter", location: "Destination 2 Script",
    lineNumber: 40, lineText: "router.routeMessage(" },
] } };

test("a call read only in part is called out, with where to go and fix it", async () => {
  const { all } = await renderChannelView(splitCallTopology, null, splitCallSearch);

  assert.match(all, /Route calls read only in part/, "the limitation is stated, not left to be inferred");
  // Both calls, including the one that produced no route at all. Excluding
  // split calls from the unresolvable list had made that one vanish entirely.
  assert.match(all, /Source Transformer[\s\S]{0,80}line 12/);
  assert.match(all, /Destination 2 Script[\s\S]{0,80}line 40/);
  assert.match(all, /routeMessage\(/, "the line as matched, so it is obvious where it stops");

  // The remedy is the channel's formatting, so it is said as one.
  assert.match(all, /on one line is all it takes/, "and what to change");
});

test("a route whose call was split is not reported as missing from the search", async () => {
  const { all } = await renderChannelView(splitCallTopology, null, splitCallSearch);

  // The search did find the call. It could not be tied to the route because the
  // split stripped the target there was nothing left to match on.
  assert.match(all, /call found, but split across lines/);
  assert.doesNotMatch(all, /not found by Source Code Search/,
    "the search found it; saying otherwise sends the reader after the wrong problem");
});

test("the graph draws what was resolved and claims nothing about the rest", async () => {
  const { graph } = await renderChannelView(splitCallTopology, "a", splitCallSearch);

  // The resolved one is an ordinary route.
  assert.match(graph, /MF_Billing/, "the route the parser resolved is drawn");
  assert.equal((graph.match(/<path class="mf-edge/g) || []).length, 1, "one route, not two");

  // The unresolved one has no target to draw to, and the graph does not invent
  // one: it is named in the section beneath, where the reason fits.
  // Specific phrases, not the word "split": the channel in this fixture is
  // called MF_Splitter, and a loose match finds its own name.
  assert.doesNotMatch(graph, /read only in part|continues on the next line|split across lines/,
    "the graph states no limitation it cannot draw");
  assert.doesNotMatch(graph, /mf-placeholder/, "and the channel itself is still there");
});

// A commented-out call is not a route. The test this replaces was
// /^(\/\/|\*)/ against the trimmed line, which catches a line starting with //
// and a * continuation, and nothing else. Everything below marked as previously
// wrong was being reported as a real route, and because the server is
// comment-aware and gives it no edge, it surfaced in the routing table as a
// route the map could not account for.
test("a call inside a comment is not a route", () => {
  const { callIsCommented } = loadSearchPipeline();

  assert.equal(callIsCommented("routeMessage('A', msg);"), false, "a plain call is a call");
  assert.equal(callIsCommented("// routeMessage('A', msg);"), true);
  assert.equal(callIsCommented("  * routeMessage('A', msg);"), true, "a block continuation line");

  // The three the old test let through.
  assert.equal(callIsCommented("/* routeMessage('A', msg); */"), true,
    "a one-line block comment starts with /, which is neither // nor *");
  assert.equal(callIsCommented("/* routeMessage('A', msg);"), true,
    "a block that opens before the call and does not close on this line");
  assert.equal(callIsCommented("var x = 1; // routeMessage('A', msg);"), true,
    "a trailing comment does not start the line");

  // And what must not be mistaken for a comment.
  assert.equal(callIsCommented("/* note */ routeMessage('A', msg);"), false,
    "a block that closed before the call leaves it live");
  assert.equal(callIsCommented("var u = 'http://x'; routeMessage('A', m);"), false,
    "// inside a string is not a comment");
  assert.equal(callIsCommented("var s = '// routeMessage(x)'; routeMessage('A', m);"), false,
    "nor is a call quoted inside one");
});

test("commented-out calls do not reach the routing index", async () => {
  const { fetchRouteCalls } = loadSearchPipeline();
  const asList = (v, k) => {
    if (v == null) return [];
    if (k && v && typeof v === "object" && !Array.isArray(v) && v[k] !== undefined) v = v[k];
    return Array.isArray(v) ? v : [v];
  };
  const line = (lineText) => ({
    groupType: "CHANNEL", channelId: "c", channelName: "C",
    location: "Source Transformer", lineNumber: 1, lineText,
  });
  const idx = await fetchRouteCalls({
    asList,
    get: async () => ({ matches: { "com.diridium.sourcecodesearch.SearchMatch": [
      line("routeMessage('Live', msg);"),
      line("/* routeMessage('Dead', msg); */"),
      line("var x = 1; // routeMessage('AlsoDead', msg);"),
    ] } }),
  });
  assert.deepEqual((idx.byChannel.c || []).map((c) => c.target), ["Live"],
    "only the call that is not commented out");
});
