import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { searchLogicFlow } from "./searchLogicFlow";

test("exact start and end FQNs resolve into a real structural path search result", async () => {
  await withLogicFlowFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireLogicFlow(db, {
        start: "src/beta.ts::beta",
        end: "src/base.ts::base",
        maxPaths: 2,
      });

      assert.deepEqual(result.requested, {
        start: "src/beta.ts::beta",
        end: "src/base.ts::base",
        maxPaths: 2,
        crossRepo: false,
      });
      assert.equal(result.resolvedStart.localName, "beta");
      assert.equal(result.resolvedStart.kind, "function");
      assert.equal(result.resolvedEnd.localName, "base");
      assert.equal(result.resolvedEnd.kind, "function");
      assert.equal(result.summary.reachable, true);
      assert.equal(result.summary.shortestPathEdgeCount, 2);
    } finally {
      db.close();
    }
  });
});

test("unknown start and end symbols fail clearly under exact FQN resolution", async () => {
  await withLogicFlowFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const missingStart = searchLogicFlow(db, {
        start: "src/missing.ts::missing",
        end: "src/base.ts::base",
        maxPaths: 2,
      });
      const missingEnd = searchLogicFlow(db, {
        start: "src/beta.ts::beta",
        end: "src/missing.ts::missing",
        maxPaths: 2,
      });

      assert.equal(missingStart.ok, false);
      assert.equal(missingEnd.ok, false);

      if (missingStart.ok || missingEnd.ok) {
        throw new Error("Expected exact-FQN lookup failures.");
      }

      assert.equal(missingStart.error.code, "unknown_start");
      assert.equal(missingStart.error.message, "Unknown indexed start symbol FQN: src/missing.ts::missing");
      assert.deepEqual(missingStart.error.details, {
        field: "start",
        symbolFqn: "src/missing.ts::missing",
        resolutionMode: "exact_fqn",
      });
      assert.equal(missingEnd.error.code, "unknown_end");
      assert.equal(missingEnd.error.message, "Unknown indexed end symbol FQN: src/missing.ts::missing");
      assert.deepEqual(missingEnd.error.details, {
        field: "end",
        symbolFqn: "src/missing.ts::missing",
        resolutionMode: "exact_fqn",
      });
    } finally {
      db.close();
    }
  });
});

test("reachable symbols return bounded deterministic shortest paths", async () => {
  await withLogicFlowFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireLogicFlow(db, {
        start: "src/beta.ts::beta",
        end: "src/base.ts::base",
        maxPaths: 1,
      });

      assert.equal(result.summary.reachable, true);
      assert.equal(result.summary.pathCount, 1);
      assert.equal(result.summary.maxPaths, 1);
      assert.equal(result.summary.truncated, true);
      assert.deepEqual(
        result.paths[0]?.nodes.map((node) => node.fqName),
        [
          "src/beta.ts::beta",
          "src/alpha.ts::alpha",
          "src/base.ts::base",
        ],
      );
      assert.deepEqual(
        result.paths[0]?.steps.map((step) => [step.edgeType, step.fromFqName, step.toFqName]),
        [
          ["imports", "src/beta.ts::beta", "src/alpha.ts::alpha"],
          ["imports", "src/alpha.ts::alpha", "src/base.ts::base"],
        ],
      );
    } finally {
      db.close();
    }
  });
});

test("unreachable symbols return an explicit no-path result", async () => {
  await withLogicFlowFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireLogicFlow(db, {
        start: "src/beta.ts::beta",
        end: "src/orphan.ts::orphan",
        maxPaths: 2,
      });

      assert.equal(result.summary.reachable, false);
      assert.equal(result.summary.pathCount, 0);
      assert.equal(result.summary.shortestPathEdgeCount, null);
      assert.equal(result.summary.truncated, false);
      assert.deepEqual(result.paths, []);
      assert.equal(
        result.coverage.notes.includes(
          "No indexed structural path was found from src/beta.ts::beta to src/orphan.ts::orphan.",
        ),
        true,
      );
    } finally {
      db.close();
    }
  });
});

test("a TypeScript-only repo reports call-flow evidence as unavailable with an honest note", async () => {
  await withLogicFlowFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireLogicFlow(db, {
        start: "src/beta.ts::beta",
        end: "src/base.ts::base",
        maxPaths: 2,
      });

      assert.equal(result.coverage.supportedEdgeTypes.includes("calls"), true);
      assert.equal(result.coverage.observedEdgeTypes.includes("calls"), false);
      assert.equal(result.coverage.callFlowEvidenceAvailable, false);
      assert.equal(result.coverage.callFlowEvidenceUsed, false);
      assert.equal(
        result.coverage.notes.some((note) =>
          note.includes("No statically resolved calls edges were available")
        ),
        true,
      );
    } finally {
      db.close();
    }
  });
});

test("a direct A -> B call path is found through a statically resolved calls edge", async () => {
  await withPythonCallFlowFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireLogicFlow(db, {
        start: "src/pkg/user.py::entry",
        end: "src/pkg/target.py::do_work",
        maxPaths: 3,
      });

      assert.equal(result.summary.reachable, true);
      assert.equal(result.summary.shortestPathEdgeCount, 1);
      assert.deepEqual(
        result.paths[0]?.steps.map((step) => [step.edgeType, step.fromFqName, step.toFqName]),
        [["calls", "src/pkg/user.py::entry", "src/pkg/target.py::do_work"]],
      );
      assert.equal(result.coverage.callFlowEvidenceAvailable, true);
      assert.equal(result.coverage.callFlowEvidenceUsed, true);
      assert.equal(result.coverage.observedEdgeTypes.includes("calls"), true);
      assert.equal(
        result.coverage.notes.some((note) =>
          note.includes("traverses a statically resolved calls edge")
        ),
        true,
      );
    } finally {
      db.close();
    }
  });
});

test("a mixed imports + calls path is found when both edge types are available", async () => {
  await withPythonMixedFlowFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireLogicFlow(db, {
        start: "src/pkg/caller.py::caller",
        end: "src/pkg/leaf.py::leaf",
        maxPaths: 3,
      });

      assert.equal(result.summary.reachable, true);
      const observedTypes = new Set(
        result.paths.flatMap((path) => path.steps.map((step) => step.edgeType)),
      );
      assert.equal(observedTypes.has("calls"), true);
      assert.equal(result.coverage.callFlowEvidenceAvailable, true);
      assert.equal(result.coverage.callFlowEvidenceUsed, true);
    } finally {
      db.close();
    }
  });
});

test("call-flow path search is deterministic across repeated calls", async () => {
  await withPythonCallFlowFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const first = requireLogicFlow(db, {
        start: "src/pkg/user.py::entry",
        end: "src/pkg/target.py::do_work",
        maxPaths: 3,
      });
      const second = requireLogicFlow(db, {
        start: "src/pkg/user.py::entry",
        end: "src/pkg/target.py::do_work",
        maxPaths: 3,
      });

      assert.deepEqual(second, first);
    } finally {
      db.close();
    }
  });
});

test("shortest-path ordering is deterministic across repeated calls", async () => {
  await withLogicFlowFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const first = requireLogicFlow(db, {
        start: "src/beta.ts::beta",
        end: "src/base.ts::base",
        maxPaths: 3,
      });
      const second = requireLogicFlow(db, {
        start: "src/beta.ts::beta",
        end: "src/base.ts::base",
        maxPaths: 3,
      });

      assert.deepEqual(second, first);
      assert.deepEqual(
        first.paths.map((path) => path.nodes.map((node) => node.fqName)),
        [
          [
            "src/beta.ts::beta",
            "src/alpha.ts::alpha",
            "src/base.ts::base",
          ],
          [
            "src/beta.ts::beta",
            "src/zeta.ts::zeta",
            "src/base.ts::base",
          ],
        ],
      );
    } finally {
      db.close();
    }
  });
});

async function withLogicFlowFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-logic-flow-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeLogicFlowFixtureRepo(repoRoot);
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withPythonCallFlowFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  await withPythonFixture(run, async (pkgRoot) => {
    await writeFile(path.join(pkgRoot, "__init__.py"), "");
    await writeFile(
      path.join(pkgRoot, "target.py"),
      ["def do_work(x):", "    return x", ""].join("\n"),
    );
    await writeFile(
      path.join(pkgRoot, "user.py"),
      [
        "from .target import do_work",
        "",
        "def entry():",
        "    return do_work(1)",
        "",
      ].join("\n"),
    );
  });
}

async function withPythonMixedFlowFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  await withPythonFixture(run, async (pkgRoot) => {
    await writeFile(path.join(pkgRoot, "__init__.py"), "");
    await writeFile(
      path.join(pkgRoot, "leaf.py"),
      ["def leaf():", "    return 1", ""].join("\n"),
    );
    await writeFile(
      path.join(pkgRoot, "middle.py"),
      [
        "from .leaf import leaf",
        "",
        "def middle():",
        "    return leaf()",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(pkgRoot, "caller.py"),
      [
        "from .middle import middle",
        "",
        "def caller():",
        "    return middle",
        "",
      ].join("\n"),
    );
  });
}

async function withPythonFixture(
  run: (repoRoot: string) => Promise<void>,
  writePackage: (pkgRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-logic-flow-py-"));
  const repoRoot = path.join(root, "repo");
  const pkgRoot = path.join(repoRoot, "src", "pkg");

  try {
    await mkdir(pkgRoot, { recursive: true });
    await writePackage(pkgRoot);
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeLogicFlowFixtureRepo(repoRoot: string): Promise<void> {
  await writeFile(
    path.join(repoRoot, "src", "base.ts"),
    [
      "export function base(): string {",
      "  return \"base\";",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src", "alpha.ts"),
    [
      "import { base } from \"./base\";",
      "",
      "export function alpha(): string {",
      "  return base();",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src", "zeta.ts"),
    [
      "import { base } from \"./base\";",
      "",
      "export function zeta(): string {",
      "  return base();",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src", "beta.ts"),
    [
      "import { alpha } from \"./alpha\";",
      "import { zeta } from \"./zeta\";",
      "",
      "export function beta(): string {",
      "  return alpha().length > zeta().length ? alpha() : zeta();",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src", "orphan.ts"),
    [
      "export function orphan(): string {",
      "  return \"orphan\";",
      "}",
      "",
    ].join("\n"),
  );
}

function requireLogicFlow(
  db: Parameters<typeof searchLogicFlow>[0],
  input: Parameters<typeof searchLogicFlow>[1],
) {
  const result = searchLogicFlow(db, input);

  if (!result.ok) {
    throw new Error(`Expected successful logic-flow result: ${result.error.message}`);
  }

  return result.output;
}
