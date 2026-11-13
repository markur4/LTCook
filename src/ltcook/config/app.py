"""The single AppRC declaration for LTCook-owned configuration and paths."""

import apprc as rc

APP_RC = rc.AppRC(
    app_id="ltcook",
    display_name="LTCook",
    command_name="ltcook",
    config_package="ltcook.config",
    user_dotenv=rc.UserDotenv(),
    workspaces=rc.Workspaces(),
    paths=rc.Paths(config=True, appdata=True, cache=True, state=True),
)
