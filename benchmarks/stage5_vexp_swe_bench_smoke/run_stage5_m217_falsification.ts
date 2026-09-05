/**
 * M217 §20 — run the pure falsification suite and write its evidence.
 *
 * Deterministic. No container, no provider, no frozen task.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m217_falsification.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RunManifestRow } from "./m214Preregistration";
import {
  M215_EXTERNAL_REFERENCE_FILE,
  M215_MANIFEST_FILE,
  M215_PREREGISTRATION_FILE,
  verifyFrozenAuthorities,
} from "./m215LaunchExecutor";
import { M217_SUITE_VERSION, runM217FalsificationSuite, suitePasses } from "./m217Falsification";
import { frozenSpendArithmetic, launchRiskStatement } from "./m217RetryReserve";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m217_falsification.json");

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8")) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const authorities = verifyFrozenAuthorities(
    readJson(M215_PREREGISTRATION_FILE),
    readJson(M215_MANIFEST_FILE) as unknown as { rows: RunManifestRow[]; manifestHash: string },
    readJson(M215_EXTERNAL_REFERENCE_FILE),
  );
  if (!authorities.verified) {
    throw new Error(`frozen authorities do not verify: ${authorities.issues.join("; ")}`);
  }

  const controls = await runM217FalsificationSuite({ authorities });
  const failures = controls.filter((entry) => !entry.satisfied);
  const document = {
    schemaVersion: M217_SUITE_VERSION,
    milestone: "M217",
    generatedAt: new Date().toISOString(),
    authorities: {
      preregistration: authorities.preregistrationHash,
      manifest: authorities.manifestHash,
      externalReference: authorities.externalReferenceHash,
    },
    controlCount: controls.length,
    satisfied: controls.length - failures.length,
    failures: failures.map((entry) => entry.id),
    guardFiresControls: controls.filter((entry) => entry.expectation === "GUARD_FIRES").length,
    guardSilentControls: controls.filter((entry) => entry.expectation === "GUARD_SILENT").length,
    suitePasses: suitePasses(controls),
    briefControlMap: controls
      .filter((entry) => entry.briefId !== null)
      .map((entry) => ({ id: entry.id, briefId: entry.briefId })),
    spendArithmetic: frozenSpendArithmetic(authorities.manifest.length),
    launchRisk: launchRiskStatement(authorities.manifest.length),
    liveModelSpendUsd: 0,
    providerCalls: 0,
    frozenBenchmarkTaskLiveAgentRuns: 0,
    dockerContainersStarted: 0,
    controls,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `${document.satisfied}/${document.controlCount} controls satisfied `
    + `(${document.guardFiresControls} GUARD_FIRES, ${document.guardSilentControls} GUARD_SILENT); `
    + `failures [${document.failures.join(", ") || "none"}]; suitePasses=${document.suitePasses}\n`,
  );
  process.stdout.write(`wrote ${OUTPUT}\n`);
  if (!document.suitePasses) process.exitCode = 1;
}

await main();
