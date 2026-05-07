/**
 * extension/content/content-main.js — content-script entry point (isolated world).
 *
 * Routes background → content activation messages to the appropriate overlay or
 * orchestrates the picker → analyze → toolbar flow. Supports multiple toolbar
 * instances spawned per-config from jaal-auto-activate-multi.
 *
 * Handled messages (from background via B.tabs.sendMessage):
 *   jaal-activate-skeleton       → Jaal.skeletonOverlay.show()
 *   jaal-activate-net-recorder   → Jaal.netRecorderOverlay.show()
 *   jaal-activate-picker         → startPicking()
 *   jaal-start-pick              → startPicking() (repick)
 *   jaal-auto-activate           → autoActivate(legacyConfig)
 *   jaal-auto-activate-multi     → for each config, autoActivate(legacyConfig)
 *
 * Exposed globals:
 *   window.Jaal.startPicking()  — called directly by toolbar repick button
 *   window.Jaal._activeToolbars  — Map<configId, instance> for live tracking
 */
(function () {
  "use strict";

  // CRITICAL: In Firefox content scripts, window !== globalThis.
  const _root = (typeof globalThis !== "undefined") ? globalThis : window;

  if (_root.__jaalContentMainLoaded) {
    console.log("[Jaal content-main] already loaded — re-registering message listener");
  } else {
    _root.__jaalContentMainLoaded = true;
  }

  const Jaal = (_root.Jaal = _root.Jaal || {});
  const log  = Jaal.makeLogger ? Jaal.makeLogger("content-main") : console;
  const B    = typeof browser !== "undefined" ? browser : chrome;

  // Track live toolbar instances keyed by configId (or "manual-<n>" for picks)
  Jaal._activeToolbars = Jaal._activeToolbars || new Map();
  let _manualCounter = 0;

  console.log("[Jaal content-main] initializing, Jaal keys:", Object.keys(Jaal).join(","));

  // --- Message routing ---

  B.runtime.onMessage.addListener(function (msg) {
    if (!msg || typeof msg.type !== "string") return;
    console.log("[Jaal content-main] message received:", msg.type);

    if (msg.type === "jaal-activate-skeleton") {
      if (Jaal.skeletonOverlay && Jaal.skeletonOverlay.show) {
        log.info("activate_skeleton", { phase: "mutate" });
        Jaal.skeletonOverlay.show();
      } else {
        console.error("[Jaal content-main] skeletonOverlay not available");
      }

    } else if (msg.type === "jaal-activate-net-recorder") {
      if (Jaal.netRecorderOverlay && Jaal.netRecorderOverlay.show) {
        log.info("activate_net_recorder", { phase: "mutate" });
        Jaal.netRecorderOverlay.show();
      } else {
        console.error("[Jaal content-main] netRecorderOverlay not available");
      }

    } else if (msg.type === "jaal-activate-picker" || msg.type === "jaal-start-pick") {
      log.info("activate_picker", { phase: "mutate", src: msg.type });
      startPicking();

    } else if (msg.type === "jaal-auto-activate") {
      // Legacy single-config message
      log.info("auto_activate", { phase: "mutate", url: msg.config && msg.config.urlPattern });
      autoActivate(msg.config, null);

    } else if (msg.type === "jaal-auto-activate-multi") {
      const configs = Array.isArray(msg.configs) ? msg.configs : [];
      log.info("auto_activate_multi", { phase: "mutate", count: configs.length });
      for (let i = 0; i < configs.length; i++) {
        const cfg = configs[i];
        if (!cfg || !cfg.parentSelector) continue;
        const legacy = _configToLegacyShape(cfg);
        autoActivate(legacy, cfg);
      }

    } else if (msg.type === "jaal-open-modal") {
      log.info("open_modal", { phase: "mutate" });
      if (Jaal.modal && Jaal._activeToolbars.size > 0) {
        // Already have active toolbars — just surface the modal
        Jaal.modal.openOrFocus();
      } else if (Jaal.modal) {
        // No active toolbars yet — will be handled by jaal-auto-activate-multi sent after this
        Jaal.modal.openOrFocus();
      } else {
        console.warn("[Jaal content-main] jaal-open-modal received but Jaal.modal not loaded");
      }

    } else if (msg.type === "jaal-manual-spawn-config") {
      const configId = msg.configId;
      log.info("manual_spawn_config", { phase: "mutate", configId: configId });
      if (configId) Jaal.activateConfig(configId);
    }
  });

  // Adapter: convert v2 config to the (containerSelector, itemSelector,
  // columns, pagination) shape the autoActivate path uses internally.
  function _configToLegacyShape(cfg) {
    return {
      containerSelector: cfg.parentSelector,
      itemSelector:      cfg.itemSelector,
      columns:           cfg.columns || [],
      pagination:        cfg.pagination || null,
      urlPattern:        (cfg.domain || "") + (cfg.pathPattern || ""),
    };
  }

  // --- Picker orchestration ---

  async function startPicking() {
    console.log("[Jaal content-main] startPicking called, Jaal.picker =", !!Jaal.picker);
    if (!Jaal.picker) {
      console.error("[Jaal content-main] picker not loaded");
      return;
    }
    if (Jaal.picker.isActive()) {
      console.log("[Jaal content-main] picker already active");
      return;
    }

    let loadingInst = null;
    try {
      const { element: containerEl, hint: hintEl } = await Jaal.picker.activate({
        tooltipHeader: "Click the LIST CONTAINER (parent)",
        prompt: "Pick the PARENT element that holds all repeating items — not an item itself. Scroll ↕ to walk up the tree.",
        highlightColor: "#ff6b35",
      });

      log.info("container_picked", { phase: "mutate", tag: containerEl.tagName });

      if (Jaal.toolbar) {
        loadingInst = Jaal.toolbar.showLoading("Analyzing…", containerEl);
        loadingInst.onClose(function () {
          if (Jaal.sorter) Jaal.sorter.clearOriginalOrder();
        });
      }

      await analyzeAndBuildToolbar(containerEl, hintEl, loadingInst);

    } catch (err) {
      if (err.message === "Picker cancelled") {
        if (loadingInst) loadingInst.destroy();
        return;
      }
      log.error("picker_error", { phase: "error", err: err.message });
      if (loadingInst) loadingInst.showError("Picker error: " + err.message);
    }
  }

  async function analyzeAndBuildToolbar(containerEl, hintEl, loadingInst) {
    const containerSelector = buildSelector(containerEl);

    let metadata, samples, parentAnalysis = null, superItem = null;
    if (Jaal.htmlExtractor
        && Jaal.htmlExtractor.analyzeParent
        && Jaal.htmlExtractor.buildSyntheticSuperItem) {
      // New flow (Tier 5): walk every item's leaves, send a single synthetic
      // super-item to the AI so missing-field cases are eliminated.
      parentAnalysis = Jaal.htmlExtractor.analyzeParent(containerEl, hintEl);
      superItem = Jaal.htmlExtractor.buildSyntheticSuperItem(parentAnalysis.items);

      if (superItem.fieldCount > 0) {
        // Send up to 3 synthetic blocks so AI sees value variation across items
        samples = superItem.htmlBlocks && superItem.htmlBlocks.length > 0
          ? superItem.htmlBlocks
          : [superItem.html];
        const directChildren = Array.from(containerEl.children);
        const tagCounts = {};
        directChildren.forEach(function (c) {
          var t = c.tagName || "#";
          tagCounts[t] = (tagCounts[t] || 0) + 1;
        });
        metadata = {
          url: window.location.href,
          containerTag: containerEl.tagName.toLowerCase(),
          containerClasses: containerEl.className || "",
          containerId: containerEl.id || "",
          totalChildren: directChildren.length,
          totalItems: parentAnalysis.items.length,
          itemSelector: parentAnalysis.itemSelector,
          layout: parentAnalysis.layout,
          unwrappedGrid: parentAnalysis.layout === "2D-matrix",
          childTagDistribution: tagCounts,
          fieldCount: superItem.fieldCount,
          superItem: true,
        };
        log.info("super_item_built", {
          phase: "load",
          items: parentAnalysis.items.length,
          fields: superItem.fieldCount,
          blocks: samples.length,
          layout: parentAnalysis.layout,
        });
      } else {
        // Fallback to legacy random-sample flow if super-item produced no fields
        log.warn("super_item_empty_fallback", { phase: "load" });
        const extracted = Jaal.htmlExtractor.extractMinimalHTML(containerEl, 3, hintEl);
        metadata = extracted.metadata;
        samples  = extracted.samples;
      }
    } else if (Jaal.htmlExtractor && Jaal.htmlExtractor.extractMinimalHTML) {
      const extracted = Jaal.htmlExtractor.extractMinimalHTML(containerEl, 3, hintEl);
      metadata = extracted.metadata;
      samples  = extracted.samples;
    } else {
      const children = Array.from(containerEl.children).slice(0, 3);
      samples  = children.map(function (el) { return el.outerHTML; });
      metadata = { url: window.location.href, containerTag: containerEl.tagName.toLowerCase() };
    }

    try {
      const response = await sendToBackground({
        type: "jaal-analyze",
        payload: { metadata: metadata, samples: samples, url: window.location.href },
      });

      if (!response || !response.ok) {
        const msg = response && response.error ? response.error : "Server error";
        handleAnalysisError(msg, loadingInst);
        return;
      }

      const analysis = response.data;

      // Echo runId to console so the diagnostician can find the debug artifacts
      const runId = analysis.runId || null;
      if (runId) console.log("[Jaal] runId=" + runId);
      delete analysis.runId;

      // Strip any jaal-* class from the AI's itemSelector (e.g. ".jaal-super-item"
      // only exists in the synthetic prompt artifact, not in the real DOM).
      if (analysis.itemSelector && /\bjaal-/.test(analysis.itemSelector)) {
        console.warn("[Jaal] AI leaked synthetic class into itemSelector — discarding:", analysis.itemSelector);
        delete analysis.itemSelector;
      }

      // Choose between the AI's itemSelector and analyzeParent's deterministic one.
      // The AI sees data-jaal-path hints and often returns a tighter class-specific
      // selector. Prefer it when it resolves to a reasonable item count (≥5 and no
      // more than 1.5× the parent count). Fall back to the parent's selector when
      // the AI's is too broad, empty, or invalid.
      (function _pickItemSelector() {
        const aiSel = analysis.itemSelector;
        const parentSel = parentAnalysis ? parentAnalysis.itemSelector : null;
        const parentCount = parentAnalysis ? parentAnalysis.items.length : 0;

        if (!aiSel || !containerEl) {
          if (parentSel) analysis.itemSelector = parentSel;
          return;
        }

        let aiCount = 0;
        try {
          const safeSel = aiSel.trimStart().startsWith(">") ? ":scope " + aiSel : aiSel;
          aiCount = containerEl.querySelectorAll(safeSel).length;
        } catch (_) {
          if (parentSel) analysis.itemSelector = parentSel;
          log.info("item_selector_decision", { phase: "mutate", chose: "parent", reason: "ai-sel-invalid", aiSel: aiSel });
          return;
        }

        const parentTooMany = parentCount > aiCount * 1.4;
        const aiReasonable  = aiCount >= 5 && aiCount <= Math.max(parentCount * 1.5, aiCount);

        if (aiReasonable && parentTooMany) {
          // AI found a tighter, more specific set — use it
          analysis.itemSelector = aiSel;
          log.info("item_selector_decision", { phase: "mutate", chose: "ai", aiSel: aiSel, aiCount: aiCount, parentSel: parentSel, parentCount: parentCount });
        } else {
          if (parentSel) analysis.itemSelector = parentSel;
          log.info("item_selector_decision", { phase: "mutate", chose: "parent", aiSel: aiSel, aiCount: aiCount, parentSel: parentSel, parentCount: parentCount });
        }
      })();

      // Validate each AI-returned column selector against real items.
      // If a selector matches 0 or >1 elements per card, substitute the
      // deterministic fallbackSelector recorded during super-item construction.
      // usedLeafIndices ensures each leaf is consumed at most once across columns.
      const _leaves = superItem && superItem.leaves && superItem.leaves.length > 0
        ? superItem.leaves : [];
      if (_leaves.length > 0) {
        const usedLeafIndices = new Set();
        analysis.columns = (analysis.columns || []).map(function (col) {
          return _validateOrFallbackColumn(col, containerEl, analysis.itemSelector, _leaves, usedLeafIndices);
        });
      }

      const validation = validateAnalysis(containerEl, analysis, _leaves);
      if (!validation.valid) {
        if (loadingInst) loadingInst.showError("Analysis failed: " + validation.reason + ". Try selecting a different element.");
        return;
      }

      if (Jaal.toolbar) {
        const key = "manual-" + (++_manualCounter);
        const toolbarOpts = { containerSelector: containerSelector, label: "Jaal · pick", configId: key, runId: runId };
        // Use the actual DOM count for the chosen itemSelector rather than the
        // raw parentAnalysis count — important when AI's selector was preferred.
        let canonicalCount = validation.itemCount;
        try {
          const safeSel = analysis.itemSelector.trimStart().startsWith(">")
            ? ":scope " + analysis.itemSelector : analysis.itemSelector;
          const domCount = containerEl.querySelectorAll(safeSel).length;
          if (domCount >= 1) canonicalCount = domCount;
        } catch (_) {
          if (parentAnalysis && parentAnalysis.items) canonicalCount = parentAnalysis.items.length;
        }
        const inst = (loadingInst && loadingInst.upgrade)
          ? loadingInst.upgrade(
              { columns: validation.columns, itemSelector: analysis.itemSelector },
              containerEl,
              analysis.itemSelector,
              canonicalCount,
              toolbarOpts
            )
          : Jaal.toolbar.create(
              { columns: validation.columns, itemSelector: analysis.itemSelector },
              containerEl,
              analysis.itemSelector,
              canonicalCount,
              toolbarOpts
        );
        Jaal._activeToolbars.set(key, inst);
        if (Jaal.modal) {
          Jaal.modal.addToolbarTab(inst); // also calls _ensureCreated + shows modal
        }
        inst.onClose(function () {
          Jaal._activeToolbars.delete(key);
          if (Jaal.sorter) Jaal.sorter.clearOriginalOrder();
        });
      }

      log.info("toolbar_built", { phase: "init", cols: validation.columns.length, items: validation.itemCount });

    } catch (err) {
      handleAnalysisError(err.message, loadingInst);
    }
  }

  // Validate an AI-returned column selector against real items in the DOM.
  // If a selector matches 0 or >1 elements per item, substitute the
  // deterministic fallbackSelector recorded during super-item construction.
  // Never returns an unfixed column without logging the decision.
  // usedLeafIndices: Set<number> — shared across all column calls so each leaf
  // is consumed at most once in the positional fallback step.
  function _validateOrFallbackColumn(col, container, itemSel, superLeaves, usedLeafIndices) {
    if (!col || (!col.selector && col.selector !== "")) return col;
    if (col.selector === "") return col; // "" means the item itself — always valid

    const safeSel = col.selector.trimStart().startsWith(">")
      ? ":scope " + col.selector
      : col.selector;
    const safeItemSel = itemSel && itemSel.trimStart().startsWith(">")
      ? ":scope " + itemSel
      : itemSel;

    const sampleItems = Array.from(container.querySelectorAll(safeItemSel)).slice(0, 5);
    if (sampleItems.length === 0) return col;

    const matchCounts = sampleItems.map(function (item) {
      try { return item.querySelectorAll(safeSel).length; } catch (_) { return 0; }
    });
    const allExactlyOne = matchCounts.every(function (n) { return n === 1; });
    if (allExactlyOne) return col; // AI's selector is valid

    const leaves = superLeaves || [];
    console.warn("[Jaal validate] col='" + col.name + "' ai='" + col.selector +
                 "' matched=" + JSON.stringify(matchCounts) + " — searching fallback");

    // Strategy 1: class overlap
    const colClasses = (col.selector.match(/\.[\w-]+/g) || []).map(function (c) { return c.slice(1); });
    let bestIdx = -1;
    let bestScore = 0;
    for (var i = 0; i < leaves.length; i++) {
      if (usedLeafIndices && usedLeafIndices.has(i)) continue;
      var leaf = leaves[i];
      var leafClasses = (leaf.selector.match(/\.[\w-]+/g) || []).map(function (c) { return c.slice(1); });
      var shared = colClasses.filter(function (c) { return leafClasses.indexOf(c) >= 0; }).length;
      if (shared > bestScore) { bestScore = shared; bestIdx = i; }
    }
    if (bestIdx >= 0 && bestScore > 0) {
      var chosen = leaves[bestIdx].fallbackSelector || leaves[bestIdx].selector;
      if (usedLeafIndices) usedLeafIndices.add(bestIdx);
      console.warn("[Jaal validate] → class-match leaf[" + bestIdx + "] sel='" + chosen + "'");
      return Object.assign({}, col, { selector: chosen });
    }

    // Strategy 2: dataType match
    var colDataType = col.dataType || "";
    for (var j = 0; j < leaves.length; j++) {
      if (usedLeafIndices && usedLeafIndices.has(j)) continue;
      if (leaves[j].dataType === colDataType && colDataType !== "" && colDataType !== "text") {
        var chosen2 = leaves[j].fallbackSelector || leaves[j].selector;
        if (usedLeafIndices) usedLeafIndices.add(j);
        console.warn("[Jaal validate] → dataType-match leaf[" + j + "] dataType=" + colDataType + " sel='" + chosen2 + "'");
        return Object.assign({}, col, { selector: chosen2 });
      }
    }

    // Strategy 3: next unused leaf (positional)
    for (var k = 0; k < leaves.length; k++) {
      if (usedLeafIndices && usedLeafIndices.has(k)) continue;
      var chosen3 = leaves[k].fallbackSelector || leaves[k].selector;
      if (usedLeafIndices) usedLeafIndices.add(k);
      console.warn("[Jaal validate] → positional leaf[" + k + "] sel='" + chosen3 + "'");
      return Object.assign({}, col, { selector: chosen3 });
    }

    console.warn("[Jaal validate] → no fallback available for '" + col.name + "', keeping AI selector");
    return col;
  }

  // Infer a human-readable name from a super-item leaf for promoted columns.
  function _guessNameFromLeaf(leaf, index) {
    if (leaf.dataType === "currency") return "Price";
    if (leaf.dataType === "rating") return "Rating";
    if (leaf.dataType === "date") return "Date";
    if (leaf.dataType === "image") return "Image";
    if (leaf.dataType === "url") return "URL";
    if (leaf.sampleValues && leaf.sampleValues[0]) {
      var v = String(leaf.sampleValues[0]).trim();
      if (v.length <= 12) return v;
    }
    var selStr = leaf.fallbackSelector || leaf.selector || "";
    var m = selStr.match(/\.([\w-]+)\s*$/);
    if (m) return m[1].replace(/[-_]/g, " ").replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    return "Field " + (index + 1);
  }

  function validateAnalysis(container, analysis, superLeaves) {
    if (!analysis || !analysis.itemSelector) {
      return { valid: false, reason: "No itemSelector in analysis" };
    }
    const safeItemSel = analysis.itemSelector.trimStart().startsWith(">")
      ? ":scope " + analysis.itemSelector
      : analysis.itemSelector;
    const items = container.querySelectorAll(safeItemSel);
    if (items.length === 0) {
      return { valid: false, reason: "itemSelector \"" + analysis.itemSelector + "\" matched 0 elements" };
    }
    if (!analysis.columns || analysis.columns.length === 0) {
      return { valid: false, reason: "No columns identified" };
    }
    const validColumns = analysis.columns.filter(function (col) {
      if (!col.selector || col.selector === "") return true;
      const safeSel = col.selector.trimStart().startsWith(">") ? ":scope " + col.selector : col.selector;
      for (var i = 0; i < Math.min(3, items.length); i++) {
        if (items[i].querySelector(safeSel)) return true;
      }
      return false;
    });
    if (validColumns.length === 0) {
      // AI returned no usable selectors and all fallbacks are exhausted.
      // Promote super-item leaves directly to columns so the user gets a
      // working toolbar (possibly with extra columns to hide) instead of an error.
      var leaves = superLeaves || [];
      if (leaves.length > 0) {
        var promoted = leaves.map(function (leaf, i) {
          return {
            name: _guessNameFromLeaf(leaf, i),
            selector: leaf.fallbackSelector || leaf.selector || "",
            attribute: leaf.attribute || "textContent",
            dataType: leaf.dataType || "text",
            hidden: false,
          };
        });
        console.warn("[Jaal] validateAnalysis: AI columns all invalid — promoting " +
          promoted.length + " super-item leaves to columns");
        return { valid: true, columns: promoted, itemCount: items.length, autoPromoted: true };
      }
      return { valid: false, reason: "No column selectors matched actual elements" };
    }
    return { valid: true, columns: validColumns, itemCount: items.length };
  }

  function handleAnalysisError(message, loadingInst) {
    let userMsg;
    if (message && (message.includes("Failed to fetch") || message.includes("NetworkError") || message.includes("net::ERR"))) {
      userMsg = "Cannot reach Jaal server. Make sure it is running on port 7773.";
    } else {
      userMsg = "Error: " + (message || "Unknown error");
    }
    if (loadingInst) loadingInst.showError(userMsg);
    else if (Jaal.toolbar) Jaal.toolbar.showError(userMsg);
    log.error("analysis_error", { phase: "error", message: message });
  }

  function buildSelector(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 5) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift("#" + CSS.escape(cur.id));
        break;
      }
      if (cur.className && typeof cur.className === "string") {
        const classes = cur.className.trim().split(/\s+/)
          .filter(function (c) { return !c.startsWith("jaal-"); })
          .slice(0, 2);
        if (classes.length) part += "." + classes.map(function (c) { return CSS.escape(c); }).join(".");
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function sendToBackground(message) {
    return new Promise(function (resolve) {
      B.runtime.sendMessage(message, resolve);
    });
  }

  // --- Auto-activate from finalized config ---

  function _tryAutoActivate(config, v2cfg) {
    const containerEl = document.querySelector(config.containerSelector);
    if (!containerEl) return false;
    const safeItemSel = config.itemSelector && config.itemSelector.trimStart().startsWith(">")
      ? ":scope " + config.itemSelector
      : config.itemSelector;
    if (!safeItemSel) return false;
    const items = containerEl.querySelectorAll(safeItemSel);
    if (items.length === 0) return false;

    const key = (v2cfg && v2cfg.id) || ("auto-" + (++_manualCounter));
    if (Jaal._activeToolbars.has(key)) {
      // Already spawned for this config (e.g. mutation observer fired twice)
      return true;
    }

    if (Jaal.toolbar) {
      const inst = Jaal.toolbar.create(
        { columns: config.columns, itemSelector: config.itemSelector },
        containerEl,
        config.itemSelector,
        items.length,
        {
          containerSelector: config.containerSelector,
          pagination: config.pagination || null,
          finalized: true,
          label: (v2cfg && v2cfg.label) || "Jaal",
          configId: key,
          searchInputSelector: v2cfg && v2cfg.searchInputSelector,
          searchInputValue:    v2cfg && v2cfg.searchInputValue,
        }
      );
      Jaal._activeToolbars.set(key, inst);
      if (Jaal.modal) {
        Jaal.modal.addToolbarTab(inst);
      }
      inst.onClose(function () {
        Jaal._activeToolbars.delete(key);
        if (Jaal.sorter) Jaal.sorter.clearOriginalOrder();
      });
    }

    // Pre-fill the page's search input if the saved config has one
    if (v2cfg && v2cfg.searchInputSelector && v2cfg.searchInputValue) {
      _prefillSearchInput(v2cfg.searchInputSelector, v2cfg.searchInputValue);
    }
    log.info("auto_activated", { phase: "init", items: items.length, cols: config.columns.length, configId: key });
    return true;
  }

  function autoActivate(config, v2cfg) {
    if (!config || !config.containerSelector) return;
    if (_tryAutoActivate(config, v2cfg)) return;

    // SPA: content not in DOM yet — watch for mutations up to 30s
    let done = false;
    const observer = new MutationObserver(function () {
      if (done) return;
      if (_tryAutoActivate(config, v2cfg)) { done = true; observer.disconnect(); clearInterval(poll); clearTimeout(timeout); }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const poll = setInterval(function () {
      if (done) return;
      if (_tryAutoActivate(config, v2cfg)) { done = true; observer.disconnect(); clearInterval(poll); clearTimeout(timeout); }
    }, 2000);

    const timeout = setTimeout(function () {
      if (!done) {
        observer.disconnect();
        clearInterval(poll);
        log.warn("auto_activate_timeout", { phase: "init", containerSel: config.containerSelector });
      }
    }, 30000);
  }

  // Pre-fill a page <input> with the saved search value. Skip if the input
  // already has a non-empty value (don't clobber user input).
  function _prefillSearchInput(selector, value) {
    try {
      const el = document.querySelector(selector);
      if (!el) {
        log.warn("search_prefill_no_match", { phase: "init", selector: selector });
        return;
      }
      if (el.value && el.value.length > 0) {
        log.info("search_prefill_skip_nonempty", { phase: "init" });
        return;
      }
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      log.info("search_prefilled", { phase: "init", value: value });
    } catch (err) {
      log.warn("search_prefill_failed", { phase: "error", err: err && err.message });
    }
  }

  // Expose for toolbar repick button
  Jaal.startPicking = startPicking;

  // Expose for modal's ▶ Spawn button: activate a saved config by id
  Jaal.activateConfig = function (configId) {
    if (!B) { console.warn("[Jaal] activateConfig: no B"); return; }
    B.storage.local.get("jaal_configs", function (result) {
      const configs = Array.isArray(result && result.jaal_configs) ? result.jaal_configs : [];
      const cfg = configs.find(function (c) { return c.id === configId; });
      if (!cfg) { console.warn("[Jaal] activateConfig: not found", configId); return; }
      const legacy = _configToLegacyShape(cfg);
      autoActivate(legacy, cfg);
      log.info("activate_config", { phase: "mutate", configId: configId });
    });
  };

  log.info("content_main_ready", { phase: "init" });
})();
