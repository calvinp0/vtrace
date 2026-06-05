import { buildCapsule, createSourceBackedCapsuleBuilder } from "../../capsule/buildCapsule";
import { createCharacterBudget } from "../../capsule/budget";
import {
  buildCapsuleDiagnostics,
  renderCompactCapsule,
  type CapsuleDiagnostics,
  type CapsuleSelectionDiagnostic,
} from "../../capsule/capsuleDiagnostics";
import {
  CapsuleMode,
  DEFAULT_CAPSULE_MODE,
  parseCapsuleMode,
  resolveCapsuleModeLimits,
} from "../../capsule/capsuleModes";
import { recoverMicroCapsule, type MicroCapsuleRecovery } from "../../capsule/microTargets";
import { CandidateRole, type RoledCandidate } from "../../capsule/assignCandidateRoles";
import {
  deriveModeSignals,
  recommendCapsuleMode,
  RecommendedCapsuleMode,
  TargetConfidence,
} from "../../capsule/recommendMode";
import { shapeSweQuery, type ShapedSweQuery } from "../../capsule/sweQueryShaping";
import {
  CapsuleInclusionReasonKind,
  type Capsule,
  type CapsuleInclusionReason,
  type CapsuleItem,
  type CapsuleSupportingCandidate,
} from "../../capsule/types";
import { prepareCapsuleAssembly } from "../../capsuleProfiles/orchestrator";
import { hasIndexedFiles } from "../../db/repositories/filesRepository";
import { openIndexerDatabase } from "../../db/sqlite";
import { routeQuery } from "../../intent/routeQuery";
import type { HybridCandidate } from "../../retrieval/hybridRetrieval";
import { GraphScoreSignal, type GraphSearchResult } from "../../retrieval/types";
import { formatCapsuleInspection, formatJson } from "../formatters";
import type { CliOptions, CommandResult } from "../types";
import {
  failure,
  resolveRepoCommandPaths,
  resolveOptions,
  success,
} from "./helpers";

const CAPSULE_USAGE =
  "Usage: capsule <repo> <query> [--mode <micro|standard|full>] [--max-items <n>] [--max-chars <n>] [--json]";

// Retained for callers (e.g. handoff) that build capsules without the capsule
// command's mode plumbing. Unchanged from the original capsule defaults so
// those callers keep their existing sizing.
export const CAPSULE_COMMAND_DEFAULTS = Object.freeze({
  maxBudgetCharacters: 2_000,
  maxResults: 6,
});

export async function runCapsuleCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  const parsed = parseCapsuleArgs(args);

  if ("error" in parsed) {
    return failure(parsed.error);
  }

  const resolvedOptions = resolveOptions(options);
  const { repoPath, query, mode, json } = parsed;
  const limits = resolveCapsuleModeLimits(mode, {
    ...(parsed.maxItems === undefined ? {} : { maxItems: parsed.maxItems }),
    ...(parsed.maxChars === undefined ? {} : { maxChars: parsed.maxChars }),
  });

  let resolvedRepo;

  try {
    resolvedRepo = await resolveRepoCommandPaths(resolvedOptions, repoPath);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }

  const repoRoot = resolvedRepo.repoRoot;

  if (!resolvedRepo.dbExists) {
    return failure(`Repo not indexed: ${repoRoot}`);
  }

  try {
    const db = openIndexerDatabase(resolvedRepo.dbPath);

    try {
      if (!hasIndexedFiles(db)) {
        return failure(`Repo not indexed: ${repoRoot}`);
      }

      const routedQuery = routeQuery(db, query, { maxResults: limits.maxItems });

      // Micro mode recovers the implementation edit target from the failing
      // test's symbols (via hybrid graph-expanded retrieval) so the tiny capsule
      // points at the code to change rather than the test (or nothing). Other
      // modes keep the routed candidates.
      const shaped = shapeSweQuery({ problemStatement: query });
      const recovery: MicroCapsuleRecovery | undefined = mode === CapsuleMode.Micro
        ? recoverMicroCapsule(db, shaped, { maxTargets: 1, poolSize: Math.max(limits.maxItems * 6, 12) })
        : undefined;

      // A micro capsule must point at a real target. If role assignment found no
      // high-confidence pivot, do NOT emit empty/misdirecting context — skip.
      if (recovery !== undefined && recovery.pivots.length === 0) {
        return emitMicroSkip(json);
      }

      // Micro: pivots are the recovered edit targets; support is the related
      // context (rendered skeleton-only), filling the remaining item budget.
      // Other modes keep the routed candidates (pivot + structural support).
      const pivotCandidates: readonly GraphSearchResult[] = recovery !== undefined
        ? recovery.pivots.map(hybridCandidateToGraphResult)
        : routedQuery.rerankedResults;
      const supportingCandidates: readonly CapsuleSupportingCandidate[] = recovery !== undefined
        ? recovery.support
          .slice(0, Math.max(0, limits.maxItems - pivotCandidates.length))
          .map(hybridCandidateToSupportingCandidate)
        : pivotCandidates.map(makeSupportingCandidateFromGraphResult);

      const preparedAssembly = prepareCapsuleAssembly({
        classification: routedQuery.classification,
        builderInput: {
          query,
          rerankedCandidates: pivotCandidates,
          supportingCandidates,
          maxBudget: createCharacterBudget(limits.maxChars),
        },
      });
      const capsule = buildCapsule(
        createSourceBackedCapsuleBuilder({ db, repoRoot }),
        preparedAssembly.builderInput,
      );

      const diagnostics = computeDiagnostics(query, mode, capsule, shaped, recovery);

      if (json) {
        const compact = renderCompactCapsule(capsule, {
          maxChars: limits.maxChars,
          reason: diagnostics.retrieval_reason,
        });
        // Diagnostics carry the actually-emitted context size.
        const emitted: CapsuleDiagnostics = {
          ...diagnostics,
          context_chars: compact.chars,
          context_items: compact.items,
        };
        return success(formatJson({ diagnostics: emitted, context: compact.text }));
      }

      return success(formatCapsuleInspection({
        routedQuery,
        capsuleProfileSelection: preparedAssembly.selection,
        capsule,
        diagnostics,
      }));
    } finally {
      db.close();
    }
  } catch (error) {
    return failure(formatCommandError("capsule failed", error));
  }
}

// Derive a recommendation by shaping the query as if it were an issue body. This
// is diagnostic only — the actual sizing follows the requested/default mode.
//
// When micro mode recovered concrete implementation targets, they take priority
// for likely_files/likely_symbols: a recovered impl file (e.g. aggregates.py) is
// a far better edit-target signal than the test file the shaping surfaced.
function computeDiagnostics(
  query: string,
  mode: CapsuleMode,
  capsule: Capsule,
  shaped: ShapedSweQuery,
  recovery: MicroCapsuleRecovery | undefined,
): CapsuleDiagnostics {
  const recommendation = recommendCapsuleMode(deriveModeSignals({ problemStatement: query }, shaped));

  const pivots = recovery?.pivots ?? [];
  const recoveredFiles = pivots.map((target) => target.filePath);
  const recoveredSymbols = pivots.map((target) => target.localName);
  const likelyFiles = recoveredFiles.length > 0 ? recoveredFiles : shaped.likelyFiles;
  const likelySymbols = recoveredSymbols.length > 0 ? recoveredSymbols : shaped.likelySymbols;

  // Per-item role + score breakdown + evidence. Prefer the role-assigned hybrid
  // candidates' full breakdown (micro); otherwise derive it from the assembled
  // capsule items so the diagnostics are present and uniformly shaped everywhere.
  const selection = recovery !== undefined
    ? selectionFromRoledCandidates(recovery.roled)
    : selectionFromCapsule(capsule);

  return buildCapsuleDiagnostics({
    mode,
    capsule,
    recommendation,
    actualMode: mode,
    ...(likelyFiles.length > 0 ? { likelyFiles } : {}),
    ...(likelySymbols.length > 0 ? { likelySymbols } : {}),
    ...(selection.length > 0 ? { selection } : {}),
  });
}

// Micro mode found no implementation target. Emit a skip recommendation with no
// context rather than a misleading empty capsule (Requirement 6). An empty
// likely_files/context here is honest precisely BECAUSE recommended_mode=skip.
function emitMicroSkip(json: boolean): CommandResult {
  const reason =
    "no high-confidence actionable target recovered — recommending skip rather than "
    + "emitting vague support-only or misdirecting context.";
  const diagnostics: CapsuleDiagnostics = {
    mode: CapsuleMode.Micro,
    context_chars: 0,
    context_items: 0,
    recommended_mode: RecommendedCapsuleMode.Skip,
    actual_mode: RecommendedCapsuleMode.Skip,
    target_confidence: TargetConfidence.Low,
    pivot_count: 0,
    support_count: 0,
    likely_files: [],
    likely_symbols: [],
    retrieval_reason: reason,
  };

  if (json) {
    return success(formatJson({ diagnostics, context: "" }));
  }
  return success(`micro: skip — ${reason}`);
}

function hybridCandidateToSupportingCandidate(
  candidate: HybridCandidate,
): CapsuleSupportingCandidate {
  return {
    symbolId: candidate.symbolId,
    filePath: candidate.filePath,
    fqName: candidate.fqName,
    localName: candidate.localName,
    kind: candidate.kind,
    lexicalScore: candidate.scores.lexical,
    graphScore: candidate.scores.graph,
    finalScore: candidate.scores.final,
    inclusionReasons: [
      {
        kind: CapsuleInclusionReasonKind.QueryCoverage,
        note: candidate.evidence[0] ?? "related context",
      },
    ],
  };
}

function hybridCandidateToGraphResult(candidate: HybridCandidate): GraphSearchResult {
  return {
    symbolId: candidate.symbolId,
    filePath: candidate.filePath,
    fqName: candidate.fqName,
    localName: candidate.localName,
    kind: candidate.kind,
    matches: candidate.matches,
    lexicalScore: candidate.scores.lexical,
    graphScore: candidate.scores.graph,
    finalScore: candidate.scores.final,
    graphContributions: [],
  };
}

// Role-assigned candidates (micro): emit each with its pivot/support role,
// the full scorecard (including the new bm25/testToImpl/graphProximity aliases),
// and the role's "why" as the leading evidence line so the report shows WHY a
// candidate is a pivot. Discards are omitted from the emitted selection.
function selectionFromRoledCandidates(
  roled: readonly RoledCandidate[],
): CapsuleSelectionDiagnostic[] {
  return roled
    .filter((entry) => entry.role !== CandidateRole.Discard)
    .map((entry) => {
      const target = entry.candidate;
      return {
        role: entry.role === CandidateRole.Pivot ? "pivot" as const : "support" as const,
        path: target.filePath,
        symbol: target.localName,
        scores: {
          lexical: target.scores.lexical,
          bm25: target.scores.bm25,
          path: target.scores.path,
          symbol: target.scores.symbol,
          testToImpl: target.scores.testToImpl,
          domain: target.scores.domain,
          graph: target.scores.graph,
          graphProximity: target.scores.graphProximity,
          centrality: target.scores.centrality,
          actionability: target.scores.actionability,
          local_evidence_score: target.scores.localEvidence,
          in_degree_or_dependent_count: target.scores.inDegree,
          hub_penalty: target.scores.hubPenalty,
          actionability_penalty: target.scores.actionabilityPenalty,
          final: target.scores.final,
        },
        evidence: [entry.why, ...target.evidence],
      };
    });
}

// Build a uniform selection breakdown from the assembled capsule items when no
// hybrid breakdown is available (non-micro modes). Role comes from the item's
// own role; the capsule carries lexical / graph / final, others default to 0.
function selectionFromCapsule(capsule: Capsule): CapsuleSelectionDiagnostic[] {
  const pivots = capsule.pivots.map((item) => roledSelectionItem(item, "pivot"));
  const support = capsule.supportingItems.map((item) => roledSelectionItem(item, "support"));
  return [...pivots, ...support];
}

function roledSelectionItem(
  item: CapsuleItem,
  role: "pivot" | "support",
): CapsuleSelectionDiagnostic {
  return {
    role,
    path: item.filePath,
    symbol: item.localName,
    scores: {
      lexical: item.lexicalScore ?? 0,
      bm25: 0,
      path: 0,
      symbol: 0,
      testToImpl: 0,
      domain: 0,
      graph: item.graphScore ?? 0,
      graphProximity: item.graphScore ?? 0,
      centrality: 0,
      actionability: 0,
      local_evidence_score: 0,
      in_degree_or_dependent_count: 0,
      hub_penalty: 0,
      actionability_penalty: 0,
      final: item.finalScore ?? 0,
    },
    evidence: inclusionReasonsToEvidence(item.inclusionReasons),
  };
}

function inclusionReasonsToEvidence(
  reasons: readonly CapsuleInclusionReason[],
): string[] {
  const evidence: string[] = [];
  for (const reason of reasons) {
    switch (reason.kind) {
      case CapsuleInclusionReasonKind.LexicalMatch:
        if (reason.matchedFields.length > 0) {
          evidence.push(`lexical match on ${reason.matchedFields.join(", ")}`);
        }
        break;
      case CapsuleInclusionReasonKind.GraphConnection:
        evidence.push(
          `graph connection: ${reason.graphSignals.map(graphSignalLabel).join(", ")}`,
        );
        break;
      case CapsuleInclusionReasonKind.StructuralSupport:
        evidence.push(`structural ${reason.edgeType} support`);
        break;
      case CapsuleInclusionReasonKind.QueryCoverage:
        evidence.push(reason.note);
        break;
      case CapsuleInclusionReasonKind.BudgetCompression:
        break;
    }
  }
  return evidence;
}

function graphSignalLabel(signal: GraphScoreSignal): string {
  return signal.replace(/_/g, " ");
}

interface ParsedCapsuleArgs {
  repoPath: string;
  query: string;
  mode: CapsuleMode;
  maxItems?: number;
  maxChars?: number;
  json: boolean;
}

function parseCapsuleArgs(
  args: readonly string[],
): ParsedCapsuleArgs | { error: string } {
  let mode: CapsuleMode = DEFAULT_CAPSULE_MODE;
  let maxItems: number | undefined;
  let maxChars: number | undefined;
  let json = false;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;

    if (argument === "--json") {
      json = true;
      continue;
    }

    if (argument === "--mode") {
      const next = args[index + 1];
      const resolved = typeof next === "string" ? parseCapsuleMode(next) : undefined;
      if (resolved === undefined) {
        return { error: CAPSULE_USAGE };
      }
      mode = resolved;
      index += 1;
      continue;
    }

    if (argument === "--max-items" || argument === "--max-chars") {
      const next = args[index + 1];
      const value = typeof next === "string" ? Number(next) : NaN;
      if (!Number.isInteger(value) || value < 0) {
        return { error: `${argument} requires a non-negative integer. ${CAPSULE_USAGE}` };
      }
      if (argument === "--max-items") {
        maxItems = value;
      } else {
        maxChars = value;
      }
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      return { error: `Unknown option ${argument}. ${CAPSULE_USAGE}` };
    }

    positional.push(argument);
  }

  if (positional.length < 2) {
    return { error: CAPSULE_USAGE };
  }

  const query = positional.slice(1).join(" ").trim();
  if (query.length === 0) {
    return { error: CAPSULE_USAGE };
  }

  return {
    repoPath: positional[0] as string,
    query,
    mode,
    ...(maxItems === undefined ? {} : { maxItems }),
    ...(maxChars === undefined ? {} : { maxChars }),
    json,
  };
}

function makeSupportingCandidateFromGraphResult(
  result: GraphSearchResult,
): CapsuleSupportingCandidate {
  return {
    symbolId: result.symbolId,
    filePath: result.filePath,
    fqName: result.fqName,
    localName: result.localName,
    kind: result.kind,
    lexicalScore: result.lexicalScore,
    graphScore: result.graphScore,
    finalScore: result.finalScore,
    inclusionReasons: buildInclusionReasonsFromGraphResult(result),
  };
}

function buildInclusionReasonsFromGraphResult(
  result: GraphSearchResult,
): CapsuleInclusionReason[] {
  const reasons: CapsuleInclusionReason[] = [
    {
      kind: CapsuleInclusionReasonKind.LexicalMatch,
      matchedFields: collectUniqueInOrder(result.matches.map((match) => match.field)),
    },
  ];
  const graphSignals = collectUniqueInOrder(result.graphContributions.map((contribution) => contribution.signal));
  const relatedSymbolIds = collectSortedUnique(
    result.graphContributions.flatMap((contribution) => contribution.relatedSymbolIds ?? []),
  );

  if (graphSignals.length > 0) {
    reasons.push({
      kind: CapsuleInclusionReasonKind.GraphConnection,
      graphSignals,
      ...(relatedSymbolIds.length === 0 ? {} : { relatedSymbolIds }),
    });
  }

  return reasons;
}

function collectUniqueInOrder<T>(values: readonly T[]): T[] {
  const uniqueValues: T[] = [];
  const seen = new Set<T>();

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    uniqueValues.push(value);
  }

  return uniqueValues;
}

function collectSortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function formatCommandError(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}
