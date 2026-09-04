/**
 * M212 — shadow A15 over a controlled fanout corpus.
 *
 * Frozen A15 asks one question of a default `get_impact_graph` response: does an
 * arbitrary known caller arrive inline, carrying source text that names the
 * callee? It asks it on C-LARGE, where fanout is whatever ARC happens to have.
 * This runner asks the same question at fanouts chosen in advance — 1, 8, 32,
 * 64, 65, 100, 200, 500 — so the shape of the answer as fanout grows is visible
 * rather than inferred from one corpus (control F3: a five-caller fixture where
 * everything fits establishes nothing about an architecture).
 *
 * It is a SHADOW evaluator. It does not replace, modify or re-threshold the
 * frozen A15 scorer, and its numbers are never substituted for frozen ones. It
 * reuses the frozen predicate through `representationOf` so the two can never
 * disagree about the same relation, and it reports the one thing frozen A15
 * cannot see: how many of those same callers are reachable when the response's
 * own deterministic continuation is followed.
 *
 * One repository per fanout, so the target's caller count is exactly the fanout
 * and not a sum. Callers are `caller_0001 .. caller_NNNN`, each with a real
 * static call, and the sample is the first ten lexicographically — fixed before
 * any response is read (control F9).
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m212_shadow_a15.ts \
 *     [--scratch <dir>] [--repeats 2]
 */
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createMcpServer } from "../../src/mcp/server";
import { McpToolId, MCP_SERVER_SCHEMA } from "../../src/mcp/types";
import { classifyProjection, recallOf, representationOf } from "./m212VexpSurface";
import type { CallerRepresentation } from "./m212VexpSurface";

const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const SCRATCH = argOf("--scratch", path.join(process.env.TMPDIR ?? "/tmp", "m212"));
const REPEATS = Number.parseInt(argOf("--repeats", "2"), 10);

/** Pre-registered before any response was read. */
const FANOUTS = [1, 8, 32, 64, 65, 100, 200, 500] as const;
const SAMPLE_SIZE = 10;
const CALLERS_PER_FILE = 20;

const callerName = (i: number) => `caller_${String(i).padStart(4, "0")}`;

/**
 * A deliberately boring corpus: one exported target, and callers that do nothing
 * but call it. Parser or resolution uncertainty here would be indistinguishable
 * from projection behaviour, which is the confusion control F4 exists to
 * prevent, so the source is kept as simple as a call graph can be.
 */
function generateCorpus(root: string, fanout: number): string[] {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "target.ts"),
    "export function target(value: number): number {\n  return value + 1;\n}\n");

  const callers: string[] = [];
  for (let start = 1; start <= fanout; start += CALLERS_PER_FILE) {
    const end = Math.min(fanout, start + CALLERS_PER_FILE - 1);
    const rel = `src/callers_${String(start).padStart(4, "0")}.ts`;
    const lines = ['import { target } from "./target";', ""];
    for (let i = start; i <= end; i += 1) {
      lines.push(`export function ${callerName(i)}(): number {`, `  return target(${i});`, "}", "");
      callers.push(`${rel}::${callerName(i)}`);
    }
    writeFileSync(path.join(root, rel), `${lines.join("\n")}\n`);
  }
  return callers.sort();
}

type Server = ReturnType<typeof createMcpServer>;
/** The default model-facing path, entered exactly as M197A enters it (control F6). */
const call = async (server: Server, toolId: string, input: unknown, id = "m212"): Promise<any> => {
  const res: any = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: id, toolId, input } as any);
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

const TARGET_FQN = "src/target.ts::target";

const perFanout: any[] = [];

for (const fanout of FANOUTS) {
  const work = path.join(SCRATCH, `fanout_${fanout}`);
  const truthfulCallers = generateCorpus(work, fanout);
  // Control F9: the sample is fixed here, before a single response exists.
  const sample = truthfulCallers.slice(0, Math.min(SAMPLE_SIZE, truthfulCallers.length));

  const dbPath = path.join(work, ".vtrace/index.sqlite");
  const server = createMcpServer({ context: { repoRoot: work, dbPath } } as any);
  const indexed = await call(server, McpToolId.IndexRepo, { repo_root: work }, "idx");
  if (indexed?.readiness?.status !== "ready") {
    perFanout.push({ fanout, status: "INDEX_NOT_READY", indexed }); continue;
  }

  // Control F4: indexing recall is measured against the generator's ground
  // truth and reported separately, so a parser miss is never read as the
  // renderer declining to project a caller it actually had.
  const db = new Database(dbPath, { readonly: true });
  const indexedCallers = new Set((db.query(
    `select ss.fq_name as fqn from edges e
       join symbols ss on ss.id = e.src_symbol_id
       join symbols ds on ds.id = e.dst_symbol_id
      where e.edge_type = 'calls' and ds.fq_name = ?1`).all(TARGET_FQN) as { fqn: string }[]).map((r) => r.fqn));
  db.close();

  // ------------------------------------------------------- default response
  const responses: any[] = [];
  for (let r = 0; r < REPEATS; r += 1) {
    responses.push(await call(server, McpToolId.GetImpactGraph, { repo_root: work, symbol_fqn: TARGET_FQN }));
  }
  const impact = responses[0];
  const delivered = (impact?.directRelations ?? []) as any[];
  const census = impact?.impactCensus ?? null;
  const continuation = impact?.continuation ?? null;

  // Control F10: semantics must repeat. Timing is excluded by comparing only
  // the fields that carry meaning, never the ones that carry a clock.
  const semanticShape = (x: any) => JSON.stringify({
    relations: (x?.directRelations ?? []).map((d: any) => [d?.source?.symbol, d?.evidence?.sourceText ?? null]),
    census: x?.impactCensus?.directRelations ?? null,
    exactCallers: x?.impactCensus?.exactCallers ?? null,
    remaining: x?.continuation?.remaining ?? null,
  });
  const stable = new Set(responses.map(semanticShape)).size === 1;

  // -------------------------------------- default + deterministic continuation
  // REACHABLE_RECALL follows the response's own cursor and nothing else. A
  // caller found by unrelated search would not count (control F6).
  const reachable = new Map<string, CallerRepresentation>();
  for (const c of sample) reachable.set(c, representationOf(c, delivered, indexedCallers.has(c)));

  let pages = 0;
  let ref: string | undefined = continuation?.ref;
  const continuationFaults: string[] = [];
  // A harness bound, not a product one. Reported alongside the result so a
  // stream that was merely truncated here is never read as one that ended.
  const PAGE_CAP = 400;
  while (ref !== undefined && ref !== null && pages < PAGE_CAP) {
    const page: any = await call(server, McpToolId.GetImpactGraph,
      { repo_root: work, symbol_fqn: TARGET_FQN, continuation_ref: ref });
    pages += 1;
    const pageRelations = (page?.directRelations ?? []) as any[];
    if (pageRelations.length === 0 && page?.continuation?.ref === ref) { continuationFaults.push("cursor_did_not_advance"); break; }
    for (const c of sample) {
      if (reachable.get(c) === "INLINE_WITH_SOURCE") continue;
      const here = representationOf(c, pageRelations, indexedCallers.has(c));
      if (here !== "CENSUS_ONLY" && here !== "ABSENT") reachable.set(c, here);
    }
    ref = page?.continuation?.ref;
  }

  const inlineHits = sample.filter((c) => representationOf(c, delivered, indexedCallers.has(c)) === "INLINE_WITH_SOURCE").length;
  const reachableHits = sample.filter((c) => reachable.get(c) === "INLINE_WITH_SOURCE").length;

  const breakdown: Record<string, number> = {};
  for (const c of sample) {
    const k = representationOf(c, delivered, indexedCallers.has(c));
    breakdown[k] = (breakdown[k] ?? 0) + 1;
  }
  const reachableBreakdown: Record<string, number> = {};
  for (const c of sample) {
    const k = reachable.get(c) ?? "ABSENT";
    reachableBreakdown[k] = (reachableBreakdown[k] ?? 0) + 1;
  }

  perFanout.push({
    fanout,
    status: "MEASURED",
    truthfulCallers: truthfulCallers.length,
    indexedCallers: indexedCallers.size,
    indexingRecallPercent: +(100 * indexedCallers.size / truthfulCallers.length).toFixed(2),
    censusDirectRelations: census?.directRelations ?? null,
    // Reported beside exactCallers because a zero in one and a truthful total in
    // the other is a statement about edge STRENGTH classification on this corpus,
    // not about the census being wrong. Splitting them is the point of the field.
    censusExactCallers: census?.exactCallers ?? null,
    censusResolvedCallers: census?.resolvedCallers ?? null,
    censusImporters: census?.importers ?? null,
    censusComplete: census?.complete ?? null,
    deliveredRelations: delivered.length,
    deliveredWithSource: delivered.filter((d: any) => typeof d?.evidence?.sourceText === "string" && d.evidence.sourceText.length > 0).length,
    continuationRemaining: continuation?.remaining ?? null,
    continuationPagesFollowed: pages,
    continuationExhausted: ref === undefined || ref === null,
    continuationFaults,
    responseBytes: JSON.stringify(impact ?? {}).length,
    sample,
    sampleBreakdown: breakdown,
    reachableBreakdown,
    recall: recallOf(inlineHits, reachableHits, sample.length),
    projectionClass: classifyProjection({
      indexedCallers: indexedCallers.size,
      deliveredRelations: delivered.length,
      censusTotal: census?.directRelations ?? null,
      hasDeterministicContinuation: typeof continuation?.ref === "string",
      hasExpandableReferences: false, // VTRACE emits no V-REF-style marker; see the surface audit.
    }),
    semanticsStableAcrossRepeats: stable,
  });

  const row = perFanout[perFanout.length - 1];
  console.log(`fanout ${String(fanout).padStart(3)} | indexed ${row.indexedCallers}/${row.truthfulCallers}`
    + ` | census ${row.censusDirectRelations} | inline ${row.deliveredRelations}`
    + ` | inline+src ${row.deliveredWithSource}`
    + ` | INLINE_RECALL ${row.recall.inlineRecall}% | REACHABLE_RECALL ${row.recall.reachableRecall}%`
    + ` | ${row.projectionClass}`);
}

const measured = perFanout.filter((r) => r.status === "MEASURED");
const report = {
  milestone: "M212",
  generatedAt: new Date().toISOString(),
  method: "synthetic controlled-fanout corpora, VTRACE default get_impact_graph through the MCP request handler; no agent, no model call",
  preregistered: { fanouts: FANOUTS, sampleSize: SAMPLE_SIZE, sampleRule: "first N caller FQNs lexicographically, fixed before any response was read" },
  repeats: REPEATS,
  perFanout,
  aggregate: {
    corpora: measured.length,
    allSemanticsStable: measured.every((r) => r.semanticsStableAcrossRepeats),
    indexingRecallMin: measured.length === 0 ? null : Math.min(...measured.map((r) => r.indexingRecallPercent)),
    censusTruthfulEverywhere: measured.every((r) => r.censusDirectRelations !== null && r.censusDirectRelations >= r.indexedCallers),
    projectionClasses: [...new Set(measured.map((r) => r.projectionClass))],
    inlineRecallByFanout: Object.fromEntries(measured.map((r) => [r.fanout, r.recall.inlineRecall])),
    reachableRecallByFanout: Object.fromEntries(measured.map((r) => [r.fanout, r.recall.reachableRecall])),
  },
};

writeFileSync(path.join(RESULTS, "stage5_m212_shadow_a15.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\ncensus truthful at every fanout: ${report.aggregate.censusTruthfulEverywhere}`);
console.log(`semantics stable across ${REPEATS} repeats: ${report.aggregate.allSemanticsStable}`);
console.log("wrote results/stage5_m212_shadow_a15.json");
