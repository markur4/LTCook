"""Launch the TypeScript runtime with its workspace-resolved AppRC environment."""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence
from pathlib import Path

from ltcook.launch import resolve_launch


def main(argv: Sequence[str] | None = None) -> int:
    """Run the development runtime from a checkout using workspace settings.

    Arguments after ``--`` are forwarded to the runtime entrypoint. The
    optional ``--watch`` flag enables Bun's file watcher.
    """
    arguments = list(sys.argv[1:] if argv is None else argv)
    try:
        separator = arguments.index("--")
    except ValueError:
        raise SystemExit("Place runtime arguments after `--`.") from None
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--bun")
    parser.add_argument("--watch", action="store_true")
    options = parser.parse_args(arguments[:separator])
    runtime_arguments = arguments[separator + 1 :]

    source_root = options.root.resolve(strict=True)
    entrypoint = source_root / "runtime" / "src" / "main.ts"
    if not entrypoint.is_file():
        raise FileNotFoundError(f"Runtime entrypoint is missing: {entrypoint}")
    workspace = options.workspace or source_root

    original_environment = dict(os.environ)
    original_environment["LTCOOK_JS_ROOT"] = str(source_root)
    launch = resolve_launch(workspace, original_environment=original_environment)
    launch.environment["LTCOOK_SHELL_PROVENANCE"] = json.dumps(original_environment)
    bun = options.bun or original_environment.get("BUN") or "bun"
    os.chdir(source_root)
    command = [bun]
    if options.watch:
        command.append("--watch")
    command.extend(("runtime/src/main.ts", *runtime_arguments))
    try:
        os.execvpe(bun, command, launch.environment)
    except OSError as exc:
        print(f"Cannot start Bun executable {bun!r}: {exc}", file=sys.stderr)
        return 127
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
