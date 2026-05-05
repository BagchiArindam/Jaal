/**
 * extension/ui/modal.js — singleton in-page tabbed modal for Jaal.
 *
 * Public API (window.Jaal.modal):
 *   openOrFocus()                — show or create the modal
 *   close()                      — hide the modal
 *   addToolbarTab(inst)          — reparent inst.hostEl into a new toolbar tab
 *   removeToolbarTab(configId)   — remove a toolbar tab and its content
 *   activateTab(tabId)           — switch to a specific tab
 *
 * The modal hosts:
 *   - One tab per active toolbar (toolbar hostEl reparented inside)
 *   - A pinned "📁 Patterns" tab (saved configs list with ▶ Spawn)
 *   - A pinned "🛠 Tools" tab (skeleton/net-recorder buttons + server health)
 */
(function (global) {
  "use strict";

  const ns  = (global.Jaal = global.Jaal || {});
  const log = ns.makeLogger ? ns.makeLogger("modal") : console;
  const B   = typeof browser !== "undefined" ? browser : (typeof chrome !== "undefined" ? chrome : null);
  const SERVER_URL = "http://127.0.0.1:7773";

  if (ns.modal) {
    console.log("[Jaal modal] already loaded");
    return;
  }

  let _hostEl      = null;
  let _shadowRoot  = null;
  let _tabbar      = null;
  let _body        = null;
  let _minimized   = false;
  let _tabs        = []; // { id, btn, panel, inst? }
  let _activeTabId = null;

  const MODAL_CSS = `
:host {
  all: initial;
  display: block !important;
  position: fixed !important;
  bottom: 20px !important;
  right: 20px !important;
  z-index: 2147483646 !important;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
  font-size: 13px !important;
}
.jm {
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0,0,0,.22);
  width: 540px;
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  color: #1a1a2e;
  overflow: hidden;
}
.jm-header {
  display: flex;
  align-items: center;
  gap: 3px;
  background: #1a1a2e;
  color: #fff;
  padding: 6px 8px;
  cursor: grab;
  border-radius: 10px 10px 0 0;
  flex-shrink: 0;
  user-select: none;
}
.jm-header:active { cursor: grabbing; }
.jm-title { font-weight: 700; font-size: 13px; flex-shrink: 0; padding-right: 4px; }
.jm-tabbar {
  display: flex;
  flex: 1;
  overflow-x: auto;
  gap: 2px;
  align-items: center;
  min-width: 0;
}
.jm-tabbar::-webkit-scrollbar { display: none; }
.jm-tab {
  background: none;
  border: none;
  color: rgba(255,255,255,.6);
  cursor: pointer;
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 11px;
  white-space: nowrap;
  flex-shrink: 0;
  font-family: inherit;
  line-height: 1.4;
}
.jm-tab:hover { background: rgba(255,255,255,.15); color: #fff; }
.jm-tab.active { background: #2563eb; color: #fff; }
.jm-hbtn {
  background: none; border: none; color: rgba(255,255,255,.7);
  cursor: pointer; padding: 2px 5px; border-radius: 3px;
  font-size: 11px; flex-shrink: 0; font-family: inherit;
}
.jm-hbtn:hover { color: #fff; background: rgba(255,255,255,.15); }
.jm-body { flex: 1; overflow-y: auto; min-height: 40px; }
.jm.minimized .jm-body { display: none; }
/* Patterns panel */
.jm-panel { padding: 10px 12px; }
.jm-list { max-height: 420px; overflow-y: auto; margin-bottom: 4px; }
.jm-empty { text-align: center; color: #9ca3af; padding: 20px; font-style: italic; font-size: 12px; }
.jm-dh { font-weight: 600; font-size: 11px; color: #6b7280; padding: 4px 0 2px; border-bottom: 1px solid #f0f0f0; margin-bottom: 4px; }
.jm-row { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 6px 8px; margin-bottom: 4px; font-size: 11px; }
.jm-row-label { font-weight: 600; color: #1a1a2e; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.jm-row-meta { font-family: monospace; font-size: 10px; color: #6b7280; margin-bottom: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.jm-row-actions { display: flex; gap: 4px; justify-content: flex-end; flex-wrap: wrap; }
.jm-btn { background: #e5e7eb; border: 1px solid #d1d5db; border-radius: 4px; padding: 2px 7px; font-size: 10px; cursor: pointer; color: #374151; font-family: inherit; }
.jm-btn:hover { background: #d1d5db; }
.jm-btn.spawn { background: #dbeafe; border-color: #93c5fd; color: #1d4ed8; }
.jm-btn.spawn:hover { background: #bfdbfe; }
.jm-btn.danger { background: #fef2f2; border-color: #fecaca; color: #dc2626; }
.jm-btn.danger:hover { background: #fee2e2; }
.jm-footer { display: flex; gap: 6px; padding-top: 6px; border-top: 1px solid #e5e7eb; margin-top: 4px; }
.jm-footer .jm-btn { flex: 1; }
.jm-suggest { margin-top: 8px; }
.jm-suggest-title { font-size: 11px; color: #6b7280; margin-bottom: 6px; }
.jm-suggest-row { display: flex; gap: 6px; align-items: flex-start; justify-content: space-between; padding: 6px 8px; margin-top: 4px; border: 1px solid #e5e7eb; border-radius: 6px; background: #f9fafb; }
.jm-suggest-text { flex: 1; min-width: 0; font-size: 11px; color: #1a1a2e; word-break: break-word; }
.jm-suggest-meta { display: block; color: #9ca3af; font-size: 10px; margin-top: 2px; }
.jm-suggest-copy { flex-shrink: 0; }
.jm-row.editing { background: #fff; border-color: #bfdbfe; }
.jm-form { display: grid; gap: 6px; }
.jm-field { display: grid; gap: 3px; }
.jm-field label { font-size: 10px; color: #6b7280; }
.jm-field input { width: 100%; box-sizing: border-box; border: 1px solid #d1d5db; border-radius: 4px; padding: 5px 6px; font: inherit; font-size: 11px; }
.jm-form-actions { display: flex; gap: 6px; justify-content: flex-end; }
.jm-form-actions .jm-btn { flex: 0 0 auto; }
/* Tools panel */
.jm-tool-btn { display: block; width: 100%; padding: 9px 12px; margin-bottom: 6px; background: #2563eb; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-family: inherit; text-align: left; }
.jm-tool-btn:hover { background: #1d4ed8; }
.jm-health { font-size: 10px; padding: 6px 8px; border-radius: 4px; background: #f3f4f6; color: #6b7280; font-family: monospace; margin-top: 6px; }
.jm-health.online { background: #ecfdf5; color: #059669; }
.jm-health.offline { background: #fef2f2; color: #dc2626; }
`;

  function _esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function _ensureCreated() {
    if (_hostEl) return;

    _hostEl = document.createElement("div");
    _shadowRoot = _hostEl.attachShadow({ mode: "open" });

    const styleEl = document.createElement("style");
    styleEl.textContent = MODAL_CSS;
    _shadowRoot.appendChild(styleEl);

    const modal = document.createElement("div");
    modal.className = "jm";
    _shadowRoot.appendChild(modal);

    // Header
    const header = document.createElement("div");
    header.className = "jm-header";

    const titleEl = document.createElement("span");
    titleEl.className = "jm-title";
    titleEl.textContent = "Jaal";
    header.appendChild(titleEl);

    _tabbar = document.createElement("div");
    _tabbar.className = "jm-tabbar";
    header.appendChild(_tabbar);

    const minBtn = document.createElement("button");
    minBtn.className = "jm-hbtn";
    minBtn.title = "Minimize";
    minBtn.textContent = "▽";
    minBtn.addEventListener("click", function () {
      _minimized = !_minimized;
      modal.classList.toggle("minimized", _minimized);
      minBtn.textContent = _minimized ? "△" : "▽";
    });
    header.appendChild(minBtn);

    const closeBtn = document.createElement("button");
    closeBtn.className = "jm-hbtn";
    closeBtn.title = "Close Jaal panel";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", function () { _hostEl.style.display = "none"; });
    header.appendChild(closeBtn);

    modal.appendChild(header);

    _body = document.createElement("div");
    _body.className = "jm-body";
    modal.appendChild(_body);

    // Pinned static tabs (appended after any toolbar tabs)
    _addStaticTab("patterns", "📁 Patterns", _buildPatternsPanel());
    _addStaticTab("tools",    "🛠 Tools",    _buildToolsPanel());

    _setupDrag(header);

    document.body.appendChild(_hostEl);
    console.log("[Jaal modal] created");
  }

  function _addStaticTab(id, label, panelEl) {
    const btn = document.createElement("button");
    btn.className = "jm-tab";
    btn.textContent = label;
    btn.dataset.tabId = id;
    btn.addEventListener("click", function () { ns.modal.activateTab(id); });
    _tabbar.appendChild(btn);

    panelEl.dataset.tabId = id;
    panelEl.style.display = "none";
    _body.appendChild(panelEl);

    _tabs.push({ id: id, btn: btn, panel: panelEl, inst: null });
  }

  // ─── Saved Patterns panel ───────────────────────────────────────────────

  function _buildPatternsPanel() {
    const el = document.createElement("div");
    el.className = "jm-panel";

    const list = document.createElement("div");
    list.className = "jm-list";
    list.innerHTML = '<div class="jm-empty">Loading…</div>';
    el.appendChild(list);

    const footer = document.createElement("div");
    footer.className = "jm-footer";

    const exportBtn = document.createElement("button");
    exportBtn.className = "jm-btn";
    exportBtn.textContent = "Export";
    footer.appendChild(exportBtn);

    const importBtn = document.createElement("button");
    importBtn.className = "jm-btn";
    importBtn.textContent = "Import";
    footer.appendChild(importBtn);

    const importFile = document.createElement("input");
    importFile.type = "file";
    importFile.accept = ".json";
    importFile.style.display = "none";
    footer.appendChild(importFile);

    el.appendChild(footer);

    const suggestBtn = document.createElement("button");
    suggestBtn.className = "jm-btn";
    suggestBtn.textContent = "Suggest…";
    suggestBtn.title = "Fetch sitemap-derived path suggestions for the current domain";
    footer.appendChild(suggestBtn);

    const suggestResult = document.createElement("div");
    suggestResult.className = "jm-suggest";
    suggestResult.style.display = "none";
    el.appendChild(suggestResult);

    function load() {
      if (!B) return;
      B.storage.local.get("jaal_configs", function (result) {
        const configs = Array.isArray(result && result.jaal_configs) ? result.jaal_configs : [];
        _renderPatternsList(list, configs, load);
      });
    }
    el._reload = load;

    function renderSuggestResult(domain, patterns) {
      suggestResult.innerHTML = "";
      suggestResult.style.display = "";
      if (!patterns.length) {
        suggestResult.innerHTML = '<div class="jm-suggest-title">No patterns suggested for ' + _esc(domain) + '.</div>';
        return;
      }

      const title = document.createElement("div");
      title.className = "jm-suggest-title";
      title.textContent = "Sitemap patterns for " + domain + ":";
      suggestResult.appendChild(title);

      patterns.forEach(function (p) {
        const row = document.createElement("div");
        row.className = "jm-suggest-row";

        const text = document.createElement("div");
        text.className = "jm-suggest-text";
        text.innerHTML = _esc(p.text);

        const meta = document.createElement("span");
        meta.className = "jm-suggest-meta";
        meta.textContent = (p.count != null ? " (" + p.count + ")" : "") + (p.example ? " · e.g. " + p.example.substring(0, 40) : "");
        text.appendChild(meta);

        const copyBtn = document.createElement("button");
        copyBtn.className = "jm-btn jm-suggest-copy";
        copyBtn.textContent = "Copy";
        copyBtn.addEventListener("click", function () {
          navigator.clipboard.writeText(p.text).then(function () {
            copyBtn.textContent = "Copied";
            setTimeout(function () { copyBtn.textContent = "Copy"; }, 1500);
          });
        });

        row.appendChild(text);
        row.appendChild(copyBtn);
        suggestResult.appendChild(row);
      });
    }

    suggestBtn.addEventListener("click", function () {
      if (!B) return;
      B.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (!tabs[0] || !tabs[0].url) return;
        let domain;
        try { domain = new URL(tabs[0].url).hostname; }
        catch (_) { return; }
        suggestResult.style.display = "";
        suggestResult.innerHTML = '<div class="jm-suggest-title">Fetching sitemap for ' + _esc(domain) + '…</div>';
        fetch(SERVER_URL + "/discover-patterns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain: domain }),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            const raw = (data && Array.isArray(data.patterns)) ? data.patterns : [];
            const patterns = raw.map(function (p) {
              if (typeof p === "string") return { text: p, example: "", count: null };
              return {
                text: p.pattern || p.text || "",
                example: p.example || "",
                count: (typeof p.count === "number") ? p.count : null,
              };
            }).filter(function (p) { return p.text; });
            renderSuggestResult(domain, patterns);
          })
          .catch(function (err) {
            suggestResult.innerHTML = '<div class="jm-suggest-title">Server unreachable: ' + _esc(err.message) + '</div>';
          });
      });
    });

    exportBtn.addEventListener("click", function () {
      if (!B) return;
      B.storage.local.get("jaal_configs", function (result) {
        const configs = Array.isArray(result && result.jaal_configs) ? result.jaal_configs : [];
        const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), schemaVersion: 2, configs: configs }, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "jaal-configs-" + Date.now() + ".json";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 500);
      });
    });

    importBtn.addEventListener("click", function () { importFile.click(); });
    importFile.addEventListener("change", function () {
      const file = importFile.files[0];
      if (!file || !B) return;
      const reader = new FileReader();
      reader.onload = function (e) {
        try {
          const parsed = JSON.parse(e.target.result);
          const incoming = Array.isArray(parsed.configs) ? parsed.configs : (Array.isArray(parsed) ? parsed : []);
          if (incoming.length === 0) { alert("No configs found in file."); return; }
          B.storage.local.get("jaal_configs", function (result) {
            const existing = Array.isArray(result && result.jaal_configs) ? result.jaal_configs : [];
            let added = 0;
            incoming.forEach(function (c) {
              if (!c.id || existing.some(function (e) { return e.id === c.id; })) return;
              existing.push(c); added++;
            });
            B.storage.local.set({ jaal_configs: existing }, function () { alert("Imported " + added + " pattern(s)."); load(); });
          });
        } catch (err) { alert("Failed to parse: " + err.message); }
      };
      reader.readAsText(file);
      importFile.value = "";
    });

    load();
    return el;
  }

  function _renderPatternsList(listEl, configs, reload) {
    listEl.innerHTML = "";
    if (configs.length === 0) {
      listEl.innerHTML = '<div class="jm-empty">No saved patterns yet. Pick a list and click Finalize.</div>';
      return;
    }
    const byDomain = new Map();
    configs.forEach(function (c) {
      const d = c.domain || "(unknown)";
      if (!byDomain.has(d)) byDomain.set(d, []);
      byDomain.get(d).push(c);
    });
    Array.from(byDomain.keys()).sort().forEach(function (domain) {
      const dh = document.createElement("div");
      dh.className = "jm-dh";
      dh.textContent = domain + " (" + byDomain.get(domain).length + ")";
      listEl.appendChild(dh);
      byDomain.get(domain).forEach(function (cfg) {
        listEl.appendChild(_renderConfigRow(cfg, configs, reload));
      });
    });
  }

  function _renderConfigRow(cfg, configs, reload) {
    const row = document.createElement("div");
    row.className = "jm-row";
    row.dataset.configId = cfg.id;

    const label = document.createElement("div");
    label.className = "jm-row-label";
    label.textContent = cfg.label || cfg.domain;
    row.appendChild(label);

    const meta = document.createElement("div");
    meta.className = "jm-row-meta";
    meta.textContent = (cfg.pathPattern || "/") + " · " + (Array.isArray(cfg.columns) ? cfg.columns.length : 0) + " cols" + (cfg.searchInputSelector ? " · 🔍 search-bar bound" : "");
    row.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "jm-row-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "jm-btn";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", function () {
      row.replaceWith(_renderEditForm(cfg, configs, reload));
    });
    actions.appendChild(editBtn);

    const spawnBtn = document.createElement("button");
    spawnBtn.className = "jm-btn spawn";
    spawnBtn.textContent = "▶ Spawn";
    spawnBtn.addEventListener("click", function () {
      if (ns.activateConfig) {
        ns.activateConfig(cfg.id);
      } else {
        console.warn("[Jaal modal] ns.activateConfig not available");
      }
    });
    actions.appendChild(spawnBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "jm-btn danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", function () {
      if (!confirm("Delete '" + (cfg.label || cfg.domain) + "'?")) return;
      const updated = configs.filter(function (c) { return c.id !== cfg.id; });
      if (B) B.storage.local.set({ jaal_configs: updated }, reload);
    });
    actions.appendChild(deleteBtn);

    row.appendChild(actions);
    return row;
  }

  function _renderEditForm(cfg, configs, reload) {
    const form = document.createElement("div");
    form.className = "jm-row jm-form";
    form.dataset.configId = cfg.id;

    function field(labelText, className, value, placeholder) {
      const wrap = document.createElement("div");
      wrap.className = "jm-field";
      const label = document.createElement("label");
      label.textContent = labelText;
      const input = document.createElement("input");
      input.className = className;
      input.value = value || "";
      if (placeholder) input.placeholder = placeholder;
      wrap.appendChild(label);
      wrap.appendChild(input);
      return wrap;
    }

    form.appendChild(field("Label", "jm-edit-label", cfg.label || "", ""));
    form.appendChild(field("Domain", "jm-edit-domain", cfg.domain || "", ""));
    form.appendChild(field("Path", "jm-edit-path", cfg.pathPattern || "", "/products/* or /search/**"));
    form.appendChild(field("Parent", "jm-edit-parent", cfg.parentSelector || "", ""));
    form.appendChild(field("Search sel", "jm-edit-search", cfg.searchInputSelector || "", "(none)"));
    form.appendChild(field("Search val", "jm-edit-search-val", cfg.searchInputValue || "", "(none)"));

    const actions = document.createElement("div");
    actions.className = "jm-form-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "jm-btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", function () {
      form.replaceWith(_renderConfigRow(cfg, configs, reload));
    });
    actions.appendChild(cancelBtn);

    const saveBtn = document.createElement("button");
    saveBtn.className = "jm-btn";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", function () {
      const idx = configs.findIndex(function (c) { return c.id === cfg.id; });
      if (idx < 0) return;
      configs[idx] = Object.assign({}, configs[idx], {
        label: form.querySelector(".jm-edit-label").value.trim() || cfg.label,
        domain: form.querySelector(".jm-edit-domain").value.trim() || cfg.domain,
        pathPattern: form.querySelector(".jm-edit-path").value.trim() || "/",
        parentSelector: form.querySelector(".jm-edit-parent").value.trim() || cfg.parentSelector,
        searchInputSelector: form.querySelector(".jm-edit-search").value.trim() || null,
        searchInputValue: form.querySelector(".jm-edit-search-val").value || null,
      });
      if (B) B.storage.local.set({ jaal_configs: configs }, reload);
    });
    actions.appendChild(saveBtn);

    form.appendChild(actions);
    return form;
  }

  // ─── Tools panel ───────────────────────────────────────────────────────

  function _buildToolsPanel() {
    const el = document.createElement("div");
    el.className = "jm-panel";

    const skelBtn = document.createElement("button");
    skelBtn.className = "jm-tool-btn";
    skelBtn.textContent = "🔍 Inspect skeleton";
    skelBtn.addEventListener("click", function () {
      if (ns.skeletonOverlay && ns.skeletonOverlay.show) {
        ns.skeletonOverlay.show();
      } else if (B) {
        B.runtime.sendMessage({ type: "jaal-inject-skeleton", tabId: null });
      }
    });
    el.appendChild(skelBtn);

    const netBtn = document.createElement("button");
    netBtn.className = "jm-tool-btn";
    netBtn.textContent = "📡 Net recorder";
    netBtn.addEventListener("click", function () {
      if (ns.netRecorderOverlay && ns.netRecorderOverlay.show) {
        ns.netRecorderOverlay.show();
      } else if (B) {
        B.runtime.sendMessage({ type: "jaal-inject-net-recorder", tabId: null });
      }
    });
    el.appendChild(netBtn);

    const healthEl = document.createElement("div");
    healthEl.className = "jm-health";
    healthEl.textContent = "Server: checking…";
    el.appendChild(healthEl);

    fetch(SERVER_URL + "/health")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        healthEl.textContent = "Server: online · v" + (d.version || "?") + " · " + (d.aiProvider || "") + (d.aiReady ? " ✓" : " ✗");
        healthEl.className = "jm-health online";
      })
      .catch(function () {
        healthEl.textContent = "Server: offline — run: python server/server.py";
        healthEl.className = "jm-health offline";
      });

    return el;
  }

  // ─── Drag ──────────────────────────────────────────────────────────────

  function _setupDrag(headerEl) {
    let startX, startY, origLeft, origTop;
    headerEl.addEventListener("mousedown", function (e) {
      if (e.target.tagName === "BUTTON") return;
      e.preventDefault();
      startX = e.clientX; startY = e.clientY;
      origLeft = _hostEl.offsetLeft; origTop = _hostEl.offsetTop;
      const onMove = function (e) {
        _hostEl.style.left   = Math.max(0, origLeft + (e.clientX - startX)) + "px";
        _hostEl.style.top    = Math.max(0, origTop  + (e.clientY - startY)) + "px";
        _hostEl.style.right  = "";
        _hostEl.style.bottom = "";
      };
      const onUp = function () {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup",   onUp,   true);
      };
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup",   onUp,   true);
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  ns.modal = {
    openOrFocus: function () {
      _ensureCreated();
      _hostEl.style.display = "";
      if (!_activeTabId && _tabs.length > 0) ns.modal.activateTab(_tabs[0].id);
      log.info && log.info("modal_opened", { phase: "mutate" });
    },

    close: function () {
      if (_hostEl) _hostEl.style.display = "none";
    },

    addToolbarTab: function (inst) {
      _ensureCreated();
      _hostEl.style.display = "";

      const configId = inst.configId || ("tab-" + Date.now());
      if (_tabs.some(function (t) { return t.id === configId; })) {
        ns.modal.activateTab(configId);
        return;
      }

      const label = (inst.label && inst.label !== "Jaal") ? inst.label.substring(0, 20)
                  : (configId.startsWith("manual-") ? "Pick #" + configId.split("-")[1] : configId.substring(0, 14));

      const btn = document.createElement("button");
      btn.className = "jm-tab";
      btn.textContent = label;
      btn.dataset.tabId = configId;
      btn.addEventListener("click", function () { ns.modal.activateTab(configId); });

      // Insert before the first static tab
      const firstStatic = _tabbar.querySelector("[data-tab-id='patterns']");
      if (firstStatic) _tabbar.insertBefore(btn, firstStatic);
      else _tabbar.appendChild(btn);

      const panel = document.createElement("div");
      panel.dataset.tabId = configId;
      panel.style.display = "none";
      panel.style.overflow = "hidden";

      // Reparent toolbar hostEl — override its fixed positioning
      if (inst.hostEl) {
        inst.hostEl.style.cssText = "position:static;top:auto;right:auto;left:auto;bottom:auto;z-index:auto;display:block;width:100%;";
        panel.appendChild(inst.hostEl);
      }

      const firstStaticPanel = _body.querySelector("[data-tab-id='patterns']");
      if (firstStaticPanel) _body.insertBefore(panel, firstStaticPanel);
      else _body.appendChild(panel);

      _tabs.unshift({ id: configId, btn: btn, panel: panel, inst: inst });
      ns.modal.activateTab(configId);
      log.info && log.info("toolbar_tab_added", { phase: "mutate", id: configId });
    },

    removeToolbarTab: function (configId) {
      if (!configId) return;
      const idx = _tabs.findIndex(function (t) { return t.id === configId; });
      if (idx < 0) return;
      const tab = _tabs[idx];
      tab.btn.remove();
      // Restore hostEl to body before removing panel (so _destroy can remove it)
      if (tab.inst && tab.inst.hostEl) {
        tab.inst.hostEl.style.cssText = "";
      }
      tab.panel.remove();
      _tabs.splice(idx, 1);
      if (_activeTabId === configId) {
        _activeTabId = null;
        if (_tabs.length > 0) ns.modal.activateTab(_tabs[0].id);
      }
      log.info && log.info("toolbar_tab_removed", { phase: "teardown", id: configId });
    },

    activateTab: function (tabId) {
      _tabs.forEach(function (t) {
        const active = t.id === tabId;
        t.btn.classList.toggle("active", active);
        t.panel.style.display = active ? "" : "none";
        if (active && t.panel._reload) t.panel._reload();
      });
      _activeTabId = tabId;
    },
  };

  console.log("[Jaal modal] loaded");

})(typeof globalThis !== "undefined" ? globalThis : window);
