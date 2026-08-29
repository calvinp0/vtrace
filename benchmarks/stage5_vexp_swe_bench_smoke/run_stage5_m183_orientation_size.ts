/**
 * M183-B — reconcile the live default packet size against M182's figure (§47/§130).
 *
 *   bun run_stage5_m183_orientation_size.ts
 *
 * Costs nothing. Exists because M183's live orientations came out at a median of
 * 579 model-facing tokens against the 1,229 M182 recorded, and §47 says a
 * material deviation is investigated before the economics are interpreted rather
 * than after.
 *
 * WHAT THE INVESTIGATION FOUND.
 *
 * M182's 1,229 / 1,527 / 1,576 is the `atDefaultBudget` slice of M181's budget
 * LADDER — the rung where `max_tokens` was passed explicitly as 8,000. A default
 * `run_pipeline` call passes no `max_tokens` at all, and it does not land on that
 * rung. On django-13658: default 574 tokens with 5 related entries, the 8,000
 * rung 1,391 with 9. The name `defaultBudget` in M181's artifact refers to the
 * configured budget CONSTANT, not to what the default call does.
 *
 * So the two numbers describe different operating points, and comparing them
 * would have made the live treatment look like a regression it is not.
 *
 * This script measures both points on every manifest case, so the comparison in
 * the final report rests on a paired measurement rather than on this paragraph.
 *
 * WHICH ONE IS THE TREATMENT. The default. §7: the shipped default IS the
 * treatment, and arm B passes no `max_tokens`. M183 therefore qualifies the path
 * a real client takes, and reports the ladder rung beside it for continuity with
 * M181/M182 rather than in place of it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";

import { startMcpServer } from "../../src/mcp/startServer";
import { orientationWitness } from "./m183Treatment";
import { deriveStructuredTaskFromProblemStatement } from "./stage5_task_derivation";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const CORPUS = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");
const WORKSPACES = path.join(RESULTS, "workspaces", "m183_orientation");
const LADDER_RUNG = 8000;

async function callPipeline(repoRoot: string, task: string, maxTokens?: number): Promise<unknown> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on("data", (c) => chunks.push(Buffer.from(c)));
  const server = startMcpServer({ repoPath: repoRoot, stdin, stdout, visibleToolIds: ["run_pipeline"] });
  const send = (m: unknown): void => {
    const b = Buffer.from(JSON.stringify(m), "utf8");
    stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${b.length}\r\n\r\n`, "utf8"), b]));
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m183-size", version: "1" } } });
  const args: Record<string, unknown> = { task, repo_root: repoRoot, saveObservation: false };
  if (maxTokens !== undefined) args.max_tokens = maxTokens;
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_pipeline", arguments: args } });
  stdin.end();
  await server;
  const buf = Buffer.concat(chunks);
  let off = 0;
  while (off < buf.length) {
    const he = buf.indexOf("\r\n\r\n", off);
    if (he < 0) break;
    const len = Number(/Content-Length:\s*(\d+)/iu.exec(buf.subarray(off, he).toString("utf8"))?.[1] ?? -1);
    const bs = he + 4;
    if (len < 0 || bs + len > buf.length) break;
    const row = JSON.parse(buf.subarray(bs, bs + len).toString("utf8")) as { id: number; result?: { structuredContent?: { result?: { output?: unknown } } } };
    if (row.id === 2) return row.result?.structuredContent?.result?.output ?? null;
    off = bs + len;
  }
  return null;
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length === 0 ? Number.NaN : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const pct = (xs: readonly number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? Number.NaN : s[Math.min(s.length - 1, Math.floor((s.length - 1) * q))]!;
};

async function main(): Promise<void> {
  const statements = new Map<string, string>();
  for (const line of readFileSync(CORPUS, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const r = JSON.parse(line) as { instance_id: string; problem_statement: string };
    statements.set(r.instance_id, r.problem_statement);
  }
  const manifest = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m183_sample_manifest.json"), "utf8")) as {
    executionOrder: { instanceId: string; repo: string }[];
  };

  const rows: Record<string, unknown>[] = [];
  for (const [i, t] of manifest.executionOrder.entries()) {
    const repoRoot = path.join(WORKSPACES, t.instanceId);
    const task = deriveStructuredTaskFromProblemStatement(statements.get(t.instanceId)!).taskText;
    const def = orientationWitness(await callPipeline(repoRoot, task));
    const rung = orientationWitness(await callPipeline(repoRoot, task, LADDER_RUNG));
    rows.push({
      instanceId: t.instanceId, repo: t.repo,
      defaultTokens: def.orientationTokens, defaultRelated: def.relatedAt.length,
      ladderTokens: rung.orientationTokens, ladderRelated: rung.relatedAt.length,
      identical: def.semanticHash === rung.semanticHash,
      deltaTokens: rung.orientationTokens - def.orientationTokens,
    });
    process.stdout.write(`[${i + 1}/${manifest.executionOrder.length}] ${t.instanceId} default=${def.orientationTokens} ladder8000=${rung.orientationTokens}\n`);
  }

  const d = rows.map((r) => r.defaultTokens as number);
  const l = rows.map((r) => r.ladderTokens as number);
  const doc = {
    schemaVersion: "stage5.m183.orientation-size-reconciliation.v1",
    milestone: "M183", workstream: "M183-B",
    question: "§47/§130 — why is the live default orientation a median of 579 tokens when M182 recorded 1,229?",
    finding: "They are different operating points. M182's 1,229 is the `atDefaultBudget` slice of M181's budget ladder, i.e. the rung where max_tokens was passed explicitly as 8,000. A default run_pipeline call passes no max_tokens and does not land on that rung. `defaultBudget` in M181's artifact names the configured budget CONSTANT, not the behaviour of a default call.",
    whichIsTheTreatment: "The default. §7 — the shipped default IS the treatment, and arm B passes no max_tokens. The ladder rung is reported beside it for continuity with M181/M182, never in place of it.",
    cases: rows.length,
    defaultCall: { median: median(d), p90: pct(d, 0.9), max: Math.max(...d), min: Math.min(...d), medianRelated: median(rows.map((r) => r.defaultRelated as number)) },
    ladderRung8000: { median: median(l), p90: pct(l, 0.9), max: Math.max(...l), min: Math.min(...l), medianRelated: median(rows.map((r) => r.ladderRelated as number)) },
    m182Recorded: {
      atDefaultBudget: { count: 167, median: 1229, p90: 1527, max: 1576 },
      allDeliveringBudgets: { count: 1380, median: 542, p90: 1306, max: 1576 },
      note: "M183's live default median sits beside M182's ALL-BUDGETS median (542), not beside its 8,000-rung median (1,229). That is the correct neighbour: the default call is one point on the ladder, not its top rung.",
    },
    identicalAtBothPoints: rows.filter((r) => r.identical).length,
    consequenceForM182StandingFinding:
      "M182's standing finding says the current default size is 1,229/1,527/1,576 and that this is the treatment a future live benchmark must qualify. That figure describes the 8,000-token rung. The default path a real client takes is materially smaller, and M183 qualifies the default path.",
    rows,
  };
  writeFileSync(path.join(RESULTS, "stage5_m183_orientation_size_reconciliation.json"), `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`\ndefault call     median ${doc.defaultCall.median}  p90 ${doc.defaultCall.p90}  max ${doc.defaultCall.max}`);
  console.log(`ladder rung 8000 median ${doc.ladderRung8000.median}  p90 ${doc.ladderRung8000.p90}  max ${doc.ladderRung8000.max}`);
  console.log(`identical at both points: ${doc.identicalAtBothPoints}/${rows.length}`);
  console.log("  wrote results/stage5_m183_orientation_size_reconciliation.json");
}

await main();
