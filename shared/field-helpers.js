/**
 * shared/field-helpers.js — helpers for manual field picking (+ Field button).
 *
 * Exposes Jaal.fieldHelpers:
 *   findItemAncestor(element, container, itemSelector) → item element or null
 *   buildRelativeSelector(el, ancestor)               → CSS selector string
 *   buildNthChildPath(el, ancestor)                   → :nth-child path string
 *   inferDataType(text)                               → "currency" | "number" | "text"
 *   inferFieldName(el)                                → short human label string
 *
 * Ported from sort-sight toolbar.js:982-1063.
 */
(function (global) {
  "use strict";

  const ns = (global.Jaal = global.Jaal || {});

  function findItemAncestor(element, container, itemSelector) {
    const safeSelector = itemSelector && itemSelector.trimStart().startsWith(">")
      ? ":scope " + itemSelector
      : itemSelector;
    const items = container.querySelectorAll(safeSelector);
    let el = element;
    while (el && el !== container && el !== document.body) {
      for (let i = 0; i < items.length; i++) {
        if (items[i] === el) return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function buildNthChildPath(el, ancestor) {
    const segments = [];
    let current = el;
    while (current && current !== ancestor) {
      const parent = current.parentElement;
      if (!parent) break;
      const idx = Array.from(parent.children).indexOf(current) + 1;
      segments.unshift(":nth-child(" + idx + ")");
      current = parent;
    }
    return segments.length > 0 ? "> " + segments.join(" > ") : null;
  }

  function buildRelativeSelector(el, ancestor) {
    const tag = el.tagName.toLowerCase();

    // Try class-based selector (first 2 non-jaal classes)
    if (el.className && typeof el.className === "string") {
      const cls = el.className.trim().split(/\s+/)
        .filter(function (c) { return c && !c.startsWith("jaal-"); })
        .slice(0, 2)
        .map(function (c) { try { return CSS.escape(c); } catch (_) { return c; } })
        .join(".");
      if (cls) {
        const candidate = tag + "." + cls;
        if (ancestor.querySelectorAll(candidate).length === 1) return candidate;
      }
    }

    // Try data attributes
    const attrs = el.attributes;
    for (let i = 0; i < attrs.length; i++) {
      const attr = attrs[i];
      if (!attr.name.startsWith("data-")) continue;
      let candidate;
      if (attr.value) {
        const escaped = (function () { try { return CSS.escape(attr.value); } catch (_) { return attr.value.replace(/"/g, "\\\""); } })();
        candidate = tag + "[" + attr.name + "=\"" + escaped + "\"]";
      } else {
        candidate = tag + "[" + attr.name + "]";
      }
      if (ancestor.querySelectorAll(candidate).length <= 1) return candidate;
    }

    // Try aria-label
    const label = el.getAttribute("aria-label");
    if (label) {
      const escaped = (function () { try { return CSS.escape(label); } catch (_) { return label.replace(/"/g, "\\\""); } })();
      const candidate = "[aria-label=\"" + escaped + "\"]";
      if (ancestor.querySelectorAll(candidate).length === 1) return candidate;
    }

    // Fallback: nth-child path
    return buildNthChildPath(el, ancestor);
  }

  function inferDataType(text) {
    if (!text) return "text";
    if (/[$€£₹]|EUR|USD|GBP|Rs\.?/i.test(text)) return "currency";
    if (/^\s*[\d,.\-]+\s*$/.test(text.replace(/[%xX]/g, ""))) return "number";
    return "text";
  }

  function inferFieldName(el) {
    const label = el.getAttribute("aria-label");
    if (label && label.length <= 20) return label;
    if (el.className && typeof el.className === "string") {
      const cls = el.className.trim().split(/\s+/)[0];
      if (cls && cls.length <= 25) {
        const cleaned = cls
          .replace(/^[a-z]-/, "")
          .replace(/[-_]/g, " ")
          .replace(/\b\w/g, function (c) { return c.toUpperCase(); })
          .trim();
        if (cleaned.length >= 3 && cleaned.length <= 20) return cleaned;
      }
    }
    const text = (el.textContent || "").trim();
    if (text.length <= 15) return text || "Field";
    return text.substring(0, 12) + "...";
  }

  ns.fieldHelpers = {
    findItemAncestor: findItemAncestor,
    buildRelativeSelector: buildRelativeSelector,
    buildNthChildPath: buildNthChildPath,
    inferDataType: inferDataType,
    inferFieldName: inferFieldName,
  };

  console.log("[Jaal fieldHelpers] loaded");

})(typeof globalThis !== "undefined" ? globalThis : window);
