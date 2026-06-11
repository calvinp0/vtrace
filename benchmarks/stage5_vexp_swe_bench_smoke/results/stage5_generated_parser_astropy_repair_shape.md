# Stage 5 generated-parser repair — patch-shape inspection (Astropy 14369)

Inspection of the repaired patch produced by the gated generated-parser **live** repair path.

- run label: `eval-strictv2-artifacts-protocol-vtrace-astropy-14369`
- instance: `astropy__astropy-14369`
- repair source: `generated_parser_minimality`
- repairExecuted: `true`; repairSucceeded: `true`; repairFailedOpen: `false`
- repair cost: `$0.2560` (4351 in / 2282 out tokens)
- artifact: `results/runs/<runLabel>/raw/vtrace/repair/_repaired_patch.diff`

## Boundary

This generated a repaired patch only. It did not run Docker and does not claim a repair
conversion. No Docker evaluation was run; no resolution is claimed.

## First patch vs repaired patch

| property | first patch (broad rewrite) | repaired patch (narrow) |
| --- | --- | --- |
| files touched | `cds.py`, `cds_lextab.py`, `cds_parsetab.py` | `cds.py` only |
| generated tables | `cds_lextab.py` (21 lines) and `cds_parsetab.py` (68 lines) **deleted** | not touched |
| `cds.py` change | 30-line block (`@@ -164,30 +164,20 @@`) | single hunk (`@@ -182,7 +182,7 @@`) |
| grammar edit | broad | one-line reorder of the `division_of_units` production |

The repaired hunk only reorders the alternative inside `p_division_of_units`:

```diff
             division_of_units : DIVISION unit_expression
-                              | unit_expression DIVISION combined_units
+                              | combined_units DIVISION unit_expression
```

## Desired-shape checklist

- [x] changes `p_division_of_units` narrowly (single-line production reorder)
- [x] does **not** delete `cds_parsetab.py` / `cds_lextab.py`
- [x] does **not** relocate productions into `p_combined_units`
- [x] does **not** broadly rewrite unrelated grammar functions

The patch shape is acceptable. Docker evaluation is deliberately **not** run in this milestone.
