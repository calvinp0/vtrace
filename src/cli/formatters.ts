import path from "node:path";

import type { EdgeRecord, FileRecord, SymbolRecord } from "../domain/types";
import type { IndexProjectResult } from "../indexer/types";
import type { Capsule, CapsuleItem } from "../capsule/types";
import type { CapsuleProfileSelectionResult } from "../capsuleProfiles/types";
import type { HandoffPayload } from "../handoff/types";
import type { CapsuleStalenessResult, IndexRunSummary } from "../memory/types";
import type { RoutedQueryResult } from "../intent/routeQuery";
import type { InitRepoResult } from "../setup/types";
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

export interface InspectFileOutput {
  file: FileRecord;
  symbols: SymbolRecord[];
  edges: EdgeRecord[];
}

export interface InspectSymbolOutput {
  symbol: SymbolRecord;
  edges: EdgeRecord[];
}

export interface CapsuleOutput {
  query: string;
  pivots: ReturnType<typeof formatCapsuleItem>[];
  supportingItems: ReturnType<typeof formatCapsuleItem>[];
  memories?: Capsule["memories"];
  budget: Capsule["budget"];
  truncated: boolean;
  compressed: boolean;
}

export interface CapsuleInspectionOutput {
  query: string;
  intent: RoutedQueryResult["intent"];
  classification: RoutedQueryResult["classification"];
  routingProfile: {
    id: RoutedQueryResult["profile"]["id"];
    backend: RoutedQueryResult["profile"]["backend"];
    candidatePoolSize: RoutedQueryResult["profile"]["candidatePoolSize"];
    graphWeights: RoutedQueryResult["profile"]["graphWeights"];
    summary: RoutedQueryResult["profile"]["summary"];
  };
  capsuleProfile: {
    id: CapsuleProfileSelectionResult["profile"]["id"];
    targetIntent: CapsuleProfileSelectionResult["profile"]["targetIntent"];
    description: CapsuleProfileSelectionResult["profile"]["description"];
    settingsSummary: CapsuleProfileSelectionResult["settingsSummary"];
    explanation: CapsuleProfileSelectionResult["explanation"];
  };
  capsule: CapsuleOutput & {
    profileBudgetUsage?: Capsule["profileBudgetUsage"];
  };
}

export interface RunsOutput {
  runs: Array<{
    id: number;
    previousRunId?: number;
    createdAtMs: number;
    totalFiles: number;
    totalSymbols: number;
    fileChangeCounts: IndexRunSummary["fileChangeCounts"];
    symbolChangeCounts: IndexRunSummary["symbolChangeCounts"];
  }>;
}

export interface IntentRoutingOutput {
  query: string;
  intent: RoutedQueryResult["intent"];
  classification: RoutedQueryResult["classification"];
  profile: {
    id: RoutedQueryResult["profile"]["id"];
    backend: RoutedQueryResult["profile"]["backend"];
    candidatePoolSize: RoutedQueryResult["profile"]["candidatePoolSize"];
    graphWeights: RoutedQueryResult["profile"]["graphWeights"];
    summary: RoutedQueryResult["profile"]["summary"];
  };
  rerankedResults: Array<{
    symbolId: string;
    filePath: string;
    fqName: string;
    localName: string;
    kind: string;
    lexicalScore: number;
    graphScore: number;
    finalScore: number;
    matches: RoutedQueryResult["rerankedResults"][number]["matches"];
    graphContributions: RoutedQueryResult["rerankedResults"][number]["graphContributions"];
  }>;
}

export interface InitOutput {
  requestedPath: string;
  repoRoot: string;
  detectionMode: InitRepoResult["detectionMode"];
  detectionMarker?: NonNullable<InitRepoResult["detectionMarker"]>;
  paths: InitRepoResult["paths"];
  initialized: boolean;
  readiness: InitRepoResult["state"]["readiness"];
  latestRunId: number | null;
  indexSummary: InitRepoResult["state"]["indexSummary"];
}

export function formatIndexResult(result: IndexProjectResult): string {
  return formatJson({
    totalFilesScanned: result.totalFilesScanned,
    totalFilesAttemptedForParse: result.totalFilesAttemptedForParse,
    totalFilesSuccessfullyIndexed: result.totalFilesSuccessfullyIndexed,
    totalParseFailures: result.totalParseFailures,
    totalSkippedUnregisteredLanguage: result.totalSkippedUnregisteredLanguage,
    totalSkippedUnsupportedLanguage: result.totalSkippedUnsupportedLanguage,
    totalReadFailures: result.totalReadFailures,
    totalPersistenceFailures: result.totalPersistenceFailures,
    files: result.files.map((file) => ({
      path: file.path,
      language: file.language,
      status: file.status,
      diagnostics: file.diagnostics,
      ...(file.error === undefined ? {} : { error: file.error }),
    })),
  });
}

export function formatInspectFile(output: InspectFileOutput): string {
  return formatJson({
    file: output.file,
    symbols: output.symbols,
    edges: output.edges,
  });
}

export function formatInspectSymbol(output: InspectSymbolOutput): string {
  return formatJson({
    symbol: output.symbol,
    edges: output.edges,
  });
}

export function formatCapsule(capsule: Capsule): string {
  const output = formatCapsulePayload(capsule);

  return formatJson(output);
}

export function formatCapsuleInspection(input: {
  routedQuery: RoutedQueryResult;
  capsuleProfileSelection: CapsuleProfileSelectionResult;
  capsule: Capsule;
}): string {
  const output: CapsuleInspectionOutput = {
    query: input.routedQuery.query,
    intent: input.routedQuery.intent,
    classification: input.routedQuery.classification,
    routingProfile: {
      id: input.routedQuery.profile.id,
      backend: input.routedQuery.profile.backend,
      candidatePoolSize: input.routedQuery.profile.candidatePoolSize,
      graphWeights: input.routedQuery.profile.graphWeights,
      summary: input.routedQuery.profile.summary,
    },
    capsuleProfile: {
      id: input.capsuleProfileSelection.profile.id,
      targetIntent: input.capsuleProfileSelection.profile.targetIntent,
      description: input.capsuleProfileSelection.profile.description,
      settingsSummary: input.capsuleProfileSelection.settingsSummary,
      explanation: input.capsuleProfileSelection.explanation,
    },
    capsule: {
      ...formatCapsulePayload(input.capsule),
      ...(input.capsule.profileBudgetUsage === undefined
        ? {}
        : { profileBudgetUsage: input.capsule.profileBudgetUsage }),
    },
  };

  return formatJson(output);
}

function formatCapsulePayload(capsule: Capsule): CapsuleOutput {
  return {
    query: capsule.query,
    pivots: capsule.pivots.map(formatCapsuleItem),
    supportingItems: capsule.supportingItems.map(formatCapsuleItem),
    ...(capsule.memories === undefined ? {} : { memories: structuredClone(capsule.memories) }),
    budget: capsule.budget,
    truncated: capsule.truncated,
    compressed: capsule.compressed,
  };
}

export function formatRuns(runs: readonly IndexRunSummary[]): string {
  const output: RunsOutput = {
    runs: runs.map((run) => ({
      id: run.id,
      ...(run.previousRunId === undefined ? {} : { previousRunId: run.previousRunId }),
      createdAtMs: run.createdAtMs,
      totalFiles: run.totalFiles,
      totalSymbols: run.totalSymbols,
      fileChangeCounts: run.fileChangeCounts,
      symbolChangeCounts: run.symbolChangeCounts,
    })),
  };

  return formatJson(output);
}

export function formatCapsuleStaleness(result: CapsuleStalenessResult): string {
  return formatJson({
    capsuleId: result.capsuleId,
    sourceRunId: result.sourceRunId,
    comparisonRunId: result.comparisonRunId,
    query: result.query,
    status: result.status,
    items: result.items.map((item) => ({
      capsuleId: item.capsuleId,
      itemOrdinal: item.itemOrdinal,
      role: item.role,
      contentMode: item.contentMode,
      sourceBacked: item.sourceBacked,
      filePath: item.filePath,
      symbol: item.symbol,
      status: item.status,
      reasons: item.reasons,
    })),
  });
}

export function formatIntentRouting(result: RoutedQueryResult): string {
  const output: IntentRoutingOutput = {
    query: result.query,
    intent: result.intent,
    classification: result.classification,
    profile: {
      id: result.profile.id,
      backend: result.profile.backend,
      candidatePoolSize: result.profile.candidatePoolSize,
      graphWeights: result.profile.graphWeights,
      summary: result.profile.summary,
    },
    rerankedResults: result.rerankedResults.map((candidate) => ({
      symbolId: candidate.symbolId,
      filePath: candidate.filePath,
      fqName: candidate.fqName,
      localName: candidate.localName,
      kind: candidate.kind,
      lexicalScore: candidate.lexicalScore,
      graphScore: candidate.graphScore,
      finalScore: candidate.finalScore,
      matches: candidate.matches,
      graphContributions: candidate.graphContributions,
    })),
  };

  return formatJson(output);
}

export function formatInitResult(result: InitRepoResult): string {
  const output: InitOutput = {
    requestedPath: result.requestedPath,
    repoRoot: result.repoRoot,
    detectionMode: result.detectionMode,
    ...(result.detectionMarker === undefined ? {} : { detectionMarker: result.detectionMarker }),
    paths: result.paths,
    initialized: result.state.initialized,
    readiness: result.state.readiness,
    latestRunId: result.state.latestRunId,
    indexSummary: result.state.indexSummary,
  };

  return formatJson(output);
}

export function formatHandoffPayload(payload: HandoffPayload): string {
  return formatJson(payload);
}

export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function formatSetupFlowResult(result: SetupFlowResult): string {
  const title = result.initAction === "initialized"
    ? "Setup complete"
    : "Setup checked this repo and reused the existing ready state";
  const runtimeState = result.runtime.running
    ? "running"
    : result.runtime.action === "not_requested"
      ? "not started"
      : "not running";

  return [
    `${title}\n\n`,
    formatSection("Repo state", [
      `Repo root: ${result.repoRoot}`,
      `Setup action: ${result.initAction === "initialized" ? "initialized repo-local state and index" : "kept existing repo-local state and index"}`,
      `Index: ${result.readiness.summary} (latest run ${result.latestRunId ?? "none"})`,
    ]),
    formatSection(`${result.agentConfig.displayName} config`, [
      `Action: ${formatConfigActionLabel(result.agentConfig.action)}`,
      `Config file: ${formatRepoRelativePath(result.repoRoot, result.agentConfig.configPath)}`,
      `Launcher: ${formatLauncher(result.agentConfig.launcher)}`,
    ]),
    formatSection("Runtime state", [
      `Action: ${formatRuntimeActionLabel(result.runtime.action)}`,
      `State: ${runtimeState}`,
      `Log file: ${formatRepoRelativePath(result.repoRoot, result.runtime.logPath)}`,
    ]),
    formatNextSteps(result.nextSteps),
  ].join("");
}

export function formatClaudeCodeConfigResult(
  result: AgentConfigInstallResult,
): string {
  const configLabel = `${result.displayName} config`;
  const agentFlag = result.agentId === "claude-code" ? "" : ` --agent ${result.agentId}`;
  const title = result.dryRun
    ? result.action === "unchanged"
      ? `${configLabel} is already current`
      : `${configLabel} preview`
    : result.action === "created"
      ? `${configLabel} installed`
      : result.action === "updated"
        ? `${configLabel} updated`
        : `${configLabel} is already current`;
  const nextSteps = result.dryRun
    ? result.action === "unchanged"
      ? [`Open ${result.displayName} in this repo when you are ready to use vexb.`]
      : [`Run \`vexb claude-config ${result.repoRoot}${agentFlag}\` to apply this change.`]
    : [`Open ${result.displayName} in this repo. The installed MCP config will launch vexb on demand.`];

  return [
    `${title}\n\n`,
    formatSection(configLabel, [
      `Repo root: ${result.repoRoot}`,
      `Action: ${formatConfigActionLabel(result.action)}${result.dryRun ? " (dry run)" : ""}`,
      `Config file: ${formatRepoRelativePath(result.repoRoot, result.configPath)}`,
      `Launcher: ${formatLauncher(result.launcher)}`,
    ]),
    formatNextSteps(nextSteps),
  ].join("");
}

export function formatProductShellStatus(
  result: ProductShellStatus,
  mode: "status" | "doctor",
): string {
  const title = mode === "doctor" ? "Doctor" : "Status";
  const repoStateLines = [
    `Repo root: ${result.repoRoot}`,
    `Setup: ${result.repoLocal.initialized ? "initialized" : "not initialized"}`,
    `Detection: ${formatDetection(result)}`,
    ...(mode === "doctor"
      ? [
        `State dir: ${formatRepoRelativePath(result.repoRoot, result.repoLocal.stateDir)}`,
        `Config file: ${formatRepoRelativePath(result.repoRoot, result.repoLocal.configPath)}`,
        `State file: ${formatRepoRelativePath(result.repoRoot, result.repoLocal.statePath)}`,
      ]
      : []),
  ];
  const indexStateLines = [
    `State: ${result.indexPresent ? "ready" : result.readiness?.summary ?? "not initialized yet"}`,
    `Latest run: ${result.latestRunId ?? "none"}`,
    ...(mode === "status"
      ? [`Freshness: ${formatIndexFreshnessLabel(result.indexFreshness.state)}`]
      : []),
    ...(mode === "doctor"
      ? [
        `Database: ${formatRepoRelativePath(result.repoRoot, result.repoLocal.dbPath)}`,
        `Readiness checks: ${formatReadinessChecks(result.readiness)}`,
      ]
      : []),
  ];
  const nextSteps = buildProductShellStatusNextSteps(result, mode);

  return [
    `${title}\n\n`,
    formatSection("Repo state", repoStateLines),
    formatSection("Index state", indexStateLines),
    ...(mode === "doctor"
      ? [
        formatIndexFreshnessSection(result.indexFreshness),
        formatWhyItMattersSection(result.indexFreshness),
      ]
      : []),
    formatSection(`${result.agentConfig.displayName} config state`, formatAgentConfigStatusLines(result)),
    formatSection("Runtime state", formatRuntimeStatusLines(result.runtime, result.repoRoot, mode)),
    formatNextSteps(nextSteps),
  ].join("");
}

export function formatRuntimeDaemonActionResult(
  result: RuntimeDaemonActionResult,
): string {
  const title = result.action === "started"
    ? "Runtime started"
    : result.action === "already_running"
      ? "Runtime already running"
      : result.action === "stopped"
        ? "Runtime stopped"
        : "Runtime is already stopped";
  const nextSteps = result.status.running
    ? [
      `Run \`vexb daemon status ${result.status.repoRoot}\` to check the runtime again.`,
      `Run \`vexb daemon logs ${result.status.repoRoot}\` to inspect runtime output.`,
    ]
    : [`Run \`vexb daemon start ${result.status.repoRoot}\` if you want the optional background runtime.`];

  return [
    `${title}\n\n`,
    formatSection("Runtime state", formatRuntimeStatusLines(result.status, result.status.repoRoot, "doctor")),
    formatNextSteps(nextSteps),
  ].join("");
}

export function formatRuntimeDaemonStatus(
  status: RuntimeDaemonStatus,
): string {
  const nextSteps = status.running
    ? [`Run \`vexb daemon logs ${status.repoRoot}\` to inspect runtime output.`]
    : [`Run \`vexb daemon start ${status.repoRoot}\` if you want the optional background runtime.`];

  return [
    "Runtime status\n\n",
    formatSection("Runtime state", formatRuntimeStatusLines(status, status.repoRoot, "doctor")),
    formatNextSteps(nextSteps),
  ].join("");
}

export function formatRuntimeDaemonLogs(input: {
  repoRoot: string;
  logPath: string;
  content: string;
}): string {
  const trimmedContent = input.content.trimEnd();

  return [
    "Runtime logs\n\n",
    formatSection("Runtime state", [
      `Repo root: ${input.repoRoot}`,
      `Log file: ${formatRepoRelativePath(input.repoRoot, input.logPath)}`,
      `Entries: ${trimmedContent.length > 0 ? "present" : "none yet"}`,
    ]),
    trimmedContent.length > 0
      ? `Log output\n${trimmedContent}\n\n`
      : "Log output\n(no log entries yet)\n\n",
    formatNextSteps([`Run \`vexb daemon status ${input.repoRoot}\` to check whether the runtime is running.`]),
  ].join("");
}

function formatCapsuleItem(item: CapsuleItem) {
  return {
    symbolId: item.symbolId,
    filePath: item.filePath,
    fqName: item.fqName,
    localName: item.localName,
    kind: item.kind,
    role: item.role,
    contentMode: item.content.mode,
    content: item.content,
    inclusionReasons: item.inclusionReasons,
    budgetCost: item.budgetCost,
    compressed: item.compressed,
    ...(item.sourceBacked === true ? { sourceBacked: true } : {}),
    ...(item.lexicalScore === undefined ? {} : { lexicalScore: item.lexicalScore }),
    ...(item.graphScore === undefined ? {} : { graphScore: item.graphScore }),
    ...(item.finalScore === undefined ? {} : { finalScore: item.finalScore }),
  };
}

function formatSection(title: string, lines: readonly string[]): string {
  return `${title}\n${lines.map((line) => `- ${line}`).join("\n")}\n\n`;
}

function formatNextSteps(steps: readonly string[]): string {
  const effectiveSteps = steps.length > 0 ? steps : ["No action needed."];
  return formatSection("Next steps", effectiveSteps);
}

function formatRepoRelativePath(repoRoot: string, targetPath: string): string {
  const relativePath = path.relative(repoRoot, targetPath);

  if (relativePath.length === 0) {
    return ".";
  }

  if (!relativePath.startsWith("..")) {
    return relativePath.split(path.sep).join("/");
  }

  return targetPath;
}

function formatLauncher(input: { command: string; args: readonly string[] }): string {
  return [input.command, ...input.args].map(formatShellArg).join(" ");
}

function formatShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function formatIndexFreshnessSection(
  freshness: IndexFreshnessResult,
): string {
  const lines = [
    "Index freshness",
    `- State: ${formatIndexFreshnessLabel(freshness.state)}`,
    `- ${freshness.summary}`,
  ];

  if (freshness.reasons.length > 0) {
    lines.push("- Why:");

    for (const reason of freshness.reasons) {
      lines.push(`  - ${formatIndexFreshnessReason(reason)}`);
    }
  }

  return `${lines.join("\n")}\n\n`;
}

function formatWhyItMattersSection(
  freshness: IndexFreshnessResult,
): string {
  if (freshness.whyItMatters === undefined) {
    return "";
  }

  return `Why this matters\n- ${freshness.whyItMatters}\n\n`;
}

function formatIndexFreshnessLabel(
  state: IndexFreshnessResult["state"],
): string {
  return state === "possibly_stale" ? "possibly stale" : state;
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
  }
}

function buildProductShellStatusNextSteps(
  result: ProductShellStatus,
  mode: "status" | "doctor",
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
      if (mode === "doctor") {
        return ["No re-index is recommended right now."];
      }

      return [
        `Open ${result.agentConfig.displayName} in this repo; vexb can use the current indexed snapshot as-is.`,
        ...(!result.runtime.running
          ? ["Start the runtime daemon only if you want an inspectable background process."]
          : []),
      ];
    case "possibly_stale":
      return mode === "doctor"
        ? ["Re-index this repo before relying on vexb for fresh structural guidance."]
        : [
          "Indexed source files appear to have changed since the last indexed snapshot.",
          "Re-index before relying on vexb for fresh structural guidance.",
        ];
    case "unknown":
      return mode === "doctor"
        ? ["Re-index if you want a fresh, explicit trust point."]
        : [
          "Vexb could not compare the current repo state to the last indexed snapshot.",
          "Run doctor for more detail.",
        ];
  }
}

function formatDetection(result: ProductShellStatus): string {
  if (result.detectionMarker === undefined) {
    return result.detectionMode === "marker"
      ? "detected from repo markers"
      : "used the provided directory";
  }

  return result.detectionMarker === ".git"
    ? "detected from .git"
    : `detected from ${result.detectionMarker}`;
}

function formatReadinessChecks(
  readiness: ProductShellStatus["readiness"],
): string {
  if (readiness === null) {
    return "none yet";
  }

  const passingChecks = readiness.checks.filter((check) => check.ok).length;
  return `${passingChecks}/${readiness.checks.length} passed`;
}

function formatAgentConfigStatusLines(
  result: ProductShellStatus,
): string[] {
  const status = result.agentConfig;
  return [
    `State: ${formatAgentConfigState(status)}`,
    `Config file: ${formatRepoRelativePath(result.repoRoot, status.configPath)}`,
    `Launcher: ${formatLauncher(status.launcher)}`,
    ...(status.error === undefined ? [] : [`Problem: ${status.error}`]),
  ];
}

function formatAgentConfigState(
  status: AgentConfigStatus,
): string {
  if (status.error !== undefined) {
    return "could not read config";
  }
  if (!status.installed) {
    return "not installed";
  }
  if (!status.matchesExpected) {
    return "installed but needs refresh";
  }

  return "installed and current";
}

function formatRuntimeStatusLines(
  status: RuntimeDaemonStatus,
  repoRoot: string,
  mode: "status" | "doctor",
): string[] {
  return [
    `State: ${status.running ? "running" : "not running"}`,
    ...(status.pid === undefined ? [] : [`PID: ${status.pid}`]),
    ...(status.serverPid === undefined ? [] : [`Server PID: ${status.serverPid}`]),
    `State file: ${formatRepoRelativePath(repoRoot, status.statePath)}`,
    `Log file: ${formatRepoRelativePath(repoRoot, status.logPath)}`,
    ...(mode === "doctor" || status.staleStatePresent
      ? [`Stale state file: ${status.staleStatePresent ? "present" : "not present"}`]
      : []),
  ];
}

function formatConfigActionLabel(
  action: AgentConfigInstallResult["action"],
): string {
  switch (action) {
    case "created":
      return "created MCP config";
    case "updated":
      return "updated MCP config";
    case "unchanged":
      return "left current config in place";
  }
}

function formatRuntimeActionLabel(
  action: SetupFlowResult["runtime"]["action"],
): string {
  switch (action) {
    case "started":
      return "started the optional background runtime";
    case "already_running":
      return "runtime was already running";
    case "stopped":
      return "stopped";
    case "not_running":
      return "already stopped";
    case "not_requested":
      return "not requested";
  }
}
