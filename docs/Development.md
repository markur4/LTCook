# Development

[Documentation](README.md) · [Explanations](Explanations.md) · [How-to user guides](How-To-User-Guides.md) · [References](References.md) · [Examples](EXAMPLES.md)

Use [Contributing](../CONTRIBUTING.md) for shared repository rules, issue
reporting and backlog order, TODO's purpose, changelog writing, and the short
contribution quick start. Follow its links to the technical procedure relevant to
your task. This page owns detailed environment setup, project navigation,
packaging internals, verification limits, troubleshooting, and release procedures.

- [Work in the project](#work-in-the-project)
  - [Prototype workflow](#prototype-workflow)
  - [Maintainer environment](#maintainer-environment)
  - [Repository routing](#repository-routing)
  - [Workspace tool guidance](#workspace-tool-guidance)
  - [Shared personal skill discovery](#shared-personal-skill-discovery)
- [Document the project](#document-the-project)
  - [Documentation authoring](#documentation-authoring)
- [Verify and release](#verify-and-release)
  - [Verification](#verification)
  - [Operational diagnostics](#operational-diagnostics)
  - [Local Ollama and Agent Evals](#local-ollama-and-agent-evals)
    - [Tracker verification](#tracker-verification)
  - [Repository retrieval evaluation](#repository-retrieval-evaluation)
  - [Asset packaging](#asset-packaging)
  - [Integration and system procedures](#integration-and-system-procedures)
  - [Releases](#releases)

---

<br>

# Work in the project

## Prototype workflow

Develop and test instructions and skills in Codex first. Use ordinary Codex
chats in Paseo to check that the project and personal guidance, shared skills,
and LTCook workspace tools reach the agent together. Keep the policy in its
owning instructions or skill and use the fixed
[Pass and Task definitions](Explanations.md#domain-terminology). Pi is the
target for additional runtime enforcement after the policy is settled and the
behavior still needs enforcement. Existing Pi qualification and the
[verification commands](#verification) continue to apply.

Use one shared branch, worktree, and draft PR for each Pass that changes
LTCook. Review is a Task on that checkout. A denied integration action leaves
the integration Task and its dependents pending in the same Pass. Preserve the
checkout and report the denied action, the reason, and the relevant user
authorization. Leave the Pass open until the agreed integration succeeds.

For an ordinary Codex chat in Paseo, start with **Default Permissions** when
testing guidance with the user's command approval flow. That preset uses
`on-request`, `workspace-write`, and the `user` reviewer. LTCook's pinned
Paseo adapter defaults to **Auto-review** when the host Codex version supports
it (0.115.0 and newer). Auto-review keeps the same policy and sandbox, and
passes `approvalsReviewer: "auto_review"` to Codex app-server, overriding the
user's reviewer setting for that chat. Check the effective mode when diagnosing
a denial, including after resuming. [Pinned Paseo adapter](https://github.com/getpaseo/paseo/blob/23bae61535542a45ade7196a7b3c152705f16de3/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L8012-L8032)

The Codex command approval flow and the Team's code review Task have separate
criteria and authority. In Codex 0.171.0, the app-server entry point supplies
`vscode` as the thread source label even when Paseo launches it. Check the mode
and approval settings to identify which reviewer resolved a request.
[Codex app-server entry point](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/cli/src/main.rs#L1361-L1369) · [Instruction sources](Explanations.md#instruction-sources-in-codex-and-pi)

## Maintainer environment

Use Python 3.13+, Bun 1.4.4+, the Node version in `.node-version`, uv, and just.
The root [sync recipe](../justfile) is the supported locked full setup. Create the
checkout's virtual environment explicitly when selecting an interpreter:

```shell
uv venv --python 3.13 .venv
just sync
```

`just sync` creates the environment when it is absent. It runs `just build-assets`
to install Bun's frozen dependencies, build the TypeScript packages, and archive
the production assets. It then installs the locked Python application and
development groups into that same environment. `UV_PROJECT_ENVIRONMENT`
defaults to this checkout's `.venv`; set it explicitly for an isolated environment.
Directory entry does not create or activate a virtual environment.

Root `package-lock.json` is used by installed production deployment; `bun.lock`
locks JavaScript development, and `uv.lock` locks Python and authoring tools.
`just lock` also exports `pylock.toml`; this export does not replace `uv.lock`.
Set `BUN` to an absolute Bun executable path if it is not on PATH.

The restored scaffold recipes remain available alongside LTCook's runtime module:

| Commands | Purpose |
| --- | --- |
| `just sync`, `just install` | Prepare the complete locked, asset-aware development environment. |
| `just reset-venv`, `just py-switch VERSION` | Recreate the environment or select another Python interpreter, then run the full sync. |
| `just lock`, `just upgrade`, `just upgrade-repos`, `just uprep` | Intentionally update locks or Git-based dependencies; upgrades run the full sync afterward. |
| `just run -- COMMAND ...`, `just tree`, `just diagnose` | Run a command in the locked environment or inspect dependencies and interpreter state. |
| `just worktree-create BRANCH DESTINATION BASE`, `just worktree-remove DESTINATION` | Prepare a separate locked checkout or remove an eligible, merged checkout. |
| `just clean` | Remove project-local build artifacts and caches without deleting the environment or lockfiles. |
| `just clean-uv-cache` | Explicitly prune the globally shared uv cache. |
| `just format`, `just format-check` | Format authored TypeScript with Prettier and Python with Ruff, or check without rewriting. |

> [!WARNING]
> `reset-venv`, `py-switch`, and `clean` change local environment or cache state.
> Lock and upgrade recipes intentionally change dependency resolutions. These
> commands are not part of an ordinary verification loop.

Project registration is optional. `uv run ltcook workspace add ltcook . --yes`
initializes AppRC project settings when wanted; an existing unregistered directory
can also be launched without creating a marker.

For source-runtime development, use `just runtime dev` or `just runtime watch`.
Both recipes call `ltcook_dev.runtime`, which resolves AppRC for the selected
workspace before starting Bun against `runtime/src/main.ts`. The helper requires
`--root CHECKOUT`, accepts optional `--workspace WORKSPACE`, `--bun EXECUTABLE`,
and `--watch`, then forwards application arguments after `--`. The recipes set the
source root to the checkout; `LTCOOK_JS_ROOT` points there during development,
while installed launches resolve it to `<deployment>/app`. Put arguments for the
TypeScript entry after the recipe's `--`, for example `just runtime dev -- --help`.
The watch recipe enables Bun watch mode; these commands run source, not the
installed production bundle.

Root quick checks are `just runtime check`, `just runtime test`, `just check`,
and `just test`. `just runtime test` includes the in-memory runtime integration
contracts; these tests use fake agents and do not call models or require services.
Python integration/system tests remain separately selectable. See
[verification](#verification). A Python-only environment may be installed with
standard Python package tooling, but do not replace the committed locks for
normal project work. `uv` is the project's dependency manager, not a runtime
requirement imposed on users of the application.

## Repository routing

| Change | Location |
| --- | --- |
| Python application, configuration, CLI, launcher | `src/ltcook` |
| Authored installer/lifecycle and maintenance behavior | `src/ltcook_distr/payload/app_lifecycle` |
| Committed-source native builder | `src/ltcook_distr/build_native.py` |
| Developer packaging and asset-staging helpers | `src/ltcook_dev/packaging` |
| AppRC-aware TypeScript development launcher | `src/ltcook_dev/runtime.py` |
| TypeScript runtime, native integrations, panel | `runtime/src` |
| Bundled teams and Markdown resources | `teams/default`, `teams/default-minimal` |
| Compose definitions and templates | `services` |
| Traditional Tests, including tests of Agent Evals | `tests` |
| Checkout-only Agent Evals recipes and live runner | `evals` |
| Agent Evals implementation and bundled scenarios | `runtime/src/evals`, `runtime/resources/evals` |
| User and maintainer documentation | `docs` |

The Python application resolves settings through AppRC. Keep native component
translation in LTCook-owned paths and avoid a second hidden settings layer. The
TypeScript runtime owns coordination; team packages use its public Team API v3.
Runtime startup constructs the ColGREP provider and its indexing service,
Activity preferences, and the Session worktree store. The HTTP routes and workspace catalog use the same
instances. The HTTP listener starts before its native host and Core controller
are ready. Worktree reads and reports share Session and Pass scope resolution.
The Activity HTTP routes live in `runtime/src/integrations/runtime-activity.ts`.
The native tool routes, including the dedicated Session RIED operation, live in
`runtime/src/integrations/runtime-tool-routes.ts`. RuntimeApi authenticates the
caller and parses the request before delegating to these handlers.
Session open, prepare, list, snapshot, Team catalog, and command requests
use `runtime/src/integrations/runtime-session-routes.ts`. The
`session-activation.ts` service owns active workspace registration and pending
Session opens. Core owns the durable Sessions and native bindings.

The Pass scheduler in `runtime/src/core/pass-scheduler.ts` owns each
Session's scheduling queue and selects scheduled assignments. It delegates
native delivery to RuntimeController. The Session projection in
`runtime/src/core/session-snapshot.ts` uses the same dependency and approval
rules as the scheduler and controller, from `runtime/src/core/task-gates.ts`.

Native workspace preparation calls AppRC asynchronously from
`runtime/src/integrations/paseo.ts`. The preparation cache bounds reusable
workspace entries and checks recorded dependency fingerprints and generated
output hashes before reuse. The shared Python writer in
`src/ltcook/config/pi_config.py` serializes updates by canonical Pi home for
native, web, and CLI callers. For reusable installations, AppRC first discovers
the input paths, then resolves settings again after the helper captures their
file versions. The runtime verifies those versions and the generated outputs
before caching the result. An input change during preparation or a wait for the
writer lock makes the next request resolve configuration again.

Model alias policy and strict runtime validation live in
`runtime/src/models/aliases.ts`. The `@ltcook/model-contracts` workspace
owns the shared model fields, reasoning values, and catalog schema. Asset
staging includes the package and its compiled entry so the installed Paseo
plugin can resolve it. The plugin projects native model changes onto that
shared contract.

Purpose-named contracts live in `runtime/src/team-api`, `guidance-api` and
`workflow-api`. Core guidance lives in `runtime/resources`; imported bodies and
notices retain their provenance. Design/Plan Markdown lives in global AppRC state,
with coordination metadata and user decisions in SQLite.
The `src/ltcook_distr/bundle` destination is generated production input for the
wheel and installer, not general build debris. See
[asset packaging](#asset-packaging).

## Workspace tool guidance

Runtime tool names and capability checks live in `runtime/src/tools`.
Runtime startup supplies one catalog to the native HTTP and ordinary MCP
handlers. Core checks current Session bindings and Pass authority for managed
calls, and the MCP adapter checks ordinary workspace grants. The installed
Paseo plugin keeps its MCP server registration name within its copied source tree.

When adding a workspace tool or changing what agents should use it for, ship
concise agent-facing guidance with the registration. Explain when to choose the
tool, what evidence it returns, and what to do when the evidence is incomplete.
Use consistent guidance across supported harnesses. When a harness discovers MCP
tools on demand, put the tool name and its use case in the instructions the
agent sees before discovery.

For repository work, prefer `ltcook_repo_locate` with `trace` when a question
requires evidence across several files. Provide up to four independent leads
for different behaviors, known symbols, routes, or settings. For simpler
lookups, use Locate to find the definition, callers, or tests of a known symbol.
Batch independent symbols with `symbols`.
Open the surrounding block from a hit with `location`, or use `follow: true`
to check one local connection. Use ranked `ltcook_repo_search` when the
question describes behavior and the relevant symbol is unknown. Choose
`semantic` in Search, in a conceptual Locate query, or in a trace lead when
common words produce irrelevant keyword matches. Use native search for quick
literal checks. If ranked retrieval is unavailable or still indexing, report
the gap and use native search or direct file reads when they fit the requested
evidence.

Repository discovery filters belong to the runtime's shared repository
contract. Providers can push down equivalent path rules, and the runtime
checks canonical paths and verified source units before result selection.
Keep filters out of the published index identity and shared inventory cache.
Use the existing repository Traditional Tests and native workspace tool
fixtures to verify transports and provider behavior.

Check that a normal launch exposes the tool and delivers its guidance. Use the
existing [Repository Agent Behavior Evaluation](#repository-agent-behavior-evaluation)
when comparing tool selection and evidence quality. Compare time to verified
evidence and total turn time separately.

For web research, agents prefer `ltcook_web_search` and `ltcook_web_fetch` when
available and use `ltcook_web_content` to continue stored results. Search reports
engine issues as well as sources; agents should inspect source content and use
another available tool when evidence is incomplete or a capability is missing.
Core standing guidance and Paseo's agent instructions both carry this policy.

---

<br>

# Document the project

## Documentation authoring

Read the complete page before editing. Preserve the six docs pages' title, H1/H2,
and table-of-contents conventions; update useful incoming links and affected
navigation as part of the same change. Follow the
[documentation rules](README.md#documentation-rules) and source declarations.
Examples should not invent settings or commands and must not be described as
verified unless they were actually run.

Do not imply that a model conversation, local service, browser workflow, or native
platform has been exercised based only on source inspection. Explain real
prerequisites and keep normal checks independent of model calls and long-running
agent loops.

---

<br>

# Verify and release

## Verification

Traditional Tests include unit, integration, system, and browser tests. Browser tests
can also be system tests. Tests of Agent Evals belong to Traditional Tests; the
model-free Instruction Audit remains an Agent Eval. Agent Evals also include
Behavior Evaluation and Bottleneck Attribution. Scripted model responses and
model-backed runs describe how a particular test or Agent Eval operates.

Pi is the sole required agent harness for model-backed qualification across
LTCook. Traditional Tests cover the supported Codex adapters, including MCP
connectivity and permission enforcement. Optional Codex diagnostics have their
own results.

Use the root quick checks described in
[Contributing](../CONTRIBUTING.md#run-checks). `just check` performs Prettier and
TypeScript checks, Ruff formatting/lint checks, and Pyright; `just test` runs Bun
runtime/native/team contracts and Python tests excluding `integration` and
`system`. `just runtime test` is the focused runtime unit/native/integration subset.
`just build` is a packaging action, not a routine test.

Python tests use pytest-xdist with six workers by default. This is
repository policy: retain the dependency and six-worker default unless the user
explicitly approves changing them. An explicit `-n 0` can isolate a failing test
for diagnosis; it does not change the default. Small scheduling batches
(`--maxschedchunk=1`) keep the slow process-based checks distributed across
workers.

Run the full local Traditional Test suite before merging. Require model-backed
Agent Evals when the change affects behavior that needs model-backed
qualification, such as a recommended model, its prompt, or the way an agent
uses model output. Documentation and deterministic interface changes can be
verified with Traditional Tests and the relevant native checks.

A complete test-suite measurement includes Traditional Tests and model-backed
Agent Evals. Report elapsed time and outcomes for each category and their combined
total. For complete live coverage, use the full evaluation preset in
both Current and Synthetic setups. Run model-backed Agent Evals sequentially so
local model contention does not distort elapsed-time estimates. Ordinary CI runs
tests, including scripted checks of the evaluation machinery; model-backed Agent
Evals remain separately invoked.

Run local model inference on GPU for the full development Agent Evals suite.
Check actual GPU residency with `ollama ps` while the models are loaded. Run
explicit CPU benchmarks separately and report their timings independently of
the GPU suite. Use the hosted fallback below for routine Agent Evals when GPU
inference is unavailable or Bonsai exceeds its safeguard.

Prettier is pinned as a development-only JavaScript dependency. Its commands cover
authored runtime, team, and test TypeScript, excluding generated distributions.
Python formatting uses the existing Ruff configuration and generated-path
exclusions. Normal checks enforce both formats; `just format` applies them.


Planning/guidance checks use fake backends and native Pi RPC without model calls.
They cover trusted decisions, restart/uncertain delivery, native loading and
execution gates. Imported-text fidelity is checked separately from behavior;
installed resource paths must be verified independently of source paths.

For changed behavior, choose the narrow existing relevant test and report what
it establishes. Unit/contract tests do not prove native installer behavior,
service connectivity, or a live Pi model conversation. Integration tests require
an explicitly prepared environment. System checks may require service, network,
source archive, native OS, or installer prerequisites. Do not add an unbounded
model prompt loop to quick checks.

## Operational diagnostics

New or substantially changed operations should expose what ran, what happened,
and why the caller should act. Use existing Service status for current state and
shared Telemetry for durable events. Keep stable component and event codes.
Associate repeated evidence from a single operation with the same operation ID.
Distinguish a failed operation from an expected cancellation, a retry, a
temporary dependency blockage, and a deliberately injected test failure.

The runtime appends structured events to `LTCOOK_LOGS` and exports spans to
`LTCOOK_TRACES`. Each new record has a timestamp, event ID, code, component, and
severity. Operation events add an outcome and operation or correlation ID,
where applicable, plus a bounded explanation, sanitized cause, and context.
Installed runtime records identify the verified deployment fingerprint when
available. Other launches record the executing entrypoint digest. A build
fingerprint identifies bytes. Use build provenance to establish the source
revision before diagnosing source code.

Repository indexing records refresh failures and cancellations, writer
contention, a single stalled refresh, and successful publication or recovery.
A refresh that exceeds the indexing deadline reports a stall even when the
previous index generation remains usable. Correlate its later outcome by
operation ID. If the runtime cannot start, consult the existing deployment
`logs/backend.log` for launcher or captured owner-process output.

Treat diagnostic content as data. Exclude request bodies, prompts, credentials,
and unnecessary private context. Sanitize diagnostic records before storing
them and apply the receiving destination's rules before sending them to a
model or publishing a report. Use component health checks to verify the
affected behavior. Claim operational recovery only after exercising the
formerly failing behavior on the repaired running build.

See the [BugHunter diagnostics coverage assessment](bughunter-diagnostics/PLAN.md)
for the current inventory and known evidence gaps.

BugScan reads this diagnostic stream into the existing coordination database.
An explicit host-wide BugHunter setting enables the service and can name the
checkout to investigate. The service queues a hunt after three distinct failed
or degraded operations in a component within 30 minutes, an unexpected
critical failure, or a single indexing stall. It holds new background work
while a foreground agent is running. Open Activity → Services to manually run,
pause, or resume a hunt. The card shows the current
status, supported causes or hypotheses, remedies, and explicit immediate or
deferred architecture decisions. Native builds include the source revision in
their verified deployment assets. A clean checkout running the runtime directly
can also provide a source revision. BugScan looks up that commit in the
authorized repository and reads tracked content from its snapshot. Where
provenance is unavailable, it reports the gap and limits source conclusions.
Automatic model dispatch remains gated by model usage qualification.

Dev mode additionally supports eligible source fixes under a standing grant.
Use `ltcook services bughunter-authorization status` to inspect its current
scope and results. Use `grant --file` to supply a JSON scope with `targetBranch`,
`repairKinds`, `allowedPaths`, `actions`, and `maxModelRequests`.
`revoke` withdraws the grant. `prohibit --file` records an explicit restriction
using the applicable `targetBranch`, `repairKind`, `action`, and `path` fields.
`clear-prohibition --id` removes a specific restriction.

If the grant permits `issue.write`, use `publish-issue --file` to publish a
repository-policy-compliant issue for a confirmed actionable finding. The JSON
file supplies the finding `id` from status, a `title`, and the issue `body`.
BugHunter checks existing issues before creating one and keeps an uncertain
publication pending until it can reconcile the result.

The supported repair classes are `proper-fix` and `workaround`. Actions include
`worktree.create`, `source.edit`, `verify`, `git.commit`, `git.push`,
`pr.open`, `pr.merge`, `issue.write`, and `worktree.cleanup`. The native
agents use scoped worktrees. The runtime owns verification, Git operations,
and reconciliation. Dev mode and all consequential actions remain opt-in.
Automatic merges remain disabled for LTCook until the repository can enforce
the exact reviewed target at merge time. GitHub's matching-head option checks
the PR branch, and LTCook's target currently lacks branch protection. After
a human merges a reviewed repair, resume BugFix to reconcile its GitHub state.

For a managed repository indexing stall, recovery requires a fresh published
index generation in the affected workspace before the original progress limit,
a readiness check for that same generation, and build provenance matching the
integrated revision. This observation verifies the managed progress
deadline for that workspace. Findings that require a different workload or
failure condition remain pending until that behavior has its own probe. Read [the qualification plan](bughunter-qualification/PLAN.md)
for the acceptance cases and fixtures.

## Local Ollama and Agent Evals

Normal LTCook application setup detects a local Ollama installation or uses the
official platform installer when missing, then prepares
`ltcook-bonsai-2-27b-ctx65536:latest` (about 8.3 GB). This is separate from `just sync`,
editable registration, tests, and CI. Setup records readiness
under AppRC ownership and reuses a healthy user-managed service. It does not bind
Ollama beyond loopback or stop a user-owned service.

Ollama's [Linux installer](https://docs.ollama.com/linux) may require `sudo`;
the [Windows installer](https://docs.ollama.com/windows) is user-scoped; the
[macOS application](https://docs.ollama.com/macos) requires a GUI install/consent
handoff. Model storage stays under Ollama's own platform-specific location.
Windows and macOS installation behavior requires verification on those platforms.

Agent Evals uses the shared installed CLI and Paseo run service. Static audit
needs no model. Team Behavior Evaluation and semantic Instruction Audit use the
prepared local Bonsai model `ltcook-bonsai-2-27b-ctx65536:latest`. Evaluation
runs use models that are already available.
If the configured model is missing, setup uses `bonsai-2:27b` to create it with
`num_ctx` set to 65,536, pulling the base tag if needed. Once the configured model
exists, setup and `ltcook app doctor` work with that tag alone.
The run checks the saved model configuration; use `ollama ps` while it is loaded
to inspect the context and GPU allocation actually provided by Ollama. Previous
model setup receipts need the normal setup or repair flow to prepare Bonsai.

```shell
ltcook eval audit --static-only
ltcook eval run --setup current
ltcook eval run --quick --setup synthetic
ltcook eval run --setup synthetic --case read-only
ltcook eval run --setup synthetic --repetitions 2
ltcook eval run --all --setup synthetic
ltcook eval analyze --setup synthetic
```

The `just eval` recipes are shortcuts to these commands. Current Setup resolves
installed guidance and relevant workspace state; Synthetic Setup uses packaged
fixtures. Linux/WSL execution requires working Bubblewrap. Preserve network
configuration while confining filesystem writes to disposable workspace and run
state. Native Windows/macOS behavioral execution is unsupported until an
appropriate sandbox is implemented; do not launch Windows executables from WSL.

For Current Setup, the Paseo panel uses the selected Leader's Team. The CLI uses
an explicitly exported `LTCOOK_TEAM` when present, including when reusing a
runtime. Otherwise it uses the configured runtime Team and reports when the
workspace has Sessions from multiple Teams. Only non-secret evaluation settings
needed for Current Setup cross the authenticated local API.

Reports, progress events and Perfetto traces live in runtime state under
`evals/runs`, with prompts, transcripts, and credentials excluded. Instruction
Audit records production loader provenance; semantic findings require review.
Routine `eval run` performs Behavior Evaluation with full instructions in the
selected setup. It runs the mandatory core summarization evaluations and the
read-only, no-op and targeted-fix agent cases once each.
`--case` selects one case, and `--repetitions N` explicitly repeats the selected
agent cases. The default is one repetition. `eval run --all` adds Instruction
Audit and full summarization qualification.
When the categories run together, semantic audit uses the prompt already
captured during Behavior Evaluation rather than launching another agent task.

Use hosted GPT-6 Luna for routine model-backed Agent Evals whenever the
evaluation host has no usable GPU or Bonsai exhausts its safeguard. Default
to high reasoning and use a case's specified hosted reasoning level when
it has one. Run every arm of a matched comparison with the same model and
reasoning, and report the selection. Explicitly local and CPU-only candidate
comparisons keep their assigned models and inference settings.

The built-in native agent cases in `ltcook eval run` require local Bonsai.
On a host without a usable GPU, use an authorized equivalent hosted route
when available and leave the case pending otherwise. For the Renamer's
workspace title instruction, `bun evals/renamer.ts` runs one synthetic case
through hosted `@tiny` with GPT-6 Luna at low reasoning.

### Summarization qualification

The core evaluates fixed, focus-specific facts for status, negation, migration
failures, ownership, corrections, and text that contains instructions. Full
qualification adds a coding-session handoff, a file/inline comparison, and
three attempts each for the near-limit case and selected high-risk cases.
All attempts count toward qualification. Native Pi must return `HOLD` for a
declined rollout and `PROCEED` for an approved rollout. A failed decision
triggers the reviewed correct-summary control for that case.
Repetitions expose instability on the selected cases. Traditional Tests cover
deterministic evidence validation, file access, and Ollama failures.

Run `ltcook eval run --all --setup synthetic --case summarization` for changes
to the recommended summarizer, its prompt, generation settings, or preparation
of input. The report identifies local models by their resolved tags and
digests. It includes a code fingerprint, hashes for
the fixtures and prompts, effective settings, individual results, fixed-fixture
summaries and quotations, latency, and token counts when available. Concision
and readability are separate from the required-fact verdict.
When an LFM3 comparison uses its built-in profile and retries without reasoning, the report identifies
the initial reasoning attempt and includes both requests in the token totals.

The engine fingerprints its runtime bundle at startup. Source checkouts
fingerprint the evaluation and summarizer source files and the Bun lockfile
at engine creation.

Set the global AppRC model and generation options before starting the evaluation
runtime to compare a candidate. Leave both settings unset to qualify the
current default. The initial LFM3 baseline used
the LFM3 tag (set `LTCOOK_MODEL_TINY_LOCAL=lfm3:1.7b-q8_0` to reproduce it) with this generation value.

```shell
export LTCOOK_SUMMARIZER_GENERATION='{"think":false,"stream":false,"options":{"temperature":0.1,"num_ctx":4096,"num_predict":128}}'
```

The near-limit attempts raise the output budget to 4,096 tokens or half the
configured context, whichever is smaller, while preserving any higher
configured budget. Other attempts use the configured generation settings.
The fixture fills the input allowance left after reserving output and prompt
space. The report records the effective near-limit budget and fixture hash.
Historical runs used their configured output budget for all fixtures. See the
[first full LFM3 baseline](../evals/summarization-baseline.md).

Add `--summarization-grader gpt-6-luna` to opt into hosted OpenAI grading and
downstream decisions at high reasoning. The report identifies the hosted
provider, model, and reasoning setting. The opt-in also works with the source
runner, `bun evals/evaluation-live.ts synthetic full STATE_DIRECTORY --case summarization --summarization-grader gpt-6-luna`.
It uses the signed-in Codex CLI on PATH for both grading and rollout decisions.
Codex receives only fixed fixture inputs and candidate summaries from LTCook.
This option is an exploratory comparison with the required Pi evaluation path.

Each run checks the selected grader against development and held-out fixtures with fixed
expected judgments. Keep the held-out cases separate when refining the grading prompt.
Calibration requires the grader to flag the expected claims and cite their wording.
Evidence validation checks each required fact against its supplied quotation.
For ticket IDs explicitly marked in the fixture, qualification accepts a Unicode
hyphen or nonbreaking hyphen in place of the ASCII hyphen. Other exact values,
including paths and machine identifiers, retain exact matching.
Summary citations can span line wrapping, typographic spacing, and Markdown
formatting such as lists, emphasis, and inline code. The report retains the
exact excerpt as it appeared in the candidate summary.
Critical disagreements can be adjudicated manually against the fixed source and
candidate. An unavailable, uncalibrated, or self-grading model blocks semantic
checks while deterministic checks continue. A changed summarizer identity blocks
attribution of its outputs to the candidate. A confirmed failure takes precedence
over a blocker. Qualification passes only when every required check passes.

The quick preset and focused runs for other agent cases provide partial coverage.
The qualification verdict belongs to the summarization report, independently
of whether the runner completed. Existing elapsed-time history and fallback for
the three agent cases still use their original attempts.

<a id="session-memory-qualification"></a>

### Tracker verification

Use the existing Traditional Test suite for deterministic history, AAB
recording, attachment handling, authorization, delegation, and concurrent
inference. The focused tests for Tracker exercise manual edits and deletions,
rewind, restart, pause gaps, input-budget outcomes, and independently valid
changes across Trackers.

Run the Hosted Decision Tracker suite through the shared Agent Evals CLI.
Use the offline command for request-budget, persistence, evidence, and
recovery checks. The baseline adds Hosted tracking, Instruction Audit,
and independently calibrated semantic grading through Pi. It requires
Codex subscription sign-in and the built Pi runtime for the native timeline
fixture.

```shell
ltcook eval run --case decision-tracker --setup synthetic --deterministic-only
ltcook eval run --all --case decision-tracker --baseline
```

Synthetic Setup uses a pinned Hosted profile and annotated conversations.
Current Setup uses the running LTCook instance's Hosted Tracker model,
reasoning, and input budget against the same fixture data. Each case uses
a disposable conversation-products database so the evaluation can read
persisted Notebook state without touching any real conversation.

The baseline runs the two setups in sequence under one 20-minute deadline,
including calibration. `--retry-blocked` permits one additional run within
that same deadline. The report shows deterministic and semantic verdicts,
prepared evidence, request estimates and provider usage, item and revision
checks, and coverage and recovery gaps. `ltcook eval report RUN_ID --json`
returns the checkpointed case details. A confirmed failure remains
`FAILED` when later checks are `BLOCKED`. The evaluation-only baseline is
expected to expose the current budget stall while the Traditional Test
that verifies detection passes.

See the [Hosted Decision Tracker baseline](../evals/decision-tracker-baseline.md)
for the measured results and the next runtime changes to investigate.

The fresh `conversation-records-v1.sqlite` holds deterministic receipts and
AABs. `conversation-products-v1.sqlite` holds Tracker state. Both
are in runtime state. Preserve native Paseo history and the separate
`pasted-documents` store. The application starts these databases fresh and
ignores the old Session Memory records.

### Opt-in summarization utility comparison

Run `bun evals/summarization-benchmark-live.ts` from a synced checkout with the
local Ollama models available. The comparison runs two fresh native Pi sessions
on the same fixed coding handoff with the same downstream Bonsai model and
generation settings. The first opens the source with Pi's `read` tool. The
second calls `ltcook_summarize` with its path and focus and can read the source
for supporting passages. Pi invokes the shared summarizer implementation
directly, so recorded time covers the tools and inference in this checkout.
Each session can execute up to four tool calls before it is asked to answer.
The report records when this budget is reached and retains rejected requests.

The JSON report gives per-field correctness, ordered tool calls, actual
summarizer invocation and usage, total elapsed time, and provider token usage
across Pi turns. Pi's normalized cache fields use zero when the provider omits
the split. Treat a zero cache count accordingly. Both sessions have fresh
histories and identical source files. Ollama's runtime cache stays in place
and the baseline runs first. This comparison is descriptive and runs only on
request, outside CI and qualification.

Bottleneck Attribution reports timings from those same executions and their
Perfetto traces. `eval analyze` starts one set of full-instruction cases by
default, or uses its explicit `--case` and `--repetitions` selections. It does
not run reduced-instruction variants. One execution is enough for an elapsed-time
estimate; overlapping trace categories must not be added into another total.

Keep diagnosis focused: start Synthetic Setup with `--case read-only`, then
verify no-op and targeted-fix individually. Each case starts with reasoning off
and may fall back once to low reasoning on the same pinned Bonsai model. A case
that fails its fallback stops the run before later cases or repetitions. Each
attempt uses an independent workspace, requests copy-on-write copies where
supported, and releases disposable state after its diagnostics are preserved.

Pi's existing context compaction remains enabled for the pinned 65,536-token
model, reserving 4,096 tokens and keeping 1,024 recent tokens. Summary calls use
the same isolated model and provider state. Diagnostics record compaction timing,
reported usage and failures, while excluding summary text.
Pi sends the full instructions using the `system` message role supported by the
Ollama provider, with `supportsDeveloperRole: false` in its isolated model state.
Execution and compaction requests explicitly send `max_tokens: 4096`, the field
accepted by Ollama. The isolated model's sampling override retains that output
cap while Pi uses its existing compaction and overflow handling. The configured
context does not guarantee that every input fits.
A failed summary aborts that disposable agent turn and ends its attempt. A later
model request cannot clear the failure and repeat compaction until the safeguard;
the run still permits only its single configured low-reasoning fallback.

The Leader scheduling handoff names the native `ltcook_team` operations and
required fields. Scheduled execution reports use `report.create` with an explicit
success or failure outcome; the runtime owns scheduled Task status. Command
validation selects errors by command type, so unrelated Task fields do not hide
invalid report fields.
Evaluation requests encode coordination command names and Pass requirements in
forms Ollama retains; Pi and the runtime still validate the original schema. If
the Leader finishes and reports the scheduling handoff without registering any
scheduled Task, the case fails with that reason instead of waiting for its time
limit.
Tool counts and the existing tool budget include rejected validation attempts,
counted once per attempt even when a provider reuses call IDs. Provider diagnostics retain HTTP status,
reported stop reasons, usage and sanitized stream errors; ordinary content chunks
are ignored. Stream text and response headers are not saved.
The OpenAI client can intercept errors before Pi's stream hook receives them;
these metadata hooks do not establish that every provider error was observed.

Evaluation agents retain full standing guidance and receive an appended execution
scope only after the authenticated runtime confirms their disposable Session and
running Pass. This clarification describes the predefined scenario's existing
authorization; it does not approve a Plan or change normal sessions. The effective
prompt hash and timing provenance include this clarification. Failed confirmation
is reported as a runtime failure. If the runtime API is unreachable, Pi's hook
error and the existing safeguard provide the remaining diagnostics and limit.
On restart, supported run records retain sanitized checkpoints while leftover
temporary execution folders are removed. Cleanup failures remain visible in the
run's limitations and are retried on the next restart; unsupported histories stay
unchanged.

Agent Evals safeguards use three times the slowest of the five most recent
comparable successful attempts. Reasoning modes have separate histories, and
model, fixture, setup, instruction/tool configuration and verified inference
hardware must match. Failed or cancelled attempts do not increase the safeguard.
With no compatible successful history, the report identifies the 120-second
bootstrap safeguard. Reports show the reference runs, expected duration,
calculated safeguard, actual duration, and saved failure diagnostics. Timing
history and partial results belong to runtime state, not a separate database.

Run records use schema 3. Unsupported older histories remain unchanged and are
not read as current results. Preserve them if needed, stop the runtime, remove
its `evals/runs` directory, and restart to reset history. Tests of the evaluation
machinery use scripted responses without Ollama or user login; model-backed Agent Evals remain
explicitly invoked outside ordinary CI.

## Repository retrieval evaluation

Run the checkout benchmark with Bun, Git, and `rg` on the trusted `PATH`.
Pass `--colgrep` explicitly to include hybrid retrieval using the installed
`LTCOOK_COLGREP_DEPLOYMENT` assets. The command builds disposable indexes and
uses no agent sessions, LLM grading, or external service.

```shell
bun evals/repository-retrieval-live.ts --k 5 > retrieval-ripgrep.json
bun evals/repository-retrieval-live.ts --k 5 --colgrep > retrieval-comparison.json
```

Each provider searches its own copy of the TypeScript and Python fixtures and
selected LTCook files read from the checkout's committed `HEAD`. Identifier
queries use case-sensitive whole-word ripgrep. Conceptual questions run through
the whole-question literal control, a keyword baseline, and ColGREP hybrid when
requested. The keyword baseline takes distinct words from the question alone,
scans up to 100 matching lines, and ranks them by keyword overlap. ColGREP
receives the original question. Each arm returns the same top-K budget.

Each question lists its labeled locations, returned paths and line ranges,
independently checked excerpt validity, coverage, and diagnostics. A match
covers a label when the verified excerpt contains its labeled range. The report
groups scores by question category, code language, and question language.
Additional valid hits count as nonrelevant to the labels. For negatives, the
report counts both irrelevant hits and searches that completed with no hits.
An intentionally limited case demonstrates truncation. Edit, rename, and delete
scenarios reuse each provider's search state. Traditional Tests inject stale
and malformed evidence to cover failures during index updates.

The ColGREP arm measures the initial build separately from its first query
and warm retrieval. It measures cache bytes before and after each refresh
and samples the peak while the candidate is being built. A new provider also
checks that a simulated change to the live device identity reuses the same
published generation. Filesystem caches remain in place. Each result records
serialized bytes and elapsed time. Save the JSON
to compare per-question outcomes across runs using the recorded source revision,
corpus, labels, implementation hash, and provider versions. Invalid evidence,
an unavailable or indexing response, or a failed standalone index build
yields exit status 1. Truncation and quality scores are reported separately.
Use the [initial baseline](../evals/repository-retrieval-baseline.md) as a
historical reference.

### Repository Agent Behavior Evaluation

Run the paired comparison through native Pi with `rg` on `PATH`, loopback
Ollama running, and `LTCOOK_COLGREP_DEPLOYMENT` pointing to installed assets.
The runner uses the installed LTCook Bonsai model by default. Pass
`--model MODEL` to select another installed Ollama model for both arms.

```shell
bun evals/repository-behavior-live.ts > pi-repository-behavior.json
```

Both arms receive identical task prompts. One has Search and the other has
Search and Locate. They use a warmed disposable index and repeat a selected
pair in the opposite order. A separate pair tests the response to deliberately
unavailable retrieval for a question with a known answer. The answer schema
ties each fact to citations. Use `--case CASE_ID` to rerun a case's scheduled
pairs, such as `--case absent-concept` for the negative.
The Pi runner requests the final answer when a single-call turn repeats a
search with no new evidence or when two consecutive calls are unavailable.
It waits for all parallel replies and continues if a sibling returns usable
evidence. It records native tool attempts and errors, including
requests rejected before provider execution. The 16-call safeguard applies
to those attempts. If Pi sends another tool request after stopping or returns
an invalid answer format, the runner records one tools-disabled answer retry.
Factual and citation grading still applies.
The report separates factual correctness, evidence validity, retrieval
coverage, and tool selection. It records tool calls, repeated or low-yield
requests, context size, and elapsed times. Time to the first verified citation
measures when returned evidence first supports a correct citation in the
final answer. This field is `null` when no citation qualifies. Compare paired
correctness before timing. Live runs are opt-in. Normal CI type-checks the
runner and tests the deterministic graders.

For multi-file traversal, run the opt-in real-repository cases from a committed
checkout. The runner archives the revision and keeps the evaluation labels
outside the agent's source corpus. It runs each Search-only and Locate pair in
both orders. Available cases are `workspace-grant`, `paste-projection`, and
`runtime-log-owner`.

```shell
bun evals/repository-behavior-live.ts --traversal
bun evals/repository-behavior-live.ts --codex --traversal --case paste-projection
```

The report measures time to the first verified citation, time by which the
last required range was returned, total turn time, and rendered tool-response
bytes. The last measure is a proxy for tool context. These are isolated
Search-only and Locate comparisons. To measure ordinary Codex CLI against
Paseo, give both the same committed tree, model, reasoning, and shell access.
Alternate run order and score citations before comparing elapsed times.
Include a Paseo run with retrieval disabled to measure the tool's contribution.

For a spot check of natural stopping, the native Paseo fixture can also send
three questions to an installed loopback Ollama model. It starts ordinary Pi
sessions with built-in tools disabled so the cases exercise workspace MCP. The
cases cover citations to adjacent source lines, a successful empty search, and
missing ColGREP assets. The fixture records the model's outcome, evidence
grade, and tool calls without steering or retrying the answer. The fixture's
scripted summarizer rejects live requests. Run the check with the checkout's
native test prerequisites and the selected model already installed.

```shell
bun run build
fixture=$(mktemp -d)
env -i HOME="$fixture" PATH="$PATH" PI_OFFLINE=1 DO_NOT_TRACK=1 \
  LTCOOK_COLGREP_DEPLOYMENT="$LTCOOK_COLGREP_DEPLOYMENT" \
  LTCOOK_NATIVE_PI_MODEL=qwen3.5:4b-q8_0 \
  bun tests/runtime/system/paseo-workspace-mcp.ts "$fixture"
```

The existing scripted native checks still gate transport correctness. The
optional live observations are descriptive. Choosing a model here applies only
to these evaluation turns.

#### Optional Codex diagnostics

With the Codex CLI authenticated, use `--codex` to run the two-case guided
smoke. Add `--compare-locate` for the six-run guided comparison or
`--autonomous` for the same paired schedule as Pi. The paired Codex modes
default to `gpt-6.2-sol`. Pass `--model MODEL` to select another Codex model.

```shell
bun evals/repository-behavior-live.ts --codex > codex-repository-smoke.json
bun evals/repository-behavior-live.ts --codex --compare-locate > codex-locate-comparison.json
bun evals/repository-behavior-live.ts --codex --autonomous > codex-autonomous.json
```

The harness grants the read-only Codex sessions access to its disposable
fixture through isolated local MCP. All recorded verdicts and evidence
metadata refer to that fixture. Reports exclude credentials and raw responses.

See the [Repository Intelligence evaluation report](../evals/repository-intelligence-report.md)
for the measured results and coverage gaps.

## Asset packaging

`src/ltcook_dev/packaging/package_assets.py` builds the canonical
`src/ltcook_distr/bundle.zip` from validated production outputs. It contains the
compiled runtime and all three public entry points, Core rules/skills/references,
Pi/Paseo plugins, the patched Paseo web UI, built teams/resources, services, production
manifests/lock and Node selection, but no development dependencies.
`BuildPy` validates and copies that archive; initialization extracts it into
private staging while preparing the deployment.

`just sync`, `just build`, and AppRC editable updates call `just build-assets`
to create the archive. `just build` also builds the wheel and sdist. The ZIP is
required because AppRC's snapshot cleanup removes every
new generated `dist` directory, including nested staged package assets.

The pinned source patch and builder live in [paseo-patches](../paseo-patches/README.md).
Run `bun run build:paseo-web` before the packaged Paseo browser acceptance.
The runtime serves those assets through Paseo's web UI distribution option.

`just build-native` uses the exact committed tree and `uv.lock`, builds assets
inside its private export and calls the SDK snapshot/native APIs. It emits
`dist/ltcook-setup-linux-x86_64` and `dist/SHA256SUMS`, with intermediates under
ignored `.cache/apprc/`. Native compilation requires uv >=0.11.6 and Rust/LLVM;
the SDK accepts supported newer uv versions as well.
Editable registration uses the existing checkout `.venv` and needs no Rust.

Explicit registration/setup prepares private Node and configured service
prerequisites without starting Compose. Local mode validates Podman; a receipt
alone is not proof of readiness. Missing service secrets are persisted only
at explicit runtime/service starts after Ready. Inspection does not provision
software or initialize those secrets.

## Integration and system procedures

`just test-integration` runs the marked Python integration tests and Bun runtime
integration tests; `just runtime test-integration` runs the Bun runtime
integration tests alone. The standard `just test` already includes those
in-memory runtime contracts. `just test-system` runs the marked Python system
tests and the required Linux clockwork acceptance. That acceptance starts
isolated real Pi and Paseo processes against a local scripted OpenAI-compatible
endpoint with fake credentials. It covers approved delegation, a real local
verification command, failure/correction, restart, independent review, and Pass
completion without model downloads or external services. Hosted CI runs this
acceptance and the native Paseo GUI acceptance on release candidates, stable tags
that need extended checks, and manual dispatches. Other slow installer and
service scenarios retain their separate prerequisites.

Native package smoke requires a built setup from an explicit immutable commit
and normal download/toolchain prerequisites. Run only the selected maintained
system test; its isolated direct-service mode does not prove local Podman health.
Live local
service verification additionally requires a usable Podman engine, Compose
provider, configured credentials, and the actual Compose assets. Live research
requires reachable services and a working model provider. Browser verification
requires the separately installed browser executable and browser files.

Linux-only release automation does not establish native Windows/macOS behavior,
live web research, or model-backed workflows. Native platform checks need the
respective native environment; do not launch Windows verification executables
from WSL.

## Releases

Hosted CI runs the Linux Python 3.13 source checks on pull requests and pushes
to `main`. A new commit cancels stale CI for the same PR or ref. Routine CI
checks the Bun workspaces and runs the quick Python suite directly from source.
Release candidates add Python 3.14, package builds, and offline native
acceptance. Stable tags run the same extended checks unless a same-version
ancestor release candidate passed its tag CI with identical source and
dependencies. An equivalent stable promotion still runs the source checks.
Manual CI dispatch runs extended checks and the separate integration, system,
macOS, and Windows jobs.

The committed `RELEASE_REQUIRE_CI` setting controls the hosted CI gate.
With its default value `false`, the release command relies on successful local
tests and artifact verification. Report hosted CI separately from local results
before merging or releasing. A beta tag selects the CI profile and skips the
test jobs with this setting. Set it to `true` to run the source checks on beta
tags and require successful hosted CI on the exact release tag and commit.
`RELEASE_PYPI` is independently set to `false`, so publication goes to GitHub.

Follow the [changelog-writing rules](../CONTRIBUTING.md#changelog) when preparing
release notes. Use `b2` or `rc2` when a fix needs another preview. Move the
release entries out of `[Unreleased]` before running `just release-prepare`.

```shell
just release-check
just release-prepare 0.2.0
just release-push v0.2.0
```

`release-check` runs the source checks on Python 3.13 and verifies the built
wheel and source archive. `release-prepare` accepts an explicit version or
`patch`, `minor`, and `major`. It validates the prepared notes, updates project
metadata and locks, and creates an annotated local tag on the version commit.

`release-push` runs the local checks, builds the committed Linux setup, and
smoke-tests the staged installer. It uses its embedded binding and checksum to
verify the app, distribution, command, version, and source commit. The command
caches the verified bundle under `.cache/apprc/releases/`, pushes `main` and
the tag together, and publishes the matching GitHub Release. Run it again to
retry the checked bundle. `just release VERSION` combines preparation and
publication. Pushing the release commit and tag and publishing the release
require explicit release authorization. An approved Pass authorizes its normal
reviewed PR merge under the repository's execution permissions.

GitHub marks beta and RC builds as prereleases. Publishing keeps the newest
published beta and the newest published release candidate across target
versions. Retention removes older releases and downloads in the published
channel. Git tags and all stable releases stay available.
The published-release workflow verifies and starts the uploaded Linux setup.
The manual workflow remains available for building downloadable GitHub Actions
artifacts. Native Windows and macOS behavior requires checks on those platforms.


## Shared personal skill discovery

The launch helper resolves the original user's `~/.agents/skills` as the internal
`LTCOOK_SHARED_SKILLS_DIR` environment input before Paseo changes native `HOME`.
Native guidance adds this optional source to Pi and reports its resources as User
guidance. Core/Team requirements, native project trust, explicit-only invocation,
physical-path deduplication and conflicting-name errors remain authoritative.
Current Setup snapshots shared skill files under `shared-skills` and uses that
snapshot for Instruction Audit and execution. Synthetic Setup uses an empty
shared source, and reduced instructions exclude all non-Core guidance. Existing
credential and symlink snapshot exclusions apply to the added source too.
