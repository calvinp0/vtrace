/**
 * M220-A3 §16 — run the harness-compatibility falsification suite.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m220_a3_falsification.ts
 *
 * Real-process controls run the real capability probe (network and /tmp
 * isolated, no credential) against the installed Claude Code and against fake
 * harnesses, the real launcher as a subprocess and the production adapter over
 * a fake bridge. No model, no provider, no frozen task, no container.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { M220A3_FROZEN_HASH } from "./m220A3Amendment";
import { runM220A3FalsificationSuite, suiteDocument } from "./m220A3Falsification";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m220_a3_falsification.json");
/** Under results/, never under /tmp (M218 §12); fake harnesses must also stay visible inside the probe's private /tmp. */
const SCRATCH_DIR = join(RESULTS_DIR, "_m220_a3_falsification_scratch");

async function main(): Promise<void> {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
  mkdirSync(SCRATCH_DIR, { recursive: true });
  let controls: Awaited<ReturnType<typeof runM220A3FalsificationSuite>>;
  try {
    controls = await runM220A3FalsificationSuite({
      benchmarkDir: import.meta.dir, resultsDir: RESULTS_DIR, scratchDir: SCRATCH_DIR, repoRoot: join(import.meta.dir, "..", ".."),
    });
  } finally {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
  }
  const document = suiteDocument(controls, {
    briefIds: "F1–F14 realised as F233–F246 (M220 ended at F232); F247–F254 are implementation controls",
    a3AmendmentHash: M220A3_FROZEN_HASH,
  });
  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `${document.satisfied}/${document.controlCount} controls satisfied (${document.guardFiresControls} GUARD_FIRES, ${document.guardSilentControls} GUARD_SILENT, ${document.realProcessControls} REAL_PROCESS); failures [${(document.failures as string[]).join(", ") || "none"}]\n`
    + `${controls.map((entry) => `${entry.id}(${entry.briefId ?? "-"})=${entry.satisfied ? "ok" : "FAIL"}`).join(" ")}\nwrote ${OUTPUT}\n`,
  );
  for (const entry of controls.filter((candidate) => !candidate.satisfied)) process.stdout.write(`  ${entry.id}: ${entry.detail.slice(0, 700)}\n`);
  if (!document.suitePasses) process.exitCode = 1;
}

await main();
