import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  runStage5EnvGuardPreflight,
  deriveCondaBasePrefix,
  resolveExpectedTestbedPrefix,
  evaluateMandatoryLiveEnvGuard,
  STAGE5_ENV_GUARD_MANDATORY_SINCE,
  STAGE5_EXPECTED_TESTBED_PREFIX_ENV,
  EXPECTED_PREFIX_FIX_MESSAGE,
  type Stage5EnvGuardOptions,
  type MandatoryLiveEnvGuardInput,
} from "./stage5EnvGuardIntegration";
import { buildEnvGuardMetadata, type PythonProbe } from "./envIsolationGuard";

const BASE = "/home/calvin/miniforge3";
const TESTBED = "/home/calvin/miniforge3/envs/vexp_swebench";

function probeFor(prefix: string, pipPrefix = prefix): PythonProbe {
  return {
    executable: `${prefix}/bin/python`,
    prefix,
    basePrefix: prefix,
    pipVersionLine: `pip 26.1 from ${pipPrefix}/lib/python3.12/site-packages/pip (python 3.12)`,
    condaPrefix: BASE, // active shell is base — tolerated when abs interpreter verified
  };
}

const baseOpts = (over: Partial<Stage5EnvGuardOptions>): Stage5EnvGuardOptions => ({
  enabled: true,
  driftCheckEnabled: false,
  expectedTestbedPrefix: TESTBED,
  vexpSweBenchDir: "/home/calvin/code/vexp-swe-bench",
  shellCondaPrefix: BASE,
  existsFn: (p) => p === `${TESTBED}/bin/python`,
  probeFn: (py) => (py === `${TESTBED}/bin/python` ? probeFor(TESTBED) : null),
  ...over,
});

describe("deriveCondaBasePrefix", () => {
  test("strips /envs/<name>", () => {
    expect(deriveCondaBasePrefix(`${BASE}/envs/vexp_swebench`)).toBe(BASE);
    expect(deriveCondaBasePrefix(BASE)).toBe(BASE);
    expect(deriveCondaBasePrefix(null)).toBeNull();
  });
});

describe("stage5 env guard preflight", () => {
  // (15) default path: disabled ⇒ ok, not_applicable, no behavior change
  test("disabled guard returns ok and not_applicable", () => {
    const r = runStage5EnvGuardPreflight(baseOpts({ enabled: false }));
    expect(r.ok).toBe(true);
    expect(r.metadata.stage5_env_guard_status).toBe("not_applicable");
    expect(r.prefixGuard).toBeNull();
  });

  test("enabled + clean testbed interpreter passes", () => {
    const r = runStage5EnvGuardPreflight(baseOpts({}));
    expect(r.ok).toBe(true);
    expect(r.metadata.stage5_env_guard_status).toBe("pass");
    expect(r.resolvedTestbedPython).toBe(`${TESTBED}/bin/python`);
    expect(r.metadata.stage5_python_prefix_verified).toBe(true);
  });

  // (6) missing expected prefix fails closed
  test("missing expected prefix fails closed", () => {
    const r = runStage5EnvGuardPreflight(baseOpts({ expectedTestbedPrefix: null }));
    expect(r.ok).toBe(false);
    expect(r.failClosedReason).toContain("expected-testbed-prefix");
    expect(r.metadata.stage5_env_guard_status).toBe("fail");
  });

  test("interpreter resolving to base is rejected (contamination vector)", () => {
    const r = runStage5EnvGuardPreflight(
      baseOpts({
        expectedTestbedPrefix: TESTBED,
        existsFn: (p) => p === `${TESTBED}/bin/python`,
        // The resolved interpreter lies and actually reports base — guard must catch it.
        probeFn: () => probeFor(BASE),
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.metadata.stage5_env_guard_status).toBe("fail");
  });

  test("interpreter not found fails closed", () => {
    const r = runStage5EnvGuardPreflight(baseOpts({ existsFn: () => false }));
    expect(r.ok).toBe(false);
    expect(r.failClosedReason).toContain("not found");
  });

  test("unsafe candidate command is counted as blocked", () => {
    const r = runStage5EnvGuardPreflight(baseOpts({ candidateCommand: "pip install pytest" }));
    expect(r.metadata.stage5_blocked_unsafe_pip_command_count).toBe(1);
    expect(r.metadata.stage5_dependency_install_commands_checked).toBe(1);
    expect(r.ok).toBe(false);
  });

  test("safe candidate command does not block", () => {
    const r = runStage5EnvGuardPreflight(baseOpts({ candidateCommand: `${TESTBED}/bin/python -m pip install pytest` }));
    expect(r.metadata.stage5_blocked_unsafe_pip_command_count).toBe(0);
    expect(r.metadata.stage5_dependency_install_commands_checked).toBe(1);
    expect(r.ok).toBe(true);
  });
});

// =====================================================================================
// M89 — mandatory env guard for live agent runs (pure policy + prefix resolution).
// =====================================================================================

describe("M89 resolveExpectedTestbedPrefix", () => {
  test("CLI flag wins (source=cli)", () => {
    const r = resolveExpectedTestbedPrefix({ cliPrefix: TESTBED, envValue: "/other/env" });
    expect(r.prefix).toBe(TESTBED);
    expect(r.source).toBe("cli");
  });
  test("env var used when no CLI flag (source=env)", () => {
    const r = resolveExpectedTestbedPrefix({ cliPrefix: null, envValue: TESTBED });
    expect(r.prefix).toBe(TESTBED);
    expect(r.source).toBe("env");
  });
  test("neither configured ⇒ null/none (fail closed for live)", () => {
    const r = resolveExpectedTestbedPrefix({ cliPrefix: null, envValue: null });
    expect(r.prefix).toBeNull();
    expect(r.source).toBe("none");
  });
  test("blank values are ignored (treated as unset)", () => {
    const r = resolveExpectedTestbedPrefix({ cliPrefix: "  ", envValue: "" });
    expect(r.source).toBe("none");
  });
});

describe("M89 evaluateMandatoryLiveEnvGuard", () => {
  const live = (over: Partial<MandatoryLiveEnvGuardInput>): MandatoryLiveEnvGuardInput => ({
    isLiveAgentRun: true,
    allowUnguardedLiveEnv: false,
    envGuardEnabled: true,
    driftCheckEnabled: true,
    resolvedExpectedPrefix: TESTBED,
    expectedPrefixSource: "cli",
    preflightOk: true,
    preflightStatus: "pass",
    preflightFailureReason: null,
    ...over,
  });

  // (1) live run without env guard fails closed
  test("missing env guard fails closed", () => {
    const d = evaluateMandatoryLiveEnvGuard(live({ envGuardEnabled: false }));
    expect(d.failClosed).toBe(true);
    expect(d.proceed).toBe(false);
    expect(d.required).toBe(true);
    expect(d.fixInstructions).toContain("--stage5-env-guard");
  });

  // (2) live run without drift check fails closed
  test("missing drift check fails closed", () => {
    const d = evaluateMandatoryLiveEnvGuard(live({ driftCheckEnabled: false }));
    expect(d.failClosed).toBe(true);
    expect(d.fixInstructions).toContain("--stage5-env-drift-check");
  });

  // (3) live run without expected prefix fails closed with clear fix instructions
  test("missing expected prefix fails closed with fix instructions", () => {
    const d = evaluateMandatoryLiveEnvGuard(live({ resolvedExpectedPrefix: null, expectedPrefixSource: "none" }));
    expect(d.failClosed).toBe(true);
    expect(d.fixInstructions).toBe(EXPECTED_PREFIX_FIX_MESSAGE);
    expect(d.fixInstructions).toContain("--expected-testbed-prefix");
    expect(d.fixInstructions).toContain(STAGE5_EXPECTED_TESTBED_PREFIX_ENV);
  });

  // (8/9/10) preflight not passing fails closed (wrong prefix / pip mismatch / base target)
  test("preflight failure fails closed", () => {
    const d = evaluateMandatoryLiveEnvGuard(
      live({ preflightOk: false, preflightStatus: "fail", preflightFailureReason: "sys.prefix != expected" }),
    );
    expect(d.failClosed).toBe(true);
    expect(d.reason).toContain("did not pass");
  });

  // (4/5) clean guarded pass proceeds and is benchmark-valid
  test("clean guarded pass proceeds and is benchmark-valid", () => {
    const d = evaluateMandatoryLiveEnvGuard(live({}));
    expect(d.proceed).toBe(true);
    expect(d.failClosed).toBe(false);
    expect(d.benchmarkValid).toBe(true);
    expect(d.bypassed).toBe(false);
  });

  // (6) offline / non-live mode does not require the env guard
  test("non-live run is not required and proceeds", () => {
    const d = evaluateMandatoryLiveEnvGuard(live({ isLiveAgentRun: false, envGuardEnabled: false }));
    expect(d.proceed).toBe(true);
    expect(d.required).toBe(false);
    expect(d.failClosed).toBe(false);
  });

  // (13) escape hatch proceeds but is NEVER benchmark-valid
  test("escape hatch proceeds but is never benchmark-valid", () => {
    const d = evaluateMandatoryLiveEnvGuard(live({ allowUnguardedLiveEnv: true, envGuardEnabled: false }));
    expect(d.proceed).toBe(true);
    expect(d.bypassed).toBe(true);
    expect(d.benchmarkValid).toBe(false);
    expect(d.required).toBe(true);
  });
});

describe("M89 env guard metadata", () => {
  // (11/12) required + mandatory-since recorded for live runs
  test("required live metadata records required=true and mandatory-since=M89", () => {
    const m = buildEnvGuardMetadata({
      enabled: true,
      expectedTestbedPrefix: TESTBED,
      prefixGuard: null,
      driftCheckEnabled: true,
      drift: null,
      dependencyInstallCommandsChecked: 0,
      blockedUnsafePipCommandCount: 0,
      notApplicableReason: "preflight",
      required: true,
      mandatorySince: STAGE5_ENV_GUARD_MANDATORY_SINCE,
      expectedPrefixSource: "cli",
    });
    expect(m.stage5_env_guard_required).toBe(true);
    expect(m.stage5_env_guard_mandatory_since).toBe("M89");
    expect(m.stage5_expected_testbed_prefix_source).toBe("cli");
  });

  // a required-but-disabled live run is recorded as a failure, not "not_applicable"
  test("required + disabled records status=fail", () => {
    const m = buildEnvGuardMetadata({
      enabled: false,
      expectedTestbedPrefix: null,
      prefixGuard: null,
      driftCheckEnabled: false,
      drift: null,
      dependencyInstallCommandsChecked: 0,
      blockedUnsafePipCommandCount: 0,
      required: true,
    });
    expect(m.stage5_env_guard_status).toBe("fail");
    expect(m.stage5_env_guard_required).toBe(true);
    expect(m.stage5_env_guard_benchmark_valid).toBe(false);
  });

  // offline / non-required ⇒ required=false, not_applicable
  test("non-required disabled records not_applicable", () => {
    const m = buildEnvGuardMetadata({
      enabled: false,
      expectedTestbedPrefix: null,
      prefixGuard: null,
      driftCheckEnabled: false,
      drift: null,
      dependencyInstallCommandsChecked: 0,
      blockedUnsafePipCommandCount: 0,
      notApplicableReason: "disabled",
    });
    expect(m.stage5_env_guard_required).toBe(false);
    expect(m.stage5_env_guard_mandatory_since).toBeNull();
    expect(m.stage5_env_guard_status).toBe("not_applicable");
  });

  // (13) bypass (escape hatch) ⇒ never benchmark-valid in metadata
  test("escape hatch metadata is never benchmark-valid", () => {
    const m = buildEnvGuardMetadata({
      enabled: true,
      expectedTestbedPrefix: TESTBED,
      prefixGuard: null,
      driftCheckEnabled: true,
      drift: null,
      dependencyInstallCommandsChecked: 0,
      blockedUnsafePipCommandCount: 0,
      notApplicableReason: "bypass",
      required: true,
      unguardedLiveEnvAllowed: true,
    });
    expect(m.stage5_unguarded_live_env_allowed).toBe(true);
    expect(m.stage5_env_guard_benchmark_valid).toBe(false);
  });

  // (15) metadata stays compact — no full environment dump (bounded, known key set).
  test("metadata is compact (no full environment dump)", () => {
    const m = buildEnvGuardMetadata({
      enabled: true,
      expectedTestbedPrefix: TESTBED,
      prefixGuard: null,
      driftCheckEnabled: true,
      drift: null,
      dependencyInstallCommandsChecked: 0,
      blockedUnsafePipCommandCount: 0,
      notApplicableReason: "x",
      required: true,
    });
    const keys = Object.keys(m);
    // A small, fixed metadata surface — never a `conda list` / pip freeze dump.
    expect(keys.length).toBeLessThanOrEqual(20);
    expect(keys.some((k) => /packages|conda_list|pip_freeze|environment_dump|site_packages/i.test(k))).toBe(false);
    const serialized = JSON.stringify(m);
    expect(serialized.length).toBeLessThan(2000);
  });
});

// (14) the future live driver template ships with the mandatory env-guard flags.
describe("M89 driver templates carry the env guard flags", () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  for (const tmpl of ["run_stage5_m88_driver.template.sh", "run_stage5_m90_driver.template.sh"]) {
    test(`${tmpl} includes --stage5-env-guard, --stage5-env-drift-check, --expected-testbed-prefix`, () => {
      const p = path.join(here, tmpl);
      expect(fs.existsSync(p)).toBe(true);
      const text = fs.readFileSync(p, "utf8");
      expect(text).toContain("--stage5-env-guard");
      expect(text).toContain("--stage5-env-drift-check");
      expect(text).toContain("--expected-testbed-prefix");
      // The escape hatch must NEVER appear in a driver template.
      expect(text).not.toContain("--allow-unguarded-live-env");
    });
  }
});
