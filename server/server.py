"""Jaal Flask server — entry point.

Endpoint surface per phase:
  C-1  /health
  C-2  /analyze, /analyze-pagination
  C-3  /cache/*, /scrape-runs/*
  C-4  /discover-patterns
"""
import os

from flask import Flask, jsonify, request
from flask_cors import CORS

import cache
import config
import scrape_runs
from analyzer import analyze, analyze_pagination
from logger import make_logger
from providers import provider_health

log = make_logger("server")

app = Flask(__name__)
CORS(app)


@app.route("/health", methods=["GET"])
def health():
    ai = provider_health()
    cache_entries = len(cache.list_entries())
    run_entries = len(scrape_runs.list_entries())
    log.info(
        "route_health",
        phase="mutate",
        aiProvider=ai["provider"],
        aiReady=ai["ready"],
        cacheEntries=cache_entries,
        runEntries=run_entries,
    )
    return jsonify({
        "status": "ok",
        "version": config.VERSION,
        "aiProvider": ai["provider"],
        "aiReady": ai["ready"],
        "aiCliPath": ai["cliPath"],
        "aiModel": ai["model"],
        "aiReasoningEffort": ai["reasoningEffort"],
        "cacheEntries": cache_entries,
        "runEntries": run_entries,
    })


# ─── /analyze ──────────────────────────────────────────────────────────────

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

    if url and structural_hash:
        cached = cache.get(url, structural_hash)
        if cached is not None:
            log.info("route_analyze_cache_hit", phase="mutate", url=url, hash=structural_hash)
            return jsonify({**cached, "cached": True})

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

    if url and structural_hash:
        cache.put(url, structural_hash, result, metadata)

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


# ─── /cache/* ──────────────────────────────────────────────────────────────

@app.route("/cache/check", methods=["GET"])
def cache_check():
    url = request.args.get("url", "")
    structural_hash = request.args.get("hash", "")
    if not url or not structural_hash:
        return jsonify({"error": "Missing 'url' or 'hash' query params"}), 400
    analysis = cache.get(url, structural_hash)
    if analysis is not None:
        return jsonify({"hit": True, "analysis": analysis})
    return jsonify({"hit": False})


@app.route("/cache/list", methods=["GET"])
def cache_list():
    return jsonify(cache.list_entries())


@app.route("/cache/<path:filename>", methods=["DELETE"])
def cache_delete(filename):
    # Defensive: never resolve outside CACHE_DIR
    path = os.path.join(config.CACHE_DIR, filename)
    resolved = os.path.realpath(path)
    cache_root = os.path.realpath(config.CACHE_DIR)
    if not resolved.startswith(cache_root + os.sep) and resolved != cache_root:
        return jsonify({"error": "invalid path"}), 400
    if not resolved.endswith(".json") or not os.path.exists(resolved):
        return jsonify({"deleted": False}), 404
    try:
        os.remove(resolved)
        log.info("route_cache_delete", phase="mutate", filename=filename)
        return jsonify({"deleted": True})
    except Exception as e:
        log.error("route_cache_delete_failed", phase="error", filename=filename, err=str(e))
        return jsonify({"error": str(e)}), 500


@app.route("/cache/by-url", methods=["DELETE"])
def cache_delete_by_url():
    url = request.args.get("url", "")
    if not url:
        return jsonify({"error": "Missing 'url' query param"}), 400
    count = cache.delete_by_url(url)
    return jsonify({"deleted": count})


@app.route("/cache", methods=["DELETE"])
def cache_clear_all():
    count = cache.clear()
    return jsonify({"cleared": count})


# ─── /scrape-runs/* ────────────────────────────────────────────────────────

@app.route("/scrape-runs/latest", methods=["GET"])
def scrape_latest():
    site_key = request.args.get("siteKey", "")
    config_hash = request.args.get("configHash", "") or None
    if not site_key:
        return jsonify({"error": "Missing 'siteKey' query param"}), 400
    return jsonify({"run": scrape_runs.get_latest(site_key, config_hash)})


@app.route("/scrape-runs/start", methods=["POST"])
def scrape_start():
    data = request.get_json(silent=True) or {}
    site_key = data.get("siteKey", "")
    cfg = data.get("config")
    resume_run_id = data.get("resumeRunId")
    if not site_key or not isinstance(cfg, dict):
        return jsonify({"error": "Missing 'siteKey' or invalid 'config'"}), 400
    try:
        return jsonify(scrape_runs.start_run(site_key, cfg, resume_run_id))
    except FileNotFoundError:
        return jsonify({"error": f"Run not found: {resume_run_id}"}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        log.error("route_scrape_start_failed", phase="error", siteKey=site_key, err=str(e))
        return jsonify({"error": str(e)}), 500


@app.route("/scrape-runs/<run_id>/checkpoint", methods=["POST"])
def scrape_checkpoint_route(run_id):
    data = request.get_json(silent=True) or {}
    rows = data.get("rows", [])
    checkpoint_data = data.get("checkpoint", {})
    if not isinstance(rows, list):
        return jsonify({"error": "'rows' must be an array"}), 400
    if not isinstance(checkpoint_data, dict):
        return jsonify({"error": "'checkpoint' must be an object"}), 400
    try:
        return jsonify(scrape_runs.checkpoint(run_id, rows, checkpoint_data))
    except FileNotFoundError:
        return jsonify({"error": f"Run not found: {run_id}"}), 404
    except Exception as e:
        log.error("route_scrape_checkpoint_failed", phase="error", runId=run_id, err=str(e))
        return jsonify({"error": str(e)}), 500


@app.route("/scrape-runs/<run_id>/complete", methods=["POST"])
def scrape_complete_route(run_id):
    data = request.get_json(silent=True) or {}
    summary = data.get("summary", {})
    if not isinstance(summary, dict):
        return jsonify({"error": "'summary' must be an object"}), 400
    try:
        return jsonify(scrape_runs.complete(run_id, summary))
    except FileNotFoundError:
        return jsonify({"error": f"Run not found: {run_id}"}), 404
    except Exception as e:
        log.error("route_scrape_complete_failed", phase="error", runId=run_id, err=str(e))
        return jsonify({"error": str(e)}), 500


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
