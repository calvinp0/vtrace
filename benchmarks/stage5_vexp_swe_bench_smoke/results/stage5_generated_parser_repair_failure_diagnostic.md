# Stage 5 generated-parser repair failure diagnostic

_Generated: 2026-06-11T20:10:33.353Z_

_Analysis only. Reads existing artifacts (repair conversion report, repaired patch, first patch, earlier resolved patch) and runs the deterministic `analyzeGeneratedParserConsistency` probe. No agents, no repair, no live critic, no Docker, no model calls, no artifact mutation, no policy accounting._

## Summary

The gated generated-parser repair for `astropy__astropy-14369` produced a narrow, well-localized grammar reorder but the Docker evaluation stayed **unresolved**. The deterministic consistency probe classifies the repaired patch as `source_grammar_changed_without_generated_table_update`: it changed the source grammar in `cds.py` without updating the generated parser table `cds_parsetab.py`. This is generated-parser **consistency**, not localization and not broad-rewrite minimality.

## Source run

- **Run label**: `eval-strictv2-artifacts-protocol-vtrace-astropy-14369`.
- **Instance**: `astropy__astropy-14369`.
- **Conversion report found**: yes (`stage5_generated_parser_repair_conversion.json`).

## Repair attempt

The gated generated-parser repair fixed the earlier broad-rewrite shape: it did not delete generated parser tables, did not relocate productions across parser functions, and did not broadly rewrite unrelated grammar functions. It changed only `astropy/units/format/cds.py`.

- **Files changed by repaired patch**: astropy/units/format/cds.py.
- **Narrow grammar reorder detected**: yes.

## Docker outcome

| property | value |
| --- | --- |
| dockerUsed | yes |
| evaluationMethod | isolated_derived_jsonl_external_evaluate |
| sourcePatchResolved | no |
| repairedPatchResolved | no |
| convertedUnresolvedToResolved | no |

The repaired patch did not convert the instance. This remains a patch-quality failure and is not counted as a conversion.

## Repaired patch shape

The repaired patch reorders one alternative inside `p_division_of_units`:

```diff
             division_of_units : DIVISION unit_expression
-                              | unit_expression DIVISION combined_units
+                              | combined_units DIVISION unit_expression
```

- [x] changes `p_division_of_units` narrowly (single-line production reorder)
- [x] does **not** delete `cds_parsetab.py` / `cds_lextab.py`
- [x] does **not** relocate productions into `p_combined_units`
- [x] does **not** broadly rewrite unrelated grammar functions
- [ ] does **not** update the generated parser table `cds_parsetab.py` — **the gap**

## Consistency probe

Deterministic `analyzeGeneratedParserConsistency` over the repaired patch:

- **defectClass**: `source_grammar_changed_without_generated_table_update`; consistencyRisk yes; risk high; confidence high.
- **Source grammar files changed**: astropy/units/format/cds.py.
- **Expected generated tables**: astropy/units/format/cds_parsetab.py.
- **Generated tables updated**: none.
- **Generated tables deleted**: none.
- **Narrow grammar reorder detected**: yes.
- **Signals**: `source_grammar_changed_without_generated_table_update`, `narrow_grammar_reorder_without_table_update`, `expected_generated_table_known_present`.
- Source grammar file(s) astropy/units/format/cds.py changed (functions: p_division_of_units) but the expected generated parser table(s) astropy/units/format/cds_parsetab.py were not updated. PLY runs the stale generated table at import time, so the source grammar edit has no runtime effect until the table is regenerated.
- The source edit is a narrow grammar-production reorder (minimal and well-localized) — the defect is generated-parser consistency, NOT localization and NOT broad-rewrite minimality.
- Expected generated table(s) astropy/units/format/cds_parsetab.py are known to exist (observed in the first/resolved patch), so the stale-table inference does not rely on PLY convention alone.

## Comparison with resolved patch

The earlier resolved strict run `eval-strictv2-vtrace-astropy-14369` changed both `cds.py` and `cds_parsetab.py`. It made the same narrow `division_of_units` reorder AND regenerated the parser table.

| patch | files changed | updated cds_parsetab.py |
| --- | --- | --- |
| resolved | astropy/units/format/cds.py, astropy/units/format/cds_parsetab.py | yes |
| repaired (unresolved) | astropy/units/format/cds.py | no |

- **Generated table(s) the repaired patch missed**: astropy/units/format/cds_parsetab.py.

## Diagnosis update

The generated-parser repair fixed the broad-rewrite problem but likely under-repaired the generated-parser consistency problem. The repaired patch changed the source grammar in cds.py but did not update cds_parsetab.py. The earlier resolved Astropy patch changed both cds.py and cds_parsetab.py. Therefore the current failure should be treated as source_grammar_changed_without_generated_table_update, not as a localization failure.

## Recommended next step

Update the generated-parser repair guidance so that narrow repairs may update generated parser tables consistently when the source grammar changes. The instruction should forbid deleting generated parser tables or broad grammar rewrites, but should require regenerating/updating the relevant parsetab when the grammar changes. Do not run another Astropy instance yet; do not add a policy-accounting row; do not change pivot ranking or Capsule budget.

## Non-claims

- This report does not re-run agents, repair, live critic, or Docker.
- This report does not modify any patch.
- This report does not claim a repair conversion.
- This report does not change repair eligibility.
- This report does not change Stage 5 policy accounting.
- This report does not prove all generated-parser systems require committed parser-table updates.

