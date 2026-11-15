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


def test_cli_quick_report_skips_empty_comparison_arm(monkeypatch):
    from io import StringIO

    from rich.console import Console

    import ltcook.cli.eval as cli

    output = StringIO()
    monkeypatch.setattr(cli, "console", Console(file=output, force_terminal=False))
    cli._print_report(
        {
            "summary": {
                "status": "completed",
                "completed": 2,
                "total": 2,
                "preset": "quick",
                "runId": "fixture",
            },
            "result": {
                "results": {
                    "behavior": {
                        "tasks": [{"success": True, "elapsedMs": 1200}],
                        "aggregates": [
                            {
                                "arm": "minimal",
                                "tasks": 0,
                                "meanTotalElapsedMs": None,
                                "minElapsedMs": None,
                                "maxElapsedMs": None,
                            },
                            {
                                "arm": "complete",
                                "tasks": 1,
                                "meanTotalElapsedMs": 1200,
                                "minElapsedMs": 1200,
                                "maxElapsedMs": 1200,
                            },
                        ],
                    }
                }
            },
        }
    )
    assert "mean 1.20s" in output.getvalue()
    assert "minimal" not in output.getvalue()


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
