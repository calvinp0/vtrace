import path from "node:path";

import {
  DEFAULT_FILE_WATCH_DEBOUNCE_MS,
  DEFAULT_FILE_WATCH_POLL_INTERVAL_MS,
  startRepoFileWatcher,
} from "../../runtime/fileWatcher";
import { detectRepoRoot, resolveRepoLocalPaths } from "../../setup/repoState";
import { formatJson } from "../formatters";
import type { CliOptions, CommandResult } from "../types";
import {
  failure,
  failureJson,
  resolveOptions,
  success,
} from "./helpers";

export async function runWatchCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  const parsed = parseWatchArgs(args);

  if ("error" in parsed) {
    return parsed.json ? failureJson(formatJson({ error: parsed.error })) : failure(parsed.error);
  }

  const resolvedOptions = resolveOptions(options);

  try {
    const requestedPath = path.resolve(resolvedOptions.cwd, parsed.repoPath);
    const detection = await detectRepoRoot(requestedPath);
    const repoRoot = detection.repoRoot;
    const paths = resolveRepoLocalPaths(repoRoot);

    const watcher = await startRepoFileWatcher({
      repoRoot,
      statePath: paths.statePath,
      debounceMs: parsed.debounceMs,
      pollIntervalMs: parsed.pollIntervalMs,
      onFlush(result) {
        const payload = {
          event: "file_changes_marked_stale",
          repoRoot,
          observedFileChanges: result.observedFileChanges,
        };
        process.stdout.write(parsed.json ? formatJson(payload) : `${payload.event}: ${result.observedFileChanges?.changedFileCount ?? 0} file(s)\n`);
      },
    });

    const started = {
      event: "watch_started",
      repoRoot,
      debounceMs: parsed.debounceMs,
      pollIntervalMs: parsed.pollIntervalMs,
      behavior: "mark_stale_only",
    };

    process.stdout.write(parsed.json ? formatJson(started) : `Watching ${repoRoot}; changes mark the index stale until the next explicit reindex.\n`);

    return await waitForShutdown(parsed.json, repoRoot, () => watcher.stop());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return parsed.json ? failureJson(formatJson({ error: message })) : failure(`watch failed: ${message}`);
  }
}

function parseWatchArgs(args: readonly string[]): {
  repoPath: string;
  json: boolean;
  debounceMs: number;
  pollIntervalMs: number;
} | {
  error: string;
  json: boolean;
} {
  let repoPath = ".";
  let json = false;
  let debounceMs = DEFAULT_FILE_WATCH_DEBOUNCE_MS;
  let pollIntervalMs = DEFAULT_FILE_WATCH_POLL_INTERVAL_MS;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--json") {
      json = true;
      continue;
    }

    if (argument === "--debounce-ms") {
      const parsed = parsePositiveInteger(args[index + 1]);

      if (parsed === null) {
        return { error: "Usage: watch [repo] [--debounce-ms <n>] [--poll-ms <n>] [--json]", json };
      }

      debounceMs = parsed;
      index += 1;
      continue;
    }

    if (argument === "--poll-ms") {
      const parsed = parsePositiveInteger(args[index + 1]);

      if (parsed === null) {
        return { error: "Usage: watch [repo] [--debounce-ms <n>] [--poll-ms <n>] [--json]", json };
      }

      pollIntervalMs = parsed;
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      return { error: "Usage: watch [repo] [--debounce-ms <n>] [--poll-ms <n>] [--json]", json };
    }

    if (repoPath !== ".") {
      return { error: "Usage: watch [repo] [--debounce-ms <n>] [--poll-ms <n>] [--json]", json };
    }

    repoPath = argument;
  }

  return {
    repoPath,
    json,
    debounceMs,
    pollIntervalMs,
  };
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (value === undefined || value.startsWith("--")) {
    return null;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function waitForShutdown(
  json: boolean,
  repoRoot: string,
  stop: () => void,
): Promise<CommandResult> {
  return await new Promise((resolve) => {
    const shutdown = () => {
      stop();
      const payload = {
        event: "watch_stopped",
        repoRoot,
      };
      process.stdout.write(json ? formatJson(payload) : `Stopped watching ${repoRoot}.\n`);
      resolve(success(""));
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
