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
      parentAnalysis = Jaal.htmlExtractor.analyzeParent(containerEl);
      superItem = Jaal.htmlExtractor.buildSyntheticSuperItem(parentAnalysis.items);

      if (superItem.fieldCount > 0) {
        samples = [superItem.html];
        metadata = {
          url: window.location.href,
          containerTag: containerEl.tagName.toLowerCase(),
          containerClasses: containerEl.className || "",
          containerId: containerEl.id || "",
          totalItems: parentAnalysis.items.length,
          itemSelector: parentAnalysis.itemSelector,
          layout: parentAnalysis.layout,
          fieldCount: superItem.fieldCount,
          superItem: true,
        };
        log.info("super_item_built", {
          phase: "load",
          items: parentAnalysis.items.length,
          fields: superItem.fieldCount,
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
      // Prefer the deterministic itemSelector from analyzeParent — the server
      // only saw the synthetic super-item and can't infer the real DOM's
      // repeating-unit selector.
      if (parentAnalysis && parentAnalysis.itemSelector) {
        analysis.itemSelector = parentAnalysis.itemSelector;
      }
      const validation = validateAnalysis(containerEl, analysis);
      if (!validation.valid) {
        if (loadingInst) loadingInst.showError("Analysis failed: " + validation.reason + ". Try selecting a different element.");
        return;
      }

      if (Jaal.toolbar) {
        const key = "manual-" + (++_manualCounter);
        const inst = (loadingInst && loadingInst.upgrade)
          ? loadingInst.upgrade(
              { columns: validation.columns, itemSelector: analysis.itemSelector },
              containerEl,
              analysis.itemSelector,
              validation.itemCount,
              { containerSelector: containerSelector, label: "Jaal · pick", configId: key }
            )
          : Jaal.toolbar.create(
              { columns: validation.columns, itemSelector: analysis.itemSelector },
              containerEl,
              analysis.itemSelector,
              validation.itemCount,
              { containerSelector: containerSelector, label: "Jaal · pick", configId: key }
            );
        Jaal._activeToolbars.set(key, inst);
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

  function validateAnalysis(container, analysis) {
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
      for (let i = 0; i < Math.min(3, items.length); i++) {
        if (items[i].querySelector(safeSel)) return true;
      }
      return false;
    });
    if (validColumns.length === 0) {
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

  log.info("content_main_ready", { phase: "init" });
})();
