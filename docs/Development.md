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
  - [Asset packaging](#asset-packaging)
  - [Integration and system procedures](#integration-and-system-procedures)
  - [Releases](#releases)

---

<br>

# Work in the project

## Maintainer environment

Use Python 3.12+, Bun 1.4.4+, the Node version in `.node-version`, uv, and just.
The root [sync recipe](../justfile) is the supported locked full setup:

```shell
just sync
```

It installs `package-lock.json`/Bun's `bun.lock`, builds TypeScript packages,
stages production assets, then syncs Python dependencies from `uv.lock`. Root
`package-lock.json` is used by installed production deployment; `bun.lock` is
the generated Bun development lock. `uv.lock` locks Python and authoring tools.
Set `BUN` to an absolute Bun executable path if it is not on PATH.

Before using the default checkout workspace, register this repository once from
its root: `uv run ltcook workspace add ltcook . --yes`. AppRC's workspace marker
is required; the development helper does not create it automatically.

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
| Generated AppRC support artifacts | `src/ltcook_distr/artifacts` |
| Developer packaging and asset-staging helpers | `src/ltcook_dev/packaging` |
| AppRC-aware TypeScript development launcher | `src/ltcook_dev/runtime.py` |
| TypeScript runtime, native integrations, panel | `runtime/src` |
| Bundled teams and Markdown resources | `teams/default`, `teams/default-minimal` |
| Compose definitions and templates | `services` |
| Python, runtime, team, and system tests | `tests` |
| User and maintainer documentation | `docs` |

The Python application resolves settings through AppRC. Keep native component
translation in LTCook-owned paths and avoid a second hidden settings layer. The
TypeScript runtime owns coordination; team packages use its public version-1 API.
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
[Contributing](../CONTRIBUTING.md#run-checks). `just check` performs Bun type
checks, Ruff, and Pyright; `just test` runs Bun runtime/native/team contracts and
Python tests excluding `integration` and `system`. `just runtime test` is the
focused runtime/native/team contract subset. `just build` is a packaging action,
not a routine test.

For changed behavior, choose the narrow existing relevant test and report what
it establishes. Unit/contract tests do not prove native installer behavior,
service connectivity, or a live Pi model conversation. Integration tests require
an explicitly prepared environment. System checks may require service, network,
source archive, native OS, or installer prerequisites. Do not add an unbounded
model prompt loop to quick checks.

## Asset packaging

`src/ltcook_dev/packaging/package_assets.py` stages validated production outputs
from the repository root into `src/ltcook_distr/bundle`. The staged bundle
contains compiled runtime entry, Pi extension, Paseo panel plugin, both built
team packages and their Markdown resources, Compose assets, package declarations,
locks, and selected Node version. It excludes development `node_modules` and
test/development-only dependencies. `BuildPy` refuses to build a wheel unless
the bundle is staged and validated; it copies that bundle into the wheel.

The normal `just build` recipe builds TypeScript, stages the bundle, then builds
the Python wheel and source archive. It does not generate AppRC lifecycle
artifacts. Run `just make-artifacts` only after editing authored installer
composition or payload; `just check-artifacts` checks generated artifacts without
rewriting. `src/ltcook_distr/artifacts/_support` is installer support and is not a
runtime bundle. The wheel includes `ltcook_distr/bundle` because installed runtime
needs it; the Python developer tools in `ltcook_dev` and development dependency
group are not installed runtime requirements.

PyApp runs the standalone AppRC installer from a separate bootstrap environment
named `ltcook-installer`, whose dependency file declares `apprc-core` and its
transitive requirements, not `ltcook`. AppRC's configured `uv tool` backend
installs LTCook itself and owns its application environment.
During explicit installer setup/retry, LTCook prepares its private
Node/JavaScript deployment and local Podman/Compose prerequisites. It may need
network access and normal host elevation; the installer does not start Compose.
Starting the runtime in local service mode starts the Compose project, but does
not prove service health. Use `ltcook services status` to inspect local
containers. Status inspection and directory entry do not install prerequisites.

## Integration and system procedures

`just test-integration` runs the marked Python integration tests and Bun runtime
integration tests; `just runtime test-integration` runs the Bun runtime
integration tests alone. The standard `just test` already includes those
in-memory runtime contracts. `just test-system` runs the marked Python system
tests. These selected suites are separate from quick Python tests, and may need
their scenario-specific environment. The slow CI workflow is manual; it is not
part of the ordinary quick-check loop.

Installer source-smoke scenarios require an explicitly supplied immutable source
commit/archive through `INSTALLER_SMOKE_MAIN_SOURCE` and
`INSTALLER_SMOKE_MAIN_COMMIT`, plus network/transport prerequisites. They are
not ordinary smoke checks and must not be run without those inputs. Live local
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
GitHub Actions release workflow builds Linux wheel/source assets, generated
AppRC installer support, and a portable PyApp bundle of three adjacent assets:
`ltcook-install`, `main-installer.pyz`, and the canonical LTCook wheel matching
the project version. It uploads a workflow artifact but does not create a tag,
publish a GitHub Release, or publish to PyPI. Do not infer a release or a
completed installation from a successful asset build.

The PyApp builder validates the wheel's name, project version, and SHA-256.
AppRC selects the adjacent wheel as a noneditable local package; this portable
route needs no source checkout and does not download project source. The native
shell bootstrap generated by `just make-artifacts` remains a separate,
checkout-based route. On native Windows, the launcher is named
`ltcook-install.exe`. The manual workflow is Linux-only and does not establish
native Windows behavior.
