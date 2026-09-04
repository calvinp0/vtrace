/**
 * M210 — the ALLOCATION decomposition. READ-ONLY on the product.
 *
 * The audit (run_stage5_m210_audit.ts) established WHERE the frozen A15 caller
 * is lost. This instrument asks the two questions that decide what may be
 * repaired, and it keeps them apart because the architecture keeps them apart:
 *
 *   ENUMERATION CAPACITY   how many relations may be delivered at all
 *                          (`max_edges`, default 64)
 *   REPRESENTATION BUDGET  how richly each delivered relation may be written
 *                          (`max_tokens`, default 1200)
 *
 * §19 forbids conflating them, so the sweeps below move ONE at a time. A width
 * that only helps when both move together would tell us nothing about which
 * authority binds.
 *
 * It then packs the response by hand — greedily, in the product's own delivered
 * order, at the product's own measured per-item sizes — under three costings of
 * the model-visible budget:
 *
 *   A_STATUS_QUO            the graph restatement is a FIXED floor, which is
 *                           what the shipped ladder makes it: `nodes`, `edges`
 *                           and `view` have no rung of their own, so trimming a
 *                           relation frees the relation's bytes and nothing else.
 *   B_COHERENT_PROJECTIONS  every retained relation carries its own edge, its
 *                           own endpoint nodes and its own view line, and a
 *                           relation that is not retained costs none of them.
 *                           This is the tool's published contract — "nodes,
 *                           paths, directRelations, and view are projections of
 *                           that set" — applied to the set the response actually
 *                           delivers rather than to the set it started from.
 *   C_EVIDENCE_ONLY         the restatement is free. Not a design; the upper
 *                           bound that says whether ANY reallocation of this
 *                           budget could reach the bar.
 *
 * The sizes are not modelled. They are read off a response the product built
 * with shedding effectively disabled (`max_tokens` at the hard maximum), so
 * every per-relation, per-edge, per-node and per-view-line cost is the cost the
 * product itself would pay to deliver that item.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m210_allocation.ts \
 *     --label pre [--product-root <dir>] [--scratch <dir>] [--corpora ...]
 */
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { corpusSpecs, deriveCallSiteEdges, latencyStats, median, prepareCorpus } from "./m197aFixtures";
import { frozenA15Rendered, countBy } from "./m209CallSiteTruth";
import { relationLane, responseAnatomy } from "./m210RelationAllocation";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback; };
const LABEL = argOf("--label", "pre");
const PRODUCT_ROOT = path.resolve(argOf("--product-root", REPO));
const SCRATCH = argOf("--scratch", `/tmp/m210-alloc-${LABEL}`);
const CORPORA = argOf("--corpora", "C-SMALL,C-MED,C-LARGE").split(",");
const POPULATION = 50;
const SCORER_DEPTH = 3;
/** The shipped defaults this instrument holds one of fixed while moving the other. */
const DEFAULT_MAX_EDGES = 64;
const DEFAULT_MAX_TOKENS = 1200;
/** Representation budget alone; enumeration capacity stays at the shipped default. */
const TOKEN_SWEEP = [1200, 1600, 2000, 2400, 3200, 4800, 20000] as const;
/** Enumeration capacity alone; representation budget stays at the shipped default. */
const EDGE_SWEEP = [64, 96, 128, 256, 2000] as const;
mkdirSync(SCRATCH, { recursive: true });

const loadAverage = () => { try { return readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).map(Number); } catch { return []; } };
const productHead = Bun.spawnSync(["git", "-C", PRODUCT_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();

const { createMcpServer } = await import(path.join(PRODUCT_ROOT, "src/mcp/server.ts"));
const { McpToolId, MCP_SERVER_SCHEMA } = await import(path.join(PRODUCT_ROOT, "src/mcp/types.ts"));

type Server = { handleRequest: (request: unknown) => Promise<any> };
const call = async (server: Server, toolId: string, input: unknown, id = "m210a"): Promise<any> => {
  const res: any = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: id, toolId, input } as any);
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

const size = (value: unknown): number => JSON.stringify(value ?? null).length;

/**
 * Greedy packing in the delivered order. Returns how many leading relations fit
 * under both of the envelope's contracts, given a per-relation cost and a fixed
 * overhead the model-visible side must carry regardless.
 *
 * Both bounds are applied because the product applies both: the caller's
 * `max_tokens` bounds the model-visible projections, and `max_tokens` plus the
 * documented metadata allowance bounds the complete serialized response.
 */
function packed(
  costs: readonly number[],
  modelVisibleOverhead: number,
  modelVisibleBudgetChars: number,
  fixedMetadataChars: number,
  totalCeilingChars: number,
): number {
  let used = modelVisibleOverhead;
  let count = 0;
  for (const cost of costs) {
    const next = used + cost;
    if (next > modelVisibleBudgetChars) break;
    if (fixedMetadataChars + next > totalCeilingChars) break;
    used = next;
    count += 1;
  }
  return count;
}

const perCorpus: any[] = [];
const itemRows: any[] = [];
const startLoad = loadAverage();
console.log(`M210 allocation label=${LABEL} product=${PRODUCT_ROOT} @ ${productHead.slice(0, 10)} load ${startLoad.join(" ")}`);

for (const spec of corpusSpecs(REPO).filter((s) => CORPORA.includes(s.id))) {
  const work = prepareCorpus(spec, SCRATCH);
  if (work === null) { perCorpus.push({ id: spec.id, status: "CORPUS_ABSENT" }); continue; }
  const dbPath = path.join(work, ".vtrace/index.sqlite");
  const server: Server = createMcpServer({ context: { repoRoot: work, dbPath } } as any);
  const indexed = await call(server, McpToolId.IndexRepo, { repo_root: work }, "idx");
  if (indexed?.readiness?.status !== "ready") { perCorpus.push({ id: spec.id, status: "INDEX_NOT_READY", indexed }); continue; }
  const db = new Database(dbPath, { readonly: true });
  const pairs = deriveCallSiteEdges(db, POPULATION);
  db.close();

  const items: any[] = [];
  const tokenSweep: Record<string, { scored: number; relations: number[]; withText: number[]; characters: number[]; latencyMs: number[]; states: string[] }> = {};
  const edgeSweep: Record<string, { scored: number; relations: number[]; withText: number[]; characters: number[]; latencyMs: number[]; states: string[] }> = {};

  for (const pair of pairs) {
    const isTarget = (relation: any) => relation?.source?.symbol === pair.start;

    // The shipped default: what the frozen scorer reads.
    const shipped = await call(server, McpToolId.GetImpactGraph, { repo_root: work, symbol_fqn: pair.end, depth: SCORER_DEPTH });
    // The same canonical selection with shedding effectively disabled, which is
    // where the per-item costs are read from.
    const unshed = await call(server, McpToolId.GetImpactGraph,
      { repo_root: work, symbol_fqn: pair.end, depth: SCORER_DEPTH, max_edges: DEFAULT_MAX_EDGES, max_tokens: 20000 });
    if (shipped === null || unshed === null || unshed.__error !== undefined) continue;

    const shippedAnatomy = responseAnatomy(shipped);
    const unshedAnatomy = responseAnatomy(unshed);
    const relations: any[] = unshed.directRelations ?? [];
    const targetRank = relations.findIndex(isTarget);

    // Per-item costs, measured on the product's own objects. The `+1` is the
    // separator each element needs inside its array.
    const relationCosts = relations.map((relation) => size(relation) + 1);
    const edgeCostById = new Map<string, number>((unshed.edges ?? []).map((edge: any) => [edge.edgeId, size(edge) + 1]));
    const nodeCostById = new Map<string, number>((unshed.nodes ?? []).map((node: any) => [node.symbolId, size(node) + 1]));
    const viewLineCost = (unshed.view?.lines ?? []).length === 0
      ? 0
      : Math.ceil(size(unshed.view) / Math.max(1, (unshed.view.lines as string[]).length));
    const rootNodeId = unshed.resolvedSymbol?.symbolId;
    const rootNodeCost = (rootNodeId === undefined ? 0 : nodeCostById.get(rootNodeId) ?? 0) + viewLineCost;

    // B_COHERENT: what one relation costs when its projections travel with it.
    const seenNodes = new Set<string>(rootNodeId === undefined ? [] : [rootNodeId]);
    const coherentCosts = relations.map((relation, index) => {
      let cost = relationCosts[index]!;
      if (relation.edgeId !== null && relation.edgeId !== undefined) cost += edgeCostById.get(relation.edgeId) ?? 0;
      for (const endpoint of [relation.source, relation.target]) {
        const id = endpoint?.nodeId;
        if (id === undefined || seenNodes.has(id)) continue;
        seenNodes.add(id);
        cost += (nodeCostById.get(id) ?? 0) + viewLineCost;
      }
      return cost;
    });

    const modelVisibleBudgetChars = (shipped.responseBudget?.requestedMaxTokens ?? DEFAULT_MAX_TOKENS) * 4;
    const totalCeilingChars = (shipped.responseBudget?.totalCeiling ?? 2000) * 4;
    // The fixed metadata the shipped response actually carried: everything that
    // is neither a model-visible projection nor `potentialCallers`.
    const fixedMetadataChars = shippedAnatomy.fixedCharacters;
    const restatementFloor = unshedAnatomy.restatementCharacters - unshedAnatomy.pathsCharacters;

    const models = {
      A_STATUS_QUO: packed(relationCosts, restatementFloor, modelVisibleBudgetChars, fixedMetadataChars, totalCeilingChars),
      B_COHERENT_PROJECTIONS: packed(coherentCosts, rootNodeCost, modelVisibleBudgetChars, fixedMetadataChars, totalCeilingChars),
      C_EVIDENCE_ONLY: packed(relationCosts, 0, modelVisibleBudgetChars, fixedMetadataChars, totalCeilingChars),
    };

    // Sweeps: one authority at a time.
    const tokenRows: Record<string, any> = {};
    for (const budget of TOKEN_SWEEP) {
      const key = `tokens${budget}`;
      const t0 = performance.now();
      const response = await call(server, McpToolId.GetImpactGraph,
        { repo_root: work, symbol_fqn: pair.end, depth: SCORER_DEPTH, max_edges: DEFAULT_MAX_EDGES, max_tokens: budget });
      const elapsed = +(performance.now() - t0).toFixed(2);
      const anatomy = responseAnatomy(response);
      const scored = frozenA15Rendered((response?.directRelations ?? []).find(isTarget) ?? null);
      tokenRows[key] = { scored, relations: anatomy.deliveredRelations, withSourceText: anatomy.relationsWithSourceText,
        characters: anatomy.totalCharacters, resultState: response?.responseBudget?.resultState ?? "?", latencyMs: elapsed };
      tokenSweep[key] ??= { scored: 0, relations: [], withText: [], characters: [], latencyMs: [], states: [] };
      if (scored) tokenSweep[key]!.scored += 1;
      tokenSweep[key]!.relations.push(anatomy.deliveredRelations);
      tokenSweep[key]!.withText.push(anatomy.relationsWithSourceText);
      tokenSweep[key]!.characters.push(anatomy.totalCharacters);
      tokenSweep[key]!.latencyMs.push(elapsed);
      tokenSweep[key]!.states.push(response?.responseBudget?.resultState ?? "?");
    }
    const edgeRows: Record<string, any> = {};
    for (const width of EDGE_SWEEP) {
      const key = `edges${width}`;
      const t0 = performance.now();
      const response = await call(server, McpToolId.GetImpactGraph,
        { repo_root: work, symbol_fqn: pair.end, depth: SCORER_DEPTH, max_edges: width, max_tokens: DEFAULT_MAX_TOKENS });
      const elapsed = +(performance.now() - t0).toFixed(2);
      const anatomy = responseAnatomy(response);
      const scored = frozenA15Rendered((response?.directRelations ?? []).find(isTarget) ?? null);
      edgeRows[key] = { scored, relations: anatomy.deliveredRelations, withSourceText: anatomy.relationsWithSourceText,
        characters: anatomy.totalCharacters, resultState: response?.responseBudget?.resultState ?? "?", latencyMs: elapsed };
      edgeSweep[key] ??= { scored: 0, relations: [], withText: [], characters: [], latencyMs: [], states: [] };
      if (scored) edgeSweep[key]!.scored += 1;
      edgeSweep[key]!.relations.push(anatomy.deliveredRelations);
      edgeSweep[key]!.withText.push(anatomy.relationsWithSourceText);
      edgeSweep[key]!.characters.push(anatomy.totalCharacters);
      edgeSweep[key]!.latencyMs.push(elapsed);
      edgeSweep[key]!.states.push(response?.responseBudget?.resultState ?? "?");
    }

    items.push({
      corpus: spec.id, from: pair.start, to: pair.end,
      targetRank, lane: targetRank >= 0 ? relationLane(relations[targetRank]!) : null,
      unshedRelations: relations.length,
      shippedRelations: shippedAnatomy.deliveredRelations,
      shippedScored: frozenA15Rendered((shipped.directRelations ?? []).find(isTarget) ?? null),
      budgets: { modelVisibleBudgetChars, totalCeilingChars, fixedMetadataChars, restatementFloor, rootNodeCost, viewLineCost },
      costs: { medianRelation: median(relationCosts), medianCoherent: median(coherentCosts),
        targetRelation: targetRank >= 0 ? relationCosts[targetRank] : null,
        targetCoherent: targetRank >= 0 ? coherentCosts[targetRank] : null },
      models,
      modelScores: Object.fromEntries(Object.entries(models).map(([name, k]) => [name, targetRank >= 0 && targetRank < k])),
      tokenSweep: tokenRows, edgeSweep: edgeRows,
    });
  }

  const eligible = items.length;
  const pct = (n: number) => eligible ? +(100 * n / eligible).toFixed(2) : null;
  const summarySweep = (rows: typeof tokenSweep) => Object.fromEntries(Object.entries(rows).map(([key, t]) => [key, {
    scored: t.scored, percent: pct(t.scored),
    medianRelations: median(t.relations), maxRelations: Math.max(...t.relations),
    medianWithSourceText: median(t.withText), medianCharacters: median(t.characters), maxCharacters: Math.max(...t.characters),
    latency: latencyStats(t.latencyMs), resultStates: countBy(t.states),
  }]));
  const summary = {
    id: spec.id, language: spec.language, productHead, eligible,
    shippedScored: items.filter((it) => it.shippedScored).length, shippedPercent: pct(items.filter((it) => it.shippedScored).length),
    targetRank: {
      median: median(items.map((it) => it.targetRank)), max: Math.max(...items.map((it) => it.targetRank)),
      absent: items.filter((it) => it.targetRank < 0).length,
      distribution: countBy(items.map((it) => it.targetRank < 0 ? "absent" : it.targetRank === 0 ? "0" : it.targetRank <= 2 ? "1-2" : it.targetRank <= 5 ? "3-5" : it.targetRank <= 12 ? "6-12" : it.targetRank <= 63 ? "13-63" : "64+")),
    },
    budgets: {
      medianModelVisibleBudgetChars: median(items.map((it) => it.budgets.modelVisibleBudgetChars)),
      medianTotalCeilingChars: median(items.map((it) => it.budgets.totalCeilingChars)),
      medianFixedMetadataChars: median(items.map((it) => it.budgets.fixedMetadataChars)),
      medianRestatementFloor: median(items.map((it) => it.budgets.restatementFloor)),
      restatementShareOfModelVisibleBudgetPercent: +(100 * median(items.map((it) => it.budgets.restatementFloor))
        / Math.max(1, median(items.map((it) => it.budgets.modelVisibleBudgetChars)))).toFixed(2),
      medianRelationCost: median(items.map((it) => it.costs.medianRelation)),
      medianCoherentCost: median(items.map((it) => it.costs.medianCoherent)),
    },
    packingModels: Object.fromEntries(["A_STATUS_QUO", "B_COHERENT_PROJECTIONS", "C_EVIDENCE_ONLY"].map((name) => [name, {
      medianRelationsThatFit: median(items.map((it) => it.models[name])),
      maxRelationsThatFit: Math.max(...items.map((it) => it.models[name])),
      targetWouldScore: items.filter((it) => it.modelScores[name]).length,
      percent: pct(items.filter((it) => it.modelScores[name]).length),
    }])),
    tokenSweep: summarySweep(tokenSweep),
    edgeSweep: summarySweep(edgeSweep),
  };
  perCorpus.push(summary);
  itemRows.push(...items);
  console.log(`${spec.id.padEnd(8)} n=${eligible} shipped ${summary.shippedPercent}% | target rank median ${summary.targetRank.median} max ${summary.targetRank.max} ${JSON.stringify(summary.targetRank.distribution)}`);
  console.log(`         budget ${summary.budgets.medianModelVisibleBudgetChars}c model-visible; restatement floor ${summary.budgets.medianRestatementFloor}c (${summary.budgets.restatementShareOfModelVisibleBudgetPercent}%); relation ${summary.budgets.medianRelationCost}c coherent ${summary.budgets.medianCoherentCost}c`);
  console.log(`         packing ${Object.entries(summary.packingModels).map(([n, m]: any) => `${n}=${m.percent}% (k~${m.medianRelationsThatFit})`).join(" ")}`);
  console.log(`         tokens  ${Object.entries(summary.tokenSweep).map(([k, s]: any) => `${k}=${s.percent}%`).join(" ")}`);
  console.log(`         edges   ${Object.entries(summary.edgeSweep).map(([k, s]: any) => `${k}=${s.percent}%`).join(" ")}`);
}

const out = {
  milestone: "M210", instrument: "run_stage5_m210_allocation.ts", label: LABEL, productRoot: PRODUCT_ROOT, productHead,
  scratch: SCRATCH, hardware: { cpus: navigator.hardwareConcurrency, loadAverageAtStart: startLoad, loadAverageAtEnd: loadAverage() },
  defaults: { maxEdges: DEFAULT_MAX_EDGES, maxTokens: DEFAULT_MAX_TOKENS },
  tokenSweep: TOKEN_SWEEP, edgeSweep: EDGE_SWEEP,
  corpora: perCorpus,
};
writeFileSync(path.join(RESULTS, `stage5_m210_allocation_${LABEL}.json`), `${JSON.stringify(out, null, 2)}\n`);
writeFileSync(path.join(RESULTS, `stage5_m210_allocation_items_${LABEL}.jsonl`), itemRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`wrote results/stage5_m210_allocation_${LABEL}.json`);
