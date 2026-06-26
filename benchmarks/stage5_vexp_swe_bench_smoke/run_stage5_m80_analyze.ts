/**
 * M80 — analyze captured CALIBRATED-V4 tool-loop-guard INJECT-mode live runs against the frozen
 * M77 split, the prior M73 unguarded treatment, the prior M77 V0/default-guard live runs, and the
 * M79 offline V4 replay predictions. NO live agents, NO Docker, NO API spend — reads
 * results/runs/<label>/raw/vtrace/{swebench-*.jsonl,_run.meta.json,_tool_calls.json,_eval.meta.json}
 * and the injected context file, computes M80 validity + V4 guard-mechanism evidence
 * (firing AND suppression) + changed-behavior deltas vs M73/M77, and writes the compact summary +
 * detail JSON.
 *
 *   bun run_stage5_m80_analyze.ts [--split path] [--out dir]
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
const LABEL_PREFIX = flag("--label-prefix", "m80_tool_loop_guard_v4_");
const GUARD_MARKER = "<VTRACE_TOOL_LOOP_GUARD>";
const DIGEST_START = "<VTRACE_CAPSULE_V2_DIGEST_START>";
const CONTRACT_START = "<VTRACE_DIGEST_DECISION_CONTRACT_START>";
const NO_HIGH_CONF = "NO_HIGH_CONFIDENCE_REQUIRED_TARGETS";
const NO_PRIOR_PROGRESS = "no_prior_progress_for_read_search_window_trigger";

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

// Resolve the canonical label that produced a result. Base label is
// `m80_tool_loop_guard_v4_<safe>`; operational retries are `..._retryN`. Prefer the base
// (non-retry) label that produced a result, else the first retry that produced a result.
function resolveLabel(instanceId: string): { label: string | null; attempts: string[]; usedRetry: boolean } {
  const prefix = `${LABEL_PREFIX}${safe(instanceId)}`;
  const runsRoot = path.join(OUT, "runs");
  if (!fs.existsSync(runsRoot)) return { label: null, attempts: [], usedRetry: false };
  const attempts = fs
    .readdirSync(runsRoot)
    .filter((d) => (d === prefix || d.startsWith(`${prefix}_`)) && fs.statSync(path.join(runsRoot, d)).isDirectory())
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

// Prior M77 (V0/default-guard live) outcomes, keyed by instance.
const m77Detail = readJson(path.join(RESULTS, "stage5_m77_tool_loop_guard_live_validation.detail.json"));
const m77ById = new Map<string, any>();
for (const c of (m77Detail?.cases ?? []) as any[]) m77ById.set(c.instance_id, c);

// M79 offline V4 replay predictions (the 4 named live-divergent cases only).
const m79Replay = readJson(path.join(RESULTS, "stage5_m79_tool_loop_guard_v4_replay.json"));
const m79Named = (m79Replay?.named_by_case ?? {}) as Record<string, any>;

const split = readJson(SPLIT);
const cases: any[] = [];

for (const c of split.cases as any[]) {
  const { label, attempts, usedRetry } = resolveLabel(c.instance_id);
  const meta = label ? readJson(path.join(runDir(label), "_run.meta.json")) : null;
  const row = label ? firstSwebench(label) : null;
  const evalMeta = label ? readJson(path.join(runDir(label), "_eval.meta.json")) : null;
  const stats = label ? toolCallStats(label) : { tool_call_count: null, reads: null, searches: null, edits: null, repeated_file_reads: null };
  const ctx = classifyContext(meta);

  const enabled = meta?.tool_loop_guard_enabled ?? null;
  const mode = meta?.tool_loop_guard_mode ?? null;
  const calibration = meta?.tool_loop_guard_calibration ?? null;
  const hookAvail = meta?.tool_loop_guard_runtime_hook_available ?? null;
  const injCount = meta?.tool_loop_guard_injection_count ?? null;
  const events = (meta?.tool_loop_guard_events ?? null) as any[] | null;
  const injectedMsgs = (meta?.tool_loop_guard_injected_messages ?? null) as string[] | null;
  const triggerTypes = events ? [...new Set(events.map((e) => e.trigger_type))] : null;
  const suppressedCount = meta?.tool_loop_guard_suppressed_count ?? null;
  const suppressedEvents = (meta?.tool_loop_guard_suppressed_events ?? null) as any[] | null;
  const suppressionReasons = (meta?.tool_loop_guard_suppression_reasons ?? null) as string[] | null;
  const markerPresent = Array.isArray(injectedMsgs) && injectedMsgs.length > 0 && injectedMsgs.every((m) => m.includes(GUARD_MARKER));
  const patchProduced = !!(row && row.modelPatch);
  const resolved = evalMeta ? (evalMeta.resolvedCount ?? 0) > 0 : row ? !!row.resolved : null;
  const treatmentValid = meta?.vtraceTreatmentValid ?? null;
  const contextInjected = meta?.vtraceContextInjected ?? null;
  const firstFire = meta?.tool_loop_guard_first_event_turn ?? null;
  const capCost = (c.prior_m73_treatment_cost ?? 0) >= 2.9 ? 3.0 : null;
  const thisCost = row?.costUsd ?? null;

  const nEvents = Array.isArray(events) ? events.length : 0;
  // Firing-side consistency (mirrors M77): injection_count <-> events <-> marker <-> first-turn.
  const fireConsistent =
    (injCount ?? 0) === nEvents &&
    ((injCount ?? 0) === 0
      ? firstFire === null && (!Array.isArray(injectedMsgs) || injectedMsgs.length === 0)
      : firstFire !== null && markerPresent && Array.isArray(injectedMsgs) && injectedMsgs.length === (injCount ?? 0));
  // Suppression-side consistency: count <-> events array length, and (when >0) reason present.
  const nSuppressed = Array.isArray(suppressedEvents) ? suppressedEvents.length : 0;
  const suppressConsistent =
    (suppressedCount ?? 0) === nSuppressed &&
    ((suppressedCount ?? 0) === 0 ||
      (Array.isArray(suppressionReasons) && suppressionReasons.includes(NO_PRIOR_PROGRESS)));

  let valid = true;
  let reason: string | null = null;
  if (!label) {
    valid = false; reason = "m80_provider_abort";
  } else if (ctx.partial) {
    valid = false; reason = "m80_partial_sentinel";
  } else if (ctx.ctxFound && !ctx.digest) {
    valid = false; reason = "m80_digest_not_present";
  } else if (ctx.ctxFound && !ctx.contract) {
    valid = false; reason = "m80_decision_contract_not_present";
  } else if (ctx.ctxFound && !ctx.gate) {
    valid = false; reason = "m80_confidence_gate_not_applied";
  } else if (!ctx.ctxFound && treatmentValid !== true) {
    valid = false; reason = "m80_decision_contract_not_present";
  } else if (enabled !== true) {
    valid = false; reason = "m80_tool_loop_guard_not_enabled";
  } else if (mode !== "runtime_injection") {
    valid = false; reason = "m80_tool_loop_guard_not_inject_mode";
  } else if (calibration !== "v4") {
    valid = false; reason = "m80_tool_loop_guard_not_v4";
  } else if (hookAvail !== true) {
    valid = false; reason = "m80_runtime_hook_unavailable";
  } else if (!fireConsistent) {
    valid = false; reason = "m80_guard_event_missing_when_expected";
  } else if (!suppressConsistent) {
    valid = false; reason = "m80_guard_suppression_metadata_missing";
  } else if (patchProduced && evalMeta == null) {
    valid = false; reason = "m80_eval_missing_for_patch";
  }

  const liveFired = (injCount ?? 0) > 0;
  const liveSuppressed = (suppressedCount ?? 0) > 0;

  // Prior M77 (V0/default-guard live).
  const m77 = m77ById.get(c.instance_id) ?? null;
  const priorM77Resolved = m77?.resolved ?? null;
  const priorM77Cost = m77?.cost ?? null;
  const priorM77Tools = m77?.tool_call_count ?? null;
  const priorM77Fired = m77 ? (m77.tool_loop_guard_injection_count ?? 0) > 0 : null;
  const priorM77FirstFire = m77?.tool_loop_guard_first_event_turn ?? null;
  const priorM77Trigger = m77?.tool_loop_guard_trigger_types ?? null;

  // M79 offline V4 prediction (named cases only).
  const m79 = m79Named[c.instance_id] ?? null;
  const m79ExpectedFire = m79 ? m79.v4?.fires ?? null : null;
  const m79ExpectedSuppress = m79 ? (m79.v4?.suppressed?.length ?? 0) > 0 : null;
  const m79ExpectedFirstFire = m79 ? m79.v4?.first_fire_turn ?? null : null;
  const m79ExpectedSuppressionReason = m79 && (m79.v4?.suppressed?.length ?? 0) > 0 ? m79.v4.suppressed[0].reason : null;

  // changed-behavior evidence vs prior M73 AND prior M77.
  const priorM73Tools = c.prior_m73_tool_calls ?? null;
  const priorM73Cost = c.prior_m73_treatment_cost ?? null;
  const priorM73Resolved = c.prior_m73_treatment_resolved ?? null;
  const cbe: Record<string, boolean | null> = {
    lower_tool_calls_than_m77: stats.tool_call_count != null && priorM77Tools != null ? stats.tool_call_count < priorM77Tools : null,
    lower_repeated_reads_than_m77:
      stats.repeated_file_reads != null && m77?.repeated_file_reads != null ? stats.repeated_file_reads < m77.repeated_file_reads : null,
    lower_cost_than_m77: thisCost != null && priorM77Cost != null ? thisCost < priorM77Cost : null,
    lower_cost_than_m73: thisCost != null && priorM73Cost != null ? thisCost < priorM73Cost : null,
    new_files_edited_vs_m77: stats.edits != null && m77?.edits != null ? stats.edits !== m77.edits : null,
    patch_produced_when_prior_no_patch:
      priorM73Resolved === false && c.prior_m73_outcome === "treatment_invalid_or_skipped" ? patchProduced : null,
    earlier_exit_than_m77: row?.numTurns != null && priorM77Tools != null ? row.numTurns < priorM77Tools : null,
    guard_fired_before_cost_cap: capCost != null && firstFire != null && thisCost != null ? thisCost < capCost : null,
    risky_early_fire_suppressed: liveSuppressed,
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
    turn_count: row?.numTurns ?? null,
    ...stats,
    // guard — firing
    tool_loop_guard_enabled: enabled,
    tool_loop_guard_mode: mode,
    tool_loop_guard_calibration: calibration,
    tool_loop_guard_runtime_hook_available: hookAvail,
    tool_loop_guard_runtime_hook_unavailable_reason: meta?.tool_loop_guard_runtime_hook_unavailable_reason ?? null,
    tool_loop_guard_injection_count: injCount,
    tool_loop_guard_first_event_turn: firstFire,
    tool_loop_guard_last_event_turn: meta?.tool_loop_guard_last_event_turn ?? null,
    tool_loop_guard_events: events,
    tool_loop_guard_injected_messages: injectedMsgs,
    tool_loop_guard_trigger_types: triggerTypes,
    guard_marker_present: markerPresent,
    // guard — suppression (V4)
    tool_loop_guard_suppressed_count: suppressedCount,
    tool_loop_guard_suppressed_events: suppressedEvents,
    tool_loop_guard_suppression_reasons: suppressionReasons,
    live_fired: liveFired,
    live_suppressed: liveSuppressed,
    guard_fire_consistent: fireConsistent,
    guard_suppress_consistent: suppressConsistent,
    guard_fired_before_cost_cap: cbe.guard_fired_before_cost_cap,
    // prior M73
    prior_m73_treatment_resolved: priorM73Resolved,
    prior_m73_treatment_cost: priorM73Cost,
    prior_m73_tool_calls: priorM73Tools,
    // prior M77 (V0/default-guard live)
    prior_m77_resolved: priorM77Resolved,
    prior_m77_cost: priorM77Cost,
    prior_m77_tool_calls: priorM77Tools,
    prior_m77_guard_fired: priorM77Fired,
    prior_m77_first_fire_turn: priorM77FirstFire,
    prior_m77_trigger_type: priorM77Trigger,
    // M79 offline V4 prediction
    prior_m79_v4_expected_fire: m79ExpectedFire,
    prior_m79_v4_expected_suppress: m79ExpectedSuppress,
    prior_m79_v4_expected_first_fire_turn: m79ExpectedFirstFire,
    prior_m79_v4_expected_suppression_reason: m79ExpectedSuppressionReason,
    changed_behavior_evidence: cbe,
  });
}

// ---- aggregate ----
const byGroup = (g: string) => cases.filter((c) => c.validation_group === g);
const num = (xs: (number | null)[]) => xs.filter((x): x is number => typeof x === "number");
const sum = (xs: (number | null)[]) => num(xs).reduce((a, b) => a + b, 0);
const mean = (xs: (number | null)[]) => (num(xs).length ? sum(xs) / num(xs).length : null);

const fired = cases.filter((c) => (c.tool_loop_guard_injection_count ?? 0) > 0);
const suppressed = cases.filter((c) => (c.tool_loop_guard_suppressed_count ?? 0) > 0);
const targeted = [...byGroup("A"), ...byGroup("B")];
const controls = [...byGroup("C"), ...byGroup("D")];
const protectedWins = byGroup("C");

const summary = {
  milestone: "M80",
  kind: "calibrated-V4 tool-loop-guard INJECT-mode live re-validation (10-case slice; NOT a 100-task benchmark, NOT a promotion)",
  helper: "run_stage5_m80_analyze.ts",
  live_agents: true,
  docker: true,
  retrieval_changed: false,
  guard_calibration: "v4",
  scope_caveat:
    "Mechanism re-validation slice over the frozen M77 10-case split. Not a paired significance claim, not broad SWE-bench evidence, not a default promotion.",
  guard_config_replayed: split.guard_config_replayed,
  total_cases: cases.length,
  valid_runs: cases.filter((c) => c.valid_run).length,
  invalid_runs: cases.filter((c) => !c.valid_run).map((c) => ({ instance_id: c.instance_id, reason: c.invalid_reason })),
  runtime_injection_active_all: cases.every(
    (c) => c.tool_loop_guard_mode === "runtime_injection" && c.tool_loop_guard_runtime_hook_available === true,
  ),
  calibration_v4_all: cases.every((c) => c.tool_loop_guard_calibration === "v4" || !c.run_label),
  guard_fired_count: fired.length,
  guard_fired_instances: fired.map((c) => c.instance_id),
  guard_suppressed_count: suppressed.length,
  guard_suppressed_instances: suppressed.map((c) => c.instance_id),
  guard_marker_verified_all_fired: fired.every((c) => c.guard_marker_present),
  guard_metadata_consistent_all: cases.every((c) => (c.guard_fire_consistent && c.guard_suppress_consistent) || !c.run_label),
  // mechanism checks for the 4 named cases
  mechanism_checks: {
    "pytest-6197_early_fire_suppressed_or_absent": (() => {
      const x = cases.find((c) => c.instance_id === "pytest-dev__pytest-6197");
      if (!x || !x.run_label) return null;
      const earlyReadFire = (x.tool_loop_guard_events ?? []).some(
        (e: any) => e.trigger_type === "repeated_read" && (e.turn ?? 99) <= 3,
      );
      return !earlyReadFire; // suppressed OR no early read-loop occurred
    })(),
    "astropy-14598_useful_fire_preserved_if_loop_recurs": (() => {
      const x = cases.find((c) => c.instance_id === "astropy__astropy-14598");
      if (!x || !x.run_label) return null;
      return x.live_fired ? (x.tool_loop_guard_trigger_types ?? []).includes("repeated_read") : "no_recurring_read_loop";
    })(),
    "sympy-12419_command_fire_preserved_if_loop_recurs": (() => {
      const x = cases.find((c) => c.instance_id === "sympy__sympy-12419");
      if (!x || !x.run_label) return null;
      return x.live_fired ? (x.tool_loop_guard_trigger_types ?? []).includes("repeated_failed_command") : "no_recurring_command_loop";
    })(),
    "django-16263_no_read_loop_fire": (() => {
      const x = cases.find((c) => c.instance_id === "django__django-16263");
      if (!x || !x.run_label) return null;
      const readFamilyFired = (x.tool_loop_guard_trigger_types ?? []).some((t: string) =>
        ["repeated_read", "repeated_search", "repeated_read_window"].includes(t),
      );
      return { read_family_fired: readFamilyFired, capped: (x.cost ?? 0) >= 2.9, resolved: x.resolved };
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
          fired: gs.filter((c) => (c.tool_loop_guard_injection_count ?? 0) > 0).length,
          suppressed: gs.filter((c) => (c.tool_loop_guard_suppressed_count ?? 0) > 0).length,
          resolved: gs.filter((c) => c.resolved === true).length,
          prior_m73_resolved: gs.filter((c) => c.prior_m73_treatment_resolved === true).length,
          prior_m77_resolved: gs.filter((c) => c.prior_m77_resolved === true).length,
          mean_cost: mean(gs.map((c) => c.cost)),
          mean_m77_cost: mean(gs.map((c) => c.prior_m77_cost)),
          mean_m73_cost: mean(gs.map((c) => c.prior_m73_treatment_cost)),
        },
      ];
    }),
  ),
  protected_wins_summary: {
    n: protectedWins.length,
    resolved: protectedWins.filter((c) => c.resolved === true).length,
    prior_m73_resolved: protectedWins.filter((c) => c.prior_m73_treatment_resolved === true).length,
    prior_m77_resolved: protectedWins.filter((c) => c.prior_m77_resolved === true).length,
    any_guard_fired: protectedWins.some((c) => (c.tool_loop_guard_injection_count ?? 0) > 0),
    regressed_instances: protectedWins
      .filter((c) => c.prior_m73_treatment_resolved === true && c.resolved !== true)
      .map((c) => c.instance_id),
  },
  controls_summary: {
    n: controls.length,
    resolved: controls.filter((c) => c.resolved === true).length,
    prior_m73_resolved: controls.filter((c) => c.prior_m73_treatment_resolved === true).length,
    prior_m77_resolved: controls.filter((c) => c.prior_m77_resolved === true).length,
    any_guard_fired: controls.some((c) => (c.tool_loop_guard_injection_count ?? 0) > 0),
    any_read_family_fired: controls.some((c) =>
      (c.tool_loop_guard_trigger_types ?? []).some((t: string) =>
        ["repeated_read", "repeated_search", "repeated_read_window"].includes(t),
      ),
    ),
  },
  resolution: {
    m80_resolved: cases.filter((c) => c.resolved === true).length,
    m77_resolved: cases.filter((c) => c.prior_m77_resolved === true).length,
    m73_resolved: cases.filter((c) => c.prior_m73_treatment_resolved === true).length,
  },
  cost_total_m80: sum(cases.map((c) => c.cost)),
  cost_total_m77: sum(cases.map((c) => c.prior_m77_cost)),
  cost_total_m73: sum(cases.map((c) => c.prior_m73_treatment_cost)),
};

fs.writeFileSync(path.join(OUT, "stage5_m80_tool_loop_guard_v4_live_validation.json"), JSON.stringify(summary, null, 2) + "\n");
fs.writeFileSync(
  path.join(OUT, "stage5_m80_tool_loop_guard_v4_live_validation.detail.json"),
  JSON.stringify({ milestone: "M80", guard_calibration: "v4", cases }, null, 2) + "\n",
);
console.log(
  "RESULT_JSON: " +
    JSON.stringify(
      {
        total: summary.total_cases,
        valid: summary.valid_runs,
        fired: summary.guard_fired_count,
        suppressed: summary.guard_suppressed_count,
        runtime_active_all: summary.runtime_injection_active_all,
        calibration_v4_all: summary.calibration_v4_all,
        resolution: summary.resolution,
        cost_m80: Number(summary.cost_total_m80.toFixed(2)),
        cost_m77: Number(summary.cost_total_m77.toFixed(2)),
        invalid: summary.invalid_runs,
      },
      null,
      2,
    ),
);
