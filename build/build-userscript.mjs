#!/usr/bin/env node
/**
 * build/build-userscript.mjs — produce userscript/jaal.user.js
 *
 * Concatenation order:
 *   1. Tampermonkey header (extracted from the top of jaal-source.js)
 *   2. shared/logger.js
 *   3. shared/html-extractor.js
 *   4. shared/net-hooks.js
 *   5. shared/skeleton.js
 *   6. shared/net-replayer.js
 *   7. userscript/jaal-source.js (minus its header comment)
 *
 * Usage:
 *   node build/build-userscript.mjs
 *   npm run build:userscript
 */
import fs   from "node:fs";
import path from "node:path";
import url  from "node:url";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, "..");

const SHARED_ORDER = [
  "logger.js",
  "html-extractor.js",
  "net-hooks.js",
  "skeleton.js",
  "net-replayer.js",
];

const SOURCE   = path.join(ROOT, "userscript", "jaal-source.js");
const OUT_FILE = path.join(ROOT, "userscript", "jaal.user.js");

function splitHeader(src) {
  const HEADER_END = "// ==/UserScript==";
  const idx = src.indexOf(HEADER_END);
  if (idx === -1) {
    console.warn("[build-userscript] WARNING: no ==/UserScript== found in jaal-source.js");
    return { header: "", body: src };
  }
  const split = idx + HEADER_END.length;
  return {
    header: src.substring(0, split) + "\n",
    body:   src.substring(split),
  };
}

function wrapFile(file, relPath) {
  return `\n// ── ${relPath} ──────────────────────────────────────\n` + file + "\n";
}

const sourceText = fs.readFileSync(SOURCE, "utf8");
const { header, body } = splitHeader(sourceText);

const parts = [header];

for (const name of SHARED_ORDER) {
  const p = path.join(ROOT, "shared", name);
  if (!fs.existsSync(p)) {
    console.error(`[build-userscript] ERROR: shared/${name} not found`);
    process.exit(1);
  }
  parts.push(wrapFile(fs.readFileSync(p, "utf8"), `shared/${name}`));
  console.log(`  included    shared/${name}`);
}

// Remove any NOTE comment block at top of body (lines starting with // NOTE:)
// so the output reads cleanly after the header.
const bodyClean = body.replace(/^\s*\/\/ NOTE:.*\n/gm, "");
parts.push(wrapFile(bodyClean, "userscript/jaal-source.js"));

fs.writeFileSync(OUT_FILE, parts.join(""), "utf8");

const kb = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);
console.log(`\n[build-userscript] wrote ${path.relative(ROOT, OUT_FILE)}  (${kb} KB)`);
