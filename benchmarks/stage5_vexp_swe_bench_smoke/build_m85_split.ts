/**
 * M85 — build the FROZEN V4 + C7_D combined-guard live-validation split (10 cases) DETERMINISTICALLY
 * from three committed sources, with NO live agents / NO Docker / NO spend:
 *
 *   - stage5_m82_v4_c7_live_split.json        (frozen membership + M73/M80 priors)
 *   - stage5_m82_v4_c7_live_validation.detail.json  (ACTUAL M82 V4+C7_V0 live outcomes)
 *   - stage5_m84_c7d_replay.json              (offline C7_D first-fire expectations)
 *
 * Membership is identical to M82/M80/M77 (A=4,B=2,C=2,D=2). No case added/dropped/reordered.
 * The M85 split carries prior_m82_* actuals and prior_m84_expected_c7d_* so the analyzer/report
 * can compare M85 live behavior against M73 / M80 / M82 / the M84 C7_D replay expectation.
 *
 *   bun build_m85_split.ts [--out dir]
 */
import path from "node:path";
import fs from "node:fs";

const ROOT = "/home/calvin/code/vtrace";
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
function flag(name: string, fb: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fb;
}
const OUT = flag("--out", RESULTS);
const readJson = (f: string): any => JSON.parse(fs.readFileSync(f, "utf8"));

const m82Split = readJson(path.join(RESULTS, "stage5_m82_v4_c7_live_split.json"));
const m82Detail = readJson(path.join(RESULTS, "stage5_m82_v4_c7_live_validation.detail.json"));
const m84Replay = readJson(path.join(RESULTS, "stage5_m84_c7d_replay.json"));

const m82ById = new Map<string, any>((m82Detail.cases as any[]).map((c) => [c.instance_id, c]));
// M84 replay c7d cohort per-case rows (offline first-fire expectation under editVerifyChurnThreshold=2).
const m84C7dById = new Map<string, any>(
  (m84Replay.m82_per_case as any[]).filter((r) => r.calibration === "c7d").map((r) => [r.instance_id, r]),
);

const cases = (m82Split.cases as any[]).map((c) => {
  const m82 = m82ById.get(c.instance_id);
  const m84 = m84C7dById.get(c.instance_id);
  if (!m82) throw new Error(`missing M82 actual for ${c.instance_id}`);
  if (!m84) throw new Error(`missing M84 c7d expectation for ${c.instance_id}`);

  const m82Triggers: string[] = m82.cost_guard_trigger_types ?? [];
  const m84Triggers: string[] = m84.m82_triggers ?? [];

  return {
    instance_id: c.instance_id,
    repo: c.repo,
    difficulty: c.difficulty,
    validation_group: c.validation_group,
    // ---- M73 unguarded treatment priors (carried from M82 split) ----
    prior_m73_treatment_resolved: c.prior_m73_treatment_resolved,
    prior_m73_treatment_cost: c.prior_m73_treatment_cost,
    prior_m73_tool_calls: c.prior_m73_tool_calls,
    // ---- M80 V4-only live priors (carried from M82 split) ----
    prior_m80_resolved: c.prior_m80_resolved,
    prior_m80_cost: c.prior_m80_cost,
    prior_m80_turns: c.prior_m80_turns,
    prior_m80_tool_calls: c.prior_m80_tool_calls,
    prior_m80_v4_fired: c.prior_m80_v4_fired,
    prior_m80_v4_first_turn: c.prior_m80_v4_first_turn,
    // ---- M82 V4 + C7_V0 ACTUAL live outcomes (from the captured M82 detail) ----
    prior_m82_resolved: m82.resolved ?? null,
    prior_m82_cost: m82.cost ?? null,
    prior_m82_tool_calls: m82.tool_call_count ?? null,
    prior_m82_turns: m82.turn_count ?? null,
    prior_m82_v4_fired: m82.v4_fired ?? null,
    prior_m82_v4_first_turn: m82.tool_loop_guard_first_event_turn ?? null,
    prior_m82_c7_fired: m82.c7_fired ?? null,
    prior_m82_c7_trigger_type: m82Triggers.length ? m82Triggers : null,
    prior_m82_c7_first_fire_turn: m82.cost_guard_first_event_turn ?? null,
    // ---- M84 OFFLINE C7_D first-fire expectation (editVerifyChurnThreshold=2 replay) ----
    prior_m84_expected_c7d_fire: m84.m82_first_fire !== null,
    prior_m84_expected_trigger_type: m84Triggers.length ? m84Triggers : null,
    prior_m84_expected_first_fire_turn: m84.m82_first_fire ?? null,
    prior_m84_first_fire_delta_vs_v0: m84.first_fire_delta_vs_v0 ?? null,
    // carry the M82 split's analytical note for traceability
    note: c.note,
  };
});

const summary = {
  milestone: "M85-split",
  kind:
    "frozen V4 + C7_D (editVerifyChurnThreshold=2) combined-guard live-validation split (10 cases); " +
    "IDENTICAL membership to the frozen M82/M80/M77 split, carrying M73/M80 priors, ACTUAL M82 V4+C7_V0 " +
    "live outcomes, and the M84 offline C7_D first-fire expectation",
  live_agents: false,
  docker: false,
  retrieval_changed: false,
  derived_from: [
    "stage5_m82_v4_c7_live_split.json (frozen membership + M73/M80 priors)",
    "stage5_m82_v4_c7_live_validation.detail.json (ACTUAL M82 V4+C7_V0 live outcomes)",
    "stage5_m84_c7d_replay.json (offline C7_D first-fire expectation)",
  ],
  freeze_note:
    "Membership identical to the frozen M82/M80/M77 10-case split (A=4,B=2,C=2,D=2). No case added, " +
    "dropped, reordered, or excluded after seeing any live result. C7_D changes ONLY editVerifyChurnThreshold " +
    "(3->2); the 25-tool gate and every other threshold are unchanged. Both guards remain DEFAULT-OFF.",
  no_replacements: true,
  selected_counts: { A: 4, B: 2, C: 2, D: 2 },
  total_selected: cases.length,
  group_definitions: m82Split.group_definitions,
  guard_condition: {
    tool_loop_guard_mode: "inject",
    tool_loop_guard_calibration: "v4",
    cost_guard_mode: "inject",
    cost_guard_calibration: "c7d",
    cost_guard_edit_verify_churn_threshold: 2,
    cost_guard_min_tool_calls_gate: 25,
  },
  cases,
  prior_resolution_rollup: {
    m73_resolved: cases.filter((c) => c.prior_m73_treatment_resolved === true).length,
    m80_resolved: cases.filter((c) => c.prior_m80_resolved === true).length,
    m82_resolved: cases.filter((c) => c.prior_m82_resolved === true).length,
    m82_v4_fired_instances: cases.filter((c) => c.prior_m82_v4_fired === true).map((c) => c.instance_id),
    m82_c7_fired_instances: cases.filter((c) => c.prior_m82_c7_fired === true).map((c) => c.instance_id),
    m84_expected_c7d_fire_instances: cases
      .filter((c) => c.prior_m84_expected_c7d_fire === true)
      .map((c) => c.instance_id),
    m84_c7d_earlier_than_v0_instances: cases
      .filter((c) => (c.prior_m84_first_fire_delta_vs_v0 ?? 0) > 0)
      .map((c) => c.instance_id),
  },
};

fs.writeFileSync(path.join(OUT, "stage5_m85_v4_c7d_live_split.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(
  "SPLIT_BUILT: " +
    JSON.stringify({
      total: summary.total_selected,
      counts: summary.selected_counts,
      m82_c7_fired: summary.prior_resolution_rollup.m82_c7_fired_instances,
      m84_expected_c7d: summary.prior_resolution_rollup.m84_expected_c7d_fire_instances,
      m84_earlier: summary.prior_resolution_rollup.m84_c7d_earlier_than_v0_instances,
    }),
);
