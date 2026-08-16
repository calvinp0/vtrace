import { hasIndexedFiles } from "../../db/repositories/filesRepository";
import { openIndexerDatabase } from "../../db/sqlite";
import { ProductStoreLease } from "../../session/sessionStore";
import { formatRunPipelineOrchestrationOutput } from "../../runPipeline/formatRunPipelineOutput";
import { runPipelineOrchestrator } from "../../runPipeline/runPipelineOrchestrator";
import {
  RUN_PIPELINE_CONCRETE_PRESETS,
  RunPipelinePresetIntent,
} from "../../runPipeline/types";
import { isRunPipelinePresetIntent } from "../../runPipeline/selectIntent";
import { CapsuleIntent, parseCapsuleIntent } from "../../capsuleV2/types";
import {
  buildContextAccounting,
  runPipelineOutputFilePathGroups,
} from "../../metrics/contextAccounting";
import { resolveCapsuleCompatibility } from "../../capsuleV2/engineSelection";
import { assembleProductContext } from "../../productContext/assembleProductContext";
import { resolveCurrentObservationContext } from "../../observations/provenance";

// Hidden migration aliases. Current help does not advertise this flag;
// compatibility validation never changes the implementation.
const ACCEPTED_CAPSULE_ENGINES: readonly string[] = ["default", "v1", "v2", "legacy"];
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
  readonly capsuleEngine?: string;
  readonly capsuleIntent?: CapsuleIntent;
  readonly capsuleBudgetTokens?: number;
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
    resolveCapsuleCompatibility(parsed.capsuleEngine);
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
    const lease = new ProductStoreLease(db, resolvedRepo.dbPath);
    try {
      if (!hasIndexedFiles(db)) {
        return failure(`Repo not indexed: ${resolvedRepo.repoRoot}`);
      }
      const accountingStartedAt = performance.now();
      const currentObservationContext = await resolveCurrentObservationContext(resolvedRepo.repoRoot);
      const orchestration = runPipelineOrchestrator(lease.write, resolvedRepo.repoRoot, {
        query: parsed.query,
        ...(parsed.maxResults === undefined ? {} : { maxResults: parsed.maxResults }),
        ...(parsed.maxBudgetCharacters === undefined ? {} : { maxBudgetCharacters: parsed.maxBudgetCharacters }),
        ...(parsed.intent === undefined ? {} : { intent: parsed.intent }),
        ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
        ...(parsed.includeMemory === undefined ? {} : { includeMemory: parsed.includeMemory }),
        ...(parsed.capsuleEngine === undefined ? {} : { capsuleEngine: parsed.capsuleEngine }),
        ...(parsed.capsuleIntent === undefined ? {} : { capsuleIntent: parsed.capsuleIntent }),
        ...(parsed.capsuleBudgetTokens === undefined ? {} : { capsuleBudgetTokens: parsed.capsuleBudgetTokens }),
        currentObservationContext,
      });
      const formatted = formatRunPipelineOrchestrationOutput(orchestration);
      const productContext = await assembleProductContext({
        stores: lease.read,
        repoRoot: resolvedRepo.repoRoot,
        task: parsed.query,
        intent: parsed.capsuleIntent ?? CapsuleIntent.Auto,
        budgetTokens: parsed.capsuleBudgetTokens ?? 8_000,
        authoritativeRetrieval: orchestration.context.authoritativeRetrieval,
        ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
      });
      // Deterministic, best-effort accounting over the emitted response. Mirrors
      // the MCP run_pipeline path so the CLI and tool surfaces report the same
      // estimated compactness. Accounting failure must never fail the command.
      let withAccounting: unknown = formatted;
      try {
        const accounting = await buildContextAccounting({
          repoRoot: resolvedRepo.repoRoot,
          emittedValue: formatted,
          filePathGroups: runPipelineOutputFilePathGroups(formatted),
          latencyMs: performance.now() - accountingStartedAt,
        });
        withAccounting = {
          ...formatted,
          accounting,
          productContext,
        };
      } catch {
        withAccounting = {
          ...formatted,
          productContext,
        };
      }
      return success(`${JSON.stringify(withAccounting)}\n`);
    } finally {
      lease.close();
      db.close();
    }
  } catch (error) {
    return failure(`run-pipeline failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const USAGE = "Usage: run-pipeline <repo> <query> [--max-results N] [--max-budget-characters N] [--intent <auto|explore|debug|modify|refactor>] [--session-id ID] [--include-memory] [--capsule-intent <auto|debug|refactor|modify|explain|impact|test-failure>] [--capsule-budget-tokens N]";

function parseArgs(args: readonly string[]): ParsedRunPipelineArgs {
  const repo = args[0]!;
  const queryParts: string[] = [];
  let maxResults: number | undefined;
  let maxBudgetCharacters: number | undefined;
  let intent: RunPipelinePresetIntent | undefined;
  let sessionId: string | undefined;
  let includeMemory: boolean | undefined;
  let capsuleEngine: string | undefined;
  let capsuleIntent: CapsuleIntent | undefined;
  let capsuleBudgetTokens: number | undefined;

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
    } else if (token === "--capsule-engine") {
      const value = args[++cursor];
      const normalized = value?.toLowerCase();
      if (normalized === undefined || !ACCEPTED_CAPSULE_ENGINES.includes(normalized)) {
        throw new Error(`--capsule-engine must be one of: ${ACCEPTED_CAPSULE_ENGINES.join(", ")}`);
      }
      capsuleEngine = normalized;
    } else if (token === "--capsule-intent") {
      const value = args[++cursor];
      const parsedIntent = value === undefined ? undefined : parseCapsuleIntent(value);
      if (parsedIntent === undefined) {
        throw new Error("--capsule-intent must be one of: auto, debug, refactor, modify, explain, impact, test-failure");
      }
      capsuleIntent = parsedIntent;
    } else if (token === "--capsule-budget-tokens") {
      capsuleBudgetTokens = parsePositiveInt(args[++cursor], "--capsule-budget-tokens");
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
    ...(capsuleEngine === undefined ? {} : { capsuleEngine }),
    ...(capsuleIntent === undefined ? {} : { capsuleIntent }),
    ...(capsuleBudgetTokens === undefined ? {} : { capsuleBudgetTokens }),
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
