# Development

[Documentation](README.md) · [Explanations](Explanations.md) · [How-to user guides](How-To-User-Guides.md) · [References](References.md) · [Examples](EXAMPLES.md)

Read [Contributing](../CONTRIBUTING.md) for shared conventions, the normal setup,
quick checks, and submission expectations. This page covers the deeper project
layout, packaging boundary, verification limits, and current release workflow.

- [Work in the project](#work-in-the-project)
  - [Maintainer environment](#maintainer-environment)
  - [Repository routing](#repository-routing)
  - [Shared personal skill discovery](#shared-personal-skill-discovery)
- [Document the project](#document-the-project)
  - [Documentation authoring](#documentation-authoring)
- [Verify and release](#verify-and-release)
  - [Verification](#verification)
  - [Local Ollama and Agent Evals](#local-ollama-and-agent-evals)
  - [Asset packaging](#asset-packaging)
  - [Integration and system procedures](#integration-and-system-procedures)
  - [Releases](#releases)

---

<br>

# Work in the project

## Maintainer environment

Use Python 3.12+, Bun 1.4.4+, the Node version in `.node-version`, uv, and just.
The root [sync recipe](../justfile) is the supported locked full setup. Create the
checkout's virtual environment explicitly when selecting an interpreter:

```shell
uv venv --python 3.12 .venv
just sync
```

`just sync` also creates the environment when it is absent. It installs Bun's
frozen `bun.lock`, builds the TypeScript packages, installs locked Python
development groups without the project, stages production assets, then installs
the Python application into that same environment. `UV_PROJECT_ENVIRONMENT`
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
Purpose-named contracts live in `runtime/src/team-api`, `guidance-api` and
`workflow-api`. Core guidance lives in `runtime/resources`; imported bodies and
notices retain their provenance. Design/Plan Markdown lives in global AppRC state,
with coordination metadata and user decisions in SQLite.
The `src/ltcook_distr/bundle` destination is generated production input for the
wheel and installer, not general build debris. See
[asset packaging](#asset-packaging).

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

A complete test-suite measurement includes Traditional Tests and model-backed
Agent Evals. Report elapsed time and outcomes for each category and their combined
total. For complete live coverage, use the full evaluation preset in
both Current and Synthetic setups. Run model-backed Agent Evals sequentially so
local model contention does not distort elapsed-time estimates. Ordinary CI runs
tests, including scripted checks of the evaluation machinery; model-backed Agent
Evals remain separately invoked.

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
needs no model; LLM-dependent runs require the prepared local Bonsai model
`ltcook-bonsai-2-27b-ctx65536:latest` and do not install or pull models.
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
of input. The report identifies the configured model and Bonsai grader by
their resolved tags and digests. It includes a code fingerprint, hashes for
the fixtures and prompts, effective settings, individual results, fixed-fixture
summaries and quotations, latency, and token counts when available. Concision
and readability are separate from the required-fact verdict.

The engine fingerprints its runtime bundle at startup. Source checkouts
fingerprint the evaluation and summarizer source files and the Bun lockfile
at engine creation.

Set the global AppRC model and generation options before starting the evaluation
runtime to compare a candidate. Leave both settings unset to qualify the
current default. To reproduce the initial LFM3 baseline, use
`LTCOOK_SUMMARIZER_MODEL=lfm3:1.7b-q8_0` and the following generation value.

```shell
export LTCOOK_SUMMARIZER_GENERATION='{"think":false,"stream":false,"options":{"temperature":0.1,"num_ctx":4096,"num_predict":128}}'
```

The near-limit fixture measures the effective tool budget for the configured
context and focus. Compare runs with different context settings using that budget
and the recorded fixture hash. See the [first full LFM3 baseline](../evals/summarization-baseline.md).

Each run checks Bonsai against development and held-out fixtures with fixed
expected judgments. Keep the held-out cases separate when refining the grading prompt.
Calibration requires Bonsai to flag the expected claims and cite their wording.
Evidence validation checks each required fact against its supplied quotation.
Summary citations can span line wrapping, typographic spacing, and Markdown
formatting such as lists, bold text, and inline code. The report retains the
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

### Opt-in summarization utility comparison

Run `bun evals/summarization-benchmark-live.ts` from a synced checkout with the
local Ollama models available. The comparison runs two fresh native Pi sessions
on the same fixed coding handoff with the same downstream Bonsai model and
generation settings. The first opens the source with Pi's `read` tool. The
second calls `ltcook_summarize` with its path and focus and can read the source
for supporting passages. Pi invokes the shared summarizer implementation
directly, so recorded time covers the tools and inference in this checkout.
After four tool calls, each session loses access to tools for subsequent turns
so it can return an answer. The report records when this budget is reached.

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

## Asset packaging

`src/ltcook_dev/packaging/package_assets.py` builds the canonical
`src/ltcook_distr/bundle.zip` from validated production outputs. It contains the
compiled runtime and all three public entry points, Core rules/skills/references,
Pi/Paseo plugins, built teams/resources, services, production
manifests/lock and Node selection, but no development dependencies.
`BuildPy` validates and copies that archive; initialization extracts it into
private staging while preparing the deployment.

`just sync` and `just build` create the archive; the latter also builds wheel
and sdist. The ZIP is required because AppRC's snapshot cleanup removes every
new generated `dist` directory, including nested staged package assets.

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
completion without model downloads or external services. It is a PR CI gate;
other slow installer/service scenarios retain their separate prerequisites.

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

The root `justfile` sets `RELEASE_PYPI := "false"`; do not recommend or run PyPI
publication commands. There is currently no published LTCook release. The manual
GitHub Actions release workflow builds Linux wheel/sdist, committed-source native
setup and SDK checksums. It uploads workflow artifacts but creates no tag,
GitHub Release or PyPI publication. Neither an asset build nor a passing
fixture-based check establishes a live installation or model-backed session.

The scaffold's local release commands are adapted to this asset-only policy.
`just build-release-inputs` builds packages and notes; `just release-check`
rehearses the local checks without uploading. `just release-prepare LEVEL` creates
a local version commit and annotated tag. `just release-push TAG` explicitly
pushes the prepared refs and dispatches the manual asset workflow, while
`just release LEVEL` combines those two operations. None creates a GitHub Release
or publishes to PyPI. These mutation and remote operations require separate
authorization; they are not ordinary checks. The incompatible scaffold
`publish-pypi` recipe is deliberately absent.

Release staging checks the setup's embedded binding against application,
distribution, version, command and requested source commit, then verifies its
exact SDK checksum entry. The schema-2 manifest hashes the final package/native
assets without hashing itself; stale setup binaries and legacy script/zipapp
manifests are rejected. Windows/macOS native behavior needs independent native
verification; never run Windows verification executables from WSL.


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
