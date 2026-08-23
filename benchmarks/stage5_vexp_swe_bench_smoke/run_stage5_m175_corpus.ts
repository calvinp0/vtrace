/**
 * M175-E — the frozen repair, qualified on Broad100-A and Broad100-B.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m175_corpus.ts --corpus broad100a
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m175_corpus.ts --corpus broad100b
 *
 * TWO CHECKOUTS, ONE CORPUS, ONE INDEX. The `before` arm is served by a worktree
 * pinned to the pre-repair commit; the `after` arm by this one. Both answer against
 * the SAME absolute workspace paths and the SAME indexes, so retrieval and ranking
 * are not merely expected to be unchanged — they are the same code reading the same
 * database, and the only difference between the arms is the response envelope.
 *
 * WHY NOT REPLAY. M175-B established that compaction runs before any response is
 * observable, and that capturing above the ceiling changes what gets selected. So
 * the arms are measured the only way that is faithful: by running the product.
 *
 * WHAT IS MEASURED IS WHAT AN AGENT RECEIVES. The default path returns a projection,
 * so there is no envelope to introspect and no need for one — the question is
 * whether a focus and its related evidence arrived, and how many tokens it cost.
 *
 * TASK TEXT IS THE RAW PROBLEM STATEMENT, which is what the live M173/M174 runs
 * sent and what an agent pasting a bug report sends. The M171 captures used M103's
 * derived text at a median of 156-176 characters; the defect cannot occur there,
 * so measuring it there would measure nothing.
 *
 * GOLD IS DIAGNOSTIC ONLY (§44). Retrieval is unchanged, so any gold movement is
 * DELIVERY RECOVERY and never retrieval improvement (§45).
 *
 * Offline. No agent, no Docker, no paid API.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { captureDefaultCached, loadProblemStatements, readDefaultPath } from "./m175Capture";
import type { DefaultPathOutcome } from "./m175Capture";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const DATASET = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");
const CACHE = path.join(RESULTS, "_m175_corpus");

/** The pre-repair checkout. Created by M175-E; nothing else owns it. */
const PRE_REPAIR_ROOT = "/home/calvin/bench/vtrace-m175/pre-repair";

const argv = process.argv.slice(2);
const corpus = argv[argv.indexOf("--corpus") + 1] ?? "broad100a";

const statements = loadProblemStatements(DATASET);

interface CaptureCase {
  readonly instanceId: string;
  readonly repoRoot: string;
  readonly expectedFiles?: readonly string[];
  readonly expectedSymbols?: readonly string[];
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

const localPart = (fqName: string): string => {
  const afterPath = fqName.includes("::") ? fqName.slice(fqName.lastIndexOf("::") + 2) : fqName;
  return afterPath.includes(".") ? afterPath.slice(afterPath.lastIndexOf(".") + 1) : afterPath;
};
const fileDelivered = (delivered: readonly string[], gold: readonly string[]): boolean =>
  gold.some((goldFile) => delivered.some(
    (candidate) => candidate === goldFile || candidate.endsWith(`/${goldFile}`) || goldFile.endsWith(`/${candidate}`),
  ));
const symbolDelivered = (delivered: readonly string[], gold: readonly string[]): boolean =>
  gold.some((goldSymbol) => delivered.some((candidate) => localPart(candidate) === localPart(goldSymbol)));

interface Row {
  readonly instanceId: string;
  readonly taskCharacters: number;
  readonly before: DefaultPathOutcome;
  readonly after: DefaultPathOutcome;
  readonly goldFileBefore: boolean | null;
  readonly goldFileAfter: boolean | null;
  readonly goldSymbolBefore: boolean | null;
  readonly goldSymbolAfter: boolean | null;
  readonly deliveryRecovered: boolean;
  readonly deliveryLost: boolean;
  readonly focusChanged: boolean;
  readonly relatedDelta: number;
}

async function main(): Promise<void> {
  if (!existsSync(PRE_REPAIR_ROOT)) {
    throw new Error(
      `M175-E needs the pre-repair worktree at ${PRE_REPAIR_ROOT}.\n`
      + `  git worktree add --detach ${PRE_REPAIR_ROOT} <pre-repair commit>\n`
      + `  ln -s ${ROOT}/node_modules ${PRE_REPAIR_ROOT}/node_modules`,
    );
  }
  const manifestPath = path.join(RESULTS, "_m171_capture", `${corpus}.manifest.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { cases: readonly CaptureCase[] };

  // Gold annotations live beside the M171 captures, not in the manifest.
  const goldFor = (instanceId: string): { files: readonly string[]; symbols: readonly string[] } | null => {
    const file = path.join(RESULTS, "_m171_capture", corpus, `${instanceId}.json`);
    if (!existsSync(file)) return null;
    const captured = JSON.parse(readFileSync(file, "utf8")) as
      { expectedFiles?: readonly string[]; expectedSymbols?: readonly string[] };
    return { files: captured.expectedFiles ?? [], symbols: captured.expectedSymbols ?? [] };
  };

  mkdirSync(CACHE, { recursive: true });
  const rows: Row[] = [];
  let index = 0;

  for (const entry of manifest.cases) {
    index += 1;
    const task = statements.get(entry.instanceId);
    if (task === undefined || !existsSync(entry.repoRoot)) {
      console.log(`[${index}/${manifest.cases.length}] ${entry.instanceId} SKIPPED (no task or workspace)`);
      continue;
    }

    const beforeCapture = await captureDefaultCached(
      path.join(CACHE, corpus, "before"), entry.instanceId, entry.repoRoot, task, ".default", PRE_REPAIR_ROOT,
    );
    const afterCapture = await captureDefaultCached(
      path.join(CACHE, corpus, "after"), entry.instanceId, entry.repoRoot, task, ".default", ROOT,
    );

    const before = readDefaultPath(beforeCapture.snapshot);
    const after = readDefaultPath(afterCapture.snapshot);
    const gold = goldFor(entry.instanceId);

    const row: Row = {
      instanceId: entry.instanceId,
      taskCharacters: task.length,
      before, after,
      goldFileBefore: gold === null ? null : fileDelivered(before.relatedFiles, gold.files),
      goldFileAfter: gold === null ? null : fileDelivered(after.relatedFiles, gold.files),
      goldSymbolBefore: gold === null ? null : symbolDelivered(before.relatedSymbols, gold.symbols),
      goldSymbolAfter: gold === null ? null : symbolDelivered(after.relatedSymbols, gold.symbols),
      // Recovery is "unusable → usable", not only "decline → orientation". The
      // echo has TWO failure modes and the harsher one was found on the corpus:
      // past a certain question length the envelope is unreachable even with the
      // evidence deleted, `compactProductResponse` throws, and the tool returns
      // `handler_failed` with no response at all.
      deliveryRecovered: before.kind !== "orientation" && before.kind !== "not_ready"
        && after.kind === "orientation",
      deliveryLost: before.kind === "orientation"
        && (after.kind === "decline" || after.kind === "empty"),
      focusChanged: before.kind === "orientation" && after.kind === "orientation"
        && before.focusAt !== after.focusAt,
      relatedDelta: after.relatedCount - before.relatedCount,
    };
    rows.push(row);

    const flag = row.deliveryRecovered ? "  RECOVERED" : row.deliveryLost ? "  LOST" : "";
    console.log(
      `[${index}/${manifest.cases.length}] ${entry.instanceId.padEnd(38)} task=${String(task.length).padStart(6)}`
      + ` ${before.kind.padEnd(12)}→${after.kind.padEnd(12)}`
      + ` tok ${String(before.billedTokens).padStart(5)}→${String(after.billedTokens).padStart(5)}`
      + ` rel ${before.relatedCount}→${after.relatedCount}${flag}`,
    );
  }

  // Workspaces whose index is empty refuse in BOTH arms. They are an environment
  // condition, not a result, and they are excluded from every denominator.
  const notReady = rows.filter((row) => row.before.kind === "not_ready" || row.after.kind === "not_ready");
  const valid = rows.filter((row) => !notReady.includes(row));
  const scored = valid.filter((row) => row.goldFileBefore !== null);
  const summarise = (pick: (row: Row) => DefaultPathOutcome) => ({
    delivered: valid.filter((row) => pick(row).kind === "orientation").length,
    declined: valid.filter((row) => pick(row).kind === "decline").length,
    medianBilledTokens: median(valid.map((row) => pick(row).billedTokens)),
    medianRelated: median(valid.map((row) => pick(row).relatedCount)),
    totalBilledTokens: valid.reduce((sum, row) => sum + pick(row).billedTokens, 0),
  });

  const summary = {
    corpus,
    cases: rows.length,
    validCases: valid.length,
    notReadyExcluded: notReady.map((row) => row.instanceId),
    before: summarise((row) => row.before),
    after: summarise((row) => row.after),
    deliveryRecovered: valid.filter((row) => row.deliveryRecovered)
      .map((row) => ({
        instanceId: row.instanceId, taskCharacters: row.taskCharacters,
        from: row.before.kind, errorCode: row.before.errorCode,
        relatedAfter: row.after.relatedCount,
      })),
    envelopeUnreachableBefore: valid
      .filter((row) => row.before.errorCode === "handler_failed")
      .map((row) => ({ instanceId: row.instanceId, taskCharacters: row.taskCharacters })),
    deliveryLost: valid.filter((row) => row.deliveryLost).map((row) => row.instanceId),
    focusChanged: valid.filter((row) => row.focusChanged).map((row) => row.instanceId),
    relatedChanged: valid.filter((row) => row.relatedDelta !== 0)
      .map((row) => ({ instanceId: row.instanceId, delta: row.relatedDelta })),
    goldFileDelivered: {
      scored: scored.length,
      before: scored.filter((row) => row.goldFileBefore === true).length,
      after: scored.filter((row) => row.goldFileAfter === true).length,
    },
    goldSymbolDelivered: {
      scored: scored.length,
      before: scored.filter((row) => row.goldSymbolBefore === true).length,
      after: scored.filter((row) => row.goldSymbolAfter === true).length,
    },
  };

  writeFileSync(path.join(RESULTS, `stage5_m175_${corpus}.json`), `${JSON.stringify({
    schemaVersion: "stage5.m175.corpus.v1",
    milestone: "M175",
    workstream: "M175-E",
    corpus,
    arms: {
      before: { checkout: PRE_REPAIR_ROOT, description: "pre-repair commit" },
      after: { checkout: ROOT, description: "the frozen IDENTITY_ONLY repair" },
      shared: "the same absolute workspace paths and the same indexes serve both arms",
    },
    taskText: "raw SWE-bench problem_statement",
    goldStatus: "diagnostic only; retrieval is unchanged, so movement is DELIVERY RECOVERY (§45)",
    summary,
    rows,
  }, null, 2)}\n`);

  console.log("");
  console.log(`${corpus}: ${rows.length} cases, ${valid.length} valid `
    + `(${notReady.length} excluded: index not ready in both arms)`);
  console.log(`  delivered   ${summary.before.delivered} → ${summary.after.delivered}`);
  console.log(`  declined    ${summary.before.declined} → ${summary.after.declined}`);
  console.log(`  median tok  ${summary.before.medianBilledTokens} → ${summary.after.medianBilledTokens}`);
  console.log(`  gold file   ${summary.goldFileDelivered.before} → ${summary.goldFileDelivered.after} / ${scored.length}`);
  console.log(`  gold symbol ${summary.goldSymbolDelivered.before} → ${summary.goldSymbolDelivered.after} / ${scored.length}`);
  console.log(`  recovered   ${summary.deliveryRecovered.length}   lost ${summary.deliveryLost.length}`
    + `   (tool crashed before: ${summary.envelopeUnreachableBefore.length})`);
  console.log(`  focus changed ${summary.focusChanged.length}   related changed ${summary.relatedChanged.length}`);
  console.log(`wrote results/stage5_m175_${corpus}.json`);
}

await main();
