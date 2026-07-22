import { describe, expect, test } from "bun:test";
import type { OrderedToolCall } from "./m111_case_classifier";
import {
  classifyEnvironmentFailure,
  classifyVerificationCommand,
  isRelevantAssertionFailure,
  normalizeVerificationCommand,
  replayEnvironmentFailureLoop,
} from "./m116_env_failure_loop";

const bash = (index: number, command: string, output: string): OrderedToolCall => ({ index, tool: "Bash", command, output });
const edit = (index: number, file = "src/a.py"): OrderedToolCall => ({ index, tool: "Edit", path: file, output: "updated" });

describe("M116 E1 event extraction", () => {
  test("detects verification command families", () => {
    expect(classifyVerificationCommand("python -m pytest tests/test_a.py")).toBe("repo_test");
    expect(classifyVerificationCommand("python -c \"assert f() == 2\"")).toBe("local_oracle");
    expect(classifyVerificationCommand("python -m py_compile src/a.py")).toBe("lint_or_typecheck");
    expect(classifyVerificationCommand("sed -n '1,20p' src/a.py")).toBe("none");
  });

  test("keeps environment families distinct", () => {
    expect(classifyEnvironmentFailure("pip install x", "pip: command not found")).toBe("missing_pip");
    expect(classifyEnvironmentFailure("pip install x", "error: externally-managed-environment (PEP 668)")).toBe("pip_blocked_by_policy");
    expect(classifyEnvironmentFailure("python -m pytest", "ERROR collecting tests/test_a.py\nImportError: bad package")).toBe("pytest_collection_failure");
  });

  test("does not classify a genuine assertion failure as environment", () => {
    const output = "FAILED tests/test_a.py::test_value - AssertionError: expected 2 but got 1";
    expect(isRelevantAssertionFailure(output)).toBe(true);
    expect(classifyEnvironmentFailure("pytest tests/test_a.py", output)).toBeNull();
  });

  test("cosmetic shell changes normalize equivalently", () => {
    expect(normalizeVerificationCommand("python3 -m pytest tests/a.py 2>&1 | head -80"))
      .toBe(normalizeVerificationCommand("python -m pytest tests/a.py"));
  });
});

describe("M116 E1 state machine", () => {
  const missing = "Exit code 1\nModuleNotFoundError: No module named 'dep'";

  test("single failure does not fire", () => {
    const result = replayEnvironmentFailureLoop([bash(3, "python -m pytest tests/a.py", missing)]);
    expect(result.diagnosticState).toBe("ISOLATED_ENV_FAILURE");
    expect(result.wouldFire).toBe(false);
  });

  test("same failure repeated without progress fires deterministically", () => {
    const calls = [bash(3, "python -m pytest tests/a.py", missing), bash(7, "python3 -m pytest tests/a.py 2>&1", missing)];
    const first = replayEnvironmentFailureLoop(calls);
    const second = replayEnvironmentFailureLoop(calls);
    expect(first.wouldFire).toBe(true);
    expect(first.firstFireTurn).toBe(7);
    expect(second).toEqual(first);
  });

  test("repeated test after relevant source edit does not immediately fire", () => {
    const result = replayEnvironmentFailureLoop([
      bash(1, "python -m pytest tests/a.py", missing),
      edit(2),
      bash(3, "python -m pytest tests/a.py", missing),
    ]);
    expect(result.wouldFire).toBe(false);
    expect(result.progressResetCount).toBe(1);
  });

  test("successful local oracle resets and suppresses", () => {
    const result = replayEnvironmentFailureLoop([
      bash(1, "python -m pytest tests/a.py", missing),
      bash(2, "python -c \"print('Expected: 2'); print('Match: True')\"", "Expected: 2\nMatch: True"),
    ]);
    expect(result.diagnosticState).toBe("RECOVERED_AFTER_ENV_FAILURE");
    expect(result.successfulLocalOracleDetected).toBe(true);
    expect(result.wouldFire).toBe(false);
  });

  test("different meaningful hypothesis is not collapsed", () => {
    const result = replayEnvironmentFailureLoop([
      bash(1, "python -m pytest tests/a.py::test_a", missing),
      bash(2, "python -m pytest tests/b.py::test_b", missing),
    ]);
    expect(result.wouldFire).toBe(false);
    expect(result.diagnosticState).toBe("AMBIGUOUS");
    expect(result.analystReviewNeeded).toBe(true);
  });
});

describe("M116 split and input boundary", () => {
  test("chronological split integrity is 24/26/47", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.join(import.meta.dir, "results");
    const counts = ["m105", "m106", "m107", "m108"].map((m) => {
      const data = JSON.parse(fs.readFileSync(path.join(root, `stage5_${m}_live_runs.detail.json`), "utf8"));
      return data.cases.filter((row: { validity?: { valid?: boolean } }) => row.validity?.valid).length;
    });
    expect(counts).toEqual([14, 10, 26, 47]);
  });

  test("outcome and gold fields cannot enter detector input", () => {
    const descriptor = replayEnvironmentFailureLoop.toString();
    expect(descriptor).not.toMatch(/live_resolved|gold_patch|gold_files|eval_status/);
  });

  test("analyst override schema remains external to detector", () => {
    const review = { instance_id: "x", judgment: "productive_recovery", evidence_turns: [1, 2], rationale: "different oracle" };
    expect(Object.keys(review)).toEqual(["instance_id", "judgment", "evidence_turns", "rationale"]);
    expect(replayEnvironmentFailureLoop([bash(1, "pytest", "1 passed")]).analystReviewNeeded).toBe(false);
  });
});
