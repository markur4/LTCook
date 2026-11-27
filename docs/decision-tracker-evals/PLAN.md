# Hosted Decision Tracker Agent Evals

The approved Pass delivers a selectable suite and a baseline report for
Synthetic Setup and Current Setup. It establishes failure evidence before
changes to Tracker processing. [Issue #113](https://github.com/markur4/LTCook/issues/113)
owns the evaluation scope.

## Scope

- Use the production Design Decisions instructions, Hosted inference through
  Pi, Tracker service, and a disposable, file-backed conversation-products
  database. Current Setup uses the effective Hosted configuration from the
  running LTCook instance. Synthetic Setup uses a pinned Hosted profile and
  controlled input.
- Reuse the Agent Evals service, CLI, checkpoints, and reporting. Keep live
  inference opt-in and Traditional Tests offline. A CLI baseline session
  allows both setups and at most one optional diagnostic run within a shared
  20-minute deadline.
- Keep Tracker processing changes in the follow-up work identified by the
  baseline. Limit production changes here to wiring and diagnostic observation.

## Work and acceptance

1. **Budget reproduction.** Exercise the real prompt builder and estimator
   with a long user message, a long preceding reply, an expanding collection,
   and serialized requests at budget boundaries. Record provider context
   rejection separately. The first oversized case must report an Agent Eval
   failure and a durable pending event after reopening. A Traditional Test must
   pass by asserting that detection.
2. **Decision quality.** Annotate roughly 25 cases across the suite. Cover clear
   commitments, references, partial approvals, ambiguous or tentative turns,
   rejection, independent decisions, and fidelity to cited originals. Confirm
   revision identity and retraction history with fixture aliases.
3. **Reliability.** Verify coverage behind the ingestion cursor, interruption,
   restart, replay, suffix recomputation, and eventual progress without manual
   intervention. Drive one small fixture through the native Pi/Paseo timeline
   and the production source adapter.
4. **Assessment.** Inspect effective instructions and grade persisted state
   with an independent, calibrated hosted grader. Report deterministic and
   semantic results, denominators, prepared evidence, token estimates and
   provider usage, and the first substantiated failure stage. Reject a
   plausible item when its required evidence was omitted.
5. **Baseline and integration.** Run the bounded baseline, retain failures when
   later checks are blocked, and document actionable follow-ups. Propose quality
   thresholds from observed behavior and validate them on separate fixtures
   before making them qualification criteria.

## Delivery

Use one branch, worktree, and draft PR for all Tasks. The coordinator owns
shared engine and CLI wiring, verification, the baseline report, and Git
integration. Workers own the runner and fixture/grader modules in the shared
checkout. One Code Reviewer reviews the combined snapshot. Run focused offline
checks, then `just check` and the full local `just test`. Record the Hosted run
separately and integrate through the reviewed PR to `main`.
