/**
 * shared/html-extractor.js — DOM skeleton extraction utility.
 *
 * Exposes: window.Jaal.htmlExtractor.extractMinimalHTML(containerElement, sampleCount, hintElement)
 * Returns: { metadata, samples } where samples are cleaned outerHTML strings.
 *
 * Ported from lib-sortsight-js/html-extractor.js — namespace renamed SortSight → Jaal.
 */
(function (global) {
  "use strict";

  const ns = (global.Jaal = global.Jaal || {});

  const KEEP_ATTRS = [
    "class", "id", "href", "src", "alt", "title",
    "aria-label", "role",
    "data-price", "data-rating", "data-sort", "data-value",
    "datetime",
  ];

  function walkTree(node, fn) {
    fn(node);
    for (const child of node.childNodes) {
      walkTree(child, fn);
    }
  }

  function cleanClone(element) {
    const clone = element.cloneNode(true);

    // Remove non-visible / non-structural elements
    clone
      .querySelectorAll("script, style, svg, noscript, iframe, link, br")
      .forEach((el) => el.remove());

    walkTree(clone, (node) => {
      if (node.nodeType === 1) {
        const toRemove = [];
        for (const attr of node.attributes) {
          if (!KEEP_ATTRS.includes(attr.name) && !attr.name.startsWith("data-")) {
            toRemove.push(attr.name);
          }
          if (attr.name.startsWith("data-") && !KEEP_ATTRS.includes(attr.name)) {
            if (attr.value.length > 80) toRemove.push(attr.name);
          }
        }
        toRemove.forEach((a) => node.removeAttribute(a));

        for (const urlAttr of ["href", "src"]) {
          const val = node.getAttribute(urlAttr);
          if (val && val.length > 80) {
            node.setAttribute(urlAttr, val.substring(0, 60) + "...");
          }
        }
      }

      if (node.nodeType === 3) {
        const trimmed = node.textContent.trim();
        if (trimmed.length > 100) {
          node.textContent = trimmed.substring(0, 100) + "...";
        }
      }
    });

    return clone;
  }

  function countTags(children) {
    const counts = {};
    for (const child of children) {
      const tag = child.tagName ? child.tagName.toLowerCase() : "#text";
      counts[tag] = (counts[tag] || 0) + 1;
    }
    return counts;
  }

  // Detect grid/row-wrapper patterns where the true repeating unit is nested
  // inside thin structural wrappers (e.g. Swiggy's 2-column grid:
  // container > row > KyyFD > _1WDPG > [item, item]).
  // Returns the deepest element that is a consistent repeating unit, or null.
  function unwrapToRepeatingItems(children, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 4 || children.length < 2) return null;

    const tags = children.map((c) => c.tagName);
    const allSameTag = tags.every((t) => t === tags[0]);
    if (!allSameTag) return null;

    const grandchildren = children.flatMap((c) => Array.from(c.children));
    if (grandchildren.length === 0) return null;

    if (grandchildren.length >= children.length) {
      const deeper = unwrapToRepeatingItems(grandchildren, depth + 1);
      return deeper || grandchildren;
    }

    return null;
  }

  function extractMinimalHTML(containerElement, sampleCount = 3, hintElement = null) {
    const directChildren = Array.from(containerElement.children);

    const unwrapped = unwrapToRepeatingItems(directChildren);
    const children = unwrapped || directChildren;
    const isUnwrapped = !!unwrapped;

    const hintIndex = hintElement
      ? children.findIndex((c) => c === hintElement || c.contains(hintElement))
      : -1;

    let indices;
    if (children.length <= sampleCount) {
      indices = children.map((_, i) => i);
    } else {
      const pool = Array.from({ length: children.length }, (_, i) => i);
      if (hintIndex !== -1) {
        pool.splice(pool.indexOf(hintIndex), 1);
      }
      indices = hintIndex !== -1 ? [hintIndex] : [];
      while (indices.length < sampleCount && pool.length > 0) {
        const r = Math.floor(Math.random() * pool.length);
        indices.push(pool.splice(r, 1)[0]);
      }
      indices.sort((a, b) => a - b);
    }

    const sample = indices.map((i) => children[i]);
    const cleanedSamples = sample.map((child) => cleanClone(child).outerHTML);

    const metadata = {
      containerTag: containerElement.tagName.toLowerCase(),
      containerClasses: containerElement.className || "",
      containerId: containerElement.id || "",
      totalChildren: directChildren.length,
      totalItems: children.length,
      sampleCount: sample.length,
      childTagDistribution: countTags(directChildren),
      unwrappedGrid: isUnwrapped,
    };

    console.log("[Jaal.htmlExtractor] extractMinimalHTML —",
      "container=" + metadata.containerTag,
      "children=" + metadata.totalChildren,
      "samples=" + metadata.sampleCount,
      "unwrapped=" + isUnwrapped);

    return { metadata, samples: cleanedSamples };
  }

  // ─── analyzeParent ──────────────────────────────────────────────────────
  //
  // Given a "list parent" element (the wrapper holding repeating items),
  // returns { layout, items, itemSelector } deterministically:
  //   layout       — "1D" if direct children are the repeating units,
  //                  "2D-matrix" if children are row/grid wrappers and the
  //                  true repeating units live one level deeper.
  //   items        — Element[] of the repeating units (NOT the parent's
  //                  immediate children if 2D).
  //   itemSelector — relative CSS selector that matches one item from the
  //                  parent. Built from the most common tag + 2 classes
  //                  shared across siblings.
  //
  // Reuses unwrapToRepeatingItems (depth ≤ 4) for 2D detection.

  function _commonClasses(elements) {
    if (!elements.length) return [];
    let common = null;
    for (const el of elements) {
      const cls = (typeof el.className === "string")
        ? el.className.trim().split(/\s+/).filter(function (c) { return c && !c.startsWith("jaal-"); })
        : [];
      const set = new Set(cls);
      if (common === null) common = cls;
      else common = common.filter(function (c) { return set.has(c); });
      if (common.length === 0) break;
    }
    return (common || []).slice(0, 2);
  }

  function _itemSelectorFor(items) {
    if (!items.length) return "";
    const first = items[0];
    const tag = first.tagName ? first.tagName.toLowerCase() : "*";
    const classes = _commonClasses(items);
    if (classes.length) {
      return tag + "." + classes.map(function (c) {
        try { return CSS.escape(c); } catch (_) { return c; }
      }).join(".");
    }
    return tag;
  }

  function analyzeParent(parent) {
    if (!parent || parent.nodeType !== 1) {
      return { layout: "1D", items: [], itemSelector: "" };
    }
    const directChildren = Array.from(parent.children);
    if (directChildren.length === 0) {
      return { layout: "1D", items: [], itemSelector: "" };
    }

    const unwrapped = unwrapToRepeatingItems(directChildren);
    const items = unwrapped || directChildren;
    const layout = unwrapped ? "2D-matrix" : "1D";
    const itemSelector = _itemSelectorFor(items);

    console.log("[Jaal.htmlExtractor] analyzeParent —",
      "layout=" + layout,
      "items=" + items.length,
      "itemSelector=" + itemSelector);

    return { layout: layout, items: items, itemSelector: itemSelector };
  }

  ns.htmlExtractor = { extractMinimalHTML, analyzeParent, unwrapToRepeatingItems };
  console.log("[Jaal] html-extractor loaded");

})(typeof globalThis !== "undefined" ? globalThis : this);
