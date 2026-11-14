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
  - [Local guidance benchmark](#local-guidance-benchmark)
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

## Local guidance benchmark

The opt-in [guidance benchmark](../tests/benchmarks/guidance.ts) compares minimal
Team guidance with complete LTCook guidance using the same `default-minimal`
Team, selected model, tool definitions, fixture, and Core rules/skills in both
arms. It uses Pi's public SDK and existing `models.json` provider configuration.
Start your own llama.cpp OpenAI-compatible server on loopback and register the
model there through Pi's normal configuration. No model download, authentication
client, external provider, or service provisioning is performed.

Run from the checkout root after `just sync`:

```shell
bun tests/benchmarks/guidance.ts /absolute/path/to/models.json local Spark-X2.6-4B-Q8 /absolute/path/to/results.json 3
```

The first two arguments select an existing Pi model file and provider ID. The
remaining arguments select model ID, JSON output, 1–20 repetitions, and optional
starting thinking level (`off`, `low`, or `high`). The default model label is
`Spark-X2.6-4B-Q8`; use the exact ID in your Pi configuration and configure it
with reasoning support. The default is thinking off. Each failed off-thinking
task automatically repeats once with low thinking on a fresh copy of the same
fixture. Low and high starts are diagnostic runs and do not auto-retry.
Only a loopback endpoint is accepted. A run has a 120-second deadline, a 24-tool
budget, and at most two direct delegations to another declared eligible member.
It exposes only fixed fixture read/write/verification tools and a clearly named
synthetic `benchmark_delegate` tool; it does not measure RuntimeController Pass
scheduling. Each run uses a fresh temporary workspace, removed after disposal.

The JSON report records each task's initial and final success, total wall-clock
completion time across attempts, and each attempt's thinking level, success,
elapsed time, provider-reported input, output/cache tokens, tool calls,
delegations, and rule-based unnecessary-action candidates. Aggregates include
initial and post-retry success and mean total task time. Repeated reads,
verification calls, and answer writes are candidates
for inspection; a necessary correction may trigger them. Aggregates compare the
two arms, whose order alternates each repetition. Zero usage may mean the provider
did not report tokens; it is not an estimate. Model scores never gate CI or Pass
completion. A live local model run is explicitly initiated by this command;
normal checks use no model service.

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
