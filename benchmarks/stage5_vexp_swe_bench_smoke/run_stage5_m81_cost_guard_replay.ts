#!/usr/bin/env bun
// M81 offline replay / calibration for the C7 cost / no-convergence guard.
//
// NO live agents, NO Docker, NO API spend. It replays the DEFAULT cost-guard config over
// the captured tool-call streams of the frozen M80 V4 split (the 10 calibrated cases) plus
// the M77 inject split (cross-check), joining each run's cost/turns/resolved from the
// TRACKED detail JSONs. For each run it computes would_cost_guard_fire / first_fire_turn /
// fire_count / trigger types + a per-case snapshot, then rolls the cases up by cohort.
//
// Raw streams are read ONLY for replay (never staged). The committed outputs are the two
// COMPACT JSON summaries (no raw stream content):
//   results/stage5_m81_cost_guard_replay.json   — per-case verdicts + cohort rollups
//   results/stage5_m81_cost_guard.json           — implementation + threshold + rollup summary
//
// Usage:  bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m81_cost_guard_replay.ts

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runCostGuard,
  toCostGuardEvent,
  DEFAULT_COST_GUARD_CONFIG,
  type CostGuardEvent,
  type CostGuardRunContext,
  type CostGuardTriggerType,
} from "./costGuard";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, "results");
const RUNS = path.join(RESULTS, "runs");

// Cohort taxonomy for the replay rollup (M81 brief "Required cohorts"). Each case is
// tagged from the TRACKED M77 split metadata + M80 detail (outcome-blind selection).
interface CaseMeta {
  readonly instanceId: string;
  readonly cohort: string; // human cohort label
  readonly m80RunLabel: string;
  readonly m77RunLabel: string;
}

// Built from stage5_m77_tool_loop_guard_live_split.json (groups) + the M80 detail. Cohort
// labels follow the M81 "Required cohorts" list; a case may belong to several conceptually
// (e.g. django-12273 is BOTH a protected treatment-only win AND a cap-hit) — we pick the
// most decision-relevant label and note overlaps in the report.
const CASES: readonly CaseMeta[] = [
  { instanceId: "astropy__astropy-14598", cohort: "cap_hit_cluster", m80RunLabel: "m80_tool_loop_guard_v4_astropy__astropy_14598", m77RunLabel: "m77_tool_loop_guard_inject_astropy__astropy_14598_" },
  { instanceId: "django__django-15503", cohort: "cap_hit_high_cost_resolved", m80RunLabel: "m80_tool_loop_guard_v4_django__django_15503", m77RunLabel: "m77_tool_loop_guard_inject_django__django_15503_" },
  { instanceId: "django__django-16263", cohort: "high_cost_no_convergence", m80RunLabel: "m80_tool_loop_guard_v4_django__django_16263", m77RunLabel: "m77_tool_loop_guard_inject_django__django_16263_" },
  { instanceId: "pytest-dev__pytest-6197", cohort: "normal_control_low_cost", m80RunLabel: "m80_tool_loop_guard_v4_pytest_dev__pytest_6197", m77RunLabel: "m77_tool_loop_guard_inject_pytest_dev__pytest_6197_" },
  { instanceId: "pylint-dev__pylint-4551", cohort: "cap_hit_cluster_not_fired", m80RunLabel: "m80_tool_loop_guard_v4_pylint_dev__pylint_4551", m77RunLabel: "m77_tool_loop_guard_inject_pylint_dev__pylint_4551_" },
  { instanceId: "sympy__sympy-12419", cohort: "protected_win_command_loop", m80RunLabel: "m80_tool_loop_guard_v4_sympy__sympy_12419", m77RunLabel: "m77_tool_loop_guard_inject_sympy__sympy_12419_" },
  { instanceId: "django__django-11815", cohort: "treatment_only_win_low_cost", m80RunLabel: "m80_tool_loop_guard_v4_django__django_11815", m77RunLabel: "m77_tool_loop_guard_inject_django__django_11815_" },
  { instanceId: "django__django-12273", cohort: "protected_win_high_cost", m80RunLabel: "m80_tool_loop_guard_v4_django__django_12273", m77RunLabel: "m77_tool_loop_guard_inject_django__django_12273_" },
  { instanceId: "astropy__astropy-7166", cohort: "normal_control_low_cost", m80RunLabel: "m80_tool_loop_guard_v4_astropy__astropy_7166", m77RunLabel: "m77_tool_loop_guard_inject_astropy__astropy_7166_" },
  { instanceId: "django__django-10880", cohort: "normal_control_low_cost", m80RunLabel: "m80_tool_loop_guard_v4_django__django_10880", m77RunLabel: "m77_tool_loop_guard_inject_django__django_10880_" },
];

async function readJson(file: string): Promise<unknown | null> {
  return readFile(file, "utf8")
    .then((c) => JSON.parse(c) as unknown)
    .catch(() => null);
}

// Load the ordered event stream for a run-label (rich stream preferred). Returns [] when
// absent (raw streams are local-only) so the replay degrades to the detail-aggregate path.
async function loadStream(runLabel: string): Promise<CostGuardEvent[]> {
  const dir = path.join(RUNS, runLabel, "raw", "vtrace");
  for (const name of ["_tool_calls_with_outputs.json", "_tool_calls.json"]) {
    const parsed = await readJson(path.join(dir, name));
    if (Array.isArray(parsed) && parsed.length > 0) {
      return (parsed as Array<Record<string, unknown>>).map((r, i) => toCostGuardEvent(r, i));
    }
  }
  return [];
}

interface DetailRow {
  cost: number | null;
  turns: number | null;
  toolCount: number | null;
  edits: number | null;
  resolved: boolean | null;
}

async function loadM80Detail(): Promise<Map<string, DetailRow>> {
  const detail = (await readJson(path.join(RESULTS, "stage5_m80_tool_loop_guard_v4_live_validation.detail.json"))) as
    | { cases?: Array<Record<string, unknown>> }
    | null;
  const map = new Map<string, DetailRow>();
  for (const c of detail?.cases ?? []) {
    const id = String(c.instance_id);
    map.set(id, {
      cost: typeof c.cost === "number" ? c.cost : null,
      turns: typeof c.turn_count === "number" ? c.turn_count : null,
      toolCount: typeof c.tool_call_count === "number" ? c.tool_call_count : null,
      edits: typeof c.edits === "number" ? c.edits : null,
      resolved: typeof c.resolved === "boolean" ? c.resolved : null,
    });
  }
  return map;
}

interface CaseVerdict {
  instance_id: string;
  cohort: string;
  source_split: string;
  would_cost_guard_fire: boolean;
  first_fire_turn: number | null;
  fire_count: number;
  trigger_types: CostGuardTriggerType[];
  trigger_signatures: string[];
  suppressed_count: number;
  prior_tool_count: number;
  prior_edit_count: number;
  prior_verify_count: number;
  max_same_file_edits: number;
  patch_seen: boolean;
  cost: number | null;
  turns: number | null;
  resolved: boolean | null;
  late_fire: boolean; // first fire in the last quarter of the stream
}

function classify(events: CostGuardEvent[], detail: DetailRow, meta: CaseMeta, split: string): CaseVerdict {
  const context: CostGuardRunContext = { estimatedCostUsd: detail.cost, turnCount: detail.turns };
  const result = runCostGuard(events, { ...DEFAULT_COST_GUARD_CONFIG, enabled: true }, context);
  const first = result.events[0] ?? null;
  const total = events.length || 1;
  const firstFire = result.firstEventTurn;
  // position of first fire among tool calls (events are 0-indexed by `index`)
  const lateFire = firstFire !== null && firstFire >= Math.floor(total * 0.75);
  const editCount = events.filter((e) => e.category === "edit").length;
  const verifyCount = first?.snapshot.verifyCount ?? 0;
  return {
    instance_id: meta.instanceId,
    cohort: meta.cohort,
    source_split: split,
    would_cost_guard_fire: result.wouldFire,
    first_fire_turn: firstFire,
    fire_count: result.events.length,
    trigger_types: result.events.map((e) => e.triggerType),
    trigger_signatures: [...result.signatures],
    suppressed_count: result.suppressedEvents.length,
    prior_tool_count: first ? first.snapshot.toolCount : events.length,
    prior_edit_count: first ? first.snapshot.editCount : editCount,
    prior_verify_count: verifyCount,
    max_same_file_edits: result.maxSameFileEditCount,
    patch_seen: first ? first.snapshot.patchSeen : editCount > 0,
    cost: detail.cost,
    turns: detail.turns,
    resolved: detail.resolved,
    late_fire: lateFire,
  };
}

async function main(): Promise<void> {
  const detailMap = await loadM80Detail();
  const verdicts: CaseVerdict[] = [];
  for (const meta of CASES) {
    const detail = detailMap.get(meta.instanceId) ?? { cost: null, turns: null, toolCount: null, edits: null, resolved: null };
    const m80Events = await loadStream(meta.m80RunLabel);
    verdicts.push(classify(m80Events, detail, meta, "m80_v4"));
  }

  // cohort rollup
  const cohorts = new Map<string, { cases: number; fired: number; early: number; late: number; resolved: number }>();
  for (const v of verdicts) {
    const c = cohorts.get(v.cohort) ?? { cases: 0, fired: 0, early: 0, late: 0, resolved: 0 };
    c.cases += 1;
    if (v.would_cost_guard_fire) c.fired += 1;
    if (v.would_cost_guard_fire && v.late_fire) c.late += 1;
    if (v.would_cost_guard_fire && !v.late_fire) c.early += 1;
    if (v.resolved === true) c.resolved += 1;
    cohorts.set(v.cohort, c);
  }
  const rollup = [...cohorts.entries()].map(([cohort, s]) => ({ cohort, ...s })).sort((a, b) => a.cohort.localeCompare(b.cohort));

  const firedCases = verdicts.filter((v) => v.would_cost_guard_fire);
  const protectedWinFires = verdicts.filter(
    (v) => v.would_cost_guard_fire && (v.cohort.startsWith("treatment_only_win") || v.cohort === "protected_win_command_loop"),
  );
  const controlFires = verdicts.filter((v) => v.would_cost_guard_fire && v.cohort.startsWith("normal_control"));

  const replay = {
    milestone: "M81",
    kind: "C7 cost / no-convergence guard offline replay (no agents, no Docker)",
    live_agents: false,
    docker: false,
    retrieval_changed: false,
    guard_config: { ...DEFAULT_COST_GUARD_CONFIG, enabled: true },
    source_splits: ["m80_v4 (frozen calibrated split, raw streams local-only)"],
    case_count: verdicts.length,
    summary: {
      fired: firedCases.length,
      not_fired: verdicts.length - firedCases.length,
      protected_win_or_command_loop_fires: protectedWinFires.length,
      normal_control_fires: controlFires.length,
      // honest early-orientation = a fire that landed before the min tool-call gate (by
      // construction the gate forbids this, so this should always be 0).
      early_orientation_fires: verdicts.filter((v) => v.would_cost_guard_fire && v.prior_tool_count < DEFAULT_COST_GUARD_CONFIG.minToolCallsBeforeFire).length,
    },
    cohort_rollup: rollup,
    cases: verdicts,
  };

  const replayPath = path.join(RESULTS, "stage5_m81_cost_guard_replay.json");
  await writeFile(replayPath, `${JSON.stringify(replay, null, 2)}\n`);

  const summary = {
    milestone: "M81",
    title: "Default-off cost / no-convergence guard (C7)",
    implemented: true,
    default_off: true,
    flags: ["--cost-guard", "--cost-guard-mode observe|inject", "--cost-guard-inject"],
    modes: { observe: "observe_post_run", inject: "runtime_injection" },
    marker: "<VTRACE_COST_GUARD>",
    runtime_integration: "M76 Claude Code PostToolUse --settings hook (combined hook; cost guard owns the single registration when injecting)",
    trigger_types: [
      "high_tool_count",
      "high_turn_count",
      "edit_verify_churn",
      "no_patch_drift",
      "repeated_verification_no_progress",
      "cost_cap_approaching",
    ],
    thresholds: { ...DEFAULT_COST_GUARD_CONFIG, enabled: true },
    guard_priority_with_tool_loop_guard: "cost guard priority near budget; if both fire on the same tool result, ONE combined message (cost text + one-line tool-loop tail)",
    replay_rollup: rollup,
    replay_summary: replay.summary,
    coexists_with_v4: true,
    v4_unchanged: true,
  };
  const summaryPath = path.join(RESULTS, "stage5_m81_cost_guard.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  // eslint-disable-next-line no-console
  console.log(`wrote ${path.relative(HERE, replayPath)} and ${path.relative(HERE, summaryPath)}`);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ rollup, summary: replay.summary }, null, 2));
  for (const v of verdicts) {
    // eslint-disable-next-line no-console
    console.log(
      `${v.instance_id.padEnd(26)} ${v.cohort.padEnd(28)} fire=${v.would_cost_guard_fire ? "Y" : "n"} first=${String(v.first_fire_turn ?? "-").padStart(3)} n=${v.fire_count} [${v.trigger_types.join(",")}] cost=${v.cost?.toFixed(2) ?? "-"} resolved=${v.resolved}`,
    );
  }
}

void main();
