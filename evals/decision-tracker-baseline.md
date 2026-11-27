# Hosted Decision Tracker Agent Evals baseline

## Deterministic reproduction

The offline CLI run `c241a6d5-e540-4d16-b9c4-986d972d2f20` at `48d78b9`
reproduced the current preflight budget failure. The first request estimated
18,501 tokens against an 8,000-token allowance. After reopening the database,
Tracker's ingestion cursor was at 2. Turn 1 had `incomplete / budget` coverage
and turn 2 remained `pending`. There were zero inference requests, items, or
revisions. The Agent Eval reported `FAILED`. The Traditional Test passed by
checking that this behavior fails the automatic-progress contract.

| Deterministic case | Estimated input | Local limit | Observed |
| --- | ---: | ---: | --- |
| Oversized user message | 18,501 | 8,000 | Preflight gap and later pending turn persisted |
| Large preceding assistant reply | 15,199 | 8,000 | Preflight gap |
| Large existing collection | 31,147 | 8,000 | Preflight gap |
| One token above the limit | 1,178 | 1,177 | Request rejected before inference |
| At the limit | 1,178 | 1,178 | Request reached inference and committed the decision |
| One token below the limit | 1,178 | 1,179 | Request reached inference and committed the decision |
| Scripted provider context rejection | 1,178 | 8,000 | Reached the provider boundary, then recorded a transient failure |

The missing-proposal control committed a plausible 30-second retry decision
while its inference request omitted the original proposal. The evaluation
reported `FAILED` at evidence selection even though the Notebook had an item
and Tracker marked the turn as changed. The native timeline case passed with
a real Pi/Paseo timeline and disposable SQLite state.

## Hosted baseline

The final baseline on `18b7f4f` completed both sets of 29 scenarios in
8 minutes 35 seconds, including the two independent grader calibrations
and semantic Instruction Audits. Both used Hosted GPT-6 Luna at low
reasoning for extraction, GPT-6.1 Sol at high reasoning for grading, and
an 8,000-token input limit for the ordinary fixtures. Synthetic Setup
pinned that profile. Current Setup resolved the same values from the
running instance. Both graders passed the two development and two
held-out examples. Every live case was graded.

| Result | Synthetic Setup | Current Setup |
| --- | ---: | ---: |
| Elapsed | 262.02 s | 252.34 s |
| Scenarios passed / failed / blocked | 21 / 8 / 0 | 21 / 8 / 0 |
| Semantic cases passed / failed / blocked | 13 / 2 / 0 | 13 / 2 / 0 |
| Decision precision | 9/13 | 9/14 |
| Explicit-decision recall | 5/6 | 5/6 |
| Indirect-decision recall | 4/5 | 4/5 |
| Information fidelity | 10/15 | 10/15 |
| Revision accuracy | 1/2 | 1/2 |
| Extraction coverage | 70/77 | 70/77 |
| Recovery correctness | 8/14 | 8/14 |
| Idempotency checks | 4/4 | 4/4 |
| Tracker input / output tokens reported by provider | 17,696 / 1,043 | 17,697 / 881 |

- Synthetic run `192a35a7-2771-4d85-9364-e3ca73d2c984`
- Current run `b1fea133-2e76-48f3-b899-4ce0f9d6bb95`
- Effective Tracker instruction hash
  `f68021ca3d206b41dfbde4ed3948f6be1ea41fdff7d48203fb4e74bbc3cf9184`
- Fixture hash
  `5a96cc01abe8fb5ba08e7c697f0ab546b8468d0e8994ef2fdfc6b3fcaa867c2b`

The complete per-run checkpoints include expected and observed Notebook
state, decision-level evidence, revisions and IDs, individual request
hashes and token estimates, and the claims evaluated by the grader.
The earlier Hosted attempt exposed a grader catalog problem. Synthetic
run `b5905547-4ae8-40aa-8518-b4e2b616f55d` had blocked grading and the
Current run was cancelled before Hosted inference. Selecting a distinct
model supported by the pinned Pi catalog resolved that setup problem for
the final baseline.

## Instruction Audit and Behavior Evaluation

Static checks passed in both setups. Both semantic audits identified
ambiguity between future-tense commitments and tentative intentions,
a conflict between the item-independence rule and the indexing revision
example, and the lack of a specific rule for retirement after withdrawal.
The suggested interpretations need review against the intended policy.

| Case | Expected Notebook | Observed in both setups |
| --- | --- | --- |
| Partial acceptance | One accepted retry interval citing proposal 1 and acceptance 2 | The retry item cited only message 2, although proposal 1 was available. Current Setup also stored a negative index directive. |
| Conditional backfill | One item containing the region, rationale, availability condition, and account exception | The region and rationale were stored separately from audit-read availability and the exception. |
| Retraction | Retire the existing active item and preserve its revision history | Tracker kept an active item and rewrote it to describe removing the endpoint. |

Read the item-boundary results in light of the audit findings.
The partial-acceptance fixture's negative directive can read as a separate
decision. The backfill wording can read as two independently revisable
instructions. Tighten those labels and phrasings on separate fixtures
before using these scores as quality gates. The missing citation is a
separate failure even when that additional item is considered supported.

## Bottleneck Attribution and follow-up

- **Context budgeting.** Four scenarios failed before Hosted inference.
  Design bounded processing that advances extraction coverage while
  retaining pending evidence and its source references across restarts.
- **Evidence selection.** The omitted-proposal control reached persistence
  with a plausible item. Resolve required references before committing
  complete coverage for a decision that depends on them.
- **Hosted extraction and instruction policy.** The three live discrepancies
  occurred after successful inference reached the Notebook. Review partial
  approval, related conditions, and standalone retractions. The observed
  discrepancies do not establish a persistence defect.
- **Recovery.** The native fixture, committed replay, and deliberate suffix
  recomputation passed. The stalled budget cases account for the uncompleted
  automatic-progress checks. Keep ingestion, extraction coverage, and
  decision identity independently observable.

[Issue #116](https://github.com/markur4/LTCook/issues/116) tracks the bounded
processing follow-up. For a separate held-out corpus, candidate targets
are at least 90% each for precision and both recall measures, and at least
95% for annotated facts. These are proposed targets. The baseline's small
denominators and disputed case boundaries cannot validate them. Coverage
loss, false completion, unintended identity changes, and runtime errors
stored as decisions are strict correctness failures.

The shared deadline stops new Hosted cases. If it expires during startup
or shutdown of the scripted native fixture, Paseo cleanup can delay the
terminal report.

## Reproduce

```shell
ltcook eval run --case decision-tracker --setup synthetic --deterministic-only
ltcook eval run --all --case decision-tracker --baseline
```
