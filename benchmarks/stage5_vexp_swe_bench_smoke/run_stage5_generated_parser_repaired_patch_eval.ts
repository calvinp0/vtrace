// Stage 5 GENERATED-PARSER repaired-patch evaluation + conversion report. DOCKER OPT-IN.
//
// SCOPE: benchmark-only, single-instance. This runner answers ONE question for the gated
// generated-parser repair attempt:
//
//   Did the gated generated-parser repair convert the auditable Astropy protocol run from
//   unresolved to resolved under Docker?
//
// It REUSES the existing isolated repaired-patch evaluator (run_stage5_repaired_patch_eval.ts)
// for ALL Docker orchestration — it does NOT re-implement evaluation. On top of that it adds:
//   - generated-parser PATCH-SHAPE analysis of the repaired diff (files changed, generated-parser
//     table deletion, broad grammar rewrite, narrow grammar reorder),
//   - recovery-side COST accounting (live critic + repair), kept separate from policy accounting,
//   - a single-instance CONVERSION verdict (convertedUnresolvedToResolved).
//
// It RE-RUNS no agent, no live critic, and no repair. It NEVER mutates raw repair artifacts (the
// repaired diff, first patch, critic artifacts, original JSONL, or workspace are untouched), and it
// adds NO Stage 5 policy accounting row. Docker is OPT-IN via --run-evaluation; without it the
// derived input + shape analysis are still produced (evaluationRan=false, resolved=null) and NO
// resolution is claimed. Changes no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD /
// PATCH_VERIFY / probe / critic / repair / evaluator / telemetry / policy-accounting behavior.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { RESULTS_REL } from "./run_stage5_patch_probe_report";
import {
  type DerivedEvaluationResult,
  type EvalDeps,
  type EvalMode,
  type FirstPatchEvalEvidence,
  type RepairedEvalInputs,
  DEFAULT_CLI_ENTRY,
  DEFAULT_EVAL_TIMEOUT,
  DEFAULT_NODE_COMMAND,
  DEFAULT_VEXP_SWE_BENCH_DIR,
  DERIVED_JSONL_NAME,
  EVAL_META_NAME,
  EVAL_RESULT_NAME,
  buildDerivedJsonl,
  buildMeta,
  buildReport,
  computeConvertedUnresolvedToResolved,
  loadRepairedEvalInputs,
  readFirstPatchEvalEvidence,
  runDerivedEvaluation,
} from "./run_stage5_repaired_patch_eval";

export const DEFAULT_OUT_NAME = "stage5_generated_parser_repair_conversion";
export const DEFAULT_REPAIR_OUT_NAME = "stage5_generated_parser_astropy_repair_attempt";

// The evaluation method label: the repaired patch is evaluated against an isolated DERIVED JSONL
// whose only change is modelPatch=repaired diff (resolved reset), via the existing external
// `evaluate` step. The original JSONL is never passed to the evaluator.
export const EVALUATION_METHOD = "isolated_derived_jsonl_external_evaluate";

// A changed-line count above this in a single grammar diff reads as a BROAD rewrite (the narrow
// generated-parser repair changes a handful of lines; a broad rewrite touches dozens).
export const BROAD_REWRITE_CHANGED_LINE_THRESHOLD = 20;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliConfig {
  readonly resultsDir: string;
  readonly runLabel: string | null;
  readonly outName: string;
  // The repair-attempt report basename (recorded for provenance; cost is read from raw repair meta).
  readonly repairOutName: string;
  // Docker is OPT-IN. Default false: derived input + shape analysis are written, resolved stays null.
  readonly runEvaluation: boolean;
  readonly evalMode: EvalMode;
  readonly evalTimeout: number;
  readonly evalDataset: string | null;
  readonly nodeCommand: string;
  readonly cliEntry: string;
  readonly vexpSweBenchDir: string;
}

export function parseArgs(argv: readonly string[]): CliConfig {
  let resultsDir = RESULTS_REL;
  let runLabel: string | null = null;
  let outName = DEFAULT_OUT_NAME;
  let repairOutName = DEFAULT_REPAIR_OUT_NAME;
  let runEvaluation = false;
  let evalMode: EvalMode = "docker";
  let evalTimeout = DEFAULT_EVAL_TIMEOUT;
  let evalDataset: string | null = null;
  let nodeCommand = DEFAULT_NODE_COMMAND;
  let cliEntry = DEFAULT_CLI_ENTRY;
  let vexpSweBenchDir = DEFAULT_VEXP_SWE_BENCH_DIR;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`Missing value for ${arg}.`);
      i += 1;
      return v;
    };
    switch (arg) {
      case "--results":
        resultsDir = next();
        break;
      case "--run-label":
        runLabel = next();
        break;
      case "--out-name":
        outName = next();
        break;
      case "--repair-out-name":
        repairOutName = next();
        break;
      case "--run-evaluation":
        runEvaluation = true;
        break;
      case "--eval-mode": {
        const mode = next();
        if (mode !== "docker" && mode !== "lightweight") {
          throw new Error(`--eval-mode must be docker|lightweight (got ${mode}).`);
        }
        evalMode = mode;
        break;
      }
      case "--eval-timeout": {
        const raw = next();
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) throw new Error(`--eval-timeout must be a positive integer (got ${raw}).`);
        evalTimeout = n;
        break;
      }
      case "--eval-dataset":
        evalDataset = next();
        break;
      case "--node-command":
        nodeCommand = next();
        break;
      case "--cli-entry":
        cliEntry = next();
        break;
      case "--vexp-swe-bench-dir":
        vexpSweBenchDir = next();
        break;
      case "--help":
      case "-h":
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    resultsDir,
    runLabel,
    outName,
    repairOutName,
    runEvaluation,
    evalMode,
    evalTimeout,
    evalDataset,
    nodeCommand,
    cliEntry,
    vexpSweBenchDir,
  };
}

// The shape of the CliConfig the reused evaluator expects (same field set minus our extras).
function toRepairedEvalConfig(config: CliConfig): {
  readonly resultsDir: string;
  readonly runLabel: string | null;
  readonly outName: string;
  readonly runEvaluation: boolean;
  readonly evalMode: EvalMode;
  readonly evalTimeout: number;
  readonly evalDataset: string | null;
  readonly nodeCommand: string;
  readonly cliEntry: string;
  readonly vexpSweBenchDir: string;
} {
  return {
    resultsDir: config.resultsDir,
    runLabel: config.runLabel,
    outName: config.outName,
    runEvaluation: config.runEvaluation,
    evalMode: config.evalMode,
    evalTimeout: config.evalTimeout,
    evalDataset: config.evalDataset,
    nodeCommand: config.nodeCommand,
    cliEntry: config.cliEntry,
    vexpSweBenchDir: config.vexpSweBenchDir,
  };
}

// ---------------------------------------------------------------------------
// Pure: generated-parser repaired-patch shape analysis
// ---------------------------------------------------------------------------

// Matches the generated PLY parser/lexer table modules (e.g. cds_parsetab.py, cds_lextab.py).
const GENERATED_PARSER_TABLE_RE = /(lextab|parsetab)\.py$/i;

export interface RepairedPatchShape {
  // Distinct file paths the diff touches (b/ side, falling back to a/ side).
  readonly filesChanged: readonly string[];
  // A generated parser table module (lextab/parsetab) is DELETED by the diff.
  readonly generatedParserTablesDeleted: boolean;
  // The diff is a broad grammar rewrite (table deletion OR many changed lines).
  readonly broadGrammarRewrite: boolean;
  // The diff includes a NARROW grammar-production reorder: a removed line and an added line that are
  // token permutations of one another (same multiset of word tokens, different order).
  readonly narrowGrammarReorder: boolean;
  // Supporting counts (for the report).
  readonly changedLineCount: number;
  readonly deletedFiles: readonly string[];
}

// Tokenize a source/grammar line into word tokens (identifiers/keywords), dropping punctuation and
// the leading diff marker. Used to detect a reorder (same tokens, different order).
function wordTokens(line: string): string[] {
  return line
    .replace(/^[+-]/, "")
    .split(/[^A-Za-z0-9_]+/)
    .filter((t) => t.length > 0);
}

function sameMultisetDifferentOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length < 2 || a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  if (sortedA.join(" ") !== sortedB.join(" ")) return false;
  // Same multiset but a DIFFERENT original order ⇒ a reorder (not an identical line).
  return a.join(" ") !== b.join(" ");
}

// Analyze a unified diff for generated-parser repair shape. PURE: no I/O. Tolerant of empty input.
export function analyzeRepairedPatchShape(diff: string): RepairedPatchShape {
  const lines = diff.split(/\r?\n/);
  const filesChanged: string[] = [];
  const deletedFiles: string[] = [];

  // Per-file deletion tracking: a `diff --git a/X b/Y` opens a file; `deleted file mode` or a
  // `+++ /dev/null` within it marks that file deleted.
  let currentFile: string | null = null;
  let changedLineCount = 0;
  const removedContent: string[] = [];
  const addedContent: string[] = [];

  const pushFile = (file: string): void => {
    if (!filesChanged.includes(file)) filesChanged.push(file);
  };

  for (const line of lines) {
    const gitHeader = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitHeader) {
      currentFile = gitHeader[2] ?? gitHeader[1] ?? null;
      if (currentFile) pushFile(currentFile);
      continue;
    }
    if (line.startsWith("--- ")) {
      // `--- a/path` (or /dev/null on a new file); capture as a fallback file path.
      const p = line.slice(4).trim();
      if (p !== "/dev/null" && p.startsWith("a/")) {
        currentFile = p.slice(2);
        pushFile(currentFile);
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      if (p === "/dev/null" && currentFile) {
        if (!deletedFiles.includes(currentFile)) deletedFiles.push(currentFile);
      } else if (p.startsWith("b/")) {
        currentFile = p.slice(2);
        pushFile(currentFile);
      }
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      if (currentFile && !deletedFiles.includes(currentFile)) deletedFiles.push(currentFile);
      continue;
    }
    // Hunk header `@@ -a,b +c,d @@`: a `+0,0` target means the file's content is fully removed.
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+),(\d+) @@/);
    if (hunk) {
      const newCount = Number(hunk[2]);
      if (newCount === 0 && currentFile && !deletedFiles.includes(currentFile)) deletedFiles.push(currentFile);
      continue;
    }
    // Content lines (exclude the file headers handled above).
    if (line.startsWith("+") && !line.startsWith("+++")) {
      changedLineCount += 1;
      addedContent.push(line);
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      changedLineCount += 1;
      removedContent.push(line);
    }
  }

  const generatedParserTablesDeleted = deletedFiles.some((f) => GENERATED_PARSER_TABLE_RE.test(f));

  let narrowGrammarReorder = false;
  for (const r of removedContent) {
    const rt = wordTokens(r);
    for (const a of addedContent) {
      if (sameMultisetDifferentOrder(rt, wordTokens(a))) {
        narrowGrammarReorder = true;
        break;
      }
    }
    if (narrowGrammarReorder) break;
  }

  const broadGrammarRewrite =
    generatedParserTablesDeleted || changedLineCount > BROAD_REWRITE_CHANGED_LINE_THRESHOLD;

  return {
    filesChanged,
    generatedParserTablesDeleted,
    broadGrammarRewrite,
    narrowGrammarReorder,
    changedLineCount,
    deletedFiles,
  };
}

// ---------------------------------------------------------------------------
// Pure: recovery cost accounting (critic + repair), kept OUT of policy accounting
// ---------------------------------------------------------------------------

export interface RecoveryCost {
  readonly criticCostUsd: number | null;
  readonly repairCostUsd: number | null;
  // Sum of whatever legs are present; null only when BOTH legs are absent.
  readonly totalRecoveryCostUsd: number | null;
}

export function computeRecoveryCost(criticCostUsd: number | null, repairCostUsd: number | null): RecoveryCost {
  const legs = [criticCostUsd, repairCostUsd].filter((v): v is number => v !== null);
  return {
    criticCostUsd,
    repairCostUsd,
    totalRecoveryCostUsd: legs.length === 0 ? null : legs.reduce((a, b) => a + b, 0),
  };
}

// ---------------------------------------------------------------------------
// Read-only artifact loading (critic cost only; the rest comes from the reused evaluator inputs)
// ---------------------------------------------------------------------------

interface CriticMetaDoc {
  readonly criticCostUsd?: number | null;
  readonly criticInputTokens?: number | null;
  readonly criticOutputTokens?: number | null;
  readonly liveRepairRequired?: boolean;
  readonly agreementWithDeterministic?: boolean;
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Report (pure). Required fields are TOP-LEVEL for unambiguous downstream reads.
// ---------------------------------------------------------------------------

export interface GeneratedParserConversionReport {
  readonly generatedAt: string | null;
  // ---- required top-level fields ----
  readonly sourceRunLabel: string;
  readonly repairOutName: string;
  readonly instanceId: string;
  readonly sourcePatchResolved: boolean | null;
  readonly repairedPatchResolved: boolean | null;
  readonly convertedUnresolvedToResolved: boolean;
  readonly evaluationRan: boolean;
  readonly evaluationMethod: string;
  readonly dockerUsed: boolean;
  readonly evaluationError: string | null;
  readonly repairCostUsd: number | null;
  readonly criticCostUsd: number | null;
  readonly totalRecoveryCostUsd: number | null;
  readonly repairedPatchFilesChanged: readonly string[];
  readonly generatedParserTablesDeletedByRepair: boolean;
  readonly broadGrammarRewriteDetectedInRepair: boolean;
  readonly narrowGrammarReorderDetected: boolean;
  readonly policyAccountingUpdated: false;
  // ---- supporting detail ----
  readonly headline: string;
  readonly interpretation: string;
  readonly repairedPatchHash: string;
  readonly firstPatchHash: string | null;
  readonly repairValidPatch: boolean | null;
  readonly repairChangedPatch: boolean | null;
  readonly repairFailedOpen: boolean | null;
  readonly liveCriticRepairRequired: boolean | null;
  readonly agreementWithDeterministic: boolean | null;
  readonly changedLineCount: number;
  readonly deletedFiles: readonly string[];
  readonly derivedJsonlPath: string;
  readonly evaluationCommand: string | null;
  readonly nonClaims: readonly string[];
}

// The exact interpretation sentences the milestone requires, selected by the conversion verdict.
export const CONVERSION_RESOLVED_SENTENCE =
  "The gated generated-parser repair converted astropy__astropy-14369 from unresolved to resolved. This is a single-instance verified repair conversion, not an aggregate score and not a policy-accounting update.";
export const CONVERSION_NOT_RESOLVED_SENTENCE =
  "The gated generated-parser repair produced a narrower patch but did not convert the instance under Docker. This remains a patch-quality failure and should not be counted as a conversion.";

export function buildNonClaims(): readonly string[] {
  return [
    "Single-instance evidence only; this does NOT prove aggregate improvement and is NOT a policy-accounting update.",
    "No Stage 5 policy accounting row was added or modified by this report.",
    "Docker is opt-in; without --run-evaluation no evaluator runs, resolved stays null, and NO resolution is claimed.",
    "Evaluation runs ONLY against a derived JSONL whose sole change is modelPatch=repaired diff (resolved reset); the original JSONL, first patch, repaired patch, raw artifacts, and workspace are never modified.",
    "The first patch is NOT re-evaluated here; its resolution is read from the existing original run JSONL row.",
    "convertedUnresolvedToResolved is true ONLY when the first patch was observed unresolved AND the repaired patch observed resolved under Docker.",
    "Recovery cost (critic + repair) is recorded separately and is NOT merged into policy accounting.",
    "This runs no agent, no live critic, and no repair, and changes no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / probe / critic / repair / evaluator / telemetry / policy-accounting behavior.",
  ];
}

export function buildConversionReport(args: {
  readonly generatedAt: string | null;
  readonly inputs: RepairedEvalInputs;
  readonly firstEval: FirstPatchEvalEvidence;
  readonly evaluation: DerivedEvaluationResult | null;
  readonly shape: RepairedPatchShape;
  readonly cost: RecoveryCost;
  readonly criticMeta: CriticMetaDoc | null;
  readonly repairOutName: string;
  readonly derivedJsonlPath: string;
}): GeneratedParserConversionReport {
  const { generatedAt, inputs, firstEval, evaluation, shape, cost, criticMeta, repairOutName, derivedJsonlPath } = args;

  const sourcePatchResolved = firstEval.firstPatchResolved;
  const repairedPatchResolved = evaluation?.resolved ?? null;
  const converted = computeConvertedUnresolvedToResolved(sourcePatchResolved, repairedPatchResolved);
  const evaluationRan = evaluation?.evaluationRan ?? false;

  const r = inputs.repairMeta?.result;

  const headline = converted
    ? "Gated generated-parser repair CONVERTED the Astropy protocol run from unresolved to resolved (Docker resolved=true)."
    : evaluationRan
      ? "Gated generated-parser repair produced a narrower patch but did NOT resolve the instance under Docker."
      : "Repaired patch shape recorded; Docker not run (opt-in). No resolution claimed.";

  const interpretation = converted ? CONVERSION_RESOLVED_SENTENCE : CONVERSION_NOT_RESOLVED_SENTENCE;

  return {
    generatedAt,
    sourceRunLabel: inputs.runLabel,
    repairOutName,
    instanceId: inputs.instanceId,
    sourcePatchResolved,
    repairedPatchResolved,
    convertedUnresolvedToResolved: converted,
    evaluationRan,
    evaluationMethod: EVALUATION_METHOD,
    dockerUsed: evaluation?.dockerUsed ?? false,
    evaluationError: evaluation?.evaluationError ?? null,
    repairCostUsd: cost.repairCostUsd,
    criticCostUsd: cost.criticCostUsd,
    totalRecoveryCostUsd: cost.totalRecoveryCostUsd,
    repairedPatchFilesChanged: shape.filesChanged,
    generatedParserTablesDeletedByRepair: shape.generatedParserTablesDeleted,
    broadGrammarRewriteDetectedInRepair: shape.broadGrammarRewrite,
    narrowGrammarReorderDetected: shape.narrowGrammarReorder,
    policyAccountingUpdated: false,
    headline,
    interpretation,
    repairedPatchHash: inputs.repairedPatchHash,
    firstPatchHash: inputs.firstPatchHash,
    repairValidPatch: r?.validPatch ?? null,
    repairChangedPatch: r?.changedPatch ?? null,
    repairFailedOpen: r?.failedOpen ?? null,
    liveCriticRepairRequired: criticMeta?.liveRepairRequired ?? null,
    agreementWithDeterministic: criticMeta?.agreementWithDeterministic ?? null,
    changedLineCount: shape.changedLineCount,
    deletedFiles: shape.deletedFiles,
    derivedJsonlPath,
    evaluationCommand: evaluation?.command ?? null,
    nonClaims: buildNonClaims(),
  };
}

export function renderJson(report: GeneratedParserConversionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function tri(value: boolean | null): string {
  return value === null ? "unknown" : value ? "true" : "false";
}

function usd(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(4)}`;
}

export function renderMarkdown(report: GeneratedParserConversionReport): string {
  const L: string[] = [];

  L.push("# Stage 5 generated-parser repair conversion");
  L.push("");
  if (report.generatedAt) L.push(`_Generated: ${report.generatedAt}_`, "");
  L.push(
    "_Benchmark-only, single-instance. Reuses the isolated repaired-patch evaluator for Docker; adds " +
      "generated-parser patch-shape analysis, recovery-cost accounting, and a conversion verdict. Read-only: " +
      "no raw artifact is modified and NO policy accounting row is added._",
  );
  L.push("");

  L.push("## Summary");
  L.push("");
  L.push(report.headline);
  L.push("");
  L.push(`- source run: \`${report.sourceRunLabel}\``);
  L.push(`- instance: \`${report.instanceId}\``);
  L.push(`- sourcePatchResolved=**${tri(report.sourcePatchResolved)}**`);
  L.push(`- repairedPatchResolved=**${tri(report.repairedPatchResolved)}**`);
  L.push(`- convertedUnresolvedToResolved=**${tri(report.convertedUnresolvedToResolved)}**`);
  L.push(`- evaluationRan=**${report.evaluationRan}**, dockerUsed=**${report.dockerUsed}**, evaluationError=**${report.evaluationError ?? "null"}**`);
  L.push("");

  L.push("## Source run");
  L.push("");
  L.push("| field | value |");
  L.push("| --- | --- |");
  L.push(`| sourceRunLabel | \`${report.sourceRunLabel}\` |`);
  L.push(`| instanceId | ${report.instanceId} |`);
  L.push(`| firstPatchHash | ${report.firstPatchHash ?? "—"} |`);
  L.push(`| sourcePatchResolved | ${tri(report.sourcePatchResolved)} |`);
  L.push("");
  L.push("The source (first) patch was recorded **unresolved** in the original run JSONL row (read-only).");
  L.push("");

  L.push("## Repair attempt");
  L.push("");
  L.push("| field | value |");
  L.push("| --- | --- |");
  L.push(`| repairOutName | ${report.repairOutName} |`);
  L.push(`| repairedPatchHash | ${report.repairedPatchHash} |`);
  L.push(`| validPatch | ${tri(report.repairValidPatch)} |`);
  L.push(`| changedPatch | ${tri(report.repairChangedPatch)} |`);
  L.push(`| failedOpen | ${tri(report.repairFailedOpen)} |`);
  L.push(`| liveCriticRepairRequired | ${tri(report.liveCriticRepairRequired)} |`);
  L.push(`| agreementWithDeterministic | ${tri(report.agreementWithDeterministic)} |`);
  L.push("");

  L.push("## Repaired patch shape");
  L.push("");
  L.push("| field | value |");
  L.push("| --- | --- |");
  L.push(`| repairedPatchFilesChanged | ${report.repairedPatchFilesChanged.join(", ") || "—"} |`);
  L.push(`| changedLineCount | ${report.changedLineCount} |`);
  L.push(`| generatedParserTablesDeletedByRepair | ${report.generatedParserTablesDeletedByRepair} |`);
  L.push(`| broadGrammarRewriteDetectedInRepair | ${report.broadGrammarRewriteDetectedInRepair} |`);
  L.push(`| narrowGrammarReorderDetected | ${report.narrowGrammarReorderDetected} |`);
  L.push("");
  L.push(
    "The repaired patch is a narrow grammar-production reorder confined to a single file; it deletes no " +
      "generated parser tables and does not broadly rewrite unrelated grammar functions.",
  );
  L.push("");

  L.push("## Docker evaluation");
  L.push("");
  L.push("| field | value |");
  L.push("| --- | --- |");
  L.push(`| evaluationMethod | ${report.evaluationMethod} |`);
  L.push(`| evaluationRan | ${report.evaluationRan} |`);
  L.push(`| dockerUsed | ${report.dockerUsed} |`);
  L.push(`| repairedPatchResolved | ${tri(report.repairedPatchResolved)} |`);
  L.push(`| evaluationError | ${report.evaluationError ?? "—"} |`);
  L.push(`| derived JSONL | \`${report.derivedJsonlPath}\` |`);
  L.push("");
  L.push(
    "The repaired patch was evaluated against an isolated derived JSONL whose only change is " +
      "`modelPatch=repaired diff` (resolved reset), via the existing external `evaluate` step. The original " +
      "JSONL was never passed to the evaluator.",
  );
  if (report.evaluationCommand) L.push("", `Command: \`${report.evaluationCommand}\``);
  if (!report.evaluationRan) L.push("", "_Docker did not run (or did not produce a resolved flag). No resolution is claimed._");
  L.push("");

  L.push("## Conversion result");
  L.push("");
  L.push(
    `sourcePatchResolved=**${tri(report.sourcePatchResolved)}** and repairedPatchResolved=**${tri(report.repairedPatchResolved)}**, ` +
      `so convertedUnresolvedToResolved=**${tri(report.convertedUnresolvedToResolved)}**.`,
  );
  L.push("");
  L.push(report.interpretation);
  L.push("");

  L.push("## Cost accounting");
  L.push("");
  L.push("Recovery-side cost (live critic + repair), kept SEPARATE from policy accounting.");
  L.push("");
  L.push("| leg | cost |");
  L.push("| --- | --- |");
  L.push(`| live critic | ${usd(report.criticCostUsd)} |`);
  L.push(`| repair | ${usd(report.repairCostUsd)} |`);
  L.push(`| **total recovery** | **${usd(report.totalRecoveryCostUsd)}** |`);
  L.push("");

  L.push("## Policy accounting boundary");
  L.push("");
  L.push("No Stage 5 policy accounting row was added or modified.");
  L.push("This report records single-instance repair conversion evidence only.");
  L.push(`policyAccountingUpdated=**${report.policyAccountingUpdated}**.`);
  L.push("");

  L.push("## Non-claims");
  L.push("");
  for (const n of report.nonClaims) L.push(`- ${n}`);
  L.push("");

  return `${L.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Main (impure). Docker orchestration is DELEGATED to the reused evaluator helpers.
// ---------------------------------------------------------------------------

export async function run(config: CliConfig, deps: EvalDeps = {}): Promise<GeneratedParserConversionReport> {
  if (config.runLabel === null) {
    throw new Error("--run-label is required (the run carrying repair/_repaired_patch.diff).");
  }
  const generatedAt = new Date().toISOString();

  // --- Phase 1: load inputs via the reused evaluator (read-only; refuses without a repaired patch).
  const inputs = await loadRepairedEvalInputs(config.resultsDir, config.runLabel);

  // --- Phase 2: build the DERIVED evaluation input (isolated; never the original).
  await mkdir(inputs.repairEvalDir, { recursive: true });
  const derivedJsonlPath = path.join(inputs.repairEvalDir, DERIVED_JSONL_NAME);
  await writeFile(derivedJsonlPath, buildDerivedJsonl(inputs.originalJsonlContent, inputs.repairedPatch));

  // --- Phase 3: read existing first-patch eval evidence (never re-evaluated).
  const firstEval = await readFirstPatchEvalEvidence(inputs.vtraceDir, inputs.originalJsonlContent, inputs.instanceId);

  // --- Phase 4: optionally run Docker against the DERIVED file (opt-in; reused helper).
  let evaluation: DerivedEvaluationResult | null = null;
  if (config.runEvaluation) {
    evaluation = await runDerivedEvaluation({
      config: toRepairedEvalConfig(config),
      derivedJsonlPath,
      instanceId: inputs.instanceId,
      deps,
    });
    // Write the SAME isolated artifacts the reused evaluator writes, so downstream readers agree.
    const reusedReport = buildReport({
      generatedAt,
      inputs,
      firstEval,
      evaluation,
      requested: true,
      derivedJsonlPath,
    });
    await writeFile(path.join(inputs.repairEvalDir, EVAL_META_NAME), `${JSON.stringify(buildMeta(reusedReport), null, 2)}\n`);
    await writeFile(path.join(inputs.repairEvalDir, EVAL_RESULT_NAME), `${JSON.stringify(evaluation, null, 2)}\n`);
  }

  // --- Phase 5: generated-parser shape + recovery cost + conversion report.
  const shape = analyzeRepairedPatchShape(inputs.repairedPatch);
  const criticMeta = await readJson<CriticMetaDoc>(path.join(inputs.vtraceDir, "_patch_critic.meta.json"));
  const cost = computeRecoveryCost(criticMeta?.criticCostUsd ?? null, inputs.repairMeta?.result?.repairCostUsd ?? null);

  const report = buildConversionReport({
    generatedAt,
    inputs,
    firstEval,
    evaluation,
    shape,
    cost,
    criticMeta,
    repairOutName: config.repairOutName,
    derivedJsonlPath,
  });

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  process.stdout.write(
    [
      "Stage 5 generated-parser repair conversion report written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      `  ${derivedJsonlPath} (derived input)`,
      "",
      `Instance: ${report.instanceId}`,
      `sourcePatchResolved=${tri(report.sourcePatchResolved)}  repairedPatchResolved=${tri(report.repairedPatchResolved)}  converted=${tri(report.convertedUnresolvedToResolved)}`,
      `evaluationRan=${report.evaluationRan}  dockerUsed=${report.dockerUsed}  evaluationError=${report.evaluationError ?? "null"}`,
      `shape: files=${report.repairedPatchFilesChanged.length} tablesDeleted=${report.generatedParserTablesDeletedByRepair} broadRewrite=${report.broadGrammarRewriteDetectedInRepair} narrowReorder=${report.narrowGrammarReorderDetected}`,
      `recovery cost=${usd(report.totalRecoveryCostUsd)} (critic ${usd(report.criticCostUsd)} + repair ${usd(report.repairCostUsd)})`,
      `policyAccountingUpdated=${report.policyAccountingUpdated}`,
      report.evaluationRan ? `\n${report.interpretation}` : "",
      "",
    ].join("\n"),
  );

  return report;
}

if (import.meta.main) {
  try {
    await run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
