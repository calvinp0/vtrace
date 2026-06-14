# Stage 5 — M5 bounded stratified validation: candidate audit (Phase 1)

Generated: 2026-06-15, on `main` HEAD (`01b657e`). Phase-1 planning artifact for a bounded 10-case live validation after the cleared-with-caveats M4 headline gate. **No live agents were run for this audit** — it is built from existing retrieval evals, prior live reports, and problem-statement leakage analysis. Gold patch data used only post-hoc for classification.

## Method

Per candidate, three signals were combined:
1. **Retrieval status** — from `stage5_retrieval_eval_cross_repo_30.json` (30 cross-repo cases): top-1/top-3 file hit, symbol hit, expected-file role (pivot/support/discarded/missing), inject vs no_context mode, miss category.
2. **Traceback-leakage** — does the SWE-bench `problem_statement` (from `vexp-swe-bench/data/swe-bench-100.jsonl`) name the gold file, and is it named *inside a `File "…"` traceback line*? `CLEAN` = gold file not named (baseline must explore); `file-named` = file named but not via traceback; `LEAKY` = gold named in a traceback line (baseline localizes for free).
3. **Prior live behavior** — from `stage5_localization_gap_*`, `stage5_capsule_v2_recovered_live_validation.md`, `stage5_baseline_vs_vtrace_live_comparison.md`, and the M4 reports: did baseline over-read or localize quickly; did VTRACE help; was any failure patch-synthesis-bound vs localization-bound.

A case is a strong **injected-localization** candidate only if VTRACE *injects* (standard mode, gold retrievable in top-3) **and** the issue is **CLEAN** (baseline cannot localize from the statement). Leaky/file-named cases are routed to the traceback/leaky bucket; correct-localize-but-fail cases to hard patch-synthesis.

## Leakage map (retrievable standard-mode cases)

| instance | role | t1/t3/sym | leakage | note |
|---|---|:--:|---|---|
| matplotlib-24627 | pivot | 0/1/0 | **CLEAN** | 395-char behavioral statement; baseline over-read 4.8M tok live |
| flask-5014 | pivot | 0/1/1 | **CLEAN** | 195-char statement; forces exploration |
| sphinx-7748 | pivot | 1/1/1 | **CLEAN** | strong retrieval, not named |
| requests-1142 | pivot | 1/1/1 | **CLEAN** | strong retrieval, not named |
| sympy-12481 | pivot | 1/1/1 | CLEAN | backup |
| astropy-14365 | pivot | 1/1/1 | CLEAN | backup (units sibling) |
| astropy-14539 | pivot | 1/1/0 | CLEAN | backup |
| sympy-16766 | pivot | 1/1/0 | CLEAN file, **symbol named** | baseline already optimal (both arms resolved) |
| astropy-14369 | pivot | 0/1/0 | CLEAN | actionability anchor (generated parser table) |
| sphinx-7462 | pivot | 0/1/0 | gold#1 LEAKY, **gold#2 hidden** | `pycode/ast.py` named nowhere → actionability/follow-through |
| scikit-learn-10844 | pivot | 1/1/1 | file-named | baseline likely localizes |
| pytest-7432 | pivot | 1/1/1 | file-named | baseline likely localizes |
| seaborn-3187 | pivot | 1/1/0 | file-named | backup |
| xarray-3677 | pivot | 1/1/1 | **LEAKY** | gold `dataset.py` in traceback line |
| requests-5414 | pivot | 1/1/1 | file-named | baseline resolves; VTRACE patch-shape regression risk (hard synthesis) |
| matplotlib-25960 | discarded | 0/0/1 | n/a (no_context) | VTRACE skips |
| pylint-8898 | missing | 0/0/0 | n/a (no_context) | VTRACE skips (gold missing) |
| django-10880 / -11095 | no_context | — | n/a | M4 no_context anchors |

## Primary 10-case set

| # | instance | bucket | reuse? | gold file(s) | why included | success = |
|---|---|---|---|---|---|---|
| 1 | matplotlib-24627 | A injected-localization | new | `axes/_base.py` | CLEAN; baseline over-read 4.8M tok / 112 turns live | VTRACE preserves resolution while **cutting wasted Read/Grep/Bash** vs baseline |
| 2 | flask-5014 | A injected-localization | new | `blueprints.py` | CLEAN; 195-char statement forces exploration | resolution preserved, fewer pre-edit reads/greps |
| 3 | sphinx-7748 | A injected-localization | new | `ext/autodoc/__init__.py` | CLEAN; strong retrieval (t1/sym/pivot) | resolution preserved, faster localization, no overhead |
| 4 | requests-1142 | A injected-localization | new | `requests/models.py` | CLEAN; strong retrieval (t1/sym/pivot) | resolution preserved, faster localization, no overhead |
| 5 | astropy-14369 | B actionability | **reuse** (m4r2 + m4r6 n=5) | `cds.py` (+`cds_parsetab.py`) | confirmed actionability_success (0/3→3/5) | obligation followed, generated artifact in final diff, resolution up |
| 6 | sphinx-7462 | B actionability | new | `domains/python.py` + **`pycode/ast.py`** | VTRACE surfaces hidden 2nd gold not in traceback | agent **edits the surfaced hidden file** (follow-through), resolution preserved |
| 7 | django-11095 | C no_context safety | **reuse** (m4h) | `admin/options.py` | confirmed no_context_safety_pass (3/3=3/3) | VTRACE skips context, resolution preserved, no overhead |
| 8 | matplotlib-25960 | C no_context safety | new | `figure.py` | VTRACE skips (gold discarded); tests skip generalization | skip honored, resolution preserved/non-regressed, no useless context |
| 9 | sympy-16766 | D traceback/leaky (baseline-optimal) | new | `printing/pycode.py` | symbol named in statement; both arms resolved in recovered runs | VTRACE **does not add overhead** over an already-optimal baseline |
| 10 | requests-5414 | E hard patch-synthesis | new | `requests/models.py` | baseline resolves; prior VTRACE chose regressing edit-shape | diagnostic — VTRACE must **not regress** PASS_TO_PASS; localization stays correct |

Bucket counts: **A=4, B=2, C=2, D/E=2** — matches the recommended first bounded composition.

## Reuse vs new runs

**Reused (clean condition verified, Docker-evaluated, no new runs):**
- astropy-14369: baseline `eval-m4r2-baseline-astropy-14369-r{1,2,3}`; VTRACE `eval-m4r6-current-clean-obligation-astropy-14369-r{1..5}` (n=5, `--disable-pivot-check`, policy=inject, no gates).
- django-11095: baseline `eval-m4h-baseline-django-11095-r{1,2,3}`; VTRACE `eval-m4h-current-clean-django-11095-r{1,2,3}` (policy=skip, no gates).

**New labels to run** (each: baseline n=3 + clean VTRACE n=3 = 6 run+eval pairs):
`eval-bounded-baseline-<SHORT>-r{1,2,3}` and `eval-bounded-current-clean-<SHORT>-r{1,2,3}` for:
- matplotlib-24627 (`mpl-24627`)
- flask-5014 (`flask-5014`)
- sphinx-7748 (`sphinx-7748`)
- requests-1142 (`requests-1142`)
- sphinx-7462 (`sphinx-7462`)
- matplotlib-25960 (`mpl-25960`)
- sympy-16766 (`sympy-16766`)
- requests-5414 (`requests-5414`)

**Estimated live run count: 48 new run+eval pairs** (8 cases × 6). Rough cost ≈ $30–35; dominated by matplotlib-24627's expensive baseline arm (~$3/run, 112-turn flail risk). flask/sphinx/requests/sympy arms are cheap ($0.3–$0.6/run).

## Classifications (Phase-1)

- `include_in_bounded_validation`: matplotlib-24627, flask-5014, sphinx-7748, requests-1142, astropy-14369, sphinx-7462, django-11095, matplotlib-25960, sympy-16766, requests-5414.
- `backup_candidate`: sympy-12481, astropy-14365, astropy-14539, seaborn-3187 (A); django-10880, pylint-8898 (C); xarray-3677, scikit-learn-10844 (D).
- `reject_traceback_leaky_for_headline`: sympy-13372 (gold file:line printed), xarray-3677 (gold in traceback — kept only as D backup).
- `reject_patch_synthesis_bound_for_headline` (kept only as E diagnostic): requests-5414 carries this caveat — it is included as a **diagnostic/negative** case, not a headline win.
- `reject_no_context_for_injected_bucket`: matplotlib-25960, pylint-8898 belong in C, not A.
- `reject_missing_or_stale_artifacts`: matplotlib-24970, sphinx-7910, sphinx-9230 (retrieval missing/wrong_subsystem).

## Notes / risks

- Genuine VTRACE *localization wins* are expected to be rare: prior audits show baseline usually localizes too (traceback or strong model priors). The bounded set is therefore designed to test **non-regression + the known positive effects** (actionability on astropy, no_context safety), with bucket A as the honest stress test for "does injected context reduce wasted exploration without adding overhead."
- matplotlib-24627 is the single best bucket-A test (CLEAN + documented baseline over-read) but is the most expensive; if budget tightens, it can be deferred and replaced with sympy-12481 (CLEAN, cheaper).
- requests-5414 is a **diagnostic**, not a headline win — its prior VTRACE arm was force-inject and chose a PASS_TO_PASS-regressing edit; the clean re-run tests whether the default v2 path avoids that.
- Live-agent results are stochastic; decisions use medians of n=3 (astropy n=5).

## Non-claims

- This is not a public SWE-bench score, not VEXP parity, not a 100-task validation. The set is small and stratified.
