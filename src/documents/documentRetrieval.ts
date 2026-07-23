import type { Database } from "bun:sqlite";

import type { EmbeddedPathClue } from "../capsule/sweQueryShaping";
import { tokenize } from "../retrieval/hybridScoring";
import { matchPathClues, type PathClueMatch } from "../retrieval/pathScopedRelevance";
import { getDocumentChunk } from "../db/repositories/documentsRepository";
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

export function retrieveIndexedDocuments(
  db: Database,
  task: string,
  pathClues: readonly EmbeddedPathClue[] = [],
  maxFiles = MAX_FILES,
): DocumentRetrievalResult {
  const started = performance.now();
  if (!hasDocumentEvidence(task, pathClues)) {
    return { invoked: false, reason: "no_document_task_evidence", queryTerms: [], candidates: [], queryMs: 0 };
  }
  const queryTerms = distinctiveTerms(task);
  if (queryTerms.length === 0) {
    return { invoked: true, reason: "no_searchable_terms", queryTerms, candidates: [], queryMs: performance.now() - started };
  }
  const ftsQuery = queryTerms.map(quoteFts).join(" OR ");
  let rows: Array<{ chunk_id: string; file_path_raw: string; rank: number }>;
  try {
    rows = db.query(`
      SELECT chunk_id, file_path_raw, bm25(document_search_fts) AS rank
      FROM document_search_fts
      WHERE document_search_fts MATCH ?
      ORDER BY rank ASC, file_path_raw ASC, chunk_id ASC
      LIMIT ?
    `).all(ftsQuery, MAX_FTS_ROWS) as Array<{ chunk_id: string; file_path_raw: string; rank: number }>;
  } catch {
    return {
      invoked: true,
      reason: "document_index_unavailable",
      queryTerms,
      candidates: [],
      queryMs: performance.now() - started,
    };
  }

  const byPath = new Map<string, DocumentCandidate>();
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    const chunk = getDocumentChunk(db, row.chunk_id);
    if (chunk === undefined) continue;
    const haystackTokens = new Set(tokenize(`${chunk.path} ${chunk.keyPath ?? ""} ${chunk.text}`));
    const matchedTerms = queryTerms.filter((term) => haystackTokens.has(term));
    const pathMatches = matchPathClues(chunk.path, pathClues);
    const objectives = artifactObjectives(chunk.path, chunk.text, task);
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
  const ranked = [...byPath.values()]
    .filter((candidate) => candidate.matchedTerms.length >= 1 && (candidate.score >= 0.35 || candidate.pathMatches.length > 0))
    .sort((left, right) =>
      right.score - left.score
      || left.rawRank - right.rawRank
      || left.path.localeCompare(right.path));
  const candidates = diversifyArtifacts(ranked, Math.max(0, maxFiles));
  return {
    invoked: true,
    reason: candidates.length === 0 ? "no_relevant_document_candidates" : "document_task_evidence",
    queryTerms,
    candidates,
    queryMs: performance.now() - started,
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

function hasDocumentEvidence(task: string, pathClues: readonly EmbeddedPathClue[]): boolean {
  return /\b(?:ya?ml|toml|pyproject|workflow|github actions|ci|dependencies|pytest|configuration)\b/iu.test(task)
    || pathClues.some((clue) => /\.(?:ya?ml|toml)$/u.test(clue.normalized) || clue.normalized.includes(".github/workflows"));
}

function distinctiveTerms(task: string): string[] {
  return unique(tokenize(task)
    .filter((term) => term.length >= MIN_TOKEN_LENGTH && !QUERY_STOP.has(term)))
    .slice(0, 24);
}

function artifactObjectives(filePath: string, text: string, task: string): string[] {
  const value = `${filePath}\n${text}`.toLowerCase();
  const taskLower = task.toLowerCase();
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
