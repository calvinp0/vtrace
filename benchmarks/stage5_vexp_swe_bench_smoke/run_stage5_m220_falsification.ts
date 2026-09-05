/**
 * M220 §44–§51 — run the quota-session / subscription-auth falsification suite.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m220_falsification.ts
 *
 * Pure controls plus real-process controls (the real launcher as a subprocess,
 * the pinned CLI's `auth status` with networking unshared, the production
 * agent adapter over a fake bridge, the real filesystem). No model, no
 * provider, no frozen task, no container.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { M220_QUOTA_AVAILABILITY, M220_REQUIRED_AUTHORIZATION_TEXT } from "./m220SubscriptionAuth";
import { ensureResultsDir, runM220FalsificationSuite, suiteDocument } from "./m220Falsification";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m220_falsification.json");
/** Research scratch for this suite: under results/, never under /tmp (M218 §12). */
const SCRATCH_DIR = join(RESULTS_DIR, "_m220_falsification_scratch");

async function main(): Promise<void> {
  ensureResultsDir(RESULTS_DIR);
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
  mkdirSync(SCRATCH_DIR, { recursive: true });
  let controls: Awaited<ReturnType<typeof runM220FalsificationSuite>>;
  try {
    controls = await runM220FalsificationSuite({
      benchmarkDir: import.meta.dir, resultsDir: RESULTS_DIR, cohortDir: join(RESULTS_DIR, "_m215_cohort"), scratchDir: SCRATCH_DIR,
    });
  } finally {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
  }
  const document = suiteDocument(controls, {
    briefIds: "F1–F30 realised as F199–F228 (M219 ended at F198); F229–F232 are implementation controls",
    quotaAvailability: M220_QUOTA_AVAILABILITY,
    requiredAuthorizationTextForG36: M220_REQUIRED_AUTHORIZATION_TEXT,
  });
  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `${document.satisfied}/${document.controlCount} controls satisfied (${document.guardFiresControls} GUARD_FIRES, ${document.guardSilentControls} GUARD_SILENT, ${document.realProcessControls} REAL_PROCESS); failures [${(document.failures as string[]).join(", ") || "none"}]\n`
    + `${controls.map((entry) => `${entry.id}(${entry.briefId ?? "-"})=${entry.satisfied ? "ok" : "FAIL"}`).join(" ")}\nwrote ${OUTPUT}\n`,
  );
  for (const entry of controls.filter((candidate) => !candidate.satisfied)) process.stdout.write(`  ${entry.id}: ${entry.detail.slice(0, 600)}\n`);
  if (!document.suitePasses) process.exitCode = 1;
}

await main();
