/**
 * extension/popup/popup.js — slim launcher popup.
 *
 * The full Saved patterns, Tools, and Compare views now live in the in-page
 * modal (Jaal.modal). This popup is a thin launcher that opens the modal and
 * shows the Compare fields matrix for cross-config analysis.
 */

const B = typeof browser !== "undefined" ? browser : chrome;
const SERVER_URL = "http://127.0.0.1:7773";

console.log("[Jaal popup] loaded");

// ─── Open Jaal panel button ──────────────────────────────────────────────

document.getElementById("open-modal-btn").addEventListener("click", function () {
  B.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs[0]) return;
    const url = tabs[0].url || "";
    if (url.startsWith("chrome://") || url.startsWith("about:") || url.startsWith("moz-extension://")) {
      alert("Cannot open Jaal on this page.\n\n" + url.split(":")[0] + ":// pages are not injectable.");
      return;
    }
    B.runtime.sendMessage({ type: "jaal-open-modal", tabId: tabs[0].id });
    window.close();
  });
});

// ─── Server health badge ─────────────────────────────────────────────────

console.log("[Jaal popup] checking server health…");
fetch(SERVER_URL + "/health")
  .then(function (r) { return r.json(); })
  .then(function (d) {
    const el = document.getElementById("status");
    el.className = "status online";
    el.innerHTML = '<span class="status-icon">✓</span><span>Server v' + (d.version || "?") + " online · " + (d.aiProvider || "") + '</span>';
    console.log("[Jaal popup] server online");
  })
  .catch(function (err) {
    const el = document.getElementById("status");
    el.className = "status offline";
    el.innerHTML = '<span class="status-icon">✗</span><span>Server offline</span>';
    console.log("[Jaal popup] server offline:", err.message);
  });

// ─── Tab switching (currently just Compare) ──────────────────────────────

document.querySelectorAll(".tab").forEach(function (tab) {
  tab.addEventListener("click", function () {
    const target = tab.getAttribute("data-tab");
    document.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("active", t === tab); });
    document.getElementById("panel-compare").style.display = target === "compare" ? "" : "none";
    if (target === "compare") renderCompareTab();
  });
});

// ─── Compare fields tab ──────────────────────────────────────────────────

function renderCompareTab() {
  const output = document.getElementById("compare-output");
  if (!output) return;

  B.storage.local.get("jaal_configs", function (result) {
    const configs = Array.isArray(result && result.jaal_configs) ? result.jaal_configs : [];
    const withCols = configs.filter(function (c) { return Array.isArray(c.columns) && c.columns.length > 0; });

    if (withCols.length === 0) {
      output.innerHTML = '<div class="empty">No saved patterns with columns yet.</div>';
      return;
    }

    const fieldSet = new Set();
    withCols.forEach(function (c) {
      c.columns.forEach(function (col) { if (col.name) fieldSet.add(col.name); });
    });
    const fields = Array.from(fieldSet);

    fields.sort(function (a, b) {
      const cA = withCols.filter(function (c) { return c.columns.some(function (col) { return col.name === a; }); }).length;
      const cB = withCols.filter(function (c) { return c.columns.some(function (col) { return col.name === b; }); }).length;
      return cB - cA;
    });

    const headerCells = withCols.map(function (c) {
      const label = (c.label || (c.domain + (c.pathPattern !== "/" ? c.pathPattern : ""))).substring(0, 20);
      return "<th class=\"compare-col\" title=\"" + escHtml(c.label || c.domain) + "\">" + escHtml(label) + "</th>";
    }).join("");

    const bodyRows = fields.map(function (field) {
      const coverage = withCols.filter(function (c) { return c.columns.some(function (col) { return col.name === field; }); }).length;
      const isCommon = coverage === withCols.length;
      const cells = withCols.map(function (c) {
        const col = c.columns.find(function (col) { return col.name === field; });
        return col
          ? "<td class=\"field-present\" title=\"" + escHtml(col.selector || "") + "\">✓</td>"
          : "<td class=\"field-absent\">—</td>";
      }).join("");
      return "<tr class=\"" + (isCommon ? "field-common" : "") + "\"><td class=\"field-name\">" + escHtml(field) + "</td>" + cells + "</tr>";
    }).join("");

    output.innerHTML =
      "<div class=\"compare-wrapper\">" +
      "<table class=\"compare-table\">" +
      "<thead><tr><th class=\"field-name\">Field</th>" + headerCells + "</tr></thead>" +
      "<tbody>" + bodyRows + "</tbody>" +
      "</table></div>" +
      "<p class=\"compare-hint\">✓ = present &nbsp;|&nbsp; bold = in all configs &nbsp;|&nbsp; hover ✓ for selector</p>";

    console.log("[Jaal popup] compare rendered", withCols.length, "configs,", fields.length, "fields");
  });
}

// Load compare tab on startup
renderCompareTab();

// ─── Helpers ─────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
