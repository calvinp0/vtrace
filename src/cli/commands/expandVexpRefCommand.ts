import { hasIndexedFiles } from "../../db/repositories/filesRepository";
import { openIndexerDatabase } from "../../db/sqlite";
import {
  DEFERRED_VEXP_HASH_PATTERN,
  DEFERRED_VEXP_SUPPORTED_CATEGORIES,
  getSharedDeferredVexpStore,
  isSupportedDeferredVexpCategory,
  isValidDeferredVexpHash,
} from "../../runPipeline/deferredVexpStore";
import { runPipelineOrchestrator } from "../../runPipeline/runPipelineOrchestrator";
import {
  RUN_PIPELINE_CONCRETE_PRESETS,
  RunPipelinePresetIntent,
} from "../../runPipeline/types";
import { isRunPipelinePresetIntent } from "../../runPipeline/selectIntent";
import type { CliOptions, CommandResult } from "../types";
import { failure, resolveOptions, resolveRepoCommandPaths, success } from "./helpers";

interface ParsedArgs {
  readonly repo: string;
  readonly hash: string;
  readonly query?: string;
  readonly sessionId?: string;
  readonly intent?: RunPipelinePresetIntent;
  readonly maxBudgetCharacters?: number;
  readonly includeMemory?: boolean;
}

/**
 * `vtrace expand-vexp-ref <repo> <hash> [--query <query>]` — expand a deferred
 * V-REF emitted by `run-pipeline`.
 *
 * Because the deferred V-REF store is process-local, the CLI re-invokes the
 * orchestrator with the original query (when supplied) to deterministically
 * republish the same hash, then resolves the requested hash. Without a query,
 * the command can only honor an unknown_hash response.
 */
export async function runExpandVexpRefCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  if (args.length < 2) {
    return failure(USAGE);
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }

  const requestedHash = parsed.hash;
  if (!isValidDeferredVexpHash(requestedHash)) {
    return success(
      `${JSON.stringify({
        requestedHash,
        resolved: false,
        reason: "malformed_hash",
        message: `expand-vexp-ref requires hash to be exactly 12 lowercase hex characters (pattern ${DEFERRED_VEXP_HASH_PATTERN}).`,
      })}\n`,
    );
  }

  let resolvedRepo;
  try {
    resolvedRepo = await resolveRepoCommandPaths(resolveOptions(options), parsed.repo);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }

  if (!resolvedRepo.dbExists) {
    return failure(`Repo not indexed: ${resolvedRepo.repoRoot}`);
  }

  const store = getSharedDeferredVexpStore();

  if (parsed.query !== undefined && parsed.query.length > 0) {
    try {
      const db = openIndexerDatabase(resolvedRepo.dbPath);
      try {
        if (!hasIndexedFiles(db)) {
          return failure(`Repo not indexed: ${resolvedRepo.repoRoot}`);
        }
        runPipelineOrchestrator(db, resolvedRepo.repoRoot, {
          query: parsed.query,
          ...(parsed.intent === undefined ? {} : { intent: parsed.intent }),
          ...(parsed.maxBudgetCharacters === undefined ? {} : { maxBudgetCharacters: parsed.maxBudgetCharacters }),
          ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
          ...(parsed.includeMemory === undefined ? {} : { includeMemory: parsed.includeMemory }),
        });
      } finally {
        db.close();
      }
    } catch (error) {
      return failure(`expand-vexp-ref failed during republish: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const entry = store.resolve(requestedHash);
  if (entry === null) {
    if (store.isExpired(requestedHash)) {
      return success(
        `${JSON.stringify({
          requestedHash,
          resolved: false,
          reason: "expired",
          message:
            "The deferred V-REF was previously known but is no longer available. Re-run run-pipeline to produce a fresh expandable V-REF.",
        })}\n`,
      );
    }
    return success(
      `${JSON.stringify({
        requestedHash,
        resolved: false,
        reason: "unknown_hash",
        message:
          "No deferred V-REF is registered under this hash. Use run-pipeline first; expand-vexp-ref only resolves hashes it has seen emitted.",
      })}\n`,
    );
  }

  if (!isSupportedDeferredVexpCategory(entry.category)) {
    return success(
      `${JSON.stringify({
        requestedHash,
        resolved: false,
        reason: "unsupported_category",
        message: `Deferred category '${entry.category}' is not supported. Supported: ${DEFERRED_VEXP_SUPPORTED_CATEGORIES.join(", ")}.`,
      })}\n`,
    );
  }

  return success(
    `${JSON.stringify({
      requestedHash,
      resolved: true,
      stableId: entry.stableId,
      category: entry.category,
      content: entry.content,
      metadata: entry.metadata,
      createdAtMs: entry.createdAtMs,
    })}\n`,
  );
}

const USAGE = "Usage: expand-vexp-ref <repo> <hash> [--query <query>] [--session-id ID] [--intent <auto|...>] [--max-budget-characters N] [--include-memory]";

function parseArgs(args: readonly string[]): ParsedArgs {
  const repo = args[0]!;
  const hash = args[1]!;
  let query: string | undefined;
  let sessionId: string | undefined;
  let intent: RunPipelinePresetIntent | undefined;
  let maxBudgetCharacters: number | undefined;
  let includeMemory: boolean | undefined;

  let cursor = 2;
  while (cursor < args.length) {
    const token = args[cursor]!;
    if (token === "--query") {
      const value = args[++cursor];
      if (value === undefined || value.length === 0) {
        throw new Error("--query requires a value");
      }
      query = value;
    } else if (token === "--session-id") {
      const value = args[++cursor];
      if (value === undefined || value.length === 0) {
        throw new Error("--session-id requires a value");
      }
      sessionId = value;
    } else if (token === "--intent") {
      const value = args[++cursor];
      if (value === undefined || !isRunPipelinePresetIntent(value)) {
        throw new Error(
          `--intent must be one of: ${[RunPipelinePresetIntent.Auto, ...RUN_PIPELINE_CONCRETE_PRESETS].join(", ")}`,
        );
      }
      intent = value;
    } else if (token === "--max-budget-characters" || token === "--max-budget") {
      const value = args[++cursor];
      const parsedNum = Number.parseInt(value ?? "", 10);
      if (!Number.isFinite(parsedNum) || parsedNum <= 0) {
        throw new Error(`${token} must be a positive integer`);
      }
      maxBudgetCharacters = parsedNum;
    } else if (token === "--include-memory") {
      includeMemory = true;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
    cursor += 1;
  }

  return {
    repo,
    hash,
    ...(query === undefined ? {} : { query }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(intent === undefined ? {} : { intent }),
    ...(maxBudgetCharacters === undefined ? {} : { maxBudgetCharacters }),
    ...(includeMemory === undefined ? {} : { includeMemory }),
  };
}
