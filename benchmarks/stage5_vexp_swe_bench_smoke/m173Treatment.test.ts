import { describe, expect, it } from "bun:test";

import {
  M168_ALLOWED_TOOLS,
  M168_MANDATE_TEXT,
  M168_PIPELINE_TOOL_NAME,
  M168_PROHIBITION_TEXT,
  M168_VISIBLE_TOOL_IDS,
  claudeMdForArm as m168ClaudeMdForArm,
} from "./m168Treatment";
import {
  Disclosure,
  M173_ARMS,
  M173_MANDATE_TEXT,
  ORIENTATION_SCHEMA_VERSION,
  armDefinition,
  buildSchedule,
  claudeMdForArm,
  classifyDisclosure,
  findLeakage,
  mcpConfigForArm,
  allowedToolsForArm,
} from "./m173Treatment";

describe("M173 arms", () => {
  it("has exactly two arms", () => {
    expect([...M173_ARMS]).toEqual(["baseline", "vtrace_compact"]);
  });

  it("carries the M168 clean arm's mandate byte-for-byte", () => {
    // The whole causal claim rests on this: if the prose moved, M173 is not
    // requalifying M169's treatment, it is measuring a different one.
    expect(M173_MANDATE_TEXT).toBe(M168_MANDATE_TEXT);
    expect(claudeMdForArm("vtrace_compact")).toBe(m168ClaudeMdForArm("vtrace_clean"));
  });

  it("carries no prohibition text anywhere", () => {
    const policy = claudeMdForArm("vtrace_compact")!;
    expect(policy).not.toContain(M168_PROHIBITION_TEXT.trim());
    expect(policy.toLowerCase()).not.toContain("do not use grep");
  });

  it("never asks for a detail level", () => {
    // §8 — the shipped compact default IS the treatment. A treatment that named
    // a detail level would be testing an argument, not the product default.
    // The mandate does say "debugging" — that is the task list VEXP published,
    // not an argument. What must be absent is any instruction naming the
    // `detail` parameter or the debug level it selects.
    const policy = claudeMdForArm("vtrace_compact")!;
    expect(policy).not.toContain("detail");
    expect(policy).not.toContain("detail=debug");
    expect(policy).not.toMatch(/\bdebug\b/);
  });

  it("gives the baseline nothing at all", () => {
    expect(claudeMdForArm("baseline")).toBeNull();
    expect(mcpConfigForArm("baseline", "/tmp/x", "/tmp/cli.ts").mcpServers).toEqual({});
    expect(armDefinition("baseline").visibleToolIds).toEqual([]);
    expect(armDefinition("baseline").disclosure).toBe("NONE");
    expect([...allowedToolsForArm("baseline")]).toEqual([...M168_ALLOWED_TOOLS]);
  });

  it("preserves the M168-frozen tool inventory", () => {
    expect([...armDefinition("vtrace_compact").visibleToolIds]).toEqual([...M168_VISIBLE_TOOL_IDS]);
    const config = mcpConfigForArm("vtrace_compact", "/repo", "/cli.ts");
    const server = config.mcpServers.vtrace as { args: string[] };
    expect(server.args).toContain("--tools");
    expect(server.args).toContain(M168_VISIBLE_TOOL_IDS.join(","));
    expect(server.args).toContain("/repo");
  });

  it("names the pipeline tool the agent actually sees", () => {
    expect(M173_MANDATE_TEXT).toContain(M168_PIPELINE_TOOL_NAME);
  });

  it("declares no coercion of any kind", () => {
    const b = armDefinition("vtrace_compact");
    expect(b.prohibitionText).toBe(false);
    expect(b.searchGuard).toBe(false);
    expect(b.antiLoopDiscipline).toBe(false);
    expect(b.disclosure).toBe("M172_COMPACT_ORIENTATION_DEFAULT");
  });
});

describe("M173 schedule", () => {
  it("alternates arm order so neither arm owns the earlier slot", () => {
    const schedule = buildSchedule(["a", "b", "c", "d"]);
    expect(schedule.map((r) => r.armOrder[0])).toEqual([
      "baseline", "vtrace_compact", "baseline", "vtrace_compact",
    ]);
    expect(schedule.map((r) => r.order)).toEqual([1, 2, 3, 4]);
  });

  it("runs every arm on every task", () => {
    for (const row of buildSchedule(["a", "b", "c"])) {
      expect([...row.armOrder].sort()).toEqual(["baseline", "vtrace_compact"]);
    }
  });
});

describe("disclosure classification", () => {
  it("identifies the shipped compact orientation by its schema version", () => {
    const packet = JSON.stringify({ schemaVersion: ORIENTATION_SCHEMA_VERSION, focus: {}, boundary: "x" });
    expect(classifyDisclosure(packet)).toBe(Disclosure.CompactOrientation);
  });

  it("identifies an authoritative debug payload by authoritative-only keys", () => {
    expect(classifyDisclosure(JSON.stringify({ productContext: { items: [] } })))
      .toBe(Disclosure.AuthoritativeDebug);
    expect(classifyDisclosure(JSON.stringify({ responseBudget: { withinEnvelope: true } })))
      .toBe(Disclosure.AuthoritativeDebug);
  });

  it("does not call a long compact packet a debug payload", () => {
    // Size is not the discriminator. A packet that reached the ceiling is still
    // the compact projection, and calling it debug would manufacture a leak.
    const long = JSON.stringify({
      schemaVersion: ORIENTATION_SCHEMA_VERSION,
      related: Array.from({ length: 200 }, (_, i) => ({ path: `f${i}.py`, why: "imports the focus symbol" })),
    });
    expect(long.length).toBeGreaterThan(8000);
    expect(classifyDisclosure(long)).toBe(Disclosure.CompactOrientation);
  });

  it("records an unreadable capture as unobservable rather than as compact", () => {
    // M167's rule: an unobservable is recorded as such, never scored as an
    // absence. Failing to "compact" here would certify a leak-free run we did
    // not observe.
    expect(classifyDisclosure("")).toBe(Disclosure.Unclassifiable);
    expect(classifyDisclosure("some free text with no markers")).toBe(Disclosure.Unclassifiable);
  });

  it("keeps a non-resolved envelope distinct from both", () => {
    expect(classifyDisclosure(JSON.stringify({ resolved: false, reason: "repo_not_ready" })))
      .toBe(Disclosure.Envelope);
  });
});

describe("baseline leakage detection", () => {
  it("finds nothing in a clean baseline prompt", () => {
    expect(findLeakage("Fix the bug in aggregates.py so Count(distinct=True) works.")).toEqual([]);
  });

  it("names what leaked", () => {
    expect(findLeakage("call mcp__vtrace__run_pipeline first")).toContain("mcp__vtrace__");
    expect(findLeakage("The .VTRACE index is ready")).toContain(".vtrace");
  });
});
