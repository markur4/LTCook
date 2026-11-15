"""Focused packaging checks and isolated native-install system smoke."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path, PurePosixPath

import pytest
from apprc.definition.installation import EditableCheckout
from apprc.distribution import decode_native_binding, read_project_metadata
from apprc.distribution.runtime import materialize_project_snapshot
from apprc.user_files.installation.discovery import (
    inspect_installation,
    installation_directory,
)

ROOT = Path(__file__).resolve().parents[1]


def _asset_source(root: Path) -> Path:
    root.mkdir(parents=True)
    for name in ("package.json", "package-lock.json", ".node-version"):
        (root / name).write_text("declaration", encoding="utf-8")
    (root / "runtime").mkdir(parents=True)
    (root / "runtime/package.json").write_text("{}", encoding="utf-8")
    (root / "runtime/dist/integrations").mkdir(parents=True)
    (root / "runtime/dist/main.js").write_text("runtime", encoding="utf-8")
    (root / "runtime/dist/integrations/pi-rpc.js").write_text("rpc", encoding="utf-8")
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
    for resource in ("rules/planning.md", "skills/ltcook-planning/SKILL.md"):
        path = root / "runtime/resources" / resource
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("required Core guidance", encoding="utf-8")
    plugin = root / "runtime/dist/paseo-plugin"
    for name in (
        "paseo-plugin.json",
        "index.server.ts",
        "index.client.tsx",
        "shared/evals.ts",
        "shared/panel-snapshot.ts",
        "shared/panel-details.ts",
        "shared/view-model.ts",
        "client/use-team-panel.ts",
        "client/components/PanelChrome.tsx",
        "client/components/StatusBadge.tsx",
        "client/screens/TeamOverview.tsx",
        "client/screens/TaskBoard.tsx",
        "client/screens/AgentFocus.tsx",
    ):
        path = plugin / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("plugin", encoding="utf-8")
    for team in ("default", "default-minimal"):
        (root / f"teams/{team}/dist").mkdir(parents=True)
        (root / f"teams/{team}/resources").mkdir(parents=True)
        (root / f"teams/{team}/package.json").write_text("{}", encoding="utf-8")
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
    assert "runtime/dist/workflow-api/index.js" in names
    assert "runtime/resources/skills/ltcook-planning/SKILL.md" in names
    assert "teams/default-minimal/dist/index.js" in names
    assert all("node_modules" not in name for name in names)
    with zipfile.ZipFile(first) as archive:
        assert archive.read(".ltcook-bundle") == b"ltcook\n"
        assert all(
            info.date_time == (1980, 1, 1, 0, 0, 0) for info in archive.infolist()
        )


def test_rebuild_replaces_owned_generated_output_with_current_assets(
    tmp_path: Path,
) -> None:
    """An old compiler output can be rebuilt while install inputs remain strict."""
    from ltcook_dev.packaging.package_assets import archive_assets, validate_bundle

    root = _asset_source(tmp_path / "source")
    destination = tmp_path / "bundle.zip"
    with zipfile.ZipFile(destination, "w") as archive:
        archive.writestr(".ltcook-bundle", b"ltcook\n")
    with pytest.raises(ValueError):
        validate_bundle(destination)
    archive_assets(root, destination)
    assert "runtime/dist/workflow-api/index.js" in validate_bundle(destination)


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


def _wait_for_retained_removal(authority: Path, app_id: str) -> None:
    """Wait for finalization before reusing an installation's retained resources.

    :param authority: Isolated installation authority directory.
    :param app_id: Expected application identity.
    """
    deadline = time.monotonic() + 30
    while True:
        final = inspect_installation(authority, app_id=app_id)
        if final.status == "removed-retained" or time.monotonic() >= deadline:
            break
        time.sleep(0.05)
    assert final.status == "removed-retained", final.diagnostics


@pytest.mark.system
@pytest.mark.skipif(sys.platform != "linux", reason="Native setup smoke is Linux-only.")
def test_native_setup_initializes_ready_authority_and_retains_resources(
    tmp_path: Path,
) -> None:
    """Prove native/editable retention and reject an unowned command collision."""
    setup = Path(
        os.environ.get(
            "LTCOOK_NATIVE_SETUP", str(ROOT / "dist/ltcook-setup-linux-x86_64")
        )
    )
    if not setup.is_file():
        pytest.skip("Build the Linux native setup before running this system smoke.")
    setup = setup.resolve(strict=True)
    home, command_bin = tmp_path / "home", tmp_path / "bin"
    home.mkdir()
    command_bin.mkdir()
    pi_auth = home / ".pi/agent/auth.json"
    pi_auth.parent.mkdir(parents=True)
    pi_auth.write_bytes(b'{"fixture":"retain shared Pi authentication"}\n')
    pi_auth_bytes = pi_auth.read_bytes()
    environment = os.environ.copy()
    for key in ("PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT"):
        environment.pop(key, None)
    for key in tuple(environment):
        if key.startswith(("LTCOOK_", "PASEO_", "PI_")):
            environment.pop(key)
    environment.update(
        HOME=str(home),
        USERPROFILE=str(home),
        XDG_DATA_HOME=str(home / "data"),
        XDG_CONFIG_HOME=str(home / "config"),
        XDG_CACHE_HOME=str(home / "cache"),
        XDG_STATE_HOME=str(home / "state"),
    )
    environment.update(
        PATH=f"{command_bin}{os.pathsep}{environment.get('PATH', '')}",
        LTCOOK_SERVICE_CONNECTION="direct",
        LTCOOK_BROWSER_ENABLED="false",
    )
    installed = subprocess.run(
        [
            str(setup),
            "--yes",
            "--skip-setup",
            "--command-directory",
            str(command_bin),
        ],
        cwd=tmp_path,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )
    assert installed.returncode == 0, installed.stdout + installed.stderr
    metadata = read_project_metadata(ROOT)
    authority = installation_directory(
        metadata.identity.app_id, environment=environment
    )
    inspection = inspect_installation(authority, app_id=metadata.identity.app_id)
    assert inspection.status == "ready", inspection.diagnostics
    record = inspection.record
    assert record is not None
    assert record.schema_version == 3
    command = command_bin / metadata.identity.commands[0]
    assert command.is_file()
    sentinels = []
    for kind, root in (
        ("config", record.placement.config_dir),
        ("appdata", record.placement.appdata_dir),
        ("cache", record.placement.cache_dir),
        ("state", record.placement.state_dir),
    ):
        assert root is not None
        sentinel = root / "retained-resource"
        sentinel.write_text(kind, encoding="utf-8")
        sentinels.append((sentinel, kind))
    removed = subprocess.run(
        ["ltcook", "app", "uninstall", "--yes"],
        cwd=tmp_path,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
        timeout=120,
    )
    assert removed.returncode == 0, removed.stdout + removed.stderr
    _wait_for_retained_removal(authority, metadata.identity.app_id)
    assert not command.exists()
    for sentinel, content in sentinels:
        assert sentinel.read_text(encoding="utf-8") == content
    assert pi_auth.read_bytes() == pi_auth_bytes

    uv = shutil.which("uv", path=environment["PATH"])
    assert uv is not None, "The editable system smoke requires uv on PATH."
    exported = tmp_path / "editable-checkout"
    snapshot = tmp_path / "editable-source.zip"
    with zipfile.ZipFile(setup) as product:
        binding = decode_native_binding(product.read("binding.json"))
        snapshot.write_bytes(product.read("project.zip"))
    materialize_project_snapshot(snapshot, exported, binding.source)
    checkout = exported.joinpath(*PurePosixPath(binding.source.project_path).parts)
    editable_environment = checkout / ".venv"
    editable_shell = dict(environment, UV_PROJECT_ENVIRONMENT=str(editable_environment))
    synchronized = subprocess.run(
        [uv, "sync", "--locked", "--no-dev", "--python", binding.selection.python],
        cwd=checkout,
        env=editable_shell,
        text=True,
        capture_output=True,
        check=False,
        timeout=600,
    )
    assert synchronized.returncode == 0, synchronized.stdout + synchronized.stderr
    editable_command = editable_environment / "bin/ltcook"
    assert editable_command.is_file()
    checkout_sentinel = checkout / "retained-checkout"
    checkout_sentinel.write_bytes(b"developer-owned checkout\n")
    environment_sentinel = editable_environment / "retained-environment"
    environment_sentinel.write_bytes(b"developer-owned environment\n")
    assert record.placement.appdata_dir is not None
    runtime_receipt = record.placement.appdata_dir / "deployment/runtime.json"
    retained_files = {
        path: path.read_bytes()
        for path in (
            checkout_sentinel,
            environment_sentinel,
            checkout / "pyproject.toml",
            checkout / "uv.lock",
            editable_environment / "pyvenv.cfg",
            editable_command,
            runtime_receipt,
            pi_auth,
        )
    }
    install_arguments = [
        str(editable_command),
        "app",
        "install",
        "-e",
        "--yes",
        "--skip-setup",
        "--command-directory",
        str(command_bin),
    ]

    unowned_bytes = b"#!/bin/sh\nprintf '%s\\n' 'unowned command'\n"
    command.write_bytes(unowned_bytes)
    command.chmod(0o751)
    unowned_mode = command.stat().st_mode
    before_collision = inspect_installation(authority, app_id=metadata.identity.app_id)
    collision = subprocess.run(
        install_arguments,
        cwd=checkout,
        env=editable_shell,
        text=True,
        capture_output=True,
        check=False,
        timeout=120,
    )
    assert collision.returncode != 0, collision.stdout + collision.stderr
    assert not command.is_symlink()
    assert command.read_bytes() == unowned_bytes
    assert command.stat().st_mode == unowned_mode
    after_collision = inspect_installation(authority, app_id=metadata.identity.app_id)
    assert after_collision.status == before_collision.status == "removed-retained"
    assert after_collision.revision == before_collision.revision
    for path, content in retained_files.items():
        assert path.read_bytes() == content
    command.unlink()

    registered = subprocess.run(
        install_arguments,
        cwd=checkout,
        env=editable_shell,
        text=True,
        capture_output=True,
        check=False,
        timeout=120,
    )
    assert registered.returncode == 0, registered.stdout + registered.stderr
    editable_inspection = inspect_installation(
        authority, app_id=metadata.identity.app_id
    )
    assert editable_inspection.status == "ready", editable_inspection.diagnostics
    editable_record = editable_inspection.record
    assert editable_record is not None
    assert isinstance(editable_record.active_runtime, EditableCheckout)
    assert editable_record.active_runtime.project == checkout.resolve()
    assert editable_record.active_runtime.environment == editable_environment.resolve()
    assert command.is_symlink()
    assert command.resolve(strict=True) == editable_command.resolve(strict=True)
    for path, content in retained_files.items():
        assert path.read_bytes() == content
    for sentinel, content in sentinels:
        assert sentinel.read_text(encoding="utf-8") == content

    editable_removed = subprocess.run(
        ["ltcook", "app", "uninstall", "--yes"],
        cwd=tmp_path,
        env=editable_shell,
        text=True,
        capture_output=True,
        check=False,
        timeout=120,
    )
    assert editable_removed.returncode == 0, (
        editable_removed.stdout + editable_removed.stderr
    )
    _wait_for_retained_removal(authority, metadata.identity.app_id)
    assert not command.exists()
    assert not command.is_symlink()
    assert checkout.is_dir()
    assert editable_environment.is_dir()
    for path, content in retained_files.items():
        assert path.read_bytes() == content
    for sentinel, content in sentinels:
        assert sentinel.read_text(encoding="utf-8") == content
    surviving_environment = subprocess.run(
        [
            str(editable_environment / "bin/python"),
            "-I",
            "-c",
            (
                "import sys; from importlib.metadata import version; "
                "print(sys.prefix); print(version('ltcook'))"
            ),
        ],
        cwd=tmp_path,
        env=editable_shell,
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )
    assert surviving_environment.returncode == 0, surviving_environment.stderr
    assert surviving_environment.stdout.splitlines() == [
        str(editable_environment.resolve()),
        binding.version,
    ]


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
