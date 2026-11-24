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
  - [Context-aware Session Memory](#context-aware-session-memory)
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

OpenAI authorization comes from the existing Codex sign-in. For other providers,
`runtime.pi_auth_dir` (`LTCOOK_PI_AUTH_DIR`) defaults to native Pi's
`~/.pi/agent`. Project runtimes share that directory's `auth.json` through
Pi's SDK. Workspace models, settings, and conversations stay project-local.

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

The application uses AppRC core and terminal packages from the same pinned Git
commit. The local `dev` group supplies authoring and verification tools; it is
not required by the installed application. Runtime and team JavaScript packages
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
API. A user explicitly opens a project from the terminal or submits the native
**+ → LTCook → Team** composer. The Paseo-created agent is adopted as the
Leader, and supporting Pi agents use its native parent relationship. Selecting
a directory or viewing the Team panel alone does not create agents.

## Pi authentication

`ltcook auth login`, `logout`, and `check` delegate OpenAI account management
to Codex. Managed Pi reads request authorization over the Codex app-server's
local stdio protocol and sends it only to the official provider endpoint.
Codex owns credential storage and refresh. The ChatGPT sign-in is used by
`openai-codex` models, and a Codex-managed Platform API key is used by
`openai` models. The credential stays in memory for each request.

For other providers, these commands run Pi's native authentication CLI.
Paseo creates Pi's `ModelRuntime` with a shared `authPath` and a workspace-local
`modelsPath`. Pi owns credential refresh and cross-process locking for those
providers. Project services use the workspace `PI_CODING_AGENT_DIR`, while the
shared auth home stays outside LTCook's removable application resources.

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
| Discussion | A conversation between a user and an agent within a Session. |
| User>Agent Message Pair (UAMP) | A user message and its corresponding completed agent response. Native steering messages are additional sources. |
| Agent Action (AA) | An operation performed by an agent and recorded as an Action by native Pi or Paseo history. |
| Agent Action Batch (AAB) | Related AAs grouped for summarization. Known Plan, Pass, Task, and Step identifiers apply to the AAB. |
| Request | The native initiating message for work; a Task may reference its native message identifier. |
| Plan | A document specifying intended work and integration strategy. LTCook references it rather than storing a second plan history. |
| Pass | An explicitly created integration unit with a title and an optional Plan reference. |
| Task | An owned piece of work, optionally associated with a Pass; standalone Tasks do not create a Pass. |
| Step | Persisted, ordered progress within a Task. |
| Action | A tool call, message, or other action recorded by native Pi/Paseo history, not a second LTCook transcript. |
| Goal | A completion criterion spanning Passes and potentially multiple Sessions. |
| Phase | A classification of a Task or commit, not an independent scheduling engine. |

Chat, Design, and Plan are interaction activities. A Plan can also identify work
in the Plan → Pass → Task → Step → Action execution hierarchy. A Session may
start a Plan directly, and AAs can occur outside a Plan. Optional PPTSA
identifiers remain absent when no corresponding work record exists.

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

Each team exports `apiVersion: 3`, `definition` and optionally `selectAssignee`
through the [public Team API](../runtime/src/team-api/index.ts).
The host loads the selected package and uses its definition, not fixed role
names or a fixed member count.

The [default team](../teams/default) declares six persistent members and four
explicitly temporary specialist variants. The
[minimal team](../teams/default-minimal) declares exactly Leader and Adjutant.
Leader performs absent specialists' work in the minimal team; self-inspection is
not labelled an independent review. Team selection stays fixed for each Session; multiple Teams can share one runtime.

## Guidance and planning

Core supplies required functional planning guidance and research methods. Personal writing, coding preferences and detailed Modes strategy come from User guidance. Teams add member responsibilities
and methods; Projects retain native repository instructions and skills; Users add
global personal guidance. Rules enter applicable standing context. Native Pi
advertises skill descriptions and reads bodies/references when needed. Required
Core guidance and execution guards cannot be disabled by optional resource flags.
The [guidance inspector](References.md#guidance-api) reports sources, applicability,
conflicts and actual loading rather than assuming that discovered means loaded.

Core owns the planning sequence: Adjutant prefills, Leader investigates and finalizes,
then the user approves. Teams declare eligible members, default routes and an
optional selection hook. The hook receives work context and eligible members; it
cannot answer user questions, approve execution or operate a second scheduler.
Leader registers execution Tasks; the runtime schedules eligible work after Leader
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

### Repository Core and RIED

Repository Core is the internal, harness-independent subsystem in
`runtime/src/repository`. Runtime and MCP adapters establish workspace identity
and read permissions. Core opens that trusted workspace, resolves relative
paths, and rejects links and traversal for targeted discovery. Every
`RepositoryResult<T>` names its provider and records capture time, freshness,
partial results, truncation, and structured diagnostics next to the value.

RIED composes the `brief`, Git, and Just providers with host tool availability.
It caches repository metadata in AppRC and samples Git on summary and Git
requests. Session activation warms metadata in the background. Summaries
return a small briefing. Directory maps and source outlines run on demand.
`brief` reads a bounded staging directory of regular workspace files so its
own filesystem probes cannot follow workspace links. Detected developer
commands remain inventory data.

Managed Pi conversations and ordinary Pi or Codex chats share the discovery
service through their existing native or MCP adapters. Source outlines require
trusted file-read access. ColGREP remains a separate retrieval provider with its
own authorization and index lifecycle. The shared workspace and observation
types give providers a common boundary for future composition. See the
[RIED tool contract](References.md#repository-inventory).

Repository Core's ColGREP provider searches code locally with a managed
LateOn-Code-edge model and ONNX Runtime. The repository search tool forwards
authorized ranked requests to that provider. It builds and updates an index on demand under the AppRC
cache, with separate storage for each canonical workspace identity. ColGREP
uses its native file discovery and ignore rules. The process runs on the host
with LTCook's filesystem access.

Repository Core verifies each candidate against its current workspace file
before returning an excerpt. A hit names a workspace-relative path and a
one-based, inclusive line range. Core checks either the provider's best-match
range or its enclosing unit range and returns the one that contains the exact
excerpt. It omits invalid candidates and retains verified hits in provider
order. The check reads regular UTF-8 files up to 2 MiB and compares text with
normalized CRLF line endings. A verified excerpt can be clipped after
verification. It reflects the source at the time of the check.

Source evidence and retrieval freshness answer different questions. ColGREP
can rank against a cached index even when every returned excerpt matches the
current file. A missing file or a source mismatch marks retrieval stale.
Verification cannot detect relevant source that the index omitted entirely.
See the [repository search response](References.md#repository-inventory).

Repository Core also provides an independent ripgrep scan through
`createRipgrepProvider().search(workspace, request, signal)`. `exact` matches a
case-sensitive whole word, `literal` matches a case-sensitive substring, and
`regex` uses ripgrep's default regex engine. Requests can select literal
workspace paths and set a limit of 1 to 100 matching lines in Core. The provider reuses
`rg` from the trusted executable path, uses ripgrep's hidden-file and
repository ignore rules during traversal, and has no index. `kind: "exhaustive"`
describes the bounded scan. A complete response has neither `partial` nor
`truncated` set. The provider is callable from Repository Core and used by the
[retrieval benchmark](Development.md#repository-retrieval-evaluation).

Standalone Pi uses its native workspace, Team Pi uses its bound Session, and
ordinary Paseo Pi and Codex use their authenticated launch workspace. For both
Paseo harnesses, that workspace authorizes LTCook's bounded repository search,
source outlines, and file summarization. LTCook binds the connection to the
canonical workspace and applies each tool's path checks. Native editors and
shells use the harness's own permissions and any Team execution rules.

LTCook setup prepares the optional ColGREP assets. Indexing starts on the first
ranked search.

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
require Leader's explicit spawn.

A successful result completes a Task only when dependencies, required passed
verification entries with evidence, and exact user approvals hold. The runtime
validates the recorded structure and declared outcomes; it does not establish
whether an agent's technical conclusion is true. Failed prerequisites block
dependents. A linked correction followed by Leader's explicit retry creates a new
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

Coordination schema version 4 is a prototype breaking replacement. The runtime
creates its schema only in a new empty store and rejects incompatible
databases before modifying them. Select a fresh `runtime.database` under AppRC
state when starting a new store. No conversion, compatibility layer or
chat-history import is performed. Native Pi/Paseo histories and authentication
remain separate from coordination state.

## Context-aware Session Memory

The runtime summarizes completed UAMPs and groups observed AAs at execution
boundaries and an estimated token threshold. Native user messages remain the
authority for goals and decisions. Original user messages stay available while
summarization is pending, after compaction, and when agents resume work or share
authorized context. Each summary cites its native source sequences, including
which sequences are original user instructions.

An opt-in delegation handoff can include explicit, named check outcomes
from original tool results. LTCook searches the original conversation for
requested paths and technical identifiers even when a summary already mentions
them. It can include the cited evidence within the same handoff budget.

Immediate Context supplies the current Task objective and acceptance criteria
when Core knows them. For an AAB it also supplies the initiating user
instructions or runtime assignment and applicable steering. This material is
separate from the current original messages and serves as instructions.
One recent relevant completed UAMP provides background for references.
A previous summary cannot establish that an Action occurred or a decision
was accepted in the current unit.

The selection follows chronology within the known Task scope. Where Task
identity is absent, matching Session, Plan, and Pass scope is used when
available. Immediate Context aims for about 256 to 512 additional estimated
tokens. Authoritative instructions can exceed that target, and the available
space for previous summary text shrinks to protect current sources.
All completed summaries stay in chronological storage. Retrieval can select
individual recognized field statements and cite the original sequences used
by their summary portion. Malformed formatting retains a raw-text fallback.

Rewind invalidates affected summaries and receipts that were tied to the
replaced history. The runtime rebuilds from authorized original messages.
Paseo still owns the original conversation and the native lifecycle metadata.

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
