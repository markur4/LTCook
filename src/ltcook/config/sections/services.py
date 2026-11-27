"""Host-wide organization and naming services in the LTCook runtime."""

import apprc as rc

from ltcook.config.app import APP_RC


@APP_RC.config(
    "workspace_organizer",
    prefix="LTCOOK_WORKSPACE_ORGANIZER_",
    title="Workspace Organizer",
    rc_path=("runtime", "services", "workspace_organizer"),
)
class WorkspaceOrganizerSettings(rc.Config):
    """Standard workspace labels and automatic archival on this host."""

    enabled: bool = rc.field(
        "LTCOOK_WORKSPACE_ORGANIZER_ENABLED",
        default=True,
        title="Workspace Organizer",
        explanation_short="Maintain standard labels on this Paseo host.",
    )
    auto_archive: bool = rc.field(
        "LTCOOK_WORKSPACE_ORGANIZER_AUTO_ARCHIVE",
        default=True,
        title="Archive inactive workspaces",
        explanation_short="Archive eligible workspaces after 14 days without use.",
    )


@APP_RC.config(
    "renamer",
    prefix="LTCOOK_RENAMER_",
    title="Renamer",
    rc_path=("runtime", "services", "renamer"),
)
class RenamerSettings(rc.Config):
    """Automatic workspace and agent-session titles on this host."""

    enabled: bool = rc.field(
        "LTCOOK_RENAMER_ENABLED",
        default=True,
        title="Renamer",
        explanation_short="Name workspaces and agent tabs from their first user prompts.",
    )
    workspaces: bool = rc.field(
        "LTCOOK_RENAMER_WORKSPACES",
        default=True,
        title="Rename workspaces",
        explanation_short="Keep workspace titles within 20 visible characters.",
    )
    tabs: bool = rc.field(
        "LTCOOK_RENAMER_TABS",
        default=True,
        title="Rename agent tabs",
        explanation_short="Keep agent-session titles within 15 visible characters.",
    )


@APP_RC.config(
    "bughunter",
    prefix="LTCOOK_BUGHUNTER_",
    title="BugHunter",
    rc_path=("runtime", "services", "bughunter"),
)
class BugHunterSettings(rc.Config):
    """Host-wide permission to investigate LTCook diagnostics."""

    enabled: bool = rc.field("LTCOOK_BUGHUNTER_ENABLED", default=False)
    workspace: str = rc.field("LTCOOK_BUGHUNTER_WORKSPACE", default="")
    mode: str = rc.field("LTCOOK_BUGHUNTER_MODE", default="user")
    active_minutes: int = rc.field("LTCOOK_BUGHUNTER_ACTIVE_MINUTES", default=45)
    manual_model_requests: int = rc.field(
        "LTCOOK_BUGHUNTER_MANUAL_MODEL_REQUESTS", default=12
    )
