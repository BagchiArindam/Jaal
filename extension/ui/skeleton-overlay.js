/**
 * extension/ui/skeleton-overlay.js — floating DOM skeleton overlay, extension flavor.
 *
 * Three modes toggled via [Tree][Overlay][Panel] buttons:
 *   Tree    — existing ASCII tree in a floating panel (unchanged)
 *   Overlay — translucent bordered boxes drawn over real page elements using
 *             getBoundingClientRect(); redraws on resize/scroll
 *   Panel   — scaled SVG wireframe in a shadow-DOM panel; copy/download SVG
 *
 * Depends on window.Jaal.skeleton.inspect() and window.Jaal.skeleton.collectVisualBlocks().
 * Exposes: window.Jaal.skeletonOverlay.show() / .hide()
 */
(function () {
  "use strict";

  const ID         = "jaal-skeleton";
  const OVERLAY_ID = ID + "-overlay";
  const STORAGE_KEYS = {
    maxDepth:          ID + ".maxDepth",
    collapseThreshold: ID + ".collapseThreshold",
    results:           ID + ".results",
    lastBackupAt:      ID + ".lastBackupAt",
    mode:              ID + ".mode",
  };
  const MAX_DEPTH_DEFAULT        = 8;
  const COLLAPSE_THRESHOLD_DEFAULT = 3;
  const MAX_RESULTS_STORED       = 10;

  const B = typeof browser !== "undefined" ? browser : chrome;
  const hasExtStorage = !!(B && B.storage && B.storage.local);

  const _root = (typeof globalThis !== "undefined") ? globalThis : window;

  const log = (_root.Jaal && _root.Jaal.makeLogger)
    ? _root.Jaal.makeLogger("skeleton-overlay")
    : console;

  let settings    = { maxDepth: MAX_DEPTH_DEFAULT, collapseThreshold: COLLAPSE_THRESHOLD_DEFAULT };
  let storedResults = [];
  let lastBackupAt  = null;
  let stateLoaded   = false;
  let _mode         = "tree"; // "tree" | "overlay" | "panel"

  // ─── storage helpers ─────────────────────────────────────────────────────

  function _storageGet(keys) {
    return new Promise(function (resolve) {
      if (!hasExtStorage) return resolve({});
      try { B.storage.local.get(keys, function (items) { resolve(items || {}); }); }
      catch (_) { resolve({}); }
    });
  }

  function _storageSet(obj) {
    return new Promise(function (resolve) {
      if (!hasExtStorage) return resolve();
      try { B.storage.local.set(obj, function () { resolve(); }); }
      catch (_) { resolve(); }
    });
  }

  async function loadState() {
    const items = await _storageGet(Object.values(STORAGE_KEYS));
    settings = {
      maxDepth:          Number(items[STORAGE_KEYS.maxDepth])          || MAX_DEPTH_DEFAULT,
      collapseThreshold: Number(items[STORAGE_KEYS.collapseThreshold]) || COLLAPSE_THRESHOLD_DEFAULT,
    };
    storedResults = Array.isArray(items[STORAGE_KEYS.results]) ? items[STORAGE_KEYS.results] : [];
    lastBackupAt  = items[STORAGE_KEYS.lastBackupAt] || null;
    _mode         = items[STORAGE_KEYS.mode] || "tree";
    stateLoaded   = true;
    log.info && log.info("state_loaded", { phase: "init", storedCount: storedResults.length, mode: _mode });
  }

  // ─── utils ───────────────────────────────────────────────────────────────

  function formatRelTime(isoStr) {
    if (!isoStr) return "Never";
    const diffMs  = Date.now() - new Date(isoStr).getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1)  return "just now";
    if (diffMin < 60) return diffMin + "m ago";
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24)   return diffH + "h ago";
    return Math.floor(diffH / 24) + "d ago";
  }

  function el(tag, attrs, text) {
    const e = document.createElement(tag);
    if (attrs) Object.assign(e, attrs);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function btn(label, style, onClick) {
    const b = el("button", { onclick: onClick }, label);
    b.style.cssText = "padding:3px 9px; border:none; border-radius:4px; cursor:pointer; font-size:11px; font-family:inherit; " + (style || "");
    return b;
  }

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 500);
  }

  function downloadJson(filename, payload) {
    downloadBlob(filename, new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  }

  async function copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (_) { return false; }
  }

  // ─── inspection ──────────────────────────────────────────────────────────

  function runInspection() {
    if (!_root.Jaal || !_root.Jaal.skeleton) {
      throw new Error("Jaal.skeleton not loaded — shared/skeleton.js should be injected first");
    }
    const result = _root.Jaal.skeleton.inspect(document.body, settings);
    storedResults.unshift({ url: result.url, capturedAt: result.capturedAt, tree: result.tree });
    if (storedResults.length > MAX_RESULTS_STORED) storedResults = storedResults.slice(0, MAX_RESULTS_STORED);
    _storageSet({ [STORAGE_KEYS.results]: storedResults });
    log.info && log.info("inspection_complete", { phase: "mutate", storedCount: storedResults.length });
    return result;
  }

  // ─── OVERLAY mode ─────────────────────────────────────────────────────────

  let _overlayContainer = null;
  let _dimStyleEl       = null;
  let _redrawPending    = false;

  function _buildOverlayBoxes(blocks) {
    if (!_overlayContainer) return;
    _overlayContainer.innerHTML = "";
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var hue   = b.hue || 210;
      var alpha = Math.max(0.08, 0.55 - b.depth * 0.06);
      var box   = document.createElement("div");
      box.style.cssText = [
        "position:fixed",
        "left:" + b.x + "px",
        "top:"  + b.y + "px",
        "width:"  + b.w + "px",
        "height:" + b.h + "px",
        "border:1px dashed hsla(" + hue + ",80%,55%," + Math.min(0.9, alpha * 4) + ")",
        "background:hsla(" + hue + ",80%,55%," + (alpha * 0.3) + ")",
        "box-sizing:border-box",
        "pointer-events:none",
        "z-index:2147483640",
        "overflow:hidden",
      ].join(";");

      // Label
      if (b.w > 30 && b.h > 18) {
        var lbl = document.createElement("span");
        lbl.textContent = b.label;
        lbl.style.cssText = [
          "position:absolute",
          "top:1px",
          "left:2px",
          "font:8px/1 monospace",
          "color:hsla(" + hue + ",80%,30%,0.85)",
          "white-space:nowrap",
          "overflow:hidden",
          "max-width:" + (b.w - 4) + "px",
          "pointer-events:none",
          "user-select:none",
        ].join(";");
        box.appendChild(lbl);
      }
      _overlayContainer.appendChild(box);
    }
  }

  function _redrawOverlay() {
    if (_redrawPending || !_overlayContainer) return;
    _redrawPending = true;
    requestAnimationFrame(function () {
      _redrawPending = false;
      if (!_overlayContainer || !_root.Jaal || !_root.Jaal.skeleton) return;
      var blocks = _root.Jaal.skeleton.collectVisualBlocks(document.body);
      _buildOverlayBoxes(blocks);
    });
  }

  function _showOverlayMode() {
    _removeOverlayMode();
    _overlayContainer = document.createElement("div");
    _overlayContainer.id = ID + "-boxes";
    _overlayContainer.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483640";
    document.body.appendChild(_overlayContainer);

    var blocks = _root.Jaal.skeleton.collectVisualBlocks(document.body);
    _buildOverlayBoxes(blocks);

    window.addEventListener("resize", _redrawOverlay, { passive: true });
    window.addEventListener("scroll", _redrawOverlay, { passive: true });
    log.info && log.info("overlay_mode_started", { phase: "mutate", blocks: blocks.length });
  }

  function _removeOverlayMode() {
    window.removeEventListener("resize", _redrawOverlay);
    window.removeEventListener("scroll", _redrawOverlay);
    if (_overlayContainer) { _overlayContainer.remove(); _overlayContainer = null; }
    if (_dimStyleEl)       { _dimStyleEl.remove();       _dimStyleEl = null; }
  }

  function _toggleDim(on) {
    if (on) {
      if (_dimStyleEl) return;
      _dimStyleEl = document.createElement("style");
      _dimStyleEl.id = ID + "-dim";
      _dimStyleEl.textContent = "body { filter: grayscale(1) opacity(0.15) !important; transition: filter 0.3s; }";
      document.head.appendChild(_dimStyleEl);
    } else {
      if (_dimStyleEl) { _dimStyleEl.remove(); _dimStyleEl = null; }
    }
  }

  // ─── PANEL mode ───────────────────────────────────────────────────────────

  let _panelHost = null;

  function _buildSvg(blocks, viewW, viewH, svgW, svgH) {
    const scaleX = svgW / Math.max(viewW, 1);
    const scaleY = svgH / Math.max(viewH, 1);
    const scale  = Math.min(scaleX, scaleY) * 0.95;
    const offX   = (svgW - viewW * scale) / 2;
    const offY   = (svgH - viewH * scale) / 2;

    let svgParts = ['<svg xmlns="http://www.w3.org/2000/svg"',
      ' width="' + svgW + '" height="' + svgH + '"',
      ' viewBox="0 0 ' + svgW + ' ' + svgH + '"',
      ' style="background:#1e1e2e;">',
    ];

    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var rx = Math.round(offX + b.x * scale);
      var ry = Math.round(offY + b.y * scale);
      var rw = Math.max(2, Math.round(b.w * scale));
      var rh = Math.max(2, Math.round(b.h * scale));
      var hue = b.hue || 210;
      var alpha = Math.max(0.1, 0.6 - b.depth * 0.07);

      svgParts.push(
        '<rect x="' + rx + '" y="' + ry + '" width="' + rw + '" height="' + rh + '"' +
        ' fill="hsla(' + hue + ',70%,55%,' + (alpha * 0.25) + ')"' +
        ' stroke="hsla(' + hue + ',70%,60%,' + (alpha * 0.9) + ')"' +
        ' stroke-width="1" rx="2"/>'
      );
      // Label if box is big enough
      if (rw > 16 && rh > 12) {
        var maxChars = Math.floor(rw / 5);
        var lbl = b.label.length > maxChars ? b.label.substring(0, maxChars - 1) + "…" : b.label;
        svgParts.push(
          '<text x="' + (rx + 2) + '" y="' + (ry + 9) + '"' +
          ' font-size="7" font-family="monospace"' +
          ' fill="hsla(' + hue + ',60%,80%,0.8)"' +
          ' clip-path="url(#clip' + i + ')">' +
          lbl.replace(/&/g, "&amp;").replace(/</g, "&lt;") + '</text>'
        );
      }
    }
    svgParts.push('</svg>');
    return svgParts.join("");
  }

  function _showPanelMode() {
    _removePanelMode();
    const blocks = _root.Jaal.skeleton.collectVisualBlocks(document.body);
    const viewW  = window.innerWidth;
    const viewH  = window.innerHeight;
    const SVG_W  = 280;
    const SVG_H  = 420;
    const svgSrc = _buildSvg(blocks, viewW, viewH, SVG_W, SVG_H);

    _panelHost = document.createElement("div");
    _panelHost.id = ID + "-panel";
    document.body.appendChild(_panelHost);

    const shadow = _panelHost.attachShadow({ mode: "open" });
    shadow.innerHTML = `
<style>
  :host { all: initial; }
  #panel {
    position: fixed; top: 12px; right: 12px; z-index: 2147483646;
    width: 310px; background: #1e1e2e; border: 1px solid #45475a;
    border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.6);
    display: flex; flex-direction: column; overflow: hidden;
    font-family: monospace; font-size: 11px; color: #cdd6f4;
    user-select: none;
  }
  #hdr {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px; background: #313244; border-radius: 8px 8px 0 0;
    cursor: move; flex-shrink: 0;
  }
  #title { flex: 1; font-weight: bold; color: #cba6f7; }
  #close { cursor: pointer; opacity: 0.6; font-size: 14px; }
  #close:hover { opacity: 1; }
  #svg-wrap { padding: 6px; background: #1e1e2e; }
  #footer {
    display: flex; gap: 4px; padding: 5px 8px;
    background: #313244; border-top: 1px solid #45475a; flex-shrink: 0;
  }
  .fpbtn {
    flex: 1; padding: 3px 6px; border: none; border-radius: 4px;
    cursor: pointer; font: 11px monospace; background: #45475a; color: #cdd6f4;
  }
  .fpbtn:hover { background: #585b70; }
</style>
<div id="panel">
  <div id="hdr"><span id="title">🔍 Jaal Skeleton · Panel</span><span id="close">✕</span></div>
  <div id="svg-wrap"></div>
  <div id="footer">
    <button class="fpbtn" id="btn-copy">📋 Copy SVG</button>
    <button class="fpbtn" id="btn-dl">⬇ Download</button>
    <button class="fpbtn" id="btn-refresh">↺ Refresh</button>
  </div>
</div>`;

    shadow.getElementById("svg-wrap").innerHTML = svgSrc;
    shadow.getElementById("close").addEventListener("click", function () { _removePanelMode(); });

    shadow.getElementById("btn-copy").addEventListener("click", function () {
      copyToClipboard(svgSrc).then(function (ok) {
        shadow.getElementById("btn-copy").textContent = ok ? "✓ Copied" : "✗ Failed";
        setTimeout(function () { shadow.getElementById("btn-copy").textContent = "📋 Copy SVG"; }, 1500);
      });
    });

    shadow.getElementById("btn-dl").addEventListener("click", function () {
      downloadBlob("jaal-skeleton-" + Date.now() + ".svg", new Blob([svgSrc], { type: "image/svg+xml" }));
    });

    shadow.getElementById("btn-refresh").addEventListener("click", function () {
      _showPanelMode();
    });

    // Drag
    const panelEl = shadow.getElementById("panel");
    const hdrEl   = shadow.getElementById("hdr");
    let dragging = false, dox = 0, doy = 0;
    hdrEl.addEventListener("mousedown", function (e) {
      if (e.target.tagName === "BUTTON" || e.target.id === "close") return;
      dragging = true;
      const r = panelEl.getBoundingClientRect();
      dox = e.clientX - r.left; doy = e.clientY - r.top;
    });
    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      panelEl.style.left  = (e.clientX - dox) + "px";
      panelEl.style.top   = (e.clientY - doy) + "px";
      panelEl.style.right = "auto";
    });
    document.addEventListener("mouseup", function () { dragging = false; });

    log.info && log.info("panel_mode_started", { phase: "mutate", blocks: blocks.length });
  }

  function _removePanelMode() {
    if (_panelHost) { _panelHost.remove(); _panelHost = null; }
  }

  // ─── TREE mode overlay UI ─────────────────────────────────────────────────

  function removeOverlay() {
    const existing = document.getElementById(OVERLAY_ID);
    if (existing) existing.remove();
    _removeOverlayMode();
    _removePanelMode();
  }

  function renderOverlay(result) {
    removeOverlay();

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = [
      "position:fixed; top:12px; right:12px; z-index:2147483646;",
      "width:520px; max-height:82vh;",
      "background:#1e1e2e; color:#cdd6f4;",
      "font-family:'Cascadia Code','Fira Code','Consolas',monospace; font-size:12px;",
      "border:1px solid #45475a; border-radius:8px;",
      "box-shadow:0 10px 40px rgba(0,0,0,0.6);",
      "display:flex; flex-direction:column; overflow:hidden;",
    ].join(" ");

    // Header
    const header = document.createElement("div");
    header.style.cssText = "padding:8px 10px; background:#313244; border-radius:8px 8px 0 0; display:flex; align-items:center; gap:6px; flex-shrink:0; flex-wrap:wrap;";

    const title = el("span", null, "🔍 Jaal Skeleton");
    title.style.cssText = "font-weight:bold; color:#cba6f7; white-space:nowrap;";

    const urlLabel = el("span", null, result.url);
    urlLabel.style.cssText = "flex:1; color:#6c7086; font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:60px;";

    // Mode toggle buttons
    const modeBar = document.createElement("div");
    modeBar.style.cssText = "display:flex; gap:3px;";

    function modeBtn(label, modeVal) {
      const b = btn(label, "", function () {
        _mode = modeVal;
        _storageSet({ [STORAGE_KEYS.mode]: _mode });
        // Update active styling
        modeBar.querySelectorAll("button").forEach(function (bb) {
          bb.style.background = bb.textContent === label ? "#3b82f6" : "#45475a";
          bb.style.color      = "#cdd6f4";
        });
        if (modeVal === "tree") {
          _removeOverlayMode(); _removePanelMode();
        } else if (modeVal === "overlay") {
          _removePanelMode();
          _showOverlayMode();
        } else if (modeVal === "panel") {
          _removeOverlayMode();
          _showPanelMode();
        }
      });
      b.style.background = (_mode === modeVal) ? "#3b82f6" : "#45475a";
      b.style.color      = "#cdd6f4";
      return b;
    }

    const btnTree    = modeBtn("Tree",    "tree");
    const btnOverlay = modeBtn("Overlay", "overlay");
    const btnPanel   = modeBtn("Panel",   "panel");
    modeBar.append(btnTree, btnOverlay, btnPanel);

    // Dim toggle (only for overlay mode)
    const btnDim = btn("Dim", "background:#45475a; color:#cdd6f4;", function () {
      const dimOn = !!_dimStyleEl;
      _toggleDim(!dimOn);
      this.style.background = !dimOn ? "#f59e0b" : "#45475a";
    });
    btnDim.title = "Dim page so overlay pops";

    const btnCopyTree = btn("📋 Tree", "background:#45475a; color:#cdd6f4;", async function () {
      const ok = await copyToClipboard(result.tree);
      this.textContent = ok ? "✓ Copied" : "✗ Failed";
      setTimeout(function () { this.textContent = "📋 Tree"; }.bind(this), 1500);
    });

    const btnCopyJson = btn("📋 JSON", "background:#45475a; color:#cdd6f4;", async function () {
      const payload = { url: result.url, capturedAt: result.capturedAt, settings: result.settings, tree: result.treeJson };
      const ok = await copyToClipboard(JSON.stringify(payload, null, 2));
      this.textContent = ok ? "✓ Copied" : "✗ Failed";
      setTimeout(function () { this.textContent = "📋 JSON"; }.bind(this), 1500);
    });

    const btnSettingsToggle = btn("⚙️", "background:#45475a; color:#cdd6f4;", function () {
      const panel = document.getElementById(ID + "-settings");
      panel.style.display = panel.style.display === "none" ? "block" : "none";
    });

    const btnClose = btn("✕", "background:#f38ba8; color:#1e1e2e; font-weight:bold;", removeOverlay);

    header.append(title, urlLabel, modeBar, btnDim, btnCopyTree, btnCopyJson, btnSettingsToggle, btnClose);

    // Settings panel (hidden by default)
    const settingsPanel = document.createElement("div");
    settingsPanel.id = ID + "-settings";
    settingsPanel.style.cssText = "display:none; padding:10px 12px; background:#181825; border-bottom:1px solid #313244; flex-shrink:0;";

    const configRow = document.createElement("div");
    configRow.style.cssText = "display:grid; grid-template-columns:auto 1fr auto 1fr; gap:6px 10px; align-items:center; margin-bottom:10px;";

    function numInput(eid, value, onchange) {
      const inp = document.createElement("input");
      inp.type = "number"; inp.min = "1"; inp.max = "20"; inp.value = value; inp.id = eid;
      inp.style.cssText = "width:50px; padding:2px 4px; background:#313244; color:#cdd6f4; border:1px solid #45475a; border-radius:4px; font-family:inherit;";
      inp.onchange = onchange;
      return inp;
    }

    const lblDepth    = el("label", null, "Max depth");
    lblDepth.style.cssText = "color:#a6adc8; font-size:11px;";
    const inpDepth    = numInput(ID + "-inp-depth", settings.maxDepth, function () {
      settings.maxDepth = parseInt(this.value) || MAX_DEPTH_DEFAULT;
      _storageSet({ [STORAGE_KEYS.maxDepth]: settings.maxDepth });
    });

    const lblCollapse = el("label", null, "Collapse ≥");
    lblCollapse.style.cssText = "color:#a6adc8; font-size:11px;";
    const inpCollapse = numInput(ID + "-inp-collapse", settings.collapseThreshold, function () {
      settings.collapseThreshold = parseInt(this.value) || COLLAPSE_THRESHOLD_DEFAULT;
      _storageSet({ [STORAGE_KEYS.collapseThreshold]: settings.collapseThreshold });
    });

    configRow.append(lblDepth, inpDepth, lblCollapse, inpCollapse);

    // Backup row
    const backupRow = document.createElement("div");
    backupRow.style.cssText = "display:flex; gap:6px; align-items:center;";

    const syncIndicator = el("span", { id: ID + "-sync-indicator" }, "💾 " + (lastBackupAt ? formatRelTime(lastBackupAt) : "Never exported"));
    syncIndicator.style.cssText = "font-size:10px; color:#6c7086; margin-left:4px;";

    const btnExport = btn("📥 Export data", "background:#a6e3a1; color:#1e1e2e;", async function () {
      const data = { version: 1, exportedAt: new Date().toISOString(), results: storedResults, settings };
      const filename = "jaal-skeleton-backup-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
      downloadJson(filename, data);
      lastBackupAt = new Date().toISOString();
      await _storageSet({ [STORAGE_KEYS.lastBackupAt]: lastBackupAt });
      syncIndicator.textContent = "💾 just now";
      this.textContent = "✓ Exported";
      setTimeout(function () { this.textContent = "📥 Export data"; }.bind(this), 1500);
    });

    const importFile = document.createElement("input");
    importFile.type = "file"; importFile.accept = ".json";
    importFile.style.display = "none"; importFile.id = ID + "-import-file";
    importFile.onchange = function () {
      const file = this.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async function (e) {
        try {
          const data = JSON.parse(e.target.result);
          if (!data.version || !Array.isArray(data.results)) throw new Error("Invalid format");
          if (!confirm("[Jaal] Import " + data.results.length + " results? This replaces current stored data.")) return;
          storedResults = data.results;
          await _storageSet({ [STORAGE_KEYS.results]: storedResults });
          if (data.settings) {
            settings = Object.assign({}, settings, data.settings);
            await _storageSet({ [STORAGE_KEYS.maxDepth]: settings.maxDepth, [STORAGE_KEYS.collapseThreshold]: settings.collapseThreshold });
            const d = document.getElementById(ID + "-inp-depth");
            const c = document.getElementById(ID + "-inp-collapse");
            if (d) d.value = settings.maxDepth;
            if (c) c.value = settings.collapseThreshold;
          }
          alert("[Jaal] Imported " + storedResults.length + " results.");
        } catch (err) {
          alert("[Jaal] Import failed: " + err.message);
        }
      };
      reader.readAsText(file);
    };

    const btnImport = btn("📤 Import backup", "background:#89dceb; color:#1e1e2e;", function () {
      document.getElementById(ID + "-import-file").click();
    });

    backupRow.append(btnExport, btnImport, importFile, syncIndicator);
    settingsPanel.append(configRow, backupRow);

    // Tree content
    const content = document.createElement("pre");
    content.style.cssText = "margin:0; padding:10px 12px; overflow:auto; flex:1; font-size:11px; line-height:1.6; white-space:pre; color:#cdd6f4;";
    content.textContent = result.tree;

    // Footer
    const footer = el("div", null, "Captured " + new Date(result.capturedAt).toLocaleTimeString() + " — " + result.url.replace(/^https?:\/\//, "").substring(0, 60));
    footer.style.cssText = "padding:4px 12px; font-size:10px; color:#45475a; border-top:1px solid #313244; flex-shrink:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";

    overlay.append(header, settingsPanel, content, footer);
    document.body.appendChild(overlay);

    // Auto-activate the saved mode
    if (_mode === "overlay") {
      _showOverlayMode();
      btnOverlay.style.background = "#3b82f6";
    } else if (_mode === "panel") {
      _showPanelMode();
      btnPanel.style.background = "#3b82f6";
    }

    // Blinking sync indicator
    if (lastBackupAt) {
      let v = true;
      const blink = setInterval(function () {
        if (!syncIndicator.isConnected) return clearInterval(blink);
        v = !v;
        syncIndicator.style.opacity = v ? "1" : "0.35";
      }, 900);
    }
  }

  // ─── public surface ───────────────────────────────────────────────────────

  async function show() {
    try {
      if (!stateLoaded) await loadState();
      const result = runInspection();
      renderOverlay(result);
    } catch (err) {
      console.error("[Jaal skeleton-overlay] show failed:", err);
      alert("[Jaal] Skeleton inspector error: " + err.message);
    }
  }

  function hide() {
    removeOverlay();
  }

  function setMode(modeVal) {
    if (!["tree", "overlay", "panel"].includes(modeVal)) return;
    _mode = modeVal;
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) {
      // Overlay already shown — switch mode in-place by clicking the mode button if visible
      const modeBtn = overlay.querySelector("[data-mode=\"" + modeVal + "\"]");
      if (modeBtn) { modeBtn.click(); return; }
      if (modeVal === "overlay") _showOverlayMode();
      else if (modeVal === "panel") _showPanelMode();
    } else {
      // Show fresh with the requested mode
      show();
    }
  }

  _root.Jaal = _root.Jaal || {};
  _root.Jaal.skeletonOverlay = { show, hide, setMode };
  console.log("[Jaal] skeleton-overlay loaded");
})();
