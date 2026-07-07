// Stage 5 M109 — pure helpers for the final-summary hard-stratum analysis:
// flip classification vs the M73 treatment arm (STRICT comparability — a
// case without a valid M73 treatment row is `no_M73_row`, never counted as
// an agreement or a flip) and a documented likely-reason heuristic for
// unresolved live outcomes. NO I/O — everything takes parsed JSON values so
// the logic is unit-testable without raw live artifacts.

export type FlipType = "agreement" | "live_loss_vs_M73" | "live_win_vs_M73" | "no_M73_row";

export type LikelyReason =
  | "deterministic_context_gap"
  | "agent_variance"
  | "high_cost_tool_loop"
  | "single_file_patch_on_multifile_gold"
  | "no_context"
  | "infrastructure_invalid"
  | "unknown";

export interface HardStratumInput {
  readonly live_status: "valid" | "invalid" | "not_attempted";
  readonly live_resolved: boolean | null;
  readonly m73_treatment_valid: boolean;
  readonly m73_treatment_resolved: boolean | null;
  readonly m103_outcome: string | null; // excellent/good/partial/wrong_pivot/miss/overpacked
  readonly m103_capsule_mode: string | null; // "no_context" for the never-spawned class
  readonly gold_multi_file: boolean;
  readonly m103_all_gold: boolean | null; // capsule carried ALL gold files
  readonly changed_files_count: number | null;
  readonly cost_usd: number | null;
  readonly tool_calls: number | null;
}

export function classifyFlip(input: HardStratumInput): FlipType {
  if (!input.m73_treatment_valid) return "no_M73_row";
  if (input.live_status !== "valid" || input.live_resolved === null) return "no_M73_row";
  const m73 = input.m73_treatment_resolved === true;
  if (input.live_resolved === m73) return "agreement";
  return input.live_resolved ? "live_win_vs_M73" : "live_loss_vs_M73";
}

// Documented heuristic, applied to UNRESOLVED live outcomes (losses and
// agreed-failures) and to non-attempted/invalid rows. Resolved cases return
// null (no failure to explain). Check order is deliberate:
//   1. no_context        — never spawned (frozen M103 no-context parity)
//   2. infrastructure_invalid — run happened but is validity-failed
//   3. single_file_patch_on_multifile_gold — multi-file gold, 1-file patch,
//      AND the capsule carried all gold files (the context told the agent
//      about every file and it still patched one — the xarray-6938
//      signature). When the capsule did NOT carry all gold, the miss is the
//      better explanation and the case falls through to 4/5.
//   4. high_cost_tool_loop — cost >= $1.50 or tool calls >= 25 (the M78
//      edit-churn / structural-ceiling signature)
//   5. deterministic_context_gap — M103 outcome miss/wrong_pivot/partial
//      (the capsule did not carry usable gold)
//   6. agent_variance    — M103 excellent/good/overpacked (gold context was
//      present) yet the agent's patch failed
//   7. unknown
export const HIGH_COST_USD = 1.5;
export const HIGH_TOOL_CALLS = 25;

export function classifyLikelyReason(input: HardStratumInput): LikelyReason | null {
  if (input.live_status === "not_attempted") {
    return input.m103_capsule_mode === "no_context" ? "no_context" : "unknown";
  }
  if (input.live_status === "invalid") return "infrastructure_invalid";
  if (input.live_resolved === true) return null;
  if (input.gold_multi_file && input.changed_files_count === 1 && input.m103_all_gold === true)
    return "single_file_patch_on_multifile_gold";
  if ((input.cost_usd ?? 0) >= HIGH_COST_USD || (input.tool_calls ?? 0) >= HIGH_TOOL_CALLS) return "high_cost_tool_loop";
  const outcome = input.m103_outcome;
  if (outcome === "miss" || outcome === "wrong_pivot" || outcome === "partial") return "deterministic_context_gap";
  if (outcome === "excellent" || outcome === "good" || outcome === "overpacked") return "agent_variance";
  return "unknown";
}
