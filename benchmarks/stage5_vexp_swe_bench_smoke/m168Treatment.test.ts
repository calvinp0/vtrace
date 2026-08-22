import { describe, expect, test } from "bun:test";

import {
  M168_ALLOWED_TOOLS,
  M168_ARMS,
  M168_MANDATE_TEXT,
  M168_PIPELINE_TOOL_NAME,
  M168_PROHIBITION_TEXT,
  M168_POLICY_ENFORCEMENT,
  M168_VISIBLE_TOOL_IDS,
  allowedToolsForArm,
  armDefinition,
  buildSchedule,
  claudeMdForArm,
  guardScript,
  mcpConfigForArm,
  settingsJsonForArm,
  sha256,
} from "./m168Treatment";

describe("arm isolation — B and C differ by the coercive policy and nothing else", () => {
  test("the mandate is byte-identical in both VTRACE arms", () => {
    const strict = claudeMdForArm("vtrace_strict")!;
    const clean = claudeMdForArm("vtrace_clean")!;
    // Removing the prohibition BYTES from strict must recover clean exactly.
    expect(strict.replace(M168_PROHIBITION_TEXT, "")).toBe(clean);
    expect(strict).toContain(M168_PROHIBITION_TEXT);
  });

  test("both VTRACE arms mandate the same tool under the same name", () => {
    for (const arm of ["vtrace_strict", "vtrace_clean"] as const) {
      expect(claudeMdForArm(arm)).toContain(M168_PIPELINE_TOOL_NAME);
      expect(claudeMdForArm(arm)).toContain("ALWAYS FIRST");
    }
  });

  test("only the strict arm carries the prohibition", () => {
    expect(claudeMdForArm("vtrace_strict")).toContain("Do NOT use grep");
    expect(claudeMdForArm("vtrace_clean")).not.toContain("Do NOT use grep");
    expect(claudeMdForArm("baseline")).toBeNull();
  });

  test("both VTRACE arms expose the identical tool inventory", () => {
    expect(armDefinition("vtrace_strict").visibleToolIds)
      .toEqual(armDefinition("vtrace_clean").visibleToolIds);
    expect(armDefinition("vtrace_strict").visibleToolIds).toEqual(M168_VISIBLE_TOOL_IDS);
  });

  test("both VTRACE arms get the identical MCP config for the same workspace", () => {
    const strict = mcpConfigForArm("vtrace_strict", "/w/repo", "/v/cli.ts");
    const clean = mcpConfigForArm("vtrace_clean", "/w/repo", "/v/cli.ts");
    expect(strict).toEqual(clean);
  });

  test("only the strict arm registers a PreToolUse hook", () => {
    expect(settingsJsonForArm("vtrace_strict", "/h/guard.sh")).not.toBeNull();
    expect(settingsJsonForArm("vtrace_clean", "/h/guard.sh")).toBeNull();
    expect(settingsJsonForArm("baseline", "/h/guard.sh")).toBeNull();
  });
});

describe("baseline leakage controls", () => {
  test("the baseline carries no VTRACE server, policy, hook or tool", () => {
    expect(mcpConfigForArm("baseline", "/w/repo", "/v/cli.ts").mcpServers).toEqual({});
    expect(claudeMdForArm("baseline")).toBeNull();
    expect(settingsJsonForArm("baseline", "/h/guard.sh")).toBeNull();
    expect(armDefinition("baseline").visibleToolIds).toEqual([]);
    expect(allowedToolsForArm("baseline")).toEqual([...M168_ALLOWED_TOOLS]);
    for (const tool of allowedToolsForArm("baseline")) {
      expect(tool.startsWith("mcp__")).toBe(false);
    }
  });

  test("normal tools are identical across all three arms", () => {
    for (const arm of M168_ARMS) {
      for (const tool of M168_ALLOWED_TOOLS) {
        expect(allowedToolsForArm(arm)).toContain(tool);
      }
    }
  });

  test("Grep and Glob remain in every arm's whitelist — the guard denies, the "
    + "whitelist does not withhold", () => {
    for (const arm of M168_ARMS) {
      expect(allowedToolsForArm(arm)).toContain("Grep");
      expect(allowedToolsForArm(arm)).toContain("Glob");
    }
  });
});

describe("the guard reproduces the published denial semantics and no more", () => {
  test("it matches exactly Grep and Glob", () => {
    expect(settingsJsonForArm("vtrace_strict", "/h/g.sh")!.hooks.PreToolUse)
      .toEqual([{ matcher: "Grep|Glob", hooks: [{ type: "command", command: "/h/g.sh" }] }]);
  });

  test("it is conditional on the engine's own index, and exits 0 without it", () => {
    const script = guardScript("/w/repo", "/w/events.jsonl");
    expect(script).toContain('INDEX="/w/repo/.vtrace/index.sqlite"');
    expect(script).toContain('if [ -f "$INDEX" ]');
    expect(script.trimEnd().endsWith("exit 0")).toBe(true);
    expect(script).toContain("exit 2");
  });

  test("it records every decision, so a silently unguarded run is visible", () => {
    const script = guardScript("/w/repo", "/w/events.jsonl");
    expect(script).toContain('"decision":"deny"');
    expect(script).toContain('"decision":"allow"');
  });

  test("stated policy is broader than enforced policy, and both are recorded", () => {
    const strict = M168_POLICY_ENFORCEMENT.vtrace_strict;
    expect(strict.statedBlocked).toEqual(["grep", "glob", "Bash", "Read", "cat"]);
    expect(strict.hookBlocks).toEqual(["Grep", "Glob"]);
    expect(strict.unenforcedStatedBlocks).toEqual(["Bash", "Read", "cat"]);
  });

  test("nothing beyond Grep and Glob is ever mechanically blocked", () => {
    for (const arm of M168_ARMS) {
      const blocks = M168_POLICY_ENFORCEMENT[arm].hookBlocks;
      for (const tool of blocks) expect(["Grep", "Glob"]).toContain(tool);
    }
  });
});

describe("schedule", () => {
  test("every task runs every arm", () => {
    for (const entry of buildSchedule(["a", "b", "c", "d"])) {
      expect([...entry.armOrder].sort()).toEqual([...M168_ARMS].sort());
    }
  });

  test("no arm systematically leads", () => {
    const leads = buildSchedule(Array.from({ length: 12 }, (_, i) => `t${i}`))
      .map((e) => e.armOrder[0]);
    for (const arm of M168_ARMS) {
      expect(leads.filter((a) => a === arm)).toHaveLength(4);
    }
  });
});

describe("policy hashes are stable across calls", () => {
  test("the same arm hashes the same twice", () => {
    expect(armDefinition("vtrace_strict").claudeMdSha256)
      .toBe(armDefinition("vtrace_strict").claudeMdSha256);
  });

  test("the two VTRACE arms do not share a policy hash", () => {
    expect(armDefinition("vtrace_strict").claudeMdSha256)
      .not.toBe(armDefinition("vtrace_clean").claudeMdSha256);
  });

  test("the clean arm's policy is exactly the shared mandate", () => {
    expect(armDefinition("vtrace_clean").claudeMdSha256).toBe(sha256(M168_MANDATE_TEXT));
  });
});
