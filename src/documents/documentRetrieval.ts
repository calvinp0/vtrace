import type { Database } from "bun:sqlite";

import type { EmbeddedPathClue } from "../capsule/sweQueryShaping";
import { tokenize } from "../retrieval/hybridScoring";
import {
  createPathRelevanceContext,
  matchPathCluesWithContext,
  type PathClueMatch,
  type PathRelevanceContext,
} from "../retrieval/pathScopedRelevance";
import {
  getDocumentChunks,
  searchDocumentChunkHits,
} from "../db/repositories/documentsRepository";
import type { DocumentKind } from "./documentPolicy";

const MAX_FTS_ROWS = 48;
const MAX_FILES = 4;
const MAX_EXCERPTS_PER_FILE = 2;
const MIN_TOKEN_LENGTH = 3;
const QUERY_STOP = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "add", "fix",
  "identify", "existing", "relevant", "requirements", "changes", "dedicated",
]);

export interface DocumentCandidate {
  path: string;
  kind: DocumentKind;
  score: number;
  rawRank: number;
  matchedTerms: string[];
  pathMatches: PathClueMatch[];
  objectiveMatches: string[];
  excerpts: Array<{
    chunkId: string;
    startLine: number;
    endLine: number;
    text: string;
    keyPath?: string;
    truncated: boolean;
  }>;
}

export interface DocumentRetrievalResult {
  invoked: boolean;
  reason: string;
  queryTerms: string[];
  candidates: DocumentCandidate[];
  queryMs: number;
}

export interface DocumentIntegrationProfile {
  timingsMs: Record<string, number>;
  counters: Record<string, number>;
  documentLane?: {
    attempted: boolean;
    reason: string;
    trigger?: string[];
  };
}

export interface DocumentRetrievalOptions {
  pathContext?: PathRelevanceContext;
  profile?: DocumentIntegrationProfile;
}

export function retrieveIndexedDocuments(
  db: Database,
  task: string,
  pathClues: readonly EmbeddedPathClue[] = [],
  maxFiles = MAX_FILES,
  options: DocumentRetrievalOptions = {},
): DocumentRetrievalResult {
  const started = options.profile === undefined ? 0 : performance.now();
  const relevanceStarted = options.profile === undefined ? 0 : performance.now();
  const triggers = documentEvidenceTriggers(task, pathClues);
  timedSince(options.profile, "document_relevance_detection", relevanceStarted);
  count(options.profile, "task_objectives", taskObjectiveCount(task, pathClues));
  if (triggers.length === 0) {
    if (options.profile !== undefined) {
      options.profile.documentLane = {
        attempted: false,
        reason: "no_supported_document_clue",
      };
    }
    return { invoked: false, reason: "no_document_task_evidence", queryTerms: [], candidates: [], queryMs: 0 };
  }
  if (options.profile !== undefined) {
    options.profile.documentLane = {
      attempted: true,
      reason: "supported_document_clue",
      trigger: triggers,
    };
  }
  const queryTerms = distinctiveTerms(task);
  if (queryTerms.length === 0) {
    return {
      invoked: true,
      reason: "no_searchable_terms",
      queryTerms,
      candidates: [],
      queryMs: elapsed(options.profile, started),
    };
  }
  const ftsQuery = queryTerms.map(quoteFts).join(" OR ");
  const ftsStarted = options.profile === undefined ? 0 : performance.now();
  let hits: ReturnType<typeof searchDocumentChunkHits>;
  try {
    hits = searchDocumentChunkHits(db, ftsQuery, MAX_FTS_ROWS);
  } catch {
    timedSince(options.profile, "document_fts_query", ftsStarted);
    return {
      invoked: true,
      reason: "document_index_unavailable",
      queryTerms,
      candidates: [],
      queryMs: elapsed(options.profile, started),
    };
  }
  timedSince(options.profile, "document_fts_query", ftsStarted);
  count(options.profile, "document_fts_queries", 1);
  count(options.profile, "document_fts_variants", 1);
  count(options.profile, "document_chunk_rows_returned", hits.length);

  const loadingStarted = options.profile === undefined ? 0 : performance.now();
  const chunks = getDocumentChunks(db, hits.map((hit) => hit.chunkId));
  timedSince(options.profile, "document_chunk_excerpt_loading", loadingStarted);
  count(options.profile, "document_chunk_batch_queries", hits.length === 0 ? 0 : 1);
  count(options.profile, "document_excerpts_loaded", chunks.size);
  count(
    options.profile,
    "document_bytes_loaded",
    [...chunks.values()].reduce((total, chunk) => total + Buffer.byteLength(chunk.text), 0),
  );

  const materializationStarted = options.profile === undefined ? 0 : performance.now();
  const pathContext = options.pathContext
    ?? createPathRelevanceContext(task, pathClues, options.profile);
  const taskLower = task.toLowerCase();
  const byPath = new Map<string, DocumentCandidate>();
  for (let rowIndex = 0; rowIndex < hits.length; rowIndex += 1) {
    const hit = hits[rowIndex]!;
    const chunk = chunks.get(hit.chunkId);
    if (chunk === undefined) continue;
    const haystackTokens = new Set(tokenize(`${chunk.path} ${chunk.keyPath ?? ""} ${chunk.text}`));
    const matchedTerms = queryTerms.filter((term) => haystackTokens.has(term));
    const pathMatches = matchPathCluesWithContext(chunk.path, pathContext);
    const objectiveStarted = options.profile === undefined ? 0 : performance.now();
    const objectives = artifactObjectives(chunk.path, chunk.text, taskLower);
    timedSince(options.profile, "objective_to_candidate_matching", objectiveStarted);
    count(options.profile, "candidate_objective_comparisons", 5);
    const lexical = matchedTerms.length / Math.max(1, queryTerms.length);
    const pathScore = pathMatches[0]?.score ?? 0;
    const objectiveScore = Math.min(1, objectives.length * 0.35);
    const score = lexical + pathScore * 1.25 + objectiveScore;
    const existing = byPath.get(chunk.path) ?? {
      path: chunk.path,
      kind: chunk.kind,
      score,
      rawRank: rowIndex + 1,
      matchedTerms: [],
      pathMatches,
      objectiveMatches: [],
      excerpts: [],
    };
    existing.score = Math.max(existing.score, score);
    existing.rawRank = Math.min(existing.rawRank, rowIndex + 1);
    existing.matchedTerms = unique([...existing.matchedTerms, ...matchedTerms]);
    existing.pathMatches = strongestPathMatches([...existing.pathMatches, ...pathMatches]);
    existing.objectiveMatches = unique([...existing.objectiveMatches, ...objectives]);
    if (existing.excerpts.length < MAX_EXCERPTS_PER_FILE) {
      existing.excerpts.push({
        chunkId: chunk.id,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text: chunk.text,
        ...(chunk.keyPath === undefined ? {} : { keyPath: chunk.keyPath }),
        truncated: chunk.truncated,
      });
    }
    byPath.set(chunk.path, existing);
  }
  timedSince(options.profile, "document_candidate_materialization", materializationStarted);
  count(options.profile, "document_candidates_materialized", byPath.size);
  const ranked = [...byPath.values()]
    .filter((candidate) => candidate.matchedTerms.length >= 1 && (candidate.score >= 0.35 || candidate.pathMatches.length > 0))
    .sort((left, right) =>
      right.score - left.score
      || left.rawRank - right.rawRank
      || left.path.localeCompare(right.path));
  count(options.profile, "candidate_sorts", 1);
  const candidates = diversifyArtifacts(ranked, Math.max(0, maxFiles));
  count(options.profile, "document_candidates_surviving_cap", candidates.length);
  count(options.profile, "document_files_eligible", byPath.size);
  timedSince(options.profile, "m128_integration_total", started);
  return {
    invoked: true,
    reason: candidates.length === 0 ? "no_relevant_document_candidates" : "document_task_evidence",
    queryTerms,
    candidates,
    queryMs: elapsed(options.profile, started),
  };
}

function diversifyArtifacts(ranked: readonly DocumentCandidate[], maxFiles: number): DocumentCandidate[] {
  const selected: DocumentCandidate[] = [];
  const take = (predicate: (candidate: DocumentCandidate) => boolean): void => {
    const candidate = ranked.find((item) => !selected.includes(item) && predicate(item));
    if (candidate !== undefined && selected.length < maxFiles) selected.push(candidate);
  };
  take((candidate) => candidate.objectiveMatches.includes("dependency_configuration")
    && /(^|\/)pyproject\.toml$/u.test(candidate.path));
  take((candidate) => candidate.objectiveMatches.includes("workflow"));
  for (const candidate of ranked) {
    if (selected.length >= maxFiles) break;
    if (!selected.includes(candidate)) selected.push(candidate);
  }
  return selected;
}

function documentEvidenceTriggers(task: string, pathClues: readonly EmbeddedPathClue[]): string[] {
  const triggers: string[] = [];
  if (/\b(?:ya?ml)\b/iu.test(task)) triggers.push("yaml_objective");
  if (/\btoml\b/iu.test(task)) triggers.push("toml_objective");
  if (/\bpyproject\b/iu.test(task)) triggers.push("project_configuration_objective");
  if (/\b(?:workflow|github actions|ci)\b/iu.test(task)) triggers.push("workflow_objective");
  if (/\b(?:dependencies|pytest|configuration)\b/iu.test(task)) triggers.push("project_configuration_objective");
  if (pathClues.some((clue) => /\.(?:ya?ml|toml)$/u.test(clue.normalized))) {
    triggers.push("explicit_document_filename");
  }
  if (pathClues.some((clue) => clue.normalized.includes(".github/workflows"))) {
    triggers.push("matching_document_path");
  }
  return unique(triggers);
}

function taskObjectiveCount(task: string, pathClues: readonly EmbeddedPathClue[]): number {
  const objectives = [
    /\b(?:workflow|github actions|ci|ya?ml)\b/iu.test(task),
    /\b(?:toml|pyproject|dependencies|configuration)\b/iu.test(task),
    /\b(?:pytest|full-suite|test command)\b/iu.test(task),
    /\bnotebook\b/iu.test(task),
    pathClues.length > 0,
  ];
  return objectives.filter(Boolean).length;
}

function distinctiveTerms(task: string): string[] {
  return unique(tokenize(task)
    .filter((term) => term.length >= MIN_TOKEN_LENGTH && !QUERY_STOP.has(term)))
    .slice(0, 24);
}

function artifactObjectives(filePath: string, text: string, taskLower: string): string[] {
  const value = `${filePath}\n${text}`.toLowerCase();
  const objectives: string[] = [];
  if (/(^|\/)\.github\/workflows\/|\.ya?ml$/u.test(filePath) && /workflow|github actions|ci/u.test(taskLower)) objectives.push("workflow");
  if (/pyproject\.toml$/u.test(filePath) && /dependenc|pytest|pyproject|notebook|test/u.test(taskLower)) objectives.push("dependency_configuration");
  if (/pytest|python -m pytest/u.test(value) && /pytest|full-suite|test/u.test(taskLower)) objectives.push("test_command");
  if (/notebook|jupyter|nbconvert/u.test(value) && /notebook/u.test(taskLower)) objectives.push("notebook_dependency");
  if (/clients\/python/u.test(value) && /clients\/python/u.test(taskLower)) objectives.push("path_scope");
  return objectives;
}

function quoteFts(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function strongestPathMatches(matches: readonly PathClueMatch[]): PathClueMatch[] {
  const byKey = new Map<string, PathClueMatch>();
  for (const match of matches) {
    const key = `${match.normalizedClue}:${match.matchType}`;
    const old = byKey.get(key);
    if (old === undefined || old.score < match.score) byKey.set(key, match);
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score || a.normalizedClue.localeCompare(b.normalizedClue));
}

function timedSince(
  profile: DocumentIntegrationProfile | undefined,
  name: string,
  started: number,
): void {
  if (profile !== undefined) {
    profile.timingsMs[name] = (profile.timingsMs[name] ?? 0) + performance.now() - started;
  }
}

function count(
  profile: DocumentIntegrationProfile | undefined,
  name: string,
  delta: number,
): void {
  if (profile !== undefined) {
    profile.counters[name] = (profile.counters[name] ?? 0) + delta;
  }
}

function elapsed(profile: DocumentIntegrationProfile | undefined, started: number): number {
  return profile === undefined ? 0 : performance.now() - started;
}
