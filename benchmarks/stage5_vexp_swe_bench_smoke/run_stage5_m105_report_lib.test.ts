import { describe, expect, test } from "bun:test";

import {
  aggregateM105,
  assessRunValidity,
  behavioralGuardFired,
  changedFilesFromPatch,
  detectDrift,
  detectFallbackFire,
  extractResultRowMetrics,
  hostPipBlockCount,
  joinHistorical,
  median,
  p90,
  type M105CaseRow,
  type RunMeta,
} from "./run_stage5_m105_report_lib";
import { forbiddenArmsOn, mandatoryGuardsOff, M105_TREATMENT_CONTEXT_ARGV } from "./run_stage5_m105_preflight";
import { parseArgs } from "./run_stage5_vexp_swe_bench_smoke";

const CLEAN_META: RunMeta = {
  vtraceRequestedCapsuleEngine: "v2",
  vtraceEffectiveCapsuleEngine: "v2",
  vtraceCapsuleEngineFallbackReason: null,
  vtraceContextInjected: true,
  stage5_env_guard_status: "pass",
  stage5_env_guard_benchmark_valid: true,
  stage5_agent_shell_guard_status: "pass",
  stage5_unguarded_live_env_allowed: false,
  stage5_prefix_drift_summary: "not_run",
  stage5_blocked_host_package_command_count: 0,
  stage5_blocked_unsafe_pip_command_count: 0,
};

describe("M105 fallback-fire detector", () => {
  test("clean v2 run does not fire", () => {
    expect(detectFallbackFire(CLEAN_META)).toBe(false);
  });

  test("v2->legacy fallback fires on effective engine", () => {
    expect(
      detectFallbackFire({ ...CLEAN_META, vtraceEffectiveCapsuleEngine: "legacy", vtraceCapsuleEngineFallbackReason: "v2 query failed" }),
    ).toBe(true);
  });

  test("a fallback reason alone fires even if engines read v2", () => {
    expect(detectFallbackFire({ ...CLEAN_META, vtraceCapsuleEngineFallbackReason: "boom" })).toBe(true);
  });
});

describe("M105 drift / host-pip / behavioral-guard detectors", () => {
  test("not_run and clean overall are no-drift", () => {
    expect(detectDrift(CLEAN_META)).toBe(false);
    expect(detectDrift({ ...CLEAN_META, stage5_prefix_drift_summary: "overall=ok" })).toBe(false);
  });

  test("mismatch or SAFETY_FAILED is drift", () => {
    expect(detectDrift({ ...CLEAN_META, stage5_prefix_drift_summary: "overall=changed mismatch=2" })).toBe(true);
    expect(detectDrift({ ...CLEAN_META, stage5_prefix_drift_summary: "overall=fail SAFETY_FAILED" })).toBe(true);
  });

  test("host pip block count sums both counters", () => {
    expect(hostPipBlockCount(CLEAN_META)).toBe(0);
    expect(
      hostPipBlockCount({ ...CLEAN_META, stage5_blocked_host_package_command_count: 2, stage5_blocked_unsafe_pip_command_count: 1 }),
    ).toBe(3);
  });

  test("behavioral guard metadata is detected; its absence is clean", () => {
    expect(behavioralGuardFired(CLEAN_META)).toBe(false);
    expect(behavioralGuardFired({ ...CLEAN_META, cost_guard_fired: true })).toBe(true);
    expect(behavioralGuardFired({ ...CLEAN_META, tool_loop_guard_mode: "inject" })).toBe(true);
  });
});

describe("M105 run validity", () => {
  const base = {
    meta: CLEAN_META,
    hasResultRow: true,
    resultRowParses: true,
    unexplainedLeakCount: 0,
    revisionArtifactNames: [] as string[],
    preflightPassed: true,
  };

  test("clean guarded run is valid", () => {
    const v = assessRunValidity(base);
    expect(v.valid).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  test("fallback fire invalidates", () => {
    const v = assessRunValidity({ ...base, meta: { ...CLEAN_META, vtraceEffectiveCapsuleEngine: "legacy" } });
    expect(v.valid).toBe(false);
    expect(v.fallback_fired).toBe(true);
  });

  test("unguarded escape hatch invalidates", () => {
    const v = assessRunValidity({ ...base, meta: { ...CLEAN_META, stage5_unguarded_live_env_allowed: true } });
    expect(v.valid).toBe(false);
    expect(v.unguarded_used).toBe(true);
  });

  test("unexplained leakage invalidates; missing snapshot invalidates", () => {
    expect(assessRunValidity({ ...base, unexplainedLeakCount: 1 }).valid).toBe(false);
    expect(assessRunValidity({ ...base, unexplainedLeakCount: null }).valid).toBe(false);
  });

  test("revision/corrective artifacts invalidate", () => {
    const v = assessRunValidity({ ...base, revisionArtifactNames: ["_pivot_revision.json"] });
    expect(v.valid).toBe(false);
    expect(v.revision_artifacts_present).toBe(true);
  });

  test("a no-patch outcome is still valid (normal agent failure)", () => {
    expect(assessRunValidity(base).valid).toBe(true);
  });
});

describe("M105 result-row metrics", () => {
  test("extracts tokens/cost/changed files", () => {
    const row = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 1000,
      cacheCreationTokens: 10,
      costUsd: 0.5,
      numTurns: 7,
      resolved: true,
      modelPatch: "diff --git a/x/a.py b/x/a.py\n--- a/x/a.py\n+++ b/x/a.py\ndiff --git a/y/b.py b/y/b.py\n",
    };
    const m = extractResultRowMetrics(row, 12);
    expect(m.total_tokens).toBe(1160);
    expect(m.changed_files).toEqual(["x/a.py", "y/b.py"]);
    expect(m.patch_produced).toBe(true);
    expect(m.resolved).toBe(true);
    expect(m.tool_calls).toBe(12);
  });

  test("empty patch is a no-patch outcome and resolved may be unknown", () => {
    const m = extractResultRowMetrics({ modelPatch: "", costUsd: 0.1 }, null);
    expect(m.patch_produced).toBe(false);
    expect(m.changed_files).toEqual([]);
    expect(m.resolved).toBeNull();
  });

  test("changedFilesFromPatch dedupes", () => {
    expect(changedFilesFromPatch("diff --git a/a.py b/a.py\ndiff --git a/a.py b/a.py\n")).toEqual(["a.py"]);
  });
});

describe("M105 aggregation", () => {
  test("median/p90 on tiny samples", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(p90([])).toBeNull();
    expect(p90([5])).toBe(5);
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
  });

  test("aggregates counts, spend, and safety tallies", () => {
    const validity = (over: Partial<ReturnType<typeof assessRunValidity>>) => ({
      valid: true,
      reasons: [],
      fallback_fired: false,
      env_guard_pass: true,
      shell_guard_pass: true,
      unguarded_used: false,
      drift_detected: false,
      host_pip_block_count: 0,
      behavioral_guard_fired: false,
      revision_artifacts_present: false,
      ...over,
    });
    const metrics = (cost: number, tokens: number, resolved: boolean | null, patch = true) => ({
      resolved,
      patch_produced: patch,
      changed_files: [],
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: tokens,
      cache_creation_tokens: 0,
      total_tokens: tokens,
      cost_usd: cost,
      num_turns: null,
      tool_calls: 3,
    });
    const rows: M105CaseRow[] = [
      { instance_id: "a", preflight_status: "pass", live_status: "valid", eval_status: "evaluated", validity: validity({}), metrics: metrics(1, 100, true) },
      { instance_id: "b", preflight_status: "pass", live_status: "valid", eval_status: "evaluated", validity: validity({}), metrics: metrics(2, 200, false, false) },
      { instance_id: "c", preflight_status: "pass", live_status: "invalid", eval_status: "not_applicable", validity: validity({ valid: false, reasons: ["v2->legacy capsule fallback fired"], fallback_fired: true }), metrics: metrics(3, 300, null) },
      { instance_id: "d", preflight_status: "fail", live_status: "not_attempted", eval_status: "not_applicable", validity: null, metrics: null },
    ];
    const agg = aggregateM105(rows, 0);
    expect(agg.live_started_count).toBe(3);
    expect(agg.live_valid_count).toBe(2);
    expect(agg.eval_completed_count).toBe(2);
    expect(agg.resolved_count).toBe(1);
    expect(agg.resolution_rate).toBe(0.5);
    expect(agg.patch_produced_count).toBe(2);
    expect(agg.no_patch_count).toBe(1);
    expect(agg.invalid_count).toBe(1);
    expect(agg.invalid_reasons.c).toEqual(["v2->legacy capsule fallback fired"]);
    expect(agg.cost_usd).toBe(6);
    expect(agg.total_tokens).toBe(600);
    expect(agg.tool_calls).toBe(9);
    expect(agg.fallback_fire_count).toBe(1);
    expect(agg.env_guard_fail_count).toBe(0);
  });
});

describe("M105 historical join", () => {
  test("joins M73/M92/M103/M104 with nulls for absent rows", () => {
    const j = joinHistorical("x", { treatment_resolved: true, baseline_resolved: false }, undefined, "good", true);
    expect(j.m73_treatment_resolved).toBe(true);
    expect(j.m73_baseline_resolved).toBe(false);
    expect(j.m92_resolved).toBeNull();
    expect(j.m103_outcome).toBe("good");
    expect(j.m104_preflight_leak_clean).toBe(true);
    const none = joinHistorical("y", undefined, false, undefined, undefined);
    expect(none.m73_treatment_resolved).toBeNull();
    expect(none.m92_resolved).toBe(false);
    expect(none.m103_outcome).toBeNull();
  });
});

describe("M105 treatment argv contract", () => {
  test("parsed M105 treatment config has all forbidden arms off and mandatory guards on", () => {
    const config = parseArgs([...M105_TREATMENT_CONTEXT_ARGV]);
    expect(forbiddenArmsOn(config)).toEqual([]);
    expect(mandatoryGuardsOff(config)).toEqual([]);
    expect(config.capsuleEngine).toBe("v2");
    expect(config.capsuleIntent).toBe("debug");
    expect(config.capsuleBudget).toBe(8000);
    expect(config.contextPolicyOverride).toBe("force-inject");
    expect(config.injectCapsuleDigest).toBe(true);
    expect(config.digestDecisionContract).toBe(true);
    expect(config.boundedDigestDecisions).toBe(true);
    expect(config.compactDigestInjection).toBe(true);
    expect(config.pivotConfidenceGate).toBe(true);
    expect(config.disablePivotCheck).toBe(false);
  });

  test("forbidden arms are reported when configured", () => {
    const config = parseArgs([...M105_TREATMENT_CONTEXT_ARGV, "--pivot-inspection-enforcement", "--pivot-revision-pass"]);
    expect(forbiddenArmsOn(config)).toEqual(["pivotInspectionEnforcement", "pivotRevisionPass"]);
  });
});
