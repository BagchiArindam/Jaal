/**
 * shared/scrape-runs.js — client wrappers for /scrape-runs/* server endpoints.
 *
 * Exposes Jaal.scrapeRuns:
 *   start(siteKey, config, resumeRunId?)  → { runId, ... }
 *   checkpoint(runId, rows, checkpoint?)  → { ok, ... }
 *   complete(runId, summary?)             → { ok, ... }
 *   latest(siteKey, configHash?)          → { run }
 */
(function (global) {
  "use strict";

  const ns     = (global.Jaal = global.Jaal || {});
  const SERVER = "http://127.0.0.1:7773";

  async function _post(path, body) {
    const r = await fetch(SERVER + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error("scrapeRuns HTTP " + r.status + " POST " + path);
    return r.json();
  }

  async function _get(path) {
    const r = await fetch(SERVER + path);
    if (!r.ok) throw new Error("scrapeRuns HTTP " + r.status + " GET " + path);
    return r.json();
  }

  ns.scrapeRuns = {
    start: function (siteKey, config, resumeRunId) {
      console.log("[Jaal scrapeRuns] start", siteKey, "resumeRunId=" + (resumeRunId || "none"));
      return _post("/scrape-runs/start", {
        siteKey: siteKey,
        config: config,
        resumeRunId: resumeRunId || null,
      });
    },

    checkpoint: function (runId, rows, checkpoint) {
      console.log("[Jaal scrapeRuns] checkpoint runId=" + runId + " rows=" + rows.length);
      return _post("/scrape-runs/" + runId + "/checkpoint", {
        rows: rows,
        checkpoint: checkpoint || {},
      });
    },

    complete: function (runId, summary) {
      console.log("[Jaal scrapeRuns] complete runId=" + runId);
      return _post("/scrape-runs/" + runId + "/complete", {
        summary: summary || {},
      });
    },

    latest: function (siteKey, configHash) {
      let path = "/scrape-runs/latest?siteKey=" + encodeURIComponent(siteKey);
      if (configHash) path += "&configHash=" + encodeURIComponent(configHash);
      return _get(path);
    },
  };

  console.log("[Jaal scrapeRuns] loaded — server=" + SERVER);

})(typeof globalThis !== "undefined" ? globalThis : window);
