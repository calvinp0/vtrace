/**
 * M156 §21-§24: what a degraded index is allowed to say about ABSENCE.
 *
 * The positive case is easy and not the point. If a repository defines `Foo`,
 * an unparsed file elsewhere cannot retract that — a hit is self-supporting.
 * The claim under test is the negative one: when a repository does NOT define
 * the name and one of its source files could not be parsed, the miss stops
 * being a proof of absence, because the file we failed on could be the file
 * that defines it.
 *
 * Equally load-bearing is the case that must NOT weaken (§24). A failed YAML
 * document cannot define a Python symbol, so absence over symbols stays
 * authoritative. Weakening every claim whenever anything anywhere failed would
 * be safe-looking and useless, and would make the whole mechanism something
 * callers learn to ignore.
 */
import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { Database } from "bun:sqlite";

import { resolveIndexDbPath } from "../indexer/indexMeta";
import { initRepo } from "../setup/initRepo";
import { evaluateIndexReadiness, withRuntimeSignals } from "../indexer/indexReadiness";
import { resolveWorkspaceConfigPath } from "./config";
import { evaluateWorkspaceReadiness } from "./readiness";
import { resolveWorkspaceRegistry, type RegisteredRepository } from "./registry";
import {
  createDatabaseProbe,
  nominateRepositories,
  RepositoryRelevanceStatus,
  type RepositoryProbe,
} from "./repositoryRelevance";
import { PresenceUnknownReason, UniquenessProofStatus } from "./repositoryPresence";
import {
  cleanupWorkspaceFixtures,
  makeFixtureRepo,
  makeWorkspaceRoot,
  writeFixtureWorkspace,
} from "./workspaceFixture";

afterAll(cleanupWorkspaceFixtures);

const BROKEN_PYTHON = "def broken(:\n    return 1\n";

async function indexedRepo(
  root: string,
  relative: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const repoRoot = await makeFixtureRepo(path.join(root, relative), { files });
  await initRepo({ repoPath: repoRoot });
  return repoRoot;
}

function probeFactory(open: Database[]): (repository: RegisteredRepository) => RepositoryProbe | null {
  return (repository: RegisteredRepository): RepositoryProbe | null => {
    try {
      const db = new Database(resolveIndexDbPath(repository.rootPath), { readonly: true });
      open.push(db);
      return createDatabaseProbe(db);
    } catch {
      return null;
    }
  };
}

describe("M156 degraded coverage and absence", () => {
  test("a repository with a failed source file still indexes and is usable", async () => {
    const root = await makeWorkspaceRoot("m156-usable");
    const repoRoot = await indexedRepo(root, "app", {
      "src/solver.py": "def solve():\n    return 1\n",
      "src/fixture_bad.py": BROKEN_PYTHON,
    });

    const readiness = await evaluateIndexReadiness(repoRoot, { probe: "full" });

    // Usable AND degraded are both true at once. That pairing is the whole
    // milestone: `ready` must not be dragged down by a coverage gap (§18, §25).
    expect(readiness.ready).toBe(true);
    expect(readiness.coverage.probed).toBe(true);
    expect(readiness.coverage.complete).toBe(false);
    expect(readiness.coverage.failedFiles).toBe(1);
    expect(readiness.coverage.failedLanguages).toEqual(["python"]);
  });

  test("a repository where every file fails is not served as merely degraded", async () => {
    // The boundary of the milestone. Containment says one bad file must not cost
    // the repository; it does not say a repository with NO indexable evidence is
    // usable. `indexed_files_present` still fails, so this reports as an index
    // with nothing in it rather than as a degraded index worth querying.
    const root = await makeWorkspaceRoot("m156-all-failed");
    const repoRoot = await indexedRepo(root, "app", {
      "src/one.py": BROKEN_PYTHON,
      "src/two.py": BROKEN_PYTHON,
    });

    const readiness = await evaluateIndexReadiness(repoRoot, { probe: "full" });

    expect(readiness.coverage.failedFiles).toBe(2);
    expect(readiness.coverage.complete).toBe(false);

    // The raw evaluation answers only "can this index be read and does it match
    // the source", and both are true — the index is well-formed and current, it
    // simply contains nothing. Emptiness is a REQUEST-TIME signal in M141's
    // decomposition, applied by every consumer through `withRuntimeSignals`, and
    // that is the layer that withdraws the index.
    expect(readiness.ready).toBe(true);
    const withEmptiness = withRuntimeSignals(readiness, { indexHasNoFiles: true });
    expect(withEmptiness.ready).toBe(false);
    expect(withEmptiness.state).toBe("index_missing");
    // Coverage survives the downgrade: the reason there is nothing to serve is
    // still that two files failed, and that must not be erased by the refusal.
    expect(withEmptiness.coverage.failedFiles).toBe(2);
  });

  test("a clean repository is never marked degraded", async () => {
    const root = await makeWorkspaceRoot("m156-clean");
    const repoRoot = await indexedRepo(root, "app", {
      "src/solver.py": "def solve():\n    return 1\n",
    });

    const readiness = await evaluateIndexReadiness(repoRoot, { probe: "full" });

    expect(readiness.ready).toBe(true);
    expect(readiness.coverage.complete).toBe(true);
    expect(readiness.coverage.failedFiles).toBe(0);
  });

  test("a failed code file weakens exact-symbol absence to unknown", async () => {
    const root = await makeWorkspaceRoot("m156-weakened");
    const repoRoot = await indexedRepo(root, "degraded", {
      "src/solver.py": "def solve():\n    return 1\n",
      "src/fixture_bad.py": BROKEN_PYTHON,
    });
    const config = await writeFixtureWorkspace({
      configPath: resolveWorkspaceConfigPath(root),
      repos: [{ alias: "degraded", rootPath: repoRoot }],
    });

    const registry = await resolveWorkspaceRegistry({ config });
    const readiness = await evaluateWorkspaceReadiness(registry);
    const open: Database[] = [];
    try {
      const relevance = nominateRepositories({
        registry,
        readiness,
        probe: probeFactory(open),
        symbolHints: ["TotallyAbsentSymbol"],
      });

      // The one member answered, and answered honestly: it does not define the
      // name in what it indexed, and it cannot speak for what it did not.
      expect(relevance.status).toBe(RepositoryRelevanceStatus.NoMatch);
      const proof = relevance.diagnostics?.presenceProof;
      expect(proof?.status).toBe(UniquenessProofStatus.Unproven);
      expect(proof?.unknown?.[0]?.reason).toBe(PresenceUnknownReason.CoverageIncomplete);
    } finally {
      for (const db of open) db.close();
    }
  });

  test("a failed DOCUMENT file does not weaken absence over symbols", async () => {
    // §24. A YAML file that failed to index is a real coverage gap for document
    // retrieval and no gap at all for "does this repository define `Foo`".
    const root = await makeWorkspaceRoot("m156-irrelevant-gap");
    const repoRoot = await indexedRepo(root, "app", {
      "src/solver.py": "def solve():\n    return 1\n",
    });

    const db = new Database(resolveIndexDbPath(repoRoot));
    try {
      db.run(
        "INSERT INTO file_index_failures (path, language, status, failure_class, message, content_hash, size_bytes) "
        + "VALUES ('config/bad.yaml', 'yaml', 'parse_failed', 'SYNTAX_ERROR', 'bad yaml', 'abc', 12)",
      );
    } finally {
      db.close();
    }

    const readOnly = new Database(resolveIndexDbPath(repoRoot), { readonly: true });
    try {
      const coverage = createDatabaseProbe(readOnly).semanticCoverage?.();
      expect(coverage?.failedFiles).toBe(1);
      // The gap is recorded, but it cannot hide a symbol.
      expect(coverage?.failedFilesCouldDefineSymbols).toBe(false);
    } finally {
      readOnly.close();
    }
  });

  test("a query answered elsewhere in a degraded repository still works normally", async () => {
    // §24: the unrelated failure must not poison a question the index can answer.
    const root = await makeWorkspaceRoot("m156-elsewhere");
    const repoRoot = await indexedRepo(root, "degraded", {
      "src/solver.py": "def solve_it():\n    return 1\n",
      "src/fixture_bad.py": BROKEN_PYTHON,
    });
    const config = await writeFixtureWorkspace({
      configPath: resolveWorkspaceConfigPath(root),
      repos: [{ alias: "degraded", rootPath: repoRoot }],
    });

    const registry = await resolveWorkspaceRegistry({ config });
    const readiness = await evaluateWorkspaceReadiness(registry);
    const open: Database[] = [];
    try {
      const relevance = nominateRepositories({
        registry,
        readiness,
        probe: probeFactory(open),
        symbolHints: ["solve_it"],
      });

      // A hit is self-supporting: the failed file cannot retract it.
      expect(relevance.status).toBe(RepositoryRelevanceStatus.Selected);
      expect(relevance.selected.map((nominee) => nominee.alias)).toEqual(["degraded"]);
    } finally {
      for (const db of open) db.close();
    }
  });
});
