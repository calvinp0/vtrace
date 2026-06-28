/**
 * M88 — analyze captured COMBINED V4 tool-loop guard + C7_D (editVerifyChurnThreshold=2) cost-guard
 * INJECT-mode live runs over the frozen 24-case M88 split, HARDENED with the M86 Stage 5
 * environment-isolation guard. NO live agents, NO Docker, NO API spend — reads
 * results/runs/<label>/raw/vtrace/{swebench-*.jsonl,_run.meta.json,_tool_calls.json,_eval.meta.json}
 * and computes M88 validity (treatment + BOTH guards + env guard) + guard mechanism evidence +
 * environment safety + carryover comparisons vs M73/M80/M82/M85, then writes the compact summary +
 * detail JSON.
 *
 *   bun run_stage5_m88_analyze.ts [--split path] [--out dir]
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
const SPLIT = flag("--split", path.join(RESULTS, "stage5_m88_v4_c7d_envguard_split.json"));
const LABEL_PREFIX = flag("--label-prefix", "m88_v4_c7d_envguard_");
const TL_MARKER = "<VTRACE_TOOL_LOOP_GUARD>";
const COST_MARKER = "<VTRACE_COST_GUARD>";
const DIGEST_START = "<VTRACE_CAPSULE_V2_DIGEST_START>";
const CONTRACT_START = "<VTRACE_DIGEST_DECISION_CONTRACT_START>";
const NO_HIGH_CONF = "NO_HIGH_CONFIDENCE_REQUIRED_TARGETS";
const EXPECTED_PREFIX = "/home/calvin/miniforge3/envs/vexp_swebench";

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
const hasResult = (label: string) => firstSwebench(label) !== null;

function resolveLabel(instanceId: string): { label: string | null; attempts: string[]; usedRetry: boolean } {
  const prefix = `${LABEL_PREFIX}${safe(instanceId)}`;
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

// Prior M85 mechanism detail (keyed by short id) + M85 split M80/M82 cost/tool/turn priors.
const m85val = readJson(path.join(RESULTS, "stage5_m85_v4_c7d_live_validation.json"));
const m85mech: Record<string, any> = m85val?.mechanism_checks ?? {};
const m85split = readJson(path.join(RESULTS, "stage5_m85_v4_c7d_live_split.json"));
const m85splitByInst: Record<string, any> = {};
for (const c of (m85split?.cases ?? []) as any[]) m85splitByInst[c.instance_id] = c;

const split = readJson(SPLIT);
const cases: any[] = [];

for (const c of split.cases as any[]) {
  const { label, attempts, usedRetry } = resolveLabel(c.instance_id);
  const meta = label ? readJson(path.join(runDir(label), "_run.meta.json")) : null;
  const row = label ? firstSwebench(label) : null;
  const evalMeta = label ? readJson(path.join(runDir(label), "_eval.meta.json")) : null;
  const stats = label ? toolCallStats(label) : toolCallStats("__none__");
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

  // ---- env-guard fields (from envGuardOutcome.metadata in _run.meta.json) ----
  const envEnabled = meta?.stage5_env_guard_enabled ?? null;
  const envStatus = meta?.stage5_env_guard_status ?? null;
  const envExpectedPrefix = meta?.stage5_expected_testbed_prefix ?? null;
  const envPyVerified = meta?.stage5_python_prefix_verified ?? null;
  const envPipVerified = meta?.stage5_pip_prefix_verified ?? null;
  const envDriftEnabled = meta?.stage5_drift_check_enabled ?? null;
  const envDriftSummary = meta?.stage5_prefix_drift_summary ?? null;
  const envPrefixGuardFailures = (meta?.stage5_prefix_guard_failures ?? null) as any[] | null;
  const envBlockedUnsafePip = meta?.stage5_blocked_unsafe_pip_command_count ?? null;
  // Drift stop conditions: a protected prefix changed during the run / went mismatched / import broke.
  const driftStr = typeof envDriftSummary === "string" ? envDriftSummary : JSON.stringify(envDriftSummary ?? "");
  const driftDanger = /changed_during_run|pip_conda_mismatch|import_broken/.test(driftStr);

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

  // ---- priors from the M88 split ----
  const priorM73BaselineResolved = c.prior_m73_baseline_resolved ?? null;
  const priorM73Resolved = c.prior_m73_treatment_resolved ?? null;
  const priorM73Cost = c.prior_m73_treatment_cost ?? null;
  const priorM73Tools = c.prior_m73_treatment_tool_calls ?? null;
  const priorM80Resolved = c.prior_m80_resolved ?? null;
  const priorM82Resolved = c.prior_m82_resolved ?? null;
  const priorM85 = c.prior_m85_status ?? null; // {resolved, v4_fired, c7_fired, cost} for E carryovers
  // Deeper M82/M80 cost/tool/turn priors from the M85 split (only for the 10-overlap cases).
  const ov = m85splitByInst[c.instance_id] ?? {};
  const priorM82Cost = ov.prior_m82_cost ?? null;
  const priorM82Tools = ov.prior_m82_tool_calls ?? null;
  const priorM82Turns = ov.prior_m82_turns ?? null;
  const priorM82C7Fired = ov.prior_m82_c7_fired ?? null;
  const priorM82C7FirstTurn = ov.prior_m82_c7_first_fire_turn ?? null;
  const priorM80Cost = ov.prior_m80_cost ?? null;
  const priorM80Tools = ov.prior_m80_tool_calls ?? null;
  const priorM85Cost = priorM85?.cost ?? null;

  const capCost = 3.0;
  const earlierC7ThanM82 =
    cgFired && cgFirst != null && priorM82C7Fired === true && priorM82C7FirstTurn != null ? cgFirst < priorM82C7FirstTurn : null;

  // ---- M88 validity ----
  let valid = true;
  let reason: string | null = null;
  if (!label) {
    valid = false; reason = "m88_provider_abort";
  } else if (meta == null) {
    valid = false; reason = "m88_guard_metadata_missing";
  } else if (ctx.partial) {
    valid = false; reason = "m88_partial_sentinel";
  } else if (ctx.ctxFound && !ctx.digest) {
    valid = false; reason = "m88_digest_not_present";
  } else if (ctx.ctxFound && !ctx.contract) {
    valid = false; reason = "m88_decision_contract_not_present";
  } else if (ctx.ctxFound && !ctx.gate) {
    valid = false; reason = "m88_confidence_gate_not_applied";
  } else if (!ctx.ctxFound && treatmentValid !== true) {
    valid = false; reason = "m88_decision_contract_not_present";
  } else if (tlEnabled !== true) {
    valid = false; reason = "m88_tool_loop_guard_not_enabled";
  } else if (tlMode !== "runtime_injection") {
    valid = false; reason = "m88_tool_loop_guard_not_enabled";
  } else if (tlCalib !== "v4") {
    valid = false; reason = "m88_tool_loop_guard_not_v4";
  } else if (cgEnabled !== true) {
    valid = false; reason = "m88_cost_guard_not_enabled";
  } else if (cgMode !== "runtime_injection") {
    valid = false; reason = "m88_cost_guard_not_enabled";
  } else if (cgCalib !== "c7d") {
    valid = false; reason = "m88_cost_guard_not_c7d";
  } else if (cgChurnThreshold !== 2) {
    valid = false; reason = "m88_cost_guard_not_c7d";
  } else if (tlHook !== true) {
    valid = false; reason = "m88_runtime_hook_unavailable";
  } else if (cgHook !== true) {
    valid = false; reason = "m88_combined_hook_unavailable";
  } else if (envEnabled !== true) {
    valid = false; reason = "m88_env_guard_not_enabled";
  } else if (envStatus !== "pass") {
    valid = false; reason = "m88_env_guard_not_pass";
  } else if (envExpectedPrefix !== EXPECTED_PREFIX) {
    valid = false; reason = "m88_expected_prefix_not_verified";
  } else if (envPyVerified !== true || envPipVerified !== true) {
    valid = false; reason = "m88_expected_prefix_not_verified";
  } else if (envDriftEnabled !== true) {
    valid = false; reason = "m88_drift_check_missing";
  } else if (driftDanger) {
    valid = false; reason = "m88_prefix_drift_detected";
  } else if (tlFired && !tlMarkerOk) {
    valid = false; reason = "m88_guard_metadata_missing";
  } else if (cgFired && !cgMarkerOk) {
    valid = false; reason = "m88_guard_metadata_missing";
  } else if (patchProduced && evalMeta == null) {
    valid = false; reason = "m88_eval_missing_for_patch";
  }

  const cbe: Record<string, boolean | null> = {
    lower_cost_than_m82: thisCost != null && priorM82Cost != null ? thisCost < priorM82Cost : null,
    lower_cost_than_m85: thisCost != null && priorM85Cost != null ? thisCost < priorM85Cost : null,
    lower_cost_than_m73: thisCost != null && priorM73Cost != null ? thisCost < priorM73Cost : null,
    lower_tool_calls_than_m82: stats.tool_call_count != null && priorM82Tools != null ? stats.tool_call_count < priorM82Tools : null,
    lower_tool_calls_than_m73: stats.tool_call_count != null && priorM73Tools != null ? stats.tool_call_count < priorM73Tools : null,
    earlier_c7_fire_than_m82: earlierC7ThanM82,
    cost_guard_fired_before_cost_cap: cgFired && thisCost != null ? thisCost < capCost : null,
    no_harm_resolved_protected:
      c.group === "B" || c.group === "D" ? resolved === true : null,
  };

  cases.push({
    instance_id: c.instance_id,
    repo: c.repo,
    difficulty: c.difficulty,
    group: c.group,
    validation_group: c.validation_group,
    selection_reason: c.selection_reason,
    expected_guard_behavior: c.expected_guard_behavior,
    prior_m74_failure_cluster: c.prior_m74_failure_cluster ?? null,
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
    cost_guard_trigger_types: cgTriggers,
    cost_guard_marker_present: cgMarkerOk,
    c7_fired: cgFired,
    // ---- env guard ----
    stage5_env_guard_enabled: envEnabled,
    stage5_env_guard_status: envStatus,
    stage5_expected_testbed_prefix: envExpectedPrefix,
    stage5_python_prefix_verified: envPyVerified,
    stage5_pip_prefix_verified: envPipVerified,
    stage5_drift_check_enabled: envDriftEnabled,
    stage5_prefix_drift_summary: envDriftSummary,
    stage5_prefix_guard_failures: envPrefixGuardFailures,
    stage5_blocked_unsafe_pip_command_count: envBlockedUnsafePip,
    env_drift_danger: driftDanger,
    // ---- combined ----
    combined_guard_message_count: combinedMsgCount,
    combined_guard_same_turn_count: sameTurn,
    first_guard_turn:
      tlFirst != null || cgFirst != null ? Math.min(...[tlFirst, cgFirst].filter((x): x is number => typeof x === "number")) : null,
    // ---- priors ----
    prior_m73_baseline_resolved: priorM73BaselineResolved,
    prior_m73_treatment_resolved: priorM73Resolved,
    prior_m73_treatment_cost: priorM73Cost,
    prior_m73_treatment_tool_calls: priorM73Tools,
    prior_m80_resolved: priorM80Resolved,
    prior_m80_cost: priorM80Cost,
    prior_m80_tool_calls: priorM80Tools,
    prior_m82_resolved: priorM82Resolved,
    prior_m82_cost: priorM82Cost,
    prior_m82_tool_calls: priorM82Tools,
    prior_m82_turns: priorM82Turns,
    prior_m82_c7_fired: priorM82C7Fired,
    prior_m82_c7_first_fire_turn: priorM82C7FirstTurn,
    prior_m85_status: priorM85,
    cost_delta_vs_m85: thisCost != null && priorM85Cost != null ? Number((thisCost - priorM85Cost).toFixed(4)) : null,
    cost_delta_vs_m82: thisCost != null && priorM82Cost != null ? Number((thisCost - priorM82Cost).toFixed(4)) : null,
    cost_delta_vs_m73: thisCost != null && priorM73Cost != null ? Number((thisCost - priorM73Cost).toFixed(4)) : null,
    changed_behavior_evidence: cbe,
  });
}

// ---- aggregate ----
const GROUPS = ["A", "B", "C", "D", "E"];
const byGroup = (g: string) => cases.filter((c) => c.group === g);
const num = (xs: (number | null)[]) => xs.filter((x): x is number => typeof x === "number");
const sum = (xs: (number | null)[]) => num(xs).reduce((a, b) => a + b, 0);
const mean = (xs: (number | null)[]) => (num(xs).length ? sum(xs) / num(xs).length : null);

const ran = cases.filter((c) => c.run_label);
const validCases = cases.filter((c) => c.valid_run);
const v4Fired = cases.filter((c) => c.v4_fired);
const c7Fired = cases.filter((c) => c.c7_fired);
const find = (id: string) => cases.find((c) => c.instance_id === id);

// Risky-early-fire check (the old pytest-6197 risk): a V4 read-trigger fire at a very early turn
// before any prior search/edit progress would be unsafe.
function earlyReadFire(x: any): boolean {
  if (!x?.tool_loop_guard_events) return false;
  return x.tool_loop_guard_events.some(
    (e: any) => /repeated_read/.test(e.trigger_type ?? "") && (e.turn ?? e.turn_or_event_index ?? 99) <= 4,
  );
}

const carryover = (id: string) => {
  const x = find(id);
  if (!x) return null;
  const m85 = m85mech[id.split("__")[1]] ?? null;
  return {
    instance_id: id,
    m73_treatment_resolved: x.prior_m73_treatment_resolved,
    m80_resolved: x.prior_m80_resolved,
    m82_resolved: x.prior_m82_resolved,
    m85_resolved: m85?.resolved ?? x.prior_m85_status?.resolved ?? null,
    m88_resolved: x.resolved,
    m85_v4_fired: m85?.v4_fired ?? x.prior_m85_status?.v4_fired ?? null,
    m85_c7_fired: m85?.c7_fired ?? x.prior_m85_status?.c7_fired ?? null,
    m88_v4_fired: x.v4_fired,
    m88_c7_fired: x.c7_fired,
    m88_v4_trigger_types: x.tool_loop_guard_trigger_types,
    m88_v4_first_turn: x.tool_loop_guard_first_event_turn,
    m88_c7_trigger_types: x.cost_guard_trigger_types,
    m88_c7_first_turn: x.cost_guard_first_event_turn,
    m85_cost: x.prior_m85_status?.cost ?? null,
    m88_cost: x.cost,
    cost_delta_vs_m85: x.cost_delta_vs_m85,
    m88_tool_calls: x.tool_call_count,
    valid: x.valid_run,
    invalid_reason: x.invalid_reason,
    early_v4_read_fire: earlyReadFire(x),
    behavior_changed_intended_direction:
      // intended: same-or-lower cost vs M85 and no new harm
      x.cost_delta_vs_m85 != null ? x.cost_delta_vs_m85 <= 0 : null,
  };
};

const summary = {
  milestone: "M88",
  kind: "combined V4 tool-loop guard + C7_D (editVerifyChurnThreshold=2) cost-guard INJECT-mode live validation over a frozen 24-case split, HARDENED with the M86 Stage 5 environment-isolation guard (24-case mechanism slice; NOT a 100-task benchmark, NOT a promotion, NOT a VEXP/SWE-bench external claim)",
  helper: "run_stage5_m88_analyze.ts",
  live_agents: true,
  docker: true,
  retrieval_changed: false,
  tool_loop_guard_calibration: "v4",
  cost_guard_mode: "inject",
  cost_guard_calibration: "c7d",
  expected_testbed_prefix: EXPECTED_PREFIX,
  scope_caveat:
    "Larger internal mechanism-validation slice over a frozen 24-case split. Not a paired significance claim, not broad SWE-bench evidence, not a VEXP parity claim, not a default promotion. Both guards remain DEFAULT-OFF; the env guard is opt-in.",
  total_cases: cases.length,
  ran_count: ran.length,
  valid_runs: validCases.length,
  invalid_runs: cases.filter((c) => !c.valid_run).map((c) => ({ instance_id: c.instance_id, group: c.group, reason: c.invalid_reason })),
  // ---- guard config invariants (over ran cases) ----
  both_guards_runtime_active_all: ran.every(
    (c) =>
      c.tool_loop_guard_mode === "runtime_injection" &&
      c.tool_loop_guard_runtime_hook_available === true &&
      c.cost_guard_mode === "runtime_injection" &&
      c.cost_guard_runtime_hook_available === true,
  ),
  calibration_v4_all: ran.every((c) => c.tool_loop_guard_calibration === "v4"),
  calibration_c7d_all: ran.every((c) => c.cost_guard_calibration === "c7d"),
  c7d_churn_threshold_2_all: ran.every((c) => c.cost_guard_edit_verify_churn_threshold === 2),
  c7d_gate_25_all: ran.every((c) => c.cost_guard_min_tool_calls_gate === 25),
  combined_hook_coexists_all: ran.every((c) => c.cost_guard_coexists_with_tool_loop_guard === true),
  // ---- env safety ----
  env_safety: {
    env_guard_enabled_all: ran.every((c) => c.stage5_env_guard_enabled === true),
    env_guard_pass_all: ran.every((c) => c.stage5_env_guard_status === "pass"),
    expected_prefix_all: ran.every((c) => c.stage5_expected_testbed_prefix === EXPECTED_PREFIX),
    python_prefix_verified_all: ran.every((c) => c.stage5_python_prefix_verified === true),
    pip_prefix_verified_all: ran.every((c) => c.stage5_pip_prefix_verified === true),
    drift_check_enabled_all: ran.every((c) => c.stage5_drift_check_enabled === true),
    any_prefix_drift_detected: ran.some((c) => c.env_drift_danger === true),
    drift_danger_instances: ran.filter((c) => c.env_drift_danger === true).map((c) => c.instance_id),
    any_prefix_guard_failure: ran.some((c) => Array.isArray(c.stage5_prefix_guard_failures) && c.stage5_prefix_guard_failures.length > 0),
    blocked_unsafe_pip_total: sum(ran.map((c) => c.stage5_blocked_unsafe_pip_command_count)),
    safety_invalid_instances: cases.filter((c) => /env_guard|prefix|drift/.test(c.invalid_reason ?? "")).map((c) => c.instance_id),
  },
  // ---- guard fire summary ----
  v4_fired_count: v4Fired.length,
  v4_fired_instances: v4Fired.map((c) => c.instance_id),
  v4_suppressed_total: sum(cases.map((c) => c.tool_loop_guard_suppressed_count)),
  v4_trigger_types_union: [...new Set(v4Fired.flatMap((c) => c.tool_loop_guard_trigger_types ?? []))],
  v4_early_read_fire_instances: ran.filter((c) => earlyReadFire(c)).map((c) => c.instance_id),
  c7_fired_count: c7Fired.length,
  c7_fired_instances: c7Fired.map((c) => c.instance_id),
  c7_trigger_types_union: [...new Set(c7Fired.flatMap((c) => c.cost_guard_trigger_types ?? []))],
  c7_fired_before_cap_all: c7Fired.every((c) => c.changed_behavior_evidence.cost_guard_fired_before_cost_cap === true),
  c7_fired_before_cap_count: c7Fired.filter((c) => c.changed_behavior_evidence.cost_guard_fired_before_cost_cap === true).length,
  // C7_D fires on a control/protected case (B/D) before a clear no-convergence signal would be harmful.
  c7_fired_on_control_or_protected: c7Fired.filter((c) => c.group === "B" || c.group === "D").map((c) => c.instance_id),
  v4_fired_on_control_or_protected: v4Fired.filter((c) => c.group === "B" || c.group === "D").map((c) => c.instance_id),
  combined_same_turn_total: sum(cases.map((c) => c.combined_guard_same_turn_count)),
  guard_marker_verified_all_fired:
    v4Fired.every((c) => c.tool_loop_guard_marker_present) && c7Fired.every((c) => c.cost_guard_marker_present),
  // ---- carryover sentinels (M85) ----
  carryover: {
    "django-16263": carryover("django__django-16263"),
    "django-15503": carryover("django__django-15503"),
    "pytest-6197": carryover("pytest-dev__pytest-6197"),
    "django-12273": carryover("django__django-12273"),
  },
  // ---- by group ----
  by_group: Object.fromEntries(
    GROUPS.map((g) => {
      const gs = byGroup(g);
      return [
        g,
        {
          n: gs.length,
          ran: gs.filter((c) => c.run_label).length,
          valid: gs.filter((c) => c.valid_run).length,
          v4_fired: gs.filter((c) => c.v4_fired).length,
          c7_fired: gs.filter((c) => c.c7_fired).length,
          resolved: gs.filter((c) => c.resolved === true).length,
          prior_m73_baseline_resolved: gs.filter((c) => c.prior_m73_baseline_resolved === true).length,
          prior_m73_treatment_resolved: gs.filter((c) => c.prior_m73_treatment_resolved === true).length,
          mean_cost: mean(gs.map((c) => c.cost)),
          mean_m73_cost: mean(gs.map((c) => c.prior_m73_treatment_cost)),
          mean_tool_calls: mean(gs.map((c) => c.tool_call_count)),
          mean_m73_tool_calls: mean(gs.map((c) => c.prior_m73_treatment_tool_calls)),
        },
      ];
    }),
  ),
  // ---- targeted cost cohort (A) ----
  cohort_A_targeted_cost: {
    n: byGroup("A").length,
    valid: byGroup("A").filter((c) => c.valid_run).length,
    guard_fired: byGroup("A").filter((c) => c.v4_fired || c.c7_fired).length,
    mean_cost_m88: mean(byGroup("A").map((c) => c.cost)),
    mean_cost_m73: mean(byGroup("A").map((c) => c.prior_m73_treatment_cost)),
    mean_tool_calls_m88: mean(byGroup("A").map((c) => c.tool_call_count)),
    mean_tool_calls_m73: mean(byGroup("A").map((c) => c.prior_m73_treatment_tool_calls)),
  },
  // ---- resolution / cost roll-up ----
  resolution: {
    m88_resolved: cases.filter((c) => c.resolved === true).length,
    m73_treatment_resolved: cases.filter((c) => c.prior_m73_treatment_resolved === true).length,
    m73_baseline_resolved: cases.filter((c) => c.prior_m73_baseline_resolved === true).length,
  },
  cost_total_m88: Number(sum(cases.map((c) => c.cost)).toFixed(4)),
  cost_total_m73_treatment: Number(sum(cases.map((c) => c.prior_m73_treatment_cost)).toFixed(4)),
  tool_calls_total_m88: sum(cases.map((c) => c.tool_call_count)),
  tool_calls_total_m73_treatment: sum(cases.map((c) => c.prior_m73_treatment_tool_calls)),
};

fs.writeFileSync(path.join(OUT, "stage5_m88_v4_c7d_envguard_validation.json"), JSON.stringify(summary, null, 2) + "\n");
fs.writeFileSync(
  path.join(OUT, "stage5_m88_v4_c7d_envguard_validation.detail.json"),
  JSON.stringify(
    { milestone: "M88", tool_loop_guard_calibration: "v4", cost_guard_mode: "inject", cost_guard_calibration: "c7d", expected_testbed_prefix: EXPECTED_PREFIX, cases },
    null,
    2,
  ) + "\n",
);
console.log(
  "RESULT_JSON: " +
    JSON.stringify(
      {
        total: summary.total_cases,
        ran: summary.ran_count,
        valid: summary.valid_runs,
        v4_fired: summary.v4_fired_count,
        c7_fired: summary.c7_fired_count,
        env_guard_pass_all: summary.env_safety.env_guard_pass_all,
        any_drift: summary.env_safety.any_prefix_drift_detected,
        v4_early_read_fire: summary.v4_early_read_fire_instances,
        resolution: summary.resolution,
        cost_m88: summary.cost_total_m88,
        invalid: summary.invalid_runs,
      },
      null,
      2,
    ),
);
