/**
 * Jaal background (MV3 service worker / MV2 background script).
 *
 * Context menus:
 *   jaal-inspect-skeleton  → injects skeleton inspector overlay
 *   jaal-net-recorder      → injects net recorder overlay
 *                            (net-hooks are installed declaratively at document-start;
 *                             this menu item just surfaces the UI panel)
 *
 * Message relay:
 *   jaal-health → GET /health, response forwarded to sender.
 */
/* global browser, chrome */

const B = typeof browser !== "undefined" ? browser : chrome;
const SERVER_URL = "http://127.0.0.1:7773";
const LOG_TAG = "[Jaal bg]";

// ─── Context menus ──────────────────────────────────────────────────────────

function registerContextMenus() {
  const create = function (def) {
    try {
      B.contextMenus.create(def, function () {
        if (B.runtime.lastError) {
          // Ignore "duplicate id" on service-worker restart / re-install
        }
      });
    } catch (_) {}
  };

  create({
    id: "jaal-pick",
    title: "Jaal: Pick list",
    contexts: ["page", "frame", "link", "image", "selection"],
  });
  create({
    id: "jaal-inspect-skeleton",
    title: "Jaal: Inspect skeleton",
    contexts: ["page", "frame", "link", "image", "selection"],
  });
  create({
    id: "jaal-net-recorder",
    title: "Jaal: Net recorder",
    contexts: ["page", "frame", "link", "image", "selection"],
  });

  console.log(LOG_TAG, "context menus registered");
}

// MV3: rebuild on install/update. MV2: run at load.
if (B.runtime && B.runtime.onInstalled) {
  B.runtime.onInstalled.addListener(registerContextMenus);
}
registerContextMenus();

B.contextMenus.onClicked.addListener(function (info, tab) {
  if (!tab || typeof tab.id !== "number") return;
  if (info.menuItemId === "jaal-pick") {
    injectPicker(tab.id);
  } else if (info.menuItemId === "jaal-inspect-skeleton") {
    injectSkeletonInspector(tab.id);
  } else if (info.menuItemId === "jaal-net-recorder") {
    injectNetRecorder(tab.id);
  }
});

// ─── Picker / toolbar injection ─────────────────────────────────────────────

// All shared libs + picker + sorter + paginator + toolbar, then content-main as router.
const PICKER_FILES = [
  "shared/logger.js",
  "shared/html-extractor.js",
  "shared/sorter.js",
  "shared/paginator.js",
  "content/picker.js",
  "ui/toolbar.js",
  "content/content-main.js",
];

function injectPicker(tabId) {
  console.log(LOG_TAG, "injecting picker", tabId);
  _injectFiles(tabId, PICKER_FILES, "jaal-activate-picker");
}

// ─── Skeleton inspector injection ───────────────────────────────────────────

// Paths relative to extension root. shared/ is the dev-sync copy of repo/shared/.
const SKELETON_FILES = [
  "shared/logger.js",
  "shared/skeleton.js",
  "ui/skeleton-overlay.js",
  "content/content-main.js",
];

function injectSkeletonInspector(tabId) {
  console.log(LOG_TAG, "injecting skeleton inspector", tabId);
  _injectFiles(tabId, SKELETON_FILES, "jaal-activate-skeleton");
}

// ─── Net recorder injection ──────────────────────────────────────────────────
//
// net-recorder-main.js runs in MAIN world via declarative content_scripts
// (MV3) or net-recorder-injector.js <script> tag (MV2), both at document_start.
// We only need to inject the UI overlay (isolated world).

const NET_RECORDER_UI_FILES = [
  "shared/logger.js",
  "shared/net-replayer.js",
  "ui/net-recorder-overlay.js",
  "content/content-main.js",
];

function injectNetRecorder(tabId) {
  console.log(LOG_TAG, "injecting net recorder UI", tabId);
  _injectFiles(tabId, NET_RECORDER_UI_FILES, "jaal-activate-net-recorder");
}

// ─── Shared injection helper ─────────────────────────────────────────────────

function _injectFiles(tabId, files, activateMsg) {
  if (B.scripting && B.scripting.executeScript) {
    // MV3 path — isolated world (default; no `world` key means "ISOLATED")
    B.scripting
      .executeScript({ target: { tabId: tabId }, files: files })
      .then(function () {
        if (activateMsg) B.tabs.sendMessage(tabId, { type: activateMsg });
      })
      .catch(function (err) {
        console.error(LOG_TAG, "MV3 injection failed:", err);
      });
  } else if (B.tabs && B.tabs.executeScript) {
    // MV2 path — serialize injections
    const chain = files.reduce(function (p, f) {
      return p.then(function () {
        return B.tabs.executeScript(tabId, { file: f });
      });
    }, Promise.resolve());
    chain
      .then(function () {
        if (activateMsg) B.tabs.sendMessage(tabId, { type: activateMsg });
      })
      .catch(function (err) {
        console.error(LOG_TAG, "MV2 injection failed:", err);
      });
  } else {
    console.error(LOG_TAG, "no executeScript API available");
  }
}

// ─── Auto-inject: check finalized configs on tab load ───────────────────────

B.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (changeInfo.status !== "complete" || !tab.url || tab.url.startsWith("chrome")) return;

  B.storage.local.get("jaal_finalized", function (result) {
    const store = (result && result["jaal_finalized"]) || {};
    const keys  = Object.keys(store);
    if (keys.length === 0) return;

    let url;
    try { url = new URL(tab.url); } catch (_) { return; }
    const tabKey = url.hostname + url.pathname.replace(/\/+$/, "");

    // Exact key match first, then check stored urlPattern prefix
    let config = store[tabKey];
    if (!config) {
      for (const k of keys) {
        const c = store[k];
        if (c.urlPattern && tab.url.startsWith(c.urlPattern.split("?")[0])) {
          config = c;
          break;
        }
      }
    }
    if (!config) return;

    console.log(LOG_TAG, "auto-inject for", tab.url);
    _injectFiles(tabId, PICKER_FILES, null);
    // After inject, send auto-activate with the saved config
    setTimeout(function () {
      B.tabs.sendMessage(tabId, { type: "jaal-auto-activate", config: config });
    }, 500);
  });
});

// ─── Server message relay ──────────────────────────────────────────────────

B.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== "string") return false;

  if (msg.type === "jaal-health") {
    fetch(SERVER_URL + "/health")
      .then(function (r) { return r.json(); })
      .then(function (data) { sendResponse({ ok: true, data: data }); })
      .catch(function (err) { sendResponse({ ok: false, error: String(err) }); });
    return true;
  }

  if (msg.type === "jaal-analyze") {
    fetch(SERVER_URL + "/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg.payload || {}),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) { sendResponse({ ok: true, data: data }); })
      .catch(function (err) { sendResponse({ ok: false, error: String(err) }); });
    return true;
  }

  if (msg.type === "jaal-start-pick") {
    // Relay from a content script that can't call startPicking directly
    // (e.g. cross-context scenario). Bounce back to the sending tab.
    if (sender && sender.tab && sender.tab.id) {
      B.tabs.sendMessage(sender.tab.id, { type: "jaal-activate-picker" });
    }
    return false;
  }

  return false;
});

console.log(LOG_TAG, "background ready — server=" + SERVER_URL);
