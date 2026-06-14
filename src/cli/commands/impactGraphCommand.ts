// @ts-nocheck
import { openIndexerDatabase } from "../../db/sqlite";
import {
  IMPACT_FORMATS,
  getImpactGraph,
} from "../../impact/getImpactGraph";
import {
  buildContextAccounting,
  impactGraphOutputFilePathGroups,
} from "../../metrics/contextAccounting";
import { formatJson } from "../formatters";
import type { CliOptions, CommandResult } from "../types";
import {
  failure,
  resolveOptions,
  resolveRepoCommandPaths,
  success,
} from "./helpers";

export async function runImpactGraphCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  const parsed = parseImpactGraphArgs(args);

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
      const result = getImpactGraph(db, {
        symbolFqn: parsed.symbolFqn,
        depth: parsed.depth,
        format: parsed.format,
      });

      // JSON parity with the MCP get_impact_graph tool: attach the same
      // deterministic, best-effort accounting block to a successful result.
      // Accounting failure must never fail the command (best-effort, additive).
      if (result.ok) {
        try {
          const accounting = await buildContextAccounting({
            repoRoot: paths.repoRoot,
            emittedValue: result.output,
            filePathGroups: impactGraphOutputFilePathGroups(result.output),
            latencyMs: performance.now() - accountingStartedAt,
          });
          return success(formatJson({ ...result, output: { ...result.output, accounting } }));
        } catch {
          return success(formatJson(result));
        }
      }

      return success(formatJson(result));
    } finally {
      db.close();
    }
  } catch (error) {
    return failure(formatCommandError("impact-graph failed", error));
  }
}

function parseImpactGraphArgs(
  args: readonly string[],
): {
  repoPath: string;
  symbolFqn: string;
  depth: number;
  format: typeof IMPACT_FORMATS[number];
} | {
  error: string;
} {
  if (args.length < 2) {
    return { error: "Usage: impact-graph <repo> <symbol-fqn> [--depth <n>] [--format <list|tree|mermaid>]" };
  }

  let depth = 2;
  let format = "list" as const;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--depth") {
      const next = args[index + 1];
      const parsedDepth = typeof next === "string" ? Number.parseInt(next, 10) : Number.NaN;

      if (!Number.isInteger(parsedDepth) || parsedDepth < 0) {
        return { error: "Usage: impact-graph <repo> <symbol-fqn> [--depth <n>] [--format <list|tree|mermaid>]" };
      }

      depth = parsedDepth;
      index += 1;
      continue;
    }

    if (argument === "--format") {
      const next = args[index + 1];

      if (typeof next !== "string" || !IMPACT_FORMATS.includes(next as typeof IMPACT_FORMATS[number])) {
        return { error: "Usage: impact-graph <repo> <symbol-fqn> [--depth <n>] [--format <list|tree|mermaid>]" };
      }

      format = next as typeof IMPACT_FORMATS[number];
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      return { error: "Usage: impact-graph <repo> <symbol-fqn> [--depth <n>] [--format <list|tree|mermaid>]" };
    }

    positional.push(argument);
  }

  if (positional.length !== 2) {
    return { error: "Usage: impact-graph <repo> <symbol-fqn> [--depth <n>] [--format <list|tree|mermaid>]" };
  }

  return {
    repoPath: positional[0] as string,
    symbolFqn: positional[1] as string,
    depth,
    format,
  };
}

function formatCommandError(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}
