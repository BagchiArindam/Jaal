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

  // ─── buildSyntheticSuperItem ─────────────────────────────────────────────
  //
  // Given a list of repeating items (from analyzeParent), walk every item's
  // leaf nodes, group by a (tag + classes + attribute) signature, and emit a
  // single synthetic HTML element that contains one representative node per
  // unique leaf signature. This is the "union of all fields ever observed
  // across any item" — so a list where item A has a discount badge and item
  // B has an out-of-stock badge yields a super-item with BOTH fields.
  //
  // Sending this single synthetic item to the AI analyzer (instead of 2-3
  // random samples) eliminates "missing fields" caused by sampling and saves
  // tokens. Returns { html, fieldCount, itemCount, leaves }.

  function _classesOf(el) {
    if (!el || typeof el.className !== "string") return [];
    return el.className.trim().split(/\s+/)
      .filter(function (c) { return c && !c.startsWith("jaal-"); })
      .slice(0, 3);
  }

  function _detectDataType(value, attribute) {
    if (attribute === "src") return "image";
    if (attribute === "href") return "url";
    if (attribute === "datetime") return "date";
    if (!value) return "text";
    const v = String(value).trim();
    if (/^[$£€¥₹]\s?-?\d/.test(v) || /-?\d+([.,]\d+)?\s?[$£€¥₹]/.test(v)) return "currency";
    if (/^\d{4}-\d{2}-\d{2}/.test(v))           return "date";
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(v))   return "date";
    if (/^-?\d+(\.\d+)?$/.test(v))              return "number";
    if (/^\d+(\.\d+)?\s*(out of|\/)\s*\d+/.test(v.toLowerCase())) return "rating";
    return "text";
  }

  // Build one CSS selector step for an element (tag + first 2 non-jaal classes).
  function _pathStep(node) {
    const tag = node.tagName.toLowerCase();
    const classes = _classesOf(node);
    if (!classes.length) return tag;
    try {
      return tag + "." + classes.map(function (c) { return CSS.escape(c); }).join(".");
    } catch (_) {
      return tag + "." + classes.join(".");
    }
  }

  // Walk an item's tree, emit { tag, classes, attribute, value, fallbackSelector } for each leaf.
  // fallbackSelector is a :scope-relative path usable to re-find this leaf inside a real item.
  function _gatherLeaves(itemRoot) {
    const leaves = [];
    // relParts = CSS steps from itemRoot's direct children down to (and including) current node.
    // Empty means current node IS the itemRoot (selector = "" = the item itself).
    function visit(node, relParts) {
      if (!node || node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();

      const fallbackSelector = relParts.length === 0
        ? ""
        : ":scope > " + relParts.join(" > ");

      if (tag === "img") {
        const src = node.getAttribute("src");
        if (src) leaves.push({ tag: "img", classes: _classesOf(node), attribute: "src", value: src, fallbackSelector: fallbackSelector });
        return;
      }
      if (tag === "input" || tag === "textarea") {
        const v = node.value || node.getAttribute("value");
        if (v) leaves.push({ tag: tag, classes: _classesOf(node), attribute: "value", value: v, fallbackSelector: fallbackSelector });
        return;
      }
      if (tag === "time") {
        const dt = node.getAttribute("datetime");
        if (dt) leaves.push({ tag: "time", classes: _classesOf(node), attribute: "datetime", value: dt, fallbackSelector: fallbackSelector });
        return;
      }
      if (tag === "a" && node.children.length === 0) {
        const href = node.getAttribute("href");
        const text = (node.textContent || "").trim();
        if (text) leaves.push({ tag: "a", classes: _classesOf(node), attribute: null, value: text, fallbackSelector: fallbackSelector });
        else if (href) leaves.push({ tag: "a", classes: _classesOf(node), attribute: "href", value: href, fallbackSelector: fallbackSelector });
        return;
      }
      // Element with no element children → text leaf if it has text
      if (node.children.length === 0) {
        const text = (node.textContent || "").trim();
        if (text) leaves.push({ tag: tag, classes: _classesOf(node), attribute: null, value: text, fallbackSelector: fallbackSelector });
        return;
      }
      // Branch — recurse into children, extending the path
      for (const child of node.children) {
        visit(child, relParts.concat([_pathStep(child)]));
      }
    }
    visit(itemRoot, []);
    return leaves;
  }

  function _signature(leaf) {
    return leaf.tag + "|" + leaf.classes.join(".") + "|" + (leaf.attribute || "");
  }

  function buildSyntheticSuperItem(items) {
    if (!Array.isArray(items) || items.length === 0) {
      return { html: "<div class=\"jaal-super-item\"></div>", fieldCount: 0, itemCount: 0, leaves: [] };
    }
    const bySig = new Map();
    for (const item of items) {
      const leaves = _gatherLeaves(item);
      for (const leaf of leaves) {
        const sig = _signature(leaf);
        if (!bySig.has(sig)) {
          bySig.set(sig, {
            tag: leaf.tag,
            classes: leaf.classes,
            attribute: leaf.attribute,
            fallbackSelector: leaf.fallbackSelector || "",
            values: [],
            count: 0,
          });
        }
        const e = bySig.get(sig);
        e.count++;
        if (leaf.value && e.values.length < 3 && e.values.indexOf(leaf.value) < 0) {
          e.values.push(leaf.value);
        }
      }
    }

    const fields = [];
    const htmlParts = [];
    for (const e of bySig.values()) {
      const cls = e.classes.length ? " class=\"" + e.classes.join(" ").replace(/"/g, "&quot;") + "\"" : "";
      const sample = e.values[0] || "";
      const dataType = _detectDataType(sample, e.attribute);
      // data-jaal-path stamps the DOM path so AI can use it as a selector hint
      const dataPath = " data-jaal-path=\"" + (e.fallbackSelector || "").replace(/"/g, "&quot;") + "\"";
      // Build representative HTML node
      let nodeHtml;
      if (e.attribute === "src" || e.attribute === "href" || e.attribute === "datetime" || e.attribute === "value") {
        const safeVal = String(sample).replace(/"/g, "&quot;").substring(0, 200);
        if (e.tag === "img") {
          nodeHtml = "<img" + cls + dataPath + " src=\"" + safeVal + "\" />";
        } else {
          nodeHtml = "<" + e.tag + cls + dataPath + " " + e.attribute + "=\"" + safeVal + "\"></" + e.tag + ">";
        }
      } else {
        const safeText = String(sample).replace(/[<>&]/g, function (c) {
          return c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;";
        }).substring(0, 200);
        nodeHtml = "<" + e.tag + cls + dataPath + ">" + safeText + "</" + e.tag + ">";
      }
      htmlParts.push(nodeHtml);

      // Build a class-based CSS selector for matching AI output back to a leaf
      let sel = e.tag;
      if (e.classes.length) {
        try { sel += "." + e.classes.map(function (c) { return CSS.escape(c); }).join("."); }
        catch (_) { sel += "." + e.classes.join("."); }
      }
      fields.push({
        selector: sel,
        fallbackSelector: e.fallbackSelector || "",
        attribute: e.attribute,
        dataType: dataType,
        sampleValues: e.values.slice(),
        occurrenceFraction: e.count / items.length,
      });
    }

    const html = "<div class=\"jaal-super-item\">" + htmlParts.join("") + "</div>";

    console.log("[Jaal.htmlExtractor] buildSyntheticSuperItem —",
      "items=" + items.length,
      "uniqueFields=" + fields.length);

    return { html: html, fieldCount: fields.length, itemCount: items.length, leaves: fields };
  }

  ns.htmlExtractor = {
    extractMinimalHTML,
    analyzeParent,
    unwrapToRepeatingItems,
    buildSyntheticSuperItem,
  };
  console.log("[Jaal] html-extractor loaded");

})(typeof globalThis !== "undefined" ? globalThis : this);
