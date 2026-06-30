import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, accessSync, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  materializeAgentShellGuard,
  readBlockedCommandLog,
  resolveWrapperDelegates,
  AGENT_WRAPPER_BIN_DIRNAME,
} from "./stage5AgentShellGuardIntegration";
import { AGENT_WRAPPER_NAMES, AGENT_SHELL_GUARD_BLOCK_EXIT } from "./agentShellGuard";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "m90a-it-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function isExec(abs: string): boolean {
  try {
    accessSync(abs, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

describe("resolveWrapperDelegates", () => {
  test("prefers the expected testbed bin/python when it exists", () => {
    const d = resolveWrapperDelegates({
      originalPath: "/usr/bin",
      expectedTestbedPrefix: "/tb",
      isExecutable: () => false,
      exists: (p) => p === "/tb/bin/python",
    });
    expect(d.delegatePython).toBe("/tb/bin/python");
  });

  test("falls back to a PATH python when no testbed", () => {
    const d = resolveWrapperDelegates({
      originalPath: "/usr/bin",
      expectedTestbedPrefix: null,
      isExecutable: (p) => p === "/usr/bin/python3",
      exists: () => false,
    });
    expect(d.delegatePython).toBe("/usr/bin/python3");
  });
});

describe("materializeAgentShellGuard (real fs, temp dir)", () => {
  test("writes an executable wrapper bin with sanitized env", () => {
    const runDir = path.join(tmp, "run-materialize");
    const r = materializeAgentShellGuard({
      runDir,
      originalPath: "/home/calvin/miniforge3/bin:/usr/bin",
      processEnv: { CONDA_PREFIX: "/home/calvin/miniforge3" },
      expectedTestbedPrefix: null,
    });
    expect(r.wrapperBinReady).toBe(true);
    expect(r.failureReason).toBeNull();
    expect(r.wrapperBin.endsWith(AGENT_WRAPPER_BIN_DIRNAME)).toBe(true);
    // Wrapper bin first on the sanitized PATH; base miniforge removed.
    const entries = r.shellEnv.sanitizedPath.split(":");
    expect(entries[0]).toBe(r.wrapperBin);
    expect(entries).not.toContain("/home/calvin/miniforge3/bin");
    expect(r.shellEnv.pathSanitized).toBe(true);
    expect(r.shellEnv.condaEnvScrubbed).toBe(true);
    // Every wrapper exists and is executable.
    for (const name of AGENT_WRAPPER_NAMES) {
      expect(isExec(path.join(r.wrapperBin, name))).toBe(true);
    }
  });
});

describe("wrapper firewall behavior (invokes the real wrappers)", () => {
  // Materialize once, then run dangerous + harmless commands through the guarded shell.
  let wrapperBin: string;
  let blockLogPath: string;
  let env: Record<string, string>;

  beforeAll(() => {
    const runDir = path.join(tmp, "run-invoke");
    const r = materializeAgentShellGuard({ runDir, expectedTestbedPrefix: null });
    wrapperBin = r.wrapperBin;
    blockLogPath = r.blockLogPath;
    env = { ...process.env, ...r.shellEnv.overrides } as Record<string, string>;
  });

  const run = (cmd: string) => spawnSync("bash", ["-lc", cmd], { env, encoding: "utf8" });

  const blocked: Array<[string, string]> = [
    ["pip install -e .", "VTRACE_HOST_PIP_BLOCKED"],
    ["pip install pluggy==0.13.1", "VTRACE_HOST_PIP_BLOCKED"],
    ["python -m pip install -e .", "VTRACE_HOST_PIP_BLOCKED"],
    ["python3 -m pip install -e .", "VTRACE_HOST_PIP_BLOCKED"],
    ["conda install pluggy=0.13.1", "VTRACE_HOST_CONDA_BLOCKED"],
    ["conda update --all", "VTRACE_HOST_CONDA_BLOCKED"],
    ["uv pip install -e .", "VTRACE_HOST_PACKAGE_MANAGER_BLOCKED"],
    ["poetry add pluggy", "VTRACE_HOST_PACKAGE_MANAGER_BLOCKED"],
    ["pipx install pytest", "VTRACE_HOST_PACKAGE_MANAGER_BLOCKED"],
  ];

  for (const [cmd, marker] of blocked) {
    test(`blocks: ${cmd}`, () => {
      const p = run(cmd);
      expect(p.status).toBe(AGENT_SHELL_GUARD_BLOCK_EXIT);
      expect(`${p.stdout}${p.stderr}`).toContain(marker);
    });
  }

  test("which pip resolves to the VTRACE wrapper, not host/base pip", () => {
    const p = run("which pip");
    expect(p.stdout.trim()).toBe(path.join(wrapperBin, "pip"));
  });

  test("which python resolves to the VTRACE wrapper", () => {
    const p = run("which python");
    expect(p.stdout.trim()).toBe(path.join(wrapperBin, "python"));
  });

  test("harmless python still executes", () => {
    const p = run("python - <<'PY'\nprint('hello-m90a')\nPY");
    expect(p.status).toBe(0);
    expect(p.stdout).toContain("hello-m90a");
  });

  test("every blocked attempt is recorded in the block log", () => {
    const rows = readBlockedCommandLog(blockLogPath);
    // At least one record per tool family we exercised above.
    const markers = new Set(rows.map((r) => r.marker));
    expect(markers.has("VTRACE_HOST_PIP_BLOCKED")).toBe(true);
    expect(markers.has("VTRACE_HOST_CONDA_BLOCKED")).toBe(true);
    expect(markers.has("VTRACE_HOST_PACKAGE_MANAGER_BLOCKED")).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(blocked.length);
  });
});

describe("wrapperBinReady is false when a wrapper cannot be made executable", () => {
  test("non-executable write ⇒ not ready + failure reason", () => {
    const r = materializeAgentShellGuard({
      runDir: path.join(tmp, "run-notready"),
      originalPath: "/usr/bin",
      processEnv: {},
      expectedTestbedPrefix: null,
      mkdir: () => {},
      writeWrapper: () => {}, // pretend to write, but nothing lands
      isExecutable: () => false, // verification fails
      exists: () => false,
    });
    expect(r.wrapperBinReady).toBe(false);
    expect(r.failureReason).toMatch(/not executable/);
  });
});
