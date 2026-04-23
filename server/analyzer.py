"""Column detection + pagination classification via the configured AI provider.

Prompts written fresh for Jaal — preserves the output schema contract from
sort-sight's analyzer.py (itemSelector/columns, pagination type + selectors)
but re-phrases the instructions. Schema stability matters; wording does not.
"""
from html_cleaner import clean_html
from logger import make_logger
from providers import get_provider

log = make_logger("analyzer")


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
    user_message = _build_column_prompt(metadata, samples)
    provider = get_provider()
    log.info(
        "analyze_start",
        phase="mutate",
        provider=provider.name,
        model=provider.model,
        promptChars=len(user_message),
        sampleCount=len(samples),
    )
    result = provider.run_json_task(COLUMN_SYSTEM_PROMPT, user_message)
    log.info(
        "analyze_done",
        phase="mutate",
        columnCount=len(result.get("columns", [])),
        itemSelector=result.get("itemSelector"),
    )
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
