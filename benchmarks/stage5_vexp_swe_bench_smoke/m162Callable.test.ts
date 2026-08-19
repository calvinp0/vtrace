import { describe, expect, test } from "bun:test";

import {
  FROZEN_CALLABLE_TOOL_IDS,
  buildCallableAllowedTools,
  buildVtraceMcpConfig,
  checkArmToolParity,
  expectedArmToolPermissions,
  frozenCallableMcpToolNames,
  mcpToolName,
} from "./m162Callable";

describe("M162 callable tool naming", () => {
  test("uses the Claude MCP namespace the agent actually sees", () => {
    expect(mcpToolName("get_code_context")).toBe("mcp__vtrace__get_code_context");
    expect(frozenCallableMcpToolNames()).toEqual([
      "mcp__vtrace__get_code_context",
      "mcp__vtrace__get_impact_graph",
    ]);
  });

  test("the frozen set is exactly two tools", () => {
    expect([...FROZEN_CALLABLE_TOOL_IDS]).toEqual(["get_code_context", "get_impact_graph"]);
  });
});

describe("M162 MCP config", () => {
  test("binds the server to the agent's own workspace and restricts the surface", () => {
    const config = buildVtraceMcpConfig({
      repoRoot: "/work/task-42",
      cliEntry: "/vtrace/src/cli/index.ts",
      runtime: "bun",
    });
    const server = config.mcpServers.vtrace!;
    expect(server.command).toBe("bun");
    expect(server.args).toEqual([
      "/vtrace/src/cli/index.ts",
      "mcp-serve",
      "--repo",
      "/work/task-42",
      "--tools",
      "get_code_context,get_impact_graph",
    ]);
  });

  test("exactly one server is configured", () => {
    const config = buildVtraceMcpConfig({
      repoRoot: "/w", cliEntry: "/c", runtime: "bun",
    });
    expect(Object.keys(config.mcpServers)).toEqual(["vtrace"]);
  });
});

describe("M162 allow-list", () => {
  test("adds the two VTRACE names and nothing else", () => {
    expect(buildCallableAllowedTools()).toEqual([
      "Edit", "Write", "Bash", "Read", "Glob", "Grep", "TodoWrite",
      "mcp__vtrace__get_code_context",
      "mcp__vtrace__get_impact_graph",
    ]);
  });

  test("never uses a wildcard", () => {
    // A wildcard would let a future registered tool reach the agent without
    // passing through the frozen-set review.
    expect(buildCallableAllowedTools().some((tool) => tool.includes("*"))).toBe(false);
  });
});

describe("M162 arm parity", () => {
  const arms = (["baseline", "static", "callable"] as const).map((arm) => expectedArmToolPermissions(arm));

  test("the three arms differ only by VTRACE affordances", () => {
    const result = checkArmToolParity(arms);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("baseline and static expose zero VTRACE tools and zero MCP servers", () => {
    for (const arm of ["baseline", "static"] as const) {
      const permissions = expectedArmToolPermissions(arm);
      expect(permissions.vtraceToolNames).toEqual([]);
      expect(permissions.mcpServersConfigured).toEqual([]);
      expect(permissions.allowedTools.some((tool) => tool.startsWith("mcp__"))).toBe(false);
    }
  });

  test("detects a leaked VTRACE tool in the static arm", () => {
    const leaked = arms.map((arm) => (arm.arm === "static"
      ? { ...arm, vtraceToolNames: ["mcp__vtrace__get_code_context"] }
      : arm));
    const result = checkArmToolParity(leaked);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("STATIC exposes VTRACE tools");
  });

  test("detects an ordinary-tool asymmetry", () => {
    const skewed = arms.map((arm) => (arm.arm === "callable"
      ? { ...arm, allowedTools: arm.allowedTools.filter((tool) => tool !== "Grep") }
      : arm));
    const result = checkArmToolParity(skewed);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("CALLABLE ordinary tool permissions differ");
  });

  test("detects a visible-but-unusable tool", () => {
    // The exact M155-shaped failure one level up: configured and discoverable,
    // but absent from the allow-list, so every call would be denied.
    const unusable = arms.map((arm) => (arm.arm === "callable"
      ? { ...arm, allowedTools: arm.allowedTools.filter((tool) => !tool.startsWith("mcp__")) }
      : arm));
    const result = checkArmToolParity(unusable);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("missing mcp__vtrace__get_code_context");
  });

  test("detects a thirteenth tool", () => {
    const extra = arms.map((arm) => (arm.arm === "callable"
      ? {
          ...arm,
          vtraceToolNames: [...arm.vtraceToolNames, "mcp__vtrace__search_symbols"],
          allowedTools: [...arm.allowedTools, "mcp__vtrace__search_symbols"],
        }
      : arm));
    const result = checkArmToolParity(extra);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("CALLABLE VTRACE tool set is");
  });
});
