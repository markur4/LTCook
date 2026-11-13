# Explanations

[Documentation](README.md) · [How-to user guides](How-To-User-Guides.md) · [References](References.md) · [Examples](EXAMPLES.md) · [Development](Development.md)

- [Application and settings](#application-and-settings)
  - [Command-line application](#command-line-application)
  - [AppRC](#apprc)
  - [Config sections](#config-sections)
  - [ResolvedConfig](#resolvedconfig)
- [Files and paths](#files-and-paths)
  - [Configuration files](#configuration-files)
  - [Filesystem capabilities](#filesystem-capabilities)
- [Tools and package structure](#tools-and-package-structure)
  - [Configuration tools](#configuration-tools)
  - [Config bundle](#config-bundle)
  - [Package layout and dependencies](#package-layout-and-dependencies)
- [Agent runtime](#agent-runtime)
  - [Pi and Paseo](#pi-and-paseo)
  - [Interchangeable teams](#interchangeable-teams)
  - [Coordination and recovery](#coordination-and-recovery)
  - [Web services and diagnostics](#web-services-and-diagnostics)

This page explains LTCook's configuration boundary and its native agent runtime.
Python resolves settings and launches components; TypeScript owns coordination.

<br>

# Application and settings

## Command-line application

The command-line application is the Typer `app` in
[`cli/app.py`](../src/ltcook/cli/app.py). Both the console script and
`python -m ltcook` run this object. AppRC mounts configuration and
installation-management commands in its Maintenance help panel. Installation
inspection, repair and uninstall preview remain available without starting
agents or the web-service stack.

The optional `launcher` uses one Textual event loop for management and the
installed application's command. It captures layout, workspace, dotenv, and
environment controls from the initiating CLI context. Application startup and
uninstall remain separate actions; the launcher does not recreate environments
or run business setup merely to show management.

## AppRC

`APP_RC` in [`config/app.py`](../src/ltcook/config/app.py) is the shared
`rc.AppRC` declaration. It identifies the application, independently enables
config and appdata paths, and optionally declares saved user dotenv support.
Installation state is recorded separately from these application resources.
The declaration enables only the capabilities the application uses; an
installation receipt cannot enable an undeclared path.

## Config sections

Config sections group settings by component and environment prefix. The
[`LtcookConfig`](../src/ltcook/config/bundle.py) exposes `app`, `runtime`,
`paseo`, `pi`, provider sections (`anthropic`, `openai`, `google`, `openrouter`),
`context7`, `agent_browser`, and web-service sections (`web`, `searxng`,
`crawl4ai`, `podman`, `container`, `playwright`). The native environment names
remain those declared by each field; for example, `LtcookConfig` exposes
`config.crawl4ai.api_token` for `CRAWL4AI_API_TOKEN`, while the AppRC manager path
for that setting is `web.crawl4ai.api_token`.
TypeScript consumes the resolved startup configuration; it does not maintain a
second set of configuration defaults.

Field `title`, `explanation_short`, and `explanation_long` are reused by the
config editor. Use `secret=True` for redacted display of sensitive values; this
flag does not encrypt stored values.

## ResolvedConfig

A `ResolvedConfig` contains the values read for one invocation. The mounted CLI
calls `APP_RC.resolve()` and stores the result as `state.resolved`.
`resolved.build(LtcookConfig)` converts those inputs into the application's
[config bundle](#config-bundle).

Each result retains the values it read; a later environment change does not
mutate an earlier result or `os.environ`. A workspace-bound agent receives a
fresh resolution for its own repository, not the root workspace's settings
relabelled as shell exports. Deliberate shell exports still take precedence.
The [application-code guide](How-To-User-Guides.md#use-settings-in-application-code)
shows how to construct settings explicitly outside the CLI.

<br>

# Files and paths

## Configuration files

Configuration layers include Python and packaged defaults, AppRC's saved user
and secret env files, registered workspace settings and secrets, explicit
dotenv files, and the captured process environment. Repository settings can
override user defaults; shell exports retain AppRC's normal final precedence.
LTCook does not take ownership of arbitrary `.env` files.

`PASEO_HOME` must resolve inside the current deployment and outside its
immutable `<deployment>/app` tree; `PI_CODING_AGENT_DIR` must resolve inside
the deployment. An invalid path is rejected with its variable name. The Node
host is the sole writer of `<PASEO_HOME>/config.json`; it uses the final
AppRC-resolved `PASEO_HOME`, even when `LTCOOK_JS_ROOT` points to source.
Python's `write-native-config` command writes only the private
`<PI_CODING_AGENT_DIR>/web-search.json`; it does not write Paseo configuration.

The mutable Paseo home defaults to `<LTCOOK_DEPLOYMENT_DIR>/paseo`, outside the
replaceable `<LTCOOK_DEPLOYMENT_DIR>/app` bundle. Pi homes default to
`<LTCOOK_DEPLOYMENT_DIR>/workspaces/<workspace-id>/pi`. Secret fields are
redacted in diagnostics; raw component environment mappings are launch inputs,
not material to print in logs or the status panel.

## Filesystem capabilities

AppRC declares config, appdata, cache, and state independently. Each enabled
resource has one captured absolute path in the installation placement; disabled
resources remain absent. A native layout uses platform locations. A
single-root layout uses `config/`, `appdata/`, `cache/`, and `state/` beneath
one absolute root. Reinstallation reuses recorded paths unless an explicit
layout override is supplied.

The fixed native `installation/` directory is separate from appdata and is
never a purgeable capability. It contains the authoritative installation
record and saved management support required for repair and recovery.

<br>

# Tools and package structure

## Configuration tools

`APP_RC.manage()` returns a `ConfigManager` that initializes declared files,
inspects settings, and plans edits. It provides the same operations to Python
code and the interactive interfaces. Creating a manager does not write.

The `config` group is mounted by AppRC. `config doctor` reports missing values
and source problems, `config set` saves a scoped override, and `config edit` opens
the Textual configuration editor. The
[editing guide](How-To-User-Guides.md#initialize-saved-preferences) shows how to
initialize and save settings.

The editor displays effective values and contributing layers. It can edit saved
user or workspace overrides, but it does not rewrite packaged defaults or the
parent shell's environment. Opening it writes nothing; setup and save are
explicit actions.

## Config bundle

A config bundle is a dataclass containing the registered config sections. The
[`LtcookConfig`](../src/ltcook/config/bundle.py) keeps those sections together
while preserving their separate declarations and paths. Typed bundle fields
include `config.runtime.api_token`, `config.crawl4ai.api_token`, and
`config.searxng.secret`. The corresponding AppRC setting paths are
`runtime.api_token`, `web.crawl4ai.api_token`, and `web.searxng.secret`.
For a programmatic user-scoped secret write, call
`manager.plan_update(ENV_NAME, value, scope='user')` with
`LTCOOK_API_TOKEN`, `CRAWL4AI_API_TOKEN`, or `SEARXNG_SECRET`, then save the
plan with `manager.apply_edit(plan)`. Update keys are environment names, not
dotted paths.

`@APP_RC.bundle` registers the dataclass. `resolved.build(LtcookConfig)`
constructs its section factories from the same `ResolvedConfig`. The
[settings example](EXAMPLES.md#resolve-settings-in-python) reads the existing
team setting without replacing application modules. Importing the bundle imports
its sections; there is no separate config catalog.

## Package layout and dependencies

Runtime source lives under `src/ltcook`. Package initializers stay small;
commands import the declaration and bundle directly from their modules. The
[project paths](References.md#project-paths) table identifies each source file,
and [Development](Development.md#repository-routing) explains where to add code.

The application uses matching published AppRC core and terminal packages.
The local `dev` group supplies authoring and verification tools; it is not
required by the installed application. Runtime and team JavaScript packages
are separate workspaces, with versions resolved in the root dependency locks.

<br>

# Agent runtime

## Pi and Paseo

Paseo provides chat, connectivity and native agent identities. Its built-in Pi
provider runs the agents; LTCook does not implement another provider or chat
interface. Conversations remain in native Pi/Paseo storage.

The Python launch helper builds the component's environment from AppRC.
The TypeScript host connects native agent operations to the
[`RuntimeController`](../runtime/src/core/runtime.ts), keeping settings
resolution separate from scheduling and coordination.

## Interchangeable teams

Each team exports `apiVersion`, `definition`, `activateService` and
`activateAgent` through the [public team API](../runtime/src/api/team.ts).
The host loads the selected package and uses its definition, not fixed role
names or a fixed member count.

The [default team](../teams/default) declares six persistent members and four
explicitly temporary specialist variants. The
[minimal team](../teams/default-minimal) declares exactly Main and Adjutant.
Main performs absent specialists' work in the minimal team; self-inspection is
not labelled an independent review. Team selection stays fixed for a session.

## Coordination and recovery

One runtime owns the SQLite coordination database. It records only sessions,
passes, tasks, assignments, reports, applicable reviews, scoped user approvals
and bindings to native agent identities. It is not a configuration database or
transcript mirror.

Recovery reconciles saved bindings with native agents before dispatching work.
An uncertain external outcome is a blocker, not permission to resend an action.
A restart does not mint approvals or silently replace the selected team.
LTCook does not migrate application data during installation or reinstallation.

## Web services and diagnostics

Pi plans research and writes cited answers. pi-web-access searches only through
SearXNG and reads pages through HTTP or Crawl4AI. The selected routes do not
permit unconfigured hosted fallbacks or hidden answer/summary model calls.
Lookup and Explore are research instructions, not a separate state machine.

One Podman Compose project contains separate SearXNG and Crawl4AI services.
Prerequisites are prepared by explicit setup, never by status inspection or
directory entry. Cleanup targets LTCook's project, not shared Podman resources.

The Paseo status panel reads the selected runtime's members and assignments.
Local logs and Perfetto traces correlate operations without recording secret
values or full prompts/transcripts by default. There is no observability server.
