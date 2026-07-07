import { describe, expect, test } from "bun:test";

import {
  HIGH_COST_USD,
  HIGH_TOOL_CALLS,
  classifyFlip,
  classifyLikelyReason,
  type HardStratumInput,
} from "./run_stage5_m109_lib";

function input(overrides: Partial<HardStratumInput>): HardStratumInput {
  return {
    live_status: "valid",
    live_resolved: false,
    m73_treatment_valid: true,
    m73_treatment_resolved: true,
    m103_outcome: "excellent",
    m103_capsule_mode: "debug",
    gold_multi_file: false,
    m103_all_gold: true,
    changed_files_count: 1,
    cost_usd: 0.5,
    tool_calls: 8,
    ...overrides,
  };
}

describe("classifyFlip", () => {
  test("agreement when live matches M73", () => {
    expect(classifyFlip(input({ live_resolved: true, m73_treatment_resolved: true }))).toBe("agreement");
    expect(classifyFlip(input({ live_resolved: false, m73_treatment_resolved: false }))).toBe("agreement");
  });

  test("loss and win flips", () => {
    expect(classifyFlip(input({ live_resolved: false, m73_treatment_resolved: true }))).toBe("live_loss_vs_M73");
    expect(classifyFlip(input({ live_resolved: true, m73_treatment_resolved: false }))).toBe("live_win_vs_M73");
  });

  test("STRICT comparability: an invalid M73 treatment row is never a flip, even with a raw boolean", () => {
    // django-10973's raw M73 row records treatment_resolved=false with
    // treatment_valid=false (skipped in stage B) — it must be no_M73_row.
    expect(classifyFlip(input({ live_resolved: true, m73_treatment_valid: false, m73_treatment_resolved: false }))).toBe(
      "no_M73_row",
    );
  });

  test("not-attempted and invalid live rows are not comparable", () => {
    expect(classifyFlip(input({ live_status: "not_attempted", live_resolved: null }))).toBe("no_M73_row");
    expect(classifyFlip(input({ live_status: "invalid", live_resolved: null }))).toBe("no_M73_row");
  });
});

describe("classifyLikelyReason", () => {
  test("resolved live outcomes need no reason", () => {
    expect(classifyLikelyReason(input({ live_resolved: true }))).toBeNull();
  });

  test("never-spawned frozen no-context cases classify no_context", () => {
    expect(
      classifyLikelyReason(input({ live_status: "not_attempted", live_resolved: null, m103_capsule_mode: "no_context" })),
    ).toBe("no_context");
  });

  test("invalid runs classify infrastructure_invalid", () => {
    expect(classifyLikelyReason(input({ live_status: "invalid", live_resolved: null }))).toBe("infrastructure_invalid");
  });

  test("single-file patch on multi-file gold requires the capsule to have carried ALL gold", () => {
    // xarray-6938's signature: excellent capsule with BOTH gold files, 1-file patch.
    expect(
      classifyLikelyReason(
        input({ gold_multi_file: true, m103_all_gold: true, changed_files_count: 1, m103_outcome: "excellent" }),
      ),
    ).toBe("single_file_patch_on_multifile_gold");
    // A miss-class capsule never told the agent about the other files — the
    // context gap is the primary explanation, not the patch shape.
    expect(
      classifyLikelyReason(
        input({ gold_multi_file: true, m103_all_gold: false, changed_files_count: 1, m103_outcome: "miss" }),
      ),
    ).toBe("deterministic_context_gap");
  });

  test("high cost or tool-call count classifies high_cost_tool_loop", () => {
    expect(classifyLikelyReason(input({ cost_usd: HIGH_COST_USD }))).toBe("high_cost_tool_loop");
    expect(classifyLikelyReason(input({ tool_calls: HIGH_TOOL_CALLS }))).toBe("high_cost_tool_loop");
    expect(classifyLikelyReason(input({ cost_usd: 1.49, tool_calls: 24 }))).toBe("agent_variance");
  });

  test("miss/wrong_pivot/partial outcomes classify deterministic_context_gap", () => {
    for (const outcome of ["miss", "wrong_pivot", "partial"]) {
      expect(classifyLikelyReason(input({ m103_outcome: outcome }))).toBe("deterministic_context_gap");
    }
  });

  test("excellent/good/overpacked unresolved outcomes classify agent_variance", () => {
    for (const outcome of ["excellent", "good", "overpacked"]) {
      expect(classifyLikelyReason(input({ m103_outcome: outcome }))).toBe("agent_variance");
    }
  });

  test("unknown outcome classifies unknown", () => {
    expect(classifyLikelyReason(input({ m103_outcome: null }))).toBe("unknown");
  });
});
