import { describe, expect, test } from "bun:test";
import {
  isCondaPathEntry,
  sanitizeAgentPath,
  scrubAgentCondaEnv,
  buildAgentShellEnv,
  resolveOnPath,
  evaluateMandatoryAgentShellGuard,
  parseBlockedCommandLog,
  buildAgentShellGuardMetadata,
  buildAllWrapperScripts,
  pythonWrapperScript,
  pipWrapperScript,
  SCRUBBED_ENV_KEYS,
  AGENT_WRAPPER_NAMES,
  STAGE5_AGENT_SHELL_GUARD_MANDATORY_SINCE,
  BLOCK_MARKER_PIP,
  BLOCK_MARKER_CONDA,
  BLOCK_MARKER_PKG_MANAGER,
  type WrapperDelegates,
} from "./agentShellGuard";

const WRAPPER = "/run/raw/baseline/_vtrace_agent_bin";
const DELEGATES: WrapperDelegates = {
  delegatePython: "/home/calvin/miniforge3/envs/vexp_swebench/bin/python",
  realConda: "/home/calvin/miniforge3/condabin/conda",
  realUv: null,
  realPoetry: null,
  realPipx: null,
};

describe("isCondaPathEntry", () => {
  test("matches base/condabin/env bins, not system dirs", () => {
    expect(isCondaPathEntry("/home/calvin/miniforge3/bin")).toBe(true);
    expect(isCondaPathEntry("/home/calvin/miniforge3/condabin")).toBe(true);
    expect(isCondaPathEntry("/home/calvin/miniforge3/envs/vexp_swebench/bin")).toBe(true);
    expect(isCondaPathEntry("/opt/anaconda3/bin")).toBe(true);
    expect(isCondaPathEntry("/usr/bin")).toBe(false);
    expect(isCondaPathEntry("/home/calvin/.local/bin")).toBe(false);
  });
});

describe("sanitizeAgentPath", () => {
  test("removes every conda entry and prepends the wrapper bin first", () => {
    const original = "/home/calvin/miniforge3/bin:/home/calvin/miniforge3/condabin:/usr/local/bin:/usr/bin";
    const r = sanitizeAgentPath(original, WRAPPER);
    const entries = r.sanitizedPath.split(":");
    expect(entries[0]).toBe(WRAPPER); // wrapper bin first
    expect(r.wrapperBinFirst).toBe(true);
    expect(entries).not.toContain("/home/calvin/miniforge3/bin");
    expect(entries).not.toContain("/home/calvin/miniforge3/condabin");
    expect(entries).toContain("/usr/local/bin");
    expect(entries).toContain("/usr/bin");
    expect(r.removedEntries).toEqual([
      "/home/calvin/miniforge3/bin",
      "/home/calvin/miniforge3/condabin",
    ]);
  });

  test("does not duplicate the wrapper bin if already present", () => {
    const r = sanitizeAgentPath(`${WRAPPER}:/usr/bin`, WRAPPER);
    expect(r.sanitizedPath.split(":").filter((e) => e === WRAPPER).length).toBe(1);
  });
});

describe("scrubAgentCondaEnv", () => {
  test("neutralizes present leakage vars and sets hardening vars", () => {
    const r = scrubAgentCondaEnv({
      CONDA_PREFIX: "/home/calvin/miniforge3",
      CONDA_DEFAULT_ENV: "base",
      VIRTUAL_ENV: "/x/.venv",
      PYTHONPATH: "/x",
    });
    for (const key of SCRUBBED_ENV_KEYS) expect(r.overrides[key]).toBe("");
    expect(r.overrides.PYTHONNOUSERSITE).toBe("1");
    expect(r.overrides.PIP_REQUIRE_VIRTUALENV).toBe("true");
    expect(r.condaEnvScrubbed).toBe(true);
    expect(r.scrubbedKeysPresent).toContain("CONDA_PREFIX");
    expect(r.scrubbedKeysPresent).toContain("VIRTUAL_ENV");
  });

  test("condaEnvScrubbed is false when nothing leaked (safe state)", () => {
    const r = scrubAgentCondaEnv({ PATH: "/usr/bin" });
    expect(r.condaEnvScrubbed).toBe(false);
    expect(r.scrubbedKeysPresent).toEqual([]);
    // hardening still applied
    expect(r.overrides.PYTHONNOUSERSITE).toBe("1");
  });
});

describe("buildAgentShellEnv", () => {
  test("composes sanitized PATH + scrub + block log", () => {
    const env = buildAgentShellEnv({
      originalPath: "/home/calvin/miniforge3/bin:/usr/bin",
      wrapperBin: WRAPPER,
      processEnv: { CONDA_PREFIX: "/home/calvin/miniforge3" },
      blockLogPath: `${WRAPPER}/_blocked.jsonl`,
    });
    expect(env.overrides.PATH.split(":")[0]).toBe(WRAPPER);
    expect(env.pathSanitized).toBe(true);
    expect(env.condaEnvScrubbed).toBe(true);
    expect(env.overrides.VTRACE_AGENT_BLOCK_LOG).toBe(`${WRAPPER}/_blocked.jsonl`);
    expect(env.removedPathEntries).toContain("/home/calvin/miniforge3/bin");
  });
});

describe("resolveOnPath", () => {
  test("returns the first executable hit on the PATH", () => {
    const exec = (abs: string) => abs === "/usr/bin/python3";
    expect(resolveOnPath("python3", "/nope:/usr/bin:/usr/local/bin", exec)).toBe("/usr/bin/python3");
    expect(resolveOnPath("python3", "/nope", exec)).toBeNull();
  });
});

describe("evaluateMandatoryAgentShellGuard", () => {
  const live = {
    isLiveAgentRun: true,
    allowUnguardedLiveEnv: false,
    shellGuardEnabled: true,
    hostPipFirewallEnabled: true,
    wrapperBinReady: true,
    pathSanitized: true,
    condaEnvScrubbed: true,
  };

  test("non-live ⇒ not applicable, proceeds", () => {
    const d = evaluateMandatoryAgentShellGuard({ ...live, isLiveAgentRun: false });
    expect(d.proceed).toBe(true);
    expect(d.status).toBe("not_applicable");
    expect(d.required).toBe(false);
  });

  test("clean live run passes", () => {
    const d = evaluateMandatoryAgentShellGuard(live);
    expect(d.proceed).toBe(true);
    expect(d.status).toBe("pass");
    expect(d.benchmarkValid).toBe(true);
  });

  test("escape hatch bypasses but is never benchmark-valid", () => {
    const d = evaluateMandatoryAgentShellGuard({ ...live, allowUnguardedLiveEnv: true });
    expect(d.bypassed).toBe(true);
    expect(d.benchmarkValid).toBe(false);
    expect(d.failClosed).toBe(false);
  });

  test("disabled guard fails closed", () => {
    const d = evaluateMandatoryAgentShellGuard({ ...live, shellGuardEnabled: false });
    expect(d.failClosed).toBe(true);
    expect(d.benchmarkValid).toBe(false);
    expect(d.reason).toMatch(/agent shell guard/);
  });

  test("disabled firewall fails closed", () => {
    const d = evaluateMandatoryAgentShellGuard({ ...live, hostPipFirewallEnabled: false });
    expect(d.failClosed).toBe(true);
    expect(d.reason).toMatch(/host-pip firewall/);
  });

  test("unmaterialized wrapper bin fails closed", () => {
    const d = evaluateMandatoryAgentShellGuard({ ...live, wrapperBinReady: false });
    expect(d.failClosed).toBe(true);
    expect(d.reason).toMatch(/wrapper bin/);
  });

  test("unsanitized PATH fails closed", () => {
    const d = evaluateMandatoryAgentShellGuard({ ...live, pathSanitized: false });
    expect(d.failClosed).toBe(true);
    expect(d.reason).toMatch(/PATH/);
  });

  test("nothing-to-scrub does NOT fail closed when PATH is sanitized", () => {
    const d = evaluateMandatoryAgentShellGuard({ ...live, condaEnvScrubbed: false });
    expect(d.proceed).toBe(true);
    expect(d.status).toBe("pass");
  });
});

describe("parseBlockedCommandLog", () => {
  test("parses JSONL records, skips junk", () => {
    const text = [
      '{"marker":"VTRACE_HOST_PIP_BLOCKED","tool":"pip","command":"install -e ."}',
      "not json",
      '{"marker":"VTRACE_HOST_CONDA_BLOCKED","tool":"conda","command":"install pluggy=0.13.1"}',
      "",
    ].join("\n");
    const rows = parseBlockedCommandLog(text);
    expect(rows.length).toBe(2);
    expect(rows[0].tool).toBe("pip");
    expect(rows[1].marker).toBe(BLOCK_MARKER_CONDA);
  });

  test("empty/null ⇒ []", () => {
    expect(parseBlockedCommandLog(null)).toEqual([]);
    expect(parseBlockedCommandLog("")).toEqual([]);
  });
});

describe("buildAgentShellGuardMetadata", () => {
  test("flattens blocked commands and counts them", () => {
    const m = buildAgentShellGuardMetadata({
      required: true,
      enabled: true,
      hostPipFirewallEnabled: true,
      status: "pass",
      wrapperBin: WRAPPER,
      pathSanitized: true,
      condaEnvScrubbed: true,
      pythonResolution: "wrapper:.../python",
      pipResolution: "wrapper:.../pip",
      blockedCommands: [
        { marker: BLOCK_MARKER_PIP, tool: "pip", command: "install -e ." },
        { marker: BLOCK_MARKER_PKG_MANAGER, tool: "uv", command: "pip install -e ." },
      ],
      failureReason: null,
    });
    expect(m.stage5_agent_shell_guard_mandatory_since).toBe(STAGE5_AGENT_SHELL_GUARD_MANDATORY_SINCE);
    expect(m.stage5_blocked_host_package_command_count).toBe(2);
    expect(m.stage5_blocked_host_package_commands).toEqual(["pip install -e .", "uv pip install -e ."]);
    expect(m.stage5_agent_path_sanitized).toBe(true);
  });
});

describe("wrapper script generation", () => {
  test("generates an executable script for every wrapper name with the right markers", () => {
    const scripts = buildAllWrapperScripts(DELEGATES);
    for (const name of AGENT_WRAPPER_NAMES) {
      expect(scripts[name].startsWith("#!/usr/bin/env bash")).toBe(true);
    }
    expect(scripts.pip).toMatch(new RegExp(BLOCK_MARKER_PIP));
    expect(scripts.conda).toMatch(new RegExp(BLOCK_MARKER_CONDA));
    expect(scripts.uv).toMatch(new RegExp(BLOCK_MARKER_PKG_MANAGER));
  });

  test("python wrapper blocks -m pip / -m ensurepip and delegates otherwise", () => {
    const s = pythonWrapperScript("python", DELEGATES);
    expect(s).toMatch(/pip\|pip3\|pip3\.12\|ensurepip\|virtualenv/);
    expect(s).toMatch(/-mpip\|/); // no-space form covered
    expect(s).toContain(DELEGATES.delegatePython);
  });

  test("pip wrapper delegates read-only verbs to the testbed python, blocks the rest", () => {
    const s = pipWrapperScript("pip", DELEGATES);
    expect(s).toMatch(/--version\|-V\|list/);
    expect(s).toContain(`${DELEGATES.delegatePython}' -m pip`);
  });
});
