"""LTCook entry points for provider authentication."""

from __future__ import annotations

import getpass
import json
import os
import shutil
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Annotated

import typer

from ltcook.launch import resolve_launch

auth_cli = typer.Typer(no_args_is_help=True)
OPENAI_PROVIDERS = frozenset({"openai", "openai-codex"})


def _codex_cli() -> tuple[str, dict[str, str]]:
    """Resolve the user's Codex CLI in the global launch environment."""
    environment = dict(resolve_launch(original_environment=os.environ).environment)
    environment.pop("OPENAI_API_KEY", None)
    codex = shutil.which("codex", path=environment.get("PATH"))
    if codex is None:
        raise typer.BadParameter("Install Codex CLI to use OpenAI models in LTCook.")
    return codex, environment


def _check_codex(provider: str, json_output: bool) -> None:
    """Report Codex login readiness without forwarding credential output."""
    codex, environment = _codex_cli()
    try:
        result = subprocess.run(
            [codex, "login", "status"],
            env=environment,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        message = (result.stdout + result.stderr).lower()
        kind = (
            "oauth"
            if "chatgpt" in message
            else "api_key"
            if "api key" in message
            else None
        )
        expected = "oauth" if provider == "openai-codex" else "api_key"
        status = "ready" if result.returncode == 0 and kind == expected else "not_ready"
    except (OSError, subprocess.TimeoutExpired):
        kind = None
        status = "invalid"
    if json_output:
        typer.echo(
            json.dumps({"status": status, "provider": provider, "authType": kind})
        )
    else:
        typer.echo(status)
    raise typer.Exit({"ready": 0, "not_ready": 1, "invalid": 2}[status])


def _native_pi_cli() -> tuple[str, Path, dict[str, str]]:
    """Resolve managed Node, Pi's installed CLI bundle, and global auth home.

    :return: Node executable, Pi CLI path, and globally resolved child environment.
    """
    launch = resolve_launch(original_environment=os.environ)
    environment = launch.environment
    node = environment["LTCOOK_NODE_EXECUTABLE"]
    cli = (
        Path(environment["LTCOOK_JS_ROOT"])
        / "node_modules"
        / "@earendil-works"
        / "pi-coding-agent"
        / "dist"
        / "bundle"
        / "cli.js"
    )
    if not Path(node).is_file() or not cli.is_file():
        raise typer.BadParameter(
            "Pi authentication prerequisites are not prepared; re-run the LTCook installer."
        )
    child_environment = dict(environment)
    child_environment["PI_CODING_AGENT_DIR"] = environment["LTCOOK_PI_AUTH_DIR"]
    return node, cli, child_environment


def _invoke_native_pi(arguments: Sequence[str]) -> None:
    """Replace LTCook with Pi so terminal, exit, and signal behavior stay native.

    :param arguments: Native Pi auth action and the allowed public options.
    :return: Never returns after Pi is launched.
    """
    node, cli, environment = _native_pi_cli()
    os.execve(node, [node, str(cli), "auth", *arguments], environment)


@auth_cli.command("login")
def login(
    provider: str,
    api_key: Annotated[bool, typer.Option("--api-key")] = False,
    no_browser: Annotated[bool, typer.Option("--no-browser")] = False,
) -> None:
    """Sign in through the provider's LTCook authentication owner."""
    if api_key and no_browser:
        raise typer.BadParameter("--no-browser cannot be used with --api-key.")
    if provider in OPENAI_PROVIDERS:
        codex, environment = _codex_cli()
        if api_key:
            key = (
                getpass.getpass("OpenAI API key: ")
                if sys.stdin.isatty()
                else sys.stdin.readline()
            ).strip()
            if not key:
                raise typer.BadParameter("Enter an OpenAI API key to sign in.")
            result = subprocess.run(
                [codex, "login", "--with-api-key"],
                input=key + "\n",
                text=True,
                env=environment,
                check=False,
            )
            raise typer.Exit(result.returncode)
        os.execve(
            codex,
            [codex, "login", *(["--device-auth"] if no_browser else [])],
            environment,
        )
    arguments = ["login", provider]
    if api_key:
        arguments.append("--api-key")
    if no_browser:
        arguments.append("--no-browser")
    _invoke_native_pi(arguments)


@auth_cli.command("logout")
def logout(provider: str) -> None:
    """Sign out from the provider's LTCook authentication owner."""
    if provider in OPENAI_PROVIDERS:
        codex, environment = _codex_cli()
        os.execve(codex, [codex, "logout"], environment)
    _invoke_native_pi(["logout", provider])


@auth_cli.command("check")
def check(
    provider: Annotated[str | None, typer.Option("--provider")] = None,
    model: Annotated[str | None, typer.Option("--model")] = None,
    json_output: Annotated[bool, typer.Option("--json")] = False,
    no_refresh: Annotated[bool, typer.Option("--no-refresh")] = False,
) -> None:
    """Check provider authentication without exposing credential values."""
    selected_provider = provider or (model.split("/", 1)[0] if model else None)
    if selected_provider in OPENAI_PROVIDERS and selected_provider is not None:
        _check_codex(selected_provider, json_output)
    arguments = ["check"]
    if provider:
        arguments.extend(["--provider", provider])
    if model:
        arguments.extend(["--model", model])
    if json_output:
        arguments.append("--json")
    if no_refresh:
        arguments.append("--no-refresh")
    _invoke_native_pi(arguments)
