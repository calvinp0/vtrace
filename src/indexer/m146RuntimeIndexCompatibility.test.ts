/**
 * M146-A. Runtime ↔ index derivation compatibility.
 *
 * Readiness has always separated identity ("is this the same repository?") from
 * source freshness ("does the index describe the current contents?"). M146-A
 * adds the third question those two cannot answer between them: was this index
 * produced by semantics the CURRENT runtime still agrees with?
 *
 * The fixtures below drive that question from both directions. A change to code
 * that decides what gets indexed must refuse the stored index; a change to code
 * that only decides how results are ranked must not, because invalidating on
 * every VTRACE edit would rebuild the world for nothing.
 *
 * Each fixture mutates REAL source and restores it, rather than asserting
 * against a hand-written fingerprint. A test that stubbed the fingerprints could
 * not have caught what M146-A actually found: the FTS tokenizer sat in a
 * directory excluded from every fingerprint, so changing it altered stored index
 * content while readiness still reported `ready: true`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { initRepo } from "../setup/initRepo";
import { evaluateIndexReadiness, type IndexReadiness } from "./indexReadiness";

const execFile = promisify(execFileCallback);
const VTRACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const FIXTURE_SOURCE = `class HttpRequestParser:
    def parseJsonBody(self):
        return 1


def computeTotalPrice(itemList):
    return 2
`;

async function makeIndexedRepo(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `m146-${label}-`));
  roots.push(root);
  await writeFile(path.join(root, "sample.py"), FIXTURE_SOURCE);
  await writeFile(path.join(root, "config.yaml"), "service:\n  name: sample\n");
  await execFile("git", ["init", "-q", root]);
  await execFile("git", ["-C", root, "add", "-A"]);
  await execFile("git", [
    "-C", root, "-c", "user.email=m146@test", "-c", "user.name=m146", "commit", "-qm", "init",
  ]);
  await initRepo({ repoPath: root });
  return root;
}

/**
 * Append a real, compiling declaration so the file's CONTENT hash moves — the
 * fingerprints hash content, so a no-op edit would prove nothing.
 */
async function withMutatedSource<T>(relativePath: string, run: () => Promise<T>): Promise<T> {
  const absolute = path.join(VTRACE_ROOT, relativePath);
  const original = await readFile(absolute, "utf8");
  try {
    await writeFile(absolute, `${original}\nexport const __m146Probe = "${relativePath}";\n`);
    return await run();
  } finally {
    await writeFile(absolute, original);
  }
}

/** Readiness of `root` as computed by a runtime that has the mutation applied. */
async function readinessUnder(root: string, relativePath: string): Promise<IndexReadiness> {
  return withMutatedSource(relativePath, () => evaluateIndexReadiness(root, { probe: "full" }));
}

describe("M146-A fixture 1 — query-only runtime change reuses the index", () => {
  // The whole point of a semantic invalidation contract: ranking moves constantly
  // and must stay free. `searchSymbolsShared` is the sharpest possible control —
  // it is where the FTS tokenizer used to live, and is now provably query-only.
  for (const queryOnlyFile of [
    "src/retrieval/searchSymbolsShared.ts",
    "src/capsuleV2/buildCapsuleV2.ts",
    "src/capsuleV2/budgetAllocator.ts",
  ]) {
    test(`${queryOnlyFile} does not invalidate a stored index`, async () => {
      const root = await makeIndexedRepo("query-only");
      expect((await evaluateIndexReadiness(root, { probe: "full" })).ready).toBe(true);

      const readiness = await readinessUnder(root, queryOnlyFile);

      expect(readiness.ready).toBe(true);
      expect(readiness.state).toBe("ready");
      expect(readiness.schemaCompatible).toBe(true);
      expect(readiness.sourceFresh).toBe(true);
    });
  }
});

describe("M146-A fixtures 2-5 — semantic changes refuse the stored index", () => {
  const semanticChanges = [
    // Fixture 2: parser semantics — what symbols exist at all.
    { file: "src/parsers/pythonParser.ts", label: "parser semantics" },
    // Fixture 3: graph resolution — M140's archetype, where the same source
    // produced different edge ownership under old and new runtimes.
    { file: "src/parsers/moduleSymbol.ts", label: "module ownership" },
    { file: "src/indexer/normalizedGraph.ts", label: "graph construction" },
    // Fixture 4: document indexing semantics.
    { file: "src/documents/documentChunks.ts", label: "document chunking" },
    // Fixture 5: persisted schema — the representation control.
    { file: "src/db/schema.ts", label: "stored schema" },
    // The M146-A defect itself: stored FTS text derivation.
    { file: "src/indexer/searchTextDerivation.ts", label: "FTS text derivation" },
    // Stored identity derivation: file ids, symbol ids, FQNs.
    { file: "src/domain/types.ts", label: "stored identity derivation" },
  ] as const;

  for (const { file, label } of semanticChanges) {
    test(`${label} (${file}) refuses the stored index`, async () => {
      const root = await makeIndexedRepo("semantic");
      expect((await evaluateIndexReadiness(root, { probe: "full" })).ready).toBe(true);

      const readiness = await readinessUnder(root, file);

      // Fail closed is the requirement; which dimension reports it is a
      // separate (and deliberately truthful) question asserted below.
      expect(readiness.ready).toBe(false);
      expect(readiness.recommendedAction).not.toBe("none");
      // Identity is untouched by a runtime change and must not be blamed.
      expect(readiness.repositoryCompatible).toBe(true);
      expect(readiness.worktreeCompatible).toBe(true);
    });
  }

  test("a schema change is reported as a schema change", async () => {
    const root = await makeIndexedRepo("schema-reason");
    const readiness = await readinessUnder(root, "src/db/schema.ts");

    expect(readiness.state).toBe("schema_incompatible");
    expect(readiness.reason).toBe("schema_changed");
  });

  test("an indexer-semantics change is NOT reported as a schema change", async () => {
    // M145 saw an indexer edit surface as `schema_incompatible` with no schema
    // version having moved. The state is fair — the index cannot be consumed —
    // but `index_status` renders the REASON to the user, and telling someone the
    // database schema changed when a parser was edited sends them somewhere else.
    const root = await makeIndexedRepo("derivation-reason");
    const readiness = await readinessUnder(root, "src/indexer/searchTextDerivation.ts");

    expect(readiness.reason).toBe("derivation_changed");
    expect(readiness.recommendedAction).toBe("full_rebuild");
  });
});

describe("M146-A fixture 6 — a source edit is staleness, not incompatibility", () => {
  test("editing a repository file leaves derivation compatible", async () => {
    const root = await makeIndexedRepo("source-only");
    await writeFile(path.join(root, "sample.py"), `${FIXTURE_SOURCE}\n\ndef addedLater():\n    return 3\n`);

    const readiness = await evaluateIndexReadiness(root, { probe: "full" });

    expect(readiness.ready).toBe(false);
    expect(readiness.sourceFresh).toBe(false);
    // The distinction that matters: this is the one class an incremental
    // planner can resolve, so it must never be reported as needing a rebuild.
    expect(readiness.schemaCompatible).toBe(true);
    expect(readiness.state).toBe("source_stale");
    expect(readiness.recommendedAction).toBe("incremental_refresh");
  });
});

describe("M146-A fixture 7 — identity failure is not masked by derivation checks", () => {
  test("replacing the repository at the same path fails on identity", async () => {
    const root = await makeIndexedRepo("replaced");

    // M145's scenario: same path, unrelated checkout. Path-derived ids alone
    // cannot see this, which is why instance evidence exists.
    await rm(path.join(root, ".git"), { recursive: true, force: true });
    await writeFile(path.join(root, "sample.py"), "def unrelated():\n    return 0\n");
    await execFile("git", ["init", "-q", root]);
    await execFile("git", ["-C", root, "add", "-A"]);
    await execFile("git", [
      "-C", root, "-c", "user.email=other@test", "-c", "user.name=other", "commit", "-qm", "other",
    ]);

    const readiness = await evaluateIndexReadiness(root, { probe: "full" });

    expect(readiness.ready).toBe(false);
    expect(readiness.repositoryCompatible || readiness.worktreeCompatible).toBe(false);
    // Identity outranks the weaker causes: a replaced checkout must not be
    // reported as merely stale source.
    expect(["repository_mismatch", "worktree_mismatch"]).toContain(readiness.state);
  });
});

describe("M146-A fixture 8 — unchanged runtime and source stays ready", () => {
  test("re-evaluating an untouched index needs no rebuild", async () => {
    const root = await makeIndexedRepo("stable");

    const first = await evaluateIndexReadiness(root, { probe: "full" });
    const second = await evaluateIndexReadiness(root, { probe: "full" });

    for (const readiness of [first, second]) {
      expect(readiness.ready).toBe(true);
      expect(readiness.state).toBe("ready");
      expect(readiness.sourceFresh).toBe(true);
      expect(readiness.schemaCompatible).toBe(true);
      expect(readiness.repositoryCompatible).toBe(true);
      expect(readiness.worktreeCompatible).toBe(true);
      expect(readiness.recommendedAction).toBe("none");
    }
  });
});

/**
 * The real workflow: update VTRACE, reconnect the MCP server, ask about an index
 * built by the previous runtime. A reconnect must not make an index fresh — the
 * NEW process has to prove the stored index is compatible.
 *
 * These spawn a subprocess so the mutated source is genuinely loaded, which
 * in-process mutation cannot do once a module has been imported.
 */
async function readinessInFreshProcess(root: string): Promise<{ ready: boolean; state: string; reason: string }> {
  const script = `
    import { evaluateIndexReadiness } from ${JSON.stringify(path.join(VTRACE_ROOT, "src/indexer/indexReadiness.ts"))};
    const r = await evaluateIndexReadiness(${JSON.stringify(root)}, { probe: "full" });
    console.log(JSON.stringify({ ready: r.ready, state: r.state, reason: r.reason }));
  `;
  const { stdout } = await execFile("bun", ["-e", script], { cwd: VTRACE_ROOT });
  return JSON.parse(stdout.trim().split("\n").pop()!);
}

describe("M146-A MCP reconnect acceptance", () => {
  test("a reconnected runtime refuses an index built under different derivation semantics", async () => {
    const root = await makeIndexedRepo("reconnect-stale");
    expect((await readinessInFreshProcess(root)).ready).toBe(true);

    const afterUpgrade = await withMutatedSource(
      "src/indexer/searchTextDerivation.ts",
      () => readinessInFreshProcess(root),
    );

    expect(afterUpgrade.ready).toBe(false);
    expect(afterUpgrade.reason).toBe("derivation_changed");
  });

  test("a reconnected runtime keeps an index whose only change was query-time", async () => {
    // The mandatory product control from the opposite direction: upgrading
    // VTRACE must not cost a reindex when nothing about derivation moved.
    const root = await makeIndexedRepo("reconnect-fresh");

    const afterUpgrade = await withMutatedSource(
      "src/retrieval/searchSymbolsShared.ts",
      () => readinessInFreshProcess(root),
    );

    expect(afterUpgrade.ready).toBe(true);
    expect(afterUpgrade.state).toBe("ready");
  });
});
