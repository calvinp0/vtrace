/**
 * M111 — hard-stratum transcript study over CAPTURED artifacts only.
 *
 * Reads: committed M109/M103/M10x detail JSONs + read-only run folders under
 * results/runs/ (never staged). Writes: the M111 case classifications
 * (JSON+CSV), the machine-readable study summary, and the next-action queue.
 *
 * No live agents, no Docker, no network, no reruns. Machine fields are
 * computed by m111_case_classifier.ts; analyst judgment fields come from the
 * ANALYST table below, written after reading every case's captured transcript
 * (_agent_stream.first_pass.jsonl) and tool log — the evidence_summary cites
 * what the transcript shows.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m111_hard_stratum_transcript_study.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  classifyEditedGold,
  classifyPatchShape,
  classifyTestBehavior,
  runFolderLabel,
  toCsv,
  toolLoopSignatures,
  type AgentPatchShape,
  type OrderedToolCall,
  type TestBehavior,
} from "./m111_case_classifier";

const RESULTS = path.join(import.meta.dir, "results");
const RUNS = path.join(RESULTS, "runs");

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

// ---------------------------------------------------------------- case sets
const LOSS_CASES: ReadonlyArray<{ id: string; milestone: string }> = [
  { id: "astropy__astropy-7166", milestone: "m106" },
  { id: "pydata__xarray-6938", milestone: "m106" },
  { id: "django__django-12273", milestone: "m107" },
  { id: "django__django-12774", milestone: "m107" },
  { id: "matplotlib__matplotlib-25960", milestone: "m107" },
  { id: "pytest-dev__pytest-6197", milestone: "m107" },
  { id: "sympy__sympy-15875", milestone: "m107" },
  { id: "django__django-12325", milestone: "m107" },
  { id: "matplotlib__matplotlib-24627", milestone: "m107" },
  { id: "django__django-11490", milestone: "m108" },
  { id: "django__django-13551", milestone: "m108" },
  { id: "sympy__sympy-16766", milestone: "m108" },
  { id: "sympy__sympy-23413", milestone: "m108" },
];
const TOOL_LOOP_CASES: ReadonlyArray<{ id: string; milestone: string }> = [
  { id: "django__django-16263", milestone: "m107" },
  { id: "pylint-dev__pylint-4551", milestone: "m106" },
];
const CONTRAST_WINS: ReadonlyArray<{ id: string; milestone: string }> = [
  { id: "django__django-10973", milestone: "m108" },
  { id: "astropy__astropy-14539", milestone: "m108" },
  { id: "sympy__sympy-12419", milestone: "m107" },
  { id: "pylint-dev__pylint-8898", milestone: "m107" },
  { id: "astropy__astropy-14365", milestone: "m106" },
  { id: "sympy__sympy-24562", milestone: "m107" },
];

// ------------------------------------------------- analyst judgment table
interface AnalystJudgment {
  context_action_failure_type: string;
  primary_cause: string;
  confidence: "high" | "medium" | "low";
  evidence_summary: string;
  test_behavior_override?: TestBehavior;
  m111_reclassified_from_m109?: string;
}

const ANALYST: Record<string, AnalystJudgment> = {
  "astropy__astropy-7166": {
    context_action_failure_type: "gold_edited_wrong_logic",
    primary_cause: "agent_variance",
    confidence: "high",
    evidence_summary:
      "Ruled out both lexical noise pivots immediately, edited the gold InheritDocstrings metaclass, but inherited the docstring onto val.fget.__doc__ and verified with a self-written standalone metaclass whose oracle also checked fget.__doc__ (astropy itself unimportable: numpy missing). The captured M73-era run for the same instance patched the same site but asserted B.x.__doc__ (the property object's doc) in its standalone check and resolved — the loss encoded the wrong oracle, not the wrong location.",
    test_behavior_override: "relevant_tests_passed_but_eval_failed",
  },
  "pydata__xarray-6938": {
    context_action_failure_type: "single_file_patch_on_multifile_gold",
    primary_cause: "agent_variance",
    confidence: "high",
    evidence_summary:
      "Both gold files were in the capsule (variable.py as an optional target). First thinking correctly flagged BOTH mutation branches (to_index_variable AND to_base_variable set var.dims in place), and the agent grepped both methods in variable.py — then patched only the index branch call-site in dataset.py with .copy(). Its decision contract covered only pivot targets (the dataarray wrapper); the optional co-edit target variable.py never received an explicit EDIT/RULE_OUT decision. Repro blocked (numpy missing).",
  },
  "django__django-12273": {
    context_action_failure_type: "gold_edited_wrong_logic",
    primary_cause: "agent_variance",
    confidence: "high",
    evidence_summary:
      "Edited the gold base.py at _save_parents but inverted the pk/ptr sync (clearing the ptr field when pk is None) rather than making the save path insert. All repro attempts failed on env (distutils missing, runtests unimportable); shipped with 'CHECK RUN: could not run'. Docker eval failed.",
  },
  "django__django-12774": {
    context_action_failure_type: "gold_edited_wrong_logic",
    primary_cause: "agent_variance",
    confidence: "high",
    evidence_summary:
      "Edited gold query.py in_bulk with a total_unique_constraints check, but the rewrite computes opts.get_field(field_name) BEFORE the field_name != 'pk' short-circuit; get_field('pk') raises FieldDoesNotExist, so every default in_bulk() call crashes — a self-inflicted regression any single repo-test run would have caught. Env blocked all 4 test attempts (distutils/pytest/runtests).",
  },
  "matplotlib__matplotlib-25960": {
    context_action_failure_type: "gold_edited_wrong_logic",
    primary_cause: "agent_variance",
    confidence: "medium",
    evidence_summary:
      "Lead pivot was the gold subfigures site; agent traced to SubFigure._redo_transform_rel_fig and replaced the manual ratio math with SubplotSpec.get_position(self._parent), which routes through figure-level subplot params (margins) — plausible but eval-failed. No numpy, so the wspace/hspace repro never executed; correctness rested on code reading alone.",
  },
  "pytest-dev__pytest-6197": {
    context_action_failure_type: "gold_edited_wrong_logic",
    primary_cause: "agent_variance",
    confidence: "medium",
    m111_reclassified_from_m109: "deterministic_context_gap",
    evidence_summary:
      "M103 miss (both pivots noise) did NOT bind: the transcript shows the agent explicitly calling the pivots unrelated, searching collection code, and editing the gold pytest_collect_file in src/_pytest/python.py (removed the + [\"__init__.py\"] pattern). The sandbox repro it built could not run (pytest/atomicwrites missing, pip absent). Wrong fix semantics at the right site; the context gap cost search turns, not the outcome.",
  },
  "sympy__sympy-15875": {
    context_action_failure_type: "gold_edited_wrong_logic",
    primary_cause: "agent_variance",
    confidence: "high",
    m111_reclassified_from_m109: "deterministic_context_gap",
    test_behavior_override: "relevant_tests_passed_but_eval_failed",
    evidence_summary:
      "M103 miss did NOT bind: agent ruled out the agca/integrals noise pivots and went straight to gold add.py from the issue. It was the only loss to achieve real execution — it built a /tmp venv (setuptools+mpmath) and ran repo code — but its oracle accepted is_zero=None ('None or True') for an expression that is provably zero, so it converged on the weaker semantic and shipped. Eval expected the stronger answer.",
  },
  "django__django-12325": {
    context_action_failure_type: "single_file_patch_on_multifile_gold",
    primary_cause: "agent_variance",
    confidence: "medium",
    m111_reclassified_from_m109: "agent_variance (unchanged) — but patch-shape evidence adds the multi-file signal M109 did not record",
    evidence_summary:
      "Multi-file gold (base.py + options.py); the capsule carried options.py as a REQUIRED target but not base.py. The agent grepped the error message, found base.py on its own and edited only it (parent_links preference); options.py — gold, in the capsule — got neither an edit nor an explicit co-edit rule-out. Env blocked verification (distutils). Discovery succeeded; multi-file propagation failed.",
  },
  "matplotlib__matplotlib-24627": {
    context_action_failure_type: "gold_edited_wrong_logic",
    primary_cause: "agent_variance",
    confidence: "medium",
    evidence_summary:
      "Edited the gold axes/_base.py (unset .axes on children in __clear) and additionally the non-gold figure.py (unset .figure across artist lists). The direction matches the issue but eval failed — the clearing semantics did not match the expected behavior across all collections. No numpy: neither repro ran; the last thinking shows unresolved uncertainty about which attributes must be unset where.",
  },
  "django__django-11490": {
    context_action_failure_type: "gold_edited_wrong_logic",
    primary_cause: "agent_variance",
    confidence: "high",
    evidence_summary:
      "Edited the gold compiler.py get_combinator_sql — dropped the 'not compiler.query.values_select and' guard so values_select is always re-propagated. Six consecutive env-failure Bash attempts (distutils/setuptools/django unimportable) meant zero verification; docker eval failed. Same one-line-guard family of fix as the issue hints, but the chosen semantics were wrong.",
  },
  "django__django-13551": {
    context_action_failure_type: "gold_edited_wrong_logic",
    primary_cause: "agent_variance",
    confidence: "high",
    evidence_summary:
      "Edited the gold tokens.py _make_hash_value, appending getattr(user, 'email', None) or '' — hard-coding the attribute name instead of the user model's email-field contract its own risk note gestured at (AbstractBaseUser doesn't require 'email'). Only a syntax check ran (pytest/django/runtests all unavailable). Docker eval failed.",
  },
  "sympy__sympy-16766": {
    context_action_failure_type: "gold_edited_wrong_logic",
    primary_cause: "agent_variance",
    confidence: "low",
    evidence_summary:
      "Near-miss: added _print_Indexed to the gold PythonCodePrinter exactly where the issue asked, but deviated from the issue's own suggested implementation (str(base)) to self._print(base), which routes IndexedBase back through printer support machinery. mpmath missing + pip absent: never executed. Eval failed; the delta to the issue's snippet is the only transcript-visible difference, so confidence in the exact mechanism is low.",
  },
  "sympy__sympy-23413": {
    context_action_failure_type: "gold_edited_wrong_logic",
    primary_cause: "agent_variance",
    confidence: "medium",
    evidence_summary:
      "Edited the gold polys/matrices/normalforms.py but bolted a post-loop 'rescue leftmost nonzero column' scan onto _hermite_normal_form instead of fixing the pivot bookkeeping; shipped unverified (mpmath/numpy missing, pip absent) with an explicit 'could not run' note. Docker eval failed.",
  },
  // -------------------------------------------------- tool-loop cases
  "django__django-16263": {
    context_action_failure_type: "single_file_patch_on_multifile_gold",
    primary_cause: "tool_loop_or_budget",
    confidence: "medium",
    evidence_summary:
      "4-file gold; capsule carried 1 of 4 (sql/query.py — which the agent did edit). 38 tool calls / 93 turns / $3.01: 17 exploration calls before the first edit, then 4 edits to the same file (churn) inventing a bespoke get_annotation_refs stripping pass, plus an asgiref/pip env-failure loop. Ended at the spend ceiling without any runnable verification. The loop is an ENV-failure loop, not read-thrash: V4 would not fire (M78), and C7_D fired late and neutral on this exact case in the M85 live trial — both correctly stay default-off.",
  },
  "pylint-dev__pylint-4551": {
    context_action_failure_type: "single_file_patch_on_multifile_gold",
    primary_cause: "agent_variance",
    confidence: "medium",
    m111_reclassified_from_m109: "high_cost_tool_loop",
    evidence_summary:
      "M103 miss did not bind for discovery: the agent immediately recognized the checker pivots as 'None'-lexical false positives, globbed pyreverse, and read 2 of the 4 gold files (inspector.py, diagrams.py). It then attempted a feature-scale 4-file gold (type-hint UML support) as a bolt-on to inspector.py alone, iterating 4 edits amid an astroid/pip env-failure loop ($1.38, 27 calls). The cost signature is env-fighting plus scope underestimation, not a read/test loop.",
  },
  // -------------------------------------------------- contrast wins
  "django__django-10973": {
    context_action_failure_type: "unknown",
    primary_cause: "unknown",
    confidence: "high",
    evidence_summary:
      "WIN. Capsule lead was the exact gold client.py; agent read it once, rewrote runshell_db around subprocess.run + PGPASSWORD as the issue specified, self-reviewed via py_compile + git diff, resolved in 5 tool calls. One-shot correct: the task text fully determined the fix; M95-M104 chain delivered the file first.",
  },
  "astropy__astropy-14539": {
    context_action_failure_type: "unknown",
    primary_cause: "unknown",
    confidence: "high",
    evidence_summary:
      "WIN (M7.x regression recovered live). Lead pivot gold diff.py; agent traced identical→TableDataDiff._diff, found the VLA branch only checked 'P' formats, and made the one-token fix ('P' or 'Q'), grep-verifying the pattern parity with column.py. Runtime check blocked (erfa) — resolved anyway because the fix was structurally determined by the code it read.",
  },
  "sympy__sympy-12419": {
    context_action_failure_type: "unknown",
    primary_cause: "unknown",
    confidence: "high",
    evidence_summary:
      "WIN (M7.x regression recovered live). Capsule overpacked with a noise lead (quantum identitysearch), but gold matexpr.py was a required target; agent ignored the noise, replaced Identity._entry's Python `if i == j` with KroneckerDelta. mpmath blocked the check; resolved. Overpacking cost nothing here.",
  },
  "pylint-dev__pylint-8898": {
    context_action_failure_type: "unknown",
    primary_cause: "unknown",
    confidence: "high",
    evidence_summary:
      "WIN despite M103 miss AND multi-file gold. The M103 V5 derived task carried the issue traceback, which named argument.py::_regexp_csv_transfomer directly; the agent followed it, wrote a brace-aware CSV splitter, and — key contrast with the losses — validated with a FAITHFUL standalone oracle (reimplemented the parser and fed it the issue's exact '(foo{1,3})' input). Single-file patch sufficed for resolution.",
  },
  "astropy__astropy-14365": {
    context_action_failure_type: "unknown",
    primary_cause: "unknown",
    confidence: "high",
    evidence_summary:
      "WIN. Single-file capsule with gold lead qdp.py; agent grepped the error literal, added re.IGNORECASE + v.upper()=='NO', then standalone-tested _line_type with the issue's exact lowercase line ('read serr 1 2') — a faithful oracle mirroring issue-visible expected behavior. Resolved.",
  },
  "sympy__sympy-24562": {
    context_action_failure_type: "unknown",
    primary_cause: "unknown",
    confidence: "high",
    evidence_summary:
      "WIN. Capsule overpacked but lead gold numbers.py; agent derived the string-repetition bug ('100' * 2 → '100100') from first principles reading Rational.__new__, applied a 2-line coercion fix, and simulated the exact logic standalone. Resolved.",
  },
};

// ------------------------------------------------------------- input shapes
interface M103Row {
  instance_id: string;
  repo: string;
  gold: { scored_files: string[]; multi_file: boolean };
  capsule: {
    mode: string;
    lead_pivot_file: string | null;
    required_files: string[];
    optional_files: string[];
    capsule_files: string[];
  };
  file_metrics: {
    any_gold_in_capsule: boolean;
    all_gold_in_capsule: boolean;
    lead_pivot_is_source_gold: boolean;
  };
  outcome: string;
}
interface LiveCase {
  instance_id: string;
  run_label: string;
  resolved: boolean;
  metrics: {
    changed_files: string[];
    cost_usd: number;
    num_turns: number;
    tool_calls: number;
  };
  historical: {
    m73_treatment_resolved: boolean | null;
    m92_resolved: boolean | null;
  };
}
interface M109Case {
  instance_id: string;
  milestone: string;
  flip_type: string;
  likely_reason: string | null;
}

// ------------------------------------------------------------------- main
const m103Rows = new Map(
  readJson<{ rows: M103Row[] }>(
    path.join(RESULTS, "stage5_m103_deterministic_scoreboard.detail.json"),
  ).rows.map((r) => [r.instance_id, r]),
);
const liveCases = new Map<string, LiveCase>();
for (const m of ["m105", "m106", "m107", "m108"]) {
  const detail = readJson<{ cases: LiveCase[] }>(
    path.join(RESULTS, `stage5_${m}_live_runs.detail.json`),
  );
  for (const c of detail.cases) liveCases.set(c.instance_id, c);
}
const m109 = readJson<{ cases: M109Case[] }>(
  path.join(RESULTS, "stage5_m109_hard_stratum_analysis.json"),
);
const m109ByInstance = new Map(m109.cases.map((c) => [c.instance_id, c]));

// verify the loss set matches M109 exactly (success criterion 3)
const m109Losses = m109.cases
  .filter((c) => c.flip_type === "live_loss_vs_M73")
  .map((c) => c.instance_id)
  .sort();
const plannedLosses = LOSS_CASES.map((c) => c.id).sort();
if (JSON.stringify(m109Losses) !== JSON.stringify(plannedLosses)) {
  throw new Error(
    `M109 loss set mismatch:\n m109=${m109Losses.join(",")}\n plan=${plannedLosses.join(",")}`,
  );
}

type Group = "strict_live_loss" | "tool_loop_high_cost" | "contrast_win";
const ALL_CASES: Array<{ id: string; milestone: string; group: Group }> = [
  ...LOSS_CASES.map((c) => ({ ...c, group: "strict_live_loss" as Group })),
  ...TOOL_LOOP_CASES.map((c) => ({ ...c, group: "tool_loop_high_cost" as Group })),
  ...CONTRAST_WINS.map((c) => ({ ...c, group: "contrast_win" as Group })),
];

const rows: Array<Record<string, unknown>> = [];
for (const { id, milestone, group } of ALL_CASES) {
  const label = runFolderLabel(id, milestone);
  const raw = path.join(RUNS, label, "raw", "vtrace");
  const m103 = m103Rows.get(id);
  const live = liveCases.get(id);
  const judged = ANALYST[id];
  if (!m103 || !live || !judged) {
    throw new Error(`missing canonical inputs for ${id}`);
  }

  const artifactPaths: string[] = [
    `results/stage5_${milestone}_live_runs.detail.json`,
    "results/stage5_m103_deterministic_scoreboard.detail.json",
    "results/stage5_m109_hard_stratum_analysis.json",
  ];
  let toolCalls: OrderedToolCall[] = [];
  let toolCallsWithOutputs: OrderedToolCall[] = [];
  let patchChars: number | null = null;
  let transcriptEvents: number | null = null;
  let artifactCoverage = "summary_only";
  if (fs.existsSync(raw)) {
    artifactCoverage = "full";
    toolCalls = readJson<OrderedToolCall[]>(path.join(raw, "_tool_calls.json"));
    toolCallsWithOutputs = readJson<OrderedToolCall[]>(
      path.join(raw, "_tool_calls_with_outputs.json"),
    );
    const jsonl = fs
      .readdirSync(raw)
      .filter((f) => f.startsWith("swebench-") && f.endsWith(".jsonl"));
    if (jsonl.length > 0) {
      const row = JSON.parse(
        fs.readFileSync(path.join(raw, jsonl[0]!), "utf8").trim().split("\n")[0]!,
      ) as { modelPatch?: string };
      patchChars = (row.modelPatch ?? "").length;
    }
    transcriptEvents = fs
      .readFileSync(path.join(raw, "_agent_stream.first_pass.jsonl"), "utf8")
      .trim()
      .split("\n").length;
    artifactPaths.push(
      `results/runs/${label}/raw/vtrace/_agent_stream.first_pass.jsonl (read-only, unstaged)`,
      `results/runs/${label}/raw/vtrace/_tool_calls_with_outputs.json (read-only, unstaged)`,
    );
  }

  const gold = m103.gold.scored_files;
  const changed = live.metrics.changed_files;
  const edited = classifyEditedGold(changed, gold);
  const patchShape: AgentPatchShape = classifyPatchShape(changed, gold, live.resolved);
  const signatures = toolLoopSignatures(toolCallsWithOutputs.length ? toolCallsWithOutputs : toolCalls, {
    costUsd: live.metrics.cost_usd,
    numTurns: live.metrics.num_turns,
    patchEmpty: patchChars === 0,
  });
  const testBehavior: TestBehavior =
    judged.test_behavior_override ??
    (artifactCoverage === "full"
      ? classifyTestBehavior(toolCallsWithOutputs, live.resolved)
      : "unknown");

  rows.push({
    instance_id: id,
    repo: m103.repo,
    group,
    milestone_source: milestone.toUpperCase(),
    run_label: label,
    artifact_coverage: artifactCoverage,
    live_resolved: live.resolved,
    M73_treatment_resolved: live.historical.m73_treatment_resolved,
    M92_resolved_if_available: live.historical.m92_resolved,
    M103_deterministic_outcome: m103.outcome,
    M103_any_gold_in_capsule: m103.file_metrics.any_gold_in_capsule,
    M103_all_gold_in_capsule: m103.file_metrics.all_gold_in_capsule,
    M103_lead_source_gold: m103.file_metrics.lead_pivot_is_source_gold,
    capsule_mode: m103.capsule.mode,
    capsule_lead_pivot_file: m103.capsule.lead_pivot_file,
    changed_files: changed,
    gold_files: gold,
    gold_multi_file: m103.gold.multi_file,
    agent_edited_gold_file: edited.agentEditedGoldFile,
    agent_edited_non_gold_file: edited.agentEditedNonGoldFile,
    agent_patch_shape: patchShape,
    tool_loop_signature: signatures,
    test_behavior: testBehavior,
    context_action_failure_type: judged.context_action_failure_type,
    primary_cause: judged.primary_cause,
    confidence: judged.confidence,
    m109_likely_reason: m109ByInstance.get(id)?.likely_reason ?? null,
    m109_flip_type: m109ByInstance.get(id)?.flip_type ?? "not_in_m109_case_list",
    m111_reclassified_from_m109: judged.m111_reclassified_from_m109 ?? null,
    cost_usd: live.metrics.cost_usd,
    num_turns: live.metrics.num_turns,
    tool_calls: live.metrics.tool_calls,
    patch_chars: patchChars,
    transcript_events: transcriptEvents,
    evidence_summary: judged.evidence_summary,
    artifact_paths_used: artifactPaths,
  });
}

// -------------------------------------------------------------- aggregates
const losses = rows.filter((r) => r["group"] === "strict_live_loss");
const count = (pred: (r: Record<string, unknown>) => boolean) => losses.filter(pred).length;
const lossAnatomy = {
  losses_total: losses.length,
  all_gold_in_capsule: count((r) => r["M103_all_gold_in_capsule"] === true),
  lead_source_gold: count((r) => r["M103_lead_source_gold"] === true),
  edited_at_least_one_gold_file: count((r) => r["agent_edited_gold_file"] !== "no"),
  edited_no_gold_despite_gold_in_capsule: count(
    (r) => r["agent_edited_gold_file"] === "no" && r["M103_any_gold_in_capsule"] === true,
  ),
  no_patch: count((r) => r["agent_patch_shape"] === "no_patch"),
  single_file_patch_on_multifile_gold: count(
    (r) => r["gold_multi_file"] === true && (r["changed_files"] as string[]).length === 1,
  ),
  // no loss ever ran the repo's own test suite (env blackout); these two are
  // the standalone-oracle / venv-repro executions (astropy-7166, sympy-15875)
  repo_test_suite_executed: 0,
  agent_verification_executed_but_eval_failed: count(
    (r) =>
      r["test_behavior"] === "relevant_tests_failed" ||
      r["test_behavior"] === "relevant_tests_passed_but_eval_failed",
  ),
  any_tool_loop_signature: count(
    (r) => !(r["tool_loop_signature"] as string[]).includes("none"),
  ),
  primary_cause_agent_variance: count((r) => r["primary_cause"] === "agent_variance"),
  primary_cause_deterministic_context_gap: count(
    (r) => r["primary_cause"] === "deterministic_context_gap",
  ),
};

const nextActionQueue = [
  {
    rank: 1,
    action: "improve_digest_context_action_wording",
    lever:
      "Extend the digest decision contract so EVERY capsule file (required AND optional) needs an explicit EDIT / RULE_OUT decision, with hidden-coedit phrasing on optional targets ('files that historically change together with the lead').",
    evidence:
      "xarray-6938: variable.py (gold, optional) never received a decision while the agent's own analysis flagged its mutation path; django-12325: options.py (gold, required) got neither edit nor rule-out.",
    expected_impact: "1-2 of the 13 strict losses (the multi-file propagation class).",
    no_spend_first_step:
      "Offline: change the injected contract text, re-audit captured M106-M108 decision-contract tables for per-file coverage; no agents.",
  },
  {
    rank: 2,
    action: "verification_oracle_prompt_policy",
    lever:
      "When repo tests cannot run (standing env property of the live protocol), PATCH_VERIFY's CHECK RUN should require a standalone oracle that mirrors the ISSUE's expected output verbatim, and forbid counting a self-invented oracle as verification.",
    evidence:
      "Losses shipped after 'CHECK RUN: could not run' 11/13 times or validated against a wrong self-oracle (7166 fget.__doc__ vs property doc; 15875 accepted is_zero=None). Wins 8898/14365/24562 built faithful oracles from the issue's exact inputs and resolved.",
    expected_impact: "Several wrong-logic losses; largest single class (11/13).",
    no_spend_first_step:
      "Offline: classify CHECK RUN text vs resolution across all 97 captured runs to size the correlation before any prompt change.",
  },
  {
    rank: 3,
    action: "env_failure_loop_diagnostic_design",
    lever:
      "Design (default-off, diagnostic-only) a detector for >=3 consecutive ModuleNotFoundError/pip-absent Bash failures that injects a single advisory: 'this environment cannot run repo tests; stop retrying installs and verify by faithful standalone oracle'.",
    evidence:
      "command_failure_loop signatures across losses and both tool-loop cases; 16263 spent a large share of its $3.01 on asgiref/pip retries; neither V4 nor C7_D targets this loop class (M78/M85).",
    expected_impact: "Cost reduction on the tool-loop class; possibly converts none directly.",
    no_spend_first_step: "Design doc + offline replay over captured tool logs.",
  },
  {
    rank: 4,
    action: "no_action_on_retrieval_for_hard_stratum",
    lever: "None — do not spend retrieval/capsule/packing effort on the strict-loss stratum.",
    evidence:
      "0/13 losses had a binding deterministic context gap: every loss edited a gold file; both M109 'deterministic_context_gap' cases (pytest-6197, sympy-15875) recovered the gold file in-transcript.",
    expected_impact: "Avoids spending on a non-binding constraint.",
    no_spend_first_step: "Record in ledger; keep M100/M103 mined-out findings standing.",
  },
  {
    rank: 5,
    action: "defer_env_provisioning_change",
    lever:
      "Pre-provisioning repo deps for the agent shell would change the frozen protocol and requires a new preregistered paired arm (live spend) — defer until the no-spend levers above are exhausted.",
    evidence:
      "Verification blackout is standing (the captured M73-era run hit the same wall), so it does not explain the M73 delta by itself; but it converts hard cases into one-shot logic bets.",
    expected_impact: "Unknown; potentially large but expensive to measure validly.",
    no_spend_first_step: "None now (explicitly deferred).",
  },
];

const study = {
  milestone: "M111",
  kind: "hard-stratum transcript study from captured artifacts (no live agents, no Docker, no reruns, no VEXP, no V4/C7_D, no revision arms)",
  date: "2026-07-10",
  case_sets: {
    strict_live_losses: LOSS_CASES.map((c) => c.id),
    tool_loop_high_cost: TOOL_LOOP_CASES.map((c) => c.id),
    contrast_wins: CONTRAST_WINS.map((c) => c.id),
    id_mapping_note:
      "The M111 prompt's named-loss list includes django-10973, astropy-14539, sympy-12419, pylint-8898; in the committed M109 JSON these are a no_M73_row resolve and three wins/agreement-resolves, covered here in the contrast set.",
  },
  artifact_coverage: {
    cases_analyzed: rows.length,
    full_transcript_patch_eval: rows.filter((r) => r["artifact_coverage"] === "full").length,
    summary_only: rows.filter((r) => r["artifact_coverage"] === "summary_only").length,
  },
  loss_anatomy: lossAnatomy,
  m109_revision: {
    m109_reason_split: { agent_variance: 10, single_file_patch_on_multifile_gold: 1, deterministic_context_gap: 2 },
    m111_reason_split: {
      agent_variance_wrong_logic_at_gold_site: 11,
      agent_variance_multi_file_propagation: 2,
      binding_deterministic_context_gap: 0,
    },
    reclassified_cases: rows
      .filter((r) => r["m111_reclassified_from_m109"])
      .map((r) => ({
        instance_id: r["instance_id"],
        from: r["m109_likely_reason"],
        to: r["primary_cause"],
        note: r["m111_reclassified_from_m109"],
      })),
  },
  main_findings: [
    "Every one of the 13 strict live losses produced a patch and edited at least one gold file; there are zero wrong-file patches and zero no-patch losses. The hard stratum fails on WRONG LOGIC AT THE GOLD SITE (11/13) or MISSING THE SECOND GOLD FILE (2/13), never on failing to find the code.",
    "The two M109 'deterministic context gap' losses (pytest-6197, sympy-15875) are non-binding: both transcripts show the agent ruling out the noise pivots and independently editing the gold file. Binding deterministic gaps in the strict-loss set: 0/13.",
    "Verification blackout is the shared mechanism: in no loss did a repo test suite run (numpy/mpmath/distutils/asgiref missing; pip absent; host-pip firewalled). 11/13 losses shipped with an explicit 'CHECK RUN: could not run' (or equivalent); the two that did execute code validated against self-invented oracles that encoded the wrong semantics. The captured M73-era run of astropy-7166 faced the SAME env wall but chose a faithful oracle (property.__doc__) and resolved — the env is a standing property of the protocol, not a guard regression, and it converts hard cases into one-shot logic bets.",
    "Contrast wins are one-shot-correct under identical constraints: fixes structurally determined by the issue/traceback/code (10973, 14539, 12419, 24562) or validated by FAITHFUL standalone oracles built from the issue's exact inputs (8898, 14365). The M103 V5 traceback extraction directly enabled the pylint-8898 win on an M103 miss.",
    "Tool-loop cases are env-failure loops plus scope underestimation on multi-file feature golds (16263: 4-file gold, 1 in capsule; 4551: 4-file gold, miss). Neither V4 (read-thrash) nor C7_D (edit-churn cost) targets this loop class; both stay default-off (M78/M83/M85/M88 standing).",
  ],
  next_action_queue: nextActionQueue,
  claim_boundary: [
    "Internal captured-artifact analysis only; no public SWE-bench pass@1 claim, no VEXP parity claim, no new live results.",
    "Gold file lists came from the committed M103 scoring artifact and were used only for post-hoc set comparisons; agent-behavior narratives are transcript-only; gold patch hunks were not used to judge agent logic.",
  ],
  verdict: "PASS",
  recommendation: "improve digest/context-action wording",
};

// ------------------------------------------------------------------ outputs
const outClassJson = path.join(RESULTS, "stage5_m111_case_classifications.json");
const outClassCsv = path.join(RESULTS, "stage5_m111_case_classifications.csv");
const outStudy = path.join(RESULTS, "stage5_m111_hard_stratum_transcript_study.json");
const outQueue = path.join(RESULTS, "stage5_m111_next_action_queue.json");

fs.writeFileSync(
  outClassJson,
  JSON.stringify({ milestone: "M111", count: rows.length, cases: rows }, null, 2) + "\n",
);
const CSV_COLUMNS = [
  "instance_id",
  "repo",
  "group",
  "milestone_source",
  "live_resolved",
  "M73_treatment_resolved",
  "M92_resolved_if_available",
  "M103_deterministic_outcome",
  "M103_any_gold_in_capsule",
  "M103_all_gold_in_capsule",
  "M103_lead_source_gold",
  "capsule_mode",
  "changed_files",
  "gold_files",
  "gold_multi_file",
  "agent_edited_gold_file",
  "agent_edited_non_gold_file",
  "agent_patch_shape",
  "tool_loop_signature",
  "test_behavior",
  "context_action_failure_type",
  "primary_cause",
  "confidence",
  "m109_likely_reason",
  "m111_reclassified_from_m109",
  "cost_usd",
  "num_turns",
  "tool_calls",
  "evidence_summary",
];
fs.writeFileSync(outClassCsv, toCsv(rows, CSV_COLUMNS));
fs.writeFileSync(outStudy, JSON.stringify(study, null, 2) + "\n");
fs.writeFileSync(outQueue, JSON.stringify({ milestone: "M111", queue: nextActionQueue }, null, 2) + "\n");

console.log(`M111 study: ${rows.length} cases (${losses.length} losses)`);
console.log("loss anatomy:", JSON.stringify(lossAnatomy, null, 2));
console.log("wrote:", [outClassJson, outClassCsv, outStudy, outQueue].map((p) => path.relative(RESULTS, p)).join(", "));
