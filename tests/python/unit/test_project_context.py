"""Project facts stay declarative, cached and independent of fresh Git status."""

import json

from ltcook import project_context


def test_snapshot_refreshes_sources_and_git_without_running_project_scripts(
    tmp_path, monkeypatch
):
    workspace = tmp_path / "project"
    workspace.mkdir()
    cache = tmp_path / "cache"
    sentinel = tmp_path / "script-ran"
    manifest = workspace / "package.json"
    manifest.write_text(
        json.dumps({"name": "example", "scripts": {"test": f"touch {sentinel}"}})
    )
    (workspace / "pyproject.toml").write_text(
        '[project]\nname = "example-python"\nversion = "0.1"\n'
    )
    (workspace / "justfile").write_text("test:\n    echo {{variable}}\n")
    calls = []
    git_status = ["?? first.txt"]
    monkeypatch.setattr(
        project_context,
        "_tool",
        lambda name, _workspace: "/bin/sh" if name == "git" else None,
    )

    def run(arguments, root):
        calls.append(arguments)
        assert root == workspace
        if "--version" in arguments:
            return "git version test"
        if "--show-toplevel" in arguments:
            return str(workspace)
        if "--abbrev-ref" in arguments:
            return "main"
        assert "status" in arguments
        assert "core.fsmonitor=false" in arguments
        return git_status[0]

    monkeypatch.setattr(project_context, "_run", run)
    first = project_context.project_snapshot(workspace, cache)
    assert first["cache"]["reused"] is False
    assert first["facts"]["manifests"][0]["commands"]["test"] == f"touch {sentinel}"
    assert first["facts"]["justRecipes"] == [
        {"name": "test", "definition": "test:\n    echo {{variable}}"}
    ]
    assert first["facts"]["manifests"][1]["languages"] == ["Python"]
    versions_before = sum("--version" in call for call in calls)
    git_status[0] = " M changed.txt"
    second = project_context.project_snapshot(workspace, cache)
    assert second["cache"]["reused"] is True
    assert second["git"]["status"] == " M changed.txt"
    assert sum("--version" in call for call in calls) == versions_before
    manifest.write_text('{"name":"changed","scripts":{"build":"never-run"}}')
    third = project_context.project_snapshot(workspace, cache)
    assert third["cache"]["reused"] is False
    assert third["facts"]["manifests"][0]["packages"][0]["name"] == "changed"
    assert not sentinel.exists()


def test_snapshot_reports_partial_sources_and_skips_linked_manifests(
    tmp_path, monkeypatch
):
    workspace = tmp_path / "project"
    workspace.mkdir()
    (workspace / "pyproject.toml").write_text("invalid [toml")
    target = tmp_path / "private.json"
    target.write_text('{"name":"must-not-inspect"}')
    (workspace / "package.json").symlink_to(target)
    monkeypatch.setattr(project_context, "_tool", lambda *_args: None)
    result = project_context.project_snapshot(workspace, tmp_path / "cache")
    assert result["facts"]["manifests"] == []
    assert any("package.json" in item for item in result["incomplete"])
    assert any("pyproject.toml" in item for item in result["incomplete"])
    assert "error" in result["git"]


def test_project_executables_are_not_used_for_version_probes(tmp_path, monkeypatch):
    executable = tmp_path / "node"
    executable.write_text("#!/bin/sh\nexit 99\n")
    monkeypatch.setattr(project_context.shutil, "which", lambda _: str(executable))
    assert project_context._tool("node", tmp_path) is None
