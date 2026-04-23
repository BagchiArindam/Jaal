"""Structured JSONL logger for the Jaal Flask server.

One log line = one JSON object on stdout + server.log, matching the schema used
across all D:\\Dev\\ projects (parsable by D:/Dev/cc-session-tools/parse-logs.py).

Usage:
    from logger import make_logger
    log = make_logger("server")
    log.info("route_hit", phase="mutate", route="/health")
    log.error("provider_failed", phase="error", provider="claude_cli", err=str(e))
"""
import json
import logging
import os
import sys
from datetime import datetime, timezone


class _JsonlFormatter(logging.Formatter):
    """Render each LogRecord as a single-line JSON object in Jaal's schema."""

    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
            "project": "jaal",
            "lang": "py",
            "phase": getattr(record, "phase", "runtime"),
            "level": record.levelname.lower(),
            "component": getattr(record, "component", record.name or "server"),
            "event": getattr(record, "event", record.getMessage()),
        }
        data = getattr(record, "data", None)
        if data:
            entry["data"] = data
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


def _install_root_handlers(log_path: str | None = None) -> None:
    """Attach JSONL handlers to the root logger exactly once."""
    root = logging.getLogger()
    if getattr(root, "_jaal_installed", False):
        return
    root.setLevel(logging.DEBUG)

    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(_JsonlFormatter())
    root.addHandler(stream)

    if log_path:
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        fh = logging.FileHandler(log_path, encoding="utf-8")
        fh.setFormatter(_JsonlFormatter())
        root.addHandler(fh)

    root._jaal_installed = True  # type: ignore[attr-defined]


class _ComponentLogger:
    """Thin wrapper exposing debug/info/warn/error with keyword data payload."""

    def __init__(self, component: str) -> None:
        self.component = component
        self._logger = logging.getLogger(component)

    def _emit(self, level: int, event: str, phase: str, data: dict) -> None:
        extra = {"component": self.component, "event": event, "phase": phase}
        if data:
            extra["data"] = data
        self._logger.log(level, event, extra=extra)

    def debug(self, event: str, *, phase: str = "runtime", **data) -> None:
        self._emit(logging.DEBUG, event, phase, data)

    def info(self, event: str, *, phase: str = "runtime", **data) -> None:
        self._emit(logging.INFO, event, phase, data)

    def warn(self, event: str, *, phase: str = "runtime", **data) -> None:
        self._emit(logging.WARNING, event, phase, data)

    warning = warn

    def error(self, event: str, *, phase: str = "error", **data) -> None:
        self._emit(logging.ERROR, event, phase, data)


def make_logger(component: str, log_path: str | None = None) -> _ComponentLogger:
    if log_path is None:
        log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.log")
    _install_root_handlers(log_path)
    return _ComponentLogger(component)
