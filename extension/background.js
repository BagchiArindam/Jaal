/**
 * Jaal background (MV3 service worker / MV2 background script).
 *
 * Current surface (C-5 skeleton):
 *   - Context menu: "Jaal: Inspect skeleton"
 *   - Injects shared/logger.js + shared/skeleton.js + ui/skeleton-overlay.js
 *     + content/content-main.js, then dispatches {type: "jaal-activate-skeleton"}.
 *   - Message relay for /health (used by future popup / debugging).
 *
 * Remaining endpoints (/analyze, /analyze-pagination, /cache/*, /scrape-runs/*,
 * /discover-patterns) are wired in as the picker, toolbar, and discovery UI
 * land in later phases.
 */
/* global browser, chrome */

const B = typeof browser !== "undefined" ? browser : chrome;
const SERVER_URL = "http://127.0.0.1:7773";
const LOG_TAG = "[Jaal bg]";

// ─── Context menu ───────────────────────────────────────────────────────────

function registerContextMenus() {
  // MV3 service workers can run before onInstalled; guard against duplicate id.
  const create = (def) => {
    try {
      B.contextMenus.create(def, () => {
        if (B.runtime.lastError) {
          // Ignore "duplicate id" on re-install / worker restart
        }
      });
    } catch (_) {}
  };
  create({
    id: "jaal-inspect-skeleton",
    title: "Jaal: Inspect skeleton",
    contexts: ["page", "frame", "link", "image", "selection"],
  });
  console.log(LOG_TAG, "context menu registered");
}

// MV3: rebuild on install/update. MV2: run at load.
if (B.runtime && B.runtime.onInstalled) {
  B.runtime.onInstalled.addListener(registerContextMenus);
}
registerContextMenus();

B.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || typeof tab.id !== "number") return;
  if (info.menuItemId === "jaal-inspect-skeleton") {
    injectSkeletonInspector(tab.id);
  }
});

// ─── Script injection ───────────────────────────────────────────────────────

// Paths are resolved relative to the extension root (where manifest.json lives).
// `shared/` here is the synced copy that build/dev-sync.mjs (and eventually
// build/build-extension.mjs) copies in from the repo's top-level shared/.
const SKELETON_FILES = [
  "shared/logger.js",
  "shared/skeleton.js",
  "ui/skeleton-overlay.js",
  "content/content-main.js",
];

function injectSkeletonInspector(tabId) {
  console.log(LOG_TAG, "injecting skeleton inspector into tab", tabId);
  if (B.scripting && B.scripting.executeScript) {
    // MV3 path
    B.scripting
      .executeScript({ target: { tabId }, files: SKELETON_FILES })
      .then(() => {
        B.tabs.sendMessage(tabId, { type: "jaal-activate-skeleton" });
      })
      .catch((err) => console.error(LOG_TAG, "MV3 injection failed:", err));
  } else if (B.tabs && B.tabs.executeScript) {
    // MV2 path — serialize injections
    const chain = SKELETON_FILES.reduce(
      (p, f) => p.then(() => B.tabs.executeScript(tabId, { file: f })),
      Promise.resolve()
    );
    chain
      .then(() => B.tabs.sendMessage(tabId, { type: "jaal-activate-skeleton" }))
      .catch((err) => console.error(LOG_TAG, "MV2 injection failed:", err));
  } else {
    console.error(LOG_TAG, "no executeScript API available");
  }
}

// ─── Server message relay ──────────────────────────────────────────────────

B.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;

  if (msg.type === "jaal-health") {
    fetch(`${SERVER_URL}/health`)
      .then((r) => r.json())
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async response
  }

  // Future relays will land here in C-5b onward.
  return false;
});

console.log(LOG_TAG, "background ready — server=" + SERVER_URL);
