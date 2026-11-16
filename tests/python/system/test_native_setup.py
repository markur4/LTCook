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

ROOT = Path(__file__).resolve().parents[3]


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
