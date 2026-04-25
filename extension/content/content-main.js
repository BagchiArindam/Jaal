/**
 * extension/content/content-main.js — content-script entry point (isolated world).
 *
 * Routes background → content activation messages to the appropriate overlay or
 * orchestrates the picker → analyze → toolbar flow.
 *
 * Handled messages (from background via B.tabs.sendMessage):
 *   jaal-activate-skeleton      → window.Jaal.skeletonOverlay.show()
 *   jaal-activate-net-recorder  → window.Jaal.netRecorderOverlay.show()
 *   jaal-activate-picker        → startPicking()
 *   jaal-start-pick             → startPicking() (repick from toolbar)
 *
 * Exposed globals:
 *   window.Jaal.startPicking()  — called directly by toolbar repick button
 */
(function () {
  "use strict";

  if (window.__jaalContentMainLoaded) {
    console.log("[Jaal content-main] already loaded — re-registering message listener");
    // Don't skip; re-register the listener in case a new UI was injected
  } else {
    window.__jaalContentMainLoaded = true;
  }

  const Jaal = (window.Jaal = window.Jaal || {});
  const log  = Jaal.makeLogger ? Jaal.makeLogger("content-main") : console;
  const B    = typeof browser !== "undefined" ? browser : chrome;

  console.log("[Jaal content-main] initializing, Jaal namespace ready");

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
      log.info("auto_activate", { phase: "mutate", url: msg.config && msg.config.urlPattern });
      autoActivate(msg.config);
    }
  });

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

    try {
      console.log("[Jaal content-main] activating picker...");
      const { element: containerEl, hint: hintEl } = await Jaal.picker.activate({
        tooltipHeader: "Select the list container",
        prompt: "Pick the WRAPPER element containing all repeating items (e.g. a <ul> or grid <div>). Scroll ↕ to walk up the tree.",
        highlightColor: "#ff6b35",
      });

      log.info("container_picked", { phase: "mutate", tag: containerEl.tagName });

      if (Jaal.toolbar) {
        Jaal.toolbar.showLoading("Analyzing…", containerEl);
        Jaal.toolbar.onClose(function () {
          if (Jaal.sorter) Jaal.sorter.clearOriginalOrder();
        });
      }

      await analyzeAndBuildToolbar(containerEl, hintEl);

    } catch (err) {
      if (err.message === "Picker cancelled") {
        if (Jaal.toolbar) Jaal.toolbar.destroy();
        return;
      }
      log.error("picker_error", { phase: "error", err: err.message });
      if (Jaal.toolbar) Jaal.toolbar.showError("Picker error: " + err.message);
    }
  }

  async function analyzeAndBuildToolbar(containerEl, hintEl) {
    const containerSelector = buildSelector(containerEl);

    // Extract minimal HTML for AI analysis
    let metadata, samples;
    if (Jaal.htmlExtractor && Jaal.htmlExtractor.extractMinimalHTML) {
      const extracted = Jaal.htmlExtractor.extractMinimalHTML(containerEl, 3, hintEl);
      metadata = extracted.metadata;
      samples  = extracted.samples;
    } else {
      // Fallback: send raw outerHTML of first 3 children
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
        handleAnalysisError(msg);
        return;
      }

      const analysis = response.data;
      const validation = validateAnalysis(containerEl, analysis);
      if (!validation.valid) {
        if (Jaal.toolbar) Jaal.toolbar.showError("Analysis failed: " + validation.reason + ". Try selecting a different element.");
        return;
      }

      if (Jaal.toolbar) {
        Jaal.toolbar.create(
          { columns: validation.columns, itemSelector: analysis.itemSelector },
          containerEl,
          analysis.itemSelector,
          validation.itemCount,
          { containerSelector: containerSelector }
        );
        Jaal.toolbar.onClose(function () {
          if (Jaal.sorter) Jaal.sorter.clearOriginalOrder();
        });
      }

      log.info("toolbar_built", { phase: "init", cols: validation.columns.length, items: validation.itemCount });

    } catch (err) {
      handleAnalysisError(err.message);
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
    // Keep only columns whose selectors actually match something
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

  function handleAnalysisError(message) {
    let userMsg;
    if (message && (message.includes("Failed to fetch") || message.includes("NetworkError") || message.includes("net::ERR"))) {
      userMsg = "Cannot reach Jaal server. Make sure it is running on port 7773.";
    } else {
      userMsg = "Error: " + (message || "Unknown error");
    }
    if (Jaal.toolbar) Jaal.toolbar.showError(userMsg);
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

  function _tryAutoActivate(config) {
    const containerEl = document.querySelector(config.containerSelector);
    if (!containerEl) return false;
    const safeItemSel = config.itemSelector.trimStart().startsWith(">")
      ? ":scope " + config.itemSelector
      : config.itemSelector;
    const items = containerEl.querySelectorAll(safeItemSel);
    if (items.length === 0) return false;

    if (Jaal.toolbar) {
      Jaal.toolbar.create(
        { columns: config.columns, itemSelector: config.itemSelector },
        containerEl,
        config.itemSelector,
        items.length,
        { containerSelector: config.containerSelector, pagination: config.pagination || null, finalized: true }
      );
      Jaal.toolbar.onClose(function () {
        if (Jaal.sorter) Jaal.sorter.clearOriginalOrder();
      });
    }
    log.info("auto_activated", { phase: "init", items: items.length, cols: config.columns.length });
    return true;
  }

  function autoActivate(config) {
    if (!config || !config.containerSelector) return;
    if (_tryAutoActivate(config)) return;

    // SPA: content not in DOM yet — watch for mutations up to 30 s
    let done = false;
    const observer = new MutationObserver(function () {
      if (done) return;
      if (_tryAutoActivate(config)) { done = true; observer.disconnect(); clearInterval(poll); clearTimeout(timeout); }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const poll = setInterval(function () {
      if (done) return;
      if (_tryAutoActivate(config)) { done = true; observer.disconnect(); clearInterval(poll); clearTimeout(timeout); }
    }, 2000);

    const timeout = setTimeout(function () {
      if (!done) {
        observer.disconnect();
        clearInterval(poll);
        log.warn("auto_activate_timeout", { phase: "init", containerSel: config.containerSelector });
      }
    }, 30000);
  }

  // Expose for toolbar repick button
  Jaal.startPicking = startPicking;

  log.info("content_main_ready", { phase: "init" });
})();
