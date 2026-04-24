/**
 * ui/net-recorder-overlay.js — network recorder floating panel.
 *
 * Runs in isolated world. Communicates with content/net-recorder-main.js
 * (MAIN world) via CustomEvent on the shared window object.
 *
 * Workflow:
 *   1. Panel opens → sends "init" cmd → shows live call count.
 *   2. User clicks "① Mark start" → snapshot-before saved in MAIN world.
 *   3. User performs UI action (next-page click, form submit, etc.).
 *   4. User clicks "② Capture diff" → diff of new calls returned.
 *   5. "Generate replayer script" → downloads a standalone JS file via
 *      window.Jaal.NetReplayer.generateScript().
 *   6. "📥 Export JSON" → copies captured calls to clipboard (or downloads).
 *   7. "📤 Import JSON" → restores a prior export.
 *
 * Follows skeleton-overlay.js patterns:
 *   - Shadow DOM (host-style isolation)
 *   - chrome.storage.local for last-export timestamp
 *   - export/import JSON backup buttons in ⚙️ Settings panel
 */
(function () {
  "use strict";

  if (window.__jaalNetRecorderOverlayLoaded) {
    console.log("[Jaal net-recorder-overlay] already loaded — skipping");
    return;
  }
  window.__jaalNetRecorderOverlayLoaded = true;

  const log = (window.Jaal && window.Jaal.makeLogger)
    ? window.Jaal.makeLogger("net-recorder-overlay")
    : { info: console.log, warn: console.warn, error: console.error, debug: console.log };

  // ─── State ───────────────────────────────────────────────────────────────

  let diffCalls = [];
  let phase = "idle"; // idle | before | result

  // ─── Shadow DOM ──────────────────────────────────────────────────────────

  const host = document.createElement("div");
  host.id = "jaal-net-recorder-host";
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
<style>
  :host { all: initial; }
  #panel {
    position: fixed; top: 10px; right: 10px; z-index: 2147483647;
    background: #1a1a2e; color: #e0e0e0;
    font: 13px/1.4 "SFMono-Regular", Consolas, monospace;
    border-radius: 8px; box-shadow: 0 4px 24px rgba(0,0,0,0.6);
    width: 310px; user-select: none;
  }
  #hdr {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; background: #16213e;
    border-radius: 8px 8px 0 0; cursor: move;
  }
  #title { flex: 1; font-weight: bold; font-size: 12px; color: #7ec8e3; }
  #close { cursor: pointer; opacity: 0.6; font-size: 16px; line-height: 1; }
  #close:hover { opacity: 1; }
  #body { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  #status {
    font-size: 11px; padding: 5px 8px;
    border-radius: 4px; background: #0f3460; min-height: 28px;
  }
  .row { display: flex; gap: 6px; }
  .row .btn { flex: 1; }
  .btn {
    padding: 6px 8px; border: none; border-radius: 4px;
    cursor: pointer; font: 12px monospace; transition: opacity .15s;
  }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-red   { background: #e94560; color: #fff; }
  .btn-red:hover:not(:disabled)   { background: #c73652; }
  .btn-blue  { background: #0f3460; color: #7ec8e3; }
  .btn-blue:hover:not(:disabled)  { background: #1a4a80; }
  .btn-green { background: #27ae60; color: #fff; }
  .btn-green:hover:not(:disabled) { background: #219150; }
  #calls-list {
    display: none; max-height: 130px; overflow-y: auto;
    font-size: 10px; background: #0d0d1a;
    border-radius: 4px; padding: 6px;
  }
  .ci { padding: 2px 0; border-bottom: 1px solid #1a1a2e; }
  .ci:last-child { border-bottom: none; }
  .cm { color: #f39c12; }
  .cu { color: #bdc3c7; word-break: break-all; }
  #settings-toggle {
    font-size: 11px; text-align: center; color: #7ec8e3; cursor: pointer;
    border-top: 1px solid #0f3460; padding-top: 6px; margin-top: 2px;
  }
  #settings-toggle:hover { color: #fff; }
  #settings-panel { display: none; flex-direction: column; gap: 6px; padding-top: 4px; }
  #settings-panel.open { display: flex; }
  #backup-age { font-size: 10px; color: #7ec8e3; text-align: center; }
</style>
<div id="panel">
  <div id="hdr">
    <span id="title">Jaal · Net Recorder</span>
    <span id="close" title="Close">✕</span>
  </div>
  <div id="body">
    <div id="status">Connecting to page hooks…</div>
    <div class="row">
      <button class="btn btn-red"  id="btn-before"   disabled>① Mark start</button>
      <button class="btn btn-blue" id="btn-diff"     disabled>② Capture diff</button>
    </div>
    <button class="btn btn-green"  id="btn-generate" disabled>⬇ Generate replayer script</button>
    <div class="row">
      <button class="btn btn-blue" id="btn-export"   disabled>📥 Export JSON</button>
      <button class="btn btn-blue" id="btn-import">📤 Import JSON</button>
      <button class="btn btn-blue" id="btn-clear"    disabled>Clear</button>
    </div>
    <div id="calls-list"></div>
    <div id="settings-toggle">⚙ Settings</div>
    <div id="settings-panel">
      <div id="backup-age"></div>
      <input type="file" id="import-file" accept=".json" style="display:none">
    </div>
  </div>
</div>`;

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

  // ─── Drag ────────────────────────────────────────────────────────────────

  let dragging = false, dox = 0, doy = 0;
  shadow.getElementById("hdr").addEventListener("mousedown", function (e) {
    dragging = true;
    const r = panel.getBoundingClientRect();
    dox = e.clientX - r.left; doy = e.clientY - r.top;
  });
  document.addEventListener("mousemove", function (e) {
    if (!dragging) return;
    panel.style.left  = (e.clientX - dox) + "px";
    panel.style.top   = (e.clientY - doy) + "px";
    panel.style.right = "auto";
  });
  document.addEventListener("mouseup", function () { dragging = false; });

  // ─── Settings panel ──────────────────────────────────────────────────────

  settingsTgl.addEventListener("click", function () {
    settingsPnl.classList.toggle("open");
  });

  closeEl.addEventListener("click", function () {
    host.remove();
    window.__jaalNetRecorderOverlayLoaded = false;
    log.info("panel_closed", { phase: "teardown" });
  });

  // ─── Storage (last-export timestamp) ────────────────────────────────────

  const STORAGE_KEY = "jaal_net_recorder_export_ts";
  const hasStorage = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

  function loadExportTs() {
    if (!hasStorage) return Promise.resolve(null);
    return new Promise(function (res) {
      chrome.storage.local.get([STORAGE_KEY], function (r) { res(r[STORAGE_KEY] || null); });
    });
  }
  function saveExportTs(ts) {
    if (!hasStorage) return;
    chrome.storage.local.set({ [STORAGE_KEY]: ts });
  }
  function refreshBackupAge() {
    loadExportTs().then(function (ts) {
      if (!ts) { backupAge.textContent = "No export yet"; return; }
      const ms = Date.now() - new Date(ts).getTime();
      const h  = Math.floor(ms / 3600000);
      const m  = Math.floor((ms % 3600000) / 60000);
      backupAge.textContent = "📦 Last export: " + (h > 0 ? h + "h " + m + "m" : m + "m") + " ago";
    });
  }
  refreshBackupAge();

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function setStatus(msg) { statusEl.textContent = msg; }

  function renderCalls(calls) {
    if (!calls || !calls.length) {
      callsList.style.display = "none";
      callsList.innerHTML = "";
      return;
    }
    callsList.style.display = "block";
    callsList.innerHTML = calls.map(function (c) {
      const url = c.url.length > 55 ? c.url.substring(0, 55) + "…" : c.url;
      return '<div class="ci"><span class="cm">' + (c.method || c.type) + "</span> " +
             '<span class="cu">' + url + "</span></div>";
    }).join("");
  }

  function applyPhase(p) {
    phase = p;
    const hasCalls = diffCalls.length > 0;
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
    btnGenerate.disabled = !hasCalls;
    btnExport.disabled   = !hasCalls;
    btnClear.disabled    = false;
  }

  // ─── CustomEvent bridge ──────────────────────────────────────────────────

  function sendCmd(cmd, extra) {
    window.dispatchEvent(new CustomEvent("jaal:recorder:cmd", {
      detail: Object.assign({ cmd: cmd }, extra || {})
    }));
  }

  window.addEventListener("jaal:recorder:evt", function (evt) {
    if (!evt || !evt.detail) return;
    const e = evt.detail;

    if (e.event === "ready") {
      const count = e.count || 0;
      setStatus("Recording — " + count + " call(s) captured so far.");
      btnBefore.disabled = false;
      btnClear.disabled  = false;
      if (count > 0) {
        btnGenerate.disabled = false;
        btnExport.disabled   = false;
      }
      log.info("recorder_ready", { phase: "init", count: count });

    } else if (e.event === "snapshot-before-done") {
      applyPhase("before");
      setStatus("✅ Start marked (" + e.count + " calls). Perform your action, then click ②.");
      log.info("snapshot_before", { phase: "mutate", count: e.count });

    } else if (e.event === "diff-result") {
      diffCalls = e.calls || [];
      applyPhase("result");
      setStatus("Diff: " + diffCalls.length + " new call(s).");
      renderCalls(diffCalls);
      log.info("diff_captured", { phase: "mutate", count: diffCalls.length });

    } else if (e.event === "snapshot-result") {
      diffCalls = e.calls || [];
      applyPhase("result");
      setStatus("Snapshot: " + diffCalls.length + " total call(s).");
      renderCalls(diffCalls);

    } else if (e.event === "cleared") {
      diffCalls = [];
      applyPhase("idle");
      setStatus("Cleared. Recording from now.");
      callsList.style.display = "none";
      callsList.innerHTML = "";
      btnGenerate.disabled = true;
      btnExport.disabled   = true;
      log.info("recorder_cleared", { phase: "mutate" });
    }
  });

  // ─── Button handlers ─────────────────────────────────────────────────────

  btnBefore.addEventListener("click", function () {
    setStatus("Marking start…");
    sendCmd("snapshot-before");
  });

  btnDiff.addEventListener("click", function () {
    setStatus("Computing diff…");
    sendCmd("diff");
  });

  btnGenerate.addEventListener("click", function () {
    if (!diffCalls.length) { setStatus("No calls to replay yet."); return; }
    if (!window.Jaal || !window.Jaal.NetReplayer) {
      setStatus("⚠ NetReplayer module not available.");
      log.error("generate_failed", { phase: "error", reason: "NetReplayer missing" });
      return;
    }
    const script = window.Jaal.NetReplayer.generateScript(diffCalls, {
      label: "Jaal replayer — " + window.location.hostname,
    });
    const blob = new Blob([script], { type: "text/javascript" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url;
    a.download = "jaal-replayer-" + Date.now() + ".js";
    a.click();
    URL.revokeObjectURL(url);
    setStatus("✓ Replayer script downloaded.");
    log.info("replayer_generated", { phase: "mutate", count: diffCalls.length });
  });

  btnExport.addEventListener("click", function () {
    if (!diffCalls.length) { setStatus("No calls to export."); return; }
    const payload = {
      exported: new Date().toISOString(),
      url: window.location.href,
      calls: diffCalls,
    };
    const json = JSON.stringify(payload, null, 2);
    navigator.clipboard.writeText(json).then(function () {
      setStatus("✓ Copied JSON to clipboard.");
    }).catch(function () {
      const blob = new Blob([json], { type: "application/json" });
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u; a.download = "jaal-calls-" + Date.now() + ".json";
      a.click(); URL.revokeObjectURL(u);
      setStatus("✓ Downloaded JSON.");
    });
    const ts = new Date().toISOString();
    saveExportTs(ts);
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
        if (!confirm("Import " + data.calls.length + " calls from backup? This replaces the current diff.")) return;
        diffCalls = data.calls;
        applyPhase("result");
        setStatus("Imported " + diffCalls.length + " calls from backup.");
        renderCalls(diffCalls);
        log.info("calls_imported", { phase: "mutate", count: diffCalls.length });
      } catch (err) {
        setStatus("⚠ Import failed: " + err.message);
        log.error("import_failed", { phase: "error", error: err.message });
      }
      importFile.value = "";
    };
    reader.readAsText(file);
  });

  btnClear.addEventListener("click", function () {
    if (!confirm("Clear all captured calls and the before-snapshot?")) return;
    sendCmd("clear");
  });

  // ─── Expose + init ───────────────────────────────────────────────────────

  window.Jaal = window.Jaal || {};
  window.Jaal.netRecorderOverlay = {
    show: function () { host.style.display = ""; },
    hide: function () { host.style.display = "none"; },
  };

  // Request init — net-recorder-main.js should already be running.
  sendCmd("init");

  log.info("net_recorder_overlay_loaded", { phase: "init" });
})();
