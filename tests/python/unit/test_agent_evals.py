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
    assert "Behavioral Evals" in rendered
    assert "1/2 passed" in rendered
    assert "1 retried" in rendered
