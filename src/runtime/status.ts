import { stat } from "node:fs/promises";
import path from "node:path";

import {
  readRepoLocalConfig,
  readRepoLocalState,
  detectRepoRoot,
  resolveRepoLocalPaths,
} from "../setup/repoState";
import type {
  RepoLocalConfig,
  RepoLocalState,
  RepoReadiness,
  RepoRootDetectionMode,
  RepoRootMarker,
} from "../setup/types";
import {
  getRuntimeDaemonStatus,
  type RuntimeDaemonStatus,
} from "./daemon";
import {
  resolveProductShellAgent,
  type AgentConfigStatus,
  type ProductShellAgentId,
} from "./agents";
import {
  inspectIndexFreshness,
  type IndexFreshnessResult,
} from "./indexFreshness";
import { buildFileWatcherStatus } from "./fileWatcher";
import {
  buildStableMcpLauncher,
  type LauncherCommand,
} from "./launcher";
import { getRuntimeProvenance, type RuntimeProvenance } from "./provenance";

export interface ProductShellStatus {
  requestedPath: string;
  repoRoot: string;
  detectionMode: RepoRootDetectionMode;
  detectionMarker?: RepoRootMarker;
  selectedAgent: ProductShellAgentId;
  repoLocal: {
    stateDir: string;
    configPath: string;
    statePath: string;
    dbPath: string;
    configPresent: boolean;
    statePresent: boolean;
    dbPresent: boolean;
    initialized: boolean;
  };
  readiness: RepoReadiness | null;
  latestRunId: number | null;
  indexPresent: boolean;
  indexFreshness: IndexFreshnessResult;
  watcher: ReturnType<typeof buildFileWatcherStatus>;
  launcher: LauncherCommand;
  agentConfig: AgentConfigStatus;
  runtime: RuntimeDaemonStatus;
  provenance: RuntimeProvenance;
  nextSteps: string[];
}

export async function inspectProductShellStatus(options: {
  repoPath?: string;
  cwd?: string;
  agent?: string;
} = {}): Promise<ProductShellStatus> {
  const resolvedCwd = path.resolve(options.cwd ?? process.cwd());
  const requestedPath = path.resolve(resolvedCwd, options.repoPath ?? ".");
  const detection = await detectRepoRoot(requestedPath);
  const agent = resolveProductShellAgent(options.agent);
  const repoRoot = detection.repoRoot;
  const paths = resolveRepoLocalPaths(repoRoot);
  const configPresent = await isExistingFile(paths.configPath);
  const statePresent = await isExistingFile(paths.statePath);
  const config = configPresent ? await safeReadConfig(paths.configPath) : undefined;
  const state = statePresent ? await safeReadState(paths.statePath) : undefined;
  const dbPath = config?.dbPath ?? state?.dbPath ?? paths.dbPath;
  const dbPresent = await isExistingFile(dbPath);
  const initialized = config?.initialized === true
    && state?.initialized === true
    && dbPresent;
  const readiness = state?.readiness ?? null;
  const latestRunId = state?.latestRunId ?? null;
  const indexPresent = latestRunId !== null && dbPresent;
  const indexFreshness = await inspectIndexFreshness({
    repoRoot,
    lastIndexSnapshot: state?.lastIndexSnapshot,
    observedFileChanges: state?.observedFileChanges,
    fileWatcher: state?.fileWatcher,
  });
  const launcher = buildStableMcpLauncher(repoRoot);
  const agentConfig = await agent.getStatus(repoRoot);
  const runtime = await getRuntimeDaemonStatus(repoRoot);
  const watcher = buildFileWatcherStatus(state);

  return {
    requestedPath,
    repoRoot,
    detectionMode: detection.mode,
    ...(detection.marker === undefined ? {} : { detectionMarker: detection.marker }),
    selectedAgent: agent.id,
    repoLocal: {
      stateDir: paths.stateDir,
      configPath: paths.configPath,
      statePath: paths.statePath,
      dbPath,
      configPresent,
      statePresent,
      dbPresent,
      initialized,
    },
    readiness,
    latestRunId,
    indexPresent,
    indexFreshness,
    watcher,
    launcher,
    agentConfig,
    runtime,
    provenance: getRuntimeProvenance(),
    nextSteps: buildNextSteps({
      repoRoot,
      selectedAgent: agent.id,
      initialized,
      readiness,
      agentConfig,
      runtime,
    }),
  };
}

function buildNextSteps(input: {
  repoRoot: string;
  selectedAgent: ProductShellAgentId;
  initialized: boolean;
  readiness: RepoReadiness | null;
  agentConfig: AgentConfigStatus;
  runtime: RuntimeDaemonStatus;
}): string[] {
  const steps: string[] = [];

  if (!input.initialized || input.readiness?.status !== "ready") {
    steps.push(`Run \`vtrace setup ${input.repoRoot}${formatAgentFlag(input.selectedAgent)}\` to initialize and index the repo.`);
  }

  if (!input.agentConfig.matchesExpected) {
    steps.push(`Run \`vtrace claude-config ${input.repoRoot}${formatAgentFlag(input.selectedAgent)}\` to install or refresh ${input.agentConfig.displayName} MCP config.`);
  }

  if (!input.runtime.running) {
    steps.push(`Runtime daemon is optional; run \`vtrace daemon start ${input.repoRoot}\` if you want an inspectable background process.`);
  }

  if (
    input.initialized
    && input.readiness?.status === "ready"
    && input.agentConfig.matchesExpected
  ) {
    steps.push(`Open ${input.agentConfig.displayName} in this repo; the installed MCP config will launch vtrace on demand.`);
  }

  return [...new Set(steps)];
}

function formatAgentFlag(agentId: ProductShellAgentId): string {
  return agentId === "claude-code" ? "" : ` --agent ${agentId}`;
}

async function safeReadConfig(
  configPath: string,
): Promise<RepoLocalConfig | undefined> {
  try {
    return await readRepoLocalConfig(configPath);
  } catch {
    return undefined;
  }
}

async function safeReadState(
  statePath: string,
): Promise<RepoLocalState | undefined> {
  try {
    return await readRepoLocalState(statePath);
  } catch {
    return undefined;
  }
}

async function isExistingFile(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isFile();
  } catch {
    return false;
  }
}
