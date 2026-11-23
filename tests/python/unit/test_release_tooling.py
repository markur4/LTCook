"""Offline contracts for the committed release policy and hosted CI selection."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


def _just(workspace: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    executable = shutil.which("just")
    if not executable or not shutil.which("bash"):
        pytest.skip("The repository's release recipes require just and Bash.")
    return subprocess.run(
        [
            executable,
            "--no-dotenv",
            "--justfile",
            str(ROOT / "justfile"),
            "--working-directory",
            str(workspace),
            *arguments,
        ],
        text=True,
        capture_output=True,
        check=False,
    )


def _git(workspace: Path, *arguments: str) -> None:
    subprocess.run(["git", *arguments], cwd=workspace, check=True, capture_output=True)


def test_release_policy_uses_the_exact_tag_snapshot(tmp_path: Path) -> None:
    _git(tmp_path, "init", "-b", "main")
    _git(tmp_path, "config", "user.name", "Release fixture")
    _git(tmp_path, "config", "user.email", "fixture@example.invalid")
    source = tmp_path / "justfile"
    source.write_text(
        'RELEASE_REQUIRE_CI := "true"\nRELEASE_PYPI := "false"\n'
        "mod runtime 'runtime/justfile'\n",
        encoding="utf-8",
    )
    _git(tmp_path, "add", "justfile")
    _git(tmp_path, "commit", "--no-gpg-sign", "-m", "Version fixture")
    _git(tmp_path, "tag", "-a", "v0.2.0rc1", "-m", "Release fixture")
    source.write_text(
        'RELEASE_REQUIRE_CI := "false"\nRELEASE_PYPI := "true"\n',
        encoding="utf-8",
    )

    for setting, expected in (
        ("RELEASE_REQUIRE_CI", "true"),
        ("RELEASE_PYPI", "false"),
    ):
        result = _just(tmp_path, "_committed-release-policy", "v0.2.0rc1", setting)
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == expected

    _git(tmp_path, "add", "justfile")
    _git(tmp_path, "commit", "--no-gpg-sign", "-m", "Different current policies")
    result = _just(tmp_path, "_committed-release-policy", "HEAD", "RELEASE_PYPI")
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "true"


@pytest.mark.skipif(os.name == "nt", reason="The release workflow runs on Linux.")
def test_hosted_gate_watches_the_exact_tag_push(tmp_path: Path, monkeypatch) -> None:
    gh = tmp_path / "gh"
    gh.write_text(
        "#!/usr/bin/env bash\n"
        'printf "%s\\n" "$*" >> calls\n'
        'if [[ "$1 $2" == "run list" ]]; then printf "24601\\n"; fi\n',
        encoding="utf-8",
    )
    gh.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
    commit = "a" * 40
    result = _just(tmp_path, "_wait-release-ci", "v0.2.0rc1", commit)
    assert result.returncode == 0, result.stderr
    listing, watching = (tmp_path / "calls").read_text(encoding="utf-8").splitlines()
    assert (
        f"--workflow ci.yml --event push --branch v0.2.0rc1 --commit {commit}"
        in listing
    )
    assert watching == "run watch --repo markur4/LTCook 24601 --exit-status"
