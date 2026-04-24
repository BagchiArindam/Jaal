// ==UserScript==
// @name         Jaal
// @namespace    https://github.com/jaal
// @version      0.1.0
// @description  Web-inspection and reverse-DOM toolkit — skeleton inspector + network recorder
// @author       Jaal
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

// NOTE: This is the source file. The final userscript/jaal.user.js is produced
//       by build/build-userscript.mjs, which concatenates shared/*.js before
//       this code. Do not install this file directly in Tampermonkey.

/**
 * Jaal userscript main.
 *
 * At this point the following are available from the concatenated shared files:
 *   window.Jaal.makeLogger      (shared/logger.js)
 *   window.Jaal.htmlExtractor   (shared/html-extractor.js)
 *   window.Jaal.NetHooks        (shared/net-hooks.js)
 *   window.Jaal.skeleton        (shared/skeleton.js)
 *   window.Jaal.NetReplayer     (shared/net-replayer.js)
 *
 * Features exposed by the floating launcher:
 *   🔍 Skeleton — inspect DOM structure in a floating tree panel
 *   📡 Net recorder — capture fetch/XHR, diff around an action, download replayer
 *   ⚙️  Settings — export / import all GM_setValue data as JSON
 */
(function () {
  "use strict";

  if (window.__jaalUserscriptLoaded) return;
  window.__jaalUserscriptLoaded = true;

  const log = window.Jaal.makeLogger("jaal-userscript");
  log.info("userscript_start", { phase: "init", url: window.location.href });

  // ── Net hooks ── install immediately at document-start ──────────────────
  let hooks = null;
  try {
    hooks = window.Jaal.NetHooks.create({ maxBuffer: 500 });
    hooks.start();
    log.info("net_hooks_installed", { phase: "init" });
  } catch (err) {
    log.error("net_hooks_failed", { phase: "error", error: String(err) });
  }

  // ── Storage helpers (GM_setValue / GM_getValue) ────────────────────────

  const STORAGE_PREFIX = "jaal_";
  const STORAGE_EXPORT_TS_KEY = STORAGE_PREFIX + "net_recorder_export_ts";
  const STORAGE_SKELETON_SETTINGS_KEY = STORAGE_PREFIX + "skeleton_settings";

  function gmGet(key, fallback) {
    try { return GM_getValue(STORAGE_PREFIX + key, fallback); } catch (_) { return fallback; }
  }
  function gmSet(key, val) {
    try { GM_setValue(STORAGE_PREFIX + key, val); } catch (_) {}
  }

  // Export ALL GM_setValue data to a JSON string.
  function exportAllGmData() {
    const keys = [
      STORAGE_EXPORT_TS_KEY,
      STORAGE_SKELETON_SETTINGS_KEY,
    ];
    const data = { exported: new Date().toISOString(), version: "0.1.0", data: {} };
    keys.forEach(function (k) {
      const raw = GM_getValue(k, undefined);
      if (raw !== undefined) data.data[k] = raw;
    });
    return JSON.stringify(data, null, 2);
  }

  function importGmData(json) {
    const parsed = JSON.parse(json);
    if (!parsed.data || typeof parsed.data !== "object") throw new Error("Invalid format");
    Object.keys(parsed.data).forEach(function (k) { GM_setValue(k, parsed.data[k]); });
    return Object.keys(parsed.data).length;
  }

  // ── Panels registry ───────────────────────────────────────────────────
  let skeletonPanel = null;
  let recorderPanel = null;
  let settingsPanel = null;

  // ── UI init deferred to DOMContentLoaded ─────────────────────────────

  function init() {
    if (document.getElementById("jaal-launcher-host")) return;
    mountLauncher();
    log.info("launcher_mounted", { phase: "init" });
  }

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LAUNCHER
  // ═══════════════════════════════════════════════════════════════════════

  function mountLauncher() {
    const host = document.createElement("div");
    host.id = "jaal-launcher-host";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
<style>
  :host { all: initial; }
  #btn {
    position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
    width: 42px; height: 42px; border-radius: 50%;
    background: linear-gradient(135deg, #e94560, #7ec8e3);
    color: #fff; font: bold 18px/42px monospace;
    text-align: center; cursor: pointer;
    box-shadow: 0 3px 12px rgba(0,0,0,0.4);
    user-select: none; transition: transform .1s;
  }
  #btn:hover { transform: scale(1.08); }
  #menu {
    position: fixed; bottom: 70px; right: 20px; z-index: 2147483647;
    background: #1a1a2e; border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    overflow: hidden; display: none;
  }
  #menu.open { display: block; }
  .mi {
    display: block; padding: 9px 16px;
    color: #e0e0e0; font: 13px monospace;
    cursor: pointer; white-space: nowrap;
    border-bottom: 1px solid #0f3460;
  }
  .mi:last-child { border-bottom: none; }
  .mi:hover { background: #16213e; color: #7ec8e3; }
</style>
<div id="btn" title="Jaal">J</div>
<div id="menu">
  <div class="mi" id="mi-skeleton">🔍 Skeleton inspector</div>
  <div class="mi" id="mi-recorder">📡 Net recorder</div>
  <div class="mi" id="mi-settings">⚙️ Settings</div>
</div>`;

    const btn  = shadow.getElementById("btn");
    const menu = shadow.getElementById("menu");
    let open = false;

    function toggleMenu(v) {
      open = v;
      menu.classList.toggle("open", open);
    }

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleMenu(!open);
    });
    document.addEventListener("click", function () { toggleMenu(false); });

    shadow.getElementById("mi-skeleton").addEventListener("click", function () {
      toggleMenu(false);
      showSkeletonPanel();
    });
    shadow.getElementById("mi-recorder").addEventListener("click", function () {
      toggleMenu(false);
      showRecorderPanel();
    });
    shadow.getElementById("mi-settings").addEventListener("click", function () {
      toggleMenu(false);
      showSettingsPanel();
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SKELETON PANEL
  // ═══════════════════════════════════════════════════════════════════════

  function showSkeletonPanel() {
    if (skeletonPanel) { skeletonPanel.style.display = ""; return; }
    log.info("skeleton_panel_open", { phase: "mutate" });

    const savedSettings = gmGet("skeleton_settings", {});
    let maxDepth          = savedSettings.maxDepth || 6;
    let collapseThreshold = savedSettings.collapseThreshold || 5;

    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
<style>
  :host { all: initial; }
  #panel {
    position: fixed; top: 10px; left: 10px; z-index: 2147483647;
    width: 420px; max-height: 70vh;
    background: #1a1a2e; color: #e0e0e0;
    font: 12px/1.5 "SFMono-Regular", Consolas, monospace;
    border-radius: 8px; box-shadow: 0 4px 24px rgba(0,0,0,0.6);
    display: flex; flex-direction: column; user-select: none;
  }
  #hdr {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; background: #16213e;
    border-radius: 8px 8px 0 0; cursor: move; flex-shrink: 0;
  }
  #title { flex: 1; font-weight: bold; font-size: 12px; color: #7ec8e3; }
  .ic { cursor: pointer; opacity: .6; font-size: 15px; }
  .ic:hover { opacity: 1; }
  #controls {
    display: flex; gap: 6px; padding: 6px 10px; flex-shrink: 0;
    border-bottom: 1px solid #0f3460;
  }
  .btn {
    padding: 4px 8px; border: none; border-radius: 4px;
    cursor: pointer; font: 11px monospace;
  }
  .btn-blue { background: #0f3460; color: #7ec8e3; }
  .btn-blue:hover { background: #1a4a80; }
  label { font-size: 11px; color: #aaa; display: flex; align-items: center; gap: 4px; }
  input[type=number] {
    width: 36px; background: #0f3460; border: none; border-radius: 3px;
    color: #7ec8e3; font: 11px monospace; padding: 2px 4px;
  }
  #tree {
    overflow: auto; padding: 8px 10px; flex: 1;
    white-space: pre; font-size: 11px; line-height: 1.4; color: #ccc;
  }
  #export-bar {
    display: flex; gap: 6px; padding: 6px 10px; flex-shrink: 0;
    border-top: 1px solid #0f3460;
  }
</style>
<div id="panel">
  <div id="hdr">
    <span id="title">Jaal · Skeleton</span>
    <span class="ic" id="refresh" title="Re-inspect">↺</span>
    <span class="ic" id="close" title="Close">✕</span>
  </div>
  <div id="controls">
    <label>Depth <input type="number" id="depth" min="1" max="20" value="${maxDepth}"></label>
    <label>Collapse ≥ <input type="number" id="collapse" min="1" max="50" value="${collapseThreshold}"></label>
    <button class="btn btn-blue" id="btn-re">Apply</button>
  </div>
  <div id="tree">Inspecting…</div>
  <div id="export-bar">
    <button class="btn btn-blue" id="btn-copy-tree">Copy tree</button>
    <button class="btn btn-blue" id="btn-copy-json">Copy JSON</button>
    <button class="btn btn-blue" id="btn-dl-json">Download JSON</button>
  </div>
</div>`;

    skeletonPanel = host;
    const treeEl     = shadow.getElementById("tree");
    const depthInput = shadow.getElementById("depth");
    const collapseInput = shadow.getElementById("collapse");
    let lastResult = null;

    function runInspect() {
      maxDepth          = parseInt(depthInput.value, 10) || 6;
      collapseThreshold = parseInt(collapseInput.value, 10) || 5;
      try {
        lastResult = window.Jaal.skeleton.inspect(document.body, { maxDepth, collapseThreshold });
        treeEl.textContent = lastResult.tree;
        gmSet("skeleton_settings", { maxDepth, collapseThreshold });
        log.info("skeleton_inspected", { phase: "mutate" });
      } catch (err) {
        treeEl.textContent = "Error: " + err.message;
        log.error("skeleton_inspect_failed", { phase: "error", error: err.message });
      }
    }

    // Drag
    let dragging = false, dox = 0, doy = 0;
    const panel = shadow.getElementById("panel");
    shadow.getElementById("hdr").addEventListener("mousedown", function (e) {
      dragging = true;
      const r = panel.getBoundingClientRect();
      dox = e.clientX - r.left; doy = e.clientY - r.top;
    });
    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      panel.style.left = (e.clientX - dox) + "px";
      panel.style.top  = (e.clientY - doy) + "px";
    });
    document.addEventListener("mouseup", function () { dragging = false; });

    shadow.getElementById("close").addEventListener("click", function () {
      host.style.display = "none";
    });
    shadow.getElementById("refresh").addEventListener("click", runInspect);
    shadow.getElementById("btn-re").addEventListener("click", runInspect);

    shadow.getElementById("btn-copy-tree").addEventListener("click", function () {
      if (!lastResult) return;
      navigator.clipboard.writeText(lastResult.tree).catch(function () {
        GM_setClipboard(lastResult.tree);
      });
    });
    shadow.getElementById("btn-copy-json").addEventListener("click", function () {
      if (!lastResult) return;
      const s = JSON.stringify(lastResult, null, 2);
      navigator.clipboard.writeText(s).catch(function () { GM_setClipboard(s); });
    });
    shadow.getElementById("btn-dl-json").addEventListener("click", function () {
      if (!lastResult) return;
      const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: "application/json" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = "jaal-skeleton-" + Date.now() + ".json"; a.click();
      URL.revokeObjectURL(url);
    });

    runInspect();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // NET RECORDER PANEL
  // ═══════════════════════════════════════════════════════════════════════

  function showRecorderPanel() {
    if (recorderPanel) { recorderPanel.style.display = ""; return; }
    log.info("net_recorder_panel_open", { phase: "mutate" });

    let diffCalls = [];
    let beforeSnap = null;
    let recPhase   = "idle"; // idle | before | result

    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
<style>
  :host { all: initial; }
  #panel {
    position: fixed; top: 10px; right: 10px; z-index: 2147483647;
    width: 310px; background: #1a1a2e; color: #e0e0e0;
    font: 13px/1.4 "SFMono-Regular", Consolas, monospace;
    border-radius: 8px; box-shadow: 0 4px 24px rgba(0,0,0,0.6);
    user-select: none;
  }
  #hdr {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; background: #16213e;
    border-radius: 8px 8px 0 0; cursor: move;
  }
  #title { flex: 1; font-weight: bold; font-size: 12px; color: #7ec8e3; }
  .ic { cursor: pointer; opacity: .6; font-size: 15px; }
  .ic:hover { opacity: 1; }
  #body { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  #status { font-size: 11px; padding: 5px 8px; border-radius: 4px; background: #0f3460; }
  .row { display: flex; gap: 6px; }
  .row .btn { flex: 1; }
  .btn { padding: 6px 8px; border: none; border-radius: 4px; cursor: pointer; font: 12px monospace; }
  .btn:disabled { opacity: .4; cursor: not-allowed; }
  .btn-red   { background: #e94560; color: #fff; }
  .btn-red:hover:not(:disabled) { background: #c73652; }
  .btn-blue  { background: #0f3460; color: #7ec8e3; }
  .btn-blue:hover:not(:disabled) { background: #1a4a80; }
  .btn-green { background: #27ae60; color: #fff; }
  .btn-green:hover:not(:disabled) { background: #219150; }
  #calls-list {
    display: none; max-height: 120px; overflow-y: auto;
    font-size: 10px; background: #0d0d1a; border-radius: 4px; padding: 6px;
  }
  .ci { padding: 2px 0; border-bottom: 1px solid #1a1a2e; }
  .ci:last-child { border-bottom: none; }
  .cm { color: #f39c12; }
  .cu { color: #bdc3c7; word-break: break-all; }
  #settings-toggle {
    font-size: 11px; text-align: center; color: #7ec8e3; cursor: pointer;
    border-top: 1px solid #0f3460; padding-top: 6px;
  }
  #settings-toggle:hover { color: #fff; }
  #settings-panel { display: none; flex-direction: column; gap: 6px; padding-top: 4px; }
  #settings-panel.open { display: flex; }
  #backup-age { font-size: 10px; color: #7ec8e3; text-align: center; }
</style>
<div id="panel">
  <div id="hdr">
    <span id="title">Jaal · Net Recorder</span>
    <span class="ic" id="close" title="Close">✕</span>
  </div>
  <div id="body">
    <div id="status">Recording — 0 calls</div>
    <div class="row">
      <button class="btn btn-red"  id="btn-before">① Mark start</button>
      <button class="btn btn-blue" id="btn-diff" disabled>② Capture diff</button>
    </div>
    <button class="btn btn-green" id="btn-generate" disabled>⬇ Generate replayer script</button>
    <div class="row">
      <button class="btn btn-blue" id="btn-export" disabled>📥 Export JSON</button>
      <button class="btn btn-blue" id="btn-import">📤 Import JSON</button>
      <button class="btn btn-blue" id="btn-clear" disabled>Clear</button>
    </div>
    <div id="calls-list"></div>
    <div id="settings-toggle">⚙ Settings</div>
    <div id="settings-panel">
      <div id="backup-age"></div>
      <input type="file" id="import-file" accept=".json" style="display:none">
    </div>
  </div>
</div>`;

    recorderPanel = host;
    const panel       = shadow.getElementById("panel");
    const statusEl    = shadow.getElementById("status");
    const btnBefore   = shadow.getElementById("btn-before");
    const btnDiff     = shadow.getElementById("btn-diff");
    const btnGenerate = shadow.getElementById("btn-generate");
    const btnExport   = shadow.getElementById("btn-export");
    const btnImport   = shadow.getElementById("btn-import");
    const btnClear    = shadow.getElementById("btn-clear");
    const callsList   = shadow.getElementById("calls-list");
    const settingsTgl = shadow.getElementById("settings-toggle");
    const settingsPnl = shadow.getElementById("settings-panel");
    const importFile  = shadow.getElementById("import-file");
    const backupAge   = shadow.getElementById("backup-age");
    const closeEl     = shadow.getElementById("close");

    function setStatus(msg) { statusEl.textContent = msg; }
    function setPhase(p) {
      recPhase = p;
      const has = diffCalls.length > 0;
      if (p === "idle") {
        btnBefore.disabled = false;
        btnDiff.disabled   = true;
      } else if (p === "before") {
        btnBefore.disabled = true;
        btnDiff.disabled   = false;
      } else if (p === "result") {
        btnBefore.disabled = false;
        btnDiff.disabled   = false;
      }
      btnGenerate.disabled = !has;
      btnExport.disabled   = !has;
      btnClear.disabled    = false;
    }
    function renderCalls(calls) {
      if (!calls || !calls.length) {
        callsList.style.display = "none";
        callsList.innerHTML = "";
        return;
      }
      callsList.style.display = "block";
      callsList.innerHTML = calls.map(function (c) {
        const u = c.url.length > 55 ? c.url.substring(0, 55) + "…" : c.url;
        return '<div class="ci"><span class="cm">' + (c.method || c.type) + "</span> " +
               '<span class="cu">' + u + "</span></div>";
      }).join("");
    }

    // Drag
    let dragging = false, dox = 0, doy = 0;
    shadow.getElementById("hdr").addEventListener("mousedown", function (e) {
      dragging = true;
      const r = panel.getBoundingClientRect();
      dox = e.clientX - r.left; doy = e.clientY - r.top;
    });
    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      panel.style.right = "auto";
      panel.style.left  = (e.clientX - dox) + "px";
      panel.style.top   = (e.clientY - doy) + "px";
    });
    document.addEventListener("mouseup", function () { dragging = false; });

    settingsTgl.addEventListener("click", function () {
      settingsPnl.classList.toggle("open");
    });

    closeEl.addEventListener("click", function () { host.style.display = "none"; });

    function refreshBackupAge() {
      const ts = GM_getValue(STORAGE_EXPORT_TS_KEY, null);
      if (!ts) { backupAge.textContent = "No export yet"; return; }
      const ms = Date.now() - new Date(ts).getTime();
      const h  = Math.floor(ms / 3600000);
      const m  = Math.floor((ms % 3600000) / 60000);
      backupAge.textContent = "📦 Last export: " + (h > 0 ? h + "h " + m + "m" : m + "m") + " ago";
    }
    refreshBackupAge();

    // Update live count every 2s while panel is visible
    const ticker = setInterval(function () {
      if (!hooks || host.style.display === "none") return;
      const n = hooks.snapshot().length;
      if (recPhase === "idle") setStatus("Recording — " + n + " call(s)");
    }, 2000);

    btnBefore.addEventListener("click", function () {
      beforeSnap = hooks ? hooks.snapshot() : [];
      setPhase("before");
      setStatus("✅ Start marked (" + beforeSnap.length + " calls). Do your action, then click ②.");
    });

    btnDiff.addEventListener("click", function () {
      const after = hooks ? hooks.snapshot() : [];
      const ids   = new Set((beforeSnap || []).map(function (c) { return c.id; }));
      diffCalls   = after.filter(function (c) { return !ids.has(c.id); });
      setPhase("result");
      setStatus("Diff: " + diffCalls.length + " new call(s).");
      renderCalls(diffCalls);
      log.info("diff_captured", { phase: "mutate", count: diffCalls.length });
    });

    btnGenerate.addEventListener("click", function () {
      if (!diffCalls.length) { setStatus("No calls to replay yet."); return; }
      const script = window.Jaal.NetReplayer.generateScript(diffCalls, {
        label: "Jaal replayer — " + window.location.hostname,
      });
      const blob = new Blob([script], { type: "text/javascript" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = "jaal-replayer-" + Date.now() + ".js"; a.click();
      URL.revokeObjectURL(url);
      setStatus("✓ Replayer script downloaded.");
      log.info("replayer_generated", { phase: "mutate", count: diffCalls.length });
    });

    btnExport.addEventListener("click", function () {
      if (!diffCalls.length) { setStatus("No calls to export."); return; }
      const payload = { exported: new Date().toISOString(), url: window.location.href, calls: diffCalls };
      const json    = JSON.stringify(payload, null, 2);
      navigator.clipboard.writeText(json).then(function () {
        setStatus("✓ Copied JSON to clipboard.");
      }).catch(function () {
        try { GM_setClipboard(json); setStatus("✓ Copied via GM."); }
        catch (_) {
          const blob = new Blob([json], { type: "application/json" });
          const u = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = u; a.download = "jaal-calls-" + Date.now() + ".json"; a.click();
          URL.revokeObjectURL(u);
          setStatus("✓ Downloaded JSON.");
        }
      });
      GM_setValue(STORAGE_EXPORT_TS_KEY, new Date().toISOString());
      refreshBackupAge();
      log.info("calls_exported", { phase: "mutate", count: diffCalls.length });
    });

    btnImport.addEventListener("click", function () { importFile.click(); });
    importFile.addEventListener("change", function () {
      const file = importFile.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function (ev) {
        try {
          const data = JSON.parse(ev.target.result);
          if (!Array.isArray(data.calls)) throw new Error("Missing calls array");
          if (!confirm("Import " + data.calls.length + " calls? Replaces current diff.")) return;
          diffCalls = data.calls;
          setPhase("result");
          setStatus("Imported " + diffCalls.length + " calls.");
          renderCalls(diffCalls);
          log.info("calls_imported", { phase: "mutate", count: diffCalls.length });
        } catch (err) {
          setStatus("⚠ Import failed: " + err.message);
        }
        importFile.value = "";
      };
      reader.readAsText(file);
    });

    btnClear.addEventListener("click", function () {
      if (!confirm("Clear all captured calls?")) return;
      if (hooks) hooks.clear();
      diffCalls  = [];
      beforeSnap = null;
      setPhase("idle");
      setStatus("Cleared. Recording from now.");
      callsList.style.display = "none";
      callsList.innerHTML     = "";
      btnGenerate.disabled    = true;
      btnExport.disabled      = true;
      log.info("recorder_cleared", { phase: "mutate" });
    });

    // Clean up ticker when panel host is removed
    const observer = new MutationObserver(function () {
      if (!document.contains(host)) { clearInterval(ticker); observer.disconnect(); }
    });
    observer.observe(document.body, { childList: true });

    // Initial status
    const initCount = hooks ? hooks.snapshot().length : 0;
    setStatus("Recording — " + initCount + " call(s)");
    setPhase("idle");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SETTINGS PANEL (export / import ALL GM data)
  // ═══════════════════════════════════════════════════════════════════════

  function showSettingsPanel() {
    if (settingsPanel) { settingsPanel.style.display = ""; return; }
    log.info("settings_panel_open", { phase: "mutate" });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
<style>
  :host { all: initial; }
  #panel {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    z-index: 2147483647; width: 320px;
    background: #1a1a2e; color: #e0e0e0;
    font: 13px/1.4 "SFMono-Regular", Consolas, monospace;
    border-radius: 8px; box-shadow: 0 4px 24px rgba(0,0,0,0.7);
  }
  #hdr {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; background: #16213e;
    border-radius: 8px 8px 0 0;
  }
  #title { flex: 1; font-weight: bold; font-size: 12px; color: #7ec8e3; }
  .ic { cursor: pointer; opacity: .6; font-size: 15px; }
  .ic:hover { opacity: 1; }
  #body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .desc { font-size: 11px; color: #aaa; }
  .row { display: flex; gap: 6px; }
  .row .btn { flex: 1; }
  .btn { padding: 7px 10px; border: none; border-radius: 4px; cursor: pointer; font: 12px monospace; }
  .btn-blue  { background: #0f3460; color: #7ec8e3; }
  .btn-blue:hover  { background: #1a4a80; }
  .btn-green { background: #27ae60; color: #fff; }
  .btn-green:hover { background: #219150; }
  #msg { font-size: 11px; color: #7ec8e3; min-height: 18px; }
</style>
<div id="panel">
  <div id="hdr">
    <span id="title">Jaal · Settings</span>
    <span class="ic" id="close" title="Close">✕</span>
  </div>
  <div id="body">
    <div class="desc">All Jaal data stored in Tampermonkey (settings, export timestamps).</div>
    <div class="row">
      <button class="btn btn-green" id="btn-export">📥 Export data</button>
      <button class="btn btn-blue"  id="btn-import">📤 Import from backup</button>
    </div>
    <div id="msg"></div>
    <input type="file" id="import-file" accept=".json" style="display:none">
  </div>
</div>`;

    settingsPanel = host;
    const msgEl     = shadow.getElementById("msg");
    const importFile = shadow.getElementById("import-file");

    shadow.getElementById("close").addEventListener("click", function () { host.style.display = "none"; });

    shadow.getElementById("btn-export").addEventListener("click", function () {
      const json = exportAllGmData();
      navigator.clipboard.writeText(json).then(function () {
        msgEl.textContent = "✓ Copied to clipboard.";
      }).catch(function () {
        try { GM_setClipboard(json); msgEl.textContent = "✓ Copied via GM."; }
        catch (_) {
          const blob = new Blob([json], { type: "application/json" });
          const u = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = u; a.download = "jaal-settings-" + Date.now() + ".json"; a.click();
          URL.revokeObjectURL(u);
          msgEl.textContent = "✓ Downloaded.";
        }
      });
      log.info("settings_exported", { phase: "mutate" });
    });

    shadow.getElementById("btn-import").addEventListener("click", function () { importFile.click(); });

    importFile.addEventListener("change", function () {
      const file = importFile.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function (ev) {
        try {
          if (!confirm("Import backup? ⚠ This will overwrite current Jaal settings.")) return;
          const count = importGmData(ev.target.result);
          msgEl.textContent = "✓ Imported " + count + " key(s).";
          log.info("settings_imported", { phase: "mutate", keys: count });
        } catch (err) {
          msgEl.textContent = "⚠ Import failed: " + err.message;
          log.error("settings_import_failed", { phase: "error", error: err.message });
        }
        importFile.value = "";
      };
      reader.readAsText(file);
    });
  }

})();
