import path from "node:path";

import { formatProductShellStatus } from "../formatters";
import {
  formatProductShellStatusJson,
  formatShellJsonFailure,
} from "../shellJson";
import type { CliOptions, CommandResult } from "../types";
import {
  failure,
  failureJson,
  formatUserFacingFailure,
  resolveOptions,
  success,
  successJson,
} from "./helpers";
import { inspectProductShellStatus } from "../../runtime/status";

export async function runStatusCommand(
  args: readonly string[],
  options: CliOptions = {},
  mode: "status" | "doctor" = "status",
): Promise<CommandResult> {
  const parsed = parseStatusArgs(args, mode);

  if ("error" in parsed) {
    return parsed.json
      ? failureJson(formatShellJsonFailure({
        command: mode,
        message: parsed.error,
        nextSteps: [`Run \`vtrace ${mode} [repo] [--agent <name>] [--json]\`.`],
      }))
      : failure(parsed.error);
  }

  const resolvedOptions = resolveOptions(options);
  const repoPath = path.resolve(resolvedOptions.cwd, parsed.repoPath);

  try {
    const result = await inspectProductShellStatus({
      repoPath,
      cwd: resolvedOptions.cwd,
      agent: parsed.agent,
    });
    return parsed.json
      ? successJson(formatProductShellStatusJson(mode, result))
      : success(formatProductShellStatus(result, mode));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return parsed.json
      ? failureJson(formatShellJsonFailure({
        command: mode,
        message,
        nextSteps: [`Run \`vtrace ${mode} [repo]\` from inside the repo, or pass the repo path explicitly.`],
      }))
      : failure(formatUserFacingFailure(
        mode === "doctor" ? "Doctor could not inspect this repo." : "Status is unavailable.",
        message,
        `Run \`vtrace ${mode} [repo]\` from inside the repo, or pass the repo path explicitly.`,
      ));
  }
}

function parseStatusArgs(
  args: readonly string[],
  mode: "status" | "doctor",
): {
  repoPath: string;
  json: boolean;
  agent?: string;
} | {
  error: string;
  json: boolean;
} {
  let repoPath = ".";
  let json = false;
  let agent: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--json") {
      json = true;
      continue;
    }

    if (argument === "--agent") {
      agent = args[index + 1];

      if (typeof agent !== "string" || agent.startsWith("--")) {
        return { error: `Usage: ${mode} [repo] [--agent <name>] [--json]`, json };
      }

      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      return { error: `Usage: ${mode} [repo] [--agent <name>] [--json]`, json };
    }

    if (repoPath !== ".") {
      return { error: `Usage: ${mode} [repo] [--agent <name>] [--json]`, json };
    }

    repoPath = argument;
  }

  return {
    repoPath,
    json,
    ...(agent === undefined ? {} : { agent }),
  };
}
