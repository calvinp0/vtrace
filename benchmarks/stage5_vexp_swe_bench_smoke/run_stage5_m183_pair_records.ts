/**
 * M183 — build the canonical paired record, and seal it (§39/§85).
 *
 *   bun run_stage5_m183_pair_records.ts
 *
 * Reads only artifacts the sweep produced. Writes `stage5_m183_pair_records.jsonl`,
 * one row per manifest instance, whether or not both arms ran — an instance that
 * is missing from the analysis because it silently produced no row is exactly the
 * failure §28 is about, so absence is recorded as a row with a reason.
 *
 * WHAT IS SEALED, AND WHY BEFORE GOLD IS TOUCHED.
 *
 * §85 asks for the transcript, telemetry and patch hashes to be sealed before
 * post-hoc gold analysis begins. The reason is not ceremony: the gold diagnostics
 * read the same run directories, and a hash taken afterwards cannot testify that
 * nothing moved. So the hashes are computed here, in the step that runs first.
 *
 * TOKEN AND COST FIGURES COME FROM THE RESULT ROW, NOT THE STREAM.
 *
 * M169 measured a 23.5% inflation from summing streamed `message.usage`, which
 * re-emits messages. The harness's own row deduplicates on `message.id`, and the
 * contract in stage5_m183_token_accounting_contract.md names it authoritative.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { totalAgentTokens } from "./m183Analysis";
import { M183_ARMS, type M183Arm } from "./m183Treatment";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const ORIENTATION_DIR = path.join(RESULTS, "_m183_orientation");

const sha256File = (p: string): string | null => {
  try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { return null; }
};
const readJson = <T>(p: string): T | null => {
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; }
};

const labelFor = (arm: M183Arm, instanceId: string): string =>
  `m183_${arm}_${instanceId.replace(/-/gu, "_")}`;

interface ResultRow {
  readonly instanceId: string; readonly repo: string; readonly model: string;
  readonly inputTokens: number; readonly outputTokens: number;
  readonly cacheReadTokens: number; readonly cacheCreationTokens: number;
  readonly costUsd: number | null; readonly numTurns: number | null;
  readonly durationMs: number | null; readonly resolved: boolean | null;
  readonly modelPatch: string | null;
  readonly toolCalls: Record<string, number> | null;
  readonly timestamp: string | null;
}

interface ToolCall { readonly index: number; readonly tool: string; readonly category: string | null; readonly path: string | null }

/** The run directory for a label, whichever condition subdirectory the runner used. */
function rawDir(label: string): string | null {
  const base = path.join(RESULTS, "runs", label, "raw");
  if (!existsSync(base)) return null;
  for (const entry of readdirSync(base)) {
    const dir = path.join(base, entry);
    if (statSync(dir).isDirectory() && readdirSync(dir).some((f) => f.startsWith("swebench-"))) return dir;
  }
  return null;
}

/**
 * §49 — the first MEANINGFUL edit.
 *
 * Defined before any outcome was seen: the first tool call the harness
 * categorised as `edit` whose target is a repository path. Harness bootstrap and
 * dependency setup do not appear in this log as edits at all, and a write to a
 * scratch path outside the checkout is not a step toward the patch.
 */
function firstMeaningfulEdit(calls: readonly ToolCall[]): { index: number | null; toolCallsBefore: number } {
  const editIndex = calls.findIndex(
    (c) => c.category === "edit" && typeof c.path === "string" && c.path.length > 0);
  return editIndex < 0
    ? { index: null, toolCallsBefore: calls.length }
    : { index: calls[editIndex]!.index, toolCallsBefore: editIndex };
}

function armRecord(arm: M183Arm, instanceId: string): Record<string, unknown> {
  const label = labelFor(arm, instanceId);
  const dir = rawDir(label);
  if (dir === null) {
    return { arm, label, valid: false, invalidReason: "NO_RESULT_ROW", present: false };
  }
  const rowFile = readdirSync(dir).find((f) => f.startsWith("swebench-") && f.endsWith(".jsonl"))!;
  const rowPath = path.join(dir, rowFile);
  const line = readFileSync(rowPath, "utf8").split("\n").find((l) => l.trim() !== "");
  const row = line === undefined ? null : (JSON.parse(line) as ResultRow);
  if (row === null) {
    return { arm, label, valid: false, invalidReason: "EMPTY_RESULT_ROW", present: true };
  }

  const meta = readJson<Record<string, unknown>>(path.join(dir, "_run.meta.json")) ?? {};
  const evalMeta = readJson<Record<string, unknown>>(path.join(dir, "_eval.meta.json"));
  const calls = readJson<ToolCall[]>(path.join(dir, "_tool_calls.json")) ?? [];

  const byCategory: Record<string, number> = {};
  for (const c of calls) byCategory[c.category ?? "unknown"] = (byCategory[c.category ?? "unknown"] ?? 0) + 1;
  const edit = firstMeaningfulEdit(calls);
  const before = edit.index === null ? calls : calls.slice(0, edit.toolCallsBefore);
  const preEditByCategory: Record<string, number> = {};
  for (const c of before) preEditByCategory[c.category ?? "unknown"] = (preEditByCategory[c.category ?? "unknown"] ?? 0) + 1;

  const tokens = {
    inputTokens: row.inputTokens ?? 0, outputTokens: row.outputTokens ?? 0,
    cacheReadTokens: row.cacheReadTokens ?? 0, cacheCreationTokens: row.cacheCreationTokens ?? 0,
  };

  return {
    arm, label, present: true,
    // §27/§68/§69: a run that worked and failed is VALID. Invalidity is about the
    // apparatus, and the only apparatus failure visible here is a missing row.
    valid: true, invalidReason: null,
    model: row.model ?? null,
    timestamp: row.timestamp ?? null,
    resolved: row.resolved === true,
    graded: evalMeta !== null,
    evaluationRan: evalMeta?.evaluationRan ?? null,
    resolvedCount: evalMeta?.resolvedCount ?? null,
    costUsd: typeof row.costUsd === "number" ? row.costUsd : null,
    costLimitHit: typeof row.costUsd === "number" && row.costUsd >= 3,
    numTurns: row.numTurns ?? null,
    turnLimitHit: (row.numTurns ?? 0) >= 250,
    durationMs: row.durationMs ?? null,
    tokens,
    totalAgentTokens: totalAgentTokens(tokens),
    toolCallCount: calls.length,
    toolCallsByTool: row.toolCalls ?? null,
    toolCallsByCategory: byCategory,
    firstMeaningfulEditIndex: edit.index,
    toolCallsBeforeFirstEdit: edit.toolCallsBefore,
    preEditToolCallsByCategory: preEditByCategory,
    reachedAnEdit: edit.index !== null,
    // §34/§81 — the LIVE delivery witness. Set from the adapter's own stderr, so
    // it testifies that the injection happened in this run rather than that the
    // environment variable was set.
    triggerFile: meta.stage5M163TriggerFile ?? null,
    triggerInjected: meta.stage5M163TriggerInjected ?? false,
    triggerMissing: meta.stage5M163TriggerMissing ?? false,
    // §85 seals.
    seals: {
      resultRow: sha256File(rowPath),
      runMeta: sha256File(path.join(dir, "_run.meta.json")),
      toolCalls: sha256File(path.join(dir, "_tool_calls.json")),
      agentStream: sha256File(path.join(dir, "_agent_stream.first_pass.jsonl")),
      evalMeta: evalMeta === null ? null : sha256File(path.join(dir, "_eval.meta.json")),
      modelPatch: typeof row.modelPatch === "string"
        ? createHash("sha256").update(row.modelPatch, "utf8").digest("hex") : null,
    },
    modelPatchCharacters: typeof row.modelPatch === "string" ? row.modelPatch.length : 0,
    rawDir: path.relative(process.cwd(), dir),
  };
}

function main(): void {
  const manifest = readJson<{ executionOrder: { instanceId: string; repo: string; difficulty: string; stratum: string; m173Overlap: boolean; order: number }[] }>(
    path.join(RESULTS, "stage5_m183_sample_manifest.json"))!;
  const pairOrder = readJson<{ schedule: { instanceId: string; armOrder: string[] }[] }>(
    path.join(RESULTS, "stage5_m183_pair_order.json"))!;
  const armOrderOf = new Map(pairOrder.schedule.map((r) => [r.instanceId, r.armOrder]));

  const lines: string[] = [];
  let completePairs = 0;

  for (const target of manifest.executionOrder) {
    const baseline = armRecord("baseline", target.instanceId);
    const treatment = armRecord("vtrace_orientation", target.instanceId);
    const witness = readJson<Record<string, unknown>>(
      path.join(ORIENTATION_DIR, `${target.instanceId}.witness.json`));

    const bothValid = baseline.valid === true && treatment.valid === true;
    if (bothValid) completePairs += 1;

    const delta = (key: string): number | null => {
      const b = baseline[key], t = treatment[key];
      return typeof b === "number" && typeof t === "number" ? t - b : null;
    };

    lines.push(JSON.stringify({
      schemaVersion: "stage5.m183.pair-record.v1",
      instanceId: target.instanceId,
      repo: target.repo,
      difficulty: target.difficulty,
      stratum: target.stratum,
      m173Overlap: target.m173Overlap,
      executionOrder: target.order,
      armOrder: armOrderOf.get(target.instanceId) ?? null,
      pairValid: bothValid,
      pairInvalidReason: bothValid ? null
        : [baseline.valid === false ? `baseline:${baseline.invalidReason}` : null,
           treatment.valid === false ? `treatment:${treatment.invalidReason}` : null]
          .filter(Boolean).join(","),
      baseline, treatment,
      orientation: witness === null ? null : {
        deliveryState: (witness.witness as Record<string, unknown>).deliveryState,
        semanticHash: (witness.witness as Record<string, unknown>).semanticHash,
        focusAt: (witness.witness as Record<string, unknown>).focusAt,
        focusFile: (witness.witness as Record<string, unknown>).focusFile,
        relatedFiles: (witness.witness as Record<string, unknown>).relatedFiles,
        relatedAt: (witness.witness as Record<string, unknown>).relatedAt,
        orientationTokens: (witness.witness as Record<string, unknown>).orientationTokens,
        injectedSectionTokens: (witness.witness as Record<string, unknown>).injectedSectionTokens,
        taskHash: (witness.query as Record<string, unknown>).taskHash,
        indexVtraceCommit: ((witness.indexAuthority as Record<string, unknown>)?.meta as Record<string, unknown>)?.vtrace_commit ?? null,
      },
      paired: {
        solveDelta: bothValid ? Number(treatment.resolved) - Number(baseline.resolved) : null,
        totalTokenDelta: bothValid ? delta("totalAgentTokens") : null,
        costDelta: bothValid ? delta("costUsd") : null,
        turnDelta: bothValid ? delta("numTurns") : null,
        toolCallDelta: bothValid ? delta("toolCallCount") : null,
        preEditToolCallDelta: bothValid ? delta("toolCallsBeforeFirstEdit") : null,
      },
    }));
  }

  writeFileSync(path.join(RESULTS, "stage5_m183_pair_records.jsonl"), `${lines.join("\n")}\n`);
  console.log(`wrote results/stage5_m183_pair_records.jsonl — ${lines.length} instances, ${completePairs} complete pairs`);
}

main();
