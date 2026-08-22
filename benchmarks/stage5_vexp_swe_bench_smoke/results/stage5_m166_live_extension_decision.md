# M166 — live extension decision

## Decision

```text
AUTHORIZED   NO
RECOMMENDED  NO
```

No paid agent work is proposed by M166, and none was run: the milestone spent zero
dollars on model calls (§57). The evidence for the extension threshold (§61) does not
close.

## The threshold, tested

§61 permits proposing paid live work only when all four hold:

| condition | verdict | basis |
| --- | --- | --- |
| model-visible tax confirmed | **YES** | `MODEL_VISIBLE_METADATA_TAX_CONFIRMED`; the runtime hands the model the whole envelope untruncated, billed at a median 8,944 tokens and re-read on every later request |
| offline compression material | **NO** | the shipped change moved the median response 11,067 → 10,734 tokens, −3%. The simulated −53.6% did not survive contact with the envelope ceiling |
| evidence semantics identical | **YES** | 12/12 on rendered evidence, selection, readiness, absence, control semantics; evidence never lost and restored on 5/12 |
| machine consumers preserved | **YES** | `detail=debug` returns the diagnostics in full; CLI and programmatic paths untouched |

The second condition fails, so `DO NOT EXTEND`.

## Why a full-vs-compact economics ablation would not be informative now

§59 sketched `CURRENT_PIPELINE_TRIGGER` vs `COMPRESSED_PIPELINE_TRIGGER` over the same
twelve tasks, holding evidence selection fixed and varying only representation. That
design is still correct — but it needs two arms that differ by thousands of tokens to
have anything to measure. The arms available today differ by ~330 median tokens on an
~11,000-token call, inside the run-to-run variance M164 already documented. Spending
~$20 to measure a 3% representation delta against a solve-rate signal that produced
zero unique wins at full strength would buy a null attributable to the design.

## What the change actually bought, and why it is not a token result

The response is envelope-bound. `responseTokenCeiling(requested_context_tokens)` caps
it at 9,200 product-tokens and the progressive packer fills the cap: 6/12 responses sat
within 500 tokens of it before the change, three of them within 54. Removing the
machine diagnostics therefore did not shrink the response — it freed budget the packer
immediately spent on evidence it had been compacting away. Pivot-neighborhood excerpts
went from 8 to 28 across the twelve, restored on 5/12 tasks that previously received
none.

That is a better outcome than a token saving and a worse one for an economics ablation:
the tax was converted into evidence rather than removed, so there is no cheap arm to
compare against an expensive one.

## What would make a live experiment informative

Either of these, and neither is started here:

1. **Lower the ceiling as the treatment.** With the diagnostics gone, the same evidence
   now fits a smaller envelope. A paired run at a reduced `max_tokens` against the
   current default would vary representation cost by thousands of tokens while holding
   selection fixed — the §60 design, with arms far enough apart to read.
2. **The hard-localization corpus.** M166 removes response tax as an explanation for
   M164's null, joining retrieval quality, composition, adoption and answerability. The
   remaining untested variable is still the task population.

## Standing rails carried forward

No live agents, Docker, or 30/100-case sweeps without explicit approval. The next
milestone should read this file and `stage5_m166_final_report.md` before proposing spend.
