/**
 * M209 — the impact / call-site truth audit. READ-ONLY on the product.
 *
 * For every corpus of the frozen matrix, and for every edge of the frozen A15
 * population (`deriveCallSiteEdges`, the committed derivation), this driver
 * asks three surfaces the same question — the CORE `getImpactGraph` before any
 * envelope, the DEFAULT `get_impact_graph` MCP response the scorer reads, and
 * the `search_logic_flow` surface the scorer publishes beside it — and judges
 * each answer against the file on disk and the index: is the site persisted,
 * inside the caller's span, in a file the index still describes, does its text
 * name the callee, and did the surface show that text or drop it.
 *
 * It then answers the causal question the milestone turns on: if only the
 * product renderer changed, how much frozen A15 coverage is achievable from the
 * truth the index already holds, and would the default budget let it through.
 *
 * The product is loaded from `--product-root` so the predecessor worktree can
 * be audited with the same instrument; the pure rules live in
 * m209CallSiteTruth.ts and the frozen predicate is the committed scorer's.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m209_audit.ts \
 *     --label pre [--product-root <dir>] [--scratch <dir>] [--repeats 3] [--corpora C-SMALL,C-MED,C-LARGE]
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { corpusSpecs, deriveCallSiteEdges, deriveImpactTargets, latencyStats, median, prepareCorpus } from "./m197aFixtures";
import { semanticProjection } from "./m197aScoring";
import {
  callSiteIdentity, callSiteTruthFaults, classifyRenderability, countBy, crossFile, frozenA15Rendered, impactRole,
  impactTokens, strippedEvidenceCharacters, type CallSiteTruthFault, type RelationLike, type RenderabilityClass,
} from "./m209CallSiteTruth";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback; };
const LABEL = argOf("--label", "pre");
const PRODUCT_ROOT = path.resolve(argOf("--product-root", REPO));
const SCRATCH = argOf("--scratch", `/tmp/m209-audit-${LABEL}`);
const REPEATS = Number.parseInt(argOf("--repeats", "3"), 10);
const CORPORA = argOf("--corpora", "C-SMALL,C-MED,C-LARGE").split(",");
/** The frozen scorer's population size and the depth it passes. */
const POPULATION = 50;
const SCORER_DEPTH = 3;
mkdirSync(SCRATCH, { recursive: true });

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const loadAverage = () => { try { return readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).map(Number); } catch { return []; } };
const productHead = Bun.spawnSync(["git", "-C", PRODUCT_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();

const { createMcpServer } = await import(path.join(PRODUCT_ROOT, "src/mcp/server.ts"));
const { McpToolId, MCP_SERVER_SCHEMA } = await import(path.join(PRODUCT_ROOT, "src/mcp/types.ts"));
const { getImpactGraph } = await import(path.join(PRODUCT_ROOT, "src/impact/getImpactGraph.ts"));
const { listSymbolsByFqName } = await import(path.join(PRODUCT_ROOT, "src/db/repositories/symbolsRepository.ts"));
const { getFileByPath } = await import(path.join(PRODUCT_ROOT, "src/db/repositories/filesRepository.ts"));

type Server = { handleRequest: (request: unknown) => Promise<any> };
const call = async (server: Server, toolId: string, input: unknown, id = "m209"): Promise<any> => {
  const res: any = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: id, toolId, input } as any);
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

// ------------------------------------------------------------ substrate

/** What the index HOLDS about call sites, from the schema and the rows, before any surface is consulted. */
function auditSubstrate(db: Database) {
  const tables = new Set((db.query("select name from sqlite_master where type='table'").all() as { name: string }[]).map((r) => r.name));
  const columns = tables.has("edge_call_sites")
    ? (db.query("pragma table_info(edge_call_sites)").all() as { name: string; type: string }[]).map((c) => `${c.name} ${c.type}`)
    : [];
  const one = (sql: string): number => (db.query(sql).get() as any)?.c ?? 0;
  const callsEdges = one("select count(*) c from edges where edge_type='calls'");
  const callsWithSite = one("select count(*) c from edges e where e.edge_type='calls' and exists (select 1 from edge_call_sites s where s.edge_id=e.id)");
  const sites = one("select count(*) c from edge_call_sites s join edges e on e.id=s.edge_id where e.edge_type='calls'");
  const precision = Object.fromEntries((db.query("select precision, count(*) c from edge_call_sites group by precision").all() as any[]).map((r) => [r.precision, r.c]));
  const multiSite = one("select count(*) c from (select edge_id from edge_call_sites group by edge_id having count(*) > 1)");
  const crossFileCalls = one("select count(*) c from edges e join symbols a on a.id=e.src_symbol_id join symbols b on b.id=e.dst_symbol_id where e.edge_type='calls' and a.file_id <> b.file_id");
  const sitesOutsideCallerSpan = one("select count(*) c from edge_call_sites s join edges e on e.id=s.edge_id join symbols a on a.id=e.src_symbol_id where e.edge_type='calls' and (s.start_line < a.start_line or s.start_line > a.end_line)");
  const referencesEdges = one("select count(*) c from edges where edge_type='references'");
  const referencesWithSite = one("select count(*) c from edges e where e.edge_type='references' and exists (select 1 from edge_call_sites s where s.edge_id=e.id)");
  const importsEdges = one("select count(*) c from edges where edge_type='imports'");
  const fanIn = db.query("select s.fq_name fqn, count(*) c from edges e join symbols s on s.id=e.dst_symbol_id where e.edge_type='calls' group by s.fq_name order by c desc, s.fq_name asc limit 3").all() as any[];
  return {
    edgeCallSitesTable: tables.has("edge_call_sites"), columns,
    edgeTypes: Object.fromEntries((db.query("select edge_type, count(*) c from edges group by edge_type").all() as any[]).map((r) => [r.edge_type, r.c])),
    calls: { edges: callsEdges, edgesWithPersistedSite: callsWithSite, edgesWithoutSite: callsEdges - callsWithSite,
      sitePercent: callsEdges ? +(100 * callsWithSite / callsEdges).toFixed(2) : null, sites, precision, edgesWithMultipleSites: multiSite,
      crossFileEdges: crossFileCalls, sameFileEdges: callsEdges - crossFileCalls, sitesOutsideCallerSpan },
    references: { edges: referencesEdges, edgesWithPersistedSite: referencesWithSite },
    imports: { edges: importsEdges },
    highestFanIn: fanIn,
    // What the index cannot express, stated rather than inferred later.
    absent: [
      "potential (unresolved-receiver) callers: never persisted; discovered per response by callerCoverage",
      "call-site source text: never persisted; rebuilt from the file on disk under the index's hash check",
      "graph distance: not a column; computed per traversal",
    ],
  };
}

// --------------------------------------------------------------- items

interface ItemRecord {
  corpus: string; from: string; to: string; callee: string; edgeIndex: number;
  crossFile: boolean | null;
  delivery?: { totalCharacters: number; ceilingCharacters: number; directRelationsCharacters: number; nodesCharacters: number; edgesCharacters: number; viewCharacters: number; pathsCharacters: number; fixedCharacters: number; deliveredRelations: number };
  core: { found: boolean; relations: number; rank: number; relationCharacters: number | null; medianRelationCharacters: number | null; kind?: string; strength?: string; direction?: string; locationKind?: string; callSites?: number; sourceText?: string; referenceName?: string; faults: CallSiteTruthFault[]; role?: string; identity?: string };
  product: { found: boolean; locationKind?: string; callSites?: number; sourceText?: string; referenceName?: string; evidenceKeys: string[]; faults: CallSiteTruthFault[]; frozenRendered: boolean;
    retainedRelations: number; requestedMaxTokens: number; modelVisibleTokens: number; totalTokens: number; totalCeiling: number; compactedFields: string[]; resultState: string; latencyMs: number[]; semanticHashes: string[] };
  flow: { found: boolean; sourceText?: string; frozenRendered: boolean };
  renderability: RenderabilityClass;
  counterfactual: { strippedCharacters: number; strippedTokens: number };
  declaredSpan?: string; spanText?: string;
}

const perCorpus: any[] = [];
const itemRows: ItemRecord[] = [];
const startLoad = loadAverage();
console.log(`M209 audit label=${LABEL} product=${PRODUCT_ROOT} @ ${productHead.slice(0, 10)} load ${startLoad.join(" ")}`);

for (const spec of corpusSpecs(REPO).filter((s) => CORPORA.includes(s.id))) {
  const work = prepareCorpus(spec, SCRATCH);
  if (work === null) { perCorpus.push({ id: spec.id, status: "CORPUS_ABSENT" }); continue; }
  const dbPath = path.join(work, ".vtrace/index.sqlite");
  const server: Server = createMcpServer({ context: { repoRoot: work, dbPath } } as any);
  const indexed = await call(server, McpToolId.IndexRepo, { repo_root: work }, "idx");
  if (indexed?.readiness?.status !== "ready") { perCorpus.push({ id: spec.id, status: "INDEX_NOT_READY", indexed }); continue; }
  const db = new Database(dbPath, { readonly: true });

  const substrate = auditSubstrate(db);
  const pairs = deriveCallSiteEdges(db, POPULATION);
  const fileCache = new Map<string, { lines: string[] | null; identity: { sizeBytes: number; contentHash: string } | null }>();
  const fileOnDisk = (rel: string) => {
    if (!fileCache.has(rel)) {
      try {
        const bytes = readFileSync(path.join(work, rel));
        // The identity is over the raw bytes, exactly as the indexer computes it.
        fileCache.set(rel, { lines: bytes.toString("utf8").split("\n"), identity: { sizeBytes: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") } });
      } catch { fileCache.set(rel, { lines: null, identity: null }); }
    }
    return fileCache.get(rel)!;
  };

  const items: ItemRecord[] = [];
  let edgeIndex = 0;
  for (const pair of pairs) {
    edgeIndex += 1;
    const callerSymbol = listSymbolsByFqName(db, pair.start)[0];
    const calleeSymbol = listSymbolsByFqName(db, pair.end)[0];
    const callee: string = calleeSymbol?.localName ?? pair.end.split("::").pop()!.split(".").pop()!;
    const callerFile = callerSymbol?.filePath;
    const disk = callerFile === undefined ? { lines: null, identity: null } : fileOnDisk(callerFile);
    const indexedFile = callerFile === undefined ? undefined : getFileByPath(db, callerFile);
    const truthInputFor = (relation: RelationLike) => ({
      relation, sourceLines: disk.lines, indexedFile: indexedFile === undefined ? null : { sizeBytes: indexedFile.sizeBytes, contentHash: indexedFile.contentHash },
      actualFile: disk.identity, callerSpan: callerSymbol === undefined ? null : { startLine: callerSymbol.startLine, endLine: callerSymbol.endLine }, expectedCallee: callee,
    });

    // CORE: the engine before any envelope, at the scorer's own request shape.
    const coreResult = getImpactGraph(db, { symbolFqn: pair.end, depth: SCORER_DEPTH, format: "tree" }, { repoRoot: work });
    const coreRelations: RelationLike[] = coreResult.ok ? (coreResult.output.directRelations as RelationLike[]) : [];
    // The scorer reads the DELIVERED list in its delivered order, so the caller's
    // position in the core's ordered relations is what a projection would have to
    // retain down to. -1 means the core's own maxEdges slice already lost it.
    const coreRank = coreRelations.findIndex((r) => r.source?.symbol === pair.start);
    const coreRelation: RelationLike | null = coreRelations.find((r) => r.source?.symbol === pair.start && r.direction === "incoming") ?? null;
    const coreFaults = coreRelation === null ? [] : callSiteTruthFaults(truthInputFor(coreRelation));

    // PRODUCT: the default MCP response the frozen scorer reads, repeated for determinism.
    const latency: number[] = []; const hashes = new Set<string>();
    let product: any = null;
    for (let i = 0; i < REPEATS; i += 1) {
      const t0 = performance.now();
      product = await call(server, McpToolId.GetImpactGraph, { repo_root: work, symbol_fqn: pair.end, depth: SCORER_DEPTH });
      latency.push(+(performance.now() - t0).toFixed(2));
      hashes.add(sha(JSON.stringify(semanticProjection(product))));
    }
    const productRelation: RelationLike | null = (product?.directRelations ?? []).find((r: any) => r.source?.symbol === pair.start) ?? null;
    const productFaults = productRelation === null ? [] : callSiteTruthFaults(truthInputFor(productRelation));

    // FLOW: the surface the scorer publishes beside the verdict.
    const flow = await call(server, McpToolId.SearchLogicFlow, { repo_root: work, start: pair.start, end: pair.end });
    const flowRelation: RelationLike | null = flow?.paths?.[0]?.steps?.[0]?.relation ?? null;

    const relationSizes = coreRelations.map((r) => JSON.stringify(r).length).sort((a, b) => a - b);
    const medianChars = relationSizes.length === 0 ? null : relationSizes[Math.floor(relationSizes.length / 2)]!;
    // The response's own cost decomposition, from the delivered object: what the
    // typed evidence costs, what its three graph restatements cost, and what is
    // left over as fixed metadata no projection change can shed.
    const size = (v: unknown) => JSON.stringify(v ?? null).length;
    const delivery = product === null ? null : {
      totalCharacters: size(product), ceilingCharacters: (product?.responseBudget?.totalCeiling ?? 0) * 4,
      directRelationsCharacters: size(product.directRelations), nodesCharacters: size(product.nodes),
      edgesCharacters: size(product.edges), viewCharacters: size(product.view), pathsCharacters: size(product.paths),
      fixedCharacters: size(product) - size(product.directRelations) - size(product.nodes) - size(product.edges) - size(product.view) - size(product.paths),
      deliveredRelations: product.directRelations?.length ?? 0,
    };
    const site = coreRelation?.evidence?.callSites?.[0];
    const spanText = site !== undefined && disk.lines !== null ? disk.lines.slice(site.startLine - 1, site.endLine).join("\n") : undefined;
    const stripped = coreRelation === null ? 0 : strippedEvidenceCharacters(coreRelation.evidence ?? {});
    const item: ItemRecord = {
      corpus: spec.id, from: pair.start, to: pair.end, callee, edgeIndex,
      crossFile: coreRelation === null ? null : crossFile(coreRelation),
      core: coreRelation === null ? { found: false, relations: coreRelations.length, rank: coreRank, relationCharacters: null, medianRelationCharacters: medianChars, faults: [] } : {
        found: true, relations: coreRelations.length, rank: coreRank,
        relationCharacters: JSON.stringify(coreRelation).length, medianRelationCharacters: medianChars, kind: coreRelation.kind, strength: coreRelation.strength, direction: coreRelation.direction,
        locationKind: coreRelation.evidence?.locationKind, callSites: coreRelation.evidence?.callSiteCount,
        sourceText: coreRelation.evidence?.sourceText, referenceName: coreRelation.evidence?.referenceName,
        faults: coreFaults, role: impactRole(coreRelation), identity: callSiteIdentity(coreRelation),
      },
      product: {
        found: productRelation !== null, locationKind: productRelation?.evidence?.locationKind, callSites: productRelation?.evidence?.callSiteCount,
        sourceText: productRelation?.evidence?.sourceText, referenceName: productRelation?.evidence?.referenceName,
        evidenceKeys: Object.keys(productRelation?.evidence ?? {}).sort(), faults: productFaults, frozenRendered: frozenA15Rendered(productRelation),
        retainedRelations: product?.directRelations?.length ?? 0,
        requestedMaxTokens: product?.responseBudget?.requestedMaxTokens ?? -1, modelVisibleTokens: product?.responseBudget?.modelVisibleEstimatedTokens ?? -1,
        totalTokens: product?.responseBudget?.estimatedTotalTokens ?? -1, totalCeiling: product?.responseBudget?.totalCeiling ?? -1,
        compactedFields: product?.responseBudget?.compactedFields ?? [], resultState: product?.responseBudget?.resultState ?? "?",
        latencyMs: latency, semanticHashes: [...hashes],
      },
      flow: { found: flowRelation !== null, sourceText: flowRelation?.evidence?.sourceText, frozenRendered: frozenA15Rendered(flowRelation) },
      renderability: classifyRenderability(coreRelation, coreFaults),
      ...(delivery === null ? {} : { delivery }),
      counterfactual: { strippedCharacters: stripped, strippedTokens: impactTokens(stripped) },
      ...(site === undefined || callerFile === undefined ? {} : { declaredSpan: `${callerFile}:${site.startLine}-${site.endLine}` }),
      ...(spanText === undefined ? {} : { spanText: spanText.slice(0, 200) }),
    };
    items.push(item);
  }

  // Counterfactual budget: would the default envelope carry the stripped keys
  // for EVERY retained relation of the response, not just the scored one?
  // Measured per response from the product's own responseBudget and the core's
  // evidence for the retained relation ids.
  const budgetRows = items;
  const fitsWithoutShedding = budgetRows.filter((it) => it.product.found
    && it.product.modelVisibleTokens + it.counterfactual.strippedTokens <= it.product.requestedMaxTokens).length;
  const fitsWithinCeiling = budgetRows.filter((it) => it.product.found
    && it.product.totalTokens + it.counterfactual.strippedTokens <= it.product.totalCeiling).length;

  // Whole-response counterfactual over the retained set: the sum of stripped
  // characters across ALL retained direct relations of each scored response.
  const wholeResponse: any[] = [];
  for (const pair of pairs.slice(0, POPULATION)) {
    const coreResult = getImpactGraph(db, { symbolFqn: pair.end, depth: SCORER_DEPTH, format: "tree" }, { repoRoot: work });
    const product = await call(server, McpToolId.GetImpactGraph, { repo_root: work, symbol_fqn: pair.end, depth: SCORER_DEPTH });
    if (!coreResult.ok || !product?.responseBudget) continue;
    const retained = new Set((product.directRelations ?? []).map((r: any) => r.id));
    const strippedAll = (coreResult.output.directRelations as RelationLike[])
      .filter((r) => retained.has(r.id)).reduce((n, r) => n + strippedEvidenceCharacters(r.evidence ?? {}), 0);
    const withSourceText = (coreResult.output.directRelations as RelationLike[]).filter((r) => retained.has(r.id) && typeof r.evidence?.sourceText === "string").length;
    wholeResponse.push({
      to: pair.end, retained: retained.size, retainedWithCoreSourceText: withSourceText,
      strippedTokensAllRetained: impactTokens(strippedAll),
      modelVisibleTokens: product.responseBudget.modelVisibleEstimatedTokens, requestedMaxTokens: product.responseBudget.requestedMaxTokens,
      totalTokens: product.responseBudget.estimatedTotalTokens, totalCeiling: product.responseBudget.totalCeiling,
      wouldMeetEvidenceTarget: product.responseBudget.modelVisibleEstimatedTokens + impactTokens(strippedAll) <= product.responseBudget.requestedMaxTokens,
      wouldFitCeiling: product.responseBudget.estimatedTotalTokens + impactTokens(strippedAll) <= product.responseBudget.totalCeiling,
    });
  }

  // High-fan-in probe: the largest impact result the corpus can produce at the
  // default bounds and at the hard bounds, so bounded behaviour is a number.
  const [top] = deriveImpactTargets(db, 1);
  const fanIn = top === undefined ? null : await (async () => {
    const def = await call(server, McpToolId.GetImpactGraph, { repo_root: work, symbol_fqn: top, depth: SCORER_DEPTH });
    const max = await call(server, McpToolId.GetImpactGraph, { repo_root: work, symbol_fqn: top, depth: SCORER_DEPTH, max_edges: 2000, max_tokens: 20000 });
    const size = (o: any) => ({ characters: JSON.stringify(o ?? {}).length, directRelations: o?.directRelations?.length ?? 0,
      withSourceText: (o?.directRelations ?? []).filter((r: any) => typeof r.evidence?.sourceText === "string").length,
      edgesInspected: o?.diagnostics?.edgesInspected ?? null, retainedEdges: o?.responseBudget?.retainedEdges ?? null, omittedEdges: o?.responseBudget?.omittedEdges ?? null,
      totalTokens: o?.responseBudget?.estimatedTotalTokens ?? null, totalCeiling: o?.responseBudget?.totalCeiling ?? null, resultState: o?.responseBudget?.resultState ?? null });
    return { symbol: top, incomingCalls: substrate.highestFanIn[0]?.c ?? null, default: size(def), hardBounds: size(max) };
  })();

  db.close();
  const classes = countBy(items.map((it) => it.renderability));
  const eligible = items.length;
  // -------------------------------------------------- the delivery ceiling
  //
  // The frozen metric needs the DELIVERED response to contain the scored
  // caller's relation. So the achievable coverage of any renderer-only repair
  // is bounded twice: by the core's own ordered slice (a caller past it was
  // never a candidate) and by how many relations the default envelope can
  // afford. This computes the second bound from the product's OWN numbers —
  // each response's fixed metadata and its own ceiling — under a range of
  // per-relation costs, including costs no representation could actually reach,
  // so the bound is an upper bound and not a forecast of one design.
  const ranks = items.map((it) => it.core.rank);
  // Renderable AND affordable: an item can only be scored if the truth supports
  // a rendering and the response can carry the relation at that rank.
  const affordable = (perRelation: number) => items.filter((it) => it.core.rank >= 0
    && it.renderability === "RENDERABLE_FROM_EXISTING_TRUTH" && it.delivery !== undefined
    && it.delivery.fixedCharacters + (it.core.rank + 1) * perRelation <= it.delivery.ceilingCharacters).length;
  const deliveryCeiling = {
    callerInCoreOrder: ranks.filter((r) => r >= 0).length,
    callerLostToCoreSlice: ranks.filter((r) => r < 0).length,
    rankDistribution: { rank0: ranks.filter((r) => r === 0).length, atMost2: ranks.filter((r) => r >= 0 && r <= 2).length,
      atMost6: ranks.filter((r) => r >= 0 && r <= 6).length, atMost9: ranks.filter((r) => r >= 0 && r <= 9).length,
      max: Math.max(...ranks), medianCoreRelations: [...items.map((it) => it.core.relations)].sort((a, b) => a - b)[Math.floor(items.length / 2)] ?? null },
    medianCharacters: {
      total: median(items.map((it) => it.delivery?.totalCharacters ?? 0)),
      fixed: median(items.map((it) => it.delivery?.fixedCharacters ?? 0)),
      graphRestatements: median(items.map((it) => (it.delivery?.nodesCharacters ?? 0) + (it.delivery?.edgesCharacters ?? 0) + (it.delivery?.viewCharacters ?? 0))),
      directRelations: median(items.map((it) => it.delivery?.directRelationsCharacters ?? 0)),
      perCoreRelation: median(items.map((it) => it.core.medianRelationCharacters ?? 0)),
      ceiling: median(items.map((it) => it.delivery?.ceilingCharacters ?? 0)),
    },
    deliveredRelations: countBy(items.map((it) => String(it.delivery?.deliveredRelations ?? 0))),
    // Upper bound on frozen A15 for a renderer-only repair, per relation cost.
    achievableIfRelationCosts: Object.fromEntries([200, 500, 700, 900, 1100].map((c) => [c,
      { fits: affordable(c), percent: items.length ? +(100 * affordable(c) / items.length).toFixed(2) : null }])),
  };

  const summary = {
    id: spec.id, language: spec.language, productHead, substrate,
    population: { eligible, derivation: "deriveCallSiteEdges(db, 50): calls edges with an ordinal-0 persisted site, src != dst, by edge id" },
    renderability: classes,
    frozen: {
      impactRendered: items.filter((it) => it.product.frozenRendered).length,
      impactRenderPercent: eligible ? +(100 * items.filter((it) => it.product.frozenRendered).length / eligible).toFixed(2) : null,
      flowRendered: items.filter((it) => it.flow.frozenRendered).length,
      flowRenderPercent: eligible ? +(100 * items.filter((it) => it.flow.frozenRendered).length / eligible).toFixed(2) : null,
    },
    core: {
      relationFound: items.filter((it) => it.core.found).length,
      withSourceText: items.filter((it) => typeof it.core.sourceText === "string").length,
      withReferenceName: items.filter((it) => typeof it.core.referenceName === "string").length,
      edgeSite: items.filter((it) => it.core.locationKind === "edge_site").length,
      faultless: items.filter((it) => it.core.found && it.core.faults.length === 0).length,
      faults: countBy(items.flatMap((it) => it.core.faults)),
      byStrength: countBy(items.map((it) => it.core.strength ?? "absent")),
      byLocationKind: countBy(items.map((it) => it.core.locationKind ?? "absent")),
      crossFile: items.filter((it) => it.crossFile === true).length, sameFile: items.filter((it) => it.crossFile === false).length,
    },
    product: {
      relationFound: items.filter((it) => it.product.found).length,
      withSourceText: items.filter((it) => typeof it.product.sourceText === "string").length,
      withReferenceName: items.filter((it) => typeof it.product.referenceName === "string").length,
      evidenceKeySets: countBy(items.map((it) => it.product.evidenceKeys.join(","))),
      compactedFieldSets: countBy(items.map((it) => it.product.compactedFields.join("|"))),
      resultStates: countBy(items.map((it) => it.product.resultState)),
      faults: countBy(items.flatMap((it) => it.product.faults)),
      deterministic: items.every((it) => it.product.semanticHashes.length === 1),
      latency: latencyStats(items.flatMap((it) => it.product.latencyMs)),
    },
    deliveryCeiling,
    counterfactual: {
      renderableFromExistingTruth: classes.RENDERABLE_FROM_EXISTING_TRUTH ?? 0,
      achievableImpactRenderPercent: eligible ? +(100 * (classes.RENDERABLE_FROM_EXISTING_TRUTH ?? 0) / eligible).toFixed(2) : null,
      scoredRelationFitsEvidenceTarget: fitsWithoutShedding, scoredRelationFitsCeiling: fitsWithinCeiling,
      wholeResponse: {
        responses: wholeResponse.length,
        meetEvidenceTargetWithAllStrippedKeys: wholeResponse.filter((r) => r.wouldMeetEvidenceTarget).length,
        fitCeilingWithAllStrippedKeys: wholeResponse.filter((r) => r.wouldFitCeiling).length,
        maxStrippedTokens: Math.max(0, ...wholeResponse.map((r) => r.strippedTokensAllRetained)),
        medianStrippedTokens: wholeResponse.length ? [...wholeResponse.map((r) => r.strippedTokensAllRetained)].sort((a, b) => a - b)[Math.floor(wholeResponse.length / 2)] : null,
        rows: wholeResponse,
      },
    },
    fanIn,
    examples: items.filter((it) => it.renderability === "RENDERABLE_FROM_EXISTING_TRUTH").slice(0, 3)
      .map((it) => ({ from: it.from, to: it.to, role: it.core.role, declaredSpan: it.declaredSpan, coreSourceText: it.core.sourceText, productSourceText: it.product.sourceText ?? null })),
  };
  perCorpus.push(summary);
  itemRows.push(...items);
  console.log(`${spec.id.padEnd(8)} eligible ${eligible} | core text ${summary.core.withSourceText} faultless ${summary.core.faultless} | frozen impact ${summary.frozen.impactRenderPercent}% flow ${summary.frozen.flowRenderPercent}% | truth renderable ${summary.counterfactual.achievableImpactRenderPercent}% | delivered-caller ceiling ${deliveryCeiling.achievableIfRelationCosts[500].percent}% (rank<=2 ${deliveryCeiling.rankDistribution.atMost2}, lost to slice ${deliveryCeiling.callerLostToCoreSlice}) | ${JSON.stringify(classes)}`);
}

const out = {
  milestone: "M209", instrument: "run_stage5_m209_audit.ts", label: LABEL, productRoot: PRODUCT_ROOT, productHead,
  repeats: REPEATS, scratch: SCRATCH, hardware: { cpus: navigator.hardwareConcurrency, loadAverageAtStart: startLoad, loadAverageAtEnd: loadAverage() },
  frozenRule: "callSiteIsRendered (m197aScoring.ts): evidence.sourceText non-empty and includes evidence.referenceName; scored on get_impact_graph directRelations for the caller, C-LARGE, 50 eligible, MATCH >= 90%, EXCEED 100%",
  corpora: perCorpus,
};
writeFileSync(path.join(RESULTS, `stage5_m209_audit_${LABEL}.json`), `${JSON.stringify(out, null, 2)}\n`);
writeFileSync(path.join(RESULTS, `stage5_m209_items_${LABEL}.jsonl`), itemRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`wrote results/stage5_m209_audit_${LABEL}.json and stage5_m209_items_${LABEL}.jsonl`);
