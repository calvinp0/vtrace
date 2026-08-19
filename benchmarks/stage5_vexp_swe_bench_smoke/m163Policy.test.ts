import { describe, expect, test } from "bun:test";

import { VTRACE_TOOL_SUITE_POLICY } from "../../src/mcp/startServer";
import { frozenCallableMcpToolNames } from "./m162Callable";
import {
  buildArmWiring,
  checkArmPolicyLadder,
  HISTORICAL_TOKEN_DISCIPLINE_PROBES,
  M163_ARMS,
  M163_CONTEXT_TOOL_NAME,
  M163_TASK_TRIGGER_TEXT,
  policyComponents,
  policyDelta,
  scanTaskTrigger,
  sha256,
} from "./m163Policy";

const WIRING = {
  repoRoot: "/tmp/ws/instance",
  cliEntry: "/home/calvin/code/vtrace/src/cli/index.ts",
  runtime: "bun",
} as const;

describe("policy ladder", () => {
  test("the three arms are a strict incremental ladder over one tool surface", () => {
    expect(checkArmPolicyLadder()).toEqual({ ok: true, issues: [] });
  });

  test("TOOLS_ONLY carries tool schemas and nothing else", () => {
    expect(policyComponents("tools_only")).toEqual([]);
  });

  test("A->B adds exactly the suite policy, B->C exactly the trigger", () => {
    expect(policyDelta("tools_only", "tools_neutral_policy").added).toEqual(["suite_policy"]);
    expect(policyDelta("tools_only", "tools_neutral_policy").removed).toEqual([]);
    expect(policyDelta("tools_neutral_policy", "tools_task_trigger").added).toEqual(["task_trigger"]);
    expect(policyDelta("tools_neutral_policy", "tools_task_trigger").removed).toEqual([]);
  });

  test("the neutral policy is the product's own bytes, not a rewrite", () => {
    const component = policyComponents("tools_neutral_policy").find((entry) => entry.id === "suite_policy");
    expect(component?.text).toBe(VTRACE_TOOL_SUITE_POLICY);
    // M162 served this exact policy; the hash is recorded there.
    expect(component?.sha256).toBe("6b7fc159f93dc6298958c86ceafa0db222aa0c2192a189000bd6d09144daec8c");
  });

  test("every arm exposes the identical two-tool inventory", () => {
    for (const arm of M163_ARMS) {
      const wiring = buildArmWiring({ ...WIRING, arm, triggerFile: "/tmp/trigger.md" });
      expect(wiring.mcpConfig.mcpServers.vtrace?.args).toContain("get_code_context,get_impact_graph");
      expect(wiring.env.VTRACE_MCP_ALLOWED_TOOLS).toBe(frozenCallableMcpToolNames().join(","));
      for (const name of frozenCallableMcpToolNames()) expect(wiring.allowedTools).toContain(name);
    }
  });
});

describe("arm wiring", () => {
  test("only TOOLS_ONLY suppresses the served policy", () => {
    const args = (arm: (typeof M163_ARMS)[number]): readonly string[] =>
      buildArmWiring({ ...WIRING, arm, triggerFile: "/tmp/trigger.md" }).mcpConfig.mcpServers.vtrace?.args ?? [];

    expect(args("tools_only")).toContain("--no-suite-policy");
    expect(args("tools_neutral_policy")).not.toContain("--no-suite-policy");
    expect(args("tools_task_trigger")).not.toContain("--no-suite-policy");
  });

  test("only the trigger arm carries the trigger env var", () => {
    const env = (arm: (typeof M163_ARMS)[number]): Record<string, string> =>
      buildArmWiring({ ...WIRING, arm, triggerFile: "/tmp/trigger.md" }).env as Record<string, string>;

    expect(env("tools_only").VTRACE_TASK_TRIGGER_FILE).toBeUndefined();
    expect(env("tools_neutral_policy").VTRACE_TASK_TRIGGER_FILE).toBeUndefined();
    expect(env("tools_task_trigger").VTRACE_TASK_TRIGGER_FILE).toBe("/tmp/trigger.md");
  });

  test("a trigger arm without a trigger file is refused rather than silently demoted", () => {
    // The failure this prevents is the whole M162 lesson: a treatment that did
    // not arrive is indistinguishable, in every result field, from one the agent
    // declined. Here it would silently turn arm C into arm B.
    expect(() => buildArmWiring({ ...WIRING, arm: "tools_task_trigger" })).toThrow(/requires a triggerFile/);
  });

  test("suppressing the policy leaves the repo binding and tool restriction intact", () => {
    const a = buildArmWiring({ ...WIRING, arm: "tools_only" }).mcpConfig.mcpServers.vtrace;
    const b = buildArmWiring({ ...WIRING, arm: "tools_neutral_policy" }).mcpConfig.mcpServers.vtrace;
    expect(a?.command).toBe(b?.command ?? "");
    expect(a?.args.slice(0, -1)).toEqual([...(b?.args ?? [])]);
  });
});

describe("frozen trigger wording", () => {
  test("the frozen trigger passes its own scanner", () => {
    expect(scanTaskTrigger(M163_TASK_TRIGGER_TEXT)).toEqual({
      ok: true,
      forbiddenHits: [],
      missingRequired: [],
    });
  });

  test("the frozen trigger names the real tool and mandates one call", () => {
    expect(M163_TASK_TRIGGER_TEXT).toContain(M163_CONTEXT_TOOL_NAME);
    expect(M163_CONTEXT_TOOL_NAME).toBe("mcp__vtrace__get_code_context");
    expect(M163_TASK_TRIGGER_TEXT).toContain("a single call");
  });

  test("the frozen bytes are pinned", () => {
    // Any edit to the trigger changes the treatment. If this hash moves, the
    // sweep it belongs to is a different experiment.
    expect(sha256(M163_TASK_TRIGGER_TEXT)).toBe(sha256([
      "Your first action on this task must be a single call to the mcp__vtrace__get_code_context tool, using this task's description, to orient yourself.",
      "",
      "After that one call you may use or ignore its result entirely, and you may use all normal repository tools without restriction for the rest of the task.",
    ].join("\n")));
  });
});

describe("trigger scanner, both polarities", () => {
  // Negative polarity: wording that must be REJECTED. An empty finding from a
  // detector that has never fired is not evidence (M162-B/C standing finding).
  test.each([
    ["suppress_search", "Call the tool first. Do not grep the repository afterwards."],
    ["search_budget", "Call the tool first, then use at most 2 searches before editing."],
    ["patch_first", "Call the tool, then patch first without further exploration."],
    ["mandate_trust", "Call the tool once and trust the result it returns."],
    ["mandate_follow", "Call the tool once, then follow the pivot it identifies."],
    ["mandate_repeat_use", "Always call the context tool before every edit."],
    ["authoritative", "The tool returns the authoritative answer for this repository."],
    ["limit_yourself", "Limit yourself to the files the tool names."],
  ])("rejects %s", (id, text) => {
    const result = scanTaskTrigger(text);
    expect(result.ok).toBe(false);
    expect(result.forbiddenHits).toContain(id);
  });

  // Positive polarity: a trigger that forbids nothing but quietly dropped the
  // clause returning autonomy. It would measure obedience while reporting
  // exposure, and a forbid-only scanner passes it.
  test("rejects a trigger that dropped the ignore-rights clause", () => {
    const stripped = "Your first action on this task must be a single call to the mcp__vtrace__get_code_context tool.";
    const result = scanTaskTrigger(stripped);
    expect(result.ok).toBe(false);
    expect(result.forbiddenHits).toEqual([]);
    expect(result.missingRequired).toEqual(["grants_ignore", "grants_normal_tools"]);
  });

  test("rejects a trigger that names no tool", () => {
    const vague = "Your first action must be one call to the repository context tool. "
      + "After that you may use or ignore its result entirely and use all normal repository tools without restriction.";
    expect(scanTaskTrigger(vague).missingRequired).toContain("names_context_tool");
  });

  test("the historical STAGE5_TOKEN_DISCIPLINE wording fails the scanner", () => {
    for (const probe of HISTORICAL_TOKEN_DISCIPLINE_PROBES) {
      expect(scanTaskTrigger(probe).ok).toBe(false);
    }
  });

  test("no M163 policy surface contains historical discipline wording", () => {
    const surfaces = M163_ARMS.flatMap((arm) => policyComponents(arm).map((entry) => entry.text));
    for (const text of surfaces) {
      for (const probe of HISTORICAL_TOKEN_DISCIPLINE_PROBES) {
        expect(text.includes(probe)).toBe(false);
      }
    }
  });
});
