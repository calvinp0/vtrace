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
          ["calls", "src/beta.ts::beta", "src/alpha.ts::alpha"],
          ["calls", "src/alpha.ts::alpha", "src/base.ts::base"],
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
      assert.equal(result.summary.traversalLimitReached, false);
      assert.deepEqual(result.paths, []);
      assert.equal(
        result.coverage.notes.includes(
          "No indexed structural path was found from src/beta.ts::beta to src/orphan.ts::orphan in the current index.",
        ),
        true,
      );
    } finally {
      db.close();
    }
  });
});

test("a TypeScript repo traverses statically resolved call edges through search_logic_flow", async () => {
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
      assert.equal(result.coverage.observedEdgeTypes.includes("calls"), true);
      assert.equal(result.coverage.callFlowEvidenceAvailable, true);
      assert.equal(result.coverage.callFlowEvidenceUsed, true);
      const usesCallEdge = result.paths.some((path) =>
        path.steps.some((step) => step.edgeType === "calls")
      );
      assert.equal(usesCallEdge, true);
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

test("a Cython call path is found through a statically resolved calls edge", async () => {
  await withCythonCallFlowFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireLogicFlow(db, {
        start: "src/kernel.pyx::entry",
        end: "src/kernel.pyx::target",
        maxPaths: 3,
      });

      assert.equal(result.summary.reachable, true);
      assert.equal(result.summary.shortestPathEdgeCount, 1);
      assert.deepEqual(
        result.paths[0]?.steps.map((step) => [step.edgeType, step.fromFqName, step.toFqName]),
        [["calls", "src/kernel.pyx::entry", "src/kernel.pyx::target"]],
      );
      assert.equal(result.coverage.callFlowEvidenceAvailable, true);
      assert.equal(result.coverage.callFlowEvidenceUsed, true);
      assert.equal(result.coverage.observedEdgeTypes.includes("calls"), true);
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
      // M140: a module-level import is owned by the importing MODULE, not by
      // whichever function the file happens to define. Before M140 this fixture
      // produced `caller --imports--> middle` only because caller.py had
      // exactly one top-level symbol; the function itself never imported
      // anything. The import leg of the path now starts at module scope.
      const result = requireLogicFlow(db, {
        start: "src/pkg/caller.py::<module>",
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
      // beta -> alpha -> base is now reachable through both `imports` and the
      // newly extracted `calls` edges, so the bounded shortest-path set is the
      // deterministic combination of those edge types over the same node chain.
      assert.deepEqual(
        first.paths.map((path) =>
          path.steps.map((step) => [step.edgeType, step.fromFqName, step.toFqName]),
        ),
        [
          [
            ["calls", "src/beta.ts::beta", "src/alpha.ts::alpha"],
            ["calls", "src/alpha.ts::alpha", "src/base.ts::base"],
          ],
          [
            ["calls", "src/beta.ts::beta", "src/alpha.ts::alpha"],
            ["imports", "src/alpha.ts::alpha", "src/base.ts::base"],
          ],
          [
            ["imports", "src/beta.ts::beta", "src/alpha.ts::alpha"],
            ["calls", "src/alpha.ts::alpha", "src/base.ts::base"],
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

async function withCythonCallFlowFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-logic-flow-cy-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "src", "kernel.pyx"),
      [
        "cpdef int target(int v):",
        "    return v + 1",
        "",
        "def entry(int n):",
        "    return target(n)",
        "",
      ].join("\n"),
    );
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

test("path steps omit source excerpts unless the product layer requests them", async () => {
  await withLogicFlowFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireLogicFlow(db, {
        start: "src/beta.ts::beta",
        end: "src/base.ts::base",
        maxPaths: 1,
      });

      for (const path of result.paths) {
        for (const step of path.steps) {
          assert.equal(step.sourceExcerpt, undefined);
        }
      }
    } finally {
      db.close();
    }
  });
});

test("path steps include bounded edge-source excerpts when repoRoot is provided", async () => {
  await withLogicFlowFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = searchLogicFlow(db, {
        start: "src/beta.ts::beta",
        end: "src/base.ts::base",
        maxPaths: 1,
      }, { repoRoot });

      assert.equal(result.ok, true);
      if (!result.ok) {
        throw new Error("expected success");
      }

      const firstStep = result.output.paths[0]?.steps[0];
      assert.ok(firstStep, "expected at least one step");
      assert.ok(firstStep.sourceExcerpt, "expected an excerpt on the first step");
      // The excerpt is the edge source (the `from` symbol, where the call lives).
      assert.equal(firstStep.sourceExcerpt.filePath, "src/beta.ts");
      assert.ok(firstStep.sourceExcerpt.text.includes("beta"));
      assert.ok(
        firstStep.sourceExcerpt.text.split("\n").length <= 12,
        "excerpt must respect the line ceiling",
      );
      assert.ok(
        ["symbol_span", "fallback_symbol_window"].includes(firstStep.sourceExcerpt.reason),
      );
    } finally {
      db.close();
    }
  });
});

test("flow excerpts are capped at the per-path budget", async () => {
  await withLogicFlowFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = searchLogicFlow(db, {
        start: "src/beta.ts::beta",
        end: "src/base.ts::base",
        maxPaths: 1,
      }, { repoRoot, maxExcerptsPerPath: 1 });

      assert.equal(result.ok, true);
      if (!result.ok) {
        throw new Error("expected success");
      }

      const steps = result.output.paths[0]?.steps ?? [];
      assert.ok(steps.length >= 2, "expected a multi-step path");
      assert.ok(steps[0]?.sourceExcerpt, "first step within budget should carry an excerpt");
      assert.equal(steps[1]?.sourceExcerpt, null, "step beyond budget should be explicitly nulled");
    } finally {
      db.close();
    }
  });
});
