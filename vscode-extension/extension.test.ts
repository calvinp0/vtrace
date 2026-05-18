import assert from "node:assert/strict";
import test from "node:test";

import { EXECUTABLE_SOURCES } from "./cli.js";
import {
  RESULT_DOC_SCHEME,
  ResultDocumentStore,
  activateWithVscode,
  getCommandDefinitions,
  registerExtensionCommands,
  resolveFileSkeletonContext,
  resolveImpactGraphContext,
} from "./extension-main.js";
import { EDITOR_EMPTY_STATE_MESSAGES, RUN_PIPELINE_MESSAGES, SETUP_REINDEX_MESSAGES } from "./shell.js";

test("command definitions include every registered vexb shell action", () => {
  assert.deepEqual(
    getCommandDefinitions().map((definition) => definition.id),
    [
      "vexb.setupAgent",
      "vexb.showIndexStatus",
      "vexb.generateContextCapsule",
      "vexb.showFileSkeleton",
      "vexb.showImpactGraphAtCursor",
      "vexb.doctor",
      "vexb.refreshStatus",
      "vexb.openOutput",
      "vexb.openSettings",
      "vexb.revealRepoRoot",
      "vexb.openAgentConfigFile",
      "vexb.showFreshnessReport",
      "vexb.showRuntimeReport",
      "vexb.showSetupConfigReport",
      "vexb.showExecutableResolutionReport",
      "vexb.showNoWorkspaceGuidance",
      "vexb.runPipelineForCurrentTask",
      "vexb.setupOrReindex",
    ],
  );
});

test("registerExtensionCommands wires each definition into the VS Code command registry", () => {
  const registeredIds: string[] = [];
  const context = { subscriptions: [] as Array<{ dispose(): void }> };
  const handlers = {
    setupAgent() {},
    showIndexStatus() {},
    generateContextCapsule() {},
    showFileSkeleton() {},
    showImpactGraphAtCursor() {},
    doctor() {},
    refreshStatus() {},
    openOutput() {},
    openSettings() {},
    revealRepoRoot() {},
    openAgentConfigFile() {},
    showFreshnessReport() {},
    showRuntimeReport() {},
    showSetupConfigReport() {},
    showExecutableResolutionReport() {},
    showNoWorkspaceGuidance() {},
    runPipelineForCurrentTask() {},
    setupOrReindex() {},
  };

  registerExtensionCommands({
    commands: {
      registerCommand(id: string, handler: () => void) {
        registeredIds.push(id);
        assert.equal(typeof handler, "function");
        return { dispose() {} };
      },
    },
  } as never, context as never, handlers);

  assert.deepEqual(registeredIds, getCommandDefinitions().map((definition) => definition.id));
  assert.equal(context.subscriptions.length, getCommandDefinitions().length);
});

test("ResultDocumentStore stores readonly document bodies keyed by URI", () => {
  const store = new ResultDocumentStore();
  const counter = store.nextCounter();
  const uri = { toString: () => `${RESULT_DOC_SCHEME}:/results/${counter.toString().padStart(4, "0")}-x.md` };
  store.store(uri.toString(), "hello world");

  assert.equal(store.provideTextDocumentContent(uri), "hello world");
  assert.equal(store.nextCounter(), counter + 1);
  assert.equal(store.provideTextDocumentContent({ toString: () => "vexb:/missing" }), "");
});

test("activateWithVscode renders four top-level sections and populates Overview rows", async () => {
  const harness = createVscodeHarness();
  const app = await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);

  assert.match(harness.statusBar.text, /vexb: ready/);
  assert.equal(harness.statusBar.shown, true);
  assert.deepEqual(harness.registeredCommandIds, getCommandDefinitions().map((definition) => definition.id));

  const sections = app.repoStatusProvider.getChildren() as Array<TreeNodeStub>;
  assert.deepEqual(sections.map((section) => section.label), [
    "OVERVIEW",
    "QUICK ACTIONS",
    "CURRENT AGENT",
    "OUTPUT & DIAGNOSTICS",
  ]);
  assert.deepEqual(
    sections.map((section) => (section as TreeNodeStub & { iconPath?: { id: string } }).iconPath?.id),
    ["dashboard", "zap", "hubot", "pulse"],
  );

  const overview = app.repoStatusProvider.getChildren(sections[0]) as Array<TreeNodeStub>;
  assert.deepEqual(overview.map((row) => row.label), [
    "Ready",
    "Repo root",
    "Setup",
    "Index",
    "Latest run",
    "Freshness",
    "Runtime",
  ]);
});

test("activateWithVscode renders No workspace primary status when no folder is open", async () => {
  const harness = createVscodeHarness({ noWorkspace: true });
  const app = await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);

  assert.match(harness.statusBar.text, /no workspace/);
  const sections = app.repoStatusProvider.getChildren() as Array<TreeNodeStub>;
  const overview = app.repoStatusProvider.getChildren(sections[0]) as Array<TreeNodeStub>;
  assert.equal(overview[0]?.label, "No workspace");
});

test("activateWithVscode renders VEXB not found primary status when CLI resolution fails", async () => {
  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "vexb", source: EXECUTABLE_SOURCES.Path, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "vexb", source: EXECUTABLE_SOURCES.Path, attempted: [] };
      },
      async runJson() {
        const error = new Error("vexb CLI was not found.");
        (error as Error & { code?: string }).code = "VEXB_CLI_NOT_FOUND";
        throw error;
      },
      async runText() {
        throw new Error("unused");
      },
    },
  });

  const app = await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);

  assert.match(harness.statusBar.text, /CLI missing/);
  const sections = app.repoStatusProvider.getChildren() as Array<TreeNodeStub>;
  const overview = app.repoStatusProvider.getChildren(sections[0]) as Array<TreeNodeStub>;
  assert.equal(overview[0]?.label, "VEXB not found");

  const diagnostics = app.repoStatusProvider.getChildren(sections[3]) as Array<TreeNodeStub>;
  const executableRow = diagnostics.find((row) => row.label === "Executable Resolution");
  assert.ok(executableRow, "Output & Diagnostics must surface the Executable Resolution row");
  assert.equal(executableRow?.description, "using vexb on PATH");
});

test("activateWithVscode wires click commands on Overview rows per spec", async () => {
  const harness = createVscodeHarness();
  const app = await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);

  const sections = app.repoStatusProvider.getChildren() as Array<TreeNodeStub>;
  const overview = app.repoStatusProvider.getChildren(sections[0]) as Array<TreeNodeStub>;
  const quick = app.repoStatusProvider.getChildren(sections[1]) as Array<TreeNodeStub>;

  const byLabel = Object.fromEntries(overview.map((row) => [row.label, row]));
  assert.equal(byLabel["Ready"]?.command?.command, "vexb.showIndexStatus");
  assert.equal(byLabel["Repo root"]?.command?.command, "vexb.revealRepoRoot");
  assert.equal(byLabel["Setup"]?.command, undefined);
  assert.equal(byLabel["Index"]?.command, undefined);
  assert.equal(byLabel["Latest run"]?.command, undefined);
  assert.equal(byLabel["Freshness"]?.command?.command, "vexb.showFreshnessReport");
  assert.equal(byLabel["Runtime"]?.command?.command, "vexb.showRuntimeReport");

  assert.deepEqual(
    quick.map((row) => row.command?.command),
    [
      "vexb.refreshStatus",
      "vexb.runPipelineForCurrentTask",
      "vexb.setupOrReindex",
      "vexb.showFileSkeleton",
      "vexb.showImpactGraphAtCursor",
    ],
  );

  const diagnostics = app.repoStatusProvider.getChildren(sections[3]) as Array<TreeNodeStub>;
  assert.deepEqual(diagnostics.map((row) => row.command?.command), [
    "vexb.doctor",
    "vexb.openOutput",
    "vexb.showExecutableResolutionReport",
  ]);
});

test("resolveFileSkeletonContext returns spec message for each missing-context branch", () => {
  const noWorkspace = resolveFileSkeletonContext({
    workspace: { workspaceFolders: [], getWorkspaceFolder: () => undefined },
    window: { activeTextEditor: undefined },
  } as never);
  assert.equal(noWorkspace.error, EDITOR_EMPTY_STATE_MESSAGES.FileSkeleton.NoWorkspace);

  const noEditor = resolveFileSkeletonContext({
    workspace: { workspaceFolders: [{ uri: { fsPath: "/repo" } }], getWorkspaceFolder: () => undefined },
    window: { activeTextEditor: undefined },
  } as never);
  assert.equal(noEditor.error, EDITOR_EMPTY_STATE_MESSAGES.FileSkeleton.NoActiveEditor);

  const outsideWorkspace = resolveFileSkeletonContext({
    workspace: {
      workspaceFolders: [{ uri: { fsPath: "/repo" } }],
      getWorkspaceFolder: () => undefined,
    },
    window: {
      activeTextEditor: {
        document: { uri: { fsPath: "/other/file.ts" } },
        selection: { active: { line: 0 } },
      },
    },
  } as never);
  assert.equal(outsideWorkspace.error, EDITOR_EMPTY_STATE_MESSAGES.FileSkeleton.OutsideWorkspace);

  const inside = resolveFileSkeletonContext({
    workspace: {
      workspaceFolders: [{ uri: { fsPath: "/repo" } }],
      getWorkspaceFolder: () => ({ uri: { fsPath: "/repo" } }),
    },
    window: {
      activeTextEditor: {
        document: { uri: { fsPath: "/repo/src/app.ts" } },
        selection: { active: { line: 4 } },
      },
    },
  } as never);
  assert.equal(inside.error, null);
  assert.equal(inside.file?.relativePath, "src/app.ts");
  assert.equal(inside.file?.lineNumber, 5);
});

test("resolveImpactGraphContext surfaces impact-graph-specific messages for missing context", () => {
  const noWorkspace = resolveImpactGraphContext({
    workspace: { workspaceFolders: [], getWorkspaceFolder: () => undefined },
    window: { activeTextEditor: undefined },
  } as never);
  assert.equal(noWorkspace.error, EDITOR_EMPTY_STATE_MESSAGES.ImpactGraph.NoWorkspace);

  const noEditor = resolveImpactGraphContext({
    workspace: { workspaceFolders: [{ uri: { fsPath: "/repo" } }], getWorkspaceFolder: () => undefined },
    window: { activeTextEditor: undefined },
  } as never);
  assert.equal(noEditor.error, EDITOR_EMPTY_STATE_MESSAGES.ImpactGraph.NoActiveEditor);
});

test("showFileSkeleton surfaces not-initialized and index-not-ready messages from spec", async () => {
  const errorMessages: string[] = [];
  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson() {
        return { data: makeNotInitializedStatusEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText() {
        return { command: "/ext/bin/vexb", stdout: "" };
      },
    },
  });
  harness.vscode.window.activeTextEditor = {
    document: { uri: { fsPath: "/repo/src/app.ts" } },
    selection: { active: { line: 0 } },
  } as never;
  harness.vscode.workspace.getWorkspaceFolder = (() => ({ uri: { fsPath: "/repo" } })) as never;
  harness.vscode.window.showErrorMessage = ((message: string) => {
    errorMessages.push(message);
    return Promise.resolve(undefined);
  }) as never;

  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  errorMessages.length = 0;
  const handler = harness.registeredCommands.get("vexb.showFileSkeleton");
  await handler?.();

  assert.deepEqual(errorMessages, [EDITOR_EMPTY_STATE_MESSAGES.FileSkeleton.NotInitialized]);
});

test("showFileSkeleton surfaces unsupported-file message when the CLI rejects the file", async () => {
  const errorMessages: string[] = [];
  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson(args: string[]) {
        if (args[0] === "skeleton") {
          const error: Error & { code?: string; stderr?: string } = new Error("vexb skeleton failed");
          error.code = "VEXB_COMMAND_FAILED";
          error.stderr = "error: file is not a supported indexed source file";
          throw error;
        }
        return { data: makeReadyStatusEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText() {
        return { command: "/ext/bin/vexb", stdout: "" };
      },
    },
  });
  harness.vscode.window.activeTextEditor = {
    document: { uri: { fsPath: "/repo/src/app.ts" } },
    selection: { active: { line: 0 } },
  } as never;
  harness.vscode.workspace.getWorkspaceFolder = (() => ({ uri: { fsPath: "/repo" } })) as never;
  harness.vscode.window.showErrorMessage = ((message: string) => {
    errorMessages.push(message);
    return Promise.resolve(undefined);
  }) as never;

  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  errorMessages.length = 0;
  const handler = harness.registeredCommands.get("vexb.showFileSkeleton");
  await handler?.();

  assert.deepEqual(errorMessages, [EDITOR_EMPTY_STATE_MESSAGES.FileSkeleton.UnsupportedFile]);
});

test("showImpactGraphAtCursor surfaces no-symbol and symbol-not-resolved messages from spec", async () => {
  const errorMessages: string[] = [];
  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson(args: string[]) {
        if (args[0] === "inspect-file") {
          return { data: { symbols: [] }, command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
        }
        return { data: makeReadyStatusEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText() {
        return { command: "/ext/bin/vexb", stdout: "" };
      },
    },
  });
  harness.vscode.window.activeTextEditor = {
    document: { uri: { fsPath: "/repo/src/app.ts" } },
    selection: { active: { line: 0 } },
  } as never;
  harness.vscode.workspace.getWorkspaceFolder = (() => ({ uri: { fsPath: "/repo" } })) as never;
  harness.vscode.window.showErrorMessage = ((message: string) => {
    errorMessages.push(message);
    return Promise.resolve(undefined);
  }) as never;

  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  errorMessages.length = 0;
  const handler = harness.registeredCommands.get("vexb.showImpactGraphAtCursor");
  await handler?.();

  assert.deepEqual(errorMessages, [EDITOR_EMPTY_STATE_MESSAGES.ImpactGraph.NoSymbolAtCursor]);
});

test("showIndexStatus renders into the result panel instead of opening a markdown document", async () => {
  const harness = createVscodeHarness();
  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);

  const handler = harness.registeredCommands.get("vexb.showIndexStatus");
  await handler?.();

  assert.equal(harness.createdWebviewPanels.length, 1);
  assert.equal(harness.createdWebviewPanels[0]?.title, "vexb — Index Status");
  assert.match(harness.createdWebviewPanels[0]?.webview.html ?? "", /data-result-type="index_status"/);
});

test("successive report commands reuse a single webview panel", async () => {
  const harness = createVscodeHarness();
  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);

  await harness.registeredCommands.get("vexb.showIndexStatus")?.();
  await harness.registeredCommands.get("vexb.showFreshnessReport")?.();
  await harness.registeredCommands.get("vexb.showRuntimeReport")?.();

  assert.equal(harness.createdWebviewPanels.length, 1);
  assert.equal(harness.createdWebviewPanels[0]?.title, "vexb — Runtime");
});

test("doctor command renders into the result panel with snapshot-derived sections", async () => {
  const harness = createVscodeHarness();
  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);

  await harness.registeredCommands.get("vexb.doctor")?.();

  assert.equal(harness.createdWebviewPanels[0]?.title, "vexb — Doctor");
  assert.match(harness.createdWebviewPanels[0]?.webview.html ?? "", /data-result-type="doctor"/);
});

test("activateWithVscode refreshes on workspace-folder change", async () => {
  const folderChangeListeners: Array<() => void> = [];
  const harness = createVscodeHarness({
    onDidChangeWorkspaceFolders: (listener) => {
      folderChangeListeners.push(listener);
    },
  });

  let refreshCount = 0;
  let latestStatus = makeReadyStatusEnvelope();
  harness.overrides.cliBridge = {
    async getExecutableInfo() {
      return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
    },
    getLastExecutableInfo() {
      return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
    },
    async runJson() {
      refreshCount += 1;
      return {
        data: latestStatus,
        command: "/ext/bin/vexb",
        exitCode: 0,
        stdout: "",
      };
    },
    async runText() {
      return { command: "/ext/bin/vexb", stdout: "" };
    },
  };

  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  const initialCalls = refreshCount;

  for (const listener of folderChangeListeners) {
    listener();
  }
  // Let the async refresh complete.
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.ok(refreshCount > initialCalls, `workspace change should re-run status (initial=${initialCalls}, after=${refreshCount})`);
});

test("refreshStatus deduplicates overlapping refresh calls", async () => {
  let activeCalls = 0;
  let peakConcurrency = 0;
  let totalCalls = 0;
  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson() {
        activeCalls += 1;
        totalCalls += 1;
        peakConcurrency = Math.max(peakConcurrency, activeCalls);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeCalls -= 1;
        return {
          data: makeReadyStatusEnvelope(),
          command: "/ext/bin/vexb",
          exitCode: 0,
          stdout: "",
        };
      },
      async runText() {
        return { command: "/ext/bin/vexb", stdout: "" };
      },
    },
  });

  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);

  totalCalls = 0;
  peakConcurrency = 0;
  activeCalls = 0;

  await Promise.all([
    invokeRefresh(harness),
    invokeRefresh(harness),
    invokeRefresh(harness),
    invokeRefresh(harness),
  ]);

  // Two status calls per refresh cycle (claude-code + codex). Without coalescing, 4 parallel
  // refreshes would fire 8 status calls. With coalescing: first cycle + one queued cycle = 4.
  assert.ok(peakConcurrency <= 2, `peak concurrency should stay at 2 per cycle — got ${peakConcurrency}`);
  assert.ok(totalCalls <= 4, `redundant parallel refreshes should coalesce — got ${totalCalls}`);
});

test("runPipelineForCurrentTask command is registered under the spec-defined id", () => {
  assert.ok(
    getCommandDefinitions().some((definition) => definition.id === "vexb.runPipelineForCurrentTask"),
    "vexb.runPipelineForCurrentTask must be a registered command id",
  );
});

test("Quick Actions places Run Pipeline directly after Refresh and above Setup / Re-index", async () => {
  const harness = createVscodeHarness();
  const app = await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);

  const sections = app.repoStatusProvider.getChildren() as Array<TreeNodeStub>;
  const quick = app.repoStatusProvider.getChildren(sections[1]) as Array<TreeNodeStub>;
  const labels = quick.map((row) => row.label);

  const refreshIdx = labels.indexOf("Refresh");
  const pipelineIdx = labels.indexOf("Run Pipeline for Current Task");
  const setupIdx = labels.indexOf("Setup / Re-index");

  assert.ok(refreshIdx >= 0 && pipelineIdx >= 0 && setupIdx >= 0, "expected Refresh, Run Pipeline, and Setup / Re-index rows");
  assert.equal(pipelineIdx, refreshIdx + 1, "Run Pipeline must sit directly after Refresh");
  assert.equal(setupIdx, pipelineIdx + 1, "Setup / Re-index must sit directly after Run Pipeline");
  assert.equal(quick[pipelineIdx]?.command?.command, "vexb.runPipelineForCurrentTask");
  assert.equal(quick[setupIdx]?.command?.command, "vexb.setupOrReindex");
});

test("Quick Actions no longer surfaces Setup Agent (demoted from sidebar)", async () => {
  const harness = createVscodeHarness();
  const app = await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);

  const sections = app.repoStatusProvider.getChildren() as Array<TreeNodeStub>;
  const quick = app.repoStatusProvider.getChildren(sections[1]) as Array<TreeNodeStub>;
  const commands = quick.map((row) => row.command?.command);

  assert.equal(commands.includes("vexb.setupAgent"), false);
});

test("runPipelineForCurrentTask prompts with spec title and placeholder, runs CLI, routes to RunPipeline panel", async () => {
  let capturedOptions: { title?: string; placeHolder?: string; prompt?: string } | undefined;
  const cliArgsLog: string[][] = [];
  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson(args: string[]) {
        cliArgsLog.push(args);
        if (args[0] === "run-pipeline") {
          return {
            data: { intent: { type: "explain" }, diagnostics: {}, taskSummary: {} },
            command: "/ext/bin/vexb",
            exitCode: 0,
            stdout: "",
          };
        }
        return { data: makeReadyStatusEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText() {
        return { command: "/ext/bin/vexb", stdout: "" };
      },
    },
  });
  harness.vscode.window.showInputBox = ((options: { title?: string; placeHolder?: string; prompt?: string }) => {
    capturedOptions = options;
    return Promise.resolve("Refactor the login flow");
  }) as never;

  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  cliArgsLog.length = 0;
  const handler = harness.registeredCommands.get("vexb.runPipelineForCurrentTask");
  await handler?.();

  assert.equal(capturedOptions?.title, RUN_PIPELINE_MESSAGES.InputTitle);
  assert.equal(capturedOptions?.placeHolder, RUN_PIPELINE_MESSAGES.InputPlaceholder);

  const pipelineInvocation = cliArgsLog.find((args) => args[0] === "run-pipeline");
  assert.ok(pipelineInvocation, "run-pipeline CLI command must be invoked");
  assert.equal(pipelineInvocation?.[1], "/repo");
  assert.equal(pipelineInvocation?.[2], "Refactor the login flow");

  const pipelinePanel = harness.createdWebviewPanels.find((panel) => panel.title === "VEXB • Pipeline Result");
  assert.ok(pipelinePanel, "result must land in the RunPipeline webview panel");
  assert.match(pipelinePanel?.webview.html ?? "", /data-result-type="run_pipeline"/);
});

test("runPipelineForCurrentTask shows EmptyInput message and does not call run-pipeline on blank input", async () => {
  const errorMessages: string[] = [];
  const cliArgsLog: string[][] = [];
  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson(args: string[]) {
        cliArgsLog.push(args);
        return { data: makeReadyStatusEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText() {
        return { command: "/ext/bin/vexb", stdout: "" };
      },
    },
  });
  harness.vscode.window.showInputBox = (() => Promise.resolve("   ")) as never;
  harness.vscode.window.showErrorMessage = ((message: string) => {
    errorMessages.push(message);
    return Promise.resolve(undefined);
  }) as never;

  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  errorMessages.length = 0;
  cliArgsLog.length = 0;
  const handler = harness.registeredCommands.get("vexb.runPipelineForCurrentTask");
  await handler?.();

  assert.deepEqual(errorMessages, [RUN_PIPELINE_MESSAGES.EmptyInput]);
  assert.equal(cliArgsLog.some((args) => args[0] === "run-pipeline"), false);
});

test("runPipelineForCurrentTask shows NoWorkspace message when no folder is open", async () => {
  const errorMessages: string[] = [];
  const cliArgsLog: string[][] = [];
  const harness = createVscodeHarness({
    noWorkspace: true,
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson(args: string[]) {
        cliArgsLog.push(args);
        return { data: makeReadyStatusEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText() {
        return { command: "/ext/bin/vexb", stdout: "" };
      },
    },
  });
  harness.vscode.window.showErrorMessage = ((message: string) => {
    errorMessages.push(message);
    return Promise.resolve(undefined);
  }) as never;
  harness.vscode.window.showInputBox = (() => {
    throw new Error("showInputBox should not be called when no workspace is open");
  }) as never;

  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  errorMessages.length = 0;
  cliArgsLog.length = 0;
  const handler = harness.registeredCommands.get("vexb.runPipelineForCurrentTask");
  await handler?.();

  assert.deepEqual(errorMessages, [RUN_PIPELINE_MESSAGES.NoWorkspace]);
  assert.equal(cliArgsLog.some((args) => args[0] === "run-pipeline"), false);
});

test("runPipelineForCurrentTask shows NotInitialized message when the repo is not initialized", async () => {
  const errorMessages: string[] = [];
  const cliArgsLog: string[][] = [];
  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson(args: string[]) {
        cliArgsLog.push(args);
        return { data: makeNotInitializedStatusEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText() {
        return { command: "/ext/bin/vexb", stdout: "" };
      },
    },
  });
  harness.vscode.window.showErrorMessage = ((message: string) => {
    errorMessages.push(message);
    return Promise.resolve(undefined);
  }) as never;
  harness.vscode.window.showInputBox = (() => {
    throw new Error("showInputBox should not be called when the repo is not initialized");
  }) as never;

  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  errorMessages.length = 0;
  cliArgsLog.length = 0;
  const handler = harness.registeredCommands.get("vexb.runPipelineForCurrentTask");
  await handler?.();

  assert.deepEqual(errorMessages, [RUN_PIPELINE_MESSAGES.NotInitialized]);
  assert.equal(cliArgsLog.some((args) => args[0] === "run-pipeline"), false);
});

test("runPipelineForCurrentTask shows IndexNotReady message when setup completed but index is not ready", async () => {
  const errorMessages: string[] = [];
  const cliArgsLog: string[][] = [];
  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson(args: string[]) {
        cliArgsLog.push(args);
        return { data: makeInitializedButNotReadyEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText() {
        return { command: "/ext/bin/vexb", stdout: "" };
      },
    },
  });
  harness.vscode.window.showErrorMessage = ((message: string) => {
    errorMessages.push(message);
    return Promise.resolve(undefined);
  }) as never;
  harness.vscode.window.showInputBox = (() => {
    throw new Error("showInputBox should not be called when the index is not ready");
  }) as never;

  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  errorMessages.length = 0;
  cliArgsLog.length = 0;
  const handler = harness.registeredCommands.get("vexb.runPipelineForCurrentTask");
  await handler?.();

  assert.deepEqual(errorMessages, [RUN_PIPELINE_MESSAGES.IndexNotReady]);
  assert.equal(cliArgsLog.some((args) => args[0] === "run-pipeline"), false);
});

test("setupOrReindex shows NoWorkspace message and runs nothing when no folder is open", async () => {
  const errorMessages: string[] = [];
  const cliArgsLog: string[][] = [];
  const harness = createVscodeHarness({
    noWorkspace: true,
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson(args: string[]) {
        cliArgsLog.push(args);
        return { data: makeReadyStatusEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText(args: string[]) {
        cliArgsLog.push(args);
        return { command: "/ext/bin/vexb", stdout: "" };
      },
    },
  });
  harness.vscode.window.showErrorMessage = ((message: string) => {
    errorMessages.push(message);
    return Promise.resolve(undefined);
  }) as never;

  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  errorMessages.length = 0;
  cliArgsLog.length = 0;
  await harness.registeredCommands.get("vexb.setupOrReindex")?.();

  assert.deepEqual(errorMessages, [SETUP_REINDEX_MESSAGES.NoWorkspace]);
  assert.equal(
    cliArgsLog.some((args) => args[0] === "setup" || args[0] === "index"),
    false,
    "no setup/index CLI call should run without a workspace",
  );
});

test("setupOrReindex runs setup (not index) when the repo is not initialized", async () => {
  const cliArgsLog: string[][] = [];
  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson(args: string[]) {
        cliArgsLog.push(args);
        return { data: makeNotInitializedStatusEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText(args: string[]) {
        cliArgsLog.push(args);
        return { command: "/ext/bin/vexb", stdout: "setup ok" };
      },
    },
  });
  harness.vscode.window.showQuickPick = ((items: Array<{ label: string; agentId?: string }>) => {
    const first = items[0];
    return Promise.resolve(first ? { ...first, agentId: first.agentId ?? "claude-code" } : undefined);
  }) as never;

  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  cliArgsLog.length = 0;
  await harness.registeredCommands.get("vexb.setupOrReindex")?.();

  const setupCalls = cliArgsLog.filter((args) => args[0] === "setup");
  const indexCalls = cliArgsLog.filter((args) => args[0] === "index");
  assert.equal(setupCalls.length, 1, "setup CLI call must run exactly once");
  assert.equal(setupCalls[0]?.[1], "/repo");
  assert.equal(indexCalls.length, 0, "index CLI call must not run when the repo is not initialized");
});

test("setupOrReindex runs index (not setup) when initialized but index is not ready", async () => {
  const cliArgsLog: string[][] = [];
  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson(args: string[]) {
        cliArgsLog.push(args);
        return { data: makeInitializedButNotReadyEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText(args: string[]) {
        cliArgsLog.push(args);
        return { command: "/ext/bin/vexb", stdout: "" };
      },
    },
  });
  harness.vscode.window.showQuickPick = (() => {
    throw new Error("showQuickPick should not run when index is not ready");
  }) as never;

  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  cliArgsLog.length = 0;
  await harness.registeredCommands.get("vexb.setupOrReindex")?.();

  const setupCalls = cliArgsLog.filter((args) => args[0] === "setup");
  const indexCalls = cliArgsLog.filter((args) => args[0] === "index");
  assert.equal(indexCalls.length, 1, "index CLI call must run exactly once");
  assert.equal(indexCalls[0]?.[1], "/repo");
  assert.equal(setupCalls.length, 0);
});

test("setupOrReindex runs index when the repo is initialized and freshness is possibly_stale", async () => {
  const cliArgsLog: string[][] = [];
  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson(args: string[]) {
        cliArgsLog.push(args);
        return { data: makeStaleStatusEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText(args: string[]) {
        cliArgsLog.push(args);
        return { command: "/ext/bin/vexb", stdout: "" };
      },
    },
  });
  harness.vscode.window.showQuickPick = (() => {
    throw new Error("showQuickPick should not run when freshness is possibly_stale");
  }) as never;

  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  cliArgsLog.length = 0;
  await harness.registeredCommands.get("vexb.setupOrReindex")?.();

  const indexCalls = cliArgsLog.filter((args) => args[0] === "index");
  assert.equal(indexCalls.length, 1, "index CLI call must run exactly once when stale");
  assert.equal(indexCalls[0]?.[1], "/repo");
  assert.equal(cliArgsLog.some((args) => args[0] === "setup"), false);
});

test("setupOrReindex shows the ready quick pick and honors Cancel without touching the CLI", async () => {
  const cliArgsLog: string[][] = [];
  let capturedOptions: { title?: string; placeHolder?: string } | undefined;
  let capturedLabels: string[] | undefined;
  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson(args: string[]) {
        cliArgsLog.push(args);
        return { data: makeReadyStatusEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText(args: string[]) {
        cliArgsLog.push(args);
        return { command: "/ext/bin/vexb", stdout: "" };
      },
    },
  });
  harness.vscode.window.showQuickPick = ((items: Array<{ label: string }>, options: { title?: string; placeHolder?: string }) => {
    capturedOptions = options;
    capturedLabels = items.map((item) => item.label);
    const cancel = items.find((item) => item.label === SETUP_REINDEX_MESSAGES.ReadyQuickPickCancel);
    return Promise.resolve(cancel);
  }) as never;

  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  cliArgsLog.length = 0;
  await harness.registeredCommands.get("vexb.setupOrReindex")?.();

  assert.equal(capturedOptions?.title, SETUP_REINDEX_MESSAGES.ReadyQuickPickTitle);
  assert.equal(capturedOptions?.placeHolder, SETUP_REINDEX_MESSAGES.ReadyQuickPickPlaceholder);
  assert.deepEqual(capturedLabels, [
    SETUP_REINDEX_MESSAGES.ReadyQuickPickReindex,
    SETUP_REINDEX_MESSAGES.ReadyQuickPickShowIndexStatus,
    SETUP_REINDEX_MESSAGES.ReadyQuickPickDoctor,
    SETUP_REINDEX_MESSAGES.ReadyQuickPickCancel,
  ]);
  assert.equal(cliArgsLog.some((args) => args[0] === "setup" || args[0] === "index"), false);
});

test("setupOrReindex ready quick pick runs index when Re-index anyway is chosen", async () => {
  const cliArgsLog: string[][] = [];
  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson(args: string[]) {
        cliArgsLog.push(args);
        return { data: makeReadyStatusEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText(args: string[]) {
        cliArgsLog.push(args);
        return { command: "/ext/bin/vexb", stdout: "" };
      },
    },
  });
  harness.vscode.window.showQuickPick = ((items: Array<{ label: string }>) => {
    const choice = items.find((item) => item.label === SETUP_REINDEX_MESSAGES.ReadyQuickPickReindex);
    return Promise.resolve(choice);
  }) as never;

  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  cliArgsLog.length = 0;
  await harness.registeredCommands.get("vexb.setupOrReindex")?.();

  const indexCalls = cliArgsLog.filter((args) => args[0] === "index");
  assert.equal(indexCalls.length, 1, "ready + Re-index anyway should run index once");
  assert.equal(cliArgsLog.some((args) => args[0] === "setup"), false);
});

test("setupOrReindex ready quick pick delegates to existing commands without duplicating backend logic", async () => {
  const executedCommands: string[] = [];
  const cliArgsLog: string[][] = [];
  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson(args: string[]) {
        cliArgsLog.push(args);
        return { data: makeReadyStatusEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText(args: string[]) {
        cliArgsLog.push(args);
        return { command: "/ext/bin/vexb", stdout: "" };
      },
    },
  });
  harness.vscode.commands.executeCommand = ((id: string) => {
    executedCommands.push(id);
    return Promise.resolve(undefined);
  }) as never;
  harness.vscode.window.showQuickPick = ((items: Array<{ label: string }>) => {
    const choice = items.find((item) => item.label === SETUP_REINDEX_MESSAGES.ReadyQuickPickDoctor);
    return Promise.resolve(choice);
  }) as never;

  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  cliArgsLog.length = 0;
  executedCommands.length = 0;
  await harness.registeredCommands.get("vexb.setupOrReindex")?.();

  assert.ok(
    executedCommands.includes("vexb.doctor"),
    "Doctor branch must delegate to the existing vexb.doctor command, not duplicate its logic",
  );
  assert.equal(
    cliArgsLog.some((args) => args[0] === "setup" || args[0] === "index"),
    false,
    "Doctor branch must not fire setup/index CLI calls",
  );
});

test("setupOrReindex updates sidebar + status bar to Indexing… before the CLI resolves", async () => {
  let releaseCli: (() => void) | null = null;
  const cliFinished = new Promise<void>((resolve) => { releaseCli = resolve; });

  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson() {
        return { data: makeStaleStatusEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText() {
        await cliFinished;
        return { command: "/ext/bin/vexb", stdout: "reindex ok" };
      },
    },
  });

  const app = await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  const beforeText = harness.statusBar.text;

  const pending = harness.registeredCommands.get("vexb.setupOrReindex")?.();
  // Let refreshStatus + any quick-pick resolution run, but keep runText blocked on cliFinished.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const sectionsDuring = app.repoStatusProvider.getChildren() as Array<TreeNodeStub>;
  const overviewDuring = app.repoStatusProvider.getChildren(sectionsDuring[0]) as Array<TreeNodeStub>;
  assert.equal(overviewDuring[0]?.label, "Indexing…");
  assert.equal(overviewDuring[0]?.description, "Re-indexing this repo…");
  assert.match(harness.statusBar.text, /vexb: indexing/);
  assert.notEqual(harness.statusBar.text, beforeText);

  releaseCli?.();
  await pending;

  const sectionsAfter = app.repoStatusProvider.getChildren() as Array<TreeNodeStub>;
  const overviewAfter = app.repoStatusProvider.getChildren(sectionsAfter[0]) as Array<TreeNodeStub>;
  assert.notEqual(overviewAfter[0]?.label, "Indexing…", "busy state should clear after the CLI resolves");
  assert.doesNotMatch(harness.statusBar.text, /indexing/, "status bar must return to a non-busy state");
});

test("setupOrReindex labels running_setup when the repo is not initialized", async () => {
  let releaseCli: (() => void) | null = null;
  const cliFinished = new Promise<void>((resolve) => { releaseCli = resolve; });

  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson() {
        return { data: makeNotInitializedStatusEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText() {
        await cliFinished;
        return { command: "/ext/bin/vexb", stdout: "setup ok" };
      },
    },
  });
  harness.vscode.window.showQuickPick = ((items: Array<{ label: string; agentId?: string }>) => {
    const first = items[0];
    return Promise.resolve(first ? { ...first, agentId: first.agentId ?? "claude-code" } : undefined);
  }) as never;

  const app = await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  const pending = harness.registeredCommands.get("vexb.setupOrReindex")?.();
  // Wait for refreshStatus + pickAgent to settle while runText stays blocked on cliFinished.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const sections = app.repoStatusProvider.getChildren() as Array<TreeNodeStub>;
  const overview = app.repoStatusProvider.getChildren(sections[0]) as Array<TreeNodeStub>;
  assert.equal(overview[0]?.label, "Indexing…");
  assert.equal(overview[0]?.description, "Setting up and indexing this repo…");

  releaseCli?.();
  await pending;
});

test("setupOrReindex status bar surfaces different tooltips for setup vs reindex", async () => {
  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson() {
        return { data: makeStaleStatusEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText() {
        return { command: "/ext/bin/vexb", stdout: "" };
      },
    },
  });

  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  await harness.registeredCommands.get("vexb.setupOrReindex")?.();

  assert.doesNotMatch(harness.statusBar.text, /indexing/);
});

test("setupOrReindex clears busy back to idle on successful completion", async () => {
  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson() {
        return { data: makeStaleStatusEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText() {
        return { command: "/ext/bin/vexb", stdout: "reindex ok" };
      },
    },
  });

  const app = await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  await harness.registeredCommands.get("vexb.setupOrReindex")?.();

  assert.equal(app.busyState, "idle");
  assert.equal(app.repoStatusProvider.busyState, "idle");

  const sections = app.repoStatusProvider.getChildren() as Array<TreeNodeStub>;
  const overview = app.repoStatusProvider.getChildren(sections[0]) as Array<TreeNodeStub>;
  assert.notEqual(overview[0]?.label, "Indexing…");
});

test("setupOrReindex streams CLI stderr lines into the output channel as they arrive, and auto-focuses the channel before the run", async () => {
  const appendedLines: string[] = [];
  const outputShownTimestamps: number[] = [];
  const capturedOnStderrLine: Array<((line: string) => void) | undefined> = [];

  // Release gate: runTextStreaming only resolves after the test has observed mid-run lines.
  let releaseStreaming: (() => void) | null = null;
  const streamingFinished = new Promise<void>((resolve) => { releaseStreaming = resolve; });

  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson() {
        return { data: makeStaleStatusEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText() {
        return { command: "/ext/bin/vexb", stdout: "" };
      },
      async runTextStreaming(_args, _cwd, handlers) {
        capturedOnStderrLine.push(handlers?.onStderrLine);
        handlers?.onStderrLine?.("parsing src/a.ts");
        handlers?.onStderrLine?.("parsing src/b.ts");
        await streamingFinished;
        return { command: "/ext/bin/vexb", stdout: "Index updated: 2 files." };
      },
    },
  });

  // Capture every appendLine call and note when show() is first invoked,
  // so we can assert show() happens before any streamed lines land.
  harness.overrides.outputChannel = {
    clear() {},
    appendLine(line: string) { appendedLines.push(line); },
    append(line: string) { appendedLines.push(line); },
    show(_preserveFocus?: boolean) { outputShownTimestamps.push(appendedLines.length); },
    dispose() {},
  } as never;

  await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);

  const pending = harness.registeredCommands.get("vexb.setupOrReindex")?.();

  // Let the streaming handler push its two mid-run lines into the output channel.
  await new Promise((resolve) => setTimeout(resolve, 10));

  // The output channel must be shown BEFORE any streamed lines arrive.
  assert.ok(outputShownTimestamps.length > 0, "output channel must be shown during setup/reindex");
  const firstShownIdx = outputShownTimestamps[0] ?? 0;
  const firstStreamedIdx = appendedLines.findIndex((line) => line === "parsing src/a.ts");
  assert.ok(
    firstStreamedIdx >= 0,
    "first streamed stderr line must have been appended to the output channel during the run",
  );
  assert.ok(
    firstShownIdx <= firstStreamedIdx,
    `output.show must happen before streamed lines arrive (shown at idx ${firstShownIdx}, first line at idx ${firstStreamedIdx})`,
  );

  // Mid-run, both streamed lines should already be visible — this is the whole point
  // of streaming vs. the old buffered behaviour.
  assert.ok(appendedLines.includes("parsing src/a.ts"));
  assert.ok(appendedLines.includes("parsing src/b.ts"));

  releaseStreaming?.();
  await pending;

  // An onStderrLine handler must have been wired — otherwise streaming doesn't happen.
  assert.equal(capturedOnStderrLine.length, 1);
  assert.equal(typeof capturedOnStderrLine[0], "function");

  // Final stdout payload still lands in the output channel after the run completes.
  assert.ok(appendedLines.some((line) => line.includes("Index updated: 2 files.")));
});

test("setupOrReindex clears busy back to idle and surfaces error on CLI failure", async () => {
  const errorMessages: string[] = [];
  const harness = createVscodeHarness({
    cliBridge: {
      async getExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      getLastExecutableInfo() {
        return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
      },
      async runJson() {
        return { data: makeStaleStatusEnvelope(), command: "/ext/bin/vexb", exitCode: 0, stdout: "" };
      },
      async runText() {
        const error: Error & { stderr?: string; code?: string } = new Error("index failed: disk full");
        error.code = "VEXB_COMMAND_FAILED";
        error.stderr = "disk full";
        throw error;
      },
    },
  });
  harness.vscode.window.showErrorMessage = ((message: string) => {
    errorMessages.push(message);
    return Promise.resolve(undefined);
  }) as never;

  const app = await activateWithVscode(harness.vscode as never, harness.context, harness.overrides);
  errorMessages.length = 0;
  await harness.registeredCommands.get("vexb.setupOrReindex")?.();

  assert.equal(app.busyState, "idle", "busy state must clear even on failure");
  assert.equal(app.repoStatusProvider.busyState, "idle");
  assert.ok(errorMessages.length > 0, "user must see a failure message");

  const sections = app.repoStatusProvider.getChildren() as Array<TreeNodeStub>;
  const overview = app.repoStatusProvider.getChildren(sections[0]) as Array<TreeNodeStub>;
  assert.notEqual(overview[0]?.label, "Indexing…", "busy state row must clear after failure");
  assert.doesNotMatch(harness.statusBar.text, /indexing/, "status bar must clear after failure");
});

async function invokeRefresh(harness: ReturnType<typeof createVscodeHarness>) {
  const entry = harness.registeredCommands.get("vexb.refreshStatus");
  if (entry === undefined) throw new Error("refreshStatus command missing");
  await entry();
}

type TreeNodeStub = {
  label: string;
  description?: string;
  tooltip?: string;
  command?: { command: string; title: string };
  __vexbChildren?: unknown;
};

function createVscodeHarness(options: {
  noWorkspace?: boolean;
  cliBridge?: FakeCliBridge;
  onDidChangeWorkspaceFolders?: (listener: () => void) => void;
} = {}) {
  const subscriptions: Array<{ dispose(): void }> = [];
  const registeredCommandIds: string[] = [];
  const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
  const createdWebviewPanels: Array<{
    title: string;
    webview: { html: string };
    revealed: boolean;
    disposed: boolean;
  }> = [];

  const outputChannel = {
    clear() {},
    appendLine(_line: string) {},
    append(_line: string) {},
    show(_preserveFocus?: boolean) {},
    dispose() {},
  };
  const statusBar: {
    text: string;
    tooltip: string | undefined;
    command: string | undefined;
    color: string | undefined;
    shown: boolean;
    show(): void;
    hide(): void;
    dispose(): void;
  } = {
    text: "",
    tooltip: undefined,
    command: undefined,
    color: undefined,
    shown: false,
    show() { this.shown = true; },
    hide() { this.shown = false; },
    dispose() {},
  };

  const defaultCliBridge: FakeCliBridge = {
    async getExecutableInfo() {
      return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
    },
    getLastExecutableInfo() {
      return { command: "/ext/bin/vexb", source: EXECUTABLE_SOURCES.Bundled, attempted: [] };
    },
    async runJson() {
      return {
        data: makeReadyStatusEnvelope(),
        command: "/ext/bin/vexb",
        exitCode: 0,
        stdout: "",
      };
    },
    async runText() {
      return { command: "/ext/bin/vexb", stdout: "" };
    },
  };

  const folders = options.noWorkspace
    ? undefined
    : [{ name: "repo", uri: { fsPath: "/repo" } }];

  const vscode = {
    StatusBarAlignment: { Left: 1 },
    TreeItemCollapsibleState: { None: 0 },
    ViewColumn: { Active: 1 },
    ProgressLocation: { Notification: 15, SourceControl: 1, Window: 10 },
    TreeItem: class {
      label: string;
      collapsibleState: number;
      description?: string;
      tooltip?: string;
      iconPath?: unknown;
      command?: unknown;
      constructor(label: string, collapsibleState: number) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    ThemeIcon: class {
      id: string;
      constructor(id: string) { this.id = id; }
    },
    EventEmitter: class {
      listeners: Array<(value: unknown) => void> = [];
      event = (listener: (value: unknown) => void) => {
        this.listeners.push(listener);
        return { dispose: () => {} };
      };
      fire(value: unknown) {
        for (const listener of this.listeners) listener(value);
      }
      dispose() { this.listeners = []; }
    },
    Uri: {
      parse(value: string) { return { toString: () => value }; },
      file(value: string) { return { fsPath: value, toString: () => `file://${value}` }; },
    },
    window: {
      createOutputChannel: () => outputChannel,
      createStatusBarItem: () => statusBar,
      createWebviewPanel(_viewType: string, title: string) {
        const panel = {
          title,
          webview: { html: "" },
          revealed: false,
          disposed: false,
          reveal() { panel.revealed = true; },
          onDidDispose(_listener: () => void) { return { dispose() {} }; },
          dispose() { panel.disposed = true; },
        };
        createdWebviewPanels.push(panel);
        return panel;
      },
      activeTextEditor: undefined,
      showErrorMessage() { return Promise.resolve(undefined); },
      showWarningMessage() { return Promise.resolve(undefined); },
      showInformationMessage() { return Promise.resolve(undefined); },
      onDidChangeActiveTextEditor() { return { dispose() {} }; },
      onDidChangeWindowState() { return { dispose() {} }; },
      withProgress(_options: { title?: string }, callback: (progress: unknown) => Promise<unknown>) {
        return callback({ report() {} });
      },
    },
    workspace: {
      workspaceFolders: folders,
      getConfiguration: () => ({ get: () => "" }),
      getWorkspaceFolder: () => undefined,
      onDidChangeWorkspaceFolders(listener: () => void) {
        options.onDidChangeWorkspaceFolders?.(listener);
        return { dispose() {} };
      },
      registerTextDocumentContentProvider() { return { dispose() {} }; },
    },
    commands: {
      registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
        registeredCommandIds.push(id);
        registeredCommands.set(id, handler);
        assert.equal(typeof handler, "function");
        return { dispose() {} };
      },
      executeCommand(_id: string) {
        return Promise.resolve(undefined);
      },
    },
  };

  const overrides = {
    outputChannel,
    statusBarItem: statusBar,
    cliBridge: withStreamingFallback(options.cliBridge ?? defaultCliBridge),
    createTreeView: (() => ({ dispose() {} })) as never,
  };

  return {
    vscode,
    context: { subscriptions, extensionPath: "/ext" },
    overrides,
    statusBar,
    registeredCommandIds,
    registeredCommands,
    createdWebviewPanels,
  };
}

type FakeCliBridge = {
  getExecutableInfo(): Promise<{ command: string; source: string; attempted: unknown[] }>;
  getLastExecutableInfo(): { command: string; source: string; attempted: unknown[] } | null;
  runJson(args: string[], cwd: string): Promise<{ data: unknown; command: string; exitCode: number; stdout: string }>;
  runText(args: string[], cwd: string): Promise<{ command: string; stdout: string }>;
  runTextStreaming?(
    args: string[],
    cwd: string,
    handlers?: { onStderrLine?: (line: string) => void },
  ): Promise<{ command: string; stdout: string }>;
};

// Tests that don't care about streaming can supply a bridge with only runText;
// this shim adds a runTextStreaming that delegates to runText so setup/reindex flows
// exercise the streaming code path without needing every fixture to know about it.
function withStreamingFallback(bridge: FakeCliBridge): FakeCliBridge {
  if (bridge.runTextStreaming !== undefined) return bridge;
  return {
    ...bridge,
    async runTextStreaming(args, cwd, _handlers) {
      return await bridge.runText(args, cwd);
    },
  };
}

function makeReadyStatusEnvelope() {
  return {
    ok: true,
    command: "status",
    repoRoot: "/repo",
    timestampMs: 1,
    warnings: [],
    nextSteps: [],
    error: null,
    result: {
      selectedAgent: "claude-code",
      repoState: { initialized: true },
      indexState: {
        latestRunId: 1,
        freshness: {
          state: "fresh",
          summary: "fresh",
          recommendedAction: null,
        },
        readiness: { status: "ready", summary: "ready", checks: [] },
      },
      agentConfig: { installed: true, matchesExpected: true },
      runtime: { running: false, status: "not_running" },
    },
  };
}

function makeStaleStatusEnvelope() {
  return {
    ok: true,
    command: "status",
    repoRoot: "/repo",
    timestampMs: 1,
    warnings: [],
    nextSteps: [],
    error: null,
    result: {
      selectedAgent: "claude-code",
      repoState: { initialized: true },
      indexState: {
        latestRunId: 1,
        freshness: { state: "possibly_stale", summary: "drift detected", recommendedAction: "re-index" },
        readiness: { status: "ready", summary: "ready", checks: [] },
      },
      agentConfig: { installed: true, matchesExpected: true },
      runtime: { running: false, status: "not_running" },
    },
  };
}

function makeInitializedButNotReadyEnvelope() {
  return {
    ok: true,
    command: "status",
    repoRoot: "/repo",
    timestampMs: 1,
    warnings: [],
    nextSteps: ["Finish setup or indexing, then try again."],
    error: null,
    result: {
      selectedAgent: "claude-code",
      repoState: { initialized: true },
      indexState: {
        latestRunId: null,
        freshness: { state: "unknown", summary: "", recommendedAction: null },
        readiness: { status: "pending", summary: "index not ready", checks: [] },
      },
      agentConfig: { installed: true, matchesExpected: true },
      runtime: { running: false, status: "not_running" },
    },
  };
}

function makeNotInitializedStatusEnvelope() {
  return {
    ok: true,
    command: "status",
    repoRoot: "/repo",
    timestampMs: 1,
    warnings: [],
    nextSteps: ["Run `vexb setup /repo` to initialize and index the repo."],
    error: null,
    result: {
      selectedAgent: "claude-code",
      repoState: { initialized: false },
      indexState: {
        latestRunId: null,
        freshness: { state: "unknown", summary: "", recommendedAction: null },
        readiness: null,
      },
      agentConfig: { installed: false, matchesExpected: false },
      runtime: { running: false, status: "not_running" },
    },
  };
}
