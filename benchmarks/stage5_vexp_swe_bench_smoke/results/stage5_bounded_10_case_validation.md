# Stage 5 — M5 bounded 10-case stratified validation

Generated: 2026-06-15, on `main` HEAD (`58e5479`). Phase-2 of the bounded validation planned in `stage5_bounded_validation_candidate_audit.md`. Clean headline treatment for VTRACE: `protocol vtrace-indexed`, current default Capsule v2 compact inspect-first, `--disable-pivot-check`, hard gate off, no `--capsule-engine`. Baseline = no-context control. n=3 per condition (astropy VTRACE n=5, reused from M4.7). Medians; live-agent results are stochastic. Gold patch used only post-hoc.

## 1. Executive verdict

**`passed_with_caveats`.**

Resolution is **preserved or improved in 10/10 cases — zero resolution regressions.** Where VTRACE injects context that actually helps, it produces **real reductions in wasted exploration** (token/cache-read/Read-Grep-Bash/cost down 23–59%), which is materially stronger than M4's weak matplotlib signal. It safely **skips** context on cases where the baseline is already efficient, and reproduces the **astropy actionability win** (0/3→3/5). The caveats: on three cases VTRACE injected context that did **not** help and **added cost** (sphinx-7462 hidden-pivot follow-through, requests-5414 hard synthesis, sympy-16766 already-optimal baseline). All VTRACE telemetry is clean across every run (eng=v2, fallback=null, no PIVOT_CHECK/EDIT_GUARD/PATCH_VERIFY, ordered telemetry present).

## 2. Candidate set

| # | instance | planned bucket | reuse | gold file(s) |
|---|---|---|---|---|
| 1 | matplotlib-24627 | A injected-localization | new | `axes/_base.py` |
| 2 | flask-5014 | A injected-localization | new | `blueprints.py` |
| 3 | sphinx-7748 | A injected-localization | new | `ext/autodoc/__init__.py` |
| 4 | requests-1142 | A injected-localization | new | `requests/models.py` |
| 5 | astropy-14369 | B actionability | reuse (m4r2+m4r6 n=5) | `cds.py` (+`cds_parsetab.py`) |
| 6 | sphinx-7462 | B actionability | new | `domains/python.py` + hidden `pycode/ast.py` |
| 7 | django-11095 | C no_context safety | reuse (m4h) | `admin/options.py` |
| 8 | matplotlib-25960 | C no_context safety | new | `figure.py` |
| 9 | sympy-16766 | D traceback/baseline-optimal | new | `printing/pycode.py` |
| 10 | requests-5414 | E hard patch-synthesis | new | `requests/models.py` |

Labels: new cases `eval-bounded-{baseline,current-clean}-<short>-r{1,2,3}`; reused astropy `eval-m4r2-baseline-*` + `eval-m4r6-current-clean-obligation-*`; reused django-11095 `eval-m4h-{baseline,current-clean}-django-11095-*`. All 48 new runs valid (Docker-evaluated, one JSONL each, no aborts).

## 3. Per-case distribution table

Medians. Δ = (VTRACE − baseline)/baseline. Policy = observed live auto-policy.

| instance | bucket | base→vtr resolved | med total (b→v / Δ) | med cache-read (Δ) | med R+G+B (b→v) | med cost (b→v / Δ) | policy | classification |
|---|---|:--:|---|:--:|:--:|---|:--:|---|
| requests-1142 | A | 3/3 → 3/3 | 562,316 → 433,335 / **−23%** | −23% | 5 → 3 | $0.237 → $0.183 / −23% | inject | strict_efficiency_pass |
| sphinx-7748 | A | 0/3 → 0/3 | 3,138,318 → 1,292,144 / **−59%** | −59% | 27 → 9 | $1.189 → $0.608 / −49% | inject | strict_efficiency_pass |
| matplotlib-24627 | A | 0/3 → 0/3 | 4,981,149 → 3,462,262 / **−30%** | −30% | 39 → 29 | $3.032 → $1.119 / −63% | inject | strict_efficiency_pass |
| flask-5014 | A | 3/3 → 3/3 | 313,375 → 313,197 / −0% | −0% | 2 → 2 | $0.199 → $0.172 / −14% | **skip** | no_context_safety_pass |
| astropy-14369 | B | 0/3 → **3/5** | 2,414,739 → 3,327,998 / +38% | +39% | 18 → 21 | $1.323 → $1.482 / +12% | inject | actionability_success |
| sphinx-7462 | B | 0/3 → 0/3 | 597,031 → 791,376 / +33% | +26% | 5 → 6 | $0.267 → $0.422 / +58% | inject | patch_synthesis_bound |
| django-11095 | C | 3/3 → 3/3 | 600,702 → 541,649 / −10% | −10% | 6 → 6 | $0.264 → $0.200 / −24% | **skip** | no_context_safety_pass |
| matplotlib-25960 | C | 0/3 → **1/3** | 3,770,928 → 2,008,333 / **−46%** | −47% | 35 → 16 | $0.50† → $0.30† / −40% | **inject** | strict_efficiency_pass |
| sympy-16766 | D | 3/3 → 3/3 | 1,063,857 → 969,904 / −7% | −9% | 11 → 6 | $0.46† → $0.64† / **+39%** | inject | weak_pass_with_overlap |
| requests-5414 | E | 0/3 → 0/3 | 492,965 → 516,969 / +13% | +5% | 4 → 4 | $0.35† → $0.45† / +29% | inject | patch_synthesis_bound |

† approximate (median of small n). Totals/cache-read are exact medians.

**Two planned-vs-observed policy divergences:** flask-5014 (planned inject, retrieval-eval standard mode) was **auto-skipped** live → parity; matplotlib-25960 (planned no_context, retrieval-eval discarded) was **auto-injected** live → resolution gain + efficiency win. VTRACE's runtime debug-intent policy legitimately differs from the deterministic retrieval-eval prediction; observed behavior is reported.

## 4. Bucket summaries

**A — injected-localization (4):** the strongest result. 3 of 4 deliver genuine waste reduction (requests-1142 −23% with full resolution; sphinx-7748 −59%; matplotlib-24627 −30%/−63% cost); flask-5014 auto-skipped to parity. Resolution preserved 4/4. Caveat: the two big-reduction cases (sphinx-7748, matplotlib-24627) are hard cases neither arm resolves (0/3=0/3) — the win is reduced exploration, not new resolutions; matplotlib-24627's gold-edit rate slipped 3→2 (capsule was off-target there per the M4 audit).

**B — actionability (2):** split. astropy-14369 is a clear `actionability_success` (0/3→3/5; generated `cds_parsetab.py` in final diff 5/5, `ensure-in-diff` visible 5/5, gold grammar direction 3/5 predicts resolution). sphinx-7462 is **not**: VTRACE surfaces the hidden second gold `pycode/ast.py` as a pivot, but the agent **edited it 0/3** (it edits `domains/python.py` 3/3 and `ext/autodoc/__init__.py` once) and the case costs +58% — the context-to-action gap on a *hidden co-edit pivot* is not closed, unlike the generated-artifact obligation.

**C — no_context safety (2):** django-11095 is a clean `no_context_safety_pass` (skip, 3/3=3/3, −10% tokens/−24% cost). matplotlib-25960 was planned no_context but **auto-injected** live and helped (0/3→1/3, −46% tokens, gold-edit 1→3) — a safety *non*-event that turned into a win; the skip machinery was not even exercised here.

**D — traceback/baseline-optimal (1):** sympy-16766 — resolution preserved 3/3=3/3 and R+G+B down 11→6, but **cost +39%**: VTRACE injects context the agent doesn't need (target named in the statement) and pays for it. A mild efficiency regression on an already-optimal baseline.

**E — hard patch-synthesis (1):** requests-5414 — both arms 0/3 (the patch-shape regression bites baseline too this round), localization identical (gold edited 3/3 both), VTRACE +29% cost with no benefit. `patch_synthesis_bound` diagnostic, as designed.

## 5. Effectiveness vs efficiency

**Effectiveness:**
- Resolution preserved or improved **10/10** (improved on astropy 0→3/5 and matplotlib-25960 0→1/3; no regressions).
- Gold-file edit rate improved on 3 (sphinx-7748 2→3, matplotlib-25960 1→3, astropy 3→5; sphinx-7462 2→3 on gold#1), regressed on 1 (matplotlib-24627 3→2).
- Actionability follow-through: **improved** for the generated-artifact obligation (astropy 5/5 in final diff) but **not** for the hidden co-edit pivot (sphinx-7462 `ast.py` 0/3).

**Efficiency:**
- Net reductions on every injected-helpful case and both skip cases (total/cache-read/R+G+B/cost down 7–63%).
- Regressions confined to cases where context did not help: sphinx-7462 (+58% cost), requests-5414 (+29%), sympy-16766 (+39% cost), and astropy (+38% — but that buys the resolution win).

Token-only metrics do not override the astropy resolution gain (kept as a success despite +38%); equally, the inject-without-benefit cost regressions are not hidden — they are the core caveat.

## 6. Failure analysis

| case | blocker | detail |
|---|---|---|
| sphinx-7462 | actionability/follow-through + patch synthesis | VTRACE localizes hidden `pycode/ast.py` but agent never edits it; 2-file fix never completed; context-to-action gap on hidden pivots |
| requests-5414 | patch synthesis | both arms localize gold `models.py` 3/3; neither produces a non-regressing edit; stochastic edit-shape failure |
| sympy-16766 | baseline already optimal | target named in statement; VTRACE context is redundant and adds cost (+39%) |
| matplotlib-24627 (gold-edit dip) | retrieval/localization | capsule pivots were repro entry-points (`pyplot.py`), not gold `axes/_base.py`; still cut cost sharply but localized gold less often |

No telemetry/reporting failures: every VTRACE run reported eng=v2, fallback=null, no gates, ordered telemetry present, and policy (inject/skip) consistent within each case.

## 7. Decision for next validation stage

**`ready_for_20_case_expansion`.** Resolution is never harmed; injected-helpful cases show substantial, repeatable efficiency wins; skip safety holds; the astropy actionability win generalizes as a pattern (generated-artifact obligation). Expand to ~20 stratified cases (more injected-localization and a few more actionability/no_context) to tighten the estimates.

**Watch-item for the expansion (not a blocker, and out of scope to fix here):** VTRACE sometimes injects context that does not help and adds cost (sphinx-7462, requests-5414, sympy-16766). The auto-policy could be more conservative about injecting when the baseline is already optimal — but auto-policy thresholds were explicitly **not** tuned in this milestone. Track the inject-without-benefit rate in the 20-case run.

## 8. Non-claims

- This is not a public SWE-bench score.
- This is not VEXP parity.
- This is not a 100-task validation.
- The set is small and stratified (10 cases; n=3, astropy n=5).
- Live-agent results are stochastic; medians reduce but do not remove noise.
- Several big efficiency reductions (sphinx-7748, matplotlib-24627) are on hard cases neither arm resolves — they reduce wasted exploration, they are not new resolutions.
- Observed auto-policy (inject/skip) can differ from the deterministic retrieval-eval prediction; bucket labels are the *plan*, classifications use *observed* behavior.
