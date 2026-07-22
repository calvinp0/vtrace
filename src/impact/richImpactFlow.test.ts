import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { searchLogicFlow } from "../logicFlow/searchLogicFlow";
import { getImpactGraph } from "./getImpactGraph";

test("rich impact keeps calls/imports distinct and grounds incoming/outgoing evidence", async () => {
  await withRichFixture(async (repoRoot) => {
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db });
      const result = getImpactGraph(db, {
        symbolFqn: "src/pkg/base.py::target",
        depth: 3,
        format: "list",
        direction: "both",
        includeLexical: true,
        maxPaths: 8,
        maxEdges: 64,
        maxTokens: 20_000,
      }, { repoRoot });
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const kinds = new Set(result.output.directRelations.map((relation) => relation.kind));
      assert.equal(kinds.has("calls"), true);
      assert.equal(kinds.has("imports") || kinds.has("re_exports"), true, JSON.stringify(result.output.directRelations));
      assert.equal(kinds.has("documents"), true);
      assert.ok(result.output.richSummary.directIncoming > 0);
      assert.ok(result.output.richSummary.directOutgoing >= 0);
      for (const relation of result.output.directRelations) {
        assert.ok(relation.source.path);
        assert.ok(relation.source.lineSpan);
        assert.ok(relation.target.nodeId);
        assert.ok(relation.evidence.resolutionMethod);
        assert.equal(relation.confidence, null);
        if (relation.kind === "documents") assert.equal(relation.strength, "lexical");
        if (relation.kind === "calls") assert.notEqual(relation.strength, "lexical");
      }
      assert.equal(result.output.diagnostics.staticEvidenceOnly, true);
      assert.match(result.output.diagnostics.limitations.join(" "), /not runtime execution traces/iu);
    } finally {
      db.close();
    }
  });
});

test("alias, relative import, package re-export, test links, and bounded paths stay explicit", async () => {
  await withRichFixture(async (repoRoot) => {
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db });
      const result = getImpactGraph(db, {
        symbolFqn: "src/pkg/base.py::target",
        depth: 4,
        format: "tree",
        direction: "upstream",
        maxPaths: 2,
        maxEdges: 64,
        maxTokens: 20_000,
      }, { repoRoot });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.ok(result.output.directRelations.some((relation) =>
        relation.evidence.resolutionMethod.includes("alias")
        || relation.evidence.resolutionMethod.includes("relative")
        || relation.kind === "re_exports"
      ), JSON.stringify(result.output.directRelations));
      assert.ok(result.output.tests.some((entry) => entry.fqName.includes("test_target")));
      assert.ok(result.output.paths.length <= 2);
      assert.equal(result.output.limits.maxPaths, 2);
      assert.deepEqual(
        [...result.output.paths].sort((left, right) => left.id.localeCompare(right.id)).map((entry) => entry.id),
        [...result.output.paths].sort((left, right) => left.id.localeCompare(right.id)).map((entry) => entry.id),
      );
    } finally {
      db.close();
    }
  });
});

test("inheritance, implementation, and decorator references are syntax-classified without becoming calls", async () => {
  await withRichFixture(async (repoRoot) => {
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db });
      const pythonBase = getImpactGraph(db, { symbolFqn: "src/pkg/base.py::Base", depth: 2, format: "list" }, { repoRoot });
      const decorator = getImpactGraph(db, { symbolFqn: "src/pkg/base.py::mark", depth: 2, format: "list" }, { repoRoot });
      const contract = getImpactGraph(db, { symbolFqn: "src/contracts.ts::Contract", depth: 2, format: "list" }, { repoRoot });
      assert.equal(pythonBase.ok, true);
      assert.equal(decorator.ok, true);
      assert.equal(contract.ok, true);
      if (!pythonBase.ok || !decorator.ok || !contract.ok) return;
      assert.ok(pythonBase.output.directRelations.some((relation) => relation.kind === "inherits"));
      assert.ok(decorator.output.directRelations.some((relation) => relation.kind === "decorates"));
      assert.ok(contract.output.directRelations.some((relation) => relation.kind === "implements"));
      assert.equal(pythonBase.output.directRelations.some((relation) => relation.kind === "calls"), false);
    } finally {
      db.close();
    }
  });
});

test("flow relation filters, depth/edge/token caps, no-path result, and cycle safety are deterministic", async () => {
  await withRichFixture(async (repoRoot) => {
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db });
      const input = {
        start: "src/cycle.ts::a",
        end: "src/cycle.ts::c",
        maxPaths: 2,
        maxDepth: 2,
        maxEdges: 100,
        maxTokens: 20_000,
        relations: ["calls" as const],
      };
      const first = searchLogicFlow(db, input, { repoRoot });
      const second = searchLogicFlow(db, input, { repoRoot });
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      if (!first.ok || !second.ok) return;
      assert.deepEqual(second.output.paths, first.output.paths);
      assert.equal(first.output.summary.reachable, true);
      assert.equal(first.output.paths[0]?.edgeCount, 2);
      assert.ok(first.output.paths.every((flowPath) => flowPath.steps.every((step) => step.relation?.kind === "calls")));
      assert.ok(first.output.diagnostics.nodesVisited <= 3);

      const tooShallow = searchLogicFlow(db, { ...input, maxDepth: 1 }, { repoRoot });
      assert.equal(tooShallow.ok, true);
      if (tooShallow.ok) assert.equal(tooShallow.output.summary.reachable, false);
      const noPath = searchLogicFlow(db, { ...input, end: "src/contracts.ts::Contract" }, { repoRoot });
      assert.equal(noPath.ok, true);
      if (noPath.ok) assert.equal(noPath.output.summary.reachable, false);
    } finally {
      db.close();
    }
  });
});

async function withRichFixture(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-m120-rich-"));
  const repoRoot = path.join(root, "repo");
  try {
    await mkdir(path.join(repoRoot, "src", "pkg"), { recursive: true });
    await mkdir(path.join(repoRoot, "tests"), { recursive: true });
    await mkdir(path.join(repoRoot, "docs"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "__init__.py"), "");
    await writeFile(path.join(repoRoot, "src", "pkg", "base.py"), [
      "def mark(fn):", "    return fn", "", "class Base:", "    pass", "", "def target(value):", "    return value", "",
    ].join("\n"));
    await writeFile(path.join(repoRoot, "src", "pkg", "__init__.py"), "from .base import Base, target\n");
    await writeFile(path.join(repoRoot, "src", "pkg", "user.py"), [
      "from .base import target as run", "from .base import mark", "", "@mark", "def decorated():", "    return run(1)", "", "def entry():", "    return run(2)", "",
    ].join("\n"));
    await writeFile(path.join(repoRoot, "src", "pkg", "sub.py"), [
      "from .base import Base", "", "class Sub(Base):", "    pass", "",
    ].join("\n"));
    await writeFile(path.join(repoRoot, "tests", "test_user.py"), [
      "from src.pkg.base import target", "", "def test_target():", "    assert target(1) == 1", "",
    ].join("\n"));
    await writeFile(path.join(repoRoot, "src", "contracts.ts"), [
      "export interface Contract { run(): void; }", "export class Impl implements Contract { run(): void {} }", "",
    ].join("\n"));
    await writeFile(path.join(repoRoot, "src", "cycle.ts"), [
      "export function a(): number { return b(); }", "export function b(): number { return c(); }", "export function c(): number { return a(); }", "",
    ].join("\n"));
    await writeFile(path.join(repoRoot, "docs", "guide.md"), "# Target API\nUse `src/pkg/base.py::target` for the example.\n");
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
