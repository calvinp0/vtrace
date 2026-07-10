import { describe, expect, test } from "bun:test";
import {
  classifyEditedGold,
  classifyPatchShape,
  classifyTestBehavior,
  csvEscape,
  isTestCommand,
  isTestFile,
  runFolderLabel,
  toCsv,
  toolLoopSignatures,
  type OrderedToolCall,
} from "./m111_case_classifier";

const bash = (index: number, command: string, output?: string): OrderedToolCall => ({
  index,
  tool: "Bash",
  args: { command },
  ...(output === undefined ? {} : { output }),
});
const read = (index: number, file: string): OrderedToolCall => ({
  index,
  tool: "Read",
  args: { file_path: file },
});
const edit = (index: number, file: string): OrderedToolCall => ({
  index,
  tool: "Edit",
  args: { file_path: file },
});
const grep = (index: number, pattern: string): OrderedToolCall => ({
  index,
  tool: "Grep",
  args: { pattern },
});

describe("isTestFile", () => {
  test("detects tests directories and test_ prefixes", () => {
    expect(isTestFile("tests/auth_tests/test_tokens.py")).toBe(true);
    expect(isTestFile("src/pkg/tests/helpers.py")).toBe(true);
    expect(isTestFile("testing/test_collection.py")).toBe(true);
    expect(isTestFile("django/contrib/auth/tokens.py")).toBe(false);
  });
});

describe("classifyEditedGold", () => {
  test("full gold coverage", () => {
    expect(classifyEditedGold(["a.py"], ["a.py"])).toEqual({
      agentEditedGoldFile: "yes",
      agentEditedNonGoldFile: "no",
    });
  });
  test("partial gold coverage on multi-file gold", () => {
    expect(classifyEditedGold(["a.py"], ["a.py", "b.py"]).agentEditedGoldFile).toBe("partial");
  });
  test("no gold edited", () => {
    expect(classifyEditedGold(["c.py"], ["a.py"]).agentEditedGoldFile).toBe("no");
    expect(classifyEditedGold(["c.py"], ["a.py"]).agentEditedNonGoldFile).toBe("yes");
  });
  test("unknown gold stays unknown", () => {
    expect(classifyEditedGold(["c.py"], []).agentEditedGoldFile).toBe("unknown");
  });
});

describe("classifyPatchShape", () => {
  test("no patch", () => {
    expect(classifyPatchShape([], ["a.py"], false)).toBe("no_patch");
  });
  test("test-only patch", () => {
    expect(classifyPatchShape(["tests/test_x.py"], ["a.py"], false)).toBe("test_only_patch");
  });
  test("wrong file patch", () => {
    expect(classifyPatchShape(["z.py"], ["a.py"], false)).toBe("wrong_file_patch");
  });
  test("single-file patch on multi-file gold (xarray-6938 shape)", () => {
    expect(
      classifyPatchShape(["xarray/core/dataset.py"], ["xarray/core/dataset.py", "xarray/core/variable.py"], false),
    ).toBe("single_file_patch");
  });
  test("correct file wrong logic when all gold edited but eval failed", () => {
    expect(classifyPatchShape(["a.py"], ["a.py"], false)).toBe("correct_file_wrong_logic");
  });
  test("resolved exact-gold single file is single_file_patch", () => {
    expect(classifyPatchShape(["a.py"], ["a.py"], true)).toBe("single_file_patch");
  });
  test("gold plus one extra file is multi_file_patch (mpl-24627 shape)", () => {
    expect(classifyPatchShape(["a.py", "b.py"], ["a.py"], false)).toBe("multi_file_patch");
  });
  test("gold plus two extras is overbroad", () => {
    expect(classifyPatchShape(["a.py", "b.py", "c.py"], ["a.py"], false)).toBe("overbroad_patch");
  });
  test("multi-changed partial gold coverage is partial_patch", () => {
    expect(classifyPatchShape(["a.py", "z.py"], ["a.py", "b.py"], false)).toBe("partial_patch");
  });
  test("unknown gold falls back to file count", () => {
    expect(classifyPatchShape(["a.py"], [], false)).toBe("single_file_patch");
  });
});

describe("toolLoopSignatures", () => {
  test("clean run yields none", () => {
    expect(toolLoopSignatures([read(0, "a.py"), edit(1, "a.py")])).toEqual(["none"]);
  });
  test("repeated read of the same file without edits", () => {
    const calls = [read(0, "a.py"), read(1, "a.py"), read(2, "a.py"), read(3, "a.py")];
    expect(toolLoopSignatures(calls)).toContain("repeated_read");
  });
  test("edit resets the repeated-read counter", () => {
    const calls = [read(0, "a.py"), read(1, "a.py"), edit(2, "a.py"), read(3, "a.py"), read(4, "a.py")];
    expect(toolLoopSignatures(calls)).toEqual(["none"]);
  });
  test("edit churn on one file", () => {
    const calls = [edit(0, "a.py"), edit(1, "a.py"), edit(2, "a.py")];
    expect(toolLoopSignatures(calls)).toContain("edit_churn");
  });
  test("consecutive failing bash commands (env-failure loop)", () => {
    const calls = [
      bash(0, "pip install x", "Exit code 127\npip: command not found"),
      bash(1, "python -c 'import x'", "ModuleNotFoundError: No module named 'x'"),
      bash(2, "python3 -m pip install x", "Exit code 1"),
    ];
    expect(toolLoopSignatures(calls)).toContain("command_failure_loop");
  });
  test("a succeeding bash call resets the failure run", () => {
    const calls = [
      bash(0, "x", "Exit code 1"),
      bash(1, "echo ok", "ok"),
      bash(2, "x", "Exit code 1"),
      bash(3, "x", "ModuleNotFoundError"),
    ];
    expect(toolLoopSignatures(calls)).toEqual(["none"]);
  });
  test("repeated identical search pattern", () => {
    const calls = [grep(0, "def foo"), grep(1, "def foo"), grep(2, "def foo")];
    expect(toolLoopSignatures(calls)).toContain("repeated_search");
  });
  test("cost cap proxy from cost or turns", () => {
    expect(toolLoopSignatures([], { costUsd: 3.0 })).toContain("cost_cap");
    expect(toolLoopSignatures([], { numTurns: 93 })).toContain("cost_cap");
  });
  test("no-patch exhaustion requires empty patch and no edits", () => {
    expect(toolLoopSignatures([read(0, "a.py")], { patchEmpty: true })).toContain("no_patch_exhaustion");
    expect(toolLoopSignatures([edit(0, "a.py")], { patchEmpty: false })).toEqual(["none"]);
  });
});

describe("classifyTestBehavior", () => {
  test("no bash at all", () => {
    expect(classifyTestBehavior([read(0, "a.py")], false)).toBe("no_tests_run");
  });
  test("all repro/test attempts fail on env (loss-case pattern)", () => {
    const calls = [
      bash(0, "python -c 'import django'", "ModuleNotFoundError: No module named 'distutils'"),
      bash(1, "python tests/runtests.py auth", "RuntimeError: Django module not found"),
    ];
    expect(classifyTestBehavior(calls, false)).toBe("test_command_failed_infra");
  });
  test("a passing check followed by failed eval", () => {
    const calls = [bash(0, "python3 -c 'print(1)'", "All tests passed!")];
    expect(classifyTestBehavior(calls, false)).toBe("relevant_tests_passed_but_eval_failed");
  });
  test("a passing standalone check on a resolved run is irrelevant_tests_run", () => {
    const calls = [bash(0, "python3 -c 'print(1)'", "All tests passed!")];
    expect(classifyTestBehavior(calls, true)).toBe("irrelevant_tests_run");
  });
  test("with-outputs top-level command field is honored", () => {
    const call: OrderedToolCall = {
      index: "0",
      tool: "Bash",
      command: "python -m pytest tests/x.py",
      output: "ModuleNotFoundError: No module named 'pytest'",
    };
    expect(classifyTestBehavior([call], false)).toBe("test_command_failed_infra");
  });
  test("missing outputs give unknown", () => {
    expect(classifyTestBehavior([bash(0, "python -m pytest tests/")], false)).toBe("unknown");
  });
  test("isTestCommand matches harness/test runners", () => {
    expect(isTestCommand("python -m pytest tests/x.py")).toBe(true);
    expect(isTestCommand("python tests/runtests.py auth -v 0")).toBe(true);
    expect(isTestCommand("ls -la")).toBe(false);
  });
});

describe("runFolderLabel", () => {
  test("m106-m108 live-ext labels", () => {
    expect(runFolderLabel("pydata__xarray-6938", "m106")).toBe("m106_live_ext_pydata__xarray_6938_");
    expect(runFolderLabel("django__django-11490", "m108")).toBe("m108_live_ext_django__django_11490_");
  });
  test("m105 small-live labels", () => {
    expect(runFolderLabel("sympy__sympy-13372", "m105")).toBe("m105_small_live_sympy__sympy_13372_");
  });
});

describe("csv", () => {
  test("escapes quotes, commas and newlines", () => {
    expect(csvEscape('a "b", c')).toBe('"a ""b"", c"');
    expect(csvEscape("x\ny")).toBe('"x\ny"');
    expect(csvEscape(null)).toBe("");
  });
  test("toCsv joins arrays with pipes and keeps column order", () => {
    const csv = toCsv([{ a: 1, b: ["x", "y"] }], ["a", "b"]);
    expect(csv).toBe("a,b\n1,x|y\n");
  });
});
