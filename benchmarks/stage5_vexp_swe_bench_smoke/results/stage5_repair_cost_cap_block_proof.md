# Stage 5 repair cost-cap block proof

_Generated: 2026-06-12T06:47:32.894Z_

_Proof/reporting only. Reads the committed no-model dry-run repair report (`stage5_generated_parser_repair_cost_cap_blocked_dry_run.json`) and proves the hardened repair cost cap blocks the historical generated-parser repair before any model call. Runs no agent / live critic / repair / Docker / model; mutates no existing report and no raw artifact; adds no generated-parser defect to the default allowlist._

## Summary

Proof PASSED: under `pre_call_estimated_max` enforcement, the estimated worst-case repair call cost $3.0000 added to the prior cumulative $0.0000 (= $3.0000) cannot fit the $0.4000 cap, so the historical generated-parser repair is blocked BEFORE any model call (blockedBeforeModelCall=true). No model/repair call was made (modelCalled=false, repairCallsAttempted=0, repairExecuted=false).

## Historical over-cap repair

The historical repair `stage5_generated_parser_astropy_repair_attempt_shape_gate` recorded repairCostUsd=$2.8185 despite repairCostCapUsd=$0.4000 (repairCostExceededCap=true). Under the old pre_call_cumulative_only enforcement the first/only call saw prior cumulative $0.0000 < cap and always proceeded, so a single call was never bounded by the cap.

## Hardened dry-run command

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_patch_repair.ts \
  --results benchmarks/stage5_vexp_swe_bench_smoke/results \
  --dry-run \
  --run-label eval-strictv2-artifacts-protocol-vtrace-astropy-14369 \
  --include-ad-hoc-run-labels \
  --allow-generated-parser-repair \
  --max-repair-runs 1 \
  --repair-cost-cap-usd 0.40 \
  --out-name stage5_generated_parser_repair_cost_cap_blocked_dry_run
```

## Dry-run result

- sourceRunLabel: `eval-strictv2-artifacts-protocol-vtrace-astropy-14369`
- generatedParserRepairAllowed: true
- generatedParserRepairEligibleBeforeCostCap: true
- wouldRepair (dry-run defect-eligibility only, model NOT invoked): true
- repairCallsAttempted: 0
- repairExecuted: false
- modelCalled: false

The run is eligible by defect class / critic agreement, but the cost cap blocks the actual call: no model was invoked and no repair was attempted or executed.

## Cost-cap enforcement evidence

| field | value |
| --- | --- |
| repairCostCapEnforcementMode | `pre_call_estimated_max` |
| repairCostCapUsd | $0.4000 |
| repairEstimatedMaxCallCostUsd | $3.0000 |
| priorCumulativeCostUsd | $0.0000 |
| estimatedTotalIfCalledUsd | $3.0000 |
| singleCallMayExceedCap | false |
| blockedBeforeModelCall | true |
| repairStoppedByCostCap | true |
| proofPassed | true |

$0.0000 + $3.0000 = $3.0000 > $0.4000 ⇒ the call is refused pre-call.

The hardened repair cost cap now blocks the historical generated-parser repair before a model call under a $0.40 cap. With pre_call_estimated_max enforcement, the estimated maximum call cost of $3.00 cannot fit inside the remaining $0.40 cap, so the runner performs no repair call. This proves the historical over-cap path is now blocked in no-model dry-run form.

## Generated-parser repair boundary

Generated-parser repair stays OFF by default behind ALL of: `--enable-patch-repair`, `--allow-generated-parser-repair`, an explicit `--run-label`, a valid live critic, deterministic/live agreement, actionable narrow guidance, max-repair-runs, and the cost cap. This proof adds NO generated-parser defect class to `DEFAULT_ALLOWED_DEFECT_CLASSES`; broader use must wait until the estimated worst-case call cost is configured to fit the cap.

## Recommended next step

- Add a first-pass-vs-recovery-cost report that keeps strict-v2 first-pass token/cost reduction separate from critic/repair recovery cost.

_Generated-parser repair is NOT recommended for broad enablement yet._

## Non-claims

- This proof does not run a model, repair, critic, agent, or Docker.
- This proof does not evaluate any patch.
- This proof does not change the historical conversion evidence.
- This proof does not enable broader generated-parser repair usage.
- This proof does not change Stage 5 policy accounting.

