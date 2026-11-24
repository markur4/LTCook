# Changelog

All notable changes to `ltcook` will be documented in this file.

> [!IMPORTANT]
> ## Rules
> This changelog follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and
> [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0/).
>
> Keep one cumulative section per target version. Start with `## [X.Y.Z] - YYYY-MM-DD (b1)`,
> update the date, entries, and marker for `rc1`, and remove the marker for
> stable. The notes describe what ships since the previous stable version.
> Link the section to that stable tag once one exists. Include only stable
> `X.Y.0` releases in the table of contents.
>
> Keep all six category headings under `[Unreleased]` and empty them before a
> release. Omit empty categories from versioned sections. Preserve the emojis
> and layout markers. Prefix breaking entries with `**Breaking:** 💥` in the
> applicable category. Describe the final shipped behavior under Added for a
> new feature. Use Fixed for defects in previously released behavior.



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

## [Unreleased]

<br>

### ✨ Added

- RIED provides bounded directory maps, targeted source outlines, richer
  repository metadata, and live Git details with optional local base comparison.
  RIED responses include provider provenance, freshness, and structured diagnostics.

- Workspace-scoped repository search in Pi using ripgrep and ColGREP,
  with a pinned LateOn-Code-edge model and lazy local indexing. Repository search verifies
  excerpts against current files and reports unavailable, partial, stale, and
  truncated retrieval separately.

- Repository Core includes a standalone ripgrep provider for bounded lexical
  scans and a labeled retrieval benchmark with opt-in ColGREP comparison.

- Pi can use `ltcook_repo_locate` to find verified implementation,
  caller, and test candidates with bounded follow-up search.

- Shared SearXNG search, URL retrieval, and stored-result tools for managed
  Pi and workspace Pi and Codex chats in Paseo. Local searches wait for SearXNG
  to become ready during startup. Search returns structured source links and
  per-query outcomes. Broken and duplicate links are removed before ranking
  limits apply. Search reports engine failures and can retry using remaining
  enabled engines. Fetch can find and cite passages in one call.

- Explicit GitHub Release workflow for beta, release candidate, and stable
  versions. Release preparation uses cumulative changelog notes. Publishing
  stages and verifies Linux assets locally, with a separately configurable
  hosted CI gate.

- Shared model aliases for Teams, Paseo, and the native Pi and Codex launcher.
  Paseo saves the effective model and reasoning with each new conversation.
  The summarizer uses Spark X2.6 4B Q8_0 with reasoning off. Pull Spark
  explicitly when needed.

- Behavior Evaluation includes mandatory core summarization evaluations with
  independent Bonsai grading. The CLI and Paseo diagnostics show the
  qualification verdict and provide a focused full qualification run.
  Full qualification covers both rollout decisions, a coding handoff, and
  three near-limit attempts. An opt-in Pi utility comparison reports the
  cost and correctness of reading directly and using a summary. Focused
  summarization runs can opt into GPT-6 Luna with high reasoning for grading
  and rollout decisions. Near-limit attempts reserve additional output within
  the configured context, and grader calibration checks contextual paraphrases
  and exact citations.

- Add workspace inventory and local Ollama summarization over authenticated MCP
  for ordinary Pi and Codex chats in Paseo.

- Display the Graffiti Jam artwork in the README and use LTCook icons for new
  AppRC shortcuts on Linux and Windows and for Windows Installed apps.

- Added 🚀 `ltcook serve` as a no-argument alias for bare `ltcook`; both start
  or reuse the desktop runtime, open Paseo, and follow backend logs.

- Native agents discover the real user's shared `~/.agents/skills` directory even when LTCook gives them a private HOME. Required Core/Team guidance, project trust, explicit-only skills and conflict checks remain active. Current evaluation snapshots include shared skills; synthetic setups remain isolated from the live user library.

- Added a native LTCook Paseo provider with per-Session Team selection, direct
  Leader chat, a local Teams browser, native child conversations, and contextual
  Team/Tasks panels. Multiple Teams share one runtime, including Sessions in the
  same Workspace. Paseo packages use the matching composer-capable published beta.

- Python tests use pytest-xdist with six workers by default. Complete test-suite timing includes Traditional Tests and model-backed Agent Evals, reported separately and together.

- Agent Evals supports Current Setup and Synthetic Setup selection in the CLI and Paseo panel, a model-free `eval audit --static-only`, full-instruction Behavior Evaluation by default, `--case` selection, and `--repetitions` defaulting to one. Bottleneck Attribution uses the same executions and traces; `eval run --all` also performs Instruction Audit. Failed cases stop after their low-reasoning fallback, with saved partial results and safeguard history.
  Evaluation attempts use independent copy-on-write workspace copies where supported, release disposable state between attempts, and avoid duplicate runtime-state polling.
  Local inference uses Bonsai 2 27B with a 65,536-token context; existing installations need the normal setup or repair flow to prepare the new model.
  Setup only needs the base Bonsai tag to create the configured tag. App doctor
  checks readiness using the configured tag and its context size.
  Pi context compaction uses the same pinned local model; sanitized diagnostics and traces include summary-call timing, usage and failures.
  Agents receive an authenticated disposable execution-scope clarification alongside full instructions, using the system role. Restart removes temporary execution state for supported run records and reports cleanup failures.
  Evaluation output caps use Ollama's supported `max_tokens` field, including compaction. Leader handoffs explain native scheduling operations, and command validation reports errors for the selected command type.
  Rejected tool attempts count toward the existing budget; sanitized provider metadata preserves stream failures without saving stream text or headers.
  Failed context summaries end the attempt instead of repeating compaction until timeout.
  Current Setup retains explicit shell overrides when starting or reusing a runtime.

<br>
- Added normal-install Ollama/Bonsai provisioning and opt-in local Agent Evals with private Perfetto-compatible traces and safeguards derived from comparable successful runs.
- Added runtime dispatch of eligible approved Pass Tasks, persisted dependencies,
  verification and user approval gates, same-member serialization, correction and
  explicit retry, restart delivery handling, and one current-revision Pass review.
- Added required Linux real Pi/Paseo system acceptance using a scripted local
  endpoint, plus Agent Evals for read-only, no-op, and targeted
  fixes. These Agent Evals use Bonsai 2 27B with thinking off, retry failed behavior
  cases once at low thinking, and record total task time, provider usage,
  tool/delegation counts, and action candidates.
- Added Core/Team/Project/User guidance with required standing Core rules, native
  progressive skills, source diagnostics and `ltcook guidance inspect`.
- Added Team-routed Plan prefill/finalization, Team-authored timestamped Markdown,
  persisted topic coverage and mandatory user decisions, authenticated native
  dialogs and explicit `ltcook planning` CLI operations.
- Added approval-before-execution tool gates, pending-decision recovery and
  runtime-owned RIED discovery with one AppRC cache and separately refreshed Git
  state. RIED identifies WSL in its summary and host inventory.
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
  and unowned extensions, one shared TypeBox command schema, and focused package
  validation used by the installer builder and release tooling. Authenticated
  runtime requests stay on loopback and reject redirects.
- Restored Buildben scaffold development recipes with checkout-local uv
  environments and LTCook's asset-aware setup. `just clean` removes project-local
  artifacts; `just clean-uv-cache` explicitly prunes the shared uv cache.
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

### 🛠️ Changed

<br>

- Pi is the required harness for model-backed Agent Evals. Repository Behavior
  Evaluation defaults to Pi, with an explicit option for Codex diagnostics.
  The Pi comparison records early stops for repeated searches and unavailable
  retrieval.

- **Breaking:** 💥 Set `LTCOOK_MODEL_TINY_LOCAL` in place of
  `LTCOOK_SUMMARIZER_MODEL`. `@plan` now shares the smart model slot, so
  remove `LTCOOK_MODEL_PLAN`. Use plain `provider/model` settings and put
  explicit reasoning in the Team or session. Start a new LTCook conversation
  for existing Paseo profile records that predate saved alias selections.

- `ltcook app update` rebuilds runtime assets before refreshing an editable
  installation. Checkouts using an older updater need one manual asset build
  and editable registration to pick up the new update path.

- **Breaking:** 💥 LTCook now uses AppRC 0.39.1rc1 (commit `26aa61`).
  `app uninstall --keep-config` replaces `--keep-data` and retains the
  configuration directory, including settings and secrets. Uninstall removes
  appdata, cache, and state even when configuration is retained. Review
  `app uninstall --dry-run` for selected paths.
  Editable repositories remain unless `--remove-repository` selects them.
  Replace `ltcook diagnose --json` with `ltcook app doctor --verbose --json`.
  Lifecycle hooks are declared only in `pyproject.toml`; cleanup stops the
  owned Compose project before AppRC removes managed directories.

- **Breaking:** 💥 Team API v3 uses `leaderKey` and the canonical `leader` member.
  Custom Teams must replace coordinator/Main identities and declare API v3.
  Coordination schema 4 rejects older stores unchanged: stop the runtime,
  preserve the old database, and select a new empty `runtime.database`. No
  migration or automatic deletion is provided. See PR #5.

- **Breaking:** 💥 Agent Evals uses run-record schema 3 with saved repetitions, timing history and partial diagnostics, and requires Bubblewrap for Linux/WSL execution. Existing evaluation histories are unsupported and left unchanged. Users can preserve old results, stop the runtime, remove its `evals/runs` directory, and restart to reset history. See PR #2.

<br>
- **Breaking:** 💥 personal clear-writing, TypeScript, React/Vite, reader-load and Modes planning guidance are no longer bundled by Core. Affected: installations relying on those defaults or the `ltcook-typescript`, `ltcook-react-vite` and `ltcook-reader-load` names. Migration: supply personal rules and native skill directories under the configured User guidance root; use the shared OMP skill names when using the chezmoi configuration. Core planning operations, approval gates, lookup and explore remain available without personal guidance.

- **Breaking:** 💥 IBB is renamed to Agent Evals. Affected: CLI users and developers
  using `ltcook ibb`, `just ibb`, `LTCOOK_IBB_RESULTS`, or IBB runtime/cache paths.
  Migration: use `ltcook eval`, `just eval`, `LTCOOK_EVAL_RESULTS`, and the new
  `evals` paths. Existing generated cache files and the old Ollama receipt are
  left untouched; rerun the supported LTCook setup/repair flow to write the new
  `eval_model` receipt field. No aliases, readers, or automatic data migration
  are provided.

- **Breaking:** 💥 Coordination schema 4 adds scheduled Task graphs, gates and assignment
  attempts. Affected: users with older prototype coordination stores and custom
  command consumers. Migration: preserve the old store, select a new empty
  `runtime.database`, and adopt the extended Task/result/retry contracts. No
  database conversion or automatic uncertain-action replay is provided.
- **Breaking:** 💥 RIED replaces the Python project-context scanner and its JSON
  format. Affected: callers of `ltcook.project_context`, `LTCOOK_PROJECT_CACHE_DIR`
  and Team API v2 `WorkContext.projectContext`. Migration: use the authenticated
  `ltcook_ried` tool or `/v1/ried` API and discard old cache files; no reader or
  conversion is provided.
- **Breaking:** 💥 Team packages require API v3 and the purpose-named `team-api`,
  `guidance-api` and `workflow-api` imports. The generic `api` export and activation
  hooks are removed. Custom Teams must implement the new declarations; no adapter
  or automatic rewrite is supplied.
- **Breaking:** 💥 Execution requires a registered, approved Plan and active Pass. Runtime
  coordination uses a new schema and defaults to `<AppRC state>/runtime/coordination.sqlite`.
  Existing prototype databases are rejected unchanged; select a new empty store
  while preserving old files. No database conversion is provided.

- **Breaking:** 💥 The `ltcook version` command is replaced with the eager root option
  `ltcook --version` (alias `ltcook -V`). Affected: users and scripts invoking
  the former subcommand. Migration: use `ltcook --version` or `ltcook -V`;
  version output exits before AppRC runtime preparation.
- **Breaking:** 💥 Opening a project with unset `LTCOOK_SESSION` now starts a new chat
  instead of selecting a workspace-derived Session. To resume, set `LTCOOK_SESSION`
  to an existing saved identifier; current-schema IDs and native bindings remain stable on restart.
- **Breaking:** 💥 Team command consumers must create Passes explicitly, handle optional
  `Task.passId`, and submit `review.create` with `passId` instead of `reportId`.
  Review now gates the current whole-Pass revision. Teams must remove
  `workflows.register` calls and use `TeamDefinition` as the policy authority.
- **Breaking:** 💥 Python callers must import `ltcook.config.pi_config` instead of
  `ltcook.config.native`. The unused `ltcook.utils` scaffold exports are removed.
- **Breaking:** 💥 Pi agents now use a shared user-level authentication home instead of
  credentials stored in each workspace Pi home. Users with workspace-only logins
  must run `ltcook auth login PROVIDER` once, or set user-level `runtime.pi_auth_dir` to
  an existing Pi auth home. Project settings and conversation histories stay
  separate; credentials are not copied automatically.
- **Breaking:** 💥 Bare `ltcook` now starts or attaches to the runtime instead of printing
  help. Scripts requiring help must use `ltcook --help`; headless foreground users
  should retain `ltcook launch runtime`.
- **Breaking:** 💥 Maintenance commands move to `ltcook app ...`. Use `config setup`
  and replace the optional terminal `ltcook launcher` with bare `ltcook` for
  Paseo or `app doctor|paths|repair`.
  Retire schema-2 installations with matching old tools and remove their
  LTCook-owned resources before registering the checkout with
  `uv run --locked ltcook app install -e`. Follow the
  [clean reinstall guide](docs/How-To-User-Guides.md#install-from-a-checkout).
- **Breaking:** 💥 Native distribution authors now build a committed-source Linux setup
  with `just build-native`, rather than generated shell/Python installers or
  adjacent-wheel PyApp bundles. Release staging requires schema-2 native manifests;
  regenerate legacy manifests and assets from the intended immutable source commit.
- Missing service secrets are generated only at explicit runtime/service starts
  after installation is Ready, serialized across simultaneous starts; inspection
  and authentication checks remain read-only.

- Updated the locked AppRC Git revision to include the central host-first,
  colored help renderer, preserving the CLI presentation after dependency sync.

### 🗑️ Deprecated

<br>

### 🔥 Removed

<br>

### 🐛 Fixed

- Repository Search and Locate show explicit line numbers in agent-facing
  excerpts so adjacent source lines can be cited precisely. Structured results
  retain their existing path, range, and excerpt fields.

<br>
- Summarization qualification accepts typographic hyphens for designated ticket
  IDs and retains the original quoted evidence.
- Agent Evals preserves coordination command labels and execution Pass guidance
  when Ollama renders tool schemas, and reports a finished scheduling handoff
  with no registered work without waiting for the time limit.
- Fixed missing `ltcook_ried` in standalone LTCook Pi chats; native Pi workspace
  changes now rebind inventory while reusing the existing scanner and AppRC cache.


### 🔒 Security

<br>

---

<br>

