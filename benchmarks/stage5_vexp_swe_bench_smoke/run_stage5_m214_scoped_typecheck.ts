/**
 * M214 §33, §45 F21 — the scoped typecheck, and proof that it can fail.
 *
 * `tsconfig.benchmarks.json` excludes `benchmarks/** /*.test.ts`, so no
 * benchmark test file has ever been typechecked. M213 discovered this the hard
 * way: a test's object literal kept fields that a refactor had removed, and
 * `bun run lint` did not notice. Enabling the exclusion repo-wide surfaces ~60
 * pre-existing errors in unrelated historical benchmark tests, which M214 is
 * not authorised to clean up.
 *
 * The narrow fix is `tsconfig.m214.json`. But a config that includes files and
 * a config that CHECKS them are not the same claim — a glob that matches
 * nothing, or an `exclude` that quietly wins, would report success forever. So
 * this runner does both halves:
 *
 *   CLEAN     the scoped target must report zero errors as committed.
 *   INJECTED  a deliberate type error is written into a file the target claims
 *             to cover, and the target must report it. The file is removed
 *             afterwards whether or not the check succeeded.
 *
 * Deterministic. No model, no network, no container.
 *
 * Usage:
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m214_scoped_typecheck.ts [--out <dir>]
 */

import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const VTRACE_ROOT = path.resolve(import.meta.dir, "..", "..");
const DEFAULT_OUT = path.join(import.meta.dir, "results");
const SCOPED_CONFIG = "tsconfig.m214.json";
const BENCHMARK_CONFIG = "tsconfig.benchmarks.json";

/** A path the scoped config's include globs match, and nothing else does. */
const INJECTED_FILE = path.join(import.meta.dir, "m214InjectedTypeErrorProbe.ts");

const INJECTED_SOURCE =
  "// M214 F21 probe. Written and removed by run_stage5_m214_scoped_typecheck.ts.\n"
  + "// If this file is present in a commit, the probe crashed and left it behind.\n"
  + "export const deliberatelyWrong: number = \"this is a string, not a number\";\n";

interface TypecheckResult {
  readonly config: string;
  readonly exitCode: number;
  readonly errorCount: number;
  readonly errors: readonly string[];
}

async function typecheck(config: string): Promise<TypecheckResult> {
  const tsc = path.join(VTRACE_ROOT, "node_modules", ".bin", "tsc");
  let stdout = "";
  let exitCode = 0;
  try {
    const result = await execFile(tsc, ["-p", config], {
      cwd: VTRACE_ROOT, timeout: 900_000, maxBuffer: 32 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    const failure = error as { stdout?: string; code?: number };
    stdout = failure.stdout ?? "";
    exitCode = failure.code ?? 1;
  }
  const errors = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /error TS\d+:/.test(line));
  return { config, exitCode, errorCount: errors.length, errors };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outDir = outIndex >= 0 && args[outIndex + 1] !== undefined
    ? path.resolve(args[outIndex + 1]!)
    : DEFAULT_OUT;
  mkdirSync(outDir, { recursive: true });

  if (existsSync(INJECTED_FILE)) {
    throw new Error(
      `${INJECTED_FILE} already exists; a previous probe left it behind and must be removed before `
      + "this one can distinguish its own injection from the residue",
    );
  }

  const clean = await typecheck(SCOPED_CONFIG);

  let injected: TypecheckResult;
  try {
    writeFileSync(INJECTED_FILE, INJECTED_SOURCE);
    injected = await typecheck(SCOPED_CONFIG);
  } finally {
    rmSync(INJECTED_FILE, { force: true });
  }

  const afterRemoval = await typecheck(SCOPED_CONFIG);

  // The historical baseline this milestone is NOT authorised to fix, measured
  // rather than asserted, so the report can separate it from M214's own scope.
  const benchmarkWideWithTests = await typecheckBenchmarkTestsWide();

  const detectsInjectedError = injected.errorCount > clean.errorCount
    && injected.errors.some((line) => line.includes("m214InjectedTypeErrorProbe.ts"));

  const findings = {
    scopedTargetCleanAsCommitted: clean.errorCount === 0,
    scopedTargetDetectsInjectedError: detectsInjectedError,
    scopedTargetCleanAfterRemoval: afterRemoval.errorCount === 0,
    probeFileRemoved: !existsSync(INJECTED_FILE),
  };

  const verdict = Object.values(findings).every(Boolean)
    ? "M214_SCOPED_TYPECHECK_VERIFIED"
    : "M214_SCOPED_TYPECHECK_NOT_VERIFIED";

  const artifact = {
    schemaVersion: "stage5.m214.scoped-typecheck.v1",
    milestone: "M214",
    generatedAt: new Date().toISOString(),
    scopedConfig: SCOPED_CONFIG,
    scopedConfigCovers: [
      "benchmarks/stage5_vexp_swe_bench_smoke/m214*.ts (including *.test.ts)",
      "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m214_*.ts",
      "every file those transitively import",
    ],
    clean,
    injected: { ...injected, injectedFile: path.relative(VTRACE_ROOT, INJECTED_FILE) },
    afterRemoval,
    preexistingBenchmarkTestTypeErrors: benchmarkWideWithTests,
    scopeStatement:
      "M214_NEW_TYPECHECK_ERRORS is the scoped target's error count and is 0. "
      + "PREEXISTING_BENCHMARK_TEST_TYPE_ERRORS is what enabling benchmark test files repo-wide "
      + "would surface in historical files; it is outside M214's authorised scope and is NOT "
      + "claimed to be fixed. Repository-wide benchmark tests remain untypechecked.",
    findings,
    verdict,
  };

  const outPath = path.join(outDir, "stage5_m214_scoped_typecheck.json");
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(`${outPath}\n`);
  process.stdout.write(
    `scoped clean ${clean.errorCount} errors; injected ${injected.errorCount} errors; `
    + `after removal ${afterRemoval.errorCount} errors\n`,
  );
  process.stdout.write(
    `PREEXISTING_BENCHMARK_TEST_TYPE_ERRORS ${benchmarkWideWithTests.errorCount} `
    + `(outside M214 scope); M214_NEW_TYPECHECK_ERRORS ${clean.errorCount}\n`,
  );
  process.stdout.write(`${verdict}\n`);
  if (verdict !== "M214_SCOPED_TYPECHECK_VERIFIED") process.exitCode = 1;
}

/**
 * The historical baseline: what `tsconfig.benchmarks.json` would report if it
 * stopped excluding benchmark test files.
 *
 * Measured through a throwaway config so the committed one is never touched,
 * and reported as context — the number is the size of a cleanup M214 is
 * explicitly not authorised to do.
 */
async function typecheckBenchmarkTestsWide(): Promise<TypecheckResult & { readonly note: string }> {
  const temporary = path.join(VTRACE_ROOT, "tsconfig.m214-preexisting-probe.json");
  const base = JSON.parse(
    await Bun.file(path.join(VTRACE_ROOT, BENCHMARK_CONFIG)).text(),
  ) as { exclude?: string[] };
  const config = {
    extends: "./tsconfig.json",
    compilerOptions: { noEmit: true },
    include: ["benchmarks/**/*.ts"],
    exclude: (base.exclude ?? []).filter((entry) => entry !== "benchmarks/**/*.test.ts"),
  };
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`);
    const result = await typecheck(path.basename(temporary));
    return {
      ...result,
      errors: result.errors.slice(0, 5),
      note:
        "pre-existing, in historical benchmark test files, outside M214's scope; only the first "
        + "five error lines are retained",
    };
  } finally {
    rmSync(temporary, { force: true });
  }
}

await main();
