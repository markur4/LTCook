"""AppRC-aware development runtime command planning."""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from ltcook_dev import runtime


def _checkout(tmp_path: Path) -> Path:
    root = tmp_path / "checkout"
    entrypoint = root / "runtime" / "src" / "main.ts"
    entrypoint.parent.mkdir(parents=True)
    entrypoint.write_text("void 0;\n", encoding="utf-8")
    return root


def test_runtime_dev_resolves_source_root_and_forwards_application_help(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _checkout(tmp_path)
    workspace = tmp_path / "workspace"
    calls: list[tuple[str, list[str], dict[str, str]]] = []
    working_directories: list[Path] = []
    monkeypatch.delenv("BUN", raising=False)
    monkeypatch.delenv("LTCOOK_SHELL_PROVENANCE", raising=False)
    shell = dict(os.environ)
    monkeypatch.setattr(runtime.os, "chdir", working_directories.append)

    def resolve_launch(workspace_root, *, original_environment):
        assert workspace_root == workspace
        assert original_environment["LTCOOK_JS_ROOT"] == str(root)
        return SimpleNamespace(environment={"PATH": "resolved-path"})

    monkeypatch.setattr(runtime, "resolve_launch", resolve_launch)
    monkeypatch.setattr(
        runtime.os,
        "execvpe",
        lambda executable, command, environment: calls.append(
            (executable, command, environment)
        ),
    )

    result = runtime.main(
        ["--root", str(root), "--workspace", str(workspace), "--", "--help"]
    )

    assert result == 0
    assert working_directories == [root]
    assert calls == [
        (
            "bun",
            ["bun", "runtime/src/main.ts", "--help"],
            {
                "PATH": "resolved-path",
                "LTCOOK_SHELL_PROVENANCE": json.dumps(
                    shell | {"LTCOOK_JS_ROOT": str(root)}
                ),
            },
        ),
    ]


def test_runtime_dev_watch_uses_explicit_bun_and_forwards_arguments(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _checkout(tmp_path)
    calls: list[tuple[str, list[str]]] = []
    monkeypatch.setenv("BUN", "environment-bun")
    monkeypatch.setattr(
        runtime,
        "resolve_launch",
        lambda *_args, **_kwargs: SimpleNamespace(environment={}),
    )
    monkeypatch.setattr(
        runtime.os,
        "execvpe",
        lambda executable, command, _environment: calls.append((executable, command)),
    )
    monkeypatch.setattr(runtime.os, "chdir", lambda _path: None)

    result = runtime.main(
        ["--root", str(root), "--bun", "explicit-bun", "--watch", "--", "--help"]
    )

    assert result == 0
    assert calls == [
        (
            "explicit-bun",
            ["explicit-bun", "--watch", "runtime/src/main.ts", "--help"],
        )
    ]


def test_runtime_dev_uses_bun_environment_when_not_overridden(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _checkout(tmp_path)
    calls: list[str] = []
    monkeypatch.setenv("BUN", "environment-bun")
    monkeypatch.setattr(
        runtime,
        "resolve_launch",
        lambda *_args, **_kwargs: SimpleNamespace(environment={}),
    )
    monkeypatch.setattr(runtime.os, "chdir", lambda _path: None)
    monkeypatch.setattr(
        runtime.os,
        "execvpe",
        lambda executable, _command, _environment: calls.append(executable),
    )

    runtime.main(["--root", str(root), "--", "--version"])

    assert calls == ["environment-bun"]
