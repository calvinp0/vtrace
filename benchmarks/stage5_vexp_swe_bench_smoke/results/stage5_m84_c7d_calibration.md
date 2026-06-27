# Stage 5 M84 C7_D Cost Guard Calibration

## Summary

- **C7_D implemented?** Yes — as a first-class, named cost-guard *calibration* (`v0 | c7d`),
  not a one-off threshold override.
- **Default behavior:** the cost guard stays **DEFAULT-OFF**. An unflagged run never
  executes the guard and emits **no** `cost_guard_*` metadata. The calibration default
  (`c7d`) is inert until the guard is explicitly enabled.
- **CLI / config names:** `--cost-guard-calibration v0|c7d` (advanced A/B knob; does **not**
  enable the guard on its own). Config: `CostGuardConfig.calibration`. Constructor:
  `costGuardConfigForCalibration(calibration, overrides?)`. When the guard *is* enabled the
  selected calibration defaults to `c7d`.
- **Threshold changed:** `editVerifyChurnThreshold` **3 → 2** (and only that).
- **Thresholds unchanged:** `minToolCalls 25`, `minTurns 8`, `highToolCount 35`,
  `highTurnCount 90`, `noPatchTool 30`, `repeatedVerify 3`, `costCap 0.85 × $3`,
  `maxInjections 2`, `cooldown 8`.
- **Offline replay result:** C7_D first-fires **+10 tools earlier** on django-16263
  (`34 → 24`) and is otherwise **identical** to V0 on every safety axis — 0 early fires,
  0 control fires, 0 protected-early fires, pytest-6197 silent, django-15503 silent,
  sympy-12419's winning trajectory untouched (first fire 34 under both). Broad 563-stream
  corpus fire count rises only **+3** (23 → 26; 4.09% → 4.62%), all late, none early.
- **Recommendation:** **Proceed to small live validation with V4 + C7_D** (default-off,
  calibration recorded in metadata).

## M83 Recap

- **Why C7 was too late.** In the M82 live validation C7 fired three times but always at
  the high-tool-count ceiling (`@34`) — after the budget was already mostly spent. On
  django-16263 (35 tools / 2 edits / 17 verifies, ~$3.04) the only signal that crossed was
  `high_tool_count`; the same-file edit/verify churn never reached the V0 threshold of 3
  (the run made just 2 edits to the churned file), so the guard could not steer earlier.
- **Why C7_D was chosen.** The M83 threshold sweep ranked nine candidate variants. Lowering
  `editVerifyChurnThreshold` 3 → 2 (C7_D) gave the **largest safe timing lead** —
  django-16263 first-fire moves +10 tools earlier — while every panel variant kept **0**
  early / control / protected-early fires, and the broad 563-stream corpus fire-rate rose
  only marginally (churn fires 14 → 18). It also leaves the winning sympy-12419 run
  untouched (its fire is a command-loop / high-tool signal, not same-file edit churn).
- **Why lowering the 25-tool gate was rejected.** M83 found the 25-tool gate is the
  *protective lever*: lowering it inflated broad-corpus churn fires 14 → 32, whereas
  lowering only the churn threshold added just +3. The gate is what keeps early orientation
  from firing, so M84 leaves it at 25 and changes only the churn threshold.

## Implementation

- **Calibration config.** `costGuard.ts` adds `CostGuardCalibration = "v0" | "c7d"`, a
  `CostGuardConfig.calibration` field (module default `"v0"`), and the single source of
  truth `COST_GUARD_CALIBRATION_CHURN_THRESHOLD = { v0: 3, c7d: 2 }`. The constructor
  `costGuardConfigForCalibration(calibration, overrides)` builds a config whose
  `editVerifyChurnThreshold` is taken from that map and whose **every other field** comes
  from `DEFAULT_COST_GUARD_CONFIG`, so `c7d` differs from `v0` in exactly one threshold
  (plus the recorded label). `overrides` win last (the harness passes `{ enabled: true }`).
- **CLI flag.** `--cost-guard-calibration v0|c7d` sets `config.costGuardCalibration` and
  rejects any other value. It does **not** enable the guard (mirrors
  `--tool-loop-guard-calibration`). The harness default is `c7d`.
- **Metadata.** `costGuardMeta` now emits top-level `cost_guard_calibration` and a per-event
  `calibration`; `CostGuardResult.calibration` carries it through. The harness records the
  resolved `cost_guard_config` (with `editVerifyChurnThreshold` = 2 under c7d) alongside.
- **Observe / inject behavior.** `computeCostGuardMeta` (observe) builds its guard config via
  `costGuardConfigForCalibration(config.costGuardCalibration, { enabled: true })`. The
  runtime hook receives the same config JSON through `VTRACE_COST_GUARD_CONFIG`;
  `parseCostGuardHookConfig` honors the embedded `calibration` + threshold. Because the
  runtime injector re-runs the pure detector over the accumulated prefix, it fires at exactly
  the same turns the observe detector would, under whichever calibration is selected.
- **V4 coexistence.** Unchanged. The combined hook still registers one PostToolUse process;
  the cost guard (under its calibration) leads near budget and the V4 tool-loop guard handles
  local loops. `--tool-loop-guard-calibration v4 --cost-guard-calibration c7d` is a valid
  combined config.

## Offline Replay

Replay over the captured M82 streams (canonical observe view, with run-context), the M80
cross-check streams, and the broad 563-stream corpus (stream-only, live-faithful). Both
calibrations are built through `costGuardConfigForCalibration` and passed to the existing
pure `runCostGuard` — **no** guard behavior is changed.

| Cohort | Streams | V0 fires | C7_D fires | Early | Protected/Control | django-16263 | django-12273 | sympy-12419 | Risk |
|---|---|---|---|---|---|---|---|---|---|
| M82 cohort (w/ context) | 10 | 3 | 3 | 0 / 0 | 0 / 0 | **34 → 24** | 31 → 31 | 34 → 34 | low |
| M80 cross-check | 10 | — | — (no new fires) | 0 | 0 / 0 | — | — | — | low |
| Broad corpus (stream-only) | 563 | 23 | 26 (+3) | 0 / 0 | n/a | — | — | — | low |

Named first-fire turns (M82 cohort, with run-context):

| Case | V0 first-fire | C7_D first-fire | Δ (earlier) | Trigger under C7_D |
|---|---|---|---|---|
| django-16263 | 34 | **24** | **+10** | edit_verify_churn |
| django-12273 | 31 | 31 | 0 | edit_verify_churn (already churning) |
| sympy-12419 | 34 | 34 | 0 | high_tool_count (trajectory safe) |
| django-15503 | — (silent) | — (silent) | — | none |
| pytest-6197 | — (silent) | — (silent) | — | none |

Cohort fire counts (M82, both calibrations): treatment-only-win 0, baseline-only-loss 0,
low-cost-pass 0, control 0, protected-early 0. The three fires are all targeted
cost/no-convergence cases (django-16263, django-12273, sympy-12419) — exactly the vector C7
is meant to catch.

**M74 cohort note.** The M74 self-harness cases were captured as eval logs only (no full
tool-call streams), so — as with M73 in the M83 sweep — they contribute outcome-cohort
*counts* (cap-hit / category counts in `m74_cohort_coverage`), not replayable streams. The
broad-corpus count (563) **matches M83 exactly**; no discrepancy to report.

Detail: `stage5_m84_c7d_replay.json`; headline: `stage5_m84_c7d_calibration.json`.

## Tests

Added `costGuardCalibration.test.ts` (18 numbered cases) plus a CLI test in
`run_stage5_vexp_swe_bench_smoke.test.ts`:

1. cost guard remains default-off (module default `enabled:false`, `calibration:"v0"`).
2. default enabled calibration recorded (constructor + harness default `c7d`).
3. `--cost-guard-calibration v0` parses and does not enable the guard.
4. `--cost-guard-calibration c7d` parses and does not enable the guard.
5. c7d differs from v0 in **only** `editVerifyChurnThreshold` (+ the calibration label).
6. v0 keeps `editVerifyChurnThreshold` 3.
7. c7d fires edit-verify churn after **2** cycles once the 25-tool gate is open.
8. v0 does **not** fire on that same 2-cycle churn.
9. the 25-tool gate still gates c7d (pre-gate 2-cycle churn is suppressed).
10. early orientation does not fire under either calibration.
11. pytest-style short run stays silent under both.
12. django-16263 compact fixture: c7d first-fires **+10** tools earlier than v0.
13. sympy-12419 compact fixture: c7d matches v0 exactly (trajectory safe).
14. metadata records `cost_guard_calibration` (top-level + per-event).
15. observe-mode metadata uses the selected calibration.
16. inject-mode runtime injector fires at the same turns as the batch detector per calibration.
17. V4 + C7_D combined hook config is valid (parses; combined hook runs without throwing).
18. offline replay deterministic (pure function of events + calibration; v0 ≠ c7d on churn input).

**Verification:** `bun run typecheck`, `bun run typecheck:benchmarks`, and `bun test` all pass;
`git diff --check` clean. No retrieval / scoring / ranking / Capsule v2 / decision-contract /
pivot-confidence / tool-loop-guard behavior touched.

## Recommendation

**Proceed to small live validation with V4 + C7_D.** C7_D is a faithful, default-off,
metadata-recorded calibration that buys a real timing lead on the dominant
cost/no-convergence vector (django-16263, +10 tools earlier) with zero new early/control/
protected-early fires and a negligible broad-corpus fire-rate increase (+3 / 563). It leaves
the protective 25-tool gate intact and does not disturb the winning sympy-12419 trajectory.
The remaining unknown is purely live behavior (does the one-cycle-earlier churn message
actually steer django-16263-class runs to convergence), which only a small live A/B can
answer — and which must be explicitly approved before running.
