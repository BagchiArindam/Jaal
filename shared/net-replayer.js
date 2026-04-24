/**
 * shared/net-replayer.js — standalone replayer script generator.
 *
 * Takes an array of captured call objects (from net-hooks.js) and produces
 * a self-contained JS string that, when pasted in a browser console or run
 * in Node.js (with node-fetch), replays each fetch/XHR call and logs results.
 *
 * WebSocket calls are omitted — they require an active server connection and
 * cannot be replayed statelessly.
 *
 * Body fidelity note: net-hooks.js truncates bodies to 500 chars. Truncated
 * entries are flagged with a // TRUNCATED comment in the emitted script.
 *
 * Usage:
 *   const script = window.Jaal.NetReplayer.generateScript(calls, { label: "my capture" });
 *   // script is a JS string; download as .js or paste in console.
 */
(function (global) {
  "use strict";

  const ns = (global.Jaal = global.Jaal || {});

  function generateScript(calls, opts) {
    opts = opts || {};
    const label = opts.label || "Jaal replayer";
    const replayable = (calls || []).filter(function (c) {
      return c.type === "fetch" || c.type === "xhr";
    });

    const ts = new Date().toISOString();
    const out = [];

    out.push("// " + label);
    out.push("// Generated: " + ts);
    out.push("// Source:    " + (typeof window !== "undefined" ? window.location.href : "(unknown)"));
    out.push("// Calls:     " + replayable.length + " (WebSocket calls omitted — not replayable)");
    out.push("// NOTE: Request bodies > 500 chars are truncated at capture time.");
    out.push("// Run: paste in browser DevTools console, or `node this-file.js` with node-fetch.");
    out.push("");
    out.push("(async function replayAll() {");
    out.push("  const results = [];");
    out.push("");

    replayable.forEach(function (call, i) {
      const idx = i + 1;
      const isTruncated = typeof call.bodyPreview === "string" && call.bodyPreview.endsWith("…");
      const hasBody = call.bodyPreview && call.bodyPreview !== "" &&
        call.method !== "GET" && call.method !== "HEAD";
      const hasHeaders = call.headers && Object.keys(call.headers).length > 0;

      out.push("  // ── Call " + idx + " ── " + call.type.toUpperCase() + " " + call.method + " " + call.url);
      if (isTruncated) {
        out.push("  // WARNING: request body was truncated at capture time — replace placeholder before running");
      }

      out.push("  try {");
      out.push("    const _r" + i + " = await fetch(");
      out.push("      " + JSON.stringify(call.url) + ",");
      out.push("      {");
      out.push("        method: " + JSON.stringify(call.method) + ",");
      if (hasHeaders) {
        out.push("        headers: " + JSON.stringify(call.headers, null, 2).replace(/\n/g, "\n        ") + ",");
      }
      if (hasBody) {
        if (isTruncated) {
          out.push("        // body: /* TRUNCATED — replace with full body */");
        } else {
          out.push("        body: " + JSON.stringify(call.bodyPreview) + ",");
        }
      }
      out.push("      }");
      out.push("    );");
      out.push("    const _text" + i + " = await _r" + i + ".text();");
      out.push("    const _res" + i + " = { status: _r" + i + ".status, url: " + JSON.stringify(call.url) + ", body: _text" + i + ".substring(0, 500) };");
      out.push("    console.log(\"[replay " + idx + "]\", _res" + i + ");");
      out.push("    results.push(_res" + i + ");");
      out.push("  } catch (_e" + i + ") {");
      out.push("    console.error(\"[replay " + idx + " failed]\", _e" + i + ".message);");
      out.push("    results.push({ error: _e" + i + ".message, url: " + JSON.stringify(call.url) + " });");
      out.push("  }");
      out.push("");
    });

    out.push("  console.log(\"[jaal replay done]\", results);");
    out.push("  return results;");
    out.push("})();");

    return out.join("\n");
  }

  ns.NetReplayer = { generateScript: generateScript };
  console.log("[Jaal] net-replayer loaded");

})(typeof globalThis !== "undefined" ? globalThis : this);
