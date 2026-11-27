"""User-facing Agent Evals diagnostics commands backed by the shared runtime service."""

from __future__ import annotations

import json
import os
import time
import urllib.error
from enum import StrEnum
from typing import Annotated

import typer
from rich.console import Console
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TextColumn,
    TimeElapsedColumn,
)
from rich.table import Table

from ltcook._runtime_client import (
    RuntimeClientError,
    open_runtime_request,
    probe_runtime,
    redact_runtime_token,
    start_runtime,
    wait_for_runtime,
)
from ltcook.config.app import APP_RC
from ltcook.launch import _shell_environment, resolve_launch

eval_cli = typer.Typer(help="Run and inspect Agent Evals.", no_args_is_help=True)
console = Console()


EVAL_LABELS = {
    "static": "Instruction Audit · static",
    "semantic": "Instruction Audit · semantic",
    "behavior": "Behavior Evaluation",
    "bottlenecks": "Bottleneck Attribution",
    "summarization": "Summarization evaluations",
    "decision-tracker": "Hosted Decision Tracker",
}
EVAL_LABELS.update(
    {
        "instruction-static": "Instruction Audit · static",
        "instruction-semantic": "Instruction Audit · semantic",
        "preparation": "Preparing",
    }
)

# > Only non-secret settings consumed by Current Setup cross the local API.
_EVALUATION_ENVIRONMENT_KEYS = (
    "LTCOOK_TEAM",
    "LTCOOK_GUIDANCE_DIR",
    "LTCOOK_SEARXNG_URL",
    "LTCOOK_CRAWL4AI_URL",
    "LTCOOK_SSRF_ALLOW_RANGES",
)


class EvalCase(StrEnum):
    read_only = "read-only"
    no_op = "no-op"
    targeted_fix = "targeted-fix"
    summarization = "summarization"
    decision_tracker = "decision-tracker"


class EvalSetup(StrEnum):
    current = "current"
    synthetic = "synthetic"


class SummarizationGrader(StrEnum):
    luna = "gpt-6-luna"


def _runtime():
    shell = _shell_environment(os.environ)
    launch = resolve_launch(None, original_environment=shell)
    status = probe_runtime(launch.environment)
    child = None
    if status is None:
        child = start_runtime(
            launch.environment,
            workspace_root=None,
            shell_environment=shell,
            detached=True,
        )
        status = wait_for_runtime(launch.environment, child)
    elif status == "starting":
        status = wait_for_runtime(launch.environment, None)
    return launch.environment, status


def _call(environment, route: str, payload: object = None):
    try:
        with open_runtime_request(
            environment, route, payload or {}, timeout=30
        ) as response:
            return json.loads(response.read().decode())
    except (
        OSError,
        urllib.error.URLError,
        urllib.error.HTTPError,
        ValueError,
    ) as error:
        raise RuntimeClientError(
            redact_runtime_token(
                f"Agent Evals runtime request failed: {error}", environment
            )
        ) from None


def _follow(environment, run_id: str, *, defer_verdict: bool = False) -> dict:
    cursor = 0
    with Progress(
        SpinnerColumn(),
        TextColumn("{task.description}"),
        BarColumn(),
        "{task.completed}/{task.total}",
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("Preparing Agent Evals suites", total=1)
        while True:
            status = _call(
                environment, "/v1/evals/status", {"runId": run_id, "after": cursor}
            )
            summary = status["summary"]
            progress.update(
                task,
                description=f"{EVAL_LABELS.get(summary.get('currentSuite'), 'Preparing')} · {summary.get('currentCase', summary['status'])}",
                total=max(1, summary["total"]),
                completed=summary["completed"],
            )
            cursor = status["next"]
            if summary["status"] != "running":
                break
            time.sleep(1)
    report = _call(environment, "/v1/evals/report", {"runId": run_id})
    _print_report(report)
    if not defer_verdict and _run_verdict(report) != "passed":
        raise typer.Exit(1)
    return report


def _run_verdict(report: dict) -> str:
    summary = report["summary"]
    qualifications = {
        summary.get("summarizationQualification"),
        summary.get("decisionTrackerQualification"),
    }
    if "failed" in qualifications:
        return "failed"
    if summary["status"] in {"cancelled", "interrupted"} or "blocked" in qualifications:
        return "blocked"
    return "passed" if summary["status"] == "completed" else "failed"


def _print_report(report: dict) -> None:
    summary = report["summary"]
    result = report.get("result") or {}
    console.print(
        f"[bold]Agent Evals · {summary['status'].upper()}[/bold] · "
        f"{summary['completed']}/{summary['total']} checks · "
        f"{summary.get('setup', 'current')} · {summary.get('teamSelection', 'Preparing team')} · {summary['preset']} · {summary['runId']}"
    )
    if summary.get("error"):
        console.print(summary["error"], style="red")

    for limitation in summary.get("limitations", []):
        console.print(f"Limitation: {limitation}")
    table = Table("Component", "Outcome", "Details")
    labels = EVAL_LABELS
    for name, raw_value in result.get("results", {}).items():
        value = raw_value if isinstance(raw_value, dict) else {}
        tasks = raw_value if isinstance(raw_value, list) else value.get("tasks", [])
        if name == "decision-tracker":
            table.add_row(
                labels[name], str(value.get("verdict", "blocked")).upper(), ""
            )
            continue
        if name == "summarization":
            attempts = value.get("attempts", [])
            passed = sum(attempt.get("verdict") == "passed" for attempt in attempts)
            table.add_row(
                labels[name],
                str(value.get("verdict", "blocked")).upper()
                if value.get("complete")
                else "Partial",
                f"{value.get('scope', '')} · {passed}/{len(attempts)} attempts passed",
            )
            continue
        if name == "bottlenecks":
            table.add_row(
                labels[name],
                "Same executions",
                f"{value.get('totalElapsedMs', 0) / 1000:.2f}s total task time",
            )
            continue
        if isinstance(tasks, list):
            passed = sum(task.get("success") is True for task in tasks)
            retries = sum(len(task.get("attempts", [])) > 1 for task in tasks)
            if tasks:
                table.add_row(
                    labels.get(name, name.replace("-", " ")),
                    f"{passed}/{len(tasks)} passed",
                    f"{retries} retried · {sum(task.get('elapsedMs', 0) for task in tasks) / 1000:.2f}s total task time",
                )
                continue
        findings = value.get("findings")
        if isinstance(findings, list):
            table.add_row(
                labels.get(name, name.replace("-", " ")),
                f"{len(findings)} potential findings",
                f"{value.get('resourceCount', value.get('sourceCount', ''))} sources",
            )
        else:
            table.add_row(labels.get(name, name.replace("-", " ")), "Completed", "")
    if table.row_count:
        console.print(table)
    tracker = result.get("results", {}).get("decision-tracker", {})
    if audit := tracker.get("instructionAudit"):
        console.print(f"Instruction Audit · {audit['status'].upper()}", markup=False)
    for label, key in (
        ("Behavior Evaluation · deterministic checks", "deterministicResults"),
        ("Semantic grading", "semanticResults"),
    ):
        if metrics := tracker.get(key):
            verdict = str(
                metrics.get("verdict") or metrics.get("status") or "blocked"
            ).upper()
            console.print(f"{label} · {verdict}", markup=False)
            for name, counts in metrics.items():
                if isinstance(counts, dict) and {"passed", "total"} <= counts.keys():
                    console.print(f"  {name} · {counts['passed']}/{counts['total']}")
            for name, counts in metrics.get("metrics", {}).items():
                console.print(
                    f"  {name} · {counts['numerator']}/{counts['denominator']}"
                )
    if tracker.get("cases"):
        console.print("Bottleneck Attribution", markup=False)
    for case in tracker.get("cases", []):
        if case.get("verdict") in {"failed", "blocked"}:
            stage = f" · {case['failureStage']}" if case.get("failureStage") else ""
            console.print(
                f"  {case['id']} · {case['verdict'].upper()}{stage}", markup=False
            )
            if message := case.get("budgetMessage") or case.get("blocker"):
                console.print(f"    {message}", markup=False)
    qualification = result.get("results", {}).get("summarization", {})
    for blocker in qualification.get("blockers", []):
        console.print(blocker, markup=False)
    for attempt in qualification.get("attempts", []):
        if attempt.get("verdict") == "passed":
            continue
        label = f"{attempt['id']} · attempt {attempt['attempt']} · {attempt['input']}"
        detail = attempt.get("reason") or attempt.get("verdict", "blocked")
        console.print(f"{label} · {detail}", markup=False)
        for missing in attempt.get("missingExact", []):
            console.print(
                f"  {missing['fact']} · missing {', '.join(missing['values'])}",
                markup=False,
            )
        grade = attempt.get("grading", {}).get("grade", {})
        for fact in grade.get("facts", []):
            if fact["verdict"] != "preserved":
                console.print(
                    f"  {fact['id']} · {fact['verdict']} · {fact['sourceQuote']}",
                    markup=False,
                )
        for claim in grade.get("claims", []):
            if claim["verdict"] != "supported":
                console.print(
                    f"  {claim['verdict']} · {claim['summaryQuote']}", markup=False
                )
    if downstream := qualification.get("downstream"):
        console.print(
            "Behavior Evaluation · downstream decision · "
            + downstream["verdict"]
            + (
                f" · {downstream['attribution']}"
                if downstream.get("attribution")
                else ""
            ),
            markup=False,
        )
        for case in downstream.get("cases", []):
            actual = case.get("candidate", {}).get("decision") or "unavailable"
            control = case.get("control", {}).get("decision")
            detail = f" · control {control}" if control else ""
            attribution = case.get("attribution")
            if attribution:
                detail += f" · {attribution}"
            console.print(
                f"  {case['id']} · expected {case['expected']} · returned {actual} · {case['verdict']}{detail}",
                markup=False,
            )
    for task in result.get("results", {}).get("behavior", {}).get("tasks", []):
        for attempt in task.get("attempts", []):
            budget = attempt.get("budget") or {}
            console.print(
                f"{task.get('scenario', 'Case')} · {attempt.get('thinking', 'off')} · {attempt.get('elapsedMs', 0) / 1000:.2f}s"
            )
            if budget:
                expected = budget.get("expectedMs")
                source = (
                    ", ".join(budget.get("referenceRuns", []))
                    or "no successful baseline yet"
                )
                console.print(
                    f"Safeguard: {budget['timeoutMs'] / 1000:.2f}s; expected {'unknown' if expected is None else f'{expected / 1000:.2f}s'}; history: {source}"
                )
            if attempt.get("failure"):
                console.print(attempt["failure"], style="red", markup=False)
            if attempt.get("diagnostics"):
                console.print(json.dumps(attempt["diagnostics"], indent=2))
    timings = result.get("results", {}).get("bottlenecks", {}).get("timings", {})
    if timings:
        console.print(
            "Bottleneck Attribution · overlapping trace durations: "
            + "; ".join(
                f"{name}: {elapsed / 1000:.2f}s" for name, elapsed in timings.items()
            )
        )


def _start_and_follow(
    preset: str,
    *,
    setup: EvalSetup = EvalSetup.current,
    static_only: bool = False,
    repetitions: int = 1,
    scenario: EvalCase | None = None,
    summarization_grader: SummarizationGrader | None = None,
    deterministic_only: bool = False,
    deadline_at: int | None = None,
    defer_verdict: bool = False,
) -> dict | None:
    try:
        environment, _ = _runtime()
        shell = _shell_environment(os.environ)
        workspace = (
            APP_RC.manage(environment=shell).inspect().resolved.workspace
            if setup == EvalSetup.current and scenario != EvalCase.decision_tracker
            else None
        )
        request: dict[str, object] = {
            "preset": preset,
            "setup": setup.value,
            "staticOnly": static_only,
            "repetitions": repetitions,
        }
        if scenario is not None:
            request["scenario"] = scenario.value
        if summarization_grader is not None:
            request["summarizationGrader"] = summarization_grader.value
        if workspace is not None:
            request["workspaceRoot"] = str(workspace.root)
        if deterministic_only:
            request["deterministicOnly"] = True
        if deadline_at is not None:
            request["deadlineAt"] = deadline_at
        if setup == EvalSetup.current and scenario != EvalCase.decision_tracker:
            overrides = {
                key: shell[key] for key in _EVALUATION_ENVIRONMENT_KEYS if key in shell
            }
            if overrides:
                request["environmentOverrides"] = overrides
        run_id = _call(
            environment,
            "/v1/evals/start",
            request,
        )["runId"]
        console.print(f"Agent Evals run [bold]{run_id}[/bold] · {preset}")
        if defer_verdict:
            return _follow(environment, run_id, defer_verdict=True)
        return _follow(environment, run_id)
    except KeyboardInterrupt:
        console.print(
            "Detached from run. It continues in the LTCook runtime; use `ltcook eval cancel RUN_ID` to stop it."
        )
    except RuntimeClientError as error:
        raise typer.BadParameter(str(error)) from error
    return None


def _decision_tracker_baseline(*, retry_blocked: bool) -> None:
    """Run the two Tracker setups with one server-enforced session deadline."""
    deadline = time.time_ns() // 1_000_000 + 20 * 60 * 1000
    setups = [EvalSetup.synthetic, EvalSetup.current]
    verdicts: list[str] = []
    retry_setup = None
    for setup in setups:
        if time.time_ns() // 1_000_000 >= deadline:
            console.print(f"{setup.value} · BLOCKED · baseline deadline expired")
            verdicts.append("blocked")
            continue
        report = _start_and_follow(
            "full",
            setup=setup,
            scenario=EvalCase.decision_tracker,
            deadline_at=deadline,
            defer_verdict=True,
        )
        if report is None:
            raise typer.Exit(1)
        verdict = _run_verdict(report)
        verdicts.append(verdict)
        if retry_blocked and verdict == "blocked" and retry_setup is None:
            retry_setup = setup

    if retry_setup and time.time_ns() // 1_000_000 < deadline:
        report = _start_and_follow(
            "full",
            setup=retry_setup,
            scenario=EvalCase.decision_tracker,
            deadline_at=deadline,
            defer_verdict=True,
        )
        if report is None:
            raise typer.Exit(1)
        verdicts[setups.index(retry_setup)] = _run_verdict(report)

    verdict = (
        "failed"
        if "failed" in verdicts
        else "blocked"
        if "blocked" in verdicts
        else "passed"
    )
    console.print(f"Hosted Decision Tracker baseline · {verdict.upper()}")
    if verdict != "passed":
        raise typer.Exit(1)


@eval_cli.command("run")
def run(
    setup: Annotated[
        EvalSetup, typer.Option("--setup", help="Evaluation setup.")
    ] = EvalSetup.current,
    all_categories: bool = typer.Option(
        False,
        "--all",
        help="Run all evaluation categories or full qualification for a selected suite.",
    ),
    behavior_only: bool = typer.Option(
        False, "--behavior-only", help="Run only Behavior Evaluation."
    ),
    quick: bool = typer.Option(
        False, "--quick", help="Run the fast instruction and targeted-fix check."
    ),
    repetitions: Annotated[
        int, typer.Option("--repetitions", min=1, help="Number of executions per case.")
    ] = 1,
    case: Annotated[
        EvalCase | None, typer.Option("--case", help="Run one selected case.")
    ] = None,
    summarization_grader: Annotated[
        SummarizationGrader | None,
        typer.Option(
            "--summarization-grader",
            help="Use hosted GPT-6 Luna with high reasoning for fixed summarization fixtures.",
        ),
    ] = None,
    deterministic_only: Annotated[
        bool,
        typer.Option(
            "--deterministic-only", help="Run Decision Tracker checks offline."
        ),
    ] = False,
    baseline: Annotated[
        bool,
        typer.Option(
            "--baseline", help="Run both Decision Tracker setups within 20 minutes."
        ),
    ] = False,
    retry_blocked: Annotated[
        bool,
        typer.Option(
            "--retry-blocked",
            help="Retry one blocked setup within the baseline deadline.",
        ),
    ] = False,
):
    """Run Behavior Evaluation with full instructions and report Bottleneck Attribution."""
    if all_categories and (quick or behavior_only):
        raise typer.BadParameter(
            "--all cannot be combined with --quick or --behavior-only."
        )
    if quick and behavior_only:
        raise typer.BadParameter("--quick and --behavior-only cannot be combined.")
    if quick and case is not None:
        raise typer.BadParameter("--quick and --case cannot be combined.")
    if summarization_grader is not None and case != EvalCase.summarization:
        raise typer.BadParameter(
            "--summarization-grader requires --case summarization."
        )
    if (deterministic_only or baseline) and case != EvalCase.decision_tracker:
        raise typer.BadParameter(
            "--deterministic-only and --baseline require --case decision-tracker."
        )
    if case == EvalCase.decision_tracker and repetitions != 1:
        raise typer.BadParameter("Decision Tracker cases run once per setup.")
    if retry_blocked and not baseline:
        raise typer.BadParameter("--retry-blocked requires --baseline.")
    if baseline:
        if deterministic_only or behavior_only:
            raise typer.BadParameter("--baseline runs all Decision Tracker categories.")
        _decision_tracker_baseline(retry_blocked=retry_blocked)
        return
    _start_and_follow(
        "full" if all_categories else "quick" if quick else "behavior",
        setup=setup,
        repetitions=repetitions,
        scenario=case,
        summarization_grader=summarization_grader,
        deterministic_only=deterministic_only,
    )


@eval_cli.command("audit")
def audit(
    setup: Annotated[
        EvalSetup, typer.Option("--setup", help="Evaluation setup.")
    ] = EvalSetup.current,
    static_only: bool = typer.Option(
        False, "--static-only", help="Run the static audit without Ollama."
    ),
):
    """Run the static and semantic Instruction Audit."""
    _start_and_follow("audit", setup=setup, static_only=static_only)


@eval_cli.command("analyze")
def analyze(
    setup: Annotated[
        EvalSetup, typer.Option("--setup", help="Evaluation setup.")
    ] = EvalSetup.current,
    repetitions: Annotated[
        int, typer.Option("--repetitions", min=1, help="Number of executions per case.")
    ] = 1,
    case: Annotated[
        EvalCase | None, typer.Option("--case", help="Run one selected case.")
    ] = None,
):
    """Report Bottleneck Attribution from the same full-instruction case executions."""
    if case == EvalCase.summarization:
        raise typer.BadParameter(
            "Use eval run --case summarization for this evaluation."
        )
    _start_and_follow(
        "bottlenecks", setup=setup, repetitions=repetitions, scenario=case
    )


@eval_cli.command("watch")
def watch(run_id: str):
    """Attach the terminal progress view to a run started by either client."""
    try:
        environment, _ = _runtime()
        _follow(environment, run_id)
    except KeyboardInterrupt:
        console.print(
            "Detached from run. It continues in the LTCook runtime; use `ltcook eval cancel RUN_ID` to stop it."
        )
    except RuntimeClientError as error:
        raise typer.BadParameter(str(error)) from error


@eval_cli.command("list")
def list_runs():
    environment, _ = _runtime()
    rows = _call(environment, "/v1/evals/list")["runs"]
    table = Table("Run", "Setup", "Team", "Preset", "Status", "Progress", "Started")
    for item in rows:
        table.add_row(
            item["runId"],
            item["setup"],
            item.get("teamSelection", "Preparing team"),
            item["preset"],
            item["status"],
            f"{item['completed']}/{item['total']}",
            item["createdAt"],
        )
    console.print(table)


@eval_cli.command("status")
def status(run_id: str):
    environment, _ = _runtime()
    console.print(
        json.dumps(_call(environment, "/v1/evals/status", {"runId": run_id}), indent=2)
    )


@eval_cli.command("report")
def report(
    run_id: str,
    json_output: Annotated[
        bool, typer.Option("--json", help="Print the structured Agent Evals report.")
    ] = False,
):
    environment, _ = _runtime()
    result = _call(environment, "/v1/evals/report", {"runId": run_id})
    if json_output:
        typer.echo(json.dumps(result, indent=2))
    else:
        _print_report(result)


@eval_cli.command("cancel")
def cancel(run_id: str):
    environment, _ = _runtime()
    console.print(
        json.dumps(_call(environment, "/v1/evals/cancel", {"runId": run_id}), indent=2)
    )


@eval_cli.command("delete")
def delete(run_id: str):
    environment, _ = _runtime()
    _call(environment, "/v1/evals/delete", {"runId": run_id})
    console.print("Run deleted.")
