/**
 * M66 — offline metrics extraction for the 24 frozen-set live treatment runs (reads
 * CAPTURED artifacts only; no agents, no Docker, no spend). Reuses the EXACT M65B/M65C
 * classifier (classifyDigestDecisionContract: required PIVOT targets only) and the same
 * treatment-validity gates. Joins the reused baseline + M62C treatment per-case metrics
 * (from committed JSONs) for paired comparison, and writes the M66 per-case detail JSON.
 *
 * Usage: bun run_stage5_m66_analyze.ts [--fixture path]
 */
import fs from "node:fs";
import path from "node:path";
import {
  parseDigestDecisionContract,
  classifyDigestDecisionContract,
  type DigestDecisionTarget,
  type DigestDecisionToolCall,
} from "../../src/capsuleV2/digestDecisionContract.ts";

const RESULTS = "benchmarks/stage5_vexp_swe_bench_smoke/results";
const RUNS = path.join(RESULTS, "runs");
const M62C_JSON = path.join(RESULTS, "stage5_m62c_structured_bounded_24_live_validation.json");
function flag(name: string, fb: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fb;
}
const FIXTURE = flag("--fixture", path.join(RESULTS, "stage5_m62_structured_bounded_24_preregistration.json"));

const CONTRACT_START = "<VTRACE_DIGEST_DECISION_CONTRACT_START>";
const CONTRACT_END = "<VTRACE_DIGEST_DECISION_CONTRACT_END>";
const DIGEST_START = "<VTRACE_CAPSULE_V2_DIGEST_START>";
const DIGEST_END = "<VTRACE_CAPSULE_V2_DIGEST_END>";

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
function parseOptionalContext(snapshot: string): Array<{ kind: string; target: string; path: string }> {
  const s = snapshot.indexOf(CONTRACT_START), e = snapshot.indexOf(CONTRACT_END);
  if (s < 0 || e < 0) return [];
  const block = snapshot.slice(s, e);
  const out: Array<{ kind: string; target: string; path: string }> = [];
  for (const m of block.matchAll(/^- (?:O\d+: )?(PIVOT|IMPACT) (\S+) — optional context only/gm)) {
    out.push({ kind: m[1]!, target: m[2]!.trim(), path: m[2]!.split("::")[0]!.trim() });
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
const m62c = readJson<{ cases: Record<string, unknown>[] }>(M62C_JSON);
const m62cByInst = new Map<string, Record<string, unknown>>();
for (const c of m62c?.cases ?? []) m62cByInst.set(String(c.instance_id), c);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

const rows: Record<string, unknown>[] = [];

for (const fi of fixture.instances) {
  const runLabel = `m66_optional_impact_24_${fi.safe}`;
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

  // treatment-validity gates (M66) on the injected snapshot
  const digestStart = countOcc(snapshot, DIGEST_START), digestEnd = countOcc(snapshot, DIGEST_END);
  const contractStart = countOcc(snapshot, CONTRACT_START), contractEnd = countOcc(snapshot, CONTRACT_END);
  const digestPresent = digestStart === 1 && digestEnd === 1;
  const decisionContractPresent = contractStart === 1 && contractEnd === 1;
  const cBlock = snapshot.slice(Math.max(0, snapshot.indexOf(CONTRACT_START)), snapshot.indexOf(CONTRACT_END) + CONTRACT_END.length);
  const grammarPresent = /target_id:/.test(cBlock) && /decision:/.test(cBlock) && /reason:/.test(cBlock) &&
    /files_touched:/.test(cBlock) && /EDIT/.test(cBlock) && /RULE_OUT/.test(cBlock) && /INSPECT_ONLY_NO_EDIT/.test(cBlock);
  const impactPresent = /→ impact/.test(snapshot.slice(snapshot.indexOf(DIGEST_START), snapshot.indexOf(DIGEST_END) + 1));
  const requiredIds = [...cBlock.matchAll(/target_id: (T\d+)/g)].map((m) => m[1]!);
  const optionalIds = [...cBlock.matchAll(/^- (O\d+):/gm)].map((m) => m[1]!);
  const optionalSectionPresent = /Optional context \/ FYI impact references/.test(cBlock);
  const optionalImpactContextPresent = optionalSectionPresent && optionalIds.length > 0;
  const optionalNotClosureScored = /not closure-scored/i.test(cBlock);
  const idsCollide = optionalIds.some((id) => requiredIds.includes(id)) ||
    requiredIds.some((id) => /^O/.test(id)) || optionalIds.some((id) => /^T/.test(id));
  const compactModeApplied = countOcc(snapshot, "## VTRACE inspect-first") === 0;

  const parsed = parseDigestDecisionContract(snapshot);
  const requiredTargets: DigestDecisionTarget[] = parsed.targets.map((t) => ({ kind: t.kind, target: t.target, path: t.path, reason: "" }));
  const requiredHasImpactInContract = requiredTargets.some((t) => t.kind === "IMPACT");
  const optionalCtx = parseOptionalContext(snapshot);
  const impactRepsExist = optionalCtx.some((o) => o.kind === "IMPACT");

  let invalidReason: string | null = null;
  if (!digestPresent) invalidReason = "m66_digest_not_present";
  else if (!decisionContractPresent) invalidReason = "m66_decision_contract_not_present";
  else if (!impactPresent) invalidReason = "m66_impact_not_enriched";
  else if (!grammarPresent) invalidReason = "m66_structured_grammar_not_present";
  else if (!(requiredTargets.length > 0)) invalidReason = "m66_required_targets_missing";
  else if (requiredTargets.length > 4) invalidReason = "m66_required_target_cap_exceeded";
  else if (requiredHasImpactInContract) invalidReason = "m66_required_impact_target_present";
  else if (impactRepsExist && !optionalImpactContextPresent) invalidReason = "m66_optional_impact_context_missing";
  else if (idsCollide) invalidReason = "m66_optional_ids_collide_with_required_ids";
  else if (!compactModeApplied) invalidReason = "m66_compact_mode_not_applied";
  else if (modelPatch.length === 0) invalidReason = "m66_fail_closed_omitted";
  const validRun = invalidReason === null;

  const clsToolCalls: DigestDecisionToolCall[] = toolCalls.map((t) => ({ category: typeof t.category === "string" ? t.category : "other", path: typeof t.path === "string" ? t.path : null }));
  const agentText = agentTextFrom(raw);
  const cls = classifyDigestDecisionContract({ requiredTargets, toolCalls: clsToolCalls, editedFiles, agentText });
  const per = cls.requiredTargets.map((r) => ({ kind: r.target.kind, target: r.target.target, path: r.target.path, decision: r.decision, inspected: r.inspected, edited: r.edited }));
  const pivots = per.filter((t) => t.kind === "PIVOT");
  const lead = pivots[0] ?? null, hiddenCo = pivots[1] ?? null;

  const optInspected = optionalCtx.filter((o) => toolCalls.some((t) => t.category === "read" && typeof t.path === "string" && pathsMatch(t.path, o.path)));
  const optEdited = optionalCtx.filter((o) => editedFiles.some((f) => pathsMatch(f, o.path)));
  const offTarget = editedFiles.filter((f) => !per.some((t) => pathsMatch(f, t.path)));

  const m62cCase = m62cByInst.get(fi.instance_id) ?? {};
  const coverage = cls.requiredTargetCount > 0 ? cls.requiredTargetClosedCount / cls.requiredTargetCount : 0;
  const ignoredRate = cls.requiredTargetCount > 0 ? cls.requiredTargetIgnoredCount / cls.requiredTargetCount : 0;

  rows.push({
    instance_id: fi.instance_id,
    repo: fi.repo,
    category: fi.category,
    selection_reason: fi.selection_reason,
    condition: "m66_optional",
    run_label: runLabel,
    // comparators
    baseline_source: m62cCase.baseline_source ?? "reused",
    baseline_run_label: m62cCase.baseline_run_label ?? fi.baseline_label_hint ?? null,
    baseline_model_match: m62cCase.baseline_model_match ?? null,
    baseline_resolved: m62cCase.baseline_resolved_any ?? null,
    baseline_resolved_frac: m62cCase.baseline_resolved_frac ?? null,
    baseline_cost_med: m62cCase.baseline_cost_med ?? null,
    baseline_total_tokens_med: m62cCase.baseline_total_tokens_med ?? null,
    baseline_cache_read_med: m62cCase.baseline_cache_read_med ?? null,
    baseline_tool_med: m62cCase.baseline_tool_med ?? null,
    m62c_resolved: m62cCase.resolved ?? null,
    m62c_cost: m62cCase.cost ?? null,
    m62c_total_tokens: m62cCase.total_tokens ?? null,
    m62c_cache_read: m62cCase.cache_read_tokens_total ?? null,
    m62c_tool_call_count: m62cCase.tool_call_count ?? null,
    m62c_required_target_count: m62cCase.required_target_count ?? null,
    m62c_closed: m62cCase.required_target_closed_count ?? null,
    m62c_open: m62cCase.required_target_open_count ?? null,
    m62c_ignored: m62cCase.required_target_ignored_count ?? null,
    m62c_invalid: m62cCase.required_target_invalid_decision_count ?? null,
    m62c_off_target_edit_count: m62cCase.off_target_edit_count ?? null,
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
    query_truncated: runMeta?.vtraceQueryTruncated ?? null,
    query_original_chars: runMeta?.vtraceQueryOriginalChars ?? null,
    required_impact_target_count: requiredTargets.filter((t) => t.kind === "IMPACT").length,
    optional_impact_context_present: optionalImpactContextPresent,
    optional_impact_id_count: optionalIds.length,
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
    // structured decision
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
    optional_context_target_count: optionalCtx.length,
    optional_context_targets: optionalCtx.map((o) => `${o.kind} ${o.target}`),
    optional_context_inspected: optInspected.map((o) => o.path),
    optional_context_edited: optEdited.map((o) => o.path),
    edited_files: editedFiles,
    edited_files_overlap_with_pivots: editedFiles.filter((f) => pivots.some((t) => pathsMatch(f, t.path))),
    edited_files_overlap_with_required_targets: editedFiles.filter((f) => per.some((t) => pathsMatch(f, t.path))),
    off_target_edit_count: offTarget.length,
    off_target_edits: offTarget,
  });
}

fs.writeFileSync(path.join(RESULTS, "stage5_m66_optional_impact_24_live_validation.detail.json"), JSON.stringify(rows, null, 2) + "\n");
console.log(JSON.stringify(rows.map((r) => ({
  inst: r.instance_id, cat: r.category, valid: r.valid_run, invalid: r.invalid_reason, resolved: r.resolved, evaluated: r.evaluated,
  reqImpact: r.required_has_impact, req: r.required_target_count, closed: r.required_target_closed_count,
  open: r.required_target_open_count, ign: r.required_target_ignored_count, inv: r.required_target_invalid_decision_count,
  opt: r.optional_context_target_count, optEd: (r.optional_context_edited as string[]).length, offTgt: r.off_target_edit_count,
  cost: r.cost, m62c_res: r.m62c_resolved, bl_res: r.baseline_resolved,
})), null, 2));
