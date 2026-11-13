"""AppRC declaration shared by ltcook settings and commands."""

from __future__ import annotations

import apprc as rc

APP_RC = rc.AppRC(
    app_id="ltcook",
    display_name="ltcook",
    paths=rc.Paths(config=True, appdata=True),
    config_package="ltcook.config",
    user_dotenv=rc.UserDotenv(),
    command_name="ltcook",
)
