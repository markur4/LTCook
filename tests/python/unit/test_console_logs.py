"""Terminal log presentation keeps structured records readable and lossless."""

import io
import json
from types import SimpleNamespace

import pytest

from ltcook import _console_logs
from ltcook._runtime_client import _LogFollower


@pytest.mark.parametrize(
    ("record", "source", "parts"),
    [
        (
            {
                "timestamp": "2026-11-14T10:20:30.000Z",
                "level": "info",
                "event": "runtime.ready",
                "workspace": "workspace-alpha",
                "sessionId": "session-1",
            },
            "events",
            (
                "2026-11-14T10:20:30.000Z",
                "INFO",
                "[events]",
                "runtime.ready",
                "workspace=workspace-alpha",
                "details in log",
            ),
        ),
        (
            {
                "time": 1794651630000,
                "level": 40,
                "msg": "request failed",
                "name": "http-server",
                "module": "api",
                "pid": 47,
                "hostname": "host",
                "requestId": "r-2",
            },
            "paseo",
            (
                "2026-11-14T10:20:30.000Z",
                "WARN",
                "[paseo]",
                "[http-server/api]",
                "request failed",
                "details in log",
            ),
        ),
    ],
)
def test_known_structured_records_render_columns_and_context(record, source, parts):
    rendered = _console_logs._format_console_log(json.dumps(record), source)
    for part in parts:
        assert part in rendered
    assert "pid=" not in rendered
    assert "hostname=" not in rendered


def test_pino_errors_keep_actionable_summary_and_verbose_stack():
    record = {
        "time": "2026-11-14T10:20:30.000Z",
        "level": 50,
        "msg": "request failed",
        "err": {
            "type": "TypeError",
            "message": "bad input",
            "code": "EINVAL",
            "stack": "TypeError: bad input\n    at handler (server.js:4)",
        },
        "clientId": "synthetic-client",
    }

    rendered = _console_logs._format_console_log(json.dumps(record), "paseo")
    verbose = _console_logs._format_console_log(
        json.dumps(record), "paseo", verbose=True
    )

    assert "ERROR" in rendered and "request failed" in rendered
    assert "TypeError: bad input" in rendered and "code=EINVAL" in rendered
    assert "at handler" not in rendered and "synthetic-client" not in rendered
    assert "at handler (server.js:4)" in verbose
    assert "synthetic-client" in verbose


@pytest.mark.parametrize(
    "message",
    [
        "Client connected; awaiting hello",
        "Client socket disconnected; session remains attached",
        "ws_runtime_metrics",
    ],
)
def test_routine_upstream_diagnostics_require_verbose_mode(message):
    record = {
        "time": 1794651630000,
        "level": 30,
        "msg": message,
        "connectionId": "synthetic-connection",
        "client": {"session": "synthetic-session", "metrics": [1] * 500},
    }

    assert _console_logs._format_console_log(json.dumps(record), "paseo") is None
    verbose = _console_logs._format_console_log(
        json.dumps(record), "paseo", verbose=True
    )
    assert message in verbose
    assert "synthetic-connection" in verbose
    assert "metrics" in verbose


def test_slow_request_warning_keeps_only_actionable_scalar_context():
    record = {
        "level": "warn",
        "event": "slow request",
        "requestType": "websocket",
        "durationMs": 12000,
        "clientId": "synthetic-client",
        "browserFingerprint": "synthetic-browser",
        "payload": {"items": [1, 2, 3]},
    }
    rendered = _console_logs._format_console_log(json.dumps(record), "paseo")

    assert "WARN" in rendered and "requestType=websocket" in rendered
    assert "durationMs=12000" in rendered
    assert "synthetic-client" not in rendered
    assert "synthetic-browser" not in rendered and "items" not in rendered
    assert "details in log" in rendered


def test_oversized_recognized_error_is_visible_and_bounded():
    record = {
        "level": 50,
        "msg": "failed",
        "err": {"type": "NetworkError", "message": "x" * 3000, "code": "ECONNRESET"},
    }
    rendered = _console_logs._format_console_log(json.dumps(record), "paseo")

    assert rendered is not None and "ERROR" in rendered
    assert "NetworkError" in rendered and "ECONNRESET" in rendered
    assert "details in log" in rendered and len(rendered) < 1000


def test_missing_optional_metadata_and_established_level_strings_render():
    rendered = _console_logs._format_console_log(
        '{"time":1794651630000,"level":"warning","message":"slow"}', "runtime"
    )

    assert "WARN" in rendered and "[runtime]" in rendered and "slow" in rendered
    assert "[None]" not in rendered


@pytest.mark.parametrize(
    "line",
    [
        "ordinary output",
        "{broken json",
        "[1, 2]",
        '{"event":"without severity"}',
        '{"time":"not a timestamp","level":30,"msg":"invalid shape"}',
        '{"time":1,"level":30,"msg":{"nested":"not a message"}}',
    ],
)
def test_unrecognized_or_invalid_records_remain_verbatim(line):
    assert _console_logs._format_console_log(line, "events") == f"[events] {line}"


def test_follower_formats_complete_lines_and_final_fragment_without_rewriting_file(
    tmp_path, monkeypatch
):
    raw = b'{"timestamp":"2026-11-14T10:20:30Z","level":"info","event":"complete"}\n'
    fragment = b'{"time":1794651630000,"level":30,"msg":"final"}'
    path = tmp_path / "events.jsonl"
    path.write_bytes(raw + fragment)
    follower = _LogFollower(path, "events")
    follower.offset = 0
    output = io.StringIO()
    monkeypatch.setattr("sys.stdout", output)
    follower.read()

    follower._emit("", final=True)

    assert "INFO" in output.getvalue() and "complete" in output.getvalue()
    assert (
        "final" in output.getvalue() and "2026-11-14T10:20:30.000Z" in output.getvalue()
    )
    assert path.read_bytes() == raw + fragment
    follower.close()


def test_follower_suppresses_routine_final_fragment_without_blank_output(
    tmp_path, monkeypatch
):
    path = tmp_path / "paseo.jsonl"
    path.write_text('{"level":30,"msg":"websocket connected"}', encoding="utf-8")
    follower = _LogFollower(path, "paseo")
    follower.offset = 0
    output = io.StringIO()
    monkeypatch.setattr("sys.stdout", output)

    follower.read()
    follower._emit("", final=True)

    assert output.getvalue() == ""
    follower.close()


@pytest.mark.parametrize(
    ("is_tty", "no_color", "term", "colored"),
    [
        (True, False, "xterm-256color", True),
        (False, False, "xterm-256color", False),
        (True, True, "xterm-256color", False),
        (True, False, "dumb", False),
    ],
)
def test_severity_color_obeys_tty_and_terminal_environment(
    monkeypatch, is_tty, no_color, term, colored
):
    monkeypatch.setattr(
        _console_logs.sys, "stdout", SimpleNamespace(isatty=lambda: is_tty)
    )
    monkeypatch.setenv("TERM", term)
    if no_color:
        monkeypatch.setenv("NO_COLOR", "")
    else:
        monkeypatch.delenv("NO_COLOR", raising=False)

    rendered = _console_logs._format_console_log(
        '{"level":"error","event":"failed"}', "events"
    )

    assert ("\033[" in rendered) is colored
    assert "ERROR" in rendered
