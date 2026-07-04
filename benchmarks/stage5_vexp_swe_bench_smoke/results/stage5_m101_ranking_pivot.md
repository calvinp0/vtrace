# Stage 5 M101 Ranking and Lead-Pivot Improvement

_Deterministic milestone: no live agents, no Docker, no API spend, no Conda
mutation. Gold patches are scoring-only — never an input to generation._

## Summary

- **Seam decision**: the widest addressable gap is not tests/docs/facades
  winning lead (0/24 addressable cases) but a **role/ordering coherence gap**:
  candidates carrying tier-2 anchor evidence (title-symbol, high-signal
  literal-anchor, strong direct evidence — the exact ids the pivot ORDERING
  already ranks at `evidenceTier` 2) were invisible to the ROLE layer, so the
  `maxPivots=2` cap evicted them (12 gold cases) or the dispatcher demotion
  removed them (3 gold cases, 2 anchored) before ordering ever ran.
- **Change made**: the **anchored-target pivot guard**
  (`pivot_selection_version: "m101_anchored_target_guard"`). The tier-2 anchor
  id set is threaded into `refineDebugRoles` with two bounded effects:
  1. *Dispatcher-demotion exemption* — a non-test, actionable candidate that
     holds the pivot role on its own evidence is not demoted to support as an
     "entry point/caller" when the issue names it outright.
  2. *Bounded pivot-cap exemption* — at standard/full tiers, at most ONE
     anchored, anchor-actionable-kind, non-test, distinct-file pivot that the
     cap would evict keeps the pivot role, **converting one support slot** into
     the extra pivot slot (item budget constant) and ordering **last** among
     pivots (a required target, never the lead).
- **Why**: the issue author *named* these symbols/files (`InheritDocstrings`
  in a title, `polyval` in a title, `utils.numberformat.format` as a dotted
  path); a structural inference (score cap, "it delegates") must not silently
  override an explicit author pointer. This mirrors the existing line-anchor
  override one confidence notch down. Weak direct evidence and every
  support-only lane (co-edit, file-evidence rescue, graph neighbours) are
  excluded by construction.
- **M100 baseline → M101 result (all scored, n=99)**: wrong_pivot **11 → 8**,
  lead_pivot_is_source_gold **51.5% → 54.5%**, gold_file_in_required
  **60.6% → 64.6%**, excellent **27 → 29**, recall@1 **0.503 → 0.529**, MRR
  **0.609 → 0.627**; recall@5/@10, any-gold, all-gold, hidden-coedit,
  multi-file all-gold, overpacked count all byte-flat; holdout gold metrics
  byte-identical.
- **Verdict: PASS** (criterion 1 via the wrong_pivot arm: −3; every guard
  criterion holds; retrieval evals improved).
- **Recommendation**: proceed to the task-derivation audit (M100's deferred
  lever). The remaining 8 wrong_pivot cases are weak-direct-evidence golds
  (deliberate M96 conservatism) or plain-lexical twins not separable
  gold-blind; the 24 lexical-mismatch misses now dwarf the ranking gap.

## Ranking/Pivot Gap Analysis

Full pre-change audit: `stage5_m101_ranking_pivot_gap_analysis.md` +
`stage5_m101_ranking_pivot_gap_audit.json` (script
`run_stage5_m101_ranking_pivot_gap_audit.ts`, read-only rebuild).

- 11 wrong_pivot cases; in **all 11** the gold source file is already in the
  capsule (top-5 read order) as support — required-target failure, not recall.
- 24 addressable cases (source gold in capsule, non-gold lead): gold is the
  2nd pivot in 9 (near-tied "twin" candidates), support in 15.
- Wrong lead type: `wrong_source` 24/24. Zero test/docs/facade/generic-infra
  leads → Families B and C rejected for zero coverage.
- Gold demotion mechanism (15 support cases): pivot-cap eviction 12,
  dispatcher demotion 3. Five of these carry tier-2 anchors (all dev);
  five entered via the WEAK direct-evidence lane (out of scope by design);
  the rest are plain-lexical ambiguity.
- Chosen intervention: the anchored-target guard (Family A lead-eligibility +
  Family E required-target refinement as one coherence fix). Family D
  (evidence-vector rescoring) deferred — the twin-pivot ambiguity it targets
  is not separable gold-blind at this budget.

## Implementation

- **Files changed**: `src/capsuleV2/debugRoles.ts` (namedAnchors option;
  dispatcher exemption; bounded cap exemption in `capPivots`),
  `src/capsuleV2/buildCapsuleV2.ts` (anchor-id union; exempted pivot ordered
  last; support-slot conversion; diagnostics), `src/capsuleV2/types.ts`
  (diagnostics fields), `src/capsuleV2/debugRoles.test.ts` (5 new tests).
  New benchmark scripts: `run_stage5_m101_ranking_pivot_gap_audit.ts`,
  `run_stage5_m101_deterministic_scoreboard.ts`.
- **Support-only lead guard**: co-edit / file-evidence / graph-neighbour
  entries never enter the pivot role (unchanged, test-pinned); weak-direct
  candidates still order by pre-boost organic final and are not in the anchor
  set; the cap-exempted pivot sorts last among pivots, so a beyond-cap
  candidate can never become the lead.
- **Source/test/docs/facade behaviour**: unchanged. Tests and
  non-anchor-actionable kinds never qualify for either exemption; the
  non-source-example demotion still runs downstream of the guard.
- **Why general**: the guard consumes only the task-derived anchor id sets the
  builder already computes; no paths, repos, instance ids, or thresholds tuned
  to a benchmark case. It fires on 17/99 capsules including 7 holdout capsules
  (where it changed nothing gold-relevant — evidence it is not fitted to dev).
- **Why not gold leakage**: anchors are extracted from the ISSUE text and
  resolved against the index; gold labels touch only the scoreboard.
- **Tests added**: anchored cap-evictee keeps pivot (bounded to one);
  exemption refused for tests / module-level kinds / micro tier / base-gate
  support; weak-direct cap-evictee still cannot claim a slot; anchored
  dispatcher keeps pivot while unanchored is still demoted; guard inert when
  no anchor lane fired (admindocs capsule unchanged).

## Deterministic Scoreboard Delta (M100 → M101)

| cohort | lead=src-gold | gold-in-required | wrong_pivot | r@1 | r@5 | any-gold | all-gold | hidden | mean files | med/p90 tok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all (99) | 51.5→**54.5%** | 60.6→**64.6%** | 11→**8** | .503→**.529** | .730→.730 | 75.8→75.8% | 72.7→72.7% | .622→.622 | 3.949→3.980 | 1152→1178 / 3536→4046 |
| dev (60) | 56.7→**61.7%** | 65.0→**71.7%** | 8→**5** | .547→**.589** | .813→.813 | 85.0→85.0% | 81.7→81.7% | .778→.778 | 3.967→3.967 | 917→917 / 2843→3188 |
| holdout (39) | 43.6→43.6% | 53.8→53.8% | 3→3 | .436→.436 | .603→.603 | 61.5→61.5% | 59.0→59.0% | 0→0 | 3.923→4.000 | 1484→1401 / 6325→**5083** |
| M100 wrong_pivot (11) | 0→9.1% | 0→**27.3%** | 11→8 | 0→.091 | .909→.909 | 100→100% | 90.9→90.9% | .80→.80 | 4.455→4.364 | 546→509 |
| M100 source-gold-available (24) | 0→**12.5%** | 37.5→**54.2%** | 11→8 | 0→.104 | .906→.906 | 100→100% | 87.5→87.5% | .815→.815 | 4.708→4.667 | 1032→1192 |
| multi-file (15) | 13.3→**20.0%** | 40.0→46.7% | 5→4 | .056→.089 | .550→.550 | 73.3% | 53.3→**53.3%** | .622→.622 | 4.333→4.333 | 1194→1530 |

Outcome flips (all four positive, all dev): astropy-14369 wrong_pivot→good,
astropy-7166 wrong_pivot→good, xarray-6599 wrong_pivot→excellent,
xarray-6938 good→excellent. By-repo: astropy lead 40→60%, xarray lead
33→67%, django gold-in-required 70.5→75.0%; no repo regressed on any gold
metric (`stage5_m101_deterministic_by_repo.csv`).

## Pivot Evidence Analysis

- **Lead changes (3, all gained gold, none lost)**: django-11206
  `utils/formats.py` → `utils/numberformat.py::format` (strong direct
  evidence, dispatcher exemption), xarray-6599 `coordinates.py` →
  `computation.py::polyval` (title+literal anchor, dispatcher exemption),
  xarray-6938 `dataarray.py` → `dataset.py` (dispatcher exemption).
- **Guard activity**: fired 17/99 (dev 10: 7 cap + 5 dispatcher; holdout 7:
  7 cap + 2 dispatcher). Holdout firings were gold-neutral (promoted anchored
  non-gold candidates in miss-class cases; no metric moved).
- **Prevented-from-lead accounting**: cap-exempted pivots are ordered last by
  construction — 14 support-only-style lead preventions; facade/test/docs
  lead preventions n/a (0 such leads existed pre-change).
- **Required-target changes**: mean required targets 1.475→1.626 (+0.15),
  mean optional 2.475→2.354 (−0.12) — the slot conversion, not growth;
  gold_file_in_required 60.6→64.6%.
- **Regressions**: none observed — no lead lost gold, no all-gold flip, no
  outcome downgraded, holdout gold metrics byte-identical.

## Capsule/Token Impact

- Median tokens 1152→1178 (+26); p90 3536→4046 all-scored (promoted pivots
  render focused source instead of a signature), while holdout p90 fell
  6325→5083; budget ceiling (8000) never exceeded.
- Mean capsule files 3.949→3.980 (+0.031 ≤ 0.1 gate); median 4→4.
- Overpacked count 14→14 (the support-slot conversion keeps the item budget
  at the tier cap; without it a first cut measured 14→16, which motivated the
  conversion).

## Retrieval Eval Compatibility

Stash A/B proof (pre-change vs post-change, identical fixtures, temp dirs —
this milestone intentionally changes capsule output, so a no-change byte-diff
does not apply):

- django expanded (20): top-1 **80% → 85%**, top-3 100% → 100%, pivot
  **95% → 100%**, missing 0% → 0% (django-11206 hit_top3 → hit_top1_pivot).
- cross_repo 30: top-1 66.7% flat, top-3 80% flat, pivot **73.3% → 76.7%**,
  missing 13.3% flat (astropy-14369 gold row support → pivot).
- No regressed row in either fixture. Canonical baselines + freshness meta
  refreshed per the meta-file protocol in the follow-up commit.

## Remaining Failure Modes

- wrong_pivot (8): five golds reachable only through the WEAK direct-evidence
  lane (astropy-14598-class; promoting them would breach the M96 "weak cannot
  claim slots" invariant — a candidate for a separate, carefully-gated
  refinement), and plain-lexical golds (django-13512/15503/15731/16256)
  indistinguishable gold-blind from the lead. xarray-6992's single exemption
  slot went to a competing anchored candidate (`drop_coords` over gold
  `_id_coord_names`).
- miss (24, unchanged): lexical_mismatch dominates — **task derivation is now
  the binding constraint** (M100 standing finding; 13 absent golds carry exact
  evidence only beyond the 360-char derived task). Parser/language coverage is
  not the bottleneck on this benchmark.

## Success Criteria Check

| # | criterion | result |
| --- | --- | --- |
| 1 | holdout lead +3pts OR all-scored wrong_pivot −3 | **PASS** (wrong_pivot 11→8) |
| 2 | holdout any_gold no drop | PASS (61.5% flat) |
| 3 | holdout all_gold drop ≤ 2pts | PASS (59.0% flat) |
| 4 | holdout recall@1 drop ≤ 2pts | PASS (0.436 flat) |
| 5 | holdout recall@5 no drop | PASS (0.603 flat) |
| 6 | multi-file all_gold ≥ 53.3% | PASS (53.3%) |
| 7 | hidden_coedit_recall ≥ 0.622 | PASS (0.622) |
| 8 | mean capsule files +≤0.1 | PASS (+0.031) |
| 9 | overpacked not increased | PASS (14→14) |
| 10 | retrieval evals no material regression | PASS (both improved) |
| 11 | no support-only lane steals lead | PASS (design + tests; exempted pivot ordered last) |
| 12 | no broad heuristic regressions | PASS (0 metric drops anywhere) |
| 13 | no gold leakage | PASS (anchors are task-derived only) |
| 14 | tests/typechecks | PASS (3498 tests, both tsc configs) |
| 15 | no live agents / Docker / API spend | PASS |

## Verdict

**PASS**

## Recommendation

**Proceed to task-derivation audit.** Pool recall (M100) and the mechanical
ranking/pivot coherence gap (this milestone) are both shipped; the remaining
deterministic headroom is concentrated in the 24 lexical-mismatch misses whose
evidence lives beyond the 360-char derived task, which re-baselines every lane
and needs its own controlled milestone.
