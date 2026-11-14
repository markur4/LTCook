"""Generated consumer checks for real source installs and retained removal."""

from __future__ import annotations

import dataclasses
import json
import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
import venv
from pathlib import Path, PurePosixPath
from urllib.request import urlopen

import pytest
from apprc.distribution import (
    PayloadTree,
    build_main_installer,
    install_support_files,
    read_project_metadata,
)
from apprc.user_files.installation.discovery import installation_directory
from support_source_transport.server import SourceFixture

from ltcook_dev.packaging.release_stage import (
    _locked_runtime_requirements,
)
from ltcook_distr.make_artifacts import distribution_spec

ROOT = Path(__file__).resolve().parents[1]
TESTS = ROOT / "tests"


def test_checkout_management_is_read_only_without_business_settings(
    tmp_path: Path,
) -> None:
    """Inspect an unmanaged consumer without initializing user resources."""
    environment = os.environ.copy()
    for key in (
        "HOME",
        "USERPROFILE",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "LOCALAPPDATA",
    ):
        environment[key] = str(tmp_path / key.casefold())
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "ltcook",
            "installation",
            "show",
            "--json",
        ],
        cwd=ROOT,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    inspection = json.loads(result.stdout)
    assert inspection["status"] == "missing"
    metadata = read_project_metadata(ROOT)
    assert not installation_directory(
        metadata.identity.app_id, environment=environment
    ).exists()


def _project_identity():
    metadata = read_project_metadata(ROOT)
    spec = distribution_spec(ROOT, metadata)
    settings = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    repository = settings["project"].get("urls", {}).get("Repository")
    if not isinstance(repository, str) or not repository:
        pytest.fail("Generated project metadata must declare its GitHub repository.")
    version = settings["project"]["version"]
    return metadata, spec, repository, f"v{version}", version


def _main_installer(metadata, spec, commit: str, destination: Path) -> Path:
    spec = dataclasses.replace(
        spec,
        source_mode="main",
        release_commit=commit,
        runtime_requirements=tuple(
            dict.fromkeys(
                (
                    *spec.runtime_requirements,
                    *_locked_runtime_requirements(ROOT),
                )
            )
        ),
    )
    payload_root = ROOT / metadata.distribution_path / "payload"
    modules = tuple(
        PurePosixPath("app_lifecycle") / filename
        for filename in (
            "__init__.py",
            "install.py",
            "uninstall.py",
            "actions.py",
        )
    )
    with tempfile.TemporaryDirectory(prefix="consumer-main-payload-") as temporary:
        staged = Path(temporary) / "payload"
        shutil.copytree(payload_root, staged)
        base_payload = PayloadTree(staged, modules)
        resources: list[PurePosixPath] = []
        for relative, content in install_support_files(spec, base_payload).items():
            resource = PurePosixPath("app_lifecycle/_support") / relative
            target = staged.joinpath(*resource.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            resources.append(resource)
        payload = PayloadTree(staged, modules, resources=tuple(resources))
        artifact = build_main_installer(spec, payload)
        destination.write_bytes(artifact.content)
    return destination


def _smoke_commit() -> str:
    """Require source-smoke inputs only when the release recipe supplies one."""
    archive = os.environ.get("INSTALLER_SMOKE_MAIN_SOURCE")
    commit = os.environ.get("INSTALLER_SMOKE_MAIN_COMMIT")
    if bool(archive) != bool(commit):
        pytest.fail(
            "INSTALLER_SMOKE_MAIN_SOURCE and INSTALLER_SMOKE_MAIN_COMMIT "
            "must be supplied together."
        )
    if not archive or not commit:
        pytest.skip("Source-installer scenarios require the release smoke inputs.")
    if not Path(archive).is_file():
        pytest.fail(f"Source archive does not exist: {archive}")
    if len(commit) != 40 or any(
        character not in "0123456789abcdef" for character in commit
    ):
        pytest.fail("INSTALLER_SMOKE_MAIN_COMMIT must be a full lowercase commit hash.")
    return commit


def _source_fixture(tmp_path: Path, commit: str) -> SourceFixture:
    metadata, spec, repository, tag, _version = _project_identity()
    assets = ROOT / "release" / "assets"
    archive_name = os.environ.get("INSTALLER_SMOKE_MAIN_SOURCE")
    if not archive_name:
        pytest.fail("Set INSTALLER_SMOKE_MAIN_SOURCE to the maintained source archive.")
    archive = Path(archive_name)
    if not archive.is_file():
        pytest.fail(f"Source archive does not exist: {archive}")
    if not assets.is_dir():
        pytest.fail("Run the release staging recipe before source-install smoke.")
    requested_source = os.environ.get("INSTALLER_SMOKE_SOURCE")
    if requested_source:
        source = Path(requested_source)
        staged = assets / source.name
        if (
            not source.is_file()
            or not staged.is_file()
            or source.read_bytes() != staged.read_bytes()
        ):
            pytest.fail("Staged release bytes differ from INSTALLER_SMOKE_SOURCE.")
    main_installer = _main_installer(
        metadata, spec, commit, tmp_path / "main-installer.py"
    )
    return SourceFixture(
        assets_directory=assets,
        main_installer=main_installer,
        main_installer_path=(
            metadata.distribution_path.as_posix()
            + "/artifacts/installer/main-installer.py"
        ),
        main_archive=archive,
        repository=repository,
        commit=commit,
        tag=tag,
        moving_commit=("0" if commit != "0" * 40 else "1") * 40,
        moving_archive=b"a moved branch must not replace its captured source commit",
    )


def _smoke_environment(
    tmp_path: Path,
    fixture: SourceFixture,
    *,
    restricted: bool,
    symlink_tmp: bool,
) -> dict[str, str]:
    environment = os.environ.copy()
    for key, name in {
        "HOME": "home",
        "USERPROFILE": "home",
        "XDG_CONFIG_HOME": "config",
        "XDG_DATA_HOME": "data",
        "XDG_STATE_HOME": "state",
        "XDG_CACHE_HOME": "cache",
        "LOCALAPPDATA": "local-appdata",
        "UV_CACHE_DIR": "uv-cache",
        "UV_TOOL_DIR": "uv-tools",
        "UV_TOOL_BIN_DIR": "uv-bin",
        "TEMP": "temporary",
        "TMP": "temporary",
    }.items():
        path = tmp_path / name
        path.mkdir(parents=True, exist_ok=True)
        environment[key] = str(path)
    environment["TMPDIR"] = environment["TEMP"]
    if symlink_tmp:
        if os.name == "nt":
            pytest.skip("The temporary-directory alias case is POSIX-only.")
        alias = tmp_path / "temporary-alias"
        alias.symlink_to(environment["TMPDIR"], target_is_directory=True)
        environment["TMPDIR"] = str(alias)
    parent_venv = tmp_path / "active-parent-venv"
    venv.EnvBuilder(with_pip=False).create(parent_venv)
    environment["VIRTUAL_ENV"] = str(parent_venv)
    environment["PYTHON"] = sys.executable
    environment["INSTALLER_SMOKE_API_URL"] = fixture.base_url + "/api"
    environment["LTCOOK_SERVICE_CONNECTION"] = "direct"
    environment.pop("UV", None)
    support = tmp_path / "transport-client"
    support.mkdir()
    for name in ("gh", "gh.py", "gh.cmd", "sitecustomize.py"):
        shutil.copy2(TESTS / "support_source_transport" / name, support / name)
    if os.name != "nt":
        (support / "gh").chmod(0o700)
    mapping = tmp_path / "url-map.json"
    mapping.write_text(json.dumps(fixture.url_map), encoding="utf-8")
    environment["INSTALLER_SMOKE_URL_MAP"] = str(mapping)
    environment["PYTHONPATH"] = os.pathsep.join(
        item
        for item in (
            str(support),
            str(ROOT / "src"),
            environment.get("PYTHONPATH", ""),
        )
        if item
    )
    uv = shutil.which("uv")
    if uv is None:
        pytest.fail("Source smoke requires an existing real uv executable.")
    environment["APPRC_UV_PATH"] = str(Path(uv).resolve())
    if restricted:
        persistent = Path(environment["HOME"]) / ".local" / "bin"
        persistent.mkdir(parents=True)
        shutil.copy2(uv, persistent / "uv")
        environment["UV"] = str(persistent / "uv")
        required = {
            "basename",
            "sh",
            "cat",
            "mktemp",
            "rm",
            "dirname",
            "pwd",
            "uname",
            "git",
            "sed",
        }
        tools = {name: shutil.which(name) for name in required}
        missing = sorted(name for name, value in tools.items() if value is None)
        if missing:
            pytest.fail(
                "Restricted source smoke lacks required shell tools: "
                + ", ".join(missing)
            )
        path = tmp_path / "path"
        path.mkdir()
        for name, executable in tools.items():
            (path / name).symlink_to(executable)
        if os.environ.get("INSTALLER_SMOKE_CLIENT", "curl") == "gh":
            shutil.copy2(support / "gh", path / "gh")
            shutil.copy2(support / "gh.py", path / "gh.py")
            (path / "gh").chmod(0o700)
        environment["PATH"] = str(path)
    else:
        environment["PATH"] = os.pathsep.join(
            (str(support), environment.get("PATH", ""))
        )
    caller = tmp_path / "outside-checkout"
    caller.mkdir()
    environment["INSTALLER_SMOKE_CALLER"] = str(caller)
    return environment


def _run(
    arguments: list[str], environment: dict[str, str]
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        arguments,
        cwd=Path(environment["INSTALLER_SMOKE_CALLER"]),
        env=environment,
        text=True,
        capture_output=True,
        timeout=240,
        check=False,
    )


def _install_and_assert(
    fixture: SourceFixture,
    environment: dict[str, str],
    *,
    mode: str,
    entrypoint: Path | list[str],
    windows_cmd: bool,
    expected_uv: Path | None = None,
) -> None:
    if isinstance(entrypoint, Path):
        arguments = [str(entrypoint)]
        if mode == "main":
            arguments.append("--main")
        if os.environ.get("INSTALLER_SMOKE_CLIENT", "curl") == "gh":
            arguments.extend(("--github-client", "gh"))
        arguments.extend(("--layout", "native"))
        if windows_cmd:
            arguments = ["cmd.exe", "/d", "/c", *arguments]
    else:
        arguments = list(entrypoint)
        if os.environ.get("INSTALLER_SMOKE_CLIENT", "curl") == "gh":
            arguments.extend(("--github-client", "gh"))
        arguments.extend(("--layout", "native"))
    result = _run(arguments, environment)
    assert result.returncode == 0, result.stdout + result.stderr
    fixture.close()
    temporary = Path(environment["TMPDIR"])
    assert not tuple(temporary.glob("apprc-source-*"))
    assert not tuple(temporary.glob("apprc-main-*"))
    assert not tuple(temporary.glob("apprc-release-*"))
    metadata = read_project_metadata(ROOT)
    command = metadata.identity.commands[0]
    executable = Path(environment["UV_TOOL_BIN_DIR"]) / command
    if os.name == "nt":
        executable = executable.with_suffix(".exe")
    assert executable.is_file()
    assert fixture.main_resolution_count == (1 if mode == "main" else 0)
    assert fixture.main_archive_requests == ([fixture.commit] if mode == "main" else [])
    help_result = _run([str(executable), "--help"], environment)
    assert help_result.returncode == 0, help_result.stdout + help_result.stderr
    installation = installation_directory(
        metadata.identity.app_id, environment=environment
    )
    receipt = installation / "installation.json"
    installed = json.loads(receipt.read_text(encoding="utf-8"))
    assert installed["status"] == "ready"
    assert installed["current"] is not None
    if mode == "main":
        assert fixture.commit in json.dumps(installed["current"]["source"])
    if expected_uv is not None:
        assert str(expected_uv) in json.dumps(installed["current"]["backend"])
    sentinel = installation.parent / "unowned.txt"
    sentinel.write_text("preserve unrelated data\n", encoding="utf-8")
    uninstall = installation / ("uninstall.cmd" if os.name == "nt" else "uninstall.sh")
    assert uninstall.is_file()
    remove = [str(uninstall), "--yes"]
    if os.name == "nt":
        remove = ["cmd.exe", "/d", "/c", *remove]
    removed = _run(remove, environment)
    assert removed.returncode == 0, removed.stdout + removed.stderr
    final = json.loads(receipt.read_text(encoding="utf-8"))
    assert final["status"] == "removed-retained"
    assert final["current"] is None
    assert final["last_successful"] is not None
    assert sentinel.read_text(encoding="utf-8") == "preserve unrelated data\n"
    assert not executable.exists()
    assert not (
        Path(environment["UV_TOOL_DIR"]) / metadata.identity.distribution
    ).exists()


@pytest.mark.system
@pytest.mark.parametrize("mode", ["release", "main"])
@pytest.mark.parametrize("restricted_path", [False, True])
@pytest.mark.parametrize("symlink_tmp", [False, True])
def test_source_install_smoke(
    tmp_path: Path,
    mode: str,
    restricted_path: bool,
    symlink_tmp: bool,
) -> None:
    """Network install requiring INSTALLER_SMOKE_COMMIT; direct mode avoids Podman."""
    if os.name == "nt" and restricted_path:
        pytest.skip("The minimal POSIX PATH fixture is not available on Windows.")
    if os.name == "nt" and symlink_tmp:
        pytest.skip("The temporary-directory alias case is POSIX-only.")
    client = os.environ.get("INSTALLER_SMOKE_CLIENT", "curl")
    if client not in {"curl", "gh"}:
        pytest.fail("INSTALLER_SMOKE_CLIENT must be curl or gh.")
    commit = _smoke_commit()
    fixture = _source_fixture(tmp_path, commit)
    try:
        environment = _smoke_environment(
            tmp_path,
            fixture,
            restricted=restricted_path,
            symlink_tmp=symlink_tmp,
        )
        assets = ROOT / "release" / "assets"
        entrypoint = (
            assets / ("app-install.cmd" if os.name == "nt" else "app-install.sh")
            if mode == "release"
            else ROOT / ("app-install.cmd" if os.name == "nt" else "app-install.sh")
        )
        _install_and_assert(
            fixture,
            environment,
            mode=mode,
            entrypoint=entrypoint,
            windows_cmd=os.name == "nt",
        )
    finally:
        fixture.close()


@pytest.mark.system
@pytest.mark.skipif(
    os.name != "nt", reason="Native PowerShell coverage runs on Windows."
)
@pytest.mark.parametrize("entry", ["file", "downloaded-text"])
def test_windows_installer_entries(
    tmp_path: Path, entry: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Native Windows PowerShell installer; requires network, WSL and source access."""
    monkeypatch.setenv("INSTALLER_SMOKE_CLIENT", "gh")
    commit = _smoke_commit()
    fixture = _source_fixture(tmp_path, commit)
    try:
        environment = _smoke_environment(
            tmp_path, fixture, restricted=False, symlink_tmp=False
        )
        bootstrap = ROOT / "release" / "assets" / "bootstrap.ps1"
        if entry == "file":
            command = [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(bootstrap),
                "--main",
            ]
        else:
            with urlopen(
                f"{fixture.base_url}/assets/bootstrap.ps1", timeout=30
            ) as response:
                downloaded = response.read().decode("utf-8")
            downloaded_file = tmp_path / "downloaded-bootstrap.ps1"
            downloaded_file.write_text(downloaded, encoding="utf-8")
            literal = str(downloaded_file).replace("'", "''")
            command = [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                (
                    "$script = [ScriptBlock]::Create("
                    f"[IO.File]::ReadAllText('{literal}')); & $script --main"
                ),
            ]
        _install_and_assert(
            fixture,
            environment,
            mode="main",
            entrypoint=command,
            windows_cmd=False,
        )
    finally:
        fixture.close()


def _official_uv_environment(
    tmp_path: Path, fixture: SourceFixture
) -> tuple[dict[str, str], Path]:
    environment = _smoke_environment(
        tmp_path, fixture, restricted=False, symlink_tmp=False
    )
    environment.pop("UV", None)
    environment.pop("APPRC_UV_PATH", None)
    persistent_name = "uv.exe" if os.name == "nt" else "uv"
    persistent_uv = Path(environment["HOME"]) / ".local" / "bin" / persistent_name
    if persistent_uv.exists():
        persistent_uv.unlink()
    if os.name == "nt":
        original_path = environment["PATH"].split(os.pathsep)
        filtered = []
        for entry in original_path:
            directory = Path(entry)
            available = (
                "uv.exe",
                "python.exe",
                "python3.exe",
                "uv",
                "python",
                "python3",
            )
            if any((directory / name).is_file() for name in available):
                continue
            filtered.append(entry)
        powershell = (
            Path(os.environ["SystemRoot"]) / "System32" / "WindowsPowerShell" / "v1.0"
        )
        filtered.append(str(powershell))
        environment["PATH"] = os.pathsep.join(filtered)
        assert shutil.which("uv", path=environment["PATH"]) is None
        assert shutil.which("python", path=environment["PATH"]) is None
    else:
        tools = {
            "sh",
            "curl",
            "git",
            "cat",
            "mktemp",
            "rm",
            "dirname",
            "pwd",
            "uname",
            "mkdir",
            "chmod",
            "mv",
            "tar",
            "rmdir",
            "grep",
            "cut",
            "tr",
            "head",
            "sed",
            "sleep",
            "cp",
            "ln",
            "realpath",
            "awk",
            "sort",
            "wc",
            "basename",
            "sha256sum",
            "ldd",
        }
        path = tmp_path / "official-bootstrap-path"
        path.mkdir()
        for name in tools:
            executable = shutil.which(name)
            if executable is None:
                pytest.fail(f"Official uv bootstrap smoke requires {name}.")
            (path / name).symlink_to(executable)
        for name in (
            "sysctl",
            "sw_vers",
            "tail",
            "gzip",
            "install",
            "which",
            "getconf",
        ):
            executable = shutil.which(name)
            if executable is not None:
                (path / name).symlink_to(executable)
        if os.environ.get("INSTALLER_SMOKE_CLIENT", "curl") == "gh":
            support = tmp_path / "transport-client"
            shutil.copy2(support / "gh", path / "gh")
            shutil.copy2(support / "gh.py", path / "gh.py")
            (path / "gh").chmod(0o700)
        environment["PATH"] = str(path)
        assert shutil.which("uv", path=environment["PATH"]) is None
        assert shutil.which("python", path=environment["PATH"]) is None
        assert shutil.which("python3", path=environment["PATH"]) is None
    return environment, persistent_uv


@pytest.mark.system
def test_official_uv_bootstrap_installs_without_initial_python_or_uv(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Network/system installer smoke; requires INSTALLER_SMOKE_COMMIT and source access."""
    monkeypatch.setenv("INSTALLER_SMOKE_CLIENT", "curl")
    commit = _smoke_commit()
    fixture = _source_fixture(tmp_path, commit)
    try:
        environment, selected_uv = _official_uv_environment(tmp_path, fixture)
        entrypoint = ROOT / ("app-install.cmd" if os.name == "nt" else "app-install.sh")
        _install_and_assert(
            fixture,
            environment,
            mode="main",
            entrypoint=entrypoint,
            windows_cmd=os.name == "nt",
            expected_uv=selected_uv,
        )
        assert selected_uv.is_file()
    finally:
        fixture.close()


def test_production_bundle_staging_includes_runtime_teams_and_services(
    tmp_path: Path,
) -> None:
    """Stage built assets and declarations without copying development installs."""
    from ltcook_dev.packaging.package_assets import stage_assets

    root = tmp_path / "source"
    for declaration in ("package.json", "package-lock.json", ".node-version"):
        (root / declaration).parent.mkdir(parents=True, exist_ok=True)
        (root / declaration).write_text("declared")
    (root / "runtime/dist").mkdir(parents=True)
    (root / "runtime/dist/main.js").write_text("runtime")
    (root / "runtime/dist/integrations").mkdir()
    (root / "runtime/dist/integrations/pi-rpc.js").write_text("#!/usr/bin/env node\n")
    plugin = root / "runtime/dist/paseo-plugin"
    (plugin / "shared").mkdir(parents=True)
    (plugin / "paseo-plugin.json").write_text("{}")
    (plugin / "index.server.ts").write_text("source")
    (plugin / "index.client.tsx").write_text("source")
    (plugin / "shared/panel-snapshot.ts").write_text("source")
    (root / "runtime/package.json").write_text("{}")
    (root / "runtime/node_modules").mkdir()
    (root / "runtime/node_modules/private").write_text("not shipped")
    (root / "teams/default/dist").mkdir(parents=True)
    (root / "teams/default/resources/rules").mkdir(parents=True)
    (root / "teams/default-minimal/dist").mkdir(parents=True)
    (root / "teams/default-minimal/resources/rules").mkdir(parents=True)
    for team in ("default", "default-minimal"):
        (root / "teams" / team / "package.json").write_text("{}")
        (root / "teams" / team / "dist/index.js").write_text(team)
        (root / "teams" / team / "resources/rules/main.md").write_text(team)
    (root / "services/templates").mkdir(parents=True)
    (root / "services/compose.yaml").write_text("services: {}")
    (root / "services/templates/crawl4ai.yml").write_text("app: {}")

    bundle = root / "src/ltcook_distr/bundle"
    staged = stage_assets(root, bundle)

    assert Path(".node-version") in staged
    assert Path("package-lock.json") in staged
    assert Path("runtime/dist/main.js") in staged
    assert Path("runtime/dist/integrations/pi-rpc.js") in staged
    if os.name == "posix":
        assert (bundle / "runtime/dist/integrations/pi-rpc.js").stat().st_mode & 0o111
    assert Path("runtime/dist/paseo-plugin/paseo-plugin.json") in staged
    assert Path("runtime/dist/paseo-plugin/index.server.ts") in staged
    assert Path("runtime/dist/paseo-plugin/index.client.tsx") in staged
    assert Path("runtime/dist/paseo-plugin/shared/panel-snapshot.ts") in staged
    assert Path("teams/default/resources/rules/main.md") in staged
    assert Path("teams/default-minimal/dist/index.js") in staged
    assert Path("services/templates/crawl4ai.yml") in staged
    assert not (bundle / "runtime/node_modules").exists()
    bundle_link = root / "src/ltcook_distr/bundle-link"
    bundle_link.symlink_to(bundle, target_is_directory=True)
    with pytest.raises(ValueError, match="Unsafe production bundle destination"):
        stage_assets(root, bundle_link)


def test_package_cli_preserves_destination_leaf_symlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Keep the destination symlink visible to the ownership guard."""
    from ltcook_dev.packaging import package_assets

    target = tmp_path / "managed"
    target.mkdir()
    link = tmp_path / "bundle-link"
    link.symlink_to(target, target_is_directory=True)
    observed: list[Path] = []
    monkeypatch.setattr(
        package_assets,
        "stage_assets",
        lambda _root, destination: observed.append(destination) or (),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "package-assets",
            "--root",
            str(tmp_path),
            "--destination",
            str(link),
        ],
    )

    assert package_assets.main() == 0
    assert observed[0] == link
    assert observed[0].is_symlink()


def test_pyapp_pairs_installer_and_wheel_and_preserves_args(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Execute the paired AppRC archive and validate its adjacent wheel input."""
    import hashlib
    import zipfile

    from ltcook_dev.packaging import build_pyapp

    source = tmp_path / "pyapp"
    (source / "src").mkdir(parents=True)
    (source / "Cargo.toml").write_text("[package]")
    (source / "src/main.rs").write_text("fn main() {}")
    cargo_target = tmp_path / "cargo-target"
    built = cargo_target / "x86_64-unknown-linux-gnu/release/pyapp"
    built.parent.mkdir(parents=True)
    built.write_bytes(b"native-launcher")
    installer = tmp_path / "main-installer.pyz"
    with zipfile.ZipFile(installer, "w") as archive:
        archive.writestr(
            "__main__.py",
            "import argparse, hashlib, json, os\n"
            "from pathlib import Path\n"
            "parser = argparse.ArgumentParser()\n"
            "parser.add_argument('--package-wheel', type=Path)\n"
            "parser.add_argument('--package-wheel-sha256')\n"
            "args, remaining = parser.parse_known_args()\n"
            "if args.package_wheel is not None:\n"
            "    assert args.package_wheel.is_file()\n"
            "    assert hashlib.sha256(args.package_wheel.read_bytes()).hexdigest() == "
            "args.package_wheel_sha256\n"
            "elif args.package_wheel_sha256 is not None:\n"
            "    raise SystemExit('wheel digest without wheel')\n"
            "Path(os.environ['PYAPP_TEST_ARGV']).write_text("
            "json.dumps({'wheel': str(args.package_wheel) if args.package_wheel else None, "
            "'digest': args.package_wheel_sha256, 'args': remaining}), encoding='utf-8')\n",
        )
    root = tmp_path / "ltcook"
    root.mkdir()
    (root / "pyproject.toml").write_text(
        "[project]\n"
        'name = "ltcook"\n'
        'version = "0.1.0"\n'
        'dependencies = ["apprc-core==0.33.0", "apprc==0.33.0", "typer"]\n'
    )
    wheel = tmp_path / "ltcook-0.1.0-py3-none-any.whl"
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr(
            "ltcook-0.1.0.dist-info/METADATA",
            "Metadata-Version: 2.1\nName: ltcook\nVersion: 0.1.0\n\n",
        )
    wheel_digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
    calls: list[tuple[list[str], dict[str, str]]] = []
    python_run = subprocess.run
    dependencies: list[str] = []
    monkeypatch.setattr(build_pyapp.shutil, "which", lambda _: "/tools/cargo")

    def fake_cargo(command, *, env, **_kwargs):
        calls.append((command, env))
        dependencies.append(
            Path(env["PYAPP_PROJECT_DEPENDENCY_FILE"]).read_text(encoding="utf-8")
        )
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(build_pyapp.subprocess, "run", fake_cargo)
    monkeypatch.setenv("CARGO_TARGET_DIR", str(cargo_target))
    output = build_pyapp.build_pyapp(
        source,
        installer,
        wheel,
        tmp_path / "out/ltcook-install",
        root=root,
        target="x86_64-unknown-linux-gnu",
    )

    sidecar = output.parent / "main-installer.pyz"
    wheel_sidecar = output.parent / wheel.name
    assert output.read_bytes() == b"native-launcher"
    assert sidecar.read_bytes() == installer.read_bytes()
    assert wheel_sidecar.read_bytes() == wheel.read_bytes()
    assert calls[0][1]["PYAPP_PROJECT_NAME"] == "ltcook-installer"
    assert calls[0][1]["PYAPP_PROJECT_DEPENDENCY_FILE"]
    assert calls[0][1]["PYAPP_SKIP_INSTALL"] == "false"
    assert calls[0][1]["PYAPP_PASS_LOCATION"] == "true"
    assert dependencies == ["apprc-core==0.33.0\n"]
    assert calls[0][1]["CARGO_TARGET_DIR"] == str(cargo_target)
    assert calls[0][0][-2:] == ["--target", "x86_64-unknown-linux-gnu"]

    args_file = tmp_path / "installer-argv.json"
    python_environment = os.environ.copy()
    python_environment["PYAPP"] = str(output)
    python_environment["PYAPP_TEST_ARGV"] = str(args_file)
    forwarded = ["--workspace", str(root), "--option", "kept"]
    result = python_run(
        [
            sys.executable,
            "-c",
            calls[0][1]["PYAPP_EXEC_CODE"],
            *forwarded,
        ],
        env=python_environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(args_file.read_text(encoding="utf-8")) == {
        "wheel": str(wheel_sidecar),
        "digest": wheel_digest,
        "args": forwarded,
    }

    repair_arguments = ["--repair", "--directory", str(tmp_path / "installed")]
    result = python_run(
        [
            sys.executable,
            "-c",
            calls[0][1]["PYAPP_EXEC_CODE"],
            *repair_arguments,
        ],
        env=python_environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(args_file.read_text(encoding="utf-8")) == {
        "wheel": str(wheel_sidecar),
        "digest": wheel_digest,
        "args": repair_arguments,
    }


def test_local_wheel_source_prepares_without_checkout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Prepare the explicit wheel through AppRC without an editable project source."""
    import hashlib
    import zipfile

    from apprc.definition.installation import InstallationSource
    from apprc.distribution.runtime import SourceSelection

    from ltcook_distr.payload.app_lifecycle.install import _select_package_wheel

    metadata = read_project_metadata(ROOT)
    spec = distribution_spec(ROOT, metadata)
    wheel = tmp_path / (
        f"{metadata.identity.distribution}-{metadata.version}-py3-none-any.whl"
    )
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr(
            f"{metadata.identity.distribution}-{metadata.version}.dist-info/METADATA",
            f"Metadata-Version: 2.1\n"
            f"Name: {metadata.identity.distribution}\n"
            f"Version: {metadata.version}\n\n",
        )
    digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
    editable = SourceSelection(
        InstallationSource(kind="editable", requirement=str(ROOT))
    )
    selected = _select_package_wheel(spec, editable, wheel.resolve(), digest)
    assert selected.source.kind == "wheel"
    assert selected.source.requirement == str(wheel.resolve())
    assert selected.source.version == metadata.version
    assert selected.source.digest == digest

    isolated_cwd = tmp_path / "isolated-cwd"
    isolated_cwd.mkdir()
    monkeypatch.chdir(isolated_cwd)
    with tempfile.TemporaryDirectory(prefix="ltcook-wheel-test-") as staging:
        prepared = selected.prepare(Path(staging).resolve())
        prepared_wheel = Path(prepared.requirement)
        assert prepared.source.kind == "wheel"
        assert prepared.source.requirement == str(wheel.resolve())
        assert prepared_wheel.is_file()
        assert prepared_wheel.parent.name == f"apprc-source-{digest}"
        assert prepared_wheel.read_bytes() == wheel.read_bytes()
