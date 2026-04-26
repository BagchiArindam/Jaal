/**
 * extension/popup/popup.js — browser-action popup with two tabs:
 *   1. Saved patterns — list / edit / delete jaal_configs entries
 *   2. Tools         — Skeleton + Net recorder buttons + server health
 *
 * Saved-pattern actions (Edit / Delete / Export / Import) operate directly
 * on chrome.storage.local["jaal_configs"]. Sitemap "Suggest…" pulls from
 * the local Jaal server's /discover-patterns endpoint.
 */

const B = typeof browser !== "undefined" ? browser : chrome;
const SERVER_URL = "http://127.0.0.1:7773";

console.log("[Jaal popup] loaded");

// ─── Tab switching ───────────────────────────────────────────────────────

document.querySelectorAll(".tab").forEach(function (tab) {
  tab.addEventListener("click", function () {
    const target = tab.getAttribute("data-tab");
    document.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("active", t === tab); });
    document.getElementById("panel-patterns").style.display = target === "patterns" ? "" : "none";
    document.getElementById("panel-tools").style.display    = target === "tools"    ? "" : "none";
  });
});

// ─── Saved patterns: load + render ───────────────────────────────────────

let _configs = [];

function loadAndRender() {
  B.storage.local.get("jaal_configs", function (result) {
    _configs = Array.isArray(result && result.jaal_configs) ? result.jaal_configs : [];
    renderPatterns();
  });
}

function renderPatterns() {
  const list = document.getElementById("patterns-list");
  list.innerHTML = "";
  if (_configs.length === 0) {
    list.innerHTML = '<div class="empty">No saved patterns yet.<br>Pick a list on a page and click Finalize.</div>';
    return;
  }
  // Group by domain
  const byDomain = new Map();
  for (const c of _configs) {
    const d = c.domain || "(unknown)";
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(c);
  }
  // Sort domains alphabetically
  const domains = Array.from(byDomain.keys()).sort();
  for (const domain of domains) {
    const group = document.createElement("div");
    group.className = "domain-group";
    const header = document.createElement("div");
    header.className = "domain-header";
    header.innerHTML = '<span>' + escHtml(domain) + '</span> <span class="domain-count">(' + byDomain.get(domain).length + ')</span>';
    group.appendChild(header);
    for (const cfg of byDomain.get(domain)) {
      group.appendChild(renderConfigRow(cfg));
    }
    list.appendChild(group);
  }
}

function renderConfigRow(cfg) {
  const row = document.createElement("div");
  row.className = "config-row";
  row.dataset.configId = cfg.id;
  row.innerHTML =
    '<div class="config-label">' + escHtml(cfg.label || cfg.domain) + '</div>' +
    '<div class="config-meta">' +
      '<span class="key">Path</span><span class="val">' + escHtml(cfg.pathPattern || "/") + '</span>' +
      '<span class="key">Parent</span><span class="val">' + escHtml(cfg.parentSelector || "") + '</span>' +
      '<span class="key">Cols</span><span class="val">' + (Array.isArray(cfg.columns) ? cfg.columns.length : 0) +
        (cfg.searchInputSelector ? ' · 🔍 search-bar bound' : '') + '</span>' +
    '</div>' +
    '<div class="config-actions">' +
      '<button class="btn jaal-edit">Edit</button>' +
      '<button class="btn btn-danger jaal-delete">Delete</button>' +
    '</div>';

  row.querySelector(".jaal-edit").addEventListener("click", function () {
    row.replaceWith(renderEditForm(cfg));
  });
  row.querySelector(".jaal-delete").addEventListener("click", function () {
    if (!confirm("Delete pattern '" + (cfg.label || cfg.domain) + "'?")) return;
    _configs = _configs.filter(function (c) { return c.id !== cfg.id; });
    saveAndRender();
  });
  return row;
}

function renderEditForm(cfg) {
  const form = document.createElement("div");
  form.className = "config-edit";
  form.dataset.configId = cfg.id;
  form.innerHTML =
    '<div class="edit-field"><label>Label</label><input class="ed-label" value="' + escAttr(cfg.label || "") + '" /></div>' +
    '<div class="edit-field"><label>Domain</label><input class="ed-domain" value="' + escAttr(cfg.domain || "") + '" /></div>' +
    '<div class="edit-field"><label>Path</label><input class="ed-path" value="' + escAttr(cfg.pathPattern || "") + '" placeholder="/products/* or /search/**" /></div>' +
    '<div class="edit-field"><label>Parent</label><input class="ed-parent" value="' + escAttr(cfg.parentSelector || "") + '" /></div>' +
    '<div class="edit-field"><label>Search sel</label><input class="ed-search" value="' + escAttr(cfg.searchInputSelector || "") + '" placeholder="(none)" /></div>' +
    '<div class="edit-field"><label>Search val</label><input class="ed-search-val" value="' + escAttr(cfg.searchInputValue || "") + '" placeholder="(none)" /></div>' +
    '<div class="config-actions">' +
      '<button class="btn jaal-cancel">Cancel</button>' +
      '<button class="btn btn-primary jaal-save">Save</button>' +
    '</div>';

  form.querySelector(".jaal-cancel").addEventListener("click", function () {
    form.replaceWith(renderConfigRow(cfg));
  });
  form.querySelector(".jaal-save").addEventListener("click", function () {
    const idx = _configs.findIndex(function (c) { return c.id === cfg.id; });
    if (idx < 0) return;
    _configs[idx] = Object.assign({}, _configs[idx], {
      label:               form.querySelector(".ed-label").value.trim() || cfg.label,
      domain:              form.querySelector(".ed-domain").value.trim() || cfg.domain,
      pathPattern:         form.querySelector(".ed-path").value.trim() || "/",
      parentSelector:      form.querySelector(".ed-parent").value.trim() || cfg.parentSelector,
      searchInputSelector: form.querySelector(".ed-search").value.trim() || null,
      searchInputValue:    form.querySelector(".ed-search-val").value || null,
    });
    saveAndRender();
  });

  return form;
}

function saveAndRender() {
  B.storage.local.set({ jaal_configs: _configs }, function () {
    renderPatterns();
  });
}

// ─── Export / Import ────────────────────────────────────────────────────

document.getElementById("export-btn").addEventListener("click", function () {
  const payload = {
    exported: new Date().toISOString(),
    schemaVersion: 2,
    configs: _configs,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "jaal-configs-" + Date.now() + ".json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 500);
  console.log("[Jaal popup] exported", _configs.length, "configs");
});

document.getElementById("import-btn").addEventListener("click", function () {
  document.getElementById("import-file").click();
});

document.getElementById("import-file").addEventListener("change", function (e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (ev) {
    try {
      const data = JSON.parse(ev.target.result);
      const configs = Array.isArray(data && data.configs) ? data.configs : null;
      if (!configs) throw new Error("Missing configs[] array");
      const choice = confirm(
        "Import " + configs.length + " configs?\n\n" +
        "OK = MERGE (skip duplicates by composite key)\n" +
        "Cancel = REPLACE (overwrite existing)"
      );
      if (choice) {
        // merge
        for (const c of configs) {
          const dupe = _configs.find(function (e) {
            return e.domain === c.domain
                && e.pathPattern === c.pathPattern
                && e.parentSelector === c.parentSelector;
          });
          if (!dupe) _configs.push(c);
        }
      } else {
        _configs = configs;
      }
      saveAndRender();
      console.log("[Jaal popup] imported", configs.length, "configs");
    } catch (err) {
      alert("Import failed: " + err.message);
    }
    e.target.value = "";
  };
  reader.readAsText(file);
});

// ─── Sitemap suggestions ────────────────────────────────────────────────

document.getElementById("suggest-btn").addEventListener("click", function () {
  B.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs[0] || !tabs[0].url) return;
    let domain;
    try { domain = new URL(tabs[0].url).hostname; }
    catch (_) { return; }
    const out = document.getElementById("suggest-result");
    out.style.display = "";
    out.innerHTML = '<div class="suggest-title">Fetching sitemap for ' + escHtml(domain) + '…</div>';
    fetch(SERVER_URL + "/discover-patterns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: domain }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        const raw = (data && Array.isArray(data.patterns)) ? data.patterns : [];
        // Server returns either {pattern, example, count, notes} objects or plain strings.
        const patterns = raw.map(function (p) {
          if (typeof p === "string") return { text: p, example: "", count: null };
          return {
            text:    p.pattern || p.text || "",
            example: p.example || "",
            count:   (typeof p.count === "number") ? p.count : null,
          };
        }).filter(function (p) { return p.text; });

        if (patterns.length === 0) {
          out.innerHTML = '<div class="suggest-title">No patterns suggested for ' + escHtml(domain) + '.</div>';
          return;
        }
        out.innerHTML = '<div class="suggest-title">Sitemap patterns for ' + escHtml(domain) + ':</div>';
        for (const p of patterns) {
          const div = document.createElement("div");
          div.className = "suggest-pat";
          const meta = (p.count != null ? " (" + p.count + ")" : "") +
                       (p.example ? " · e.g. " + p.example.substring(0, 40) : "");
          div.innerHTML = '<span class="suggest-pat-text">' + escHtml(p.text) +
                          '<span style="color:#9ca3af;font-size:10px">' + escHtml(meta) + '</span></span>' +
                          '<button class="btn btn-sm">Copy</button>';
          div.querySelector("button").addEventListener("click", function () {
            navigator.clipboard.writeText(p.text).then(function () {
              div.querySelector("button").textContent = "Copied";
              setTimeout(function () { div.querySelector("button").textContent = "Copy"; }, 1500);
            });
          });
          out.appendChild(div);
        }
      })
      .catch(function (err) {
        out.innerHTML = '<div class="suggest-title">Server unreachable: ' + escHtml(err.message) + '</div>';
      });
  });
});

// ─── Tools panel: Skeleton + Net recorder buttons + server status ───────

document.getElementById("skeleton-btn").addEventListener("click", function () {
  console.log("[Jaal popup] skeleton button clicked");
  B.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs[0]) {
      B.runtime.sendMessage({ type: "jaal-inject-skeleton", tabId: tabs[0].id });
      window.close();
    }
  });
});

document.getElementById("net-recorder-btn").addEventListener("click", function () {
  console.log("[Jaal popup] net recorder button clicked");
  B.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs[0]) {
      B.runtime.sendMessage({ type: "jaal-inject-net-recorder", tabId: tabs[0].id });
      window.close();
    }
  });
});

console.log("[Jaal popup] checking server health...");
fetch(SERVER_URL + "/health")
  .then(function (r) { return r.json(); })
  .then(function () {
    const status = document.getElementById("status");
    status.className = "status online";
    status.innerHTML = '<span class="status-icon">✓</span><span>Server: Online</span>';
    console.log("[Jaal popup] server online");
  })
  .catch(function (err) {
    const status = document.getElementById("status");
    status.className = "status offline";
    status.innerHTML = '<span class="status-icon">✗</span><span>Server: Offline</span>';
    console.log("[Jaal popup] server offline:", err.message);
  });

// ─── Helpers ────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escAttr(s) {
  return escHtml(s);
}

// Initial load
loadAndRender();
