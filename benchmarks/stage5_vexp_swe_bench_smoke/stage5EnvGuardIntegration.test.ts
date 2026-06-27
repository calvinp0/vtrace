import { describe, expect, test } from "bun:test";
import {
  runStage5EnvGuardPreflight,
  deriveCondaBasePrefix,
  type Stage5EnvGuardOptions,
} from "./stage5EnvGuardIntegration";
import type { PythonProbe } from "./envIsolationGuard";

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
