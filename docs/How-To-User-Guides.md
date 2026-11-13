# How-to user guides

[Documentation](README.md) · [Explanations](Explanations.md) · [References](References.md) · [Examples](EXAMPLES.md) · [Development](Development.md)

- [Install and start](#install-and-start)
  - [Install a release](#install-a-release)
  - [Install from a checkout](#install-from-a-checkout)
  - [Run the first command](#run-the-first-command)
  - [Remove an installation](#remove-an-installation)
- [Configure settings and paths](#configure-settings-and-paths)
  - [Initialize saved preferences](#initialize-saved-preferences)
  - [Choose application paths](#choose-application-paths)
  - [Select a team and resume a session](#select-a-team-and-resume-a-session)
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

The portable PyApp delivery consists of three adjacent assets: `ltcook-install`
(`ltcook-install.exe` on native Windows), `main-installer.pyz`, and the canonical
LTCook wheel matching the project version. The launcher validates the wheel's
identity and SHA-256, then AppRC installs it as a noneditable local wheel. This
bundle needs no project checkout and does not download source.

PyApp runs the generated AppRC installer from the separate `ltcook-installer`
bootstrap environment, which depends on `apprc-core` and its transitive
requirements, not `ltcook`. AppRC's configured `uv tool` backend installs the
actual LTCook application and owns its environment. The native shell installer
in the next section is a separate checkout-based route.
An artifact build does not prove a completed installation or support on every
platform.

## Install from a checkout

Start with Python 3.12+, Node matching `.node-version`, Bun, uv, and just. From
the repository root, build and stage the production payload before generating
the checkout installer:

```shell
just sync
just make-artifacts
```

Then run `./app-install.sh --layout native` on Linux/macOS or
`.\app-install.cmd --layout native` in native Windows. The generated installer
uses the selected checkout and prepares a private Node installation and JavaScript
application under AppRC appdata. It installs production dependencies from
`package-lock.json`, prepares browser prerequisites, and checks or installs Podman
and a Compose provider for local services. This is explicit setup: it can download
software and require the host's normal elevation. It does not start the Compose stack.

A compatible existing Podman installation is reused. macOS and native Windows
may require a Podman machine. Configuration inspection and directory entry do not
perform this preparation. Re-run the explicit installer to retry preparation;
`ltcook config setup --yes` initializes configuration, not external prerequisites.
See [installation placement](References.md#installation-placement) for native and
single-root resource layouts.

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
ltcook version
ltcook diagnose --json
ltcook installation show
ltcook installation doctor
ltcook config show --json
```

After installation, [save model selections and credentials](#initialize-saved-preferences).
Before the first workspace-specific launch for a repository, register its AppRC
workspace once:

```shell
ltcook workspace add project-name ROOT --yes
```

Then start the selected workspace:

```shell
ltcook launch runtime --workspace ROOT
```

Launching does not create the required workspace marker.

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
native agents is distinct from sending a prompt; a model-backed conversation
additionally needs a working provider and explicit user input. The optional
`ltcook launcher` opens AppRC management; it is not a separate chat interface or
a substitute for the runtime command.

## Remove an installation

Run the generated `./app-uninstall.sh` or native Windows `app-uninstall.cmd`.
Program-only removal retains declared resources and saved recovery support.
Inspect `ltcook installation uninstall --dry-run` before removal.

> [!CAUTION]
> Explicit appdata removal deletes LTCook's deployment and coordination data.
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
Configure the required provider credential there as well; secret fields use
AppRC's secret env files. Store only revocable credentials agents may read.
`config show --json` reports application settings, not a dump of every component
credential.

The [configuration layers](Explanations.md#configuration-files) preserve saved
user defaults, registered workspace overrides, and deliberate shell exports.
AppRC does not take ownership of arbitrary repository `.env` files. Use
`ltcook config --help` for the installed version's workspace and secret-file
management commands rather than inventing another configuration editor.

## Choose application paths

The installer accepts `--layout native` or
`--layout single-root --root ABSOLUTE_PATH`. Reinstallation reuses recorded
absolute resource paths unless placement is explicitly overridden. Config,
appdata, cache, and state are enabled independently in the AppRC declaration.
The fixed native `installation/` authority remains separate from appdata.

The default deployment is `<appdata>/deployment`, including private `node/`,
production `app/`, service receipts, and coordination data. Paseo's mutable home
defaults to `<LTCOOK_DEPLOYMENT_DIR>/paseo`, outside the replaceable
`<LTCOOK_DEPLOYMENT_DIR>/app` bundle. Workspace Pi homes default to
`<LTCOOK_DEPLOYMENT_DIR>/workspaces/<workspace-id>/pi`.

`PASEO_HOME` must resolve inside the current deployment but outside its immutable
`app/` tree. `PI_CODING_AGENT_DIR` must resolve inside the deployment. Invalid
paths are rejected with the variable name.

Use `ltcook config paths --json` and `ltcook installation show` to inspect actual
locations. See [project paths](References.md#project-paths).

## Select a team and resume a session

Register this repository once with AppRC before using `--workspace`; follow the
[first-launch step](#run-the-first-command) to add its workspace marker.

For a single POSIX invocation:

```shell
LTCOOK_TEAM=default-minimal LTCOOK_SESSION=my-project ltcook launch runtime --workspace ROOT
```

The aliases `default` and `default-minimal` resolve to the bundled team packages.
Other values are dynamically imported JavaScript module specifiers; the module
must already be resolvable in the deployment and export an `apiVersion: 1` team.
Changing the setting does not install a module.

The launcher derives a stable session identifier from the workspace when
`LTCOOK_SESSION` is unset. Set `LTCOOK_SESSION` to choose a different stable
identifier explicitly. Reusing the same identifier, workspace, and selected
team opens the saved session; a session cannot silently change its workspace or
team.

Only one runtime owns a coordination database. A later `ltcook launch runtime`
command contacts that runtime to open the requested workspace session rather
than starting another database owner. Stop that owner before starting another
runtime against the same database. A different selected team requires a runtime
configured for that team and must not be added to the existing owner's sessions.

Recovery reconciles native bindings and leaves uncertain handoffs blocked rather
than resending them. Inspect the panel's blockers and native conversations before
choosing further action. Restarting is not renewed permission to repeat an
external operation. [Coordination and recovery](Explanations.md#coordination-and-recovery)
explains the ownership boundary.

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

Register that repository first with `ltcook workspace add NAME ROOT --yes`.
Service commands do not create its AppRC marker.

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

Use `ltcook config paths --json`, `ltcook config doctor --json`, and
`ltcook installation doctor` for passive inspection.

| Symptom | Action |
| --- | --- |
| Command unavailable | Use the installed environment's executable or `python -m ltcook`. |
| Saved team is ignored | Compare `LTCOOK_TEAM` shell exports and registered workspace overrides. |
| Runtime deployment is missing | Re-run the explicit generated installer after building/staging its inputs. |
| Model alias is empty | Configure the matching `runtime.*_model` or smart fallback and provider credentials. |
| Session reports a different team/workspace | Restore the original selection or choose a new session identifier. |
| Database already has an owner | Stop that runtime; do not delete its lock or run another recovery owner. |
| Browser unavailable | Inspect the installation receipt and browser prerequisites; do not confuse it with core chat/search availability. |
| Web tools cannot connect | Check configured URLs, actual Compose ports, credentials, network access, and narrow SSRF allowances. |
| Saved installation is incomplete | Use installation inspection/repair with matching saved support. |

The internal `python -m ltcook.launch environment --workspace ROOT` command emits
raw child-process environment values, including secrets. It is not a redacted
diagnostic; do not paste its output into issues, logs, or a shared terminal.
Use the [command reference](References.md#command-reference) for safe inspection.
