/**
 * M211 — impact architecture audit + §41 counterfactual. READ-ONLY on the product.
 *
 * Answers, mechanically and in this order:
 *
 *   AUDIT         what does the shipped impact response actually contain, and
 *                 where do its numbers come from;
 *   PATHOLOGY     reproduce M210's high-fanout finding on real repositories —
 *                 graph restatement outspending source evidence while the
 *                 delivered relation count collapses;
 *   CENSUS TRUTH  compare every count the response publishes against the same
 *                 count over the COMPLETE relation universe the core returns at
 *                 its hard bound;
 *   COUNTERFACTUAL model the target architecture's response shape over that same
 *                 truth and report whether it materially improves it.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m211_audit.ts \
 *     --label pre [--product-root <dir>] [--scratch <dir>] [--corpora C-SMALL,C-MED,C-LARGE]
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { corpusSpecs, prepareCorpus, percentile } from "./m197aFixtures";
import {
  censusBlockCharacters, censusFromUniverse, projectEvidence,
  M211_ORDERING_AUTHORITY, M211_PRODUCT_METRICS, type RelationLike,
} from "./m211ImpactArchitecture";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback; };
const LABEL = argOf("--label", "pre");
const PRODUCT_ROOT = path.resolve(argOf("--product-root", REPO));
const SCRATCH = argOf("--scratch", `/tmp/m211-audit-${LABEL}`);
const CORPORA = argOf("--corpora", "C-SMALL,C-MED,C-LARGE").split(",");
/** The core's own hard maximum: what "the complete truthful universe" means here. */
const HARD_MAX_EDGES = 2000;
const SCORER_DEPTH = 3;
/** §28's fanout ladder. Each bucket takes the corpus symbol closest to it. */
const FANOUT_BUCKETS = [0, 1, 8, 32, 64, 128, 500, 1000] as const;
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(RESULTS, { recursive: true });

const size = (value: unknown): number => JSON.stringify(value ?? null).length;
const loadAverage = () => { try { return readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).map(Number); } catch { return []; } };
const productHead = Bun.spawnSync(["git", "-C", PRODUCT_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();

const { createMcpServer } = await import(path.join(PRODUCT_ROOT, "src/mcp/server.ts"));
const { McpToolId, MCP_SERVER_SCHEMA } = await import(path.join(PRODUCT_ROOT, "src/mcp/types.ts"));
const { getImpactGraph } = await import(path.join(PRODUCT_ROOT, "src/impact/getImpactGraph.ts"));
const { compactImpactProductResponse } = await import(path.join(PRODUCT_ROOT, "src/impact/impactResponseEnvelope.ts"));
const { buildContextAccounting, impactGraphOutputFilePathGroups } = await import(path.join(PRODUCT_ROOT, "src/metrics/contextAccounting.ts"));

type Server = { handleRequest: (request: unknown) => Promise<any> };
const call = async (server: Server, toolId: string, input: unknown, id = "m211"): Promise<any> => {
  const res: any = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: id, toolId, input } as any);
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

/** The product's own pre-envelope pipeline, replicated call-for-call from `src/mcp/tools.ts`. */
async function productResponse(db: Database, work: string, symbolFqn: string, overrides: Record<string, unknown> = {}): Promise<any | null> {
  const result = getImpactGraph(db, { symbolFqn, depth: SCORER_DEPTH, format: "tree", ...overrides }, { repoRoot: work, measureTiming: true });
  if (!result.ok) return null;
  let accounting: any;
  try {
    accounting = await buildContextAccounting({
      repoRoot: work, emittedValue: result.output,
      filePathGroups: impactGraphOutputFilePathGroups(result.output), latencyMs: 0,
    });
  } catch { accounting = undefined; }
  return compactImpactProductResponse(accounting === undefined ? result.output : { ...result.output, accounting });
}

/**
 * The counterfactual response SHAPE, measured over the product's own relation
 * objects.
 *
 * THREE DELIBERATE CONSERVATISMS, so a proven reduction is not an artefact of a
 * flattering model:
 *
 *   1. `fixedCharacters` is lifted verbatim from the REAL response, so the model
 *      never invents a cheaper metadata block than the one that actually ships —
 *      including `richSummary` and `summary.consumers`, which the census makes
 *      largely redundant but which the output schema still requires.
 *   2. The graph restatement is NOT set to zero. `nodes`, `edges` and `view` are
 *      required schema fields, so the model keeps paying for them — but at the
 *      size they would be if they were rebuilt from the PROJECTED relations
 *      alone, which is what "restatement yields in lockstep with evidence"
 *      actually means. Per-unit costs come from the shipped response's own
 *      serialization, not from an estimate.
 *   3. Because that restatement cost depends on how many relations are
 *      projected, the two are solved together: `k` grows only while the whole
 *      response — fixed + census + restatement(k) + evidence(k) — still fits the
 *      same ceiling the shipped response was measured against.
 */
function counterfactual(shipped: any, universe: readonly RelationLike[], maxTokens: number) {
  const fixed = size(shipped)
    - size(shipped.nodes) - size(shipped.edges) - size(shipped.view) - size(shipped.paths)
    - size(shipped.directRelations);
  const census = censusFromUniverse(universe);
  // Continuation ref: a fixed-width self-describing token. 96 chars is the
  // measured width of the shipped implementation's encoded ref; the model uses
  // the same constant so its budget is not flattered.
  const REF_CHARACTERS = 96;
  const censusChars = censusBlockCharacters(census, universe.length, "x".repeat(REF_CHARACTERS));
  // THE PRODUCT'S OWN TWO BOUNDS, not one invented here. `modelVisibleCeiling`
  // is what `impactResponseMeetsEvidenceBudget` measures the five model-visible
  // keys against; `deliveryCeiling` is the `impactResponseFitsEnvelope` gate over
  // the complete serialized response, including the max(800, 15%) metadata
  // allowance. Charging the census against the STRICTER of the two is the
  // conservative choice: it makes the census compete with the evidence.
  const modelVisibleCeiling = maxTokens * 4;
  const deliveryCeiling = (maxTokens + Math.max(800, Math.ceil(maxTokens * 0.15))) * 4;

  // Per-unit restatement costs, taken from the shipped response so the model
  // charges the product's own serialization. Falls back to the observed medians
  // when the shipped response happens to carry none of that projection.
  const perNode = shipped.nodes.length > 0 ? size(shipped.nodes) / shipped.nodes.length : 270;
  const perEdge = shipped.edges.length > 0 ? size(shipped.edges) / shipped.edges.length : 407;
  const perViewLine = (shipped.view?.lines?.length ?? 0) > 0 ? size(shipped.view) / shipped.view.lines.length : 118;
  // Every projected relation drags in its counterpart node, its edge, and its
  // view line; the root node and the view header are paid once.
  const overheadPerRelation = Math.round(perNode + perEdge + perViewLine);
  const baseRestatement = Math.round(perNode + perViewLine);

  const available = Math.min(
    modelVisibleCeiling - censusChars - baseRestatement,
    deliveryCeiling - fixed - censusChars - baseRestatement,
  );
  const projection = projectEvidence(universe, Math.max(0, available), overheadPerRelation);
  const restatementCharacters = baseRestatement + overheadPerRelation * projection.rendered;
  const evidenceCharacters = projection.evidenceCharacters - overheadPerRelation * projection.rendered;
  return {
    census, censusChars, fixedCharacters: fixed,
    restatementCharacters,
    evidenceBudget: Math.max(0, available), evidenceCharacters,
    projection,
    totalCharacters: fixed + censusChars + restatementCharacters + evidenceCharacters,
  };
}

const corpora: any[] = [];
const startLoad = loadAverage();
console.log(`M211 audit label=${LABEL} product=${PRODUCT_ROOT} @ ${productHead.slice(0, 10)} load ${startLoad.join(" ")}`);

for (const spec of corpusSpecs(REPO).filter((s) => CORPORA.includes(s.id))) {
  const work = prepareCorpus(spec, SCRATCH);
  if (work === null) { corpora.push({ id: spec.id, status: "CORPUS_ABSENT" }); continue; }
  const dbPath = path.join(work, ".vtrace/index.sqlite");
  const server: Server = createMcpServer({ context: { repoRoot: work, dbPath } } as any);
  const indexed = await call(server, McpToolId.IndexRepo, { repo_root: work }, "idx");
  if (indexed?.readiness?.status !== "ready") { corpora.push({ id: spec.id, status: "INDEX_NOT_READY" }); continue; }
  const db = new Database(dbPath, { readonly: true });

  // §28 probe ladder: the symbol whose direct incoming `calls` fan-in is closest
  // to each bucket, taken from the graph rather than chosen by hand.
  const fanin = db.query(`
    select s.fq_name as fqn, count(*) as c
    from edges e join symbols s on s.id = e.dst_symbol_id
    where e.edge_type = 'calls' group by s.fq_name order by c desc, s.fq_name asc`).all() as { fqn: string; c: number }[];
  const zeroFanout = db.query(`
    select s.fq_name as fqn from symbols s
    where s.id not in (select dst_symbol_id from edges) order by s.fq_name asc limit 1`).all() as { fqn: string }[];
  const probes: { bucket: number; fqn: string; fanin: number }[] = [];
  for (const bucket of FANOUT_BUCKETS) {
    if (bucket === 0) {
      if (zeroFanout[0] !== undefined) probes.push({ bucket, fqn: zeroFanout[0].fqn, fanin: 0 });
      continue;
    }
    if (fanin.length === 0) continue;
    const hit = fanin.reduce((best, row) => Math.abs(row.c - bucket) < Math.abs(best.c - bucket) ? row : best, fanin[0]!);
    if (!probes.some((probe) => probe.fqn === hit.fqn)) probes.push({ bucket, fqn: hit.fqn, fanin: hit.c });
  }

  const rows: any[] = [];
  for (const probe of probes) {
    // UNIVERSE: the complete truthful direct-relation set at the core's hard bound.
    const universeResult = getImpactGraph(db, { symbolFqn: probe.fqn, depth: SCORER_DEPTH, format: "tree", maxEdges: HARD_MAX_EDGES }, { repoRoot: work });
    if (!universeResult.ok) continue;
    const universe = universeResult.output.directRelations as RelationLike[];
    const truth = censusFromUniverse(universe);

    const t0 = performance.now();
    const shipped = await productResponse(db, work, probe.fqn);
    const shippedMs = performance.now() - t0;
    if (shipped === null) continue;

    const restatement = size(shipped.nodes) + size(shipped.edges) + size(shipped.view) + size(shipped.paths);
    const evidence = size(shipped.directRelations);
    const total = size(shipped);
    const withText = (shipped.directRelations as any[]).filter((relation) => (relation?.evidence?.sourceText ?? "").trim().length > 0).length;
    const model = counterfactual(shipped, universe, 1200);

    rows.push({
      bucket: probe.bucket, fqn: probe.fqn, faninCalls: probe.fanin,
      truth,
      claimed: {
        exactCallerCount: shipped.summary?.consumers?.exactCallerCount ?? null,
        exactReferenceCount: shipped.summary?.consumers?.exactReferenceCount ?? null,
        outgoingDependencyCount: shipped.summary?.consumers?.outgoingDependencyCount ?? null,
        directIncoming: shipped.richSummary?.directIncoming ?? null,
        directOutgoing: shipped.richSummary?.directOutgoing ?? null,
      },
      censusTruthful:
        (shipped.summary?.consumers?.exactCallerCount ?? -1) === truth.exactCallers + truth.resolvedCallers
        || (shipped.summary?.consumers?.exactCallerCount ?? -1) === truth.exactCallers,
      shipped: {
        totalCharacters: total, restatementCharacters: restatement, evidenceCharacters: evidence,
        fixedCharacters: total - restatement - evidence,
        restatementShare: Number((restatement / total).toFixed(4)),
        deliveredRelations: shipped.directRelations.length, deliveredWithSourceText: withText,
        deliveredNodes: shipped.nodes.length, deliveredEdges: shipped.edges.length,
        resultState: shipped.responseBudget?.resultState, latencyMs: Number(shippedMs.toFixed(1)),
      },
      counterfactual: {
        censusCharacters: model.censusChars, fixedCharacters: model.fixedCharacters,
        restatementCharacters: model.restatementCharacters,
        evidenceBudget: model.evidenceBudget, evidenceCharacters: model.evidenceCharacters,
        totalCharacters: model.totalCharacters,
        restatementShare: Number(((model.censusChars + model.restatementCharacters) / model.totalCharacters).toFixed(4)),
        rendered: model.projection.rendered, renderedWithSourceText: model.projection.renderedWithSourceText,
        forms: model.projection.forms, remaining: model.projection.remaining,
      },
    });
    console.log(`  ${spec.id} bucket=${probe.bucket} ${probe.fqn.split("::").pop()} universe=${universe.length} claimed=${rows.at(-1).claimed.exactCallerCount} truth=${truth.exactCallers}+${truth.resolvedCallers} shipped(${shipped.directRelations.length} rel/${withText} text, restate ${restatement}c vs evid ${evidence}c) -> cf(${model.projection.rendered} rel/${model.projection.renderedWithSourceText} text, census ${model.censusChars}c restate ${model.restatementCharacters}c evid ${model.evidenceCharacters}c)`);
  }
  db.close();

  const highFanout = rows.filter((row) => row.truth.directRelations >= 64);
  corpora.push({
    id: spec.id, status: "OK", probes: rows.length,
    censusFalseCount: rows.filter((row) => !row.censusTruthful).length,
    restatementExceedsEvidence: rows.filter((row) => row.shipped.restatementCharacters > row.shipped.evidenceCharacters).length,
    collapsedToOneRelation: rows.filter((row) => row.shipped.deliveredRelations <= 1 && row.truth.directRelations > 1).length,
    zeroSourceBacked: rows.filter((row) => row.shipped.deliveredWithSourceText === 0 && row.truth.relationsWithCallSite > 0).length,
    highFanout: {
      probes: highFanout.length,
      shippedEvidenceMedian: highFanout.length === 0 ? null : percentile(highFanout.map((r) => r.shipped.deliveredWithSourceText), 50),
      counterfactualEvidenceMedian: highFanout.length === 0 ? null : percentile(highFanout.map((r) => r.counterfactual.renderedWithSourceText), 50),
      shippedRestatementShareMedian: highFanout.length === 0 ? null : percentile(highFanout.map((r) => r.shipped.restatementShare), 50),
      counterfactualRestatementShareMedian: highFanout.length === 0 ? null : percentile(highFanout.map((r) => r.counterfactual.restatementShare), 50),
    },
    rows,
  });
}

// -------------------------------------------------------------- §41 verdict
const ok = corpora.filter((corpus) => corpus.status === "OK");
const allRows = ok.flatMap((corpus) => corpus.rows as any[]);
const high = allRows.filter((row) => row.truth.directRelations >= 64);
const evidenceImproves = high.length > 0 && high.every((row) => row.counterfactual.renderedWithSourceText >= row.shipped.deliveredWithSourceText)
  && high.some((row) => row.counterfactual.renderedWithSourceText > row.shipped.deliveredWithSourceText);
const restatementFalls = high.length > 0 && high.every((row) => row.counterfactual.restatementShare < row.shipped.restatementShare);
const censusIsFalseToday = allRows.some((row) => !row.censusTruthful);
const boundedStill = allRows.every((row) => row.counterfactual.totalCharacters <= 80_000);
const reductionProven = evidenceImproves && restatementFalls && censusIsFalseToday && boundedStill;

const report = {
  milestone: "M211", phase: "audit", label: LABEL, productHead,
  generatedAtMs: Date.now(), loadAverage: startLoad, endLoadAverage: loadAverage(),
  orderingAuthority: M211_ORDERING_AUTHORITY,
  frozenMetrics: M211_PRODUCT_METRICS,
  marker: "M211_IMPACT_ARCHITECTURE_AUDITED",
  reductionVerdict: reductionProven ? "M211_ARCHITECTURE_REDUCTION_PROVEN" : "M211_ARCHITECTURE_REDUCTION_NOT_PROVEN",
  reductionInputs: { evidenceImproves, restatementFalls, censusIsFalseToday, boundedStill, highFanoutProbes: high.length },
  corpora,
};
const outPath = path.join(RESULTS, `stage5_m211_audit_${LABEL}.json`);
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nM211_IMPACT_ARCHITECTURE_AUDITED`);
console.log(`${report.reductionVerdict}  evidence=${evidenceImproves} restatement=${restatementFalls} censusFalse=${censusIsFalseToday} bounded=${boundedStill}`);
console.log(`wrote ${outPath} (${createHash("sha256").update(readFileSync(outPath)).digest("hex").slice(0, 12)})`);
