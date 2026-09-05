/**
 * M219 §28 — run the operator-preflight falsification suite.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m219_falsification.ts
 *
 * Requires the materialization to have been recorded (the identity record) and
 * the launcher to be runnable; starts no container and spends nothing.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureResultsDir, runM219FalsificationSuite, suiteDocument } from "./m219Falsification";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m219_falsification.json");

async function main(): Promise<void> {
  ensureResultsDir(RESULTS_DIR);
  const controls = await runM219FalsificationSuite({
    benchmarkDir: import.meta.dir, resultsDir: RESULTS_DIR, cohortDir: join(RESULTS_DIR, "_m215_cohort"),
  });
  const document = suiteDocument(controls, { briefIds: "F1–F16 realised as F183–F198 (M218 ended at F182)" });
  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `${document.satisfied}/${document.controlCount} controls satisfied; failures [${(document.failures as string[]).join(", ") || "none"}]\n`
    + `${controls.map((entry) => `${entry.id}(${entry.briefId})=${entry.satisfied ? "ok" : "FAIL"}`).join(" ")}\nwrote ${OUTPUT}\n`,
  );
  for (const entry of controls.filter((candidate) => !candidate.satisfied)) process.stdout.write(`  ${entry.id}: ${entry.detail}\n`);
  if (!document.suitePasses) process.exitCode = 1;
}

await main();
