"""Disk cache for AI analysis results — keyed by (url, structural_hash).

One JSON file per cached entry in `config.CACHE_DIR`. Filename derives from
the URL path + hash; contents include the analysis, the metadata snapshot,
and a UTC ISO timestamp.
"""
import json
import os
import re
from datetime import datetime, timezone
from urllib.parse import urlparse
from typing import Any

from config import CACHE_DIR
from logger import make_logger

log = make_logger("cache")

_FILENAME_UNSAFE = re.compile(r'[<>:"/\\|?*\s]')


def _url_key(url: str) -> str:
    """Derive a URL key that mirrors the extension/userscript pattern-store logic
    (hostname + path with any trailing slash removed)."""
    try:
        parsed = urlparse(url)
        return (parsed.hostname or "") + (parsed.path or "").rstrip("/")
    except Exception:
        return url


def _make_filename(url: str, structural_hash: str) -> str:
    raw = f"{_url_key(url)}__{structural_hash}"
    safe = _FILENAME_UNSAFE.sub("_", raw)
    if len(safe) > 200:
        safe = safe[:200]
    return safe + ".json"


def _ensure_dir() -> None:
    os.makedirs(CACHE_DIR, exist_ok=True)


def get(url: str, structural_hash: str) -> dict | None:
    """Return the cached analysis, or None on miss / read failure."""
    _ensure_dir()
    path = os.path.join(CACHE_DIR, _make_filename(url, structural_hash))
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            entry = json.load(f)
        return entry.get("analysis")
    except Exception as e:
        log.warn("cache_read_failed", phase="load", path=path, err=str(e))
        return None


def put(url: str, structural_hash: str, analysis: dict, metadata: dict | None = None) -> None:
    """Persist an analysis result. Swallows write errors (cache is best-effort)."""
    _ensure_dir()
    path = os.path.join(CACHE_DIR, _make_filename(url, structural_hash))
    entry = {
        "url": url,
        "structural_hash": structural_hash,
        "analysis": analysis,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "metadata_snapshot": metadata or {},
    }
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(entry, f, indent=2)
        log.info("cache_put", phase="mutate", url=url, hash=structural_hash)
    except Exception as e:
        log.warn("cache_write_failed", phase="mutate", path=path, err=str(e))


def list_entries() -> list[dict[str, Any]]:
    """Return a summary of every cache file, newest first."""
    _ensure_dir()
    entries: list[dict[str, Any]] = []
    try:
        for fname in os.listdir(CACHE_DIR):
            if not fname.endswith(".json"):
                continue
            path = os.path.join(CACHE_DIR, fname)
            try:
                with open(path, encoding="utf-8") as f:
                    entry = json.load(f)
                entries.append({
                    "url": entry.get("url", ""),
                    "structural_hash": entry.get("structural_hash", ""),
                    "created_at": entry.get("created_at", ""),
                    "column_count": len(entry.get("analysis", {}).get("columns", [])),
                    "filename": fname,
                })
            except Exception:
                continue
    except Exception as e:
        log.warn("cache_list_failed", phase="load", err=str(e))
    entries.sort(key=lambda e: e.get("created_at", ""), reverse=True)
    return entries


def delete_entry(url: str, structural_hash: str) -> bool:
    """Remove a specific cache entry. Returns True if a file was deleted."""
    _ensure_dir()
    path = os.path.join(CACHE_DIR, _make_filename(url, structural_hash))
    if not os.path.exists(path):
        return False
    try:
        os.remove(path)
        log.info("cache_delete", phase="mutate", url=url, hash=structural_hash)
        return True
    except Exception as e:
        log.warn("cache_delete_failed", phase="mutate", path=path, err=str(e))
        return False


def delete_by_url(url: str) -> int:
    """Remove every cache entry whose filename starts with this URL's key.
    Returns the number of files removed."""
    _ensure_dir()
    prefix = _FILENAME_UNSAFE.sub("_", _url_key(url))
    count = 0
    try:
        for fname in os.listdir(CACHE_DIR):
            if fname.endswith(".json") and fname.startswith(prefix):
                try:
                    os.remove(os.path.join(CACHE_DIR, fname))
                    count += 1
                except Exception:
                    pass
    except Exception as e:
        log.warn("cache_delete_by_url_failed", phase="mutate", url=url, err=str(e))
    if count:
        log.info("cache_delete_by_url", phase="mutate", url=url, removed=count)
    return count


def clear() -> int:
    """Remove every cache file. Returns the count removed."""
    _ensure_dir()
    count = 0
    try:
        for fname in os.listdir(CACHE_DIR):
            if fname.endswith(".json"):
                try:
                    os.remove(os.path.join(CACHE_DIR, fname))
                    count += 1
                except Exception:
                    pass
    except Exception as e:
        log.warn("cache_clear_failed", phase="mutate", err=str(e))
    log.info("cache_clear", phase="mutate", removed=count)
    return count
