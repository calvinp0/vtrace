/**
 * M146-B: repository relevance, and the readiness gate in front of it.
 *
 * The controls that matter most here are the negative ones. It is easy to build
 * a router that picks the right repository when everything is healthy; the
 * question M146-A leaves behind is what happens when one member's index was
 * produced by semantics this runtime has already refused. Such a member must
 * still be identifiable from the request and the filesystem, and must never be
 * allowed to answer for itself out of obsolete derived state.
 *
 * So the probe factory below records every member it is asked to open. A test
 * that merely asserts the right repository was chosen would pass even if the
 * stale one had been queried along the way; asserting on `probeRequests` is what
 * makes "the stale index was never consulted" a measured fact.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";

import { resolveIndexDbPath, resolveIndexMetaPath, type IndexMeta } from "../indexer/indexMeta";
import { initRepo } from "../setup/initRepo";
import { resolveWorkspaceConfigPath, type ResolvedWorkspaceConfig } from "./config";
import { evaluateWorkspaceReadiness } from "./readiness";
import { resolveWorkspaceRegistry, type RegisteredRepository, type WorkspaceRegistry } from "./registry";
import {
  createDatabaseProbe,
  nominateRepositories,
  RepositoryEvidenceKind,
  RepositoryRelevanceStatus,
  type RepositoryProbe,
  type RepositoryRelevanceRequest,
} from "./repositoryRelevance";
import {
  cleanupWorkspaceFixtures,
  cloneFixtureRepo,
  makeFixtureRepo,
  makeWorkspaceRoot,
  writeFixtureWorkspace,
} from "./workspaceFixture";

afterAll(cleanupWorkspaceFixtures);

async function indexedRepo(
  root: string,
  relative: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const repoRoot = await makeFixtureRepo(path.join(root, relative), { files });
  await initRepo({ repoPath: repoRoot });
  return repoRoot;
}

/**
 * Make a repository's index derivation-incompatible without touching its source,
 * exactly as upgrading VTRACE's indexer would. The repository stays healthy and
 * correctly registered; only its derived content is obsolete.
 */
async function breakDerivation(repoRoot: string): Promise<void> {
  const metaPath = resolveIndexMetaPath(repoRoot);
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as IndexMeta;
  meta.indexer_fingerprint = "0".repeat(64);
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

/** Undo `breakDerivation`, standing in for a completed rebuild. */
async function repairDerivation(repoRoot: string, original: string): Promise<void> {
  const metaPath = resolveIndexMetaPath(repoRoot);
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as IndexMeta;
  meta.indexer_fingerprint = original;
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

async function storedFingerprint(repoRoot: string): Promise<string> {
  const meta = JSON.parse(await readFile(resolveIndexMetaPath(repoRoot), "utf8")) as IndexMeta;
  return meta.indexer_fingerprint;
}

interface Harness {
  readonly registry: WorkspaceRegistry;
  readonly probeRequests: string[];
  readonly probe: (repository: RegisteredRepository) => RepositoryProbe | null;
  readonly close: () => void;
}

function harnessFor(registry: WorkspaceRegistry): Harness {
  const probeRequests: string[] = [];
  const open: Database[] = [];
  return {
    registry,
    probeRequests,
    probe: (repository: RegisteredRepository): RepositoryProbe | null => {
      probeRequests.push(repository.alias);
      try {
        const db = new Database(resolveIndexDbPath(repository.rootPath), { readonly: true });
        open.push(db);
        return createDatabaseProbe(db);
      } catch {
        return null;
      }
    },
    close: (): void => { for (const db of open) db.close(); },
  };
}

async function nominate(
  config: ResolvedWorkspaceConfig,
  request: Omit<RepositoryRelevanceRequest, "registry" | "readiness" | "probe">,
) {
  const registry = await resolveWorkspaceRegistry({ config });
  const readiness = await evaluateWorkspaceReadiness(registry);
  const harness = harnessFor(registry);
  try {
    const relevance = nominateRepositories({ ...request, registry, readiness, probe: harness.probe });
    return { relevance, probeRequests: [...harness.probeRequests], readiness };
  } finally {
    harness.close();
  }
}

// ---------------------------------------------------------------------------
// §12 — the mandatory mixed-readiness fixture
// ---------------------------------------------------------------------------

async function mixedReadinessWorkspace() {
  const root = await makeWorkspaceRoot("m146b-mixed-");
  const alpha = await indexedRepo(root, "alpha", {
    "src/dihedral.py": "def get_dihedral(a, b):\n    return 1\n",
  });
  const beta = await indexedRepo(root, "beta", {
    "tckdb/species.py": "class SpeciesRecord:\n    def store_species(self):\n        return 2\n",
  });
  const gamma = await indexedRepo(root, "gamma", {
    "src/gamma_only.py": "def gamma_only():\n    return 3\n",
  });
  const betaFingerprint = await storedFingerprint(beta);
  await breakDerivation(beta);

  const config = await writeFixtureWorkspace({
    configPath: resolveWorkspaceConfigPath(alpha),
    repos: [{ alias: "alpha", rootPath: alpha }, { alias: "beta", rootPath: beta }, { alias: "gamma", rootPath: gamma }],
    primaryRepoAlias: "alpha",
  });
  return { root, alpha, beta, gamma, config, betaFingerprint };
}

describe("M146-B mixed readiness (§12)", () => {
  test("readiness reports beta as derivation-incompatible, alpha and gamma ready", async () => {
    const { config } = await mixedReadinessWorkspace();
    const registry = await resolveWorkspaceRegistry({ config });
    const readiness = await evaluateWorkspaceReadiness(registry);

    const beta = readiness.repos.find((repo) => repo.alias === "beta")!;
    expect(beta.ready).toBe(false);
    expect(beta.index?.reason).toBe("derivation_changed");
    expect(readiness.repos.filter((repo) => repo.ready).map((repo) => repo.alias).sort()).toEqual(["alpha", "gamma"]);
  });

  test("case 1 — an explicit alpha request never touches beta", async () => {
    const { alpha, config } = await mixedReadinessWorkspace();

    const { relevance, probeRequests } = await nominate(config, { selector: { alias: "alpha" } });

    expect(relevance.status).toBe(RepositoryRelevanceStatus.Selected);
    expect(relevance.selected.map((repo) => repo.alias)).toEqual(["alpha"]);
    expect(relevance.diagnostics.decidingTier).toBe(RepositoryEvidenceKind.ExplicitRoute);
    // Explicit selection is answered from registration alone.
    expect(probeRequests).toEqual([]);
    expect(relevance.diagnostics.reposDeepProbed).toBe(0);
    expect(alpha.length).toBeGreaterThan(0);
  });

  test("case 2 — an exact beta path nominates beta and stops at readiness", async () => {
    const { beta, config } = await mixedReadinessWorkspace();

    const { relevance, probeRequests } = await nominate(config, {
      pathHints: [path.join(beta, "tckdb/species.py")],
    });

    // Identified without its index, which is the whole point of the index-free
    // tier: the right answer is "beta, once you repair it", not "no match".
    expect(relevance.status).toBe(RepositoryRelevanceStatus.NotReady);
    expect(relevance.candidates.map((repo) => repo.alias)).toEqual(["beta"]);
    expect(relevance.candidates[0]!.notReadyReason).toContain("derivation_changed");
    expect(relevance.diagnostics.decidingTier).toBe(RepositoryEvidenceKind.PathContainment);
    expect(probeRequests).not.toContain("beta");
  });

  test("case 3 — beta contributes no indexed evidence while incompatible", async () => {
    const { config } = await mixedReadinessWorkspace();

    // A symbol only beta defines. If the stale symbol table were consulted,
    // beta would win; the gate means nothing finds it.
    const { relevance, probeRequests } = await nominate(config, { symbolHints: ["SpeciesRecord"] });

    expect(relevance.status).toBe(RepositoryRelevanceStatus.NoMatch);
    expect(probeRequests).not.toContain("beta");
    expect(relevance.diagnostics.reposExcludedNotReady.map((entry) => entry.alias)).toEqual(["beta"]);
    expect(relevance.diagnostics.reposExcludedNotReady[0]!.reason).toContain("derivation_changed");
  });

  test("case 4 — after repair the same query uses beta's symbol evidence", async () => {
    const { beta, config, betaFingerprint } = await mixedReadinessWorkspace();

    const before = await nominate(config, { symbolHints: ["SpeciesRecord"] });
    expect(before.relevance.status).toBe(RepositoryRelevanceStatus.NoMatch);

    await repairDerivation(beta, betaFingerprint);
    const after = await nominate(config, { symbolHints: ["SpeciesRecord"] });

    expect(after.relevance.status).toBe(RepositoryRelevanceStatus.Selected);
    expect(after.relevance.selected.map((repo) => repo.alias)).toEqual(["beta"]);
    expect(after.relevance.diagnostics.decidingTier).toBe(RepositoryEvidenceKind.ExactSymbol);
    expect(after.probeRequests).toContain("beta");
  });

  test("a stale member never blocks a ready member's answer", async () => {
    const { config } = await mixedReadinessWorkspace();

    const { relevance } = await nominate(config, { symbolHints: ["gamma_only"] });

    expect(relevance.status).toBe(RepositoryRelevanceStatus.Selected);
    expect(relevance.selected.map((repo) => repo.alias)).toEqual(["gamma"]);
  });
});

// ---------------------------------------------------------------------------
// §65 — generic routing controls
// ---------------------------------------------------------------------------

async function genericWorkspace(order: readonly string[] = ["a", "b"]) {
  const root = await makeWorkspaceRoot("m146b-generic-");
  const repoA = await indexedRepo(root, "one", {
    "src/alpha_file.py": "def AlphaOnly():\n    return 1\n",
    "src/utils.py": "def parse():\n    return 'a'\n",
  });
  const repoB = await indexedRepo(root, "two", {
    "src/beta_file.py": "def BetaOnly():\n    return 2\n",
    "src/utils.py": "def parse():\n    return 'b'\n",
  });
  const byAlias: Record<string, string> = { a: repoA, b: repoB };
  const config = await writeFixtureWorkspace({
    configPath: resolveWorkspaceConfigPath(repoA),
    repos: order.map((alias) => ({ alias, rootPath: byAlias[alias]! })),
    primaryRepoAlias: order[0]!,
  });
  return { root, repoA, repoB, config };
}

describe("M146-B generic routing controls (§65)", () => {
  test("a unique absolute path selects its repository", async () => {
    const { repoB, config } = await genericWorkspace();

    const { relevance } = await nominate(config, { pathHints: [path.join(repoB, "src/beta_file.py")] });

    expect(relevance.status).toBe(RepositoryRelevanceStatus.Selected);
    expect(relevance.selected.map((repo) => repo.alias)).toEqual(["b"]);
  });

  test("a unique symbol selects its repository", async () => {
    const { config } = await genericWorkspace();

    const { relevance } = await nominate(config, { symbolHints: ["BetaOnly"] });

    expect(relevance.status).toBe(RepositoryRelevanceStatus.Selected);
    expect(relevance.selected.map((repo) => repo.alias)).toEqual(["b"]);
    expect(relevance.diagnostics.decidingTier).toBe(RepositoryEvidenceKind.ExactSymbol);
  });

  test("a symbol both repositories define is ambiguous, not a race", async () => {
    const { config } = await genericWorkspace();

    const { relevance } = await nominate(config, { symbolHints: ["parse"] });

    expect(relevance.status).toBe(RepositoryRelevanceStatus.Ambiguous);
    expect(relevance.selected).toEqual([]);
    expect(relevance.candidates.map((repo) => repo.alias)).toEqual(["a", "b"]);
  });

  test("a relative path both repositories index is ambiguous", async () => {
    const { config } = await genericWorkspace();

    const { relevance } = await nominate(config, { pathHints: ["src/utils.py"] });

    expect(relevance.status).toBe(RepositoryRelevanceStatus.Ambiguous);
    expect(relevance.diagnostics.decidingTier).toBe(RepositoryEvidenceKind.IndexedPath);
    expect(relevance.candidates.map((repo) => repo.alias)).toEqual(["a", "b"]);
  });

  test("explicit selection overrides evidence pointing elsewhere", async () => {
    const { repoB, config } = await genericWorkspace();

    const { relevance } = await nominate(config, {
      selector: { alias: "a" },
      pathHints: [path.join(repoB, "src/beta_file.py")],
      symbolHints: ["BetaOnly"],
    });

    expect(relevance.status).toBe(RepositoryRelevanceStatus.Selected);
    expect(relevance.selected.map((repo) => repo.alias)).toEqual(["a"]);
    expect(relevance.diagnostics.decidingTier).toBe(RepositoryEvidenceKind.ExplicitRoute);
  });

  test("no evidence means no match, never the least bad repository", async () => {
    const { config } = await genericWorkspace();

    const { relevance } = await nominate(config, { symbolHints: ["NothingDefinesThis"] });

    expect(relevance.status).toBe(RepositoryRelevanceStatus.NoMatch);
    expect(relevance.selected).toEqual([]);
    expect(relevance.diagnostics.decidingTier).toBeNull();
  });

  test("a repository display name in prose does not select it", async () => {
    // §20/§66: M135/M137 measured project-name bias. The alias is display
    // metadata, and prose is not a typed repository reference.
    const { config } = await genericWorkspace();

    const { relevance } = await nominate(config, { symbolHints: ["a"] });

    expect(relevance.status).not.toBe(RepositoryRelevanceStatus.Selected);
  });
});

// ---------------------------------------------------------------------------
// §67/§68 — invariance
// ---------------------------------------------------------------------------

describe("M146-B invariance", () => {
  test("registration order does not change any decision", async () => {
    const forward = await genericWorkspace(["a", "b"]);
    const reversed = await genericWorkspace(["b", "a"]);

    for (const request of [
      { symbolHints: ["BetaOnly"] },
      { symbolHints: ["parse"] },
      { symbolHints: ["NothingDefinesThis"] },
    ]) {
      const left = await nominate(forward.config, request);
      const right = await nominate(reversed.config, request);

      expect(right.relevance.status).toBe(left.relevance.status);
      expect(right.relevance.selected.map((repo) => repo.alias))
        .toEqual(left.relevance.selected.map((repo) => repo.alias));
      expect(right.relevance.candidates.map((repo) => repo.alias))
        .toEqual(left.relevance.candidates.map((repo) => repo.alias));
    }
  });

  test("adding an unrelated repository does not move a decisive answer", async () => {
    const root = await makeWorkspaceRoot("m146b-invariance-");
    const repoA = await indexedRepo(root, "one", { "src/alpha_file.py": "def AlphaOnly():\n    return 1\n" });
    const repoB = await indexedRepo(root, "two", { "src/beta_file.py": "def BetaOnly():\n    return 2\n" });
    const repoC = await indexedRepo(root, "three", { "src/unrelated.py": "def unrelated():\n    return 3\n" });

    const before = await writeFixtureWorkspace({
      configPath: path.join(root, "before.workspace.json"),
      repos: [{ alias: "a", rootPath: repoA }, { alias: "b", rootPath: repoB }],
      primaryRepoAlias: "a",
    });
    const after = await writeFixtureWorkspace({
      configPath: path.join(root, "after.workspace.json"),
      repos: [{ alias: "a", rootPath: repoA }, { alias: "b", rootPath: repoB }, { alias: "c", rootPath: repoC }],
      primaryRepoAlias: "a",
    });

    const left = await nominate(before, { symbolHints: ["BetaOnly"] });
    const right = await nominate(after, { symbolHints: ["BetaOnly"] });

    expect(right.relevance.status).toBe(left.relevance.status);
    expect(right.relevance.selected.map((repo) => repo.alias))
      .toEqual(left.relevance.selected.map((repo) => repo.alias));
  });

  test("independent clones with identical content stay ambiguous", async () => {
    // §69: same content, same HEAD, distinct M145 identities. Nothing in the
    // query separates them, so neither may be chosen by path order.
    const root = await makeWorkspaceRoot("m146b-clone-");
    const origin = await makeFixtureRepo(path.join(root, "origin"), {
      files: { "src/shared.py": "def clone_symbol():\n    return 1\n" },
    });
    const cloneA = await cloneFixtureRepo(origin, path.join(root, "clone-a"));
    const cloneB = await cloneFixtureRepo(origin, path.join(root, "clone-b"));
    await initRepo({ repoPath: cloneA });
    await initRepo({ repoPath: cloneB });

    const config = await writeFixtureWorkspace({
      configPath: path.join(root, "clones.workspace.json"),
      repos: [{ alias: "clone-a", rootPath: cloneA }, { alias: "clone-b", rootPath: cloneB }],
      primaryRepoAlias: "clone-a",
    });

    const { relevance } = await nominate(config, { symbolHints: ["clone_symbol"] });

    expect(relevance.status).toBe(RepositoryRelevanceStatus.Ambiguous);
    expect(relevance.candidates.map((repo) => repo.alias)).toEqual(["clone-a", "clone-b"]);
    // Distinct identities is M145's guarantee; ambiguity here is M146-B's.
    const ids = relevance.candidates.map((repo) => repo.worktreeId);
    expect(new Set(ids).size).toBe(2);
  });

  test("collisions keep their repository provenance", async () => {
    const { relevance } = await nominate((await genericWorkspace()).config, { pathHints: ["src/utils.py"] });

    // §40/§54: the same relative path in both repositories stays two facts.
    expect(relevance.candidates).toHaveLength(2);
    const worktreeIds = relevance.candidates.map((repo) => repo.worktreeId);
    expect(new Set(worktreeIds).size).toBe(2);
    const repositoryIds = relevance.candidates.map((repo) => repo.repositoryId);
    expect(new Set(repositoryIds).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §25/§26 — bounded fan-out
// ---------------------------------------------------------------------------

describe("M146-B fan-out bounds", () => {
  test("a decisive path answers a large workspace without opening any index", async () => {
    const root = await makeWorkspaceRoot("m146b-scale-");
    const target = await indexedRepo(root, "target", { "src/target.py": "def target():\n    return 1\n" });

    const repos = [{ alias: "target", rootPath: target }];
    for (let index = 0; index < 100; index += 1) {
      // Descriptors only: routing must not need them indexed, or workspace size
      // would set query cost.
      repos.push({ alias: `filler-${index}`, rootPath: await makeFixtureRepo(path.join(root, `filler-${index}`)) });
    }

    const config = await writeFixtureWorkspace({
      configPath: path.join(root, "scale.workspace.json"),
      repos,
      primaryRepoAlias: "target",
    });

    const started = performance.now();
    const { relevance, probeRequests } = await nominate(config, { pathHints: [path.join(target, "src/target.py")] });
    const elapsedMs = performance.now() - started;

    expect(relevance.status).toBe(RepositoryRelevanceStatus.Selected);
    expect(relevance.selected.map((repo) => repo.alias)).toEqual(["target"]);
    expect(probeRequests).toEqual([]);
    expect(relevance.diagnostics.reposRegistered).toBe(101);
    expect(relevance.diagnostics.reposDeepProbed).toBe(0);
    expect(elapsedMs).toBeLessThan(20_000);
  });

  test("deep probes stay under the configured bound", async () => {
    const root = await makeWorkspaceRoot("m146b-bound-");
    const repos = [];
    for (let index = 0; index < 6; index += 1) {
      repos.push({
        alias: `repo-${index}`,
        rootPath: await indexedRepo(root, `repo-${index}`, { [`src/file${index}.py`]: `def shared():\n    return ${index}\n` }),
      });
    }
    const config = await writeFixtureWorkspace({
      configPath: path.join(root, "bound.workspace.json"),
      repos,
      primaryRepoAlias: "repo-0",
    });

    const { relevance, probeRequests } = await nominate(config, { symbolHints: ["shared"], limits: { maxDeepProbes: 2 } });

    expect(probeRequests.length).toBeLessThanOrEqual(2);
    expect(relevance.diagnostics.reposDeepProbed).toBeLessThanOrEqual(2);
  });

  test("ambiguous candidate reporting is bounded", async () => {
    const root = await makeWorkspaceRoot("m146b-report-");
    const repos = [];
    for (let index = 0; index < 5; index += 1) {
      repos.push({
        alias: `repo-${index}`,
        rootPath: await indexedRepo(root, `repo-${index}`, { [`src/file${index}.py`]: "def shared():\n    return 1\n" }),
      });
    }
    const config = await writeFixtureWorkspace({
      configPath: path.join(root, "report.workspace.json"),
      repos,
      primaryRepoAlias: "repo-0",
    });

    const { relevance } = await nominate(config, {
      symbolHints: ["shared"],
      limits: { maxReportedCandidates: 2 },
    });

    expect(relevance.status).toBe(RepositoryRelevanceStatus.Ambiguous);
    expect(relevance.candidates).toHaveLength(2);
    expect(relevance.diagnostics.candidatesOmitted).toBe(3);
  });
});
