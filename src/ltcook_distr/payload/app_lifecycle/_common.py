"""Small process and ownership primitives shared by authored setup actions."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import tarfile
import zipfile
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from urllib.request import urlopen

PODMAN_RELEASE = "5.6.0"


class SetupError(RuntimeError):
    """An external prerequisite or ownership check did not complete."""


def run(
    arguments: Sequence[str],
    *,
    environment: Mapping[str, str],
    cwd: Path | None = None,
    required: bool = True,
) -> subprocess.CompletedProcess[str]:
    """Run a real command without a shell or exposing its environment in errors."""
    if os.name != "nt" and arguments[0].lower().endswith((".exe", ".cmd", ".bat")):
        raise SetupError("Native Windows executables must not run from Linux/WSL.")
    try:
        result = subprocess.run(
            list(arguments),
            env=dict(environment),
            cwd=cwd,
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError as exc:
        raise SetupError(
            f"Cannot execute {Path(arguments[0]).name}: {exc.strerror}"
        ) from exc
    if required and result.returncode:
        # > Subprocess output can contain credentials; do not copy it into logs.
        raise SetupError(
            f"{Path(arguments[0]).name} {arguments[1] if len(arguments) > 1 else ''} "
            f"failed (exit {result.returncode}). Run that command directly for diagnostics."
        )
    return result


def no_links(path: Path) -> None:
    """Reject symlink ancestors before reading or deleting an owned location."""
    for part in (path, *path.parents):
        if part.is_symlink():
            raise SetupError(f"Linked ownership path is not allowed: {path}")


def owned_directory(path: Path) -> Path:
    """Claim only an empty directory, or reuse an explicitly LTCook-owned one."""
    if not path.is_absolute() or path == Path(path.anchor):
        raise SetupError("The deployment must be an absolute non-root directory.")
    no_links(path)
    marker = path / ".ltcook-owned"
    if path.exists() and not marker.is_file() and any(path.iterdir()):
        raise SetupError(f"Refusing to claim a nonempty unowned directory: {path}")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if marker.exists() and marker.read_text() != "ltcook\n":
        raise SetupError("Deployment ownership marker does not identify LTCook.")
    marker.write_text("ltcook\n", encoding="utf-8")
    marker.chmod(0o600)
    return path


@contextmanager
def setup_lock(deployment: Path) -> Iterator[None]:
    """Serialize preparation; recover only a lock whose process is known dead."""
    lock = deployment / ".setup-lock"
    no_links(lock)
    try:
        lock.mkdir(mode=0o700)
    except FileExistsError:
        try:
            pid = int((lock / "pid").read_text())
            os.kill(pid, 0)
        except ProcessLookupError:
            (lock / "pid").unlink()
            lock.rmdir()
            lock.mkdir(mode=0o700)
        except (OSError, ValueError) as exc:
            raise SetupError(
                "Preparation lock is uncertain; inspect it before retrying."
            ) from exc
        else:
            raise SetupError("Another LTCook preparation process is running.")
    (lock / "pid").write_text(str(os.getpid()))
    try:
        yield
    finally:
        (lock / "pid").unlink()
        lock.rmdir()


def write_json(path: Path, value: object) -> None:
    """Publish complete private JSON atomically within an owned directory."""
    no_links(path)
    temporary = path.with_name(path.name + ".partial")
    no_links(temporary)
    temporary.write_text(
        json.dumps(value, sort_keys=True, indent=2) + "\n", encoding="utf-8"
    )
    temporary.chmod(0o600)
    temporary.replace(path)


def download(url: str, destination: Path, digest: str | None = None) -> None:
    """Download HTTPS bytes atomically and optionally require an exact SHA-256."""
    if not url.startswith("https://"):
        raise SetupError("Prerequisite downloads require HTTPS.")
    no_links(destination)
    if digest and destination.exists():
        if not destination.is_file():
            raise SetupError("The cached prerequisite download is not a regular file.")
        with destination.open("rb") as cached:
            if hashlib.file_digest(cached, "sha256").hexdigest() == digest:
                return
        destination.unlink()
    temporary = destination.with_name(destination.name + ".partial")
    no_links(temporary)
    try:
        with urlopen(url, timeout=60) as response, temporary.open("wb") as output:
            if not response.url.startswith("https://"):
                raise SetupError("Prerequisite download redirected away from HTTPS.")
            shutil.copyfileobj(response, output)
        if digest:
            with temporary.open("rb") as downloaded:
                actual = hashlib.file_digest(downloaded, "sha256").hexdigest()
            if actual != digest:
                raise SetupError("Prerequisite download failed its SHA-256 check.")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def safe_member(name: str) -> PurePosixPath:
    """Validate archive paths on both POSIX and Windows before extraction."""
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name or ":" in name:
        raise SetupError(f"Unsafe archive member: {name}")
    return path


def extract_archive(archive: Path, destination: Path) -> None:
    """Extract regular files and confined Node symlinks without following links."""
    no_links(destination)
    destination.mkdir(mode=0o700, exist_ok=True)
    if next(destination.iterdir(), None) is not None:
        raise SetupError("Archive extraction requires an empty destination.")
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as source:
            for info in source.infolist():
                relative = safe_member(info.filename)
                target = destination.joinpath(*relative.parts)
                if stat.S_ISLNK(info.external_attr >> 16):
                    raise SetupError("ZIP symlinks are not accepted.")
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with source.open(info) as data, target.open("xb") as output:
                        shutil.copyfileobj(data, output)
        return
    with tarfile.open(archive) as source:
        links: list[tarfile.TarInfo] = []
        for info in source:
            relative = safe_member(info.name)
            target = destination.joinpath(*relative.parts)
            if info.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif info.isreg():
                target.parent.mkdir(parents=True, exist_ok=True)
                data = source.extractfile(info)
                if data is None:
                    raise SetupError("Archive member has no readable file content.")
                with data, target.open("xb") as output:
                    shutil.copyfileobj(data, output)
                target.chmod(info.mode & 0o755)
            elif info.issym():
                links.append(info)
            else:
                raise SetupError("Archive devices and hard links are not accepted.")
        # > Official Node distributions link npm/npx to their bundled JS files.
        for info in links:
            target = destination.joinpath(*safe_member(info.name).parts)
            link = PurePosixPath(info.linkname)
            resolved = (target.parent / info.linkname).resolve()
            if (
                link.is_absolute()
                or "\\" in info.linkname
                or ":" in info.linkname
                or not resolved.is_relative_to(destination.resolve())
                or not resolved.is_file()
            ):
                raise SetupError("Archive link escapes its extraction directory.")
            target.symlink_to(info.linkname)
