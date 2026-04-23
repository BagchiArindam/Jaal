"""Jaal HTML cleaner — further trim HTML that was already minimized client-side.

Ported verbatim from D:\\Dev\\lib-sortsight-core\\sortsight_core\\html_cleaner.py.
Still a stub — grow as patterns that trip Claude's token budget surface.
"""
import re


def clean_html(html: str) -> str:
    """Further clean HTML that was already minimized client-side."""
    # Remove HTML comments
    html = re.sub(r"<!--.*?-->", "", html, flags=re.DOTALL)
    # Collapse multiple whitespace/newlines into single space
    html = re.sub(r"\s+", " ", html)
    # Remove whitespace between tags
    html = re.sub(r">\s+<", "><", html)
    return html.strip()
