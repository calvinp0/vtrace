# Stage 5 — M18 revision replacement/adoption guardrail audit

**Goal.** Stop treating "the revision improved the compliance shape" as if it meant "the
revised patch is safe to adopt as the final patch." M17.1 proved those are different
things: sphinx r1 and r2 both improved compliance (`unclear[ast.py] → edited[ast.py]`) and
both carried the legacy `replacedFinalPatch=true`, yet only r2's revised patch actually
**resolved** in a read-only shadow Docker eval. r1's stayed unresolved.

This audit recomputes the new adoption decision (`decideRevisionAdoption`) over the
**existing** M17 shadow-eval outputs — read-only, no new agents, no new Docker.

## What changed

- **New pure guardrail** `decideRevisionAdoption` (`revisedPatchShadowEval.ts`). It
  separates three concepts that the old code conflated into one boolean:
  - `revisionCandidate` — compliance improved (the old `decideReplacement` signal). A
    candidate is *not* adoptable.
  - `replacementRecommended` — verified safe to adopt. Gated on a **shadow-eval
    outcome**; compliance improvement alone can never set it true.
  - `canonicalReplaced` — whether canonical artifacts were *actually* replaced. Always
    false in read-only shadow mode (this module only recommends).
- **Corrected `replacedFinalPatch` semantics** (`pivotRevisionPass.ts`). It now mirrors
  `canonicalReplaced`: true only when an `installFinalPatch` actually happened. The live
  wiring omits `installFinalPatch`, so it now stays **false** there — fixing the
  misleading legacy behavior where it tracked compliance improvement instead of real
  replacement (the exact M17.1 finding). The compliance-improvement signal now lives in
  the new `revisionCandidate` field.
- **Shadow-eval orchestrator** (`--mode evaluate-revised-patch`) now writes an `adoption`
  block into `_pivot_revision_shadow_eval.meta.json` so future shadow evals record the
  candidate/recommended/replaced distinction directly.

## How adoption is now decided

`replacementRecommended` requires one of:

| Shadow classification              | Resolutions                         | Recommended |
| ---------------------------------- | ----------------------------------- | ----------- |
| `shadow_resolution_success`        | original unresolved, revised resolved | **yes**   |
| `shadow_preserves_resolution`      | both resolved, no over-edit         | **yes**     |
| `shadow_preserves_resolution` + over-edit | both resolved, extra unrelated files | no   |
| `shadow_no_effect`                 | both unresolved                     | no          |
| `shadow_harm`                      | original resolved, revised unresolved | no        |
| `shadow_skipped_empty_or_identical`| nothing meaningful to evaluate      | no          |
| `shadow_inconclusive` / no shadow eval | not verified                    | no          |

Compliance improvement maps only to `revisionCandidate`, never to
`replacementRecommended`.

## Audit of existing M17 shadow-eval outputs

| label | original resolved | shadow revised resolved | old compliance-improvement signal | old `replacedFinalPatch` | new `revisionCandidate` | new `replacementRecommended` | new `replacementReason` | `canonicalReplaced` | classification |
| ----- | ----------------- | ----------------------- | --------------------------------- | ------------------------ | ----------------------- | ---------------------------- | ----------------------- | ------------------- | -------------- |
| `eval-m16-ruleout-guard-current-sphinx-7462-r1` | false | false | true | **true (misleading)** | true | **false** | `shadow_no_effect` | false | `shadow_no_effect` |
| `eval-m16-ruleout-guard-current-sphinx-7462-r2` | false | true | true | true | true | **true** | `shadow_resolution_success` | false | `shadow_resolution_success` |
| `eval-m16-ruleout-guard-current-seaborn-3187-r2` | true | n/a (skipped) | false | false | false | false | `shadow_skipped_empty_or_identical` | false | `shadow_skipped_empty_or_identical` |

### Per-label reading

- **sphinx r1** — compliance improved, so it is a `revisionCandidate`, but the shadow eval
  shows `shadow_no_effect` (revised patch still unresolved). **Not recommended.** The old
  `replacedFinalPatch=true` was exactly the misleading signal M17.1 flagged; the corrected
  fields now say candidate-yes / recommended-no.
- **sphinx r2** — compliance improved AND the shadow eval shows `shadow_resolution_success`
  (original unresolved → revised resolved). **Recommended.** This is the only case where
  adoption is justified, and only because verification — not compliance — confirmed it.
- **seaborn r2** — the revised patch was identical to the original, so the shadow eval was
  skipped (`shadow_skipped_empty_or_identical`) and compliance did not improve. **Not a
  candidate and not recommended.**

## Decision

The guardrail now correctly separates the r1 and r2 cases that the old single boolean
could not: same compliance verdict, same legacy `replacedFinalPatch`, but only r2 is
recommended for adoption — because only r2 was verified to resolve. `canonicalReplaced`
stays false for all three: nothing was wired into canonical evaluation.

**Verdict: `revision_shadow_eval_success`** — the replacement decision is now gated on
verification, and the three audited labels land on the expected recommendations.

## Scope / safety

- Read-only audit: recomputed from existing artifacts; no live agents, no new Docker, no
  30/100 sweep.
- No canonical artifacts were replaced; `canonicalReplaced=false` everywhere.
- No change to retrieval, scoring, ranking, candidate generation, Capsule v2 pivot
  selection, or parser/index logic. The revision pass remains off by default.
- Next step (NOT done here): only after a guardrail like this is trusted should revised
  patches ever be wired into canonical evaluation — and then only when
  `replacementRecommended=true`.
