"""Native runtime configuration grouped by its public environment prefixes."""

import apprc as rc

from ltcook.config.app import APP_RC


@APP_RC.config(
    "runtime", prefix="LTCOOK_", title="LTCook runtime", rc_path=("runtime",)
)
class RuntimeSettings(rc.Config):
    """LTCook-owned runtime declarations."""

    database: str = rc.field("LTCOOK_DATABASE", default="")
    state_dir: str = rc.field("LTCOOK_RUNTIME_STATE_DIR", default="")
    guidance_dir: str = rc.field("LTCOOK_GUIDANCE_DIR", default="")
    paseo_listen: str = rc.field("LTCOOK_PASEO_LISTEN", default="127.0.0.1:6767")
    paseo_password: str = rc.field("LTCOOK_PASEO_PASSWORD", default="", secret=True)
    js_root: str = rc.field("LTCOOK_JS_ROOT", default="")
    pi_auth_dir: str = rc.field("LTCOOK_PI_AUTH_DIR", default="~/.pi/agent")
    medium_model: str = rc.field(
        "LTCOOK_MODEL_MEDIUM", default="openai-codex/gpt-6.1-terra"
    )
    smart_model: str = rc.field(
        "LTCOOK_MODEL_SMART", default="openai-codex/gpt-6.2-sol"
    )
    smol_model: str = rc.field("LTCOOK_MODEL_SMOL", default="openai-codex/gpt-6-luna")
    expensive_model: str = rc.field(
        "LTCOOK_MODEL_EXPENSIVE", default="openai-codex/gpt-6-astra"
    )
    tiny_local_model: str = rc.field(
        "LTCOOK_MODEL_TINY_LOCAL", default="hf.co/XHToken/Spark-X2.6-4B-GGUF:Q8_0"
    )
    local_cpu_model: str = rc.field(
        "LTCOOK_MODEL_LOCAL_CPU", default="lfm3:1.7b-qad-q4_0"
    )
    local_evals_model: str = rc.field(
        "LTCOOK_MODEL_LOCAL_EVALS", default="bonsai-2:27b"
    )
    logs: str = rc.field("LTCOOK_LOGS", default="")
    traces: str = rc.field("LTCOOK_TRACES", default="")
    browser_enabled: bool = rc.field("LTCOOK_BROWSER_ENABLED", default=True)
    browser_home: str = rc.field("LTCOOK_BROWSER_HOME", default="")
    codesearch_enabled: bool = rc.field("LTCOOK_CODESEARCH_ENABLED", default=True)
    context7_enabled: bool = rc.field("LTCOOK_CONTEXT7_ENABLED", default=False)
    context7_url: str = rc.field(
        "LTCOOK_CONTEXT7_URL", default="https://mcp.context7.com/mcp"
    )
    ollama_endpoint: str = rc.field(
        "LTCOOK_OLLAMA_ENDPOINT", default="http://127.0.0.1:11434"
    )
    summarizer_keep_alive: int = rc.field("LTCOOK_SUMMARIZER_KEEP_ALIVE", default=-1)
    summarizer_generation: str = rc.field("LTCOOK_SUMMARIZER_GENERATION", default="")
    conversation_local_model: str = rc.field(
        "LTCOOK_CONVERSATION_LOCAL_MODEL", default=""
    )
    conversation_inference: str = rc.field(
        "LTCOOK_CONVERSATION_INFERENCE", default="hosted"
    )
    conversation_input_tokens: int = rc.field(
        "LTCOOK_CONVERSATION_INPUT_TOKENS", default=8000
    )
    session_memory_delegation: bool = rc.field(
        "LTCOOK_SESSION_MEMORY_DELEGATION", default=False
    )
    api_listen: str = rc.field("LTCOOK_API_LISTEN", default="127.0.0.1:48731")
    api_token: str = rc.field("LTCOOK_API_TOKEN", default="", secret=True)
    runtime_api_url: str = rc.field("LTCOOK_RUNTIME_API_URL", default="")
    runtime_user_token: str = rc.field(
        "LTCOOK_RUNTIME_USER_TOKEN", default="", secret=True
    )
    agent_api_token: str = rc.field("LTCOOK_AGENT_API_TOKEN", default="", secret=True)
    session_id: str = rc.field("LTCOOK_SESSION_ID", default="")
    team_id: str = rc.field("LTCOOK_TEAM_ID", default="")
    member_key: str = rc.field("LTCOOK_MEMBER_KEY", default="")
    native_agent_id: str = rc.field("LTCOOK_NATIVE_AGENT_ID", default="")
    readonly: bool = rc.field("LTCOOK_READONLY", default=False)
    shell_provenance: str = rc.field("LTCOOK_SHELL_PROVENANCE", default="", secret=True)


@APP_RC.config("paseo", prefix="PASEO_", title="Paseo", rc_path=("runtime", "paseo"))
class PaseoSettings(rc.Config):
    """Paseo's native home declaration."""

    home: str = rc.field("PASEO_HOME", default="")


@APP_RC.config("pi", prefix="PI_", title="Pi", rc_path=("runtime", "pi"))
class PiSettings(rc.Config):
    """Pi's native data and command declarations."""

    home: str = rc.field("PI_CODING_AGENT_DIR", default="")
    command: str = rc.field("PI_COMMAND", default="")


@APP_RC.config(
    "anthropic",
    prefix="ANTHROPIC_",
    title="Anthropic",
    rc_path=("runtime", "models", "anthropic"),
)
class AnthropicSettings(rc.Config):
    api_key: str = rc.field("ANTHROPIC_API_KEY", default="", secret=True)


@APP_RC.config(
    "openai", prefix="OPENAI_", title="OpenAI", rc_path=("runtime", "models", "openai")
)
class OpenAISettings(rc.Config):
    api_key: str = rc.field("OPENAI_API_KEY", default="", secret=True)


@APP_RC.config(
    "google",
    prefix="GEMINI_",
    title="Google Gemini",
    rc_path=("runtime", "models", "google"),
)
class GoogleSettings(rc.Config):
    api_key: str = rc.field("GEMINI_API_KEY", default="", secret=True)


@APP_RC.config(
    "openrouter",
    prefix="OPENROUTER_",
    title="OpenRouter",
    rc_path=("runtime", "models", "openrouter"),
)
class OpenRouterSettings(rc.Config):
    api_key: str = rc.field("OPENROUTER_API_KEY", default="", secret=True)


@APP_RC.config(
    "context7", prefix="CONTEXT7_", title="Context7", rc_path=("runtime", "context7")
)
class Context7Settings(rc.Config):
    api_key: str = rc.field("CONTEXT7_API_KEY", default="", secret=True)


@APP_RC.config(
    "agent_browser",
    prefix="AGENT_BROWSER_",
    title="Native browser",
    rc_path=("runtime", "browser"),
)
class AgentBrowserSettings(rc.Config):
    executable_path: str = rc.field("AGENT_BROWSER_EXECUTABLE_PATH", default="")
