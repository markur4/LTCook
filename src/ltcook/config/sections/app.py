"""Application settings registered with AppRC for ltcook."""

from __future__ import annotations

# == 3rd Party ===============================
import apprc as rc

# == Internal ================================
from ltcook.config.app import APP_RC


@APP_RC.config(
    "app",
    prefix="LTCOOK_",
    title="App",
    rc_path=("app",),
)
class AppSettings(rc.Config):
    """Typed application settings loaded from AppRC-managed env layers."""

    message: str = rc.field(
        "LTCOOK_MESSAGE",
        default="Hello from ltcook",
        title="Example message",
        explanation_short="Small editable example setting.",
        explanation_long=(
            "This field exists so a new scaffold immediately demonstrates "
            "`ltcook config set app.message VALUE` and the Textual "
            "config editor. Replace it with real application settings."
        ),
    )
