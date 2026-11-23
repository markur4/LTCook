"""Validate staged Linux assets and publish the exact bundle to GitHub."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tomllib
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from .package_validation import validate_package
from .release_manifest import (
    LINUX_SETUP_SUFFIX,
    MANIFEST_NAME,
    expected_asset_names,
    manifest_bytes,
    validate_manifest,
)
from .release_notes import release_channel, validate_version

SHA_RE = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})")


class ReleaseError(RuntimeError):
    """Raised when release identity or local payload is invalid."""


@dataclass(frozen=True, slots=True)
class Identity:
    """Validated local bundle and remote tag identity."""

    repository: str
    tag: str
    commit: str


def _repository(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value):
        raise ReleaseError("Repository must be OWNER/REPO.")
    return value


def _tag(value: str) -> str:
    try:
        validate_version(value.removeprefix("v"))
    except ValueError as error:
        raise ReleaseError(str(error)) from error
    if not value.startswith("v"):
        raise ReleaseError("Release tag must start with v.")
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
) -> dict[str, bytes]:
    name, version = _project()
    app_id = _project_app_id(name)
    _check_asset_names(names, app_id=app_id)
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
            app_id=app_id,
            distribution=re.sub(r"[-_.]+", "-", name).lower(),
            version=version,
            commit=identity.commit,
        )
    except (ValueError, TypeError) as error:
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


def verify(
    directory: Path, *, repository: str, tag: str, commit: str
) -> dict[str, str]:
    """Verify the exact bundle and return GitHub-formatted asset digests.

    :param directory: Dedicated directory holding the complete release assets.
    :param repository: Owner and repository for this release.
    :param tag: Version declared by the checked-out project, with its v prefix.
    :param commit: Full source commit embedded in the native setup and manifest.
    :return: Asset names and their SHA-256 digests, including the manifest.
    """
    from apprc.distribution import read_distribution_spec

    from .release_stage import _native_identity, _no_links

    identity = Identity(_repository(repository), _tag(tag), _sha(commit))
    directory = directory.absolute()
    _no_links(directory)
    names = sorted(path.name for path in directory.iterdir())
    payload = _validate_local_files(directory, names, identity)
    spec = read_distribution_spec(Path.cwd())
    app = spec.metadata.identity
    _native_identity(
        directory / f"{app.app_id}{LINUX_SETUP_SUFFIX}",
        app_id=app.app_id,
        distribution=app.distribution,
        command=spec.metadata.command_name or app.commands[0],
        version=tag[1:],
        commit=commit,
    )
    return {
        name: f"sha256:{hashlib.sha256(data).hexdigest()}"
        for name, data in payload.items()
    }


def _gh(*args: str) -> str:
    return subprocess.check_output(["gh", *args], text=True)


def _object(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ReleaseError("GitHub returned an invalid release object.")
    return value


def _api_object(endpoint: str, *args: str) -> dict[str, object]:
    return _object(json.loads(_gh("api", endpoint, *args)))


def _releases(repository: str) -> list[dict[str, object]]:
    pages = json.loads(
        _gh("api", "--paginate", "--slurp", f"repos/{repository}/releases?per_page=100")
    )
    if not isinstance(pages, list) or any(not isinstance(page, list) for page in pages):
        raise ReleaseError("GitHub returned an invalid release listing.")
    return [_object(item) for page in pages for item in page]


def _release_id(release: dict[str, object]) -> int:
    value = release.get("id")
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ReleaseError("GitHub release has an invalid identifier.")
    return value


def _remote_tag_matches(identity: Identity) -> None:
    repository = identity.repository
    ref = _api_object(f"repos/{repository}/git/ref/tags/{identity.tag}")
    obj = _object(ref.get("object"))
    sha = obj.get("sha")
    if obj.get("type") == "tag" and isinstance(sha, str) and SHA_RE.fullmatch(sha):
        annotated = _api_object(f"repos/{repository}/git/tags/{sha}")
        target = _object(annotated.get("object"))
        if (
            annotated.get("tag") == identity.tag
            and target.get("type") == "commit"
            and target.get("sha") == identity.commit
        ):
            return
    raise ReleaseError(
        f"Remote annotated tag {identity.tag} does not resolve to {identity.commit}."
    )


def _matching_release(identity: Identity) -> dict[str, object] | None:
    matches = [
        release
        for release in _releases(identity.repository)
        if release.get("tag_name") == identity.tag
    ]
    if len(matches) > 1:
        raise ReleaseError(f"GitHub returned duplicate releases for {identity.tag}.")
    return matches[0] if matches else None


def _missing_assets(release: dict[str, object], digests: dict[str, str]) -> list[str]:
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise ReleaseError("GitHub returned an invalid release asset list.")
    seen: set[str] = set()
    for value in assets:
        asset = _object(value)
        name = asset.get("name")
        if (
            not isinstance(name, str)
            or name in seen
            or name not in digests
            or asset.get("state") != "uploaded"
            or asset.get("digest") != digests[name]
        ):
            raise ReleaseError(
                f"Existing GitHub asset conflicts with the bundle: {name!r}."
            )
        seen.add(name)
    return sorted(digests.keys() - seen)


def _validate_remote_release(
    release: dict[str, object], identity: Identity, release_id: int, *, preview: bool
) -> bool:
    draft = release.get("draft")
    if (
        _release_id(release) != release_id
        or release.get("tag_name") != identity.tag
        or release.get("prerelease") is not preview
        or not isinstance(draft, bool)
    ):
        raise ReleaseError(
            f"GitHub release {identity.tag} has an inconsistent identity or channel."
        )
    return draft


def _published_at(release: dict[str, object]) -> datetime:
    timestamp = release.get("published_at")
    if isinstance(timestamp, str):
        try:
            published = datetime.fromisoformat(timestamp)
        except ValueError:
            pass
        else:
            if published.tzinfo is not None:
                return published
    raise ReleaseError("GitHub preview release has no valid publication time.")


def _preview_channel(tag: object) -> str | None:
    if isinstance(tag, str) and tag.startswith("v"):
        try:
            return release_channel(tag[1:])
        except ValueError:
            pass
    return None


def _prune_previews(identity: Identity, release_id: int, channel: str) -> None:
    releases = _releases(identity.repository)
    candidates: list[tuple[datetime, int, str]] = []
    for release in releases:
        tag = release.get("tag_name")
        if (
            isinstance(tag, str)
            and _preview_channel(tag) == channel
            and release.get("draft") is False
            and release.get("prerelease") is True
        ):
            candidates.append((_published_at(release), _release_id(release), tag))
    if (
        len({tag for _, _, tag in candidates}) != len(candidates)
        or len({number for _, number, _ in candidates}) != len(candidates)
        or not any(
            number == release_id and tag == identity.tag
            for _, number, tag in candidates
        )
    ):
        raise ReleaseError("GitHub preview listing has ambiguous release identities.")
    keep = 1 if channel == "beta" else 3
    expired = sorted(candidates, reverse=True)[keep:]
    if any(candidate_id == release_id for _, candidate_id, _ in expired):
        raise ReleaseError(
            "The requested preview falls outside the current retention window."
        )
    for published, candidate_id, tag in expired:
        endpoint = f"repos/{identity.repository}/releases/{candidate_id}"
        current = _api_object(endpoint)
        if (
            _release_id(current) != candidate_id
            or current.get("tag_name") != tag
            or current.get("draft") is not False
            or current.get("prerelease") is not True
            or _published_at(current) != published
        ):
            raise ReleaseError(f"Preview {tag} changed during retention.")
        _gh("api", endpoint, "--method", "DELETE")


def publish(
    directory: Path, *, repository: str, tag: str, commit: str, notes: Path
) -> None:
    """Publish the verified GitHub draft for an existing annotated tag.

    :param directory: Complete, locally verified release bundle.
    :param repository: Exact owner and repository to publish into.
    :param tag: Version tag already pushed by the explicit release command.
    :param commit: Full commit SHA expected at the remote annotated tag.
    :param notes: Release notes prepared from that commit's changelog.
    """
    digests = verify(directory, repository=repository, tag=tag, commit=commit)
    identity = Identity(repository, tag, commit)
    channel = release_channel(tag[1:])
    preview = channel != "stable"
    label = {"beta": "Beta", "pre-release": "Pre-release", "stable": "Stable"}[channel]
    _remote_tag_matches(identity)
    release = _matching_release(identity)
    if release is None:
        _gh(
            "release",
            "create",
            tag,
            "--repo",
            repository,
            "--verify-tag",
            "--draft",
            f"--prerelease={str(preview).lower()}",
            "--title",
            f"LTCook {tag[1:]} · {label}",
            "--notes-file",
            str(notes),
        )
        release = _matching_release(identity)
    if release is None:
        raise ReleaseError(f"Could not find the GitHub release for {tag}.")
    release_id = _release_id(release)
    endpoint = f"repos/{repository}/releases/{release_id}"
    current = _api_object(endpoint)
    draft = _validate_remote_release(current, identity, release_id, preview=preview)
    missing = _missing_assets(current, digests)
    if draft:
        if missing:
            _gh(
                "release",
                "upload",
                tag,
                "--repo",
                repository,
                *(str(directory.absolute() / name) for name in missing),
            )
        updated = _api_object(endpoint)
        if not _validate_remote_release(
            updated, identity, release_id, preview=preview
        ) or _missing_assets(updated, digests):
            raise ReleaseError("The GitHub draft changed during upload.")
        _remote_tag_matches(identity)
        updated = _api_object(
            endpoint,
            "--method",
            "PATCH",
            "-F",
            "draft=false",
            "-f",
            f"make_latest={str(not preview).lower()}",
        )
        if _validate_remote_release(updated, identity, release_id, preview=preview) or (
            _missing_assets(updated, digests)
        ):
            raise ReleaseError(f"Could not confirm publication of {tag}.")
    elif missing:
        raise ReleaseError(f"Published release {tag} is missing expected assets.")
    if preview:
        try:
            _prune_previews(identity, release_id, channel)
        except (OSError, ValueError, ReleaseError, subprocess.SubprocessError) as error:
            raise ReleaseError(
                f"GitHub release {tag} is published. Retry just release-push {tag} for retention: {error}"
            ) from error
    print(f"GitHub release {tag} is published.")


def main() -> int:
    """Run read-only asset verification or explicit GitHub publication."""
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("verify", "publish"):
        subparser = commands.add_parser(command)
        subparser.add_argument("--repository", required=True)
        subparser.add_argument("--tag", required=True)
        subparser.add_argument("--commit", required=True)
        subparser.add_argument("--directory", type=Path, required=True)
        if command == "publish":
            subparser.add_argument("--notes", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "publish":
            publish(
                args.directory,
                repository=args.repository,
                tag=args.tag,
                commit=args.commit,
                notes=args.notes,
            )
        else:
            names = verify(
                args.directory,
                repository=args.repository,
                tag=args.tag,
                commit=args.commit,
            )
            print("\n".join(names))
    except (OSError, ValueError, ReleaseError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
