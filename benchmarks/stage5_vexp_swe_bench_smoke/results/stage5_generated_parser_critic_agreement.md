# Stage 5 generated-parser critic agreement

_Generated: 2026-06-11T19:04:22.969Z_

_Documentation only. No agents, no live critic, no repair, no Docker, no patch modification. Reads existing artifacts and records that the deterministic generated-parser minimality probe and the live patch critic agreed repair was required for this run._

## Summary

The auditable Astropy protocol run had good context: indexed Capsule v2 was injected, the lead pivot was astropy/units/format/cds.py::CDS, ordered telemetry was available, and loop heuristics were false. Docker still failed because the patch made a broad generated-parser rewrite. The deterministic generated-parser minimality probe flagged this as high-risk/high-confidence, and the live critic agreed that repair was required. This establishes an observation-only agreement signal, not a repair conversion.

## Run identity

- runLabel: eval-strictv2-artifacts-protocol-vtrace-astropy-14369
- instanceId: astropy__astropy-14369
- source: ad_hoc_run_label

## Context quality

Context-quality evidence read from the run's `_run.meta.json`, `_tool_calls.summary.json`, and `swebench-*.jsonl`. The run had good context yet Docker still failed — because the patch was a broad generated-parser rewrite, not because retrieval was poor.

| field | value |
| --- | --- |
| vtraceMethod | indexed-context |
| vtraceTreatmentValid | true |
| capsuleV2ArtifactsPersisted | true |
| capsuleEngine | v2 |
| pivotRankingVersion | v2 |
| lead pivot | astropy/units/format/cds.py::CDS |
| orderedTelemetryAvailable | true |
| longBashLoopHeuristic | false |
| repeatedSearchHeuristic | false |
| Docker resolved | false |

## Deterministic probe finding

The deterministic generated-parser patch-minimality probe (observation-only) flagged this patch.

- patchMinimalityRepairRequired: true
- patchMinimalityDefectClass: generated_parser_broad_rewrite / grammar_patch_minimality
- patchMinimalityRisk: high
- patchMinimalityConfidence: high
- patchMinimalitySignals: generated_parser_table_deleted, grammar_function_removed, multiple_grammar_functions_changed, grammar_productions_relocated, narrow_alternative_available, grammar_patch_minimality
- reason: Patch deletes generated parser table file(s): astropy/units/format/cds_lextab.py, astropy/units/format/cds_parsetab.py.
- reason: Parser function(s) removed entirely: p_division_of_units, p_product_of_units.
- reason: Multiple parser functions changed in one patch: p_combined_units, p_division_of_units, p_product_of_units.
- reason: Grammar productions appear relocated between parser functions (a function was removed while another was rewritten).
- reason: Narrower alternative likely exists: reorder the division_of_units grammar production within its own parser function rather than relocating productions across parser functions or deleting generated parser tables.
- narrowAlternativeHint: Narrower alternative likely exists: reorder the division_of_units grammar production within its own parser function rather than relocating productions across parser functions or deleting generated parser tables.

## Live critic finding

The live patch critic ran once on this run (observation-only; the critic never modifies the patch).

- scope_ok: true
- failing_behavior_handled: true
- minimality_ok: false
- test_evidence_ok: false
- risk: high
- repair_required: true
- confidence: high
- critic cost: $0.1858 (4240 in / 2453 out tokens)
- repair_reason: Broad non-minimal rewrite of a generated parser: it removes p_product_of_units and p_division_of_units, relocates their productions into p_combined_units, and deletes the generated lex/parse tables, when the deterministic probe indicates a narrower production-order change to division_of_units would suffice. This widens blast radius across the grammar and removes regenerable artifacts without test-suite coverage.
- repair_instructions: Modify the existing patch rather than restart: keep p_product_of_units and p_division_of_units as separate functions and confine the fix to making the division production left-associative within p_division_of_units (e.g. 'division_of_units : combined_units DIVISION unit_expression' / 'DIVISION unit_expression') so chained units associate correctly, instead of merging all productions into p_combined_units. Do not delete cds_lextab.py/cds_parsetab.py by hand; let PLY regenerate them, and run the named astropy/units test suite to confirm no existing CDS cases regress.

## Agreement

- deterministicRepairRequired: true
- liveRepairRequired: true
- agreementWithDeterministic: true

Agreement = (deterministicRepairRequired === liveRepairRequired). Both are true: the deterministic probe and the live critic independently concluded repair was required. This is an observation-only agreement signal, not a repair conversion.

## Observation-only boundary

- No repair was run.
- No generated-parser defect class was added to the repair allowlist.
- Repair remains disabled-by-default and ineligible for this defect class unless a later explicit milestone adds a gated generated-parser repair path.
- The generated-parser patch-minimality probe is an OBSERVATION-ONLY deterministic signal: it makes a run eligible for live critic observation but never triggers automatic repair.

## Repair boundary

- Generated-parser minimality is not yet in the repair allowlist.
- No repair was run.
- No repaired patch was evaluated.
- No policy accounting row should be added.

## Recommended next step

Design a separate gated generated-parser repair milestone. It should start with dry-run repair eligibility only, require a valid live critic report with actionable narrow-rewrite instructions, keep one-attempt/cost-cap/run-label gates, and only then test whether a repair can produce the narrow grammar-rule reorder without deleting generated parser tables.

## Non-claims

- This report does not re-run agents, live critic, repair, or Docker.
- This report does not modify any patch.
- This report does not claim a repair conversion.
- This report does not add generated-parser defects to the repair allowlist.
- This report does not change Stage 5 policy accounting.
- This report does not prove the probe generalizes to all generated-parser systems.

