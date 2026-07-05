// Stage 5 M105 — pure helpers for live-run validity classification, metric
// aggregation, and the historical join. NO I/O here: everything takes parsed
// JSON values so the logic is unit-testable without raw live artifacts.

// ---------------------------------------------------------------------------
// Run validity (fallback / safety / arms-off) over _run.meta.json + result row
// ---------------------------------------------------------------------------

export type RunMeta = Record<string, unknown>;

export interface RunValidity {
  readonly valid: boolean;
  readonly reasons: string[]; // empty when valid
  readonly fallback_fired: boolean;
  readonly env_guard_pass: boolean;
  readonly shell_guard_pass: boolean;
  readonly unguarded_used: boolean;
  readonly drift_detected: boolean;
  readonly host_pip_block_count: number;
  readonly behavioral_guard_fired: boolean;
  readonly revision_artifacts_present: boolean;
}

// The M104 residual: a v2→legacy fallback retrieval query still packs
// FAIL_TO_PASS, so a fallback fire makes the run parity-invalid for M105.
export function detectFallbackFire(meta: RunMeta): boolean {
  const requested = meta.vtraceRequestedCapsuleEngine;
  const effective = meta.vtraceEffectiveCapsuleEngine;
  const reason = meta.vtraceCapsuleEngineFallbackReason;
  return requested !== "v2" || effective !== "v2" || (reason !== null && reason !== undefined);
}

// Drift summary line format (envIsolationGuard summarizeDriftLine): "not_run"
// or "overall=<status>[ mismatch=N][ changed=N][ SAFETY_FAILED]".
export function detectDrift(meta: RunMeta): boolean {
  const summary = meta.stage5_prefix_drift_summary;
  if (typeof summary !== "string" || summary === "not_run") return false;
  return summary.includes("SAFETY_FAILED") || summary.includes("mismatch=");
}

export function hostPipBlockCount(meta: RunMeta): number {
  const count = meta.stage5_blocked_host_package_command_count;
  const legacy = meta.stage5_blocked_unsafe_pip_command_count;
  return (typeof count === "number" ? count : 0) + (typeof legacy === "number" ? legacy : 0);
}

export function behavioralGuardFired(meta: RunMeta): boolean {
  // An unflagged run emits NO *_guard_* behavioral metadata; any fire/injection
  // marker means a V4/C7_D arm was configured — invalid for M105.
  return Object.keys(meta).some(
    (k) => (k.startsWith("tool_loop_guard_") || k.startsWith("cost_guard_")) && meta[k] !== null && meta[k] !== false,
  );
}

export interface AssessRunInput {
  readonly meta: RunMeta | null;
  readonly hasResultRow: boolean;
  readonly resultRowParses: boolean;
  readonly unexplainedLeakCount: number | null; // null = snapshot missing
  readonly revisionArtifactNames: readonly string[]; // _pivot_revision*/_ruleout_sufficiency* under raw/
  readonly preflightPassed: boolean;
}

export function assessRunValidity(input: AssessRunInput): RunValidity {
  const reasons: string[] = [];
  const meta = input.meta;
  if (!input.preflightPassed) reasons.push("preflight did not pass before spawn");
  if (meta === null) reasons.push("_run.meta.json missing or unparseable");
  if (!input.hasResultRow) reasons.push("no swebench result row");
  else if (!input.resultRowParses) reasons.push("result row unparseable");

  const fallback = meta !== null && detectFallbackFire(meta);
  if (fallback) reasons.push("v2->legacy capsule fallback fired (parity-invalid per M104 residual)");

  const envGuardPass =
    meta !== null &&
    meta.stage5_env_guard_status === "pass" &&
    meta.stage5_env_guard_benchmark_valid === true;
  if (meta !== null && !envGuardPass) reasons.push(`env guard not pass (status=${String(meta.stage5_env_guard_status)})`);

  const shellGuardPass = meta !== null && meta.stage5_agent_shell_guard_status === "pass";
  if (meta !== null && !shellGuardPass)
    reasons.push(`agent shell guard not pass (status=${String(meta.stage5_agent_shell_guard_status)})`);

  const unguarded = meta !== null && meta.stage5_unguarded_live_env_allowed === true;
  if (unguarded) reasons.push("unguarded live env escape hatch used (never benchmark-valid)");

  const drift = meta !== null && detectDrift(meta);
  if (drift) reasons.push(`env drift detected (${String(meta?.stage5_prefix_drift_summary)})`);

  const pipBlocks = meta === null ? 0 : hostPipBlockCount(meta);
  if (pipBlocks > 0) reasons.push(`host package-manager commands blocked (${pipBlocks})`);

  const guardFired = meta !== null && behavioralGuardFired(meta);
  if (guardFired) reasons.push("behavioral guard (V4/C7_D) metadata present — arm was configured");

  if (meta !== null && meta.vtraceContextInjected !== true) reasons.push("vtrace context was not injected");

  if (input.revisionArtifactNames.length > 0)
    reasons.push(`revision/corrective artifacts present: ${input.revisionArtifactNames.join(", ")}`);

  if (input.unexplainedLeakCount === null) reasons.push("injected-context snapshot missing (cannot leak-scan)");
  else if (input.unexplainedLeakCount > 0)
    reasons.push(`unexplained model-visible leakage hits in injected context (${input.unexplainedLeakCount})`);

  return {
    valid: reasons.length === 0,
    reasons,
    fallback_fired: fallback,
    env_guard_pass: envGuardPass,
    shell_guard_pass: shellGuardPass,
    unguarded_used: unguarded,
    drift_detected: drift,
    host_pip_block_count: pipBlocks,
    behavioral_guard_fired: guardFired,
    revision_artifacts_present: input.revisionArtifactNames.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Result-row metrics
// ---------------------------------------------------------------------------

export interface ResultRowMetrics {
  readonly resolved: boolean | null;
  readonly patch_produced: boolean;
  readonly changed_files: string[];
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_creation_tokens: number;
  readonly total_tokens: number;
  readonly cost_usd: number;
  readonly num_turns: number | null;
  readonly tool_calls: number | null;
}

export function changedFilesFromPatch(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.split("\n")) {
    const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (m && m[2] !== undefined && !files.includes(m[2])) files.push(m[2]);
  }
  return files;
}

export function extractResultRowMetrics(row: Record<string, unknown>, toolCallCount: number | null): ResultRowMetrics {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const patch = typeof row.modelPatch === "string" ? row.modelPatch : "";
  const input = num(row.inputTokens);
  const output = num(row.outputTokens);
  const cacheRead = num(row.cacheReadTokens);
  const cacheCreation = num(row.cacheCreationTokens);
  return {
    resolved: typeof row.resolved === "boolean" ? row.resolved : row.resolved === 1 ? true : row.resolved === 0 ? false : null,
    patch_produced: patch.trim().length > 0,
    changed_files: changedFilesFromPatch(patch),
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreation,
    total_tokens: input + output + cacheRead + cacheCreation,
    cost_usd: num(row.costUsd),
    num_turns: typeof row.numTurns === "number" ? row.numTurns : null,
    tool_calls: toolCallCount,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function p90(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank p90 (ceil(0.9n)), standard and stable for tiny samples.
  const rank = Math.max(1, Math.ceil(0.9 * sorted.length));
  return sorted[rank - 1]!;
}

export interface M105CaseRow {
  readonly instance_id: string;
  readonly preflight_status: "pass" | "fail" | "missing";
  readonly live_status: "valid" | "invalid" | "not_attempted";
  readonly eval_status: "evaluated" | "pending" | "not_applicable";
  readonly validity: RunValidity | null;
  readonly metrics: ResultRowMetrics | null;
}

export interface M105Aggregate {
  readonly attempted_count: number;
  readonly preflight_valid_count: number;
  readonly live_started_count: number;
  readonly live_valid_count: number;
  readonly eval_completed_count: number;
  readonly resolved_count: number;
  readonly resolution_rate: number | null;
  readonly patch_produced_count: number;
  readonly no_patch_count: number;
  readonly invalid_count: number;
  readonly invalid_reasons: Record<string, string[]>;
  readonly total_tokens: number;
  readonly cache_read_tokens: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly tool_calls: number;
  readonly cost_usd: number;
  readonly median_cost: number | null;
  readonly p90_cost: number | null;
  readonly median_tokens: number | null;
  readonly fallback_fire_count: number;
  readonly leakage_fire_count: number;
  readonly env_guard_fail_count: number;
  readonly shell_guard_block_count: number;
  readonly host_pip_block_count: number;
}

export function aggregateM105(rows: readonly M105CaseRow[], leakageFireCount: number): M105Aggregate {
  const started = rows.filter((r) => r.live_status !== "not_attempted");
  const valid = rows.filter((r) => r.live_status === "valid");
  const withMetrics = started.filter((r) => r.metrics !== null);
  const evaluated = valid.filter((r) => r.eval_status === "evaluated" && r.metrics?.resolved !== null);
  const resolved = evaluated.filter((r) => r.metrics!.resolved === true);
  const costs = withMetrics.map((r) => r.metrics!.cost_usd);
  const tokens = withMetrics.map((r) => r.metrics!.total_tokens);
  const invalid = started.filter((r) => r.live_status === "invalid");
  const invalidReasons: Record<string, string[]> = {};
  for (const r of invalid) invalidReasons[r.instance_id] = r.validity?.reasons ?? ["unknown"];
  const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
  return {
    attempted_count: rows.filter((r) => r.preflight_status !== "missing").length,
    preflight_valid_count: rows.filter((r) => r.preflight_status === "pass").length,
    live_started_count: started.length,
    live_valid_count: valid.length,
    eval_completed_count: evaluated.length,
    resolved_count: resolved.length,
    resolution_rate: evaluated.length === 0 ? null : resolved.length / evaluated.length,
    patch_produced_count: withMetrics.filter((r) => r.metrics!.patch_produced).length,
    no_patch_count: withMetrics.filter((r) => !r.metrics!.patch_produced).length,
    invalid_count: invalid.length,
    invalid_reasons: invalidReasons,
    total_tokens: sum(tokens),
    cache_read_tokens: sum(withMetrics.map((r) => r.metrics!.cache_read_tokens)),
    input_tokens: sum(withMetrics.map((r) => r.metrics!.input_tokens)),
    output_tokens: sum(withMetrics.map((r) => r.metrics!.output_tokens)),
    tool_calls: sum(withMetrics.map((r) => r.metrics!.tool_calls ?? 0)),
    cost_usd: sum(costs),
    median_cost: median(costs),
    p90_cost: p90(costs),
    median_tokens: median(tokens),
    fallback_fire_count: started.filter((r) => r.validity?.fallback_fired === true).length,
    leakage_fire_count: leakageFireCount,
    env_guard_fail_count: started.filter((r) => r.validity !== null && !r.validity.env_guard_pass).length,
    shell_guard_block_count: started.filter((r) => r.validity !== null && !r.validity.shell_guard_pass).length,
    host_pip_block_count: sum(started.map((r) => r.validity?.host_pip_block_count ?? 0)),
  };
}

// ---------------------------------------------------------------------------
// Historical join
// ---------------------------------------------------------------------------

export interface HistoricalJoinRow {
  readonly instance_id: string;
  readonly m73_treatment_resolved: boolean | null;
  readonly m73_baseline_resolved: boolean | null;
  readonly m92_resolved: boolean | null; // null when not in the M92 50-split
  readonly m103_outcome: string | null;
  readonly m104_preflight_leak_clean: boolean | null;
}

export function joinHistorical(
  instanceId: string,
  m73Row: { treatment_resolved?: unknown; baseline_resolved?: unknown } | undefined,
  m92Resolved: boolean | undefined,
  m103Outcome: string | undefined,
  m104LeakClean: boolean | undefined,
): HistoricalJoinRow {
  const asBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  return {
    instance_id: instanceId,
    m73_treatment_resolved: m73Row === undefined ? null : asBool(m73Row.treatment_resolved),
    m73_baseline_resolved: m73Row === undefined ? null : asBool(m73Row.baseline_resolved),
    m92_resolved: m92Resolved === undefined ? null : m92Resolved,
    m103_outcome: m103Outcome ?? null,
    m104_preflight_leak_clean: m104LeakClean === undefined ? null : m104LeakClean,
  };
}
