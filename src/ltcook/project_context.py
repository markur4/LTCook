"""Collect bounded project declarations without running project code."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
from datetime import UTC, datetime
from pathlib import Path

_MANIFESTS = ("package.json", "pyproject.toml", "Cargo.toml", "go.mod")
_JUSTFILES = ("justfile", "Justfile", ".justfile")
_MAX_SOURCE_BYTES = 1024 * 1024


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _tool(name: str, workspace: Path) -> str | None:
    """Use installed tools outside the project, excluding project executables."""
    candidate = sys.executable if name == "python" else shutil.which(name)
    if candidate is None or not Path(candidate).is_absolute():
        return None
    resolved = Path(candidate).resolve()
    if name != "python" and resolved.is_relative_to(workspace):
        return None
    return str(resolved)


def _run(arguments: list[str], workspace: Path) -> str:
    environment = {**os.environ, "GIT_OPTIONAL_LOCKS": "0", "NO_COLOR": "1"}
    result = subprocess.run(
        arguments,
        cwd=workspace,
        env=environment,
        capture_output=True,
        text=True,
        timeout=3,
        check=False,
    )
    if result.returncode:
        raise ValueError(f"{Path(arguments[0]).name} exited with {result.returncode}")
    if len(result.stdout) > 65536:
        raise ValueError(
            f"{Path(arguments[0]).name} output exceeded the snapshot limit"
        )
    return result.stdout.rstrip("\r\n")


def _manifest(name: str, text: str) -> dict[str, object]:
    """Translate declarations only; scripts and build backends are never invoked."""
    packages: list[dict[str, str]] = []
    commands: dict[str, str] = {}
    languages: list[str] = []
    kind = name
    if name == "package.json":
        data = json.loads(text)
        languages = ["JavaScript"]
        if "typescript" in data.get("devDependencies", {}) or "typescript" in data.get(
            "dependencies", {}
        ):
            languages.append("TypeScript")
        if isinstance(data.get("name"), str):
            packages.append(
                {"name": data["name"], "version": str(data.get("version", ""))}
            )
        for key, value in data.get("scripts", {}).items():
            if isinstance(value, str):
                commands[str(key)] = value
    elif name in {"pyproject.toml", "Cargo.toml"}:
        data = tomllib.loads(text)
        section = data.get("project" if name == "pyproject.toml" else "package", {})
        languages = ["Python" if name == "pyproject.toml" else "Rust"]
        if isinstance(section.get("name"), str):
            packages.append(
                {"name": section["name"], "version": str(section.get("version", ""))}
            )
        if name == "pyproject.toml":
            for key, value in section.get("scripts", {}).items():
                if isinstance(value, str):
                    commands[str(key)] = value
    else:
        languages = ["Go"]
        module = re.search(r"^module\s+(\S+)", text, re.MULTILINE)
        if module:
            packages.append({"name": module.group(1), "version": ""})
    return {
        "path": name,
        "kind": kind,
        "languages": languages,
        "packages": packages,
        "commands": commands,
    }


def _recipes(text: str) -> list[dict[str, str]]:
    recipes: list[dict[str, str]] = []
    current: list[str] | None = None
    for line in text.splitlines():
        match = re.match(r"^(@?[A-Za-z_][\w-]*)(?:\s+[^:=]*)?:(?!=)", line)
        if match:
            current = [line]
            recipes.append({"name": match.group(1).lstrip("@"), "definition": line})
        elif current is not None and (not line or line[0].isspace()):
            current.append(line)
            recipes[-1]["definition"] = "\n".join(current).rstrip()
        elif line and not line.startswith("#"):
            current = None
    return recipes


def project_snapshot(workspace_root: Path, cache_dir: Path) -> dict[str, object]:
    """Cache stable declarations and collect fresh, read-only Git status.

    :param workspace_root: Existing project directory; no marker is required.
    :param cache_dir: Globally resolved AppRC project-cache directory.
    :return: Sources, freshness, declarations and explicit coverage limitations.
    """
    workspace = workspace_root.expanduser().resolve(strict=True)
    if not workspace.is_dir():
        raise ValueError("Project snapshot requires an existing directory")
    incomplete = [
        (
            "Only root manifests and literal Just recipes are inspected; includes, "
            "workspace members and generated commands are not expanded."
        )
    ]
    sources: list[dict[str, str]] = []
    texts: dict[str, str] = {}
    for name in (*_MANIFESTS, *_JUSTFILES):
        path = workspace / name
        if not path.exists():
            sources.append({"path": name, "fingerprint": "absent"})
            continue
        if (
            path.is_symlink()
            or not path.is_file()
            or path.stat().st_size > _MAX_SOURCE_BYTES
        ):
            incomplete.append(f"Skipped linked, nonregular or oversized source: {name}")
            sources.append({"path": name, "fingerprint": "unsupported"})
            continue
        try:
            content = path.read_bytes()
            sources.append(
                {"path": name, "fingerprint": hashlib.sha256(content).hexdigest()}
            )
            texts[name] = content.decode("utf-8")
        except (OSError, UnicodeError) as error:
            incomplete.append(f"Cannot read {name}: {type(error).__name__}")
    executables = {
        name: _tool(name, workspace)
        for name in ("python", "node", "bun", "git", "just", "uv")
    }
    tool_sources = []
    for name, executable in executables.items():
        if executable:
            stat = Path(executable).stat()
            tool_sources.append(
                f"{name}:{executable}:{stat.st_mtime_ns}:{stat.st_size}"
            )
    fingerprint = hashlib.sha256(
        json.dumps([sources, tool_sources], sort_keys=True).encode()
    ).hexdigest()
    cache_dir = cache_dir.expanduser().resolve()
    identity = hashlib.sha256(str(workspace).encode()).hexdigest()
    cached_path = cache_dir / f"{identity}.json"
    cached = None
    try:
        candidate = json.loads(cached_path.read_text(encoding="utf-8"))
        if candidate.get("format") == 1 and candidate.get("fingerprint") == fingerprint:
            cached = candidate
    except (OSError, ValueError, AttributeError):
        pass
    reused = cached is not None
    if cached is None:
        manifests = []
        for name in _MANIFESTS:
            if name not in texts:
                continue
            try:
                manifests.append(_manifest(name, texts[name]))
            except (ValueError, TypeError, AttributeError) as error:
                incomplete.append(f"Cannot parse {name}: {type(error).__name__}")
        recipes = []
        for name in _JUSTFILES:
            if name in texts:
                recipes.extend(_recipes(texts[name]))
        tools = []
        for name, executable in executables.items():
            if not executable:
                incomplete.append(f"Installed tool unavailable outside project: {name}")
                continue
            try:
                version = (
                    sys.version.split()[0]
                    if name == "python"
                    else _run([executable, "--version"], workspace).splitlines()[0]
                )
                tools.append({"name": name, "version": version, "source": executable})
            except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
                incomplete.append(f"Installed version unavailable: {name}")
        cached = {
            "format": 1,
            "fingerprint": fingerprint,
            "refreshedAt": _now(),
            "facts": {"manifests": manifests, "justRecipes": recipes, "tools": tools},
            "incomplete": incomplete,
        }
        cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor, temporary = tempfile.mkstemp(prefix=".project-", dir=cache_dir)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(cached, stream)
            os.replace(temporary, cached_path)
        finally:
            Path(temporary).unlink(missing_ok=True)
    git: dict[str, object] = {"capturedAt": _now()}
    executable = executables["git"]
    if executable:
        command = [
            executable,
            "--no-pager",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
        ]
        try:
            git["root"] = _run([*command, "rev-parse", "--show-toplevel"], workspace)
            git["branch"] = _run(
                [*command, "rev-parse", "--abbrev-ref", "HEAD"], workspace
            )
            git["status"] = _run(
                [
                    *command,
                    "status",
                    "--porcelain=v1",
                    "--untracked-files=normal",
                    "--ignore-submodules=all",
                ],
                workspace,
            )
        except (OSError, ValueError, subprocess.TimeoutExpired) as error:
            git["error"] = str(error)
    else:
        git["error"] = "Installed Git unavailable outside project"
    return {
        "workspaceRoot": str(workspace),
        "capturedAt": _now(),
        "facts": cached["facts"],
        "cache": {
            "path": str(cached_path),
            "refreshedAt": cached["refreshedAt"],
            "reused": reused,
        },
        "git": git,
        "sources": sources,
        "incomplete": cached["incomplete"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(project_snapshot(args.workspace, args.cache_dir)))


if __name__ == "__main__":
    main()
