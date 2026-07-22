import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  aggregateByOutcome,
  classifyEnvFailure,
  classifyVerificationSignals,
  hasCommandFailureLoop,
  isRepoTestCommand,
  toCsv,
  type OutcomeAggregateRow,
} from "./m113_verification_oracle";
import type { OrderedToolCall } from "./m111_case_classifier";
import { M113_SMOKE_CASE_IDS } from "./run_stage5_m112_render_smoke";

const bash = (index: number, command: string, output: string, success?: boolean): OrderedToolCall => ({
  index,
  tool: "Bash",
  command,
  output,
  ...(success === undefined ? {} : { success } as object),
});

describe("M113 command classification", () => {
  test("detects repo test runners without treating py_compile as a test", () => {
    expect(isRepoTestCommand("python -m pytest tests/test_x.py")).toBe(true);
    expect(isRepoTestCommand("python tests/runtests.py auth_tests")).toBe(true);
    expect(isRepoTestCommand("python -m py_compile x.py")).toBe(false);
  });

  test("classifies missing-pip environment failures", () => {
    expect(classifyEnvFailure([bash(0, "pip install x", "pip: command not found", false)])).toBe("missing_pip");
    expect(classifyEnvFailure([bash(0, "python -c 'import x'", "ModuleNotFoundError: No module named 'x'", false)])).toBe("missing_dependency");
  });

  test("detects three consecutive semantic command failures", () => {
    expect(hasCommandFailureLoop([
      bash(0, "python -c x", "ImportError: x", false),
      bash(1, "pip install x", "command not found", false),
      bash(2, "python -c x", "No module named x", false),
    ])).toBe(true);
  });

  test("extracts repo-test, local-oracle, and short evidence signals", () => {
    const signals = classifyVerificationSignals([
      bash(0, "python -m pytest tests/test_x.py", "No module named pytest", true),
      bash(1, "python -c \"assert f('exact') == 2; print('PASS')\"", "PASS", true),
    ], "CHECK RUN: exact local reproduction passed");
    expect(signals.repoTestAttempted).toBe("yes");
    expect(signals.repoTestResult).toBe("failed_environment");
    expect(signals.localOracleAttempted).toBe("yes");
    expect(signals.localOracleType).toBe("property_assertion");
    expect(signals.successfulLocalOracle).toBe(true);
    expect(signals.evidenceQuotes.length).toBeGreaterThan(1);
  });
});

describe("M113 aggregates and schema", () => {
  const row = (resolved: boolean, quality: OutcomeAggregateRow["local_oracle_quality"]): OutcomeAggregateRow => ({
    live_resolved: resolved,
    local_oracle_quality: quality,
    verification_attempted: "yes",
    repo_test_attempted: "no",
    repo_test_result: "not_run",
    local_oracle_attempted: "yes",
    verification_failure_mode: resolved ? "none" : "wrong_oracle",
    primary_verification_cause: resolved ? "verification_sufficient" : "wrong_oracle",
  });

  test("separates resolved and unresolved oracle distributions", () => {
    const aggregate = aggregateByOutcome([row(true, "strong"), row(false, "wrong")]);
    expect(aggregate.overall.cases).toBe(2);
    expect(aggregate.resolved.oracle_quality.strong).toBe(1);
    expect(aggregate.unresolved.oracle_quality.wrong).toBe(1);
  });

  test("CSV preserves column order and escapes evidence", () => {
    expect(toCsv([{ instance_id: "x", evidence_quotes: ['a, "b"'] }], ["instance_id", "evidence_quotes"]))
      .toBe('instance_id,evidence_quotes\nx,"a, ""b"""\n');
  });

  test("generated JSON classifies all 97 valid rows with required analyst evidence", () => {
    const output = JSON.parse(readFileSync(join(import.meta.dir, "results", "stage5_m113_verification_classifications.json"), "utf8")) as {
      count: number;
      cases: Array<Record<string, unknown>>;
    };
    expect(output.count).toBe(97);
    expect(output.cases).toHaveLength(97);
    expect(new Set(output.cases.map((row) => row["instance_id"])).size).toBe(97);
    for (const row of output.cases) {
      expect(typeof row["instance_id"]).toBe("string");
      expect(["M105", "M106", "M107", "M108"]).toContain(row["milestone_source"]);
      expect(["strong", "medium", "weak", "wrong", "none", "unknown"]).toContain(row["local_oracle_quality"]);
      expect(["high", "medium", "low"]).toContain(row["confidence"]);
      expect(Array.isArray(row["evidence_quotes"])).toBe(true);
      expect((row["evidence_summary"] as unknown[]).length).toBeGreaterThan(1);
      expect((row["artifact_paths_used"] as unknown[]).length).toBeGreaterThan(2);
    }
  });

  test("M113 smoke set and generated detail cover the required offline strata", () => {
    expect(M113_SMOKE_CASE_IDS).toHaveLength(12);
    expect(M113_SMOKE_CASE_IDS).toContain("astropy__astropy-7166");
    expect(M113_SMOKE_CASE_IDS).toContain("sympy__sympy-15875");
    expect(M113_SMOKE_CASE_IDS).toContain("django__django-11740");
    const smoke = JSON.parse(readFileSync(join(import.meta.dir, "results", "stage5_m113_verification_wording_smoke.detail.json"), "utf8")) as {
      summary: Record<string, unknown>;
    };
    expect(smoke.summary["cases"]).toBe(12);
    expect(smoke.summary["all_invariants_hold"]).toBe(true);
    expect(smoke.summary["leak_unexplained_total"]).toBe(0);
    expect(smoke.summary["m113_wording_present_post_count"]).toBe(11);
  });
});
