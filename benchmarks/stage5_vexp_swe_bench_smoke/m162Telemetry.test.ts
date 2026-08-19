import { describe, expect, test } from "bun:test";

import {
  accountVtraceTokens,
  analyzeUtilization,
  classifyFirstCallTiming,
  detectComposition,
  detectRedundantLookups,
  extractVtraceCalls,
  firstEditPosition,
  parseVtraceResponse,
  summarizeNavigationWork,
  summarizeRun,
  vtraceToolIdOf,
  type RawToolCall,
} from "./m162Telemetry";

const CTX = "mcp__vtrace__get_code_context";
const IMPACT = "mcp__vtrace__get_impact_graph";

function contextOutput(items: Array<{ path: string; fqName?: string }>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    productContext: {
      items: items.map((item, index) => ({ id: `P${index + 1}`, path: item.path, ...(item.fqName ? { fqName: item.fqName } : {}) })),
      coverage: { absenceClaim: "not_observed" },
      ...extra,
    },
  });
}

function call(overrides: Partial<RawToolCall> & { tool: string }): RawToolCall {
  return { index: 0, tool: overrides.tool, ...overrides };
}

describe("VTRACE call identification", () => {
  test("recognizes the model-visible MCP names, not internal ids", () => {
    expect(vtraceToolIdOf(CTX)).toBe("get_code_context");
    expect(vtraceToolIdOf(IMPACT)).toBe("get_impact_graph");
    // An internal id is NOT what the agent emits, so it must not match.
    expect(vtraceToolIdOf("get_code_context")).toBeUndefined();
    expect(vtraceToolIdOf("Grep")).toBeUndefined();
  });
});

describe("result-state parsing", () => {
  test("VALID_NONEMPTY when evidence is returned", () => {
    expect(parseVtraceResponse(contextOutput([{ path: "pkg/core.py", fqName: "pkg/core.py::A.b" }])).state)
      .toBe("VALID_NONEMPTY");
  });

  test("VALID_EMPTY is a successful call that found nothing", () => {
    const parsed = parseVtraceResponse(contextOutput([]));
    expect(parsed.state).toBe("VALID_EMPTY");
    expect(parsed.itemCount).toBe(0);
  });

  test("DEGRADED_VALID when a nested coverage block reports failures", () => {
    const output = JSON.stringify({
      productContext: { items: [{ path: "lib/good.py" }], diagnostics: { readiness: { coverageComplete: false, failedFiles: 1 } } },
    });
    expect(parseVtraceResponse(output).state).toBe("DEGRADED_VALID");
  });

  test("TOOL_ERROR for an invalid request, never VALID_EMPTY", () => {
    const output = JSON.stringify({ code: "invalid_request", message: "Unknown indexed symbol FQN: apply_discount" });
    expect(parseVtraceResponse(output).state).toBe("TOOL_ERROR");
  });

  test("an unparseable payload is an error, not a silent empty", () => {
    expect(parseVtraceResponse("<html>gateway timeout</html>").state).toBe("TOOL_ERROR");
    expect(parseVtraceResponse("").state).toBe("TOOL_ERROR");
  });

  test("unwraps the MCP envelope the LIVE runtime delivers", () => {
    // Gate 1 attempt 1 scored a correct composition as failed because it read
    // the tool result at the wrong depth: the live runtime records the server
    // envelope, a direct stdio client does not.
    const live = JSON.stringify({
      schema: { name: "vtrace_rc1_mcp" },
      requestId: "jsonrpc:1:get_code_context",
      toolId: "get_code_context",
      result: { ok: true, output: { productContext: { items: [{ path: "pkg/core.py", fqName: "pkg/core.py::PriceEngine.apply_discount" }] } } },
    });
    const parsed = parseVtraceResponse(live);
    expect(parsed.state).toBe("VALID_NONEMPTY");
    expect(parsed.fqNames).toEqual(["pkg/core.py::PriceEngine.apply_discount"]);
  });

  test("still parses the unwrapped shape a direct stdio client receives", () => {
    const direct = contextOutput([{ path: "pkg/core.py", fqName: "pkg/core.py::A.b" }]);
    expect(parseVtraceResponse(direct).fqNames).toEqual(["pkg/core.py::A.b"]);
  });

  test("impact responses expose the resolved symbol", () => {
    const output = JSON.stringify({
      resolvedSymbol: { filePath: "pkg/core.py", fqName: "pkg/core.py::A.b" },
      nodes: [{}, {}],
    });
    const parsed = parseVtraceResponse(output);
    expect(parsed.state).toBe("VALID_NONEMPTY");
    expect(parsed.fqNames).toEqual(["pkg/core.py::A.b"]);
  });
});

describe("first-call timing precedence", () => {
  test("NEVER_USED when no VTRACE call appears", () => {
    expect(classifyFirstCallTiming([call({ tool: "Grep" }), call({ tool: "Read" })])).toBe("NEVER_USED");
  });

  test("BEFORE_ANY_REPO_SEARCH", () => {
    expect(classifyFirstCallTiming([call({ tool: CTX }), call({ tool: "Read" })])).toBe("BEFORE_ANY_REPO_SEARCH");
  });

  test("AFTER_REPO_SEARCH_BEFORE_READ", () => {
    expect(classifyFirstCallTiming([call({ tool: "Grep" }), call({ tool: CTX })]))
      .toBe("AFTER_REPO_SEARCH_BEFORE_READ");
  });

  test("AFTER_READ_BEFORE_EDIT", () => {
    expect(classifyFirstCallTiming([call({ tool: "Grep" }), call({ tool: "Read" }), call({ tool: CTX })]))
      .toBe("AFTER_READ_BEFORE_EDIT");
  });

  test("AFTER_FIRST_EDIT", () => {
    expect(classifyFirstCallTiming([call({ tool: "Read" }), call({ tool: "Edit" }), call({ tool: CTX })]))
      .toBe("AFTER_FIRST_EDIT");
  });

  test("AFTER_TEST_FAILURE outranks AFTER_FIRST_EDIT", () => {
    // Precedence is frozen before live runs so an ambiguous transcript cannot be
    // resolved after the fact.
    const calls = [
      call({ tool: "Edit", path: "pkg/core.py" }),
      call({ tool: "Bash", command: "python -m pytest tests/test_a.py", output: "1 failed, 2 passed\nAssertionError" }),
      call({ tool: CTX }),
    ];
    expect(classifyFirstCallTiming(calls)).toBe("AFTER_TEST_FAILURE");
  });
});

describe("composition detection", () => {
  test("records an impact call that reuses a returned canonical identity", () => {
    const calls = [
      call({ tool: CTX, args: { task: "discount bug" }, output: contextOutput([{ path: "pkg/core.py", fqName: "pkg/core.py::PriceEngine.apply_discount" }]) }),
      call({ tool: IMPACT, args: { symbol_fqn: "pkg/core.py::PriceEngine.apply_discount" }, output: JSON.stringify({ resolvedSymbol: { fqName: "pkg/core.py::PriceEngine.apply_discount" }, nodes: [{}] }) }),
    ];
    const events = detectComposition(extractVtraceCalls(calls));
    expect(events).toHaveLength(1);
    expect(events[0]!.identifierFromReturnedFqName).toBe(true);
  });

  test("distinguishes an invented identifier from a copied one", () => {
    // The M162-A failure mode: the agent guesses instead of copying.
    const calls = [
      call({ tool: CTX, args: { task: "discount bug" }, output: contextOutput([{ path: "pkg/core.py", fqName: "pkg/core.py::PriceEngine.apply_discount" }]) }),
      call({ tool: IMPACT, args: { symbol_fqn: "pkg/core.py::apply_discount" }, output: JSON.stringify({ code: "invalid_request", message: "Unknown indexed symbol FQN" }) }),
    ];
    const records = extractVtraceCalls(calls);
    const events = detectComposition(records);
    expect(events[0]!.identifierFromReturnedFqName).toBe(false);
    expect(records[1]!.resultState).toBe("TOOL_ERROR");
  });
});

describe("result utilization", () => {
  test("detects reading and editing a returned path", () => {
    const calls = [
      call({ tool: CTX, args: { task: "t" }, output: contextOutput([{ path: "pkg/core.py", fqName: "pkg/core.py::A.b" }]) }),
      call({ tool: "Read", path: "pkg/core.py" }),
      call({ tool: "Edit", path: "pkg/core.py" }),
    ];
    const records = extractVtraceCalls(calls);
    const utilization = analyzeUtilization(calls, records);
    expect(utilization[0]!.outcomes.sort()).toEqual(["EDITED_RETURNED_PATH", "READ_RETURNED_PATH"]);
    expect(utilization[0]!.used).toBe(true);
  });

  test("an ignored result is recorded as ignored", () => {
    const calls = [
      call({ tool: CTX, args: { task: "t" }, output: contextOutput([{ path: "pkg/core.py" }]) }),
      call({ tool: "Read", path: "other/thing.py" }),
      call({ tool: "Edit", path: "other/thing.py" }),
    ];
    const utilization = analyzeUtilization(calls, extractVtraceCalls(calls));
    expect(utilization[0]!.outcomes).toEqual(["IGNORED"]);
    expect(utilization[0]!.used).toBe(false);
  });
});

describe("redundant-lookup detector", () => {
  test("KNOWN POSITIVE: greps for the exact symbol it was just handed", () => {
    const calls = [
      call({ tool: CTX, args: { task: "t" }, output: contextOutput([{ path: "pkg/core.py", fqName: "pkg/core.py::PriceEngine.apply_discount" }]) }),
      call({ tool: "Grep", args: { pattern: "apply_discount" } }),
    ];
    const findings = detectRedundantLookups(calls, extractVtraceCalls(calls));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rediscoveredTerm).toBe("apply_discount");
  });

  test("KNOWN POSITIVE: shell-searches for the exact returned path", () => {
    const calls = [
      call({ tool: CTX, args: { task: "t" }, output: contextOutput([{ path: "pkg/core.py" }]) }),
      call({ tool: "Bash", command: "rg pkg/core.py" }),
    ];
    expect(detectRedundantLookups(calls, extractVtraceCalls(calls))).toHaveLength(1);
  });

  test("KNOWN NEGATIVE: reading the returned implementation is not rediscovery", () => {
    // Reading after orientation is expected and useful. Counting it would
    // manufacture evidence that VTRACE fails to substitute for investigation.
    const calls = [
      call({ tool: CTX, args: { task: "t" }, output: contextOutput([{ path: "pkg/core.py", fqName: "pkg/core.py::PriceEngine.apply_discount" }]) }),
      call({ tool: "Read", path: "pkg/core.py" }),
    ];
    expect(detectRedundantLookups(calls, extractVtraceCalls(calls))).toEqual([]);
  });

  test("KNOWN NEGATIVE: a broader search that merely mentions the term", () => {
    const calls = [
      call({ tool: CTX, args: { task: "t" }, output: contextOutput([{ path: "pkg/core.py", fqName: "pkg/core.py::PriceEngine.apply_discount" }]) }),
      call({ tool: "Grep", args: { pattern: "apply_discount\\(.*tier.*\\)" } }),
    ];
    expect(detectRedundantLookups(calls, extractVtraceCalls(calls))).toEqual([]);
  });

  test("KNOWN NEGATIVE: a search after an empty result is not rediscovery", () => {
    const calls = [
      call({ tool: CTX, args: { task: "t" }, output: contextOutput([]) }),
      call({ tool: "Grep", args: { pattern: "anything" } }),
    ];
    expect(detectRedundantLookups(calls, extractVtraceCalls(calls))).toEqual([]);
  });
});

describe("navigation work and token accounting", () => {
  test("reports components, never a blended score", () => {
    const calls = [
      call({ tool: "Grep", args: { pattern: "x" } }),
      call({ tool: CTX, args: { task: "t" }, output: contextOutput([{ path: "a.py" }]) }),
      call({ tool: "Read", path: "a.py" }),
      call({ tool: "Edit", path: "a.py" }),
      call({ tool: "Bash", command: "rg something" }),
    ];
    const work = summarizeNavigationWork(calls);
    expect(work).toMatchObject({ ordinarySearches: 2, fileReads: 1, edits: 1, vtraceCalls: 1, totalToolCalls: 5 });
    expect(firstEditPosition(calls)).toBe(3);
  });

  test("separates fixed overhead from dynamic result tokens", () => {
    const calls = [
      call({ tool: CTX, args: { task: "t" }, output: contextOutput([{ path: "a.py" }]) }),
      call({ tool: IMPACT, args: { symbol_fqn: "a.py::f" }, output: JSON.stringify({ resolvedSymbol: { fqName: "a.py::f" }, nodes: [] }) }),
    ];
    const accounting = accountVtraceTokens(extractVtraceCalls(calls), 1937, 128);
    expect(accounting.fixedSchemaTokens).toBe(1937);
    expect(accounting.fixedPolicyTokens).toBe(128);
    expect(accounting.callCount).toBe(2);
    expect(accounting.totalVtraceContextExposure)
      .toBe(1937 + 128 + accounting.dynamicResultTokens);
    expect(Object.keys(accounting.byTool).sort()).toEqual(["get_code_context", "get_impact_graph"]);
  });
});

describe("adoption state", () => {
  test("zero calls with tools available is NOT a failure", () => {
    const run = summarizeRun([call({ tool: "Grep" }), call({ tool: "Edit", path: "a.py" })], {
      toolsAvailable: true, fixedSchemaTokens: 1937, fixedPolicyTokens: 128,
    });
    expect(run.adoption).toBe("TOOLS_AVAILABLE_NOT_USED");
    expect(run.firstCallTiming).toBe("NEVER_USED");
  });

  test("unavailable tools are distinguished from unused tools", () => {
    const run = summarizeRun([call({ tool: "Grep" })], {
      toolsAvailable: false, fixedSchemaTokens: 0, fixedPolicyTokens: 0,
    });
    expect(run.adoption).toBe("TOOLS_UNAVAILABLE");
  });

  test("a full composed run summarizes end to end", () => {
    const calls = [
      call({ tool: "Grep", args: { pattern: "discount" } }),
      call({ tool: CTX, args: { task: "gold tier discount wrong" }, output: contextOutput([{ path: "pkg/core.py", fqName: "pkg/core.py::PriceEngine.apply_discount" }]) }),
      call({ tool: IMPACT, args: { symbol_fqn: "pkg/core.py::PriceEngine.apply_discount" }, output: JSON.stringify({ resolvedSymbol: { fqName: "pkg/core.py::PriceEngine.apply_discount" }, nodes: [{}] }) }),
      call({ tool: "Read", path: "pkg/core.py" }),
      call({ tool: "Edit", path: "pkg/core.py" }),
    ];
    const run = summarizeRun(calls, { toolsAvailable: true, fixedSchemaTokens: 1937, fixedPolicyTokens: 128 });

    expect(run.adoption).toBe("TOOLS_AVAILABLE_USED");
    expect(run.firstCallTiming).toBe("AFTER_REPO_SEARCH_BEFORE_READ");
    expect(run.calls).toHaveLength(2);
    expect(run.callsBeforeFirstEdit).toBe(2);
    expect(run.callsAfterFirstEdit).toBe(0);
    expect(run.composition[0]!.identifierFromReturnedFqName).toBe(true);
    expect(run.utilization[0]!.used).toBe(true);
    expect(run.redundantLookups).toEqual([]);
    expect(run.resultStateCounts.VALID_NONEMPTY).toBe(2);
    expect(run.navigation.firstEditPosition).toBe(4);
  });
});
