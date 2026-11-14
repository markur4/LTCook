"""LTCook entry points for Pi-managed provider authentication."""

from __future__ import annotations

import os
from collections.abc import Sequence
from pathlib import Path
from typing import Annotated

import typer

from ltcook.launch import resolve_launch

auth_cli = typer.Typer(no_args_is_help=True)


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
    """Sign in to a provider using Pi's native credential flow."""
    if api_key and no_browser:
        raise typer.BadParameter("--no-browser cannot be used with --api-key.")
    arguments = ["login", provider]
    if api_key:
        arguments.append("--api-key")
    if no_browser:
        arguments.append("--no-browser")
    _invoke_native_pi(arguments)


@auth_cli.command("logout")
def logout(provider: str) -> None:
    """Sign out of a provider using Pi's native credential store."""
    _invoke_native_pi(["logout", provider])


@auth_cli.command("check")
def check(
    provider: Annotated[str | None, typer.Option("--provider")] = None,
    model: Annotated[str | None, typer.Option("--model")] = None,
    json_output: Annotated[bool, typer.Option("--json")] = False,
    no_refresh: Annotated[bool, typer.Option("--no-refresh")] = False,
) -> None:
    """Check Pi provider authentication without exposing credential values."""
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
