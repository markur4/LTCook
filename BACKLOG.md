# Backlog

Treat this as the parking lot for actionable problems discovered while working but intentionally left unresolved.


<br>

> [!CAUTION]
> This is git-tracked: Never record secrets, absolute paths, credentials, private host data, or speculative security claims. Use only relative paths. 


> [!IMPORTANT]
> 
> ## Rules
> 1) Do not remove this header and TOC. THis is supposed to stay.
> 1) Newest at the top, but below `## Ignore`.
> 1) Do not suggest issues for paths that are under `## Ignore`
> 1) Append a new entry only when the observation is real, actionable, not already listed, and out of scope for the current change. Do not modify `BACKLOG.md` when there is nothing useful to add.
> 1) If an issue is new and related to another issue, reference it in the `Suggested next step`. Do not create a new entry for the same problem. Place the reference in both entries (bi-directional).
> 1) If an issue was resolved, remove it and make an entry in the CHANGELOG.md.
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
> # YYYY-MM-DD <!-- today's date -->
>
> ## <Priority> / <Effort> [<Type>] - *Short problem title*
> - **Area:**  `path/or/symbol`
> - **Observed while:** short context
> - **Why not fixed now:** scope, risk, uncertainty, or user decision needed
> - **Evidence:** concrete observation
> - **Context:** explanation to ensure the problem is understood in the big-picture of the repo.
> - **Suggested next step:** smallest reasonable follow-up. If applicable, reference related backlog items [here](#backlog).
> 
> ## <Priority> / <Effort> [<Type>] - *Short problem title*
> - **Area:** `path/or/symbol`
> - ...
> 
> <br>
> 
> # YYYY-MM-DD  <!-- today's date -->
>
> ## <Priority> / <Effort> [<Type>] - *Short problem title*
> - **Area:** `path/or/symbol`
> - ...
> ```



<br>

---

<br>

## Table Of Contents

1. [Backlog](#backlog)
   1. [Table Of Contents](#table-of-contents)
   2. [Ignore](#ignore)

<br>


---

<br>

## Ignore
- `publications/`

<br>

# 2026-11-26

## P2 / E2 [Tooling] - *Make effective Codex approval settings visible in Paseo*

- **Area:** Paseo's Codex app-server adapter and [LTCook's Paseo host configuration](runtime/src/integrations/paseo.ts).
- **Observed while:** Investigating why a Codex command approval blocked default-branch integration.
- **Why not fixed now:** The current Pass aligns instructions and documentation. A diagnostics or provider change needs its own scope.
- **Evidence:** The affected Paseo agent had `modeId: "auto-review"` and its turn used `on-request` with `auto_review`. The pinned Paseo adapter defaults to Auto-review for Codex 0.115.0 and newer and forwards that preset to Codex. The affected session ran Codex 0.171.0. Codex app-server itself assigns the historical `vscode` source label.
- **Context:** The active chat mode can override the user's CLI defaults. The historical records establish the effective mode, and the adapter source establishes the provider default. The original mode selection or inheritance for that chat remains unconfirmed.
- **Suggested next step:** Trace how a fresh or resumed Codex chat obtains its mode. Verify the effective reviewer, approval policy, and sandbox for standalone Codex and Paseo's Default Permissions and Auto-review presets. Make the effective values and their sources visible through existing diagnostics.

The [architectural CSC report](code-smells.md) records findings, accepted
decisions, the Explorer fix status, and the order for the remaining passes.

## P3 / E2 [Code smell] - *Give LTCook Services and container deployment distinct homes*

- **Area:** `runtime/src/session-memory/`, `runtime/src/services/`, `runtime/src/repository/`, `services/`, and `docs/`.
- **Observed while:** Reviewing runtime ownership and the Activity sidebar's Services terminology during the architectural CSC.
- **Why not fixed now:** This records the approved ownership decision. Schedule the moves with the CSC follow-ups after the next milestone.
- **Evidence:** Tracker lives under `runtime/src/session-memory/`; Activity lists RAG Index and handoff evidence, while `runtime/src/services/controller.ts` controls external containers and root `services/` holds Compose definitions and templates.
- **Context:** LTCook Services live in the single runtime, remain available while enabled, wait for events, schedules, or requests, and maintain their own state. AI is optional and a separate process or daemon is unnecessary. Reserve `runtime/src/services/` for these capabilities. Keep search, indexing, and providers in `runtime/src/repository/`. The background repository indexing service in `runtime/src/services/repository-index.ts` calls the Repository Core provider and reports its work through the RAG Index view.
- **Suggested next step:** Rename root `services/` to `containers/` and move the controller to `runtime/src/integrations/containers.ts` or an equally clear container integration path. Update packaging, asset staging, and `docs/` in the same change, including [repository routing](docs/Development.md#repository-routing), the [conversation evidence explanation](docs/Explanations.md#tracker-and-conversation-evidence), and affected container paths and links. Preserve the Activity labels and GUI experience, keep one runtime, and omit migrations and legacy adapters. Coordinate the moves with [runtime decomposition](#p3--e1-code-smell---separate-runtime-composition-transport-and-coordination).

## P2 / E1 [Code smell] - *Give managed tool classification and bound-member lookup explicit owners*

- **Area:** `runtime/src/tools`, `runtime/src/core`, `runtime/src/integrations/native-policy.ts`, and `runtime/src/integrations/runtime-api.ts`.
- **Observed while:** Reviewing the managed Pi Session Memory denial and its server authorization path.
- **Why not fixed now:** Explorer restoration is tracked in PR #62. This pass covers classification and bound-member lookup. The timeline decoder and neutral Memory contract remain with the Session Memory pass.
- **Evidence:** The authorization pass consolidates classification and replaces two Session snapshots with one binding lookup per managed HTTP invocation. Session Memory and worktree calls retain the native precheck because Pi's call hook lacks the selected handler's identity.
- **Context:** The next milestone depends on explicit tool classification and a current binding lookup. Keep role, Pass approval, workspace grants, and Memory peer scope distinct.
- **Suggested next step:** Use the scoped invocation authority in the transport decomposition, then finish Memory-specific ownership with the Session Memory pass. See [CSC-01](code-smells.md#csc-01--tool-classification-and-authorization-disagree), [CSC-05](code-smells.md#csc-05--backend-contracts-sit-under-the-paseo-plugin), [CSC-06A](code-smells.md#csc-06a--managed-authorization-repeats-broad-reads), and the [runtime decomposition](#p3--e1-code-smell---separate-runtime-composition-transport-and-coordination) entry.

## P3 / E1 [Code smell] - *Separate runtime composition, transport and coordination*

- **Area:** `runtime/src/main.ts`, `runtime/src/integrations/runtime-api.ts`, `runtime/src/integrations/mcp.ts`, and `runtime/src/core/runtime.ts`.
- **Observed while:** Tracing shared tool construction, startup and scheduling.
- **Why not fixed now:** Shared construction and the Activity, tool, and Session route families have explicit owners. Core extraction, the remaining adapter boundaries, and correction of failure details remain open.
- **Evidence:** HTTP and MCP invoke tools through the same runtime catalog. Session activation owns canonical workspace registration and pending Open requests. RuntimeController still implements command policy, scheduling, native lifecycle, delivery, and snapshot projection. RIED and Session Memory lose returned error detail at the native boundary.
- **Context:** Preserve startup readiness, one coordination owner, uncertain-send protection, approval and review gates, and the existing user workflows.
- **Suggested next step:** Extract route families on the injected service boundary, then extract cohesive Core responsibilities using the shared task gates and fix evidenced error detail losses. See [CSC-02](code-smells.md#csc-02--http-constructs-services-also-used-by-the-tool-catalog), [CSC-04](code-smells.md#csc-04--runtimecontroller-concentrates-coordination-responsibilities), [CSC-09](code-smells.md#csc-09--adapters-discard-actionable-failure-detail), [tool classification and lookup](#p2--e1-code-smell---give-managed-tool-classification-and-bound-member-lookup-explicit-owners), [model contract ownership](#p3--e3-code-smell---clarify-model-contract-and-documentation-ownership), and [Services and container ownership](#p3--e2-code-smell---give-ltcook-services-and-container-deployment-distinct-homes).

## P3 / E1 [Question] - *Measure authorized conversation retrieval scaling*

- **Area:** `runtime/src/session-memory/conversation.ts` and `runtime/src/integrations/paseo-memory.ts`.
- **Observed while:** Tracing broad discovery through authorized original history.
- **Why not fixed now:** The local Paseo pilot met the current deadlines and found every expected source on the measured corpus. It gives no reason to introduce an index for that workload.
- **Evidence:** Exact lookup used one page at every tested size. Targeted broad search walked 200 pages at 9,600 messages. Handoff read one page for current context and 200 pages when recovering older originals. See the [retrieval measurements](code-smells.md#retrieval-measurements) for latency, recall, and fixture limits.
- **Context:** Evaluate search, exact lookup, and handoff recovery separately. Preserve epoch, peer scope, citations, and truthful incomplete results.
- **Suggested next step:** Reconsider an epoch-aware lexical index if a representative workload shows missed deadlines or recall loss. See [CSC-06B](code-smells.md#csc-06b--broad-memory-search-walks-original-history).

## P3 / E2 [Question] - *Measure live workspace preparation and cache growth*

- **Area:** `runtime/src/integrations/paseo.ts`, `runtime/src/integrations/workspace-preparation.ts`, and `src/ltcook/config/pi_config.py`.
- **Observed while:** Tracing AppRC workspace preparation for managed native agents.
- **Why not fixed now:** [Draft #75](https://github.com/markur4/LTCook/pull/75) has a measured and reviewed implementation awaiting integration.
- **Evidence:** The live runtime uses `spawnSync` and synchronous fingerprints. The cache has no eviction. Different Session keys can point to the same generated Pi configuration.
- **Context:** AppRC owns configuration and shell provenance. Configuration writes include read-merge-replace behavior.
- **Suggested next step:** Reconcile the async startup and bounded cache with Session activation on the target. Preserve shared Pi-home serialization, fingerprint invalidation, and shell provenance. See the [workspace preparation measurements](code-smells.md#workspace-preparation-measurements) and [CSC-06C](code-smells.md#csc-06c--live-workspace-preparation-uses-synchronous-io).

## P3 / E3 [Code smell] - *Clarify model contract and documentation ownership*

- **Area:** `runtime/src/models/aliases.ts`, `runtime/src/paseo-plugin/shared/models.ts`, and `docs/Development.md`.
- **Observed while:** Comparing strict model inputs, panel DTOs, and contributor routing.
- **Why not fixed now:** The model contract and documentation should follow the actual module owners as boundaries move.
- **Evidence:** Model DTOs repeat reasoning values and fields. The panel deliberately accepts broader identifiers and projects native overrides. Contributors have only broad runtime routing guidance.
- **Context:** Preserve public aliases, provider-native overrides, and appropriate validation at each boundary.
- **Suggested next step:** Derive common declarations where deployed dependency resolution supports it, then update routing and qualification documentation in place. See [CSC-08](code-smells.md#csc-08--model-and-documentation-contracts-have-split-ownership) and [runtime decomposition](#p3--e1-code-smell---separate-runtime-composition-transport-and-coordination).

<br>

# 2026-11-25

## P2 / E2 [Question] - *Align the chat diff count with the reviewed worktree*

- **Area:** `paseo-patches/session-worktrees.patch` and Paseo's chat diff count.
- **Observed while:** Checking linked-worktree diffs in Changes.
- **Why not fixed now:** Choosing which checkout the chat count represents is separate from the default file collapse behavior.
- **Evidence:** Changes uses the focused session's worktree selection. The chat count reads `workspace.diffStat` from the original Paseo workspace.
- **Suggested next step:** Define how the chat count should respond to following and pinning. Verify that its additions and deletions use the same checkout as the Changes view it opens.

<br>

# 2026-11-24

## P3 / E3 [Tooling] - *Isolate native guidance test fixtures from host skills*

- **Area:** `tests/runtime/native/native-guidance.test.ts`
- **Observed while:** Running Traditional Tests for Immediate Context qualification.
- **Why not fixed now:** This pass covers Session Memory qualification. Fixture isolation is a separate test change.
- **Evidence:** Two native guidance tests picked up skills from the host's `~/.agents/skills`. One fixture returned unexpected skills and the other reported a duplicate skill name. Both passed with the host skill directory masked for the Bun process.
- **Context:** The Pi loader can discover host skills independently of the fixture's temporary agent and guidance directories.
- **Suggested next step:** Run the affected fixtures with isolated host skill discovery while preserving the tests that exercise an explicit shared skills directory.

## P2 / E2 [Tooling] - *Release Activity observation when native mobile hides a retained tab*
- **Area:** `runtime/src/paseo-plugin/client/screens/ActivityPanel.tsx` and Paseo's Explorer panel contract.
- **Observed while:** Checking the Activity panel's subscription lifetime against the pinned Paseo SDK.
- **Why not fixed now:** The native panel contract has no visibility event for a retained Explorer tab hidden in the foreground.
- **Evidence:** The browser panel can observe its own rendered bounds. Native clients currently release Activity observation when the app backgrounds or the panel unmounts.
- **Suggested next step:** Consume a supported host visibility signal when available. Verify that hiding Activity releases its observation and leaves background work running on native mobile.

<br>

# 2026-11-22

## P2 / E2 [Tools] - *Improve local summarizer fidelity on operational notes*
- **Area:** `runtime/src/tools/summarize.ts` and the summarization evaluations.
- **Observed while:** Checking the default LFM2.5 1.2B summarizer alongside Bonsai.
- **Evidence:** Both models remained loaded, but the summarizer sometimes omitted a filename, identifier, or negated action from the three fixed passages.
- **Qualification:** The first full LFM3 run passed 14 of 17 summary attempts. A cutoff and a reversed recovery decision failed. One semantic grade was blocked by invalid evidence. See the [baseline report](evals/summarization-baseline.md).
- **LFM3 evidence:** A retry without reasoning recovered the coding handoff in qualification and the utility comparison. The latest LFM3 run still blocked the coding grade on an invalid Bonsai source quotation. All three near-limit attempts and both rollout decisions passed. See the [cutoff and typography checks](evals/summarization-baseline.md#coding-handoff-cutoff-and-ticket-typography).
- **Spark evidence:** Spark X2.6 4B Q4_K_M on CPU timed out on all three near-limit inputs with reasoning off, a 32,768-token context and a 4,096-token output cap. GPT-6 Luna passed all five grader calibration examples at high reasoning.
- **Suggested next step:** Compare candidate prompts or generation settings against the full qualification suite before promoting a new default.

<br>

# 2026-11-16

## P1 / E1 [Tooling] - *Quiesce the detached runtime during uninstall*
- **Area:** `src/ltcook_distr/payload/app_lifecycle/actions.py`, `src/ltcook/_runtime_client.py`, and AppRC uninstall authority.
- **Observed while:** Aligning LTCook with the current AppRC lifecycle.
- **Why not fixed now:** Safe automatic shutdown needs the saved installation's listener, authentication and runtime identity under pending uninstall authority. This dependency update keeps the explicit stopped-process prerequisite instead of adding another configuration path.
- **Evidence:** The cleanup hook stops the owned Compose project but not Node. `start_runtime()` launches Node with `close_fds=True`, and the TypeScript runtime does not hold an AppRC runtime lease. AppRC's managed Python runtime quiescence therefore does not establish that the detached runtime has stopped.
- **Context:** Default uninstall removes managed state and appdata. A running Node owner can still hold its database or recreate files during removal. The removal guide now requires successful `ltcook stop` and `ltcook services stop` before removing an installation that has been started.
- **Suggested next step:** Reuse authenticated `stop_runtime()` with configuration captured from the saved uninstall placement, and fail safely before removal if the recorded runtime cannot be confirmed stopped. Extend existing lifecycle tests to cover stopped, running, unreachable and mismatched runtime identities without introducing live model calls.

## P1 / E1 [Tooling] - *Investigate intermittent Agent Evals retries*
- **Area:** `runtime/src/evals/` and `runtime/src/integrations/pi-extension.ts`
- **Observed while:** Verifying Agent Evals diagnostics in PR #4.
- **Why not fixed now:** Both setups completed, but the local model's behavior varied between runs.
- **Evidence:** With fixture v6, complete Synthetic and Current runs passed in 86.1 and 133.4 seconds respectively, with one attempt per behavior case. An earlier Current run took 308.0 seconds and required a read-only retry after a 120-second timeout. An earlier Synthetic targeted-fix attempt exceeded its tool budget before its retry failed to delegate. The subsequent scheduling instruction separates the Leader's delegation requirement from the execution Task.
- **Context:** A single passing run is an elapsed-time estimate, not evidence of consistent model behavior. Preserve actual delegation, success criteria and runtime authorization.
- **Suggested next step:** Use retained sanitized diagnostics to investigate recurring timeouts or tool loops if they continue to affect routine Agent Evals; avoid increasing repetitions by default. See [PR #10](https://github.com/markur4/LTCook/pull/10) for the current changes and verification.

<br>

---

<br>

