import { describe, expect, test } from "bun:test";

import {
  FAMILY_VERDICTS,
  MediationFamily,
  NATIVE_BOUND_DISCLOSURE,
  NATIVE_PARTIAL_VIEW_MARKER,
  OperationIntent,
  Phase,
  SafetyClass,
  classifyIntent,
  isEnumerativePattern,
  isInvestigationIntent,
  parseOperations,
  pathsNamedByResult,
  readSpanOf,
} from "./m170Investigation";

// ── stream fixture ──────────────────────────────────────────────────

interface Step {
  readonly id: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly result: string;
  readonly isError?: boolean;
}

/** One assistant event per content block, exactly as streaming emits it. */
function streamFor(steps: readonly Step[]): string[] {
  const lines: string[] = [];
  steps.forEach((step, index) => {
    lines.push(JSON.stringify({
      type: "assistant",
      message: {
        id: `msg_${index}`,
        usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        content: [{ type: "tool_use", id: step.id, name: step.tool, input: step.input }],
      },
    }));
    lines.push(JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: step.id, content: step.result, is_error: step.isError === true }] },
    }));
  });
  return lines;
}

describe("intent classification", () => {
  test("a definition-shaped grep is a locate, not an enumeration", () => {
    expect(isEnumerativePattern("class ManagementUtility")).toBe(false);
    expect(isEnumerativePattern("def polyval")).toBe(false);
    expect(isEnumerativePattern("fowlkes_mallows_score")).toBe(false);
  });

  test("alternation and character classes are enumerations whatever they return", () => {
    expect(isEnumerativePattern("CdsHeader|CdsData")).toBe(true);
    expect(isEnumerativePattern("\\.method\\s*=.*\\.upper\\(\\)")).toBe(true);
    // One file today does not make it a locate: the agent asked for every site.
    expect(isEnumerativePattern("get_offset|ScalarFormatter")).toBe(true);
  });

  test("a Read is whole-file until the agent bounds it itself", () => {
    expect(classifyIntent("Read", { file_path: "a.py" })).toBe(OperationIntent.WholeFileRead);
    expect(classifyIntent("Read", { file_path: "a.py", offset: 10 })).toBe(OperationIntent.RegionRead);
    expect(classifyIntent("Read", { file_path: "a.py", limit: 40 })).toBe(OperationIntent.RegionRead);
  });

  test("Bash is read for what it does", () => {
    expect(classifyIntent("Bash", { command: "git blame -L 1920,1949 x.py" })).toBe(OperationIntent.ShellInspect);
    expect(classifyIntent("Bash", { command: "pip install -e ." })).toBe(OperationIntent.NotInvestigation);
    expect(classifyIntent("Bash", { command: "pytest -k foo | head" })).toBe(OperationIntent.NotInvestigation);
  });

  test("editing is not investigation", () => {
    expect(isInvestigationIntent(classifyIntent("Edit", { file_path: "a.py" }))).toBe(false);
    expect(isInvestigationIntent(OperationIntent.WholeFileRead)).toBe(true);
  });
});

describe("operation reconstruction", () => {
  test("pairs by tool_use_id and splits the trace at the first edit", () => {
    const operations = parseOperations(streamFor([
      { id: "t1", tool: "Grep", input: { pattern: "class Blueprint" }, result: "Found 1 file\nsrc/flask/blueprints.py" },
      { id: "t2", tool: "Read", input: { file_path: "/repo/src/flask/blueprints.py" }, result: "1\timport x\n2\tclass Blueprint:" },
      { id: "t3", tool: "Edit", input: { file_path: "/repo/src/flask/blueprints.py", old_string: "x" }, result: "ok" },
      { id: "t4", tool: "Read", input: { file_path: "/repo/src/flask/blueprints.py", offset: 5, limit: 10 }, result: "5\ty" },
    ]));
    expect(operations.map((o) => o.tool)).toEqual(["Grep", "Read", "Edit", "Read"]);
    expect(operations.map((o) => o.phase)).toEqual([
      Phase.PreFirstEdit, Phase.PreFirstEdit, Phase.PostFirstEdit, Phase.PostFirstEdit,
    ]);
    expect(operations[0]!.intent).toBe(OperationIntent.SymbolLocate);
    expect(operations[1]!.intent).toBe(OperationIntent.WholeFileRead);
    expect(operations[3]!.intent).toBe(OperationIntent.RegionRead);
  });

  test("a tool_use with no result is dropped rather than paired with a stranger's", () => {
    const lines = streamFor([
      { id: "t1", tool: "Grep", input: { pattern: "foo" }, result: "Found 1 file\na.py" },
    ]);
    lines.push(JSON.stringify({
      type: "assistant",
      message: { id: "msg_orphan", usage: {}, content: [{ type: "tool_use", id: "t_orphan", name: "Read", input: { file_path: "b.py" } }] },
    }));
    const operations = parseOperations(lines);
    expect(operations).toHaveLength(1);
    expect(operations[0]!.toolUseId).toBe("t1");
  });

  test("results are measured whole, and the harness's own banner is measured apart", () => {
    const banner = `<system-reminder>${NATIVE_PARTIAL_VIEW_MARKER} a.py: showing 10 of 900 lines.]</system-reminder>`;
    const operations = parseOperations(streamFor([
      { id: "t1", tool: "Read", input: { file_path: "a.py" }, result: `${banner}1\tx` },
    ]));
    expect(operations[0]!.nativePartialView).toBe(true);
    expect(operations[0]!.bannerCharacters).toBe(banner.length);
    expect(operations[0]!.resultCharacters).toBe(banner.length + 3);
  });

  test("an out-of-order sibling still answers its own call", () => {
    const lines: string[] = [];
    lines.push(JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_0", usage: {},
        content: [
          { type: "tool_use", id: "a", name: "Grep", input: { pattern: "one" } },
          { type: "tool_use", id: "b", name: "Read", input: { file_path: "two.py" } },
        ],
      },
    }));
    lines.push(JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "b", content: "1\ttwo" },
          { type: "tool_result", tool_use_id: "a", content: "Found 1 file\none.py" },
        ],
      },
    }));
    const operations = parseOperations(lines);
    expect(operations.map((o) => o.tool)).toEqual(["Read", "Grep"]);
  });
});

describe("result shapes", () => {
  test("Grep files_with_matches and content mode both yield their paths", () => {
    expect(pathsNamedByResult("Grep", "Found 2 files\na/b.py\nc/d.py")).toEqual(["a/b.py", "c/d.py"]);
    expect(pathsNamedByResult("Grep", "a/b.py:12:    def x():\na/b.py-13-      pass")).toEqual(["a/b.py"]);
    expect(pathsNamedByResult("Read", "1\tx")).toEqual([]);
  });

  test("a cat -n result reports the span it covers", () => {
    expect(readSpanOf("40\tfirst\n41\tsecond\n42\tthird")).toEqual({ first: 40, last: 42 });
    expect(readSpanOf("no line numbers here")).toBeNull();
  });
});

describe("frozen semantics", () => {
  test("Grep declares its own bound and Read does not — the asymmetry M170 turns on", () => {
    expect(NATIVE_BOUND_DISCLOSURE.Grep.selfDeclaring).toBe(true);
    expect(NATIVE_BOUND_DISCLOSURE.Glob.selfDeclaring).toBe(true);
    expect(NATIVE_BOUND_DISCLOSURE.Read.selfDeclaring).toBe(false);
  });

  test("read narrowing is classified unsafe before it is measured", () => {
    const read = FAMILY_VERDICTS.find((v) => v.family === MediationFamily.SymbolAwareRead);
    expect(read?.safety).toBe(SafetyClass.Unsafe);
    const search = FAMILY_VERDICTS.find((v) => v.family === MediationFamily.RankedSearch);
    expect(search?.safety).toBe(SafetyClass.SafeNarrowing);
    const graph = FAMILY_VERDICTS.find((v) => v.family === MediationFamily.SearchToGraph);
    expect(graph?.safety).toBe(SafetyClass.SafeAugmentation);
  });
});
