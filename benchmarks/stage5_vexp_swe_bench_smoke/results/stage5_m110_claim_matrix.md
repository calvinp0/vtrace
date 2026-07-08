# Stage 5 M110 Claim Matrix

_2026-07-08. Every claim the frozen default path supports, with the allowed wording (reuse verbatim or equivalent), its evidence, scope, denominator, caveats, and the stronger forms that are prohibited. Lines prefixed with ✗ QUOTE prohibited wording — they are listed so nobody uses them._

## deterministic_m94_to_m103

**Claim**: The M95-M103 deterministic chain improved the pre-agent scoreboard from M94 to M103.

**Allowed wording**:

> The M95-M103 deterministic chain improved the pre-agent scoreboard from M94 to M103: recall@5 .637 to .748, all-gold-in-capsule 60.6% to 75.0%, lead-pivot=source-gold 45.5% to 59.0%, hidden-coedit recall .222 to .622, multi-file all-gold 6.7% to 53.3%, miss 30 to 21, wrong_pivot 10 to 7 — at flat median capsule size and p90 -20%. Accepted cost: overpacked capsules 7 to 14.

**Supporting artifacts**:
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m94_deterministic_scoreboard.json`
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m103_deterministic_scoreboard.json`
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m109_final_internal_summary.json`

**Scope**: gold-blind, pre-agent, deterministic scoreboard over the internal 100-case pool (M94 = comparable-99 basis; M103 = new-policy-100 basis)

**Denominator**: 99/100 scored capsules (set bases differ as noted); percentages are over scored cases

**Caveats**:
- pre-agent scoreboard quality, not live resolution
- M94 and M103 sets differ by the leakage-policy change (psf-5414 scoreable only under M103 policy)
- overpacked 7 to 14 is a real accepted regression

**Prohibited stronger forms** (never say):
- ✗ "VTRACE retrieval is validated on SWE-bench"
- ✗ "guaranteed recall improvement on any repository"

## live_97_valid_55_resolved

**Claim**: 97 valid guarded live runs on the frozen internal 100-case pool; 55 resolved.

**Allowed wording**:

> On the frozen internal 100-case Stage 5 pool, the current default VTRACE path produced 97 valid guarded live runs, with 55 resolved patches (56.7% of valid live runs). Three cases were pre-registered no-context exclusions under the parity contract.

**Supporting artifacts**:
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m108_100_case_live_confirmation.json`
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m108_live_runs.detail.json`
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m109_final_internal_summary.json`

**Scope**: internal live confirmation, guarded, digest-ON clean-core protocol; frozen pool only

**Denominator**: ALWAYS report all three numbers: 100 frozen pool cases, 97 valid live runs, 3 pre-registered no-context exclusions; the 56.7% rate is over VALID runs only

**Caveats**:
- not a public SWE-bench pass@1 claim
- single live pass per case; live variance is real (M107/M108 evidence)
- the three sub-samples (M105/M106/M107 vs M108) are not exchangeable — M106/M107 oversampled failure strata

**Prohibited stronger forms** (never say):
- ✗ "VTRACE achieved 56.7% on SWE-bench"
- ✗ "VTRACE pass@1 is 56.7%"
- ✗ "100/100 live cases were run"
- ✗ "VTRACE is validated on SWE-bench Verified"

## no_context_exclusions

**Claim**: 3 pool cases were pre-registered no-context exclusions, never spawned.

**Allowed wording**:

> Three pool cases (django__django-11740, django__django-15572, sphinx-doc__sphinx-9320) are frozen M103 no-context rows: the default path has nothing to inject, a spawned run would be baseline-shaped and parity-invalid, so the preflight held them back. They were pre-registered in the M108 plan, not dropped after the fact.

**Supporting artifacts**:
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m108_100_case_live_confirmation_plan.md`
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m108_live_preflight.detail.json`
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m110_frozen_default_path_manifest.json`

**Scope**: frozen 100-case pool under the M104 parity contract

**Denominator**: 3 of 100 pool cases

**Caveats**:
- these are unattempted, not failures and not resolutions; they cap any pool-denominator rate at 97 attempted

**Prohibited stronger forms** (never say):
- ✗ "100/100 live cases were run"
- ✗ "the exclusions were resolved or would have resolved"

## safety_leakage_measured_zero

**Claim**: Safety/leakage was measured-zero across all 97 valid live runs.

**Allowed wording**:

> Across the 97 valid runs, the default path was leak-clean: zero model-visible FAIL_TO_PASS/PASS_TO_PASS/gold-patch leakage, zero fallback-context fires, zero unguarded env/shell runs, and zero host-pip mutation escapes.

**Supporting artifacts**:
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m105_live_preflight.detail.json`
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m106_live_preflight.detail.json`
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m107_live_preflight.detail.json`
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m108_live_preflight.detail.json`
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m109_final_internal_summary.json`

**Scope**: two-sided scans (pre-spawn assembled context + post-run injected snapshot) with base-commit + issue-authored provenance classification

**Denominator**: 97/97 valid runs; 0 unexplained hits

**Caveats**:
- measured-zero on THIS protocol; never present it as an impossibility guarantee
- raw string scans false-positive on legitimate base-commit content; classification by provenance is part of the contract (M104 finding)

**Prohibited stronger forms** (never say):
- ✗ "no leakage is possible"
- ✗ "the protocol proves leakage cannot occur"

## m92_token_cost_reduction

**Claim**: M92 paired 50-task run: tokens -26.7%, cost -25.0%, resolution preserved.

**Allowed wording**:

> In the one paired same-protocol measurement (M92, 50 tasks, both arms valid), VTRACE reduced total agent tokens by 26.7% and cost by 25.0% (tool calls -30.2%) with resolution preserved (20/50 both arms).

**Supporting artifacts**:
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m92_core_reduction50_validation.json`
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m92_core_reduction50_validation.md`

**Scope**: paired baseline-vs-vtrace, same protocol, same day, 50 tasks; the ONLY same-protocol reduction claim

**Denominator**: 50 paired tasks, both arms valid

**Caveats**:
- pre-dates the M95-M103 retrieval chain and the M103 task derivation (M92 used the old composite task)
- M105-M108 vs-M73 cost deltas (+14%/-11%/-34%/-10%) are directional only — different model days, unpaired
- internal chars/4 budgeter is not tokenizer-accurate

**Prohibited stronger forms** (never say):
- ✗ "token reduction is guaranteed"
- ✗ "VTRACE always reduces tokens by ~25%"

## historical_m73_m92_comparison

**Claim**: Live results are directionally comparable to frozen M73/M92 history.

**Allowed wording**:

> Against frozen history (different run days, partly different protocol versions): strict M73-treatment comparability holds on 93 cases — M73 expectation 64, live 54, per-case agreement 77/93 (82.8%). M73-baseline expectation is 61/97 vs live 55/97. On the 49-case M92 overlap: live 16 vs M92 20, agreement 41/49. The deficit concentrates in the deliberately failure-enriched M106/M107 strata and is dominated by agent-side variance on cases whose capsules carried all gold files.

**Supporting artifacts**:
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m73_final_100_paired_summary.json`
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m109_hard_stratum_analysis.json`
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m109_final_internal_summary.json`

**Scope**: unpaired comparison against frozen historical runs; directional context only

**Denominator**: strict comparable set = 93 (4 pool cases lack a valid M73 treatment row); loose as-reported framing = 81/96 agreement

**Caveats**:
- not controlled arms; not statistically powered as a public claim at n=100
- 13 strict live losses: 10 agent-variance, 1 single-file-patch-on-multifile-gold, 2 deterministic context gaps; 10 of 13 had all gold files in the capsule

**Prohibited stronger forms** (never say):
- ✗ "VTRACE regressed/improved X% vs M73 (as a controlled result)"
- ✗ "live variance has been ruled out"

## boundary_not_public_pass_at_1

**Claim**: BOUNDARY: results are internal, not a public SWE-bench pass@1.

**Allowed wording**:

> This is an internal live confirmation, not a public SWE-bench pass@1 claim and not a VEXP parity claim.

**Supporting artifacts**:
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m109_final_internal_summary.json`

**Scope**: all M105-M108 live numbers

**Denominator**: n/a (boundary statement)

**Caveats**:
- a public claim would need SWE-bench Verified / the official harness under a preregistered protocol

**Prohibited stronger forms** (never say):
- ✗ "VTRACE achieved 56.7% on SWE-bench"
- ✗ "VTRACE pass@1 is 56.7%"
- ✗ "VTRACE is validated on SWE-bench Verified"

## boundary_not_vexp_parity

**Claim**: BOUNDARY: no VEXP parity or superiority claim exists.

**Allowed wording**:

> No VEXP arm was run in the M94-M109 arc. Any VTRACE-vs-VEXP comparison requires a separate preregistered protocol with its own paired design and budget.

**Supporting artifacts**:
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m109_final_internal_summary.json`
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m110_frozen_default_path_manifest.json`

**Scope**: the whole M94-M109 arc

**Denominator**: n/a (boundary statement)

**Caveats**:
- the Stage 5 harness wraps the external vexp-swe-bench runner; that is infrastructure reuse, not a comparison

**Prohibited stronger forms** (never say):
- ✗ "VTRACE beats VEXP"
- ✗ "VTRACE matches VEXP"

## boundary_not_100_of_100_attempted

**Claim**: BOUNDARY: a 100-of-100 live-attempted framing must never be used.

**Allowed wording**:

> 97 of the 100 frozen pool cases were live-attempted (all 97 valid); the remaining 3 are pre-registered no-context exclusions that the default path cannot inject on and therefore never spawned.

**Supporting artifacts**:
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m108_100_case_live_confirmation.json`
- `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m108_live_preflight.detail.json`

**Scope**: frozen 100-case pool

**Denominator**: 97 attempted / 3 excluded / 100 pool

**Caveats**:
- reporting 55/97 without mentioning the 3 exclusions is also non-compliant — the denominator rule requires all three numbers

**Prohibited stronger forms** (never say):
- ✗ "100/100 live cases were run"
- ✗ "55/100 resolved (without the exclusion framing)"
