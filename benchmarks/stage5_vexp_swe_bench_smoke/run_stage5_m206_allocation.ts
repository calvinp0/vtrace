/**
 * M206 — the frozen A11 sweep with the candidate-allocation audit and the
 * counterfactual uncapped-supply evaluator.
 *
 * Runs EXACTLY the calls the frozen engine makes for A11/A13: every A13 task
 * on C-MED (and the first three on the other corpora) at each budget, through
 * the DEFAULT `get_code_context` path, and computes the frozen whole-response
 * utilisation with the engine's own rule (m204Utilization.ts, verbatim).
 * Nothing about the protocol is tuned here.
 *
 * Beside each default call the driver makes ONE paired `detail=debug` call of
 * the same request and ONE direct, read-only capsule build with the request's
 * own resolved preset and character budget (M204's instrument). From those it
 * binds the ranked candidate stream the capsule saw — pivots, support and
 * every discard with its verbatim reason — and, for each candidate the tier's
 * item count discarded, the body the index holds for it, rendered by the same
 * product functions that would have rendered it (structural skeleton, parser
 * signature). The counterfactual (m206Allocation.ts) then replays the
 * projector's admission over the delivered prefix plus those candidates, in
 * the capsule's order, under the caller's ceiling, and reports what the SAME
 * ranked stream would have delivered had the count not stopped it. Nothing
 * here changes the default response, which is what is measured.
 *
 * `--product-root` selects which tree's product code answers (the predecessor
 * worktree for the pre-change reproduction); `--scratch` selects the corpus
 * copy, so the repaired product can be run against the pre-change copy.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m206_allocation.ts \
 *     --label pre [--product-root <dir>] [--scratch <dir>] [--repeats 1] \
 *     [--corpora C-MED] [--budgets 1000,1500,2000,3000,4000,6000,8000,12000,16000]
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { A13_TASKS, corpusSpecs, latencyStats, prepareCorpus } from "./m197aFixtures";
import {
  A11_BUDGETS, analyzeUtilization, frozenA11Verdict, median, orderRelation, type ResponseUtilization, type UpstreamSupply,
} from "./m204Utilization";
import {
  PIVOT_CAP_DEMOTION, actualStopReason, allocationGates, auditAllocationStages, classifyDiscardReason, distributionOf,
  isCountCapDiscard, simulateUncappedAdmission, sufficiencyRow, supplyVerdict, type DiscardClass, type Serializer,
  type SimulationResult, type UncappedCandidate,
} from "./m206Allocation";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const LABEL = argOf("--label", "post");
const PRODUCT_ROOT = path.resolve(argOf("--product-root", REPO));
const SCRATCH = argOf("--scratch", `/tmp/m206-allocation-${LABEL}`);
const REPEATS = Number.parseInt(argOf("--repeats", "1"), 10);
const CORPORA = argOf("--corpora", "C-MED").split(",");
const BUDGETS = argOf("--budgets", "1000,1500,2000,3000,4000,6000,8000,12000,16000").split(",").map((b) => Number.parseInt(b, 10));
mkdirSync(SCRATCH, { recursive: true });

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const loadAverage = () => {
  try { return readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).map(Number); }
  catch { return []; }
};

// The product under measurement, from whichever tree was named.
const { createMcpServer } = await import(path.join(PRODUCT_ROOT, "src/mcp/server.ts"));
const { McpToolId, MCP_SERVER_SCHEMA } = await import(path.join(PRODUCT_ROOT, "src/mcp/types.ts"));
const accountingModule = await import(path.join(PRODUCT_ROOT, "src/runPipeline/orientationAccounting.ts"));
const projection = await import(path.join(PRODUCT_ROOT, "src/runPipeline/orientationProjection.ts"));
const representation = await import(path.join(PRODUCT_ROOT, "src/runPipeline/orientationRepresentation.ts"));
const { allocateBudget } = await import(path.join(PRODUCT_ROOT, "src/capsuleV2/budgetAllocator.ts"));
const { PIVOT_NEIGHBORHOOD_DEFAULTS } = await import(path.join(PRODUCT_ROOT, "src/runPipeline/pivotNeighborhood.ts"));
const { buildAuthoritativeProductRetrieval } = await import(path.join(PRODUCT_ROOT, "src/capsuleV2/authoritativeProductRetrieval.ts"));
const { renderStructuralSkeleton } = await import(path.join(PRODUCT_ROOT, "src/productContext/assembleProductContext.ts"));
const { getSymbolById, listSymbolsForFile, listSymbolsByFqName } = await import(path.join(PRODUCT_ROOT, "src/db/repositories/symbolsRepository.ts"));
const { loadSymbolSource } = await import(path.join(PRODUCT_ROOT, "src/capsule/loadSymbolSource.ts"));
const { extractFullSymbolSource, ExtractSymbolSourceStatus } = await import(path.join(PRODUCT_ROOT, "src/capsule/extractSymbolContent.ts"));
const { estimateTokens } = await import(path.join(PRODUCT_ROOT, "src/capsuleV2/tokens.ts"));
const { orientationAccountingOf, orientationTokensOfCharacters, withItemTokens } = accountingModule;
const ORIENTATION_POLICY = projection.ORIENTATION_POLICY;
const FROZEN_PHRASES: readonly string[] = projection.ORIENTATION_FROZEN_PHRASES;
const ceilingRule: (requested: number | string) => number = projection.orientationCeilingTokens;
const RELATED_BOUND: number = ORIENTATION_POLICY.relatedCodeCharacters;
const productHead = Bun.spawnSync(["git", "-C", PRODUCT_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();

// The retrieval pool cap, read from the product source rather than restated.
const capsuleSource = readFileSync(path.join(PRODUCT_ROOT, "src/capsuleV2/buildCapsuleV2.ts"), "utf8");
const POOL_CAP = Number.parseInt(/const CANDIDATE_POOL_SIZE = (\d+);/.exec(capsuleSource)?.[1] ?? "NaN", 10);
const allocatorSource = readFileSync(path.join(PRODUCT_ROOT, "src/capsuleV2/budgetAllocator.ts"), "utf8");
const allocatorPolicy = {
  microMaxTokens: Number.parseInt(/MICRO_MAX_TOKENS = ([\d_]+)/.exec(allocatorSource)?.[1]?.replace(/_/g, "") ?? "NaN", 10),
  standardMaxTokens: Number.parseInt(/STANDARD_MAX_TOKENS = ([\d_]+)/.exec(allocatorSource)?.[1]?.replace(/_/g, "") ?? "NaN", 10),
  tiers: ["micro", "standard", "full"].map((t) => {
    const a = allocateBudget(t === "micro" ? 1 : t === "standard" ? 2000 : 16000);
    return { tier: a.tier, maxPivots: a.maxPivots, maxSupport: a.maxSupport ?? null, supportWindow: a.supportWindow ?? null };
  }),
  supportCountIsHardMaximum: /support\.length >= (maxSupportSlots|supportWindow)/.test(capsuleSource),
};

/** The projector's serialization, replicated from the same product functions and checked against its ledger on every response. */
const serializer: Serializer = {
  packetTokens: (p) => orientationTokensOfCharacters(JSON.stringify(p).length),
  assemble: (focus, related, notes) => ({
    schemaVersion: projection.ORIENTATION_SCHEMA_VERSION, focus, related: [...related], boundary: projection.ORIENTATION_BOUNDARY,
    ...(notes.length === 0 ? {} : { notes: [...notes] }),
  }),
  withItemTokens,
  availableRepresentation: (i) => representation.availableRepresentation(i),
};

const call = async (server: any, toolId: string, input: unknown, id = "m206"): Promise<any> => {
  const res: any = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: id, toolId, input } as any);
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

console.log(`[${LABEL}] product ${PRODUCT_ROOT} @ ${productHead.slice(0, 12)}; pool cap ${POOL_CAP}; tiers ${JSON.stringify(allocatorPolicy.tiers)}; `
  + `support count hard maximum ${allocatorPolicy.supportCountIsHardMaximum}; budgets ${BUDGETS.join(",")}; load ${loadAverage().join(" ")}`);

// ------------------------------------------------------ the ranked stream

interface StreamFacts {
  readonly built: any;
  readonly supply: UpstreamSupply;
  readonly discardClasses: DiscardClass[];
  readonly extras: UncappedCandidate[];
  readonly extrasPivotVariant: UncappedCandidate[];
  readonly deliveredDemotedPivots: number;
}

/** The capsule's own view of the request: pivots, support and every discard in its order, plus the identity and body of each count-cap discard. */
function bindStream(db: any, work: string, task: string, debug: any, budget: number): StreamFacts {
  const allocation = allocateBudget(budget);
  const neighborhoods: any[] = Array.isArray(debug?.pivotNeighborhood) ? debug.pivotNeighborhood : [];
  const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
  const preset = debug?.intent?.selectedPreset;
  const capsuleIntent = debug?.intent?.selectedIntent;
  const maxBudgetCharacters = count(debug?.request?.maxBudgetCharacters) ?? budget * 4;
  let built: any = null;
  if (typeof preset === "string") {
    try {
      built = buildAuthoritativeProductRetrieval(db, work, { query: task, preset, maxBudgetCharacters,
        ...(typeof capsuleIntent === "string" ? { capsuleIntent } : {}) }).result;
    } catch { built = null; }
  }
  const discarded: any[] = Array.isArray(built?.discarded) ? built.discarded : [];
  const pool: any[] = Array.isArray(built?.diagnostics?.candidate_scores) ? built.diagnostics.candidate_scores : [];
  const poolKey = (p: string, s: string) => `${p} ${s}`;
  const poolByKey = new Map<string, any[]>();
  for (const c of pool) { const k = poolKey(c.path, c.symbol); poolByKey.set(k, [...(poolByKey.get(k) ?? []), c]); }
  const inPool = (path: string, symbol: string, final: number | undefined): any | undefined => {
    const list = poolByKey.get(poolKey(path, symbol)) ?? [];
    return list.find((c) => final === undefined || c.scores?.final === final) ?? list[0];
  };
  const byReason: Record<string, number> = {};
  const discardClasses: DiscardClass[] = [];
  for (const d of discarded) {
    const r = String(d?.discard_reason ?? "unknown");
    byReason[r] = (byReason[r] ?? 0) + 1;
    discardClasses.push(classifyDiscardReason(r, typeof d?.role_reason === "string" ? d.role_reason : undefined));
  }

  // Identity, span and body for each count-cap discard: the pool row when it came
  // from the pool (rank, score, symbol id), the file's unique local name otherwise.
  const extras: UncappedCandidate[] = [];
  const extrasPivotVariant: UncappedCandidate[] = [];
  let discardRank = 0;
  for (const [k, d] of discarded.entries()) {
    if (!isCountCapDiscard(discardClasses[k]!)) continue;
    discardRank += 1;
    const poolRow = inPool(d.path, d.symbol, d.scorecard?.final);
    let record: any = poolRow ? getSymbolById(db, poolRow.symbol_id) : undefined;
    if (record === undefined) {
      const inFile = listSymbolsForFile(db, d.path).filter((s: any) => s.localName === d.symbol);
      record = inFile.length === 1 ? inFile[0] : undefined;
    }
    const how = typeof d.role_reason === "string" ? d.role_reason : String(d.discard_reason);
    const role: UncappedCandidate["role"] = PIVOT_CAP_DEMOTION.test(how) ? "demoted_pivot" : "support";
    if (record === undefined) {
      const stub: UncappedCandidate = { at: `${d.path}::${d.symbol}`, file: d.path, lines: null, how, form: "summary", body: "",
        capsuleEstimatedTokens: estimateTokens(String(d.symbol)), discardRank, poolRank: poolRow?.rank ?? null,
        finalScore: d.scorecard?.final ?? null, role, identityResolved: false };
      extras.push(stub); extrasPivotVariant.push(stub);
      continue;
    }
    // The product's own support rendering rule (sourceDraft): structural skeleton, else parser signature, else summary.
    const structural = renderStructuralSkeleton(db, d.path, record);
    const signature: string = typeof record.signature === "string" ? record.signature : "";
    const form = structural.content ? "skeleton" : signature ? "signature" : "summary";
    const body: string = structural.content ?? (signature || "");
    const base: UncappedCandidate = {
      at: record.fqName, file: d.path, lines: `${record.startLine}-${record.endLine}`, how, form, body,
      capsuleEstimatedTokens: estimateTokens(signature || String(d.symbol)),
      discardRank, poolRank: poolRow?.rank ?? null, finalScore: d.scorecard?.final ?? null, role, identityResolved: true,
    };
    extras.push(base);
    if (role === "demoted_pivot") {
      const loaded = loadSymbolSource(db, work, record.id);
      const extracted = extractFullSymbolSource(loaded);
      const source = extracted.status === ExtractSymbolSourceStatus.Extracted ? extracted.source : undefined;
      extrasPivotVariant.push(source === undefined ? base : { ...base, form: "focused_source", body: source, capsuleEstimatedTokens: estimateTokens(source) });
    } else {
      extrasPivotVariant.push(base);
    }
  }
  const supportItems: any[] = Array.isArray(built?.support) ? built.support : [];
  const supply: UpstreamSupply = {
    tier: typeof built?.actual_mode === "string" ? built.actual_mode : null,
    maxPivots: allocation.maxPivots, maxSupport: allocation.maxSupport ?? allocation.supportWindow ?? null,
    candidateCount: count(built?.diagnostics?.candidate_count),
    pivotCount: built ? built.pivots.length : null, supportCount: built ? supportItems.length : null,
    discardedCount: built ? discarded.length : null, discardedByReason: built ? byReason : null,
    discardedForTierCap: built ? discardClasses.filter(isCountCapDiscard).length : null,
    directBuildConsistent: null,
    neighborhoodExcerpts: neighborhoods.reduce((n, e) => n + (Array.isArray(e?.excerpts) ? e.excerpts.length : 0), 0),
    neighborhoodPivots: neighborhoods.length,
    neighborhoodMaxPivots: PIVOT_NEIGHBORHOOD_DEFAULTS.maxPivots,
    neighborhoodMaxExcerptsPerPivot: PIVOT_NEIGHBORHOOD_DEFAULTS.maxExcerptsPerPivot,
  };
  return { built, supply, discardClasses, extras, extrasPivotVariant,
    deliveredDemotedPivots: supportItems.filter((s) => PIVOT_CAP_DEMOTION.test(String(s.role_reason ?? ""))).length };
}

const perCorpus: any[] = [];
const responseRows: any[] = [];
const candidateRows: any[] = [];
let peakRssBytes = 0;
const noteMemory = () => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); };

for (const spec of corpusSpecs(REPO).filter((s) => CORPORA.includes(s.id))) {
  const work = prepareCorpus(spec, SCRATCH);
  if (work === null) { perCorpus.push({ id: spec.id, status: "CORPUS_ABSENT" }); continue; }
  const dbPath = path.join(work, ".vtrace/index.sqlite");
  const server = createMcpServer({ context: { repoRoot: work, dbPath } } as any);
  const indexed = await call(server, McpToolId.IndexRepo, { repo_root: work }, "idx");
  if (indexed?.readiness?.status !== "ready") {
    perCorpus.push({ id: spec.id, status: "INDEX_NOT_READY", readiness: indexed?.readiness ?? null });
    continue;
  }
  const db = new Database(dbPath, { readonly: true });
  const budgetTasks = spec.id === "C-MED" ? A13_TASKS : A13_TASKS.slice(0, 3);
  const responses: any[] = [];
  const packetHashes = new Map<string, Set<string>>();
  const ledgerHashes = new Map<string, Set<string>>();
  const latencyByBudget = new Map<number, number[]>();
  const allocationMsByBudget = new Map<number, number[]>();
  const packetBytesByBudget = new Map<number, number[]>();

  for (const task of budgetTasks) {
    for (const budget of BUDGETS) {
      let out: any = null; let ledger: any = null;
      for (let r = 0; r < REPEATS; r += 1) {
        const t0 = performance.now();
        out = await call(server, McpToolId.GetCodeContext, { task, repo_root: work, max_tokens: budget });
        const ms = performance.now() - t0;
        noteMemory();
        latencyByBudget.set(budget, [...(latencyByBudget.get(budget) ?? []), ms]);
        packetBytesByBudget.set(budget, [...(packetBytesByBudget.get(budget) ?? []), JSON.stringify(out ?? null).length]);
        ledger = out && typeof out === "object" ? orientationAccountingOf(out) : undefined;
        const key = `${task}@${budget}`;
        const ph = packetHashes.get(key) ?? new Set(); ph.add(sha(JSON.stringify(out ?? null))); packetHashes.set(key, ph);
        const lh = ledgerHashes.get(key) ?? new Set(); lh.add(sha(JSON.stringify(ledger ?? null))); ledgerHashes.set(key, lh);
      }
      const isPacket = out && typeof out === "object" && "focus" in out;
      // The paired authoritative call and the direct build: supply facts only, never the measured output.
      const debug = await call(server, McpToolId.GetCodeContext, { task, repo_root: work, max_tokens: budget, detail: "debug", include_item_content: true }, "dbg");
      const a0 = performance.now();
      const stream = bindStream(db, work, task, debug, budget);
      allocationMsByBudget.set(budget, [...(allocationMsByBudget.get(budget) ?? []), performance.now() - a0]);
      const facts = stream.supply;
      const analysis: ResponseUtilization | null = isPacket ? analyzeUtilization({
        budget, packet: out, ledger, expectedCeilingTokens: ceilingRule(budget),
        headBoundCharacters: ORIENTATION_POLICY.focusCodeCharacters, frozenPhrases: FROZEN_PHRASES, upstream: facts,
      }) : null;

      // Stage audit and stop reason.
      const built = stream.built;
      const items: any[] = Array.isArray(debug?.productContext?.items) ? debug.productContext.items : [];
      const itemsByRole: Record<string, number> = {};
      for (const it of items) for (const role of (Array.isArray(it.roles) ? it.roles : [])) itemsByRole[role] = (itemsByRole[role] ?? 0) + 1;
      const delivery = debug?.productContext?.delivery ?? null;
      const stages = auditAllocationStages({
        capsule: {
          candidateCount: facts.candidateCount, poolCap: POOL_CAP, tier: facts.tier, maxPivots: facts.maxPivots, maxSupport: facts.maxSupport,
          pivots: (built?.pivots ?? []).map((p: any) => ({ roleReason: String(p.role_reason ?? "") })),
          support: (built?.support ?? []).map((s: any) => ({ roleReason: String(s.role_reason ?? ""), inPool: (built?.diagnostics?.candidate_scores ?? []).some((c: any) => c.path === s.path && c.symbol === s.symbol) })),
          discarded: (built?.discarded ?? []).map((d: any) => ({ reason: String(d.discard_reason ?? ""), roleReason: typeof d.role_reason === "string" ? d.role_reason : undefined,
            inPool: (built?.diagnostics?.candidate_scores ?? []).some((c: any) => c.path === d.path && c.symbol === d.symbol) })),
        },
        assembly: items.length === 0 ? null : { itemsByRole, items: items.length, duplicateItemsRemoved: debug?.productContext?.accounting?.duplicateItemCountRemoved ?? null },
        delivery: delivery === null ? null : { selectedItemsBeforeBudget: delivery.selectedItemsBeforeBudget ?? null, deliveredItems: delivery.deliveredItems ?? null,
          droppedForBudget: delivery.droppedForBudget ?? null, compactionStages: Array.isArray(delivery.compactionStages) ? delivery.compactionStages : [] },
        projector: ledger?.candidates ? { neighbourhoodExcerpts: facts.neighborhoodExcerpts, proposed: ledger.candidates.proposed, deduplicated: ledger.candidates.deduplicated,
          droppedNoClaim: ledger.candidates.droppedNoClaim, admitted: ledger.candidates.admitted, rejectedForCeiling: ledger.candidates.rejectedForCeiling, notReached: ledger.candidates.notReached } : null,
      });
      const stop = actualStopReason({
        projectorRejectedForCeiling: ledger?.candidates?.rejectedForCeiling ?? null,
        tierCapDiscards: stream.discardClasses.filter(isCountCapDiscard).length,
        evidenceBudgetDropped: delivery?.droppedForBudget ?? null,
        evidenceBudgetCompacted: delivery?.status === "compacted",
        tokenBudgetDiscards: stream.discardClasses.filter((c) => c === "TOKEN_BUDGET").length,
        laneCeilingDiscards: stream.discardClasses.filter((c) => c === "LANE_TOKEN_CEILING").length,
        candidateCount: facts.candidateCount, poolCap: POOL_CAP,
      });

      // The counterfactual: the delivered prefix plus every count-cap discard, in the capsule's order.
      let simulation: SimulationResult | null = null; let simulationPivotVariant: SimulationResult | null = null;
      let replicaMatchesLedger: boolean | null = null;
      if (isPacket && ledger) {
        const notes: string[] = Array.isArray(out.notes) ? out.notes : [];
        const strip = (e: any) => { const { tokens: _t, ...rest } = e; return rest; };
        const replica = serializer.packetTokens(serializer.assemble(strip(out.focus), (out.related ?? []).map(strip), notes));
        replicaMatchesLedger = replica === ledger.evidence?.tokens;
        const common = {
          focus: out.focus, notes, delivered: out.related ?? [], ceilingTokens: ceilingRule(budget), relatedBound: RELATED_BOUND,
          upstream: typeof debug?.productContext?.accounting?.renderedCharacters === "number"
            ? { budgetTokens: budget, renderedCharacters: debug.productContext.accounting.renderedCharacters } : null,
          capsule: built ? { maxTokens: built.budget.max_tokens, usedTokens: built.budget.estimated_tokens } : null,
          serializer, pool: { candidateCount: facts.candidateCount, cap: POOL_CAP },
        };
        simulation = simulateUncappedAdmission({ ...common, extras: stream.extras });
        simulationPivotVariant = stream.extrasPivotVariant.some((e, k) => e !== stream.extras[k])
          ? simulateUncappedAdmission({ ...common, extras: stream.extrasPivotVariant }) : simulation;
      }
      const gates = allocationGates({ packet: out, utilizationVerdict: analysis?.verdict ?? null, discardClasses: stream.discardClasses, stop, simulation });
      if (replicaMatchesLedger !== null) gates.push({ id: "counterfactual_replica_matches_ledger", pass: replicaMatchesLedger, detail: `replica evidence tokens vs ledger ${ledger?.evidence?.tokens}` });

      const relatedIds: string[] = isPacket ? (out.related ?? []).map((r: any) => String(r.at)) : [];
      const rankedPreCap = built ? built.pivots.length + built.support.length + built.discarded.length : null;
      const postCap = built ? built.pivots.length + built.support.length : null;
      const row = {
        corpus: spec.id, task, budget, frozenBudget: (A11_BUDGETS as readonly number[]).includes(budget),
        shape: isPacket ? "orientation" : String(out?.schemaVersion ?? out?.__error?.code ?? "other"),
        packetSha: sha(JSON.stringify(out ?? null)),
        focusAt: isPacket ? out.focus.at : null, focusForm: isPacket ? out.focus.form : null,
        focusCodeTokensFrozen: isPacket ? Math.ceil((out.focus.code ?? "").length / 4) : 0,
        relatedIds,
        relatedRepresentations: isPacket ? (ledger?.items ?? []).filter((i: any) => i.slot === "related").map((i: any) => i.representation) : [],
        latencyMs: +(latencyByBudget.get(budget)!.at(-1)!).toFixed(1),
        allocationMs: +(allocationMsByBudget.get(budget)!.at(-1)!).toFixed(1),
        tier: facts.tier, maxPivots: facts.maxPivots, maxSupport: facts.maxSupport,
        debugEnvelope: { withinEnvelope: debug?.responseBudget?.within_envelope ?? null, totalTokens: debug?.responseBudget?.estimated_total_response_tokens ?? null,
          ceilingTokens: debug?.responseBudget?.total_response_token_ceiling ?? null, compactedFields: Array.isArray(debug?.responseBudget?.compacted_fields) ? debug.responseBudget.compacted_fields : null },
        candidateCount: facts.candidateCount, poolCap: POOL_CAP,
        rankedPreCap, postCap,
        pivots: facts.pivotCount, support: facts.supportCount, discarded: facts.discardedCount,
        discardClasses: Object.fromEntries(stream.discardClasses.reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map<string, number>())),
        deliveredDemotedPivots: stream.deliveredDemotedPivots,
        stages, stop,
        utilisation: analysis === null ? null : {
          frozenWholeTokens: analysis.consumed.frozenWholeTokens, utilisationPercent: analysis.utilisationPercent,
          evidenceTokens: analysis.consumed.evidenceTokens, ceilingTokens: analysis.effectiveCeilingTokens,
          items: analysis.consumed.items, unusedFrozenBudget: analysis.unused.frozenBudgetTokens,
          bindingReason: analysis.bindingReason, bindingDetail: analysis.bindingDetail, integrity: analysis.verdict,
          upstreamVisible: analysis.upstream.modelVisibleTokens, upstreamRemaining: analysis.upstream.remainingTokens, upstreamStatus: analysis.upstream.deliveryStatus,
        },
        counterfactual: simulation === null ? null : {
          extras: stream.extras.length, unresolved: simulation.unresolvedExtra, deduplicated: simulation.deduplicatedExtra,
          admittedExtra: simulation.admittedExtra, admittedExtraAllBounds: simulation.admittedExtraAllBounds,
          rejectedForCeiling: simulation.rejectedExtraForCeiling, notReached: simulation.notReachedExtra,
          frozenTokens: simulation.frozenTokens, frozenTokensAllBounds: simulation.frozenTokensAllBounds,
          evidencePacketTokens: simulation.evidencePacketTokens,
          utilisationPercent: +(100 * simulation.frozenTokens / budget).toFixed(2),
          utilisationPercentAllBounds: +(100 * simulation.frozenTokensAllBounds / budget).toFixed(2),
          stopReason: simulation.stopReason, stopDetail: simulation.stopDetail,
          admittedIds: simulation.rows.filter((r) => r.fitsCeiling).map((r) => r.at),
          admittedRepresentations: simulation.rows.filter((r) => r.fitsCeiling).map((r) => r.representation),
          pivotVariant: simulationPivotVariant === null ? null : { frozenTokens: simulationPivotVariant.frozenTokens, frozenTokensAllBounds: simulationPivotVariant.frozenTokensAllBounds,
            utilisationPercent: +(100 * simulationPivotVariant.frozenTokens / budget).toFixed(2), admittedExtra: simulationPivotVariant.admittedExtra },
        },
        gates, gatesPass: gates.every((g) => g.pass),
      };
      responses.push(row);
      responseRows.push(row);
      if (simulation !== null) {
        for (const c of simulation.rows) candidateRows.push({ corpus: spec.id, task, budget, frozen_budget: row.frozenBudget, ...c });
      }
    }
  }

  // ---------------------------------------------------------- aggregates
  const packets = responses.filter((r) => r.utilisation !== null);
  const frozenPackets = packets.filter((r) => r.frozenBudget);
  const byBudget = Object.fromEntries(BUDGETS.map((b) => {
    const rows = packets.filter((r) => r.budget === b);
    const num = (f: (r: any) => number | null | undefined) => rows.map(f).filter((n): n is number => typeof n === "number");
    const hist = (f: (r: any) => string) => { const h: Record<string, number> = {}; for (const r of rows) h[f(r)] = (h[f(r)] ?? 0) + 1; return h; };
    const suff = sufficiencyRow({
      budget: b, rankedPreCap: num((r) => r.rankedPreCap), postCap: num((r) => r.postCap),
      currentFrozenTokens: num((r) => r.utilisation.frozenWholeTokens),
      uncappedFrozenTokens: num((r) => r.counterfactual?.frozenTokens), uncappedFrozenTokensAllBounds: num((r) => r.counterfactual?.frozenTokensAllBounds),
    });
    const discardTotals: Record<string, number> = {};
    for (const r of rows) for (const [k, v] of Object.entries(r.discardClasses as Record<string, number>)) discardTotals[k] = (discardTotals[k] ?? 0) + v;
    return [b, {
      responses: rows.length, ceilingTokens: ceilingRule(b), tier: [...new Set(rows.map((r) => r.tier))],
      sufficiency: suff,
      medians: {
        candidateCount: median(num((r) => r.candidateCount)), rankedPreCap: suff.medianRankedPreCap, postCap: suff.medianPostCap,
        pivots: median(num((r) => r.pivots)), support: median(num((r) => r.support)), discarded: median(num((r) => r.discarded)),
        tierCapDiscards: median(num((r) => r.discardClasses.TIER_SUPPORT_CAP ?? 0)),
        items: median(num((r) => r.utilisation.items)), frozenWholeTokens: suff.medianCurrentFrozenTokens,
        evidenceTokens: median(num((r) => r.utilisation.evidenceTokens)), unusedFrozenBudget: median(num((r) => r.utilisation.unusedFrozenBudget)),
        counterfactualAdmittedExtra: median(num((r) => r.counterfactual?.admittedExtra)),
        counterfactualAdmittedExtraAllBounds: median(num((r) => r.counterfactual?.admittedExtraAllBounds)),
        counterfactualFrozenTokens: suff.medianUncappedFrozenTokens, counterfactualFrozenTokensAllBounds: suff.medianUncappedFrozenTokensAllBounds,
        pivotVariantFrozenTokens: median(num((r) => r.counterfactual?.pivotVariant?.frozenTokens)),
        allocationMs: median(allocationMsByBudget.get(b) ?? []),
      },
      currentUtilisation: distributionOf(num((r) => r.utilisation.utilisationPercent)),
      frozenUtilisationMedian: rows.length === 0 ? null : +median(num((r) => r.utilisation.utilisationPercent)).toFixed(2),
      discardTotals,
      bindingReasons: hist((r) => r.utilisation.bindingReason),
      stopReasons: hist((r) => `${r.stop.reason}${r.stop.policy ? `:${r.stop.policy}` : ""}`),
      counterfactualStopReasons: hist((r) => r.counterfactual?.stopReason ?? "n/a"),
      totals: {
        gatesFailed: rows.filter((r) => !r.gatesPass).length, integrityFailures: rows.filter((r) => r.utilisation.integrity !== "UTILIZATION_INTEGRITY_PASS").length,
        unresolvedExtras: rows.reduce((n, r) => n + (r.counterfactual?.unresolved ?? 0), 0),
        deduplicatedExtras: rows.reduce((n, r) => n + (r.counterfactual?.deduplicated ?? 0), 0),
        counterfactualRejectedForCeiling: rows.reduce((n, r) => n + (r.counterfactual?.rejectedForCeiling ?? 0), 0),
      },
      latency: latencyStats(latencyByBudget.get(b) ?? []),
      largestPacketBytes: Math.max(0, ...(packetBytesByBudget.get(b) ?? [])),
    }];
  }));
  const sufficiencyRows = BUDGETS.map((b) => byBudget[b]!.sufficiency);
  const frozenMedians = A11_BUDGETS.map((b) => byBudget[b]?.frozenUtilisationMedian ?? null);
  const frozenA11 = { utilisationByBudget: Object.fromEntries(A11_BUDGETS.map((b, k) => [b, { median: frozenMedians[k] }])), verdict: frozenA11Verdict(frozenMedians) };
  const counterfactualMedians = A11_BUDGETS.map((b) => byBudget[b]?.sufficiency.theoreticalUtilisationMedian ?? null);
  const counterfactualMediansAllBounds = A11_BUDGETS.map((b) => byBudget[b]?.sufficiency.theoreticalUtilisationAllBoundsMedian ?? null);

  // The frozen A13 rule, observed and not optimised.
  const curves = budgetTasks.map((task) => {
    const points = A11_BUDGETS.map((b) => responses.find((r) => r.task === task && r.budget === b)).filter(Boolean);
    let sizeViolations = 0; let focusSwaps = 0;
    for (let i = 1; i < points.length; i += 1) {
      if (points[i]!.focusCodeTokensFrozen < points[i - 1]!.focusCodeTokensFrozen) sizeViolations += 1;
      if (points[i]!.focusAt !== points[i - 1]!.focusAt) focusSwaps += 1;
    }
    const relations = A11_BUDGETS.slice(1).map((b, k) => {
      const lo = points[k]; const hi = points[k + 1];
      return { from: A11_BUDGETS[k], to: b, relation: lo && hi ? orderRelation(lo.relatedIds, hi.relatedIds) : "unmeasured" };
    });
    return { task, sizeViolations, focusSwaps, focusByBudget: Object.fromEntries(points.map((p) => [p!.budget, p!.focusAt])), orderRelations: relations };
  });
  const relationHist: Record<string, number> = {};
  for (const c of curves) for (const r of c.orderRelations) relationHist[r.relation] = (relationHist[r.relation] ?? 0) + 1;

  // Tail: the worst-utilised frozen responses, each with what stopped it.
  const tail = [...frozenPackets].sort((x, y) => x.utilisation.utilisationPercent - y.utilisation.utilisationPercent).slice(0, 10)
    .map((r) => ({ task: r.task, budget: r.budget, utilisationPercent: r.utilisation.utilisationPercent, frozenWholeTokens: r.utilisation.frozenWholeTokens,
      items: r.utilisation.items, candidateCount: r.candidateCount, rankedPreCap: r.rankedPreCap, postCap: r.postCap,
      remainingTruthfulSupply: r.counterfactual?.extras ?? null, nextItemFits: r.counterfactual ? r.counterfactual.admittedExtra > 0 : null,
      counterfactualUtilisation: r.counterfactual?.utilisationPercent ?? null, counterfactualUtilisationAllBounds: r.counterfactual?.utilisationPercentAllBounds ?? null,
      stop: r.stop, counterfactualStop: r.counterfactual?.stopReason ?? null, bindingReason: r.utilisation.bindingReason }));

  db.close();
  const unstable = [...packetHashes.entries()].filter(([, s]) => s.size > 1).map(([k]) => k);
  const unstableLedgers = [...ledgerHashes.entries()].filter(([, s]) => s.size > 1).map(([k]) => k);
  const stopAll: Record<string, number> = {};
  for (const r of frozenPackets) { const k = `${r.stop.reason}${r.stop.policy ? `:${r.stop.policy}` : ""}`; stopAll[k] = (stopAll[k] ?? 0) + 1; }
  const stageTotals: Record<string, { lost: number; otherwiseEligibleLost: number; lostByReason: Record<string, number> }> = {};
  for (const r of frozenPackets) for (const s of r.stages) {
    const t = stageTotals[s.stage] ?? { lost: 0, otherwiseEligibleLost: 0, lostByReason: {} };
    t.lost += s.lost; t.otherwiseEligibleLost += s.otherwiseEligibleLost;
    for (const [k, v] of Object.entries(s.lostByReason as Record<string, number>)) t.lostByReason[k] = (t.lostByReason[k] ?? 0) + v;
    stageTotals[s.stage] = t;
  }

  perCorpus.push({
    id: spec.id, filesIndexed: indexed?.summary?.filesIndexed ?? null, tasks: budgetTasks.length,
    budgets: BUDGETS, frozenBudgets: A11_BUDGETS, responseCount: responses.length, packets: packets.length,
    frozenA11,
    counterfactualA11: {
      utilisationByBudget: Object.fromEntries(A11_BUDGETS.map((b, k) => [b, { median: counterfactualMedians[k], medianAllBounds: counterfactualMediansAllBounds[k] }])),
      verdictIfUncapped: frozenA11Verdict(counterfactualMedians), verdictIfUncappedAllBounds: frozenA11Verdict(counterfactualMediansAllBounds),
    },
    supplySufficiency: { rows: sufficiencyRows, verdict: supplyVerdict(sufficiencyRows) },
    frozenA13: { tasksWithSizeViolation: curves.filter((c) => c.sizeViolations > 0).length, tasksWithFocusSwap: curves.filter((c) => c.focusSwaps > 0).length, curves },
    orderRelations: relationHist,
    byBudget, stopReasonsOverFrozen: stopAll, stageTotalsOverFrozen: stageTotals,
    integrity: { packets: packets.length, gateFailures: packets.filter((r) => !r.gatesPass).length,
      failedGates: packets.flatMap((r) => r.gates.filter((g: any) => !g.pass).map((g: any) => `${r.task}@${r.budget}:${g.id}`)).slice(0, 60) },
    tail,
    determinism: { repeats: REPEATS, packetsStable: unstable.length === 0, unstablePackets: unstable, ledgersStable: unstableLedgers.length === 0, unstableLedgers },
    resources: { peakRssBytes, largestPacketBytes: Math.max(0, ...[...packetBytesByBudget.values()].flat()),
      largestItemCount: Math.max(0, ...packets.map((r) => r.utilisation.items)), largestRankedStream: Math.max(0, ...packets.map((r) => r.rankedPreCap ?? 0)) },
    responses: responses.map(({ stages: _s, gates: g, ...rest }) => ({ ...rest, failedGates: g.filter((x: any) => !x.pass).map((x: any) => x.id) })),
  });
  const c = perCorpus.at(-1)!;
  console.log(`[${LABEL}] ${spec.id.padEnd(8)} A11 ${A11_BUDGETS.map((b) => `${b}=${byBudget[b]?.frozenUtilisationMedian}%`).join(" ")} ${frozenA11.verdict}`
    + ` | uncapped ${A11_BUDGETS.map((b) => `${b}=${byBudget[b]?.sufficiency.theoreticalUtilisationMedian}%/${byBudget[b]?.sufficiency.theoreticalUtilisationAllBoundsMedian}%`).join(" ")}`
    + ` ${c.supplySufficiency.verdict} | stops ${JSON.stringify(stopAll)} | A13 size ${c.frozenA13.tasksWithSizeViolation} swap ${c.frozenA13.tasksWithFocusSwap}`
    + ` | gate failures ${c.integrity.gateFailures} | stable ${c.determinism.packetsStable}`);
}

const cmed = perCorpus.find((c) => c.id === "C-MED");
const out = {
  milestone: "M206", instrument: "run_stage5_m206_allocation.ts", label: LABEL,
  product: { root: PRODUCT_ROOT, head: productHead, poolCap: POOL_CAP, allocator: allocatorPolicy, relatedCodeCharacters: RELATED_BOUND, focusCodeCharacters: ORIENTATION_POLICY.focusCodeCharacters },
  protocol: {
    calls: "get_code_context, default detail, max_tokens at each budget, one index per corpus copy; one paired detail=debug call (include_item_content) and one direct read-only capsule build per request for the ranked stream",
    tasks: "A13_TASKS (all 20 on C-MED, first 3 elsewhere)", budgets: BUDGETS, frozenBudgets: A11_BUDGETS,
    frozenNumerator: "ceil(JSON.stringify(output).length / 4) (engine rule, verbatim)", frozenDenominator: "the caller's max_tokens",
    frozenAggregate: "per-budget median over the C-MED tasks", frozenBand: "MATCHES >= 60% at every frozen budget; EXCEEDS >= 80% (report rule, verbatim)",
    counterfactual: "delivered prefix + every count-cap discard in the capsule's order; relationship-only admission under the caller's ceiling (prefix, first miss ends it); then the M205 router offers each admitted extra its upstream form under the same ceiling; the upstream evidence budget and the capsule token budget are reported as a second bound (all-bounds figure)",
    sufficiencyRule: "required_match_tokens(B) = ceil(0.6 x B) whole-packet chars/4 tokens; SUFFICIENT when the all-bounds median reaches it, INSUFFICIENT when the ceiling-only median does not, INDETERMINATE between; the verdict needs every frozen budget",
  },
  hardware: { cpus: navigator.hardwareConcurrency, loadAverageAtEnd: loadAverage(), peakRssBytes },
  frozenA11: cmed?.frozenA11 ?? null, counterfactualA11: cmed?.counterfactualA11 ?? null, supplySufficiency: cmed?.supplySufficiency ?? null,
  frozenA13: cmed === undefined ? null : { tasksWithSizeViolation: cmed.frozenA13.tasksWithSizeViolation, tasksWithFocusSwap: cmed.frozenA13.tasksWithFocusSwap, orderRelations: cmed.orderRelations },
  corpora: perCorpus,
};
writeFileSync(path.join(RESULTS, `stage5_m206_allocation_${LABEL}.json`), `${JSON.stringify(out, null, 2)}\n`);
writeFileSync(path.join(RESULTS, `stage5_m206_allocation_audit_${LABEL}.jsonl`),
  `${responseRows.map((r) => JSON.stringify({ corpus: r.corpus, task: r.task, budget: r.budget, frozen_budget: r.frozenBudget, tier: r.tier, candidate_count: r.candidateCount,
    ranked_pre_cap: r.rankedPreCap, post_cap: r.postCap, pivots: r.pivots, support: r.support, discarded: r.discarded, discard_classes: r.discardClasses,
    stages: r.stages, stop: r.stop, utilisation: r.utilisation, counterfactual: r.counterfactual, gates_pass: r.gatesPass, failed_gates: r.gates.filter((g: any) => !g.pass).map((g: any) => g.id) })).join("\n")}\n`);
if (candidateRows.length > 0) {
  writeFileSync(path.join(RESULTS, `stage5_m206_uncapped_supply_${LABEL}.jsonl`), `${candidateRows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}
console.log(`[${LABEL}] frozen A11 C-MED ${JSON.stringify(cmed?.frozenA11?.utilisationByBudget ?? null)} ${cmed?.frozenA11?.verdict ?? "UNMEASURED"};`
  + ` supply ${cmed?.supplySufficiency?.verdict ?? "UNMEASURED"} -> results/stage5_m206_allocation_${LABEL}.json + ${responseRows.length} audit rows + ${candidateRows.length} candidate rows`);
