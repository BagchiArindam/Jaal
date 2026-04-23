"""Process-wide AI provider — constructed once, reused by any module that asks.

Consolidates the build_provider() call so server.py and analyzer.py share one
instance and don't each carry their own config-reading boilerplate.
"""
from functools import lru_cache

import config
from ai_provider import AiProvider, build_provider
from logger import make_logger

log = make_logger("providers")


@lru_cache(maxsize=1)
def get_provider() -> AiProvider:
    provider = build_provider(
        provider_name=config.AI_PROVIDER,
        cli_path=config.AI_CLI_PATH,
        model=config.AI_MODEL,
        timeout=config.AI_TIMEOUT,
        reasoning_effort=config.AI_REASONING_EFFORT,
    )
    log.info(
        "provider_built",
        phase="init",
        provider=provider.name,
        cliPath=provider.cli_path,
        model=provider.model,
        timeout=provider.timeout,
    )
    return provider


def provider_health() -> dict:
    provider = get_provider()
    try:
        ready = provider.check_health()
    except Exception as e:
        log.error("provider_health_failed", phase="error", provider=provider.name, err=str(e))
        ready = False
    return {
        "provider": provider.name,
        "ready": ready,
        "cliPath": provider.cli_path,
        "model": provider.model,
        "timeout": provider.timeout,
        "reasoningEffort": getattr(provider, "reasoning_effort", None),
    }
