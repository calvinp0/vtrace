import { buildCapsule, createSourceBackedCapsuleBuilder } from "../../capsule/buildCapsule";
import { createCharacterBudget } from "../../capsule/budget";
import {
  buildCapsuleDiagnostics,
  renderCompactCapsule,
  type CapsuleDiagnostics,
} from "../../capsule/capsuleDiagnostics";
import {
  CapsuleMode,
  DEFAULT_CAPSULE_MODE,
  parseCapsuleMode,
  resolveCapsuleModeLimits,
  type CapsuleModeLimits,
} from "../../capsule/capsuleModes";
import { deriveModeSignals, recommendCapsuleMode } from "../../capsule/recommendMode";
import { shapeSweQuery } from "../../capsule/sweQueryShaping";
import {
  CapsuleInclusionReasonKind,
  type CapsuleInclusionReason,
  type CapsuleSupportingCandidate,
} from "../../capsule/types";
import { prepareCapsuleAssembly } from "../../capsuleProfiles/orchestrator";
import { hasIndexedFiles } from "../../db/repositories/filesRepository";
import { openIndexerDatabase } from "../../db/sqlite";
import { routeQuery } from "../../intent/routeQuery";
import type { GraphSearchResult } from "../../retrieval/types";
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
      const preparedAssembly = prepareCapsuleAssembly({
        classification: routedQuery.classification,
        builderInput: {
          query,
          rerankedCandidates: routedQuery.rerankedResults,
          supportingCandidates: routedQuery.rerankedResults.map(makeSupportingCandidateFromGraphResult),
          maxBudget: createCharacterBudget(limits.maxChars),
        },
      });
      const capsule = buildCapsule(
        createSourceBackedCapsuleBuilder({ db, repoRoot }),
        preparedAssembly.builderInput,
      );

      const diagnostics = computeDiagnostics(query, mode, capsule, limits);

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
function computeDiagnostics(
  query: string,
  mode: CapsuleMode,
  capsule: Parameters<typeof buildCapsuleDiagnostics>[0]["capsule"],
  _limits: CapsuleModeLimits,
): CapsuleDiagnostics {
  const shaped = shapeSweQuery({ problemStatement: query });
  const recommendation = recommendCapsuleMode(deriveModeSignals({ problemStatement: query }, shaped));

  return buildCapsuleDiagnostics({
    mode,
    capsule,
    recommendation,
    ...(shaped.likelyFiles.length > 0 ? { likelyFiles: shaped.likelyFiles } : {}),
    ...(shaped.likelySymbols.length > 0 ? { likelySymbols: shaped.likelySymbols } : {}),
  });
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
