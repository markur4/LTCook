"""Stage runtime and native plugin payloads for wheels and installers."""

from __future__ import annotations

import argparse
import os
import shutil
import tempfile
from pathlib import Path

from setuptools.command.build_py import build_py as BuildPyBase

ROOT_DECLARATIONS = ("package.json", "package-lock.json", ".node-version")
REQUIRED_RUNTIME_ENTRIES = ("dist/main.js", "dist/integrations/pi-rpc.js")
REQUIRED_PASEO_PLUGIN_ASSETS = (
    "paseo-plugin.json",
    "index.server.ts",
    "index.client.tsx",
    "shared/panel-snapshot.ts",
)


def _copy_tree(source: Path, destination: Path, *, required: bool) -> None:
    """Copy a production subtree without links or development dependencies."""
    if not source.is_dir() or source.is_symlink():
        if required:
            raise FileNotFoundError(f"Required production assets are missing: {source}")
        return
    for item in sorted(source.rglob("*")):
        if item.is_symlink():
            raise ValueError(f"Production payload contains a link: {item}")
        if item.is_dir():
            continue
        if not item.is_file() or "node_modules" in item.parts or ".git" in item.parts:
            continue
        output = destination / item.relative_to(source)
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(item, output)


def stage_assets(root: Path, destination: Path) -> tuple[Path, ...]:
    """Atomically stage runtime, native plugin sources, teams, services and declarations.

    :param root: Repository root containing generated production assets.
    :param destination: Exact LTCook-owned staging directory to replace.
    :return: Relative file paths included in the staged payload.
    """
    root = root.resolve(strict=True)
    if not destination.is_absolute():
        raise ValueError("Production bundle destination must be absolute.")
    if destination.is_symlink() or destination == Path(destination.anchor):
        raise ValueError("Unsafe production bundle destination.")
    for declaration in ROOT_DECLARATIONS:
        path = root / declaration
        if path.is_symlink() or not path.is_file():
            raise FileNotFoundError(
                f"Required production declaration is missing: {declaration}"
            )
    runtime_manifest = root / "runtime/package.json"
    if runtime_manifest.is_symlink() or not runtime_manifest.is_file():
        raise FileNotFoundError(
            "runtime/package.json is required for the production workspace lock."
        )
    for entry in REQUIRED_RUNTIME_ENTRIES:
        path = root / "runtime" / entry
        if path.is_symlink() or not path.is_file():
            raise FileNotFoundError(
                f"Compiled runtime entry is required before staging: {entry}"
            )
    plugin_directory = root / "runtime/dist/paseo-plugin"
    if plugin_directory.is_symlink() or not plugin_directory.is_dir():
        raise FileNotFoundError(
            "Production Paseo plugin source directory is required before staging."
        )
    for asset in REQUIRED_PASEO_PLUGIN_ASSETS:
        path = plugin_directory / asset
        if path.is_symlink() or not path.is_file():
            raise FileNotFoundError(
                f"Required production Paseo plugin asset is missing: {asset}"
            )
    unexpected_root_code = [
        path.name
        for path in plugin_directory.iterdir()
        if path.is_file()
        and path.suffix in {".js", ".jsx", ".ts", ".tsx", ".cjs", ".mjs"}
        and path.name not in {"index.server.ts", "index.client.tsx"}
    ]
    if unexpected_root_code:
        raise ValueError(
            "Unexpected code at the Paseo plugin root: "
            + ", ".join(sorted(unexpected_root_code))
        )
    parent = destination.parent
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ltcook-bundle-", dir=parent) as temporary:
        staging = Path(temporary) / "bundle"
        staging.mkdir()
        (staging / "runtime").mkdir()
        for declaration in ROOT_DECLARATIONS:
            shutil.copyfile(root / declaration, staging / declaration)
        shutil.copyfile(runtime_manifest, staging / "runtime/package.json")
        _copy_tree(root / "runtime/dist", staging / "runtime/dist", required=True)
        launcher = staging / "runtime/dist/integrations/pi-rpc.js"
        launcher.chmod(launcher.stat().st_mode | 0o111)
        for team in ("default", "default-minimal"):
            source = root / "teams" / team
            target = staging / "teams" / team
            manifest = source / "package.json"
            if not manifest.is_file() or manifest.is_symlink():
                raise FileNotFoundError(f"Missing team package manifest: {team}")
            target.mkdir(parents=True)
            shutil.copyfile(manifest, target / "package.json")
            _copy_tree(source / "dist", target / "dist", required=True)
            _copy_tree(source / "resources", target / "resources", required=True)
        _copy_tree(root / "services", staging / "services", required=True)
        (staging / ".ltcook-bundle").write_text("ltcook\n", encoding="utf-8")
        if destination.exists():
            marker = destination / ".ltcook-bundle"
            if (
                destination.is_symlink()
                or not marker.is_file()
                or marker.read_text(encoding="utf-8") != "ltcook\n"
            ):
                raise ValueError(
                    "Refusing to replace an unowned production bundle directory."
                )
            shutil.rmtree(destination)
        staging.replace(destination)
    return tuple(
        path.relative_to(destination)
        for path in sorted(destination.rglob("*"))
        if path.is_file()
    )


class BuildPy(BuildPyBase):
    """Validate and copy explicitly staged assets into the wheel tree."""

    def run(self) -> None:
        """Keep wheel build offline and fail if its source bundle is incomplete."""
        super().run()
        source = Path(__file__).resolve().parents[2] / "ltcook_distr" / "bundle"
        marker = source / ".ltcook-bundle"
        if (
            source.is_symlink()
            or not marker.is_file()
            or marker.read_text(encoding="utf-8") != "ltcook\n"
        ):
            raise RuntimeError(
                "Run the explicit package_assets staging command before building the wheel."
            )
        required = [source / name for name in ROOT_DECLARATIONS]
        required.extend(
            (
                source / "runtime/dist/main.js",
                source / "runtime/dist/integrations/pi-rpc.js",
                source / "services/compose.yaml",
            )
        )
        for team in ("default", "default-minimal"):
            required.extend(
                (
                    source / "teams" / team / "dist",
                    source / "teams" / team / "resources",
                )
            )
        if any(not path.exists() for path in required):
            raise RuntimeError(
                "Staged wheel payload is missing a required production asset."
            )
        destination = Path(self.build_lib) / "ltcook_distr" / "bundle"
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(source, destination, symlinks=False)


def main() -> int:
    """Stage checked production build outputs into the source bundle directory."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--destination", type=Path, required=True)
    arguments = parser.parse_args()
    destination = Path(os.path.abspath(arguments.destination))
    print("\n".join(map(str, stage_assets(arguments.root, destination))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
