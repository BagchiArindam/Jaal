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
  //
  // Key invariant: only signal 2D-matrix (return non-null) when we've actually
  // drilled at least one level. Never return the container's direct children
  // unless they're themselves the result of unwrapping (depth > 0).
  // Return the fraction of elements sharing the most common tagName.
  function _dominantTagFraction(elements) {
    if (!elements.length) return { tag: null, fraction: 0 };
    const counts = {};
    for (var i = 0; i < elements.length; i++) {
      var t = elements[i].tagName || "#";
      counts[t] = (counts[t] || 0) + 1;
    }
    var best = null, bestCount = 0;
    for (var t in counts) {
      if (counts[t] > bestCount) { best = t; bestCount = counts[t]; }
    }
    return { tag: best, fraction: bestCount / elements.length };
  }

  function unwrapToRepeatingItems(children, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 4 || children.length < 2) return null;

    // Children (row wrappers) must all share the same tag — strict.
    const tags = children.map(function (c) { return c.tagName; });
    const allSameTag = tags.every(function (t) { return t === tags[0]; });
    if (!allSameTag) return null;

    const grandchildren = children.flatMap(function (c) { return Array.from(c.children); });
    if (grandchildren.length === 0) return null;

    if (grandchildren.length >= children.length) {
      // Relaxed: accept grandchildren as repeating items if ≥60% share the dominant tag.
      // This handles rows that have product cards + occasional in-row ad slots with
      // different tags (e.g. Swiggy Instamart rows: 2×div.card + 1×aside.ad).
      const gcDom = _dominantTagFraction(grandchildren);
      if (gcDom.fraction >= 0.6) {
        // Filter to dominant-tag grandchildren for recursion and return
        const gcDominant = gcDom.fraction === 1
          ? grandchildren
          : grandchildren.filter(function (g) { return g.tagName === gcDom.tag; });
        const deeper = unwrapToRepeatingItems(gcDominant, depth + 1);
        return deeper || gcDominant;
      }
      // Grandchildren are too heterogeneous → current children are the repeating units.
      // Return them only if we've drilled at least one level.
      return depth > 0 ? children : null;
    }

    return null;
  }

  // Filter out "aberrant" siblings — items with far fewer leaves than the median
  // (brand spotlights, carousels, ad blocks). Primary filter: class-fingerprint
  // majority (≥50% items share the same class set). Fallback: two-sided leaf-count.
  function _filterAberrantSiblings(items) {
    if (items.length <= 2) return items;

    // Primary: class-fingerprint majority filter.
    // Compute CSS class fingerprint (sorted, deduplicated, non-jaal classes).
    var fingerprints = items.map(function (item) {
      var cls = (typeof item.className === "string")
        ? item.className.trim().split(/\s+/).filter(function (c) { return c && !c.startsWith("jaal-"); }).sort()
        : [];
      return cls.join("|");
    });
    var fpCount = Object.create(null);
    fingerprints.forEach(function (fp) { fpCount[fp] = (fpCount[fp] || 0) + 1; });
    var dominantFp = null, dominantCount = 0;
    Object.keys(fpCount).forEach(function (fp) {
      if (fpCount[fp] > dominantCount) { dominantFp = fp; dominantCount = fpCount[fp]; }
    });

    // If ≥50% of items share the dominant fingerprint, keep only those.
    if (dominantCount >= Math.ceil(items.length * 0.5)) {
      var byClass = items.filter(function (_, i) { return fingerprints[i] === dominantFp; });
      if (byClass.length < items.length) {
        console.log("[Jaal.htmlExtractor] _filterAberrantSiblings — rejected " +
          (items.length - byClass.length) + " outlier sibling(s) by class (majority=" + dominantCount + "/" + items.length + ")");
      }
      return byClass;
    }

    // Fallback: two-sided leaf-count filter.
    var leafCounts = items.map(function (item) { return _gatherLeaves(item).length; });
    var sorted = leafCounts.slice().sort(function (a, b) { return a - b; });
    var median = sorted[Math.floor(sorted.length / 2)];
    if (median === 0) return items;
    var lo = Math.max(1, Math.floor(median * 0.3));
    var hi = Math.ceil(median * 2.5);
    var byLeaf = items.filter(function (_, i) { return leafCounts[i] >= lo && leafCounts[i] <= hi; });
    if (byLeaf.length === 0) return items;
    if (byLeaf.length < items.length) {
      console.log("[Jaal.htmlExtractor] _filterAberrantSiblings — rejected " +
        (items.length - byLeaf.length) + " outlier sibling(s) by leaf count (median=" + median + ", range=[" + lo + "," + hi + "])");
    }
    return byLeaf;
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

  function analyzeParent(parent, hintEl) {
    if (!parent || parent.nodeType !== 1) {
      console.warn("[Jaal.htmlExtractor] analyzeParent — invalid parent node");
      return { layout: "1D", items: [], itemSelector: "" };
    }
    const directChildren = Array.from(parent.children);
    if (directChildren.length === 0) {
      console.warn("[Jaal.htmlExtractor] analyzeParent — parent has no children");
      return { layout: "1D", items: [], itemSelector: "" };
    }

    console.log("[Jaal.htmlExtractor] analyzeParent — start tag=" + parent.tagName.toLowerCase()
      + " directChildren=" + directChildren.length + " hintEl=" + (hintEl ? hintEl.tagName : "none"));

    const unwrapped = unwrapToRepeatingItems(directChildren);
    let items = unwrapped || directChildren;
    const layout = unwrapped ? "2D-matrix" : "1D";

    if (unwrapped) {
      console.log("[Jaal.htmlExtractor] analyzeParent — 2D-matrix: unwrapped " +
        directChildren.length + " direct children → " + items.length + " inner items");
    } else {
      console.log("[Jaal.htmlExtractor] analyzeParent — 1D: " + items.length + " direct items");
    }

    if (items.length === 0) {
      console.warn("[Jaal.htmlExtractor] analyzeParent — 0 items after unwrap; falling back to direct children");
      items = directChildren;
    }

    // Hint-guided filter: if the user clicked a specific product card (hintEl),
    // use it as the reference for what a valid item looks like (same tag + leaf count ±40%).
    // Falls back to class-fingerprint / leaf-count heuristics when hint is unavailable.
    if (hintEl && parent.contains(hintEl)) {
      var hintItem = null;
      for (var hi = 0; hi < items.length; hi++) {
        if (items[hi] === hintEl || items[hi].contains(hintEl)) { hintItem = items[hi]; break; }
      }
      if (hintItem) {
        var hintLeaves = _gatherLeaves(hintItem).length;
        var hintTag    = hintItem.tagName;
        var hLo = Math.max(1, Math.floor(hintLeaves * 0.60));
        var hHi = Math.ceil(hintLeaves * 1.40);
        var byHint = items.filter(function (item) {
          var lc = _gatherLeaves(item).length;
          return item.tagName === hintTag && lc >= hLo && lc <= hHi;
        });
        if (byHint.length >= 3) {
          console.log("[Jaal.htmlExtractor] analyzeParent — hint-guided filter: kept " +
            byHint.length + "/" + items.length + " items (hint leaves=" + hintLeaves +
            ", range=[" + hLo + "," + hHi + "])");
          items = byHint;
        } else {
          console.log("[Jaal.htmlExtractor] analyzeParent — hint filter too strict (" +
            byHint.length + " items), falling back to _filterAberrantSiblings");
          items = _filterAberrantSiblings(items);
        }
      } else {
        console.log("[Jaal.htmlExtractor] analyzeParent — hintEl not found in items array, using _filterAberrantSiblings");
        items = _filterAberrantSiblings(items);
      }
    } else {
      items = _filterAberrantSiblings(items);
    }

    const itemSelector = _itemSelectorFor(items);

    console.log("[Jaal.htmlExtractor] analyzeParent — done layout=" + layout
      + " items=" + items.length + " itemSelector=" + itemSelector);

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

  function _buildSuperItemNode(e, sampleValue) {
    var cls = e.classes.length ? " class=\"" + e.classes.join(" ").replace(/"/g, "&quot;") + "\"" : "";
    var dataPath = " data-jaal-path=\"" + (e.fallbackSelector || "").replace(/"/g, "&quot;") + "\"";
    var sample = sampleValue || "";
    if (e.attribute === "src" || e.attribute === "href" || e.attribute === "datetime" || e.attribute === "value") {
      var safeVal = String(sample).replace(/"/g, "&quot;").substring(0, 200);
      if (e.tag === "img") return "<img" + cls + dataPath + " src=\"" + safeVal + "\" />";
      return "<" + e.tag + cls + dataPath + " " + e.attribute + "=\"" + safeVal + "\"></" + e.tag + ">";
    }
    var safeText = String(sample).replace(/[<>&]/g, function (c) {
      return c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;";
    }).substring(0, 200);
    return "<" + e.tag + cls + dataPath + ">" + safeText + "</" + e.tag + ">";
  }

  function buildSyntheticSuperItem(items) {
    if (!Array.isArray(items) || items.length === 0) {
      return { html: "<div class=\"jaal-super-item\"></div>", htmlBlocks: [], fieldCount: 0, itemCount: 0, leaves: [] };
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

    // Build the fields (leaves) array from unique signatures
    const entriesArr = Array.from(bySig.values());
    const fields = entriesArr.map(function (e) {
      var sel = e.tag;
      if (e.classes.length) {
        try { sel += "." + e.classes.map(function (c) { return CSS.escape(c); }).join("."); }
        catch (_) { sel += "." + e.classes.join("."); }
      }
      return {
        selector: sel,
        fallbackSelector: e.fallbackSelector || "",
        attribute: e.attribute,
        dataType: _detectDataType(e.values[0] || "", e.attribute),
        sampleValues: e.values.slice(),
        occurrenceFraction: e.count / items.length,
      };
    });

    if (fields.length === 0) {
      console.warn("[Jaal.htmlExtractor] buildSyntheticSuperItem — 0 fields found across " +
        items.length + " items! First item outerHTML preview:", items[0].outerHTML.slice(0, 600));
      return { html: "<div class=\"jaal-super-item\"></div>", htmlBlocks: [], fieldCount: 0, itemCount: items.length, leaves: [] };
    }

    // Emit up to 3 synthetic blocks, each using a different sample value per field.
    // The AI sees realistic value variation across blocks, enabling better semantic inference.
    var numBlocks = Math.min(3, Math.max(1, items.length));
    var htmlBlocks = [];
    for (var blockIdx = 0; blockIdx < numBlocks; blockIdx++) {
      var blockParts = entriesArr.map(function (e) {
        return _buildSuperItemNode(e, e.values[blockIdx] || e.values[0] || "");
      });
      htmlBlocks.push("<div class=\"jaal-super-item\" data-sample=\"" + blockIdx + "\">" + blockParts.join("") + "</div>");
    }
    var html = htmlBlocks.join("\n");

    console.log("[Jaal.htmlExtractor] buildSyntheticSuperItem — done items=" + items.length
      + " uniqueFields=" + fields.length + " blocks=" + htmlBlocks.length);

    return { html: html, htmlBlocks: htmlBlocks, fieldCount: fields.length, itemCount: items.length, leaves: fields };
  }

  ns.htmlExtractor = {
    extractMinimalHTML,
    analyzeParent,
    unwrapToRepeatingItems,
    buildSyntheticSuperItem,
  };
  console.log("[Jaal] html-extractor loaded");

})(typeof globalThis !== "undefined" ? globalThis : this);
