# Session Memory CPU and repository-edit evaluation

Keep `LiquidAI/lfm2.5-1.2b-instruct:q8_0` as the recommended extractor for
opt-in Session Memory. It recovered after reaching the output limit and
completed more long-transcript updates in both sampling profiles. LFM3 QAD Q4
was the fastest on the matched warm requests and used the least memory. Both
LFM3 variants retained the cache opener path and symbol that LFM2.5 missed.
All three missed critical evidence. Deterministic search can retrieve omitted
messages directly from Paseo.

The [focused follow-up](#focused-follow-up-with-a-2048-token-cap) found that
both LFM3 variants passed the long fixture at temperature 0.4 with a
2,048-token cap. QAD Q4 used about half the request time of Q8 and less RAM.
The [full QAD Q4 qualification](#full-qad-q4-qualification) subsequently
passed all extraction and hybrid Pi checks. The invoice original-source
control failed and prevented full qualification.

## Sampling settings and reasoning

The original comparison explicitly sent `temperature: 0`. Both LFM3 Ollama
tags ship with temperature 0.1, top-k 50, and a repetition penalty of 1.1.
The original requests inherited the latter two values and overrode the
temperature. Liquid AI recommends all three values together for general
inference on the LFM3 GGUF models, including QAD Q4. The LFM2.5 Instruct
recipe uses the same temperature and top-k with a repetition penalty of 1.05.
[LFM3 GGUF model card](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF#how-to-run-lfm3-17b),
[LFM2.5 Instruct model card](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct)

Pass `--recommended-sampling` to apply those three parameters explicitly to
each candidate. Both profiles request `think: false` and `num_gpu: 0`.
Reasoning token counts come from the generated token log and the returned
answer and thinking fields. [Ollama chat API](https://docs.ollama.com/api/chat)

## Rerun with recommended sampling

```sh
bun evals/session-memory-live.ts --extract-only --include-cadence --recommended-sampling
```

This reruns the same extraction corpus with the same prompt, schema, context
and output limits. All three candidates use temperature 0.1 and top-k 50.
The repetition penalty is 1.05 for LFM2.5 and 1.1 for both LFM3 variants.
The JSON report includes each candidate's request settings and per-request
reasoning token counts. The rerun used the same Linux host, Ollama version,
model manifest digests, and corpus hash as the original comparison. It took
484.10 seconds and used one run per fixture with Ollama's default seed setting.

Ollama reported zero GPU bytes for all 26 requests. The generated token logs
verified zero reasoning tokens in 25 requests. The final LFM3 Q8 request for
messages 43–92 reached the output limit and its token log could not be
reconciled with the returned answer. Its reasoning token count is unknown.
All 26 requests sent `think: false` and returned no thinking text.

| Extraction result | LFM2.5 1.2B Instruct Q8 | LFM3 1.7B Q8 | LFM3 1.7B QAD Q4 |
| --- | ---: | ---: | ---: |
| Short-workflow facts retained | 14/14 | 14/14 | 14/14 |
| Short-workflow fact categories mismatched | 7 | 6 | 6 |
| Valid short outputs | 5/5 | 5/5 | 5/5 |
| Valid long outputs | 2/3 | 1/4 | 1/4 |
| Valid outputs overall | 7/8 | 6/9 | 6/9 |
| Long-transcript facts retained | 3/5 | 2/5 | 2/5 |
| Long-transcript critical facts retained | 1/3 | 2/3 | 2/3 |
| Final long-transcript checkpoint | 92 | 42 | 42 |
| Requests with verified zero reasoning tokens | 8/8 | 8/9 | 9/9 |

No labeled contradiction or source misattribution was observed. LFM2.5 hit
the 768-token cap on messages 1–42, then produced valid updates through
messages 51 and 90. The final two messages advanced its checkpoint to 92
without an inference request. It retained the schema mismatch, version guard
result, and preserved cache bytes. Both LFM3 variants retained the cache
opener path and symbol in the first update, then hit the output cap on all
three subsequent attempts. The retained facts and checkpoint behavior were
the same under both sampling profiles. QAD Q4 had one more short-workflow
category mismatch at temperature 0.1 than at temperature zero.

| CPU measurement | LFM2.5 1.2B Instruct Q8 | LFM3 1.7B Q8 | LFM3 1.7B QAD Q4 |
| --- | ---: | ---: | ---: |
| Warm short prefill | 4.02 s | 8.50 s | 4.67 s |
| Warm short generation | 19.69 s | 20.97 s | 12.37 s |
| Warm short request latency | 23.74 s | 29.50 s | 17.07 s |
| Warm short generated tokens | 714 | 500 | 497 |
| Cold first short request latency | 4.12 s | 8.68 s | 5.50 s |
| First long batch prefill | 11.94 s | 19.79 s | 12.18 s |
| First long batch generation | 25.96 s | 24.32 s | 15.01 s |
| First long batch request latency | 37.92 s | 44.12 s | 27.21 s |
| Total long request latency | 99.20 s | 182.13 s | 114.05 s |
| Ollama CPU residency | 1.62 GB | 2.02 GB | 1.23 GB |
| Peak runner RSS | 1.75 GB | 2.43 GB | 1.63 GB |

Warm short timings sum four requests matched on fixture, message range, and
zero cached input tokens. Each model was resident for all four. The first
long batch, messages 1–42, was also warm and uncached for all three. Total long
request latency includes the different retries and cache reuse after that
batch. Residency and peak RSS use decimal GB.

## Focused follow-up with a 2,048-token cap

The 92-message cache-recovery transcript was the only fixture that failed
qualification in the recommended-sampling comparison. All three candidates
reran that fixture at temperatures 0.1 and 0.4, with an output cap of 2,048
tokens, CPU-only inference, and `think: false`. Both arms retained top-k 50,
the model-specific repetition penalties, the 16,384-token context, and the
same prompt, schema and cadence. The higher temperature tests a sampling
hypothesis from a community report on a parentheses question that used the
STEM preset. [Hugging Face discussion](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF/discussions/6)

```sh
bun evals/session-memory-live.ts --extract-only --cadence --recommended-sampling --output-cap=2048 > cap2048-temp01.json
bun evals/session-memory-live.ts --extract-only --cadence --recommended-sampling --output-cap=2048 --temperature=0.4 > cap2048-temp04.json
```

| Temperature | Extractor | Valid updates | Output cutoffs / timeouts | Checkpoint | Facts retained | Critical facts retained | Fixture |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 0.1 | LFM2.5 Instruct Q8 | 3/3 | 0 / 0 | 92 | 1/5 | 0/3 | Fail |
| 0.1 | LFM3 Q8 | 1/4 | 0 / 3 | 42 | 2/5 | 2/3 | Fail |
| 0.1 | LFM3 QAD Q4 | 1/4 | 1 / 2 | 42 | 2/5 | 2/3 | Fail |
| 0.4 | LFM2.5 Instruct Q8 | 3/3 | 0 / 0 | 92 | 1/5 | 0/3 | Fail |
| 0.4 | LFM3 Q8 | 3/3 | 0 / 0 | 92 | 4/5 | 3/3 | Pass |
| 0.4 | LFM3 QAD Q4 | 3/3 | 0 / 0 | 92 | 4/5 | 3/3 | Pass |

The higher cap at 0.1 let LFM2.5's first batch finish, which changed its
subsequent batch boundaries. It retained only the schema mismatch. Both
LFM3 variants still stalled at message 42. QAD Q4's last request returned
after generating all 2,048 tokens, and five LFM3 requests reached the
120-second deadline.

At 0.4, both LFM3 models retained the opener path, opener symbol, version
guard result and preserved cache bytes. Both missed the schema mismatch.
There were no contradictions or wrong sources. QAD Q4 mismatched the
category of all three critical facts. Q8 mismatched the categories of the
guard result and the noncritical cache-bytes fact. Category mismatches are
tracked separately from the fixture's qualification gate.

| Temperature | Extractor | Prefill measured | Generation measured | Total request latency | Peak runner RSS |
| ---: | --- | ---: | ---: | ---: | ---: |
| 0.1 | LFM2.5 Instruct Q8 | 27.10 s | 72.48 s | 100.94 s | 1.77 GB |
| 0.1 | LFM3 Q8 | 20.55 s | 26.33 s | 409.56 s | 2.39 GB |
| 0.1 | LFM3 QAD Q4 | 21.05 s | 117.91 s | 382.55 s | 1.59 GB |
| 0.4 | LFM2.5 Instruct Q8 | 33.38 s | 52.80 s | 87.90 s | 1.75 GB |
| 0.4 | LFM3 Q8 | 45.00 s | 150.32 s | 197.81 s | 2.45 GB |
| 0.4 | LFM3 QAD Q4 | 27.57 s | 69.78 s | 99.05 s | 1.65 GB |

Prefill and generation sums cover responses that returned timing data. Total
request latency includes timeouts and model loads. A short local type check
overlapped the first Q8 timeout at 0.1. All first requests at 0.4 were cold,
and all three batches matched by message range and zero cached tokens. On
the longest batch, Q8 took 118.24 seconds within the 120-second deadline.
QAD Q4 took 43.27 seconds on the same batch. Their successful responses
generated 1,753 and 995 tokens respectively, both above the old cap. Ollama
reported 1.62 GB, 2.02 GB, and 1.23 GB of loaded memory respectively for the
three models.

Ollama verified CPU residency throughout. Token logs verified zero reasoning
tokens in all nine requests at 0.4 and in the six returned responses at 0.1.
The five timeouts have no reasoning counts. The two runs used the same model
manifests and cadence corpus SHA-256
`09461ba3abb041b0480998da59ffa89a2518c2ff5001ac8c590b23985c88c348`.
The 0.1 and 0.4 runs took 893.41 and 384.82 seconds respectively. The result
reflects one sampled execution per candidate and temperature.

### Full QAD Q4 qualification

The full run used QAD Q4 on CPU for extraction and both native Pi handoff
arms. Each request started with reasoning off at temperature 0.4 and kept
the 2,048-token cap on retries. The runner retries a failed extraction
batch or handoff once using the same model's Boolean thinking mode. The
original-source control and hybrid Pi handoff both count toward the
qualification verdict.

```sh
bun evals/session-memory-live.ts lfm3:1.7b-qad-q4_0 lfm3:1.7b-qad-q4_0 --include-cadence --recommended-sampling --output-cap=2048 --temperature=0.4 --reasoning-fallback
```

| Fixture | Extraction latency | Pi original-source latency | Pi hybrid latency | Combined latency | Fixture verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| Invoice replay | 6.78 s · Pass | 61.44 s · Fail | 4.51 s · Pass | 72.73 s | Fail |
| Paseo rewind | 5.93 s · Pass | 2.91 s · Pass | 4.06 s · Pass | 12.89 s | Pass |
| Cache recovery, short | 12.96 s · Pass | 4.15 s · Pass | 5.32 s · Pass | 22.42 s | Pass |
| Cache recovery, 92 messages | 91.99 s · Pass | 3.99 s · Pass | 5.64 s · Pass | 101.61 s | Pass |
| **Total** | **117.65 s · 4/4** | **72.48 s · 3/4** | **19.52 s · 4/4** | **209.65 s** | **3/4** |

Latencies sum model request times, including retries. The runner took
209.80 seconds. It verified CPU residency for each request and confirmed
the model manifest stayed fixed. All eight extraction requests returned
valid outputs with zero measured reasoning tokens.

The only thinking retry was the invoice original-source control. The
reasoning-off attempt took 5.11 seconds and gave incorrect values for
`acceptanceTest` and `emptyBatchCursor`. The retry took 56.33 seconds and
reached the 2,048-token cap without a complete answer. The hybrid invoice
handoff supplied correct values for every field on its reasoning-off
attempt. No check passed on a thinking retry.

### Low-reasoning fallback in native Pi

LFM3's Ollama artifacts advertise Boolean thinking controls. To test an
actual low-effort setting, native Pi reran the failed batches from the
earlier 768-token recommended-sampling report with GPT-6 Luna via the
existing Codex sign-in. Identical message ranges shared one retry. Pi received
the same extraction instructions and numbered excerpts with the output schema
in its system prompt. The same parser and fact grader evaluated each batch.
[Ollama thinking controls](https://docs.ollama.com/capabilities/thinking)

```sh
bun evals/session-memory-live.ts --luna-low-from=models-recommended-sampling.json
```

| Replayed messages | Previously missed critical evidence | Fallback result | Pi elapsed time | Reported reasoning tokens |
| --- | --- | --- | ---: | ---: |
| 1–42 | Opener path and function name | Recovered | 7.62 s | 0 |
| 1–51 | Opener path and function name | Recovered | 6.27 s | 0 |
| 43–81 | Version guard result | Recovered | 13.20 s | 300 |
| 43–90 | Version guard result | Recovered | 6.84 s | 0 |
| 43–92 | Version guard result | Recovered | 5.86 s | 0 |

All five retries returned valid evidence with correct source attribution.
Pi recorded `low` for each request and reported 300 reasoning tokens in total.
The five retries took 39.79 seconds. The provider omitted the response model
identifier. The replay included both batches that still omitted critical
evidence in LFM2.5 at temperature 0.4. The fixture grader knew which critical
facts the local outputs missed. This measures recovery when a retry is selected
and leaves both production failure detection and the independent effect of
reasoning untested.

## Original CPU comparison at temperature zero

The three candidates used the same numbered excerpt prompt, structured output
schema, 16,384-token context, 768-token output budget, temperature zero,
and 3,000-estimated-token cadence. The corpus includes three short workflows
and the 92-message, 7,803-estimated-token cache workflow from the
[previous hybrid qualification](session-memory-hybrid-results.md).
The comparison ran on Linux with an Intel Core i7-14700 and Ollama 0.40.17.
Each request explicitly set `num_gpu: 0` and `think: false`.

Across **26 of 26 requests**, Ollama reported CPU residency and the returned
token log reconstructed the complete answer text. The usage count had at most
one extra token beyond the log, consistent with the stop token. The response
contained no thinking text. The observed reasoning count was **zero for each request**, including
output-limit failures. The runner leaves the count unknown when token logs
cannot account for generated text. Ollama reports prefill and generation
durations separately. [Ollama API timing and usage](https://github.com/ollama/ollama/blob/main/docs/api/usage.mdx)

| Extractor | Short facts retained | Valid outputs, all requests | Warm short prefill | Warm short generation | Warm short request | Ollama CPU residency | Peak runner RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| LFM2.5 1.2B Instruct Q8 | 14/14 | 7/8 | 1.04 s | 3.44 s | 4.60 s | 1.62 GB | 1.81 GB |
| LFM3 1.7B Q8 | 14/14 | 6/9 | 2.06 s | 4.80 s | 6.87 s | 2.02 GB | 2.43 GB |
| LFM3 1.7B QAD Q4 | 14/14 | 6/9 | 1.17 s | 3.02 s | 4.20 s | 1.23 GB | 1.63 GB |

Timing columns are medians of the four warm short requests with zero cached
input tokens per candidate. Only three of those batches match across all
three candidates. LFM3 Q8 and QAD first loaded in requests of 7.06 s
and 3.98 s. The baseline was already resident at its first request, which
took 3.40 s. Residency is Ollama's loaded size. Peak RSS is the largest
Linux runner high-water mark observed for each model across the corpus.
The two memory measurements use decimal GB and cover different allocations.
Across the three shared warm uncached short requests, total latency was
15.00 s for LFM2.5, 17.23 s for LFM3 Q8, and 10.43 s for LFM3 QAD Q4.

| Extractor | Valid long updates | Critical evidence omitted at final checkpoint | Total long request latency |
| --- | ---: | --- | ---: |
| LFM2.5 1.2B Instruct Q8 | 2/3 | Cache opener path and symbol | 87.06 s |
| LFM3 1.7B Q8 | 1/4 | Cache version guard result | 202.98 s |
| LFM3 1.7B QAD Q4 | 1/4 | Cache version guard result | 121.12 s |

| Final long-transcript result | LFM2.5 1.2B Instruct Q8 | LFM3 1.7B Q8 | LFM3 1.7B QAD Q4 |
| --- | ---: | ---: | ---: |
| Labeled facts retained | 3/5 | 2/5 | 2/5 |
| Critical labels retained | 1/3 | 2/3 | 2/3 |
| Conversation checkpoint | 92 | 42 | 42 |

Both LFM3 models found the opener path and symbol in the first matched long
batch. Each then reached the 768-token cutoff on every attempt to complete the
second batch. LFM2.5 reached the cutoff on the first long update and completed
its later updates. Its first long request reused 3,257 input tokens, so total
long latency includes different cache and retry patterns. The warm uncached
short batches that match across candidates give the cleaner CPU timing
comparison. No labeled contradiction or source misattribution was observed.
At the short workflows'
final checkpoints, LFM2.5, LFM3 Q8 and LFM3 QAD respectively assigned a
different category to seven, six and five facts.

| First long batch, messages 1–42 | Prompt tokens, cached | Prefill | Generation | Total request |
| --- | ---: | ---: | ---: | ---: |
| LFM2.5 1.2B Instruct Q8 | 3,261, 3,257 | 0.04 s | 24.37 s | 24.45 s |
| LFM3 1.7B Q8 | 3,191, 0 | 19.68 s | 24.56 s | 44.25 s |
| LFM3 1.7B QAD Q4 | 3,191, 0 | 12.90 s | 16.36 s | 29.28 s |

The CPU matrix took 497.45 seconds. The corpus SHA-256 is
`0866c8c67f742595e8749f3bd9881e3ed2faf4bb0f2134b399df320875ac426a`.

| Ollama artifact | Manifest SHA-256 |
| --- | --- |
| `LiquidAI/lfm2.5-1.2b-instruct:q8_0` | `2286ca7057af384ff8a3993142536351dcd632602f0ddab97162cc723cd3ad38` |
| `lfm3:1.7b-q8_0` | `a329e3b38ec2bb26c1bcd74c84acca3a8965e4d7d22c5b2f70ab5bcedc399984` |
| `lfm3:1.7b-qad-q4_0` | `765f7bd04f18c4774e31755fde29fc72c2f63686b9f6a935c411334f2b0e3ad4` |

All three manifest digests matched before and after the comparison.

## Task-aware extraction at temperature zero

For LFM2.5 and LFM3 QAD, a matched long-transcript arm supplied the cache task
focus to the same extraction request and told the model to ignore unrelated
work. The numbered input, update schedule, output schema, and inference
settings stayed fixed. The extra prompt used the evaluation's known focus,
including the guard's name, so this arm tests a favorable case for explicit
task focus.

| Extractor | Valid updates, generic → task-aware | Critical omissions with task focus | Generic → task-aware request time |
| --- | ---: | --- | ---: |
| LFM2.5 1.2B Instruct Q8 | 2/3 → 1/4 | Cache opener path and symbol, cache version guard result | 87.06 s → 137.22 s |
| LFM3 1.7B QAD Q4 | 1/4 → 1/4 | Cache version guard result | 121.12 s → 132.32 s |

The focus prompt failed to improve evidence retention. LFM2.5's final valid
checkpoint moved earlier, leaving the guard result unprocessed as well as the
opener evidence missing. LFM3 QAD preserved the same critical facts with both
prompts. All eight task-aware requests ran on CPU and returned zero measured
reasoning tokens. Production extraction uses the generic prompt. The task
focus variant remains available in the evaluation runner.

## Repository edits in native Pi

The runner starts a fresh Pi session for each arm and creates detached
copies of the same LTCook source files from commit `53a615`. The two tasks are
trace event pairing and workspace preparation cache invalidation. Each used
an authored long transcript with interleaved work, an initial proposal, and a
confirmed correction. The transcripts and required outcomes are fixed in the
[edit fixtures](https://github.com/markur4/LTCook/blob/b500ce32c8d2e3291aced42d2651fd5459fc1b29/evals/session-memory-edit-fixtures.ts). The edits ran against real
LTCook source files and were graded by executable behavior checks and file
scope.

- **Conventional delegation** supplied the approved assignment and a short
  manual handoff.
- **Deterministic search** added the Session Memory tool over original
  conversation messages and performed no model extraction for the tool.
- **Hybrid** added the LFM2.5 Session Memory handoff to the same assignment
  and search tool. All arms used the same native Pi read and edit tools.

The CPU-only Bonsai 9B pilot reached its per-response output cap before its
first file edit. A local LFM3 QAD pilot completed the three trace-pairing
arms without a passing edit. These pilots used different worker models.

The matched run used GPT-6 Luna at high reasoning through native Pi and the
existing Codex sign-in. Each conversation had 52 messages and about 3,300
estimated tokens. LFM2.5 extracted the source location before dispatch in
both cases, and the latest user correction remained pending in the conversation.
Both extraction requests ran on CPU with zero measured reasoning tokens.

| Repository edit | Conventional delegation | Deterministic search | Hybrid |
| --- | ---: | ---: | ---: |
| Trace pairing | Pass · 44.79 s · 6,819 input tokens | Pass · 22.80 s · 6,130 tokens | Pass · 17.82 s · 6,205 tokens |
| Workspace preparation | Pass · 26.44 s · 3,457 tokens | Pass · 28.30 s · 11,876 tokens | Pass · 17.08 s · 6,065 tokens |
| **Total** | **2/2 · 71.23 s · 10,276 tokens** | **2/2 · 51.10 s · 18,006 tokens** | **2/2 · 34.91 s · 12,270 tokens** |

All six edits passed the executable behavioral checks and changed only the
assigned file. The search-only worker retrieved history once in each task.
The hybrid worker completed both tasks without a search call. Conventional
delegation used the fewest input tokens across both tasks. Hybrid used the
least worker time and generated 841 output tokens across both tasks, compared
with 1,208 for search and 2,665 for conventional delegation.

The two extraction requests took 13.84 seconds in total and sit outside
the worker timings. End-to-end runner time was 171.11 seconds. The fixed arm
order, shared provider cache, and one run per arm limit latency comparisons.
The two workloads establish functioning edits under all three handoffs.
They provide a signal for lower worker latency with hybrid context and leave
any reliability advantage unestablished. The report records Pi's selected
model and provider. These responses omitted the provider's model identifier.

The original CPU matrix and task-aware comparison took 767.07 seconds
together. The repository-edit Agent Evals brought the original measured
Session Memory evaluation time to 938.18 seconds across these workloads.
