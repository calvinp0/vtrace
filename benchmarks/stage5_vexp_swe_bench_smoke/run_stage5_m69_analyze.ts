/**
 * M69 — offline metrics extraction for the 24 frozen-set live treatment runs done WITH the
 * pivot-confidence gate (`--pivot-confidence-gate`). Reads CAPTURED artifacts only; no
 * agents, no Docker, no spend. Reuses the EXACT M66 classifier
 * (classifyDigestDecisionContract: required PIVOT targets only) plus the M68 gate extras
 * (zero-required marker, demoted pivots, O/T id separation). Joins the reused baseline and
 * the M66 treatment per-case metrics (from the committed M66 detail JSON) for paired
 * comparison, and writes the M69 per-case detail JSON.
 *
 * Usage: bun run_stage5_m69_analyze.ts [--fixture path]
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
const M66_DETAIL = path.join(RESULTS, "stage5_m66_optional_impact_24_live_validation.detail.json");
const M69_PREFLIGHT = path.join(RESULTS, "stage5_m69_preflight.json");
function flag(name: string, fb: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fb;
}
const FIXTURE = flag("--fixture", path.join(RESULTS, "stage5_m62_structured_bounded_24_preregistration.json"));

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
    out.push({
      id: m[1]!,
      kind: m[2]!,
      target: m[3]!.trim(),
      path: m[3]!.split("::")[0]!.trim(),
      demoted: m[4]!.includes(DEMOTED_SUFFIX),
    });
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

const fixture = readJson<{ instances: Array<{ instance_id: string; safe: string; repo: string; category: string; selection_reason: string; baseline_label_hint?: string }> }>(FIXTURE)!;
const m66 = readJson<Record<string, unknown>[]>(M66_DETAIL) ?? [];
const m66ByInst = new Map<string, Record<string, unknown>>();
for (const c of m66) m66ByInst.set(String(c.instance_id), c);
// M69 gated pre-flight (deterministic gate-on render) — used to VERIFY the gate was applied
// in the live run: the live snapshot contract must reproduce the gated pre-flight contract
// (same required-target count, same demoted-pivot count, same zero-required marker).
const preflight = readJson<{ cases: Record<string, unknown>[] }>(M69_PREFLIGHT);
const preflightByInst = new Map<string, Record<string, unknown>>();
for (const c of preflight?.cases ?? []) preflightByInst.set(String(c.instance_id), c);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

const rows: Record<string, unknown>[] = [];

for (const fi of fixture.instances) {
  const runLabel = `m69_pivot_confidence_24_${fi.safe}`;
  const runDir = path.join(RUNS, runLabel);
  const raw = path.join(runDir, "raw", "vtrace");
  const snapshot = readText(path.join(runDir, "_vtrace_instructions.snapshot.md"));
  const sweFile = firstGlob(raw, "swebench-");
  const swe = sweFile
    ? readJson<Record<string, unknown>>(sweFile) ?? (() => { const l = readText(sweFile).trim().split("\n").pop(); return l ? JSON.parse(l) as Record<string, unknown> : null; })()
    : null;
  const evalMeta = readJson<Record<string, unknown>>(path.join(raw, "_eval.meta.json"));
  const runMeta = readJson<Record<string, unknown>>(path.join(raw, "_run.meta.json"));
  const toolCalls = readJson<Array<Record<string, unknown>>>(path.join(raw, "_tool_calls.json")) ?? [];
  const modelPatch = typeof swe?.modelPatch === "string" ? (swe.modelPatch as string) : "";
  const editedFiles = editedFilesFromPatch(modelPatch);
  const resolved = swe?.resolved === true || evalMeta?.resolvedCount === 1;
  const evaluated = evalMeta !== null;

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
  // gate effect directly visible in the snapshot (marker or any demoted pivot)
  const gateEffectObserved = noHighConfMarker || demotedPivots.length > 0;
  // VERIFY the gate was applied: the live snapshot contract must reproduce the gated
  // pre-flight render for this case (same required count, demoted count, and marker). The
  // gate is a deterministic, retrieval-unchanged render step; a match proves it ran.
  const pf = preflightByInst.get(fi.instance_id);
  const gateMatchesPreflight =
    pf != null &&
    num(pf.required_target_count) === requiredCount &&
    num(pf.demoted_pivot_count) === demotedPivots.length &&
    Boolean(pf.no_high_confidence_required_marker) === noHighConfMarker;
  const gateEnabled = gateMatchesPreflight;

  // M69 validity gates
  let invalidReason: string | null = null;
  if (partialSentinel) invalidReason = "m69_partial_sentinel";
  else if (!digestPresent) invalidReason = "m69_digest_not_present";
  else if (!decisionContractPresent) invalidReason = "m69_decision_contract_not_present";
  else if (!impactPresent) invalidReason = "m69_impact_not_enriched";
  else if (requiredCount === 0 && !noHighConfMarker) invalidReason = "m69_zero_required_without_marker";
  else if (requiredCount > 0 && !grammarPresent) invalidReason = "m69_structured_grammar_not_present";
  else if (requiredCount > 4) invalidReason = "m69_required_target_cap_exceeded";
  else if (requiredHasImpactInContract) invalidReason = "m69_required_impact_target_present";
  else if (impactReps.length > 0 && !optionalImpactContextPresent) invalidReason = "m69_optional_impact_context_missing";
  else if (optionalSectionPresent && !optionalNotClosureScored) invalidReason = "m69_optional_impact_context_missing";
  else if (idsCollide) invalidReason = "m69_optional_ids_collide_with_required_ids";
  else if (!compactModeApplied) invalidReason = "m69_compact_mode_not_applied";
  else if (!gateEnabled) invalidReason = "m69_confidence_gate_not_applied";
  else if (modelPatch.length === 0) invalidReason = "m69_fail_closed_omitted";
  const validRun = invalidReason === null;

  const clsToolCalls: DigestDecisionToolCall[] = toolCalls.map((t) => ({ category: typeof t.category === "string" ? t.category : "other", path: typeof t.path === "string" ? t.path : null }));
  const agentText = agentTextFrom(raw);
  const cls = classifyDigestDecisionContract({ requiredTargets, toolCalls: clsToolCalls, editedFiles, agentText });
  const per = cls.requiredTargets.map((r) => ({ kind: r.target.kind, target: r.target.target, path: r.target.path, decision: r.decision, inspected: r.inspected, edited: r.edited }));
  const pivots = per.filter((t) => t.kind === "PIVOT");
  const lead = pivots[0] ?? null, hiddenCo = pivots[1] ?? null;

  // optional/demoted context follow-through (inspected = read; edited = appears in patch)
  const optInspected = optionalCtx.filter((o) => toolCalls.some((t) => t.category === "read" && typeof t.path === "string" && pathsMatch(t.path, o.path)));
  const optEdited = optionalCtx.filter((o) => editedFiles.some((f) => pathsMatch(f, o.path)));
  const demotedInspected = demotedPivots.filter((o) => toolCalls.some((t) => t.category === "read" && typeof t.path === "string" && pathsMatch(t.path, o.path)));
  const demotedEdited = demotedPivots.filter((o) => editedFiles.some((f) => pathsMatch(f, o.path)));
  const offTarget = editedFiles.filter((f) => !per.some((t) => pathsMatch(f, t.path)));

  const m66Case = m66ByInst.get(fi.instance_id) ?? {};
  const coverage = cls.requiredTargetCount > 0 ? cls.requiredTargetClosedCount / cls.requiredTargetCount : null;
  const ignoredRate = cls.requiredTargetCount > 0 ? cls.requiredTargetIgnoredCount / cls.requiredTargetCount : null;

  rows.push({
    instance_id: fi.instance_id,
    repo: fi.repo,
    category: fi.category,
    selection_reason: fi.selection_reason,
    condition: "m69_pivot_confidence",
    run_label: runLabel,
    // comparators (baseline reused; m66 = prior treatment without gate)
    baseline_source: m66Case.baseline_source ?? "reused",
    baseline_run_label: m66Case.baseline_run_label ?? fi.baseline_label_hint ?? null,
    baseline_model_match: m66Case.baseline_model_match ?? null,
    baseline_resolved: m66Case.baseline_resolved ?? null,
    baseline_resolved_frac: m66Case.baseline_resolved_frac ?? null,
    baseline_cost_med: m66Case.baseline_cost_med ?? null,
    baseline_total_tokens_med: m66Case.baseline_total_tokens_med ?? null,
    baseline_cache_read_med: m66Case.baseline_cache_read_med ?? null,
    baseline_tool_med: m66Case.baseline_tool_med ?? null,
    m66_resolved: m66Case.resolved ?? null,
    m66_cost: m66Case.cost ?? null,
    m66_total_tokens: m66Case.total_tokens ?? null,
    m66_cache_read: m66Case.cache_read_tokens_total ?? null,
    m66_tool_call_count: m66Case.tool_call_count ?? null,
    m66_required_target_count: m66Case.required_target_count ?? null,
    m66_closed: m66Case.required_target_closed_count ?? null,
    m66_open: m66Case.required_target_open_count ?? null,
    m66_ignored: m66Case.required_target_ignored_count ?? null,
    m66_invalid: m66Case.required_target_invalid_decision_count ?? null,
    m66_off_target_edit_count: m66Case.off_target_edit_count ?? null,
    // validity
    preflight_status: "VALID",
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
    hidden_or_non_traceback_pivot_path: hiddenCo?.path ?? null,
    hidden_or_non_traceback_pivot_inspected: hiddenCo?.inspected ?? null,
    hidden_or_non_traceback_pivot_edited: hiddenCo?.edited ?? null,
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
    edited_files_overlap_with_pivots: editedFiles.filter((f) => pivots.some((t) => pathsMatch(f, t.path))),
    edited_files_overlap_with_required_targets: editedFiles.filter((f) => per.some((t) => pathsMatch(f, t.path))),
    off_target_edit_count: offTarget.length,
    off_target_edits: offTarget,
  });
}

fs.writeFileSync(path.join(RESULTS, "stage5_m69_pivot_confidence_24_live_validation.detail.json"), JSON.stringify(rows, null, 2) + "\n");
console.log(JSON.stringify(rows.map((r) => ({
  inst: r.instance_id, cat: r.category, valid: r.valid_run, invalid: r.invalid_reason, resolved: r.resolved, evaluated: r.evaluated,
  gate: r.pivot_confidence_gate_enabled, marker: r.no_high_confidence_required_marker_present, dem: r.demoted_pivot_count,
  reqImpact: r.required_has_impact, req: r.required_target_count, closed: r.required_target_closed_count,
  open: r.required_target_open_count, ign: r.required_target_ignored_count, inv: r.required_target_invalid_decision_count,
  opt: r.optional_context_target_count, optEd: (r.optional_context_edited as string[]).length, offTgt: r.off_target_edit_count,
  cost: r.cost, m66_res: r.m66_resolved, bl_res: r.baseline_resolved,
})), null, 2));
