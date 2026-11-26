# LTCook architectural code smell cleanup

**Goal.** Clarify ownership of tool policy, runtime composition, coordination,
and Session Memory while preserving supported workflows and their authorization
and recovery guarantees.

**Specifics.** The architectural scan examined `36f7702` on November 25, 2026.
The follow-up checked the affected paths against `58e951c` on November 26.
The scan covered the repository tree and selected implementation paths, tests,
documentation, and backlog entries. The optional deep edge-case scan was
declined. Evidence below distinguishes source observations, verified fixes, and
performance hypotheses. [BACKLOG.md](BACKLOG.md#2026-11-26) tracks outstanding
work. The following checklist is an index.

- [Decisions and acceptance](#decisions-and-acceptance)
- [Execution order](#execution-order)
- [Findings](#findings)
- [Coverage and existing backlog](#coverage-and-existing-backlog)

## Decisions and acceptance

- **Architecture.** AppRC/Python owns configuration and installation. One
  TypeScript runtime owns coordination and the coordination database. Core owns
  dispatch and consent. Teams declare routing. Pi/Paseo own native history.
  Session Memory owns derived records. Paseo panels project runtime and native
  state. Ordinary Pi and Codex receive workspace tools through MCP. Managed
  Team execution uses Pi.
- **Compatibility.** Internal APIs, the public Team API, module boundaries,
  names, wiring and persisted formats may change where that improves ownership.
  Preserve intended user workflows and GUI layout, controls, and navigation.
  Update affected callers, tests, and documentation together. Remove superseded
  production paths once supported callers use the replacement.
- **State.** Keep existing formats where they fit. Cross-version Session
  recovery is optional. Follow the prototype's fresh-store policy for
  incompatible state. Reject that state unchanged and give a clear diagnostic
  and reset instructions. Skip migrations, legacy readers, and compatibility
  layers for historical prototype state. Verify resets with disposable data.
  Resetting an actual installation requires separate authorization.
- **Public Team packages.** If the Team API changes, version it explicitly,
  update bundled Teams, document adaptation and rebuild for managed local
  packages, and verify a representative local package in a newly created
  Session. Its previous Sessions may need replacement. Remove superseded Team
  API implementations and adapters after the cutover.
- **Authorization.** Test successful calls and rejection for all three scopes.
  Managed tools require a current binding to the requested Session and reject
  stale or mismatched bindings. Ordinary MCP requires a valid workspace grant
  and rejects revoked or out-of-scope access. Memory peer access can span
  Sessions within the same TeamInstance and workspace, and must reject access
  outside either boundary. Keep approval, role restrictions, tool
  classification, and transport identity explicit.
- **Recovery.** Establish production-profile Session Memory tests before
  restructuring. Re-run the behavioral cases against the final supported
  implementation and format. Cover same-version restart, resume, incomplete
  history, rewind/invalidation and interrupted generation. Preserve citations,
  current user authority, uncertain-send protection, persisted consent, and
  revision-sensitive Pass reviews.
- **Historical evaluations.** Keep the documented comparison arms runnable and
  retain their semantics and baselines. Isolate historical policy and fixtures
  in checkout-only evaluation code when extracting them from production.
  Use existing Traditional Tests and Pi verification where relevant.
  Model-backed Agent Evals or live cross-harness comparisons follow the
  repository's authorization and verification policy.

## Execution order

1. **Explorer fix (CSC-01).** Independent change `176b072` is reviewed in
   [draft PR #62](https://github.com/markur4/LTCook/pull/62). The two role
   variants passed the focused native guard regression, and the reviewer
   approved the three-file patch. The fix is merged into local `main` as
   `4698a1`, and the report was integrated locally as `bfb823`. Check the
   published target and PR state before picking up either change.
2. **Next milestone (CSC-01, CSC-05, CSC-06A).** Establish ownership of tool
   classification and a targeted bound-member lookup. This removes the
   dependency on the full Session projection and gives runtime composition
   an explicit authorization boundary. Production-profile Memory recovery
   coverage (CSC-03 and CSC-07) may land in parallel when its scope is independent.
3. **Runtime composition and coordination (CSC-02, CSC-04, CSC-09).** Move
   shared service construction out of HTTP and extract Core responsibilities
   in focused passes. Preserve supported startup and native client behavior
   by updating affected callers whenever their contracts change. Fix lost
   error details where callers can use them.
4. **Session Memory (CSC-03, CSC-07).** Once production recovery is covered,
   extract responsibilities incrementally and isolate qualification variants
   while preserving their runnable baselines. Verify packaged plugin loading
   when changing its dependency graph.
5. **Evidence-led follow-ups (CSC-06B, CSC-06C, CSC-08).** Measure the live
   retrieval and workspace preparation paths before selecting optimizations.
   Fold model contract and documentation ownership into the corresponding
   boundary changes when the benefit is concrete.

Each implementation pass follows the repository's expected-file-tree and plan
checkpoints where applicable, one pass worktree, draft PR, verification, and
pass-wide review. Use the published target and PR state to establish the starting
revision. Link completed findings to their evidence, and leave deferred findings
in the backlog. Releases and deployment have separate authorization.

## Findings

### CSC-01 — Tool classification and authorization disagree

**Observed defect, then structural cleanup.** The managed Pi
[native guard](runtime/src/integrations/native-policy.ts) omitted
`session-memory`; [Core](runtime/src/core/runtime.ts) and
[Planning](runtime/src/core/planning.ts) permit it. The
[Pi extension](runtime/src/integrations/pi-extension.ts) rejected both read-only
Explorer lifetimes before consulting Core. The independent fix adds the
existing tool identity to the native guard and exercises both real member
declarations, runtime denial, and local write denial.

The broader cleanup should share capability classification and retain separate
decisions about roles, approval, grants, and transport identity. Guarded
coordination through `ltcook_team` still uses command-level authority.
Native unknown-tool handling differs between read-only and writable members.
Verify the supported behavior for both roles, disabled Memory, and the three
authorization scopes above. The authorization pass gives
[tool capabilities](runtime/src/tools/capabilities.ts) one owner, separate from
the authenticated Session lookup and ordinary MCP grants.

### CSC-02 — HTTP constructs services also used by the tool catalog

**Observed coupling.** [RuntimeApi](runtime/src/integrations/runtime-api.ts)
creates the ColGREP provider and worktree tool used by
[main](runtime/src/main.ts) for the shared catalog. It also owns Activity
preferences, routing, identity, body limits, and several readiness checks.
The listener starts before the host and controller are ready. HTTP invokes
the catalog via [WorkspaceMcp](runtime/src/integrations/mcp.ts), while ordinary
MCP applies its workspace grant. Managed RIED has a dedicated Session route.

Move shared service construction to composition or the relevant domain owner
first. Then extract route families where they improve traversal. Preserve
pre-ready, ready, and shutdown behavior, grant lifetime, and the native and MCP
trust models. For any wire break, update the Python client, Pi, the Paseo plugin,
and relevant tests together.

### CSC-03 — Session Memory concentrates recording, inference, retrieval, and handoff

**Observed coupling.** [SessionMemory](runtime/src/session-memory/service.ts)
owns history ingestion, epochs, checkpoints, durable records, inference
placement and foreground pauses, Activity state, retrieval and handoff.
Existing owners include [units](runtime/src/session-memory/units.ts),
[store](runtime/src/session-memory/store.ts),
[summarization](runtime/src/session-memory/summarization.ts), and
[handoff](runtime/src/session-memory/handoff.ts).

Establish production recovery coverage (CSC-07) and extract cohesive
responsibilities around existing owners. Keep one derived-store owner and
explicit epoch/checkpoint ownership. Preserve the short Discussion threshold
including attachment text, deterministic action bundles, native source
ownership, citations and user authority, pause and resume, pending progress,
model placement, and the distinction between delivered and retained handoff
evidence. See the
[Session Memory behavior contract](docs/Explanations.md#context-aware-session-memory).

### CSC-04 — RuntimeController concentrates coordination responsibilities

**Observed coupling.** [RuntimeController](runtime/src/core/runtime.ts) owns
commands, scheduling, native member lifecycle, delivery, authorization, and
snapshot projection. Scheduling and the snapshot already share
`taskGates()` for task dependencies and approvals.

Keep one coordination and dispatch owner. Reuse the shared gate code and
extract responsibilities where the dependencies are explicit. Preserve
serialization, fresh reads after awaited sends, approved Pass checks, uncertain
delivery without automatic replay, reviewer authority, and revision-sensitive
review. Verify the existing scheduling, planning, recovery, and Team contract
scenarios. Treat changes to transport and error mapping as separately reviewable.

### CSC-05 — Backend contracts sit under the Paseo plugin

**Observed ownership problem with packaging constraints.** Core and multiple
integrations import
[workspace tool metadata](runtime/src/paseo-plugin/shared/workspace-tools.ts)
from the plugin. The plugin server itself currently needs the MCP server name
from that module. [Memory units](runtime/src/session-memory/units.ts) refer to a
type under the plugin's [timeline decoder](runtime/src/paseo-plugin/server/memory-source.ts),
which the [Paseo integration](runtime/src/integrations/paseo-memory.ts) also uses.
The build copies the plugin source subtree to the deployment. The sidebar
loading correction in `120da91` moved a helper into that subtree so installed
Paseo could load it. Source tests alone miss that boundary.

Give domain capabilities and contracts domain owners. Keep actual panel
contracts with the plugin, and preserve provenance and runtime dispatch marker
checks when moving timeline logic. Check the built plugin's dependency
resolution before removing the current import path. Keep shared MCP transport
metadata accessible to the deployed plugin.

The authorization pass moves [workspace tool metadata](runtime/src/tools/workspace-tools.ts)
to runtime tools. The plugin retains its MCP registration name. The timeline
decoder and neutral Memory data contract belong to the later Memory pass.

### CSC-06A — Managed authorization repeats broad reads

**Observed redundant work, unmeasured latency.** The Pi hook asks
`/v1/tool/authorize` for Session Memory, and then `/v1/workspace-tool` authorizes
at invocation. The latter builds one Session snapshot to check the actor and
another through `authorizeTool()`. Repository and web tools already take the
single endpoint path. The standard managed Agent Evals disable Memory and
worktree registration, so this trace does not show double charging in those
runs. Worktree scope separately consults the Session projection.

Use a current bound-member lookup, then targeted state for role, assignment and
Pass decisions. Retain server-side authorization at invocation and check
whether the earlier hook adds an independent guarantee for adapter-owned tools.
Avoid cached positive decisions and preserve actual evaluation budget semantics.
Do not treat the scheduler's post-send refresh as redundant. Verify fresh,
stale, mismatched, and uninitialized binding cases and measure query count before
claiming a latency improvement.

The authorization pass replaces two Session projections and the separate
Planning binding read with a single lookup in Core. Pi dispatches registered
managed catalog tools through the invocation-time authorization boundary.
The separate worktree Pass context still reads the projection it needs.

### CSC-06B — Broad Memory search walks original history

**Observed scaling characteristic, practical impact unmeasured.** In
[SessionMemory](runtime/src/session-memory/service.ts), broad discovery pages
through authorized original history and re-ranks after each page. Peers run
concurrently, and an output budget limits results. Exact source lookup already
uses a cursor-based page read. Handoff recovery can call broad discovery with
its own budget.

Measure exact lookup, broad searches, and handoff recovery separately. For
broad discovery record pages, bytes, peers, ranking time, deadlines, result
completeness, and recall on old identifiers and revised decisions. Consider
derived-record lookup or a rebuildable epoch-aware lexical index only if the
measurements support it. Preserve peer authority, rewind invalidation, exact
Paseo citations, and explicit incomplete/unavailable results.

### CSC-06C — Live workspace preparation uses synchronous I/O

**Observed blocking and unbounded cache, practical impact unmeasured.** The
[Paseo integration](runtime/src/integrations/paseo.ts) invokes AppRC with
`spawnSync`. [WorkspacePreparationCache](runtime/src/integrations/workspace-preparation.ts)
uses synchronous fingerprints and a Map without eviction. AppRC owns settings,
secrets, and original shell provenance. Different Session cache keys can
resolve to one Pi home. The AppRC
[config writer](src/ltcook/config/pi_config.py) reads, merges, and atomically
replaces `models.json`.

Measure event-loop delay and cache growth independently. If async work is
justified, deduplicate equal in-flight requests and serialize writes by shared
output path where needed. Preserve dependency identity, content invalidation,
shell provenance, and cancellation. Check concurrent Sessions sharing one Pi
home, external edits, and bounded cache behavior.

### CSC-07 — Production Memory carries historical evaluation strategies

**Observed coupling and test gap.** The production
[composition](runtime/src/main.ts) uses deterministic Markdown with
`contextIndependent: true`. Some [recovery tests](tests/runtime/unit/session-memory.test.ts)
select legacy JSON. The
[comparison runner](evals/session-memory-simplified.ts) exercises legacy JSON,
deterministic JSON, and deterministic Markdown. It explicitly sets context
independence for its hosted arm. Legacy behavior also affects queue and pause
semantics. The [qualification guide](docs/Development.md#session-memory-qualification)
documents the comparison.

[PR #64](https://github.com/markur4/LTCook/pull/64) adds production-profile
characterization with an incomplete timeline, shutdown during Markdown
inference, same-store reopen and resume, and old-epoch citation and row
invalidation. The delayed history and missed terminal event fixtures exercise
both profiles. Re-run these assertions after restructuring Session Memory.

Characterize restart, resume, partial history, rewind and interrupted
summaries with the real production profile. Then extract qualification variants
and reusable fixtures from production. Retain runnable historical comparisons
with the same behavior and attribution. Keep Traditional Tests, bundled Agent
Evals, and checkout-only qualification roles intact.

### CSC-08 — Model and documentation contracts have split ownership

**Observed declaration duplication, no confirmed alias drift.** The
[alias registry](runtime/src/models/aliases.ts) owns model aliases and strict
inputs. The [panel model DTO](runtime/src/paseo-plugin/shared/models.ts) repeats
reasoning values and field shapes and accepts broader model strings. That
boundary also projects native overrides.

Share neutral declarations if the resulting import fits the deployed plugin,
while retaining the distinct input constraints and panel projection. Keep
public aliases and native overrides usable. Update the
[repository routing guide](docs/Development.md#repository-routing) with the
resulting module owners and label current production versus qualification
instructions. Change existing documentation in place.

### CSC-09 — Adapters discard actionable failure detail

**Observed information loss.** [RuntimeApi](runtime/src/integrations/runtime-api.ts)
maps uncaught request failures to HTTP 400 and returns the exception
message. The [Pi extension](runtime/src/integrations/pi-extension.ts) drops
returned details for RIED and Session Memory while preserving them for repository
search. [SessionMemory](runtime/src/session-memory/service.ts) records a generic
update failure on unexpected errors.

Start with concrete failures where a caller can act on a safer detail. Preserve
typed unavailable, partial, or paused outcomes where they express valid degraded
behavior. Keep hard authority and unsafe-state failures hard, separate client
errors from actionable service failures, and redact sensitive context. Introduce
a common error contract only if actual callers benefit. Verify the affected
CLI, native, or GUI consumers when changing status or message contracts.

## Coverage and existing backlog

The analysis traced obvious failures, responsibility and traversal, efficiency,
documentation, errors, user-facing messages, and removal candidates. It was a
static review with selected tests read and no deeper edge-case audit. It did
not benchmark latency or recall, run live Agent Evals, certify an installed
build, or establish that historical evaluation paths are unused.

The independent Explorer patch passed eight focused guard tests, the
TypeScript/formatting checks, 397 TypeScript Traditional Tests with two skips,
and 269 Python Traditional Tests. The TypeScript suite used an isolated view of
host skills, addressing the already tracked fixture issue. Those checks apply
to the Explorer patch's reviewed tree and do not verify the proposed refactors.
See [PR #62](https://github.com/markur4/LTCook/pull/62) for its evidence.

Existing backlog entries remain authoritative for detached runtime shutdown,
mobile Activity observation, chat diff/worktree selection, host-skill fixture
isolation, local summarizer fidelity, and intermittent Agent Eval retries.
See [BACKLOG.md](BACKLOG.md).
