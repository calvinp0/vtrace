import path from "node:path";

import { formatSetupFlowResult } from "../formatters";
import { selectProgressReporter } from "../progress";
import {
  formatSetupJson,
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
import { runSetupFlow } from "../../runtime/setupFlow";

export async function runSetupCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  const parsed = parseSetupArgs(args);

  if ("error" in parsed) {
    return parsed.json
      ? failureJson(formatShellJsonFailure({
        command: "setup",
        message: parsed.error,
        nextSteps: ["Run `vtrace setup [repo] [--start-runtime] [--agent <name>] [--json] [--quiet|--no-progress]`."],
      }))
      : failure(parsed.error);
  }

  const resolvedOptions = resolveOptions(options);

  const progress = selectProgressReporter({
    stream: process.stderr,
    env: process.env,
    isJsonOutput: parsed.json,
    quiet: parsed.quiet,
  });

  try {
    const result = await runSetupFlow({
      repoPath: path.resolve(resolvedOptions.cwd, parsed.repoPath),
      cwd: resolvedOptions.cwd,
      startRuntime: parsed.startRuntime,
      agent: parsed.agent,
      onProgress: progress,
    });
    return parsed.json
      ? successJson(formatSetupJson(result))
      : success(formatSetupFlowResult(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return parsed.json
      ? failureJson(formatShellJsonFailure({
        command: "setup",
        message,
        nextSteps: ["Run `vtrace setup [repo]` from inside the repo, or pass the repo path explicitly."],
      }))
      : failure(formatUserFacingFailure(
        "Setup could not finish.",
        message,
        "Run `vtrace setup [repo]` from inside the repo, or pass the repo path explicitly.",
      ));
  }
}

function parseSetupArgs(
  args: readonly string[],
): {
  repoPath: string;
  startRuntime: boolean;
  json: boolean;
  quiet: boolean;
  agent?: string;
} | {
  error: string;
  json: boolean;
} {
  const usage =
    "Usage: setup [repo] [--start-runtime] [--agent <name>] [--json] [--quiet|--no-progress]";
  let repoPath = ".";
  let startRuntime = false;
  let json = false;
  let quiet = false;
  let agent: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--start-runtime") {
      startRuntime = true;
      continue;
    }

    if (argument === "--json") {
      json = true;
      continue;
    }

    if (argument === "--quiet" || argument === "--no-progress") {
      quiet = true;
      continue;
    }

    if (argument === "--agent") {
      agent = args[index + 1];

      if (typeof agent !== "string" || agent.startsWith("--")) {
        return { error: usage, json };
      }

      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      return { error: usage, json };
    }

    if (repoPath !== ".") {
      return { error: usage, json };
    }

    repoPath = argument;
  }

  return {
    repoPath,
    startRuntime,
    json,
    quiet,
    ...(agent === undefined ? {} : { agent }),
  };
}
