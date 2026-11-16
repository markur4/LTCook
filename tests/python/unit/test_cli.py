"""User-facing root CLI contracts."""

from __future__ import annotations

import importlib
from pathlib import Path

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
    for command_name in ("stop", "launch", "auth", "services", "app"):
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
    assert "--keep-data" in uninstall.output
    assert "--remove-repository" in uninstall.output
    assert "--complete" not in uninstall.output


def test_shared_doctor_includes_host_metadata_without_creating_resources(tmp_path):
    import json

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
