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
 * analysis shape:  { columns: [{ name, selector, attribute, dataType }] }
 * options shape:   { containerSelector, pagination }
 *
 * Deferred (not yet implemented):
 *   Three-state null filter button
 *   Unique-value dropdown
 *   Column name → field highlight hover
 *   Hide / Show-hidden column buttons
 *   Finalize / auto-inject
 *   In-flow placement (toolbar injected inside page layout)
 */
(function (global) {
  "use strict";

  const ns  = (global.Jaal = global.Jaal || {});
  const log = ns.makeLogger ? ns.makeLogger("toolbar") : console;
  const B   = typeof browser !== "undefined" ? browser : (typeof chrome !== "undefined" ? chrome : null);

  // --- Internal state ---
  let _hostEl         = null;
  let _shadowRoot     = null;
  let _closeCb        = null;
  let _currentSort    = { colIndex: -1, direction: null };
  let _filterValues   = [];
  let _savedPagination = null;
  let _containerSel   = null;

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
  max-width: 480px;
  user-select: none;
  color: #1a1a2e;
}
.jaal-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: #1a1a2e;
  color: #fff;
  border-radius: 10px 10px 0 0;
}
.jaal-header.draggable { cursor: grab; }
.jaal-header.draggable:active { cursor: grabbing; }
.jaal-title { font-weight: 700; font-size: 14px; flex-shrink: 0; }
.jaal-count { font-size: 11px; opacity: .75; flex: 1; text-align: center; }
.jaal-hbtn {
  background: none; border: none; color: #fff; cursor: pointer;
  padding: 2px 6px; border-radius: 4px; font-size: 12px; opacity: .8; flex-shrink: 0;
}
.jaal-hbtn:hover { opacity: 1; background: rgba(255,255,255,.15); }
.jaal-columns { padding: 6px 0; }
.jaal-column {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 12px; border-bottom: 1px solid #f0f0f0;
}
.jaal-column:last-child { border-bottom: none; }
.jaal-col-name {
  font-weight: 500; min-width: 70px; max-width: 110px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; color: #374151;
}
.jaal-sort-btn {
  background: none; border: 1px solid #d1d5db; border-radius: 4px;
  cursor: pointer; padding: 2px 5px; font-size: 11px; color: #6b7280;
  line-height: 1; flex-shrink: 0;
}
.jaal-sort-btn:hover { background: #f3f4f6; color: #1a1a2e; }
.jaal-sort-btn.active { background: #3b82f6; color: #fff; border-color: #3b82f6; }
.jaal-filter {
  flex: 1; min-width: 0; border: 1px solid #d1d5db; border-radius: 4px;
  padding: 3px 6px; font-size: 12px; color: #1a1a2e;
  background: #fff; outline: none; font-family: inherit;
}
.jaal-filter:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,.15); }
.jaal-filter::placeholder { color: #9ca3af; }
.jaal-status {
  padding: 6px 12px; font-size: 11px; color: #6b7280;
  border-top: 1px solid #f0f0f0; text-align: center;
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
.jaal-paginate-status { padding: 4px 12px; font-size: 11px; color: #059669; border-top: 1px solid #f0f0f0; }
`;

  // --- Helpers ---

  function escHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function safeQSA(container, selector) {
    const s = selector && selector.trimStart().startsWith(">") ? ":scope " + selector : selector;
    return Array.from(container.querySelectorAll(s));
  }

  function sampleValue(col, container, itemSelector) {
    const items = safeQSA(container, itemSelector);
    for (let i = 0; i < Math.min(5, items.length); i++) {
      const val = ns.sorter && ns.sorter.extractValue(items[i], col.selector, col.attribute);
      if (val != null && String(val).trim() !== "") {
        const text = String(val).trim();
        return text.length > 25 ? text.substring(0, 22) + "..." : text;
      }
    }
    return null;
  }

  function filterHint(dataType) {
    switch (dataType) {
      case "number":
      case "currency":
      case "rating":
        return ">N  >=N  N-M";
      case "date":
        return "2024  !old";
      default:
        return "text  !excl  ?  ?!";
    }
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

    // Position near the picked element if visible
    if (nearElement) {
      try {
        const rect = nearElement.getBoundingClientRect();
        const top  = Math.max(10, Math.min(rect.top, window.innerHeight - 300));
        const left = rect.left > window.innerWidth / 2
          ? Math.max(10, rect.left - 500)
          : Math.min(rect.right + 16, window.innerWidth - 510);
        _hostEl.style.top  = top  + "px";
        _hostEl.style.left = left + "px";
        _hostEl.style.right = "";
      } catch (_) { /* keep default */ }
    }

    log.info("host_created", { phase: "init" });
  }

  // --- Drag ---

  function _setupDrag(headerEl) {
    if (!headerEl) return;
    let startX, startY, origLeft, origTop;
    headerEl.addEventListener("mousedown", function (e) {
      if (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT") return;
      e.preventDefault();
      startX   = e.clientX;
      startY   = e.clientY;
      origLeft = _hostEl.offsetLeft;
      origTop  = _hostEl.offsetTop;
      document.addEventListener("mousemove", onDragMove, true);
      document.addEventListener("mouseup",   onDragUp,   true);
    });
    function onDragMove(e) {
      _hostEl.style.left = Math.max(0, origLeft + (e.clientX - startX)) + "px";
      _hostEl.style.top  = Math.max(0, origTop  + (e.clientY - startY)) + "px";
      _hostEl.style.right = "";
    }
    function onDragUp() {
      document.removeEventListener("mousemove", onDragMove, true);
      document.removeEventListener("mouseup",   onDragUp,   true);
    }
  }

  // --- Status bar ---

  function _updateStatus(toolbar, container, itemSelector) {
    const statusEl = toolbar && toolbar.querySelector(".jaal-status");
    if (!statusEl) return;
    const allItems     = safeQSA(container, itemSelector);
    const visibleItems = allItems.filter(function (el) { return el.style.display !== "none"; });
    statusEl.textContent = visibleItems.length + " of " + allItems.length + " visible";
  }

  // --- Sort ---

  function _setupSort(toolbar, columns, container, itemSelector) {
    toolbar.querySelectorAll(".jaal-sort-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const colIdx = parseInt(btn.getAttribute("data-col"));
        const dir    = btn.getAttribute("data-dir");
        if (_currentSort.colIndex === colIdx && _currentSort.direction === dir) {
          // toggle off → reset order
          ns.sorter.resetOrder();
          _currentSort = { colIndex: -1, direction: null };
          toolbar.querySelectorAll(".jaal-sort-btn").forEach(function (b) { b.classList.remove("active"); });
        } else {
          _currentSort = { colIndex: colIdx, direction: dir };
          toolbar.querySelectorAll(".jaal-sort-btn").forEach(function (b) { b.classList.remove("active"); });
          btn.classList.add("active");
          ns.sorter.sortElements(container, itemSelector, columns[colIdx], dir);
        }
        _updateStatus(toolbar, container, itemSelector);
      });
    });
  }

  // --- Filter ---

  function _getEffectiveFilters() { return _filterValues.slice(); }

  function _setupFilters(toolbar, columns, container, itemSelector) {
    toolbar.querySelectorAll(".jaal-filter").forEach(function (input) {
      input.addEventListener("input", function () {
        const colIdx = parseInt(input.getAttribute("data-col"));
        _filterValues[colIdx] = input.value;
        const visible = ns.sorter.applyFilters(container, itemSelector, columns, _getEffectiveFilters());
        const countEl = toolbar.querySelector(".jaal-count");
        if (countEl) countEl.textContent = visible + " items";
        _updateStatus(toolbar, container, itemSelector);
      });
    });
  }

  // --- Header buttons ---

  function _setupHeaderButtons(toolbar, columns, container, itemSelector) {
    const closeBtn  = toolbar.querySelector(".jaal-close");
    const resetBtn  = toolbar.querySelector(".jaal-reset");
    const repickBtn = toolbar.querySelector(".jaal-repick");
    const detectBtn = toolbar.querySelector(".jaal-detect");
    const flattenBtn = toolbar.querySelector(".jaal-flatten");

    if (closeBtn) closeBtn.addEventListener("click", function () {
      destroy();
      if (_closeCb) _closeCb();
    });

    if (resetBtn) resetBtn.addEventListener("click", function () {
      ns.sorter.resetOrder();
      ns.sorter.clearOriginalOrder();
      _currentSort  = { colIndex: -1, direction: null };
      _filterValues = new Array(columns.length).fill("");
      toolbar.querySelectorAll(".jaal-sort-btn").forEach(function (b) { b.classList.remove("active"); });
      toolbar.querySelectorAll(".jaal-filter").forEach(function (inp) { inp.value = ""; });
      safeQSA(container, itemSelector).forEach(function (el) { el.style.display = ""; });
      const countEl = toolbar.querySelector(".jaal-count");
      const allItems = safeQSA(container, itemSelector);
      if (countEl) countEl.textContent = allItems.length + " items";
      _updateStatus(toolbar, container, itemSelector);
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

    // Detect pagination: let user pick the pagination element
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

    // Flatten: traverse all pages and accumulate items into the container
    if (flattenBtn) flattenBtn.addEventListener("click", async function () {
      if (!ns.paginator || !_savedPagination) return;
      flattenBtn.disabled = true;
      flattenBtn.textContent = "…";
      const statusEl = toolbar.querySelector(".jaal-paginate-status") || (() => {
        const el = document.createElement("div");
        el.className = "jaal-paginate-status";
        toolbar.appendChild(el);
        return el;
      })();
      ns.paginator.onProgress(function (info) {
        statusEl.textContent = "Page " + info.currentPage +
          (info.totalPages ? " / " + info.totalPages : "") +
          " — " + info.totalItems + " items";
      });
      ns.paginator.onComplete(function (info) {
        flattenBtn.textContent = "Flatten";
        flattenBtn.disabled = false;
        statusEl.textContent = "Done — " + info.totalPages + " pages, " + info.totalItems + " items";
        const countEl = toolbar.querySelector(".jaal-count");
        if (countEl) countEl.textContent = info.totalItems + " items";
        ns.sorter.refreshOriginalOrder(container, itemSelector);
        _updateStatus(toolbar, container, itemSelector);
        log.info("flatten_done", { phase: "mutate", pages: info.totalPages, items: info.totalItems });
      });
      ns.paginator.onError(function (err) {
        flattenBtn.textContent = "Flatten";
        flattenBtn.disabled = false;
        statusEl.textContent = "Error: " + err.message;
        log.error("flatten_error", { phase: "error", err: err.message });
      });
      await ns.paginator.startFlatten(container, itemSelector, _savedPagination, {
        containerSelector: _containerSel,
      });
    });
  }

  // --- HTML builders ---

  function _buildColumnRow(col, i, container, itemSelector) {
    const example = sampleValue(col, container, itemSelector);
    const placeholder = example
      ? filterHint(col.dataType) + "  e.g. " + example
      : filterHint(col.dataType);
    return "<div class=\"jaal-column\" data-col-index=\"" + i + "\">" +
      "<span class=\"jaal-col-name\" title=\"" + escHtml(col.name) + "\">" + escHtml(col.name) + "</span>" +
      "<button class=\"jaal-sort-btn\" data-col=\"" + i + "\" data-dir=\"asc\" title=\"Sort ascending\">&#9650;</button>" +
      "<button class=\"jaal-sort-btn\" data-col=\"" + i + "\" data-dir=\"desc\" title=\"Sort descending\">&#9660;</button>" +
      "<input class=\"jaal-filter\" data-col=\"" + i + "\" placeholder=\"" + escHtml(placeholder) + "\" />" +
      "</div>";
  }

  function _buildToolbarHTML(columns, totalItems, container, itemSelector) {
    const colsHTML = columns.map(function (col, i) {
      return _buildColumnRow(col, i, container, itemSelector);
    }).join("");
    return "<div class=\"jaal-header draggable\">" +
      "<span class=\"jaal-title\">Jaal</span>" +
      "<span class=\"jaal-count\">" + totalItems + " items</span>" +
      "<button class=\"jaal-hbtn jaal-detect\" title=\"Detect pagination\">Detect</button>" +
      "<button class=\"jaal-hbtn jaal-flatten\" title=\"Flatten all pages\" style=\"display:none\">Flatten</button>" +
      "<button class=\"jaal-hbtn jaal-reset\" title=\"Reset sort and filters\">Reset</button>" +
      "<button class=\"jaal-hbtn jaal-repick\" title=\"Re-pick element\">&#8635;</button>" +
      "<button class=\"jaal-hbtn jaal-close\" title=\"Close\">&#10005;</button>" +
      "</div>" +
      "<div class=\"jaal-columns\">" + colsHTML + "</div>" +
      "<div class=\"jaal-status\"></div>";
  }

  // --- Public API ---

  function create(analysis, container, itemSelector, totalItems, options) {
    options       = options || {};
    _containerSel = options.containerSelector || null;
    _savedPagination = options.pagination || null;
    _filterValues = new Array((analysis.columns || []).length).fill("");
    _currentSort  = { colIndex: -1, direction: null };

    _createHost(container);

    const columns = analysis.columns || [];
    const toolbar = document.createElement("div");
    toolbar.className = "jaal-toolbar";
    toolbar.innerHTML = _buildToolbarHTML(columns, totalItems, container, itemSelector);
    _shadowRoot.appendChild(toolbar);

    _setupDrag(toolbar.querySelector(".jaal-header"));
    _setupSort(toolbar, columns, container, itemSelector);
    _setupFilters(toolbar, columns, container, itemSelector);
    _setupHeaderButtons(toolbar, columns, container, itemSelector);

    if (_savedPagination) {
      const detectBtn  = toolbar.querySelector(".jaal-detect");
      const flattenBtn = toolbar.querySelector(".jaal-flatten");
      if (detectBtn)  detectBtn.style.display  = "none";
      if (flattenBtn) flattenBtn.style.display = "";
    }

    _updateStatus(toolbar, container, itemSelector);
    log.info("toolbar_created", { phase: "init", cols: columns.length, items: totalItems });
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
      "<button class=\"jaal-hbtn jaal-close\" title=\"Close\">&#10005;</button>" +
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
    if (_hostEl) { _hostEl.remove(); _hostEl = null; }
    _shadowRoot = null;
    log.info("destroyed", { phase: "teardown" });
  }

  function onClose(cb) { _closeCb = cb; }

  ns.toolbar = { create, showLoading, showError, destroy, onClose };

  console.log("[Jaal] toolbar loaded");

})(typeof globalThis !== "undefined" ? globalThis : this);
