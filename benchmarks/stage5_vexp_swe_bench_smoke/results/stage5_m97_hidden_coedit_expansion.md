# Stage 5 M97 Hidden Co-edit Expansion

_Deterministic, offline: no live agents, no Docker, no API spend. Scored against
the frozen M96 baseline (`stage5_m96_deterministic_scoreboard.*`) with the M95
dev/holdout split; gold labels the output only._

## Summary

- **Change**: a bounded, relation-backed **co-edit support lane**
  (`src/capsuleV2/coeditExpansion.ts`, wired in `buildCapsuleV2`). When the
  capsule leads with a credible source pivot, it (a) **rescues** ≤1 pooled
  support candidate per anchor whose file is new to the capsule and densely
  edge-connected (≥2 cross-file edges + same/parent/sibling package) to an
  anchor file, and (b) **injects** edge-connected package neighbours gated by
  task-token affinity on the connecting symbol names or anchor-stem sharing,
  plus exact generated-artifact pairs (`cds.py` ↔ `cds_parsetab.py`). Combined
  cap 2 files, 1 symbol each, support-only, ≤20 % of the token budget, and a
  displacement rule that never evicts a support item introducing a new,
  non-generic, non-example file.
- **Why**: M96 left multi-file all-gold at 6.7 % and holdout hidden-coedit at 0;
  the M97 gap audit showed the hidden sibling is almost always either already
  retrieved but squeezed out of the 4-slot support budget by duplicate-file
  symbols, or one call/reference edge away from a found anchor.
- **M96 → M97 (all scored, n=99)**: recall@5 0.706→**0.721**, all-gold
  65.7 %→**70.7 %**, hidden-coedit 0.256→**0.589**; recall@1 / any-gold /
  lead=src-gold / median (1152) / p90 (3536) tokens all unchanged.
- **Multi-file (n=15)**: all-gold **6.7 % → 40.0 %**, hidden-coedit
  **0.256 → 0.589**, recall@5 0.394→0.494.
- **Dev vs holdout**: dev hidden-coedit 0.319→**0.736**, dev all-gold
  70 %→78.3 %; **holdout is exactly flat on every headline metric**
  (r@1 0.436, any 61.5 %, all 59.0 %, lead 43.6 %, hidden 0) with median tokens
  +1.95 % and p90 −0.1 %. All 3 holdout multi-file cases lack any deterministic
  relation signal (2 are full misses with no anchor; the 1 anchored case has no
  edge/directory/pair relation), exactly as the pre-change audit predicted.
- **Cost**: mean capsule file count 3.63→4.32; the outcome-label distribution
  shifts (excellent 32→18, good 16→27, overpacked 11→18) because ~1 non-gold
  relation-backed support file per fired case pushes the file-per-gold ratio
  over the classifier's cutoffs. Token budgets are untouched.
- **Verdict: MIXED** — large dev/multi-file gains at zero token cost, holdout
  headline flat (no regression), non-gold candidate rate high (94 %).
- **Recommendation**: keep the lane; next milestone should be **capsule
  packing / support-precision improvement** (trimming low-value support files —
  now the dominant cost — rather than adding more recall).

## Hidden Co-edit Gap Analysis

See `stage5_m97_hidden_coedit_gap_analysis.md` (+
`stage5_m97_hidden_coedit_gap_audit.json`). Key findings driving the design:

- 15/99 scored cases are multi-file; M96 all-gold on them was 1/15. In 10/12
  dev (1/3 holdout) multi-file cases ≥1 source gold was already found.
- Relations connecting found→hidden gold (dev): same-directory 4,
  parent/child 4, sibling-package 1, call edges 3, reference edges 2, generated
  pair 1, none 2; holdout: none 1 (only anchored case).
- 3 dev hidden gold files were in the pool but discarded "beyond standard
  support budget (max 4)" — with the budget spent on extra symbols of files
  already in the capsule (budget-displacement audit, Q9).
- Every hidden file had `graph_neighbor_saw_it=false`: important co-edit
  siblings are high-in-degree files the existing graph-neighbour lane rejects
  as hubs, and its recovered neighbours order last among support.
- Dangerous relations excluded: bare same-directory without edges, hub anchors
  by raw edge volume, generic-named siblings (`base.py`), import-only
  relations invisible to this index.

## Implementation

- **Files changed**: `src/capsuleV2/coeditExpansion.ts` (new lane, pure w.r.t.
  the index), `src/capsuleV2/buildCapsuleV2.ts` (wiring + co-edit token ceiling
  + displacement diagnostics), `src/capsuleV2/types.ts` (diagnostics fields),
  `src/db/repositories/edgesRepository.ts`
  (`listCrossFileEdgeEndpointsForFile`, `countCrossFileNeighborFiles`),
  `src/capsuleV2/coeditExpansion.test.ts` (20 tests). Benchmarks:
  `run_stage5_m97_hidden_coedit_gap_audit.ts`,
  `run_stage5_m97_deterministic_scoreboard.ts`.
- **Activation**: lead pivot must exist and not be a test or docs/example file;
  anchors are credible source pivots (not tests/docs/vendored/generic-infra/
  suppressed decoys) plus support candidates with strong independent evidence
  (line/title/literal/direct-evidence anchor, body literal, test-routed, or
  lexical ≥ 0.5); ≤4 anchors.
- **Relation types used**: cross-file call/reference/import edges within
  package scope (same dir / parent-child / sibling package), pool-rescue
  (≥2 edges + proximity), generated parser-table pairs. Injection additionally
  requires task-token affinity on a connecting symbol name or an anchor-stem
  token share, and rejects neighbours edge-connected to >25 distinct files
  (repo-wide utilities) and anchors with >6 qualifying neighbours (hub shape).
- **Caps**: 2 co-edit files/case, 1 per anchor (generated pairs exempt),
  1 symbol/file, combined tokens ≤20 % of the capsule budget, no test co-edits
  (test files are excluded outright).
- **Budget/displacement**: co-edit entries are support-only and rank behind
  every support winner that introduces a new, non-generic, non-example file —
  they can only reclaim slots spent on duplicate-file symbols, generic-infra
  files, or docs/examples. Displacements are recorded in `coedit_displaced`.
  Support caps (2 pivots / 4 support at this budget) are untouched.
- **Why general**: keys only off index structure (edges, paths, stems) and the
  task prose; no instance ids, repo names, or benchmark-specific paths.
- **Why not gold leakage**: the lane reads the index and the derived task; gold
  patches are used only by the scoreboard to label outputs (the leakage guard
  `assertNoGoldLeakage` still blocks any task that names a gold path).
- **Tests**: activation gating (no pivots / test lead / generic-only lead),
  injection affinity/ambiguity/hub/test/generic/scope filters, generated-pair
  injection, rescue threshold + winner exclusion, per-anchor cap, combined cap,
  rescue-beats-injection precedence, displacement ordering (new-file winner
  never displaced; duplicate-file and generic displaceable; no double-emission),
  determinism. Full suite: 3447 pass.

## Deterministic Scoreboard Delta (M96 → M97)

| cohort | n | r@5 | any-gold | all-gold | lead=src | hidden-coedit | med tok | p90 tok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 99 | 0.706→0.721 | 75.8 % (=) | 65.7→70.7 % | 51.5 % (=) | 0.256→0.589 | 1152 (=) | 3536 (=) |
| dev | 60 | 0.774→0.799 | 85.0 % (=) | 70.0→78.3 % | 56.7 % (=) | 0.319→0.736 | 920→890 | 2843 (=) |
| holdout | 39 | 0.603 (=) | 61.5 % (=) | 59.0 % (=) | 43.6 % (=) | 0 (=) | 1484→1513 | 6329→6325 |
| multi-file | 15 | 0.394→0.494 | 73.3 % (=) | 6.7→40.0 % | 13.3 % (=) | 0.256→0.589 | 1152→1194 | 2637→2620 |
| multi-file dev | 12 | 0.451→0.576 | 83.3 % (=) | 8.3→50.0 % | 16.7 % (=) | 0.319→0.736 | 906→926 | 2172→2183 |
| multi-file holdout | 3 | 0.167 (=) | 33.3 % (=) | 0 (=) | 0 (=) | 0 (=) | 2637→2620 | 6329→6325 |
| single-file | 84 | 0.762 (=) | 76.2 % (=) | 76.2 % (=) | 58.3 % (=) | — | 1139.5→1145 | 3536 (=) |
| hidden-coedit subset | 15 | same as multi-file (identical id set) | | | | | | |
| partial-gold subset | 10 | 0.492→0.642 | 100 % (=) | 0→50.0 % | 20.0 % (=) | 0.283→0.783 | 906→926 | 1643→1646 |

Recovered multi-file cases (dev): pydata-6938 (`variable.py` rescued, 15 edges),
mwaskom-3187 (`_core/scales.py` rescued, 26 edges — overpacked→excellent),
sphinx-7462 (`pycode/ast.py` injected via a call edge whose connecting symbol
`_parse_annotation` matches the task word "annotation"), matplotlib-24870
(`tri/_tricontour.py` injected, 3 edges + stem share), astropy-14369
(`cds_parsetab.py` injected as generated pair). All five flip
`all_gold_in_capsule` to true; multi-file all-gold goes 1/15 → 6/15.

Per-repo movement mirrors the case list (xarray, seaborn, sphinx, matplotlib,
astropy improve on all-gold/hidden; django/sympy hidden gold connected only by
import-only or no relations is untouched). See
`stage5_m97_deterministic_by_repo.csv`.

## Co-edit Lane Analysis

- Fire rate: 69/99 (dev 41/60, holdout 28/39). Gold hit when fired: 6 cases
  (8.7 %); 107 candidates total = 58 rescued + 49 injected, of which 6 gold
  (non-gold rate 94.4 %).
- Evidence types (cases): pool_rescue_calls_references 26, edge_calls_references
  15, pool_rescue_calls 12, edge_calls 10, edge_imports 9, edge_references 8,
  pool_rescue_references 8, generated_artifact_pair 1, other combos 6.
- Rejections: 883 ambiguous (volume-without-affinity or beyond caps),
  209 hub-shaped (anchor fan-out or neighbour global fan-in >25),
  0 budget-limited (signature items are far below the 20 % ceiling).
- Displacement: 82 items displaced across fired cases — all duplicate-file
  symbols, generic-infra files, or docs/example items by construction.
- Notable safety datapoint: on holdout sphinx-9698 the lane *injected the gold
  file itself* (`sphinx/domains/python.py`) but the displacement rule found no
  displaceable winner, so it never rendered — the protection that guarantees no
  regression also forfeited one holdout near-recovery.
- False-positive behaviour: ~1 non-gold relation-backed file per fired case is
  the direct cause of the outcome-label shift (below).

## Capsule/Token Impact

- Median tokens 1152→1152, p90 3536→3536 (all); holdout median +29 (+1.95 %),
  p90 −4. Dev median −30 (rescues replace larger duplicate-symbol signatures).
- Mean capsule file count 3.63→4.32; mean optional targets 2.15→2.85.
- Outcome labels: excellent 32→18, good 16→27, overpacked 11→18, partial 4→2,
  wrong_pivot 12→10, miss 24 (=). Dev flips: 10× excellent→good and
  3× good→overpacked (one extra non-gold file pushing files-per-gold past the
  3.0 cutoff), 1× wrong_pivot→overpacked, against seaborn-3187
  overpacked→excellent, xarray-6938 + sphinx-7462 partial→good.
- Displacement behaviour: recorded per case (`coedit_displaced`); only
  duplicate-file/generic/example items lose slots.

## Retrieval Eval Compatibility

- django expanded: top-1 80.0 %, top-3 100 %, as-pivot 95.0 %, missing 0 % —
  identical to the M96 baseline; mean tokens 1096.55→1097.45.
- cross-repo-30: top-1 66.7 %, top-3 80.0 %, as-pivot 73.3 %, missing 13.3 %,
  no-context 1 — identical to the M96 baseline; mean tokens 1914.1→1918.6.
- No regression on any tracked metric.

## Remaining Failure Modes

- Misses are unchanged at 24 — the lane cannot help cases with **no anchor at
  all** (pylint-4551/8898, django-16938, sympy-16597, most holdout misses);
  candidate recall for anchor-less cases is still the biggest absolute bucket
  (`lexical_mismatch` 24).
- Hidden co-edits connected only by **Python imports** stay unreachable
  (django-13195 `sessions/middleware.py`, django-16256
  `contenttypes/fields.py`): this index emits few import edges (82 vs 8190
  call edges in xarray). An import-edge extraction improvement would unlock
  them.
- The new dominant *quality* cost is **support precision**: ~1 non-gold
  relation-backed file per fired case (94 % non-gold candidate rate) drives the
  excellent→good/overpacked label bleed. Packing/precision, not recall, is now
  the top capsule-quality bottleneck.

## Success Criteria Check

1. Holdout hidden_coedit_recall +5pts OR holdout multi_file_all_gold +5pts:
   **FAIL** (0→0 on both; all 3 holdout multi-file cases have no relation
   signal — 2 have no anchor, 1 has no relation).
2. Holdout recall@1 drop ≤2pts: **PASS** (0.436→0.436).
3. Holdout lead_pivot_is_source_gold drop ≤2pts: **PASS** (0.436→0.436).
4. Holdout any_gold_in_capsule does not drop: **PASS** (61.5 %→61.5 %).
5. Holdout median tokens ≤ +10 %: **PASS** (+1.95 %).
6. Holdout p90 tokens ≤ +10 %: **PASS** (−0.1 %).
7. Overpacked count not materially up without a larger hidden-coedit gain:
   **PARTIAL** — overpacked 11→18, against multi-file all-gold +33.3pts and
   hidden-coedit +33.3pts (dev-concentrated); the label shift is file-count
   driven, tokens flat.
8. Retrieval evals no material regression: **PASS** (byte-identical headline
   metrics).
9. No broad support-cap increase: **PASS** (caps untouched; co-edits compete
   inside the existing 4-slot budget).
10. No lead-pivot theft: **PASS** (support-only by construction;
    lead_pivot_is_source_gold identical in every cohort).
11. No gold leakage: **PASS** (lane reads index + derived task only; leakage
    guard unchanged).
12. Tests/typechecks: **PASS** (3447 tests, `typecheck` + `typecheck:benchmarks`).
13. No live agents / Docker / API spend: **PASS**.

## Verdict

**MIXED** — the milestone's own MIXED definition applies twice over: dev
improves strongly (hidden-coedit +41.7pts, multi-file all-gold 8.3→50 %) while
holdout is flat, and the co-edit lane recovers five real multi-file cases while
adding mostly non-gold candidates elsewhere. No FAIL condition triggers:
holdout headline metrics do not regress, tokens are flat, retrieval evals are
identical, the change is repo-agnostic, and no leakage exists.

## Recommendation

**Proceed to capsule packing/token budget improvement.** Keep the lane: the
multi-file all-gold recovery (6.7→40 %) is the largest multi-file gain of the
deterministic series at zero token cost, and the holdout is safe. The next
deterministic win is support precision — trimming the ~1 non-gold support file
per case (co-edit or otherwise) that now drives the excellent→good/overpacked
label bleed — plus import-edge extraction to reach the import-only hidden
co-edits the audit identified.
