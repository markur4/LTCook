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


def _format_console_log(line: str, source: str) -> str:
    """Render known telemetry/Pino rows, retaining unfamiliar output verbatim.

    :param line: One decoded record, without its terminating newline.
    :param source: The original runtime, events, or paseo stream label.
    :return: Terminal-only text; the captured source is never rewritten.
    """
    fallback = f"[{source}] {line}"
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
    if isinstance(record.get("pid"), int) and not isinstance(record["pid"], bool):
        consumed.add("pid")
    if isinstance(record.get("hostname"), str):
        consumed.add("hostname")
    details = []
    for field in ("err", "error", "stack"):
        if field in record:
            consumed.add(field)
            details.extend(_error_lines(field, record[field]))
    context = " ".join(
        f"{field}={_context_value(value)}"
        for field, value in record.items()
        if field not in consumed
    )
    level_column = f"{severity:<8}"
    if (
        sys.stdout.isatty()
        and "NO_COLOR" not in os.environ
        and os.environ.get("TERM") != "dumb"
    ):
        level_column = f"\033[{_COLORS[severity]}m{level_column}\033[0m"
    component_column = f" [{'/'.join(components)}]" if components else ""
    message_lines = message.splitlines() or [""]
    heading = (
        f"{timestamp} {level_column} [{source}]{component_column} {message_lines[0]}"
    )
    if context:
        heading += f" {context}"
    return "\n".join([heading, *(f"  {part}" for part in message_lines[1:]), *details])
