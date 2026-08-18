/**
 * M160-B §34, §35, §38 — Broad100-B quality, availability truth and gold fate.
 *
 * The metric definitions are lifted verbatim from the M156/M157/M158 broad
 * comparison runners, which take them from the scorer's own vocabulary. That is
 * the only reason the two corpora can be put side by side at all: if M160
 * re-derived "delivered" or "top-3" its own way, every difference between
 * Broad100-A and Broad100-B would be uninterpretable (§34).
 *
 * Denominators are stated, never assumed (§66). A row the scorer could not
 * evaluate is excluded from every rate, exactly as M155 §20 established, and the
 * count that was excluded is printed beside the rate rather than folded into it.
 *
 * Latency is measured here rather than read from the eval artifact: the eval
 * records no timing at all, and M122's convention keeps nondeterministic fields
 * out of the artifact whose semantic hash is the comparison authority. So this
 * runner times one capsule build per case, and that timing never enters a
 * semantic comparison.
 *
 * Reads pinned, already-indexed workspaces. NO agent, NO Docker, NO network, NO
 * indexing, NO writes to any target workspace or index.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { loadRetrievalFixture, type RetrievalEvalRow } from "./run_stage5_retrieval_eval";
import type { PreparedWorkspace } from "./run_stage5_m160_prepare_workspaces";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const RESULTS = path.join(import.meta.dir, "results");

/** M155 §20 — a row the scorer could not evaluate is in no rate. */
function isEvaluated(row: RetrievalEvalRow): boolean {
  return row.result !== "workspace_error" && row.result !== "fixture_error";
}

function rate(rows: readonly RetrievalEvalRow[], predicate: (row: RetrievalEvalRow) => boolean): number {
  const evaluated = rows.filter(isEvaluated);
  if (evaluated.length === 0) return 0;
  return Number((evaluated.filter(predicate).length / evaluated.length).toFixed(4));
}

function count(rows: readonly RetrievalEvalRow[], predicate: (row: RetrievalEvalRow) => boolean): number {
  return rows.filter(isEvaluated).filter(predicate).length;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return Number((sorted[index] ?? 0).toFixed(2));
}

const DELIVERED = new Set(["pivot", "support"]);

/** The M156-M158 metric block, unchanged, plus explicit numerators. */
export function summarize(rows: readonly RetrievalEvalRow[]): Record<string, number> {
  const evaluated = rows.filter(isEvaluated);
  const tokens = evaluated.map((row) => row.estimated_tokens ?? 0);
  return {
    cases: rows.length,
    evaluated: evaluated.length,
    goldFileTop1: rate(rows, (row) => row.contains_expected_file_top1),
    goldFileTop1Count: count(rows, (row) => row.contains_expected_file_top1),
    goldFileTop3: rate(rows, (row) => row.contains_expected_file_top3),
    goldFileTop3Count: count(rows, (row) => row.contains_expected_file_top3),
    goldFileAnywhere: rate(rows, (row) => row.contains_expected_file_anywhere),
    goldFileAnywhereCount: count(rows, (row) => row.contains_expected_file_anywhere),
    goldSymbolAnywhere: rate(rows, (row) => row.contains_expected_symbol_anywhere),
    goldSymbolAnywhereCount: count(rows, (row) => row.contains_expected_symbol_anywhere),
    goldDelivered: rate(rows, (row) => DELIVERED.has(row.expected_file_role)),
    goldDeliveredCount: count(rows, (row) => DELIVERED.has(row.expected_file_role)),
    goldSymbolDelivered: rate(rows, (row) => DELIVERED.has(row.expected_symbol_role)),
    goldSymbolDeliveredCount: count(rows, (row) => DELIVERED.has(row.expected_symbol_role)),
    goldDiscarded: rate(rows, (row) => row.expected_file_role === "discarded"),
    goldMissing: rate(rows, (row) => row.expected_file_role === "missing"),
    emptyContexts: rate(rows, (row) => row.pivot_count === 0 && row.support_count === 0),
    emptyContextCount: count(rows, (row) => row.pivot_count === 0 && row.support_count === 0),
    supportOnlyContexts: rate(rows, (row) => row.pivot_count === 0 && row.support_count > 0),
    pivotContexts: rate(rows, (row) => row.pivot_count > 0),
    // §108 — a lead that is not gold, on a case where gold existed to be led with.
    misleadingLead: rate(rows, (row) => row.pivot_count > 0 && !row.contains_expected_file_top1),
    misleadingLeadCount: count(rows, (row) => row.pivot_count > 0 && !row.contains_expected_file_top1),
    tokensMean: mean(tokens),
    tokensMedian: quantile(tokens, 0.5),
    tokensP90: quantile(tokens, 0.9),
  };
}

function byRepo(rows: readonly RetrievalEvalRow[]): Record<string, Record<string, number>> {
  const groups = new Map<string, RetrievalEvalRow[]>();
  for (const row of rows) {
    const bucket = groups.get(row.repo) ?? [];
    bucket.push(row);
    groups.set(row.repo, bucket);
  }
  return Object.fromEntries([...groups].sort().map(([repo, bucket]) => [repo, summarize(bucket)]));
}

async function measureLatency(
  rows: readonly RetrievalEvalRow[],
  fixturePath: string,
  corpusRoot: string,
): Promise<number[]> {
  const fixture = await loadRetrievalFixture(fixturePath);
  const taskById = new Map(fixture.map((entry) => [entry.instance_id, entry]));
  const samples: number[] = [];
  for (const row of rows) {
    if (!isEvaluated(row)) continue;
    const entry = taskById.get(row.instance_id);
    if (entry === undefined) continue;
    const workspace = path.resolve(corpusRoot, row.instance_id);
    let db: ReturnType<typeof openIndexerDatabase> | null = null;
    try {
      db = openIndexerDatabase(path.join(workspace, ".vtrace", "index.sqlite"));
      const started = performance.now();
      buildCapsuleV2({
        db,
        repoRoot: workspace,
        task: entry.task,
        intent: entry.intent as CapsuleIntent,
        maxTokens: entry.budget,
      });
      samples.push(performance.now() - started);
    } catch {
      // A case that cannot be rebuilt contributes no timing rather than a zero.
    } finally {
      db?.close();
    }
  }
  return samples;
}

interface Config {
  readonly eval: string;
  readonly workspaces: string;
  readonly goldFate: string;
  readonly corpusRoot: string;
  readonly fixture: string;
  readonly out: string;
  readonly latency: boolean;
}

export function parseArgs(argv: readonly string[]): Config {
  let evalPath = path.join(RESULTS, "stage5_m160_broad100b_retrieval.json");
  let workspaces = path.join(RESULTS, "stage5_m160_broad100b_workspaces.json");
  let goldFate = path.join(RESULTS, "stage5_m160_broad100b_gold_fate.json");
  let corpusRoot = path.join(RESULTS, "workspaces", "m160_broad_b");
  let fixture = path.join(import.meta.dir, "retrieval_eval.m160_broad_b.json");
  let out = path.join(RESULTS, "stage5_m160_broad100b_results.json");
  let latency = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string => {
      const next = argv[(i += 1)];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--eval") evalPath = value();
    else if (arg === "--workspaces") workspaces = value();
    else if (arg === "--gold-fate") goldFate = value();
    else if (arg === "--corpus-root") corpusRoot = value();
    else if (arg === "--fixture") fixture = value();
    else if (arg === "--out") out = value();
    else if (arg === "--no-latency") latency = false;
    else throw new Error(`Unknown argument ${arg}`);
  }
  return { eval: evalPath, workspaces, goldFate, corpusRoot, fixture, out, latency };
}

async function main(config: Config): Promise<void> {
  const evalDoc = JSON.parse(await readFile(config.eval, "utf8")) as { rows: RetrievalEvalRow[] };
  const prepared = JSON.parse(await readFile(config.workspaces, "utf8")) as {
    workspaces: PreparedWorkspace[];
    counts: Record<string, number>;
  };
  const fate = await readFile(config.goldFate, "utf8")
    .then((text) => JSON.parse(text) as { counts?: Record<string, number>; byFate?: Record<string, string[]> })
    .catch(() => null);

  const rows = evalDoc.rows;
  const samples = config.latency ? await measureLatency(rows, config.fixture, config.corpusRoot) : [];

  const availability = prepared.workspaces.reduce<Record<string, number>>((acc, row) => {
    acc[row.availability] = (acc[row.availability] ?? 0) + 1;
    return acc;
  }, {});

  const doc = {
    schemaVersion: "stage5.m160.broad100b-results.v1",
    milestone: "M160",
    kind: "Broad100-B retrieval quality, availability and gold fate under the frozen product (§34)",
    productChanged: false,
    metricDefinitions: "inherited verbatim from the M156/M157/M158 broad comparison runners (§34)",
    denominators: {
      frozenCases: prepared.workspaces.length,
      scoredCases: rows.length,
      evaluatedCases: rows.filter(isEvaluated).length,
      note:
        "Rates use evaluatedCases. Cases refused by the preparation completeness gate never enter " +
        "the fixture and so never enter a retrieval-quality denominator (§8, §80).",
    },
    availability: {
      counts: availability,
      degradedNote:
        "§32 — contained per-file parse failures leave a repository usable and degraded. " +
        "Degraded repositories are scored normally and are never counted as unavailable.",
      parseFailures: prepared.workspaces.reduce((sum, row) => sum + (row.index?.parseFailures ?? 0), 0),
    },
    overall: summarize(rows),
    byRepo: byRepo(rows),
    goldFate: fate?.counts ?? null,
    latency: {
      samples: samples.length,
      meanMs: mean(samples),
      medianMs: quantile(samples, 0.5),
      p90Ms: quantile(samples, 0.9),
      note: "capsule build wall time; reported, never folded into a semantic comparison (M122 convention)",
    },
    indexBuild: {
      totalSeconds: Math.round(prepared.workspaces.reduce((sum, row) => sum + row.indexMs, 0) / 1000),
      medianSeconds: Number((quantile(prepared.workspaces.map((row) => row.indexMs), 0.5) / 1000).toFixed(2)),
      indexedFiles: prepared.workspaces.reduce((sum, row) => sum + (row.index?.filesIndexed ?? 0), 0),
      symbols: prepared.workspaces.reduce((sum, row) => sum + (row.index?.symbols ?? 0), 0),
    },
  };

  await writeFile(config.out, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  const o = doc.overall;
  console.log(
    `Broad100-B: ${o.evaluated} evaluated · top-1 ${(o.goldFileTop1 * 100).toFixed(1)}% · ` +
      `top-3 ${(o.goldFileTop3 * 100).toFixed(1)}% · delivered ${o.goldDeliveredCount}/${o.evaluated} · ` +
      `symbol anywhere ${(o.goldSymbolAnywhere * 100).toFixed(1)}%`,
  );
  console.log(`  ${path.relative(REPO_ROOT, config.out)}`);
}

if (import.meta.main) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
