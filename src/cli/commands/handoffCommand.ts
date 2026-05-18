import { buildCapsule, createSourceBackedCapsuleBuilder } from "../../capsule/buildCapsule";
import { createCharacterBudget } from "../../capsule/budget";
import {
  CapsuleInclusionReasonKind,
  type CapsuleInclusionReason,
  type CapsuleSupportingCandidate,
} from "../../capsule/types";
import { prepareCapsuleAssembly } from "../../capsuleProfiles/orchestrator";
import { hasIndexedFiles } from "../../db/repositories/filesRepository";
import { getLatestIndexRun } from "../../db/repositories/indexRunsRepository";
import { openIndexerDatabase } from "../../db/sqlite";
import {
  buildHandoffPayload,
  deterministicHandoffBuilder,
} from "../../handoff/buildHandoff";
import { routeQuery } from "../../intent/routeQuery";
import type { GraphSearchResult } from "../../retrieval/types";
import { formatHandoffPayload } from "../formatters";
import type { CliOptions, CommandResult } from "../types";
import {
  failure,
  resolveRepoCommandPaths,
  resolveOptions,
  success,
} from "./helpers";
import { CAPSULE_COMMAND_DEFAULTS } from "./capsuleCommand";

export async function runHandoffCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  if (args.length < 2) {
    return failure("Usage: handoff <repo> <query>");
  }

  const resolvedOptions = resolveOptions(options);
  const query = args.slice(1).join(" ").trim();

  if (query.length === 0) {
    return failure("Usage: handoff <repo> <query>");
  }

  let resolvedRepo;

  try {
    resolvedRepo = await resolveRepoCommandPaths(
      resolvedOptions,
      args[0] as string,
    );
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

      const routedQuery = routeQuery(db, query, {
        maxResults: CAPSULE_COMMAND_DEFAULTS.maxResults,
      });
      const preparedAssembly = prepareCapsuleAssembly({
        classification: routedQuery.classification,
        builderInput: {
          query,
          rerankedCandidates: routedQuery.rerankedResults,
          supportingCandidates: routedQuery.rerankedResults.map(makeSupportingCandidateFromGraphResult),
          maxBudget: createCharacterBudget(CAPSULE_COMMAND_DEFAULTS.maxBudgetCharacters),
        },
      });
      const capsule = buildCapsule(
        createSourceBackedCapsuleBuilder({ db, repoRoot }),
        preparedAssembly.builderInput,
      );
      const handoffPayload = buildHandoffPayload(deterministicHandoffBuilder, {
        pipeline: {
          routedQuery,
          capsuleProfileSelection: preparedAssembly.selection,
          capsule,
        },
        metadata: {
          repoRoot,
          sourceRunId: getLatestIndexRun(db)?.id ?? null,
        },
      });

      return success(formatHandoffPayload(handoffPayload));
    } finally {
      db.close();
    }
  } catch (error) {
    return failure(formatCommandError("handoff failed", error));
  }
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
