// Stage 5 M104 — live-path structured-task parity + leakage no-agent smoke.
//
// Builds, for a small representative case set, the EXACT model-visible context a
// live `--protocol vtrace-indexed` run would inject (the same buildCapsuleV2Task
// task text, the same `vtrace capsule … --intent auto --budget … --pivot-
// neighborhood --json` CLI subprocess over the M103 clean indexed workspaces, the
// same classifyCapsuleOutput options, the same cost-aware gate, and the same
// buildVtraceContextMarkdown limits as the canonical protocol command) — WITHOUT
// spawning an agent. It then proves:
//
//   parity  — the live task text is byte-identical to the deterministic M103
//             derivation (shared module AND the frozen M103 detail rows);
//   leakage — neither the task nor the assembled model-visible markdown contains
//             FAIL_TO_PASS / PASS_TO_PASS ids, gold-patch text, hints, or
//             scoring-diagnostic markers; gold paths in the task are
//             issue-authored (psf-5414 policy), never gold-patch-derived.
//
// NO Claude, NO Docker, NO agent spawn, NO API calls, NO network. The only
// subprocess is the local `vtrace capsule` CLI over pre-existing workspaces.
//
// Usage:
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m104_live_context_smoke.ts \
//     [--data /home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl] \
//     [--out benchmarks/stage5_vexp_swe_bench_smoke/results]

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  applyContextPolicyOverride,
  buildCapsuleV2Task,
  buildVtraceQueryCommand,
  classifyCapsuleOutput,
  decideCapsuleV2ContextPolicy,
  deriveContextPolicySignals,
  buildVtraceContextMarkdown,
  loadSweBenchData,
  parseArgs,
  toSweBenchInstance,
  type SweBenchInstance,
  type VtraceContextSection,
} from "./run_stage5_vexp_swe_bench_smoke";
import { deriveStructuredTaskFromProblemStatement } from "./stage5_task_derivation";
import { assessGoldLeakage, extractGold } from "./stage5_m94_lib";
import { normalizeFilePath } from "./run_stage5_retrieval_eval";

const DEFAULT_DATA = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";
const RESULTS_ROOT = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "results");
const WS_ROOT = path.join(RESULTS_ROOT, "workspaces");
const INDEX_RELPATH = path.join(".vtrace", "index.sqlite");
const CLEAN_WS_ROOTS = ["expanded", "cross_repo"] as const;
const M103_DETAIL = path.join(RESULTS_ROOT, "stage5_m103_deterministic_scoreboard.detail.json");

// The M104 smoke case set (see stage5_m104_live_path_parity_plan.md §9):
// leakage-policy case, the three M103 regression guards, M103 wins (incl.
// holdout), an unchanged holdout miss, multi-file co-edit / import-reexport /
// file-evidence-rescue recoveries, and cross-repo coverage.
export const SMOKE_CASE_IDS: readonly string[] = [
  "psf__requests-5414",
  "django__django-13513",
  "matplotlib__matplotlib-22719",
  "pydata__xarray-4695",
  "psf__requests-1724",
  "sympy__sympy-13372",
  "sympy__sympy-13480",
  "django__django-16938",
  "django__django-13810",
  "astropy__astropy-14369",
  "django__django-16256",
  "django__django-13195",
  "mwaskom__seaborn-3187",
  "sphinx-doc__sphinx-7462",
];

// ---------------------------------------------------------------------------
// Leakage scanning (pure; unit-tested)
// ---------------------------------------------------------------------------

export interface LeakHit {
  readonly kind: string;
  readonly needle: string;
  readonly snippet: string;
}

// Substring scan for forbidden needles, reporting a bounded context snippet per
// hit so a finding is inspectable without dumping the whole context.
export function scanForbiddenStrings(hay: string, kind: string, needles: readonly string[]): LeakHit[] {
  const hits: LeakHit[] = [];
  for (const needle of needles) {
    const trimmed = needle.trim();
    if (trimmed.length === 0) continue;
    const idx = hay.indexOf(trimmed);
    if (idx < 0) continue;
    hits.push({
      kind,
      needle: trimmed,
      snippet: hay.slice(Math.max(0, idx - 60), idx + trimmed.length + 60).replace(/\n/g, "\\n"),
    });
  }
  return hits;
}

// Non-trivial ADDED lines of a unified diff: post-fix code that cannot appear in
// base-commit retrieval unless gold-derived content leaked. Short/punctuation
// lines are skipped (they legitimately repeat all over a codebase).
export function goldAddedLines(patch: string, minChars = 16): string[] {
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const body = line.slice(1).trim();
    if (body.length < minChars) continue;
    if (!out.includes(body)) out.push(body);
  }
  return out;
}

// Scoring/benchmark marker strings that must never be model-visible. Note:
// `failing tests:`/`hints:` are the exact labels the pre-M104 task composite
// used; their absence proves the old composite is gone.
export const FORBIDDEN_MARKERS: readonly string[] = [
  "FAIL_TO_PASS",
  "PASS_TO_PASS",
  "failing tests:",
  "hints:",
  "gold_patch",
  "gold patch",
  "issue_authored_gold_path",
];

export interface LeakScan {
  readonly hits: LeakHit[];
  readonly goldAddedLineMatches: string[];
  readonly clean: boolean;
}

export function scanLeakage(
  hay: string,
  labels: { failToPass: readonly string[]; passToPass: readonly string[]; goldPatch: string },
): LeakScan {
  const hits = [
    ...scanForbiddenStrings(hay, "fail_to_pass_id", labels.failToPass),
    ...scanForbiddenStrings(hay, "pass_to_pass_id", labels.passToPass),
    ...scanForbiddenStrings(hay, "marker", FORBIDDEN_MARKERS),
    ...(labels.goldPatch.trim().length > 0 && hay.includes(labels.goldPatch.trim())
      ? [{ kind: "gold_patch_literal", needle: "(entire gold patch)", snippet: "" }]
      : []),
  ];
  const goldAddedLineMatches = goldAddedLines(labels.goldPatch).filter((line) => hay.includes(line));
  return { hits, goldAddedLineMatches, clean: hits.length === 0 && goldAddedLineMatches.length === 0 };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// A leak hit annotated with base-commit provenance: a needle that already exists
// verbatim in the base-commit workspace snapshot is legitimate REPO content the
// capsule retrieved (e.g. a FAIL_TO_PASS test that exists — and fails — at the
// base commit and shows up as an impact caller; a gold added-line that copies a
// pre-existing sibling pattern). Only a hit ABSENT from the base commit can have
// come from benchmark metadata, i.e. is a genuine injection leak.
export interface AnnotatedLeakHit extends LeakHit {
  readonly in_base_commit_repo: boolean;
}

// Verbatim single-line search over the workspace snapshot (tracked-file git grep
// is unusable here: the clean workspaces are `git init` snapshots with no
// commits). Excludes the .git/.vtrace bookkeeping dirs.
export function presentInWorkspace(workspace: string, needle: string): boolean {
  const proc = spawnSync(
    "grep",
    ["-rlF", "--exclude-dir=.git", "--exclude-dir=.vtrace", "--", needle, workspace],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return proc.status === 0;
}

// Is this needle derivable from base-commit repo content alone? Verbatim
// presence counts; so does a `path::symbol` composite (vtrace's own caller /
// item rendering, which coincides with the pytest node-id format) whose FILE
// exists in the snapshot and whose final SYMBOL segment appears in that file —
// the renderer composed it from indexed base-commit code, not from metadata.
export function derivableFromWorkspace(workspace: string, needle: string): boolean {
  if (presentInWorkspace(workspace, needle)) return true;
  const sep = needle.indexOf("::");
  if (sep <= 0) return false;
  const file = needle.slice(0, sep);
  const symbol = needle.slice(needle.lastIndexOf("::") + 2).trim();
  if (symbol.length === 0 || file.includes("..")) return false;
  const filePath = path.join(workspace, file);
  if (!existsSync(filePath)) return false;
  try {
    return readFileSync(filePath, "utf8").includes(symbol);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-case smoke
// ---------------------------------------------------------------------------

function resolveCleanWorkspace(instanceId: string): string | null {
  for (const root of CLEAN_WS_ROOTS) {
    const ws = path.join(WS_ROOT, root, instanceId);
    if (existsSync(path.join(ws, INDEX_RELPATH))) return ws;
  }
  return null;
}

interface M103DetailRow {
  readonly instance_id: string;
  readonly outcome: string | null;
  readonly derivation: {
    readonly task_text: string;
    readonly task_chars: number;
    readonly exception_count: number;
    readonly failing_test_count: number;
    readonly traceback_frame_count: number;
  } | null;
  readonly leakage: { readonly verdict: string; readonly issue_authored_paths: string[] } | null;
  readonly capsule: { readonly lead_pivot_file: string | null; readonly capsule_files: string[] } | null;
}

interface CaseResult {
  readonly instance_id: string;
  readonly repo: string;
  // Task parity
  readonly problem_statement_hash: string;
  readonly structured_task_hash: string;
  readonly structured_task_chars: number;
  readonly structured_task_est_tokens: number;
  readonly exception_count: number;
  readonly failing_test_count: number;
  readonly traceback_frame_count: number;
  readonly uses_shared_derivation: boolean;
  readonly task_text_exact_match: boolean;
  readonly structured_task_hash_exact_match: boolean;
  readonly m103_task_text_exact_match: boolean | null;
  readonly task_is_full_problem_statement: boolean;
  readonly task_diagnostics_match_m103: boolean | null;
  // Provenance / leakage
  readonly leakage_verdict: string;
  readonly issue_authored_gold_path_count: number;
  readonly gold_patch_leak_block_count: number;
  readonly task_leak: { hits: LeakHit[]; gold_added_line_matches: string[] };
  readonly context_leak: {
    hits: AnnotatedLeakHit[];
    gold_added_line_matches: { line: string; in_base_commit_repo: boolean }[];
    unexplained_count: number;
    base_commit_content_count: number;
  } | null;
  readonly model_visible_fail_to_pass_present: boolean | null;
  readonly model_visible_pass_to_pass_present: boolean | null;
  readonly model_visible_gold_patch_present: boolean | null;
  readonly model_visible_full_problem_present: boolean | null;
  // Live context build
  readonly workspace_found: boolean;
  readonly capsule_exit_code: number | null;
  readonly capsule_policy_action: string | null;
  readonly gate_action: string | null;
  readonly gate_reason: string | null;
  readonly context_chars: number | null;
  readonly lead_pivot_file: string | null;
  readonly m103_lead_pivot_file: string | null;
  readonly lead_pivot_matches_m103: boolean | null;
  readonly capsule_files: string[] | null;
  readonly m103_outcome: string | null;
  readonly error: string | null;
  readonly task_text: string;
}

function runCase(
  record: Record<string, unknown>,
  m103Row: M103DetailRow | null,
  repoRoot: string,
): CaseResult {
  const instance: SweBenchInstance = toSweBenchInstance(record);
  const problemStatement = instance.problemStatement;
  const gold = extractGold(typeof record.patch === "string" ? record.patch : "");
  const passToPass = normalizeList(record.PASS_TO_PASS ?? record.pass_to_pass);
  const goldPatch = typeof record.patch === "string" ? record.patch : "";

  // --- Task parity: live builder vs shared derivation vs frozen M103 row -----
  const liveTask = buildCapsuleV2Task(instance);
  const derived = deriveStructuredTaskFromProblemStatement(problemStatement);
  const taskMatch = liveTask === derived.taskText;
  const m103Task = m103Row?.derivation?.task_text ?? null;
  const diag = derived.diagnostics;
  const diagMatch = m103Row?.derivation
    ? diag.taskChars === m103Row.derivation.task_chars &&
      diag.exceptionCount === m103Row.derivation.exception_count &&
      diag.failingTestCount === m103Row.derivation.failing_test_count &&
      diag.tracebackFrameCount === m103Row.derivation.traceback_frame_count
    : null;

  // --- Provenance policy over the LIVE task ---------------------------------
  const assessed = assessGoldLeakage(liveTask, problemStatement, gold);

  // --- Leakage scan of the task itself ---------------------------------------
  const labels = { failToPass: instance.failToPass, passToPass, goldPatch };
  const taskLeak = scanLeakage(liveTask, labels);

  const base = {
    instance_id: instance.instanceId,
    repo: instance.repo,
    problem_statement_hash: sha256(problemStatement),
    structured_task_hash: sha256(liveTask),
    structured_task_chars: liveTask.length,
    structured_task_est_tokens: Math.ceil(liveTask.length / 4),
    exception_count: diag.exceptionCount,
    failing_test_count: diag.failingTestCount,
    traceback_frame_count: diag.tracebackFrameCount,
    uses_shared_derivation: taskMatch,
    task_text_exact_match: taskMatch,
    structured_task_hash_exact_match: sha256(liveTask) === sha256(derived.taskText),
    m103_task_text_exact_match: m103Task === null ? null : liveTask === m103Task,
    task_is_full_problem_statement: liveTask.trim() === problemStatement.trim(),
    task_diagnostics_match_m103: diagMatch,
    leakage_verdict: assessed.verdict,
    issue_authored_gold_path_count: assessed.issueAuthoredPaths.length,
    gold_patch_leak_block_count: assessed.verdict === "gold_patch_leak" ? 1 : 0,
    task_leak: { hits: taskLeak.hits, gold_added_line_matches: taskLeak.goldAddedLineMatches },
    m103_lead_pivot_file: m103Row?.capsule?.lead_pivot_file ?? null,
    m103_outcome: m103Row?.outcome ?? null,
    task_text: liveTask,
  };

  // --- Live model-visible context (exact live-runner pipeline, no agent) -----
  const workspace = resolveCleanWorkspace(instance.instanceId);
  if (workspace === null) {
    return {
      ...base,
      context_leak: null,
      model_visible_fail_to_pass_present: null,
      model_visible_pass_to_pass_present: null,
      model_visible_gold_patch_present: null,
      model_visible_full_problem_present: null,
      workspace_found: false,
      capsule_exit_code: null,
      capsule_policy_action: null,
      gate_action: null,
      gate_reason: null,
      context_chars: null,
      lead_pivot_file: null,
      lead_pivot_matches_m103: null,
      capsule_files: null,
      error: "no clean indexed workspace",
    };
  }

  // Canonical live protocol config: defaults + --disable-pivot-check (the flag
  // the CLAUDE.md run-protocol command always passes). Digest injection stays
  // default-off exactly as on a live run.
  const config = parseArgs(["--disable-pivot-check"]);
  const spec = buildVtraceQueryCommand(config, workspace, liveTask, undefined);
  const proc = spawnSync(spec.command, spec.args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    return {
      ...base,
      context_leak: null,
      model_visible_fail_to_pass_present: null,
      model_visible_pass_to_pass_present: null,
      model_visible_gold_patch_present: null,
      model_visible_full_problem_present: null,
      workspace_found: true,
      capsule_exit_code: proc.status,
      capsule_policy_action: null,
      gate_action: null,
      gate_reason: null,
      context_chars: null,
      lead_pivot_file: null,
      lead_pivot_matches_m103: null,
      capsule_files: null,
      error: `vtrace capsule failed: ${(proc.stderr ?? "").trim().slice(0, 400)}`,
    };
  }

  // Mirror the live runner's classification options for a default protocol run
  // (injectDigest = config.injectCapsuleDigest = false; contract flags off).
  const classification = classifyCapsuleOutput(proc.stdout, {
    injectDigest: false,
    query: liveTask,
    digestDecisionContract: false,
    compactDigestInjection: false,
    boundedDigestDecisions: false,
    pivotConfidenceGate: false,
  });

  // Mirror the live runner's cost-aware v2 gate (auto override).
  const signals = deriveContextPolicySignals(instance);
  const hasContext = classification.context.trim().length > 0;
  const autoDecision = decideCapsuleV2ContextPolicy(signals, {
    capsuleAction: classification.policyAction,
    hasContext,
    actualMode: classification.actualCapsuleMode,
    pivotCount: classification.pivotCount,
    supportCount: classification.supportCount,
    topPivotHasSource: classification.capsuleTopPivotHasSource,
    topPivotSourceChars: classification.capsuleTopPivotSourceChars,
    editRiskDirectiveCount: classification.capsuleEditRiskDirectivesCount,
    lineAnchorResolutionUsed: classification.capsuleLineAnchorResolutionUsed,
    sqlRenderingBackfillUsed: classification.capsuleSqlRenderingBackfillUsed,
    actionabilityHintCount: classification.capsuleV2Result?.actionability_hints?.length ?? 0,
    topPivotPath: classification.capsuleV2Result?.pivots[0]?.path ?? null,
    localization: classification.capsuleV2Result?.diagnostics.localization_signals,
  });
  const decision = applyContextPolicyOverride(autoDecision, "auto", hasContext);

  // Assemble the UNGATED injected view for leakage scanning (what the model
  // would see whenever context IS injected — incl. --context-policy
  // force-inject), with the exact live limits/policies.
  const section: VtraceContextSection = {
    instance,
    rawContext: classification.context,
    error: null,
    classification,
    preformatted: true,
    requestedEngine: "v2",
    effectiveEngine: "v2",
    engineFallbackReason: null,
  };
  const assembled = buildVtraceContextMarkdown([section], {
    maxChars: config.vtraceContextMaxChars,
    maxItems: config.vtraceContextMaxItems,
    pivotCheckPolicy: config.disablePivotCheck ? "off" : config.pivotCheckPolicy,
    disablePivotCheck: config.disablePivotCheck,
    disableEditGuard: config.disableEditGuard,
    disablePatchVerify: config.disablePatchVerify,
    pivotInspectionEnforcement: config.pivotInspectionEnforcement,
    injectTokenDiscipline: !config.disableTokenDiscipline,
  });

  const contextLeak = scanLeakage(assembled.markdown, labels);
  const fullProblemVisible =
    problemStatement.trim().length > 200 && assembled.markdown.includes(problemStatement.trim());

  // Provenance-annotate every hit: content already present in the base-commit
  // snapshot is retrieved REPO evidence (allowed, diagnosed); anything else is
  // an unexplained injection leak (must be zero).
  const annotatedHits: AnnotatedLeakHit[] = contextLeak.hits.map((h) => ({
    ...h,
    in_base_commit_repo: derivableFromWorkspace(workspace, h.needle),
  }));
  const annotatedGoldLines = contextLeak.goldAddedLineMatches.map((line) => ({
    line,
    in_base_commit_repo: presentInWorkspace(workspace, line),
  }));
  const unexplainedHits = annotatedHits.filter((h) => !h.in_base_commit_repo);
  const unexplainedGoldLines = annotatedGoldLines.filter((g) => !g.in_base_commit_repo);
  const unexplainedCount = unexplainedHits.length + unexplainedGoldLines.length;
  const baseCommitCount = annotatedHits.length + annotatedGoldLines.length - unexplainedCount;

  const leadPivot = classification.capsulePivots?.[0]?.path;
  const capsuleFiles = [
    ...new Set(
      (classification.capsulePivots ?? [])
        .concat(classification.capsuleSupport ?? [])
        .map((i) => normalizeFilePath(i.path)),
    ),
  ];

  return {
    ...base,
    context_leak: {
      hits: annotatedHits,
      gold_added_line_matches: annotatedGoldLines,
      unexplained_count: unexplainedCount,
      base_commit_content_count: baseCommitCount,
    },
    model_visible_fail_to_pass_present: unexplainedHits.some((h) => h.kind === "fail_to_pass_id" || h.needle === "FAIL_TO_PASS"),
    model_visible_pass_to_pass_present: unexplainedHits.some((h) => h.kind === "pass_to_pass_id" || h.needle === "PASS_TO_PASS"),
    model_visible_gold_patch_present: unexplainedHits.some((h) => h.kind === "gold_patch_literal") || unexplainedGoldLines.length > 0,
    model_visible_full_problem_present: fullProblemVisible,
    workspace_found: true,
    capsule_exit_code: proc.status,
    capsule_policy_action: classification.policyAction,
    gate_action: decision.action,
    gate_reason: decision.reason,
    context_chars: assembled.markdown.length,
    lead_pivot_file: leadPivot === undefined ? null : normalizeFilePath(leadPivot),
    lead_pivot_matches_m103:
      base.m103_lead_pivot_file === null || leadPivot === undefined
        ? null
        : normalizeFilePath(leadPivot) === base.m103_lead_pivot_file,
    capsule_files: capsuleFiles,
    error: null,
  };
}

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
    } catch {
      return [];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string, fallback: string): string => {
    const idx = argv.indexOf(name);
    return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1]! : fallback;
  };
  const dataPath = flag("--data", DEFAULT_DATA);
  const outDir = flag("--out", RESULTS_ROOT);
  const repoRoot = process.cwd();

  const records = await loadSweBenchData(dataPath);
  const m103Rows = new Map<string, M103DetailRow>(
    (JSON.parse(readFileSync(M103_DETAIL, "utf8")) as { rows: M103DetailRow[] }).rows.map((r) => [r.instance_id, r]),
  );

  const results: CaseResult[] = [];
  for (const id of SMOKE_CASE_IDS) {
    const record = records.find((r) => r.instance_id === id || r.instanceId === id);
    if (record === undefined) {
      process.stderr.write(`[m104] SKIP ${id}: not in dataset\n`);
      continue;
    }
    process.stderr.write(`[m104] ${id} …\n`);
    results.push(runCase(record, m103Rows.get(id) ?? null, repoRoot));
  }

  const contextCases = results.filter((r) => r.context_leak !== null);
  const summary = {
    milestone: "M104",
    kind: "live-path structured task parity + leakage no-agent smoke",
    date: new Date().toISOString().slice(0, 10),
    no_agents: true,
    no_docker: true,
    no_api_spend: true,
    dataset: dataPath,
    cases: results.length,
    context_built: contextCases.length,
    task_text_exact_match_all: results.every((r) => r.task_text_exact_match),
    m103_task_text_exact_match_all: results.every((r) => r.m103_task_text_exact_match !== false),
    task_diagnostics_match_m103_all: results.every((r) => r.task_diagnostics_match_m103 !== false),
    task_is_full_problem_statement_any: results.some((r) => r.task_is_full_problem_statement),
    task_leak_hits_total: results.reduce((n, r) => n + r.task_leak.hits.length + r.task_leak.gold_added_line_matches.length, 0),
    context_leak_hits_total: contextCases.reduce(
      (n, r) => n + (r.context_leak?.hits.length ?? 0) + (r.context_leak?.gold_added_line_matches.length ?? 0),
      0,
    ),
    // Hits proven to be base-commit repo content (retrieved evidence, allowed).
    context_leak_base_commit_content_total: contextCases.reduce(
      (n, r) => n + (r.context_leak?.base_commit_content_count ?? 0),
      0,
    ),
    // Hits NOT present in the base-commit snapshot — genuine injection leaks.
    context_leak_unexplained_total: contextCases.reduce(
      (n, r) => n + (r.context_leak?.unexplained_count ?? 0),
      0,
    ),
    model_visible_fail_to_pass_any: contextCases.some((r) => r.model_visible_fail_to_pass_present === true),
    model_visible_pass_to_pass_any: contextCases.some((r) => r.model_visible_pass_to_pass_present === true),
    model_visible_gold_patch_any: contextCases.some((r) => r.model_visible_gold_patch_present === true),
    model_visible_full_problem_any: contextCases.some((r) => r.model_visible_full_problem_present === true),
    issue_authored_gold_path_count: results.filter((r) => r.leakage_verdict === "issue_authored_gold_path").length,
    gold_patch_leak_block_count: results.reduce((n, r) => n + r.gold_patch_leak_block_count, 0),
    lead_pivot_matches_m103: {
      matched: contextCases.filter((r) => r.lead_pivot_matches_m103 === true).map((r) => r.instance_id),
      diverged: contextCases.filter((r) => r.lead_pivot_matches_m103 === false).map((r) => r.instance_id),
    },
    errors: results.filter((r) => r.error !== null).map((r) => ({ id: r.instance_id, error: r.error })),
  };

  await mkdir(outDir, { recursive: true });
  const detailPath = path.join(outDir, "stage5_m104_live_context_smoke.detail.json");
  const summaryPath = path.join(outDir, "stage5_m104_live_path_parity.json");
  const csvPath = path.join(outDir, "stage5_m104_live_context_smoke.csv");
  await writeFile(detailPath, `${JSON.stringify({ summary, cases: results }, null, 2)}\n`);
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  const csvHeader = [
    "instance_id", "task_text_exact_match", "m103_task_text_exact_match", "leakage_verdict",
    "task_leak_hits", "context_leak_unexplained", "model_visible_fail_to_pass", "gate_action",
    "lead_pivot_file", "m103_lead_pivot_file", "lead_pivot_matches_m103", "structured_task_chars",
  ].join(",");
  const csvRows = results.map((r) => [
    r.instance_id, r.task_text_exact_match, r.m103_task_text_exact_match, r.leakage_verdict,
    r.task_leak.hits.length + r.task_leak.gold_added_line_matches.length,
    r.context_leak === null ? "" : r.context_leak.unexplained_count,
    r.model_visible_fail_to_pass_present ?? "", r.gate_action ?? "",
    r.lead_pivot_file ?? "", r.m103_lead_pivot_file ?? "", r.lead_pivot_matches_m103 ?? "", r.structured_task_chars,
  ].join(","));
  await writeFile(csvPath, `${[csvHeader, ...csvRows].join("\n")}\n`);

  process.stderr.write(`[m104] wrote ${detailPath}\n[m104] wrote ${summaryPath}\n[m104] wrote ${csvPath}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (import.meta.main) {
  await main();
}
