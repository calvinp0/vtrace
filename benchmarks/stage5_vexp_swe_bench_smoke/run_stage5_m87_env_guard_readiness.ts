// Stage 5 M87 — environment-guard post-repair READINESS verification (READ-ONLY).
//
// This driver answers the M87 question: "Can Stage 5 prove it will use the intended clean
// testbed/vexp_swebench prefix and fail closed before any wrong-prefix execution?" It runs
// the M86 read-only env audit, exercises the PURE prefix guard / install-command classifier
// on synthetic negative cases, runs the (read-only, NO-AGENT) Stage 5 env-guard preflight on
// the clean expected prefix, and replays the PURE drift checker on synthetic snapshots.
//
// It MUTATES NOTHING: no `pip install`, no `conda install`, no agent spawn, no Docker. Every
// real-environment touch is the read-only probe (`python -c …`, `python -m pip -V/show`,
// `conda list`). The negative tests, positive-path guard eval, and drift simulation are pure
// functions over synthetic inputs. It writes two compact JSON summaries; no env dumps.
//
// Usage:
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m87_env_guard_readiness.ts \
//     [--out <results-dir>] [--expected-testbed-prefix <prefix>] [--vexp-swe-bench-dir <dir>]

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  runEnvAudit,
  type EnvAuditResult,
  type CandidatePrefix,
} from "./envIsolationProbe";
import {
  evaluatePrefixGuard,
  classifyInstallCommand,
  classifyPackageDrift,
  summarizePrefixDrift,
  normalizePrefix,
  type PackageRecord,
  type PythonProbe,
  type PrefixGuardConfig,
  type DriftStatus,
} from "./envIsolationGuard";
import { runStage5EnvGuardPreflight } from "./stage5EnvGuardIntegration";

const DEFAULT_BASE = "/home/calvin/miniforge3";
const DEFAULT_EXPECTED = "/home/calvin/miniforge3/envs/vexp_swebench";
const DEFAULT_VEXP = "/home/calvin/code/vexp-swe-bench";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT = arg("--out", join(__dirname, "results"));
const BASE = normalizePrefix(arg("--base-prefix", DEFAULT_BASE));
const EXPECTED = normalizePrefix(arg("--expected-testbed-prefix", DEFAULT_EXPECTED));
const VEXP = normalizePrefix(arg("--vexp-swe-bench-dir", DEFAULT_VEXP));

// --------------------------------------------------------------------------------------------
// Verification 1 — read-only environment audit (+ contamination findings).
// --------------------------------------------------------------------------------------------

/** A package import is BROKEN when metadata says it is installed but the module won't import. */
function isBrokenImport(r: PackageRecord): boolean {
  const installed = r.pipVersion != null || r.condaVersion != null;
  return installed && r.importedVersion == null && r.importedFile == null;
}

interface AuditPackageOut {
  package: string;
  condaVersion: string | null;
  pipVersion: string | null;
  importedVersion: string | null;
  importedFile: string | null;
  importedMtimeMs: number | null;
  driftStatus: DriftStatus;
  driftDetail: string;
  brokenImport: boolean;
}

interface AuditPrefixOut {
  role: string;
  prefix: string;
  exists: boolean;
  pythonExecutable: string | null;
  sysPrefix: string | null;
  pipPrefix: string | null;
  condaPrefixSeen: string | null;
  packages: AuditPackageOut[];
}

function enrichAudit(audit: EnvAuditResult): AuditPrefixOut[] {
  return audit.prefixes.map((p) => ({
    role: p.role,
    prefix: p.prefix,
    exists: p.exists,
    pythonExecutable: p.probe?.executable ?? null,
    sysPrefix: p.probe?.prefix ?? null,
    pipPrefix: p.pipPrefix,
    condaPrefixSeen: p.probe?.condaPrefix ?? null,
    packages: p.packages.map((r) => {
      const drift = classifyPackageDrift(r);
      return {
        package: r.package,
        condaVersion: r.condaVersion,
        pipVersion: r.pipVersion,
        importedVersion: r.importedVersion,
        importedFile: r.importedFile,
        importedMtimeMs: r.importedMtimeMs,
        driftStatus: drift.status,
        driftDetail: drift.detail,
        brokenImport: isBrokenImport(r),
      };
    }),
  }));
}

const CANDIDATES: CandidatePrefix[] = [
  { role: "base", prefix: BASE },
  { role: "testbed", prefix: EXPECTED },
  { role: "testbed", prefix: `${VEXP}/.venv` },
];

const auditRaw = runEnvAudit(CANDIDATES);
const auditPrefixes = enrichAudit(auditRaw);

const basePrefix = auditPrefixes.find((p) => p.prefix === BASE);
const baseMismatches = (basePrefix?.packages ?? []).filter((p) => p.driftStatus === "pip_conda_mismatch").map((p) => p.package);
const baseBroken = (basePrefix?.packages ?? []).filter((p) => p.brokenImport).map((p) => p.package);
const baseContaminated = baseMismatches.length > 0 || baseBroken.length > 0;

const expectedPrefix = auditPrefixes.find((p) => p.prefix === EXPECTED);
const expectedClean =
  Boolean(expectedPrefix?.exists) &&
  (expectedPrefix?.packages ?? []).every((p) => p.driftStatus === "ok" && !p.brokenImport);

// --------------------------------------------------------------------------------------------
// Verification 2 — prefix-guard NEGATIVE tests (pure / synthetic; nothing executed).
// --------------------------------------------------------------------------------------------

interface NegativeCase {
  name: string;
  rejected: boolean;
  detail: string;
}

const DEV_PREFIX = `${BASE}/envs/vtrace_dev`; // synthetic active dev env (not real)
const cleanProbe: PythonProbe = {
  executable: `${EXPECTED}/bin/python`,
  prefix: EXPECTED,
  basePrefix: EXPECTED,
  pipVersionLine: `pip 26.1.2 from ${EXPECTED}/lib/python3.12/site-packages/pip (python 3.12)`,
  condaPrefix: EXPECTED,
};
const baseProbe: PythonProbe = {
  executable: `${BASE}/bin/python`,
  prefix: BASE,
  basePrefix: BASE,
  pipVersionLine: `pip 25.3 from ${BASE}/lib/python3.12/site-packages/pip (python 3.12)`,
  condaPrefix: BASE,
};
const baseCfg: PrefixGuardConfig = { expectedTestbedPrefix: EXPECTED, protectedBasePrefixes: [BASE], protectedDevPrefixes: [DEV_PREFIX] };

function cmdRejected(command: string): boolean {
  return classifyInstallCommand(command).isDependencyInstall && !classifyInstallCommand(command).safeForm;
}

const negativeCases: NegativeCase[] = [
  // --- unsafe install-command FORMS ---
  (() => { const r = cmdRejected("pip install pytest==4.0"); return { name: "bare `pip install` rejected", rejected: r, detail: classifyInstallCommand("pip install pytest==4.0").reason }; })(),
  (() => { const c = "python -m pip install pluggy==0.13.1"; const r = cmdRejected(c); return { name: "bare `python -m pip install` rejected", rejected: r, detail: classifyInstallCommand(c).reason }; })(),
  (() => { const c = "conda activate base && pip install pytest"; const r = cmdRejected(c); return { name: "`conda activate && pip install` rejected", rejected: r, detail: classifyInstallCommand(c).reason }; })(),
  (() => { const c = "conda install pluggy"; const r = cmdRejected(c); return { name: "`conda install` without -p/-n rejected", rejected: r, detail: classifyInstallCommand(c).reason }; })(),
  // --- protected prefixes as install TARGET (expected mis-set) ---
  (() => { const cfg: PrefixGuardConfig = { expectedTestbedPrefix: BASE, protectedBasePrefixes: [BASE], protectedDevPrefixes: [DEV_PREFIX] }; const g = evaluatePrefixGuard(baseProbe, cfg); return { name: "base prefix rejected as install target", rejected: !g.ok, detail: g.failures.join("; ") || "(no failures)" }; })(),
  (() => { const cfg: PrefixGuardConfig = { expectedTestbedPrefix: DEV_PREFIX, protectedBasePrefixes: [BASE], protectedDevPrefixes: [DEV_PREFIX] }; const probe: PythonProbe = { executable: `${DEV_PREFIX}/bin/python`, prefix: DEV_PREFIX, basePrefix: BASE, pipVersionLine: `pip 25.3 from ${DEV_PREFIX}/lib/python3.12/site-packages/pip (python 3.12)`, condaPrefix: DEV_PREFIX }; const g = evaluatePrefixGuard(probe, cfg); return { name: "active dev prefix rejected as install target", rejected: !g.ok, detail: g.failures.join("; ") || "(no failures)" }; })(),
  // --- fail-closed when un-provable ---
  (() => { const cfg: PrefixGuardConfig = { expectedTestbedPrefix: "", protectedBasePrefixes: [BASE], protectedDevPrefixes: [DEV_PREFIX] }; const g = evaluatePrefixGuard(cleanProbe, cfg); return { name: "missing expected prefix fails closed", rejected: !g.ok, detail: g.failures.join("; ") || "(no failures)" }; })(),
  (() => { const badPip: PythonProbe = { ...cleanProbe, pipVersionLine: `pip 25.3 from ${BASE}/lib/python3.12/site-packages/pip (python 3.12)` }; const g = evaluatePrefixGuard(badPip, baseCfg); return { name: "pip -V prefix mismatch fails closed", rejected: !g.ok, detail: g.failures.join("; ") || "(no failures)" }; })(),
  (() => { const contam: PythonProbe = { ...baseProbe }; const g = evaluatePrefixGuard(contam, baseCfg); return { name: "actual sys.prefix==base (contamination) fails closed", rejected: !g.ok, detail: g.failures.join("; ") || "(no failures)" }; })(),
];

const allNegativeRejected = negativeCases.every((c) => c.rejected);

// --------------------------------------------------------------------------------------------
// Verification 3 — expected-prefix POSITIVE path (read-only; NO agent, NO Docker).
// --------------------------------------------------------------------------------------------

const positive = runStage5EnvGuardPreflight({
  enabled: true,
  driftCheckEnabled: true,
  expectedTestbedPrefix: EXPECTED,
  vexpSweBenchDir: VEXP,
  shellCondaPrefix: BASE,
});
const positivePass =
  positive.ok &&
  positive.metadata.stage5_env_guard_status === "pass" &&
  positive.metadata.stage5_python_prefix_verified &&
  positive.metadata.stage5_pip_prefix_verified;

// --------------------------------------------------------------------------------------------
// Verification 5 — post-run drift SIMULATION (pure / synthetic snapshots).
// --------------------------------------------------------------------------------------------

function rec(over: Partial<PackageRecord>): PackageRecord {
  return {
    prefix: EXPECTED,
    pythonExecutable: `${EXPECTED}/bin/python`,
    package: "pluggy",
    condaVersion: "1.6.0",
    pipVersion: "1.6.0",
    importedVersion: "1.6.0",
    importedFile: `${EXPECTED}/lib/python3.12/site-packages/pluggy/__init__.py`,
    importedMtimeMs: 1000,
    ...over,
  };
}

// (a) stable base/dev → ok, no safety failure.
const stableBefore = rec({ prefix: BASE });
const driftStable = summarizePrefixDrift([{ prefix: BASE, role: "base", records: [{ before: stableBefore, after: stableBefore }] }]);
// (b) synthetic mtime change on a BASE package → changed_during_run + safetyFailed.
const changedAfter = rec({ prefix: BASE, importedMtimeMs: 2000 });
const driftChanged = summarizePrefixDrift([{ prefix: BASE, role: "base", records: [{ before: rec({ prefix: BASE }), after: changedAfter }] }]);
// (c) synthetic pluggy conda/pip mismatch → pip_conda_mismatch.
const mismatch = classifyPackageDrift(rec({ prefix: BASE, condaVersion: "0.13.1", pipVersion: "1.6.0", importedVersion: "1.6.0" }));
// (d) broken pytest import → brokenImport (audit-layer rule).
const brokenRec = rec({ prefix: BASE, package: "pytest", condaVersion: "0.1.dev1", pipVersion: "0.1.dev1", importedVersion: null, importedFile: null, importedMtimeMs: null });
const brokenDetected = isBrokenImport(brokenRec);

const driftSim = {
  stable_base_ok: driftStable.overallStatus === "ok" && !driftStable.safetyFailed,
  changed_during_run_detected: driftChanged.changedCount === 1 && driftChanged.overallStatus === "changed_during_run",
  base_change_flags_safety_failure: driftChanged.safetyFailed === true,
  pip_conda_mismatch_detected: mismatch.status === "pip_conda_mismatch",
  broken_import_detected: brokenDetected === true,
};
const driftSimAllPass = Object.values(driftSim).every(Boolean);

// --------------------------------------------------------------------------------------------
// Assemble + write the two JSON summaries.
// --------------------------------------------------------------------------------------------

const generatedAt = new Date().toISOString();

const auditJson = {
  milestone: "M87",
  generatedBy: "run_stage5_m87_env_guard_readiness.ts (read-only)",
  generatedAt,
  shellCondaPrefix: auditRaw.shellCondaPrefix,
  shellVirtualEnv: auditRaw.shellVirtualEnv,
  expectedTestbedPrefix: EXPECTED,
  prefixes: auditPrefixes,
  findings: {
    baseRepairVerified: !baseContaminated,
    baseContaminated,
    basePipCondaMismatches: baseMismatches,
    baseBrokenImports: baseBroken,
    expectedTestbedClean: expectedClean,
  },
};

const readinessJson = {
  milestone: "M87",
  generatedAt,
  question: "Can Stage 5 prove it will use the intended clean testbed prefix and fail closed before wrong-prefix execution?",
  baseRepairVerified: !baseContaminated,
  expectedTestbedPrefix: EXPECTED,
  expectedTestbedClean: expectedClean,
  verification: {
    audit: { baseContaminated, basePipCondaMismatches: baseMismatches, baseBrokenImports: baseBroken },
    negativeTests: { allRejected: allNegativeRejected, cases: negativeCases },
    positivePath: {
      pass: positivePass,
      resolvedTestbedPython: positive.resolvedTestbedPython,
      metadata: positive.metadata,
      warnings: positive.prefixGuard?.warnings ?? [],
    },
    driftSimulation: { allPass: driftSimAllPass, ...driftSim },
  },
  // The guard MECHANICS are ready (negatives reject, positive passes, drift works) but the
  // real BASE prefix is still contaminated, so live validation must stay PAUSED.
  guardMechanicsReady: allNegativeRejected && positivePass && driftSimAllPass,
  environmentSafeForLiveRuns: !baseContaminated,
  recommendation: baseContaminated
    ? "repair base/dev prefix manually before live work; keep Stage 5 live runs paused"
    : "proceed to M88 larger guarded validation",
};

writeFileSync(join(OUT, "stage5_m87_env_audit.json"), JSON.stringify(auditJson, null, 2) + "\n");
writeFileSync(join(OUT, "stage5_m87_env_guard_post_repair_readiness.json"), JSON.stringify(readinessJson, null, 2) + "\n");

// Console digest.
const lines = [
  `M87 env-guard readiness (read-only)`,
  `  base repair verified: ${!baseContaminated}  (contaminated=${baseContaminated}; mismatches=[${baseMismatches.join(",")}]; brokenImports=[${baseBroken.join(",")}])`,
  `  expected testbed prefix: ${EXPECTED}  clean=${expectedClean}`,
  `  negative tests: ${negativeCases.filter((c) => c.rejected).length}/${negativeCases.length} rejected (allRejected=${allNegativeRejected})`,
  `  positive path: pass=${positivePass}  status=${positive.metadata.stage5_env_guard_status}  py=${positive.metadata.stage5_python_prefix_verified} pip=${positive.metadata.stage5_pip_prefix_verified}`,
  `  drift simulation: allPass=${driftSimAllPass}  ${JSON.stringify(driftSim)}`,
  `  guard mechanics ready: ${readinessJson.guardMechanicsReady}`,
  `  environment safe for live runs: ${readinessJson.environmentSafeForLiveRuns}`,
  `  recommendation: ${readinessJson.recommendation}`,
];
process.stdout.write(lines.join("\n") + "\n");
