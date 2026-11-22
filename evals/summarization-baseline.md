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
export LTCOOK_SUMMARIZER_MODEL=lfm3:1.7b-q8_0
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
