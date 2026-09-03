/**
 * M207 — the retrieval-pool width sweep: the frozen A11 protocol run through
 * the REAL default `get_code_context` path at every width, with the ranked
 * stream the capsule saw bound beside each response.
 *
 * Runs EXACTLY the calls the frozen engine makes for A11/A13 — every A13 task
 * on C-MED (and the first three on the other corpora) at each budget through
 * the default handler — once per pool width. The width reaches the capsule
 * builder through the MCP server's construction-time instrumentation field
 * (`retrievalInstrumentation.candidatePoolSize`), which no request can set;
 * everything downstream of the pool — the lexical row budget, the backfill
 * lanes' own windows, the role gate, the pivot cap, the M206 allocator, the
 * M205 router, the M203 accounting, the evidence budget, the envelope and the
 * projector ceiling — runs unchanged at its product value. So a sweep over the
 * width varies retrieval breadth alone, and the frozen scorer reads the packet
 * the model would actually have been handed. Nothing is simulated.
 *
 * Beside each default call the driver makes ONE paired `detail=debug` call
 * (delivery, accounting and envelope facts) and ONE direct read-only capsule
 * build at the same width (the ranked stream: pool, pivots, support, every
 * discard with its verbatim reason). The pool the product uses with no
 * instrument at all is also run, as the seam-identity control: at the product
 * width the instrumented packets must be byte-identical to it.
 *
 * `--product-root` selects which tree's product code answers; `--scratch`
 * selects the corpus copy, so a later product can be run against an earlier
 * copy for same-corpus attribution.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m207_pool_sweep.ts \
 *     --label pre [--product-root <dir>] [--scratch <dir>] [--repeats 1] \
 *     [--corpora C-MED] [--widths 25,50,100,200,uncapped] \
 *     [--budgets 1000,1500,2000,3000,4000,6000,8000,12000,16000]
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { A13_TASKS, corpusSpecs, latencyStats, prepareCorpus } from "./m197aFixtures";
import {
  A11_BUDGETS, analyzeUtilization, frozenA11Verdict, median, orderRelation, type ResponseUtilization, type UpstreamSupply,
} from "./m204Utilization";
import { classifyDiscardReason, distributionOf, type DiscardClass } from "./m206Allocation";
import {
  DEFAULT_SWEEP_WIDTHS, PRODUCT_WIDTH, UNCAPPED_WIDTH, candidateFate, discardClassHistogram, narrowestSufficientWidth, parseWidths, provenanceOf,
  retrievalSupplyVerdict, roleIdentity, stopAtWidth, tailQuality, widthBudgetSupply, widthLabel,
  type ExposedCandidate, type PoolCandidate, type ResponseFacts, type TailQuality, type WidthBudgetSupply,
} from "./m207RetrievalPool";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const LABEL = argOf("--label", "post");
const PRODUCT_ROOT = path.resolve(argOf("--product-root", REPO));
const SCRATCH = argOf("--scratch", `/tmp/m207-pool-${LABEL}`);
const REPEATS = Number.parseInt(argOf("--repeats", "1"), 10);
const CORPORA = argOf("--corpora", "C-MED").split(",");
const BUDGETS = argOf("--budgets", "1000,1500,2000,3000,4000,6000,8000,12000,16000").split(",").map((b) => Number.parseInt(b, 10));
const WIDTHS = args.includes("--widths") ? parseWidths(argOf("--widths", "")) : [...DEFAULT_SWEEP_WIDTHS];
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
const { allocateBudget } = await import(path.join(PRODUCT_ROOT, "src/capsuleV2/budgetAllocator.ts"));
const { PIVOT_NEIGHBORHOOD_DEFAULTS } = await import(path.join(PRODUCT_ROOT, "src/runPipeline/pivotNeighborhood.ts"));
const { buildAuthoritativeProductRetrieval } = await import(path.join(PRODUCT_ROOT, "src/capsuleV2/authoritativeProductRetrieval.ts"));
const { orientationAccountingOf } = accountingModule;
const ORIENTATION_POLICY = projection.ORIENTATION_POLICY;
const FROZEN_PHRASES: readonly string[] = projection.ORIENTATION_FROZEN_PHRASES;
const ceilingRule: (requested: number | string) => number = projection.orientationCeilingTokens;
const productHead = Bun.spawnSync(["git", "-C", PRODUCT_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();

// The product pool, read from the product source rather than restated. A
// budget-derived product carries no single constant; then the allocator's own
// value at each budget is the product width.
const capsuleSource = readFileSync(path.join(PRODUCT_ROOT, "src/capsuleV2/buildCapsuleV2.ts"), "utf8");
const FIXED_POOL = /const CANDIDATE_POOL_SIZE = (\d+);/.exec(capsuleSource);
const productPoolAt = (budget: number): number | null => {
  const allocation = allocateBudget(budget) as { candidatePool?: number };
  if (typeof allocation.candidatePool === "number") return allocation.candidatePool;
  return FIXED_POOL === null ? null : Number.parseInt(FIXED_POOL[1]!, 10);
};
const seamSupported = /candidatePoolSize/.test(capsuleSource);
if (!seamSupported) throw new Error("M207_PRODUCT_HAS_NO_POOL_SEAM: the named product cannot vary its retrieval pool");

const call = async (server: any, toolId: string, input: unknown, id = "m207"): Promise<any> => {
  const res: any = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: id, toolId, input } as any);
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

console.log(`[${LABEL}] product ${PRODUCT_ROOT} @ ${productHead.slice(0, 12)}; product pool ${FIXED_POOL === null ? "budget-derived" : FIXED_POOL[1]}; `
  + `widths ${WIDTHS.map(widthLabel).join(",")}; budgets ${BUDGETS.join(",")}; repeats ${REPEATS}; load ${loadAverage().join(" ")}`);

// ------------------------------------------------------ the ranked stream

interface StreamFacts {
  readonly built: any;
  readonly supply: UpstreamSupply;
  readonly discardClasses: DiscardClass[];
  readonly pool: PoolCandidate[];
  readonly pivotFqNames: string[];
  readonly supportFqNames: string[];
  readonly roleDiscardFqNames: string[];
  readonly capsuleBuildMs: number;
}

/** The capsule's own view of the request at this width: pool (with scores), pivots, support and every discard in its order. */
function bindStream(db: any, work: string, task: string, debug: any, budget: number, width: number | null): StreamFacts {
  const allocation = allocateBudget(budget);
  const neighborhoods: any[] = Array.isArray(debug?.pivotNeighborhood) ? debug.pivotNeighborhood : [];
  const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
  const preset = debug?.intent?.selectedPreset;
  const capsuleIntent = debug?.intent?.selectedIntent;
  const maxBudgetCharacters = count(debug?.request?.maxBudgetCharacters) ?? budget * 4;
  let built: any = null;
  const t0 = performance.now();
  if (typeof preset === "string") {
    try {
      built = buildAuthoritativeProductRetrieval(db, work, { query: task, preset, maxBudgetCharacters,
        ...(typeof capsuleIntent === "string" ? { capsuleIntent } : {}),
        ...(width === null ? {} : { candidatePoolSize: width }) }).result;
    } catch { built = null; }
  }
  const capsuleBuildMs = performance.now() - t0;
  const discarded: any[] = Array.isArray(built?.discarded) ? built.discarded : [];
  const poolRows: any[] = Array.isArray(built?.diagnostics?.candidate_scores) ? built.diagnostics.candidate_scores : [];
  const pool: PoolCandidate[] = poolRows.map((c) => ({
    rank: c.rank, symbolId: String(c.symbol_id), path: String(c.path), fqName: String(c.fq_name), symbol: String(c.symbol),
    finalScore: typeof c.scores?.final === "number" ? c.scores.final : 0,
    sources: Array.isArray(c.sources) ? c.sources.map(String) : [], evidence: Array.isArray(c.evidence) ? c.evidence.map(String) : [],
  }));
  const byReason: Record<string, number> = {};
  const discardClasses: DiscardClass[] = [];
  const roleDiscardFqNames: string[] = [];
  const fqOf = (path: string, symbol: string): string => {
    const row = poolRows.find((c) => c.path === path && c.symbol === symbol);
    return row ? String(row.fq_name) : `${path}::${symbol}`;
  };
  for (const d of discarded) {
    const r = String(d?.discard_reason ?? "unknown");
    byReason[r] = (byReason[r] ?? 0) + 1;
    const cls = classifyDiscardReason(r, typeof d?.role_reason === "string" ? d.role_reason : undefined);
    discardClasses.push(cls);
    if (cls === "ROLE_GATE" || cls === "NO_PIVOT_SUPPORT_ONLY") roleDiscardFqNames.push(fqOf(d.path, d.symbol));
  }
  const supportItems: any[] = Array.isArray(built?.support) ? built.support : [];
  const supply: UpstreamSupply = {
    tier: typeof built?.actual_mode === "string" ? built.actual_mode : null,
    maxPivots: allocation.maxPivots, maxSupport: (allocation as any).maxSupport ?? allocation.supportWindow ?? null,
    candidateCount: count(built?.diagnostics?.candidate_count),
    pivotCount: built ? built.pivots.length : null, supportCount: built ? supportItems.length : null,
    discardedCount: built ? discarded.length : null, discardedByReason: built ? byReason : null,
    discardedForTierCap: built ? discardClasses.filter((c) => c === "TIER_SUPPORT_CAP").length : null,
    directBuildConsistent: null,
    neighborhoodExcerpts: neighborhoods.reduce((n, e) => n + (Array.isArray(e?.excerpts) ? e.excerpts.length : 0), 0),
    neighborhoodPivots: neighborhoods.length,
    neighborhoodMaxPivots: PIVOT_NEIGHBORHOOD_DEFAULTS.maxPivots,
    neighborhoodMaxExcerptsPerPivot: PIVOT_NEIGHBORHOOD_DEFAULTS.maxExcerptsPerPivot,
  };
  return {
    built, supply, discardClasses, pool, capsuleBuildMs,
    pivotFqNames: (built?.pivots ?? []).map((p: any) => String(p.fq_name)),
    supportFqNames: supportItems.map((s: any) => String(s.fq_name)),
    roleDiscardFqNames,
  };
}

const perCorpus: any[] = [];
const responseRows: any[] = [];
const exposedRows: ExposedCandidate[] = [];
let peakRssBytes = 0;
const noteMemory = () => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); };

for (const spec of corpusSpecs(REPO).filter((s) => CORPORA.includes(s.id))) {
  const work = prepareCorpus(spec, SCRATCH);
  if (work === null) { perCorpus.push({ id: spec.id, status: "CORPUS_ABSENT" }); continue; }
  const dbPath = path.join(work, ".vtrace/index.sqlite");
  const plainServer = createMcpServer({ context: { repoRoot: work, dbPath } } as any);
  const indexed = await call(plainServer, McpToolId.IndexRepo, { repo_root: work }, "idx");
  if (indexed?.readiness?.status !== "ready") {
    perCorpus.push({ id: spec.id, status: "INDEX_NOT_READY", readiness: indexed?.readiness ?? null });
    continue;
  }
  const db = new Database(dbPath, { readonly: true });
  const budgetTasks = spec.id === "C-MED" ? A13_TASKS : A13_TASKS.slice(0, 3);
  const responses: any[] = [];
  const factsByKey = new Map<string, ResponseFacts>();
  const poolByKey = new Map<string, PoolCandidate[]>();
  const packetHashes = new Map<string, Set<string>>();
  const ledgerHashes = new Map<string, Set<string>>();
  const seamIdentity = { compared: 0, identical: 0, differing: [] as string[] };

  for (const width of WIDTHS) {
    // `product`: no instrument at all; the width the product derives per budget
    // is read from its allocator for the stop reason and the identity control.
    const server = width === PRODUCT_WIDTH
      ? plainServer
      : createMcpServer({ context: { repoRoot: work, dbPath, retrievalInstrumentation: { candidatePoolSize: width } } } as any);
    const effectiveWidth = (budget: number): number => (width === PRODUCT_WIDTH ? (productPoolAt(budget) ?? UNCAPPED_WIDTH) : width);
    const latencyByBudget = new Map<number, number[]>();
    const buildMsByBudget = new Map<number, number[]>();
    const packetBytesByBudget = new Map<number, number[]>();
    for (const task of budgetTasks) {
      for (const budget of BUDGETS) {
        let out: any = null; let ledger: any = null;
        // The seam-identity control: at the product's own width the uninstrumented
        // handler is called IMMEDIATELY before the instrumented one, in the same
        // process state, and the two packets must be byte-identical. (An earlier
        // draft compared against a separate first pass; the product's packet at a
        // tight budget depends on process state that pass did not share.)
        const productSha = width !== PRODUCT_WIDTH && productPoolAt(budget) === width
          ? sha(JSON.stringify((await call(plainServer, McpToolId.GetCodeContext, { task, repo_root: work, max_tokens: budget })) ?? null))
          : null;
        for (let r = 0; r < REPEATS; r += 1) {
          const t0 = performance.now();
          out = await call(server, McpToolId.GetCodeContext, { task, repo_root: work, max_tokens: budget });
          const ms = performance.now() - t0;
          noteMemory();
          latencyByBudget.set(budget, [...(latencyByBudget.get(budget) ?? []), ms]);
          packetBytesByBudget.set(budget, [...(packetBytesByBudget.get(budget) ?? []), JSON.stringify(out ?? null).length]);
          ledger = out && typeof out === "object" ? orientationAccountingOf(out) : undefined;
          const key = `${widthLabel(width)}|${task}@${budget}`;
          const ph = packetHashes.get(key) ?? new Set(); ph.add(sha(JSON.stringify(out ?? null))); packetHashes.set(key, ph);
          const lh = ledgerHashes.get(key) ?? new Set(); lh.add(sha(JSON.stringify(ledger ?? null))); ledgerHashes.set(key, lh);
        }
        const isPacket = out && typeof out === "object" && "focus" in out;
        const packetSha = sha(JSON.stringify(out ?? null));
        if (productSha !== null) {
          seamIdentity.compared += 1;
          if (productSha === packetSha) seamIdentity.identical += 1; else seamIdentity.differing.push(`${task}@${budget}`);
        }
        const debug = await call(server, McpToolId.GetCodeContext, { task, repo_root: work, max_tokens: budget, detail: "debug", include_item_content: true }, "dbg");
        const stream = bindStream(db, work, task, debug, budget, width === PRODUCT_WIDTH ? null : width);
        buildMsByBudget.set(budget, [...(buildMsByBudget.get(budget) ?? []), stream.capsuleBuildMs]);
        const facts = stream.supply;
        const analysis: ResponseUtilization | null = isPacket ? analyzeUtilization({
          budget, packet: out, ledger, expectedCeilingTokens: ceilingRule(budget),
          headBoundCharacters: ORIENTATION_POLICY.focusCodeCharacters, frozenPhrases: FROZEN_PHRASES, upstream: facts,
        }) : null;
        const delivery = debug?.productContext?.delivery ?? null;
        const discardClasses = discardClassHistogram(stream.discardClasses);
        const stop = stopAtWidth({
          projectorRejectedForCeiling: ledger?.candidates?.rejectedForCeiling ?? null,
          evidenceBudgetDropped: delivery?.droppedForBudget ?? null,
          evidenceBudgetCompacted: delivery?.status === "compacted",
          discardClasses, candidateCount: facts.candidateCount, width: effectiveWidth(budget),
        });
        const relatedIds: string[] = isPacket ? (out.related ?? []).map((r: any) => String(r.at)) : [];
        const built = stream.built;
        const rankedStream = built ? built.pivots.length + built.support.length + built.discarded.length : null;
        const rf: ResponseFacts = {
          task, budget, width: effectiveWidth(budget), candidateCount: facts.candidateCount, rankedStream,
          roleDiscards: stream.roleDiscardFqNames.length,
          pivotFqNames: stream.pivotFqNames, supportFqNames: stream.supportFqNames, discardClasses,
          focusAt: isPacket ? String(out.focus.at) : null, relatedIds,
          frozenWholeTokens: analysis?.consumed.frozenWholeTokens ?? null, utilisationPercent: analysis?.utilisationPercent ?? null,
          deliveredItems: analysis?.consumed.items ?? null, stop: { reason: stop.reason, policy: stop.policy },
        };
        const key = `${widthLabel(width)}|${task}@${budget}`;
        factsByKey.set(key, rf);
        poolByKey.set(key, stream.pool);
        const representationByAt = new Map<string, string>(
          (ledger?.items ?? []).filter((i: any) => i.slot === "related").map((i: any) => [String(i.at), String(i.representation)] as const));
        const row = {
          corpus: spec.id, task, budget, width: widthLabel(width), poolWidth: effectiveWidth(budget) === UNCAPPED_WIDTH ? null : effectiveWidth(budget), frozenBudget: (A11_BUDGETS as readonly number[]).includes(budget),
          shape: isPacket ? "orientation" : String(out?.schemaVersion ?? out?.__error?.code ?? "other"),
          packetSha, focusAt: rf.focusAt, focusForm: isPacket ? out.focus.form : null,
          focusCodeTokensFrozen: isPacket ? Math.ceil((out.focus.code ?? "").length / 4) : 0,
          relatedIds, relatedRepresentations: relatedIds.map((id) => representationByAt.get(id) ?? "unlabelled"),
          latencyMs: +(latencyByBudget.get(budget)!.at(-1)!).toFixed(1), capsuleBuildMs: +stream.capsuleBuildMs.toFixed(1),
          tier: facts.tier, maxPivots: facts.maxPivots, supportWindow: facts.maxSupport,
          debugEnvelope: { withinEnvelope: debug?.responseBudget?.within_envelope ?? null, totalTokens: debug?.responseBudget?.estimated_total_response_tokens ?? null,
            ceilingTokens: debug?.responseBudget?.total_response_token_ceiling ?? null, compactedFields: Array.isArray(debug?.responseBudget?.compacted_fields) ? debug.responseBudget.compacted_fields : null },
          candidateCount: facts.candidateCount, rankedStream, pivots: facts.pivotCount, support: facts.supportCount, discarded: facts.discardedCount,
          roleDiscards: rf.roleDiscards, discardClasses, stop,
          delivery: delivery === null ? null : { status: delivery.status ?? null, selectedItemsBeforeBudget: delivery.selectedItemsBeforeBudget ?? null,
            deliveredItems: delivery.deliveredItems ?? null, droppedForBudget: delivery.droppedForBudget ?? null,
            compactionStages: Array.isArray(delivery.compactionStages) ? delivery.compactionStages : [] },
          assembly: { items: Array.isArray(debug?.productContext?.items) ? debug.productContext.items.length : null,
            duplicateItemsRemoved: debug?.productContext?.accounting?.duplicateItemCountRemoved ?? null,
            renderedCharacters: debug?.productContext?.accounting?.renderedCharacters ?? null },
          projector: ledger?.candidates ?? null,
          utilisation: analysis === null ? null : {
            frozenWholeTokens: analysis.consumed.frozenWholeTokens, utilisationPercent: analysis.utilisationPercent,
            evidenceTokens: analysis.consumed.evidenceTokens, ceilingTokens: analysis.effectiveCeilingTokens,
            items: analysis.consumed.items, unusedFrozenBudget: analysis.unused.frozenBudgetTokens,
            bindingReason: analysis.bindingReason, bindingDetail: analysis.bindingDetail, integrity: analysis.verdict,
            upstreamVisible: analysis.upstream.modelVisibleTokens, upstreamRemaining: analysis.upstream.remainingTokens, upstreamStatus: analysis.upstream.deliveryStatus,
            gates: analysis.gates.filter((g) => !g.pass).map((g) => g.id),
          },
          pivotFqNames: rf.pivotFqNames, supportCount: rf.supportFqNames.length,
        };
        responses.push(row);
        responseRows.push(row);
      }
    }
    // Per-width latency summaries are attached after the loop (below).
    perCorpus.push({ marker: "width-latency", corpus: spec.id, width: widthLabel(width),
      latency: Object.fromEntries(BUDGETS.map((b) => [b, latencyStats(latencyByBudget.get(b) ?? [])])),
      capsuleBuildMs: Object.fromEntries(BUDGETS.map((b) => [b, latencyStats(buildMsByBudget.get(b) ?? [])])),
      largestPacketBytes: Object.fromEntries(BUDGETS.map((b) => [b, Math.max(0, ...(packetBytesByBudget.get(b) ?? []))])) });
    const frozen = responses.filter((r) => r.width === widthLabel(width) && r.frozenBudget && r.utilisation);
    console.log(`[${LABEL}] ${spec.id} width ${widthLabel(width).padEnd(8)} A11 `
      + A11_BUDGETS.map((b) => `${b}=${median(frozen.filter((r) => r.budget === b).map((r) => r.utilisation.utilisationPercent)).toFixed(2)}%`).join(" ")
      + ` | median pool ${median(frozen.map((r) => r.candidateCount ?? 0))} stream ${median(frozen.map((r) => r.rankedStream ?? 0))}`
      + ` | p90 16000 ${latencyStats(latencyByBudget.get(16000) ?? []).p90} ms | seam ${seamIdentity.identical}/${seamIdentity.compared}`);
  }

  // ---------------------------------------------------------- aggregates
  const widthLatency = perCorpus.filter((c) => c.marker === "width-latency" && c.corpus === spec.id);
  const packets = responses.filter((r) => r.utilisation !== null);
  const supplyRows: WidthBudgetSupply[] = [];
  const byWidth: Record<string, any> = {};
  for (const width of WIDTHS) {
    const wl = widthLabel(width);
    const rowsW = packets.filter((r) => r.width === wl);
    const byBudget: Record<string, any> = {};
    for (const b of BUDGETS) {
      const rows = rowsW.filter((r) => r.budget === b);
      const num = (f: (r: any) => number | null | undefined) => rows.map(f).filter((n): n is number => typeof n === "number");
      const hist = (f: (r: any) => string) => { const h: Record<string, number> = {}; for (const r of rows) h[f(r)] = (h[f(r)] ?? 0) + 1; return h; };
      const supply = widthBudgetSupply({
        width, budget: b, frozenTokens: num((r) => r.utilisation.frozenWholeTokens), utilisation: num((r) => r.utilisation.utilisationPercent),
        candidateCounts: num((r) => r.candidateCount), rankedStreams: num((r) => r.rankedStream), deliveredItems: num((r) => r.utilisation.items),
      });
      supplyRows.push(supply);
      const discardTotals: Record<string, number> = {};
      for (const r of rows) for (const [k, v] of Object.entries(r.discardClasses as Record<string, number>)) discardTotals[k] = (discardTotals[k] ?? 0) + v;
      const lat = widthLatency.find((c) => c.width === wl);
      byBudget[b] = {
        responses: rows.length, ceilingTokens: ceilingRule(b), tier: [...new Set(rows.map((r) => r.tier))],
        supply,
        medians: {
          candidateCount: median(num((r) => r.candidateCount)), rankedStream: median(num((r) => r.rankedStream)),
          eligible: median(num((r) => (r.candidateCount ?? 0) - r.roleDiscards)),
          pivots: median(num((r) => r.pivots)), support: median(num((r) => r.support)), discarded: median(num((r) => r.discarded)),
          roleDiscards: median(num((r) => r.roleDiscards)),
          assemblyItems: median(num((r) => r.assembly.items)), selectedBeforeBudget: median(num((r) => r.delivery?.selectedItemsBeforeBudget)),
          deliveredUpstream: median(num((r) => r.delivery?.deliveredItems)), droppedForBudget: median(num((r) => r.delivery?.droppedForBudget)),
          projectorProposed: median(num((r) => r.projector?.proposed)), projectorAdmitted: median(num((r) => r.projector?.admitted)),
          projectorDeduplicated: median(num((r) => r.projector?.deduplicated)), projectorRejectedForCeiling: median(num((r) => r.projector?.rejectedForCeiling)),
          items: median(num((r) => r.utilisation.items)), frozenWholeTokens: supply.medianFrozenTokens,
          evidenceTokens: median(num((r) => r.utilisation.evidenceTokens)), unusedFrozenBudget: median(num((r) => r.utilisation.unusedFrozenBudget)),
          renderedCharacters: median(num((r) => r.assembly.renderedCharacters)),
        },
        utilisation: distributionOf(num((r) => r.utilisation.utilisationPercent)),
        frozenUtilisationMedian: rows.length === 0 ? null : +median(num((r) => r.utilisation.utilisationPercent)).toFixed(2),
        discardTotals,
        bindingReasons: hist((r) => r.utilisation.bindingReason),
        stopReasons: hist((r) => `${r.stop.reason}${r.stop.policy ? `:${r.stop.policy}` : ""}`),
        upstreamStatus: hist((r) => String(r.utilisation.upstreamStatus)),
        integrityFailures: rows.filter((r) => r.utilisation.integrity !== "UTILIZATION_INTEGRITY_PASS").length,
        latency: lat?.latency?.[b] ?? null, capsuleBuildMs: lat?.capsuleBuildMs?.[b] ?? null, largestPacketBytes: lat?.largestPacketBytes?.[b] ?? 0,
      };
    }
    const frozenMedians = A11_BUDGETS.map((b) => byBudget[b]?.frozenUtilisationMedian ?? null);
    byWidth[wl] = { width: wl, byBudget, frozenA11: { utilisationByBudget: Object.fromEntries(A11_BUDGETS.map((b, k) => [b, { median: frozenMedians[k] }])), verdict: frozenA11Verdict(frozenMedians) } };
  }

  // Tail quality: what the wider widths newly exposed, and what became of it.
  const baseWidth = WIDTHS[0]!;
  const tail: TailQuality[] = [];
  const identities: any[] = [];
  for (const width of WIDTHS.slice(1)) {
    for (const b of BUDGETS) {
      const exposed: ExposedCandidate[] = [];
      const baselineScores: number[] = [];
      let duplicates = 0;
      const pairs: { base: ResponseFacts; at: ResponseFacts }[] = [];
      for (const task of budgetTasks) {
        const baseKey = `${widthLabel(baseWidth)}|${task}@${b}`; const atKey = `${widthLabel(width)}|${task}@${b}`;
        const base = factsByKey.get(baseKey); const at = factsByKey.get(atKey);
        if (base === undefined || at === undefined) continue;
        pairs.push({ base, at });
        const basePool = poolByKey.get(baseKey) ?? []; const atPool = poolByKey.get(atKey) ?? [];
        const baseIds = new Set(basePool.map((c) => c.symbolId));
        for (const c of basePool) baselineScores.push(c.finalScore);
        const row = responses.find((r) => r.width === widthLabel(width) && r.task === task && r.budget === b);
        const representationByAt = new Map<string, string>((row?.relatedIds ?? []).map((id: string, k: number) => [id, row.relatedRepresentations[k]] as const));
        duplicates += row?.projector?.deduplicated ?? 0;
        const pivotSet = new Set(at.pivotFqNames); const supportSet = new Set(at.supportFqNames);
        const roleDiscarded = new Set<string>();
        const built = responses.find((r) => r.width === widthLabel(width) && r.task === task && r.budget === b);
        void built;
        const relatedSet = new Set(at.relatedIds);
        for (const c of atPool) {
          if (baseIds.has(c.symbolId)) continue;
          const fate = candidateFate({ fqName: c.fqName, pivotFqNames: pivotSet, supportFqNames: supportSet, discardedRoleFqNames: roleDiscarded, relatedIds: relatedSet, focusAt: at.focusAt });
          exposed.push({ ...c, task, budget: b, width, fate: fate.fate, delivered: fate.delivered,
            representation: fate.delivered ? (representationByAt.get(c.fqName) ?? "unlabelled") : null, provenance: provenanceOf(c.sources, c.evidence) });
        }
      }
      tail.push(tailQuality({ width, budget: b, exposed, baselineScores, duplicates }));
      identities.push(roleIdentity({ width, budget: b, pairs }));
      // The per-candidate ledger keeps the two frozen budgets where the pool
      // binds (8000, 16000) and drops the evidence text (the provenance label
      // summarises it); the aggregate above is complete for every budget.
      if (b === 8000 || b === 16000) {
        for (const e of exposed) exposedRows.push({ ...e, evidence: [], width: widthLabel(width) as any });
      }
    }
  }

  // The frozen A13 rule at each width, observed and not optimised.
  const a13ByWidth: Record<string, any> = {};
  for (const width of WIDTHS) {
    const wl = widthLabel(width);
    const curves = budgetTasks.map((task) => {
      const points = A11_BUDGETS.map((b) => responses.find((r) => r.width === wl && r.task === task && r.budget === b)).filter(Boolean);
      let sizeViolations = 0; let focusSwaps = 0;
      for (let i = 1; i < points.length; i += 1) {
        if (points[i]!.focusCodeTokensFrozen < points[i - 1]!.focusCodeTokensFrozen) sizeViolations += 1;
        if (points[i]!.focusAt !== points[i - 1]!.focusAt) focusSwaps += 1;
      }
      const relations = A11_BUDGETS.slice(1).map((b, k) => {
        const lo = points[k]; const hi = points[k + 1];
        return { from: A11_BUDGETS[k], to: b, relation: lo && hi ? orderRelation(lo.relatedIds, hi.relatedIds) : "unmeasured" };
      });
      let representationRegressions = 0;
      for (let i = 1; i < points.length; i += 1) {
        const lo = points[i - 1]!; const hi = points[i]!;
        const loRep = new Map<string, string>(lo.relatedIds.map((id: string, k: number) => [id, lo.relatedRepresentations[k]]));
        for (const [k, id] of hi.relatedIds.entries()) {
          const before = loRep.get(id); const after = hi.relatedRepresentations[k];
          if (before !== undefined && before !== "relationship_only" && after === "relationship_only") representationRegressions += 1;
        }
      }
      return { task, sizeViolations, focusSwaps, representationRegressions, orderRelations: relations };
    });
    const relationHist: Record<string, number> = {};
    for (const c of curves) for (const r of c.orderRelations) relationHist[r.relation] = (relationHist[r.relation] ?? 0) + 1;
    a13ByWidth[wl] = { tasksWithSizeViolation: curves.filter((c) => c.sizeViolations > 0).length, tasksWithFocusSwap: curves.filter((c) => c.focusSwaps > 0).length,
      representationRegressions: curves.reduce((n, c) => n + c.representationRegressions, 0), orderRelations: relationHist, curves };
  }

  // Tail: the worst-utilised frozen responses at the widest width, each with what stopped it.
  const widest = widthLabel(WIDTHS.at(-1)!);
  const worst = [...packets.filter((r) => r.width === widest && r.frozenBudget)].sort((x, y) => x.utilisation.utilisationPercent - y.utilisation.utilisationPercent).slice(0, 10)
    .map((r) => ({ task: r.task, budget: r.budget, utilisationPercent: r.utilisation.utilisationPercent, frozenWholeTokens: r.utilisation.frozenWholeTokens,
      items: r.utilisation.items, candidateCount: r.candidateCount, rankedStream: r.rankedStream, pivots: r.pivots, support: r.support, roleDiscards: r.roleDiscards,
      discardClasses: r.discardClasses, stop: r.stop, bindingReason: r.utilisation.bindingReason, upstreamStatus: r.utilisation.upstreamStatus,
      selectedBeforeBudget: r.delivery?.selectedItemsBeforeBudget ?? null, droppedForBudget: r.delivery?.droppedForBudget ?? null }));

  db.close();
  const unstable = [...packetHashes.entries()].filter(([, s]) => s.size > 1).map(([k]) => k);
  const unstableLedgers = [...ledgerHashes.entries()].filter(([, s]) => s.size > 1).map(([k]) => k);
  const verdict = retrievalSupplyVerdict(supplyRows, WIDTHS.at(-1)!);
  perCorpus.push({
    id: spec.id, filesIndexed: indexed?.summary?.filesIndexed ?? null, tasks: budgetTasks.length,
    budgets: BUDGETS, frozenBudgets: A11_BUDGETS, widths: WIDTHS.map(widthLabel), responseCount: responses.length, packets: packets.length,
    seamIdentity,
    byWidth, supply: { rows: supplyRows, verdict, narrowestSufficientWidth: narrowestSufficientWidth(supplyRows) },
    tail, roleIdentity: identities, a13ByWidth, worst,
    determinism: { repeats: REPEATS, packetsStable: unstable.length === 0, unstablePackets: unstable, ledgersStable: unstableLedgers.length === 0, unstableLedgers },
    resources: { peakRssBytes, largestPacketBytes: Math.max(0, ...widthLatency.flatMap((c) => Object.values(c.largestPacketBytes as Record<string, number>))),
      largestItemCount: Math.max(0, ...packets.map((r) => r.utilisation.items)), largestRankedStream: Math.max(0, ...packets.map((r) => r.rankedStream ?? 0)),
      largestCandidateCount: Math.max(0, ...packets.map((r) => r.candidateCount ?? 0)) },
    integrity: { packets: packets.length, integrityFailures: packets.filter((r) => r.utilisation.integrity !== "UTILIZATION_INTEGRITY_PASS").length,
      failedGates: packets.flatMap((r) => r.utilisation.gates.map((g: string) => `${r.width}|${r.task}@${r.budget}:${g}`)).slice(0, 60) },
  });
  const c = perCorpus.at(-1)!;
  console.log(`[${LABEL}] ${spec.id} supply ${verdict}; narrowest sufficient ${c.supply.narrowestSufficientWidth === null ? "none" : widthLabel(c.supply.narrowestSufficientWidth)};`
    + ` seam identity ${seamIdentity.identical}/${seamIdentity.compared}; stable ${c.determinism.packetsStable}; integrity failures ${c.integrity.integrityFailures}`);
}

const cmed = perCorpus.find((c) => c.id === "C-MED");
const out = {
  milestone: "M207", instrument: "run_stage5_m207_pool_sweep.ts", label: LABEL,
  product: { root: PRODUCT_ROOT, head: productHead, fixedPool: FIXED_POOL === null ? null : Number.parseInt(FIXED_POOL[1]!, 10),
    productPoolByBudget: Object.fromEntries(BUDGETS.map((b) => [b, productPoolAt(b)])), relatedCodeCharacters: ORIENTATION_POLICY.relatedCodeCharacters },
  protocol: {
    calls: "get_code_context, default detail, max_tokens at each budget, one index per corpus copy; per width one server whose construction-time retrievalInstrumentation.candidatePoolSize is the width; one paired detail=debug call (include_item_content) and one direct read-only capsule build at the same width per request",
    tasks: "A13_TASKS (all 20 on C-MED, first 3 elsewhere)", budgets: BUDGETS, frozenBudgets: A11_BUDGETS, widths: WIDTHS.map(widthLabel),
    heldFixed: "lexical row budget (lexicalPoolSizeFor(product pool)), backfill lane windows, anchors, decoy suppression, role gate, pivot cap, support window, M206 token-budget packing, M158 dedupe, lane ceilings, assembly, evidence budget, envelope, M205 router, M203 accounting, projector ceiling",
    frozenNumerator: "ceil(JSON.stringify(output).length / 4) (engine rule, verbatim)", frozenDenominator: "the caller's max_tokens",
    frozenAggregate: "per-budget median over the C-MED tasks", frozenBand: "MATCHES >= 60% at every frozen budget; EXCEEDS >= 80% (report rule, verbatim)",
    sufficiencyRule: "required_match_tokens(B) = ceil(0.6 x B) whole-packet chars/4 tokens; a width is SUFFICIENT at a budget when the median of its REAL packets reaches it; the verdict is taken on the widest width at every frozen budget",
  },
  hardware: { cpus: navigator.hardwareConcurrency, loadAverageAtEnd: loadAverage(), peakRssBytes },
  supply: cmed?.supply ?? null, seamIdentity: cmed?.seamIdentity ?? null,
  frozenA11ByWidth: cmed === undefined ? null : Object.fromEntries(Object.entries(cmed.byWidth).map(([w, v]: [string, any]) => [w, v.frozenA11])),
  corpora: perCorpus.filter((c) => c.marker === undefined),
};
writeFileSync(path.join(RESULTS, `stage5_m207_pool_sweep_${LABEL}.json`), `${JSON.stringify(out, null, 2)}\n`);
writeFileSync(path.join(RESULTS, `stage5_m207_pool_sweep_rows_${LABEL}.jsonl`),
  `${responseRows.map((r) => JSON.stringify({ corpus: r.corpus, task: r.task, budget: r.budget, width: r.width, frozen_budget: r.frozenBudget, tier: r.tier,
    pool_width: r.poolWidth, candidate_count: r.candidateCount, ranked_stream: r.rankedStream, pivots: r.pivots, support: r.support, discarded: r.discarded, role_discards: r.roleDiscards,
    discard_classes: r.discardClasses, stop: r.stop, delivery: r.delivery, assembly: r.assembly, projector: r.projector, utilisation: r.utilisation,
    focus_at: r.focusAt, related_ids: r.relatedIds, related_representations: r.relatedRepresentations, pivot_fq_names: r.pivotFqNames,
    latency_ms: r.latencyMs, capsule_build_ms: r.capsuleBuildMs, packet_sha: r.packetSha, debug_envelope: r.debugEnvelope })).join("\n")}\n`);
if (exposedRows.length > 0) {
  writeFileSync(path.join(RESULTS, `stage5_m207_pool_tail_${LABEL}.jsonl`), `${exposedRows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}
console.log(`[${LABEL}] C-MED supply ${cmed?.supply?.verdict ?? "UNMEASURED"} -> results/stage5_m207_pool_sweep_${LABEL}.json + ${responseRows.length} rows + ${exposedRows.length} exposed candidates`);
