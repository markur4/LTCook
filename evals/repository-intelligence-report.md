# Repository Intelligence evaluation report

## Verification audit

| Coverage | Established by | Limits |
| --- | --- | --- |
| Workspace isolation, provider identity, path and excerpt integrity, cancellation, and bounded results | Traditional Tests for Repository Core, Search, Locate, RIED, and shared MCP | Most failure paths use controlled inputs. |
| Stale or malformed ColGREP candidates and interrupted searches | Deterministic provider and grader fixtures | Native refresh timing does not reliably produce these errors on demand. |
| Search and Locate through Pi, and Codex visibility under the current grant | Native Linux Paseo fixture with real clients and a scripted model endpoint | Requires a local Codex CLI. Native ColGREP branches also require installed managed assets. |
| Relevance, evidence recall, and post-edit index behavior | Opt-in benchmark with real ripgrep and ColGREP | Labeled miniature corpus and selected committed LTCook files. |
| Guided and autonomous tool behavior | Opt-in paired Agent Behavior Evaluation | Isolated fixture authority and limited case and model counts. |

The current Paseo hook provides no effective Codex read scope. LTCook now
withholds Search and Locate from ordinary Codex sessions using that hook and
keeps the Pi grant. The isolated Codex evaluator grants its own disposable
fixture. A supported host read grant is needed to restore the ordinary Codex
path. See [the follow-up](../BACKLOG.md#2026-11-24).

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
models. The observed timing differences do not establish a general Locate
speedup.
