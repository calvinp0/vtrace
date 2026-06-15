# Stage 5 — M7.2 clean-Docker re-baseline of the M6 bounded 20-case validation

Generated 2026-06-15, on `main` HEAD `d4d731c`. **Measurement-repair task.** Re-evaluates the full M6 bounded-20 set (`stage5_bounded_20_case_validation.md`) under a confirmed-healthy Docker, eval-only — no agent re-runs, no patch regeneration. Motivation: M7.1 found that the Docker "Yunix" containerd shim fault produced false-negative resolutions, making the original M6 resolution-regression evidence suspect. This task establishes which M6 conclusions survive a clean re-evaluation.

Method note: the Yunix fault makes containers fail to **start**, so tests never run and `resolved` defaults to **False**. A fault can therefore only produce false *negatives* — a `resolved=True` row is always trustworthy (a container ran and FAIL_TO_PASS passed). Re-evaluation was scoped to the **54 rows currently showing `resolved=False` with a non-empty patch**; the 68 `resolved=True` rows are carried forward unchanged, and empty-patch rows (deterministically unresolved) are not re-run. Token/cost/tool-call metrics are re-eval-invariant and carried forward (verified: recomputed deltas match the original report).

## 1. Executive verdict

**`m6_rebaseline_changes_conclusion`.**

Clean Docker changes the M6 conclusion, but narrowly. **Exactly 2 of 20 cases changed** — both VTRACE-arm false negatives, both previously counted as resolution regressions:

- **sympy-13372**: VTRACE 2/3 → **3/3** (resolution preserved vs baseline 3/3, −23% tokens).
- **xarray-3677**: VTRACE 1/3 → **3/3** (now a resolution *improvement* over baseline 2/3, −48% tokens).

The other 18 cases reproduce the original report byte-for-byte, including the 3 *genuine* regressions (sympy-12419, astropy-14539, pylint-8898), which persist under clean Docker. So the original M6 report was **mostly clean**; only the two traceback-leaky cases were contaminated. Net effect: the resolution-regression rate drops 25% → **15%**, useful-injection rate rises 47% → **59%**. Critically, the two corrected cases are exactly the two cases the M7 conservative-localization policy fires on — and corrected, they are useful injections, not regressions. M7's motivation does not survive re-baselining.

## 2. Docker health

```
docker run hello-world : OK ("Hello from Docker!")
docker ps              : OK (host containers up; daemon healthy)
_ping                  : OK
Yunix/shim errors      : none — 0 occurrences across all 54 re-evals
54/54 evals            : evaluationRan=true, dockerUsed=true, evaluationError=null, exit=0
```

Single validation eval (matplotlib-24627 baseline) ran a real 5m03s docker evaluation and stayed `False` (genuine non-resolving baseline, matching the report) — confirming the flow distinguishes genuine failures from contamination rather than blanket-flipping.

## 3. Re-evaluation coverage

```
labels expected (20 cases × {baseline, vtrace} × reps): 122 rows across 122 labels
labels/rows re-evaluated (resolved=False, patch>0):        54
labels valid (clean docker eval):                          54  (100%)
labels invalid infrastructure (Yunix/shim):                 0
labels missing artifacts:                                   0
rows carried forward (resolved=True, trustworthy):         68
rows not re-run (empty patch → deterministically False):    6  (sphinx-7462 r3 base; mpl-25960 r1/r2 base; astropy-14365 vtrace r1; astropy-14539 vtrace r3; xarray-3677 base r2)
```

Reused-label mapping resolved: astropy-14369 baseline = `eval-m4r2-baseline-astropy-14369-r{1,2,3}`, VTRACE = `eval-m4r6-current-clean-obligation-astropy-14369-r{1..5}` (n=5, 3/5); django-11095 = `eval-m4h-{baseline,current-clean}-django-11095-r{1,2,3}`. The other 18 cases use `eval-bounded-*` (8 M5 cases) and `eval-bounded20-*` (10 M6 cases).

## 4. Corrected 20-case table

Resolution `b→v` = baseline→VTRACE resolved count. Efficiency deltas (total tokens, cache-read, R+G+B tool calls, cost) are re-eval-invariant, carried from `stage5_bounded_20_case_validation.md`. Medians.

| instance | set | bkt | b n | v n | old b→v | new b→v | clean b | clean v | tot Δ | cache-read Δ | R+G+B b→v | cost Δ | old class | corrected class | changed? |
|---|---|---|:-:|:-:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|---|:--:|
| matplotlib-24627 | M5 | A | 3 | 3 | 0/3→0/3 | 0/3→0/3 | 0/3 | 0/3 | −30% | −30% | 39→29 | −63% | strict_efficiency_pass | strict_efficiency_pass | no |
| flask-5014 | M5 | A | 3 | 3 | 3/3→3/3 | 3/3→3/3 | 3/3 | 3/3 | −0% | −0% | 2→2 | −14% | no_context_safety_pass | no_context_safety_pass | no |
| sphinx-7748 | M5 | A | 3 | 3 | 0/3→0/3 | 0/3→0/3 | 0/3 | 0/3 | −59% | −59% | 27→9 | −49% | strict_efficiency_pass | strict_efficiency_pass | no |
| requests-1142 | M5 | A | 3 | 3 | 3/3→3/3 | 3/3→3/3 | 3/3 | 3/3 | −23% | −23% | 5→3 | −23% | strict_efficiency_pass | strict_efficiency_pass | no |
| astropy-14369 | M5 | B | 3 | 5 | 0/3→3/5 | 0/3→3/5 | 0/3 | 3/5 | +38% | +39% | 18→21 | +12% | actionability_success | actionability_success | no |
| sphinx-7462 | M5 | B | 3 | 3 | 0/3→0/3 | 0/3→0/3 | 0/3 | 0/3 | +33% | +26% | 5→6 | +58% | inject_without_benefit | inject_without_benefit | no |
| django-11095 | M5 | C | 3 | 3 | 3/3→3/3 | 3/3→3/3 | 3/3 | 3/3 | −10% | −10% | 6→6 | −24% | no_context_safety_pass | no_context_safety_pass | no |
| matplotlib-25960 | M5 | C | 3 | 3 | 0/3→1/3 | 0/3→1/3 | 0/3 | 1/3 | −46% | −47% | 35→16 | −40% | strict_efficiency_pass | strict_efficiency_pass | no |
| sympy-16766 | M5 | D | 3 | 3 | 3/3→3/3 | 3/3→3/3 | 3/3 | 3/3 | −7% | −9% | 11→6 | +39% | inject_without_benefit | inject_without_benefit | no |
| requests-5414 | M5 | E | 3 | 3 | 0/3→0/3 | 0/3→0/3 | 0/3 | 0/3 | +13% | +5% | 4→4 | +29% | inject_without_benefit | inject_without_benefit | no |
| sympy-12419 | M6 | A | 3 | 3 | 3/3→2/3 | 3/3→2/3 | 3/3 | 2/3 | +0% | +1% | 21→22 | +11% | **resolution_regression** | **resolution_regression** | no |
| sympy-12481 | M6 | A | 3 | 3 | 3/3→3/3 | 3/3→3/3 | 3/3 | 3/3 | −7% | −8% | 15→13 | −10% | no_context_safety_pass | no_context_safety_pass | no |
| astropy-14365 | M6 | A | 3 | 3 | 0/3→1/3 | 0/3→1/3 | 0/3 | 1/3 | +60% | +64% | 8→12 | +15% | resolution_improvement_with_cost | resolution_improvement_with_cost | no |
| astropy-14539 | M6 | A | 3 | 3 | 3/3→1/3 | 3/3→1/3 | 3/3 | 1/3 | −36% | −32% | 10→9 | −48% | **resolution_regression** | **resolution_regression** | no |
| seaborn-3187 | M6 | B | 3 | 3 | 0/3→0/3 | 0/3→0/3 | 0/3 | 0/3 | −8% | −8% | 29→25 | −10% | inject_without_benefit | inject_without_benefit | no |
| django-13195 | M6 | B | 3 | 3 | 0/3→0/3 | 0/3→0/3 | 0/3 | 0/3 | −28% | −29% | 6→3 | +1% | useful (preserved+cheaper) | useful (preserved+cheaper) | no |
| pylint-8898 | M6 | C | 3 | 3 | 2/3→0/3 | 2/3→0/3 | 2/3 | 0/3 | +4% | +5% | 11→11 | +2% | **resolution_regression** | **resolution_regression** | no |
| django-11728 | M6 | C | 3 | 3 | 2/3→3/3 | 2/3→3/3 | 2/3 | 3/3 | −37% | −37% | 15→8 | −36% | strict_efficiency_pass | strict_efficiency_pass | no |
| sympy-13372 | M6 | D | 3 | 3 | 3/3→**2/3** | 3/3→**3/3** | 3/3 | 3/3 | −23% | −27% | 7→5 | −12% | **resolution_regression** | strict_efficiency_pass | **YES** |
| xarray-3677 | M6 | D | 3 | 3 | 2/3→**1/3** | 2/3→**3/3** | 2/3 | 3/3 | −48% | −46% | 12→6 | −49% | **resolution_regression** | resolution_improvement | **YES** |

Absolute median total tokens / cost (clean Docker; for the two changed cases): sympy-13372 baseline 765k tok / $0.282, VTRACE 589k / $0.248; xarray-3677 baseline 1.18M / $0.432, VTRACE 621k / $0.221.

## 5. Corrected injection-policy summary

Counted per case (20 total). Rule (from the M6 report): "useful injection" = resolution improved, OR resolution preserved with median total tokens ≥10% lower.

```
injected count:                  17
no_context (skip) count:          3   (flask-5014, django-11095, sympy-12481)
useful injection count:          10   (was 8)
inject-without-benefit count:     4   (sphinx-7462, sympy-16766, requests-5414, seaborn-3187)
resolution_regression count:      3   (sympy-12419, astropy-14539, pylint-8898)   (was 5)
safe no_context count:            3
unsafe no_context count:          0
```

Rates:
```
useful injection rate:        10/17 = 59%   (was 47%)
inject-without-benefit rate:   4/17 = 24%   (unchanged)
resolution regression rate:    3/20 = 15%   (was 25%);  3/17 = 18% of injected (was 29%)
safe no_context rate:           3/3 = 100%  (unchanged)
```

useful injection (10) = matplotlib-24627, sphinx-7748, requests-1142, astropy-14369, matplotlib-25960, astropy-14365, django-11728, django-13195, **sympy-13372 (new)**, **xarray-3677 (new)**.

## 6. Contamination analysis

Which M6 conclusions changed because of Docker contamination:

```
cases with changed resolved count:        2   (sympy-13372, xarray-3677) — both VTRACE arm
  sympy-13372:  VTRACE 2/3 → 3/3  (+1; old "regression" was a false negative)
  xarray-3677:  VTRACE 1/3 → 3/3  (+2; old "regression" was 2 false negatives; now an improvement)
old unresolved → resolved after clean eval: 2 rows in sympy-13372, 2 rows in xarray-3677 (VTRACE)
old resolved → unresolved after clean eval: 0  (resolved=True is fault-immune; never re-run down)
baseline arms changed:                      0  (all baseline counts identical to the report)
genuine regressions confirmed (persist):    3  (sympy-12419 3→2, astropy-14539 3→1, pylint-8898 2→0)
```

Both contaminated cases are the "traceback-leaky / baseline-optimal" diagnostics (set M6, bucket D) — exactly the cases the original report flagged as "VTRACE injected redundantly, cheaper trajectory resolved less." That narrative was an artifact: under clean Docker the cheaper trajectory resolves *equally* (sympy-13372) or *better* (xarray-3677). The M7.1 finding is reproduced and bounded: the contamination was confined to these two cases, not the whole M6 set.

## 7. M7 policy consequence

**`disable_m7_policy_by_default`.**

The M7 conservative-localization downgrade (`inject → no_context` when an issue traceback-localizes the lead pivot) fires, per the M7.1 live validation, on exactly **sympy-13372** and **xarray-3677**. Under the corrected M6 table both are **useful injections**, not regressions:

- sympy-13372: injection preserves resolution (3/3) at −23% tokens. Skipping removes the token saving with no resolution benefit (M7.1 live: the skip trajectory cost *more* than inject).
- xarray-3677: injection **improves** resolution (baseline 2/3 → VTRACE 3/3) at −48% tokens. Skipping would forfeit a resolution gain *and* a token saving.

So the policy's entire justification — "traceback-localized injection is harmful/wasteful on these cases" — was built on contaminated evidence. Corrected, the policy removes useful injection without any resolution gain, and on xarray actively removes a resolution improvement. It is net-negative on the only two cases it affects. The localization diagnostics/telemetry (kind, confidence, signals) may still be worth keeping for future targeting, but the *downgrade action* should not be on by default.

This task did not change the policy (out of scope per the task constraints).

## 8. Next recommendation

**B.** Patch the auto-policy to disable the conservative-localization `inject→no_context` downgrade by default (keep the localization diagnostics/telemetry, which are cheap and may inform a better-targeted future signal), then rerun the offline policy audit (`stage5_m7_policy_audit_on_m6_cases.md`) against the corrected resolutions to confirm no useful injection is suppressed. Do this as a separate task. Do not advance to a 30-case or 100-task run: the corrected 20-case set still shows a real inject-without-benefit rate (24%) and 3 genuine regressions (sympy-12419, astropy-14539, pylint-8898) that are unrelated to traceback localization and remain the substantive open problem — but they are not addressed by the M7 policy and need their own analysis (multi-file co-edit follow-through; injecting on already-solvable cases below the resolving threshold).

## 9. Non-claims

- Not a public SWE-bench score, not VEXP parity, not a 100-task validation. Stratified 20-case set, n=3 (astropy-14369 n=5).
- Re-evaluation was scoped to `resolved=False` rows because the Yunix fault is a pure false-negative generator; `resolved=True` rows were carried forward, not re-run. This is sound for the fault in question but assumes no *other* fault produced false positives during the original runs (no evidence of one).
- The 3 surviving regressions are small-n (one is a single-run dip: sympy-12419 3→2); their direction is consistent but n=3 limits confidence. django-13195 counts as "useful" only by the literal rule (a failure preserved more cheaply, 0/3→0/3 −28%); it is not a resolution win.
- Token/cost/tool metrics were carried forward, not recomputed per-row, except total-token and cost medians which were recomputed and matched the report's deltas.
