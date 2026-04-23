# Jaal

Web-inspection and reverse-DOM toolkit. One codebase, two variants:

- **`extension/`** — WebExtension (Chrome MV3, Firefox MV2)
- **`userscript/`** — Tampermonkey `.user.js`

Both share `shared/` core logic and talk to a local Flask server in `server/` on port **7773**.

## What it does

1. **List scraping** — pick a container, AI detects columns, sort/filter/hide inline, flatten pagination, export CSV with checkpoint resume.
2. **DOM skeleton inspector** — floating pseudo-Figma tree of the page's structure with layout-CSS annotations.
3. **Network recorder + replayer** — hook fetch/XHR/WS at `document-start`, diff the capture around a UI action, emit a standalone replayer script.
4. **URL pattern discovery** — sitemap → search `site:` query → AI inference.

## Quick start

```bash
# server
cd server && pip install -r requirements.txt && python server.py

# extension (unpacked load)
#   Chrome:  chrome://extensions → Load unpacked → pick extension/ (MV3)
#   Firefox: about:debugging → Load Temporary Add-on → pick extension/manifest.v2.json

# userscript
npm run build:userscript    # produces userscript/jaal.user.js
# install in Tampermonkey
```

See `AGENTS.md` for architecture, conventions, and full endpoint list.

## Status

Replaces `D:\sort-sight\` and four smaller scattered repos. See `AGENTS.md` → _Deprecated ancestors_.
