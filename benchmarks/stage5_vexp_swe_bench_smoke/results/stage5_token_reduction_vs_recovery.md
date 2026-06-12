# Stage 5 token reduction vs recovery cost

_Generated: 2026-06-12T06:59:29.166Z_

_Reporting only. Consolidates committed Stage 5 report JSONs to separate FIRST-PASS token/cost reduction from internal RECOVERY-side critic/repair cost. Runs no agent / live critic / repair / Docker / model; mutates no existing report, no raw artifact, and no aggregate policy row; invents no numbers._

## Summary

Status: `first_pass_and_recovery_separated`. First-pass VTRACE token reduction is reported SEPARATELY from internal recovery cost. Measured first-pass (strict-risk-gated VTRACE vs baseline): 25.24% fewer tokens and 8.16% lower cost (7/10 vs 8/10 resolved). One verified generated-parser repair conversion (astropy__astropy-14369) cost $3.0043 of recovery and is NOT merged into first-pass (recoveryMergedIntoFirstPass=false, aggregateComparable=false).

## Product-facing token reduction story

VTRACE analyzes codebases at the AST level, identifies the most relevant code via hybrid search, and delivers compressed context capsules with session memory. Up to 74% fewer tokens in benchmarked workflows.

The public-facing claim is first-pass token reduction from compact, symbol-aware context capsules — NOT user-visible repair budgeting. The control-loop recovery mechanism is internal and benchmark-only (userFacingRepairCostControls=false).

## First-pass evidence

| metric | baseline | strict-risk-gated VTRACE first-pass | reduction |
| --- | --- | --- | --- |
| resolved | 8/10 | 7/10 | — |
| tokens | 16,756,692 | 12,526,985 | 25.24% |
| cost | $6.9777 | $6.4080 | 8.16% |

Source: `stage5_policy_accounting.json` (`strictAccounting`). Strict-risk-gated first-pass uses fewer tokens and lower cost than baseline; it remains one resolved task behind baseline on this controlled 10-task set, so fewer tokens does NOT imply a higher success rate.

## Recovery-side evidence

- instance: `astropy__astropy-14369`
- sourcePatchResolved: false
- repairedPatchResolved: true
- convertedUnresolvedToResolved: true
- live critic cost: $0.1858
- repair cost: $2.8185
- total recovery cost: $3.0043

## Why these must stay separate

VTRACE's primary token-reduction claim should be based on first-pass context delivery: AST/symbol-aware retrieval, hybrid search, Capsule v2 ranking, and compressed context capsules. The generated-parser repair loop is not the headline product feature; it is an internal bounded recovery mechanism for cases where compact context was good but the agent wrote a bad patch. Recovery costs must be tracked separately so a successful repair does not obscure the first-pass token-reduction measurement.

In short: `first-pass context/token reduction != repair-side recovery cost`. A successful one-shot repair must never be folded into the first-pass token-reduction measurement or any aggregate row.

## Generated-parser repair case

The generated-parser repair loop is an internal bounded recovery mechanism — gated, off by default, one-shot, fail-open, shape-validated, and cost-capped. The verified Astropy generated-parser repair is evidence that the control loop can recover one patch-quality failure, not evidence of aggregate SWE-bench improvement or broad generated-parser generalization.

## Cost-cap safety status

- historical repair cost-cap exceeded: true
- repair cost-cap hardened (pre_call_estimated_max): true
- no-model cost-cap block proof passed: true

The repair cost cap is an INTERNAL benchmark control, not a user-facing setting (userFacingRepairCostControls=false).

## What can be claimed

- VTRACE can reduce first-pass token usage by delivering compact, symbol-aware context capsules in benchmarked workflows.
- The Stage 5 control loop has one verified generated-parser repair conversion.
- The repair loop is gated, off by default, one-shot, fail-open, shape-validated, and cost-capped.
- Recovery evidence is tracked separately from first-pass token-reduction evidence.

## What cannot be claimed

- Do not claim the generated-parser repair result improves the aggregate Stage 5 score.
- Do not merge Astropy recovery cost into first-pass token-reduction rows.
- Do not claim generated-parser repair generalizes beyond the verified Astropy case.
- Do not claim users should configure repair cost caps.
- Do not present repair as the public headline product feature.

## Recommended next milestones

1. Produce a small user-facing README/marketing wording update that keeps token reduction as the headline and mentions control-loop recovery only in deeper technical docs.
2. Define an expected-value policy for repair: run repair only when a defect class has observed conversion evidence and estimated cost fits the cap.
3. Run one additional real generated-parser-like case only if a natural candidate appears.
4. Add a product/engineering split in docs: user-facing context capsules vs internal benchmark-only repair controls.

## Non-claims

- This report does not run agents, repair, live critic, or Docker.
- This report does not change Stage 5 policy accounting or mutate any aggregate policy row.
- This report does not merge repair recovery cost into first-pass token-reduction rows.
- This report does not claim aggregate SWE-bench improvement.
- This report does not claim generated-parser repair generalizes beyond the verified Astropy case.
- First-pass numbers are READ from committed reports; when a source is unavailable the value is marked unavailable and NOT invented.

