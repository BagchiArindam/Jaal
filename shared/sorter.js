/**
 * shared/sorter.js — client-side sort / filter for picked list containers.
 *
 * Ported fresh from sort-sight/extension/content/sorter.js with namespace
 * moved to window.Jaal.sorter.
 *
 * Public API:
 *   sortElements(container, itemSelector, columnDef, direction)
 *   filterElements(container, itemSelector, columnDef, filterText) → visibleCount
 *   applyFilters(container, itemSelector, columnDefs, filterValues) → visibleCount
 *   resetOrder()
 *   clearOriginalOrder()
 *   refreshOriginalOrder(container, itemSelector)
 *   extractValue(element, selector, attribute) → string | null
 *   parseByType(rawText, dataType) → number | Date | string | null
 *   hashItem(element) → "h1:h2" fingerprint string
 *   debugColumns(container, itemSelector, columnDefs)
 *
 * columnDef shape: { name, selector, attribute, dataType }
 *   dataType: "text" | "number" | "currency" | "rating" | "date"
 *
 * Filter syntax (filterText):
 *   "foo"      — case-insensitive substring / exact match
 *   "!foo"     — exclude matching
 *   ">50"      — numeric greater-than
 *   ">=50"     — numeric ≥
 *   "<50"      — numeric less-than
 *   "<=50"     — numeric ≤
 *   "10-50"    — numeric range
 *   "?"        — has a value (non-null/non-empty)
 *   "?!"       — is null / empty
 */
(function (global) {
  "use strict";

  const ns = (global.Jaal = global.Jaal || {});
  const log = ns.makeLogger ? ns.makeLogger("sorter") : console;

  // Firefox rejects selectors starting with ">" unless prefixed with :scope
  function safeQSA(container, selector) {
    const s = selector && selector.trimStart().startsWith(">") ? ":scope " + selector : selector;
    return Array.from(container.querySelectorAll(s));
  }

  let _debugLogCount = 0;

  function extractValue(element, selector, attribute) {
    let target = element;
    if (selector && selector !== "") {
      const safeSelector = selector.trimStart().startsWith(">")
        ? ":scope " + selector
        : selector;
      target = element.querySelector(safeSelector);
    }
    if (!target) {
      if (_debugLogCount < 15) {
        log.debug("extract_no_match", { phase: "load", selector: selector });
        _debugLogCount++;
      }
      return null;
    }

    let val;
    if (attribute === "textContent" || !attribute) {
      val = target.textContent.trim();
    } else {
      val = target.getAttribute(attribute) || target.textContent.trim();
    }

    if (_debugLogCount < 15) {
      log.debug("extract_value", { phase: "load", selector: selector, val: String(val).substring(0, 80) });
      _debugLogCount++;
    }
    return val;
  }

  // Content fingerprint for dedup — must produce "h1:h2" string matching
  // the _item_hash field consumed by server/scrape_runs.py.
  function hashItem(element) {
    const text = (element.textContent || "").replace(/\s+/g, " ").trim().substring(0, 500);
    const firstLink = element.querySelector("a[href]");
    const firstImg  = element.querySelector("img[src]");
    const dataId    = element.getAttribute("data-id") || element.id || "";
    const input = text
      + "|" + (firstLink ? firstLink.getAttribute("href") : "")
      + "|" + (firstImg  ? firstImg.getAttribute("src")  : "")
      + "|" + dataId;
    let h1 = 0, h2 = 0;
    for (let i = 0; i < input.length; i++) {
      h1 = (Math.imul(31, h1) + input.charCodeAt(i)) | 0;
      h2 = (Math.imul(37, h2) + input.charCodeAt(i)) | 0;
    }
    return h1 + ":" + h2;
  }

  function parseByType(rawText, dataType) {
    if (rawText == null || rawText === "") return null;
    const text = String(rawText).trim();
    if (!text) return null;

    switch (dataType) {
      case "number":
      case "rating": {
        const num = parseFloat(text.replace(/[^0-9.\-]/g, ""));
        return isNaN(num) ? null : num;
      }
      case "currency": {
        // European format: 1.299,99 (dots = thousands, comma = decimal)
        let cleaned = text;
        if (/\d{1,3}\.\d{3},\d{2}/.test(cleaned)) {
          cleaned = cleaned.replace(/\./g, "").replace(",", ".");
        } else {
          cleaned = cleaned.replace(/,/g, ""); // strip thousands commas
        }
        const num = parseFloat(cleaned.replace(/[^0-9.\-]/g, ""));
        return isNaN(num) ? null : num;
      }
      case "date": {
        const d = new Date(text);
        return isNaN(d.getTime()) ? text : d;
      }
      default:
        return text;
    }
  }

  function compare(a, b, direction) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    let cmp;
    if (typeof a === "number" && typeof b === "number") {
      cmp = a - b;
    } else if (a instanceof Date && b instanceof Date) {
      cmp = a.getTime() - b.getTime();
    } else {
      cmp = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
    }
    return direction === "desc" ? -cmp : cmp;
  }

  // --- Original order preservation ---
  //
  // Each slot records { element, parent, anchor } where anchor is the first
  // non-item sibling after that element in the original DOM (may be null).
  // Restoring from slots is O(n) and idempotent — applying two successive
  // sorts always produces identical DOM because we restore first, then sort
  // from the snapshot, then reinsert into the original slots.

  let originalOrder = null;

  function saveOriginalOrder(container, itemSelector) {
    if (originalOrder) return;
    const items = safeQSA(container, itemSelector);
    const itemSet = new Set(items);
    originalOrder = {
      container: container,
      itemSelector: itemSelector,
      slots: items.map(function (el) {
        var anchor = el.nextSibling;
        while (anchor && itemSet.has(anchor)) anchor = anchor.nextSibling;
        return { element: el, parent: el.parentElement, anchor: anchor };
      }),
    };
    log.debug("save_original_order", { phase: "mutate", count: items.length });
  }

  function _restoreToSlots() {
    if (!originalOrder) return;
    originalOrder.slots.forEach(function (s) {
      s.element.style.display = "";
      if (s.parent && s.parent.isConnected) {
        var ref = (s.anchor && s.anchor.parentElement === s.parent) ? s.anchor : null;
        s.parent.insertBefore(s.element, ref);
      }
    });
  }

  function resetOrder() {
    if (!originalOrder) return;
    _restoreToSlots();
    log.info("reset_order", { phase: "mutate" });
  }

  function clearOriginalOrder() {
    originalOrder = null;
  }

  function refreshOriginalOrder(container, itemSelector) {
    originalOrder = null;
    saveOriginalOrder(container, itemSelector);
  }

  // --- Sort ---

  function sortElements(container, itemSelector, columnDef, direction) {
    saveOriginalOrder(container, itemSelector);
    // Always restore to original positions first so repeated sorts are idempotent.
    _restoreToSlots();
    // Sort from the snapshot (original order), not from current DOM state.
    const items = originalOrder ? originalOrder.slots.map(function (s) { return s.element; })
                                : safeQSA(container, itemSelector);
    const pairs = items.map(function (item) {
      const raw   = extractValue(item, columnDef.selector, columnDef.attribute);
      const value = parseByType(raw, columnDef.dataType);
      return { element: item, value: value };
    });
    pairs.sort(function (a, b) { return compare(a.value, b.value, direction); });
    // Reinsert sorted items into the original slots.
    const sortedEls = pairs.map(function (p) { return p.element; });
    if (originalOrder) {
      originalOrder.slots.forEach(function (s, i) {
        if (s.parent && s.parent.isConnected) {
          var ref = (s.anchor && s.anchor.parentElement === s.parent) ? s.anchor : null;
          s.parent.insertBefore(sortedEls[i], ref);
        }
      });
    }
    log.info("sort_applied", { phase: "mutate", col: columnDef.name, direction: direction, count: pairs.length });
  }

  // --- Filter ---

  function _matchesFilterPositive(rawValue, filter, dataType) {
    if (["number", "currency", "rating"].includes(dataType)) {
      const numVal = parseByType(rawValue, dataType);
      if (numVal == null) return false;
      if (/^\d+(\.\d+)?-\d+(\.\d+)?$/.test(filter)) {
        const parts = filter.split("-").map(Number);
        return numVal >= parts[0] && numVal <= parts[1];
      }
      if (filter.startsWith(">=")) return numVal >= parseFloat(filter.slice(2));
      if (filter.startsWith("<=")) return numVal <= parseFloat(filter.slice(2));
      if (filter.startsWith(">"))  return numVal >  parseFloat(filter.slice(1));
      if (filter.startsWith("<"))  return numVal <  parseFloat(filter.slice(1));
      return String(numVal).includes(filter);
    }
    return String(rawValue || "").toLowerCase().includes(filter.toLowerCase());
  }

  function matchesFilter(rawValue, filter, dataType) {
    if (!filter || filter.trim() === "") return true;
    filter = filter.trim();
    if (filter === "?")  return rawValue != null && String(rawValue).trim() !== "";
    if (filter === "?!") return rawValue == null || String(rawValue).trim() === "";
    const isNot = filter.startsWith("!");
    const text  = isNot ? filter.slice(1).trim() : filter;
    if (!text) return true;
    const result = _matchesFilterPositive(rawValue, text, dataType);
    return isNot ? !result : result;
  }

  function filterElements(container, itemSelector, columnDef, filterText) {
    saveOriginalOrder(container, itemSelector);
    const items = safeQSA(container, itemSelector);
    let visible = 0;
    items.forEach(function (item) {
      const raw     = extractValue(item, columnDef.selector, columnDef.attribute);
      const matches = matchesFilter(raw, filterText, columnDef.dataType);
      item.style.display = matches ? "" : "none";
      if (matches) visible++;
    });
    log.debug("filter_applied", { phase: "mutate", col: columnDef.name, visible: visible });
    return visible;
  }

  function applyFilters(container, itemSelector, columnDefs, filterValues) {
    saveOriginalOrder(container, itemSelector);
    const items = safeQSA(container, itemSelector);
    let visibleCount = 0;
    items.forEach(function (item) {
      let show = true;
      for (let i = 0; i < columnDefs.length; i++) {
        const filterText = filterValues[i];
        if (!filterText || filterText.trim() === "") continue;
        const raw = extractValue(item, columnDefs[i].selector, columnDefs[i].attribute);
        if (!matchesFilter(raw, filterText, columnDefs[i].dataType)) {
          show = false;
          break;
        }
      }
      item.style.display = show ? "" : "none";
      if (show) visibleCount++;
    });
    log.debug("filters_applied", { phase: "mutate", visible: visibleCount });
    return visibleCount;
  }

  // --- Debug ---

  function debugColumns(container, itemSelector, columnDefs) {
    const items       = safeQSA(container, itemSelector);
    const sampleCount = Math.min(3, items.length);
    log.info("debug_columns", { phase: "load", items: items.length, cols: columnDefs.length });
    for (let i = 0; i < sampleCount; i++) {
      const row = {};
      columnDefs.forEach(function (col) {
        const raw = extractValue(items[i], col.selector, col.attribute);
        row[col.name] = raw ? String(raw).substring(0, 60) : "(null)";
      });
      console.table(row);
    }
    _debugLogCount = 0;
  }

  ns.sorter = {
    sortElements,
    filterElements,
    applyFilters,
    resetOrder,
    clearOriginalOrder,
    refreshOriginalOrder,
    extractValue,
    parseByType,
    hashItem,
    debugColumns,
  };

  console.log("[Jaal] sorter loaded");

})(typeof globalThis !== "undefined" ? globalThis : this);
