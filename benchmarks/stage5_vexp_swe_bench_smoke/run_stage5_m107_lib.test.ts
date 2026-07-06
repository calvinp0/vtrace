import { describe, expect, test } from "bun:test";

import type { M105CaseRow, ResultRowMetrics, RunValidity } from "./run_stage5_m105_report_lib";
import type { M106SelectionCandidate } from "./run_stage5_m106_lib";
import {
  M107_REPO_CAP,
  M107_STRATA,
  M107_STRATUM_SUBSTITUTES,
  aggregateCombined50,
  m107Phase,
  selectM107Cases,
} from "./run_stage5_m107_lib";

// ---------------------------------------------------------------------------
// selectM107Cases
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

describe("M107_STRATA", () => {
  test("wants sum to the pre-registered 26-case extension", () => {
    expect(M107_STRATA.reduce((n, s) => n + s.want, 0)).toBe(26);
  });

  test("the M107 brief's strata names and sizes are frozen", () => {
    expect(M107_STRATA.map((s) => [s.name, s.want])).toEqual([
      ["eg_hist_resolved", 5],
      ["eg_hist_unresolved", 4],
      ["partial", 4],
      ["wrong_pivot", 4],
      ["miss", 5],
      ["multi_file", 2],
      ["holdout", 2],
    ]);
  });
});

describe("selectM107Cases substitution", () => {
  test("fills a partial deficit from overpacked, tagged with substitution provenance", () => {
    const candidates = [
      candidate({ instance_id: "p1", repo: "r1/x", m103_outcome: "partial" }),
      candidate({ instance_id: "op_b", repo: "r2/x", m103_outcome: "overpacked" }),
      candidate({ instance_id: "op_a", repo: "r3/x", m103_outcome: "overpacked" }),
      candidate({ instance_id: "op_m92", repo: "r4/x", m103_outcome: "overpacked", in_m92: true }),
    ];
    const strata = [{ name: "partial", want: 3, predicate: (c: M106SelectionCandidate) => c.m103_outcome === "partial" }];
    const result = selectM107Cases(candidates, new Set());
    void strata;
    // Only the partial stratum can select p1; every other M107 stratum is
    // short with no substitute except partial (deficit 3 -> all 3 overpacked,
    // M92-preferred first then id order).
    const partialRows = result.selected.filter((s) => s.stratum === "partial" || s.stratum === "partial_sub_overpacked");
    expect(partialRows).toEqual([
      { instance_id: "p1", stratum: "partial" },
      { instance_id: "op_m92", stratum: "partial_sub_overpacked" },
      { instance_id: "op_a", stratum: "partial_sub_overpacked" },
      { instance_id: "op_b", stratum: "partial_sub_overpacked" },
    ]);
    expect(result.substitutions).toEqual([{ stratum: "partial", substitute: "partial_sub_overpacked", count: 3 }]);
    expect(result.shortfalls.find((s) => s.stratum === "partial")).toBeUndefined();
  });

  test("substitution honors the GLOBAL repo cap across the whole selection", () => {
    // Saturate hot/repo up to the cap (5 via eg_hist_resolved + 1 via miss —
    // both strata run before the substitution loop), then verify the partial
    // substitution skips hot/repo overpacked candidates in pass 1.
    const hot = [
      ...Array.from({ length: 5 }, (_, i) =>
        candidate({ instance_id: `hot_res_${i}`, repo: "hot/repo", m103_outcome: "good", m73_treatment_resolved: true }),
      ),
      candidate({ instance_id: "hot_miss", repo: "hot/repo", m103_outcome: "miss" }),
    ];
    expect(hot).toHaveLength(M107_REPO_CAP);
    const overpacked = [
      candidate({ instance_id: "aaa_hot_op", repo: "hot/repo", m103_outcome: "overpacked" }),
      candidate({ instance_id: "zzz_cold_op", repo: "cold/repo", m103_outcome: "overpacked" }),
    ];
    const result = selectM107Cases([...hot, ...overpacked], new Set());
    const subs = result.selected.filter((s) => s.stratum === "partial_sub_overpacked");
    // Pass 1 must take the cold-repo candidate FIRST despite its later id;
    // the hot-repo candidate only enters via pass-2 relaxation.
    expect(subs.map((s) => s.instance_id)).toEqual(["zzz_cold_op", "aaa_hot_op"]);
  });

  test("a stratum without a substitute keeps its shortfall", () => {
    const result = selectM107Cases([candidate({ instance_id: "only", m103_outcome: "miss" })], new Set());
    expect(result.shortfalls.find((s) => s.stratum === "wrong_pivot")).toEqual({ stratum: "wrong_pivot", want: 4, got: 0 });
    expect(Object.keys(M107_STRATUM_SUBSTITUTES)).toEqual(["partial"]);
  });

  test("excluded (committed M105/M106) ids never enter any stratum or substitution", () => {
    const candidates = [
      candidate({ instance_id: "committed_partial", m103_outcome: "partial" }),
      candidate({ instance_id: "committed_op", m103_outcome: "overpacked" }),
    ];
    const result = selectM107Cases(candidates, new Set(["committed_partial", "committed_op"]));
    expect(result.selected).toEqual([]);
  });
});

describe("m107Phase", () => {
  test("assigns A=1-5, B=6-15, C=16-26 over selection order", () => {
    const phases = Array.from({ length: 26 }, (_, i) => m107Phase(i));
    expect(phases.filter((p) => p === "A")).toHaveLength(5);
    expect(phases.filter((p) => p === "B")).toHaveLength(10);
    expect(phases.filter((p) => p === "C")).toHaveLength(11);
    expect(phases[0]).toBe("A");
    expect(phases[4]).toBe("A");
    expect(phases[5]).toBe("B");
    expect(phases[14]).toBe("B");
    expect(phases[15]).toBe("C");
    expect(phases[25]).toBe("C");
  });
});

// ---------------------------------------------------------------------------
// aggregateCombined50
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

function row(id: string, resolved: boolean): M105CaseRow {
  return {
    instance_id: id,
    preflight_status: "pass",
    live_status: "valid",
    eval_status: "evaluated",
    validity: validValidity,
    metrics: metrics({ resolved }),
  };
}

describe("aggregateCombined50", () => {
  test("aggregates the three sets and both combined views consistently", () => {
    const m105 = [row("a", true), row("b", false)];
    const m106 = [row("c", true)];
    const m107 = [row("d", false), row("e", true), row("f", false)];
    const agg = aggregateCombined50(m105, m106, m107, 0, 0, 0);
    expect(agg.m105.resolved_count).toBe(1);
    expect(agg.m106.resolved_count).toBe(1);
    expect(agg.m107.resolved_count).toBe(1);
    expect(agg.combined24.attempted_count).toBe(3);
    expect(agg.combined24.resolved_count).toBe(2);
    expect(agg.combined50.attempted_count).toBe(6);
    expect(agg.combined50.resolved_count).toBe(3);
    expect(agg.combined50.cost_usd).toBeCloseTo(3.0);
    expect(agg.combined50.leakage_fire_count).toBe(0);
  });

  test("leakage fire counts add across sets", () => {
    const agg = aggregateCombined50([row("a", false)], [row("b", false)], [row("c", false)], 1, 2, 3);
    expect(agg.combined24.leakage_fire_count).toBe(3);
    expect(agg.combined50.leakage_fire_count).toBe(6);
  });

  test("throws on an M105 case reappearing in M107 rows (rerun guard)", () => {
    expect(() => aggregateCombined50([row("a", true)], [row("b", true)], [row("a", false)], 0, 0, 0)).toThrow(
      /rerun detected/,
    );
  });

  test("throws on an M106 case reappearing in M107 rows (rerun guard)", () => {
    expect(() => aggregateCombined50([row("a", true)], [row("b", true)], [row("b", false)], 0, 0, 0)).toThrow(
      /rerun detected/,
    );
  });
});
