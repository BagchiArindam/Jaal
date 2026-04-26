/**
 * extension/ui/skeleton-overlay.js — floating DOM skeleton overlay, extension flavor.
 *
 * Adapted from D:\Dev\dom-skeleton-inspector\dom-skeleton-inspector.user.js.
 * Depends on window.Jaal.skeleton.inspect() (shared/skeleton.js) for the tree logic.
 *
 * Differences from the userscript shim:
 *   - chrome.storage.local instead of GM_setValue / GM_getValue (async)
 *   - navigator.clipboard.writeText instead of GM_setClipboard
 *   - download-as-file via Blob URL instead of clipboard-only export
 *   - No GM_registerMenuCommand — entry is the context-menu click wired in background.js
 *
 * Exposes: window.Jaal.skeletonOverlay.show() / .hide()
 */
(function () {
  "use strict";

  const ID = "jaal-skeleton";
  const OVERLAY_ID = ID + "-overlay";
  const STORAGE_KEYS = {
    maxDepth: ID + ".maxDepth",
    collapseThreshold: ID + ".collapseThreshold",
    results: ID + ".results",
    lastBackupAt: ID + ".lastBackupAt",
  };
  const MAX_DEPTH_DEFAULT = 8;
  const COLLAPSE_THRESHOLD_DEFAULT = 3;
  const MAX_RESULTS_STORED = 10;

  const B = typeof browser !== "undefined" ? browser : chrome;
  const hasExtStorage = !!(B && B.storage && B.storage.local);

  // Firefox content scripts: window !== globalThis. shared/ files all register
  // on globalThis, so we must read/write through the same root.
  const _root = (typeof globalThis !== "undefined") ? globalThis : window;

  const log = (_root.Jaal && _root.Jaal.makeLogger)
    ? _root.Jaal.makeLogger("skeleton-overlay")
    : console;

  // In-memory mirror of persistent state (filled by loadState on first show)
  let settings = { maxDepth: MAX_DEPTH_DEFAULT, collapseThreshold: COLLAPSE_THRESHOLD_DEFAULT };
  let storedResults = [];
  let lastBackupAt = null;
  let stateLoaded = false;

  // ─── storage helpers ─────────────────────────────────────────────────────

  function _storageGet(keys) {
    return new Promise((resolve) => {
      if (!hasExtStorage) return resolve({});
      try {
        B.storage.local.get(keys, (items) => resolve(items || {}));
      } catch (_) { resolve({}); }
    });
  }

  function _storageSet(obj) {
    return new Promise((resolve) => {
      if (!hasExtStorage) return resolve();
      try {
        B.storage.local.set(obj, () => resolve());
      } catch (_) { resolve(); }
    });
  }

  async function loadState() {
    const items = await _storageGet(Object.values(STORAGE_KEYS));
    settings = {
      maxDepth: Number(items[STORAGE_KEYS.maxDepth]) || MAX_DEPTH_DEFAULT,
      collapseThreshold: Number(items[STORAGE_KEYS.collapseThreshold]) || COLLAPSE_THRESHOLD_DEFAULT,
    };
    storedResults = Array.isArray(items[STORAGE_KEYS.results]) ? items[STORAGE_KEYS.results] : [];
    lastBackupAt = items[STORAGE_KEYS.lastBackupAt] || null;
    stateLoaded = true;
    log.info && log.info("state_loaded", { phase: "init", storedCount: storedResults.length });
  }

  // ─── utils ───────────────────────────────────────────────────────────────

  function formatRelTime(isoStr) {
    if (!isoStr) return "Never";
    const diffMs = Date.now() - new Date(isoStr).getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return diffMin + "m ago";
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return diffH + "h ago";
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

  function downloadJson(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      log.warn && log.warn("clipboard_failed", { phase: "mutate", err: String(e) });
      return false;
    }
  }

  // ─── inspection ──────────────────────────────────────────────────────────

  function runInspection() {
    if (!_root.Jaal || !_root.Jaal.skeleton) {
      throw new Error("Jaal.skeleton not loaded — shared/skeleton.js should be injected first");
    }
    const result = _root.Jaal.skeleton.inspect(document.body, settings);
    // Persist into results history (cap at MAX_RESULTS_STORED)
    storedResults.unshift({
      url: result.url,
      capturedAt: result.capturedAt,
      tree: result.tree,
    });
    if (storedResults.length > MAX_RESULTS_STORED) {
      storedResults = storedResults.slice(0, MAX_RESULTS_STORED);
    }
    _storageSet({ [STORAGE_KEYS.results]: storedResults });
    log.info && log.info("inspection_complete", {
      phase: "mutate",
      topLevelChildren: (result.treeJson && result.treeJson.children || []).length,
      storedCount: storedResults.length,
    });
    return result;
  }

  // ─── overlay UI ──────────────────────────────────────────────────────────

  function removeOverlay() {
    const existing = document.getElementById(OVERLAY_ID);
    if (existing) existing.remove();
  }

  function renderOverlay(result) {
    removeOverlay();

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = [
      "position:fixed; top:12px; right:12px; z-index:2147483647;",
      "width:520px; max-height:82vh;",
      "background:#1e1e2e; color:#cdd6f4;",
      "font-family:'Cascadia Code','Fira Code','Consolas',monospace; font-size:12px;",
      "border:1px solid #45475a; border-radius:8px;",
      "box-shadow:0 10px 40px rgba(0,0,0,0.6);",
      "display:flex; flex-direction:column; overflow:hidden;",
    ].join(" ");

    // Header
    const header = document.createElement("div");
    header.style.cssText = "padding:8px 10px; background:#313244; border-radius:8px 8px 0 0; display:flex; align-items:center; gap:6px; flex-shrink:0;";

    const title = el("span", null, "🔍 Jaal Skeleton");
    title.style.cssText = "font-weight:bold; color:#cba6f7; white-space:nowrap;";

    const urlLabel = el("span", null, result.url);
    urlLabel.style.cssText = "flex:1; color:#6c7086; font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";

    const btnCopyTree = btn("📋 Tree", "background:#45475a; color:#cdd6f4;", async function () {
      const ok = await copyToClipboard(result.tree);
      this.textContent = ok ? "✓ Copied" : "✗ Failed";
      setTimeout(() => { this.textContent = "📋 Tree"; }, 1500);
    });

    const btnCopyJson = btn("📋 JSON", "background:#45475a; color:#cdd6f4;", async function () {
      const payload = {
        url: result.url,
        capturedAt: result.capturedAt,
        settings: result.settings,
        tree: result.treeJson,
      };
      const ok = await copyToClipboard(JSON.stringify(payload, null, 2));
      this.textContent = ok ? "✓ Copied" : "✗ Failed";
      setTimeout(() => { this.textContent = "📋 JSON"; }, 1500);
    });

    const btnSettings = btn("⚙️", "background:#45475a; color:#cdd6f4;", function () {
      const panel = document.getElementById(ID + "-settings");
      panel.style.display = panel.style.display === "none" ? "block" : "none";
    });

    const btnClose = btn("✕", "background:#f38ba8; color:#1e1e2e; font-weight:bold;", removeOverlay);

    header.append(title, urlLabel, btnCopyTree, btnCopyJson, btnSettings, btnClose);

    // Settings panel (hidden by default)
    const settingsPanel = document.createElement("div");
    settingsPanel.id = ID + "-settings";
    settingsPanel.style.cssText = "display:none; padding:10px 12px; background:#181825; border-bottom:1px solid #313244; flex-shrink:0;";

    const configRow = document.createElement("div");
    configRow.style.cssText = "display:grid; grid-template-columns:auto 1fr auto 1fr; gap:6px 10px; align-items:center; margin-bottom:10px;";

    function numInput(eid, value, onchange) {
      const inp = document.createElement("input");
      inp.type = "number"; inp.min = "1"; inp.max = "20"; inp.value = value;
      inp.id = eid;
      inp.style.cssText = "width:50px; padding:2px 4px; background:#313244; color:#cdd6f4; border:1px solid #45475a; border-radius:4px; font-family:inherit;";
      inp.onchange = onchange;
      return inp;
    }

    const lblDepth = el("label", null, "Max depth");
    lblDepth.style.cssText = "color:#a6adc8; font-size:11px;";
    const inpDepth = numInput(ID + "-inp-depth", settings.maxDepth, function () {
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
      const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
        results: storedResults,
        settings,
      };
      const filename = `jaal-skeleton-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      downloadJson(filename, data);
      lastBackupAt = new Date().toISOString();
      await _storageSet({ [STORAGE_KEYS.lastBackupAt]: lastBackupAt });
      syncIndicator.textContent = "💾 just now";
      this.textContent = "✓ Exported";
      setTimeout(() => { this.textContent = "📥 Export data"; }, 1500);
      log.info && log.info("export_data", { phase: "mutate", count: storedResults.length });
    });

    const importFile = document.createElement("input");
    importFile.type = "file"; importFile.accept = ".json";
    importFile.style.display = "none";
    importFile.id = ID + "-import-file";
    importFile.onchange = function () {
      const file = this.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async function (e) {
        try {
          const data = JSON.parse(e.target.result);
          if (!data.version || !Array.isArray(data.results)) {
            throw new Error("Invalid format — missing 'version' or 'results' fields");
          }
          if (!confirm(`[Jaal] Import ${data.results.length} results? This will replace current stored data.`)) return;
          storedResults = data.results;
          await _storageSet({ [STORAGE_KEYS.results]: storedResults });
          if (data.settings) {
            settings = Object.assign({}, settings, data.settings);
            await _storageSet({
              [STORAGE_KEYS.maxDepth]: settings.maxDepth,
              [STORAGE_KEYS.collapseThreshold]: settings.collapseThreshold,
            });
            const d = document.getElementById(ID + "-inp-depth");
            const c = document.getElementById(ID + "-inp-collapse");
            if (d) d.value = settings.maxDepth;
            if (c) c.value = settings.collapseThreshold;
          }
          alert(`[Jaal] Imported ${storedResults.length} results.`);
          log.info && log.info("import_data", { phase: "mutate", count: storedResults.length });
        } catch (err) {
          alert("[Jaal] Import failed: " + err.message);
          log.error && log.error("import_failed", { phase: "error", err: err.message });
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
    content.style.cssText = [
      "margin:0; padding:10px 12px; overflow:auto; flex:1;",
      "font-size:11px; line-height:1.6; white-space:pre;",
      "color:#cdd6f4;",
    ].join(" ");
    content.textContent = result.tree;

    // Footer
    const footer = el("div", null, "Captured " + new Date(result.capturedAt).toLocaleTimeString() + " — " + result.url.replace(/^https?:\/\//, "").substring(0, 60));
    footer.style.cssText = "padding:4px 12px; font-size:10px; color:#45475a; border-top:1px solid #313244; flex-shrink:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";

    overlay.append(header, settingsPanel, content, footer);
    document.body.appendChild(overlay);

    // Blinking sync indicator
    if (lastBackupAt) {
      let v = true;
      const blink = setInterval(() => {
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

  _root.Jaal = _root.Jaal || {};
  _root.Jaal.skeletonOverlay = { show, hide };
  console.log("[Jaal] skeleton-overlay loaded");
})();
