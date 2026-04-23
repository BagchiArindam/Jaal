"""Jaal AI provider abstraction — Claude CLI (default) and Codex CLI (opt-in).

Ported verbatim from D:\\Dev\\lib-sortsight-core\\sortsight_core\\ai_provider.py.
Env-var selection happens in config.py (JAAL_AI_PROVIDER with SORTSIGHT_AI_PROVIDER
as a back-compat fallback); this module takes provider_name as a parameter.
"""
import json
import logging
import os
import subprocess
import tempfile
from dataclasses import dataclass
from typing import Protocol


class AiProvider(Protocol):
    name: str
    cli_path: str
    model: str
    timeout: int

    def check_health(self) -> bool:
        ...

    def run_json_task(self, system_prompt: str, user_message: str) -> dict:
        ...


def _strip_markdown_fences(text: str) -> str:
    out = text.strip()
    if out.startswith("```"):
        out = out.split("\n", 1)[1] if "\n" in out else out[3:]
        if out.endswith("```"):
            out = out[:-3]
    return out.strip()


def _parse_json_text(text: str, source_name: str) -> dict:
    cleaned = _strip_markdown_fences(text)
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"{source_name} returned invalid JSON: {cleaned[:300]}"
        ) from e
    if not isinstance(data, dict):
        raise RuntimeError(f"{source_name} returned non-object JSON.")
    return data


@dataclass
class ClaudeCliProvider:
    cli_path: str
    model: str
    timeout: int
    name: str = "claude_cli"

    def check_health(self) -> bool:
        try:
            r = subprocess.run(
                [self.cli_path, "--version"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            return r.returncode == 0
        except Exception:
            return False

    def run_json_task(self, system_prompt: str, user_message: str) -> dict:
        cmd = [
            self.cli_path,
            "-p",
            "--output-format",
            "json",
            "--system-prompt",
            system_prompt,
            "--model",
            self.model,
            "--tools",
            "",
            "--no-session-persistence",
        ]
        if any(m in self.model.lower() for m in ("sonnet", "opus")):
            cmd += ["--thinking", "disabled"]

        try:
            result = subprocess.run(
                cmd,
                input=user_message,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=self.timeout,
            )
        except FileNotFoundError:
            raise RuntimeError(
                f"Claude CLI not found at '{self.cli_path}'. "
                "Make sure Claude Code is installed and available."
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"Claude CLI timed out after {self.timeout}s.")

        if result.returncode != 0:
            stderr = result.stderr.strip()
            raise RuntimeError(
                f"Claude CLI exited with code {result.returncode}. "
                f"stderr: {stderr or '(none)'}"
            )

        try:
            envelope = json.loads(result.stdout)
        except json.JSONDecodeError as e:
            raise RuntimeError(
                f"Claude CLI returned non-JSON output: {result.stdout[:300]}"
            ) from e

        if envelope.get("is_error"):
            raise RuntimeError(
                f"Claude CLI reported an error: {envelope.get('result', 'unknown error')}"
            )

        return _parse_json_text(envelope.get("result", ""), "Claude CLI")


@dataclass
class CodexCliProvider:
    cli_path: str
    model: str
    timeout: int
    reasoning_effort: str
    name: str = "codex_cli"

    def check_health(self) -> bool:
        try:
            r = subprocess.run(
                [self.cli_path, "--version"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            return r.returncode == 0
        except Exception:
            return False

    def run_json_task(self, system_prompt: str, user_message: str) -> dict:
        combined_prompt = (
            f"{system_prompt}\n\n"
            "Task:\n"
            f"{user_message}\n\n"
            "Return only valid JSON with no markdown fences."
        )

        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", delete=False, suffix=".txt"
        ) as out_file:
            output_path = out_file.name

        cmd = [
            self.cli_path,
            "exec",
            "--skip-git-repo-check",
            "--ephemeral",
            "--color",
            "never",
            "--output-last-message",
            output_path,
            "--model",
            self.model,
            "-c",
            f'model_reasoning_effort="{self.reasoning_effort}"',
            "-s",
            "read-only",
            combined_prompt,
        ]

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=self.timeout,
            )
        except FileNotFoundError:
            raise RuntimeError(
                f"Codex CLI not found at '{self.cli_path}'. "
                "Make sure Codex CLI is installed and available."
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"Codex CLI timed out after {self.timeout}s.")
        finally:
            pass

        if result.returncode != 0:
            stderr = result.stderr.strip()
            raise RuntimeError(
                f"Codex CLI exited with code {result.returncode}. "
                f"stderr: {stderr or '(none)'}"
            )

        try:
            with open(output_path, encoding="utf-8") as f:
                message_text = f.read()
        except Exception as e:
            raise RuntimeError("Codex CLI completed but final message could not be read.") from e
        finally:
            try:
                os.remove(output_path)
            except OSError:
                pass

        return _parse_json_text(message_text, "Codex CLI")


def build_provider(
    provider_name: str,
    cli_path: str,
    model: str,
    timeout: int,
    reasoning_effort: str,
) -> AiProvider:
    normalized = (provider_name or "").strip().lower()
    if normalized == "codex_cli":
        return CodexCliProvider(
            cli_path=cli_path,
            model=model,
            timeout=timeout,
            reasoning_effort=reasoning_effort,
        )
    if normalized != "claude_cli":
        logging.warning(
            "Unknown AI provider '%s', falling back to claude_cli.",
            provider_name,
        )
    return ClaudeCliProvider(cli_path=cli_path, model=model, timeout=timeout)
