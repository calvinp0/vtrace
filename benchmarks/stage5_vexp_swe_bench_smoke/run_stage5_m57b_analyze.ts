/**
 * M57B offline metrics extraction + decision-contract classification.
 *
 * Reads CAPTURED run artifacts (no agent, no Docker, no spend) for a set of
 * (instance, condition, run-label, subdir) tuples and emits one JSON metrics record
 * per run, including the M57 decision-contract classification
 * (classifyDigestDecisionContract) for treatment runs.
 *
 * Usage: bun run_stage5_m57b_analyze.ts <spec.json>  (writes JSON to stdout)
 *   spec.json: [{ instance, condition, runLabel, subdir }]
 */
import fs from "node:fs";
import path from "node:path";
import {
  parseDigestDecisionContract,
  classifyDigestDecisionContract,
  type DigestDecisionTarget,
  type DigestDecisionToolCall,
} from "../../src/capsuleV2/digestDecisionContract.ts";

const RESULTS = "benchmarks/stage5_vexp_swe_bench_smoke/results/runs";
const DIGEST_START = "<VTRACE_CAPSULE_V2_DIGEST_START>";
const CONTRACT_START = "<VTRACE_DIGEST_DECISION_CONTRACT_START>";
const INSPECT_FIRST = "## VTRACE inspect-first";

interface Spec {
  instance: string;
  condition: string;
  runLabel: string;
  subdir: string; // "vtrace" | "baseline"
  /**
   * Optional: classify this run's artifacts against the decision-contract targets
   * parsed from ANOTHER run's snapshot (counterfactual — used to ask "how would the
   * M57 contract have scored the M56C impact run, which never saw the contract").
   */
  contractSourceLabel?: string;
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}
function readText(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
function firstGlob(dir: string, prefix: string): string | null {
  try {
    const f = fs.readdirSync(dir).find((n) => n.startsWith(prefix));
    return f ? path.join(dir, f) : null;
  } catch {
    return null;
  }
}

// Repo-relative path (strip workspace prefix) — mirror the classifier's helper.
function toRepoRelative(p: string): string {
  const m = /\.bench-repos\/[^/]+\/(.+)$/.exec(p) || /workspaces\/[^/]+\/[^/]+\/(.+)$/.exec(p);
  return (m ? m[1]! : p).replace(/^\.\//, "");
}

function editedFilesFromPatch(patch: string): string[] {
  const files = new Set<string>();
  for (const m of patch.matchAll(/^\+\+\+ b\/(.+)$/gm)) files.add(m[1]!.trim());
  for (const m of patch.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)) files.add(m[1]!.trim());
  return [...files];
}

function pathsMatch(a: string, b: string): boolean {
  const na = toRepoRelative(a);
  const nb = toRepoRelative(b);
  if (na === nb) return true;
  return na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`);
}

const specPath = process.argv[2];
if (!specPath) throw new Error("usage: bun run_stage5_m57b_analyze.ts <spec.json>");
const specs = readJson<Spec[]>(specPath);
if (!specs) throw new Error(`cannot read spec ${specPath}`);

const out: Record<string, unknown>[] = [];

for (const spec of specs) {
  const raw = path.join(RESULTS, spec.runLabel, "raw", spec.subdir);
  const sweFile = firstGlob(raw, "swebench-");
  const swe = sweFile ? (readJson<Record<string, unknown>>(sweFile) ?? JSON.parse(readText(sweFile).trim().split("\n").pop()!)) : null;
  const evalMeta = readJson<Record<string, unknown>>(path.join(raw, "_eval.meta.json"));
  const toolCalls = readJson<Array<Record<string, unknown>>>(path.join(raw, "_tool_calls.json")) ?? [];
  const snapshot = readText(path.join(RESULTS, spec.runLabel, "_vtrace_instructions.snapshot.md"));

  // --- token / cost / outcome ---
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const inputTokens = num(swe?.inputTokens);
  const outputTokens = num(swe?.outputTokens);
  const cacheRead = num(swe?.cacheReadTokens);
  const cacheWrite = num(swe?.cacheCreationTokens);
  const totalTokens = inputTokens + outputTokens + cacheRead + cacheWrite;
  const modelPatch = typeof swe?.modelPatch === "string" ? (swe.modelPatch as string) : "";
  const resolved = swe?.resolved === true || evalMeta?.resolvedCount === 1;

  // --- tool-call breakdown ---
  const cat = (c: string) => toolCalls.filter((t) => t.category === c);
  const reads = cat("read");
  const searches = cat("search");
  const edits = cat("edit");
  const readPaths = reads.map((t) => (typeof t.path === "string" ? t.path : "")).filter(Boolean);
  const seen = new Set<string>();
  let repeatedReads = 0;
  for (const p of readPaths) {
    if (seen.has(p)) repeatedReads += 1;
    else seen.add(p);
  }

  // --- digest / contract / impact presence (from the faithful injected snapshot) ---
  const digestPresent = snapshot.includes(DIGEST_START);
  const contractParsed = parseDigestDecisionContract(snapshot);
  const contractPresent = contractParsed.present;
  const impactPresent = /→ impact/.test(snapshot);
  const compactApplied = digestPresent && !snapshot.includes(INSPECT_FIRST);

  const editedFiles = editedFilesFromPatch(modelPatch);

  const base: Record<string, unknown> = {
    instance_id: spec.instance,
    condition: spec.condition,
    run_label: spec.runLabel,
    patch_produced: modelPatch.length > 0,
    resolved,
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
    repeated_file_reads: repeatedReads,
    digest_present: digestPresent,
    impact_present: impactPresent,
    decision_contract_present: contractPresent,
    compact_mode_applied: compactApplied,
    edited_files: editedFiles,
  };

  // Decision-contract classification. Targets come from this run's own snapshot
  // (m57_contract) or, for a counterfactual, from contractSourceLabel's snapshot.
  let classifyTargets = contractParsed.targets;
  let counterfactual = false;
  if (spec.contractSourceLabel) {
    const srcSnap = readText(path.join(RESULTS, spec.contractSourceLabel, "_vtrace_instructions.snapshot.md"));
    const srcContract = parseDigestDecisionContract(srcSnap);
    if (srcContract.present && srcContract.targets.length > 0) {
      classifyTargets = srcContract.targets;
      counterfactual = true;
    }
  }
  if ((spec.condition === "m57_contract" && contractPresent) || counterfactual) {
    // Build DigestDecisionTarget[] from the parsed contract (classifier uses path + target only).
    const requiredTargets: DigestDecisionTarget[] = classifyTargets.map((t) => ({
      kind: t.kind,
      target: t.target,
      path: t.path,
      reason: "",
    }));
    const clsToolCalls: DigestDecisionToolCall[] = toolCalls.map((t) => ({
      category: typeof t.category === "string" ? t.category : "other",
      path: typeof t.path === "string" ? t.path : null,
    }));
    // agent final text: concatenate the result.result + all assistant text blocks.
    const streamPath = path.join(raw, "_agent_stream.first_pass.jsonl");
    let agentText = "";
    for (const line of readText(streamPath).split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        if (o.type === "result" && typeof o.result === "string") agentText += "\n" + o.result;
        if (o.type === "assistant") {
          const content = (o.message as Record<string, unknown> | undefined)?.content;
          if (Array.isArray(content)) {
            for (const blk of content) {
              if (blk && typeof blk === "object" && (blk as Record<string, unknown>).type === "text") {
                agentText += "\n" + String((blk as Record<string, unknown>).text ?? "");
              }
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
    const cls = classifyDigestDecisionContract({
      requiredTargets,
      toolCalls: clsToolCalls,
      editedFiles,
      agentText,
    });
    const perTarget = cls.requiredTargets.map((r) => ({
      kind: r.target.kind,
      target: r.target.target,
      path: r.target.path,
      decision: r.decision,
      inspected: r.inspected,
      edited: r.edited,
    }));

    const pivotTargets = perTarget.filter((t) => t.kind === "PIVOT");
    const impactTargets = perTarget.filter((t) => t.kind === "IMPACT");
    const lead = pivotTargets[0] ?? null;
    const hiddenCo = pivotTargets[1] ?? null; // 2nd pivot = hidden/non-traceback co-pivot

    Object.assign(base, {
      contract_classification_counterfactual: counterfactual,
      required_target_count: cls.requiredTargetCount,
      required_targets: perTarget.map((t) => `${t.kind} ${t.target}`),
      required_target_inspected_count: perTarget.filter((t) => t.inspected).length,
      required_target_edited_count: cls.requiredTargetEditedCount,
      required_target_ruled_out_count: cls.requiredTargetRuledOutCount,
      required_target_ignored_count: cls.requiredTargetIgnoredCount,
      required_target_invalid_decision_count: cls.requiredTargetInvalidDecisionCount,
      required_target_edited_without_inspection_count: cls.requiredTargetEditedWithoutInspectionCount,
      required_target_inspected_only_count: perTarget.filter((t) => t.decision === "INSPECTED_ONLY").length,
      per_target: perTarget,
      lead_pivot_path: lead?.path ?? null,
      lead_pivot_inspected: lead?.inspected ?? null,
      lead_pivot_edited: lead?.edited ?? null,
      hidden_or_non_traceback_pivot_present: hiddenCo !== null,
      hidden_or_non_traceback_pivot_inspected: hiddenCo?.inspected ?? null,
      hidden_or_non_traceback_pivot_edited: hiddenCo?.edited ?? null,
      impact_representative_paths: impactTargets.map((t) => t.path),
      impact_representative_inspected: impactTargets.map((t) => t.inspected),
      impact_representative_edited: impactTargets.map((t) => t.edited),
      edited_files_overlap_with_required_targets: editedFiles.filter((f) =>
        perTarget.some((t) => pathsMatch(f, t.path)),
      ),
      edited_files_overlap_with_pivots: editedFiles.filter((f) =>
        pivotTargets.some((t) => pathsMatch(f, t.path)),
      ),
      edited_files_overlap_with_impact: editedFiles.filter((f) =>
        impactTargets.some((t) => pathsMatch(f, t.path)),
      ),
    });
  }

  out.push(base);
}

console.log(JSON.stringify(out, null, 2));
