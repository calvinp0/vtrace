/**
 * M203 — what the accounting costs at run time (§49).
 *
 * Three measurements, each against the thing it is about:
 *
 *   projector, before vs after   the predecessor projector (a worktree at the
 *                                starting commit) and the current one, run on
 *                                the SAME authoritative results, interleaved,
 *                                many times. The difference is the cost of
 *                                building the ledger and attaching `tokens`.
 *   validation                   the analyzer on each packet + ledger.
 *   memory                       heap retained by the packets and their ledgers,
 *                                and the ledger's serialized size, per packet.
 *
 * Whole-call latency is not measured here: the frozen A5 harness is the
 * authority for that and is run on its own, on an idle machine, as M201/M202
 * did. The authoritative results are taken at `detail=debug` from the already
 * indexed C-MED working copy the A14 reproduction built; the packet the
 * projector derives from them is checked against the default-path packet so the
 * workload is known to be the real one.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m203_performance.ts \
 *     [--pre-root /home/calvin/bench/vtrace-m203/pre] [--work /tmp/m203-a14-post/C-MED] [--rounds 20]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createMcpServer } from "../../src/mcp/server";
import { McpToolId, MCP_SERVER_SCHEMA } from "../../src/mcp/types";
import { orientationAccountingOf } from "../../src/runPipeline/orientationAccounting";
import { ORIENTATION_POLICY, projectRunPipelineOrientation } from "../../src/runPipeline/orientationProjection";
import { A13_TASKS, latencyStats, median } from "./m197aFixtures";
import { analyzeAccounting, stripAccounting } from "./m203Accounting";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const PRE_ROOT = argOf("--pre-root", "/home/calvin/bench/vtrace-m203/pre");
const WORK = argOf("--work", "/tmp/m203-a14-post/C-MED");
const ROUNDS = Number.parseInt(argOf("--rounds", "20"), 10);
const BUDGETS = [1000, 2000, 4000, 8000, 16000] as const;

if (!existsSync(path.join(WORK, ".vtrace/index.sqlite"))) throw new Error(`M203_WORK_NOT_INDEXED: ${WORK}`);
const pre = await import(path.join(PRE_ROOT, "src/runPipeline/orientationProjection.ts"));
const preHead = Bun.spawnSync(["git", "-C", PRE_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const loadAverage = () => { try { return readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).map(Number); } catch { return []; } };

const server = createMcpServer({ context: { repoRoot: WORK, dbPath: path.join(WORK, ".vtrace/index.sqlite") } } as any);
const call = async (input: unknown): Promise<any> => {
  const res: any = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: "perf", toolId: McpToolId.GetCodeContext, input } as any);
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

// ------------------------------------------------ the workload: 100 authoritative results
const workload: { task: string; budget: number; authoritative: any; defaultPacketSha: string }[] = [];
let workloadMatches = 0;
for (const task of A13_TASKS) {
  for (const budget of BUDGETS) {
    const authoritative = await call({ task, repo_root: WORK, max_tokens: budget, detail: "debug" });
    const packet = await call({ task, repo_root: WORK, max_tokens: budget });
    if (!authoritative?.productContext || !packet?.focus) continue;
    const defaultPacketSha = sha(JSON.stringify(packet));
    // The projector applied to the debug result must reproduce the default packet,
    // or the timing below would be of a different workload.
    if (sha(JSON.stringify(projectRunPipelineOrientation(authoritative))) === defaultPacketSha) workloadMatches += 1;
    workload.push({ task, budget, authoritative, defaultPacketSha });
  }
}
console.log(`workload ${workload.length} authoritative results; projector-from-debug reproduces the default packet on ${workloadMatches}`);

// ------------------------------------------------------- projector before vs after
const preSamples: number[] = []; const postSamples: number[] = []; const validateSamples: number[] = [];
let strippedEqual = 0;
for (let round = 0; round < ROUNDS; round += 1) {
  for (const w of workload) {
    // Interleaved, so drift in machine load lands on both sides equally.
    const t0 = performance.now();
    const before = pre.projectRunPipelineOrientation(w.authoritative);
    preSamples.push(performance.now() - t0);
    const t1 = performance.now();
    const after = projectRunPipelineOrientation(w.authoritative);
    postSamples.push(performance.now() - t1);
    const t2 = performance.now();
    analyzeAccounting({ packet: after, ledger: orientationAccountingOf(after!), ceilingTokens: ORIENTATION_POLICY.ceilingTokens });
    validateSamples.push(performance.now() - t2);
    if (round === 0 && JSON.stringify(before) === JSON.stringify(stripAccounting(after))) strippedEqual += 1;
  }
}

// ------------------------------------------------------------------- memory
const gc = () => { if (typeof Bun.gc === "function") Bun.gc(true); };
const retainedPre: unknown[] = []; const retainedPost: unknown[] = [];
gc(); const h0 = process.memoryUsage().heapUsed;
for (const w of workload) retainedPre.push(pre.projectRunPipelineOrientation(w.authoritative));
gc(); const h1 = process.memoryUsage().heapUsed;
for (const w of workload) retainedPost.push(projectRunPipelineOrientation(w.authoritative));
gc(); const h2 = process.memoryUsage().heapUsed;
const ledgerBytes = retainedPost.map((p) => JSON.stringify(orientationAccountingOf(p as object)).length);
const packetBytes = retainedPost.map((p) => JSON.stringify(p).length);
const ledgerItems = retainedPost.map((p) => (orientationAccountingOf(p as object) as any).items.length);

const out = {
  milestone: "M203", instrument: "run_stage5_m203_performance.ts",
  predecessor: { root: PRE_ROOT, head: preHead },
  workload: { authoritativeResults: workload.length, projectorFromDebugReproducesDefaultPacket: workloadMatches,
    strippedPostEqualsPre: strippedEqual, rounds: ROUNDS, samplesPerSide: preSamples.length },
  hardware: { cpus: navigator.hardwareConcurrency, loadAverage: loadAverage() },
  projectorMs: {
    before: latencyStats(preSamples), after: latencyStats(postSamples),
    accountingConstructionMedianMs: +(median(postSamples) - median(preSamples)).toFixed(4),
    accountingConstructionP90Ms: +(latencyStats(postSamples).p90 - latencyStats(preSamples).p90).toFixed(4),
  },
  validationMs: latencyStats(validateSamples),
  memory: {
    heapRetainedByPacketsBeforeBytes: h1 - h0, heapRetainedByPacketsAfterBytes: h2 - h1,
    perPacketDeltaBytes: workload.length === 0 ? null : Math.round(((h2 - h1) - (h1 - h0)) / workload.length),
    ledgerSerializedBytes: { median: median(ledgerBytes), max: Math.max(...ledgerBytes) },
    packetSerializedBytes: { median: median(packetBytes), max: Math.max(...packetBytes) },
    ledgerItems: { median: median(ledgerItems), max: Math.max(...ledgerItems) },
    retention: "ledgers live in a WeakMap keyed on the packet; they are collected with it, and nothing accumulates across calls",
  },
  storage: { databaseTables: 0, schemaChanges: 0, persisted: false,
    note: "derived at compile time, result-local; nothing is written to index.sqlite or session.sqlite" },
};
writeFileSync(path.join(RESULTS, "stage5_m203_performance.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`projector median before ${out.projectorMs.before.median} ms, after ${out.projectorMs.after.median} ms `
  + `(+${out.projectorMs.accountingConstructionMedianMs} ms); validation median ${out.validationMs.median} ms; `
  + `heap per packet +${out.memory.perPacketDeltaBytes} B; ledger median ${out.memory.ledgerSerializedBytes.median} B`);
