# M180 — the item ownership and lifecycle contract

## What `productContext.items` is supposed to represent

Two things, and before M180 nothing in the code or the types said which.

```text
AUTHORITATIVE SEMANTIC SUPPLY        what evidence this response carries
        owner: assembleProductContext, then applyProgressiveContextBudget
        lifetime: fixed once the evidence budget has run
        may change: only for the evidence budget, which is max_tokens' own contract

MODEL-FACING METADATA REPRESENTATION how that evidence is described in the response
        owner: src/mcp/responseEnvelope.ts
        lifetime: one serialization attempt, discarded whenever the projector resolves
        may change: freely, to fit the complete-response ceiling
```

The formal classification is `MIXED_RESPONSIBILITY`. The array legitimately
carried both, and the type distinguished neither their owners nor their lifetimes.

## Was `compactMandatoryProductMetadata` authorized to change the semantic supply?

**NO.** It controls serialized response metadata. Its own contract is the
metadata allowance; it has no view of retrieval, no view of ranking, and no
notion of what a symbol means. It nonetheless decided, on 722 of 1,380 delivering
budgets, which symbols the agent would be told about — while leaving the
rendering of those same symbols in the response it was shrinking.

Partial is not the right answer either. Every field it drops is presentational
*except* the rows themselves, and dropping a row is not a presentational act when
another component reads the array as an index.

## Was the projector consuming an authoritative surface or a mutable one?

A **mutable serialization surface**. `tools.ts` names the value
`authoritativeResult`, and it is authoritative in the sense the name was chosen
for — complete rather than projected — but it is the output of
`compactProductResponse`, which is to say a budget-dependent serialization. The
projector ran downstream of the serializer and read the serializer's output as
evidence.

There is a sharper way to say it. On the default path the compacted response is
**discarded**: `tools.ts` returns `orientation ?? decline ?? authoritativeResult`,
so when the projector resolves, nothing the envelope produced crosses the wire.
The envelope was budgeting a payload nobody receives, and the one lasting effect
of that budgeting was to cut the index of the payload that does.

## The contract now

> **Response metadata compaction may change how evidence is represented to satisfy
> an envelope. It may not change the semantic evidence supply used by later
> orientation decisions.**

> **For fixed authoritative evidence and ranking, a larger delivery budget must
> not cause focus or related semantic evidence to disappear because an earlier
> serialization step rewrote the evidence source.**

Enforced structurally rather than by convention: the supply the projector reads is
published by the component that owns the evidence budget, is frozen at
publication, and is never part of the response — so no serialization rung can
reach it, present or future.

## Three lifetimes, named

| | published where | lives as long as | who may change it |
| --- | --- | --- | --- |
| authoritative semantic supply | `semanticItemSupply.ts`, keyed on the productContext record | the response object | nobody, after publication |
| derived model-facing metadata | `productContext.items` | one serialization attempt | `responseEnvelope.ts`, freely |
| the delivered packet | the orientation packet | the request | nobody; assembled frozen |

## What was deliberately not done

- **No new response field.** `semanticItems` and `compactedItems` as two public
  arrays would disclose the same facts twice, which is the tax M166/M167 measured.
  Internal authority may be richer than default disclosure (M171); it is.
- **No V2 anything.** No `productContextV2`, no `itemsV2`, no `run_pipeline_v2`.
  M178's names are unchanged.
- **No `ProductContext` type redesign.** A small explicit supply reference states
  the ownership split; a type-system rewrite would state it no better.
- **`compactMandatoryProductMetadata` was not deleted.** It does useful work and
  still does it: metadata token medians are unchanged to the token, and the same
  722 budgets still have their item rows ejected. What was repaired is what it is
  allowed to mutate, not whether it exists.

## One thing the repair gives up

`projectRunPipelineOrientation` is no longer a function of its argument's JSON
alone. It reads the supply through the productContext record's **object
identity**, so a value that was cloned or round-tripped through JSON on the way
in carries no supply and the projector falls back to `productContext.items` —
the pre-M180 source, and the safe direction to fail in. The module header says so.
Production has no copy on that path: `tools.ts` hands the compacted response
straight to the projector, and `get_code_context` returns early whenever the inner
pass projected an orientation, so its `remeasureResponseBudget` spread is only
ever reached on a decline.
