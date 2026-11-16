def test_cli_report_summarizes_behavioral_evals(monkeypatch):
    from io import StringIO

    from rich.console import Console

    import ltcook.cli.eval as eval_cli

    output = StringIO()
    monkeypatch.setattr(eval_cli, "console", Console(file=output, force_terminal=False))
    eval_cli._print_report(
        {
            "summary": {
                "status": "completed",
                "completed": 6,
                "total": 6,
                "preset": "behavior",
                "runId": "run-123",
            },
            "result": {
                "results": {
                    "behavior": {
                        "tasks": [
                            {"success": True, "attempts": [{}]},
                            {"success": False, "attempts": [{}, {}]},
                        ]
                    }
                }
            },
        }
    )

    rendered = output.getvalue()
    assert "Agent Evals · COMPLETED" in rendered
    assert "Behavior Evaluation" in rendered
    assert "1/2 passed" in rendered
    assert "1 retried" in rendered


def test_cli_selects_synthetic_behavior_without_workspace_resolution(monkeypatch):
    from typer.testing import CliRunner

    import ltcook.cli.eval as cli

    calls = []
    monkeypatch.setattr(cli, "_runtime", lambda: ({}, None))
    monkeypatch.setattr(
        cli,
        "_call",
        lambda environment, route, payload: (
            calls.append((route, payload)) or {"runId": "fixture"}
        ),
    )
    monkeypatch.setattr(cli, "_follow", lambda environment, run_id: None)
    result = CliRunner().invoke(
        cli.eval_cli, ["run", "--behavior-only", "--setup", "synthetic"]
    )
    assert result.exit_code == 0, result.output
    assert calls == [
        (
            "/v1/evals/start",
            {
                "preset": "behavior",
                "setup": "synthetic",
                "staticOnly": False,
                "repetitions": 1,
            },
        )
    ]


def test_cli_rejects_quick_behavior_combination_before_start(monkeypatch):
    from typer.testing import CliRunner

    import ltcook.cli.eval as cli

    def unexpected_start():
        raise AssertionError("invalid options started a runtime")

    monkeypatch.setattr(cli, "_runtime", unexpected_start)
    result = CliRunner().invoke(cli.eval_cli, ["run", "--quick", "--behavior-only"])
    assert result.exit_code == 2
    assert "cannot be combined" in result.output


def test_cli_current_setup_passes_registered_workspace(monkeypatch):
    from pathlib import Path
    from types import SimpleNamespace

    from typer.testing import CliRunner

    import ltcook.cli.eval as cli

    calls = []
    workspace = SimpleNamespace(root=Path("/registered-project"))
    manager = SimpleNamespace(
        inspect=lambda: SimpleNamespace(resolved=SimpleNamespace(workspace=workspace))
    )
    monkeypatch.setattr(cli, "APP_RC", SimpleNamespace(manage=lambda: manager))
    monkeypatch.setattr(cli, "_runtime", lambda: ({}, None))
    monkeypatch.setattr(
        cli,
        "_call",
        lambda environment, route, payload: (
            calls.append(payload) or {"runId": "fixture"}
        ),
    )
    monkeypatch.setattr(cli, "_follow", lambda environment, run_id: None)
    result = CliRunner().invoke(cli.eval_cli, ["audit", "--static-only"])
    assert result.exit_code == 0, result.output
    assert calls == [
        {
            "preset": "audit",
            "setup": "current",
            "staticOnly": True,
            "repetitions": 1,
            "workspaceRoot": "/registered-project",
        }
    ]


def test_cli_report_preserves_budget_and_error_evidence(monkeypatch):
    from io import StringIO

    from rich.console import Console

    import ltcook.cli.eval as cli

    output = StringIO()
    monkeypatch.setattr(cli, "console", Console(file=output, force_terminal=False))
    cli._print_report(
        {
            "summary": {
                "status": "failed",
                "completed": 1,
                "total": 3,
                "preset": "behavior",
                "runId": "fixture",
            },
            "result": {
                "results": {
                    "behavior": {
                        "tasks": [
                            {
                                "scenario": "read-only",
                                "success": False,
                                "elapsedMs": 1200,
                                "attempts": [
                                    {
                                        "thinking": "off",
                                        "elapsedMs": 1200,
                                        "failure": "Provider failed (500)",
                                        "budget": {
                                            "timeoutMs": 3000,
                                            "expectedMs": 1000,
                                            "referenceRuns": ["history-run"],
                                        },
                                    }
                                ],
                            }
                        ]
                    },
                    "bottlenecks": {"totalElapsedMs": 1200, "timings": {"model": 1000}},
                }
            },
        }
    )
    rendered = output.getvalue()
    assert "Provider failed (500)" in rendered
    assert "3.00s" in rendered
    assert "history-run" in rendered
    assert "Bottleneck Attribution" in rendered


def test_cli_default_run_selects_case_and_repetitions(monkeypatch):
    from typer.testing import CliRunner

    import ltcook.cli.eval as cli

    requests = []
    monkeypatch.setattr(cli, "_runtime", lambda: ({}, None))
    monkeypatch.setattr(
        cli,
        "_call",
        lambda environment, route, payload: (
            requests.append(payload) or {"runId": "fixture"}
        ),
    )
    monkeypatch.setattr(cli, "_follow", lambda environment, run_id: None)
    result = CliRunner().invoke(
        cli.eval_cli,
        ["run", "--setup", "synthetic", "--case", "read-only", "--repetitions", "2"],
    )
    assert result.exit_code == 0, result.output
    assert requests == [
        {
            "preset": "behavior",
            "setup": "synthetic",
            "staticOnly": False,
            "repetitions": 2,
            "scenario": "read-only",
        }
    ]


def test_cli_rejects_zero_repetitions_before_runtime_start(monkeypatch):
    from typer.testing import CliRunner

    import ltcook.cli.eval as cli

    monkeypatch.setattr(
        cli, "_runtime", lambda: (_ for _ in ()).throw(AssertionError("must not start"))
    )
    result = CliRunner().invoke(cli.eval_cli, ["run", "--repetitions", "0"])
    assert result.exit_code == 2


def test_cli_all_selects_combined_execution(monkeypatch):
    from typer.testing import CliRunner

    import ltcook.cli.eval as cli

    requests = []
    monkeypatch.setattr(cli, "_runtime", lambda: ({}, None))
    monkeypatch.setattr(
        cli,
        "_call",
        lambda environment, route, payload: (
            requests.append(payload) or {"runId": "fixture"}
        ),
    )
    monkeypatch.setattr(cli, "_follow", lambda environment, run_id: None)
    result = CliRunner().invoke(
        cli.eval_cli, ["run", "--all", "--setup", "synthetic", "--case", "no-op"]
    )
    assert result.exit_code == 0, result.output
    assert requests[0]["preset"] == "full"
    assert requests[0]["scenario"] == "no-op"


def test_eval_runtime_preserves_shell_provenance_on_cold_start_and_reuse(monkeypatch):
    import json
    from types import SimpleNamespace

    import ltcook.cli.eval as cli

    original = {"LTCOOK_TEAM": "default", "PATH": "/original/bin"}
    monkeypatch.setenv("LTCOOK_SHELL_PROVENANCE", json.dumps(original))
    monkeypatch.setenv("LTCOOK_TEAM", "overlay-must-not-win")
    resolved = []
    started = []
    status = object()
    monkeypatch.setattr(
        cli,
        "resolve_launch",
        lambda workspace, *, original_environment: (
            resolved.append((workspace, dict(original_environment)))
            or SimpleNamespace(
                environment={"LTCOOK_TEAM": original_environment["LTCOOK_TEAM"]}
            )
        ),
    )
    monkeypatch.setattr(cli, "probe_runtime", lambda _environment: None)
    monkeypatch.setattr(
        cli,
        "start_runtime",
        lambda environment, **kwargs: started.append(kwargs) or object(),
    )
    monkeypatch.setattr(cli, "wait_for_runtime", lambda *_args, **_kwargs: status)

    environment, actual = cli._runtime()
    assert environment["LTCOOK_TEAM"] == "default"
    assert actual is status
    assert resolved == [(None, original)]
    assert started[0]["shell_environment"] == original
    assert started[0]["workspace_root"] is None

    monkeypatch.setattr(cli, "probe_runtime", lambda _environment: status)
    environment, actual = cli._runtime()
    assert environment["LTCOOK_TEAM"] == "default"
    assert actual is status
    assert len(started) == 1
