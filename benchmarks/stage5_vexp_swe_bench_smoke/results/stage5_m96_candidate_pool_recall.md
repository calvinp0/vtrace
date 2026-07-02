# Stage 5 M96 Candidate-Pool Recall Improvement

_Deterministic, offline. No live agents, no Docker, no Codex, no API spend, no
Conda mutation. Gold patches label evaluation only — never fed into retrieval or
capsule generation._

## Summary

- **Change made:** a new **direct-evidence candidate lane**
  (`src/capsuleV2/directEvidenceAnchoring.ts`, wired in `buildCapsuleV2`).
  It extracts exact code mentions from the issue-derived task — dotted module
  paths (`utils.numberformat.format`), explicit `x.py` tokens, mid-sentence
  capitalized class words (`Count`), mixed-case identifiers (`kernS`), and bare
  file-stem words (`autoreload`, `inspectdb`) — resolves each against the
  **index** with tight ambiguity caps and a generic-word stoplist, then
  **injects** missing candidates into the pool and **boosts** in-pool candidates
  the issue names. Strong (file-resolved) mentions are anchor-grade; weak
  (stem/word) mentions compete for budget but **order by their organic
  (pre-boost) final**, so they can fill an empty capsule or a free slot but can
  never steal the lead from multi-signal retrieval.
- **Why:** the pre-change gap audit
  (`stage5_m96_candidate_pool_gap_analysis.md`) showed the dominant remaining
  M95 failure is gold **truly absent from the 25-candidate pool** (dev 16/28
  gold files; holdout 17/25), plus in-pool gold squeezed out by the standard
  tier's 2-pivot/4-support budget — and that the recoverable signal lives in
  exactly these mention shapes, which no existing lane (title-symbol, literal,
  line-anchor) resolves.
- **M95 baseline (all, n=99):** recall@1 0.463, recall@5 0.652, recall@10
  0.662, any-gold 70.7%, lead=src-gold 47.5%, median tokens 1127, p90 4447,
  overpacked 7.
- **M96 result (all, n=99):** recall@1 **0.503**, recall@5 **0.706**, recall@10
  **0.706**, any-gold **75.8%**, lead=src-gold **51.5%**, median tokens 1152
  (+2.2%), p90 **3536** (−20%), overpacked 11.
- **dev vs holdout:** the gains are **dev-concentrated**. Dev: recall@1
  0.481→**0.547** (+6.6pts), recall@5 0.685→**0.774** (+8.9pts), any-gold
  76.7→**85.0%** (+8.3pts), lead 50.0→**56.7%** (+6.7pts). Holdout: every
  headline metric is **exactly flat** (one gain — sympy-19637 miss→excellent via
  the `kernS` mixed-case mention — offset by one loss, sphinx excellent→miss
  from support-budget displacement, plus one good→overpacked).
- **Verdict: MIXED** — large, real, token-cheap dev gains and improved
  retrieval evals, with a theft-proof ordering design; but the holdout aggregate
  does not move, and absent-gold holdout recovery (+8.3pts) falls short of the
  +10pt gate.
- **Recommendation: proceed to hidden co-edit expansion.** The audit shows the
  remaining holdout absent-gold misses carry **no exact low-ambiguity mention at
  all** (0/12 resolvable before this lane; 1/12 after) — the issue-text lane
  family is now mined out. Multi-file all-gold remains ≤7% and
  hidden_coedit_recall 0.256; co-edit structure is the next lever.

## Candidate-Pool Gap Analysis

Full detail in `stage5_m96_candidate_pool_gap_analysis.md` (written before any
implementation) and `stage5_m96_candidate_pool_gap_audit.json`
(`run_stage5_m96_candidate_pool_gap_audit.ts`, re-run against the M95 code).

- **Absent gold** dominates: dev 16/28 gold files (11/20 miss cases), holdout
  17/25 (12/18). **Present-but-demoted**: 4 dev gold files were retrieved and
  discarded "beyond standard support budget (max 4)" (django-15037 `inspectdb.py`
  1.51, django-16333 `UserCreationForm` 1.72, matplotlib-24870 `contour.py`
  1.71, psf-1724 `sessions.py` 1.27). **In-capsule wrong-lead**: 8 dev gold
  files sat in the capsule of a wrong_pivot case.
- **Issue-text mention audit** (dev): gold-hitting low-ambiguity mentions are
  bare file stems (10), quoted/backticked identifiers (3), dotted module paths
  (2), unique class words (2), exact symbol names (2). The 360-char derived task
  rarely carries a full path (the leakage guard excludes those cases anyway).
- **Why module-path → likelyFiles was rejected (M95):** it pushed derived,
  unverified path strings into the fuzzy query-side `pathMatchRaw` signal,
  rescoring the whole pool and displacing gold (ALL recall@5 0.637→0.622). The
  M96 lane inverts this: mentions are resolved against the index first (exact,
  ambiguity-capped) and the effect is per-symbol bounded injection/boost — the
  query and its scoring signals are untouched.
- **Chosen intervention:** the two-tier direct-evidence lane described above.

## Implementation

- **Files changed:**
  - `src/capsuleV2/directEvidenceAnchoring.ts` (new) — extraction, index
    resolution, caps, candidate construction, boost helper.
  - `src/capsuleV2/buildCapsuleV2.ts` — lane invocation after the title/literal
    anchors (line anchors still merge ahead), inject/boost split, weak-ordering
    metadata, strong ids joined to the anchor evidence tier, diagnostics.
  - `src/capsuleV2/debugRoles.ts` — `capPivots` orders weak-lane candidates by
    organic final (new `weakDirectEvidence` refinement option).
  - `src/capsuleV2/types.ts` — `direct_evidence_*` diagnostics fields.
  - `benchmarks/.../run_stage5_m96_candidate_pool_gap_audit.ts`,
    `run_stage5_m96_deterministic_scoreboard.ts` (new benchmark helpers).
- **Algorithm:** extract mentions (URLs stripped) → resolve against indexed
  files/symbols only → strong tier (dotted path whose ≥2-segment prefix names ≤2
  indexed files, with symbol drill; explicit `.py` token matching ≤3 non-test
  files) enters at final 2.5 with a path pointer, anchor-grade; weak tier
  (mid-sentence class word matching ≤5 indexed classes; mixed-case identifier
  ≤5; file stem ≥4 chars matching ≤2 non-test basenames, else a top-level
  function/class name ≥5 chars matching ≤2) enters at final 1.9 with a symbol
  pointer. In-pool candidates the mentions name are boosted
  (final floored at tier, pointer added, evidence line appended) instead of
  re-injected.
- **Ambiguity/generic filtering:** per-shape exact-match caps (above); a
  generic stoplist = the milestone's suggested list ∪ query-shaping
  `GENERIC_TOKEN_STOPLIST` ∪ the generic-infrastructure decoy tokens (so the
  lane can never re-arm a decoy the suppressor weakened — e.g. `deprecation` →
  `deprecation.py`) ∪ language/packaging words; package `__init__.py`
  resolutions require the drill symbol to resolve (a bare package name or a
  re-export is not an edit-file pointer); exception names excluded; runner
  scripts and ubiquitous basenames excluded.
- **Caps:** ≤3 file mentions, ≤2 symbols per resolved file, ≤5 weak candidates,
  ≤8 total per task; pool size unchanged at 25.
- **The no-lead-theft rule (the design's core):** weak-lane candidates order by
  their **organic (pre-boost) final** in every pivot-ordering site (`capPivots`,
  the anchor-tier sort, the pivot-ranking-v2 sort). A fresh injection (organic
  0) sorts behind every organically-evidenced pivot; a boosted incumbent keeps
  exactly the rank its own evidence earned. The boosted final buys only budget
  competition (support slots, free pivot slots). Two intermediate designs — a
  max-bar ceiling and a min-bar ceiling — were measured on dev and discarded
  (the first still allowed lead theft after refinement demotions; the second
  killed the recall wins).
- **Why it is general:** every rule keys off mention shape, index content, and
  ambiguity counts — no instance ids, repo names, paths, or benchmark-specific
  vocabulary. The stoplist is generic vocabulary, not repo terms.
- **Why it is not gold leakage:** the lane reads only the task text and the
  index; gold is never available to generation, `assertNoGoldLeakage` still
  blocks tasks carrying a gold path, and the scored set is identical to
  M94/M95's.
- **Tests added:** `src/capsuleV2/directEvidenceAnchoring.test.ts` — 15 tests:
  extraction per shape (incl. URL/self/generic/exception/runner rejection),
  dotted resolution + drill-must-resolve, basename/stem/class-word resolution,
  ambiguity rejection, caps + determinism, capsule recovery integration, the
  no-lead-theft guarantee, weak-leads-only-when-nothing-organic, and
  strong-tier scoring/evidence.

## Deterministic Scoreboard Delta

Full tables in `stage5_m96_deterministic_scoreboard.md`; M95 is the primary
baseline (M94 headline: recall@5 0.637, any 69.7%, recall@1 0.443, lead 45.5%).

| cohort | metric | M95 | M96 | Δ |
| --- | --- | --- | --- | --- |
| **all (99)** | recall@1 | 0.463 | 0.503 | **+0.040** |
| | recall@3 | 0.622 | 0.646 | +0.024 |
| | recall@5 | 0.652 | 0.706 | **+0.054** |
| | recall@10 | 0.662 | 0.706 | +0.044 |
| | MRR | 0.571 | 0.609 | +0.038 |
| | any_gold_in_capsule | 70.7% | 75.8% | **+5.1pts** |
| | all_gold_in_capsule | 62.6% | 65.7% | +3.1pts |
| | source_gold_in_capsule | 70.7% | 75.8% | +5.1pts |
| | lead_pivot_is_source_gold | 47.5% | 51.5% | **+4.0pts** |
| | hidden_coedit_recall | 0.222 | 0.256 | +0.034 |
| | median tokens | 1127 | 1152 | +25 (+2.2%) |
| | p90 tokens | 4447 | 3536 | **−911 (−20%)** |
| | overpacked | 7 | 11 | +4 |
| | wrong_pivot | 9 | 12 | +3 |
| | miss | 29 | 24 | **−5** |
| **dev (60)** | recall@1 | 0.481 | 0.547 | **+6.6pts** |
| | recall@5 | 0.685 | 0.774 | **+8.9pts** |
| | recall@10 | 0.701 | 0.774 | +7.2pts |
| | any_gold_in_capsule | 76.7% | 85.0% | **+8.3pts** |
| | lead_pivot_is_source_gold | 50.0% | 56.7% | +6.7pts |
| | median tokens | 896 | 920 | +24 (+2.7%) |
| | p90 tokens | 3048 | 2843 | −205 |
| | overpacked | 6 | 9 | +3 |
| **holdout (39)** | recall@1 | 0.436 | 0.436 | 0 |
| | recall@3 | 0.577 | 0.577 | 0 |
| | recall@5 | 0.603 | 0.603 | 0 |
| | recall@10 | 0.603 | 0.603 | 0 |
| | MRR | 0.509 | 0.514 | +0.004 |
| | any_gold_in_capsule | 61.5% | 61.5% | 0 |
| | all_gold_in_capsule | 59.0% | 59.0% | 0 |
| | lead_pivot_is_source_gold | 43.6% | 43.6% | 0 |
| | median tokens | 1484 | 1484 | 0 |
| | p90 tokens | 6329 | 6329 | 0 |
| | overpacked | 1 | 2 | +1 |

### Absent-gold subset (cases whose gold was absent from the M95 pool)

| cohort | n | any_gold M95→M96 | recall@10 M95→M96 | med tokens |
| --- | --- | --- | --- | --- |
| all | 23 | 0.0% → **17.4%** | 0.000 → 0.152 | 724→787 |
| dev | 11 | 0.0% → **27.3%** | 0.000 → 0.227 | 649→649 |
| holdout | 12 | 0.0% → **8.3%** | 0.000 → 0.083 | 2337→2337 |

### By repo (recall@5 / any-gold / lead, M95→M96)

django 0.718→0.782 / 77.3→84.1% / 56.8→59.1%; sympy 0.588→0.647 (all three up);
matplotlib 0.429→0.500 / 42.9→57.1% / 28.6→42.9%; requests 0.333→0.667 (all
up); astropy r@5 0.700→0.900; flask lead 0→100%. **sphinx regresses**
(0.500→0.357 / 57.1→42.9% / 42.9→28.6%) — the single holdout loss; xarray,
pytest, pylint, sklearn, seaborn flat.

### By patch shape

single_file (84): r@5 0.702→0.762, any 71.4→76.2%. multi_file (15): r@5
0.372→0.394, any 66.7→**73.3%**, but all_gold 13.3→6.7% (one case lost a
co-edit file to support displacement); hidden_coedit_recall 0.222→0.256. All 99
scored cases are source_only; there is no test-including cohort.

### Dev case transitions (M95→M96)

Wins (10): psf-1921 miss→**excellent** (empty capsule → gold lead), django-16333
miss→good (dotted path, gold lead), django-10880 miss→wrong_pivot (gold
recovered via `Count`), django-15037 miss→wrong_pivot (`inspectdb` stems),
matplotlib-24870 miss→wrong_pivot (`contour`), astropy-14598 r@5 0→1 (`Card`),
django-11206 gold r@5 kept + numberformat promoted, django-13195 r@5 0.33→0.67,
django-11820 overpacked→good, flask-5014 lead gained (`Blueprint`).
Regressions (5): astropy-14369 partial→wrong_pivot (the issue genuinely names
non-gold `ascii.cds`), django-11749 & django-12325 & matplotlib-24627
good→overpacked (junk stems fill support slots; gold and lead retained —
24627 even gains the lead), django-16256 r@5 1.0→0.5 (a boosted stem displaced
the second gold file from support).

## Direct Evidence Lane Analysis

- **all (99):** mentions extracted on 99 cases; lane resolved something on 60
  (**gold hit on 31 = 52% of used**); 72 candidates injected + 46 boosted;
  86 non-gold matches (≈0.9/case); 13 ambiguous + 295 generic rejections.
- **dev (60):** used on 39, gold hit 23 (59%); types: file_stem 32, class_word
  7, dotted 5.
- **holdout (39):** used on 21, gold hit 8 (38%); types: file_stem 20,
  class_word 3, explicit_file 1, mixed_case 1.
- **False-positive behaviour:** non-gold matches are bounded (≤8/case cap) and,
  by the organic-ordering rule, can only consume support slots — the observed
  cost is the +4 overpacked labels and one support displacement (16256), not
  lead flips.

## Capsule/Token Impact

- Median capsule tokens: all 1127→1152 (+2.2%), dev 896→920 (+2.7%),
  **holdout unchanged** (1484). p90: all 4447→**3536 (−20%)**, holdout
  unchanged (6329).
- Overpacked: all 7→11 (+4: three dev cases where junk stems filled free
  support slots, one holdout), median overpacking ratio unchanged (3.0).
- Mean capsule file count 3.39→3.63; required targets 1.49→1.47 (flat);
  optional targets 1.90→2.15 (the injected/boosted files enter as optional).

## Retrieval Eval Compatibility

Both existing evals re-run to a temp dir (committed reports untouched):

- **django expanded (20):** top-3 file recall 0.95→**1.00**,
  expected-file-as-pivot 85%→**95%**, missing stays 0%; mean tokens
  1018→1097 (+7.7%).
- **cross-repo 30:** top-1 file accuracy 0.533→**0.667**, top-3 recall
  0.767→0.800, no_context 2→1, expected-file-discarded 6.7→3.3%, symbol hit
  50→56.7%; missing rate flat (13.3%); mean tokens 1981→1914 (−3.4%).

No regression on either fixture — both improve. (CSVs are intentionally not
byte-identical: this milestone changes candidate generation.)

## Remaining Failure Modes

- Post-M96 misses: 24 (from 29). The remaining holdout absent-gold misses
  (django-13810/14792/16938/17084, sphinx-7910/9230/9698,
  sympy-15875/20428/20801, pylint-4551/8898 on dev) carry **no exact
  low-ambiguity code mention** in the derived task — the issue-text mention
  family (title, literal, line-anchor, direct-evidence) is now exhausted for
  them; recovery needs a different signal (co-edit structure, test-to-impl
  routing, richer task derivation).
- **Hidden co-edit is now the clearest structured bottleneck**: multi-file
  all-gold ≤7%, hidden_coedit_recall 0.256; the lane's own wins (24870, 16938)
  recover the lead file but not its co-edit sibling.
- Overpacking from junk stems (+4) is the lane's main cost — a follow-up could
  bound weak injections to free support space once co-edit work lands.

## Success Criteria Check

| # | criterion | result |
| --- | --- | --- |
| 1 | holdout recall@10 +≥3 OR any-gold +≥3 OR absent-gold recovery +≥10 | ❌ 0 / 0 / +8.3pts |
| 2 | holdout recall@1 not down >2pts | ✅ 0 |
| 3 | holdout lead=src-gold not down >2pts | ✅ 0 |
| 4 | holdout median tokens not up >10% | ✅ 0% |
| 5 | holdout p90 tokens not up >15% | ✅ 0% |
| 6 | overpacked not up materially without larger recall gain | ✅⚠ +4 (all), against +5.1pts any-gold / +5.4pts recall@5 (all) |
| 7 | existing retrieval evals not materially regressed | ✅ both improve |
| 8 | no rejected broad module-path pollution reintroduced | ✅ index-resolved, per-symbol, capped |
| 9 | no gold leakage | ✅ guard intact; scored set identical |
| 10 | tests/typechecks pass | ✅ 3427 tests, tsc + tsc:benchmarks clean |
| 11 | no live agents / Docker / API spend | ✅ |

10/11 met; the unmet criterion is the holdout headline gate.

## Verdict

**MIXED** — the milestone's own MIXED definition ("dev improves but holdout
does not; recall improves with mild overpacking") describes this outcome
exactly. The change is real, general, theft-proof by construction, token-cheap
(holdout budget untouched, ALL p90 −20%), improves both retrieval evals, and
lifts every ALL/dev metric — but the 39-case holdout nets to zero (one absent
recovery exactly offset by one support-displacement loss).

## Recommendation

**Proceed to hidden co-edit expansion.** Keep this change: it clears 5 misses,
is the largest single-milestone ALL-cohort gain of the deterministic series,
and its remaining costs are support-slot noise, not ranking damage. The audit
proves the issue-text mention family is now mined out for the remaining
holdout misses; multi-file co-edit structure (hidden_coedit_recall 0.256,
multi-file all-gold ≤7%) is where the next deterministic recall lives.
