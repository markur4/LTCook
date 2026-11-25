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

## Lean single-seed qualification

The routine summary comparison on the RTX 5090 made 22 requests at seed 17
and completed in 28.57 s. Both strategies used matching source portions and
the same LFM3 QAD Q4 model. Counts below are critical facts in summaries and
assembled handoffs. Every request completed and the grader flagged no
contradictions.

| Fixture | Task context summaries | Immediate Context summaries | Task context handoffs | Immediate Context handoffs |
| --- | ---: | ---: | ---: | ---: |
| Short cache recovery | 3/3 | 3/3 | 3/3 | 3/3 |
| Rewind with pasted reference | 3/3 | 3/3 | 3/3 | 3/3 |
| Previous Discussion reference | 1/2 | 2/2 | 1/2 | 2/2 |
| Held-out index restore | 3/3 | 3/3 | 3/3 | 3/3 |

The rewind fixture models a native turn ending in a tool outcome after
assistant commentary. That turn yields an AAB. Its initiating attachment now
appears in the AAB's current evidence and carries the original sequence in
its citation. Both strategies kept the exact reference name and path.
The previous Discussion fixture requires the later approval to name the
reuse of `selectWorkspaceSnapshot` and preserve the public API. Immediate
Context resolved the reference. Both strategies kept the API constraint.

Named-result grading reads structured test and status pairs in the same
record, or an adjacent identifier and status in a text statement. This
recognizes multiline JSON and prevents one check from inheriting a nearby
failure or pass. Traditional Tests exercise both reported grading errors.

### Isolated CPU timing

These requests summarized the same 194-character cache-check tool result
at seed 17, without generating preceding summaries. The before and final
requests used the same model and 2,048-token cap on an AMD Ryzen 9 9900X.
Ollama verified 100% CPU residency for both.

| Prompt | Input tokens | Output tokens | Prefill | Generation | Load | End-to-end |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Before | 534 | 175 | 1.011 s | 6.021 s | 3.327 s | 10.379 s |
| Final | 491 | 49 | 0.978 s | 1.697 s | 0.002 s | 2.697 s |

The before response repeated both outcomes across fields, added Task
background, and printed empty fields. The final response kept both exact
check outcomes and their observed details in one results field. The before
request loaded the model and the final request reused it. Prefill and
generation totaled 7.032 s and 2.675 s respectively.

### Native Pi controls and edits

Both local Bonsai original-source controls passed their executable checks
after receiving the original search results and the exact latest correction.
Pi then attempted the Immediate Context edits using the same model and
fixture revisions. Both arms received handoffs containing the labeled
critical facts. The tool loop guard stopped both candidate sessions.

| Fixture | Original-source control | Immediate Context edit |
| --- | --- | --- |
| Trace pairing | Passed in 23.81 s | Stopped after 10 tool calls in 11.04 s. All four edit checks passed. |
| Workspace preparation | Passed in 12.20 s | Stopped after 11 tool calls in 10.63 s. The identical-replacement check failed. |

The edit runner took 106.81 s including summary requests and model loading.
The lean GPU runs took 135.38 s in aggregate. Repository-edit qualification
remains open because both candidate turns stopped at the tool-loop guard.
These results measure one run of each original-source control.

Static checks passed. Bun Traditional Tests recorded 315 passes and two
opt-in skips with host Pi skills isolated. Python Traditional Tests recorded
250 passes on six workers. Scripted native Pi/Paseo Leader adoption also
passed. The Traditional Tests and native acceptance took 109.00 s in
aggregate. Together with the GPU runs, the measured command times totaled
244.38 s.

## Automatic delegation investigation

This investigation covers the trace-pairing and workspace-preparation Pi
edits. It uses the pinned two-file workspaces, the same local Bonsai worker
and tools for both arms, and seed 17 for the summaries included in the
Immediate Context handoffs. Both models ran on the RTX 5090.

### What Pi received

The assignment, configured worker instructions, tool descriptions, and
available files matched within each comparison. Both arms received the
full final user decision at sequence 31. The worker could read and edit
the two pinned files and search the conversation. The named checks in the
history refer to verification evidence. The evaluator runs the behavioral
checks outside the Pi session.

| Handoff | Instructions and ordering | Evidence and references |
| --- | --- | --- |
| Original source | Use the latest explicit decision. Search results appear in relevance order in one JSON array, followed by the full correction. | Original messages contain a sequence, author, and text. Both fixtures include the raw implementation finding at sequence 2, the test note at 4, and the supporting review at 10. |
| Immediate Context | Follow the assignment and latest original instruction. A potentially-incomplete flag precedes chronological user messages, including the final correction. A second chronological block of older evidence follows it. | The raw implementation finding at sequence 2 sits alongside AAB and UAMP text with source arrays and portion IDs. The test note at 4 appears in summary text. The summary citing 9 and 10 gives the implementation intent. The full review at 10 is available through original search. |

The audited Immediate Context handoffs were longer than the original-source
handoffs, at 1,404 vs. 999 estimated tokens for trace pairing and 1,342 vs.
1,164 for workspace preparation. Both include earlier proposals and unrelated
documentation work. Immediate Context also carries repeated test references
and an inferred patch failure in the trace summary. The implementation
location was the only labeled critical fact in each edit fixture. Inspecting
the full correction was necessary to check coverage of the actual edit.

### Normal edit outcomes

| Fixture and handoff | Implementation | Turn completed | Tool loop |
| --- | --- | --- | --- |
| Trace pairing, original source | Passed all four checks | Yes | No |
| Trace pairing, Immediate Context | Passed all four checks | No | Yes, 10 calls |
| Workspace preparation, original source | Passed all four checks | Yes | No |
| Workspace preparation, Immediate Context | No edit. Identical replacement failed. | No | Yes, 11 calls |

Trace pairing edited and reread the file before searching six times around
`TRACE_OLD_END`. Exact queries returned the same historical note at sequence
4. Implementation succeeded and Pi failed to finish the turn.

Workspace preparation read the target once. Its first search returned the
full final correction and owner review, including the exception for regular
dependency files and the metadata and identity checks to retain. Pi then
searched for `PREP_REPLACE_IDENTICAL` and `PREP_CONFIG_CONTENT` without
calling `edit`. Exact queries returned the historical note at sequence 4.
The failed check ran against the unchanged target. Search returned an
incomplete indicator in both handoff arms, including the passing controls.

### Controlled replays

| Replay | Trace pairing | Workspace preparation |
| --- | --- | --- |
| Clarify that the evaluator runs the checks. Keep the handoff byte-for-byte. | All four edit checks passed. Pi looped after the edit. | Pi looped before editing. Identical replacement failed. |
| Move the final original decision to the end. Preserve every evidence row and citation. | All four edit checks passed. Pi looped after the edit. | All four edit checks passed. Pi looped after the edit. |

The three runs regenerated identical normal Immediate Context handoffs.
Both original-source controls passed in every run. The workspace result
changed when the placement of the decision changed. This isolates a
presentation effect on implementation for this fixture. The model could
make the correct edit using the evidence that was already present.

Turn termination is a separate downstream behavior. Both workers kept
searching for historical check labels even after a passing edit in the
decision-last replay. Explaining who runs the checks and moving the decision
each left both loops intact. The runs establish what the worker searched for
and when. They leave the exact trigger among the remaining presentation
differences unresolved.

The audited run and the two focused comparisons took 69.36 s, 75.64 s, and
78.51 s. The diagnostic replays leave the normal qualification verdict open.

## Compact production delegation

Production selects evidence for the approved Task, removes duplicate text
and explicitly tentative older proposals superseded by a later instruction,
and places the latest applicable original user instruction last. Known Task
scope excludes unrelated work. History without scope metadata uses query
relevance. The compact projection shows source sequences and identifies
historical verification outcomes. The stored originals and summary citations
remain available for exact lookup.

The two repository-edit comparisons use seed 17 and the local models on the
RTX 5090. The JSON control renders the same selected evidence and citations in
the same order, with the same worker instructions, lookup tool, and final
decision. The report records one shared evidence hash per pair. The control
reproduces the decision-last structure with the current selection and status
rules. The earlier investigation used a different evidence selection.

An earlier run of this comparison exposed two downstream retrieval patterns.
Trace pairing reopened the original at sequence 4 successfully and continued
searching for the historical test label after the passing edit. Those searches
reported available history and returned the same references. Workspace
preparation's JSON arm read the final instruction at sequence 31 and then
requested all 103 sequences from 32 through 134. The transcript ends at 31.
The requests changed each time, so the existing identical-call guard did not
fire. The turn reached its 120-second safeguard without making an edit.

The exact lookup now reports a missing reference separately from unavailable
history and returns the latest known sequence when available. The
search result also reports pending summaries, result truncation, and history
availability independently. These are response semantics. The worker can
still make the same calls and the evaluator uses the same loop guard and
executable checks.

| Fixture and handoff | Estimated handoff tokens | Implementation | Turn completion and tools |
| --- | ---: | --- | --- |
| Trace pairing, original-source control | 999 | Passed 4/4 checks | Loop guard after 9 calls |
| Trace pairing, compact | 1,164 | Passed 4/4 checks | Loop guard after 11 calls |
| Trace pairing, matched JSON | 1,539 | Passed 4/4 checks | Loop guard after 11 calls |
| Workspace preparation, original-source control | 1,164 | Passed 4/4 checks | Response-length stop after 14 calls |
| Workspace preparation, compact | 1,140 | Made no edit. Identical replacement failed. | Loop guard after 11 calls |
| Workspace preparation, matched JSON | 1,454 | Made no edit. Identical replacement failed. | Timed out at 120 s after 117 calls |

The final compact handoffs were 24% shorter for trace pairing and 22%
shorter for workspace preparation. Both kept the complete final instruction
at sequence 31. The unrelated navigation Task and explicitly tentative
original proposals were absent from the selected handoffs.

In the final workspace JSON run, 115 exact lookups included 104 nonexistent
references, ending at sequence 135. The tool reported `not-found` and
`latestSequence: 31` for each out-of-range lookup. History was available.
The workspace compact worker instead repeated searches that returned the
historical note. The trace-pairing workers continued searching after a
correct patch. These traces show that readable handoffs and complete
lookup responses can coexist with downstream tool loops. They leave
the model's reason for continuing unresolved.

Both original-source controls passed the implementation checks and failed
turn completion, leaving automatic delegation qualification inconclusive.
The final GPU comparison took 253.45 s. Static checks, 317 Bun Traditional
Tests with two opt-in skips, and scripted Pi/Paseo Leader adoption passed.
The 250 Python Traditional Tests also passed. Summarization qualification
is recorded separately above.

## Downstream qualification with GPT-6 Luna

Both the original-source and compact Session Memory handoffs qualified on
the two repository-edit fixtures at LTCook revision `88017c`. The single
diagnostic run used Pi with GPT-6 Luna at high reasoning through the existing
Codex sign-in. Pi recorded the requested model and provider. The responses
did not include a separate model ID. LFM3 QAD Q4 ran at seed 17 with full
GPU residency on the RTX 5090.

| Fixture | Handoff | Executable checks | Turn completed | Tool loop | Pi elapsed |
| --- | --- | --- | --- | --- | ---: |
| Trace pairing | Original source | 4/4 | Yes | No | 14.48 s |
| Trace pairing | Compact Session Memory | 4/4 | Yes | No | 19.39 s |
| Workspace preparation | Original source | 4/4 | Yes | No | 20.18 s |
| Workspace preparation | Compact Session Memory | 4/4 | Yes | No | 28.65 s |

The executable checks and scope rules matched across both arms. Pi received
the same file set and access to read, edit, and Session Memory. Luna made
scoped edits using two or three tool calls per turn. It did not call the
Session Memory tool. The compact evidence hashes matched the Bonsai comparison
for both fixtures.

The earlier local Bonsai original-source controls passed their implementation
checks and failed turn completion. Trace pairing repeated successful searches
after editing. Workspace preparation reached the response-length limit after
editing. With the compact handoff, Bonsai passed trace pairing's edit checks
and looped, and the workspace worker looped before editing. With the matched
JSON presentation, the workspace worker repeatedly requested out-of-range
sources and reached the time limit. These are observed limitations of the
tested Bonsai configuration as a downstream worker.

The Luna run completed in 136.59 s. The four passing arms close this
implementation pass for the two fixtures under Luna. Summarization has its
own qualification record above.

```shell
bun evals/session-memory-edit-live.ts --context-aware --audit-output \
  lfm3:1.7b-qad-q4_0 gpt-6-luna
```

## Simplified Session Memory comparison

The matched run used `lfm3:1.7b-qad-q4_0` (manifest digest beginning
`765f7b`) at seed 17 on CPU. Production Session Memory inference was
suspended and its preference was restored afterward. The two deterministic
arms recorded all five focused fixtures without generating a summary. The
existing JSON arm made 15 attempts, of which one AAB request failed. Its
request time includes that attempt. Provider token totals are partial when a
request fails without counts. Requests with provider metrics reported 9,033
input tokens and 2,948 generated tokens, with 35.76 s of prefill and
91.33 s of generation.

| Pipeline | Requests | CPU request time | Input tokens | Generation tokens | Stored record bytes | Handoff bytes | Record critical facts | Handoff critical facts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Existing JSON | 15 | 146.81 s | Partial | Partial | 20328 | 18447 | 14/14 | 14/14 |
| Deterministic AABs and JSON UAMPs | 0 | 0.00 s | 0 | 0 | 8127 | 10465 | 14/14 | 14/14 |
| Deterministic AABs and Markdown UAMPs | 0 | 0.00 s | 0 | 0 | 8127 | 10465 | 14/14 | 14/14 |

Both deterministic arms retained the large AAB's failed and passing outcomes
as separate events. The 14/14 results use normal access to source references
on recorded AABs and skipped UAMPs.

The generated Markdown approval control was open at the end of this comparison. In the strongest replay
with the added proposal and execution checks, the summarizer retained 4/5
critical facts in its generated output, across the stored records, and in
the handoff. It preserved the open proposal, API constraint, rejection of
an automatic rebuild, and lack of completed implementation. The approval
still omitted that “Implement that” referred to reuse of
`selectWorkspaceSnapshot`. A longer reference instruction and a plain
Markdown context replay both yielded an empty approval summary. The pass
retained the 4/5 prompt and the 5/5 gate with zero critical contradictions.
The [approval reference follow-up](#approval-reference-follow-up) closes this gap.

Native Pi with GPT-6 Luna at high reasoning completed both the original
source controls and simplified handoffs for trace pairing and workspace
preparation. All four runs passed their four executable checks. The
simplified records for these edit fixtures required zero inference requests.
The four runs took 72.75 s including setup and assembly.

## Approval reference follow-up

The preceding generated UAMP and the exact rendered approval prompt both
contained `selectWorkspaceSnapshot`, including the description of reusing it
for compatible caches. The original Markdown answer omitted the identifier
despite having it in context. The missing fact arose during generation.

Each diagnostic pair used the same current exchange, task context, and prior
content for JSON and Markdown. LFM3 ran on CPU at seed 17 with production
inference suspended. The table grades the four facts in the current approval.
A fifth fact covers the still open proposal in the preceding UAMP.

| Preceding context | Estimated context tokens | JSON | Markdown |
| --- | ---: | ---: | ---: |
| Generated summary with structured records | 225 | 3/4 | 3/4 |
| Original UAMP with structured records | 419 | 2/4 | 4/4 |
| Generated summary with compact chronological dialogue | 187 | 2/4 | 0/4 |

The Markdown dialogue replay returned an empty answer. JSON sometimes repeated
the symbol without tying it to the user's approval. The successful Markdown
replay used the preceding original UAMP within the same context budget. In
production, a chain of skipped UAMPs can now reopen that one preceding pair.
The normal runtime replay retained **5/5** in generated summaries, stored
records, and the assembled handoff. The known technical identifier in the
bounded generated summary remains available if clipping the original would
lose it.

### Semantic LFM3 baseline

These fixtures require summarization and model the length and content of
ordinary engineering discussions. The abbreviated clarification in the
manifest case remains below the 256-token threshold. The four long UAMPs range
from 281 to 294 estimated tokens.

| Fixture | Requests | CPU request time | Generated summaries | Stored records | Delegation |
| --- | ---: | ---: | ---: | ---: | ---: |
| Export header discovery and observed checks | 1 | 7.63 s | 4/4 | 4/4 | 4/4 |
| Corrected retry delay and rejection | 1 | 6.96 s | 3/3 | 3/3 | 3/3 |
| Manifest approval by reference | 2 | 21.20 s | 4/4 | 4/4 | 4/4 |
| Total | 4 | 35.79 s | 11/11 | 11/11 | 11/11 |

The selected checks detected zero critical contradictions and all 11 labels
were present before compensatory original search. The graders check the
labeled source, status, identifiers and decision language. The audit of the
fixture responses also confirmed the expected failure and the 45-second
correction. Smaller models were outside this run.


## Smaller model screening

The screen used the Session Memory runtime, prompts and fixture inputs pinned
at `e7f1d60` on Ollama 0.40.17. All four weight hashes matched their published
GGUF checkpoints. Each profile used an isolated Ollama alias for sampling
defaults. The evaluator checked that the alias retained the model’s native
chat template, weights and stop settings. All requests verified CPU residency,
used seed 17 and reported zero reasoning tokens. Production Session Memory
inference was suspended and the prior setting was restored afterward.

| Model | Temperature | Export (4) | Retry correction (3) | Manifest approval (4) | Skipped Discussions (5) |
| --- | ---: | ---: | ---: | ---: | ---: |
| LFM2.5-1.2B-Instruct QAD Q4_0 | 0.4 | 1/4 | — | — | — |
| LFM2.5-350M Q8_0 | 0.4 | 0/4 | — | — | — |
| MNN-Pocket-0.3B Q8_0 | 0.8 | 4/4 | 3/3 | 3/4 | — |
| MNN-Pocket-0.3B Q8_0 | 0.1 | 2/4 | — | — | — |
| LFM2.5-350M QAD Q4_0 | 0.4 | 0/4 | — | — | — |

The 1.2B model retained the header parser name and omitted the exact path and
named outcome pairs. The 350M Q8_0 model repeated the prompt’s section guidance.
The 350M QAD model also reported that the missing header case succeeded,
reversing the source’s failure. MNN-Pocket at 0.8 repeated the manifest
implementation symbol but described the approved proposal as still awaiting a
decision. Its 0.1 retry preserved the named outcomes and lost both the exact
path and parser name.

The checker initially scored MNN-Pocket’s retry-stage output at 2/3 and
started the 0.1 profile too early. It now accepts the output’s wording,
“maximum attempts remain at three.” A focused seeded replay at 0.8 verified
the two preceding stages before running manifest approval. The 0.1 attempt
counts as the model’s one retry. No profile qualified, so the screen did not
run LFM3 again or compare total CPU time.

### Per-request CPU measurements

Prefill rates use reported input tokens with reported cached tokens removed.
Handoff and original-source recovery were outside the scoring gate. Each
fixture began with a cold model. The second manifest request reused the
loaded runner. Loaded size is Ollama's working model size. Peak RAM is the
Linux runner's RSS high-water mark, which can include a prior request in that
runner.

The table includes all ten requests. The corrected replay supplies the
qualification scores for MNN-Pocket at 0.8.

| Model | Temperature | Fixture and request | Fixture facts | Input / output tokens | Prefill / generation tok/s | Load s | Wall s | Loaded / peak MiB |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| LFM2.5-1.2B-Instruct QAD Q4_0 | 0.4 | export-header 1/1 | 1/4 | 577 / 50 | 542 / 50 | 1.270 | 3.345 | 1022 / 1001 |
| LFM2.5-350M Q8_0 | 0.4 | export-header 1/1 | 0/4 | 577 / 133 | 887 / 80 | 0.513 | 2.832 | 658 / 655 |
| MNN-Pocket-0.3B Q8_0 | 0.8 | export-header 1/1 (initial) | 4/4 | 555 / 170 | 957 / 84 | 0.764 | 3.384 | 670 / 660 |
| MNN-Pocket-0.3B Q8_0 | 0.8 | retry-correction 1/1 (initial) | 2/3 (grader error) | 557 / 113 | 781 / 82 | 0.514 | 2.608 | 670 / 660 |
| MNN-Pocket-0.3B Q8_0 | 0.8 | export-header 1/1 | 4/4 | 555 / 170 | 883 / 94 | 0.514 | 2.957 | 670 / 660 |
| MNN-Pocket-0.3B Q8_0 | 0.8 | retry-correction 1/1 | 3/3 | 557 / 113 | 942 / 100 | 0.515 | 2.243 | 670 / 660 |
| MNN-Pocket-0.3B Q8_0 | 0.8 | manifest-reference 1/2 | 3/4 | 583 / 212 | 956 / 92 | 0.516 | 3.434 | 670 / 661 |
| MNN-Pocket-0.3B Q8_0 | 0.8 | manifest-reference 2/2 | 3/4 | 900 / 202 | 968 / 87 | 0.001 | 3.042 | 670 / 677 |
| MNN-Pocket-0.3B Q8_0 | 0.1 | export-header 1/1 | 2/4 | 555 / 162 | 688 / 77 | 0.524 | 3.429 | 670 / 660 |
| LFM2.5-350M QAD Q4_0 | 0.4 | export-header 1/1 | 0/4 | 577 / 101 | 1222 / 118 | 0.516 | 1.851 | 505 / 505 |

### MNN-Pocket approval-first follow-up

MNN-Pocket Q8_0 at 0.6 retained 3/4 manifest facts and contradicted the
explicit approval. It copied the earlier proposal into the approval summary,
including the pending decision, and failed to name `reuseExportManifest` as
the approved implementation. Both summaries matched the 0.8 replay exactly.
The native template and all other profile settings stayed the same, including
seed 17. Both requests ran on CPU with
zero reasoning tokens. Production inference was suspended and its prior
setting was restored. The run stopped at manifest approval, so the other
fixtures and the LFM3 comparison did not run. LFM3 remains qualified.

| Request | Input / output tokens | Prefill / generation tok/s | Load s | Wall s | Loaded / peak MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| Proposal | 583 / 212 | 597 / 63 | 1.025 | 5.378 | 670 / 661 |
| Approval | 900 / 202 | 580 / 68 | 0.001 | 4.156 | 670 / 677 |

### MNN-Pocket Q4_1 QAT screen

The official Q4_1 checkpoint at temperature 0.8 scored 0/4 on the automated
manifest gate. Reading the summary directly, it restated API stability and
keeping old manifests in wording the grader did not match. The approval
summary omitted `reuseExportManifest` and described planned checks as
already performed. The screen stopped after the two manifest requests.
It used the verified official weights, the native chat template, seed 17,
and zero reasoning tokens on CPU. Production inference was restored after
the screen. LFM3 remains in production.

| Request | Input / output tokens | Prefill / generation tok/s | Load s | Wall s | Loaded / peak MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| Proposal | 583 / 142 | 632 / 89 | 0.515 | 3.050 | 484 / 475 |
| Approval | 844 / 182 | 555 / 84 | 0.001 | 3.300 | 484 / 488 |
