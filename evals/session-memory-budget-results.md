# Session Memory CPU and repository-edit evaluation

Keep `LiquidAI/lfm2.5-1.2b-instruct:q8_0` as the recommended extractor for
opt-in Session Memory. LFM3 QAD was faster on short requests and used less
memory. LFM2.5 completed more long-transcript updates and recovered after
reaching the output limit. All three models missed critical evidence on the
long transcript. Deterministic search can retrieve omitted messages directly
from Paseo.

## Matched CPU comparison

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
input tokens per candidate. LFM3 Q8 and QAD first loaded in requests of 7.06 s
and 3.98 s. The baseline was already resident at its first request, which
took 3.40 s. Residency is Ollama's loaded size. Peak RSS is the largest
Linux runner high-water mark observed for each model across the corpus.
The two memory measurements use decimal GB and cover different allocations.

| Extractor | Valid long updates | Critical evidence omitted at final checkpoint | Total long request latency |
| --- | ---: | --- | ---: |
| LFM2.5 1.2B Instruct Q8 | 2/3 | Cache opener path and symbol | 87.06 s |
| LFM3 1.7B Q8 | 1/4 | Cache version guard result | 202.98 s |
| LFM3 1.7B QAD Q4 | 1/4 | Cache version guard result | 121.12 s |

Both LFM3 models found the opener path and symbol in the first matched long
batch. Each then reached the 768-token cutoff on every attempt to complete the
second batch. LFM2.5 reached the cutoff on the first long update and completed
its later updates. Its first long request reused 3,257 input tokens, so total
long latency includes different cache and retry patterns. The warm uncached
short medians give the cleaner CPU timing comparison. No labeled
contradiction or source misattribution was observed. At the short workflows'
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

## Task-aware extraction

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
[edit fixtures](session-memory-edit-fixtures.ts). The edits ran against real
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

The CPU matrix and task-aware comparison took 767.07 seconds together. The
repository-edit Agent Evals brought measured Session Memory evaluation time
to 938.18 seconds across these workloads.
