import pytest


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

    monkeypatch.setenv("LTCOOK_SHELL_PROVENANCE", "{}")
    calls = []
    workspace = SimpleNamespace(root=Path("/registered-project"))
    manager = SimpleNamespace(
        inspect=lambda: SimpleNamespace(resolved=SimpleNamespace(workspace=workspace))
    )
    monkeypatch.setattr(
        cli, "APP_RC", SimpleNamespace(manage=lambda **_kwargs: manager)
    )
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


def test_current_eval_forwards_only_relevant_original_shell_overrides(monkeypatch):
    import json
    from types import SimpleNamespace

    import ltcook.cli.eval as cli

    shell = {
        "LTCOOK_TEAM": "default",
        "LTCOOK_SEARXNG_URL": "http://127.0.0.1:8123",
        "OPENAI_API_KEY": "must-not-cross-api",
        "LTCOOK_API_TOKEN": "must-not-cross-api",
    }
    monkeypatch.setenv("LTCOOK_SHELL_PROVENANCE", json.dumps(shell))
    monkeypatch.setenv("LTCOOK_TEAM", "overlaid-value")
    manager = SimpleNamespace(
        inspect=lambda: SimpleNamespace(resolved=SimpleNamespace(workspace=None))
    )
    captured_environments = []
    monkeypatch.setattr(
        cli,
        "APP_RC",
        SimpleNamespace(
            manage=lambda *, environment: (
                captured_environments.append(environment) or manager
            )
        ),
    )
    monkeypatch.setattr(cli, "_runtime", lambda: ({}, None))
    calls = []
    monkeypatch.setattr(
        cli,
        "_call",
        lambda _environment, _route, payload: (
            calls.append(payload) or {"runId": "fixture"}
        ),
    )
    monkeypatch.setattr(cli, "_follow", lambda *_args: None)
    cli._start_and_follow("behavior", setup=cli.EvalSetup.current)
    assert captured_environments == [shell]
    assert calls[0]["environmentOverrides"] == {
        "LTCOOK_TEAM": "default",
        "LTCOOK_SEARXNG_URL": "http://127.0.0.1:8123",
    }
    assert "must-not-cross-api" not in json.dumps(calls)


@pytest.mark.parametrize("verdict", ["failed", "blocked", "passed"])
def test_cli_exits_unsuccessfully_when_summarization_not_qualified(
    monkeypatch, verdict
):
    from typer.testing import CliRunner

    import ltcook.cli.eval as cli

    summary = {
        "status": "completed",
        "completed": 1,
        "total": 1,
        "preset": "full",
        "setup": "synthetic",
        "runId": "fixture",
        "summarizationQualification": verdict,
    }
    calls = []

    def call(_environment, route, payload):
        calls.append((route, payload))
        if route.endswith("/start"):
            return {"runId": "fixture"}
        if route.endswith("/status"):
            return {"summary": summary, "next": 0}
        return {
            "summary": summary,
            "result": {
                "results": {
                    "summarization": {
                        "complete": True,
                        "scope": "full",
                        "verdict": verdict,
                        "attempts": [],
                        "downstream": {
                            "verdict": "passed",
                            "cases": [
                                {
                                    "id": "rollout-decision",
                                    "expected": "HOLD",
                                    "candidate": {"decision": "HOLD"},
                                    "verdict": "passed",
                                },
                                {
                                    "id": "rollout-approval",
                                    "expected": "PROCEED",
                                    "candidate": {"decision": "PROCEED"},
                                    "verdict": "passed",
                                },
                            ],
                        },
                    }
                }
            },
        }

    monkeypatch.setattr(cli, "_runtime", lambda: ({}, None))
    monkeypatch.setattr(cli, "_call", call)
    result = CliRunner().invoke(
        cli.eval_cli,
        [
            "run",
            "--all",
            "--case",
            "summarization",
            "--setup",
            "synthetic",
            "--summarization-grader",
            "gpt-6-luna",
        ],
    )
    assert result.exit_code == (0 if verdict == "passed" else 1), result.output
    assert "Agent Evals · COMPLETED" in result.output
    assert verdict.upper() in result.output
    assert "rollout-decision · expected HOLD · returned HOLD" in result.output
    assert "rollout-approval · expected PROCEED · returned PROCEED" in result.output
    route, params = calls[0]
    assert route == "/v1/evals/start"
    assert params["preset"] == "full"
    assert params["scenario"] == "summarization"
    assert params["summarizationGrader"] == "gpt-6-luna"


def test_tracker_baseline_keeps_confirmed_failure_and_retries_one_blocked_setup(
    monkeypatch,
):
    from typer.testing import CliRunner

    import ltcook.cli.eval as cli

    calls = []
    verdicts = iter(["failed", "blocked", "passed"])

    def start(preset, **options):
        calls.append((preset, options))
        return {
            "summary": {
                "status": "completed",
                "decisionTrackerQualification": next(verdicts),
            },
        }

    monkeypatch.setattr(cli, "_start_and_follow", start)
    result = CliRunner().invoke(
        cli.eval_cli,
        ["run", "--all", "--case", "decision-tracker", "--baseline", "--retry-blocked"],
    )
    assert result.exit_code == 1
    assert "baseline · FAILED" in result.output
    assert [options["setup"].value for _, options in calls] == [
        "synthetic",
        "current",
        "current",
    ]
    assert len({options["deadline_at"] for _, options in calls}) == 1
    assert all(
        preset == "full" and options["defer_verdict"] for preset, options in calls
    )


def test_tracker_baseline_preserves_a_failure_if_another_setup_cannot_start(
    monkeypatch,
):
    import typer
    from typer.testing import CliRunner

    import ltcook.cli.eval as cli

    calls = []

    def start(_preset, **options):
        calls.append(options["setup"].value)
        if options["setup"] == cli.EvalSetup.current:
            raise typer.BadParameter("Runtime request outcome is unavailable.")
        return {
            "summary": {"status": "completed", "decisionTrackerQualification": "failed"}
        }

    monkeypatch.setattr(cli, "_start_and_follow", start)
    result = CliRunner().invoke(
        cli.eval_cli,
        ["run", "--case", "decision-tracker", "--baseline", "--retry-blocked"],
    )
    assert result.exit_code == 1
    assert "current · BLOCKED" in result.output
    assert "baseline · FAILED" in result.output
    assert calls == ["synthetic", "current"]


def test_tracker_baseline_does_not_launch_another_setup_after_deadline(monkeypatch):
    from typer.testing import CliRunner

    import ltcook.cli.eval as cli

    clock = iter([0, 1_000_000, 1_200_000_000_001])
    example_time = type("Clock", (), {"time_ns": staticmethod(lambda: next(clock))})
    monkeypatch.setattr(cli, "time", example_time)
    calls = []

    def start(preset, **options):
        calls.append((preset, options))
        return {
            "summary": {"status": "completed", "decisionTrackerQualification": "passed"}
        }

    monkeypatch.setattr(cli, "_start_and_follow", start)
    result = CliRunner().invoke(
        cli.eval_cli, ["run", "--case", "decision-tracker", "--baseline"]
    )
    assert result.exit_code == 1
    assert "current · BLOCKED" in result.output
    assert len(calls) == 1


def test_tracker_deterministic_run_marks_request_offline(monkeypatch):
    from typer.testing import CliRunner

    import ltcook.cli.eval as cli

    requests = []
    monkeypatch.setattr(cli, "_runtime", lambda: ({}, None))
    monkeypatch.setattr(
        cli,
        "_call",
        lambda _environment, _route, body: requests.append(body) or {"runId": "test"},
    )
    monkeypatch.setattr(cli, "_follow", lambda _environment, _run_id: None)
    result = CliRunner().invoke(
        cli.eval_cli,
        [
            "run",
            "--case",
            "decision-tracker",
            "--setup",
            "synthetic",
            "--deterministic-only",
        ],
    )
    assert result.exit_code == 0, result.output
    assert requests[0]["scenario"] == "decision-tracker"
    assert requests[0]["deterministicOnly"] is True
