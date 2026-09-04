/**
 * M215 §53, §54 — run the falsification suite and write its evidence.
 *
 * Zero spend: every control runs the real executor against synthetic adapters,
 * so no provider is contacted and no frozen benchmark task is executed.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m215_falsification.ts
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RunManifestRow } from "./m214Preregistration";
import {
  M215_EXECUTOR_VERSION,
  M215_EXTERNAL_REFERENCE_FILE,
  M215_MANIFEST_FILE,
  M215_PREREGISTRATION_FILE,
  verifyFrozenAuthorities,
} from "./m215LaunchExecutor";
import { runM215FalsificationSuite, suitePasses } from "./m215Falsification";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m215_falsification.json");

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8")) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const preregistrationDocument = readJson(M215_PREREGISTRATION_FILE);
  const manifestDocument = readJson(M215_MANIFEST_FILE) as unknown as {
    rows: RunManifestRow[]; manifestHash: string;
  };
  const externalReferenceDocument = readJson(M215_EXTERNAL_REFERENCE_FILE);

  const authorities = verifyFrozenAuthorities(
    preregistrationDocument, manifestDocument, externalReferenceDocument,
  );
  if (!authorities.verified) {
    throw new Error(`frozen authorities do not verify: ${authorities.issues.join("; ")}`);
  }

  const observedVtraceProductTreeSha = execFileSync(
    "git", ["-C", join(import.meta.dir, "..", ".."), "rev-parse", "HEAD:src"],
  ).toString().trim();

  const controls = await runM215FalsificationSuite({
    authorities,
    preregistrationDocument,
    manifestDocument,
    externalReferenceDocument,
    observedVtraceProductTreeSha,
  });

  const failures = controls.filter((entry) => !entry.satisfied);
  const document = {
    schemaVersion: "stage5.m215.falsification.v1",
    milestone: "M215",
    generatedAt: new Date().toISOString(),
    executorVersion: M215_EXECUTOR_VERSION,
    liveModelSpendUsd: 0,
    frozenBenchmarkTaskLiveAgentRuns: 0,
    authorities: {
      preregistration: authorities.preregistrationHash,
      manifest: authorities.manifestHash,
      externalReference: authorities.externalReferenceHash,
    },
    observedVtraceProductTreeSha,
    controlCount: controls.length,
    satisfied: controls.filter((entry) => entry.satisfied).length,
    guardFiresControls: controls.filter((entry) => entry.expectation === "GUARD_FIRES").length,
    guardSilentControls: controls.filter((entry) => entry.expectation === "GUARD_SILENT").length,
    suitePasses: suitePasses(controls),
    failures: failures.map((entry) => entry.id),
    controls,
  };

  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `${document.satisfied}/${document.controlCount} controls satisfied `
    + `(${document.guardFiresControls} GUARD_FIRES, ${document.guardSilentControls} GUARD_SILENT); `
    + `suitePasses=${document.suitePasses}\n`,
  );
  process.stdout.write(`wrote ${OUTPUT}\n`);
  if (!document.suitePasses) {
    process.exitCode = 1;
    process.stdout.write(`failing controls: ${failures.map((entry) => entry.id).join(", ")}\n`);
  }
}

await main();
