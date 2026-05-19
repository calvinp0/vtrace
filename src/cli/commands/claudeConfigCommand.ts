import path from "node:path";

import { detectRepoRoot } from "../../setup/repoState";
import { resolveProductShellAgent } from "../../runtime/agents";
import { formatClaudeCodeConfigResult } from "../formatters";
import {
  formatAgentConfigInstallJson,
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

export async function runClaudeConfigCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  const parsed = parseClaudeConfigArgs(args);

  if ("error" in parsed) {
    return parsed.json
      ? failureJson(formatShellJsonFailure({
        command: "claude-config",
        message: parsed.error,
        nextSteps: ["Run `vtrace claude-config [repo] [--dry-run] [--agent <name>] [--json]`."],
      }))
      : failure(parsed.error);
  }

  const resolvedOptions = resolveOptions(options);

  try {
    const agent = resolveProductShellAgent(parsed.agent);
    const detection = await detectRepoRoot(path.resolve(resolvedOptions.cwd, parsed.repoPath));
    const result = await agent.writeConfig(detection.repoRoot, {
      dryRun: parsed.dryRun,
    });
    return parsed.json
      ? successJson(formatAgentConfigInstallJson("claude-config", result))
      : success(formatClaudeCodeConfigResult(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return parsed.json
      ? failureJson(formatShellJsonFailure({
        command: "claude-config",
        message,
        nextSteps: ["Run `vtrace claude-config [repo] [--dry-run] [--agent <name>] [--json]` from inside the repo, or pass the repo path explicitly."],
      }))
      : failure(formatUserFacingFailure(
        "Agent config was not updated.",
        message,
        "Run `vtrace claude-config [repo] [--agent <name>]` from inside the repo, or pass the repo path explicitly.",
      ));
  }
}

function parseClaudeConfigArgs(
  args: readonly string[],
): {
  repoPath: string;
  dryRun: boolean;
  json: boolean;
  agent?: string;
} | {
  error: string;
  json: boolean;
} {
  let repoPath = ".";
  let dryRun = false;
  let json = false;
  let agent: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (argument === "--json") {
      json = true;
      continue;
    }

    if (argument === "--agent") {
      agent = args[index + 1];

      if (typeof agent !== "string" || agent.startsWith("--")) {
        return { error: "Usage: claude-config [repo] [--dry-run] [--agent <name>] [--json]", json };
      }

      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      return { error: "Usage: claude-config [repo] [--dry-run] [--agent <name>] [--json]", json };
    }

    if (repoPath !== ".") {
      return { error: "Usage: claude-config [repo] [--dry-run] [--agent <name>] [--json]", json };
    }

    repoPath = argument;
  }

  return {
    repoPath,
    dryRun,
    json,
    ...(agent === undefined ? {} : { agent }),
  };
}
