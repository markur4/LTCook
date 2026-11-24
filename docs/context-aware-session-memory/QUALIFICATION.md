# Context-aware Session Memory qualification

The initial runtime passed local verification and was integrated ahead of
model qualification. Rolling history remains below the critical-retention
target. The retention follow-up was reviewed and merged with live verification
deferred until GPU access. See the [Immediate Context qualification](#immediate-context-qualification)
for the post-merge run. Delegation enrichment stays opt-in.

## Method

The summarizer ran on CPU with Ollama 0.40.17 and `lfm3:1.7b-qad-q4_0`
(manifest digest starts `765f7b`). Requests used temperature 0.4, top-k 50,
repeat penalty 1.1, a 16,384-token context, a 2,048-token generation cap, and
reasoning disabled. Settings were fixed across inference arms. Original
conversation search made no summarization requests. A separate local inference
runner was active during performance sampling, so these timings describe the
observed host workload.

The semantic grades cover labeled facts and contradictions. JSON parseability
and fields recovered from the raw answer are recorded separately. Input,
output, and cache token counts come from Ollama. Historical budget sizes and
handoff sizes use LTCook's estimator. The 4,096 ceiling and 2,048 eviction
target apply to that estimator. Ollama 0.40.17 returned 404 for a standalone
tokenizer request. The runtime uses the configured model context and asks
Ollama to reject overflow so it can keep incomplete sources pending.
[Ollama usage metrics](https://github.com/ollama/ollama/blob/main/docs/api/usage.mdx)

Request latency is wall time from starting an Ollama request through
receiving and parsing the response. Prefill and generation are Ollama's
reported times. Queue delay is measured from observation to inference start.
The Linux runner's peak RSS is its process high-water mark, which can include
earlier samples.

## Matched quality and CPU cost

The first invoice replay sample exposed a critical omission in rolling
history. The model's logical no-history arm retained the same test result.
The evaluation repeated the fixture after tightening the prompt to keep an
exact test name beside its observed outcome, limit output to the current
unit's fields, and report each fact once.

| Initial invoice replay strategy | Critical omissions | Requests completed | Summarizer request time | Handoff estimate |
| --- | ---: | ---: | ---: | ---: |
| Extractive, token-based | 0 | 2/2 | 6.12 s | 469 tokens |
| Abstractive, token-based | 0 | 2/2 | 27.74 s | 1,012 tokens |
| Logical UAMP and AAB, no history | 0 | 4/4 | 32.29 s | 1,155 tokens |
| Logical UAMP and AAB, rolling history | 1 | 4/4 | 80.46 s | 1,156 tokens |
| Deterministic original search | 0 | 0 | 0 s | 464 tokens |

The omitted result was `DUPLICATE_REPLAY_CASE` passing. The initial raw
conversation was 353 estimated tokens. Pre-injected summaries increased the
estimated handoff size in this short fixture, even before measuring downstream
usage. Ollama reported zero cached input tokens and zero reasoning tokens for
the initial invoice sample.


The revised invoice replay sample retained the previously omitted result.
Across five fixtures, rolling history was less reliable than logical
summarization without history and consumed more prefill time. These scores
measure preservation of facts in summaries plus the strategy's direct source
evidence. The original-search score establishes that labeled evidence exists in
the authoritative sources. The Pi edit comparison measures successful use of
that evidence.

| Strategy | Critical facts | All labeled facts | Complete requests | Input tokens | Newly processed | Output tokens | Prefill | Generation | Request time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Extractive | 13/14 | 21/24 | 9/9 | 8,883 | 8,883 | 3,643 | 36.54 s | 123.54 s | 160.37 s |
| Token-based abstractive | 13/14 | 20/24 | 9/9 | 11,658 | 11,658 | 3,353 | 57.87 s | 188.40 s | 246.58 s |
| Logical without history | 13/14 | 22/24 | 23/24 | 16,109 | 15,868 | 7,752 | 62.37 s | 236.92 s | 299.66 s |
| Logical with rolling history | 10/14 | 19/24 | 24/24 | 32,631 | 29,792 | 8,096 | 117.11 s | 247.77 s | 365.24 s |
| Original search | 14/14 | 24/24 | — | — | — | — | — | — | — |

The 66 responses had zero measured reasoning tokens and no labeled
contradictions. The three abstractive arms produced parseable JSON in 8/9,
21/24, and 23/24 requests, respectively. Every abstractive request yielded
at least one recognized field. A logical no-history request reached the
2,048-token cap and stayed incomplete. Ollama reported 241 cached tokens
without history and 2,839 with history. Peak runner RSS reached 2.81 GiB.

The logical arms preserved the exact verification identifier and source path
from the pasted document. Token-based abstraction preserved the pasted
identifier and path but omitted the rewind consequence. The extractive arm
omitted the attachment-specific fact. With rolling history, the cache version
guard result was omitted in both cache recovery fixtures. The initial long
sample also omitted the cache opener's path and symbol. Its synthetic
documentation reports lacked independent turn IDs, so they were grouped
with cache work. A focused replay separates the native turns and retains the
same source messages and labels.

The rolling arm reduced the 10,264 estimated raw source tokens to 5,667
estimated handoff tokens across the five fixtures, a 44.8% reduction from
raw source size. Original search supplied 3,335, a 67.5% reduction. On the 7,810-token long fixture, the arms selected similar context
sizes at roughly 1,200 tokens. The comparison uses the same handoff budget
for each arm and measures context availability independently of the runtime
storage and scheduling path.

| Ready summary type | No history requests | No history median latency | Rolling requests | Rolling median latency |
| --- | ---: | ---: | ---: | ---: |
| UAMP | 12 | 7.70 s | 12 | 11.53 s |
| AAB | 11 | 7.05 s | 12 | 15.66 s |

<details>
<summary>Per-fixture scores and request times</summary>

| Fixture | Strategy | Critical facts | Complete requests | Prefill | Generation | End-to-end | Handoff token estimate |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Invoice replay | Extractive | 3/3 | 2/2 | 2.87 s | 7.27 s | 10.19 s | 456 |
| Invoice replay | Token-based abstractive | 3/3 | 2/2 | 5.29 s | 31.19 s | 36.51 s | 928 |
| Invoice replay | Logical without history | 3/3 | 4/4 | 6.20 s | 26.89 s | 33.13 s | 1,155 |
| Invoice replay | Logical with rolling history | 3/3 | 4/4 | 14.50 s | 46.95 s | 61.51 s | 1,156 |
| Invoice replay | Original search | 3/3 | — | — | — | — | 464 |
| Paseo rewind | Extractive | 2/2 | 1/1 | 1.35 s | 3.55 s | 4.93 s | 388 |
| Paseo rewind | Token-based abstractive | 2/2 | 1/1 | 2.34 s | 7.99 s | 10.34 s | 464 |
| Paseo rewind | Logical without history | 2/2 | 4/4 | 5.90 s | 16.19 s | 22.13 s | 791 |
| Paseo rewind | Logical with rolling history | 2/2 | 4/4 | 10.53 s | 23.08 s | 33.65 s | 1,020 |
| Paseo rewind | Original search | 2/2 | — | — | — | — | 384 |
| Cache recovery | Extractive | 3/3 | 2/2 | 2.88 s | 10.24 s | 13.15 s | 905 |
| Cache recovery | Token-based abstractive | 3/3 | 2/2 | 5.03 s | 19.64 s | 24.69 s | 944 |
| Cache recovery | Logical without history | 3/3 | 6/6 | 9.76 s | 45.13 s | 54.98 s | 1,220 |
| Cache recovery | Logical with rolling history | 2/3 | 6/6 | 27.45 s | 78.68 s | 106.20 s | 1,221 |
| Cache recovery | Original search | 3/3 | — | — | — | — | 799 |
| Cache recovery with interleaved work | Extractive | 3/3 | 3/3 | 28.20 s | 98.77 s | 127.11 s | 1,215 |
| Cache recovery with interleaved work | Token-based abstractive | 3/3 | 3/3 | 40.41 s | 120.47 s | 161.09 s | 1,130 |
| Cache recovery with interleaved work | Logical without history | 2/3 | 5/6 | 33.02 s | 128.24 s | 161.39 s | 1,220 |
| Cache recovery with interleaved work | Logical with rolling history | 0/3 | 6/6 | 48.61 s | 62.30 s | 111.06 s | 1,218 |
| Cache recovery with interleaved work | Original search | 3/3 | — | — | — | — | 1,222 |
| Paseo rewind with pasted reference | Extractive | 2/3 | 1/1 | 1.24 s | 3.72 s | 4.99 s | 380 |
| Paseo rewind with pasted reference | Token-based abstractive | 2/3 | 1/1 | 4.81 s | 9.12 s | 13.95 s | 522 |
| Paseo rewind with pasted reference | Logical without history | 3/3 | 4/4 | 7.50 s | 20.48 s | 28.02 s | 979 |
| Paseo rewind with pasted reference | Logical with rolling history | 3/3 | 4/4 | 16.02 s | 36.76 s | 52.83 s | 1,052 |
| Paseo rewind with pasted reference | Original search | 3/3 | — | — | — | — | 466 |

</details>

The earlier task-aware extraction experiment on the long cache transcript
included the known Task focus in the prompt. For QAD Q4 at temperature zero,
it retained the same critical facts and increased request time from 121.12 s
to 132.32 s. The new runtime applies Task scope to recorded provenance and
uses the delegation query to rank evidence. The comparison here holds the
summarization prompt independent of a future delegation query.
[Task-aware extraction experiment](../../evals/session-memory-budget-results.md#task-aware-extraction-at-temperature-zero)

## Cache reuse and queue priority

The controlled LFM3 probe supplied a short current UAMP and stable synthetic
historical summaries. A deliberately incorrect earlier summary claimed
`runtimeConfig` should be removed. The new explicit instruction to preserve
`runtimeConfig` and its signature in `runtime/src/main.ts` was retained,
without an approved removal appearing in the recovered `decisions` field.
This was one diagnostic sample.

| Probe | History estimate | Input tokens | Cached tokens | Output tokens | Prefill | Generation | End-to-end |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Incorrect prior summary | 32 | 428 | 0 | 130 | 3.56 s | 8.63 s | 12.23 s |
| Agent A, first historical prefix | 3,908 | 3,792 | 0 | 282 | 15.91 s | 8.72 s | 24.65 s |
| Agent A, repeat with same prefix | 3,908 | 3,792 | 2,768 | 174 | 5.09 s | 5.74 s | 10.84 s |
| Agent B, different prefix | 652 | 949 | 0 | 260 | 3.76 s | 7.47 s | 11.27 s |
| Agent A, return after switch | 3,908 | 3,792 | 2,768 | 209 | 4.44 s | 7.62 s | 12.09 s |
| Agent A, grouped eviction | 1,954 | 2,097 | 0 | 299 | 8.70 s | 9.09 s | 17.83 s |
| Agent A, grow new prefix | 2,605 | 2,662 | 1,073 | 221 | 6.42 s | 7.18 s | 13.61 s |
| Agent A, repeat new prefix | 2,605 | 2,662 | 1,638 | 204 | 4.28 s | 14.46 s | 18.75 s |

The identical 3,792-token request reused 73% of the input and reduced prefill
by 68% on the first repeat. The switch back to Agent A retained that cache.
Grouped eviction reduced the historical window to 1,954 estimated tokens
under the 2,048 target and required fresh prefill. The next appended request
reused 1,073 tokens. Ollama's loaded model occupied 1.14 GiB of RAM with zero
GPU bytes, and the model runner reached 1.96 GiB peak RSS during this probe.
All ten direct probe responses reported zero reasoning tokens.

| Queue probe | End-to-end or queue wait | Summary request execution |
| --- | ---: | ---: |
| Foreground request, empty Session Memory queue | 18.10 s | — |
| Foreground request, two Session Memory jobs pending | 23.46 s | — |
| First Session Memory job | 23.47 s wait | 15.42 s |
| Second Session Memory job | 38.89 s wait | 15.60 s |

Both queued UAMPs completed. Neither summary started during the foreground
request. The foreground slowdown estimate is inconclusive because the samples generated
different output lengths and shared the CPU with another workload.

## Repository edits in Pi

Pi requested GPT-6 Luna with high reasoning through the existing Codex
authorization in all downstream arms. Each worker edited disposable files from the
same pinned LTCook revision. The grader checked the actual target edit,
untouched sibling files, and executable behavior.

| LTCook edit | Conventional delegation | Original conversation search |
| --- | --- | --- |
| Trace pairing | Failed duplicate-begin rule, 39.97 s | Passed, 25.82 s |
| Workspace preparation | Passed, 21.09 s | Passed, 21.69 s |

The first long comparison stopped during rolling-history summarization at
Ollama's 120-second request limit. The edit runner now records such a request
as incomplete and proceeds with source-backed Pi evaluation. Failed original
controls make the corresponding downstream comparison inconclusive.


### Matched edit run

| LTCook edit | Strategy | Pi result | Completed summary requests | CPU summarization time | Pi edit time | Pi input tokens |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Trace pairing | Conventional delegation | Passed | — | — | 34.87 s | 3,677 |
| Trace pairing | Original search | Passed | — | — | 22.98 s | 6,681 |
| Trace pairing | Extractive | Passed | 2/2 | 63.14 s | 14.09 s | 6,942 |
| Trace pairing | Token-based abstractive | Passed | 2/2 | 48.72 s | 21.11 s | 8,961 |
| Trace pairing | Logical without history | Passed | 8/8 | 116.53 s | 19.69 s | 7,175 |
| Trace pairing | Logical with rolling history | Passed | 6/8 | 254.98 s | 19.74 s | 7,324 |
| Workspace preparation | Conventional delegation | Passed | — | — | 24.58 s | 3,415 |
| Workspace preparation | Original search | Timed out | — | — | 120.01 s | 694 |
| Workspace preparation | Extractive | Passed | 2/2 | 61.32 s | 13.39 s | 6,801 |
| Workspace preparation | Token-based abstractive | Passed | 2/2 | 38.75 s | 24.59 s | 13,389 |
| Workspace preparation | Logical without history | Passed | 8/8 | 122.85 s | 11.31 s | 6,835 |
| Workspace preparation | Logical with rolling history | Passed | 8/8 | 174.80 s | 16.70 s | 6,954 |

Trace pairing passed with every input strategy and with conventional
delegation in the matched run. Its prior conventional attempt failed the
duplicate-begin rule. The rolling arm still omitted the labeled implementation
path and left two of eight summary requests incomplete at the 2,048-token cap.
This fixture shows that successful repository edits and reliable summary
coverage need separate checks.

The original-search control timed out in the matched workspace preparation
run. Its earlier standalone counterpart passed. The matched workspace
comparison is inconclusive. The remaining workspace arms all passed their
executable edit checks. The matched edit run took 20 minutes 24 seconds
including all summarizer requests and native Pi turns. Ollama's model digest
stayed fixed.

## Retention follow-up

After assigning native turn IDs to the separate documentation work, the
long fixture still exposed all three missing critical facts with rolling
history. The short rolling replay missed the cache version guard again.

| Focused pre-fix replay | Strategy | Critical facts | Complete requests | Prefill | Generation | End-to-end |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Short cache recovery | Logical with rolling history | 2/3 | 6/6 | 25.48 s | 58.56 s | 84.14 s |
| Long cache recovery, corrected native turns | Logical without history | 3/3 | 15/15 | 56.10 s | 267.04 s | 323.58 s |
| Long cache recovery, corrected native turns | Logical with rolling history | 0/3 | 15/15 | 122.87 s | 304.68 s | 427.94 s |

The follow-up preserves explicit named outcomes from original tool responses.
It searches original conversation messages for technical identifiers absent
from a delegation handoff, within the existing handoff token budget. It runs
the same model with the same inference settings. Focused measurements score
the model output and the selected handoff separately.

| Follow-up replay | Model evidence | With observed checks | In selected handoff | Complete requests | Prefill | Generation | End-to-end |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Short cache recovery, rolling history | 3/3 | 3/3 | 3/3 | 6/6 | 46.15 s | 209.31 s | 255.63 s |

The short replay recovered the missing test result in the model output itself.
This replay required no original-source lookup. A Traditional Test separately
verifies exact original-source recovery when a completed summary omits a
requested implementation path. The short replay had higher latency than the
pre-fix run under a shared CPU workload.

The short result predates the final exact-match grader and selection logic.
The follow-up long replay stopped before producing a complete report, and the
queued trace-pairing replay did not start. The merged initial runtime's local
checks are recorded below.

## Local verification

| Check | Result | Time |
| --- | --- | ---: |
| Bun Traditional Tests | 300 passed, two opt-in skips | 30.10 s |
| Python Traditional Tests | 250 passed on six workers | 5.96 s |
| Build and static checks | Passed | — |
| Native Pi/Paseo acceptance | Passed UAMP scheduling, source access, native provenance, exact attachment retrieval and restart | — |

Bun used a 20-second test limit during concurrent CPU workloads. The native
acceptance fixture verifies the attachment handoff at protocol level. The
supported composer control has type and bundle coverage.

## Immediate Context qualification

Qualification remains open. Immediate Context preserved all held-out critical
facts. The full corpus exposed a coverage gap in the attachment fixture, and
the native Pi edit attempts timed out in both Immediate Context cases at
seed 17.

The post-merge run used LTCook revision `2003a9` (PR #31) on Linux/WSL with
Ollama 0.40.16. The full comparison corpus contains five fixtures. The separate
held-out run uses the index-restore fixture. The completed context matrices
used the earlier default of seeds 17, 43, and 89. They compared no added
context, authoritative Task context, Immediate Context, and rolling history.
The edit comparison uses those strategies plus conventional and original-search
controls on two pinned repository edits. The handoff comparison sends paired
chronological and generated presentations to fresh Pi sessions. Routine runs
now use one seed, defaulting to 17.

The summarizer used `lfm3:1.7b-qad-q4_0` (digest `765f7bd04f18`) at
temperature 0.4, top-k 50, and a 1.1 repetition penalty, with a 16,384-token
context, a 2,048-token output cap, and reasoning disabled. Native Pi used
local `ltcook-bonsai-2-27b-ctx65536:latest` (digest `bd5f3c102bf7`) for the
edit and handoff comparisons. Completed runners reported stable model digests.
Ollama's GPU discovery watchdog expired during the first full run and the
model moved to CPU. That run was canceled. The GPU rerun used a temporary
loopback Ollama listener restricted to the RTX 5090.

### CPU summarization sample

The focused run used the single-seed default and the production summarizer
settings on an AMD Ryzen 9 9900X. Ollama reported 100% CPU residency. The table
shows one completed Agent Action Batch, source sequence 8 from the short
cache-recovery fixture, using Immediate Context. The model was already loaded.

| Input tokens | Cached input tokens | Output tokens | Prefill | Generation | Load | End-to-end |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 677 | 0 | 362 | 0.808 s | 6.502 s | 0.001 s | 56.014 s |

Prefill and generation totaled 7.310 s. Other requests overlapped on the shared
Ollama service, and the observed end-to-end latency includes time beyond model
load, prefill, and generation. The focused runner completed four summary
requests in 152.89 s. This sample describes one input and output length.

```shell
bun evals/session-memory-live.ts --context-aware --cpu-only \
  --fixture=runtime-rebuild-and-cache-recovery --strategy=immediate
```

### GPU summary retention

All 72 strategy runs in the full and held-out context matrices reported full
GPU residency. Source portion hashes matched across the four strategies for
every fixture and seed. The full matrix took 373.19 s. The held-out matrix
took 16.53 s.

| Full corpus strategy | Complete requests | Critical facts in summaries | In handoff before original recovery | In assembled handoff |
| --- | ---: | ---: | ---: | ---: |
| No added context | 75/75 | 39/42 | 39/42 | 39/42 |
| Authoritative Task context | 75/75 | 39/42 | 37/42 | 39/42 |
| Immediate Context | 74/75 | 36/42 | 34/42 | 39/42 |
| Rolling history | 75/75 | 21/42 | 22/42 | 37/42 |

Original search found all 42 critical facts. The attachment-specific fact was
outside the summarization portions and absent from the assembled handoff for
every strategy and seed. Original search retrieved it every time. This fixture
exercises attachment search and leaves attachment summarization unqualified.

Immediate Context retained 8/9 critical facts in summaries on each of the short
and interleaved cache-recovery fixtures. Both handoffs covered 9/9. The short
fixture had one incomplete Agent Action Batch at seed 89. At seed 43 the long
fixture's corresponding batch omitted `CACHE_VERSION_GUARD` and introduced an
unsupported automatic-rebuild observation. The invoice replay grader missed
one valid `DUPLICATE_REPLAY_CASE` result because the identifier and `PASS`
appeared on separate JSON lines. Three rewind contradiction flags matched
references to a failing assertion alongside the passing `PI_REWIND_PROVIDER_ID`
result. The audited summaries still included unsupported claims about whether
the original failure had been resolved.

Immediate Context retained all 9/9 held-out critical facts in summaries and
in the assembled handoff, with no labeled contradictions. Authoritative Task
context also retained 9/9 in summaries. No added context and rolling history
retained 8/9 each. All four held-out handoffs retained 9/9.

### Native Pi handoff formats on GPU

Both invoice handoff formats failed both wording variants. All four responses
returned parseable output. Three chose the wrong target value and one chose the
wrong idempotency key. The runner took 13.25 s and Ollama reported 100% GPU
residency for Bonsai.

### Native Pi repository edits on GPU

The table reports the controls and seed-17 strategy results. Pi edited files
from pinned revision `53a615`. Ollama reported full GPU residency for Bonsai
and LFM3. Both trace-pairing controls ran once. For workspace preparation,
the targeted rolling-history replay ran the required controls again.

| Strategy | Trace pairing | Workspace preparation |
| --- | --- | --- |
| Conventional | Failed (6.10 s) | Timed out in both runs |
| Original search | Passed | Timed out in both runs |
| No added context | Timed out | Passed |
| Authoritative Task context | Passed | Timed out |
| Immediate Context | Timed out | Timed out |
| Rolling history | Timed out | Timed out |

The first edit run recorded 23 outcomes, with eight timeouts at the runner's
120-second safeguard. It stopped after the seed-17 workspace-preparation
Immediate Context attempt when the routine seed count changed. Its progress
log contains the completed outcomes. The runner emits detailed JSON on
completion. The follow-up used the new single-seed default for the remaining
workspace-preparation rolling-history comparison. Original search retrieved
the critical facts on that replay but did not finish the edit. The original
control timeouts make the matched workspace-preparation comparison
inconclusive. The rolling-history replay made 160 tool calls before it timed
out.

The first edit run took 1,294.20 s including canceled work. The targeted
replay took 388.04 s. The reported GPU runs total 2,085.21 s. Together with
Traditional Tests and native acceptance, the aggregate measured time was
2,162.59 s.

### Post-merge Traditional Tests

| Check | Result | Wall time |
| --- | --- | ---: |
| `just check` | Passed formatting, lint, and type checks after the single-seed default change | 17.15 s |
| Bun Traditional Tests | 311 passed, two opt-in skips | 27.39 s |
| Python Traditional Tests | 250 passed on six workers | 2.78 s |
| Native Pi/Paseo Leader adoption | Passed the scripted end-to-end test, including Session Memory source access, attachments, and restart | 47.21 s |

Two native guidance tests in the first `just test` run discovered host Pi
skills. The passing Bun run used the same test directories, masked the host
skill directory for the process, and used a 20-second test limit. The Python
command from `just test` ran separately. Traditional Tests and native
acceptance took 77.38 s in aggregate.
