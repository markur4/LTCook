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
  - [Guidance API](#guidance-api)
  - [Workflow API](#workflow-api)
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
| [runtime/src/team-api](../runtime/src/team-api) | Team API v3 definitions and routing. |
| [runtime/src/guidance-api](../runtime/src/guidance-api) | Guidance discovery, selection and inspection contract. |
| [runtime/src/workflow-api](../runtime/src/workflow-api) | Planning, decisions, approvals and coordination contract. |
| [runtime/resources](../runtime/resources) | Required Core rules and shared native skills/references. |
| [runtime/src/services/controller.ts](../runtime/src/services/controller.ts) | Internal local Compose controller used by the service commands. |
| [teams](../teams) | Bundled team packages and Markdown resources. |
| [services](../services) | Pinned Compose services and their non-secret configuration. |
| [src/ltcook_distr/payload/app_lifecycle](../src/ltcook_distr/payload/app_lifecycle) | Authored installation, preparation, and maintenance behavior. |
| [src/ltcook_dev/packaging](../src/ltcook_dev/packaging) | Asset archive, package and native-release staging helpers. |
| [src/ltcook_dev/runtime.py](../src/ltcook_dev/runtime.py) | Resolves workspace AppRC settings before starting Bun against checkout source. |
| [tests](../tests) | Python and TypeScript quick, integration, and system tests. |

## Command reference

Use `ltcook --help` for AppRC's mounted configuration commands. These implemented
commands provide launch operations and diagnostics:

| Command | Result |
| --- | --- |
| `ltcook`, `ltcook serve` | Start/reuse the local runtime, open Paseo in the host default browser, and follow backend logs; Ctrl+C detaches. |
| `ltcook stop` | Gracefully stop the matching local runtime; does not stop Compose containers or close browser tabs. |
| `ltcook --help` | Show application and mounted AppRC command help. |
| `ltcook --version`, `ltcook -V` | Print the installed package version before runtime preparation. |
| `ltcook app doctor --verbose --json` | Include package/interpreter metadata, paths, configuration and resource diagnostics. |
| `ltcook config setup --yes` | Initialize declared configuration files; it does not install Node or prepare services. |
| `ltcook config show --json` | Show app settings, paths, and selected workspace. |
| `ltcook app paths` | Show recorded AppRC resource paths. |
| `ltcook app doctor --json` | Diagnose installation/configuration without writing. |
| `ltcook config edit` | Open the AppRC terminal configuration editor. |
| `ltcook workspace add NAME ROOT --yes` | Optionally register a project and initialize its AppRC settings marker. |
| `ltcook launch runtime [--workspace ROOT]` | Browser-free foreground server, or explicit project activation; reuse does not take over the owner. |
| `ltcook auth login PROVIDER [--api-key \| --no-browser]` | Delegate interactive authentication to the installed Pi CLI and shared user credential home. |
| `ltcook auth logout PROVIDER` | Remove that provider's credential through Pi; affects other Pi instances using the same home. |
| `ltcook auth check [--provider PROVIDER] [--model MODEL] [--json] [--no-refresh]` | Report native Pi credential readiness without printing credentials; exit statuses are 0 ready, 1 not ready, and 2 invalid. |
| `ltcook launch write-native-config --workspace ROOT` | Write the private Pi `web-search.json` under `PI_CODING_AGENT_DIR`; the Paseo config is not written by this command. |
| `ltcook planning start --session SESSION --design PATH --title TITLE` | Request Plan prefill/finalization for a Design. |
| `ltcook planning show --session SESSION --plan PLAN_ID [--json]` | Read current Plan Markdown and workflow state, or raw state with `--json`. |
| `ltcook planning questions --session SESSION --plan PLAN_ID` | Inspect registered user decisions. |
| `ltcook planning answer --session SESSION --plan PLAN_ID --decision ID --answer TEXT` | Persist an explicit authenticated user answer. |
| `ltcook planning approve --session SESSION --plan PLAN_ID` | Approve after coverage and decision gates pass. |
| `ltcook planning reject --session SESSION --plan PLAN_ID` | Reject execution. |
| `ltcook guidance inspect --session SESSION [--agent ID]` | Inspect actual native loading and guidance diagnostics. |
| `ltcook services start [--workspace ROOT]` | Start the LTCook Compose project in local mode. |
| `ltcook services stop [--workspace ROOT]` | Stop the SearXNG and Crawl4AI containers in local mode. |
| `ltcook services status [--workspace ROOT]` | Show local Compose status or the configured remote-service mode. |
| `ltcook services logs [--workspace ROOT]` | Show recent local service logs. |
| `ltcook app doctor --json`, `ltcook app paths` | Inspect installation health and recorded resource placement. |
| `ltcook eval audit [--static-only] [--setup current|synthetic]` | Run Instruction Audit; static-only needs no Ollama. |
| `ltcook eval run [--quick\|--all] [--setup current\|synthetic] [--case read-only\|no-op\|targeted-fix] [--repetitions N]` | Run full-instruction Behavior Evaluation once by default; `--all` includes Instruction Audit and timings use the same executions. |
| `ltcook eval analyze [--setup current\|synthetic] [--case read-only\|no-op\|targeted-fix] [--repetitions N]` | Report Bottleneck Attribution from one set of full-instruction case executions by default. |
| `ltcook eval report RUN_ID` | Show a persisted evaluation report. |
| `ltcook eval list`, `watch`, `status`, `cancel`, `delete` | Manage shared Agent Evals runs and history. |
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
otherwise starts the runtime and opens that project. Opening a project starts the Compose project in `local` mode; idle startup
does not start containers.
The service commands also use the internal
[`ServiceController`](../runtime/src/services/controller.ts). In `direct` and
`paseo-tunnel` modes, operate remote services on their host; local commands do
not control them or verify their health. Successful startup is not a health
check for the services or proof that live research works.

The local runtime control boundary uses master-bearer authentication.
`GET /v1/status` reports readiness and the running instance's UUID, team,
deployment/database paths, actual Paseo listener, and log paths.
`POST /v1/runtime/stop` accepts `{"instanceId":"<observed UUID>"}`; a stale UUID
is rejected rather than stopping a replacement. Agent-scoped credentials cannot
stop the runtime. These endpoints do not provide network-wide discovery.

## Installer reference

The Linux `ltcook-setup-linux-x86_64` contains an SDK manager, committed project
snapshot and exact lock. Install with `--yes --skip-setup`; updates use a newer
setup. AppRC owns managed runtime slots, not a `uv tool` environment.
No adjacent wheel, generated Python installer or shell wrapper is required.
The manual workflow builds assets only; no release has been published.

For editable registration, synchronize the checkout and run
`uv run --locked ltcook app install -e --yes --skip-setup`. Its `.venv` remains
developer-owned. `--command-directory` selects an existing directory already on
PATH without modifying shell profiles or overwriting unrelated commands.
`--desktop` requests a shortcut with the LTCook icon on Linux or Windows.
`--skip-setup` does not skip initialization. For checkout updates, run
`just sync` before repeating registration so the deployment bundle is rebuilt.
See the [installation guide](How-To-User-Guides.md#install-from-a-checkout).

## Uninstaller reference

AppRC lifecycle management owns installation records and supported removal.
`app uninstall --yes` removes the program and managed configuration, appdata,
cache, and state. `--keep-config` retains only the configuration directory,
including settings and secrets. `--remove-repository` selects the editable
checkout for removal. AppRC rejects that option if the checkout contains
configuration selected for retention.
Hooks are declared once in `[tool.apprc.distribution.hooks]`: initialization
prepares prerequisites; cleanup stops the recorded LTCook Compose project before
AppRC removes directories, including their contents and symbolic links without
following link targets. No application file inventory is required.
LTCook's application-specific maintenance actions are limited to its deployment,
cache, logs, and coordination state. Removing the program does not authorize
purging unrelated Podman data, an external workspace, or an existing `lcook`
installation. Inspect the installed AppRC help and removal preview before
confirming removal; malformed ownership records should preserve data
for recovery rather than broaden cleanup.

## Installation placement

AppRC declares config, appdata, cache, and state as independent paths. The
installation authority is a separate fixed native location. The deployment is
normally under AppRC appdata; it contains the private Node executable, production
application bundle, per-workspace Pi locations and service receipt. Runtime
documents and SQLite coordination default to `<state>/runtime`; project facts
are cached under `<cache>/projects`. Use `ltcook app paths` and `ltcook app doctor --json` to
inspect recorded locations. Explicit resource relocation uses `app migrate`,
not a manual move or an edit to installation authority.

## Lifecycle and deployment assets

The initializer and maintenance actions live under
[`src/ltcook_distr/payload/app_lifecycle`](../src/ltcook_distr/payload/app_lifecycle).
AppRC initializes resources before invoking `actions:initialize` with pending
operation context. That hook provisions runtime/services without config edits.
Missing service secrets are saved only at explicit post-Ready starts.

[`package_assets.py`](../src/ltcook_dev/packaging/package_assets.py) creates and
validates the single canonical `src/ltcook_distr/bundle.zip`. It contains compiled
runtime/team code, Pi/Paseo plugin resources, services, manifests, production
lock and Node selection, excluding development dependencies. `BuildPy` copies
the validated archive; initialization safely extracts it while preparing Node.
An archive is necessary because SDK snapshot cleanup strips generated `dist`
directories, even inside staged package directories.

`just sync` and `just build` prepare the archive. `just build-native` exports a
committed tree, builds assets inside that private tree and invokes AppRC's native
builder with the locked application graph. Authoring needs uv >=0.11.6, Rust and
LLVM; editable registration does not.

The Linux workflow emits wheel, sdist, `ltcook-setup-linux-x86_64` and
`SHA256SUMS`. Release staging verifies the embedded binding's app/distribution,
version, command and source commit plus exact native checksums before creating
the schema-2 release manifest. Legacy schema-1 script/zipapp manifests are not
accepted. The workflow creates no tag, GitHub Release or PyPI publication;
`RELEASE_PYPI := "false"` remains the hard publication gate.

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
| `LTCOOK_RUNTIME_STATE_DIR` | Global `runtime.state_dir`; defaults to `<AppRC state>/runtime`, containing documents and the default database. |
| `LTCOOK_DATABASE` | Global `runtime.database`; defaults to `<LTCOOK_RUNTIME_STATE_DIR>/coordination.sqlite`. Incompatible schemas are rejected unchanged. |
| `LTCOOK_GUIDANCE_DIR` | Global `runtime.guidance_dir`; defaults to `<AppRC config>/guidance` with `rules/` and `skills/`. |
| `LTCOOK_RIED_CACHE_DIR` | Launch-derived `<AppRC cache>/projects`, holding the single versioned RIED cache. |
| `LTCOOK_BRIEF_EXECUTABLE` | Launch-derived pinned `brief` executable in the LTCook deployment; development may select a matching PATH binary. |
| `LTCOOK_TEAM` | `AppSettings.team`; CLI Session creation default, `default-minimal`. GUI Sessions choose their Team independently. |
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
are needed. Use **+ → LTCook → Team** and submit a message to open the
Leader chat. Merely starting the UI or selecting a directory does not create agents.

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
| `<appdata>/deployment` | Private Node, production application and service receipts. |
| `<state>/runtime/documents/designs/Design-YYYY_MM_DD-HH_MM-title.md` | Team-authored Design, using creation-machine local time and timezone metadata. |
| `<state>/runtime/documents/plans/Plan-YYYY_MM_DD-HH_MM-title.md` | Team-authored Plan; stable filename and append-only reporting convention. |
| `<state>/runtime/coordination.sqlite` | Runtime coordination, document references, decisions and approval metadata. |
| `<cache>/projects` | Lazily refreshed declarative facts; Git state is refreshed separately. |
| `<LTCOOK_DEPLOYMENT_DIR>/paseo/config.json` | Paseo configuration written by the Node host; the home also holds mutable Paseo data. |
| `<LTCOOK_DEPLOYMENT_DIR>/workspaces/<workspace-id>/pi` | Workspace-specific Pi home; `write-native-config` writes its private `web-search.json`. |
| `<PI_CODING_AGENT_DIR>/settings.json.ltcook-extensions.json` | Versioned exact ownership of LTCook-managed extension paths; independent extensions remain in `settings.json`. |
| `<LTCOOK_PI_AUTH_DIR>/auth.json` | Shared Pi-managed API keys/OAuth credentials; native login/logout and all LTCook project SDK runtimes use this file without copying it. |
| `<LTCOOK_DEPLOYMENT_DIR>/logs/backend.log` | Private append-only captured runtime stdout/stderr, followed alongside telemetry and Paseo daemon output by bare `ltcook`. |

`resolve_launch()` uses AppRC `current_env_mapping()` for each section and
preserves original shell provenance. Global startup explicitly excludes workspace
selection; project settings are optional. The auth directory is always resolved
from global settings. Shell exports retain normal precedence; one project's
merged environment is not used as the next project's shell input. See the
[configuration explanation](Explanations.md#configuration-files) and
[Pi authentication guide](How-To-User-Guides.md#authenticate-with-pi).

## Team API

The public import is `@ltcook/runtime/team-api`, authored in
[`runtime/src/team-api/index.ts`](../runtime/src/team-api/index.ts).

| Member | Type | Purpose |
| --- | --- | --- |
| `apiVersion` | `3` | Current clean prototype contract; old APIs are rejected. |
| `definition` | `TeamDefinition` | Identity, members, separate rule/skill refs, routing and review policy. |
| `selectAssignee(context, eligible)` | optional function | Returns an eligible member key; Core validates and persists before dispatch. |

Members declare keys, names, roles, eligible `workTypes`, model alias, thinking,
lifetime, read-only policy, `rules` and `skills`. Resources have path, URL and
rule/skill kind. Teams have one default route per work type:

| Work type | `default-minimal` | `default` |
| --- | --- | --- |
| `design` | Leader | Leader |
| `plan.prefill` | Adjutant | Adjutant |
| `plan.finalize` | Leader | Leader |
| `task.execute` | Leader | Senior |

Leader can schedule among eligible execution members. The optional hook receives
read-only work context and eligible members, without a privileged runtime handle
or user approval authority. There are no `activateService`/`activateAgent` hooks.
`TeamDefinition.leaderKey` names the canonical `leader` member. The built-in
selections are `default` and `default-minimal`; other Teams must be managed local
`teams/` workspaces with locked dependencies and valid API v3 exports. See the
[selection-hook example](EXAMPLES.md#select-an-assignee-through-team-api).

Independent-review eligibility, dispatch and current Pass-revision checks remain
the full Team's policy. Minimal permits self-review. Task, Step and report changes
advance the Pass revision and require a current accepted review when required;
Plan execution approval is a separate gate. A completed Pass remains final.

## Guidance API

`@ltcook/runtime/guidance-api`, authored in
[`runtime/src/guidance-api`](../runtime/src/guidance-api), describes Rule/Skill
resources and inspection. Sources use Core, Team, Project and User scopes. Rules
enter applicable standing context; skills use Pi's native parser and discovery.
Descriptions are advertised; bodies and references remain on demand. Bundled
functional skill names use the `ltcook-` prefix. Personal skill names and invocation settings come from User guidance.

`ltcook guidance inspect` reports each resource's name, path, scope, kind,
applicability, native loaded state and explicit-only setting, plus source-specific
diagnostics. Repeated discovery of one physical file is deduplicated; distinct
resources with conflicting names fail. Missing required guidance blocks activation.
Native project trust remains authoritative. Global User guidance is resolved from
AppRC before native HOME changes. Required Core rules and guards cannot be
removed by optional resource settings. Imported text and notices retain recorded
provenance under `runtime/resources`.

## Workflow API

`@ltcook/runtime/workflow-api`, authored in
[`runtime/src/workflow-api`](../runtime/src/workflow-api), contains planning,
document references, decisions, approvals and work results.
[`commands.ts`](../runtime/src/workflow-api/commands.ts) is the single authoritative
TypeBox schema; public command types and agent-facing input schemas derive from it.
The `ltcook_team` native tool uses that schema and Core enforces actor permissions.

Scheduled Pass `task.create` requests use stable `requestId` values and may
register `assigneeKey`, `dependencyIds`, `verificationRequirements`,
`approvalScopes` (`{action, resourceId, revision}`), and `correctionOfTaskId`.
`task.update` may change dependencies only while pending and unassigned.
`task.retry` supplies `taskId`, stable `requestId`, and a completed linked
`correctionTaskId` when required. A scheduled `report.create` declares
`outcome` (`success` or `failure`) and `verification` entries with `requirement`,
`result` (`passed` or `failed`), and nonempty `evidence`. Required successful
entries and exact user approvals gate completion. Pass review responses identify
the current review assignment and revision. `review.create` also accepts the
same named `verification` entries when its review Task declares requirements;
acceptance requires passing evidence and every exact approval scope on that Task.
Consult the authoritative schema
for required and optional fields; standalone and planning work retains manual
assignment/status behavior.

`/v1/snapshot` exposes saved Tasks, assignment attempts, gates, and blockers.
Dependency waits, unmet verification/approvals, unavailable members, and uncertain
sends remain visible through the existing Paseo views. Duplicate events are
idempotent only when identical. An interrupted send becomes uncertain and is
never replayed automatically.

RIED is a separate runtime service. `POST /v1/ried` accepts an authenticated
Session and `operation` of `summary`, `section` or `refresh`; `section` requires
`repository`, `git`, `host` or `recipes`. The `ltcook_ried` native tool exposes
these operations to bound agents, including read-only members. Standalone Pi
chats in LTCook also expose the tool when AppRC inventory paths are resolved;
they use the same discovery service and AppRC cache directly, with the native
Pi runtime workspace as the scan root and no Team Session or bearer. New, resumed
and forked Pi sessions rebind that workspace. The managed runtime derives its
scan root from the Session. Its schema-version-1 result reports
provenance, capture time, partial or stale status and diagnostics. Neither
Team API v3 nor coordination snapshots carry the full inventory.

The local authenticated command endpoint accepts
`POST /v1/command` with `{"sessionId":"SESSION","command":{"type":"..."}}`
and returns `{"value":...}`. Planning CLI operations use the user bearer; native
agents receive only their bound Session/agent credential. Agent-reported answers
cannot authorize execution.

Planning operations are `planning.start`, `planning.show`, `planning.questions`,
`planning.submit`, `decision.create`, `decision.answer`, `planning.approve` and
`planning.reject`. Answers and approvals require explicit Session and Plan
identity. Native user dialogs are correlated through the trusted host bridge;
cancellation, missing events and timeouts remain pending. Duplicate matching
responses are idempotent. The CLI provides recovery after interrupted delivery.

Plans register six coverage topics: intent, design, scope, implementation,
verification and delivery. Dispositions are `Resolved`, `Defaulted`, `Unresolved`
and `Not applicable`. Unresolved coverage, unanswered mandatory question categories
or outstanding blocking decisions prevent approval. Approval permits the Plan's
Pass to execute. Core does not interpret Markdown to infer material changes;
Teams register new blocking decisions when scope changes. Appended reports do
not reset approval.

Document names use local timestamps and concise titles, without random suffixes.
Timezone is retained in metadata; collisions fail. Core supplies directories and
records references. Native file tools write the documents; there are no content
update, revision or snapshot endpoints. See
[planning and guidance](Explanations.md#guidance-and-planning) and the
[CLI guide](How-To-User-Guides.md#plan-work-and-answer-decisions).

## Dependency and lock files

| File | Role |
| --- | --- |
| [`package-lock.json`](../package-lock.json) | Node/npm production lock used by private deployment preparation. |
| [`bun.lock`](../bun.lock) | Generated Bun lock used with `bun install --frozen-lockfile` for development. |
| [`uv.lock`](../uv.lock) | Python and authoring dependency lock. |
| [`pylock.toml`](../pylock.toml) | Portable Python lock export generated by `just lock`; `uv.lock` remains authoritative for uv. |
| [`pyproject.toml`](../pyproject.toml) | Python runtime requirements and local `dev` dependency group. |
| [`.node-version`](../.node-version) | Exact Node version selected for deployment and development. |

The application runtime declares AppRC core and terminal packages at version 0.34.0.
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
| `just runtime test` | Run runtime unit/native/integration tests. |
| `just runtime test-integration` | Run runtime integration tests. |
| `just runtime build` | Compile the runtime, Pi SDK/RPC launcher, Pi extension, and Paseo plugin. |
| `just eval probe` | Run the opt-in quick Agent Evals preset; requires normal app setup and the exact local model. |
| `just eval audit-static` | Run model-free instruction inventory checks. |
| `just eval audit` | Run the local Bonsai semantic Instruction Audit. |
| `just eval behavior` | Run read-only, no-op and targeted-fix Behavior Evaluation once with full instructions; fall back once to low reasoning on failure. |
| `just eval bottlenecks` | Run full-instruction cases once by default and report Bottleneck Attribution from their Perfetto-compatible traces. |
| `ltcook app doctor --verbose --json` | Inspect AppRC paths and local Ollama/Bonsai readiness. |
| `just check` | Enforce Prettier/Ruff formatting, TypeScript types, Python lint, and Pyright. |
| `just test` | Run Bun unit/native/integration and team contract tests, plus Python tests excluding `integration` and `system`. |
| `just test-integration` | Run marked Python and TypeScript integration tests. |
| `just test-system` | Run system checks, including required Linux real Pi/Paseo scripted acceptance. |
| `just build` | Build/stage runtime, team, and service production assets and the Python wheel/source distribution. |
| `just sync`, `just install` | Prepare the checkout-local uv environment, install frozen locks, build, stage assets, and register the Python application. Does not provision Ollama. |
| `just build-native` | Build committed-source Linux setup and SDK checksums with uv >=0.11.6 and Rust/LLVM. |
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
