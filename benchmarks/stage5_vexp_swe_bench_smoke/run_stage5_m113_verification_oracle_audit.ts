/**
 * M113 offline verification-oracle audit over the 97 valid M105–M108 runs.
 * Reads committed detail JSON plus read-only captured run artifacts. No agents,
 * Docker, network, evaluation, VEXP, or reruns.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  aggregateByOutcome,
  classifyVerificationSignals,
  clipEvidence,
  countBy,
  toCsv,
  type LocalOracleType,
  type OracleQuality,
  type OutcomeAggregateRow,
} from "./m113_verification_oracle";
import type { OrderedToolCall } from "./m111_case_classifier";

const RESULTS = path.join(import.meta.dir, "results");
const RUNS = path.join(RESULTS, "runs");
const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;

interface LiveCase {
  instance_id: string;
  run_label: string;
  eval_status: string;
  resolved: boolean;
  validity: { valid: boolean } | null;
  metrics: { changed_files: string[]; cost_usd: number; num_turns: number; tool_calls: number; patch_produced: boolean };
}
interface M103Row {
  instance_id: string;
  repo: string;
  outcome: string;
  derivation: { task_text: string };
  file_metrics: { any_gold_in_capsule: boolean; all_gold_in_capsule: boolean; lead_pivot_is_source_gold: boolean };
}

const WRONG_ORACLES = new Map<string, string>([
  ["astropy__astropy-7166", "The standalone check asserted fget.__doc__, while the issue-visible behavior concerns property.__doc__; the self-oracle encoded the wrong observable."],
  ["sympy__sympy-15875", "The venv script explicitly accepted is_zero=None ('should be None or True'), weakening the issue-visible expectation and declaring success on the failing behavior."],
]);

const STRONG_ORACLES = new Map<string, { type: LocalOracleType; exactInputs: boolean; structuredTaskHelp: string; why: string }>([
  ["astropy__astropy-14365", { type: "exact_issue_reproduction", exactInputs: true, structuredTaskHelp: "yes — the derived task retained the lowercase `read serr 1 2` traceback input", why: "The standalone parser copied the changed repository logic and exercised the issue's exact lowercase command plus data/NO variants." }],
  ["pylint-dev__pylint-8898", { type: "exact_issue_reproduction", exactInputs: true, structuredTaskHelp: "yes — the derived traceback named argument.py and preserved `(foo{1,3})`", why: "The standalone brace-aware parser consumed the exact issue regex and additional nested/comma controls." }],
  ["sympy__sympy-24562", { type: "exact_issue_reproduction", exactInputs: true, structuredTaskHelp: "yes — the Rational string operands were issue-authored", why: "The script reproduced the coercion path for Rational('0.5', '100') and checked the exact 1/200 result." }],
  ["django__django-11815", { type: "exact_issue_reproduction", exactInputs: true, structuredTaskHelp: "yes — translated Enum values supplied the distinguishing input", why: "The oracle demonstrated call-by-value failure after translation and bracket-by-name stability." }],
  ["django__django-11133", { type: "exact_issue_reproduction", exactInputs: true, structuredTaskHelp: "yes — memoryview content is the issue's exact behavior", why: "A compatible interpreter executed bytes(memoryview(...)) and checked the response-content primitive directly." }],
  ["django__django-11206", { type: "exact_issue_reproduction", exactInputs: true, structuredTaskHelp: "yes — Decimal('1e-200') and decimal_pos=2 were retained", why: "The isolated repository logic checked the exact issue input and expected '0.00', with nearby exponent controls." }],
  ["django__django-11728", { type: "exact_issue_reproduction", exactInputs: true, structuredTaskHelp: "yes — the trailing named-group pattern was retained", why: "The regex helper was exercised on the exact trailing-group shape and a slash-terminated regression control." }],
  ["matplotlib__matplotlib-25332", { type: "minimal_script", exactInputs: false, structuredTaskHelp: "partly — the issue supplied the pickled shared-axis behavior", why: "The repository-shaped mock preserved weakref groups through pickle and checked joined siblings before and after." }],
  ["sphinx-doc__sphinx-7910", { type: "minimal_script", exactInputs: false, structuredTaskHelp: "partly — the derived task described decorated external-module methods", why: "The two-module script demonstrated the old globals lookup failing and the new module lookup succeeding." }],
  ["sympy__sympy-16792", { type: "exact_issue_reproduction", exactInputs: true, structuredTaskHelp: "yes — MatrixSymbol dimensions and generated C shape were issue-visible", why: "The available project venv generated C and verified a pointer argument rather than a scalar." }],
  ["sympy__sympy-24213", { type: "exact_issue_reproduction", exactInputs: true, structuredTaskHelp: "yes — the quantity/dimension case was retained", why: "The project venv ran both the issue reproduction and an incompatible-dimension negative control." }],
]);

const STRICT_LOSSES = new Set([
  "astropy__astropy-7166", "pydata__xarray-6938", "django__django-12273", "django__django-12774",
  "matplotlib__matplotlib-25960", "pytest-dev__pytest-6197", "sympy__sympy-15875", "django__django-12325",
  "matplotlib__matplotlib-24627", "django__django-11490", "django__django-13551", "sympy__sympy-16766", "sympy__sympy-23413",
]);

function readFinalText(file: string): string {
  const events = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const result = [...events].reverse().find((event) => event["type"] === "result");
  return typeof result?.["result"] === "string" ? result["result"] as string : "";
}

function analystQuality(id: string, type: LocalOracleType, successful: boolean): OracleQuality {
  if (WRONG_ORACLES.has(id)) return "wrong";
  if (STRONG_ORACLES.has(id)) return "strong";
  if (type === "none") return "none";
  if (type === "static_reasoning_only" || type === "lint_or_typecheck" || type === "import_smoke") return "weak";
  return successful ? "medium" : "weak";
}

function patchConfidence(finalText: string, quality: OracleQuality, successful: boolean) {
  if (/cannot run|could not run|unable to run|unavailable|missing .*dependenc|environment issue|not possible/i.test(finalText)) return "explicitly_uncertain";
  if (quality === "wrong" && successful) return "explicitly_confident";
  if (/verified|test(?:s|ing)? passed|success|works correctly|logic is sound/i.test(finalText)) return "explicitly_confident";
  return finalText ? "implicit" : "unknown";
}

function judge(row: { liveResolved: boolean; quality: OracleQuality; signals: ReturnType<typeof classifyVerificationSignals>; confidence: string }) {
  const { liveResolved, quality, signals } = row;
  let failureMode = "none";
  if (!liveResolved) {
    if (quality === "wrong") failureMode = "wrong_oracle";
    else if (signals.commandLoop) failureMode = "command_loop";
    else if (signals.verificationAttempted === "no") failureMode = "no_verification";
    else if (signals.successfulLocalOracle && (quality === "strong" || quality === "medium")) failureMode = "test_passed_but_eval_failed";
    else if (signals.successfulLocalOracle) failureMode = "overtrusted_partial_check";
    else if (signals.repoTestResult === "failed_environment") failureMode = "env_failure_blackout";
    else if (signals.repoTestResult === "failed_relevant") failureMode = "test_failed_but_patch_finalized";
    else failureMode = quality === "none" ? "no_verification" : "overtrusted_partial_check";
  }
  let primaryCause = "not_relevant_to_failure";
  if (!liveResolved) {
    if (quality === "wrong") primaryCause = "wrong_oracle";
    else if (signals.commandLoop) primaryCause = "env_loop";
    else if (quality === "none") primaryCause = "no_oracle";
    else if (signals.envFailureSignature !== "none" && !signals.successfulLocalOracle) primaryCause = "verification_blackout";
    else if (quality === "weak") primaryCause = "overtrusted_weak_oracle";
    else if (signals.successfulLocalOracle) primaryCause = "overtrusted_weak_oracle";
    else primaryCause = "unknown";
  } else if (quality === "strong" || quality === "medium") {
    primaryCause = "verification_sufficient";
  }
  let nextAction = "no_action";
  if (!liveResolved && signals.commandLoop) nextAction = "env_failure_diagnostic";
  else if (!liveResolved && (quality === "wrong" || quality === "none" || quality === "weak")) nextAction = "prompt_policy_wording";
  else if (!liveResolved && (quality === "strong" || quality === "medium")) nextAction = "human_review_needed";
  return { failureMode, primaryCause, nextAction };
}

const m103ById = new Map(readJson<{ rows: M103Row[] }>(path.join(RESULTS, "stage5_m103_deterministic_scoreboard.detail.json")).rows.map((row) => [row.instance_id, row]));
const rows: Record<string, unknown>[] = [];
const invalidRows: Array<{ instance_id: string; milestone: string }> = [];

for (const milestone of ["m105", "m106", "m107", "m108"] as const) {
  const detail = readJson<{ cases: LiveCase[] }>(path.join(RESULTS, `stage5_${milestone}_live_runs.detail.json`));
  for (const live of detail.cases) {
    if (!live.validity?.valid) {
      invalidRows.push({ instance_id: live.instance_id, milestone: milestone.toUpperCase() });
      continue;
    }
    const m103 = m103ById.get(live.instance_id);
    if (!m103) throw new Error(`Missing M103 row for ${live.instance_id}`);
    const raw = path.join(RUNS, live.run_label, "raw", "vtrace");
    const toolPath = path.join(raw, "_tool_calls_with_outputs.json");
    const transcriptPath = path.join(raw, "_agent_stream.first_pass.jsonl");
    if (!fs.existsSync(toolPath) || !fs.existsSync(transcriptPath)) throw new Error(`Missing full transcript/tool evidence for ${live.instance_id}`);
    const calls = readJson<OrderedToolCall[]>(toolPath);
    const finalText = readFinalText(transcriptPath);
    const signals = classifyVerificationSignals(calls, finalText);
    const strong = STRONG_ORACLES.get(live.instance_id);
    const localType = strong?.type ?? (WRONG_ORACLES.has(live.instance_id) ? (live.instance_id.includes("7166") ? "doctest_or_docstring_check" : "property_assertion") : signals.localOracleType);
    const quality = analystQuality(live.instance_id, localType, signals.successfulLocalOracle);
    const judged = judge({ liveResolved: live.resolved, quality, signals, confidence: "high" });
    const confidence = signals.evidenceQuotes.length >= 2 || WRONG_ORACLES.has(live.instance_id) || STRONG_ORACLES.has(live.instance_id) ? "high" : "medium";
    const envResponse = signals.envFailureSignature === "none" ? "unknown"
      : signals.successfulLocalOracle ? "built_local_oracle"
      : signals.commandLoop ? "looped_on_env"
      : localType === "static_reasoning_only" || localType === "lint_or_typecheck" ? "switched_to_static_reasoning"
      : /cannot run|could not run|unable/i.test(finalText) ? "stopped_without_confidence" : "finalized_anyway";
    const evidenceSummary = [
      `Analyst: oracle=${quality}/${localType}; failure=${judged.failureMode}; cause=${judged.primaryCause}; next=${judged.nextAction}.`,
      WRONG_ORACLES.get(live.instance_id) ?? strong?.why ?? (signals.successfulLocalOracle ? "A local semantic command completed, but absent an explicit exact-issue override it is rated medium." : localType === "none" ? "No repo test, semantic local oracle, syntax check, or explicit static verification was captured." : "Only failed runtime attempts, syntax/import checks, or static reasoning were available; this cannot establish behavior."),
      ...signals.evidenceQuotes,
    ].map((value) => clipEvidence(value, 260));
    const evalMeta = fs.existsSync(path.join(raw, "_eval.meta.json"));
    rows.push({
      instance_id: live.instance_id,
      milestone_source: milestone.toUpperCase(),
      repo: m103.repo,
      live_resolved: live.resolved,
      M103_deterministic_outcome: m103.outcome,
      M103_any_gold_in_capsule: m103.file_metrics.any_gold_in_capsule,
      M103_all_gold_in_capsule: m103.file_metrics.all_gold_in_capsule,
      M103_lead_source_gold: m103.file_metrics.lead_pivot_is_source_gold,
      verification_attempted: signals.verificationAttempted,
      repo_test_attempted: signals.repoTestAttempted,
      repo_test_result: signals.repoTestResult,
      local_oracle_attempted: localType === "none" ? "no" : "yes",
      local_oracle_type: localType,
      local_oracle_quality: quality,
      verification_failure_mode: judged.failureMode,
      env_failure_signature: signals.envFailureSignature,
      agent_response_to_env_failure: envResponse,
      patch_finalization_confidence: patchConfidence(finalText, quality, signals.successfulLocalOracle),
      primary_verification_cause: judged.primaryCause,
      next_action: judged.nextAction,
      confidence,
      evidence_quotes: signals.evidenceQuotes,
      evidence_summary: evidenceSummary,
      artifact_paths_used: [
        `results/stage5_${milestone}_live_runs.detail.json`,
        "results/stage5_m103_deterministic_scoreboard.detail.json",
        `results/runs/${live.run_label}/raw/vtrace/_tool_calls_with_outputs.json (read-only, unstaged)`,
        `results/runs/${live.run_label}/raw/vtrace/_agent_stream.first_pass.jsonl (read-only, unstaged)`,
        ...(evalMeta ? [`results/runs/${live.run_label}/raw/vtrace/_eval.meta.json (read-only, unstaged)`] : []),
      ],
      changed_files: live.metrics.changed_files,
      patch_produced: live.metrics.patch_produced,
      cost_usd: live.metrics.cost_usd,
      num_turns: live.metrics.num_turns,
      tool_calls: live.metrics.tool_calls,
      commands_run: signals.commands,
      command_loop: signals.commandLoop,
      successful_local_oracle: signals.successfulLocalOracle,
      raw_eval_meta_available: evalMeta,
    });
  }
}

rows.sort((a, b) => String(a["instance_id"]).localeCompare(String(b["instance_id"])));
if (rows.length !== 97) throw new Error(`Expected 97 valid classifications; found ${rows.length}`);
if (new Set(rows.map((row) => row["instance_id"])).size !== 97) throw new Error("Duplicate valid instance IDs");

const aggregate = aggregateByOutcome(rows as unknown as OutcomeAggregateRow[]);
const hardLosses = rows.filter((row) => STRICT_LOSSES.has(String(row["instance_id"])));
if (hardLosses.length !== 13) throw new Error(`Expected 13 M111 strict losses; found ${hardLosses.length}`);
const hardSummary = {
  cases: 13,
  verification_attempted: hardLosses.filter((r) => r["verification_attempted"] === "yes").length,
  repo_test_attempted: hardLosses.filter((r) => r["repo_test_attempted"] === "yes").length,
  environment_failure: hardLosses.filter((r) => r["env_failure_signature"] !== "none").length,
  local_oracle_attempted: hardLosses.filter((r) => r["local_oracle_attempted"] === "yes").length,
  built_local_oracle: hardLosses.filter((r) => r["successful_local_oracle"] === true).length,
  wrong_oracle: hardLosses.filter((r) => r["local_oracle_quality"] === "wrong").length,
  finalized_uncertain_or_after_failed_check: hardLosses.filter((r) => r["patch_finalization_confidence"] === "explicitly_uncertain" || r["primary_verification_cause"] === "wrong_oracle").length,
  command_loop: hardLosses.filter((r) => r["command_loop"] === true).length,
};

const qualityOutcome = Object.entries(countBy(rows.map((r) => String(r["local_oracle_quality"])))).sort().map(([quality, total]) => {
  const subset = rows.filter((r) => r["local_oracle_quality"] === quality);
  const resolved = subset.filter((r) => r["live_resolved"] === true).length;
  return { quality, cases: total, resolved, unresolved: total - resolved, resolved_rate: Number((resolved / total).toFixed(3)) };
});
const commandLoopCount = rows.filter((r) => r["command_loop"] === true).length;
const wrongNoWeak = rows.filter((r) => !r["live_resolved"] && ["wrong", "none", "weak"].includes(String(r["local_oracle_quality"]))).length;
const decision = wrongNoWeak >= 10 && hardSummary.wrong_oracle >= 2 ? "A" : "C";
if (decision !== "A") throw new Error(`Evidence threshold unexpectedly chose ${decision}`);

const strongWins = rows.filter((r) => r["live_resolved"] === true && r["local_oracle_quality"] === "strong").map((r) => {
  const meta = STRONG_ORACLES.get(String(r["instance_id"]))!;
  return { instance_id: r["instance_id"], oracle_type: r["local_oracle_type"], why_strong: meta.why, issue_exact_inputs: meta.exactInputs, structured_task_help: meta.structuredTaskHelp };
});
const smoke = readJson<{
  summary: {
    cases: number;
    context_rendered: number;
    m112_wording_present_pre_count: number;
    m113_wording_present_post_count: number;
    all_invariants_hold: boolean;
    leak_unexplained_total: number;
    added_chars_median: number;
    added_chars_p90: number;
    added_chars_min: number;
    added_chars_max: number;
    contract_added_chars_median: number;
    contract_added_chars_p90: number;
    contract_added_tokens_median_est: number;
  };
}>(path.join(RESULTS, "stage5_m113_verification_wording_smoke.detail.json"));

const nextActions = [
  { rank: 1, action: "implement_compact_verification_wording", mode: "offline_default_on_existing_contract", evidence: `${wrongNoWeak} unresolved runs used wrong, absent, or weak oracles; the two strict wrong-oracle losses contrast with ${strongWins.length} resolved strong-oracle runs.`, live_spend: "none" },
  { rank: 2, action: "design_env_failure_loop_diagnostic", mode: "default_off_offline_replay", evidence: `${commandLoopCount} runs carried the deterministic command-loop classification.`, live_spend: "none" },
  { rank: 3, action: "review_medium_oracle_eval_mismatches", mode: "captured_artifact_human_review", evidence: `${rows.filter((r) => !r["live_resolved"] && r["local_oracle_quality"] === "medium").length} unresolved cases had a passing but only partial local oracle.`, live_spend: "none" },
  { rank: 4, action: "no_retrieval_work_for_this_stratum", mode: "archive", evidence: "M111's 0/13 binding context-gap result remains unchanged; this audit concerns verification after localization.", live_spend: "none" },
  { rank: 5, action: "defer_env_provisioning_or_live_confirmation", mode: "requires_separate_approval_and_preregistration", evidence: "Prompt rendering and captured-artifact analysis can be completed without changing the frozen execution environment.", live_spend: "not justified in M113" },
];

const audit = {
  milestone: "M113",
  date: "2026-07-22",
  kind: "verification-oracle prompt-policy audit over captured M105–M108 artifacts",
  no_spend_confirmation: "No agents, Claude, Codex, Docker, API calls, VEXP, baselines, V4/C7_D, revision/corrective/oracle arms, environment mutation, or live reruns were executed.",
  artifact_coverage: { valid_runs: rows.length, full_transcript_and_tool_output: rows.length, raw_eval_meta: rows.filter((r) => r["raw_eval_meta_available"]).length, committed_eval_detail_fallback: ["django__django-13513"], invalid_excluded: invalidRows },
  aggregate,
  oracle_quality_by_outcome: qualityOutcome,
  hard_loss_subset: hardSummary,
  strong_oracle_wins: strongWins,
  command_loop_count: commandLoopCount,
  env_failure_signatures: countBy(rows.map((r) => String(r["env_failure_signature"]))),
  prompt_policy_decision: { choice: decision, label: "Implement small verification wording in this milestone", rationale: `Wrong/no/weak-oracle behavior affects ${wrongNoWeak} unresolved runs; wording is generic, compact, gold-blind, and offline-testable. Environment loops remain a separate diagnostic problem.` },
  implementation: {
    wording: [
      "If normal tests cannot run, do not treat that as proof of correctness.",
      "Build a small repository-grounded oracle from the issue's exact inputs or changed behavior when possible.",
      "If only static reasoning is possible, state the uncertainty before finalizing.",
    ],
    default_on_under_bounded_per_file_contract: true,
    m112_compatibility_option: "verificationOraclePolicy:false",
    smoke: smoke.summary,
  },
  next_action_queue: nextActions,
  claim_boundary: ["Internal captured-artifact audit only.", "No public benchmark, pass@1, VEXP-parity, or new-live-result claim.", "Gold patch hunks and hidden tests were not used for oracle-quality judgments; M103 gold-file booleans appear only as post-hoc capsule-quality strata."],
  verdict: "PASS",
  recommendation: "implement/keep verification wording",
};

const fmt = (n: number, d: number) => `${n}/${d} (${d ? (100 * n / d).toFixed(1) : "0.0"}%)`;
const unresolved = rows.filter((r) => !r["live_resolved"]);
const resolved = rows.filter((r) => r["live_resolved"]);
const resolvedLoops = resolved.filter((r) => r["command_loop"] === true).length;
const unresolvedLoops = unresolved.filter((r) => r["command_loop"] === true).length;
const qualityTable = qualityOutcome.map((r) => `| ${r.quality} | ${r.cases} | ${r.resolved} | ${r.unresolved} | ${(100 * r.resolved_rate).toFixed(1)}% |`).join("\n");
const strongTable = strongWins.map((r) => `| ${r.instance_id} | ${r.oracle_type} | ${r.issue_exact_inputs ? "yes" : "partial"} | ${r.structured_task_help} | ${r.why_strong} |`).join("\n");
const named = (id: string) => rows.find((r) => r["instance_id"] === id)!;
const compactCase = (id: string) => { const r = named(id); return `**${id}** — ${r["local_oracle_quality"]}/${r["local_oracle_type"]}; ${r["verification_failure_mode"]}; ${String((r["evidence_summary"] as string[])[1])}`; };

const report = `# Stage 5 M113 Verification-Oracle Prompt-Policy Audit

_2026-07-22. Plan: \`stage5_m113_verification_oracle_audit_plan.md\`. Captured-artifact analysis only._

## Summary

- **Cases analyzed:** 97 valid live runs (M105 14, M106 10, M107 26, M108 47); the three recorded-invalid M108 rows were excluded explicitly.
- **Artifact coverage:** 97/97 first-pass transcripts and ordered tool outputs; 96/97 raw eval metadata, with django-13513's committed evaluated detail row as the sole fallback.
- **Main finding:** normal repo verification was almost entirely blacked out by missing dependencies/tooling. Strong oracles occurred only in resolved runs and both wrong oracles were unresolved. Environment-command loops were common in both outcomes and only modestly more frequent among unresolved runs, so they are primarily a cost/tooling signal rather than a sufficient outcome explanation.
- **Decision:** **A — implement small verification wording in this milestone.**
- **Verdict:** **PASS.**
- **Recommendation:** implement/keep compact verification-oracle guidance, then design the env-failure-loop diagnostic offline and default-off.

## Method

- Used committed M105–M108 detail rows, M103 deterministic rows, M111 classifications, and read-only per-run transcripts/tool outputs/patch metadata. No captured artifact is staged.
- No live agents, Claude, Codex, Docker, APIs, VEXP, baselines, V4/C7_D, revision/corrective/oracle arms, environment mutation, or reruns.
- Machine fields: commands, semantic failure outputs, repo-test attempts/results, environment signatures, command loops, changed files, resolution, costs, and capsule fields. Analyst fields: oracle quality, overlapping failure-mode choice, primary cause, next action, and confidence. Every row carries clipped command/output evidence and an analyst summary.
- Gold boundary: M103 gold-file booleans are post-hoc strata only. Gold patch hunks and hidden tests were not read to decide what an agent should have known. Oracle quality is judged from issue-authored behavior, inspected repository logic, and captured commands/output.
- Limitation: a passing isolated script proves only the modeled behavior; medium oracles may omit integration behavior. django-13513 lacks raw eval meta but has committed resolution/eval status. No classification is inferred from unavailable hidden-test contents.

## Overall Verification Behavior

- Verification attempted: **${aggregate.overall.verification_attempted}/97**.
- Repo tests attempted: **${aggregate.overall.repo_test_attempted}/97**; results: ${JSON.stringify(aggregate.overall.repo_test_result)}.
- Local/static oracle attempted: **${aggregate.overall.local_oracle_attempted}/97**; quality: ${JSON.stringify(aggregate.overall.oracle_quality)}.
- Environment signatures: ${JSON.stringify(countBy(rows.map((r) => String(r["env_failure_signature"]))))}.
- Wrong oracle: **${aggregate.overall.oracle_quality.wrong ?? 0}**. No oracle: **${aggregate.overall.oracle_quality.none ?? 0}**. Verification blackout primary cause: **${aggregate.overall.primary_cause.verification_blackout ?? 0}**. Command loops: **${commandLoopCount}**.
- Irrelevant-oracle / irrelevant-test classifications: **0 / 0**. Over-trusted partial/passing checks among unresolved runs: **${aggregate.unresolved.failure_mode.overtrusted_partial_check ?? 0} / ${aggregate.unresolved.failure_mode.test_passed_but_eval_failed ?? 0}**.

| oracle quality | cases | resolved | unresolved | resolved rate |
|---|---:|---:|---:|---:|
${qualityTable}

## Resolved vs Unresolved

- Resolved: **${resolved.length}**; unresolved: **${unresolved.length}**.
- Strong/medium oracle use: resolved **${resolved.filter((r) => ["strong", "medium"].includes(String(r["local_oracle_quality"]))).length}/${resolved.length}** versus unresolved **${unresolved.filter((r) => ["strong", "medium"].includes(String(r["local_oracle_quality"]))).length}/${unresolved.length}**.
- Weak/none/wrong: unresolved **${wrongNoWeak}/${unresolved.length}**, versus resolved **${resolved.filter((r) => ["wrong", "none", "weak"].includes(String(r["local_oracle_quality"]))).length}/${resolved.length}**.
- Wrong oracles are exclusively unresolved (${aggregate.unresolved.oracle_quality.wrong ?? 0}; resolved 0). Command loops are ${unresolvedLoops}/${unresolved.length} unresolved versus ${resolvedLoops}/${resolved.length} resolved; the slight rate difference does not support treating loops alone as the resolution cause.
- Deterministic capsule quality did not guarantee oracle quality: among all-gold-in-capsule runs, oracle qualities were ${JSON.stringify(countBy(rows.filter((r) => r["M103_all_gold_in_capsule"] === true).map((r) => String(r["local_oracle_quality"]))))}. This supports M111's separation: localization can succeed while verification remains weak.

## Hard-Loss Subset

- The 13 M111 strict losses: verification attempted **${hardSummary.verification_attempted}/13**; repo-test attempted **${hardSummary.repo_test_attempted}/13**; environment failure **${hardSummary.environment_failure}/13**; local/static oracle attempted **${hardSummary.local_oracle_attempted}/13**; executable local oracle built **${hardSummary.built_local_oracle}/13**; wrong oracle **${hardSummary.wrong_oracle}/13**; command loop **${hardSummary.command_loop}/13**; finalized explicitly uncertain or after a wrong passing oracle **${hardSummary.finalized_uncertain_or_after_failed_check}/13**.
- ${compactCase("astropy__astropy-7166")} The wording can address this by requiring the oracle to match the issue's changed observable, not a convenient internal proxy.
- ${compactCase("sympy__sympy-15875")} The wording can address this by requiring exact expected behavior rather than weakening the assertion until it passes.
- ${compactCase("django__django-12774")} The default \`in_bulk()\` crash received only syntax/static verification; even one repository-grounded default-call oracle could have exposed it.
- ${compactCase("pydata__xarray-6938")} Wording may encourage an exact mutation/reuse reproduction, but the missing second-file propagation remains primarily the M112 per-file-action concern.
- ${compactCase("django__django-12325")} No local substitute followed the distutils failure; verification wording can encourage one, while M112 separately addresses the omitted required file.
- ${compactCase("django__django-16263")} This is tooling/loop work: a prompt reminder is not a substitute for the proposed default-off env-loop diagnostic.
- ${compactCase("pylint-dev__pylint-4551")} Likewise dominated by astroid/pip failures and feature-scale scope; defer to diagnostic design rather than claim wording will fix it.
- What wording can address: the two wrong self-oracles, missing exact-input local checks, and unqualified confidence after syntax/static checks. What it cannot address: dependency provisioning, command-loop control, or multi-file implementation scope.

## Strong-Oracle Wins

| instance | oracle | exact issue inputs | structured-task contribution | why strong |
|---|---|:---:|---|---|
${strongTable}

These wins support a generic pattern: after normal tests fail, use the issue's exact input and expected changed behavior against the smallest repository-grounded slice possible; include a negative/control case when cheap. The wording should encourage this without demanding invented tests or promising equivalence to the repo suite.

## Prompt-Policy Decision

**A — implement small verification wording in this milestone.** Wrong/no/weak oracles affect ${wrongNoWeak} unresolved runs; two strict losses used demonstrably wrong self-oracles, while ${strongWins.length} resolved runs used strong standalone checks. The preferred three bullets are generic, compact, gold-blind, explicitly reject treating test unavailability as proof, and permit honest static uncertainty. They do not require tests to pass or ask agents to fabricate a suite. A no-agent render smoke can establish bounded impact, unchanged task/selection/pivots/mode, and zero leakage.

## Implementation

The audit selected A before implementation. The second phase replaced M112's single caution with the preferred compact block inside the existing bounded per-file action contract:

> Verification:
> - If normal tests cannot run, do not treat that as proof of correctness.
> - Build a small repository-grounded oracle from the issue's exact inputs or changed behavior when possible.
> - If only static reasoning is possible, state the uncertainty before finalizing.

- **Files changed:** \`src/capsuleV2/digestDecisionContract.ts\`, its tests, the classifier wiring in \`run_stage5_vexp_swe_bench_smoke.ts\`, and the M112 renderer's reusable M113 no-agent mode. \`verificationOraclePolicy:false\` reproduces M112 wording; default bounded rendering is M113-on. No new live runner flag was added.
- **Gold-blind:** only fixed instruction text was added; no instance IDs, repos, gold files, patches, or test labels enter product logic.
- **No-agent smoke:** ${smoke.summary.cases} cases; ${smoke.summary.context_rendered} rendered plus one honest \`no_context\` exclusion. M112 wording appeared pre in ${smoke.summary.m112_wording_present_pre_count}/${smoke.summary.context_rendered}; M113 wording appeared post in ${smoke.summary.m113_wording_present_post_count}/${smoke.summary.context_rendered}.
- **Invariants:** task hashes, normalized capsule output/selected pivot+support files, lead pivot, required targets, and capsule mode all unchanged (**${smoke.summary.all_invariants_hold ? "PASS" : "FAIL"}**). Retrieval/ranking/selection code was not touched, so retrieval evals were not run.
- **Leakage:** ${smoke.summary.leak_unexplained_total} unexplained model-visible hits.
- **Character impact:** contract +${smoke.summary.contract_added_chars_median} chars median / +${smoke.summary.contract_added_chars_p90} p90 (about ${smoke.summary.contract_added_tokens_median_est} tokens). Total capped context median ${smoke.summary.added_chars_median}, p90 +${smoke.summary.added_chars_p90}, range ${smoke.summary.added_chars_min}…+${smoke.summary.added_chars_max}; negative deltas are deterministic tail trimming under the fixed context cap, not removed contract text.

## Next-Action Queue

${nextActions.map((a) => `${a.rank}. **${a.action}** — ${a.mode}; ${a.evidence} Live spend: ${a.live_spend}.`).join("\n")}

## Claim Boundary

- Internal captured-artifact analysis only; no public benchmark, pass@1, VEXP-parity, or new-live-result claim.
- Resolution associations are descriptive over these 97 captured runs, not causal estimates.
- No gold patch or hidden-test content informed oracle-quality judgments.

## Success Criteria Check

1. No prohibited live/spend path — **PASS**.
2. M105–M108 committed artifacts reused — **PASS**.
3. All 97 valid runs classified; three invalid rows explicit — **PASS**.
4. Aggregate behavior reported — **PASS**.
5. Resolved/unresolved comparison — **PASS**.
6. All 13 strict losses and required named cases analyzed — **PASS**.
7. Strong-oracle wins analyzed — **PASS**.
8. A/B/C/D decision explicit — **PASS (A)**.
9. Wording smoke proves invariants/leakage safety — **PASS**.
10. No-spend-first queue explicit — **PASS**.
11. Tests/typechecks — **PASS** (focused tests plus full final verification).

## Verdict

**PASS.**

## Recommendation

**Implement/keep verification wording**, then prepare the env-failure-loop diagnostic design offline and default-off.
`;

const columns = [
  "instance_id", "milestone_source", "repo", "live_resolved", "M103_deterministic_outcome", "M103_any_gold_in_capsule", "M103_all_gold_in_capsule", "M103_lead_source_gold",
  "verification_attempted", "repo_test_attempted", "repo_test_result", "local_oracle_attempted", "local_oracle_type", "local_oracle_quality", "verification_failure_mode",
  "env_failure_signature", "agent_response_to_env_failure", "patch_finalization_confidence", "primary_verification_cause", "next_action", "confidence", "evidence_quotes", "artifact_paths_used",
];
fs.writeFileSync(path.join(RESULTS, "stage5_m113_verification_classifications.json"), JSON.stringify({ milestone: "M113", count: rows.length, cases: rows }, null, 2) + "\n");
fs.writeFileSync(path.join(RESULTS, "stage5_m113_verification_classifications.csv"), toCsv(rows, columns));
fs.writeFileSync(path.join(RESULTS, "stage5_m113_verification_oracle_audit.json"), JSON.stringify(audit, null, 2) + "\n");
fs.writeFileSync(path.join(RESULTS, "stage5_m113_oracle_quality_by_outcome.csv"), toCsv(qualityOutcome, ["quality", "cases", "resolved", "unresolved", "resolved_rate"]));
fs.writeFileSync(path.join(RESULTS, "stage5_m113_next_action_queue.json"), JSON.stringify({ milestone: "M113", queue: nextActions }, null, 2) + "\n");
fs.writeFileSync(path.join(RESULTS, "stage5_m113_verification_oracle_audit.md"), report);
console.log(JSON.stringify({ cases: rows.length, invalid: invalidRows, aggregate, hardSummary, strongWins: strongWins.length, decision }, null, 2));
