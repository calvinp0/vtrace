import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CapsuleIntent } from "../../src/capsuleV2/types";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { getImpactGraph, type ImpactGraphOutput } from "../../src/impact/getImpactGraph";
import { indexProject } from "../../src/indexer/indexProject";
import { normalizeGraph } from "../../src/indexer/normalizedGraph";
import { searchLogicFlow } from "../../src/logicFlow/searchLogicFlow";
import { assembleProductContext, buildUnresolvedProductContext } from "../../src/productContext/assembleProductContext";

const RESULTS = path.join(import.meta.dir, "results");
const DETAIL_PATH = path.join(RESULTS, "stage5_m120_impact_flow_smoke.detail.json");
const CSV_PATH = path.join(RESULTS, "stage5_m120_impact_flow_smoke.csv");
const COMPARISON_PATH = path.join(RESULTS, "stage5_m120_impact_flow_comparison.json");

interface CaseResult {
  case: string;
  passed: boolean;
  evidence: string;
  durationMs: number;
}

const cases: CaseResult[] = [];
let comparison: unknown = null;
const record = async (name: string, run: () => Promise<string> | string): Promise<void> => {
  const started = performance.now();
  try {
    const evidence = await run();
    cases.push({ case: name, passed: true, evidence, durationMs: performance.now() - started });
  } catch (error) {
    cases.push({ case: name, passed: false, evidence: error instanceof Error ? error.message : String(error), durationMs: performance.now() - started });
  }
};

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-m120-smoke-"));
const repoRoot = path.join(tempRoot, "repo");
const db = openIndexerDatabase();

try {
  await writeFixture(repoRoot);
  const full = await indexProject({ repoRoot, db, refreshMode: "full" });
  assert.ok(full.snapshot);

  const target = requireImpact(getImpactGraph(db, {
    symbolFqn: "src/pkg/base.py::target",
    depth: 4,
    format: "list",
    direction: "both",
    includeLexical: true,
    maxPaths: 8,
    maxEdges: 64,
    maxTokens: 20_000,
  }, { repoRoot, measureTiming: true }));
  const baseClass = requireImpact(getImpactGraph(db, { symbolFqn: "src/pkg/base.py::Base", depth: 3, format: "list" }, { repoRoot }));
  const tsWork = requireImpact(getImpactGraph(db, { symbolFqn: "src/lib.ts::work", depth: 4, format: "list", maxPaths: 8, maxTokens: 20_000 }, { repoRoot }));
  const contract = requireImpact(getImpactGraph(db, { symbolFqn: "src/contracts.ts::Contract", depth: 3, format: "list" }, { repoRoot }));
  const legacyDirectEdges = target.edges.filter((edge) => {
    const source = target.nodes.find((node) => node.symbolId === edge.fromSymbolId);
    return source?.distance === 1;
  });
  const edgeSites = target.directRelations.filter((edge) => edge.evidence.locationKind === "edge_site").length;
  comparison = {
    target: target.resolvedSymbol.fqName,
    comparisonBoundary: "M119-compatible legacy fields and M120 rich fields from the same indexed synthetic snapshot; old latency is unavailable because M119 exposed no dedicated impact timing seam",
    old: {
      behavior: "reverse shortest-layer nodes/edges and flat dependent files",
      directEdgeCount: legacyDirectEdges.length,
      typedEdgeCounts: countStrings(legacyDirectEdges.map((edge) => edge.edgeType)),
      sourceGroundedEdgePercent: 0,
      resolvedVsLexical: null,
      pathCount: 0,
      affectedFiles: target.dependentFiles.length,
      entrypoints: 0,
      tests: 0,
      renderedTokenEstimate: Math.ceil(target.view.lines.join("\n").length / 4),
      latencyMs: null,
      truncated: false,
    },
    new: {
      behavior: "typed incoming/outgoing evidence plus bounded strongest static paths",
      directEdgeCount: target.directRelations.length,
      typedEdgeCounts: target.richSummary.countsByRelation,
      sourceGroundedEdgePercent: target.directRelations.length === 0 ? 0 : Number(((edgeSites / target.directRelations.length) * 100).toFixed(1)),
      resolvedVsLexical: target.richSummary.countsByStrength,
      pathCount: target.paths.length,
      affectedFiles: target.richSummary.affectedFiles,
      entrypoints: target.entrypoints.length,
      tests: target.tests.length,
      renderedTokenEstimate: Math.ceil(JSON.stringify({ directRelations: target.directRelations, paths: target.paths, affectedFiles: target.affectedFiles }).length / 4),
      latencyMs: target.timing,
      truncated: target.richSummary.truncated,
      omittedPaths: target.richSummary.omittedPaths,
      omittedEdges: target.richSummary.omittedEdges,
    },
    interpretation: "The gain is provenance, semantic separation, and bounded path explanation; extra edge quantity alone is not treated as improvement.",
  };

  await record("1_python_direct_caller", () => {
    const calls = target.directRelations.filter((edge) => edge.kind === "calls");
    assert.ok(calls.length >= 2);
    assert.ok(calls.every((edge) => edge.persistedKind === "calls" && edge.strength !== "lexical"));
    return `${calls.length} source-grounded calls`;
  });
  await record("2_python_aliased_import_and_call", () => {
    const alias = target.directRelations.find((edge) => edge.evidence.importAlias === "run");
    assert.ok(alias);
    assert.equal(alias.evidence.resolutionMethod, "relative_import_resolution");
    return `${alias.kind}:${alias.evidence.importAlias}`;
  });
  await record("3_python_relative_import", () => {
    assert.ok(target.directRelations.some((edge) => edge.evidence.resolutionMethod === "relative_import_resolution"));
    return "relative import resolved to canonical target";
  });
  await record("4_python_package_reexport", () => {
    const edge = target.directRelations.find((candidate) => candidate.kind === "re_exports");
    assert.ok(edge);
    assert.match(edge.source.path ?? "", /__init__\.py$/u);
    return `${edge.source.path}:${edge.source.lineSpan?.start}`;
  });
  await record("5_python_inheritance_chain", () => {
    const inherits = baseClass.directRelations.filter((edge) => edge.kind === "inherits");
    assert.ok(inherits.length > 0);
    assert.ok(inherits.every((edge) => edge.strength === "exact"));
    return `${inherits.length} explicit base clauses`;
  });
  await record("6_typescript_import_call", () => {
    assert.ok(tsWork.directRelations.some((edge) => edge.kind === "calls"));
    assert.ok(tsWork.directRelations.some((edge) => edge.kind === "imports"));
    return "calls and imports remain distinct";
  });
  await record("7_typescript_reexport", () => {
    const edge = tsWork.directRelations.find((candidate) => candidate.kind === "re_exports");
    assert.ok(edge);
    assert.equal(edge.source.path, "src/index.ts");
    return "index.ts export syntax reconstructed";
  });
  await record("8_typescript_extends_implements", () => {
    assert.ok(contract.directRelations.some((edge) => edge.kind === "implements"));
    return "explicit implements clause";
  });
  await record("9_test_to_target", () => {
    assert.ok(target.tests.some((test) => test.fqName.includes("test_target")));
    assert.ok(target.paths.some((flowPath) => flowPath.direction === "test_to_target"));
    return "test direct-call path classified";
  });
  await record("10_documentation_to_symbol", () => {
    const docs = target.directRelations.find((edge) => edge.kind === "documents");
    assert.ok(docs);
    assert.equal(docs.strength, "lexical");
    return `${docs.source.path}:${docs.source.lineSpan?.start} lexical`;
  });
  await record("11_multiple_paths_deterministic_ranking", () => {
    const first = searchLogicFlow(db, { start: "src/multi.ts::start", end: "src/multi.ts::end", maxPaths: 4, maxDepth: 4, maxTokens: 20_000 }, { repoRoot });
    const second = searchLogicFlow(db, { start: "src/multi.ts::start", end: "src/multi.ts::end", maxPaths: 4, maxDepth: 4, maxTokens: 20_000 }, { repoRoot });
    assert.equal(first.ok, true); assert.equal(second.ok, true);
    if (!first.ok || !second.ok) throw new Error("flow failed");
    assert.ok(first.output.paths.length >= 2);
    assert.deepEqual(second.output.paths, first.output.paths);
    return `${first.output.paths.length} stable paths`;
  });
  await record("12_cycle_safe", () => {
    const flow = searchLogicFlow(db, { start: "src/cycle.ts::a", end: "src/cycle.ts::c", maxPaths: 3, maxDepth: 3, maxEdges: 100 }, { repoRoot });
    assert.equal(flow.ok, true);
    if (!flow.ok) throw new Error("flow failed");
    assert.equal(flow.output.summary.shortestPathEdgeCount, 2);
    assert.ok(flow.output.diagnostics.nodesVisited <= 3);
    return `${flow.output.diagnostics.nodesVisited} nodes visited`;
  });
  await record("13_lexical_only_reference", () => {
    const docs = target.directRelations.filter((edge) => edge.kind === "documents");
    assert.ok(docs.length > 0 && docs.every((edge) => edge.strength === "lexical" && edge.confidence === null));
    return "lexical evidence excluded from call truth";
  });
  await record("14_ambiguous_unresolved_target", () => {
    const unknown = getImpactGraph(db, { symbolFqn: "src/pkg/base.py::missing", depth: 1, format: "list", includeUnresolved: true });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.error.code, "unknown_symbol");
    return "unknown target rejected; no target fabricated";
  });
  await record("15_no_path", () => {
    const flow = searchLogicFlow(db, { start: "src/cycle.ts::a", end: "src/contracts.ts::Contract", maxPaths: 2, maxDepth: 4 });
    assert.equal(flow.ok, true);
    if (flow.ok) assert.equal(flow.output.summary.reachable, false);
    return "explicit reachable=false";
  });
  await record("16_bounded_truncation", () => {
    const bounded = requireImpact(getImpactGraph(db, { symbolFqn: "src/pkg/base.py::target", depth: 4, format: "list", maxPaths: 1, maxEdges: 1, maxTokens: 80 }, { repoRoot }));
    assert.equal(bounded.richSummary.truncated, true);
    assert.ok(bounded.richSummary.omittedEdges > 0 || bounded.richSummary.omittedPaths > 0);
    return `omittedEdges=${bounded.richSummary.omittedEdges};omittedPaths=${bounded.richSummary.omittedPaths}`;
  });
  await record("17_linked_worktree_isolation", async () => {
    const isolationRepo = path.join(tempRoot, "isolation-repo");
    await writeFixture(isolationRepo);
    const isolationDb = openIndexerDatabase();
    await indexProject({ repoRoot: isolationRepo, db: isolationDb, refreshMode: "full" });
    const isolationImpact = requireImpact(getImpactGraph(isolationDb, { symbolFqn: "src/lib.ts::work", depth: 2, format: "list" }, { repoRoot: isolationRepo }));
    isolationDb.close();
    const linked = await createLinkedWorktree(isolationRepo, tempRoot);
    const linkedDb = openIndexerDatabase();
    try {
      await writeFile(path.join(linked, "src", "consumer.ts"), "export function use(): number { return 0; }\n");
      await indexProject({ repoRoot: linked, db: linkedDb, refreshMode: "full" });
      const linkedImpact = requireImpact(getImpactGraph(linkedDb, { symbolFqn: "src/lib.ts::work", depth: 2, format: "list" }, { repoRoot: linked }));
      assert.ok(isolationImpact.richSummary.directIncoming > linkedImpact.richSummary.directIncoming);
      return `${isolationImpact.richSummary.directIncoming} main vs ${linkedImpact.richSummary.directIncoming} linked`;
    } finally { linkedDb.close(); }
  });
  await record("18_incremental_full_equivalence", async () => {
    const before = full.snapshot!;
    await writeFile(path.join(repoRoot, "src", "orphan.ts"), "export function orphan(): number { return 2; }\n");
    const incremental = await indexProject({ repoRoot, db, refreshMode: "incremental", previousSnapshot: before, hasExistingGraph: true, previousSnapshotCompatible: true });
    assert.equal(incremental.performance?.mode, "incremental", JSON.stringify(incremental.performance));
    const fullDb = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db: fullDb, refreshMode: "full" });
      assert.deepEqual(normalizeGraph(db), normalizeGraph(fullDb));
      const incImpact = requireImpact(getImpactGraph(db, { symbolFqn: "src/lib.ts::work", depth: 3, format: "list" }, { repoRoot }));
      const fullImpact = requireImpact(getImpactGraph(fullDb, { symbolFqn: "src/lib.ts::work", depth: 3, format: "list" }, { repoRoot }));
      assert.deepEqual(incImpact, fullImpact);
      return "normalized graph and rich impact byte-equivalent";
    } finally { fullDb.close(); }
  });
  await record("19_product_context_impact_integration", async () => {
    const product = await assembleProductContext({ db, repoRoot, task: "impact callers of src/lib.ts work", intent: CapsuleIntent.Impact, budgetTokens: 8_000, freshnessOverride: { status: "fresh", reason: "smoke", action: "none" } });
    const impactItems = product.items.filter((item) => item.roles.includes("impact"));
    assert.ok(impactItems.length > 0, JSON.stringify({ resolved: product.resolved, leadPivot: product.leadPivot, items: product.items.map((item) => ({ path: item.path, symbol: item.symbol, roles: item.roles })) }));
    assert.ok(impactItems.every((item) => item.metadata?.contextReference === `[${item.id}]`));
    assert.equal(product.accounting.renderedCharacters, product.modelVisibleContext.length);
    return `${impactItems.length} items;${product.accounting.usedTokensEstimate} tokens`;
  });
  await record("20_no_context_stale_index", () => {
    const stale = buildUnresolvedProductContext({ task: "impact", repoRoot, repositoryId: "repo", worktreeId: "worktree", headCommit: null, branch: "main", detached: false, freshnessStatus: "stale", freshnessReason: "changed", freshnessAction: "index_repo", totalMs: 1 });
    assert.equal(stale.resolved, false);
    assert.equal(stale.items.length, 0);
    assert.equal(stale.modelVisibleContext, "");
    return "fails closed without model-visible context";
  });
} finally {
  db.close();
  await mkdir(RESULTS, { recursive: true });
  const passed = cases.filter((entry) => entry.passed).length;
  const detail = {
    milestone: "M120",
    generatedAt: new Date().toISOString(),
    noAgent: true,
    liveAgentRuns: 0,
    dockerRuns: 0,
    vexpRuns: 0,
    summary: { total: cases.length, passed, failed: cases.length - passed, verdict: passed === 20 ? "PASS" : "FAIL", totalDurationMs: cases.reduce((sum, entry) => sum + entry.durationMs, 0) },
    cases,
  };
  await writeFile(DETAIL_PATH, `${JSON.stringify(detail, null, 2)}\n`);
  await writeFile(CSV_PATH, ["case,passed,duration_ms,evidence", ...cases.map((entry) => [entry.case, entry.passed, entry.durationMs.toFixed(3), entry.evidence].map(csv).join(","))].join("\n") + "\n");
  await writeFile(COMPARISON_PATH, `${JSON.stringify(comparison, null, 2)}\n`);
  await rm(tempRoot, { recursive: true, force: true });
}

if (cases.some((entry) => !entry.passed) || cases.length !== 20) process.exitCode = 1;
else console.log(`M120 no-agent smoke PASS: ${cases.length}/${cases.length}`);

function requireImpact(result: ReturnType<typeof getImpactGraph>): ImpactGraphOutput {
  if ("error" in result) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.output;
}

async function writeFixture(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, "src", "pkg"), { recursive: true });
  await mkdir(path.join(repoRoot, "tests"), { recursive: true });
  await mkdir(path.join(repoRoot, "docs"), { recursive: true });
  await writeFile(path.join(repoRoot, "src", "__init__.py"), "");
  await writeFile(path.join(repoRoot, "src", "pkg", "base.py"), "def mark(fn):\n    return fn\n\nclass Base:\n    pass\n\ndef target(value):\n    return value\n");
  await writeFile(path.join(repoRoot, "src", "pkg", "__init__.py"), "from .base import Base, target\n");
  await writeFile(path.join(repoRoot, "src", "pkg", "user.py"), "from .base import target as run\nfrom .base import mark\n\n@mark\ndef decorated():\n    return run(1)\n\ndef entry():\n    return run(2)\n");
  await writeFile(path.join(repoRoot, "src", "pkg", "sub.py"), "from .base import Base\n\nclass Sub(Base):\n    pass\n");
  await writeFile(path.join(repoRoot, "tests", "test_user.py"), "from src.pkg.base import target\n\ndef test_target():\n    assert target(1) == 1\n");
  await writeFile(path.join(repoRoot, "src", "lib.ts"), "export function work(): number { return 1; }\n");
  await writeFile(path.join(repoRoot, "src", "index.ts"), "export { work } from \"./lib\";\n");
  await writeFile(path.join(repoRoot, "src", "consumer.ts"), "import { work as doWork } from \"./lib\";\nexport function use(): number { return doWork(); }\n");
  await writeFile(path.join(repoRoot, "src", "contracts.ts"), "export interface Contract { run(): void; }\nexport class Impl implements Contract { run(): void {} }\n");
  await writeFile(path.join(repoRoot, "src", "cycle.ts"), "export function a(): number { return b(); }\nexport function b(): number { return c(); }\nexport function c(): number { return a(); }\n");
  await writeFile(path.join(repoRoot, "src", "multi.ts"), "export function end(): number { return 1; }\nexport function left(): number { return end(); }\nexport function right(): number { return end(); }\nexport function start(): number { return left() + right(); }\n");
  await writeFile(path.join(repoRoot, "src", "orphan.ts"), "export function orphan(): number { return 1; }\n");
  await writeFile(path.join(repoRoot, "docs", "guide.md"), "# Target API\nUse `src/pkg/base.py::target` for the example.\n");
}

async function createLinkedWorktree(repoRoot: string, tempRoot: string): Promise<string> {
  runGit(repoRoot, ["init"]);
  runGit(repoRoot, ["add", "."]);
  runGit(repoRoot, ["-c", "user.name=VTRACE Smoke", "-c", "user.email=smoke@invalid", "commit", "-m", "fixture"]);
  const linked = path.join(tempRoot, "linked");
  runGit(repoRoot, ["worktree", "add", "-b", "linked", linked]);
  return linked;
}

function runGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function csv(value: unknown): string {
  const text = String(value);
  return /[",\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function countStrings(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}
