// Message Flow: the web administrator half of the plugin.
//
// Discovered and served by the Web Support plugin, which scans every installed
// extension for webadmin/plugin.json. Runs inside the already authenticated
// shell and talks to /api/extensions/messageFlow through the shell's own
// platform.api, which attaches the X-Requested-With header the engine's /api
// layer requires.
//
// Two entry points, since the platform exposes no message-scoped extension
// point (see docs/design-notes.md):
//   1. registerNavItem + registerView  -- a Message Flow tab under Monitor,
//      with its own channel list and the message trace box.
//   2. registerChannelAction           -- "View in Message Flow" on a channel's
//      right-click menu, jumping to (1) with that channel selected.

import { platform } from "@oie/web-shell";

const TOPOLOGY_PATH = "/extensions/messageFlow/topology";
const NAV_PATH = "/message-flow";

// Escapes for both text and attribute context. Channel and destination names
// are interpolated into attributes throughout this file (title=, value=,
// data-select-channel=), so quotes have to be escaped too: a channel named
// x" onmouseover="... would otherwise break out of the attribute it sits in,
// and anyone able to create a channel could plant it for every admin who
// opens this tab.
const esc = (s) => String(s)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

// Connector type to icon name, using the host's own icon set so the graph
// matches the rest of the application. Anything unmapped falls back to a
// generic icon rather than throwing.
/* Still used by the routing tables. The graphs no longer draw it: a node's card
   already names its source connector directly underneath, so the glyph repeated
   the label, and on an engine whose channels are all one connector type it drew
   the same symbol on every node. */
function iconNameForTransport(t) {
  const map = {
    "Channel Reader": "transform", "Channel Writer": "transform",
    "TCP Listener": "link", "TCP Sender": "link",
    "File Reader": "folder", "File Writer": "folder",
    "Database Reader": "db", "Database Writer": "db",
    "HTTP Listener": "globe", "HTTP Sender": "globe",
    "Web Service Listener": "globe", "Web Service Sender": "globe",
    "JavaScript Reader": "code", "JavaScript Writer": "code",
    "DICOM Listener": "file", "DICOM Sender": "file",
    "SMTP Sender": "mail", "JMS Reader": "messages", "JMS Writer": "messages",
  };
  return map[t] || "link";
}

// platform.ui exposes icon(name, size), which returns an SVG element, not
// iconPath(name). The rest of this module builds HTML strings, so the element
// is serialized back out.
function inlineIcon(ui, name, size, styleValue) {
  const el = ui.icon(name, size);
  if (styleValue) el.setAttribute("style", styleValue);
  return el.outerHTML;
}

function iconForTransportCell(ui, t) {
  return inlineIcon(ui, iconNameForTransport(t), 12, "margin-right:5px;vertical-align:-2px");
}

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "message-flow-plugin-styles";
  // No theme tokens here: this runs inside the shell's page, where the
  // shell's own --bg0/--accent/etc are already on :root. Component classes
  // only.
  style.textContent = `
.mf-page{display:flex;flex-direction:column;min-height:0;height:100%}
.mf-bar{display:flex;align-items:center;gap:10px;padding:10px 18px;border-bottom:1px solid var(--line);flex-shrink:0;flex-wrap:wrap}
.mf-bar label{font-size:11px;font-weight:600;color:var(--text-faint);text-transform:uppercase;letter-spacing:.05em}
.mf-bar select{background:var(--bg2);border:1px solid var(--line-strong);color:var(--text);border-radius:6px;padding:5px 8px;font-size:13px;min-width:230px;max-width:360px}
.mf-bar-stats{margin-left:auto;font-size:12px;color:var(--text-dim);text-align:right}
.mf-pane{flex:1;min-width:0;min-height:0;overflow-y:auto;padding:16px 18px}
.mf-cards{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px}
.mf-card{flex:1 1 150px;min-width:150px;max-width:230px;text-align:left;background:var(--bg1);border:1px solid var(--line);border-radius:var(--radius);padding:10px 12px;cursor:pointer;color:inherit;font:inherit;transition:border-color .1s,background .1s}
.mf-card:hover{background:var(--bg2);border-color:var(--line-strong)}
.mf-card.active{border-color:var(--accent);background:var(--accent-glow)}
.mf-card.warn .mf-card-n{color:var(--warn)}
.mf-card-n{font-size:22px;font-weight:700;color:var(--text);line-height:1.1}
.mf-card-of{font-size:13px;font-weight:400;color:var(--text-faint)}
.mf-card-l{font-size:12px;color:var(--text);margin-top:3px}
.mf-card-note{font-size:11px;color:var(--text-faint);margin-top:3px;line-height:1.35}
/* The legend. These three rules were deleted while the markup that needs them
   stayed, so every swatch was an empty inline span with a background and no
   box: zero width, invisible, and the entries ran together into one unbroken
   line because the container lost its flex and gap. A legend nobody can read is
   worse than none, because the graph looks as though it never had one. */
.mf-legend{display:flex;flex-wrap:wrap;gap:7px 18px;margin-bottom:14px;font-size:11.5px;color:var(--text-dim)}
.mf-legend-group{display:flex;flex-wrap:wrap;align-items:center;gap:7px 14px}
.mf-legend-heading{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-faint)}
.mf-legend span.mf-legend-item{display:inline-flex;align-items:center;white-space:nowrap}
.mf-legend-line{display:inline-block;width:18px;height:2px;margin-right:6px;flex:none}
.mf-legend-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;flex:none}
/* Graph cards and edges. Dimming is by family so picking out a route kind does
   not also grey every channel, and the edit chip only appears on the card the
   pointer is over. */
.mf-node-click{cursor:pointer}
.mf-node rect{transition:stroke .12s,opacity .12s}
.mf-node-click:hover rect:first-of-type{stroke:var(--accent)}
.mf-node-edit{opacity:0;cursor:pointer;transition:opacity .12s}
.mf-node:hover .mf-node-edit{opacity:1}
.mf-node-edit:hover rect{stroke:var(--accent)}
.mf-node-edit:hover text{fill:var(--accent)}
.mf-edge{transition:opacity .12s,stroke-width .12s;cursor:help}
/* Context: a route between two of the focused channel's neighbours, which is
   not what the reader opened this graph to see. Hover still restores it. */
.mf-edge-context{opacity:.26;stroke-width:1.3}
.mf-edge-context:hover,.mf-edge-context.mf-on{opacity:1}
/* One route picked out, and the cards it passes over faded so it can be read
   across them. */
.mf-edge.mf-solo{opacity:1;stroke-width:3.2}
.mf-node.mf-behind{opacity:.16;transition:opacity .12s}
.mf-off{opacity:.09}
.mf-edge.mf-on{stroke-width:3;opacity:1}
.mf-tip{position:fixed;z-index:40;display:none;pointer-events:none;background:#0b1016;border:1px solid var(--line-strong);border-radius:7px;padding:6px 9px;font-size:11.5px;color:var(--text);box-shadow:0 6px 20px rgba(0,0,0,.5);max-width:340px}
.mf-tip b{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-faint);font-weight:700;margin-bottom:2px}
.mf-legend-item{padding:2px 6px;border-radius:6px;border:1px solid transparent;cursor:default;transition:background .12s,border-color .12s,opacity .12s}
.mf-legend-item.mf-on{border-color:var(--line-strong);background:var(--bg2);color:var(--text)}
.mf-hops{font-size:11.5px;color:var(--text-faint);margin:6px 2px 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mf-hops-btn{background:var(--bg2);border:1px solid var(--line-strong);color:var(--text-dim);border-radius:6px;padding:2px 9px;font-size:11.5px;cursor:pointer;font-family:inherit}
.mf-hops-btn:hover{border-color:var(--accent);color:var(--accent)}
.mf-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text-dim);margin-bottom:8px;cursor:pointer}
.mf-check input{cursor:pointer}
.mf-link{color:var(--accent);text-decoration:none}
.mf-help{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;margin-left:5px;border-radius:50%;border:1px solid var(--accent);color:var(--accent);font-size:10px;font-weight:700;text-decoration:none;vertical-align:1px}
.mf-help:hover{background:var(--accent);color:var(--accent-ink)}
.mf-edit{color:var(--text-faint);text-decoration:none;font-size:11px;margin-left:8px;border:1px solid var(--line-strong);border-radius:4px;padding:1px 5px}
.mf-edit:hover{color:var(--text);border-color:var(--text-faint)}
.mf-link:hover{text-decoration:underline}
.mf-notice-warn{border-color:var(--warn);background:rgba(200,150,40,.08)}
.mf-notice-warn svg{color:var(--warn)}
.mf-call{font-family:var(--font-mono,monospace);font-size:11.5px;color:var(--text-dim);white-space:pre-wrap;overflow-wrap:anywhere;display:inline-block;max-width:46ch}
.mf-dyn{color:var(--violet)}
.mf-notice{display:flex;gap:10px;align-items:flex-start;background:var(--bg2);border:1px solid var(--line-strong);border-radius:var(--radius);padding:11px 13px;margin-bottom:16px;font-size:12.5px;color:var(--text-dim);max-width:90ch}
.mf-notice svg{flex-shrink:0;margin-top:1px;color:var(--text-faint)}
.mf-notice a{color:var(--accent)}
.mf-lead{font-size:13px;color:var(--text-dim);margin-bottom:16px;max-width:70ch}
.mf-channel-title{font-size:15px;font-weight:700;color:var(--text);margin-bottom:10px}
.mf-section-note{font-size:11.5px;color:var(--text-dim);margin-bottom:7px;max-width:80ch}
/* Labelled explanation lines. A grid so the labels share one column and the
   prose starts at the same place on every row; full width on purpose, because
   the 80ch cap above a full-width table is what made this read as a column. */
.mf-note-rows{display:grid;grid-template-columns:max-content 1fr;gap:5px 14px;font-size:11.5px;color:var(--text-dim);margin-bottom:11px;align-items:baseline}
.mf-note-label{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-faint);white-space:nowrap}
@media (max-width:760px){.mf-note-rows{grid-template-columns:1fr;gap:1px 0}.mf-note-label{margin-top:7px}}
.mf-placeholder{margin:auto;color:var(--text-faint);text-align:center;padding:40px;font-size:13.5px}
.mf-graph{border:1px solid var(--line);border-radius:var(--radius);background:var(--bg1);overflow:auto;margin-bottom:14px;min-height:200px}
table.mf-table{width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:22px}
/* The pane is the scroll container, so a sticky header sticks to it. The
   rule is drawn with an inset shadow rather than a border, because a
   border on a sticky cell is painted out from under it while scrolling. */
table.mf-table th{position:sticky;top:0;z-index:2;background:var(--bg0);box-shadow:inset 0 -1px 0 var(--line-strong);text-align:left;padding:7px 10px;color:var(--text-faint);font-size:10.5px;text-transform:uppercase;letter-spacing:.04em}
table.mf-table td{padding:6px 10px;border-bottom:1px solid var(--line)}
.mf-section-title{font-weight:700;font-size:13px;margin-bottom:7px;color:var(--text)}
.mf-trace-box{border:1px solid var(--line);border-radius:var(--radius);background:var(--bg1);padding:12px 14px;margin-bottom:18px}
.mf-trace-inputs{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px}
.mf-trace-inputs label{font-size:11.5px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em;margin-right:4px}
.mf-trace-channel{font-weight:600;color:var(--text)}
.mf-trace-inputs input{background:var(--bg2);border:1px solid var(--line-strong);color:var(--text);border-radius:6px;padding:5px 8px;font-size:12.5px}
.mf-trace-inputs input[type=number]{width:100px}
.mf-trace-btn{background:var(--accent);color:var(--accent-ink);border:1px solid var(--accent-press);border-radius:6px;padding:5px 12px;font-size:12.5px;font-weight:600;cursor:pointer}
.mf-trace-btn:hover{background:var(--accent-press)}
`;
  document.head.appendChild(style);
}

let defsInjected = false;
/* SVG gradient, filter and marker ids are scoped to the document, not to each
   <svg>, so one hidden definition block serves every graph on the page. This is
   why the topology graph and the trace chain can share a single set of ids
   instead of each carrying its own copy under a different prefix. */
function ensureDefs() {
  if (defsInjected) return;
  defsInjected = true;
  const holder = document.createElement("div");
  holder.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  holder.setAttribute("aria-hidden", "true");
  /* One arrowhead per route kind, and nothing else. The gradients, the node
     glow and the line glow went out with the glossy circles they belonged to;
     the single violet arrow went with them, because an arrowhead now takes the
     colour of the route it ends. */
  holder.innerHTML = `<svg width="0" height="0"><defs>
    ${["Writer:var(--violet)", "Traced:var(--blue)", "Untraced:var(--warn)", "Disabled:var(--text-faint)"].map((pair) => {
      const [name, color] = pair.split(/:(.*)/);
      return `<marker id="mfArrow${name}" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M1,2 L9,5 L1,8 Z" fill="${color}"/></marker>`;
    }).join("")}
  </defs></svg>`;
  document.body.appendChild(holder);
}

/* BFS outward from the selected channel in both directions, to `hops` levels.
   One hop by default, which is the question the view is actually asked: what
   routes into this channel and what does it route to. Going further pulled in
   channels that only reach the focus through an intermediary, and an edge that
   spans two ranks has to be threaded around whatever sits between them, which
   is where the long swooping curves came from. They were not a rendering fault
   and no amount of curve work removes them; not drawing two-rank spans does.
   The reader can still follow the chain, by opening the next channel. */
function computeFocus(selectedId, edges, hops) {
  const maxHops = hops == null ? 1 : hops;
  const downstreamAdj = {}, upstreamAdj = {};
  // A script route whose target name resolves to no known channel has a null
  // toId. Left in, it becomes an object key, so the BFS discovers a node called
  // "null" and the graph draws a floating circle labelled null with no edge
  // attached. Such routes are real and worth knowing about, but they belong in
  // the routing table, which names the target the script actually asked for;
  // they cannot be placed in the graph because there is nothing to place.
  edges = edges.filter((e) => e.fromId && e.toId);
  edges.forEach((e) => {
    (downstreamAdj[e.fromId] ??= []).push(e.toId);
    (upstreamAdj[e.toId] ??= []).push(e.fromId);
  });
  function bfsLevels(adj, sign) {
    const levelOf = {};
    const queue = [selectedId];
    const seen = new Set([selectedId]);
    while (queue.length) {
      const cur = queue.shift();
      const curLevel = levelOf[cur] || 0;
      if (Math.abs(curLevel) >= maxHops) continue;
      (adj[cur] || []).forEach((next) => {
        if (!seen.has(next)) {
          seen.add(next);
          levelOf[next] = curLevel + sign;
          queue.push(next);
        }
      });
    }
    return levelOf;
  }
  const downLevels = bfsLevels(downstreamAdj, 1);
  const upLevels = bfsLevels(upstreamAdj, -1);
  const levelOf = { [selectedId]: 0, ...downLevels, ...upLevels };
  const nodeIds = new Set(Object.keys(levelOf));
  const relevantEdges = edges.filter((e) => nodeIds.has(e.fromId) && nodeIds.has(e.toId));
  // Whether widening would actually show anything, so the control can say so.
  // Only the nodes sitting at the current outer edge of the walk can lead
  // anywhere new, and only by continuing in the direction that got them here:
  // an upstream node's own downstream siblings (or a downstream node's own
  // other parents) never lead back to the selected channel, so they must not
  // be counted just because they touch a node already in view.
  const beyond = new Set();
  Object.entries(levelOf).forEach(([id, lvl]) => {
    if (lvl === maxHops) (downstreamAdj[id] || []).forEach((next) => { if (!nodeIds.has(next)) beyond.add(next); });
    if (lvl === -maxHops) (upstreamAdj[id] || []).forEach((next) => { if (!nodeIds.has(next)) beyond.add(next); });
  });
  return { levelOf, nodeIds, relevantEdges, beyond: beyond.size };
}

/** Clamps a measured pixel width into what a card is allowed to be. */
function estimateLabelWidth(px) {
  return Math.round(Math.min(272, Math.max(130, px)));
}

/* Renders the focused upstream/downstream chain SVG for `selectedId` into
   `wrap` (an already-mounted element). onSelectChannel(id) fires when the
   user clicks another known channel node in the graph -- callers decide
   what that means (switch the nav tab's selection, or just re-focus locally
   within a channel-editor tab). Shared between the nav-tab view and the
   channel-editor tab so there is exactly one copy of this logic. */
function renderFocusSvgInto(wrap, ui, mfData, selectedId, onSelectChannel, graphHops, codeIndex) {
  if (!wrap || !mfData) return;
  ensureDefs();
  const idToName = {}, nodesById = {};
  mfData.nodes.forEach((n) => { idToName[n.id] = n.name; nodesById[n.id] = n; });
  mfData.edges.forEach((e) => {
    if (e.toId && !idToName[e.toId]) idToName[e.toId] = e.toName || (e.toRestricted ? "a channel you cannot see" : "(unknown channel)");
  });
  const restrictedIds = new Set(mfData.edges.filter((e) => e.toRestricted && e.toId).map((e) => e.toId));

  const { levelOf, nodeIds, relevantEdges, beyond } = computeFocus(selectedId, mfData.edges, graphHops);

  const extNodesById = {};
  const extEdges = [];
  nodeIds.forEach((id) => {
    (mfData.externalDestinations || []).filter((d) => d.channelId === id).forEach((d, i) => {
      const extId = `ext::${id}::${i}`;
      // A Channel Writer with a ${...} target routes inside the engine to a
      // channel chosen at runtime. It has no node because it cannot be
      // resolved, but drawing it beside the HTTP senders and file writers said
      // the data leaves the engine, which is the opposite of true.
      extNodesById[extId] = {
        label: d.destName, transportName: d.transportName, enabled: d.enabled,
        ownerId: id, unresolved: !!d.dynamicRouting,
      };
      extEdges.push({ fromId: id, toId: extId, enabled: d.enabled, destName: d.destName, unresolved: !!d.dynamicRouting });
    });
  });
  /* Routes whose target is not a node. computeFocus drops any edge with a null
     toId, because leaving it in makes the BFS discover a node keyed "null" and
     draw a floating circle labelled null. That is the right thing to drop and
     the wrong thing to forget: a channel whose only routes are of this kind
     showed an empty diagram, under a message claiming it had no destinations
     configured, when it had two. Both are real and both are drawable once they
     are given a target to be drawn to.

     Two kinds. A Channel Writer set to None has no target at all and reports
     SENT while delivering nowhere. A script route that names a channel the
     engine does not have is asking for something built at run time, which is
     why "MF_SITE_" is a prefix rather than a channel. */
  nodeIds.forEach((id) => {
    mfData.edges.filter((e) => e.fromId === id && !e.toId).forEach((e, i) => {
      const pid = `unres::${id}::${i}`;
      /* A target the script builds is named by the expression that builds it.
         The topology reports the first string literal the parser matched, so a
         call like routeMessage('MF_SITE_' + site) comes back as "MF_SITE_",
         which reads as a channel and is half of one. Source Code Search has the
         line as written, so where it is available the whole argument is shown
         instead; where it is not, the literal is shown as the fragment it is.

         Without the expression the subtitle is bounded by what the topology
         knows: a name that resolves to nothing could be a deleted channel or a
         computed one, and both arrive here identically. */
      const call = callFor(codeIndex, e);
      const expr = call && call.dynamic && call.dynamic !== "split" ? targetExpression(call.text) : null;
      extNodesById[pid] = {
        label: e.toNone ? "None" : (expr || e.toName || "target not resolved"),
        subtitle: e.toNone
          ? "a Channel Writer with no target set"
          : expr
            ? "channel name built at run time"
            : (e.toName ? "no channel of this name on this engine" : "target built at run time"),
        kind: e.toNone ? "ext" : (expr ? "runtime" : "unknown"),
        enabled: e.enabled,
        ownerId: id,
        unresolved: !e.toNone,
      };
      extEdges.push({
        fromId: id, toId: pid, enabled: e.enabled, destName: e.destName, unresolved: !e.toNone,
        // The line says what the node it lands on says. Left to the default it
        // called this "Channel chosen at run time", which is the one thing the
        // topology cannot tell us about a name it could not resolve.
        label: e.toNone ? "Channel Writer with no target set"
          : expr ? "Channel chosen at run time"
          : "Target is not a channel on this engine",
        detail: e.toNone
          ? `${idToName[id] || ""} → ${e.destName}: a Channel Writer set to None reports SENT and delivers nowhere`
          : expr
            ? `${idToName[id] || ""} routes to ${expr}, built when the message runs, so the map cannot say which channel it reaches`
            : `${idToName[id] || ""} → ${e.destName}: no channel named ${e.toName} on this engine`,
      });
    });
  });

  const allNodeIds = new Set([...nodeIds, ...Object.keys(extNodesById)]);

  /* No early return for a channel with nothing attached to it. The channel
     being viewed is always a node, so there is always something to draw, and a
     card saying "this channel, and nothing routes to or from it" is a better
     answer than an empty box with a sentence in it -- particularly since the
     sentence used to be wrong, claiming no destinations were configured for
     channels that had two the graph could not resolve a target for. */

  const combinedLevelOf = { ...levelOf };
  Object.entries(extNodesById).forEach(([extId, n]) => { combinedLevelOf[extId] = (levelOf[n.ownerId] || 0) + 1; });

  /* Cards, not circles. A circle needs its label parked underneath it, and at
     any realistic node spacing those labels collided with each other and with
     the edges crossing them. Putting the name inside the node makes the node
     the size of its own label, so nothing overlaps by construction. */
  const CARD_H = 46;        // a card with a single arrival and a one-line name
  const PORT_PITCH = 16;    // gap between arrivals; must clear the arrowhead and read as separate
  const PORT_PAD = 13;      // inset from a card's top and bottom
  const CARD_H_MAX = 210;   // past this a hub compresses instead of becoming a ribbon
  const LINE_H = 15;        // a wrapped second line of the name

  /* A name is not truncated to make the card a convenient size; the card is
     sized to hold the name. Past the width cap it wraps to a second line and the
     card grows to fit, because a graph of channels whose names are cut off in
     the middle cannot be read, and channel names on a real engine are long
     ("ADT-01 Epic Inbound"). Only past two lines does it finally ellipsize. */
  /* Width is measured in pixels at the size each line is actually drawn, not in
     characters. Counting a name character as 0.64 of a subtitle character
     underestimated it by about half, because the name is 12.5px bold and the
     subtitle 10.5px regular, so names were being ellipsized on cards that were
     wide enough to hold them. */
  const NAME_CH = 7.3, SUB_CH = 5.95, CARD_PAD = 58;   // 14 left inset + 44 reserved for the edit chip
  const nameOf = (id) => String(extNodesById[id] ? extNodesById[id].label : (idToName[id] || id));
  const labelWidths = {}, nameLines = {};
  allNodeIds.forEach((id) => {
    const isExt = !!extNodesById[id];
    const subtitle = String((isExt ? extNodesById[id].transportName : (nodesById[id]?.sourceTransport || "unknown/deleted channel")) || "");
    const statusText = isExt && extNodesById[id].enabled === false ? "Disabled" : "";
    labelWidths[id] = estimateLabelWidth(Math.max(
      nameOf(id).length * NAME_CH, subtitle.length * SUB_CH, statusText.length * SUB_CH) + CARD_PAD);
  });

  /* One width for every card in a graph. Sized individually the columns looked
     ragged and accidental, and a column of mixed widths is harder to scan than a
     slightly wider uniform one. */
  const maxLabelWidth = Math.max(130, ...Object.values(labelWidths));
  allNodeIds.forEach((id) => {
    labelWidths[id] = maxLabelWidth;
    nameLines[id] = nameOf(id).length * NAME_CH > maxLabelWidth - CARD_PAD ? 2 : 1;
  });

  /* A card grows so that every arrival lands on its own edge rather than in the
     space beside it. Ten routes into one channel span 132px at this pitch while
     a card is 46px tall, so without this the top and bottom arrows attach to
     nothing. Capped, because a hub with forty inbound routes would otherwise be
     a ribbon; past the cap the arrivals compress instead. */
  const inboundCount = {};
  relevantEdges.forEach((e) => { if (e.toId !== e.fromId) inboundCount[e.toId] = (inboundCount[e.toId] || 0) + 1; });
  const cardH = {};
  allNodeIds.forEach((id) => {
    const base = CARD_H + (nameLines[id] - 1) * LINE_H;
    const n = inboundCount[id] || 0;
    cardH[id] = n > 1 ? Math.min(CARD_H_MAX, Math.max(base, (n - 1) * PORT_PITCH + PORT_PAD * 2)) : base;
  });

  /* Layout. dagre was used here for a while and has been taken out again: its
     value was rank assignment and edge routing, and neither is left. Nothing
     routes around cards any more, and with the graph capped at one hop every
     node is at -1, 0 or +1, so there are no layers to assign. A vendored 50KB
     dependency earning nothing is worse than the twenty lines below.

     What remains is BFS levels, ordered within a column by the barycentre
     heuristic, packed by each card's own height. That is the crossing-reduction
     half of a layered layout and does not claim to be more. */
  const pos = {};
  let width, height;
  {
    const byLevel = {};
    allNodeIds.forEach((id) => { (byLevel[combinedLevelOf[id]] ??= []).push(id); });
    const levels = Object.keys(byLevel).map(Number).sort((a, b) => a - b);

    /* Order each column by the average position of the things it connects to, a
       few passes alternating direction. Without it a column is in whatever order
       the nodes were discovered, so a channel can sit at the top of its column
       while everything routing to it sits at the bottom. */
    const neighbours = {};
    [...relevantEdges, ...extEdges].forEach((e) => {
      if (!allNodeIds.has(e.fromId) || !allNodeIds.has(e.toId)) return;
      (neighbours[e.fromId] ??= []).push(e.toId);
      (neighbours[e.toId] ??= []).push(e.fromId);
    });
    const rowOf = {};
    const reindex = () => levels.forEach((l) => byLevel[l].forEach((id, i) => { rowOf[id] = i; }));
    reindex();
    for (let pass = 0; pass < 4; pass++) {
      (pass % 2 ? [...levels].reverse() : levels).forEach((l) => {
        byLevel[l] = byLevel[l]
          .map((id) => {
            const ns = (neighbours[id] || []).map((n) => rowOf[n]).filter((v) => v !== undefined);
            return { id, bary: ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : rowOf[id] };
          })
          .sort((a, b) => a.bary - b.bary || String(a.id).localeCompare(String(b.id)))
          .map((o) => o.id);
        reindex();
      });
    }

    const colGap = Math.max(280, maxLabelWidth + 130);
    const GAP_Y = 30;
    const colHeights = levels.map((l) =>
      byLevel[l].reduce((h, id) => h + cardH[id], 0) + GAP_Y * (byLevel[l].length - 1));
    height = Math.max(220, Math.max(...colHeights) + 56);
    width = Math.max(560, levels.length * colGap + maxLabelWidth + 60);
    levels.forEach((lvl, colIdx) => {
      const colX = 40 + maxLabelWidth / 2 + colIdx * colGap;
      let y = (height - colHeights[colIdx]) / 2;
      byLevel[lvl].forEach((id) => {
        pos[id] = { x: colX, y: y + cardH[id] / 2 };
        y += cardH[id] + GAP_Y;
      });
    });
  }
  /* What the drawing actually occupies. The canvas used to be sized from the
     column count and the widest label, which is a guess: it left 274px empty on
     the right and still clipped 58px off the left, because a same-column edge
     bows out past the first column and a self-loop reaches past the right of its
     card. Both are outside every card's box, so no formula over the cards alone
     can see them. Anything that draws outside a card reports its extent here. */
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (x, y) => {
    if (x < bounds.minX) bounds.minX = x;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (y > bounds.maxY) bounds.maxY = y;
  };

  const rectOf = (id) => {
    const p = pos[id], w = labelWidths[id], h = cardH[id];
    return { x: p.x - w / 2, y: p.y - h / 2, w, h, cx: p.x, cy: p.y };
  };

  const ARROW_GAP = 9;
  const FORWARD_MIN = 70;   // less horizontal travel than this is not a forward edge

  const armFor = (x1, y1, x2, y2) => {
    const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
    return Math.max(34, Math.min(dx * 0.62, dx * 0.45 + dy * 0.18));
  };
  /* Horizontal tangents at both ends: every route leaves its source going right
     and arrives at its target going right, so the arrowheads all point the same
     way instead of radiating from a point like spokes. The control arm grows a
     little with the vertical drop, so a short hop that has to fall a long way
     eases into it rather than diving; bounded by the horizontal run, because an
     arm longer than the gap loops back on itself. */
  const curve = (x1, y1, x2, y2) => {
    const c = armFor(x1, y1, x2, y2);
    return `M${x1.toFixed(1)},${y1.toFixed(1)} C${(x1 + c).toFixed(1)},${y1.toFixed(1)} ${(x2 - c).toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
  };

  /* Two channels the same distance from the focus share a column, and one can
     still route to the other. Sending that edge out of the source's right face
     towards a target at the same x puts the second control point left of the
     first, so the path lunges right and doubles back through its own column.
     These bow out to the left instead and arrive at the target's left face like
     every other route, which keeps one arrival convention for the whole graph. */
  const backCurve = (a, b, y2) => {
    /* Bow depth was proportional to the vertical distance with nothing bounding
       it, so two channels at opposite ends of a tall column produced a 244px
       arc swinging clear of the drawing. Capped: past a point a deeper bow adds
       width without making the route any easier to follow. */
    const k = Math.min(92, 40 + Math.abs(b.cy - a.cy) * 0.12);
    grow(a.x - k, Math.min(a.cy, y2));
    return `M${a.x.toFixed(1)},${a.cy.toFixed(1)} C${(a.x - k).toFixed(1)},${a.cy.toFixed(1)} ${(b.x - k).toFixed(1)},${y2.toFixed(1)} ${(b.x - ARROW_GAP).toFixed(1)},${y2.toFixed(1)}`;
  };
  // A channel that routes to itself has no second node to draw a curve to.
  const selfLoop = (r) => (grow(r.x + r.w + 26, r.y - 34), "") + `M${(r.x + r.w * 0.62).toFixed(1)},${r.y.toFixed(1)} C${(r.x + r.w * 0.66).toFixed(1)},${(r.y - 34).toFixed(1)} ${(r.x + r.w + 26).toFixed(1)},${(r.y - 20).toFixed(1)} ${(r.x + r.w + 7).toFixed(1)},${(r.y + r.h / 2).toFixed(1)}`;

  /* Which cards a curve passes over. Nothing is routed around any more: an edge
     takes the direct line and may cross a card, because hovering the edge greys
     whatever it crosses, which answers the question routing was there to answer.
     Routing around obstacles is what produced the detours, and the detours were
     the swooping. Sampled rather than solved: a cubic against a rounded
     rectangle has no answer worth the code. */
  const cardsUnder = (x1, y1, x2, y2, skip) => {
    const c = armFor(x1, y1, x2, y2);
    const hit = new Set();
    const boxes = [...allNodeIds].filter((id) => !skip.has(id) && pos[id]).map((id) => [id, rectOf(id)]);
    for (let i = 1; i < 28; i++) {
      const t = i / 28, u = 1 - t;
      const x = u * u * u * x1 + 3 * u * u * t * (x1 + c) + 3 * u * t * t * (x2 - c) + t * t * t * x2;
      const y = u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2;
      for (const [id, r] of boxes) {
        if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) hit.add(id);
      }
    }
    return [...hit];
  };

  /* Where each edge meets its target, ordered by the height it actually arrives
     from, so routes land in the order they approach and do not cross each other
     on the way in. */
  const approachFrom = (e) => rectOf(e.fromId).cy;
  const arrivalY = new Map();
  const byTarget = {};
  relevantEdges.forEach((e) => {
    if (!pos[e.fromId] || !pos[e.toId] || e.fromId === e.toId) return;
    (byTarget[e.toId] ??= []).push(e);
  });
  Object.entries(byTarget).forEach(([toId, list]) => {
    list.sort((x, y) => approachFrom(x) - approachFrom(y));
    const r = rectOf(toId);
    const pitch = list.length > 1 ? Math.min(PORT_PITCH, (r.h - PORT_PAD * 2) / (list.length - 1)) : 0;
    const span = (list.length - 1) * pitch;
    list.forEach((e, i) => arrivalY.set(e, r.cy - span / 2 + i * pitch));
  });

  const crossed = new Map();
  const edgeLines = relevantEdges.map((e) => {
    if (!pos[e.fromId] || !pos[e.toId]) return "";
    // A route that writes no source map is the most operationally important
    // thing this graph can say, so it is said on the line itself rather than
    // only in the tables: a message taking this hop cannot be traced past it.
    const untraceable = e.viaScript && e.traceable === false;
    const kind = untraceable ? "untraced"
      : e.viaScript ? "traced"
      : (e.enabled === false ? "disabled" : "writer");
    const st = EDGE_KIND[kind];
    const a = rectOf(e.fromId);
    const d = e.fromId === e.toId
      ? selfLoop(a)
      : (() => {
          const b = rectOf(e.toId);
          const y2 = arrivalY.get(e) ?? b.cy;
          /* One curve, straight from the source's right face to its arrival
             port. No obstacle avoidance: an edge may pass over a card, and
             hovering it fades whatever it crosses so the line can still be
             read. Routing around cards is what produced the swooping, and the
             swooping cost more than the crossings it prevented. */
          if ((b.x - (a.x + a.w)) < FORWARD_MIN) return backCurve(a, b, y2);
          crossed.set(e, cardsUnder(a.x + a.w, a.cy, b.x - ARROW_GAP, y2, new Set([e.fromId, e.toId])));
          return curve(a.x + a.w, a.cy, b.x - ARROW_GAP, y2);
        })();
    const note = untraceable ? " — message tracing stops here"
      : e.viaScript ? " — may be conditional"
      : (e.enabled === false ? " — nothing is dispatched" : "");
    /* This is a focus graph: it exists to show what routes into and out of one
       channel. An edge between two of its neighbours is context and was being
       drawn at the same weight as the subject, which is most of what made a
       modest graph look like spaghetti. Context is dimmed rather than dropped,
       because it is still true and the hover pairing can bring any of it back. */
    const onFocus = !selectedId || e.fromId === selectedId || e.toId === selectedId;
    return `<path class="mf-edge${onFocus ? "" : " mf-edge-context"}" data-family="route" data-kind="${kind}" data-label="${esc(st.label)}"
      data-crosses="${esc((crossed.get(e) || []).join(" "))}"
      data-detail="${esc((idToName[e.fromId] || "") + " → " + (idToName[e.toId] || e.destName) + " via " + e.destName + note)}"
      d="${d}" fill="none" stroke="${st.stroke}" stroke-width="1.8" stroke-linecap="round" ${st.dash} marker-end="url(#${st.marker})"/>`;
  }).join("");

  const extEdgeLines = extEdges.map((e) => {
    if (!pos[e.fromId] || !pos[e.toId]) return "";
    const a = rectOf(e.fromId), b = rectOf(e.toId);
    const kind = e.unresolved ? "runtime" : "ext";
    const color = e.enabled === false ? "var(--text-faint)" : (e.unresolved ? "var(--violet)" : "#5a8fa8");
    const detail = e.unresolved
      ? `${idToName[e.fromId] || ""} → ${e.destName} (routes to a channel chosen at run time)`
      : `${idToName[e.fromId] || ""} → ${e.destName} (a destination, not a channel route)`;
    return `<path class="mf-edge" data-family="route" data-kind="${kind}"
      data-label="${esc(e.label || (e.unresolved ? "Channel chosen at run time" : "Other destination (not a channel route)"))}"
      data-detail="${esc(e.detail || detail)}" d="${curve(a.x + a.w, a.cy, b.x - ARROW_GAP, b.cy)}" fill="none"
      stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="1,3.5"
      opacity="${e.enabled === false ? 0.45 : 0.8}"/>`;
  }).join("");

  /* A card: the name and connector live inside it, the colour moves to a stripe
     down the left edge, and an edit chip appears on hover. Both actions a reader
     wants from a channel name are on the node itself now, where before the graph
     could only select and the tables could only do both. */
  const cardEl = ({ r, nodeId, name, subtitle, status, kind, stripe, border, fill, textColor, selected, selectId, editId, title, lines }) => {
    const inner = Math.max(40, r.w - (editId ? 44 : 20));
    const textH = 22 + (lines || 1) * 0 + ((lines || 1) - 1) * 15;
    return `<g class="mf-node${selectId ? " mf-node-click" : ""}" data-node-id="${esc(nodeId || "")}" data-family="node" data-kind="${kind}"
      data-label="${esc(NODE_KIND_LABEL[kind] || "")}" data-detail="${esc(title || name)}"
      ${selectId ? `data-select-channel="${esc(selectId)}"` : ""} transform="translate(${r.x.toFixed(1)},${r.y.toFixed(1)})">
      <rect width="${r.w}" height="${r.h}" rx="9" fill="${fill}" stroke="${border}" stroke-width="1.2" ${kind === "unknown" || kind === "ext" || kind === "runtime" ? 'stroke-dasharray="4,3"' : ""}/>
      <rect width="4" height="${r.h}" rx="2" fill="${stripe}"/>
      <foreignObject x="14" y="${(r.h / 2 - 17 - textH / 2 + 11).toFixed(1)}" width="${inner}" height="${36 + ((lines || 1) - 1) * 15}" style="pointer-events:none">
        <div xmlns="http://www.w3.org/1999/xhtml" style="font-family:var(--font-ui,inherit);line-height:1.25">
          <div style="font-size:12.5px;font-weight:${selected ? 700 : 600};color:${textColor};display:-webkit-box;-webkit-line-clamp:${lines || 1};-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:break-word;word-break:normal" title="${esc(name)}">${esc(name)}</div>
          <div style="font-size:10.5px;color:var(--text-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(subtitle || "")}</div>
          ${status ? `<div style="font-size:10px;color:var(--warn);font-weight:600">${esc(status)}</div>` : ""}
        </div>
      </foreignObject>
      ${editId ? `<g class="mf-node-edit" data-edit="${esc(editId)}" transform="translate(${(r.w - 36).toFixed(1)},7)">
        <rect width="29" height="15" rx="4" fill="#0f151d" stroke="var(--line-strong)" stroke-width="1"/>
        <text x="14.5" y="11" text-anchor="middle" font-size="9.5" fill="var(--text-dim)" font-family="var(--font-ui,inherit)">edit</text>
      </g>` : ""}
    </g>`;
  };

  const nodeEls = [...nodeIds].map((id) => {
    const node = nodesById[id];
    const known = !!node;
    const isSelected = id === selectedId;
    const restricted = !known && restrictedIds.has(id);
    const kind = isSelected ? "selected" : known ? "known" : "unknown";
    return cardEl({
      r: rectOf(id),
      nodeId: id,
      name: idToName[id] || id,
      subtitle: known ? node.sourceTransport : (restricted ? "you do not have access" : "unknown/deleted channel"),
      kind,
      stripe: isSelected ? "#d4a656" : known ? "#6f8fd9" : "var(--text-faint)",
      border: isSelected ? "#e8c874" : known ? "#2e3b4d" : "var(--text-faint)",
      fill: isSelected ? "#1a2230" : known ? "#161d28" : "var(--bg3)",
      textColor: isSelected ? "#f0dca8" : known ? "#cfe0f8" : "var(--text-faint)",
      selected: isSelected,
      selectId: known && !isSelected ? id : null,
      editId: known ? id : null,
      lines: nameLines[id],
    });
  }).join("");

  const extNodeEls = Object.entries(extNodesById).map(([id, n]) => {
    const muted = n.enabled === false;
    return cardEl({
      r: rectOf(id),
      nodeId: id,
      name: n.label,
      subtitle: n.subtitle || (n.unresolved ? "channel chosen at run time" : n.transportName),
      status: muted ? "Disabled" : "",
      kind: n.kind || (n.unresolved ? "runtime" : "ext"),
      stripe: n.kind === "unknown" ? "var(--text-faint)" : muted ? "var(--text-faint)" : (n.unresolved ? "var(--violet)" : "#5a8fa8"),
      border: n.kind === "unknown" ? "var(--text-faint)" : muted ? "var(--text-faint)" : (n.unresolved ? "var(--violet)" : "#5a8fa8"),
      fill: n.kind === "unknown" ? "var(--bg3)" : (n.unresolved ? "#2a2438" : "#233240"),
      textColor: n.kind === "unknown" ? "var(--text-faint)" : muted ? "var(--text-faint)" : (n.unresolved ? "#c9b6f5" : "#a8d4e8"),
      /* Only offered when it goes somewhere else. A destination of the channel
         already on screen was inviting a click that reloads the same view. */
      selectId: n.ownerId && n.ownerId !== selectedId ? n.ownerId : null,
      title: n.ownerId && n.ownerId !== selectedId
        ? `${n.label} — click to view ${idToName[n.ownerId] || n.ownerId}`
        : n.label,
      lines: nameLines[id],
    });
  }).join("");

  allNodeIds.forEach((id) => {
    if (!pos[id]) return;
    const r = rectOf(id);
    grow(r.x, r.y);
    grow(r.x + r.w, r.y + r.h);
  });
  const PAD = 16;
  const vx = Math.floor(bounds.minX - PAD), vy = Math.floor(bounds.minY - PAD);
  const vw = Math.max(240, Math.ceil(bounds.maxX + PAD) - vx);
  const vh = Math.max(160, Math.ceil(bounds.maxY + PAD) - vy);

  // Edges first so they pass behind every card. They were drawn last, which put
  // them over the labels: the reason a channel's own name was unreadable in the
  // middle of its fan-in.
  wrap.innerHTML = `<svg width="${vw}" height="${vh}" viewBox="${vx} ${vy} ${vw} ${vh}">
    <g class="mf-edges">${edgeLines}${extEdgeLines}</g>
    <g class="mf-nodes">${nodeEls}${extNodeEls}</g>
  </svg>`;
  // Attribute rather than dataset: everything else here reads and writes
  // attributes, and dataset is one more thing a host has to provide.
  wrap.setAttribute("data-beyond", String(beyond || 0));

  wireGraphInteractions(wrap, onSelectChannel);
}

/* Line colour and dash per route kind, and the legend label each one echoes.
   One table, so the graph, the trace chain and the legend cannot disagree about
   what a route of a given kind looks like. */
const EDGE_KIND = {
  writer:   { stroke: "var(--violet)",     dash: "",                          marker: "mfArrowWriter",   label: "Channel Writer route" },
  traced:   { stroke: "var(--blue)",       dash: 'stroke-dasharray="2,3"',    marker: "mfArrowTraced",   label: "Script route (traceable)" },
  untraced: { stroke: "var(--warn)",       dash: 'stroke-dasharray="6,3"',    marker: "mfArrowUntraced", label: "Script route that writes no source map" },
  disabled: { stroke: "var(--text-faint)", dash: 'stroke-dasharray="4,3"',    marker: "mfArrowDisabled", label: "Disabled" },
};
const NODE_KIND_LABEL = {
  selected: "The channel you are viewing",
  known: "A channel on this engine",
  unknown: "Unknown, deleted, or not visible to you",
  ext: "Other destination (not a channel route)",
  runtime: "Channel chosen at run time",
};

/* Hovering a route says what kind it is and lights its legend entry; hovering a
   legend entry picks out every route of that kind and fades the rest. The second
   direction is the one that earns its keep on a dense graph, where "show me
   everything that writes no source map" is otherwise an eye-tracing exercise. */
function wireGraphInteractions(wrap, onSelectChannel) {
  wrap.querySelectorAll("[data-select-channel]").forEach((el) => {
    el.addEventListener("click", (ev) => {
      // The edit chip sits inside the card, so its click must not also select.
      if (ev.target.closest && ev.target.closest("[data-edit]")) return;
      onSelectChannel(el.getAttribute("data-select-channel"));
    });
  });
  /* Hovering a route picks out that one route, not every route of its kind.
     Following a single line through a busy graph is the thing a reader actually
     does, and the kind-wide highlight is still available from the legend, which
     is where "show me everything that writes no source map" belongs.

     Whatever cards the line passes over fade with it, so the line can be read
     across them. That is what makes crossing a card acceptable, and it is why
     none of this routes around them any more. */
  const cards = [...wrap.querySelectorAll("[data-node-id]")];
  wrap.querySelectorAll(".mf-edge").forEach((el) => {
    el.addEventListener("mouseenter", () => {
      const crosses = new Set((el.getAttribute("data-crosses") || "").split(" ").filter(Boolean));
      wrap.querySelectorAll(".mf-edge").forEach((o) => {
        o.classList.toggle("mf-solo", o === el);
        o.classList.toggle("mf-off", o !== el);
      });
      cards.forEach((c) => c.classList.toggle("mf-behind", crosses.has(c.getAttribute("data-node-id"))));
      showGraphTip(el.getAttribute("data-label"), el.getAttribute("data-detail"));
    });
    el.addEventListener("mousemove", moveGraphTip);
    el.addEventListener("mouseleave", () => { clearEdgeSolo(wrap); hideGraphTip(); });
  });
}

function clearEdgeSolo(wrap) {
  wrap.querySelectorAll(".mf-edge").forEach((o) => o.classList.remove("mf-solo", "mf-off"));
  wrap.querySelectorAll("[data-node-id]").forEach((c) => c.classList.remove("mf-behind"));
}

let graphTipEl = null;
function graphTip() {
  if (!graphTipEl) {
    graphTipEl = document.createElement("div");
    graphTipEl.className = "mf-tip";
    document.body.appendChild(graphTipEl);
  }
  return graphTipEl;
}
function showGraphTip(label, detail) {
  const t = graphTip();
  t.innerHTML = `<b>${esc(label || "")}</b>${esc(detail || "")}`;
  t.style.display = "block";
}
function moveGraphTip(ev) {
  const t = graphTip();
  t.style.left = `${ev.clientX + 14}px`;
  t.style.top = `${ev.clientY + 16}px`;
}
function hideGraphTip() { if (graphTipEl) graphTipEl.style.display = "none"; }

/* Dims by family, so picking out a route kind does not also grey every channel.
   Scoped to the document because the legend lives outside the SVG. */
function highlightKind(family, kind) {
  document.querySelectorAll("[data-family]").forEach((el) => {
    const same = el.getAttribute("data-family") === family;
    const on = same && el.getAttribute("data-kind") === kind;
    el.classList.toggle("mf-on", !!kind && on);
    el.classList.toggle("mf-off", !!kind && same && !on);
  });
}

/* Pure: returns the routing-table HTML for the full graph. Same content
   regardless of which channel (if any) is focused, so it's shared as-is. */

/* ── OIE Source Code Search, the primary source for script routing ───────────
   Channel export XML says a route call exists and what literal it matched. It
   cannot say where in the channel the call is written, what the call actually
   looks like, whether its target is computed, or that a call exists at all
   inside a code template. Source Code Search answers all four, quickly, and is
   the source this prefers for anything about a script route.

   The built-in parser remains the fallback so the map still works without it,
   but the fallback knows strictly less and the UI says so rather than quietly
   showing a thinner answer. */
const SCS_PATH = "/extensions/oie-source-code-search/search";
const ROUTE_CALL = /\brouteMessage(?:ByChannelId)?\s*\(/;
/* The same pattern, asked of Source Code Search directly. Its regex mode takes
   a Java pattern, and \b, (?:...) and \s all mean there what they mean here, so
   one pattern can serve both instead of two that have to agree.

   The plain query it replaces is a case-insensitive contains, which is loose in
   both directions: "ROUTEMESSAGE" matched, and so did the tail of
   myRouteMessageHelper(. Neither is a statement that can run, and every one of
   them crossed the wire only to be discarded by ROUTE_CALL on arrival. Sent
   case-sensitively, because the language is. Verified against a live engine,
   where the pattern and the old query return the same fifteen raw matches and
   the same nine route calls. */
const ROUTE_CALL_PATTERN = "\\brouteMessage(?:ByChannelId)?\\s*\\(";
const LITERAL_ARG = /\brouteMessage(?:ByChannelId)?\s*\(\s*(['"])[^'"]*\1\s*[,)]/;
const CONCATENATED = /\brouteMessage(?:ByChannelId)?\s*\(\s*(['"])[^'"]*\1\s*\+/;
const FIRST_LITERAL = /\brouteMessage(?:ByChannelId)?\s*\(\s*(['"])([^'"]*)\1/;
/* Where to get the code template. The instruction to import it is useless in
   the place it is read unless it also says where from, and the reader is in a
   table cell rather than in the documentation. */
const RWS_URL = "https://github.com/nextgenhealthcare/connect-examples/tree/master/Code%20Templates/Route%20with%20Sources";
const RWS_LINK = `<a href="${RWS_URL}" target="_blank" rel="noopener" class="mf-help"`
  + ` title="Route with Sources, by Tony Germano, in the NextGen connect-examples repository: Code Templates / Route with Sources. Import the library export, then enable it for this channel.">?</a>`;

/* Whether a channel has ever received anything. A Channel Reader that no route
   targets is either fed by a route the map cannot resolve, or never runs, and
   the message count settles which without guessing: a channel that has received
   messages is being fed by something, whatever the map can see.

   Counts are cumulative since the statistics were last cleared, so zero means
   "not since then" rather than "never", and the wording says so. */
async function fetchReceivedCounts(api) {
  try {
    const rows = await api.statistics.list(undefined, true);
    const byId = {};
    for (const r of rows || []) {
      if (r && r.channelId != null) byId[r.channelId] = Number(r.received) || 0;
    }
    return byId;
  } catch (e) {
    return null;
  }
}

/* Why the enrichment is unavailable, when it is. A missing plugin and a missing
   permission both surface as a failed call and want different advice. */
function unavailableReason(e) {
  const status = e && (e.status || e.statusCode || (e.response && e.response.status));
  const text = String((e && e.message) || e || "");
  if (status === 401 || status === 403 || /forbidden|unauthori[sz]ed|permission/i.test(text)) return "permission";
  return "absent";
}

/** One route call as Source Code Search found it. */
function describeCall(m) {
  const text = String(m.lineText || "").trim();
  const target = (text.match(FIRST_LITERAL) || [])[2] || null;
  /* Source Code Search matches a line at a time, so a call whose arguments run
     onto the next line arrives cut off at the line break. Read as a whole line
     it looks exactly like a computed target -- "routeMessage(" and
     "routeMessage(target," are both a call with no literal first argument --
     and it was being reported as one, so a plain literal target on the next
     line was asserted to be determined at run time.

     The server does not have this problem: it parses the channel's script as
     one string, and \s* after the paren spans the line break, so it resolves
     the target and draws the edge. The two halves then disagreed about the same
     call. Saying the target was not read is true; saying it is computed is a
     guess, and on a split literal a wrong one. */
  const dynamic = CONCATENATED.test(text) ? "concatenated"
    : LITERAL_ARG.test(text) ? null
    : callRunsOn(text) ? "split"
    : "variable";
  return {
    channelId: m.channelId,
    channelName: String(m.channelName || ""),
    location: String(m.location || ""),
    lineNumber: Number(m.lineNumber) || 0,
    text,
    target,
    dynamic,
    traced: !/\brouter\s*\.\s*routeMessage/.test(text),
  };
}

async function fetchRouteCalls(api) {
  let payload;
  try {
    payload = await api.get(SCS_PATH, {
      query: ROUTE_CALL_PATTERN, regex: true, caseSensitive: true,
      searchChannels: true, searchCodeTemplates: true,
    });
  } catch (e) {
    return { unavailable: unavailableReason(e) };
  }
  /* core/api.js parses the body through unwrap(), which strips a single XStream
     root key, so this receives the contents of SearchResults rather than the
     envelope curl shows. Accept both: the envelope when something hands us a
     raw body, the contents when the platform client has already opened it.
     asList then handles the element key, where a lone match arrives as an
     object rather than an array. */
  const results = (payload && payload["com.diridium.sourcecodesearch.SearchResults"]) || payload;
  const raw = api.asList(results && results.matches, "com.diridium.sourcecodesearch.SearchMatch");

  const byChannel = {};
  const inCodeTemplates = [];
  for (const m of raw) {
    const call = describeCall(m);
    // Commented-out calls are reported by the search and are not routes.
    if (callIsCommented(call.text)) continue;
    if (!ROUTE_CALL.test(call.text)) continue;
    // A code template that defines the routing helpers is not a channel
    // routing anywhere. Only a call with a literal target is somebody's route;
    // "function routeMessage(channelName, ...)" and the library's own
    // delegation to router are its implementation.
    if (m.groupType === "CODE_TEMPLATE") {
      if (call.target) inCodeTemplates.push(call);
    }
    else if (call.channelId) (byChannel[call.channelId] ??= []).push(call);
  }
  return { byChannel, inCodeTemplates };
}

/* What a route points at, in words. A Channel Writer set to None has no target
   and a restricted one has a target the reader may not see; neither is a channel
   the map failed to resolve, which is what falling back on a missing toName
   claimed about both. */
function routeTargetLabel(e) {
  if (e.toNone) return "None (a Channel Writer with no target set)";
  if (e.toRestricted) return "a channel you cannot see";
  return e.toName || "a channel the map cannot resolve";
}

/** The call Source Code Search found for a given edge, if it can be identified. */
function callFor(index, edge) {
  if (!index || index.unavailable || !edge.viaScript || !edge.fromId) return null;
  const calls = index.byChannel[edge.fromId] || [];
  if (!calls.length) return null;
  const target = (String(edge.destName).match(/['"]([^'"]+)['"]/) || [])[1];
  const exact = target ? calls.filter((c) => c.target === target) : [];
  return (exact.length === 1 ? exact[0] : null) || (calls.length === 1 ? calls[0] : null);
}

/** Calls whose target cannot be resolved from configuration, so no edge exists. */
/** The first argument of a call: the thing that decides where the message goes.
    Scans rather than pattern-matches, because the argument is frequently itself
    a call, and stopping at the first comma or bracket truncates $c('routeTo')
    to $c('routeTo. Quotes are tracked so a bracket or comma inside a string
    ends nothing. */
/* Whether the call on this line is inside a comment. The test this replaces was
   a pattern anchored at the start of the trimmed line, which catches a line
   beginning with a line-comment marker and a continuation line of a block, and
   nothing else. It missed a call wrapped in a block comment on one line, whose
   first character is a single slash rather than either of those, and a call
   after a trailing line comment. Both were reported as routes, and because
   the server is comment-aware and gives them no edge, they turned up in the
   routing table as routes the map could not account for.

   Scans to the call rather than pattern-matching the start, tracking strings so
   a // inside one is not a comment. The server does the same thing over the
   whole script; here there is only ever one line to work with.

   What one line cannot settle: a call inside a multi-line block comment whose
   own line carries no marker. Nothing in the line says it is commented, and the
   search returns no surrounding context. The server excludes it from the edges
   regardless, so the graph stays right and only the table can be fooled. */
function callIsCommented(text) {
  const src = String(text || "");
  if (/^\*/.test(src.trim())) return true;     // a * continuation line of a block
  const m = ROUTE_CALL.exec(src);
  if (!m) return false;
  let quote = null;
  for (let i = 0; i < m.index; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "/" && src[i + 1] === "/") return true;
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close === -1 || close > m.index) return true;   // the block covers the call
      i = close + 1;                                       // it closed before it
    }
  }
  return false;
}

/* Whether a call's argument list is still open at the end of the line, which
   means the rest of it is on lines this one cannot see. */
function callRunsOn(text) {
  const src = String(text || "");
  const m = ROUTE_CALL.exec(src);
  if (!m) return false;
  let depth = 0, quote = null;
  for (let i = src.indexOf("(", m.index); i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (depth === 0) return false;   // closed before the line ended
  }
  return depth > 0;
}

function targetExpression(text) {
  const src = String(text || "");
  const open = src.search(/\brouteMessage(?:ByChannelId)?\s*\(/);
  if (open === -1) return null;
  let i = src.indexOf("(", open) + 1;
  const start = i;
  let depth = 0, quote = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(" || ch === "[") { depth++; continue; }
    if (ch === ")" || ch === "]") { if (depth === 0) break; depth--; continue; }
    if (ch === "," && depth === 0) break;
  }
  const arg = src.slice(start, i).trim();
  return arg || null;
}

function unresolvableRoutes(index, channelId) {
  if (!index || index.unavailable) return [];
  /* A call whose target was merely cut off by a line break is not an
     unresolvable route: the server reads the script whole and usually resolves
     it into an edge. Listing it here claimed the map could not account for a
     route it had already drawn. */
  return (index.byChannel[channelId] || []).filter((c) => c.dynamic && c.dynamic !== "split");
}

/* Calls whose arguments run onto a line the search did not return. They are
   listed on their own rather than among the routes, because the one thing that
   can be said about them is the same for all of them and it is about the source
   rather than about the routing: the target was not read here, and writing the
   call on one line would let it be. */
function splitCalls(index, channelId) {
  if (!index || index.unavailable) return [];
  const all = channelId
    ? (index.byChannel[channelId] || [])
    : Object.values(index.byChannel || {}).flat();
  return all.filter((c) => c.dynamic === "split");
}

/* Renders a call with the parts that are not literal marked, so a computed
   target explains itself rather than being asserted. Deliberately conservative:
   only quoted runs are treated as literal text and everything else is marked,
   which over-marks an operator rather than under-marking a variable. */
function renderCall(text) {
  if (!text) return "";
  const out = [];
  const pattern = /(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  let last = 0, m;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(`<span class="mf-dyn">${esc(text.slice(last, m.index))}</span>`);
    out.push(esc(m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(`<span class="mf-dyn">${esc(text.slice(last))}</span>`);
  return `<code class="mf-call">${out.join("")}</code>`;
}

/* What is worth saying about an engine before anyone reads a list. Deliberately
   short: the four in/out-degree combinations of a graph are trivial to compute
   and none of them is a question anybody asks, so terminals, channels with no
   destinations, and hubs were all computed shapes with a justification written
   afterwards. What remains is routing that cannot be accounted for and routing
   that cannot be traced, both of which name something to go and look at. */
function characterize(mfData, codeIndex) {
  const nodes = mfData.nodes;
  const edges = mfData.edges;
  const external = mfData.externalDestinations || [];
  const routedTo = new Set(edges.map((e) => e.toId).filter(Boolean));

  /* Nothing routing to a channel means two different things depending on how it
     receives. A listener takes messages from outside the engine, so nothing
     routing to it is expected. A Channel Reader can only be fed by a Channel
     Writer or a router call, so nothing routing to it means either something
     targets it in a way the map cannot resolve, or nothing does. */
  const CHANNEL_READER = "Channel Reader";
  const entry = nodes.filter((n) => !routedTo.has(n.id) && n.sourceTransport !== CHANNEL_READER);
  const unfed = nodes.filter((n) => !routedTo.has(n.id) && n.sourceTransport === CHANNEL_READER);

  /* Every computed target is a route whose destination the map cannot resolve,
     so any of them could be feeding a channel that looks unreached. Counting
     them turns a bare claim into one a reader can weigh. */
  const computedTargets = nodes.filter((n) => unresolvableRoutes(codeIndex, n.id).length).length
    + external.filter((d) => d.dynamicRouting).length;

  /* Two ways a trail is lost, and only one of them applies unconditionally.
     A channel that sends with router.routeMessage always loses it: whatever it
     routes to arrives with no source map. A channel whose storage does not keep
     the source map only loses something if it receives routed messages, because
     that is the only case where there was an inbound trail to keep. Flagging a
     storage setting on a channel nothing routes to reports a condition with no
     consequence: its messages come from outside the engine and never had an
     ancestor to lose. */
  const gapChannels = new Set([
    ...nodes.filter((n) => n.traceGap && routedTo.has(n.id)).map((n) => n.id),
    ...edges.filter((e) => e.traceable === false).map((e) => e.fromId),
  ]);

  return { entry, unfed, computedTargets, gaps: nodes.filter((n) => gapChannels.has(n.id)) };
}

/* A channel name in a table is a destination, not a label. Two things a reader
   wants from one: see its routing here, or go and change it. The second is the
   point of most of these tables, since every gap they report is fixed by
   editing the channel. */
function channelCell(id, name) {
  if (!id) return esc(name || "");
  return `<a href="#" class="mf-link" data-open="${esc(id)}">${esc(name || id)}</a>`
    + `<a href="#" class="mf-edit" data-edit="${esc(id)}" title="Open this channel in the editor">edit</a>`;
}

/* The routing tables. With no focusId these describe the whole engine, which is
   what the overview page wants; with one they are cut to the routes and
   destinations that touch that channel, because a reader looking at one
   channel's graph should not be handed the engine's entire routing list
   underneath it. */
function renderTablesHTML(ui, mfData, focusId, codeIndex, only) {
  const all = mfData.edges;
  const edges = focusId ? all.filter((e) => e.fromId === focusId || e.toId === focusId) : all;
  const allExternal = mfData.externalDestinations || [];
  const external = focusId ? allExternal.filter((d) => d.channelId === focusId) : allExternal;
  const nodes = focusId ? mfData.nodes.filter((n) => n.id === focusId) : mfData.nodes;

  /* Grouped by source channel, and grouped once. A flat engine-ordered list of
     every edge is hard to read: a reader asking "what does this channel feed"
     had to scan the whole table for its name. Grouping only the resolved edges
     was not enough, because the routes whose target cannot be resolved and the
     Channel Writers with a template target were built as separate blocks and
     concatenated after them. A channel with all three then headed its own group
     near the top and reappeared twice further down, under other channels'
     names, in the same table. They are all one channel's outbound routing and
     they belong in one group, so each kind is turned into a row of the same
     shape first and the grouping happens once, over all of them. */
  const edgeEntries = edges.map((e) => {
        const toLabel = e.toNone
          ? '<span style="color:var(--text-faint)" title="A Channel Writer set to None. The destination reports SENT and the message goes nowhere.">None</span>'
          : e.toRestricted
          ? '<span style="color:var(--text-faint)">a channel you cannot see</span>'
          : e.toName
            ? (e.viaScript && !e.toId ? esc(e.toName) + ' <span style="color:var(--warn);font-size:11px">(name not found among known channels)</span>' : channelCell(e.toId, e.toName))
            : "(unknown channel \u2014 id: " + esc(e.toId || "?") + ")";
        /* Being enabled is a property of a destination connector, so it is
           shown with the connector rather than in a column of its own that a
           script route can only ever put a placeholder in. A script route has
           no enable switch at all, and whether its line executes depends on the
           code around it, which nothing here inspects. */
        const disabledTag = e.enabled === false
          ? ' <span style="color:var(--text-faint);font-size:11px">disabled</span>' : "";
        const sourceMapTag = e.traceable === false
          ? ' <span style="color:var(--warn);font-size:11px" title="This call does not write the source map, so message tracing stops at this hop.">no source map</span>'
          : "";
        /* How is the mechanism, shown as itself: the connector type for a
           destination, the call as written for a script. Where is the one
           question asked of both, answered as a destination number or as the
           place in the source the call sits. */
        const call = callFor(codeIndex, e);
        /* A computed target is not knowable from configuration, so the literal
           the parser managed to match is not the answer and must not be shown
           as one. 'MF_SITE_' is the prefix of a name, not a channel. */
        /* Only a target the code actually computes is shown as computed. A
           call cut off at a line break has an unread target, which the edge
           itself may well have resolved. */
        const computed = call && call.dynamic && call.dynamic !== "split";
        const splitCall = !!(call && call.dynamic === "split");
        /* A located call is shown as source, because it is. An unlocated one
           must not be: rendering the parser's reconstruction in the same
           monospace as real code claimed evidence we do not have, and paired
           with an empty Where it read as a contradiction. */
        /* A split call's source line is only its first line, so showing it
           alone reads as the whole call. The tag says the rest is elsewhere,
           rather than leaving a reader to wonder why the parentheses do not
           close. */
        const splitTag = splitCall
          ? ` <span style="color:var(--text-faint);font-size:11px" title="This call's arguments continue on the next line. Source Code Search matches a line at a time, so only the first line is shown and the target could not be read from it. The target beside it, if any, is the one the routing parser resolved from the whole script.">continues on the next line</span>`
          : "";
        const how = e.via !== "script"
          ? `<span style="color:var(--violet)">Channel Writer</span>`
          : call
            ? renderCall(call.text) + splitTag
            : `<span style="color:var(--text-dim)">${esc((String(e.destName).match(/^[\w.]+/) || ["routeMessage"])[0])} to ${esc((String(e.destName).match(/['"]([^'"]+)['"]/) || [])[1] || "?")}</span>`;
        const where = e.via === "script"
          ? (call
              ? `${esc(call.location)}${call.lineNumber ? ` <span style="color:var(--text-faint)">line ${call.lineNumber}</span>` : ""}`
              : splitCalls(codeIndex, e.fromId).length
                ? '<span style="color:var(--warn)" title="Source Code Search found route calls in this channel, but their arguments continue past the end of the line it matched, so none of them could be tied to this route. The target shown was resolved by the routing parser, which reads the whole script.">call found, but split across lines</span>'
                : '<span style="color:var(--warn)" title="The routing parser found this call in the channel configuration, but Source Code Search did not return it. The two disagree, which usually means the call is in a code template or the search could not read that part of the channel.">not found by Source Code Search</span>')
          : (e.destinationId != null
              ? `Destination ${e.destinationId}: ${esc(e.destName)}`
              : esc(e.destName));
    return {
      fromId: e.fromId,
      fromName: e.fromName,
      how: `${how}${disabledTag}${sourceMapTag}`,
      to: computed
        ? (targetExpression(call.text)
            ? `<code class="mf-call"><span class="mf-dyn">${esc(targetExpression(call.text))}</span></code>`
            : `<span style="color:var(--violet)">determined at run time</span>`)
        : toLabel,
      where,
    };
  });

  /* A call whose target is a plain variable matches no literal, so the parser
     produced no edge and the channel looked like it does not route. These are
     real routes and belong in the routing list, with the one honest answer
     available for their target. */
  const routedChannels = new Set(edges.filter((e) => e.viaScript).map((e) => e.fromId));
  const orphanEntries = (focusId ? [focusId] : mfData.nodes.map((n) => n.id))
    .flatMap((id) => unresolvableRoutes(codeIndex, id)
      .filter((c) => c.dynamic === "variable" || !routedChannels.has(id))
      .map((c) => ({ id, call: c })))
    .map(({ id, call }) => ({
      fromId: id,
      fromName: (mfData.nodes.find((n) => n.id === id) || {}).name,
      how: `${renderCall(call.text)}${call.traced ? "" : ' <span style="color:var(--warn);font-size:11px">no source map</span>'}`,
      to: targetExpression(call.text)
        ? `<code class="mf-call"><span class="mf-dyn">${esc(targetExpression(call.text))}</span></code>`
        : `<span style="color:var(--violet)">determined at run time</span>`,
      where: `${esc(call.location)}${call.lineNumber ? ` <span style="color:var(--text-faint)">line ${call.lineNumber}</span>` : ""}`,
    }));

  /* A Channel Writer with a template target is a route: it belongs with the
     other routes, naming the template as its destination, rather than in a
     side table that made it look like a different kind of thing. */
  const dynamicWriterEntries = external.filter((d) => d.dynamicRouting).map((d) => ({
    fromId: d.channelId,
    fromName: d.channelName,
    how: `<span style="color:var(--violet)">Channel Writer</span>${d.enabled === false ? ' <span style="color:var(--text-faint);font-size:11px">disabled</span>' : ""}`,
    to: d.dynamicTarget
      ? `<code class="mf-call"><span class="mf-dyn">${esc(d.dynamicTarget)}</span></code>`
      : '<span style="color:var(--violet)">determined at run time</span>',
    where: d.destinationId != null ? `Destination ${d.destinationId}: ${esc(d.destName)}` : esc(d.destName),
  }));

  /* Keyed by id where there is one, so two channels that share a name are not
     merged, and by name for the rare route whose source id the parser could not
     resolve. Insertion order is kept, so a channel first seen among the
     resolved edges keeps that position and its other routes join it there
     rather than starting a second group lower down. */
  const bySource = new Map();
  [...edgeEntries, ...orphanEntries, ...dynamicWriterEntries].forEach((r) => {
    const key = r.fromId || `name:${r.fromName}`;
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(r);
  });

  const routingRows = bySource.size
    ? [...bySource.values()].map((group) => group.map((r, idx) => `<tr${idx === 0 && bySource.size > 1 ? ' style="border-top:1px solid var(--line-strong)"' : ""}>
        <td style="font-weight:${idx === 0 ? 600 : 400};vertical-align:top">${idx === 0 ? channelCell(r.fromId, r.fromName) : ""}</td>
        <td>${r.how}</td>
        <td>${r.to}</td>
        <td>${r.where}</td>
      </tr>`).join("")).join("")
    : `<tr><td colspan="4" style="color:var(--text-faint)">${focusId ? "This channel has no channel-to-channel routing." : "No channel-to-channel routing found."}</td></tr>`;

  const leavingEngine = external.filter((d) => !d.dynamicRouting);
  const byChannel = {};
  leavingEngine.forEach((d) => { (byChannel[d.channelName] ??= []).push(d); });
  const extRows = Object.keys(byChannel).length
    ? Object.entries(byChannel).map(([chName, dests]) => `<tr>
        <td style="vertical-align:top;font-weight:600">${channelCell((dests[0] || {}).channelId, chName)}</td>
        <td>
          ${dests.map((d) => `<div style="margin-bottom:2px">${iconForTransportCell(ui, d.transportName)}${esc(d.destName)} <span style="color:var(--text-faint);font-family:var(--font-mono,monospace);font-size:11px">(${esc(d.transportName)})</span>${d.enabled === false ? ' <span style="color:var(--text-faint)">\u2014 disabled</span>' : ""}</div>`).join("")}
        </td>
      </tr>`).join("")
    : `<tr><td colspan="2" style="color:var(--text-faint)">${focusId ? "This channel has no destinations other than its channel routes." : "No other destinations found."}</td></tr>`;

  /* One question only: will a trace through this channel find anything? A
     computed routing target is a different problem, belongs to the map, and is
     a row in the routing table above; listing it here said the same thing twice
     and blurred what this section is for. */
  const untraceable = edges.filter((e) => e.traceable === false);
  const routedToHere = new Set(all.map((e) => e.toId).filter(Boolean));

  /* One row per channel, not one per route call. The row was emitted per
     untraceable edge while carrying nothing that distinguished one edge from
     another, so a channel with three router.routeMessage calls printed three
     identical rows, the long remedy paragraph included. The two causes were
     also emitted in separate blocks, which scattered a channel's rows down the
     table instead of keeping them together. Grouping fixes both: a channel
     appears once, with every reason its trail is lost and the matching fix
     beside it, the way Other destinations already groups a channel's
     destinations into one cell. The calls are named because that is the part
     that actually differs, and it is what tells a reader how much there is to
     change. */
  const gapsByChannel = new Map();
  const gapFor = (id, name) => {
    if (!gapsByChannel.has(id)) gapsByChannel.set(id, { id, name, calls: [], storage: null });
    return gapsByChannel.get(id);
  };
  untraceable.forEach((e) => gapFor(e.fromId, e.fromName).calls.push(e.destName));
  nodes.filter((n) => n.traceGap && routedToHere.has(n.id))
    .forEach((n) => { gapFor(n.id, n.name).storage = n; });

  /* Node order, so this table reads in the same order as every other one. A
     channel that only routes untraceably has no node of its own in a focused
     view, so anything the node list does not cover is appended rather than
     dropped. */
  const ordered = [
    ...nodes.map((n) => gapsByChannel.get(n.id)).filter(Boolean),
    ...[...gapsByChannel.values()].filter((g) => !nodes.some((n) => n.id === g.id)),
  ];

  const stack = (parts) => parts.map((h) => `<div style="margin-bottom:9px">${h}</div>`).join("");

  const traceabilityRowsAll = ordered.map((g) => {
    const reasons = [];
    if (g.calls.length) {
      reasons.push([
        `<span style="color:var(--warn)">Routes with <code>router.routeMessage</code></span>${g.calls.length > 1
          ? `<div style="color:var(--text-faint);font-size:11px;margin-top:2px">${g.calls.length} calls: ${g.calls.map((c) => `<code>${esc(c)}</code>`).join(", ")}</div>`
          : ""}`,
        `<code>router.routeMessage</code> does not send the source map to the downstream channel, so nothing there records where the message came from. Import the <b>Route with Sources</b> code template library${RWS_LINK} and call <code>routeMessage(...)</code> instead: dropping the <code>router.</code> prefix is the whole change, and the code template sends the source map a Channel Writer would.`,
      ]);
    }
    if (g.storage) {
      reasons.push([
        `<span style="color:var(--warn)">${esc(g.storage.traceGapCause)}</span>`,
        esc(g.storage.traceGap),
      ]);
    }
    return `<tr>
      <td style="vertical-align:top">${channelCell(g.id, g.name)}</td>
      <td style="vertical-align:top">${stack(reasons.map((r) => r[0]))}</td>
      <td style="vertical-align:top">${stack(reasons.map((r) => r[1]))}</td>
    </tr>`;
  }).join("");

  const traceabilitySection = traceabilityRowsAll
    ? `<div class="mf-section-title">Where message tracing will fail</div>
       <div class="mf-section-note">A message trace follows the source map the engine writes on each hop. These channels either never write it or do not keep it, so a trace that reaches them stops. They route correctly either way; only the record of it is missing.</div>
       <table class="mf-table"><thead><tr><th>Channel</th><th>Cause</th><th>What to change</th></tr></thead><tbody>${traceabilityRowsAll}</tbody></table>`
    : "";

  /* Called out as a limitation of the reading, not as a fault in the routing.
     Every one of these is a real route; what is missing is the target, and only
     because the line the search returned stops before it. The remedy is the
     channel's formatting, so it is stated as one. */
  const split = splitCalls(codeIndex, focusId);
  const splitSection = split.length
    ? `<div class="mf-section-title">Route calls read only in part</div>
       <div class="mf-section-note">Source Code Search matches one line at a time, and ${split.length === 1 ? "this call continues" : "these calls continue"} past the end of it, so the target could not be read from the source. Where the target is a plain name the routing parser still resolved it from the whole script and the route is drawn above; where it is not, that route is missing from the map. Writing the call and its first argument on one line is all it takes to close the gap.</div>
       <table class="mf-table">
         <thead><tr><th>Channel</th><th>Where</th><th>The line as matched</th></tr></thead>
         <tbody>${split.map((c) => `<tr>
           <td>${channelCell(c.channelId, c.channelName)}</td>
           <td style="color:var(--text-dim)">${esc(c.location)}${c.lineNumber ? ` <span style="color:var(--text-faint)">line ${c.lineNumber}</span>` : ""}</td>
           <td><code class="mf-call">${esc(String(c.text).trim())}</code><span style="color:var(--text-faint)">&nbsp;\u2026</span></td>
         </tr>`).join("")}</tbody>
       </table>`
    : "";

  const templateRoutes = (!focusId && codeIndex && !codeIndex.unavailable && codeIndex.inCodeTemplates.length)
    ? `<div class="mf-section-title">Routing inside code templates</div>
       <div class="mf-section-note">Route calls written in shared code rather than in a channel. Message Flow cannot draw these as edges, because code templates are not part of any channel's configuration, so which channels they affect depends on which libraries those channels enable. Found by OIE Source Code Search.</div>
       <table class="mf-table">
         <thead><tr><th>Template</th><th>Where</th><th>Line</th></tr></thead>
         <tbody>${codeIndex.inCodeTemplates.map((m) => `<tr>
           <td>${esc(m.channelName)}</td>
           <td style="color:var(--text-dim)">${esc(m.location)}</td>
           <td style="color:var(--text-faint);font-family:var(--font-mono,monospace);font-size:11.5px">${esc(String(m.lineText || "").trim().slice(0, 90))}</td>
         </tr>`).join("")}</tbody>
       </table>`
    : "";

  const show = (name) => !only || only === name;

  return `
    ${show("routes") ? `
    <div class="mf-section-title">${focusId ? "Routes into and out of this channel" : "Channel \u2192 channel routing"}</div>
    <table class="mf-table">
      <thead><tr><th>From</th><th>How</th><th>To</th><th>Where</th></tr></thead>
      <tbody>${routingRows}</tbody>
    </table>` : ""}
    ${show("external") && focusId ? `
    <div class="mf-section-title">Other destinations</div>
    <div class="mf-section-note">Destinations that are not a channel-to-channel route. What each actually does is a property of its connector, and for a JavaScript Writer of its script: it may send data out of the engine, write somewhere local, do nothing, or even route onward itself. This map cannot tell which, so it does not guess.</div>
    <table class="mf-table">
      <thead><tr><th>Channel</th><th>Destinations</th></tr></thead>
      <tbody>${extRows}</tbody>
    </table>` : ""}
    ${show("routes") ? splitSection : ""}
    ${show("routes") ? templateRoutes : ""}
    ${show("trace") ? traceabilitySection : ""}`;
}

/* Every colour and dash the graphs use, said once. The nodes were never in here
   at all, so the two solid fills a reader sees most often, the channel they are
   looking at and every other channel, had nothing telling them what they meant.
   Grouped because a line and a circle answer different questions. The swatch
   colours are the same literals the graph draws with, so a change to one
   without the other is visible rather than silent. */
function legendHTML() {
  const item = (family, kind, swatchClass, css, label) =>
    `<span class="mf-legend-item" data-family="${family}" data-kind="${kind}"><span class="${swatchClass}" style="${css}"></span>${label}</span>`;
  const dashCss = (color, size) => `background:${color};background-image:linear-gradient(90deg,${color} 60%,transparent 40%);background-size:${size} 2px`;
  const routes = [
    ["writer", "background:var(--violet)"],
    ["traced", dashCss("var(--blue)", "6px")],
    ["untraced", dashCss("var(--warn)", "9px")],
    ["disabled", dashCss("var(--text-faint)", "8px")],
  ].map(([kind, css]) => item("route", kind, "mf-legend-line", css, EDGE_KIND[kind].label)).join("");
  const nodes = [
    ["selected", "background:radial-gradient(circle at 35% 30%,#f5e2ae,#d4a656 55%,#9b7532);border:1px solid #e8c874"],
    ["known", "background:radial-gradient(circle at 35% 30%,#a8c4f5,#6f8fd9 55%,#3f5ba8);border:1px solid #6f8fd9"],
    ["unknown", "background:var(--bg3);border:1.5px dashed var(--text-faint)"],
    ["ext", "background:#233240;border:1.3px dashed #5a8fa8"],
    ["runtime", "background:#2a2438;border:1.3px dashed var(--violet)"],
  ].map(([kind, css]) => item("node", kind, "mf-legend-dot", css, NODE_KIND_LABEL[kind])).join("");
  return `<div class="mf-legend">
    <span class="mf-legend-group"><span class="mf-legend-heading">Routes</span>${routes}</span>
    <span class="mf-legend-group"><span class="mf-legend-heading">Channels</span>${nodes}</span>
  </div>`;
}

/* The legend is the other half of the hover pairing: point at an entry and every
   route or channel of that kind is picked out of the graph while the rest fade.
   On a dense graph that answers "show me everything that writes no source map"
   directly, which is otherwise an eye-tracing exercise. */
function wireLegend(container) {
  if (!container) return;
  container.querySelectorAll(".mf-legend-item").forEach((el) => {
    el.addEventListener("mouseenter", () => highlightKind(el.getAttribute("data-family"), el.getAttribute("data-kind")));
    el.addEventListener("mouseleave", () => highlightKind(null, null));
  });
}

/* Renders a linear ancestor -> current -> descendant chain in the same visual
   language as the topology graph. A separate renderer rather than reusing
   renderFocusSvgInto: that one lays an arbitrary graph out by BFS level, which
   is the wrong shape for what is always a straight line. Both share one set of
   gradient, filter and marker definitions (see ensureDefs). */
// A message can route back into its own upstream, and Channel Writer appends a
// hop every lap, so a chain is not bounded by the number of channels. The server
// caps what it returns; this caps what gets drawn, because the canvas is sized
// per node and a few hundred of them asks the browser for an SVG tens of
// thousands of pixels wide.
const MAX_RENDERED_HOPS = 21;

/* How the hop into a pseudo-node is drawn, taken from what the routing map uses
   for the same route so the two diagrams agree. A reader who has just looked at
   the map above should not have to work out that these are the same thing. */
const HOP_STYLE = {
  disabled: { stroke: "var(--text-faint)", dash: 'stroke-dasharray="4,3"', marker: "mfArrowDisabled" },
  untraceable: { stroke: "var(--warn)", dash: 'stroke-dasharray="6,3"', marker: "mfArrowUntraced" },
  runtime: { stroke: "var(--violet)", dash: 'stroke-dasharray="2,3"', marker: "mfArrowWriter" },
};

/** What a chain node says about itself under its name. */
function subtitleFor(n) {
  if (n.unconfirmed) return n.subtitleText || "not confirmed";
  if (n.restricted) return "not visible to you";
  if (n.notFound) return "not found";
  if (n.lookupError) return "lookup failed";
  return `#${n.messageId} \u00b7 ${n.status || "\u2014"}`;
}

/* ══════════════ Trace graph: reconstructing branches and merges ══════════
   A trace is not a chain. One message can fan out to several real
   destinations (a Channel Writer with two enabled routes sends two separate
   downstream messages), and separate branches can converge back onto the
   same target -- usually an external endpoint, since two different channels
   can each write to the same place. Ancestors stay a single line on
   purpose: a message has exactly one lineage backward in Mirth's model,
   so there is nothing to branch on that side.

   This reconstructs the real tree from parentChannelId/parentMessageId on
   each descendant (added server-side alongside this change -- see the
   accompanying MessageFlowServlet patch). If an older server is still
   deployed and that field is absent, this falls back to the previous
   flattened order and says so, rather than drawing something confidently
   wrong. */

function nodeKey(channelId, messageId) { return `${channelId}::${messageId}`; }

/** Why a specific branch's trail stops, asked of the channel it actually
    ended at. Returns null when there is simply nothing recorded yet -- not
    every dead end has a documented cause. */
function computeContinuation(endNode, mfData, codeIndex, transportById) {
  const endId = endNode.channelId;
  const endName = endNode.channelName || endId;
  const dynamicAtEnd = unresolvableRoutes(codeIndex, endId);
  const writerDynamicAtEnd = (mfData.externalDestinations || [])
    .filter((d) => d.dynamicRouting && d.channelId === endId);
  const untraceableAtEnd = mfData.edges.filter((e) => e.fromId === endId && e.traceable === false);
  const onwardAtEnd = mfData.edges.filter((e) => e.fromId === endId);
  const disabledAtEnd = onwardAtEnd.filter((e) => e.enabled === false);
  const allOnwardDisabled = onwardAtEnd.length > 0
    && disabledAtEnd.length === onwardAtEnd.length
    && !dynamicAtEnd.length && !writerDynamicAtEnd.length;

  if (allOnwardDisabled) {
    /* Keyed by what the routes actually point at, not by the branch they
       left from -- two different branches disabled on the way to the same
       destination are one dead end, not two, and should draw as one node. */
    const targetIds = disabledAtEnd.map((e) => e.toId || e.destName || "?").sort();
    const singular = disabledAtEnd.length === 1;
    return {
      channelName: singular ? (disabledAtEnd[0].toName || disabledAtEnd[0].destName || "1 destination") : `${disabledAtEnd.length} destinations`,
      targetKey: `disabled:${targetIds.join("|")}`,
      hopKind: "disabled", subtitleText: "route disabled",
      sourceTransport: singular ? transportById[disabledAtEnd[0].toId] : undefined,
      reason: `The trail ends at ${endName}: ${disabledAtEnd.length === 1 ? "its only route onward is" : disabledAtEnd.length === 2 ? "both of its routes onward are" : `all ${disabledAtEnd.length} of its routes onward are`} disabled (${disabledAtEnd.map((e) => `${e.destinationId != null ? `Destination ${e.destinationId}: ` : ""}${e.destName} \u2192 ${routeTargetLabel(e)}`).join("; ")}). Nothing was dispatched from it, so there is no downstream message for a trace to find. This reads the channel as it is configured now, not as it was when the message ran.`,
    };
  }
  if (untraceableAtEnd.length) {
    const targetIds = untraceableAtEnd.map((e) => e.toId || e.destName || "?").sort();
    const targets = untraceableAtEnd.map(routeTargetLabel);
    const singular = untraceableAtEnd.length === 1;
    return {
      channelName: singular ? targets[0] : `${untraceableAtEnd.length} channels`,
      targetKey: `untraceable:${targetIds.join("|")}`,
      hopKind: "untraceable",
      sourceTransport: singular ? transportById[untraceableAtEnd[0].toId] : undefined,
      reason: `The trail ends at ${endName}: it routes to ${targets.join(", ")} with router.routeMessage, which does not send the source map to the downstream channel. Nothing there records that it came from this message, so the routing map knows the hop exists but no trace can confirm this message took it. Import the Route with Sources code template library and call routeMessage(...) without the router. prefix to close the gap.`,
    };
  }
  if (dynamicAtEnd.length || writerDynamicAtEnd.length) {
    const where = dynamicAtEnd.length
      ? `${dynamicAtEnd[0].location}${dynamicAtEnd[0].lineNumber ? ` line ${dynamicAtEnd[0].lineNumber}` : ""}`
      : "a Channel Writer with a template target";
    return {
      channelName: "determined at run time",
      targetKey: `runtime:${endId}`,
      hopKind: "runtime",
      reason: `The trail ends at ${endName}: it routes to a target it builds at run time (${where}), so the routing map cannot say which channel this message went to, and the forward scan only looks at channels the map knows about. If it was routed with router.routeMessage the source map did not travel with it either, so nothing downstream can be linked back to it.`,
    };
  }
  return null;
}

/** Reconstructs the real branch/merge tree from the flat ancestors/
    descendants lists the API returns. `degraded` is true when the server
    has not yet been updated to send parentChannelId/parentMessageId, in
    which case descendants are laid out in the old single-file order so the
    view still works, and the caller should say why it looks that way. */
function buildTraceGraph(traceResult, mfData, codeIndex) {
  const transportById = {};
  (mfData && mfData.nodes || []).forEach((n) => { transportById[n.id] = n.sourceTransport; });

  const root = {
    channelId: traceResult.channelId, channelName: traceResult.channelName,
    messageId: traceResult.messageId, hop: 0, isRoot: true, children: [],
  };
  root.key = nodeKey(root.channelId, root.messageId);
  root.sourceTransport = transportById[root.channelId];

  const ancestors = (traceResult.ancestors || []).map((n) => ({ ...n, sourceTransport: transportById[n.channelId] }));

  const rawDescendants = traceResult.descendants || [];
  const degraded = rawDescendants.length > 0 && rawDescendants.every((d) => d.parentChannelId == null);

  const byKey = new Map([[root.key, root]]);
  rawDescendants.forEach((raw) => {
    const n = { ...raw, sourceTransport: transportById[raw.channelId], children: [] };
    n.key = nodeKey(n.channelId, n.messageId);
    byKey.set(n.key, n);
  });

  const orphans = [];
  if (degraded) {
    // No lineage to reconstruct from -- keep the previous behaviour (one
    // file, in scan order) rather than inventing structure that isn't there.
    let prev = root;
    rawDescendants.forEach((raw) => {
      const n = byKey.get(nodeKey(raw.channelId, raw.messageId));
      prev.children.push(n);
      prev = n;
    });
  } else {
    rawDescendants.forEach((raw) => {
      const n = byKey.get(nodeKey(raw.channelId, raw.messageId));
      const parent = byKey.get(`${raw.parentChannelId}::${raw.parentMessageId}`);
      if (parent) parent.children.push(n);
      else orphans.push(n); // parent fell outside the scan window (truncated) -- real, just not placeable
    });
  }

  const leaves = [];
  (function collectLeaves(n) {
    if (n.children.length) n.children.forEach(collectLeaves);
    else leaves.push(n);
  })(root);

  // Branches that end for a documented reason and share the same target are
  // drawn as one merged node with several incoming edges, rather than
  // repeating the same "?" once per branch.
  const continuationGroups = new Map();
  leaves.forEach((leaf) => {
    const c = computeContinuation(leaf, mfData, codeIndex, transportById);
    if (!c) return;
    const g = continuationGroups.get(c.targetKey) || { ...c, parents: [] };
    g.parents.push(leaf);
    continuationGroups.set(c.targetKey, g);
  });
  const continuations = [...continuationGroups.values()].map((g) => {
    const node = {
      channelName: g.channelName, unconfirmed: true, hop: Math.max(...g.parents.map((p) => p.hop)) + 1,
      hopKind: g.hopKind, subtitleText: g.subtitleText, sourceTransport: g.sourceTransport,
      reason: g.parents.length > 1
        ? `${g.reason} (${g.parents.length} branches route here: ${g.parents.map((p) => p.channelName || p.channelId).join(", ")}.)`
        : g.reason,
      mergedFrom: g.parents.length > 1 ? g.parents.length : 0,
      mergeParents: g.parents, // used once, after layout, to place this node between its branches
      children: [], key: `cont::${g.targetKey}`,
    };
    g.parents.forEach((p) => p.children.push(node));
    return node;
  });

  // Lane layout: leaves get sequential lanes; every parent centres over its
  // own children. Ancestors and the root sit on the root's lane, since that
  // side of the picture is never anything but one line.
  let nextLane = 0;
  /* A merge node has more than one parent, so it cannot be laned as an
     ordinary child: whichever branch's post-order pass reaches it first
     would set its lane, and every other branch feeding it would then
     average toward that same lane and collapse onto it. Each branch gets
     its own fresh row up to the merge; the merge node itself is placed
     afterward, once every branch that feeds it has a real row. */
  function laneForChild(child) {
    if (child.mergeParents) return nextLane++;
    return assignLane(child);
  }
  function assignLane(n) {
    if (n.lane !== undefined) return n.lane;
    if (!n.children.length) { n.lane = nextLane++; return n.lane; }
    const lanes = n.children.map(laneForChild);
    n.lane = lanes.reduce((a, b) => a + b, 0) / lanes.length;
    return n.lane;
  }
  assignLane(root);
  ancestors.forEach((a) => { a.lane = root.lane; });
  orphans.forEach((o) => { o.lane = nextLane++; });
  continuations.forEach((c) => {
    c.lane = c.mergeParents.reduce((sum, p) => sum + p.lane, 0) / c.mergeParents.length;
  });

  return { root, ancestors, leaves, continuations, orphans, degraded };
}

/** Renders a reconstructed trace graph (see buildTraceGraph) as branching
    cards and curves, the same visual language the routing map uses above
    it, so the two pictures of the same engine agree. */
function renderTraceGraphSvg(wrap, ui, graph, onSelectChannel) {
  ensureDefs();
  if (!wrap) return;
  const { root, ancestors, orphans } = graph;

  // A merge node is reachable from more than one parent; collect it once for
  // the card even though the edge walk below still draws one line per parent.
  const seen = new Set();
  const allNodes = [];
  const pushOnce = (n) => { if (!seen.has(n)) { seen.add(n); allNodes.push(n); } };
  ancestors.forEach(pushOnce);
  pushOnce(root);
  (function walk(n) { n.children.forEach(pushOnce); n.children.forEach(walk); })(root);
  orphans.forEach(pushOnce);

  if (!allNodes.length) { wrap.innerHTML = ""; return; }

  const CARD_H = 46, GAP_X = 58, GAP_Y = 20, TOP = 26, LEFT = 20;
  const cardOf = (n) => {
    const name = String(n.channelName || n.channelId || "");
    const sub = subtitleFor(n);
    return estimateLabelWidth(Math.max(name.length * 7.3, sub.length * 5.95) + 36);
  };

  // One column per distinct hop value, ordered left to right, so a gap in
  // hop numbers (e.g. a truncated branch) doesn't leave a blank column.
  const hops = [...new Set(allNodes.map((n) => n.hop))].sort((a, b) => a - b);
  const colIndex = new Map(hops.map((h, i) => [h, i]));
  const colWidth = hops.map((h) => Math.max(...allNodes.filter((n) => n.hop === h).map(cardOf)));
  const colX = [];
  let cursor = LEFT;
  colWidth.forEach((w) => { colX.push(cursor); cursor += w + GAP_X; });
  const width = cursor + 4;

  const maxLane = Math.max(0, ...allNodes.map((n) => n.lane));
  const rowH = CARD_H + GAP_Y;
  const height = TOP + (maxLane + 1) * rowH + 10;

  const xOf = (n) => colX[colIndex.get(n.hop)];
  const wOf = (n) => colWidth[colIndex.get(n.hop)];
  const yOf = (n) => TOP + n.lane * rowH;

  const curve = (x1, y1, x2, y2, stroke, dash, marker) => {
    const mx = (x1 + x2) / 2;
    return `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none"
      stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" ${dash || ""}
      marker-end="url(#${marker})"/>`;
  };

  const edgeEls = [];
  for (let i = 0; i < ancestors.length; i++) {
    const a = ancestors[i], b = i + 1 < ancestors.length ? ancestors[i + 1] : root;
    edgeEls.push(curve(xOf(a) + wOf(a), yOf(a) + CARD_H / 2, xOf(b), yOf(b) + CARD_H / 2, "var(--violet)", "", "mfArrowWriter"));
  }
  (function walkEdges(n) {
    n.children.forEach((c) => {
      const style = c.unconfirmed ? (HOP_STYLE[c.hopKind] || HOP_STYLE.untraceable) : null;
      edgeEls.push(curve(
        xOf(n) + wOf(n), yOf(n) + CARD_H / 2, xOf(c), yOf(c) + CARD_H / 2,
        style ? style.stroke : "var(--violet)", style ? style.dash : "", style ? style.marker : "mfArrowWriter",
      ));
    });
    n.children.forEach(walkEdges);
  })(root);

  const nodeEls = allNodes.map((n) => {
    const isCurrent = n.isRoot;
    const known = !n.unconfirmed && !n.notFound && !n.lookupError && !n.restricted;
    const w = wOf(n), x = xOf(n), y = yOf(n);
    const stripe = isCurrent ? "#d4a656" : known ? "#6f8fd9" : "var(--text-faint)";
    const border = isCurrent ? "#e8c874" : known ? "#2e3b4d" : "var(--text-faint)";
    const fill = isCurrent ? "#1a2230" : known ? "#161d28" : "var(--bg3)";
    const textColor = isCurrent ? "#f0dca8" : known ? "#cfe0f8" : "var(--text-faint)";
    const hopStyle = HOP_STYLE[n.hopKind] || HOP_STYLE.untraceable;
    const whyBadge = n.unconfirmed && n.reason
      ? `<g transform="translate(${w - 11},-9)" style="cursor:help">
           <title>${esc(n.reason)}</title>
           <circle r="8.5" fill="#151c26" stroke="${hopStyle.stroke}" stroke-width="1.2"/>
           <text text-anchor="middle" y="3.4" font-size="11" font-weight="700" fill="${hopStyle.stroke}" style="font-family:var(--font-ui,inherit)">?</text>
         </g>`
      : "";
    const mergeBadge = n.mergedFrom
      ? `<g transform="translate(${w - (n.unconfirmed ? 30 : 11)},-9)" style="cursor:help">
           <title>Merged from ${n.mergedFrom} branches.</title>
           <circle r="8.5" fill="#151c26" stroke="var(--text-dim)" stroke-width="1.2"/>
           <text text-anchor="middle" y="3.4" font-size="9.5" font-weight="700" fill="var(--text-dim)" style="font-family:var(--font-ui,inherit)">${n.mergedFrom}</text>
         </g>`
      : "";
    const clickable = known && n.channelId;
    return `<g class="mf-node${clickable ? " mf-node-click" : ""}"
      ${clickable ? `data-select-channel="${esc(n.channelId)}"` : ""} transform="translate(${x},${y})">
      <rect width="${w}" height="${CARD_H}" rx="9" fill="${fill}" stroke="${border}" stroke-width="1.2" ${known ? "" : 'stroke-dasharray="4,3"'}/>
      <rect width="4" height="${CARD_H}" rx="2" fill="${stripe}"/>
      <foreignObject x="14" y="6" width="${Math.max(40, w - (clickable ? 44 : 20))}" height="36" style="pointer-events:none">
        <div xmlns="http://www.w3.org/1999/xhtml" style="font-family:var(--font-ui,inherit);line-height:1.25">
          <div style="font-size:12.5px;font-weight:${isCurrent ? 700 : 600};color:${textColor};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(n.channelName || n.channelId)}</div>
          <div style="font-size:10.5px;color:var(--text-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(subtitleFor(n))}</div>
        </div>
      </foreignObject>
      ${clickable ? `<g class="mf-node-edit" data-edit="${esc(n.channelId)}" transform="translate(${w - 36},7)">
        <rect width="29" height="15" rx="4" fill="#0f151d" stroke="var(--line-strong)" stroke-width="1"/>
        <text x="14.5" y="11" text-anchor="middle" font-size="9.5" fill="var(--text-dim)" font-family="var(--font-ui,inherit)">edit</text>
      </g>` : ""}
      ${whyBadge}${mergeBadge}
    </g>`;
  }).join("");

  wrap.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <g class="mf-edges">${edgeEls.join("")}</g>
    <g class="mf-nodes">${nodeEls}</g>
  </svg>`;

  if (onSelectChannel) {
    wrap.querySelectorAll("[data-select-channel]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        if (ev.target.closest && ev.target.closest("[data-edit]")) return;
        onSelectChannel(el.getAttribute("data-select-channel"));
      });
    });
  }
}

function register(platform2) {
  // No section: nav-layout puts an item with no section into "Plugins", which
  // is where a third-party extension belongs. Monitor is the shell's own
  // section for built-in operational views.
  platform2.registerNavItem({
    id: "message-flow",
    label: "Message Flow",
    icon: "link",
    path: NAV_PATH,
  });

  platform2.registerView(NAV_PATH, messageFlowViewHandler(platform2), { title: "Message Flow" });

  // Jumps to the nav tab with this channel selected.
  platform2.registerChannelAction({
    id: "view-in-message-flow",
    label: "View in Message Flow",
    icon: "link",
    order: 60,
    onInvoke(channel, ctx) {
      ctx.platform.router.navigate(`${NAV_PATH}?channelId=${encodeURIComponent(channel.id)}`);
    },
  });
}

/* ══════════════════════════════ Nav tab (own channel list) ══════════════ */

function messageFlowViewHandler(platform2) {
  const { ui, api } = platform2;

  return async function handler({ query }) {
    ensureStyles();

    const root = document.createElement("div");
    root.className = "mf-page";

    let mfData = null;
    let mfError = null;
    let codeIndex = null;
    try {
      mfData = await api.get(TOPOLOGY_PATH);
    } catch (e) {
      mfError = e && e.message ? e.message : String(e);
    }
    // Optional: absent, unpermitted or changed means no enrichment, not an error.
    if (mfData) codeIndex = await fetchRouteCalls(api);
    let received = mfData ? await fetchReceivedCounts(api) : null;

    let selected = query && query.channelId ? query.channelId : null;
    if (selected && mfData && !mfData.nodes.some((n) => n.id === selected)) selected = null;

    let traceLoading = false, traceError = null, traceResult = null;
    /* One hop is the default, not a limit. A reader who wants the wider
       neighbourhood can have it, and is told how much wider it gets before
       asking for it. */
    let graphHops = 1;

    const bar = document.createElement("div");
    bar.className = "mf-bar";
    const pane = document.createElement("div");
    pane.className = "mf-pane";
    root.appendChild(bar);
    root.appendChild(pane);

    /* Engine-wide counts belong to the overview. Showing them under a selected
       channel invited the reading that they described that channel. */
    function overviewStats() {
      const n = mfData.nodes.length, e = mfData.edges.length;
      const x = (mfData.externalDestinations || []).length;
      const u = mfData.unconfiguredCount;
      const gaps = mfData.nodes.filter((c) => c.traceGap).length
        + mfData.edges.filter((c) => c.traceable === false).length;
      return [
        `${n} channel${n === 1 ? "" : "s"}`,
        `${e} channel-to-channel route${e === 1 ? "" : "s"}`,
        `${x} external destination${x === 1 ? "" : "s"}`,
        u ? `${u} unconfigured stub${u === 1 ? "" : "s"} hidden` : null,
        gaps ? `<span style="color:var(--warn)">${gaps} cannot be traced</span>` : null,
      ].filter(Boolean).join(" &middot; ");
    }

    function channelStats(id) {
      const inbound = mfData.edges.filter((e) => e.toId === id).length;
      const outbound = mfData.edges.filter((e) => e.fromId === id).length;
      const ext = (mfData.externalDestinations || []).filter((d) => d.channelId === id).length;
      const node = mfData.nodes.find((n) => n.id === id) || {};
      return [
        `${inbound} inbound`,
        `${outbound} outbound`,
        `${ext} external destination${ext === 1 ? "" : "s"}`,
        node.sourceTransport ? esc(node.sourceTransport) : null,
      ].filter(Boolean).join(" &middot; ");
    }

    function renderBar() {
      if (!mfData || !mfData.nodes.length) { bar.innerHTML = ""; return; }
      const options = mfData.nodes.map((n) =>
        `<option value="${esc(n.id)}"${selected === n.id ? " selected" : ""}>${esc(n.name)}</option>`).join("");
      bar.innerHTML = `
        <label for="mfChannelPick">Channel</label>
        <select id="mfChannelPick">
          <option value=""${selected ? "" : " selected"}>All channels (overview)</option>
          ${options}
        </select>
        <div class="mf-bar-stats">${selected ? channelStats(selected) : overviewStats()}</div>`;
      bar.querySelector("#mfChannelPick").addEventListener("change", (ev) => {
        selected = ev.target.value || null;
        traceResult = null; traceError = null;
        renderBar(); renderPane();
      });
    }

    /* Said once, on the overview, and only when the detail is actually missing.
       What it is missing is named, because "install this plugin" is a worse
       message than "these three things are invisible to you right now". */
    function scsNoticeHTML() {
      if (!codeIndex || !codeIndex.unavailable) return "";
      const permission = codeIndex.unavailable === "permission";
      return `<div class="mf-notice mf-notice-warn">
        ${inlineIcon(ui, "warning", 15)}
        <div>
          <div><b>Message Flow needs OIE Source Code Search.</b> ${permission
            ? "It is installed, but this account cannot search with it."
            : `It is a separate, free plugin: <a href="https://github.com/diridium-com/oie-source-code-search" target="_blank" rel="noopener">oie-source-code-search</a>.`}</div>
          <div style="margin-top:5px">Without it the map still draws Channel Writer routing, but everything about script routing is missing: what the call actually says, where in the channel it is written, whether its target is computed rather than fixed, and any routing that lives in a code template. ${permission
            ? "Ask for its search permission."
            : "Install it and reload this page."}</div>
        </div>
      </div>`;
    }

    function renderPane() {
      if (mfError) {
        pane.innerHTML = `<div class="mf-err">${inlineIcon(ui, "warning", 16)}<div>${esc(mfError)}</div></div>`;
        return;
      }
      if (!mfData || !mfData.nodes.length) {
        pane.innerHTML = `<div class="mf-placeholder">No channels found on this engine.</div>`;
        return;
      }
      if (!selected) { renderOverview(); return; }
      renderChannel();
    }

    /* Landing page: everything here is engine-wide. No graph, because there is
       no channel to centre one on, and a whole-engine graph is unreadable past
       a dozen channels. */
    let overviewFilter = null;
    let onlyChannelReaders = false;

    function renderOverview() {
      const c = characterize(mfData, codeIndex);
      const cards = [
        { key: "routes", n: mfData.edges.length, label: "channel-to-channel routes", note: "the full routing list" },
        { key: "noroutein", of: mfData.nodes.length, n: c.entry.length + c.unfed.length, label: "no inbound route found", note: "nothing the map can see routes to these", warn: c.unfed.length > 0 },
        { key: "trace", of: mfData.nodes.length, n: c.gaps.length, label: "cannot be traced", note: "routing that leaves no record of where a message came from", warn: true },
      ].filter((card) => card.n > 0);

      pane.innerHTML = `
        <div class="mf-lead">The shape of this engine. Pick any figure to see which channels it counts, or choose a channel above to open its routing chain.</div>
        ${scsNoticeHTML()}
        <div class="mf-cards">${cards.map((card) => `
          <button class="mf-card${overviewFilter === card.key ? " active" : ""}${card.warn && card.n ? " warn" : ""}" data-filter="${card.key === null ? "" : card.key}">
            <div class="mf-card-n">${card.n}${card.of ? `<span class="mf-card-of"> of ${card.of}</span>` : ""}</div>
            <div class="mf-card-l">${esc(card.label)}</div>
            <div class="mf-card-note">${esc(card.note)}</div>
          </button>`).join("")}</div>
        <div id="mfDetail"></div>`;

      pane.querySelectorAll("[data-filter]").forEach((el) => {
        el.addEventListener("click", () => {
          const k = el.getAttribute("data-filter") || null;
          overviewFilter = overviewFilter === k ? null : k;
          renderOverview();
        });
      });
      renderOverviewDetail(c);
    }

    /* The deep dive. Nothing is removed by the cards; they choose which slice of
       it to show, and with none chosen the whole thing is here as before. */
    /* What this list is worth, said plainly. A Channel Reader can only be fed
       by a route, so one nothing targets is either fed by a route the map
       cannot resolve or never runs. Which of those is more likely is a fact
       about this engine, not a generality, so it is counted rather than
       hedged. */
    /* What is known is narrow: no route into these was found. Whether that
       makes a channel an entry point or an orphan is a judgement about the
       architecture, which belongs to the reader, so the list gives them the
       source connector and the message count and does not decide for them. */
    /* Four separate things, returned separately and labelled where they are
       shown. They were joined with spaces into one paragraph, which on a real
       engine ran to six sentences and about 700 characters of 11.5px text, and
       the note's 80ch cap against a full-width table underneath made that read
       as a narrow left-hand column. Labels because the four are answers to
       different questions, and a reader wanting only the last one should not
       have to read the other three to find it. */
    function noRouteInCaveat(c) {
      const parts = [{
        label: "What was found",
        text: "No Channel Writer destination and no routeMessage call on this engine names these channels as a target.",
      }];

      const computed = codeIndex && codeIndex.unavailable
        ? "Source Code Search is not available, so routes with a computed target cannot be detected at all here."
        : c.computedTargets > 0
          ? `${c.computedTargets} route${c.computedTargets === 1 ? " on this engine builds its" : "s on this engine build their"} target at run time.`
          : "No route on this engine builds its target at run time, so nothing is hidden from the map that way.";
      parts.push({
        label: "What could still reach them",
        text: `A route that builds its target at run time could still be routing to any of them, and the map cannot show that. ${computed}`,
      });

      if (c.unfed.length) {
        parts.push({
          label: "Why the source connector matters",
          text: "Any channel can be routed to whatever its source connector is, so this is not about what can receive. It is that a Channel Reader has no other way in: one here has nothing reaching it at all, while the rest also take messages from outside the engine, so nothing routing to them says little.",
        });
      }

      const fed = received ? [...c.unfed, ...c.entry].filter((n) => (received[n.id] || 0) > 0) : [];
      if (received && fed.length) {
        parts.push({
          label: "What to check next",
          text: `${fed.length} of them ${fed.length === 1 ? "has" : "have"} received messages, so something is reaching ${fed.length === 1 ? "it" : "them"}: trace one of those messages and its ancestors name the source, provided the hop sent the source map.`,
        });
      }
      return parts;
    }

    function renderOverviewDetail(c) {
      const el = pane.querySelector("#mfDetail");
      /* One list drawn here, not two. The trace card opens "Where message
         tracing will fail" below instead, because that table already exists and
         is the right shape: the two ways a trail is lost have different
         remedies, so each row needs its own cause and its own fix. The list
         this used to draw had a single column for both, which meant it could
         only ever name the cause of one of them, and it printed that cause
         under the "Messages received" heading. A storage setting is not a
         count, and it is not a reason a count is missing either: the counts are
         engine statistics, which a channel keeps whatever its storage does. */
      if (overviewFilter === "noroutein") {
        const allRows = [...c.unfed, ...c.entry];
        /* A Channel Reader is the case worth isolating, because only a route
           can feed it, so it gets a filter rather than a list of its own. */
        const rows = onlyChannelReaders
          ? allRows.filter((n) => n.sourceTransport === "Channel Reader")
          : allRows;
        el.innerHTML = `
          <div class="mf-section-title">Channels with no inbound route found</div>
          <div class="mf-note-rows">${noRouteInCaveat(c).map((part) => `
            <div class="mf-note-label">${esc(part.label)}</div>
            <div>${esc(part.text)}</div>`).join("")}</div>
          <label class="mf-check"><input type="checkbox" id="mfOnlyReaders"${onlyChannelReaders ? " checked" : ""}> Channel Readers only <span style="color:var(--text-faint)">(${allRows.filter((n) => n.sourceTransport === "Channel Reader").length} of ${allRows.length})</span></label>
          <table class="mf-table">
            <thead><tr><th>Channel</th><th>Source connector</th><th>${received ? "Messages received" : ""}</th></tr></thead>
            <tbody>${rows.map((n) => `<tr>
              <td>${channelCell(n.id, n.name)}</td>
              <td style="color:var(--text-dim)">${esc(n.sourceTransport || "unknown")}</td>
              <td style="color:${received && (received[n.id] || 0) > 0 ? "var(--warn)" : "var(--text-faint)"}">${received ? String(received[n.id] ?? 0) : ""}</td>
            </tr>`).join("")}</tbody>
          </table>`;
      } else if (overviewFilter === "routes" || overviewFilter === "trace" || overviewFilter === null) {
        el.innerHTML = renderTablesHTML(ui, mfData, null, codeIndex, overviewFilter);
      }

      const box = el.querySelector("#mfOnlyReaders");
      if (box) box.addEventListener("change", () => { onlyChannelReaders = box.checked; renderOverviewDetail(c); });
      wireChannelLinks(el);
    }

    /* What the graph is not showing, and the way to see it. Placed under the graph
   rather than above it because it answers a question the picture raises. */
function hopControlHTML(hops, beyond) {
  if (hops > 1) {
    return `<div class="mf-hops">Showing every channel within ${hops} hops.
      <button type="button" class="mf-hops-btn" data-hops="1">Show direct routes only</button></div>`;
  }
  if (!beyond) return "";
  return `<div class="mf-hops">Direct routes only. ${beyond} more channel${beyond === 1 ? "" : "s"}
    reach${beyond === 1 ? "es" : ""} this one through another channel.
    <button type="button" class="mf-hops-btn" data-hops="2">Show them</button></div>`;
}

/* A note is a list of plain strings, and a channel named in one is still a
   channel the reader may want to open. Rather than build HTML inside prose and
   have to reason about escaping a sentence, each note is escaped whole and then
   the known channel names inside it are replaced with links. Escaping happens
   first and the replacement matches the escaped name, so nothing in a channel
   name can reach the output unescaped however it is spelled. */
function linkifyNote(text, channels) {
  let out = esc(text);
  // Longest first, so "MF_Archive Backup" is not eaten by "MF_Archive".
  [...channels].sort((a, b) => b.name.length - a.name.length).forEach((c) => {
    const needle = esc(c.name);
    if (!needle || needle.length < 3 || !out.includes(needle)) return;
    const link = `<a href="#" class="mf-link" data-open="${esc(c.id)}">${needle}</a>`;
    // Only the first mention: a sentence with the same channel linked four
    // times reads as a list of links rather than as a sentence.
    out = out.replace(needle, link);
  });
  return out;
}

/* Channel names in every table lead somewhere: the name opens that
       channel's routing here, the edit tag opens it in the channel editor.
       Most of what these tables report is fixed by editing the channel, so
       making the reader go and find it by hand was the wrong ending. */
    function wireChannelLinks(container) {
      if (!container) return;
      container.querySelectorAll("[data-open]").forEach((a) => {
        a.addEventListener("click", (ev) => {
          ev.preventDefault();
          selected = a.getAttribute("data-open");
          traceResult = null; traceError = null;
          renderBar(); renderPane();
        });
      });
      container.querySelectorAll("[data-edit]").forEach((a) => {
        a.addEventListener("click", (ev) => {
          ev.preventDefault();
          const id = a.getAttribute("data-edit");
          if (platform2.router && platform2.router.navigate) platform2.router.navigate(`/channels/${id}/edit`);
        });
      });
    }

    function renderChannel() {
      const name = (mfData.nodes.find((n) => n.id === selected) || {}).name || selected;
      pane.innerHTML = `
        <div class="mf-channel-title">${esc(name)}<a href="#" class="mf-edit" data-edit="${esc(selected)}" title="Open this channel in the editor">edit</a></div>
        ${scsNoticeHTML()}
        <div class="mf-graph" id="mfGraphWrap"></div>
        <div id="mfHops"></div>
        ${legendHTML()}
        <div class="mf-trace-box">
          <div class="mf-trace-inputs">
            <label>Trace a message from this channel</label>
            <input id="mfTraceMsgId" type="number" min="1" placeholder="Message ID">
            <button class="mf-trace-btn" id="mfTraceBtn" type="button">Trace</button>
          </div>
          <div class="mf-section-note" style="margin:4px 0 0">Shows this message\u2019s actual path: ancestors from its own Source Map, descendants from a bounded forward scan.</div>
          <div id="mfTraceResult"></div>
        </div>
        <div id="mfTables"></div>`;

      const graphWrap = pane.querySelector("#mfGraphWrap");
      renderFocusSvgInto(graphWrap, ui, mfData, selected, (id) => {
        selected = id; traceResult = null; traceError = null;
        renderBar(); renderPane();
      }, graphHops, codeIndex);
      /* The control is rendered after the graph because only the graph knows how
         many channels were left outside the chosen radius. */
      const hopBox = pane.querySelector("#mfHops");
      if (hopBox) {
        hopBox.innerHTML = hopControlHTML(graphHops, Number(graphWrap.getAttribute("data-beyond") || 0));
        const btn = hopBox.querySelector("[data-hops]");
        if (btn) btn.addEventListener("click", () => {
          graphHops = Number(btn.getAttribute("data-hops"));
          renderPane();
        });
      }
      /* The graph's cards carry the same two actions the tables' channel names
         do, so they are wired by the same function: the name opens the channel
         here, the edit chip opens it in the editor. */
      wireChannelLinks(graphWrap);
      wireLegend(pane);
      pane.querySelector("#mfTraceBtn").addEventListener("click", runTrace);
      pane.querySelector("#mfTraceMsgId").addEventListener("keydown", (ev) => { if (ev.key === "Enter") runTrace(); });
      renderTraceResult();
      const tables = pane.querySelector("#mfTables");
      tables.innerHTML = renderTablesHTML(ui, mfData, selected, codeIndex);
      wireChannelLinks(tables);
    }

    async function runTrace() {
      const input = pane.querySelector("#mfTraceMsgId");
      const messageId = input ? input.value.trim() : "";
      if (!selected || !messageId) {
        traceError = "Enter a message ID.";
        traceResult = null; renderTraceResult(); return;
      }
      traceLoading = true; traceError = null; traceResult = null;
      renderTraceResult();
      try {
        traceResult = await api.get("/extensions/messageFlow/trace", { channelId: selected, messageId });
      } catch (e) {
        traceError = e && e.message ? e.message : String(e);
      }
      traceLoading = false;
      renderTraceResult();
    }

    function renderTraceResult() {
      const el = pane.querySelector("#mfTraceResult");
      if (!el) return;
      if (traceLoading) { el.innerHTML = `<div class="mf-section-note" style="padding:8px 0">Tracing this message\u2026</div>`; return; }
      if (traceError) {
        el.innerHTML = `<div class="mf-err" style="margin-top:10px;margin-bottom:0">${inlineIcon(ui, "warning", 14)}<div>${esc(traceError)}</div></div>`;
        return;
      }
      if (!traceResult) { el.innerHTML = ""; return; }

      /* Reconstructs the real tree (branches and merges) from the flat lists
         the API returns, rather than assuming list order is chain order --
         see buildTraceGraph for why that assumption was wrong. */
      const graph = buildTraceGraph(traceResult, mfData, codeIndex);
      let descendantCount = 0;
      (function count(n) { n.children.forEach((c) => { if (!c.key.startsWith("cont::")) descendantCount++; count(c); }); })(graph.root);

      const notes = [];
      if (graph.degraded) {
        notes.push("This server has not yet been updated to record which specific message each descendant came from, so branches below are shown in scan order rather than their real shape. Rebuild and redeploy message-flow-server with the parentChannelId/parentMessageId patch to see actual branches and merges.");
      }
      if (graph.orphans.length) {
        notes.push(`${graph.orphans.length} descendant${graph.orphans.length === 1 ? "" : "s"} could not be placed in the tree (its parent hop fell outside the scan window) and ${graph.orphans.length === 1 ? "is" : "are"} shown unattached.`);
      }
      // One reason per distinct dead end, not one per branch that hit it --
      // continuations already merge branches sharing a target, so this just
      // reads their reasons back out in the same de-duplicated form.
      const seenReasons = new Set();
      graph.continuations.forEach((c) => {
        if (seenReasons.has(c.reason)) return;
        seenReasons.add(c.reason);
        notes.push(c.reason);
      });
      if (!graph.continuations.length && descendantCount === 0) {
        notes.push("No descendants found. The message may not have been routed onward yet, a downstream message may have been pruned, or a downstream channel may not store maps.");
      }
      if (traceResult.ancestors.length === 0) {
        notes.push("No ancestors recorded. Either this is where the message entered the engine, or it arrived by a router.routeMessage call, which does not send the source map to the downstream channel unless it goes through the Route with Sources code template.");
      }
      if (traceResult.truncated) {
        notes.push("The scan hit its ceiling, so this tree may be incomplete. Trace a message further along to see past this point.");
      }
      if (traceResult.scanErrors) {
        notes.push(`${traceResult.scanErrors} message lookup${traceResult.scanErrors === 1 ? "" : "s"} failed during the scan and were skipped.`);
      }
      const totalNodesShown = graph.ancestors.length + 1 + descendantCount + graph.continuations.length;
      if (totalNodesShown > MAX_RENDERED_HOPS) {
        // The old chain view windowed itself around the traced message when a
        // trace ran long. Windowing a branching tree needs to decide which
        // whole branches to drop, not just which hops -- worth its own pass
        // rather than folding in here; for now this says the picture may be
        // large rather than silently narrowing it.
        notes.push(`${totalNodesShown} nodes in this tree. A trace this wide or deep usually means a fan-out with many destinations, or a loop -- scroll the graph horizontally if it runs past the edge.`);
      }
      const note = notes.length
        ? `<div class="mf-section-note" style="margin-top:6px">${notes.map((t) => linkifyNote(t, mfData.nodes)).join("<br>")}</div>`
        : "";
      el.innerHTML = `<div class="mf-graph" id="mfTraceGraph" style="margin-top:10px;margin-bottom:0"></div>${note}`;
      const graphWrapEl = el.querySelector("#mfTraceGraph");
      renderTraceGraphSvg(graphWrapEl, ui, graph, (id) => {
        selected = id; traceResult = null; traceError = null;
        renderBar(); renderPane();
      });
      // The graph's edit chips, and the channel names now linked in the notes
      // beneath it, use the same wiring as every other channel name.
      wireChannelLinks(graphWrapEl);
      wireChannelLinks(el);
    }

    renderBar();
    renderPane();

    // /message-flow?channelId=X&messageId=Y&autoTrace=true lands on a result.
    if (query && query.messageId && selected) {
      const input = pane.querySelector("#mfTraceMsgId");
      if (input) input.value = query.messageId;
      if (query.autoTrace) runTrace();
    }

    return root;
  };
}

export { register };
