/**
 * M58B offline metrics extraction + bounded-contract classification.
 *
 * Reads CAPTURED run artifacts (no agent, no Docker, no spend) for a set of
 * (instance, condition, run-label, subdir) tuples and emits one JSON metrics record
 * per run. For contract conditions it runs the M58 classifyDigestDecisionContract
 * (EDIT / RULE_OUT / INSPECT_ONLY_NO_EDIT / INSPECTED_ONLY / IGNORED / INVALID) and
 * the closed/open partition. Targets are parsed from the run's own snapshot, or — for
 * a counterfactual — from `contractSourceLabel`'s snapshot.
 *
 * Usage: bun run_stage5_m58b_analyze.ts <spec.json>  (writes JSON to stdout)
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
const CONTRACT_END = "<VTRACE_DIGEST_DECISION_CONTRACT_END>";
const INSPECT_FIRST = "## VTRACE inspect-first";
const BOUNDED_CHOICE = "decision: EDIT | RULE_OUT | INSPECT_ONLY_NO_EDIT";

interface Spec {
  instance: string;
  condition: string; // baseline | m57_contract | m58_bounded
  runLabel: string;
  subdir: string; // vtrace | baseline
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
function toRepoRelative(p: string): string {
  const m = /\.bench-repos\/[^/]+\/(.+)$/.exec(p) || /workspaces\/[^/]+\/[^/]+\/(.+)$/.exec(p);
  return (m ? m[1]! : p).replace(/^\.\//, "");
}
function pathsMatch(a: string, b: string): boolean {
  const na = toRepoRelative(a);
  const nb = toRepoRelative(b);
  if (na === nb) return true;
  return na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`);
}
function editedFilesFromPatch(patch: string): string[] {
  const files = new Set<string>();
  for (const m of patch.matchAll(/^\+\+\+ b\/(.+)$/gm)) files.add(m[1]!.trim());
  for (const m of patch.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)) files.add(m[1]!.trim());
  return [...files];
}

// Parse the non-numbered "Optional context" bullets from a snapshot's contract block.
function parseOptionalContext(snapshot: string): Array<{ kind: string; target: string; path: string }> {
  const s = snapshot.indexOf(CONTRACT_START);
  const e = snapshot.indexOf(CONTRACT_END);
  if (s < 0 || e < 0) return [];
  const block = snapshot.slice(s, e);
  const out: Array<{ kind: string; target: string; path: string }> = [];
  for (const m of block.matchAll(/^- (PIVOT|IMPACT) (\S+) — optional context only/gm)) {
    const target = m[2]!.trim();
    out.push({ kind: m[1]!, target, path: target.split("::")[0]!.trim() });
  }
  return out;
}

const specPath = process.argv[2];
if (!specPath) throw new Error("usage: bun run_stage5_m58b_analyze.ts <spec.json>");
const specs = readJson<Spec[]>(specPath);
if (!specs) throw new Error(`cannot read spec ${specPath}`);

const out: Record<string, unknown>[] = [];

for (const spec of specs) {
  const raw = path.join(RESULTS, spec.runLabel, "raw", spec.subdir);
  const sweFile = firstGlob(raw, "swebench-");
  const swe = sweFile
    ? readJson<Record<string, unknown>>(sweFile) ?? JSON.parse(readText(sweFile).trim().split("\n").pop()!)
    : null;
  const evalMeta = readJson<Record<string, unknown>>(path.join(raw, "_eval.meta.json"));
  const toolCalls = readJson<Array<Record<string, unknown>>>(path.join(raw, "_tool_calls.json")) ?? [];
  const snapshot = readText(path.join(RESULTS, spec.runLabel, "_vtrace_instructions.snapshot.md"));

  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const inputTokens = num(swe?.inputTokens);
  const outputTokens = num(swe?.outputTokens);
  const cacheRead = num(swe?.cacheReadTokens);
  const cacheWrite = num(swe?.cacheCreationTokens);
  const totalTokens = inputTokens + outputTokens + cacheRead + cacheWrite;
  const modelPatch = typeof swe?.modelPatch === "string" ? (swe.modelPatch as string) : "";
  const resolved = swe?.resolved === true || evalMeta?.resolvedCount === 1;

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

  const digestPresent = snapshot.includes(DIGEST_START);
  const ownContract = parseDigestDecisionContract(snapshot);
  const contractPresent = ownContract.present;
  const impactPresent = /→ impact/.test(snapshot);
  const boundedPresent = snapshot.includes(BOUNDED_CHOICE);
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
    bounded_contract_present: boundedPresent,
    compact_mode_applied: compactApplied,
    edited_files: editedFiles,
  };

  // Choose contract targets: own snapshot, or counterfactual source.
  let classifyTargets = ownContract.targets;
  let optionalCtx = parseOptionalContext(snapshot);
  let counterfactual = false;
  if (spec.contractSourceLabel) {
    const srcSnap = readText(path.join(RESULTS, spec.contractSourceLabel, "_vtrace_instructions.snapshot.md"));
    const src = parseDigestDecisionContract(srcSnap);
    if (src.present && src.targets.length > 0) {
      classifyTargets = src.targets;
      optionalCtx = parseOptionalContext(srcSnap);
      counterfactual = true;
    }
  }

  if (spec.condition !== "baseline" && classifyTargets.length > 0) {
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
    let agentText = "";
    for (const line of readText(path.join(raw, "_agent_stream.first_pass.jsonl")).split("\n")) {
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
    const cls = classifyDigestDecisionContract({ requiredTargets, toolCalls: clsToolCalls, editedFiles, agentText });
    const perTarget = cls.requiredTargets.map((r) => ({
      kind: r.target.kind,
      target: r.target.target,
      path: r.target.path,
      decision: r.decision,
      inspected: r.inspected,
      edited: r.edited,
    }));
    const pivots = perTarget.filter((t) => t.kind === "PIVOT");
    const impacts = perTarget.filter((t) => t.kind === "IMPACT");
    const lead = pivots[0] ?? null;
    const hiddenCo = pivots[1] ?? null;

    // Optional-context exploration: was an optional target read/edited?
    const optInspected = optionalCtx.filter((o) =>
      toolCalls.some((t) => t.category === "read" && typeof t.path === "string" && pathsMatch(t.path, o.path)),
    );
    const optEdited = optionalCtx.filter((o) => editedFiles.some((f) => pathsMatch(f, o.path)));

    Object.assign(base, {
      contract_classification_counterfactual: counterfactual,
      required_target_count: cls.requiredTargetCount,
      required_targets: perTarget.map((t) => `${t.kind} ${t.target}`),
      required_target_edited_count: cls.requiredTargetEditedCount,
      required_target_ruled_out_count: cls.requiredTargetRuledOutCount,
      required_target_inspect_only_no_edit_count: cls.requiredTargetInspectOnlyNoEditCount,
      required_target_inspected_only_count: perTarget.filter((t) => t.decision === "INSPECTED_ONLY").length,
      required_target_ignored_count: cls.requiredTargetIgnoredCount,
      required_target_invalid_decision_count: cls.requiredTargetInvalidDecisionCount,
      required_target_closed_count: cls.requiredTargetClosedCount,
      required_target_open_count: cls.requiredTargetOpenCount,
      per_target: perTarget,
      lead_pivot_path: lead?.path ?? null,
      lead_pivot_inspected: lead?.inspected ?? null,
      lead_pivot_edited: lead?.edited ?? null,
      hidden_or_non_traceback_pivot_present: hiddenCo !== null,
      hidden_or_non_traceback_pivot_inspected: hiddenCo?.inspected ?? null,
      hidden_or_non_traceback_pivot_edited: hiddenCo?.edited ?? null,
      impact_representative_paths: impacts.map((t) => t.path),
      impact_representative_inspected: impacts.map((t) => t.inspected),
      impact_representative_edited: impacts.map((t) => t.edited),
      optional_context_targets: optionalCtx.map((o) => `${o.kind} ${o.target}`),
      optional_context_inspected: optInspected.map((o) => o.path),
      optional_context_edited: optEdited.map((o) => o.path),
      edited_files_overlap_with_required_targets: editedFiles.filter((f) =>
        perTarget.some((t) => pathsMatch(f, t.path)),
      ),
      edited_files_overlap_with_pivots: editedFiles.filter((f) => pivots.some((t) => pathsMatch(f, t.path))),
      edited_files_overlap_with_impact: editedFiles.filter((f) => impacts.some((t) => pathsMatch(f, t.path))),
      edited_files_outside_required_targets: editedFiles.filter(
        (f) => !perTarget.some((t) => pathsMatch(f, t.path)),
      ),
    });
  }

  out.push(base);
}

console.log(JSON.stringify(out, null, 2));
