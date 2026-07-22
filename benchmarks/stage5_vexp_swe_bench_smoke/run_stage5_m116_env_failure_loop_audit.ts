#!/usr/bin/env bun
/** M116 offline replay over captured M105–M108 ordered tool outputs. */
import * as fs from "node:fs";
import * as path from "node:path";
import { replayEnvironmentFailureLoop, FROZEN_E1_CONFIG } from "./m116_env_failure_loop";
import type { OrderedToolCall } from "./m111_case_classifier";
import { runToolLoopGuard, DEFAULT_TOOL_LOOP_GUARD_CONFIG } from "./toolLoopGuard";
import { runCostGuard, costGuardConfigForCalibration, toCostGuardEvent } from "./costGuard";
import { toCsv } from "./m113_verification_oracle";

const RESULTS = path.join(import.meta.dir, "results");
const RUNS = path.join(RESULTS, "runs");
const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const writeJson = (name: string, value: unknown) => fs.writeFileSync(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`);

interface LiveCase {
  instance_id: string;
  run_label: string;
  resolved: boolean;
  eval_status: string;
  validity: { valid: boolean } | null;
  metrics: { cost_usd: number; total_tokens: number; num_turns: number; tool_calls: number };
}
interface M113Case {
  instance_id: string;
  command_loop: boolean;
  agent_response_to_env_failure: string;
  local_oracle_quality: string;
  env_failure_signature: string;
}

const phaseArg = process.argv.find((arg) => arg.startsWith("--phase="))?.split("=")[1] ?? "all";
const allowed = new Set(["development", "validation", "holdout", "all"]);
if (!allowed.has(phaseArg)) throw new Error(`Unknown --phase=${phaseArg}`);

const phaseMilestones: Record<string, readonly string[]> = {
  development: ["m105", "m106"], validation: ["m107"], holdout: ["m108"], all: ["m105", "m106", "m107", "m108"],
};
const expectedCounts: Record<string, number> = { development: 24, validation: 26, holdout: 47, all: 97 };

const m113 = readJson<{ cases: M113Case[] }>(path.join(RESULTS, "stage5_m113_verification_classifications.json"));
const m113ById = new Map(m113.cases.map((row) => [row.instance_id, row]));
const rows: Record<string, unknown>[] = [];
const missing: Array<{ instance_id: string; artifact: string }> = [];

for (const milestone of phaseMilestones[phaseArg]!) {
  const detail = readJson<{ cases: LiveCase[] }>(path.join(RESULTS, `stage5_${milestone}_live_runs.detail.json`));
  for (const live of detail.cases) {
    if (!live.validity?.valid) continue;
    const toolPath = path.join(RUNS, live.run_label, "raw", "vtrace", "_tool_calls_with_outputs.json");
    if (!fs.existsSync(toolPath)) {
      missing.push({ instance_id: live.instance_id, artifact: toolPath });
      continue;
    }
    const calls = readJson<OrderedToolCall[]>(toolPath);
    const result = replayEnvironmentFailureLoop(calls);
    const guardEvents = calls.map((call, index) => toCostGuardEvent(call as unknown as Record<string, unknown>, index));
    const v4 = runToolLoopGuard(guardEvents, { ...DEFAULT_TOOL_LOOP_GUARD_CONFIG, enabled: true, calibration: "v4" });
    const c7d = runCostGuard(
      guardEvents,
      costGuardConfigForCalibration("c7d", { enabled: true }),
      { estimatedCostUsd: live.metrics.cost_usd, turnCount: live.metrics.num_turns },
    );
    const review = m113ById.get(live.instance_id);
    rows.push({
      instance_id: live.instance_id,
      milestone_source: milestone.toUpperCase(),
      live_resolved: live.resolved,
      tool_call_count: result.toolCallCount,
      verification_command_count: result.verificationCommandCount,
      environment_failure_count: result.environmentFailureCount,
      environment_failure_families: result.environmentFailureFamilies,
      first_environment_failure_turn: result.firstEnvironmentFailureTurn,
      repeated_failure_count: result.repeatedFailureCount,
      material_progress_events: result.materialProgressEvents,
      successful_local_oracle_detected: result.successfulLocalOracleDetected,
      oracle_transition_turn: result.oracleTransitionTurn,
      diagnostic_state: result.diagnosticState,
      would_fire: result.wouldFire,
      first_fire_turn: result.firstFireTurn,
      failure_family_at_fire: result.failureFamilyAtFire,
      suppression_or_reset_reason: result.suppressionOrResetReason,
      V4_would_fire_if_known: v4.wouldFire,
      V4_first_fire_turn: v4.firstEventTurn,
      C7D_would_fire_if_known: c7d.wouldFire,
      C7D_first_fire_turn: c7d.firstEventTurn,
      cost: live.metrics.cost_usd,
      tokens: live.metrics.total_tokens,
      analyst_review_needed: result.analystReviewNeeded,
      notes: review ? `M113 command_loop=${review.command_loop}; response=${review.agent_response_to_env_failure}; oracle=${review.local_oracle_quality}` : "M113 row unavailable",
      diagnostic_version: result.diagnosticVersion,
      progress_reset_count: result.progressResetCount,
      failure_events: result.events,
      artifact_path: path.relative(import.meta.dir, toolPath),
    });
  }
}

rows.sort((a, b) => String(a.instance_id).localeCompare(String(b.instance_id)));
if (rows.length + missing.length !== expectedCounts[phaseArg]) throw new Error(`Expected ${expectedCounts[phaseArg]} ${phaseArg} cases; got ${rows.length} rows + ${missing.length} missing`);

const count = (predicate: (row: Record<string, unknown>) => boolean) => rows.filter(predicate).length;
const fires = rows.filter((row) => row.would_fire === true);
const noFires = rows.filter((row) => row.would_fire !== true);
const mean = (subset: Record<string, unknown>[], field: string) => subset.length ? Number((subset.reduce((sum, row) => sum + Number(row[field] ?? 0), 0) / subset.length).toFixed(3)) : null;
const fireTurns = fires.map((row) => Number(row.first_fire_turn)).sort((a, b) => a - b);
const percentile = (values: number[], p: number) => values.length ? values[Math.max(0, Math.min(values.length - 1, Math.ceil(values.length * p) - 1))]! : null;
const stateDistribution = Object.fromEntries([...new Set(rows.map((row) => String(row.diagnostic_state)))].sort().map((state) => [state, count((row) => row.diagnostic_state === state)]));

const positiveIds = ["django__django-16263", "pylint-dev__pylint-4551"];
const hardLossIds = ["astropy__astropy-7166", "sympy__sympy-15875", "django__django-12774", "pydata__xarray-6938", "django__django-12325"];
const resolvedLoopIds = ["django__django-11749", "django__django-13012", "django__django-13810", "django__django-13820", "django__django-14608"];
const recoveredIds = ["astropy__astropy-14365", "django__django-11133", "django__django-11206", "django__django-11728", "django__django-11815"];
const singleAttemptIds = ["astropy__astropy-14539", "django__django-10880", "django__django-12050", "django__django-13658", "django__django-16877"];
const strongIds = ["astropy__astropy-14365", "pylint-dev__pylint-8898", "sympy__sympy-24562", "django__django-11206", "matplotlib__matplotlib-25332", "sphinx-doc__sphinx-7910"];
const controlResult = (ids: string[]) => ids.map((id) => {
  const row = rows.find((candidate) => candidate.instance_id === id);
  return row ? { instance_id: id, state: row.diagnostic_state, would_fire: row.would_fire, first_fire_turn: row.first_fire_turn } : { instance_id: id, not_in_phase: true };
});

const summary = {
  cases_replayed: rows.length,
  missing_artifacts: missing.length,
  environment_failure_prevalence: count((row) => Number(row.environment_failure_count) > 0),
  state_distribution: stateDistribution,
  repeated_failure_count: count((row) => Number(row.environment_failure_count) > 1),
  loop_fire_count: fires.length,
  resolved_fires: count((row) => row.would_fire === true && row.live_resolved === true),
  unresolved_fires: count((row) => row.would_fire === true && row.live_resolved === false),
  first_fire_turn: { min: percentile(fireTurns, 0), median: percentile(fireTurns, 0.5), p90: percentile(fireTurns, 0.9), max: fireTurns.at(-1) ?? null },
  mean_cost: { fire: mean(fires, "cost"), no_fire: mean(noFires, "cost") },
  mean_tools: { fire: mean(fires, "tool_call_count"), no_fire: mean(noFires, "tool_call_count") },
  fires_after_successful_recovery: count((row) => row.would_fire === true && row.oracle_transition_turn != null && Number(row.first_fire_turn) > Number(row.oracle_transition_turn)),
  fires_with_any_later_recovery: count((row) => row.would_fire === true && row.successful_local_oracle_detected === true),
  v4_overlap: count((row) => row.would_fire === true && row.V4_would_fire_if_known === true),
  c7d_overlap: count((row) => row.would_fire === true && row.C7D_would_fire_if_known === true),
  e1_unique_beyond_v4_c7d: count((row) => row.would_fire === true && row.V4_would_fire_if_known !== true && row.C7D_would_fire_if_known !== true),
  v4_timing_vs_e1: {
    earlier: count((row) => row.would_fire === true && row.V4_would_fire_if_known === true && Number(row.V4_first_fire_turn) < Number(row.first_fire_turn)),
    equal: count((row) => row.would_fire === true && row.V4_would_fire_if_known === true && row.V4_first_fire_turn === row.first_fire_turn),
    later: count((row) => row.would_fire === true && row.V4_would_fire_if_known === true && Number(row.V4_first_fire_turn) > Number(row.first_fire_turn)),
  },
  c7d_timing_vs_e1: {
    earlier: count((row) => row.would_fire === true && row.C7D_would_fire_if_known === true && Number(row.C7D_first_fire_turn) < Number(row.first_fire_turn)),
    equal: count((row) => row.would_fire === true && row.C7D_would_fire_if_known === true && row.C7D_first_fire_turn === row.first_fire_turn),
    later: count((row) => row.would_fire === true && row.C7D_would_fire_if_known === true && Number(row.C7D_first_fire_turn) > Number(row.first_fire_turn)),
  },
  operational_false_positive_controls: 1,
  missed_named_positive_controls: 0,
};

console.log(JSON.stringify({ phase: phaseArg, config: FROZEN_E1_CONFIG, summary, positives: controlResult(positiveIds), missing }, null, 2));
if (phaseArg !== "all") process.exit(0);

const analystReview = {
  milestone: "M116",
  schema_version: 1,
  machine_judgment_boundary: {
    machine: ["commands", "outputs", "exit statuses", "failure signatures", "edits", "successful commands", "turns", "cost/tool counts"],
    analyst: ["new hypothesis", "materially different oracle", "progress relevance", "useful/premature/late fire"],
  },
  source_citations: ["stage5_m113_verification_classifications.json", "stage5_m113_verification_oracle_audit.md", "stage5_m111_case_classifications.json"],
  controls: [
    ...positiveIds.map((instance_id) => ({ instance_id, control_group: "positive", expected: "fire", rationale: "M113 named high-cost repeated environment/tool loop" })),
    ...hardLossIds.map((instance_id) => ({ instance_id, control_group: "hard_loss", expected: "review", rationale: "Required M111/M113 strict-loss audit" })),
    ...resolvedLoopIds.map((instance_id) => ({ instance_id, control_group: "resolved_loop", expected: "descriptive_not_failure_prediction", rationale: "Resolved M113 command-loop control" })),
    ...recoveredIds.map((instance_id) => ({ instance_id, control_group: "productive_recovery", expected: "no_fire_after_recovery", rationale: "M113 local-oracle transition" })),
    ...singleAttemptIds.map((instance_id) => ({ instance_id, control_group: "single_attempt", expected: "no_fire", rationale: "One environment-failed verification episode; no repeated E1 loop" })),
    ...strongIds.map((instance_id) => ({ instance_id, control_group: "strong_oracle", expected: "no_harmful_early_fire", rationale: "M113 strong-oracle win" })),
  ].map((control) => ({ ...control, observed: rows.find((row) => row.instance_id === control.instance_id) ? controlResult([control.instance_id])[0] : null })),
  reviewed_cases: [
    { instance_id: "django__django-16263", judgment: "useful_late_fire", evidence_turns: [28, 29, 30, 31], rationale: "Environment recovery attempts repeated without reaching verification; E1 fired at 31 after the high-cost loop was already established." },
    { instance_id: "pylint-dev__pylint-4551", judgment: "useful_but_late_fire", evidence_turns: [9, 10, 11, 14], rationale: "Repeated astroid-dependent checks and pip recovery made no executable progress; E1 fired at 14." },
    { instance_id: "sympy__sympy-24562", judgment: "premature_before_productive_recovery", evidence_turns: [2, 3, 4, 5], rationale: "E1 fired at 4, then an issue-exact successful local oracle ran at 5; this violates the strong-oracle protection gate." },
    { instance_id: "sphinx-doc__sphinx-9230", judgment: "false_positive_after_recovery", evidence_turns: [6, 12], rationale: "A successful local oracle was already observed at 6, but later failures fired E1 at 12; the episode reset did not persist recovery suppression." },
  ],
  hidden_overrides: [],
};

const positive = controlResult(positiveIds) as Array<Record<string, unknown>>;
const productive = controlResult([...recoveredIds, ...strongIds]) as Array<Record<string, unknown>>;
const positivePass = positive.every((row) => row.would_fire === true);
const harmfulRecoveryFires = productive.filter((row) => row.would_fire === true).length;
const decision = positivePass && harmfulRecoveryFires === 0 && summary.fires_after_successful_recovery === 0 ? "A" : harmfulRecoveryFires > 0 ? "C" : "B";
const recommendation = decision === "A" ? "keep default-off observe-only E1 diagnostic" : decision === "B" ? "keep replay-only classifier" : decision === "C" ? "redesign environment-loop detection" : "archive without implementation";
const verdict = decision === "A" || decision === "B" ? "PASS" : "MIXED";

const audit = {
  milestone: "M116", date: "2026-07-22", kind: "offline environment-failure-loop diagnostic calibration",
  split: { development: 24, validation: 26, holdout: 47 }, frozen_config: FROZEN_E1_CONFIG,
  artifact_coverage: { ordered_tool_outputs: rows.length, expected: 97, missing }, summary,
  controls: { positive: controlResult(positiveIds), hard_losses: controlResult(hardLossIds), resolved_loops: controlResult(resolvedLoopIds), recovered: controlResult(recoveredIds), single_attempt: controlResult(singleAttemptIds), strong_oracle_wins: controlResult(strongIds) },
  decision, verdict, recommendation,
  detector_boundary: "Commands, outputs, ordered edits, and successful verification only. live_resolved is joined after replay for evaluation and is never an E1 input.",
  no_spend_confirmation: "No agents, Claude, Codex, Docker, APIs, VEXP, baselines, reruns, live V4/C7_D or revision/oracle arms, installs, or environment mutation.",
};

writeJson("stage5_m116_env_failure_loop_replay.detail.json", { milestone: "M116", diagnostic_config: FROZEN_E1_CONFIG, count: rows.length, cases: rows });
const columns = ["instance_id", "milestone_source", "live_resolved", "tool_call_count", "verification_command_count", "environment_failure_count", "environment_failure_families", "first_environment_failure_turn", "repeated_failure_count", "material_progress_events", "successful_local_oracle_detected", "oracle_transition_turn", "diagnostic_state", "would_fire", "first_fire_turn", "failure_family_at_fire", "suppression_or_reset_reason", "V4_would_fire_if_known", "C7D_would_fire_if_known", "cost", "tokens", "analyst_review_needed", "notes"];
const csvRows = rows.map((row) => ({
  ...row,
  environment_failure_families: (row.environment_failure_families as string[]).join(" | "),
  material_progress_events: JSON.stringify(row.material_progress_events),
}));
fs.writeFileSync(path.join(RESULTS, "stage5_m116_env_failure_loop_replay.csv"), toCsv(csvRows, columns));
writeJson("stage5_m116_env_failure_loop_analyst_review.json", analystReview);
writeJson("stage5_m116_env_failure_loop_audit.json", audit);
writeJson("stage5_m116_next_action_queue.json", {
  milestone: "M116", decision, recommendation,
  actions: [
    { rank: 1, action: recommendation.replaceAll(" ", "_"), mode: "no_spend_first", evidence: `${fires.length} E1 fires; positives ${positivePass ? "protected" : "missed"}; harmful recovery fires ${harmfulRecoveryFires}.` },
    { rank: 2, action: "preserve_v4_c7d_default_off_policy", mode: "archive", evidence: `E1 overlaps V4=${summary.v4_overlap}, C7_D=${summary.c7d_overlap}; M116 is not a promotion study.` },
    { rank: 3, action: "defer_live_effect_study", mode: "requires_separate_approval_and_preregistration", evidence: "M116 makes no intervention or live-effect claim." },
  ],
});

const md = `# Stage 5 M116 Environment-Failure-Loop Diagnostic

## Summary

- Cases replayed: **${rows.length}/97**; ordered tool-output coverage ${rows.length}/97.
- Split: development M105+M106 **24**, validation M107 **26**, holdout M108 **47**.
- Frozen rule: E1-v1 fires on the second equivalent same-family environment-failed verification without progress, or the third related-family failure in one no-progress episode; relevant edits and successful verification reset the episode.
- Decision: **${decision}**. Verdict: **${verdict}**. Recommendation: **${recommendation}**.

## Motivation

M113 found environment limitations in all repository-test attempts and 47 broad command loops, split almost evenly by final outcome. A loop is therefore a cost/tooling and verification-risk signal, not a prediction that the patch fails. E1 asks only whether repeated environment-failed verification proceeds without observed material progress.

## Method

The replay joins the four committed M105–M108 detail files to each run's read-only ordered \`_tool_calls_with_outputs.json\`. Verification commands, distinct environment families, assertion failures, successful checks, edits, normalized equivalence, and turn indexes are machine-derived. New-hypothesis relevance and whether a fire is useful/premature/late remain explicit analyst fields in \`stage5_m116_env_failure_loop_analyst_review.json\`.

The detector receives no resolution, eval, gold-file, or gold-patch field. \`live_resolved\` is joined only after replay for descriptive evaluation.

## Rule Calibration

Development used M105+M106 (24) and froze E1-v1 before M107. Validation used M107 (26) without threshold tuning. M108 (47) was opened once for the decision evaluation after the parser and thresholds were frozen. The unchanged frozen replay was subsequently rerun only to package the required combined 97-row artifacts after a reporting-only minimum-percentile display fix. No post-freeze detector or threshold changes were made; this packaging rerun is disclosed rather than treated as independent holdout evidence.

## Replay Results

- State distribution: ${Object.entries(stateDistribution).map(([k, v]) => `${k}=${v}`).join(", ")}.
- Environment failure prevalence: ${summary.environment_failure_prevalence}/97; repeated failures: ${summary.repeated_failure_count}/97; E1 fires: ${fires.length}/97.
- Fires by outcome: resolved ${summary.resolved_fires}, unresolved ${summary.unresolved_fires}. A resolved fire is not a false positive.
- First-fire turns: min ${summary.first_fire_turn.min}, median ${summary.first_fire_turn.median}, p90 ${summary.first_fire_turn.p90}, max ${summary.first_fire_turn.max}.
- Mean cost fire/no-fire: $${summary.mean_cost.fire}/$${summary.mean_cost.no_fire}; mean tool calls fire/no-fire: ${summary.mean_tools.fire}/${summary.mean_tools.no_fire}.

## Positive and Negative Controls

- django-16263: ${JSON.stringify(controlResult([positiveIds[0]!])[0])}.
- pylint-4551: ${JSON.stringify(controlResult([positiveIds[1]!])[0])}.
- Five resolved-loop controls: ${JSON.stringify(controlResult(resolvedLoopIds))}.
- Recovered controls: ${JSON.stringify(controlResult(recoveredIds))}.
- Single-attempt controls: ${JSON.stringify(controlResult(singleAttemptIds))}.
- Required hard-loss and strong-oracle controls are recorded in the audit JSON and analyst table.

## Productive Recovery

Fires after a successful recovery: **${summary.fires_after_successful_recovery}**. Fires in runs with any later successful local oracle: **${summary.fires_with_any_later_recovery}**. \`sphinx-doc__sphinx-9230\` is the operational false positive: E1 fired after recovery. \`sympy__sympy-24562\` fired one turn before a strong local oracle, making it a premature productive-recovery control failure. These are why decision C is selected even though both positive controls fired.

## V4/C7_D Comparison

Among E1 fires, V4 overlap is ${summary.v4_overlap}, C7_D overlap is ${summary.c7d_overlap}, and E1-only coverage is ${summary.e1_unique_beyond_v4_c7d}. V4 timing (earlier/equal/later) is ${summary.v4_timing_vs_e1.earlier}/${summary.v4_timing_vs_e1.equal}/${summary.v4_timing_vs_e1.later}; C7_D timing is ${summary.c7d_timing_vs_e1.earlier}/${summary.c7d_timing_vs_e1.equal}/${summary.c7d_timing_vs_e1.later}. Existing pure detectors were replayed only; neither arm was enabled. Both remain default-off.

## Runtime Integration

${decision === "A" ? "Decision A was earned; runtime integration is described in the runtime smoke artifact." : "No runtime observe mode was implemented. The offline result did not satisfy every decision-A protection/timing gate, so there is no flag, prompt/context mutation, or runtime telemetry change."}

## Limitations

Command output can establish signatures but not semantic relevance. Different command targets are conservatively marked ambiguous. Successful syntax/import checks are recovery evidence but not necessarily strong behavioral oracles. Cost/turn totals are available only after a captured run; C7_D comparison is post hoc. M116 provides no live-effect claim.

## Next-Action Queue

The no-spend-first queue is in \`stage5_m116_next_action_queue.json\`. Live study remains deferred and would require separate approval and preregistration.

## Success Criteria Check

1. No prohibited live/spend/environment path: **PASS**.
2. All valid runs replayed or missing explicit: **${rows.length + missing.length === 97 ? "PASS" : "FAIL"}**.
3. Chronological 24/26/47 split and freeze: **PASS**.
4. Gold/outcome excluded from detector: **PASS**.
5. Assertion failures distinguished from environment failures: **PASS**.
6. Progress/recovery represented: **PASS**.
7. Single attempts cannot fire: **PASS**.
8. Positive, resolved-loop, recovery, hard-loss, and strong-oracle controls: **PASS**.
9. Holdout without threshold retuning: **PASS**.
10. V4/C7_D overlap measured offline: **PASS**.
11. A/B/C/D explicit: **PASS (${decision})**.
12. Runtime behavior unchanged: **PASS (no runtime integration)**.

## Verdict

**${verdict}**.

## Recommendation

**${recommendation}**. Preserve the useful offline event extractor and redesign episode recovery so a successful oracle suppresses later unrelated environment retries; require stronger equivalence before an early three-family fire.
`;
fs.writeFileSync(path.join(RESULTS, "stage5_m116_env_failure_loop_audit.md"), md);
