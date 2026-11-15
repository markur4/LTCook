# Development

[Documentation](README.md) · [Explanations](Explanations.md) · [How-to user guides](How-To-User-Guides.md) · [References](References.md) · [Examples](EXAMPLES.md)

Read [Contributing](../CONTRIBUTING.md) for shared conventions, the normal setup,
quick checks, and submission expectations. This page covers the deeper project
layout, packaging boundary, verification limits, and current release workflow.

- [Work in the project](#work-in-the-project)
  - [Maintainer environment](#maintainer-environment)
  - [Repository routing](#repository-routing)
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
| `just clean` | Remove build/cache artifacts, including pruning the global uv cache; it does not delete the environment or lockfiles. |
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
| Python, runtime, team, and system tests | `tests` |
| User and maintainer documentation | `docs` |

The Python application resolves settings through AppRC. Keep native component
translation in LTCook-owned paths and avoid a second hidden settings layer. The
TypeScript runtime owns coordination; team packages use its public Team API v2.
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
verified unless they were actually run. For this assignment, documentation
examples are illustrative only; Main owns checks and execution.

Do not imply that a model conversation, local service, browser workflow, or native
platform has been exercised based only on source inspection. Explain real
prerequisites and keep normal checks independent of model calls and long-running
agent loops.

---

<br>

# Verify and release

## Verification

Use the root quick checks described in
[Contributing](../CONTRIBUTING.md#run-checks). `just check` performs Prettier and
TypeScript checks, Ruff formatting/lint checks, and Pyright; `just test` runs Bun
runtime/native/team contracts and Python tests excluding `integration` and
`system`. `just runtime test` is the focused runtime/native/team contract subset.
`just build` is a packaging action, not a routine test.

Symbolic Python tests use pytest-xdist with six workers by default. This is
repository policy: retain the dependency and six-worker default unless the user
explicitly approves changing them. An explicit `-n 0` can isolate a failing test
for diagnosis; it does not change the default. Small scheduling batches
(`--maxschedchunk=1`) keep the slow process-based checks distributed across
workers.

A complete test-suite measurement includes symbolic tests and live agent
evaluations. Report elapsed time and outcomes for each category and their
combined total. For complete live coverage, use the full evaluation preset in
both Current and Synthetic setups. Run live agent evaluations sequentially so local
model contention does not distort elapsed-time estimates. Ordinary CI runs symbolic
tests, including scripted checks of the evaluation machinery; live agent
evaluations remain separately invoked.

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
official platform installer when missing, then ensures
`SparkLLM/Spark-X2.6-4B:q8_0` (about 4.4 GB). This is separate from `just sync`,
editable registration, deterministic tests, and CI. Setup records readiness
under AppRC ownership and reuses a healthy user-managed service. It does not bind
Ollama beyond loopback or stop a user-owned service.

Ollama's [Linux installer](https://docs.ollama.com/linux) may require `sudo`;
the [Windows installer](https://docs.ollama.com/windows) is user-scoped; the
[macOS application](https://docs.ollama.com/macos) requires a GUI install/consent
handoff. Model storage stays under Ollama's own platform-specific location. This
checkout's live verification used Fedora 44 on WSL2 only; Windows and macOS
installation behavior remains documented, not natively validated.

Agent Evals uses the shared installed CLI and Paseo run service. Static audit
needs no model; LLM-dependent runs require the prepared local Spark tag
`ltcook-spark-x2.6-4b-q8_0-ctx8192:latest` and do not install or pull models.

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

Reports, progress events and Perfetto traces live in runtime state under
`evals/runs`, with prompts, transcripts, and credentials excluded. Instruction
Audit records production loader provenance; semantic findings require review.
Routine `eval run` performs Behavior Evaluation with full instructions in the
selected setup. It runs the read-only, no-op and targeted-fix cases once each.
`--case` selects one case, and `--repetitions N` explicitly repeats the selected
cases. The default is one repetition. `eval run --all` adds Instruction Audit;
when the categories run together, semantic audit uses the prompt already
captured during Behavior Evaluation rather than launching another agent task.

Bottleneck Attribution reports timings from those same executions and their
Perfetto traces. `eval analyze` starts one set of full-instruction cases by
default, or uses its explicit `--case` and `--repetitions` selections. It does
not run reduced-instruction variants. One execution is enough for an elapsed-time
estimate; overlapping trace categories must not be added into another total.

Keep diagnosis focused: start Synthetic Setup with `--case read-only`, then
verify no-op and targeted-fix individually. Each case starts with reasoning off
and may fall back once to low reasoning on the same pinned Spark model. A case
that fails its fallback stops the run before later cases or repetitions. Each
attempt uses an independent workspace, requests copy-on-write copies where
supported, and releases disposable state after its diagnostics are preserved.

Pi's existing context compaction remains enabled for the pinned 8,192-token
model, reserving 2,048 tokens and keeping 1,024 recent tokens. Summary calls use
the same isolated model and provider state. Diagnostics record compaction timing,
reported usage and failures, while excluding summary text.

Agent evaluation safeguards use three times the slowest of the five most recent
comparable successful attempts. Reasoning modes have separate histories, and
model, fixture, setup, instruction/tool configuration and verified inference
hardware must match. Failed or cancelled attempts do not increase the safeguard.
With no compatible successful history, the report identifies the 120-second
bootstrap safeguard. Reports show the reference runs, expected duration,
calculated safeguard, actual duration, and saved failure diagnostics. Timing
history and partial results belong to runtime state, not a separate database.

Run records use schema 3. Unsupported older histories remain unchanged and are
not read as current results. Preserve them if needed, stop the runtime, remove
its `evals/runs` directory, and restart to reset history. Symbolic tests use
scripted responses without Ollama or user login; live agent evaluations remain
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
ignored `.cache/apprc/`. Native compilation requires uv 0.13.6 and Rust/LLVM;
use a cache-scoped uv version rather than replacing a global installation.
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

The source declares platform preparation code, but this pass has not established
native Windows/macOS behavior, live web research, or model-backed workflows.
Linux-only release automation does not establish those behaviors. Native platform
checks need the respective native environment; do not launch Windows verification
executables from WSL.

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
