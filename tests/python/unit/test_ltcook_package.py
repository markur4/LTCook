"""Focused packaging checks and isolated native-install system smoke."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest


def _asset_source(root: Path) -> Path:
    root.mkdir(parents=True)
    for name in ("package.json", "package-lock.json", ".node-version"):
        (root / name).write_text("declaration", encoding="utf-8")
    (root / "runtime").mkdir(parents=True)
    (root / "runtime/package.json").write_text("{}", encoding="utf-8")
    (root / "runtime/dist/integrations").mkdir(parents=True)
    (root / "runtime/dist/main.js").write_text("runtime", encoding="utf-8")
    idle_restart = root / "runtime/dist/paseo-idle-restart"
    idle_restart.mkdir()
    for name in ("register.mjs", "patch.mjs", "gate.mjs"):
        (idle_restart / name).write_text("export {};", encoding="utf-8")
    (root / "runtime/dist/integrations/pi-rpc.js").write_text("rpc", encoding="utf-8")
    (root / "runtime/dist/tools").mkdir()
    (root / "runtime/dist/tools/web-mcp.js").write_text("web", encoding="utf-8")
    (root / "runtime/dist/tools/pi-web-access.LICENSE").write_text(
        "MIT", encoding="utf-8"
    )
    for entry in (
        "dist/evals/worker.js",
        "resources/evals/manifest.json",
        "resources/evals/verify.cjs",
    ):
        asset = root / "runtime" / entry
        asset.parent.mkdir(parents=True, exist_ok=True)
        asset.write_text("evaluation asset", encoding="utf-8")
    for boundary in ("team-api", "guidance-api", "workflow-api"):
        path = root / "runtime/dist" / boundary / "index.js"
        path.parent.mkdir()
        path.write_text("export {};", encoding="utf-8")
        source = root / "runtime/src" / boundary / "index.ts"
        source.parent.mkdir(parents=True)
        source.write_text("export {};", encoding="utf-8")
    (root / "runtime/src/workflow-api/commands.ts").write_text(
        "export {};", encoding="utf-8"
    )
    contracts = root / "runtime/src/models/contracts"
    (contracts / "dist").mkdir(parents=True)
    (contracts / "package.json").write_text(
        '{"name":"@ltcook/model-contracts"}', encoding="utf-8"
    )
    (contracts / "index.ts").write_text("export {};", encoding="utf-8")
    (contracts / "dist/index.js").write_text("export {};", encoding="utf-8")
    for resource in ("rules/planning.md", "skills/ltcook-planning/SKILL.md"):
        path = root / "runtime/resources" / resource
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("required Core guidance", encoding="utf-8")
    web_ui = root / "runtime/dist/paseo-web"
    for name in (
        "index.html",
        "ltcook-paseo-build.json",
        "_expo/static/js/web/fixture.js",
    ):
        asset = web_ui / name
        asset.parent.mkdir(parents=True, exist_ok=True)
        asset.write_text("patched Paseo asset", encoding="utf-8")
    plugin = root / "runtime/dist/paseo-plugin"
    for name in (
        "paseo-plugin.json",
        "index.server.ts",
        "index.client.tsx",
        "shared/evals.ts",
        "shared/team-catalog.ts",
        "shared/panel-snapshot.ts",
        "shared/panel-details.ts",
        "shared/view-model.ts",
        "client/use-team-panel.ts",
        "client/use-team-catalog.ts",
        "client/components/PanelChrome.tsx",
        "client/components/StatusBadge.tsx",
        "client/screens/Diagnostics.tsx",
        "client/screens/TeamStatus.tsx",
        "client/screens/TeamOverview.tsx",
        "client/screens/TeamsBrowser.tsx",
        "client/components/TeamComposerItem.tsx",
        "client/screens/TaskBoard.tsx",
        "client/screens/AgentFocus.tsx",
    ):
        path = plugin / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("plugin", encoding="utf-8")
    for team in ("default", "default-minimal"):
        (root / f"teams/{team}/dist").mkdir(parents=True)
        (root / f"teams/{team}/resources").mkdir(parents=True)
        (root / f"teams/{team}/package.json").write_text(
            json.dumps({"name": f"@ltcook/team-{team}"}), encoding="utf-8"
        )
        (root / f"teams/{team}/dist/index.js").write_text(team, encoding="utf-8")
        (root / f"teams/{team}/resources/rules.md").write_text(team, encoding="utf-8")
    (root / "services").mkdir()
    (root / "services/compose.yaml").write_text("services: {}", encoding="utf-8")
    return root


def test_bundle_archive_is_deterministic_and_excludes_development_installs(
    tmp_path: Path,
) -> None:
    """Fixed ZIP metadata and sorted names make equal production bytes reproducible."""
    from ltcook_dev.packaging.package_assets import archive_assets, validate_bundle

    root = _asset_source(tmp_path / "source")
    (root / "runtime/node_modules").mkdir()
    (root / "runtime/node_modules/private").write_text("not shipped")
    external = tmp_path / "work"
    external.mkdir()
    first = archive_assets(root, tmp_path / "first.zip", staging_parent=external)
    second = archive_assets(root, tmp_path / "second.zip", staging_parent=external)
    assert first.read_bytes() == second.read_bytes()
    names = validate_bundle(first)
    assert names == tuple(sorted(names))
    assert "runtime/dist/main.js" in names
    assert "runtime/dist/tools/web-mcp.js" in names
    assert "runtime/dist/tools/pi-web-access.LICENSE" in names
    assert "runtime/dist/workflow-api/index.js" in names
    assert "runtime/src/models/contracts/package.json" in names
    assert "runtime/src/models/contracts/index.ts" in names
    assert "runtime/src/models/contracts/dist/index.js" in names
    assert "runtime/resources/skills/ltcook-planning/SKILL.md" in names
    assert "teams/default-minimal/dist/index.js" in names
    assert all("node_modules" not in name for name in names)
    with zipfile.ZipFile(first) as archive:
        assert archive.read(".ltcook-bundle") == b"ltcook\n"
        assert all(
            info.date_time == (1980, 1, 1, 0, 0, 0) for info in archive.infolist()
        )


def test_bundle_includes_all_local_team_workspaces(tmp_path: Path) -> None:
    """Additional managed Teams survive staging and incomplete packages fail."""
    from ltcook_dev.packaging.package_assets import archive_assets, validate_bundle

    root = _asset_source(tmp_path / "source")
    extra = root / "teams/another"
    shutil.copytree(root / "teams/default-minimal", extra)
    (extra / "package.json").write_text(
        json.dumps({"name": "@ltcook/team-another"}), encoding="utf-8"
    )
    result = archive_assets(root, tmp_path / "bundle.zip")
    assert "teams/another/dist/index.js" in validate_bundle(result)
    shutil.rmtree(extra / "dist")
    with pytest.raises(FileNotFoundError, match="Required production assets"):
        archive_assets(root, tmp_path / "incomplete.zip")


def test_rebuild_replaces_owned_generated_output_with_current_assets(
    tmp_path: Path,
) -> None:
    """Rebuild a stale archive before the updater has synced Python packages."""
    from ltcook_dev.packaging.package_assets import validate_bundle

    root = _asset_source(tmp_path / "source")
    destination = tmp_path / "bundle.zip"
    with zipfile.ZipFile(destination, "w") as archive:
        archive.writestr(".ltcook-bundle", b"ltcook\n")
    with pytest.raises(ValueError):
        validate_bundle(destination)
    source = Path(__file__).resolve().parents[3] / "src"
    subprocess.run(
        [
            sys.executable,
            "-S",
            "-m",
            "ltcook_dev.packaging.package_assets",
            "--root",
            str(root),
            "--destination",
            str(destination),
        ],
        env={**os.environ, "PYTHONPATH": str(source)},
        check=True,
        timeout=30,
    )
    validate_bundle(destination)
    with zipfile.ZipFile(destination) as archive:
        assert archive.read("runtime/dist/main.js") == b"runtime"


@pytest.mark.skipif(
    os.name != "posix", reason="Symlink safety coverage is Unix-specific."
)
def test_bundle_archive_rejects_linked_output_and_unsafe_members(
    tmp_path: Path,
) -> None:
    """Archive writes do not follow a linked output and reject traversal paths."""
    from ltcook_dev.packaging.package_assets import archive_assets, validate_bundle

    root = _asset_source(tmp_path / "source")
    target = tmp_path / "target"
    target.write_text("unchanged")
    link = tmp_path / "bundle.zip"
    link.symlink_to(target)
    with pytest.raises(ValueError, match="link"):
        archive_assets(root, link)
    assert target.read_text() == "unchanged"
    unsafe = tmp_path / "unsafe.zip"
    with zipfile.ZipFile(unsafe, "w") as archive:
        archive.writestr("../escape", "bad")
    with pytest.raises(ValueError, match="Unsafe production bundle member"):
        validate_bundle(unsafe)


@pytest.mark.skipif(
    os.name != "posix", reason="Symlink safety coverage is Unix-specific."
)
def test_stage_assets_refuses_linked_bundle_and_staging_paths(tmp_path: Path) -> None:
    """Directory staging does not follow linked owned output or temporary paths."""
    from ltcook_dev.packaging.package_assets import archive_assets, stage_assets

    root = _asset_source(tmp_path / "source")
    target = tmp_path / "target"
    target.mkdir()
    (target / "sentinel").write_text("unchanged")
    bundle_link = tmp_path / "bundle"
    bundle_link.symlink_to(target, target_is_directory=True)
    with pytest.raises(ValueError):
        stage_assets(root, bundle_link)
    external_link = tmp_path / "external-link"
    external_link.symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError):
        archive_assets(root, tmp_path / "result.zip", staging_parent=external_link)
    assert (target / "sentinel").read_text() == "unchanged"


@pytest.mark.parametrize(
    "entry",
    [
        "dist/evals/worker.js",
        "resources/evals/manifest.json",
        "resources/evals/verify.cjs",
    ],
)
def test_bundle_rejects_missing_evaluation_assets(tmp_path: Path, entry: str) -> None:
    from ltcook_dev.packaging.package_assets import archive_assets

    source = _asset_source(tmp_path / "source")
    (source / "runtime" / entry).unlink()
    with pytest.raises(FileNotFoundError, match="required before staging"):
        archive_assets(source, tmp_path / "bundle.zip")
