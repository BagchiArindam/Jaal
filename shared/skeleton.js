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

  ns.skeleton = {
    inspect,
    SKIP_TAGS,
    MAX_DEPTH_DEFAULT,
    COLLAPSE_THRESHOLD_DEFAULT,
  };
  console.log("[Jaal] skeleton loaded");

})(typeof globalThis !== "undefined" ? globalThis : (function() {
  try { return this; } catch(_) { return window; }
})());
