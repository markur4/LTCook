"""Build a PyApp installer launcher without giving PyApp the app environment."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import tomllib
from pathlib import Path

from .package_validation import validate_package


def _installer_sdk_requirement(project: dict[str, object]) -> str:
    """Select the sole AppRC core dependency declared by the LTCook project."""
    dependencies = project.get("dependencies")
    if not isinstance(dependencies, list) or not all(
        isinstance(dependency, str) for dependency in dependencies
    ):
        raise ValueError("Project metadata must declare runtime dependencies.")
    requirements: list[str] = []
    for dependency in dependencies:
        match = re.match(r"[A-Za-z0-9][A-Za-z0-9._-]*", dependency.strip())
        if match and re.sub(r"[-_.]+", "-", match.group()).casefold() == "apprc-core":
            requirements.append(dependency)
    if len(requirements) != 1:
        raise ValueError(
            "Project metadata must declare exactly one direct apprc-core dependency."
        )
    return requirements[0]


def _pyapp_exec_code(wheel_name: str, wheel_digest: str) -> str:
    """Forward the adjacent wheel's immutable identity to the installer archive."""
    return (
        "import os, runpy, sys\n"
        "_bundle = os.path.dirname(os.environ['PYAPP'])\n"
        "sys.argv[1:1] = ["
        "'--package-wheel', os.path.join(_bundle, "
        f"{json.dumps(wheel_name)}), "
        f"'--package-wheel-sha256', {json.dumps(wheel_digest)}]\n"
        "runpy.run_path(os.path.join(_bundle, 'main-installer.pyz'), "
        "run_name='__main__')"
    )


def build_pyapp(
    pyapp_source: Path,
    installer: Path,
    wheel: Path,
    output: Path,
    *,
    root: Path,
    target: str | None = None,
) -> Path:
    """Build PyApp with the AppRC archive and verified LTCook wheel beside it.

    :param pyapp_source: Checked-out official PyApp source directory.
    :param installer: Generated standalone AppRC installer ``.pyz``.
    :param wheel: Built LTCook wheel matching the root project metadata.
    :param output: Destination executable path.
    :param root: LTCook repository root containing project version metadata.
    :param target: Optional Cargo target triple for cross-builds.
    :return: Built launcher; its archive and wheel are sibling assets.
    """
    pyapp_source = pyapp_source.resolve(strict=True)
    installer = installer.resolve(strict=True)
    wheel = wheel.resolve(strict=True)
    root = root.resolve(strict=True)
    if installer.suffix != ".pyz" or not installer.is_file():
        raise ValueError("PyApp requires the generated AppRC main-installer.pyz.")
    if wheel.suffix != ".whl" or not wheel.is_file():
        raise ValueError("PyApp requires the already-built LTCook wheel.")
    manifest = pyapp_source / "Cargo.toml"
    if not manifest.is_file() or not (pyapp_source / "src/main.rs").is_file():
        raise ValueError(
            "--pyapp-source must point to the official PyApp Cargo project."
        )
    metadata = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    project = metadata.get("project", {})
    if project.get("name") != "ltcook" or not isinstance(project.get("version"), str):
        raise ValueError("Project metadata must declare LTCook's installer identity.")
    wheel_bytes = validate_package(wheel, project["name"], project["version"])
    wheel_digest = hashlib.sha256(wheel_bytes).hexdigest()
    cargo = shutil.which("cargo")
    if cargo is None:
        raise RuntimeError(
            "Cargo is required to build PyApp; install Rust before using this helper."
        )
    environment = dict(os.environ)
    arguments = [cargo, "build", "--release", "--manifest-path", str(manifest)]
    if target:
        arguments.extend(("--target", target))
    windows_target = target is not None and "windows" in target
    executable_name = "pyapp.exe" if windows_target or os.name == "nt" else "pyapp"
    configured_target_dir = environment.get("CARGO_TARGET_DIR")
    if configured_target_dir:
        target_directory = Path(configured_target_dir)
        if not target_directory.is_absolute():
            target_directory = pyapp_source / target_directory
    else:
        target_directory = pyapp_source / "target"
    built = target_directory / (target or "") / "release" / executable_name
    requirement = _installer_sdk_requirement(project)
    with tempfile.TemporaryDirectory(prefix="ltcook-pyapp-requirements-") as temporary:
        dependency_file = Path(temporary) / "installer-requirements.txt"
        dependency_file.write_text(requirement + "\n", encoding="utf-8")
        environment.update(
            {
                "PYAPP_PROJECT_NAME": "ltcook-installer",
                "PYAPP_PROJECT_VERSION": project["version"],
                "PYAPP_PROJECT_DEPENDENCY_FILE": str(dependency_file),
                "PYAPP_EXEC_CODE": _pyapp_exec_code(wheel.name, wheel_digest),
                "PYAPP_PASS_LOCATION": "true",
                "PYAPP_SKIP_INSTALL": "false",
            }
        )
        result = subprocess.run(
            arguments, cwd=pyapp_source, env=environment, check=False
        )
    if result.returncode:
        raise RuntimeError(
            f"PyApp Cargo build failed with exit code {result.returncode}."
        )
    if not built.is_file():
        raise RuntimeError(f"PyApp build succeeded without producing {built}.")
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(built, output)
    sidecar = output.parent / "main-installer.pyz"
    if sidecar.is_symlink():
        raise ValueError(f"Refusing to replace linked installer archive: {sidecar}")
    if sidecar.resolve() != installer:
        shutil.copyfile(installer, sidecar)
    wheel_sidecar = output.parent / wheel.name
    if wheel_sidecar.is_symlink():
        raise ValueError(f"Refusing to replace linked wheel asset: {wheel_sidecar}")
    if wheel_sidecar.resolve() != wheel:
        shutil.copyfile(wheel, wheel_sidecar)
    if output.suffix != ".exe":
        output.chmod(0o755)
    return output


def main() -> int:
    """Build one native PyApp launcher using explicitly supplied source assets."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pyapp-source", type=Path, required=True)
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--wheel", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--target")
    args = parser.parse_args()
    print(
        build_pyapp(
            args.pyapp_source,
            args.installer,
            args.wheel,
            args.output,
            root=args.root,
            target=args.target,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
