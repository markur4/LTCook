"""AppRC command composition for LTCook restarts."""

from pathlib import Path


def app_update_command(launcher: Path, *, assume_yes: bool) -> list[str | Path]:
    """Build the call to AppRC that owns update selection, confirmation, and execution."""
    return [launcher, "app", "update", *(["--yes"] if assume_yes else [])]
