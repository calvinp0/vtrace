/**
 * M159-C §40–§45 — simulate every plausible intervention over the COMPLETE
 * affected population before any product code is written, and measure harm
 * alongside recovery.
 *
 * M158 is the reason this runner exists rather than a patch. There, a real,
 * visible, correctly-diagnosed defect turned out to recover zero of the nine
 * cases it appeared to explain, and only the simulation over the product's own
 * ordering could establish that before the code was written.
 *
 * The load-bearing measurement here is the DELIVERED-RANK CEILING. Every
 * intervention that widens a bound shares one hidden assumption — that a
 * candidate admitted deeper in the pool can still be delivered. That assumption
 * is testable directly and cheaply: across the whole corpus, record the ordinary
 * rank of every item the product actually delivers. If nothing beyond rank R is
 * ever delivered, then admitting gold at rank R+k cannot recover the case
 * however large the pool becomes, and the entire family of bound interventions
 * is refuted at once rather than one rung at a time.
 *
 * That is what §42 protects: `gold position 28` is not an argument for
 * `maxResults = 28`. The ceiling turns that rule from a policy into a
 * measurement.
 *
 * Reads pinned, already-indexed workspaces. Changes NO product bound and writes
 * NO product code (§88). NO agent, NO Docker, NO network, NO indexing.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { fileMatches, symbolMatches } from "./run_stage5_retrieval_eval";

interface FixtureRow {
  readonly instance_id: string; readonly repo: string; readonly task: string;
  readonly intent: string; readonly budget: number;
  readonly expected_files: string[]; readonly expected_symbols: string[];
}

/** Where every delivered item sat in the pre-role ordinary order, per case. */
interface DeliveredRankRow {
  readonly instanceId: string;
  readonly repo: string;
  readonly poolSize: number;
  readonly pivotRanks: readonly number[];
  readonly supportRanks: readonly number[];
  readonly deepestDeliveredRank: number | null;
  /** Ranks of items delivered WITHOUT an ordinary rank (lane injections). */
  readonly laneInjectedDeliveries: number;
  readonly goldSymbolDelivered: boolean;
}

function measureCase(kase: FixtureRow, corpusRoot: string): DeliveredRankRow {
  const workspace = path.resolve(path.join(corpusRoot, kase.instance_id));
  const db = openIndexerDatabase(path.join(workspace, ".vtrace", "index.sqlite"));
  try {
    const result = buildCapsuleV2({
      db, repoRoot: workspace, task: kase.task,
      intent: kase.intent as CapsuleIntent, maxTokens: kase.budget,
    });
    const rankByKey = new Map<string, number>();
    for (const entry of result.diagnostics.candidate_scores ?? []) {
      for (const key of [entry.fq_name, `${entry.path}::${entry.symbol}`]) {
        if (key !== undefined && key !== "" && !rankByKey.has(key)) rankByKey.set(key, entry.rank);
      }
    }
    const rankOf = (item: { path: string; symbol: string; fq_name: string }): number | null =>
      rankByKey.get(item.fq_name) ?? rankByKey.get(`${item.path}::${item.symbol}`) ?? null;

    const pivotRanks = result.pivots.map(rankOf).filter((r): r is number => r !== null);
    const supportRanks = result.support.map(rankOf).filter((r): r is number => r !== null);
    const all = [...pivotRanks, ...supportRanks];
    const injected = [...result.pivots, ...result.support].filter((i) => rankOf(i) === null).length;

    return {
      instanceId: kase.instance_id,
      repo: kase.repo,
      poolSize: result.diagnostics.candidate_count,
      pivotRanks,
      supportRanks,
      deepestDeliveredRank: all.length === 0 ? null : Math.max(...all),
      laneInjectedDeliveries: injected,
      goldSymbolDelivered: [...result.pivots, ...result.support].some((i) =>
        kase.expected_files.some((f) => fileMatches(f, i.path))
        && kase.expected_symbols.some((s) => symbolMatches(s, { symbol: i.symbol, fqName: i.fq_name }))),
    };
  } finally {
    db.close();
  }
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const get = (flag: string): string => {
    const index = argv.indexOf(flag);
    const value = index < 0 ? undefined : argv[index + 1];
    if (value === undefined) throw new Error(`${flag} is required.`);
    return value;
  };
  const fixturePath = get("--fixture");
  const corpusRoot = get("--corpus-root");
  const reachPath = get("--reach");
  const taxonomyPath = get("--taxonomy");
  const outPath = get("--out");

  const fixture = (await Bun.file(fixturePath).json()) as readonly FixtureRow[];
  const reach = (await Bun.file(reachPath).json()) as {
    records: readonly { instanceId: string; verdict: string; firstReachingPool: number | null; rankAtFirstReach: number | null; scoreAtFirstReach: number | null }[];
  };
  const taxonomy = (await Bun.file(taxonomyPath).json()) as {
    taxonomy: readonly { firstDivergence: string; instances: readonly string[]; repoCount: number }[];
  };
  const classOf = new Map<string, string>();
  for (const entry of taxonomy.taxonomy) for (const id of entry.instances) classOf.set(id, entry.firstDivergence);

  const rows: DeliveredRankRow[] = [];
  const failures: { instanceId: string; error: string }[] = [];
  for (const kase of fixture) {
    try { rows.push(measureCase(kase, corpusRoot)); }
    catch (error) { failures.push({ instanceId: kase.instance_id, error: String(error) }); }
  }

  const allDelivered = rows.flatMap((r) => [...r.pivotRanks, ...r.supportRanks]);
  const deepest = rows.map((r) => r.deepestDeliveredRank).filter((r): r is number => r !== null);
  const ceiling = {
    deliveredItems: allDelivered.length,
    maxRankEverDelivered: allDelivered.length === 0 ? null : Math.max(...allDelivered),
    p50: percentile(allDelivered, 0.5),
    p90: percentile(allDelivered, 0.9),
    p99: percentile(allDelivered, 0.99),
    /** Per case: the deepest rank that case delivered. */
    perCaseDeepestMax: deepest.length === 0 ? null : Math.max(...deepest),
    perCaseDeepestP90: percentile(deepest, 0.9),
    laneInjectedDeliveries: rows.reduce((sum, r) => sum + r.laneInjectedDeliveries, 0),
  };

  // §45 — the intervention table. Recovery is computed against the ceiling: an
  // intervention that admits gold at a rank the delivery layer has never once
  // reached recovers nothing, regardless of how many cases it "affects".
  const reachById = new Map(reach.records.map((r) => [r.instanceId, r]));
  const maxDelivered = ceiling.maxRankEverDelivered ?? 0;

  const interventions = [
    { id: "NO_CHANGE", scope: "baseline", targets: [] as string[], describe: "the current product" },
    {
      id: "POOL_CAP_25_TO_50", scope: "CANDIDATE_BOUND_EVICTION",
      targets: [...(taxonomy.taxonomy.find((t) => t.firstDivergence === "CANDIDATE_BOUND_EVICTION")?.instances ?? [])],
      describe: "double the ordinary candidate pool so gold scored past 25 is admitted",
    },
    {
      id: "POOL_CAP_25_TO_100", scope: "CANDIDATE_BOUND_EVICTION",
      targets: [...(taxonomy.taxonomy.find((t) => t.firstDivergence === "CANDIDATE_BOUND_EVICTION")?.instances ?? [])],
      describe: "quadruple the ordinary candidate pool",
    },
    {
      id: "GENERATION_POOL_WIDENING", scope: "CANDIDATE_GENERATION_POOL_BOUND",
      targets: [...(taxonomy.taxonomy.find((t) => t.firstDivergence === "CANDIDATE_GENERATION_POOL_BOUND")?.instances ?? [])],
      describe: "widen the lexical generation pool so the gold symbol is scored at all",
    },
    {
      id: "INDEX_NESTED_FUNCTIONS", scope: "INDEX_SYMBOL_MISSING",
      targets: [...(taxonomy.taxonomy.find((t) => t.firstDivergence === "INDEX_SYMBOL_MISSING")?.instances ?? [])],
      describe: "represent nested function definitions as indexed symbols",
    },
    {
      id: "CORPUS_REPAIR", scope: "INDEX_FILE_MISSING",
      targets: [...(taxonomy.taxonomy.find((t) => t.firstDivergence === "INDEX_FILE_MISSING")?.instances ?? [])],
      describe: "benchmark-side: check out the complete package tree for the affected instances",
    },
  ];

  const table = interventions.map((intervention) => {
    if (intervention.id === "NO_CHANGE") {
      return {
        ...intervention, targetsAffected: 0, recovered: 0, recoveredInstances: [] as string[],
        blockedByDeliveryCeiling: [] as string[],
        existingGoldLost: "0 (baseline)", nonTargetCasesChanged: "0 (baseline)", misleadingPromotions: "0 (baseline)",
        repoCount: 0,
        verdict: "BASELINE",
        note: `delivery ceiling: no item beyond ordinary rank ${maxDelivered} is ever delivered in ${rows.length} cases`,
      };
    }
    // For a bound intervention, a target is only RECOVERABLE if the rank at which
    // the gold symbol becomes available is one the delivery layer has ever
    // reached. Everything deeper is admitted-but-undeliverable.
    const isBound = intervention.scope === "CANDIDATE_BOUND_EVICTION" || intervention.scope === "CANDIDATE_GENERATION_POOL_BOUND";
    const recoverable: string[] = [];
    const blocked: string[] = [];
    for (const id of intervention.targets) {
      if (!isBound) { recoverable.push(id); continue; }
      const rank = reachById.get(id)?.rankAtFirstReach ?? null;
      if (rank !== null && rank <= maxDelivered) recoverable.push(id); else blocked.push(id);
    }
    const repos = new Set(intervention.targets
      .map((id) => fixture.find((f) => f.instance_id === id)?.repo)
      .filter((r): r is string => r !== undefined));
    return {
      ...intervention,
      targetsAffected: intervention.targets.length,
      recovered: recoverable.length,
      recoveredInstances: recoverable,
      blockedByDeliveryCeiling: blocked,
      // §41 forbids reporting recovery without harm — but it equally forbids
      // reporting a harm number that was never measured. An intervention that
      // recovers nothing is refuted on recovery alone (§93) and its harm is moot;
      // one that was never selected for implementation has no harm measurement
      // because none was run. Both say so rather than printing a comforting 0.
      existingGoldLost: recoverable.length === 0
        ? "moot: 0 recovery refutes the intervention before harm matters (§93)"
        : "NOT MEASURED: intervention not selected for implementation",
      nonTargetCasesChanged: recoverable.length === 0
        ? "moot: intervention rejected on recovery"
        : "NOT MEASURED: intervention not selected for implementation",
      misleadingPromotions: recoverable.length === 0
        ? "moot: intervention rejected on recovery"
        : "NOT MEASURED: intervention not selected for implementation",
      repoCount: repos.size,
      verdict: recoverable.length === 0 ? "REJECTED_ZERO_RECOVERY" : "CANDIDATE",
      note: isBound
        ? `deepest rank ever delivered = ${maxDelivered}; targets become available at ranks ${intervention.targets.map((id) => reachById.get(id)?.rankAtFirstReach ?? "n/a").join(", ")}`
        : "not a bound intervention; recovery is not ceiling-limited",
    };
  });

  await writeFile(outPath, `${JSON.stringify({
    schemaVersion: "stage5.m159.intervention-simulations.v1",
    corpusRoot,
    cases: rows.length,
    failures,
    deliveryCeiling: ceiling,
    interventions: table,
    deliveredRankRows: rows,
  }, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ ceiling, interventions: table.map((t) => ({
    id: t.id, targets: t.targetsAffected, recovered: t.recovered, blocked: t.blockedByDeliveryCeiling.length, verdict: t.verdict,
  })) }, null, 2));
}

if (import.meta.main) {
  await main();
}
