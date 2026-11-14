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
  - [Pi authentication](#pi-authentication)
  - [Domain terminology](#domain-terminology)
  - [Interchangeable teams](#interchangeable-teams)
  - [Guidance and planning](#guidance-and-planning)
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

Server startup and native authentication explicitly use global inspection through
`ConfigManager.inspect(include_workspace=False)`, so a selected registry entry
cannot silently choose a project. Opening an existing project path uses normal
workspace resolution when its AppRC marker exists, otherwise global settings.
The project root remains the agents' working directory in either case.

<br>

# Files and paths

## Configuration files

Configuration layers include Python and packaged defaults, AppRC's saved user
and secret env files, optional initialized workspace settings and secrets,
explicit dotenv files, and the captured process environment. Project settings
can override user defaults; shell exports retain normal final precedence.
LTCook does not take ownership of arbitrary `.env` files or require a marker
merely to launch. Native application resource paths do not depend on project
registration.

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

Provider credentials are separate from those project homes. `runtime.pi_auth_dir`
(`LTCOOK_PI_AUTH_DIR`) is resolved from global user settings and defaults to
native Pi's `~/.pi/agent`. Every project runtime uses that directory's
`auth.json` through Pi's supported SDK; models and other Pi configuration remain
project-local. No credential file is copied or linked into a project home.

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
provider uses LTCook's managed Pi SDK/RPC entry to select a shared authentication
store while retaining project-local services. Pi's public session/runtime APIs
own agent execution and the RPC lifecycle; LTCook does not implement another
OAuth provider or chat interface. Conversations remain in native Pi/Paseo storage.

The Python launch helper builds the component's environment from AppRC.
The TypeScript host connects native agent operations to the
[`RuntimeController`](../runtime/src/core/runtime.ts), keeping settings
resolution separate from scheduling and coordination.

Starting the server without a project opens only Paseo and the local runtime
API. A user explicitly opens a project from the terminal or **Start session** in
the Paseo panel. Selecting a directory or viewing the panel alone does not
initialize a Session or create agents.

## Pi authentication

`ltcook auth login`, `logout`, and `check` run the installed Pi authentication CLI
with its agent directory set to the shared user auth home. The commands retain
Pi's interactive terminal, credential storage, and exit behavior. ChatGPT account
sign-in uses Pi's OAuth flow; an OpenAI API key is a different method and can also
be supplied through the declared `OPENAI_API_KEY` secret.

Paseo's agent command instead constructs Pi's public `ModelRuntime` with an
explicit shared `authPath` and a project-local `modelsPath`. Pi owns credential
refresh and cross-process storage locking. Its project services still use the
workspace `PI_CODING_AGENT_DIR`, so web configuration and extension settings do
not overwrite another project's configuration. The shared auth home is not an
AppRC-managed application resource and is not purged with LTCook's appdata.

The [authentication guide](How-To-User-Guides.md#authenticate-with-pi) covers
headless login, API keys, and existing user-level Pi credentials. Provider login
is distinct from LTCook model-role selection and from the optional Paseo API/
WebSocket password.

## Domain terminology

These terms describe work, not ten separate workflow engines or database tables:

| Term | Meaning |
| --- | --- |
| Project | A logical collection of declared roots, repositories, Sessions, and Goals. It is not a filesystem sandbox. |
| Session | A user-facing chat with its own native conversation history and bindings. |
| Request | The native initiating message for work; a Task may reference its native message identifier. |
| Plan | A document specifying intended work and integration strategy. LTCook references it rather than storing a second plan history. |
| Pass | An explicitly created integration unit with a title and an optional Plan reference. |
| Task | An owned piece of work, optionally associated with a Pass; standalone Tasks do not create a Pass. |
| Step | Persisted, ordered progress within a Task. |
| Action | A tool call, message, or other action recorded by native Pi/Paseo history, not a second LTCook transcript. |
| Goal | A completion criterion spanning Passes and potentially multiple Sessions. |
| Phase | A classification of a Task or commit, not an independent scheduling engine. |

A TeamInstance is the persistent logical team for one selected team and canonical
workspace root. Several Sessions can share that TeamInstance while retaining
separate native agents and histories. Starting a chat does not create a new
logical workspace team, and sharing a team must not merge chats.

Worktree isolation belongs to a Task or Pass when the work needs it; a Project
does not imply one shared sandbox. Phase names classify work rather than
orchestrate it: `implementation` changes intended behavior, `review` examines
work, `verification` runs checks, and `integration` combines completed changes.
The fix phases identify what prompted a correction: `review-fix` addresses review
findings, `verification-fix` addresses check failures, `integration-fix` resolves
integration differences, and `system-fix` addresses a failure observed in the
running system. These classifications do not grant approval or bypass review.

## Interchangeable teams

Each team exports `apiVersion: 2`, `definition` and optionally `selectAssignee`
through the [public Team API](../runtime/src/team-api/index.ts).
The host loads the selected package and uses its definition, not fixed role
names or a fixed member count.

The [default team](../teams/default) declares six persistent members and four
explicitly temporary specialist variants. The
[minimal team](../teams/default-minimal) declares exactly Main and Adjutant.
Main performs absent specialists' work in the minimal team; self-inspection is
not labelled an independent review. Team selection stays fixed for a runtime.

## Guidance and planning

Core supplies required common rules and methods. Teams add member responsibilities
and methods; Projects retain native repository instructions and skills; Users add
global personal guidance. Rules enter applicable standing context. Native Pi
advertises skill descriptions and reads bodies/references when needed. Required
Core guidance and execution guards cannot be disabled by optional resource flags.
The [guidance inspector](References.md#guidance-api) reports sources, applicability,
conflicts and actual loading rather than assuming that discovered means loaded.

Core owns the planning sequence: Adjutant prefills, Main investigates and finalizes,
then the user approves. Teams declare eligible members, default routes and an
optional selection hook. The hook receives work context and eligible members; it
cannot answer user questions, approve execution or operate a second scheduler.
Main registers execution Tasks; the runtime schedules eligible work after Main
completes the post-approval registration handoff. Both bundled Teams preserve their
existing member models, lifetimes, read-only settings and review policy.

The Team writes Designs and Plans through native file tools in the global runtime
state directory. Core records document references, stages, topic coverage and
user decisions. It does not maintain document versions or interpret edits.
Documents retain their timestamped filenames; implementation reports append to
the same Plan. Approval attaches to the registered Plan and survives appended
reports. A declared blocking decision pauses new execution until answered.

Approval requires coverage of intent, design, scope, implementation, verification
and delivery, with no Unresolved topic. The mandatory question categories are
user intent; breaking changes, compatibility and migrations; and validation and
potentially lengthy verification. Applicable recorded answers can be reused.
Only authenticated CLI operations or correlated native user dialog responses can
answer or approve. Agent reports, recommendations, cancellation and timeouts do
not count as consent. Interrupted dialogs remain pending for CLI recovery.

Before approval, native tools permit read-only investigation and writing the
Design/Plan files in designated directories. Project edits, arbitrary shell
execution and other mutations are blocked. After approval, an active Pass permits
execution while member read-only restrictions remain. Unavailable runtime
authorization fails closed. These controls are native tool/API boundaries; they
are not an operating-system sandbox.

RIED combines bounded `brief` repository discovery with Git state, host tool
availability and Just recipe names. It stores one versioned cache under AppRC
and refreshes Git status when read. Session activation starts cache warmup without
waiting. Standalone LTCook Pi chats reuse the same discovery implementation and
AppRC cache, bound to their native Pi workspace without creating a Team Session.
RIED reports partial or stale results; it does not run recipes, project
scripts or services, or build a semantic index. See the
[runtime API](References.md#workflow-api) and
[planning guide](How-To-User-Guides.md#plan-work-and-answer-decisions).

## Coordination and recovery

One runtime owns the SQLite coordination database. It records TeamInstances,
Sessions, explicit Passes, optionally Pass-associated Tasks, ordered Steps,
assignment attempts, Task dependencies and gates, reports, whole-Pass reviews,
scoped approvals, and native bindings.
It is not a configuration database or transcript mirror.

A Pass can reference a Plan document through `planRef`. Completing a Task does
not require a separate reviewer. Completing a Pass requires its Tasks completed
and, where the team's review policy requires it, an accepted review of the current
whole-Pass revision. Task, Step, and report changes invalidate an earlier revision's
approval. The full team requires independent review; the minimal team permits
self-review without representing it as independent.
A completed Pass is final and cannot be reopened or mutated; create another
explicit Pass for later work. Starting a new Pass does not itself create a Plan
or Task.

Scheduled Pass Tasks have stable request IDs, optional assignees, dependency IDs,
named verification requirements, and exact approval scopes. Dependencies may
change only while pending and unassigned. Self, cyclic, and cross-Pass edges are
rejected. The scheduler serializes dispatch decisions per Session and permits
parallel work across members, with one active assignment per member. Routing
choices and assignments persist before native sends; temporary members still
require Main's explicit spawn.

A successful result completes a Task only when dependencies, required passed
verification entries with evidence, and exact user approvals hold. The runtime
validates the recorded structure and declared outcomes; it does not establish
whether an agent's technical conclusion is true. Failed prerequisites block
dependents. A linked correction followed by Main's explicit retry creates a new
attempt at the original Task. Identical duplicate requests, results, retries, and
review responses are idempotent; conflicting repeats fail.

One Pass-wide review starts when all execution Tasks finish. Requested changes
can lead to a correction and another attempt at that same gate. Independent
review uses a declared eligible reviewer; optional self-inspection under the
minimal Team is never recorded as independent review. Standalone Tasks and
planning assignments retain their manual status and assignment behavior.

Only the requested Session is initialized. Concurrent requests for that Session
share initialization, and a transient initialization failure can be retried.
Recovery reconciles saved bindings with native agents before dispatching work.
An uncertain external outcome is a blocker, not permission to resend an action.
A restart does not mint approvals or silently replace the selected team.

Coordination schema version 3 is a prototype breaking replacement. The runtime
creates its schema only in a new empty store and rejects incompatible
databases before modifying them. Preserve an old database and explicitly select a
fresh `runtime.database` under AppRC state. No conversion, compatibility layer or
chat-history import is performed. Native Pi/Paseo histories and authentication
remain separate from coordination state.

## Web services and diagnostics

Pi plans research and writes cited answers. pi-web-access searches only through
SearXNG and reads pages through HTTP or Crawl4AI. The selected routes do not
permit unconfigured hosted fallbacks or hidden answer/summary model calls.
Lookup and Explore are research instructions, not a separate state machine.

One Podman Compose project contains separate SearXNG and Crawl4AI services.
Prerequisites are prepared by explicit setup, never by status inspection or
directory entry. Cleanup targets LTCook's project, not shared Podman resources.

The Paseo status panel projects member names, Pass/Task titles, ordered Step
progress, assignment status, and issue counts. Tasks without a Pass are labelled
explicitly. Descriptions, acceptance text, reports, handoff content, and raw blocker
messages stay out of that projection; native UI remains the history authority.
Local logs and Perfetto traces correlate operations without recording secret
values or full prompts/transcripts by default. There is no observability server.
