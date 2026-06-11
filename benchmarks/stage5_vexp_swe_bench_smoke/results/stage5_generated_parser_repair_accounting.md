# Stage 5 generated-parser repair accounting (single-instance, labelled)

_Generated: 2026-06-11T21:35:44.954Z_

_Accounting/reporting only. Reads the committed Docker-verified generated-parser repair conversion report (`stage5_generated_parser_repair_conversion_shape_gate.json`) and records ONE explicit, separately-labelled row. Mutates no existing aggregate row and no raw artifact; runs no agent / critic / repair / Docker / model._

## Summary

Recorded single-instance verified generated-parser repair conversion for astropy__astropy-14369 as row `single_instance_verified_generated_parser_repair_astropy` (aggregateComparable=false).

## Accounting row: `single_instance_verified_generated_parser_repair_astropy`

- This is single-instance generated-parser repair evidence.
- It is not a full 10-task aggregate.
- It is not directly comparable to strict_vtrace_first_patch unless the lineage is explicitly normalized.

| field | value |
| --- | --- |
| sourceRunLabel | `eval-strictv2-artifacts-protocol-vtrace-astropy-14369` |
| repairOutName | stage5_generated_parser_astropy_repair_attempt_shape_gate |
| instanceId | astropy__astropy-14369 |
| sourcePatchResolved | false |
| repairedPatchResolved | true |
| convertedUnresolvedToResolved | true |
| criticCostUsd | $0.1858 |
| repairCostUsd | $2.8185 |
| totalRecoveryCostUsd | $3.0043 |
| repairCostCapUsd | $0.4000 |
| repairCostExceededCap | true |
| generatedParserRepairShapeAccepted | true |
| generatedParserTablesUpdatedByRepair | astropy/units/format/cds_parsetab.py |
| generatedParserTablesDeletedByRepair | false |
| policyAccountingUpdated | true |
| aggregateComparable | false |

## Interpretation

The shape-gated generated-parser repair converted astropy__astropy-14369 from unresolved to resolved under Docker. This is verified single-instance repair-conversion evidence. It should not be counted as a new aggregate Stage 5 score until a comparable row lineage is defined. The repair also exceeded the configured repair cost cap, so broader generated-parser repair usage should wait for a separate cost-cap enforcement audit.

## Aggregate-comparability boundary

This row is **single-instance** verified generated-parser repair-conversion evidence. It is NOT a full 10-task aggregate and is recorded with `aggregateComparable=false`. It must not be counted as a new aggregate Stage 5 score, and is not directly comparable to `strict_vtrace_first_patch` (or any aggregate policy row) until a comparable row lineage is explicitly normalized. No existing aggregate row was mutated.

## Cost-cap follow-up

- Audit repair cost-cap enforcement before enabling broader generated-parser repair usage. The accepted repair call recorded repairCostUsd=$2.8185 despite repairCostCapUsd=$0.4000.

This is a recommended follow-up audit item only. This report records the cost-cap exceedance but does NOT change cost-cap enforcement; broader generated-parser repair usage should wait for that separate audit.

## Non-claims

- Single-instance evidence only; this is NOT a full 10-task aggregate and does NOT prove aggregate improvement.
- aggregateComparable=false: this row is NOT directly comparable to strict_vtrace_first_patch (or any aggregate policy row) until a comparable row lineage is explicitly normalized.
- No existing aggregate Stage 5 policy row was mutated, merged into, or recomputed by this report; this is a SEPARATE labelled row.
- The conversion result is READ from the committed Docker-verified conversion report; this runs no agent, no live critic, no repair, no Docker, and no model.
- The repair exceeded the configured repair cost cap; this report records that fact for a SEPARATE cost-cap enforcement audit and does NOT change cost-cap enforcement.
- This changes no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / probe / critic / repair / evaluator / telemetry / policy-accounting behavior.

