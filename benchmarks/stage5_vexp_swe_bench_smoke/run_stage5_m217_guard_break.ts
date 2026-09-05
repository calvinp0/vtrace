/**
 * M217 §21 — break the two new guards on purpose, and check both suites notice.
 *
 *   B1 CONTINUATION SAFETY  `classifyTeardown` stops reading the enumeration,
 *                           so residue never blocks and no cohort ever halts.
 *   B2 RETRY SPEND RESERVE  `retryReserveDecision` reports every retry as
 *                           inside the completion reserve.
 *
 * Both breakages are textual substitutions in the real source files, applied
 * with a backup and restored in a `finally`; restoration is re-verified by
 * byte comparison and by a clean re-run of BOTH suites — the pure suite and
 * the real-substrate suite, because the launch-critical finding is the real
 * one and a guard-break that only touched the fakes would prove the fakes.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m217_guard_break.ts
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const RESULTS_DIR = join(HERE, "results");
const VTRACE_ROOT = join(HERE, "..", "..");
const PURE_EVIDENCE = join(RESULTS_DIR, "stage5_m217_falsification.json");
const REAL_EVIDENCE = join(RESULTS_DIR, "stage5_m217_real_substrate.json");
const OUTPUT = join(RESULTS_DIR, "stage5_m217_guard_break.json");

interface Breakage {
  readonly id: string;
  readonly guardClass: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly expectedPureFailures: readonly string[];
  readonly expectedRealFailures: readonly string[];
}

const BREAKAGES: readonly Breakage[] = Object.freeze([
  Object.freeze({
    id: "B1_CONTINUATION_SAFETY_IGNORES_RESIDUE",
    guardClass: "continuation safety",
    file: "m217ContinuationSafety.ts",
    find: "  const residue = residualStateIssues(residual);\n  const reportedClean = teardownReportedClean(teardown);",
    replace: "  const residue: string[] = [];\n  const reportedClean = teardownReportedClean(teardown);",
    // F96 falls as a CONSEQUENCE of the break rather than by asserting it: with
    // residue ignored, F85's direct row selection is no longer refused and
    // actually RUNS a row, so the resume point F96 expects has moved. That is
    // the guard's absence propagating, which is what a load-bearing guard does.
    expectedPureFailures: ["F84", "F85", "F86", "F88", "F94", "F96", "F97", "F100"],
    expectedRealFailures: ["F107", "F109", "F109B", "F110", "F111", "F112", "F113"],
  }),
  Object.freeze({
    id: "B2_RETRY_RESERVE_ALWAYS_WITHIN",
    guardClass: "retry spend reserve",
    file: "m217RetryReserve.ts",
    find: "  const withinReserve = projected <= input.ceilingUsd;",
    replace: "  const withinReserve = true;",
    expectedPureFailures: ["F91", "F91B"],
    expectedRealFailures: [],
  }),
]);

/**
 * Controls the breakages deliberately do NOT reach, and why. Written down so
 * the expected-failure list is a claim about mechanism rather than a list
 * fitted to whatever fell over.
 */
const DELIBERATELY_UNAFFECTED: readonly { readonly id: string; readonly why: string }[] = Object.freeze([
  Object.freeze({
    id: "F107B",
    why: "it asserts the real PROBE's enumeration fires on the residue, which B1 does not touch; B1 "
      + "makes the CLASSIFIER ignore that enumeration, which F107 catches",
  }),
  Object.freeze({
    id: "F99",
    why: "a probe failure is checked before residue is consulted, so ignoring residue cannot reach it",
  }),
  Object.freeze({
    id: "F103",
    why: "the launch preflight reads residualStateIssues directly rather than through classifyTeardown",
  }),
  Object.freeze({
    id: "F104",
    why: "same as F103, on the real substrate",
  }),
  Object.freeze({
    id: "F114",
    why: "a false cleanup failure is PROVEN whether or not residue is consulted, because there is none",
  }),
  Object.freeze({
    id: "F89",
    why: "the frozen arithmetic does not go through retryReserveDecision",
  }),
]);

interface SuiteResult {
  readonly satisfied: number;
  readonly controlCount: number;
  readonly failures: readonly string[];
}

function runSuite(script: string, evidence: string): SuiteResult {
  try {
    execFileSync("bun", [join(HERE, script)], {
      cwd: VTRACE_ROOT, encoding: "utf8", timeout: 3_600_000, maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    // A failing suite exits non-zero by design; the evidence file is what counts.
  }
  const document = JSON.parse(readFileSync(evidence, "utf8")) as SuiteResult;
  return { satisfied: document.satisfied, controlCount: document.controlCount, failures: [...document.failures].sort() };
}

function readClean(evidence: string, label: string): SuiteResult {
  const clean = JSON.parse(readFileSync(evidence, "utf8")) as SuiteResult;
  if (clean.failures.length > 0) {
    throw new Error(
      `the committed ${label} evidence is not clean (${clean.failures.join(", ")}); breaking guards against `
      + "an already-failing suite proves nothing",
    );
  }
  return clean;
}

async function main(): Promise<void> {
  const cleanPure = readClean(PURE_EVIDENCE, "pure");
  const cleanReal = readClean(REAL_EVIDENCE, "real-substrate");
  copyFileSync(PURE_EVIDENCE, `${PURE_EVIDENCE}.clean`);
  copyFileSync(REAL_EVIDENCE, `${REAL_EVIDENCE}.clean`);

  const backups = new Map<string, string>();
  let brokenPure: SuiteResult | null = null;
  let brokenReal: SuiteResult | null = null;
  let brokenError: string | null = null;
  try {
    for (const breakage of BREAKAGES) {
      const path = join(HERE, breakage.file);
      if (!backups.has(path)) backups.set(path, readFileSync(path, "utf8"));
      const source = readFileSync(path, "utf8");
      if (!source.includes(breakage.find)) {
        throw new Error(
          `${breakage.id}: the guard it breaks is no longer at the text it names in ${breakage.file}. `
          + "A breakage that cannot find its target would silently prove nothing.",
        );
      }
      writeFileSync(path, source.replace(breakage.find, breakage.replace));
    }
    try {
      brokenPure = runSuite("run_stage5_m217_falsification.ts", PURE_EVIDENCE);
      brokenReal = runSuite("run_stage5_m217_real_substrate.ts", REAL_EVIDENCE);
    } catch (error) {
      brokenError = (error as Error).message.slice(0, 600);
    }
  } finally {
    for (const [path, original] of backups) writeFileSync(path, original);
    renameSync(`${PURE_EVIDENCE}.clean`, PURE_EVIDENCE);
    renameSync(`${REAL_EVIDENCE}.clean`, REAL_EVIDENCE);
  }

  const restoredIntact = [...backups].every(([path, original]) => readFileSync(path, "utf8") === original);
  const restoredPure = runSuite("run_stage5_m217_falsification.ts", PURE_EVIDENCE);
  const restoredReal = runSuite("run_stage5_m217_real_substrate.ts", REAL_EVIDENCE);

  const expectedPure = [...new Set(BREAKAGES.flatMap((entry) => entry.expectedPureFailures))].sort();
  const expectedReal = [...new Set(BREAKAGES.flatMap((entry) => entry.expectedRealFailures))].sort();
  const observedPure = [...(brokenPure?.failures ?? [])].sort();
  const observedReal = [...(brokenReal?.failures ?? [])].sort();
  const unexpected = [
    ...observedPure.filter((id) => !expectedPure.includes(id)),
    ...observedReal.filter((id) => !expectedReal.includes(id)),
  ];
  const missed = [
    ...expectedPure.filter((id) => !observedPure.includes(id)),
    ...expectedReal.filter((id) => !observedReal.includes(id)),
  ];

  const verdict = brokenPure !== null && brokenReal !== null
    && missed.length === 0 && unexpected.length === 0
    && restoredPure.failures.length === 0 && restoredReal.failures.length === 0
    && restoredIntact
    ? "M217_SUITE_IS_FALSIFYING"
    : "M217_SUITE_FALSIFICATION_NOT_DEMONSTRATED";

  const document = {
    schemaVersion: "stage5.m217.guard-break.v1",
    milestone: "M217",
    generatedAt: new Date().toISOString(),
    breakages: BREAKAGES.map((entry) => ({
      id: entry.id, guardClass: entry.guardClass, file: entry.file,
      expectedPureFailures: entry.expectedPureFailures, expectedRealFailures: entry.expectedRealFailures,
    })),
    pure: {
      clean: { satisfied: cleanPure.satisfied, controlCount: cleanPure.controlCount },
      broken: brokenPure === null ? null : { ...brokenPure, failures: observedPure },
      restored: restoredPure,
    },
    real: {
      clean: { satisfied: cleanReal.satisfied, controlCount: cleanReal.controlCount },
      broken: brokenReal === null ? null : { ...brokenReal, failures: observedReal },
      restored: restoredReal,
    },
    brokenRunError: brokenError,
    expectedPureFailures: expectedPure,
    expectedRealFailures: expectedReal,
    deliberatelyUnaffected: DELIBERATELY_UNAFFECTED,
    unexpectedFailures: unexpected,
    missedFailures: missed,
    sourceFilesRestoredIntact: restoredIntact,
    verdict,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `pure: clean ${cleanPure.satisfied}/${cleanPure.controlCount}; broken ${brokenPure?.satisfied ?? "?"}/`
    + `${brokenPure?.controlCount ?? "?"} failing [${observedPure.join(", ")}]; restored `
    + `${restoredPure.satisfied}/${restoredPure.controlCount}\n`
    + `real: clean ${cleanReal.satisfied}/${cleanReal.controlCount}; broken ${brokenReal?.satisfied ?? "?"}/`
    + `${brokenReal?.controlCount ?? "?"} failing [${observedReal.join(", ")}]; restored `
    + `${restoredReal.satisfied}/${restoredReal.controlCount}\n`
    + `unexpected [${unexpected.join(", ")}]; missed [${missed.join(", ")}]\n${verdict}\nwrote ${OUTPUT}\n`,
  );
  if (verdict !== "M217_SUITE_IS_FALSIFYING") process.exitCode = 1;
}

await main();
