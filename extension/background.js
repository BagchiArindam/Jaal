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

// ─── Data migration (sort-sight → jaal) ──────────────────────────────────────

function migrateFromSortSight() {
  B.storage.local.get("jaal_migration_done", function (result) {
    if (result.jaal_migration_done) {
      console.log(LOG_TAG, "migration already completed");
      return;
    }

    B.storage.local.get("sortsight_finalized", function (result) {
      const oldData = result.sortsight_finalized || {};
      const numOldEntries = Object.keys(oldData).length;

      if (numOldEntries === 0) {
        B.storage.local.set({ jaal_migration_done: true });
        console.log(LOG_TAG, "no sort-sight data to migrate");
        return;
      }

      B.storage.local.get("jaal_finalized", function (result) {
        const newData = result.jaal_finalized || {};
        let numMigrated = 0;

        // Merge: copy any missing entries from old data to new
        for (const key in oldData) {
          if (!(key in newData)) {
            newData[key] = oldData[key];
            numMigrated++;
          }
        }

        B.storage.local.set({
          jaal_finalized: newData,
          jaal_migration_done: true
        });

        console.log(LOG_TAG, "migrated " + numMigrated + " entries from sort-sight to jaal");
      });
    });
  });
}

// ─── Data migration v2 (jaal_finalized object → jaal_configs array) ──────

function migrateToConfigsV2() {
  B.storage.local.get(["jaal_migration_v2_done", "jaal_finalized", "jaal_configs"], function (result) {
    if (result.jaal_migration_v2_done) {
      console.log(LOG_TAG, "v2 migration already completed");
      return;
    }

    const old = (result && result.jaal_finalized) || {};
    const configs = Array.isArray(result && result.jaal_configs) ? result.jaal_configs : [];
    let migrated = 0;

    for (const key in old) {
      const entry = old[key];
      if (!entry || !entry.containerSelector) continue;

      const slashIdx = key.indexOf("/");
      const domain = slashIdx >= 0 ? key.substring(0, slashIdx) : key;
      const path   = slashIdx >= 0 ? key.substring(slashIdx)    : "/";

      const dupe = configs.find(function (c) {
        return c.domain === domain
            && c.pathPattern === path
            && c.parentSelector === entry.containerSelector;
      });
      if (dupe) continue;

      configs.push({
        id: (typeof crypto !== "undefined" && crypto.randomUUID)
              ? crypto.randomUUID()
              : ("legacy-" + Date.now() + "-" + migrated),
        domain: domain,
        pathPattern: path,
        parentSelector: entry.containerSelector,
        label: domain + " — auto-migrated",
        layout: "1D",
        itemSelector: entry.itemSelector || "",
        columns: entry.columns || [],
        pagination: entry.pagination || null,
        searchInputSelector: null,
        searchInputValue: null,
        finalizedAt: new Date(0).toISOString(),
        createdAt: new Date(0).toISOString(),
      });
      migrated++;
    }

    B.storage.local.set({ jaal_configs: configs, jaal_migration_v2_done: true });
    console.log(LOG_TAG, "v2 migration: copied " + migrated + " entries from jaal_finalized → jaal_configs");
  });
}

// Run migrations on install/update
if (B.runtime && B.runtime.onInstalled) {
  B.runtime.onInstalled.addListener(migrateFromSortSight);
  B.runtime.onInstalled.addListener(migrateToConfigsV2);
}
migrateFromSortSight();
migrateToConfigsV2();

// ─── URL glob matcher (inlined from shared/url-glob.js) ──────────────────

const _globCache = Object.create(null);
function _globToRegex(glob) {
  let r = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { r += ".*"; i++; }
      else                     { r += "[^/]*"; }
    } else if ("\\^$.|?+()[]{}".indexOf(c) >= 0) {
      r += "\\" + c;
    } else {
      r += c;
    }
  }
  return new RegExp(r + "$");
}
function _globMatches(glob, path) {
  if (typeof glob !== "string" || typeof path !== "string") return false;
  if (glob === "" || glob === "*" || glob === "**") return true;
  if (!_globCache[glob]) {
    try { _globCache[glob] = _globToRegex(glob); }
    catch (_) { return false; }
  }
  return _globCache[glob].test(path);
}

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
  }
});

// ─── Picker / toolbar injection ─────────────────────────────────────────────

// All shared libs + picker + sorter + paginator + toolbar, then content-main as router.
const PICKER_FILES = [
  "shared/logger.js",
  "shared/html-extractor.js",
  "shared/sorter.js",
  "shared/paginator.js",
  "shared/field-helpers.js",
  "shared/scrape-runs.js",
  "content/picker.js",
  "ui/modal.js",
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
        if (activateMsg) _sendToTabWithRetry(tabId, { type: activateMsg });
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
        if (activateMsg) _sendToTabWithRetry(tabId, { type: activateMsg });
      })
      .catch(function (err) {
        console.error(LOG_TAG, "MV2 injection failed:", err);
      });
  } else {
    console.error(LOG_TAG, "no executeScript API available");
  }
}

function _sendToTabWithRetry(tabId, message, attempts, delayMs) {
  const tries = typeof attempts === "number" ? attempts : 5;
  const wait = typeof delayMs === "number" ? delayMs : 120;
  const retry = function (reason) {
    if (tries <= 1) {
      console.warn(LOG_TAG, "sendMessage failed:", message.type, "tab=", tabId, reason || "");
      return;
    }
    setTimeout(function () {
      _sendToTabWithRetry(tabId, message, tries - 1, wait);
    }, wait);
  };

  try {
    const maybePromise = B.tabs.sendMessage(tabId, message, function () {
      if (B.runtime && B.runtime.lastError) {
        retry(B.runtime.lastError.message);
      }
    });
    if (maybePromise && typeof maybePromise.then === "function") {
      maybePromise.catch(function (err) {
        retry(err && err.message ? err.message : String(err));
      });
    }
  } catch (err) {
    try {
      const promised = B.tabs.sendMessage(tabId, message);
      if (promised && typeof promised.then === "function") {
        promised.catch(function (sendErr) {
          retry(sendErr && sendErr.message ? sendErr.message : String(sendErr));
        });
      }
    } catch (sendErr) {
      retry(sendErr && sendErr.message ? sendErr.message : String(sendErr));
    }
  }
}

// ─── Auto-inject: match jaal_configs on tab load ────────────────────────

B.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (changeInfo.status !== "complete" || !tab.url || tab.url.startsWith("chrome")) return;

  let url;
  try { url = new URL(tab.url); } catch (_) { return; }

  B.storage.local.get("jaal_configs", function (result) {
    const configs = Array.isArray(result && result.jaal_configs) ? result.jaal_configs : [];
    if (configs.length === 0) return;

    const path = url.pathname.replace(/\/+$/, "") || "/";
    const matches = configs.filter(function (c) {
      if (!c || !c.domain || !c.parentSelector) return false;
      if (c.domain !== url.hostname) return false;
      return _globMatches(c.pathPattern || "*", path)
          || _globMatches(c.pathPattern || "*", url.pathname);
    });
    if (matches.length === 0) return;

    console.log(LOG_TAG, "auto-inject for", tab.url, "—", matches.length, "config(s) matched");
    _injectFiles(tabId, PICKER_FILES, null);
    _sendToTabWithRetry(tabId, { type: "jaal-auto-activate-multi", configs: matches }, 8, 150);
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

  if (msg.type === "jaal-open-modal") {
    const tabId = (typeof msg.tabId === "number") ? msg.tabId
                : (sender && sender.tab && sender.tab.id);
    if (typeof tabId !== "number") {
      console.warn(LOG_TAG, "jaal-open-modal: no tabId resolved");
      return false;
    }
    // Inject picker files, then open modal and re-send matching configs so
    // toolbars are (re-)spawned when the user opens the panel from popup.
    _injectFiles(tabId, PICKER_FILES, null);
    B.tabs.get(tabId, function (tab) {
      if (!tab || !tab.url) {
        _sendToTabWithRetry(tabId, { type: "jaal-open-modal" });
        return;
      }
      let url;
      try { url = new URL(tab.url); } catch (_) {
        _sendToTabWithRetry(tabId, { type: "jaal-open-modal" });
        return;
      }
      B.storage.local.get("jaal_configs", function (result) {
        const configs = Array.isArray(result && result.jaal_configs) ? result.jaal_configs : [];
        const path = url.pathname.replace(/\/+$/, "") || "/";
        const matches = configs.filter(function (c) {
          if (!c || !c.domain || !c.parentSelector) return false;
          if (c.domain !== url.hostname) return false;
          return _globMatches(c.pathPattern || "*", path)
              || _globMatches(c.pathPattern || "*", url.pathname);
        });
        if (matches.length > 0) {
          // Re-spawn matching toolbar configs + show modal
          _sendToTabWithRetry(tabId, { type: "jaal-auto-activate-multi", configs: matches }, 8, 150);
        } else {
          // No matching configs — just open the modal (user can use Patterns tab)
          _sendToTabWithRetry(tabId, { type: "jaal-open-modal" });
        }
      });
    });
    return false;
  }

  if (msg.type === "jaal-inject-skeleton") {
    // Popup messages carry tabId in payload (sender.tab is undefined for popups);
    // content-script messages set sender.tab.
    const tabId = (typeof msg.tabId === "number") ? msg.tabId
                : (sender && sender.tab && sender.tab.id);
    if (typeof tabId === "number") {
      injectSkeletonInspector(tabId);
    } else {
      console.warn(LOG_TAG, "jaal-inject-skeleton: no tabId resolved");
    }
    return false;
  }

  if (msg.type === "jaal-inject-net-recorder") {
    const tabId = (typeof msg.tabId === "number") ? msg.tabId
                : (sender && sender.tab && sender.tab.id);
    if (typeof tabId === "number") {
      injectNetRecorder(tabId);
    } else {
      console.warn(LOG_TAG, "jaal-inject-net-recorder: no tabId resolved");
    }
    return false;
  }

  return false;
});

console.log(LOG_TAG, "background ready — server=" + SERVER_URL);
