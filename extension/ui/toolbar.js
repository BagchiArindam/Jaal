/**
 * extension/ui/toolbar.js — floating sort/filter toolbar.
 *
 * Renders a draggable, shadow-DOM-isolated panel near the picked container.
 * Wires up window.Jaal.sorter for sort/filter and window.Jaal.paginator for
 * pagination detection and list flattening.
 *
 * Public API (window.Jaal.toolbar):
 *   create(analysis, container, itemSelector, totalItems, options) → hostEl
 *   showLoading(message, nearElement)
 *   showError(message)
 *   destroy()
 *   onClose(cb)
 *
 * analysis shape:  { columns: [{ name, selector, attribute, dataType }], itemSelector }
 * options shape:   { containerSelector, pagination, finalized }
 */
(function (global) {
  "use strict";

  const ns  = (global.Jaal = global.Jaal || {});
  const log = ns.makeLogger ? ns.makeLogger("toolbar") : console;
  const B   = typeof browser !== "undefined" ? browser : (typeof chrome !== "undefined" ? chrome : null);

  // --- Internal state ---
  let _hostEl          = null;
  let _shadowRoot      = null;
  let _closeCb         = null;
  let _currentSort     = { colIndex: -1, direction: null };
  let _filterValues    = [];
  let _nullStates      = []; // "off" | "non-null" | "null-only" per column
  let _hiddenCols      = []; // bool[] per column
  let _savedPagination = null;
  let _containerSel    = null;
  let _itemSel         = null;
  let _columns         = [];
  let _isFinalized     = false;
  let _activeDropCol   = -1;

  // --- CSS ---
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
`;

  // --- Helpers ---

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

  function sampleValue(col, container, itemSelector) {
    const items = safeQSA(container, itemSelector);
    for (let i = 0; i < Math.min(5, items.length); i++) {
      const val = ns.sorter && ns.sorter.extractValue(items[i], col.selector, col.attribute);
      if (val != null && String(val).trim() !== "") {
        const text = String(val).trim();
        return text.length > 22 ? text.substring(0, 20) + "…" : text;
      }
    }
    return null;
  }

  function collectUniqueValues(col, container, itemSelector) {
    const items = safeQSA(container, itemSelector);
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

  // --- Host element + shadow DOM ---

  function _createHost(nearElement) {
    destroy();
    _hostEl = document.createElement("div");
    _hostEl.style.cssText = "position:fixed;top:20px;right:20px;z-index:2147483647";
    document.body.appendChild(_hostEl);

    _shadowRoot = _hostEl.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = TOOLBAR_CSS;
    _shadowRoot.appendChild(style);

    if (nearElement) {
      try {
        const rect = nearElement.getBoundingClientRect();
        const top  = Math.max(10, Math.min(rect.top, window.innerHeight - 300));
        const left = rect.left > window.innerWidth / 2
          ? Math.max(10, rect.left - 540)
          : Math.min(rect.right + 16, window.innerWidth - 540);
        _hostEl.style.top  = top  + "px";
        _hostEl.style.left = left + "px";
        _hostEl.style.right = "";
      } catch (_) {}
    }
  }

  // --- Drag ---

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

  // --- Status bar ---

  function _updateStatus(toolbar, container, itemSelector) {
    const el = toolbar && toolbar.querySelector(".jaal-status");
    if (!el) return;
    const all     = safeQSA(container, itemSelector);
    const visible = all.filter(function (el) { return el.style.display !== "none"; });
    el.textContent = visible.length + " of " + all.length + " visible";
  }

  function _updateCount(toolbar, container, itemSelector) {
    const el = toolbar && toolbar.querySelector(".jaal-count");
    if (!el) return;
    const visible = safeQSA(container, itemSelector).filter(function (e) { return e.style.display !== "none"; });
    el.textContent = visible.length + " items";
  }

  // --- Effective filter computation ---

  function _effectiveFilters() {
    return _filterValues.map(function (fv, i) {
      if (_nullStates[i] === "non-null") return "?";
      if (_nullStates[i] === "null-only") return "?!";
      return fv;
    });
  }

  function _applyAllFilters(toolbar, container, itemSelector) {
    if (!ns.sorter) return;
    ns.sorter.applyFilters(container, itemSelector, _columns, _effectiveFilters());
    _updateStatus(toolbar, container, itemSelector);
    _updateCount(toolbar, container, itemSelector);
  }

  // --- Column name hover → highlight matching fields ---

  let _hlStyleEl = null;

  function _ensureHlStyle() {
    if (_hlStyleEl || !document.head) return;
    _hlStyleEl = document.createElement("style");
    _hlStyleEl.textContent = ".jaal-field-highlight{outline:2px solid #f59e0b!important;outline-offset:1px!important;background-color:rgba(245,158,11,.12)!important;}";
    document.head.appendChild(_hlStyleEl);
  }

  function _highlightField(col, container, itemSelector, on) {
    _ensureHlStyle();
    const items = safeQSA(container, itemSelector);
    items.forEach(function (item) {
      const target = col.selector
        ? item.querySelector(col.selector.trimStart().startsWith(">") ? ":scope " + col.selector : col.selector)
        : item;
      if (target) {
        if (on) target.classList.add("jaal-field-highlight");
        else     target.classList.remove("jaal-field-highlight");
      }
    });
  }

  function _setupColHighlight(toolbar, container, itemSelector) {
    toolbar.querySelectorAll(".jaal-col-name").forEach(function (nameEl) {
      const colIdx = parseInt(nameEl.getAttribute("data-col"));
      const col    = _columns[colIdx];
      if (!col) return;
      nameEl.addEventListener("mouseenter", function () {
        nameEl.classList.add("hl-active");
        _highlightField(col, container, itemSelector, true);
      });
      nameEl.addEventListener("mouseleave", function () {
        nameEl.classList.remove("hl-active");
        _highlightField(col, container, itemSelector, false);
      });
    });
  }

  // --- Unique-value dropdown ---

  function _openDropdown(toolbar, colIdx, ddBtn, container, itemSelector) {
    // Close any open dropdown first
    _closeDropdown(toolbar);
    _activeDropCol = colIdx;
    ddBtn.classList.add("open");

    const col  = _columns[colIdx];
    const vals = collectUniqueValues(col, container, itemSelector);

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
            _applyAllFilters(toolbar, container, itemSelector);
          }
          _closeDropdown(toolbar);
        });
        dd.appendChild(item);
      });
    }

    // Position below the button
    const btnRect = ddBtn.getBoundingClientRect();
    dd.style.cssText = "position:fixed;top:" + (btnRect.bottom + 2) + "px;left:" + btnRect.left + "px";
    _shadowRoot.appendChild(dd);

    // Close on outside click
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

  // --- Sort ---

  function _setupSort(toolbar, container, itemSelector) {
    toolbar.querySelectorAll(".jaal-sort-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const colIdx = parseInt(btn.getAttribute("data-col"));
        const dir    = btn.getAttribute("data-dir");
        if (_currentSort.colIndex === colIdx && _currentSort.direction === dir) {
          ns.sorter && ns.sorter.resetOrder();
          _currentSort = { colIndex: -1, direction: null };
          toolbar.querySelectorAll(".jaal-sort-btn").forEach(function (b) { b.classList.remove("active"); });
        } else {
          _currentSort = { colIndex: colIdx, direction: dir };
          toolbar.querySelectorAll(".jaal-sort-btn").forEach(function (b) { b.classList.remove("active"); });
          btn.classList.add("active");
          ns.sorter && ns.sorter.sortElements(container, itemSelector, _columns[colIdx], dir);
        }
        _updateStatus(toolbar, container, itemSelector);
      });
    });
  }

  // --- Filter text inputs ---

  function _setupFilters(toolbar, container, itemSelector) {
    toolbar.querySelectorAll(".jaal-filter").forEach(function (input) {
      input.addEventListener("input", function () {
        _filterValues[parseInt(input.getAttribute("data-col"))] = input.value;
        _applyAllFilters(toolbar, container, itemSelector);
      });
    });
  }

  // --- Three-state null buttons ---

  function _setupNullButtons(toolbar, container, itemSelector) {
    toolbar.querySelectorAll(".jaal-null-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const colIdx = parseInt(btn.getAttribute("data-col"));
        const cur    = _nullStates[colIdx] || "off";
        const next   = cur === "off" ? "non-null" : cur === "non-null" ? "null-only" : "off";
        _nullStates[colIdx] = next;
        btn.className = "jaal-null-btn" + (next !== "off" ? " " + next : "");
        btn.title = next === "non-null" ? "Has value" : next === "null-only" ? "Empty only" : "Null filter: off";
        btn.textContent = next === "non-null" ? "?" : next === "null-only" ? "?!" : "○";
        // Disable text filter input while null-state is active
        const input = toolbar.querySelector(".jaal-filter[data-col=\"" + colIdx + "\"]");
        if (input) input.disabled = (next !== "off");
        _applyAllFilters(toolbar, container, itemSelector);
      });
    });
  }

  // --- Dropdown buttons ---

  function _setupDropdownButtons(toolbar, container, itemSelector) {
    toolbar.querySelectorAll(".jaal-dd-btn").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        const colIdx = parseInt(btn.getAttribute("data-col"));
        if (_activeDropCol === colIdx) { _closeDropdown(toolbar); return; }
        _openDropdown(toolbar, colIdx, btn, container, itemSelector);
      });
    });
  }

  // --- Hide / Show-hidden ---

  function _updateShowHiddenBtn(toolbar) {
    const hidden = _hiddenCols.filter(Boolean).length;
    const btn = toolbar.querySelector(".jaal-show-hidden");
    if (!btn) return;
    if (hidden === 0) {
      btn.style.display = "none";
    } else {
      btn.style.display = "";
      btn.textContent = "Hidden (" + hidden + ")";
    }
  }

  function _setupHideButtons(toolbar, container, itemSelector) {
    toolbar.querySelectorAll(".jaal-hide-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const colIdx = parseInt(btn.getAttribute("data-col"));
        _hiddenCols[colIdx] = true;
        const row = toolbar.querySelector(".jaal-column[data-col-index=\"" + colIdx + "\"]");
        if (row) row.style.display = "none";
        _updateShowHiddenBtn(toolbar);
        _applyAllFilters(toolbar, container, itemSelector);
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

  // --- Finalize / auto-inject ---

  function _finalizationKey() {
    return window.location.hostname + window.location.pathname.replace(/\/+$/, "");
  }

  function _setupFinalizeButton(toolbar, container, itemSelector, options) {
    const btn = toolbar.querySelector(".jaal-finalize");
    if (!btn || !B) return;

    btn.textContent = _isFinalized ? "Unfinalize" : "Finalize";

    btn.addEventListener("click", function () {
      const key = _finalizationKey();
      B.storage.local.get("jaal_finalized", function (result) {
        const store = (result && result["jaal_finalized"]) || {};
        if (_isFinalized) {
          delete store[key];
          _isFinalized = false;
          btn.textContent = "Finalize";
          log.info("unfinalized", { phase: "mutate", key: key });
        } else {
          store[key] = {
            urlPattern:        window.location.href,
            containerSelector: _containerSel,
            itemSelector:      _itemSel,
            columns:           _columns,
            pagination:        _savedPagination || null,
          };
          _isFinalized = true;
          btn.textContent = "Unfinalize";
          log.info("finalized", { phase: "mutate", key: key, cols: _columns.length });
        }
        B.storage.local.set({ "jaal_finalized": store });
      });
    });
  }

  // --- Header buttons ---

  function _setupHeaderButtons(toolbar, container, itemSelector) {
    const closeBtn   = toolbar.querySelector(".jaal-close");
    const resetBtn   = toolbar.querySelector(".jaal-reset");
    const repickBtn  = toolbar.querySelector(".jaal-repick");
    const detectBtn  = toolbar.querySelector(".jaal-detect");
    const flattenBtn = toolbar.querySelector(".jaal-flatten");
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
      destroy();
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
      safeQSA(container, itemSelector).forEach(function (el) { el.style.display = ""; });
      _updateStatus(toolbar, container, itemSelector);
      _updateCount(toolbar, container, itemSelector);
      log.info("reset", { phase: "mutate" });
    });

    if (repickBtn) repickBtn.addEventListener("click", function () {
      destroy();
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
        log.info("pagination_detected", { phase: "load", type: config.type });
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
        // Save resumeState into the flatten button data attr for checkpoint recovery
        if (info.resumeState) {
          flattenBtn.setAttribute("data-resume", JSON.stringify(info.resumeState));
        }
      });
      ns.paginator.onComplete(function (info) {
        flattenBtn.textContent = "Flatten";
        flattenBtn.disabled = false;
        statusEl.textContent = "Done — " + info.totalPages + " pages, " + info.totalItems + " items";
        ns.sorter && ns.sorter.refreshOriginalOrder(container, itemSelector);
        _updateStatus(toolbar, container, itemSelector);
        _updateCount(toolbar, container, itemSelector);
        log.info("flatten_done", { phase: "mutate", pages: info.totalPages, items: info.totalItems });
      });
      ns.paginator.onError(function (err) {
        flattenBtn.textContent = "Resume";
        flattenBtn.disabled = false;
        const savedResume = flattenBtn.getAttribute("data-resume");
        statusEl.textContent = "Paused: " + err.message + (savedResume ? " — click Resume" : "");
        log.error("flatten_error", { phase: "error", err: err.message });
      });

      const resumeData = flattenBtn.getAttribute("data-resume");
      await ns.paginator.startFlatten(container, itemSelector, _savedPagination, {
        containerSelector: _containerSel,
        resumeState: resumeData ? JSON.parse(resumeData) : null,
      });
    });
  }

  // --- HTML builder ---

  function _buildColumnRow(col, i, container, itemSelector) {
    const example = sampleValue(col, container, itemSelector);
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

  function _buildToolbarHTML(columns, totalItems, container, itemSelector) {
    const colsHTML = columns.map(function (col, i) {
      return _buildColumnRow(col, i, container, itemSelector);
    }).join("");

    return (
      "<div class=\"jaal-header draggable\">" +
      "<span class=\"jaal-title\">Jaal</span>" +
      "<span class=\"jaal-count\">" + totalItems + " items</span>" +
      "<button class=\"jaal-hbtn jaal-collapse\" title=\"Collapse\">▼</button>" +
      "<button class=\"jaal-hbtn jaal-detect\" title=\"Detect pagination\">Detect</button>" +
      "<button class=\"jaal-hbtn jaal-flatten\" title=\"Flatten all pages\" style=\"display:none\">Flatten</button>" +
      "<button class=\"jaal-hbtn jaal-show-hidden\" title=\"Show hidden columns\" style=\"display:none\">Hidden</button>" +
      "<button class=\"jaal-hbtn jaal-finalize\" title=\"Save for auto-inject\">" + (_isFinalized ? "Unfinalize" : "Finalize") + "</button>" +
      "<button class=\"jaal-hbtn jaal-reset\" title=\"Reset sort and filters\">Reset</button>" +
      "<button class=\"jaal-hbtn jaal-repick\" title=\"Re-pick element\">↺</button>" +
      "<button class=\"jaal-hbtn jaal-close\" title=\"Close\">✕</button>" +
      "</div>" +
      "<div class=\"jaal-columns\">" + colsHTML + "</div>" +
      "<div class=\"jaal-status\"></div>"
    );
  }

  // --- Public API ---

  function create(analysis, container, itemSelector, totalItems, options) {
    options        = options || {};
    _containerSel  = options.containerSelector || null;
    _itemSel       = itemSelector;
    _columns       = analysis.columns || [];
    _savedPagination = options.pagination || null;
    _isFinalized   = !!(options.finalized);
    _filterValues  = new Array(_columns.length).fill("");
    _nullStates    = new Array(_columns.length).fill("off");
    _hiddenCols    = new Array(_columns.length).fill(false);
    _currentSort   = { colIndex: -1, direction: null };
    _activeDropCol = -1;

    _createHost(container);

    const toolbar = document.createElement("div");
    toolbar.className = "jaal-toolbar";
    toolbar.innerHTML = _buildToolbarHTML(_columns, totalItems, container, itemSelector);
    _shadowRoot.appendChild(toolbar);

    _setupDrag(toolbar.querySelector(".jaal-header"));
    _setupSort(toolbar, container, itemSelector);
    _setupFilters(toolbar, container, itemSelector);
    _setupNullButtons(toolbar, container, itemSelector);
    _setupDropdownButtons(toolbar, container, itemSelector);
    _setupHideButtons(toolbar, container, itemSelector);
    _setupColHighlight(toolbar, container, itemSelector);
    _setupHeaderButtons(toolbar, container, itemSelector);
    _setupFinalizeButton(toolbar, container, itemSelector, options);

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
    _updateStatus(toolbar, container, itemSelector);

    log.info("toolbar_created", { phase: "init", cols: _columns.length, items: totalItems, finalized: _isFinalized });
    return _hostEl;
  }

  function showLoading(message, nearElement) {
    _createHost(nearElement);
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
    _setupDrag(toolbar.querySelector(".jaal-header"));
    toolbar.querySelector(".jaal-close").addEventListener("click", function () {
      destroy();
      if (_closeCb) _closeCb();
    });
    log.info("loading_shown", { phase: "init", message: message });
  }

  function showError(message) {
    if (!_shadowRoot) showLoading("");
    const existing = _shadowRoot.querySelector(".jaal-loading") ||
                     _shadowRoot.querySelector(".jaal-columns");
    if (existing) {
      const errDiv = document.createElement("div");
      errDiv.className = "jaal-error";
      errDiv.textContent = message;
      existing.replaceWith(errDiv);
    }
    log.error("error_shown", { phase: "error", message: message });
  }

  function destroy() {
    if (_hlStyleEl) { _hlStyleEl.remove(); _hlStyleEl = null; }
    if (_hostEl)    { _hostEl.remove();    _hostEl = null; }
    _shadowRoot = null;
    log.info("destroyed", { phase: "teardown" });
  }

  function onClose(cb) { _closeCb = cb; }

  ns.toolbar = { create, showLoading, showError, destroy, onClose };

  console.log("[Jaal] toolbar loaded");

})(typeof globalThis !== "undefined" ? globalThis : this);
