import { describe, expect, test } from "bun:test";

import type { M105CaseRow, ResultRowMetrics, RunValidity } from "./run_stage5_m105_report_lib";
import {
  M106_STRATA,
  aggregateCombined,
  selectM106Cases,
  toM105CaseRow,
  type M106SelectionCandidate,
} from "./run_stage5_m106_lib";

// ---------------------------------------------------------------------------
// selectM106Cases
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

describe("selectM106Cases", () => {
  test("fills strata in order with deterministic id ordering and M92 preference", () => {
    const candidates = [
      // eg_hist_resolved pool: b_res has no M92 row, a_res and c_res do —
      // M92-preferred first, then id order.
      candidate({ instance_id: "c_res", repo: "r1/x", m73_treatment_resolved: true, in_m92: true }),
      candidate({ instance_id: "a_res", repo: "r2/x", m73_treatment_resolved: true, in_m92: true }),
      candidate({ instance_id: "b_res", repo: "r3/x", m73_treatment_resolved: true, in_m92: false }),
      candidate({ instance_id: "a_unres", repo: "r4/x", m73_treatment_resolved: false }),
      candidate({ instance_id: "b_unres", repo: "r5/x", m73_treatment_resolved: false }),
      candidate({ instance_id: "a_wrong", repo: "r6/x", m103_outcome: "wrong_pivot" }),
      candidate({ instance_id: "a_partial", repo: "r7/x", m103_outcome: "partial" }),
      candidate({ instance_id: "a_miss", repo: "r8/x", m103_outcome: "miss" }),
      candidate({ instance_id: "b_miss", repo: "r9/x", m103_outcome: "miss" }),
      candidate({ instance_id: "a_multi", repo: "r10/x", multi_file: true, m103_outcome: "overpacked" }),
      candidate({ instance_id: "a_hold", repo: "r11/x", in_holdout: true, m103_outcome: "overpacked" }),
    ];
    const result = selectM106Cases(candidates, new Set());
    expect(result.shortfalls).toEqual([]);
    expect(result.selected).toEqual([
      { instance_id: "a_res", stratum: "eg_hist_resolved" },
      { instance_id: "c_res", stratum: "eg_hist_resolved" },
      { instance_id: "a_unres", stratum: "eg_hist_unresolved" },
      { instance_id: "b_unres", stratum: "eg_hist_unresolved" },
      { instance_id: "a_partial", stratum: "partial_wrong_pivot" },
      { instance_id: "a_wrong", stratum: "partial_wrong_pivot" },
      { instance_id: "a_miss", stratum: "miss" },
      { instance_id: "b_miss", stratum: "miss" },
      { instance_id: "a_multi", stratum: "multi_file" },
      { instance_id: "a_hold", stratum: "holdout" },
    ]);
  });

  test("excludes the M105 ids and never selects a case twice across strata", () => {
    const candidates = [
      candidate({ instance_id: "excluded", m73_treatment_resolved: true }),
      // Satisfies eg_hist_resolved AND multi_file AND holdout — must appear once.
      candidate({ instance_id: "everything", m73_treatment_resolved: true, multi_file: true, in_holdout: true }),
    ];
    const strata = M106_STRATA.filter((s) => ["eg_hist_resolved", "multi_file", "holdout"].includes(s.name)).map(
      (s) => ({ ...s, want: 1 }),
    );
    const result = selectM106Cases(candidates, new Set(["excluded"]), strata);
    expect(result.selected).toEqual([{ instance_id: "everything", stratum: "eg_hist_resolved" }]);
    expect(result.shortfalls).toEqual([
      { stratum: "multi_file", want: 1, got: 0 },
      { stratum: "holdout", want: 1, got: 0 },
    ]);
  });

  test("repo cap skips an overrepresented repo in pass 1 but relaxes on shortfall", () => {
    const strata = [{ name: "miss", want: 3, predicate: (c: M106SelectionCandidate) => c.m103_outcome === "miss" }];
    const sameRepo = ["a", "b", "c"].map((id) =>
      candidate({ instance_id: id, repo: "hot/repo", m103_outcome: "miss" }),
    );
    const other = candidate({ instance_id: "d", repo: "cold/repo", m103_outcome: "miss" });
    const result = selectM106Cases([...sameRepo, other], new Set(), strata);
    // Pass 1: a, b (hot/repo reaches the cap of 2), then d; want=3 satisfied
    // without relaxation.
    expect(result.selected.map((s) => s.instance_id)).toEqual(["a", "b", "d"]);
    // Without the cold-repo candidate the cap must relax to fill the stratum.
    const relaxed = selectM106Cases(sameRepo, new Set(), strata);
    expect(relaxed.selected.map((s) => s.instance_id)).toEqual(["a", "b", "c"]);
    expect(relaxed.shortfalls).toEqual([]);
  });

  test("unscored candidates never enter the pool", () => {
    const strata = [{ name: "miss", want: 1, predicate: (c: M106SelectionCandidate) => c.m103_outcome === "miss" }];
    const result = selectM106Cases([candidate({ instance_id: "a", m103_outcome: "miss", scored: false })], new Set(), strata);
    expect(result.selected).toEqual([]);
    expect(result.shortfalls).toEqual([{ stratum: "miss", want: 1, got: 0 }]);
  });
});

// ---------------------------------------------------------------------------
// toM105CaseRow (committed-artifact reuse adapter)
// ---------------------------------------------------------------------------

const validity: RunValidity = {
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

function metrics(overrides: Partial<ResultRowMetrics> = {}): ResultRowMetrics {
  return {
    resolved: true,
    patch_produced: true,
    changed_files: ["a.py"],
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 70,
    cache_creation_tokens: 0,
    total_tokens: 100,
    cost_usd: 0.5,
    num_turns: 5,
    tool_calls: 7,
    ...overrides,
  };
}

function caseRow(id: string, overrides: Partial<M105CaseRow> = {}): M105CaseRow {
  return {
    instance_id: id,
    preflight_status: "pass",
    live_status: "valid",
    eval_status: "evaluated",
    validity,
    metrics: metrics(),
    ...overrides,
  };
}

describe("toM105CaseRow", () => {
  test("accepts a committed M105 detail case row (extra fields ignored)", () => {
    const detailRow = { ...caseRow("x"), leakage_status: "clean", historical: {}, notes: [] };
    expect(toM105CaseRow(detailRow)).toEqual(caseRow("x"));
  });

  test("accepts null validity/metrics for a not-attempted case", () => {
    const row = caseRow("x", { live_status: "not_attempted", eval_status: "not_applicable", validity: null, metrics: null });
    expect(toM105CaseRow({ ...row })).toEqual(row);
  });

  test("rejects shape drift instead of silently coercing", () => {
    expect(toM105CaseRow(null)).toBeNull();
    expect(toM105CaseRow({})).toBeNull();
    expect(toM105CaseRow({ ...caseRow("x"), preflight_status: "yes" })).toBeNull();
    expect(toM105CaseRow({ ...caseRow("x"), live_status: "ok" })).toBeNull();
    expect(toM105CaseRow({ ...caseRow("x"), eval_status: "done" })).toBeNull();
    expect(toM105CaseRow({ ...caseRow("x"), validity: { nope: true } })).toBeNull();
    expect(toM105CaseRow({ ...caseRow("x"), metrics: { cost_usd: "1" } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// aggregateCombined
// ---------------------------------------------------------------------------

describe("aggregateCombined", () => {
  test("combines disjoint M105 and M106 sets and sums leakage counts", () => {
    const m105 = [caseRow("a"), caseRow("b", { metrics: metrics({ resolved: false }) })];
    const m106 = [caseRow("c", { metrics: metrics({ cost_usd: 1.5, total_tokens: 300 }) })];
    const out = aggregateCombined(m105, m106, 0, 1);
    expect(out.m105.live_valid_count).toBe(2);
    expect(out.m105.resolved_count).toBe(1);
    expect(out.m106.live_valid_count).toBe(1);
    expect(out.combined.live_valid_count).toBe(3);
    expect(out.combined.resolved_count).toBe(2);
    expect(out.combined.cost_usd).toBeCloseTo(2.5);
    expect(out.combined.total_tokens).toBe(500);
    expect(out.combined.leakage_fire_count).toBe(1);
  });

  test("throws on an M105 case appearing in the M106 rows (rerun = FAIL condition)", () => {
    expect(() => aggregateCombined([caseRow("a")], [caseRow("a")], 0, 0)).toThrow(/rerun/);
  });
});
