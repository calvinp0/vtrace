# Stage 5 M70 100-Task Preregistration

Frozen, reproducible plan for a 100-task live confirmation of the VTRACE structured-bounded
treatment **with the pivot-confidence gate** (the M69-validated condition). **Planning /
preregistration only — no live agents, no Docker, no API spend, no 100-task run, no default
promotion.** No retrieval / scoring / ranking / candidate-generation code is touched (this
milestone adds only a deterministic fixture builder, this report, and the JSON fixture).

Treatment = `vtrace-indexed · force-inject · v2 · debug · 8000 · inject-capsule-digest ·
digest-decision-contract · bounded-digest-decisions · compact-digest-injection ·
pivot-confidence-gate`. Model `claude-opus-4-5-20251101` (vexp default; runner does not
override). Fixture: `stage5_m70_100_task_preregistration.json`. Builder:
`run_stage5_m70_preregister_100.ts`.

## Summary

- **Sample size:** **100** tasks.
- **Source pool:** `swe-bench-100.jsonl` (SWE-bench Verified-derived; the **only** dataset on
  disk), **100 instances, 12 repos**, carrying the Verified `difficulty` annotation.
- **Selection method:** **full census of the available pool.** Because the target sample size
  (100) equals the available source-pool size (100), every instance is included and there is
  **zero selection discretion** — the strongest possible anti-cherry-picking stance. Seed 42
  governs only the deterministic **run-queue ordering**, never membership.
- **Repo count:** 12.
- **Repo counts:** django 44, sympy 17, matplotlib 7, sphinx 7, xarray 6, astropy 5,
  requests 4, pytest 4, pylint 2, scikit-learn 2, seaborn 1, flask 1.
- **Complexity balance (Verified difficulty bands):** `<15 min` 38, `15 min–1 h` 53,
  `1–4 h` 8, `>4 h` 1. (A census cannot rebalance complexity — the distribution **is** the
  pool's own.)
- **Planned treatment runs:** **100** (one per instance).
- **Planned reused baselines:** **24** (the verified M62/M69 baselines). **Planned fresh
  baselines:** **76** (upper bound; some may upgrade to reuse at the run-time gate).
- **Expected live-run count:** **100** (Option 1, treatment-only) **to 176** (Option 2,
  treatment + fresh baselines for paired analysis); staged 50+50 available (Option 3).
- **M62/M69 24-task set:** **naturally included** in the census **and** retained as a
  **locked diagnostic subset** (`in_M62_24=true`) for continuity with M55Y→M62→M69.
- **Recommendation:** **Ready for explicit authorization to run a staged 100-task benchmark**
  (see Recommendation). The fixture and source metadata are complete; the only run-time
  prerequisite is the standard live pre-flight gate over fresh-clone indexes.

## M69 Evidence Recap

**Why M69 justifies planning a 100-task run.** On the frozen 24-task set, the
pivot-confidence-gate treatment was **valid in 24/24** runs, emitted both zero-required
contracts only with the explicit `<VTRACE_NO_HIGH_CONFIDENCE_REQUIRED_TARGET>` marker,
demoted only low-confidence pivots (no gold lead demoted, none resolution-critical), lifted
structured-decision coverage to **90.24%** (≥ 90 bar) while improving invalid rule-out to
**7.32%** (< M66's 8.51%), and did so at **lower** pooled cost (**−8.80%**) and tokens
(**−16.96%**) than the reused baseline, with resolution **17/24 vs 15/24** (+2). All 12 M69
success criteria passed.

**Why M69 does *not* justify default promotion or unplanned 100-task execution.** N=24 with a
single replicate per case carries real run-to-run variance (live coverage 90.24% / invalid
7.32% vs the M68 retro-replay's 92.7% / 4.9%); the lone M66→M69 resolution regression
(astropy-14365) was patch-quality variance, not gate-caused; category B remained a cost
outlier (+67% pooled within-category). M69's own verdict was explicit: *proceed to broader
confirmation **planning**; do not promote to default yet; do not start the 100-task run inside
M69.* This preregistration is that planning step — it freezes the sample, comparator, gate,
and scoring **before** any 100-task spend so the result cannot be cherry-picked after the fact.

## Selection Method

- **Source pool.** `swe-bench-100.jsonl` is the only SWE-bench dataset present in the harness
  checkout (`$VEXP/data/`). It is SWE-bench Verified-derived (it carries the Verified
  `difficulty` time-estimate buckets). There is no `swe-bench-verified.jsonl` /
  `swe-bench-500.jsonl` / lite variant on disk to sub-sample from.
- **Exclusions.** **None.** Every instance in the pool is included. The 3 historically
  over-budget cases (`pylint-8898`, `sympy-12419`, `matplotlib-22719`, FAIL_CLOSED at the 12k
  truncation budget in the **pre-M63** M62 replay) are **retained** with an over-budget watch
  flag; all three became **VALID** in the post-M63 M69 live pre-flight, and they are skipped
  at run time **only** if their fresh live pre-flight is not VALID — never excluded here.
- **Seed.** `selection_seed = 42`. Because the sample equals the pool, the seed cannot affect
  membership; it seeds a `mulberry32` PRNG used solely for the **run-queue ordering** (a
  repo-stratified round-robin schedule). The builder is byte-reproducible (verified:
  identical JSON across repeated runs).
- **Stratification.** By repository. With a full census the repo strata **are** the pool's
  natural distribution (django 44%, sympy 17%, …) — no re-weighting is applied or needed; the
  run-queue interleaves repos so partial executions stay repo-balanced.
- **Complexity handling.** SWE-bench Verified difficulty is **4 ordinal bands**, not 5 numeric
  quintiles. We record `complexity_score` (1..4 ordinal), `complexity_band` (the raw label),
  and `complexity_quintile = band_<n>_of_4` as the closest reproducible alternative. No
  numeric complexity score exists in any on-disk artifact, so true quintiles are not
  available; this is documented rather than invented.
- **Anti-cherry-picking safeguards.** (1) Full census ⇒ zero membership discretion. (2) No
  task is added because the treatment did well on it or dropped because it did poorly —
  membership is mechanical. (3) Known VTRACE wins are **not** over-represented (they are the
  24 M62 cases inside the 100; the other 76 are out-of-(prior-)sample). (4) Known losses
  (e.g. the sympy/astropy regression-watch cases) are **kept**. (5) Reuse is credited only
  through a verifiable model-matched gate; everything else gets a fresh baseline.

### Closest reproducible alternative to exact VEXP sampling

The VEXP-style methodology samples 100 tasks from the **full** SWE-bench Verified set
(stratified, complexity-balanced, seed 42). That exact procedure **cannot** be reproduced
here because the full Verified set is not on disk — only the 100-instance derived pool is.
The closest reproducible alternative, and the one adopted, is a **full census of the available
pool**: it preserves the "no cherry-picking, fixed seed, stratified by repo, all represented
repositories, honest reporting" spirit while removing sampling discretion entirely. The cost
is that the repo mix is inherited (django-heavy, 44%) rather than re-balanced, and complexity
is 4 bands rather than 5 quintiles — both documented below.

## Selected Instances

`in24` = member of the frozen M62/M69 24-task locked diagnostic subset. `baseline`:
**R**=reused (verified gate), **F**=fresh required (default; may upgrade at run-time gate).
`band` = complexity ordinal 1..4 (`<15m / 15m–1h / 1–4h / >4h`). Full per-task fields
(`source_pool`, `selection_method`, `run_queue_position`, `expected_preflight_status`,
`planned_treatment_run_label`, `notes`, …) live in the JSON fixture.

| # | instance_id | repo | band | in24 | baseline |
|--:|---|---|:-:|:-:|:-:|
| 1 | astropy__astropy-14365 | astropy | 2 | Y | R |
| 2 | astropy__astropy-14369 | astropy | 3 | Y | R |
| 3 | astropy__astropy-14539 | astropy | 2 | Y | R |
| 4 | astropy__astropy-14598 | astropy | 2 | Y | R |
| 5 | astropy__astropy-7166 | astropy | 1 | - | F |
| 6 | django__django-10880 | django | 1 | Y | R |
| 7 | django__django-10973 | django | 2 | - | F |
| 8 | django__django-11095 | django | 2 | Y | R |
| 9 | django__django-11133 | django | 1 | - | F |
| 10 | django__django-11206 | django | 2 | - | F |
| 11 | django__django-11490 | django | 1 | - | F |
| 12 | django__django-11728 | django | 2 | - | F |
| 13 | django__django-11740 | django | 2 | Y | R |
| 14 | django__django-11749 | django | 2 | - | F |
| 15 | django__django-11815 | django | 2 | - | F |
| 16 | django__django-11820 | django | 1 | Y | R |
| 17 | django__django-12050 | django | 2 | - | F |
| 18 | django__django-12273 | django | 2 | - | F |
| 19 | django__django-12276 | django | 1 | - | F |
| 20 | django__django-12325 | django | 3 | - | F |
| 21 | django__django-12774 | django | 2 | - | F |
| 22 | django__django-12858 | django | 2 | - | F |
| 23 | django__django-13012 | django | 2 | - | F |
| 24 | django__django-13112 | django | 1 | - | F |
| 25 | django__django-13195 | django | 2 | Y | R |
| 26 | django__django-13363 | django | 1 | - | F |
| 27 | django__django-13512 | django | 1 | - | F |
| 28 | django__django-13513 | django | 2 | - | F |
| 29 | django__django-13551 | django | 1 | - | F |
| 30 | django__django-13590 | django | 2 | - | F |
| 31 | django__django-13658 | django | 2 | - | F |
| 32 | django__django-13810 | django | 2 | - | F |
| 33 | django__django-13820 | django | 2 | - | F |
| 34 | django__django-14608 | django | 1 | - | F |
| 35 | django__django-14792 | django | 1 | - | F |
| 36 | django__django-15037 | django | 2 | - | F |
| 37 | django__django-15503 | django | 3 | - | F |
| 38 | django__django-15572 | django | 1 | - | F |
| 39 | django__django-15695 | django | 2 | - | F |
| 40 | django__django-15731 | django | 2 | - | F |
| 41 | django__django-16256 | django | 2 | - | F |
| 42 | django__django-16263 | django | 3 | - | F |
| 43 | django__django-16333 | django | 1 | - | F |
| 44 | django__django-16569 | django | 1 | - | F |
| 45 | django__django-16667 | django | 2 | - | F |
| 46 | django__django-16819 | django | 2 | - | F |
| 47 | django__django-16877 | django | 2 | - | F |
| 48 | django__django-16938 | django | 2 | - | F |
| 49 | django__django-17084 | django | 2 | - | F |
| 50 | matplotlib__matplotlib-22719 | matplotlib | 1 | Y | R |
| 51 | matplotlib__matplotlib-24627 | matplotlib | 2 | Y | R |
| 52 | matplotlib__matplotlib-24870 | matplotlib | 2 | - | F |
| 53 | matplotlib__matplotlib-24970 | matplotlib | 2 | - | F |
| 54 | matplotlib__matplotlib-25332 | matplotlib | 1 | - | F |
| 55 | matplotlib__matplotlib-25960 | matplotlib | 2 | Y | R |
| 56 | matplotlib__matplotlib-26466 | matplotlib | 2 | - | F |
| 57 | mwaskom__seaborn-3187 | mwaskom | 2 | Y | R |
| 58 | pallets__flask-5014 | pallets | 1 | Y | R |
| 59 | psf__requests-1142 | psf | 1 | Y | R |
| 60 | psf__requests-1724 | psf | 1 | - | F |
| 61 | psf__requests-1921 | psf | 1 | - | F |
| 62 | psf__requests-5414 | psf | 1 | Y | R |
| 63 | pydata__xarray-2905 | pydata | 2 | - | F |
| 64 | pydata__xarray-3677 | pydata | 2 | Y | R |
| 65 | pydata__xarray-4695 | pydata | 2 | - | F |
| 66 | pydata__xarray-6599 | pydata | 2 | - | F |
| 67 | pydata__xarray-6938 | pydata | 2 | - | F |
| 68 | pydata__xarray-6992 | pydata | 4 | - | F |
| 69 | pylint-dev__pylint-4551 | pylint-dev | 3 | - | F |
| 70 | pylint-dev__pylint-8898 | pylint-dev | 3 | Y | R |
| 71 | pytest-dev__pytest-10051 | pytest-dev | 2 | - | F |
| 72 | pytest-dev__pytest-5262 | pytest-dev | 1 | - | F |
| 73 | pytest-dev__pytest-6197 | pytest-dev | 3 | - | F |
| 74 | pytest-dev__pytest-7432 | pytest-dev | 1 | Y | R |
| 75 | scikit-learn__scikit-learn-10844 | scikit-learn | 2 | - | F |
| 76 | scikit-learn__scikit-learn-11578 | scikit-learn | 2 | - | F |
| 77 | sphinx-doc__sphinx-7462 | sphinx-doc | 1 | Y | R |
| 78 | sphinx-doc__sphinx-7748 | sphinx-doc | 2 | - | F |
| 79 | sphinx-doc__sphinx-7910 | sphinx-doc | 1 | - | F |
| 80 | sphinx-doc__sphinx-9230 | sphinx-doc | 1 | - | F |
| 81 | sphinx-doc__sphinx-9320 | sphinx-doc | 1 | - | F |
| 82 | sphinx-doc__sphinx-9698 | sphinx-doc | 1 | - | F |
| 83 | sphinx-doc__sphinx-9711 | sphinx-doc | 1 | - | F |
| 84 | sympy__sympy-12419 | sympy | 2 | Y | R |
| 85 | sympy__sympy-12481 | sympy | 1 | Y | R |
| 86 | sympy__sympy-13372 | sympy | 1 | Y | R |
| 87 | sympy__sympy-13480 | sympy | 1 | - | F |
| 88 | sympy__sympy-13974 | sympy | 2 | - | F |
| 89 | sympy__sympy-15599 | sympy | 2 | - | F |
| 90 | sympy__sympy-15875 | sympy | 1 | - | F |
| 91 | sympy__sympy-16597 | sympy | 3 | - | F |
| 92 | sympy__sympy-16766 | sympy | 1 | Y | R |
| 93 | sympy__sympy-16792 | sympy | 2 | - | F |
| 94 | sympy__sympy-18189 | sympy | 1 | - | F |
| 95 | sympy__sympy-19637 | sympy | 1 | - | F |
| 96 | sympy__sympy-20428 | sympy | 2 | - | F |
| 97 | sympy__sympy-20801 | sympy | 2 | - | F |
| 98 | sympy__sympy-23413 | sympy | 2 | - | F |
| 99 | sympy__sympy-24213 | sympy | 2 | - | F |
| 100 | sympy__sympy-24562 | sympy | 1 | - | F |

### Locked diagnostic subset (M62/M69 24) — full detail

Carried verbatim from the frozen `stage5_m62_structured_bounded_24_preregistration.json`
(category A–E, baseline reuse). These 24 anchor the M55Y→M62→M69 continuity analysis.

| instance_id | repo | cat | band | quintile | baseline | notes |
|---|---|:-:|:-:|---|:-:|---|
| sphinx-doc__sphinx-7462 | sphinx | A | 1 | band_1_of_4 | reused | locked sentinel |
| django__django-11820 | django | A | 1 | band_1_of_4 | reused | locked sentinel |
| django__django-13195 | django | D | 2 | band_2_of_4 | reused | locked sentinel |
| matplotlib__matplotlib-24627 | matplotlib | A | 2 | band_2_of_4 | reused | digest-attributable win |
| mwaskom__seaborn-3187 | seaborn | A | 2 | band_2_of_4 | reused | |
| sympy__sympy-13372 | sympy | A | 1 | band_1_of_4 | reused | |
| matplotlib__matplotlib-22719 | matplotlib | A | 1 | band_1_of_4 | reused | over-budget watch |
| astropy__astropy-14539 | astropy | B | 2 | band_2_of_4 | reused | |
| pydata__xarray-3677 | xarray | B | 2 | band_2_of_4 | reused | |
| pylint-dev__pylint-8898 | pylint | B | 3 | band_3_of_4 | reused | over-budget watch |
| sympy__sympy-12419 | sympy | B | 2 | band_2_of_4 | reused | over-budget watch; zero-required (M69) |
| astropy__astropy-14365 | astropy | C | 2 | band_2_of_4 | reused | |
| pytest-dev__pytest-7432 | pytest | C | 1 | band_1_of_4 | reused | |
| matplotlib__matplotlib-25960 | matplotlib | C | 2 | band_2_of_4 | reused | |
| psf__requests-1142 | requests | C | 1 | band_1_of_4 | reused | |
| sympy__sympy-12481 | sympy | C | 1 | band_1_of_4 | reused | |
| astropy__astropy-14598 | astropy | D | 2 | band_2_of_4 | reused | |
| pallets__flask-5014 | flask | D | 1 | band_1_of_4 | reused | |
| django__django-10880 | django | E | 1 | band_1_of_4 | reused | baseline-strong control |
| psf__requests-5414 | requests | E | 1 | band_1_of_4 | reused | baseline-strong control |
| sympy__sympy-16766 | sympy | E | 1 | band_1_of_4 | reused | baseline-strong control |
| astropy__astropy-14369 | astropy | E | 3 | band_3_of_4 | reused | baseline-strong control |
| django__django-11095 | django | E | 2 | band_2_of_4 | reused | baseline-strong control |
| django__django-11740 | django | E | 2 | band_2_of_4 | reused | baseline-strong control; zero-required (M69) |

## Repo / Complexity Balance

Full census ⇒ both distributions equal the source pool's own (no comparison-to-pool gap).

| repo | n | `<15m` | `15m–1h` | `1–4h` | `>4h` | in M62/69 | reused base | fresh base |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| django/django | 44 | 14 | 27 | 3 | 0 | 5 | 5 | 39 |
| sympy/sympy | 17 | 8 | 8 | 1 | 0 | 4 | 4 | 13 |
| matplotlib/matplotlib | 7 | 2 | 5 | 0 | 0 | 3 | 3 | 4 |
| sphinx-doc/sphinx | 7 | 6 | 1 | 0 | 0 | 1 | 1 | 6 |
| pydata/xarray | 6 | 0 | 5 | 0 | 1 | 1 | 1 | 5 |
| astropy/astropy | 5 | 1 | 3 | 1 | 0 | 4 | 4 | 1 |
| psf/requests | 4 | 4 | 0 | 0 | 0 | 2 | 2 | 2 |
| pytest-dev/pytest | 4 | 2 | 1 | 1 | 0 | 1 | 1 | 3 |
| pylint-dev/pylint | 2 | 0 | 0 | 2 | 0 | 1 | 1 | 1 |
| scikit-learn/scikit-learn | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 2 |
| mwaskom/seaborn | 1 | 0 | 1 | 0 | 0 | 1 | 1 | 0 |
| pallets/flask | 1 | 1 | 0 | 0 | 0 | 1 | 1 | 0 |
| **TOTAL** | **100** | **38** | **53** | **8** | **1** | **24** | **24** | **76** |

**Notes.** (1) **django skew** — django is 44% of the pool; report MUST present per-repo and
django-excluded results so no single repo dominates the headline. (2) **scikit-learn** (2
instances) appears in the 100 but is **not** in the M62 24 — these are genuinely
out-of-prior-sample. (3) Complexity is concentrated in bands 1–2 (91/100); bands 3 (8) and 4
(1) are thin, so complexity-stratified results for the hard tail are low-power and must be
reported as such.

## Planned Execution Protocol

**Treatment flags (per VALID case):**
```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances <INSTANCE_ID> \
  --run-label m70_structured_bounded_<SAFE> \
  --show-vtrace-index-log \
  --context-policy force-inject --capsule-engine v2 \
  --capsule-intent debug --capsule-budget 8000 \
  --inject-capsule-digest --digest-decision-contract \
  --bounded-digest-decisions --compact-digest-injection \
  --pivot-confidence-gate \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**Fresh baseline (per fresh-needed case, or when a reused baseline fails the reuse gate):**
```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol --protocol baseline \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances <INSTANCE_ID> \
  --run-label m70_baseline_<SAFE> \
  --show-vtrace-index-log \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**Docker evaluation (per produced patch):**
```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate --eval-mode docker \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --run-label m70_structured_bounded_<SAFE> \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

- **Model / scaffold class.** vexp-swe-bench default `claude-opus-4-5-20251101` (runner does
  not override) — the same class as all reused baselines, preserving model-match. Confirm
  per-case at run time.
- **Turn / cost limits.** Inherited from the vexp-swe-bench harness (not overridden). No hard
  per-run cost cap; **reporting guardrail:** flag any run > $5 as a cost outlier (M69 max was
  astropy-14598 at $3.01).
- **Baseline protocol.** `baseline` — the vexp default scaffold with **no** vtrace context
  injection.

### Baseline strategy

- **Reuse gate (per case).** A baseline is reusable only if: same `instance_id`; Stage 5
  vexp-swe-bench harness family; patch + Docker `_eval.meta.json` present; token/cost/tool
  telemetry present; not known-invalid; **and** the recorded model equals the live M70
  treatment model.
- **Pre-approved reuse (24).** Exactly the M62/M69 baselines (verified same-instance,
  model-matched `opus-4-5`, Docker-evaluated, captured in the committed M69 detail artifact).
- **Fresh needed (76).** The remaining instances default to a fresh baseline. ~23 distinct
  baseline run dirs exist on disk (some non-M62, e.g. sphinx-7748, django-11728), which **may**
  upgrade specific cases to reuse **iff** they pass the run-time gate — **not assumed** here,
  so 76 is an upper bound on fresh baselines.

### Pre-flight gate (mandatory first gate; per VALID treatment case)

Re-run the non-agent render-path pre-flight (à la `run_stage5_m69_preflight.ts`, with the full
treatment flag set **including `--pivot-confidence-gate`**) over fresh-clone indexes. Each case
must satisfy:

1. digest `START`/`END` present **exactly once**;
2. decision-contract `START`/`END` present **exactly once**;
3. a real non-warning `→ impact` section;
4. bounded structured grammar (`target_id` / `decision` / `reason` / `files_touched` + the
   three-way `EDIT | RULE_OUT | INSPECT_ONLY_NO_EDIT`) **OR** the explicit
   `<VTRACE_NO_HIGH_CONFIDENCE_REQUIRED_TARGET>` marker for a zero-required case;
5. compact mode applied (no duplicate `## VTRACE inspect-first`);
6. pivot-confidence gate enabled;
7. no partial sentinel block;
8. **no required IMPACT targets** (`required_impact_any=false`);
9. optional/FYI impact context present wherever impact reps exist;
10. O-prefixed optional IDs do not collide with T-required IDs.

A **zero-required** contract is valid **only** if `<VTRACE_NO_HIGH_CONFIDENCE_REQUIRED_TARGET>`
is present.

### Stop conditions

Stop and report rather than continue if **any** of:
- pre-flight produces any **partial sentinel** (would mean an atomic-truncation regression);
- **fewer than 90** selected cases are VALID at pre-flight;
- **required IMPACT** targets appear;
- the **confidence gate is missing** from any treatment render;
- artifact extraction **cannot verify** treatment validity;
- baseline reuse fails enough cases that fresh baselines would exceed the authorized cap;
- the runner/vexp workspace/evaluator is unavailable or the raw artifact layout changed enough
  that metrics cannot be extracted.

### Staged execution options

| Option | Composition | Live runs | Use when |
|---|---|--:|---|
| **1** | 100 treatment only; reuse the 24 baselines; report the 76 fresh-baseline cases as treatment-only (unpaired) | 100 | minimize spend; accept unpaired analysis for 76 |
| **2** | 100 treatment + 76 fresh baselines (full paired) | 176 | methodologically complete paired comparison |
| **3** | Option 2 split as **50 + 50** halves of the **same frozen fixture** | 176 (2×88) | operational batching; **no** mid-course selection change |

No stage is authorized in M70. Live runs must remain **sequential** (the first pass writes a
shared `_agent_stream.jsonl`).

## Metrics and Scoring

The future 100-task live report must extract, per case and condition:

- **Identity / provenance:** `instance_id, repo, condition, run_label, baseline_source
  (reused|fresh), baseline_model_match, preflight_status, valid_run, invalid_reason`.
- **Resolution:** `patch_produced, resolved`.
- **Cost / token / effort:** `cost, duration_ms, input/output/cache_read/cache_write/total
  tokens, turn_count, tool_call_count, Read count, Search/Grep count, Edit/Write count,
  repeated_file_reads`.
- **Structured-contract validity:** `digest_present, impact_present,
  decision_contract_present, structured_grammar_present, bounded_contract_present,
  compact_mode_applied, pivot_confidence_gate_enabled,
  no_high_confidence_required_marker_present`.
- **Impact (must be optional/FYI only):** `required_impact_target_count (must be 0),
  optional_impact_context_present, optional_impact_id_count, optional_context_targets,
  optional_context_inspected, optional_context_edited`.
- **Required-target decisions & gate:** `required_target_count, required_targets,
  demoted_pivot_count, demoted_pivots, demotion_reasons, required_target_closed_count,
  required_target_open_count, required_target_ignored_count,
  required_target_invalid_decision_count, decision_coverage, ignored_rate,
  invalid_rule_out_rate`.
- **Over-anchoring:** `edited_files, off_target_edit_count`.

**Validity rule.** A treatment run is valid only if its injected snapshot carries the digest +
contract sentinels (each once) + real `→ impact` + bounded grammar (or the explicit
zero-required marker) + compact + gate-enabled + **zero** required IMPACT targets. Sentinels
are detected by the M59/M69 structured parser, not generic glyphs.

**Statistical reporting plan.** Report: pass counts; paired outcomes (both_pass / both_fail /
treatment-only / baseline-only); net wins/losses; cost/token deltas (mean, median, pooled);
**a Wilson/Clopper-Pearson confidence interval for the pass rate**; **a confidence interval
for the paired difference** (e.g. McNemar / bootstrap) where the paired subset supports it;
per-repo outcomes; and category/complexity-stratified outcomes (A–E for the 24; difficulty
bands for all 100, flagging the thin bands 3–4 as low-power). Headline numbers must be
reported **both** with and without the django stratum.

## Success / Mixed / Fail Criteria

**Strict PASS** (all must hold):
1. treatment valid in **≥ 95/100** attempted runs;
2. resolution **not worse** than the comparable baseline;
3. treatment-only wins **≥** baseline-only losses;
4. required-target decision coverage **≥ 90%**;
5. ignored required-target rate **≤ 5%**;
6. invalid rule-out rate **does not exceed M69 (7.32%) by more than 2 pp** (i.e. ≤ ~9.3%);
7. **no** required IMPACT targets emitted;
8. optional/FYI targets **not** closure-scored;
9. pooled cost regression vs baseline **≤ +15%**;
10. **no** evidence of systematic over-anchoring on baseline-strong (E) controls.

**Practical MIXED / FAVORABLE:** resolution parity-or-better, cost lower or within +15%,
validity high, structured-decision metrics acceptable, but **one** secondary criterion misses
narrowly.

**FAIL:** resolution worse than baseline by **> 2 tasks**; OR validity **< 90%**; OR cost
regression **> 25%** without a resolution gain; OR structured-decision metrics regress **below
M66** (coverage 85.11% / invalid rule-out 8.51%).

**INVALID:** sentinel/contract/impact missing, artifact matrix incomplete, the confidence gate
absent from renders, or metrics not extractable.

**Required reporting layers:** (a) full attempted-set result incl. invalids; (b) valid-only
result; (c) per-repo and **django-excluded** result; (d) category-stratified (A–E on the 24)
and difficulty-band-stratified (all 100) result; (e) baseline-strong (E) control no-hurt
result; (f) M70-vs-M69 stability on the shared 24.

## Non-claims

- This preregistration does **not** claim VTRACE beats VEXP.
- It does **not** claim a broad SWE-bench pass@1 improvement.
- It does **not** make any statistical-superiority claim until the run is executed and
  analyzed.
- **A 100-task census supports a stronger engineering claim than the 24-task set, but still
  does not prove general SWE-bench superiority unless the sampling and comparator are fully
  aligned.** Here the comparator is a reused/fresh baseline on the same harness/model class and
  the sample is the full available 100-pool — a strong *internal* comparison, not a claim about
  the full Verified set or about VEXP's own scaffold.

## Recommendation

**Ready for explicit authorization to run the staged 100-task benchmark.**

The fixture is frozen and de-risked: the sample is a **full census** of the only available
SWE-bench Verified-derived pool (no cherry-picking possible), every instance is present with
repo + difficulty metadata, the M62/M69 24 are retained as a locked diagnostic subset, the
treatment and gate are unchanged from the M69-validated condition, baselines are model-matched
for 24 and fresh-needed for 76 (upper bound), and the pre-flight gate + stop conditions are
specified. The remaining prerequisites are **operational, not design**: (1) re-run the live
pre-flight over fresh-clone indexes (expected ≥ 95 VALID given M69's 24/24 post-M63), and (2)
choose an execution option and a live-run cap.

**Suggested authorization:** **Option 2 (100 treatment + 76 fresh baselines, 176 live runs)**
for a fully paired comparison, executed as **Option 3's 50+50 split** for operational safety —
or **Option 1 (100 treatment, 100 runs)** if spend must be minimized, accepting unpaired
analysis for the 76 fresh-baseline cases. **Do not** promote the gate to default on the basis
of this plan; promotion is a separate decision after the 100-task result is analyzed.

---

### Provenance

- Source pool: `/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl` (100 instances, the
  only dataset on disk; SWE-bench Verified `difficulty` annotation).
- Locked diagnostic subset + baseline hints + categories:
  `stage5_m62_structured_bounded_24_preregistration.json`.
- Treatment validation justifying this plan: `stage5_m69_pivot_confidence_24_live_validation.{md,json}`.
- Builder (deterministic, report-only): `run_stage5_m70_preregister_100.ts`.
- Frozen fixture: `stage5_m70_100_task_preregistration.json`.
