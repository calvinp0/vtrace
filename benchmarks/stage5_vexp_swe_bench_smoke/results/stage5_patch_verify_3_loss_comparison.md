# Stage 5 PATCH_VERIFY 3-loss comparison

_Generated: 2026-06-10T12:55:34.989Z_

_Reporting / analysis only. No agents, no Docker, no retrieval / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / telemetry changes. Every metric is computed from existing run + docker-eval artifacts; resolution is read verbatim from `_eval.meta.json`._

## Summary

PATCH_VERIFY did not produce a resolution improvement on the three targeted losses: 0/3 after runs resolved (vs 0/3 before). Conversions to resolved: 0; regressions: 0; unchanged unresolved: 3.

The treatment split was valid in 3/3 cases (PIVOT_CHECK on in both conditions; EDIT_GUARD off in both; PATCH_VERIFY injected in the after arm only). PATCH_VERIFY raised mean cost by $0.0736 ($0.3738 → $0.4473) and mean tokens by +188833 (868360 → 1057193).

| metric | value |
| --- | --- |
| cases | 3 |
| beforeResolvedCount | 0 |
| afterResolvedCount | 0 |
| conversionsToResolved | 0 |
| regressionsToUnresolved | 0 |
| unchangedResolved | 0 |
| unchangedUnresolved | 3 |
| meanBeforeCost | $0.3738 |
| meanAfterCost | $0.4473 |
| meanCostDelta | $0.0736 |
| meanBeforeTokens | 868360 |
| meanAfterTokens | 1057193 |
| meanTokenDelta | +188833 |
| patchVerifyTreatmentValidCount | 3 |

## Experimental design

Three controlled-pilot VTRACE losses, each classified `patch_mistake_despite_good_context` (correct file and context, wrong edit). For each, two VTRACE-indexed conditions differ ONLY in the patch-verification checkpoint:

- **before** = PIVOT_CHECK only (`--disable-edit-guard --disable-patch-verify`).
- **after** = PIVOT_CHECK + PATCH_VERIFY (`--disable-edit-guard`).

EDIT_GUARD is held DISABLED in BOTH arms, so this isolates the **incremental** effect of PATCH_VERIFY on top of PIVOT_CHECK alone (not stacked on EDIT_GUARD). `--disable-pivot-check` is never used. Both conditions share the normal protocol (force-inject, Capsule v2, intent debug, budget 8000). All six runs were Docker-evaluated; resolution is taken from those evaluations.

## Result table

| instance | before resolved | after resolved | Δcost | Δtokens | Δpatch chars | edited-set changed | classification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sympy__sympy-16766 | no | no | $0.0374 (+10.1%) | +169112 (+23.0%) | +106 | no | different_but_same_defect |
| matplotlib__matplotlib-22719 | no | no | $0.1288 (+29.6%) | +167678 (+13.3%) | -7 | no | different_but_same_defect |
| psf__requests-5414 | no | no | $0.0545 (+17.4%) | +229709 (+37.8%) | -404 | no | different_and_improved_but_unresolved |

## Per-case analysis

### sympy__sympy-16766 (sympy)

- **Labels**: `eval-patchverify-before-sympy-16766` → `eval-patchverify-after-sympy-16766`.
- **Resolution**: before no, after no (changed: no).
- **Treatment**: PIVOT_CHECK yes→yes, EDIT_GUARD no→no, PATCH_VERIFY no→yes (split valid: yes).
- **Context inspection**: hidden pivots inspected 2→2.
- **Known defect**: wrong class scope — new printer methods landed in AbstractPythonCodePrinter instead of PythonCodePrinter.
- **After defect status**: still unresolved; defect shape not readable from the diff (scope unverifiable), so persistence is indeterminate.
- **Patch shape**: before `sympy/printing/pycode.py: +4/-0 lines`; after `sympy/printing/pycode.py: +4/-0 lines`.
- **Verification behavior**: not_observable (Bash/check calls 2→2, changed: no; checklist followed: no).
- **Classification**: different_but_same_defect (confidence: medium (patch differs; defect-shape not readable from diff; verification narrative not captured in artifacts)).
- **Evidence**: Before (eval-patchverify-before-sympy-16766) resolved=false; after (eval-patchverify-after-sympy-16766) resolved=false. Both conditions edited sympy/printing/pycode.py; edited-file set unchanged. Patch chars 508 → 614 (+106). The known defect (wrong class scope — new printer methods landed in AbstractPythonCodePrinter instead of PythonCodePrinter) is class-scope-level and not readable from the unified diff, so no improvement can be evidenced. Verification behavior: not_observable (Bash/check tool calls 2→2; final-response narrative not captured). Classification: different_but_same_defect.

### matplotlib__matplotlib-22719 (matplotlib)

- **Labels**: `eval-patchverify-before-matplotlib-22719` → `eval-patchverify-after-matplotlib-22719`.
- **Resolution**: before no, after no (changed: no).
- **Treatment**: PIVOT_CHECK yes→yes, EDIT_GUARD no→no, PATCH_VERIFY no→yes (split valid: yes).
- **Context inspection**: hidden pivots inspected 2→2.
- **Known defect**: missed empty-array behavior — narrowed the deprecation-warning guard but never added the early return for empty arrays.
- **After defect status**: still unresolved; the after patch still exhibits the same defect class (missed empty-array behavior — narrowed the deprecation-warning guard but never added the early return for empty arrays).
- **Patch shape**: before `lib/matplotlib/category.py: +3/-0 lines`; after `lib/matplotlib/category.py: +1/-1 lines`.
- **Verification behavior**: not_observable (Bash/check calls 5→6, changed: yes; checklist followed: no).
- **Classification**: different_but_same_defect (confidence: medium (verification narrative not captured in artifacts)).
- **Evidence**: Before (eval-patchverify-before-matplotlib-22719) resolved=false; after (eval-patchverify-after-matplotlib-22719) resolved=false. Both conditions edited lib/matplotlib/category.py; edited-file set unchanged. Patch chars 698 → 691 (-7). The after patch still exhibits the known defect (missed empty-array behavior — narrowed the deprecation-warning guard but never added the early return for empty arrays); PATCH_VERIFY's FAILING BEHAVIOR HANDLED (the patch must explicitly handle the empty-array input) did not change the edit shape. Verification behavior: not_observable (Bash/check tool calls 5→6; final-response narrative not captured). Classification: different_but_same_defect.

### psf__requests-5414 (psf)

- **Labels**: `eval-patchverify-before-requests-5414` → `eval-patchverify-after-requests-5414`.
- **Resolution**: before no, after no (changed: no).
- **Treatment**: PIVOT_CHECK yes→yes, EDIT_GUARD no→no, PATCH_VERIFY no→yes (split valid: yes).
- **Context inspection**: hidden pivots inspected 1→1.
- **Known defect**: broad control-flow rewrite — always-IDNA-encode restructure instead of minimal additive empty-label validation.
- **After defect status**: still unresolved, but the after patch's SHAPE now addresses the defect (MINIMALITY (prefer the smallest additive guard/validation over a control-flow rewrite)) — outcome did not flip.
- **Patch shape**: before `requests/models.py: +6/-6 lines`; after `requests/models.py: +5/-0 lines`.
- **Verification behavior**: not_observable (Bash/check calls 2→2, changed: no; checklist followed: no).
- **Classification**: different_and_improved_but_unresolved (confidence: medium-high (verification narrative not captured in artifacts)).
- **Evidence**: Before (eval-patchverify-before-requests-5414) resolved=false; after (eval-patchverify-after-requests-5414) resolved=false. Both conditions edited requests/models.py; edited-file set unchanged. Patch chars 1047 → 643 (-404). The after patch's shape now addresses the known defect (broad control-flow rewrite — always-IDNA-encode restructure instead of minimal additive empty-label validation) via PATCH_VERIFY's MINIMALITY (prefer the smallest additive guard/validation over a control-flow rewrite), yet docker still reports unresolved. Verification behavior: not_observable (Bash/check tool calls 2→2; final-response narrative not captured). Classification: different_and_improved_but_unresolved.

## Patch-shape comparison

| instance | before chars | after chars | Δ | edited-set changed | classification |
| --- | --- | --- | --- | --- | --- |
| sympy__sympy-16766 | 508 | 614 | +106 | no | different_but_same_defect |
| matplotlib__matplotlib-22719 | 698 | 691 | -7 | no | different_but_same_defect |
| psf__requests-5414 | 1047 | 643 | -404 | no | different_and_improved_but_unresolved |

Did PATCH_VERIFY change the edit behavior? In every case the after patch differs from the before patch, but in none did the change convert the task. Did it fix the specific known defect? No case flipped to resolved. Did context inspection stay stable? Hidden-pivot inspection is unchanged across before/after in every case (localization was never the bottleneck).

## Verification-behavior analysis

Did the final answer appear to follow the PATCH_VERIFY checkpoint? The run artifacts capture the harness progress stream and the final model patch, but NOT the agent's reasoning or final natural-language response, so the checklist narrative (SCOPE LANDED / FAILING BEHAVIOR HANDLED / MINIMALITY / CHECK RUN / RISK) is not directly observable. The only artifact-level proxy is the count of Bash-class ("other") tool calls — a weak stand-in for CHECK RUN.

| instance | verification behavior | Bash/check calls before→after | changed | checklist tokens in final |
| --- | --- | --- | --- | --- |
| sympy__sympy-16766 | not_observable | 2→2 | no | none captured |
| matplotlib__matplotlib-22719 | not_observable | 5→6 | yes | none captured |
| psf__requests-5414 | not_observable | 2→2 | no | none captured |

Across all three cases the verification narrative is `not_observable`: no final-response text was captured, so we cannot claim the agent substantively followed (or skipped) the checklist. The Bash/check-call proxy is flat or barely moved (e.g. +1 on matplotlib), giving no positive evidence of a new executable verification step. We report this as a measurement gap, not as proof the checkpoint was ignored.

## Cost and token impact

| instance | before cost | after cost | Δcost | Δcost% | before tokens | after tokens | Δtokens | Δtokens% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sympy__sympy-16766 | $0.3719 | $0.4093 | $0.0374 | +10.1% | 734903 | 904015 | +169112 | +23.0% |
| matplotlib__matplotlib-22719 | $0.4356 | $0.5644 | $0.1288 | +29.6% | 1262069 | 1429747 | +167678 | +13.3% |
| psf__requests-5414 | $0.3138 | $0.3683 | $0.0545 | +17.4% | 608108 | 837817 | +229709 | +37.8% |

PATCH_VERIFY increased cost on all 3 runs (mean Δ $0.0736) and tokens on all 3 runs (mean Δ +188833). The extra checkpoint prose adds spend without a resolution return on these three losses.

## Interpretation

PATCH_VERIFY did not produce a resolution improvement on the three targeted losses. Possible explanations:

1. The checkpoint was still passive prose and may be ignored or satisfied superficially.
2. The agent may need executable / narrow reproduction checks, not just self-verification.
3. Patch-quality failures may require a second-pass critic or patch-repair loop.
4. Task stochasticity may require repetitions before a final judgment.

The patch shape changed in all three cases but never crossed the docker bar, and the verification narrative is not captured in the artifacts, so we cannot distinguish "followed superficially" (explanation 1) from "followed but insufficient" (explanations 2/3). What is clear is that prose-only self-verification, isolated from EDIT_GUARD, converted none of these losses while costing more. No statistical significance is claimed from 3 cases.

## Recommended next engineering work

**Stop adding passive prompt blocks; add an explicit patch-critic / repair loop (benchmark-only).**

After the first patch is produced: (1) run deterministic patch probes / narrow tests where available; (2) have a critic inspect the diff against the issue text and the known failing behavior; (3) if the critic finds wrong scope, missing failing behavior, a broad rewrite, or no test evidence, allow exactly one repair attempt; (4) record first-patch vs repaired-patch telemetry separately. The loop is conceptual here, not implemented in this report, and should stay benchmark-only until it shows a resolution benefit.

Conceptual loop (not implemented in this report):

1. After the first patch is produced, run deterministic patch probes / narrow tests where available.
2. Have a critic inspect the diff against the issue text and the known failing behavior.
3. If the critic finds wrong scope, missing failing behavior, a broad rewrite, or no test evidence, allow exactly one repair attempt.
4. Record first-patch vs repaired-patch telemetry separately.

Caveat: PATCH_VERIFY should not become always-on unless future evidence shows a resolution benefit: in this targeted experiment it added cost and tokens without producing any conversions.

## Non-claims

- This is a 3-case targeted experiment, not a statistical benchmark; no significance is claimed from n=3.
- It does not prove PATCH_VERIFY can never help — only that it converted none of these three targeted losses.
- It does not compare VTRACE to VEXP; both conditions are VTRACE-indexed and differ only by the patch-verify checkpoint.
- It does not change retrieval or revisit Capsule quality conclusions; localization was already correct in all three.
- It does not rerun agents or Docker; resolution is read verbatim from the existing docker _eval.meta.json artifacts.
- It does not prove prompt-only verification is useless in general; it only reports this treatment on these three cases.

