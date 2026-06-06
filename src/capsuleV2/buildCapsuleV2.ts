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
import {
  buildNoContextExplanations,
  collectIssueTokens,
  passthroughRoles,
  refineDebugRoles,
  type RefinedRoledCandidate,
} from "./debugRoles";
import { retrieveDocSections, type DocSection } from "./docRetrieval";
import {
  backfillProductionCandidates,
  isTestDominatedPool,
} from "./productionBackfill";
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
  type NoContextExplanation,
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

  let candidates = hybridRetrieve(input.db, {
    query: shaped.query,
    shaped,
    weights,
    symbolSeeds: deriveSymbolSeeds(shaped),
    maxResults: CANDIDATE_POOL_SIZE,
  }).candidates;

  // Production-candidate backfill (debug intent). A pool of only test symbols
  // means lexical search ranked the failing tests above the implementation they
  // exercise, so the real edit target never entered the pool. Recover it with
  // production-focused seeds (Class.method expansion + issue class/method names),
  // excluding tests, and merge those candidates ahead of the original pool.
  let productionBackfillUsed = false;
  let classMethodExpansionUsed = false;
  if (intent === CapsuleIntent.Debug && isTestDominatedPool(candidates)) {
    const backfill = backfillProductionCandidates({
      db: input.db,
      shaped,
      weights,
      task: input.task,
      issueTokens: collectIssueTokens(shaped),
      poolSize: CANDIDATE_POOL_SIZE,
    });
    if (backfill.candidates.length > 0) {
      productionBackfillUsed = true;
      classMethodExpansionUsed = backfill.classMethodExpansionUsed;
      candidates = mergeCandidatesPreferring(backfill.candidates, candidates, CANDIDATE_POOL_SIZE);
    }
  }

  // Role assignment. The base gate scores each candidate in isolation; for debug
  // intent we then refine roles with call-graph structure (caller vs helper,
  // local vs generic infrastructure) before capping pivots to the tier. Other
  // intents keep the base gate's own cap. Centrality never produces a pivot.
  let refined: RefinedRoledCandidate[];
  let subsystemRoot: string | undefined;
  let sourceBodyCallFallbackUsed = false;
  if (intent === CapsuleIntent.Debug) {
    const result = refineDebugRoles(
      input.db,
      assignCandidateRoles(candidates),
      shaped,
      allocation.maxPivots,
      { sourceTextOf: (symbolId) => loadFocusedSourceById(input.db, input.repoRoot, symbolId) },
    );
    refined = result.refined;
    subsystemRoot = result.subsystemRoot;
    sourceBodyCallFallbackUsed = result.sourceBodyCallFallbackUsed;
  } else {
    refined = passthroughRoles(assignCandidateRoles(candidates, { maxPivots: allocation.maxPivots }));
  }

  // Debug-intent recovery diagnostics, surfaced on both the success and
  // no-context paths so the production-target recovery is always auditable.
  const debugDiagnostics: Partial<CapsuleV2Result["diagnostics"]> =
    intent === CapsuleIntent.Debug
      ? {
          production_backfill_used: productionBackfillUsed,
          class_method_expansion_used: classMethodExpansionUsed,
          source_body_call_fallback_used: sourceBodyCallFallbackUsed,
          ...(subsystemRoot === undefined ? {} : { subsystem_root: subsystemRoot }),
        }
      : {};

  const pivotCandidates = refined.filter((r) => r.role === CandidateRole.Pivot);
  const supportCandidates = refined.filter((r) => r.role === CandidateRole.Support);
  const roleDiscards = refined.filter((r) => r.role === CandidateRole.Discard);

  // No high-confidence edit target: emit an intentionally empty capsule rather
  // than a vague support-only pile. The discards still report what was generated,
  // and the no-context explanations say precisely why nothing cleared the gate.
  if (pivotCandidates.length === 0) {
    return noContextResult({
      intent,
      intentReason,
      maxTokens: input.maxTokens,
      candidateCount: candidates.length,
      supportCount: supportCandidates.length,
      discarded: [
        ...supportCandidates.map((r) => toDiscarded(r, "support-only: no actionable edit target")),
        ...roleDiscards.map((r) => toDiscarded(r, r.roleReason)),
      ],
      weights: weightsRecord,
      shaped,
      explanations: buildNoContextExplanations(refined, shaped),
      debugDiagnostics,
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

  // Order support so the most edit-relevant context wins scarce support slots:
  // cap-demoted implementation helpers first, then ordinary local support, and
  // generic infrastructure last — a generic parser class must never outrank a
  // local helper (Problem B). Within a tier, higher final score wins. For
  // non-debug intents every signal is false, so this reduces to final order.
  const orderedSupport = [...supportCandidates].sort(
    (left, right) =>
      supportTier(left) - supportTier(right)
      || right.candidate.scores.final - left.candidate.scores.final,
  );

  for (const entry of orderedSupport) {
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
    discarded.push(toDiscarded(entry, entry.roleReason));
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
      ...debugDiagnostics,
    },
  };
}

// Support ordering tier: implementation helpers (edit sites that only missed the
// pivot budget) rank above ordinary support, which ranks above generic
// infrastructure. Lower number = higher priority.
function supportTier(entry: RefinedRoledCandidate): number {
  if (entry.signals.is_implementation_helper) {
    return 0;
  }
  if (entry.signals.is_generic_infrastructure) {
    return 2;
  }
  return 1;
}

// --- pivot/support rendering --------------------------------------------------

// Render a pivot, laddering content full -> signature -> skeleton until it fits
// the remaining budget. A forced (lead) pivot always renders at least a skeleton
// so the capsule never goes empty when a target exists.
function renderPivot(
  db: Database,
  repoRoot: string,
  entry: RefinedRoledCandidate,
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

  return firstFitting(entry, "pivot", evidence, ladder, remainingTokens, forced);
}

// Render a support item as a signature (or a skeleton when none is indexed).
// Support never carries a source body — that is what distinguishes it from a
// pivot. Dropped entirely when it does not fit the remaining budget.
function renderSupport(
  db: Database,
  repoRoot: string,
  entry: RefinedRoledCandidate,
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

  return firstFitting(entry, "support", evidence, ladder, remainingTokens, false);
}

// Pick the richest ladder rung whose rendered block fits the remaining budget.
// When `forced`, fall back to the cheapest rung even if it overflows, so a lead
// pivot is always emitted.
function firstFitting(
  entry: RefinedRoledCandidate,
  role: "pivot" | "support",
  evidence: string[],
  ladder: Array<{ mode: CapsuleV2ContentMode; source?: string; signature?: string }>,
  remainingTokens: number,
  forced: boolean,
): CapsuleV2Item | undefined {
  let cheapest: CapsuleV2Item | undefined;
  for (const rung of ladder) {
    const item = composeItem(entry, role, evidence, rung);
    if (item.estimated_tokens <= remainingTokens) {
      return item;
    }
    cheapest = item; // ladder is richest -> cheapest, so the last is the smallest.
  }
  return forced ? cheapest : undefined;
}

function composeItem(
  entry: RefinedRoledCandidate,
  role: "pivot" | "support",
  evidence: string[],
  rung: { mode: CapsuleV2ContentMode; source?: string; signature?: string },
): CapsuleV2Item {
  const candidate = entry.candidate;
  const item: CapsuleV2Item = {
    role,
    role_reason: entry.roleReason,
    is_entry_point: entry.signals.is_entry_point,
    is_implementation_helper: entry.signals.is_implementation_helper,
    is_generic_infrastructure: entry.signals.is_generic_infrastructure,
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
    role_reason: "relevant documentation section",
    is_entry_point: false,
    is_implementation_helper: false,
    is_generic_infrastructure: false,
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
  return loadFocusedSourceById(db, repoRoot, candidate.symbolId);
}

function loadFocusedSourceById(db: Database, repoRoot: string, symbolId: string): string | undefined {
  const result = loadSymbolSource(db, repoRoot, symbolId);
  const extracted = extractFullSymbolSource(result);
  return extracted.status === ExtractSymbolSourceStatus.Extracted ? extracted.source : undefined;
}

// Merge backfilled production candidates AHEAD of the original pool, deduped by
// symbol id and capped — so the recovered edit targets are never crowded out
// again by the test symbols that dominated the first pass.
function mergeCandidatesPreferring(
  preferred: readonly HybridCandidate[],
  rest: readonly HybridCandidate[],
  limit: number,
): HybridCandidate[] {
  const out: HybridCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of [...preferred, ...rest]) {
    if (seen.has(candidate.symbolId)) {
      continue;
    }
    seen.add(candidate.symbolId);
    out.push(candidate);
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

function loadSignature(db: Database, repoRoot: string, candidate: HybridCandidate): string | undefined {
  const result = loadSymbolSource(db, repoRoot, candidate.symbolId);
  return result.symbol?.signature;
}

// --- evidence shaping ---------------------------------------------------------

// A pivot leads with the role reason (the decisive reason it is an edit target —
// for debug intent this is the caller-vs-helper-vs-infra decision), then the
// candidate's own evidence lines, deduped and capped.
function pivotEvidence(entry: RefinedRoledCandidate): string[] {
  return dedupe([entry.roleReason, ...entry.candidate.evidence]).slice(0, MAX_PIVOT_EVIDENCE);
}

function supportEvidence(entry: RefinedRoledCandidate): string[] {
  return dedupe([entry.roleReason, ...entry.candidate.evidence]).slice(0, MAX_PIVOT_EVIDENCE);
}

// --- helpers ------------------------------------------------------------------

function toDiscarded(entry: RefinedRoledCandidate, reason: string): CapsuleV2Discarded {
  return {
    path: entry.candidate.filePath,
    symbol: entry.candidate.localName,
    kind: entry.candidate.kind,
    is_entry_point: entry.signals.is_entry_point,
    is_implementation_helper: entry.signals.is_implementation_helper,
    is_generic_infrastructure: entry.signals.is_generic_infrastructure,
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
  explanations: NoContextExplanation[];
  debugDiagnostics: Partial<CapsuleV2Result["diagnostics"]>;
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
      ...input.debugDiagnostics,
      ...(input.explanations.length > 0 ? { no_context_explanations: input.explanations } : {}),
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
