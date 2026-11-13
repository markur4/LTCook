"""Config bundle passed to ltcook application code."""

from dataclasses import dataclass, field

from ltcook.config.app import APP_RC
from ltcook.config.sections.app import AppSettings


@APP_RC.bundle
@dataclass(kw_only=True)
class LtcookConfig:
    """Application settings grouped by config section.

    :param app: The starter application's settings.
    """

    app: AppSettings = field(default_factory=AppSettings)
