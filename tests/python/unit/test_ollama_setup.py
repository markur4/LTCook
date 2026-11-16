"""Offline coverage for native Ollama preparation ownership and idempotence."""

from __future__ import annotations

import json

import pytest

from ltcook.cli.app import _ollama_resource_diagnostics
from ltcook_distr.payload.app_lifecycle import prepare_ollama


def test_existing_server_and_models_are_reused_without_mutation(tmp_path, monkeypatch):
    base = {"name": prepare_ollama.MODEL, "digest": "base-digest"}
    derived = {"name": prepare_ollama.EVAL_MODEL, "digest": "derived-digest"}
    calls = []

    def json_response(url, **_):
        if url.endswith("/api/version"):
            return {"version": "test"}
        if url.endswith("/api/show"):
            return {"modelfile": "PARAMETER num_ctx 65536"}
        return {"models": [base, derived]}

    def run(arguments, *, environment, cwd=None, required=True):
        calls.append(list(arguments))

    monkeypatch.setattr(prepare_ollama, "_json", json_response)
    monkeypatch.setattr(prepare_ollama, "run", run)
    receipt_path = prepare_ollama.prepare_ollama(tmp_path, environment={"PATH": ""})

    receipt = json.loads(receipt_path.read_text())
    assert receipt["ready"] is True
    assert receipt["ollama_installed_by_ltcook"] is False
    assert receipt["server_started_by_ltcook"] is False
    assert receipt["eval_model_digest"] == "derived-digest"
    assert calls == []


@pytest.mark.parametrize(
    "value", ["PARAMETER num_ctx 655360", "PARAMETER num_ctx 8192", None]
)
def test_context_configuration_must_match_exactly(value):
    assert not prepare_ollama._has_expected_context(value)
    assert prepare_ollama._has_expected_context("FROM model\nPARAMETER num_ctx 65536\n")


def test_missing_derived_model_is_created_from_exact_bonsai_source(
    tmp_path, monkeypatch
):
    base = {"name": prepare_ollama.MODEL, "digest": "base-digest"}
    responses = iter(
        [[base], [base, {"name": prepare_ollama.EVAL_MODEL, "digest": "ctx-digest"}]]
    )
    calls = []

    def json_response(url, **_):
        if url.endswith("/api/version"):
            return {"version": "test"}
        if url.endswith("/api/show"):
            return {"modelfile": "PARAMETER num_ctx 65536"}
        return {"models": next(responses)}

    def run(arguments, *, environment, cwd=None, required=True):
        calls.append(list(arguments))

    executable = tmp_path / "ollama"
    executable.write_text("fake")
    monkeypatch.setattr(prepare_ollama, "_json", json_response)
    monkeypatch.setattr(
        prepare_ollama, "_wait_for_server", lambda *_: (False, "test", None)
    )
    monkeypatch.setattr(
        prepare_ollama.shutil, "which", lambda *_, **__: str(executable)
    )
    monkeypatch.setattr(prepare_ollama, "run", run)

    receipt = prepare_ollama.prepare_ollama(tmp_path, environment={"PATH": ""})

    assert calls == [
        [
            str(executable),
            "create",
            prepare_ollama.EVAL_MODEL,
            "-f",
            str(tmp_path / "deployment/bonsai-65536.Modelfile"),
        ]
    ]
    assert (tmp_path / "deployment/bonsai-65536.Modelfile").read_text() == (
        f"FROM {prepare_ollama.MODEL}\nPARAMETER num_ctx 65536\n"
    )
    assert json.loads(receipt.read_text())["eval_model"] == prepare_ollama.EVAL_MODEL


def test_doctor_requires_the_current_model_and_context_receipt(tmp_path, monkeypatch):
    deployment = tmp_path / "deployment"
    deployment.mkdir()
    receipt = deployment / "ollama.json"
    model_context = "PARAMETER num_ctx 65536"
    data = {
        "ready": True,
        "version": "test",
        "model": prepare_ollama.MODEL,
        "eval_model": prepare_ollama.EVAL_MODEL,
        "context_tokens": prepare_ollama.CONTEXT_TOKENS,
    }

    def json_response(url, **_):
        if url.endswith("/api/version"):
            return {"version": "test"}
        if url.endswith("/api/show"):
            return {"modelfile": model_context}
        return {
            "models": [
                {"name": prepare_ollama.MODEL},
                {"name": prepare_ollama.EVAL_MODEL},
            ]
        }

    monkeypatch.setattr(prepare_ollama, "_json", json_response)
    receipt.write_text(json.dumps(data))
    status = _ollama_resource_diagnostics(tmp_path)["ollama"]
    assert isinstance(status, dict)
    assert status["context_tokens"] == 65536
    model_context = "PARAMETER num_ctx 655360"
    with pytest.raises(ValueError, match="not ready"):
        _ollama_resource_diagnostics(tmp_path)
    model_context = "PARAMETER num_ctx 65536"
    data["eval_model"] = "previous-model"
    receipt.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="not ready"):
        _ollama_resource_diagnostics(tmp_path)
