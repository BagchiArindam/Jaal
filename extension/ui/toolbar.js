/**
 * extension/ui/toolbar.js — floating sort/filter toolbar (multi-instance factory).
 *
 * Each Jaal.toolbar.create(...) call returns an isolated instance with its own
 * shadow DOM, state, and event handlers. Multiple instances can co-exist on
 * one page (one per finalized jaal_configs entry whose parentSelector is in DOM).
 *
 * Public API (window.Jaal.toolbar):
 *   create(analysis, container, itemSelector, totalItems, options) → instance
 *   showLoading(message, nearElement)                              → instance
 *   showError(message, instance?)                                  → void
 *
 * instance API (returned by create / showLoading):
 *   destroy()           — remove host element from page
 *   onClose(cb)         — register a close callback
 *   refresh()           — re-render counts/status
 *   hostEl              — the outer <div> living in document.body
 *   isLoading           — true if this is a showLoading instance
 *   upgrade(analysis, container, itemSelector, totalItems, options)
 *                       — convert a loading instance into a full toolbar in-place
 *
 * Vertical stacking: each new instance positions itself based on _instances
 * count (top = 20 + index * (panel height + gap)).
 *
 * options shape: { containerSelector, pagination, finalized, label, configId }
 */
(function (global) {
  "use strict";

  const ns  = (global.Jaal = global.Jaal || {});
  const log = ns.makeLogger ? ns.makeLogger("toolbar") : console;
  const B   = typeof browser !== "undefined" ? browser : (typeof chrome !== "undefined" ? chrome : null);

  // Active instances (used for vertical stacking + cleanup tracking)
  const _instances = [];

  // --- CSS (shared across all instances; injected per-shadow-root) ---
  const TOOLBAR_CSS = `
:host {
  all: initial;
  z-index: 2147483647 !important;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
  font-size: 13px !important;
  display: block !important;
  position: fixed !important;
}
.jaal-toolbar {
  background: #ffffff;
  border: 1px solid #d1d5db;
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0,0,0,.18);
  min-width: 300px;
  max-width: 520px;
  user-select: none;
  color: #1a1a2e;
}
.jaal-header {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 8px 10px;
  background: #1a1a2e;
  color: #fff;
  border-radius: 10px 10px 0 0;
  flex-wrap: wrap;
}
.jaal-header.draggable { cursor: grab; }
.jaal-header.draggable:active { cursor: grabbing; }
.jaal-title { font-weight: 700; font-size: 14px; flex-shrink: 0; }
.jaal-count { font-size: 11px; opacity: .75; flex: 1; text-align: center; min-width: 60px; }
.jaal-hbtn {
  background: none; border: none; color: #fff; cursor: pointer;
  padding: 2px 6px; border-radius: 4px; font-size: 11px; opacity: .8; flex-shrink: 0; line-height: 1.4;
}
.jaal-hbtn:hover { opacity: 1; background: rgba(255,255,255,.15); }
.jaal-hbtn.active { background: #3b82f6; opacity: 1; }
.jaal-hbtn:disabled { opacity: .4; cursor: default; }
.jaal-columns { padding: 4px 0; }
.jaal-column {
  display: flex; align-items: center; gap: 3px;
  padding: 3px 10px; border-bottom: 1px solid #f0f0f0;
}
.jaal-column:last-child { border-bottom: none; }
.jaal-col-name {
  font-weight: 500; min-width: 65px; max-width: 100px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; color: #374151; cursor: pointer;
  border-radius: 3px; padding: 1px 3px;
}
.jaal-col-name:hover { background: rgba(245,158,11,.15); }
.jaal-col-name.hl-active { background: rgba(245,158,11,.25); }
.jaal-sort-btn {
  background: none; border: 1px solid #d1d5db; border-radius: 4px;
  cursor: pointer; padding: 1px 5px; font-size: 11px; color: #6b7280;
  line-height: 1.2; flex-shrink: 0;
}
.jaal-sort-btn:hover { background: #f3f4f6; color: #1a1a2e; }
.jaal-sort-btn.active { background: #3b82f6; color: #fff; border-color: #3b82f6; }
.jaal-null-btn {
  background: none; border: 1px solid #d1d5db; border-radius: 4px;
  cursor: pointer; padding: 1px 5px; font-size: 10px; color: #9ca3af;
  line-height: 1.2; flex-shrink: 0; font-weight: 600;
}
.jaal-null-btn:hover { background: #f3f4f6; }
.jaal-null-btn.non-null { color: #3b82f6; border-color: #3b82f6; background: rgba(59,130,246,.08); }
.jaal-null-btn.null-only { color: #ef4444; border-color: #ef4444; background: rgba(239,68,68,.08); }
.jaal-filter {
  flex: 1; min-width: 0; border: 1px solid #d1d5db; border-radius: 4px;
  padding: 2px 5px; font-size: 12px; color: #1a1a2e;
  background: #fff; outline: none; font-family: inherit;
}
.jaal-filter:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,.15); }
.jaal-filter::placeholder { color: #9ca3af; }
.jaal-dd-btn {
  background: none; border: 1px solid #d1d5db; border-radius: 4px;
  cursor: pointer; padding: 1px 4px; font-size: 10px; color: #6b7280;
  line-height: 1.2; flex-shrink: 0;
}
.jaal-dd-btn:hover { background: #f3f4f6; }
.jaal-dd-btn.open { background: #e5e7eb; }
.jaal-hide-btn {
  background: none; border: none; cursor: pointer; padding: 1px 4px;
  font-size: 11px; color: #9ca3af; flex-shrink: 0; line-height: 1.2; border-radius: 3px;
}
.jaal-hide-btn:hover { color: #ef4444; background: rgba(239,68,68,.08); }
.jaal-dropdown {
  position: absolute; background: #fff; border: 1px solid #d1d5db;
  border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,.15);
  max-height: 220px; overflow-y: auto; min-width: 160px; z-index: 10;
  font-size: 12px; color: #1a1a2e;
}
.jaal-dd-item {
  padding: 5px 10px; cursor: pointer; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; max-width: 240px;
}
.jaal-dd-item:hover { background: #f3f4f6; }
.jaal-dd-item.empty { color: #9ca3af; font-style: italic; cursor: default; }
.jaal-status {
  padding: 5px 10px; font-size: 11px; color: #6b7280;
  border-top: 1px solid #f0f0f0; text-align: center;
}
.jaal-paginate-status {
  padding: 4px 10px; font-size: 11px; color: #059669;
  border-top: 1px solid #f0f0f0;
}
.jaal-loading {
  display: flex; align-items: center; justify-content: center;
  gap: 8px; padding: 16px; color: #6b7280;
}
.jaal-spinner {
  width: 18px; height: 18px;
  border: 2px solid #d1d5db; border-top: 2px solid #3b82f6;
  border-radius: 50%; animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.jaal-error { padding: 12px; color: #dc2626; font-size: 12px; text-align: center; cursor: text; user-select: text; }
.jaal-field-highlight { outline: 2px solid #f59e0b !important; outline-offset: 1px !important; background-color: rgba(245,158,11,.12) !important; }
.jaal-settings {
  padding: 6px 10px; border-top: 1px solid #f0f0f0; background: #f9fafb;
}
.jaal-set-row {
  display: flex; align-items: center; gap: 6px; padding: 3px 0;
}
.jaal-set-label {
  font-size: 11px; color: #6b7280; min-width: 78px; flex-shrink: 0;
}
.jaal-set-value {
  flex: 1; font-size: 11px; color: #374151;
  font-family: "SFMono-Regular", Consolas, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  background: #fff; padding: 2px 6px; border-radius: 3px; border: 1px solid #e5e7eb;
}
.jaal-set-value.empty { color: #9ca3af; font-style: italic; }
.jaal-search-value {
  flex: 1; padding: 2px 6px; font-size: 12px;
  border: 1px solid #d1d5db; border-radius: 4px; outline: none;
  font-family: inherit; color: #1a1a2e; background: #fff;
}
.jaal-search-value:focus { border-color: #3b82f6; }
.jaal-set-btn {
  background: #e5e7eb; color: #374151; border: none;
  padding: 2px 8px; border-radius: 4px; cursor: pointer;
  font-size: 11px; font-family: inherit;
}
.jaal-set-btn:hover { background: #d1d5db; }
.jaal-set-btn.danger { background: #fee2e2; color: #b91c1c; }
.jaal-set-btn.danger:hover { background: #fecaca; }
`;

  // Highlight stylesheet — added to <head> once, shared across all instances
  let _hlStyleEl = null;
  function _ensureHlStyle() {
    if (_hlStyleEl || !document.head) return;
    _hlStyleEl = document.createElement("style");
    _hlStyleEl.textContent = ".jaal-field-highlight{outline:2px solid #f59e0b!important;outline-offset:1px!important;background-color:rgba(245,158,11,.12)!important;}";
    document.head.appendChild(_hlStyleEl);
  }

  // --- Stateless helpers ---

  function escHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function safeQSA(container, selector) {
    const s = selector && selector.trimStart().startsWith(">") ? ":scope " + selector : selector;
    return Array.from(container.querySelectorAll(s));
  }

  function filterHint(dataType) {
    switch (dataType) {
      case "number": case "currency": case "rating": return ">N  N-M";
      case "date":   return "2024  !old";
      default:       return "text  !excl  ?";
    }
  }

  function _stackTop(instanceIndex) {
    // Vertical stacking from top; assume each toolbar is ~48px tall collapsed,
    // or starts at 20px + index * 56 for a generous gap
    return 20 + (instanceIndex * 56);
  }

  function _csvEscape(val) {
    const s = String(val == null ? "" : val);
    if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function _downloadCsv(rows, columns) {
    const visibleCols = columns.filter(function (c) { return !c.hidden; });
    const header = visibleCols.map(function (c) { return _csvEscape(c.name); }).join(",");
    const lines  = [header];
    rows.forEach(function (row) {
      lines.push(visibleCols.map(function (c) { return _csvEscape(row[c.name] != null ? row[c.name] : ""); }).join(","));
    });
    const csv  = lines.join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = (window.location.hostname || "jaal") + "_scrape_" + Date.now() + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // --- Factory: full toolbar ---

  function create(analysis, container, itemSelector, totalItems, options) {
    options = options || {};

    // ─── Per-instance state (closure) ───────────────────────────────
    let _hostEl          = null;
    let _shadowRoot      = null;
    let _closeCb         = null;
    let _currentSort     = { colIndex: -1, direction: null };
    let _filterValues    = [];
    let _nullStates      = [];
    let _hiddenCols      = [];
    let _activeDropCol   = -1;
    const _containerSel    = options.containerSelector || null;
    const _itemSel         = itemSelector;
    const _columns         = analysis.columns || [];
    let _savedPagination = options.pagination || null;
    let _isFinalized     = !!(options.finalized);
    const _configId        = options.configId || null;
    const _label           = options.label || "Jaal";
    let _searchInputSelector = options.searchInputSelector || null;
    let _searchInputValue    = options.searchInputValue    || "";
    const _runId             = options.runId || null;

    _filterValues = new Array(_columns.length).fill("");
    _nullStates   = new Array(_columns.length).fill("off");
    _hiddenCols   = new Array(_columns.length).fill(false);

    const instance = {
      destroy: _destroy,
      onClose: function (cb) { _closeCb = cb; },
      refresh: _refresh,
      isLoading: false,
      configId: _configId,
      label: _label,
      get hostEl() { return _hostEl; },
    };
    _instances.push(instance);
    const _instanceIndex = _instances.length - 1;

    // ─── Host + shadow DOM ──────────────────────────────────────────

    function _createHost(nearElement) {
      _hostEl = document.createElement("div");
      _shadowRoot = _hostEl.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = TOOLBAR_CSS;
      _shadowRoot.appendChild(style);

      // If modal is available, it will parent us — don't attach to body.
      // Fallback: attach to body with fixed positioning (standalone mode).
      if (!ns.modal) {
        _hostEl.style.cssText = "position:fixed;top:" + _stackTop(_instanceIndex) + "px;right:20px;z-index:2147483647";
        document.body.appendChild(_hostEl);

        if (nearElement) {
          try {
            const rect = nearElement.getBoundingClientRect();
            if (rect.right > 0 && rect.left < window.innerWidth) {
              const top  = Math.max(_stackTop(_instanceIndex), Math.min(rect.top, window.innerHeight - 300));
              const left = rect.left > window.innerWidth / 2
                ? Math.max(10, rect.left - 540)
                : Math.min(rect.right + 16, window.innerWidth - 540);
              _hostEl.style.top  = top  + "px";
              _hostEl.style.left = left + "px";
              _hostEl.style.right = "";
            }
          } catch (_) {}
        }
      }
    }

    // ─── Drag ───────────────────────────────────────────────────────

    function _setupDrag(headerEl) {
      if (!headerEl) return;
      let startX, startY, origLeft, origTop;
      headerEl.addEventListener("mousedown", function (e) {
        if (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT") return;
        e.preventDefault();
        startX = e.clientX; startY = e.clientY;
        origLeft = _hostEl.offsetLeft; origTop = _hostEl.offsetTop;
        document.addEventListener("mousemove", onMove, true);
        document.addEventListener("mouseup",   onUp,   true);
      });
      function onMove(e) {
        _hostEl.style.left  = Math.max(0, origLeft + (e.clientX - startX)) + "px";
        _hostEl.style.top   = Math.max(0, origTop  + (e.clientY - startY)) + "px";
        _hostEl.style.right = "";
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup",   onUp,   true);
      }
    }

    // ─── Status bar / count ─────────────────────────────────────────

    function _updateStatus(toolbar) {
      const el = toolbar && toolbar.querySelector(".jaal-status");
      if (!el) return;
      const all     = safeQSA(container, _itemSel);
      const visible = all.filter(function (el) { return el.style.display !== "none"; });
      el.textContent = visible.length + " of " + all.length + " visible";
    }

    function _updateCount(toolbar) {
      const el = toolbar && toolbar.querySelector(".jaal-count");
      if (!el) return;
      const all = safeQSA(container, _itemSel);
      const visible = all.filter(function (e) { return e.style.display !== "none"; });
      const total = totalItems || all.length;
      el.textContent = visible.length + " of " + total + " items";
    }

    // ─── Filters ────────────────────────────────────────────────────

    function _effectiveFilters() {
      return _filterValues.map(function (fv, i) {
        if (_nullStates[i] === "non-null") return "?";
        if (_nullStates[i] === "null-only") return "?!";
        return fv;
      });
    }

    function _applyAllFilters(toolbar) {
      if (!ns.sorter) return;
      ns.sorter.applyFilters(container, _itemSel, _columns, _effectiveFilters());
      _updateStatus(toolbar);
      _updateCount(toolbar);
    }

    // Inline rename for a column name element.
    function _startRename(nameEl, colIdx) {
      if (nameEl.querySelector("input")) return; // already renaming
      const current = _columns[colIdx] ? _columns[colIdx].name : nameEl.textContent.trim();
      const input = document.createElement("input");
      input.type = "text";
      input.value = current;
      input.className = "jaal-rename-input";
      input.style.cssText = "width:100%;box-sizing:border-box;font:inherit;border:1px solid #888;border-radius:2px;padding:1px 3px;background:#fff;color:#111;";
      nameEl.textContent = "";
      nameEl.appendChild(input);
      input.focus();
      input.select();
      function commit() {
        const newName = input.value.trim() || current;
        if (_columns[colIdx]) _columns[colIdx].name = newName;
        nameEl.textContent = newName;
        _updateConfigInStorage({ columns: _columns });
        console.log("[Jaal.toolbar] renamed col", colIdx, "→", newName);
      }
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        if (e.key === "Escape") { input.value = current; input.blur(); }
      });
    }

    // Wire events for a single column row (used by initial setup and + Field).
    function _wireColumnRow(row, colIdx, col, toolbar) {
      row.querySelectorAll(".jaal-sort-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          const dir = btn.getAttribute("data-dir");
          // Pressing the same sort button twice is a noop — list is already sorted this way.
          if (_currentSort.colIndex === colIdx && _currentSort.direction === dir) {
            return;
          } else {
            _currentSort = { colIndex: colIdx, direction: dir };
            toolbar.querySelectorAll(".jaal-sort-btn").forEach(function (b) { b.classList.remove("active"); });
            btn.classList.add("active");
            ns.sorter && ns.sorter.sortElements(container, _itemSel, col, dir);
          }
          _updateStatus(toolbar);
        });
      });

      const filterInput = row.querySelector(".jaal-filter");
      if (filterInput) {
        filterInput.addEventListener("input", function () {
          _filterValues[colIdx] = filterInput.value;
          _applyAllFilters(toolbar);
        });
      }

      const nullBtn = row.querySelector(".jaal-null-btn");
      if (nullBtn) {
        nullBtn.addEventListener("click", function () {
          const cur  = _nullStates[colIdx] || "off";
          const next = cur === "off" ? "non-null" : cur === "non-null" ? "null-only" : "off";
          _nullStates[colIdx] = next;
          nullBtn.className = "jaal-null-btn" + (next !== "off" ? " " + next : "");
          nullBtn.title = next === "non-null" ? "Has value" : next === "null-only" ? "Empty only" : "Null filter: off";
          nullBtn.textContent = next === "non-null" ? "?" : next === "null-only" ? "?!" : "○";
          if (filterInput) filterInput.disabled = (next !== "off");
          _applyAllFilters(toolbar);
        });
      }

      const ddBtn = row.querySelector(".jaal-dd-btn");
      if (ddBtn) {
        ddBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          if (_activeDropCol === colIdx) { _closeDropdown(toolbar); return; }
          _openDropdown(toolbar, colIdx, ddBtn);
        });
      }

      const hideBtn = row.querySelector(".jaal-hide-btn");
      if (hideBtn) {
        hideBtn.addEventListener("click", function () {
          _hiddenCols[colIdx] = true;
          row.style.display = "none";
          _updateShowHiddenBtn(toolbar);
          _applyAllFilters(toolbar);
        });
      }

      const nameEl = row.querySelector(".jaal-col-name");
      if (nameEl) {
        nameEl.addEventListener("mouseenter", function () {
          nameEl.classList.add("hl-active");
          _highlightField(col, true);
        });
        nameEl.addEventListener("mouseleave", function () {
          nameEl.classList.remove("hl-active");
          _highlightField(col, false);
        });
        nameEl.addEventListener("dblclick", function (e) {
          e.stopPropagation();
          _startRename(nameEl, colIdx);
        });
        nameEl.title = "Double-click to rename";
      }
    }

    // ─── Column hover highlight ─────────────────────────────────────

    function _highlightField(col, on) {
      _ensureHlStyle();
      const items = safeQSA(container, _itemSel);
      items.forEach(function (item) {
        let target = item;
        if (col.selector) {
          try {
            const sel = col.selector.trimStart().startsWith(">") ? ":scope " + col.selector : col.selector;
            target = item.querySelector(sel) || null;
          } catch (_) { target = null; }
        }
        if (target) {
          if (on) target.classList.add("jaal-field-highlight");
          else     target.classList.remove("jaal-field-highlight");
        }
      });
    }

    function _setupColHighlight(toolbar) {
      toolbar.querySelectorAll(".jaal-col-name").forEach(function (nameEl) {
        const colIdx = parseInt(nameEl.getAttribute("data-col"));
        const col    = _columns[colIdx];
        if (!col) return;
        nameEl.addEventListener("mouseenter", function () {
          nameEl.classList.add("hl-active");
          _highlightField(col, true);
        });
        nameEl.addEventListener("mouseleave", function () {
          nameEl.classList.remove("hl-active");
          _highlightField(col, false);
        });
        nameEl.addEventListener("dblclick", function (e) {
          e.stopPropagation();
          _startRename(nameEl, colIdx);
        });
        nameEl.title = "Double-click to rename";
      });
    }

    // ─── Sample value & dropdown ─────────────────────────────────────

    function sampleValue(col) {
      const items = safeQSA(container, _itemSel);
      for (let i = 0; i < Math.min(5, items.length); i++) {
        const val = ns.sorter && ns.sorter.extractValue(items[i], col.selector, col.attribute);
        if (val != null && String(val).trim() !== "") {
          const text = String(val).trim();
          return text.length > 22 ? text.substring(0, 20) + "…" : text;
        }
      }
      return null;
    }

    function collectUniqueValues(col) {
      const items = safeQSA(container, _itemSel);
      const seen = new Set();
      const vals = [];
      for (let i = 0; i < Math.min(200, items.length); i++) {
        const raw = ns.sorter && ns.sorter.extractValue(items[i], col.selector, col.attribute);
        const val = raw != null ? String(raw).trim() : null;
        if (val && !seen.has(val)) { seen.add(val); vals.push(val); }
        if (vals.length >= 60) break;
      }
      return vals.sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }); });
    }

    function _openDropdown(toolbar, colIdx, ddBtn) {
      _closeDropdown(toolbar);
      _activeDropCol = colIdx;
      ddBtn.classList.add("open");

      const col  = _columns[colIdx];
      const vals = collectUniqueValues(col);

      const dd = document.createElement("div");
      dd.className = "jaal-dropdown";
      dd.setAttribute("data-dd-col", String(colIdx));

      if (vals.length === 0) {
        const empty = document.createElement("div");
        empty.className = "jaal-dd-item empty";
        empty.textContent = "(no values)";
        dd.appendChild(empty);
      } else {
        vals.forEach(function (val) {
          const item = document.createElement("div");
          item.className = "jaal-dd-item";
          item.textContent = val;
          item.title = val;
          item.addEventListener("click", function () {
            const input = toolbar.querySelector(".jaal-filter[data-col=\"" + colIdx + "\"]");
            if (input) {
              input.value = val;
              _filterValues[colIdx] = val;
              _applyAllFilters(toolbar);
            }
            _closeDropdown(toolbar);
          });
          dd.appendChild(item);
        });
      }

      const btnRect = ddBtn.getBoundingClientRect();
      dd.style.cssText = "position:fixed;top:" + (btnRect.bottom + 2) + "px;left:" + btnRect.left + "px";
      _shadowRoot.appendChild(dd);

      setTimeout(function () {
        document.addEventListener("click", function _ddClose(e) {
          if (!dd.contains(e.target) && e.target !== ddBtn) {
            _closeDropdown(toolbar);
            document.removeEventListener("click", _ddClose, true);
          }
        }, true);
      }, 0);
    }

    function _closeDropdown(toolbar) {
      if (!_shadowRoot) return;
      const existing = _shadowRoot.querySelector(".jaal-dropdown");
      if (existing) existing.remove();
      if (_activeDropCol >= 0) {
        const btn = toolbar && toolbar.querySelector(".jaal-dd-btn[data-col=\"" + _activeDropCol + "\"]");
        if (btn) btn.classList.remove("open");
      }
      _activeDropCol = -1;
    }

    // ─── Sort / filter / null / dropdown / hide setups ─────────────

    function _setupSort(toolbar) {
      toolbar.querySelectorAll(".jaal-sort-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          const colIdx = parseInt(btn.getAttribute("data-col"));
          const dir    = btn.getAttribute("data-dir");
          // Pressing the same sort button twice is a noop — list is already sorted this way.
          if (_currentSort.colIndex === colIdx && _currentSort.direction === dir) {
            return;
          } else {
            _currentSort = { colIndex: colIdx, direction: dir };
            toolbar.querySelectorAll(".jaal-sort-btn").forEach(function (b) { b.classList.remove("active"); });
            btn.classList.add("active");
            ns.sorter && ns.sorter.sortElements(container, _itemSel, _columns[colIdx], dir);
          }
          _updateStatus(toolbar);
        });
      });
    }

    function _setupFilters(toolbar) {
      toolbar.querySelectorAll(".jaal-filter").forEach(function (input) {
        input.addEventListener("input", function () {
          _filterValues[parseInt(input.getAttribute("data-col"))] = input.value;
          _applyAllFilters(toolbar);
        });
      });
    }

    function _setupNullButtons(toolbar) {
      toolbar.querySelectorAll(".jaal-null-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          const colIdx = parseInt(btn.getAttribute("data-col"));
          const cur    = _nullStates[colIdx] || "off";
          const next   = cur === "off" ? "non-null" : cur === "non-null" ? "null-only" : "off";
          _nullStates[colIdx] = next;
          btn.className = "jaal-null-btn" + (next !== "off" ? " " + next : "");
          btn.title = next === "non-null" ? "Has value" : next === "null-only" ? "Empty only" : "Null filter: off";
          btn.textContent = next === "non-null" ? "?" : next === "null-only" ? "?!" : "○";
          const input = toolbar.querySelector(".jaal-filter[data-col=\"" + colIdx + "\"]");
          if (input) input.disabled = (next !== "off");
          _applyAllFilters(toolbar);
        });
      });
    }

    function _setupDropdownButtons(toolbar) {
      toolbar.querySelectorAll(".jaal-dd-btn").forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          const colIdx = parseInt(btn.getAttribute("data-col"));
          if (_activeDropCol === colIdx) { _closeDropdown(toolbar); return; }
          _openDropdown(toolbar, colIdx, btn);
        });
      });
    }

    function _updateShowHiddenBtn(toolbar) {
      const hidden = _hiddenCols.filter(Boolean).length;
      const btn = toolbar.querySelector(".jaal-show-hidden");
      if (!btn) return;
      if (hidden === 0) { btn.style.display = "none"; }
      else { btn.style.display = ""; btn.textContent = "Hidden (" + hidden + ")"; }
    }

    function _setupHideButtons(toolbar) {
      toolbar.querySelectorAll(".jaal-hide-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          const colIdx = parseInt(btn.getAttribute("data-col"));
          _hiddenCols[colIdx] = true;
          const row = toolbar.querySelector(".jaal-column[data-col-index=\"" + colIdx + "\"]");
          if (row) row.style.display = "none";
          _updateShowHiddenBtn(toolbar);
          _applyAllFilters(toolbar);
        });
      });

      const showBtn = toolbar.querySelector(".jaal-show-hidden");
      if (showBtn) {
        showBtn.addEventListener("click", function () {
          _hiddenCols = _hiddenCols.map(function () { return false; });
          toolbar.querySelectorAll(".jaal-column").forEach(function (row) { row.style.display = ""; });
          _updateShowHiddenBtn(toolbar);
        });
      }
    }

    // ─── Finalize button (writes to jaal_configs v2 schema) ────────

    function _setupFinalizeButton(toolbar) {
      const btn = toolbar.querySelector(".jaal-finalize");
      if (!btn || !B) return;

      btn.textContent = _isFinalized ? "Unfinalize" : "Finalize";

      btn.addEventListener("click", function () {
        const domain      = window.location.hostname;
        const pathPattern = window.location.pathname.replace(/\/+$/, "") || "/";

        B.storage.local.get("jaal_configs", function (result) {
          const configs = Array.isArray(result && result.jaal_configs) ? result.jaal_configs : [];
          const idx = configs.findIndex(function (c) {
            return c && c.domain === domain
                    && c.pathPattern === pathPattern
                    && c.parentSelector === _containerSel;
          });

          if (_isFinalized && idx >= 0) {
            configs.splice(idx, 1);
            _isFinalized = false;
            btn.textContent = "Finalize";
            log.info && log.info("unfinalized", { phase: "mutate", domain: domain, path: pathPattern });
          } else {
            const now = new Date().toISOString();
            const newId = (typeof crypto !== "undefined" && crypto.randomUUID)
                            ? crypto.randomUUID()
                            : ("local-" + Date.now());
            const entry = {
              id: idx >= 0 ? configs[idx].id : newId,
              domain: domain,
              pathPattern: pathPattern,
              parentSelector: _containerSel,
              label: (configs[idx] && configs[idx].label)
                     || (domain + (pathPattern !== "/" ? pathPattern : "") + " list"),
              layout: (options && options.layout) || (configs[idx] && configs[idx].layout) || "1D",
              itemSelector: _itemSel,
              columns: _columns,
              pagination: _savedPagination || null,
              searchInputSelector: _searchInputSelector || (configs[idx] && configs[idx].searchInputSelector) || null,
              searchInputValue:    _searchInputValue    || (configs[idx] && configs[idx].searchInputValue)    || null,
              finalizedAt: now,
              createdAt: (configs[idx] && configs[idx].createdAt) || now,
            };
            if (idx >= 0) configs[idx] = entry;
            else          configs.push(entry);
            _isFinalized = true;
            btn.textContent = "Unfinalize";
            log.info && log.info("finalized", { phase: "mutate", domain: domain, path: pathPattern, cols: _columns.length });
          }
          B.storage.local.set({ jaal_configs: configs });
        });
      });
    }

    // ─── Settings panel (search-bar pick + saved value) ─────────────

    // Update this instance's matching entry in jaal_configs (by composite key).
    // No-op if no entry exists yet (Finalize will write it later).
    function _updateConfigInStorage(patch) {
      if (!B || !B.storage || !B.storage.local) return;
      const domain      = window.location.hostname;
      const pathPattern = window.location.pathname.replace(/\/+$/, "") || "/";
      B.storage.local.get("jaal_configs", function (result) {
        const configs = Array.isArray(result && result.jaal_configs) ? result.jaal_configs : [];
        const idx = configs.findIndex(function (c) {
          return c && c.domain === domain
                  && c.pathPattern === pathPattern
                  && c.parentSelector === _containerSel;
        });
        if (idx < 0) return;
        configs[idx] = Object.assign({}, configs[idx], patch);
        B.storage.local.set({ jaal_configs: configs });
      });
    }

    function _setupSettings(toolbar) {
      const toggleBtn  = toolbar.querySelector(".jaal-settings-toggle");
      const panel      = toolbar.querySelector(".jaal-settings");
      const selEl      = toolbar.querySelector(".jaal-search-sel");
      const pickBtn    = toolbar.querySelector(".jaal-search-pick");
      const clearBtn   = toolbar.querySelector(".jaal-search-clear");
      const valInput   = toolbar.querySelector(".jaal-search-value");
      const copyRunId  = toolbar.querySelector(".jaal-copy-runid");

      if (copyRunId && _runId) {
        copyRunId.addEventListener("click", function () {
          try {
            navigator.clipboard.writeText(_runId).then(function () {
              copyRunId.textContent = "✓";
              setTimeout(function () { copyRunId.textContent = "📋"; }, 1200);
            });
          } catch (_) {}
        });
      }

      if (toggleBtn && panel) {
        toggleBtn.addEventListener("click", function () {
          const open = panel.style.display === "" || panel.style.display === "block";
          panel.style.display = open ? "none" : "";
          toggleBtn.classList.toggle("active", !open);
        });
      }

      function _refreshSel() {
        if (!selEl) return;
        if (_searchInputSelector) {
          selEl.textContent = _searchInputSelector;
          selEl.title = _searchInputSelector;
          selEl.classList.remove("empty");
        } else {
          selEl.textContent = "(not picked)";
          selEl.title = "";
          selEl.classList.add("empty");
        }
      }

      if (pickBtn) {
        pickBtn.addEventListener("click", async function () {
          if (!ns.picker) {
            log.warn && log.warn("search_pick_no_picker", { phase: "error" });
            return;
          }
          pickBtn.disabled = true;
          pickBtn.textContent = "…";
          try {
            const { element } = await ns.picker.activate({
              tooltipHeader: "Click the SEARCH INPUT",
              prompt: "Pick the <input> the site uses for searching this list. Scroll ↕ to walk up.",
              highlightColor: "#7ec8e3",
            });
            // Build a CSS selector — prefer #id, then tag.class, then tag[type]
            let sel = "";
            if (element.id) {
              sel = "#" + (function () { try { return CSS.escape(element.id); } catch (_) { return element.id; } })();
            } else if (element.name) {
              sel = (element.tagName || "input").toLowerCase() + "[name=\"" + element.name.replace(/"/g, "\\\"") + "\"]";
            } else if (element.className && typeof element.className === "string") {
              const cls = element.className.trim().split(/\s+/)
                .filter(function (c) { return c && !c.startsWith("jaal-"); }).slice(0, 2);
              sel = (element.tagName || "input").toLowerCase() +
                    (cls.length ? ("." + cls.join(".")) : "");
            } else {
              sel = (element.tagName || "input").toLowerCase();
            }
            _searchInputSelector = sel;
            _refreshSel();
            _updateConfigInStorage({ searchInputSelector: sel });
            log.info && log.info("search_picked", { phase: "mutate", sel: sel });
          } catch (err) {
            // Cancelled or failed — silent
          } finally {
            pickBtn.disabled = false;
            pickBtn.textContent = "Pick";
          }
        });
      }

      if (clearBtn) {
        clearBtn.addEventListener("click", function () {
          _searchInputSelector = null;
          _refreshSel();
          _updateConfigInStorage({ searchInputSelector: null });
          log.info && log.info("search_cleared", { phase: "mutate" });
        });
      }

      if (valInput) {
        let _valTimer = null;
        valInput.addEventListener("input", function () {
          _searchInputValue = valInput.value;
          if (_valTimer) clearTimeout(_valTimer);
          _valTimer = setTimeout(function () {
            _updateConfigInStorage({ searchInputValue: _searchInputValue || null });
          }, 400);
        });
      }
    }

    // ─── Header buttons ─────────────────────────────────────────────

    function _setupHeaderButtons(toolbar) {
      const closeBtn    = toolbar.querySelector(".jaal-close");
      const resetBtn    = toolbar.querySelector(".jaal-reset");
      const addFieldBtn = toolbar.querySelector(".jaal-add-field");
      const debugBtn    = toolbar.querySelector(".jaal-debug");
      const scrapeBtn   = toolbar.querySelector(".jaal-scrape");
      const repickBtn   = toolbar.querySelector(".jaal-repick");
      const detectBtn   = toolbar.querySelector(".jaal-detect");
      const flattenBtn  = toolbar.querySelector(".jaal-flatten");
      const collapseBtn = toolbar.querySelector(".jaal-collapse");

      if (collapseBtn) {
        let collapsed = false;
        collapseBtn.addEventListener("click", function () {
          collapsed = !collapsed;
          const body = toolbar.querySelector(".jaal-columns");
          const status = toolbar.querySelector(".jaal-status");
          const pagStatus = toolbar.querySelector(".jaal-paginate-status");
          if (body)      body.style.display      = collapsed ? "none" : "";
          if (status)    status.style.display    = collapsed ? "none" : "";
          if (pagStatus) pagStatus.style.display = collapsed ? "none" : "";
          collapseBtn.textContent = collapsed ? "▲" : "▼";
        });
      }

      if (closeBtn) closeBtn.addEventListener("click", function () {
        _destroy();
        if (_closeCb) _closeCb();
      });

      if (resetBtn) resetBtn.addEventListener("click", function () {
        ns.sorter && ns.sorter.resetOrder();
        ns.sorter && ns.sorter.clearOriginalOrder();
        _currentSort = { colIndex: -1, direction: null };
        _filterValues = _filterValues.map(function () { return ""; });
        _nullStates   = _nullStates.map(function () { return "off"; });
        toolbar.querySelectorAll(".jaal-sort-btn").forEach(function (b) { b.classList.remove("active"); });
        toolbar.querySelectorAll(".jaal-filter").forEach(function (inp) { inp.value = ""; inp.disabled = false; });
        toolbar.querySelectorAll(".jaal-null-btn").forEach(function (b) {
          b.className = "jaal-null-btn"; b.textContent = "○"; b.title = "Null filter: off";
        });
        safeQSA(container, _itemSel).forEach(function (el) { el.style.display = ""; });
        _updateStatus(toolbar);
        _updateCount(toolbar);
        log.info && log.info("reset", { phase: "mutate" });
      });

      if (addFieldBtn) {
        addFieldBtn.addEventListener("click", async function () {
          if (!ns.picker || !ns.fieldHelpers) {
            log.warn && log.warn("add_field_unavailable", { phase: "error", hasPicker: !!ns.picker, hasHelpers: !!ns.fieldHelpers });
            return;
          }
          addFieldBtn.disabled = true;
          addFieldBtn.textContent = "…";
          try {
            const { element } = await ns.picker.activate({
              tooltipHeader: "Click a value inside any item card",
              prompt: "Pick a field. Scroll ↕ to walk up.",
              highlightColor: "#10b981",
            });

            const itemAncestor = ns.fieldHelpers.findItemAncestor(element, container, _itemSel);
            if (!itemAncestor) {
              log.warn && log.warn("add_field_no_ancestor", { phase: "skip" });
              addFieldBtn.textContent = "Not in item";
              setTimeout(function () { addFieldBtn.textContent = "+ Field"; }, 2000);
              return;
            }

            const selector = ns.fieldHelpers.buildRelativeSelector(element, itemAncestor);
            if (!selector) {
              log.warn && log.warn("add_field_no_selector", { phase: "skip" });
              addFieldBtn.textContent = "+ Field";
              return;
            }

            // Duplicate check — same physical element across first 5 items
            const safeItemSel = _itemSel && _itemSel.trimStart().startsWith(">") ? ":scope " + _itemSel : _itemSel;
            const testItems = Array.from(container.querySelectorAll(safeItemSel)).slice(0, 5);
            const safeSel = selector.trimStart().startsWith(">") ? ":scope " + selector : selector;
            for (let ci = 0; ci < _columns.length; ci++) {
              const existing = _columns[ci];
              if (!existing.selector) continue;
              const safeOld = existing.selector.trimStart().startsWith(">") ? ":scope " + existing.selector : existing.selector;
              let hits = 0;
              testItems.forEach(function (item) {
                const a = item.querySelector(safeSel);
                const b = item.querySelector(safeOld);
                if (a && b && a === b) hits++;
              });
              if (hits >= Math.min(3, testItems.length)) {
                log.info && log.info("add_field_duplicate", { phase: "skip", existing: existing.name });
                addFieldBtn.textContent = "Exists!";
                setTimeout(function () { addFieldBtn.textContent = "+ Field"; }, 2000);
                return;
              }
            }

            // Sample texts for data type inference
            const sampleTexts = testItems.map(function (item) {
              const el = item.querySelector(safeSel);
              return el ? (el.textContent || "").trim() : "";
            }).filter(Boolean);

            const name     = ns.fieldHelpers.inferFieldName(element);
            const dataType = ns.fieldHelpers.inferDataType(sampleTexts.join(" "));
            const colIdx   = _columns.length;
            const newCol   = { name: name, selector: selector, attribute: "textContent", dataType: dataType, hidden: false };

            _columns.push(newCol);
            _filterValues.push("");
            _nullStates.push("off");
            _hiddenCols.push(false);

            const columnsDiv = toolbar.querySelector(".jaal-columns");
            if (columnsDiv) {
              columnsDiv.insertAdjacentHTML("beforeend", _buildColumnRow(newCol, colIdx));
              const newRow = columnsDiv.querySelector(".jaal-column[data-col-index=\"" + colIdx + "\"]");
              if (newRow) {
                _wireColumnRow(newRow, colIdx, newCol, toolbar);
                // Prompt user to rename the auto-inferred field name immediately.
                const newNameEl = newRow.querySelector(".jaal-col-name");
                if (newNameEl) setTimeout(function () { _startRename(newNameEl, colIdx); }, 50);
              }
            }

            _updateStatus(toolbar);
            _updateCount(toolbar);
            log.info && log.info("add_field_done", { phase: "mutate", name: name, selector: selector, dataType: dataType });
            addFieldBtn.textContent = "Added!";
            setTimeout(function () { addFieldBtn.textContent = "+ Field"; }, 1500);
          } catch (err) {
            const msg = String(err).toLowerCase();
            if (!msg.includes("cancel") && !msg.includes("abort")) {
              log.error && log.error("add_field_error", { phase: "error", err: String(err) });
            }
            addFieldBtn.textContent = "+ Field";
          } finally {
            addFieldBtn.disabled = false;
          }
        });
      }

      if (debugBtn) {
        debugBtn.addEventListener("click", function () {
          if (ns.sorter && ns.sorter.debugColumns) {
            ns.sorter.debugColumns(container, _itemSel, _columns);
          } else {
            console.warn("[Jaal toolbar] debugColumns not available");
          }
          log.info && log.info("debug_columns_triggered", { phase: "load", cols: _columns.length });
        });
      }

      if (scrapeBtn) {
        scrapeBtn.addEventListener("click", async function () {
          scrapeBtn.disabled = true;
          scrapeBtn.textContent = "…";
          try {
            const items = safeQSA(container, _itemSel).filter(function (el) { return el.style.display !== "none"; });
            if (items.length === 0) {
              scrapeBtn.textContent = "No items";
              setTimeout(function () { scrapeBtn.textContent = "Scrape"; }, 2000);
              return;
            }

            const visibleCols = _columns.filter(function (c) { return !c.hidden; });
            const rows = items.map(function (item) {
              const row = {};
              visibleCols.forEach(function (col) {
                const val = ns.sorter && ns.sorter.extractValue(item, col.selector, col.attribute);
                row[col.name] = val != null ? String(val).trim() : "";
              });
              return row;
            });

            _downloadCsv(rows, visibleCols);
            log.info && log.info("scrape_csv_downloaded", { phase: "mutate", rows: rows.length, cols: visibleCols.length });

            if (ns.scrapeRuns) {
              try {
                const siteKey = window.location.hostname + (window.location.pathname.replace(/\/+$/, "") || "/");
                const config  = { itemSelector: _itemSel, columns: _columns, containerSelector: _containerSel || null };
                const { runId } = await ns.scrapeRuns.start(siteKey, config);
                await ns.scrapeRuns.checkpoint(runId, rows, {});
                await ns.scrapeRuns.complete(runId, { totalRows: rows.length, url: window.location.href });
                log.info && log.info("scrape_run_saved", { phase: "mutate", runId: runId, rows: rows.length });
              } catch (serverErr) {
                log.warn && log.warn("scrape_server_skip", { phase: "warn", err: String(serverErr) });
              }
            }

            scrapeBtn.textContent = rows.length + " rows";
            setTimeout(function () { scrapeBtn.textContent = "Scrape"; }, 3000);
          } catch (err) {
            log.error && log.error("scrape_error", { phase: "error", err: String(err) });
            scrapeBtn.textContent = "Error";
            setTimeout(function () { scrapeBtn.textContent = "Scrape"; }, 2000);
          } finally {
            scrapeBtn.disabled = false;
          }
        });
      }

      if (repickBtn) repickBtn.addEventListener("click", function () {
        _destroy();
        if (global.Jaal && typeof global.Jaal.startPicking === "function") {
          global.Jaal.startPicking();
        } else if (B) {
          B.runtime.sendMessage({ type: "jaal-start-pick" });
        }
      });

      if (detectBtn) detectBtn.addEventListener("click", async function () {
        if (!ns.picker || !ns.paginator) return;
        detectBtn.disabled = true;
        detectBtn.textContent = "Pick…";
        try {
          const { element: pagEl } = await ns.picker.activate({
            tooltipHeader: "Pick the pagination control",
            highlightColor: "#8b5cf6",
          });
          const config = ns.paginator.detect(pagEl);
          if (!config) {
            detectBtn.textContent = "None";
            detectBtn.disabled = false;
            return;
          }
          _savedPagination = config;
          detectBtn.style.display = "none";
          if (flattenBtn) flattenBtn.style.display = "";
          log.info && log.info("pagination_detected", { phase: "load", type: config.type });
        } catch (_) {
          detectBtn.textContent = "Detect";
          detectBtn.disabled = false;
        }
      });

      if (flattenBtn) flattenBtn.addEventListener("click", async function () {
        if (!ns.paginator || !_savedPagination) return;
        flattenBtn.disabled = true;
        flattenBtn.textContent = "…";

        let statusEl = toolbar.querySelector(".jaal-paginate-status");
        if (!statusEl) {
          statusEl = document.createElement("div");
          statusEl.className = "jaal-paginate-status";
          toolbar.appendChild(statusEl);
        }

        ns.paginator.onProgress(function (info) {
          statusEl.textContent = "Page " + info.currentPage +
            (info.totalPages ? " / " + info.totalPages : "") +
            " — " + info.totalItems + " items";
        });
        ns.paginator.onPage(function (info) {
          if (info.resumeState) {
            flattenBtn.setAttribute("data-resume", JSON.stringify(info.resumeState));
          }
        });
        ns.paginator.onComplete(function (info) {
          flattenBtn.textContent = "Flatten";
          flattenBtn.disabled = false;
          statusEl.textContent = "Done — " + info.totalPages + " pages, " + info.totalItems + " items";
          ns.sorter && ns.sorter.refreshOriginalOrder(container, _itemSel);
          _updateStatus(toolbar);
          _updateCount(toolbar);
          log.info && log.info("flatten_done", { phase: "mutate", pages: info.totalPages, items: info.totalItems });
        });
        ns.paginator.onError(function (err) {
          flattenBtn.textContent = "Resume";
          flattenBtn.disabled = false;
          const savedResume = flattenBtn.getAttribute("data-resume");
          statusEl.textContent = "Paused: " + err.message + (savedResume ? " — click Resume" : "");
          log.error && log.error("flatten_error", { phase: "error", err: err.message });
        });

        const resumeData = flattenBtn.getAttribute("data-resume");
        await ns.paginator.startFlatten(container, _itemSel, _savedPagination, {
          containerSelector: _containerSel,
          resumeState: resumeData ? JSON.parse(resumeData) : null,
        });
      });
    }

    // ─── HTML builder ───────────────────────────────────────────────

    function _buildColumnRow(col, i) {
      const example = sampleValue(col);
      const ph = (example ? filterHint(col.dataType) + "  e.g. " + example : filterHint(col.dataType));
      return (
        "<div class=\"jaal-column\" data-col-index=\"" + i + "\">" +
        "<span class=\"jaal-col-name\" data-col=\"" + i + "\" title=\"" + escHtml(col.name) + "\">" + escHtml(col.name) + "</span>" +
        "<button class=\"jaal-sort-btn\" data-col=\"" + i + "\" data-dir=\"asc\" title=\"Sort ▲\">▲</button>" +
        "<button class=\"jaal-sort-btn\" data-col=\"" + i + "\" data-dir=\"desc\" title=\"Sort ▼\">▼</button>" +
        "<button class=\"jaal-null-btn\" data-col=\"" + i + "\" title=\"Null filter: off\">○</button>" +
        "<input class=\"jaal-filter\" data-col=\"" + i + "\" placeholder=\"" + escHtml(ph) + "\" />" +
        "<button class=\"jaal-dd-btn\" data-col=\"" + i + "\" title=\"Unique values\">▾</button>" +
        "<button class=\"jaal-hide-btn\" data-col=\"" + i + "\" title=\"Hide column\">✕</button>" +
        "</div>"
      );
    }

    function _buildToolbarHTML() {
      const colsHTML = _columns.map(function (col, i) { return _buildColumnRow(col, i); }).join("");
      return (
        "<div class=\"jaal-header draggable\">" +
        "<span class=\"jaal-title\">" + escHtml(_label) + "</span>" +
        "<span class=\"jaal-count\">" + totalItems + " items</span>" +
        "<button class=\"jaal-hbtn jaal-collapse\" title=\"Collapse\">▼</button>" +
        "<button class=\"jaal-hbtn jaal-detect\" title=\"Detect pagination\">Detect</button>" +
        "<button class=\"jaal-hbtn jaal-flatten\" title=\"Flatten all pages\" style=\"display:none\">Flatten</button>" +
        "<button class=\"jaal-hbtn jaal-scrape\" title=\"Scrape visible items to CSV\">Scrape</button>" +
        "<button class=\"jaal-hbtn jaal-show-hidden\" title=\"Show hidden columns\" style=\"display:none\">Hidden</button>" +
        "<button class=\"jaal-hbtn jaal-finalize\" title=\"Save for auto-inject\">" + (_isFinalized ? "Unfinalize" : "Finalize") + "</button>" +
        "<button class=\"jaal-hbtn jaal-reset\" title=\"Reset sort and filters\">Reset</button>" +
        "<button class=\"jaal-hbtn jaal-add-field\" title=\"Add a field by clicking an element\">+ Field</button>" +
        "<button class=\"jaal-hbtn jaal-debug\" title=\"Log column extraction to console\">Debug</button>" +
        "<button class=\"jaal-hbtn jaal-settings-toggle\" title=\"Settings\">⚙</button>" +
        "<button class=\"jaal-hbtn jaal-repick\" title=\"Re-pick element\">↺</button>" +
        "<button class=\"jaal-hbtn jaal-close\" title=\"Close\">✕</button>" +
        "</div>" +
        "<div class=\"jaal-columns\">" + colsHTML + "</div>" +
        _buildSettingsHTML() +
        "<div class=\"jaal-status\"></div>"
      );
    }

    function _buildSettingsHTML() {
      const sel = _searchInputSelector || "";
      const val = _searchInputValue || "";
      const runIdRow = _runId
        ? "<div class=\"jaal-set-row\">" +
            "<span class=\"jaal-set-label\">Debug runId:</span>" +
            "<span class=\"jaal-set-value\" title=\"" + escHtml(_runId) + "\" style=\"font-size:10px\">" + escHtml(_runId) + "</span>" +
            "<button class=\"jaal-set-btn jaal-copy-runid\" title=\"Copy runId to clipboard\">📋</button>" +
          "</div>"
        : "";
      return (
        "<div class=\"jaal-settings\" style=\"display:none\">" +
          "<div class=\"jaal-set-row\">" +
            "<span class=\"jaal-set-label\">Search bar:</span>" +
            "<span class=\"jaal-set-value jaal-search-sel" + (sel ? "" : " empty") + "\" title=\"" + escHtml(sel) + "\">" + escHtml(sel || "(not picked)") + "</span>" +
            "<button class=\"jaal-set-btn jaal-search-pick\" title=\"Pick the search input element\">Pick</button>" +
            "<button class=\"jaal-set-btn danger jaal-search-clear\" title=\"Clear search-bar binding\">✕</button>" +
          "</div>" +
          "<div class=\"jaal-set-row\">" +
            "<span class=\"jaal-set-label\">Search value:</span>" +
            "<input class=\"jaal-search-value\" placeholder=\"text auto-typed into search bar on load\" value=\"" + escHtml(val) + "\" />" +
          "</div>" +
          runIdRow +
        "</div>"
      );
    }

    // ─── Build + wire ───────────────────────────────────────────────

    _createHost(container);

    const toolbar = document.createElement("div");
    toolbar.className = "jaal-toolbar";
    toolbar.innerHTML = _buildToolbarHTML();
    _shadowRoot.appendChild(toolbar);

    _setupDrag(toolbar.querySelector(".jaal-header"));
    _setupSort(toolbar);
    _setupFilters(toolbar);
    _setupNullButtons(toolbar);
    _setupDropdownButtons(toolbar);
    _setupHideButtons(toolbar);
    _setupColHighlight(toolbar);
    _setupHeaderButtons(toolbar);
    _setupFinalizeButton(toolbar);
    _setupSettings(toolbar);

    if (_savedPagination) {
      const detectBtn  = toolbar.querySelector(".jaal-detect");
      const flattenBtn = toolbar.querySelector(".jaal-flatten");
      if (detectBtn)  detectBtn.style.display  = "none";
      if (flattenBtn) flattenBtn.style.display = "";
    }

    // Restore hidden columns from finalized config
    _columns.forEach(function (col, i) {
      if (col.hidden) {
        _hiddenCols[i] = true;
        const row = toolbar.querySelector(".jaal-column[data-col-index=\"" + i + "\"]");
        if (row) row.style.display = "none";
      }
    });
    _updateShowHiddenBtn(toolbar);
    _updateStatus(toolbar);

    function _refresh() {
      _updateStatus(toolbar);
      _updateCount(toolbar);
    }

    function _destroy() {
      if (ns.modal && _configId) ns.modal.removeToolbarTab(_configId);
      if (_hostEl) { _hostEl.remove(); _hostEl = null; }
      _shadowRoot = null;
      const idx = _instances.indexOf(instance);
      if (idx >= 0) _instances.splice(idx, 1);
      if (_closeCb) { var cb = _closeCb; _closeCb = null; cb(); }
      log.info && log.info("destroyed", { phase: "teardown" });
    }

    log.info && log.info("toolbar_created", { phase: "init", cols: _columns.length, items: totalItems, finalized: _isFinalized, idx: _instanceIndex });
    return instance;
  }

  // --- Factory: loading spinner ---

  function showLoading(message, nearElement) {
    let _hostEl     = null;
    let _shadowRoot = null;
    let _closeCb    = null;

    const instance = {
      isLoading: true,
      destroy: _destroy,
      onClose: function (cb) { _closeCb = cb; },
      refresh: function () {},
      get hostEl() { return _hostEl; },
      // Replace this loading instance with a full toolbar in-place
      upgrade: function (analysis, container, itemSelector, totalItems, options) {
        _destroy();
        return create(analysis, container, itemSelector, totalItems, options);
      },
      // Show an error message inside the loading panel
      showError: function (message) {
        if (!_shadowRoot) return;
        const existing = _shadowRoot.querySelector(".jaal-loading") ||
                         _shadowRoot.querySelector(".jaal-columns");
        if (existing) {
          const errDiv = document.createElement("div");
          errDiv.className = "jaal-error";
          errDiv.textContent = message;
          existing.replaceWith(errDiv);
        }
        log.error && log.error("error_shown", { phase: "error", message: message });
      },
    };
    _instances.push(instance);
    const _instanceIndex = _instances.length - 1;

    // Tell the modal where to appear when it first opens (near the picked element).
    if (nearElement && ns.modal && ns.modal.setPreferredPos) {
      ns.modal.setPreferredPos(nearElement);
    }

    _hostEl = document.createElement("div");
    _hostEl.style.cssText = "position:fixed;top:" + _stackTop(_instanceIndex) + "px;right:20px;z-index:2147483647";
    document.body.appendChild(_hostEl);
    _shadowRoot = _hostEl.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = TOOLBAR_CSS;
    _shadowRoot.appendChild(style);

    if (nearElement) {
      try {
        const rect = nearElement.getBoundingClientRect();
        if (rect.right > 0 && rect.left < window.innerWidth) {
          const top  = Math.max(_stackTop(_instanceIndex), Math.min(rect.top, window.innerHeight - 300));
          const left = rect.left > window.innerWidth / 2
            ? Math.max(10, rect.left - 540)
            : Math.min(rect.right + 16, window.innerWidth - 540);
          _hostEl.style.top  = top  + "px";
          _hostEl.style.left = left + "px";
          _hostEl.style.right = "";
        }
      } catch (_) {}
    }

    const toolbar = document.createElement("div");
    toolbar.className = "jaal-toolbar";
    toolbar.innerHTML =
      "<div class=\"jaal-header draggable\">" +
      "<span class=\"jaal-title\">Jaal</span>" +
      "<span class=\"jaal-count\"></span>" +
      "<button class=\"jaal-hbtn jaal-close\" title=\"Close\">✕</button>" +
      "</div>" +
      "<div class=\"jaal-loading\">" +
      "<div class=\"jaal-spinner\"></div>" +
      "<span>" + escHtml(message || "Analyzing...") + "</span>" +
      "</div>";
    _shadowRoot.appendChild(toolbar);

    // Drag for loading panel
    const headerEl = toolbar.querySelector(".jaal-header");
    let startX, startY, origLeft, origTop;
    headerEl.addEventListener("mousedown", function (e) {
      if (e.target.tagName === "BUTTON") return;
      e.preventDefault();
      startX = e.clientX; startY = e.clientY;
      origLeft = _hostEl.offsetLeft; origTop = _hostEl.offsetTop;
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup",   onUp,   true);
    });
    function onMove(e) {
      _hostEl.style.left  = Math.max(0, origLeft + (e.clientX - startX)) + "px";
      _hostEl.style.top   = Math.max(0, origTop  + (e.clientY - startY)) + "px";
      _hostEl.style.right = "";
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup",   onUp,   true);
    }

    toolbar.querySelector(".jaal-close").addEventListener("click", function () {
      _destroy();
      if (_closeCb) _closeCb();
    });

    function _destroy() {
      if (_hostEl) { _hostEl.remove(); _hostEl = null; }
      _shadowRoot = null;
      const idx = _instances.indexOf(instance);
      if (idx >= 0) _instances.splice(idx, 1);
    }

    log.info && log.info("loading_shown", { phase: "init", message: message });
    return instance;
  }

  function showError(message, instance) {
    if (instance && typeof instance.showError === "function") {
      instance.showError(message);
      return;
    }
    // Fallback: create a transient loading instance and swap in error
    const inst = showLoading("");
    inst.showError(message);
  }

  ns.toolbar = { create, showLoading, showError };

  console.log("[Jaal] toolbar loaded (factory mode)");

})(typeof globalThis !== "undefined" ? globalThis : this);
