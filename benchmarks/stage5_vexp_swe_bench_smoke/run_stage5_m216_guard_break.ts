/**
 * M216 §52 — break the guards on purpose, and check the suite notices.
 *
 * A suite that has only ever passed is indistinguishable from a suite that
 * cannot fail. M215 established this by disabling two guards and watching its
 * controls drop from 66/66 to 61/66. M216 does the same against the REAL
 * substrate, breaking one guard from each of the three classes §52 names:
 *
 *   B1 SOURCE STATE     the pre-agent snapshot reverts to FILE granularity, the
 *                       exact historical invocation M215's D4 measured.
 *   B2 ADAPTER IDENTITY the agent-binary resolver stops reporting a version
 *                       mismatch, so a drifted pin would launch.
 *   B3 PATCH CAPTURE    the derived exclusions are emptied, so treatment state
 *                       is attributed to the agent.
 *
 * Each breakage is a textual substitution in a real source file, applied with a
 * backup and restored in a `finally` — the run is not allowed to leave a broken
 * guard behind, and the restoration is re-verified by byte comparison and by a
 * clean re-run.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m216_guard_break.ts
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const RESULTS_DIR = join(HERE, "results");
const VTRACE_ROOT = join(HERE, "..", "..");
const EVIDENCE = join(RESULTS_DIR, "stage5_m216_real_substrate.json");
const OUTPUT = join(RESULTS_DIR, "stage5_m216_guard_break.json");

interface Breakage {
  readonly id: string;
  readonly guardClass: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly expectedFailures: readonly string[];
}

const BREAKAGES: readonly Breakage[] = Object.freeze([
  Object.freeze({
    id: "B1_SOURCE_STATE_SNAPSHOT_GRANULARITY",
    guardClass: "source state",
    file: "m216ProductionAdapters.ts",
    find: '"container.untrackedPaths", { handle: own.bridgeHandle, granularity: "DIRECTORY" },',
    replace: '"container.untrackedPaths", { handle: own.bridgeHandle, granularity: "FILE" },',
    expectedFailures: ["F75", "F47R"],
  }),
  Object.freeze({
    id: "B2_ADAPTER_IDENTITY_VERSION_PIN",
    guardClass: "adapter identity",
    file: "m216ProductionAdapters.ts",
    find: "  return {\n    binary: pinned,\n    declaredBinary,",
    replace: "  issues.length = 0;\n  return {\n    binary: pinned,\n    declaredBinary,",
    expectedFailures: ["F21B"],
  }),
  Object.freeze({
    id: "B3_PATCH_CAPTURE_DERIVED_EXCLUSIONS",
    guardClass: "patch capture",
    file: "m216RealSubstrate.ts",
    find: "      const exclusions = derivePatchCaptureExclusions(untracked(repo, directory));",
    replace: "      const exclusions = derivePatchCaptureExclusions([]);",
    expectedFailures: ["F41P2", "F41P4", "F47"],
  }),
]);

/**
 * A control the patch-capture breakage deliberately does NOT reach, and why.
 *
 * F41P1 runs the `vtrace init` route, where the treatment writes `/.vtrace/`
 * into `.git/info/exclude`. On that route git itself hides the directory from
 * `ls-files --others --exclude-standard`, so emptying the DERIVED exclusions
 * changes nothing and the captured patch stays empty. That is exactly M214's
 * two-routes finding — "is the treatment state excluded?" has two correct
 * answers — and it is recorded here rather than papered over, because a
 * breakage list that quietly expected F41P1 to fail would be describing a
 * mechanism that does not exist.
 */
const DELIBERATELY_UNAFFECTED: readonly { readonly id: string; readonly why: string }[] =
  Object.freeze([
    Object.freeze({
      id: "F41P1",
      why: "the vtrace-init route is protected by git's own .git/info/exclude entry, not by the "
        + "derived exclusions, so emptying them cannot reach it",
    }),
  ]);

interface SuiteResult {
  readonly satisfied: number;
  readonly controlCount: number;
  readonly failures: readonly string[];
}

function runSuite(): SuiteResult {
  execFileSync("bun", [join(HERE, "run_stage5_m216_real_substrate.ts")], {
    cwd: VTRACE_ROOT, encoding: "utf8", timeout: 5_400_000, maxBuffer: 64 * 1024 * 1024,
  });
  const document = JSON.parse(readFileSync(EVIDENCE, "utf8")) as SuiteResult;
  return {
    satisfied: document.satisfied,
    controlCount: document.controlCount,
    failures: [...document.failures].sort(),
  };
}

async function main(): Promise<void> {
  const clean = JSON.parse(readFileSync(EVIDENCE, "utf8")) as SuiteResult;
  if (clean.failures.length > 0) {
    throw new Error(
      `the committed evidence is not clean (${clean.failures.join(", ")}); breaking guards against `
      + "an already-failing suite proves nothing",
    );
  }
  const cleanEvidence = `${EVIDENCE}.clean`;
  copyFileSync(EVIDENCE, cleanEvidence);

  const backups = new Map<string, string>();
  let broken: SuiteResult | null = null;
  let brokenError: string | null = null;
  try {
    for (const breakage of BREAKAGES) {
      const path = join(HERE, breakage.file);
      if (!backups.has(path)) backups.set(path, readFileSync(path, "utf8"));
      const source = readFileSync(path, "utf8");
      if (!source.includes(breakage.find)) {
        throw new Error(
          `${breakage.id}: the guard it breaks is no longer at the text it names in `
          + `${breakage.file}. A breakage that cannot find its target would silently prove nothing.`,
        );
      }
      writeFileSync(path, source.replace(breakage.find, breakage.replace));
    }
    try {
      broken = runSuite();
    } catch (error) {
      // A broken guard can make the suite CRASH rather than merely fail, which
      // is still a demonstration that the guard was load-bearing. Recorded as
      // such rather than swallowed.
      brokenError = (error as Error).message.slice(0, 600);
      try {
        broken = JSON.parse(readFileSync(EVIDENCE, "utf8")) as SuiteResult;
      } catch {
        broken = null;
      }
    }
  } finally {
    for (const [path, original] of backups) writeFileSync(path, original);
    // The evidence the broken run overwrote is replaced by the clean copy, so a
    // crashed guard-break cannot leave a failing artifact behind that a later
    // readiness derivation would read as the truth.
    renameSync(cleanEvidence, EVIDENCE);
  }

  const restoredIntact = [...backups].every(
    ([path, original]) => readFileSync(path, "utf8") === original,
  );
  const restored = runSuite();

  const expected = [...new Set(BREAKAGES.flatMap((entry) => entry.expectedFailures))].sort();
  const observed = [...(broken?.failures ?? [])].sort();
  const unexpected = observed.filter((id) => !expected.includes(id));
  const missed = expected.filter((id) => !observed.includes(id));

  const document = {
    schemaVersion: "stage5.m216.guard-break.v1",
    milestone: "M216",
    generatedAt: new Date().toISOString(),
    breakages: BREAKAGES.map((entry) => ({
      id: entry.id, guardClass: entry.guardClass, file: entry.file,
      expectedFailures: entry.expectedFailures,
    })),
    clean: { satisfied: clean.satisfied, controlCount: clean.controlCount },
    broken: broken === null
      ? null
      : { satisfied: broken.satisfied, controlCount: broken.controlCount, failures: observed },
    brokenRunError: brokenError,
    restored: {
      satisfied: restored.satisfied, controlCount: restored.controlCount,
      failures: [...restored.failures],
    },
    expectedFailures: expected,
    deliberatelyUnaffected: DELIBERATELY_UNAFFECTED,
    unexpectedFailures: unexpected,
    missedFailures: missed,
    sourceFilesRestoredIntact: restoredIntact,
    verdict: broken !== null
      && missed.length === 0
      && unexpected.length === 0
      && restored.failures.length === 0
      && restoredIntact
      ? "M216_SUITE_IS_FALSIFYING"
      : "M216_SUITE_FALSIFICATION_NOT_DEMONSTRATED",
  };

  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `clean ${clean.satisfied}/${clean.controlCount}; broken `
    + `${broken?.satisfied ?? "?"}/${broken?.controlCount ?? "?"} failing `
    + `[${observed.join(", ")}]; restored ${restored.satisfied}/${restored.controlCount}\n`,
  );
  process.stdout.write(`${document.verdict}\nwrote ${OUTPUT}\n`);
  if (document.verdict !== "M216_SUITE_IS_FALSIFYING") process.exitCode = 1;
}

await main();
