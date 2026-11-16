"""Native Compose configuration rendering."""

import os
from pathlib import Path

import pytest


@pytest.mark.system
def test_compose_stack_renders_without_starting_containers() -> None:
    """Validate native Compose rendering; requires Podman and a provider, starts no services."""
    import shutil
    import subprocess

    root = Path(__file__).resolve().parents[3]
    podman = shutil.which("podman")
    provider = shutil.which("podman-compose") or shutil.which("docker-compose")
    if podman is None or provider is None:
        pytest.skip("system render requires an installed Podman Compose provider")
    environment = os.environ.copy()
    environment["PODMAN_COMPOSE_PROVIDER"] = provider
    environment["CRAWL4AI_API_TOKEN"] = "render-only-token"
    environment["SEARXNG_SECRET"] = "render-only-secret"
    compose_file = root / "services/compose.yaml"
    result = subprocess.run(
        [
            podman,
            "compose",
            "--project-name",
            "ltcook",
            "-f",
            str(compose_file),
            "config",
        ],
        cwd=compose_file.parent,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, "Podman Compose could not render the LTCook stack."
