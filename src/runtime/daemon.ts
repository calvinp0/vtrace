import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createRepoBoundMcpServer } from "../mcp/startServer";
import { detectRepoRoot, resolveRepoLocalPaths } from "../setup/repoState";
import {
  buildDaemonRunnerLauncher,
  buildStableMcpLauncher,
  type LauncherCommand,
} from "./launcher";

const RUNTIME_STATE_FILENAME = "runtime.json" as const;
const RUNTIME_LOG_FILENAME = "runtime.log" as const;

interface RuntimeDaemonMetadata {
  repoRoot: string;
  pid: number;
  serverPid: number;
  startedAtMs: number;
  launcher: LauncherCommand;
}

export interface RuntimeDaemonStatus {
  repoRoot: string;
  statePath: string;
  logPath: string;
  launcher: LauncherCommand;
  running: boolean;
  status: "running" | "not_running";
  pid?: number;
  serverPid?: number;
  startedAtMs?: number;
  staleStatePresent: boolean;
}

export interface RuntimeDaemonActionResult {
  action: "started" | "already_running" | "stopped" | "not_running";
  status: RuntimeDaemonStatus;
}

export function resolveRuntimeDaemonPaths(repoRoot: string): {
  statePath: string;
  logPath: string;
} {
  const stateDir = resolveRepoLocalPaths(path.resolve(repoRoot)).stateDir;

  return {
    statePath: path.join(stateDir, RUNTIME_STATE_FILENAME),
    logPath: path.join(stateDir, RUNTIME_LOG_FILENAME),
  };
}

export async function getRuntimeDaemonStatus(
  repoRoot: string,
): Promise<RuntimeDaemonStatus> {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const paths = resolveRuntimeDaemonPaths(resolvedRepoRoot);
  const launcher = buildStableMcpLauncher(resolvedRepoRoot);

  try {
    const metadata = await readRuntimeDaemonMetadata(paths.statePath);
    const running = isProcessRunning(metadata.pid);

    return {
      repoRoot: resolvedRepoRoot,
      statePath: paths.statePath,
      logPath: paths.logPath,
      launcher,
      running,
      status: running ? "running" : "not_running",
      ...(running
        ? {
          pid: metadata.pid,
          serverPid: metadata.serverPid,
          startedAtMs: metadata.startedAtMs,
        }
        : {}),
      staleStatePresent: !running,
    };
  } catch (error) {
    if (!isMissingFileError(error)) {
      return {
        repoRoot: resolvedRepoRoot,
        statePath: paths.statePath,
        logPath: paths.logPath,
        launcher,
        running: false,
        status: "not_running",
        staleStatePresent: false,
      };
    }

    return {
      repoRoot: resolvedRepoRoot,
      statePath: paths.statePath,
      logPath: paths.logPath,
      launcher,
      running: false,
      status: "not_running",
      staleStatePresent: false,
    };
  }
}

export async function startRuntimeDaemon(options: {
  repoPath: string;
  cwd?: string;
}): Promise<RuntimeDaemonActionResult> {
  const requestedPath = path.resolve(options.cwd ?? process.cwd(), options.repoPath);
  const detection = await detectRepoRoot(requestedPath);
  const repoRoot = detection.repoRoot;

  await createRepoBoundMcpServer({
    repoPath: repoRoot,
    cwd: options.cwd,
  });

  const existingStatus = await getRuntimeDaemonStatus(repoRoot);

  if (existingStatus.running) {
    return {
      action: "already_running",
      status: existingStatus,
    };
  }

  const paths = resolveRuntimeDaemonPaths(repoRoot);
  await mkdir(path.dirname(paths.statePath), { recursive: true });

  const launcher = buildDaemonRunnerLauncher(repoRoot);
  const logFd = openSync(paths.logPath, "a");

  try {
    const child = spawn(launcher.command, launcher.args, {
      cwd: options.cwd ?? process.cwd(),
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });

    child.unref();

    const started = await waitForDaemonState(repoRoot, true, 1_500);

    if (!started.running) {
      throw new Error(`Runtime daemon failed to start for ${repoRoot}`);
    }

    return {
      action: "started",
      status: started,
    };
  } finally {
    closeSync(logFd);
  }
}

export async function stopRuntimeDaemon(
  repoRoot: string,
): Promise<RuntimeDaemonActionResult> {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const status = await getRuntimeDaemonStatus(resolvedRepoRoot);

  if (!status.running || status.pid === undefined) {
    await cleanupRuntimeDaemonState(resolvedRepoRoot);

    return {
      action: "not_running",
      status: await getRuntimeDaemonStatus(resolvedRepoRoot),
    };
  }

  process.kill(status.pid, "SIGTERM");
  await waitForDaemonState(resolvedRepoRoot, false, 1_500);
  await cleanupRuntimeDaemonState(resolvedRepoRoot);

  return {
    action: "stopped",
    status: await getRuntimeDaemonStatus(resolvedRepoRoot),
  };
}

export async function readRuntimeDaemonLogs(
  repoRoot: string,
): Promise<{
  logPath: string;
  content: string;
}> {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const paths = resolveRuntimeDaemonPaths(resolvedRepoRoot);

  try {
    return {
      logPath: paths.logPath,
      content: await readFile(paths.logPath, "utf8"),
    };
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }

    return {
      logPath: paths.logPath,
      content: "",
    };
  }
}

export async function runRuntimeDaemonRunner(
  repoPath: string,
  cwd?: string,
): Promise<number> {
  const requestedPath = path.resolve(cwd ?? process.cwd(), repoPath);
  const detection = await detectRepoRoot(requestedPath);
  const repoRoot = detection.repoRoot;
  const paths = resolveRuntimeDaemonPaths(repoRoot);
  const launcher = buildStableMcpLauncher(repoRoot);

  await mkdir(path.dirname(paths.statePath), { recursive: true });

  const child = spawn(launcher.command, launcher.args, {
    cwd: cwd ?? process.cwd(),
    stdio: ["pipe", "inherit", "inherit"],
  });

  if (child.stdin === null) {
    throw new Error("Runtime daemon runner failed to create keepalive stdin pipe.");
  }

  const metadata: RuntimeDaemonMetadata = {
    repoRoot,
    pid: process.pid,
    serverPid: child.pid ?? -1,
    startedAtMs: Date.now(),
    launcher,
  };

  await writeFile(paths.statePath, `${JSON.stringify(metadata, null, 2)}\n`);
  logDaemonEvent("daemon_started", metadata);

  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logDaemonEvent("daemon_stopping", { repoRoot, signal });
    child.stdin?.end();
    child.kill("SIGTERM");
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return await new Promise<number>((resolve) => {
    child.once("exit", async (code, signal) => {
      logDaemonEvent("daemon_stopped", {
        repoRoot,
        signal: signal ?? null,
        code: code ?? null,
      });
      await cleanupRuntimeDaemonState(repoRoot);
      resolve(shuttingDown ? 0 : code ?? 0);
    });
  });
}

async function waitForDaemonState(
  repoRoot: string,
  expectedRunning: boolean,
  timeoutMs: number,
): Promise<RuntimeDaemonStatus> {
  const startedAtMs = Date.now();

  while (Date.now() - startedAtMs <= timeoutMs) {
    const status = await getRuntimeDaemonStatus(repoRoot);

    if (status.running === expectedRunning) {
      return status;
    }

    await delay(50);
  }

  return getRuntimeDaemonStatus(repoRoot);
}

async function cleanupRuntimeDaemonState(repoRoot: string): Promise<void> {
  const paths = resolveRuntimeDaemonPaths(repoRoot);
  await rm(paths.statePath, { force: true });
}

async function readRuntimeDaemonMetadata(
  statePath: string,
): Promise<RuntimeDaemonMetadata> {
  return JSON.parse(await readFile(statePath, "utf8")) as RuntimeDaemonMetadata;
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function logDaemonEvent(event: string, details: unknown): void {
  process.stdout.write(`${JSON.stringify({ event, details, atMs: Date.now() })}\n`);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
