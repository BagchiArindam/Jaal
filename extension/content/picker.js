/**
 * extension/content/picker.js — element picker overlay.
 *
 * Injects a transparent overlay + highlight box + tooltip into the page so
 * the user can hover over elements, scroll the wheel to walk up the ancestor
 * chain, and click to select. Returns a Promise<{element, hint}>.
 *
 * Public API (window.Jaal.picker):
 *   activate(options) → Promise<{ element: Element, hint: Element|null }>
 *   deactivate()
 *   isActive() → boolean
 *
 * options:
 *   tooltipHeader   — string shown at top of tooltip (null = omit)
 *   prompt          — hint line at bottom of tooltip
 *   highlightColor  — hex color string (default "#ff6b35")
 */
(function (global) {
  "use strict";

  const ns = (global.Jaal = global.Jaal || {});
  const log = ns.makeLogger ? ns.makeLogger("picker") : console;

  // --- CSS injected once per page load ---
  const STYLE_ID = "jaal-picker-styles";
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = [
      ".jaal-picker-overlay{position:fixed;inset:0;z-index:2147483640;cursor:crosshair}",
      ".jaal-picker-highlight{position:fixed;z-index:2147483641;pointer-events:none;",
        "border:2px solid #ff6b35;box-sizing:border-box;transition:top .05s,left .05s,width .05s,height .05s}",
      ".jaal-picker-tooltip{position:fixed;z-index:2147483642;pointer-events:none;",
        "background:#1e293b;color:#f1f5f9;font:12px/1.5 monospace;",
        "border-radius:6px;padding:6px 10px;max-width:340px;box-shadow:0 4px 16px rgba(0,0,0,.5)}",
      ".jaal-picker-tooltip .jaal-ph{font-weight:700;padding-bottom:4px;margin-bottom:4px;",
        "border-bottom:1px solid rgba(255,255,255,.15);font-size:11px}",
      ".jaal-picker-tooltip .jaal-level{opacity:.55;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".jaal-picker-tooltip .jaal-level.active{opacity:1;font-weight:700}",
      ".jaal-picker-tooltip .jaal-cc{opacity:.5;font-size:10px;margin-left:4px}",
      ".jaal-picker-tooltip .jaal-hint{opacity:.45;font-size:10px;margin-top:4px;border-top:1px solid rgba(255,255,255,.1);padding-top:4px}",
    ].join("");
    document.head.appendChild(s);
  }

  // --- State ---
  let _active          = false;
  let _overlay         = null;
  let _highlight       = null;
  let _tooltip         = null;
  let _hoveredEl       = null;
  let _chain           = [];
  let _level           = 0;
  let _resolveSelection = null;
  let _rejectSelection  = null;
  let _opts            = {};

  const DEFAULT_OPTS = {
    tooltipHeader: null,
    prompt: "Scroll to change level · Click to select · Esc to cancel",
    highlightColor: "#ff6b35",
  };

  // --- Helpers ---

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }

  function throttle(fn, ms) {
    let last = 0;
    return function () {
      const now = Date.now();
      if (now - last >= ms) { last = now; fn.apply(this, arguments); }
    };
  }

  function describeElement(el) {
    if (!el || !el.tagName) return "";
    let desc = el.tagName.toLowerCase();
    if (el.id) desc += "#" + el.id;
    if (el.className && typeof el.className === "string") {
      const classes = el.className.trim().split(/\s+/)
        .filter(function (c) { return !c.startsWith("jaal-"); })
        .slice(0, 3);
      if (classes.length) desc += "." + classes.join(".");
    }
    return desc;
  }

  function childCountLabel(el) {
    const count = el && el.children ? el.children.length : 0;
    return count > 0 ? "(" + count + " children)" : "";
  }

  function buildChain(el) {
    const chain = [];
    let cur = el;
    while (cur && cur !== document.documentElement && chain.length < 20) {
      chain.push(cur);
      cur = cur.parentElement;
    }
    return chain;
  }

  // --- Overlay elements ---

  function _createElements() {
    const color = _opts.highlightColor || "#ff6b35";

    _overlay = document.createElement("div");
    _overlay.className = "jaal-picker-overlay";
    document.body.appendChild(_overlay);

    _highlight = document.createElement("div");
    _highlight.className = "jaal-picker-highlight";
    _highlight.style.setProperty("border-color", color, "important");
    _highlight.style.setProperty("background-color", hexToRgba(color, 0.08), "important");
    document.body.appendChild(_highlight);

    _tooltip = document.createElement("div");
    _tooltip.className = "jaal-picker-tooltip";
    document.body.appendChild(_tooltip);
  }

  function _removeElements() {
    if (_overlay)   { _overlay.remove();   _overlay = null; }
    if (_highlight) { _highlight.remove(); _highlight = null; }
    if (_tooltip)   { _tooltip.remove();   _tooltip = null; }
  }

  // --- Highlight + tooltip positioning ---

  function _positionHighlight(el) {
    if (!el || !_highlight) return;
    const r = el.getBoundingClientRect();
    _highlight.style.top    = r.top    + "px";
    _highlight.style.left   = r.left   + "px";
    _highlight.style.width  = r.width  + "px";
    _highlight.style.height = r.height + "px";
  }

  function _updateTooltip(mouseX, mouseY) {
    if (!_tooltip || _chain.length === 0) return;
    const color = _opts.highlightColor || "#ff6b35";
    const showStart = Math.max(0, _level - 2);
    const showEnd   = Math.min(_chain.length - 1, _level + 2);

    let html = "";
    if (_opts.tooltipHeader) {
      html += "<div class=\"jaal-ph\" style=\"color:" + color + "!important\">" +
              _opts.tooltipHeader + "</div>";
    }
    for (let i = showEnd; i >= showStart; i--) {
      const el      = _chain[i];
      const isActive = (i === _level);
      const indent  = "  ".repeat(showEnd - i);
      const desc    = describeElement(el);
      const cc      = childCountLabel(el);
      html += "<div class=\"jaal-level" + (isActive ? " active" : "") + "\">" +
              indent + (i > showStart ? "> " : "") + desc +
              (cc ? "<span class=\"jaal-cc\">" + cc + "</span>" : "") +
              "</div>";
    }
    const hint = _opts.prompt || "Scroll · Click · Esc";
    html += "<div class=\"jaal-hint\">" + hint + "</div>";
    _tooltip.innerHTML = html;

    const pad = 15;
    let tx = mouseX + pad;
    let ty = mouseY + pad;
    const tw = _tooltip.offsetWidth || 300;
    const th = _tooltip.offsetHeight || 100;
    if (tx + tw > window.innerWidth  - 10) tx = mouseX - tw - pad;
    if (ty + th > window.innerHeight - 10) ty = mouseY - th - pad;
    if (tx < 5) tx = 5;
    if (ty < 5) ty = 5;
    _tooltip.style.left = tx + "px";
    _tooltip.style.top  = ty + "px";
  }

  // --- Event handlers ---

  const _onMouseMove = throttle(function (e) {
    if (!_active) return;

    // Temporarily disable overlay pointer-events so elementFromPoint works
    _overlay.style.pointerEvents = "none";
    _highlight.style.display = "none";
    _tooltip.style.display   = "none";
    const el = document.elementFromPoint(e.clientX, e.clientY);
    _overlay.style.pointerEvents = "";
    _highlight.style.display = "";
    _tooltip.style.display   = "";

    if (!el || el === document.body || el === document.documentElement) return;
    if (el.className && typeof el.className === "string" && el.className.includes("jaal-picker-")) return;

    if (el !== _hoveredEl) {
      _hoveredEl = el;
      _chain = buildChain(el);
      _level = 0;
    }

    _positionHighlight(_chain[_level]);
    _updateTooltip(e.clientX, e.clientY);
  }, 16);

  function _onWheel(e) {
    if (!_active) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.deltaY > 0) {
      if (_level < _chain.length - 1) _level++;
    } else {
      if (_level > 0) _level--;
    }
    _positionHighlight(_chain[_level]);
    _updateTooltip(e.clientX, e.clientY);
  }

  function _onClick(e) {
    if (!_active) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const selectedEl = _chain[_level];
    if (!selectedEl) return;
    const hint    = (_chain[0] !== selectedEl) ? _chain[0] : null;
    const resolve = _resolveSelection;
    log.info("element_picked", { phase: "mutate", element: describeElement(selectedEl), level: _level });
    deactivate();
    if (resolve) resolve({ element: selectedEl, hint: hint });
  }

  function _onKeyDown(e) {
    if (!_active) return;
    if (e.key === "Escape") {
      e.preventDefault();
      const reject = _rejectSelection;
      log.info("picker_cancelled", { phase: "mutate" });
      deactivate();
      if (reject) reject(new Error("Picker cancelled"));
    }
  }

  function _blockEvent(e) {
    if (!_active) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function _addListeners() {
    document.addEventListener("mousemove",   _onMouseMove, true);
    document.addEventListener("wheel",       _onWheel, { capture: true, passive: false });
    document.addEventListener("click",       _onClick, true);
    document.addEventListener("keydown",     _onKeyDown, true);
    document.addEventListener("mousedown",   _blockEvent, true);
    document.addEventListener("mouseup",     _blockEvent, true);
    document.addEventListener("contextmenu", _blockEvent, true);
  }

  function _removeListeners() {
    document.removeEventListener("mousemove",   _onMouseMove, true);
    document.removeEventListener("wheel",       _onWheel, true);
    document.removeEventListener("click",       _onClick, true);
    document.removeEventListener("keydown",     _onKeyDown, true);
    document.removeEventListener("mousedown",   _blockEvent, true);
    document.removeEventListener("mouseup",     _blockEvent, true);
    document.removeEventListener("contextmenu", _blockEvent, true);
  }

  // --- Public API ---

  function activate(options) {
    return new Promise(function (resolve, reject) {
      if (_active) { reject(new Error("Picker already active")); return; }
      _active = true;
      _opts   = Object.assign({}, DEFAULT_OPTS, options || {});
      _resolveSelection = resolve;
      _rejectSelection  = reject;
      ensureStyles();
      _createElements();
      _addListeners();
      log.info("picker_activated", { phase: "init", color: _opts.highlightColor });
    });
  }

  function deactivate() {
    _active = false;
    _removeListeners();
    _removeElements();
    _hoveredEl        = null;
    _chain            = [];
    _level            = 0;
    _resolveSelection = null;
    _rejectSelection  = null;
    _opts             = {};
  }

  function isActive() { return _active; }

  ns.picker = { activate, deactivate, isActive };

  console.log("[Jaal] picker loaded");

})(typeof globalThis !== "undefined" ? globalThis : this);
