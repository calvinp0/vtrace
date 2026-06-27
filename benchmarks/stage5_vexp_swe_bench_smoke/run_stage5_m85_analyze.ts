/**
 * M85 — analyze captured COMBINED V4 tool-loop guard + C7_D (editVerifyChurnThreshold=2) cost-guard
 * INJECT-mode live runs against the frozen M85 split, the prior M73 unguarded treatment, the prior
 * M80 V4-only live runs, the ACTUAL M82 V4+C7_V0 live runs, and the M84 offline C7_D replay
 * expectation. NO live agents, NO Docker, NO API spend — reads
 * results/runs/<label>/raw/vtrace/{swebench-*.jsonl,_run.meta.json,_tool_calls.json,_eval.meta.json}
 * and the injected context file, computes M85 validity (incl. cost_guard_calibration === "c7d" and
 * editVerifyChurnThreshold === 2) + BOTH guards' mechanism evidence + combined behavior +
 * changed-behavior deltas vs M73/M80/M82, and writes the compact summary + detail JSON.
 *
 *   bun run_stage5_m85_analyze.ts [--split path] [--out dir]
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
const SPLIT = flag("--split", path.join(RESULTS, "stage5_m85_v4_c7d_live_split.json"));
const LABEL_PREFIX = flag("--label-prefix", "m85_v4_c7d_guard_");
const TL_MARKER = "<VTRACE_TOOL_LOOP_GUARD>";
const COST_MARKER = "<VTRACE_COST_GUARD>";
const DIGEST_START = "<VTRACE_CAPSULE_V2_DIGEST_START>";
const CONTRACT_START = "<VTRACE_DIGEST_DECISION_CONTRACT_START>";
const NO_HIGH_CONF = "NO_HIGH_CONFIDENCE_REQUIRED_TARGETS";

// safe() mirrors the driver's bash `echo "$x" | tr -c 'a-zA-Z0-9' '_'`, which converts the trailing
// newline echo adds into a trailing '_'. So labels carry a trailing underscore.
const safe = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "_") + "_";
const readJson = (f: string): any => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);
const runDir = (label: string) => path.join(OUT, "runs", label, "raw", "vtrace");

function firstSwebench(label: string): any | null {
  const dir = runDir(label);
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((x) => /^swebench-.*\.jsonl$/.test(x));
  if (!f) return null;
  const line = fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").filter(Boolean)[0];
  return line ? JSON.parse(line) : null;
}
function hasResult(label: string): boolean {
  return firstSwebench(label) !== null;
}

// Resolve the canonical label that produced a result (base preferred, else first retry).
function resolveLabel(instanceId: string): { label: string | null; attempts: string[]; usedRetry: boolean } {
  const prefix = `${LABEL_PREFIX}${safe(instanceId)}`; // includes trailing underscore
  const runsRoot = path.join(OUT, "runs");
  if (!fs.existsSync(runsRoot)) return { label: null, attempts: [], usedRetry: false };
  const attempts = fs
    .readdirSync(runsRoot)
    .filter((d) => (d === prefix || d.startsWith(`${prefix}retry`)) && fs.statSync(path.join(runsRoot, d)).isDirectory())
    .sort((a, b) => (a.includes("retry") ? 1 : 0) - (b.includes("retry") ? 1 : 0) || a.localeCompare(b));
  const base = attempts.find((a) => !a.includes("retry")) ?? null;
  const withResult = (base && hasResult(base) ? base : null) ?? attempts.find(hasResult) ?? null;
  return { label: withResult, attempts, usedRetry: withResult !== null && withResult !== base };
}

function toolCallStats(label: string) {
  const tc = readJson(path.join(runDir(label), "_tool_calls.json")) as any[] | null;
  if (!Array.isArray(tc))
    return { tool_call_count: null, reads: null, searches: null, edits: null, verifies: null, repeated_file_reads: null, max_same_file_edits: null };
  const byCat = (c: string) => tc.filter((t) => t.category === c).length;
  const readPaths = tc.filter((t) => t.category === "read").map((t) => t.path).filter(Boolean) as string[];
  const counts = new Map<string, number>();
  for (const p of readPaths) counts.set(p, (counts.get(p) ?? 0) + 1);
  let redundant = 0;
  for (const v of counts.values()) if (v > 1) redundant += v - 1;
  const editPaths = tc.filter((t) => t.category === "edit").map((t) => t.path).filter(Boolean) as string[];
  const editCounts = new Map<string, number>();
  for (const p of editPaths) editCounts.set(p, (editCounts.get(p) ?? 0) + 1);
  const maxSameFileEdits = editCounts.size ? Math.max(...editCounts.values()) : 0;
  return {
    tool_call_count: tc.length,
    reads: byCat("read"),
    searches: byCat("search"),
    edits: byCat("edit"),
    verifies: byCat("verify") + byCat("test"),
    repeated_file_reads: redundant,
    max_same_file_edits: maxSameFileEdits,
  };
}

function classifyContext(meta: any): { digest: boolean; contract: boolean; gate: boolean; partial: boolean; ctxFound: boolean } {
  const f = meta?.vtraceContextFile as string | undefined;
  if (!f || !fs.existsSync(f)) return { digest: false, contract: false, gate: false, partial: false, ctxFound: false };
  const ctx = fs.readFileSync(f, "utf8");
  const occ = (n: string) => ctx.split(n).length - 1;
  const dS = occ(DIGEST_START), dE = occ("<VTRACE_CAPSULE_V2_DIGEST_END>");
  const cS = occ(CONTRACT_START), cE = occ("<VTRACE_DIGEST_DECISION_CONTRACT_END>");
  return {
    digest: dS === 1 && dE === 1,
    contract: cS === 1 && cE === 1,
    gate: cS === 1 && (ctx.includes("decision:") || ctx.includes(NO_HIGH_CONF)),
    partial: dS !== dE || cS !== cE,
    ctxFound: true,
  };
}

const split = readJson(SPLIT);
const cases: any[] = [];

for (const c of split.cases as any[]) {
  const { label, attempts, usedRetry } = resolveLabel(c.instance_id);
  const meta = label ? readJson(path.join(runDir(label), "_run.meta.json")) : null;
  const row = label ? firstSwebench(label) : null;
  const evalMeta = label ? readJson(path.join(runDir(label), "_eval.meta.json")) : null;
  const stats = label
    ? toolCallStats(label)
    : { tool_call_count: null, reads: null, searches: null, edits: null, verifies: null, repeated_file_reads: null, max_same_file_edits: null };
  const ctx = classifyContext(meta);

  // ---- tool-loop (V4) guard fields ----
  const tlEnabled = meta?.tool_loop_guard_enabled ?? null;
  const tlMode = meta?.tool_loop_guard_mode ?? null;
  const tlCalib = meta?.tool_loop_guard_calibration ?? null;
  const tlHook = meta?.tool_loop_guard_runtime_hook_available ?? null;
  const tlInj = meta?.tool_loop_guard_injection_count ?? null;
  const tlEvents = (meta?.tool_loop_guard_events ?? null) as any[] | null;
  const tlMsgs = (meta?.tool_loop_guard_injected_messages ?? null) as string[] | null;
  const tlTriggers = tlEvents ? [...new Set(tlEvents.map((e) => e.trigger_type))] : null;
  const tlSuppressed = meta?.tool_loop_guard_suppressed_count ?? null;
  const tlFirst = meta?.tool_loop_guard_first_event_turn ?? null;
  const tlMarkerOk = Array.isArray(tlMsgs) && tlMsgs.length > 0 && tlMsgs.every((m) => m.includes(TL_MARKER));

  // ---- cost (C7_D) guard fields ----
  const cgEnabled = meta?.cost_guard_enabled ?? null;
  const cgMode = meta?.cost_guard_mode ?? null;
  const cgCalib = meta?.cost_guard_calibration ?? null;
  const cgConfig = (meta?.cost_guard_config ?? null) as any | null;
  const cgChurnThreshold = cgConfig?.editVerifyChurnThreshold ?? null;
  const cgGate = cgConfig?.minToolCallsBeforeFire ?? null;
  const cgHook = meta?.cost_guard_runtime_hook_available ?? null;
  const cgCoexists = meta?.cost_guard_coexists_with_tool_loop_guard ?? null;
  const cgInj = meta?.cost_guard_injection_count ?? null;
  const cgEvents = (meta?.cost_guard_events ?? null) as any[] | null;
  const cgMsgs = (meta?.cost_guard_injected_messages ?? null) as string[] | null;
  const cgTriggers = cgEvents ? [...new Set(cgEvents.map((e) => e.trigger_type))] : null;
  const cgFirst = meta?.cost_guard_first_event_turn ?? null;
  const cgLast = meta?.cost_guard_last_event_turn ?? null;
  const cgSuppressed = meta?.cost_guard_suppressed_count ?? null;
  const cgMarkerOk =
    Array.isArray(cgMsgs) && cgMsgs.length > 0 && cgMsgs.every((m) => m.includes(COST_MARKER) || m.includes(TL_MARKER));

  const patchProduced = !!(row && row.modelPatch);
  const resolved = evalMeta ? (evalMeta.resolvedCount ?? 0) > 0 : row ? !!row.resolved : null;
  const treatmentValid = meta?.vtraceTreatmentValid ?? null;
  const contextInjected = meta?.vtraceContextInjected ?? null;
  const thisCost = row?.costUsd ?? null;
  const thisTurns = row?.numTurns ?? null;

  // ---- combined behavior ----
  const tlFireTurns = new Set((tlEvents ?? []).map((e) => e.turn ?? e.turn_or_event_index));
  const cgFireTurns = new Set((cgEvents ?? []).map((e) => e.turn_or_event_index ?? e.turn));
  const sameTurn = [...cgFireTurns].filter((t) => tlFireTurns.has(t)).length;
  const combinedMsgCount = (tlInj ?? 0) + (cgInj ?? 0);

  const tlFired = (tlInj ?? 0) > 0;
  const cgFired = (cgInj ?? 0) > 0;

  // ---- M85 validity ----
  let valid = true;
  let reason: string | null = null;
  if (!label) {
    valid = false; reason = "m85_provider_abort";
  } else if (meta == null) {
    valid = false; reason = "m85_guard_metadata_missing";
  } else if (ctx.partial) {
    valid = false; reason = "m85_partial_sentinel";
  } else if (ctx.ctxFound && !ctx.digest) {
    valid = false; reason = "m85_digest_not_present";
  } else if (ctx.ctxFound && !ctx.contract) {
    valid = false; reason = "m85_decision_contract_not_present";
  } else if (ctx.ctxFound && !ctx.gate) {
    valid = false; reason = "m85_confidence_gate_not_applied";
  } else if (!ctx.ctxFound && treatmentValid !== true) {
    valid = false; reason = "m85_decision_contract_not_present";
  } else if (tlEnabled !== true) {
    valid = false; reason = "m85_tool_loop_guard_not_enabled";
  } else if (tlMode !== "runtime_injection") {
    valid = false; reason = "m85_tool_loop_guard_not_enabled";
  } else if (tlCalib !== "v4") {
    valid = false; reason = "m85_tool_loop_guard_not_v4";
  } else if (cgEnabled !== true) {
    valid = false; reason = "m85_cost_guard_not_enabled";
  } else if (cgMode !== "runtime_injection") {
    valid = false; reason = "m85_cost_guard_not_enabled";
  } else if (cgCalib !== "c7d") {
    valid = false; reason = "m85_cost_guard_not_c7d";
  } else if (cgChurnThreshold !== 2) {
    valid = false; reason = "m85_cost_guard_not_c7d";
  } else if (tlHook !== true) {
    valid = false; reason = "m85_runtime_hook_unavailable";
  } else if (cgHook !== true) {
    valid = false; reason = "m85_combined_hook_unavailable";
  } else if (tlFired && !tlMarkerOk) {
    valid = false; reason = "m85_guard_metadata_missing";
  } else if (cgFired && !cgMarkerOk) {
    valid = false; reason = "m85_guard_metadata_missing";
  } else if (patchProduced && evalMeta == null) {
    valid = false; reason = "m85_eval_missing_for_patch";
  }

  // ---- prior data from the split ----
  const priorM73Resolved = c.prior_m73_treatment_resolved ?? null;
  const priorM73Cost = c.prior_m73_treatment_cost ?? null;
  const priorM73Tools = c.prior_m73_tool_calls ?? null;
  const priorM80Resolved = c.prior_m80_resolved ?? null;
  const priorM80Cost = c.prior_m80_cost ?? null;
  const priorM80Tools = c.prior_m80_tool_calls ?? null;
  const priorM80V4Fired = c.prior_m80_v4_fired ?? null;
  const priorM80V4FirstTurn = c.prior_m80_v4_first_turn ?? null;
  // ACTUAL M82 V4+C7_V0 live priors.
  const priorM82Resolved = c.prior_m82_resolved ?? null;
  const priorM82Cost = c.prior_m82_cost ?? null;
  const priorM82Tools = c.prior_m82_tool_calls ?? null;
  const priorM82V4Fired = c.prior_m82_v4_fired ?? null;
  const priorM82C7Fired = c.prior_m82_c7_fired ?? null;
  const priorM82C7Trigger = c.prior_m82_c7_trigger_type ?? null;
  const priorM82C7FirstTurn = c.prior_m82_c7_first_fire_turn ?? null;
  // M84 OFFLINE C7_D first-fire expectation.
  const m84ExpectedC7dFire = c.prior_m84_expected_c7d_fire ?? null;
  const m84ExpectedTrigger = c.prior_m84_expected_trigger_type ?? null;
  const m84ExpectedFirstTurn = c.prior_m84_expected_first_fire_turn ?? null;

  const capCost = 3.0;
  // Earlier C7 fire than M82: this run's first cost-guard event turn is lower than M82's actual
  // first C7_V0 fire turn (both must have fired). Null when not comparable.
  const earlierC7ThanM82 =
    cgFired && cgFirst != null && priorM82C7Fired === true && priorM82C7FirstTurn != null
      ? cgFirst < priorM82C7FirstTurn
      : null;
  const cbe: Record<string, boolean | null> = {
    lower_cost_than_m82: thisCost != null && priorM82Cost != null ? thisCost < priorM82Cost : null,
    lower_cost_than_m80: thisCost != null && priorM80Cost != null ? thisCost < priorM80Cost : null,
    lower_cost_than_m73: thisCost != null && priorM73Cost != null ? thisCost < priorM73Cost : null,
    lower_tool_calls_than_m82: stats.tool_call_count != null && priorM82Tools != null ? stats.tool_call_count < priorM82Tools : null,
    lower_tool_calls_than_m80: stats.tool_call_count != null && priorM80Tools != null ? stats.tool_call_count < priorM80Tools : null,
    fewer_edit_verify_cycles_than_m82:
      stats.max_same_file_edits != null && c.prior_m82_tool_calls != null && priorM82C7Trigger != null
        ? null // not directly recoverable from the split; recorded as null (see detail per-case max_same_file_edits)
        : null,
    earlier_c7_fire_than_m82: earlierC7ThanM82,
    earlier_exit_than_m82: thisTurns != null && c.prior_m82_turns != null ? thisTurns < c.prior_m82_turns : null,
    patch_produced_when_prior_no_patch: priorM82Resolved === false ? patchProduced : null,
    cost_guard_fired_before_cost_cap: cgFired && thisCost != null ? thisCost < capCost : null,
    resolved_when_prior_m82_unresolved: priorM82Resolved === false ? resolved === true : null,
    no_harm_resolved_protected: c.validation_group === "C" || c.validation_group === "D" ? resolved === true : null,
  };

  cases.push({
    instance_id: c.instance_id,
    repo: c.repo,
    difficulty: c.difficulty,
    validation_group: c.validation_group,
    run_label: label,
    used_operational_retry: usedRetry,
    attempt_labels: attempts,
    valid_run: valid,
    invalid_reason: reason,
    treatment_valid: treatmentValid,
    context_injected: contextInjected,
    effective_engine: meta?.vtraceEffectiveCapsuleEngine ?? null,
    digest_present: ctx.ctxFound ? ctx.digest : treatmentValid === true,
    decision_contract_present: ctx.ctxFound ? ctx.contract : treatmentValid === true,
    confidence_gate_applied: ctx.ctxFound ? ctx.gate : treatmentValid === true,
    partial_sentinel: ctx.partial,
    patch_produced: patchProduced,
    resolved,
    evaluation_ran: evalMeta?.evaluationRan ?? null,
    cost: thisCost,
    duration_ms: row?.durationMs ?? null,
    input_tokens_total: row?.inputTokens ?? null,
    output_tokens_total: row?.outputTokens ?? null,
    cache_read_tokens_total: row?.cacheReadTokens ?? null,
    cache_write_tokens_total: row?.cacheCreationTokens ?? null,
    total_tokens:
      row != null ? (row.inputTokens ?? 0) + (row.outputTokens ?? 0) + (row.cacheReadTokens ?? 0) + (row.cacheCreationTokens ?? 0) : null,
    turn_count: thisTurns,
    ...stats,
    // ---- tool-loop (V4) ----
    tool_loop_guard_enabled: tlEnabled,
    tool_loop_guard_mode: tlMode,
    tool_loop_guard_calibration: tlCalib,
    tool_loop_guard_runtime_hook_available: tlHook,
    tool_loop_guard_injection_count: tlInj,
    tool_loop_guard_suppressed_count: tlSuppressed,
    tool_loop_guard_first_event_turn: tlFirst,
    tool_loop_guard_events: tlEvents,
    tool_loop_guard_injected_messages: tlMsgs,
    tool_loop_guard_trigger_types: tlTriggers,
    tool_loop_guard_marker_present: tlMarkerOk,
    v4_fired: tlFired,
    // ---- cost (C7_D) ----
    cost_guard_enabled: cgEnabled,
    cost_guard_mode: cgMode,
    cost_guard_calibration: cgCalib,
    cost_guard_edit_verify_churn_threshold: cgChurnThreshold,
    cost_guard_min_tool_calls_gate: cgGate,
    cost_guard_config: cgConfig,
    cost_guard_runtime_hook_available: cgHook,
    cost_guard_coexists_with_tool_loop_guard: cgCoexists,
    cost_guard_injection_count: cgInj,
    cost_guard_suppressed_count: cgSuppressed,
    cost_guard_first_event_turn: cgFirst,
    cost_guard_last_event_turn: cgLast,
    cost_guard_events: cgEvents,
    cost_guard_injected_messages: cgMsgs,
    cost_guard_trigger_types: cgTriggers,
    cost_guard_marker_present: cgMarkerOk,
    c7_fired: cgFired,
    // ---- combined ----
    combined_guard_message_count: combinedMsgCount,
    combined_guard_same_turn_count: sameTurn,
    first_guard_turn:
      tlFirst != null || cgFirst != null ? Math.min(...[tlFirst, cgFirst].filter((x): x is number => typeof x === "number")) : null,
    // ---- priors ----
    prior_m73_treatment_resolved: priorM73Resolved,
    prior_m73_treatment_cost: priorM73Cost,
    prior_m73_tool_calls: priorM73Tools,
    prior_m80_resolved: priorM80Resolved,
    prior_m80_cost: priorM80Cost,
    prior_m80_tool_calls: priorM80Tools,
    prior_m80_v4_fired: priorM80V4Fired,
    prior_m80_v4_first_turn: priorM80V4FirstTurn,
    // ACTUAL M82 V4+C7_V0 live priors
    prior_m82_resolved: priorM82Resolved,
    prior_m82_cost: priorM82Cost,
    prior_m82_tool_calls: priorM82Tools,
    prior_m82_v4_fired: priorM82V4Fired,
    prior_m82_c7_fired: priorM82C7Fired,
    prior_m82_c7_trigger_type: priorM82C7Trigger,
    prior_m82_c7_first_fire_turn: priorM82C7FirstTurn,
    // M84 offline C7_D first-fire expectation
    prior_m84_expected_c7d_fire: m84ExpectedC7dFire,
    prior_m84_expected_trigger_type: m84ExpectedTrigger,
    prior_m84_expected_first_fire_turn: m84ExpectedFirstTurn,
    cost_delta_vs_m82: thisCost != null && priorM82Cost != null ? Number((thisCost - priorM82Cost).toFixed(4)) : null,
    cost_delta_vs_m80: thisCost != null && priorM80Cost != null ? Number((thisCost - priorM80Cost).toFixed(4)) : null,
    changed_behavior_evidence: cbe,
  });
}

// ---- aggregate ----
const byGroup = (g: string) => cases.filter((c) => c.validation_group === g);
const num = (xs: (number | null)[]) => xs.filter((x): x is number => typeof x === "number");
const sum = (xs: (number | null)[]) => num(xs).reduce((a, b) => a + b, 0);
const mean = (xs: (number | null)[]) => (num(xs).length ? sum(xs) / num(xs).length : null);

const v4Fired = cases.filter((c) => c.v4_fired);
const c7Fired = cases.filter((c) => c.c7_fired);
const protectedWins = byGroup("C");
const controls = byGroup("D");

const find = (id: string) => cases.find((c) => c.instance_id === id);
const mech = (id: string) => {
  const x = find(id);
  if (!x || !x.run_label) return null;
  return {
    instance_id: id,
    valid: x.valid_run,
    resolved: x.resolved,
    cost: x.cost,
    cost_delta_vs_m82: x.cost_delta_vs_m82,
    cost_delta_vs_m80: x.cost_delta_vs_m80,
    turns: x.turn_count,
    tool_calls: x.tool_call_count,
    max_same_file_edits: x.max_same_file_edits,
    v4_fired: x.v4_fired,
    v4_trigger_types: x.tool_loop_guard_trigger_types,
    v4_first_turn: x.tool_loop_guard_first_event_turn,
    c7_fired: x.c7_fired,
    c7_trigger_types: x.cost_guard_trigger_types,
    c7_first_turn: x.cost_guard_first_event_turn,
    c7_last_turn: x.cost_guard_last_event_turn,
    c7_fired_before_cap: x.changed_behavior_evidence.cost_guard_fired_before_cost_cap,
    earlier_c7_fire_than_m82: x.changed_behavior_evidence.earlier_c7_fire_than_m82,
    combined_same_turn_count: x.combined_guard_same_turn_count,
    // priors / expectations
    prior_m82_c7_fired: x.prior_m82_c7_fired,
    prior_m82_c7_first_fire_turn: x.prior_m82_c7_first_fire_turn,
    prior_m82_c7_trigger_type: x.prior_m82_c7_trigger_type,
    prior_m82_cost: x.prior_m82_cost,
    prior_m82_resolved: x.prior_m82_resolved,
    m84_expected_c7d_fire: x.prior_m84_expected_c7d_fire,
    m84_expected_first_fire_turn: x.prior_m84_expected_first_fire_turn,
    m84_expected_trigger_type: x.prior_m84_expected_trigger_type,
  };
};

const summary = {
  milestone: "M85",
  kind: "combined V4 tool-loop guard + C7_D (editVerifyChurnThreshold=2) cost-guard INJECT-mode live validation (10-case slice; NOT a 100-task benchmark, NOT a promotion, NOT a VEXP/SWE-bench external claim)",
  helper: "run_stage5_m85_analyze.ts",
  live_agents: true,
  docker: true,
  retrieval_changed: false,
  tool_loop_guard_calibration: "v4",
  cost_guard_mode: "inject",
  cost_guard_calibration: "c7d",
  scope_caveat:
    "Mechanism validation slice over the frozen M85 10-case split (identical membership to M82/M80/M77). Not a paired significance claim, not broad SWE-bench evidence, not a default promotion. Both guards remain DEFAULT-OFF.",
  total_cases: cases.length,
  valid_runs: cases.filter((c) => c.valid_run).length,
  invalid_runs: cases.filter((c) => !c.valid_run).map((c) => ({ instance_id: c.instance_id, reason: c.invalid_reason })),
  both_guards_runtime_active_all: cases.every(
    (c) =>
      !c.run_label ||
      (c.tool_loop_guard_mode === "runtime_injection" &&
        c.tool_loop_guard_runtime_hook_available === true &&
        c.cost_guard_mode === "runtime_injection" &&
        c.cost_guard_runtime_hook_available === true),
  ),
  calibration_v4_all: cases.every((c) => c.tool_loop_guard_calibration === "v4" || !c.run_label),
  calibration_c7d_all: cases.every((c) => c.cost_guard_calibration === "c7d" || !c.run_label),
  c7d_churn_threshold_2_all: cases.every((c) => c.cost_guard_edit_verify_churn_threshold === 2 || !c.run_label),
  c7d_gate_25_all: cases.every((c) => c.cost_guard_min_tool_calls_gate === 25 || !c.run_label),
  combined_hook_coexists_all: cases.every((c) => c.cost_guard_coexists_with_tool_loop_guard === true || !c.run_label),
  v4_fired_count: v4Fired.length,
  v4_fired_instances: v4Fired.map((c) => c.instance_id),
  v4_suppressed_total: sum(cases.map((c) => c.tool_loop_guard_suppressed_count)),
  c7_fired_count: c7Fired.length,
  c7_fired_instances: c7Fired.map((c) => c.instance_id),
  c7_trigger_types_union: [...new Set(c7Fired.flatMap((c) => c.cost_guard_trigger_types ?? []))],
  c7_fired_before_cap_all: c7Fired.every((c) => c.changed_behavior_evidence.cost_guard_fired_before_cost_cap === true),
  // C7_D timing vs M82's actual C7_V0: instances where both fired and M85's first fire is earlier.
  c7d_earlier_than_m82_instances: c7Fired
    .filter((c) => c.changed_behavior_evidence.earlier_c7_fire_than_m82 === true)
    .map((c) => c.instance_id),
  c7d_earlier_than_m82_count: c7Fired.filter((c) => c.changed_behavior_evidence.earlier_c7_fire_than_m82 === true).length,
  // M82 actually fired C7_V0 here; recurrence check for the M85 C7_D run on the same instances.
  m82_c7_fired_instances: cases.filter((c) => c.prior_m82_c7_fired === true).map((c) => c.instance_id),
  m84_expected_c7d_fire_instances: cases.filter((c) => c.prior_m84_expected_c7d_fire === true).map((c) => c.instance_id),
  c7d_recurred_on_m82_fired: cases
    .filter((c) => c.prior_m82_c7_fired === true && c.c7_fired === true)
    .map((c) => c.instance_id),
  combined_same_turn_total: sum(cases.map((c) => c.combined_guard_same_turn_count)),
  guard_marker_verified_all_fired:
    v4Fired.every((c) => c.tool_loop_guard_marker_present) && c7Fired.every((c) => c.cost_guard_marker_present),
  // ---- mechanism checks for the 5 named cases ----
  mechanism_checks: {
    "django-16263": mech("django__django-16263"),
    "django-15503": mech("django__django-15503"),
    "django-12273": mech("django__django-12273"),
    "pytest-6197": (() => {
      const m = mech("pytest-dev__pytest-6197");
      if (!m) return null;
      const earlyV4 = (find("pytest-dev__pytest-6197")?.tool_loop_guard_events ?? []).some(
        (e: any) => (e.turn ?? e.turn_or_event_index ?? 99) <= 3,
      );
      const earlyC7 = (m.c7_first_turn ?? 99) <= 8;
      return { ...m, early_v4_read_fire: earlyV4, early_c7_fire: earlyC7 };
    })(),
    "sympy-12419": (() => {
      const m = mech("sympy__sympy-12419");
      if (!m) return null;
      const commandTrigger = (m.v4_trigger_types ?? []).includes("repeated_failed_command");
      return { ...m, v4_command_trigger_present: commandTrigger };
    })(),
  },
  by_group: Object.fromEntries(
    ["A", "B", "C", "D"].map((g) => {
      const gs = byGroup(g);
      return [
        g,
        {
          n: gs.length,
          valid: gs.filter((c) => c.valid_run).length,
          v4_fired: gs.filter((c) => c.v4_fired).length,
          c7_fired: gs.filter((c) => c.c7_fired).length,
          resolved: gs.filter((c) => c.resolved === true).length,
          prior_m73_resolved: gs.filter((c) => c.prior_m73_treatment_resolved === true).length,
          prior_m80_resolved: gs.filter((c) => c.prior_m80_resolved === true).length,
          prior_m82_resolved: gs.filter((c) => c.prior_m82_resolved === true).length,
          mean_cost: mean(gs.map((c) => c.cost)),
          mean_m82_cost: mean(gs.map((c) => c.prior_m82_cost)),
          mean_m80_cost: mean(gs.map((c) => c.prior_m80_cost)),
          mean_m73_cost: mean(gs.map((c) => c.prior_m73_treatment_cost)),
        },
      ];
    }),
  ),
  protected_wins_summary: {
    n: protectedWins.length,
    resolved: protectedWins.filter((c) => c.resolved === true).length,
    prior_m73_resolved: protectedWins.filter((c) => c.prior_m73_treatment_resolved === true).length,
    prior_m80_resolved: protectedWins.filter((c) => c.prior_m80_resolved === true).length,
    prior_m82_resolved: protectedWins.filter((c) => c.prior_m82_resolved === true).length,
    any_v4_fired: protectedWins.some((c) => c.v4_fired),
    any_c7_fired: protectedWins.some((c) => c.c7_fired),
    regressed_vs_m73: protectedWins
      .filter((c) => c.prior_m73_treatment_resolved === true && c.resolved !== true)
      .map((c) => c.instance_id),
    recovered_vs_m82: protectedWins
      .filter((c) => c.prior_m82_resolved === false && c.resolved === true)
      .map((c) => c.instance_id),
  },
  controls_summary: {
    n: controls.length,
    resolved: controls.filter((c) => c.resolved === true).length,
    prior_m73_resolved: controls.filter((c) => c.prior_m73_treatment_resolved === true).length,
    prior_m80_resolved: controls.filter((c) => c.prior_m80_resolved === true).length,
    prior_m82_resolved: controls.filter((c) => c.prior_m82_resolved === true).length,
    any_guard_fired: controls.some((c) => c.v4_fired || c.c7_fired),
  },
  resolution: {
    m85_resolved: cases.filter((c) => c.resolved === true).length,
    m82_resolved: cases.filter((c) => c.prior_m82_resolved === true).length,
    m80_resolved: cases.filter((c) => c.prior_m80_resolved === true).length,
    m73_resolved: cases.filter((c) => c.prior_m73_treatment_resolved === true).length,
  },
  cost_total_m85: Number(sum(cases.map((c) => c.cost)).toFixed(4)),
  cost_total_m82: Number(sum(cases.map((c) => c.prior_m82_cost)).toFixed(4)),
  cost_total_m80: Number(sum(cases.map((c) => c.prior_m80_cost)).toFixed(4)),
  cost_total_m73: Number(sum(cases.map((c) => c.prior_m73_treatment_cost)).toFixed(4)),
};

fs.writeFileSync(path.join(OUT, "stage5_m85_v4_c7d_live_validation.json"), JSON.stringify(summary, null, 2) + "\n");
fs.writeFileSync(
  path.join(OUT, "stage5_m85_v4_c7d_live_validation.detail.json"),
  JSON.stringify(
    { milestone: "M85", tool_loop_guard_calibration: "v4", cost_guard_mode: "inject", cost_guard_calibration: "c7d", cases },
    null,
    2,
  ) + "\n",
);
console.log(
  "RESULT_JSON: " +
    JSON.stringify(
      {
        total: summary.total_cases,
        valid: summary.valid_runs,
        v4_fired: summary.v4_fired_count,
        c7_fired: summary.c7_fired_count,
        c7_instances: summary.c7_fired_instances,
        c7d_earlier_than_m82: summary.c7d_earlier_than_m82_instances,
        both_active_all: summary.both_guards_runtime_active_all,
        calibration_c7d_all: summary.calibration_c7d_all,
        resolution: summary.resolution,
        cost_m85: summary.cost_total_m85,
        cost_m82: summary.cost_total_m82,
        invalid: summary.invalid_runs,
      },
      null,
      2,
    ),
);
