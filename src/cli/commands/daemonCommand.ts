import path from "node:path";

import { detectRepoRoot } from "../../setup/repoState";
import {
  getRuntimeDaemonStatus,
  readRuntimeDaemonLogs,
  runRuntimeDaemonRunner,
  startRuntimeDaemon,
  stopRuntimeDaemon,
} from "../../runtime/daemon";
import {
  formatRuntimeDaemonActionResult,
  formatRuntimeDaemonLogs,
  formatRuntimeDaemonStatus,
} from "../formatters";
import {
  formatRuntimeDaemonActionJson,
  formatRuntimeDaemonLogsJson,
  formatRuntimeDaemonStatusJson,
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

export async function runDaemonCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  const resolvedOptions = resolveOptions(options);
  const parsed = parseDaemonArgs(args);

  if ("error" in parsed) {
    return parsed.json
      ? failureJson(formatShellJsonFailure({
        command: "daemon",
        message: parsed.error,
        nextSteps: ["Run `vexb daemon <start|stop|status|logs> [repo] [--json]`."],
      }))
      : failure(parsed.error);
  }

  const repoPath = path.resolve(resolvedOptions.cwd, parsed.repoPath);

  try {
    if (parsed.subcommand === "start") {
      const result = await startRuntimeDaemon({
        repoPath,
        cwd: resolvedOptions.cwd,
      });
      return parsed.json
        ? successJson(formatRuntimeDaemonActionJson("daemon.start", result))
        : success(formatRuntimeDaemonActionResult(result));
    }

    const detection = await detectRepoRoot(repoPath);

    if (parsed.subcommand === "stop") {
      const result = await stopRuntimeDaemon(detection.repoRoot);
      return parsed.json
        ? successJson(formatRuntimeDaemonActionJson("daemon.stop", result))
        : success(formatRuntimeDaemonActionResult(result));
    }

    if (parsed.subcommand === "status") {
      const result = await getRuntimeDaemonStatus(detection.repoRoot);
      return parsed.json
        ? successJson(formatRuntimeDaemonStatusJson(result))
        : success(formatRuntimeDaemonStatus(result));
    }

    const result = {
      repoRoot: detection.repoRoot,
      ...(await readRuntimeDaemonLogs(detection.repoRoot)),
    };
    return parsed.json
      ? successJson(formatRuntimeDaemonLogsJson(result))
      : success(formatRuntimeDaemonLogs(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return parsed.json
      ? failureJson(formatShellJsonFailure({
        command: `daemon.${parsed.subcommand}`,
        message,
        nextSteps: [`Run \`vexb status ${repoPath}\` to check repo readiness, then try \`vexb daemon ${parsed.subcommand} ${repoPath}\` again.`],
      }))
      : failure(formatUserFacingFailure(
        `Runtime ${parsed.subcommand} failed.`,
        message,
        `Run \`vexb status ${repoPath}\` to check repo readiness, then try \`vexb daemon ${parsed.subcommand} ${repoPath}\` again.`,
      ));
  }
}

export async function runDaemonRunnerCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  const repoPath = parseRepoFlag(args);

  if (repoPath === undefined) {
    return failure("Usage: daemon-runner --repo <repo>");
  }

  const resolvedOptions = resolveOptions(options);

  try {
    const exitCode = await runRuntimeDaemonRunner(repoPath, resolvedOptions.cwd);

    return {
      exitCode,
      stdout: "",
      stderr: "",
    };
  } catch (error) {
    return failure(`daemon-runner failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseRepoFlag(
  args: readonly string[],
): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--repo") {
      return args[index + 1];
    }

    if (argument.startsWith("--repo=")) {
      return argument.slice("--repo=".length);
    }
  }

  return undefined;
}

function parseDaemonArgs(
  args: readonly string[],
): {
  subcommand: "start" | "stop" | "status" | "logs";
  repoPath: string;
  json: boolean;
} | {
  error: string;
  json: boolean;
} {
  const [subcommand, ...rest] = args;

  if (
    subcommand !== "start"
    && subcommand !== "stop"
    && subcommand !== "status"
    && subcommand !== "logs"
  ) {
    return { error: "Usage: daemon <start|stop|status|logs> [repo] [--json]", json: false };
  }

  let repoPath = ".";
  let json = false;

  for (const argument of rest) {
    if (argument === "--json") {
      json = true;
      continue;
    }

    if (argument.startsWith("--")) {
      return { error: "Usage: daemon <start|stop|status|logs> [repo] [--json]", json };
    }

    if (repoPath !== ".") {
      return { error: "Usage: daemon <start|stop|status|logs> [repo] [--json]", json };
    }

    repoPath = argument;
  }

  return {
    subcommand,
    repoPath,
    json,
  };
}
