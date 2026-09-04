/**
 * M210 — the impact RELATION-ALLOCATION audit. READ-ONLY on the product.
 *
 * M209 established that frozen A15's residual is not a rendering fault: the
 * default `get_impact_graph` response can now render a truthful call line, but
 * the scored caller is usually not in it. This driver asks WHY, and it asks it
 * mechanically rather than from the shape of the ladder's source.
 *
 * For every corpus and every edge of the frozen A15 population it recovers
 * three views of the same question and compares them:
 *
 *   UNIVERSE   the complete truthful direct-relation set, by asking the core
 *              for the hard maximum instead of the default bound, so a caller
 *              that the default slice never considered is visible as such;
 *   SLICE      the core's own default relation slice, which is what any
 *              projection could have retained down to;
 *   DELIVERED  the default MCP response the frozen scorer actually reads.
 *
 * It then runs COUNTERFACTUALS through the product's OWN unmodified envelope.
 * Every arm is a pure pre-transform of the core output — a permutation of the
 * relations, or a projection dropped before the envelope sees it — handed to
 * `compactImpactProductResponse` exactly as `src/mcp/tools.ts` hands it the
 * real thing. Nothing about budget arithmetic, ladder order or rendering is
 * re-implemented here, so an arm's result is the product's answer to a
 * different input and not this file's opinion about one. Arm `CONTROL` is the
 * identity transform and is checked against the real MCP response; if it ever
 * disagrees, the instrument is wrong and the run says so.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m210_audit.ts \
 *     --label pre [--product-root <dir>] [--scratch <dir>] [--repeats 3]
 *     [--corpora C-SMALL,C-MED,C-LARGE] [--sweep]
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { corpusSpecs, deriveCallSiteEdges, latencyStats, median, prepareCorpus } from "./m197aFixtures";
import { semanticProjection } from "./m197aScoring";
import {
  callSiteIdentity, callSiteTruthFaults, classifyRenderability, countBy, crossFile,
  frozenA15Rendered, impactRole, type RelationLike,
} from "./m209CallSiteTruth";
import {
  ALLOCATION_POLICIES, A15_MISS_CLASSES, IMPACT_LANES, affordabilityForm, classifyA15Miss,
  isWeakerLane, occupancy, relationLane, responseAnatomy, type A15MissInput,
} from "./m210RelationAllocation";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback; };
const LABEL = argOf("--label", "pre");
const PRODUCT_ROOT = path.resolve(argOf("--product-root", REPO));
const SCRATCH = argOf("--scratch", `/tmp/m210-audit-${LABEL}`);
const REPEATS = Number.parseInt(argOf("--repeats", "3"), 10);
const CORPORA = argOf("--corpora", "C-SMALL,C-MED,C-LARGE").split(",");
const RUN_SWEEP = args.includes("--sweep");
/** The frozen scorer's population size, depth and default request shape. */
const POPULATION = 50;
const SCORER_DEPTH = 3;
/** The core's own hard maximum: what "the complete truthful universe" means here. */
const HARD_MAX_EDGES = 2000;
mkdirSync(SCRATCH, { recursive: true });

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const loadAverage = () => { try { return readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).map(Number); } catch { return []; } };
const productHead = Bun.spawnSync(["git", "-C", PRODUCT_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();

const { createMcpServer } = await import(path.join(PRODUCT_ROOT, "src/mcp/server.ts"));
const { McpToolId, MCP_SERVER_SCHEMA } = await import(path.join(PRODUCT_ROOT, "src/mcp/types.ts"));
const { getImpactGraph } = await import(path.join(PRODUCT_ROOT, "src/impact/getImpactGraph.ts"));
const { compactImpactProductResponse } = await import(path.join(PRODUCT_ROOT, "src/impact/impactResponseEnvelope.ts"));
const { buildContextAccounting, impactGraphOutputFilePathGroups } = await import(path.join(PRODUCT_ROOT, "src/metrics/contextAccounting.ts"));
const { listSymbolsByFqName } = await import(path.join(PRODUCT_ROOT, "src/db/repositories/symbolsRepository.ts"));
const { getFileByPath } = await import(path.join(PRODUCT_ROOT, "src/db/repositories/filesRepository.ts"));

type Server = { handleRequest: (request: unknown) => Promise<any> };
const call = async (server: Server, toolId: string, input: unknown, id = "m210"): Promise<any> => {
  const res: any = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: id, toolId, input } as any);
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

/**
 * The product's own pre-envelope pipeline, replicated call-for-call from
 * `src/mcp/tools.ts`: build the graph, attach best-effort accounting computed
 * over the UNTRANSFORMED output (accounting precedes compaction there too),
 * then hand the result to the envelope. `transform` is the only thing this
 * differs from the tool by, and for the control arm it is the identity.
 */
async function envelopeArm(
  db: Database, work: string, symbolFqn: string,
  transform: (output: any) => any,
  overrides: Record<string, unknown> = {},
): Promise<any | null> {
  const result = getImpactGraph(db, { symbolFqn, depth: SCORER_DEPTH, format: "tree", ...overrides }, { repoRoot: work, measureTiming: true });
  if (!result.ok) return null;
  let accounting: any;
  try {
    accounting = await buildContextAccounting({
      repoRoot: work, emittedValue: result.output,
      filePathGroups: impactGraphOutputFilePathGroups(result.output), latencyMs: 0,
    });
  } catch { accounting = undefined; }
  const withAccounting = accounting === undefined ? result.output : { ...result.output, accounting };
  return compactImpactProductResponse(transform(withAccounting));
}

/** A pre-transform that permutes `directRelations` and nothing else. */
const reorderArm = (policy: (relations: readonly RelationLike[]) => RelationLike[]) =>
  (output: any) => ({ ...output, directRelations: policy(output.directRelations as RelationLike[]) });

/**
 * A pre-transform that hands the envelope the SAME relations but no legacy
 * compatibility edge list. The envelope rebuilds `nodes` and `view` from
 * whatever edges plus relation endpoints remain, so this is the shape of a
 * response whose graph RESTATEMENT yields before its evidence does — the
 * allocation question §8 asks, expressed without touching relation truth,
 * relation count, or per-relation content.
 */
const withoutCompatibilityEdges = (output: any) => ({ ...output, edges: [] });

const ARMS: Readonly<Record<string, (output: any) => any>> = {
  CONTROL: (output) => output,
  P1_LANE_AUTHORITY: reorderArm(ALLOCATION_POLICIES.P1_LANE_AUTHORITY!),
  P2_GROUNDED_FIRST: reorderArm(ALLOCATION_POLICIES.P2_GROUNDED_FIRST!),
  P3_LANE_THEN_GROUNDED: reorderArm(ALLOCATION_POLICIES.P3_LANE_THEN_GROUNDED!),
  P4_LANE_ROUND_ROBIN: reorderArm(ALLOCATION_POLICIES.P4_LANE_ROUND_ROBIN!),
  E1_NO_COMPAT_EDGES: withoutCompatibilityEdges,
  E2_NO_COMPAT_EDGES_LANE: (output) => withoutCompatibilityEdges(reorderArm(ALLOCATION_POLICIES.P1_LANE_AUTHORITY!)(output)),
  E3_NO_COMPAT_EDGES_GROUNDED: (output) => withoutCompatibilityEdges(reorderArm(ALLOCATION_POLICIES.P3_LANE_THEN_GROUNDED!)(output)),
};

/** Capacity widths for the §11 sweep, stated as multiples of the shipped default. */
const SWEEP_EDGES = [64, 80, 96, 128, 256, 2000] as const;
const SWEEP_TOKENS = [1200, 1500, 1800, 2400, 4800, 20000] as const;

const perCorpus: any[] = [];
const itemRows: any[] = [];
const startLoad = loadAverage();
console.log(`M210 audit label=${LABEL} product=${PRODUCT_ROOT} @ ${productHead.slice(0, 10)} load ${startLoad.join(" ")} sweep=${RUN_SWEEP}`);

for (const spec of corpusSpecs(REPO).filter((s) => CORPORA.includes(s.id))) {
  const work = prepareCorpus(spec, SCRATCH);
  if (work === null) { perCorpus.push({ id: spec.id, status: "CORPUS_ABSENT" }); continue; }
  const dbPath = path.join(work, ".vtrace/index.sqlite");
  const server: Server = createMcpServer({ context: { repoRoot: work, dbPath } } as any);
  const indexed = await call(server, McpToolId.IndexRepo, { repo_root: work }, "idx");
  if (indexed?.readiness?.status !== "ready") { perCorpus.push({ id: spec.id, status: "INDEX_NOT_READY", indexed }); continue; }
  const db = new Database(dbPath, { readonly: true });

  const pairs = deriveCallSiteEdges(db, POPULATION);
  const fileCache = new Map<string, { lines: string[] | null; identity: { sizeBytes: number; contentHash: string } | null }>();
  const fileOnDisk = (rel: string) => {
    if (!fileCache.has(rel)) {
      try {
        const bytes = readFileSync(path.join(work, rel));
        fileCache.set(rel, { lines: bytes.toString("utf8").split("\n"), identity: { sizeBytes: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") } });
      } catch { fileCache.set(rel, { lines: null, identity: null }); }
    }
    return fileCache.get(rel)!;
  };

  const items: any[] = [];
  const armTotals: Record<string, { scored: number; delivered: number; relations: number[]; characters: number[]; states: string[] }> = {};
  for (const arm of Object.keys(ARMS)) armTotals[arm] = { scored: 0, delivered: 0, relations: [], characters: [], states: [] };
  const sweepTotals: Record<string, { scored: number; relations: number[]; characters: number[]; withText: number[]; latencyMs: number[]; states: string[] }> = {};

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
    const isTarget = (relation: any) => relation?.source?.symbol === pair.start;

    // ---- UNIVERSE: the complete truthful direct-relation set at the hard bound.
    const universeResult = getImpactGraph(db, { symbolFqn: pair.end, depth: SCORER_DEPTH, format: "tree", maxEdges: HARD_MAX_EDGES }, { repoRoot: work });
    const universe: RelationLike[] = universeResult.ok ? (universeResult.output.directRelations as RelationLike[]) : [];
    const universeRank = universe.findIndex(isTarget);

    // ---- SLICE: the core's own default relation slice.
    const coreResult = getImpactGraph(db, { symbolFqn: pair.end, depth: SCORER_DEPTH, format: "tree" }, { repoRoot: work });
    const coreRelations: RelationLike[] = coreResult.ok ? (coreResult.output.directRelations as RelationLike[]) : [];
    const coreSliceRank = coreRelations.findIndex(isTarget);
    const coreRelation: RelationLike | null = coreRelations.find((r) => isTarget(r) && r.direction === "incoming") ?? null;
    const coreFaults = coreRelation === null ? [] : callSiteTruthFaults(truthInputFor(coreRelation));
    const renderability = classifyRenderability(coreRelation, coreFaults);
    // Is the default slice exactly the head of the universe? A `false` here
    // would mean the two calls are not comparable and every ordinal below is
    // suspect, so it is measured rather than assumed.
    const sliceIsUniverseHead = coreRelations.every((relation, index) => universe[index]?.id === relation.id);

    // ---- DELIVERED: the default MCP response the frozen scorer reads.
    const latency: number[] = []; const hashes = new Set<string>();
    let product: any = null;
    for (let i = 0; i < REPEATS; i += 1) {
      const t0 = performance.now();
      product = await call(server, McpToolId.GetImpactGraph, { repo_root: work, symbol_fqn: pair.end, depth: SCORER_DEPTH });
      latency.push(+(performance.now() - t0).toFixed(2));
      hashes.add(sha(JSON.stringify(semanticProjection(product))));
    }
    const delivered: RelationLike[] = product?.directRelations ?? [];
    const deliveredRank = delivered.findIndex(isTarget);
    const deliveredRelation = deliveredRank >= 0 ? delivered[deliveredRank]! : null;
    const deliveredHasSourceText = typeof deliveredRelation?.evidence?.sourceText === "string"
      && deliveredRelation.evidence.sourceText.trim().length > 0;

    // ---- occupancy: what the capacity the caller did not get was spent on.
    const targetLane = coreRelation === null ? null : relationLane(coreRelation);
    const ahead = coreSliceRank >= 0 ? coreRelations.slice(0, coreSliceRank) : coreRelations;
    const weakerDelivered = targetLane === null ? 0
      : delivered.filter((relation) => isWeakerLane(relationLane(relation), targetLane)).length;
    const targetIdentity = coreRelation === null ? null : callSiteIdentity(coreRelation);
    const duplicateIdentityDelivered = targetIdentity !== null
      && delivered.some((relation) => !isTarget(relation) && callSiteIdentity(relation) === targetIdentity);

    const missInput: A15MissInput = {
      universeRank, coreSliceRank, deliveredRank, renderability,
      deliveredHasSourceText, frozenRendered: frozenA15Rendered(deliveredRelation),
      duplicateIdentityDelivered, weakerRelationsDelivered: weakerDelivered,
    };
    const missClass = classifyA15Miss(missInput);

    // ---- counterfactual arms through the product's own envelope.
    const arms: Record<string, any> = {};
    for (const [name, transform] of Object.entries(ARMS)) {
      const response = await envelopeArm(db, work, pair.end, transform);
      const armRelation = (response?.directRelations ?? []).find(isTarget) ?? null;
      const anatomy = response === null ? null : responseAnatomy(response);
      const scored = frozenA15Rendered(armRelation);
      arms[name] = {
        scored, deliveredRank: (response?.directRelations ?? []).findIndex(isTarget),
        relations: anatomy?.deliveredRelations ?? 0, characters: anatomy?.totalCharacters ?? 0,
        withSourceText: anatomy?.relationsWithSourceText ?? 0,
        restatementCharacters: anatomy?.restatementCharacters ?? 0,
        resultState: response?.responseBudget?.resultState ?? "?",
        retainedEdges: response?.responseBudget?.retainedEdges ?? -1,
        compactedFields: response?.responseBudget?.compactedFields ?? [],
      };
      const totals = armTotals[name]!;
      if (scored) totals.scored += 1;
      if (arms[name].deliveredRank >= 0) totals.delivered += 1;
      totals.relations.push(arms[name].relations);
      totals.characters.push(arms[name].characters);
      totals.states.push(arms[name].resultState);
    }
    // The instrument's own control: the identity arm must be the product.
    const controlResponse = arms.CONTROL;
    const controlAgrees = controlResponse.scored === missInput.frozenRendered
      && controlResponse.relations === (product?.directRelations?.length ?? 0)
      && controlResponse.resultState === (product?.responseBudget?.resultState ?? "?");

    // ---- capacity sweep, on the real tool at widened bounds.
    const sweep: Record<string, any> = {};
    if (RUN_SWEEP) {
      for (let i = 0; i < SWEEP_EDGES.length; i += 1) {
        const key = `edges${SWEEP_EDGES[i]}_tokens${SWEEP_TOKENS[i]}`;
        const t0 = performance.now();
        const response = await call(server, McpToolId.GetImpactGraph,
          { repo_root: work, symbol_fqn: pair.end, depth: SCORER_DEPTH, max_edges: SWEEP_EDGES[i], max_tokens: SWEEP_TOKENS[i] });
        const elapsed = +(performance.now() - t0).toFixed(2);
        const armRelation = (response?.directRelations ?? []).find(isTarget) ?? null;
        const anatomy = responseAnatomy(response);
        const scored = frozenA15Rendered(armRelation);
        sweep[key] = { scored, relations: anatomy.deliveredRelations, characters: anatomy.totalCharacters,
          withSourceText: anatomy.relationsWithSourceText, resultState: response?.responseBudget?.resultState ?? "?", latencyMs: elapsed };
        sweepTotals[key] ??= { scored: 0, relations: [], characters: [], withText: [], latencyMs: [], states: [] };
        if (scored) sweepTotals[key]!.scored += 1;
        sweepTotals[key]!.relations.push(anatomy.deliveredRelations);
        sweepTotals[key]!.characters.push(anatomy.totalCharacters);
        sweepTotals[key]!.withText.push(anatomy.relationsWithSourceText);
        sweepTotals[key]!.latencyMs.push(elapsed);
        sweepTotals[key]!.states.push(response?.responseBudget?.resultState ?? "?");
      }
    }

    const anatomy = product === null ? null : responseAnatomy(product);
    items.push({
      corpus: spec.id, edgeIndex, from: pair.start, to: pair.end, callee,
      crossFile: coreRelation === null ? null : crossFile(coreRelation),
      role: coreRelation === null ? null : impactRole(coreRelation),
      lane: targetLane, renderability, missClass, affordability: affordabilityForm(missInput),
      universe: { relations: universe.length, rank: universeRank, sliceIsUniverseHead },
      slice: { relations: coreRelations.length, rank: coreSliceRank,
        occupancyAhead: occupancy(ahead, callSiteIdentity),
        occupancyWhole: occupancy(coreRelations, callSiteIdentity) },
      delivered: { relations: delivered.length, rank: deliveredRank, hasSourceText: deliveredHasSourceText,
        frozenRendered: missInput.frozenRendered, weakerRelationsDelivered: weakerDelivered,
        duplicateIdentityDelivered, lanes: countBy(delivered.map(relationLane)),
        compactedFields: product?.responseBudget?.compactedFields ?? [],
        resultState: product?.responseBudget?.resultState ?? "?",
        retainedEdges: product?.responseBudget?.retainedEdges ?? -1,
        omittedEdges: product?.responseBudget?.omittedEdges ?? -1,
        requestedMaxTokens: product?.responseBudget?.requestedMaxTokens ?? -1,
        modelVisibleTokens: product?.responseBudget?.modelVisibleEstimatedTokens ?? -1,
        totalTokens: product?.responseBudget?.estimatedTotalTokens ?? -1,
        totalCeiling: product?.responseBudget?.totalCeiling ?? -1,
        latencyMs: latency, semanticHashes: [...hashes] },
      anatomy, arms, controlAgrees, ...(RUN_SWEEP ? { sweep } : {}),
    });
  }

  db.close();
  const eligible = items.length;
  const pct = (n: number) => eligible ? +(100 * n / eligible).toFixed(2) : null;
  const summary = {
    id: spec.id, language: spec.language, productHead, eligible,
    population: "deriveCallSiteEdges(db, 50): calls edges with an ordinal-0 persisted site, src != dst, by edge id",
    instrumentControl: {
      controlArmAgreesWithProduct: items.filter((it) => it.controlAgrees).length,
      sliceIsUniverseHead: items.filter((it) => it.universe.sliceIsUniverseHead).length,
      deterministic: items.every((it) => it.delivered.semanticHashes.length === 1),
    },
    frozen: { rendered: items.filter((it) => it.delivered.frozenRendered).length, percent: pct(items.filter((it) => it.delivered.frozenRendered).length) },
    missClasses: countBy(items.map((it) => it.missClass)),
    affordabilityForms: countBy(items.map((it) => it.affordability)),
    renderability: countBy(items.map((it) => it.renderability)),
    targetLanes: countBy(items.map((it) => it.lane ?? "absent")),
    ordinals: {
      universeRank: { median: median(items.map((it) => it.universe.rank)), max: Math.max(...items.map((it) => it.universe.rank)),
        absent: items.filter((it) => it.universe.rank < 0).length,
        distribution: countBy(items.map((it) => it.universe.rank < 0 ? "absent" : it.universe.rank === 0 ? "0" : it.universe.rank <= 2 ? "1-2" : it.universe.rank <= 6 ? "3-6" : it.universe.rank <= 15 ? "7-15" : it.universe.rank <= 63 ? "16-63" : "64+")) },
      sliceRank: { median: median(items.map((it) => it.slice.rank)), max: Math.max(...items.map((it) => it.slice.rank)), absent: items.filter((it) => it.slice.rank < 0).length },
      deliveredRank: { absent: items.filter((it) => it.delivered.rank < 0).length },
      universeRelations: { median: median(items.map((it) => it.universe.relations)), max: Math.max(...items.map((it) => it.universe.relations)) },
      sliceRelations: { median: median(items.map((it) => it.slice.relations)), max: Math.max(...items.map((it) => it.slice.relations)) },
      deliveredRelations: countBy(items.map((it) => String(it.delivered.relations))),
    },
    occupancyAheadTotals: Object.fromEntries(IMPACT_LANES.map((lane) => [lane,
      items.reduce((n, it) => n + (it.slice.occupancyAhead.byLane[lane] ?? 0), 0)])),
    occupancyAheadEvidence: {
      slotsAhead: items.reduce((n, it) => n + it.slice.occupancyAhead.total, 0),
      withCallSite: items.reduce((n, it) => n + it.slice.occupancyAhead.withCallSite, 0),
      withRenderedLine: items.reduce((n, it) => n + it.slice.occupancyAhead.withRenderedLine, 0),
      crossFile: items.reduce((n, it) => n + it.slice.occupancyAhead.crossFile, 0),
      sameFile: items.reduce((n, it) => n + it.slice.occupancyAhead.sameFile, 0),
      duplicateIdentities: items.reduce((n, it) => n + it.slice.occupancyAhead.duplicateCallSiteIdentities, 0),
    },
    anatomyMedians: {
      total: median(items.map((it) => it.anatomy?.totalCharacters ?? 0)),
      directRelations: median(items.map((it) => it.anatomy?.directRelationsCharacters ?? 0)),
      nodes: median(items.map((it) => it.anatomy?.nodesCharacters ?? 0)),
      edges: median(items.map((it) => it.anatomy?.edgesCharacters ?? 0)),
      view: median(items.map((it) => it.anatomy?.viewCharacters ?? 0)),
      paths: median(items.map((it) => it.anatomy?.pathsCharacters ?? 0)),
      potentialCallers: median(items.map((it) => it.anatomy?.potentialCallersCharacters ?? 0)),
      restatement: median(items.map((it) => it.anatomy?.restatementCharacters ?? 0)),
      fixed: median(items.map((it) => it.anatomy?.fixedCharacters ?? 0)),
      deliveredNodes: median(items.map((it) => it.anatomy?.deliveredNodes ?? 0)),
      deliveredEdges: median(items.map((it) => it.anatomy?.deliveredEdges ?? 0)),
      ceiling: median(items.map((it) => (it.delivered.totalCeiling ?? 0) * 4)),
    },
    arms: Object.fromEntries(Object.keys(ARMS).map((name) => [name, {
      scored: armTotals[name]!.scored, percent: pct(armTotals[name]!.scored),
      delivered: armTotals[name]!.delivered,
      medianRelations: median(armTotals[name]!.relations), maxRelations: Math.max(...armTotals[name]!.relations),
      medianCharacters: median(armTotals[name]!.characters), maxCharacters: Math.max(...armTotals[name]!.characters),
      resultStates: countBy(armTotals[name]!.states),
    }])),
    ...(RUN_SWEEP ? { sweep: Object.fromEntries(Object.entries(sweepTotals).map(([key, t]) => [key, {
      scored: t.scored, percent: pct(t.scored), medianRelations: median(t.relations), maxRelations: Math.max(...t.relations),
      medianCharacters: median(t.characters), maxCharacters: Math.max(...t.characters),
      medianWithSourceText: median(t.withText), latency: latencyStats(t.latencyMs), resultStates: countBy(t.states),
    }])) } : {}),
    compactedFieldSets: countBy(items.map((it) => it.delivered.compactedFields.join("|"))),
    examples: items.filter((it) => it.missClass !== "SCORED").slice(0, 4).map((it) => ({
      from: it.from, to: it.to, lane: it.lane, missClass: it.missClass,
      universeRank: it.universe.rank, sliceRank: it.slice.rank, deliveredRank: it.delivered.rank,
      deliveredRelations: it.delivered.relations, aheadByLane: it.slice.occupancyAhead.byLane,
      armsScored: Object.fromEntries(Object.entries(it.arms).map(([n, a]: any) => [n, a.scored])),
    })),
  };
  perCorpus.push(summary);
  itemRows.push(...items);
  console.log(`${spec.id.padEnd(8)} n=${eligible} frozen ${summary.frozen.percent}% | control-agrees ${summary.instrumentControl.controlArmAgreesWithProduct}/${eligible} slice-head ${summary.instrumentControl.sliceIsUniverseHead}/${eligible}`);
  console.log(`         miss ${JSON.stringify(summary.missClasses)}`);
  console.log(`         delivered relations ${JSON.stringify(summary.ordinals.deliveredRelations)} | median chars rel ${summary.anatomyMedians.directRelations} restatement ${summary.anatomyMedians.restatement} fixed ${summary.anatomyMedians.fixed}`);
  console.log(`         arms ${Object.entries(summary.arms).map(([n, a]: any) => `${n}=${a.percent}%`).join(" ")}`);
  if (RUN_SWEEP) console.log(`         sweep ${Object.entries(summary.sweep ?? {}).map(([k, s]: any) => `${k}=${s.percent}%`).join(" ")}`);
}

const out = {
  milestone: "M210", instrument: "run_stage5_m210_audit.ts", label: LABEL, productRoot: PRODUCT_ROOT, productHead,
  repeats: REPEATS, scratch: SCRATCH, sweep: RUN_SWEEP,
  hardware: { cpus: navigator.hardwareConcurrency, loadAverageAtStart: startLoad, loadAverageAtEnd: loadAverage() },
  frozenRule: "callSiteIsRendered (m197aScoring.ts) on get_impact_graph directRelations for the caller; C-LARGE decides; MATCH >= 90%, EXCEED 100%",
  arms: Object.keys(ARMS), missClasses: A15_MISS_CLASSES, lanes: IMPACT_LANES,
  corpora: perCorpus,
};
writeFileSync(path.join(RESULTS, `stage5_m210_audit_${LABEL}.json`), `${JSON.stringify(out, null, 2)}\n`);
writeFileSync(path.join(RESULTS, `stage5_m210_items_${LABEL}.jsonl`), itemRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`wrote results/stage5_m210_audit_${LABEL}.json and stage5_m210_items_${LABEL}.jsonl`);
