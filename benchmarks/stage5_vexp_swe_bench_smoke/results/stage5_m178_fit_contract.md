# M178 — the response-fit contract

What VTRACE promises when it says a response "fits", condition by condition, and
which caller is entitled to enforce which promise.

## 1. The question M177 left open

M177 closed with a measured mismatch it deliberately did not resolve:

```text
impactResponseEnvelope.ts:183   fits()   tests three conditions
impactResponseEnvelope.ts:330   terminal tests two of them
```

and warned that "aligning" the terminal to `fits()` would start declining
responses the product returns today. M178 settles which of the three hypotheses
is right. The answer is the third, and it is structural rather than a slip.

## 2. `max_tokens` carries two bounds, and both are published

`get_impact_graph`'s own tool schema states both:

> `max_tokens`: Approximate chars/4 budget for **model-facing impact content**.
> The complete response adds max(800, 15%) metadata tokens and **is checked after
> all fields are attached**.

`run_pipeline`'s says the same thing in the same shape:

> `max_tokens`: Budget for the **MODEL-VISIBLE context**. The complete serialized
> response is **bounded separately** at max_tokens plus a documented metadata
> allowance.

So there was never one contract. There are two, they are both real, and they are
both public. The defect was that one boolean computed both and no name
distinguished them.

## 3. The conditions (§74)

| Constraint | Current implementation | Intended semantic surface | Hard/soft | Final consumer | Changed? |
| --- | --- | --- | --- | --- | --- |
| **C1** `estimatedTotalTokens <= totalCeiling` | `impactResponseEnvelope.ts:192` | complete serialized `structuredContent`, chars/4 | **HARD_DELIVERY_CONSTRAINT** | ladder **and** terminal | predicate extracted and named `impactResponseFitsEnvelope`; truth value unchanged |
| **C2** `serializedCharacters <= 80_000` | `impactResponseEnvelope.ts:193` | complete serialized response, characters | **TRANSPORT_COMPATIBILITY_CONSTRAINT — provably DEAD** | ladder and terminal | folded into `impactResponseFitsEnvelope`, kept as a backstop, pinned by test |
| **C3** `modelVisibleEstimatedTokens <= requestedMaxTokens` | `impactResponseEnvelope.ts:194` | five evidence keys only, chars/4 | **MODEL_VISIBLE_BUDGET, enforced as a COMPACTION TARGET** | ladder **only** | predicate extracted and named `impactResponseMeetsEvidenceBudget`; truth value unchanged |
| **P1** `estimateTokens(render(...)) <= budget` | `budgetDelivery.ts:136` | rendered model-visible context, chars/4 | **MODEL_VISIBLE_BUDGET** | `run_pipeline` delivery packer | documented only |
| **P2/P3** `total <= responseTokenCeiling(requested)` | `responseEnvelope.ts:1509`, `:2311` | complete serialized response, chars/4 | **HARD_DELIVERY_CONSTRAINT** | `run_pipeline` ladder **and** terminal | documented only |
| **P6** `orientationTokens(packet) > 2000` | `orientationProjection.ts:328` | assembled orientation packet, **chars × 0.3174** | **SOFT_PRODUCT_TARGET** | orientation projector | unchanged |

### C2 is dead, and that is proved rather than sampled

`totalCeiling` is `Math.min(requested + allowance, floor(80_000 / 4))` and
`estimatedTotalTokens` is `ceil(serializedCharacters / 4)`. So C1 already bounds
the response at `4 × totalCeiling ≤ 80,000` characters — which *is* C2's bound.
Checked over every budget the tool accepts (1..20,000): **0 counterexamples**,
maximum implied characters exactly 80,000. C2 cannot fail while C1 holds.

It is kept as an explicit backstop and pinned by a test, because the clamp that
makes it redundant is three lines away and easy to change without noticing.

### The estimators are not all the same unit (§42, §43)

Both envelopes and the delivery packer use `chars/4` (`estimateTokens`). The
orientation projector uses M166's measured provider rate, `chars × 0.3174`,
against a **fixed 2,000-token ceiling that is not derived from `max_tokens` at
all**. C2 compares characters to a character constant inside a boolean whose other
terms compare tokens to token budgets. Each side of each comparison is
self-consistent; the conjunction is what hid that one term was not denominated in
the caller's currency. Nothing rides on it today because C2 is dead.

## 4. The authoritative definitions

**MODEL_FACING_RESPONSE_FITS** — the hard delivery constraint, and the only ground
on which a well-formed impact result may be withheld:

```text
the COMPLETE serialized response, measured in chars/4 estimated tokens,
must be <= max_tokens + max(800, 15% of max_tokens), clamped at 20,000.

it counts:      every field the caller receives in structuredContent —
                evidence, metadata, provenance, and the echoed request
it excludes:    the content[0].text duplicate and the JSON-RPC wrapper (M167:
                0 model tokens in the proven client, unremovable under 2024-11-05)
declines:       are themselves measured, and are never re-gated
```

**THE COMPACTION TARGET** — what the ladder is trying to achieve, and never a
delivery gate:

```text
the five evidence keys — edges, nodes, view, directRelations, paths —
must be <= max_tokens.

the ladder sheds evidence while this is false. it has a FLOOR: one relation,
one edge. below that the only remaining move is to deliver nothing.
```

**Terminal acceptance** tests the delivery constraint alone.
**The compaction ladder** is gated on both, because it must keep working while
either is unmet. That asymmetry is the contract, not a bug.

## 5. Why the terminal must not enforce the compaction target (§79)

The window in which a delivered response carries more evidence than `max_tokens`
has a width that is not arbitrary:

```text
width = IMPACT_METADATA_ALLOWANCE_FLOOR_TOKENS - metadataTokens
```

Derivation: below its floor the ladder is exhausted, so the draft is a constant —
`mvFloor` evidence tokens and `metaFloor` metadata tokens. The terminal accepts
when `mvFloor + metaFloor <= B + allowance`, i.e. `B >= mvFloor + metaFloor -
allowance`; the compaction target holds when `mvFloor <= B`. A normal response is
therefore emitted with the target unmet exactly on

```text
B in [ mvFloor + metaFloor - allowance , mvFloor - 1 ]
```

whose width is `allowance - metaFloor`. **Nothing about the evidence enters it.**
The overshoot is the **surplus metadata allowance** — the part of the flat
800-token grant that this specimen's unshrinkable metadata did not need.

On the M177 known positive: `mvFloor = 484`, `metaFloor = 793`, predicted window
`[477, 483]`, width 7 = `800 - 793`. Observed window `[477, 483]`. Across the
frozen corpus the prediction holds on **60 of 60** symbols, 0 failures, and the
measured excess **never exceeds the surplus bound** (max 41, mean 18.08).

So the answer to "should metadata the ladder cannot alter be allowed to fail an
otherwise acceptable response?" is **no — and the metadata allowance is precisely
the mechanism that already prevents it**. By class:

- **Metadata within its allowance** — correctly excluded from the evidence budget.
  This is what the allowance is for.
- **Surplus allowance beyond actual metadata cost** — currently spendable on
  evidence. This is the window. It is the allowance working rather than leaking:
  the alternative is to waste the slack and deliver less.

## 6. Why `run_pipeline` does not have this window

Same two bounds, enforced by **two separate components**: `budgetDelivery.ts`
packs to the evidence budget and sheds all the way to `delivery_failure` rather
than overshoot, and `responseEnvelope.ts` gates on the total — with its ladder
and its terminal testing the *same* condition. Because the packer never leaves
evidence above `max_tokens`, no surplus allowance is ever available to it.

That is a prediction about a different implementation than the one the mechanism
was derived from, and it was checked: **0 delivery-contract violations** and
**0 envelope-contract violations** across 6 snapshots × 16 budgets.

`get_impact_graph` reaches the same two contracts through **one** ladder, which is
why it — and only it — needed the two names.

## 7. The disagreement census (§75)

| Case class | Count | Default budget | Tiny/constrained budget | Root condition |
| --- | ---: | ---: | ---: | --- |
| `fits=false`, terminal emits normally | 564 | **0** | 564 | C3 (compaction target), inside the surplus allowance |
| `fits=true`, terminal declines | 0 | 0 | 0 | — |
| compactor/terminal disagreement (`run_pipeline`) | 0 | 0 | 0 | — |
| delivered outside the envelope (any path) | 0 | 0 | 0 | — |

Envelope-isolated view, 1,042 observations over 60 symbols. The engine-coupled
view — where the engine's own spend of `max_tokens` moves with the envelope's —
records 2 at pressure budgets and **0 at the default**.

**Blast radius at the default budget: zero, in both views.** The largest
irreducible evidence floor in the corpus is 655 tokens, well under the 1,200
default, so no corpus symbol can reach its window at the default.

## 8. Verdict on the three hypotheses

- **H1 FITS_IS_AUTHORITATIVE** — rejected. Promoting C3 to a delivery gate would
  convert 564 bounded deliveries into declines, destroying 25 delivered edges, to
  reclaim at most 41 tokens each — and those tokens were never the caller's
  evidence budget to begin with.
- **H2 TERMINAL_ACCEPTANCE_IS_AUTHORITATIVE** — rejected. Removing C3 from the
  *ladder* would leave evidence bounded only by `max_tokens + allowance -
  metadata`, so a request for 400 tokens of content could return ~700. That
  abandons a bound the schema publishes.
- **H3 CONCEPT_CONFLATION** — **confirmed.** Two legitimate, separately published
  contracts were computed by one boolean called `fits()`. Both callers were
  already correct. Only the naming was wrong.
