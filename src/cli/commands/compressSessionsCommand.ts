import { listIndexRuns } from "../../db/repositories/indexRunsRepository";
import { openIndexerDatabase } from "../../db/sqlite";
import { ProductStoreLease } from "../../session/sessionStore";
import {
  DEFAULT_SESSION_COMPRESSION_INACTIVE_AFTER_MS,
  compressInactiveSessions,
} from "../../observations/sessionLifecycle";
import type { CliOptions, CommandResult } from "../types";
import {
  failure,
  resolveOptions,
  resolveRepoCommandPaths,
  success,
} from "./helpers";

const MS_PER_HOUR = 60 * 60 * 1000;

const USAGE =
  "Usage: compress-sessions <repo> [--idle-hours N] [--limit N] [--dry-run] [--json]";

interface ParsedCompressSessionsArgs {
  readonly repo: string;
  readonly inactiveAfterMs: number;
  readonly idleHours: number | null;
  readonly limit?: number;
  readonly dryRun: boolean;
  readonly json: boolean;
}

export async function runCompressSessionsCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  if (args.length < 1) {
    return failure(USAGE);
  }

  let parsed: ParsedCompressSessionsArgs;
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
    const lease = new ProductStoreLease(db, resolvedRepo.dbPath);
    try {
      if (listIndexRuns(db).length === 0) {
        return failure(`Repo not indexed: ${resolvedRepo.repoRoot}`);
      }

      const result = compressInactiveSessions(lease.write, {
        repoRoot: resolvedRepo.repoRoot,
        nowMs: Date.now(),
        inactiveAfterMs: parsed.inactiveAfterMs,
        ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
        dryRun: parsed.dryRun,
      });

      const report = {
        repoRoot: resolvedRepo.repoRoot,
        dryRun: result.dryRun,
        idleHours: parsed.idleHours,
        inactiveAfterMs: parsed.inactiveAfterMs,
        limit: parsed.limit ?? null,
        eligibleSessionCount: result.eligibleSessionCount,
        processedSessionCount: result.processedSessionCount,
        compressedSessionCount: result.compressedSummaries.length,
        prunedToolCallObservationCount: result.compressedSummaries.reduce(
          (total, summary) => total + summary.prunedToolCallObservationCount,
          0,
        ),
        compressedSessionIds: result.compressedSummaries.map((summary) => summary.sessionId),
        cleanupCandidateCount: result.cleanupCandidates.length,
        previews: result.previews,
      };

      if (parsed.json) {
        return success(`${JSON.stringify(report)}\n`);
      }

      return success(formatReport(report));
    } finally {
      lease.close();
      db.close();
    }
  } catch (error) {
    return failure(`compress-sessions failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseArgs(args: readonly string[]): ParsedCompressSessionsArgs {
  const repo = args[0]!;
  let inactiveAfterMs = DEFAULT_SESSION_COMPRESSION_INACTIVE_AFTER_MS;
  let idleHours: number | null = null;
  let limit: number | undefined;
  let dryRun = false;
  let json = false;

  let cursor = 1;
  while (cursor < args.length) {
    const token = args[cursor]!;
    if (token === "--idle-hours") {
      const value = parseNonNegativeNumber(args[++cursor], "--idle-hours");
      idleHours = value;
      inactiveAfterMs = Math.round(value * MS_PER_HOUR);
    } else if (token === "--limit") {
      limit = parsePositiveInt(args[++cursor], "--limit");
    } else if (token === "--dry-run") {
      dryRun = true;
    } else if (token === "--json") {
      json = true;
    } else {
      throw new Error(`${USAGE}\nUnknown argument: ${token}`);
    }
    cursor += 1;
  }

  return {
    repo,
    inactiveAfterMs,
    idleHours,
    ...(limit === undefined ? {} : { limit }),
    dryRun,
    json,
  };
}

function formatReport(report: {
  dryRun: boolean;
  idleHours: number | null;
  eligibleSessionCount: number;
  processedSessionCount: number;
  compressedSessionCount: number;
  prunedToolCallObservationCount: number;
  compressedSessionIds: string[];
  cleanupCandidateCount: number;
  previews: readonly { sessionId: string; prunedToolCallObservationCount: number }[];
}): string {
  const lines: string[] = [];
  lines.push(report.dryRun
    ? "Session compression (dry run — no changes written):"
    : "Session compression:");
  lines.push(`  eligible sessions:     ${report.eligibleSessionCount}`);
  lines.push(`  processed (bounded):   ${report.processedSessionCount}`);

  if (report.dryRun) {
    const wouldPrune = report.previews.reduce(
      (total, preview) => total + preview.prunedToolCallObservationCount,
      0,
    );
    lines.push(`  would compress:        ${report.processedSessionCount}`);
    lines.push(`  would consolidate:     ${wouldPrune} repeated tool-call observations`);
    for (const preview of report.previews) {
      lines.push(`    - ${preview.sessionId} (${preview.prunedToolCallObservationCount} to consolidate)`);
    }
  } else {
    lines.push(`  compressed sessions:   ${report.compressedSessionCount}`);
    lines.push(`  consolidated obs:      ${report.prunedToolCallObservationCount}`);
    for (const sessionId of report.compressedSessionIds) {
      lines.push(`    - ${sessionId}`);
    }
  }

  lines.push(`  cleanup candidates:    ${report.cleanupCandidateCount}`);
  return `${lines.join("\n")}\n`;
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

function parseNonNegativeNumber(value: string | undefined, name: string): number {
  if (value === undefined) {
    throw new Error(`${name} requires a value`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}
