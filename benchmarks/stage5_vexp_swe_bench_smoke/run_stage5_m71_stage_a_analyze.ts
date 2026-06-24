/**
 * M71 — offline metrics extraction for the Stage A 50 live treatment runs (structured-bounded
 * digest decision contract WITH the M68 pivot-confidence gate, `--pivot-confidence-gate`).
 * Reads CAPTURED artifacts only; no agents, no Docker, no spend. Reuses the EXACT M66/M69
 * classifier (classifyDigestDecisionContract: required PIVOT targets only) plus the M68 gate
 * extras (zero-required marker, demoted pivots, O/T id separation). VERIFIES the gate fired
 * by reproducing the M71 Stage A pre-flight render (same required/demoted/marker).
 *
 * Baselines are NOT run in M71. For reused_verified cases the matrix-provided baseline run
 * (resolved + cost/tokens/tools, read from its own captured swebench-*.jsonl) is joined for a
 * paired subset analysis; missing-baseline cases are treatment-only (paired conclusion pending
 * Stage C).
 *
 * Usage: bun run_stage5_m71_stage_a_analyze.ts
 *   [--fixture results/stage5_m71_stage_a_fixture.json]
 *   [--preflight results/stage5_m71_stage_a_preflight.json]
 */
import fs from "node:fs";
import path from "node:path";
import {
  parseDigestDecisionContract,
  classifyDigestDecisionContract,
  NO_HIGH_CONFIDENCE_REQUIRED_MARKER,
  type DigestDecisionTarget,
  type DigestDecisionToolCall,
} from "../../src/capsuleV2/digestDecisionContract.ts";

const RESULTS = "benchmarks/stage5_vexp_swe_bench_smoke/results";
const RUNS = path.join(RESULTS, "runs");
function flag(name: string, fb: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fb;
}
const FIXTURE = flag("--fixture", path.join(RESULTS, "stage5_m71_stage_a_fixture.json"));
const PREFLIGHT = flag("--preflight", path.join(RESULTS, "stage5_m71_stage_a_preflight.json"));
const M69_VALIDATION = path.join(RESULTS, "stage5_m69_pivot_confidence_24_live_validation.json");

const CONTRACT_START = "<VTRACE_DIGEST_DECISION_CONTRACT_START>";
const CONTRACT_END = "<VTRACE_DIGEST_DECISION_CONTRACT_END>";
const DIGEST_START = "<VTRACE_CAPSULE_V2_DIGEST_START>";
const DIGEST_END = "<VTRACE_CAPSULE_V2_DIGEST_END>";
const DEMOTED_SUFFIX = "low-confidence pivot (weak localization evidence)";

function readJson<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as T; } catch { return null; }
}
function readText(p: string): string {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}
function firstGlob(dir: string, prefix: string): string | null {
  try { const f = fs.readdirSync(dir).find((n) => n.startsWith(prefix)); return f ? path.join(dir, f) : null; } catch { return null; }
}
function toRepoRel(p: string): string {
  const m = /\.bench-repos\/[^/]+\/(.+)$/.exec(p) || /workspaces\/[^/]+\/[^/]+\/(.+)$/.exec(p);
  return (m ? m[1]! : p).replace(/^\.\//, "");
}
function pathsMatch(a: string, b: string): boolean {
  const na = toRepoRel(a), nb = toRepoRel(b);
  return na === nb || na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`);
}
function editedFilesFromPatch(patch: string): string[] {
  const files = new Set<string>();
  for (const m of patch.matchAll(/^\+\+\+ b\/(.+)$/gm)) files.add(m[1]!.trim());
  for (const m of patch.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)) files.add(m[1]!.trim());
  return [...files];
}
function parseOptionalContext(snapshot: string): Array<{ id: string; kind: string; target: string; path: string; demoted: boolean }> {
  const s = snapshot.indexOf(CONTRACT_START), e = snapshot.indexOf(CONTRACT_END);
  if (s < 0 || e < 0) return [];
  const block = snapshot.slice(s, e);
  const out: Array<{ id: string; kind: string; target: string; path: string; demoted: boolean }> = [];
  for (const m of block.matchAll(/^- (O\d+): (PIVOT|IMPACT) (\S+) — optional context only: (.+)$/gm)) {
    out.push({ id: m[1]!, kind: m[2]!, target: m[3]!.trim(), path: m[3]!.split("::")[0]!.trim(), demoted: m[4]!.includes(DEMOTED_SUFFIX) });
  }
  return out;
}
function agentTextFrom(raw: string): string {
  let t = "";
  for (const line of readText(path.join(raw, "_agent_stream.first_pass.jsonl")).split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (o.type === "result" && typeof o.result === "string") t += "\n" + o.result;
      if (o.type === "assistant") {
        const content = (o.message as Record<string, unknown> | undefined)?.content;
        if (Array.isArray(content)) for (const b of content) {
          if (b && typeof b === "object" && (b as Record<string, unknown>).type === "text") t += "\n" + String((b as Record<string, unknown>).text ?? "");
        }
      }
    } catch { /* ignore */ }
  }
  return t;
}
function countOcc(h: string, n: string): number { return h.split(n).length - 1; }
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

// Read a captured swebench run (treatment or baseline) -> compact metrics. Baselines are
// captured under raw/baseline/, treatments under raw/vtrace/ — resolve whichever exists.
function readSweRun(runLabel: string): {
  found: boolean; resolved: boolean; evaluated: boolean; patch_produced: boolean;
  cost: number; total_tokens: number; cache_read: number; tool_call_count: number; reads: number; searches: number;
} | null {
  const rawRoot = path.join(RUNS, runLabel, "raw");
  let raw: string | null = null;
  for (const cond of ["baseline", "vtrace", "vexp"]) {
    const d = path.join(rawRoot, cond);
    if (firstGlob(d, "swebench-")) { raw = d; break; }
  }
  if (!raw) return null;
  const sweFile = firstGlob(raw, "swebench-");
  if (!sweFile) return null;
  const swe = readJson<Record<string, unknown>>(sweFile) ?? (() => { const l = readText(sweFile).trim().split("\n").pop(); return l ? (JSON.parse(l) as Record<string, unknown>) : null; })();
  if (!swe) return null;
  const evalMeta = readJson<Record<string, unknown>>(path.join(raw, "_eval.meta.json"));
  const toolCalls = readJson<Array<Record<string, unknown>>>(path.join(raw, "_tool_calls.json")) ?? [];
  const modelPatch = typeof swe.modelPatch === "string" ? (swe.modelPatch as string) : "";
  const it = num(swe.inputTokens), ot = num(swe.outputTokens), cr = num(swe.cacheReadTokens), cw = num(swe.cacheCreationTokens);
  return {
    found: true,
    resolved: swe.resolved === true || evalMeta?.resolvedCount === 1,
    evaluated: evalMeta !== null,
    patch_produced: modelPatch.length > 0,
    cost: num(swe.costUsd),
    total_tokens: it + ot + cr + cw,
    cache_read: cr,
    tool_call_count: toolCalls.length,
    reads: toolCalls.filter((t) => t.category === "read").length,
    searches: toolCalls.filter((t) => t.category === "search").length,
  };
}

type FixtureInst = {
  instance_id: string; safe: string; repo: string; difficulty: string; category: string;
  run_label: string; baseline_reuse_status: string; baseline_run_label: string | null; baseline_resolved: boolean | null;
};
const fixture = readJson<{ instances: FixtureInst[] }>(FIXTURE)!;
const preflight = readJson<{ cases: Record<string, unknown>[] }>(PREFLIGHT);
const preflightByInst = new Map<string, Record<string, unknown>>();
for (const c of preflight?.cases ?? []) preflightByInst.set(String(c.instance_id), c);

const rows: Record<string, unknown>[] = [];

for (const fi of fixture.instances) {
  const runLabel = fi.run_label;
  const runDir = path.join(RUNS, runLabel);
  const raw = path.join(runDir, "raw", "vtrace");
  const snapshot = readText(path.join(runDir, "_vtrace_instructions.snapshot.md"));
  const sweFile = firstGlob(raw, "swebench-");
  const swe = sweFile
    ? readJson<Record<string, unknown>>(sweFile) ?? (() => { const l = readText(sweFile).trim().split("\n").pop(); return l ? (JSON.parse(l) as Record<string, unknown>) : null; })()
    : null;
  const evalMeta = readJson<Record<string, unknown>>(path.join(raw, "_eval.meta.json"));
  const runMeta = readJson<Record<string, unknown>>(path.join(raw, "_run.meta.json"));
  const toolCalls = readJson<Array<Record<string, unknown>>>(path.join(raw, "_tool_calls.json")) ?? [];
  const modelPatch = typeof swe?.modelPatch === "string" ? (swe.modelPatch as string) : "";
  const editedFiles = editedFilesFromPatch(modelPatch);
  const resolved = swe?.resolved === true || evalMeta?.resolvedCount === 1;
  const evaluated = evalMeta !== null;
  const runPresent = swe !== null;

  const inputTokens = num(swe?.inputTokens), outputTokens = num(swe?.outputTokens);
  const cacheRead = num(swe?.cacheReadTokens), cacheWrite = num(swe?.cacheCreationTokens);
  const totalTokens = inputTokens + outputTokens + cacheRead + cacheWrite;

  const cat = (c: string) => toolCalls.filter((t) => t.category === c);
  const reads = cat("read"), searches = cat("search"), edits = cat("edit");
  const seen = new Set<string>(); let repeated = 0;
  for (const t of reads) { const p = typeof t.path === "string" ? t.path : ""; if (!p) continue; if (seen.has(p)) repeated++; else seen.add(p); }

  // sentinel accounting on the injected snapshot
  const digestStart = countOcc(snapshot, DIGEST_START), digestEnd = countOcc(snapshot, DIGEST_END);
  const contractStart = countOcc(snapshot, CONTRACT_START), contractEnd = countOcc(snapshot, CONTRACT_END);
  const partialSentinel = digestStart !== digestEnd || contractStart !== contractEnd;
  const digestPresent = digestStart === 1 && digestEnd === 1;
  const decisionContractPresent = contractStart === 1 && contractEnd === 1;
  const cBlock = snapshot.slice(Math.max(0, snapshot.indexOf(CONTRACT_START)), snapshot.indexOf(CONTRACT_END) + CONTRACT_END.length);
  const noHighConfMarker = snapshot.includes(NO_HIGH_CONFIDENCE_REQUIRED_MARKER);

  const parsed = parseDigestDecisionContract(snapshot);
  const requiredTargets: DigestDecisionTarget[] = parsed.targets.map((t) => ({ kind: t.kind, target: t.target, path: t.path, reason: "" }));
  const requiredCount = requiredTargets.length;
  const requiredHasImpactInContract = requiredTargets.some((t) => t.kind === "IMPACT");

  const grammarPresent = /target_id:/.test(cBlock) && /decision:/.test(cBlock) && /reason:/.test(cBlock) &&
    /files_touched:/.test(cBlock) && /EDIT/.test(cBlock) && /RULE_OUT/.test(cBlock) && /INSPECT_ONLY_NO_EDIT/.test(cBlock);
  const impactPresent = /→ impact/.test(snapshot.slice(snapshot.indexOf(DIGEST_START), snapshot.indexOf(DIGEST_END) + 1));
  const requiredIds = [...cBlock.matchAll(/target_id: (T\d+)/g)].map((m) => m[1]!);
  const optionalCtx = parseOptionalContext(snapshot);
  const optionalIds = optionalCtx.map((o) => o.id);
  const demotedPivots = optionalCtx.filter((o) => o.demoted);
  const impactReps = optionalCtx.filter((o) => o.kind === "IMPACT");
  const optionalSectionPresent = /Optional context \/ FYI/.test(cBlock);
  const optionalImpactContextPresent = optionalSectionPresent && impactReps.length > 0;
  const optionalNotClosureScored = /not closure-scored/i.test(cBlock);
  const idsCollide = optionalIds.some((id) => requiredIds.includes(id)) ||
    requiredIds.some((id) => /^O/.test(id)) || optionalIds.some((id) => /^T/.test(id));
  const compactModeApplied = countOcc(snapshot, "## VTRACE inspect-first") === 0;
  const gateEffectObserved = noHighConfMarker || demotedPivots.length > 0;

  // VERIFY the gate ran: live snapshot contract must reproduce the gated pre-flight render.
  const pf = preflightByInst.get(fi.instance_id);
  const gateMatchesPreflight =
    pf != null &&
    num(pf.required_target_count) === requiredCount &&
    num(pf.demoted_pivot_count) === demotedPivots.length &&
    Boolean(pf.no_high_confidence_required_marker) === noHighConfMarker;
  const gateEnabled = gateMatchesPreflight;

  // M71 validity gates (only meaningful if a run is present)
  let invalidReason: string | null = null;
  if (!runPresent) invalidReason = "m71_no_run";
  else if (partialSentinel) invalidReason = "m71_partial_sentinel";
  else if (!digestPresent) invalidReason = "m71_digest_not_present";
  else if (!decisionContractPresent) invalidReason = "m71_decision_contract_not_present";
  else if (!impactPresent) invalidReason = "m71_impact_not_enriched";
  else if (requiredCount === 0 && !noHighConfMarker) invalidReason = "m71_zero_required_without_marker";
  else if (requiredCount > 0 && !grammarPresent) invalidReason = "m71_structured_grammar_not_present";
  else if (requiredCount > 4) invalidReason = "m71_required_target_cap_exceeded";
  else if (requiredHasImpactInContract) invalidReason = "m71_required_impact_target_present";
  else if (impactReps.length > 0 && !optionalImpactContextPresent) invalidReason = "m71_optional_impact_context_missing";
  else if (optionalSectionPresent && !optionalNotClosureScored) invalidReason = "m71_optional_impact_context_missing";
  else if (idsCollide) invalidReason = "m71_optional_ids_collide_with_required_ids";
  else if (!compactModeApplied) invalidReason = "m71_compact_mode_not_applied";
  else if (!gateEnabled) invalidReason = "m71_confidence_gate_not_applied";
  else if (modelPatch.length === 0) invalidReason = "m71_fail_closed_omitted";
  const validRun = invalidReason === null;

  const clsToolCalls: DigestDecisionToolCall[] = toolCalls.map((t) => ({ category: typeof t.category === "string" ? t.category : "other", path: typeof t.path === "string" ? t.path : null }));
  const agentText = agentTextFrom(raw);
  const cls = classifyDigestDecisionContract({ requiredTargets, toolCalls: clsToolCalls, editedFiles, agentText });
  const per = cls.requiredTargets.map((r) => ({ kind: r.target.kind, target: r.target.target, path: r.target.path, decision: r.decision, inspected: r.inspected, edited: r.edited }));
  const pivots = per.filter((t) => t.kind === "PIVOT");
  const lead = pivots[0] ?? null, hiddenCo = pivots[1] ?? null;

  const optInspected = optionalCtx.filter((o) => toolCalls.some((t) => t.category === "read" && typeof t.path === "string" && pathsMatch(t.path, o.path)));
  const optEdited = optionalCtx.filter((o) => editedFiles.some((f) => pathsMatch(f, o.path)));
  const demotedInspected = demotedPivots.filter((o) => toolCalls.some((t) => t.category === "read" && typeof t.path === "string" && pathsMatch(t.path, o.path)));
  const demotedEdited = demotedPivots.filter((o) => editedFiles.some((f) => pathsMatch(f, o.path)));
  const offTarget = editedFiles.filter((f) => !per.some((t) => pathsMatch(f, t.path)));

  const coverage = cls.requiredTargetCount > 0 ? cls.requiredTargetClosedCount / cls.requiredTargetCount : null;
  const ignoredRate = cls.requiredTargetCount > 0 ? cls.requiredTargetIgnoredCount / cls.requiredTargetCount : null;

  // reused baseline join (no baseline run in M71)
  const baselineReused = fi.baseline_reuse_status === "reused_verified" && fi.baseline_run_label != null;
  const baselineMetrics = baselineReused ? readSweRun(fi.baseline_run_label!) : null;

  rows.push({
    instance_id: fi.instance_id,
    repo: fi.repo,
    difficulty: fi.difficulty,
    category: fi.category,
    execution_stage: "stage_a",
    condition: "m71_stage_a_pivot_confidence",
    run_label: runLabel,
    // baseline (reused only; matrix-provided)
    baseline_reuse_status: fi.baseline_reuse_status,
    baseline_run_label: fi.baseline_run_label,
    baseline_resolved: fi.baseline_resolved,
    baseline_metrics_available: baselineMetrics !== null,
    baseline_cost: baselineMetrics?.cost ?? null,
    baseline_total_tokens: baselineMetrics?.total_tokens ?? null,
    baseline_cache_read: baselineMetrics?.cache_read ?? null,
    baseline_tool_call_count: baselineMetrics?.tool_call_count ?? null,
    baseline_resolved_from_run: baselineMetrics?.resolved ?? null,
    // validity
    preflight_status: pf ? String(pf.final_status) : "UNKNOWN",
    run_present: runPresent,
    valid_run: validRun,
    invalid_reason: invalidReason,
    digest_present: digestPresent,
    impact_present: impactPresent,
    decision_contract_present: decisionContractPresent,
    structured_grammar_present: grammarPresent,
    bounded_contract_present: /EDIT \| RULE_OUT \| INSPECT_ONLY_NO_EDIT/.test(cBlock),
    compact_mode_applied: compactModeApplied,
    pivot_confidence_gate_enabled: gateEnabled,
    gate_matches_preflight: gateMatchesPreflight,
    gate_effect_observed: gateEffectObserved,
    no_high_confidence_required_marker_present: noHighConfMarker,
    partial_sentinel: partialSentinel,
    query_truncated: runMeta?.vtraceContextTruncated ?? null,
    treatment_valid_meta: runMeta?.vtraceTreatmentValid ?? null,
    required_impact_target_count: requiredTargets.filter((t) => t.kind === "IMPACT").length,
    optional_impact_context_present: optionalImpactContextPresent,
    optional_impact_id_count: impactReps.length,
    optional_impact_not_closure_scored: optionalNotClosureScored,
    optional_ids_collide: idsCollide,
    // metrics
    patch_produced: modelPatch.length > 0,
    resolved,
    evaluated,
    cost: num(swe?.costUsd),
    duration_ms: num(swe?.durationMs),
    input_tokens_total: inputTokens,
    output_tokens_total: outputTokens,
    cache_read_tokens_total: cacheRead,
    cache_write_tokens_total: cacheWrite,
    total_tokens: totalTokens,
    turn_count: num(swe?.numTurns),
    tool_call_count: toolCalls.length,
    read_count: reads.length,
    search_count: searches.length,
    edit_count: edits.length,
    repeated_file_reads: repeated,
    // structured decision (required pivots only)
    required_target_count: cls.requiredTargetCount,
    required_targets: per.map((t) => `${t.kind} ${t.target}`),
    required_has_impact: per.some((t) => t.kind === "IMPACT"),
    required_target_edited_count: cls.requiredTargetEditedCount,
    required_target_ruled_out_count: cls.requiredTargetRuledOutCount,
    required_target_inspect_only_no_edit_count: cls.requiredTargetInspectOnlyNoEditCount,
    required_target_ignored_count: cls.requiredTargetIgnoredCount,
    required_target_invalid_decision_count: cls.requiredTargetInvalidDecisionCount,
    required_target_closed_count: cls.requiredTargetClosedCount,
    required_target_open_count: cls.requiredTargetOpenCount,
    decision_coverage: coverage,
    ignored_rate: ignoredRate,
    per_target: per.map((t) => ({ kind: t.kind, target: t.target, decision: t.decision })),
    lead_pivot_path: lead?.path ?? null,
    lead_pivot_inspected: lead?.inspected ?? null,
    lead_pivot_edited: lead?.edited ?? null,
    hidden_or_non_traceback_pivot_present: hiddenCo !== null,
    // gate demotion details
    demoted_pivot_count: demotedPivots.length,
    demoted_pivots: demotedPivots.map((o) => `${o.id} ${o.target}`),
    demoted_pivot_inspected: demotedInspected.map((o) => o.path),
    demoted_pivot_edited: demotedEdited.map((o) => o.path),
    // optional context follow-through (demoted pivots + impact reps)
    optional_context_target_count: optionalCtx.length,
    optional_context_targets: optionalCtx.map((o) => `${o.id} ${o.kind} ${o.target}`),
    optional_context_inspected: optInspected.map((o) => o.path),
    optional_context_edited: optEdited.map((o) => o.path),
    edited_files: editedFiles,
    off_target_edit_count: offTarget.length,
    off_target_edits: offTarget,
  });
}

fs.writeFileSync(path.join(RESULTS, "stage5_m71_stage_a_50_treatment.detail.json"), JSON.stringify(rows, null, 2) + "\n");

// ---- aggregates ----
const present = rows.filter((r) => r.run_present);
const valid = present.filter((r) => r.valid_run);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

// structured decision pooled over valid runs with required targets
const dec = {
  required: sum(valid.map((r) => num(r.required_target_count))),
  closed: sum(valid.map((r) => num(r.required_target_closed_count))),
  open: sum(valid.map((r) => num(r.required_target_open_count))),
  ignored: sum(valid.map((r) => num(r.required_target_ignored_count))),
  invalid: sum(valid.map((r) => num(r.required_target_invalid_decision_count))),
  edited: sum(valid.map((r) => num(r.required_target_edited_count))),
  ruled_out: sum(valid.map((r) => num(r.required_target_ruled_out_count))),
  inspect_only_no_edit: sum(valid.map((r) => num(r.required_target_inspect_only_no_edit_count))),
} as Record<string, number>;
// Formulas match the M69 report (run_stage5_m69_report.ts): all rates are over the required
// target count, so M71 vs M69 comparisons are apples-to-apples.
dec.coverage_pct = dec.required ? +(100 * dec.closed / dec.required).toFixed(2) : 0;
dec.ignored_rate_pct = dec.required ? +(100 * dec.ignored / dec.required).toFixed(2) : 0;
dec.invalid_rule_out_rate_pct = dec.required ? +(100 * dec.invalid / dec.required).toFixed(2) : 0;

const m69v = readJson<Record<string, unknown>>(M69_VALIDATION);
const m69dec = (m69v?.structured_decision_m69 as Record<string, number> | undefined) ?? null;

// paired (reused_verified) subset
const paired = valid.filter((r) => r.baseline_reuse_status === "reused_verified" && r.baseline_resolved !== null);
const pairedWithMetrics = paired.filter((r) => r.baseline_metrics_available);
const pairedStats = {
  paired_case_count: paired.length,
  baseline_passes: paired.filter((r) => r.baseline_resolved === true).length,
  treatment_passes: paired.filter((r) => r.resolved === true).length,
  both_pass: paired.filter((r) => r.resolved === true && r.baseline_resolved === true).length,
  both_fail: paired.filter((r) => r.resolved !== true && r.baseline_resolved !== true).length,
  treatment_only_pass: paired.filter((r) => r.resolved === true && r.baseline_resolved !== true).length,
  baseline_only_pass: paired.filter((r) => r.resolved !== true && r.baseline_resolved === true).length,
  pooled_treatment_cost: +sum(pairedWithMetrics.map((r) => num(r.cost))).toFixed(4),
  pooled_baseline_cost: +sum(pairedWithMetrics.map((r) => num(r.baseline_cost))).toFixed(4),
  pooled_treatment_tokens: sum(pairedWithMetrics.map((r) => num(r.total_tokens))),
  pooled_baseline_tokens: sum(pairedWithMetrics.map((r) => num(r.baseline_total_tokens))),
  metrics_pairs: pairedWithMetrics.length,
};

// unpaired (missing baseline) subset
const unpaired = valid.filter((r) => r.baseline_reuse_status !== "reused_verified");
const unpairedStats = {
  case_count: unpaired.length,
  treatment_passes: unpaired.filter((r) => r.resolved === true).length,
  treatment_failures: unpaired.filter((r) => r.resolved !== true).length,
  pooled_cost: +sum(unpaired.map((r) => num(r.cost))).toFixed(4),
  pooled_tokens: sum(unpaired.map((r) => num(r.total_tokens))),
  mean_cost: +mean(unpaired.map((r) => num(r.cost))).toFixed(4),
  mean_tool_calls: +mean(unpaired.map((r) => num(r.tool_call_count))).toFixed(1),
};

const zeroRequiredCases = valid.filter((r) => num(r.required_target_count) === 0);
const demotedTotal = sum(valid.map((r) => num(r.demoted_pivot_count)));
// Cost/token aggregation covers ALL executed runs (incl. the 2 genuine no-patch runs, which
// cost real money), so total spend and the 100-run projection are not understated.
const costs = present.map((r) => num(r.cost));

const summary = {
  milestone: "M71",
  kind: "Stage A 50-treatment slice — structured-bounded digest decision contract + pivot-confidence gate",
  live_agents: true,
  source_matrix: "stage5_m70b_100_task_execution_matrix.json",
  stage_a_selected: fixture.instances.length,
  new_live_runs: present.length,
  runs_missing: fixture.instances.length - present.length,
  docker_evals: present.filter((r) => r.evaluated).length,
  fresh_baselines: 0,
  baselines_reused_available: rows.filter((r) => r.baseline_reuse_status === "reused_verified").length,
  baselines_missing_pending_stage_c: rows.filter((r) => r.baseline_reuse_status === "missing").length,
  retrieval_changed: false,
  // Live-launch accounting: 8 first-pass runs (the last 8 in fixture order) were aborted by
  // the account's 5-hour session limit (HTTP 429, out_of_credits) with no patch/result. The
  // user explicitly authorized re-running those 8 DISTINCT instances after the credit reset
  // to obtain one valid result per Stage A instance — exceeding the literal 50-launch cap
  // (58 total launches) but NOT adding any new/replacement instances or variance replicates.
  live_run_accounting: {
    distinct_instances: fixture.instances.length,
    total_live_launches: 58,
    first_pass_completed: 42,
    quota_aborted_first_pass: 8,
    quota_aborted_cases: ["sphinx-doc__sphinx-9698", "sphinx-doc__sphinx-9711", "sympy__sympy-12481", "sympy__sympy-16597", "sympy__sympy-16792", "sympy__sympy-18189", "sympy__sympy-20428", "sympy__sympy-24213"],
    reruns_after_credit_reset: 8,
    reruns_completed: 8,
    cap_note: "8 first-pass runs aborted by account 5-hour session limit (out_of_credits); user authorized re-running those 8 distinct instances after reset to get one valid result per Stage A instance. Cost total below covers the 50 valid results; ~$3 additional was spent on the 8 aborted partial attempts (not captured on disk after re-run overwrite).",
  },
  repos: [...new Set(fixture.instances.map((i) => i.repo))].length,
  valid_treatment_runs: valid.length,
  invalid_treatment_runs: present.length - valid.length,
  invalid_detail: present.filter((r) => !r.valid_run).map((r) => ({ instance_id: r.instance_id, reason: r.invalid_reason })),
  validity_rate_pct: present.length ? +(100 * valid.length / present.length).toFixed(1) : 0,
  gate_enabled_all: valid.every((r) => r.pivot_confidence_gate_enabled),
  gate_enabled_count: valid.filter((r) => r.pivot_confidence_gate_enabled).length,
  required_impact_any: valid.some((r) => r.required_has_impact),
  ids_collide_any: valid.some((r) => r.optional_ids_collide),
  optional_impact_ok: valid.every((r) => num(r.optional_impact_id_count) === 0 || r.optional_impact_context_present),
  partial_sentinel_any: present.some((r) => r.partial_sentinel),
  zero_required_count: zeroRequiredCases.length,
  zero_required_cases: zeroRequiredCases.map((r) => r.instance_id),
  zero_required_all_marker_backed: zeroRequiredCases.every((r) => r.no_high_confidence_required_marker_present),
  demoted_pivot_total: demotedTotal,
  demoted_cases: valid.filter((r) => num(r.demoted_pivot_count) > 0).map((r) => ({ instance_id: r.instance_id, demoted_pivots: r.demoted_pivots, demoted_inspected: r.demoted_pivot_inspected, demoted_edited: r.demoted_pivot_edited, resolved: r.resolved })),
  any_demoted_pivot_edited: valid.some((r) => (r.demoted_pivot_edited as string[]).length > 0),
  off_target_edit_total: sum(valid.map((r) => num(r.off_target_edit_count))),
  resolution: {
    n: present.length,
    treatment_resolved: present.filter((r) => r.resolved === true).length,
    treatment_evaluated: present.filter((r) => r.evaluated).length,
  },
  paired_vs_baseline: pairedStats,
  unpaired_treatment_only: unpairedStats,
  structured_decision_m71: dec,
  structured_decision_m69: m69dec,
  cost: {
    total: +sum(costs).toFixed(4),
    mean: +mean(costs).toFixed(4),
    median: +median(costs).toFixed(4),
    pooled_total_tokens: sum(present.map((r) => num(r.total_tokens))),
    projected_100_treatment_cost: +(sum(costs) / (present.length || 1) * 100).toFixed(2),
    max_cost_case: present.length ? present.reduce((a, b) => (num(b.cost) > num(a.cost) ? b : a)).instance_id : null,
    max_cost_value: present.length ? +Math.max(...costs).toFixed(4) : 0,
    cost_basis: "all 50 executed runs (incl. 2 no-patch)",
    note_excluded_quota_aborts: "~$3 additional spent on 8 quota-aborted partial attempts is not captured here (overwritten on re-run)",
  },
};

fs.writeFileSync(path.join(RESULTS, "stage5_m71_stage_a_50_treatment.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({
  stage_a_selected: summary.stage_a_selected,
  new_live_runs: summary.new_live_runs,
  valid: summary.valid_treatment_runs,
  invalid: summary.invalid_treatment_runs,
  validity_rate_pct: summary.validity_rate_pct,
  gate_all: summary.gate_enabled_all,
  required_impact_any: summary.required_impact_any,
  zero_required: summary.zero_required_count,
  demoted_total: summary.demoted_pivot_total,
  treatment_resolved: summary.resolution.treatment_resolved,
  docker_evals: summary.docker_evals,
  paired: pairedStats,
  unpaired: unpairedStats,
  decision_coverage_pct: dec.coverage_pct,
  ignored_rate_pct: dec.ignored_rate_pct,
  invalid_rule_out_rate_pct: dec.invalid_rule_out_rate_pct,
  cost_total: summary.cost.total,
  projected_100: summary.cost.projected_100_treatment_cost,
}, null, 2));
