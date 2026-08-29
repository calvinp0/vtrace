// M187 — the agent-shell guard must survive the external harness's own start-up.
//
// THE DEFECT THIS PINS. The M90A firewall was materialized into `rawConditionDir`, which the
// runner also passes to the external harness as `--output`. `vexp-swe-bench`'s orchestrator
// opens every fresh run with `cleanPreviousRun(outputDir)`, which `rmSync`s each entry there.
// All 60 M183 arms logged `⚠ Cleaned 1 file(s) from <rawDir>/` — that one entry was the
// wrapper bin. The agent then ran with the guard's PATH (conda stripped: no `pip`, no testbed
// interpreter) and none of the guard's wrappers, so `python` fell through to a bare system
// interpreter with no packages, `pip` was simply absent, and zero commands were ever blocked.
//
// The suite below reproduces the harness's cleaner against BOTH arrangements. The control
// matters as much as the assertion: if the simulated wipe cannot destroy the old layout, it
// is not exercising the failure and the new layout's survival proves nothing.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { materializeAgentShellGuard } from "./stage5AgentShellGuardIntegration";
import { agentShellGuardDir, rawConditionDir } from "./run_stage5_vexp_swe_bench_smoke";
import { buildAgentShellGuardMetadata } from "./agentShellGuard";

/**
 * A faithful transcription of `vexp-swe-bench/src/harness/orchestrator.ts::cleanPreviousRun`.
 * Copied rather than imported because the external harness is not a dependency of this repo;
 * if it ever changes shape this fixture is the thing that should be updated to match.
 */
function cleanPreviousRun(dir: string): number {
  if (!existsSync(dir)) return 0;
  const files = readdirSync(dir).filter((f) => f !== ".gitkeep");
  for (const f of files) rmSync(path.join(dir, f), { recursive: true, force: true });
  return files.length;
}

const TESTBED = "/home/calvin/miniforge3/envs/vexp_swebench";

describe("the guard directory is disjoint from the harness output directory", () => {
  test("agentShellGuardDir is not inside rawConditionDir, for labelled and unlabelled runs", () => {
    for (const label of ["m187_probe", null] as const) {
      const out = "/tmp/results";
      const raw = rawConditionDir(out, "baseline", label);
      const guard = agentShellGuardDir(out, "baseline", label);
      expect(guard.startsWith(`${raw}${path.sep}`)).toBe(false);
      expect(guard).not.toBe(raw);
    }
  });

  test("two conditions under one run label get separate guard directories", () => {
    expect(agentShellGuardDir("/tmp/results", "baseline", "L")).not.toBe(
      agentShellGuardDir("/tmp/results", "vtrace", "L"),
    );
  });
});

describe("survival across the harness's clean-on-start", () => {
  test("CONTROL — the pre-M187 layout IS destroyed by the harness cleaner", () => {
    const out = mkdtempSync(path.join(tmpdir(), "m187-control-"));
    try {
      const raw = rawConditionDir(out, "baseline", "L");
      mkdirSync(raw, { recursive: true });
      // Exactly what M183 did: materialize into the directory handed to the harness.
      const mat = materializeAgentShellGuard({ runDir: raw, expectedTestbedPrefix: TESTBED });
      expect(mat.wrapperBinReady).toBe(true);
      expect(existsSync(path.join(mat.wrapperBin, "python"))).toBe(true);

      const cleaned = cleanPreviousRun(raw);

      // The observed M183 signature, reproduced: exactly one entry removed, and it was the guard.
      expect(cleaned).toBe(1);
      expect(existsSync(mat.wrapperBin)).toBe(false);
      expect(existsSync(path.join(mat.wrapperBin, "python"))).toBe(false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("the M187 layout survives the same cleaner", () => {
    const out = mkdtempSync(path.join(tmpdir(), "m187-repair-"));
    try {
      const raw = rawConditionDir(out, "baseline", "L");
      mkdirSync(raw, { recursive: true });
      const mat = materializeAgentShellGuard({
        runDir: agentShellGuardDir(out, "baseline", "L"),
        expectedTestbedPrefix: TESTBED,
      });
      expect(mat.wrapperBinReady).toBe(true);

      // The harness also writes its result rows into raw/, so give it something to clean.
      writeFileSync(path.join(raw, "swebench-2026-01-01.jsonl"), "{}\n");
      cleanPreviousRun(raw);

      expect(existsSync(path.join(mat.wrapperBin, "python"))).toBe(true);
      expect(existsSync(path.join(mat.wrapperBin, "pip"))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("a vanished firewall is recorded, not reported as a pass", () => {
  test("survival is carried explicitly in the run metadata", () => {
    const meta = buildAgentShellGuardMetadata({
      required: true,
      enabled: true,
      hostPipFirewallEnabled: true,
      status: "pass",
      wrapperBin: "/tmp/x/_vtrace_agent_bin",
      pathSanitized: true,
      condaEnvScrubbed: true,
      pythonResolution: "wrapper → delegate",
      pipResolution: "wrapper → BLOCK",
      blockedCommands: [],
      failureReason: null,
      wrapperBinSurvivedRun: true,
    });
    expect(meta.stage5_agent_shell_guard_wrapper_bin_survived_run).toBe(true);
  });

  test("an unobserved survival stays null rather than defaulting to true", () => {
    const meta = buildAgentShellGuardMetadata({
      required: true,
      enabled: true,
      hostPipFirewallEnabled: true,
      status: "pass",
      wrapperBin: null,
      pathSanitized: false,
      condaEnvScrubbed: false,
      pythonResolution: null,
      pipResolution: null,
      blockedCommands: [],
      failureReason: null,
    });
    expect(meta.stage5_agent_shell_guard_wrapper_bin_survived_run).toBeNull();
  });
});
