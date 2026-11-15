"""Pydantic Evals cases and objective success evaluators for IBB."""

from __future__ import annotations

from pydantic_evals import Case, Dataset
from pydantic_evals.evaluators import EvaluatorContext


def _success(ctx: EvaluatorContext[dict[str, str], dict[str, bool], None]) -> bool:
    """Grade the measured fixture oracle, independently of agent narration."""
    return ctx.output.get("oracle_passed") is True


DATASET = Dataset(
    name="ltcook-ibb-v1",
    cases=[
        Case(
            name="read-only",
            inputs={"kind": "read-only"},
            expected_output={"oracle_passed": True},
            evaluators=[_success],
        ),
        Case(
            name="no-op",
            inputs={"kind": "no-op"},
            expected_output={"oracle_passed": True},
            evaluators=[_success],
        ),
        Case(
            name="targeted-fix",
            inputs={"kind": "targeted-fix"},
            expected_output={"oracle_passed": True},
            evaluators=[_success],
        ),
    ],
)
