// @ts-nocheck
import { openIndexerDatabase } from "../../db/sqlite";
import {
  buildContextAccounting,
  skeletonOutputFilePathGroups,
} from "../../metrics/contextAccounting";
import { formatJson } from "../formatters";
import type { CliOptions, CommandResult } from "../types";
import {
  failure,
  resolveOptions,
  resolveRepoCommandPaths,
  success,
} from "./helpers";
import {
  SKELETON_DETAIL_LEVELS,
  getSkeleton,
} from "../../skeleton/getSkeleton";

export async function runSkeletonCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  const parsed = parseSkeletonArgs(args);

  if ("error" in parsed) {
    return failure(parsed.error);
  }

  const resolvedOptions = resolveOptions(options);
  const paths = await resolveRepoCommandPaths(resolvedOptions, parsed.repoPath);

  if (!paths.dbExists) {
    return failure(
      `Index database not found for repo: ${paths.repoRoot}. Run \`vtrace setup ${paths.repoRoot}\` or \`vtrace index ${paths.repoRoot}\`.`,
    );
  }

  try {
    const db = openIndexerDatabase(paths.dbPath);

    try {
      const accountingStartedAt = performance.now();
      const output = await getSkeleton(db, {
        repoRoot: paths.repoRoot,
        files: [parsed.filePath],
        detail: parsed.detail,
      });

      // JSON parity with the MCP get_skeleton tool: attach the same deterministic,
      // best-effort accounting block. Accounting failure must never fail the
      // command (best-effort, additive).
      try {
        const accounting = await buildContextAccounting({
          repoRoot: paths.repoRoot,
          emittedValue: output,
          filePathGroups: skeletonOutputFilePathGroups(output),
          latencyMs: performance.now() - accountingStartedAt,
        });
        return success(formatJson({ ...output, accounting }));
      } catch {
        return success(formatJson(output));
      }
    } finally {
      db.close();
    }
  } catch (error) {
    return failure(formatCommandError("skeleton failed", error));
  }
}

function parseSkeletonArgs(
  args: readonly string[],
): {
  repoPath: string;
  filePath: string;
  detail: typeof SKELETON_DETAIL_LEVELS[number];
} | {
  error: string;
} {
  if (args.length < 2) {
    return { error: "Usage: skeleton <repo> <file> [--detail <minimal|standard|detailed>]" };
  }

  let detail = "standard" as const;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--detail") {
      const next = args[index + 1];

      if (typeof next !== "string" || !SKELETON_DETAIL_LEVELS.includes(next as typeof SKELETON_DETAIL_LEVELS[number])) {
        return { error: "Usage: skeleton <repo> <file> [--detail <minimal|standard|detailed>]" };
      }

      detail = next as typeof SKELETON_DETAIL_LEVELS[number];
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      return { error: "Usage: skeleton <repo> <file> [--detail <minimal|standard|detailed>]" };
    }

    positional.push(argument);
  }

  if (positional.length !== 2) {
    return { error: "Usage: skeleton <repo> <file> [--detail <minimal|standard|detailed>]" };
  }

  return {
    repoPath: positional[0] as string,
    filePath: positional[1] as string,
    detail,
  };
}

function formatCommandError(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}
