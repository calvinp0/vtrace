# Stage 5 M103 Structured Task Derivation

_Deterministic, offline milestone: no live agents, no Docker, no API spend, no
baselines re-run, no Conda mutation. Gold patches remain scoring-only._

## Summary

- **Change made**: the default Stage 5 deterministic task derivation is now
  `deriveStructuredTaskFromProblemStatement` (new shared module
  `stage5_task_derivation.ts`): the unchanged V0 base (title + first
  substantive prose sentence, word-safe 360-char cap) plus extracted
  **exception names (≤6) + failing-test ids (≤6) + capped traceback frames
  (≤8, head+tail)** as labelled evidence lines, whole sections trimmed under a
  1200-char total cap. `taskText` is **byte-identical to M102's winning
  V5_title_plus_errors variant** (verified by unit test AND by scoreboard
  parity). The leakage guard is now provenance-based.
- **Why**: M102 proved 50/100 cases hold gold evidence the prose-biased
  360-char derivation never sees, that longer raw prose is net-harmful, and
  that only the V5 shape is net-positive (holdout r@5 +3.8, lead +5.1,
  any-gold +5.2, with smaller capsules).
- **M101 baseline (99)**: r@1 .529, r@5 .730, any 75.8%, all 72.7%, lead
  54.5%, wp 8, miss 24, op 14, files 3.98, med tok 1178.
- **M102 V5 target (99)**: r@1 .564, r@5 .745, any 78.8%, all 74.7%, lead
  58.6%, wp 7, miss 21, op 14, files 3.88, med tok 1094.
- **M103 result (99-comparable)**: **identical to the V5 target on every
  aggregate — 0 parity mismatches** (outcome, lead pivot, task chars, per
  instance). 100-case new-policy set: r@1 .568, r@5 .748, any 79.0%, all
  75.0%, lead 59.0% (psf__requests-5414 newly scored `good`).
- **Verdict: PASS** (all 15 criteria met; see Success Criteria Check).
- **Recommendation: proceed to small live confirmation** (the deterministic
  chain M95–M103 has now shipped +8 lead pts / +4 any-gold pts over M94-era
  retrieval without a live run since M92; a small approved live slice would
  ground the deterministic wins).

## Implementation Plan

Plan (written before implementation, 12 audit questions answered):
`stage5_m103_structured_task_derivation_plan.md`.

- **Task derivation code path**: single shared module
  `stage5_task_derivation.ts`; the fixture builder re-exports the V0 helpers
  so all frozen M94–M102 runners keep byte-identical historical behavior.
- **Duplication**: none removed — there was one deterministic implementation;
  the live runner's separate `buildCapsuleV2Task` (full problem statement +
  FAIL_TO_PASS + hints) is a divergent live-side path, deliberately untouched
  (live-behavior change requires live validation; noted that it already
  carries FAIL_TO_PASS, which is benchmark-added evidence under the new
  taxonomy — a pre-existing live-side property).
- **Structured evidence fields**: `exceptions`, `failingTests`,
  `tracebackFrames`, `addedEvidence` (rendered lines), `taskText`, plus
  diagnostics (base/task chars, per-lane counts, `capped`, `omittedCounts`,
  `provenance: "issue_problem_statement"`).
- **Caps**: frozen to M102 V5 — exceptions 6, failing tests 6, traceback
  frames 8 (head+tail when over), 1200-char total cap with whole-section
  trimming (base never trimmed). Documented deviation from the "suggested"
  8/8/8+600: reproducing the measured winner byte-for-byte was the goal; every
  frozen cap is within the M103 hard bounds.
- **Provenance/leakage policy**: `assessGoldLeakage(task, problemStatement,
  gold)` in `stage5_m94_lib.ts` — a gold path in the task that the problem
  statement contains is `issue_authored_gold_path` (diagnostic, scored); a
  gold path the issue never contained is `gold_patch_leak` (still blocks).
  Legacy `assertNoGoldLeakage` kept verbatim for frozen runners.

## Implementation

- **Files changed**:
  - `stage5_task_derivation.ts` (new): V0 base moved verbatim +
    `deriveStructuredTaskFromProblemStatement` + extraction helpers.
  - `build_stage5_retrieval_fixture.ts`: re-exports V0 helpers; `buildGoldRow`
    now writes the structured `taskText` into fixtures (notes updated).
  - `stage5_m94_lib.ts`: added `assessGoldLeakage` (+ types).
  - `run_stage5_m103_deterministic_scoreboard.ts` (new): rebaseline runner.
  - `stage5_task_derivation.test.ts` (new, 10 tests).
  - Regenerated fixtures `retrieval_eval.django.expanded.json` (15 auto rows;
    5 manual rows preserved via `--base-fixture`) and
    `retrieval_eval.cross_repo.30.json` (30 rows) — `task`/`notes` fields only.
- **Algorithm**: base derivation unchanged; evidence extracted from the
  cleaned problem statement by the exact M102 V5 regexes (exception classes
  `\b[A-Z]\w*(Error|Exception|Warning)\b`; pytest node ids then bare
  `test_*` names; `File "…", line N` frames + final error line, 160-char
  line cap); exact-token dedupe, first-occurrence order; labelled lines
  `Errors: a | b`, `Failing tests: …`, `Traceback: …` appended under the base.
- **Diagnostics**: per-case task/base chars, per-lane included counts,
  over-cap omission counts, section-trim count, provenance tag; surfaced in
  the scoreboard detail rows and aggregates (mean exceptions .43 / tests .12 /
  frames .77 per case; 100-case task chars med 176 / p90 371).
- **Why it is not longer prose**: no prose window changed anywhere — the base
  is the same 360-char derivation and a long-prose statement without error
  evidence produces `taskText === baseTask` (unit-tested); evidence is
  extracted tokens/lines only, hard-capped at 1200 total.
- **Why it is not gold leakage**: single-parameter signature (problem
  statement only — structurally gold-blind, unit-tested); provenance recorded;
  `assessGoldLeakage` still BLOCKS any gold path the issue never contained.
- **Tests added**: base parity, V5 byte-equivalence (6 statement shapes incl.
  long-traceback trimming), exception/test/traceback extraction (dedupe, caps,
  ordering, generic-`test` rejection, 160-char truncation), formatting, no
  long-prose default, determinism + gold-blindness, issue-authored-path
  fixture (psf-5414 shape), gold-patch-leak still blocks. All existing suites
  pass unchanged (3520 tests).

## Scoreboard Rebaseline

Full tables: `stage5_m103_deterministic_scoreboard.md` (+ `.json`,
`.detail.json`, failure modes, by-repo CSV, top-misses CSV).

- **99-case comparable set** (M101-scored ids):

| metric | M101 | M102 V5 | M103 | Δ vs M101 |
| --- | --- | --- | --- | --- |
| recall@1 | .529 | .564 | **.564** | +.035 |
| recall@5 | .730 | .745 | **.745** | +.015 |
| MRR | .627 | .660 | **.660** | +.033 |
| any_gold_in_capsule | 75.8% | 78.8% | **78.8%** | +3.0 |
| all_gold_in_capsule | 72.7% | 74.7% | **74.7%** | +2.0 |
| lead_pivot_is_source_gold | 54.5% | 58.6% | **58.6%** | +4.1 |
| gold_file_in_required | 64.6% | 67.7% | **67.7%** | +3.1 |
| hidden_coedit_recall | .622 | .622 | **.622** | flat |
| multi_file_all_gold | 53.3% | 53.3% | **53.3%** | flat |
| wrong_pivot / miss / overpacked | 8 / 24 / 14 | 7 / 21 / 14 | **7 / 21 / 14** | −1 / −3 / flat |
| median / p90 capsule tokens | 1178 / 4046 | 1094 / 3712 | **1094 / 3712** | smaller |
| mean capsule files | 3.980 | 3.879 | **3.879** | −0.101 |

- **100-case new-policy set** (adds psf__requests-5414, scored `good`):
  r@1 .568, r@5 .748, any 79.0%, all 75.0%, lead 59.0%, wp 7, miss 21, op 14,
  files 3.88; holdout(40): r@1 .500, r@5 .650, any 67.5%, lead 50.0%.
- **Dev (60)**: r@1 .589→.614, r@5 .813 flat, any 85.0→86.7%, all 81.7→83.3%,
  lead 61.7→65.0%, miss 9→8, op 11 flat.
- **Holdout (39)**: r@1 .436→**.487**, r@5 .603→**.641** (+3.8pts), any
  61.5→**66.7%** (+5.2pts), all 59.0→61.5%, lead 43.6→**48.7%** (+5.1pts),
  wp 3→2, miss 15→13, op 3 flat.
- **Evidence-beyond-V0 cohort (50)**: any 74→80%, all 74→78%, lead 58→64%,
  miss 13→10 — the gains sit exactly where M102 said the lost evidence was.
  **No-evidence cohort (49)**: everything flat except r@1 .510→.531 and
  smaller capsules (files 4.16→3.98) — no collateral damage.
- **By repo** (`stage5_m103_deterministic_by_repo.csv`, comparable set):
  gains — sympy r@5 .647→.706 and lead 41.2→58.8%, requests r@5/lead
  .667→1.000, sphinx lead 28.6→42.9%, django r@5 .801→.813; localized
  regressions — xarray r@5 1.000→.833 (the xarray-4695 guard case) and
  matplotlib lead .429→.286 (the matplotlib-22719 guard case); all other
  repos byte-flat.
- Outcome flips vs M101: 5 up (13012 good→excellent, requests-1724
  miss→excellent, sphinx-7462 good→excellent, sympy-13372
  wrong_pivot→excellent, sympy-13480 miss→good), 1 down (django-13513
  excellent→good), 1 lateral (16938 miss→partial). All-gold flips: 2 gained,
  0 lost.

## M102 V5 Reproduction

**Exact**: 0 parity mismatches on outcome, lead pivot file, and task chars
across all 99 comparable instances (`v5_parity_mismatches: []`), and every
aggregate matches V5 to the fourth decimal. Expected, since the derivation is
byte-identical and `buildCapsuleV2` is deterministic — the parity check is the
proof the implementation introduced no drift.

## Leakage Guard / psf__requests-5414

- **Old behavior**: `assertNoGoldLeakage` blocked ANY gold path in the task →
  psf__requests-5414 permanently `leakage_blocked` (its issue's traceback
  names `requests/models.py`), M94–M101 scored 99/100.
- **New policy**: provenance-based `assessGoldLeakage` — issue-authored gold
  paths are evidence (scored, `issue_authored_gold_path` diagnostic);
  gold-patch-derived paths (in the task but NOT in the problem statement)
  still block. Protection against real contamination is not weakened; a unit
  test pins the blocking case.
- **Result**: 100/100 scored; psf__requests-5414 = **`good`** (lead pivot IS
  the gold `requests/models.py`, all gold in capsule, r@5 = 1.0; `good` not
  `excellent` only because the 4-file capsule has overpack ratio 4). 8 cases
  carry the `issue_authored_gold_path` diagnostic; **0** `gold_patch_leak`
  blocks fired.

## Regression Guard Cases

| case | M101 | M102 V5 | M103 | what changed / acceptability |
| --- | --- | --- | --- | --- |
| django-13513 [holdout] | excellent (lead `views/debug.py` = gold) | good | good (= V5) | Lead drifted to `views/generic/__init__.py`; ALL gold still in capsule, gold still in required, r@5 = 1.0. The one real lead regression; acceptable as the sole loss inside +5.1pts holdout lead. Mitigation path: facade lead demotion for `__init__.py` leads — M101 found test/docs/facade demotion had zero addressable coverage THEN; this is the first facade-lead case, revisit only if more appear. |
| matplotlib-22719 [dev] | overpacked (lead = gold `category.py`, gold in required) | overpacked (lead `units.py`, gold demoted to support) | overpacked (= V5) | Outcome class unchanged (already overpacked at M101); "Errors:" tokens pulled `units.py::ConversionError` ahead. Gold stays in capsule (r@5 = 1.0). Acceptable; real fix is the overpacking itself, not derivation. |
| xarray-4695 [dev] | overpacked (gold rank ≤5) | overpacked (gold left top-5, still in capsule) | overpacked (= V5) | r@5 1→0 but any/all-gold in capsule unchanged inside an already-overpacked 6-file capsule. Acceptable; same overpacking root cause. |

No new mitigation shipped for these (per M102: two are pre-existing
overpacked capsules; the derivation is not the lever). They are pinned in the
scoreboard's `regression_guard_cases` block for the next milestone to diff.

## Retrieval Eval Compatibility

- **Engine no-change proof**: with the OLD fixtures, both evals are
  **byte-identical** to the committed baselines (src/ untouched; baseline
  freshness verified: `git diff --stat 48379f1..HEAD -- src/` empty). All
  retrieval deltas below are attributable to the new fixture task text alone.
- **django expanded (20 rows, 5 manual + 15 regenerated)**: top-1 85→**90%**,
  top-3 100% flat, pivot 100% flat, missing 0% flat. Row change:
  django-11815 hit_top3→hit_top1_pivot.
- **cross-repo 30 (all regenerated)**: top-1 66.7→**73.3%**, top-3
  80→**83.3%**, pivot 76.7→**80%**, missing 13.3→**10%**. Row changes: 4 up
  (requests-1724 hit_discarded→hit_top1_pivot, pylint-8898
  skipped_no_context→hit_discarded, sphinx-7462 + sympy-13372
  hit_top3→hit_top1_pivot), 1 down (matplotlib-22719
  hit_top1_pivot→hit_top3 — the known guard case; gold stays top-3).
- **Baseline refresh files** (separate refresh commit, meta protocol):
  `retrieval_eval.django.expanded.json`, `retrieval_eval.cross_repo.30.json`,
  `stage5_retrieval_eval_expanded.{csv,json,md}`,
  `stage5_retrieval_eval_cross_repo_30.{csv,json,md}`,
  `stage5_retrieval_eval_baselines.meta.json`.
- No material regression: one row traded top-1→top-3 against five row-level
  improvements and four aggregate improvements.

## Token and Context Impact

- Task text (100-case): median 176 / p90 371 chars (99-comparable p90 392;
  V0 was 132 / 239) — ≈ +40 est tokens median, far under the 1200 cap.
- Capsules SHRANK: median tokens 1178→1094, p90 4046→3712, mean files
  3.980→3.879 (−0.101), median files 4 flat.
- Overpacked count 14 flat (dev 11 / holdout 3, unchanged).

## Success Criteria Check

1. V5-shaped default (base + exceptions + failing tests + capped traceback) — **PASS** (byte-identical to V5).
2. No longer/raw prose window default — **PASS** (unit-tested; base unchanged).
3. Comparable-set metrics reproduce M102 V5 — **PASS** (exact, 0 mismatches).
4. Holdout recall@5 ≥ +3 vs M101 — **PASS** (.603→.641, +3.8pts).
5. Holdout lead=src-gold ≥ +3 vs M101 — **PASS** (43.6→48.7%, +5.1pts).
6. Holdout any-gold improves vs M101 / no regress vs V5 — **PASS** (61.5→66.7%, = V5).
7. Overpacked not increased vs M101 — **PASS** (14→14).
8. Mean capsule files ≤ +0.1 vs M101 — **PASS** (−0.101).
9. Task p90 ≤ 1200, near V5's 392 — **PASS** (392 comparable / 371 new-policy).
10. Provenance guard distinguishes issue-authored vs gold-patch leak — **PASS** (implemented + tested; 8 diagnostics, 0 false blocks, blocking path pinned by test).
11. psf__requests-5414 scored — **PASS** (`good`; 100/100 coverage).
12. Retrieval evals no material regression — **PASS** (both improved; 1 known row tradeoff).
13. Regression-guard cases analyzed — **PASS** (section above + scoreboard block).
14. Tests/typechecks pass — **PASS** (3520 tests, both tsc, `git diff --check`).
15. No live agents / Docker / API spend / baselines / Conda — **PASS** (offline in-process only).

## Verdict

**PASS**

## Recommendation

**Proceed to small live confirmation** — the deterministic chain (M95–M103)
has accumulated holdout lead 43.6→48.7% and any-gold 61.5→66.7% without live
validation since M92; a small, explicitly-approved live slice (e.g. the
guarded 10-case protocol with env+shell guards) would ground the deterministic
wins before further tuning. (Alternative if live spend stays paused:
parser/language coverage improvement — `language_coverage_gap` remains a
standing failure reason.)
