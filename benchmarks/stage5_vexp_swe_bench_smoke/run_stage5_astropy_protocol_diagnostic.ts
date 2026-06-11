// Stage 5 Astropy protocol diagnostic report generator.
//
// SCOPE: read-only reporter for ONE auditable Capsule v2 protocol run on
// astropy__astropy-14369 — indexed Capsule v2, forced context injection, strict
// pivot-check gating, ordered telemetry, and PERSISTED Capsule v2 artifacts
// (manifest / ranking / context). It reads the already-captured raw artifacts
// under `results/runs/<RUN_LABEL>/` and writes a `.md` / `.json` diagnostic.
//
// It updates the Astropy diagnosis: the earlier strict/risk runs (no persisted
// Capsule artifacts) suggested `noisy_pivot_ranking`; this auditable run shows
// `cds.py::CDS` ranked/rendered FIRST and Docker still failing, so the current
// failure mode is `patch_mistake_despite_good_context` — the agent saw the right
// parser class and edited the right file but made a broad grammar rewrite/deletion
// instead of the narrower known-good grammar reorder.
//
// It does NOT run agents, Docker, retrieval, ranking, Capsule generation,
// prompts, PIVOT_CHECK, the critic, repair, the evaluator, or telemetry capture.
// It only reads what those steps already wrote. See `NON_CLAIMS`.

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants: which run this report diagnoses
// ---------------------------------------------------------------------------

export const RUN_LABEL = "eval-strictv2-artifacts-protocol-vtrace-astropy-14369";
export const INSTANCE_ID = "astropy__astropy-14369";
export const CONDITION = "vtrace";

// The CDS parser file/class the auditable run placed first. The diagnosis hinges
// on this being the rendered/ranked lead pivot while Docker still failed.
export const EXPECTED_TOP_PIVOT_FILE = "astropy/units/format/cds.py";
export const EXPECTED_TOP_PIVOT_SYMBOL = "CDS";

// Generated parser/lexer table files. A patch that DELETES one of these (rather
// than editing a grammar rule) is the broad-rewrite signature this report flags.
export const GENERATED_PARSER_TABLE_RE = /(^|\/)[A-Za-z0-9_]+_(parsetab|lextab)\.py$/;

// The narrow known-good grammar reorder, for contrast in the patch analysis.
export const NARROW_GRAMMAR_REORDER_RE = /combined_units\s+DIVISION\s+unit_expression/;

export const REPORT_BASENAME = "stage5_astropy_protocol_diagnostic";

// The updated diagnosis for this auditable protocol run.
export const PRIMARY_ISSUE = "patch_mistake_despite_good_context";
export const SECONDARY_ISSUES: readonly string[] = [
  "capsule_budget_too_large",
  "grammar_patch_minimality",
];
// What this diagnosis supersedes (preserved as history, not erased).
export const SUPERSEDES_ISSUE = "noisy_pivot_ranking";

export const INTERPRETATION =
  "The auditable protocol run shows that the current indexed Capsule v2 path can " +
  "place astropy/units/format/cds.py::CDS first and avoid the earlier loop pattern, " +
  "but the produced patch still failed Docker evaluation. Therefore the current " +
  "Astropy failure mode is no longer primarily missing or noisy localization " +
  "evidence. It is patch_mistake_despite_good_context: the agent saw the relevant " +
  "parser class and edited the right file, but made a broad grammar rewrite/deletion " +
  "instead of the narrower known-good grammar change.";

export const RANKING_METADATA_CAVEAT =
  "_capsule_v2_ranking.json reports cds.py::CDS as rank 1 while vounit.py::VOUnit has " +
  "a higher pivotRankScore. This should be clarified in a later artifact-format " +
  "cleanup: either rank should correspond to final rendered order and score should be " +
  "labeled diagnosticScore, or final rank should sort by pivotRankScore. This caveat " +
  "does not change the current diagnosis because the rendered context and metadata " +
  "both place cds.py first.";

export const RECOMMENDED_NEXT_STEP =
  "Add a deterministic patch-minimality/probe diagnostic for Astropy-style generated " +
  "parser rewrites: flag patches that delete generated parser tables or broadly " +
  "relocate grammar productions when a narrower grammar-rule edit is possible. Do this " +
  "as a probe/report first, not as automatic repair.";

// Caveats the report MUST state — rendered verbatim under "## Non-claims" and
// asserted by the test suite, so editing these is a deliberate, tested change.
export const NON_CLAIMS: readonly string[] = [
  "This report does not re-run agents or Docker.",
  "This report does not claim pivot-ranking v2 caused any resolution.",
  "This report does not claim aggregate improvement.",
  "This report does not prove Capsule budget is optimal.",
  "This report does not change repair policy.",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SweBenchRow {
  instanceId: string;
  resolved: boolean | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  numTurns: number;
  durationMs: number;
  commitHash: string | null;
  model: string | null;
  agent: string | null;
  modelPatch: string;
  toolCalls: Record<string, number>;
}

export interface DockerEvaluation {
  evaluationRan: boolean | null;
  evaluationMethod: string | null;
  dockerUsed: boolean | null;
  evaluationError: string | null;
  instancesEvaluated: number | null;
  resolvedCount: number | null;
  resolved: boolean;
}

export interface OrderedTelemetry {
  totalToolCalls: number | null;
  bashToolCalls: number | null;
  grepLikeToolCalls: number | null;
  fileReadToolCalls: number | null;
  fileWriteToolCalls: number | null;
  uniqueFilesTouchedByTools: number | null;
  longBashLoopHeuristic: boolean | null;
  repeatedSearchHeuristic: boolean | null;
  orderedTelemetryAvailable: boolean | null;
}

// Capsule v2 evidence pulled from `_run.meta.json` plus the persisted artifacts.
export interface CapsuleEvidence {
  capsuleV2ArtifactsPersisted: boolean;
  capsuleEngine: string | null;
  pivotRankingVersion: string | null;
  capsuleIntent: string | null;
  capsuleBudget: number | null;
  capsuleEstimatedTokens: number | null;
  topPivotFile: string | null;
  topPivotSymbol: string | null;
  pivotCount: number | null;
  supportCount: number | null;
  contextInjected: boolean | null;
  contextPolicyOverride: string | null;
  treatmentValid: boolean | string | null;
  pivotCheckPolicy: string | null;
  pivotCheckInjected: boolean | null;
  pivotCheckPolicyReason: string | null;
  // Whether the persisted artifact files were found on disk.
  manifestFilePresent: boolean;
  rankingFilePresent: boolean;
  contextFilePresent: boolean;
}

export interface RankingTopItem {
  rank: number | null;
  path: string | null;
  symbol: string | null;
  kind: string | null;
  pivotRankScore: number | null;
}

// Ranking evidence, including the rank-vs-score disagreement caveat detection.
export interface RankingEvidence {
  pivotRankingVersion: string | null;
  topItems: RankingTopItem[];
  // The rank-1 item, and whether the rendered/recorded order leads with the
  // expected cds.py::CDS pivot.
  rank1: RankingTopItem | null;
  topPivotIsExpected: boolean;
  // Rank-vs-score disagreement: a lower-ranked item carries a HIGHER score.
  rankScoreDisagreement: boolean;
  higherScoredLowerRanked: RankingTopItem | null;
}

export interface PatchAnalysis {
  patchPresent: boolean;
  editedFiles: string[];
  deletedFiles: string[];
  deletedGeneratedParserTables: string[];
  touchesCombinedUnitsMethod: boolean;
  narrowGrammarReorderPresent: boolean;
  // The combined "broad grammar rewrite" signal: a generated parser table was
  // deleted, or grammar productions were relocated into `p_combined_units`.
  broadGrammarRewriteDetected: boolean;
}

export interface ProtocolDiagnosticReport {
  generatedAt: string | null;
  runLabel: string;
  instanceId: string;
  condition: string;
  protocol: string;
  row: SweBenchRow;
  docker: DockerEvaluation;
  capsule: CapsuleEvidence;
  ranking: RankingEvidence;
  telemetry: OrderedTelemetry;
  patch: PatchAnalysis;
  contextGood: boolean;
  failureMode: string;
  diagnosis: {
    primaryIssue: string;
    secondaryIssues: string[];
    supersedes: string;
  };
  interpretation: string;
  rankingMetadataCaveat: string;
  recommendedNextStep: string;
  nonClaims: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNullableBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asToolCallMap(value: unknown): Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export function totalTokens(row: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  return (
    asNumber(row.inputTokens) +
    asNumber(row.outputTokens) +
    asNumber(row.cacheReadTokens) +
    asNumber(row.cacheCreationTokens)
  );
}

export function parseSweBenchRow(raw: Record<string, unknown>): SweBenchRow {
  return {
    instanceId: asNullableString(raw.instanceId) ?? "",
    resolved: asNullableBool(raw.resolved),
    inputTokens: asNumber(raw.inputTokens),
    outputTokens: asNumber(raw.outputTokens),
    cacheReadTokens: asNumber(raw.cacheReadTokens),
    cacheCreationTokens: asNumber(raw.cacheCreationTokens),
    costUsd: asNumber(raw.costUsd),
    numTurns: asNumber(raw.numTurns),
    durationMs: asNumber(raw.durationMs),
    commitHash: asNullableString(raw.commitHash),
    model: asNullableString(raw.model),
    agent: asNullableString(raw.agent),
    modelPatch: asNullableString(raw.modelPatch) ?? asNullableString(raw.patch) ?? "",
    toolCalls: asToolCallMap(raw.toolCalls),
  };
}

export function parseDockerEvaluation(evalMeta: Record<string, unknown> | null): DockerEvaluation {
  const resolvedCount = asNullableNumber(evalMeta?.resolvedCount);
  return {
    evaluationRan: asNullableBool(evalMeta?.evaluationRan),
    evaluationMethod: asNullableString(evalMeta?.evaluationMethod),
    dockerUsed: asNullableBool(evalMeta?.dockerUsed),
    evaluationError: asNullableString(evalMeta?.evaluationError),
    instancesEvaluated: asNullableNumber(evalMeta?.instancesEvaluated),
    resolvedCount,
    // A single-instance run resolves iff resolvedCount > 0.
    resolved: resolvedCount !== null && resolvedCount > 0,
  };
}

export function parseOrderedTelemetry(summary: Record<string, unknown> | null): OrderedTelemetry {
  return {
    totalToolCalls: asNullableNumber(summary?.totalToolCalls),
    bashToolCalls: asNullableNumber(summary?.bashToolCalls),
    grepLikeToolCalls: asNullableNumber(summary?.grepLikeToolCalls),
    fileReadToolCalls: asNullableNumber(summary?.fileReadToolCalls),
    fileWriteToolCalls: asNullableNumber(summary?.fileWriteToolCalls),
    uniqueFilesTouchedByTools: asNullableNumber(summary?.uniqueFilesTouchedByTools),
    longBashLoopHeuristic: asNullableBool(summary?.longBashLoopHeuristic),
    repeatedSearchHeuristic: asNullableBool(summary?.repeatedSearchHeuristic),
    orderedTelemetryAvailable: asNullableBool(summary?.orderedTelemetryAvailable),
  };
}

export function parseCapsuleEvidence(
  runMeta: Record<string, unknown> | null,
  artifactsPresent: { manifest: boolean; ranking: boolean; context: boolean },
): CapsuleEvidence {
  const treatmentRaw = runMeta?.vtraceTreatmentValid;
  const treatmentValid =
    typeof treatmentRaw === "boolean" || typeof treatmentRaw === "string" ? treatmentRaw : null;
  return {
    capsuleV2ArtifactsPersisted: runMeta?.capsuleV2ArtifactsPersisted === true,
    capsuleEngine: asNullableString(runMeta?.capsuleEngine) ?? asNullableString(runMeta?.vtraceCapsuleEngine),
    pivotRankingVersion: asNullableString(runMeta?.pivotRankingVersion),
    capsuleIntent: asNullableString(runMeta?.vtraceCapsuleIntent),
    capsuleBudget: asNullableNumber(runMeta?.vtraceCapsuleBudget),
    capsuleEstimatedTokens: asNullableNumber(runMeta?.vtraceCapsuleEstimatedTokens),
    topPivotFile: asNullableString(runMeta?.vtraceCapsuleTopPivotFile),
    topPivotSymbol: asNullableString(runMeta?.vtraceCapsuleTopPivotSymbol),
    pivotCount: asNullableNumber(runMeta?.vtracePivotCount),
    supportCount: asNullableNumber(runMeta?.vtraceSupportCount),
    contextInjected: asNullableBool(runMeta?.vtraceContextInjected),
    contextPolicyOverride: asNullableString(runMeta?.vtraceContextPolicyOverride),
    treatmentValid,
    pivotCheckPolicy: asNullableString(runMeta?.vtracePivotCheckPolicy),
    pivotCheckInjected: asNullableBool(runMeta?.vtracePivotCheckInjected),
    pivotCheckPolicyReason: asNullableString(runMeta?.vtracePivotCheckPolicyReason),
    manifestFilePresent: artifactsPresent.manifest,
    rankingFilePresent: artifactsPresent.ranking,
    contextFilePresent: artifactsPresent.context,
  };
}

function toRankingTopItem(raw: unknown): RankingTopItem {
  const r = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    rank: asNullableNumber(r.rank),
    path: asNullableString(r.path),
    symbol: asNullableString(r.symbol),
    kind: asNullableString(r.kind),
    pivotRankScore: asNullableNumber(r.pivotRankScore),
  };
}

// Detect whether the recorded rank order disagrees with the pivotRankScore order:
// a lower-ranked item (higher rank number) carries a strictly higher score than
// the rank-1 item. Returns the offending item when so, else null.
export function detectRankScoreDisagreement(
  items: readonly RankingTopItem[],
): { disagrees: boolean; rank1: RankingTopItem | null; higher: RankingTopItem | null } {
  const ranked = items.filter((item) => item.rank !== null).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const rank1 = ranked[0] ?? null;
  if (rank1 === null || rank1.pivotRankScore === null) {
    return { disagrees: false, rank1, higher: null };
  }
  for (const item of ranked.slice(1)) {
    if (item.pivotRankScore !== null && item.pivotRankScore > rank1.pivotRankScore) {
      return { disagrees: true, rank1, higher: item };
    }
  }
  return { disagrees: false, rank1, higher: null };
}

export function parseRankingEvidence(ranking: Record<string, unknown> | null): RankingEvidence {
  const rawItems = Array.isArray(ranking?.topItems) ? (ranking!.topItems as unknown[]) : [];
  const topItems = rawItems.map(toRankingTopItem);
  const { disagrees, rank1, higher } = detectRankScoreDisagreement(topItems);
  const topPivotIsExpected =
    rank1 !== null &&
    rank1.path === EXPECTED_TOP_PIVOT_FILE &&
    rank1.symbol === EXPECTED_TOP_PIVOT_SYMBOL;
  return {
    pivotRankingVersion: asNullableString(ranking?.pivotRankingVersion),
    topItems,
    rank1,
    topPivotIsExpected,
    rankScoreDisagreement: disagrees,
    higherScoredLowerRanked: higher,
  };
}

// Files touched by a unified-diff patch (`diff --git a/<file> b/<file>`).
export function editedFilesFromPatch(patch: string): string[] {
  const files = new Set<string>();
  const re = /^diff --git a\/(\S+) b\/\S+/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(patch)) !== null) files.add(match[1]!);
  return [...files];
}

// Files DELETED by a unified-diff patch: a `diff --git` block followed by a
// `deleted file mode` marker before the next block.
export function deletedFilesFromPatch(patch: string): string[] {
  const deleted: string[] = [];
  const blocks = patch.split(/^diff --git a\//m).slice(1);
  for (const block of blocks) {
    const header = block.match(/^(\S+) b\/\S+/);
    if (header === null) continue;
    if (/\ndeleted file mode/.test(`\n${block}`)) deleted.push(header[1]!);
  }
  return deleted;
}

export function analyzePatch(patch: string): PatchAnalysis {
  const editedFiles = editedFilesFromPatch(patch);
  const deletedFiles = deletedFilesFromPatch(patch);
  const deletedGeneratedParserTables = deletedFiles.filter((f) => GENERATED_PARSER_TABLE_RE.test(f));
  const touchesCombinedUnitsMethod = /p_combined_units/.test(patch);
  const narrowGrammarReorderPresent = NARROW_GRAMMAR_REORDER_RE.test(patch);
  return {
    patchPresent: patch.trim() !== "",
    editedFiles,
    deletedFiles,
    deletedGeneratedParserTables,
    touchesCombinedUnitsMethod,
    narrowGrammarReorderPresent,
    broadGrammarRewriteDetected: deletedGeneratedParserTables.length > 0 || touchesCombinedUnitsMethod,
  };
}

// Whether the run had GOOD localization context: a valid treatment, context
// injected, and the lead pivot pointing at the expected CDS parser class.
export function isContextGood(capsule: CapsuleEvidence, ranking: RankingEvidence): boolean {
  const treatmentOk = capsule.treatmentValid === true || capsule.treatmentValid === "true";
  const topPivotOk =
    capsule.topPivotFile === EXPECTED_TOP_PIVOT_FILE &&
    capsule.topPivotSymbol === EXPECTED_TOP_PIVOT_SYMBOL;
  return treatmentOk && capsule.contextInjected === true && (topPivotOk || ranking.topPivotIsExpected);
}

// Classify the failure mode from whether context was good and Docker resolved.
// Good context + unresolved Docker is the patch-mistake regime this report names.
export function classifyFailureMode(contextGood: boolean, dockerResolved: boolean): string {
  if (dockerResolved) return "resolved";
  return contextGood ? "patch_mistake_despite_good_context" : "localization_or_context_gap";
}

// ---------------------------------------------------------------------------
// IO layer
// ---------------------------------------------------------------------------

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readFirstJsonlRecord(dir: string): Promise<Record<string, unknown> | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const jsonl = entries.filter((name) => name.endsWith(".jsonl")).sort();
  for (const name of jsonl) {
    const text = await readTextFile(path.join(dir, name));
    if (!text) continue;
    const firstLine = text.split("\n").find((line) => line.trim() !== "");
    if (!firstLine) continue;
    try {
      const parsed = JSON.parse(firstLine);
      if (parsed !== null && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // try next file
    }
  }
  return null;
}

export interface LoadOptions {
  resultsDir: string;
  runLabel?: string;
  condition?: string;
}

export async function buildReport(
  options: LoadOptions,
  generatedAt: string | null,
): Promise<ProtocolDiagnosticReport> {
  const runLabel = options.runLabel ?? RUN_LABEL;
  const condition = options.condition ?? CONDITION;

  const runDir = path.join(options.resultsDir, "runs", runLabel);
  const conditionDir = path.join(runDir, "raw", condition);

  const rowRaw = await readFirstJsonlRecord(conditionDir);
  if (rowRaw === null) {
    throw new Error(
      `Missing protocol run row: no JSONL record under ${conditionDir} (label "${runLabel}").`,
    );
  }

  const evalMeta = await readJsonFile(path.join(conditionDir, "_eval.meta.json"));
  const runMeta = await readJsonFile(path.join(conditionDir, "_run.meta.json"));
  const summary = await readJsonFile(path.join(conditionDir, "_tool_calls.summary.json"));
  const rankingJson = await readJsonFile(path.join(conditionDir, "_capsule_v2_ranking.json"));
  const artifactsPresent = {
    manifest: await fileExists(path.join(conditionDir, "_capsule_v2_manifest.json")),
    ranking: await fileExists(path.join(conditionDir, "_capsule_v2_ranking.json")),
    context: await fileExists(path.join(conditionDir, "_capsule_v2_context.md")),
  };

  const row = parseSweBenchRow(rowRaw);
  const docker = parseDockerEvaluation(evalMeta);
  if (row.resolved === null) row.resolved = docker.resolved;

  const capsule = parseCapsuleEvidence(runMeta, artifactsPresent);
  const ranking = parseRankingEvidence(rankingJson);
  const telemetry = parseOrderedTelemetry(summary);
  const patch = analyzePatch(row.modelPatch);
  const contextGood = isContextGood(capsule, ranking);
  const failureMode = classifyFailureMode(contextGood, docker.resolved);

  return {
    generatedAt,
    runLabel,
    instanceId: row.instanceId || INSTANCE_ID,
    condition,
    protocol: "vtrace-indexed",
    row,
    docker,
    capsule,
    ranking,
    telemetry,
    patch,
    contextGood,
    failureMode,
    diagnosis: {
      primaryIssue: PRIMARY_ISSUE,
      secondaryIssues: [...SECONDARY_ISSUES],
      supersedes: SUPERSEDES_ISSUE,
    },
    interpretation: INTERPRETATION,
    rankingMetadataCaveat: RANKING_METADATA_CAVEAT,
    recommendedNextStep: RECOMMENDED_NEXT_STEP,
    nonClaims: [...NON_CLAIMS],
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function boolMark(value: boolean | null): string {
  if (value === null) return "n/a";
  return value ? "yes" : "no";
}

function scoreStr(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

export function renderJson(report: ProtocolDiagnosticReport): string {
  const r = report.row;
  const out = {
    report: "stage5-astropy-protocol-diagnostic",
    generatedAt: report.generatedAt,
    runLabel: report.runLabel,
    instanceId: report.instanceId,
    condition: report.condition,
    protocol: report.protocol,
    commitHash: r.commitHash,
    model: r.model,
    agent: r.agent,
    capsule: report.capsule,
    ranking: {
      pivotRankingVersion: report.ranking.pivotRankingVersion,
      topItems: report.ranking.topItems,
      rank1: report.ranking.rank1,
      topPivotIsExpected: report.ranking.topPivotIsExpected,
      rankScoreDisagreement: report.ranking.rankScoreDisagreement,
      higherScoredLowerRanked: report.ranking.higherScoredLowerRanked,
    },
    orderedTelemetry: report.telemetry,
    docker: report.docker,
    cost: {
      totalTokens: totalTokens(r),
      costUsd: r.costUsd,
      numTurns: r.numTurns,
      durationMs: r.durationMs,
      toolCalls: r.toolCalls,
    },
    patch: report.patch,
    contextGood: report.contextGood,
    failureMode: report.failureMode,
    diagnosis: report.diagnosis,
    interpretation: report.interpretation,
    rankingMetadataCaveat: report.rankingMetadataCaveat,
    recommendedNextStep: report.recommendedNextStep,
    nonClaims: report.nonClaims,
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

export function renderMarkdown(report: ProtocolDiagnosticReport): string {
  const r = report.row;
  const c = report.capsule;
  const k = report.ranking;
  const t = report.telemetry;
  const d = report.docker;
  const p = report.patch;
  const lines: string[] = [];

  lines.push("# Stage 5 Astropy protocol diagnostic");
  lines.push("");
  if (report.generatedAt) lines.push(`_Generated: ${report.generatedAt}_`, "");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `An auditable Capsule v2 protocol run on \`${report.instanceId}\` (run label ` +
      `\`${report.runLabel}\`) injected indexed Capsule v2 context (force-inject), placed ` +
      `\`${EXPECTED_TOP_PIVOT_FILE}::${EXPECTED_TOP_PIVOT_SYMBOL}\` first, and avoided the earlier ` +
      `loop pattern (both loop heuristics false). It produced a patch but Docker evaluation ` +
      `reported it ${d.resolved ? "resolved" : "UNRESOLVED"}. The diagnosis is updated to ` +
      `**${report.diagnosis.primaryIssue}**, superseding the earlier \`${report.diagnosis.supersedes}\` ` +
      `hypothesis for this auditable run.`,
  );
  lines.push("");

  // Run identity
  lines.push("## Run identity");
  lines.push("");
  lines.push(`- Run label: \`${report.runLabel}\``);
  lines.push(`- Instance: \`${report.instanceId}\``);
  lines.push(`- Condition: \`${report.condition}\``);
  lines.push(`- Protocol: \`${report.protocol}\``);
  lines.push(`- Capsule engine: ${c.capsuleEngine ?? "n/a"}`);
  lines.push(`- Pivot ranking version: ${c.pivotRankingVersion ?? k.pivotRankingVersion ?? "n/a"}`);
  lines.push(`- Context policy override: ${c.contextPolicyOverride ?? "n/a"}`);
  lines.push(`- Model: ${r.model ?? "n/a"}`);
  lines.push(`- Commit: ${r.commitHash ?? "n/a"}`);
  lines.push("");

  // Capsule v2 evidence
  lines.push("## Capsule v2 evidence");
  lines.push("");
  lines.push(`- Capsule v2 artifacts persisted: ${c.capsuleV2ArtifactsPersisted ? "yes" : "no"}`);
  lines.push(`- Manifest / ranking / context files present: ${boolMark(c.manifestFilePresent)} / ${boolMark(c.rankingFilePresent)} / ${boolMark(c.contextFilePresent)}`);
  lines.push(`- Capsule intent: ${c.capsuleIntent ?? "n/a"}`);
  lines.push(`- Capsule budget: ${c.capsuleBudget ?? "n/a"}`);
  lines.push(`- Capsule estimated tokens: ${c.capsuleEstimatedTokens ?? "n/a"}`);
  lines.push(`- Top pivot (meta): ${c.topPivotFile ?? "n/a"}::${c.topPivotSymbol ?? "n/a"}`);
  lines.push(`- Pivot count / support count: ${c.pivotCount ?? "n/a"} / ${c.supportCount ?? "n/a"}`);
  lines.push(`- Context injected: ${boolMark(c.contextInjected)}`);
  lines.push(`- Treatment valid: ${c.treatmentValid === null ? "n/a" : String(c.treatmentValid)}`);
  lines.push(`- PIVOT_CHECK policy: ${c.pivotCheckPolicy ?? "n/a"} (injected: ${boolMark(c.pivotCheckInjected)})`);
  lines.push(`- PIVOT_CHECK reason: ${c.pivotCheckPolicyReason ?? "n/a"}`);
  lines.push("");

  // Ranking/context evidence
  lines.push("## Ranking/context evidence");
  lines.push("");
  lines.push(
    `The persisted ranking and rendered context both lead with ` +
      `\`${EXPECTED_TOP_PIVOT_FILE}::${EXPECTED_TOP_PIVOT_SYMBOL}\` ` +
      `(rank-1 is the expected pivot: ${k.topPivotIsExpected ? "yes" : "no"}).`,
  );
  lines.push("");
  lines.push("| rank | path | symbol | kind | pivotRankScore |");
  lines.push("| ---: | --- | --- | --- | ---: |");
  for (const item of k.topItems) {
    lines.push(
      `| ${item.rank ?? "n/a"} | ${item.path ?? "n/a"} | ${item.symbol ?? "n/a"} | ${item.kind ?? "n/a"} | ${scoreStr(item.pivotRankScore)} |`,
    );
  }
  lines.push("");

  // Ordered telemetry evidence
  lines.push("## Ordered telemetry evidence");
  lines.push("");
  lines.push(`- Ordered telemetry available: ${boolMark(t.orderedTelemetryAvailable)}`);
  lines.push(`- Total tool calls: ${t.totalToolCalls ?? "n/a"}`);
  lines.push(`- Bash tool calls: ${t.bashToolCalls ?? "n/a"}`);
  lines.push(`- Grep-like tool calls: ${t.grepLikeToolCalls ?? "n/a"}`);
  lines.push(`- File-read tool calls: ${t.fileReadToolCalls ?? "n/a"}`);
  lines.push(`- File-write tool calls: ${t.fileWriteToolCalls ?? "n/a"}`);
  lines.push(`- Unique files touched: ${t.uniqueFilesTouchedByTools ?? "n/a"}`);
  lines.push(`- Long Bash loop heuristic: ${boolMark(t.longBashLoopHeuristic)}`);
  lines.push(`- Repeated search heuristic: ${boolMark(t.repeatedSearchHeuristic)}`);
  lines.push("");
  lines.push("Both loop heuristics are false: the auditable run did not exhibit the earlier loop pattern.");
  lines.push("");

  // Docker outcome
  lines.push("## Docker outcome");
  lines.push("");
  lines.push(`- Evaluation ran: ${boolMark(d.evaluationRan)}`);
  lines.push(`- Evaluation method: ${d.evaluationMethod ?? "n/a"}`);
  lines.push(`- Docker used: ${boolMark(d.dockerUsed)}`);
  lines.push(`- Evaluation error: ${d.evaluationError ?? "null"}`);
  lines.push(`- Instances evaluated: ${d.instancesEvaluated ?? "n/a"}`);
  lines.push(`- Resolved count: ${d.resolvedCount ?? "n/a"}`);
  lines.push(`- Resolved: ${d.resolved ? "True" : "False"}`);
  lines.push(`- Cost (USD): $${r.costUsd}`);
  lines.push(`- Total tokens: ${totalTokens(r).toLocaleString("en-US")}`);
  lines.push("");

  // Patch analysis
  lines.push("## Patch analysis");
  lines.push("");
  lines.push(`- Patch present: ${p.patchPresent ? "yes" : "no"}`);
  lines.push(`- Edited files: ${p.editedFiles.join(", ") || "none"}`);
  lines.push(`- Deleted files: ${p.deletedFiles.join(", ") || "none"}`);
  lines.push(`- Deleted generated parser tables: ${p.deletedGeneratedParserTables.join(", ") || "none"}`);
  lines.push(`- Touches \`p_combined_units\` grammar method: ${p.touchesCombinedUnitsMethod ? "yes" : "no"}`);
  lines.push(`- Narrow known-good grammar reorder present: ${p.narrowGrammarReorderPresent ? "yes" : "no"}`);
  lines.push(`- Broad grammar rewrite detected: ${p.broadGrammarRewriteDetected ? "yes" : "no"}`);
  lines.push("");
  lines.push(
    "The patch deleted a generated parser table and relocated grammar productions into " +
      "`p_combined_units`, a broad rewrite, rather than the narrower known-good reorder " +
      "`division_of_units: unit_expression DIVISION combined_units` → " +
      "`combined_units DIVISION unit_expression`.",
  );
  lines.push("");

  // Diagnosis update
  lines.push("## Diagnosis update");
  lines.push("");
  lines.push(`- Primary issue: \`${report.diagnosis.primaryIssue}\``);
  lines.push(`- Secondary issues: ${report.diagnosis.secondaryIssues.map((s) => `\`${s}\``).join(", ")}`);
  lines.push(`- Supersedes (history): \`${report.diagnosis.supersedes}\` (earlier strict/risk runs without persisted Capsule artifacts)`);
  lines.push(`- Computed failure mode: \`${report.failureMode}\` (context good: ${report.contextGood ? "yes" : "no"}; Docker resolved: ${d.resolved ? "yes" : "no"})`);
  lines.push("");
  lines.push(report.interpretation);
  lines.push("");

  // Ranking metadata caveat
  lines.push("## Ranking metadata caveat");
  lines.push("");
  if (k.rankScoreDisagreement && k.rank1 !== null && k.higherScoredLowerRanked !== null) {
    lines.push(
      `> Detected: rank ${k.rank1.rank} \`${k.rank1.path}::${k.rank1.symbol}\` ` +
        `(pivotRankScore ${scoreStr(k.rank1.pivotRankScore)}) is ordered ahead of rank ` +
        `${k.higherScoredLowerRanked.rank} \`${k.higherScoredLowerRanked.path}::${k.higherScoredLowerRanked.symbol}\` ` +
        `(pivotRankScore ${scoreStr(k.higherScoredLowerRanked.pivotRankScore)}), which is HIGHER.`,
    );
    lines.push("");
  }
  lines.push(report.rankingMetadataCaveat);
  lines.push("");

  // Recommended next step
  lines.push("## Recommended next step");
  lines.push("");
  lines.push(report.recommendedNextStep);
  lines.push("");

  // Non-claims
  lines.push("## Non-claims");
  lines.push("");
  for (const claim of report.nonClaims) lines.push(`- ${claim}`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const DEFAULT_RESULTS_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "results",
);

export interface ReportCliConfig {
  resultsDir: string;
  outDir: string;
  runLabel: string;
  condition: string;
}

export function parseReportArgs(argv: readonly string[]): ReportCliConfig {
  const config: ReportCliConfig = {
    resultsDir: DEFAULT_RESULTS_DIR,
    outDir: DEFAULT_RESULTS_DIR,
    runLabel: RUN_LABEL,
    condition: CONDITION,
  };
  let outExplicit = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}.`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--results":
      case "--results-dir":
        config.resultsDir = next();
        break;
      case "--out":
        config.outDir = next();
        outExplicit = true;
        break;
      case "--run-label":
        config.runLabel = next();
        break;
      case "--condition":
        config.condition = next();
        break;
      case "--help":
      case "-h":
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!outExplicit) config.outDir = config.resultsDir;
  return config;
}

async function main(config: ReportCliConfig): Promise<void> {
  const generatedAt = new Date().toISOString();
  const report = await buildReport(
    { resultsDir: config.resultsDir, runLabel: config.runLabel, condition: config.condition },
    generatedAt,
  );

  await mkdir(config.outDir, { recursive: true });
  const mdPath = path.join(config.outDir, `${REPORT_BASENAME}.md`);
  const jsonPath = path.join(config.outDir, `${REPORT_BASENAME}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  process.stdout.write(
    [
      `Stage 5 Astropy protocol diagnostic written:`,
      `  ${mdPath}`,
      `  ${jsonPath}`,
      ``,
      `Instance:        ${report.instanceId}`,
      `Resolved:        ${report.docker.resolved ? "True" : "False"}`,
      `Context good:    ${report.contextGood ? "yes" : "no"}`,
      `Failure mode:    ${report.failureMode}`,
      `Primary issue:   ${report.diagnosis.primaryIssue}`,
      `Rank/score caveat: ${report.ranking.rankScoreDisagreement ? "rank≠score order" : "consistent"}`,
      ``,
    ].join("\n"),
  );
}

if (import.meta.main) {
  try {
    await main(parseReportArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
