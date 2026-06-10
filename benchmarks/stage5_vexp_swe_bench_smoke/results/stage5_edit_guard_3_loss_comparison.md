# Stage 5 EDIT_GUARD 3-loss comparison

_Generated: 2026-06-10T10:47:09.378Z_

_Reporting / analysis only. No agents, no Docker, no retrieval / PIVOT_CHECK / EDIT_GUARD / telemetry changes. Every metric is computed from existing run + docker-eval artifacts; resolution is read verbatim from `_eval.meta.json`._

## Summary

EDIT_GUARD did not produce a resolution improvement on the three targeted losses: 0/3 after runs resolved (vs 0/3 before). Conversions to resolved: 0; regressions: 0; unchanged unresolved: 3.

The treatment split was valid in 3/3 cases (PIVOT_CHECK on in both conditions; EDIT_GUARD injected in after only). EDIT_GUARD raised mean cost by $0.0771 ($0.4316 → $0.5088) and mean tokens by +250612 (1056195 → 1306806).

| metric | value |
| --- | --- |
| cases | 3 |
| beforeResolvedCount | 0 |
| afterResolvedCount | 0 |
| conversionsToResolved | 0 |
| regressionsToUnresolved | 0 |
| unchangedResolved | 0 |
| unchangedUnresolved | 3 |
| meanBeforeCost | $0.4316 |
| meanAfterCost | $0.5088 |
| meanCostDelta | $0.0771 |
| meanBeforeTokens | 1056195 |
| meanAfterTokens | 1306806 |
| meanTokenDelta | +250612 |
| editGuardTreatmentValidCount | 3 |

## Experimental design

Three controlled-pilot VTRACE losses, each classified `patch_mistake_despite_good_context` (correct file and context, wrong edit). For each, two VTRACE-indexed conditions differ ONLY in the edit guard:

- **before** = PIVOT_CHECK only (`--disable-edit-guard`).
- **after** = PIVOT_CHECK + EDIT_GUARD (default).

`--disable-pivot-check` is never used: this measures the **incremental** effect of EDIT_GUARD on top of PIVOT_CHECK. Both conditions share the normal protocol (force-inject, Capsule v2, intent debug, budget 8000). All six runs were Docker-evaluated; resolution is taken from those evaluations.

## Result table

| instance | before resolved | after resolved | Δcost | Δtokens | Δpatch chars | edited-set changed | classification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sympy__sympy-16766 | no | no | $0.0801 (+16.8%) | +233675 (+18.8%) | -19 | no | different_but_same_defect |
| matplotlib__matplotlib-22719 | no | no | $0.0606 (+13.5%) | +170465 (+14.2%) | +13 | no | different_and_improved_but_unresolved |
| psf__requests-5414 | no | no | $0.0907 (+24.6%) | +347695 (+47.7%) | -240 | no | different_but_same_defect |

## Per-case analysis

### sympy__sympy-16766 (sympy)

- **Labels**: `eval-editguard-before-sympy-16766` → `eval-editguard-after-sympy-16766`.
- **Resolution**: before no, after no (changed: no).
- **Treatment**: PIVOT_CHECK yes→yes, EDIT_GUARD no→yes (split valid: yes).
- **Context inspection**: hidden pivots inspected 2→2.
- **Known defect**: wrong class scope — new printer methods landed in AbstractPythonCodePrinter instead of PythonCodePrinter.
- **After defect status**: still unresolved; defect shape not readable from the diff (scope unverifiable), so persistence is indeterminate.
- **Patch shape**: before `sympy/printing/pycode.py: +7/-0 lines`; after `sympy/printing/pycode.py: +7/-0 lines`.
- **Classification**: different_but_same_defect (confidence: medium (patch differs; defect-shape not readable from diff)).
- **Evidence**: Before (eval-editguard-before-sympy-16766) resolved=false; after (eval-editguard-after-sympy-16766) resolved=false. Both conditions edited sympy/printing/pycode.py; edited-file set unchanged. Patch chars 697 → 678 (-19). The known defect (wrong class scope — new printer methods landed in AbstractPythonCodePrinter instead of PythonCodePrinter) is class-scope-level and not readable from the unified diff, so no improvement can be evidenced. Classification: different_but_same_defect.

### matplotlib__matplotlib-22719 (matplotlib)

- **Labels**: `eval-editguard-before-matplotlib-22719` → `eval-editguard-after-matplotlib-22719`.
- **Resolution**: before no, after no (changed: no).
- **Treatment**: PIVOT_CHECK yes→yes, EDIT_GUARD no→yes (split valid: yes).
- **Context inspection**: hidden pivots inspected 2→2.
- **Known defect**: missed empty-array behavior — narrowed the deprecation-warning guard but never added the early return for empty arrays.
- **After defect status**: still unresolved, but the after patch's SHAPE now addresses the defect (FAILING BEHAVIOR (name the concrete failing input — the empty array — and verify the patch handles it)) — outcome did not flip.
- **Patch shape**: before `lib/matplotlib/category.py: +1/-1 lines`; after `lib/matplotlib/category.py: +2/-0 lines`.
- **Classification**: different_and_improved_but_unresolved (confidence: medium-high).
- **Evidence**: Before (eval-editguard-before-matplotlib-22719) resolved=false; after (eval-editguard-after-matplotlib-22719) resolved=false. Both conditions edited lib/matplotlib/category.py; edited-file set unchanged. Patch chars 677 → 690 (+13). The after patch's shape now addresses the known defect (missed empty-array behavior — narrowed the deprecation-warning guard but never added the early return for empty arrays) via EDIT_GUARD's FAILING BEHAVIOR (name the concrete failing input — the empty array — and verify the patch handles it), yet docker still reports unresolved. Classification: different_and_improved_but_unresolved.

### psf__requests-5414 (psf)

- **Labels**: `eval-editguard-before-requests-5414` → `eval-editguard-after-requests-5414`.
- **Resolution**: before no, after no (changed: no).
- **Treatment**: PIVOT_CHECK yes→yes, EDIT_GUARD no→yes (split valid: yes).
- **Context inspection**: hidden pivots inspected 1→1.
- **Known defect**: broad control-flow rewrite — always-IDNA-encode restructure instead of minimal additive empty-label validation.
- **After defect status**: still unresolved; the after patch still exhibits the same defect class (broad control-flow rewrite — always-IDNA-encode restructure instead of minimal additive empty-label validation).
- **Patch shape**: before `requests/models.py: +10/-10 lines`; after `requests/models.py: +6/-10 lines`.
- **Classification**: different_but_same_defect (confidence: medium-high).
- **Evidence**: Before (eval-editguard-before-requests-5414) resolved=false; after (eval-editguard-after-requests-5414) resolved=false. Both conditions edited requests/models.py; edited-file set unchanged. Patch chars 1564 → 1324 (-240). The after patch still exhibits the known defect (broad control-flow rewrite — always-IDNA-encode restructure instead of minimal additive empty-label validation); EDIT_GUARD's MINIMAL FIX (prefer the smallest additive guard/validation over a control-flow rewrite) did not change the edit shape. Classification: different_but_same_defect.

## Patch-shape comparison

| instance | before chars | after chars | Δ | edited-set changed | classification |
| --- | --- | --- | --- | --- | --- |
| sympy__sympy-16766 | 697 | 678 | -19 | no | different_but_same_defect |
| matplotlib__matplotlib-22719 | 677 | 690 | +13 | no | different_and_improved_but_unresolved |
| psf__requests-5414 | 1564 | 1324 | -240 | no | different_but_same_defect |

Did EDIT_GUARD change the edit behavior? In every case the after patch differs from the before patch, but in none did the change convert the task. Did it fix the specific known defect? No case flipped to resolved. Did context inspection stay stable? Hidden-pivot inspection is unchanged across before/after in every case (localization was never the bottleneck).

## Cost and token impact

| instance | before cost | after cost | Δcost | Δcost% | before tokens | after tokens | Δtokens | Δtokens% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sympy__sympy-16766 | $0.4778 | $0.5578 | $0.0801 | +16.8% | 1240375 | 1474050 | +233675 | +18.8% |
| matplotlib__matplotlib-22719 | $0.4491 | $0.5097 | $0.0606 | +13.5% | 1199768 | 1370233 | +170465 | +14.2% |
| psf__requests-5414 | $0.3681 | $0.4589 | $0.0907 | +24.6% | 728441 | 1076136 | +347695 | +47.7% |

EDIT_GUARD increased cost on all 3 runs (mean Δ $0.0771) and tokens on all 3 runs (mean Δ +250612). The extra prose adds spend without a resolution return on these three losses.

## Interpretation

EDIT_GUARD did not produce a resolution improvement on the three targeted losses. Possible explanations:

1. The guard was too weak / too easy for the model to ignore.
2. The guard changed reasoning but not enough to alter the patch into a passing one.
3. These failures require stronger patch verification, not more pre-edit prose.
4. Task stochasticity may require more repetitions before a final judgment.

Notably, on matplotlib the after patch's shape DID change toward the known fix (it added the empty-array early return that the before patch lacked), yet the task still failed docker evaluation — evidence for explanation 3: shaping the prose moved the edit closer without crossing the bar a real verification step would enforce. On requests the after patch remained a broad control-flow rewrite (the exact defect the MINIMAL FIX step targets), evidence for explanation 1/2. No statistical significance is claimed from 3 cases.

## Recommended next engineering work

**Move from passive prose guidance to a structured patch-verification checkpoint.**

Before finalizing the patch, require a PATCH_VERIFY step that checks: (1) did the edit land in the intended scope/class/function? (2) does the patch explicitly handle the failing input/behavior? (3) is the change minimal/additive unless justified? (4) did a narrow test or reproduction command run? (5) if no test ran, explain why and name the risk. Keep this benchmark-only for now.

Secondary (cost): EDIT_GUARD increased cost and tokens on all three runs. If it does not improve resolution, it should not remain always-on; gate it or drop it pending stronger evidence.

## Non-claims

- This is a 3-case targeted experiment, not a statistical benchmark; no significance is claimed from n=3.
- It does not prove EDIT_GUARD can never help — only that it converted none of these three targeted losses.
- It does not compare VTRACE to VEXP; both conditions are VTRACE-indexed and differ only by the edit guard.
- It does not change retrieval or revisit Capsule quality conclusions; localization was already correct in all three.
- It does not rerun agents or Docker; resolution is read verbatim from the existing docker _eval.meta.json artifacts.

