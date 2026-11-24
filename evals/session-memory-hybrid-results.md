# Hybrid Session Memory qualification

The hybrid keeps original user requirements and corrections independently of the
summarizer. The model selects numbered agent and tool excerpts and assigns each
a category. LTCook copies the selected text and derives its author, source
sequence and chronological order from Paseo. The runtime can therefore preserve
user messages even while a model update is pending or has failed.

## Isolating the previous handoff

The paired invoice test used identical excerpt text and source roles for
messages 6–11. Only their presentation changed within each task pair. The
chronological arm rendered them in source order. The generated arm reproduced
the previous handoff envelope and ordering. Each arm used a fresh native Pi
session with the same Bonsai model, task and instructions.

| Task wording | Chronological presentation | Previous generated presentation |
| --- | --- | --- |
| Original wording | 4/5. Returned task ID `INV-204` for the design. | 4/5. Returned `invoice-v3` and gave the acceptance test as the idempotency key. |
| Explicit design-version wording | 4/5. Returned `INV-204` for the design. | 4/5. Returned `INV-204` for the design. |

This comparison reproduces field confusion with the same excerpts on both
sides. The presentation changed which field failed in one pair. Chronological
ordering alone did not recover a complete handoff. The comparison tests the
previous envelope and ordering together, with earlier generated entries omitted
from both conditions.

## Simplifying the extractor

Qwen was tested before the other candidates. With the first additions-only
prompt, it passed all three downstream Pi tasks but qualified on none of the
extraction fixtures. It repeated a fictional formatting example as a finding
in two conversations. Removing that example improved invoice retention, but
Qwen still described an unapproved strategy as an existing function on one
attempt.

The production form asks the model only for an excerpt number and category.
LTCook resolves those numbers to copied text and its source. The model never
receives the original user messages or synthesizes their wording. The format
also removes model-generated IDs, update operations and supersession commands.
Later user messages remain in the record alongside earlier instructions and
the rendered handoff tells the worker which one resolves a correction.

## Corpus and acceptance

The three scenarios cover invoice replay revisions, native Pi rewind with an
epoch change, and offline cache reset policy. The conversations range from
seven to eleven messages and about 260 to 680 estimated tokens. Each crosses
one or two evidence update boundaries and leaves a new user correction pending
at delegation. The rewind task also asks the worker to report a named tool
result.

The runner separates malformed output, missing facts, contradicted facts,
wrong source attribution, and wrong category. The qualification gate requires
valid CPU inference output, critical evidence with correct attribution, no
labeled contradiction, verbatim user-message retention, the pending correction,
and a correct Pi handoff with a passing source control. Category differences
are tracked separately. This is a labeled comparison of the selected facts
rather than an exhaustive semantic review of every possible claim.

The benchmarks use native Pi with the same local Bonsai downstream model across
conditions. The four Ollama extractors run on CPU and their model digests are
verified. The runtime uses the same reasoning-off, temperature-zero, 16,384
context, 768 output-token settings used in the comparison. All timings are
end-to-end model request timings from the shared Linux development host.

## Final comparison

The final handoff uses one quoted line per source. Confirmed user messages come
first in chronological order, followed by evidence with its author and source
number. All 12 hybrid Pi tasks and all six original-source control runs passed
across the two final invocations. All 20 extraction calls returned valid
output and ran on CPU. No labeled
contradiction, wrong attribution, or missing verbatim user message was
observed. Omission and categorization still differed by model.

| Q8 model | Qualified workflows | Pi handoffs | Pi input tokens vs. source | Cold CPU update | Median warm CPU update | Warm update range | Warm output tokens/s | Ollama loaded memory |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| LFM2.5-350M | 1/3 | 3/3 | 1,381 (−7.3%) | 1.28 s | 0.80 s | 0.74–0.87 s | 107–125 | 690 MB |
| Qwen3.5-0.8B | 2/3 | 3/3 | 1,324 (−11.0%) | 2.42 s | 2.05 s | 0.49–2.61 s | 14–47 | 1,299 MB |
| LFM2.5-1.2B-Instruct | 3/3 | 3/3 | 1,405 (−5.7%) | 3.28 s | 3.91 s | 1.78–6.95 s | 39–44 | 1,622 MB |
| Spark-X2.6-4B | 3/3 | 3/3 | 1,405 (−5.7%) | 11.99 s | 7.83 s | 1.71–20.15 s | 4–12 | 4,755 MB |

LFM2.5-350M omitted the old-epoch failure and the cache guard result. Qwen
retained the critical invoice and rewind evidence but missed the cache opener
path and function and the cache guard result. LFM2.5-1.2B retained all labeled
facts across the three scenarios. Spark missed one noncritical restart error.
Both qualifying models sometimes filed reference or test evidence as a
finding. These errors affect how a reader interprets the entry, while the evidence
remains available through its text and citation.

In a separate rendering comparison, the two qualifying candidates each used
1,628 Pi input tokens with the JSON envelope and 1,402 with the compact handoff,
a **14% reduction** for identical selected excerpts. The final compact handoff
saved **5.7%** overall against its matched 1,490-token original-source control.
It used eight additional invoice tokens, saved eleven rewind tokens and saved
82 cache recovery tokens. Compression varied with the amount and structure of
retained evidence.

The final compact comparison took 24.13 seconds for Qwen and 84.73 seconds
for the remaining candidates, including the Pi controls. Ollama reported the
model unloaded before each candidate's first request. Loaded bytes describe
Ollama residency. The short corpus SHA-256 is
`86b0eb9493d8ea54d2dc93576b9cacfd504696c226bce72f4e3ea98cfa5bd68f`.

| Ollama artifact tested | SHA-256 digest |
| --- | --- |
| `hf.co/LiquidAI/LFM2.5-350M-GGUF:Q8_0` | `20b6da56bc7cdecf3ade82fabed1b21cd3f0f1bbe6ad0e5189ac93b13d75ea8b` |
| `qwen3.5:0.8b-q8_0` | `7c00f78aed0fd757e9ba2f2720896768fd22da24b7fb6fe17096bb1e85bb2d25` |
| `LiquidAI/lfm2.5-1.2b-instruct:q8_0` | `2286ca7057af384ff8a3993142536351dcd632602f0ddab97162cc723cd3ad38` |
| `hf.co/XHToken/Spark-X2.6-4B-GGUF:Q8_0` | `b3bfb5c5eb1533e3165bf56c51513211fd2a71db68815258e1e276a5ef24fcf2` |

## Periodic extraction at 1,500 and 3,000 tokens

The cadence test used the 1.2B model on the same cache task with 92 messages
and 7,803 estimated tokens. Interleaved synthetic reports from a separate
documentation pass supplied realistic distractions. The runner scheduled
updates after completed turns and at the end. The shorter corpus used explicit
task-boundary flushes. Both long runs used the same focused original-source
control and measured dispatch before the final update.

| Estimated token threshold | Periodic plus final updates | Total CPU request time | Critical evidence omitted | Pi context and task |
| --- | ---: | ---: | --- | --- |
| 3,000 | 2 + 1 | 28.72 s | Cache opener path and symbol, cache guard result | 475 vs. 589 input tokens, passed |
| 1,500 | 4 + 1 | 37.08 s | Cache opener path and symbol | 507 vs. 590 input tokens, passed |

All eight updates produced valid CPU output. Both handoffs included the latest
confirmed user correction. The lower threshold retained the guard result and
the noncritical finding about preserved cache bytes. It increased extraction
request time by 29% and neither schedule met the extraction gate. This single
synthetic long task is evidence of sensitivity to interleaving and batch size.
It leaves the best periodic cadence open. Its corpus SHA-256 is
`09461ba3abb041b0480998da59ffa89a2518c2ff5001ac8c590b23985c88c348`.

## Recommendation and limits

Use **LFM2.5-1.2B-Instruct Q8** for opt-in delegation. It was the smallest
candidate that passed all three short extraction and handoff scenarios. Keep
3,000 estimated tokens as the provisional configured default, with
task-boundary updates enabled. The longer stress test leaves a quality gap
before enabling automatic enrichment by default.

The evidence supports the simpler runtime and a candidate choice for
opt-in use. The comparison covers three synthetic workflows and downstream
task comprehension. Production tool capture uses structured outcomes such as
exit codes, changed paths and search counts. The corpus also includes
synthetic named test evidence, which in a real session may come from the
agent's test report. Native Pi/Paseo tests cover runtime persistence and
shared access separately. Pi can omit the submission identifier on a rebuilt
history. The runtime preserves those prompts verbatim as unattributed evidence
and gives them fresh citations. The source adapter limits individual messages
to 12,000 characters, and delegation uses shorter previews. Full workload
compression, peak process memory and repository-edit success were outside this
evaluation.
