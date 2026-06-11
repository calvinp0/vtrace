# Stage 5 repair cost-cap audit

_Generated: 2026-06-11T21:51:57.062Z_

_Audit/reporting only. Reads the committed generated-parser repair conversion evidence and documents the cost-cap root cause + fix. Runs no agent / critic / repair / Docker / model; mutates no accounting or conversion row._

## Summary

The accepted generated-parser repair conversion exceeded the configured repair cap. This audit clarifies/fixes the cap semantics before broader repair use.

Root cause: The pre-fix cost cap was checked ONLY against accumulated PRIOR cost before each call (`totalRepairCostUsd >= cap`). With maxRepairRuns=1 the first/only repair call sees prior cumulative $0.0000 < cap, so it always proceeded; its ACTUAL cost was added only AFTER the call. A single call was therefore never bounded by the cap — so a $2.8185 call ran under a $0.4000 cap.

## Historical over-cap repair

| field | value |
| --- | --- |
| instanceId | astropy__astropy-14369 |
| sourceRunLabel | `eval-strictv2-artifacts-protocol-vtrace-astropy-14369` |
| convertedUnresolvedToResolved | true |
| repairCostUsd | $2.8185 |
| repairCostCapUsd | $0.4000 |
| repairCostExceededCap | true |
| totalRecoveryCostUsd | $3.0043 |

The accepted generated-parser repair recorded repairCostUsd=$2.8185 despite a configured repairCostCapUsd=$0.4000 (repairCostExceededCap=true). The conversion row is left as historical evidence and is NOT recomputed here.

## Existing enforcement behavior

Mode: `pre_call_cumulative_only` (singleCallMayExceedCap=true).

Pre-call CUMULATIVE-ONLY: the cap is checked against accumulated PRIOR cost only. The first call (prior $0.0000) is never bounded, so a single call can exceed the cap. This is honest only as a cumulative bound across MULTIPLE calls; it cannot bound one call.

## Fix or clarified semantics

Mode (new default): `pre_call_estimated_max` (singleCallMayExceedCap=false).

Pre-call ESTIMATED-MAX (now the default): a repair call is permitted ONLY when prior cumulative PLUS an estimated worst-case call cost still fits the cap; otherwise the call is skipped with repairStoppedByCostCap=true. An allowed call cannot push cumulative past the cap to the accuracy of the estimate. The `claude -p` caller passes no max-output-tokens budget, so the bound is the estimate, not a hard model-API limit; when no estimate is configured the runner falls back to the honest cumulative-only mode and flags singleCallMayExceedCap=true.

Defaults: repairCostCapUsd=$0.2500, repairEstimatedMaxCallCostUsd=$3.0000.

The repair report now records these fields:
- `repairCostCapUsd`
- `repairCostCapEnforcementMode`
- `repairPreCallCumulativeCostUsd`
- `repairEstimatedMaxCallCostUsd`
- `repairActualCostUsd`
- `repairExceededCap`
- `repairStoppedByCostCap`
- `singleCallMayExceedCap`

## Generated-parser repair implications

- Generated-parser LIVE repair remains gated, unchanged, by ALL of: --enable-patch-repair, --allow-generated-parser-repair, an explicit --run-label, a valid live critic, deterministic/live agreement, actionable narrow-rewrite guidance, max-repair-runs, and the cost cap.
- Generated-parser defect classes are STILL NOT in DEFAULT_ALLOWED_DEFECT_CLASSES; the cap fix loosens no gate.
- Under the fixed default (cap $0.25, estimated worst-case call $3.00) a generated-parser repair call is REFUSED pre-call unless the operator raises the cap above the estimate (or supplies a tighter, justified estimate), so the historical over-cap call could not recur silently.

## Recommended next step

Keep generated-parser repair OFF by default. Before any broader generated-parser repair usage, set --repair-cost-cap-usd and --repair-estimated-max-call-cost-usd to values that make the estimated worst-case call fit the cap, confirm the repair report shows repairCostCapEnforcementMode=pre_call_estimated_max with singleCallMayExceedCap=false, and only then widen usage. Do NOT recompute the historical conversion row; leave its over-cap caveat as historical evidence.

## Non-claims

- This audit does not run repair, live critic, agents, or Docker.
- This audit does not change the generated-parser conversion result.
- This audit does not add new policy accounting rows.
- This audit does not enable broader generated-parser repair usage by itself.

