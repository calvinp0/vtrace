/**
 * M176-E — attributing the default-budget identity misses.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m176_identity_recheck.ts
 *
 * The paired corpus run recorded 11 of 200 default-budget responses as non-identical
 * between the pre-repair and repaired checkouts. The repair cannot produce that
 * shape of difference — it replaces a response that FAILED to fit, wholesale, and
 * every one of the 11 was an orientation packet before and after, with the focus
 * unchanged and only `related` items added. So either the attribution is wrong or
 * the repair does something it is not supposed to do, and guessing between those is
 * not acceptable.
 *
 * THE DISCRIMINATOR. The corpus arms were captured MINUTES APART and under a
 * different machine load — Broad100-A and Broad100-B ran concurrently. This runner
 * re-measures the same cases with the two checkouts INTERLEAVED, back to back, so
 * temporal state and load are shared by both arms instead of separating them. It
 * also runs each checkout against itself, which is the control that tells a
 * code difference from a run-to-run one:
 *
 *   before ≠ after, before = before, after = after     → the repair changed it
 *   before ≠ after, and a checkout differs from itself → run-to-run variance
 *
 * Offline. Local index reads only; no agent, no Docker, no paid API.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { callRunPipeline, loadProblemStatements, unwrapOutput } from "./m175Capture";
import { isRecord } from "./m176Envelope";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const DATASET = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");
const PRE_REPAIR_ROOT = "/home/calvin/bench/vtrace-m176/pre-repair";

const REPEATS = 2;

interface ManifestCase { readonly instanceId: string; readonly repoRoot: string }

function changedCases(corpus: string): Array<{ instanceId: string; repoRoot: string }> {
  const report = path.join(RESULTS, `stage5_m176_${corpus}.json`);
  if (!existsSync(report)) return [];
  const parsed = JSON.parse(readFileSync(report, "utf8")) as {
    defaultBudget: { changed: ReadonlyArray<{ instanceId: string }> };
  };
  const manifest = JSON.parse(readFileSync(path.join(RESULTS, "_m171_capture", `${corpus}.manifest.json`), "utf8")) as
    { cases: readonly ManifestCase[] };
  const roots = new Map(manifest.cases.map((entry) => [entry.instanceId, entry.repoRoot]));
  return parsed.defaultBudget.changed
    .map((row) => ({ instanceId: row.instanceId, repoRoot: roots.get(row.instanceId) ?? "" }))
    .filter((row) => row.repoRoot !== "" && existsSync(row.repoRoot));
}

const focusOf = (serialized: string): string => {
  const parsed = JSON.parse(serialized) as unknown;
  return isRecord(parsed) && isRecord(parsed.focus) ? JSON.stringify(parsed.focus) : "";
};
const relatedCount = (serialized: string): number => {
  const parsed = JSON.parse(serialized) as unknown;
  return isRecord(parsed) && Array.isArray(parsed.related) ? parsed.related.length : 0;
};

async function main(): Promise<void> {
  const statements = loadProblemStatements(DATASET);
  const cases = [...changedCases("broad100a"), ...changedCases("broad100b")];
  if (cases.length === 0) throw new Error("no changed cases to re-check; run the corpora first");

  const rows: Array<Record<string, unknown>> = [];
  for (const entry of cases) {
    const task = statements.get(entry.instanceId);
    if (task === undefined) continue;

    // Interleaved, back to back: before, after, before, after. Temporal state and
    // machine load are shared by the arms rather than separating them.
    const before: string[] = [];
    const after: string[] = [];
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      before.push(JSON.stringify(unwrapOutput(await callRunPipeline(entry.repoRoot, task, null, undefined, 900_000, PRE_REPAIR_ROOT)) ?? null));
      after.push(JSON.stringify(unwrapOutput(await callRunPipeline(entry.repoRoot, task, null, undefined, 900_000, ROOT)) ?? null));
    }

    const beforeSelfStable = before.every((value) => value === before[0]);
    const afterSelfStable = after.every((value) => value === after[0]);
    const arms = before[0] === after[0];
    const attribution = arms
      ? "IDENTICAL_WHEN_INTERLEAVED"
      : beforeSelfStable && afterSelfStable
        ? "ATTRIBUTED_TO_REPAIR"
        : "RUN_TO_RUN_VARIANCE";

    rows.push({
      instanceId: entry.instanceId,
      beforeCharacters: before.map((value) => value.length),
      afterCharacters: after.map((value) => value.length),
      beforeSelfStable,
      afterSelfStable,
      identicalWhenInterleaved: arms,
      focusIdentical: focusOf(before[0]!) === focusOf(after[0]!),
      relatedBefore: relatedCount(before[0]!),
      relatedAfter: relatedCount(after[0]!),
      attribution,
    });
    console.log(
      `${entry.instanceId.padEnd(34)} before=${before.map((v) => v.length).join("/")}`
      + ` after=${after.map((v) => v.length).join("/")}  ${attribution}`,
    );
  }

  const attributedToRepair = rows.filter((row) => row.attribution === "ATTRIBUTED_TO_REPAIR");
  const identical = rows.filter((row) => row.identicalWhenInterleaved === true);
  const variance = rows.filter((row) => row.attribution === "RUN_TO_RUN_VARIANCE");

  writeFileSync(path.join(RESULTS, "stage5_m176_identity_attribution.json"), `${JSON.stringify({
    schemaVersion: "stage5.m176.identity-attribution.v1",
    milestone: "M176",
    workstream: "E",
    question: "Are the default-budget identity misses caused by the repair, or by run-to-run variance?",
    method:
      "The two checkouts are re-run INTERLEAVED, back to back, twice each, on exactly the cases the "
      + "paired corpus run recorded as changed. Interleaving makes temporal state and machine load "
      + "shared by both arms instead of separating them, and the self-comparison of each checkout is "
      + "the control that distinguishes a code difference from a run-to-run one.",
    whyItWasSuspect:
      "The repair replaces a response that FAILED to fit, wholesale. It cannot turn an orientation "
      + "packet into a larger orientation packet with the same focus and more related items, which "
      + "is what all 11 misses looked like.",
    corpusRunConditions:
      "Broad100-A and Broad100-B were captured concurrently, and within each corpus the before arm "
      + "for a case ran before the after arm. The arms were therefore separated by minutes and by a "
      + "different machine load.",
    repeats: REPEATS,
    rows,
    summary: {
      rechecked: rows.length,
      identicalWhenInterleaved: identical.length,
      attributedToRepair: attributedToRepair.length,
      runToRunVariance: variance.length,
      focusIdenticalEverywhere: rows.every((row) => row.focusIdentical === true),
    },
    verdict: attributedToRepair.length === 0
      ? "NO_IDENTITY_MISS_ATTRIBUTABLE_TO_THE_REPAIR"
      : "IDENTITY_MISS_ATTRIBUTABLE_TO_THE_REPAIR",
  }, null, 2)}\n`);

  console.log(`\nrechecked ${rows.length}: identical=${identical.length}`
    + ` variance=${variance.length} attributedToRepair=${attributedToRepair.length}`);
  console.log(attributedToRepair.length === 0
    ? "verdict: NO_IDENTITY_MISS_ATTRIBUTABLE_TO_THE_REPAIR"
    : "verdict: IDENTITY_MISS_ATTRIBUTABLE_TO_THE_REPAIR");
}

await main();
