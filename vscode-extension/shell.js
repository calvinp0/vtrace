import path from "node:path";

import { AGENT_IDS, EXECUTABLE_SOURCES, describeExecutableSource } from "./cli.js";

export const COMMAND_IDS = Object.freeze({
  SetupAgent: "vtrace.setupAgent",
  ShowIndexStatus: "vtrace.showIndexStatus",
  GenerateContextCapsule: "vtrace.generateContextCapsule",
  ShowFileSkeleton: "vtrace.showFileSkeleton",
  ShowImpactGraphAtCursor: "vtrace.showImpactGraphAtCursor",
  Doctor: "vtrace.doctor",
  RefreshStatus: "vtrace.refreshStatus",
  OpenOutput: "vtrace.openOutput",
  OpenSettings: "vtrace.openSettings",
  RevealRepoRoot: "vtrace.revealRepoRoot",
  OpenAgentConfigFile: "vtrace.openAgentConfigFile",
  ShowFreshnessReport: "vtrace.showFreshnessReport",
  ShowRuntimeReport: "vtrace.showRuntimeReport",
  ShowSetupConfigReport: "vtrace.showSetupConfigReport",
  ShowExecutableResolutionReport: "vtrace.showExecutableResolutionReport",
  ShowNoWorkspaceGuidance: "vtrace.showNoWorkspaceGuidance",
  RunPipelineForCurrentTask: "vtrace.runPipelineForCurrentTask",
  SetupOrReindex: "vtrace.setupOrReindex",
});

export const BUSY_STATES = Object.freeze({
  Idle: "idle",
  RunningSetup: "running_setup",
  RunningReindex: "running_reindex",
  Failed: "failed",
  Complete: "complete",
});

export function isRunningBusy(state) {
  return state === BUSY_STATES.RunningSetup || state === BUSY_STATES.RunningReindex;
}

export const SECTION_IDS = Object.freeze({
  Overview: "overview",
  QuickActions: "quick_actions",
  CurrentAgent: "current_agent",
  OutputDiagnostics: "output_diagnostics",
});

export const EMPTY_STATE_MESSAGES = Object.freeze({
  NoWorkspace: "Open a workspace folder to use vtrace.",
  NoActiveEditor: "Open a workspace file to use this vtrace command.",
  NoSymbolAtCursor: "No indexed symbol was found at the current cursor line.",
  NotInitialized: (repoRoot) => `This repo is not set up for vtrace yet. Run \`vtrace setup ${repoRoot}\` or use vtrace: Setup Agent.`,
  NotReady: "vtrace finished setup but the index is not ready. Run vtrace: Doctor to see why.",
  StaleIndex: "vtrace detected likely drift since the last indexed snapshot. Re-indexing is recommended.",
  UnknownFreshness: "vtrace could not verify index freshness. Re-index if you want a fresh trust point.",
  CliNotFound: "vtrace executable not found. Set `vtrace.cliPath` or install vtrace on PATH.",
  BunMissing: "The bundled vtrace launcher cannot start because Bun is missing. Install Bun or set `vtrace.cliPath`.",
  NoWorkspaceHelper: "Open a folder to use vtrace in VS Code.",
  CliNotFoundHelper: "Set vtrace.cliPath or install vtrace so the extension can invoke it.",
  StaleHelper: "Indexed source files may have changed since the last indexed snapshot.",
});

export const SETUP_REINDEX_MESSAGES = Object.freeze({
  NoWorkspace: "Open a folder or workspace to set up or re-index vtrace.",
  ReadyQuickPickTitle: "VTRACE is already ready",
  ReadyQuickPickPlaceholder: "Choose what to do next",
  ReadyQuickPickReindex: "Re-index anyway",
  ReadyQuickPickShowIndexStatus: "Show Index Status",
  ReadyQuickPickDoctor: "Doctor",
  ReadyQuickPickCancel: "Cancel",
});

export const RUN_PIPELINE_MESSAGES = Object.freeze({
  InputTitle: "Run vtrace Pipeline",
  InputPlaceholder: "Describe the coding task you want vtrace to analyze",
  InputPrompt: "Describe the coding task you want vtrace to analyze.",
  EmptyInput: "Enter a task description to run vtrace pipeline.",
  NoWorkspace: "Open a folder or workspace to run vtrace pipeline tasks.",
  NotInitialized: "This repo is not initialized for vtrace yet. Run Setup Agent first.",
  IndexNotReady: "The vtrace index is not ready yet. Finish setup or indexing, then try again.",
});

export const EDITOR_EMPTY_STATE_MESSAGES = Object.freeze({
  FileSkeleton: Object.freeze({
    NoWorkspace: "Open a folder or workspace to use vtrace file commands.",
    NoActiveEditor: "Open a file in the workspace to show its skeleton.",
    OutsideWorkspace: "The active file is not inside the current workspace. Open a workspace file to use vtrace file skeletons.",
    UnsupportedFile: "The active file is not a supported indexed source file for vtrace skeleton output.",
    NotInitialized: "This repo is not initialized for vtrace yet. Run Setup Agent first.",
    IndexNotReady: "The vtrace index is not ready yet. Finish setup or indexing, then try again.",
  }),
  ImpactGraph: Object.freeze({
    NoWorkspace: "Open a folder or workspace to use vtrace symbol commands.",
    NoActiveEditor: "Open a workspace file and place the cursor on a symbol to show its impact graph.",
    NoSymbolAtCursor: "Place the cursor on a symbol to show its impact graph.",
    SymbolNotResolved: "Vtrace could not resolve the symbol at the cursor to an exact indexed symbol.",
    NotInitialized: "This repo is not initialized for vtrace yet. Run Setup Agent first.",
    IndexNotReady: "The vtrace index is not ready yet. Finish setup or indexing, then try again.",
  }),
});

export function parseShellJson(raw) {
  const parsed = JSON.parse(raw);

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("vtrace returned a non-object JSON payload.");
  }

  if (typeof parsed.command !== "string" || typeof parsed.ok !== "boolean") {
    throw new Error("vtrace returned a malformed shell JSON payload.");
  }

  return parsed;
}

export function createNoWorkspaceSnapshot() {
  return {
    kind: "no_workspace",
    state: "no_workspace",
    repoRoot: null,
    latestRunId: null,
    freshnessState: "unknown",
    runtimeRunning: false,
    runtimeStatus: "unknown",
    initialized: false,
    readinessStatus: null,
    agents: [],
    defaultAgentId: null,
    executable: null,
    message: EMPTY_STATE_MESSAGES.NoWorkspace,
  };
}

export function createUnavailableSnapshot(message, workspaceRoot = null, executable = null) {
  return {
    kind: "unavailable",
    state: "unavailable",
    repoRoot: workspaceRoot,
    latestRunId: null,
    freshnessState: "unknown",
    runtimeRunning: false,
    runtimeStatus: "unknown",
    initialized: false,
    readinessStatus: null,
    agents: [],
    defaultAgentId: null,
    executable,
    message,
  };
}

export function createCliUnavailableSnapshot(message, workspaceRoot, executable) {
  return {
    kind: "cli_unavailable",
    state: "cli_unavailable",
    repoRoot: workspaceRoot,
    latestRunId: null,
    freshnessState: "unknown",
    runtimeRunning: false,
    runtimeStatus: "unknown",
    initialized: false,
    readinessStatus: null,
    agents: [],
    defaultAgentId: null,
    executable,
    message,
  };
}

export function buildRepoSnapshot(statusEnvelope, additionalAgentEnvelopes = [], executable = null) {
  const result = statusEnvelope.result;

  if (!statusEnvelope.ok || result === null || typeof result !== "object") {
    return createUnavailableSnapshot(
      statusEnvelope.error?.message ?? "vtrace status is unavailable.",
      statusEnvelope.repoRoot ?? null,
      executable,
    );
  }

  const defaultAgentId = typeof result.selectedAgent === "string" ? result.selectedAgent : AGENT_IDS.ClaudeCode;
  const agents = dedupeAgents([
    toAgentSummary(defaultAgentId, result.agentConfig),
    ...additionalAgentEnvelopes
      .map((envelope) => envelope.result?.agentConfig === undefined || envelope.result === null
        ? null
        : toAgentSummary(envelope.result.selectedAgent, envelope.result.agentConfig))
      .filter((agent) => agent !== null),
  ]);
  const readinessStatus = result.indexState.readiness?.status ?? null;
  const initialized = result.repoState.initialized === true;
  const freshnessState = result.indexState.freshness.state;
  const runtimeRunning = result.runtime.running === true;

  return {
    kind: "repo",
    state: computeRepoState({
      initialized,
      readinessStatus,
      freshnessState,
    }),
    repoRoot: statusEnvelope.repoRoot,
    latestRunId: result.indexState.latestRunId,
    freshnessState,
    runtimeRunning,
    runtimeStatus: result.runtime.status,
    initialized,
    readinessStatus,
    readinessSummary: result.indexState.readiness?.summary ?? "Repo is not initialized yet.",
    freshnessSummary: result.indexState.freshness.summary,
    freshnessRecommendedAction: result.indexState.freshness.recommendedAction,
    nextSteps: Array.isArray(statusEnvelope.nextSteps) ? [...statusEnvelope.nextSteps] : [],
    warnings: Array.isArray(statusEnvelope.warnings) ? [...statusEnvelope.warnings] : [],
    agents,
    defaultAgentId,
    executable,
    rawStatus: result,
  };
}

export function primaryStatusCommand(snapshot) {
  if (snapshot.kind === "no_workspace") {
    return COMMAND_IDS.ShowNoWorkspaceGuidance;
  }
  if (snapshot.kind === "cli_unavailable") {
    return COMMAND_IDS.ShowExecutableResolutionReport;
  }
  if (snapshot.kind === "unavailable") {
    return COMMAND_IDS.Doctor;
  }
  if (snapshot.state === "not_initialized") {
    return COMMAND_IDS.ShowSetupConfigReport;
  }
  if (snapshot.state === "stale") {
    return COMMAND_IDS.ShowFreshnessReport;
  }
  if (snapshot.state === "unknown" || snapshot.state === "not_ready") {
    return COMMAND_IDS.Doctor;
  }
  return COMMAND_IDS.ShowIndexStatus;
}

export function buildRepoTreeSections(snapshot, options = {}) {
  const busyState = options.busyState ?? BUSY_STATES.Idle;
  return [
    { id: SECTION_IDS.Overview, label: "OVERVIEW", icon: "dashboard", children: buildOverviewRows(snapshot, busyState) },
    { id: SECTION_IDS.QuickActions, label: "QUICK ACTIONS", icon: "zap", children: buildQuickActionRows(busyState) },
    { id: SECTION_IDS.CurrentAgent, label: "CURRENT AGENT", icon: "hubot", children: buildCurrentAgentRows(snapshot) },
    { id: SECTION_IDS.OutputDiagnostics, label: "OUTPUT & DIAGNOSTICS", icon: "pulse", children: buildOutputDiagnosticsRows(snapshot) },
  ];
}

export function buildPrimaryStatus(snapshot, busyState = BUSY_STATES.Idle) {
  if (isRunningBusy(busyState)) {
    return {
      label: "Indexing…",
      description: busyState === BUSY_STATES.RunningSetup
        ? "Setting up and indexing this repo…"
        : "Re-indexing this repo…",
      tooltip: "vtrace is preparing this repo. Open the vtrace output channel for progress.",
      icon: "sync",
    };
  }
  if (snapshot.kind === "no_workspace") {
    return {
      label: "No workspace",
      description: EMPTY_STATE_MESSAGES.NoWorkspaceHelper,
      tooltip: snapshot.message,
      icon: "folder",
    };
  }

  if (snapshot.kind === "cli_unavailable") {
    return {
      label: "VTRACE not found",
      description: EMPTY_STATE_MESSAGES.CliNotFoundHelper,
      tooltip: snapshot.message,
      icon: "error",
    };
  }

  if (snapshot.kind === "unavailable") {
    return {
      label: "Unknown state",
      description: "vtrace status is unavailable",
      tooltip: snapshot.message,
      icon: "warning",
    };
  }

  if (snapshot.state === "not_initialized") {
    return {
      label: "Not initialized",
      description: basenameOrEmpty(snapshot.repoRoot),
      tooltip: snapshot.readinessSummary,
      icon: "info",
    };
  }

  if (snapshot.state === "not_ready") {
    return {
      label: "Unknown state",
      description: "setup incomplete",
      tooltip: snapshot.readinessSummary,
      icon: "warning",
    };
  }

  if (snapshot.state === "stale") {
    return {
      label: "Possibly stale",
      description: EMPTY_STATE_MESSAGES.StaleHelper,
      tooltip: snapshot.freshnessRecommendedAction ?? snapshot.freshnessSummary,
      icon: "warning",
    };
  }

  if (snapshot.state === "unknown") {
    return {
      label: "Unknown state",
      description: "freshness unknown",
      tooltip: snapshot.freshnessRecommendedAction ?? snapshot.freshnessSummary,
      icon: "question",
    };
  }

  return {
    label: "Ready",
    description: basenameOrEmpty(snapshot.repoRoot),
    tooltip: snapshot.readinessSummary ?? "Repo is ready.",
    icon: "pass",
  };
}

export function buildStatusBarState(snapshot, busyState = BUSY_STATES.Idle) {
  if (isRunningBusy(busyState)) {
    return {
      text: "$(sync~spin) vtrace: indexing…",
      tooltip: busyState === BUSY_STATES.RunningSetup
        ? "vtrace is setting up and indexing this repo."
        : "vtrace is re-indexing this repo.",
      command: COMMAND_IDS.OpenOutput,
      color: undefined,
    };
  }

  if (snapshot.kind === "no_workspace") {
    return {
      text: "$(circle-slash) vtrace: no workspace",
      tooltip: snapshot.message,
      command: COMMAND_IDS.ShowIndexStatus,
      color: undefined,
    };
  }

  if (snapshot.kind === "cli_unavailable") {
    return {
      text: "$(error) vtrace: CLI missing",
      tooltip: snapshot.message,
      command: COMMAND_IDS.OpenSettings,
      color: "statusBarItem.errorForeground",
    };
  }

  if (snapshot.kind === "unavailable") {
    return {
      text: "$(alert) vtrace: unavailable",
      tooltip: snapshot.message,
      command: COMMAND_IDS.OpenOutput,
      color: "statusBarItem.warningForeground",
    };
  }

  if (snapshot.state === "not_initialized") {
    return {
      text: "$(circle-slash) vtrace: not initialized",
      tooltip: snapshot.nextSteps[0] ?? snapshot.readinessSummary,
      command: COMMAND_IDS.SetupAgent,
      color: "statusBarItem.warningForeground",
    };
  }

  if (snapshot.state === "not_ready") {
    return {
      text: "$(circle-slash) vtrace: setup incomplete",
      tooltip: snapshot.nextSteps[0] ?? snapshot.readinessSummary,
      command: COMMAND_IDS.Doctor,
      color: "statusBarItem.warningForeground",
    };
  }

  if (snapshot.state === "stale") {
    return {
      text: "$(warning) vtrace: stale",
      tooltip: snapshot.freshnessRecommendedAction ?? snapshot.freshnessSummary,
      command: COMMAND_IDS.Doctor,
      color: "statusBarItem.warningForeground",
    };
  }

  if (snapshot.state === "unknown") {
    return {
      text: "$(question) vtrace: freshness unknown",
      tooltip: snapshot.freshnessRecommendedAction ?? snapshot.freshnessSummary,
      command: COMMAND_IDS.Doctor,
      color: "statusBarItem.warningForeground",
    };
  }

  return {
    text: "$(check) vtrace: ready",
    tooltip: [
      snapshot.repoRoot,
      snapshot.latestRunId === null ? "No index run recorded." : `Latest run: #${snapshot.latestRunId}`,
      snapshot.runtimeRunning ? "Runtime: running" : "Runtime: off",
      snapshot.executable ? `Executable: ${snapshot.executable.command} (${describeExecutableSource(snapshot.executable.source)})` : null,
    ].filter(Boolean).join("\n"),
    command: COMMAND_IDS.ShowIndexStatus,
    color: undefined,
  };
}

export function findSymbolAtLine(symbols, lineNumber) {
  const matches = symbols.filter((symbol) => symbol.startLine <= lineNumber && symbol.endLine >= lineNumber);

  if (matches.length === 0) {
    return null;
  }

  return matches.sort((left, right) => {
    const leftSpan = left.endLine - left.startLine;
    const rightSpan = right.endLine - right.startLine;
    return leftSpan - rightSpan
      || right.startLine - left.startLine
      || left.fqName.localeCompare(right.fqName);
  })[0];
}

export function buildResultDocumentBody(title, stdout, meta = {}) {
  const header = [
    `# ${title}`,
    meta.repoRoot ? `Repo: ${meta.repoRoot}` : null,
    meta.command ? `Command: ${meta.command}` : null,
    meta.executable ? `Executable: ${meta.executable.command} (${describeExecutableSource(meta.executable.source)})` : null,
    meta.generatedAt ? `Generated: ${meta.generatedAt}` : null,
  ].filter(Boolean).join("\n");

  const body = (stdout ?? "").replace(/\s+$/u, "");

  return `${header}\n\n${body}\n`;
}

export function buildResultDocumentUri(title, counter) {
  const safeTitle = String(title).replace(/[^A-Za-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return `vtrace:/results/${counter.toString().padStart(4, "0")}-${safeTitle || "result"}.md`;
}

export function selectPrimaryAgent(snapshot) {
  if (snapshot.agents.length === 0) {
    return null;
  }

  const defaultId = snapshot.defaultAgentId ?? AGENT_IDS.ClaudeCode;
  const preferred = snapshot.agents.find((agent) => agent.id === defaultId && agent.installed);
  if (preferred !== undefined) {
    return preferred;
  }

  const anyInstalled = snapshot.agents.find((agent) => agent.installed);
  if (anyInstalled !== undefined) {
    return anyInstalled;
  }

  return snapshot.agents.find((agent) => agent.id === defaultId) ?? snapshot.agents[0];
}

function buildOverviewRows(snapshot, busyState = BUSY_STATES.Idle) {
  const primary = buildPrimaryStatus(snapshot, busyState);

  return [
    {
      label: primary.label,
      description: primary.description,
      tooltip: primary.tooltip,
      icon: primary.icon,
      command: primaryStatusCommand(snapshot),
    },
    buildRepoRootRow(snapshot),
    buildSetupRow(snapshot),
    buildIndexRow(snapshot),
    buildLatestRunRow(snapshot),
    buildFreshnessRow(snapshot),
    buildRuntimeRow(snapshot),
  ];
}

function buildQuickActionRows(busyState = BUSY_STATES.Idle) {
  const running = isRunningBusy(busyState);
  const setupRow = running
    ? {
      label: "Setup / Re-index",
      description: busyState === BUSY_STATES.RunningSetup ? "Setting up…" : "Re-indexing…",
      tooltip: "A setup or re-index run is already in progress.",
      icon: "sync",
      command: COMMAND_IDS.OpenOutput,
    }
    : {
      label: "Setup / Re-index",
      description: "Make vtrace ready for this repo",
      tooltip: "State-aware setup or re-index for the current repo.",
      icon: "wand",
      command: COMMAND_IDS.SetupOrReindex,
    };
  return [
    {
      label: "Refresh",
      description: "Reload vtrace repo state",
      tooltip: "Re-run vtrace status and refresh the sidebar.",
      icon: "refresh",
      command: COMMAND_IDS.RefreshStatus,
    },
    {
      label: "Run Pipeline for Current Task",
      description: "Prompt for a task and run the vtrace pipeline",
      tooltip: "Run vtrace run_pipeline for a natural-language task description.",
      icon: "rocket",
      command: COMMAND_IDS.RunPipelineForCurrentTask,
    },
    setupRow,
    {
      label: "Show File Skeleton",
      description: "Show structure of current file",
      tooltip: "Run vtrace skeleton for the active editor.",
      icon: "symbol-structure",
      command: COMMAND_IDS.ShowFileSkeleton,
    },
    {
      label: "Show Impact Graph",
      description: "Show dependents for symbol at cursor",
      tooltip: "Run vtrace impact-graph for the symbol at the cursor.",
      icon: "type-hierarchy",
      command: COMMAND_IDS.ShowImpactGraphAtCursor,
    },
  ];
}

function buildCurrentAgentRows(snapshot) {
  const primaryAgent = selectPrimaryAgent(snapshot);
  const selectedValue = snapshot.kind === "repo"
    ? (primaryAgent !== null ? primaryAgent.id : "none")
    : "none";
  const agentIsHealthy = primaryAgent !== null && primaryAgent.installed && primaryAgent.matchesExpected;
  const selectedCommand = snapshot.kind === "repo" && agentIsHealthy
    ? COMMAND_IDS.ShowSetupConfigReport
    : COMMAND_IDS.SetupAgent;
  const configCommand = snapshot.kind === "repo" && agentIsHealthy
    ? COMMAND_IDS.ShowSetupConfigReport
    : COMMAND_IDS.SetupAgent;

  return [
    {
      label: "Selected",
      description: selectedValue,
      tooltip: primaryAgent !== null
        ? `${primaryAgent.label} is the currently selected vtrace agent.`
        : "No vtrace agent is selected for this workspace.",
      icon: "hubot",
      command: selectedCommand,
    },
    {
      label: "Config",
      description: formatAgentConfigDescription(snapshot, primaryAgent),
      tooltip: formatAgentConfigTooltip(snapshot, primaryAgent),
      icon: agentConfigIcon(snapshot, primaryAgent),
      command: configCommand,
    },
    buildAgentConfigFileRow(snapshot, primaryAgent),
  ];
}

function buildOutputDiagnosticsRows(snapshot) {
  return [
    {
      label: "Doctor",
      description: "Show detailed repo diagnostics",
      tooltip: "Run vtrace doctor for repo diagnostics.",
      icon: "pulse",
      command: COMMAND_IDS.Doctor,
    },
    {
      label: "Open vtrace Output",
      description: "Show command and diagnostic output",
      tooltip: "Show the vtrace output channel.",
      icon: "output",
      command: COMMAND_IDS.OpenOutput,
    },
    buildExecutableResolutionRow(snapshot),
  ];
}

function buildRepoRootRow(snapshot) {
  if (snapshot.repoRoot === null || snapshot.repoRoot === undefined) {
    return {
      label: "Repo root",
      description: "No workspace open",
      tooltip: EMPTY_STATE_MESSAGES.NoWorkspaceHelper,
      icon: "folder",
      command: COMMAND_IDS.RevealRepoRoot,
    };
  }

  return {
    label: "Repo root",
    description: snapshot.repoRoot,
    tooltip: snapshot.repoRoot,
    icon: "folder-opened",
    command: COMMAND_IDS.RevealRepoRoot,
  };
}

function buildSetupRow(snapshot) {
  if (snapshot.kind !== "repo") {
    return {
      label: "Setup",
      description: "unknown",
      tooltip: "vtrace setup state could not be determined.",
      icon: "question",
    };
  }

  if (snapshot.initialized) {
    return {
      label: "Setup",
      description: "initialized",
      tooltip: snapshot.readinessSummary ?? "This repo is set up for vtrace.",
      icon: "check",
    };
  }

  return {
    label: "Setup",
    description: "not initialized",
    tooltip: snapshot.readinessSummary ?? "This repo is not set up for vtrace yet.",
    icon: "warning",
  };
}

function buildIndexRow(snapshot) {
  if (snapshot.kind !== "repo") {
    return {
      label: "Index",
      description: "unknown",
      tooltip: "vtrace index state could not be determined.",
      icon: "question",
    };
  }

  if (!snapshot.initialized) {
    return {
      label: "Index",
      description: "not initialized yet",
      tooltip: "Run vtrace setup to initialize the index.",
      icon: "circle-slash",
    };
  }

  if (snapshot.readinessStatus === "ready") {
    return {
      label: "Index",
      description: "ready",
      tooltip: snapshot.readinessSummary ?? "The repo index is ready.",
      icon: "database",
    };
  }

  return {
    label: "Index",
    description: "unknown",
    tooltip: snapshot.readinessSummary ?? "The vtrace index readiness is not conclusive.",
    icon: "question",
  };
}

function buildLatestRunRow(snapshot) {
  if (snapshot.kind !== "repo" || snapshot.latestRunId === null || snapshot.latestRunId === undefined) {
    return {
      label: "Latest run",
      description: "none",
      tooltip: "No index run has been recorded for this repo.",
      icon: "history",
    };
  }

  return {
    label: "Latest run",
    description: `#${snapshot.latestRunId}`,
    tooltip: `Latest indexed run: #${snapshot.latestRunId}`,
    icon: "history",
  };
}

function buildFreshnessRow(snapshot) {
  const base = {
    label: "Freshness",
    command: COMMAND_IDS.ShowFreshnessReport,
  };

  if (snapshot.kind !== "repo") {
    return {
      ...base,
      description: "unknown",
      tooltip: "vtrace freshness could not be determined.",
      icon: "question",
    };
  }

  if (snapshot.freshnessState === "fresh") {
    return {
      ...base,
      description: "fresh",
      tooltip: snapshot.freshnessSummary ?? "The index matches the current repo.",
      icon: "check",
    };
  }

  if (snapshot.freshnessState === "possibly_stale") {
    return {
      ...base,
      description: "possibly stale",
      tooltip: snapshot.freshnessRecommendedAction ?? snapshot.freshnessSummary ?? EMPTY_STATE_MESSAGES.StaleHelper,
      icon: "warning",
    };
  }

  return {
    ...base,
    description: "unknown",
    tooltip: snapshot.freshnessSummary ?? "Freshness could not be verified.",
    icon: "question",
  };
}

function buildRuntimeRow(snapshot) {
  const base = { label: "Runtime", command: COMMAND_IDS.ShowRuntimeReport };

  if (snapshot.kind !== "repo") {
    return {
      ...base,
      description: "unknown",
      tooltip: "Runtime daemon state could not be determined.",
      icon: "question",
    };
  }

  if (snapshot.runtimeRunning) {
    return {
      ...base,
      description: "running",
      tooltip: "The optional vtrace runtime daemon is running.",
      icon: "play-circle",
    };
  }

  return {
    ...base,
    description: "not running",
    tooltip: "The optional vtrace runtime daemon is not running.",
    icon: "circle-slash",
  };
}

function buildExecutableResolutionRow(snapshot) {
  const executable = snapshot.executable;

  return {
    label: "Executable Resolution",
    description: formatExecutableResolution(executable),
    tooltip: formatExecutableTooltip(executable),
    icon: executable?.source === EXECUTABLE_SOURCES.Missing || executable === null || executable === undefined
      ? "search"
      : "terminal",
    command: COMMAND_IDS.ShowExecutableResolutionReport,
  };
}

function buildAgentConfigFileRow(snapshot, primaryAgent) {
  if (primaryAgent === null || primaryAgent.configPath === null || primaryAgent.configPath === undefined) {
    return {
      label: "Config file",
      description: "unknown",
      tooltip: "No vtrace agent config path is known for this workspace.",
      icon: "file-code",
      command: COMMAND_IDS.OpenAgentConfigFile,
    };
  }

  const display = snapshot.repoRoot !== null && snapshot.repoRoot !== undefined
    ? relativePath(snapshot.repoRoot, primaryAgent.configPath)
    : primaryAgent.configPath;

  return {
    label: "Config file",
    description: display,
    tooltip: primaryAgent.configPath,
    icon: "file-code",
    command: COMMAND_IDS.OpenAgentConfigFile,
  };
}

function formatExecutableResolution(executable) {
  if (executable === null || executable === undefined) {
    return "unknown";
  }

  switch (executable.source) {
    case EXECUTABLE_SOURCES.Configured:
      return "using vtrace.cliPath";
    case EXECUTABLE_SOURCES.Bundled:
    case EXECUTABLE_SOURCES.BundledDev:
      return "using bundled bin/vtrace";
    case EXECUTABLE_SOURCES.Path:
      return "using vtrace on PATH";
    case EXECUTABLE_SOURCES.Missing:
      return "no executable found";
    default:
      return "unknown";
  }
}

function formatExecutableTooltip(executable) {
  if (executable === null || executable === undefined) {
    return "vtrace executable resolution has not run yet.";
  }

  return [
    describeExecutableSource(executable.source),
    executable.command,
    executable.attempted && executable.attempted.length > 0
      ? `Attempted:\n${executable.attempted.map((entry) => `  - ${describeExecutableSource(entry.source)}: ${entry.path}`).join("\n")}`
      : null,
  ].filter(Boolean).join("\n");
}

function formatAgentConfigDescription(snapshot, agent) {
  if (snapshot.kind !== "repo" || agent === null) {
    return "unknown";
  }

  if (!agent.installed) {
    return "missing";
  }

  return agent.matchesExpected ? "installed and current" : "out of date";
}

function formatAgentConfigTooltip(snapshot, agent) {
  if (agent === null) {
    return "No vtrace agent status was found for this workspace.";
  }

  if (snapshot.kind !== "repo") {
    return `${agent.label} status is unknown outside a ready workspace.`;
  }

  if (!agent.installed) {
    return `${agent.label}: not installed.`;
  }

  return agent.matchesExpected
    ? `${agent.label}: installed and current.`
    : `${agent.label}: installed but drifted from expected config.`;
}

function agentConfigIcon(snapshot, agent) {
  if (snapshot.kind !== "repo" || agent === null) {
    return "question";
  }

  if (!agent.installed) {
    return "warning";
  }

  return agent.matchesExpected ? "check" : "warning";
}

function relativePath(from, target) {
  const rel = path.relative(from, target);
  if (rel === "" || rel.startsWith("..")) {
    return target;
  }

  return rel;
}

function basenameOrEmpty(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return "";
  }

  const base = path.basename(candidate);
  return base.length > 0 ? base : "";
}

function dedupeAgents(agents) {
  const byId = new Map();

  for (const agent of agents) {
    byId.set(agent.id, agent);
  }

  return [...byId.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function toAgentSummary(agentId, agentConfig) {
  const displayName = typeof agentConfig.displayName === "string" && agentConfig.displayName.length > 0
    ? agentConfig.displayName
    : agentId === AGENT_IDS.Codex ? "Codex" : "Claude Code";
  const configPath = typeof agentConfig.configPath === "string" && agentConfig.configPath.length > 0
    ? agentConfig.configPath
    : null;

  return {
    id: agentId,
    label: displayName,
    installed: agentConfig.installed === true,
    matchesExpected: agentConfig.matchesExpected === true,
    configPath,
  };
}

function computeRepoState(input) {
  if (!input.initialized) {
    return "not_initialized";
  }

  if (input.readinessStatus !== "ready") {
    return "not_ready";
  }

  if (input.freshnessState === "possibly_stale") {
    return "stale";
  }

  if (input.freshnessState === "unknown") {
    return "unknown";
  }

  return "ready";
}

export function buildIndexStatusReport(snapshot) {
  const lines = ["# Index Status", ""];

  lines.push(`Repo root: ${snapshot.repoRoot ?? "(no workspace)"}`);
  lines.push(`Setup: ${snapshot.kind === "repo" ? (snapshot.initialized ? "initialized" : "not initialized") : "unknown"}`);
  lines.push(`Index: ${formatIndexDescription(snapshot)}`);
  lines.push(`Latest run: ${snapshot.latestRunId === null || snapshot.latestRunId === undefined ? "none" : `#${snapshot.latestRunId}`}`);
  lines.push(`Freshness: ${formatFreshnessOneLine(snapshot)}`);

  const nextAction = firstNextStep(snapshot) ?? defaultNextAction(snapshot);
  if (nextAction !== null) {
    lines.push("", `Next action: ${nextAction}`);
  }

  return lines.join("\n") + "\n";
}

export function buildFreshnessReport(snapshot) {
  const lines = ["# Freshness", ""];
  const freshness = snapshot.rawStatus?.indexState?.freshness ?? null;

  lines.push(`State: ${snapshot.freshnessState ?? "unknown"}`);
  if (snapshot.freshnessSummary) {
    lines.push(`Summary: ${snapshot.freshnessSummary}`);
  }

  const reasons = Array.isArray(freshness?.reasons) ? freshness.reasons : [];
  if (reasons.length > 0) {
    lines.push("", "Reasons:");
    for (const reason of reasons) {
      const count = reason.count === null || reason.count === undefined ? "" : ` (${reason.count})`;
      lines.push(`  - ${reason.message}${count}`);
    }
  }

  if (freshness?.whyItMatters) {
    lines.push("", `Why this matters: ${freshness.whyItMatters}`);
  }

  const action = snapshot.freshnessRecommendedAction ?? defaultFreshnessAction(snapshot);
  if (action !== null) {
    lines.push("", `Recommended action: ${action}`);
  }

  return lines.join("\n") + "\n";
}

export function buildRuntimeReport(snapshot) {
  const lines = ["# Runtime", ""];
  const runtime = snapshot.rawStatus?.runtime ?? null;
  const runningLabel = snapshot.kind !== "repo"
    ? "unknown"
    : snapshot.runtimeRunning ? "running" : "not running";

  lines.push(`State: ${runningLabel}`);
  if (snapshot.runtimeStatus) {
    lines.push(`Status code: ${snapshot.runtimeStatus}`);
  }
  if (runtime?.statePath) {
    lines.push(`State file: ${runtime.statePath}`);
  }
  if (runtime?.logPath) {
    lines.push(`Log file: ${runtime.logPath}`);
  }
  if (runtime?.staleStatePresent === true) {
    lines.push("", "Stale state file detected: a previous daemon did not shut down cleanly. Re-running setup or `vtrace doctor` will clean it up.");
  }

  const action = runtimeRecommendedAction(snapshot, runtime);
  if (action !== null) {
    lines.push("", `Recommended action: ${action}`);
  }

  return lines.join("\n") + "\n";
}

export function buildSetupConfigReport(snapshot) {
  const lines = ["# Setup / Config", ""];

  lines.push(`Initialized: ${snapshot.kind === "repo" ? (snapshot.initialized ? "yes" : "no") : "unknown"}`);

  if (snapshot.agents.length === 0) {
    lines.push("Selected agent: none");
  } else {
    const primary = selectPrimaryAgent(snapshot);
    lines.push(`Selected agent: ${primary !== null ? primary.id : "none"}`);
    lines.push("", "Agents:");
    for (const agent of snapshot.agents) {
      const configState = !agent.installed
        ? "not installed"
        : agent.matchesExpected ? "installed and current" : "installed but drifted";
      lines.push(`  - ${agent.label} (${agent.id}): ${configState}`);
      if (agent.configPath !== null && agent.configPath !== undefined) {
        lines.push(`      config file: ${agent.configPath}`);
      }
    }
  }

  const action = setupRecommendedAction(snapshot);
  if (action !== null) {
    lines.push("", `Recommended action: ${action}`);
  }

  return lines.join("\n") + "\n";
}

export function buildExecutableResolutionReport(executable, fallbackMessage = null) {
  const lines = ["# Executable Resolution", ""];

  if (executable === null || executable === undefined) {
    lines.push("No vtrace executable resolution has been recorded yet.");
    if (fallbackMessage) {
      lines.push("", fallbackMessage);
    }
    lines.push("", "Next step: set `vtrace.cliPath` in VS Code Settings to an absolute path, or install vtrace on PATH.");
    return lines.join("\n") + "\n";
  }

  lines.push(`Resolved path: ${executable.command}`);
  lines.push(`Source: ${describeExecutableSource(executable.source)} (${executableSourceShortLabel(executable.source)})`);

  if (Array.isArray(executable.attempted) && executable.attempted.length > 0) {
    lines.push("", "Resolution order tried:");
    for (const entry of executable.attempted) {
      lines.push(`  - ${describeExecutableSource(entry.source)}: ${entry.path}`);
    }
  }

  if (fallbackMessage) {
    lines.push("", `Failure: ${fallbackMessage}`);
  }

  if (executable.source === EXECUTABLE_SOURCES.Missing) {
    lines.push("", "Next step: set `vtrace.cliPath` in VS Code Settings to an absolute path, or install vtrace on PATH.");
  } else {
    lines.push("", "To override: set `vtrace.cliPath` in VS Code Settings.");
  }

  return lines.join("\n") + "\n";
}

function formatIndexDescription(snapshot) {
  if (snapshot.kind !== "repo") {
    return "unknown";
  }
  if (!snapshot.initialized) {
    return "not initialized yet";
  }
  if (snapshot.readinessStatus === "ready") {
    return "ready";
  }
  return "unknown";
}

function formatFreshnessOneLine(snapshot) {
  if (snapshot.kind !== "repo") {
    return "unknown";
  }
  if (snapshot.freshnessState === "fresh") {
    return "fresh";
  }
  if (snapshot.freshnessState === "possibly_stale") {
    return "possibly stale";
  }
  return "unknown";
}

function firstNextStep(snapshot) {
  const step = snapshot.nextSteps?.[0];
  return typeof step === "string" && step.length > 0 ? step : null;
}

function defaultNextAction(snapshot) {
  if (snapshot.kind === "no_workspace") {
    return EMPTY_STATE_MESSAGES.NoWorkspaceHelper;
  }
  if (snapshot.kind === "cli_unavailable") {
    return EMPTY_STATE_MESSAGES.CliNotFoundHelper;
  }
  if (snapshot.kind !== "repo") {
    return null;
  }
  if (!snapshot.initialized) {
    return "Run Setup Agent to initialize and index the repo.";
  }
  if (snapshot.state === "stale") {
    return "Re-index this repo to refresh the vtrace snapshot.";
  }
  return null;
}

function defaultFreshnessAction(snapshot) {
  if (snapshot.freshnessState === "fresh") {
    return null;
  }
  if (snapshot.freshnessState === "possibly_stale") {
    return "Re-run vtrace setup or index to refresh the snapshot.";
  }
  return "Re-index the repo to establish a fresh trust point.";
}

function runtimeRecommendedAction(snapshot, runtime) {
  if (snapshot.kind !== "repo") {
    return "Open a workspace and run Setup Agent if you need the optional runtime daemon.";
  }
  if (snapshot.runtimeRunning) {
    return null;
  }
  if (runtime?.staleStatePresent === true) {
    return "Run vtrace doctor to clean up the stale runtime state file.";
  }
  return "The runtime daemon is optional. Start it only if a vtrace command needs it.";
}

function setupRecommendedAction(snapshot) {
  if (snapshot.kind !== "repo") {
    return "Open a workspace to manage vtrace setup.";
  }
  if (!snapshot.initialized) {
    return "Run Setup Agent to initialize vtrace for this repo.";
  }
  const primary = selectPrimaryAgent(snapshot);
  if (primary !== null && (!primary.installed || !primary.matchesExpected)) {
    return `Run Setup Agent to install or refresh the ${primary.label} config.`;
  }
  return null;
}

function executableSourceShortLabel(source) {
  switch (source) {
    case EXECUTABLE_SOURCES.Configured:
      return "setting";
    case EXECUTABLE_SOURCES.Bundled:
    case EXECUTABLE_SOURCES.BundledDev:
      return "bundled";
    case EXECUTABLE_SOURCES.Path:
      return "PATH";
    case EXECUTABLE_SOURCES.Missing:
      return "missing";
    default:
      return "unknown";
  }
}
