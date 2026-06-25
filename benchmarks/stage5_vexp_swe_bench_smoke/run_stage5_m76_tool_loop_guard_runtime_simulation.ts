// M76 offline simulation: replay the captured M71/M72/M73 treatment tool-call
// streams through the RUNTIME injector state machine (event-by-event, exactly as
// the live PostToolUse hook would) and verify it fires at the SAME turns as the
// M75 observe-mode batch detector. NO agents, NO Docker, NO API spend — this reads
// the already-captured `_tool_calls_with_outputs.json` streams and steps the pure
// `stepToolLoopGuardRuntime` over them.
//
// Usage:
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m76_tool_loop_guard_runtime_simulation.ts
//
// Writes (additive, tracked report artifacts):
//   results/stage5_m76_tool_loop_guard_runtime_simulation.json   (per-case + per-group)
//   results/stage5_m76_tool_loop_guard_runtime_hook.json         (compact summary)

import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  runToolLoopGuard,
  toGuardEvent,
  DEFAULT_TOOL_LOOP_GUARD_CONFIG,
  type ToolLoopGuardConfig,
  type ToolLoopGuardEvent,
  type ToolLoopGuardFiring,
} from "./toolLoopGuard";
import { initRuntimeState, stepToolLoopGuardRuntime } from "./toolLoopGuardRuntime";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const R = path.join(HERE, "results");
const RUNS = path.join(R, "runs");

const readJson = <T>(p: string): T | null => {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
};

interface TreatmentRow {
  instance_id: string;
  repo: string;
  run_label: string;
}
interface AuditRow {
  instance_id: string;
  paired_outcome: string;
  treatment_resolved: boolean;
  treatment_cost: number;
  tool_loop_or_thrashing_detected: boolean;
  no_patch_exhaustion: boolean;
}

const m71 = readJson<TreatmentRow[]>(path.join(R, "stage5_m71_stage_a_50_treatment.detail.json")) ?? [];
const m72 = readJson<TreatmentRow[]>(path.join(R, "stage5_m72_stage_b_50_treatment.detail.json")) ?? [];
const treatment = [...m71, ...m72];
const audit = readJson<{ per_task_classification: AuditRow[] }>(
  path.join(R, "stage5_m74_self_harness_lite_audit.json"),
);
const auditById = new Map<string, AuditRow>((audit?.per_task_classification ?? []).map((r) => [r.instance_id, r]));

// Same group assignment as the M75 replay so the two reports line up 1:1.
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

const GUARD_CONFIG: ToolLoopGuardConfig = { ...DEFAULT_TOOL_LOOP_GUARD_CONFIG, enabled: true };

// Drive the runtime injector over a full stream, returning the ordered injections
// (one per delivered message) exactly as the live PostToolUse hook would produce.
function driveRuntime(events: readonly ToolLoopGuardEvent[]): ToolLoopGuardFiring[] {
  let state = initRuntimeState();
  const injections: ToolLoopGuardFiring[] = [];
  for (const e of events) {
    const step = stepToolLoopGuardRuntime(state, e, GUARD_CONFIG);
    state = step.state;
    if (step.injection) injections.push(step.injection);
  }
  return injections;
}

// Compact, comparable fingerprint of a firing list.
const fingerprint = (fs: readonly ToolLoopGuardFiring[]): string =>
  JSON.stringify(fs.map((f) => [f.turnIndex, f.triggerType, f.signature]));

interface CaseResult {
  instance_id: string;
  group: string;
  event_count: number;
  observe_event_count: number;
  runtime_injection_count: number;
  observe_first_turn: number | null;
  runtime_first_turn: number | null;
  timing_matches_observe: boolean;
  deterministic: boolean;
}

const cases: CaseResult[] = [];
for (const t of treatment) {
  const a = auditById.get(t.instance_id);
  const file = findStream(t.run_label);
  if (!file) continue;
  const raw = readJson<Array<Record<string, unknown>>>(file) ?? [];
  const events = raw.map((r, i) => toGuardEvent(r, i));

  // observe-mode batch firing list (M75 single source of truth)
  const observe = runToolLoopGuard(events, GUARD_CONFIG).events;
  // runtime injector, twice (determinism check)
  const runtimeA = driveRuntime(events);
  const runtimeB = driveRuntime(events);

  cases.push({
    instance_id: t.instance_id,
    group: groupOf(a),
    event_count: events.length,
    observe_event_count: observe.length,
    runtime_injection_count: runtimeA.length,
    observe_first_turn: observe.length ? observe[0]!.turnIndex : null,
    runtime_first_turn: runtimeA.length ? runtimeA[0]!.turnIndex : null,
    // Under the production cooldown (>=1) the detector fires at most once per index,
    // so the runtime's per-turn injections match the observe firing list exactly.
    timing_matches_observe: fingerprint(runtimeA) === fingerprint(observe),
    deterministic: fingerprint(runtimeA) === fingerprint(runtimeB),
  });
}

// ---- aggregate by group ----------------------------------------------------
const GROUP_ORDER = [
  "cap_hit",
  "thrashing_signal",
  "treatment_only_win",
  "baseline_only_loss",
  "no_patch_exhaustion",
  "normal_resolved_control",
  "other_unresolved",
  "unknown",
];
interface GroupAgg {
  group: string;
  cases: number;
  observe_events_total: number;
  runtime_injections_total: number;
  timing_match_cases: number;
  deterministic_cases: number;
}
const byGroup: GroupAgg[] = [];
for (const g of GROUP_ORDER) {
  const cs = cases.filter((c) => c.group === g);
  if (cs.length === 0) continue;
  byGroup.push({
    group: g,
    cases: cs.length,
    observe_events_total: cs.reduce((s, c) => s + (c.observe_event_count > 0 ? 1 : 0), 0),
    runtime_injections_total: cs.reduce((s, c) => s + (c.runtime_injection_count > 0 ? 1 : 0), 0),
    timing_match_cases: cs.filter((c) => c.timing_matches_observe).length,
    deterministic_cases: cs.filter((c) => c.deterministic).length,
  });
}

const allMatch = cases.every((c) => c.timing_matches_observe);
const allDeterministic = cases.every((c) => c.deterministic);
const firedCases = cases.filter((c) => c.runtime_injection_count > 0);

const summary = {
  milestone: "M76",
  kind: "Offline simulation of the runtime tool-loop-guard injector over captured M71/M72/M73 treatment streams",
  live_agents: false,
  docker: false,
  api_spend: false,
  guard_config: GUARD_CONFIG,
  total_cases: cases.length,
  cases_with_runtime_injection: firedCases.length,
  total_runtime_injections: cases.reduce((s, c) => s + c.runtime_injection_count, 0),
  total_observe_events: cases.reduce((s, c) => s + c.observe_event_count, 0),
  runtime_matches_observe_timing_all_cases: allMatch,
  deterministic_all_cases: allDeterministic,
  by_group: byGroup,
  verdict:
    allMatch && allDeterministic
      ? "PASS — runtime injector fires at the same turns as M75 observe mode, deterministic across reruns"
      : "ATTENTION — runtime/observe divergence or nondeterminism; see per-case detail",
};

const detail = { milestone: "M76", guard_config: GUARD_CONFIG, by_group: byGroup, cases: cases.sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : a.instance_id < b.instance_id ? -1 : 1)) };

writeFileSync(path.join(R, "stage5_m76_tool_loop_guard_runtime_simulation.json"), `${JSON.stringify(detail, null, 2)}\n`);
writeFileSync(path.join(R, "stage5_m76_tool_loop_guard_runtime_hook.json"), `${JSON.stringify(summary, null, 2)}\n`);

console.log("M76 runtime-injector simulation —", cases.length, "treatment cases");
console.log(`  runtime matches observe timing (all cases): ${allMatch}`);
console.log(`  deterministic across reruns (all cases):     ${allDeterministic}`);
console.log(`  cases with >=1 runtime injection:            ${firedCases.length}`);
for (const g of byGroup) {
  console.log(
    `  ${g.group.padEnd(24)} cases=${String(g.cases).padStart(2)} fired=${String(g.runtime_injections_total).padStart(2)} ` +
      `timingMatch=${g.timing_match_cases}/${g.cases} deterministic=${g.deterministic_cases}/${g.cases}`,
  );
}
console.log("verdict:", summary.verdict);
