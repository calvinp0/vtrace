# Stage 5 — M36: Live A/B plan for the Multi-Pivot Action Plan

**Status: PLAN ONLY. Nothing here has been executed.** This document specifies a live
A/B; it spawns real agents and (optionally) runs canonical Docker evaluation, so it
costs money and **requires explicit approval before any run**. No agent, Docker, or
SWE-bench evaluation was run to produce this file.

## 1. Objective and hypothesis

M35 added a compact `## Multi-Pivot Action Plan` at the top of the injected
`vtrace-indexed` capsule. Offline validation (`stage5_m35_multi_pivot_actionability.md`)
showed it promotes the missed gold co-edit `sphinx/pycode/ast.py::unparse` into the
top-level required inspection set for sphinx-7462, but cannot help seaborn-3187 (its
gold co-edit `seaborn/utils.py` is ranked as support, not a pivot — a separate
co-edit-evidence gap).

**Hypothesis (H1):** on multi-pivot co-edit tasks, the M35 action plan increases the
rate at which the agent inspects AND edits the required secondary pivot on the first
pass, raising `resolved` without enabling pivot revision or pivot-inspection
enforcement.

**Prediction:** measurable lift on sphinx-7462 (evidence is correct, salience was the
gap); little or no lift on seaborn-3187 (evidence gap, not salience) — seaborn is the
built-in negative control that guards against "the plan just nudges resolution
regardless of whether the right pivot is surfaced."

## 2. Arms

| arm | render | how produced |
| --- | --- | --- |
| **A — control** (old) | `vtrace-indexed`, M35 section suppressed | `VTRACE_ENABLE_MULTI_PIVOT_ACTION_PLAN=0` |
| **B — treatment** (new) | `vtrace-indexed` + M35 action plan | default (section renders) |

Everything else is identical between arms: same protocol (`vtrace-indexed`), same
intent (`auto`), same instances, same harness, **no** revision, **no** pivot-inspection
enforcement, **no** diagnostic verifier.

### 2.1 Prerequisite: a render-time toggle (small, rendering-only)

M35 currently renders the section unconditionally, so a single-binary A/B needs a way
to suppress it for arm A. Add a render-time toggle consistent with the existing
`VTRACE_ENABLE_TRACEBACK_LOCALIZED_SKIP` convention:

- Gate the `buildMultiPivotActionPlan(...)` call in `renderCapsuleV2Human` behind an
  option that defaults to ON, overridable by `VTRACE_ENABLE_MULTI_PIVOT_ACTION_PLAN=0`.
- This is rendering-only: it adds/removes one section, touches no retrieval, ranking,
  candidate generation, or scoring.
- **Prove it:** with the flag ON the injected snapshot is unchanged vs current HEAD;
  with it OFF the snapshot equals the pre-M35 (`ddd0d8c`) render. Run the deterministic
  retrieval eval in both states — both CSVs must stay byte-identical to the committed
  baselines.

Fallback if a flag is undesirable: produce arm A from a `git worktree` checkout of the
parent commit `ddd0d8c` and arm B from `37c570c` (M35). The flag is preferred — one
binary, one variable, no cross-checkout drift.

## 3. Instances (M32 genuine actionability failures only)

| instance | gold files | required secondary co-edit | M34 functional label |
| --- | --- | --- | --- |
| `sphinx-doc__sphinx-7462` | `sphinx/domains/python.py`, `sphinx/pycode/ast.py` | `sphinx/pycode/ast.py::unparse` | `retrieval_success_action_failure` ×3 |
| `mwaskom__seaborn-3187` | `seaborn/_core/scales.py`, `seaborn/utils.py` | `seaborn/utils.py` (ranked as support — negative control) | `retrieval_success_action_failure` ×2, success ×1 |

Both FAIL_TO_PASS sets have 2 tests; resolution requires ALL to pass.

## 4. Replicates and run matrix

Both instances are stochastic (seaborn-3187 resolved 1/3 in M32), so single runs are
not decisive. Target **r1–r3 per arm per instance, budget permitting**:

- Full matrix: 2 instances × 2 arms × 3 replicates = **12 live protocol runs**.
- Minimum decisive cut if budget is tight: r1–r2 per arm per instance = 8 runs
  (declare underpowered; do not over-read a single-run flip).

Suggested labels (`<arm>` ∈ {`a-control`, `b-m35`}; keeps arm + instance + replicate
greppable in `results/runs/`):

```
eval-m36-<arm>-sphinx-7462-r{1,2,3}
eval-m36-<arm>-seaborn-3187-r{1,2,3}
```

## 5. Protocol-run commands (per run; DO NOT execute without approval)

Sequential only — the first pass writes a SHARED `results/_agent_stream.jsonl`;
concurrent live runs clobber it. Run one at a time.

```bash
VEXP=/home/calvin/code/vexp-swe-bench
OUT=benchmarks/stage5_vexp_swe_bench_smoke/results
RUNNER=benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts

# Arm A (control — M35 section OFF). Repeat per instance × r1..r3.
VTRACE_ENABLE_MULTI_PIVOT_ACTION_PLAN=0 \
bun "$RUNNER" --mode run-protocol --protocol vtrace-indexed \
  --vexp-swe-bench-dir "$VEXP" --instances "sphinx-doc__sphinx-7462" \
  --capsule-intent auto --capture-product-v2-accounting --disable-pivot-check \
  --run-label "eval-m36-a-control-sphinx-7462-r1" --out "$OUT"

# Arm B (treatment — M35 section ON, the default). Repeat per instance × r1..r3.
bun "$RUNNER" --mode run-protocol --protocol vtrace-indexed \
  --vexp-swe-bench-dir "$VEXP" --instances "sphinx-doc__sphinx-7462" \
  --capsule-intent auto --capture-product-v2-accounting --disable-pivot-check \
  --run-label "eval-m36-b-m35-sphinx-7462-r1" --out "$OUT"
```

Flag invariants for BOTH arms (scope guards): NO `--pivot-inspection-enforcement`,
NO `--pivot-revision-pass`, NO diagnostic verifier, NO `--allow-docker-verify` during
protocol runs. `--disable-pivot-check` keeps the legacy PIVOT_CHECK off.

## 6. Canonical Docker evaluation (ONLY after all protocol runs)

A separate step, run once after the protocol runs land their patches (it mutates
`resolved` in place):

```bash
bun "$RUNNER" --mode evaluate --eval-mode docker \
  --vexp-swe-bench-dir "$VEXP" --run-label "eval-m36-b-m35-sphinx-7462-r1" --out "$OUT"
```

Requires explicit Docker approval. Do not interleave with protocol runs of the same
label (Docker eval of one label MAY overlap a live run of a different label — different
resources — but keep it simple and run eval after the protocol sweep).

## 7. Metrics (per run, then aggregated per arm × instance)

Primary:
- **`resolved`** (canonical Docker; all FAIL_TO_PASS pass) — the headline outcome.
- **secondary-pivot edited on first pass** — does `modelPatch` touch the required
  secondary (`ast.py` for sphinx; `utils.py` for seaborn)? Parse `modelPatch` changed
  files from `raw/vtrace/swebench-*.jsonl`.

Mechanism / supporting:
- **secondary-pivot inspected** — did `_tool_calls.json` read the secondary BEFORE the
  first edit (vs after, as in M32 sphinx where `ast.py` was read post-edit)?
- **token cost delta** — `injectedContextTokens` and the new `multiPivotActionPlanTokens`
  (M34 accounting) — confirm the ~158–160-tok surcharge and check total cost/`costUsd`.
- **tool-call counts** — `beforeFirstPatch*` from M34 post-capsule wandering.

Read-back paths per label: `raw/vtrace/swebench-*.jsonl` (`modelPatch`, `resolved`,
`costUsd`, `numTurns`), `raw/vtrace/_tool_calls.json`, `raw/vtrace/_run.meta.json`,
`_vtrace_instructions.snapshot.md`, `raw/vtrace/_eval.meta.json`.

## 8. Success criteria

- **Confirmatory (H1 supported):** on sphinx-7462, arm B shows higher
  secondary-pivot-edit rate AND ≥ arm A `resolved` across r1–r3, with the surcharge
  bounded to the measured ~160 tokens. seaborn-3187 shows no degradation (its lack of
  lift is expected and reinforces that the lever is salience-of-correct-evidence).
- **Null/negative:** arm B does not raise secondary-pivot edits over arm A on sphinx →
  salience was not the bottleneck; pivot to co-edit-evidence/ranking work (M35 rider B).
- **Guard:** if arm B edits the secondary but `resolved` does not improve → synthesis
  failure downstream of localization; record but do not attribute to M35.

Stochastic caution: with r≤3 per cell, treat a single-run flip as weak evidence; report
per-replicate outcomes, not just the cell mean.

## 9. Cost, approval, and scope

- ~12 live agent runs (8 minimum) + canonical Docker eval of the resulting labels.
  Runs re-clone the repo per label (minutes each, network-bound) and are sequential.
- **Explicit approval required** before any protocol run and before Docker eval.
- Scope guards (unchanged from M35): no pivot revision default, no pivot-inspection
  enforcement default, no retrieval/ranking/scoring/candidate changes (the only code
  delta is the rendering-only toggle in §2.1, proven byte-identical by retrieval eval).
- Reporting: write `stage5_m36_live_ab.{md,json}` with the per-run matrix and the
  per-arm × instance aggregates; never stage raw artifacts under `results/runs/`.
