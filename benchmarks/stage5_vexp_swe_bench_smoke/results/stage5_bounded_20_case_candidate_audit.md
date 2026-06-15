# Stage 5 — M6 bounded 20-case validation: candidate audit (Phase 1)

Generated: 2026-06-15, on `main` HEAD (`a9fc665`). Plans the 10 additions that grow the M5 bounded 10-case validation to 20. **No live agents run for this audit.** Built from the cross-repo (30) + expanded retrieval evals (50 unique instances total), prior M4/M5 live reports, and traceback-leakage analysis of SWE-bench `problem_statement`s (`vexp-swe-bench/data/swe-bench-100.jsonl`). Gold patch used only post-hoc.

## 1. Executive candidate decision

Add 10 cases to reach **8 injected-localization / 4 actionability / 4 no_context / 4 baseline-optimal-or-hard**. Selection rules: injected-localization picks are **CLEAN** (gold file not named in a `File "…"` traceback line → baseline must explore) **and non-django** (M5 showed django auto-skips live even when the retrieval eval labels it `standard`, so non-django gives dependable injection); actionability picks are **multi-file co-edit** cases (test follow-through generalization beyond generated artifacts); no_context picks are expected skips; the diagnostic bucket uses **traceback-leaky** cases (baseline localizes for free → measures whether VTRACE adds overhead).

## 2. Existing 10 reused (M5, commit a9fc665)

No reruns. Reused as-is (clean condition, Docker-evaluated, ordered telemetry, no gates):

| instance | bucket | labels |
|---|---|---|
| matplotlib-24627, flask-5014, sphinx-7748, requests-1142 | A injected | `eval-bounded-{baseline,current-clean}-<short>-r{1,2,3}` |
| astropy-14369 | B actionability | `eval-m4r2-baseline-*` + `eval-m4r6-current-clean-obligation-*` (n=5) |
| sphinx-7462 | B actionability | `eval-bounded-{baseline,current-clean}-sphinx-7462-*` |
| django-11095 | C no_context | `eval-m4h-{baseline,current-clean}-django-11095-*` |
| matplotlib-25960 | C no_context | `eval-bounded-{baseline,current-clean}-mpl-25960-*` |
| sympy-16766 | D baseline-optimal | `eval-bounded-{baseline,current-clean}-sympy-16766-*` |
| requests-5414 | E hard synthesis | `eval-bounded-{baseline,current-clean}-requests-5414-*` |

## 3. Proposed 10 additions

| # | instance | bucket | short | gold file(s) | leakage | retrieval | why / success = |
|---|---|---|---|---|---|---|---|
| 11 | sympy-12419 | A injected | `sympy-12419` | `matrices/expressions/matexpr.py` | CLEAN | t3, pivot | baseline must explore; VTRACE injects → fewer pre-edit reads/greps, resolution preserved |
| 12 | sympy-12481 | A injected | `sympy-12481` | `combinatorics/permutations.py` | CLEAN | t1/sym/pivot | strong retrieval, not leaked → earlier localization, no overhead |
| 13 | astropy-14365 | A injected | `astropy-14365` | `io/ascii/qdp.py` | CLEAN | t1/sym/pivot | QDP reader; CLEAN → baseline explores; also probes actionability-layer generalization to a non-PLY parser |
| 14 | astropy-14539 | A injected | `astropy-14539` | `io/fits/diff.py` | CLEAN | t1/pivot | CLEAN diff subsystem → baseline over-reads; VTRACE injects |
| 15 | seaborn-3187 | B actionability | `seaborn-3187` | `_core/scales.py` + `utils.py` | file-named | t1/pivot, **MULTI** | 2-file co-edit; success = agent edits the surfaced 2nd gold (`utils.py`) more than baseline |
| 16 | django-13195 | B actionability | `django-13195` | `cookie.py` + `middleware.py` + `http/response.py` | CLEAN | t1/sym/pivot, **MULTI** | 3-file co-edit (delete_cookie/process_response); tests multi-file follow-through; auto-skip risk noted |
| 17 | pylint-8898 | C no_context | `pylint-8898` | `config/argument.py` + `utils/__init__.py` + `utils/utils.py` | n/a | **no_context mode**, missing | gold not retrievable → VTRACE should skip; success = safe skip, no resolution harm |
| 18 | django-11728 | C no_context | `django-11728` | `admindocs/utils.py` | CLEAN | pivot | small/local regex fix; expected auto-skip; success = safe skip / no overhead |
| 19 | sympy-13372 | D leaky diagnostic | `sympy-13372` | `core/evalf.py` | **LEAKY** (file:line in traceback) | t3, pivot | baseline localizes for free; success = VTRACE adds no overhead, no regression |
| 20 | xarray-3677 | D leaky diagnostic | `xarray-3677` | `core/dataset.py` | **LEAKY** (gold in traceback) | t1/sym/pivot | baseline localizes for free; success = no overhead / no regression |

## 4. Backup cases

- A injected: scikit-learn-10844, pytest-7432, pydata-xarray-2905 (all file-named, baseline likely localizes — weaker).
- B actionability: django-12325 (`base.py`+`options.py`, 2-file co-edit), pylint-8898 (3-file, but no_context).
- C no_context: django-11133 (`http/response.py` make_bytes), django-11206 (`numberformat.py`).
- D leaky/hard: scikit-learn-11578 (file-named), django-12774 (LEAKY).

## 5. Rejected candidates and reasons

- `reject_missing_or_stale_artifacts`: matplotlib-24970, sphinx-7910, sphinx-9230 (retrieval missing / wrong_subsystem — gold not in top-3).
- `reject_traceback_leaky_for_injected_bucket`: sympy-13372, xarray-3677, django-12774 (gold in traceback) — kept only as D diagnostics, never in the injected bucket.
- `reject_baseline_optimal_for_injected_bucket`: scikit-learn-10844/11578, pytest-7432/10051/5262, xarray-2905, sympy-15599, seaborn-3187 (file-named: gold named in statement → baseline localizes; seaborn kept for actionability via its hidden 2nd gold, not for injected-localization).
- `reject_patch_synthesis_bound_for_headline`: requests-1724 (discarded role + known synthesis difficulty).

## 6. Expected bucket balance (20 total)

| bucket | M5 | +M6 | total |
|---|:--:|:--:|:--:|
| injected-localization | 4 | 4 | **8** |
| actionability | 2 | 2 | **4** |
| no_context safety | 2 | 2 | **4** |
| baseline-optimal / hard / leaky | 2 | 2 | **4** |

## 7. Expected live run count

10 new cases × (baseline n=3 + clean VTRACE n=3) = **60 new run+eval pairs**. Existing 10 cases contribute 0 new runs (reused). Rough cost ≈ $25–40 (most additions are cheap sympy/django/pylint/seaborn; astropy io and xarray are mid; no 4M-token matplotlib baselines this round).

## 8. Labels that can be reused

All M5 labels for the existing 10 cases (see §2) — verified clean (no PIVOT_CHECK/EDIT_GUARD/PATCH_VERIFY, Docker-evaluated, ordered telemetry, one JSONL/run, v2 path or no_context skip).

## 9. Labels that must be newly run

`eval-bounded20-{baseline,current-clean}-<short>-r{1,2,3}` for: sympy-12419, sympy-12481, astropy-14365, astropy-14539, seaborn-3187, django-13195, pylint-8898, django-11728, sympy-13372, xarray-3677.

## 10. Risk / cost estimate

- **Auto-policy divergence risk:** django-13195 (actionability) and django-11728 (no_context) may auto-skip or auto-inject differently than planned — observed policy will be reported, and a skip on django-13195 is itself a finding (actionability layer not exercised). seaborn-3187 (non-django) is the more reliable actionability inject.
- **Cost risk:** xarray and astropy-io runs are mid-cost; the leaky diagnostics (sympy-13372, xarray-3677) may run long if a baseline flails, but no case here is the 4M-token matplotlib-24627 class.
- **Stochasticity:** n=3 medians; leaky-bucket and hard cases can swing — decisions use medians and the injection-policy rates, not single draws.

## Non-claims

Not a public SWE-bench score, not VEXP parity, not 100-task validation. Set is stratified and small; live-agent results are stochastic. Bucket labels are the *plan*; classifications in Phase 2 use *observed* policy.
