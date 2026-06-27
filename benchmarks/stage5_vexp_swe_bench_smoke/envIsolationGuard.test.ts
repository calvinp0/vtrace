import { describe, expect, test } from "bun:test";
import {
  classifyInstallCommand,
  evaluatePrefixGuard,
  classifyPackageDrift,
  summarizePrefixDrift,
  buildEnvGuardMetadata,
  parsePipPrefixFromVersionLine,
  normalizePrefix,
  looksLikeBasePrefix,
  deriveInterpreterPrefix,
  type PythonProbe,
  type PrefixGuardConfig,
  type PackageRecord,
} from "./envIsolationGuard";

// Synthetic prefixes — NONE of these are touched on disk; the pure core has no I/O.
const TESTBED = "/opt/miniconda3/envs/testbed";
const BASE = "/home/calvin/miniforge3";
const DEV = "/home/calvin/miniforge3/envs/vtrace_dev";

const BASE_CFG: PrefixGuardConfig = {
  expectedTestbedPrefix: TESTBED,
  protectedBasePrefixes: [BASE],
  protectedDevPrefixes: [DEV],
};

// A probe that is fully consistent with the expected testbed prefix.
function goodProbe(): PythonProbe {
  return {
    executable: `${TESTBED}/bin/python`,
    prefix: TESTBED,
    basePrefix: TESTBED,
    pipVersionLine: `pip 23.0 from ${TESTBED}/lib/python3.9/site-packages/pip (python 3.9)`,
    condaPrefix: TESTBED,
  };
}

describe("path + pip parsing helpers", () => {
  test("normalizePrefix strips trailing slashes and collapses separators", () => {
    expect(normalizePrefix("/a/b/")).toBe("/a/b");
    expect(normalizePrefix("/a//b///")).toBe("/a/b");
    expect(normalizePrefix(null)).toBe("");
  });

  test("parsePipPrefixFromVersionLine extracts the prefix", () => {
    expect(
      parsePipPrefixFromVersionLine("pip 25.3 from /home/calvin/miniforge3/lib/python3.12/site-packages/pip (python 3.12)"),
    ).toBe("/home/calvin/miniforge3");
    expect(parsePipPrefixFromVersionLine("garbage")).toBeNull();
    expect(parsePipPrefixFromVersionLine(null)).toBeNull();
  });

  test("looksLikeBasePrefix flags distribution base dirs", () => {
    expect(looksLikeBasePrefix("/home/calvin/miniforge3")).toBe(true);
    expect(looksLikeBasePrefix("/opt/miniconda3")).toBe(true);
    expect(looksLikeBasePrefix("/opt/miniconda3/envs/testbed")).toBe(false);
  });

  test("deriveInterpreterPrefix returns the env prefix", () => {
    expect(deriveInterpreterPrefix(`${TESTBED}/bin/python`)).toBe(TESTBED);
    expect(deriveInterpreterPrefix(`${TESTBED}/Scripts/python.exe`)).toBe(TESTBED);
    expect(deriveInterpreterPrefix("python")).toBeNull();
  });
});

describe("unsafe pip command detection", () => {
  // (1) safe absolute expected-prefix `python -m pip` command passes
  test("absolute interpreter `-m pip` is a safe form", () => {
    const k = classifyInstallCommand(`${TESTBED}/bin/python -m pip install pytest==4.0`);
    expect(k.form).toBe("abs_python_pip");
    expect(k.safeForm).toBe(true);
    expect(k.interpreter).toBe(`${TESTBED}/bin/python`);
  });

  test("conda run -p <prefix> is a safe form and records the target", () => {
    const k = classifyInstallCommand(`conda run -p ${TESTBED} python -m pip install pluggy`);
    expect(k.form).toBe("conda_run_pip");
    expect(k.safeForm).toBe(true);
    expect(k.condaRunPrefix).toBe(TESTBED);
  });

  // (2) bare pip install is rejected
  test("bare pip install is unsafe", () => {
    const k = classifyInstallCommand("pip install pytest");
    expect(k.form).toBe("bare_pip");
    expect(k.isDependencyInstall).toBe(true);
    expect(k.safeForm).toBe(false);
  });

  test("bare `python -m pip` (non-absolute) is unsafe", () => {
    const k = classifyInstallCommand("python -m pip install pytest");
    expect(k.form).toBe("bare_python_pip");
    expect(k.safeForm).toBe(false);
  });

  test("conda activate then pip install is unsafe", () => {
    const k = classifyInstallCommand("conda activate testbed && pip install pluggy==0.13.1");
    expect(k.form).toBe("conda_activate_pip");
    expect(k.safeForm).toBe(false);
  });

  test("conda install without -p/-n is unsafe", () => {
    const k = classifyInstallCommand("conda install pluggy");
    expect(k.isDependencyInstall).toBe(true);
    expect(k.safeForm).toBe(false);
  });

  test("non-install commands are ignored", () => {
    expect(classifyInstallCommand("pytest -q").isDependencyInstall).toBe(false);
    expect(classifyInstallCommand("git status").isDependencyInstall).toBe(false);
    expect(classifyInstallCommand("").isDependencyInstall).toBe(false);
  });
});

describe("prefix guard", () => {
  // (1) safe absolute expected-prefix python -m pip command passes
  test("consistent testbed probe + safe command passes all checks", () => {
    const r = evaluatePrefixGuard(goodProbe(), BASE_CFG, `${TESTBED}/bin/python -m pip install pytest`);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("pass");
    expect(r.failures).toHaveLength(0);
    expect(r.blockedCommand).toBeNull();
  });

  // (2) bare pip install is rejected
  test("bare pip install is rejected and recorded as blocked", () => {
    const r = evaluatePrefixGuard(goodProbe(), BASE_CFG, "pip install pytest");
    expect(r.ok).toBe(false);
    expect(r.status).toBe("fail");
    expect(r.blockedCommand).toBe("pip install pytest");
    expect(r.blockedCommandForm).toBe("bare_pip");
  });

  // (3) python -m pip with wrong sys.prefix is rejected
  test("wrong sys.prefix (points at base) is rejected", () => {
    const probe: PythonProbe = {
      executable: `${BASE}/bin/python`,
      prefix: BASE,
      basePrefix: BASE,
      pipVersionLine: `pip 25.3 from ${BASE}/lib/python3.12/site-packages/pip (python 3.12)`,
      condaPrefix: BASE,
    };
    const r = evaluatePrefixGuard(probe, BASE_CFG);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.startsWith("sys_prefix_matches"))).toBe(true);
    expect(r.failures.some((f) => f.startsWith("actual_prefix_not_protected_base"))).toBe(true);
  });

  // (4) conda base prefix is rejected as install target
  test("conda base prefix configured as expected is rejected", () => {
    const cfg: PrefixGuardConfig = { ...BASE_CFG, expectedTestbedPrefix: BASE };
    const probe: PythonProbe = {
      executable: `${BASE}/bin/python`,
      prefix: BASE,
      basePrefix: BASE,
      pipVersionLine: `pip 25.3 from ${BASE}/lib/python3.12/site-packages/pip (python 3.12)`,
      condaPrefix: BASE,
    };
    const r = evaluatePrefixGuard(probe, cfg);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.startsWith("expected_not_protected_base"))).toBe(true);
    expect(r.failures.some((f) => f.startsWith("expected_not_home_base"))).toBe(true);
  });

  // (5) active VTRACE/dev prefix is rejected as install target
  test("active dev prefix configured as expected is rejected", () => {
    const cfg: PrefixGuardConfig = { ...BASE_CFG, expectedTestbedPrefix: DEV };
    const probe: PythonProbe = {
      executable: `${DEV}/bin/python`,
      prefix: DEV,
      basePrefix: BASE,
      pipVersionLine: `pip 25.3 from ${DEV}/lib/python3.12/site-packages/pip (python 3.12)`,
      condaPrefix: DEV,
    };
    const r = evaluatePrefixGuard(probe, cfg);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.startsWith("expected_not_dev"))).toBe(true);
  });

  // (6) missing expected prefix fails closed
  test("missing expected prefix fails closed", () => {
    const cfg: PrefixGuardConfig = { ...BASE_CFG, expectedTestbedPrefix: "" };
    const r = evaluatePrefixGuard(goodProbe(), cfg);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("fail");
    expect(r.failures.some((f) => f.startsWith("expected_prefix_configured"))).toBe(true);
  });

  // (7) pip -V mismatch fails closed
  test("pip -V reporting a different prefix fails closed", () => {
    const probe: PythonProbe = {
      ...goodProbe(),
      pipVersionLine: `pip 25.3 from ${BASE}/lib/python3.12/site-packages/pip (python 3.12)`,
    };
    const r = evaluatePrefixGuard(probe, BASE_CFG);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.startsWith("pip_prefix_matches"))).toBe(true);
  });

  // (8) CONDA_PREFIX mismatch is reported (tolerated when abs interpreter verified)
  test("CONDA_PREFIX mismatch is tolerated-with-warning when abs interpreter verified", () => {
    const probe: PythonProbe = { ...goodProbe(), condaPrefix: BASE };
    const r = evaluatePrefixGuard(probe, BASE_CFG);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("CONDA_PREFIX"))).toBe(true);
    expect(r.checks.find((c) => c.id === "conda_prefix_consistent")?.ok).toBe(true);
  });

  test("CONDA_PREFIX mismatch fails when requireCondaPrefixMatch is set", () => {
    const probe: PythonProbe = { ...goodProbe(), condaPrefix: BASE };
    const r = evaluatePrefixGuard(probe, { ...BASE_CFG, requireCondaPrefixMatch: true });
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.startsWith("conda_prefix_consistent"))).toBe(true);
  });
});

describe("drift checker", () => {
  function rec(over: Partial<PackageRecord>): PackageRecord {
    return {
      prefix: BASE,
      pythonExecutable: `${BASE}/bin/python`,
      package: "pluggy",
      condaVersion: null,
      pipVersion: null,
      importedVersion: null,
      importedFile: null,
      importedMtimeMs: null,
      ...over,
    };
  }

  // (9) detects pip/conda version mismatch using synthetic package records
  test("detects pip/conda version mismatch", () => {
    const d = classifyPackageDrift(rec({ condaVersion: "0.13.1", pipVersion: "1.6.0", importedVersion: "1.6.0" }));
    expect(d.status).toBe("pip_conda_mismatch");
    expect(d.detail).toContain("0.13.1");
  });

  // (10) detects changed package file mtime
  test("detects changed package file mtime during run", () => {
    const before = rec({ condaVersion: "1.6.0", pipVersion: "1.6.0", importedVersion: "1.6.0", importedMtimeMs: 1000 });
    const after = rec({ condaVersion: "1.6.0", pipVersion: "1.6.0", importedVersion: "1.6.0", importedMtimeMs: 2000 });
    const d = classifyPackageDrift(before, after);
    expect(d.status).toBe("changed_during_run");
  });

  // (11) reports ok for stable matching records
  test("reports ok for stable matching records", () => {
    const before = rec({ condaVersion: "1.6.0", pipVersion: "1.6.0", importedVersion: "1.6.0", importedMtimeMs: 1000 });
    const after = rec({ condaVersion: "1.6.0", pipVersion: "1.6.0", importedVersion: "1.6.0", importedMtimeMs: 1000 });
    expect(classifyPackageDrift(before, after).status).toBe("ok");
    expect(classifyPackageDrift(before).status).toBe("ok");
  });

  test("reports missing when no data present", () => {
    expect(classifyPackageDrift(rec({ package: "wheel" })).status).toBe("missing");
  });

  test("summary flags a safety failure when a protected base prefix changes", () => {
    const before = rec({ condaVersion: "1.6.0", pipVersion: "1.6.0", importedVersion: "1.6.0", importedMtimeMs: 1000 });
    const after = rec({ condaVersion: "1.6.0", pipVersion: "0.13.1", importedVersion: "0.13.1", importedMtimeMs: 2000 });
    const summary = summarizePrefixDrift([{ prefix: BASE, role: "base", records: [{ before, after }] }]);
    expect(summary.safetyFailed).toBe(true);
    expect(summary.changedCount).toBe(1);
    expect(summary.overallStatus).toBe("changed_during_run");
  });

  test("summary does not flag a safety failure for a testbed prefix change", () => {
    const before = rec({ prefix: TESTBED, condaVersion: "1.6.0", importedVersion: "1.6.0", importedMtimeMs: 1000 });
    const after = rec({ prefix: TESTBED, condaVersion: "1.6.0", importedVersion: "1.6.0", importedMtimeMs: 2000 });
    const summary = summarizePrefixDrift([{ prefix: TESTBED, role: "testbed", records: [{ before, after }] }]);
    expect(summary.safetyFailed).toBe(false);
    expect(summary.changedCount).toBe(1);
  });
});

describe("metadata builder", () => {
  // (13) metadata includes pass/fail status
  test("emits pass status with verified prefixes when guard passes", () => {
    const pg = evaluatePrefixGuard(goodProbe(), BASE_CFG);
    const meta = buildEnvGuardMetadata({
      enabled: true,
      expectedTestbedPrefix: TESTBED,
      prefixGuard: pg,
      driftCheckEnabled: false,
      drift: null,
      dependencyInstallCommandsChecked: 0,
      blockedUnsafePipCommandCount: 0,
    });
    expect(meta.stage5_env_guard_status).toBe("pass");
    expect(meta.stage5_python_prefix_verified).toBe(true);
    expect(meta.stage5_pip_prefix_verified).toBe(true);
    expect(meta.stage5_env_guard_enabled).toBe(true);
  });

  test("emits fail status when prefix guard fails", () => {
    const pg = evaluatePrefixGuard(goodProbe(), BASE_CFG, "pip install pytest");
    const meta = buildEnvGuardMetadata({
      enabled: true,
      expectedTestbedPrefix: TESTBED,
      prefixGuard: pg,
      driftCheckEnabled: false,
      drift: null,
      dependencyInstallCommandsChecked: 1,
      blockedUnsafePipCommandCount: 1,
    });
    expect(meta.stage5_env_guard_status).toBe("fail");
    expect(meta.stage5_blocked_unsafe_pip_command_count).toBe(1);
    expect(meta.stage5_prefix_guard_failures.length).toBeGreaterThan(0);
  });

  // (15) default path: guard disabled ⇒ not_applicable, nothing else changes
  test("disabled guard reports not_applicable", () => {
    const meta = buildEnvGuardMetadata({
      enabled: false,
      expectedTestbedPrefix: null,
      prefixGuard: null,
      driftCheckEnabled: false,
      drift: null,
      dependencyInstallCommandsChecked: 0,
      blockedUnsafePipCommandCount: 0,
    });
    expect(meta.stage5_env_guard_status).toBe("not_applicable");
    expect(meta.stage5_env_guard_enabled).toBe(false);
    expect(meta.stage5_python_prefix_verified).toBe(false);
  });

  test("safety-failed drift forces fail status even if prefix guard passed", () => {
    const pg = evaluatePrefixGuard(goodProbe(), BASE_CFG);
    const before: PackageRecord = {
      prefix: BASE, pythonExecutable: `${BASE}/bin/python`, package: "pytest",
      condaVersion: "9.0", pipVersion: "9.0", importedVersion: "9.0", importedFile: null, importedMtimeMs: 1,
    };
    const after = { ...before, importedMtimeMs: 2 };
    const drift = summarizePrefixDrift([{ prefix: BASE, role: "base", records: [{ before, after }] }]);
    const meta = buildEnvGuardMetadata({
      enabled: true, expectedTestbedPrefix: TESTBED, prefixGuard: pg,
      driftCheckEnabled: true, drift, dependencyInstallCommandsChecked: 0, blockedUnsafePipCommandCount: 0,
    });
    expect(meta.stage5_env_guard_status).toBe("fail");
    expect(meta.stage5_prefix_drift_summary).toContain("SAFETY_FAILED");
  });

  // (14) no full environment dump is emitted — metadata shape is a small fixed key set
  test("metadata is a compact fixed key set (no env dump)", () => {
    const meta = buildEnvGuardMetadata({
      enabled: true, expectedTestbedPrefix: TESTBED,
      prefixGuard: evaluatePrefixGuard(goodProbe(), BASE_CFG),
      driftCheckEnabled: false, drift: null, dependencyInstallCommandsChecked: 0, blockedUnsafePipCommandCount: 0,
    });
    const keys = Object.keys(meta).sort();
    expect(keys).toEqual([
      "stage5_blocked_unsafe_pip_command_count",
      "stage5_dependency_install_commands_checked",
      "stage5_drift_check_enabled",
      "stage5_env_guard_enabled",
      "stage5_env_guard_status",
      "stage5_expected_testbed_prefix",
      "stage5_pip_prefix_verified",
      "stage5_prefix_drift_summary",
      "stage5_prefix_guard_failures",
      "stage5_python_prefix_verified",
    ]);
    // No giant strings.
    expect(JSON.stringify(meta).length).toBeLessThan(2000);
  });
});
