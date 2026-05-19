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
