#!/usr/bin/env node
/**
 * build/watch-firefox.mjs — auto-rebuild on source changes.
 *
 * Watches shared/, extension/, and build/ directories for changes and
 * automatically runs `npm run build:firefox` when files are modified.
 *
 * Usage:
 *   npm run watch:firefox
 *
 * Then in Firefox:
 *   about:debugging → This Firefox → (right-click extension) → Reload
 */
import fs from "fs";
import path from "path";
import url from "url";
import { spawn } from "child_process";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WATCH_DIRS = [
  path.join(ROOT, "shared"),
  path.join(ROOT, "extension"),
  path.join(ROOT, "build"),
];

let debounceTimer;

const rebuild = () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`\n[watch] rebuilding at ${timestamp}...`);
    const proc = spawn("npm", ["run", "build:firefox"], {
      stdio: "inherit",
      cwd: ROOT
    });
    proc.on("error", (err) => {
      console.error("[watch] build failed:", err.message);
    });
  }, 300); // 300ms debounce
};

WATCH_DIRS.forEach((dir) => {
  fs.watch(dir, { recursive: true }, (eventType, filename) => {
    if (
      filename &&
      !filename.includes("node_modules") &&
      !filename.includes("dist-firefox") &&
      !filename.includes(".xpi")
    ) {
      console.log(`[watch] ${eventType}: ${filename}`);
      rebuild();
    }
  });
});

console.log(`[watch] watching ${WATCH_DIRS.map(d => path.relative(ROOT, d)).join(", ")}...`);
console.log("[watch] to rebuild, edit any file in shared/, extension/, or build/ and save");
console.log("[watch] then reload the extension in Firefox (about:debugging → reload button)");
