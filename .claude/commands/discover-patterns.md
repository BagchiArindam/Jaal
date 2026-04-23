Discover the main URL patterns used by the website **$ARGUMENTS**.

## Steps

**Step 1 — Check sitemap.xml**
Use WebFetch to fetch `https://$ARGUMENTS/robots.txt`. Look for any `Sitemap:` directive lines. If found, fetch the sitemap URL and extract all `<loc>` values. Skip sitemap index entries and only take leaf URLs.

**Step 2 — Search engine fallback (if no sitemap or sitemap fetch fails)**
Fetch `https://html.duckduckgo.com/html/?q=site:$ARGUMENTS` using WebFetch. Parse all `<a>` href values that belong to the `$ARGUMENTS` domain. If DuckDuckGo fails, try `https://www.bing.com/search?q=site:$ARGUMENTS`.

**Step 3 — Use built-in knowledge for popular sites**
For well-known sites (pixiv.net, twitter.com, x.com, reddit.com, github.com, youtube.com, instagram.com, and similar major platforms), use built-in knowledge of their URL schema directly — no fetching needed.

**Step 4 — Cluster URLs into patterns**
Group collected URLs by replacing variable segments:
- Digits-only segment → `:id` (e.g. `123456` → `:id`)
- UUID format `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` → `:uuid`
- Date format `YYYY-MM-DD` or `YYYY/MM/DD` → `:date`
- Mixed alphanumeric slug (contains letters + digits + hyphens) → `:slug`
- Query param with a variable value → keep param name, replace value with `:value`
- Identical literal segments stay as-is

Collapse duplicate patterns. Sort by frequency (most common first).

**Step 5 — Output a pattern table**

Return the results as a markdown table:

| URL Pattern | Example | Notes |
|---|---|---|
| `/artworks/:id` | `/artworks/123456` | Individual artwork page |
| ... | ... | ... |

Also report:
- **Sitemap status**: found / not found / fetch failed
- **robots.txt notes**: any `Disallow:` rules affecting crawlability, any `Crawl-delay:` value
- **Auth requirement**: does the site appear to require login for most content?
- **Total patterns found**: N
