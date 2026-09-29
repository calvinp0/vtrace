import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { M214_AGENT, M214_BUDGET, M214_MODEL, M214_NATIVE_TOOLS } from "./m214Preregistration";
import { M220A3_HARNESS_CAPABILITIES } from "./m220A3Amendment";
import {
  type AgentHarnessIdentity,
  type ProbeSpawner,
  AgentHarnessAuthority,
  PROBE_MCP_SERVER,
  containsWholeToken,
  observationFrom,
  probeAgentHarness,
  probeArgv,
} from "./m220A3AgentHarness";

const root = mkdtempSync(join(tmpdir(), "m220a3-harness-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const TOKENS = "tool_use tool_result rate_limit_event rate_limit_info allowed allowed_warning rejected rateLimitType resetsAt utilization isUsingOverage overageStatus error_max_turns error_max_budget_usd";

function executable(name: string, tokens: string = TOKENS): string {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\n# ${tokens}\n`);
  return path;
}

function identity(binary: string, version = "9.9.9"): AgentHarnessIdentity {
  return { declaredBinary: M214_AGENT.binary, resolvedBinary: binary, versionOutput: `${version} (Claude Code)`, version, sha256: "f".repeat(64), issues: [] };
}

/** A canned CLI: answers the offline production invocation and auth status the way the real one does. */
function cannedSpawner(overrides: { init?: Record<string, unknown>; stdout?: string } = {}): ProbeSpawner {
  return (_binary, args, options) => {
    mkdirSync(options.env.CLAUDE_CONFIG_DIR!, { recursive: true });
    writeFileSync(join(options.env.CLAUDE_CONFIG_DIR!, ".claude.json"), "{}");
    if (args[0] === "auth") return { status: 0, stdout: JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }), stderr: "", error: null };
    const model = args[args.indexOf("--model") + 1];
    const init = { type: "system", subtype: "init", model, apiKeySource: "none", tools: ["Read"], mcp_servers: [{ name: PROBE_MCP_SERVER, status: "failed" }], claude_code_version: "9.9.9", ...overrides.init };
    const result = { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, usage: {} };
    return { status: 1, stdout: overrides.stdout ?? `${JSON.stringify(init)}\n${JSON.stringify(result)}\n`, stderr: "", error: null };
  };
}

describe("static schema scan", () => {
  test("whole tokens only: error_max_budget is not found inside error_max_budget_usd", () => {
    const bytes = Buffer.from("x='error_max_budget_usd';y=\"rate_limit_event\"");
    expect(containsWholeToken(bytes, "error_max_budget_usd")).toBe(true);
    expect(containsWholeToken(bytes, "error_max_budget")).toBe(false);
    expect(containsWholeToken(bytes, "rate_limit_event")).toBe(true);
    expect(containsWholeToken(bytes, "rate_limit")).toBe(false);
  });
});

describe("the probe argv is the production argv shape", () => {
  test("every production flag is present with the frozen values", () => {
    const argv = probeArgv();
    expect(argv[0]).toBe("-p");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(argv[argv.indexOf("--model") + 1]).toBe(M214_MODEL.model);
    expect(argv[argv.indexOf("--max-turns") + 1]).toBe(String(M214_BUDGET.maxTurns));
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe(M214_NATIVE_TOOLS.join(","));
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe(String(M214_BUDGET.perRunCostCapUsd));
    expect(argv).toContain("--verbose");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--mcp-config") + 1]).toContain(PROBE_MCP_SERVER);
  });
});

describe("capability evaluation", () => {
  test("a compliant harness passes all twelve, whatever its version", () => {
    const report = probeAgentHarness(identity(executable("ok")), { spawner: cannedSpawner(), isolationAvailable: true, scratchRoot: root });
    expect(report.issues).toEqual([]);
    expect(report.capabilities.map((entry) => entry.id)).toEqual(M220A3_HARNESS_CAPABILITIES.map((entry) => entry.id));
    expect(report.verdict).toBe("AGENT_HARNESS_CAPABILITIES_PASS");
  });

  test("plain text output, a missing model, a missing token each fail their capability", () => {
    const plain = probeAgentHarness(identity(executable("plain")), { spawner: cannedSpawner({ stdout: "Not logged in\n" }), isolationAvailable: true, scratchRoot: root });
    expect(plain.capabilities.filter((entry) => !entry.satisfied).map((entry) => entry.id)).toContain("C2_STRUCTURED_STREAM_OUTPUT");
    const noModel = probeAgentHarness(identity(executable("nomodel")), { spawner: cannedSpawner({ init: { model: undefined } }), isolationAvailable: true, scratchRoot: root });
    expect(noModel.capabilities.filter((entry) => !entry.satisfied).map((entry) => entry.id)).toEqual(["C3_INIT_MODEL_IDENTITY"]);
    const noBudget = probeAgentHarness(identity(executable("nobudget", TOKENS.replace("error_max_budget_usd", "error_max_budget_usd_v2"))), { spawner: cannedSpawner(), isolationAvailable: true, scratchRoot: root });
    expect(noBudget.capabilities.filter((entry) => !entry.satisfied).map((entry) => entry.id)).toEqual(["C9_TERMINATION_SUBTYPES"]);
    const apiKey = probeAgentHarness(identity(executable("apikey")), { spawner: cannedSpawner({ init: { apiKeySource: "ANTHROPIC_API_KEY" } }), isolationAvailable: true, scratchRoot: root });
    expect(apiKey.verdict).toBe("AGENT_HARNESS_CAPABILITY_MISMATCH");
  });

  test("without isolation the harness is never executed", () => {
    let spawned = 0;
    const report = probeAgentHarness(identity(executable("iso")), { spawner: () => { spawned += 1; return { status: 0, stdout: "", stderr: "", error: null }; }, isolationAvailable: false, scratchRoot: root });
    expect(spawned).toBe(0);
    expect(report.isolation).toBe("UNAVAILABLE");
    expect(report.verdict).toBe("AGENT_HARNESS_CAPABILITY_MISMATCH");
  });

  test("a report that skipped a capability cannot pass", () => {
    const report = probeAgentHarness(identity(executable("skip")), { spawner: cannedSpawner(), isolationAvailable: true, scratchRoot: root });
    const partial = { ...report, capabilities: report.capabilities.slice(1) };
    expect(observationFrom(partial).capabilityVerdict).toBe("AGENT_HARNESS_CAPABILITY_MISMATCH");
  });

  test("the authority probes each digest once and re-resolves every time", () => {
    let probes = 0;
    const binary = executable("cache");
    const spawner: ProbeSpawner = (b, args, options) => { if (args[0] === "-p") probes += 1; return cannedSpawner()(b, args, options); };
    const authority = new AgentHarnessAuthority({ resolve: () => identity(binary), spawner, isolationAvailable: true, scratchRoot: root });
    authority.observe();
    authority.observe();
    expect(probes).toBe(1);
  });
});
