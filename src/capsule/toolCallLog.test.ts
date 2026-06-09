import assert from "node:assert/strict";
import { test } from "bun:test";

import { classifyPivotInspection, type PivotForInspection } from "./finalEditDiagnostics";
import {
  inspectionCallsFromLog,
  parseOrderedToolCalls,
  toInspectionToolCalls,
  toolCategory,
} from "./toolCallLog";

const AST_PIVOT: PivotForInspection = {
  path: "sphinx/pycode/ast.py",
  symbol: "unparse",
  role: "pivot",
  hidden: true,
};

// A representative Claude Code stream-json transcript: an assistant turn that
// reads a file, a top-level grep tool_use with its result, and an edit.
function streamLines(lines: object[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n");
}

test("toolCategory normalizes differing tool names into internal categories", () => {
  assert.equal(toolCategory("Read"), "read");
  assert.equal(toolCategory("open"), "read");
  assert.equal(toolCategory("Grep"), "search");
  assert.equal(toolCategory("ripgrep"), "search");
  assert.equal(toolCategory("Edit"), "edit");
  assert.equal(toolCategory("MultiEdit"), "edit");
  assert.equal(toolCategory("Bash"), "other");
});

test("parseOrderedToolCalls extracts ordered calls with targets, queries, and output", () => {
  const stream = streamLines([
    { type: "system", subtype: "init" },
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "looking" },
          { type: "tool_use", name: "Read", input: { file_path: "sphinx/pycode/ast.py" } },
        ],
      },
    },
    { type: "tool_use", name: "Grep", input: { pattern: "unparse", path: "sphinx" } },
    { type: "tool_result", content: "sphinx/pycode/ast.py:42: def unparse(node):" },
    { type: "result", total_cost_usd: 0.1 },
  ]);

  const calls = parseOrderedToolCalls(stream);
  assert.equal(calls.length, 2);

  assert.deepEqual(
    { index: calls[0]!.index, tool: calls[0]!.tool, category: calls[0]!.category, path: calls[0]!.path },
    { index: 0, tool: "Read", category: "read", path: "sphinx/pycode/ast.py" },
  );

  assert.equal(calls[1]!.tool, "Grep");
  assert.equal(calls[1]!.category, "search");
  assert.equal(calls[1]!.query, "unparse");
  // The following tool_result is attached as the grep's output.
  assert.ok(calls[1]!.output_summary?.includes("sphinx/pycode/ast.py"));
});

test("parseOrderedToolCalls is tolerant of non-JSON / empty lines", () => {
  const stream = ["", "not json", JSON.stringify({ type: "tool_use", name: "Read", input: { file_path: "a.py" } }), ""].join(
    "\n",
  );
  const calls = parseOrderedToolCalls(stream);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, "a.py");
});

test("read/open calls normalize to inspected", () => {
  const stream = streamLines([
    { type: "tool_use", name: "Read", input: { file_path: "sphinx/pycode/ast.py" } },
  ]);
  const calls = toInspectionToolCalls(parseOrderedToolCalls(stream));
  const [record] = classifyPivotInspection([AST_PIVOT], calls, []);
  assert.equal(record!.inspected, true);
  assert.equal(record!.discovered, false);
  assert.equal(record!.status, "inspected");
});

test("grep/search calls normalize to discovered only (not inspected)", () => {
  const stream = streamLines([
    { type: "tool_use", name: "Grep", input: { pattern: "unparse" } },
    { type: "tool_result", content: "sphinx/pycode/ast.py:42: def unparse(node):" },
  ]);
  const calls = toInspectionToolCalls(parseOrderedToolCalls(stream));
  const [record] = classifyPivotInspection([AST_PIVOT], calls, []);
  assert.equal(record!.discovered, true);
  assert.equal(record!.inspected, false);
  // Search visibility is not engagement.
  assert.equal(record!.status, "ignored");
});

test("classifier over an ordered log still leaks no gold labels", () => {
  // The agent grepped for and edited the WRONG file; the real pivot (ast.py) was
  // only surfaced in search output. No gold knowledge can promote it.
  const stream = streamLines([
    { type: "tool_use", name: "Grep", input: { pattern: "annotation" } },
    { type: "tool_result", content: "sphinx/domains/python.py:117 sphinx/pycode/ast.py:42" },
    { type: "tool_use", name: "Edit", input: { file_path: "sphinx/domains/python.py" } },
  ]);
  const calls = toInspectionToolCalls(parseOrderedToolCalls(stream));
  const [record] = classifyPivotInspection([AST_PIVOT], calls, ["sphinx/domains/python.py"]);
  assert.equal(record!.inspected, false);
  assert.equal(record!.edited, false);
  assert.equal(record!.status, "ignored");
});

test("inspectionCallsFromLog coerces a persisted _tool_calls.json array", () => {
  const log = [
    { index: 0, tool: "Read", category: "read", path: "sphinx/pycode/ast.py", query: null, output_summary: null },
    { index: 1, tool: "Grep", category: "search", path: null, query: "unparse", output_summary: "x ast.py y" },
  ];
  const calls = inspectionCallsFromLog(log);
  assert.ok(calls);
  assert.equal(calls!.length, 2);
  assert.equal(calls![0]!.target, "sphinx/pycode/ast.py");
  // output falls back to the query when no output_summary is present.
  assert.equal(calls![1]!.output, "x ast.py y");
});

test("inspectionCallsFromLog returns null for a non-array (absent/invalid log)", () => {
  assert.equal(inspectionCallsFromLog(null), null);
  assert.equal(inspectionCallsFromLog({ not: "an array" }), null);
});
