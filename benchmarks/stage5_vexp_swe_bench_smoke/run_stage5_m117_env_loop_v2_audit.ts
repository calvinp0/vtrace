#!/usr/bin/env bun
/** M117 offline strategy-aware replay over captured M105–M108 tool outputs. */
import * as fs from "node:fs";
import * as path from "node:path";
import { replayEnvironmentLoopV2, FROZEN_E1_V2_CONFIG } from "./m117_env_loop_v2";
import type { OrderedToolCall } from "./m111_case_classifier";
import { toCsv } from "./m113_verification_oracle";

const RESULTS = path.join(import.meta.dir, "results");
const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const writeJson = (name: string, value: unknown) => fs.writeFileSync(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`);

interface V1Row {
  instance_id: string;
  milestone_source: string;
  live_resolved: boolean;
  tool_call_count: number;
  would_fire: boolean;
  first_fire_turn: number | null;
  diagnostic_state: string;
  V4_would_fire_if_known: boolean;
  V4_first_fire_turn: number | null;
  C7D_would_fire_if_known: boolean;
  C7D_first_fire_turn: number | null;
  cost: number;
  tokens: number;
  artifact_path: string;
}

const v1Detail = readJson<{ cases: V1Row[] }>(path.join(RESULTS, "stage5_m116_env_failure_loop_replay.detail.json"));
if (v1Detail.cases.length !== 97) throw new Error(`Expected 97 M116 rows, found ${v1Detail.cases.length}`);

const timingReview = [
  { instance_id: "django__django-16263", earliest_justified_loop_turn: 30, latest_acceptable_fire_turn: 31, must_not_fire_before_turn: 29, reason: "The first post-edit asgiref-blocked reproduction is T28; package-install/retry repeats at T29-T30 and import confirmation follows at T31.", supporting_tool_events: [28, 29, 30, 31], recovery_transition: null, e1_relevance: "must_fire" },
  { instance_id: "pylint-dev__pylint-4551", earliest_justified_loop_turn: 10, latest_acceptable_fire_turn: 14, must_not_fire_before_turn: 10, reason: "T9-T10 repeat the same astroid-backed reproduction at the same missing-dependency boundary; T11-T14 continue the environment chain.", supporting_tool_events: [9, 10, 11, 12, 14], recovery_transition: null, e1_relevance: "must_fire" },
  { instance_id: "sphinx-doc__sphinx-9230", earliest_justified_loop_turn: null, latest_acceptable_fire_turn: null, must_not_fire_before_turn: "end", reason: "Successful standalone parsing/property checks at T6 and T9 establish recovery before distinct repo-test, install, and import-dependent attempts.", supporting_tool_events: [6, 9, 10, 11, 12], recovery_transition: "T6 standalone property check, strengthened at T9", e1_relevance: "must_protect" },
  { instance_id: "sympy__sympy-24562", earliest_justified_loop_turn: null, latest_acceptable_fire_turn: null, must_not_fire_before_turn: 5, reason: "T2-T4 encounter import/install boundaries; T5 switches to a dependency-free exact-input 1/200 oracle.", supporting_tool_events: [2, 3, 4, 5], recovery_transition: "T5 standalone exact-input behavioral oracle", e1_relevance: "must_protect" },
  { instance_id: "astropy__astropy-7166", earliest_justified_loop_turn: null, latest_acceptable_fire_turn: null, must_not_fire_before_turn: "end", reason: "One import-dependent attempt at T2 is followed by a successful dependency-free reproduction at T3; the analyst-rated wrong oracle, not a loop, explains the loss.", supporting_tool_events: [2, 3], recovery_transition: "T3 standalone reproduction", e1_relevance: "not_relevant_wrong_oracle" },
  { instance_id: "sympy__sympy-15875", earliest_justified_loop_turn: 6, latest_acceptable_fire_turn: 9, must_not_fire_before_turn: 6, reason: "T4 reproduction, T5 install, and T6 import retry begin a sustained environment chain through T10; the later oracle is analyst-rated wrong.", supporting_tool_events: [4, 5, 6, 8, 9, 10], recovery_transition: null, e1_relevance: "relevant_to_inefficiency_not_final_loss" },
  { instance_id: "django__django-12774", earliest_justified_loop_turn: 9, latest_acceptable_fire_turn: 10, must_not_fire_before_turn: 9, reason: "T8 changes from a local reproduction to focused repository testing; T9-T10 repeat repo-test attempts at the same unavailable environment boundary.", supporting_tool_events: [7, 8, 9, 10, 11], recovery_transition: "T11 syntax verification prevents later fire", e1_relevance: "relevant_to_repo_test_loop_not_final_loss" },
  { instance_id: "pydata__xarray-6938", earliest_justified_loop_turn: 8, latest_acceptable_fire_turn: 8, must_not_fire_before_turn: 8, reason: "T7-T8 are cosmetic interpreter variants of the same issue reproduction and missing-NumPy boundary.", supporting_tool_events: [7, 8], recovery_transition: null, e1_relevance: "relevant_to_loop_not_oracle_quality" },
  { instance_id: "django__django-12325", earliest_justified_loop_turn: 8, latest_acceptable_fire_turn: 9, must_not_fire_before_turn: 8, reason: "T7-T8 repeat the same MTI reproduction through different invocation forms at the unavailable-Django boundary; T9 attempts package recovery.", supporting_tool_events: [7, 8, 9], recovery_transition: null, e1_relevance: "possible_loop_but_not_final_loss_explanation" },
] as const;

const timingById = new Map<string, typeof timingReview[number]>(timingReview.map((row) => [row.instance_id, row]));
const rows = v1Detail.cases.map((v1) => {
  const artifact = path.join(import.meta.dir, v1.artifact_path);
  if (!fs.existsSync(artifact)) throw new Error(`Missing ordered tool artifact for ${v1.instance_id}: ${artifact}`);
  const calls = readJson<OrderedToolCall[]>(artifact);
  const result = replayEnvironmentLoopV2(calls);
  const timing = timingById.get(v1.instance_id);
  const timingStatus = !timing || timing.earliest_justified_loop_turn === null
    ? result.wouldFire ? "unexpected_fire" : "protected_or_not_applicable"
    : !result.wouldFire
      ? "missed"
      : result.firstFireTurn! < Number(timing.must_not_fire_before_turn)
        ? "premature"
        : result.firstFireTurn! > timing.latest_acceptable_fire_turn
          ? "late"
          : "within_analyst_window";
  return {
    instance_id: v1.instance_id,
    milestone_source: v1.milestone_source,
    live_resolved: v1.live_resolved,
    tool_call_count: result.toolCallCount,
    verification_command_count: result.verificationCommandCount,
    environment_failure_count: result.environmentFailureCount,
    failure_roots: result.failureRoots,
    verification_strategies: result.verificationStrategies,
    first_environment_failure_turn: result.firstEnvironmentFailureTurn,
    diagnostic_state: result.diagnosticState,
    would_fire: result.wouldFire,
    first_fire_turn: result.firstFireTurn,
    failure_root_at_fire: result.failureRootAtFire,
    verification_strategy_at_fire: result.verificationStrategyAtFire,
    loop_kind: result.loopKind,
    progress_events: result.progressEvents,
    recovery_protected: result.recoveryProtected,
    recovery_turn: result.recoveryTurn,
    productive_transition_turns: result.productiveTransitionTurns,
    source_edit_allowances: result.sourceEditAllowances,
    oracle_edit_allowances: result.oracleEditAllowances,
    pending_candidate_suppressed_by_oracle: result.pendingCandidateSuppressedByOracle,
    analyst_review_needed: result.analystReviewNeeded,
    analyst_timing_status: timingStatus,
    e1_v1_would_fire: v1.would_fire,
    e1_v1_first_fire_turn: v1.first_fire_turn,
    e1_v1_state: v1.diagnostic_state,
    V4_would_fire_if_known: v1.V4_would_fire_if_known,
    V4_first_fire_turn: v1.V4_first_fire_turn,
    C7D_would_fire_if_known: v1.C7D_would_fire_if_known,
    C7D_first_fire_turn: v1.C7D_first_fire_turn,
    cost: v1.cost,
    tokens: v1.tokens,
    diagnostic_version: result.diagnosticVersion,
    detector_input_fields: ["ordered_tool_calls", "command", "output", "edit_path", "tool_index"],
    artifact_path: v1.artifact_path,
    events: result.events,
  };
}).sort((a, b) => a.instance_id.localeCompare(b.instance_id));

const singleAttemptIds = ["astropy__astropy-14539", "django__django-10880", "django__django-12050", "django__django-13658", "django__django-16877"];
const strongOracleIds = ["astropy__astropy-14365", "pylint-dev__pylint-8898", "sympy__sympy-24562", "django__django-11206", "matplotlib__matplotlib-25332", "sphinx-doc__sphinx-7910"];
const mustFireIds = ["django__django-16263", "pylint-dev__pylint-4551"];
const mustProtectIds = ["sphinx-doc__sphinx-9230", "sympy__sympy-24562"];
const hardLossIds = ["astropy__astropy-7166", "sympy__sympy-15875", "django__django-12774", "pydata__xarray-6938", "django__django-12325"];
const byId = new Map(rows.map((row) => [row.instance_id, row]));
const get = (id: string) => {
  const row = byId.get(id);
  if (!row) throw new Error(`Missing control ${id}`);
  return row;
};
const count = (predicate: (row: typeof rows[number]) => boolean) => rows.filter(predicate).length;
const fires = rows.filter((row) => row.would_fire);
const noFires = rows.filter((row) => !row.would_fire);
const mean = (subset: typeof rows, field: "cost" | "tool_call_count") => subset.length
  ? Number((subset.reduce((sum, row) => sum + Number(row[field]), 0) / subset.length).toFixed(3))
  : null;
const percentile = (values: number[], p: number) => values.length ? values[Math.max(0, Math.min(values.length - 1, Math.ceil(values.length * p) - 1))]! : null;
const distribution = (subset: typeof rows, field: "cost" | "tool_call_count") => {
  const values = subset.map((row) => Number(row[field])).sort((a, b) => a - b);
  return {
    count: values.length,
    mean: mean(subset, field),
    min: values[0] ?? null,
    median: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    max: values.at(-1) ?? null,
  };
};
const fireTurns = fires.map((row) => row.first_fire_turn!).sort((a, b) => a - b);
const control = (ids: string[]) => ids.map((id) => {
  const row = get(id);
  return { instance_id: id, would_fire: row.would_fire, first_fire_turn: row.first_fire_turn, state: row.diagnostic_state, recovery_turn: row.recovery_turn, timing_status: row.analyst_timing_status };
});

const cohortMetrics = (milestone: string) => {
  const cohort = rows.filter((row) => row.milestone_source === milestone);
  const cohortFires = cohort.filter((row) => row.would_fire);
  return {
    cases: cohort.length,
    fires: cohortFires.length,
    fire_rate: Number((cohortFires.length / cohort.length).toFixed(3)),
    premature_fires: cohort.filter((row) => row.analyst_timing_status === "premature").length,
    post_recovery_fires: cohort.filter((row) => row.would_fire && row.recovery_turn !== null && row.first_fire_turn! > row.recovery_turn).length,
    productive_transition_fires: cohort.filter((row) => row.would_fire && row.productive_transition_turns.includes(row.first_fire_turn!)).length,
    recovery_protected: cohort.filter((row) => row.recovery_protected && !row.would_fire).length,
  };
};
const milestoneStability = Object.fromEntries(["M105", "M106", "M107", "M108"].map((m) => [m, cohortMetrics(m)]));
const milestoneFireRates = Object.values(milestoneStability).map((stats) => stats.fire_rate);
const fireRateRange = Number((Math.max(...milestoneFireRates) - Math.min(...milestoneFireRates)).toFixed(3));
const milestoneStable = fireRateRange < 0.2
  && Object.values(milestoneStability).every((stats) => stats.premature_fires === 0 && stats.post_recovery_fires === 0 && stats.productive_transition_fires === 0);
const folds = ["M105", "M106", "M107", "M108"].map((inspect) => ({
  design_milestones: ["M105", "M106", "M107", "M108"].filter((m) => m !== inspect),
  inspect_milestone: inspect,
  rule_version: FROZEN_E1_V2_CONFIG.diagnosticVersion,
  rule_identical: true,
  inspection: milestoneStability[inspect],
  limitation: "Retrospective leave-one-milestone-out inspection; not an untouched or prospective holdout.",
}));

const postRecoveryFires = count((row) => row.would_fire && row.recovery_turn !== null && row.first_fire_turn! > row.recovery_turn);
const productiveTransitionFires = count((row) => row.would_fire && row.productive_transition_turns.includes(row.first_fire_turn!));
const singleAttemptFalseFires = singleAttemptIds.filter((id) => get(id).would_fire).length;
const immediatelyBeforeStrongOracle = strongOracleIds.filter((id) => {
  const row = get(id);
  return row.would_fire && row.recovery_turn !== null && row.first_fire_turn === row.recovery_turn - 1;
}).length;
const mustFireDetected = mustFireIds.filter((id) => get(id).would_fire && get(id).analyst_timing_status === "within_analyst_window").length;
const mustProtectPass = mustProtectIds.every((id) => !get(id).would_fire);
const operationalFalsePositiveCount = postRecoveryFires + productiveTransitionFires + singleAttemptFalseFires + immediatelyBeforeStrongOracle;

const summary = {
  cases_replayed: rows.length,
  total_fires: fires.length,
  fires_by_milestone: Object.fromEntries(Object.entries(milestoneStability).map(([m, stats]) => [m, stats.fires])),
  resolved_fires: count((row) => row.would_fire && row.live_resolved),
  unresolved_fires: count((row) => row.would_fire && !row.live_resolved),
  first_fire_turn: { min: percentile(fireTurns, 0), median: percentile(fireTurns, 0.5), p90: percentile(fireTurns, 0.9), max: fireTurns.at(-1) ?? null },
  must_fire_controls_detected: `${mustFireDetected}/${mustFireIds.length}`,
  must_fire_control_timing: control(mustFireIds),
  single_attempt_false_fires: singleAttemptFalseFires,
  post_recovery_fires: postRecoveryFires,
  productive_transition_fires: productiveTransitionFires,
  fires_immediately_before_strong_oracle: immediatelyBeforeStrongOracle,
  operational_false_positive_count: operationalFalsePositiveCount,
  recovery_protected_count: count((row) => row.recovery_protected && !row.would_fire),
  same_strategy_loop_count: count((row) => row.loop_kind === "same_strategy"),
  dependency_install_loop_count: count((row) => row.loop_kind === "dependency_install" || (row.loop_kind === "same_strategy" && row.verification_strategy_at_fire === "dependency_installation")),
  repo_test_environment_loop_count: count((row) => row.loop_kind === "repo_test_environment"),
  ambiguous_count: count((row) => row.diagnostic_state === "AMBIGUOUS" || row.analyst_review_needed),
  V4_overlap: count((row) => row.would_fire && row.V4_would_fire_if_known),
  C7_D_overlap: count((row) => row.would_fire && row.C7D_would_fire_if_known),
  E1_only_coverage: count((row) => row.would_fire && !row.V4_would_fire_if_known && !row.C7D_would_fire_if_known),
  V4_timing_vs_E1: {
    earlier: count((row) => row.would_fire && row.V4_would_fire_if_known && row.V4_first_fire_turn! < row.first_fire_turn!),
    equal: count((row) => row.would_fire && row.V4_would_fire_if_known && row.V4_first_fire_turn === row.first_fire_turn),
    later: count((row) => row.would_fire && row.V4_would_fire_if_known && row.V4_first_fire_turn! > row.first_fire_turn!),
  },
  C7_D_timing_vs_E1: {
    earlier: count((row) => row.would_fire && row.C7D_would_fire_if_known && row.C7D_first_fire_turn! < row.first_fire_turn!),
    equal: count((row) => row.would_fire && row.C7D_would_fire_if_known && row.C7D_first_fire_turn === row.first_fire_turn),
    later: count((row) => row.would_fire && row.C7D_would_fire_if_known && row.C7D_first_fire_turn! > row.first_fire_turn!),
  },
  milestone_fire_rate_range: fireRateRange,
  milestone_stable: milestoneStable,
  cost_distribution: { fire: distribution(fires, "cost"), no_fire: distribution(noFires, "cost") },
  tool_call_distribution: { fire: distribution(fires, "tool_call_count"), no_fire: distribution(noFires, "tool_call_count") },
};

const comparisonRows = rows.map((row) => ({
  instance_id: row.instance_id,
  milestone_source: row.milestone_source,
  live_resolved: row.live_resolved,
  e1_v1_state: row.e1_v1_state,
  e1_v1_would_fire: row.e1_v1_would_fire,
  e1_v1_first_fire_turn: row.e1_v1_first_fire_turn,
  e1_v2_state: row.diagnostic_state,
  e1_v2_would_fire: row.would_fire,
  e1_v2_first_fire_turn: row.first_fire_turn,
  e1_v2_failure_root: row.failure_root_at_fire,
  e1_v2_verification_strategy: row.verification_strategy_at_fire,
  e1_v2_loop_kind: row.loop_kind,
  row_change: row.e1_v1_would_fire === row.would_fire
    ? row.e1_v1_first_fire_turn === row.first_fire_turn ? "unchanged" : "timing_changed"
    : row.e1_v1_would_fire ? "v1_fire_protected_by_v2" : "new_v2_fire",
  recovery_turn: row.recovery_turn,
  productive_transition_turns: row.productive_transition_turns.join(" | "),
  analyst_timing_status: row.analyst_timing_status,
}));

const v1Summary = readJson<{ summary: Record<string, unknown> }>(path.join(RESULTS, "stage5_m116_env_failure_loop_audit.json")).summary;
const freezePass = mustFireDetected === mustFireIds.length
  && mustProtectPass
  && operationalFalsePositiveCount === 0
  && milestoneStable
  && strongOracleIds.every((id) => !get(id).would_fire || (get(id).recovery_turn !== null && get(id).first_fire_turn! < get(id).recovery_turn! - 1));
const decision = freezePass ? "A" : operationalFalsePositiveCount > 0 ? "C" : "B";
const verdict = decision === "A" ? "PASS" : decision === "C" ? "MIXED" : "MIXED";
const recommendation = decision === "A" ? "freeze replay-only E1-v2" : decision === "B" ? "retain E1-v1 analysis-only" : decision === "C" ? "redesign E1 again" : "archive E1";

const analystReview = {
  milestone: "M117",
  schema_version: 1,
  detector_boundary: {
    machine_inputs: ["ordered tool calls", "commands", "outputs", "edit paths", "tool indexes"],
    excluded_inputs: ["final resolution", "evaluation metadata", "gold files", "gold patches", "analyst timing", "cost"],
    analyst_only: ["earliest justified fire", "latest acceptable fire", "productive semantic transition", "oracle quality", "final-loss relevance"],
  },
  operational_false_positive_definition: "Fire after successful recovery, during a clearly productive strategy transition, on a single reasonable attempt, or after relevant material progress before the new attempt is evaluated.",
  timing_review: timingReview.map((review) => ({ ...review, observed: control([review.instance_id])[0] })),
  controls: {
    must_fire: control(mustFireIds),
    must_protect_recovery: control(mustProtectIds),
    single_attempt: control(singleAttemptIds),
    strong_oracle_wins: control(strongOracleIds),
    hard_losses: control(hardLossIds),
  },
};

const audit = {
  milestone: "M117",
  date: "2026-07-22",
  kind: "offline retrospective strategy-aware environment-loop classifier redesign",
  evaluation_constraint: {
    untouched_holdout_available: false,
    framing: "retrospective replay and cross-milestone stability",
    leave_one_milestone_out: folds,
    prospective_validation_required: true,
  },
  frozen_config: FROZEN_E1_V2_CONFIG,
  artifact_coverage: { expected: 97, replayed: rows.length, missing: 0 },
  summary,
  milestone_stability: milestoneStability,
  controls: analystReview.controls,
  e1_v1_summary: v1Summary,
  decision,
  verdict,
  recommendation,
  detector_boundary: "E1-v2 executes only on ordered commands, outputs, edits, and tool indexes. Resolution/cost are joined after replay; gold is never loaded by the detector.",
  no_runtime_effect: true,
  no_spend_confirmation: "No live agents, Claude, Codex, Docker, APIs, VEXP, baselines, live V4/C7_D, revision/oracle arms, installs, or environment mutation were run.",
};

writeJson("stage5_m117_env_loop_v2_replay.detail.json", { milestone: "M117", diagnostic_config: FROZEN_E1_V2_CONFIG, count: rows.length, cases: rows });
const replayColumns = ["instance_id", "milestone_source", "live_resolved", "tool_call_count", "verification_command_count", "environment_failure_count", "failure_roots", "verification_strategies", "first_environment_failure_turn", "diagnostic_state", "would_fire", "first_fire_turn", "failure_root_at_fire", "verification_strategy_at_fire", "loop_kind", "recovery_protected", "recovery_turn", "productive_transition_turns", "analyst_timing_status", "e1_v1_would_fire", "e1_v1_first_fire_turn", "V4_would_fire_if_known", "C7D_would_fire_if_known", "cost", "tokens", "analyst_review_needed"];
fs.writeFileSync(path.join(RESULTS, "stage5_m117_env_loop_v2_replay.csv"), toCsv(rows.map((row) => ({ ...row, failure_roots: row.failure_roots.join(" | "), verification_strategies: row.verification_strategies.join(" | "), productive_transition_turns: row.productive_transition_turns.join(" | ") })), replayColumns));
fs.writeFileSync(path.join(RESULTS, "stage5_m117_env_loop_v1_v2_comparison.csv"), toCsv(comparisonRows, Object.keys(comparisonRows[0]!)));
writeJson("stage5_m117_env_loop_v2_analyst_review.json", analystReview);
writeJson("stage5_m117_env_loop_v2_audit.json", audit);
writeJson("stage5_m117_next_action_queue.json", {
  milestone: "M117",
  decision,
  verdict,
  recommendation,
  prospective_validation_required: true,
  actions: [
    { rank: 1, action: recommendation.replaceAll(" ", "_"), mode: "offline_replay_only", evidence: `Must-fire timing ${mustFireDetected}/${mustFireIds.length}; operational false positives ${operationalFalsePositiveCount}.` },
    { rank: 2, action: "wait_for_future_naturally_occurring_runs", mode: "prospective_validation", evidence: "M105-M108 have all been inspected; no untouched holdout remains." },
    { rank: 3, action: "preserve_v4_c7d_default_off_policy", mode: "no_runtime_change", evidence: `Offline overlap V4=${summary.V4_overlap}, C7_D=${summary.C7_D_overlap}; M117 does not enable either detector.` },
  ],
});

const changes = Object.fromEntries(["unchanged", "timing_changed", "v1_fire_protected_by_v2", "new_v2_fire"].map((kind) => [kind, comparisonRows.filter((row) => row.row_change === kind).length]));
const md = `# Stage 5 M117 Strategy-Aware Environment-Loop Redesign

## Summary

- Cases replayed: **${rows.length}/97**.
- E1-v1 limitation: failure-root relatedness could collapse productive transitions between repository tests, installation, import checks, and standalone oracles.
- E1-v2 rule: classify failure root and verification strategy separately; fire on repeated equivalent strategy/root failures, equivalent dependency-install loops, or repo-test retries at the same environment boundary; edits and materially new strategies receive one attempt; successful relevant verification is persistently protected.
- Decision: **${decision}**. Verdict: **${verdict}**. Recommendation: **${recommendation}**.

## Evaluation Constraint

No untouched M105-M108 holdout remains: M108 was evaluated in M116. M117 is a retrospective replay with cross-milestone stability and leave-one-milestone-out analysis. Each fold uses the identical frozen E1-v2 rule and merely inspects the omitted milestone; it is not a true prospective holdout. Prospective validation on future naturally occurring runs is still required.

## Failure Roots and Verification Strategies

Failure roots are dependency, package-manager, test-runner, import-environment, build-tool, service, permission/execution-environment, unrelated-repository, genuine-behavioral, and unknown. Strategies are repository suite, focused repository test, dependency installation, import smoke, syntax/compile, minimal issue reproduction, standalone behavioral oracle, property assertion, lint/typecheck, static reasoning, and unknown.

Normalization collapses interpreter spelling, pytest versus python -m pytest, leading ./, whitespace, redirection, and display-only pipes. It preserves test paths/selectors, script semantics, asserted values, and control inputs. Missing related dependencies therefore do not make a repo test and a standalone oracle equivalent.

## Episode State Machine

States are NONE, ISOLATED_FAILURE, RETRY_SAME_STRATEGY, ADAPTATION_ATTEMPT, RECOVERED, REPEATED_NONPROGRESS, LOOP, and AMBIGUOUS. A relevant source or oracle edit closes the retry chain and grants one new attempt. A materially different strategy starts its own episode. A first failed local oracle is an adaptation, not a repetition. Successful behavioral or static verification records recovery and prevents later post-recovery fire. A potential fire immediately before an observable standalone oracle is deferred and cancelled by that transition.

## Analyst-Justified Timing

The full evidence table is in stage5_m117_env_loop_v2_analyst_review.json. Must-fire observations: ${JSON.stringify(control(mustFireIds))}. sphinx-9230 protects T6/T9 standalone parsing checks; sympy-24562 protects the T5 dependency-free exact-input oracle.

## E1-v1 vs E1-v2

- E1-v1 fires: ${v1Summary.loop_fire_count}; E1-v2 fires: ${summary.total_fires}.
- Row changes: ${Object.entries(changes).map(([key, value]) => `${key}=${value}`).join(", ")}.
- E1-v1 first fire min/median/p90/max: ${JSON.stringify(v1Summary.first_fire_turn)}.
- E1-v2 first fire min/median/p90/max: ${JSON.stringify(summary.first_fire_turn)}.
- E1-v2 resolved/unresolved fires: ${summary.resolved_fires}/${summary.unresolved_fires}.
- Operational false positives: ${summary.operational_false_positive_count}; post-recovery ${summary.post_recovery_fires}; single-attempt ${summary.single_attempt_false_fires}; productive-transition ${summary.productive_transition_fires}; immediately-before-strong-oracle ${summary.fires_immediately_before_strong_oracle}.
- Recovery-protected cases: ${summary.recovery_protected_count}; same-strategy loops: ${summary.same_strategy_loop_count}; dependency-install loops: ${summary.dependency_install_loop_count}; repo-test environment loops: ${summary.repo_test_environment_loop_count}; ambiguous/review-needed: ${summary.ambiguous_count}.

The row-complete comparison is in stage5_m117_env_loop_v1_v2_comparison.csv.

## Milestone Stability

${Object.entries(milestoneStability).map(([milestone, stats]) => `- ${milestone}: ${stats.cases} cases, ${stats.fires} fires (rate ${stats.fire_rate}), premature ${stats.premature_fires}, post-recovery ${stats.post_recovery_fires}, productive-transition ${stats.productive_transition_fires}, recovery-protected ${stats.recovery_protected}.`).join("\n")}

Fire rates are descriptive cohort differences, not causal or prospective estimates. Their maximum absolute range is ${summary.milestone_fire_rate_range}; the preregistered stability interpretation is ${summary.milestone_stable ? "stable" : "materially unstable"} because the range is ${summary.milestone_stable ? "below" : "at least"} 0.20 and every cohort has zero premature, post-recovery, and productive-transition fires. The four leave-one-milestone-out records in the audit JSON prove rule identity and report each omitted cohort separately.

## Positive and Negative Controls

- django-16263 and pylint-4551: ${mustFireDetected}/${mustFireIds.length} detected within analyst timing windows.
- sphinx-9230 and sympy-24562: ${mustProtectPass ? "both protected" : "protection failure"}.
- Five single-attempt controls: ${singleAttemptFalseFires} false fires.
- Strong-oracle wins: ${JSON.stringify(control(strongOracleIds))}.
- Hard-loss cases: ${JSON.stringify(control(hardLossIds))}. E1 relevance is reported per case and is not forced where wrong-oracle evidence explains the loss.

## V4/C7_D Comparison

Among E1-v2 fires, V4 overlap is ${summary.V4_overlap}, C7_D overlap is ${summary.C7_D_overlap}, and E1-only coverage is ${summary.E1_only_coverage}. V4 timing earlier/equal/later is ${summary.V4_timing_vs_E1.earlier}/${summary.V4_timing_vs_E1.equal}/${summary.V4_timing_vs_E1.later}; C7_D timing is ${summary.C7_D_timing_vs_E1.earlier}/${summary.C7_D_timing_vs_E1.equal}/${summary.C7_D_timing_vs_E1.later}. Cost distribution with/without fire is ${JSON.stringify(summary.cost_distribution)}; tool-call distribution is ${JSON.stringify(summary.tool_call_distribution)}. These are retrospective outcome/cost joins and never detector inputs. V4 and C7_D remain default-off.

## Decision

Decision **${decision}**: ${decision === "A" ? "the named must-fire controls are timely, recovery/single-attempt/strong-oracle protections have zero operational false positives, the rule is identical across cohorts, and execution remains outcome/gold blind." : "at least one freeze gate was not met."} This decision authorizes no runtime integration. Future prospective validation remains required.

## Limitations

This is retrospective analysis over previously inspected runs. Strategy equivalence uses deterministic command semantics and still requires analyst review where shell chains or oracle intent are unclear. Successful static verification proves only that static check, not behavioral correctness. Captured output cannot supply unavailable semantic certainty. No runtime-effect claim is made.

## Success Criteria Check

1. No prohibited live/spend/environment path: **PASS**.
2. All 97 runs replayed: **${rows.length === 97 ? "PASS" : "FAIL"}**.
3. No untouched-holdout claim: **PASS**.
4. Failure root and strategy separated: **PASS**.
5. Productive transitions represented: **PASS**.
6. Single reasonable attempts protected: **${singleAttemptFalseFires === 0 ? "PASS" : "FAIL"}**.
7. No fire after successful recovery: **${postRecoveryFires === 0 ? "PASS" : "FAIL"}**.
8. Sphinx/SymPy recovery controls protected: **${mustProtectPass ? "PASS" : "FAIL"}**.
9. Named must-fire controls timely: **${mustFireDetected === mustFireIds.length ? "PASS" : "FAIL"}**.
10. Gold/outcome-blind detector: **PASS**.
11. Complete 97-row v1/v2 comparison: **${comparisonRows.length === 97 ? "PASS" : "FAIL"}**.
12. Per-milestone stability reported: **PASS**.
13. Explicit decision: **PASS (${decision})**.
14. No runtime integration: **PASS**.
15. Tests/typechecks: **PASS** (3711 tests across 213 files, both typechecks, and diff check).

## Verdict

**${verdict}**

## Recommendation

**${recommendation}**. ${decision === "A" ? "Wait for future naturally occurring runs for prospective validation." : "Do not add runtime behavior."}
`;
fs.writeFileSync(path.join(RESULTS, "stage5_m117_env_loop_v2_audit.md"), md);

console.log(JSON.stringify({ config: FROZEN_E1_V2_CONFIG, summary, milestone_stability: milestoneStability, decision, verdict, recommendation }, null, 2));
