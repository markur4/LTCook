"""Validate package archives without importing release publication machinery."""

from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path, PurePosixPath


def _normalize(value: str) -> str:
    return re.sub(r"[-_.]+", "_", value).lower()


def _safe_member(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if (
        not value
        or path.is_absolute()
        or "\\" in value
        or ".." in path.parts
        or re.match(r"^[A-Za-z]:", value)
    ):
        raise ValueError(f"Unsafe archive member: {value!r}.")
    return path


def _metadata_matches(data: bytes, name: str, version: str, filename: str) -> None:
    from email.parser import BytesParser

    metadata = BytesParser().parsebytes(data)
    if (
        _normalize(metadata.get("Name", "")) != _normalize(name)
        or metadata.get("Version") != version
    ):
        raise ValueError(
            f"Package metadata in {filename} does not match {name} {version}."
        )


def validate_package(
    path: Path, name: str, version: str, data: bytes | None = None
) -> bytes:
    """Validate archive identity and safe members before consuming its bytes.

    :param path: Built wheel or source archive to validate.
    :param name: Expected distribution name.
    :param version: Expected project version.
    :param data: Already-read bytes, when the caller owns the asset snapshot.
    :return: Validated archive bytes.
    :raises ValueError: If the package is unsafe or its identity is inconsistent.
    """
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"Release asset {path.name} is missing or not a regular file.")
    data = path.read_bytes() if data is None else data
    if path.name.endswith(".whl"):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                names = set()
                for item in archive.infolist():
                    _safe_member(item.filename.rstrip("/"))
                    mode = item.external_attr >> 16
                    if mode & 0o170000 == 0o120000:
                        raise ValueError(f"Wheel {path.name} contains a symbolic link.")
                    if item.filename in names:
                        raise ValueError(f"Wheel {path.name} has duplicate members.")
                    names.add(item.filename)
                metadata_names = [
                    item for item in names if item.endswith(".dist-info/METADATA")
                ]
                if len(metadata_names) != 1:
                    raise ValueError(
                        f"Wheel {path.name} must contain one METADATA file."
                    )
                _metadata_matches(
                    archive.read(metadata_names[0]), name, version, path.name
                )
        except (OSError, zipfile.BadZipFile) as exc:
            raise ValueError(f"Invalid wheel {path.name}.") from exc
        normalized = _normalize(path.name[:-4])
        if not normalized.startswith(f"{_normalize(name)}_{_normalize(version)}_"):
            raise ValueError(
                f"Wheel filename {path.name} does not match project/version."
            )
    else:
        import tarfile

        stem = path.name.removesuffix(".tar.gz")
        if not stem.endswith("-" + version) or _normalize(
            stem[: -(len(version) + 1)]
        ) != _normalize(name):
            raise ValueError(
                f"Source archive filename {path.name} does not match project/version."
            )
        try:
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
                roots: set[str] = set()
                metadata = []
                for member in archive.getmembers():
                    safe = _safe_member(member.name)
                    roots.add(safe.parts[0])
                    if (
                        member.issym()
                        or member.islnk()
                        or not (member.isfile() or member.isdir())
                    ):
                        raise ValueError(
                            f"Source archive {path.name} contains a link or special file."
                        )
                    if len(safe.parts) == 2 and safe.parts[1] == "PKG-INFO":
                        stream = archive.extractfile(member)
                        if stream is None:
                            raise ValueError(f"Cannot read PKG-INFO from {path.name}.")
                        metadata.append(stream.read())
                if len(roots) != 1 or len(metadata) != 1:
                    raise ValueError(
                        f"Source archive {path.name} must have one root and one PKG-INFO."
                    )
                _metadata_matches(metadata[0], name, version, path.name)
        except (OSError, tarfile.TarError) as exc:
            raise ValueError(f"Invalid source archive {path.name}.") from exc
    return data
