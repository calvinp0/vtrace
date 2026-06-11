# Stage 5 patch minimality probe report

_Generated: 2026-06-11T18:34:05.427Z_

_Analysis only. The deterministic `analyzePatchMinimality` probe is applied to patches that already exist on disk. No agents, no Docker, no model calls, no raw-artifact mutation. Every finding is an observation-only risk signal — this report does not repair patches and is not a gate._

## Summary

Analyzed 5 Stage 5 run patch(es). The probe rated 2 high-risk and flagged 2 with a generated-parser / grammar-minimality defect class (repairRequired on 2). The probe stays silent on non-parser patches.

| metric | value |
| --- | --- |
| runsAnalyzed | 5 |
| runsHighRisk | 2 |
| runsRepairRequired | 2 |
| runsWithGeneratedParserFindings | 2 |

## Runs analyzed

| run | instance | resolved | files changed | repairRequired | defectClass | risk | confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| eval-strictv2-artifacts-protocol-vtrace-astropy-14369 | astropy__astropy-14369 | no | 1 | yes | `generated_parser_broad_rewrite` | high | high |
| eval-strictv2-artifacts-vtrace-astropy-14369 | astropy__astropy-14369 | no | 1 | yes | `generated_parser_broad_rewrite` | high | high |
| eval-strictv2-artifacts-force-vtrace-astropy-14369 | astropy__astropy-14369 | unknown | 1 | no | `none` | low | low |
| eval-editguard-before-requests-5414 | psf__requests-5414 | no | 1 | no | `none` | low | high |
| eval-editguard-before-sympy-16766 | sympy__sympy-16766 | no | 1 | no | `none` | low | high |

### eval-strictv2-artifacts-protocol-vtrace-astropy-14369

- **Instance**: astropy__astropy-14369; resolved: no.
- **Files changed**: astropy/units/format/cds.py.
- **Verdict**: defectClass `generated_parser_broad_rewrite`, risk high, confidence high, repairRequired yes.
- **Generated files deleted**: astropy/units/format/cds_lextab.py, astropy/units/format/cds_parsetab.py.
- **Grammar functions changed**: p_combined_units, p_division_of_units, p_product_of_units, p_unit_expression.
- **Grammar functions removed**: p_division_of_units, p_product_of_units.
- **Signals**: `generated_parser_table_deleted`, `grammar_function_removed`, `multiple_grammar_functions_changed`, `grammar_productions_relocated`, `narrow_alternative_available`, `grammar_patch_minimality`.
- Patch deletes generated parser table file(s): astropy/units/format/cds_lextab.py, astropy/units/format/cds_parsetab.py.
- Parser function(s) removed entirely: p_division_of_units, p_product_of_units.
- Multiple parser functions changed in one patch: p_combined_units, p_division_of_units, p_product_of_units, p_unit_expression.
- Grammar productions appear relocated between parser functions (a function was removed while another was rewritten).
- Narrower alternative likely exists: reorder the division_of_units grammar production within its own parser function rather than relocating productions across parser functions or deleting generated parser tables.
- **Narrow alternative**: Narrower alternative likely exists: reorder the division_of_units grammar production within its own parser function rather than relocating productions across parser functions or deleting generated parser tables.

### eval-strictv2-artifacts-vtrace-astropy-14369

- **Instance**: astropy__astropy-14369; resolved: no.
- **Files changed**: astropy/units/format/cds.py.
- **Verdict**: defectClass `generated_parser_broad_rewrite`, risk high, confidence high, repairRequired yes.
- **Generated files deleted**: astropy/units/format/cds_parsetab.py.
- **Grammar functions changed**: p_combined_units, p_division_of_units, p_product_of_units, p_unit_expression.
- **Grammar functions removed**: p_division_of_units.
- **Signals**: `generated_parser_table_deleted`, `grammar_function_removed`, `multiple_grammar_functions_changed`, `grammar_productions_relocated`, `narrow_alternative_available`, `grammar_patch_minimality`.
- Patch deletes generated parser table file(s): astropy/units/format/cds_parsetab.py.
- Parser function(s) removed entirely: p_division_of_units.
- Multiple parser functions changed in one patch: p_combined_units, p_division_of_units, p_product_of_units, p_unit_expression.
- Grammar productions appear relocated between parser functions (a function was removed while another was rewritten).
- Narrower alternative likely exists: reorder the division_of_units grammar production within its own parser function rather than relocating productions across parser functions or deleting generated parser tables.
- **Narrow alternative**: Narrower alternative likely exists: reorder the division_of_units grammar production within its own parser function rather than relocating productions across parser functions or deleting generated parser tables.

### eval-strictv2-artifacts-force-vtrace-astropy-14369

- **Instance**: astropy__astropy-14369; resolved: unknown.
- **Files changed**: astropy/units/format/cds.py.
- **Verdict**: defectClass `none`, risk low, confidence low, repairRequired no.
- **Grammar functions changed**: p_division_of_units.
- **Signals**: `narrow_grammar_edit`.
- Narrow grammar edit: p_division_of_units changed without function relocation, removal, or generated-table deletion.

### eval-editguard-before-requests-5414

- **Instance**: psf__requests-5414; resolved: no.
- **Files changed**: requests/models.py.
- **Verdict**: defectClass `none`, risk low, confidence high, repairRequired no.
- No generated-parser / grammar-minimality risk shapes detected in the diff.

### eval-editguard-before-sympy-16766

- **Instance**: sympy__sympy-16766; resolved: no.
- **Files changed**: sympy/printing/pycode.py.
- **Verdict**: defectClass `none`, risk low, confidence high, repairRequired no.
- No generated-parser / grammar-minimality risk shapes detected in the diff.

## Generated-parser findings

| run | defectClass | risk | generated files deleted | grammar functions removed |
| --- | --- | --- | --- | --- |
| eval-strictv2-artifacts-protocol-vtrace-astropy-14369 | `generated_parser_broad_rewrite` | high | astropy/units/format/cds_lextab.py, astropy/units/format/cds_parsetab.py | p_division_of_units, p_product_of_units |
| eval-strictv2-artifacts-vtrace-astropy-14369 | `generated_parser_broad_rewrite` | high | astropy/units/format/cds_parsetab.py | p_division_of_units |

## Astropy protocol finding

The probe flags the unresolved Astropy protocol patch as `generated_parser_broad_rewrite` / `grammar_patch_minimality` because it deletes generated parser table files and broadly relocates grammar productions, even though the context localized the issue to the CDS parser grammar.

- **Run**: `eval-strictv2-artifacts-protocol-vtrace-astropy-14369` (instance `astropy__astropy-14369`, resolved: no).
- **defectClass**: `generated_parser_broad_rewrite`; risk high; confidence high.
- **Generated tables deleted**: astropy/units/format/cds_lextab.py, astropy/units/format/cds_parsetab.py.
- **Productions relocated out of**: p_division_of_units, p_product_of_units.
- **Narrow alternative**: Narrower alternative likely exists: reorder the division_of_units grammar production within its own parser function rather than relocating productions across parser functions or deleting generated parser tables.

## Probe signals

Deterministic signals the probe can emit (a finding fires one or more):

- `generated_parser_table_deleted` — a `*_parsetab.py` / `*_lextab.py` (or configured) file is deleted.
- `grammar_function_removed` — a `p_<rule>` parser function is removed entirely.
- `multiple_grammar_functions_changed` — two or more parser functions change in one patch.
- `grammar_productions_relocated` — a function is removed while another is rewritten (productions moved).
- `generated_artifact_deleted_without_source_grammar_edit` — a generated table is deleted with no source grammar edit.
- `grammar_function_broadly_rewritten` — one parser function rewritten across many production lines.
- `grammar_patch_minimality` / `narrow_alternative_available` — a narrower per-production edit likely exists.
- `narrow_grammar_edit` — a single localized grammar edit; explicitly NOT flagged high-risk.

## Recommended next step

Wire this deterministic probe into the live critic candidate-selection path as an observation-only risk signal first. Do not auto-repair yet. The next milestone should check whether the live critic agrees with the probe and can produce actionable narrow-rewrite instructions for this Astropy patch (reorder the division_of_units grammar production rather than relocating productions or deleting generated parser tables).

## Non-claims

- This report does not re-run agents or Docker.
- This report does not modify patches.
- This report does not make repair automatic.
- This report does not prove the generated-parser probe generalizes to all parser systems.
- This report does not change Stage 5 policy accounting.

