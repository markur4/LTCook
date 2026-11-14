# Contributing to `ltcook`

These conventions apply to human contributors and coding agents. Start here for
the normal contribution workflow; use [Development](docs/Development.md) for
detailed environment, packaging, and verification guidance.

<br>

---

### Table of Contents

1. [Before starting](#before-starting)
2. [Quick start](#quick-start)
   1. [Set up development](#set-up-development)
   2. [Run checks](#run-checks)
3. [Working conventions](#working-conventions)
4. [Documentation and generated files](#documentation-and-generated-files)
   1. [README maintenance](#readme-maintenance)
   2. [Generated files](#generated-files)
5. [Before submitting](#before-submitting)

---

<br>

# Before starting

Check [existing issues](https://github.com/markur4/LTCook/issues) and
[BACKLOG.md](BACKLOG.md) for overlapping work. Read the relevant component in
[Explanations](docs/Explanations.md), inspect its source and tests, and preserve
unrelated changes. Coding agents must also follow [AGENTS.md](AGENTS.md).

---

<br>

# Quick start

## Set up development

The project requires Python 3.12+, Bun 1.4.4+, Node matching `.node-version`,
uv, and just. From the project root:

```shell
uv venv --python 3.12 .venv
just sync
```

This uses the checkout's `.venv` (or explicit `UV_PROJECT_ENVIRONMENT`), installs
frozen Bun dependencies, builds and stages runtime/team assets, then synchronizes
the Python environment from `uv.lock`. It does not install Podman or run
application setup. You may use the
normal Python package tooling without uv for Python-only work, but changes to the
runtime bundle, Python lock, or packaged assets should use the locked root setup.
If Bun is not on PATH, set `BUN` to its executable path for root and runtime tasks.

The [maintainer environment](docs/Development.md#maintainer-environment) guide
explains the dependency locks, portable lock export, staged wheel payload, and
restored scaffold recipes.
Entering the repository does not install or start Pi, Paseo, browser files, or
containers.

## Run checks

The default quick checks are split by language:

```shell
just runtime check
just runtime test
just check
just test
```

`just check` enforces Prettier and Ruff formatting, TypeScript types, Python lint,
and Pyright. Use `just format` to apply formatting. `just test` runs
Bun unit/native/runtime-integration/team-contract tests and Python tests excluding
the `integration` and `system` markers. The runtime integration tests use fake
agents and in-memory coordination; these quick commands do not start native
agents, call models, or start containers. The separate marked Python integration
and system commands are documented in the
[verification guide](docs/Development.md#verification); use them only when their
scenario prerequisites are available.

Do not run installation smoke tests as a default loop. They require an explicitly
built native setup and its immutable source commit, plus compiler/download prerequisites.
Windows and macOS behavior is not established by Linux execution. The guides explain these
limits; the [release guide](docs/Development.md#releases) describes the current
Linux-only manual asset build, not publication.

---

<br>

# Working conventions

- Keep changes focused and follow the [repository layout](docs/Development.md#repository-routing).
  Ask before creating a top-level directory if an existing owner fits.
- AppRC is declared once in `ltcook.config.app.APP_RC`; settings belong in their
  registered classes under `ltcook.config.sections`, and `LtcookConfig` groups
  those declarations. Declare fields with `rc.field(...)`; register each new
  section with `APP_RC.config(...)` and include it in the bundle. Use
  `current_env_mapping()` when producing each workspace's child environment;
  preserve original shell provenance between workspace resolutions.
- Keep secret settings marked `secret=True`, and never log or document their
  values. Redaction controls display; it does not encrypt the AppRC-managed file.
- Keep Python launch/configuration concerns in `src/ltcook`, lifecycle and
  installer ownership in `src/ltcook_distr`, and developer packaging helpers in
  `src/ltcook_dev`. The wheel's `BuildPy` step copies only a validated canonical
  `src/ltcook_distr/bundle.zip`.
- Runtime and team packages are Bun workspaces. Teams implement the current
  public `apiVersion: 2` interface in `runtime/src/team-api/index.ts`. Guidance
  and workflow contracts have separate purpose-named public entry points. Teams
  declare routing and optional assignee selection; Core owns consent and dispatch.
  Shared commands are defined once in `runtime/src/workflow-api/commands.ts`
  and inferred from its TypeBox schema; do
  not duplicate the command union or parameters. Do not add adapters for old
  prototype versions.
- Keep TypeScript coordination in the single runtime owner for its SQLite
  database. A persistent TeamInstance may back multiple Sessions, but native
  bindings and chat histories remain Session-specific. Pi/Paseo owns message
  history; LTCook records ordered Steps and Pass-level current-revision reviews.
  Preserve workspace/team identity and never replay an uncertain external action
  automatically.
- Use precise domain attributes and established helpers. Add abstractions only
  when they clarify a real shared responsibility. Preserve package initializer
  boundaries and use Sphinx-style docstrings for public Python behavior.

[BACKLOG.md](BACKLOG.md) holds durable actionable work deferred from the current
change. Keep active execution checklists beside their plan, not as a second
repository backlog.

---

<br>

# Documentation and generated files

Update documentation when setup, commands, settings, public APIs, packaging, or
user-visible behavior changes. Preserve the existing design of the root README,
CONTRIBUTING, and six documentation pages. Follow the
[documentation rules](docs/README.md#documentation-rules), and update affected
incoming links and anchors in the same change.

## README maintenance

Adapt the root README in place. Read it completely before editing, preserve its
section order, HTML layout, useful content, and curated navigation. Replace stale
facts where they occur; do not replace it with generic boilerplate. A substantial
redesign requires an explicit request. Preserve CONTRIBUTING's established design
as well.

## Generated files

When an asset has a source builder, update that source and regenerate explicitly.
`just sync` and `just build` create the canonical runtime/team/service bundle ZIP.
`just build-native` snapshots committed source and its lock, then builds the Linux
native setup through AppRC. Native authoring needs uv 0.13.6 and Rust/LLVM;
editable registration does not. Never hand-edit generated payloads or stage
incomplete assets into a distributable package. See
[asset packaging](docs/Development.md#asset-packaging).

---

<br>

# Before submitting

Review the changed files and relevant links for stale facts, unsupported claims,
and unrelated edits. Run the relevant bounded checks; report exact commands and
observed outcomes, including unrun integration/system behavior. Documentation
examples are not evidence of successful execution unless they were actually run.

A pull request should explain the problem, intended behavior, verification, and
compatibility implications. Record relevant user-facing changes in
[CHANGELOG.md](CHANGELOG.md); state breaking changes and migration instructions
when applicable. Respect the user's commit, publication, and deployment permissions.
