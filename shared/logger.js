/**
 * shared/logger.js — structured JSONL logger, browser side.
 *
 * Emits one JSON.stringify line per call via console.log — consumable by
 * `python D:/Dev/cc-session-tools/parse-logs.py`.
 *
 * Schema per line:
 *   ts        ISO-8601 UTC timestamp
 *   project   always "jaal"
 *   lang      always "js"
 *   phase     init | load | mutate | teardown | error  (from data.phase; default "runtime")
 *   level     debug | info | warn | error
 *   component subsystem name, defaulted at construction time (e.g. "picker", "paginator")
 *   event     verb-noun key (e.g. "dom_query", "fetch_start")
 *   data      optional structured payload (anything not consumed above)
 *
 * Usage (must be loaded before any module that uses it):
 *   const log = window.Jaal.makeLogger('picker');
 *   log.info('dom_query',   { phase: 'init', selector: '#list', count: items.length });
 *   log.error('fetch_failed', { phase: 'mutate', url, err: e.message });
 */
(function (global) {
  "use strict";

  const ns = (global.Jaal = global.Jaal || {});

  function makeLogger(component) {
    const baseComponent = component || "main";

    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      project: "jaal",
      lang: "js",
      phase: "init",
      level: "info",
      component: baseComponent,
      event: "logger_ready",
    }));

    function emit(level, event, data) {
      const src = data || {};
      const { phase = "runtime", component: comp = baseComponent, ...rest } = src;
      const entry = {
        ts: new Date().toISOString(),
        project: "jaal",
        lang: "js",
        phase,
        level,
        component: comp,
        event,
      };
      if (Object.keys(rest).length > 0) entry.data = rest;
      console.log(JSON.stringify(entry));
      return entry;
    }

    return {
      debug: (event, data) => emit("debug", event, data),
      info:  (event, data) => emit("info",  event, data),
      warn:  (event, data) => emit("warn",  event, data),
      error: (event, data) => emit("error", event, data),
    };
  }

  ns.makeLogger = makeLogger;
  console.log("[Jaal] logger loaded");

})(typeof globalThis !== "undefined" ? globalThis : this);
