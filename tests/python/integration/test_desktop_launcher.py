"""Real CLI lifecycle tests backed by the maintained SQLite owner fixture."""

from __future__ import annotations

import json
import os
import select
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from ltcook._runtime_client import RuntimeStatus, probe_runtime

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FIXTURE = REPOSITORY_ROOT / "tests" / "runtime" / "native" / "runtime-owner-fixture.ts"
CLI_WRAPPER = r"""
import os
from pathlib import Path
from ltcook import _browser
_browser.open_paseo_url = lambda url: Path(os.environ["LTCOOK_TEST_BROWSER_REQUESTS"]).open("a", encoding="utf-8").write(url + "\n")
from ltcook.cli.app import main
main()
"""


def _environment(tmp_path: Path) -> dict[str, str]:
    bun = shutil.which("bun") or sys.executable
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        api_port = listener.getsockname()[1]
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        paseo_port = listener.getsockname()[1]
    home = tmp_path / "home"
    deployment = tmp_path / "deployment"
    (deployment / "app" / "runtime" / "dist").mkdir(parents=True)
    native = deployment / "app" / "runtime" / "dist" / "main.js"
    native.write_text(f'import "{FIXTURE.as_uri()}";\n', encoding="utf-8")
    environment = os.environ.copy()
    for key in tuple(environment):
        if key.startswith(("LTCOOK_", "PASEO_")):
            environment.pop(key)
    environment.update(
        {
            "HOME": str(home),
            "USERPROFILE": str(home),
            "XDG_CONFIG_HOME": str(tmp_path / "config"),
            "XDG_DATA_HOME": str(tmp_path / "data"),
            "XDG_CACHE_HOME": str(tmp_path / "cache"),
            "XDG_STATE_HOME": str(tmp_path / "state"),
            "PYTHONPATH": str(REPOSITORY_ROOT / "src"),
            "LTCOOK_NODE_EXECUTABLE": bun,
            "LTCOOK_JS_ROOT": str(deployment / "app"),
            "LTCOOK_DEPLOYMENT_DIR": str(deployment),
            "LTCOOK_DATABASE": str(deployment / "coordination.sqlite"),
            "LTCOOK_TEAM": "default-minimal",
            "LTCOOK_API_LISTEN": f"127.0.0.1:{api_port}",
            "LTCOOK_API_TOKEN": "fixture-master-token",
            "LTCOOK_PASEO_LISTEN": f"127.0.0.1:{paseo_port}",
            "PASEO_HOME": str(deployment / "paseo"),
            "LTCOOK_LOGS": str(deployment / "logs" / "runtime.jsonl"),
            "LTCOOK_TEST_OWNER_EVENTS": str(tmp_path / "owner-events.jsonl"),
            "LTCOOK_TEST_BROWSER_REQUESTS": str(tmp_path / "browser-requests.txt"),
            "LTCOOK_TEST_READY_DELAY_MS": "300",
            "LTCOOK_WORKSPACE": str(tmp_path / "stale-workspace"),
            "LTCOOK_SESSION": "stale-session",
        }
    )
    return environment


def _command(*arguments: str) -> list[str]:
    return [sys.executable, "-c", CLI_WRAPPER, *arguments]


def _start_cli(environment: dict[str, str], *arguments: str) -> subprocess.Popen[str]:
    return subprocess.Popen(
        _command(*arguments),
        cwd=REPOSITORY_ROOT,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=os.name == "posix",
    )


def _wait_ready(
    environment: dict[str, str], process: subprocess.Popen[str]
) -> RuntimeStatus:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        status = probe_runtime(environment)
        if isinstance(status, RuntimeStatus):
            return status
        if process.poll() is not None:
            stdout, stderr = process.communicate(timeout=2)
            raise AssertionError(f"CLI exited {process.returncode}: {stdout}\n{stderr}")
        time.sleep(0.05)
    raise AssertionError("runtime fixture did not become ready before the deadline")


def _detach(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    if os.name == "posix":
        process.send_signal(signal.SIGINT)
    else:
        process.send_signal(signal.CTRL_C_EVENT)
    process.communicate(timeout=10)
    assert process.returncode == 130


@pytest.mark.integration
def test_help_uses_typer_without_spawning_runtime(tmp_path):
    environment = _environment(tmp_path)
    result = subprocess.run(
        _command("--help"),
        cwd=REPOSITORY_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "launch" in result.stdout
    assert not Path(environment["LTCOOK_TEST_BROWSER_REQUESTS"]).exists()
    assert not Path(environment["LTCOOK_TEST_OWNER_EVENTS"]).exists()
    assert not Path(environment["LTCOOK_DATABASE"]).exists()


def _owner_events(environment: dict[str, str]) -> list[dict[str, object]]:
    path = Path(environment["LTCOOK_TEST_OWNER_EVENTS"])
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def _wait_for_owner_events(
    environment: dict[str, str], expected_count: int
) -> list[dict[str, object]]:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        events = _owner_events(environment)
        if len(events) >= expected_count:
            return events
        time.sleep(0.05)
    raise AssertionError(f"owner event log did not reach {expected_count} records")


@pytest.mark.skipif(
    os.name != "posix", reason="Signal-based owner lifecycle needs POSIX."
)
@pytest.mark.skipif(
    shutil.which("bun") is None, reason="Bun runs the native owner fixture."
)
@pytest.mark.integration
def test_concurrent_cli_attach_detach_incremental_logs_and_explicit_stop(tmp_path):
    if not FIXTURE.is_file():
        pytest.fail(f"Maintained native owner fixture is missing: {FIXTURE}")
    environment = _environment(tmp_path)
    cleanup_environment = environment
    first = _start_cli(environment)
    second = _start_cli(environment)
    followers = [first, second]
    try:
        status = _wait_ready(environment, first)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if (
                Path(environment["LTCOOK_TEST_BROWSER_REQUESTS"]).exists()
                and len(
                    Path(environment["LTCOOK_TEST_BROWSER_REQUESTS"])
                    .read_text()
                    .splitlines()
                )
                >= 2
            ):
                break
            if second.poll() is not None:
                stdout, stderr = second.communicate(timeout=2)
                raise AssertionError(
                    f"second CLI exited {second.returncode}: {stdout}\n{stderr}"
                )
            time.sleep(0.05)
        events = _wait_for_owner_events(environment, 1)
        assert not any(event["event"] == "session-open" for event in events)
        browser_urls = (
            Path(environment["LTCOOK_TEST_BROWSER_REQUESTS"]).read_text().splitlines()
        )
        assert browser_urls == [f"http://{status.paseo_listen}/"] * 2
        for key, value in (
            ("LTCOOK_API_TOKEN", "wrong-token"),
            ("LTCOOK_TEAM", "different-team"),
            ("LTCOOK_DATABASE", str(tmp_path / "other.sqlite")),
            ("LTCOOK_DEPLOYMENT_DIR", str(tmp_path / "other-deployment")),
        ):
            mismatched = dict(environment)
            mismatched[key] = value
            result = subprocess.run(
                _command(),
                cwd=REPOSITORY_ROOT,
                env=mismatched,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            assert result.returncode == 1, result.stderr
            assert "Traceback" not in result.stderr
            assert (
                Path(environment["LTCOOK_TEST_BROWSER_REQUESTS"])
                .read_text()
                .splitlines()
                == browser_urls
            )
            assert len(_owner_events(environment)) == 1

        _detach(first)
        followers.remove(first)
        still_ready = probe_runtime(environment)
        assert isinstance(still_ready, RuntimeStatus)
        assert still_ready.instance_id == status.instance_id

        assert status.backend_log_path is not None
        sources = [
            (Path(status.backend_log_path), "runtime"),
            (Path(status.telemetry_log_path), "events"),
            (Path(status.paseo_log_path), "paseo"),
        ]
        telemetry = Path(status.telemetry_log_path)
        paseo = Path(status.paseo_log_path)
        for path in (telemetry, paseo):
            path.parent.mkdir(parents=True, exist_ok=True)
        telemetry_record = (
            b'{"timestamp":"2026-11-14T10:20:30.000Z","level":"info",'
            b'"event":"runtime.ready","sessionId":"fixture-session"}\n'
        )
        paseo_record = (
            b'{"time":1794651630000,"level":50,"msg":"request failed",'
            b'"name":"fixture-daemon","err":{"type":"TypeError",'
            b'"message":"bad input","code":"EINVAL",'
            b'"stack":"TypeError: bad input\\n    at handler (server.js:4)"}}\n'
        )
        with telemetry.open("ab") as output:
            output.write(telemetry_record[:35])
            output.flush()
            time.sleep(0.15)
            output.write(telemetry_record[35:])
        with paseo.open("ab") as output:
            output.write(paseo_record)
            output.flush()
        raw_sources = {
            telemetry: telemetry.read_bytes(),
            paseo: paseo.read_bytes(),
        }
        assert second.stdout is not None
        import select

        deadline = time.monotonic() + 5
        seen = ""
        expected = {
            "2026-11-14T10:20:30.000Z",
            "INFO",
            "[events]",
            "runtime.ready",
            "sessionId=fixture-session",
            "ERROR",
            "[paseo] [fixture-daemon]",
            "request failed",
            "TypeError: bad input",
            "code=EINVAL",
            "at handler (server.js:4)",
        }
        while time.monotonic() < deadline and not all(
            marker in seen for marker in expected
        ):
            ready, _, _ = select.select([second.stdout], [], [], 0.2)
            if ready:
                seen += os.read(second.stdout.fileno(), 4096).decode(
                    "utf-8", errors="replace"
                )
        assert all(marker in seen for marker in expected)
        assert {path: path.read_bytes() for path in raw_sources} == raw_sources
        for path, _label in sources:
            with path.open("ab") as output:
                output.write(b"attached-part")
                output.flush()
                time.sleep(0.15)
                output.write(b"ial\n")
        expected_plain = {
            "[runtime] attached-partial",
            "[events] attached-partial",
            "[paseo] attached-partial",
        }
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not all(
            marker in seen for marker in expected_plain
        ):
            ready, _, _ = select.select([second.stdout], [], [], 0.2)
            if ready:
                seen += os.read(second.stdout.fileno(), 4096).decode(
                    "utf-8", errors="replace"
                )
        assert all(marker in seen for marker in expected_plain)
        events_log = telemetry
        events_log.unlink()
        time.sleep(0.2)
        events_log.write_bytes(b"created-late\n")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and "[events] created-late" not in seen:
            ready, _, _ = select.select([second.stdout], [], [], 0.2)
            if ready:
                seen += os.read(second.stdout.fileno(), 4096).decode(
                    "utf-8", errors="replace"
                )
        assert "[events] created-late" in seen

        # > Replace and truncate an actual owner-reported source without wedging the follower.
        rotated = paseo.with_suffix(".previous")
        if paseo.exists():
            paseo.replace(rotated)
        rotated_record = (
            b'{"time":1794651630000,"level":30,"msg":"rotated after replacement"}\n'
        )
        paseo.write_bytes(rotated_record)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and "rotated after replacement" not in seen:
            ready, _, _ = select.select([second.stdout], [], [], 0.2)
            if ready:
                seen += os.read(second.stdout.fileno(), 4096).decode(
                    "utf-8", errors="replace"
                )
        assert "rotated after replacement" in seen
        paseo.write_bytes(b"short\n")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and "[paseo] short" not in seen:
            ready, _, _ = select.select([second.stdout], [], [], 0.2)
            if ready:
                seen += os.read(second.stdout.fileno(), 4096).decode(
                    "utf-8", errors="replace"
                )
        assert "[paseo] short" in seen

        stop = subprocess.run(
            _command("stop"),
            cwd=REPOSITORY_ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=35,
            check=False,
        )
        assert stop.returncode == 0, stop.stderr
        assert any(
            event["event"] == "stopped"
            for event in _wait_for_owner_events(environment, 2)
        )

        replacement_environment = dict(environment)
        replacement_environment["LTCOOK_TEAM"] = "replacement-team"
        cleanup_environment = replacement_environment
        replacement = _start_cli(replacement_environment)
        followers.append(replacement)
        replacement_status = _wait_ready(replacement_environment, replacement)
        assert replacement_status.instance_id != status.instance_id
        assert len(_wait_for_owner_events(environment, 3)) == 3
        stdout, stderr = second.communicate(timeout=10)
        followers.remove(second)
        assert second.returncode == 0, f"{stdout}\n{stderr}"
        assert (seen + stdout).count("Attached to LTCook") == 1
        _detach(replacement)
        followers.remove(replacement)
        stop = subprocess.run(
            _command("stop"),
            cwd=REPOSITORY_ROOT,
            env=replacement_environment,
            capture_output=True,
            text=True,
            timeout=35,
            check=False,
        )
        assert stop.returncode == 0, stop.stderr
    finally:
        for process in followers:
            if process.poll() is None:
                if os.name == "posix":
                    process.send_signal(signal.SIGINT)
                else:
                    process.send_signal(signal.CTRL_C_EVENT)
                try:
                    process.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate(timeout=3)
        try:
            subprocess.run(
                _command("stop"),
                cwd=REPOSITORY_ROOT,
                env=cleanup_environment,
                capture_output=True,
                text=True,
                timeout=35,
                check=False,
            )
        except subprocess.TimeoutExpired:
            pass


@pytest.mark.skipif(
    os.name != "posix", reason="Signal-based owner lifecycle needs POSIX."
)
@pytest.mark.skipif(
    shutil.which("bun") is None, reason="Bun runs the native owner fixture."
)
@pytest.mark.integration
def test_explicit_runtime_is_headless_captures_output_and_stops_on_ctrl_c(tmp_path):
    environment = _environment(tmp_path)
    process = _start_cli(environment, "launch", "runtime")
    try:
        status = _wait_ready(environment, process)
        assert status.backend_log_path is not None
        assert Path(status.backend_log_path).is_file()
        assert not Path(environment["LTCOOK_TEST_BROWSER_REQUESTS"]).exists()
        assert process.stdout is not None
        deadline = time.monotonic() + 5
        seen = ""
        while time.monotonic() < deadline and "fixture runtime ready" not in seen:
            ready, _, _ = select.select([process.stdout], [], [], 0.2)
            if ready:
                seen += os.read(process.stdout.fileno(), 4096).decode(
                    "utf-8", errors="replace"
                )
        assert "fixture runtime ready" in seen
        process.send_signal(
            signal.SIGINT if os.name == "posix" else signal.CTRL_C_EVENT
        )
        process.communicate(timeout=15)
        assert process.returncode == 130
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and probe_runtime(environment) is not None:
            time.sleep(0.1)
        assert probe_runtime(environment) is None
        events = _wait_for_owner_events(environment, 2)
        assert any(event["event"] == "stopped" for event in events)
    finally:
        if process.poll() is None:
            process.send_signal(
                signal.SIGINT if os.name == "posix" else signal.CTRL_C_EVENT
            )
            try:
                process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=3)
        subprocess.run(
            _command("stop"),
            cwd=REPOSITORY_ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=35,
            check=False,
        )
