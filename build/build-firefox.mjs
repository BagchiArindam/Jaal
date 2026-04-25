#!/usr/bin/env node
/**
 * build/build-firefox.mjs — produce dist-firefox/ with manifest.v2.json as manifest.json.
 *
 * Firefox always reads the file literally named `manifest.json`, so we can't
 * load extension/ directly (it has the MV3 manifest). This script copies the
 * extension folder and renames manifest.v2.json → manifest.json, dropping the
 * MV3 manifest.json entirely.
 *
 * Usage:
 *   node build/build-firefox.mjs
 *   npm run build:firefox
 *
 * Then in Firefox: about:debugging → This Firefox → Load Temporary Add-on
 *   → select dist-firefox/manifest.json
 */
import fs   from "node:fs";
import path from "node:path";
import url  from "node:url";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, "..");
const SRC_DIR    = path.join(ROOT, "extension");
const OUT_DIR    = path.join(ROOT, "dist-firefox");

// Re-create dist-firefox/ from scratch
if (fs.existsSync(OUT_DIR)) {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  console.log(`[build-firefox] cleared ${path.relative(ROOT, OUT_DIR)}`);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

function copyRecursive(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRecursive(path.join(src, name), path.join(dst, name));
    }
  } else {
    fs.copyFileSync(src, dst);
  }
}

let copied = 0;
for (const name of fs.readdirSync(SRC_DIR)) {
  // Skip the MV3 manifest and any stray copies — we'll write manifest.json from manifest.v2.json
  if (name === "manifest.json" || name === "manifest.v2.json") continue;
  if (name.toLowerCase().includes("copy")) continue;
  copyRecursive(path.join(SRC_DIR, name), path.join(OUT_DIR, name));
  copied++;
}

// Use manifest.v2.json as the dist manifest.json
const v2Path = path.join(SRC_DIR, "manifest.v2.json");
if (!fs.existsSync(v2Path)) {
  console.error("[build-firefox] ERROR: extension/manifest.v2.json not found");
  process.exit(1);
}
fs.copyFileSync(v2Path, path.join(OUT_DIR, "manifest.json"));
console.log(`[build-firefox] copied ${copied} entries + manifest.v2.json → manifest.json`);
console.log(`[build-firefox] wrote ${path.relative(ROOT, OUT_DIR)}/`);
console.log("");
console.log("Load in Firefox:");
console.log("  1. about:debugging");
console.log("  2. This Firefox");
console.log("  3. Load Temporary Add-on…");
console.log(`  4. Select ${OUT_DIR.replace(/\\/g, "/")}/manifest.json`);
