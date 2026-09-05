/**
 * M220 — the scoped typecheck, extended from M219's, and proof it can fail.
 *
 *   CLEAN     the scoped target reports zero errors as committed.
 *   INJECTED  a deliberate error is written into a path only M220's globs match,
 *             and the target must report it. Removed either way.
 *
 * Deterministic. No model, no network, no container.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m220_scoped_typecheck.ts
 */

import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const VTRACE_ROOT = path.resolve(import.meta.dir, "..", "..");
const OUT_DIR = path.join(import.meta.dir, "results");
const SCOPED_CONFIG = "tsconfig.m220.json";
const PREDECESSOR_CONFIG = "tsconfig.m219.json";
const INJECTED_FILE = path.join(import.meta.dir, "m220InjectedTypeErrorProbe.ts");
const INJECTED_SOURCE =
  "// M220 probe. Written and removed by run_stage5_m220_scoped_typecheck.ts.\n"
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
    const result = await execFile(tsc, ["-p", config], { cwd: VTRACE_ROOT, timeout: 900_000, maxBuffer: 32 * 1024 * 1024 });
    stdout = result.stdout;
  } catch (error) {
    const failure = error as { stdout?: string; code?: number };
    stdout = failure.stdout ?? "";
    exitCode = failure.code ?? 1;
  }
  const errors = stdout.split("\n").map((line) => line.trim()).filter((line) => /error TS\d+:/.test(line));
  return { config, exitCode, errorCount: errors.length, errors };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  if (existsSync(INJECTED_FILE)) throw new Error(`${INJECTED_FILE} already exists; a previous probe left it behind`);
  const clean = await typecheck(SCOPED_CONFIG);
  let injected: TypecheckResult;
  try {
    writeFileSync(INJECTED_FILE, INJECTED_SOURCE);
    injected = await typecheck(SCOPED_CONFIG);
  } finally {
    rmSync(INJECTED_FILE, { force: true });
  }
  const afterRemoval = await typecheck(SCOPED_CONFIG);
  const predecessorScope = await typecheck(PREDECESSOR_CONFIG);
  const findings = {
    scopedTargetCleanAsCommitted: clean.errorCount === 0,
    scopedTargetDetectsInjectedError: injected.errorCount > clean.errorCount && injected.errors.some((line) => line.includes("m220InjectedTypeErrorProbe.ts")),
    scopedTargetCleanAfterRemoval: afterRemoval.errorCount === 0,
    probeFileRemoved: !existsSync(INJECTED_FILE),
    predecessorScopeStillClean: predecessorScope.errorCount === 0,
  };
  const verdict = Object.values(findings).every(Boolean) ? "M220_SCOPED_TYPECHECK_VERIFIED" : "M220_SCOPED_TYPECHECK_NOT_VERIFIED";
  const artifact = {
    schemaVersion: "stage5.m220.scoped-typecheck.v1",
    milestone: "M220",
    generatedAt: new Date().toISOString(),
    scopedConfig: SCOPED_CONFIG,
    scopedConfigCovers: [
      "benchmarks/stage5_vexp_swe_bench_smoke/m220*.ts (including *.test.ts)",
      "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m220_*.ts",
      "M219's, M218's, M217's, M216's, M215's and M214's files, kept inside the scope because M220's session controls live in their executor, launcher, adapter and continuation ledger",
      "benchmarks/stage5_vexp_swe_bench_smoke/m193aArmEnvironment.ts",
      "every file those transitively import",
    ],
    clean, injected: { ...injected, injectedFile: path.relative(VTRACE_ROOT, INJECTED_FILE) }, afterRemoval, predecessorScope,
    m220NewTypecheckErrors: clean.errorCount,
    scopeStatement:
      "M220_NEW_TYPECHECK_ERRORS is the scoped target's error count and is 0. The ~59 pre-existing errors in "
      + "historical benchmark test files that enabling benchmark tests repo-wide would surface are outside M220's "
      + "authorised scope, were measured by M214, and are NOT claimed to be fixed.",
    findings, verdict,
  };
  const outPath = path.join(OUT_DIR, "stage5_m220_scoped_typecheck.json");
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(`scoped clean ${clean.errorCount}; injected ${injected.errorCount}; after removal ${afterRemoval.errorCount}; m219 scope ${predecessorScope.errorCount}\n${verdict}\n${outPath}\n`);
  if (verdict !== "M220_SCOPED_TYPECHECK_VERIFIED") process.exitCode = 1;
}

await main();
