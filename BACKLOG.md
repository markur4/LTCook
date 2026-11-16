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

# 2026-11-16

## P1 / E1 [Tooling] - *Enable clean local reinstall through the installation manager*
- **Area:** `src/ltcook_distr/payload/app_lifecycle/` and the AppRC installation inventory contract.
- **Observed while:** Preparing a clean editable reinstall.
- **Why not fixed now:** The pinned installation manager cannot represent every owned target in a safe removal inventory.
- **Evidence:** Complete-uninstall preview reports that the recorded runtime has no cleanup hook. The installed dependency tree contains symbolic links, but the manager's inventory accepts only files and directories, rejects links, and removes directories only when empty.
- **Context:** Clean prototype reinstalls must remove LTCook-owned data without following links into shared services, independent installations or external workspaces. Removing unlisted targets inside a cleanup hook would bypass the manager's exact-inventory check.
- **Suggested next step:** Add explicitly inventoried symbolic-link support to the installation manager, including identity checks and removal without following targets. Then provide LTCook's cleanup inventory and hook, and verify complete reinstall through the supported lifecycle.

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

