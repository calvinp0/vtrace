import assert from "node:assert/strict";
import { test } from "bun:test";

import { EXECUTABLE_SOURCES } from "./cli.js";
import {
  COMMAND_IDS,
  EDITOR_EMPTY_STATE_MESSAGES,
  EMPTY_STATE_MESSAGES,
  SECTION_IDS,
  buildExecutableResolutionReport,
  buildFreshnessReport,
  buildIndexStatusReport,
  buildRepoSnapshot,
  buildRepoTreeSections,
  buildResultDocumentBody,
  buildResultDocumentUri,
  buildRuntimeReport,
  buildSetupConfigReport,
  buildStatusBarState,
  createCliUnavailableSnapshot,
  createNoWorkspaceSnapshot,
  createUnavailableSnapshot,
  findSymbolAtLine,
  parseShellJson,
  primaryStatusCommand,
  selectPrimaryAgent,
} from "./shell.js";

test("parseShellJson accepts status and doctor envelopes", () => {
  const status = parseShellJson(JSON.stringify(makeShellEnvelope({ command: "status" })));
  const doctor = parseShellJson(JSON.stringify(makeShellEnvelope({ command: "doctor" })));

  assert.equal(status.command, "status");
  assert.equal(doctor.command, "doctor");
});

test("buildRepoTreeSections renders the four spec sections in order with distinct header icons", () => {
  const sections = buildRepoTreeSections(createNoWorkspaceSnapshot());
  assert.deepEqual(sections.map((section) => section.id), [
    SECTION_IDS.Overview,
    SECTION_IDS.QuickActions,
    SECTION_IDS.CurrentAgent,
    SECTION_IDS.OutputDiagnostics,
  ]);
  assert.deepEqual(sections.map((section) => section.label), [
    "OVERVIEW",
    "QUICK ACTIONS",
    "CURRENT AGENT",
    "OUTPUT & DIAGNOSTICS",
  ]);
  // Each section carries a distinct codicon so headers read as structural vs. row content.
  const icons = sections.map((section) => section.icon);
  assert.deepEqual(icons, ["dashboard", "zap", "hubot", "pulse"]);
  assert.equal(new Set(icons).size, icons.length, "section icons must be distinct");
});

test("Overview rows render in exact spec order with exact labels", () => {
  const snapshot = buildRepoSnapshot(
    makeShellEnvelope(),
    [],
    { command: "/ext/bin/vtrace", source: EXECUTABLE_SOURCES.Bundled, attempted: [] },
  );
  const overview = sectionByIdOrThrow(buildRepoTreeSections(snapshot), SECTION_IDS.Overview);

  assert.deepEqual(overview.children.map((row) => row.label), [
    "Ready",
    "Repo root",
    "Setup",
    "Index",
    "Latest run",
    "Freshness",
    "Runtime",
  ]);
});

test("Quick Actions exposes the spec actions in order and wires correct commands", () => {
  const quick = sectionByIdOrThrow(buildRepoTreeSections(createNoWorkspaceSnapshot()), SECTION_IDS.QuickActions);

  assert.deepEqual(quick.children.map((row) => row.label), [
    "Refresh",
    "Run Pipeline for Current Task",
    "Setup / Re-index",
    "Show File Skeleton",
    "Show Impact Graph",
  ]);
  assert.deepEqual(quick.children.map((row) => row.command), [
    COMMAND_IDS.RefreshStatus,
    COMMAND_IDS.RunPipelineForCurrentTask,
    COMMAND_IDS.SetupOrReindex,
    COMMAND_IDS.ShowFileSkeleton,
    COMMAND_IDS.ShowImpactGraphAtCursor,
  ]);
});

test("Current Agent exposes Selected / Config / Config file rows with config path", () => {
  const snapshot = buildRepoSnapshot(
    makeShellEnvelope({
      agentConfigPath: "/home/test/.claude.json",
      agentDisplayName: "Claude Code",
    }),
    [],
    null,
  );
  const currentAgent = sectionByIdOrThrow(buildRepoTreeSections(snapshot), SECTION_IDS.CurrentAgent);

  assert.deepEqual(currentAgent.children.map((row) => row.label), ["Selected", "Config", "Config file"]);
  assert.equal(currentAgent.children[0]?.description, "claude-code");
  assert.equal(currentAgent.children[1]?.description, "installed and current");
  assert.equal(currentAgent.children[2]?.description, "/home/test/.claude.json");
  assert.equal(currentAgent.children[2]?.command, COMMAND_IDS.OpenAgentConfigFile);
});

test("Output & Diagnostics exposes Doctor, Open vtrace Output, and Executable Resolution rows in order", () => {
  const snapshot = buildRepoSnapshot(
    makeShellEnvelope(),
    [],
    { command: "/usr/bin/vtrace", source: EXECUTABLE_SOURCES.Path, attempted: [] },
  );
  const output = sectionByIdOrThrow(buildRepoTreeSections(snapshot), SECTION_IDS.OutputDiagnostics);

  assert.deepEqual(output.children.map((row) => row.label), ["Doctor", "Open vtrace Output", "Executable Resolution"]);
  assert.deepEqual(output.children.map((row) => row.command), [
    COMMAND_IDS.Doctor,
    COMMAND_IDS.OpenOutput,
    COMMAND_IDS.ShowExecutableResolutionReport,
  ]);
  assert.equal(output.children[2]?.description, "using vtrace on PATH");
});

test("Ready snapshot surfaces Ready primary status and click commands per spec", () => {
  const snapshot = buildRepoSnapshot(
    makeShellEnvelope(),
    [makeShellEnvelope({ selectedAgent: "codex", agentInstalled: false, agentMatchesExpected: false })],
    { command: "/ext/bin/vtrace", source: EXECUTABLE_SOURCES.Bundled, attempted: [] },
  );
  const overview = sectionByIdOrThrow(buildRepoTreeSections(snapshot), SECTION_IDS.Overview);
  const byLabel = indexByLabel(overview.children);

  assert.equal(snapshot.state, "ready");
  assert.equal(overview.children[0]?.label, "Ready");
  assert.equal(overview.children[0]?.command, COMMAND_IDS.ShowIndexStatus);
  assert.equal(byLabel["Repo root"]?.description, "/repo");
  assert.equal(byLabel["Repo root"]?.command, COMMAND_IDS.RevealRepoRoot);
  assert.equal(byLabel["Setup"]?.description, "initialized");
  assert.equal(byLabel["Setup"]?.command, undefined);
  assert.equal(byLabel["Index"]?.description, "ready");
  assert.equal(byLabel["Index"]?.command, undefined);
  assert.equal(byLabel["Latest run"]?.description, "#7");
  assert.equal(byLabel["Latest run"]?.command, undefined);
  assert.equal(byLabel["Freshness"]?.description, "fresh");
  assert.equal(byLabel["Freshness"]?.command, COMMAND_IDS.ShowFreshnessReport);
  assert.equal(byLabel["Runtime"]?.description, "not running");
  assert.equal(byLabel["Runtime"]?.command, COMMAND_IDS.ShowRuntimeReport);
  assert.equal(byLabel["CLI"], undefined);
});

test("Possibly stale snapshot surfaces stale freshness and spec-matching primary label", () => {
  const snapshot = buildRepoSnapshot(makeShellEnvelope({
    freshnessState: "possibly_stale",
    freshnessSummary: "Vtrace detected likely drift.",
    freshnessRecommendedAction: "Re-index this repo.",
  }));
  const overview = sectionByIdOrThrow(buildRepoTreeSections(snapshot), SECTION_IDS.Overview);
  const byLabel = indexByLabel(overview.children);

  assert.equal(overview.children[0]?.label, "Possibly stale");
  assert.equal(byLabel["Freshness"]?.description, "possibly stale");
  assert.match(String(byLabel["Freshness"]?.tooltip), /Re-index/);
});

test("Not initialized snapshot labels setup and index as spec values and wires setup click", () => {
  const snapshot = buildRepoSnapshot(makeShellEnvelope({
    initialized: false,
    readiness: null,
    latestRunId: null,
    freshnessState: "unknown",
  }));
  const overview = sectionByIdOrThrow(buildRepoTreeSections(snapshot), SECTION_IDS.Overview);
  const byLabel = indexByLabel(overview.children);

  assert.equal(overview.children[0]?.label, "Not initialized");
  assert.equal(byLabel["Setup"]?.description, "not initialized");
  assert.equal(byLabel["Setup"]?.command, undefined);
  assert.equal(byLabel["Index"]?.description, "not initialized yet");
  assert.equal(byLabel["Index"]?.command, undefined);
  assert.equal(byLabel["Latest run"]?.description, "none");
  assert.equal(byLabel["Latest run"]?.command, undefined);
});

test("No workspace snapshot shows No workspace primary status and folder-picker click on repo root", () => {
  const snapshot = createNoWorkspaceSnapshot();
  const overview = sectionByIdOrThrow(buildRepoTreeSections(snapshot), SECTION_IDS.Overview);
  const byLabel = indexByLabel(overview.children);

  assert.equal(overview.children[0]?.label, "No workspace");
  assert.equal(overview.children[0]?.description, EMPTY_STATE_MESSAGES.NoWorkspaceHelper);
  assert.equal(byLabel["Repo root"]?.description, "No workspace open");
  assert.equal(byLabel["Repo root"]?.command, COMMAND_IDS.RevealRepoRoot);
  assert.equal(byLabel["Setup"]?.description, "unknown");
  assert.equal(byLabel["Index"]?.description, "unknown");
  assert.equal(byLabel["Latest run"]?.description, "none");
  assert.equal(byLabel["Freshness"]?.description, "unknown");
  assert.equal(byLabel["Runtime"]?.description, "unknown");
  assert.equal(byLabel["CLI"], undefined);

  const quick = sectionByIdOrThrow(buildRepoTreeSections(snapshot), SECTION_IDS.QuickActions);
  assert.ok(quick.children.some((row) => row.label === "Refresh"));
  assert.ok(quick.children.some((row) => row.label === "Setup / Re-index"));
});

test("VTRACE not found snapshot exposes missing CLI across Overview and Output sections", () => {
  const snapshot = createCliUnavailableSnapshot(
    "vtrace CLI was not found.\nSet `vtrace.cliPath`.",
    "/repo",
    {
      command: "vtrace",
      source: EXECUTABLE_SOURCES.Missing,
      attempted: [
        { source: EXECUTABLE_SOURCES.Bundled, path: "/ext/bin/vtrace" },
        { source: EXECUTABLE_SOURCES.Path, path: "vtrace" },
      ],
    },
  );
  const overview = sectionByIdOrThrow(buildRepoTreeSections(snapshot), SECTION_IDS.Overview);
  const byLabel = indexByLabel(overview.children);
  const output = sectionByIdOrThrow(buildRepoTreeSections(snapshot), SECTION_IDS.OutputDiagnostics);
  const outByLabel = indexByLabel(output.children);

  assert.equal(overview.children[0]?.label, "VTRACE not found");
  assert.equal(overview.children[0]?.description, EMPTY_STATE_MESSAGES.CliNotFoundHelper);
  assert.equal(byLabel["Repo root"]?.description, "/repo");
  assert.equal(byLabel["CLI"], undefined);
  assert.equal(outByLabel["Executable Resolution"]?.description, "no executable found");
  assert.match(String(outByLabel["Executable Resolution"]?.tooltip), /Attempted/);
});

test("Status bar reflects stale, ready, not-initialized, no-workspace states", () => {
  assert.match(buildStatusBarState(createNoWorkspaceSnapshot()).text, /no workspace/);
  assert.match(buildStatusBarState(createCliUnavailableSnapshot("missing", "/repo", null)).text, /CLI missing/);

  const ready = buildRepoSnapshot(makeShellEnvelope(), [], {
    command: "/ext/bin/vtrace",
    source: EXECUTABLE_SOURCES.Bundled,
    attempted: [],
  });
  assert.match(buildStatusBarState(ready).text, /ready/);

  const stale = buildRepoSnapshot(makeShellEnvelope({ freshnessState: "possibly_stale" }));
  assert.match(buildStatusBarState(stale).text, /stale/);

  const notInitialized = buildRepoSnapshot(makeShellEnvelope({
    initialized: false, readiness: null, latestRunId: null, freshnessState: "unknown",
  }));
  assert.match(buildStatusBarState(notInitialized).text, /not initialized/);
});

test("Unavailable snapshot renders Unknown state primary status with repo root preserved", () => {
  const snapshot = createUnavailableSnapshot("status is unavailable", "/repo");
  const overview = sectionByIdOrThrow(buildRepoTreeSections(snapshot), SECTION_IDS.Overview);
  const byLabel = indexByLabel(overview.children);

  assert.equal(overview.children[0]?.label, "Unknown state");
  assert.equal(byLabel["Repo root"]?.description, "/repo");
});

test("selectPrimaryAgent prefers the default selected, installed and current agent", () => {
  const snapshot = buildRepoSnapshot(
    makeShellEnvelope({
      agentConfigPath: "/home/test/.claude.json",
      agentDisplayName: "Claude Code",
    }),
    [makeShellEnvelope({
      selectedAgent: "codex",
      agentInstalled: true,
      agentMatchesExpected: true,
      agentConfigPath: "/repo/.codex/config.toml",
      agentDisplayName: "Codex",
    })],
  );
  const primary = selectPrimaryAgent(snapshot);
  assert.equal(primary?.id, "claude-code");
  assert.equal(primary?.configPath, "/home/test/.claude.json");
});

test("buildResultDocumentBody prefixes metadata header before command stdout", () => {
  const body = buildResultDocumentBody("Context Capsule", "payload body", {
    repoRoot: "/repo",
    command: "/ext/bin/vtrace capsule /repo 'trace auth'",
    executable: {
      command: "/ext/bin/vtrace",
      source: EXECUTABLE_SOURCES.Bundled,
      attempted: [],
    },
    generatedAt: "2026-04-21T00:00:00.000Z",
  });

  assert.match(body, /# Context Capsule/);
  assert.match(body, /Repo: \/repo/);
  assert.match(body, /Command: \/ext\/bin\/vtrace capsule/);
  assert.match(body, /Executable: \/ext\/bin\/vtrace \(Bundled launcher\)/);
  assert.match(body, /Generated: 2026-04-21T00:00:00\.000Z/);
  assert.match(body, /\npayload body\n$/);
});

test("buildResultDocumentUri sanitizes titles and zero-pads the counter", () => {
  assert.equal(
    buildResultDocumentUri("File Skeleton: src/app.ts", 3),
    "vtrace:/results/0003-File-Skeleton-src-app.ts.md",
  );
  assert.equal(
    buildResultDocumentUri("Impact Graph: App::render", 42),
    "vtrace:/results/0042-Impact-Graph-App-render.md",
  );
});

test("primaryStatusCommand routes each state to the narrowest focused report", () => {
  assert.equal(primaryStatusCommand(createNoWorkspaceSnapshot()), COMMAND_IDS.ShowNoWorkspaceGuidance);
  assert.equal(
    primaryStatusCommand(createCliUnavailableSnapshot("missing", "/repo", null)),
    COMMAND_IDS.ShowExecutableResolutionReport,
  );
  assert.equal(
    primaryStatusCommand(createUnavailableSnapshot("bad", "/repo")),
    COMMAND_IDS.Doctor,
  );

  const ready = buildRepoSnapshot(makeShellEnvelope());
  assert.equal(primaryStatusCommand(ready), COMMAND_IDS.ShowIndexStatus);

  const stale = buildRepoSnapshot(makeShellEnvelope({ freshnessState: "possibly_stale" }));
  assert.equal(primaryStatusCommand(stale), COMMAND_IDS.ShowFreshnessReport);

  const notInitialized = buildRepoSnapshot(makeShellEnvelope({
    initialized: false, readiness: null, latestRunId: null, freshnessState: "unknown",
  }));
  assert.equal(primaryStatusCommand(notInitialized), COMMAND_IDS.ShowSetupConfigReport);

  const unknownFreshness = buildRepoSnapshot(makeShellEnvelope({ freshnessState: "unknown" }));
  assert.equal(primaryStatusCommand(unknownFreshness), COMMAND_IDS.Doctor);
});

test("Overview is primarily informational — Setup / Index / Latest run carry no click command", () => {
  const snapshot = buildRepoSnapshot(
    makeShellEnvelope(),
    [],
    { command: "/ext/bin/vtrace", source: EXECUTABLE_SOURCES.Bundled, attempted: [] },
  );
  const overview = sectionByIdOrThrow(buildRepoTreeSections(snapshot), SECTION_IDS.Overview);
  const byLabel = indexByLabel(overview.children);

  // Setup / Index / Latest run describe state only — no click destination.
  assert.equal(byLabel["Setup"]?.command, undefined);
  assert.equal(byLabel["Index"]?.command, undefined);
  assert.equal(byLabel["Latest run"]?.command, undefined);

  // The clickable Overview rows each open a distinct narrow report.
  const clickable = [
    overview.children[0]?.command, // primary status
    byLabel["Repo root"]?.command,
    byLabel["Freshness"]?.command,
    byLabel["Runtime"]?.command,
  ];
  assert.equal(
    new Set(clickable).size,
    clickable.length,
    `clickable Overview rows must have distinct destinations; got ${JSON.stringify(clickable)}`,
  );

  // None of the narrow informational or clickable rows default to the Doctor command.
  assert.notEqual(byLabel["Freshness"]?.command, COMMAND_IDS.Doctor);
  assert.notEqual(byLabel["Runtime"]?.command, COMMAND_IDS.Doctor);
});

test("Quick Actions is trimmed to the five spec rows — no Doctor / Show Index Status / Generate Context Capsule", () => {
  const snapshot = buildRepoSnapshot(
    makeShellEnvelope(),
    [],
    { command: "/ext/bin/vtrace", source: EXECUTABLE_SOURCES.Bundled, attempted: [] },
  );
  const quick = sectionByIdOrThrow(buildRepoTreeSections(snapshot), SECTION_IDS.QuickActions);
  const commands = quick.children.map((row) => row.command);

  assert.equal(quick.children.length, 5);
  assert.equal(commands.includes(COMMAND_IDS.Doctor), false, "Doctor is diagnostic, not a primary action");
  assert.equal(commands.includes(COMMAND_IDS.ShowIndexStatus), false, "Show Index Status is covered by Setup / Re-index and Doctor");
  assert.equal(commands.includes(COMMAND_IDS.GenerateContextCapsule), false, "Generate Context Capsule is covered by Run Pipeline for Current Task");
  assert.equal(commands.includes(COMMAND_IDS.SetupAgent), false, "Setup Agent is covered by Setup / Re-index");
});

test("No two visible primary rows open the same output across Quick Actions and Output & Diagnostics", () => {
  const snapshot = buildRepoSnapshot(
    makeShellEnvelope(),
    [],
    { command: "/ext/bin/vtrace", source: EXECUTABLE_SOURCES.Bundled, attempted: [] },
  );
  const quick = sectionByIdOrThrow(buildRepoTreeSections(snapshot), SECTION_IDS.QuickActions);
  const diagnostics = sectionByIdOrThrow(buildRepoTreeSections(snapshot), SECTION_IDS.OutputDiagnostics);
  const allPrimaryCommands = [
    ...quick.children.map((row) => row.command),
    ...diagnostics.children.map((row) => row.command),
  ].filter((command): command is string => typeof command === "string");

  assert.equal(
    new Set(allPrimaryCommands).size,
    allPrimaryCommands.length,
    `primary rows must have unique destinations; got ${JSON.stringify(allPrimaryCommands)}`,
  );
});

test("Doctor lives only in Output & Diagnostics — not promoted into Overview or Quick Actions", () => {
  const snapshot = buildRepoSnapshot(
    makeShellEnvelope(),
    [],
    { command: "/ext/bin/vtrace", source: EXECUTABLE_SOURCES.Bundled, attempted: [] },
  );
  const sections = buildRepoTreeSections(snapshot);
  const overview = sectionByIdOrThrow(sections, SECTION_IDS.Overview);
  const quick = sectionByIdOrThrow(sections, SECTION_IDS.QuickActions);
  const diagnostics = sectionByIdOrThrow(sections, SECTION_IDS.OutputDiagnostics);

  // Doctor surfaces exactly once — as the first row of Output & Diagnostics.
  assert.equal(diagnostics.children[0]?.label, "Doctor");
  assert.equal(diagnostics.children[0]?.command, COMMAND_IDS.Doctor);

  const doctorCountInQuick = quick.children.filter((row) => row.command === COMMAND_IDS.Doctor).length;
  assert.equal(doctorCountInQuick, 0);
  // Overview rows that carry commands should not default to Doctor when a distinct report exists.
  for (const row of overview.children) {
    if (row.command === COMMAND_IDS.Doctor) {
      // Doctor as Overview primary-status fallback is acceptable only for states with no narrower report
      // (e.g. `unavailable` / `not_ready` / `unknown`). A ready snapshot must not route Overview rows to Doctor.
      assert.fail(`Overview row ${row.label} must not default to Doctor in a ready snapshot`);
    }
  }
});

test("Current Agent Config row routes to SetupAgent when drifted and SetupConfigReport when healthy", () => {
  const healthy = buildRepoSnapshot(makeShellEnvelope());
  const healthySection = sectionByIdOrThrow(buildRepoTreeSections(healthy), SECTION_IDS.CurrentAgent);
  const healthyByLabel = indexByLabel(healthySection.children);
  assert.equal(healthyByLabel["Config"]?.command, COMMAND_IDS.ShowSetupConfigReport);
  assert.equal(healthyByLabel["Selected"]?.command, COMMAND_IDS.ShowSetupConfigReport);

  const drifted = buildRepoSnapshot(makeShellEnvelope({ agentMatchesExpected: false }));
  const driftedSection = sectionByIdOrThrow(buildRepoTreeSections(drifted), SECTION_IDS.CurrentAgent);
  const driftedByLabel = indexByLabel(driftedSection.children);
  assert.equal(driftedByLabel["Config"]?.command, COMMAND_IDS.SetupAgent);
  assert.equal(driftedByLabel["Selected"]?.command, COMMAND_IDS.SetupAgent);
});

test("buildIndexStatusReport includes repo/setup/index/run/freshness lines, no full runtime block", () => {
  const snapshot = buildRepoSnapshot(makeShellEnvelope());
  const body = buildIndexStatusReport(snapshot);

  assert.match(body, /^# Index Status/m);
  assert.match(body, /Repo root: \/repo/);
  assert.match(body, /Setup: initialized/);
  assert.match(body, /Index: ready/);
  assert.match(body, /Latest run: #7/);
  assert.match(body, /Freshness: fresh/);
  assert.doesNotMatch(body, /Log file:/);
  assert.doesNotMatch(body, /State file:/);
});

test("buildFreshnessReport surfaces state, reasons, whyItMatters, and recommended action", () => {
  const raw = makeShellEnvelope({
    freshnessState: "possibly_stale",
    freshnessSummary: "Drift detected.",
    freshnessRecommendedAction: "Re-index the repo.",
  });
  raw.result.indexState.freshness.reasons = [
    { code: "source_file_count_changed", count: 3, message: "3 new source files" },
  ];
  raw.result.indexState.freshness.whyItMatters = "Vtrace answers may be outdated.";
  const snapshot = buildRepoSnapshot(raw);
  const body = buildFreshnessReport(snapshot);

  assert.match(body, /State: possibly_stale/);
  assert.match(body, /Summary: Drift detected\./);
  assert.match(body, /3 new source files \(3\)/);
  assert.match(body, /Why this matters: Vtrace answers may be outdated\./);
  assert.match(body, /Recommended action: Re-index the repo\./);
  assert.doesNotMatch(body, /Runtime|executable|agent config/i);
});

test("buildRuntimeReport surfaces runtime state, paths, and stale-state warning; no Doctor dump", () => {
  const raw = makeShellEnvelope();
  raw.result.runtime.statePath = "/repo/.vtrace/runtime.state";
  raw.result.runtime.logPath = "/repo/.vtrace/runtime.log";
  raw.result.runtime.staleStatePresent = true;
  const snapshot = buildRepoSnapshot(raw);
  const body = buildRuntimeReport(snapshot);

  assert.match(body, /State: not running/);
  assert.match(body, /State file: \/repo\/\.vtrace\/runtime\.state/);
  assert.match(body, /Log file: \/repo\/\.vtrace\/runtime\.log/);
  assert.match(body, /Stale state file detected/);
  assert.match(body, /Recommended action:/);
  assert.doesNotMatch(body, /Freshness|Index readiness|agent config/i);
});

test("buildSetupConfigReport lists initialized state, agent entries, and setup recommendation", () => {
  const raw = makeShellEnvelope({
    agentMatchesExpected: false,
    agentConfigPath: "/home/test/.claude.json",
    agentDisplayName: "Claude Code",
  });
  const snapshot = buildRepoSnapshot(raw);
  const body = buildSetupConfigReport(snapshot);

  assert.match(body, /^# Setup \/ Config/m);
  assert.match(body, /Initialized: yes/);
  assert.match(body, /Selected agent: claude-code/);
  assert.match(body, /Claude Code \(claude-code\): installed but drifted/);
  assert.match(body, /config file: \/home\/test\/\.claude\.json/);
  assert.match(body, /Recommended action: Run Setup Agent/);
});

test("buildExecutableResolutionReport surfaces path, source, attempted order, and next step", () => {
  const body = buildExecutableResolutionReport({
    command: "/ext/bin/vtrace",
    source: EXECUTABLE_SOURCES.Bundled,
    attempted: [
      { source: EXECUTABLE_SOURCES.Bundled, path: "/ext/bin/vtrace" },
      { source: EXECUTABLE_SOURCES.Path, path: "vtrace" },
    ],
  });

  assert.match(body, /^# Executable Resolution/m);
  assert.match(body, /Resolved path: \/ext\/bin\/vtrace/);
  assert.match(body, /Source: Bundled launcher \(bundled\)/);
  assert.match(body, /Resolution order tried:/);
  assert.match(body, /Bundled launcher: \/ext\/bin\/vtrace/);
  assert.match(body, /Resolved from PATH: vtrace/);
  assert.match(body, /set `vtrace\.cliPath`/);
});

test("buildExecutableResolutionReport falls back cleanly when no executable info is present", () => {
  const body = buildExecutableResolutionReport(null, "vtrace CLI was not found.");

  assert.match(body, /No vtrace executable resolution has been recorded yet\./);
  assert.match(body, /vtrace CLI was not found\./);
  assert.match(body, /Next step: set `vtrace\.cliPath`/);
});

test("EDITOR_EMPTY_STATE_MESSAGES match the spec verbatim for file skeleton and impact graph", () => {
  assert.equal(EDITOR_EMPTY_STATE_MESSAGES.FileSkeleton.NoWorkspace, "Open a folder or workspace to use vtrace file commands.");
  assert.equal(EDITOR_EMPTY_STATE_MESSAGES.FileSkeleton.NoActiveEditor, "Open a file in the workspace to show its skeleton.");
  assert.equal(EDITOR_EMPTY_STATE_MESSAGES.FileSkeleton.OutsideWorkspace, "The active file is not inside the current workspace. Open a workspace file to use vtrace file skeletons.");
  assert.equal(EDITOR_EMPTY_STATE_MESSAGES.FileSkeleton.UnsupportedFile, "The active file is not a supported indexed source file for vtrace skeleton output.");
  assert.equal(EDITOR_EMPTY_STATE_MESSAGES.FileSkeleton.NotInitialized, "This repo is not initialized for vtrace yet. Run Setup Agent first.");
  assert.equal(EDITOR_EMPTY_STATE_MESSAGES.FileSkeleton.IndexNotReady, "The vtrace index is not ready yet. Finish setup or indexing, then try again.");

  assert.equal(EDITOR_EMPTY_STATE_MESSAGES.ImpactGraph.NoWorkspace, "Open a folder or workspace to use vtrace symbol commands.");
  assert.equal(EDITOR_EMPTY_STATE_MESSAGES.ImpactGraph.NoActiveEditor, "Open a workspace file and place the cursor on a symbol to show its impact graph.");
  assert.equal(EDITOR_EMPTY_STATE_MESSAGES.ImpactGraph.NoSymbolAtCursor, "Place the cursor on a symbol to show its impact graph.");
  assert.equal(EDITOR_EMPTY_STATE_MESSAGES.ImpactGraph.SymbolNotResolved, "Vtrace could not resolve the symbol at the cursor to an exact indexed symbol.");
  assert.equal(EDITOR_EMPTY_STATE_MESSAGES.ImpactGraph.NotInitialized, "This repo is not initialized for vtrace yet. Run Setup Agent first.");
  assert.equal(EDITOR_EMPTY_STATE_MESSAGES.ImpactGraph.IndexNotReady, "The vtrace index is not ready yet. Finish setup or indexing, then try again.");
});

test("findSymbolAtLine chooses the narrowest indexed symbol covering the cursor", () => {
  const symbol = findSymbolAtLine([
    {
      fqName: "src/app.ts::App",
      startLine: 1,
      endLine: 20,
    },
    {
      fqName: "src/app.ts::App.render",
      startLine: 7,
      endLine: 12,
    },
  ], 8);

  assert.equal(symbol?.fqName, "src/app.ts::App.render");
});

function sectionByIdOrThrow(sections: Array<{ id: string; label: string; children: unknown[] }>, id: string) {
  const section = sections.find((candidate) => candidate.id === id);
  if (section === undefined) {
    throw new Error(`Section ${id} missing`);
  }
  return section as { id: string; label: string; children: Array<{ label: string; description?: string; tooltip?: string; icon?: string; command?: string }> };
}

function indexByLabel(rows: Array<{ label: string; description?: string; tooltip?: string; icon?: string; command?: string }>) {
  const byLabel: Record<string, { label: string; description?: string; tooltip?: string; icon?: string; command?: string }> = {};
  for (const row of rows) {
    byLabel[row.label] = row;
  }
  return byLabel;
}

function makeShellEnvelope(overrides: {
  command?: string;
  selectedAgent?: string;
  initialized?: boolean;
  readiness?: { status: string; summary: string; checks: unknown[] } | null;
  latestRunId?: number | null;
  freshnessState?: string;
  freshnessSummary?: string;
  freshnessRecommendedAction?: string | null;
  runtimeRunning?: boolean;
  runtimeStatus?: string;
  agentInstalled?: boolean;
  agentMatchesExpected?: boolean;
  agentConfigPath?: string;
  agentDisplayName?: string;
} = {}) {
  return {
    ok: true,
    command: overrides.command ?? "status",
    repoRoot: "/repo",
    timestampMs: 1,
    warnings: [],
    nextSteps: ["Run `vtrace setup /repo` to initialize and index the repo."],
    error: null,
    result: {
      selectedAgent: overrides.selectedAgent ?? "claude-code",
      repoState: {
        initialized: overrides.initialized ?? true,
      },
      indexState: {
        latestRunId: overrides.latestRunId !== undefined ? overrides.latestRunId : 7,
        freshness: {
          state: overrides.freshnessState ?? "fresh",
          summary: overrides.freshnessSummary ?? "The current repo appears consistent with the last indexed snapshot.",
          recommendedAction: overrides.freshnessRecommendedAction ?? null,
        },
        readiness: overrides.readiness === undefined
          ? { status: "ready", summary: "Ready", checks: [] }
          : overrides.readiness,
      },
      agentConfig: {
        installed: overrides.agentInstalled ?? true,
        matchesExpected: overrides.agentMatchesExpected ?? true,
        configPath: overrides.agentConfigPath ?? "/home/test/.claude.json",
        displayName: overrides.agentDisplayName ?? "Claude Code",
      },
      runtime: {
        running: overrides.runtimeRunning ?? false,
        status: overrides.runtimeStatus ?? "not_running",
      },
    },
  };
}
