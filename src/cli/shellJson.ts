import type { RepoReadiness } from "../setup/types";
import type {
  AgentConfigInstallResult,
  AgentConfigStatus,
} from "../runtime/agents";
import type {
  RuntimeDaemonActionResult,
  RuntimeDaemonStatus,
} from "../runtime/daemon";
import type {
  IndexFreshnessReason,
  IndexFreshnessResult,
} from "../runtime/indexFreshness";
import type { SetupFlowResult } from "../runtime/setupFlow";
import type { ProductShellStatus } from "../runtime/status";
import { formatJson } from "./formatters";

export interface ShellJsonEnvelope<TResult> {
  ok: boolean;
  command: string;
  repoRoot: string | null;
  timestampMs: number;
  result: TResult | null;
  warnings: string[];
  nextSteps: string[];
  error: {
    message: string;
  } | null;
}

interface ShellJsonLauncher {
  command: string;
  args: string[];
}

interface ShellJsonAgentConfig {
  agentId: string;
  displayName: string;
  configPath: string;
  installed: boolean;
  matchesExpected: boolean;
  launcher: ShellJsonLauncher;
  error: string | null;
}

interface ShellJsonAgentConfigResult extends ShellJsonAgentConfig {
  action: "created" | "updated" | "unchanged";
  dryRun: boolean;
}

interface ShellJsonRuntimeStatus {
  status: RuntimeDaemonStatus["status"];
  running: boolean;
  statePath: string;
  logPath: string;
  launcher: ShellJsonLauncher;
  staleStatePresent: boolean;
  pid: number | null;
  serverPid: number | null;
  startedAtMs: number | null;
}

interface ShellJsonRepoState {
  requestedPath: string;
  detectionMode: ProductShellStatus["detectionMode"];
  detectionMarker: ProductShellStatus["detectionMarker"] | null;
  stateDir: string;
  configPath: string;
  statePath: string;
  dbPath: string;
  configPresent: boolean;
  statePresent: boolean;
  dbPresent: boolean;
  initialized: boolean;
}

interface ShellJsonIndexState {
  indexPresent: boolean;
  latestRunId: number | null;
  freshness: ShellJsonIndexFreshness;
  watcher: {
    supported: boolean;
    enabled: boolean;
    running: boolean;
    debounceMs: number;
    lastEventAtMs: number | null;
  };
  readiness: {
    status: RepoReadiness["status"];
    summary: string;
    checks: Array<{
      id: RepoReadiness["checks"][number]["id"];
      ok: boolean;
      detail: string;
    }>;
  } | null;
}

interface ShellJsonIndexFreshness {
  state: IndexFreshnessResult["state"];
  isStale: boolean;
  summary: string;
  reasons: Array<{
    code: IndexFreshnessReason["code"];
    count: number | null;
    message: string;
  }>;
  observedFileChanges: {
    isStale: true;
    reason: "file_changes_detected";
    firstChangedAtMs: number;
    lastChangedAtMs: number;
    changedFileCount: number;
    changedFiles: string[];
    omittedChangedFileCount: number;
  } | null;
  whyItMatters: string | null;
  recommendedAction: string | null;
  snapshot: {
    lastIndexedAtMs: number | null;
    lastIndexedHead: string | null;
    lastIndexedSourceFileCount: number | null;
    lastIndexedSourceFingerprint: string | null;
  };
  currentHead: string | null;
  comparison: {
    currentSourceFileCount: number | null;
    fingerprintMatches: boolean | null;
  };
}

export function formatSetupJson(result: SetupFlowResult): string {
  return formatJson(buildShellJsonSuccess("setup", result.repoRoot, {
    selectedAgent: result.selectedAgent,
    requestedPath: result.requestedPath,
    detectionMode: result.detectionMode,
    detectionMarker: result.detectionMarker ?? null,
    initAction: result.initAction,
    readiness: formatReadiness(result.readiness),
    latestRunId: result.latestRunId,
    launcher: formatLauncher(result.launcher),
    agentConfig: formatAgentConfigInstallResult(result.agentConfig),
    runtime: {
      action: result.runtime.action,
      status: formatRuntimeStatus(result.runtime),
    },
  }, collectAgentAndRuntimeWarnings(result.agentConfig, result.runtime), result.nextSteps));
}

export function formatProductShellStatusJson(
  command: "status" | "doctor",
  result: ProductShellStatus,
): string {
  return formatJson(buildShellJsonSuccess(command, result.repoRoot, {
    selectedAgent: result.selectedAgent,
    repoState: formatRepoState(result),
    indexState: formatIndexState(result),
    agentConfig: formatAgentConfigStatus(result.agentConfig),
    runtime: formatRuntimeStatus(result.runtime),
  }, collectProductShellWarnings(result), buildProductShellStatusNextSteps(command, result)));
}

export function formatAgentConfigInstallJson(
  command: "claude-config",
  result: AgentConfigInstallResult,
): string {
  return formatJson(buildShellJsonSuccess(command, result.repoRoot, {
    selectedAgent: result.agentId,
    agentConfig: formatAgentConfigInstallResult(result),
  }, collectAgentConfigWarnings(result), buildAgentConfigNextSteps(result)));
}

export function formatRuntimeDaemonActionJson(
  command: "daemon.start" | "daemon.stop",
  result: RuntimeDaemonActionResult,
): string {
  const warnings = result.status.staleStatePresent
    ? ["Runtime state file exists but the daemon is not running."]
    : [];
  const nextSteps = result.status.running
    ? [
      `Run \`vtrace daemon status ${result.status.repoRoot}\` to check the runtime again.`,
      `Run \`vtrace daemon logs ${result.status.repoRoot}\` to inspect runtime output.`,
    ]
    : [`Run \`vtrace daemon start ${result.status.repoRoot}\` if you want the optional background runtime.`];

  return formatJson(buildShellJsonSuccess(command, result.status.repoRoot, {
    action: result.action,
    runtime: formatRuntimeStatus(result.status),
  }, warnings, nextSteps));
}

export function formatRuntimeDaemonStatusJson(
  result: RuntimeDaemonStatus,
): string {
  return formatJson(buildShellJsonSuccess("daemon.status", result.repoRoot, {
    runtime: formatRuntimeStatus(result),
  }, result.staleStatePresent
    ? ["Runtime state file exists but the daemon is not running."]
    : [], result.running
    ? [`Run \`vtrace daemon logs ${result.repoRoot}\` to inspect runtime output.`]
    : [`Run \`vtrace daemon start ${result.repoRoot}\` if you want the optional background runtime.`]));
}

export function formatRuntimeDaemonLogsJson(input: {
  repoRoot: string;
  logPath: string;
  content: string;
}): string {
  return formatJson(buildShellJsonSuccess("daemon.logs", input.repoRoot, {
    logPath: input.logPath,
    hasContent: input.content.length > 0,
    content: input.content,
  }, [], [`Run \`vtrace daemon status ${input.repoRoot}\` to check whether the runtime is running.`]));
}

export function formatShellJsonFailure(input: {
  command: string;
  repoRoot?: string | null;
  message: string;
  nextSteps?: string[];
  warnings?: string[];
}): string {
  const payload: ShellJsonEnvelope<null> = {
    ok: false,
    command: input.command,
    repoRoot: input.repoRoot ?? null,
    timestampMs: Date.now(),
    result: null,
    warnings: [...(input.warnings ?? [])],
    nextSteps: [...(input.nextSteps ?? [])],
    error: {
      message: input.message,
    },
  };

  return formatJson(payload);
}

function buildShellJsonSuccess<TResult>(
  command: string,
  repoRoot: string,
  result: TResult,
  warnings: readonly string[],
  nextSteps: readonly string[],
): ShellJsonEnvelope<TResult> {
  return {
    ok: true,
    command,
    repoRoot,
    timestampMs: Date.now(),
    result,
    warnings: [...warnings],
    nextSteps: [...nextSteps],
    error: null,
  };
}

function formatLauncher(launcher: {
  command: string;
  args: readonly string[];
}): ShellJsonLauncher {
  return {
    command: launcher.command,
    args: [...launcher.args],
  };
}

function formatAgentConfigStatus(
  status: AgentConfigStatus,
): ShellJsonAgentConfig {
  return {
    agentId: status.agentId,
    displayName: status.displayName,
    configPath: status.configPath,
    installed: status.installed,
    matchesExpected: status.matchesExpected,
    launcher: formatLauncher(status.launcher),
    error: status.error ?? null,
  };
}

function formatAgentConfigInstallResult(
  result: AgentConfigInstallResult,
): ShellJsonAgentConfigResult {
  return {
    ...formatAgentConfigStatus(result),
    action: result.action,
    dryRun: result.dryRun,
  };
}

function formatRuntimeStatus(
  status: RuntimeDaemonStatus,
): ShellJsonRuntimeStatus {
  return {
    status: status.status,
    running: status.running,
    statePath: status.statePath,
    logPath: status.logPath,
    launcher: formatLauncher(status.launcher),
    staleStatePresent: status.staleStatePresent,
    pid: status.pid ?? null,
    serverPid: status.serverPid ?? null,
    startedAtMs: status.startedAtMs ?? null,
  };
}

function formatRepoState(
  result: ProductShellStatus,
): ShellJsonRepoState {
  return {
    requestedPath: result.requestedPath,
    detectionMode: result.detectionMode,
    detectionMarker: result.detectionMarker ?? null,
    stateDir: result.repoLocal.stateDir,
    configPath: result.repoLocal.configPath,
    statePath: result.repoLocal.statePath,
    dbPath: result.repoLocal.dbPath,
    configPresent: result.repoLocal.configPresent,
    statePresent: result.repoLocal.statePresent,
    dbPresent: result.repoLocal.dbPresent,
    initialized: result.repoLocal.initialized,
  };
}

function formatIndexState(
  result: ProductShellStatus,
): ShellJsonIndexState {
  return {
    indexPresent: result.indexPresent,
    latestRunId: result.latestRunId,
    freshness: formatIndexFreshness(result.indexFreshness),
    watcher: result.watcher,
    readiness: formatReadiness(result.readiness),
  };
}

function formatIndexFreshness(
  freshness: IndexFreshnessResult,
): ShellJsonIndexFreshness {
  return {
    state: freshness.state,
    isStale: freshness.isStale,
    summary: freshness.summary,
    reasons: freshness.reasons.map((reason) => ({
      code: reason.code,
      count: reason.count ?? null,
      message: formatIndexFreshnessReason(reason),
    })),
    observedFileChanges: freshness.observedFileChanges === null
      ? null
      : {
        ...freshness.observedFileChanges,
        changedFiles: [...freshness.observedFileChanges.changedFiles],
      },
    whyItMatters: freshness.whyItMatters ?? null,
    recommendedAction: freshness.recommendedAction ?? null,
    snapshot: {
      lastIndexedAtMs: freshness.snapshot.lastIndexedAtMs,
      lastIndexedHead: freshness.snapshot.lastIndexedHead,
      lastIndexedSourceFileCount: freshness.snapshot.lastIndexedSourceFileCount,
      lastIndexedSourceFingerprint: freshness.snapshot.lastIndexedSourceFingerprint,
    },
    currentHead: freshness.currentHead,
    comparison: {
      currentSourceFileCount: freshness.comparison.currentSourceFileCount,
      fingerprintMatches: freshness.comparison.fingerprintMatches,
    },
  };
}

function formatReadiness(
  readiness: RepoReadiness | null,
): ShellJsonIndexState["readiness"] {
  if (readiness === null) {
    return null;
  }

  return {
    status: readiness.status,
    summary: readiness.summary,
    checks: readiness.checks.map((check) => ({
      id: check.id,
      ok: check.ok,
      detail: check.detail,
    })),
  };
}

function collectAgentAndRuntimeWarnings(
  agentConfig: AgentConfigStatus,
  runtime: RuntimeDaemonStatus,
): string[] {
  const warnings: string[] = [];

  if (agentConfig.error !== undefined) {
    warnings.push(`${agentConfig.displayName} config could not be read.`);
  }

  if (runtime.staleStatePresent) {
    warnings.push("Runtime state file exists but the daemon is not running.");
  }

  return warnings;
}

function collectProductShellWarnings(
  result: ProductShellStatus,
): string[] {
  const warnings = collectAgentAndRuntimeWarnings(result.agentConfig, result.runtime);

  if (result.indexPresent && result.readiness?.status === "ready") {
    switch (result.indexFreshness.state) {
      case "possibly_stale":
        warnings.push("Vtrace detected likely drift since the last indexed snapshot.");
        break;
      case "unknown":
        warnings.push("Vtrace could not determine whether the current repo matches the last indexed snapshot.");
        break;
      case "fresh":
        break;
    }
  }

  return warnings;
}

function collectAgentConfigWarnings(
  agentConfig: AgentConfigStatus,
): string[] {
  return agentConfig.error === undefined
    ? []
    : [`${agentConfig.displayName} config could not be read.`];
}

function buildAgentConfigNextSteps(
  result: AgentConfigInstallResult,
): string[] {
  const agentFlag = result.agentId === "claude-code" ? "" : ` --agent ${result.agentId}`;

  if (result.dryRun) {
    return result.action === "unchanged"
      ? [`Open ${result.displayName} in this repo when you are ready to use vtrace.`]
      : [`Run \`vtrace claude-config ${result.repoRoot}${agentFlag}\` to apply this change.`];
  }

  return [`Open ${result.displayName} in this repo. The installed MCP config will launch vtrace on demand.`];
}

function buildProductShellStatusNextSteps(
  command: "status" | "doctor",
  result: ProductShellStatus,
): string[] {
  if (
    result.readiness?.status !== "ready"
    || !result.indexPresent
    || !result.agentConfig.matchesExpected
  ) {
    return result.nextSteps;
  }

  switch (result.indexFreshness.state) {
    case "fresh":
      if (command === "doctor") {
        return ["No re-index is recommended right now."];
      }

      return [
        `Open ${result.agentConfig.displayName} in this repo; vtrace can use the current indexed snapshot as-is.`,
        ...(!result.runtime.running
          ? ["Start the runtime daemon only if you want an inspectable background process."]
          : []),
      ];
    case "possibly_stale":
      return command === "doctor"
        ? ["Re-index this repo before relying on vtrace for fresh structural guidance."]
        : [
          "Indexed source files appear to have changed since the last indexed snapshot.",
          "Re-index before relying on vtrace for fresh structural guidance.",
        ];
    case "unknown":
      return command === "doctor"
        ? ["Re-index if you want a fresh, explicit trust point."]
        : [
          "Vtrace could not compare the current repo state to the last indexed snapshot.",
          "Run doctor for more detail.",
        ];
  }
}

function formatIndexFreshnessReason(
  reason: IndexFreshnessReason,
): string {
  switch (reason.code) {
    case "last_index_metadata_missing_or_incomplete":
      return "last-index metadata is missing or incomplete";
    case "current_source_snapshot_unavailable":
      return "the current indexed source snapshot could not be computed";
    case "indexed_source_file_count_differs":
      return "indexed source file count differs from the last indexed snapshot";
    case "indexed_source_fingerprint_differs":
      return "indexed source fingerprint differs from the last indexed snapshot";
    case "file_changes_detected":
      return `watcher observed ${reason.count ?? 0} indexed source file change(s) since the last index`;
  }
}
