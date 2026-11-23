"""Stage and archive production runtime/plugin assets for package builds."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

ROOT_DECLARATIONS = ("package.json", "package-lock.json", ".node-version")
REQUIRED_RUNTIME_ENTRIES = (
    "dist/main.js",
    "dist/tools/web-mcp.js",
    "dist/tools/pi-web-access.LICENSE",
    "dist/evals/worker.js",
    "resources/evals/manifest.json",
    "resources/evals/verify.cjs",
    "dist/integrations/pi-rpc.js",
    "dist/team-api/index.js",
    "dist/guidance-api/index.js",
    "dist/workflow-api/index.js",
)
REQUIRED_PASEO_PLUGIN_ASSETS = (
    "paseo-plugin.json",
    "index.server.ts",
    "index.client.tsx",
    "shared/evals.ts",
    "shared/team-catalog.ts",
    "shared/panel-snapshot.ts",
    "shared/panel-details.ts",
    "shared/view-model.ts",
    "client/use-team-panel.ts",
    "client/use-team-catalog.ts",
    "client/components/PanelChrome.tsx",
    "client/components/StatusBadge.tsx",
    "client/screens/Diagnostics.tsx",
    "client/screens/TeamStatus.tsx",
    "client/screens/TeamOverview.tsx",
    "client/screens/TeamsBrowser.tsx",
    "client/components/TeamComposerItem.tsx",
    "client/screens/TaskBoard.tsx",
    "client/screens/AgentFocus.tsx",
)


def _no_links(path: Path) -> None:
    """Reject linked owned paths before reading or replacing their contents."""
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise ValueError(f"Unsafe production bundle destination or input link: {path}")


def _copy_tree(source: Path, destination: Path, *, required: bool) -> None:
    """Copy a production subtree without links or development dependencies."""
    _no_links(source)
    if not source.is_dir():
        if required:
            raise FileNotFoundError(f"Required production assets are missing: {source}")
        return
    for item in sorted(source.rglob("*")):
        _no_links(item)
        if item.is_dir():
            continue
        if not item.is_file() or "node_modules" in item.parts or ".git" in item.parts:
            continue
        output = destination / item.relative_to(source)
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(item, output)


def _team_packages(root: Path) -> tuple[Path, ...]:
    """Find managed direct Team workspaces without following linked inputs."""
    directory = root / "teams"
    _no_links(directory)
    packages: list[Path] = []
    for package in sorted(directory.iterdir()):
        _no_links(package)
        if not package.is_dir() or not (package / "package.json").is_file():
            continue
        _no_links(package / "package.json")
        manifest = json.loads((package / "package.json").read_text(encoding="utf-8"))
        if not isinstance(manifest, dict) or not isinstance(manifest.get("name"), str):
            raise TypeError(f"Invalid Team package manifest: {package.name}")
        packages.append(package)
    if not packages:
        raise ValueError("Production bundle requires at least one local Team package.")
    return tuple(packages)


def stage_assets(root: Path, destination: Path) -> tuple[Path, ...]:
    """Atomically stage runtime, native plugin sources, teams, services and declarations.

    :param root: Repository root containing generated production assets.
    :param destination: Exact LTCook-owned staging directory to replace.
    :return: Relative file paths included in the staged payload.
    """
    _no_links(root)
    root = root.resolve(strict=True)
    if not destination.is_absolute():
        raise ValueError("Production bundle destination must be absolute.")
    if destination.is_symlink() or destination == Path(destination.anchor):
        raise ValueError("Unsafe production bundle destination.")
    _no_links(destination)
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
        for boundary in ("team-api", "guidance-api", "workflow-api"):
            _copy_tree(
                root / "runtime/src" / boundary,
                staging / "runtime/src" / boundary,
                required=True,
            )
        _copy_tree(
            root / "runtime/resources", staging / "runtime/resources", required=True
        )
        launcher = staging / "runtime/dist/integrations/pi-rpc.js"
        launcher.chmod(launcher.stat().st_mode | 0o111)
        for source in _team_packages(root):
            team = source.name
            _no_links(source)
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
                or marker.is_symlink()
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


def validate_bundle(archive: Path) -> tuple[str, ...]:
    """Validate the sole packaged payload without extracting untrusted paths.

    :param archive: Canonical production ZIP, never a directory fallback.
    :return: Validated regular-file member names in archive order.
    """
    _no_links(archive)
    required = {
        ".ltcook-bundle",
        *ROOT_DECLARATIONS,
        "runtime/package.json",
        *(
            f"runtime/src/{boundary}/index.ts"
            for boundary in ("team-api", "guidance-api", "workflow-api")
        ),
        "runtime/src/workflow-api/commands.ts",
        *(f"runtime/{entry}" for entry in REQUIRED_RUNTIME_ENTRIES),
        *(f"runtime/dist/paseo-plugin/{name}" for name in REQUIRED_PASEO_PLUGIN_ASSETS),
        "services/compose.yaml",
    }
    try:
        with zipfile.ZipFile(archive) as source:
            names = source.namelist()
            if len(names) != len(set(names)):
                raise ValueError("Production bundle contains duplicate members.")
            for member in source.infolist():
                path = PurePosixPath(member.filename)
                mode = member.external_attr >> 16
                if (
                    not path.parts
                    or path.is_absolute()
                    or ".." in path.parts
                    or str(path) != member.filename
                    or any(character in member.filename for character in "\\\x00:")
                    or any(part in {"node_modules", ".git"} for part in path.parts)
                    or not stat.S_ISREG(mode)
                ):
                    raise ValueError(
                        f"Unsafe production bundle member: {member.filename}"
                    )
                source.read(member)
            if not required.issubset(names):
                raise ValueError(
                    "Production bundle is missing a required production asset."
                )
            for kind in ("rules", "skills"):
                if not any(
                    name.startswith(f"runtime/resources/{kind}/") for name in names
                ):
                    raise ValueError(
                        "Production bundle is missing required Core guidance."
                    )
            teams = {
                PurePosixPath(name).parts[1]
                for name in names
                if name.startswith("teams/") and len(PurePosixPath(name).parts) >= 3
            }
            if not teams:
                raise ValueError("Production bundle is missing local Team packages.")
            for team in sorted(teams):
                for subtree in ("dist", "resources"):
                    if not any(
                        name.startswith(f"teams/{team}/{subtree}/") for name in names
                    ):
                        raise ValueError(
                            "Production bundle is missing required team assets."
                        )
                if f"teams/{team}/package.json" not in names:
                    raise ValueError("Production bundle is missing a team declaration.")
            if source.read(".ltcook-bundle") != b"ltcook\n":
                raise ValueError("Production bundle ownership marker does not match.")
    except (OSError, zipfile.BadZipFile) as error:
        raise ValueError(f"Invalid production bundle archive: {archive}") from error
    return tuple(names)


def _check_output_ownership(destination: Path) -> None:
    """Allow rebuilding an owned output independently of its old asset inventory."""
    _no_links(destination)
    if not destination.exists():
        return
    try:
        with zipfile.ZipFile(destination) as archive:
            marker = archive.getinfo(".ltcook-bundle")
            if marker.file_size == 7 and archive.read(marker) == b"ltcook\n":
                return
    except (OSError, KeyError, zipfile.BadZipFile):
        pass
    raise ValueError("Refusing to replace an unowned production bundle archive.")


def _write_bundle(bundle: Path, destination: Path) -> Path:
    """Publish deterministically staged directory members to one ZIP file."""
    _check_output_ownership(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    _no_links(destination)
    descriptor, name = tempfile.mkstemp(
        prefix=".ltcook-bundle-", dir=destination.parent
    )
    candidate = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            with zipfile.ZipFile(
                stream, "w", compression=zipfile.ZIP_DEFLATED
            ) as archive:
                files = sorted(
                    (path for path in bundle.rglob("*") if path.is_file()),
                    key=lambda path: path.relative_to(bundle).as_posix(),
                )
                for source in files:
                    relative = source.relative_to(bundle).as_posix()
                    member = zipfile.ZipInfo(relative, (1980, 1, 1, 0, 0, 0))
                    member.create_system = 3
                    mode = 0o755 if source.stat().st_mode & 0o111 else 0o644
                    member.external_attr = (stat.S_IFREG | mode) << 16
                    member.compress_type = zipfile.ZIP_DEFLATED
                    archive.writestr(member, source.read_bytes())
            stream.flush()
            os.fsync(stream.fileno())
        validate_bundle(candidate)
        _no_links(destination)
        candidate.replace(destination)
    finally:
        candidate.unlink(missing_ok=True)
    return destination


def archive_assets(
    root: Path, destination: Path, *, staging_parent: Path | None = None
) -> Path:
    """Stage privately outside the source tree and atomically publish its ZIP.

    :param root: Repository or exported snapshot containing compiled assets.
    :param destination: Exact archive output; linked or unowned outputs are refused.
    :param staging_parent: Optional private workspace outside the exported source.
    :return: Validated canonical archive path.
    """
    _no_links(root)
    root = root.resolve(strict=True)
    destination = Path(os.path.abspath(destination))
    _no_links(destination)
    _check_output_ownership(destination)
    if staging_parent is not None:
        _no_links(staging_parent)
    parent = staging_parent.resolve(strict=True) if staging_parent else None
    with tempfile.TemporaryDirectory(prefix="ltcook-assets-", dir=parent) as temporary:
        private = Path(temporary).resolve()
        if private.is_relative_to(root):
            raise ValueError(
                "Production bundle staging must be outside the source tree."
            )
        bundle = private / "bundle"
        stage_assets(root, bundle)
        _write_bundle(bundle, destination)
    return destination


def main() -> int:
    """Archive checked production outputs from private external staging."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--destination", type=Path, required=True)
    arguments = parser.parse_args()
    destination = Path(os.path.abspath(arguments.destination))
    print(archive_assets(arguments.root, destination))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
else:
    # > AppRC runs the archive CLI before Setuptools is available.
    from setuptools.command.build_py import build_py as BuildPyBase

    class BuildPy(BuildPyBase):
        """Validate the canonical archive and copy it with the Python package."""

        def run(self) -> None:
            """Keep wheel builds offline and refuse linked package outputs."""
            source = Path(__file__).absolute().parents[2] / "ltcook_distr/bundle.zip"
            validate_bundle(source)
            destination = (
                Path(os.path.abspath(self.build_lib)) / "ltcook_distr/bundle.zip"
            )
            _no_links(destination)
            super().run()
            _no_links(destination)
            destination.parent.mkdir(parents=True, exist_ok=True)
            self.copy_file(str(source), str(destination))
