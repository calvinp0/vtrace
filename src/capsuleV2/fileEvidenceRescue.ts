// File-evidence deep-pool rescue (M100).
//
// WHY THIS EXISTS
// ----------------
// The M100 candidate-pool recall audit found that the dominant remaining
// pool-recall failure is NOT missing file-level indexing: the candidate pool
// cap counts SYMBOLS (25 symbols ≈ 9 distinct files), so 20 of the 31 gold
// files absent from the pool ARE reached by the existing organic generators at
// a deeper maxResults — they lose on file aggregation, never on text coverage
// (only 6/97 exact evidence hits sit outside indexed symbol bodies). At the
// same time, a PURE file-level evidence lane (exact issue-text literals
// resolved against raw repo file text) measured 3–8% gold — the derived task
// rarely carries a distinctive literal that lands in the right file at low
// ambiguity — and a rank-only deep rescue measured ≤1% gold with up to 23
// candidates per case (the M95-rejected broad-expansion failure mode).
//
// The only audited slice precise enough to ship is the INTERSECTION of the two
// weak signals: a credible SOURCE file that (a) the organic generators already
// retrieve at deep rank (≤ MAX_ORGANIC_RANK of a maxResults-400 pass), and
// (b) whose raw source text contains an exact, non-generic derived-task
// evidence term whose repo-wide file ambiguity is ≤ MAX_TERM_AMBIGUITY
// (`rank<=100 source ev<=3`: dev 1/2 gold, holdout 1/4 gold, ≤2 candidates per
// fired case). File-level evidence is the SELECTOR; the organic deep pool is
// the CANDIDATE SOURCE — the lane never synthesizes a path, resolves a guess,
// or admits a file retrieval could not reach on its own signals.
//
// Bounded and displacement-safe by construction:
//   - candidates are SUPPORT-only entries kept OUT of role refinement (the
//     graph-neighbour pattern), so the lead pivot and every organic role
//     decision are untouched;
//   - placement rides the M98 displacement contract (`orderSupportWithCoedit`):
//     a rescue may reclaim a duplicate-file / generic-infra / docs support slot
//     but never evicts a distinct new-file winner;
//   - ≤ MAX_RESCUED_FILES per capsule, and only into capsules whose distinct
//     base file count stays ≤ MAX_RESULTING_DISTINCT_FILES after rescue — the
//     deterministic overpacked label requires ≥6 files, so an overpack flip is
//     impossible by construction;
//   - a separate token ceiling (FILE_EVIDENCE_BUDGET_FRACTION of the capsule
//     budget) bounds the rendered cost.
//
// Repo-agnostic and deterministic: no instance ids, no per-repo rules; file
// contents are read from the same base-commit tree the index was built from
// (the M99 import-scan precedent). Gold patches are never an input.

import { readFileSync } from "node:fs";
import path from "node:path";

import type { Database } from "bun:sqlite";

import { CandidateRole } from "../capsule/assignCandidateRoles";
import type { ShapedSweQuery } from "../capsule/sweQueryShaping";
import { GENERIC_TOKEN_STOPLIST } from "../capsule/sweQueryShaping";
import { listAllFilePaths } from "../db/repositories/filesRepository";
import { extractBodyLiterals } from "../indexer/extractBodyLiterals";
import {
  type HybridRetrievalRequestCache,
  hybridRetrieve,
  HybridCandidateSource,
  type HybridCandidate,
} from "../retrieval/hybridRetrieval";
import type { HybridScoreWeights } from "../retrieval/hybridScoring";
import { isLikelyTestCandidate } from "../retrieval/searchSymbolsShared";
import type { RefinedRoledCandidate } from "./debugRoles";
import { NO_DEBUG_ROLE_SIGNALS } from "./types";
import { GENERIC_INFRA_TOKENS } from "./genericLexicalDecoy";
import { isGenericInfraFile, isVendoredOrGenerated } from "./graphNeighborAnchoring";
import { classifyNonSourceExample } from "./nonSourceExample";

/** Synthesized final for a rescued entry — support-strength, well below every
 * direct-evidence tier (mirrors the graph-neighbour lane's conservatism). */
export const FILE_EVIDENCE_RESCUE_FINAL = 0.35;
/** Cap on the rendered token share of rescued entries. */
export const FILE_EVIDENCE_BUDGET_FRACTION = 0.15;

// Depth of the second organic pass and the audited admission bounds. These are
// the exact gates the M100 gap audit measured (`rank<=100 source ev<=3`);
// loosening any of them was measured as noise (see the audit report).
const DEEP_POOL_SIZE = 400;
const MAX_ORGANIC_RANK = 100;
const MAX_TERM_AMBIGUITY = 3;
const MAX_RESCUED_FILES = 2;
/** A rescue never grows a capsule past this many distinct base files — the
 * deterministic overpacked label needs ≥6, so flips are impossible. */
const MAX_RESULTING_DISTINCT_FILES = 5;

const MIN_TERM_LENGTH = 4;
const MAX_TERM_LENGTH = 160;
/** Files larger than this are never scanned (size guard). */
const MAX_CONTENT_BYTES = 512 * 1024;

export type FileEvidenceShape =
  | "backticked_span"
  | "quoted_string"
  | "error_fragment"
  | "exception_name"
  | "code_token"
  | "snake_identifier"
  | "camel_identifier"
  | "dunder_identifier"
  | "dotted_path";

export interface FileEvidenceMention {
  readonly term: string;
  readonly shape: FileEvidenceShape;
}

export interface FileEvidenceRescueMatch {
  readonly path: string;
  readonly symbol: string;
  readonly symbolId: string;
  readonly term: string;
  readonly shape: FileEvidenceShape;
  /** Repo-wide count of files whose raw text contains the term (≤ cap). */
  readonly ambiguity: number;
  /** 1-based symbol rank of the file's best symbol in the deep organic pass. */
  readonly organicRank: number;
}

export interface FileEvidenceRescueResult {
  readonly fired: boolean;
  readonly mentions: FileEvidenceMention[];
  /** Deep-pool files that passed the cheap gates and were content-tested. */
  readonly consideredCount: number;
  readonly matches: FileEvidenceRescueMatch[];
  /** Support-only entries for the builder (never pivots, never role-refined). */
  readonly entries: RefinedRoledCandidate[];
  /** Files whose evidence term matched but exceeded the ambiguity cap. */
  readonly ambiguousRejectedCount: number;
  /** Mentions dropped by the generic stoplist at extraction time. */
  readonly genericRejectedCount: number;
  /** Files skipped by the content size guard. */
  readonly sizeRejectedCount: number;
  /** Qualifying files beyond the per-capsule / distinct-file caps. */
  readonly prunedCount: number;
  /** True when the lane never ran because the capsule is already at the
   * distinct-file guard (records WHY the lane stayed quiet). */
  readonly fileCapSkipped: boolean;
}

const EMPTY: FileEvidenceRescueResult = {
  fired: false,
  mentions: [],
  consideredCount: 0,
  matches: [],
  entries: [],
  ambiguousRejectedCount: 0,
  genericRejectedCount: 0,
  sizeRejectedCount: 0,
  prunedCount: 0,
  fileCapSkipped: false,
};

// Words too common to ever be file-level evidence alone. Union of the
// query-shaping stoplist and the generic-infra decoy tokens, plus capsule-wide
// generic vocabulary — matching is exact whole-term.
const GENERIC_EVIDENCE: ReadonlySet<string> = new Set([
  ...GENERIC_TOKEN_STOPLIST,
  ...GENERIC_INFRA_TOKENS,
  "field", "query", "model", "object", "type", "value", "request", "response",
  "parser", "manager", "handler", "error", "warning", "exception", "message",
  "default", "options", "instance", "example", "return", "import", "static",
  "none", "true", "false",
]);

// --- mention extraction ---------------------------------------------------------

interface Extraction {
  readonly mentions: FileEvidenceMention[];
  readonly rejectedGeneric: number;
}

/**
 * Extract the exact, code-shaped evidence terms from the task prose. The same
 * shapes the M100 audit swept: backticked spans, quoted strings, error
 * fragments, exception names, distinctive code tokens, snake/camel/dunder
 * identifiers, dotted paths. URLs are stripped; short and generic terms are
 * dropped. Terms are ordered strongest-shape-first and deduplicated.
 */
export function extractFileEvidenceMentions(task: string): Extraction {
  const text = task.replace(/\bhttps?:\/\/\S+/gi, " ");
  const mentions: FileEvidenceMention[] = [];
  const seen = new Set<string>();
  let rejectedGeneric = 0;

  const push = (raw: string, shape: FileEvidenceShape): void => {
    const term = raw.trim();
    if (term.length < MIN_TERM_LENGTH || term.length > MAX_TERM_LENGTH) return;
    if (GENERIC_EVIDENCE.has(term.toLowerCase())) {
      rejectedGeneric += 1;
      return;
    }
    const key = `${shape}|${term}`;
    if (seen.has(key)) return;
    seen.add(key);
    mentions.push({ term, shape });
  };

  for (const m of text.matchAll(/`([^`\n]{4,120})`/g)) push(m[1]!, "backticked_span");
  for (const m of text.matchAll(/(['"])((?:\\.|(?!\1).){6,160})\1/g)) push(m[2]!, "quoted_string");
  for (const m of text.matchAll(/\b([A-Z][A-Za-z]*(?:Error|Exception|Warning))\b(?::[ \t]*([^\n]{8,140}))?/g)) {
    push(m[1]!, "exception_name");
    if (m[2] !== undefined) push(m[2].replace(/["'`]+$/, ""), "error_fragment");
  }
  for (const lit of extractBodyLiterals(text)) {
    if (lit.kind === "code") push(lit.text, "code_token");
  }
  for (const m of text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
    if (m[0].length >= 6) push(m[0], "snake_identifier");
  }
  for (const m of text.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g)) push(m[0], "camel_identifier");
  for (const m of text.matchAll(/\b__\w{2,}__\b/g)) push(m[0], "dunder_identifier");
  for (const m of text.matchAll(/\b[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*){1,}\b/g)) {
    const segments = m[0].split(".");
    if (segments.length >= 2 && segments.every((s) => s.length >= 2)) push(m[0], "dotted_path");
  }

  return { mentions, rejectedGeneric };
}

// --- lane -----------------------------------------------------------------------

export interface FileEvidenceRescueInput {
  readonly db: Database;
  readonly repoRoot: string;
  readonly task: string;
  /** The same shaped query / weights / symbol seeds the organic retrieval ran
   * with, so the deep pass ranks with identical signals. */
  readonly shaped: ShapedSweQuery;
  readonly weights: HybridScoreWeights;
  readonly symbolSeeds: readonly string[];
  /** Every file path any candidate lane already holds (organic pool, co-edit,
   * graph neighbours) — a rescue must introduce a genuinely NEW file. */
  readonly poolFilePaths: ReadonlySet<string>;
  /** Distinct files across the pivots + the support winners that will render. */
  readonly baseDistinctFileCount: number;
  readonly taskAllowsNonSource: boolean;
  readonly requestCache?: HybridRetrievalRequestCache;
}

/**
 * Rescue up to MAX_RESCUED_FILES deep-pool source files whose raw source text
 * carries exact, low-ambiguity derived-task evidence. Pure with respect to the
 * index and the base-commit tree; never reads gold or benchmark data.
 */
export function rescueFileEvidenceSupport(input: FileEvidenceRescueInput): FileEvidenceRescueResult {
  const extraction = extractFileEvidenceMentions(input.task);
  if (extraction.mentions.length === 0) {
    return { ...EMPTY, genericRejectedCount: extraction.rejectedGeneric };
  }

  const rescueBudget = MAX_RESULTING_DISTINCT_FILES - input.baseDistinctFileCount;
  if (rescueBudget <= 0) {
    return {
      ...EMPTY,
      mentions: extraction.mentions,
      genericRejectedCount: extraction.rejectedGeneric,
      fileCapSkipped: true,
    };
  }
  const maxRescues = Math.min(MAX_RESCUED_FILES, rescueBudget);

  // Deep organic pass: the same generators and weights, ranked much deeper.
  // This re-ranks the same raw signal set — it can never surface a file the
  // organic generators cannot reach.
  const deep = hybridRetrieve(input.db, {
    query: input.shaped.query,
    shaped: input.shaped,
    taskText: input.task,
    weights: input.weights,
    symbolSeeds: [...input.symbolSeeds],
    maxResults: DEEP_POOL_SIZE,
    ...(input.requestCache === undefined ? {} : { requestCache: input.requestCache }),
  });

  // First (best-ranked) symbol per distinct file, in rank order.
  const bestByFile = new Map<string, { candidate: HybridCandidate; rank: number }>();
  deep.candidates.forEach((candidate, index) => {
    if (!bestByFile.has(candidate.filePath)) {
      bestByFile.set(candidate.filePath, { candidate, rank: index + 1 });
    }
  });

  // Lazy, size-guarded content reads over the indexed file list (the same
  // base-commit tree the index was built from).
  const allPaths = listAllFilePaths(input.db);
  const contentCache = new Map<string, string | null>();
  let sizeRejected = 0;
  const contentOf = (relPath: string): string | null => {
    const cached = contentCache.get(relPath);
    if (cached !== undefined) return cached;
    let content: string | null = null;
    try {
      const raw = readFileSync(path.join(input.repoRoot, relPath), "utf8");
      if (raw.length <= MAX_CONTENT_BYTES) {
        content = raw;
      } else {
        sizeRejected += 1;
      }
    } catch {
      content = null;
    }
    contentCache.set(relPath, content);
    return content;
  };

  // Repo-wide ambiguity of a term, early-stopped just past the cap: the lane
  // only needs "within the cap or not", never the exact hub count.
  const ambiguityCache = new Map<string, number>();
  const ambiguityOf = (term: string): number => {
    const cached = ambiguityCache.get(term);
    if (cached !== undefined) return cached;
    let count = 0;
    for (const p of allPaths) {
      if (!p.endsWith(".py")) continue;
      const content = contentOf(p);
      if (content === null || !content.includes(term)) continue;
      count += 1;
      if (count > MAX_TERM_AMBIGUITY) break;
    }
    ambiguityCache.set(term, count);
    return count;
  };

  const matches: FileEvidenceRescueMatch[] = [];
  const entries: RefinedRoledCandidate[] = [];
  let considered = 0;
  let ambiguousRejected = 0;
  let pruned = 0;

  for (const [filePath, { candidate, rank }] of bestByFile) {
    if (rank > MAX_ORGANIC_RANK) break; // rank order ⇒ nothing later qualifies
    if (input.poolFilePaths.has(filePath)) continue;
    if (!isCredibleRescueFile(filePath, candidate, input.taskAllowsNonSource)) continue;
    const content = contentOf(filePath);
    if (content === null) continue;
    considered += 1;

    let admitted: FileEvidenceRescueMatch | null = null;
    let sawAmbiguous = false;
    for (const mention of extraction.mentions) {
      if (!content.includes(mention.term)) continue;
      const ambiguity = ambiguityOf(mention.term);
      if (ambiguity > MAX_TERM_AMBIGUITY) {
        sawAmbiguous = true;
        continue;
      }
      admitted = {
        path: filePath,
        symbol: candidate.localName,
        symbolId: candidate.symbolId,
        term: mention.term,
        shape: mention.shape,
        ambiguity,
        organicRank: rank,
      };
      break;
    }
    if (admitted === null) {
      if (sawAmbiguous) ambiguousRejected += 1;
      continue;
    }
    if (entries.length >= maxRescues) {
      pruned += 1;
      continue;
    }
    matches.push(admitted);
    entries.push(buildRescueEntry(candidate, admitted));
  }

  if (matches.length === 0 && considered === 0 && ambiguousRejected === 0) {
    return {
      ...EMPTY,
      mentions: extraction.mentions,
      genericRejectedCount: extraction.rejectedGeneric,
      sizeRejectedCount: sizeRejected,
    };
  }
  return {
    fired: matches.length > 0,
    mentions: extraction.mentions,
    consideredCount: considered,
    matches,
    entries,
    ambiguousRejectedCount: ambiguousRejected,
    genericRejectedCount: extraction.rejectedGeneric,
    sizeRejectedCount: sizeRejected,
    prunedCount: pruned,
    fileCapSkipped: false,
  };
}

// A rescue candidate must be credible production source: never a test, a
// docs/example file (unless the task points at docs), a vendored/generated
// tree, a generic-infra giant, or a package `__init__` facade.
function isCredibleRescueFile(
  filePath: string,
  candidate: HybridCandidate,
  taskAllowsNonSource: boolean,
): boolean {
  if (!filePath.endsWith(".py")) return false;
  if (filePath.endsWith("/__init__.py") || filePath === "__init__.py") return false;
  if (isLikelyTestCandidate(candidate)) return false;
  if (!taskAllowsNonSource && classifyNonSourceExample(filePath).isNonSourceExample) return false;
  if (isVendoredOrGenerated(filePath)) return false;
  if (isGenericInfraFile(filePath)) return false;
  return true;
}

// The rescued entry keeps the candidate's identity but carries SYNTHESIZED
// support-strength scores: no direct evidence (so nothing downstream can
// mistake it for an anchor) and a final well below every organic tier. The
// honest signals — the deep organic rank and the exact evidence term — live in
// the evidence line and the diagnostics.
function buildRescueEntry(
  candidate: HybridCandidate,
  match: FileEvidenceRescueMatch,
): RefinedRoledCandidate {
  const evidence = `task literal \`${match.term}\` appears in this file's source `
    + `(exact match in ${match.ambiguity} repo file${match.ambiguity === 1 ? "" : "s"}; `
    + `organic retrieval rank ${match.organicRank}) (file-evidence rescue)`;
  const rescued: HybridCandidate = {
    ...candidate,
    scores: {
      lexical: 0,
      fts: 0,
      tfidf: 0,
      bm25: 0,
      symbol: 0,
      path: 0,
      testToImpl: 0,
      bodyLiteral: 0,
      domain: 0,
      graph: 0,
      graphProximity: 0,
      centrality: 0,
      actionability: candidate.scores.actionability,
      inDegree: 0,
      localEvidence: 0,
      hubPenalty: 0,
      actionabilityPenalty: 0,
      final: FILE_EVIDENCE_RESCUE_FINAL,
    },
    sources: [HybridCandidateSource.Lexical],
    evidence: [evidence],
    matches: [],
  };
  return {
    candidate: rescued,
    role: CandidateRole.Support,
    roleReason: evidence,
    signals: NO_DEBUG_ROLE_SIGNALS,
  };
}
