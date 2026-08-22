/**
 * M171 — reading one historical live run.
 *
 * Separated from the runner that first used it so that a second analysis can
 * import it without executing a report. The envelope this returns is the one
 * inside the agent's own tool_result block: the authoritative state the agent
 * was actually handed, not a re-capture of it.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { classifyAction, toRepoRelative, type RepositoryAction } from "./m171Consumption";

const RUNS = path.join(path.resolve("."), "benchmarks/stage5_vexp_swe_bench_smoke/results/runs");

export interface LiveRun {
  readonly label: string;
  readonly pipelineOutput: Record<string, unknown> | null;
  readonly pipelineEnvelopeCharacters: number;
  readonly actions: readonly RepositoryAction[];
  readonly goldFiles: readonly string[];
}

/**
 * Read one transcript: the orientation envelope, then every subsequent tool call.
 *
 * A parse failure is reported as a parse failure. M167's permanent rule — parse
 * failure is not semantic absence — means a run whose envelope cannot be read is
 * excluded from a rate, never counted as an unsupported one.
 */
export function readLiveRun(label: string): LiveRun | null {
  const stream = path.join(RUNS, label, "raw", "vtrace", "_agent_stream.first_pass.jsonl");
  if (!existsSync(stream)) return null;

  let pipelineOutput: Record<string, unknown> | null = null;
  let envelopeCharacters = 0;
  let seenPipelineResult = false;
  const actions: RepositoryAction[] = [];
  let order = 0;

  for (const line of readFileSync(stream, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    let row: Record<string, any>;
    try { row = JSON.parse(line) as Record<string, any>; } catch { continue; }

    if (row.type === "user") {
      for (const block of (row.message?.content ?? []) as Record<string, any>[]) {
        if (block.type !== "tool_result" || seenPipelineResult) continue;
        const body = Array.isArray(block.content)
          ? block.content.map((part: Record<string, any>) => String(part.text ?? "")).join("")
          : String(block.content ?? "");
        if (!body.trimStart().startsWith("{")) continue;
        try {
          const envelope = JSON.parse(body) as Record<string, any>;
          if (envelope?.toolId !== "run_pipeline") continue;
          pipelineOutput = (envelope?.result?.output ?? null) as Record<string, unknown> | null;
          envelopeCharacters = body.length;
          seenPipelineResult = true;
        } catch { /* not the envelope */ }
      }
      continue;
    }

    if (row.type !== "assistant") continue;
    for (const block of (row.message?.content ?? []) as Record<string, any>[]) {
      if (block.type !== "tool_use") continue;
      const tool = String(block.name ?? "");
      if (tool.includes("run_pipeline")) continue;
      if (!seenPipelineResult) continue;
      actions.push(classifyAction(tool, (block.input ?? {}) as Record<string, unknown>, order));
      order += 1;
    }
  }

  const evalMeta = path.join(RUNS, label, "raw", "vtrace", "_eval.meta.json");
  let goldFiles: string[] = [];
  if (existsSync(evalMeta)) {
    try {
      const meta = JSON.parse(readFileSync(evalMeta, "utf-8")) as Record<string, any>;
      const patch = String(meta.goldPatch ?? "");
      goldFiles = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => toRepoRelative(match[1]!));
    } catch { goldFiles = []; }
  }

  return { label, pipelineOutput, pipelineEnvelopeCharacters: envelopeCharacters, actions, goldFiles };
}

