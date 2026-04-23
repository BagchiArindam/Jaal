# Jaal — agent guide

Jaal (Hindi/Urdu: "net / web / trap") is a web-inspection and reverse-DOM toolkit. One codebase, two distribution variants (`extension/` WebExtension and `userscript/` Tampermonkey), sharing a common core (`shared/`) and talking to a local Flask server (`server/`) on port **7773**.

This file is the source of truth. `CLAUDE.md` is a one-line shim. Follow everything here verbatim.

## What Jaal does

1. **List scraping** — right-click a page, pick a repeating container, get an AI-detected column schema, sort/filter/hide inline, flatten pagination, export CSV with checkpoint resume. (Migrated forward from sort-sight.)
2. **DOM skeleton inspector** — pseudo-Figma tree of the page's structure with layout-CSS annotations, in a floating overlay. (From dom-skeleton-inspector.)
3. **Network recorder + replayer** — hook fetch/XHR/WebSocket at `document-start`, diff the capture around a UI action (typically a pagination click), emit a standalone replayer script that reproduces the call without the DOM.
4. **URL pattern discovery** — given a page, find its siblings via `sitemap.xml` → search-engine `site:` query → AI inference.

## Repo layout

```
extension/          WebExtension variant (MV3 Chrome + MV2 Firefox)
  manifest.json           MV3
  manifest.v2.json        MV2
  background.js           context menu + server relay
  content/                content scripts, import from ../shared
  ui/                     toolbars, overlays, picker UI
userscript/         Tampermonkey variant
  jaal.user.js            built by build/build-userscript.mjs
shared/             core logic, imported by both variants
  html-extractor.js       DOM → sample extraction (from lib-sortsight-js)
  net-hooks.js            fetch/XHR/WS interceptor (from lib-sortsight-js)
  sync.js                 small storage sync helper (from lib-sortsight-js)
  skeleton.js             DOM tree logic (from dom-skeleton-inspector)
  paginator.js            5-strategy pagination state machine
  sorter.js               client-side sort/filter
  net-replayer.js         replayer script generator
  logger.js               structured JSONL logger (from cc-session-tools)
server/             Flask app on :7773
  server.py, analyzer.py, ai_provider.py, html_cleaner.py,
  pattern_discovery.py, cache.py, scrape_runs.py, config.py,
  logger.py, requirements.txt
build/              build-extension.mjs, build-userscript.mjs
.claude/commands/   slash commands (discover-patterns.md)
test/test-pages/    local fixtures (products, tables, paginated)
```

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `JAAL_PORT` | `7773` | Flask bind port |
| `JAAL_AI_PROVIDER` | `claude_cli` | one of `claude_cli`, `codex_cli` |
| `JAAL_CACHE_DIR` | `<server>/.cache` | analysis cache root |
| `JAAL_RUNS_DIR` | `<server>/.runs` | scrape session root |

Legacy `SORTSIGHT_AI_PROVIDER` is read as a fallback during the deprecation window. Do not add new fallbacks for other old names.

## Server endpoints (:7773)

- `GET  /health` — provider status, cache + runs counts
- `POST /analyze` — container metadata + 2-3 HTML samples → column config
- `POST /analyze-pagination` — pagination HTML → type + selectors
- `POST /discover-patterns` — URL → candidate sibling URLs
- `GET|POST /cache/*` — `list`, `check`, `delete`, `by-url`, `clear`
- `POST /scrape-runs/start` — begin session, return `runId`
- `POST /scrape-runs/{id}/checkpoint` — persist rows + checkpoint
- `POST /scrape-runs/{id}/complete` — finalize run
- `GET  /scrape-runs/latest` — most recent run

## Conventions

- **Languages:** Python 3.11+ (`server/`), classic-script JS (`shared/`, `extension/`), userscript-flavored JS (`userscript/`).
- **JS module style:** IIFE + `window.Jaal.<module>` global namespace — **not ES modules**. Extension MV2 content scripts and Tampermonkey both ship better with classic scripts; the `build/build-userscript.mjs` step just concatenates files in order.
- **No TypeScript** in any variant — keep the build chain minimal.
- **Dependency rule:** `extension/` and `userscript/` may use `shared/` modules, never the other way around. `shared/` modules register themselves on `window.Jaal` without any DOM side effects on load.
- **Context menu id:** `jaal-pick` (not `sortsight-pick`).
- **CSS isolation:** all injected UI uses Shadow DOM so host site styles don't bleed in.
- **Userscript data:** any persistent data stored via `GM_setValue` ships with export-to-JSON + import-from-JSON buttons in a `⚙️ Settings` panel, plus a blinking backup-age indicator (per global `~/.claude/CLAUDE.md`).

## Logging (structured JSONL, required everywhere)

Every file — JS or Python — logs at: initialization, DOM query / network call, mutation, error. Use the shared logger:

- JS: load `shared/logger.js` first, then `const log = window.Jaal.makeLogger('<component>')`
- Python: `from logger import make_logger` then `log = make_logger('<component>')`

One log line = one JSON object with fields: `ts`, `project` (`"jaal"`), `lang` (`js|py`), `phase` (`init|load|mutate|teardown|error`), `level` (`debug|info|warn|error`), `component`, `event` (verb-noun), and optional `data`.

Parse logs with `python D:/Dev/cc-session-tools/parse-logs.py <file.jsonl>`. Never grep raw log text when the parser works.

## Commit messages

**Minimal. Do not mention Claude Code usage.** Example good messages:

```
init: Jaal repo skeleton
absorb: shared libs + discover-patterns command
feat(server): /health endpoint with provider status
fix(paginator): LOAD_MORE backoff handles 429
```

One concise line, optional scope. No Co-Authored-By trailers.

## Deprecated ancestors (reference only — do not run)

- `D:\sort-sight\` — predecessor extension + server; mine patterns, don't copy
- `D:\Dev\lib-sortsight-core\` — absorbed into `server/ai_provider.py` + `server/html_cleaner.py`
- `D:\Dev\lib-sortsight-js\` — absorbed into `shared/`
- `D:\Dev\web-audit-kit\` — `.claude/commands/discover-patterns.md` absorbed
- `D:\Dev\dom-skeleton-inspector\` — absorbed, split across `shared/skeleton.js` + `extension/ui/` + userscript shim

Each has a `DEPRECATED.md` at its root. Do not commit there.

## Test sites

Local fixtures in `test/test-pages/` (products, tables, paginated). Real sites previously exercised against sort-sight: Zepto, Blinkit, Swiggy — inherit as smoke targets once basic flows work.

## Verification checklist

- Server boots: `curl http://localhost:7773/health`
- Extension loads in Chrome (MV3) and Firefox (MV2)
- Userscript loads in Tampermonkey, floating launcher appears on any page
- `/discover-patterns` returns sitemap or fallback candidates
- Flatten + scrape round-trip produces CSV with `_page`, `_source_url`, `_item_hash`, `_scraped_at`
- Mid-scrape kill + restart resumes from last checkpoint
- Logs parse with `parse-logs.py`
