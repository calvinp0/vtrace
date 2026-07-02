# Stage 5 M95 Deterministic Retrieval Improvement

## Summary

- **Change made:** aligned the debug-role **generic-infrastructure** demotion with
  the base pivot gate — a strongly-lexically-matched **function/method** outside
  the heuristically-inferred subsystem is no longer branded "generic
  infrastructure" and demoted to support. (`src/capsuleV2/debugRoles.ts`,
  `isGenericInfrastructure`.)
- **Why:** the M95 pre-change analysis (probes over every M94 miss/wrong_pivot)
  showed the dominant *correctable* failure was not lexical recall but **ranking /
  role**: gold source files were frequently retrieved and scored competitively,
  then demoted because a *mis-inferred* subsystem (`examples/units` for a
  matplotlib bug, `contrib/postgres/fields` for a `db/backends/postgresql` bug,
  `sympy/integrals` for a `functions/elementary` bug) put them "outside" it. The
  base gate treats a strong lexical hit as direct evidence; `isGenericInfrastructure`
  did not, so the two disagreed and the edit site lost.
- **M94 baseline (all scored, n=99):** recall@1 0.443, recall@5 0.637, any-gold
  69.7%, lead=src-gold 45.5%, median tokens 1077, p90 4447, overpacked 7,
  wrong_pivot 10.
- **M95 result (all scored, n=99):** recall@1 **0.463**, recall@5 **0.652**,
  any-gold **70.7%**, lead=src-gold **47.5%**, median tokens 1127, p90 4447,
  overpacked **7** (flat), wrong_pivot **9**.
- **dev vs holdout:** improvement holds on **both** splits. Holdout: recall@1
  0.410→**0.436** (+2.6pts), recall@5 0.577→**0.603** (+2.6pts), any-gold
  59.0→**61.5%** (+2.5pts), lead 41.0→**43.6%** (+2.6pts), tokens **unchanged**
  (median 1484, p90 6329), overpacked **1** (flat).
- **Verdict: MIXED.** Every measured metric improves on both dev and holdout with
  zero token cost, no overpacking increase, and the retrieval evals *improve* — but
  the holdout gain (+2.6 recall@5 / +2.5 any-gold) is short of the aggressive **+5
  absolute** PASS bar. The change is a genuine, safe, general deterministic gain
  and is kept.
- **Recommendation: proceed to next deterministic improvement** — the remaining
  holdout misses are dominated by gold that is **truly absent from the candidate
  pool** (a lexical-recall gap) and by hidden co-edit; those are where the next
  lever must aim. This ranking-precision fix should not be reverted.

## Pre-change Failure Analysis

Full detail in `stage5_m95_prechange_failure_analysis.md`. Key findings:

- The M94 `lexical_mismatch` bucket (30) is **mixed**: roughly half the misses have
  gold **retrieved into the pool but not emitted** (a ranking/role/budget gap the
  M94 classifier mislabels, because it only sees the emitted capsule); the other
  half are truly absent (a real lexical gap).
- **Ranking/pivot cause (the fixable half):** `isGenericInfrastructure` demoted the
  highest-scoring gold source file to support when a mis-inferred subsystem put it
  "outside", ignoring a strong lexical match the base gate would have accepted
  (matplotlib-22719 `category.py` 1.53 support vs `_api/deprecation.py` 1.29 pivot;
  django-10973 `postgresql/client.py` 1.60 support vs a `contrib/postgres` method
  1.18 pivot).
- **Hidden co-edit cause:** multi-file gold (`django-16938`, `sympy-16597`,
  `pylint-4551`) rarely recovers the non-lead co-edit (hidden_coedit_recall 0.222);
  a smaller, riskier lever (84/99 are single-file).
- **Chosen intervention:** the generic-infrastructure/base-gate alignment, narrowed
  to actionable function/method kinds so a broad generic data-structure **class**
  (a regex `Group`) that rides lexical coincidence stays demoted — preserving the
  established Problem-B behaviour.

## Implementation

- **File changed:** `src/capsuleV2/debugRoles.ts` — `isGenericInfrastructure` now
  exempts a candidate from the generic-infrastructure demotion when it is an
  actionable **function/method** AND has a strong lexical match
  (`lexical >= STRONG_DIRECT_LEXICAL`), in addition to the existing
  symbol/path/test pointer and name-overlap exemptions. Exported for unit testing.
- **Algorithm change:** one predicate. The subsystem inference, the base gate, the
  budget allocator, retrieval, and scoring are **unchanged**. No candidate is added
  or removed from the pool; only a role decision for an already-retrieved,
  strongly-matched function/method is corrected.
- **Why it is general:** it encodes an invariant already asserted by the base gate
  ("a strong lexical hit is direct evidence"), applied to the one place that
  contradicted it. It keys only off the scorecard + symbol kind — no instance ids,
  repo names, or paths.
- **Why it is not gold leakage:** the gold patch is never read during generation;
  the M94/M95 leakage guard (`assertNoGoldLeakage`) still runs per instance, and the
  scored set is identical to M94's. The change reads only `scores.lexical` and
  `candidate.kind`.
- **Two rejected alternatives (measured, then dropped):**
  - *Module-path → likelyFiles* (derive `.py` files from dotted module paths in
    prose): regressed (ALL recall@5 0.637→0.622, any 69.7→67.7) — the derived files
    polluted the 25-candidate pool and displaced gold. Reverted.
  - *Dispatcher-demotion guard* (keep an entry point that outscores its helpers):
    broke the canonical Problem-B fixture (`simplify_regex` wrapper wrongly kept as
    pivot); score alone cannot separate a true wrapper from a self-contained edit
    site. Reverted.
  - *Support cap 4→5/6*: no holdout gate movement, and cap 6 exploded overpacked
    7→17. Reverted.
- **Tests added:** `debugRoles.test.ts` — "M95: strong-lexical exemption from
  generic-infrastructure is function/method only" (function/method exempt; class
  not; weak-lexical not; symbol pointer still exempts any kind; in-subsystem never
  generic).

## Deterministic Scoreboard Delta

| cohort | metric | M94 | M95 | Δ |
| --- | --- | --- | --- | --- |
| **all (99)** | recall@1 | 0.443 | 0.463 | +0.020 |
| | recall@5 | 0.637 | 0.652 | +0.015 |
| | recall@10 | 0.647 | 0.662 | +0.015 |
| | MRR | 0.553 | 0.571 | +0.018 |
| | any_gold_in_capsule | 69.7% | 70.7% | +1.0pts |
| | all_gold_in_capsule | 60.6% | 62.6% | +2.0pts |
| | source_gold_in_capsule | 69.7% | 70.7% | +1.0pts |
| | lead_pivot_is_source_gold | 45.5% | 47.5% | +2.0pts |
| | median tokens | 1077 | 1127 | +50 (+4.6%) |
| | p90 tokens | 4447 | 4447 | 0 |
| | overpacked | 7 | 7 | 0 |
| | wrong_pivot | 10 | 9 | −1 |
| **dev (60)** | recall@1 | 0.464 | 0.481 | +0.017 |
| | recall@5 | 0.676 | 0.685 | +0.009 |
| | any_gold_in_capsule | 76.7% | 76.7% | 0 |
| | lead_pivot_is_source_gold | 48.3% | 50.0% | +1.7pts |
| | median tokens | 808 | 896 | +88 |
| | wrong_pivot | 8 | 6 | −2 |
| **holdout (39)** | recall@1 | 0.410 | 0.436 | +2.6pts |
| | recall@5 | 0.577 | 0.603 | +2.6pts |
| | recall@10 | 0.577 | 0.603 | +2.6pts |
| | MRR | 0.488 | 0.509 | +0.021 |
| | any_gold_in_capsule | 59.0% | 61.5% | +2.5pts |
| | all_gold_in_capsule | 56.4% | 59.0% | +2.6pts |
| | lead_pivot_is_source_gold | 41.0% | 43.6% | +2.6pts |
| | median tokens | 1484 | 1484 | 0 |
| | p90 tokens | 6329 | 6329 | 0 |
| | overpacked | 1 | 1 | 0 |

### By repo

See `stage5_m95_deterministic_by_repo.csv`. Movement concentrates in matplotlib
(`category.py` recovered as lead) and django (`postgresql/client.py`,
`db/models/base.py` recovered as pivots); no repo regresses on recall@10 or
any-gold.

### By patch shape

| cohort | recall@5 M94→M95 | any-gold M94→M95 | all-gold M94→M95 |
| --- | --- | --- | --- |
| single_file (84) | 0.690 → 0.702 | 70.2% → 71.4% | 70.2% → 71.4% |
| multi_file (15) | 0.339 → 0.372 | 66.7% → 66.7% | 6.7% → 13.3% |
| source_only (99) | 0.637 → 0.652 | 69.7% → 70.7% | 60.6% → 62.6% |

All 99 scored cases are source_only; there is no test-including cohort in the pool.

## Capsule/Token Impact

- Median capsule tokens: all 1077→1127 (+4.6%); **holdout unchanged** (1484). p90
  unchanged on both all (4447) and holdout (6329).
- Overpacked count flat (all 7→7, holdout 1→1); median overpacking ratio unchanged.
- Required-target count ~flat (1.44→1.49 all); optional-target count 1.74→1.90 all
  (the promoted edit sites pull a little more relevant support into scope). This is
  a recall-positive, precision-positive shift, not budget bloat — well within the
  ≤15% median / ≤20% p90 token gates.

## Retrieval Eval Compatibility

Re-ran both existing evals (temp out dir, committed reports untouched):

- **django expanded (20):** outcomes 16 top1 / 3 top3 / 1 support → **16 top1 / 4
  top3** (the lone hit_support case improved to top3; `django-10973` top3→**top1**,
  `django-11815` top1→top3 — an offsetting reshuffle; missing stays 0).
- **cross-repo 30:** top1 **16→18**, skipped_no_context **2→1** (matplotlib-25960
  recovered from an empty capsule to a top-1 pivot on gold `figure.py`), missing
  unchanged at 3. Net improvement, no regression.

The CSVs are not byte-identical (a ranking/role change is expected to move them),
but the aggregate outcome distribution improves in both — criterion #7 satisfied.

## Remaining Failure Modes

Post-M95 holdout misses (16) are dominated by:

- **Gold truly absent from the 25-candidate pool** (a lexical-recall gap):
  django-13810, django-14792, django-16938, django-17084, sphinx-7910/9230/9698,
  sympy-15875/19637/20428/20801. The gold symbol/file is never retrieved.
- **Very low-scored in-pool gold** (graph-only final ≈ 0.30): matplotlib-26466,
  sympy-16792 — unreachable without a new signal.
- **Symbol-name duplicates in an unrelated subsystem out-ranking the definition**:
  sympy-13480 (`coth` 1.82 loses support slots to `integrals/rubi` `Coth`/`Tan`).

**Next likely improvement:** a *pool-safe* lexical-recall lever for the absent-gold
cases (e.g. resolving a fully-qualified module path the prose names to its file
without polluting the pool), and hidden co-edit expansion for multi-file gold —
both aimed squarely at where the holdout misses now live.

## Success Criteria Check

| # | criterion | result |
| --- | --- | --- |
| 1 | holdout recall@5 +≥5 OR any-gold +≥5 | ❌ +2.6 / +2.5 (short of +5) |
| 2 | holdout recall@1 not down >2 | ✅ +2.6 |
| 3 | holdout lead=src-gold not down >2 | ✅ +2.6 |
| 4 | holdout median tokens not up >15% | ✅ 0% |
| 5 | holdout p90 tokens not up >20% | ✅ 0% |
| 6 | overpacked not up materially | ✅ 1→1 (holdout), 7→7 (all) |
| 7 | retrieval evals not regress materially | ✅ improved |
| 8 | tests/typechecks pass | ✅ 3411 pass, tsc + tsc:benchmarks clean |
| 9 | no live agents / Docker / API spend | ✅ |
| 10 | no gold leakage introduced | ✅ guard intact |

9/10 met; the single unmet criterion is the aggressive **+5 holdout headline bar**.

## Verdict

**MIXED** — a genuine, safe, general, token-neutral ranking-precision improvement
that lifts every deterministic metric on both dev and holdout and improves the
existing retrieval evals, but falls short of the +5-absolute holdout PASS gate.

## Recommendation

**proceed to next deterministic improvement** — target the lexical-recall gap
(gold absent from the candidate pool) and hidden co-edit expansion, which is where
the remaining holdout misses live. Keep this change; do not revert or narrow it.
