import { describe, expect, test } from "bun:test";

import type { M105CaseRow, ResultRowMetrics, RunValidity } from "./run_stage5_m105_report_lib";
import type { M106SelectionCandidate } from "./run_stage5_m106_lib";
import {
  M108_EXPECTED_REMAINING,
  M108_EXTENSION_PAUSE_CAP_USD,
  aggregateCombined100,
  m108Phase,
  selectM108RemainingCases,
  spendCapStatus,
} from "./run_stage5_m108_lib";

// ---------------------------------------------------------------------------
// selectM108RemainingCases
// ---------------------------------------------------------------------------

function candidate(overrides: Partial<M106SelectionCandidate> & { instance_id: string }): M106SelectionCandidate {
  return {
    repo: "org/repo",
    m103_outcome: "excellent",
    multi_file: false,
    scored: true,
    m73_treatment_valid: true,
    m73_treatment_resolved: false,
    in_m92: false,
    in_holdout: false,
    ...overrides,
  };
}

describe("selectM108RemainingCases", () => {
  test("selects the exact complement of the committed sets, nothing sampled away", () => {
    const candidates = [
      candidate({ instance_id: "committed_a" }),
      candidate({ instance_id: "committed_b" }),
      candidate({ instance_id: "rem_1", m103_outcome: "miss" }),
      candidate({ instance_id: "rem_2", m103_outcome: "overpacked" }),
    ];
    const result = selectM108RemainingCases(candidates, new Set(["committed_a", "committed_b"]));
    expect(result.selected.map((s) => s.instance_id).sort()).toEqual(["rem_1", "rem_2"]);
    expect(result.rejected).toEqual([]);
  });

  test("orders M92-overlap cases first, then instance_id ascending", () => {
    const candidates = [
      candidate({ instance_id: "zzz_m92", in_m92: true }),
      candidate({ instance_id: "aaa_plain" }),
      candidate({ instance_id: "mmm_m92", in_m92: true }),
      candidate({ instance_id: "bbb_plain" }),
    ];
    const result = selectM108RemainingCases(candidates, new Set());
    expect(result.selected.map((s) => s.instance_id)).toEqual(["mmm_m92", "zzz_m92", "aaa_plain", "bbb_plain"]);
  });

  test("stratum is the reporting-only remaining_<m103_outcome> label", () => {
    const result = selectM108RemainingCases(
      [candidate({ instance_id: "x", m103_outcome: "wrong_pivot" }), candidate({ instance_id: "y", m103_outcome: null })],
      new Set(),
    );
    expect(result.selected.find((s) => s.instance_id === "x")?.stratum).toBe("remaining_wrong_pivot");
    expect(result.selected.find((s) => s.instance_id === "y")?.stratum).toBe("remaining_unknown");
  });

  test("an unscored pool row is rejected with a reason, never silently dropped", () => {
    const result = selectM108RemainingCases(
      [candidate({ instance_id: "unscored", scored: false }), candidate({ instance_id: "ok" })],
      new Set(),
    );
    expect(result.selected.map((s) => s.instance_id)).toEqual(["ok"]);
    expect(result.rejected).toEqual([
      { instance_id: "unscored", reason: "M103 detail incomplete (not scored / no derivation)" },
    ]);
  });

  test("the pre-registered remaining count is 50", () => {
    expect(M108_EXPECTED_REMAINING).toBe(50);
  });
});

describe("m108Phase", () => {
  test("assigns A=1-8, B=9-22, C=23-36, D=37-50 over selection order", () => {
    const phases = Array.from({ length: 50 }, (_, i) => m108Phase(i));
    expect(phases.filter((p) => p === "A")).toHaveLength(8);
    expect(phases.filter((p) => p === "B")).toHaveLength(14);
    expect(phases.filter((p) => p === "C")).toHaveLength(14);
    expect(phases.filter((p) => p === "D")).toHaveLength(14);
    expect(phases[0]).toBe("A");
    expect(phases[7]).toBe("A");
    expect(phases[8]).toBe("B");
    expect(phases[21]).toBe("B");
    expect(phases[22]).toBe("C");
    expect(phases[35]).toBe("C");
    expect(phases[36]).toBe("D");
    expect(phases[49]).toBe("D");
  });
});

// ---------------------------------------------------------------------------
// aggregateCombined100
// ---------------------------------------------------------------------------

const validValidity: RunValidity = {
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
};

function metrics(overrides: Partial<ResultRowMetrics>): ResultRowMetrics {
  return {
    resolved: false,
    patch_produced: true,
    changed_files: ["a.py"],
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 100,
    cache_creation_tokens: 1,
    total_tokens: 116,
    cost_usd: 0.5,
    num_turns: 10,
    tool_calls: 8,
    ...overrides,
  };
}

function row(id: string, resolved: boolean, costUsd = 0.5): M105CaseRow {
  return {
    instance_id: id,
    preflight_status: "pass",
    live_status: "valid",
    eval_status: "evaluated",
    validity: validValidity,
    metrics: metrics({ resolved, cost_usd: costUsd }),
  };
}

describe("aggregateCombined100", () => {
  test("aggregates the four sets and both combined views consistently", () => {
    const m105 = [row("a", true), row("b", false)];
    const m106 = [row("c", true)];
    const m107 = [row("d", false), row("e", true)];
    const m108 = [row("f", false), row("g", true), row("h", false)];
    const agg = aggregateCombined100(m105, m106, m107, m108, 0, 0, 0, 0);
    expect(agg.m105.resolved_count).toBe(1);
    expect(agg.m106.resolved_count).toBe(1);
    expect(agg.m107.resolved_count).toBe(1);
    expect(agg.m108.resolved_count).toBe(1);
    expect(agg.combined50.attempted_count).toBe(5);
    expect(agg.combined50.resolved_count).toBe(3);
    expect(agg.combined100.attempted_count).toBe(8);
    expect(agg.combined100.resolved_count).toBe(4);
    expect(agg.combined100.cost_usd).toBeCloseTo(4.0);
    expect(agg.combined100.leakage_fire_count).toBe(0);
  });

  test("leakage fire counts add across sets", () => {
    const agg = aggregateCombined100([row("a", false)], [row("b", false)], [row("c", false)], [row("d", false)], 1, 2, 3, 4);
    expect(agg.combined50.leakage_fire_count).toBe(6);
    expect(agg.combined100.leakage_fire_count).toBe(10);
  });

  test("throws on an M105 case reappearing in M108 rows (rerun guard)", () => {
    expect(() =>
      aggregateCombined100([row("a", true)], [row("b", true)], [row("c", true)], [row("a", false)], 0, 0, 0, 0),
    ).toThrow(/rerun detected/);
  });

  test("throws on an M107 case reappearing in M108 rows (rerun guard)", () => {
    expect(() =>
      aggregateCombined100([row("a", true)], [row("b", true)], [row("c", true)], [row("c", false)], 0, 0, 0, 0),
    ).toThrow(/rerun detected/);
  });

  test("throws on a duplicate within the M108 rows themselves", () => {
    expect(() =>
      aggregateCombined100([], [], [], [row("x", true), row("x", false)], 0, 0, 0, 0),
    ).toThrow(/rerun detected/);
  });
});

// ---------------------------------------------------------------------------
// spendCapStatus
// ---------------------------------------------------------------------------

describe("spendCapStatus", () => {
  test("sums extension cost and reports under-cap headroom", () => {
    const status = spendCapStatus([row("a", true, 10), row("b", false, 20)], 45);
    expect(status.cap_usd).toBe(45);
    expect(status.spent_usd).toBeCloseTo(30);
    expect(status.remaining_usd).toBeCloseTo(15);
    expect(status.under_cap).toBe(true);
  });

  test("flags an exceeded cap", () => {
    const status = spendCapStatus([row("a", true, 46)], 45);
    expect(status.under_cap).toBe(false);
    expect(status.remaining_usd).toBeCloseTo(-1);
  });

  test("rows without metrics count as zero spend", () => {
    const bare: M105CaseRow = {
      instance_id: "n",
      preflight_status: "pass",
      live_status: "not_attempted",
      eval_status: "not_applicable",
      validity: null,
      metrics: null,
    };
    expect(spendCapStatus([bare], 45).spent_usd).toBe(0);
  });

  test("the pre-registered M108 pause cap is $45", () => {
    expect(M108_EXTENSION_PAUSE_CAP_USD).toBe(45);
  });
});
