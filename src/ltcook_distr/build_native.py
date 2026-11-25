"""Build one Linux native setup from an immutable committed LTCook snapshot."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path

from apprc.distribution import (
    build_native_distribution,
    build_project_snapshot,
    read_distribution_spec,
)

from ltcook_dev.packaging.package_assets import archive_assets


def _assert_no_links(path: Path) -> None:
    """Reject links in an output workspace's existing path ancestry."""
    if any(candidate.is_symlink() for candidate in (path, *path.parents)):
        raise ValueError(f"Unsafe native build cache path: {path}")


def _prepare(tree: Path, staging_parent: Path) -> None:
    """Compile committed JavaScript and archive it from external private staging.

    :param tree: Private SDK-exported repository tree for the requested commit.
    :param staging_parent: Invocation-owned directory outside that tree.
    """
    subprocess.run(("bun", "install", "--frozen-lockfile"), cwd=tree, check=True)
    subprocess.run(("bun", "run", "build"), cwd=tree, check=True)
    subprocess.run(("bun", "run", "build:paseo-web"), cwd=tree, check=True)
    archive_assets(
        tree,
        tree / "src/ltcook_distr/bundle.zip",
        staging_parent=staging_parent,
    )


def build(revision: str, root: Path, uv_path: Path | None = None) -> tuple[Path, ...]:
    """Snapshot and compile the requested committed source using public SDK APIs.

    :param revision: Git revision resolved and embedded as immutable commit identity.
    :param root: LTCook repository root.
    :return: Native setup and checksum file paths.
    """
    _assert_no_links(root)
    root = root.resolve(strict=True)
    cache = root / ".cache/apprc"
    _assert_no_links(cache)
    cache.mkdir(parents=True, exist_ok=True)
    if cache.resolve() != cache.absolute():
        raise ValueError(f"Unsafe native build cache path: {cache}")
    invocation = Path(tempfile.mkdtemp(prefix="native-", dir=cache))
    spec = read_distribution_spec(root)
    snapshot_path = invocation / "source.zip"
    prepared = build_project_snapshot(
        spec,
        revision=revision,
        destination=snapshot_path,
        prepare=lambda tree: _prepare(tree, invocation),
    )
    uv = str(uv_path) if uv_path is not None else shutil.which("uv")
    if uv is None:
        raise FileNotFoundError("Native build requires uv >=0.11.6 on PATH.")
    artifact_workspace = invocation / "native-workspace"
    distribution = build_native_distribution(
        spec,
        prepared,
        uv=Path(uv).resolve(strict=True),
        workspace=artifact_workspace,
        targets=("x86_64-unknown-linux-gnu",),
        extras=(),
    )
    return tuple(artifact.path for artifact in distribution.artifacts) + (
        root / distribution.checksums.destination,
    )


def main() -> int:
    """Build the Linux-only native product for a committed source revision."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", default="HEAD")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument(
        "--uv", type=Path, help="Absolute uv >=0.11.6 executable for native authoring."
    )
    arguments = parser.parse_args()
    print("\n".join(map(str, build(arguments.revision, arguments.root, arguments.uv))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
