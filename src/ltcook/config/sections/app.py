"""Session and installation declarations shared by every launch."""

import apprc as rc

from ltcook.config.app import APP_RC


@APP_RC.config("app", prefix="LTCOOK_", title="Application", rc_path=("app",))
class AppSettings(rc.Config):
    """Select a fixed team and the application-owned deployment."""

    team: str = rc.field("LTCOOK_TEAM", default="default-minimal")
    session: str = rc.field("LTCOOK_SESSION", default="")
    deployment: str = rc.field("LTCOOK_DEPLOYMENT_DIR", default="")
    python: str = rc.field("LTCOOK_PYTHON", default="")
    node_executable: str = rc.field("LTCOOK_NODE_EXECUTABLE", default="")
    workspace: str = rc.field("LTCOOK_WORKSPACE", default="")
