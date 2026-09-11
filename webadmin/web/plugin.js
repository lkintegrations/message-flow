// webadmin/web/plugin.js
//
// Message Flow, folded into Web Support as a real plugin panel instead of
// its earlier standalone form. This is the SAME routing-graph logic (ported
// originally from Mirth DB Explorer's Topology tab, then to a compiled
// engine plugin reading channels via ChannelController + ObjectXMLSerializer
// server-side) -- only the client half changed here: instead of its own
// page (a separately-deployed static WAR, requiring its own login/session),
// it registers directly into the already-authenticated Web Support shell,
// using the shell's own platform.api (which already attaches the
// X-Requested-With header the engine's /api layer requires -- the exact
// thing a standalone page could never do for a plain browser navigation).
//
// Three entry points, given the platform has no per-message action hook
// (checked core/platform.js's full registry list and the compiled Messages
// view bundle directly -- there is no message-scoped extension point):
//   1. registerNavItem + registerView   -- a full "Message Flow" tab with
//      its own channel list, under Monitor.
//   2. registerChannelAction            -- "View in Message Flow" on a
//      channel's right-click menu in the Channels view; jumps to (1) with
//      that channel pre-selected.
//   3. registerChannelTab               -- a "Message Flow" tab inside the
//      channel editor itself, showing that channel's focused chain inline
//      wherever you already navigate per-channel.
//
// Server-side REST surface is unchanged: GET /api/extensions/messageFlow/topology
// (see MessageFlowServletInterface/MessageFlowServlet in this same package).

import { platform } from "@oie/web-shell";

const TOPOLOGY_PATH = "/extensions/messageFlow/topology";
const NAV_PATH = "/message-flow";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Same connector-type -> icon idea as the standalone version's tabler-icons
// mapping, just pointed at the host's own built-in icon set (core/icons.js)
// instead of a CDN icon font, so the graph visually matches the rest of the
// app. inlineIcon() falls back to a generic icon for anything not in this
// map (or not in the host's set) rather than throwing.
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

// platform.ui (core/ui.js) only re-exports icon(name, size) -- returning a
// real SVG DOM element, matching the host's own icon styling exactly -- not
// iconPath(name) (that's a separate export in core/icons.js that ui.js
// never re-exports). Build the element, optionally add a style, and
// serialize it, since the rest of this module is HTML-string-based rather
// than DOM-node-based.
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
  // Deliberately NOT redeclaring --bg0/--accent/etc: this runs inside the
  // shell's own page, so the shell's real theme tokens are already on
  // :root. Only component-specific classes live here.
  style.textContent = `
.mf-shell{display:flex;min-height:0;height:100%}
.mf-rail{width:230px;min-width:230px;border-right:1px solid var(--line);display:flex;flex-direction:column;overflow:hidden}
.mf-rail-label{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-faint);padding:12px 14px 8px;flex-shrink:0}
.mf-rail-list{overflow-y:auto;flex:1;padding:0 8px 12px}
.mf-rail-item{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:7px;cursor:pointer;color:var(--text-dim);font-size:13px;transition:background .1s,color .1s;margin-bottom:1px}
.mf-rail-item:hover{background:var(--bg2);color:var(--text)}
.mf-rail-item.active{background:var(--accent-glow);color:var(--text)}
.mf-rail-item svg{flex-shrink:0;color:var(--text-faint)}
.mf-rail-item.active svg{color:var(--accent)}
.mf-rail-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mf-pane{flex:1;min-width:0;overflow-y:auto;padding:16px 18px}
.mf-tab-pane{padding:0 2px}
.mf-placeholder{margin:auto;color:var(--text-faint);text-align:center;padding:40px;font-size:13.5px}
.mf-err{background:#2a1414;border:1px solid #5a2a2a;color:#ffb0b0;border-radius:var(--radius);padding:12px 14px;font-size:13px;margin-bottom:14px;display:flex;align-items:flex-start;gap:10px}
.mf-summary{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;font-size:12.5px;color:var(--text-dim)}
.mf-legend{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:14px;font-size:11.5px;color:var(--text-dim)}
.mf-legend span{display:inline-flex;align-items:center}
.mf-legend-line{display:inline-block;width:16px;height:2px;vertical-align:middle;margin-right:6px}
.mf-legend-dot{display:inline-block;width:9px;height:9px;border-radius:50%;vertical-align:middle;margin-right:6px}
.mf-graph{border:1px solid var(--line);border-radius:var(--radius);background:var(--bg1);overflow:auto;margin-bottom:14px;min-height:200px}
table.mf-table{width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:22px}
table.mf-table th{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line-strong);color:var(--text-faint);font-size:10.5px;text-transform:uppercase;letter-spacing:.04em}
table.mf-table td{padding:6px 10px;border-bottom:1px solid var(--line)}
.mf-section-title{font-weight:700;font-size:13px;margin-bottom:7px;color:var(--text)}
.mf-trace-box{border:1px solid var(--line);border-radius:var(--radius);background:var(--bg1);padding:12px 14px;margin-bottom:18px}
.mf-trace-inputs{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px}
.mf-trace-inputs label{font-size:11.5px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em;margin-right:4px}
.mf-trace-inputs select,.mf-trace-inputs input{background:var(--bg2);border:1px solid var(--line-strong);color:var(--text);border-radius:6px;padding:5px 8px;font-size:12.5px}
.mf-trace-inputs input[type=number]{width:100px}
.mf-trace-btn{background:var(--accent);color:var(--accent-ink);border:1px solid var(--accent-press);border-radius:6px;padding:5px 12px;font-size:12.5px;font-weight:600;cursor:pointer}
.mf-trace-btn:hover{background:var(--accent-press)}
`;
  document.head.appendChild(style);
}

/* BFS outward from the selected channel in both directions -- unchanged
   from the standalone version. */
function computeFocus(selectedId, edges) {
  const downstreamAdj = {}, upstreamAdj = {};
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
  return { levelOf, nodeIds, relevantEdges };
}

function estimateLabelWidth(charCount) {
  return Math.min(240, Math.max(120, charCount * 6.6 + 28));
}

/* Renders the focused upstream/downstream chain SVG for `selectedId` into
   `wrap` (an already-mounted element). onSelectChannel(id) fires when the
   user clicks another known channel node in the graph -- callers decide
   what that means (switch the nav tab's selection, or just re-focus locally
   within a channel-editor tab). Shared between the nav-tab view and the
   channel-editor tab so there is exactly one copy of this logic. */
function renderFocusSvgInto(wrap, ui, mfData, selectedId, onSelectChannel) {
  if (!wrap || !mfData) return;
  const idToName = {}, nodesById = {};
  mfData.nodes.forEach((n) => { idToName[n.id] = n.name; nodesById[n.id] = n; });
  mfData.edges.forEach((e) => { if (e.toId && !idToName[e.toId]) idToName[e.toId] = e.toName || "(unknown channel)"; });

  const { levelOf, nodeIds, relevantEdges } = computeFocus(selectedId, mfData.edges);

  const extNodesById = {};
  const extEdges = [];
  nodeIds.forEach((id) => {
    (mfData.externalDestinations || []).filter((d) => d.channelId === id).forEach((d, i) => {
      const extId = `ext::${id}::${i}`;
      extNodesById[extId] = { label: d.destName, transportName: d.transportName, enabled: d.enabled, ownerId: id };
      extEdges.push({ fromId: id, toId: extId, enabled: d.enabled, destName: d.destName });
    });
  });
  const allNodeIds = new Set([...nodeIds, ...Object.keys(extNodesById)]);

  if (allNodeIds.size <= 1) {
    wrap.innerHTML = `<div class="mf-placeholder">This channel has no channel-to-channel routing and no external destinations configured.</div>`;
    return;
  }

  const combinedLevelOf = { ...levelOf };
  Object.entries(extNodesById).forEach(([extId, n]) => { combinedLevelOf[extId] = (levelOf[n.ownerId] || 0) + 1; });

  const byLevel = {};
  allNodeIds.forEach((id) => { (byLevel[combinedLevelOf[id]] ??= []).push(id); });
  const levels = Object.keys(byLevel).map(Number).sort((a, b) => a - b);
  const nodeR = 22, extR = 15;

  const labelWidths = {};
  allNodeIds.forEach((id) => {
    const isExt = !!extNodesById[id];
    const name = isExt ? extNodesById[id].label : (idToName[id] || id);
    const subtitle = isExt ? extNodesById[id].transportName : (nodesById[id]?.sourceTransport || "unknown/deleted channel");
    const statusText = isExt && extNodesById[id].enabled === false ? "Disabled" : "";
    const effectiveLabelLen = Math.ceil(String(name).length * 0.6);
    const longest = Math.max(effectiveLabelLen, String(subtitle || "").length, String(statusText || "").length);
    labelWidths[id] = estimateLabelWidth(longest);
  });
  const maxLabelWidth = Math.max(120, ...Object.values(labelWidths));
  const colGap = Math.max(230, maxLabelWidth + 50), rowGap = 128;

  const maxRows = Math.max(...levels.map((l) => byLevel[l].length));
  const width = Math.max(560, levels.length * colGap + 100);
  const height = Math.max(240, maxRows * rowGap + 70);

  const pos = {};
  levels.forEach((lvl, colIdx) => {
    const ids = byLevel[lvl];
    const colX = 70 + colIdx * colGap;
    const totalH = ids.length * rowGap;
    const startY = (height - totalH) / 2 + rowGap / 2;
    ids.forEach((id, rowIdx) => { pos[id] = { x: colX, y: startY + rowIdx * rowGap }; });
  });
  const selPos = pos[selectedId];

  const edgeLines = relevantEdges.map((e) => {
    const a = pos[e.fromId], b = pos[e.toId];
    if (!a || !b) return "";
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const pad = nodeR + 5;
    const x1 = a.x + (dx / len) * pad, y1 = a.y + (dy / len) * pad;
    const x2 = b.x - (dx / len) * pad, y2 = b.y - (dy / len) * pad;
    const color = e.viaScript ? "var(--blue)" : (e.enabled === false ? "var(--text-faint)" : "var(--violet)");
    const dash = e.viaScript ? 'stroke-dasharray="2,3"' : (e.enabled === false ? 'stroke-dasharray="4,3"' : "");
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2" stroke-linecap="round" ${dash} filter="url(#mfLineGlow)" marker-end="url(#mfArrow)"><title>${esc(idToName[e.fromId] || "")} \u2192 ${esc(idToName[e.toId] || e.destName)} via ${esc(e.destName)}${e.viaScript ? " (script \u2014 may be conditional)" : ""}</title></line>`;
  }).join("");

  const extEdgeLines = extEdges.map((e) => {
    const a = pos[e.fromId], b = pos[e.toId];
    if (!a || !b) return "";
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const x1 = a.x + (dx / len) * (nodeR + 5), y1 = a.y + (dy / len) * (nodeR + 5);
    const x2 = b.x - (dx / len) * (extR + 5), y2 = b.y - (dy / len) * (extR + 5);
    const color = e.enabled === false ? "var(--text-faint)" : "#5a8fa8";
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="1,3" opacity="${e.enabled === false ? 0.5 : 0.85}"><title>${esc(idToName[e.fromId] || "")} \u2192 ${esc(e.destName)} (leaves the engine)</title></line>`;
  }).join("");

  function nodeCard(id, p, name, subtitle, statusText, statusColor, textColor, isSelected, r) {
    const w = labelWidths[id];
    return `<foreignObject x="${p.x - w / 2}" y="${p.y + r + 4}" width="${w}" height="70" style="pointer-events:none">
      <div xmlns="http://www.w3.org/1999/xhtml" style="font-family:var(--font-ui,inherit);font-size:11.5px;text-align:center;background:rgba(12,17,22,.72);border-radius:9px;padding:4px 8px;backdrop-filter:blur(2px)">
        <div style="font-weight:${isSelected ? 700 : 600};color:${textColor};display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.25" title="${esc(name)}">${esc(name)}</div>
        ${subtitle ? `<div style="color:var(--text-faint);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px" title="${esc(subtitle)}">${esc(subtitle)}</div>` : ""}
        ${statusText ? `<div style="color:${statusColor};font-size:11px;font-weight:600;margin-top:1px">${esc(statusText)}</div>` : ""}
      </div>
    </foreignObject>`;
  }

  const nodeEls = [...nodeIds].map((id) => {
    const p = pos[id];
    if (!p) return "";
    const isSelected = id === selectedId;
    const node = nodesById[id];
    const known = !!node;
    const grad = isSelected ? "url(#mfGradSelected)" : (known ? "url(#mfGradKnown)" : "url(#mfGradUnknown)");
    const stroke = isSelected ? "#e8c874" : (known ? "#6f8fd9" : "var(--text-faint)");
    const haloColor = isSelected ? "#d4a656" : (known ? "#4a6fc9" : "#3a4250");
    const textColor = isSelected ? "#f0dca8" : (known ? "#bcd3f7" : "var(--text-faint)");
    const dash = known ? "" : 'stroke-dasharray="3,3"';
    const iconName = known ? iconNameForTransport(node.sourceTransport) : "info";
    const clickable = known && !isSelected;
    const subtitle = known ? node.sourceTransport : "unknown/deleted channel";
    return `<g style="cursor:${clickable ? "pointer" : "default"}" ${clickable ? `data-select-channel="${esc(id)}"` : ""}>
      <circle cx="${p.x}" cy="${p.y}" r="${nodeR * 1.7}" fill="${haloColor}" opacity="0.18" filter="url(#mfNodeGlow)"/>
      <circle cx="${p.x}" cy="${p.y}" r="${nodeR}" fill="${grad}" stroke="${stroke}" stroke-width="1.5" ${dash}/>
      <foreignObject x="${p.x - 9}" y="${p.y - 9}" width="18" height="18" style="pointer-events:none">
        <div xmlns="http://www.w3.org/1999/xhtml" style="width:18px;height:18px;display:flex;align-items:center;justify-content:center;color:#fff">
          ${inlineIcon(ui, iconName, 13, "filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))")}
        </div>
      </foreignObject>
      ${nodeCard(id, p, idToName[id] || id, subtitle, "", "", textColor, isSelected, nodeR)}
    </g>`;
  }).join("");

  const extNodeEls = Object.entries(extNodesById).map(([id, n]) => {
    const p = pos[id];
    if (!p) return "";
    const iconName = iconNameForTransport(n.transportName);
    const muted = n.enabled === false;
    const ownerClickable = n.ownerId && n.ownerId !== selectedId;
    const ownerName = idToName[n.ownerId] || n.ownerId;
    return `<g style="cursor:${ownerClickable ? "pointer" : "default"}" ${ownerClickable ? `data-select-channel="${esc(n.ownerId)}"` : ""}>
      ${ownerClickable ? `<title>Click to view ${esc(ownerName)}'s full upstream/downstream chain</title>` : ""}
      <circle cx="${p.x}" cy="${p.y}" r="${extR}" fill="#233240" stroke="${muted ? "var(--text-faint)" : "#5a8fa8"}" stroke-width="1.3" stroke-dasharray="2,2" opacity="${muted ? 0.5 : 1}"/>
      <foreignObject x="${p.x - 7}" y="${p.y - 7}" width="14" height="14" style="pointer-events:none">
        <div xmlns="http://www.w3.org/1999/xhtml" style="width:14px;height:14px;display:flex;align-items:center;justify-content:center;color:${muted ? "var(--text-faint)" : "#a8d4e8"}">
          ${inlineIcon(ui, iconName, 10)}
        </div>
      </foreignObject>
      ${nodeCard(id, p, n.label, n.transportName, muted ? "Disabled" : "", muted ? "var(--text-faint)" : "var(--warn)", muted ? "var(--text-faint)" : "#a8d4e8", false, extR)}
    </g>`;
  }).join("");

  wrap.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <radialGradient id="mfGradKnown" cx="35%" cy="30%" r="70%"><stop offset="0%" stop-color="#a8c4f5"/><stop offset="55%" stop-color="#6f8fd9"/><stop offset="100%" stop-color="#3f5ba8"/></radialGradient>
      <radialGradient id="mfGradSelected" cx="35%" cy="30%" r="70%"><stop offset="0%" stop-color="#f5e2ae"/><stop offset="55%" stop-color="#d4a656"/><stop offset="100%" stop-color="#9b7532"/></radialGradient>
      <radialGradient id="mfGradUnknown" cx="35%" cy="30%" r="70%"><stop offset="0%" stop-color="#4a5460"/><stop offset="100%" stop-color="#242c36"/></radialGradient>
      <filter id="mfNodeGlow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="6"/></filter>
      <filter id="mfLineGlow" filterUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><feGaussianBlur stdDeviation="1.1" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <marker id="mfArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#b18cff"/></marker>
    </defs>
    ${selPos ? `<circle cx="${selPos.x}" cy="${selPos.y}" r="${Math.max(width, height) * 0.5}" fill="url(#mfGradKnown)" opacity="0.05"/>` : ""}
    ${nodeEls}
    ${extNodeEls}
    ${edgeLines}
    ${extEdgeLines}
  </svg>`;

  wrap.querySelectorAll("[data-select-channel]").forEach((el) => {
    el.addEventListener("click", () => onSelectChannel(el.getAttribute("data-select-channel")));
  });
}

/* Pure: returns the routing-table HTML for the full graph. Same content
   regardless of which channel (if any) is focused, so it's shared as-is. */
function renderTablesHTML(ui, mfData) {
  const { edges, externalDestinations } = mfData;
  const edgeRows = edges.length
    ? edges.map((e) => {
        const toLabel = e.toName
          ? (e.viaScript && !e.toId ? esc(e.toName) + ' <span style="color:var(--warn);font-size:11px">(name not found among known channels)</span>' : esc(e.toName))
          : "(unknown channel \u2014 id: " + esc(e.toId || "?") + ")";
        const statusCell = e.enabled === null
          ? '<span style="color:var(--blue)">script \u2014 may be conditional</span>'
          : (e.enabled === false ? '<span style="color:var(--text-faint)">disabled</span>' : '<span style="color:var(--ok)">enabled</span>');
        return `<tr>
        <td>${esc(e.fromName)}</td>
        <td style="color:${e.viaScript ? "var(--blue)" : "var(--violet)"}">\u2192</td>
        <td>${toLabel}</td>
        <td style="color:var(--text-faint);font-family:var(--font-mono,monospace);font-size:11.5px">${esc(e.destName)}</td>
        <td>${statusCell}</td>
      </tr>`;
      }).join("")
    : `<tr><td colspan="5" style="color:var(--text-faint)">No channel-to-channel routing found.</td></tr>`;

  const byChannel = {};
  externalDestinations.forEach((d) => { (byChannel[d.channelName] ??= []).push(d); });
  const extRows = Object.keys(byChannel).length
    ? Object.entries(byChannel).map(([chName, dests]) => `<tr>
        <td style="vertical-align:top;font-weight:600">${esc(chName)}</td>
        <td>
          ${dests.map((d) => `<div style="margin-bottom:2px">${iconForTransportCell(ui, d.transportName)}${esc(d.destName)} <span style="color:var(--text-faint);font-family:var(--font-mono,monospace);font-size:11px">(${esc(d.transportName)})</span>${d.enabled === false ? ' <span style="color:var(--text-faint)">\u2014 disabled</span>' : ""}${d.dynamicRouting ? ' <span style="color:var(--warn)">\u2014 dynamic routing, target unresolved</span>' : ""}</div>`).join("")}
        </td>
      </tr>`).join("")
    : `<tr><td colspan="2" style="color:var(--text-faint)">No external destinations found.</td></tr>`;

  return `
    <div class="mf-section-title">Channel &rarr; channel routing</div>
    <table class="mf-table">
      <thead><tr><th>From</th><th></th><th>To</th><th>Via destination</th><th>Status</th></tr></thead>
      <tbody>${edgeRows}</tbody>
    </table>
    <div class="mf-section-title">External destinations (where data leaves the engine)</div>
    <table class="mf-table">
      <thead><tr><th>Channel</th><th>Destinations</th></tr></thead>
      <tbody>${extRows}</tbody>
    </table>`;
}

/* Renders a linear ancestor -> current -> descendant chain using the same
   visual language as renderFocusSvgInto's graph (gradient-filled circles,
   glow, inline icons, foreignObject name/status cards) rather than plain
   boxes, per request. A dedicated renderer rather than reusing
   renderFocusSvgInto directly: that one lays out an arbitrary graph via
   BFS levels, which is overkill (and the wrong shape) for what's always a
   single straight line here. Uses its own element ids (mfT* instead of
   mf*) since a trace chain and the topology graph can both be on the page
   at once -- reusing the same <defs> ids would collide (SVG gradient/
   filter/marker ids are document-scoped, not per-<svg>-scoped). */
function renderTraceChainSvg(wrap, ui, chain, currentIndex) {
  if (!wrap || !chain.length) {
    wrap.innerHTML = "";
    return;
  }
  const nodeR = 22;
  const colGap = 190;
  const width = Math.max(320, chain.length * colGap + 60);
  const height = 150;
  const y = 62;

  const labelWidths = chain.map((n) => {
    const name = n.channelName || n.channelId;
    const sub = n.notFound ? "not found" : (n.lookupError ? "lookup failed" : `#${n.messageId}`);
    const effectiveLabelLen = Math.ceil(String(name).length * 0.6);
    return estimateLabelWidth(Math.max(effectiveLabelLen, sub.length));
  });

  function nodeCard(w, name, subtitle, textColor, isCurrent) {
    return `<foreignObject x="${-w / 2}" y="${nodeR + 4}" width="${w}" height="60" style="pointer-events:none">
      <div xmlns="http://www.w3.org/1999/xhtml" style="font-family:var(--font-ui,inherit);font-size:11.5px;text-align:center;background:rgba(12,17,22,.72);border-radius:9px;padding:4px 8px;backdrop-filter:blur(2px)">
        <div style="font-weight:${isCurrent ? 700 : 600};color:${textColor};white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(name)}">${esc(name)}</div>
        ${subtitle ? `<div style="color:var(--text-faint);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px">${esc(subtitle)}</div>` : ""}
      </div>
    </foreignObject>`;
  }

  const nodeEls = chain.map((n, i) => {
    const cx = 40 + i * colGap + nodeR;
    const isCurrent = i === currentIndex;
    const known = !n.notFound && !n.lookupError;
    const grad = isCurrent ? "url(#mfTGradSelected)" : (known ? "url(#mfTGradKnown)" : "url(#mfTGradUnknown)");
    const stroke = isCurrent ? "#e8c874" : (known ? "#6f8fd9" : "var(--text-faint)");
    const haloColor = isCurrent ? "#d4a656" : (known ? "#4a6fc9" : "#3a4250");
    const textColor = isCurrent ? "#f0dca8" : (known ? "#bcd3f7" : "var(--text-faint)");
    const dash = known ? "" : 'stroke-dasharray="3,3"';
    const iconName = known ? iconNameForTransport(n.sourceTransport) : "warning";
    const subtitle = n.notFound ? "not found" : (n.lookupError ? "lookup failed" : `#${n.messageId} \u00b7 ${n.status || "\u2014"}`);
    return `<g transform="translate(${cx},${y})">
      <circle r="${nodeR * 1.7}" fill="${haloColor}" opacity="0.18" filter="url(#mfTNodeGlow)"/>
      <circle r="${nodeR}" fill="${grad}" stroke="${stroke}" stroke-width="1.5" ${dash}/>
      <foreignObject x="-9" y="-9" width="18" height="18" style="pointer-events:none">
        <div xmlns="http://www.w3.org/1999/xhtml" style="width:18px;height:18px;display:flex;align-items:center;justify-content:center;color:#fff">
          ${inlineIcon(ui, iconName, 13, "filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))")}
        </div>
      </foreignObject>
      ${nodeCard(labelWidths[i], n.channelName || n.channelId, subtitle, textColor, isCurrent)}
    </g>`;
  }).join("");

  const lineEls = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const x1 = 40 + i * colGap + nodeR * 2 + 5;
    const x2 = 40 + (i + 1) * colGap - 5;
    lineEls.push(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="var(--violet)" stroke-width="2" stroke-linecap="round" filter="url(#mfTLineGlow)" marker-end="url(#mfTArrow)"/>`);
  }

  wrap.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <radialGradient id="mfTGradKnown" cx="35%" cy="30%" r="70%"><stop offset="0%" stop-color="#a8c4f5"/><stop offset="55%" stop-color="#6f8fd9"/><stop offset="100%" stop-color="#3f5ba8"/></radialGradient>
      <radialGradient id="mfTGradSelected" cx="35%" cy="30%" r="70%"><stop offset="0%" stop-color="#f5e2ae"/><stop offset="55%" stop-color="#d4a656"/><stop offset="100%" stop-color="#9b7532"/></radialGradient>
      <radialGradient id="mfTGradUnknown" cx="35%" cy="30%" r="70%"><stop offset="0%" stop-color="#4a5460"/><stop offset="100%" stop-color="#242c36"/></radialGradient>
      <filter id="mfTNodeGlow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="6"/></filter>
      <filter id="mfTLineGlow" filterUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><feGaussianBlur stdDeviation="1.1" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <marker id="mfTArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#b18cff"/></marker>
    </defs>
    ${lineEls.join("")}
    ${nodeEls}
  </svg>`;
}

function register(platform2) {
  platform2.registerNavItem({
    id: "message-flow",
    label: "Message Flow",
    icon: "link",
    section: "Monitor",
    order: 15,
    path: NAV_PATH,
  });

  platform2.registerView(NAV_PATH, messageFlowViewHandler(platform2), { title: "Message Flow" });

  // Closest available entry point given the platform has no per-message
  // action hook -- jumps to the tab with this channel pre-selected.
  platform2.registerChannelAction({
    id: "view-in-message-flow",
    label: "View in Message Flow",
    icon: "link",
    order: 60,
    onInvoke(channel, ctx) {
      ctx.platform.router.navigate(`${NAV_PATH}?channelId=${encodeURIComponent(channel.id)}`);
    },
  });

  // A tab inside the channel editor itself -- reached wherever you already
  // navigate per-channel, unlike the two entry points above.
  platform2.registerChannelTab({
    id: "message-flow",
    label: "Message Flow",
    order: 50,
    component: channelTabComponent(platform2),
  });
}

/* ══════════════════════════════ Nav tab (own channel list) ══════════════ */

function messageFlowViewHandler(platform2) {
  const { ui, api } = platform2;

  return async function handler({ query }) {
    ensureStyles();

    const root = document.createElement("div");
    root.className = "mf-shell";

    let mfData = null;
    let mfError = null;
    try {
      mfData = await api.get(TOPOLOGY_PATH);
    } catch (e) {
      mfError = e && e.message ? e.message : String(e);
    }

    let mfSelected = query && query.channelId ? query.channelId : null;
    if (mfSelected && mfData && !mfData.nodes.some((n) => n.id === mfSelected)) {
      mfSelected = null; // ignore a channelId that doesn't exist in the graph
    }

    const rail = document.createElement("div");
    rail.className = "mf-rail";
    const pane = document.createElement("div");
    pane.className = "mf-pane";
    root.appendChild(rail);
    root.appendChild(pane);

    function renderRail() {
      if (!mfData || !mfData.nodes.length) {
        rail.innerHTML = `<div class="mf-rail-label">Channels</div><div class="mf-placeholder" style="padding:14px;margin:0">No channels yet.</div>`;
        return;
      }
      const items = mfData.nodes.map((n) => {
        const active = mfSelected === n.id;
        return `<div class="mf-rail-item${active ? " active" : ""}" data-channel-id="${esc(n.id)}">
          ${inlineIcon(ui, iconNameForTransport(n.sourceTransport), 15)}<span title="${esc(n.name)}">${esc(n.name)}</span>
        </div>`;
      }).join("");
      rail.innerHTML = `<div class="mf-rail-label">Channels (${mfData.nodes.length})</div><div class="mf-rail-list">${items}</div>`;
      rail.querySelectorAll("[data-channel-id]").forEach((el) => {
        el.addEventListener("click", () => {
          mfSelected = el.getAttribute("data-channel-id");
          traceResult = null; // a trace from a different channel/message shouldn't linger
          traceError = null;
          renderRail();
          renderPane();
        });
      });
    }

    let traceLoading = false;
    let traceError = null;
    let traceResult = null;

    function renderPane() {
      if (mfError) {
        pane.innerHTML = `<div class="mf-err">${inlineIcon(ui, "warning", 16)}<div>${esc(mfError)}</div></div>
          <div class="mf-placeholder" style="text-align:left;padding:14px;margin:0">Try refreshing this tab. If this persists, check the server log for "Message Flow".</div>`;
        return;
      }
      if (!mfData || !mfData.nodes.length) {
        pane.innerHTML = `<div class="mf-placeholder">No channels found on this engine.</div>`;
        return;
      }

      const channelOptions = mfData.nodes.map((n) => `<option value="${esc(n.id)}"${mfSelected === n.id ? " selected" : ""}>${esc(n.name)}</option>`).join("");

      pane.innerHTML = `
        <div class="mf-trace-box">
          <div class="mf-trace-inputs">
            <label>Trace a message</label>
            <select id="mfTraceChannel">${channelOptions}</select>
            <input id="mfTraceMsgId" type="number" min="1" placeholder="Message ID">
            <button class="mf-trace-btn" id="mfTraceBtn" type="button">Trace</button>
          </div>
          <div style="font-size:11px;color:var(--text-faint)">Shows this message's actual runtime path (ancestors read from its own Source Map, descendants via a bounded forward scan) -- not just what's configured to be possible.</div>
          <div id="mfTraceResult"></div>
        </div>
        <div class="mf-summary">${mfData.nodes.length} channels &middot; ${mfData.edges.length} channel-to-channel routes &middot; ${mfData.externalDestinations.length} external destinations${mfData.unconfiguredCount ? ` &middot; ${mfData.unconfiguredCount} unconfigured stub destination${mfData.unconfiguredCount !== 1 ? "s" : ""} hidden` : ""}</div>
        ${mfSelected ? `
          <div class="mf-graph" id="mfGraphWrap"></div>
          <div class="mf-legend">
            <span><span class="mf-legend-line" style="background:var(--violet)"></span>Channel Writer route</span>
            <span><span class="mf-legend-line" style="background:var(--blue);background-image:linear-gradient(90deg,var(--blue) 60%,transparent 40%);background-size:6px 2px"></span>Script route (router.routeMessage)</span>
            <span><span class="mf-legend-line" style="background:var(--text-faint);background-image:linear-gradient(90deg,var(--text-faint) 55%,transparent 45%);background-size:8px 2px"></span>Disabled</span>
            <span><span class="mf-legend-dot" style="background:var(--bg3);border:1.5px dashed var(--text-faint)"></span>Unknown/deleted channel</span>
            <span><span class="mf-legend-dot" style="background:#233240;border:1.3px dashed #5a8fa8"></span>External destination (leaves the engine)</span>
          </div>` : `<div class="mf-placeholder" style="text-align:left;padding:14px;margin:0 0 16px">Click a channel on the left (or use "View in Message Flow" from a channel's right-click menu in the Channels view, or the Message Flow tab in the channel editor) to see its full upstream/downstream chain.</div>`}
        <div id="mfTables"></div>
      `;

      pane.querySelector("#mfTraceBtn").addEventListener("click", runTrace);
      pane.querySelector("#mfTraceMsgId").addEventListener("keydown", (ev) => { if (ev.key === "Enter") runTrace(); });
      renderTraceResult();

      if (mfSelected) {
        renderFocusSvgInto(pane.querySelector("#mfGraphWrap"), ui, mfData, mfSelected, (id) => {
          mfSelected = id;
          traceResult = null; // same reasoning as the rail click handler above
          traceError = null;
          renderRail();
          renderPane();
        });
      }
      pane.querySelector("#mfTables").innerHTML = renderTablesHTML(ui, mfData);
    }

    async function runTrace() {
      const channelSel = pane.querySelector("#mfTraceChannel");
      const msgInput = pane.querySelector("#mfTraceMsgId");
      const channelId = channelSel ? channelSel.value : null;
      const messageId = msgInput ? msgInput.value.trim() : "";
      if (!channelId || !messageId) {
        traceError = "Pick a channel and enter a message ID.";
        traceResult = null;
        renderTraceResult();
        return;
      }
      traceLoading = true;
      traceError = null;
      traceResult = null;
      renderTraceResult();
      try {
        traceResult = await api.get("/extensions/messageFlow/trace", { channelId, messageId });
      } catch (e) {
        traceError = e && e.message ? e.message : String(e);
      }
      traceLoading = false;
      renderTraceResult();
    }

    function renderTraceResult() {
      const el = pane.querySelector("#mfTraceResult");
      if (!el) return;
      if (traceLoading) {
        el.innerHTML = `<div style="padding:8px 0;color:var(--text-dim);font-size:12.5px">Tracing...</div>`;
        return;
      }
      if (traceError) {
        el.innerHTML = `<div class="mf-err" style="margin-top:10px;margin-bottom:0">${inlineIcon(ui, "warning", 14)}<div>${esc(traceError)}</div></div>`;
        return;
      }
      if (!traceResult) {
        el.innerHTML = "";
        return;
      }
      const current = { channelId: traceResult.channelId, channelName: traceResult.channelName, messageId: traceResult.messageId };
      const chain = [...traceResult.ancestors, current, ...traceResult.descendants];
      // Trace nodes only carry channel/message/status -- not the source
      // connector type -- but the topology data already loaded for the
      // main graph has it, so borrow it for a matching icon per node
      // instead of falling back to a generic one for everything.
      const sourceTransportById = {};
      (mfData && mfData.nodes || []).forEach((n) => { sourceTransportById[n.id] = n.sourceTransport; });
      const enriched = chain.map((n) => ({ ...n, sourceTransport: sourceTransportById[n.channelId] }));

      const note = traceResult.descendants.length === 0
        ? '<div style="font-size:11px;color:var(--text-faint);margin-top:6px">No descendants found within the scan depth/window -- this may mean the message hasn\'t been routed further yet, or a downstream hop hasn\'t happened within the scanned time range.</div>'
        : "";
      el.innerHTML = `<div class="mf-graph" id="mfTraceGraph" style="margin-top:10px;margin-bottom:0"></div>${note}`;
      renderTraceChainSvg(el.querySelector("#mfTraceGraph"), ui, enriched, traceResult.ancestors.length);
    }

    renderRail();
    renderPane();

    // Lets an external link -- e.g. a browser userscript adding a
    // right-click option on the Messages grid, since that view itself has
    // no plugin hook to add one directly (see README) -- land here with
    // the trace already filled in and run, via
    // /message-flow?channelId=X&messageId=Y&autoTrace=true.
    if (query && query.messageId && query.channelId) {
      const channelSel = pane.querySelector("#mfTraceChannel");
      const msgInput = pane.querySelector("#mfTraceMsgId");
      if (channelSel) channelSel.value = query.channelId;
      if (msgInput) msgInput.value = query.messageId;
      if (query.autoTrace) runTrace();
    }

    return root;
  };
}

/* ══════════════════════ Channel editor tab (single channel, no rail) ═══ */

// registerChannelTab requires a real React component -- confirmed by
// finding the actual call site in the compiled channel-editor bundle:
// `jsx(v, { def: e, ctx: { channel, platform, onChange } })`, where v is a
// generic host wrapping every plugin channel-tab. The exact prop-passing
// convention that wrapper uses internally (spreads ctx as props vs. passes
// it as a single prop) I could not pin down from the minified bundle, but
// every other component-based registry in core/platform.js documents the
// same destructured-props shape (registerConnectorPropertiesPanel's
// component({ ..., channel, platform, onChange })), so this follows that.
// If the tab doesn't render, this destructuring is the first thing to check.
//
// The component itself is a thin React wrapper around the SAME imperative
// DOM rendering used by the nav tab (renderFocusSvgInto/renderTablesHTML)
// via a ref + effect, rather than a from-scratch React reimplementation of
// the graph -- there's no reason to maintain two copies of that logic.
function channelTabComponent(platform2) {
  return function MessageFlowChannelTab({ channel, platform: p, onChange }) {
    const host = p || platform2;
    const React = host.React;
    const containerRef = React.useRef(null);
    const [state, setState] = React.useState({ loading: true, error: null, data: null });
    // Which id the embedded graph is currently focused on -- starts on this
    // channel, but clicking a neighbor in the graph can re-focus locally
    // without leaving the channel editor.
    const [focusedId, setFocusedId] = React.useState(channel.id);

    React.useEffect(() => { setFocusedId(channel.id); }, [channel.id]);

    React.useEffect(() => {
      let cancelled = false;
      setState({ loading: true, error: null, data: null });
      host.api.get(TOPOLOGY_PATH).then((data) => {
        if (!cancelled) setState({ loading: false, error: null, data });
      }).catch((e) => {
        if (!cancelled) setState({ loading: false, error: e && e.message ? e.message : String(e), data: null });
      });
      return () => { cancelled = true; };
    }, [channel.id]);

    React.useEffect(() => {
      ensureStyles();
      const el = containerRef.current;
      if (!el || state.loading) return;

      if (state.error) {
        el.innerHTML = `<div class="mf-err">${inlineIcon(host.ui, "warning", 16)}<div>${esc(state.error)}</div></div>`;
        return;
      }
      const data = state.data;
      const known = data && data.nodes.some((n) => n.id === focusedId);
      if (!data || !known) {
        el.innerHTML = `<div class="mf-placeholder" style="text-align:left;padding:14px">This channel isn't in the routing graph yet \u2014 save and deploy it first, then reopen this tab.</div>`;
        return;
      }

      el.innerHTML = `
        <div class="mf-graph" id="mfChannelTabGraph"></div>
        <div class="mf-legend">
          <span><span class="mf-legend-line" style="background:var(--violet)"></span>Channel Writer route</span>
          <span><span class="mf-legend-line" style="background:var(--blue);background-image:linear-gradient(90deg,var(--blue) 60%,transparent 40%);background-size:6px 2px"></span>Script route (router.routeMessage)</span>
          <span><span class="mf-legend-line" style="background:var(--text-faint);background-image:linear-gradient(90deg,var(--text-faint) 55%,transparent 45%);background-size:8px 2px"></span>Disabled</span>
          <span><span class="mf-legend-dot" style="background:var(--bg3);border:1.5px dashed var(--text-faint)"></span>Unknown/deleted channel</span>
          <span><span class="mf-legend-dot" style="background:#233240;border:1.3px dashed #5a8fa8"></span>External destination (leaves the engine)</span>
        </div>
        <div id="mfChannelTabTables"></div>
      `;
      renderFocusSvgInto(el.querySelector("#mfChannelTabGraph"), host.ui, data, focusedId, (id) => setFocusedId(id));
      el.querySelector("#mfChannelTabTables").innerHTML = renderTablesHTML(host.ui, data);
    }, [state, focusedId]);

    return React.createElement("div", { ref: containerRef, className: "mf-tab-pane" });
  };
}

export { register };
