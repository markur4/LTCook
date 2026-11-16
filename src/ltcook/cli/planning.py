"""Explicit, authenticated user operations for planning and guidance."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import typer

from ltcook._runtime_client import RuntimeClientError, send_runtime_command
from ltcook.launch import resolve_launch

planning_cli = typer.Typer(no_args_is_help=True)
guidance_cli = typer.Typer(no_args_is_help=True)

Session = Annotated[str, typer.Option("--session", help="Explicit runtime Session ID.")]
Plan = Annotated[
    str,
    typer.Option(
        "--plan", help="Registered Plan filename stem, including its timestamp."
    ),
]


def _result(session: str, command: dict[str, object]) -> object:
    try:
        return send_runtime_command(resolve_launch(None).environment, session, command)
    except (RuntimeClientError, ValueError) as error:
        raise typer.BadParameter(str(error)) from error


def _command(session: str, command: dict[str, object]) -> None:
    result = _result(session, command)
    typer.echo(json.dumps(result, ensure_ascii=False, indent=2))


@planning_cli.command("start")
def start(
    session: Session,
    design: Annotated[
        Path, typer.Option("--design", help="Existing Design Markdown path.")
    ],
    title: Annotated[
        str, typer.Option("--title", help="Concise title for the new Plan.")
    ],
) -> None:
    """Request Plan prefill and finalization for an explicit Design."""
    _command(
        session,
        {
            "type": "planning.start",
            "designPath": str(design.expanduser().resolve()),
            "title": title,
        },
    )


@planning_cli.command("show")
def show(
    session: Session,
    plan: Plan,
    json_output: Annotated[
        bool, typer.Option("--json", help="Emit raw registered workflow state.")
    ] = False,
) -> None:
    """Read the Team's current Plan Markdown and show its workflow state."""
    result = _result(session, {"type": "planning.show", "planId": plan})
    if json_output:
        typer.echo(json.dumps(result, ensure_ascii=False, indent=2))
        return
    record = result.get("value") if isinstance(result, dict) else None
    document = record.get("plan") if isinstance(record, dict) else None
    location = document.get("path") if isinstance(document, dict) else None
    if not isinstance(location, str):
        raise typer.BadParameter("The runtime returned no registered Plan path.")
    path = Path(location)
    if not path.is_absolute() or path.name != f"{plan}.md" or path.is_symlink():
        raise typer.BadParameter("The runtime returned an unsafe Plan path.")
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise typer.BadParameter(f"Cannot read the registered Plan: {error}") from error
    assert isinstance(record, dict)
    typer.echo(f"{plan} [{record['stage']}]\n{path}\n\n{content}")


@planning_cli.command("questions")
def questions(session: Session, plan: Plan) -> None:
    """Show decisions that remain pending or have recorded answers."""
    _command(session, {"type": "planning.questions", "planId": plan})


@planning_cli.command("answer")
def answer(
    session: Session,
    plan: Plan,
    decision: Annotated[
        str, typer.Option("--decision", help="Registered decision ID.")
    ],
    answer: Annotated[str, typer.Option("--answer", help="Your explicit answer.")],
) -> None:
    """Record a user answer for this Session, Plan and decision."""
    _command(
        session,
        {
            "type": "decision.answer",
            "planId": plan,
            "decisionId": decision,
            "answer": answer,
        },
    )


@planning_cli.command("approve")
def approve(session: Session, plan: Plan) -> None:
    """Approve execution of the registered Plan after its gates pass."""
    _command(session, {"type": "planning.approve", "planId": plan})


@planning_cli.command("reject")
def reject(session: Session, plan: Plan) -> None:
    """Reject execution of the registered Plan."""
    _command(session, {"type": "planning.reject", "planId": plan})


@guidance_cli.command("inspect")
def inspect(
    session: Session,
    agent: Annotated[
        str | None, typer.Option("--agent", help="Inspect one bound native agent.")
    ] = None,
) -> None:
    """Inspect guidance sources, applicability and actual native loading."""
    command: dict[str, object] = {"type": "guidance.inspect"}
    if agent is not None:
        command["nativeAgentId"] = agent
    _command(session, command)
