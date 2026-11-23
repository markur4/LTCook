"""Prepare LTCook's declaration-selected Node runtime and private JS deployment."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import tarfile
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from ._colgrep import COLGREP_VERSION, prepare_colgrep
from ._common import (
    SetupError,
    download,
    extract_archive,
    no_links,
    owned_directory,
    run,
    setup_lock,
    write_json,
)

_BRIEF_VERSION = "0.16.0"
_BRIEF_DIGESTS = {
    (
        "Linux",
        "x86_64",
    ): "b524dcb54ce4d4057ba7ebef6159fc82c2e0444f7eabaf8a11ef9825dc402336",
    (
        "Linux",
        "aarch64",
    ): "62dfe018ced4040b17799bb6c8e4850db46ff383f67ad58f763c8ab91ee62958",
    (
        "Darwin",
        "x86_64",
    ): "5a22d6e5f188c8b30d1f773de7ada5e422b012106c5399ad031522ed7601f079",
    (
        "Darwin",
        "arm64",
    ): "e000fad1adaec36574eea450babb39af5eab72743f14fbf2ae9a60f51e80de5a",
    (
        "Windows",
        "AMD64",
    ): "a5f47f1c05723c3bb52e9ca47b4dfd1250c4add72e362360fb1b4dbf7b27ff4a",
}


def _prepare_brief(deployment: Path, record: dict[str, Any]) -> None:
    """Repair the optional pinned discovery executable without rebuilding Node.

    :param deployment: LTCook-owned deployment directory.
    :param record: Runtime receipt updated with discovery availability.
    :return: None.
    """
    system, machine = platform.system(), platform.machine()
    digest = _BRIEF_DIGESTS.get((system, machine))
    binary = deployment / "brief" / ("brief.exe" if system == "Windows" else "brief")
    try:
        if digest is None:
            raise SetupError(f"No pinned brief asset for {system}/{machine}.")
        if record.get("brief_version") == _BRIEF_VERSION and binary.is_file():
            no_links(binary)
            return
        os_name = {"Linux": "linux", "Darwin": "darwin", "Windows": "windows"}[system]
        machine_name = {
            "x86_64": "amd64",
            "aarch64": "arm64",
            "arm64": "arm64",
            "AMD64": "amd64",
        }[machine]
        name = f"brief_{_BRIEF_VERSION}_{os_name}_{machine_name}.tar.gz"
        archive = deployment / name
        download(
            f"https://github.com/git-pkgs/brief/releases/download/v{_BRIEF_VERSION}/{name}",
            archive,
            digest,
        )
        with tempfile.TemporaryDirectory(
            prefix="brief-stage-", dir=deployment
        ) as temporary:
            stage = Path(temporary)
            extract_archive(archive, stage)
            source = stage / binary.name
            if not source.is_file() or source.is_symlink():
                raise SetupError("Pinned brief archive lacks its executable.")
            target = owned_directory(binary.parent) / binary.name
            no_links(target)
            shutil.copyfile(source, target)
            target.chmod(0o700)
        record["brief_version"] = _BRIEF_VERSION
        record["brief_executable"] = str(binary)
        record.pop("brief_unavailable_reason", None)
    except (OSError, SetupError, tarfile.TarError, zipfile.BadZipFile) as exc:
        record.pop("brief_version", None)
        record.pop("brief_executable", None)
        record["brief_unavailable_reason"] = str(exc)
    write_json(deployment / "runtime.json", record)


def _prepare_repo_search(deployment: Path, record: dict[str, Any]) -> None:
    """Report optional repository-search readiness without invalidating Node."""
    try:
        assets = prepare_colgrep(deployment)
        record["colgrep_version"] = COLGREP_VERSION
        record["colgrep_assets"] = str(assets)
        record.pop("colgrep_unavailable_reason", None)
    except (OSError, SetupError, tarfile.TarError, zipfile.BadZipFile, KeyError) as exc:
        record.pop("colgrep_version", None)
        record.pop("colgrep_assets", None)
        record["colgrep_unavailable_reason"] = str(exc)
    write_json(deployment / "runtime.json", record)


def _node_asset(version: str, system: str, machine: str) -> tuple[str, str, str]:
    """Resolve official Node archive names from the current platform."""
    os_name = {"Linux": "linux", "Darwin": "darwin", "Windows": "win"}.get(system)
    architecture = {
        "x86_64": "x64",
        "AMD64": "x64",
        "aarch64": "arm64",
        "arm64": "arm64",
    }.get(machine)
    if system == "Windows" and architecture != "x64":
        raise SetupError(
            "LTCook's Windows runtime supports the native x64 target only."
        )
    if os_name is None or architecture is None:
        raise SetupError(f"No official Node runtime archive for {system}/{machine}.")
    suffix = ".zip" if os_name == "win" else ".tar.gz"
    basename = f"node-v{version}-{os_name}-{architecture}"
    return f"https://nodejs.org/dist/v{version}/{basename}{suffix}", basename, suffix


def _inputs(root: Path) -> tuple[Path, ...]:
    """Select exact production payload inputs, excluding checkout/development files."""
    required = [
        root / name for name in ("package.json", "package-lock.json", ".node-version")
    ]
    directories = (root / "runtime", root / "teams", root / "services")
    required.extend(
        path
        for directory in directories
        for path in directory.rglob("*")
        if path.is_file()
        and not path.is_symlink()
        and not {"node_modules", ".git", ".cache"}.intersection(
            path.relative_to(root).parts
        )
    )
    for path in required:
        if path.is_symlink() or not path.is_file():
            raise SetupError(
                f"Production payload input is missing or linked: {path.name}."
            )
    return tuple(sorted(set(required)))


def _fingerprint(root: Path, inputs: tuple[Path, ...]) -> str:
    """Bind readiness to the exact declarations and shipped production assets."""
    digest = hashlib.sha256()
    for path in inputs:
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _ready(deployment: Path, fingerprint: str) -> bool:
    """Reuse only a complete installation whose source fingerprint matches."""
    try:
        no_links(deployment / "runtime.json")
        record = json.loads((deployment / "runtime.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(record, dict):
        return False
    node = Path(record.get("node", ""))
    app = Path(record.get("app", ""))
    expected_node = (
        deployment / "node" / ("node.exe" if os.name == "nt" else "bin/node")
    )
    expected_app = deployment / "app"
    no_links(node)
    no_links(app)
    no_links(app / "node_modules")
    no_links(deployment / "browser-home")
    browser = _chrome_binary(deployment / "browser-home")
    browser_available = record.get("browser_available") is True and browser is not None
    browser_optional_failure = record.get("browser_available") is False
    return (
        record.get("schema") == 1
        and record.get("fingerprint") == fingerprint
        and node == expected_node
        and app == expected_app
        and node.is_file()
        and (app / "node_modules").is_dir()
        and (app / "runtime/dist/main.js").is_file()
        and all(
            (app / "teams" / team / "resources").is_dir()
            for team in ("default", "default-minimal")
        )
        and (browser_available or browser_optional_failure)
    )


def _chrome_binary(browser_home: Path) -> Path | None:
    """Locate Chrome from agent-browser's documented private cache layout."""
    if os.name == "nt":
        patterns = ("chrome.exe", "chrome-win64/chrome.exe")
    elif platform.system() == "Darwin":
        patterns = (
            "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        )
    else:
        patterns = ("chrome", "chrome-linux64/chrome")
    browser_root = browser_home / ".agent-browser" / "browsers"
    return next(
        (
            candidate
            for directory in sorted(browser_root.glob("chrome-*"), reverse=True)
            for pattern in patterns
            if (candidate := directory / pattern).is_file()
        ),
        None,
    )


def _retry_browser(
    deployment: Path, record: dict[str, Any], environment: dict[str, str]
) -> None:
    """Retry only the browser prerequisite without reinstalling Node or JS packages."""
    app = Path(record["app"])
    browser_home = deployment / "browser-home"
    try:
        browser_home = owned_directory(browser_home)
        browser = (
            app
            / "node_modules/.bin"
            / ("agent-browser.cmd" if os.name == "nt" else "agent-browser")
        )
        if not browser.is_file():
            raise SetupError("Root production lock did not install agent-browser.")
        browser_environment = dict(environment)
        node_bin = deployment / "node" / ("." if os.name == "nt" else "bin")
        browser_environment["PATH"] = os.pathsep.join(
            (str(node_bin), str(app / "node_modules/.bin"), environment.get("PATH", ""))
        )
        browser_environment["HOME"] = str(browser_home)
        browser_environment["USERPROFILE"] = str(browser_home)
        browser_environment["LOCALAPPDATA"] = str(browser_home / "AppData/Local")
        browser_environment["APPDATA"] = str(browser_home / "AppData/Roaming")
        browser_environment["XDG_CACHE_HOME"] = str(browser_home / ".cache")
        browser_environment["PLAYWRIGHT_BROWSERS_PATH"] = str(
            browser_home / "playwright"
        )
        command = [str(browser), "install"]
        if os.name == "nt":
            import subprocess

            command = ["cmd.exe", "/d", "/s", "/c", subprocess.list2cmdline(command)]
        run(command, environment=browser_environment, cwd=app)
        chrome = _chrome_binary(browser_home)
        if chrome is None:
            raise SetupError(
                "agent-browser install completed without a Chrome executable in its isolated cache."
            )
    except (SetupError, OSError) as exc:
        record["browser_unavailable_reason"] = str(exc)
    else:
        record["browser_available"] = True
        record["browser_executable"] = str(chrome)
        record.pop("browser_unavailable_reason", None)
    write_json(deployment / "runtime.json", record)


def prepare_runtime(
    root: Path, appdata: Path, *, environment: dict[str, str] | None = None
) -> Path:
    """Install the selected Node version and production lock into AppRC appdata.

    :param root: Extracted canonical bundle containing production declarations.
    :param appdata: AppRC-owned appdata root.
    :param environment: Environment for package-manager and browser child commands.
    :return: LTCook-owned deployment directory.
    """
    inputs = _inputs(root)
    version = (root / ".node-version").read_text(encoding="utf-8").strip()
    if re.fullmatch(r"\d+\.\d+\.\d+", version) is None:
        raise SetupError("The bundled .node-version is not an exact release version.")
    fingerprint = _fingerprint(root, inputs)
    deployment = owned_directory(appdata / "deployment")
    env = dict(os.environ if environment is None else environment)
    browser_enabled = env.get("LTCOOK_BROWSER_ENABLED", "true") != "false"
    with setup_lock(deployment):
        if _ready(deployment, fingerprint):
            record = json.loads(
                (deployment / "runtime.json").read_text(encoding="utf-8")
            )
            if browser_enabled and record.get("browser_available") is False:
                _retry_browser(deployment, record, env)
                record = json.loads(
                    (deployment / "runtime.json").read_text(encoding="utf-8")
                )
            _prepare_brief(deployment, record)
            _prepare_repo_search(deployment, record)
            return deployment
        archive_url, archive_name, suffix = _node_asset(
            version, platform.system(), platform.machine()
        )
        archive = deployment / f"{archive_name}{suffix}"
        if not archive.is_file():
            download(archive_url, archive)
        stage = Path(tempfile.mkdtemp(prefix="node-stage-", dir=deployment))
        try:
            try:
                extract_archive(archive, stage)
            except (SetupError, OSError, tarfile.TarError, zipfile.BadZipFile) as exc:
                archive.unlink(missing_ok=True)
                if isinstance(exc, SetupError):
                    raise
                raise SetupError(
                    "Official Node archive extraction failed; retry setup."
                ) from exc
            extracted = stage / archive_name
            if not extracted.is_dir():
                raise SetupError(
                    "Official Node archive has an unexpected top-level directory."
                )
            (extracted / ".ltcook-owned-node").write_text(
                "LTCook Node installation\n", encoding="utf-8"
            )
            node_target = deployment / "node"
            if node_target.exists():
                no_links(node_target)
                if (
                    not node_target.is_dir()
                    or (node_target / ".ltcook-owned-node").read_text(encoding="utf-8")
                    != "LTCook Node installation\n"
                ):
                    raise SetupError(
                        "Refusing to replace a Node directory not owned by LTCook."
                    )
                shutil.rmtree(node_target)
            extracted.replace(node_target)
        finally:
            shutil.rmtree(stage, ignore_errors=True)
        node = deployment / "node" / ("node.exe" if os.name == "nt" else "bin/node")
        npm = deployment / "node" / ("npm.cmd" if os.name == "nt" else "bin/npm")
        if not node.is_file() or not npm.is_file():
            raise SetupError("Official Node archive lacks Node or npm.")
        app_target = deployment / "app"
        staged_app = deployment / "app.partial"
        if staged_app.exists():
            no_links(staged_app)
            marker = staged_app / ".ltcook-owned-app"
            if not staged_app.is_dir() or not marker.is_file():
                raise SetupError(
                    "Refusing to remove an incomplete app directory not owned by LTCook."
                )
            shutil.rmtree(staged_app)
        staged_app.mkdir(mode=0o700)
        (staged_app / ".ltcook-owned-app").write_text(
            "LTCook production app\n", encoding="utf-8"
        )
        for path in inputs:
            destination = staged_app / path.relative_to(root)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)
        if not (staged_app / "runtime/dist/main.js").is_file():
            raise SetupError("Compiled runtime is missing from the production payload.")
        for team in ("default", "default-minimal"):
            if not (staged_app / "teams" / team / "resources").is_dir():
                raise SetupError(f"Team resources are missing from payload: {team}.")
        npm_env = dict(env)
        npm_env["PATH"] = os.pathsep.join((str(npm.parent), env.get("PATH", "")))
        browser_home = deployment / "browser-home"
        npm_command = str(npm)
        command = [npm_command, "ci", "--omit=dev", "--no-audit", "--no-fund"]
        if os.name == "nt":
            import subprocess

            command = ["cmd.exe", "/d", "/s", "/c", subprocess.list2cmdline(command)]
        run(command, environment=npm_env, cwd=staged_app)
        browser_available = False
        browser_error = None
        if not browser_enabled:
            browser_error = (
                "Browser installation skipped because LTCOOK_BROWSER_ENABLED=false."
            )
        else:
            try:
                browser_home = owned_directory(browser_home)
                browser = (
                    staged_app
                    / "node_modules/.bin"
                    / ("agent-browser.cmd" if os.name == "nt" else "agent-browser")
                )
                if not browser.is_file():
                    raise SetupError(
                        "Root production lock did not install agent-browser."
                    )
                browser_env = dict(npm_env)
                browser_env["HOME"] = str(browser_home)
                browser_env["USERPROFILE"] = str(browser_home)
                browser_env["LOCALAPPDATA"] = str(browser_home / "AppData/Local")
                browser_env["APPDATA"] = str(browser_home / "AppData/Roaming")
                browser_env["XDG_CACHE_HOME"] = str(browser_home / ".cache")
                browser_env["PLAYWRIGHT_BROWSERS_PATH"] = str(
                    browser_home / "playwright"
                )
                browser_command = [str(browser), "install"]
                if os.name == "nt":
                    import subprocess

                    browser_command = [
                        "cmd.exe",
                        "/d",
                        "/s",
                        "/c",
                        subprocess.list2cmdline(browser_command),
                    ]
                run(browser_command, environment=browser_env, cwd=staged_app)
                chrome = _chrome_binary(browser_home)
                if chrome is None:
                    raise SetupError(
                        "agent-browser install completed without a Chrome executable in its isolated cache."
                    )
                browser_available = True
            except (SetupError, OSError) as exc:
                browser_error = str(exc)
        if app_target.exists():
            no_links(app_target)
            marker = app_target / ".ltcook-owned-app"
            if not app_target.is_dir() or not marker.is_file():
                raise SetupError(
                    "Refusing to replace an app directory not owned by LTCook."
                )
            shutil.rmtree(app_target)
        staged_app.replace(app_target)
        record = {
            "schema": 1,
            "fingerprint": fingerprint,
            "node_version": version,
            "node": str(node),
            "app": str(app_target),
            "browser_home": str(browser_home),
            "browser_available": browser_available,
        }
        if browser_available:
            record["browser_executable"] = str(chrome)
        elif browser_error:
            record["browser_unavailable_reason"] = browser_error
        write_json(deployment / "runtime.json", record)
        _prepare_brief(deployment, record)
        _prepare_repo_search(deployment, record)
    return deployment


def main() -> int:
    """Prepare only the bundled Node runtime without invoking Podman or AppRC."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle-root", type=Path, required=True)
    parser.add_argument("--appdata", type=Path, required=True)
    arguments = parser.parse_args()
    deployment = prepare_runtime(
        arguments.bundle_root.resolve(strict=True),
        arguments.appdata.resolve(),
        environment=dict(os.environ),
    )
    print(deployment)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
