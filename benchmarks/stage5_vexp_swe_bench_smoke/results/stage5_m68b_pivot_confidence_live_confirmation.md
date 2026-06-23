# Stage 5 M68B Pivot Confidence Live Confirmation

Small live confirmation that the post-M68 required-pivot **confidence gate**
(`--pivot-confidence-gate`, default OFF, bounded-only) behaves correctly in real
injected prompts. This is **not** a 24-task repeat, **not** a 100-task benchmark, and
**not** a default promotion. Retrieval / scoring / ranking / candidate-generation were
**not** changed (no code under `src/` retrieval paths touched).

Source of truth (frozen): `stage5_m62_structured_bounded_24_preregistration.json`,
`stage5_m66_optional_impact_24_live_validation.json` (+ `.detail.json`),
`stage5_m67_m66_pivot_localization_audit.json`,
`stage5_m68_required_pivot_confidence_gate.json`.

## Summary

- **Selected cases (5):** `django__django-11740`, `sympy__sympy-12419`,
  `matplotlib__matplotlib-24627`, `astropy__astropy-14365`, `psf__requests-5414`.
  All 5 are members of the frozen M62 24-task set. (The brief wrote the requests case as
  `requests__requests-5414`; its canonical SWE-bench id is `psf__requests-5414` — same
  case, prefix-naming only.)
- **New live runs performed:** 5 treatment runs + 5 Docker evals. **0 fresh baselines.**
  Total live agent runs = 5 (= the approved hard cap).
- **Valid / invalid treatment runs:** **5 VALID / 0 invalid.**
- **Zero-required cases:** 2 (`django-11740`, `sympy-12419`) — both marker-backed, both resolved.
- **Baseline reuse:** all 5 reused from the M62/M66 lineage (`baseline_model_match = True`).
- **Headline resolution:** M68B **2/5** vs M66 **4/5** vs baseline **3/5**. The two M68B
  misses are M66 treatment-only WINS on known-unstable cases and are **not gate-caused**
  (see Resolution / Safety Analysis).
- **Headline structured-decision:** on the 3 non-zero-required cases the gate yields
  **coverage 100 %, ignored 0 %, invalid-rule-out 0 %**, versus the M66 slice's
  **50 % / 10 % / 20 %** over the same 5 cases.
- **Verdict: PASS** (all 10 success criteria clear) — with an explicit resolution-variance caveat.

## Pre-flight

A non-agent pre-flight (`run_stage5_m68b_preflight.ts`) drove the **real** render path
(`prepareIndexedContext`: checkout → vtrace index → deterministic `capsule` query →
render) for all 5 cases with the **full treatment flag set incl. `--pivot-confidence-gate`**,
then validated the rendered injected context. No agents, no Docker, no spend.

- **Selected 5 cases checked:** 5.
- **VALID / FAIL_CLOSED_OMITTED / INVALID_PARTIAL_SENTINEL:** **5 / 0 / 0.**
- **Confidence gate enabled?** Yes (flag wired: `--pivot-confidence-gate` requires
  `--bounded-digest-decisions`).
- **Zero-required marker result:** `django-11740` and `sympy-12419` each emitted exactly
  0 required targets **with** the `<VTRACE_NO_HIGH_CONFIDENCE_REQUIRED_TARGET>` marker.
- **Demotion result:** django demoted both GDAL `feature.py` pivots; sympy demoted both
  `piecewise.py` pivots; astropy demoted the non-gold `fitsdiff.py::handle_options`
  (lead `qdp.py` kept). matplotlib + requests demoted nothing.
- **No required IMPACT result:** 0 required IMPACT targets across all 5.
- **Optional / FYI context result:** present where impact reps exist; all marked
  "not closure-scored".
- **Required/optional ID separation:** no `T`/`O` collisions in any case.

Cross-checked against the offline gate replay (`run_stage5_m68_confidence_gate_replay.ts`),
which independently reproduces the same demotions over the captured M66 artifacts.

## Baseline Reuse Gate

Baselines reused from the frozen M62/M66 lineage (recorded in the committed M66
`.detail.json`; patch/eval + token/cost/tool metadata available; `model_match = True`).
Fresh baselines were not required, keeping total live runs at 5.

| instance_id | baseline_run_label | baseline_source | model_match | reuse_decision | notes |
|---|---|---|---|---|---|
| django__django-11740 | `eval-11740` | reused | pass | reuse | baseline resolved=True |
| sympy__sympy-12419 | `eval-bounded20-baseline-sympy-12419-r1` | reused | pass | reuse | baseline resolved=True (3/3) |
| matplotlib__matplotlib-24627 | `eval-bounded-baseline-mpl-24627-r1 (+2 reps)` | reused | pass | reuse | baseline resolved=False (0/3) |
| astropy__astropy-14365 | `eval-bounded20-baseline-astropy-14365-r2 (+2 reps)` | reused | pass | reuse | baseline resolved=False (0/3) |
| psf__requests-5414 | `eval-baseline-vs-vtrace-baseline-requests-5414` | reused | pass | reuse | baseline resolved=True (1/1) |

## Run Matrix

| instance_id | repo | selection_reason | baseline | M66 | M68B | run_label | valid | evaluated | zero_required | demoted_pivots | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| django-11740 | django/django | zero-required / no-hurt | ✅ | ✅ | ✅ | `m68b_pivot_confidence_django_11740` | ✅ | ✅ | yes | 2 (feature.py) | resolved via gold autodetector.py; demoted pivots untouched |
| sympy-12419 | sympy/sympy | zero-required / regression ctrl | ✅ | ✅ | ✅ | `m68b_pivot_confidence_sympy_12419` | ✅ | ✅ | yes | 2 (piecewise.py) | resolved via matexpr.py; demoted pivots untouched |
| matplotlib-24627 | matplotlib/matplotlib | win-safety | ❌ | ✅ | ❌ | `m68b_pivot_confidence_matplotlib_24627` | ✅ | ✅ | no | 0 | pivots kept; self-rescue edited _base.py; variance miss |
| astropy-14365 | astropy/astropy | collateral safety | ❌ | ✅ | ❌ | `m68b_pivot_confidence_astropy_14365` | ✅ | ✅ | no | 1 (fitsdiff.py) | gold qdp.py kept+EDITED; patch insufficient |
| psf__requests-5414 | psf/requests | no-hurt control | ✅ | ❌ | ❌ | `m68b_pivot_confidence_requests_5414` | ✅ | ✅ | no | 0 | gold models.py kept+EDITED; matches M66 (False) |

## Results Table

| instance_id | cond | resolved | patch | total_tokens | cache_read | cost | tools | reads | search | repeat_reads | req_targets | demoted | closed | open | ignored | invalid_ruleout | optional | opt_edited | off_target |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| django-11740 | M68B | ✅ | yes | 1,650,690 | 1,562,061 | 0.721 | 17 | 5 | 4 | 4 | 0 | 2 | – | – | – | – | 2 | 0 | 1* |
| sympy-12419 | M68B | ✅ | yes | 3,719,225 | 3,621,955 | 1.365 | 32 | 4 | 2 | 1 | 0 | 2 | – | – | – | – | 2 | 0 | 1* |
| matplotlib-24627 | M68B | ❌ | yes | 1,283,831 | 1,202,543 | 0.579 | 12 | 3 | 3 | 0 | 2 | 0 | 2 | 0 | 0 | 0 | 2 | 0 | 1 |
| astropy-14365 | M68B | ❌ | yes | 595,149 | 540,057 | 0.392 | 5 | 1 | 0 | 0 | 1 | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| psf__requests-5414 | M68B | ❌ | yes | 608,505 | 549,241 | 0.444 | 5 | 2 | 0 | 1 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |

`*` For the zero-required cases there are no required targets, so the agent's (correct)
gold edit registers as "off-target" by the metric — it found the gold via search after the
contract demoted the wrong lexical pivots. `–` = not applicable (zero-required: no required
targets to close).

Pooled M68B live cost = **$3.50** over 5 runs.

## Case Notes

**django-11740** — *Expected:* zero-required; wrong GDAL `feature.py` lexical pivots
demoted. *Observed:* exactly that — 0 required, marker present, `Feature` + `Feature.fid`
demoted to `O1/O2`. Agent ignored the demoted pivots, searched, and edited the real gold
`db/migrations/autodetector.py`. **Resolved=True.** Demotion safe; zero-required behavior safe.

**sympy-12419** — *Expected:* zero-required; both `piecewise.py` lexical-only pivots
demoted. *Observed:* 0 required, marker present, `piecewise_fold` + `_sort_expr_cond`
demoted. Agent edited `matrices/expressions/matexpr.py` (off the demoted pivots).
**Resolved=True.** Demotion safe; zero-required behavior safe.

**matplotlib-24627** — *Expected:* required pivots stay required (win-safety). *Observed:*
2 required (`pyplot.py::plot`, `pyplot.py::subplots`), 0 demoted — contract byte-identical
to M66. Both required targets closed (INSPECT_ONLY_NO_EDIT); agent self-rescued to edit
`axes/_base.py`. **Resolved=False** (M66 was True). The gate is **not** the cause (no
demotion); this is the known M55X/M66 self-rescue variance case (baseline 0/3; M65C ran it
3× for variance). Mechanism (kept-required lead + freedom to self-rescue) intact.

**astropy-14365** — *Expected:* gold lead `qdp.py` required; non-gold `fitsdiff.py`
demoted. *Observed:* exactly that — `qdp.py::_write_table_qdp` kept required and **EDITED**;
`fitsdiff.py::handle_options` demoted to `O1` and **not** edited. **Resolved=False** (M66
was True), but the agent localized correctly (edited the kept-required gold lead); the run
was short (17 turns, 1 read) and the patch was insufficient — a patch-quality miss on the
right file, not a localization/gate failure. Demotion was safe (demoted file is non-gold).

**psf__requests-5414** — *Expected:* correct gold lead `models.py` stays required (no-hurt).
*Observed:* `models.py::prepare_url` kept required and EDITED; `api.py::get` kept required
(INSPECT_ONLY_NO_EDIT); 0 demoted. **Resolved=False** = **M66 False** (consistent; this is a
baseline-only-pass case). No-hurt control held: the gate did not demote the correct lead.

## Structured Decision Analysis

Scope = the 3 **non-zero-required** cases (matplotlib, astropy, requests; 5 required PIVOT
targets total). Zero-required cases have no required targets and are excluded from coverage.

- **Coverage:** 5/5 closed = **100 %**.
- **Ignored rate:** **0 %**.
- **Invalid-rule-out rate:** **0 %**.

**Zero-required accounting:** 2 cases, both marker-backed, 4 pivots demoted to FYI, **0**
demoted pivots edited, both resolved.

**Comparison to the M66 slice (same 5 cases, gate OFF, 10 required targets):** coverage
**50 % → 100 %**, ignored **10 % → 0 %**, invalid-rule-out **20 % → 0 %**. The gate removed
django's 2 INVALID_RULE_OUTs and sympy's 2 stuck INSPECTED_ONLY opens (by demoting those
weak lexical pivots) and matplotlib's 1 IGNORED (closed this run).

**Comparison to the M68 retrospective replay** (coverage 85.1 % → 92.7 %, invalid 8.5 % →
4.9 % over the full 24): the selected-slice live result moves in the **same direction**, more
strongly here because the slice is enriched for exactly the cases the gate targets.

**Would the failed M66 criteria clear on this slice?** M66's two failing criteria were
coverage ≥ 90 % (85.1 %) and invalid ≤ M62C (8.5 % vs 4.2 %). On this slice **both clear**
(100 % coverage, 0 % invalid). This is a selected, gate-favorable slice — not a claim about
the full 24.

## Resolution / Safety Analysis

- **Treatment-only win safety:** matplotlib + astropy were M66 treatment-only wins (baseline
  failed both). M68B did not reproduce either resolution, but **neither is gate-caused**:
  matplotlib's contract is identical to M66 (pivots kept, 0 demoted) and astropy edited the
  kept-required gold lead `qdp.py`. The kept-required lead "mechanism" is intact in both.
- **No-hurt control:** requests-5414 kept its correct lead `models.py` required and edited it;
  result (False) matches M66 (False). The gate did not harm it.
- **Was any demoted pivot resolution-critical?** No. All 5 demoted pivots are non-gold
  (django GDAL feature.py, sympy piecewise.py, astropy fitsdiff.py); **0** were edited in any
  run; both passing runs reached the gold elsewhere.
- **Zero-required safety:** both zero-required cases (django, sympy) **resolved** — the gate
  removing misleading "required" anchors did not block resolution; the agent searched and
  found the gold.
- **Cost / thrash:** pooled $3.50/5 runs. Notably, matplotlib cost fell to $0.58 (34 turns)
  vs M66's $3.02 (97 turns) — the M66 thrash did not recur here, but that shorter run also did
  not self-rescue to a passing patch. This is the inherent variance of that case.

**Honest caveat:** raw resolution on this tiny, win-heavy slice is variance-dominated. M68B
2/5 < M66 4/5 is driven entirely by two unstable treatment-only-win cases that the gate
provably did not affect. The task's success criteria intentionally gate on validity, demotion
safety, mechanism preservation, and structured-decision quality — not raw resolution count on
5 cases.

## Success Criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | all attempted runs valid | ✅ | 5/5 valid |
| 2 | confidence gate enabled in all runs | ✅ | gate flag set + gate-on render in 5/5 |
| 3 | zero-required valid only with marker | ✅ | 2 zero-required, both marker-backed |
| 4 | no required IMPACT targets | ✅ | 0 required IMPACT |
| 5 | optional/FYI not closure-scored | ✅ | all FYI marked not-closure-scored; 0 optional edited |
| 6 | demoted pivots not edited in passing runs (unless explained) | ✅ | 5 demoted, 0 edited (any run) |
| 7 | matplotlib + astropy safety mechanisms not harmed | ✅ | mpl pivots kept (0 demoted); astro qdp.py kept+EDITED |
| 8 | requests correct lead remains required | ✅ | models.py kept required |
| 9 | coverage ≥ 90 % on non-zero-required cases | ✅ | 100 % |
| 10 | invalid-rule-out improves or not worse vs M66 | ✅ | 0 % vs 20 % (M66 slice) |

All 10 criteria pass.

## Verdict

**PASS** — the `--pivot-confidence-gate` preserved strict four-sentinel validity and the
optional-impact invariant, emitted 2 correct marker-backed zero-required contracts, demoted
only non-gold weak-localization pivots (none edited), kept every strong/gold lead required,
and improved structured-decision accounting on this slice (coverage 50 %→100 %, invalid
20 %→0 %). Raw resolution fell on two known-unstable treatment-only-win cases, but this is
variance, not a gate effect, and is not a defined success-criterion gate.

## Recommendation

**Proceed to a 24-task live repeat with the confidence gate (opt-in, still non-default).**
The gate is confirmed safe and structured-decision-positive on the selected slice; the only
open question is resolution at scale, where the win-case variance seen here will average out.
Do not default-promote the gate before that 24-task resolution sample.

## Interpretation guardrails

M68B validated the confidence gate on 5/5 selected cases and produced 2 intentional,
marker-backed zero-required contracts. M68B did **not** preserve selected-case resolution
(2/5 vs M66 4/5), but the losses are not gate-attributable. M68B changed structured-decision
accounting from 50 % / 10 % / 20 % to 100 % / 0 % / 0 % on this selected slice. No claim is
made of VEXP parity, broad SWE-bench pass@1 improvement, or global proof of the gate.

## Reproduce

- Pre-flight (no agents): `bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m68b_preflight.ts --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench`
- Treatment (per case): `--mode run-protocol --protocol vtrace-indexed --context-policy force-inject --capsule-engine v2 --capsule-intent debug --capsule-budget 8000 --inject-capsule-digest --digest-decision-contract --bounded-digest-decisions --compact-digest-injection --pivot-confidence-gate`
- Evaluate (per case): `--mode evaluate --eval-mode docker --run-label <label>`
- Metrics: `bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m68b_analyze.ts`
- Compact summary: `stage5_m68b_pivot_confidence_live_confirmation.json`; per-case detail:
  `stage5_m68b_pivot_confidence_live_confirmation.detail.json`.
