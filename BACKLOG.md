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

# 2026-11-22

## P2 / E2 [Tools] - *Improve local summarizer fidelity on operational notes*
- **Area:** `runtime/src/tools/summarize.ts` and the summarization evaluations.
- **Observed while:** Checking the default LFM2.5 1.2B summarizer alongside Bonsai.
- **Evidence:** Both models remained loaded, but the summarizer sometimes omitted a filename, identifier, or negated action from the three fixed passages.
- **Qualification:** The first full LFM3 run passed 14 of 17 summary attempts. A cutoff and a reversed recovery decision failed. One semantic grade was blocked by invalid evidence. See the [baseline report](evals/summarization-baseline.md).
- **Current evidence:** The expanded production-profile runs exposed a repeatable generation cutoff on the coding handoff and an intermittent near-limit omission of `AUTH-17`. Both rollout decisions passed. See the [expanded qualification](evals/summarization-baseline.md#expanded-full-qualification).
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

