#!/usr/bin/env bun
// M79 offline replay of the CALIBRATED tool-loop guard (V0 vs V4).
//
// PURE OFFLINE: no live agents, no Docker, no API spend, no retrieval/scoring/
// ranking/Capsule-v2/decision-contract changes. Unlike the M78 sweep (which modeled
// V4 as a POST-HOC filter over the V0 firing list), this script runs the SHIPPED
// detector twice — once with `calibration: "v0"` and once with `calibration: "v4"`
// — over the same captured streams, so it validates the REAL M79 implementation.
//
// Inputs (captured artifacts; raw streams are read but NEVER staged):
//   * M71/M72 treatment cohort (the unguarded population the guard would face)
//   * the four named M77 LIVE guarded streams whose trajectories diverged
//   * M74 audit for the offline interpretation columns (gold is NOT used by the
//     detector — only to label recall/FP groups)
//
// It also drives the runtime state machine (observe vs inject parity) over the named
// streams to confirm V4 fires at identical turns in both paths.
//
// Writes (tracked, compact — no raw streams, no full contexts):
//   results/stage5_m79_tool_loop_guard_v4_replay.json        (full per-case + cohort)
//   results/stage5_m79_tool_loop_guard_v4_calibration.json   (compact summary)

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_TOOL_LOOP_GUARD_CONFIG,
  runToolLoopGuard,
  toGuardEvent,
  type ToolLoopGuardConfig,
  type ToolLoopGuardEvent,
} from "./toolLoopGuard";
import { initRuntimeState, stepToolLoopGuardRuntime } from "./toolLoopGuardRuntime";

const R = path.join(import.meta.dir, "results");
const RUNS = path.join(R, "runs");

const V0: ToolLoopGuardConfig = { ...DEFAULT_TOOL_LOOP_GUARD_CONFIG, enabled: true, calibration: "v0" };
const V4: ToolLoopGuardConfig = { ...DEFAULT_TOOL_LOOP_GUARD_CONFIG, enabled: true, calibration: "v4" };

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

interface TreatmentRow {
  instance_id: string;
  run_label: string;
}
interface AuditRow {
  instance_id: string;
  treatment_cost: number;
  tool_loop_or_thrashing_detected: boolean;
  paired_outcome: string;
  no_patch_exhaustion: boolean;
  treatment_resolved: boolean;
}

const m71 = readJson<TreatmentRow[]>(path.join(R, "stage5_m71_stage_a_50_treatment.detail.json")) ?? [];
const m72 = readJson<TreatmentRow[]>(path.join(R, "stage5_m72_stage_b_50_treatment.detail.json")) ?? [];
const treatment = [...m71, ...m72];
const audit = readJson<{ per_task_classification: AuditRow[] }>(
  path.join(R, "stage5_m74_self_harness_lite_audit.json"),
);
const auditById = new Map<string, AuditRow>((audit?.per_task_classification ?? []).map((r) => [r.instance_id, r]));

function findStream(runLabel: string): string | null {
  const base = path.join(RUNS, runLabel, "raw");
  if (!existsSync(base)) return null;
  const candidates: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name === "_tool_calls_with_outputs.json" || e.name === "_tool_calls.json") candidates.push(full);
    }
  };
  walk(base, 0);
  return candidates.find((c) => c.endsWith("_tool_calls_with_outputs.json")) ?? candidates.find((c) => c.endsWith("_tool_calls.json")) ?? null;
}

function groupOf(a: AuditRow | undefined): string {
  if (!a) return "unknown";
  if (a.treatment_cost >= 2.9) return "cap_hit";
  if (a.tool_loop_or_thrashing_detected) return "thrashing_signal";
  if (a.paired_outcome === "treatment_only_pass") return "treatment_only_win";
  if (a.paired_outcome === "baseline_only_pass") return "baseline_only_loss";
  if (a.no_patch_exhaustion) return "no_patch_exhaustion";
  if (a.treatment_resolved) return "normal_resolved_control";
  return "other_unresolved";
}

const RECALL_GROUPS = new Set(["cap_hit", "thrashing_signal"]);
const FP_GROUPS = new Set(["normal_resolved_control", "treatment_only_win", "baseline_only_loss"]);

// ---- cohort pass -----------------------------------------------------------
interface CohortCase {
  instance_id: string;
  group: string;
  events: ToolLoopGuardEvent[];
}
const cohort: CohortCase[] = [];
for (const t of treatment) {
  const stream = findStream(t.run_label);
  if (!stream) continue;
  const raw = readJson<Array<Record<string, unknown>>>(stream) ?? [];
  cohort.push({
    instance_id: t.instance_id,
    group: groupOf(auditById.get(t.instance_id)),
    events: raw.map((r, i) => toGuardEvent(r, i)),
  });
}

interface VariantAgg {
  recall_fires: number;
  recall_total: number;
  control_fp_fires: number;
  control_fp_total: number;
  treatment_only_win_fires: number;
  baseline_only_loss_fires: number;
  total_injections: number;
  total_suppressed: number;
}
function aggregate(config: ToolLoopGuardConfig): VariantAgg {
  const agg: VariantAgg = {
    recall_fires: 0,
    recall_total: 0,
    control_fp_fires: 0,
    control_fp_total: 0,
    treatment_only_win_fires: 0,
    baseline_only_loss_fires: 0,
    total_injections: 0,
    total_suppressed: 0,
  };
  for (const c of cohort) {
    const r = runToolLoopGuard(c.events, config);
    if (RECALL_GROUPS.has(c.group)) {
      agg.recall_total += 1;
      if (r.wouldFire) agg.recall_fires += 1;
    }
    if (FP_GROUPS.has(c.group)) {
      agg.control_fp_total += 1;
      if (r.wouldFire) agg.control_fp_fires += 1;
    }
    if (c.group === "treatment_only_win" && r.wouldFire) agg.treatment_only_win_fires += 1;
    if (c.group === "baseline_only_loss" && r.wouldFire) agg.baseline_only_loss_fires += 1;
    agg.total_injections += r.injectionCount;
    agg.total_suppressed += r.suppressedEvents.length;
  }
  return agg;
}

const cohortV0 = aggregate(V0);
const cohortV4 = aggregate(V4);

// ---- named live cases (M77 guarded streams) --------------------------------
const NAMED: { id: string; label: string; note: string }[] = [
  { id: "astropy__astropy-14598", label: "m77_tool_loop_guard_inject_astropy__astropy_14598_", note: "helpful read fire — must be PRESERVED" },
  { id: "pytest-dev__pytest-6197", label: "m77_tool_loop_guard_inject_pytest_dev__pytest_6197_", note: "risky early read fire — must be SUPPRESSED" },
  { id: "sympy__sympy-12419", label: "m77_tool_loop_guard_inject_sympy__sympy_12419_", note: "helpful command-failure fire — must be PRESERVED" },
  { id: "django__django-16263", label: "m77_tool_loop_guard_inject_django__django_16263_", note: "no-fire (cost case, not read-loop) — must stay no-fire" },
];

// Drive the runtime injector to verify observe/inject parity under V4.
function runtimeInjectionTurns(events: readonly ToolLoopGuardEvent[], config: ToolLoopGuardConfig): number[] {
  let state = initRuntimeState();
  const turns: number[] = [];
  for (const e of events) {
    const step = stepToolLoopGuardRuntime(state, e, config);
    state = step.state;
    if (step.injection) turns.push(step.injection.turnIndex);
  }
  return turns;
}

const named: Record<string, unknown> = {};
let parityOk = true;
let determinismOk = true;
const runtimeSimulation: Record<string, unknown> = {};
for (const n of NAMED) {
  const stream = findStream(n.label);
  const raw = stream ? readJson<Array<Record<string, unknown>>>(stream) ?? [] : [];
  const events = raw.map((r, i) => toGuardEvent(r, i));
  const v0 = runToolLoopGuard(events, V0);
  const v4 = runToolLoopGuard(events, V4);
  const observeTurns = v4.events.map((f) => f.turnIndex);
  const injectTurns = runtimeInjectionTurns(events, V4);
  const injectTurnsRerun = runtimeInjectionTurns(events, V4); // determinism: identical across reruns
  const parity = JSON.stringify(observeTurns) === JSON.stringify(injectTurns);
  const deterministic = JSON.stringify(injectTurns) === JSON.stringify(injectTurnsRerun);
  if (!parity) parityOk = false;
  if (!deterministic) determinismOk = false;
  runtimeSimulation[n.id] = {
    observe_fire_turns: observeTurns,
    inject_fire_turns: injectTurns,
    suppressed_turns: v4.suppressedEvents.map((s) => s.turnIndex),
    observe_inject_parity: parity,
    deterministic_across_reruns: deterministic,
  };
  named[n.id] = {
    note: n.note,
    stream_found: stream !== null,
    event_count: events.length,
    v0: { fires: v0.wouldFire, first_fire_turn: v0.firstEventTurn, triggers: v0.events.map((f) => f.triggerType) },
    v4: {
      fires: v4.wouldFire,
      first_fire_turn: v4.firstEventTurn,
      triggers: v4.events.map((f) => f.triggerType),
      suppressed: v4.suppressedEvents.map((s) => ({ turn: s.turnIndex, trigger: s.triggerType, reason: s.reason })),
    },
    runtime_observe_inject_parity: parity,
  };
}

// ---- deep-dive verdicts ----------------------------------------------------
const namedRec = named as Record<string, { v0: { fires: boolean }; v4: { fires: boolean; triggers: string[] } }>;
const deepDive = {
  "pytest-6197_suppressed": namedRec["pytest-dev__pytest-6197"]!.v0.fires && !namedRec["pytest-dev__pytest-6197"]!.v4.fires,
  "astropy-14598_preserved": namedRec["astropy__astropy-14598"]!.v4.fires,
  "sympy-12419_preserved": namedRec["sympy__sympy-12419"]!.v4.fires && namedRec["sympy__sympy-12419"]!.v4.triggers.includes("repeated_failed_command"),
  "django-16263_no_fire": !namedRec["django__django-16263"]!.v0.fires && !namedRec["django__django-16263"]!.v4.fires,
};

const expectations = {
  cap_thrash_recall_unchanged: cohortV4.recall_fires === cohortV0.recall_fires,
  normal_controls_not_increased: cohortV4.control_fp_fires <= cohortV0.control_fp_fires,
  treatment_only_wins_zero: cohortV4.treatment_only_win_fires === 0,
  baseline_only_losses_zero: cohortV4.baseline_only_loss_fires === 0,
  runtime_parity_ok: parityOk,
  runtime_deterministic: determinismOk,
  ...deepDive,
};
const allPass = Object.values(expectations).every(Boolean);

const replayOut = {
  milestone: "M79-v4-replay",
  kind: "offline V0-vs-V4 replay of the SHIPPED calibrated tool-loop guard; no live agents, no Docker, no API spend",
  live_agents: false,
  docker: false,
  retrieval_changed: false,
  uses_gold_for_detector: false,
  v0_config: V0,
  v4_config: V4,
  cohort_size: cohort.length,
  cohort_group_counts: cohort.reduce<Record<string, number>>((acc, c) => {
    acc[c.group] = (acc[c.group] ?? 0) + 1;
    return acc;
  }, {}),
  cohort_v0: cohortV0,
  cohort_v4: cohortV4,
  named_by_case: named,
  runtime_simulation: runtimeSimulation,
  deep_dive: deepDive,
  expectations,
  all_expectations_pass: allPass,
};

const summary = {
  milestone: "M79",
  kind: "compact V4 calibration replay summary",
  default_off: DEFAULT_TOOL_LOOP_GUARD_CONFIG.enabled === false,
  default_calibration_when_enabled: DEFAULT_TOOL_LOOP_GUARD_CONFIG.calibration,
  cohort_size: cohort.length,
  cap_thrash_recall: { v0: `${cohortV0.recall_fires}/${cohortV0.recall_total}`, v4: `${cohortV4.recall_fires}/${cohortV4.recall_total}` },
  normal_control_fp: { v0: `${cohortV0.control_fp_fires}/${cohortV0.control_fp_total}`, v4: `${cohortV4.control_fp_fires}/${cohortV4.control_fp_total}` },
  treatment_only_win_fires: { v0: cohortV0.treatment_only_win_fires, v4: cohortV4.treatment_only_win_fires },
  baseline_only_loss_fires: { v0: cohortV0.baseline_only_loss_fires, v4: cohortV4.baseline_only_loss_fires },
  total_injections: { v0: cohortV0.total_injections, v4: cohortV4.total_injections },
  v4_total_suppressed: cohortV4.total_suppressed,
  deep_dive: deepDive,
  runtime_observe_inject_parity: parityOk,
  runtime_deterministic: determinismOk,
  all_expectations_pass: allPass,
};

writeFileSync(path.join(R, "stage5_m79_tool_loop_guard_v4_replay.json"), `${JSON.stringify(replayOut, null, 2)}\n`);
writeFileSync(path.join(R, "stage5_m79_tool_loop_guard_v4_calibration.json"), `${JSON.stringify(summary, null, 2)}\n`);

console.log(`M79 V4 replay — cohort=${cohort.length} groups=${JSON.stringify(replayOut.cohort_group_counts)}`);
console.log(`  cap/thrash recall:  V0=${cohortV0.recall_fires}/${cohortV0.recall_total}  V4=${cohortV4.recall_fires}/${cohortV4.recall_total}`);
console.log(`  normal-control FP:  V0=${cohortV0.control_fp_fires}/${cohortV0.control_fp_total}  V4=${cohortV4.control_fp_fires}/${cohortV4.control_fp_total}`);
console.log(`  total injections:   V0=${cohortV0.total_injections}  V4=${cohortV4.total_injections}  (V4 suppressed=${cohortV4.total_suppressed})`);
for (const n of NAMED) {
  const c = namedRec[n.id]!;
  console.log(`  ${n.id.padEnd(26)} V0=${c.v0.fires ? "FIRE" : "supp"}  V4=${c.v4.fires ? "FIRE" : "supp"}  (${n.note})`);
}
console.log(`  deep-dive: ${JSON.stringify(deepDive)}`);
console.log(`  runtime observe/inject parity: ${parityOk}`);
console.log(`  ALL EXPECTATIONS PASS: ${allPass}`);
