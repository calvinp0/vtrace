/**
 * M215 §55 — the scoped typecheck, extended from M214's, and proof it can fail.
 *
 * `tsconfig.benchmarks.json` still excludes `benchmarks/(star)(star)/*.test.ts`, so no
 * benchmark test file is typechecked by `bun run lint`. M214 narrowed a strict
 * config to its own files; M215 widens that scope to its own and keeps M214's
 * inside it, because the executor imports M214's modules and a scope that
 * dropped them would stop checking exactly the boundary where the two meet.
 *
 * The same two halves M214 established, for the same reason: a config that
 * INCLUDES files and a config that CHECKS them are different claims, and a glob
 * matching nothing would report success forever.
 *
 *   CLEAN     the scoped target reports zero errors as committed.
 *   INJECTED  a deliberate error is written into a path only M215's globs match,
 *             and the target must report it. Removed either way.
 *
 * Deterministic. No model, no network, no container.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m215_scoped_typecheck.ts
 */

import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const VTRACE_ROOT = path.resolve(import.meta.dir, "..", "..");
const OUT_DIR = path.join(import.meta.dir, "results");
const SCOPED_CONFIG = "tsconfig.m215.json";
const M214_CONFIG = "tsconfig.m214.json";

/** A path M215's include globs match and M214's do not. */
const INJECTED_FILE = path.join(import.meta.dir, "m215InjectedTypeErrorProbe.ts");

const INJECTED_SOURCE =
  "// M215 §55 probe. Written and removed by run_stage5_m215_scoped_typecheck.ts.\n"
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
  mkdirSync(OUT_DIR, { recursive: true });
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

  // M214's own target, re-run unchanged: widening the scope must not have made
  // the predecessor's guarantee weaker or its config unusable.
  const m214Scope = await typecheck(M214_CONFIG);

  const findings = {
    scopedTargetCleanAsCommitted: clean.errorCount === 0,
    scopedTargetDetectsInjectedError: injected.errorCount > clean.errorCount
      && injected.errors.some((line) => line.includes("m215InjectedTypeErrorProbe.ts")),
    scopedTargetCleanAfterRemoval: afterRemoval.errorCount === 0,
    probeFileRemoved: !existsSync(INJECTED_FILE),
    m214ScopeStillClean: m214Scope.errorCount === 0,
  };

  const verdict = Object.values(findings).every(Boolean)
    ? "M215_SCOPED_TYPECHECK_VERIFIED"
    : "M215_SCOPED_TYPECHECK_NOT_VERIFIED";

  const artifact = {
    schemaVersion: "stage5.m215.scoped-typecheck.v1",
    milestone: "M215",
    generatedAt: new Date().toISOString(),
    scopedConfig: SCOPED_CONFIG,
    scopedConfigCovers: [
      "benchmarks/stage5_vexp_swe_bench_smoke/m215*.ts (including *.test.ts)",
      "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m215_*.ts",
      "M214's files, kept inside the scope because the executor imports them",
      "every file those transitively import",
    ],
    clean,
    injected: { ...injected, injectedFile: path.relative(VTRACE_ROOT, INJECTED_FILE) },
    afterRemoval,
    m214Scope,
    m215NewTypecheckErrors: clean.errorCount,
    scopeStatement:
      "M215_NEW_TYPECHECK_ERRORS is the scoped target's error count and is 0. The ~59 pre-existing "
      + "errors in historical benchmark test files that enabling benchmark tests repo-wide would "
      + "surface are outside M215's authorised scope, were measured by M214, and are NOT claimed "
      + "to be fixed. Repository-wide benchmark tests remain untypechecked.",
    findings,
    verdict,
  };

  const outPath = path.join(OUT_DIR, "stage5_m215_scoped_typecheck.json");
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(
    `scoped clean ${clean.errorCount}; injected ${injected.errorCount}; after removal `
    + `${afterRemoval.errorCount}; m214 scope ${m214Scope.errorCount}\n`,
  );
  process.stdout.write(`${verdict}\n${outPath}\n`);
  if (verdict !== "M215_SCOPED_TYPECHECK_VERIFIED") process.exitCode = 1;
}

await main();
