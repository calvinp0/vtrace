# Stage 5 patch repair run

_Generated: 2026-06-12T06:44:13.726Z_

_Benchmark-only gated one-repair-attempt mode. Disabled unless `--enable-patch-repair`; repair requires an explicit `--run-label`. Exactly one bounded attempt per eligible run, no loop, no Docker. The original first patch, raw agent output, and workspace are never modified; repair artifacts live in an isolated `repair/` subdir._

## Summary

enabled=false; 7 candidate run(s), 1 eligible. Repair calls attempted 0, succeeded 0, failed-open 0. Repaired patches produced 0 (changed 0). Total repair cost $0.0000.

| metric | value |
| --- | --- |
| candidateRuns | 7 |
| eligibleRuns | 1 |
| repairCallsAttempted | 0 |
| repairCallsSucceeded | 0 |
| repairCallsFailedOpen | 0 |
| repairedPatchProduced | 0 |
| changedPatchCount | 0 |
| totalRepairCostUsd | $0.0000 |

## Eligibility gates

enabled=false; dryRun=true; runLabels={eval-strictv2-artifacts-protocol-vtrace-astropy-14369}; maxRepairRuns=1; repairCostCapUsd=$0.4000; allowedDefectClasses={wrong_scope, broad_rewrite_minimality}; evaluateRepairedPatch=false.

A run is repair-eligible only when ALL hold: valid live-critic report; failedOpen=false; liveRepairRequired=true; 
report repair_required=true with non-empty repair_reason and repair_instructions; first patch present; defect class 
in the allowed set; instruction quality concrete or actionable; AND the run is explicitly named by --run-label.

| gate counter | value |
| --- | --- |
| candidateRuns | 7 |
| eligibleRuns | 1 |
| skippedByRunLabel | 6 |
| skippedIneligible | 0 |
| skippedByMaxRuns | 0 |
| stoppedByCostCap | 0 |
| repairCallsAttempted | 0 |
| repairCallsSucceeded | 0 |
| repairCallsFailedOpen | 0 |
| repairedPatchProduced | 0 |
| changedPatchCount | 0 |
| totalRepairCostUsd | $0.0000 |
| adHocRequested | 1 |
| adHocCandidates | 1 |

## Cost-cap enforcement

| field | value |
| --- | --- |
| repairCostCapUsd | $0.4000 |
| repairCostCapEnforcementMode | pre_call_estimated_max |
| repairEstimatedMaxCallCostUsd | $3.0000 |
| repairPreCallCumulativeCostUsd | $0.0000 |
| repairActualCostUsd | $0.0000 |
| repairExceededCap | false |
| repairStoppedByCostCap | 0 |
| singleCallMayExceedCap | false |

Enforcement mode is `pre_call_estimated_max`: a repair call is permitted ONLY when the estimated worst-case call cost plus prior cumulative spend fits within the cap, so an allowed call cannot push cumulative past the cap to the accuracy of the estimate. The `claude -p` caller passes no max-output-tokens budget, so the bound is the estimate, not a hard model-API limit.

## Runs repaired

| run | source | instance | defect class | instruction | decision | valid | changed | failed-open | cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eval-strictv2-artifacts-protocol-vtrace-astropy-14369 | ad_hoc_run_label | astropy__astropy-14369 | unknown | actionable | would-repair (dry-run) | — | — | — | — |

## Runs skipped

| run | source | instance | defect class | skip reason | detail |
| --- | --- | --- | --- | --- | --- |
| eval-patchverify-before-sympy-16766 | curated_existing | sympy__sympy-16766 | wrong_scope | not-in-run-label | not in --run-label set {eval-strictv2-artifacts-protocol-vtrace-astropy-14369} |
| eval-editguard-before-matplotlib-22719 | curated_existing | matplotlib__matplotlib-22719 | missing_failing_behavior | not-in-run-label | not in --run-label set {eval-strictv2-artifacts-protocol-vtrace-astropy-14369} |
| eval-patchverify-after-matplotlib-22719 | curated_existing | matplotlib__matplotlib-22719 | missing_failing_behavior | not-in-run-label | not in --run-label set {eval-strictv2-artifacts-protocol-vtrace-astropy-14369} |
| eval-editguard-before-requests-5414 | curated_existing | psf__requests-5414 | broad_rewrite_minimality | not-in-run-label | not in --run-label set {eval-strictv2-artifacts-protocol-vtrace-astropy-14369} |
| eval-editguard-after-requests-5414 | curated_existing | psf__requests-5414 | broad_rewrite_minimality | not-in-run-label | not in --run-label set {eval-strictv2-artifacts-protocol-vtrace-astropy-14369} |
| eval-patchverify-before-requests-5414 | curated_existing | psf__requests-5414 | broad_rewrite_minimality | not-in-run-label | not in --run-label set {eval-strictv2-artifacts-protocol-vtrace-astropy-14369} |

## Repair artifact summary

For each repaired run, artifacts are written to `results/runs/<runLabel>/raw/vtrace/repair/`: `_patch_repair_input.json`, `_patch_repair.raw.txt`, `_patch_repair_result.json`, `_patch_repair.meta.json`, `_first_patch.diff` (a copy — the original is untouched), and `_repaired_patch.diff` (only when a valid repaired patch was produced).

## Cost and token impact

| run | cost | input tok | output tok |
| --- | --- | --- | --- |
| eval-patchverify-before-sympy-16766 | — | — | — |
| eval-editguard-before-matplotlib-22719 | — | — | — |
| eval-patchverify-after-matplotlib-22719 | — | — | — |
| eval-editguard-before-requests-5414 | — | — | — |
| eval-editguard-after-requests-5414 | — | — | — |
| eval-patchverify-before-requests-5414 | — | — | — |
| eval-strictv2-artifacts-protocol-vtrace-astropy-14369 | — | — | — |

Total repair cost: $0.0000.

## Safety properties

| property | value |
| --- | --- |
| disabled by default | respected |
| run-label required | true |
| one attempt only (no loop) | true |
| missing_failing_behavior excluded by default | true |
| Docker / evaluation run | false |
| original first patch modified | false |
| original workspace modified | false |
| repair failed-open count | 0 |

## Generated-parser repair (dry-run eligibility)

SEPARATE eligibility path behind `--allow-generated-parser-repair`. Off by default; adds NO defect class to the default allowlist. Dry-run reports eligibility only (no model); live execution additionally requires `--enable-patch-repair` with dryRun=false and runs EXACTLY ONE bounded attempt (fail-open, no loop).

This is dry-run eligibility only. No repaired patch was generated, no patch was modified, and no Docker evaluation was run.

allowGeneratedParserRepair=true; mode=dry-run; eligible run(s): 1; would-repair run(s): 1; attempted: 0; succeeded: 0; failed-open: 0; repairExecuted=false.

| run | instance | allowed | eligible | repairClass | det. minimality | live repair_required | agreement | narrow guidance | repairExecuted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eval-strictv2-artifacts-protocol-vtrace-astropy-14369 | astropy__astropy-14369 | true | true | generated_parser_broad_rewrite / grammar_patch_minimality | true | true | true | yes | false |

### eval-strictv2-artifacts-protocol-vtrace-astropy-14369 — generated-parser eligibility

- eligible: true
- wouldRepair: true
- repairClass: generated_parser_broad_rewrite / grammar_patch_minimality
- source: valid_live_critic_and_patch_minimality_agreement
- mode: dry-run
- generatedParserRepairSource: generated_parser_minimality
- repairExecuted: false
- repairAttempted: false
- repairSucceeded: false
- repairFailedOpen: false
- repairCostUsd: —
- patchMinimalityRepairRequired: true
- patchMinimalityDefectClass: generated_parser_broad_rewrite / grammar_patch_minimality
- liveCriticRepairRequired: true
- liveCriticValid: true
- agreementWithDeterministic: true
- generatedParserConsistencyRisk: true
- generatedParserConsistencyDefectClass: source_grammar_changed_without_generated_table_update
- generatedParserConsistencyExpectedTables: astropy/units/format/cds_parsetab.py
- generatedParserConsistencyGuidanceIncluded: true
- consistency guidance (update the generated parser table when the source grammar changes):
  - if the source grammar changes, update/regenerate the corresponding generated parser table consistently
  - do not delete generated parser tables / lextab / parsetab files
  - keep in sync: astropy/units/format/cds_parsetab.py
  - consistency probe: Patch deletes generated parser table file(s): astropy/units/format/cds_lextab.py, astropy/units/format/cds_parsetab.py. The table must be regenerated to match the grammar, not deleted.
- gates satisfied:
  - generated-parser repair explicitly enabled (--allow-generated-parser-repair)
  - explicit --run-label provided for this run
  - dry-run eligibility mode (no model called)
  - live critic artifacts present (_patch_critic.meta.json + _patch_critic_report.json)
  - live critic report valid (validReport=true, failedOpen=false)
  - live critic repair_required=true
  - deterministic patchMinimalityRepairRequired=true
  - deterministic/live agreement=true
  - patchMinimality defect class is generated-parser (generated_parser_broad_rewrite / grammar_patch_minimality)
  - live critic includes actionable narrow-rewrite guidance
  - first patch present (_first_patch.diff)
- intended narrow-rewrite guidance (dry-run only; NOT applied):
  - Change the division_of_units production order narrowly.
  - Do not relocate productions into p_combined_units.
  - Do not delete generated parser tables.
  - Avoid broad grammar rewrites.

## Non-claims

- Benchmark-only and DISABLED by default; without --enable-patch-repair no model is called and no repair artifacts are written.
- Repair requires an explicit --run-label; with none provided nothing is repaired.
- EXACTLY ONE bounded repair attempt per eligible run — never a loop and never a retry.
- Only wrong_scope and broad_rewrite_minimality are repaired by default; missing_failing_behavior is excluded (undecided class).
- Fail-open: any invocation error or invalid diff preserves the original first patch (repairedPatch=null, failedOpen=true).
- The original first patch, raw agent output, and workspace are never modified; repair artifacts live in an isolated repair/ subdir.
- No Docker / evaluation is run this milestone; a repaired patch artifact is produced and would be evaluated later. No resolution is claimed.
- This changes no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / probe / deterministic-critic / live-critic behavior.
- Generated-parser repair is a SEPARATE eligibility path behind --allow-generated-parser-repair; it is off by default and adds NO defect class to the default allowlist. Dry-run reports eligibility only; live execution additionally requires --enable-patch-repair with dryRun=false and runs exactly one bounded attempt.
- A generated-parser live attempt generates a repaired patch only. It did not run Docker and does not claim a repair conversion.

