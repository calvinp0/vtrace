# Stage 5 — M6 bounded 20-case stratified validation

Generated: 2026-06-15, on `main` HEAD (`a271bbe`). Grows the M5 bounded 10-case validation to 20 (plan: `stage5_bounded_20_case_candidate_audit.md`). Clean VTRACE = `vtrace-indexed`, default v2 compact inspect-first, `--disable-pivot-check`, hard gate off, no `--capsule-engine`. Baseline = no-context control. n=3 per condition (astropy VTRACE n=5, reused). Medians; live-agent results are stochastic. Gold patch used only post-hoc.

## 1. Executive verdict

**`mixed`.**

The broader set does **not** reproduce M5's clean 10/10. Where VTRACE injects context that helps, the efficiency wins are real and repeatable (5 strict efficiency passes, 23–59% token cuts). But across 20 cases there are **5 resolution regressions (25%)** and the **useful-injection rate is only 47%** — VTRACE injects on many cases where the baseline is already fine or where injection leads to a cheaper-but-non-resolving trajectory. The M5 caveat ("inject-without-benefit may be too high") is **confirmed and quantified**. Resolution improved on 4, regressed on 5, unchanged on 11. All VTRACE telemetry is clean (eng=v2, fallback=null, no gates, ordered telemetry present on all 20).

Two robust regressions (structural, not noise): **pylint-8898** (VTRACE injected on a case planned as no_context, edited only 1 of 3 co-edit gold files, 2/3→0/3) and **astropy-14539** (3/3→1/3, one run produced an empty patch after 27 turns of exploration). Three further regressions are single-run dips at n=3 (sympy-12419 3→2, sympy-13372 3→2, xarray-3677 2→1) and are plausibly within noise — but their **direction is consistent** (all down, none up), which is itself a signal.

## 2. Candidate set (20)

| set | injected-localization | actionability | no_context | baseline-optimal / hard / leaky |
|---|---|---|---|---|
| M5 (reused) | matplotlib-24627, flask-5014, sphinx-7748, requests-1142 | astropy-14369, sphinx-7462 | django-11095, matplotlib-25960 | sympy-16766, requests-5414 |
| M6 (new) | sympy-12419, sympy-12481, astropy-14365, astropy-14539 | seaborn-3187, django-13195 | pylint-8898, django-11728 | sympy-13372, xarray-3677 |

Bucket totals: injected 8, actionability 4, no_context 4, baseline-optimal/hard/leaky 4. All 60 new runs valid (Docker-evaluated, one JSONL each, no aborts; astropy-14539 r3 was a legitimate empty-patch run, kept).

## 3. Per-case distribution table

Medians. Δ = (VTRACE − baseline)/baseline. Policy = observed live auto-policy.

| instance | set | bucket | res b→v | total Δ | cache-read Δ | R+G+B b→v | cost Δ | policy | classification |
|---|---|---|:--:|:--:|:--:|:--:|:--:|:--:|---|
| matplotlib-24627 | M5 | A | 0/3→0/3 | −30% | −30% | 39→29 | −63% | inject | strict_efficiency_pass |
| flask-5014 | M5 | A | 3/3→3/3 | −0% | −0% | 2→2 | −14% | skip | no_context_safety_pass |
| sphinx-7748 | M5 | A | 0/3→0/3 | −59% | −59% | 27→9 | −49% | inject | strict_efficiency_pass |
| requests-1142 | M5 | A | 3/3→3/3 | −23% | −23% | 5→3 | −23% | inject | strict_efficiency_pass |
| astropy-14369 | M5 | B | 0/3→**3/5** | +38% | +39% | 18→21 | +12% | inject | actionability_success |
| sphinx-7462 | M5 | B | 0/3→0/3 | +33% | +26% | 5→6 | +58% | inject | inject_without_benefit |
| django-11095 | M5 | C | 3/3→3/3 | −10% | −10% | 6→6 | −24% | skip | no_context_safety_pass |
| matplotlib-25960 | M5 | C | 0/3→**1/3** | −46% | −47% | 35→16 | −40% | inject | strict_efficiency_pass |
| sympy-16766 | M5 | D | 3/3→3/3 | −7% | −9% | 11→6 | +39% | inject | inject_without_benefit |
| requests-5414 | M5 | E | 0/3→0/3 | +13% | +5% | 4→4 | +29% | inject | inject_without_benefit |
| sympy-12419 | M6 | A | 3/3→**2/3** | +0% | +1% | 21→22 | +11% | inject | **resolution_regression** |
| sympy-12481 | M6 | A | 3/3→3/3 | −7% | −8% | 15→13 | −10% | skip | no_context_safety_pass |
| astropy-14365 | M6 | A | 0/3→**1/3** | +60% | +64% | 8→12 | +15% | inject | resolution_improvement_with_cost |
| astropy-14539 | M6 | A | 3/3→**1/3** | −36% | −32% | 10→9 | −48% | inject | **resolution_regression** |
| seaborn-3187 | M6 | B | 0/3→0/3 | −8% | −8% | 29→25 | −10% | inject | patch_synthesis_bound |
| django-13195 | M6 | B | 0/3→0/3 | −28% | −29% | 6→3 | +1% | inject | patch_synthesis_bound |
| pylint-8898 | M6 | C | 2/3→**0/3** | +4% | +5% | 11→11 | +2% | inject | **resolution_regression** |
| django-11728 | M6 | C | 2/3→**3/3** | −37% | −37% | 15→8 | −36% | inject | strict_efficiency_pass |
| sympy-13372 | M6 | D | 3/3→**2/3** | −23% | −27% | 7→5 | −12% | inject | **resolution_regression** |
| xarray-3677 | M6 | D | 2/3→**1/3** | −48% | −46% | 12→6 | −49% | inject | **resolution_regression** |

(xarray-3677 true gold is `core/merge.py`, not the retrieval-eval's `dataset.py`; both arms edit merge.py.)

## 4. Bucket summaries

**Injected-localization (8):** bifurcated. Clean wins persist (requests-1142 3/3=3/3 −23%; sphinx-7748 −59%; matplotlib-24627 −30%). But 2 of the 4 M6 additions **regressed** (sympy-12419 3→2; astropy-14539 3→1 with an empty-patch run), one improved-with-cost (astropy-14365 0→1, +60% tok), and one auto-skipped (sympy-12481, parity). Injecting on an already-solvable case sometimes shortens the trajectory below the resolving threshold.

**Actionability (4):** only the **generated-artifact obligation generalizes**. astropy-14369 is a clean `actionability_success` (0/3→3/5; parsetab in final diff 5/5, ensure-in-diff 5/5). The three **multi-file co-edit** cases all fail the follow-through: agent edits the hidden/2nd gold sphinx-7462 0/3, seaborn-3187 1/3, django-13195 0/3 (baseline 0/3 on all). The actionability layer does **not** yet surface or enforce multi-file co-edit obligations.

**no_context safety (4):** mixed. django-11095 (skip) and sympy-12481 (auto-skip) are clean `no_context_safety_pass`. But the two M6 additions **auto-injected instead of skipping**: pylint-8898 (planned no_context — gold missing) injected and regressed 2/3→0/3 (edited 1 of 3 co-edit files); django-11728 injected and *improved* 2/3→3/3 (−37% tok). The skip machinery did not fire where the audit predicted, in both directions.

**Baseline-optimal / hard / leaky (4):** sympy-16766 (`inject_without_benefit`, +39% cost) and requests-5414 (`inject_without_benefit`, +29%) add cost without gain. The two leaky diagnostics both regressed with big token cuts: sympy-13372 3→2 (−23% tok), xarray-3677 2→1 (−48% tok) — VTRACE injected even though the baseline localizes for free from the traceback, and the cheaper trajectory resolved less.

## 5. Injection-policy summary (mandatory)

Counted per case (20 total). "useful injection" = resolution improved, OR resolution preserved with median tokens ≥10% lower.

```
injected count:                17
no_context (skip) count:        3   (flask-5014, django-11095, sympy-12481)
useful injection count:         8
inject-without-benefit count:   4
resolution_regression (injected): 5
safe no_context count:          3
unsafe no_context count:        0
```

Rates:
```
useful injection rate:        8/17 = 47%
inject-without-benefit rate:  4/17 = 24%   (53% if regressions are counted as a severe form)
safe no_context rate:         3/3  = 100%
resolution regression rate:   5/20 = 25%   (5/17 = 29% of injected cases)
```

useful injection = matplotlib-24627, sphinx-7748, requests-1142, astropy-14369, matplotlib-25960, astropy-14365, django-11728, django-13195. inject-without-benefit = sphinx-7462, sympy-16766, requests-5414, seaborn-3187. resolution_regression = sympy-12419, astropy-14539, pylint-8898, sympy-13372, xarray-3677.

## 6. Effectiveness vs efficiency

**Effectiveness:** resolution preserved/improved 15/20, **regressed 5/20 (25%)**. Improved on 4 (astropy-14369 0→3/5, matplotlib-25960 0→1/3, astropy-14365 0→1/3, django-11728 2→3). Gold-file edit rate dropped on 4 (matplotlib-24627 3→2, astropy-14365 3→2, astropy-14539 3→2, seaborn-3187 3→2). Actionability follow-through generalizes only for generated artifacts, not multi-file co-edit.

**Efficiency:** strong where injection helps and on skips — total/cache-read/R+G+B/cost down 7–63% on 11 cases. But several token reductions come **paired with resolution regressions** (astropy-14539 −36%/res↓, sympy-13372 −23%/res↓, xarray-3677 −48%/res↓): the agent spends fewer tokens because it edits less and resolves less. Per the M6 mandate, these are **not** counted as wins — a token cut that loses a resolution is a regression, not efficiency.

## 7. Failure / caveat analysis

| case | blocker |
|---|---|
| pylint-8898 | inject-without-benefit + actionability/follow-through — injected on a no_context-planned case; edited 1 of 3 co-edit gold files; 2/3→0/3 |
| astropy-14539 | inject-without-benefit / context-action gap — one run explored 27 turns and produced an empty patch; 3/3→1/3 |
| sympy-12419 | resolution regression (likely stochastic) — both localize gold 3/3; VTRACE 1-run dip |
| sympy-13372 | baseline already optimal (traceback-leaky) — VTRACE injected redundantly; 1-run dip with −23% tok |
| xarray-3677 | baseline already optimal (traceback-leaky) — VTRACE injected redundantly; cheaper trajectory resolved less |
| sphinx-7462, seaborn-3187, django-13195 | actionability/follow-through — multi-file co-edit obligation not surfaced/followed |
| sympy-16766, requests-5414 | inject-without-benefit — added cost, no effectiveness gain |

No telemetry/reporting failures: all 20 VTRACE cases reported eng=v2, fallback=null, no PIVOT_CHECK/EDIT_GUARD/PATCH_VERIFY, ordered telemetry present, consistent policy within each case.

## 8. Decision for next validation stage

**`needs_policy_tuning_for_inject_without_benefit`.**

The dominant, actionable signal: VTRACE injects too liberally. 53% of injected cases either added cost without benefit (24%) or regressed resolution (29%); the leaky/baseline-optimal cases (sympy-13372, xarray-3677, sympy-16766) and the no_context-planned pylint-8898 should have skipped. The auto-policy needs to be more conservative about injecting when the baseline can localize unaided (traceback-leaky, file named, symbol named) — **but auto-policy thresholds were explicitly not tuned in this milestone (out of scope).** Secondary: `needs_actionability_detector_expansion` — multi-file co-edit follow-through (3/3 cases failed) is the next actionability gap after generated artifacts. Do **not** proceed to a 30-case or 100-task run until the inject-without-benefit policy is addressed and re-measured on this 20-case set.

## 9. Non-claims

- This is not a public SWE-bench score, not VEXP parity, not 100-task validation.
- The set is stratified and small (20 cases; n=3, astropy n=5). Live-agent results are stochastic — 3 of the 5 resolution regressions are single-run dips that may be noise, though their consistent downward direction is itself a signal.
- Token reductions paired with resolution regressions are reported as regressions, not efficiency wins.
- Observed auto-policy (inject/skip) diverged from the retrieval-eval prediction on several cases (pylint-8898, django-11728, sympy-12481, flask-5014); bucket labels are the plan, classifications use observed behavior.
