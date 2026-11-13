"""SearXNG, Crawl4AI and Podman declarations grouped by env prefix."""

import apprc as rc

from ltcook.config.app import APP_RC


@APP_RC.config("web", prefix="LTCOOK_", title="Web services", rc_path=("web",))
class WebSettings(rc.Config):
    """LTCook-owned service endpoints and connection settings."""

    searxng_url: str = rc.field("LTCOOK_SEARXNG_URL", default="http://127.0.0.1:8888")
    crawl4ai_url: str = rc.field(
        "LTCOOK_CRAWL4AI_URL", default="http://127.0.0.1:11235"
    )
    connection_method: str = rc.field("LTCOOK_SERVICE_CONNECTION", default="local")
    ssrf_allow_ranges: str = rc.field("LTCOOK_SSRF_ALLOW_RANGES", default="")
    compose_file: str = rc.field("LTCOOK_COMPOSE_FILE", default="")
    compose_project: str = rc.field("LTCOOK_COMPOSE_PROJECT", default="ltcook")
    podman: str = rc.field("LTCOOK_PODMAN_EXECUTABLE", default="podman")
    podman_machine: str = rc.field("LTCOOK_PODMAN_MACHINE", default="")
    service_config_dir: str = rc.field("LTCOOK_SERVICE_CONFIG_DIR", default="")


@APP_RC.config(
    "searxng", prefix="SEARXNG_", title="SearXNG", rc_path=("web", "searxng")
)
class SearXNGSettings(rc.Config):
    secret: str = rc.field("SEARXNG_SECRET", default="", secret=True)


@APP_RC.config(
    "crawl4ai", prefix="CRAWL4AI_", title="Crawl4AI", rc_path=("web", "crawl4ai")
)
class Crawl4AISettings(rc.Config):
    api_token: str = rc.field("CRAWL4AI_API_TOKEN", default="", secret=True)


@APP_RC.config("podman", prefix="PODMAN_", title="Podman", rc_path=("web", "podman"))
class PodmanSettings(rc.Config):
    compose_provider: str = rc.field("PODMAN_COMPOSE_PROVIDER", default="")


@APP_RC.config(
    "container",
    prefix="CONTAINER_",
    title="Container connection",
    rc_path=("web", "container"),
)
class ContainerSettings(rc.Config):
    connection: str = rc.field("CONTAINER_CONNECTION", default="")


@APP_RC.config(
    "playwright",
    prefix="PLAYWRIGHT_",
    title="Playwright",
    rc_path=("web", "playwright"),
)
class PlaywrightSettings(rc.Config):
    browsers_path: str = rc.field("PLAYWRIGHT_BROWSERS_PATH", default="")
