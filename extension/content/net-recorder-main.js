/**
 * content/net-recorder-main.js — runs in MAIN world at document-start.
 *
 * Installs window.Jaal.NetHooks immediately so all fetch/XHR/WS calls are
 * captured from page load. Responds to command CustomEvents dispatched by
 * the overlay (isolated world).
 *
 * MV3 Chrome: injected declaratively via manifest.json content_scripts
 *             with "world": "MAIN", "run_at": "document_start".
 * MV2 Firefox: injected via <script> tag from content/net-recorder-injector.js.
 *
 * CustomEvent bridge (window is shared across worlds):
 *   Overlay → Main:  "jaal:recorder:cmd"  evt.detail = { cmd, ...args }
 *   Main → Overlay:  "jaal:recorder:evt"  evt.detail = { event, ...data }
 *
 * Commands:
 *   init            → "ready"  { active, count }
 *   snapshot-before → "snapshot-before-done"  { count }
 *   diff            → "diff-result"  { calls[] }
 *   snapshot        → "snapshot-result"  { calls[] }
 *   clear           → "cleared"  {}
 */
(function () {
  "use strict";

  if (window.__jaalNetRecorderMainInstalled) {
    console.log("[Jaal net-recorder-main] already installed — skipping");
    return;
  }
  window.__jaalNetRecorderMainInstalled = true;

  let hooks = null;
  let beforeSnapshot = null;

  function ensureHooks() {
    if (hooks) return;
    if (!window.Jaal || !window.Jaal.NetHooks) {
      console.error("[Jaal net-recorder-main] NetHooks not yet available — will retry on next cmd");
      return;
    }
    hooks = window.Jaal.NetHooks.create({ maxBuffer: 500 });
    hooks.start();
    console.log("[Jaal net-recorder-main] NetHooks installed, recording started");
  }

  function dispatch(eventName, detail) {
    // Use postMessage for cross-world IPC (works in both Chrome MV3 and Firefox MV2)
    window.postMessage(Object.assign({ source: "jaal-main", event: eventName }, detail || {}), "*");
  }

  window.addEventListener("message", function (evt) {
    // Only process messages from the isolated world's net-recorder-overlay.js
    if (!evt || !evt.data || evt.data.source !== "jaal-overlay") return;
    const cmd = evt.data.cmd;

    if (cmd === "init") {
      ensureHooks();
      dispatch("ready", {
        active: hooks ? hooks.isActive() : false,
        count: hooks ? hooks.snapshot().length : 0,
      });

    } else if (cmd === "snapshot-before") {
      ensureHooks();
      beforeSnapshot = hooks ? hooks.snapshot() : [];
      dispatch("snapshot-before-done", { count: beforeSnapshot.length });

    } else if (cmd === "diff") {
      const after = hooks ? hooks.snapshot() : [];
      const beforeIds = new Set((beforeSnapshot || []).map(function (c) { return c.id; }));
      const newCalls = after.filter(function (c) { return !beforeIds.has(c.id); });
      dispatch("diff-result", { calls: newCalls });

    } else if (cmd === "snapshot") {
      const snap = hooks ? hooks.snapshot() : [];
      dispatch("snapshot-result", { calls: snap });

    } else if (cmd === "clear") {
      if (hooks) hooks.clear();
      beforeSnapshot = null;
      dispatch("cleared", {});
    }
  });

  // Install hooks immediately — this is the document-start hook point.
  ensureHooks();

  console.log("[Jaal net-recorder-main] ready");
})();
