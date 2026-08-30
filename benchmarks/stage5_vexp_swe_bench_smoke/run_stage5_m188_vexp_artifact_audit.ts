/**
 * M188 — VEXP published-artifact audit (offline; no agent, no Docker, no spend).
 *
 * Re-derives, from the EXTERNAL vexp-swe-bench repository's committed artifacts,
 * the arithmetic that M188's causal conclusions rest on:
 *
 *   1. whether the competitor arms (Live-SWE-Agent / OpenHands / Sonar Foundation)
 *      were executed by that harness or PROJECTED onto the 100-task subset from
 *      externally published full-500 resolvedIds;
 *   2. the treatment telemetry of the vexp arm (which tools the agent actually
 *      called, and on how many tasks);
 *   3. the disagreement between the published `costUsd` column and the same
 *      file's token columns re-priced with the harness's own price table.
 *
 * Reads via `git show HEAD:<path>` on purpose: a local vexp-swe-bench checkout is
 * dirty after any Stage 5 run of ours, and only the committed tree is the
 * published artifact.
 *
 * Usage:
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m188_vexp_artifact_audit.ts \
 *     --vexp-swe-bench-dir "$VEXP" --out benchmarks/stage5_vexp_swe_bench_smoke/results
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface ResultRow {
  instanceId: string;
  repo: string;
  model: string;
  agent: string;
  resolved: boolean | null;
  costUsd: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  timestamp: string;
  durationMs: number;
  toolCalls: Record<string, number> | null;
  vexpMetrics: unknown;
}

interface ExternalArm {
  system: string;
  score: number;
  date: string;
  source: string;
  resolvedIds: string[];
}

/** Opus 4.5 row of the harness's own MODEL_PRICING table (src/metrics/pricing.ts). */
const OPUS_45_PRICE = {
  inputPerMTok: 5,
  outputPerMTok: 25,
  cacheReadPerMTok: 0.5,
  cacheWritePerMTok: 6.25,
} as const;

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined) {
    if (fallback === undefined) throw new Error(`missing required --${name}`);
    return fallback;
  }
  return v;
}

function gitShow(dir: string, path: string): string {
  return execFileSync("git", ["-C", dir, "show", `HEAD:${path}`], {
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function readJsonl<T>(raw: string): T[] {
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

function repriceFromTokens(r: ResultRow): number {
  return (
    (r.inputTokens / 1_000_000) * OPUS_45_PRICE.inputPerMTok +
    (r.outputTokens / 1_000_000) * OPUS_45_PRICE.outputPerMTok +
    (r.cacheReadTokens / 1_000_000) * OPUS_45_PRICE.cacheReadPerMTok +
    (r.cacheCreationTokens / 1_000_000) * OPUS_45_PRICE.cacheWritePerMTok
  );
}

function main(): void {
  const vexpDir = arg("vexp-swe-bench-dir");
  const outDir = arg("out", "benchmarks/stage5_vexp_swe_bench_smoke/results");

  const head = execFileSync("git", ["-C", vexpDir, "rev-parse", "HEAD"], {
    encoding: "utf-8",
  }).trim();
  const headDate = execFileSync("git", ["-C", vexpDir, "log", "-1", "--format=%cI"], {
    encoding: "utf-8",
  }).trim();

  const subsetIds = new Set(
    readJsonl<{ instance_id: string }>(gitShow(vexpDir, "data/swe-bench-100.jsonl")).map(
      (i) => i.instance_id,
    ),
  );
  const rows = readJsonl<ResultRow>(gitShow(vexpDir, "results/swebench-2026-03-22.jsonl"));

  // ── 1. competitor arms: executed here, or projected from elsewhere? ──────────
  const externalArms = ["livesweagent", "openhands", "sonar"].map((name) => {
    const arm = JSON.parse(gitShow(vexpDir, `data/external/${name}-resolved.json`)) as ExternalArm;
    const inSubset = arm.resolvedIds.filter((id) => subsetIds.has(id)).length;
    return {
      file: `data/external/${name}-resolved.json`,
      system: arm.system,
      publishedFullSetScore: arm.score,
      runDate: arm.date,
      externalSource: arm.source,
      resolvedIdsCount: arm.resolvedIds.length,
      subsetIntersection: inSubset,
      subsetScorePct: (inSubset / subsetIds.size) * 100,
      executedByThisHarness: false,
      note: "resolvedIds are the arm's own published full-500 SWE-bench Verified run; the leaderboard figure is their intersection with this harness's 100-task subset.",
    };
  });

  // ── 2. treatment telemetry of the vexp arm ──────────────────────────────────
  const toolCallTotals = new Map<string, number>();
  const toolTaskCounts = new Map<string, number>();
  for (const r of rows) {
    for (const [tool, n] of Object.entries(r.toolCalls ?? {})) {
      toolCallTotals.set(tool, (toolCallTotals.get(tool) ?? 0) + n);
      if (n > 0) toolTaskCounts.set(tool, (toolTaskCounts.get(tool) ?? 0) + 1);
    }
  }
  const isVexpTool = (tool: string): boolean =>
    tool === "run_pipeline" || tool.toLowerCase().includes("vexp");
  const usesAny = (r: ResultRow, pred: (t: string) => boolean): boolean =>
    Object.entries(r.toolCalls ?? {}).some(([t, n]) => n > 0 && pred(t));

  const vexpToolTasks = rows.filter((r) => usesAny(r, isVexpTool));
  const nativeSearchTasks = rows.filter((r) => usesAny(r, (t) => t === "Grep" || t === "Glob"));

  // ── 3. two accountings in one file ──────────────────────────────────────────
  const publishedCost = rows.reduce((s, r) => s + r.costUsd, 0);
  const repricedCost = rows.reduce((s, r) => s + repriceFromTokens(r), 0);
  const exactMatches = rows.filter((r) => Math.abs(repriceFromTokens(r) - r.costUsd) < 1e-9);

  // ── 4. timestamp grid ───────────────────────────────────────────────────────
  const stamps = rows.map((r) => Date.parse(r.timestamp)).sort((a, b) => a - b);
  const deltas = new Set<number>();
  for (let i = 1; i < stamps.length; i++) deltas.add((stamps[i]! - stamps[i - 1]!) / 1000);
  const spanSeconds = (stamps[stamps.length - 1]! - stamps[0]!) / 1000;
  const durationSeconds = rows.reduce((s, r) => s + r.durationMs, 0) / 1000;

  const report = {
    milestone: "M188",
    generatedFor: "external artifact re-derivation; no agent spawned, no Docker, $0.00",
    source: {
      repository: "https://github.com/Vexp-ai/vexp-swe-bench",
      localCheckout: vexpDir,
      commit: head,
      commitDate: headDate,
      readVia: "git show HEAD:<path> (committed tree, not the working tree)",
    },
    subset: { size: subsetIds.size, file: "data/swe-bench-100.jsonl" },
    vexpArm: {
      rows: rows.length,
      resolved: rows.filter((r) => r.resolved === true).length,
      models: [...new Set(rows.map((r) => r.model))],
      agents: [...new Set(rows.map((r) => r.agent))],
      executedByThisHarness: true,
    },
    competitorArms: externalArms,
    treatmentTelemetry: {
      toolCalls: [...toolCallTotals.entries()]
        .map(([tool, calls]) => ({ tool, calls, tasks: toolTaskCounts.get(tool) ?? 0 }))
        .sort((a, b) => b.calls - a.calls),
      tasksCallingAnyVexpTool: vexpToolTasks.length,
      tasksCallingAnyVexpToolIds: vexpToolTasks.map((r) => r.instanceId),
      tasksCallingGrepOrGlob: nativeSearchTasks.length,
      vexpMetricsNullCount: rows.filter((r) => r.vexpMetrics === null).length,
      note: "CLAUDE.md written by the harness mandates run_pipeline first and forbids grep/glob/Read/Bash/cat; a PreToolUse hook denies Grep|Glob only while the daemon socket AND a healthy marker both exist.",
    },
    accounting: {
      publishedTotalUsd: publishedCost,
      publishedPerTaskUsd: publishedCost / rows.length,
      repricedFromTokensTotalUsd: repricedCost,
      repricedPerTaskUsd: repricedCost / rows.length,
      disagreementPct: ((repricedCost - publishedCost) / publishedCost) * 100,
      rowsWherePublishedEqualsRepriced: exactMatches.map((r) => ({
        instanceId: r.instanceId,
        costUsd: r.costUsd,
        numTurns: r.numTurns,
      })),
      mechanism:
        "parseStreamJson short-circuits on the stream's `result` event and returns Claude Code's provider-billed total_cost_usd; runs killed at the $3 cost limit never emit that event and therefore fall through to the token-priced path.",
    },
    timestampGrid: {
      first: new Date(stamps[0]!).toISOString(),
      last: new Date(stamps[stamps.length - 1]!).toISOString(),
      distinctInterRowDeltasSeconds: [...deltas].sort((a, b) => a - b),
      spanSeconds,
      summedDurationSeconds: durationSeconds,
      durationOverSpanRatio: durationSeconds / spanSeconds,
      note: "the orchestrator stamps each row with new Date() at write time; a single exact inter-row delta across 100 consecutive rows is not reachable from that code path.",
    },
  };

  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "stage5_m188_vexp_artifact_audit.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${outPath}`);
  console.log(
    `vexp arm ${report.vexpArm.resolved}/${report.vexpArm.rows} resolved; competitor subset scores: ` +
      externalArms.map((a) => `${a.system} ${a.subsetIntersection}`).join(", "),
  );
  console.log(
    `vexp tools called on ${report.treatmentTelemetry.tasksCallingAnyVexpTool}/${rows.length} tasks; ` +
      `Grep/Glob on ${report.treatmentTelemetry.tasksCallingGrepOrGlob}/${rows.length}`,
  );
  console.log(
    `accounting: published $${publishedCost.toFixed(4)} vs repriced $${repricedCost.toFixed(4)} ` +
      `(${report.accounting.disagreementPct.toFixed(1)}%)`,
  );
}

main();
