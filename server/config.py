"""Jaal server configuration — reads JAAL_* env vars, with a single back-compat
fallback on SORTSIGHT_AI_PROVIDER during the deprecation window.
"""
import os

VERSION = "0.1.0"

HOST = os.environ.get("JAAL_HOST", "127.0.0.1")
PORT = int(os.environ.get("JAAL_PORT", 7773))

# AI provider (claude_cli default, codex_cli opt-in).
# During the deprecation window, fall back to the old SORTSIGHT_AI_PROVIDER
# env var so existing shells keep working. Do not add further legacy fallbacks.
AI_PROVIDER = os.environ.get(
    "JAAL_AI_PROVIDER",
    os.environ.get("SORTSIGHT_AI_PROVIDER", "claude_cli"),
).strip().lower()

AI_CLI_PATH = os.environ.get(
    "JAAL_AI_CLI_PATH",
    "claude" if AI_PROVIDER == "claude_cli" else "codex",
)
AI_MODEL = os.environ.get(
    "JAAL_AI_MODEL",
    "haiku" if AI_PROVIDER == "claude_cli" else "gpt-5.3-codex",
)
AI_TIMEOUT = int(os.environ.get("JAAL_AI_TIMEOUT", 300))
AI_REASONING_EFFORT = os.environ.get(
    "JAAL_AI_REASONING_EFFORT",
    "medium" if AI_PROVIDER == "claude_cli" else "low",
)

CACHE_DIR = os.environ.get(
    "JAAL_CACHE_DIR",
    os.path.join(os.path.dirname(__file__), ".cache"),
)

RUNS_DIR = os.environ.get(
    "JAAL_RUNS_DIR",
    os.path.join(os.path.dirname(__file__), ".runs"),
)
