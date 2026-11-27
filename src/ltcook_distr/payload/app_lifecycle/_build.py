"""Identify production assets from the Python bundle and deployed files."""

from __future__ import annotations

import hashlib
import json
import stat
from importlib import resources
from pathlib import Path, PurePosixPath
from typing import TypedDict
from zipfile import BadZipFile, ZipFile

from ._common import SetupError, no_links

BUILD_MANIFEST = ".ltcook-build.json"
_DECLARATIONS = {"package.json", "package-lock.json", ".node-version"}
_PAYLOAD_DIRECTORIES = {"runtime", "teams", "services"}
_EXCLUDED = {"node_modules", ".git", ".cache"}


class BuildManifest(TypedDict):
    fingerprint: str
    files: dict[str, str]


def _production_file(path: PurePosixPath) -> bool:
    return bool(path.parts) and (
        path.as_posix() in _DECLARATIONS
        or (
            path.parts[0] in _PAYLOAD_DIRECTORIES
            and not _EXCLUDED.intersection(path.parts)
        )
    )


def _manifest(files: dict[str, str]) -> BuildManifest:
    digest = hashlib.sha256()
    for name in sorted(files):
        digest.update(f"{name}\0{files[name]}\n".encode())
    return {"fingerprint": digest.hexdigest(), "files": files}


def _file_digest(path: Path) -> str:
    no_links(path)
    if not stat.S_ISREG(path.stat().st_mode):
        raise SetupError(f"Production payload file is not regular: {path.name}")
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def source_build(root: Path) -> BuildManifest:
    """Read the exact production files copied by lifecycle preparation."""
    required = [root / name for name in _DECLARATIONS]
    for directory in _PAYLOAD_DIRECTORIES:
        required.extend(
            path
            for path in (root / directory).rglob("*")
            if _production_file(PurePosixPath(path.relative_to(root).as_posix()))
            and (path.is_symlink() or path.is_file())
        )
    return _manifest(
        {path.relative_to(root).as_posix(): _file_digest(path) for path in required}
    )


def packaged_build() -> BuildManifest:
    """Derive expected identity from the active Python distribution's bundle."""
    bundle = resources.files("ltcook_distr").joinpath("bundle.zip")
    try:
        with bundle.open("rb") as stream, ZipFile(stream) as archive:
            files: dict[str, str] = {}
            for member in archive.infolist():
                name = member.filename
                path = PurePosixPath(name)
                if not _production_file(path):
                    continue
                if (
                    path.is_absolute()
                    or ".." in path.parts
                    or path.as_posix() != name
                    or any(character in name for character in "\\\0\r\n:")
                    or name in files
                ):
                    raise SetupError(
                        "The packaged runtime contains an invalid asset path."
                    )
                with archive.open(member) as asset:
                    digest = hashlib.sha256()
                    for chunk in iter(lambda: asset.read(256 * 1024), b""):
                        digest.update(chunk)
                    files[name] = digest.hexdigest()
    except (OSError, BadZipFile) as error:
        raise SetupError(
            "Could not read the registered Python build's runtime bundle."
        ) from error
    if not (_DECLARATIONS | {"runtime/dist/main.js"}).issubset(files):
        raise SetupError("The registered Python build's runtime bundle is incomplete.")
    return _manifest(files)


def verify_deployed_build(app: Path, expected: BuildManifest) -> bool:
    """Check the staged manifest and independently verify the deployed payload."""
    manifest = app / BUILD_MANIFEST
    no_links(manifest)
    if not manifest.is_file():
        return False
    try:
        return (
            json.loads(manifest.read_text(encoding="utf-8")) == expected
            and source_build(app) == expected
        )
    except (OSError, ValueError):
        return False
