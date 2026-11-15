"""Offline coverage for native Ollama preparation ownership and idempotence."""

from __future__ import annotations

import json

from ltcook_distr.payload.app_lifecycle import prepare_ollama


def test_existing_server_and_models_are_reused_without_mutation(tmp_path, monkeypatch):
    base = {"name": prepare_ollama.MODEL, "digest": "base-digest"}
    derived = {"name": prepare_ollama.IBB_MODEL, "digest": "derived-digest"}
    calls = []

    def json_response(url, **_):
        if url.endswith("/api/version"):
            return {"version": "test"}
        if url.endswith("/api/show"):
            return {"modelfile": "PARAMETER num_ctx 8192"}
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
    assert receipt["ibb_model_digest"] == "derived-digest"
    assert calls == []


def test_missing_derived_model_is_created_from_exact_q8_source(tmp_path, monkeypatch):
    base = {"name": prepare_ollama.MODEL, "digest": "base-digest"}
    responses = iter(
        [[base], [base, {"name": prepare_ollama.IBB_MODEL, "digest": "ctx-digest"}]]
    )
    calls = []

    def json_response(url, **_):
        if url.endswith("/api/version"):
            return {"version": "test"}
        if url.endswith("/api/show"):
            return {"modelfile": "PARAMETER num_ctx 8192"}
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
            prepare_ollama.IBB_MODEL,
            "-f",
            str(tmp_path / "deployment/spark-8192.Modelfile"),
        ]
    ]
    assert (tmp_path / "deployment/spark-8192.Modelfile").read_text() == (
        f"FROM {prepare_ollama.MODEL}\nPARAMETER num_ctx 8192\n"
    )
    assert json.loads(receipt.read_text())["ibb_model"] == prepare_ollama.IBB_MODEL
