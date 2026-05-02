/**
 * content/net-recorder-main.js — runs in MAIN world at document-start.
 *
 * Installs window.Jaal.NetHooks immediately so all fetch/XHR/WS calls are
 * captured from page load. Also captures user-action events (click, input,
 * keydown, submit) and frontend transform calls (btoa, atob, JSON.stringify,
 * encodeURIComponent) via the extended NetHooks.
 *
 * MV3 Chrome: injected declaratively via manifest.json content_scripts
 *             with "world": "MAIN", "run_at": "document_start".
 * MV2 Firefox: injected via <script> tag from content/net-recorder-injector.js.
 *
 * postMessage bridge (window shared across worlds):
 *   Overlay → Main:  source: "jaal-overlay"  cmd field
 *   Main → Overlay:  source: "jaal-main"      event field
 *
 * Commands:
 *   init            → "ready"  { active, count }
 *   start           → "started" {}         (begin recording)
 *   stop            → "stopped" {}         (pause recording)
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

  let hooks          = null;
  let beforeSnapshot = null;

  // ─── Shortest unique CSS selector for an element ─────────────────────────

  function _uniquePath(el) {
    if (!el || el === document.body) return "body";
    if (el.id) return "#" + el.id;
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 5) {
      let step = (cur.tagName || "").toLowerCase();
      if (cur.id) { parts.unshift("#" + cur.id); break; }
      const cls = Array.from(cur.classList || []).slice(0, 2).join(".");
      if (cls) step += "." + cls;
      parts.unshift(step);
      cur = cur.parentElement;
    }
    return parts.join(" > ") || "unknown";
  }

  // ─── User-action capture ──────────────────────────────────────────────────

  let _actionListeners = [];

  function _installActionCapture() {
    function _pushAction(evtType, target, extras) {
      if (!hooks) return;
      hooks.pushAction(Object.assign({
        type: "action",
        eventType: evtType,
        target: _uniquePath(target),
        ts: Date.now(),
      }, extras || {}));
    }

    function onClickCapture(e) {
      if (!e || !e.target) return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return; // handled by input event
      _pushAction("click", e.target, { tagName: tag });
    }

    function onInputCapture(e) {
      if (!e || !e.target) return;
      const val = e.target.value || "";
      _pushAction("input", e.target, {
        tagName: (e.target.tagName || "").toLowerCase(),
        inputType: e.target.type || "",
        value: val.length > 200 ? val.substring(0, 200) + "…" : val,
      });
    }

    function onKeydownCapture(e) {
      // Only capture navigation/submit keys
      const keys = ["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp"];
      if (!e || !keys.includes(e.key)) return;
      _pushAction("keydown", e.target, { key: e.key });
    }

    function onSubmitCapture(e) {
      if (!e || !e.target) return;
      _pushAction("submit", e.target, { tagName: "form" });
    }

    document.addEventListener("click",   onClickCapture,   { capture: true, passive: true });
    document.addEventListener("input",    onInputCapture,   { capture: true, passive: true });
    document.addEventListener("keydown",  onKeydownCapture, { capture: true, passive: true });
    document.addEventListener("submit",   onSubmitCapture,  { capture: true, passive: true });

    _actionListeners = [
      ["click",   onClickCapture],
      ["input",   onInputCapture],
      ["keydown", onKeydownCapture],
      ["submit",  onSubmitCapture],
    ];
    console.log("[Jaal net-recorder-main] user-action capture installed");
  }

  function _uninstallActionCapture() {
    for (var i = 0; i < _actionListeners.length; i++) {
      document.removeEventListener(_actionListeners[i][0], _actionListeners[i][1], true);
    }
    _actionListeners = [];
  }

  // ─── Hooks init ───────────────────────────────────────────────────────────

  function ensureHooks() {
    if (hooks) return;
    if (!window.Jaal || !window.Jaal.NetHooks) {
      console.error("[Jaal net-recorder-main] NetHooks not yet available — will retry on next cmd");
      return;
    }
    hooks = window.Jaal.NetHooks.create({ maxBuffer: 500 });
    hooks.start();
    _installActionCapture();
    console.log("[Jaal net-recorder-main] NetHooks + action capture installed, recording started");
  }

  // ─── Cross-world message bridge ───────────────────────────────────────────

  function dispatch(eventName, detail) {
    window.postMessage(Object.assign({ source: "jaal-main", event: eventName }, detail || {}), "*");
  }

  window.addEventListener("message", function (evt) {
    if (!evt || !evt.data || evt.data.source !== "jaal-overlay") return;
    const cmd = evt.data.cmd;

    if (cmd === "init") {
      ensureHooks();
      dispatch("ready", {
        active: hooks ? hooks.isActive() : false,
        count:  hooks ? hooks.snapshot().length : 0,
      });

    } else if (cmd === "start") {
      ensureHooks();
      if (hooks && !hooks.isActive()) hooks.start();
      if (_actionListeners.length === 0) _installActionCapture();
      dispatch("started", { count: hooks ? hooks.snapshot().length : 0 });

    } else if (cmd === "stop") {
      if (hooks) hooks.stop();
      _uninstallActionCapture();
      dispatch("stopped", { count: hooks ? hooks.snapshot().length : 0 });

    } else if (cmd === "snapshot-before") {
      ensureHooks();
      beforeSnapshot = hooks ? hooks.snapshot() : [];
      dispatch("snapshot-before-done", { count: beforeSnapshot.length });

    } else if (cmd === "diff") {
      const after     = hooks ? hooks.snapshot() : [];
      const beforeIds = new Set((beforeSnapshot || []).map(function (c) { return c.id; }));
      const newCalls  = after.filter(function (c) { return !beforeIds.has(c.id); });
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

  ensureHooks();
  console.log("[Jaal net-recorder-main] ready");
})();
