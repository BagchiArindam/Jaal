#!/usr/bin/env node
/**
 * build/dev-sync.mjs — copy shared/*.js into extension/shared/ and userscript/shared/
 * so both variants can be loaded without a full build.
 *
 * Run this once after cloning, and again whenever files in shared/ change.
 * Extension loads unpacked from extension/ and needs shared/ as a subfolder
 * because chrome.scripting.executeScript resolves paths relative to the
 * manifest root. The userscript build in C-8 will replace this with proper
 * concatenation; for now the sync is enough.
 *
 * Usage:
 *   node build/dev-sync.mjs
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const srcShared = path.join(repoRoot, "shared");

const targets = [
  path.join(repoRoot, "extension", "shared"),
  path.join(repoRoot, "userscript", "shared"),
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function syncInto(dest) {
  ensureDir(dest);
  const srcFiles = fs.readdirSync(srcShared).filter((f) => f.endsWith(".js"));
  // Drop stale files that no longer exist in shared/
  for (const existing of fs.readdirSync(dest)) {
    if (existing.endsWith(".js") && !srcFiles.includes(existing)) {
      fs.unlinkSync(path.join(dest, existing));
      console.log(`  removed stale  ${path.relative(repoRoot, path.join(dest, existing))}`);
    }
  }
  for (const f of srcFiles) {
    const srcPath = path.join(srcShared, f);
    const destPath = path.join(dest, f);
    fs.copyFileSync(srcPath, destPath);
    console.log(`  copied         ${path.relative(repoRoot, destPath)}`);
  }
}

console.log(`[dev-sync] syncing shared/ → ${targets.length} destination(s)`);
for (const t of targets) {
  console.log(`\n[dev-sync] ${path.relative(repoRoot, t)}`);
  syncInto(t);
}
console.log("\n[dev-sync] done");
