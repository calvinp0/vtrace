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
      autoReindex: parsed.autoReindex,
      onFlush(result) {
        const payload = {
          event: parsed.autoReindex ? "file_changes_queued_for_auto_reindex" : "file_changes_marked_stale",
          repoRoot,
          observedFileChanges: result.observedFileChanges,
        };
        process.stdout.write(parsed.json ? formatJson(payload) : `${payload.event}: ${result.observedFileChanges?.changedFileCount ?? 0} file(s)\n`);
      },
      onAutoReindex(event) {
        process.stdout.write(parsed.json ? formatJson(event) : `${event.event}\n`);
      },
    });

    const started = {
      event: "watch_started",
      repoRoot,
      debounceMs: parsed.debounceMs,
      pollIntervalMs: parsed.pollIntervalMs,
      behavior: parsed.autoReindex ? "auto_reindex" : "mark_stale_only",
    };

    process.stdout.write(
      parsed.json
        ? formatJson(started)
        : parsed.autoReindex
          ? `Watching ${repoRoot}; changes mark stale state and trigger debounced auto-reindex.\n`
          : `Watching ${repoRoot}; changes mark the index stale until the next explicit reindex.\n`,
    );

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
  autoReindex: boolean;
} | {
  error: string;
  json: boolean;
} {
  let repoPath = ".";
  let json = false;
  let debounceMs = DEFAULT_FILE_WATCH_DEBOUNCE_MS;
  let pollIntervalMs = DEFAULT_FILE_WATCH_POLL_INTERVAL_MS;
  let autoReindex = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--json") {
      json = true;
      continue;
    }

    if (argument === "--auto-reindex") {
      autoReindex = true;
      continue;
    }

    if (argument === "--debounce-ms") {
      const parsed = parsePositiveInteger(args[index + 1]);

      if (parsed === null) {
        return { error: USAGE, json };
      }

      debounceMs = parsed;
      index += 1;
      continue;
    }

    if (argument === "--poll-ms") {
      const parsed = parsePositiveInteger(args[index + 1]);

      if (parsed === null) {
        return { error: USAGE, json };
      }

      pollIntervalMs = parsed;
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      return { error: USAGE, json };
    }

    if (repoPath !== ".") {
      return { error: USAGE, json };
    }

    repoPath = argument;
  }

  return {
    repoPath,
    json,
    debounceMs,
    pollIntervalMs,
    autoReindex,
  };
}

const USAGE = "Usage: watch [repo] [--auto-reindex] [--debounce-ms <n>] [--poll-ms <n>] [--json]";

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
