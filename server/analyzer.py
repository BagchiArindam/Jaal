"""Column detection + pagination classification via the configured AI provider.

Prompts written fresh for Jaal — preserves the output schema contract from
sort-sight's analyzer.py (itemSelector/columns, pagination type + selectors)
but re-phrases the instructions. Schema stability matters; wording does not.
"""
import json
import os
import random
import string
from datetime import datetime, timezone

from html_cleaner import clean_html
from logger import make_logger
from providers import get_provider

log = make_logger("analyzer")

_DEBUG_DIR = os.path.join(os.path.dirname(__file__), ".debug")


# ─────────────────────────────────────────────────────────────────────────────
# Column detection
# ─────────────────────────────────────────────────────────────────────────────

COLUMN_SYSTEM_PROMPT = (
    "You infer structured columns from repeating HTML items. "
    "Your output is consumed by a scraper, so it must be strict JSON — no markdown, "
    "no prose, no comments, no trailing commas."
)

COLUMN_USER_TEMPLATE = """Container: <{container_tag} class="{container_classes}">
Direct children: {total_children}, dominant child tag: <{dominant_tag}>{grid_note}

Note: the input sample below is a SYNTHETIC union element whose direct children are
representative leaf nodes from ALL real repeating items. It is NOT a real item.
Selectors you return must match elements inside ONE real item, not the synthetic root div.
IMPORTANT: The synthetic wrapper has the CSS class "jaal-super-item" which does NOT exist
in the real page DOM. Never use ".jaal-super-item" or any selector containing a "jaal-"
class for itemSelector or any column selector — they will match nothing on the live page.

Below are {sample_count} representative item samples. Return a JSON object shaped as:

{{
  "itemSelector": "<CSS selector matching one whole repeating item, relative to the container>",
  "columns": [
    {{
      "name": "<short human label, e.g. Title, Price, Rating>",
      "selector": "<CSS selector relative to one item; \\"\\" means the item element itself>",
      "attribute": "<textContent | href | src | alt | data-* name>",
      "dataType": "<text | number | date | currency | rating>",
      "sortDefault": "<asc | desc | null>",
      "variance": "<high | low>"
    }}
  ]
}}

Selector rules (these have all been bug sources — follow them carefully):
- itemSelector must match the OUTERMOST element that contains EVERY column you list.
  If title, price, and image are all visible in the sample, itemSelector must be their common ancestor.
- Use '> .class' ONLY when items are DIRECT children of the container.
  If items are nested inside wrapper rows/grid cells, use a descendant selector (no '>').
- Prefer stable class names over positional (:nth-child) or generic-tag selectors.
- data-testid values are attractive but sometimes label only a subsection of a card — verify
  the chosen element contains ALL the data fields before picking it.
- If the item element IS an <a>, set selector "" with attribute "textContent" for its text
  and selector "" with attribute "href" for its URL.
- If a column's value lives directly on the item (no nested element), use selector "" and
  pick the appropriate attribute.
- Each column's selector (if non-empty) should match EXACTLY ONE element per real item.
  Use the data-jaal-path attribute hints on nodes to understand what path they came from.

Data-type guidance:
- Money/prices → "currency", sortDefault "asc"
- Star ratings or numeric scores → "rating" or "number"
- Dates → "date", sortDefault "desc"
- Names/titles → "text", sortDefault "asc"

Variance:
- "high" = values are mostly unique per item (titles, URLs, prices, descriptions)
- "low"  = a small set of distinct values repeats across items (badges, categories, flags)

Samples:

{samples_text}

Return the JSON object only."""


# ─────────────────────────────────────────────────────────────────────────────
# Pagination classification
# ─────────────────────────────────────────────────────────────────────────────

PAGINATION_SYSTEM_PROMPT = (
    "You classify pagination/navigation HTML. "
    "Return strict JSON — no markdown, no prose, no trailing commas."
)

PAGINATION_USER_TEMPLATE = """Classify the pagination control shown below from {url}.

{html}

Return a JSON object shaped as:

{{
  "type": "NUMBERED_PAGES | NEXT_PREV_ONLY | LOAD_MORE | FORM_PAGES | NONE",
  "nextSelector": "<CSS for Next, relative to the pagination element, or null>",
  "prevSelector": "<CSS for Previous, or null>",
  "pageNumberSelector": "<CSS matching all numbered page links/buttons, or null>",
  "loadMoreSelector": "<CSS for the single Load More control, or null>",
  "isFormBased": true or false,
  "lastVisiblePage": <integer or null>
}}

Classification rules:
- NUMBERED_PAGES: multiple clickable page numbers, optionally with next/prev controls.
- NEXT_PREV_ONLY: next/prev controls with no individual page numbers.
- LOAD_MORE: a single button that appends more items in place.
- FORM_PAGES: pagination submits via <form> + input[type=submit] (common on older server-rendered sites).
- NONE: no recognizable pagination controls.

Selector rules:
- Decide from element structure (<a>, <button>, <form>, <input type=submit>) and aria attributes, not text content — text may be non-English.
- Prefer class names, ids, and aria-labels. Avoid positional selectors.

Return the JSON object only."""


# ─────────────────────────────────────────────────────────────────────────────
# Debug artifact helpers
# ─────────────────────────────────────────────────────────────────────────────

def _generate_run_id() -> str:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    return f"ana_{ts}_{suffix}"


def _write_debug_pre(
    run_id: str,
    system_prompt: str,
    user_prompt: str,
    metadata: dict,
    samples: list,
) -> None:
    """Write input-side artifacts BEFORE calling the AI provider.
    Called on every /analyze request so artifacts exist even if the provider throws."""
    try:
        run_dir = os.path.join(_DEBUG_DIR, run_id)
        os.makedirs(run_dir, exist_ok=True)
        if samples:
            with open(os.path.join(run_dir, "super-element.html"), "w", encoding="utf-8") as f:
                f.write(samples[0])
        with open(os.path.join(run_dir, "metadata.json"), "w", encoding="utf-8") as f:
            json.dump(metadata, f, indent=2, default=str)
        url = metadata.get("url", "")
        with open(os.path.join(run_dir, "url.txt"), "w", encoding="utf-8") as f:
            f.write(url)
        with open(os.path.join(run_dir, "prompt.txt"), "w", encoding="utf-8") as f:
            f.write("=== SYSTEM ===\n")
            f.write(system_prompt)
            f.write("\n\n=== USER ===\n")
            f.write(user_prompt)
        log.info("debug_pre_written", phase="mutate", runId=run_id)
    except Exception as exc:
        log.warning("debug_pre_failed", phase="error", runId=run_id, err=str(exc))


def _write_debug_post(
    run_id: str,
    metadata: dict,
    result: dict,
    status: str = "ok",
) -> None:
    """Write output-side artifacts + index.jsonl after provider returns (or on error)."""
    try:
        run_dir = os.path.join(_DEBUG_DIR, run_id)
        os.makedirs(run_dir, exist_ok=True)
        with open(os.path.join(run_dir, "parsed.json"), "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, default=str)
        url = metadata.get("url", "")
        parts = url.split("/")
        domain = parts[2] if len(parts) > 2 else ""
        summary = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "runId": run_id,
            "url": url,
            "domain": domain,
            "fieldCount": metadata.get("fieldCount", 0),
            "columnCount": len(result.get("columns", [])),
            "status": status,
        }
        index_path = os.path.join(_DEBUG_DIR, "index.jsonl")
        with open(index_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(summary) + "\n")
        _prune_debug(index_path, max_entries=500)
        log.info("debug_post_written", phase="mutate", runId=run_id, status=status)
    except Exception as exc:
        log.warning("debug_post_failed", phase="error", runId=run_id, err=str(exc))


def _write_debug_error(run_id: str, metadata: dict, exc_traceback: str) -> None:
    """Write error.txt on provider exception + index.jsonl with status='error'."""
    import traceback as _tb
    try:
        run_dir = os.path.join(_DEBUG_DIR, run_id)
        os.makedirs(run_dir, exist_ok=True)
        with open(os.path.join(run_dir, "error.txt"), "w", encoding="utf-8") as f:
            f.write(exc_traceback)
    except Exception:
        pass
    _write_debug_post(run_id, metadata, {}, status="error")


def write_cache_hit_debug(metadata: dict, samples: list, cached_result: dict) -> str:
    """Write debug artifacts for a cache-hit /analyze response. Returns the new runId."""
    run_id = _generate_run_id()
    user_message = _build_column_prompt(metadata, samples) if samples else "(no samples — cache hit)"
    _write_debug_pre(run_id, COLUMN_SYSTEM_PROMPT, user_message, metadata, samples)
    try:
        run_dir = os.path.join(_DEBUG_DIR, run_id)
        with open(os.path.join(run_dir, "cache-hit.txt"), "w", encoding="utf-8") as f:
            f.write("Cache hit — the AI was NOT called for this request.\n"
                    "The result in parsed.json came from the server cache.\n")
    except Exception:
        pass
    _write_debug_post(run_id, metadata, cached_result, status="cache-hit")
    return run_id


def _prune_debug(index_path: str, max_entries: int = 500) -> None:
    try:
        if not os.path.exists(index_path):
            return
        with open(index_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
        if len(lines) <= max_entries:
            return
        to_remove = lines[: len(lines) - max_entries]
        to_keep = lines[len(lines) - max_entries :]
        for line in to_remove:
            try:
                entry = json.loads(line.strip())
                run_dir = os.path.join(_DEBUG_DIR, entry.get("runId", ""))
                if os.path.isdir(run_dir):
                    import shutil
                    shutil.rmtree(run_dir, ignore_errors=True)
            except Exception:
                pass
        with open(index_path, "w", encoding="utf-8") as f:
            f.writelines(to_keep)
    except Exception as exc:
        log.warning("debug_prune_failed", phase="error", err=str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# Column detection
# ─────────────────────────────────────────────────────────────────────────────

def _build_column_prompt(metadata: dict, samples: list[str]) -> str:
    cleaned = [clean_html(s) for s in samples]
    samples_text = "\n\n".join(
        f"--- Sample {i + 1} ---\n{s}" for i, s in enumerate(cleaned)
    )

    tag_dist = metadata.get("childTagDistribution", {})
    dominant_tag = max(tag_dist, key=tag_dist.get) if tag_dist else "div"

    grid_note = ""
    if metadata.get("unwrappedGrid"):
        total_items = metadata.get("totalItems", "?")
        grid_note = (
            f"\nNote: the direct children are structural row/grid wrappers. "
            f"The actual repeating items ({total_items} total) are nested inside. "
            f"The samples below are the INNER repeating items. "
            f"Your itemSelector MUST use a descendant selector (no '>') to reach them."
        )

    return COLUMN_USER_TEMPLATE.format(
        container_tag=metadata.get("containerTag", "div"),
        container_classes=metadata.get("containerClasses", ""),
        total_children=metadata.get("totalChildren", "unknown"),
        dominant_tag=dominant_tag,
        grid_note=grid_note,
        sample_count=len(cleaned),
        samples_text=samples_text,
    )


def analyze(metadata: dict, samples: list[str]) -> dict:
    import traceback as _tb
    run_id = _generate_run_id()
    user_message = _build_column_prompt(metadata, samples)
    provider = get_provider()
    log.info(
        "analyze_start",
        phase="mutate",
        runId=run_id,
        provider=provider.name,
        model=provider.model,
        promptChars=len(user_message),
        sampleCount=len(samples),
    )
    # Write input artifacts before provider so they exist even if provider throws.
    _write_debug_pre(run_id, COLUMN_SYSTEM_PROMPT, user_message, metadata, samples)
    try:
        result = provider.run_json_task(COLUMN_SYSTEM_PROMPT, user_message)
    except Exception as exc:
        _write_debug_error(run_id, metadata, _tb.format_exc())
        log.error("analyze_provider_failed", phase="error", runId=run_id, err=str(exc))
        raise
    log.info(
        "analyze_done",
        phase="mutate",
        runId=run_id,
        columnCount=len(result.get("columns", [])),
        itemSelector=result.get("itemSelector"),
    )
    _write_debug_post(run_id, metadata, result, status="ok")
    result["runId"] = run_id
    return result


def analyze_pagination(html: str, url: str) -> dict:
    truncated = html[:5000]
    user_message = PAGINATION_USER_TEMPLATE.format(url=url, html=truncated)
    provider = get_provider()
    log.info(
        "analyze_pagination_start",
        phase="mutate",
        provider=provider.name,
        model=provider.model,
        url=url,
        htmlChars=len(html),
        truncated=len(html) > 5000,
    )
    result = provider.run_json_task(PAGINATION_SYSTEM_PROMPT, user_message)
    log.info(
        "analyze_pagination_done",
        phase="mutate",
        url=url,
        type=result.get("type"),
    )
    return result
