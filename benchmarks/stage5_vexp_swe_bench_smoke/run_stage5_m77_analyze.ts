/**
 * M77 — analyze captured tool-loop-guard INJECT-mode live runs against the frozen split and the
 * prior M73 unguarded treatment artifacts. NO live agents, NO Docker, NO API spend — reads
 * results/runs/<label>/raw/vtrace/{swebench-*.jsonl,_run.meta.json,_tool_calls.json,_eval.meta.json}
 * and the injected context file, computes M77 validity + guard-mechanism evidence + changed-behavior
 * deltas, and writes the compact summary + detail JSON.
 *
 *   bun run_stage5_m77_analyze.ts [--split path] [--out dir]
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
const SPLIT = flag("--split", path.join(RESULTS, "stage5_m77_tool_loop_guard_live_split.json"));
const GUARD_MARKER = "<VTRACE_TOOL_LOOP_GUARD>";
const DIGEST_START = "<VTRACE_CAPSULE_V2_DIGEST_START>";
const CONTRACT_START = "<VTRACE_DIGEST_DECISION_CONTRACT_START>";
const NO_HIGH_CONF = "NO_HIGH_CONFIDENCE_REQUIRED_TARGETS";

const safe = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "_");
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

// Resolve the canonical label that produced a result. The driver's bash safe() (echo|tr) appends
// a TRAILING underscore, so on-disk dirs are `m77_tool_loop_guard_inject_<safe>_` and retries are
// `..._<safe>__retryN`. Scan the runs dir by prefix to be robust to that, preferring the base
// (non-retry) label, then the first retry that produced a result.
function resolveLabel(instanceId: string): { label: string | null; attempts: string[]; usedRetry: boolean } {
  const prefix = `m77_tool_loop_guard_inject_${safe(instanceId)}_`;
  const runsRoot = path.join(OUT, "runs");
  if (!fs.existsSync(runsRoot)) return { label: null, attempts: [], usedRetry: false };
  const attempts = fs
    .readdirSync(runsRoot)
    .filter((d) => d.startsWith(prefix) && fs.statSync(path.join(runsRoot, d)).isDirectory())
    .sort((a, b) => (a.includes("_retry") ? 1 : 0) - (b.includes("_retry") ? 1 : 0) || a.localeCompare(b));
  const base = attempts.find((a) => !a.includes("_retry")) ?? null;
  const withResult = (base && hasResult(base) ? base : null) ?? attempts.find(hasResult) ?? null;
  return { label: withResult, attempts, usedRetry: withResult !== null && withResult !== base };
}

function toolCallStats(label: string) {
  const tc = readJson(path.join(runDir(label), "_tool_calls.json")) as any[] | null;
  if (!Array.isArray(tc)) return { tool_call_count: null, reads: null, searches: null, edits: null, repeated_file_reads: null };
  const byCat = (c: string) => tc.filter((t) => t.category === c).length;
  const readPaths = tc.filter((t) => t.category === "read").map((t) => t.path).filter(Boolean) as string[];
  const counts = new Map<string, number>();
  for (const p of readPaths) counts.set(p, (counts.get(p) ?? 0) + 1);
  let redundant = 0;
  for (const v of counts.values()) if (v > 1) redundant += v - 1;
  return {
    tool_call_count: tc.length,
    reads: byCat("read"),
    searches: byCat("search"),
    edits: byCat("edit"),
    repeated_file_reads: redundant,
  };
}

function classifyContext(meta: any): { digest: boolean; contract: boolean; gate: boolean; partial: boolean; ctxFound: boolean } {
  const f = meta?.vtraceContextFile as string | undefined;
  if (!f || !fs.existsSync(f)) {
    // fall back to the runner's own validity verdict
    return { digest: false, contract: false, gate: false, partial: false, ctxFound: false };
  }
  const ctx = fs.readFileSync(f, "utf8");
  const occ = (n: string) => ctx.split(n).length - 1;
  const dS = occ(DIGEST_START), dE = occ("<VTRACE_CAPSULE_V2_DIGEST_END>");
  const cS = occ(CONTRACT_START), cE = occ("<VTRACE_DIGEST_DECISION_CONTRACT_END>");
  return {
    digest: dS === 1 && dE === 1,
    contract: cS === 1 && cE === 1,
    // confidence gate present either as required targets in the contract or the explicit marker
    gate: cS === 1 && (ctx.includes("decision:") || ctx.includes(NO_HIGH_CONF)),
    partial: dS !== dE || cS !== cE,
    ctxFound: true,
  };
}

interface CaseOut {
  instance_id: string;
  repo: string | null;
  difficulty: string | null;
  validation_group: string;
  run_label: string | null;
  used_operational_retry: boolean;
  attempt_labels: string[];
  // validity
  valid_run: boolean;
  invalid_reason: string | null;
  treatment_valid: boolean | null;
  context_injected: boolean | null;
  effective_engine: string | null;
  digest_present: boolean;
  decision_contract_present: boolean;
  confidence_gate_applied: boolean;
  partial_sentinel: boolean;
  // outcome
  patch_produced: boolean;
  resolved: boolean | null;
  evaluation_ran: boolean | null;
  cost: number | null;
  duration_ms: number | null;
  input_tokens_total: number | null;
  output_tokens_total: number | null;
  cache_read_tokens_total: number | null;
  cache_write_tokens_total: number | null;
  total_tokens: number | null;
  turn_count: number | null;
  tool_call_count: number | null;
  reads: number | null;
  searches: number | null;
  edits: number | null;
  repeated_file_reads: number | null;
  // guard
  tool_loop_guard_enabled: boolean | null;
  tool_loop_guard_mode: string | null;
  tool_loop_guard_runtime_hook_available: boolean | null;
  tool_loop_guard_runtime_hook_unavailable_reason: string | null;
  tool_loop_guard_injection_count: number | null;
  tool_loop_guard_first_event_turn: number | null;
  tool_loop_guard_last_event_turn: number | null;
  tool_loop_guard_events: any[] | null;
  tool_loop_guard_injected_messages: string[] | null;
  tool_loop_guard_trigger_types: string[] | null;
  guard_marker_present: boolean;
  guard_consistent: boolean;
  live_fire_vs_m75_prediction: string;
  guard_fired_before_cost_cap: boolean | null;
  // prior M73 + M75
  prior_m73_treatment_resolved: boolean | null;
  prior_m73_treatment_cost: number | null;
  prior_m73_tool_calls: number | null;
  prior_m75_would_guard_fire: boolean | null;
  prior_m75_first_fire_turn: number | null;
  prior_m75_trigger_type: string | null;
  prior_m76_runtime_injection_count: number | null;
  // changed behavior
  changed_behavior_evidence: Record<string, boolean | null>;
}

const split = readJson(SPLIT);
const cases: CaseOut[] = [];

for (const c of split.cases as any[]) {
  const { label, attempts, usedRetry } = resolveLabel(c.instance_id);
  const meta = label ? readJson(path.join(runDir(label), "_run.meta.json")) : null;
  const row = label ? firstSwebench(label) : null;
  const evalMeta = label ? readJson(path.join(runDir(label), "_eval.meta.json")) : null;
  const stats = label ? toolCallStats(label) : { tool_call_count: null, reads: null, searches: null, edits: null, repeated_file_reads: null };
  const ctx = classifyContext(meta);

  const enabled = meta?.tool_loop_guard_enabled ?? null;
  const mode = meta?.tool_loop_guard_mode ?? null;
  const hookAvail = meta?.tool_loop_guard_runtime_hook_available ?? null;
  const injCount = meta?.tool_loop_guard_injection_count ?? null;
  const events = (meta?.tool_loop_guard_events ?? null) as any[] | null;
  const injectedMsgs = (meta?.tool_loop_guard_injected_messages ?? null) as string[] | null;
  const triggerTypes = events ? [...new Set(events.map((e) => e.trigger_type))] : null;
  const markerPresent = Array.isArray(injectedMsgs) && injectedMsgs.length > 0 && injectedMsgs.every((m) => m.includes(GUARD_MARKER));
  const patchProduced = !!(row && row.modelPatch);
  const resolved = evalMeta ? (evalMeta.resolvedCount ?? 0) > 0 : row ? !!row.resolved : null;
  const treatmentValid = meta?.vtraceTreatmentValid ?? null;
  const contextInjected = meta?.vtraceContextInjected ?? null;
  const firstFire = meta?.tool_loop_guard_first_event_turn ?? null;
  const capCost = c.prior_m75_cap_hit ? 3.0 : null;
  const thisCost = row?.costUsd ?? null;

  // --- M77 validity ---
  // NOTE: a Group A case is NOT required to fire LIVE. M75 "would_guard_fire" was computed
  // on the M73 UNGUARDED stream; the guarded live trajectory legitimately diverges (the guard
  // may fire earlier/later, or the agent simply does not loop this run). So the guard check is a
  // metadata-INTEGRITY check (injection_count <-> events <-> marker <-> first-turn consistency),
  // not a "must fire" gate. Live-vs-M75 firing is reported as mechanism evidence below.
  const nEvents = Array.isArray(events) ? events.length : 0;
  const guardConsistent =
    (injCount ?? 0) === nEvents &&
    ((injCount ?? 0) === 0
      ? firstFire === null && (!Array.isArray(injectedMsgs) || injectedMsgs.length === 0)
      : firstFire !== null && markerPresent && Array.isArray(injectedMsgs) && injectedMsgs.length === (injCount ?? 0));
  let valid = true;
  let reason: string | null = null;
  if (!label) {
    valid = false;
    reason = "m77_provider_abort"; // no result produced (or aborted); driver ledger distinguishes
  } else if (ctx.partial) {
    valid = false; reason = "m77_partial_sentinel";
  } else if (ctx.ctxFound && !ctx.digest) {
    valid = false; reason = "m77_digest_not_present";
  } else if (ctx.ctxFound && !ctx.contract) {
    valid = false; reason = "m77_decision_contract_not_present";
  } else if (ctx.ctxFound && !ctx.gate) {
    valid = false; reason = "m77_confidence_gate_not_applied";
  } else if (!ctx.ctxFound && treatmentValid !== true) {
    valid = false; reason = "m77_decision_contract_not_present";
  } else if (enabled !== true) {
    valid = false; reason = "m77_tool_loop_guard_not_enabled";
  } else if (mode !== "runtime_injection") {
    valid = false; reason = "m77_tool_loop_guard_not_inject_mode";
  } else if (hookAvail !== true) {
    valid = false; reason = "m77_runtime_hook_unavailable";
  } else if (!guardConsistent) {
    valid = false; reason = "m77_guard_event_missing_when_expected";
  } else if (patchProduced && evalMeta == null) {
    valid = false; reason = "m77_eval_missing_for_patch";
  }
  // Mechanism evidence: live firing vs the M75 prediction on the unguarded stream.
  const liveFired = (injCount ?? 0) > 0;
  const fireVsM75 =
    c.prior_m75_would_guard_fire === true
      ? liveFired ? "predicted_fired_live_fired" : "predicted_fired_live_no_fire_trajectory_diverged"
      : liveFired ? "not_predicted_live_fired" : "not_predicted_live_no_fire";

  // --- changed-behavior evidence vs prior M73 ---
  const priorTools = c.prior_m73_tool_calls ?? null;
  const priorCost = c.prior_m73_treatment_cost ?? null;
  const priorResolved = c.prior_m73_treatment_resolved ?? null;
  const cbe: Record<string, boolean | null> = {
    lower_tool_calls_than_prior: stats.tool_call_count != null && priorTools != null ? stats.tool_call_count < priorTools : null,
    lower_repeated_reads_than_prior:
      stats.repeated_file_reads != null && c.prior_m75_repeated_read_count != null
        ? stats.repeated_file_reads < c.prior_m75_repeated_read_count
        : null,
    lower_cost_than_prior: thisCost != null && priorCost != null ? thisCost < priorCost : null,
    patch_produced_when_prior_no_patch:
      priorResolved === false && c.prior_m73_outcome === "treatment_invalid_or_skipped" ? patchProduced : null,
    earlier_exit_than_prior: row?.numTurns != null && c.prior_m73_tool_calls != null ? row.numTurns < c.prior_m73_tool_calls : null,
    guard_fired_before_cost_cap:
      capCost != null && firstFire != null && thisCost != null ? thisCost < capCost : null,
    resolved_when_prior_unresolved: priorResolved === false && resolved === true ? true : priorResolved === false ? false : null,
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
      row != null
        ? (row.inputTokens ?? 0) + (row.outputTokens ?? 0) + (row.cacheReadTokens ?? 0) + (row.cacheCreationTokens ?? 0)
        : null,
    turn_count: row?.numTurns ?? null,
    ...stats,
    tool_loop_guard_enabled: enabled,
    tool_loop_guard_mode: mode,
    tool_loop_guard_runtime_hook_available: hookAvail,
    tool_loop_guard_runtime_hook_unavailable_reason: meta?.tool_loop_guard_runtime_hook_unavailable_reason ?? null,
    tool_loop_guard_injection_count: injCount,
    tool_loop_guard_first_event_turn: firstFire,
    tool_loop_guard_last_event_turn: meta?.tool_loop_guard_last_event_turn ?? null,
    tool_loop_guard_events: events,
    tool_loop_guard_injected_messages: injectedMsgs,
    tool_loop_guard_trigger_types: triggerTypes,
    guard_marker_present: markerPresent,
    guard_consistent: guardConsistent,
    live_fire_vs_m75_prediction: fireVsM75,
    guard_fired_before_cost_cap: cbe.guard_fired_before_cost_cap,
    prior_m73_treatment_resolved: priorResolved,
    prior_m73_treatment_cost: priorCost,
    prior_m73_tool_calls: priorTools,
    prior_m75_would_guard_fire: c.prior_m75_would_guard_fire ?? null,
    prior_m75_first_fire_turn: c.prior_m75_first_fire_turn ?? null,
    prior_m75_trigger_type: c.prior_m75_trigger_type ?? null,
    prior_m76_runtime_injection_count: c.prior_m76_runtime_injection_count ?? null,
    changed_behavior_evidence: cbe,
  });
}

// ---- aggregate ----
const byGroup = (g: string) => cases.filter((c) => c.validation_group === g);
const num = (xs: (number | null)[]) => xs.filter((x): x is number => typeof x === "number");
const sum = (xs: (number | null)[]) => num(xs).reduce((a, b) => a + b, 0);
const mean = (xs: (number | null)[]) => (num(xs).length ? sum(xs) / num(xs).length : null);

const fired = cases.filter((c) => (c.tool_loop_guard_injection_count ?? 0) > 0);
const targeted = [...byGroup("A"), ...byGroup("B")];
const targetedFired = targeted.filter((c) => (c.tool_loop_guard_injection_count ?? 0) > 0);
const controls = [...byGroup("C"), ...byGroup("D")];

const summary = {
  milestone: "M77",
  kind: "tool-loop-guard INJECT-mode live mechanism validation (10-case slice; NOT a 100-task benchmark, NOT a promotion)",
  helper: "run_stage5_m77_analyze.ts",
  live_agents: true,
  docker: true,
  retrieval_changed: false,
  scope_caveat:
    "Mechanism-validation slice over a frozen 10-case split. Not a paired significance claim, not broad SWE-bench evidence, not a default promotion.",
  guard_config_replayed: split.guard_config_replayed,
  total_cases: cases.length,
  valid_runs: cases.filter((c) => c.valid_run).length,
  invalid_runs: cases.filter((c) => !c.valid_run).map((c) => ({ instance_id: c.instance_id, reason: c.invalid_reason })),
  runtime_injection_active_all: cases.every((c) => c.tool_loop_guard_mode === "runtime_injection" && c.tool_loop_guard_runtime_hook_available === true),
  guard_fired_count: fired.length,
  guard_fired_instances: fired.map((c) => c.instance_id),
  guard_marker_verified_all_fired: fired.every((c) => c.guard_marker_present),
  guard_metadata_consistent_all: cases.every((c) => c.guard_consistent || !c.run_label),
  live_fire_vs_m75: Object.fromEntries(
    [...new Set(cases.map((c) => c.live_fire_vs_m75_prediction))].map((k) => [
      k,
      cases.filter((c) => c.live_fire_vs_m75_prediction === k).map((c) => c.instance_id),
    ]),
  ),
  by_group: Object.fromEntries(
    ["A", "B", "C", "D"].map((g) => {
      const gs = byGroup(g);
      return [
        g,
        {
          n: gs.length,
          valid: gs.filter((c) => c.valid_run).length,
          fired: gs.filter((c) => (c.tool_loop_guard_injection_count ?? 0) > 0).length,
          resolved: gs.filter((c) => c.resolved === true).length,
          prior_resolved: gs.filter((c) => c.prior_m73_treatment_resolved === true).length,
          mean_cost: mean(gs.map((c) => c.cost)),
          mean_prior_cost: mean(gs.map((c) => c.prior_m73_treatment_cost)),
          mean_tool_calls: mean(gs.map((c) => c.tool_call_count)),
          mean_prior_tool_calls: mean(gs.map((c) => c.prior_m73_tool_calls)),
        },
      ];
    }),
  ),
  targeted_fired: {
    n: targetedFired.length,
    instances: targetedFired.map((c) => c.instance_id),
    mean_cost: mean(targetedFired.map((c) => c.cost)),
    mean_prior_cost: mean(targetedFired.map((c) => c.prior_m73_treatment_cost)),
    mean_tool_calls: mean(targetedFired.map((c) => c.tool_call_count)),
    mean_prior_tool_calls: mean(targetedFired.map((c) => c.prior_m73_tool_calls)),
    mean_repeated_reads: mean(targetedFired.map((c) => c.repeated_file_reads)),
    resolved: targetedFired.filter((c) => c.resolved === true).length,
    prior_resolved: targetedFired.filter((c) => c.prior_m73_treatment_resolved === true).length,
  },
  controls_summary: {
    n: controls.length,
    resolved: controls.filter((c) => c.resolved === true).length,
    prior_resolved: controls.filter((c) => c.prior_m73_treatment_resolved === true).length,
    any_guard_fired: controls.some((c) => (c.tool_loop_guard_injection_count ?? 0) > 0),
    mean_cost: mean(controls.map((c) => c.cost)),
    mean_prior_cost: mean(controls.map((c) => c.prior_m73_treatment_cost)),
  },
  cost_total_m77: sum(cases.map((c) => c.cost)),
  cost_total_prior_m73: sum(cases.map((c) => c.prior_m73_treatment_cost)),
};

fs.writeFileSync(path.join(OUT, "stage5_m77_tool_loop_guard_live_validation.json"), JSON.stringify(summary, null, 2) + "\n");
fs.writeFileSync(path.join(OUT, "stage5_m77_tool_loop_guard_live_validation.detail.json"), JSON.stringify({ milestone: "M77", cases }, null, 2) + "\n");
console.log("RESULT_JSON: " + JSON.stringify({
  total: summary.total_cases,
  valid: summary.valid_runs,
  fired: summary.guard_fired_count,
  runtime_active_all: summary.runtime_injection_active_all,
  cost_m77: Number(summary.cost_total_m77.toFixed(2)),
  cost_prior: Number(summary.cost_total_prior_m73.toFixed(2)),
  by_group: summary.by_group,
}, null, 2));
