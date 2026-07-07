# Stage 5 M109 Final Internal VTRACE Summary

_2026-07-07. Closes the M94–M108 deterministic-improvement + live-confirmation
arc. No-spend milestone: no live agents, no Docker, no API calls; every number
recomputed from committed artifacts (see
`stage5_m109_final_analysis_notes.md` for the working derivations and
`stage5_m109_hard_stratum_analysis.json` for the per-case flip analysis)._

## Executive Summary

- **Final status**: the current default VTRACE path (M95–M104) is **frozen**.
  It is live-validated over the full frozen internal 100-case Stage 5 pool
  with a clean safety/parity sweep.
- **Deterministic result** (gold-blind pre-agent scoreboard, M94 → M103):
  recall@5 .637 → .748, any-gold-in-capsule 69.7% → 79.0%, all-gold 60.6% →
  75.0%, lead-pivot=source-gold 45.5% → 59.0%, hidden-coedit recall .222 →
  .622, multi-file all-gold 6.7% → 53.3%, miss class 30 → 21, wrong_pivot 10
  → 7 — at flat median capsule size (1077 → 1096 est. tokens) and smaller p90
  (4447 → 3536).
- **Live result**: 97 valid guarded live runs over the frozen 100-case pool,
  **55 resolved (56.7% of valid live runs)**, with 3 pre-registered
  no-context exclusions. Total $56.69 / 104.6M tokens / 93.9% cache-read.
- **Safety/leakage**: measured-zero across all 97 valid runs — 0 unexplained
  model-visible FAIL_TO_PASS/PASS_TO_PASS/gold-patch leakage, 0 legacy
  fallback fires, 0 env/shell-guard failures, 0 drift, 0 host-pip blocks, 0
  unguarded runs, 0 revision/corrective artifacts.
- **Recommended next action**: freeze + internal package/report; no more live
  spend until the analysis questions below are exhausted (ranked list in
  Recommended Next Steps).

## What Changed

**M95–M103 product (deterministic-path) changes**, in order:

| # | change | headline effect |
| --- | --- | --- |
| M95 | genericInfra strong-lexical fix (func/method only) | holdout r@1 +2.5pts |
| M96 | direct-evidence anchoring (issue-text mention lanes) | dev r@5 +8.9pts |
| M97 | bounded hidden co-edit expansion | multi-file all-gold 6.7%→40%; cost: overpacked 11→18 |
| M98 | co-edit confidence tiers (subtractive pruning) | mean files 4.32→3.92, overpacked 18→14, 0 gold lost |
| M99 | file-level import scan + import_reexport_rescue lane | multi-file all-gold →46.7% (django-16256) |
| M100 | file-evidence deep-pool rescue | all-gold →72.7%, multi-file →53.3% (django-13195) |
| M101 | anchored-target pivot guard | wrong_pivot 11→8, lead=src-gold +3pts, retrieval-eval top-1 80→85% |
| M103 | structured task derivation (V5 shape) as DEFAULT + provenance leakage policy | r@1 +.035, miss 24→21, holdout r@5 +3.8 / lead +5.1; smaller capsules |

**M104 (live-path parity)**: the live task builder now returns the shared
M103 derivation — live and deterministic tasks are the same function; the
pre-M104 live composite (full problem statement + `failing tests:
<FAIL_TO_PASS>` + hints) is gone, which both removed a hidden-label
contamination channel and made live runs attributable.

**M105–M108 (live confirmations, no behavior change)**: 14 → 24 → 50 → 100
cases under one artifact-reuse contract (shape-validated adapter,
bit-identical re-aggregation, overlap guards; committed runs never rerun).

**Diagnostics/report-only**: M94 (baseline scoreboard), M102 (derivation
variant audit), M109 (this). **Default-off throughout**: V4 tool-loop guard,
C7_D cost guard, M12 enforcement, M14/M15 revision/corrective passes,
rule-out corrective, M7.3 traceback skip, VEXP, all baseline arms.

## Final Default Path

- **Task**: `deriveStructuredTaskFromProblemStatement` — V0 base + exceptions
  ≤6 + issue-mentioned failing tests ≤6 + traceback frames ≤8, 1200-char cap;
  shared by deterministic scoreboard and live runner (M104).
- **Retrieval/capsule**: Capsule v2 + the M95–M101 chain (strong-lexical fix,
  direct-evidence lanes, tiered co-edit expansion, import/file-evidence
  rescues, anchored pivot guard).
- **Live flags** (M92/M105 clean-core): force-inject, v2 engine, intent
  debug, budget 8000, digest + decision contract + bounded decisions +
  compact injection + pivot-confidence gate.
- **Disabled arms**: V4, C7_D, pivot-inspection enforcement, revision/
  corrective passes, VEXP, baselines, unguarded escape hatch.
- **Safety requirements (mandatory, fail-closed)**: M89 env guard + drift
  check + pinned testbed prefix; M90A agent shell guard + host-pip firewall.
- **Validity constraints**: preflight parity gate pre-spawn (byte-exact task
  vs frozen M103 row; assembled-context leak scan with base-commit +
  issue-authored provenance; fallback probe); post-run: v2 effective (any
  legacy fallback = parity-invalid), context injected, guards pass, no
  drift/unguarded/revision/behavioral-guard artifacts, parseable result row,
  snapshot leak-scan clean.

## Deterministic Core Result

M94 baseline → M103 final (all-scored; M94 = comparable-99, M103 =
new-policy-100):

| metric | M94 | M103 | Δ |
| --- | ---: | ---: | ---: |
| recall@1 / @3 / @5 / @10 | .443 / .602 / .637 / .647 | .568 / .684 / .748 / .768 | +.125 / +.082 / +.111 / +.121 |
| any-gold / all-gold in capsule | 69.7% / 60.6% | 79.0% / 75.0% | +9.3 / +14.4pts |
| lead pivot = source gold | 45.5% | 59.0% | +13.5pts |
| hidden-coedit recall | .222 | .622 | +.400 |
| multi-file all-gold | 6.7% | 53.3% | +46.6pts |
| excellent / good | 31 / 16 | 32 / 24 | +1 / +8 |
| miss / wrong_pivot / partial | 30 / 10 / 5 | 21 / 7 / 2 | −9 / −3 / −3 |
| overpacked | 7 | 14 | **+7 (accepted cost)** |
| median / p90 capsule est. tokens | 1077 / 4447 | 1096 / 3536 | flat / −20% |

Biggest movers: M97 (multi-file recall), M103 (task evidence + holdout), M101
(pivot ordering). **Remaining deterministic bottlenecks**: 21 miss-class
cases (retrieval never reaches the gold; M100 measured the addressable slice
as mined-out at current precision standards), 14 overpacked capsules (the
M97 recall trade; the lever is packing, not derivation — M103 finding), 7
wrong_pivot (weak-direct-lane golds, deliberate M96 conservatism), 3
no-context cases (below), and the M103 regression guards (django-13513
facade lead; matplotlib-22719/xarray-4695 overpacked rank shifts).

## Live Confirmation Result

| set | n | valid | resolved | rate of valid | cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| M105 | 14 | 14 | 6 | 42.9% | $7.66 |
| M106 ext | 10 | 10 | 3 | 30.0% | $7.09 |
| M107 ext | 26 | 26 | 8 | 30.8% | $16.66 |
| M108 ext | 50 | 47 | 38 | 80.9% | $25.27 |
| **combined** | **100** | **97** | **55** | **56.7%** | **$56.69** |

- Denominator framing (always report all three): **100 frozen pool cases**,
  **97 valid live runs** (0 invalid runs — every spawned run passed the full
  validity contract), **3 pre-registered no-context exclusions**
  (django-11740, django-15572, sphinx-9320: frozen M103
  `capsule.mode=no_context`; nothing to inject; a spawned run would be
  baseline-shaped and parity-invalid, so the preflight held them back).
- Tokens 104.6M total, 93.9% cache-read; median case $0.49, p90 $0.95; 1008
  tool calls; 96/97 produced patches (django-13513 no-patch, counted
  unresolved).
- Safety/parity: clean sweep (see Safety and Validity).

## Historical Comparison

All comparisons are against FROZEN history (different run days, partly
different protocol versions) — directional context, not controlled arms, and
not statistically powered as a public claim at n=100.

- **M73 treatment (strict comparability, primary)**: 4 pool cases have no
  valid M73 treatment row (django-10973 skipped; astropy-14598,
  django-13513, django-15503 attempted-but-invalid). On the 93
  attempted∩valid cases: M73 expectation **64/93**, live **54/93**, per-case
  agreement **77/93 (82.8%)**. As previously reported in M105–M108 (raw
  booleans, only 10973 excluded): 81/96 agreement, 55/97 vs 66/100.
- **M73 baseline**: valid baseline rows exist for all 97 attempted cases:
  expectation **61/97** vs live 55/97.
- **M92 overlap** (pre-M95 retrieval + old composite task): 49 of the M92 50
  were live-attempted: live **16/49** vs M92 **20/49**, agreement 41/49.
- **Per-case agreement by set (strict)**: M105 13/13, M106 7/10, M107 15/24,
  M108 42/46.
- **Live resolution by M103 deterministic class (97 valid)**: excellent
  19/32, good 14/24, overpacked 9/14, miss 11/18, wrong_pivot 2/7, partial
  0/2. Capsule quality predicts live outcome at the extremes; the miss class
  is surprisingly agent-recoverable (61%) — absent context is less harmful
  than wrong leads.

## Hard-Stratum Analysis

(Per-case detail: `stage5_m109_hard_stratum_analysis.json` — all 36 M106/M107
cases + the named M105/M108 cases, strict M73 comparability, documented
reason heuristic.)

- **Selection effect**: M106/M107 deliberately oversampled failure classes
  (wrong_pivot 5, miss 8, partial/overpacked 5, multi-file 3, plus
  M73-unresolved excellent/good). M108 then took the success-heavy
  complement (M73 expectation 43/50). The three live samples are therefore
  NOT exchangeable — headline rates per set mean little; per-case agreement
  is the comparable quantity.
- **Failure concentration**: of the 13 strict live-losses across 97 runs, 9
  sit in M106/M107. Reason split over the 9: **6 agent-variance**
  (astropy-7166, django-12273, django-12774, matplotlib-25960,
  django-12325, matplotlib-24627 — good/excellent/overpacked capsules with
  gold substantially present, agent patch failed), **1
  single-file-patch-on-multi-file gold** (xarray-6938 — the capsule carried
  BOTH gold files), **2 deterministic context gaps** (pytest-6197,
  sympy-15875 — miss-class). M108 added 4 agent-variance losses
  (django-11490, django-13551, sympy-16766, sympy-23413). 10 of the 13
  losses had ALL gold files in the capsule.
- **Wins**: astropy-14365 (M106, excellent capsule, M73-unresolved →
  resolved), sympy-12419 + sympy-24562 (M107, both M103-overpacked,
  M73-unresolved → resolved), django-10973 (M108, no valid M73 row,
  resolved). With astropy-14539 and pylint-8898 (agreement-resolves), the
  full standing M7.x live-regression list (12419, 14539, 8898) is recovered
  under the current path.
- **Named-case notes**: astropy-7166 = cheapest loss ($0.32, 4 tools; agent
  under-explored a good capsule); xarray-6938 = context was complete, patch
  shape wrong; django-16263 + pylint-4551 = the two high-cost tool-loop
  signatures ($3.01/38 tools, $1.38/27 tools — the M78 edit-churn ceiling,
  guard stays default-off by prior evidence); django-11490/13551 = excellent
  capsules, live coin-flips (11490 has flipped across many historical runs).
- **What this means**: the live deficit vs M73 is dominated by agent-side
  variance on hard-stratum cases (9 of 12 losses had all gold in the
  capsule), not by retrieval/context regressions. There is no cluster that
  indicts the M95–M104 chain; the two context-gap losses are known
  miss-class cases the deterministic bottleneck list already covers.

## Cost and Token Analysis

- Combined: $56.69, 104.6M tokens, 93.9% cache-read (cost is dominated by
  cache reads — per-case median $0.49, p90 $0.95).
- Per milestone: M105 $7.66 (vs M73-treat $6.70 on same cases, +14%), M106
  $7.09 (−11%), M107 $16.66 (−34%), M108 $25.27 (−10% vs $28.19). Every
  extension came in under its pre-registered pause cap.
- **Supportable token/cost claims**: the paired M92 result remains the only
  same-protocol reduction claim — tokens −26.7%, cost −25.0%, tool calls
  −30.2% at preserved resolution (20/50 both arms). The M105–M108 vs-M73
  cost deltas are directional only (different model days, unpaired).
- **Not supportable**: guaranteed/universal token reduction;
  tokenizer-accurate budgeting (the budgeter is chars/4 character-based).

## Safety and Validity

- **Env guard (M89)**: mandatory fail-closed; pass + benchmark-valid on all
  97 runs; drift check armed, 0 drift.
- **Shell guard / host-pip firewall (M90A)**: pass on all 97; 0 blocked host
  package commands, 0 conda/pip mutations; unguarded escape hatch never used.
- **Leakage policy**: two-sided scans (pre-spawn assembled context + post-run
  injected snapshot) for FAIL_TO_PASS / PASS_TO_PASS / gold-patch content /
  gold added lines / full problem statement, classified by base-commit and
  issue-authored provenance — 0 unexplained hits across the arc.
- **Fallback invalidity**: the v2→legacy fallback (which still packs
  FAIL_TO_PASS into the retrieval query) fired 0 times; any fire counts a
  run parity-invalid by contract.
- **Revision/corrective arms off**: 0 artifacts; behavioral guards (V4/C7_D)
  never configured; no VEXP; no baseline reruns.

## Claim-Safe Wording

**Allowed internal wording (use verbatim or equivalent):**

> "On the frozen internal 100-case Stage 5 pool, the current default VTRACE
> path produced 97 valid guarded live runs, with 55 resolved patches (56.7%
> of valid live runs). Three cases were pre-registered no-context exclusions
> under the parity contract."

> "Across the 97 valid runs, the default path was leak-clean: zero
> model-visible FAIL_TO_PASS/PASS_TO_PASS/gold-patch leakage, zero
> fallback-context fires, zero unguarded env/shell runs, and zero host-pip
> mutation escapes."

> "The M95–M103 deterministic chain improved the pre-agent scoreboard from
> M94 to M103, including higher recall, capsule coverage, lead-pivot
> quality, multi-file all-gold coverage, and structured task evidence
> handling."

> "This is an internal live confirmation, not a public SWE-bench pass@1
> claim and not a VEXP parity claim."

> "In the one paired same-protocol measurement (M92, 50 tasks, both arms
> valid), VTRACE reduced total agent tokens by 26.7% and cost by 25.0% with
> resolution preserved."

**Prohibited wording (never say):**

- "VTRACE achieved 56.7% on SWE-bench" / "VTRACE pass@1 is 56.7%"
- "100/100 live cases were run"
- "VTRACE beats VEXP" (or any VEXP parity/superiority claim)
- "VTRACE is validated on SWE-bench Verified"
- "no leakage is possible" (measured-zero on this protocol ≠ impossible)
- "token reduction is guaranteed"

**README/docs status**: `README.md` is already claim-safe (M92 figures
properly scoped, explicit "not a public SWE-bench pass@1" disclaimer).
`docs/current_product_state.md` was stale (last reconciled M93A, "M94
planned next") — updated minimally with the M94–M108 benchmark
interpretation using the allowed wording above; no marketing language added.

## Remaining Bottlenecks

1. **3 no-context pool cases** (django-11740, django-15572, sphinx-9320):
   the only rows the default path cannot inject on — candidate-recall work
   if this class ever grows; currently 3% of the pool.
2. **Agent-variance losses despite complete context**: 10 of the 13
   strict live-losses had all gold in the capsule. This is the largest
   remaining live gap and it is NOT addressable by retrieval; levers are
   patch-shape guidance (multi-file edit discipline — the xarray-6938
   class) and convergence behavior on hard cases.
3. **Cache-read dominance** (93.9% of tokens): cost now scales with
   turn-count × context size, not with capsule size; further capsule
   shrinkage has limited cost leverage — turn efficiency is the lever.
4. **Deterministic residue**: 21 miss / 14 overpacked / 7 wrong_pivot cases
   (M100: pool recall mined-out at current precision; M103: overpacking is
   the packing lever; M96 conservatism on weak-direct lanes is deliberate).
5. **High-cost tool-loop ceiling** (django-16263, pylint-4551, sympy-20428
   signatures): structural, guard-resistant per M78/M83 evidence; V4/C7_D
   stay default-off.

## Recommended Next Steps (ranked)

1. **Freeze the current default path** (done — this milestone records it).
2. **Prepare the internal package/report** — this summary + the M108 report
   + the hard-stratum JSON are the package basis.
3. **No more live spend until analysis questions are exhausted** — the open
   analytical threads (agent-variance loss characterization, multi-file
   patch-shape levers) are all answerable from captured artifacts.
4. **Investigate hard-stratum live losses** (captured-artifact study of the
   9 agent-variance losses' transcripts/tool logs; cheapest expected gain).
5. **Investigate the 3 no_context cases** (deterministic candidate-recall
   work; only worth a milestone if the class grows beyond 3/100).
6. **Compare against VEXP only with a separate preregistered protocol** —
   never as a side effect; requires its own paired design and budget.
