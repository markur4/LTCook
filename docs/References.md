# References

[Documentation](README.md) · [Explanations](Explanations.md) · [How-to user guides](How-To-User-Guides.md) · [Examples](EXAMPLES.md) · [Development](Development.md)

- [Project and commands](#project-and-commands)
  - [Project paths](#project-paths)
  - [Command reference](#command-reference)
  - [Installer reference](#installer-reference)
  - [Uninstaller reference](#uninstaller-reference)
  - [Installation placement](#installation-placement)
  - [Lifecycle and deployment assets](#lifecycle-and-deployment-assets)
- [Configuration and public interfaces](#configuration-and-public-interfaces)
  - [Environment variables](#environment-variables)
  - [Configuration files](#configuration-files)
  - [Team API](#team-api)
- [Development reference](#development-reference)
  - [Dependency and lock files](#dependency-and-lock-files)
  - [Task commands](#task-commands)

<br>

# Project and commands

## Project paths

| Path | Responsibility |
| --- | --- |
| [README.md](../README.md) | Project overview, installation entry points, and curated navigation. |
| [justfile](../justfile) | Root environment, checks, build, and runtime module tasks. |
| [runtime/justfile](../runtime/justfile) | Grouped TypeScript runtime development, check, test, and build tasks. |
| [pyproject.toml](../pyproject.toml) | Python package metadata, AppRC integration, and development tools. |
| [package.json](../package.json) | Bun workspaces, root scripts, and JavaScript development dependencies. |
| [src/ltcook/config/app.py](../src/ltcook/config/app.py) | The single AppRC application declaration. |
| [src/ltcook/config/sections](../src/ltcook/config/sections) | Registered settings declarations grouped by owning component and environment prefix. |
| [src/ltcook/config/pi_config.py](../src/ltcook/config/pi_config.py) | Writes only the private Pi `web-search.json` native configuration. |
| [src/ltcook/launch.py](../src/ltcook/launch.py) | Global server settings, optional project overrides, and native process launch commands. |
| [runtime/src/api/team.ts](../runtime/src/api/team.ts) | Version 1 public team and runtime API. |
| [runtime/src/services/controller.ts](../runtime/src/services/controller.ts) | Internal local Compose controller used by the service commands. |
| [teams](../teams) | Bundled team packages and Markdown resources. |
| [services](../services) | Pinned Compose services and their non-secret configuration. |
| [src/ltcook_distr/payload/app_lifecycle](../src/ltcook_distr/payload/app_lifecycle) | Authored installation, preparation, and maintenance behavior. |
| [src/ltcook_dev/packaging](../src/ltcook_dev/packaging) | Authoring, asset staging, and PyApp build helpers. |
| [src/ltcook_dev/runtime.py](../src/ltcook_dev/runtime.py) | Resolves workspace AppRC settings before starting Bun against checkout source. |
| [tests](../tests) | Python and TypeScript quick, integration, and system tests. |

## Command reference

Use `ltcook --help` for AppRC's mounted configuration commands. These implemented
commands provide launch operations and diagnostics:

| Command | Result |
| --- | --- |
| `ltcook --help` | Show application and mounted AppRC command help. |
| `ltcook version` | Print the installed package version. |
| `ltcook diagnose --json` | Report package, interpreter, and AppRC paths without writing files. |
| `ltcook config setup --yes` | Initialize declared configuration files; it does not install Node or prepare services. |
| `ltcook config show --json` | Show app settings, paths, and selected workspace. |
| `ltcook config paths --json` | Show declared AppRC paths. |
| `ltcook config doctor --json` | Diagnose configuration without writing. |
| `ltcook config edit` | Open the AppRC terminal configuration editor. |
| `ltcook workspace add NAME ROOT --yes` | Optionally register a project and initialize its AppRC settings marker. |
| `ltcook launch runtime [--workspace ROOT]` | Start the idle server/UI, or explicitly open a project Session when `ROOT` is supplied. |
| `ltcook auth login PROVIDER [--api-key \| --no-browser]` | Delegate interactive authentication to the installed Pi CLI and shared user credential home. |
| `ltcook auth logout PROVIDER` | Remove that provider's credential through Pi; affects other Pi instances using the same home. |
| `ltcook auth check [--provider PROVIDER] [--model MODEL] [--json] [--no-refresh]` | Report native Pi credential readiness without printing credentials; exit statuses are 0 ready, 1 not ready, and 2 invalid. |
| `ltcook launch write-native-config --workspace ROOT` | Write the private Pi `web-search.json` under `PI_CODING_AGENT_DIR`; the Paseo config is not written by this command. |
| `ltcook services start [--workspace ROOT]` | Start the LTCook Compose project in local mode. |
| `ltcook services stop [--workspace ROOT]` | Stop the SearXNG and Crawl4AI containers in local mode. |
| `ltcook services status [--workspace ROOT]` | Show local Compose status or the configured remote-service mode. |
| `ltcook services logs [--workspace ROOT]` | Show recent local service logs. |
| `ltcook launcher` | Open the optional AppRC management launcher. |
| `python -m ltcook.launch runtime [--workspace ROOT]` | Internal module entry point for the same global or project launch. |
| `python -m ltcook.launch environment --workspace ROOT` | Emit raw workspace-specific child environment JSON; may contain secrets. |
| `python -m ltcook.launch write-native-config --workspace ROOT` | Internal entry point for the private Pi-only `web-search.json` writer. |

`--workspace` accepts an existing project directory without registration or an
AppRC marker. An existing marker enables normal project settings and secret
layers. Otherwise, launch uses global user settings and does not create project
configuration files or registry entries. Global startup and auth commands ignore
the registry's selected-workspace fallback.

The launch command requires a prepared deployment and an AppRC runtime token.
Without a project it starts or reuses the idle host without creating agents.
An explicit project opens a Session through the current runtime when available,
otherwise starts the runtime and opens that project. Startup automatically starts
the Compose project in `local` mode.
The service commands also use the internal
[`ServiceController`](../runtime/src/services/controller.ts). In `direct` and
`paseo-tunnel` modes, operate remote services on their host; local commands do
not control them or verify their health. Successful startup is not a health
check for the services or proof that live research works.

## Installer reference

The PyApp launcher executes a generated standalone AppRC installer; AppRC's
`uv tool` backend owns the installed Python application. The current manual
release workflow builds Linux installer assets, but no LTCook release is
published. For checkout installation, follow the
[installation guide](How-To-User-Guides.md#install-from-a-checkout). Do not treat
an installer asset build as a completed installation or a release.

The portable PyApp bundle contains three adjacent assets: `ltcook-install`
(`ltcook-install.exe` on native Windows), `main-installer.pyz`, and the canonical
LTCook wheel matching the project version. Keep all three together and preserve
the exact `.pyz` filename. The installer validates and selects the wheel for a
noneditable AppRC install; it needs no checkout or source download.

`--root` sets only the single-root resource destination. `--directory` names the
saved installation directory for `--repair`; neither option selects source. The
native shell bootstrap remains a separate checkout-based route.

## Uninstaller reference

AppRC lifecycle management owns installation records and supported removal.
LTCook's application-specific maintenance actions are limited to its deployment,
cache, logs, and coordination state. Removing the program does not authorize
purging unrelated Podman data, an external workspace, or an existing `lcook`
installation. Inspect the installed AppRC help and removal preview before
choosing resources to purge; malformed ownership records should preserve data
for recovery rather than broaden cleanup.

## Installation placement

AppRC declares config, appdata, cache, and state as independent paths. The
installation authority is a separate fixed native location. The deployment is
normally under AppRC appdata; it contains the private Node executable, production
application bundle, per-workspace Pi locations, service receipt, and SQLite
coordination database. Use `ltcook config paths --json` and `ltcook installation
show` to inspect the resolved locations. The installer may capture native paths
or an explicit single-root layout; reinstallation should reuse recorded placement.

## Lifecycle and deployment assets

The authored lifecycle composition lives under
[`src/ltcook_distr/payload/app_lifecycle`](../src/ltcook_distr/payload/app_lifecycle).
The generated standalone AppRC support is under
[`src/ltcook_distr/artifacts`](../src/ltcook_distr/artifacts); those files are not
a second authored lifecycle implementation. The `BuildPy` hook in
[`package_assets.py`](../src/ltcook_dev/packaging/package_assets.py) copies only
a validated, explicitly staged production bundle into the built wheel.

The staged `src/ltcook_distr/bundle` contains the compiled runtime, shared-auth
Pi SDK/RPC launcher, Pi extension, Paseo panel plugin, built team packages and
Markdown resources, Compose assets,
root production manifests/lock, and selected Node version. It excludes development
`node_modules`, tests, and Python development tools. The bundle is required wheel
content, not a disposable build output. `src/ltcook_distr/artifacts/_support` is
generated installer support, not runtime app payload.

`just build` stages the Python distribution artifacts from existing build output;
it does not generate lifecycle artifacts. `just make-artifacts` explicitly
generates those outputs. `just check-artifacts` validates generated lifecycle
files without rewriting them. Installer preparation provisions a private Node
runtime and application deployment; it does not install global npm dependencies
or make PyApp a second Python environment owner.

The current manual release workflow is Linux-only and builds a wheel, source
archive, PyApp launcher, and generated installer asset. It does not publish a
release, create a tag, or publish to PyPI. `RELEASE_PYPI := "false"` in the root
`justfile`; no LTCook release is available.

<br>

# Configuration and public interfaces

## Environment variables

AppRC resolves each exact declared environment name. The settings bundle exposes
`app`, `runtime`, `paseo`, `pi`, `anthropic`, `openai`, `google`, `openrouter`,
`context7`, `agent_browser`, `web`, `searxng`, `crawl4ai`, `podman`, `container`,
and `playwright` sections; their declarations are in
[`src/ltcook/config/sections`](../src/ltcook/config/sections).

| Name | Meaning |
| --- | --- |
| `LTCOOK_TEAM` | `AppSettings.team`; defaults to `default-minimal`. |
| `LTCOOK_SESSION` | Optional explicit Session identifier used to resume a project chat; opening a project without it creates a fresh Session. Global startup creates none. |
| `LTCOOK_TEAM_INSTANCE_ID` | Runtime-derived identifier for the persistent TeamInstance shared by Sessions on the same selected team and canonical workspace. |
| `LTCOOK_JS_ROOT` | JavaScript runtime root; source development uses the checkout root, and installed launches use `<deployment>/app`. |
| `LTCOOK_WORKSPACE` | Project path supplied for an explicit project launch; absent for idle server startup. |
| `LTCOOK_DEPLOYMENT_DIR` | LTCook-owned deployment location, normally beneath AppRC appdata. |
| `LTCOOK_MODEL_SMART` | Provider model selected by the `smart` team alias. |
| `LTCOOK_MODEL_SMOL` | Provider model selected by the `smol` alias; falls back to smart when empty. |
| `LTCOOK_MODEL_PLAN` | Provider model selected by the `plan` alias; falls back to smart when empty. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` | Optional provider credentials declared as secrets. Configure only the provider in use. |
| `LTCOOK_API_TOKEN` | Runtime API credential, created in AppRC secret storage during explicit setup. |
| `LTCOOK_PASEO_PASSWORD` | Optional secret for Paseo API and WebSocket authentication; it does not protect the static web UI. Never include it in a URL. |
| `LTCOOK_PASEO_LISTEN` | Paseo listener address; defaults to `127.0.0.1:6767`. The runtime prints the actual listener at startup. |
| `PASEO_HOME` | Mutable Paseo data home; defaults to `<LTCOOK_DEPLOYMENT_DIR>/paseo` and must stay inside deployment but outside `<LTCOOK_DEPLOYMENT_DIR>/app`. |
| `PI_CODING_AGENT_DIR` | Workspace-specific Pi home; defaults to `<LTCOOK_DEPLOYMENT_DIR>/workspaces/<workspace-id>/pi` and must remain within the deployment. |
| `LTCOOK_PI_AUTH_DIR` | Global `runtime.pi_auth_dir`; defaults to native Pi's `~/.pi/agent`. All project SDK runtimes share its `auth.json`; project overrides do not change this auth location. |
| `LTCOOK_SEARXNG_URL` | SearXNG endpoint; its declared default is `http://127.0.0.1:8888`. |
| `LTCOOK_CRAWL4AI_URL` | Crawl4AI endpoint; defaults to `http://127.0.0.1:11235`. |
| `CRAWL4AI_API_TOKEN`, `SEARXNG_SECRET` | Credentials passed to the Compose services and marked secret. |
| `LTCOOK_SERVICE_CONNECTION` | Service mode: `local`, `direct`, or `paseo-tunnel`. |
| `PODMAN_COMPOSE_PROVIDER` | Optional explicit Compose provider executable. |
| `LTCOOK_SSRF_ALLOW_RANGES` | Narrow comma-separated private ranges allowed for configured service access. |
| `LTCOOK_BROWSER_ENABLED` | Enable Pi browser extension integration; defaults to true. |
| `LTCOOK_CODESEARCH_ENABLED` | Enable hosted public-code search; defaults to true. |
| `LTCOOK_CONTEXT7_ENABLED` | Enable optional hosted Context7 MCP integration; defaults to false. |

The runtime's ready line prints `Paseo <listen>`. Open `http://<listen>/` in a
browser to use Paseo's bundled web UI; no separate server, assets, or dependency
are needed. Select a directory and use **Start session** in the LTCook panel to
activate its team. Merely starting the UI or selecting a directory does not
create agents.

AppRC setting paths for these secrets are `runtime.api_token`,
`web.crawl4ai.api_token`, and `web.searxng.secret`; the typed bundle fields are
`config.runtime.api_token`, `config.crawl4ai.api_token`, and
`config.searxng.secret`. Setting-update plans use the declared environment names
`LTCOOK_API_TOKEN`, `CRAWL4AI_API_TOKEN`, and `SEARXNG_SECRET`, not the dotted paths.

Other declarations across these sections configure Pi/Paseo paths and ports,
diagnostics, browser paths, API listeners, and service configuration. See the
source declarations for the complete exact names. Never print the raw
launch environment: it can contain credentials. Secret redaction is presentation,
not encryption of the AppRC-managed files.

## Configuration files

| File or path | Meaning |
| --- | --- |
| [`src/ltcook/config/apprc.defaults.env`](../src/ltcook/config/apprc.defaults.env) | Packaged AppRC defaults. |
| AppRC user env and secret files | Saved user settings and credentials beneath declared AppRC paths. |
| Initialized AppRC workspace settings and secrets | Optional project overrides; named registration is not required for a project path. |
| Arbitrary workspace `.env` files | Not owned or loaded by LTCook automatically. |
| `<appdata>/deployment` | Private Node, production application, service receipts, and coordination database. |
| `<LTCOOK_DEPLOYMENT_DIR>/paseo/config.json` | Paseo configuration written by the Node host; the home also holds mutable Paseo data. |
| `<LTCOOK_DEPLOYMENT_DIR>/workspaces/<workspace-id>/pi` | Workspace-specific Pi home; `write-native-config` writes its private `web-search.json`. |
| `<PI_CODING_AGENT_DIR>/settings.json.ltcook-extensions.json` | Versioned exact ownership of LTCook-managed extension paths; independent extensions remain in `settings.json`. |
| `<LTCOOK_PI_AUTH_DIR>/auth.json` | Shared Pi-managed API keys/OAuth credentials; native login/logout and all LTCook project SDK runtimes use this file without copying it. |

`resolve_launch()` uses AppRC `current_env_mapping()` for each section and
preserves original shell provenance. Global startup explicitly excludes workspace
selection; project settings are optional. The auth directory is always resolved
from global settings. Shell exports retain normal precedence; one project's
merged environment is not used as the next project's shell input. See the
[configuration explanation](Explanations.md#configuration-files) and
[Pi authentication guide](How-To-User-Guides.md#authenticate-with-pi).

## Team API

A team module exposes this `TeamPackage` shape from
[`runtime/src/api/team.ts`](../runtime/src/api/team.ts):

| Member | Type | Purpose |
| --- | --- | --- |
| `apiVersion` | `1` | Fresh public API version; no old-version adapters are provided. |
| `definition` | `TeamDefinition` | Team identity, members, resources, and review policy. |
| `activateService(runtime)` | function | Activates the selected team through scoped coordination and agent operations; policy comes from `definition`. |
| `activateAgent(runtime)` | function | Registers instructions for the selected member. |

The runtime recognizes built-in module aliases `default` and `default-minimal`;
other selections are dynamically imported module specifiers that must be installed
and resolvable. Team packages access coordination through the scoped public API,
not SQL or runtime internals. The full team uses independent review; minimal uses
a self-review policy and must not be described as independent specialist review.
The runtime uses one TypeBox command schema in
[`runtime/src/api/commands.ts`](../runtime/src/api/commands.ts) for both HTTP
validation and Pi tool parameters; command types are inferred from that schema.
API version remains `1`, with a clean cutover rather than compatibility adapters.
Teams can create explicit Passes with an optional Plan reference, create Tasks
with or without a Pass, and record ordered Steps within Tasks. Pass completion
requires completed Tasks and, when policy requires it, an accepted whole-Pass
review for the current revision. Task reviews are not the review gate.

The API command union uses a `type` discriminator. Each item below is a separate
`RuntimeCommand`; HTTP sends that command inside `{"command": ...}`:

- Create an explicit Pass with a Plan reference:
  `{"type":"pass.create","title":"Runtime integration","planRef":"docs/plan.md"}`
- Create a standalone Task by omitting `passId`:
  `{"type":"task.create","title":"Update docs","description":"Clarify runtime behavior","acceptance":"Examples match the current API"}`
- Add an ordered Step to an existing Task:
  `{"type":"step.create","taskId":"task-1","title":"Update the guide","position":1}`
- Review the whole Pass, not a Task:
  `{"type":"review.create","passId":"pass-1","outcome":"accepted","summary":"Current Pass revision reviewed"}`

HTTP validates commands with `RuntimeCommandSchema` through `isRuntimeCommand`;
Pi tool parameters use the `RuntimeCommandInputSchema` wrapper. Both derive from
the same schema rather than separate hand-maintained command representations.
A Task may also set `passId`, `phase`, and the native-message reference
`requestId`.

Whole-Pass review approval is tied to the current Pass revision. Task, Step, and
report changes increment that revision, so an older accepted review does not
authorize the changed work. A completed Pass is final; start a new Pass for later
work rather than reopening or mutating the completed Pass.

## Dependency and lock files

| File | Role |
| --- | --- |
| [`package-lock.json`](../package-lock.json) | Node/npm production lock used by private deployment preparation. |
| [`bun.lock`](../bun.lock) | Generated Bun lock used with `bun install --frozen-lockfile` for development. |
| [`uv.lock`](../uv.lock) | Python and authoring dependency lock. |
| [`pylock.toml`](../pylock.toml) | Portable Python lock export generated by `just lock`; `uv.lock` remains authoritative for uv. |
| [`pyproject.toml`](../pyproject.toml) | Python runtime requirements and local `dev` dependency group. |
| [`.node-version`](../.node-version) | Exact Node version selected for deployment and development. |

The application runtime declares AppRC core and terminal packages at version 0.33.0.
Do not add old Git pins, source overrides, migration layers, or a second Python
environment owner.

<br>

# Development reference

## Task commands

From the repository root, `just runtime <task>` invokes the grouped recipes in
[`runtime/justfile`](../runtime/justfile). The development and watch recipes use
`ltcook_dev.runtime` to resolve AppRC for the workspace before they start Bun on
the checkout's TypeScript entrypoint. They do not launch the packaged runtime.

| Command | Purpose |
| --- | --- |
| `just runtime sync` | Install the frozen Bun workspace dependencies. |
| `just runtime dev -- --help` | Display runtime help after resolving AppRC for the checkout workspace. |
| `just runtime watch -- --help` | Display runtime help with Bun watch enabled and AppRC resolved. |
| `just runtime check` | Type-check the runtime workspace. |
| `just runtime test` | Run runtime unit/native/integration and team contract tests. |
| `just runtime test-integration` | Run runtime integration tests. |
| `just runtime build` | Compile the runtime, Pi SDK/RPC launcher, Pi extension, and Paseo plugin. |
| `just check` | Enforce Prettier/Ruff formatting, TypeScript types, Python lint, and Pyright. |
| `just test` | Run Bun unit/native/integration and team contract tests, plus Python tests excluding `integration` and `system`. |
| `just test-integration` | Run marked Python and TypeScript integration tests. |
| `just test-system` | Run marked Python system tests. |
| `just build` | Build/stage runtime, team, and service production assets and the Python wheel/source distribution. |
| `just sync`, `just install` | Prepare the checkout-local uv environment, install frozen locks, build, stage assets, and install the Python application. |
| `just make-artifacts` | Generate AppRC lifecycle support files. |
| `just check-artifacts` | Check generated lifecycle files without rewriting. |
| `just format`, `just format-check` | Format authored TypeScript/Python or check the existing formatting. |
| `just run -- COMMAND ...` | Run a command with preserved arguments in the locked uv environment. |

Additional restored scaffold environment, worktree, lock, and asset-only release
recipes are described in [Development](Development.md#maintainer-environment).

Bun is selected by the root/runtime `BUN` variable; set `BUN=/absolute/path/to/bun`
if the executable is not available by its default name. Development uses `bun.lock`;
production Node installation uses `package-lock.json`; Python dependencies use `uv.lock`.

Avoid running the separate marked Python integration and system groups as
routine checks: they may require scenario-specific native prerequisites,
network access, or an installer smoke source. The runtime integration contracts
included in `just runtime test` and `just test` use fake agents and in-memory
coordination; they do not start services or call models.

The quick Python lifecycle contract tests exercise preparation boundaries with
isolated fakes and fixtures. They do not install Podman or Node. Running a live
installer, Compose service, browser, or model-backed workflow is a separate
integration/system activity, with explicit external prerequisites; no normal
check runs a long model conversation.
