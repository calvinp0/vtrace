// Deterministic retrieval benchmark provenance and comparison authority.
//
// This module deliberately lives beside the benchmark runner rather than in the
// product. It binds a result to the product implementation, fixture bytes,
// runner/scorer sources, target source checkouts, protocol, and semantic field
// definition that produced it. Product retrieval never imports this module.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";

import { FILE_SNAPSHOT_SCHEMA_VERSION, RETRIEVAL_SCHEMA_VERSION } from "../../src/indexer/incrementalIndex";
import type {
  RetrievalEvalAggregate,
  RetrievalEvalArtifact,
  RetrievalEvalFixtureEntry,
  RetrievalEvalRow,
} from "./run_stage5_retrieval_eval";

export const BENCHMARK_PROTOCOL_VERSION = "stage5.retrieval.protocol.v1" as const;
export const SEMANTIC_HASH_VERSION = "stage5.retrieval.semantic.v1" as const;

export type ArtifactState = "authoritative" | "exploratory" | "superseded" | "historical_unverified";
export type BaselineAuthority = "authoritative" | "non_authoritative";

export type ProvenanceMismatchReason =
  | "baseline_vtrace_commit_mismatch"
  | "baseline_tree_mismatch"
  | "fixture_hash_mismatch"
  | "runner_fingerprint_mismatch"
  | "protocol_mismatch"
  | "target_corpus_mismatch"
  | "semantic_hash_version_mismatch"
  | "dirty_baseline_not_authoritative"
  | "missing_provenance";

export interface GitSourceProvenance {
  readonly commit: string | null;
  readonly tree: string | null;
  /** Hash of the effective benchmark/product input files, including edits. */
  readonly sourceFingerprint: string;
  readonly dirty: boolean;
  readonly dirtyPaths: readonly string[];
}

export interface FixtureProvenance {
  readonly name: string;
  readonly path: string;
  readonly hash: string;
  readonly caseCount: number;
  readonly taskOrderHash: string;
  readonly goldLabelHash: string;
}

export interface RunnerProvenance {
  readonly fingerprint: string;
  readonly protocolVersion: typeof BENCHMARK_PROTOCOL_VERSION;
  readonly sourceFiles: readonly string[];
}

export interface TargetRepositoryProvenance {
  readonly instanceId: string;
  readonly repository: string;
  readonly commit: string | null;
  readonly tree: string | null;
  readonly dirty: boolean | null;
  readonly dirtyFingerprint: string | null;
  readonly worktreeId: string;
  readonly declaredBaseCommit: string | null;
  readonly indexedSourceFingerprint: string | null;
  readonly sourceIdentity: "git_head" | "declared_swebench_base+indexed_snapshot" | "unresolved";
}

export interface TargetCorpusProvenance {
  readonly hash: string;
  readonly manifestHash: string | null;
  readonly repositories: readonly TargetRepositoryProvenance[];
}

export interface BenchmarkProvenance {
  readonly schemaVersion: "stage5.benchmark-provenance.v1";
  readonly artifactState: ArtifactState;
  readonly authority: BaselineAuthority;
  readonly vtrace: GitSourceProvenance;
  readonly runner: RunnerProvenance;
  readonly fixture: FixtureProvenance;
  readonly targetCorpus: TargetCorpusProvenance;
  readonly schemas: {
    readonly index: number | null;
    readonly manifest: number | null;
    readonly snapshot: number | null;
    readonly retrieval: number | null;
    readonly capsuleProductContext: string | null;
  };
  readonly semanticHashVersion: typeof SEMANTIC_HASH_VERSION;
  readonly resultSemanticHash: string;
  readonly metricSummaryHash: string;
  readonly complete: boolean;
  readonly collectionMs: number;
}

export interface ComparisonExpectation {
  readonly predecessorCommit: string;
  readonly predecessorTree?: string;
  readonly fixtureHash: string;
  readonly runnerFingerprint: string;
  readonly protocolVersion: string;
  readonly targetCorpusHash: string;
  readonly semanticHashVersion: string;
}

export interface ComparisonValidity {
  readonly valid: boolean;
  readonly authoritative: boolean;
  readonly reasons: readonly ProvenanceMismatchReason[];
  readonly message: string;
}

export interface PairedSemanticDifferences {
  readonly selectedFiles: number;
  readonly lead: number;
  readonly roles: number;
  readonly contentModes: number;
  readonly modelVisibleContext: number;
  readonly tokenAccounting: number;
  readonly qualityMetrics: number;
}

export interface PairedCaseDifference {
  readonly instanceId: string;
  readonly fields: readonly (keyof PairedSemanticDifferences)[];
  readonly predecessorLead: string | null;
  readonly candidateLead: string | null;
  readonly predecessorSelectedFiles: readonly string[];
  readonly candidateSelectedFiles: readonly string[];
  readonly predecessorGoldVisible: boolean;
  readonly candidateGoldVisible: boolean;
}

export interface PairedComparisonResult {
  readonly schemaVersion: "stage5.paired-retrieval-comparison.v1";
  readonly declaredPredecessor: string;
  readonly candidateCommit: string | null;
  readonly validity: ComparisonValidity;
  readonly authoritative: boolean;
  readonly differences: PairedSemanticDifferences;
  readonly changedCases: readonly PairedCaseDifference[];
  readonly predecessorSemanticHash: string | null;
  readonly candidateSemanticHash: string | null;
  readonly pass: boolean;
}

export interface CollectBenchmarkProvenanceInput {
  readonly repoRoot: string;
  readonly vtraceRoot?: string;
  readonly fixturePath: string;
  readonly entries: readonly RetrievalEvalFixtureEntry[];
  readonly rows: readonly RetrievalEvalRow[];
  readonly aggregate: RetrievalEvalAggregate;
  readonly requestedArtifactState?: ArtifactState;
}

const RUNNER_SOURCE_FILES = [
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_retrieval_eval.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/benchmarkProvenance.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m134_historical_replay.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m134_prepare_targets.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m134_paired_comparison.ts",
] as const;

const VTRACE_INPUT_PATHS = [
  "src",
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "tsconfig.benchmarks.json",
  ...RUNNER_SOURCE_FILES,
] as const;

export async function collectBenchmarkProvenance(
  input: CollectBenchmarkProvenanceInput,
): Promise<BenchmarkProvenance> {
  const started = performance.now();
  const [vtrace, fixture, runner, targetCorpus] = await Promise.all([
    collectGitSourceProvenance(input.vtraceRoot ?? input.repoRoot),
    collectFixtureProvenance(input.repoRoot, input.fixturePath, input.entries),
    collectRunnerProvenance(input.repoRoot),
    collectTargetCorpusProvenance(input.repoRoot, input.entries),
  ]);
  const artifactState = resolveArtifactState(input.requestedArtifactState, vtrace.dirty);
  const authority: BaselineAuthority = artifactState === "authoritative" && !vtrace.dirty
    ? "authoritative"
    : "non_authoritative";
  const complete = fixture.caseCount === input.rows.length
    && targetCorpus.repositories.length === input.entries.length
    && targetCorpus.repositories.every((repo) => repo.commit !== null && repo.dirty !== true && repo.sourceIdentity !== "unresolved");
  return {
    schemaVersion: "stage5.benchmark-provenance.v1",
    artifactState,
    authority,
    vtrace,
    runner,
    fixture,
    targetCorpus,
    schemas: {
      index: FILE_SNAPSHOT_SCHEMA_VERSION,
      manifest: FILE_SNAPSHOT_SCHEMA_VERSION,
      snapshot: FILE_SNAPSHOT_SCHEMA_VERSION,
      retrieval: RETRIEVAL_SCHEMA_VERSION,
      capsuleProductContext: "capsule-v2/product-context-v1",
    },
    semanticHashVersion: SEMANTIC_HASH_VERSION,
    resultSemanticHash: hashStable(semanticProjection(input.rows)),
    metricSummaryHash: hashStable(input.aggregate),
    complete,
    collectionMs: roundMs(performance.now() - started),
  };
}

export async function collectFixtureProvenance(
  repoRoot: string,
  fixturePath: string,
  entries: readonly RetrievalEvalFixtureEntry[],
): Promise<FixtureProvenance> {
  const absolute = path.resolve(repoRoot, fixturePath);
  const bytes = await readFile(absolute);
  const portablePath = portableRelativePath(repoRoot, absolute);
  return {
    name: path.basename(absolute),
    path: portablePath,
    hash: sha256(bytes),
    caseCount: entries.length,
    taskOrderHash: hashStable(entries.map((entry) => ({ instanceId: entry.instance_id, task: entry.task }))),
    goldLabelHash: hashStable(entries.map((entry) => ({
      instanceId: entry.instance_id,
      labelSource: entry.label_source,
      expectedFiles: entry.expected_files,
      expectedSymbols: entry.expected_symbols,
    }))),
  };
}

export async function collectRunnerProvenance(repoRoot: string): Promise<RunnerProvenance> {
  const parts: Array<{ path: string; hash: string }> = [];
  for (const relative of RUNNER_SOURCE_FILES) {
    const bytes = await readFile(path.join(repoRoot, relative));
    parts.push({ path: relative, hash: sha256(bytes) });
  }
  return {
    fingerprint: hashStable({ protocolVersion: BENCHMARK_PROTOCOL_VERSION, sources: parts }),
    protocolVersion: BENCHMARK_PROTOCOL_VERSION,
    sourceFiles: RUNNER_SOURCE_FILES,
  };
}

export async function collectGitSourceProvenance(repoRoot: string): Promise<GitSourceProvenance> {
  const commit = gitOrNull(repoRoot, ["rev-parse", "HEAD"]);
  const tree = gitOrNull(repoRoot, ["rev-parse", "HEAD^{tree}"]);
  const status = git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--", ...VTRACE_INPUT_PATHS]);
  const dirtyPaths = status.split("\n").filter(Boolean).map((line) => line.slice(3)).sort();
  const tracked = git(repoRoot, ["ls-files", "-co", "--exclude-standard", "--", ...VTRACE_INPUT_PATHS])
    .split("\n").filter(Boolean).sort();
  const content: Array<{ path: string; hash: string }> = [];
  for (const relative of tracked) {
    const absolute = path.join(repoRoot, relative);
    if (!(await isRegularFile(absolute))) continue;
    content.push({ path: relative, hash: sha256(await readFile(absolute)) });
  }
  return {
    commit,
    tree,
    sourceFingerprint: hashStable(content),
    dirty: dirtyPaths.length > 0,
    dirtyPaths,
  };
}

export async function collectTargetCorpusProvenance(
  repoRoot: string,
  entries: readonly RetrievalEvalFixtureEntry[],
): Promise<TargetCorpusProvenance> {
  const manifestPath = path.join(repoRoot, "benchmarks/stage5_vexp_swe_bench_smoke/retrieval_eval.target_corpus.json");
  const manifestBytes = await readFile(manifestPath).catch(() => null);
  const manifest = manifestBytes === null ? null : parseTargetManifest(manifestBytes.toString("utf8"));
  const declaredById = new Map((manifest?.instances ?? []).map((item) => [item.instanceId, item]));
  const repositories: TargetRepositoryProvenance[] = [];
  for (const entry of entries) {
    const workspace = path.resolve(repoRoot, entry.workspace);
    const gitCommit = gitOrNull(workspace, ["rev-parse", "HEAD"]);
    const tree = gitOrNull(workspace, ["rev-parse", "HEAD^{tree}"]);
    const declared = declaredById.get(entry.instance_id) ?? null;
    const commit = gitCommit ?? declared?.baseCommit ?? null;
    const status = gitCommit === null
      ? ""
      : git(workspace, ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude).vtrace"]);
    const dirty = gitCommit === null ? null : status.trim().length > 0;
    const indexedSourceFingerprint = collectIndexedSourceFingerprint(path.join(workspace, ".vtrace", "index.sqlite"));
    const sourceIdentity = gitCommit !== null
      ? "git_head"
      : declared !== null && indexedSourceFingerprint !== null
        ? "declared_swebench_base+indexed_snapshot"
        : "unresolved";
    repositories.push({
      instanceId: entry.instance_id,
      repository: entry.repo,
      commit,
      tree,
      dirty,
      dirtyFingerprint: dirty === true ? sha256(status) : null,
      worktreeId: hashStable({ instanceId: entry.instance_id, repository: entry.repo, commit, tree, indexedSourceFingerprint }),
      declaredBaseCommit: declared?.baseCommit ?? null,
      indexedSourceFingerprint,
      sourceIdentity,
    });
  }
  const corpusIdentity = repositories.map((repository) => ({
    instanceId: repository.instanceId,
    repository: repository.repository,
    commit: repository.commit,
  }));
  return { hash: hashStable(corpusIdentity), manifestHash: manifestBytes === null ? null : sha256(manifestBytes), repositories };
}

export function validateBaselineProvenance(
  baseline: Pick<RetrievalEvalArtifact, "benchmarkProvenance"> | { readonly benchmarkProvenance?: BenchmarkProvenance },
  expected: ComparisonExpectation,
): ComparisonValidity {
  const provenance = baseline.benchmarkProvenance;
  if (provenance === undefined) {
    return invalid(["missing_provenance"], "Stored baseline has no benchmark provenance. Comparison refused.");
  }
  const reasons: ProvenanceMismatchReason[] = [];
  if (provenance.vtrace.commit !== expected.predecessorCommit) reasons.push("baseline_vtrace_commit_mismatch");
  if (expected.predecessorTree !== undefined && provenance.vtrace.tree !== expected.predecessorTree) {
    reasons.push("baseline_tree_mismatch");
  }
  if (provenance.fixture.hash !== expected.fixtureHash) reasons.push("fixture_hash_mismatch");
  if (provenance.runner.fingerprint !== expected.runnerFingerprint) reasons.push("runner_fingerprint_mismatch");
  if (provenance.runner.protocolVersion !== expected.protocolVersion) reasons.push("protocol_mismatch");
  if (provenance.targetCorpus.hash !== expected.targetCorpusHash) reasons.push("target_corpus_mismatch");
  if (provenance.semanticHashVersion !== expected.semanticHashVersion) reasons.push("semantic_hash_version_mismatch");
  if (provenance.vtrace.dirty || provenance.artifactState !== "authoritative" || provenance.authority !== "authoritative") {
    reasons.push("dirty_baseline_not_authoritative");
  }
  if (reasons.length > 0) {
    return invalid(
      reasons,
      `Baseline provenance mismatch (${reasons.join(", ")}). Comparison refused. Run paired predecessor evaluation or regenerate the baseline.`,
    );
  }
  return { valid: true, authoritative: true, reasons: [], message: "Baseline provenance valid." };
}

export function comparisonExpectationFromCandidate(
  predecessorCommit: string,
  candidate: BenchmarkProvenance,
  predecessorTree?: string,
): ComparisonExpectation {
  return {
    predecessorCommit,
    ...(predecessorTree === undefined ? {} : { predecessorTree }),
    fixtureHash: candidate.fixture.hash,
    runnerFingerprint: candidate.runner.fingerprint,
    protocolVersion: candidate.runner.protocolVersion,
    targetCorpusHash: candidate.targetCorpus.hash,
    semanticHashVersion: candidate.semanticHashVersion,
  };
}

export function comparePairedArtifacts(
  predecessor: Pick<RetrievalEvalArtifact, "benchmarkProvenance" | "rows">,
  candidate: Pick<RetrievalEvalArtifact, "benchmarkProvenance" | "rows">,
  declaredPredecessor: string,
  options: { readonly allowProvenanceMismatch?: boolean } = {},
): PairedComparisonResult {
  const expectation = comparisonExpectationFromCandidate(declaredPredecessor, candidate.benchmarkProvenance);
  const validity = validateBaselineProvenance(predecessor, expectation);
  const zero: PairedSemanticDifferences = {
    selectedFiles: 0,
    lead: 0,
    roles: 0,
    contentModes: 0,
    modelVisibleContext: 0,
    tokenAccounting: 0,
    qualityMetrics: 0,
  };
  if (!validity.valid && options.allowProvenanceMismatch !== true) {
    return {
      schemaVersion: "stage5.paired-retrieval-comparison.v1",
      declaredPredecessor,
      candidateCommit: candidate.benchmarkProvenance.vtrace.commit,
      validity,
      authoritative: false,
      differences: zero,
      changedCases: [],
      predecessorSemanticHash: predecessor.benchmarkProvenance.resultSemanticHash,
      candidateSemanticHash: candidate.benchmarkProvenance.resultSemanticHash,
      pass: false,
    };
  }
  const byId = new Map(predecessor.rows.map((row) => [row.instance_id, row]));
  const differences = { ...zero };
  const changedCases: PairedCaseDifference[] = [];
  for (const candidateRow of candidate.rows) {
    const predecessorRow = byId.get(candidateRow.instance_id);
    const fields: Array<keyof PairedSemanticDifferences> = [];
    if (predecessorRow === undefined) {
      for (const field of Object.keys(differences) as Array<keyof PairedSemanticDifferences>) {
        differences[field] += 1;
        fields.push(field);
      }
    } else {
      const before = semanticRowProjection(predecessorRow);
      const after = semanticRowProjection(candidateRow);
      for (const field of Object.keys(differences) as Array<keyof PairedSemanticDifferences>) {
        if (stableStringify(before[field]) !== stableStringify(after[field])) {
          differences[field] += 1;
          fields.push(field);
        }
      }
    }
    if (fields.length > 0) {
      changedCases.push({
        instanceId: candidateRow.instance_id,
        fields,
        predecessorLead: predecessorRow?.semantic?.lead ?? predecessorRow?.top_1_pivot_file ?? null,
        candidateLead: candidateRow.semantic?.lead ?? candidateRow.top_1_pivot_file,
        predecessorSelectedFiles: predecessorRow?.semantic?.selectedFiles ?? predecessorRow?.top_3_files ?? [],
        candidateSelectedFiles: candidateRow.semantic?.selectedFiles ?? candidateRow.top_3_files,
        predecessorGoldVisible: predecessorRow?.contains_expected_file_anywhere ?? false,
        candidateGoldVisible: candidateRow.contains_expected_file_anywhere,
      });
    }
  }
  const authoritative = validity.valid
    && candidate.benchmarkProvenance.complete
    && candidate.benchmarkProvenance.authority === "authoritative";
  const semanticEqual = Object.values(differences).every((count) => count === 0);
  return {
    schemaVersion: "stage5.paired-retrieval-comparison.v1",
    declaredPredecessor,
    candidateCommit: candidate.benchmarkProvenance.vtrace.commit,
    validity,
    authoritative,
    differences,
    changedCases,
    predecessorSemanticHash: predecessor.benchmarkProvenance.resultSemanticHash,
    candidateSemanticHash: candidate.benchmarkProvenance.resultSemanticHash,
    pass: authoritative && semanticEqual,
  };
}

export function semanticProjection(rows: readonly RetrievalEvalRow[]): unknown {
  return rows.map((row) => ({
    instanceId: row.instance_id,
    selectedFiles: row.semantic?.selectedFiles ?? row.top_3_files,
    lead: row.semantic?.lead ?? row.top_1_pivot_file,
    roles: row.semantic?.roles ?? [],
    contentModes: row.semantic?.contentModes ?? [],
    modelVisibleContext: row.semantic?.modelVisibleContext ?? null,
    tokenAccounting: row.semantic?.tokenAccounting ?? {
      budgetTokens: row.budget_tokens,
      estimatedTokens: row.estimated_tokens,
      usedPercent: row.used_percent,
    },
    quality: {
      result: row.result,
      expectedFileRank: row.expected_file_best_rank,
      expectedFileRole: row.expected_file_role,
      expectedSymbolRank: row.expected_symbol_best_rank,
      expectedSymbolRole: row.expected_symbol_role,
    },
  }));
}

function semanticRowProjection(row: RetrievalEvalRow): Record<keyof PairedSemanticDifferences, unknown> {
  return {
    selectedFiles: row.semantic?.selectedFiles ?? row.top_3_files,
    lead: row.semantic?.lead ?? row.top_1_pivot_file,
    roles: row.semantic?.roles ?? [],
    contentModes: row.semantic?.contentModes ?? [],
    modelVisibleContext: row.semantic?.modelVisibleContext ?? null,
    tokenAccounting: row.semantic?.tokenAccounting ?? {
      budgetTokens: row.budget_tokens,
      estimatedTokens: row.estimated_tokens,
      usedPercent: row.used_percent,
    },
    qualityMetrics: {
      result: row.result,
      expectedFileRank: row.expected_file_best_rank,
      expectedFileRole: row.expected_file_role,
      expectedSymbolRank: row.expected_symbol_best_rank,
      expectedSymbolRole: row.expected_symbol_role,
    },
  };
}

export function hashStable(value: unknown): string {
  return sha256(stableStringify(value));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function resolveArtifactState(requested: ArtifactState | undefined, dirty: boolean): ArtifactState {
  if (dirty) return "exploratory";
  return requested ?? "authoritative";
}

function invalid(reasons: readonly ProvenanceMismatchReason[], message: string): ComparisonValidity {
  return { valid: false, authoritative: false, reasons, message };
}

function portableRelativePath(repoRoot: string, absolute: string): string {
  const relative = path.relative(repoRoot, absolute).replace(/\\/g, "/");
  return relative.startsWith("../") ? path.basename(absolute) : relative;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

function gitOrNull(cwd: string, args: readonly string[]): string | null {
  try {
    return git(cwd, args).trim() || null;
  } catch {
    return null;
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function isRegularFile(filePath: string): Promise<boolean> {
  return stat(filePath).then((value) => value.isFile()).catch(() => false);
}

function roundMs(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

interface TargetManifest {
  readonly instances: readonly { readonly instanceId: string; readonly repository: string; readonly baseCommit: string }[];
}

function parseTargetManifest(content: string): TargetManifest | null {
  try {
    const parsed = JSON.parse(content) as Partial<TargetManifest>;
    return Array.isArray(parsed.instances) ? { instances: parsed.instances } : null;
  } catch {
    return null;
  }
}

function collectIndexedSourceFingerprint(dbPath: string): string | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.query("SELECT path, content_hash AS contentHash, size_bytes AS sizeBytes FROM files ORDER BY path").all();
      if (rows.length === 0) return null;
      return hashStable(rows);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
