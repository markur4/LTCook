# Contributing to `ltcook`

These conventions apply to human contributors and coding agents. Start here for
the normal contribution workflow; use [Development](docs/Development.md) for
detailed environment, packaging, and verification guidance.

<br>

---

### Table of Contents

1. [Before starting](#before-starting)
2. [Issues and backlog](#issues-and-backlog)
3. [Quick start](#quick-start)
   1. [Set up development](#set-up-development)
   2. [Run checks](#run-checks)
4. [Working conventions](#working-conventions)
5. [Documentation and generated files](#documentation-and-generated-files)
   1. [README maintenance](#readme-maintenance)
   2. [Generated files](#generated-files)
6. [Changelog](#changelog)
7. [Before submitting](#before-submitting)

---

<br>

# Before starting

Check [existing issues](https://github.com/markur4/LTCook/issues) and
[BACKLOG.md](BACKLOG.md) for overlapping work. Read the relevant component in
[Explanations](docs/Explanations.md), inspect its source and tests, and preserve
unrelated changes. Coding agents must also follow [AGENTS.md](AGENTS.md).

---

<br>

# Issues and backlog

## Record roles

| Record | Owns |
| --- | --- |
| GitHub Issues | Durable work and its details, evidence, scope, discussion, labels, and resolution. |
| `BACKLOG.md` | Concise issue summaries grouped into ordered planned Passes. Every actionable entry links to its GitHub Issue. |
| `PLAN.md` | The scope and approach of the active Pass. |
| `TODO.md` beside `PLAN.md` | The active Pass's operational checklist for reproduction, implementation, tests, documentation, and delivery as applicable. |
| `CHANGELOG.md` | Notable delivered changes. |
| `CONTRIBUTING.md` | Shared rules for maintaining these records. |

Several TODO steps may implement one issue, and one Pass may address several
issues. Do not create an issue for each operational step. Keep one authoritative
active checklist rather than duplicating editable checkboxes across documents.

## Labels and focus

Use only the workflow labels `accepted`, `needs info`, and `Deferred`, alongside
unrelated labels and GitHub's native issue states.

| Label | Meaning |
| --- | --- |
| `accepted` | The issue belongs to the focused work. It does not assert that all information is available. |
| `needs info` | Specific missing information prevents the next step. State the unanswered question in the issue. |
| `Deferred` | The work is deliberately retained for later. |

These labels are independent. `accepted` may coexist with `needs info`,
`Deferred`, or both. Adding `needs info` must not remove `accepted`. Remove
`needs info` when the information is supplied. Promote deferred work deliberately
when scheduling it. An issue in `BACKLOG.md` is accepted. New findings recorded as
issues do not automatically enter the focused backlog. If Actions is unavailable,
apply the required labels additively through the GitHub CLI or API.

## Schedule work

> [!CAUTION]
> These records can be published: Never record secrets, absolute paths, credentials, private host data, or speculative security claims. Use repository-relative source paths and complete GitHub issue URLs. 


> [!IMPORTANT]
> 
> ## Rules
> 1) Preserve the BACKLOG header and TOC. Follow the rules in this contribution guide.
> 1) Order planned Passes and their entries by intended execution. Group work by priorities, dependencies, shared implementation and checks, and effort. Keep `Deferred` last and preserve Ignore and other context before the queue.
> 1) Do not suggest issues for paths that are under `## Ignore`
> 1) Create or update a GitHub Issue for real, actionable, out-of-scope work. Add a concise, linked backlog entry when selected for scheduling. Reorder, batch, reconcile, or remove entries when useful.
> 1) Search open and closed issues and the backlog for the same outstanding scope. Reuse a matching issue, preserve relevant closed history, and reference related distinct issues from both records using complete issue URLs.
> 1) For a complete fix, use a closing issue reference in the pull request to `main` and remove the backlog entry in the same change. Use an ordinary reference for a partial fix and keep unresolved scope open. Follow this repository's [changelog rules](#changelog).
> 1) **Types:**
>       - **Bug risk**: Potential defect with concrete evidence, not yet confirmed.
>       - **Code smell**: Implementation, architectural, maintainability or clarity issue that is not currently a defect.
>       - **Docs drift**: Documentation is stale, incomplete, or inconsistent.
>       - **Tooling**: Issue with build, test, lint, type-check, and general slowdown of developer workflow.
>       - **Security**: Evidence-backed security risk. Use Question for uncertainty.
>       - **Question**: Design, behavior, or ownership uncertainty needing investigation & maybe decision.
> 
> 1) **Priorities:**
>       - **P1**: Should be handled ASAP.
>       - **P2**: Should be handled before next release or milestone.
>       - **P3**: Useful cleanup for a later focused pass.
> 1) **Effort:**
>       - **E1**: Issue deserves its own focused pass.
>       - **E2**: Can be batched with a few other issues.
>       - **E3**: Can be batched with many other issues.
> 1) **Format:**
> ```markdown
> 
> <br>
> 
> # Planned Pass — <pass name>
>
> ## <Priority> / <Effort> [<Type>] - *Short problem title*
> - **Issue:** <complete GitHub issue URL>
> - **Area:**  `path/or/symbol`
> - **Observed while:** short context
> - **Why not fixed now:** scope, risk, uncertainty, or user decision needed
> - **Evidence:** concrete observation
> - **Context:** explanation to ensure the problem is understood in the big-picture of the repo.
> - **Suggested next step:** smallest reasonable follow-up. If applicable, reference related issues by their complete URLs.
> 
> ## <Priority> / <Effort> [<Type>] - *Short problem title*
> - **Issue:** <complete GitHub issue URL>
> - **Area:** `path/or/symbol`
> - ...
> 
> <br>
> 
> # Planned Pass — <pass name>
>
> ## <Priority> / <Effort> [<Type>] - *Short problem title*
> - **Issue:** <complete GitHub issue URL>
> - **Area:** `path/or/symbol`
> - ...
> ```



<br>

---

<br>

Agents may reorder the backlog to handle dependencies and blockers. When one item
cannot proceed, record its blocker on the existing issue and update the backlog
order when needed. Independent Tasks within an authorized Pass may continue. Do
not create an issue merely because work stalled. Create another issue only when
it represents separate actionable work. A `needs info` label does not
automatically defer the issue or remove it from the focus. Backlog organization
does not itself authorize a Pass to start.

## Create and maintain issues

Read this policy, the relevant backlog entries, and the issue's current body,
labels, state, and relevant comments before working. Search open and closed
issues before creating a record. Reuse an issue only when it covers the same
outstanding scope. Preserve relevant closed issues as history instead of
reopening them solely to avoid a similar title. After an uncertain creation
result, search for the created issue before retrying. Preserve source evidence
until the issue exists and covers its scope. Link related work in both issues
when useful.

Use the repository's work item template for findings. Keep the existing priority,
effort, and type format. Record concrete evidence and preserve useful detail. Do
not require new reproduction before transferring findings already supported by
recorded evidence. Create an issue only for real, actionable work not already
covered by another issue. Do not create issues for paths in the backlog's Ignore
section. Preserve existing content when updating an issue. Keep repository paths
relative in issue content, and follow the privacy rules above.
Link each scheduled issue using its canonical GitHub URL. Reference issues from
the active Pass plan, checklist, and implementing pull request when applicable.

Use the repository's existing report field order: Area, Observed while, Why not
fixed now, Evidence, Context where present, and Suggested next step. Backlog
entries add a mandatory **Issue** field with the complete issue URL. Keep the
report heading style of priority, effort, and type in the issue body.

If information blocks the next step, add `needs info` with the specific question
and keep `accepted` unchanged. Use issue comments for meaningful evidence,
questions, decisions, and delivery results. Avoid transcripts of routine agent
activity.

## Complete and hand off work

For a complete fix, link the issue to the pull request with a closing reference
such as `Closes #123` that closes it when merged to `main`. Remove its completed
backlog entry in the same change, finish the relevant TODO steps, and follow the
existing changelog policy. A partial fix uses an ordinary issue reference and
leaves unresolved scope open. A reopened issue needs a scheduling decision in
`BACKLOG.md`.

Before unfinished work leaves an active Pass, preserve its durable scope in an
existing or new issue and the appropriate backlog entry. Do not let the active
TODO become the only record of durable follow-up work.

Reconcile the issue, backlog, active plan, checklist, and pull request while
discovering, organizing, working, deferring, and completing work. If a GitHub
write fails, record the operation, source evidence, and current outcome in the
active TODO. Before retiring that TODO, carry any pending operation and its
evidence into the existing unfinished-work handoff. Do not claim a write
succeeded or discard the only copy of a finding. If GitHub is unavailable, keep
the finding locally as pending publication and continue independent authorized
work.

Preserve the backlog's existing report fields and Ignore exclusions. Use its
heading format and add the canonical GitHub Issue URL to every actionable entry.
Keep full issue details in GitHub and concise summaries and planning context in
the backlog.

---

<br>

# Quick start

## Set up development

Use Python 3.13+, Bun 1.4.4+, Node matching `.node-version`, uv, and just. From
the project root:

```shell
uv venv --python 3.13 .venv
just sync
```

See [Maintainer environment](docs/Development.md#maintainer-environment) for the
locked setup, environment variables, and packaging details.

## Run checks

Run the normal checks from the project root:

```shell
just check
just test
```

See [Verification](docs/Development.md#verification) for check coverage,
prerequisites, and platform limits. Native and model-backed procedures are
documented there when a task requires them.

---

<br>

# Working conventions

LTCook is a prototype. Prefer clean breaking replacements: remove superseded code,
formats and caches. Do not add migration code, compatibility readers, aliases or
dual implementations. Reject unsupported saved state unchanged and give explicit
reset or reinstall guidance.

Reinstall local LTCook instances as clean installations. Remove the previous
instance's LTCook-owned program, configuration, credentials, sessions, histories,
caches and records before installing the current version. Do not retain, archive,
migrate or keep references to old versions or their data. Independent
installations, shared services and external workspaces are outside the instance.

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
- Give supported harnesses the same enabled LTCook workspace tools. The
  authenticated launch workspace authorizes LTCook's project file reads.
  Native editors and shells use the harness's own permissions. See
  [Repository Core and RIED](docs/Explanations.md#repository-core-and-ried).
- Keep Python launch/configuration concerns in `src/ltcook`, lifecycle and
  installer ownership in `src/ltcook_distr`, and developer packaging helpers in
  `src/ltcook_dev`. The wheel's `BuildPy` step copies only a validated canonical
  `src/ltcook_distr/bundle.zip`.
- Runtime and team packages are Bun workspaces. Teams implement the current
  public `apiVersion: 3` interface in `runtime/src/team-api/index.ts`. Guidance
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

Follow [Issues and backlog](#issues-and-backlog) for durable issue records and
planned Pass order. Keep the active execution checklist in `TODO.md` beside its
`PLAN.md`.

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
native setup through AppRC. Native authoring needs uv 0.11.6 or newer and Rust/LLVM;
editable registration does not. Never hand-edit generated payloads or stage
incomplete assets into a distributable package. See
[asset packaging](docs/Development.md#asset-packaging).

---

<br>

# Changelog

> [!IMPORTANT]
> ## Rules
> This changelog follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and
> [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0/).
>
> Keep one cumulative section per target version. Use `## [X.Y.Z] - YYYY-MM-DD`
> for stable and append `(b1)` or `(rc1)` for an optional preview. The notes
> describe what ships since the previous stable version.
> Link the section to that stable tag once one exists. Include only stable
> `X.Y.0` releases in the table of contents.
>
> Keep all six category headings under `[Unreleased]` and empty them before a
> release. Omit empty categories from versioned sections. Preserve the emojis
> and layout markers. Prefix breaking entries with `**Breaking:** 💥` in the
> applicable category. Describe the final shipped behavior under Added for a
> new feature. Use Fixed for defects in previously released behavior.

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
