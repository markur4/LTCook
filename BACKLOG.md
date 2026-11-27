# Backlog

Use this file to organize actionable, issue-backed work into planned Passes in
execution order. Keep full issue details in GitHub and link every actionable
entry to its issue.


<br>

> [!CAUTION]
> This is git-tracked: Never record secrets, absolute paths, credentials, private host data, or speculative security claims. Use only relative paths. 


> [!IMPORTANT]
> Follow the shared [Issues and backlog rules](CONTRIBUTING.md#issues-and-backlog)
> when creating, scheduling, updating, and completing work. Preserve this header,
> the table of contents, `## Ignore`, and the privacy rules above.



<br>

---

<br>

## Table Of Contents

1. [Backlog](#backlog)
   1. [Table Of Contents](#table-of-contents)
   2. [Ignore](#ignore)
   3. [Architecture follow-ups](#architecture-follow-ups)
2. [Planned Pass 1 — Managed tool authorization](#planned-pass-1--managed-tool-authorization)
   1. [P2 / E1 \[Code smell\] - *Give managed tool classification and bound-member lookup explicit owners*](#p2--e1-code-smell---give-managed-tool-classification-and-bound-member-lookup-explicit-owners)
3. [Planned Pass 2 — Runtime composition and coordination](#planned-pass-2--runtime-composition-and-coordination)
   1. [P3 / E1 \[Code smell\] - *Separate runtime composition, transport and coordination*](#p3--e1-code-smell---separate-runtime-composition-transport-and-coordination)
   2. [P3 / E2 \[Code smell\] - *Give LTCook Services and container deployment distinct homes*](#p3--e2-code-smell---give-ltcook-services-and-container-deployment-distinct-homes)
4. [Planned Pass 3 — Session Memory and model contracts](#planned-pass-3--session-memory-and-model-contracts)
   1. [P3 / E3 \[Code smell\] - *Clarify model contract and documentation ownership*](#p3--e3-code-smell---clarify-model-contract-and-documentation-ownership)
5. [Planned Pass 4 — Detached runtime uninstall](#planned-pass-4--detached-runtime-uninstall)
   1. [P1 / E1 \[Tooling\] - *Quiesce the detached runtime during uninstall*](#p1--e1-tooling---quiesce-the-detached-runtime-during-uninstall)
6. [Planned Pass 5 — Paseo review and Activity](#planned-pass-5--paseo-review-and-activity)
   1. [P2 / E2 \[Question\] - *Align the chat diff count with the reviewed worktree*](#p2--e2-question---align-the-chat-diff-count-with-the-reviewed-worktree)
   2. [P2 / E2 \[Tooling\] - *Release Activity observation when native mobile hides a retained tab*](#p2--e2-tooling---release-activity-observation-when-native-mobile-hides-a-retained-tab)
   3. [P2 / E2 \[Tooling\] - *Make effective Codex approval settings visible in Paseo*](#p2--e2-tooling---make-effective-codex-approval-settings-visible-in-paseo)
7. [Planned Pass 6 — Qualification and fixture maintenance](#planned-pass-6--qualification-and-fixture-maintenance)
   1. [P3 / E3 \[Tooling\] - *Isolate native guidance test fixtures from host skills*](#p3--e3-tooling---isolate-native-guidance-test-fixtures-from-host-skills)
   2. [P2 / E2 \[Tools\] - *Improve local summarizer fidelity on operational notes*](#p2--e2-tools---improve-local-summarizer-fidelity-on-operational-notes)
8. [Planned Pass 7 — Agent Evals reliability](#planned-pass-7--agent-evals-reliability)
   1. [P1 / E1 \[Tooling\] - *Investigate intermittent Agent Evals retries*](#p1--e1-tooling---investigate-intermittent-agent-evals-retries)
9. [Deferred](#deferred)
   1. [P3 / E1 \[Question\] - *Measure authorized conversation retrieval scaling*](#p3--e1-question---measure-authorized-conversation-retrieval-scaling)

<br>

---

<br>

## Ignore
- `publications/`

## Architecture follow-ups

The [CSC report](code-smells.md) has the findings and verification evidence. The Explorer prerequisite shipped in [PR #62](https://github.com/markur4/LTCook/pull/62), and async workspace preparation shipped in [PR #75](https://github.com/markur4/LTCook/pull/75), recorded in [issue #99](https://github.com/markur4/LTCook/issues/99).

<br>

---

<br>

# Planned Pass 1 — Managed tool authorization

Independent production-profile Session Memory recovery coverage (CSC-03 and CSC-07) can proceed alongside this Pass. Preserve the existing recovery baseline.

## P2 / E1 [Code smell] - *Give managed tool classification and bound-member lookup explicit owners*
- **Issue:** https://github.com/markur4/LTCook/issues/96
- **Area:** `runtime/src/tools`, `runtime/src/core`, `runtime/src/integrations/native-policy.ts`, and `runtime/src/integrations/runtime-api.ts`.
- **Observed while:** Reviewing managed authorization across native tool invocation.
- **Why not fixed now:** Explorer delivery and subsequent Memory work have separate scope.
- **Evidence:** Tool classification and bound-member lookup have an explicit targeted path. The native precheck still handles identities absent from the Pi call hook.
- **Context:** Keep role, Pass approval, workspace grants and Memory peer scope separate. CSC-01/05/06A.
- **Suggested next step:** Verify the scoped authority boundary before [runtime decomposition](https://github.com/markur4/LTCook/issues/97) and Memory extraction.

<br>

---

<br>

# Planned Pass 2 — Runtime composition and coordination

## P3 / E1 [Code smell] - *Separate runtime composition, transport and coordination*
- **Issue:** https://github.com/markur4/LTCook/issues/97
- **Area:** `runtime/src/main.ts`, `runtime/src/integrations/runtime-api.ts`, `runtime/src/integrations/mcp.ts`, and `runtime/src/core/runtime.ts`.
- **Observed while:** Tracing shared runtime construction and HTTP/MCP dispatch.
- **Why not fixed now:** The remaining Core boundaries and error propagation need focused work.
- **Evidence:** The controller still combines policy, lifecycle, delivery and projection. Some adapters lose failure details.
- **Context:** Preserve startup, approval, review and uncertain-send boundaries. CSC-02/04/09.
- **Suggested next step:** Continue Core and transport extraction after [tool authorization](https://github.com/markur4/LTCook/issues/96), then preserve actionable adapter failures.

## P3 / E2 [Code smell] - *Give LTCook Services and container deployment distinct homes*
- **Issue:** https://github.com/markur4/LTCook/issues/95
- **Area:** `runtime/src/session-memory/`, `runtime/src/services/`, `runtime/src/repository/`, `services/`, and `docs/`.
- **Observed while:** Reviewing ownership of runtime Services and containers.
- **Why not fixed now:** The approved moves follow the next CSC milestone.
- **Evidence:** Services and external Compose deployment currently share ambiguous locations.
- **Context:** Keep runtime Services under the single runtime, separate from container deployment and repository indexing.
- **Suggested next step:** Coordinate the directory moves and affected packaging and docs with [runtime decomposition](https://github.com/markur4/LTCook/issues/97).

<br>

---

<br>

# Planned Pass 3 — Session Memory and model contracts

Start Session Memory extraction (CSC-03 and CSC-07) after production-profile recovery coverage. Preserve historical qualification variants and verify packaged plugin loading where dependencies change. Coordinate CSC-08 with those boundary changes when the evidence supports it.

## P3 / E3 [Code smell] - *Clarify model contract and documentation ownership*
- **Issue:** https://github.com/markur4/LTCook/issues/100
- **Area:** `runtime/src/models/aliases.ts`, `runtime/src/paseo-plugin/shared/models.ts`, and `docs/Development.md`.
- **Observed while:** Reviewing package and model documentation ownership.
- **Why not fixed now:** Coordinate ownership changes with the relevant boundary work.
- **Evidence:** The architecture review identified split model and documentation contract ownership.
- **Suggested next step:** Carry forward CSC-08 where [runtime decomposition](https://github.com/markur4/LTCook/issues/97) produces a concrete boundary change.

<br>

---

<br>

# Planned Pass 4 — Detached runtime uninstall

## P1 / E1 [Tooling] - *Quiesce the detached runtime during uninstall*
- **Issue:** https://github.com/markur4/LTCook/issues/105
- **Area:** `src/ltcook_distr/payload/app_lifecycle/actions.py`, `src/ltcook/_runtime_client.py`, and AppRC uninstall authority.
- **Observed while:** Aligning uninstall with the AppRC lifecycle.
- **Why not fixed now:** Automatic shutdown needs authenticated listener and runtime identity.
- **Evidence:** Cleanup stops Compose. The detached Node runtime can remain live while uninstall removes managed state.
- **Context:** The removal guide requires explicit stop commands today.
- **Suggested next step:** Reuse the authenticated runtime stop path and fail safely when the recorded runtime cannot be confirmed stopped.

<br>

---

<br>

# Planned Pass 5 — Paseo review and Activity

## P2 / E2 [Question] - *Align the chat diff count with the reviewed worktree*
- **Issue:** https://github.com/markur4/LTCook/issues/101
- **Area:** `paseo-patches/session-worktrees.patch` and Paseo's chat diff count.
- **Observed while:** Comparing chat UI diff counts with a reviewed worktree.
- **Why not fixed now:** The mismatch requires tracing the two consumers’ inputs.
- **Evidence:** The chat count and reviewed worktree showed different scope.
- **Suggested next step:** Align their worktree and base selection.

## P2 / E2 [Tooling] - *Release Activity observation when native mobile hides a retained tab*
- **Issue:** https://github.com/markur4/LTCook/issues/103
- **Area:** `runtime/src/paseo-plugin/client/screens/ActivityPanel.tsx` and Paseo's Explorer panel contract.
- **Observed while:** Reviewing native mobile retained tabs.
- **Why not fixed now:** The hidden-tab observation lifecycle is separate work.
- **Evidence:** A retained tab can keep Activity observation while hidden.
- **Suggested next step:** Release observation on hide and restore it at the appropriate resume boundary.

## P2 / E2 [Tooling] - *Make effective Codex approval settings visible in Paseo*
- **Issue:** https://github.com/markur4/LTCook/issues/94
- **Area:** Paseo's Codex app-server adapter and [LTCook's Paseo host configuration](runtime/src/integrations/paseo.ts).
- **Observed while:** Diagnosing a blocked default-branch integration.
- **Why not fixed now:** Diagnostic changes require separate scope.
- **Evidence:** A Paseo agent’s active mode can override the CLI defaults.
- **Context:** Expose the mode’s source alongside the effective approval and sandbox choices.
- **Suggested next step:** Trace fresh and resumed modes and expose their computed settings in existing diagnostics.

<br>

---

<br>

# Planned Pass 6 — Qualification and fixture maintenance

## P3 / E3 [Tooling] - *Isolate native guidance test fixtures from host skills*
- **Issue:** https://github.com/markur4/LTCook/issues/102
- **Area:** `tests/runtime/native/native-guidance.test.ts`
- **Observed while:** Running the Traditional Tests for native guidance.
- **Why not fixed now:** The fixture isolation is separate from product changes.
- **Evidence:** Host guidance can make isolated fixture counts depend on the machine.
- **Context:** Use hermetic inputs for native guidance fixtures.
- **Suggested next step:** Isolate the fixtures from host skills and rerun the existing suites.

## P2 / E2 [Tools] - *Improve local summarizer fidelity on operational notes*
- **Issue:** https://github.com/markur4/LTCook/issues/104
- **Area:** `runtime/src/tools/summarize.ts` and the summarization evaluations.
- **Observed while:** Qualifying local summarizers with fixed operational passages.
- **Why not fixed now:** Candidate settings need comparison in the existing qualification suite.
- **Evidence:** Some attempts omitted operational identifiers or reversed a recovery decision.
- **Suggested next step:** Compare prompts or generation settings using the existing qualification before changing the default.

<br>

---

<br>

# Planned Pass 7 — Agent Evals reliability

## P1 / E1 [Tooling] - *Investigate intermittent Agent Evals retries*
- **Issue:** https://github.com/markur4/LTCook/issues/106
- **Area:** `runtime/src/evals/` and `runtime/src/integrations/pi-extension.ts`
- **Observed while:** Verifying Agent Evals diagnostics.
- **Why not fixed now:** The evidenced retries need focused diagnosis.
- **Evidence:** Repeated runs varied in attempts and blocking behavior.
- **Context:** Use retained sanitized diagnostics.
- **Suggested next step:** Investigate recurring timeouts or tool loops before raising routine repetition.

<br>

---

<br>

# Deferred

## P3 / E1 [Question] - *Measure authorized conversation retrieval scaling*
- **Issue:** https://github.com/markur4/LTCook/issues/98
- **Area:** `runtime/src/session-memory/conversation.ts` and `runtime/src/integrations/paseo-memory.ts`.
- **Observed while:** Measuring authorized retrieval on the local Paseo pilot.
- **Why not fixed now:** The current implementation met the measured deadlines and recall checks.
- **Evidence:** Exact lookup remained bounded while targeted broad search traversed more history.
- **Suggested next step:** Reassess indexing only when representative loads show missed deadlines or recall loss. CSC-06B.
