import { hasIndexedFiles } from "../../db/repositories/filesRepository";
import { openIndexerDatabase } from "../../db/sqlite";
import { formatRunPipelineOrchestrationOutput } from "../../runPipeline/formatRunPipelineOutput";
import { runPipelineOrchestrator } from "../../runPipeline/runPipelineOrchestrator";
import {
  RUN_PIPELINE_CONCRETE_PRESETS,
  RunPipelinePresetIntent,
} from "../../runPipeline/types";
import { isRunPipelinePresetIntent } from "../../runPipeline/selectIntent";
import type { CliOptions, CommandResult } from "../types";
import { failure, resolveOptions, resolveRepoCommandPaths, success } from "./helpers";

interface ParsedRunPipelineArgs {
  readonly repo: string;
  readonly query: string;
  readonly maxResults?: number;
  readonly maxBudgetCharacters?: number;
  readonly intent?: RunPipelinePresetIntent;
  readonly sessionId?: string;
  readonly includeMemory?: boolean;
}

export async function runRunPipelineCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  if (args.length < 2) {
    return failure(USAGE);
  }

  let parsed: ParsedRunPipelineArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
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

  try {
    const db = openIndexerDatabase(resolvedRepo.dbPath);
    try {
      if (!hasIndexedFiles(db)) {
        return failure(`Repo not indexed: ${resolvedRepo.repoRoot}`);
      }
      const orchestration = runPipelineOrchestrator(db, resolvedRepo.repoRoot, {
        query: parsed.query,
        ...(parsed.maxResults === undefined ? {} : { maxResults: parsed.maxResults }),
        ...(parsed.maxBudgetCharacters === undefined ? {} : { maxBudgetCharacters: parsed.maxBudgetCharacters }),
        ...(parsed.intent === undefined ? {} : { intent: parsed.intent }),
        ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
        ...(parsed.includeMemory === undefined ? {} : { includeMemory: parsed.includeMemory }),
      });
      const formatted = formatRunPipelineOrchestrationOutput(orchestration);
      return success(`${JSON.stringify(formatted)}\n`);
    } finally {
      db.close();
    }
  } catch (error) {
    return failure(`run-pipeline failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const USAGE = "Usage: run-pipeline <repo> <query> [--max-results N] [--max-budget-characters N] [--intent <auto|explore|debug|modify|refactor>] [--session-id ID] [--include-memory]";

function parseArgs(args: readonly string[]): ParsedRunPipelineArgs {
  const repo = args[0]!;
  const queryParts: string[] = [];
  let maxResults: number | undefined;
  let maxBudgetCharacters: number | undefined;
  let intent: RunPipelinePresetIntent | undefined;
  let sessionId: string | undefined;
  let includeMemory: boolean | undefined;

  let cursor = 1;
  while (cursor < args.length) {
    const token = args[cursor]!;
    if (token === "--max-results") {
      const value = parsePositiveInt(args[++cursor], "--max-results");
      maxResults = value;
    } else if (token === "--max-budget-characters" || token === "--max-budget") {
      const value = parsePositiveInt(args[++cursor], token);
      maxBudgetCharacters = value;
    } else if (token === "--intent") {
      const value = args[++cursor];
      if (value === undefined || !isRunPipelinePresetIntent(value)) {
        throw new Error(
          `--intent must be one of: ${[RunPipelinePresetIntent.Auto, ...RUN_PIPELINE_CONCRETE_PRESETS].join(", ")}`,
        );
      }
      intent = value;
    } else if (token === "--session-id") {
      const value = args[++cursor];
      if (value === undefined || value.length === 0) {
        throw new Error("--session-id requires a value");
      }
      sessionId = value;
    } else if (token === "--include-memory") {
      includeMemory = true;
    } else {
      queryParts.push(token);
    }
    cursor += 1;
  }

  const query = queryParts.join(" ").trim();
  if (query.length === 0) {
    throw new Error(USAGE);
  }

  return {
    repo,
    query,
    ...(maxResults === undefined ? {} : { maxResults }),
    ...(maxBudgetCharacters === undefined ? {} : { maxBudgetCharacters }),
    ...(intent === undefined ? {} : { intent }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(includeMemory === undefined ? {} : { includeMemory }),
  };
}

function parsePositiveInt(value: string | undefined, name: string): number {
  if (value === undefined) {
    throw new Error(`${name} requires a value`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
