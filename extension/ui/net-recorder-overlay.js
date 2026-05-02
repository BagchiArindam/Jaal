/**
 * ui/net-recorder-overlay.js — network recorder floating panel.
 *
 * Runs in isolated world. Communicates with content/net-recorder-main.js
 * (MAIN world) via postMessage on the shared window object.
 *
 * Workflow:
 *   1. Panel opens → sends "init" cmd → shows live call count.
 *   2. User clicks "Start" → recording begins (captures fetch/XHR/WS/actions/transforms).
 *   3. User performs UI actions (type, click, submit).
 *   4. User clicks "Stop & export" → captures all calls since Start, auto-exports.
 *   5. "Export HAR" → downloads a HAR 1.2 compatible JSON file.
 *   6. "Export JSON" → copies captured calls to clipboard (or downloads).
 *   7. "Import JSON" → restores a prior export.
 *   8. "Generate replayer" → downloads standalone replay script.
 */
(function () {
  "use strict";

  const _root = (typeof globalThis !== "undefined") ? globalThis : window;

  if (_root.__jaalNetRecorderOverlayLoaded) {
    console.log("[Jaal net-recorder-overlay] already loaded — skipping");
    return;
  }
  _root.__jaalNetRecorderOverlayLoaded = true;

  const log = (_root.Jaal && _root.Jaal.makeLogger)
    ? _root.Jaal.makeLogger("net-recorder-overlay")
    : { info: console.log, warn: console.warn, error: console.error, debug: console.log };

  // ─── State ───────────────────────────────────────────────────────────────

  let recordedCalls = [];
  let recording     = false; // true between "start" and "stop"
  let startSnapshot = [];    // calls present at start time (for diff)

  // ─── Shadow DOM ──────────────────────────────────────────────────────────

  const host = document.createElement("div");
  host.id    = "jaal-net-recorder-host";
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
    width: 330px; user-select: none;
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
  #status.recording { background: #3d0f0f; color: #f88; }
  .row { display: flex; gap: 6px; }
  .row .btn { flex: 1; }
  .btn {
    padding: 6px 8px; border: none; border-radius: 4px;
    cursor: pointer; font: 12px monospace; transition: opacity .15s;
  }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-red    { background: #e94560; color: #fff; }
  .btn-red:hover:not(:disabled)    { background: #c73652; }
  .btn-blue   { background: #0f3460; color: #7ec8e3; }
  .btn-blue:hover:not(:disabled)   { background: #1a4a80; }
  .btn-green  { background: #27ae60; color: #fff; }
  .btn-green:hover:not(:disabled)  { background: #219150; }
  .btn-orange { background: #e67e22; color: #fff; }
  .btn-orange:hover:not(:disabled) { background: #ca6f1e; }
  #calls-list {
    display: none; max-height: 130px; overflow-y: auto;
    font-size: 10px; background: #0d0d1a;
    border-radius: 4px; padding: 6px;
  }
  .ci { padding: 2px 0; border-bottom: 1px solid #1a1a2e; }
  .ci:last-child { border-bottom: none; }
  .cm { color: #f39c12; }
  .cu { color: #bdc3c7; word-break: break-all; }
  .ca { color: #7ec8e3; }
  .ct { color: #cba6f7; }
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
      <button class="btn btn-red"   id="btn-start"   disabled>▶ Start</button>
      <button class="btn btn-blue"  id="btn-stop"    disabled>■ Stop &amp; export</button>
    </div>
    <button class="btn btn-green"   id="btn-generate" disabled>⬇ Generate replayer script</button>
    <div class="row">
      <button class="btn btn-blue"  id="btn-export"  disabled>📋 Export JSON</button>
      <button class="btn btn-orange" id="btn-har"    disabled>📦 Export HAR</button>
    </div>
    <div class="row">
      <button class="btn btn-blue"  id="btn-import">📤 Import JSON</button>
      <button class="btn btn-blue"  id="btn-clear"   disabled>Clear</button>
    </div>
    <div id="calls-list"></div>
    <div id="settings-toggle">⚙ Settings</div>
    <div id="settings-panel">
      <div id="backup-age"></div>
      <input type="file" id="import-file" accept=".json" style="display:none">
    </div>
  </div>
</div>`;

  const panel        = shadow.getElementById("panel");
  const statusEl     = shadow.getElementById("status");
  const btnStart     = shadow.getElementById("btn-start");
  const btnStop      = shadow.getElementById("btn-stop");
  const btnGenerate  = shadow.getElementById("btn-generate");
  const btnExport    = shadow.getElementById("btn-export");
  const btnHar       = shadow.getElementById("btn-har");
  const btnImport    = shadow.getElementById("btn-import");
  const btnClear     = shadow.getElementById("btn-clear");
  const callsList    = shadow.getElementById("calls-list");
  const settingsTgl  = shadow.getElementById("settings-toggle");
  const settingsPnl  = shadow.getElementById("settings-panel");
  const importFile   = shadow.getElementById("import-file");
  const backupAge    = shadow.getElementById("backup-age");
  const closeEl      = shadow.getElementById("close");

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

  settingsTgl.addEventListener("click", function () { settingsPnl.classList.toggle("open"); });

  closeEl.addEventListener("click", function () {
    host.remove();
    _root.__jaalNetRecorderOverlayLoaded = false;
    log.info("panel_closed", { phase: "teardown" });
  });

  // ─── Storage (last-export timestamp) ────────────────────────────────────

  const STORAGE_KEY = "jaal_net_recorder_export_ts";
  const hasStorage  = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

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

  function setStatus(msg, isRec) {
    statusEl.textContent = msg;
    statusEl.className   = isRec ? "recording" : "";
  }

  function renderCalls(calls) {
    if (!calls || !calls.length) { callsList.style.display = "none"; callsList.innerHTML = ""; return; }
    callsList.style.display = "block";
    const MAX_SHOW = 50;
    const shown = calls.slice(-MAX_SHOW);
    callsList.innerHTML = shown.map(function (c) {
      if (c.type === "action") {
        return '<div class="ci"><span class="ca">action</span> <span class="cu">' + c.eventType + " → " + (c.target || "") + "</span></div>";
      }
      if (c.type === "transform") {
        return '<div class="ci"><span class="ct">transform</span> <span class="cu">' + (c.fn || "") + "()</span></div>";
      }
      const url = (c.url || "").length > 50 ? (c.url || "").substring(0, 50) + "…" : (c.url || "");
      return '<div class="ci"><span class="cm">' + (c.method || c.type) + "</span> <span class=\"cu\">" + url + "</span></div>";
    }).join("");
    if (calls.length > MAX_SHOW) {
      callsList.insertAdjacentHTML("afterbegin", '<div class="ci" style="color:#6c7086">… ' + (calls.length - MAX_SHOW) + " earlier entries …</div>");
    }
  }

  function updateButtons() {
    const hasCalls = recordedCalls.length > 0;
    btnStart.disabled    = recording;
    btnStop.disabled     = !recording;
    btnGenerate.disabled = !hasCalls;
    btnExport.disabled   = !hasCalls;
    btnHar.disabled      = !hasCalls;
    btnClear.disabled    = false;
  }

  // ─── HAR 1.2 builder ─────────────────────────────────────────────────────

  function _buildHar(calls) {
    const entries = [];
    const jaalActions    = [];
    const jaalTransforms = [];

    for (var i = 0; i < calls.length; i++) {
      const c = calls[i];
      if (c.type === "action")    { jaalActions.push(c);    continue; }
      if (c.type === "transform") { jaalTransforms.push(c); continue; }

      const requestHeaders = Object.entries(c.headers || {}).map(function (kv) {
        return { name: kv[0], value: String(kv[1]) };
      });
      const responseHeaders = Object.entries(c.responseHeaders || {}).map(function (kv) {
        return { name: kv[0], value: String(kv[1]) };
      });

      const entry = {
        startedDateTime: new Date(c.ts || Date.now()).toISOString(),
        time: -1,
        request: {
          method: c.method || "GET",
          url: c.url || "",
          httpVersion: "HTTP/1.1",
          headers: requestHeaders,
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: c.body ? c.body.length : 0,
          postData: c.body ? { mimeType: c.contentType || "application/octet-stream", text: c.body } : undefined,
        },
        response: {
          status: c.status || 0,
          statusText: c.statusText || "",
          httpVersion: "HTTP/1.1",
          headers: responseHeaders,
          cookies: [],
          content: {
            size: c.responseBody ? c.responseBody.length : 0,
            mimeType: c.responseContentType || "application/octet-stream",
            text: c.responseBody || "",
            encoding: c.responseEncoding === "base64" ? "base64" : undefined,
          },
          redirectURL: "",
          headersSize: -1,
          bodySize: c.responseBody ? c.responseBody.length : 0,
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
      };
      if (!entry.request.postData) delete entry.request.postData;
      entries.push(entry);
    }

    return {
      log: {
        version: "1.2",
        creator: { name: "Jaal", version: "1.0" },
        pages: [],
        entries: entries,
        _jaalActions: jaalActions,
        _jaalTransforms: jaalTransforms,
      },
    };
  }

  function _exportHar() {
    const har  = _buildHar(recordedCalls);
    const json = JSON.stringify(har, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = "jaal-recording-" + Date.now() + ".har";
    a.click(); URL.revokeObjectURL(url);
    const ts = new Date().toISOString();
    saveExportTs(ts); refreshBackupAge();
    setStatus("✓ HAR downloaded (" + recordedCalls.length + " entries).");
    log.info("har_exported", { phase: "mutate", count: recordedCalls.length });
  }

  function _exportJson() {
    const payload = { exported: new Date().toISOString(), url: window.location.href, calls: recordedCalls };
    const json    = JSON.stringify(payload, null, 2);
    navigator.clipboard.writeText(json).then(function () {
      setStatus("✓ Copied JSON (" + recordedCalls.length + " entries) to clipboard.");
    }).catch(function () {
      const blob = new Blob([json], { type: "application/json" });
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u; a.download = "jaal-calls-" + Date.now() + ".json";
      a.click(); URL.revokeObjectURL(u);
      setStatus("✓ Downloaded JSON (" + recordedCalls.length + " entries).");
    });
    saveExportTs(new Date().toISOString()); refreshBackupAge();
    log.info("calls_exported", { phase: "mutate", count: recordedCalls.length });
  }

  // ─── Cross-world message bridge ──────────────────────────────────────────

  function sendCmd(cmd, extra) {
    window.postMessage(Object.assign({ source: "jaal-overlay", cmd: cmd }, extra || {}), "*");
  }

  window.addEventListener("message", function (evt) {
    if (!evt || !evt.data || evt.data.source !== "jaal-main") return;
    const e = evt.data;

    if (e.event === "ready") {
      setStatus("Ready — " + (e.count || 0) + " call(s) buffered.");
      btnStart.disabled = false;
      btnClear.disabled = false;
      if (e.count > 0) { btnExport.disabled = false; btnHar.disabled = false; btnGenerate.disabled = false; }
      log.info("recorder_ready", { phase: "init", count: e.count || 0 });

    } else if (e.event === "started") {
      recording     = true;
      startSnapshot = [];
      sendCmd("snapshot-before"); // capture baseline

    } else if (e.event === "snapshot-before-done") {
      startSnapshot = [];
      setStatus("⏺ Recording… click Stop & export when done.", true);
      updateButtons();
      log.info("recording_started", { phase: "mutate" });

    } else if (e.event === "stopped") {
      recording = false;
      sendCmd("diff"); // get new calls since start
      log.info("recording_stopped", { phase: "mutate" });

    } else if (e.event === "diff-result") {
      recordedCalls = e.calls || [];
      setStatus("⏹ Stopped — " + recordedCalls.length + " event(s) captured. Exporting…");
      updateButtons();
      renderCalls(recordedCalls);
      if (recordedCalls.length > 0) {
        setTimeout(_exportHar, 200); // auto-export HAR on stop
      }
      log.info("diff_captured", { phase: "mutate", count: recordedCalls.length });

    } else if (e.event === "snapshot-result") {
      recordedCalls = e.calls || [];
      setStatus("Snapshot: " + recordedCalls.length + " total event(s).");
      updateButtons();
      renderCalls(recordedCalls);

    } else if (e.event === "cleared") {
      recordedCalls = []; recording = false;
      setStatus("Cleared. Click Start to begin a new recording.");
      callsList.style.display = "none"; callsList.innerHTML = "";
      updateButtons();
      log.info("recorder_cleared", { phase: "mutate" });
    }
  });

  // ─── Button handlers ─────────────────────────────────────────────────────

  btnStart.addEventListener("click", function () {
    setStatus("Starting recording…");
    sendCmd("start");
  });

  btnStop.addEventListener("click", function () {
    setStatus("Stopping…");
    sendCmd("stop");
  });

  btnGenerate.addEventListener("click", function () {
    if (!recordedCalls.length) { setStatus("No calls to replay yet."); return; }
    if (!_root.Jaal || !_root.Jaal.NetReplayer) {
      setStatus("⚠ NetReplayer module not available.");
      return;
    }
    const calls = recordedCalls.filter(function (c) { return c.type === "fetch" || c.type === "xhr"; });
    const script = _root.Jaal.NetReplayer.generateScript(calls, { label: "Jaal replayer — " + window.location.hostname });
    const blob = new Blob([script], { type: "text/javascript" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = "jaal-replayer-" + Date.now() + ".js";
    a.click(); URL.revokeObjectURL(url);
    setStatus("✓ Replayer script downloaded.");
    log.info("replayer_generated", { phase: "mutate", count: calls.length });
  });

  btnExport.addEventListener("click", function () {
    if (!recordedCalls.length) { setStatus("No calls to export."); return; }
    _exportJson();
  });

  btnHar.addEventListener("click", function () {
    if (!recordedCalls.length) { setStatus("No calls to export."); return; }
    _exportHar();
  });

  btnImport.addEventListener("click", function () { importFile.click(); });

  importFile.addEventListener("change", function () {
    const file = importFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (ev) {
      try {
        const data = JSON.parse(ev.target.result);
        // Accept both our JSON export and HAR format
        const calls = Array.isArray(data.calls) ? data.calls
          : (data.log && Array.isArray(data.log.entries)) ? data.log.entries
          : null;
        if (!calls) throw new Error("Missing calls array or HAR entries");
        if (!confirm("Import " + calls.length + " entries? This replaces the current recording.")) return;
        recordedCalls = calls;
        updateButtons();
        setStatus("Imported " + recordedCalls.length + " entries from backup.");
        renderCalls(recordedCalls);
        log.info("calls_imported", { phase: "mutate", count: recordedCalls.length });
      } catch (err) {
        setStatus("⚠ Import failed: " + err.message);
        log.error("import_failed", { phase: "error", error: err.message });
      }
      importFile.value = "";
    };
    reader.readAsText(file);
  });

  btnClear.addEventListener("click", function () {
    if (!confirm("Clear all captured data?")) return;
    sendCmd("clear");
  });

  // ─── Expose + init ───────────────────────────────────────────────────────

  _root.Jaal = _root.Jaal || {};
  _root.Jaal.netRecorderOverlay = {
    show: function () { host.style.display = ""; },
    hide: function () { host.style.display = "none"; },
  };

  sendCmd("init");
  log.info("net_recorder_overlay_loaded", { phase: "init" });
})();
