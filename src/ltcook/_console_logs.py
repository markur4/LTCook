"""Human presentation of captured runtime records without changing their storage."""

from __future__ import annotations

import json
import math
import os
import sys
from datetime import UTC, datetime

_LEVELS = {
    "trace": "TRACE",
    "debug": "DEBUG",
    "info": "INFO",
    "warn": "WARN",
    "warning": "WARN",
    "error": "ERROR",
    "fatal": "FATAL",
    "critical": "CRITICAL",
}
_PINO_LEVELS = {
    10: "TRACE",
    20: "DEBUG",
    30: "INFO",
    40: "WARN",
    50: "ERROR",
    60: "FATAL",
}
_COLORS = {
    "TRACE": "90",
    "DEBUG": "36",
    "INFO": "32",
    "WARN": "33",
    "ERROR": "31",
    "FATAL": "1;31",
    "CRITICAL": "1;31",
}

_ACTIONABLE_FIELDS = (
    "requestType",
    "durationMs",
    "code",
    "reason",
    "operation",
    "path",
    "team",
    "workspace",
)
_DETAILS = " [details in log; use --verbose]"


def _bounded_text(value: str, limit: int) -> str:
    """Keep normal terminal diagnostics on one bounded line."""
    text = " ".join(value.split())
    return text if len(text) <= limit else text[:limit] + "…" + _DETAILS


def _normal_error(key: str, value: object) -> str:
    """Retain actionable error identity without expanding stacks or payloads."""
    if isinstance(value, dict):
        kind = value.get("type") or value.get("name")
        parts = [
            _bounded_text(part, 180)
            for part in (kind, value.get("message"))
            if isinstance(part, str) and part
        ]
        code = value.get("code")
        if isinstance(code, (str, int, float, bool)):
            parts.append(f"code={_context_value(_bounded_text(str(code), 80))}")
        summary = ": ".join(parts[:2])
        if len(parts) > 2:
            summary += " " + parts[2]
        return f"  {key}: {summary or 'see log'}"
    if isinstance(value, str):
        return f"  {key}: {_bounded_text(value, 240)}"
    return f"  {key}: see log"


def _severity(value: object) -> str | None:
    if isinstance(value, str):
        return _LEVELS.get(value.lower())
    if isinstance(value, int) and not isinstance(value, bool):
        return _PINO_LEVELS.get(value)
    return None


def _timestamp(value: object) -> str | None:
    try:
        if isinstance(value, str) and ("T" in value or " " in value):
            moment = datetime.fromisoformat(value)
        elif (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
        ):
            moment = datetime.fromtimestamp(value / 1000, UTC)
        else:
            return None
    except (ValueError, OverflowError, OSError):
        return None
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _context_value(value: object) -> str:
    if (
        isinstance(value, str)
        and value
        and not any(
            character.isspace() or character in '="\\{}[],' for character in value
        )
    ):
        return value
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _error_lines(key: str, value: object) -> list[str]:
    if isinstance(value, str):
        return [f"  {key}: {line}" for line in value.splitlines() or [""]]
    if not isinstance(value, dict):
        return [f"  {key}={_context_value(value)}"]
    consumed: set[str] = set()
    kind = ""
    for field in ("type", "name"):
        if isinstance(value.get(field), str):
            if not kind:
                kind = value[field]
                consumed.add(field)
            elif value[field] == kind:
                consumed.add(field)
    message = value.get("message")
    summary = kind
    if isinstance(message, str):
        summary = f"{kind}: {message}" if kind else message
        consumed.add("message")
    stack = value.get("stack")
    if isinstance(stack, str):
        consumed.add("stack")
    cause = value.get("cause")
    if isinstance(cause, (dict, str)):
        consumed.add("cause")
    context = " ".join(
        f"{field}={_context_value(child)}"
        for field, child in value.items()
        if field not in consumed
    )
    heading = " ".join(part for part in (summary, context) if part)
    lines = [f"  {key}: {line}" for line in heading.splitlines() or ["{}"]]
    if isinstance(stack, str):
        stack_lines = stack.splitlines()
        if stack_lines and stack_lines[0] == summary:
            stack_lines = stack_lines[1:]
        lines.extend(f"    {line}" for line in stack_lines)
    if isinstance(cause, (dict, str)):
        lines.extend(f"  {line}" for line in _error_lines("cause", cause))
    return lines


def _format_console_log(line: str, source: str, *, verbose: bool = False) -> str | None:
    """Render concise normal output or complete diagnostic records.

    :param line: One decoded record, without its terminating newline.
    :param source: The original runtime, events, or paseo stream label.
    :param verbose: Include upstream INFO, trace/debug, context, and error stacks.
    :return: Terminal-only text, or None for a routine recognized record.
    """
    fallback = f"[{source}] {line if verbose else _bounded_text(line, 800)}"
    if not line.lstrip().startswith("{"):
        return fallback
    try:
        record = json.loads(line)
    except (json.JSONDecodeError, RecursionError):
        return fallback
    if not isinstance(record, dict):
        return fallback
    severity = _severity(record.get("level"))
    if severity is None:
        return fallback
    message_fields = ("msg", "message", "event")
    if any(
        field in record and not isinstance(record[field], str)
        for field in (*message_fields, "component", "module", "name")
    ):
        return fallback
    message_key = next((field for field in message_fields if record.get(field)), None)
    if message_key is None:
        return fallback
    message = record[message_key]
    consumed = {"level", message_key}
    timestamp = "-"
    for field in ("timestamp", "time"):
        if field in record:
            rendered = _timestamp(record[field])
            if rendered is None:
                return fallback
            if timestamp == "-":
                timestamp = rendered
                consumed.add(field)
            elif rendered == timestamp:
                consumed.add(field)
    for field in message_fields:
        if record.get(field) == message:
            consumed.add(field)
    components = []
    for field in ("name", "component", "module"):
        component = record.get(field)
        if isinstance(component, str):
            consumed.add(field)
            if component and component not in components:
                components.append(component)
    if not verbose:
        for field in ("pid", "hostname"):
            if field in record:
                consumed.add(field)

    has_error = any(field in record for field in ("err", "error", "stack"))
    if (
        not verbose
        and not has_error
        and (
            severity in {"TRACE", "DEBUG"}
            or (severity == "INFO" and source not in {"runtime", "events"})
        )
    ):
        return None

    details = []
    for field in ("err", "error", "stack"):
        if field in record:
            consumed.add(field)
            if verbose:
                details.extend(_error_lines(field, record[field]))
            elif field != "stack":
                details.append(_normal_error(field, record[field]))
    if verbose:
        context = " ".join(
            f"{field}={_context_value(value)}"
            for field, value in record.items()
            if field not in consumed
        )
    else:
        context_parts = []
        for field in _ACTIONABLE_FIELDS:
            value = record.get(field)
            if field not in consumed and isinstance(value, (str, int, float, bool)):
                if len(context_parts) == 6:
                    break
                consumed.add(field)
                rendered = _bounded_text(str(value), 100)
                context_parts.append(f"{field}={_context_value(rendered)}")
        context = " ".join(context_parts)
        if has_error or any(field not in consumed for field in record):
            context += _DETAILS

    level_column = f"{severity:<8}"
    if (
        sys.stdout.isatty()
        and "NO_COLOR" not in os.environ
        and os.environ.get("TERM") != "dumb"
    ):
        level_column = f"\033[{_COLORS[severity]}m{level_column}\033[0m"
    component = "/".join(components)
    component_column = (
        f" [{component if verbose else _bounded_text(component, 100)}]"
        if component
        else ""
    )
    message_lines = (
        message.splitlines() or [""] if verbose else [_bounded_text(message, 400)]
    )
    heading = (
        f"{timestamp} {level_column} [{source}]{component_column} {message_lines[0]}"
    )
    if context:
        heading += f" {context}"
    return "\n".join([heading, *(f"  {part}" for part in message_lines[1:]), *details])
