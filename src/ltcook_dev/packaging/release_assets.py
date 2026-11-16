"""Stage and validate local release assets without publishing them."""

from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass
from pathlib import Path

from .package_validation import validate_package
from .release_manifest import (
    MANIFEST_NAME,
    expected_asset_names,
    manifest_bytes,
    validate_manifest,
)

SHA_RE = re.compile(r"^[0-9a-f]{40,64}$")


class ReleaseError(RuntimeError):
    """Raised when release identity or local payload is invalid."""


@dataclass(frozen=True, slots=True)
class Identity:
    """Identity included in the local release manifest."""

    repository: str
    tag: str
    commit: str


def _repository(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value):
        raise ReleaseError("Repository must be OWNER/REPO.")
    return value


def _tag(value: str) -> str:
    if not re.fullmatch(
        r"v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", value
    ):
        raise ReleaseError("Tag must be vMAJOR.MINOR.PATCH.")
    return value


def _sha(value: str) -> str:
    if not SHA_RE.fullmatch(value):
        raise ReleaseError("Commit must be a full immutable Git commit SHA.")
    return value


def _project() -> tuple[str, str]:
    try:
        with Path("pyproject.toml").open("rb") as stream:
            project = tomllib.load(stream)["project"]
        name, version = project["name"], project["version"]
    except (OSError, KeyError, TypeError, tomllib.TOMLDecodeError) as exc:
        raise ReleaseError(
            "Cannot read project name and version from pyproject.toml."
        ) from exc
    if not isinstance(name, str) or not isinstance(version, str):
        raise ReleaseError("Project name and version must be strings.")
    return name, version


def _project_app_id(distribution: str) -> str:
    """Read only portable author identity, never application configuration."""
    with Path("pyproject.toml").open("rb") as stream:
        metadata = tomllib.load(stream)
    value = (
        metadata.get("tool", {})
        .get("apprc", {})
        .get("distribution", {})
        .get("app-id", re.sub(r"[-_.]+", "-", distribution).lower())
    )
    if not isinstance(value, str):
        raise ReleaseError("Release app-id must be a string.")
    return value


def _check_asset_names(names: list[str], *, app_id: str) -> tuple[str, ...]:
    try:
        return expected_asset_names(names, app_id=app_id)
    except ValueError as error:
        raise ReleaseError(str(error)) from error


def _validate_local_files(
    directory: Path,
    names: list[str],
    identity: Identity,
    *,
    expected_version: str | None = None,
) -> dict[str, bytes]:
    _check_asset_names(names, app_id=_project_app_id(_project()[0]))
    name, current_version = _project()
    version = current_version if expected_version is None else expected_version
    if identity.tag != f"v{version}":
        raise ReleaseError("Project version does not match the release tag.")
    if {entry.name for entry in directory.iterdir()} != set(names):
        raise ReleaseError(
            "Staging directory contains missing or unexpected release files."
        )
    payload: dict[str, bytes] = {}
    for filename in names:
        path = directory / filename
        if not path.is_file() or path.is_symlink():
            raise ReleaseError(f"Release asset is not a regular file: {filename}.")
        payload[filename] = path.read_bytes()
    try:
        validate_manifest(
            payload,
            app_id=_project_app_id(name),
            distribution=re.sub(r"[-_.]+", "-", name).lower(),
            version=version,
            commit=identity.commit,
        )
    except ValueError as error:
        raise ReleaseError(str(error)) from error
    for filename, content in payload.items():
        if filename.endswith((".whl", ".tar.gz")):
            validate_package(directory / filename, name, version, content)
    return payload


def stage(
    directory: Path,
    names: list[str],
    *,
    repository: str,
    tag: str,
    commit: str,
) -> tuple[str, ...]:
    """Create integrity metadata after final packages and native build.

    :param directory: Dedicated final release staging directory.
    :param names: Package, Linux setup, and checksum names excluding the manifest.
    :param repository: Explicit owner/repository release identity.
    :param tag: Exact version tag; no tag is created.
    :param commit: Immutable source identity; no Git mutation is performed.
    :return: Complete sorted asset list, including the manifest.
    """
    identity = Identity(_repository(repository), _tag(tag), _sha(commit))
    name, version = _project()
    if identity.tag != f"v{version}":
        raise ReleaseError("Project version does not match the release tag.")
    complete = [*names, MANIFEST_NAME]
    try:
        expected_asset_names(complete, app_id=_project_app_id(name))
        if {entry.name for entry in directory.iterdir()} - set(complete):
            raise ReleaseError("Staging directory contains unexpected release files.")
        payload: dict[str, bytes] = {}
        for filename in names:
            path = directory / filename
            if not path.is_file() or path.is_symlink():
                raise ReleaseError(f"Release asset is not a regular file: {filename}.")
            payload[filename] = path.read_bytes()
        for filename, content in payload.items():
            if filename.endswith((".whl", ".tar.gz")):
                validate_package(directory / filename, name, version, content)
        content = manifest_bytes(
            payload,
            app_id=_project_app_id(name),
            distribution=re.sub(r"[-_.]+", "-", name).lower(),
            version=version,
            commit=identity.commit,
        )
    except ValueError as error:
        raise ReleaseError(str(error)) from error
    (directory / MANIFEST_NAME).write_bytes(content)
    _validate_local_files(directory, complete, identity)
    return tuple(sorted(complete))
