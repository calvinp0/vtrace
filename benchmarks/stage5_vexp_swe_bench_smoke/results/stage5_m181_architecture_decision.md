# M181 — architecture decision

## The invariant this milestone records

§100 offers two forms and says not to assert both. The evidence supports the
second:

> **The primary selection reason is part of the semantic evidence contract. It
> must be selected once, by one authoritative rule, before compact and
> uncompacted rendering diverge.**

Not the first form. The first would say a compacting layer may choose any
equivalent representation of the same evidence, and that is exactly what was
happening: `compactReasons` chose a *different truthful* reason and the meaning
moved with it. Truth was never the problem. Every reason in an authoritative set
is true, which is why "both are true" cannot license substituting one for another
— and why an equivalence relation built on truth would make the budget-monotonicity
invariant unfalsifiable by construction.

## §82 — the canonicality table, after

| Reason behaviour | Normal path | Compact path | Authoritative contract |
| --- | --- | --- | --- |
| ordering | `unique([roleReason, ...evidence])`, decisive first | inherited, not re-derived | assembly layer, `assembleProductContext.ts:408` |
| primary selection | `selectionReasons[0]` | `selectionReasons[0]` | declared decisive reason, `productAdapter.ts:48` |
| dedupe | `unique()` upstream; merges APPEND | none — already unique | assembly layer, `:621` |
| full set | rendered as `why:` lines | reduced to one | internal authority, richer than disclosure |
| agent-visible form | `related[].how`, `focus.why` | same, verbatim | `orientationProjection.ts:327` |

Before the repair, one cell disagreed with the rest, and it was the only cell with
no declared contract behind it.

## Why the repair is a deletion

`compactReasons` had two jobs fused into one expression: *reduce the array to one
entry* and *decide which entry*. The first is its job — it is the evidence
budget's first compaction rung and it exists to save model-visible bytes. The
second was never assigned to it. The array arrives already ordered by a contract
established two layers up and consumed verbatim one layer down.

So the repair removes the second job rather than reimplementing it. There is no
new shared selector function, because introducing one would imply the decision
still needed making at delivery time. It does not: it was made at assembly, and
the fix is to stop overruling it.

## What made this hard to see

Three things, and they are worth recording because the same shape will recur.

**The vocabulary collision looked like intent.** `compactReasons`' four
substrings are `answerBearing`'s four substrings, twelve lines above. Read
quickly, "prefer the reason that made this item answer-bearing" sounds like a
semantic priority. It is a *keep-priority* vocabulary — it decides which ITEM
survives — and reusing it to rank an EXPLANATION is a category error that the
shared word "preferred" hides.

**The consumer arrived after the transform.** `compactReasons` shipped in M136
(2026-08-09), when reasons were only ever rendered as a list of `why:` lines and
reducing five to one had no canonical answer to violate. The orientation
projector, which gave position 0 the standing of *the relationship claim*, shipped
in M172 — later. Neither change was wrong when made. The contract broke in the
gap between them, and nothing failed, because `budgetDelivery.ts` had no test.

**The defect was invisible from the delivered response.** Every reason field on a
delivered response has already passed through the transform under test. Asking a
response what the authoritative reason was is asking the accused to testify. M180
needed the same move for items — `modelVisibleContext` as an unforgeable witness —
and M181 needed it for reasons: the frozen authoritative object, which `deliver()`
clones before touching.

## What the permutation control settled

Six orders of one reason set `{A, B, C}`:

| | distinct values across six orders |
| --- | ---: |
| declared decisive reason | **3** |
| `compactReasons`' choice | **1** |

A selector that returns one answer for orders whose decisive reason takes three
different values is not implementing a rival contract. It is blind to the only
contract there is. Without this control the milestone could have concluded that
two defensible priorities merely disagreed, and split the difference.

## Standing invariants, unchanged

- Semantic evidence and serialization metadata have distinct ownership. (M180)
- More budget must not make a fixed authoritative answer semantically worse.
- More budget does not require more output: enough, then stop.
- Budget exhaustion is a truthful bounded state, never an unreachable. (M176/M177)
- Internal authority is richer than default model-facing disclosure. (M171)

M181 adds one, above. It does not weaken any of these: the orientation still shows
**one** reason per item, and §30's prohibition on stabilising semantics by
rendering the whole set was never approached.
