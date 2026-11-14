"""Stage exact validated package and Linux native release assets."""

from __future__ import annotations

import argparse
import hashlib
import shutil
import zipfile
from pathlib import Path

from apprc.distribution import decode_native_binding, read_distribution_spec

from ltcook_dev.packaging import release_assets
from ltcook_dev.packaging.package_validation import validate_package
from ltcook_dev.packaging.release_manifest import LINUX_SETUP_SUFFIX, MANIFEST_NAME

REPOSITORY = "markur4/ltcook"


def _no_links(path: Path) -> None:
    """Reject symlinked release inputs and outputs before filesystem access."""
    if any(parent.is_symlink() for parent in (path, *path.parents)):
        raise ValueError(f"Release asset path contains a link: {path}")


def _regular_file(path: Path) -> None:
    """Require a regular file reached without following linked ancestors."""
    _no_links(path)
    if not path.is_file():
        raise ValueError(f"Release asset is not a regular file: {path.name}.")


def _package_files(directory: Path, project: str, version: str) -> tuple[Path, Path]:
    """Select and validate the unique built wheel and source archive."""
    packages = tuple(
        path for path in directory.iterdir() if path.name.endswith((".whl", ".tar.gz"))
    )
    wheels = tuple(path for path in packages if path.name.endswith(".whl"))
    sdists = tuple(path for path in packages if path.name.endswith(".tar.gz"))
    if len(wheels) != 1 or len(sdists) != 1:
        raise ValueError(
            "Release staging requires exactly one wheel and one source archive."
        )
    for path in (*wheels, *sdists):
        _regular_file(path)
        validate_package(path, project, version)
    return wheels[0], sdists[0]


def _native_identity(
    executable: Path,
    *,
    app_id: str,
    distribution: str,
    command: str,
    version: str,
    commit: str,
) -> None:
    """Require the executable's appended binding to match the requested release."""
    _regular_file(executable)
    try:
        with zipfile.ZipFile(executable) as archive:
            binding = decode_native_binding(archive.read("binding.json"))
    except (OSError, KeyError, zipfile.BadZipFile, ValueError) as error:
        raise ValueError("Linux setup has no valid embedded native binding.") from error
    if (
        binding.identity.app_id != app_id
        or binding.identity.distribution != distribution
        or binding.command_name != command
        or binding.version != version
        or binding.source.commit != commit
    ):
        raise ValueError(
            "Linux setup embedded app/distribution/command/version/commit identity does not match."
        )


def _checksum_matches(checksums: Path, setup: Path) -> bool:
    """Require SHA256SUMS to contain exactly the matching Linux setup digest."""
    _regular_file(checksums)
    try:
        lines = checksums.read_text(encoding="ascii").splitlines()
    except (OSError, UnicodeError):
        return False
    expected = f"{hashlib.sha256(setup.read_bytes()).hexdigest()}  {setup.name}"
    return lines == [expected]


def stage_release(
    tag: str, commit: str, *, root: Path, repository: str = REPOSITORY
) -> tuple[str, ...]:
    """Stage validated wheel/sdist and the SDK's Linux setup/checksum pair.

    :param tag: Final release tag, without creating or pushing a tag.
    :param commit: Full immutable source commit represented by native binding.
    :param root: Application repository root, which must be the current directory.
    :param repository: Immutable OWNER/REPO release identity.
    :return: Strict manifest validator's exact upload filename set.
    """
    _no_links(root)
    root = root.resolve()
    if root != Path.cwd().resolve():
        raise ValueError("Run release staging from the application repository root.")
    name, version = release_assets._project()
    if tag != f"v{version}":
        raise ValueError("Release tag does not match project metadata.")
    wheel, sdist = _package_files(root / "dist", name, version)
    spec = read_distribution_spec(root)
    app_id = spec.metadata.identity.app_id
    distribution = spec.metadata.identity.distribution
    command = spec.metadata.command_name or spec.metadata.identity.commands[0]
    setup = root / "dist" / f"{app_id}{LINUX_SETUP_SUFFIX}"
    checksums = root / "dist/SHA256SUMS"
    _native_identity(
        setup,
        app_id=app_id,
        distribution=distribution,
        command=command,
        version=version,
        commit=commit,
    )
    if not _checksum_matches(checksums, setup):
        raise ValueError(
            "SHA256SUMS is missing, contains extra entries, or does not match the Linux setup."
        )
    destination = root / "release/assets"
    _no_links(destination)
    destination.mkdir(parents=True, exist_ok=True)
    _no_links(destination / MANIFEST_NAME)
    expected = {wheel.name, sdist.name, setup.name, "SHA256SUMS", MANIFEST_NAME}
    if {path.name for path in destination.iterdir()} - expected:
        raise ValueError(
            "Release staging directory contains stale or unexpected files."
        )
    for source in (wheel, sdist, setup, checksums):
        _regular_file(source)
        _no_links(destination / source.name)
        shutil.copyfile(source, destination / source.name)
    return release_assets.stage(
        destination,
        [wheel.name, sdist.name, setup.name, "SHA256SUMS"],
        repository=repository,
        tag=tag,
        commit=commit,
    )


def main() -> None:
    """Parse release identity and stage exact validated assets."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag")
    parser.add_argument("commit")
    parser.add_argument("--repository", default=REPOSITORY)
    arguments = parser.parse_args()
    print(
        "\n".join(
            stage_release(
                arguments.tag,
                arguments.commit,
                root=Path.cwd(),
                repository=arguments.repository,
            )
        )
    )


if __name__ == "__main__":
    main()
