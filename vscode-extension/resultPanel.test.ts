import assert from "node:assert/strict";
import { test } from "bun:test";

import { EXECUTABLE_SOURCES } from "./cli.js";
import { buildRepoSnapshot } from "./shell.js";
import {
  RESULT_TYPES,
  ResultPanelController,
  buildHtml,
  buildResultView,
  renderContextCapsuleBody,
  renderDoctorBody,
  renderExecutableResolutionBody,
  renderExpandedVexpRefContent,
  renderFileSkeletonBody,
  renderFreshnessBody,
  renderImpactGraphBody,
  renderIndexStatusBody,
  renderRunPipelineBody,
  renderRuntimeBody,
  renderSetupConfigBody,
} from "./resultPanel.js";

test("buildResultView picks title and body per result type", () => {
  const snapshot = buildRepoSnapshot(makeShellEnvelope());
  const view = buildResultView({ type: RESULT_TYPES.IndexStatus, repoRoot: "/repo", snapshot });

  assert.equal(view.type, RESULT_TYPES.IndexStatus);
  assert.equal(view.title, "vtrace — Index Status");
  assert.equal(view.repoRoot, "/repo");
  assert.match(view.body, /Summary/);
});

test("buildResultView embeds file path in File Skeleton title and symbol in Impact Graph title", () => {
  const skeleton = { detail: "standard", files: [makeSkeletonFile()] };
  const skeletonView = buildResultView({
    type: RESULT_TYPES.FileSkeleton,
    repoRoot: "/repo",
    skeleton,
    filePath: "src/app.ts",
  });
  assert.equal(skeletonView.title, "vtrace — File Skeleton: src/app.ts");

  const impactView = buildResultView({
    type: RESULT_TYPES.ImpactGraph,
    repoRoot: "/repo",
    impact: makeImpactOutput(),
    symbolFqn: "src/app.ts::App",
  });
  assert.equal(impactView.title, "vtrace — Impact Graph: src/app.ts::App");
});

test("buildHtml embeds the title, repo line, body, and raw JSON toggle when rawData is provided", () => {
  const view = buildResultView({
    type: RESULT_TYPES.IndexStatus,
    repoRoot: "/repo",
    snapshot: buildRepoSnapshot(makeShellEnvelope()),
    rawData: { ok: true, command: "status" },
  });
  const html = buildHtml(view);

  assert.match(html, /data-result-type="index_status"/);
  assert.match(html, /data-testid="result-title">vtrace — Index Status/);
  assert.match(html, /data-testid="repo-root">Repo: \/repo/);
  // Show raw JSON toggle + Copy JSON button are present but raw pre stays hidden by default
  assert.match(html, /id="toggle-raw"[^>]*aria-expanded="false"/);
  assert.match(html, /id="copy-raw"/);
  assert.match(html, /id="raw-json" hidden/);
  assert.match(html, /&quot;command&quot;: &quot;status&quot;/);
});

test("renderFileSkeletonBody happy path + buildHtml expose raw JSON affordance without making JSON the default surface", () => {
  const skeleton = { detail: "standard", files: [makeSkeletonFile()] };
  const view = buildResultView({
    type: RESULT_TYPES.FileSkeleton,
    repoRoot: "/repo",
    skeleton,
    filePath: "src/app.ts",
    rawData: skeleton,
  });
  const html = buildHtml(view);

  // The human-readable header/summary strip render above the toggle
  const headerIdx = html.indexOf("header-block");
  const summaryIdx = html.indexOf("summary-strip");
  const toggleIdx = html.indexOf("id=\"toggle-raw\"");
  assert.ok(headerIdx !== -1 && summaryIdx !== -1 && toggleIdx !== -1);
  assert.ok(headerIdx < toggleIdx, "header block should render above raw toggle");
  assert.ok(summaryIdx < toggleIdx, "summary strip should render above raw toggle");

  // Raw section is present but the <pre> is hidden by default
  assert.match(html, /id="raw-json" hidden/);
  assert.match(html, /id="copy-raw"/);
});

test("renderImpactGraphBody happy path + buildHtml expose raw JSON affordance without making JSON the default surface", () => {
  const view = buildResultView({
    type: RESULT_TYPES.ImpactGraph,
    repoRoot: "/repo",
    impact: makeImpactOutput(),
    symbolFqn: "src/app.ts::App",
    rawData: makeImpactOutput(),
  });
  const html = buildHtml(view);

  const topDependentsIdx = html.indexOf("Top dependents");
  const toggleIdx = html.indexOf("id=\"toggle-raw\"");
  assert.ok(topDependentsIdx !== -1 && toggleIdx !== -1);
  assert.ok(topDependentsIdx < toggleIdx, "top dependents should render above raw toggle");

  assert.match(html, /id="raw-json" hidden/);
  assert.match(html, /id="copy-raw"/);
});

test("buildHtml omits the raw-JSON toggle when no raw data is attached", () => {
  const view = buildResultView({
    type: RESULT_TYPES.IndexStatus,
    repoRoot: "/repo",
    snapshot: buildRepoSnapshot(makeShellEnvelope()),
  });
  const html = buildHtml(view);

  assert.doesNotMatch(html, /id="toggle-raw"/);
  assert.doesNotMatch(html, /id="raw-json"/);
});

test("renderIndexStatusBody shows setup/index/run/freshness/watcher key-value pairs", () => {
  const snapshot = buildRepoSnapshot(makeShellEnvelope({
    watcher: {
      supported: true,
      enabled: true,
      running: true,
      lastEventAtMs: 10,
      autoReindexEnabled: true,
      reindexState: "reindex_failed",
      lastAutoReindexStartedAtMs: 11,
      lastAutoReindexFinishedAtMs: 12,
      lastAutoReindexFailedAtMs: 13,
      lastAutoReindexError: "index failed: disk full",
      pendingChangedFileCount: 2,
      changedFiles: ["src/a.ts", "src/b.ts"],
    },
  }));
  const body = renderIndexStatusBody(snapshot);

  assert.match(body, /<dt>Repo root<\/dt><dd>\/repo<\/dd>/);
  assert.match(body, /<dt>Setup<\/dt><dd>initialized<\/dd>/);
  assert.match(body, /<dt>Index<\/dt><dd>ready<\/dd>/);
  assert.match(body, /<dt>Latest run<\/dt><dd>#7<\/dd>/);
  assert.match(body, /<dt>Freshness<\/dt><dd>fresh<\/dd>/);
  assert.match(body, /<dt>Changed files<\/dt><dd>2<\/dd>/);
  assert.match(body, /<dt>Runtime<\/dt><dd>not running<\/dd>/);
  assert.match(body, /<h2>Watcher<\/h2>/);
  assert.match(body, /<dt>Status<\/dt><dd>running<\/dd>/);
  assert.match(body, /<dt>Auto re-index<\/dt><dd>enabled<\/dd>/);
  assert.match(body, /<dt>Re-index state<\/dt><dd>reindex_failed<\/dd>/);
  assert.match(body, /Auto re-index error/);
  assert.match(body, /Recommended action: run <code>vtrace index<\/code> explicitly/);
  assert.match(body, /src\/a\.ts/);
  assert.match(body, /src\/b\.ts/);
});

test("renderIndexStatusBody shows immediate setup/reindex running state", () => {
  const snapshot = buildRepoSnapshot(makeShellEnvelope());
  const body = renderIndexStatusBody(snapshot, "running_reindex");

  assert.match(body, /<dt>Current action<\/dt><dd>Re-indexing…<\/dd>/);
});

test("renderFreshnessBody includes reasons, why-it-matters, and recommendation sections", () => {
  const envelope = makeShellEnvelope({
    freshnessState: "possibly_stale",
    freshnessSummary: "Drift detected.",
    freshnessRecommendedAction: "Re-index the repo.",
  });
  envelope.result.indexState.freshness.reasons = [
    { code: "source_file_count_changed", count: 3, message: "3 new source files" },
  ];
  envelope.result.indexState.freshness.observedFileChanges = {
    count: 2,
    changedFiles: ["src/changed.ts", "src/other.ts"],
  };
  envelope.result.indexState.freshness.whyItMatters = "vtrace answers may be outdated.";
  envelope.result.watcher = {
    supported: true,
    enabled: true,
    running: false,
    lastEventAtMs: 20,
    autoReindexEnabled: false,
    reindexState: "pending_changes",
    lastAutoReindexStartedAtMs: null,
    lastAutoReindexFinishedAtMs: null,
    lastAutoReindexFailedAtMs: null,
    lastAutoReindexError: null,
    pendingChangedFileCount: 2,
    changedFiles: ["src/changed.ts", "src/other.ts"],
  };
  const snapshot = buildRepoSnapshot(envelope);
  const body = renderFreshnessBody(snapshot);

  assert.match(body, /possibly stale/);
  assert.match(body, /<dt>Changed files<\/dt><dd>2<\/dd>/);
  assert.match(body, /src\/changed\.ts/);
  assert.match(body, /<dt>Auto re-index<\/dt><dd>disabled<\/dd>/);
  assert.match(body, /3 new source files/);
  assert.match(body, /vtrace answers may be outdated/);
  assert.match(body, /Re-index the repo\./);
});

test("renderRuntimeBody renders state, state file, log file, and stale-state warning", () => {
  const envelope = makeShellEnvelope();
  envelope.result.runtime.statePath = "/repo/.vtrace/runtime.state";
  envelope.result.runtime.logPath = "/repo/.vtrace/runtime.log";
  envelope.result.runtime.staleStatePresent = true;
  const snapshot = buildRepoSnapshot(envelope);
  const body = renderRuntimeBody(snapshot);

  assert.match(body, /not running/);
  assert.match(body, /\/repo\/\.vtrace\/runtime\.state/);
  assert.match(body, /\/repo\/\.vtrace\/runtime\.log/);
  assert.match(body, /present \(cleanup recommended\)/);
});

test("renderSetupConfigBody lists each agent as a card with config state", () => {
  const snapshot = buildRepoSnapshot(makeShellEnvelope({
    agentMatchesExpected: false,
    agentDisplayName: "Claude Code",
    agentConfigPath: "/home/test/.claude.json",
  }));
  const body = renderSetupConfigBody(snapshot);

  assert.match(body, /Claude Code/);
  assert.match(body, /installed but drifted/);
  assert.match(body, /\/home\/test\/\.claude\.json/);
  assert.match(body, /Recommended action:|Run Setup Agent/);
});

test("renderExecutableResolutionBody lists resolved path, source, and attempted paths", () => {
  const body = renderExecutableResolutionBody({
    command: "/ext/bin/vtrace",
    source: "bundled",
    attempted: [
      { source: "bundled", path: "/ext/bin/vtrace" },
      { source: "path", path: "vtrace" },
    ],
  });

  assert.match(body, /Resolved path/);
  assert.match(body, /\/ext\/bin\/vtrace/);
  assert.match(body, /Bundled launcher/);
  assert.match(body, /Resolved from PATH: vtrace/);
});

test("renderExecutableResolutionBody degrades gracefully with no executable info", () => {
  const body = renderExecutableResolutionBody(null, "vtrace CLI was not found.");

  assert.match(body, /No vtrace executable resolution has been recorded yet\./);
  assert.match(body, /vtrace CLI was not found\./);
});

test("renderDoctorBody shows summary rows and bullets for warnings + next steps", () => {
  const snapshot = buildRepoSnapshot(makeShellEnvelope({
    freshnessState: "possibly_stale",
    freshnessRecommendedAction: "Re-index the repo.",
  }));
  snapshot.warnings = ["Warning one", "Warning two"];
  snapshot.nextSteps = ["Step one", "Step two"];

  const body = renderDoctorBody(snapshot);

  assert.match(body, /Repo state/);
  assert.match(body, /<li>Warning one<\/li>/);
  assert.match(body, /<li>Step one<\/li>/);
});

test("renderFileSkeletonBody renders header, summary strip, and labeled sections — no JSON blob", () => {
  const skeleton = { detail: "standard", files: [makeSkeletonFile()] };
  const body = renderFileSkeletonBody(skeleton, "src/app.ts");

  // Header block (File / Language / Status: ok)
  assert.match(body, /<dl class="header-block"[^>]*>/);
  assert.match(body, /<dt>File<\/dt><dd>src\/app\.ts<\/dd>/);
  assert.match(body, /<dt>Language<\/dt><dd>typescript<\/dd>/);
  assert.match(body, /<dt>Status<\/dt><dd>ok<\/dd>/);

  // Summary strip with four counts including Members
  assert.match(body, /<div class="summary-strip"[^>]*>/);
  assert.match(body, /Imports:<\/span>1/);
  assert.match(body, /Exports:<\/span>1/);
  assert.match(body, /Declarations:<\/span>1/);
  assert.match(body, /Members:<\/span>1/);

  // Sections
  assert.match(body, /<h2>Imports<\/h2>/);
  assert.match(body, /<h2>Exports<\/h2>/);
  assert.match(body, /<h2>Top-level declarations<\/h2>/);

  // Declaration card details
  assert.match(body, /<strong>App<\/strong>/);
  assert.match(body, /exported/);
  assert.match(body, /Lines 10–40/);

  // Members appear nested under the declaration (subsection) — never as a top-level section
  assert.match(body, /<div class="members-subsection">/);
  assert.match(body, /members-label">Members \(1\)/);
  assert.doesNotMatch(body, /<h2>Members<\/h2>/);
  assert.match(body, /render\(\): void/);

  // Notes line
  assert.match(body, /This skeleton excludes implementation bodies\./);

  // No JSON blob
  assert.doesNotMatch(body, /"filePath":\s*"src\/app\.ts"/);
});

test("renderFileSkeletonBody hides Imports and Exports sections when both are empty", () => {
  const body = renderFileSkeletonBody({
    detail: "standard",
    files: [{
      status: "ok",
      filePath: "src/app.ts",
      language: "typescript",
      message: null,
      imports: [],
      exports: [],
      declarations: [
        {
          kind: "function",
          name: "doThing",
          exported: false,
          signature: "function doThing()",
          startLine: 5,
          endLine: 8,
          docstring: null,
          decorators: [],
          members: [],
        },
      ],
    }],
  }, "src/app.ts");

  assert.doesNotMatch(body, /<h2>Imports<\/h2>/);
  assert.doesNotMatch(body, /<h2>Exports<\/h2>/);
  assert.match(body, /<h2>Top-level declarations<\/h2>/);
  // summary strip still reports zero counts
  assert.match(body, /Imports:<\/span>0/);
  assert.match(body, /Exports:<\/span>0/);
});

test("renderFileSkeletonBody file_not_found empty state matches the spec copy", () => {
  const body = renderFileSkeletonBody({
    detail: "standard",
    files: [{
      status: "file_not_found",
      filePath: "src/missing.ts",
      language: null,
      message: null,
      imports: [], exports: [], declarations: [],
    }],
  }, "src/missing.ts");

  assert.match(body, /<h2>File Skeleton<\/h2>/);
  assert.match(body, /The requested file was not found\./);
  assert.match(body, /<dt>File<\/dt><dd>src\/missing\.ts<\/dd>/);
  assert.match(body, /<dt>Status<\/dt><dd>file_not_found<\/dd>/);
  // Empty states do not render the summary strip or notes block
  assert.doesNotMatch(body, /summary-strip/);
  assert.doesNotMatch(body, /<h2>Top-level declarations<\/h2>/);
});

test("renderFileSkeletonBody not_indexed empty state matches the spec copy", () => {
  const body = renderFileSkeletonBody({
    detail: "standard",
    files: [{
      status: "not_indexed",
      filePath: "src/not_indexed.ts",
      language: null,
      message: null,
      imports: [], exports: [], declarations: [],
    }],
  }, "src/not_indexed.ts");

  assert.match(body, /This file is present but not indexed for skeleton output\./);
  assert.match(body, /<dt>File<\/dt><dd>src\/not_indexed\.ts<\/dd>/);
  assert.match(body, /<dt>Status<\/dt><dd>not_indexed<\/dd>/);
});

test("renderFileSkeletonBody no-declarations empty state renders spec text with language", () => {
  const body = renderFileSkeletonBody({
    detail: "standard",
    files: [{
      status: "ok",
      filePath: "src/empty.ts",
      language: "typescript",
      message: null,
      imports: [], exports: [], declarations: [],
    }],
  }, "src/empty.ts");

  assert.match(body, /No indexed declarations were found in this file\./);
  assert.match(body, /<dt>File<\/dt><dd>src\/empty\.ts<\/dd>/);
  assert.match(body, /<dt>Language<\/dt><dd>typescript<\/dd>/);
  assert.match(body, /<dt>Status<\/dt><dd>ok<\/dd>/);
  assert.doesNotMatch(body, /summary-strip/);
});

test("renderImpactGraphBody renders header, summary strip, top dependents, and coverage — no JSON blob", () => {
  const body = renderImpactGraphBody(makeImpactOutput(), "src/app.ts::App");

  // Header block: Symbol / Kind / File / Resolution
  assert.match(body, /<dl class="header-block"[^>]*>/);
  assert.match(body, /<dt>Symbol<\/dt><dd>src\/app\.ts::App<\/dd>/);
  assert.match(body, /<dt>Kind<\/dt><dd>class<\/dd>/);
  assert.match(body, /<dt>File<\/dt><dd>src\/app\.ts<\/dd>/);
  assert.match(body, /<dt>Resolution<\/dt><dd>exact_fqn<\/dd>/);

  // Summary strip: four metric fields
  assert.match(body, /<div class="summary-strip"[^>]*>/);
  assert.match(body, /Dependent symbols:<\/span>2/);
  assert.match(body, /Dependent files:<\/span>2/);
  assert.match(body, /Max depth:<\/span>2/);
  assert.match(body, /Max observed distance:<\/span>2/);

  // Top dependents: fqName · kind · file · distance
  assert.match(body, /<h2>Top dependents<\/h2>/);
  assert.match(body, /src\/routes\.ts::Router/);
  assert.match(body, /· class · src\/routes\.ts · distance 1/);

  // Coverage with supported/observed edge types and cross-repo
  assert.match(body, /<h2>Coverage<\/h2>/);
  assert.match(body, /<dt>Analysis kind<\/dt><dd>structural<\/dd>/);
  assert.match(body, /<dt>Supported edge types<\/dt><dd>contains, imports<\/dd>/);
  assert.match(body, /<dt>Observed edge types<\/dt><dd>imports<\/dd>/);
  assert.match(body, /<dt>Cross-repo<\/dt><dd>false<\/dd>/);

  // Edge summary + explanation sentence
  assert.match(body, /<h2>Edge summary<\/h2>/);
  assert.match(body, /Total edges/);
  assert.match(body, /Top dependents are derived from bounded reverse structural traversal\./);

  // Dependent files rendered when small
  assert.match(body, /<h2>Dependent files<\/h2>/);
  assert.match(body, /src\/routes\.ts/);
  assert.match(body, /src\/entry\.ts/);

  // No JSON blob
  assert.doesNotMatch(body, /"symbolId":/);
});

test("renderImpactGraphBody header block includes Analysis kind alongside Resolution", () => {
  const body = renderImpactGraphBody(makeImpactOutput(), "src/app.ts::App");

  // Per spec § Header block: both Resolution mode AND Analysis kind appear in the header.
  const headerBlock = body.match(/<dl class="header-block"[^>]*>[\s\S]*?<\/dl>/u)?.[0] ?? "";
  assert.match(headerBlock, /<dt>Resolution<\/dt><dd>exact_fqn<\/dd>/);
  assert.match(headerBlock, /<dt>Analysis kind<\/dt><dd>structural<\/dd>/);
});

test("renderImpactGraphBody Notes section emits honest structural-only prose", () => {
  const body = renderImpactGraphBody(makeImpactOutput(), "src/app.ts::App");

  // Notes section exists and carries conservative-coverage prose for structural analysis.
  assert.match(body, /<h2>Notes<\/h2>/);
  assert.match(body, /Coverage is conservative: results reflect static structural evidence/);
  // contains-edge was supported but not observed — renderer flags the gap honestly
  assert.match(body, /No contains edges were observed for this symbol/);
  // The interpretation line lives in Notes now, not Edge summary
  const notesMatch = body.match(/<h2>Notes<\/h2>[\s\S]*?<\/section>/u)?.[0] ?? "";
  assert.match(notesMatch, /Top dependents are derived from bounded reverse structural traversal\./);
  const edgeSummaryMatch = body.match(/<h2>Edge summary<\/h2>[\s\S]*?<\/section>/u)?.[0] ?? "";
  assert.doesNotMatch(edgeSummaryMatch, /Top dependents are derived/);
});

test("renderImpactGraphBody omits dependent-files section when the list is larger than the compact threshold", () => {
  const base = makeImpactOutput();
  const many = Array.from({ length: 20 }, (_, index) => `src/file${index}.ts`);
  const body = renderImpactGraphBody(
    { ...base, dependentFiles: many, summary: { ...base.summary, dependentFileCount: many.length } },
    "src/app.ts::App",
  );

  assert.doesNotMatch(body, /<h2>Dependent files<\/h2>/);
});

test("renderImpactGraphBody unknown-symbol error matches the spec empty state", () => {
  const body = renderImpactGraphBody({
    ok: false,
    error: { code: "unknown_symbol", message: "No matches found.", details: {} },
  }, "src/missing.ts::Ghost");

  assert.match(body, /<h2>Impact Graph<\/h2>/);
  assert.match(body, /The symbol could not be resolved exactly\./);
  assert.match(body, /<dt>Requested symbol<\/dt><dd>src\/missing\.ts::Ghost<\/dd>/);
  assert.match(body, /<dt>Resolution mode<\/dt><dd>exact_fqn<\/dd>/);
  assert.doesNotMatch(body, /summary-strip/);
});

test("renderImpactGraphBody ambiguous-symbol error falls back to the 'could not be resolved exactly' copy", () => {
  const body = renderImpactGraphBody({
    ok: false,
    error: { code: "ambiguous_symbol", message: "3 matches", details: {} },
  }, "Router");

  assert.match(body, /The symbol could not be resolved exactly\./);
  assert.match(body, /<dt>Requested symbol<\/dt><dd>Router<\/dd>/);
});

test("renderImpactGraphBody cross-repo request renders the dedicated unsupported state", () => {
  const base = makeImpactOutput();
  const body = renderImpactGraphBody(
    { ...base, requested: { ...base.requested, crossRepo: true, symbolFqn: "remote::Thing" } },
    "remote::Thing",
  );

  assert.match(body, /Cross-repo impact analysis is not supported in this workspace\./);
  assert.match(body, /<dt>Requested symbol<\/dt><dd>remote::Thing<\/dd>/);
  assert.match(body, /<dt>Cross-repo<\/dt><dd>true<\/dd>/);
});

test("renderImpactGraphBody renders the no-dependents state when summary counts are zero", () => {
  const base = makeImpactOutput();
  const body = renderImpactGraphBody({
    ...base,
    summary: { dependentSymbolCount: 0, dependentFileCount: 0, maxDepth: 0, maxObservedDistance: 0 },
    nodes: [base.nodes[0]],
    dependentFiles: [],
  }, "src/app.ts::App");

  assert.match(body, /No dependents were found for this symbol in the indexed structural graph\./);
  assert.match(body, /<dt>Symbol<\/dt><dd>src\/app\.ts::App<\/dd>/);
  assert.match(body, /<dt>Dependent symbols<\/dt><dd>0<\/dd>/);
  assert.match(body, /<dt>Dependent files<\/dt><dd>0<\/dd>/);
  assert.doesNotMatch(body, /<h2>Top dependents<\/h2>/);
});

test("renderContextCapsuleBody shows query, budget usage, pivots, and supporting items as cards", () => {
  const body = renderContextCapsuleBody({
    query: "trace auth flow",
    intent: "trace",
    routingProfile: { id: "profile-a" },
    capsuleProfile: { id: "capsule-a" },
    capsule: {
      query: "trace auth flow",
      pivots: [{ role: "pivot", symbol: { fqName: "src/auth.ts::login" }, inclusionReasons: [{ kind: "lexical_match" }] }],
      supportingItems: [{ role: "support", symbol: { fqName: "src/session.ts::createSession" }, inclusionReasons: [] }],
      budget: { usedCharacters: 1234, maxCharacters: 5000 },
      truncated: false,
    },
  });

  assert.match(body, /trace auth flow/);
  assert.match(body, /1234 \/ 5000 chars/);
  assert.match(body, /src\/auth\.ts::login/);
  assert.match(body, /src\/session\.ts::createSession/);
  assert.match(body, /lexical_match/);
});

test("ResultPanelController creates a webview on first show and reuses it on later shows", () => {
  const harness = makePanelHarness();
  const controller = new ResultPanelController(harness.vscode);

  const snapshot = buildRepoSnapshot(makeShellEnvelope());
  controller.showResult({ type: RESULT_TYPES.IndexStatus, repoRoot: "/repo", snapshot });
  controller.showResult({ type: RESULT_TYPES.Freshness, repoRoot: "/repo", snapshot });

  assert.equal(harness.created.length, 1, "panel should be reused across results");
  const panel = harness.created[0];
  assert.equal(panel?.title, "vtrace — Freshness");
  assert.match(panel?.webview.html ?? "", /data-result-type="freshness"/);
  assert.equal(panel?.revealCount ?? 0, 2);
});

test("ResultPanelController updates the title on each show", () => {
  const harness = makePanelHarness();
  const controller = new ResultPanelController(harness.vscode);
  const snapshot = buildRepoSnapshot(makeShellEnvelope());

  controller.showResult({ type: RESULT_TYPES.IndexStatus, repoRoot: "/repo", snapshot });
  assert.equal(harness.created[0]?.title, "vtrace — Index Status");
  controller.showResult({
    type: RESULT_TYPES.FileSkeleton,
    repoRoot: "/repo",
    skeleton: { detail: "standard", files: [makeSkeletonFile()] },
    filePath: "src/app.ts",
  });
  assert.equal(harness.created[0]?.title, "vtrace — File Skeleton: src/app.ts");
});

test("ResultPanelController recreates the panel after disposal", () => {
  const harness = makePanelHarness();
  const controller = new ResultPanelController(harness.vscode);
  const snapshot = buildRepoSnapshot(makeShellEnvelope());

  controller.showResult({ type: RESULT_TYPES.IndexStatus, repoRoot: "/repo", snapshot });
  harness.created[0]?.simulateDispose();
  controller.showResult({ type: RESULT_TYPES.IndexStatus, repoRoot: "/repo", snapshot });

  assert.equal(harness.created.length, 2);
});

test("ResultPanelController embeds raw JSON in the webview HTML when rawData is attached", () => {
  const harness = makePanelHarness();
  const controller = new ResultPanelController(harness.vscode);
  const snapshot = buildRepoSnapshot(makeShellEnvelope());

  controller.showResult({
    type: RESULT_TYPES.IndexStatus,
    repoRoot: "/repo",
    snapshot,
    rawData: { ok: true, command: "status" },
  });

  const html = harness.created[0]?.webview.html ?? "";
  assert.match(html, /id="toggle-raw"/);
  assert.match(html, /&quot;command&quot;: &quot;status&quot;/);
  assert.match(html, /id="raw-json" hidden/);
});

function makePanelHarness() {
  const created: Array<{
    title: string;
    webview: {
      html: string;
      postMessage(message: unknown): Promise<boolean>;
      onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void };
    };
    revealCount: number;
    disposed: boolean;
    postedMessages: Array<Record<string, unknown>>;
    simulateDispose(): void;
    simulateMessage(message: unknown): Promise<void>;
  }> = [];
  const disposeListeners = new Map<number, () => void>();
  const messageListeners = new Map<number, (message: unknown) => void>();
  const vscode = {
    ViewColumn: { Active: 1 },
    window: {
      createWebviewPanel(_viewType: string, title: string) {
        const index = created.length;
        const postedMessages: Array<Record<string, unknown>> = [];
        const panel = {
          title,
          webview: {
            html: "",
            postMessage(message: unknown) {
              postedMessages.push(message as Record<string, unknown>);
              return Promise.resolve(true);
            },
            onDidReceiveMessage(listener: (message: unknown) => void) {
              messageListeners.set(index, listener);
              return { dispose() {} };
            },
          },
          revealCount: 0,
          disposed: false,
          postedMessages,
          reveal() { this.revealCount += 1; },
          onDidDispose(listener: () => void) {
            disposeListeners.set(index, listener);
            return { dispose() {} };
          },
          dispose() { this.disposed = true; },
          simulateDispose() {
            this.disposed = true;
            disposeListeners.get(index)?.();
          },
          async simulateMessage(message: unknown) {
            const listener = messageListeners.get(index);
            if (listener) {
              await Promise.resolve(listener(message));
              // Allow microtask queue to drain so async controller handlers settle.
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
          },
        };
        created.push(panel);
        return panel;
      },
    },
  };
  return { vscode, created };
}

function makeSkeletonFile() {
  return {
    status: "ok",
    filePath: "src/app.ts",
    language: "typescript",
    message: null,
    imports: [
      { fromFilePath: "node:fs/promises", name: "readFile", kind: "function" },
    ],
    exports: [
      { name: "App", kind: "class" },
    ],
    declarations: [
      {
        kind: "class",
        name: "App",
        exported: true,
        signature: "class App",
        startLine: 10,
        endLine: 40,
        docstring: null,
        decorators: [],
        members: [
          { kind: "method", name: "render", signature: "render(): void", startLine: 15, endLine: 22, docstring: null, decorators: [] },
        ],
      },
    ],
  };
}

function makeImpactOutput() {
  return {
    requested: { symbolFqn: "src/app.ts::App", depth: 2, crossRepo: false, format: "tree" },
    resolvedSymbol: {
      symbolId: "sym1",
      filePath: "src/app.ts",
      fqName: "src/app.ts::App",
      localName: "App",
      kind: "class",
    },
    coverage: {
      analysisKind: "structural",
      resolutionMode: "exact_fqn",
      crossRepo: false,
      supportedEdgeTypes: ["contains", "imports"],
      observedEdgeTypes: ["imports"],
      notes: [],
    },
    summary: {
      dependentSymbolCount: 2,
      dependentFileCount: 2,
      maxDepth: 2,
      maxObservedDistance: 2,
    },
    dependentFiles: ["src/routes.ts", "src/entry.ts"],
    nodes: [
      {
        symbolId: "sym1",
        filePath: "src/app.ts",
        fqName: "src/app.ts::App",
        localName: "App",
        kind: "class",
        distance: 0,
      },
      {
        symbolId: "sym2",
        filePath: "src/routes.ts",
        fqName: "src/routes.ts::Router",
        localName: "Router",
        kind: "class",
        distance: 1,
      },
      {
        symbolId: "sym3",
        filePath: "src/entry.ts",
        fqName: "src/entry.ts::main",
        localName: "main",
        kind: "function",
        distance: 2,
      },
    ],
    edges: [],
    view: { format: "tree", lines: [] },
  };
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
  watcher?: Record<string, unknown>;
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
      repoState: { initialized: overrides.initialized ?? true },
      indexState: {
        latestRunId: overrides.latestRunId !== undefined ? overrides.latestRunId : 7,
        freshness: {
          state: overrides.freshnessState ?? "fresh",
          summary: overrides.freshnessSummary ?? "The current repo appears consistent with the last indexed snapshot.",
          recommendedAction: overrides.freshnessRecommendedAction ?? null,
          reasons: [],
          whyItMatters: null,
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
      watcher: overrides.watcher ?? {
        supported: true,
        enabled: false,
        running: false,
        lastEventAtMs: null,
        autoReindexEnabled: false,
        reindexState: "idle",
        lastAutoReindexStartedAtMs: null,
        lastAutoReindexFinishedAtMs: null,
        lastAutoReindexFailedAtMs: null,
        lastAutoReindexError: null,
        pendingChangedFileCount: 0,
        changedFiles: [],
      },
    },
  };
}

// --- run_pipeline panel tests ---

test("renderRunPipelineBody renders the product sections in spec order with no JSON blob", () => {
  const body = renderRunPipelineBody(makeRunPipelineOutput(), "/repo");

  const sectionTitles = ["Intent", "Task Summary", "Context", "Impact", "Memory", "Rules", "Diagnostics", "Deferred"];
  const indices = sectionTitles.map((title) => body.indexOf(`<h2>${title}</h2>`));
  for (let i = 0; i < indices.length; i++) {
    assert.notEqual(indices[i], -1, `Section "${sectionTitles[i]}" missing`);
  }
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i] > indices[i - 1], `Section "${sectionTitles[i]}" must follow "${sectionTitles[i - 1]}"`);
  }

  // Header block + summary strip render the compact identifiers humans need first.
  assert.match(body, /header-block/);
  assert.match(body, /<dt>Task<\/dt>/);
  assert.match(body, /<dt>Intent<\/dt>/);
  assert.match(body, /summary-strip/);
  assert.match(body, /Pivots:<\/span>1/);
  assert.match(body, /Supports:<\/span>1/);
  assert.match(body, /Impact:<\/span>included/);
  assert.match(body, /Rules:<\/span>active 1; candidates 1/);
  assert.match(body, /Deferred:<\/span>2/);

  // Pivots first, then supports — pivots subsection must precede supports.
  const pivotsIdx = body.indexOf("Pivots</div>");
  const supportsIdx = body.indexOf("Supports</div>");
  assert.ok(pivotsIdx !== -1 && supportsIdx !== -1 && pivotsIdx < supportsIdx, "pivots must render before supports");

  // Context items render with file/symbol anchors and representation badges.
  assert.match(body, /src\/auth\.ts::login/);
  assert.match(body, /src\/auth\.ts/);
  assert.match(body, /<span class="tag">full<\/span>/);
  assert.match(body, /src\/session\.ts::createSession/);

  // Impact: focal symbol, summary counts, top dependents, trigger reason.
  assert.match(body, /<dt>Focal symbol<\/dt><dd>src\/auth\.ts::login<\/dd>/);
  assert.match(body, /<dt>Trigger<\/dt><dd>refactor_preset<\/dd>/);
  assert.match(body, /Top dependents/);
  assert.match(body, /src\/handlers\.ts::handleAuth/);

  // Memory: both session evidence and durable matches included.
  assert.match(body, /<dt>Session<\/dt><dd>session-7<\/dd>/);
  assert.match(body, /<dt>Matches<\/dt><dd>1<\/dd>/);
  assert.match(body, /reviewed authentication code/);
  assert.match(body, /memory: prior auth refactor/);

  // Rules: active injected rules and candidate previews are visually distinct.
  assert.match(body, /<h2>Rules<\/h2>/);
  assert.match(body, /Active injected rules/);
  assert.match(body, /Keep auth edits with session tests/);
  assert.match(body, /active injected rule/);
  assert.match(body, /Candidate previews/);
  assert.match(body, /Consider documenting auth migrations/);
  assert.match(body, /candidate preview/);
  assert.match(body, /Candidate rules are previews only and are not active instructions/);

  // Diagnostics: fallback applied, deferred count, omitted sections, include_tests state.
  assert.match(body, /<dt>Fallback applied<\/dt><dd>no<\/dd>/);
  assert.match(body, /<dt>Deferred items<\/dt><dd>2<\/dd>/);
  assert.match(body, /<dt>Omitted sections<\/dt><dd>0<\/dd>/);
  assert.match(body, /<dt>include_tests default<\/dt><dd>no<\/dd>/);

  // Deferred section: each entry shows category, summary, V-REF hash, expand action.
  assert.match(body, /data-testid="deferred-section"/);
  const deferredItems = body.match(/data-testid="deferred-item"/g) ?? [];
  assert.equal(deferredItems.length, 2, "renders one card per deferred item");
  assert.match(body, /data-vexp-hash="abcdef012345"/);
  assert.match(body, /data-vexp-hash="0123456789ab"/);
  assert.match(body, /<button[^>]*data-vexp-action="expand"[^>]*>Expand V-REF<\/button>/);
  assert.match(body, /V-REF expansion is exact stored-payload lookup/);
  assert.match(body, /No fuzzy or semantic reconstruction/);
  assert.match(body, /context_capsule/);
  assert.match(body, /impact_graph/);
  // Inline expansion slot is present per item but hidden by default.
  assert.match(body, /vexp-expansion[^>]*data-vexp-expansion-for="abcdef012345"[^>]*hidden/);

  // Renderer never dumps the raw JSON blob into the body.
  assert.doesNotMatch(body, /"capsuleProfileId":/);
});

test("renderRunPipelineBody clearly marks omitted impact and memory with their skip reasons", () => {
  const pipeline = makeRunPipelineOutput({
    impactIncluded: false,
    impactSkipReason: "intent_does_not_trigger",
    sessionIncluded: false,
    sessionSkipReason: "no_session_requested",
    durableIncluded: false,
    durableSkipReason: "intent_deemphasized",
  });
  const body = renderRunPipelineBody(pipeline, "/repo");

  assert.match(body, /Impact omitted[^.]*intent_does_not_trigger/);
  assert.match(body, /Session evidence skipped[^.]*no_session_requested/);
  assert.match(body, /Durable memory skipped[^.]*intent_deemphasized/);
  assert.match(body, /Impact:<\/span>omitted/);
  assert.match(body, /Memory:<\/span>omitted/);
});

test("renderRunPipelineBody handles deferred-empty case without crashing the section", () => {
  const pipeline = makeRunPipelineOutput({ deferred: [] });
  const body = renderRunPipelineBody(pipeline, "/repo");
  assert.match(body, /<h2>Deferred<\/h2>/);
  assert.match(body, /No deferred V-REFs emitted/);
});

test("buildResultView picks the run_pipeline title with the query suffix", () => {
  const view = buildResultView({
    type: RESULT_TYPES.RunPipeline,
    repoRoot: "/repo",
    pipeline: makeRunPipelineOutput(),
  });
  assert.equal(view.type, RESULT_TYPES.RunPipeline);
  assert.match(view.title, /^vtrace — Pipeline Result: trace auth flow/);
});

test("buildHtml exposes the raw JSON for run_pipeline but keeps the human-readable sections above the toggle", () => {
  const pipeline = makeRunPipelineOutput();
  const view = buildResultView({
    type: RESULT_TYPES.RunPipeline,
    repoRoot: "/repo",
    pipeline,
    rawData: pipeline,
  });
  const html = buildHtml(view);

  const intentIdx = html.indexOf("<h2>Intent</h2>");
  const deferredIdx = html.indexOf("<h2>Deferred</h2>");
  const toggleIdx = html.indexOf('id="toggle-raw"');
  assert.ok(intentIdx !== -1 && deferredIdx !== -1 && toggleIdx !== -1);
  assert.ok(intentIdx < toggleIdx, "Intent section must render above the raw JSON toggle");
  assert.ok(deferredIdx < toggleIdx, "Deferred section must render above the raw JSON toggle");

  // Raw JSON section is present but hidden by default.
  assert.match(html, /id="raw-json" hidden/);
  assert.match(html, /id="copy-raw"/);
  // The webview script wires expand-button click → postMessage.
  assert.match(html, /vsCodeApi\.postMessage\(\{ type: "expandVexpRef"/);
  // And listens for the response from the extension host.
  assert.match(html, /message\.type !== "expandedVexpRef"/);
});

test("ResultPanelController forwards expand requests to the injected handler and posts rendered html back", async () => {
  const harness = makePanelHarness();
  const expansion = {
    requestedHash: "abcdef012345",
    resolved: true,
    stableId: "vexp:capsule:test",
    category: "context_capsule",
    content: { kind: "json", value: { hello: "world" } },
    metadata: { origin: "run_pipeline" },
    createdAtMs: 1,
  };
  const calls: Array<Record<string, unknown>> = [];
  const expandVexpRef = async (request: Record<string, unknown>) => {
    calls.push(request);
    return expansion;
  };
  const controller = new ResultPanelController(harness.vscode, { expandVexpRef });

  controller.showResult({
    type: RESULT_TYPES.RunPipeline,
    repoRoot: "/repo",
    pipeline: makeRunPipelineOutput(),
  });

  const panel = harness.created[0]!;
  await panel.simulateMessage({ type: "expandVexpRef", hash: "abcdef012345", kind: "context_capsule", id: "vexp:capsule:test" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.hash, "abcdef012345");
  assert.equal(calls[0]!.repoRoot, "/repo");
  assert.equal(calls[0]!.query, "trace auth flow");

  // The controller renders the expansion to HTML and posts it back to the webview.
  assert.equal(panel.postedMessages.length, 1);
  const posted = panel.postedMessages[0]!;
  assert.equal(posted.type, "expandedVexpRef");
  assert.equal(posted.hash, "abcdef012345");
  assert.match(String(posted.html), /vexp:capsule:test/);
  assert.match(String(posted.html), /context_capsule/);
  assert.match(String(posted.html), /&quot;hello&quot;: &quot;world&quot;/);
});

test("ResultPanelController renders an inline error when the V-REF cannot be resolved", async () => {
  const harness = makePanelHarness();
  const expandVexpRef = async () => ({
    requestedHash: "deadbeef0123",
    resolved: false,
    reason: "expired",
    message: "The deferred V-REF was previously known but is no longer available.",
  });
  const controller = new ResultPanelController(harness.vscode, { expandVexpRef });

  controller.showResult({
    type: RESULT_TYPES.RunPipeline,
    repoRoot: "/repo",
    pipeline: makeRunPipelineOutput(),
  });

  const panel = harness.created[0]!;
  await panel.simulateMessage({ type: "expandVexpRef", hash: "deadbeef0123" });

  assert.equal(panel.postedMessages.length, 1);
  const posted = panel.postedMessages[0]!;
  assert.match(String(posted.html), /Could not expand V-REF/);
  assert.match(String(posted.html), /expired/);
});

test("ResultPanelController returns an unsupported_category response when no handler is wired (no backend duplication)", async () => {
  const harness = makePanelHarness();
  const controller = new ResultPanelController(harness.vscode); // no expandVexpRef

  controller.showResult({
    type: RESULT_TYPES.RunPipeline,
    repoRoot: "/repo",
    pipeline: makeRunPipelineOutput(),
  });

  const panel = harness.created[0]!;
  await panel.simulateMessage({ type: "expandVexpRef", hash: "abcdef012345" });

  assert.equal(panel.postedMessages.length, 1);
  const posted = panel.postedMessages[0]!;
  // Renderer never invents data — it surfaces the failure clearly.
  assert.match(String(posted.html), /Could not expand V-REF/);
  assert.match(String(posted.html), /unsupported_category/);
});

test("renderExpandedVexpRefContent renders both success and failure shapes", () => {
  const successHtml = renderExpandedVexpRefContent({
    resolved: true,
    stableId: "vexp:impact:src/app.ts::App",
    category: "impact_graph",
    content: { kind: "json", value: { nodes: [{ fqName: "App" }] } },
    metadata: { origin: "run_pipeline" },
  });
  assert.match(successHtml, /vexp:impact:src\/app\.ts::App/);
  assert.match(successHtml, /impact_graph/);
  assert.match(successHtml, /not recomputed from disk/);
  assert.match(successHtml, /&quot;fqName&quot;: &quot;App&quot;/);

  const failureHtml = renderExpandedVexpRefContent({
    resolved: false,
    reason: "malformed_hash",
    message: "hash must be 12 lowercase hex characters",
  });
  assert.match(failureHtml, /Could not expand V-REF/);
  assert.match(failureHtml, /malformed_hash/);
  assert.match(failureHtml, /hash must be 12 lowercase hex characters/);
});

interface PipelineFixtureOverrides {
  impactIncluded?: boolean;
  impactSkipReason?: string;
  sessionIncluded?: boolean;
  sessionSkipReason?: string;
  durableIncluded?: boolean;
  durableSkipReason?: string;
  deferred?: Array<Record<string, unknown>>;
}

function makeRunPipelineOutput(overrides: PipelineFixtureOverrides = {}) {
  const impactIncluded = overrides.impactIncluded ?? true;
  const sessionIncluded = overrides.sessionIncluded ?? true;
  const durableIncluded = overrides.durableIncluded ?? true;
  const deferred = overrides.deferred ?? [
    {
      id: "vexp:capsule:abc123",
      hash: "abcdef012345",
      kind: "context_capsule",
      summary: "Full context capsule (pivots and supporting items in non-compact form) is available on demand.",
      suggestedTool: "get_context_capsule",
      suggestedInput: { query: "trace auth flow", maxBudgetCharacters: 2000 },
    },
    {
      id: "vexp:impact:src/auth.ts::login",
      hash: "0123456789ab",
      kind: "impact_graph",
      summary: "Full structural impact graph for the focal symbol (nodes, edges, view).",
      suggestedTool: "get_impact_graph",
      suggestedInput: { symbol_fqn: "src/auth.ts::login", depth: 2 },
    },
  ];
  return {
    schemaVersion: "run_pipeline.vnext/1",
    request: {
      query: "trace auth flow",
      maxResults: 6,
      maxBudgetCharacters: 2000,
      intentRequested: "auto",
      sessionId: null,
    },
    intent: {
      requested: "auto",
      selected: "refactor",
      source: "auto_phrase_trigger",
      rationale: "Phrase 'trace' suggests refactor preset.",
      mappedQueryIntent: "refactor",
      editGoal: "refactor_api",
      includeTestsDefault: false,
      fallbackApplied: false,
    },
    taskSummary: {
      query: "trace auth flow",
      normalizedQuery: "trace auth flow",
      editGoal: "refactor_api",
      includeTestsDefault: false,
    },
    context: {
      included: true,
      skipReason: null,
      pivots: [
        { symbolId: "s1", filePath: "src/auth.ts", fqName: "src/auth.ts::login", localName: "login", kind: "function", role: "pivot", contentMode: "full", compressed: false },
      ],
      supports: [
        { symbolId: "s2", filePath: "src/session.ts", fqName: "src/session.ts::createSession", localName: "createSession", kind: "function", role: "support", contentMode: "skeleton", compressed: false },
      ],
      itemCount: 2,
      compressed: false,
      truncated: false,
      budget: { usedCharacters: 1234, maxCharacters: 2000 },
      capsuleProfileId: "capsule-default",
      routingProfileId: "routing-default",
      capsuleRef: "vexp:capsule:abc123",
    },
    impact: impactIncluded
      ? {
        included: true,
        skipReason: null,
        triggerReason: "refactor_preset",
        selectionSource: "top_pivot_task_mention",
        focalSymbol: { symbolId: "s1", filePath: "src/auth.ts", fqName: "src/auth.ts::login", localName: "login", kind: "function" },
        summary: { dependentSymbolCount: 1, dependentFileCount: 1, maxDepth: 2, maxObservedDistance: 1 },
        topDependents: [
          { fqName: "src/handlers.ts::handleAuth", localName: "handleAuth", kind: "function", filePath: "src/handlers.ts", distance: 1 },
        ],
        impactRef: "vexp:impact:src/auth.ts::login",
      }
      : {
        included: false,
        skipReason: overrides.impactSkipReason ?? "intent_does_not_trigger",
        triggerReason: null,
        selectionSource: null,
        focalSymbol: null,
        summary: null,
        topDependents: null,
        impactRef: null,
      },
    memory: {
      session: sessionIncluded
        ? {
          included: true,
          skipReason: null,
          sessionId: "session-7",
          observationCount: 1,
          recentObservations: [
            { observationId: 11, kind: "review", summary: "reviewed authentication code", createdAtMs: 1, sessionId: "session-7" },
          ],
        }
        : {
          included: false,
          skipReason: overrides.sessionSkipReason ?? "no_session_requested",
          sessionId: null,
          observationCount: 0,
          recentObservations: [],
        },
      durable: durableIncluded
        ? {
          included: true,
          skipReason: null,
          matchedCount: 1,
          topObservations: [
            { observationId: 99, kind: "memory", summary: "memory: prior auth refactor", createdAtMs: 2, sessionId: null },
          ],
        }
        : {
          included: false,
          skipReason: overrides.durableSkipReason ?? "intent_deemphasized",
          matchedCount: 0,
          topObservations: [],
        },
    },
    rules: {
      included: true,
      active: [
        {
          id: "rule-active-1",
          status: "active",
          summary: "Keep auth edits with session tests",
          evidenceCount: 4,
          confidence: "medium",
          reason: "matched linked file",
          score: 34,
        },
      ],
      candidates: [
        {
          id: "rule-candidate-1",
          status: "candidate",
          summary: "Consider documenting auth migrations",
          evidenceCount: 3,
          confidence: "low",
          reason: "matched query term",
          score: 10,
        },
      ],
      activeCount: 2,
      candidateCount: 3,
      omitted: {
        irrelevantActiveRuleCount: 1,
        candidateRuleCount: 3,
        staleRuleCount: 1,
        disabledRuleCount: 1,
        dismissedRuleCount: 1,
      },
      notes: [
        "Active rules are injected only when structurally or lexically relevant.",
        "Candidate rules are previews only and are not active instructions.",
      ],
    },
    diagnostics: {
      intent: { requested: "auto", selected: "refactor", source: "auto_phrase_trigger", fallbackApplied: false },
      retrieval: {
        initialReason: null,
        fallbackApplied: false,
        fallbackMode: null,
        fallbackRecovered: false,
        finalReason: null,
        initialContextItemCount: 2,
        finalContextItemCount: 2,
      },
      impact: {
        included: impactIncluded,
        skipReason: impactIncluded ? null : (overrides.impactSkipReason ?? "intent_does_not_trigger"),
        triggerReason: impactIncluded ? "refactor_preset" : null,
      },
      memory: {
        sessionIncluded,
        sessionSkipReason: sessionIncluded ? null : (overrides.sessionSkipReason ?? "no_session_requested"),
        durableIncluded,
        durableSkipReason: durableIncluded ? null : (overrides.durableSkipReason ?? "intent_deemphasized"),
      },
      rules: {
        included: true,
        activeIncluded: true,
        activeMatchedCount: 1,
        activeTotalCount: 2,
        candidatePreviewCount: 1,
        candidateTotalCount: 3,
        staleTotalCount: 1,
        disabledTotalCount: 1,
        dismissedTotalCount: 1,
      },
      deferredCount: deferred.length,
      omittedSectionCount: [!impactIncluded, !sessionIncluded, !durableIncluded].filter(Boolean).length,
    },
    deferred,
  };
}
