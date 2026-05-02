/**
 * shared/skeleton.js — DOM skeleton tree builder.
 *
 * Walks a live DOM subtree, collapses consecutive siblings with matching
 * tag+class signatures, and emits a lightweight tree + text rendering.
 *
 * Exposes: window.Jaal.skeleton
 *   .inspect(root, opts)  — walk and return { tree: <text>, treeJson: <node>, capturedAt }
 *   .SKIP_TAGS            — the Set of tag names the walker ignores
 *
 * Ported from D:\Dev\dom-skeleton-inspector\dom-skeleton-inspector.user.js —
 * tree/annotation logic only. The floating overlay UI lives in extension/ui
 * and the userscript shim, not here.
 */
(function (global) {
  "use strict";

  const ns = (global.Jaal = global.Jaal || {});

  const MAX_DEPTH_DEFAULT = 8;
  const COLLAPSE_THRESHOLD_DEFAULT = 3;

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "LINK", "META", "BR",
    "SVG", "CANVAS", "IFRAME", "INPUT", "TEXTAREA", "SELECT",
  ]);

  function getLayoutAnnotation(el) {
    try {
      const cs = (el.ownerDocument && el.ownerDocument.defaultView || window).getComputedStyle(el);
      const parts = [];

      const display = cs.display;
      if (display && display !== "block" && display !== "inline" && display !== "none" && display !== "inline-block") {
        parts.push(display.replace("inline-", "i-"));
      }

      if (display === "flex" || display === "inline-flex") {
        const fd = cs.flexDirection;
        if (fd && fd !== "row") parts.push(fd);
      }

      if (display === "grid" || display === "inline-grid") {
        const gtc = cs.gridTemplateColumns;
        if (gtc && gtc !== "none" && gtc !== "auto") {
          const cols = gtc.trim().split(/\s+/).length;
          parts.push("grid-" + cols + "col");
        }
      }

      const ox = cs.overflowX;
      const oy = cs.overflowY;
      if (ox === "auto" || ox === "scroll") parts.push("scroll-x");
      if (oy === "auto" || oy === "scroll") parts.push("scroll-y");

      const pos = cs.position;
      if (pos === "sticky" || pos === "fixed") parts.push(pos);

      return parts.length ? "[" + parts.join(", ") + "]" : "";
    } catch (_) {
      return "";
    }
  }

  function elementSignature(el) {
    const tag = el.tagName.toLowerCase();
    const classes = Array.from(el.classList).slice(0, 2).join(".");
    return tag + (classes ? "." + classes : "");
  }

  function buildLabel(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? "#" + el.id : "";
    const classes = Array.from(el.classList).slice(0, 3).map((c) => "." + c).join("");
    const layout = getLayoutAnnotation(el);
    return tag + id + classes + (layout ? " " + layout : "");
  }

  function walkNode(el, depth, maxDepth, collapseThreshold) {
    if (SKIP_TAGS.has(el.tagName)) return null;

    const node = {
      label: buildLabel(el),
      sig: elementSignature(el),
      children: [],
      count: 1,
    };

    if (depth < maxDepth) {
      const visibleChildren = Array.from(el.children).filter((c) => !SKIP_TAGS.has(c.tagName));

      const groups = [];
      for (const child of visibleChildren) {
        const sig = elementSignature(child);
        if (groups.length > 0 && groups[groups.length - 1].sig === sig) {
          groups[groups.length - 1].els.push(child);
        } else {
          groups.push({ sig, els: [child] });
        }
      }

      for (const group of groups) {
        if (group.els.length >= collapseThreshold) {
          const rep = walkNode(group.els[0], depth + 1, maxDepth, collapseThreshold);
          if (rep) {
            rep.count = group.els.length;
            node.children.push(rep);
          }
        } else {
          for (const child of group.els) {
            const childNode = walkNode(child, depth + 1, maxDepth, collapseThreshold);
            if (childNode) node.children.push(childNode);
          }
        }
      }
    }

    return node;
  }

  function renderTextTree(node, prefix, isLast) {
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";
    const countStr = node.count > 1 ? " × " + node.count : "";
    let out = prefix + connector + node.label + countStr + "\n";
    for (let i = 0; i < node.children.length; i++) {
      out += renderTextTree(node.children[i], prefix + childPrefix, i === node.children.length - 1);
    }
    return out;
  }

  function buildTextTree(rootNode, rootLabel) {
    let text = rootLabel + "\n";
    for (let i = 0; i < rootNode.children.length; i++) {
      text += renderTextTree(rootNode.children[i], "", i === rootNode.children.length - 1);
    }
    return text.trim();
  }

  /**
   * Inspect a DOM subtree and return the skeleton.
   * @param {Element} [root=document.body] — root to walk
   * @param {object} [opts]
   * @param {number} [opts.maxDepth=8]
   * @param {number} [opts.collapseThreshold=3]
   * @returns {{ tree: string, treeJson: object, capturedAt: string, url: string, settings: object }}
   */
  function inspect(root, opts) {
    const target = root || document.body;
    if (!target) throw new Error("Jaal.skeleton.inspect: no root element");

    const maxDepth = (opts && opts.maxDepth) || MAX_DEPTH_DEFAULT;
    const collapseThreshold = (opts && opts.collapseThreshold) || COLLAPSE_THRESHOLD_DEFAULT;

    console.log("[Jaal.skeleton] inspect starting — maxDepth=" + maxDepth + " collapseThreshold=" + collapseThreshold);

    const rootNode = walkNode(target, 0, maxDepth, collapseThreshold);
    if (!rootNode) throw new Error("Jaal.skeleton.inspect: root was skipped during walk");

    const rootLabel = target === document.body
      ? "body" + (getLayoutAnnotation(target) ? " " + getLayoutAnnotation(target) : "")
      : rootNode.label;

    const tree = buildTextTree(rootNode, rootLabel);

    console.log("[Jaal.skeleton] inspect complete — " + rootNode.children.length + " top-level children");

    return {
      url: (typeof location !== "undefined" ? location.href : ""),
      capturedAt: new Date().toISOString(),
      settings: { maxDepth, collapseThreshold },
      tree,
      treeJson: rootNode,
    };
  }

  // ─── collectVisualBlocks ─────────────────────────────────────────────────
  //
  // Walk the live DOM from `root` and return an array of visible, block-shaped
  // elements with their bounding rects and short class/id labels.
  // Used by skeleton-overlay.js for Overlay and Panel visual modes.
  //
  // Returns: [ { x, y, w, h, label, depth } ]  (up to ~400 entries)

  const BLOCK_MIN_W = 60;
  const BLOCK_MIN_H = 30;
  const BLOCK_MAX = 400;

  // Depth-to-colour palette (hue only; overlay uses HSLA)
  const DEPTH_HUES = [210, 150, 30, 0, 270, 180, 60, 300];

  function collectVisualBlocks(root) {
    const target = root || document.body;
    const blocks = [];
    const viewW = (typeof window !== "undefined" ? window.innerWidth  : 1280);
    const viewH = (typeof window !== "undefined" ? window.innerHeight : 800);

    function walk(el, depth) {
      if (!el || el.nodeType !== 1) return;
      if (blocks.length >= BLOCK_MAX) return;
      const tag = el.tagName;
      if (SKIP_TAGS.has(tag)) return;

      let rect;
      try { rect = el.getBoundingClientRect(); } catch (_) { return; }

      // Skip invisible or off-screen elements
      if (rect.width < 1 || rect.height < 1) return;
      if (rect.bottom < -viewH || rect.top > viewH * 2) return;
      if (rect.right < 0 || rect.left > viewW * 2)      return;

      try {
        const cs = (el.ownerDocument && el.ownerDocument.defaultView || window).getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return;
        if (parseFloat(cs.opacity) < 0.01) return;
      } catch (_) {}

      // Only emit this element if it meets the size threshold
      if (rect.width >= BLOCK_MIN_W && rect.height >= BLOCK_MIN_H) {
        const id  = el.id ? "#" + el.id : "";
        const cls = Array.from(el.classList)
          .filter(function (c) { return c && !c.startsWith("jaal-"); })
          .slice(0, 3)
          .map(function (c) { return "." + c; })
          .join("");
        blocks.push({
          x:     Math.round(rect.left),
          y:     Math.round(rect.top),
          w:     Math.round(rect.width),
          h:     Math.round(rect.height),
          label: tag.toLowerCase() + id + cls,
          depth: depth,
          hue:   DEPTH_HUES[depth % DEPTH_HUES.length],
        });
      }

      for (var i = 0; i < el.children.length; i++) {
        walk(el.children[i], depth + 1);
      }
    }

    walk(target, 0);
    return blocks;
  }

  ns.skeleton = {
    inspect,
    collectVisualBlocks,
    SKIP_TAGS,
    MAX_DEPTH_DEFAULT,
    COLLAPSE_THRESHOLD_DEFAULT,
    DEPTH_HUES,
  };
  console.log("[Jaal] skeleton loaded");

})(typeof globalThis !== "undefined" ? globalThis : (function() {
  try { return this; } catch(_) { return window; }
})());
