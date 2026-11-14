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

<br>
- Breaking: Opening a project with unset `LTCOOK_SESSION` now starts a new chat
  instead of selecting a workspace-derived Session. To resume, set `LTCOOK_SESSION`
  to an existing saved identifier; IDs and native bindings survive migration.
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

### ➕ Added

<br>
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
- Added readable Pass/Task/member status and ordered Step progress in the native
  Paseo panel while excluding private task, report, handoff, and blocker text.
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

### 💔 Changed

<br>

### ⚠️ Deprecated

<br>

### 🗑️ Removed

<br>

### 🔨 Fixed

<br>

### 🔒 Security

<br>

---

<br>

