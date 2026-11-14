# How-to user guides

[Documentation](README.md) · [Explanations](Explanations.md) · [References](References.md) · [Examples](EXAMPLES.md) · [Development](Development.md)

- [Install and start](#install-and-start)
  - [Install a release](#install-a-release)
  - [Install from a checkout](#install-from-a-checkout)
  - [Run the first command](#run-the-first-command)
  - [Remove an installation](#remove-an-installation)
- [Configure settings and paths](#configure-settings-and-paths)
  - [Initialize saved preferences](#initialize-saved-preferences)
  - [Authenticate with Pi](#authenticate-with-pi)
  - [Choose application paths](#choose-application-paths)
  - [Select a team and resume a session](#select-a-team-and-resume-a-session)
  - [Plan work and answer decisions](#plan-work-and-answer-decisions)
  - [Configure guidance](#configure-guidance)
  - [Configure research tools](#configure-research-tools)
- [Extend and maintain configuration](#extend-and-maintain-configuration)
  - [Add a setting](#add-a-setting)
  - [Use settings in application code](#use-settings-in-application-code)
  - [Troubleshoot configuration and installation](#troubleshoot-configuration-and-installation)

Commands below distinguish installation, configuration, and runtime startup.
Replace `ROOT` with the workspace directory you want the agents to use.

<br>

# Install and start

## Install a release

No LTCook release exists yet. Use [checkout installation](#install-from-a-checkout).
The current manual [release workflow](Development.md#releases) builds Linux assets
for inspection; it does not publish a GitHub Release or a PyPI package.

The Linux setup `ltcook-setup-linux-x86_64` embeds committed project source and
its exact lock. Run it with `--yes --skip-setup`; no adjacent wheel, shell
bootstrap or Python installer is needed. AppRC owns managed runtime slots;
updating uses a newer setup executable, not a main/release/wheel selector.
Building an asset does not prove installation or native Windows/macOS support.

## Install from a checkout

Start with Python 3.12+, Node matching `.node-version`, Bun, uv, Git and just.
From the repository root:

```shell
just sync
uv run --locked ltcook app install -e --yes --skip-setup
```

This registers the checkout's existing `.venv` and publishes its command without
copying or owning the developer environment. The exact unreleased AppRC commit
is pinned in `pyproject.toml` and `uv.lock`; an index version alone is insufficient.
No Rust/native compilation is needed for this route.

Registration initializes declared AppRC directories, extracts the canonical
`bundle.zip`, and prepares private Node, production dependencies, optional
browser tools and the configured service prerequisites. Local mode validates
Podman and its Compose provider. Missing native prerequisites can require normal
host elevation; this preparation does not start containers. `--skip-setup`
skips only optional configuration, not required initialization.

> [!WARNING]
> Existing schema-2 installations need their matching old retirement tools
> before schema-3 registration. Program-only old uninstall leaves an incompatible
> retained record. The old application CLI's `--complete` without categories
> selects all resources: do not use it for a retention-preserving cutover.
> Preview the matching old controller with an explicitly empty category set,
> `complete=True, forget_retained=True`, retaining every resource root and marker.
> Only recorded program/support outputs may be removed. Apply that reviewed
> revision/inventory through its supported handoff, wait for finalization, then
> register the original checkout. Never hand-edit/delete authority or reset Pi auth.

Configuration inspection and directory entry do not provision prerequisites.
Use `ltcook app doctor --json` for diagnostics; repeat the supported editable
registration to retry initialization. `config setup` initializes saved settings,
not external prerequisites.

Runtime launches omit an unset or empty `CONTAINER_CONNECTION`, preserving Podman's
default engine selection. Set it to a configured Podman connection name only when
a remote engine is intended.

The private deployment is populated from the packaged archive; after changing
runtime/team sources, rerun `just sync` and editable registration to refresh it.
See [installation placement](References.md#installation-placement) for recorded
resource locations and explicit migration.

> [!WARNING]
> Windows/macOS installation and live web/model workflows are not established by
> Linux checks. Browser installation failure is optional on supported hosts: the
> installer records the failure and continues without autonomous browser tools.
> Re-running the explicit installer retries the browser prerequisite. Core chat
> and configured web-search extensions do not require the browser tool.

## Run the first command

Inspect the application without starting agents:

```shell
ltcook --help
ltcook --version
ltcook diagnose --json
ltcook app paths
ltcook app doctor --json
ltcook config show --json
```

Open the server and bundled UI without choosing a project:

```shell
ltcook
```

This starts or reuses this installation's runtime, requests Paseo in the default
browser, and follows backend logs. From WSL it opens the Windows browser through
`explorer.exe`, never a WSL browser. Exact reuse or focus of an existing tab depends
on the browser. Ctrl+C detaches the log viewer and leaves the runtime running.
Stop that runtime explicitly with `ltcook stop`; Compose containers remain managed
separately by `ltcook services stop`.

For a browser-free foreground server, use `ltcook launch runtime`. Ctrl+C stops
a server started by that foreground command; reusing a server does not take over
its ownership. Old or raw developer runtimes without output capture must be
restarted through the installed CLI before desktop log attachment is available.

Logs include private captured stdout/stderr in `<deployment>/logs/backend.log`,
the configured telemetry JSONL, and Paseo's rotating daemon log. Upstream output
can contain sensitive details; do not share these files without reviewing them.
If browser opening fails, the terminal prints the URL and continues following
logs. WSL host navigation requires working interop and localhost forwarding.

Opening the UI does not create a Session or start agents. In Paseo, select a
project directory and use **Start session** when ready. Before starting agents,
[choose their models](#initialize-saved-preferences) and
[authenticate with Pi](#authenticate-with-pi).

The **Team status** panel contains three views:

- **Team Overview** shows active Passes, progress, members and issues. Select a
  member to open Agent Focus; expand issue details to read recorded blockers.
- **Task Board** groups Tasks by their recorded state. Select a Task to inspect
  its description, acceptance criteria, ordered Steps, blocker and report.
- **Agent Focus** shows role settings, current assignments, recorded handoff and
  report, plus native model/activity when available. **Open conversation** uses
  Paseo's existing chat and is unavailable for disconnected members.

Use **Refresh** to reload coordination state. Task dependencies are not recorded
by the current runtime; the board does not infer a dependency graph. Private work
text is fetched only for the selected detail, not included in bulk status data.

To open an existing project directory directly from the terminal:

```shell
ltcook launch runtime --workspace ROOT
```

Neither registration nor an AppRC marker is required. An existing
`apprc.workspace.env` enables the normal project settings and secret layers;
without it, launch uses user settings. Launching does not create markers or
registry entries. `ltcook workspace add project-name ROOT --yes` remains an
optional way to manage project-specific AppRC configuration.

The runtime starts Paseo using its built-in Pi provider. In local service mode,
runtime startup also starts the prepared LTCook Compose project; in direct or
tunnel mode, the configured services remain on their remote host. Check service
status before relying on live research. Runtime startup prints `Paseo <listen>`;
open `http://<listen>/` in a browser for Paseo's bundled web UI. The UI is
enabled by the runtime and needs no separate server, assets, or dependency. You
can also connect through Paseo's existing client and select the LTCook
team-status panel. If `LTCOOK_PASEO_PASSWORD` is set, it protects API and
WebSocket access, not the static HTML page. Never put the password in the URL.
The minimal team contains Main and Adjutant, not hidden specialists. Starting
agents is distinct from sending a model-backed prompt, which needs a working
provider and explicit input. The former terminal `ltcook launcher` is removed:
use bare `ltcook` for Paseo and `ltcook app ...` for maintenance.

## Remove an installation

Preview with `ltcook app uninstall --dry-run`, then use
`ltcook app uninstall --yes` for program-only removal. Declared resources,
external shared Pi auth and editable checkout/environment remain intact.

> [!CAUTION]
> Explicit appdata removal deletes LTCook's deployment; state removal deletes
> runtime documents and coordination data.
> Select categories deliberately; program removal is not permission to erase data.

The [uninstaller reference](References.md#uninstaller-reference) explains complete
removal. LTCook cleanup is scoped to its recorded deployment and Compose project;
it must not remove an independent `lcook` installation, unrelated services, shared
Podman, or external workspaces. Invalid ownership metadata preserves the affected
resources for recovery rather than guessing what can be deleted.

<br>

# Configure settings and paths

## Initialize saved preferences

Use the existing AppRC configuration CLI:

```shell
ltcook config setup --yes
ltcook config set app.team default-minimal --scope user
ltcook config edit
ltcook config show --json
```

`app.team` uses `LTCOOK_TEAM` and defaults to `default-minimal`. Set
`runtime.smart_model`, `runtime.smol_model`, and, for the full team,
`runtime.plan_model` in the editor using model identifiers supported by the
installed Pi provider. An empty non-smart alias falls back to the smart selection.
These selections are required when creating agents, not when opening the idle
server/UI. Provider account login belongs to Pi, as described
[below](#authenticate-with-pi). An API key may instead be supplied through the
provider's AppRC secret field or native environment variable such as
`OPENAI_API_KEY`. `config show --json` reports application settings, not provider
OAuth credentials. Store only revocable credentials agents may read.

Explicit runtime and service starts create only missing runtime, Crawl4AI and
SearXNG secrets after installation is Ready, preserving existing values. They do
not generate provider credentials. Status, diagnosis and auth checks do not
initialize these service secrets.

The [configuration layers](Explanations.md#configuration-files) preserve saved
user defaults, registered workspace overrides, and deliberate shell exports.
AppRC does not take ownership of arbitrary repository `.env` files. Use
`ltcook config --help` for the installed version's workspace and secret-file
management commands rather than inventing another configuration editor.

## Authenticate with Pi

LTCook exposes the installed Pi authentication CLI without implementing another
login flow:

```shell
ltcook auth login openai
ltcook auth check --provider openai --json --no-refresh
ltcook auth logout openai
```

`login` requires an interactive terminal. For a headless machine, use
`ltcook auth login openai --no-browser` and follow Pi's instructions. To store an
OpenAI API key rather than sign in with an account, use
`ltcook auth login openai --api-key`. Account OAuth and API billing credentials
are different methods; configuring `OPENAI_API_KEY` is not a ChatGPT login.
The wrapper preserves Pi's exit status; `auth check` reports ready/not-ready/invalid
without printing the credential. `--no-refresh` avoids refreshing an expired
OAuth token during inspection.

All LTCook projects use `<LTCOOK_PI_AUTH_DIR>/auth.json`, defaulting to
`~/.pi/agent/auth.json`. Existing Pi credentials there are reused. Set the
user-scoped `runtime.pi_auth_dir` (`LTCOOK_PI_AUTH_DIR`) to use another native Pi home.
Workspace-local Pi settings, models, extensions, web configuration, and session
histories remain separate; credentials are not copied or linked into those homes.
Earlier logins stored only in a workspace Pi home are not imported: run the
shared login once, or select an existing user-level auth home.

Logout removes stored credentials; it does not unset API keys in AppRC or the
environment, or revoke credentials at the provider.

> [!CAUTION]
> Login and logout affect other Pi instances using the same credential home.
> Keep `auth.json` private. LTCook does not remove an external shared Pi auth home
> when uninstalling its own application resources.


## Choose application paths

AppRC records absolute native or explicitly selected resource locations
separately from program ownership. Config, appdata, cache and state are enabled
independently. Use `ltcook app migrate --help` for supported explicit relocation;
do not move/edit the fixed native `installation/` authority by hand.

The default deployment is `<appdata>/deployment`, including private `node/`,
production `app/` and service receipts. Runtime documents and coordination use
`<state>/runtime` by default; cached project facts use `<cache>/projects`. Paseo's mutable home
defaults to `<LTCOOK_DEPLOYMENT_DIR>/paseo`, outside the replaceable
`<LTCOOK_DEPLOYMENT_DIR>/app` bundle. Workspace Pi homes default to
`<LTCOOK_DEPLOYMENT_DIR>/workspaces/<workspace-id>/pi`.
Shared provider authentication is separate: `runtime.pi_auth_dir` defaults to Pi's
user-level `~/.pi/agent`, and the SDK reads that home's `auth.json` without
changing the workspace-specific `PI_CODING_AGENT_DIR`.

`PASEO_HOME` must resolve inside the current deployment but outside its immutable
`app/` tree. `PI_CODING_AGENT_DIR` must resolve inside the deployment. Invalid
paths are rejected with the variable name.

Use `ltcook app paths` and `ltcook app doctor --json` to inspect actual locations.
See [project paths](References.md#project-paths).

## Select a team and resume a session

Use an existing project directory; registration and workspace initialization are
optional, as described in the [first-launch step](#run-the-first-command).

For a single POSIX invocation:

```shell
LTCOOK_TEAM=default-minimal LTCOOK_SESSION=my-project ltcook launch runtime --workspace ROOT
```

The aliases `default` and `default-minimal` resolve to the bundled team packages.
Other values are dynamically imported JavaScript module specifiers; the module
must already be resolvable in the deployment and export an `apiVersion: 2` team.
Changing the setting does not install a module.

When `LTCOOK_SESSION` is unset, opening a project creates a fresh chat Session.
Starting the server without a project creates none. Set `LTCOOK_SESSION`
explicitly to resume that Session with the same workspace and
selected team; a Session cannot silently switch either. Multiple Sessions in one
workspace share a persistent TeamInstance, while their native conversations and
agent bindings remain separate.

Only one runtime owns a coordination database. A later `ltcook launch runtime
--workspace ROOT` command contacts that runtime to open the requested project
session. A launch without `--workspace` only starts or connects to the idle host;
it does not select a project. Stop the owner before starting another
runtime against the same database. A different selected team requires a runtime
configured for that team and must not be added to the existing owner's sessions.

Recovery reconciles native bindings and leaves uncertain handoffs blocked rather
than resending them. Inspect the panel's blockers and native conversations before
choosing further action. Restarting is not renewed permission to repeat an
external operation. [Coordination and recovery](Explanations.md#coordination-and-recovery)
explains the ownership boundary.

## Plan work and answer decisions

Open an explicit project Session first. Have the Team write its Design under
`<LTCOOK_RUNTIME_STATE_DIR>/documents/designs/`, using
`Design-YYYY_MM_DD-HH_MM-<concise-title>.md`. Start planning with its absolute path:

```shell
ltcook planning start --session SESSION --design /absolute/path/Design-2026_11_14-18_00-example.md --title example
ltcook planning show --session SESSION --plan Plan-2026_11_14-18_05-example
ltcook planning questions --session SESSION --plan Plan-2026_11_14-18_05-example
```

Use the registered Plan ID returned by `start`; example timestamps are illustrative.
Adjutant writes the proposed Plan, then Main investigates and finalizes the same
file. Pending questions use native Paseo dialogs. If a dialog is interrupted,
inspect `questions` and answer explicitly through the authenticated CLI:

```shell
ltcook planning answer --session SESSION --plan PLAN_ID --decision DECISION_ID --answer 'Use clean breaking changes'
ltcook planning approve --session SESSION --plan PLAN_ID
ltcook planning reject --session SESSION --plan PLAN_ID
```

`approve` succeeds only after finalization, complete topic coverage, answered
mandatory categories and no outstanding blocking decisions. Rejection does not
permit execution. Missing responses, defaults and cancellation remain pending.
Session and Plan context are always explicit; these commands do not create a
Session or infer one from the current directory.

The Team appends detailed implementation reporting to the Plan, including
`Implementation Report`, `Emerging Issues` and `User decisions post approval`.
Lasting design decisions also belong in the Design. Appending reports does not
reset approval; a material scope change requires an explicit new user decision.

## Configure guidance

User guidance defaults to `<AppRC config>/guidance/rules/` and `skills/`. Set its
global root through AppRC when needed:

```shell
ltcook config set runtime.guidance_dir /absolute/path/guidance --scope user
ltcook guidance inspect --session SESSION
ltcook guidance inspect --session SESSION --agent NATIVE_AGENT_ID
```

Rules are Markdown standing instructions. Skills use native `SKILL.md` directories
with names and descriptions. Their bodies and references load on demand; the
bundled reader-load skill remains explicit-only. The inspector reports scope,
kind, applicability, diagnostics and actual native loading. Distinct resources
with conflicting names fail activation; repeated discovery of the same physical
resource is deduplicated. Required Core resources must be present.

Project `AGENTS.md`, `.pi/skills` and `.agents/skills` keep native trust behavior.
Global roots resolve before native agents change `HOME`; project settings cannot
redirect shared state, User guidance or the shared auth home. Core planning and
Clear Writing rules apply to every Team. Optional integrations do not disable
them or the execution guards.

## Configure research tools

Use the `web` section for `web.searxng_url`, `web.crawl4ai_url`, and
`web.ssrf_allow_ranges`, and the AppRC setting `web.crawl4ai.api_token` for the
Crawl4AI credential (`CRAWL4AI_API_TOKEN`). The typed Python bundle exposes that
credential as `config.crawl4ai.api_token`. Local Compose assets bind to loopback.
For a central host, configure reachable URLs and explicitly choose
`web.connection_method` (`direct` or `paseo-tunnel`); Paseo pairing alone does
not expose arbitrary HTTP services. Remote service control remains on that host.
Only allow the private network ranges actually needed; do not disable SSRF
protection globally.

The commands use the current directory by default; pass `--workspace ROOT` to
resolve service configuration for a specific workspace.

Project-specific service overrides are optional. Existing initialized AppRC
workspace settings are used when present; service commands do not create markers.

Use the service commands for local Compose operations:

```shell
ltcook services start
ltcook services status
ltcook services logs
ltcook services stop
```

`start` starts the services in local mode; `status` inspects their containers and
`logs` shows recent output. `stop` stops SearXNG and Crawl4AI without removing the
project. Starting the runtime in local mode also starts the Compose project.
Check service status before live research: command success does not establish
healthy containers or successful web requests.

For `web.connection_method=direct` or `paseo-tunnel`, local commands do not
operate the remote host. Start and inspect remote services there. The local
controller cannot verify remote health or remove remote services.

The SearXNG Compose service publishes host loopback port `8888` to container port
`8080`, matching the AppRC default URL. This configuration correspondence does
not by itself prove that live searches succeed.

Lookup instructions start with a known source or targeted search. Explore
instructions compare alternatives and gaps from the outset. Both use SearXNG
search and HTTP/Crawl4AI retrieval; neither enables extension-internal model
summaries, query rewriting, or hosted fallback providers. Crawl4AI's configured
pool limits the server to two concurrent pages with one worker.

> [!IMPORTANT]
> Codesearch sends explicit public-code searches to hosted grep.app. Optional
> Context7 sends library-documentation requests to its hosted service. Neither is
> a private local index or an automatic SearXNG fallback. Do not submit secrets or
> private source to external tools.

The autonomous browser needs the separate `agent-browser` executable and browser
files prepared during installation. Enabling its Pi extension alone is not enough.
`runtime.browser_enabled` controls activation, `runtime.codesearch_enabled` controls
codesearch, and `runtime.context7_enabled` defaults to false. Browser prerequisites
are never installed by a passive status check or team activation.

<br>

# Extend and maintain configuration

## Add a setting

Add real application settings to the owning registered class in
[`config/sections`](../src/ltcook/config/sections), using `rc.field(...)` with the
consumer's exact environment name. Register new sections with `APP_RC.config(...)`
and include them in [`LtcookConfig`](../src/ltcook/config/bundle.py). Do not add
example retry/message fields or keep hidden TypeScript defaults.

Consume each section's `current_env_mapping()` in the appropriate workspace
launch, and add native translation only where a component requires its own
format. Mark credentials `secret=True`; redaction does not encrypt their stored
files. Follow [working conventions](../CONTRIBUTING.md#working-conventions).

## Use settings in application code

This illustrative program reads the existing team setting; it does not write
configuration or start agents:

```python
from ltcook.config.app import APP_RC
from ltcook.config.bundle import LtcookConfig

resolved = APP_RC.resolve()
config = resolved.build(LtcookConfig)
print(config.app.team)
```

Pass the resolved bundle or section to code that needs it. In a mounted Typer
command, reuse `state.resolved` rather than resolving the invocation twice.
Workspace launch code uses `resolve_launch(ROOT, original_environment=...)` to
resolve settings for the target workspace from original shell inputs. It does
not treat a prior workspace's merged environment as shell input. The
[settings example](EXAMPLES.md#resolve-settings-in-python) reads the existing
team setting without replacing application modules.

## Troubleshoot configuration and installation

Use `ltcook app paths` and `ltcook app doctor --json` for passive inspection.

| Symptom | Action |
| --- | --- |
| Command unavailable | Use the installed environment's executable or `python -m ltcook`. |
| Saved team is ignored | Compare `LTCOOK_TEAM` shell exports and registered workspace overrides. |
| Runtime deployment is missing | Run `just sync`, then repeat editable registration to initialize the staged payload. |
| Model alias is empty | Configure the matching `runtime.*_model` or smart fallback and provider credentials. |
| Provider authentication is not ready | Run `ltcook auth check --provider openai --json --no-refresh`, then use Pi login for the selected provider. |
| Session reports a different team/workspace | Restore the original selection or choose a new session identifier. |
| Database already has an owner | Stop that runtime; do not delete its lock or run another recovery owner. |
| Browser unavailable | Inspect the installation receipt and browser prerequisites; do not confuse it with core chat/search availability. |
| Web tools cannot connect | Check configured URLs, actual Compose ports, credentials, network access, and narrow SSRF allowances. |
| Saved installation is incomplete | Inspect `ltcook app doctor --json` and use the matching `app repair` workflow; preserve pending authority. |

The internal `python -m ltcook.launch environment --workspace ROOT` command emits
raw child-process environment values, including secrets. It is not a redacted
diagnostic; do not paste its output into issues, logs, or a shared terminal.
Use the [command reference](References.md#command-reference) for safe inspection.
