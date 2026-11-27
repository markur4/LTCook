"""User-facing root CLI contracts."""

from __future__ import annotations

import importlib
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import apprc as rc
import pytest
from typer.main import get_command
from typer.testing import CliRunner

from ltcook.cli.app import _package_version, app

RUNNER = CliRunner()


def _skip_runtime_prepare(*_args: object, **_kwargs: object) -> None:
    """Keep help-only invocations independent of local AppRC installation state."""


@pytest.mark.parametrize("option", ["--version", "-V"])
@pytest.mark.parametrize("root_kind", ["invalid", "unowned"])
def test_version_option_exits_before_apprc_preparation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    option: str,
    root_kind: str,
) -> None:
    """Both version aliases work without resolving invalid or unowned appdata."""
    app_root = tmp_path / "app-root"
    sentinel = app_root / "unowned-data.txt"
    if root_kind == "invalid":
        app_root.write_text("not an AppRC root", encoding="utf-8")
    else:
        app_root.mkdir()
        sentinel.write_text("leave this data alone", encoding="utf-8")

    def fail_if_prepared(*_args: object, **_kwargs: object) -> None:
        pytest.fail("version must exit before CliRuntime.prepare")

    monkeypatch.setattr(rc.cli.CliRuntime, "prepare", fail_if_prepared)
    result = RUNNER.invoke(
        app,
        [
            option,
            "--layout",
            "single-root",
            "--app-root",
            str(app_root),
        ],
        color=False,
    )

    assert result.exit_code == 0, result.output
    assert result.output == f"{_package_version()}\n"
    if root_kind == "unowned":
        assert sentinel.read_text(encoding="utf-8") == "leave this data alone"
        assert sorted(path.name for path in app_root.iterdir()) == [sentinel.name]


def test_version_option_is_quiet_during_resilient_parsing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Shell completion parsing does not print the package version."""
    monkeypatch.setattr(rc.cli.CliRuntime, "prepare", _skip_runtime_prepare)
    result = RUNNER.invoke(
        app,
        ["--version"],
        color=False,
        resilient_parsing=True,
    )

    assert _package_version() not in result.output


def test_root_help_orders_panels_and_lists_host_commands(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Host commands precede AppRC panels and shared help stays last."""
    monkeypatch.setattr(rc.cli.CliRuntime, "prepare", _skip_runtime_prepare)
    result = RUNNER.invoke(app, ["--help"], color=False)

    assert result.exit_code == 0, result.output
    panel_titles = [
        "Commands",
        "Options",
        "AppRC: Commands",
        "AppRC: Runtime Options",
        "Help & Completion",
    ]
    positions = [result.output.index(title) for title in panel_titles]
    assert positions == sorted(positions)
    for command_name in ("stop", "restart", "launch", "auth", "services", "app"):
        assert command_name in result.output
    assert "--version" in result.output
    assert "-V" in result.output
    assert "Inspect and maintain the application" in result.output
    for child in ("install", "doctor", "paths"):
        assert child in result.output


def test_app_help_lists_its_immediate_commands(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """AppRC maintenance help continues to show available app children."""
    monkeypatch.setattr(rc.cli.CliRuntime, "prepare", _skip_runtime_prepare)
    result = RUNNER.invoke(app, ["app", "--help"], color=False)

    assert result.exit_code == 0, result.output
    for command_name in ("install", "doctor", "paths"):
        assert command_name in result.output


def test_restart_leaves_a_competing_runtime_running_if_initially_absent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from ltcook import _app_update
    from ltcook._app_update import InstalledBuild, Registration

    cli = importlib.import_module("ltcook.cli.app")
    launcher = tmp_path / "ltcook"
    registration = Registration(
        tmp_path, uuid4(), "registered", tmp_path, tmp_path, True
    )
    monkeypatch.setattr(rc.cli.CliRuntime, "prepare", _skip_runtime_prepare)
    monkeypatch.setattr(cli, "_registered_launcher", lambda **_: launcher)
    monkeypatch.setattr(cli, "registration", lambda *_, **__: registration)
    monkeypatch.setattr(
        cli, "read_registered_build", lambda *_: InstalledBuild("build", None)
    )
    monkeypatch.setattr(
        cli, "resolve_launch", lambda *_, **__: SimpleNamespace(environment={})
    )
    monkeypatch.setattr(cli, "probe_runtime", lambda *_: None)
    monkeypatch.setattr(
        cli,
        "stop_runtime",
        lambda *_, **__: pytest.fail("No runtime was observed to stop."),
    )
    monkeypatch.setattr(_app_update, "probe_runtime", lambda *_: "starting")

    result = RUNNER.invoke(app, ["restart"], color=False)

    assert result.exit_code == 2, result.output
    assert "Another runtime appeared after stop" in result.output


@pytest.mark.parametrize(
    ("options", "stop_status", "update_status", "recovered", "exit_code"),
    [
        ([], 0, 0, True, 19),
        (["-u"], 0, 0, True, 19),
        (["--update"], 0, 0, True, 19),
        (["-u", "-y"], 0, 0, True, 19),
        (["--update", "--yes"], 0, 0, True, 19),
        (["--update"], 7, 0, False, 7),
        (["--update"], 0, 8, True, 8),
        (["--update"], 0, 8, False, 8),
        (["--update"], 0, 0, False, 1),
    ],
)
def test_restart_reports_update_and_recovery_outcomes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    options: list[str],
    stop_status: int,
    update_status: int,
    recovered: bool,
    exit_code: int,
) -> None:
    from ltcook._app_update import InstalledBuild, Registration, RestartResult
    from ltcook._runtime_client import RuntimeStatus

    cli = importlib.import_module("ltcook.cli.app")
    launcher = tmp_path / "ltcook"
    calls: list[str] = []
    config = {"LTCOOK_RUNTIME_STATE_DIR": str(tmp_path / "state")}
    registration = Registration(
        tmp_path / "installation", uuid4(), "registered", tmp_path, tmp_path, True
    )
    verified_build = InstalledBuild("verified", None)
    owner = RuntimeStatus(
        "old", str(tmp_path), ":memory:", "127.0.0.1:6767", None, "paseo", "events"
    )
    replacement = RuntimeStatus(
        "new",
        str(tmp_path),
        ":memory:",
        "127.0.0.1:6767",
        None,
        "paseo",
        "events",
        build_fingerprint="replacement",
    )

    def stop(environment: dict[str, str], **kwargs: object) -> int:
        assert environment == config
        assert kwargs == {
            "expected_instance_id": "old",
            "expected_build_fingerprint": "verified",
        }
        calls.append("stop")
        return stop_status

    def restart(
        registered: Path,
        environment: dict[str, str],
        shell: dict[str, str],
        previous: str,
        installed: object,
        build: InstalledBuild,
        **kwargs: object,
    ) -> RestartResult:
        assert registered == launcher
        assert environment == config
        assert previous == "old"
        assert installed is registration
        assert build == verified_build
        assert kwargs == {
            "update": bool(options),
            "assume_yes": bool({"--yes", "-y"}.intersection(options)),
            "detached": True,
        }
        calls.append("restart")
        return RestartResult(
            replacement if recovered else None,
            update_status,
            "AppRC update failed." if update_status else None,
            None if recovered else "Could not start the replacement runtime.",
            "registered" if recovered else None,
        )

    def execv(command: Path, arguments: list[str]) -> None:
        assert command == launcher
        assert arguments == [str(launcher), "serve"]
        calls.append("serve")
        raise SystemExit(19)

    monkeypatch.setattr(rc.cli.CliRuntime, "prepare", _skip_runtime_prepare)
    monkeypatch.setattr(cli, "sys", SimpleNamespace(platform="linux"))
    monkeypatch.setattr(cli, "os", SimpleNamespace(execv=execv, environ={}))
    monkeypatch.setattr(cli, "_registered_launcher", lambda **_: launcher)
    monkeypatch.setattr(cli, "registration", lambda *_, **__: registration)
    monkeypatch.setattr(cli, "read_registered_build", lambda *_: verified_build)
    monkeypatch.setattr(cli, "probe_runtime", lambda *_: owner)
    monkeypatch.setattr(cli, "stop_runtime", stop)
    monkeypatch.setattr(cli, "restart_stopped_runtime", restart)
    monkeypatch.setattr(
        cli, "resolve_launch", lambda *_, **__: SimpleNamespace(environment=config)
    )

    result = RUNNER.invoke(app, ["restart", *options], color=False)

    assert result.exit_code == exit_code, result.output
    expected = ["stop"]
    if not stop_status:
        expected.append("restart")
    if recovered and not update_status:
        expected.append("serve")
    assert calls == expected
    assert ("LTCook is running again." in result.output) == (
        recovered and bool(update_status)
    )
    assert ("AppRC update failed." in result.output) == bool(update_status)
    recorded = RUNNER.invoke(app, ["restart", "--last-result", "--json"], color=False)
    assert recorded.exit_code == 0, recorded.output
    if stop_status:
        assert json.loads(recorded.output) is None
    else:
        assert json.loads(recorded.output) == {
            "build_fingerprint": "replacement" if recovered else None,
            "instance_id": "new" if recovered else None,
            "registration_revision": "registered" if recovered else None,
            "runtime_error": None
            if recovered
            else "Could not start the replacement runtime.",
            "update_error": "AppRC update failed." if update_status else None,
            "update_exit": update_status if options else None,
        }


@pytest.mark.parametrize(
    ("options", "answer", "interactive", "queued", "code"),
    [
        ([], "", False, [False], 0),
        (["-u", "-y"], "", False, [True], 0),
        (["--update", "--yes"], "", False, [True], 0),
        (["--update"], "y\n", True, [True], 0),
        (["--update"], "n\n", True, [], 1),
        (["--update"], "", False, [], 2),
        (["--yes"], "", False, [], 2),
    ],
)
def test_restart_confirms_updating_before_queueing(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    options: list[str],
    answer: str,
    interactive: bool,
    queued: list[bool],
    code: int,
) -> None:
    """The worker only receives an update request after user approval."""
    from ltcook import _idle_restart

    cli = importlib.import_module("ltcook.cli.app")
    launcher = tmp_path / "ltcook"
    calls: list[bool] = []

    def queue(
        environment: dict[str, str], registered: Path, *, update: bool
    ) -> dict[str, str]:
        assert environment == {"installation": "fixture"}
        assert registered == launcher
        calls.append(update)
        return {"state": "waiting", "message": "queued"}

    monkeypatch.setattr(rc.cli.CliRuntime, "prepare", _skip_runtime_prepare)
    monkeypatch.setattr(
        cli,
        "sys",
        SimpleNamespace(
            platform="linux", stdin=SimpleNamespace(isatty=lambda: interactive)
        ),
    )
    monkeypatch.setattr(
        cli,
        "resolve_launch",
        lambda _: SimpleNamespace(environment={"installation": "fixture"}),
    )
    monkeypatch.setattr(cli, "_registered_launcher", lambda: launcher)
    monkeypatch.setattr(cli, "stop_runtime", lambda _: pytest.fail("Unexpected stop"))
    monkeypatch.setattr(_idle_restart, "queue_restart", queue)
    result = RUNNER.invoke(
        app, ["restart", "--when-idle", "--json", *options], input=answer, color=False
    )

    assert result.exit_code == code, result.output
    assert calls == queued
    if queued:
        assert json.loads(result.stdout.splitlines()[-1])["state"] == "waiting"


def test_restart_update_on_windows_exits_before_stopping(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A background update cannot be followed by immediate startup."""
    cli = importlib.import_module("ltcook.cli.app")
    monkeypatch.setattr(rc.cli.CliRuntime, "prepare", _skip_runtime_prepare)
    monkeypatch.setattr(cli, "sys", SimpleNamespace(platform="win32"))
    monkeypatch.setattr(
        cli, "stop_runtime", lambda _: pytest.fail("Unexpected runtime stop")
    )

    result = RUNNER.invoke(app, ["restart", "--update"], color=False)

    assert result.exit_code == 2
    assert "AppRC updates finish in the background" in result.output


def test_legacy_version_subcommand_is_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Version is exposed as a root option and the former command is removed."""
    monkeypatch.setattr(rc.cli.CliRuntime, "prepare", _skip_runtime_prepare)
    command = get_command(app)
    result = RUNNER.invoke(app, ["version"], color=False)

    assert "version" not in command.commands
    assert result.exit_code != 0
    assert "No such command 'version'" in result.output


def test_main_without_arguments_still_starts_the_desktop_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The installed entry point keeps its existing bare-startup behavior."""
    cli_module = importlib.import_module("ltcook.cli.app")
    monkeypatch.setattr(cli_module, "desktop_command", lambda: 19)

    with pytest.raises(SystemExit) as exit_info:
        cli_module.main([])

    assert exit_info.value.code == 19


def test_bare_verbose_dispatches_to_desktop_verbose_mode(monkeypatch):
    cli_module = importlib.import_module("ltcook.cli.app")
    calls = []

    def desktop_command(**options):
        calls.append(options)
        return 0

    monkeypatch.setattr(cli_module, "desktop_command", desktop_command)

    with pytest.raises(SystemExit) as exit_info:
        cli_module.main(["--verbose"])

    assert exit_info.value.code == 0
    assert calls == [{"verbose": True}]


def test_root_verbose_is_documented_and_rejects_command_combinations(monkeypatch):
    monkeypatch.setattr(rc.cli.CliRuntime, "prepare", _skip_runtime_prepare)
    help_result = RUNNER.invoke(app, ["--help"], color=False)

    assert help_result.exit_code == 0
    assert "--verbose" in help_result.output
    runtime_help = RUNNER.invoke(app, ["launch", "runtime", "--help"], color=False)
    assert runtime_help.exit_code == 0, runtime_help.output
    assert "--verbose" in runtime_help.output

    cli_module = importlib.import_module("ltcook.cli.app")
    with pytest.raises(SystemExit, match="only without a command"):
        cli_module.main(["--verbose", "app", "doctor"])


@pytest.mark.parametrize(
    ("arguments", "expected"),
    [
        (["planning", "show", "--plan", "Plan-2026_11_14-18_00-example"], "--session"),
        (["planning", "approve", "--session", "session-one"], "--plan"),
        (
            ["planning", "answer", "--session", "session-one", "--plan", "plan"],
            "--decision",
        ),
    ],
)
def test_planning_requires_explicit_context(monkeypatch, arguments, expected):
    monkeypatch.setattr(rc.cli.CliRuntime, "prepare", _skip_runtime_prepare)
    result = RUNNER.invoke(app, arguments, color=False)
    assert result.exit_code != 0
    assert expected in result.output


def test_planning_answer_uses_authenticated_user_command(monkeypatch):
    module = importlib.import_module("ltcook.cli.planning")
    monkeypatch.setattr(rc.cli.CliRuntime, "prepare", _skip_runtime_prepare)
    from types import SimpleNamespace

    monkeypatch.setattr(
        module,
        "resolve_launch",
        lambda _: SimpleNamespace(environment={"owner": "configured"}),
    )
    seen = []

    def send(environment, session, command):
        seen.append((environment, session, command))
        return {"answered": True}

    monkeypatch.setattr(module, "send_runtime_command", send)
    result = RUNNER.invoke(
        app,
        [
            "planning",
            "answer",
            "--session",
            "session-one",
            "--plan",
            "Plan-2026_11_14-18_00-example",
            "--decision",
            "decision-one",
            "--answer",
            "Use clean breaking changes",
        ],
        color=False,
    )
    assert result.exit_code == 0, result.output
    assert seen == [
        (
            {"owner": "configured"},
            "session-one",
            {
                "type": "decision.answer",
                "planId": "Plan-2026_11_14-18_00-example",
                "decisionId": "decision-one",
                "answer": "Use clean breaking changes",
            },
        )
    ]


def test_planning_show_reads_current_team_document_without_versioning(
    tmp_path, monkeypatch
):
    from types import SimpleNamespace

    module = importlib.import_module("ltcook.cli.planning")
    monkeypatch.setattr(rc.cli.CliRuntime, "prepare", _skip_runtime_prepare)
    monkeypatch.setattr(
        module, "resolve_launch", lambda _: SimpleNamespace(environment={})
    )
    plan = "Plan-2026_11_14-18_00-example"
    document = tmp_path / f"{plan}.md"
    document.write_text("# Proposed Plan\n\nReview this content.\n")
    monkeypatch.setattr(
        module,
        "send_runtime_command",
        lambda *_: {
            "value": {
                "id": plan,
                "stage": "awaiting-approval",
                "plan": {"path": str(document)},
            }
        },
    )
    arguments = ["planning", "show", "--session", "session-one", "--plan", plan]
    result = RUNNER.invoke(app, arguments, color=False)
    assert result.exit_code == 0, result.output
    assert "# Proposed Plan\n\nReview this content." in result.output
    document.write_text(
        "# Proposed Plan\n\n# Implementation Report\nProgress appended.\n"
    )
    appended = RUNNER.invoke(app, arguments, color=False)
    assert appended.exit_code == 0, appended.output
    assert "Progress appended." in appended.output
    document.unlink()
    metadata = RUNNER.invoke(app, [*arguments, "--json"], color=False)
    assert metadata.exit_code == 0, metadata.output
    assert '"stage": "awaiting-approval"' in metadata.output
    unreadable = RUNNER.invoke(app, arguments, color=False)
    assert unreadable.exit_code != 0
    assert "Cannot read the registered Plan" in unreadable.output


def test_fresh_process_help_and_shared_doctor_surface() -> None:
    import subprocess
    import sys

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            """
import sys

class BlockOptionalEditors:
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".")[0] in {"textual", "prompt_toolkit"}:
            raise AssertionError(f"Help attempted to import optional editor: {fullname}")

sys.meta_path.insert(0, BlockOptionalEditors())
from ltcook.main import main
main(["--help"])
""",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert "doctor" in result.stdout
    command = get_command(app)
    assert "diagnose" not in command.commands
    uninstall = RUNNER.invoke(app, ["app", "uninstall", "--help"], color=False)
    assert uninstall.exit_code == 0, uninstall.output
    assert "--keep-config" in uninstall.output
    assert "--keep-data" not in uninstall.output
    assert "--remove-repository" in uninstall.output
    assert "--complete" not in uninstall.output


def test_shared_doctor_includes_host_metadata_without_creating_resources(tmp_path):
    root = tmp_path / "uninitialized"
    result = RUNNER.invoke(
        app,
        [
            "--layout",
            "single-root",
            "--app-root",
            str(root),
            "app",
            "doctor",
            "--verbose",
            "--json",
        ],
        color=False,
    )
    payload = json.loads(result.output)
    assert {"status", "checks", "installation"} <= payload.keys()
    assert payload["details"]["host"]["package"] == "ltcook"
    assert payload["details"]["host"]["version"] == _package_version()
    assert not root.exists()
