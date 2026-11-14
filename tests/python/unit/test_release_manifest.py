"""Release manifest identity and Linux checksum contract regressions."""

from __future__ import annotations

import hashlib
import io
import json
import tarfile
import zipfile
from dataclasses import replace
from pathlib import Path

import pytest

from ltcook_dev.packaging.release_manifest import (
    MANIFEST_NAME,
    manifest_bytes,
    validate_manifest,
)

APP_ID = "ltcook"
DISTRIBUTION = "ltcook"
VERSION = "0.1.0"
COMMIT = "0123456789abcdef0123456789abcdef01234567"
SETUP = "ltcook-setup-linux-x86_64"


def _payload() -> dict[str, bytes]:
    setup = b"native setup"
    return {
        "ltcook-0.1.0-py3-none-any.whl": b"wheel",
        "ltcook-0.1.0.tar.gz": b"sdist",
        SETUP: setup,
        "SHA256SUMS": f"{hashlib.sha256(setup).hexdigest()}  {SETUP}\n".encode(),
    }


def _complete(payload: dict[str, bytes]) -> dict[str, bytes]:
    result = dict(payload)
    result[MANIFEST_NAME] = manifest_bytes(
        payload,
        app_id=APP_ID,
        distribution=DISTRIBUTION,
        version=VERSION,
        commit=COMMIT,
    )
    return result


def test_schema_two_manifest_binds_exact_linux_asset_set_and_identity() -> None:
    """A valid manifest has exact identities and a one-file checksum set."""
    payload = _complete(_payload())
    names = validate_manifest(
        payload,
        app_id=APP_ID,
        distribution=DISTRIBUTION,
        version=VERSION,
        commit=COMMIT,
    )
    assert set(names) == set(payload)
    assert json.loads(payload[MANIFEST_NAME])["schema_version"] == 2


def test_manifest_rejects_stale_identity_checksum_mismatch_and_extra_assets() -> None:
    """Identity drift and checksum additions cannot pass an otherwise valid manifest."""
    payload = _complete(_payload())
    with pytest.raises(ValueError, match="identity does not match"):
        validate_manifest(
            payload,
            app_id=APP_ID,
            distribution=DISTRIBUTION,
            version=VERSION,
            commit="f" * 40,
        )
    corrupt = dict(payload)
    corrupt["SHA256SUMS"] = b"0" * 64 + b"  " + SETUP.encode() + b"\n"
    with pytest.raises(ValueError, match="SHA-256 does not match"):
        validate_manifest(
            corrupt,
            app_id=APP_ID,
            distribution=DISTRIBUTION,
            version=VERSION,
            commit=COMMIT,
        )
    extra = _payload()
    extra["SHA256SUMS"] += b"0" * 64 + b"  unexpected\n"
    with pytest.raises(ValueError, match="exactly the matching Linux setup"):
        validate_manifest(
            _complete(extra),
            app_id=APP_ID,
            distribution=DISTRIBUTION,
            version=VERSION,
            commit=COMMIT,
        )
    with pytest.raises(ValueError, match="missing or unexpected Linux native assets"):
        manifest_bytes(
            {key: value for key, value in _payload().items() if key != SETUP},
            app_id=APP_ID,
            distribution=DISTRIBUTION,
            version=VERSION,
            commit=COMMIT,
        )


def _release_inputs(root: Path, *, wrong_field: str | None = None) -> dict[str, bytes]:
    """Create real package metadata and an appended SDK binding for staging."""
    from apprc.definition.installation import InstallationIdentity
    from apprc.definition.paths import Layout
    from apprc.distribution import (
        AppCapabilities,
        NativeBinding,
        ProjectSnapshot,
        RuntimeSelection,
        encode_native_binding,
    )

    (root / "pyproject.toml").write_text(
        '[project]\nname = "ltcook"\nversion = "0.1.0"\n'
        'requires-python = ">=3.12"\n'
        '[project.scripts]\nltcook = "ltcook.main:main"\n'
        '[tool.apprc.distribution]\napp-id = "ltcook"\n'
        'apprc-reference = "ltcook.config.app:APP_RC"\n'
        'project-path = "."\ndistribution-path = "src/ltcook_distr"\n'
        'command-name = "ltcook"\nruntime-python = "3.12"\n',
        encoding="utf-8",
    )
    (root / "src/ltcook_distr").mkdir(parents=True)
    directory = root / "dist"
    directory.mkdir()
    metadata = b"Metadata-Version: 2.1\nName: ltcook\nVersion: 0.1.0\n"
    with zipfile.ZipFile(directory / "ltcook-0.1.0-py3-none-any.whl", "w") as wheel:
        wheel.writestr("ltcook-0.1.0.dist-info/METADATA", metadata)
    with tarfile.open(directory / "ltcook-0.1.0.tar.gz", "w:gz") as sdist:
        member = tarfile.TarInfo("ltcook-0.1.0/PKG-INFO")
        member.size = len(metadata)
        sdist.addfile(member, io.BytesIO(metadata))
    identity = InstallationIdentity(
        APP_ID, DISTRIBUTION, "ltcook", "ltcook.config.app:APP_RC", ("ltcook",)
    )
    binding = NativeBinding(
        identity=identity,
        command_name="ltcook",
        display_name="LTCook",
        version=VERSION,
        source=ProjectSnapshot("0" * 64, "1" * 64, COMMIT),
        selection=RuntimeSelection("3.12"),
        capabilities=AppCapabilities(),
        layout=Layout.native(),
        bootstrap_env_prefix="LTCOOK",
    )
    if wrong_field in {"app_id", "distribution"}:
        binding = replace(binding, identity=replace(identity, **{wrong_field: "other"}))
    elif wrong_field == "command":
        binding = replace(
            binding,
            identity=replace(identity, commands=("other",)),
            command_name="other",
        )
    elif wrong_field == "version":
        binding = replace(binding, version="0.2.0")
    elif wrong_field == "commit":
        binding = replace(binding, source=replace(binding.source, commit="f" * 40))
    executable = directory / SETUP
    executable.write_bytes(b"native executable prefix")
    with zipfile.ZipFile(executable, "a") as archive:
        archive.writestr("binding.json", encode_native_binding(binding))
    (directory / "SHA256SUMS").write_text(
        f"{hashlib.sha256(executable.read_bytes()).hexdigest()}  {SETUP}\n",
        encoding="ascii",
    )
    return {path.name: path.read_bytes() for path in directory.iterdir()}


def test_release_stage_preserves_sdk_checksums_and_stages_exact_assets(
    tmp_path, monkeypatch
) -> None:
    from ltcook_dev.packaging.release_stage import stage_release

    inputs = _release_inputs(tmp_path)
    monkeypatch.chdir(tmp_path)
    names = stage_release(f"v{VERSION}", COMMIT, root=tmp_path)
    payload = {
        name: (tmp_path / "release/assets" / name).read_bytes() for name in names
    }
    assert {
        name: data for name, data in payload.items() if name != MANIFEST_NAME
    } == inputs
    assert set(
        validate_manifest(
            payload,
            app_id=APP_ID,
            distribution=DISTRIBUTION,
            version=VERSION,
            commit=COMMIT,
        )
    ) == set(names)


@pytest.mark.parametrize(
    "field", ["app_id", "distribution", "command", "version", "commit"]
)
def test_native_release_staging_rejects_stale_binding_identity(
    tmp_path, monkeypatch, field: str
) -> None:
    from ltcook_dev.packaging.release_stage import stage_release

    _release_inputs(tmp_path, wrong_field=field)
    monkeypatch.chdir(tmp_path)
    with pytest.raises(ValueError, match="identity does not match"):
        stage_release(f"v{VERSION}", COMMIT, root=tmp_path)
    assert not (tmp_path / "release/assets").exists()


@pytest.mark.parametrize(
    "damage",
    [
        "missing-setup",
        "corrupt-setup",
        "corrupt-wheel",
        "wrong-checksum",
        "extra-checksum",
    ],
)
def test_release_stage_rejects_missing_or_corrupt_inputs_before_publication(
    tmp_path, monkeypatch, damage: str
) -> None:
    from ltcook_dev.packaging.release_stage import stage_release

    _release_inputs(tmp_path)
    directory = tmp_path / "dist"
    if damage == "missing-setup":
        (directory / SETUP).unlink()
    elif damage == "corrupt-setup":
        (directory / SETUP).write_bytes(b"not a native binding")
    elif damage == "corrupt-wheel":
        (directory / "ltcook-0.1.0-py3-none-any.whl").write_bytes(b"not a wheel")
    elif damage == "wrong-checksum":
        (directory / "SHA256SUMS").write_text(f"{'0' * 64}  {SETUP}\n")
    else:
        with (directory / "SHA256SUMS").open("a") as checksums:
            checksums.write(f"{'0' * 64}  unexpected\n")
    monkeypatch.chdir(tmp_path)
    with pytest.raises(ValueError):
        stage_release(f"v{VERSION}", COMMIT, root=tmp_path)
    assert not (tmp_path / "release/assets").exists()


def test_manifest_rejects_schema_one_even_with_matching_asset_digests() -> None:
    payload = _complete(_payload())
    manifest = json.loads(payload[MANIFEST_NAME])
    manifest["schema_version"] = 1
    payload[MANIFEST_NAME] = json.dumps(manifest).encode()
    with pytest.raises(ValueError, match="schema or"):
        validate_manifest(
            payload,
            app_id=APP_ID,
            distribution=DISTRIBUTION,
            version=VERSION,
            commit=COMMIT,
        )
