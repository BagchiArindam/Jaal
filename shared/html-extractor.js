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

  ns.htmlExtractor = { extractMinimalHTML };
  console.log("[Jaal] html-extractor loaded");

})(typeof globalThis !== "undefined" ? globalThis : this);
