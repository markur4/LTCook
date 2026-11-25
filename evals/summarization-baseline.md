# Summarization qualification baseline

**2026-11-22 · Synthetic Setup · full qualification · failed**

LFM3 returned 17 fixed-fixture summaries. Fourteen attempts passed, two failed,
and one semantic grade was blocked. Bonsai passed all five calibration
examples, including all three held-out examples. The native Pi agent returned
the expected `HOLD` decision. The CLI completed the run and exited with status
1 for the failed qualification. The summarization evaluation took 100.1
seconds including generation, grading, calibration, and the downstream decision.

## Settings and provenance

Run `ltcook eval run --all --setup synthetic --case summarization` against a
runtime configured with these global AppRC settings.

```shell
export LTCOOK_MODEL_LOCAL_CPU=lfm3:1.7b-q8_0
export LTCOOK_SUMMARIZER_GENERATION='{"think":false,"stream":false,"options":{"temperature":0.1,"num_ctx":4096,"num_predict":128}}'
```

- Summarizer manifest digest `a329e3b38ec2bb26c1bcd74c84acca3a8965e4d7d22c5b2f70ab5bcedc399984`
- Grader `ltcook-bonsai-2-27b-ctx65536:latest`, manifest digest `bd5f3c102bf783b2552ca4353f467e9c495dd4fe305453edfafe1e466abe531d`
- Fixture hash `03d78fb18507a7ce0f991efd7653cc3d983abf18ff28086f94c95e0757ed7800`
- Summarizer prompt hash `068646f866de67947db3c0409abc8b457ece1fab7b9c8ea7c9631e48215731c9`
- Grader prompt hash `34ff1a81e0cc8364b1cbb117fa661dd969368ff08328779a8d70e83f9e490d61`

The focused near-limit case used 3,203 source bytes and passed. The migration
case passed all three inline attempts and the file attempt. The structured
report for run `ef48439d-d8b8-4794-accf-cb57241c7622` includes the original
fixed-fixture outputs, checked evidence, token counts, and timings.

## Failures and blocked evidence

| Case | Attempt | Verdict | Observation |
| --- | --- | --- | --- |
| Artifact negation | Inline 1 of 3 | Failed | The response reached the 128-token output limit and cut off while repeating a fact list. Attempts 2 and 3 passed. |
| Recovery focus | Inline 1 of 1 | Failed | The source says “Ada disabled writes to queue Q-11 and will recheck at 14:30 UTC.” The output says “Ada, who is disabled, writes to queue Q-11 and will recheck it at 14:30 UTC.” This reverses the action despite preserving the name, queue, and time. |
| Rollout decision | Inline 1 of 1 | Blocked | Bonsai supplied an invalid summary citation for a required fact. The separate native Pi decision returned `HOLD`. |

Earlier LiquidAI runs confirmed missing `ops/db.py` and `Inez` across repeated
migration attempts and loss of `AUTH-17` and `Nia` in the near-limit case.
Those runs used the default 32,768-token context and 512-token output limit,
and semantic checks were blocked during grader calibration. The fixed
fixtures retain those failures as regression checks.

## Local reasoning qualification

The local follow-up used the same LFM3 model and a 4,096-token context at
temperature 0.1. With reasoning enabled, 128 output tokens yielded 17 empty
cutoffs. At 512 output tokens, 10 of 17 attempts passed and seven cut off.
At 1,024 output tokens, 13 passed, two cut off, and two grades were blocked
by invalid citations.

The first 2,048-token runs completed all 17 summaries. Two formatting
mismatches were diagnosed in successive runs. Bonsai quoted adjacent list
items as one sentence and quoted a bold label without its Markdown markers.
The validator now accepts those formatting differences while retaining
the exact excerpt from the summary.

A local full run `89de39bb-c791-43c4-980d-c34c725bb360` used
`think: true`, `stream: false`, and `num_predict: 2048`. All 17 attempts
and all five Bonsai calibration examples passed. Native Pi returned
`HOLD`, and the CLI exited with status 0 after 99.2 seconds. This profile
allows up to 1,391 source bytes without a focus. The focused near-limit
fixture used 1,283 bytes and passed. The fixture hash was
`5e5e94ade71ba6d861be14c01e0a52e014f1e8a9f36fb5a929da34c2c4cf0446`.

A repeat with the same generation settings and code fingerprinting enabled
passed 16 of 17 attempts. The near-limit case reached the output cap before
preserving `AUTH-17` and `Nia`, so qualification failed. All five Bonsai
calibration examples passed and native Pi returned `HOLD`. The report for run
`24babf9b-d7fc-4ecc-8b0c-f60f0d1de5b1` recorded the runtime bundle hash
`7e2a229d5eeffcc9c8b9e2f72c38852081a69ae29536ab0ae089bb488e729a92`.

The startup-fingerprint follow-up passed all seven core cases and all five
Bonsai calibration examples. The focused run
`8d4dec10-44cd-4242-807a-f40ce66690de` exited with status 0 after 54.2 seconds.
Its recorded bundle hash matched the freshly built runtime
`bb7c24edbdb3bdb238218e6ff65c082531ac2f77f6ca38293e30236d5cfe40f8`.
The full run `fc54805b-dd1a-4618-98f1-e03e1ccad0ae` used the same build and
settings. It passed 16 of 17 attempts and all five calibration examples.
Native Pi returned `HOLD`. Qualification was blocked because the dashboard
summary used a narrow space in `14:30 UTC` and Bonsai cited it with a regular
space. A Traditional Test now verifies that the citation validator accepts
that spacing difference and preserves the original excerpt.

With the citation fix and the same generation settings, the core run
`b725b02e-838f-41c3-9050-cd63612336d3` passed all seven attempts in 57.9
seconds. The full run `eb1c2ab5-03f2-4e0a-b522-758c90134494` passed all 17
attempts in 108.6 seconds, including the near-limit case and file/inline
comparison. Both passed all five Bonsai calibration examples and exited
with status 0. Native Pi again returned `HOLD` in the full run.
Both reports recorded the runtime bundle hash
`82efc3ef1bceb3f24161d7f46d215b095215455c6f603d37bf5bbe11bf159a1d`.
The full fixture hash was
`7d4952238d8649a47cf9a0d98d7e0c0f31525824aeea0c4e8d405bd1eb3cd698`.

## Calibration fixture review

Codex checked the expected judgments against the fixed source passages,
sample summaries, and requested focus. The review confirmed the judgments
for all five calibration examples and the downstream control.

- `faithful-paraphrase` preserves all three required facts, including the
  uncertainty about why deployment was skipped.
- `wrong-event` contradicts the migration failure while preserving Inez's
  decision to wait. The ID, exit code, and path all match, so this case checks
  the outcome itself.
- `negation-and-missing-fact` reverses the deletion status and omits `Q-11`.
  Ada's move of three files to `reports/weekly` is preserved.
- `irrelevant-omission` preserves the dashboard deadline, owner, and lack of
  migration approval. The requested focus permits omitting queue recovery.
- `unsupported-material-claim` preserves the ruled-out cause, the remaining
  uncertainty, and the unapproved retry. The $50,000 cost is unsupported.
- The downstream control preserves the scope of Ada's approval and Inez's
  explicit refusal. The supported decision is `HOLD`.

## LFM3 default qualification

The default keeps the 24 KiB input allowance by using a 32,768-token context.
With reasoning enabled and a 2,048-token generation limit, full run
`58654548-2c5f-4f11-9472-fd90dafea1e5` passed 15 of 17 attempts. The near-limit
case reached the cap before returning a summary with `AUTH-17` and `Nia`.
An artifact-negation grade was blocked when Bonsai quoted a Markdown label
without its italic markers. All five calibration examples and the downstream
decision passed.

The final default raises the generation limit to 4,096 tokens. Full run
`30cd96aa-f6bf-4dc9-8f90-63d055b0e0b1` passed all 17 attempts and all five
Bonsai calibration examples. The 24,575-byte near-limit input preserved
`AUTH-17` and `Nia`, and native Pi returned `HOLD`. The run took 111.2 seconds.
The runtime bundle hash was
`8a0c57f8a126a554ce84a2bf1fcc28b5bb3733f72d886a9aa30467a5a2da128e`
and the fixture hash was
`ac783efe57b57e879652db622985be6b560978884ea0caa23ad3113a5de901a9`.

## Expanded full qualification

The coding-session fixture's required facts were checked against the fixed
handoff. `RB-214` initially failed in the reconcile test, and `RB-241` passed
in the cache test. The healthy rebuild rules out the cache, while the manifest
inspection explains the failure and why the second `RB-214` attempt passed.
The Windows check was skipped, publishing lacked approval, and `PKG-72`
remained open. In the positive downstream control, the required owner explicitly
approved `R-32` on Tuesday, superseding Monday's refusal. The separate `R-33`
migration remained deferred.

The first expanded run `787106d1-a136-41e9-8838-1202305adf29` used the production
LFM3 profile and passed 20 of 21 summary attempts in 159.4 seconds. Both native
Pi decisions matched their expected outcomes, `HOLD` and `PROCEED`. All three
near-limit attempts and all five Bonsai calibration examples passed. The
coding-session summary reached the generation limit after an opening checksum
fragment. All seven required facts were missing and qualification failed.

The repeat `607eb4f1-4274-4a29-b334-60fc55678bca` also used production settings
and passed 19 of 21 attempts in 159.3 seconds. The coding handoff again spent
all 4,096 generation tokens before returning a summary. Near-limit attempts 1
and 2 passed. Attempt 3 preserved the decision but wrote `AUTH‑17` with a
nonbreaking hyphen. The exact check rejected the variant. Both native Pi
decisions and all five Bonsai calibration examples passed. The overall verdict
was `failed`. The fixture hash for both expanded runs was
`b3d8f2169e110493b3cdf162f7297142393b49f48e27fcc8673f412fed4e22b9`.

## Opt-in Pi utility comparison

The [fixed-task comparison](../docs/Development.md#opt-in-summarization-utility-comparison)
used the same local Bonsai model and coding-session source in two fresh Pi
sessions. In an exploratory trial, both agents kept calling tools until timeout.
The checked comparison used the same four-call budget for both conditions.

| Condition | Correct fields | Elapsed | Pi input tokens | Pi output tokens | LFM3 input / output tokens | Tool calls |
| --- | ---: | ---: | --- | ---: | --- | --- |
| Read | 11/11 | 5.2 s | 4,005 uncached + 3,522 cache reads | 312 | — | 4 reads |
| Summarize, with fallback read | 11/11 | 18.2 s | 2,440 uncached + 3,087 cache reads | 290 | 581 / 4,096 | 1 summarize, 3 reads (1 successful) |

Pi started the second condition with the real path-and-focus call. LFM3 reached
its generation cap, so Pi recovered the source with `read` and answered from
that evidence. The summarizer condition was incomplete. Both sessions reached
the tool-call budget and Ollama reported zero cache-write tokens. These timings
and token counts describe a failed summarization attempt with recovery.

A repeat with the same setup completed the summary and returned all 11
fields correctly in both conditions.

| Condition | Elapsed | Pi input tokens | Pi output tokens | LFM3 input / output tokens | Tool calls |
| --- | ---: | --- | ---: | --- | --- |
| Read | 5.6 s | 4,001 uncached + 3,516 cache reads | 312 | — | 4 reads |
| Summarize, then verify | 15.6 s | 3,848 uncached + 2,794 cache reads | 290 | 581 / 3,087 | 1 summarize, 3 reads (1 successful) |

The completed summary reduced Pi's input by 875 tokens in this pair. The
summarizer used 581 input tokens and generated 3,087 tokens, including
reasoning. The condition took about 10 seconds longer and still used a
successful source read. Ollama reported zero cache-write tokens in both
conditions. These results describe this task, execution order, and local models.

## Coding-handoff cutoff and ticket typography

An increased reasoning limit of 6,144 tokens did not resolve the cutoff. In run
`8c7943c4-bf52-4530-b9f2-da2a6d26153f`, the coding handoff again returned no
summary at the limit, while the other 20 attempts passed. Both Pi decisions,
the three near-limit attempts, and all five Bonsai calibration examples passed.

The default retains its 4,096-token limit per attempt and retries once without
reasoning when the first response is incomplete. The two requests share the
existing timeout. For designated ticket IDs, the evaluation treats Unicode
hyphen and nonbreaking hyphen as equivalent to the ASCII hyphen. It retains
the original summary and quotations in the report.

Run `7ebe2e3f-ff48-4208-a660-96dde4f49de1` passed the coding handoff on its
first generation and all three near-limit attempts. An invalid quotation from
an italicized summary label blocked the artifact-negation grade. The citation
matcher now recognizes that Markdown emphasis and retains the original text.

Run `85817681-3c5a-471c-bdfe-1295669cb5a0` hit the 4,096-token limit on the
coding handoff. The retry returned a complete summary in 270 output tokens
with all required exact values. All three near-limit attempts, both Pi
decisions, and all five Bonsai calibration cases passed. Full qualification
was blocked at 20 of 21 summary attempts because Bonsai supplied an invalid
source quotation for a coding-handoff claim. The opt-in comparison exercised
the retry a second time and both Pi conditions answered 11 of 11 fields
correctly.
