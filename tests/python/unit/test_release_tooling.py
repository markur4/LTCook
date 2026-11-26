"""Offline contracts for the committed release policy and hosted CI selection."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from ltcook_dev.packaging import release_assets

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


@pytest.mark.parametrize(
    "change", ["version-only", "source", "dependency", "tag", "ci"]
)
def test_stable_ci_reuses_only_successful_equivalent_rc_evidence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: str
) -> None:
    monkeypatch.chdir(tmp_path)
    _git(tmp_path, "init", "-b", "main")
    _git(tmp_path, "config", "user.name", "Release fixture")
    _git(tmp_path, "config", "user.email", "fixture@example.invalid")
    candidate, stable = "v0.2.0rc1", "v0.2.0"
    metadata, lock, source = (
        tmp_path / "pyproject.toml",
        tmp_path / "uv.lock",
        tmp_path / "app.py",
    )
    metadata.write_text(
        f'[project]\nname = "ltcook"\nversion = "{candidate[1:]}"\n',
        encoding="utf-8",
    )
    lock.write_text(
        f'[[package]]\nname = "ltcook"\nversion = "{candidate[1:]}"\n'
        'source = { editable = "." }\n',
        encoding="utf-8",
    )
    (tmp_path / "pylock.toml").write_text('lock-version = "1.0"\n', encoding="utf-8")
    (tmp_path / "CHANGELOG.md").write_text("Candidate notes\n", encoding="utf-8")
    source.write_text("print('release')\n", encoding="utf-8")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "--no-gpg-sign", "-m", "Release candidate")
    _git(tmp_path, "tag", candidate)
    commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=tmp_path, text=True
    ).strip()

    for path in (metadata, lock):
        path.write_text(
            path.read_text(encoding="utf-8").replace(candidate[1:], stable[1:]),
            encoding="utf-8",
        )
    (tmp_path / "CHANGELOG.md").write_text("Stable notes\n", encoding="utf-8")
    if change == "source":
        source.write_text("print('changed')\n", encoding="utf-8")
    if change == "dependency":
        lock.write_text(
            lock.read_text(encoding="utf-8") + '[[package]]\nname = "added"\n',
            encoding="utf-8",
        )
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "--no-gpg-sign", "-m", "Stable release")
    _git(tmp_path, "tag", stable)

    def ci_runs(endpoint: str) -> dict[str, object]:
        assert change not in {"source", "dependency"}
        assert f"head_sha={commit}" in endpoint
        return {
            "workflow_runs": [
                {
                    "head_sha": commit,
                    "head_branch": "main" if change == "tag" else candidate,
                    "event": "push",
                    "conclusion": "failure" if change == "ci" else "success",
                }
            ]
        }

    monkeypatch.setattr(release_assets, "_api_object", ci_runs)
    assert release_assets.reuse_rc("markur4/LTCook", stable) is (
        change == "version-only"
    )


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
