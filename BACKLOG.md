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

## P1 / E1 [Tooling] - *Model-backed Synthetic Agent Evals do not complete reliably*
- **Area:** `runtime/src/evals/` and `runtime/src/integrations/pi-extension.ts`
- **Observed while:** Verifying Agent Evals diagnostics in PR #4.
- **Why not fixed now:** Merge the verified diagnostic repairs while retaining the existing live failure for a focused follow-up.
- **Evidence:** The latest live Synthetic read-only run failed in 115.34 seconds: the off attempt ended without `finish_reason`; the low attempt failed because context summarization hit its output token cap. A later live Synthetic read-only run on 16 November 2026 failed after 154.53 seconds: reasoning-off reached its 120-second safeguard and the low-reasoning fallback hit the compaction summary output cap. Tests, including scripted process tests, passed.
- **Context:** Live Spark task completion remains unproven despite improved diagnostics. No live success is claimed for read-only, no-op, targeted-fix, or the complete Synthetic run.
- **Suggested next step:** Run only Synthetic read-only through the canonical CLI, inspect the retained diagnostics, fix the demonstrated cause, then verify the remaining cases individually before one complete Synthetic run. See [PR #4](https://github.com/markur4/LTCook/pull/4) for retained evidence.

<br>

---

<br>

