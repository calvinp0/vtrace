# M175 — Orientation Envelope Input-Echo Elimination and Evidence-Budget Correctness

Start state: `stage5_m175_start_state.json` (HEAD `1b078193`, branch `main`, 102 ahead
of `origin/main`, 14 pre-existing worktrees, two pre-existing dirty ledger files left
untouched).

## The defect M174 left behind

M174 traced its empty-delivery fallback and found the fallback was not the problem.
Retrieval had **succeeded** — ten items, correct lead pivot — and the agent received
none of them, because the response envelope spent itself on the agent's own question:

```text
request.query + request.task    20,346 chars    78.5% of the response
repository evidence               3,731 tokens
metadata                          6,435 tokens
ceiling                           9,200 tokens
                                 ─────────────
deficit                             966 tokens
```

The ladder that closes such a deficit may reduce every large field in the response
except one. `request` is exempt by an explicit rule (`responseEnvelope.ts:1288`):
*"`request` echoes the caller's own input verbatim and is a correctness surface, so
it is never rewritten."* So the ladder dropped the only thing it was allowed to
drop — the evidence — and advised the caller to raise `max_tokens`.

## Central question

> Can VTRACE keep full internal request authority while removing redundant request
> restatement from the default model-facing response, so that repository evidence
> stops losing a budget competition to the question it answers?

This is an evidence-budget correctness milestone. It is **not** a retrieval milestone
and does not touch retrieval, ranking, pivot selection, or the projector.

## Workstreams

| | Question | Method |
|---|---|---|
| **A** | What ARE `request.task` and `request.query`, and who reads them? | mechanical `git grep` trace, classified per site, plus empirical identity over 199 captures |
| **B** | Did the echo cause the eviction? | the default path today, plus M174's own default-path capture for the envelope arithmetic; seven synthetic classifier controls |
| **C** | Which disclosure policy, frozen before any holdout is seen? | envelope cost and consumer compatibility only — no delivery outcome consulted |
| **D** | Implement | one function in the existing envelope; `detail=debug` untouched |
| **E** | Qualify on Broad100-A and Broad100-B | two checkouts, one corpus, one index, raw problem statements |
| **F** | Verdicts and closure | four formal verdicts; no live utility claim |

## Method notes that cost something to learn

**The obvious instrument does not work.** Capturing one authoritative snapshot and
replaying compaction under each policy would give perfect isolation. It cannot be
done here: compaction runs before any response is observable, so a capture at the
product's own budget is already the wreck — `productContext.items` arrives empty.
Capturing above the ceiling keeps the evidence, but `max_tokens` feeds `budgetTokens`
(`tools.ts:9189`) as well as `requestedContextTokens` (`tools.ts:9255`), so a wider
capture **selects differently** — 24 items at 120,000 against 10 at 8,000. Measured,
rejected, recorded.

**So the arms are two checkouts.** `before` is served by a worktree pinned to the
pre-repair commit, `after` by this one, both answering against the same absolute
workspace paths and the same indexes. Retrieval is not merely expected to be
unchanged; it is the same code reading the same database.

**Task text is the raw problem statement.** The M171 corpus captures used M103's
derived text at a median of 156–176 characters. The live M173/M174 runs sent the raw
statement — a median of 1,145–1,589 with a tail past 24,000. The defect cannot occur
in the short regime, so measuring it there would measure nothing.

**`detail=debug` is not the default path.** It retains machine-facing diagnostics the
default drops, so it degrades on cases the default delivers — the seaborn control
fails delivery at debug and succeeds by default. Envelope internals are read at debug;
prevalence and delivery are measured on the default path only.

## Constraints

- No live agents, no Docker, no SWE-bench arms. Expected live spend `$0.00`.
- No retrieval, ranking, or projector changes.
- One authoritative `run_pipeline`; no V2 schema, no parallel tool.
- `main` only, local commits, no push, no co-author trailer.
- Pre-existing dirt and all 14 worktrees preserved.
