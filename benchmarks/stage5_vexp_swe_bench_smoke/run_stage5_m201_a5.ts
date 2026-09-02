/**
 * M201 — frozen A5 harness: warm `get_code_context` latency and the per-query
 * OUTPUT authority the optimisation must preserve.
 *
 * The measurement protocol is the frozen one, imported from the M197A fixtures
 * rather than restated: the same corpora, the same authored query set, the same
 * one warm-up call, the same `--repeats` executions, the same `latencyStats`
 * percentile rule. Nothing here may be tuned; this file exists so the frozen A5
 * block can be run on its own, and so every response it produced can be hashed
 * before any product change (§6).
 *
 * The corpus is copied ONCE into `--scratch` and reused. C-MED is this
 * repository's own `src/`, so a scratch that re-copied would change the corpus
 * underneath a pre/post comparison and attribute the product change's effect to
 * a corpus that also moved.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m201_a5.ts \
 *     --label pre --scratch /tmp/m201-frozen [--repeats 5]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createMcpServer } from "../../src/mcp/server";
import { McpToolId, MCP_SERVER_SCHEMA } from "../../src/mcp/types";
import { A5_QUERIES, corpusSpecs, latencyStats, tokens } from "./m197aFixtures";
import { ensureSnapshot, materializeWorkingCopy, snapshotFingerprint } from "./m201Corpus";
import { determinismVerdict, semanticProjection } from "./m197aScoring";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const LABEL = argOf("--label", "pre");
const REPEATS = Number.parseInt(argOf("--repeats", "5"), 10);
const SNAPSHOT = argOf("--snapshot", "/tmp/m201-snapshot");
const WORK_ROOT = argOf("--work", `/tmp/m201-work-${LABEL}`);
mkdirSync(SNAPSHOT, { recursive: true });
mkdirSync(WORK_ROOT, { recursive: true });

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const environment = () => {
  const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
  const load = read("/proc/loadavg").split(" ").slice(0, 3).map(Number);
  const meminfo = Object.fromEntries(read("/proc/meminfo").split("\n")
    .map((l) => l.split(":")).filter((p) => p.length === 2)
    .map(([k, v]) => [k!.trim(), Number.parseInt(v!.trim(), 10)]));
  return {
    loadAverage: load, cpus: navigator.hardwareConcurrency,
    memTotalKb: meminfo["MemTotal"] ?? null, memAvailableKb: meminfo["MemAvailable"] ?? null,
    memPressurePercent: meminfo["MemTotal"]
      ? +(100 * (1 - (meminfo["MemAvailable"] ?? 0) / meminfo["MemTotal"])).toFixed(2) : null,
  };
};

type Server = ReturnType<typeof createMcpServer>;
const call = async (server: Server, toolId: string, input: unknown, id = "m201"): Promise<any> => {
  const res: any = await server.handleRequest(
    { schema: MCP_SERVER_SCHEMA, requestId: id, toolId, input } as any);
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

/**
 * The model-facing selection, in order. Extracted separately from the semantic
 * hash so a difference can be READ rather than only detected: a hash says two
 * runs disagree, this says which item moved.
 */
function selectionOf(out: any): unknown {
  const item = (i: any) => i === undefined || i === null ? null : {
    at: i.at ?? null, form: i.form ?? null, why: i.why ?? i.reason ?? null,
    codeChars: typeof i.code === "string" ? i.code.length : null,
    codeSha: typeof i.code === "string" ? sha(i.code).slice(0, 16) : null,
  };
  return {
    schemaVersion: out?.schemaVersion ?? null,
    focus: item(out?.focus),
    related: (out?.related ?? []).map(item),
    boundary: out?.boundary ?? null,
    notes: out?.notes ?? null,
    topLevelKeys: Object.keys(out ?? {}).sort(),
  };
}

const startedAt = environment();
console.log(`[${LABEL}] load ${startedAt.loadAverage.join(" ")} of ${startedAt.cpus} cpus, `
  + `mem pressure ${startedAt.memPressurePercent}%`);

const perCorpus: any[] = [];
for (const spec of corpusSpecs(REPO)) {
  ensureSnapshot(spec, SNAPSHOT);
  const work = materializeWorkingCopy(spec, SNAPSHOT, WORK_ROOT);
  if (work === null) { perCorpus.push({ id: spec.id, status: "CORPUS_ABSENT" }); continue; }

  const dbPath = path.join(work, ".vtrace/index.sqlite");
  const server = createMcpServer({ context: { repoRoot: work, dbPath } } as any);
  const indexed = await call(server, McpToolId.IndexRepo, { repo_root: work }, "idx");
  if (indexed?.readiness?.status !== "ready") {
    perCorpus.push({ id: spec.id, status: "INDEX_NOT_READY", readiness: indexed?.readiness ?? null });
    continue;
  }

  const queries = A5_QUERIES[spec.id] ?? [];
  const all: number[] = [];
  const hashes = new Map<string, Set<string>>();
  const perQuery: any[] = [];

  for (const task of queries) {
    // The frozen protocol: one warm-up, then REPEATS timed executions.
    await call(server, McpToolId.GetCodeContext, { task, repo_root: work });
    const samples: number[] = [];
    let last: any = null;
    const byteHashes = new Set<string>();
    for (let i = 0; i < REPEATS; i += 1) {
      const t0 = performance.now();
      const out = await call(server, McpToolId.GetCodeContext, { task, repo_root: work });
      samples.push(performance.now() - t0);
      all.push(samples.at(-1)!);
      const set = hashes.get(task) ?? new Set<string>();
      set.add(sha(JSON.stringify(semanticProjection(out))));
      hashes.set(task, set);
      byteHashes.add(sha(JSON.stringify(out)));
      last = out;
    }
    const serialized = JSON.stringify(last ?? {});
    perQuery.push({
      task, samples: samples.map((s) => +s.toFixed(2)), stats: latencyStats(samples),
      semanticSha: [...(hashes.get(task) ?? [])].sort(),
      // The byte hash carries `timing`, which legitimately varies run to run; it
      // is recorded so a byte difference can be told from a semantic one, not so
      // it can be required to be stable.
      byteSha: [...byteHashes].sort(),
      selection: selectionOf(last),
      selectionSha: sha(JSON.stringify(selectionOf(last))),
      serializedCharacters: serialized.length,
      responseTokens: tokens(serialized),
      boundedness: {
        responseBudget: last?.responseBudget ?? last?.productContext?.responseBudget ?? null,
        withinDeclaredBudget: last?.responseBudget?.withinBudget
          ?? last?.productContext?.responseBudget?.withinBudget ?? null,
      },
      relatedCount: (last?.related ?? []).length,
    });
  }

  const determinism = determinismVerdict(hashes);
  perCorpus.push({
    id: spec.id, language: spec.language, corpusPath: work,
    // Provenance: a pre/post comparison is only meaningful if BOTH sides ran
    // against the same corpus bytes, and C-MED is this repository's own src.
    snapshotFingerprint: snapshotFingerprint(spec, SNAPSHOT),
    queries: queries.length, repeats: REPEATS,
    latency: latencyStats(all),
    deterministic: determinism.deterministic,
    nonDeterministicQueries: determinism.unstableQueries,
    perQuery,
  });
  const c = perCorpus.at(-1)!;
  console.log(`[${LABEL}] ${spec.id.padEnd(8)} p50 ${c.latency.median} p90 ${c.latency.p90} `
    + `p95 ${c.latency.p95} max ${c.latency.max} min ${c.latency.min} ms`);
}

/** The frozen A5 rule, restated only as a read-out: EVERY corpus must clear. */
const p90s = perCorpus.map((c) => c.latency?.p90 ?? null);
const classification = p90s.some((v) => v === null) ? "UNMEASURED"
  : p90s.every((v) => v <= 200) ? "VTRACE_EXCEEDS_VEXP_CLAIM"
  : p90s.every((v) => v <= 500) ? "VTRACE_MATCHES_VEXP_CLAIM"
  : "VTRACE_BELOW_VEXP_CLAIM";

const out = {
  milestone: "M201", instrument: "run_stage5_m201_a5.ts", label: LABEL,
  protocol: {
    metric: "get_code_context warm wall-clock per call, measured around server.handleRequest",
    corpora: ["C-SMALL", "C-MED", "C-LARGE"],
    queriesPerCorpus: 5, warmUpCallsPerQuery: 1, repeats: REPEATS,
    aggregation: "percentile over all corpus samples, ceil(p*n)-1 index, per m197aFixtures.latencyStats",
    matchThreshold: "p90 <= 500 ms on EVERY corpus", exceedThreshold: "p90 <= 200 ms on EVERY corpus",
    indexLoadInsideTiming: "yes — the server opens the index per request; only the corpus copy and index build are outside",
    serializationBoundary: "the MCP tool output object returned by handleRequest, before transport encoding",
    snapshot: SNAPSHOT, workRoot: WORK_ROOT,
  },
  environment: { atStart: startedAt, atEnd: environment() },
  corpora: perCorpus,
  p90ByCorpus: Object.fromEntries(perCorpus.map((c) => [c.id, c.latency?.p90 ?? null])),
  classification,
};
const file = `stage5_m201_a5_${LABEL}.json`;
writeFileSync(path.join(RESULTS, file), `${JSON.stringify(out, null, 2)}\n`);
console.log(`[${LABEL}] classification ${classification} -> results/${file}`);
