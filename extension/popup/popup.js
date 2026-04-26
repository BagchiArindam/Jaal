/**
 * extension/popup/popup.js — browser-action popup entry point.
 *
 * Provides quick-access buttons for Skeleton inspector and Net recorder,
 * plus server health status.
 */
const B = typeof browser !== "undefined" ? browser : chrome;

console.log("[Jaal popup] loaded");

// Skeleton inspector button
document.getElementById("skeleton-btn").addEventListener("click", () => {
  console.log("[Jaal popup] skeleton button clicked");
  B.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      // Popup messages have sender.tab === undefined in the bg handler, so we
      // must pass tabId explicitly.
      B.runtime.sendMessage({ type: "jaal-inject-skeleton", tabId: tabs[0].id });
      window.close();
    }
  });
});

// Net recorder button
document.getElementById("net-recorder-btn").addEventListener("click", () => {
  console.log("[Jaal popup] net recorder button clicked");
  B.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      B.runtime.sendMessage({ type: "jaal-inject-net-recorder", tabId: tabs[0].id });
      window.close();
    }
  });
});

// Check server health
console.log("[Jaal popup] checking server health...");
fetch("http://127.0.0.1:7773/health", { timeout: 2000 })
  .then(r => r.json())
  .then(() => {
    const status = document.getElementById("status");
    status.className = "status online";
    status.innerHTML = '<span class="status-icon">✓</span><span>Server: Online</span>';
    console.log("[Jaal popup] server online");
  })
  .catch((err) => {
    const status = document.getElementById("status");
    status.className = "status offline";
    status.innerHTML = '<span class="status-icon">✗</span><span>Server: Offline</span>';
    console.log("[Jaal popup] server offline:", err.message);
  });
