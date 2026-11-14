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
                "sessionId": "session-1",
            },
            "events",
            (
                "2026-11-14T10:20:30.000Z",
                "INFO",
                "[events]",
                "runtime.ready",
                "sessionId=session-1",
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
                "requestId=r-2",
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


def test_pino_errors_render_type_context_and_indented_stack():
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
    }

    rendered = _console_logs._format_console_log(json.dumps(record), "paseo")

    assert "ERROR" in rendered and "request failed" in rendered
    assert "err: TypeError: bad input code=EINVAL" in rendered
    assert "\n    at handler (server.js:4)" in rendered


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
