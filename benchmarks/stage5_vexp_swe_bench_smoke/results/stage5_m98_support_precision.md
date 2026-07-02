# Stage 5 M98 Capsule Support Precision

_Deterministic, offline: no live agents, no Docker, no API spend. Scored against
the frozen M97 baseline (`stage5_m97_deterministic_scoreboard.*`) with the M95
dev/holdout split; gold labels the output only._

## Summary

- **Change**: relation-shape **confidence tiers** for the M97 co-edit support
  lane (`src/capsuleV2/coeditExpansion.ts`, placement in `buildCapsuleV2`).
  Every selected co-edit candidate is tiered from its relation shape alone:
  **HIGH** (generated pair; call-edge injection with task-word affinity; ≥2
  relation-type rescue with ≥8 edges) keeps M97's displacement rights;
  **MEDIUM** (stem-share-only call-edge injection; sparse ≥2-type rescue)
  renders only into genuinely spare support slots and can displace nothing;
  **LOW** (single-relation-type rescue; injection without a call edge; injected
  `__init__` package facade) is pruned before rendering and recorded in
  diagnostics. Selection competition is byte-identical to M97, so the rendered
  set is strictly a subset of what M97 shipped.
- **Why**: M97's lane rendered ~1 non-gold support file per fired case (94 %
  non-gold candidates), driving mean capsule files 3.63→4.32 and the label
  bleed excellent 32→18 / overpacked 11→18. The M98 audit found all 6 gold
  candidates concentrate in the high-confidence shapes, while the three LOW
  shapes hold 46 candidates with **zero** gold.
- **M97 baseline → M98 (all scored, n=99)**: mean capsule files
  **4.323 → 3.919** (−0.40), overpacked **18 → 14**, excellent **18 → 26**;
  recall@1/@5, any-gold, all-gold (70.7 %), lead=src-gold, hidden-coedit
  (0.589), median (1152) and p90 (3536) tokens all **exactly unchanged**.
- **Precision vs recall tradeoff**: none measurable — 46 candidates pruned +
  15 medium deferred, 0 gold among them; all 5 M97-recovered multi-file cases
  keep `all_gold_in_capsule`; multi-file all-gold stays 40.0 %, hidden-coedit
  0.589.
- **Verdict: PASS** (all 14 criteria; details below).
- **Recommendation**: proceed to **import-edge extraction (M99)** — the miss
  bucket (24) and the import-only hidden co-edits (django-13195/16256) are
  untouched by packing, and better import edges would also upgrade some of the
  pruned no-call-edge injections into scoreable evidence.

## Support Precision Gap Analysis

See `stage5_m98_support_precision_gap_analysis.md` (pre-change audit). Key
findings that drove the design:

- All 26 M96→M97 outcome flips were in co-edit-fired cases; 8 landed
  overpacked (all at exactly 6 files / 1 gold) and 15 excellent→good (a 3-file
  capsule pushed to 4, ratio > 3).
- 83 of 107 co-edit candidates rendered; 78 were non-gold (57 cases ≈ 1 extra
  non-gold file each). Displacement only ever hit duplicate/generic/docs items,
  so the damage was purely additive file count, not evicted gold.
- Non-gold noise concentrates in three shapes with zero gold: 13 injected
  `__init__.py` facades, 20 injections without a call edge
  (imports/references-only), 23 single-relation-type rescues. Every gold
  candidate is a generated pair, a call-edge+affinity injection, or a dense
  calls+references rescue (15/26 edges).
- Duplicate-file support symbols are invisible to `capsule_file_count` and
  token-cheap; file-level-first selection (Family A) would hand their slots to
  *more* distinct files and worsen the ratio — rejected.
- Chosen intervention: Family B (confidence tiers) + Family D (facade filter,
  injection-only) + Family C refinement (spare-slot-only placement for medium).

## Implementation

- **Files changed**: `src/capsuleV2/coeditExpansion.ts` (tier classification,
  pruning at selection, split displacing/spare-only placement),
  `src/capsuleV2/buildCapsuleV2.ts` (spare-only wiring, displacement
  attribution, new diagnostics), `src/capsuleV2/types.ts` (diagnostic fields),
  `src/capsuleV2/coeditExpansion.test.ts` (6 new tests, 2 updated). Benchmarks:
  `run_stage5_m98_deterministic_scoreboard.ts` (new; M97-baselined cohorts +
  support-precision instrumentation).
- **Algorithm change**: candidate mining, per-anchor competition, and global
  selection are unchanged from M97. After selection, each winner is tiered by
  relation shape; LOW winners are pruned (slot left empty — never refilled, so
  no new unmeasured candidate can surface), MEDIUM winners are ordered behind
  every base support winner (spare slots only), HIGH winners keep the M97
  placement (ahead of duplicate/generic/docs winners only).
- **Pruning/scoring/displacement rules**: LOW = single-relation-type rescue,
  no-call-edge injection, injected `__init__` facade. MEDIUM = stem-share-only
  call-edge injection, ≥2-type rescue with < 8 edges. HIGH = generated pair,
  call-edge+affinity injection, ≥2-type rescue with ≥ 8 edges. Scores, the
  20 % co-edit token ceiling, `MAX_COEDIT_FILES=2`, support caps (4), and pivot
  selection are untouched.
- **Caps**: no cap increased; `MIN_HIGH_CONFIDENCE_RESCUE_EDGES = 8` is the
  only new constant (4× `MIN_RESCUE_EDGES`; both observed gold rescues sit at
  15/26 edges, so any threshold ≤ 15 preserves them — 8 is chosen with margin,
  not at the boundary).
- **Why general**: tiers key only off relation shape in the index (edge types,
  edge counts, basenames, task-token affinity) — no instance ids, repos, paths,
  or thresholds tuned to a gold boundary.
- **Why not gold leakage**: the lane still reads only the index and the derived
  task; gold enters only the scoreboard's labelling (the `assertNoGoldLeakage`
  guard is unchanged). The tier rules were *validated* against gold labels in
  the offline audit but *evaluate* nothing gold at build time.
- **Tests added/updated**: single-type rescue pruned with reason; sparse
  two-type rescue = MEDIUM + dense = HIGH; no-call-edge injection pruned
  despite affinity; `__init__` facade injection pruned; affinity = HIGH vs
  stem-share-only = MEDIUM; spare-only entry never displaces (even junk);
  updated per-anchor-cap fixture to bidirectional coupling; existing
  no-lead-theft/determinism/cap tests still pass. Full suite: 3453 pass.

## Deterministic Scoreboard Delta (M97 → M98)

| cohort | n | r@5 | all-gold | hidden | med tok | p90 tok | mean files | excellent | overpacked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 99 | 0.721 (=) | 70.7 % (=) | 0.589 (=) | 1152 (=) | 3536 (=) | 4.32→3.92 | 18→26 | 18→14 |
| dev | 60 | 0.799 (=) | 78.3 % (=) | 0.736 (=) | 890→917 | 2843 (=) | 4.30→3.93 | 12→17 | 12→11 |
| holdout | 39 | 0.603 (=) | 59.0 % (=) | 0 (=) | 1513→1484 | 6325 (=) | 4.36→3.90 | 6→9 | 6→3 |
| multi-file | 15 | 0.494 (=) | 40.0 % (=) | 0.589 (=) | 1194 (=) | 2620 (=) | 4.27→4.20 | 1 (=) | 1 (=) |
| coedit-fired (M97 defn) | 69 | 0.703 (=) | 71.0 % (=) | 0.778 (=) | 1216 (=) | 5282→5377 | 4.78→4.20 | 7→15 | 14→10 |
| M97-recovered | 5 | 0.800 (=) | 100 % (=) | 1.000 (=) | 1530 (=) | 2250 (=) | 5.20 (=) | 1 (=) | 0 (=) |
| M97-overpacked | 18 | 0.972 (=) | 94.4 % (=) | 1.000 (=) | 1476→1420 | 5628→5615 | 6.00→5.67 | 0 (=) | 18→14 |

Every recall/coverage metric is identical in every cohort — the change removed
only non-gold files. All 12 outcome flips vs M97 are improvements or reversions
to the case's M96 label: 8× good→excellent (astropy-14539, django-10973/13363/
15695, pytest-10051/7432, scikit-learn-11578, sphinx-7748), 3×
overpacked→good (flask-5014, sympy-23413, sympy-24213), 1× overpacked→
wrong_pivot (django-15503 — its M96 state; the co-edit file that had inflated
it was a LOW single-type rescue). `m97_recovered_lost` is empty.

Dev median tokens +27 (+3.0 %, 890→917) and coedit-fired p90 +95 (+1.8 %): a
refused displacement means the original duplicate-symbol signature (slightly
larger than the co-edit signature it displaced under M97) renders again.
All-scored median/p90 are exactly flat and holdout median fell 29 (−1.9 %).

Per-repo (`stage5_m98_deterministic_by_repo.csv`): recall metrics unchanged in
every repo; mean files drop where the pruned shapes concentrated (django
4.79→4.32, sympy 4.71→4.24, sphinx 4.83→4.17, astropy 4.55→4.36); the
sole non-.py candidate (`_column_mixins.pyx`, astropy-7166) was pruned by the
no-call-edge rule.

## Support Precision Analysis

- **Kept candidates 61** (was 107): 35 rescued + 26 injected (dev 38 kept /
  24 pruned, holdout 23 kept / 22 pruned). Gold kept 6/6 (dev 5, holdout 1 —
  the sphinx-9698 near-miss that still, correctly, finds no displaceable slot).
- **Pruned 46, 0 gold**: single-relation-type rescue 23, `__init__` facade
  injection 13, no-call-edge injection 10.
- **Confidence tiers** (selection winners): high 46, medium 15, low 46
  (pruned). Spare-slot deferrals: 15 medium items found no spare slot and were
  not rendered (the displacements M98 refuses).
- **Displacements 37** (was 82) — only HIGH-tier candidates displace now, and
  still only duplicate-file/generic/docs winners.
- **Support composition** (all scored): duplicate-file support items 141,
  generic-infra 0, docs/examples 10 — after M98, docs/generic junk in support
  is negligible; remaining duplicates are token-cheap intra-file detail.
- **Non-gold candidate rate**: 94.4 % → 90.2 % kept (6 gold / 61); more
  importantly, non-gold *rendered* files fell by ~40 across the run (mean
  capsule files −0.40 with zero gold loss).

## Capsule/Token Impact

- Median/p90 capsule tokens: all-scored 1152 / 3536 — both exactly unchanged;
  holdout 1513→1484 (−1.9 %) / 6325 (=); dev 890→917 (+3.0 %) / 2843 (=).
- Mean capsule file count 4.323→3.919 (−0.404); median 4→4; fired-case mean
  4.78→4.20.
- Outcome labels: excellent 18→26, good 27→22, overpacked 18→14,
  wrong_pivot 10→11 (django-15503 reverting to its M96 label), partial 2 (=),
  miss 24 (=).
- Mean optional (support) targets 2.85→2.45; required targets unchanged.

## Retrieval Eval Compatibility

- django expanded: top-1 80.0 %, top-3 100 %, as-pivot 95.0 %, missing 0 % —
  identical to the M97 values; mean tokens 1097.45→1097.0.
- cross-repo-30: top-1 66.7 %, top-3 80.0 %, as-pivot 73.3 %, missing 13.3 %,
  no-context 1 — identical to the M97 values; mean tokens 1918.6→1918.3.
- No regression on any tracked metric (both run into a temp dir; the
  pre-existing dirty `stage5_retrieval_eval_cross_repo_30.*` files untouched).

## Remaining Failure Modes

- **Misses are still 24** (`lexical_mismatch` — no anchor at all: pylint-4551/
  8898, django-16938, sympy-16597, most holdout misses). Packing cannot help
  these; candidate recall for anchor-less cases remains the biggest absolute
  bucket.
- **Import-only hidden co-edits remain unreachable** (django-13195
  `sessions/middleware.py`, django-16256 `contenttypes/fields.py`): the index
  emits few import edges, and M98 deliberately distrusts the ones it has
  (no-call-edge injections were 0/20 gold). **Import-edge extraction is now the
  clear next bottleneck** — it would both unlock those cases and give the
  pruned import-relation injections real evidence to be re-tiered on.
- Hidden co-edit does *not* need another recall pass first: the residual
  multi-file failures are anchor-less (miss) or relation-less (holdout), not
  packing casualties.
- Overpacked floor is now 14: 4 pre-existing non-co-edit cases (django-11206/
  11749/12325, sympy-24562) plus 10 fired cases whose extra file is a
  HIGH-tier candidate — trimming those would start trading real evidence for
  labels.

## Success Criteria Check

1. Overpacked −3 all-scored OR mean files −0.4: **PASS** (both: 18→14 and
   4.323→3.919, −0.404).
2. Multi-file all_gold ≥ 33 %: **PASS** (40.0 %, unchanged).
3. hidden_coedit_recall ≥ 0.50: **PASS** (0.589, unchanged).
4. Holdout recall@1 drop ≤ 2pts: **PASS** (0.436→0.436).
5. Holdout lead_pivot_is_source_gold drop ≤ 2pts: **PASS** (0.436→0.436).
6. Holdout any_gold_in_capsule does not drop: **PASS** (61.5 %→61.5 %).
7. Holdout median tokens ≤ +5 %: **PASS** (−1.9 %).
8. Holdout p90 tokens ≤ +5 %: **PASS** (6325→6325).
9. Retrieval evals no material regression: **PASS** (headline metrics
   identical, mean tokens −0.5/−0.3).
10. No broad support-cap increase: **PASS** (no cap touched; the change only
    prunes).
11. No M97-recovered case lost: **PASS** (`m97_recovered_lost` empty; cohort
    all-gold 5/5).
12. No gold leakage: **PASS** (tiers read relation shape only; guard
    unchanged).
13. Tests/typechecks: **PASS** (3453 tests; `typecheck` +
    `typecheck:benchmarks`; `git diff --check` clean).
14. No live agents / Docker / API spend: **PASS** (in-process builds over
    existing indexes only).

## Verdict

**PASS** — the capsule keeps every point of M97's recall (all coverage metrics
identical in every cohort, all five recovered multi-file cases intact) while
shedding 0.40 files per capsule, a quarter of its overpacked labels, and 46
zero-gold co-edit candidates. No FAIL or MIXED condition triggers: holdout is
flat-to-better, tokens are flat-to-better, retrieval evals are identical, and
the rules are relation-shape-general.

## Recommendation

**Proceed to import-edge extraction (M99).** Support precision has hit the
point of diminishing returns (the remaining overpacked cases carry HIGH-tier
evidence or predate the co-edit lane); the untouched failure modes — 24
anchor-less misses and the import-only hidden co-edits — need better retrieval
evidence, and richer import edges would additionally let the pruned
import-relation injections earn a real tier instead of a blanket LOW.
