# Repository retrieval baseline

**2026-11-23 · Linux x64 · K=5 · ten initial questions and four edit checks**

Ripgrep found every labeled lexical location within five results. ColGREP
hybrid ranked a relevant hit first for each answerable lexical question and
missed some implementation, caller, or test evidence. Hybrid found one of
three conceptual answers. Both providers returned only valid source excerpts.

| Metric | Ripgrep | ColGREP hybrid |
| --- | ---: | ---: |
| Lexical Recall@5 | 1.00 | 0.79 |
| Lexical mean reciprocal rank | — | 1.00 |
| Conceptual Recall@5 | 0.00 | 0.33 |
| Conceptual mean reciprocal rank | — | 0.11 |
| Complete empty responses for answerless questions | 2/2 | 0/2 |
| Invalid excerpts across initial and edit checks | 0 | 0 |
| Cold first query | 5.7 ms | 1,843 ms |
| Warm repeat of the same query | 3.3 ms | 139 ms |
| Native build on a separate fresh index | — | 960 ms |
| Separate build cache size | — | 554,161 bytes |
| Serialized first response | 308 bytes | 1,022 bytes |

Recall averages the answerable questions in each group. The intentionally
limited question and the post-edit checks are excluded from the averages.
Ripgrep returns matches in scan order, so it has no reciprocal rank. The
conceptual ripgrep queries use their full wording as literal text. The cold
ColGREP query includes asset validation, implicit indexing, and search. The
separate native build times index creation after asset validation.

## Per-question observations

| Question | Ripgrep | ColGREP hybrid |
| --- | --- | --- |
| Exact identifier | 1/1 labeled range | 1/1 at rank 1 |
| Pixel bounds with a similar implementation | 0/1 | 1/1 at rank 3 |
| Duplicate-permit prevention | 0/1 | 0/1 |
| Implementation, caller, and test | 3/3 | 2/3, with the first relevant hit at rank 1 |
| Same multi-file question with limit 1 | 0/3, truncated | 1/3, truncated |
| Absent identifier | Empty | Five unlabeled hits |
| Absent concept | Empty | Five unlabeled hits |
| LTCook map implementation and caller | 2/2 | 1/2, at rank 1 |
| LTCook linked-target protection | 0/1 | 0/1 |
| Original identifier before editing | 1/1 | 1/1 at rank 1 |
| Edited identifier on its new line | 1/1 | 1/1 at rank 1 |
| Superseded identifier | Empty | Five unlabeled hits |
| Identifier at the renamed path | 1/1 | 1/1 at rank 1 |
| Identifier after deletion | Empty | Five unlabeled hits |

Hybrid reached its result cap on this corpus. The unrelated hits on answerless
and superseded queries were valid current source. Source verification alone
therefore gives no basis for treating a ranked hit as an answer. The fixture
is small, and the latency numbers are single observations with filesystem caches
in place. Use these measurements as a starting point for comparable runs before
choosing thresholds.

## Provenance

- Run `3465073f-90da-4b92-85f6-888335ca2cc4`
- Source fixture revision `447477`
- Corpus SHA-256 `f564f5a460f32064b55f25c1cc75fbdb06d59287a6728b0738a9d7a9854a7016`
- Labels SHA-256 `3895d8fc4af7ceb2e230ce196dd974f678cff95941b50fddbcd1b9d7c952207d`
- Implementation SHA-256 `30418a9650477ea16feace359594f2ec442380a5626b84d096cf4fb51e01329e`
- Bun 1.4.4, ripgrep 15.2.0, ColGREP 1.8.5, and ONNX Runtime 1.23.0
- LateOn-Code-edge revision `4bcdf5ed93f791259eb130b577a240f753d68dd8`

See [the evaluation procedure](../docs/Development.md#repository-retrieval-evaluation)
for how to retain the complete machine-readable per-question report.
