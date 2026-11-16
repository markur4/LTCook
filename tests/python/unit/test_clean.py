"""Verify cleanup stays within the checkout and preserves shared environments."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(
    os.name != "posix" or not shutil.which("just"), reason="Requires POSIX just"
)
def test_clean_preserves_virtual_environment_and_shared_uv_cache(
    tmp_path: Path,
) -> None:
    root = Path(__file__).resolve().parents[3]
    for relative in (
        "src/pkg/__pycache__/generated.pyc",
        "tests/__pycache__/generated.pyc",
        ".pytest_cache/cached",
        ".venv/lib/__pycache__/keep.pyc",
        "src/.venv/__pycache__/keep.pyc",
        "tests/node_modules/__pycache__/keep.pyc",
    ):
        item = tmp_path / relative
        item.parent.mkdir(parents=True, exist_ok=True)
        item.write_text("fixture", encoding="utf-8")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    uv = bin_dir / "uv"
    uv.write_text(
        f"#!/bin/sh\ntouch '{tmp_path / 'uv-was-called'}'\n", encoding="utf-8"
    )
    uv.chmod(0o755)
    environment = dict(os.environ, PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    result = subprocess.run(
        [
            "just",
            "--justfile",
            str(root / "justfile"),
            "--working-directory",
            str(tmp_path),
            "clean",
        ],
        capture_output=True,
        text=True,
        env=environment,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert not (tmp_path / "src/pkg/__pycache__").exists()
    assert not (tmp_path / "tests/__pycache__").exists()
    assert not (tmp_path / ".pytest_cache").exists()
    assert (tmp_path / ".venv/lib/__pycache__/keep.pyc").is_file()
    assert (tmp_path / "src/.venv/__pycache__/keep.pyc").is_file()
    assert (tmp_path / "tests/node_modules/__pycache__/keep.pyc").is_file()
    assert not (tmp_path / "uv-was-called").exists()
