"""User-facing Agent Evals diagnostics commands backed by the shared runtime service."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
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
    probe_runtime,
    runtime_api_url,
    start_runtime,
    wait_for_runtime,
)
from ltcook.config.app import APP_RC
from ltcook.launch import resolve_launch

eval_cli = typer.Typer(help="Run and inspect Agent Evals.", no_args_is_help=True)
console = Console()


class EvalSetup(StrEnum):
    current = "current"
    synthetic = "synthetic"


def _runtime():
    launch = resolve_launch(None)
    status = probe_runtime(launch.environment)
    child = None
    if status is None:
        child = start_runtime(
            launch.environment, workspace_root=None, shell_environment={}, detached=True
        )
        status = wait_for_runtime(launch.environment, child)
    elif status == "starting":
        status = wait_for_runtime(launch.environment, None)
    return launch.environment, status


def _call(environment, route: str, payload: object = None):
    url = runtime_api_url(environment["LTCOOK_API_LISTEN"]) + route
    request = urllib.request.Request(
        url,
        data=json.dumps(payload or {}).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {environment['LTCOOK_API_TOKEN']}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
            request, timeout=30
        ) as response:
            return json.loads(response.read().decode())
    except (
        OSError,
        urllib.error.URLError,
        urllib.error.HTTPError,
        ValueError,
    ) as error:
        raise RuntimeClientError(
            f"Agent Evals runtime request failed: {error}"
        ) from error


def _follow(environment, run_id: str) -> None:
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
                description=f"{summary.get('currentSuite', 'Preparing')} · {summary.get('currentCase', summary['status'])}",
                total=max(1, summary["total"]),
                completed=summary["completed"],
            )
            cursor = status["next"]
            if summary["status"] != "running":
                break
            time.sleep(1)
    report = _call(environment, "/v1/evals/report", {"runId": run_id})
    _print_report(report)
    if report["summary"]["status"] in {"failed", "cancelled"}:
        raise typer.Exit(1)


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

    table = Table("Component", "Outcome", "Details")
    labels = {
        "static": "Instruction Audit · static",
        "semantic": "Instruction Audit · semantic",
        "behavior": "Behavior Evaluation",
        "bottlenecks": "Bottleneck Attribution",
    }
    for name, raw_value in result.get("results", {}).items():
        value = raw_value if isinstance(raw_value, dict) else {}
        tasks = raw_value if isinstance(raw_value, list) else value.get("tasks", [])
        if isinstance(tasks, list):
            passed = sum(task.get("success") is True for task in tasks)
            retries = sum(len(task.get("attempts", [])) > 1 for task in tasks)
            if tasks:
                table.add_row(
                    labels.get(name, name.replace("-", " ")),
                    f"{passed}/{len(tasks)} passed",
                    f"{retries} retried",
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


def _start_and_follow(
    preset: str, *, setup: EvalSetup = EvalSetup.current, static_only: bool = False
) -> None:
    try:
        environment, _ = _runtime()
        workspace = (
            APP_RC.manage().inspect().resolved.workspace
            if setup == EvalSetup.current
            else None
        )
        request = {"preset": preset, "setup": setup.value, "staticOnly": static_only}
        if workspace is not None:
            request["workspaceRoot"] = str(workspace.root)
        run_id = _call(
            environment,
            "/v1/evals/start",
            request,
        )["runId"]
        console.print(f"Agent Evals run [bold]{run_id}[/bold] · {preset}")
        _follow(environment, run_id)
    except KeyboardInterrupt:
        console.print(
            "Detached from run. It continues in the LTCook runtime; use `ltcook eval cancel RUN_ID` to stop it."
        )
    except RuntimeClientError as error:
        raise typer.BadParameter(str(error)) from error


@eval_cli.command("run")
def run(
    setup: Annotated[
        EvalSetup, typer.Option("--setup", help="Evaluation setup.")
    ] = EvalSetup.current,
    behavior_only: bool = typer.Option(
        False, "--behavior-only", help="Run only Behavior Evaluation."
    ),
    quick: bool = typer.Option(
        False, "--quick", help="Run the fast instruction and targeted-fix check."
    ),
):
    """Run every Agent Evals category, or the quick check with --quick."""
    if quick and behavior_only:
        raise typer.BadParameter("--quick and --behavior-only cannot be combined.")
    _start_and_follow(
        "behavior" if behavior_only else "quick" if quick else "full", setup=setup
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
):
    """Run three-repetition Bottleneck Attribution."""
    _start_and_follow("bottlenecks", setup=setup)


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
    table = Table("Run", "Preset", "Status", "Progress", "Started")
    for item in rows:
        table.add_row(
            item["runId"],
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
def report(run_id: str):
    environment, _ = _runtime()
    _print_report(_call(environment, "/v1/evals/report", {"runId": run_id}))


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
