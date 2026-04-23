"""Jaal Flask server — entry point.

Phase C-1 surface: /health only. Additional endpoints land in later phases:
  C-2  /analyze, /analyze-pagination
  C-3  /cache/*, /scrape-runs/*
  C-4  /discover-patterns
"""
from flask import Flask, jsonify
from flask_cors import CORS

import config
from ai_provider import build_provider
from logger import make_logger

log = make_logger("server")

app = Flask(__name__)
CORS(app)


def _build_configured_provider():
    return build_provider(
        provider_name=config.AI_PROVIDER,
        cli_path=config.AI_CLI_PATH,
        model=config.AI_MODEL,
        timeout=config.AI_TIMEOUT,
        reasoning_effort=config.AI_REASONING_EFFORT,
    )


def _provider_health() -> dict:
    provider = _build_configured_provider()
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


@app.route("/health", methods=["GET"])
def health():
    ai = _provider_health()
    log.info("route_health", phase="mutate", aiProvider=ai["provider"], aiReady=ai["ready"])
    return jsonify({
        "status": "ok",
        "version": config.VERSION,
        "aiProvider": ai["provider"],
        "aiReady": ai["ready"],
        "aiCliPath": ai["cliPath"],
        "aiModel": ai["model"],
        "aiReasoningEffort": ai["reasoningEffort"],
        # Placeholder counts — cache.py + scrape_runs.py arrive in Phase C-3.
        "cacheEntries": 0,
        "runEntries": 0,
    })


if __name__ == "__main__":
    ai = _provider_health()
    if ai["ready"]:
        log.info(
            "server_start",
            phase="init",
            host=config.HOST,
            port=config.PORT,
            aiProvider=ai["provider"],
            aiModel=ai["model"],
        )
    else:
        log.warn(
            "server_start_degraded",
            phase="init",
            host=config.HOST,
            port=config.PORT,
            aiProvider=ai["provider"],
            aiCliPath=ai["cliPath"],
            note="AI provider CLI not reachable; /health will return aiReady=false",
        )
    app.run(host=config.HOST, port=config.PORT, debug=True)
