# Stage 5 M109 — Final Analysis Notes (pre-summary working artifact)

_2026-07-07. No-spend analysis over committed artifacts only. Written BEFORE
the final internal summary, per the M109 brief. Every number here is
recomputed from the committed detail JSONs
(`stage5_m10{5,6,7,8}_live_runs.detail.json`,
`stage5_m94/m103_deterministic_scoreboard.json`,
`stage5_m73_final_100_paired.detail.json`,
`stage5_m92_core_reduction50_validation.md` run matrix), not copied from
prose._

## 1. Exact final default path (post-M103/M104)

- **Task derivation**: `deriveStructuredTaskFromProblemStatement`
  (`stage5_task_derivation.ts`) — M102 V5 shape: V0 base sentence +
  exceptions (≤6) + issue-mentioned failing tests (≤6) + capped traceback
  frames (≤8), 1200-char cap. The LIVE task builder (`buildCapsuleV2Task`)
  RETURNS this same function's text since M104 — live and deterministic
  tasks are one function.
- **Retrieval/capsule**: Capsule v2 with the M95–M101 deterministic chain:
  genericInfra strong-lexical fix (M95), direct-evidence anchoring lanes
  (M96), bounded hidden co-edit expansion (M97), co-edit confidence tiers
  (M98), file-level import scan + `import_reexport_rescue` lane (M99),
  file-evidence deep-pool rescue (M100), anchored-target pivot guard (M101).
- **Leakage policy**: provenance-based (`assessGoldLeakage`, M103):
  issue-authored gold paths scored with diagnostic; gold-patch-derived paths
  block. Extended at M108 with issue-authored FAIL_TO_PASS-id
  classification (verbatim-in-problem-statement required).
- **Live protocol flags** (the M92/M105 clean-core set): `--protocol
  vtrace-indexed --context-policy force-inject --capsule-engine v2
  --capsule-intent debug --capsule-budget 8000 --inject-capsule-digest
  --digest-decision-contract --bounded-digest-decisions
  --compact-digest-injection --pivot-confidence-gate`.
- **Mandatory safety**: M89 env guard + drift check + expected testbed
  prefix (fail-closed pre-spawn), M90A agent shell guard + host-pip
  firewall. `--allow-unguarded-live-env` is never benchmark-valid.
- **Default-off (never part of the path)**: V4 tool-loop guard, C7_D cost
  guard, M12 pivot-inspection enforcement, M14/M15 revision/corrective
  passes, rule-out sufficiency corrective, traceback-localized skip (M7.3),
  VEXP, any baseline arm.
- **Validity constraints**: a live run is valid only if preflight passed
  pre-spawn, v2 engine effective (any legacy fallback = parity-invalid: the
  fallback query still packs FAIL_TO_PASS), context injected, guards
  pass/benchmark-valid, no drift, no unguarded escape, no revision
  artifacts, no behavioral-guard metadata, result row parses, post-run
  snapshot leak-scan clean under base-commit provenance.

## 2. Which M95–M103 milestones changed product behavior

Product (deterministic-path) behavior changes: **M95, M96, M97, M98, M99,
M100, M101, M103** (derivation default + leakage policy), **M104** (live
task builder switched to the shared derivation — live-path change, retrieval
core untouched).

## 3. Diagnostics / report-only milestones

**M94** (scoreboard baseline), **M102** (task-derivation variant audit —
benchmark-only variants, no product change), **M105–M108** (live
confirmations — measurement, no behavior change), **M109** (this).

## 4. Final deterministic core result (M94 → M103, all-scored)

| metric | M94 | M103 | Δ |
| --- | ---: | ---: | ---: |
| recall@1 | .443 | .568 | +.125 |
| recall@3 | .602 | .684 | +.082 |
| recall@5 | .637 | .748 | +.111 |
| recall@10 | .647 | .768 | +.121 |
| any-gold-in-capsule | 69.7% | 79.0% | +9.3pts |
| all-gold-in-capsule | 60.6% | 75.0% | +14.4pts |
| lead-pivot = source-gold | 45.5% | 59.0% | +13.5pts |
| hidden-coedit recall | .222 | .622 | +.400 |
| multi-file all-gold | 6.7% | 53.3% | +46.6pts |
| outcome: excellent | 31 | 32 | +1 |
| outcome: good | 16 | 24 | +8 |
| outcome: miss | 30 | 21 | −9 |
| outcome: wrong_pivot | 10 | 7 | −3 |
| outcome: partial | 5 | 2 | −3 |
| outcome: overpacked | 7 | 14 | +7 |
| median capsule est. tokens | 1077 | 1096 | ~flat |
| p90 capsule est. tokens | 4447 | 3536 | −20% |

Notes: M94 outcome counts sum to 99 (comparable-99 set); M103 sums to 100
(new-policy set incl. psf-5414). Overpacking is the one metric that got
WORSE (7→14, peaked 18 at M97, repaired to 14 by M98) — the accepted cost of
the multi-file co-edit recall gains. Biggest single movers: M97 (multi-file
all-gold 6.7→40), M103 (r@1 +.035, miss 24→21, holdout r@5 +3.8 / lead
+5.1), M101 (wrong_pivot 11→8, lead +3pts).

## 5. Final integrated live result

**97 valid guarded live runs over the frozen 100-case pool; 55 resolved
(56.7% of valid runs); 3 pre-registered no-context exclusions** (django-11740,
django-15572, sphinx-9320 — frozen M103 `capsule.mode=no_context`; nothing to
inject; a live run would be baseline-shaped and parity-invalid, so they were
preflight-held, never spawned). Per set: M105 6/14, M106 3/10, M107 8/26,
M108 38/47. Cost $56.69, 104.6M tokens, 93.9% cache-read, 1008 tool calls.

## 6. Correct denominator

- Pool: **100 frozen cases** (the M73/M103 set).
- Live denominator: **97 valid live runs** (every spawned run was valid —
  0 invalid).
- Exclusions: **3 pre-registered no-context cases** (never spawned).
- NEVER report "55/100 pass rate" without the exclusion framing, and never
  imply 100/100 were run.

## 7–8. Fairest historical comparisons + agreement

Two defensible M73-treatment framings (both reported; strict is primary):

- **Strict comparability** (require `treatment_valid` in M73): 4 pool cases
  have NO valid M73 treatment row (django-10973 skipped; astropy-14598,
  django-13513, django-15503 attempted-but-invalid). On the 93
  attempted∩M73-valid cases: expectation **64/93**, live **54/93**,
  per-case agreement **77/93 (82.8%)**.
- **As-reported in M105–M108** (raw booleans, only 10973 excluded):
  agreement 81/96; combined expectation 66/100 vs 55/97.
- **M73 baseline**: all 97 attempted cases have valid M73 baseline rows;
  expectation **61/97** vs live 55/97. (Frozen history, not a same-day arm.)
- **M92 overlap**: 49 of the M92 50 were live-attempted (15572 excluded):
  live **16/49** vs M92 **20/49**, agreement **41/49**. (M92 ran the
  pre-M95 retrieval with the old composite task; overlap skews toward the
  early failure-heavy strata.)

Per-set strict agreement: M105 13/13, M106 7/10 (win astropy-14365; losses
astropy-7166, xarray-6938), M107 15/24 (wins sympy-12419, sympy-24562;
losses 12273, 12774, mpl-25960, pytest-6197, sympy-15875, django-12325,
mpl-24627), M108 42/46 (losses 11490, 13551, sympy-16766, sympy-23413; plus
10973 resolved with no row).

## 9. Where the M106/M107 losses concentrate

13 strict live-losses total; 9 sit in M106/M107 (the other 4 are M108's
11490/13551/16766/23413), and of the 9:
- 5 in `eg_hist_resolved`-type strata (M73-resolved excellent/good capsules
  where the live agent failed: astropy-7166, django-12273, django-12774,
  matplotlib-25960, plus xarray-6938 multi_file) — agent-side, not context.
- 4 in miss/overpacked strata that M73 happened to resolve (pytest-6197,
  sympy-15875, django-12325, matplotlib-24627) — weaker context, coin-flip
  territory.
M106/M107 deliberately oversampled failure classes (wrong_pivot/miss/
partial/multi-file), so their samples are enriched for exactly the cases
where live outcomes are least stable.

## 10. Does M108 explain the final deficit?

Yes. The success-heavy complement (M73 expectation 43/50) came in at 38/47
vs 41/47 expected on attempted (−3, agreement 42/46). The combined deficit
(54/93 vs 64/93 strict) decomposes as −3 (M106) −7 (M107, net of 2 wins)
−4 (M108, net) +wins... i.e., roughly −10 net across 93, two-thirds of it in
the deliberately failure-enriched M106/M107 extensions, with M105 exactly on
expectation (13/13) and M108 within noise. No evidence of a systemic path
regression; per-stratum deltas are 1–3 flips each.

## 11. Role of deterministic outcome strata (live resolution by M103 class,
all 97)

excellent 19/32, good 14/24, overpacked 9/14, miss 11/18, wrong_pivot 2/7,
partial 0/2. Deterministic capsule quality predicts live resolution
monotonically at the top (excellent+good 33/56 = 59%) vs bottom
(wrong_pivot+partial 2/9 = 22%); the miss class is surprisingly recoverable
live (61%) because the agent can navigate on its own — capsule misses are
not fatal, wrong LEADS are worse than absent context.

## 12. Live losses despite excellent/good deterministic context (agent-side)

astropy-7166 (good), xarray-6938 (excellent; single-file patch on multi-file
gold), django-12273 (good), django-12774 (good), matplotlib-25960
(excellent), django-11490 (excellent), django-13551 (excellent),
sympy-23413 (good) — 8 cases. These are the "agent variance / patch shape"
bucket, not retrieval failures.

## 13. Live losses that were deterministically expected (miss/wrong_pivot/
partial/overpacked context)

pytest-6197, sympy-15875 (miss), django-12325, matplotlib-24627, sympy-16766
(overpacked) — plus every agreed-unresolved case in those classes. Weak or
overflowing context; expected hard.

## 14. Live wins that are deterministic upgrades vs M73/M92

- sympy-12419 (M107, holdout, M103 overpacked): M73-unresolved → live
  resolved; M92 resolved. One of the 3 standing M7.x regressions.
- sympy-24562 (M107, M103 overpacked): M73-unresolved → live resolved.
- astropy-14365 (M106, M103 excellent): M73-unresolved → live resolved.
- django-10973 (M108): no valid M73 row (skipped) → live resolved.
- astropy-14539 and pylint-8898 resolved live in agreement with M73 but
  close out the M7.x regression list (with 12419).

## 15. Supportable cost/token claims

- M92 (paired, 50/50 valid): tokens −26.7%, cost −25.0%, tool calls −30.2%,
  resolution preserved 20/50 vs 20/50 — the ONLY paired same-protocol
  reduction claim; keep it as the headline reduction evidence.
- M105–M108 vs M73-treatment historical cost on the same cases: M105 +14%
  ($7.66 vs $6.70), M106 −11%, M107 −34%, M108 −10% ($25.27 vs $28.19).
  Directional only (different model days, not paired).
- Cache-read share 93.9% of the 104.6M combined tokens — cost is dominated
  by cache reads; median per-case cost $0.49, p90 $0.95.
- NOT supportable: any guaranteed/universal token-reduction claim;
  tokenizer-accurate budgeting (budgeter is chars/4).

## 16. Supportable safety/leakage claims

Across all 97 valid runs (and the 3 held-back cases' preflights): 0
unexplained model-visible FAIL_TO_PASS/PASS_TO_PASS/gold-patch leakage
(pre-spawn assembled context AND post-run injected-snapshot scans,
base-commit + issue-authored provenance policy); 0 v2→legacy fallback fires;
0 env-guard failures, 0 drift; 0 shell-guard failures, 0 host-pip blocks, 0
conda/pip mutations; 0 unguarded runs; 0 revision/corrective artifacts; 0
behavioral-guard (V4/C7_D) metadata. Claim as measured-zero on this
protocol, NOT "no leakage is possible".

## 17. Claims that must NOT be made

- "VTRACE achieved 56.7% on SWE-bench" / "pass@1 is 56.7%" (internal frozen
  pool, internal harness, n=100, not SWE-bench Verified, not preregistered
  as a public benchmark).
- "100/100 live cases were run" (97 valid + 3 exclusions).
- "VTRACE beats VEXP" / VEXP parity in any form (never measured here).
- "validated on SWE-bench Verified".
- "no leakage is possible" (measured-zero ≠ impossible).
- "token reduction is guaranteed" (workload-dependent; M92 is one paired
  measurement).
- Treating M73/M92 comparisons as controlled same-day baselines (they are
  frozen history on partly different protocol versions).
