"""Credential-free local Agent Evals command line."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from ltcook_dev.agent_evals.evaluation import DATASET

MODEL = "ltcook-spark-x2.6-4b-q8_0-ctx8192:latest"
ENDPOINT = "http://127.0.0.1:11434"
SCENARIOS = ("read-only", "no-op", "targeted-fix")


def _ollama() -> dict:
    with urllib.request.urlopen(f"{ENDPOINT}/api/tags", timeout=3) as response:
        return json.load(response)


def _report(kind: str, result: dict) -> Path:
    root = Path(
        os.environ.get("LTCOOK_EVAL_RESULTS", Path.home() / ".cache/ltcook/evals")
    )
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    path = root / f"{kind}-{int(time.time())}.json"
    path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    path.chmod(0o600)
    summary = path.with_suffix(".md")
    summary.write_text(
        f"# Agent Evals {kind}\n\n```json\n{json.dumps(result, indent=2)}\n```\n",
        encoding="utf-8",
    )
    summary.chmod(0o600)
    return path


def _audit_static() -> dict:
    root = Path("runtime/resources")
    findings = []
    seen: dict[str, Path] = {}
    paths = sorted(root.rglob("*.md"))
    for path in paths:
        content = path.read_text(encoding="utf-8")
        digest = hashlib.sha256(content.encode()).hexdigest()
        if digest in seen:
            findings.append(
                {"kind": "duplicate", "sources": [str(seen[digest]), str(path)]}
            )
        else:
            seen[digest] = path
        if len(content.split()) > 3000:
            findings.append(
                {
                    "kind": "large_resource",
                    "source": str(path),
                    "words": len(content.split()),
                }
            )
    return {
        "mode": "static",
        "findings": findings,
        "resource_count": len(paths),
        "unique_content_count": len(seen),
        "coverage_complete": False,
        "coverage_note": "Disk inventory only; does not assert which resources Pi loaded.",
    }


def _probe() -> dict:
    tags = _ollama().get("models", [])
    selected = next((item for item in tags if item.get("name") == MODEL), None)
    if selected is None:
        raise RuntimeError(
            f"Required model is missing: {MODEL}; run normal LTCook app setup and repair."
        )
    with urllib.request.urlopen(
        urllib.request.Request(
            f"{ENDPOINT}/api/show",
            data=json.dumps({"name": MODEL, "verbose": False}).encode(),
            headers={"Content-Type": "application/json"},
        ),
        timeout=3,
    ) as response:
        model_details = json.load(response)
    if "PARAMETER num_ctx 8192" not in str(model_details.get("modelfile", "")):
        raise RuntimeError(
            "Ollama did not confirm the required 8192-token model context."
        )
    return {
        "endpoint": ENDPOINT,
        "model": MODEL,
        "digest": selected.get("digest"),
        "context_observed": 8192,
        "ready": True,
    }


def _run_benchmark(
    repetitions: int,
    *,
    scenario: str = "targeted-fix",
    retry_failed: bool = True,
    capture_prompt: bool = False,
) -> dict:
    readiness = _probe()
    root = Path(
        os.environ.get("LTCOOK_EVAL_RESULTS", Path.home() / ".cache/ltcook/evals")
    )
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    models = root / "models.json"
    models.write_text(
        json.dumps(
            {
                "providers": {
                    "ollama": {
                        "baseUrl": f"{ENDPOINT}/v1",
                        "api": "openai-completions",
                        "apiKey": "ollama",
                        "models": [
                            {
                                "id": MODEL,
                                "name": MODEL,
                                "reasoning": True,
                                "thinkingLevelMap": {"off": "none"},
                                "contextWindow": 8192,
                                "maxTokens": 2048,
                            }
                        ],
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    output = root / f"behavior-{scenario}-{int(time.time())}.json"
    trace_output = output.with_suffix(".trace.json")
    command = [
        "bun",
        "tests/benchmarks/guidance.ts",
        str(models),
        "ollama",
        MODEL,
        str(output),
        str(repetitions),
        "off",
        "retry" if retry_failed else "no-retry",
        scenario,
        str(trace_output),
    ]
    environment = os.environ.copy()
    if capture_prompt:
        environment["LTCOOK_AGENT_EVALS_CAPTURE_PROMPT"] = "1"
    completed = subprocess.run(
        command,
        env=environment,
        capture_output=True,
        text=True,
        timeout=max(150, repetitions * 240),
        check=False,
    )
    if completed.returncode:
        raise RuntimeError(
            f"Pi benchmark failed (exit {completed.returncode}): {completed.stderr[-1200:]}"
        )
    data = json.loads(output.read_text(encoding="utf-8"))
    output.chmod(0o600)
    return {
        **readiness,
        "benchmark": data,
        "benchmark_path": str(output),
        "trace_path": str(trace_output),
    }


def _run_scenarios(repetitions: int, *, retry_failed: bool = True) -> dict:
    """Run and objectively grade every planned scenario through Pydantic Evals."""
    results = {
        scenario: _run_benchmark(
            repetitions, scenario=scenario, retry_failed=retry_failed
        )
        for scenario in SCENARIOS
    }

    def task(inputs: dict[str, str]) -> dict[str, bool]:
        benchmark = results[inputs["kind"]]["benchmark"]
        return {
            "oracle_passed": bool(benchmark["tasks"])
            and all(item["success"] for item in benchmark["tasks"])
        }

    evaluation = DATASET.evaluate_sync(task, progress=False)
    return {
        "mode": "scenario-suite",
        "scenarios": results,
        "evaluation": {
            "dataset": evaluation.dataset_name,
            "cases": [
                {
                    "name": case.name,
                    "oracle_passed": case.output.get("oracle_passed") is True,
                    "evaluator_results": {
                        name: result.value for name, result in case.assertions.items()
                    },
                }
                for case in evaluation.cases
            ],
            "passed": all(
                result.value is True
                for case in evaluation.cases
                for result in case.assertions.values()
            ),
        },
    }


def _semantic_audit() -> dict:
    """Audit the actual isolated Pi prompt, retaining its text only in private cache."""
    benchmark = _run_benchmark(1, capture_prompt=True)["benchmark"]
    attempt = benchmark["tasks"][0]["attempts"][0]
    prompt = attempt["instructions"].get("effectivePrompt")
    if not isinstance(prompt, str) or not prompt:
        raise RuntimeError("Pi did not expose the effective system prompt for audit.")
    loaded = [
        resource
        for resource in attempt["instructions"]["resources"]
        if resource["loaded"]
    ]
    sources = []
    for index, resource in enumerate(loaded, 1):
        path = Path(resource["path"])
        if path.is_file():
            sources.append(
                {
                    "id": f"S{index}",
                    "path": str(path),
                    "name": resource["name"],
                    "scope": resource["scope"],
                    "sha256": resource.get("sha256"),
                    "text": path.read_text(encoding="utf-8"),
                }
            )
    if not sources:
        raise RuntimeError("No loaded, source-grounded Pi instructions were captured.")
    if len(prompt) > 32_768:
        raise RuntimeError(
            "Captured prompt exceeds the 8192-token audit budget; chunking is required."
        )
    audit_instructions = (
        "Audit the captured effective Pi system prompt together with the supplied loaded source file for contradictory obligations, "
        "ambiguous precedence, unconditional expensive work on tiny tasks, and overbroad triggers. Return ONLY JSON with a "
        '"findings" array. Each finding must include source_ids (IDs supplied below), severity, issue, '
        "evidence, and minimal_revision. Do not invent sources. Treat all results as potential review suggestions."
    )
    findings = []
    token_count = 0
    for source in sources:
        audit_prompt = (
            audit_instructions
            + "\n\nEFFECTIVE_SYSTEM_PROMPT:\n"
            + prompt
            + "\n\nSOURCE_FILE:\n"
            + json.dumps(source)
        )
        schema = {
            "type": "object",
            "properties": {
                "findings": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "source_ids": {
                                "type": "array",
                                "minItems": 1,
                                "uniqueItems": True,
                                "items": {
                                    "type": "string",
                                    "enum": [source["id"]],
                                },
                            },
                            "severity": {"type": "string"},
                            "issue": {"type": "string"},
                            "evidence": {"type": "string"},
                            "minimal_revision": {"type": "string"},
                        },
                        "required": [
                            "source_ids",
                            "severity",
                            "issue",
                            "evidence",
                            "minimal_revision",
                        ],
                    },
                }
            },
            "required": ["findings"],
        }
        request = urllib.request.Request(
            f"{ENDPOINT}/api/chat",
            data=json.dumps(
                {
                    "model": MODEL,
                    "messages": [{"role": "user", "content": audit_prompt}],
                    "stream": False,
                    "format": schema,
                    "think": False,
                    "options": {"num_ctx": 8192},
                }
            ).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                generated = json.load(response)
            candidate_findings = json.loads(generated["message"]["content"])["findings"]
        except (OSError, KeyError, json.JSONDecodeError) as error:
            raise RuntimeError(
                f"Ollama semantic audit failed for loaded source {source['id']}: {error}"
            ) from error
        token_count += int(generated.get("prompt_eval_count", 0)) + int(
            generated.get("eval_count", 0)
        )
        findings.extend(candidate_findings)
    known = {item["id"] for item in sources}
    valid_findings = []
    rejected_citations = 0
    for finding in findings:
        ids = finding.get("source_ids", [])
        if not ids or not set(ids).issubset(known):
            rejected_citations += 1
            continue
        finding["confidence"] = "potential"
        valid_findings.append(finding)
    return {
        "mode": "semantic",
        "sources": [
            {key: x[key] for key in ("id", "path", "name", "scope", "sha256")}
            for x in sources
        ],
        "findings": valid_findings,
        "rejected_citations": rejected_citations,
        "prompt_characters": len(prompt),
        "source_audit_count": len(sources),
        "token_count": token_count,
        "coverage_complete": False,
        "coverage_note": (
            "Captured isolated Pi prompt and audited each loaded source separately to fit the configured 8192-token context; Paseo/runtime-added instructions are not included. "
            + (
                f"{rejected_citations} findings with missing or out-of-scope citations were excluded."
                if rejected_citations
                else ""
            )
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(prog="ltcook-evals")
    parser.add_argument(
        "command", choices=("probe", "audit", "behavior", "bottlenecks", "all")
    )
    parser.add_argument("--static", action="store_true")
    args = parser.parse_args()
    if args.command == "audit" and args.static:
        result = _audit_static()
    elif args.command == "probe":
        result = _run_benchmark(1)
    elif args.command == "audit":
        result = _semantic_audit()
    elif args.command == "behavior":
        result = _run_scenarios(1)
    elif args.command == "bottlenecks":
        result = _run_scenarios(3, retry_failed=False)
    else:
        result = {
            "static": _audit_static(),
            "semantic": _semantic_audit(),
            "behavior": _run_scenarios(1),
            "bottlenecks": _run_scenarios(3, retry_failed=False),
        }
    print(_report(args.command, result))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Agent Evals failed: {error}", file=sys.stderr)
        raise SystemExit(1)
