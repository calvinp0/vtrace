import { describe, expect, test } from "bun:test";
import type { OrderedToolCall } from "./m111_case_classifier";
import {
  classifyFailureRoot,
  classifyVerificationStrategy,
  normalizeStrategyCommand,
  replayEnvironmentLoopV2,
} from "./m117_env_loop_v2";

const bash = (index: number, command: string, output: string): OrderedToolCall => ({ index, tool: "Bash", command, output });
const edit = (index: number, file = "src/a.py"): OrderedToolCall => ({ index, tool: "Edit", path: file, output: "updated" });
const missing = "Exit code 1\nModuleNotFoundError: No module named 'dep'";

describe("M117 failure-root and verification-strategy classification", () => {
  test("classifies roots separately from strategies", () => {
    expect(classifyFailureRoot("pip install dep", "pip: command not found")).toBe("package_manager_unavailable");
    expect(classifyFailureRoot("python -m pytest", "/usr/bin/python: No module named pytest")).toBe("test_runner_unavailable");
    expect(classifyFailureRoot("python -c 'import dep'", missing)).toBe("dependency_unavailable");
    expect(classifyVerificationStrategy("python -m pytest tests/test_a.py")).toBe("focused_repo_test");
    expect(classifyVerificationStrategy("pip install dep")).toBe("dependency_installation");
  });

  test("distinguishes repo tests from standalone oracles", () => {
    expect(classifyVerificationStrategy("pytest tests/test_a.py::test_x")).toBe("focused_repo_test");
    expect(classifyVerificationStrategy("python -c \"assert f(2) == 3; print('PASS')\"")).toBe("standalone_behavioral_oracle");
  });

  test("cosmetic commands collapse but different focused tests remain distinct", () => {
    expect(normalizeStrategyCommand("python3 -m pytest ./tests/test_a.py 2>&1 | head -20"))
      .toBe(normalizeStrategyCommand("pytest tests/test_a.py"));
    expect(normalizeStrategyCommand("pytest tests/test_a.py::test_one"))
      .not.toBe(normalizeStrategyCommand("pytest tests/test_a.py::test_two"));
  });
});

describe("M117 strategy-aware episode state", () => {
  test("strategy transition opens a recovery opportunity", () => {
    const result = replayEnvironmentLoopV2([
      bash(1, "pytest tests/test_a.py", missing),
      bash(2, "python -c \"assert issue_logic() == 2\"", missing),
    ]);
    expect(result.productiveTransitionTurns).toContain(2);
    expect(result.wouldFire).toBe(false);
  });

  test("source edit allows one new verification attempt", () => {
    const result = replayEnvironmentLoopV2([
      bash(1, "python -c \"import project\"", missing),
      edit(2),
      bash(3, "python -c \"import project\"", missing),
    ]);
    expect(result.sourceEditAllowances).toBe(1);
    expect(result.wouldFire).toBe(false);
  });

  test("test or oracle edit allows one new verification attempt", () => {
    const result = replayEnvironmentLoopV2([
      bash(1, "pytest tests/test_a.py", missing),
      edit(2, "tests/test_a.py"),
      bash(3, "pytest tests/test_a.py", missing),
    ]);
    expect(result.oracleEditAllowances).toBe(1);
    expect(result.wouldFire).toBe(false);
  });

  test("successful oracle prevents every later fire", () => {
    const result = replayEnvironmentLoopV2([
      bash(1, "pytest tests/test_a.py", missing),
      bash(2, "python -c \"assert f(2) == 3; print('PASS')\"", "PASS"),
      bash(3, "pytest tests/test_a.py", missing),
      bash(4, "pytest tests/test_a.py", missing),
    ]);
    expect(result.diagnosticState).toBe("RECOVERED");
    expect(result.recoveryProtected).toBe(true);
    expect(result.wouldFire).toBe(false);
  });

  test("does not fire immediately before an observable standalone oracle", () => {
    const result = replayEnvironmentLoopV2([
      bash(1, "pip install dep", "pip: command not found"),
      bash(2, "python -m pip install dep", "No module named pip"),
      bash(3, "python -c \"assert exact_logic('x') == 'y'; print('Match: True')\"", "Match: True"),
    ]);
    expect(result.pendingCandidateSuppressedByOracle).toBe(true);
    expect(result.wouldFire).toBe(false);
  });

  test("same-strategy repeated failure fires", () => {
    const result = replayEnvironmentLoopV2([
      bash(1, "python -c \"import project\"", missing),
      bash(2, "python3 -c \"import project\" 2>&1", missing),
    ]);
    expect(result.wouldFire).toBe(true);
    expect(result.firstFireTurn).toBe(2);
    expect(result.loopKind).toBe("same_strategy");
  });

  test("dependency-install loop fires", () => {
    const result = replayEnvironmentLoopV2([
      bash(1, "pip install dep", "pip: command not found"),
      bash(2, "python -m pip install dep", "No module named pip"),
    ]);
    expect(result.wouldFire).toBe(true);
    expect(result.loopKind).toBe("same_strategy");
  });

  test("single attempt does not fire", () => {
    expect(replayEnvironmentLoopV2([bash(1, "pytest tests/test_a.py", missing)]).wouldFire).toBe(false);
  });

  test("replay is deterministic", () => {
    const calls = [bash(1, "pytest tests/test_a.py", missing), bash(2, "pytest tests/test_a.py", missing)];
    expect(replayEnvironmentLoopV2(calls)).toEqual(replayEnvironmentLoopV2(calls));
  });
});

describe("M117 detector input boundary", () => {
  test("resolution and gold data are excluded", () => {
    const source = replayEnvironmentLoopV2.toString();
    expect(source).not.toMatch(/live_resolved|resolved|gold_patch|gold_files|eval_status/);
  });

  test("leave-one-milestone-out source counts remain 14/10/26/47", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.join(import.meta.dir, "results");
    const counts = ["m105", "m106", "m107", "m108"].map((milestone) => {
      const detail = JSON.parse(fs.readFileSync(path.join(root, `stage5_${milestone}_live_runs.detail.json`), "utf8"));
      return detail.cases.filter((row: { validity?: { valid?: boolean } }) => row.validity?.valid).length;
    });
    expect(counts).toEqual([14, 10, 26, 47]);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(97);
  });

  test("comparison schema includes both detector versions", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const csv = fs.readFileSync(path.join(import.meta.dir, "results", "stage5_m117_env_loop_v1_v2_comparison.csv"), "utf8").trim().split("\n");
    expect(csv[0]).toContain("e1_v1_would_fire");
    expect(csv[0]).toContain("e1_v2_would_fire");
    expect(csv).toHaveLength(98);
  });

  test("leave-one-milestone-out report uses one frozen rule across four complete folds", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const audit = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "results", "stage5_m117_env_loop_v2_audit.json"), "utf8"));
    const folds = audit.evaluation_constraint.leave_one_milestone_out;
    expect(folds).toHaveLength(4);
    expect(folds.every((fold: { rule_identical: boolean; rule_version: string }) => fold.rule_identical && fold.rule_version === "e1-v2")).toBe(true);
    expect(folds.reduce((sum: number, fold: { inspection: { cases: number } }) => sum + fold.inspection.cases, 0)).toBe(97);
    expect(audit.evaluation_constraint.untouched_holdout_available).toBe(false);
  });
});
