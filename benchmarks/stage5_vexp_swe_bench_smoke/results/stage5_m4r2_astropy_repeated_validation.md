# Stage 5 — M4.2 controlled repeated astropy-14369 validation + actionability audit

Generated: 2026-06-14, live repeated runs on current `main` HEAD (n=3 per condition). Single remaining injected-context blocker `astropy__astropy-14369`. No product/retrieval/scoring/candidate/auto-policy changes. Decisions use medians of n=3.

A = baseline/no-context; B = clean VTRACE (default v2 compact inspect-first, `--disable-pivot-check`, hard gate off). Default soft PIVOT_CHECK not run (M4.1 showed it adds cost without resolution benefit).

**Run note:** B repeats r2 and r3 aborted before the agent could act due to a Claude 5-hour session limit / out-of-credits (`api_error_status:429`, $0 cost, no JSONL); they are infrastructure failures, not data, and were re-run after the limit reset as r4 and r5. B's n=3 valid set is therefore {r1, r4, r5}.

**Gold fix (post-hoc, for analysis only — not leaked to runs):** `cds.py::p_division_of_units` grammar reorder `unit_expression DIVISION combined_units` -> `combined_units DIVISION unit_expression` (makes division left-associative), **plus a regenerated `cds_parsetab.py`** (PLY LALR table). FAIL_TO_PASS: `test_cds_grammar[strings4/6]`, `test_cds_grammar_fail[km/s.Mpc-1]` (the last must now *fail to parse*).

## 1. Executive verdict

**Does clean VTRACE beat baseline on astropy-14369 (median n=3)?** Tokens/efficiency: yes (median tokens/cost lower) (B median total 2,117,288 vs A 2,414,739). **Does astropy become a strict resolved PASS?** **No** — VTRACE resolved 0/3, baseline 0/3. Classification `reduction_no_resolution_gain` / actionability `patch_synthesis_failure`. astropy localizes correctly (gold `cds.py` edited 3/3) but the patch is not synthesized correctly and the generated `cds_parsetab.py` is not regenerated, so it stays unresolved regardless of context richness.

## 2. Repeat table

| cond | label | resolved | total tok | cache-read | R/G/B | cost | 1st-edit turn | post-edit Bash | gold cds.py | parsetab | non-gold | gold-dir grammar |
|---|---|:--:|--:|--:|--:|--:|--:|--:|:--:|:--:|---|:--:|
| A | `eval-m4r2-baseline-astropy-14369-r1` | no | 4,437,838 | 4,294,308 | 34 | $3.0462 | 4 | 15 | yes | no | - | no |
| A | `eval-m4r2-baseline-astropy-14369-r2` | no | 2,190,240 | 2,115,972 | 18 | $0.9954 | 3 | 8 | yes | no | - | yes |
| A | `eval-m4r2-baseline-astropy-14369-r3` | no | 2,414,739 | 2,320,986 | 18 | $1.3230 | 3 | 8 | yes | no | - | no |
| B | `eval-m4r2-current-clean-astropy-14369-r1` | no | 1,466,652 | 1,363,195 | 11 | $1.0331 | 1 | 5 | yes | no | - | no |
| B | `eval-m4r2-current-clean-astropy-14369-r4` | no | 3,303,018 | 3,082,851 | 17 | $2.1309 | 1 | 6 | yes | no | - | no |
| B | `eval-m4r2-current-clean-astropy-14369-r5` | no | 2,117,288 | 2,041,301 | 15 | $1.1337 | 1 | 6 | yes | no | - | no |

## 3. Distribution summary

| cond | resolved/n | median total | min/max total | median cacheRead | min/max cacheRead | median R+G+B | median cost | gold-cds edits/n |
|---|:--:|--:|--:|--:|--:|--:|--:|:--:|
| A (baseline (no context)) | 0/3 | 2,414,739 | 2,190,240/4,437,838 | 2,320,986 | 2,115,972/4,294,308 | 18 | $1.3230 | 3/3 |
| B (clean VTRACE (--disable-pivot-check)) | 0/3 | 2,117,288 | 1,466,652/3,303,018 | 2,041,301 | 1,363,195/3,082,851 | 15 | $1.1337 | 3/3 |

## 4. Strict gate interpretation — clean VTRACE (B) vs baseline (A)

- resolution preserved/improved? **no** (B 0/3 vs A 0/3)
- median total tokens down? **yes** — 2,117,288 vs 2,414,739 (DOWN -12.3%)
- median cache-read down? **yes** — 2,041,301 vs 2,320,986 (DOWN -12.1%)
- median Read+Grep+Bash down? **yes** — 15 vs 18 (DOWN -16.7%)
- median cost down? **yes** — 1.1 vs 1.3 (DOWN -14.3%)

**Classification: `reduction_no_resolution_gain`**

## 5. Actionability diagnosis

**Classification: `patch_synthesis_failure`**

- VTRACE (B) edited gold `cds.py` in 3/3 repeats; edited generated `cds_parsetab.py` in 0/3; used the gold grammar direction (`combined_units DIVISION unit_expression`) in 0/3.
- VTRACE resolved 0/3; baseline resolved 0/3 (baseline edited cds.py in 3/3).
- Inspect-first / pivot target: confirmed `cds.py::to_string`/`p_division_of_units` area (see B confirmations); localization is reliable, so this is **not** a localization failure.
- Failure mechanism: the gold fix requires (1) the *exact* left-assoc grammar reorder AND (2) **regenerating the PLY `cds_parsetab.py`**. Editing the grammar in `cds.py` while leaving the committed `cds_parsetab.py` stale means the parser keeps the old table; and the agents' grammar reformulations differ from gold (e.g. a `division_RHS` rule that still parses `km/s.Mpc-1`, so `test_cds_grammar_fail` stays failing).
- Tests still failing (gold FAIL_TO_PASS): test_cds_grammar[strings4-unit4], test_cds_grammar[strings6-unit6], test_cds_grammar_fail[km/s.Mpc-1].
- Would a more actionable capsule help? **Marginally.** Surfacing `cds_parsetab.py` as a co-edit/regenerate target is a plausible actionability hint, but the core difficulty is correct LALR grammar synthesis + table regeneration — pure patch synthesis that richer excerpts do not solve. VTRACE already points to the right file/function.

## B condition VTRACE confirmations

- `eval-m4r2-current-clean-astropy-14369-r1`: effEngine=v2, compactInspectFirst=True, policyAction=inject, fallback(workspaceGit)=False, pivotCheckText=False, editGuard=False, patchVerify=False, firstEdit=cds.py, editTurn=1, jsonlRows=1
- `eval-m4r2-current-clean-astropy-14369-r4`: effEngine=v2, compactInspectFirst=True, policyAction=inject, fallback(workspaceGit)=False, pivotCheckText=False, editGuard=False, patchVerify=False, firstEdit=cds.py, editTurn=1, jsonlRows=1
- `eval-m4r2-current-clean-astropy-14369-r5`: effEngine=v2, compactInspectFirst=True, policyAction=inject, fallback(workspaceGit)=False, pivotCheckText=False, editGuard=False, patchVerify=False, firstEdit=cds.py, editTurn=1, jsonlRows=1

## 6. Next decision

**Recommendation: C + B (do NOT rerun blindly).**
- astropy-14369 is a **patch-synthesis blocker**, not a context/localization problem: VTRACE reliably points to and edits the gold `cds.py::p_division_of_units`, but the required fix is an exact LALR grammar reorder + regeneration of the generated `cds_parsetab.py`, which the agent does not synthesize. Baseline fails the same way.
- **Do not** treat astropy as a context-reduction-gate case. Either (C) reclassify it as a patch-synthesis blocker and **select a replacement injected-context overhead case** for the reduction gate, or (B) attempt a *narrow* actionability hint (surface `cds_parsetab.py` as a regenerate-after-grammar-change co-target) — but only if the audit shows that hint is missing AND it is a context change, not retrieval tuning. Recommended: reclassify + replace; do not chase this single hard-synthesis case.
- matplotlib (M4.1) is on-par/no-regression; with astropy removed/replaced, run a 4-case n=3 clean headline gate using a replacement overhead case that is context-sensitive (localization-bound, not synthesis-bound).

## Non-claims
- Single instance, n=3/condition; medians reduce but do not remove noise.
- Gold patch used only for post-hoc analysis; never injected into any live run.
- No VEXP parity, no 100-task run, no retrieval/scoring/candidate/policy changes; raw artifacts not committed.