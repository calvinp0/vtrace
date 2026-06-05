// Capsule v2 orchestrator.
//
// The full product pipeline, in one deterministic, network-free pass:
//
//   task signals -> intent detection -> candidate generators -> evidence
//   scorecards -> pivot/support/discard roles -> budget allocator -> renderer
//
// Every stage is an existing, tested engine; this module is the orchestration
// that composes them into a bounded context capsule with explicit evidence,
// role assignment, and token-budget accounting. It hardcodes no benchmark
// instance ids and no file paths — the capsule is recovered from the index alone.

import type { Database } from "bun:sqlite";

import {
  assignCandidateRoles,
  CandidateRole,
  type RoledCandidate,
} from "../capsule/assignCandidateRoles";
import {
  extractFullSymbolSource,
  ExtractSymbolSourceStatus,
} from "../capsule/extractSymbolContent";
import { loadSymbolSource } from "../capsule/loadSymbolSource";
import { shapeSweQuery, type ShapedSweQuery } from "../capsule/sweQueryShaping";
import {
  hybridRetrieve,
  type HybridCandidate,
} from "../retrieval/hybridRetrieval";
import { allocateBudget } from "./budgetAllocator";
import { retrieveDocSections, type DocSection } from "./docRetrieval";
import { resolveIntent, weightsForIntent } from "./intent";
import { itemBlockText } from "./renderItem";
import { estimateTokens, roundPercent } from "./tokens";
import {
  CapsuleIntent,
  CapsuleV2ContentMode,
  CapsuleV2Mode,
  toScorecard,
  type CapsuleV2Discarded,
  type CapsuleV2Item,
  type CapsuleV2Result,
  type ResolvedCapsuleIntent,
} from "./types";

export interface BuildCapsuleV2Input {
  db: Database;
  repoRoot: string;
  /** The task / problem statement, as free prose. */
  task: string;
  /** Requested intent; `Auto` resolves from the task signals. */
  intent: CapsuleIntent;
  /** Token budget for the assembled capsule. */
  maxTokens: number;
}

// The candidate pool retrieval ranks before role assignment. Generous so the
// failing-test/graph routes can pull in a target lexical search alone missed;
// the budget allocator and role gate trim it back down.
const CANDIDATE_POOL_SIZE = 25;
// Cap on how many evidence lines a pivot carries — enough to justify the edit
// target without flooding the capsule.
const MAX_PIVOT_EVIDENCE = 6;

export function buildCapsuleV2(input: BuildCapsuleV2Input): CapsuleV2Result {
  const shaped = shapeSweQuery({
    problemStatement: input.task,
    failToPass: extractFailingTests(input.task),
  });
  const { intent, reason: intentReason } = resolveIntent(input.intent, input.task, shaped);
  const weights = weightsForIntent(intent);
  // A plain numeric record for the diagnostics surface (HybridScoreWeights has
  // fixed keys, so it is not directly a Record<string, number>).
  const weightsRecord: Record<string, number> = Object.fromEntries(Object.entries(weights));
  const allocation = allocateBudget(input.maxTokens);

  const { candidates } = hybridRetrieve(input.db, {
    query: shaped.query,
    shaped,
    weights,
    symbolSeeds: deriveSymbolSeeds(shaped),
    maxResults: CANDIDATE_POOL_SIZE,
  });

  // Role assignment caps pivots to the tier; extras demote to support. The bar
  // is the same across tiers (actionable kind + strong direct evidence + no
  // generic hub) — centrality alone never produces a pivot.
  const roled = assignCandidateRoles(candidates, { maxPivots: allocation.maxPivots });
  const pivotCandidates = roled.filter((r) => r.role === CandidateRole.Pivot);
  const supportCandidates = roled.filter((r) => r.role === CandidateRole.Support);
  const roleDiscards = roled.filter((r) => r.role === CandidateRole.Discard);

  // No high-confidence edit target: emit an intentionally empty capsule rather
  // than a vague support-only pile. The discards still report what was generated
  // and why nothing cleared the pivot bar.
  if (pivotCandidates.length === 0) {
    return noContextResult({
      intent,
      intentReason,
      maxTokens: input.maxTokens,
      candidateCount: candidates.length,
      supportCount: supportCandidates.length,
      discarded: [
        ...supportCandidates.map((r) => toDiscarded(r, "support-only: no actionable edit target")),
        ...roleDiscards.map((r) => toDiscarded(r, r.why)),
      ],
      weights: weightsRecord,
      shaped,
    });
  }

  // Greedy budget fill: pivots first (focused source, laddered down to fit),
  // then support (signatures), counting each item by the exact text it renders.
  const pivots: CapsuleV2Item[] = [];
  const support: CapsuleV2Item[] = [];
  const discarded: CapsuleV2Discarded[] = [];
  let usedTokens = 0;

  pivotCandidates.forEach((entry, index) => {
    // The lead pivot is guaranteed (a capsule must name a target); later pivots
    // that cannot fit even a skeleton drop to the discard list.
    const forced = index === 0;
    const item = renderPivot(input.db, input.repoRoot, entry, input.maxTokens - usedTokens, forced);
    if (item === undefined) {
      discarded.push(toDiscarded(entry, "over budget: no room for this pivot"));
      return;
    }
    usedTokens += item.estimated_tokens;
    pivots.push(item);
  });

  for (const entry of supportCandidates) {
    if (support.length >= allocation.maxSupport) {
      discarded.push(toDiscarded(entry, `beyond ${allocation.tier} support budget (max ${allocation.maxSupport})`));
      continue;
    }
    const item = renderSupport(input.db, input.repoRoot, entry, input.maxTokens - usedTokens);
    if (item === undefined) {
      discarded.push(toDiscarded(entry, "over budget: no room for this support item"));
      continue;
    }
    usedTokens += item.estimated_tokens;
    support.push(item);
  }

  // Documentation candidate source: query-relevant markdown sections fill any
  // remaining SUPPORT budget as summaries (never pivots — docs are not edit
  // targets). Code support takes priority, so docs are added last.
  if (support.length < allocation.maxSupport) {
    const docs = retrieveDocSections(input.repoRoot, shaped.query, allocation.maxSupport - support.length);
    for (const doc of docs) {
      const item = composeDocItem(doc);
      if (usedTokens + item.estimated_tokens > input.maxTokens) {
        continue;
      }
      usedTokens += item.estimated_tokens;
      support.push(item);
    }
  }

  for (const entry of roleDiscards) {
    discarded.push(toDiscarded(entry, entry.why));
  }

  return {
    intent,
    actual_mode: allocation.tier,
    budget: {
      max_tokens: input.maxTokens,
      estimated_tokens: usedTokens,
      used_percent: input.maxTokens > 0 ? roundPercent((usedTokens / input.maxTokens) * 100) : 0,
    },
    pivots,
    support,
    discarded,
    diagnostics: {
      intent_reason: intentReason,
      candidate_count: candidates.length,
      pivot_count: pivots.length,
      support_count: support.length,
      discarded_count: discarded.length,
      tier: allocation.tier,
      weights: weightsRecord,
      likely_files: shaped.likelyFiles,
      likely_symbols: shaped.likelySymbols,
      failing_tests: shaped.failingTests,
    },
  };
}

// --- pivot/support rendering --------------------------------------------------

// Render a pivot, laddering content full -> signature -> skeleton until it fits
// the remaining budget. A forced (lead) pivot always renders at least a skeleton
// so the capsule never goes empty when a target exists.
function renderPivot(
  db: Database,
  repoRoot: string,
  entry: RoledCandidate,
  remainingTokens: number,
  forced: boolean,
): CapsuleV2Item | undefined {
  const candidate = entry.candidate;
  const evidence = pivotEvidence(entry);
  const source = loadFocusedSource(db, repoRoot, candidate);
  const signature = loadSignature(db, repoRoot, candidate);

  const ladder: Array<{ mode: CapsuleV2ContentMode; source?: string; signature?: string }> = [];
  if (source !== undefined) {
    ladder.push({ mode: CapsuleV2ContentMode.Full, source, ...(signature ? { signature } : {}) });
  }
  if (signature !== undefined) {
    ladder.push({ mode: CapsuleV2ContentMode.Signature, signature });
  }
  ladder.push({ mode: CapsuleV2ContentMode.Skeleton });

  return firstFitting(candidate, "pivot", evidence, ladder, remainingTokens, forced);
}

// Render a support item as a signature (or a skeleton when none is indexed).
// Support never carries a source body — that is what distinguishes it from a
// pivot. Dropped entirely when it does not fit the remaining budget.
function renderSupport(
  db: Database,
  repoRoot: string,
  entry: RoledCandidate,
  remainingTokens: number,
): CapsuleV2Item | undefined {
  const candidate = entry.candidate;
  const evidence = supportEvidence(entry);
  const signature = loadSignature(db, repoRoot, candidate);

  const ladder: Array<{ mode: CapsuleV2ContentMode; signature?: string }> = [];
  if (signature !== undefined) {
    ladder.push({ mode: CapsuleV2ContentMode.Signature, signature });
  }
  ladder.push({ mode: CapsuleV2ContentMode.Skeleton });

  return firstFitting(candidate, "support", evidence, ladder, remainingTokens, false);
}

// Pick the richest ladder rung whose rendered block fits the remaining budget.
// When `forced`, fall back to the cheapest rung even if it overflows, so a lead
// pivot is always emitted.
function firstFitting(
  candidate: HybridCandidate,
  role: "pivot" | "support",
  evidence: string[],
  ladder: Array<{ mode: CapsuleV2ContentMode; source?: string; signature?: string }>,
  remainingTokens: number,
  forced: boolean,
): CapsuleV2Item | undefined {
  let cheapest: CapsuleV2Item | undefined;
  for (const rung of ladder) {
    const item = composeItem(candidate, role, evidence, rung);
    if (item.estimated_tokens <= remainingTokens) {
      return item;
    }
    cheapest = item; // ladder is richest -> cheapest, so the last is the smallest.
  }
  return forced ? cheapest : undefined;
}

function composeItem(
  candidate: HybridCandidate,
  role: "pivot" | "support",
  evidence: string[],
  rung: { mode: CapsuleV2ContentMode; source?: string; signature?: string },
): CapsuleV2Item {
  const item: CapsuleV2Item = {
    role,
    path: candidate.filePath,
    fq_name: candidate.fqName,
    symbol: candidate.localName,
    kind: candidate.kind,
    content_mode: rung.mode,
    ...(rung.source === undefined ? {} : { source: rung.source }),
    ...(rung.signature === undefined ? {} : { signature: rung.signature }),
    evidence,
    scorecard: toScorecard(candidate.scores),
    estimated_tokens: 0,
  };
  item.estimated_tokens = estimateTokens(itemBlockText(item));
  return item;
}

// Kind label for a retrieved documentation section (not a code symbol kind).
const MARKDOWN_SECTION_KIND = "markdown_section";

// Compose a support item from a documentation section: a summary under a
// signature-style block, with a synthesised scorecard (lexical overlap only —
// docs carry no symbol/graph signals). Always support, never a pivot.
function composeDocItem(doc: DocSection): CapsuleV2Item {
  const item: CapsuleV2Item = {
    role: "support",
    path: doc.filePath,
    fq_name: `${doc.filePath}#${doc.heading}`,
    symbol: doc.heading,
    kind: MARKDOWN_SECTION_KIND,
    content_mode: CapsuleV2ContentMode.Signature,
    signature: doc.summary,
    evidence: [`markdown section "${doc.heading}" matches: ${doc.matchedTerms.join(", ")}`],
    scorecard: {
      lexical: doc.score,
      symbol: 0,
      path: 0,
      test_to_impl: 0,
      graph_proximity: 0,
      centrality: 0,
      actionability: 0,
      hub_penalty: 0,
      final: doc.score,
    },
    estimated_tokens: 0,
  };
  item.estimated_tokens = estimateTokens(itemBlockText(item));
  return item;
}

// --- source/signature loading -------------------------------------------------

function loadFocusedSource(db: Database, repoRoot: string, candidate: HybridCandidate): string | undefined {
  const result = loadSymbolSource(db, repoRoot, candidate.symbolId);
  const extracted = extractFullSymbolSource(result);
  return extracted.status === ExtractSymbolSourceStatus.Extracted ? extracted.source : undefined;
}

function loadSignature(db: Database, repoRoot: string, candidate: HybridCandidate): string | undefined {
  const result = loadSymbolSource(db, repoRoot, candidate.symbolId);
  return result.symbol?.signature;
}

// --- evidence shaping ---------------------------------------------------------

// A pivot leads with the role "why" (the decisive reason it is an edit target),
// then the candidate's own evidence lines, deduped and capped.
function pivotEvidence(entry: RoledCandidate): string[] {
  const why = stripRolePrefix(entry.why);
  return dedupe([why, ...entry.candidate.evidence]).slice(0, MAX_PIVOT_EVIDENCE);
}

function supportEvidence(entry: RoledCandidate): string[] {
  return dedupe([stripRolePrefix(entry.why), ...entry.candidate.evidence]).slice(0, MAX_PIVOT_EVIDENCE);
}

// Drop the leading "pivot: " / "support: " label the role assignment prepends —
// the bullet already conveys the role, so the reason line need not repeat it.
function stripRolePrefix(why: string): string {
  return why.replace(/^(pivot|support|discard):\s*/i, "");
}

// --- helpers ------------------------------------------------------------------

function toDiscarded(entry: RoledCandidate, reason: string): CapsuleV2Discarded {
  return {
    path: entry.candidate.filePath,
    symbol: entry.candidate.localName,
    kind: entry.candidate.kind,
    scorecard: toScorecard(entry.candidate.scores),
    evidence: [...entry.candidate.evidence],
    discard_reason: reason,
  };
}

interface NoContextInput {
  intent: ResolvedCapsuleIntent;
  intentReason: string;
  maxTokens: number;
  candidateCount: number;
  supportCount: number;
  discarded: CapsuleV2Discarded[];
  weights: Record<string, number>;
  shaped: ShapedSweQuery;
}

function noContextResult(input: NoContextInput): CapsuleV2Result {
  return {
    intent: input.intent,
    actual_mode: CapsuleV2Mode.NoContext,
    reason: "no high-confidence edit target recovered",
    budget: { max_tokens: input.maxTokens, estimated_tokens: 0, used_percent: 0 },
    pivots: [],
    support: [],
    discarded: input.discarded,
    diagnostics: {
      intent_reason: input.intentReason,
      candidate_count: input.candidateCount,
      pivot_count: 0,
      support_count: 0,
      discarded_count: input.discarded.length,
      tier: CapsuleV2Mode.NoContext,
      weights: input.weights,
      likely_files: input.shaped.likelyFiles,
      likely_symbols: input.shaped.likelySymbols,
      failing_tests: input.shaped.failingTests,
    },
  };
}

// Symbol seeds beyond the shaped likely-symbols: the SUBJECT of each failing
// test class (AggregateTestCase -> Aggregate), which usually names the
// implementation directly, plus the issue identifiers that are not test names.
function deriveSymbolSeeds(shaped: ShapedSweQuery): string[] {
  const seeds: string[] = [];
  for (const identifier of shaped.identifiers) {
    if (/Test/.test(identifier) && /^[A-Z]/.test(identifier)) {
      const subject = identifier.replace(/^Test(?=[A-Z])/, "").replace(/(?:TestCase|Tests|Test)$/, "");
      if (subject.length >= 3) {
        seeds.push(subject);
      }
    } else if (!/^test[_A-Z]/.test(identifier)) {
      seeds.push(identifier);
    }
  }
  return dedupe(seeds);
}

// Extract failing-test node ids from free task prose so `shapeSweQuery` can route
// the failing test to its implementation. Recognises pytest ("a/b/test_x.py::
// TestY::test_z") and Django dotted ("a.b.TestY.test_z") shapes.
function extractFailingTests(task: string): string[] {
  const ids = new Set<string>();
  for (const match of task.matchAll(/\b[\w./-]+\.py::[\w:]+/g)) {
    ids.add(match[0]);
  }
  for (const match of task.matchAll(/\b[\w.]+\.[A-Z]\w*\.test_\w+\b/g)) {
    ids.add(match[0]);
  }
  return [...ids];
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
