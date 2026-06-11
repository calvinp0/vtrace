# Stage 5 live patch critic over existing runs

_Generated: 2026-06-11T18:52:29.354Z_

_Critic observation only. No repair, no patch modification, no Docker. Live critic disabled unless `--enable-patch-critic` is passed; the model is reached only through the injectable caller, and only on gated (cost/scope-bounded) runs._

## Gates

enabled=true; dryRun=true; runLabels={eval-strictv2-artifacts-protocol-vtrace-astropy-14369}; maxCriticRuns=1; onlyDeterministicRepairRequired=true; criticCostCapUsd=$0.2500.

| gate metric | value |
| --- | --- |
| candidateRuns | 13 |
| eligibleRuns | 1 |
| skippedLowRiskRuns | 0 |
| skippedByRunLabel | 12 |
| skippedByMaxRuns | 0 |
| stoppedByCostCap | 0 |
| liveCallsAttempted | 0 |
| liveCallsSucceeded | 0 |
| liveCallsFailedOpen | 0 |
| totalCriticCostUsd | $0.0000 |
| adHocRequested | 1 |
| adHocFound | 1 |
| adHocMaterialized | 1 |
| adHocMissing | 0 |

## Summary

enabled=true; 13 candidate run(s), 1 eligible; critic ran on 0, 0 valid report(s), 0 failed-open. Live repair_required: 0; deterministic repair_required (over ran): 0; agreement 0/0. Critic cost $0.0000 (0 in / 0 out tokens).

| metric | value |
| --- | --- |
| enabled | true |
| runsAnalyzed | 0 |
| criticRan | 0 |
| validReports | 0 |
| failedOpen | 0 |
| liveRepairRequired | 0 |
| deterministicRepairRequired | 0 |
| agreementCount | 0 |
| disagreementCount | 0 |
| totalCriticCostUsd | 0 |
| totalCriticInputTokens | 0 |
| totalCriticOutputTokens | 0 |

## Decisions by run

| run | source | det repair | decision | ran | valid | live repair | agreement | cost | reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eval-editguard-before-sympy-16766 | curated_existing | false | skipped: not-in-run-label | — | — | — | — | — | not in --run-label set {eval-strictv2-artifacts-protocol-vtrace-astropy-14369} |
| eval-editguard-after-sympy-16766 | curated_existing | false | skipped: not-in-run-label | — | — | — | — | — | not in --run-label set {eval-strictv2-artifacts-protocol-vtrace-astropy-14369} |
| eval-patchverify-before-sympy-16766 | curated_existing | true | skipped: not-in-run-label | — | — | — | — | — | not in --run-label set {eval-strictv2-artifacts-protocol-vtrace-astropy-14369} |
| eval-patchverify-after-sympy-16766 | curated_existing | false | skipped: not-in-run-label | — | — | — | — | — | not in --run-label set {eval-strictv2-artifacts-protocol-vtrace-astropy-14369} |
| eval-editguard-before-matplotlib-22719 | curated_existing | true | skipped: not-in-run-label | — | — | — | — | — | not in --run-label set {eval-strictv2-artifacts-protocol-vtrace-astropy-14369} |
| eval-editguard-after-matplotlib-22719 | curated_existing | false | skipped: not-in-run-label | — | — | — | — | — | not in --run-label set {eval-strictv2-artifacts-protocol-vtrace-astropy-14369} |
| eval-patchverify-before-matplotlib-22719 | curated_existing | false | skipped: not-in-run-label | — | — | — | — | — | not in --run-label set {eval-strictv2-artifacts-protocol-vtrace-astropy-14369} |
| eval-patchverify-after-matplotlib-22719 | curated_existing | true | skipped: not-in-run-label | — | — | — | — | — | not in --run-label set {eval-strictv2-artifacts-protocol-vtrace-astropy-14369} |
| eval-editguard-before-requests-5414 | curated_existing | true | skipped: not-in-run-label | — | — | — | — | — | not in --run-label set {eval-strictv2-artifacts-protocol-vtrace-astropy-14369} |
| eval-editguard-after-requests-5414 | curated_existing | true | skipped: not-in-run-label | — | — | — | — | — | not in --run-label set {eval-strictv2-artifacts-protocol-vtrace-astropy-14369} |
| eval-patchverify-before-requests-5414 | curated_existing | true | skipped: not-in-run-label | — | — | — | — | — | not in --run-label set {eval-strictv2-artifacts-protocol-vtrace-astropy-14369} |
| eval-patchverify-after-requests-5414 | curated_existing | true | skipped: not-in-run-label | — | — | — | — | — | not in --run-label set {eval-strictv2-artifacts-protocol-vtrace-astropy-14369} |
| eval-strictv2-artifacts-protocol-vtrace-astropy-14369 | ad_hoc_run_label | true | would-call (dry-run) | — | — | — | — | — | would call live critic (dry-run: model NOT invoked) [eligible: generated-parser-minimality] |

## Patch minimality (generated-parser) signal

Runs the deterministic generated-parser probe flagged. This is an OBSERVATION-ONLY risk signal that makes a run eligible for live critic observation; it never triggers automatic repair.

| run | patchMinimalityRepairRequired | patchMinimalityDefectClass | patchMinimalityRisk | patchMinimalityConfidence |
| --- | --- | --- | --- | --- |
| eval-strictv2-artifacts-protocol-vtrace-astropy-14369 | true | generated_parser_broad_rewrite / grammar_patch_minimality | high | high |

### eval-strictv2-artifacts-protocol-vtrace-astropy-14369 — generated-parser minimality

- patchMinimalityRepairRequired: true
- patchMinimalityDefectClass: generated_parser_broad_rewrite / grammar_patch_minimality
- patchMinimalityRisk: high
- patchMinimalityConfidence: high
- patchMinimalitySignals: generated_parser_table_deleted, grammar_function_removed, multiple_grammar_functions_changed, grammar_productions_relocated, narrow_alternative_available, grammar_patch_minimality
- patchMinimalityReason: Patch deletes generated parser table file(s): astropy/units/format/cds_lextab.py, astropy/units/format/cds_parsetab.py.
- patchMinimalityReason: Parser function(s) removed entirely: p_division_of_units, p_product_of_units.
- patchMinimalityReason: Multiple parser functions changed in one patch: p_combined_units, p_division_of_units, p_product_of_units.
- patchMinimalityReason: Grammar productions appear relocated between parser functions (a function was removed while another was rewritten).
- patchMinimalityReason: Narrower alternative likely exists: reorder the division_of_units grammar production within its own parser function rather than relocating productions across parser functions or deleting generated parser tables.
- patchMinimalityNarrowAlternativeHint: Narrower alternative likely exists: reorder the division_of_units grammar production within its own parser function rather than relocating productions across parser functions or deleting generated parser tables.

## Non-claims

- Critic OBSERVATION ONLY: the live critic never modifies the patch, edited files, workspace, final patch, or evaluation input.
- Disabled by default; with no --enable-patch-critic flag no model is called and no critic artifacts are written.
- Cost/scope GATED: by default the live critic runs on at most --max-critic-runs run(s), only on deterministic repair_required runs, and stops at --critic-cost-cap-usd.
- `repair_required = true` here is an OBSERVATION (what a critic would request); no repair is performed this milestone.
- Fail-open: a critic invocation error or invalid JSON is recorded and the original patch is preserved; the run is not failed.
- Agreement = (deterministicRepairRequired === liveRepairRequired); per-field agreement is not required for this milestone.
- The generated-parser patch-minimality probe is an OBSERVATION-ONLY deterministic signal: it makes a run eligible for live critic observation but never triggers automatic repair, and adds no generated-parser class to the repair allowlist.
- This changes no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY behavior and runs no Docker.

