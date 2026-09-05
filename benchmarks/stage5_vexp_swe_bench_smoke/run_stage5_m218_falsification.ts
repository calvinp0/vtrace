/**
 * M218 §44, §45 — run the pure falsification suite and write its evidence.
 *
 * Deterministic apart from real directory trees under a uniquely owned
 * namespace beneath the host's temporary directory, which every control
 * removes. No container, no provider, no frozen task.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m218_falsification.ts
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
import { M218_SUITE_VERSION, runM218FalsificationSuite, suitePasses } from "./m218Falsification";
import { M218_SCRATCH_POLICY } from "./m218ScratchLifecycle";
import { amendedLaunchRisk, loadActiveSpendAuthority } from "./m218SpendAuthority";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m218_falsification.json");
/** M217's final HEAD: the frozen artifacts are compared against its blobs. */
export const M217_FINAL_HEAD = "9eb8689a71cac1c193ee081e15301c0cd1477a04";

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8")) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const authorities = verifyFrozenAuthorities(
    readJson(M215_PREREGISTRATION_FILE),
    readJson(M215_MANIFEST_FILE) as unknown as { rows: RunManifestRow[]; manifestHash: string },
    readJson(M215_EXTERNAL_REFERENCE_FILE),
  );
  if (!authorities.verified) throw new Error(`frozen authorities do not verify: ${authorities.issues.join("; ")}`);

  const controls = await runM218FalsificationSuite({ authorities, resultsDir: RESULTS_DIR, predecessorHead: M217_FINAL_HEAD });
  const failures = controls.filter((entry) => !entry.satisfied);
  const document = {
    schemaVersion: M218_SUITE_VERSION,
    milestone: "M218",
    generatedAt: new Date().toISOString(),
    authorities: {
      preregistration: authorities.preregistrationHash,
      manifest: authorities.manifestHash,
      externalReference: authorities.externalReferenceHash,
    },
    predecessorHead: M217_FINAL_HEAD,
    controlCount: controls.length,
    satisfied: controls.length - failures.length,
    failures: failures.map((entry) => entry.id),
    guardFiresControls: controls.filter((entry) => entry.expectation === "GUARD_FIRES").length,
    guardSilentControls: controls.filter((entry) => entry.expectation === "GUARD_SILENT").length,
    suitePasses: suitePasses(controls),
    briefControlMap: controls.filter((entry) => entry.briefId !== null).map((entry) => ({ id: entry.id, briefId: entry.briefId })),
    launchRisk: amendedLaunchRisk(loadActiveSpendAuthority(RESULTS_DIR)),
    scratchPolicy: M218_SCRATCH_POLICY,
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
