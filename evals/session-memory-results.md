# Session Memory model evaluation

No tested configuration qualified for automatic Session Memory enrichment.
The original-source Pi control returned all five required fields. The
evaluated Memory handoffs missed the required final target even though they
included the unsummarized correction. Automatic enrichment is opt-in while
shared Memory reads and source citations are available.

## Method

The synthetic invoice-replay fixture contains different versions of a design,
an unrelated assignment, an unattributed approval claim, source symbols,
implementation observations, and an explicit correction immediately before
delegation. Its SHA-256 is
`6f5c51d7b0cd62a927b75d1b8bbf6d87f8b99abf9bec42ace934dc46566a9162`.

The matrix used a Ryzen 9 9900X with 24 logical CPUs under Linux. Ollama ran
the four Q8 extraction candidates on CPU, with a 16,384-token context,
2,048-token output cap, temperature zero and reasoning disabled. Model
digests stayed the same. Fresh Pi sessions used the same local Bonsai model
for both conditions. The Bonsai runs used the host's normal acceleration.
The original-source control received the relevant authorized messages. Each
candidate handoff used the production context selector and renderer. The
hard gate required the critical facts, current target, valid citations and
correct attribution at each update, followed by a passing Pi handoff.

## Initial matrix

The first comparison used JSON mode. All 12 model and cadence arms failed
qualification. There were 11 extraction attempts per model because a rejected
delta left the checkpoint in place. The first request for each model started
with it unloaded. Request latency includes prompt processing and generation.
Throughput counts generated tokens over the entire request.

| Q8 candidate | Ollama digest prefix | Valid deltas | Cold request | Warm requests | Output tokens/s | Loaded model |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| LFM2.5-350M | `20b6da56bc7c` | 0/11 | 2.48 s | 1.45–15.12 s | 36–102 | 690 MB |
| Qwen3.5-0.8B | `7c00f78aed0f` | 1/11 | 5.74 s | 3.42–47.27 s | 13–43 | 1,299 MB |
| LFM2.5-1.2B-Instruct | `2286ca7057af` | 0/11 | 7.05 s | 5.71–12.67 s | 18–34 | 1,622 MB |
| Spark-X2.6-4B | `b3bfb5c5eb15` | 0/11 | 26.30 s | 27.45–69.78 s | 3–12 | 4,755 MB |

The original-source control passed in 11.49 seconds with 491 input tokens. All
12 candidate Pi handoffs failed the target field. Their input lengths were
799–864 tokens. The full comparison took 802.40 seconds.

## Structured-output follow-up

Ollama's JSON Schema mode constrained entry types, statuses, and usable source
numbers. The handoff put recent explicit user messages first. Each
candidate ran at 3,000 tokens with the same fixture, CPU generation settings
and downstream model. All four fresh original-source controls passed.

| Candidate | Accepted deltas | First request | Later requests | Pi handoff |
| --- | ---: | ---: | ---: | --- |
| LFM2.5-350M | 1/3 | 3.36 s | 4.70–7.20 s | Target failed |
| Qwen3.5-0.8B | 2/3 | 8.49 s | 3.50–6.88 s | Target failed |
| LFM2.5-1.2B-Instruct | 1/3 | 10.85 s | 7.44–10.48 s | Target failed |
| Spark-X2.6-4B | 1/3 | 54.79 s | 28.86–60.17 s | Returned the task ID as the target |

Qwen preserved the final target and cited the correction in its final
extraction. It still missed required structured constraints and some earlier
technical findings. The 350M candidate retained the objective but lost the
critical constraints. The 1.2B candidate attributed a correction to an earlier
message. Valid JSON and existing sequence numbers alone did not establish
that a citation supported a claim. Spark also lost critical structured
constraints and rejected both later deltas. In its paired handoff, Pi
returned `INV-204` for the target while the source control returned
`invoice-v3`. The four follow-up runs took 215.78 seconds combined.

## Cadence and recommendation

The first 1,500-token job was eligible after the first completed turn at
1,939 estimated tokens. At a threshold of 3,000, the first job was eligible
after the second turn at 3,894 tokens. A threshold of 6,000 waited until the
fourth turn at 7,833 tokens in the evaluation runner. That last batch exceeds
the runtime's per-job cap of 6,500, so its duration is a stress comparison.
A shorter threshold exposed earlier facts sooner and increased inference
attempts when the model kept rejecting the same uncommitted context.

Keep 3,000 as a provisional threshold. No arm earned a production model
recommendation. Qwen3.5-0.8B is the best candidate for another qualification
run because it retained the final correction and accepted more deltas than
the other smaller models. Spark remains the existing summarizer and comparison
reference. The qualification uses one labeled conversation and measures the
Pi worker's interpretation of a handoff. Loaded bytes are Ollama's model
residency, and the timings come from a shared development host. Broader
workload latency, peak process RSS and repository edit quality need separate
evidence before generalizing the result.
