"""Jaal Flask server — entry point.

Endpoint surface per phase:
  C-1  /health
  C-2  /analyze, /analyze-pagination
  C-3  /cache/*, /scrape-runs/*
  C-4  /discover-patterns
"""
from flask import Flask, jsonify, request
from flask_cors import CORS

import config
from analyzer import analyze, analyze_pagination
from logger import make_logger
from providers import provider_health

log = make_logger("server")

app = Flask(__name__)
CORS(app)


@app.route("/health", methods=["GET"])
def health():
    ai = provider_health()
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


@app.route("/analyze", methods=["POST"])
def analyze_endpoint():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Request body must be JSON"}), 400

    metadata = data.get("metadata")
    samples = data.get("samples")
    if not metadata or not samples:
        return jsonify({"error": "Missing 'metadata' or 'samples' fields"}), 400

    url = data.get("url", "")
    structural_hash = data.get("structuralHash", "")

    # TODO(C-3): check server-side cache by (url, structural_hash) before calling the provider
    log.info(
        "route_analyze",
        phase="mutate",
        url=url,
        structuralHash=structural_hash,
        sampleCount=len(samples),
    )

    try:
        result = analyze(metadata, samples)
    except Exception as e:
        log.error("route_analyze_failed", phase="error", url=url, err=str(e))
        return jsonify({"error": str(e)}), 500

    # TODO(C-3): persist result to cache

    return jsonify({**result, "cached": False})


@app.route("/analyze-pagination", methods=["POST"])
def analyze_pagination_endpoint():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Request body must be JSON"}), 400

    html = data.get("html", "")
    url = data.get("url", "")
    if not html:
        return jsonify({"error": "Missing 'html' field"}), 400

    log.info("route_analyze_pagination", phase="mutate", url=url, htmlChars=len(html))

    try:
        result = analyze_pagination(html, url)
    except Exception as e:
        log.error("route_analyze_pagination_failed", phase="error", url=url, err=str(e))
        return jsonify({"error": str(e)}), 500

    return jsonify(result)


if __name__ == "__main__":
    ai = provider_health()
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
