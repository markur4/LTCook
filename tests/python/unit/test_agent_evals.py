from ltcook_dev.agent_evals.evaluation import DATASET


def test_evals_dataset_uses_objective_oracle_cases():
    assert DATASET.name == "ltcook-agent-evals-v1"
    assert [case.name for case in DATASET.cases] == [
        "read-only",
        "no-op",
        "targeted-fix",
    ]


def test_evals_evaluator_reports_oracle_failures():
    report = DATASET.evaluate_sync(
        lambda inputs: {"oracle_passed": inputs["kind"] != "read-only"},
        progress=False,
    )

    assert report.cases[0].assertions["_success"].value is False
    assert report.cases[1].assertions["_success"].value is True
    assert report.cases[2].assertions["_success"].value is True


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
            {"preset": "behavior", "setup": "synthetic", "staticOnly": False},
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
