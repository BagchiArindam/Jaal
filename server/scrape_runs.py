"""Scrape session persistence — one directory per run under `config.RUNS_DIR`.

Layout for each run:
  <RUNS_DIR>/<runId>/
      state.json    mutable session state (pages scraped, seen hashes, status, ...)
      meta.json     immutable snapshot of site + config at start time
      rows.csv      appended rows (columns + ROW_META_COLUMNS)

Public surface:
  list_entries(), get_latest(), get_state(),
  start_run(), checkpoint(), complete(),
  build_config_hash(), ROW_META_COLUMNS
"""
import csv
import hashlib
import json
import os
import random
import string
from datetime import datetime, timezone
from typing import Any

from config import RUNS_DIR
from logger import make_logger

log = make_logger("scrape_runs")

ROW_META_COLUMNS = ["_page", "_source_url", "_item_hash", "_scraped_at"]


# ─── paths / fs helpers ──────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_dir() -> None:
    os.makedirs(RUNS_DIR, exist_ok=True)


def _run_path(run_id: str) -> str:
    return os.path.join(RUNS_DIR, run_id)


def _state_path(run_id: str) -> str:
    return os.path.join(_run_path(run_id), "state.json")


def _meta_path(run_id: str) -> str:
    return os.path.join(_run_path(run_id), "meta.json")


def _rows_path(run_id: str) -> str:
    return os.path.join(_run_path(run_id), "rows.csv")


def _read_json(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _write_json(path: str, data: dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


# ─── ids + hashes ────────────────────────────────────────────────────────────

def build_config_hash(config: dict[str, Any]) -> str:
    """Stable 16-char hex hash of a scrape config (order-insensitive)."""
    serialized = json.dumps(config, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()[:16]


def _new_run_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    return f"run_{stamp}_{suffix}"


def _column_headers(config: dict[str, Any]) -> list[str]:
    cols = config.get("columns", []) if isinstance(config, dict) else []
    names: list[str] = []
    for col in cols:
        name = str((col or {}).get("name", "")).strip()
        if name:
            names.append(name)
    # Dedupe preserving order, then append the meta columns in fixed order
    seen: set[str] = set()
    deduped = [n for n in names if not (n in seen or seen.add(n))]
    return deduped + ROW_META_COLUMNS


# ─── listing / lookup ────────────────────────────────────────────────────────

def _find_all_run_ids() -> list[str]:
    _ensure_dir()
    ids: list[str] = []
    for name in os.listdir(RUNS_DIR):
        path = os.path.join(RUNS_DIR, name)
        if os.path.isdir(path) and os.path.exists(os.path.join(path, "state.json")):
            ids.append(name)
    return ids


def list_entries() -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for run_id in _find_all_run_ids():
        try:
            state = _read_json(_state_path(run_id))
            entries.append({
                "runId": run_id,
                "siteKey": state.get("siteKey"),
                "configHash": state.get("configHash"),
                "status": state.get("status"),
                "currentPage": state.get("currentPage", 0),
                "totalRows": state.get("totalRows", 0),
                "createdAt": state.get("createdAt"),
                "updatedAt": state.get("updatedAt"),
            })
        except Exception:
            continue
    entries.sort(key=lambda e: e.get("updatedAt", ""), reverse=True)
    return entries


def get_latest(site_key: str, config_hash: str | None = None) -> dict[str, Any] | None:
    """Return the most recently updated non-completed run matching site_key
    (and optionally config_hash), or None."""
    for entry in list_entries():
        if entry.get("siteKey") != site_key:
            continue
        if config_hash and entry.get("configHash") != config_hash:
            continue
        if entry.get("status") == "completed":
            continue
        return entry
    return None


def get_state(run_id: str) -> dict[str, Any]:
    path = _state_path(run_id)
    if not os.path.exists(path):
        raise FileNotFoundError(f"Run not found: {run_id}")
    return _read_json(path)


# ─── lifecycle: start / checkpoint / complete ────────────────────────────────

def start_run(site_key: str, config: dict[str, Any], resume_run_id: str | None = None) -> dict[str, Any]:
    _ensure_dir()
    config_hash = build_config_hash(config)

    if resume_run_id:
        state = get_state(resume_run_id)
        if state.get("siteKey") != site_key or state.get("configHash") != config_hash:
            raise ValueError("resumeRunId does not match site/config.")
        state["status"] = "in_progress"
        state["updatedAt"] = _now_iso()
        _write_json(_state_path(resume_run_id), state)
        log.info("run_resume", phase="mutate", runId=resume_run_id, siteKey=site_key)
        return {"runId": resume_run_id, "resumed": True, "state": state, "configHash": config_hash}

    run_id = _new_run_id()
    run_dir = _run_path(run_id)
    os.makedirs(run_dir, exist_ok=False)

    headers = _column_headers(config)
    created = _now_iso()
    state: dict[str, Any] = {
        "runId": run_id,
        "siteKey": site_key,
        "configHash": config_hash,
        "status": "in_progress",
        "createdAt": created,
        "updatedAt": created,
        "currentPage": 0,
        "totalRows": 0,
        "nextUrl": None,
        "lastError": None,
        "rateLimited": False,
        "currentDelayMs": 0,
        "seenHashes": [],
        "csvHeaders": headers,
    }
    meta: dict[str, Any] = {
        "runId": run_id,
        "siteKey": site_key,
        "configHash": config_hash,
        "createdAt": created,
        "configSnapshot": config,
    }

    _write_json(_state_path(run_id), state)
    _write_json(_meta_path(run_id), meta)
    with open(_rows_path(run_id), "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=headers, extrasaction="ignore")
        writer.writeheader()

    log.info("run_start", phase="mutate", runId=run_id, siteKey=site_key, columnCount=len(headers) - len(ROW_META_COLUMNS))
    return {"runId": run_id, "resumed": False, "state": state, "configHash": config_hash}


def checkpoint(
    run_id: str,
    rows: list[dict[str, Any]],
    checkpoint_data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    state = get_state(run_id)
    checkpoint_data = checkpoint_data or {}

    # Dedupe by _item_hash — keep only rows we haven't seen in this run
    seen_hashes = {str(h) for h in (state.get("seenHashes") or [])}
    unique_rows: list[dict[str, Any]] = []
    for row in rows or []:
        row_hash = str((row or {}).get("_item_hash", "")).strip()
        if row_hash and row_hash in seen_hashes:
            continue
        if row_hash:
            seen_hashes.add(row_hash)
        unique_rows.append(row)

    headers = state.get("csvHeaders") or []
    if unique_rows:
        with open(_rows_path(run_id), "a", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=headers, extrasaction="ignore")
            for row in unique_rows:
                writer.writerow(row)

    state["seenHashes"] = list(seen_hashes)
    state["totalRows"] = int(state.get("totalRows", 0)) + len(unique_rows)
    state["currentPage"] = max(
        int(state.get("currentPage", 0)),
        int(checkpoint_data.get("currentPage") or 0),
    )
    state["nextUrl"] = checkpoint_data.get("nextUrl")
    state["lastError"] = checkpoint_data.get("lastError")
    state["rateLimited"] = bool(checkpoint_data.get("rateLimited", False))
    state["currentDelayMs"] = int(checkpoint_data.get("currentDelayMs") or 0)
    state["status"] = "rate_limited" if state["rateLimited"] else "in_progress"
    state["updatedAt"] = _now_iso()

    _write_json(_state_path(run_id), state)

    log.info(
        "run_checkpoint",
        phase="mutate",
        runId=run_id,
        appended=len(unique_rows),
        totalRows=state["totalRows"],
        currentPage=state["currentPage"],
        status=state["status"],
    )
    return {
        "runId": run_id,
        "appendedRows": len(unique_rows),
        "totalRows": state["totalRows"],
        "currentPage": state["currentPage"],
        "status": state["status"],
    }


def complete(run_id: str, summary: dict[str, Any] | None = None) -> dict[str, Any]:
    state = get_state(run_id)
    summary = summary or {}
    state["status"] = "completed"
    state["updatedAt"] = _now_iso()
    state["rateLimited"] = False
    state["currentDelayMs"] = 0
    if "currentPage" in summary:
        state["currentPage"] = int(summary.get("currentPage") or state.get("currentPage", 0))
    if "lastError" in summary:
        state["lastError"] = summary.get("lastError")
    _write_json(_state_path(run_id), state)
    log.info("run_complete", phase="mutate", runId=run_id, totalRows=state.get("totalRows", 0))
    return {
        "runId": run_id,
        "status": state["status"],
        "totalRows": state.get("totalRows", 0),
        "currentPage": state.get("currentPage", 0),
    }
