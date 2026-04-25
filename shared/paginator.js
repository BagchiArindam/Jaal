/**
 * shared/paginator.js — pagination traversal and list flattening.
 *
 * Ported fresh from sort-sight/extension/content/paginator.js with namespace
 * moved to window.Jaal.paginator.
 *
 * Public API:
 *   detect(paginationElement) → config | null
 *   startFlatten(container, itemSelector, config, options) → Promise
 *   cancel()
 *   reset(container, itemSelector)
 *   getState() → "IDLE" | "TRAVERSING" | "COMPLETE" | "CANCELLED" | "ERROR"
 *   getProgress() → { currentPage, totalPages, totalItems }
 *   onProgress(cb)    cb({ currentPage, totalPages, totalItems })
 *   onPage(cb)        cb({ currentPage, items, totalItems, nextUrl, seenHashes })
 *   onComplete(cb)    cb({ totalPages, totalItems, seenHashes })
 *   onError(cb)       cb(Error)
 *   buildInfiniteScrollConfig(scrollContainer) → config (type = "INFINITE_SCROLL", not traversed yet)
 *   refreshLastVisiblePage(config) → number | null
 *
 * Config shape produced by detect():
 *   { type, nextSelector, prevSelector, pageNumberSelector, loadMoreSelector,
 *     lastVisiblePage, paginationSelector, paginationElement, initialNextUrl }
 *
 * Pagination types:
 *   NUMBERED_PAGES  — click page number buttons / next button (no navigation)
 *   NEXT_PREV_ONLY  — click next/prev buttons (no navigation)
 *   LOAD_MORE       — click "Load more" button (items accumulate in-place)
 *   FORM_PAGES      — fetch-based; next URL derived from <form> submit
 *   LINK_PAGES      — fetch-based; next URL from <a rel="next"> or similar
 *
 * Deferred (not yet implemented):
 *   INFINITE_SCROLL — scroll-based accumulation
 *   resumeState     — checkpoint/resume for fetch-based traversal
 *   rate-limit backoff / exponential retry
 *
 * options for startFlatten():
 *   delayMs           — inter-page delay (default 1500 ms)
 *   containerSelector — CSS selector to find the item container in fetched pages
 *   skipRebuild       — if true, don't inject clones into the live DOM
 *   initialSeenHashes — string[] of already-seen hash fingerprints for dedup
 */
(function (global) {
  "use strict";

  const ns = (global.Jaal = global.Jaal || {});
  const log = ns.makeLogger ? ns.makeLogger("paginator") : console;

  const MAX_PAGES = 100;
  const LOAD_TIMEOUT_MS = 10000;
  const DEFAULT_DELAY_MS = 1500;

  // --- Utilities ---

  function safeQSA(container, selector) {
    const s = selector && selector.trimStart().startsWith(">") ? ":scope " + selector : selector;
    return Array.from(container.querySelectorAll(s));
  }

  function delay(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  }

  // --- Control classification ---

  function getControlText(el) {
    if (el.tagName.toLowerCase() === "input") return (el.value || "").trim().toLowerCase();
    return (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isNextControl(el) {
    const text  = getControlText(el);
    const label = (el.getAttribute("aria-label") || "").toLowerCase();
    const id    = (el.id || "").toLowerCase();
    return (
      text === "next" || text === ">" || text === ">>" || text === "›" || text === "»" ||
      label.includes("next") || label.includes("next page") ||
      el.getAttribute("rel") === "next" || id === "next_page" || id === "nextpage"
    );
  }

  function isPrevControl(el) {
    const text  = getControlText(el);
    const label = (el.getAttribute("aria-label") || "").toLowerCase();
    const id    = (el.id || "").toLowerCase();
    return (
      text === "prev" || text === "previous" || text === "back" || text === "<" ||
      text === "<<" || text === "‹" || text === "«" ||
      label.includes("prev") || el.getAttribute("rel") === "prev" ||
      id === "prev_page" || id === "prevpage"
    );
  }

  function isPageNumber(el) {
    return /^\d+$/.test(getControlText(el));
  }

  function isDisabledBasic(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    if (el.classList.contains("disabled")) return true;
    return false;
  }

  function isDisabled(el) {
    if (isDisabledBasic(el)) return true;
    try {
      const style = window.getComputedStyle(el);
      if (style.pointerEvents === "none" || parseFloat(style.opacity) < 0.4) return true;
    } catch (_) { /* not in live DOM */ }
    return false;
  }

  // --- Content hashing (same algorithm as sorter.hashItem + scrape_runs.py) ---

  function hashItem(el) {
    const text      = (el.textContent || "").replace(/\s+/g, " ").trim().substring(0, 500);
    const firstLink = el.querySelector("a[href]");
    const firstImg  = el.querySelector("img[src]");
    const dataId    = el.getAttribute("data-id") || el.id || "";
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

  // --- Selector builders ---

  function buildUniqueSelector(el, root) {
    const label = el.getAttribute("aria-label");
    if (label) return "[aria-label=\"" + label + "\"]";
    const rel = el.getAttribute("rel");
    if (rel) return "[rel=\"" + rel + "\"]";
    const tag = el.tagName.toLowerCase();
    if (el.className && typeof el.className === "string") {
      const cls = el.className.trim().split(/\s+/).slice(0, 2).join(".");
      if (cls) return tag + "." + cls;
    }
    return tag;
  }

  function buildSharedSelector(els) {
    if (els.length === 0) return null;
    const tag = els[0].tagName.toLowerCase();
    if (els[0].className && typeof els[0].className === "string") {
      const classes = els[0].className.trim().split(/\s+/);
      for (const cls of classes) {
        if (cls && els.every(function (el) { return el.classList.contains(cls); })) {
          return tag + "." + cls;
        }
      }
    }
    return tag;
  }

  // --- Form URL builder ---

  function buildFormUrl(form, baseHref) {
    let resolvedAction;
    try { resolvedAction = new URL(form.getAttribute("action") || "", baseHref).href; }
    catch (_) { resolvedAction = form.getAttribute("action") || ""; }
    const params = new URLSearchParams();
    Array.from(form.querySelectorAll(
      "input[type='hidden'], input[type='text'], input[type='number'], select"
    )).forEach(function (inp) {
      if (inp.name) params.append(inp.name, inp.value || "");
    });
    return resolvedAction + (params.toString() ? "?" + params.toString() : "");
  }

  // --- Detection ---

  function buildLoadMoreConfig(paginationElement, btn) {
    return {
      type: "LOAD_MORE",
      nextSelector: null,
      prevSelector: null,
      pageNumberSelector: null,
      loadMoreSelector: buildUniqueSelector(btn, paginationElement),
      lastVisiblePage: null,
      paginationSelector: buildUniqueSelector(paginationElement, document.body),
      paginationElement: paginationElement,
      initialNextUrl: null,
    };
  }

  function detect(paginationElement) {
    const controls = Array.from(paginationElement.querySelectorAll(
      "a, button, [role='button'], [role='link'], input[type='submit']"
    )).filter(function (el) { return el.offsetParent !== null; });

    log.info("detect_controls", { phase: "load", count: controls.length });

    if (controls.length === 0) {
      const tag = paginationElement.tagName.toLowerCase();
      if (tag === "a" || tag === "button" ||
          (tag === "input" && paginationElement.type === "submit")) {
        const text = getControlText(paginationElement);
        if (text.includes("load more") || text.includes("show more") ||
            text.includes("see more")  || text.includes("view more")) {
          return buildLoadMoreConfig(paginationElement, paginationElement);
        }
      }
      return null;
    }

    const loadMoreBtn = controls.find(function (el) {
      const text = getControlText(el);
      return text.includes("load more") || text.includes("show more") ||
             text.includes("see more")  || text.includes("view more");
    });
    if (loadMoreBtn) return buildLoadMoreConfig(paginationElement, loadMoreBtn);

    const pageNumberEls = controls.filter(isPageNumber);
    const nextEl = controls.find(isNextControl);
    const prevEl = controls.find(isPrevControl);

    log.info("detect_candidates", { phase: "load", pageNumbers: pageNumberEls.length, hasNext: !!nextEl });

    // FORM_PAGES — form-submit inputs
    const formBasedNumbers = pageNumberEls.filter(function (el) {
      return el.tagName.toLowerCase() === "input" && el.closest("form");
    });
    const nextIsFormBased = nextEl && nextEl.tagName.toLowerCase() === "input" && nextEl.closest("form");
    if (formBasedNumbers.length >= 1 || nextIsFormBased) {
      const maxVisible = formBasedNumbers.reduce(function (max, el) {
        const n = parseInt(getControlText(el));
        return n > max ? n : max;
      }, 0);
      const nextForm = nextEl ? nextEl.closest("form") : null;
      const initialNextUrl = nextForm ? buildFormUrl(nextForm, window.location.href) : null;
      log.info("detect_type", { phase: "load", type: "FORM_PAGES", initialNextUrl: initialNextUrl });
      return {
        type: "FORM_PAGES",
        nextButtonId: nextEl ? nextEl.id : null,
        pageNumberSelector: buildSharedSelector(formBasedNumbers.length ? formBasedNumbers : pageNumberEls),
        lastVisiblePage: maxVisible || null,
        initialNextUrl: initialNextUrl,
        paginationSelector: buildUniqueSelector(paginationElement, document.body),
        paginationElement: paginationElement,
      };
    }

    // LINK_PAGES — <a href> next link
    const nextIsLink = nextEl && nextEl.tagName.toLowerCase() === "a" && nextEl.getAttribute("href");
    if (nextIsLink) {
      const maxVisible = pageNumberEls.reduce(function (max, el) {
        const n = parseInt(getControlText(el)); return n > max ? n : max;
      }, 0);
      let initialNextUrl = null;
      try { initialNextUrl = new URL(nextEl.getAttribute("href"), window.location.href).href; }
      catch (_) { initialNextUrl = nextEl.getAttribute("href"); }
      log.info("detect_type", { phase: "load", type: "LINK_PAGES", initialNextUrl: initialNextUrl });
      return {
        type: "LINK_PAGES",
        pageNumberSelector: buildSharedSelector(pageNumberEls),
        initialNextUrl: initialNextUrl,
        lastVisiblePage: maxVisible || null,
        paginationSelector: buildUniqueSelector(paginationElement, document.body),
        paginationElement: paginationElement,
      };
    }

    // NUMBERED_PAGES — click buttons/inputs
    if (pageNumberEls.length >= 2 || (pageNumberEls.length >= 1 && nextEl)) {
      const maxVisible = pageNumberEls.reduce(function (max, el) {
        const n = parseInt(getControlText(el)); return n > max ? n : max;
      }, 0);
      log.info("detect_type", { phase: "load", type: "NUMBERED_PAGES", lastVisiblePage: maxVisible });
      return {
        type: "NUMBERED_PAGES",
        nextSelector: nextEl ? buildUniqueSelector(nextEl, paginationElement) : null,
        prevSelector: prevEl ? buildUniqueSelector(prevEl, paginationElement) : null,
        pageNumberSelector: buildSharedSelector(pageNumberEls),
        loadMoreSelector: null,
        lastVisiblePage: maxVisible || null,
        paginationSelector: buildUniqueSelector(paginationElement, document.body),
        paginationElement: paginationElement,
        initialNextUrl: null,
      };
    }

    // NEXT_PREV_ONLY
    if (nextEl) {
      log.info("detect_type", { phase: "load", type: "NEXT_PREV_ONLY" });
      return {
        type: "NEXT_PREV_ONLY",
        nextSelector: buildUniqueSelector(nextEl, paginationElement),
        prevSelector: prevEl ? buildUniqueSelector(prevEl, paginationElement) : null,
        pageNumberSelector: null,
        loadMoreSelector: null,
        lastVisiblePage: null,
        paginationSelector: buildUniqueSelector(paginationElement, document.body),
        paginationElement: paginationElement,
        initialNextUrl: null,
      };
    }

    log.warn("detect_no_match", { phase: "load" });
    return null;
  }

  // --- State ---

  let _state           = "IDLE";
  let _cancelRequested = false;
  let _collectedPages  = [];
  let _seenHashes      = new Set();
  let _progressCb      = null;
  let _pageCb          = null;
  let _completeCb      = null;
  let _errorCb         = null;

  // --- Dedup helpers ---

  function uniqueClones(items) {
    return items.filter(function (el) {
      const h = hashItem(el);
      if (_seenHashes.has(h)) return false;
      _seenHashes.add(h);
      return true;
    }).map(function (el) { return el.cloneNode(true); });
  }

  // --- DOM mutation helpers ---

  function rebuildContainer(container, itemSelector) {
    safeQSA(container, itemSelector).forEach(function (el) { el.remove(); });
    const frag = document.createDocumentFragment();
    _collectedPages.forEach(function (page) {
      page.items.forEach(function (clone) { frag.appendChild(clone.cloneNode(true)); });
    });
    container.appendChild(frag);
  }

  function deduplicateContainer(container, itemSelector) {
    const seen = new Set();
    safeQSA(container, itemSelector).forEach(function (el) {
      const h = hashItem(el);
      if (seen.has(h)) { el.remove(); } else { seen.add(h); }
    });
  }

  // --- Callbacks ---

  function _fireProgress(currentPage, totalPages, totalItems) {
    if (_progressCb) _progressCb({ currentPage: currentPage, totalPages: totalPages, totalItems: totalItems });
  }

  async function _firePage(currentPage, pageItems, extra) {
    if (!_pageCb) return;
    await _pageCb({
      currentPage: currentPage,
      items: pageItems || [],
      totalItems: extra ? (extra.totalItems || 0) : 0,
      nextUrl: extra ? extra.nextUrl : null,
      seenHashes: Array.from(_seenHashes),
    });
  }

  // --- Click-based traversal helpers ---

  function waitForContentChange(container, itemSelector, timeoutMs) {
    return new Promise(function (resolve, reject) {
      const snapshot = safeQSA(container, itemSelector).map(function (el) {
        return el.textContent;
      }).join("|");

      const observer = new MutationObserver(function () {
        const current = safeQSA(container, itemSelector).map(function (el) {
          return el.textContent;
        }).join("|");
        if (current !== snapshot && current !== "") {
          observer.disconnect();
          clearTimeout(timer);
          setTimeout(resolve, 150);
        }
      });

      observer.observe(container, { childList: true, subtree: true, characterData: true });
      const timer = setTimeout(function () {
        observer.disconnect();
        reject(new Error("Timed out waiting for page content to change"));
      }, timeoutMs);
    });
  }

  function getNextTrigger(config, currentPage) {
    const pe = config.paginationElement || document;
    if (config.type === "LOAD_MORE") {
      return pe.querySelector(config.loadMoreSelector) ||
             document.querySelector(config.loadMoreSelector);
    }
    if (config.type === "NEXT_PREV_ONLY") {
      return pe.querySelector(config.nextSelector) ||
             document.querySelector(config.nextSelector);
    }
    if (config.type === "NUMBERED_PAGES") {
      const targetPage = currentPage + 1;
      const candidates = safeQSA(pe, config.pageNumberSelector || "");
      const exact = candidates.find(function (el) {
        return parseInt(getControlText(el)) === targetPage;
      });
      if (exact) return exact;
      if (config.nextSelector) {
        return pe.querySelector(config.nextSelector) ||
               document.querySelector(config.nextSelector);
      }
    }
    return null;
  }

  function hasMorePages(config, currentPage) {
    const pe = config.paginationElement || document;
    if (config.type === "LOAD_MORE") {
      const btn = pe.querySelector(config.loadMoreSelector) ||
                  document.querySelector(config.loadMoreSelector);
      return btn && !isDisabled(btn);
    }
    if (config.type === "NEXT_PREV_ONLY") {
      const next = pe.querySelector(config.nextSelector) ||
                   document.querySelector(config.nextSelector);
      return !!(next && !isDisabled(next));
    }
    if (config.type === "NUMBERED_PAGES") {
      if (config.nextSelector) {
        const next = pe.querySelector(config.nextSelector) ||
                     document.querySelector(config.nextSelector);
        if (next && !isDisabled(next)) return true;
      }
      if (config.pageNumberSelector) {
        const nums = safeQSA(pe, config.pageNumberSelector);
        return nums.some(function (el) { return parseInt(getControlText(el)) === currentPage + 1; });
      }
    }
    return false;
  }

  // --- Fetch-based next-URL resolution ---

  function findNextPageUrl(doc, config, baseHref) {
    if (config.type === "LINK_PAGES") {
      const nextLink = Array.from(doc.querySelectorAll("a[href]"))
        .find(function (el) { return isNextControl(el) && !isDisabledBasic(el); }) || null;
      if (!nextLink) return null;
      try { return new URL(nextLink.getAttribute("href"), baseHref).href; }
      catch (_) { return nextLink.getAttribute("href"); }
    }

    // FORM_PAGES
    let nextBtn = config.nextButtonId ? doc.getElementById(config.nextButtonId) : null;
    if (!nextBtn) {
      nextBtn = Array.from(
        doc.querySelectorAll("input[type='submit'], button[type='submit'], button")
      ).find(function (el) { return isNextControl(el) && !isDisabledBasic(el); }) || null;
    }
    if (!nextBtn || isDisabledBasic(nextBtn)) return null;
    const form = nextBtn.closest("form");
    if (!form) return null;
    return buildFormUrl(form, baseHref);
  }

  // --- Traversal: click-based (NUMBERED_PAGES / NEXT_PREV_ONLY / LOAD_MORE) ---

  async function _traverseClickBased(container, itemSelector, config, delayMs, skipRebuild) {
    const page1Items  = safeQSA(container, itemSelector);
    const page1Clones = uniqueClones(page1Items);
    if (page1Clones.length > 0) _collectedPages.push({ pageNum: 1, items: page1Clones });

    let currentPage = 1;
    let totalItems  = _collectedPages.reduce(function (s, p) { return s + p.items.length; }, 0);
    _fireProgress(currentPage, config.lastVisiblePage, totalItems);
    await _firePage(currentPage, page1Clones, { totalItems: totalItems, nextUrl: null });

    log.info("flatten_page1", { phase: "mutate", type: config.type, items: page1Items.length });

    while (currentPage < MAX_PAGES) {
      if (_cancelRequested) { _state = "CANCELLED"; return; }
      if (!hasMorePages(config, currentPage)) break;

      const trigger = getNextTrigger(config, currentPage);
      if (!trigger || isDisabled(trigger)) break;

      trigger.click();

      try {
        await waitForContentChange(container, itemSelector, LOAD_TIMEOUT_MS);
      } catch (e) {
        _state = "ERROR";
        if (_errorCb) _errorCb(e);
        return;
      }

      currentPage++;
      const newItems  = safeQSA(container, itemSelector);
      const newClones = uniqueClones(newItems);

      if (config.type === "LOAD_MORE") {
        if (newClones.length > 0) _collectedPages.push({ pageNum: currentPage, items: newClones });
      } else {
        _collectedPages.push({ pageNum: currentPage, items: newClones });
        if (!skipRebuild) rebuildContainer(container, itemSelector);
      }

      totalItems = _collectedPages.reduce(function (s, p) { return s + p.items.length; }, 0);
      _fireProgress(currentPage, config.lastVisiblePage, totalItems);
      await _firePage(currentPage, newClones, { totalItems: totalItems, nextUrl: null });
      log.debug("flatten_page", { phase: "mutate", page: currentPage, newItems: newClones.length, total: totalItems });

      if (_cancelRequested) { _state = "CANCELLED"; return; }
      await delay(delayMs);
    }

    if (config.type === "LOAD_MORE" && !skipRebuild) {
      deduplicateContainer(container, itemSelector);
    }

    totalItems = _collectedPages.reduce(function (s, p) { return s + p.items.length; }, 0);
    _state = "COMPLETE";
    log.info("flatten_complete", { phase: "mutate", pages: currentPage, items: totalItems });
    if (_completeCb) _completeCb({
      totalPages: currentPage, totalItems: totalItems, seenHashes: Array.from(_seenHashes),
    });
  }

  // --- Traversal: fetch-based (FORM_PAGES / LINK_PAGES) ---

  async function _traverseFetchBased(container, itemSelector, config, delayMs, containerSelector, skipRebuild) {
    let currentPage = 0;
    let nextUrl     = config.initialNextUrl;
    let baseHref    = window.location.href;
    let totalItems  = 0;
    let emptyStreak = 0;

    // Capture page 1 from live DOM
    const page1Items  = safeQSA(container, itemSelector);
    const page1Clones = uniqueClones(page1Items);
    if (page1Clones.length > 0) {
      _collectedPages.push({ pageNum: 1, items: page1Clones });
      totalItems = page1Clones.length;
    }
    currentPage = 1;
    _fireProgress(currentPage, config.lastVisiblePage, totalItems);
    await _firePage(currentPage, page1Clones, { totalItems: totalItems, nextUrl: nextUrl });
    log.info("flatten_page1", { phase: "mutate", type: config.type, items: page1Items.length, nextUrl: nextUrl });

    while (currentPage < MAX_PAGES && nextUrl) {
      if (_cancelRequested) { _state = "CANCELLED"; return; }

      log.debug("flatten_fetch", { phase: "mutate", page: currentPage + 1, url: nextUrl });

      let html, respUrl;
      try {
        const resp = await fetch(nextUrl, { credentials: "same-origin" });
        if (!resp.ok) throw new Error("HTTP " + resp.status + " fetching " + nextUrl);
        html    = await resp.text();
        respUrl = resp.url || nextUrl;
      } catch (e) {
        _state = "ERROR";
        log.error("flatten_fetch_error", { phase: "error", url: nextUrl, err: e.message });
        if (_errorCb) _errorCb(e);
        return;
      }

      baseHref = respUrl;
      const doc = new DOMParser().parseFromString(html, "text/html");

      // Locate item container in fetched page
      let fetchedContainer = containerSelector ? doc.querySelector(containerSelector) : null;
      if (!fetchedContainer) {
        const tag = container.tagName.toLowerCase();
        const cls = container.className && typeof container.className === "string"
          ? container.className.trim().split(/\s+/).filter(Boolean)[0]
          : null;
        const fallback = cls ? tag + "." + cls : tag;
        fetchedContainer = doc.querySelector(fallback);
        log.debug("flatten_container_fallback", { phase: "mutate", selector: fallback, found: !!fetchedContainer });
      }

      if (!fetchedContainer) {
        _state = "ERROR";
        const err = new Error("Item container not found in fetched page. Site may require auth or DOM changed.");
        log.error("flatten_container_missing", { phase: "error", url: nextUrl });
        if (_errorCb) _errorCb(err);
        return;
      }

      const newItems  = safeQSA(fetchedContainer, itemSelector);
      log.debug("flatten_page_items", { phase: "mutate", page: currentPage + 1, items: newItems.length });

      if (newItems.length === 0) {
        emptyStreak++;
        log.warn("flatten_empty_page", { phase: "mutate", page: currentPage + 1, streak: emptyStreak });
        if (emptyStreak >= 2) break;
      } else {
        emptyStreak = 0;
      }

      const newClones = uniqueClones(newItems);
      currentPage++;

      if (newClones.length > 0) {
        _collectedPages.push({ pageNum: currentPage, items: newClones });
        if (!skipRebuild) rebuildContainer(container, itemSelector);
      }

      totalItems += newClones.length;
      nextUrl = findNextPageUrl(doc, config, baseHref);
      _fireProgress(currentPage, config.lastVisiblePage, totalItems);
      await _firePage(currentPage, newClones, { totalItems: totalItems, nextUrl: nextUrl });

      if (_cancelRequested) { _state = "CANCELLED"; return; }
      await delay(delayMs);
    }

    _state = "COMPLETE";
    log.info("flatten_complete", { phase: "mutate", pages: currentPage, items: totalItems });
    if (_completeCb) _completeCb({
      totalPages: currentPage, totalItems: totalItems, seenHashes: Array.from(_seenHashes),
    });
  }

  // --- Public: startFlatten ---

  async function startFlatten(container, itemSelector, config, options) {
    if (_state === "TRAVERSING") return;
    _state           = "TRAVERSING";
    _cancelRequested = false;
    _collectedPages  = [];
    options          = options || {};

    const delayMs           = options.delayMs || DEFAULT_DELAY_MS;
    const containerSelector = options.containerSelector || null;
    const skipRebuild       = !!options.skipRebuild;
    const initialSeenHashes = Array.isArray(options.initialSeenHashes) ? options.initialSeenHashes : [];
    _seenHashes = new Set(initialSeenHashes.map(String));

    log.info("flatten_start", { phase: "mutate", type: config.type, delayMs: delayMs });

    try {
      if (config.type === "FORM_PAGES" || config.type === "LINK_PAGES") {
        await _traverseFetchBased(container, itemSelector, config, delayMs, containerSelector, skipRebuild);
      } else {
        await _traverseClickBased(container, itemSelector, config, delayMs, skipRebuild);
      }
    } catch (err) {
      _state = "ERROR";
      log.error("flatten_error", { phase: "error", err: err.message });
      if (_errorCb) _errorCb(err);
    }
  }

  // --- Public: control + query ---

  function cancel() { _cancelRequested = true; }

  function reset(container, itemSelector) {
    if (_collectedPages.length > 0) {
      const page1 = _collectedPages[0];
      safeQSA(container, itemSelector).forEach(function (el) { el.remove(); });
      const frag = document.createDocumentFragment();
      page1.items.forEach(function (clone) { frag.appendChild(clone.cloneNode(true)); });
      container.appendChild(frag);
    }
    _state           = "IDLE";
    _collectedPages  = [];
    _seenHashes      = new Set();
    _cancelRequested = false;
    log.info("reset", { phase: "mutate" });
  }

  function getState()    { return _state; }
  function getProgress() {
    return {
      currentPage: _collectedPages.length,
      totalPages:  null,
      totalItems:  _collectedPages.reduce(function (s, p) { return s + p.items.length; }, 0),
    };
  }

  function onProgress(cb) { _progressCb = cb; }
  function onPage(cb)     { _pageCb = cb; }
  function onComplete(cb) { _completeCb = cb; }
  function onError(cb)    { _errorCb = cb; }

  // Stub config for INFINITE_SCROLL — traversal is deferred
  function buildInfiniteScrollConfig(scrollContainer) {
    return {
      type: "INFINITE_SCROLL",
      scrollContainerSelector: scrollContainer ? buildUniqueSelector(scrollContainer, document.body) : null,
      nextSelector: null, prevSelector: null, pageNumberSelector: null,
      loadMoreSelector: null, lastVisiblePage: null, paginationElement: null, initialNextUrl: null,
    };
  }

  function refreshLastVisiblePage(config) {
    if (!config || !config.paginationSelector) return (config && config.lastVisiblePage) || null;
    const pagEl = document.querySelector(config.paginationSelector);
    if (!pagEl) return config.lastVisiblePage || null;
    const controls = Array.from(
      pagEl.querySelectorAll("a, button, [role='button'], [role='link'], input[type='submit']")
    ).filter(function (el) { return el.offsetParent !== null; });
    const pageNums = controls.filter(isPageNumber);
    if (pageNums.length === 0) return config.lastVisiblePage || null;
    const maxVisible = pageNums.reduce(function (max, el) {
      const n = parseInt(getControlText(el)); return n > max ? n : max;
    }, 0);
    return maxVisible || config.lastVisiblePage || null;
  }

  ns.paginator = {
    detect,
    startFlatten,
    cancel,
    reset,
    getState,
    getProgress,
    onProgress,
    onPage,
    onComplete,
    onError,
    buildFormUrl,
    buildInfiniteScrollConfig,
    refreshLastVisiblePage,
  };

  console.log("[Jaal] paginator loaded");

})(typeof globalThis !== "undefined" ? globalThis : this);
