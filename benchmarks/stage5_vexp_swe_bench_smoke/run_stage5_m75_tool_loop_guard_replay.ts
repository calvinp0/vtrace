// M75 offline replay: would the default-off tool-loop guard have fired on the
// completed M71/M72/M73 treatment runs? NO agents, NO Docker, NO API spend — this
// reads the already-captured `_tool_calls_with_outputs.json` streams and runs the
// PURE detector (`runToolLoopGuard`) over them, grouped by the M74 failure clusters.
//
// Usage:
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m75_tool_loop_guard_replay.ts
//
// Writes (additive, tracked report artifacts):
//   results/stage5_m75_tool_loop_guard_replay.json   (per-case + per-group)
//   results/stage5_m75_tool_loop_guard.json          (compact summary)

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  runToolLoopGuard,
  toGuardEvent,
  DEFAULT_TOOL_LOOP_GUARD_CONFIG,
  type ToolLoopGuardConfig,
} from "./toolLoopGuard";

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
  baseline_resolved: boolean;
  treatment_cost: number;
  cost_outlier: boolean;
  tool_loop_or_thrashing_detected: boolean;
  no_patch_exhaustion: boolean;
  repeated_file_reads: number;
}

const m71 = readJson<TreatmentRow[]>(path.join(R, "stage5_m71_stage_a_50_treatment.detail.json")) ?? [];
const m72 = readJson<TreatmentRow[]>(path.join(R, "stage5_m72_stage_b_50_treatment.detail.json")) ?? [];
const treatment = [...m71, ...m72];
const audit = readJson<{ per_task_classification: AuditRow[] }>(
  path.join(R, "stage5_m74_self_harness_lite_audit.json"),
);
const auditById = new Map<string, AuditRow>((audit?.per_task_classification ?? []).map((r) => [r.instance_id, r]));

// Locate the richest captured tool-call stream for a run label.
function findStream(runLabel: string): { file: string; kind: "rich" | "plain" } | null {
  const base = path.join(RUNS, runLabel, "raw");
  if (!existsSync(base)) return null;
  // walk one or two levels for the vtrace artifacts dir
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
  const rich = candidates.find((c) => c.endsWith("_tool_calls_with_outputs.json"));
  if (rich) return { file: rich, kind: "rich" };
  const plain = candidates.find((c) => c.endsWith("_tool_calls.json"));
  return plain ? { file: plain, kind: "plain" } : null;
}

const GUARD_CONFIG: ToolLoopGuardConfig = { ...DEFAULT_TOOL_LOOP_GUARD_CONFIG, enabled: true };

interface CaseResult {
  instance_id: string;
  repo: string;
  group: string;
  stream_kind: string;
  event_count: number;
  would_guard_fire: boolean;
  first_fire_turn: number | null;
  fire_count: number;
  trigger_types: string[];
  trigger_signatures: string[];
  repeated_read_count: number;
  repeated_command_failure_count: number;
  repeated_search_count: number;
  repeated_edit_failure_count: number;
  cost: number;
  resolved: boolean;
  cap_hit: boolean;
  early_fire: boolean; // fired before the run's last-quartile (i.e. before exhaustion)
}

// Assign each task to its primary validation group (priority order).
function groupOf(a: AuditRow | undefined): string {
  if (!a) return "unknown";
  if (a.treatment_cost >= 2.9) return "cap_hit";
  if (a.tool_loop_or_thrashing_detected) return "thrashing_signal";
  if (a.paired_outcome === "treatment_only_pass") return "treatment_only_win";
  if (a.paired_outcome === "baseline_only_pass") return "baseline_only_loss";
  if (a.no_patch_exhaustion) return "no_patch_exhaustion";
  if (a.treatment_cost >= 1.5) return "high_cost";
  if (a.treatment_resolved) return "normal_resolved_control";
  return "other_unresolved";
}

const cases: CaseResult[] = [];
for (const t of treatment) {
  const a = auditById.get(t.instance_id);
  const stream = findStream(t.run_label);
  if (!stream) continue;
  const raw = readJson<Array<Record<string, unknown>>>(stream.file) ?? [];
  const events = raw.map((r, i) => toGuardEvent(r, i));
  const res = runToolLoopGuard(events, GUARD_CONFIG);
  const lastIdx = events.length ? events[events.length - 1]!.index : 0;
  const earlyCut = lastIdx * 0.75;
  cases.push({
    instance_id: t.instance_id,
    repo: t.repo,
    group: groupOf(a),
    stream_kind: stream.kind,
    event_count: events.length,
    would_guard_fire: res.wouldFire,
    first_fire_turn: res.firstEventTurn,
    fire_count: res.injectionCount,
    trigger_types: [...new Set(res.events.map((e) => e.triggerType))],
    trigger_signatures: [...res.signatures],
    repeated_read_count: res.repeatedReadCount,
    repeated_command_failure_count: res.repeatedCommandFailureCount,
    repeated_search_count: res.repeatedSearchCount,
    repeated_edit_failure_count: res.repeatedEditFailureCount,
    cost: a?.treatment_cost ?? 0,
    resolved: a?.treatment_resolved ?? false,
    cap_hit: (a?.treatment_cost ?? 0) >= 2.9,
    early_fire: res.firstEventTurn !== null && res.firstEventTurn <= earlyCut,
  });
}

// ---- aggregate by group ----------------------------------------------------
const GROUP_ORDER = [
  "cap_hit",
  "thrashing_signal",
  "treatment_only_win",
  "baseline_only_loss",
  "no_patch_exhaustion",
  "high_cost",
  "normal_resolved_control",
  "other_unresolved",
  "unknown",
];
interface GroupAgg {
  group: string;
  cases: number;
  guard_fired: number;
  early_fire: number;
  late_fire: number;
  resolved_count: number;
  cost_total: number;
  cost_mean: number;
  fire_rate: number;
}
const byGroup: GroupAgg[] = [];
for (const g of GROUP_ORDER) {
  const cs = cases.filter((c) => c.group === g);
  if (cs.length === 0) continue;
  const fired = cs.filter((c) => c.would_guard_fire);
  byGroup.push({
    group: g,
    cases: cs.length,
    guard_fired: fired.length,
    early_fire: cs.filter((c) => c.would_guard_fire && c.early_fire).length,
    late_fire: cs.filter((c) => c.would_guard_fire && !c.early_fire).length,
    resolved_count: cs.filter((c) => c.resolved).length,
    cost_total: Number(cs.reduce((s, c) => s + c.cost, 0).toFixed(2)),
    cost_mean: Number((cs.reduce((s, c) => s + c.cost, 0) / cs.length).toFixed(3)),
    fire_rate: Number((fired.length / cs.length).toFixed(2)),
  });
}

const capHit = cases.filter((c) => c.group === "cap_hit");
const thrash = cases.filter((c) => c.group === "thrashing_signal" || c.group === "cap_hit");
const controls = cases.filter((c) => c.group === "normal_resolved_control");
const summary = {
  milestone: "M75",
  kind: "Offline replay of the default-off tool-loop guard over M71/M72/M73 treatment streams",
  live_agents: false,
  docker: false,
  api_spend: false,
  guard_config: GUARD_CONFIG,
  total_cases: cases.length,
  deterministic: true,
  used_gold_labels: false,
  headline: {
    cap_hit_cases: capHit.length,
    cap_hit_guard_fired: capHit.filter((c) => c.would_guard_fire).length,
    cap_hit_early_fire: capHit.filter((c) => c.would_guard_fire && c.early_fire).length,
    thrash_or_cap_cases: thrash.length,
    thrash_or_cap_fired: thrash.filter((c) => c.would_guard_fire).length,
    normal_control_cases: controls.length,
    normal_control_fired: controls.filter((c) => c.would_guard_fire).length,
    normal_control_early_fire: controls.filter((c) => c.would_guard_fire && c.early_fire).length,
  },
  by_group: byGroup,
};

const replayOut = {
  milestone: "M75",
  guard_config: GUARD_CONFIG,
  by_group: byGroup,
  cases: cases.sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : a.instance_id < b.instance_id ? -1 : 1)),
};

const { writeFileSync } = await import("node:fs");
writeFileSync(path.join(R, "stage5_m75_tool_loop_guard_replay.json"), `${JSON.stringify(replayOut, null, 2)}\n`);
writeFileSync(path.join(R, "stage5_m75_tool_loop_guard.json"), `${JSON.stringify(summary, null, 2)}\n`);

// console summary
console.log("M75 tool-loop guard replay —", cases.length, "treatment cases");
console.log("config:", JSON.stringify({ ...GUARD_CONFIG, enabled: true }));
for (const g of byGroup) {
  console.log(
    `  ${g.group.padEnd(24)} cases=${String(g.cases).padStart(2)} fired=${String(g.guard_fired).padStart(2)} ` +
      `(early ${g.early_fire}/ late ${g.late_fire}) rate=${g.fire_rate} resolved=${g.resolved_count} meanCost=$${g.cost_mean}`,
  );
}
console.log("headline:", JSON.stringify(summary.headline, null, 1));
