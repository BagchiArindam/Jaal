"""URL pattern discovery.

Strategy order (first wins, each falls back on failure):
  1. sitemap.xml  — via robots.txt Sitemap: directives, or /sitemap.xml
  2. DuckDuckGo `site:` search  — scrape HTML results for hrefs on the same domain
  3. AI inference  — ask the provider for likely URL patterns given the domain

Every strategy returns a flat list of URL strings; those are clustered into
patterns (e.g. /posts/123 + /posts/456 → /posts/:id) with counts.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import Any
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

from logger import make_logger
from providers import get_provider

log = make_logger("pattern_discovery")

USER_AGENT = "Mozilla/5.0 (Jaal pattern discovery; local)"
HTTP_TIMEOUT = 15
MAX_URLS_FROM_SITEMAP = 500
MAX_URLS_FROM_SEARCH = 50

_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_DATE_SEGMENT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$|^\d{4}$|^\d{2}$")
_SLUG_RE = re.compile(r"^(?=.*[a-zA-Z])(?=.*\d).*[-_].*$|^[a-z0-9]+(?:-[a-z0-9]+){2,}$")


# ─── domain / URL normalization ─────────────────────────────────────────────

def _domain_from(target: str) -> str:
    """Accept a full URL, a protocol-less URL, or a bare domain; return hostname."""
    cleaned = target.strip()
    if "://" not in cleaned:
        cleaned = "https://" + cleaned
    parsed = urlparse(cleaned)
    return (parsed.hostname or "").lower()


def _base_url(domain: str) -> str:
    return f"https://{domain}"


# ─── robots.txt + sitemap ───────────────────────────────────────────────────

def _fetch_text(url: str) -> str | None:
    try:
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=HTTP_TIMEOUT, allow_redirects=True)
        if r.status_code != 200:
            return None
        return r.text
    except Exception as e:
        log.warn("http_fetch_failed", phase="load", url=url, err=str(e))
        return None


def _parse_robots(text: str) -> dict[str, Any]:
    sitemaps: list[str] = []
    disallow: list[str] = []
    crawl_delay: str | None = None
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip().lower()
        value = value.strip()
        if key == "sitemap" and value:
            sitemaps.append(value)
        elif key == "disallow" and value:
            disallow.append(value)
        elif key == "crawl-delay" and value and not crawl_delay:
            crawl_delay = value
    return {"sitemaps": sitemaps, "disallow": disallow, "crawlDelay": crawl_delay}


def _extract_sitemap_locs(xml_text: str, base: str) -> tuple[list[str], list[str]]:
    """Return (leaf_urls, nested_sitemap_urls).

    The root tag tells us which we have: <urlset> → leaf page URLs,
    <sitemapindex> → nested sitemap URLs to recurse into.
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        log.warn("sitemap_parse_failed", phase="load", err=str(e))
        return [], []
    locs: list[str] = []
    for el in root.iter():
        local = el.tag.split("}")[-1]
        if local == "loc" and (el.text or "").strip():
            locs.append(urljoin(base, el.text.strip()))
    root_local = root.tag.split("}")[-1].lower()
    if root_local == "sitemapindex":
        return [], locs
    return locs, []


def _collect_sitemap_urls(domain: str, max_depth: int = 2) -> tuple[list[str], dict[str, Any]]:
    base = _base_url(domain)
    robots_text = _fetch_text(f"{base}/robots.txt") or ""
    robots = _parse_robots(robots_text) if robots_text else {"sitemaps": [], "disallow": [], "crawlDelay": None}
    robots["fetched"] = bool(robots_text)

    candidates = list(robots["sitemaps"]) or [f"{base}/sitemap.xml"]
    visited: set[str] = set()
    collected: list[str] = []
    stack = [(u, 0) for u in candidates]

    while stack and len(collected) < MAX_URLS_FROM_SITEMAP:
        url, depth = stack.pop(0)
        if url in visited:
            continue
        visited.add(url)
        xml_text = _fetch_text(url)
        if not xml_text:
            continue
        leaf, nested = _extract_sitemap_locs(xml_text, base)
        collected.extend(leaf[: MAX_URLS_FROM_SITEMAP - len(collected)])
        if depth < max_depth:
            for n in nested:
                if n not in visited:
                    stack.append((n, depth + 1))

    robots["hasSitemap"] = bool(collected)
    return collected, robots


# ─── DuckDuckGo site: fallback ──────────────────────────────────────────────

def _collect_from_search(domain: str) -> list[str]:
    query_url = f"https://html.duckduckgo.com/html/?q=site:{domain}"
    html = _fetch_text(query_url)
    if not html:
        # fallback to Bing
        html = _fetch_text(f"https://www.bing.com/search?q=site:{domain}")
    if not html:
        return []
    try:
        soup = BeautifulSoup(html, "html.parser")
    except Exception as e:
        log.warn("search_parse_failed", phase="load", err=str(e))
        return []
    urls: list[str] = []
    seen: set[str] = set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        # DuckDuckGo often wraps: /l/?uddg=ENCODED_URL — extract the real target
        if href.startswith("/l/?"):
            m = re.search(r"[?&]uddg=([^&]+)", href)
            if not m:
                continue
            from urllib.parse import unquote
            href = unquote(m.group(1))
        parsed = urlparse(href)
        host = (parsed.hostname or "").lower()
        if not host or domain not in host:
            continue
        canonical = f"{parsed.scheme or 'https'}://{host}{parsed.path or ''}"
        if canonical in seen:
            continue
        seen.add(canonical)
        urls.append(canonical)
        if len(urls) >= MAX_URLS_FROM_SEARCH:
            break
    return urls


# ─── AI-inference fallback ──────────────────────────────────────────────────

_AI_SYSTEM = (
    "You enumerate the main URL route patterns of websites. "
    "Return strict JSON: no markdown fences, no prose, no trailing commas."
)
_AI_USER_TEMPLATE = """Domain: {domain}

Return a JSON object listing the canonical URL route patterns for this site.

{{
  "patterns": [
    {{"pattern": "/route/:param", "example": "/route/abc", "notes": "short description"}}
  ]
}}

Rules:
- Use ':id' for numeric IDs, ':uuid' for UUIDs, ':date' for dates, ':slug' for slugs.
- Prefer well-known routes you already know for major sites (pixiv.net, reddit.com, github.com, etc.).
- If you don't recognize the site, return an empty patterns array rather than guessing.
- Return the JSON object only."""


def _infer_via_ai(domain: str) -> list[dict[str, Any]]:
    provider = get_provider()
    try:
        result = provider.run_json_task(_AI_SYSTEM, _AI_USER_TEMPLATE.format(domain=domain))
    except Exception as e:
        log.warn("ai_infer_failed", phase="load", domain=domain, err=str(e))
        return []
    patterns = result.get("patterns") or []
    out: list[dict[str, Any]] = []
    for p in patterns:
        pat = str((p or {}).get("pattern", "")).strip()
        if pat:
            out.append({
                "pattern": pat,
                "example": str(p.get("example", "")).strip(),
                "count": None,
                "notes": str(p.get("notes", "")).strip(),
            })
    return out


# ─── URL → pattern clustering ────────────────────────────────────────────────

def _classify_segment(seg: str) -> str:
    if not seg:
        return seg
    if seg.isdigit():
        return ":id"
    if _UUID_RE.match(seg):
        return ":uuid"
    if _DATE_SEGMENT_RE.match(seg):
        return ":date"
    if _SLUG_RE.match(seg):
        return ":slug"
    return seg


def _pattern_for_url(url: str) -> str:
    parsed = urlparse(url)
    segments = [_classify_segment(s) for s in (parsed.path or "/").split("/")]
    path_pattern = "/".join(segments) or "/"
    if parsed.query:
        qs_keys = sorted({kv.split("=", 1)[0] for kv in parsed.query.split("&") if kv})
        query_pattern = "&".join(f"{k}=:value" for k in qs_keys)
        return f"{path_pattern}?{query_pattern}"
    return path_pattern


def _cluster(urls: list[str]) -> list[dict[str, Any]]:
    counts: dict[str, int] = {}
    examples: dict[str, str] = {}
    for u in urls:
        pat = _pattern_for_url(u)
        counts[pat] = counts.get(pat, 0) + 1
        examples.setdefault(pat, u)
    clusters = [
        {"pattern": pat, "example": examples[pat], "count": cnt}
        for pat, cnt in counts.items()
    ]
    clusters.sort(key=lambda c: c["count"], reverse=True)
    return clusters


# ─── public entrypoint ──────────────────────────────────────────────────────

def discover(target: str) -> dict[str, Any]:
    domain = _domain_from(target)
    if not domain:
        return {"error": "invalid URL or domain"}

    log.info("discover_start", phase="init", target=target, domain=domain)

    # Strategy 1: sitemap
    sitemap_urls, robots = _collect_sitemap_urls(domain)
    if sitemap_urls:
        clusters = _cluster(sitemap_urls)
        log.info("discover_via_sitemap", phase="mutate", domain=domain, rawCount=len(sitemap_urls), patterns=len(clusters))
        return {
            "domain": domain,
            "source": "sitemap",
            "patterns": clusters,
            "rawCount": len(sitemap_urls),
            "robots": robots,
        }

    # Strategy 2: DuckDuckGo / Bing search
    search_urls = _collect_from_search(domain)
    if search_urls:
        clusters = _cluster(search_urls)
        log.info("discover_via_search", phase="mutate", domain=domain, rawCount=len(search_urls), patterns=len(clusters))
        return {
            "domain": domain,
            "source": "search",
            "patterns": clusters,
            "rawCount": len(search_urls),
            "robots": robots,
        }

    # Strategy 3: AI inference
    ai_patterns = _infer_via_ai(domain)
    log.info("discover_via_ai", phase="mutate", domain=domain, patterns=len(ai_patterns))
    return {
        "domain": domain,
        "source": "ai",
        "patterns": ai_patterns,
        "rawCount": 0,
        "robots": robots,
    }
