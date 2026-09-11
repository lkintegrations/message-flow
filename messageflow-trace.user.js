// ==UserScript==
// @name         Message Flow: Trace from Messages Grid
// @namespace    messageflow-trace
// @version      1.0.0
// @description  Right-click a message row in a Channel Messages view to jump into Message Flow's trace with the channel and message ID already filled in and run. Works entirely outside Web Support's own plugin system -- that view has no extension hook to add a real button to (see the extension's README), so this reads the page directly instead.
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // Flip to true and check the browser console if the right-click menu
  // ever stops appearing again -- logs exactly which check bailed out.
  const DEBUG = false;

  // Confirmed from the compiled shell bundle: the Messages view's route is
  // /messages/{channelId} -- the channel id is a UUID sitting right in the
  // URL, no page-scraping needed for that part.
  const MESSAGES_PATH_RE = /\/messages\/([^/?#]+)/;

  let menuEl = null;

  function currentChannelId() {
    const m = location.pathname.match(MESSAGES_PATH_RE);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Web Support can be mounted at any base path (e.g. /oie-webadmin); this
  // derives it from wherever /messages/... actually starts, rather than
  // assuming a fixed prefix.
  function appBase() {
    const idx = location.pathname.search(MESSAGES_PATH_RE);
    return idx === -1 ? "" : location.pathname.slice(0, idx);
  }

  // No dedicated id/class exists on the messages grid <table> itself in
  // the compiled bundle -- this takes the first table on the page, which
  // is correct as long as the Messages view is the only thing rendering
  // one. If a future layout adds another table above it, tighten this
  // selector.
  function findMessagesTable() {
    return document.querySelector("table");
  }

  // Column headers do carry a stable data-col-key attribute (confirmed in
  // the compiled bundle) identifying the logical column regardless of
  // display order, since columns are user-draggable. Finds the "id"
  // column's position so the same position can be read off body rows.
  function idColumnIndex(table) {
    const headRow = table.querySelector("thead tr") || table.querySelector("tr");
    if (!headRow) return -1;
    const cells = Array.from(headRow.children);
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].getAttribute && cells[i].getAttribute("data-col-key") === "id") return i;
    }
    return -1;
  }

  // A message with multiple connectors renders one row per connector
  // (Source, Destination 1, ...), and only the first of those rows shows
  // the actual Id -- the rest show a blank/dash. Walk upward from
  // whichever row was right-clicked until a row with a real Id is found.
  function extractMessageId(row, idIdx) {
    if (idIdx < 0) return null;
    let r = row;
    while (r) {
      const cell = r.children[idIdx];
      if (cell) {
        const digits = cell.textContent.replace(/[^0-9]/g, "").trim();
        if (digits) return digits;
      }
      r = r.previousElementSibling;
    }
    return null;
  }

  function removeMenu() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
  }

  function showMenu(x, y, channelId, messageId) {
    removeMenu();
    menuEl = document.createElement("div");
    menuEl.style.cssText =
      "position:fixed;z-index:999999;background:#1e1e1e;color:#e6e6e6;" +
      "border:1px solid #444;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.4);" +
      "font:13px system-ui,sans-serif;padding:4px;min-width:220px;" +
      "left:" + x + "px;top:" + y + "px;";

    const item = document.createElement("div");
    item.textContent = "Trace message #" + messageId + " in Message Flow";
    item.style.cssText = "padding:8px 12px;cursor:pointer;border-radius:4px;white-space:nowrap;";
    item.addEventListener("mouseenter", () => { item.style.background = "#333"; });
    item.addEventListener("mouseleave", () => { item.style.background = ""; });
    item.addEventListener("click", () => {
      removeMenu();
      const url = appBase() + "/message-flow?channelId=" + encodeURIComponent(channelId) +
        "&messageId=" + encodeURIComponent(messageId) + "&autoTrace=true";
      window.open(url, "_blank");
    });

    menuEl.appendChild(item);
    document.body.appendChild(menuEl);
  }

  document.addEventListener("contextmenu", (ev) => {
    if (DEBUG) console.log("[messageflow-trace] contextmenu at", location.pathname);
    if (!MESSAGES_PATH_RE.test(location.pathname)) {
      if (DEBUG) console.log("[messageflow-trace] URL doesn't match /messages/{channelId} -- not a Channel Messages page, leaving native menu alone");
      return;
    }

    const table = findMessagesTable();
    if (DEBUG) console.log("[messageflow-trace] table found:", !!table);
    if (!table) return;

    const row = ev.target.closest("tr");
    if (DEBUG) console.log("[messageflow-trace] clicked row found:", !!row, "inside table:", row ? table.contains(row) : null);
    if (!row || !table.contains(row)) return;

    const idIdx = idColumnIndex(table);
    if (DEBUG) console.log("[messageflow-trace] id column index:", idIdx);
    const messageId = extractMessageId(row, idIdx);
    const channelId = currentChannelId();
    if (DEBUG) console.log("[messageflow-trace] messageId:", messageId, "channelId:", channelId);
    if (!messageId || !channelId) return; // couldn't identify a real message row -- fall back to the browser's own menu

    ev.preventDefault();
    ev.stopPropagation(); // stops it reaching the app's OWN contextmenu handler too --
                            // preventDefault() alone only blocks the browser's native menu
    showMenu(ev.clientX, ev.clientY, channelId, messageId);
  }, true);

  document.addEventListener("click", removeMenu);
  window.addEventListener("blur", removeMenu);
})();
