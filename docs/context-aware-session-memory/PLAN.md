# Context-aware Session Memory

This plan records the original implementation. Immediate Context supersedes
its production rolling-window design. Earlier qualification runs measured the
former window as a control. See the current
[Session Memory design](../Explanations.md#context-aware-session-memory).

The approved goal is to replace production excerpt extraction with chronological
UAMP and AAB summaries. Retain the native conversation as the source of
authority, keep delegation enrichment opt-in, and continue authorized original
conversation retrieval during pending work or a rewind.

## Scope and decisions

- Reuse the LTCook runtime, Paseo timeline and lifecycle, local Ollama, existing
  SQLite infrastructure, shared read authorization, and Pi evaluation harness.
- Summarize completed UAMPs and observed AABs, preserving native source IDs and
  known PPTSA links. Use planned and unplanned execution. Steering belongs to
  the initiating UAMP. Preserve ambiguous, canceled, and interrupted messages
  for original retrieval.
- Default to LFM3 QAD Q4 on CPU at temperature 0.4, top-k 50, repetition
  penalty 1.1, reasoning disabled, and a 2,048-token output cap with a
  16,384-token context. Keep independent general summarization configuration.
- Use 4,096 historical tokens, grouped eviction down to 2,048, and an
  8,000-token target including overhead. Preserve bounded portions and
  explicitly track coverage. Use the raw text of useful non-JSON responses.
- Persist pasted text on the daemon host and bind it to its original message.
  The pinned plugin API has no supported native paste hook across clients.
  Use the approved explicit paste-to-attachment control and document the
  integration limit. Use supported draft and attachment surfaces.
- Invalidate the dependent summary suffix on source changes. If an exact
  surviving boundary is unavailable, rebuild the affected agent history from
  authorized originals. Apply the prototype breaking-change rule to derived
  memory state.
- Keep the previous extractive implementation available only for measurement.
  Compare extraction, token-bounded abstractive summarization, UAMP/AABs
  without history, UAMP/AABs with history, and original-only retrieval.
  Use fixed workers, flag failed source controls as inconclusive, and preserve
  diagnostic reasoning separately.

## Execution, verification, and integration

Implement source units and prompts, chronological state and delegation,
attachments, documentation and diagrams, then the matched evaluations. Keep
the active checklist beside this plan. Use the existing runtime Traditional
Tests, native Pi acceptance, and existing Agent Evals with targeted fixtures.
Measure semantic retention, source attribution, context reduction, cache
reuse, request and queue timings, RAM, and foreground interference. Repeat
borderline and failing cases selectively and report limitations explicitly.

Use the shared pass branch and one draft PR. Review the integrated pass
snapshot once, check the full local suite before integration, and follow
the repository's committed CI policy. Integration targets the configured
upstream of the main checkout. No release is in scope.

## Simplify Session Memory

**Goal:** Reduce CPU inference cost and factual errors while retaining Discussion,
execution evidence and delegation context.

**Specifics:** Record AABs deterministically in the existing SQLite store. Use
Paseo's canonical timeline to resolve original action references on demand.
Preserve exact recognized outcomes, including failures followed by successes.
Expose bounded execution cards, search evidence and delegation context. Put
standalone or multiple-turn AABs in the chronological viewer once.

Retain completed UAMPs below 256 estimated tokens with references to their
originals. Count user messages, final replies and supplied attachment text once.
Summarize larger UAMPs in Markdown with Intent, Pasted, Discoveries,
Disagreements, Decisions, and Questions when relevant. Use the existing input
budget. Keep raw output and derive sections for display and retrieval. Continue
deterministic recording while inference is paused. Preserve the Immediate
Context budget, use one preceding summary with bounded skipped originals, and
verify approval references across Discussion and Task scope.

Extend the existing Traditional Tests and Agent Evals. Compare JSON
summarization of all units, JSON UAMPs with deterministic records and the
threshold, and Markdown UAMPs with the same records and threshold. Match the
corpus, pin LFM3 QAD Q4 to seed 17 and verify CPU placement with production
inference suspended. Measure inference requests, prefill and generation, CPU
wall time, record and delegation sizes. Aim for a 30% reduction in requests
and CPU wall time. Keep original references, attachment access, restart,
rewind and existing Pi/Paseo acceptance covered. Use the approved Luna high
fallback for downstream Pi Agent Evals when the host has no usable GPU.

The generated-summary layer must preserve every critical fact assigned to a
summarized UAMP, including approved and rejected work and resolved references.
Session Memory records collectively must preserve 14/14 critical facts before
compensatory source recovery. Resolving a skipped UAMP or AAB source reference
is ordinary record access. The assembled delegation handoffs must also
preserve 14/14 facts and may use additional original sources. Require zero
critical contradictions in every layer. The pass may replace the derived
database with v5. Follow the same integration route and preserve native history.
