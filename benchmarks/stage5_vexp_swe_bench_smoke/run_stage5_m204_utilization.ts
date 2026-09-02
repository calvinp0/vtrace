/**
 * M204 — the frozen A11 sweep, reproduced on its own, with the utilisation ledger.
 *
 * Runs EXACTLY the calls the frozen engine makes for A11/A13: every A13 task on
 * C-MED (and the first three on the other corpora) at each of the five frozen
 * budgets, through the DEFAULT `get_code_context` path, and computes the frozen
 * whole-response utilisation with the engine's own rule (imported verbatim from
 * m204Utilization.ts). Nothing about the protocol is tuned here.
 *
 * Beside each default call the driver makes ONE paired `detail=debug` call of
 * the same request and ONE direct, read-only capsule build with the request's
 * own resolved preset and character budget. From those it reads the supply
 * facts the default packet cannot carry: the capsule tier and its caps, how
 * many ranked candidates the capsule discarded and why, and how many
 * neighbourhood excerpts reached the projector. The debug response drops the
 * capsule block entirely under tight budgets, which is why the direct build
 * exists; where both are present they are checked against each other. Those
 * facts classify WHY budget went unused; they change nothing about the default
 * response, which is what is measured.
 *
 * `--budgets` may add non-frozen values (§49, F8). The frozen A11/A13 figures
 * are computed over the five frozen budgets only, whatever else was swept.
 *
 * `--product-root` selects which tree's product code answers: the working tree
 * by default, or a worktree at the predecessor commit for the pre-change
 * reproduction. The projector's ceiling rule is read from that tree when it
 * exports one and taken as the fixed policy constant when it does not.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m204_utilization.ts \
 *     --label pre [--product-root <dir>] [--scratch <dir>] [--repeats 1] \
 *     [--corpora C-MED] [--budgets 1000,2000,4000,8000,16000,1575,3000,6000,12000]
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { A13_TASKS, corpusSpecs, latencyStats, prepareCorpus } from "./m197aFixtures";
import {
  A11_BUDGETS, analyzeUtilization, effectiveBudgetMonotonic, frozenA11Verdict, median, orderRelation,
  type ResponseUtilization, type UpstreamSupply,
} from "./m204Utilization";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const LABEL = argOf("--label", "post");
const PRODUCT_ROOT = path.resolve(argOf("--product-root", REPO));
const SCRATCH = argOf("--scratch", `/tmp/m204-utilization-${LABEL}`);
const REPEATS = Number.parseInt(argOf("--repeats", "1"), 10);
const CORPORA = argOf("--corpora", "C-SMALL,C-MED,C-LARGE").split(",");
const BUDGETS = argOf("--budgets", A11_BUDGETS.join(",")).split(",").map((b) => Number.parseInt(b, 10));
mkdirSync(SCRATCH, { recursive: true });

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const loadAverage = () => {
  try { return readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).map(Number); }
  catch { return []; }
};

// The product under measurement, from whichever tree was named.
const { createMcpServer } = await import(path.join(PRODUCT_ROOT, "src/mcp/server.ts"));
const { McpToolId, MCP_SERVER_SCHEMA } = await import(path.join(PRODUCT_ROOT, "src/mcp/types.ts"));
const { orientationAccountingOf } = await import(path.join(PRODUCT_ROOT, "src/runPipeline/orientationAccounting.ts"));
const projection = await import(path.join(PRODUCT_ROOT, "src/runPipeline/orientationProjection.ts"));
const { allocateBudget } = await import(path.join(PRODUCT_ROOT, "src/capsuleV2/budgetAllocator.ts"));
const { PIVOT_NEIGHBORHOOD_DEFAULTS } = await import(path.join(PRODUCT_ROOT, "src/runPipeline/pivotNeighborhood.ts"));
const { buildAuthoritativeProductRetrieval } = await import(path.join(PRODUCT_ROOT, "src/capsuleV2/authoritativeProductRetrieval.ts"));
const ORIENTATION_POLICY = projection.ORIENTATION_POLICY;
const FROZEN_PHRASES: readonly string[] = projection.ORIENTATION_FROZEN_PHRASES;
const ceilingRule: ((requested: number | string) => number) | null =
  typeof projection.orientationCeilingTokens === "function" ? projection.orientationCeilingTokens : null;
/** What the product's rule entitles a budget to. The predecessor tree has one fixed number. */
const expectedCeiling = (budget: number): number =>
  ceilingRule === null ? ORIENTATION_POLICY.ceilingTokens : ceilingRule(budget);
const productHead = (() => {
  try { return Bun.spawnSync(["git", "-C", PRODUCT_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim(); }
  catch { return "unknown"; }
})();

const call = async (server: any, toolId: string, input: unknown, id = "m204"): Promise<any> => {
  const res: any = await server.handleRequest(
    { schema: MCP_SERVER_SCHEMA, requestId: id, toolId, input } as any);
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

console.log(`[${LABEL}] product ${PRODUCT_ROOT} @ ${productHead.slice(0, 12)}; ceiling rule `
  + `${ceilingRule ? "caller-derived" : `fixed ${ORIENTATION_POLICY.ceilingTokens}`}; budgets ${BUDGETS.join(",")}; load ${loadAverage().join(" ")}`);

/**
 * Supply facts for one request: the direct capsule build (read-only, the
 * product's own entry point with the request's resolved preset and character
 * budget) for counts and discard reasons, the authoritative response for the
 * neighbourhood, and the allocator for the caps.
 */
function supplyFacts(db: any, work: string, task: string, debug: any, budget: number): UpstreamSupply {
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
  const byReason: Record<string, number> = {};
  for (const d of discarded) { const r = String(d?.discard_reason ?? "unknown"); byReason[r] = (byReason[r] ?? 0) + 1; }
  // The authoritative response agrees with the direct build wherever the
  // envelope left the compared field intact: `discardedTotal` always, the item
  // arrays only when `capsuleResult.pivots` / `.support` were not compacted.
  const cr = debug?.capsuleResult;
  const compacted: string[] = Array.isArray(debug?.responseBudget?.compacted_fields) ? debug.responseBudget.compacted_fields : [];
  const arraysIntact = !compacted.some((f) => f === "capsuleResult.pivots" || f === "capsuleResult.support" || f === "capsuleResult.manifest_only");
  const consistent = cr && built && count(cr.discardedTotal) !== null
    ? cr.discardedTotal === discarded.length
      && (!arraysIntact || !Array.isArray(cr.pivots) || !Array.isArray(cr.support)
        || (cr.pivots.length === built.pivots.length && cr.support.length === built.support.length))
    : null;
  return {
    tier: typeof built?.actual_mode === "string" ? built.actual_mode : (typeof cr?.actualMode === "string" ? cr.actualMode : null),
    maxPivots: allocation.maxPivots, maxSupport: allocation.maxSupport,
    candidateCount: count(built?.diagnostics?.candidateCount) ?? count(cr?.diagnostics?.candidateCount),
    pivotCount: built ? built.pivots.length : count(cr?.pivots?.length),
    supportCount: built ? built.support.length : count(cr?.support?.length),
    discardedCount: built ? discarded.length : count(cr?.discardedTotal),
    discardedByReason: built ? byReason : null,
    discardedForTierCap: built ? discarded.filter((d) => /^beyond \w+ support budget/.test(String(d?.discard_reason ?? ""))).length : null,
    directBuildConsistent: consistent,
    neighborhoodExcerpts: neighborhoods.reduce((n, e) => n + (Array.isArray(e?.excerpts) ? e.excerpts.length : 0), 0),
    neighborhoodPivots: neighborhoods.length,
    neighborhoodMaxPivots: PIVOT_NEIGHBORHOOD_DEFAULTS.maxPivots,
    neighborhoodMaxExcerptsPerPivot: PIVOT_NEIGHBORHOOD_DEFAULTS.maxExcerptsPerPivot,
  };
}

const perCorpus: any[] = [];
const ledgerRows: any[] = [];
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
  const memoryByBudget = new Map<number, { heapDeltaBytes: number[]; packetBytes: number[] }>();

  for (const task of budgetTasks) {
    for (const budget of BUDGETS) {
      let out: any = null; let ledger: any = null;
      for (let r = 0; r < REPEATS; r += 1) {
        const heapBefore = process.memoryUsage().heapUsed;
        const t0 = performance.now();
        out = await call(server, McpToolId.GetCodeContext, { task, repo_root: work, max_tokens: budget });
        const ms = performance.now() - t0;
        noteMemory();
        latencyByBudget.set(budget, [...(latencyByBudget.get(budget) ?? []), ms]);
        const mem = memoryByBudget.get(budget) ?? { heapDeltaBytes: [], packetBytes: [] };
        mem.heapDeltaBytes.push(process.memoryUsage().heapUsed - heapBefore);
        mem.packetBytes.push(JSON.stringify(out ?? null).length);
        memoryByBudget.set(budget, mem);
        ledger = out && typeof out === "object" ? orientationAccountingOf(out) : undefined;
        const key = `${task}@${budget}`;
        const ph = packetHashes.get(key) ?? new Set(); ph.add(sha(JSON.stringify(out ?? null))); packetHashes.set(key, ph);
        const lh = ledgerHashes.get(key) ?? new Set(); lh.add(sha(JSON.stringify(ledger ?? null))); ledgerHashes.set(key, lh);
      }
      const isPacket = out && typeof out === "object" && "focus" in out;
      // The paired authoritative call: supply facts only, never the measured output.
      const debug = await call(server, McpToolId.GetCodeContext, { task, repo_root: work, max_tokens: budget, detail: "debug" }, "dbg");
      const facts = supplyFacts(db, work, task, debug, budget);
      const analysis: ResponseUtilization | null = isPacket ? analyzeUtilization({
        budget, packet: out, ledger, expectedCeilingTokens: expectedCeiling(budget),
        headBoundCharacters: ORIENTATION_POLICY.focusCodeCharacters, frozenPhrases: FROZEN_PHRASES, upstream: facts,
      }) : null;
      const relatedIds: string[] = isPacket ? (out.related ?? []).map((r: any) => String(r.at)) : [];
      const row = {
        corpus: spec.id, task, budget, frozenBudget: (A11_BUDGETS as readonly number[]).includes(budget),
        shape: isPacket ? "orientation" : String(out?.schemaVersion ?? out?.__error?.code ?? "other"),
        packetSha: sha(JSON.stringify(out ?? null)),
        focusAt: isPacket ? out.focus.at : null, focusForm: isPacket ? out.focus.form : null,
        focusCodeTokensFrozen: isPacket ? Math.ceil((out.focus.code ?? "").length / 4) : 0,
        relatedIds,
        latencyMs: +(latencyByBudget.get(budget)!.at(-1)!).toFixed(1),
        authoritative: {
          requestedContextTokens: debug?.responseBudget?.requested_context_tokens ?? null,
          modelVisibleTokens: debug?.responseBudget?.estimated_model_visible_tokens ?? null,
          totalResponseTokenCeiling: debug?.responseBudget?.total_response_token_ceiling ?? null,
          withinEnvelope: debug?.responseBudget?.within_envelope ?? null,
          renderedCharacters: debug?.productContext?.accounting?.renderedCharacters ?? null,
        },
        analysis,
      };
      responses.push(row);
      if (analysis !== null) {
        ledgerRows.push({
          corpus: spec.id, task, budget, frozen_budget: row.frozenBudget,
          effective_ceiling_tokens: analysis.effectiveCeilingTokens, ceiling_source: analysis.ceilingSource,
          expected_ceiling_tokens: analysis.expectedCeilingTokens,
          eligible: analysis.supply.eligible, admitted: analysis.supply.admitted,
          rejected: analysis.supply.rejectedForCeiling, not_reached: analysis.supply.notReached,
          deduplicated: analysis.supply.deduplicated, dropped_no_claim: analysis.supply.droppedNoClaim,
          admitted_item_tokens: analysis.supply.admittedItemTokens,
          remaining_useful_candidate_tokens_estimate: analysis.supply.remainingUsefulCandidateTokensEstimate,
          evidence_tokens: analysis.consumed.evidenceTokens, packet_tokens: analysis.consumed.packetTokens,
          wrapper_tokens: analysis.consumed.wrapperTokens, accounting_overhead_tokens: analysis.consumed.accountingOverheadTokens,
          frozen_whole_tokens: analysis.consumed.frozenWholeTokens, items: analysis.consumed.items,
          unused_frozen_budget_tokens: analysis.unused.frozenBudgetTokens, unused_ceiling_tokens: analysis.unused.ceilingTokens,
          utilisation_percent: analysis.utilisationPercent,
          upstream_requested: analysis.upstream.requestedTokens, upstream_visible: analysis.upstream.modelVisibleTokens,
          upstream_remaining: analysis.upstream.remainingTokens, upstream_status: analysis.upstream.deliveryStatus,
          upstream_selected: analysis.upstream.selectedItemsBeforeBudget, upstream_delivered: analysis.upstream.deliveredItems,
          upstream_tier: facts.tier, upstream_pivots: facts.pivotCount, upstream_max_pivots: facts.maxPivots,
          upstream_support: facts.supportCount, upstream_max_support: facts.maxSupport, upstream_discarded: facts.discardedCount,
          upstream_discarded_for_tier_cap: facts.discardedForTierCap, upstream_discarded_by_reason: facts.discardedByReason,
          upstream_direct_build_consistent: facts.directBuildConsistent,
          authoritative_discarded_total: debug?.capsuleResult?.discardedTotal ?? null,
          neighborhood_excerpts: facts.neighborhoodExcerpts,
          representation_withheld_characters: analysis.representationWithheldCharacters,
          head_bound_withheld_characters: analysis.headBoundWithheldCharacters,
          binding_reason: analysis.bindingReason, binding_detail: analysis.bindingDetail,
          token_binding: analysis.tokenBinding, supply_exhausted: analysis.supplyExhausted,
          integrity: analysis.verdict, failed_gates: analysis.gates.filter((g) => !g.pass).map((g) => g.id),
          packet_sha: row.packetSha, focus_at: row.focusAt,
        });
      }
    }
  }

  // ---------------------------------------------------------- aggregates
  const packets = responses.filter((r) => r.analysis !== null);
  const frozenPackets = packets.filter((r) => r.frozenBudget);
  const byBudget = Object.fromEntries(BUDGETS.map((b) => {
    const rows = packets.filter((r) => r.budget === b);
    const a = rows.map((r) => r.analysis as ResponseUtilization);
    const hist: Record<string, number> = {};
    for (const x of a) hist[x.bindingReason] = (hist[x.bindingReason] ?? 0) + 1;
    const tokenHist: Record<string, number> = {};
    for (const x of a) for (const t of x.tokenBinding) tokenHist[t] = (tokenHist[t] ?? 0) + 1;
    const med = (f: (x: ResponseUtilization) => number | null) => {
      const v = a.map(f).filter((n): n is number => typeof n === "number");
      return v.length === 0 ? null : +median(v).toFixed(2);
    };
    return [b, {
      responses: rows.length,
      frozenUtilisationMedian: med((x) => x.utilisationPercent),
      effectiveCeilingTokens: [...new Set(a.map((x) => x.effectiveCeilingTokens))],
      expectedCeilingTokens: expectedCeiling(b),
      medians: {
        frozenWholeTokens: med((x) => x.consumed.frozenWholeTokens), packetTokens: med((x) => x.consumed.packetTokens),
        evidenceTokens: med((x) => x.consumed.evidenceTokens), unusedFrozenBudget: med((x) => x.unused.frozenBudgetTokens),
        unusedCeiling: med((x) => x.unused.ceilingTokens), items: med((x) => x.consumed.items),
        eligible: med((x) => x.supply.eligible), admitted: med((x) => x.supply.admitted),
        upstreamVisible: med((x) => (typeof x.upstream.modelVisibleTokens === "number" ? x.upstream.modelVisibleTokens : null)),
        upstreamRemaining: med((x) => (typeof x.upstream.remainingTokens === "number" ? x.upstream.remainingTokens : null)),
        upstreamDiscarded: med((x) => x.upstream.supplyFacts?.discardedCount ?? null),
        upstreamDiscardedForTierCap: med((x) => x.upstream.supplyFacts?.discardedForTierCap ?? null),
        representationWithheldCharacters: med((x) => x.representationWithheldCharacters),
      },
      totals: {
        rejectedForCeiling: a.reduce((n, x) => n + (x.supply.rejectedForCeiling ?? 0), 0),
        notReached: a.reduce((n, x) => n + (x.supply.notReached ?? 0), 0),
        supplyExhausted: a.filter((x) => x.supplyExhausted).length,
        headBoundTruncated: a.filter((x) => x.headBoundWithheldCharacters > 0).length,
        integrityFailures: a.filter((x) => x.verdict !== "UTILIZATION_INTEGRITY_PASS").length,
        directBuildChecked: a.filter((x) => x.upstream.supplyFacts?.directBuildConsistent !== null).length,
        directBuildInconsistent: a.filter((x) => x.upstream.supplyFacts?.directBuildConsistent === false).length,
      },
      bindingReasons: hist, tokenBinding: tokenHist,
      latency: latencyStats(latencyByBudget.get(b) ?? []),
      memory: (() => {
        const m = memoryByBudget.get(b);
        return m === undefined ? null : { heapDeltaBytesMedian: median(m.heapDeltaBytes), packetBytesMax: Math.max(...m.packetBytes) };
      })(),
    }];
  }));

  // The frozen A11 figure: medians over the FROZEN budgets, banded by the frozen rule.
  const frozenMedians = A11_BUDGETS.map((b) => byBudget[b]?.frozenUtilisationMedian ?? null);
  const frozenA11 = { utilisationByBudget: Object.fromEntries(A11_BUDGETS.map((b, k) => [b, { median: frozenMedians[k] }])),
    verdict: frozenA11Verdict(frozenMedians) };

  // The frozen A13 rule, observed and not optimised: over the frozen budgets in order.
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
    const allPoints = BUDGETS.map((b) => responses.find((r) => r.task === task && r.budget === b)).filter(Boolean);
    const monotonic = effectiveBudgetMonotonic(allPoints.map((p) => ({ budget: p!.budget, effective: p!.analysis?.effectiveCeilingTokens ?? null })));
    return { task, sizeViolations, focusSwaps, focusByBudget: Object.fromEntries(points.map((p) => [p!.budget, p!.focusAt])),
      orderRelations: relations, effectiveBudgetMonotonic: monotonic };
  });
  const relationHist: Record<string, number> = {};
  for (const c of curves) for (const r of c.orderRelations) relationHist[r.relation] = (relationHist[r.relation] ?? 0) + 1;

  // Tail: the worst-utilised frozen responses.
  const tail = [...frozenPackets].sort((x, y) => x.analysis.utilisationPercent - y.analysis.utilisationPercent).slice(0, 10)
    .map((r) => ({ task: r.task, budget: r.budget, utilisationPercent: r.analysis.utilisationPercent,
      frozenWholeTokens: r.analysis.consumed.frozenWholeTokens, items: r.analysis.consumed.items,
      eligible: r.analysis.supply.eligible, admitted: r.analysis.supply.admitted,
      effectiveCeilingTokens: r.analysis.effectiveCeilingTokens, evidenceTokens: r.analysis.consumed.evidenceTokens,
      bindingReason: r.analysis.bindingReason, bindingDetail: r.analysis.bindingDetail, tokenBinding: r.analysis.tokenBinding,
      upstreamVisible: r.analysis.upstream.modelVisibleTokens, upstreamRemaining: r.analysis.upstream.remainingTokens,
      upstreamDiscarded: r.analysis.upstream.supplyFacts?.discardedCount ?? null,
      representationWithheldCharacters: r.analysis.representationWithheldCharacters }));

  db.close();
  const unstable = [...packetHashes.entries()].filter(([, s]) => s.size > 1).map(([k]) => k);
  const unstableLedgers = [...ledgerHashes.entries()].filter(([, s]) => s.size > 1).map(([k]) => k);
  const bindingAll: Record<string, number> = {};
  for (const r of frozenPackets) bindingAll[r.analysis.bindingReason] = (bindingAll[r.analysis.bindingReason] ?? 0) + 1;

  perCorpus.push({
    id: spec.id, filesIndexed: indexed?.summary?.filesIndexed ?? null, tasks: budgetTasks.length,
    budgets: BUDGETS, frozenBudgets: A11_BUDGETS, responseCount: responses.length, packets: packets.length,
    frozenA11,
    frozenA13: { tasksWithSizeViolation: curves.filter((c) => c.sizeViolations > 0).length,
      tasksWithFocusSwap: curves.filter((c) => c.focusSwaps > 0).length, curves },
    byBudget,
    bindingReasonsOverFrozen: bindingAll,
    orderRelations: relationHist,
    effectiveBudgetMonotonic: { tasksViolating: curves.filter((c) => !c.effectiveBudgetMonotonic.monotonic).map((c) => c.task) },
    integrity: { packets: packets.length, failures: packets.filter((r) => r.analysis.verdict !== "UTILIZATION_INTEGRITY_PASS").length,
      failedGates: packets.flatMap((r) => r.analysis.gates.filter((g: any) => !g.pass).map((g: any) => `${r.task}@${r.budget}:${g.id}`)) },
    tail,
    determinism: { repeats: REPEATS, packetsStable: unstable.length === 0, unstablePackets: unstable,
      ledgersStable: unstableLedgers.length === 0, unstableLedgers },
    resources: { peakRssBytes, largestPacketBytes: Math.max(0, ...packets.map((r) => JSON.stringify(r).length === 0 ? 0 : r.analysis.consumed.packetCharacters)),
      largestItemCount: Math.max(0, ...packets.map((r) => r.analysis.consumed.items)) },
    responses,
  });
  const c = perCorpus.at(-1)!;
  console.log(`[${LABEL}] ${spec.id.padEnd(8)} A11 ${A11_BUDGETS.map((b) => `${b}=${byBudget[b]?.frozenUtilisationMedian}%`).join(" ")} `
    + `${frozenA11.verdict} | binding ${JSON.stringify(bindingAll)} | A13 size ${c.frozenA13.tasksWithSizeViolation} swap ${c.frozenA13.tasksWithFocusSwap} `
    + `| integrity failures ${c.integrity.failures} | stable ${c.determinism.packetsStable}`);
}

const cmed = perCorpus.find((c) => c.id === "C-MED");
const out = {
  milestone: "M204", instrument: "run_stage5_m204_utilization.ts", label: LABEL,
  product: { root: PRODUCT_ROOT, head: productHead,
    ceilingRule: ceilingRule ? "orientationCeilingTokens(requested_context_tokens)" : `fixed ORIENTATION_POLICY.ceilingTokens = ${ORIENTATION_POLICY.ceilingTokens}`,
    focusCodeCharacters: ORIENTATION_POLICY.focusCodeCharacters },
  protocol: {
    calls: "get_code_context, default detail, max_tokens at each budget, one index per corpus copy; one paired detail=debug call per request for supply facts",
    tasks: "A13_TASKS (all 20 on C-MED, first 3 elsewhere)", budgets: BUDGETS, frozenBudgets: A11_BUDGETS,
    frozenNumerator: "ceil(JSON.stringify(output).length / 4) (engine rule, verbatim)",
    frozenDenominator: "the caller's max_tokens", frozenAggregate: "per-budget median over the C-MED tasks",
    frozenBand: "MATCHES >= 60% at every frozen budget; EXCEEDS >= 80% (report rule, verbatim)",
  },
  hardware: { cpus: navigator.hardwareConcurrency, loadAverageAtEnd: loadAverage(), peakRssBytes },
  frozenA11: cmed?.frozenA11 ?? null,
  frozenA13: cmed === undefined ? null : { tasksWithSizeViolation: cmed.frozenA13.tasksWithSizeViolation, tasksWithFocusSwap: cmed.frozenA13.tasksWithFocusSwap },
  corpora: perCorpus,
};
writeFileSync(path.join(RESULTS, `stage5_m204_utilization_${LABEL}.json`), `${JSON.stringify(out, null, 2)}\n`);
if (ledgerRows.length > 0) {
  writeFileSync(path.join(RESULTS, `stage5_m204_utilization_ledger_${LABEL}.jsonl`),
    `${ledgerRows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}
console.log(`[${LABEL}] frozen A11 C-MED ${JSON.stringify(cmed?.frozenA11?.utilisationByBudget ?? null)} ${cmed?.frozenA11?.verdict ?? "UNMEASURED"}`
  + ` -> results/stage5_m204_utilization_${LABEL}.json` + (ledgerRows.length ? ` + ${ledgerRows.length} ledger rows` : ""));
