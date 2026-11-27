# Repository Intelligence evaluation report

## Verification audit

| Coverage | Established by | Limits |
| --- | --- | --- |
| Workspace isolation, provider identity, path and excerpt integrity, cancellation, and bounded results | Traditional Tests for Repository Core, Search, Locate, RIED, and shared MCP | Most failure paths use controlled inputs. |
| Stale or malformed ColGREP candidates and interrupted searches | Deterministic provider and grader fixtures | Native refresh timing does not reliably produce these errors on demand. |
| Search and Locate through Pi, and Codex visibility under the current grant | Native Linux Paseo fixture with real clients and a scripted model endpoint | Requires a local Codex CLI. Native ColGREP branches also require installed managed assets. |
| Relevance, evidence recall, and post-edit index behavior | Opt-in benchmark with real ripgrep and ColGREP | Labeled miniature corpus and selected committed LTCook files. |
| Guided and autonomous tool behavior | Opt-in paired Agent Behavior Evaluation | Isolated fixture authority and limited case and model counts. |

At the time of this evaluation, the Paseo hook provided no effective Codex read
scope. LTCook withheld Search and Locate from ordinary Codex sessions using
that hook and kept the Pi grant. The isolated Codex evaluator granted its own
disposable fixture. The [workspace tools follow-up](https://github.com/markur4/LTCook/commit/f3bd72c66bf58edf286569f963dfa8696edaeeef)
restored repository tool access through the host grant.

The retrieval runner now exits unsuccessfully on invalid evidence even if
the provider reports ready. The autonomous grader evaluates structured facts,
citation validity, and retrieval coverage independently. Tool selection is
recorded without changing the task-success grade. Guided checks continue to
assert tool and mode selection.

The combined review found two more ways to give false credit. An unrelated
ready search could support a negative answer, and an empty clipped excerpt was
accepted as a matching prefix. Both now have Traditional Test regressions.
The negative fixture requires a ready workspace-wide search for credit-card
validation or Luhn evidence, regardless of tool or mode.

## Retrieval quality

Linux x64, K=5, 17 initial questions and four post-edit observations.

| Measure | Exact or literal ripgrep | Keyword ripgrep | ColGREP hybrid |
| --- | ---: | ---: | ---: |
| Identifier-group Recall@5, 5 answerable questions | 1.00 | — | 0.77 |
| Multi-file Recall@5, 3 questions | 1.00 | — | 0.61 |
| Conceptual Recall@5, 8 answerable questions | 0.00 | 0.25 | 0.38 |
| Conceptual mean reciprocal rank | — | 0.19 | 0.29 |
| Conceptual distractor Recall@5, 3 questions | 0.00 | 0.00 | 0.67 |
| Conceptual keyword-overlap Recall@5, 2 questions | 0.00 | 1.00 | 0.50 |
| German conceptual Recall@5, 1 question | 0.00 | 0.00 | 0.00 |
| Clean negatives | 3/3 | 0/2 | 0/3 |

All measured searches were ready, and none returned invalid excerpts.
Both providers found the edited identifier on its new line and then at its
renamed path. After deletion, exact search returned no matches and hybrid
returned valid but irrelevant candidates. Hybrid returned five irrelevant
hits on each of the three initial negatives. Keyword search did the same on
its two conceptual negatives. The intentionally limited multi-file query
covered zero of three ranges with exact search and one with hybrid.

The exact query took 7.2 ms cold and 4.1 ms warm. Hybrid took 1.91 s cold and
148 ms warm for the same query. Their first serialized responses were 308 and
1,022 bytes. Hybrid's isolated index build took 1.32 s and produced 699,212
bytes. The warm keyword query took 2.4 ms on a different case. These are spot
measurements with operating-system caches in place.

Retrieval run `e8dc12d8-9204-446a-94f7-ca70ba9c29bd` used source revision
`55ba75`, ripgrep 15.2.0, ColGREP 1.8.5, ONNX Runtime 1.23.0, and LateOn-Code-edge
revision `4bcdf5ed93f791259eb130b577a240f753d68dd8`. The JSON also records hashes
for the corpus, labels, implementation, and managed assets. Use the
[evaluation procedure](../docs/Development.md#repository-retrieval-evaluation)
to retain per-question JSON from a run. The
[earlier baseline](repository-retrieval-baseline.md) used a smaller corpus and
the whole-question literal control. Changes between those runs include
fixture effects.

## Agent Behavior Evaluation

The guided two-case Codex smoke passed 2/2. The autonomous comparison exposed
Search in both arms and Locate in one, using the same prompt for each pair.
It repeated the pixel question in reverse order and ran a separate simulated
provider outage. The warmed index and generated source fixture stayed fixed.

### Codex

With `gpt-6.2-sol`, all six answerable attempts returned the expected facts
with valid citations and recovered all expected labeled ranges.

| Answerable pair | Search only | Locate available | Tool calls |
| --- | ---: | ---: | --- |
| Implementation, caller, test | 13.19 s | 12.80 s | 2 / 1 |
| Pixel bounds, Locate arm first | 10.63 s | 10.47 s | 2 / 2 |
| Pixel bounds, Search arm first | 13.73 s | 14.40 s | 3 / 3 |

Codex used Locate in one of the three answerable Locate-available attempts.
Median elapsed times across these three attempts were 13.19 s and 12.80 s.
Mean serialized tool response sizes were 1,576 and 1,209 bytes. These are
context-size proxies. Both outage attempts returned insufficient evidence,
as expected, leaving the known factual answer unverified.

The answerable and outage rows use run
`a932d4d6-a672-4c32-87f8-54ef9953f629` at implementation `48260f`,
Codex CLI 0.171.0, and the same ColGREP assets as the retrieval run.

Both arms passed the negative case after the grader correction
(`3b1a3e7f-627f-44ca-9f0e-43ae52723882`, implementation `55ba75`). The
Search-only run took 59.35 s and made 13 calls. The Locate-available run took
16.58 s and made 10 calls. Ten and seven calls, respectively, returned no
new verified source lines. Neither arm repeated an identical request.
The first negative pair took 18.68 s and 14.06 s under the earlier grader.
The spread between pairs makes a latency claim premature.

### Pi

Native Pi with the installed `qwen3.5:4b-q8_0` model passed all four native
tasks in each arm. It recovered every labeled range and used Locate in all
four native attempts that offered it.

| Pair | Search only | Locate available | Outcome in both arms |
| --- | ---: | ---: | --- |
| Implementation, caller, test | 14.38 s | 12.04 s | Passed |
| Pixel bounds, Locate arm first | 14.56 s | 11.26 s | Passed |
| Credit-card validation negative | 13.43 s | 11.90 s | Passed |
| Pixel bounds, Search arm first | 13.90 s | 10.75 s | Passed |
| Pixel bounds, simulated outage | 9.41 s | 7.77 s | Reported not found |

All ten attempts reached the 16-call cap. During native tasks, the mean number
of repeated requests was 11.25 in the Search-only arm and 10.50 with Locate
available. Mean serialized result sizes were 11,458 and 14,103 bytes. Both
outage responses used `not-found`, so the factual answer stayed unverified
and both attempts failed the separate outage-handling check.

Run `0edd3b6a-9d12-471c-8773-5e15afec2237` used implementation `e0b7ab`.
Its JSON includes the Ollama model and weights digests and measured token usage.
Two earlier local trials were stopped without a completed comparison. The
Bonsai trial reached the first case's 150-second cap, and the first Qwen trial
made prolonged repeated requests. The completed run used a fixed cap and a
final-answer prompt at that limit. Its timings include that intervention.

## Verification and readiness

- 515 Traditional Tests passed, along with lint, TypeScript checks including
  the evaluation scripts, Python type checks, and the focused Linux native fixture.
  The provider benchmark passed all operational and evidence checks. Both
  guided Codex smoke cases passed.
- Pi misclassified both simulated outages and exhausted
  its request budget. The tested Codex cohort returned insufficient evidence
  in both outages.
- The ordinary test command skipped the opt-in live summarizer
  check and the pinned `brief` binary test. The native Codex fixture skips
  without a local Codex CLI. Its real ColGREP branches need managed assets.
- Native Windows and macOS, ordinary Codex source retrieval under a future
  verified host grant, and behavior with larger repositories or across more
  models and languages remain unverified. An unexpected startup exception
  or interruption can end a live cohort before it emits its JSON.

The evidence supports a narrow exact-identifier workflow in authorized Pi.
Broader conceptual workflows need stronger recall and an explicit stop
condition that distinguishes retrieval failure from lack of relevant code.
Keep the comparison descriptive until it covers more repositories and
models. A general Locate speedup remains unverified.

## Pi stopping-rule follow-up

The baseline trace showed that every answerable Pi attempt received its last
new verified source line within 2.3 seconds. Each still made 16 calls.
The native adapter delivered usable evidence. The remaining gap was when to
stop searching and how to interpret an unavailable provider.

The paired runs used the same Qwen 3.5 4B model digest, source and question fixture,
ColGREP assets, warmed index policy, and paired order.

| Design | Native task passes | Correct outage responses | 16-call safeguard reached |
| --- | ---: | ---: | ---: |
| Original cap and final-answer prompt | 8/8 | 0/2 | 10/10 |
| Expanded initial instructions | 4/8 | 1/2 | 9/10 |
| Stop on a repeat without new evidence or two unavailable calls | 8/8 | 2/2 | 0/10 |
| Final runner with batch-aware stops and bounded answer recovery | 7/8 | 2/2 | 0/10 |

The final design uses completed tool replies and request identity. It allows
a fallback after one unavailable call and asks Pi for the final answer when a
single-call repeat yields no new evidence or two consecutive calls are
unavailable. Review moved this decision after the batch completed and made
the safeguard count tool requests rejected before reaching a provider. The
runner records one bounded answer retry for invalid format or a post-stop
tool request. Factual and citation grading remains independent.

| Mean per native attempt | Search before | Search after | Locate available before | Locate available after |
| --- | ---: | ---: | ---: | ---: |
| Tool calls | 16 | 6.00 | 16 | 7.25 |
| Repeated requests | 11.25 | 1.00 | 10.50 | 1.00 |
| Elapsed time | 14.07 s | 6.17 s | 11.49 s | 6.13 s |
| Serialized tool responses | 11,458 bytes | 6,221 bytes | 14,103 bytes | 7,978 bytes |

Both final arms retrieved all five labeled ranges and correctly abstained
after reviewing the genuine negative. One Locate-available answer gave both
correct pixel bounds and attached a closing-brace citation to the upper
bound, leaving the task unverified. Both simulated outages ended after two
calls. All ten attempts used the harness stop. The result measures a stopping
intervention within the evaluation fixture. Ordinary Pi sessions need their
own verification before adopting the behavior.

The prompt-only run was `bf0122ef-31b6-49b7-b94f-b79f1d89e73a`. The first
result-driven run was `92386478-6399-473e-ac54-bf05cd71e9e6`. The final run
was `649b5edb-146c-49ab-8846-49cf75f0cea2` with implementation SHA-256
`67caf0940bcd3152753f8c518ef60e6923e2dd2c7a50c65f0e0c0346625601ff`.
The focused default Bonsai run `56e282a6-f63b-42fe-8002-ded281a212c2` also
reported insufficient evidence after two unavailable calls in each arm.
Neither final cohort needed the answer-format retry. These small cohorts
describe the measured difference. Broader model and repository
generalization remains unverified.

## Citation and native Pi follow-up

Search and Locate now present each verified source line beside its number.
The native scripted fixture checked two neighboring retry limits with distinct
labeled lines, a successful empty ripgrep search, the missing-assets response,
and one ColGREP hit. The original structured result still carries the complete
metadata and the bounded excerpt.

The same paired Qwen cohort passed all eight regular tasks with valid evidence.
Every pixel-bounds answer cited the supporting line for both facts. Both outage
attempts reported insufficient evidence. No attempt reached the 16-call
safeguard. The runner intervened in nine of ten attempts. In the four regular
tasks per arm, Search averaged 9 calls and Locate available averaged 6.25.
Each arm retrieved all five labeled ranges. These are small-cohort observations.

Paired run `e6c7d8a8-51a2-42de-83cd-1cab61d2fa98` records implementation SHA-256
`644dc151648b60ce6a1647f43a169014dc469e3c4213dab36a31e7fc387faff4`. The model,
fixture, and ColGREP assets were the same as in the stopping-rule follow-up.
The focused rerun `b42ac15a-0186-4cdc-a2eb-cb827baeb54c` passed all four
pixel-bounds attempts after review. The provider benchmark rerun
`57621842-bb6b-4484-bc06-a0a4084b1e56` reported zero operational or evidence
failures with ripgrep, the keyword baseline, and ColGREP.

The ordinary Paseo Pi run used the same local model through workspace MCP,
with Pi's built-in tools disabled for the fixture. It ran without a
final-answer prompt or retry from the harness.

| Native case | Observed outcome | Workspace tool calls |
| --- | --- | ---: |
| Stable and preview retry limits | Retrieved both labeled lines and reached the 45 s timeout without an answer. | 28 |
| Missing exact identifier | Reported `not-found` after the successful empty search. | 2 |
| ColGREP assets unavailable | Recovered through ripgrep and cited lines 2 and 3 for the correct values. | 16 |

An earlier targeted run cited both adjacent lines correctly after two tool
calls. Its incidental summarizer request exposed a fixture error that was
corrected before the run above. Another trial starting from the function name
alone found the declaration, missed the branch lines, and timed out after
repeated inventory calls.

The line rendering and adjacent-citation grader are covered by Traditional
Tests. Natural stopping is still inconsistent, including when all required
evidence has already been retrieved. The next focused behavior evaluation
should test whether Pi stops repeating searches that add no verified evidence,
while preserving useful fallback after an unavailable result.
