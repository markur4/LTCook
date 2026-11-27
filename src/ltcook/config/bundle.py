"""The centrally declared settings used by launch and native adapters."""

from dataclasses import dataclass, field

from ltcook.config.app import APP_RC
from ltcook.config.sections.app import AppSettings
from ltcook.config.sections.runtime import (
    AgentBrowserSettings,
    AnthropicSettings,
    Context7Settings,
    GoogleSettings,
    OpenAISettings,
    OpenRouterSettings,
    PaseoSettings,
    PiSettings,
    RuntimeSettings,
)
from ltcook.config.sections.services import (
    BugHunterSettings,
    RenamerSettings,
    WorkspaceOrganizerSettings,
)
from ltcook.config.sections.web import (
    ContainerSettings,
    Crawl4AISettings,
    PlaywrightSettings,
    PodmanSettings,
    SearXNGSettings,
    WebSettings,
)


@APP_RC.bundle
@dataclass(kw_only=True)
class LtcookConfig:
    """Group declarations without introducing a second configuration store."""

    app: AppSettings = field(default_factory=AppSettings)
    runtime: RuntimeSettings = field(default_factory=RuntimeSettings)
    workspace_organizer: WorkspaceOrganizerSettings = field(
        default_factory=WorkspaceOrganizerSettings
    )
    renamer: RenamerSettings = field(default_factory=RenamerSettings)
    bughunter: BugHunterSettings = field(default_factory=BugHunterSettings)
    paseo: PaseoSettings = field(default_factory=PaseoSettings)
    pi: PiSettings = field(default_factory=PiSettings)
    anthropic: AnthropicSettings = field(default_factory=AnthropicSettings)
    openai: OpenAISettings = field(default_factory=OpenAISettings)
    google: GoogleSettings = field(default_factory=GoogleSettings)
    openrouter: OpenRouterSettings = field(default_factory=OpenRouterSettings)
    context7: Context7Settings = field(default_factory=Context7Settings)
    agent_browser: AgentBrowserSettings = field(default_factory=AgentBrowserSettings)
    web: WebSettings = field(default_factory=WebSettings)
    searxng: SearXNGSettings = field(default_factory=SearXNGSettings)
    crawl4ai: Crawl4AISettings = field(default_factory=Crawl4AISettings)
    podman: PodmanSettings = field(default_factory=PodmanSettings)
    container: ContainerSettings = field(default_factory=ContainerSettings)
    playwright: PlaywrightSettings = field(default_factory=PlaywrightSettings)
