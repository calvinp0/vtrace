/**
 * M77 — build the FROZEN tool-loop-guard live validation split from the M73/M74/M75/M76
 * artifacts (NO live agents, NO Docker, NO API spend). Deterministic: selection is a
 * pure, outcome-blind rule over the M75 replay groups + M74 cost-cap cluster, enriched
 * with prior M73 treatment metrics and M75/M76 guard-fire data.
 *
 * Selection rule (outcome-blind; sorts by instance_id, never by resolved/cost):
 *   Group A (4) targeted thrash/cap-hit, guard FIRED   : cap_hit-fired first (M74 cluster),
 *                                                         then thrashing-fired, sorted by id.
 *   Group B (2) targeted thrash/cap-hit, guard NOT fired: cap_hit-not-fired first, sorted by id.
 *   Group C (2) protected treatment_only wins, NOT fired: treatment_only_win sorted by id.
 *   Group D (2) normal resolved / low-cost controls, NOT fired: normal_resolved_control
 *                                                         (guard did not fire) sorted by id.
 *
 *   bun build_m77_split.ts
 */
import path from "node:path";

const RESULTS = path.join("/home/calvin/code/vtrace/benchmarks/stage5_vexp_swe_bench_smoke/results");
const read = (f: string) => JSON.parse(require("node:fs").readFileSync(path.join(RESULTS, f), "utf8"));

const m73Detail = read("stage5_m73_final_100_paired.detail.json") as Array<Record<string, any>>;
const m74 = read("stage5_m74_self_harness_lite_audit.json") as Record<string, any>;
const m75 = read("stage5_m75_tool_loop_guard_replay.json") as Record<string, any>;
const m76 = read("stage5_m76_tool_loop_guard_runtime_simulation.json") as Record<string, any>;

const m73By = new Map(m73Detail.map((r) => [r.instance_id, r]));
const m75By = new Map((m75.cases as any[]).map((c) => [c.instance_id, c]));
const m76By = new Map((m76.cases as any[]).map((c) => [c.instance_id, c]));
const capCluster: string[] = m74.cost_cap_exhaustion.instances;

const inGroup = (g: string) => (m75.cases as any[]).filter((c) => c.group === g).map((c) => c.instance_id).sort();
const fired = (id: string) => (m75By.get(id)?.would_guard_fire as boolean) === true;

// Group A — fired targeted: cap_hit fired first (primary M74 cluster), then thrashing fired.
const capFired = inGroup("cap_hit").filter(fired);
const thrashFired = inGroup("thrashing_signal").filter(fired);
const groupA = [...capFired, ...thrashFired].slice(0, 4);

// Group B — not-fired targeted: cap_hit not-fired first, then thrashing not-fired.
const capNot = inGroup("cap_hit").filter((id) => !fired(id));
const thrashNot = inGroup("thrashing_signal").filter((id) => !fired(id));
const groupB = [...capNot, ...thrashNot].slice(0, 2);

// Group C — protected treatment_only wins (none fire by construction).
const groupC = inGroup("treatment_only_win").filter((id) => !fired(id)).slice(0, 2);

// Group D — normal resolved controls where the guard did NOT fire (low-cost majority).
const groupD = inGroup("normal_resolved_control").filter((id) => !fired(id)).slice(0, 2);

const groups: Record<string, string[]> = { A: groupA, B: groupB, C: groupC, D: groupD };
const groupMeta: Record<string, { name: string; intent: string; target: number }> = {
  A: { name: "targeted_thrash_caphit_guard_fired", intent: "guard should inject during the repeated-loop phase", target: 4 },
  B: { name: "targeted_thrash_caphit_guard_not_fired", intent: "guard enabled+inject but detector does not fire (negative control on targeted cluster)", target: 2 },
  C: { name: "protected_treatment_only_win_not_fired", intent: "protected M73 treatment-only win; guard must not harm", target: 2 },
  D: { name: "normal_resolved_control_not_fired", intent: "normal low-cost resolved control; guard must not materially harm", target: 2 },
};

function enrich(id: string, group: string) {
  const t = m73By.get(id) ?? {};
  const r = m75By.get(id) ?? {};
  const sim = m76By.get(id) ?? {};
  return {
    instance_id: id,
    repo: t.repo ?? null,
    difficulty: t.difficulty ?? null,
    validation_group: group,
    in_m74_cost_cap_cluster: capCluster.includes(id),
    // prior M73 unguarded treatment
    prior_m73_outcome: t.outcome ?? null,
    prior_m73_treatment_resolved: t.treatment_resolved ?? null,
    prior_m73_treatment_cost: t.treatment_cost ?? null,
    prior_m73_treatment_tokens: t.treatment_tokens ?? null,
    prior_m73_tool_calls: t.treatment_tool_calls ?? null,
    prior_m73_reads: t.treatment_reads ?? null,
    prior_m73_searches: t.treatment_searches ?? null,
    prior_m73_edits: t.treatment_edits ?? null,
    // prior M75 observe replay
    prior_m75_group: r.group ?? null,
    prior_m75_would_guard_fire: r.would_guard_fire ?? null,
    prior_m75_first_fire_turn: r.first_fire_turn ?? null,
    prior_m75_fire_count: r.fire_count ?? null,
    prior_m75_trigger_type: (r.trigger_types ?? []).join("|") || null,
    prior_m75_repeated_read_count: r.repeated_read_count ?? null,
    prior_m75_cap_hit: r.cap_hit ?? null,
    // prior M76 runtime simulation
    prior_m76_runtime_injection_count: sim.runtime_injection_count ?? null,
    prior_m76_runtime_first_turn: sim.runtime_first_turn ?? null,
    prior_m76_timing_matches_observe: sim.timing_matches_observe ?? null,
    prior_m76_deterministic: sim.deterministic ?? null,
  };
}

const cases = Object.entries(groups).flatMap(([g, ids]) => ids.map((id) => enrich(id, g)));

const shortages = Object.entries(groups)
  .filter(([g, ids]) => ids.length < groupMeta[g]!.target)
  .map(([g, ids]) => ({ group: g, requested: groupMeta[g]!.target, got: ids.length }));

const split = {
  milestone: "M77-split",
  kind: "frozen tool-loop-guard live validation split (10 cases) from M73/M74/M75/M76 artifacts",
  live_agents: false,
  docker: false,
  retrieval_changed: false,
  built_by: "build_m77_split.ts",
  input_artifacts: [
    "stage5_m73_final_100_paired.detail.json",
    "stage5_m74_self_harness_lite_audit.json",
    "stage5_m75_tool_loop_guard_replay.json",
    "stage5_m76_tool_loop_guard_runtime_simulation.json",
  ],
  selection_rule:
    "outcome-blind: per group, sort candidate instance_ids ascending and take the first N; " +
    "Group A prioritizes the M74 cost-cap cluster (cap_hit) fired cases then thrashing fired; " +
    "Group B prioritizes cap_hit not-fired; never selected on resolved/cost.",
  anti_cherry_picking_notes: [
    "No case was added, dropped, or reordered after seeing any live result (this runs before live).",
    "Within each group candidates are sorted by instance_id and the first N taken — independent of pass/fail and cost.",
    "Groups A+B cover 5 of the 6 M74 cost_cap_exhaustion cluster instances (only sympy-15599 excluded as the 7th-ranked).",
  ],
  guard_config_replayed: m75.guard_config,
  group_definitions: groupMeta,
  selected_counts: Object.fromEntries(Object.entries(groups).map(([g, ids]) => [g, ids.length])),
  shortages,
  total_selected: cases.length,
  cases,
};

require("node:fs").writeFileSync(
  path.join(RESULTS, "stage5_m77_tool_loop_guard_live_split.json"),
  JSON.stringify(split, null, 2) + "\n",
);
console.log("RESULT_JSON: " + JSON.stringify({
  total: cases.length,
  byGroup: Object.fromEntries(Object.entries(groups).map(([g, ids]) => [g, ids])),
  shortages,
}, null, 2));
