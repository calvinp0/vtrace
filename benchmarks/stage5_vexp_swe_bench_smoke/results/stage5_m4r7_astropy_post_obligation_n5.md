# Stage 5 — M4.7 post-obligation astropy-14369 hardened to n=5

Generated: 2026-06-14, live clean-VTRACE runs on current `main` HEAD (`aca2aa1`). Extends the M4.6 post-obligation condition (`stage5_m4r6_astropy_post_obligation_validation.md`) from n=3 to n=5 by adding two clean repeats (r4, r5). No baseline / pre-hint / awareness-only reruns. No product/retrieval/scoring/candidate/auto-policy changes. Single condition: post-obligation clean VTRACE (default v2 compact inspect-first, `--disable-pivot-check`, hard gate off).

**Gold fix (post-hoc, analysis only — never leaked to runs):** `cds.py::p_division_of_units` grammar reorder `unit_expression DIVISION combined_units` → `combined_units DIVISION unit_expression` (left-associative division), **plus a regenerated PLY `cds_parsetab.py`**. FAIL_TO_PASS: `test_cds_grammar[strings4/6]`, `test_cds_grammar_fail[km/s.Mpc-1]` (the last must now *fail to parse*).

**Run validity:** r4 and r5 ran live to completion (non-zero cost, one JSONL row each, Docker eval ran). No 429 / session-limit / out-of-credit aborts; no replacement runs needed. Five valid post-obligation runs total: {r1, r2, r3, r4, r5}.

## 1. Executive verdict

**Did post-obligation astropy remain an actionability success at n=5?** **`confirmed_actionability_success`.**

- Resolved **3/5** (r2, r3, r4) — up from 2/3 at n=3; the added runs split 1 resolved / 1 unresolved, leaving the rate stable at ~0.6.
- The obligation's *designed* effect is now rock-solid: generated parser table reached the **submitted diff in 5/5** runs, generated-artifact awareness **5/5**, `ensure-in-diff` obligation visible in **5/5** live snapshots (char 2123, within the 12,000-char cutoff).
- Every unresolved run (r1, r5) failed for the **same single reason — wrong LALR grammar direction**, never a missing artifact. Resolution now rides entirely on grammar-direction correctness (gold direction 3/5), exactly tracking the resolved count.

## 2. n=5 run table

| label | resolved | total tok | cache-read | R/G/B | cost | cds.py edited | parsetab final diff | lextab final diff | gold grammar dir | failure category |
|---|:--:|--:|--:|--:|--:|:--:|:--:|:--:|:--:|---|
| `…-r1` | no | 3,414,729 | 3,216,559 | 4/1/17 = 22 | $1.9146 | yes | yes | no | no | wrong_grammar_direction |
| `…-r2` | yes | 3,327,998 | 3,227,065 | 2/1/17 = 20 | $1.4820 | yes | yes | no | yes | resolved |
| `…-r3` | yes | 2,120,681 | 2,028,269 | 4/0/9 = 13 | $1.0827 | yes | yes | no | yes | resolved |
| `…-r4` | yes | 2,648,011 | 2,583,179 | 3/0/18 = 21 | $1.2430 | yes | yes | yes | yes | resolved |
| `…-r5` | no | 4,245,439 | 4,092,581 | 5/0/17 = 22 | $3.0034 | yes | yes | yes | no | wrong_grammar_direction |

Labels: `eval-m4r6-current-clean-obligation-astropy-14369-r{1..5}`. (r1–r3 carried over from M4.6; r4–r5 new.)

## 3. n=5 summary

| metric | value |
|---|:--:|
| resolved | **3 / 5** |
| generated-artifact awareness | 5 / 5 |
| `ensure-in-diff` visible (snapshot, <12k) | 5 / 5 |
| parsetab in final diff | 5 / 5 |
| lextab in final diff | 2 / 5 |
| gold grammar direction | 3 / 5 |
| median total tokens | 3,327,998 |
| median cache-read | 3,216,559 |
| median R+G+B | 21 |
| median cost | $1.4820 |

min/max total tokens 2,120,681 / 4,245,439; min/max cost $1.0827 / $3.0034. Gold grammar direction is the perfect predictor of resolution in this set (3/5 gold-dir = the exact 3/5 resolved set).

## 4. Snapshot / telemetry checks (all 5 runs)

Identical and clean across r1–r5:

- `vtraceEffectiveCapsuleEngine=v2`, `vtraceCompactInspectFirst=true`, `vtracePolicyAction=inject`, `vtraceCapsuleEngineFallbackReason=null`.
- `--disable-pivot-check` honored: `vtracePivotCheckPolicy=off`; no `PIVOT_CHECK` / `EDIT_GUARD` / `PATCH_VERIFY` in any snapshot.
- Obligation block present: `## Actionability hints` (char 1750), `cds.py → cds_parsetab.py`, `cds.py → cds_lextab.py`, regenerate/update wording, `ensure-in-diff:` line (char 2123), final/submitted/tracked reminder — all before the 12,000-char injection cutoff.
- Docker eval ran for all five (`evaluationRan=true`, `dockerUsed=true`, `evaluationError=null`); resolvedCount 0/1/1/1/0.

No rendering or telemetry inconsistency — no code change required.

## 5. Consequence for astropy

**`keep_astropy_in_M4_gate`.** Resolved **3/5 (≥3/5)** and obligation/final-diff behavior is consistent (parsetab-in-diff 5/5, awareness 5/5, snapshots clean 5/5). With the obligation, astropy-14369 is a resolving injected-context case, not a permanent blocker — this confirms (and strengthens) the M4.6 decision to reverse M4.4's removal.

## 6. Next recommendation

**A — run the final clean M4 headline gate.** Four cases, n=3, `--disable-pivot-check` for injected cases:

- `matplotlib-22719`
- `astropy-14369` (post-obligation)
- `django-10880` (no_context safety)
- `django-11095` (no_context safety)

Rationale: at n=5 the post-obligation signal is now hardened — designed effect saturated (5/5 artifact-in-diff) and resolution stable at 3/5 — so the variance concern from the M4.6 caveat is resolved well enough to proceed to the headline gate rather than spend budget on n=7.

## Honest caveats / non-claims

- The obligation's measurable effect (generated artifact in the submitted diff) is fully saturated at 5/5; the resolution gain rides on LALR grammar-direction correctness (3/5), which the obligation does not directly control. At n=5, resolution variance is reduced but not eliminated.
- Both failures share one mechanism (wrong grammar direction), so astropy has shifted from follow-through-bound (solved) to grammar-synthesis-bound (residual). A future synthesis-quality intervention — not a context change — would be needed to lift resolution past ~0.6.
- Single instance; gold patch used only post-hoc, never injected. No VEXP parity, no 100-task run, no retrieval/scoring/candidate/policy changes; raw artifacts not committed.
