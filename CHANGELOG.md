# Changelog

All notable changes to `ltcook` will be documented in this file.

> [!IMPORTANT]
> ## Rules
> 1) Do not remove or change this header and TOC without very good reason. 
> 1) When bumping version, move the sub-sections from `[Unreleased]` to
>    the new version -section. Remove empty sub-sections under released
>    versions. Provide a new `[Unreleased]` section at the top of the
>    changelog with all sections empty (don't remove those).
> 1) Do not remove emojis and use `<br>` and `---`.
> 1) Changelog entries must describe the final net difference from the
>    previous released version. Do not list intermediate pre-release
>    names, helper shapes, fixes, or refactors that were overwritten
>    before release.
> 1) Use `🔨 Fixed` only for defects in previously released behavior.
>    For new features, describe the final shipped behavior under `➕
>    Added`, even if the implementation went through pre-release fixes.



<br>

---

<br>

## Table Of Contents

1. [Changelog](#changelog)
   1. [Table Of Contents](#table-of-contents)
2. [\[Unreleased\]](#unreleased)

<br>

---

<br>

<!-- ======================================================== -->

# [Unreleased]

<br>

### 💥 Breaking changes

- Breaking: Agent Evals uses run-record schema 3 with saved repetitions, timing history and partial diagnostics, and requires Bubblewrap for Linux/WSL execution. Existing evaluation histories are unsupported and left unchanged. Users can preserve old results, stop the runtime, remove its `evals/runs` directory, and restart to reset history. See PR #2.

<br>
- Breaking: personal clear-writing, TypeScript, React/Vite, reader-load and Modes planning guidance are no longer bundled by Core. Affected: installations relying on those defaults or the `ltcook-typescript`, `ltcook-react-vite` and `ltcook-reader-load` names. Migration: supply personal rules and native skill directories under the configured User guidance root; use the shared OMP skill names when using the chezmoi configuration. Core planning operations, approval gates, lookup and explore remain available without personal guidance.

- Breaking: IBB is renamed to Agent Evals. Affected: CLI users and developers
  using `ltcook ibb`, `just ibb`, `LTCOOK_IBB_RESULTS`, or IBB runtime/cache paths.
  Migration: use `ltcook eval`, `just eval`, `LTCOOK_EVAL_RESULTS`, and the new
  `evals` paths. Existing generated cache files and the old Ollama receipt are
  left untouched; rerun the supported LTCook setup/repair flow to write the new
  `eval_model` receipt field. No aliases, readers, or automatic data migration
  are provided.

- Breaking: Coordination schema 3 adds scheduled Task graphs, gates and assignment
  attempts. Affected: users with older prototype coordination stores and custom
  command consumers. Migration: preserve the old store, select a new empty
  `runtime.database`, and adopt the extended Task/result/retry contracts. No
  database conversion or automatic uncertain-action replay is provided.
- Breaking: RIED replaces the Python project-context scanner and its JSON
  format. Affected: callers of `ltcook.project_context`, `LTCOOK_PROJECT_CACHE_DIR`
  and Team API v2 `WorkContext.projectContext`. Migration: use the authenticated
  `ltcook_ried` tool or `/v1/ried` API and discard old cache files; no reader or
  conversion is provided.
- Breaking: Team packages require API v2 and the purpose-named `team-api`,
  `guidance-api` and `workflow-api` imports. The generic `api` export and activation
  hooks are removed. Custom Teams must implement the new declarations; no adapter
  or automatic rewrite is supplied.
- Breaking: Execution requires a registered, approved Plan and active Pass. Runtime
  coordination uses a new schema and defaults to `<AppRC state>/runtime/coordination.sqlite`.
  Existing prototype databases are rejected unchanged; select a new empty store
  while preserving old files. No database conversion is provided.

- Breaking: The `ltcook version` command is replaced with the eager root option
  `ltcook --version` (alias `ltcook -V`). Affected: users and scripts invoking
  the former subcommand. Migration: use `ltcook --version` or `ltcook -V`;
  version output exits before AppRC runtime preparation.
- Breaking: Opening a project with unset `LTCOOK_SESSION` now starts a new chat
  instead of selecting a workspace-derived Session. To resume, set `LTCOOK_SESSION`
  to an existing saved identifier; current-schema IDs and native bindings remain stable on restart.
- Breaking: Team command consumers must create Passes explicitly, handle optional
  `Task.passId`, and submit `review.create` with `passId` instead of `reportId`.
  Review now gates the current whole-Pass revision. Teams must remove
  `workflows.register` calls and use `TeamDefinition` as the policy authority.
- Breaking: Python callers must import `ltcook.config.pi_config` instead of
  `ltcook.config.native`. The unused `ltcook.utils` scaffold exports are removed.
- Breaking: Pi agents now use a shared user-level authentication home instead of
  credentials stored in each workspace Pi home. Users with workspace-only logins
  must run `ltcook auth login PROVIDER` once, or set user-level `runtime.pi_auth_dir` to
  an existing Pi auth home. Project settings and conversation histories stay
  separate; credentials are not copied automatically.
- Breaking: Bare `ltcook` now starts or attaches to the runtime instead of printing
  help. Scripts requiring help must use `ltcook --help`; headless foreground users
  should retain `ltcook launch runtime`.
- Breaking: LTCook now requires the pinned unreleased AppRC cutover. Maintenance
  commands move to `ltcook app ...`; use `config setup`, and replace the optional
  terminal `ltcook launcher` with bare `ltcook` for Paseo or `app doctor|paths|repair`.
  Retire schema-2 installations with matching old tools before registering the
  checkout with `uv run --locked ltcook app install -e`; retain all user resources.
- Breaking: Native distribution authors now build a committed-source Linux setup
  with `just build-native`, rather than generated shell/Python installers or
  adjacent-wheel PyApp bundles. Release staging requires schema-2 native manifests;
  regenerate legacy manifests and assets from the intended immutable source commit.
- Missing service secrets are generated only at explicit runtime/service starts
  after installation is Ready, serialized across simultaneous starts; inspection
  and authentication checks remain read-only.

### ➕ Added

- Symbolic Python tests use pytest-xdist with six workers by default. Complete test-suite timing includes symbolic tests and live agent evaluations, reported separately and together.

- Agent Evals supports Current Setup and Synthetic Setup selection in the CLI and Paseo panel, a model-free `eval audit --static-only`, full-instruction Behavior Evaluation by default, `--case` selection, and `--repetitions` defaulting to one. Bottleneck Attribution uses the same executions and traces; `eval run --all` also performs Instruction Audit. Failed cases stop after their low-reasoning fallback, with saved partial results and safeguard history.
  Evaluation attempts use independent copy-on-write workspace copies where supported, release disposable state between attempts, and avoid duplicate runtime-state polling.
  Pi context compaction uses the same pinned local model; sanitized diagnostics and traces include summary-call timing, usage and failures.
  Agents receive an authenticated disposable execution-scope clarification alongside full instructions, using the Spark-supported system role. Restart removes temporary execution state for supported run records and reports cleanup failures.
  Evaluation output caps use Ollama's supported `max_tokens` field, including compaction. Coordinator handoffs explain native scheduling operations, and command validation reports errors for the selected command type.
  Rejected tool attempts count toward the existing budget; sanitized provider metadata preserves stream failures without saving stream text or headers.
  Failed context summaries end the attempt instead of repeating compaction until timeout.

<br>
- Added normal-install Ollama/Spark provisioning and opt-in local Agent Evals with private Perfetto-compatible traces and safeguards derived from comparable successful runs.
- Added runtime dispatch of eligible approved Pass Tasks, persisted dependencies,
  verification and user approval gates, same-member serialization, correction and
  explicit retry, restart delivery handling, and one current-revision Pass review.
- Added required Linux real Pi/Paseo system acceptance using a scripted local
  endpoint, plus local Pi guidance benchmarks for read-only, no-op, and targeted
  fixes. Benchmarks use Spark-X2.6-4B Q8 with thinking off, retry failed behavior
  cases once at low thinking, and record total task time, provider usage,
  tool/delegation counts, and action candidates.
- Added Core/Team/Project/User guidance with required standing Core rules, native
  progressive skills, source diagnostics and `ltcook guidance inspect`.
- Added Team-routed Plan prefill/finalization, Team-authored timestamped Markdown,
  persisted topic coverage and mandatory user decisions, authenticated native
  dialogs and explicit `ltcook planning` CLI operations.
- Added approval-before-execution tool gates, pending-decision recovery and
  runtime-owned RIED discovery with one AppRC cache and separately refreshed Git state.
- Added verbatim Modes and Clear Writing guidance plus shared research and optional
  domain skills with source provenance and notices.

- Initialized a separate `ltcook` application from Buildben, preserving the
  existing `lcook` application and its data.
- Added a Bun development workspace and packaged Node runtime using Pi agents
  and Paseo's native chat and plugin interfaces.
- Added interchangeable default and two-agent teams, versioned SQLite coordination,
  distinct workspace TeamInstances and chat Sessions, explicit Passes, standalone
  Tasks, ordered Steps, whole-Pass review, scoped commands, and lazy restart
  recovery without LCook compatibility code.
- Added AppRC-managed settings, private dependency preparation and scoped
  installation, service and cleanup helpers, including editable checkout
  installation from staged runtime assets.
- Added pinned SearXNG/Crawl4AI Compose configuration, optional research tools,
  redacted local diagnostics and fast isolated behavior checks. Runtime launches
  omit an empty `CONTAINER_CONNECTION` so local Podman does not enter remote mode;
  configured connection names remain available.
- Added themed, responsive Team Overview, Task Board and Agent Focus views in
  Paseo, with named Passes, ordered Step progress, native conversation links and
  selected task/handoff/blocker details. Bulk status excludes private work text.
- Added exact LTCook-owned Pi extension reconciliation with preserved independent
  extensions, one shared TypeBox command schema, and focused package validation
  used by the installer builder and release tooling.
- Restored Buildben scaffold development recipes with checkout-local uv
  environments and LTCook's asset-aware setup. Release recipes retain asset-only
  behavior and disabled PyPI publication.
- Added pinned Prettier development formatting and Ruff format checks for authored
  source, with generated AppRC assets excluded and marked generated.
- Added idle server/UI startup without a selected project, optional AppRC project
  configuration, and explicit project Session activation from the Paseo panel.
- Added native Pi login/logout/readiness commands and a supported SDK/RPC launcher
  sharing Pi-managed authentication without merging project configuration or
  conversations.
- Added one-command desktop startup with Windows-host browser opening from WSL,
  detached runtime ownership, cross-terminal backend logs, and authenticated
  `ltcook stop`. Ctrl+C detaches desktop logs without stopping the shared server.
- Added concise terminal logs with severity colors and source labels. Normal
  output omits routine upstream diagnostics and bulky metadata; `ltcook --verbose`
  includes diagnostic context and error stacks. Raw diagnostic files remain
  unchanged, and redirected output stays uncolored.

### 💔 Changed

<br>
- Updated the locked AppRC Git revision to include the central host-first,
  colored help renderer, preserving the CLI presentation after dependency sync.

### ⚠️ Deprecated

<br>

### 🗑️ Removed

<br>

### 🔨 Fixed

<br>
- Fixed missing `ltcook_ried` in standalone LTCook Pi chats; native Pi workspace
  changes now rebind inventory while reusing the existing scanner and AppRC cache.


### 🔒 Security

<br>

---

<br>

