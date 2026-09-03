/**
 * M208 — the adjacent-budget transition audit through the REAL default
 * `get_code_context` path, with a stage-by-stage snapshot bound beside every
 * response.
 *
 * For every A13 task on C-MED (the first three elsewhere) at every budget of
 * the grid, the driver makes the frozen engine's call (default detail,
 * `max_tokens` = budget) `--repeats` times, reads the M203 ledger the packet
 * carries (delivered items, representation routing, ceiling, evidence-budget
 * facts from the DEFAULT response — the debug envelope's delivery differs at
 * tight budgets and is not read for that), and makes ONE direct read-only
 * capsule build with the same inputs (ranked pool with scores, roles, pivot
 * order with the v2 rank, packed support order, every discard with its verbatim
 * reason). Snapshots at adjacent budgets become transition rows; every
 * lower-budget delivered item is tracked into the higher budget; the first
 * causal divergence is named per transition (m208BudgetMonotonicity.ts).
 *
 * Counterfactuals:
 *   --pool-mode product        the product's own allowance per budget (C1)
 *   --pool-mode fixed:<n>      the retrieval pool pinned to <n> at every budget
 *                              through the M207 construction-time instrument
 *                              (C2: fixed candidate universe; 25 reproduces the
 *                              pre-M207 pool, 134 the 16000 allowance)
 *   in-process                 C5: the higher budget's authoritative debug
 *                              result projected at the lower budget's ceiling
 *                              (same supply, two ceilings) where the debug
 *                              delivery matches the default packet's supply.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m208_transition_audit.ts \
 *     --label pre [--product-root <dir>] [--scratch <dir>] [--repeats 3] \
 *     [--corpora C-MED] [--pool-mode product|fixed:25|fixed:134] \
 *     [--budgets 750,1000,1250,1499,1500,2000,2500,3000,4000,5000,6000,8000,10000,11999,12000,16000,20000]
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { A13_TASKS, corpusSpecs, latencyStats, median, prepareCorpus } from "./m197aFixtures";
import {
  FROZEN_A13_BUDGETS, adjacentPairs, buildSnapshot, frozenA13, laneOf, summarize, transitionRow,
  type StageSnapshot, type TransitionRow,
} from "./m208BudgetMonotonicity";
import { orderRelation } from "./m204Utilization";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const LABEL = argOf("--label", "pre");
const PRODUCT_ROOT = path.resolve(argOf("--product-root", REPO));
const SCRATCH = argOf("--scratch", `/tmp/m208-${LABEL}`);
const REPEATS = Number.parseInt(argOf("--repeats", "3"), 10);
const CORPORA = argOf("--corpora", "C-MED").split(",");
export const DEFAULT_GRID = [750, 1000, 1250, 1499, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 8000, 10000, 11999, 12000, 16000, 20000];
const BUDGETS = argOf("--budgets", DEFAULT_GRID.join(",")).split(",").map((b) => Number.parseInt(b, 10)).sort((a, b) => a - b);
const POOL_MODE = argOf("--pool-mode", "product");
const PINNED_WIDTH = POOL_MODE.startsWith("fixed:") ? Number.parseInt(POOL_MODE.slice("fixed:".length), 10) : null;
if (POOL_MODE !== "product" && (PINNED_WIDTH === null || !Number.isInteger(PINNED_WIDTH) || PINNED_WIDTH < 1)) {
  throw new Error(`M208_BAD_POOL_MODE: ${POOL_MODE}`);
}
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
const { projectRunPipelineOrientation } = await import(path.join(PRODUCT_ROOT, "src/runPipeline/orientationProjection.ts"));
const { allocateBudget } = await import(path.join(PRODUCT_ROOT, "src/capsuleV2/budgetAllocator.ts"));
const { buildAuthoritativeProductRetrieval } = await import(path.join(PRODUCT_ROOT, "src/capsuleV2/authoritativeProductRetrieval.ts"));
const productHead = Bun.spawnSync(["git", "-C", PRODUCT_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();
const capsuleSource = readFileSync(path.join(PRODUCT_ROOT, "src/capsuleV2/buildCapsuleV2.ts"), "utf8");
if (!/candidatePoolSize/.test(capsuleSource) && PINNED_WIDTH !== null) throw new Error("M208_PRODUCT_HAS_NO_POOL_SEAM");

const call = async (server: any, toolId: string, input: unknown, id = "m208"): Promise<any> => {
  const res: any = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: id, toolId, input } as any);
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

console.log(`[${LABEL}] product ${PRODUCT_ROOT} @ ${productHead.slice(0, 12)}; pool-mode ${POOL_MODE}; budgets ${BUDGETS.join(",")}; repeats ${REPEATS}; load ${loadAverage().join(" ")}`);

interface Observation {
  readonly snapshot: StageSnapshot;
  readonly latencyMs: number[];
  readonly capsuleBuildMs: number;
  readonly packetHashes: string[];
  readonly ledgerHashes: string[];
  readonly intent: any;
  readonly debugDelivery: any;
  readonly debugSupplyMatchesDefault: boolean | null;
  readonly debugOutput: any;
}

const perCorpus: any[] = [];
const transitionRows: (TransitionRow & { corpus: string; grid: "frozen" | "dense"; poolMode: string })[] = [];
const itemRows: any[] = [];
const snapshotRows: any[] = [];

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
  const server = PINNED_WIDTH === null
    ? plainServer
    : createMcpServer({ context: { repoRoot: work, dbPath, retrievalInstrumentation: { candidatePoolSize: PINNED_WIDTH } } } as any);
  const db = new Database(dbPath, { readonly: true });
  const tasks = spec.id === "C-MED" ? A13_TASKS : A13_TASKS.slice(0, 3);
  const observations = new Map<string, Observation>();
  const key = (task: string, budget: number) => `${task}@${budget}`;
  const seamIdentity = { compared: 0, identical: 0, differing: [] as string[] };

  for (const task of tasks) {
    // Intent and preset are a property of the task; read once from the debug envelope at the top budget.
    const probe = await call(server, McpToolId.GetCodeContext, { task, repo_root: work, max_tokens: BUDGETS.at(-1)!, detail: "debug" }, "probe");
    // The handler passes the selected preset alone (no capsule intent) to
    // buildAuthoritativeProductRetrieval; the direct build does exactly that.
    const preset = probe?.intent?.selectedPreset;
    for (const budget of BUDGETS) {
      const latency: number[] = []; const packetHashes: string[] = []; const ledgerHashes: string[] = [];
      let out: any = null; let ledger: any;
      // Seam identity when pinned to the product's own allowance: the uninstrumented handler first, same process state.
      const productSha = PINNED_WIDTH !== null && allocateBudget(budget).candidatePool === PINNED_WIDTH
        ? sha(JSON.stringify((await call(plainServer, McpToolId.GetCodeContext, { task, repo_root: work, max_tokens: budget })) ?? null))
        : null;
      for (let r = 0; r < REPEATS; r += 1) {
        const t0 = performance.now();
        out = await call(server, McpToolId.GetCodeContext, { task, repo_root: work, max_tokens: budget });
        latency.push(performance.now() - t0);
        ledger = out && typeof out === "object" ? orientationAccountingOf(out) : undefined;
        packetHashes.push(sha(JSON.stringify(out ?? null)));
        ledgerHashes.push(sha(JSON.stringify(ledger ?? null)));
      }
      const packetSha = packetHashes.at(-1)!;
      if (productSha !== null) {
        seamIdentity.compared += 1;
        if (productSha === packetSha) seamIdentity.identical += 1; else seamIdentity.differing.push(key(task, budget));
      }
      // The direct capsule build with the handler's own inputs.
      let built: any = null; const b0 = performance.now();
      if (typeof preset === "string") {
        try {
          built = buildAuthoritativeProductRetrieval(db, work, {
            query: task, preset, maxBudgetCharacters: budget * 4,
            ...(PINNED_WIDTH === null ? {} : { candidatePoolSize: PINNED_WIDTH }),
          }).result;
        } catch { built = null; }
      }
      const capsuleBuildMs = performance.now() - b0;
      // The debug envelope, for C5 only (and to record that its delivery differs where it does).
      const debug = (FROZEN_A13_BUDGETS as readonly number[]).includes(budget)
        ? await call(server, McpToolId.GetCodeContext, { task, repo_root: work, max_tokens: budget, detail: "debug", include_item_content: true }, "dbg")
        : null;
      const allocation = allocateBudget(budget);
      const isPacket = out && typeof out === "object" && "focus" in out;
      const snapshot = buildSnapshot({
        task, budget, allocation, poolWidthUsed: PINNED_WIDTH ?? allocation.candidatePool,
        built, packet: isPacket ? out : null, ledger, packetSha,
      });
      const debugItems: string[] = Array.isArray(debug?.productContext?.items) ? debug.productContext.items.map((i: any) => String(i.fqName)) : [];
      const defaultItems = snapshot.items.map((i) => i.fqName);
      const debugSupplyMatchesDefault = debug === null ? null
        : debugItems.length === defaultItems.length && debugItems.every((id, k) => id === defaultItems[k]);
      observations.set(key(task, budget), {
        snapshot, latencyMs: latency, capsuleBuildMs, packetHashes, ledgerHashes,
        intent: { preset }, debugDelivery: debug?.productContext?.delivery ?? null,
        debugSupplyMatchesDefault, debugOutput: debug,
      });
      snapshotRows.push({
        corpus: spec.id, task, budget, pool_mode: POOL_MODE, tier: snapshot.tier, max_pivots: snapshot.maxPivots, support_window: snapshot.supportWindow,
        allowance: snapshot.candidatePool, pool_width_used: snapshot.poolWidthUsed, pool: snapshot.pool.length,
        pivots: snapshot.pivots.map((p) => ({ fq: p.fqName, v2: p.pivotRankScore, final: p.finalScore, mode: p.contentMode, tokens: p.estimatedTokens })),
        support_count: snapshot.support.length, discarded: snapshot.discarded.length,
        coedit_fired: snapshot.coeditFired,
        support: snapshot.support.map((s) => ({ fq: s.fqName, lane: laneOf(s, snapshot), final: s.finalScore, mode: s.contentMode, tokens: s.estimatedTokens })),
        discards: snapshot.discarded.map((d) => ({ fq: d.fqName, reason: d.reason })),
        delivered_items: snapshot.items.map((i) => ({ id: i.sourceId, fq: i.fqName, rep: i.representation, reason: i.representationReason, tokens: i.actualTokens })),
        focus_at: snapshot.focusAt, focus_form: snapshot.focusForm, focus_code_tokens: snapshot.focusCodeTokens,
        delivered: snapshot.items.length, related: snapshot.relatedIds.length, whole_tokens: snapshot.wholeTokensFrozen,
        utilisation: +(100 * snapshot.wholeTokensFrozen / budget).toFixed(2),
        delivery: snapshot.delivery, ceiling_tokens: snapshot.ceilingTokens, evidence_tokens: snapshot.evidenceTokens,
        packet_chars: snapshot.packetCharacters, evidence_chars: snapshot.evidenceCharacters,
        evidence_within_budget_chars: snapshot.evidenceCharacters === null ? null : snapshot.evidenceCharacters <= budget * 4,
        accounting_overhead_tokens: snapshot.packetCharacters === null || snapshot.evidenceCharacters === null ? null : Math.ceil(snapshot.packetCharacters / 4) - Math.ceil(snapshot.evidenceCharacters / 4),
        rejected_for_ceiling: snapshot.rejectedForCeiling, not_reached: snapshot.notReached,
        assembly_aligned: snapshot.assemblyAligned, direct_build_consistent: snapshot.directBuildConsistent,
        debug_supply_matches_default: debugSupplyMatchesDefault, debug_delivery_status: debug?.productContext?.delivery?.status ?? null,
        related_ids: snapshot.relatedIds, related_representations: snapshot.relatedRepresentations,
        packet_sha: packetSha, packet_stable: new Set(packetHashes).size === 1, ledger_stable: new Set(ledgerHashes).size === 1,
        latency_ms: latency.map((v) => +v.toFixed(1)), capsule_build_ms: +capsuleBuildMs.toFixed(1),
      });
    }
    console.log(`[${LABEL}] ${spec.id} ${task.slice(0, 48).padEnd(48)} focus@frozen ${FROZEN_A13_BUDGETS.map((b) => observations.get(key(task, b))?.snapshot.focusAt?.split("::").pop() ?? "-").join(" | ")}`);
  }

  // ------------------------------------------------------------ transitions
  const frozenPairs = adjacentPairs(FROZEN_A13_BUDGETS.filter((b) => BUDGETS.includes(b)));
  const densePairs = adjacentPairs(BUDGETS);
  for (const task of tasks) {
    for (const [grid, pairs] of [["frozen", frozenPairs], ["dense", densePairs]] as const) {
      for (const [from, to] of pairs) {
        const lo = observations.get(key(task, from)); const hi = observations.get(key(task, to));
        if (lo === undefined || hi === undefined) continue;
        const row = transitionRow(lo.snapshot, hi.snapshot);
        transitionRows.push({ ...row, corpus: spec.id, grid, poolMode: POOL_MODE });
        if (grid === "frozen") {
          for (const item of [...row.lostItems, ...row.movedItems]) itemRows.push({ corpus: spec.id, poolMode: POOL_MODE, ...item });
        }
      }
    }
  }

  // ------------------------------------------------------- C5 projector-only
  // The higher budget's authoritative (debug) result, projected at the lower
  // budget's ceiling: same supply, two ceilings. Read only where the debug
  // envelope delivered the same supply the default packet did, so the
  // counterfactual is about the projector and nothing upstream of it.
  const projectorOnly: any[] = [];
  for (const task of tasks) {
    for (const [from, to] of frozenPairs) {
      const hi = observations.get(key(task, to));
      if (hi === undefined || hi.debugOutput === null || hi.debugSupplyMatchesDefault !== true) {
        projectorOnly.push({ task, from, to, measured: false, reason: hi?.debugSupplyMatchesDefault === false ? "debug_delivery_differs_from_default" : "no_debug_supply" });
        continue;
      }
      const atHi = projectRunPipelineOrientation(hi.debugOutput);
      const lowered = { ...hi.debugOutput, responseBudget: { ...(hi.debugOutput.responseBudget ?? {}), requested_context_tokens: from } };
      const atLo = projectRunPipelineOrientation(lowered);
      const hiIds = atHi ? atHi.related.map((r: any) => String(r.at)) : [];
      const loIds = atLo ? atLo.related.map((r: any) => String(r.at)) : [];
      const hiRep = atHi ? atHi.related.map((r: any) => (typeof r.code === "string" ? String(r.form) : "relationship_only")) : [];
      const loRep = atLo ? atLo.related.map((r: any) => (typeof r.code === "string" ? String(r.form) : "relationship_only")) : [];
      const loMap = new Map(loIds.map((id: string, k: number) => [id, loRep[k]]));
      let regressions = 0;
      hiIds.forEach((id: string, k: number) => { const b = loMap.get(id); if (b !== undefined && b !== "relationship_only" && hiRep[k] === "relationship_only") regressions += 1; });
      projectorOnly.push({
        task, from, to, measured: true,
        sameFocus: atHi?.focus.at === atLo?.focus.at, relation: orderRelation(loIds, hiIds),
        lowerRelated: loIds.length, higherRelated: hiIds.length, representationRegressions: regressions,
      });
    }
  }

  // ------------------------------------------------------------- aggregates
  const frozenRows = transitionRows.filter((r) => r.corpus === spec.id && r.grid === "frozen");
  const denseRows = transitionRows.filter((r) => r.corpus === spec.id && r.grid === "dense");
  const snapshots = [...observations.values()].map((o) => o.snapshot);
  const frozen = frozenA13(snapshots);
  const unstablePackets = [...observations.entries()].filter(([, o]) => new Set(o.packetHashes).size > 1).map(([k]) => k);
  const unstableLedgers = [...observations.entries()].filter(([, o]) => new Set(o.ledgerHashes).size > 1).map(([k]) => k);
  const byBudget = Object.fromEntries(BUDGETS.map((b) => {
    const rows = snapshotRows.filter((r) => r.corpus === spec.id && r.budget === b);
    return [b, {
      tier: [...new Set(rows.map((r) => r.tier))], allowance: allocateBudget(b).candidatePool, poolWidthUsed: PINNED_WIDTH ?? allocateBudget(b).candidatePool,
      medianPool: median(rows.map((r) => r.pool)), medianDelivered: median(rows.map((r) => r.delivered)),
      medianWholeTokens: median(rows.map((r) => r.whole_tokens)), medianUtilisation: +median(rows.map((r) => r.utilisation)).toFixed(2),
      overBudget: rows.filter((r) => r.whole_tokens > b).length,
      evidenceOverBudget: rows.filter((r) => r.evidence_within_budget_chars === false).length,
      medianAccountingOverheadTokens: median(rows.map((r) => r.accounting_overhead_tokens).filter((v: unknown): v is number => typeof v === "number")),
      deliveryStatus: Object.fromEntries([...new Set(rows.map((r) => r.delivery.status))].map((s) => [s, rows.filter((r) => r.delivery.status === s).length])),
      latency: latencyStats(rows.flatMap((r) => r.latency_ms)), capsuleBuildMs: latencyStats(rows.map((r) => r.capsule_build_ms)),
      debugDeliveryMatchesDefault: rows.filter((r) => r.debug_supply_matches_default === true).length,
      debugDeliveryDiffers: rows.filter((r) => r.debug_supply_matches_default === false).length,
    }];
  }));
  db.close();
  perCorpus.push({
    id: spec.id, filesIndexed: indexed?.summary?.filesIndexed ?? null, tasks: tasks.length, budgets: BUDGETS, poolMode: POOL_MODE,
    seamIdentity,
    frozenA13: { tasksWithSizeViolation: frozen.tasksWithSizeViolation, tasksWithFocusSwap: frozen.tasksWithFocusSwap, violations: frozen.violations, verdict: frozen.verdict,
      swappedTasks: frozen.curves.filter((c) => c.focusSwaps > 0).map((c) => c.task), sizeViolationTasks: frozen.curves.filter((c) => c.sizeViolations > 0).map((c) => c.task), curves: frozen.curves },
    frozenSummary: summarize(frozenRows), denseSummary: summarize(denseRows),
    frozenA11: Object.fromEntries(FROZEN_A13_BUDGETS.filter((b) => BUDGETS.includes(b)).map((b) => [b, byBudget[b]!.medianUtilisation])),
    byBudget, projectorOnly,
    determinism: { repeats: REPEATS, packetsStable: unstablePackets.length === 0, unstablePackets, ledgersStable: unstableLedgers.length === 0, unstableLedgers },
    consistency: {
      directBuildInconsistent: snapshotRows.filter((r) => r.corpus === spec.id && r.direct_build_consistent === false).map((r) => `${r.task}@${r.budget}`),
      assemblyMisaligned: snapshotRows.filter((r) => r.corpus === spec.id && r.assembly_aligned === false).map((r) => `${r.task}@${r.budget}`),
    },
  });
  const c = perCorpus.at(-1)!;
  console.log(`[${LABEL}] ${spec.id} frozen A13 ${frozen.tasksWithSizeViolation}/${frozen.tasksWithFocusSwap} (${frozen.verdict}); relations ${JSON.stringify(c.frozenSummary.relations)}; regressions ${c.frozenSummary.representationRegressions}; gate ${c.frozenSummary.gate}; stable ${c.determinism.packetsStable}; seam ${seamIdentity.identical}/${seamIdentity.compared}`);
  console.log(`[${LABEL}] first divergence ${JSON.stringify(c.frozenSummary.firstDivergenceByMechanism)}`);
  console.log(`[${LABEL}] lost items ${c.frozenSummary.lostItems} ${JSON.stringify(c.frozenSummary.lostItemsByMechanism)}`);
}

const out = {
  milestone: "M208", instrument: "run_stage5_m208_transition_audit.ts", label: LABEL, poolMode: POOL_MODE,
  product: { root: PRODUCT_ROOT, head: productHead },
  protocol: {
    calls: "get_code_context, default detail, max_tokens at each budget, `--repeats` times per request in one process; one direct read-only capsule build with the handler's own preset/intent/maxBudgetCharacters (and the pinned pool when --pool-mode fixed:n); one debug call per task at the top budget for intent/preset; one debug call per frozen budget for the projector-only counterfactual",
    tasks: "A13_TASKS (all 20 on C-MED, first 3 elsewhere)", budgets: BUDGETS, frozenBudgets: FROZEN_A13_BUDGETS,
    frozenRule: "per task, ascending frozen budgets: size violation = ceil(chars/4 of focus.code) decreases; focus swap = focus.at changes; verdict counts tasks with any violation, MATCH at 0 (run_stage5_m197a_engine.ts + run_stage5_m197a_report.ts, verbatim)",
    observationRules: "orderRelation on related ids (m204Utilization); representation regression = a related id whose representation was code-bearing at the lower budget and relationship_only at the higher (M207 sweep rule)",
    deliveryFacts: "read from the DEFAULT packet's M203 ledger (evidenceBudget.*), never from the debug envelope",
  },
  hardware: { cpus: navigator.hardwareConcurrency, loadAverageAtEnd: loadAverage() },
  corpora: perCorpus,
};
writeFileSync(path.join(RESULTS, `stage5_m208_audit_${LABEL}.json`), `${JSON.stringify(out, null, 2)}\n`);
writeFileSync(path.join(RESULTS, `stage5_m208_transitions_${LABEL}.jsonl`), `${transitionRows.map((r) => JSON.stringify({
  corpus: r.corpus, grid: r.grid, pool_mode: r.poolMode, task: r.task, from: r.from, to: r.to,
  from_tier: r.fromTier, to_tier: r.toTier, from_max_pivots: r.fromMaxPivots, to_max_pivots: r.toMaxPivots,
  from_support_window: r.fromSupportWindow, to_support_window: r.toSupportWindow, from_pool: r.fromPool, to_pool: r.toPool,
  from_pool_width: r.fromPoolWidthUsed, to_pool_width: r.toPoolWidthUsed,
  from_focus: r.fromFocus, to_focus: r.toFocus, focus_swap: r.focusSwap, focus_swap_record: r.focusSwapRecord,
  from_focus_code_tokens: r.fromFocusCodeTokens, to_focus_code_tokens: r.toFocusCodeTokens, size_violation: r.sizeViolation, size_violation_cause: r.sizeViolationCause,
  relation: r.relation, focus_adjusted_relation: r.focusAdjustedRelation, stage_relations: r.stageRelations,
  first_divergence_stage: r.firstDivergenceStage, first_divergence_mechanism: r.firstDivergenceMechanism,
  lost_items: r.lostItems.map((i) => ({ fq: i.fqName, fate: i.fate, mechanism: i.mechanism, lower_id: i.lower.sourceId, lower_lane: i.lower.lane, lower_support_ordinal: i.lower.supportOrdinal, higher_role: i.higher.role, higher_lane: i.higher.lane, higher_support_ordinal: i.higher.supportOrdinal, higher_reason: i.higher.roleReason ?? i.higher.discardReason })),
  moved_items: r.movedItems.map((i) => ({ fq: i.fqName, fate: i.fate, mover: i.mover, common_lower: i.commonOrdinalLower, common_higher: i.commonOrdinalHigher, mechanism: i.mechanism, lower_id: i.lower.sourceId, higher_id: i.higher.sourceId, lower_role: i.lower.role, higher_role: i.higher.role, lower_lane: i.lower.lane, higher_lane: i.higher.lane, representation: i.representation })),
  support_window_changed: r.fromSupportWindow !== r.toSupportWindow, max_pivots_changed: r.fromMaxPivots !== r.toMaxPivots, pool_grew: r.toPool > r.fromPool,
  added_items: r.addedItems, representation_regressions: r.representationRegressions, representation_upgrades: r.representationUpgrades,
  from_whole_tokens: r.fromWholeTokens, to_whole_tokens: r.toWholeTokens, from_delivered: r.fromDelivered, to_delivered: r.toDelivered,
  from_dropped_for_budget: r.fromDroppedForBudget, to_dropped_for_budget: r.toDroppedForBudget, to_rejected_for_ceiling: r.toRejectedForCeiling,
  from_related: r.fromRelated, to_related: r.toRelated,
})).join("\n")}\n`);
writeFileSync(path.join(RESULTS, `stage5_m208_items_${LABEL}.jsonl`), `${itemRows.map((r) => JSON.stringify(r)).join("\n")}\n`);
writeFileSync(path.join(RESULTS, `stage5_m208_snapshots_${LABEL}.jsonl`), `${snapshotRows.map((r) => JSON.stringify(r)).join("\n")}\n`);
console.log(`[${LABEL}] -> results/stage5_m208_audit_${LABEL}.json + ${transitionRows.length} transitions + ${itemRows.length} tracked items + ${snapshotRows.length} snapshots`);
