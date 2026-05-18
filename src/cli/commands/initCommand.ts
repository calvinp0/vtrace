import path from "node:path";

import { initRepo } from "../../setup/initRepo";
import { formatInitResult } from "../formatters";
import { createCliProgressReporter, nullProgressReporter } from "../progress";
import type { CliOptions, CommandResult } from "../types";
import { failure, resolveOptions, success } from "./helpers";

export async function runInitCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  if (args.length !== 1) {
    return failure("Usage: init <repo>");
  }

  const resolvedOptions = resolveOptions(options);
  const repoPath = path.resolve(resolvedOptions.cwd, args[0] as string);
  const progress = process.env.VEXB_NO_PROGRESS === "1" || !process.stderr.isTTY
    ? nullProgressReporter
    : createCliProgressReporter({
      stream: process.stderr,
      isTTY: true,
    });

  try {
    const result = await initRepo({
      repoPath,
      cwd: resolvedOptions.cwd,
      onProgress: progress,
    });
    return success(formatInitResult(result));
  } catch (error) {
    return failure(formatCommandError("init failed", error));
  }
}

function formatCommandError(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}
