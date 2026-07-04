# Stage 5 M102 Task-Derivation Evidence-Loss Audit

_Deterministic, offline, audit-only: no live agents, no Docker, no API spend,
no Conda mutation, and **no product behaviour change** — every variant is a
benchmark-only task string passed through `buildCapsuleV2`'s existing `task`
parameter. Gold patches are scoring-side only._

## Summary

- **Current derivation**: `deriveTaskFromProblemStatement` (benchmark-side,
  `build_stage5_retrieval_fixture.ts:101`) = title + first substantive *prose*
  sentence, word-safe 360-char cap. It is prose-biased by design: code lines,
  reproduction snippets and tracebacks are skipped even when they name the
  gold file.
- **Evidence loss is real**: 50/100 cases (17/32 M101 miss-class) carry gold
  evidence in the problem statement that the derived task never sees — mostly
  file identity (stems/basenames/path suffixes) and symbols, roughly half of
  it inside code blocks/tracebacks the derivation is structurally unable to
  include.
- **Variants tested**: V0_current, V1_720, V2_1200, V3_structured_lite,
  V4_full_problem, plus optional V5_title_plus_errors, V6_first_last,
  V7_compressed_literals — 8 variants × 99 M101-scored instances (V0 parity
  with M101: exact, zero mismatches).
- **Strongest variant: V5_title_plus_errors** (V0 + extracted exception
  names + failing-test ids + capped traceback frames; p90 task text 392
  chars). It is the ONLY net-positive variant: +5.1pts holdout lead, +3.8pts
  holdout recall@5, +5.2pts holdout any-gold, miss 24→21 and wrong_pivot 8→7
  all-scored, while capsules got *smaller* (mean files 3.98→3.88, median
  tokens 1178→1094) and hidden-coedit / multi-file all-gold / overpacked
  stayed byte-flat. Every raw-prefix variant (V1/V2/V4/V6) and the bare
  token-dump (V7) is net-NEGATIVE — more text pollutes retrieval and crushes
  the co-edit lanes (hidden-coedit 0.622 → 0.26–0.39).
- **Verdict: PASS** (all 11 criteria met).
- **Recommendation: M103 = implement structured task derivation modeled on
  V5** (error/test/traceback augmentation only — not longer prose, not full
  problem text).

## Current Task Derivation

- Code path: `benchmarks/stage5_vexp_swe_bench_smoke/build_stage5_retrieval_fixture.ts`
  → `deriveTaskFromProblemStatement(problemStatement, maxLen = 360)`; consumed
  by the deterministic scoreboards (M94–M101), the retrieval-eval fixture
  builder, and the Stage 5 live runner. The product `buildCapsuleV2` takes the
  task string as-is — the derivation itself is benchmark/runner-side.
- 360-char behaviour and loss profile: see
  `stage5_m102_task_derivation_gap_analysis.md` (pre-variant audit; data in
  `stage5_m102_task_derivation_gap_audit.json`). Lost-evidence kinds in the
  miss-class population: file stems 13, basenames 12, symbols 11, path
  suffixes 10, dotted modules 2; contexts: prose 25, traceback 17, code
  block 6. Most affected repos: xarray (5/6), pytest (4/4), django (21/44),
  sympy (8/17).

## Variant Design

Helper: `stage5_m102_task_variants.ts` (12 unit tests). All variants
deterministic, first-occurrence-ordered, exact-token-deduped, and capped
(≤20 identifiers, ≤8 paths, ≤8 traceback lines, ≤1200 structured chars);
V4 is a benchmark-only upper bound capped at 20k chars. Variants read the
problem statement ONLY (no parameter can carry the gold patch).

| variant | construction | task chars med/p90 |
| --- | --- | --- |
| V0_current | production derivation (parity-checked vs M101) | 132 / 239 |
| V1_720 | word-safe raw prefix, 720 | 707 / 718 |
| V2_1200 | word-safe raw prefix, 1200 | 1110 / 1197 |
| V3_structured_lite | V0 + backticked/quoted ids, paths, dotted modules, errors, tests, traceback | 271 / 674 |
| V4_full_problem | full statement (≤20k) | 1114 / 2862 |
| V5_title_plus_errors | V0 + errors + failing tests + traceback only | 176 / 392 |
| V6_first_last | first 360 + last 360 | 693 / 715 |
| V7_compressed_literals | V0 + ≤20 code-like tokens | 243 / 435 |

Leakage policy: V0 keeps M101's blocking semantics (parity). Longer variants
record an issue-authored gold path as a `gold_path_in_task` diagnostic instead
of blocking — the text provenance is the problem statement alone, so it is
author evidence, not contamination (V5: 7 flagged cases; V3: 27; V4: 23).

## Variant Scoreboard (all scored, n=99; V4 n=98 — one FTS "expression tree
too large" failure on a 19k-char statement, itself evidence that full text is
not even safely passable)

| variant | r@1 | r@3 | r@5 | r@10 | MRR | any | all | lead | gold-req | hidden | multi-all | wp | miss | op | files | medTok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V0 | .529 | .651 | .730 | .740 | .627 | 75.8% | 72.7% | 54.5% | 64.6% | .622 | 53.3% | 8 | 24 | 14 | 3.98 | 1178 |
| V1_720 | .483 | .637 | .691 | .691 | .592 | 71.7% | 66.7% | 50.5% | 64.6% | .389 | 20.0% | 5 | 28 | 11 | 4.13 | 1502 |
| V2_1200 | .529 | .642 | .691 | .691 | .623 | 71.7% | 66.7% | 55.6% | 68.7% | .256 | 20.0% | 2 | 28 | 10 | 4.32 | 1742 |
| V3_structured | .522 | .654 | .688 | .698 | .630 | 73.7% | 66.7% | 55.6% | 65.7% | .489 | 33.3% | 6 | 26 | 13 | 3.65 | 1004 |
| V4_full | .514 | .625 | .705 | .705 | .615 | 73.5% | 68.4% | 54.1% | 64.3% | .289 | 26.7% | 7 | 26 | 12 | 4.41 | 1388 |
| **V5_errors** | **.564** | **.681** | **.745** | **.765** | **.660** | **78.8%** | **74.7%** | **58.6%** | **67.7%** | **.622** | **53.3%** | **7** | **21** | **14** | **3.88** | **1094** |
| V6_first_last | .473 | .609 | .649 | .654 | .568 | 67.7% | 63.6% | 49.5% | 58.6% | .289 | 20.0% | 6 | 32 | 8 | 4.24 | 1491 |
| V7_literals | .468 | .629 | .718 | .723 | .585 | 74.7% | 70.7% | 48.5% | 60.6% | .556 | 46.7% | 11 | 25 | 14 | 4.34 | 1241 |

Dev (n=60) V0 → V5: r@1 .589→.614, r@5 .813 flat, any 85.0→86.7%, all-gold
81.7→83.3%, lead 61.7→65.0%, miss 9→8, overpacked 11→11.

**Holdout (n=39) V0 → V5**: r@1 .436→**.487** (+5.1pts), r@5 .603→**.641**
(+3.8pts), any-gold 61.5→**66.7%** (+5.2pts), all-gold 59.0→61.5% (+2.5pts),
lead 43.6→**48.7%** (+5.1pts), wrong_pivot 3→2, miss 15→13, overpacked 3→3.

Subset view: V5's gains concentrate exactly where they should — the
`evidence_beyond_v0` cohort (n=50: any-gold 74→80%, lead 58→64%, all-gold
74→78%) while the `no_evidence_beyond_v0` cohort is virtually unchanged
(lead 51.0→53.1%, everything else flat). M101-miss cohort (n=24): 3 recovered
(1 excellent, 1 good, 1 partial). M101-wrong_pivot cohort (n=8): sympy-13372
→ excellent.

## Win/Loss Analysis (case-level vs V0)

| variant | gross W/L | cases W/L | net | dev W/L | holdout W/L |
| --- | --- | --- | --- | --- | --- |
| V1_720 | 32/62 | 13/30 | −17 | 6/20 | 7/10 |
| V2_1200 | 37/50 | 13/23 | −10 | 7/16 | 6/7 |
| V3_structured_lite | 27/37 | 9/15 | −6 | 5/11 | 4/4 |
| V4_full_problem | 43/63 | 17/29 | −12 | 8/19 | 9/10 |
| **V5_title_plus_errors** | **20/4** | **7/3** | **+4** | **3/2** | **4/1** |
| V6_first_last | 30/72 | 11/28 | −17 | 4/21 | 7/7 |
| V7_compressed_literals | 8/31 | 4/17 | −13 | 2/11 | 2/6 |

- V5 wins: requests-1724 miss→excellent (traceback names
  `requests/sessions.py`), sympy-13372 wrong_pivot→excellent (`evalf` — the
  M101 weak-direct case, now anchored by its error/test evidence),
  sympy-13480 miss→good, django-16938 miss→partial, plus lead flips on
  django-11815, sphinx-7462, sympy-24213.
- V5 losses (3 cases, 4 events): django-13513 [holdout] excellent→good (lead
  drifted to `views/generic/__init__.py`), matplotlib-22719 lead/required
  gold lost inside an already-overpacked capsule, xarray-4695 gold left top-5
  inside an already-overpacked capsule. No all-gold loss, no
  wrong_pivot/overpack introduced anywhere.
- Prefix-variant noise profile (why more text loses): dominant loss events
  are `all_gold_lost` / `lead_source_gold_lost` / `gold_leaves_capsule` —
  prose words shift lexical ranking wholesale, and the changed derived-term
  set breaks the co-edit/file-evidence lanes tuned on short tasks
  (hidden-coedit 0.622 → 0.26–0.39, multi-file all-gold 53.3% → 20–33%).
  The false positives are generic prose/identifier tokens pulling
  same-named files from other subsystems into lead/required slots.

## Token and Context Impact

- Task text: V5 median 176 / p90 392 chars (V0: 132/239) — ~+60% text, far
  under the 1200-char gate; est tokens +~40 median.
- Capsule side (V5 vs V0): median tokens 1178→1094, p90 4046→3712, mean files
  3.98→3.88, overpacked 14→14 — the extra anchors make capsules *more*
  focused, not larger.
- V1/V2/V4/V6 inflate capsules (median tokens up to 1742, files up to 4.41)
  while losing recall — the wrong direction on both axes.

## Decision

**Yes — product task derivation should change in a future M103, in the V5
shape only**: keep the current title+sentence core and append *extracted*
exception names, failing-test identifiers and capped traceback frames.
Do NOT lengthen the prose window (V1/V2/V6), do NOT pass full problem text
(V4 — net-negative AND can exceed FTS query limits), do NOT dump bare
code-like tokens (V7 — wrong_pivot 8→11). V5 satisfies every
strong-candidate gate: holdout lead +5.1 and holdout r@5 +3.8 (≥+3),
overpacked flat, mean files −0.10, task p90 392 ≤ 1200.

M103 must be run as a full re-baselining milestone: the new task text feeds
every lane (lexical, direct-evidence, file-evidence, co-edit, pivot ranking),
so it needs its own scoreboard chain, retrieval-eval baseline refresh, a
product-side decision on the leakage-guard policy for issue-authored paths
(psf-5414 is currently unscoreable because the ISSUE names the gold file),
and a look at the three V5 loss cases (two are already-overpacked capsules;
django-13513 is the one real lead regression to guard).

## Recommended M103

**Implement structured task derivation** (V5-shaped: current derivation +
exceptions + failing tests + capped traceback frames), as a controlled
re-baselining milestone with the safeguards above.
