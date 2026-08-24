# M179-A — the delivery packer, and the two bounds it sits between

What actually decides how much of a `run_pipeline` answer reaches the model, in
execution order, with every budget-dependent branch and every hidden cap named.

## 1. The path

```text
authoritative run_pipeline output          items[] WITH bodies, modelVisibleContext rendered
        |
        v
compactProductResponse(output, {requestedContextTokens: B})
        |
  [P]   applyProgressiveContextBudget(draft, B)     <- THE PACKER. Owns modelVisibleContext.
  [0]   projectRequestDisclosure                       M175
  [1]   compactProductContextItems                     removes items[].content as a duplicate
  [2]   compactCapsuleResult / LegacyContext / Diagnostics
  [3]   compactDiagnostics / reduceDiagnosticsToAgentFacing
  [5]   compactPivotNeighborhood
  [6]   compactImpactSection
  [7/8] enforceTotalEnvelope(ceiling = responseTokenCeiling(B))
        |
        v  measureResponse -> within_envelope?
  no -> compactMandatoryProductMetadata      items[] collapsed to ONE
  no -> compactNonessentialEnvelopeMetadata
  no -> degradeOversizedProductResponse      resultState = delivery_failure, items = []
  no -> buildBoundedEnvelopeDecline          M176 terminal
        |
        v
projectRunPipelineOrientation                null unless resolved && !deliveryFailed && ready
```

## 2. The packer is a state machine, and it only ever sheds

```text
             +-- no items, not resolved --> NO_RESULT
ENTRY -------+-- initialModelTokens <= B --> COMPLETE          (ladder never runs)
             +-- initialModelTokens >  B --> ladder:

  R0  SELECTION_REASONS_COMPACTED      every item            representation
  R1  SUPPORT_EXCERPT_SHORTENED        optional support      representation   (900 chars)
  R2  SUPPORT_SKELETONIZED             optional support      representation
  R3  SUPPORT_DROPPED                  non-answer-bearing    SELECTION
  R4  SECONDARY_PIVOT_SKELETONIZED     pivots[1..]           representation
  R5  SECONDARY_PIVOT_DROPPED          pivots[1..]           SELECTION
  R6  WEAK_CONTEXT_DROPPED             keeps at least one    SELECTION
  R7  MINIMAL_REPRESENTATION           every item            representation
  R8  STRONGEST_ITEM_ONLY              keep best             SELECTION
      |
      +--> DELIVERY_FAILURE
```

Three properties, each checked rather than assumed:

- **The rung sequence does not depend on the budget.** Every mutation above runs
  unconditionally; `publishIfFit` only *reads*. The drafts `D0..D8` are therefore
  the same at every budget, and the budget selects only where to stop.
- **No rung grows a draft.** Each is a subsequence or a subset of the one before.
- **Therefore the packer is budget-monotone on its own.** Measured on the known
  positive: the packer resolves at *every* budget of the Django ladder, and its
  delivered item count rises 1 -> 12 -> 17 -> 22. It never declines.

That last point is where M179 diverged from the milestone it inherited. M176
attributed the non-monotonicity to "the progressive delivery packer"; the packer
is not where it lives.

## 3. Selection versus rendering

| Decided by | Selection | Rendering |
| --- | --- | --- |
| packer | R3, R5, R6, R8 (items removed) | R0, R1, R2, R4, R7 (bodies weakened) |
| envelope | `compactMandatoryProductMetadata` (items -> 1), `degradeOversizedProductResponse` (items -> []) | — |
| projector | related-list prefix admission | focus head bound |

**The packer owns `modelVisibleContext`, and nothing downstream can shrink it.**
The two metadata escalations reduce metadata only. So once the packer has chosen
a rung, the envelope's sole remaining move against an oversized response is to
discard the evidence entirely. There is no rung between "the packet the packer
chose" and "nothing".

## 4. Hidden bounds (§20)

| id | value | governs |
| --- | ---: | --- |
| H-SUPPORT-EXCERPT | 900 chars | size of the R1 step |
| H-MINIMAL-LINES / CHARS / FALLBACK | 8 lines / 480 / 240 chars | floor size of a skeletonized item |
| H-REASON | 160 chars | size of the R0 step |
| H-FOCUS-CODE | 1,800 chars | focus excerpt head bound |
| H-ORIENTATION-CEILING | 2,000 tokens (chars x 0.3174) | related list. **Not derived from `max_tokens`** |
| **H-METADATA-FLOOR** | **1,000 tokens** | **the flat metadata allowance. The binding bound.** |
| H-METADATA-RATIO | 0.15 | overtakes the floor only above `max_tokens` 6,667 |
| H-MANDATORY-ITEMS | 1 item | last-resort item collapse |

## 5. The arithmetic that makes the two bounds disagree

M178 named them: `max_tokens` bounds the **evidence**, and
`responseTokenCeiling(B) = B + max(1000, ceil(0.15B))` bounds the **complete
response**. The packer targets the first. Delivery is judged on the second. So
what a response can actually carry is

```text
affordable evidence = ceiling(B) - actual metadata
                    = B + allowance - actual metadata
```

which is **less than `B`** whenever real metadata exceeds the flat allowance. On
the known positive, metadata is 1,087-1,269 tokens against an allowance of 1,000:
the packer is permitted to spend about 221 tokens it can never deliver.

The packer is not misreading its bound. It is faithfully enforcing a bound nobody
can honour, and no component between it and the terminal knows enough to say so.
