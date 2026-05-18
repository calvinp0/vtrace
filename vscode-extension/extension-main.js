import path from "node:path";

import {
  AGENT_IDS,
  EXECUTABLE_SOURCES,
  buildCapsuleArgs,
  buildExpandVexpRefArgs,
  buildImpactGraphArgs,
  buildIndexArgs,
  buildInspectFileArgs,
  buildRunPipelineArgs,
  buildSetupArgs,
  buildSkeletonArgs,
  buildStatusArgs,
  createCliBridge,
  describeExecutableSource,
} from "./cli.js";
import {
  BUSY_STATES,
  COMMAND_IDS,
  EDITOR_EMPTY_STATE_MESSAGES,
  EMPTY_STATE_MESSAGES,
  RUN_PIPELINE_MESSAGES,
  SECTION_IDS,
  SETUP_REINDEX_MESSAGES,
  buildRepoSnapshot,
  buildRepoTreeSections,
  buildResultDocumentBody,
  buildResultDocumentUri,
  buildStatusBarState,
  createCliUnavailableSnapshot,
  createNoWorkspaceSnapshot,
  createUnavailableSnapshot,
  findSymbolAtLine,
  isRunningBusy,
  selectPrimaryAgent,
} from "./shell.js";
import { RESULT_TYPES, ResultPanelController } from "./resultPanel.js";

export const RESULT_DOC_SCHEME = "vexb";

export async function activate(context) {
  const vscode = await import("vscode");
  return await activateWithVscode(vscode, context);
}

export async function activateWithVscode(vscode, context, overrides = {}) {
  const output = overrides.outputChannel ?? vscode.window.createOutputChannel("vexb");
  const statusBarItem = overrides.statusBarItem
    ?? vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const cli = overrides.cliBridge ?? createCliBridge({
    extensionPath: context.extensionPath,
    getConfiguredCliPath: () => vscode.workspace.getConfiguration("vexb").get("cliPath", ""),
    execFile: overrides.execFile,
    fileExists: overrides.fileExists,
  });
  const repoStatusProvider = overrides.repoStatusProvider ?? new RepoStatusProvider(vscode);
  const resultDocumentStore = overrides.resultDocumentStore ?? new ResultDocumentStore();
  const resultPanel = overrides.resultPanel ?? new ResultPanelController(vscode);
  if (overrides.expandVexpRef !== undefined) {
    resultPanel.setExpandVexpRefHandler(overrides.expandVexpRef);
  } else {
    resultPanel.setExpandVexpRefHandler(async (request) => expandVexpRefViaCli(cli, output, request));
  }
  const app = {
    vscode,
    output,
    statusBarItem,
    cli,
    repoStatusProvider,
    resultDocumentStore,
    resultPanel,
    snapshot: createNoWorkspaceSnapshot(),
    busyState: BUSY_STATES.Idle,
    refreshPromise: null,
    refreshQueued: false,
  };

  context.subscriptions.push(output, statusBarItem, repoStatusProvider);
  context.subscriptions.push({ dispose: () => resultPanel.dispose() });

  if (overrides.registerTextDocumentContentProvider !== false) {
    const register = overrides.registerTextDocumentContentProvider
      ?? vscode.workspace.registerTextDocumentContentProvider.bind(vscode.workspace);
    context.subscriptions.push(register(RESULT_DOC_SCHEME, resultDocumentStore));
  }

  if (overrides.createTreeView !== false) {
    const treeView = (overrides.createTreeView ?? vscode.window.createTreeView)("vexb.repoStatus", {
      treeDataProvider: repoStatusProvider,
      showCollapseAll: false,
    });
    context.subscriptions.push(treeView);
  }

  const handlers = createCommandHandlers(app);
  registerExtensionCommands(vscode, context, handlers);

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refreshStatus(app);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      void refreshStatus(app);
    }),
    vscode.window.onDidChangeWindowState((event) => {
      if (event.focused) {
        void refreshStatus(app);
      }
    }),
  );

  await refreshStatus(app);
  return app;
}

export async function deactivate() {}

export function registerExtensionCommands(vscode, context, handlers) {
  for (const definition of getCommandDefinitions()) {
    context.subscriptions.push(
      vscode.commands.registerCommand(definition.id, handlers[definition.key]),
    );
  }
}

export function getCommandDefinitions() {
  return [
    { id: COMMAND_IDS.SetupAgent, key: "setupAgent" },
    { id: COMMAND_IDS.ShowIndexStatus, key: "showIndexStatus" },
    { id: COMMAND_IDS.GenerateContextCapsule, key: "generateContextCapsule" },
    { id: COMMAND_IDS.ShowFileSkeleton, key: "showFileSkeleton" },
    { id: COMMAND_IDS.ShowImpactGraphAtCursor, key: "showImpactGraphAtCursor" },
    { id: COMMAND_IDS.Doctor, key: "doctor" },
    { id: COMMAND_IDS.RefreshStatus, key: "refreshStatus" },
    { id: COMMAND_IDS.OpenOutput, key: "openOutput" },
    { id: COMMAND_IDS.OpenSettings, key: "openSettings" },
    { id: COMMAND_IDS.RevealRepoRoot, key: "revealRepoRoot" },
    { id: COMMAND_IDS.OpenAgentConfigFile, key: "openAgentConfigFile" },
    { id: COMMAND_IDS.ShowFreshnessReport, key: "showFreshnessReport" },
    { id: COMMAND_IDS.ShowRuntimeReport, key: "showRuntimeReport" },
    { id: COMMAND_IDS.ShowSetupConfigReport, key: "showSetupConfigReport" },
    { id: COMMAND_IDS.ShowExecutableResolutionReport, key: "showExecutableResolutionReport" },
    { id: COMMAND_IDS.ShowNoWorkspaceGuidance, key: "showNoWorkspaceGuidance" },
    { id: COMMAND_IDS.RunPipelineForCurrentTask, key: "runPipelineForCurrentTask" },
    { id: COMMAND_IDS.SetupOrReindex, key: "setupOrReindex" },
  ];
}

function createCommandHandlers(app) {
  return {
    setupAgent: async () => {
      const workspace = getPrimaryWorkspaceFolder(app.vscode);

      if (workspace === null) {
        app.vscode.window.showErrorMessage(EMPTY_STATE_MESSAGES.NoWorkspace);
        return;
      }

      const agentId = await pickAgent(app.vscode);

      if (agentId === null) {
        return;
      }

      await runTextCommand(app, {
        title: "Setup Agent",
        args: buildSetupArgs(workspace.repoRoot, agentId),
        cwd: workspace.repoRoot,
      });
    },

    showIndexStatus: async () => {
      await refreshStatus(app);
      app.resultPanel.showResult({
        type: RESULT_TYPES.IndexStatus,
        repoRoot: app.snapshot.repoRoot,
        snapshot: app.snapshot,
        rawData: app.snapshot.rawStatus ?? null,
      });
    },

    showFreshnessReport: async () => {
      await refreshStatus(app);
      app.resultPanel.showResult({
        type: RESULT_TYPES.Freshness,
        repoRoot: app.snapshot.repoRoot,
        snapshot: app.snapshot,
        rawData: app.snapshot.rawStatus?.indexState?.freshness ?? null,
      });
    },

    showRuntimeReport: async () => {
      await refreshStatus(app);
      app.resultPanel.showResult({
        type: RESULT_TYPES.Runtime,
        repoRoot: app.snapshot.repoRoot,
        snapshot: app.snapshot,
        rawData: app.snapshot.rawStatus?.runtime ?? null,
      });
    },

    showSetupConfigReport: async () => {
      await refreshStatus(app);
      app.resultPanel.showResult({
        type: RESULT_TYPES.SetupConfig,
        repoRoot: app.snapshot.repoRoot,
        snapshot: app.snapshot,
        rawData: {
          repoState: app.snapshot.rawStatus?.repoState ?? null,
          agentConfig: app.snapshot.rawStatus?.agentConfig ?? null,
          agents: app.snapshot.agents,
        },
      });
    },

    showExecutableResolutionReport: async () => {
      await refreshStatus(app);
      const fallback = app.snapshot.kind === "cli_unavailable" || app.snapshot.kind === "unavailable"
        ? app.snapshot.message ?? null
        : null;
      app.resultPanel.showResult({
        type: RESULT_TYPES.ExecutableResolution,
        repoRoot: app.snapshot.repoRoot,
        executable: app.snapshot.executable,
        message: fallback,
        rawData: app.snapshot.executable ?? null,
      });
    },

    showNoWorkspaceGuidance: async () => {
      const choice = await app.vscode.window.showInformationMessage(
        EMPTY_STATE_MESSAGES.NoWorkspaceHelper,
        "Open Folder",
      );
      if (choice === "Open Folder") {
        await app.vscode.commands.executeCommand("vscode.openFolder");
      }
    },

    generateContextCapsule: async () => {
      await runPipelineForQuery(app, "Context Capsule");
    },

    runPipelineForCurrentTask: async () => {
      await runPipelineForCurrentTask(app);
    },

    setupOrReindex: async () => {
      await setupOrReindex(app);
    },

    showFileSkeleton: async () => {
      const editorContext = resolveFileSkeletonContext(app.vscode);

      if (editorContext.error !== null) {
        app.vscode.window.showErrorMessage(editorContext.error);
        return;
      }

      const activeFile = editorContext.file;
      const repoGate = await ensureEditorRepoReady(app, activeFile.repoRoot, EDITOR_EMPTY_STATE_MESSAGES.FileSkeleton);

      if (repoGate === null) {
        return;
      }

      const title = `File Skeleton: ${activeFile.relativePath}`;
      const args = buildSkeletonArgs(activeFile.repoRoot, activeFile.relativePath);

      try {
        const result = await app.cli.runJson(args, activeFile.repoRoot);
        const executable = app.cli.getLastExecutableInfo();
        logInvocation(app.output, title, {
          repoRoot: activeFile.repoRoot,
          command: formatInvocation(result.command, args),
          executable,
        });
        app.resultPanel.showResult({
          type: RESULT_TYPES.FileSkeleton,
          repoRoot: activeFile.repoRoot,
          skeleton: result.data,
          filePath: activeFile.relativePath,
          rawData: result.data,
        });
      } catch (error) {
        if (isUnsupportedSkeletonError(error)) {
          app.vscode.window.showErrorMessage(EDITOR_EMPTY_STATE_MESSAGES.FileSkeleton.UnsupportedFile);
          return;
        }
        showCommandFailure(app, "Show File Skeleton", error);
      } finally {
        await refreshStatus(app);
      }
    },

    showImpactGraphAtCursor: async () => {
      const editorContext = resolveImpactGraphContext(app.vscode);

      if (editorContext.error !== null) {
        app.vscode.window.showErrorMessage(editorContext.error);
        return;
      }

      const activeFile = editorContext.file;
      const repoGate = await ensureEditorRepoReady(app, activeFile.repoRoot, EDITOR_EMPTY_STATE_MESSAGES.ImpactGraph);

      if (repoGate === null) {
        return;
      }

      try {
        const inspected = await app.cli.runJson(buildInspectFileArgs(activeFile.relativePath), activeFile.repoRoot);
        const lineNumber = activeFile.lineNumber;
        const symbol = findSymbolAtLine(inspected.data.symbols ?? [], lineNumber);

        if (symbol === null) {
          app.vscode.window.showErrorMessage(EDITOR_EMPTY_STATE_MESSAGES.ImpactGraph.NoSymbolAtCursor);
          return;
        }

        const impactArgs = buildImpactGraphArgs(activeFile.repoRoot, symbol.fqName);
        const impactResult = await app.cli.runJson(impactArgs, activeFile.repoRoot);
        const executable = app.cli.getLastExecutableInfo();
        logInvocation(app.output, `Impact Graph: ${symbol.fqName}`, {
          repoRoot: activeFile.repoRoot,
          command: formatInvocation(impactResult.command, impactArgs),
          executable,
        });
        app.resultPanel.showResult({
          type: RESULT_TYPES.ImpactGraph,
          repoRoot: activeFile.repoRoot,
          impact: impactResult.data,
          symbolFqn: symbol.fqName,
          rawData: impactResult.data,
        });
      } catch (error) {
        if (isSymbolResolutionError(error)) {
          app.vscode.window.showErrorMessage(EDITOR_EMPTY_STATE_MESSAGES.ImpactGraph.SymbolNotResolved);
          return;
        }
        showCommandFailure(app, "Show Impact Graph", error);
      } finally {
        await refreshStatus(app);
      }
    },

    doctor: async () => {
      const workspace = getPrimaryWorkspaceFolder(app.vscode);

      if (workspace === null) {
        app.vscode.window.showErrorMessage(EMPTY_STATE_MESSAGES.NoWorkspace);
        return;
      }

      await refreshStatus(app);
      app.resultPanel.showResult({
        type: RESULT_TYPES.Doctor,
        repoRoot: app.snapshot.repoRoot ?? workspace.repoRoot,
        snapshot: app.snapshot,
        rawData: app.snapshot.rawStatus ?? null,
      });
    },

    refreshStatus: async () => {
      await refreshStatus(app);
    },

    openOutput: () => {
      app.output.show(true);
    },

    openSettings: async () => {
      await app.vscode.commands.executeCommand("workbench.action.openSettings", "vexb.cliPath");
    },

    revealRepoRoot: async () => {
      const workspace = getPrimaryWorkspaceFolder(app.vscode);

      if (workspace === null) {
        await app.vscode.commands.executeCommand("vscode.openFolder");
        return;
      }

      const uri = app.vscode.Uri.file(workspace.repoRoot);
      try {
        await app.vscode.commands.executeCommand("revealInExplorer", uri);
      } catch {
        // revealInExplorer is unavailable in some hosts — silently swallow.
      }
    },

    openAgentConfigFile: async () => {
      if (app.snapshot.kind !== "repo") {
        app.resultPanel.showResult({
          type: RESULT_TYPES.SetupConfig,
          repoRoot: app.snapshot.repoRoot,
          snapshot: app.snapshot,
          rawData: app.snapshot.rawStatus?.agentConfig ?? null,
        });
        return;
      }

      const agent = selectPrimaryAgent(app.snapshot);
      if (agent === null || agent.configPath === null || agent.configPath === undefined) {
        app.resultPanel.showResult({
          type: RESULT_TYPES.SetupConfig,
          repoRoot: app.snapshot.repoRoot,
          snapshot: app.snapshot,
          rawData: app.snapshot.rawStatus?.agentConfig ?? null,
        });
        return;
      }

      const uri = app.vscode.Uri.file(agent.configPath);
      try {
        const document = await app.vscode.workspace.openTextDocument(uri);
        await app.vscode.window.showTextDocument(document, { preview: true });
      } catch {
        app.resultPanel.showResult({
          type: RESULT_TYPES.SetupConfig,
          repoRoot: app.snapshot.repoRoot,
          snapshot: app.snapshot,
          rawData: app.snapshot.rawStatus?.agentConfig ?? null,
        });
      }
    },
  };
}

function applyBusyState(app, state) {
  app.busyState = state;
  app.repoStatusProvider.setBusyState(state);
  applyStatusBarState(app.statusBarItem, buildStatusBarState(app.snapshot, state));
}

async function withProgressNotification(app, title, work) {
  const windowApi = app.vscode.window;
  const withProgress = typeof windowApi?.withProgress === "function" ? windowApi.withProgress.bind(windowApi) : null;
  if (withProgress === null) {
    return await work();
  }
  const location = app.vscode.ProgressLocation?.Notification ?? 15;
  return await withProgress({ location, title, cancellable: false }, async () => work());
}

async function refreshStatus(app) {
  if (app.refreshPromise !== null) {
    app.refreshQueued = true;
    return await app.refreshPromise;
  }

  app.refreshPromise = (async () => {
    const workspace = getPrimaryWorkspaceFolder(app.vscode);

    if (workspace === null) {
      app.snapshot = createNoWorkspaceSnapshot();
      app.repoStatusProvider.setSnapshot(app.snapshot);
      applyStatusBarState(app.statusBarItem, buildStatusBarState(app.snapshot, app.busyState));
      return;
    }

    const repoRoot = workspace.repoRoot;
    if (!isRunningBusy(app.busyState)) {
      app.statusBarItem.text = "$(sync~spin) vexb: refreshing";
      app.statusBarItem.command = COMMAND_IDS.ShowIndexStatus;
      app.statusBarItem.tooltip = "Refreshing vexb status…";
      app.statusBarItem.show();
    }

    const executable = await safeGetExecutableInfo(app.cli);

    try {
      const [defaultStatus, codexStatus] = await Promise.all([
        app.cli.runJson(buildStatusArgs(repoRoot, AGENT_IDS.ClaudeCode), repoRoot),
        app.cli.runJson(buildStatusArgs(repoRoot, AGENT_IDS.Codex), repoRoot),
      ]);
      app.snapshot = buildRepoSnapshot(defaultStatus.data, [codexStatus.data], executable);
    } catch (error) {
      app.snapshot = snapshotFromError(error, repoRoot, executable);
      logErrorToOutput(app.output, "Status Refresh", error);
    }

    app.repoStatusProvider.setSnapshot(app.snapshot);
    applyStatusBarState(app.statusBarItem, buildStatusBarState(app.snapshot, app.busyState));
  })();

  try {
    await app.refreshPromise;
  } finally {
    app.refreshPromise = null;
  }

  if (app.refreshQueued) {
    app.refreshQueued = false;
    await refreshStatus(app);
  }
}

async function safeGetExecutableInfo(cli) {
  try {
    return await cli.getExecutableInfo();
  } catch {
    return null;
  }
}

function snapshotFromError(error, repoRoot, executable) {
  if (error?.code === "VEXB_CLI_NOT_FOUND") {
    return createCliUnavailableSnapshot(
      error.message ?? EMPTY_STATE_MESSAGES.CliNotFound,
      repoRoot,
      executable,
    );
  }

  if (error?.code === "VEXB_BUN_NOT_FOUND") {
    return createCliUnavailableSnapshot(
      error.message ?? EMPTY_STATE_MESSAGES.BunMissing,
      repoRoot,
      executable,
    );
  }

  return createUnavailableSnapshot(
    error instanceof Error ? error.message : String(error),
    repoRoot,
    executable,
  );
}

async function ensureRepoReady(app, repoRoot) {
  await refreshStatus(app);

  if (app.snapshot.kind === "cli_unavailable") {
    const choice = await app.vscode.window.showErrorMessage(
      EMPTY_STATE_MESSAGES.CliNotFound,
      "Open settings",
      "Open output",
    );
    if (choice === "Open settings") {
      await app.vscode.commands.executeCommand("workbench.action.openSettings", "vexb.cliPath");
    } else if (choice === "Open output") {
      app.output.show(true);
    }
    return null;
  }

  if (app.snapshot.kind !== "repo") {
    app.vscode.window.showErrorMessage(app.snapshot.message ?? "vexb is unavailable.");
    return null;
  }

  if (app.snapshot.state === "not_initialized" || app.snapshot.state === "not_ready") {
    const hint = app.snapshot.state === "not_initialized"
      ? EMPTY_STATE_MESSAGES.NotInitialized(repoRoot)
      : EMPTY_STATE_MESSAGES.NotReady;
    const choice = await app.vscode.window.showErrorMessage(
      app.snapshot.nextSteps[0] ?? hint,
      "Run Setup",
      "Run Doctor",
    );
    if (choice === "Run Setup") {
      await app.vscode.commands.executeCommand(COMMAND_IDS.SetupAgent);
    } else if (choice === "Run Doctor") {
      await app.vscode.commands.executeCommand(COMMAND_IDS.Doctor);
    }
    return null;
  }

  if (app.snapshot.state === "stale" || app.snapshot.state === "unknown") {
    const warning = app.snapshot.state === "stale"
      ? EMPTY_STATE_MESSAGES.StaleIndex
      : EMPTY_STATE_MESSAGES.UnknownFreshness;
    const choice = await app.vscode.window.showWarningMessage(
      app.snapshot.freshnessRecommendedAction ?? warning,
      "Continue",
      "Doctor",
    );

    if (choice === "Doctor") {
      await app.vscode.commands.executeCommand(COMMAND_IDS.Doctor);
      return null;
    }

    if (choice !== "Continue") {
      return null;
    }
  }

  return app.snapshot;
}

async function runTextCommand(app, input) {
  try {
    const result = await app.cli.runText(input.args, input.cwd);
    const executable = app.cli.getLastExecutableInfo();
    appendFormattedOutput(app.output, input.title, result.stdout, {
      repoRoot: input.cwd,
      command: formatInvocation(result.command, input.args),
      executable,
    });

    if (input.preferDocument === true) {
      await openResultDocument(app, input.title, result.stdout, {
        repoRoot: input.cwd,
        command: formatInvocation(result.command, input.args),
        executable,
      });
    }
  } catch (error) {
    showCommandFailure(app, input.title, error);
  } finally {
    await refreshStatus(app);
  }
}

async function openResultDocument(app, title, stdout, meta) {
  const uriString = buildResultDocumentUri(title, app.resultDocumentStore.nextCounter());
  const body = buildResultDocumentBody(title, stdout, {
    ...meta,
    generatedAt: new Date().toISOString(),
  });

  const uri = app.vscode.Uri.parse(uriString);
  app.resultDocumentStore.store(uri.toString(), body);

  const document = await app.vscode.workspace.openTextDocument(uri);

  if (typeof app.vscode.languages?.setTextDocumentLanguage === "function") {
    try {
      await app.vscode.languages.setTextDocumentLanguage(document, "markdown");
    } catch {
      // best-effort — fall back to the default plaintext language
    }
  }

  await app.vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
}

function logInvocation(output, title, meta) {
  output.appendLine("");
  output.appendLine(`== ${title} ==`);
  if (meta?.repoRoot) {
    output.appendLine(`Repo: ${meta.repoRoot}`);
  }
  if (meta?.command) {
    output.appendLine(`Command: ${meta.command}`);
  }
  if (meta?.executable) {
    output.appendLine(`Executable: ${meta.executable.command} (${describeExecutableSource(meta.executable.source)})`);
  }
}

function appendFormattedOutput(output, title, body, meta) {
  output.appendLine("");
  output.appendLine(`== ${title} ==`);
  if (meta?.repoRoot) {
    output.appendLine(`Repo: ${meta.repoRoot}`);
  }
  if (meta?.command) {
    output.appendLine(`Command: ${meta.command}`);
  }
  if (meta?.executable) {
    output.appendLine(`Executable: ${meta.executable.command} (${describeExecutableSource(meta.executable.source)})`);
  }
  output.appendLine("");
  output.append((body ?? "").trimEnd());
  output.appendLine("");
  output.show(true);
}

function logErrorToOutput(output, title, error) {
  const message = error instanceof Error ? error.message : String(error);
  output.appendLine("");
  output.appendLine(`!! ${title} failed`);
  output.append(message);
  output.appendLine("");
}

function showCommandFailure(app, title, error) {
  const message = error instanceof Error ? error.message : String(error);
  appendFormattedOutput(app.output, `${title} (error)`, message, {
    executable: app.cli.getLastExecutableInfo?.(),
  });

  const headline = message.split("\n")[0];

  if (error?.code === "VEXB_CLI_NOT_FOUND" || error?.code === "VEXB_BUN_NOT_FOUND") {
    void app.vscode.window.showErrorMessage(headline, "Open settings", "Open output").then((choice) => {
      if (choice === "Open settings") {
        void app.vscode.commands.executeCommand("workbench.action.openSettings", "vexb.cliPath");
      } else if (choice === "Open output") {
        app.output.show(true);
      }
    });
    return;
  }

  app.vscode.window.showErrorMessage(headline);
}

function applyStatusBarState(statusBarItem, state) {
  statusBarItem.text = state.text;
  statusBarItem.tooltip = state.tooltip;
  statusBarItem.command = state.command;
  statusBarItem.color = state.color;
  statusBarItem.show();
}

function formatInvocation(command, args) {
  return [command, ...args].map((token) => /\s/u.test(token) ? `"${token}"` : token).join(" ");
}

function getPrimaryWorkspaceFolder(vscode) {
  const activeEditorUri = vscode.window.activeTextEditor?.document?.uri;
  const activeFolder = activeEditorUri === undefined
    ? undefined
    : vscode.workspace.getWorkspaceFolder(activeEditorUri);
  const folder = activeFolder ?? vscode.workspace.workspaceFolders?.[0];

  if (folder === undefined) {
    return null;
  }

  return {
    name: folder.name,
    repoRoot: folder.uri.fsPath,
  };
}

function getActiveWorkspaceFile(vscode) {
  const editor = vscode.window.activeTextEditor;

  if (editor === undefined) {
    return null;
  }

  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);

  if (folder === undefined) {
    return null;
  }

  return {
    repoRoot: folder.uri.fsPath,
    relativePath: path.relative(folder.uri.fsPath, editor.document.uri.fsPath),
    lineNumber: editor.selection.active.line + 1,
  };
}

export function resolveFileSkeletonContext(vscode) {
  return resolveEditorContext(vscode, EDITOR_EMPTY_STATE_MESSAGES.FileSkeleton);
}

export function resolveImpactGraphContext(vscode) {
  return resolveEditorContext(vscode, EDITOR_EMPTY_STATE_MESSAGES.ImpactGraph);
}

function resolveEditorContext(vscode, messages) {
  if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
    return { error: messages.NoWorkspace, file: null };
  }

  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    return { error: messages.NoActiveEditor, file: null };
  }

  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (folder === undefined) {
    return { error: messages.OutsideWorkspace ?? messages.NoActiveEditor, file: null };
  }

  return {
    error: null,
    file: {
      repoRoot: folder.uri.fsPath,
      relativePath: path.relative(folder.uri.fsPath, editor.document.uri.fsPath),
      lineNumber: editor.selection.active.line + 1,
    },
  };
}

async function ensureEditorRepoReady(app, repoRoot, messages) {
  await refreshStatus(app);

  if (app.snapshot.kind === "cli_unavailable") {
    const choice = await app.vscode.window.showErrorMessage(
      EMPTY_STATE_MESSAGES.CliNotFound,
      "Open settings",
      "Open output",
    );
    if (choice === "Open settings") {
      await app.vscode.commands.executeCommand("workbench.action.openSettings", "vexb.cliPath");
    } else if (choice === "Open output") {
      app.output.show(true);
    }
    return null;
  }

  if (app.snapshot.kind !== "repo") {
    app.vscode.window.showErrorMessage(app.snapshot.message ?? "vexb is unavailable.");
    return null;
  }

  if (app.snapshot.state === "not_initialized") {
    app.vscode.window.showErrorMessage(messages.NotInitialized);
    return null;
  }

  if (app.snapshot.state === "not_ready") {
    app.vscode.window.showErrorMessage(messages.IndexNotReady);
    return null;
  }

  return app.snapshot;
}

function isUnsupportedSkeletonError(error) {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const detail = `${error.stderr ?? ""}\n${error.stdout ?? ""}\n${error.message ?? ""}`;
  return /unsupported|not\s+a\s+supported|no\s+supported|not\s+indexed/i.test(detail);
}

function isSymbolResolutionError(error) {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const detail = `${error.stderr ?? ""}\n${error.stdout ?? ""}\n${error.message ?? ""}`;
  return /could not resolve|unknown symbol|symbol not found|no exact match/i.test(detail);
}

async function openReportDocument(app, title, body) {
  const uriString = buildResultDocumentUri(title, app.resultDocumentStore.nextCounter());
  const uri = app.vscode.Uri.parse(uriString);
  app.resultDocumentStore.store(uri.toString(), body);

  const document = await app.vscode.workspace.openTextDocument(uri);

  if (typeof app.vscode.languages?.setTextDocumentLanguage === "function") {
    try {
      await app.vscode.languages.setTextDocumentLanguage(document, "markdown");
    } catch {
      // best-effort
    }
  }

  await app.vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
}

async function pickAgent(vscode) {
  const picked = await vscode.window.showQuickPick([
    {
      label: "Claude Code",
      description: "Install or refresh the default Claude Code MCP config.",
      agentId: AGENT_IDS.ClaudeCode,
    },
    {
      label: "Codex",
      description: "Install or refresh the Codex MCP config.",
      agentId: AGENT_IDS.Codex,
    },
  ], {
    placeHolder: "Choose the vexb agent config to set up.",
    ignoreFocusOut: true,
  });

  return picked?.agentId ?? null;
}

async function setupOrReindex(app) {
  if (isRunningBusy(app.busyState)) {
    app.output.show(true);
    return;
  }

  const workspace = getPrimaryWorkspaceFolder(app.vscode);

  if (workspace === null) {
    app.vscode.window.showErrorMessage(SETUP_REINDEX_MESSAGES.NoWorkspace);
    return;
  }

  await refreshStatus(app);

  if (app.snapshot.kind === "cli_unavailable") {
    const choice = await app.vscode.window.showErrorMessage(
      EMPTY_STATE_MESSAGES.CliNotFound,
      "Open settings",
      "Open output",
    );
    if (choice === "Open settings") {
      await app.vscode.commands.executeCommand("workbench.action.openSettings", "vexb.cliPath");
    } else if (choice === "Open output") {
      app.output.show(true);
    }
    return;
  }

  if (app.snapshot.kind !== "repo") {
    app.vscode.window.showErrorMessage(app.snapshot.message ?? "vexb is unavailable.");
    return;
  }

  if (app.snapshot.state === "not_initialized") {
    await runSetupFlow(app, workspace.repoRoot);
    return;
  }

  if (app.snapshot.state === "not_ready" || app.snapshot.state === "stale" || app.snapshot.state === "unknown") {
    await runReindexFlow(app, workspace.repoRoot);
    return;
  }

  const choice = await app.vscode.window.showQuickPick(
    [
      { label: SETUP_REINDEX_MESSAGES.ReadyQuickPickReindex },
      { label: SETUP_REINDEX_MESSAGES.ReadyQuickPickShowIndexStatus },
      { label: SETUP_REINDEX_MESSAGES.ReadyQuickPickDoctor },
      { label: SETUP_REINDEX_MESSAGES.ReadyQuickPickCancel },
    ],
    {
      title: SETUP_REINDEX_MESSAGES.ReadyQuickPickTitle,
      placeHolder: SETUP_REINDEX_MESSAGES.ReadyQuickPickPlaceholder,
      ignoreFocusOut: true,
    },
  );

  if (choice === undefined || choice === null || choice.label === SETUP_REINDEX_MESSAGES.ReadyQuickPickCancel) {
    return;
  }

  if (choice.label === SETUP_REINDEX_MESSAGES.ReadyQuickPickReindex) {
    await runReindexFlow(app, workspace.repoRoot);
    return;
  }

  if (choice.label === SETUP_REINDEX_MESSAGES.ReadyQuickPickShowIndexStatus) {
    await app.vscode.commands.executeCommand(COMMAND_IDS.ShowIndexStatus);
    return;
  }

  if (choice.label === SETUP_REINDEX_MESSAGES.ReadyQuickPickDoctor) {
    await app.vscode.commands.executeCommand(COMMAND_IDS.Doctor);
  }
}

async function runSetupFlow(app, repoRoot) {
  const agentId = await pickAgent(app.vscode);
  if (agentId === null) {
    return;
  }
  await runSetupReindexJob(app, {
    busyState: BUSY_STATES.RunningSetup,
    progressTitle: "Setting up and indexing vexb for this repo…",
    args: buildSetupArgs(repoRoot, agentId),
    repoRoot,
  });
}

async function runReindexFlow(app, repoRoot) {
  await runSetupReindexJob(app, {
    busyState: BUSY_STATES.RunningReindex,
    progressTitle: "Re-indexing vexb for this repo…",
    args: buildIndexArgs(repoRoot),
    repoRoot,
  });
}

async function runSetupReindexJob(app, job) {
  const title = "Setup / Re-index";

  applyBusyState(app, job.busyState);

  // Auto-open the vexb output channel before the CLI starts so live parser progress
  // streams into the right-hand panel as it happens, not after the run ends.
  app.output.show(true);
  app.output.appendLine("");
  app.output.appendLine(`== ${title} ==`);
  app.output.appendLine(`Repo: ${job.repoRoot}`);

  let failure = null;
  try {
    await withProgressNotification(app, job.progressTitle, async () => {
      const result = await app.cli.runTextStreaming(job.args, job.repoRoot, {
        // VEXB_PROGRESS_STREAM=1 asks the CLI to emit per-phase/per-file progress to
        // stderr even though our spawned process has no TTY. Terminal users never see
        // this var so their behaviour is unchanged.
        env: { VEXB_PROGRESS_STREAM: "1" },
        onStderrLine: (line) => app.output.appendLine(line),
      });
      const executable = app.cli.getLastExecutableInfo();
      app.output.appendLine("");
      app.output.appendLine(`Command: ${formatInvocation(result.command, job.args)}`);
      if (executable) {
        app.output.appendLine(`Executable: ${executable.command} (${describeExecutableSource(executable.source)})`);
      }
      const trimmedStdout = (result.stdout ?? "").trimEnd();
      if (trimmedStdout.length > 0) {
        app.output.appendLine("");
        app.output.append(trimmedStdout);
        app.output.appendLine("");
      }
    });
    app.busyState = BUSY_STATES.Complete;
  } catch (error) {
    failure = error;
    app.busyState = BUSY_STATES.Failed;
    showCommandFailure(app, title, error);
  }

  applyBusyState(app, BUSY_STATES.Idle);
  await refreshStatus(app);

  if (failure === null) {
    app.resultPanel.showResult({
      type: RESULT_TYPES.IndexStatus,
      repoRoot: app.snapshot.repoRoot ?? job.repoRoot,
      snapshot: app.snapshot,
      rawData: app.snapshot.rawStatus ?? null,
    });
  }
}

async function runPipelineForCurrentTask(app) {
  const title = "Run Pipeline";
  const workspace = getPrimaryWorkspaceFolder(app.vscode);

  if (workspace === null) {
    app.vscode.window.showErrorMessage(RUN_PIPELINE_MESSAGES.NoWorkspace);
    return;
  }

  await refreshStatus(app);

  if (app.snapshot.kind === "cli_unavailable") {
    const choice = await app.vscode.window.showErrorMessage(
      EMPTY_STATE_MESSAGES.CliNotFound,
      "Open settings",
      "Open output",
    );
    if (choice === "Open settings") {
      await app.vscode.commands.executeCommand("workbench.action.openSettings", "vexb.cliPath");
    } else if (choice === "Open output") {
      app.output.show(true);
    }
    return;
  }

  if (app.snapshot.kind !== "repo") {
    app.vscode.window.showErrorMessage(app.snapshot.message ?? "vexb is unavailable.");
    return;
  }

  if (app.snapshot.state === "not_initialized") {
    app.vscode.window.showErrorMessage(RUN_PIPELINE_MESSAGES.NotInitialized);
    return;
  }

  if (app.snapshot.state === "not_ready") {
    app.vscode.window.showErrorMessage(RUN_PIPELINE_MESSAGES.IndexNotReady);
    return;
  }

  const query = await app.vscode.window.showInputBox({
    title: RUN_PIPELINE_MESSAGES.InputTitle,
    prompt: RUN_PIPELINE_MESSAGES.InputPrompt,
    placeHolder: RUN_PIPELINE_MESSAGES.InputPlaceholder,
    ignoreFocusOut: true,
  });

  if (query === undefined) {
    return;
  }

  const trimmedQuery = typeof query === "string" ? query.trim() : "";
  if (trimmedQuery.length === 0) {
    app.vscode.window.showErrorMessage(RUN_PIPELINE_MESSAGES.EmptyInput);
    return;
  }

  const args = buildRunPipelineArgs(workspace.repoRoot, trimmedQuery);
  try {
    const result = await app.cli.runJson(args, workspace.repoRoot);
    const executable = app.cli.getLastExecutableInfo();
    logInvocation(app.output, title, {
      repoRoot: workspace.repoRoot,
      command: formatInvocation(result.command, args),
      executable,
    });
    app.resultPanel.showResult({
      type: RESULT_TYPES.RunPipeline,
      repoRoot: workspace.repoRoot,
      pipeline: result.data,
      rawData: result.data,
    });
  } catch (error) {
    showCommandFailure(app, title, error);
  } finally {
    await refreshStatus(app);
  }
}

async function runPipelineForQuery(app, title) {
  const workspace = getPrimaryWorkspaceFolder(app.vscode);

  if (workspace === null) {
    app.vscode.window.showErrorMessage(EMPTY_STATE_MESSAGES.NoWorkspace);
    return;
  }

  const gate = await ensureRepoReady(app, workspace.repoRoot);
  if (gate === null) {
    return;
  }

  const query = await app.vscode.window.showInputBox({
    prompt: "Describe the current task for vexb run_pipeline.",
    value: defaultCapsulePrompt(app.vscode),
    ignoreFocusOut: true,
  });

  if (typeof query !== "string" || query.trim().length === 0) {
    return;
  }

  const trimmedQuery = query.trim();
  const args = buildRunPipelineArgs(workspace.repoRoot, trimmedQuery);
  try {
    const result = await app.cli.runJson(args, workspace.repoRoot);
    const executable = app.cli.getLastExecutableInfo();
    logInvocation(app.output, title, {
      repoRoot: workspace.repoRoot,
      command: formatInvocation(result.command, args),
      executable,
    });
    app.resultPanel.showResult({
      type: RESULT_TYPES.RunPipeline,
      repoRoot: workspace.repoRoot,
      pipeline: result.data,
      rawData: result.data,
    });
  } catch (error) {
    showCommandFailure(app, title, error);
  } finally {
    await refreshStatus(app);
  }
}

async function expandVexpRefViaCli(cli, output, request) {
  const repoRoot = request?.repoRoot;
  const hash = request?.hash;
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    return { resolved: false, reason: "unknown_hash", message: "No repo root attached to the active panel result." };
  }
  if (typeof hash !== "string" || hash.length === 0) {
    return { resolved: false, reason: "malformed_hash", message: "Missing V-REF hash on expansion request." };
  }
  const args = buildExpandVexpRefArgs(repoRoot, hash, {
    query: request?.query ?? null,
    sessionId: request?.sessionId ?? null,
  });
  try {
    const result = await cli.runJson(args, repoRoot);
    if (output && typeof output.appendLine === "function") {
      output.appendLine(`expand-vexp-ref ${hash} → ${result.data?.resolved ? "resolved" : `failed (${result.data?.reason ?? "?"})`}`);
    }
    return result.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { resolved: false, reason: "unknown_hash", message };
  }
}

function defaultCapsulePrompt(vscode) {
  const selection = vscode.window.activeTextEditor?.document.getText(
    vscode.window.activeTextEditor.selection,
  ).trim();

  if (selection && selection.length > 0) {
    return selection.slice(0, 200);
  }

  return "";
}

export class ResultDocumentStore {
  constructor() {
    this.counter = 0;
    this.documents = new Map();
  }

  nextCounter() {
    this.counter += 1;
    return this.counter;
  }

  store(uriKey, body) {
    this.documents.set(uriKey, body);
  }

  provideTextDocumentContent(uri) {
    return this.documents.get(uri.toString()) ?? "";
  }
}

class RepoStatusProvider {
  constructor(vscode) {
    this.vscode = vscode;
    this.snapshot = createNoWorkspaceSnapshot();
    this.busyState = BUSY_STATES.Idle;
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changeEmitter.event;
  }

  dispose() {
    this.changeEmitter.dispose();
  }

  setSnapshot(snapshot) {
    this.snapshot = snapshot;
    this.changeEmitter.fire(undefined);
  }

  setBusyState(busyState) {
    this.busyState = busyState;
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(item) {
    return item;
  }

  getChildren(element) {
    if (element === undefined || element === null) {
      return buildRepoTreeSections(this.snapshot, { busyState: this.busyState }).map((section) => this._buildSectionItem(section));
    }

    const rows = element.__vexbChildren;
    if (Array.isArray(rows)) {
      return rows.map((row) => this._buildRowItem(row));
    }

    return [];
  }

  _buildSectionItem(section) {
    const item = new this.vscode.TreeItem(section.label, this.vscode.TreeItemCollapsibleState.Expanded);
    item.contextValue = `vexbSection:${section.id}`;
    item.id = `vexb.section.${section.id}`;
    item.__vexbChildren = section.children;
    if (section.icon !== undefined) {
      item.iconPath = new this.vscode.ThemeIcon(section.icon);
    }
    return item;
  }

  _buildRowItem(row) {
    const item = new this.vscode.TreeItem(row.label, this.vscode.TreeItemCollapsibleState.None);
    if (row.description !== undefined) {
      item.description = row.description;
    }
    if (row.tooltip !== undefined) {
      item.tooltip = row.tooltip;
    }
    if (row.icon !== undefined) {
      item.iconPath = new this.vscode.ThemeIcon(row.icon);
    }
    if (row.command) {
      item.command = {
        command: row.command,
        title: row.label,
      };
    }
    return item;
  }
}

export { SECTION_IDS };

// Re-export EXECUTABLE_SOURCES for downstream packaging/tests.
export { EXECUTABLE_SOURCES };
