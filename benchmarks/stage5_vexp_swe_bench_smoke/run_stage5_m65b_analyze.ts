/**
 * M65B — offline metrics extraction for the 8 live-confirmation treatment runs (reads
 * CAPTURED artifacts only; no agents, no Docker, no spend). For each treatment run it
 * classifies the post-M65 bounded contract (classifyDigestDecisionContract: required
 * PIVOT targets only) and records structured-decision + cost/turn/tool metrics, optional
 * impact-context inspection/edit behaviour, and off-target edits. It then joins the reused
 * baseline + M62C treatment per-case metrics (from the committed JSONs) for the paired
 * comparison, and writes the compact M65B summary JSON.
 *
 * Usage: bun run_stage5_m65b_analyze.ts
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
const M65_JSON = path.join(RESULTS, "stage5_m65_impact_reps_optional_targets.json");

const CONTRACT_START = "<VTRACE_DIGEST_DECISION_CONTRACT_START>";
const CONTRACT_END = "<VTRACE_DIGEST_DECISION_CONTRACT_END>";
const DIGEST_START = "<VTRACE_CAPSULE_V2_DIGEST_START>";

const SELECTED: Array<{ instance_id: string; repo: string; category: string; selection_reason: string; run_label: string }> = [
  { instance_id: "django__django-11740", repo: "django/django", category: "E", selection_reason: "main ignored-target driver in M62C; resolved despite wrong required targets", run_label: "m65b_optional_impact_django__django_11740" },
  { instance_id: "astropy__astropy-14539", repo: "astropy/astropy", category: "B", selection_reason: "invalid/open structured-decision driver", run_label: "m65b_optional_impact_astropy__astropy_14539" },
  { instance_id: "pallets__flask-5014", repo: "pallets/flask", category: "D", selection_reason: "invalid impact-rep rule-out driver", run_label: "m65b_optional_impact_pallets__flask_5014" },
  { instance_id: "sympy__sympy-12481", repo: "sympy/sympy", category: "C", selection_reason: "ignored required-target driver", run_label: "m65b_optional_impact_sympy__sympy_12481" },
  { instance_id: "sympy__sympy-12419", repo: "sympy/sympy", category: "B", selection_reason: "recovered long-query + structured-decision problem case", run_label: "m65b_optional_impact_sympy__sympy_12419" },
  { instance_id: "mwaskom__seaborn-3187", repo: "mwaskom/seaborn", category: "A", selection_reason: "main live stability / resolution-flip case", run_label: "m65b_optional_impact_mwaskom__seaborn_3187" },
  { instance_id: "matplotlib__matplotlib-24627", repo: "matplotlib/matplotlib", category: "A", selection_reason: "treatment-only win safety check", run_label: "m65b_optional_impact_matplotlib__matplotlib_24627" },
  { instance_id: "psf__requests-5414", repo: "psf/requests", category: "E", selection_reason: "baseline-only loss / no-hurt stability check", run_label: "m65b_optional_impact_psf__requests_5414" },
];

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

const m62c = readJson<{ cases: Record<string, unknown>[] }>(M62C_JSON);
const m62cByInst = new Map<string, Record<string, unknown>>();
for (const c of m62c?.cases ?? []) m62cByInst.set(String(c.instance_id), c);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

const rows: Record<string, unknown>[] = [];

for (const sel of SELECTED) {
  const runDir = path.join(RUNS, sel.run_label);
  const raw = path.join(runDir, "raw", "vtrace");
  const snapshot = readText(path.join(runDir, "_vtrace_instructions.snapshot.md"));
  const sweFile = firstGlob(raw, "swebench-");
  const swe = sweFile
    ? readJson<Record<string, unknown>>(sweFile) ?? (() => { const l = readText(sweFile).trim().split("\n").pop(); return l ? JSON.parse(l) as Record<string, unknown> : null; })()
    : null;
  const evalMeta = readJson<Record<string, unknown>>(path.join(raw, "_eval.meta.json"));
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

  const parsed = parseDigestDecisionContract(snapshot);
  const requiredTargets: DigestDecisionTarget[] = parsed.targets.map((t) => ({ kind: t.kind, target: t.target, path: t.path, reason: "" }));
  const clsToolCalls: DigestDecisionToolCall[] = toolCalls.map((t) => ({ category: typeof t.category === "string" ? t.category : "other", path: typeof t.path === "string" ? t.path : null }));
  const agentText = agentTextFrom(raw);
  const cls = classifyDigestDecisionContract({ requiredTargets, toolCalls: clsToolCalls, editedFiles, agentText });
  const per = cls.requiredTargets.map((r) => ({ kind: r.target.kind, target: r.target.target, path: r.target.path, decision: r.decision, inspected: r.inspected, edited: r.edited }));
  const pivots = per.filter((t) => t.kind === "PIVOT");
  const lead = pivots[0] ?? null, hiddenCo = pivots[1] ?? null;

  const optionalCtx = parseOptionalContext(snapshot);
  const optInspected = optionalCtx.filter((o) => toolCalls.some((t) => t.category === "read" && typeof t.path === "string" && pathsMatch(t.path, o.path)));
  const optEdited = optionalCtx.filter((o) => editedFiles.some((f) => pathsMatch(f, o.path)));

  const offTarget = editedFiles.filter((f) => !per.some((t) => pathsMatch(f, t.path)));

  const m62cCase = m62cByInst.get(sel.instance_id) ?? {};

  rows.push({
    instance_id: sel.instance_id,
    repo: sel.repo,
    category: sel.category,
    selection_reason: sel.selection_reason,
    condition: "m65b_optional",
    run_label: sel.run_label,
    baseline_source: m62cCase.baseline_source ?? "reused",
    baseline_run_label: m62cCase.baseline_run_label ?? null,
    baseline_model_match: m62cCase.baseline_model_match ?? null,
    baseline_resolved: m62cCase.baseline_resolved_any ?? null,
    baseline_cost_med: m62cCase.baseline_cost_med ?? null,
    baseline_total_tokens_med: m62cCase.baseline_total_tokens_med ?? null,
    baseline_tool_med: m62cCase.baseline_tool_med ?? null,
    m62c_resolved: m62cCase.resolved ?? null,
    m62c_cost: m62cCase.cost ?? null,
    m62c_total_tokens: m62cCase.total_tokens ?? null,
    m62c_required_target_count: m62cCase.required_target_count ?? null,
    m62c_open: m62cCase.required_target_open_count ?? null,
    m62c_ignored: m62cCase.required_target_ignored_count ?? null,
    m62c_invalid: m62cCase.required_target_invalid_decision_count ?? null,
    // M65B treatment metrics
    valid_run: parsed.present && requiredTargets.length > 0 && !requiredTargets.some((t) => t.kind === "IMPACT") && snapshot.includes(DIGEST_START),
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
    required_target_count: cls.requiredTargetCount,
    required_targets: per.map((t) => `${t.kind} ${t.target}`),
    required_has_impact: per.some((t) => t.kind === "IMPACT"),
    required_target_edited_count: cls.requiredTargetEditedCount,
    required_target_ruled_out_count: cls.requiredTargetRuledOutCount,
    required_target_inspect_only_no_edit_count: cls.requiredTargetInspectOnlyNoEditCount,
    required_target_inspected_only_count: per.filter((t) => t.decision === "INSPECTED_ONLY").length,
    required_target_ignored_count: cls.requiredTargetIgnoredCount,
    required_target_invalid_decision_count: cls.requiredTargetInvalidDecisionCount,
    required_target_closed_count: cls.requiredTargetClosedCount,
    required_target_open_count: cls.requiredTargetOpenCount,
    per_target: per.map((t) => ({ kind: t.kind, target: t.target, decision: t.decision })),
    lead_pivot_path: lead?.path ?? null,
    lead_pivot_inspected: lead?.inspected ?? null,
    lead_pivot_edited: lead?.edited ?? null,
    hidden_or_non_traceback_pivot_present: hiddenCo !== null,
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

fs.writeFileSync(path.join(RESULTS, "stage5_m65b_optional_impact_live_confirmation.detail.json"), JSON.stringify(rows, null, 2));
console.log(JSON.stringify(rows.map((r) => ({
  inst: r.instance_id, valid: r.valid_run, resolved: r.resolved, evaluated: r.evaluated,
  reqImpact: r.required_has_impact, req: r.required_target_count, closed: r.required_target_closed_count,
  open: r.required_target_open_count, ign: r.required_target_ignored_count, inv: r.required_target_invalid_decision_count,
  opt: r.optional_context_target_count, optEd: (r.optional_context_edited as string[]).length, offTgt: r.off_target_edit_count,
  cost: r.cost, m62c_res: r.m62c_resolved, bl_res: r.baseline_resolved,
})), null, 2));
void M65_JSON;
