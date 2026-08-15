/**
 * M148-B — indexed-path uniqueness over the COMPLETE eligible population.
 *
 * M147 corrected the exact-symbol lane: a uniqueness claim is a statement about
 * every repository that could have owned the evidence, so a member whose index
 * this runtime refused is UNKNOWN and one unknown withholds the claim. The
 * indexed-path lane kept the older rule — filter to the ready members, then
 * report the single match as the owner — which is the same error in a different
 * lane. Measured before the fix, on the fixture below with `b` refused:
 *
 *   status  selected      selected: ["a"]
 *   reason  a selected on indexed_path evidence.
 *
 * while `b` really did index `shared/pipeline.py`. The router asserted a global
 * negative about a repository it never asked.
 *
 * Every control here therefore asserts TWO things: the verdict, and which
 * indexes were opened. A test that only checked the verdict would pass just as
 * well if the refused member's stale path table had been read to produce it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveIndexDbPath, resolveIndexMetaPath, type IndexMeta } from "../indexer/indexMeta";
import { initRepo } from "../setup/initRepo";
import { resolveWorkspaceConfigPath, type ResolvedWorkspaceConfig } from "./config";
import { evaluateWorkspaceReadiness } from "./readiness";
import { resolveWorkspaceRegistry, type RegisteredRepository } from "./registry";
import { UniquenessProofStatus } from "./repositoryPresence";
import {
  createDatabaseProbe,
  nominateRepositories,
  RepositoryEvidenceKind,
  RepositoryRelevanceStatus,
  type RepositoryProbe,
  type RepositoryRelevanceRequest,
} from "./repositoryRelevance";
import { assembleWorkspaceProductContext } from "./workspaceProductContext";
import {
  cleanupWorkspaceFixtures,
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

/** Refuse a member's derivation without touching its source, as an upgrade would. */
async function breakDerivation(repoRoot: string): Promise<string> {
  const metaPath = resolveIndexMetaPath(repoRoot);
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as IndexMeta;
  const original = meta.indexer_fingerprint;
  meta.indexer_fingerprint = "0".repeat(64);
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return original;
}

async function repairDerivation(repoRoot: string, original: string): Promise<void> {
  const metaPath = resolveIndexMetaPath(repoRoot);
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as IndexMeta;
  meta.indexer_fingerprint = original;
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

async function nominate(
  config: ResolvedWorkspaceConfig,
  request: Omit<RepositoryRelevanceRequest, "registry" | "readiness" | "probe">,
) {
  const registry = await resolveWorkspaceRegistry({ config });
  const readiness = await evaluateWorkspaceReadiness(registry);
  const indexesOpened: string[] = [];
  const open: Database[] = [];
  const probe = (repository: RegisteredRepository): RepositoryProbe | null => {
    indexesOpened.push(repository.alias);
    try {
      const db = new Database(resolveIndexDbPath(repository.rootPath), { readonly: true });
      open.push(db);
      return createDatabaseProbe(db);
    } catch {
      return null;
    }
  };
  try {
    const relevance = nominateRepositories({ ...request, registry, readiness, probe });
    return { relevance, indexesOpened, registry, readiness, probe };
  } finally {
    for (const db of open) db.close();
  }
}

/**
 * Three repositories that make every ownership shape expressible with one build:
 *
 *   a  owns `src/a_only.py`, shares `shared/pipeline.py`
 *   b  owns `src/b_only.py`, shares `shared/pipeline.py`   <- the breakable one
 *   c  owns nothing the others do
 *
 * Built once and cached: the cases only ASK questions, and `b`'s derivation is
 * toggled through the meta file rather than by rebuilding an index (M146 closure
 * measured what per-case index builds cost the suite).
 */
let workspaceCache: Promise<Awaited<ReturnType<typeof buildWorkspace>>> | null = null;

async function buildWorkspace(order: readonly string[] = ["a", "b", "c"]) {
  const root = await makeWorkspaceRoot("m148b-");
  const roots: Record<string, string> = {
    a: await indexedRepo(root, "a", {
      "shared/pipeline.py": "def run_a():\n    return 1\n",
      "src/a_only.py": "def a_only():\n    return 1\n",
    }),
    b: await indexedRepo(root, "b", {
      "shared/pipeline.py": "def run_b():\n    return 2\n",
      "src/b_only.py": "def b_only():\n    return 2\n",
    }),
    c: await indexedRepo(root, "c", {
      "src/c_only.py": "def c_only():\n    return 3\n",
    }),
  };
  const config = await writeFixtureWorkspace({
    configPath: resolveWorkspaceConfigPath(roots.a!),
    repos: order.map((alias) => ({ alias, rootPath: roots[alias]! })),
    primaryRepoAlias: order[0]!,
  });
  return { root, roots, config };
}

function workspace() {
  workspaceCache ??= buildWorkspace();
  return workspaceCache;
}

/** Run `body` with `alias` refused, restoring it afterwards whatever happens. */
async function withRefused<T>(
  roots: Record<string, string>,
  alias: string,
  body: () => Promise<T>,
): Promise<T> {
  const original = await breakDerivation(roots[alias]!);
  try {
    return await body();
  } finally {
    await repairDerivation(roots[alias]!, original);
  }
}

// ---------------------------------------------------------------------------
// §51 — the generic B controls
// ---------------------------------------------------------------------------

describe("M148-B indexed-path proof controls (§51)", () => {
  test("B1 — a unique path with every member ready selects its owner", async () => {
    const { config } = await workspace();

    const { relevance, indexesOpened } = await nominate(config, { pathHints: ["src/a_only.py"] });

    expect(relevance.status).toBe(RepositoryRelevanceStatus.Selected);
    expect(relevance.selected.map((repo) => repo.alias)).toEqual(["a"]);
    expect(relevance.diagnostics.decidingTier).toBe(RepositoryEvidenceKind.IndexedPath);
    const proof = relevance.diagnostics.indexedPathProof!;
    expect(proof.status).toBe(UniquenessProofStatus.Unique);
    expect(proof.owner).toBe("a");
    expect(proof.definitelyAbsent).toBe(2);
    expect(proof.unknown).toEqual([]);
    // Uniqueness required asking everyone — that is what makes it a proof.
    expect([...indexesOpened].sort()).toEqual(["a", "b", "c"]);
  }, 60_000);

  test("B2 — a path two ready members index is ambiguous", async () => {
    const { config } = await workspace();

    const { relevance } = await nominate(config, { pathHints: ["shared/pipeline.py"] });

    expect(relevance.status).toBe(RepositoryRelevanceStatus.Ambiguous);
    expect(relevance.selected).toEqual([]);
    expect(relevance.candidates.map((repo) => repo.alias)).toEqual(["a", "b"]);
    expect(relevance.diagnostics.indexedPathProof!.status).toBe(UniquenessProofStatus.Ambiguous);
  }, 60_000);

  test("B3 — a ready owner plus a refused member is UNPROVEN, not unique", async () => {
    // The M148-B correction. Pre-fix this reported `selected(a)`.
    const { config, roots } = await workspace();

    const { relevance, indexesOpened } = await withRefused(roots, "b", () =>
      nominate(config, { pathHints: ["src/a_only.py"] }));

    expect(relevance.status).toBe(RepositoryRelevanceStatus.Ambiguous);
    expect(relevance.selected).toEqual([]);
    expect(relevance.reason).toContain("b (index_refused)");
    expect(relevance.reason).toContain("indexes this path");
    const proof = relevance.diagnostics.indexedPathProof!;
    expect(proof.status).toBe(UniquenessProofStatus.Unproven);
    expect(proof.present).toEqual(["a"]);
    expect(proof.unknown.map((entry) => entry.alias)).toEqual(["b"]);
    // UNKNOWN is reached WITHOUT reading the refused index. Being unknown is
    // exactly what stops us asking it.
    expect(indexesOpened).not.toContain("b");
  }, 60_000);

  test("B4 — every ready member absent plus a refused member is not a no-owner claim", async () => {
    const { config, roots } = await workspace();

    // `src/b_only.py` exists only in the member that cannot answer.
    const { relevance, indexesOpened } = await withRefused(roots, "b", () =>
      nominate(config, { pathHints: ["src/b_only.py"] }));

    expect(relevance.selected).toEqual([]);
    expect(relevance.reason).toContain("could not be checked");
    expect(relevance.reason).not.toContain("No repository carries evidence");
    const proof = relevance.diagnostics.indexedPathProof!;
    expect(proof.status).toBe(UniquenessProofStatus.Unproven);
    expect(proof.present).toEqual([]);
    expect(proof.unknown.map((entry) => entry.alias)).toEqual(["b"]);
    expect(indexesOpened).not.toContain("b");
  }, 60_000);

  test("B5 — every member ready and absent is a genuine no-match", async () => {
    const { config } = await workspace();

    const { relevance } = await nominate(config, { pathHints: ["src/nothing_indexes_this.py"] });

    expect(relevance.status).toBe(RepositoryRelevanceStatus.NoMatch);
    expect(relevance.reason).toBe("No repository carries evidence for this request.");
    // Negative proof, not silence: every member was asked and answered.
    const proof = relevance.diagnostics.indexedPathProof!;
    expect(proof.status).toBe(UniquenessProofStatus.Absent);
    expect(proof.definitelyAbsent).toBe(3);
    expect(proof.unknown).toEqual([]);
  }, 60_000);

  test("B6 — repairing the unknown member to ABSENT completes the proof", async () => {
    const { config, roots } = await workspace();

    const before = await withRefused(roots, "b", () => nominate(config, { pathHints: ["src/a_only.py"] }));
    const after = await nominate(config, { pathHints: ["src/a_only.py"] });

    expect(before.relevance.status).toBe(RepositoryRelevanceStatus.Ambiguous);
    expect(after.relevance.status).toBe(RepositoryRelevanceStatus.Selected);
    expect(after.relevance.selected.map((repo) => repo.alias)).toEqual(["a"]);
    // Readiness changed what could be PROVEN, not merely what could be run.
    expect(after.relevance.diagnostics.indexedPathProof!.status).toBe(UniquenessProofStatus.Unique);
  }, 60_000);

  test("B7 — repairing the unknown member to PRESENT yields ambiguity", async () => {
    const { config, roots } = await workspace();

    const before = await withRefused(roots, "b", () =>
      nominate(config, { pathHints: ["shared/pipeline.py"] }));
    const after = await nominate(config, { pathHints: ["shared/pipeline.py"] });

    // Same query, two different truths, both honest about what was known.
    expect(before.relevance.diagnostics.indexedPathProof!.status).toBe(UniquenessProofStatus.Unproven);
    expect(after.relevance.diagnostics.indexedPathProof!.status).toBe(UniquenessProofStatus.Ambiguous);
    expect(after.relevance.candidates.map((repo) => repo.alias)).toEqual(["a", "b"]);
  }, 60_000);

  test("B8 — explicit selection outranks indexed-path uncertainty", async () => {
    const { config, roots } = await workspace();

    const { relevance, indexesOpened } = await withRefused(roots, "b", () =>
      nominate(config, { selector: { alias: "c" }, pathHints: ["shared/pipeline.py"] }));

    // §46: explicit routing is not a uniqueness claim and needs no proof.
    expect(relevance.status).toBe(RepositoryRelevanceStatus.Selected);
    expect(relevance.selected.map((repo) => repo.alias)).toEqual(["c"]);
    expect(relevance.diagnostics.decidingTier).toBe(RepositoryEvidenceKind.ExplicitRoute);
    expect(indexesOpened).toEqual([]);
    expect(relevance.diagnostics.indexedPathProof).toBeNull();
  }, 60_000);

  test("B9 — absolute-path containment stays the stronger tier", async () => {
    const { config, roots } = await workspace();

    const { relevance, indexesOpened } = await withRefused(roots, "b", () =>
      nominate(config, { pathHints: [path.join(roots.a!, "shared/pipeline.py")] }));

    // §47: containment is filesystem identity, not derived evidence, so an
    // unknown member's indexed paths cannot cloud it. No index is opened at all.
    expect(relevance.status).toBe(RepositoryRelevanceStatus.Selected);
    expect(relevance.selected.map((repo) => repo.alias)).toEqual(["a"]);
    expect(relevance.diagnostics.decidingTier).toBe(RepositoryEvidenceKind.PathContainment);
    expect(indexesOpened).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// §52-§54 — invariance and population membership
// ---------------------------------------------------------------------------

describe("M148-B population and invariance (§52-§54)", () => {
  test("reversing registration order changes no verdict", async () => {
    const forward = await buildWorkspace(["a", "b", "c"]);
    const reversed = await writeFixtureWorkspace({
      configPath: path.join(forward.root, "reversed.workspace.json"),
      repos: ["c", "b", "a"].map((alias) => ({ alias, rootPath: forward.roots[alias]! })),
      primaryRepoAlias: "c",
    });

    for (const hints of [["src/a_only.py"], ["shared/pipeline.py"], ["src/nothing_here.py"]]) {
      const left = await nominate(forward.config, { pathHints: hints });
      const right = await nominate(reversed, { pathHints: hints });

      expect(right.relevance.status).toBe(left.relevance.status);
      expect(right.relevance.selected.map((repo) => repo.alias))
        .toEqual(left.relevance.selected.map((repo) => repo.alias));
      expect(right.relevance.diagnostics.indexedPathProof?.status)
        .toBe(left.relevance.diagnostics.indexedPathProof?.status);
    }

    // And with a member refused, both orders withhold the same claim.
    const forwardUnproven = await withRefused(forward.roots, "b", () =>
      nominate(forward.config, { pathHints: ["src/a_only.py"] }));
    const reversedUnproven = await withRefused(forward.roots, "b", () =>
      nominate(reversed, { pathHints: ["src/a_only.py"] }));
    expect(reversedUnproven.relevance.status).toBe(forwardUnproven.relevance.status);
    expect(reversedUnproven.relevance.diagnostics.indexedPathProof!.unknown.map((entry) => entry.alias))
      .toEqual(forwardUnproven.relevance.diagnostics.indexedPathProof!.unknown.map((entry) => entry.alias));
  }, 120_000);

  test("unrelated ready members do not move a decisive answer, but one unknown does", async () => {
    // Scaled to ten real indexes rather than a hundred: the property is "an
    // absent member changes nothing, an unasked one changes everything", and it
    // does not become truer at 100 builds. Aggregate cost at 100 and 1000
    // members is measured separately in the M148 performance artifact.
    const root = await makeWorkspaceRoot("m148b-invariance-");
    const owner = await indexedRepo(root, "owner", { "src/owned.py": "def owned():\n    return 1\n" });
    const repos = [{ alias: "owner", rootPath: owner }];

    const results: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      repos.push({
        alias: `absent-${index}`,
        rootPath: await indexedRepo(root, `absent-${index}`, {
          [`src/unrelated_${index}.py`]: `def unrelated_${index}():\n    return ${index}\n`,
        }),
      });
      if (index !== 0 && index !== 9) continue;

      const config = await writeFixtureWorkspace({
        configPath: path.join(root, `scale-${index}.workspace.json`),
        repos,
        primaryRepoAlias: "owner",
      });
      const { relevance } = await nominate(config, { pathHints: ["src/owned.py"] });
      results.push(`${relevance.status}:${relevance.selected.map((repo) => repo.alias).join(",")}`);
      expect(relevance.diagnostics.indexedPathProof!.definitelyAbsent).toBe(index + 1);
    }

    // One unrelated member, then ten: the decisive answer is unmoved.
    expect(results).toEqual(["selected:owner", "selected:owner"]);

    // Now make ONE of them unaskable. Nothing about the owner changed; what
    // changed is that the negative claim covering the workspace no longer holds.
    const config = await writeFixtureWorkspace({
      configPath: path.join(root, "unknown.workspace.json"),
      repos,
      primaryRepoAlias: "owner",
    });
    const original = await breakDerivation(repos[5]!.rootPath);
    try {
      const { relevance, indexesOpened } = await nominate(config, { pathHints: ["src/owned.py"] });
      expect(relevance.status).toBe(RepositoryRelevanceStatus.Ambiguous);
      expect(relevance.diagnostics.indexedPathProof!.status).toBe(UniquenessProofStatus.Unproven);
      expect(relevance.diagnostics.indexedPathProof!.unknown.map((entry) => entry.alias)).toEqual([repos[5]!.alias]);
      expect(indexesOpened).not.toContain(repos[5]!.alias);
    } finally {
      await repairDerivation(repos[5]!.rootPath, original);
    }
  }, 180_000);

  test("a disabled member is outside the population and blocks nothing", async () => {
    // §54: `enabled: false` means the member is not part of workspace routing at
    // all, which is a different statement from "we could not read it".
    const { roots, root } = await workspace();
    const config = await writeFixtureWorkspace({
      configPath: path.join(root, "disabled.workspace.json"),
      repos: [
        { alias: "a", rootPath: roots.a! },
        { alias: "b", rootPath: roots.b!, enabled: false },
        { alias: "c", rootPath: roots.c! },
      ],
      primaryRepoAlias: "a",
    });

    const { relevance, indexesOpened } = await withRefused(roots, "b", () =>
      nominate(config, { pathHints: ["shared/pipeline.py"] }));

    expect(relevance.status).toBe(RepositoryRelevanceStatus.Selected);
    expect(relevance.selected.map((repo) => repo.alias)).toEqual(["a"]);
    const proof = relevance.diagnostics.indexedPathProof!;
    expect(proof.status).toBe(UniquenessProofStatus.Unique);
    expect(proof.unknown).toEqual([]);
    expect(indexesOpened).not.toContain("b");
  }, 60_000);

  test("the exact-symbol lane is unchanged by the path lane's proof", async () => {
    // M147 preservation: the two lanes prove different things about the same
    // workspace and must not borrow each other's verdicts.
    const { config, roots } = await workspace();

    const unique = await nominate(config, { symbolHints: ["a_only"] });
    expect(unique.relevance.status).toBe(RepositoryRelevanceStatus.Selected);
    expect(unique.relevance.diagnostics.presenceProof!.status).toBe(UniquenessProofStatus.Unique);
    expect(unique.relevance.diagnostics.indexedPathProof).toBeNull();

    const blocked = await withRefused(roots, "b", () => nominate(config, { symbolHints: ["a_only"] }));
    expect(blocked.relevance.status).toBe(RepositoryRelevanceStatus.Ambiguous);
    expect(blocked.relevance.diagnostics.presenceProof!.status).toBe(UniquenessProofStatus.Unproven);
    expect(blocked.relevance.reason).toContain("defines this name");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// §55 — through the real product path
// ---------------------------------------------------------------------------

describe("M148-B product acceptance (§55)", () => {
  test("an unproven path owner delivers no context from an arbitrary repository", async () => {
    const { config, roots } = await workspace();
    const registry = await resolveWorkspaceRegistry({ config });

    const opened: string[] = [];
    const dbs: Database[] = [];
    const openRepository = (repository: RegisteredRepository): Database | null => {
      opened.push(repository.alias);
      try {
        const db = new Database(resolveIndexDbPath(repository.rootPath), { readonly: true });
        dbs.push(db);
        return db;
      } catch {
        return null;
      }
    };

    const original = await breakDerivation(roots.b!);
    try {
      const readiness = await evaluateWorkspaceReadiness(registry);
      const result = await assembleWorkspaceProductContext({
        registry,
        readiness,
        task: "fix the pipeline entry point",
        pathHints: ["src/a_only.py"],
        probe: (repository) => {
          try {
            const db = new Database(resolveIndexDbPath(repository.rootPath), { readonly: true });
            dbs.push(db);
            return createDatabaseProbe(db);
          } catch {
            return null;
          }
        },
        openRepository,
        assemble: async () => {
          throw new Error("retrieval must not run when ownership is unproven");
        },
      });

      expect(result.context).toBeNull();
      expect(result.routing.status).toBe(RepositoryRelevanceStatus.Ambiguous);
      expect(result.routing.leadRepository).toBeNull();
      expect(result.routing.reason).toContain("could not be checked");
      // No repository was opened for RETRIEVAL, so nothing plausible-but-wrong
      // was delivered from the member that merely happened to be ready.
      expect(result.indexesOpenedForRetrieval).toEqual([]);
      expect(opened).toEqual([]);
    } finally {
      for (const db of dbs) db.close();
      await repairDerivation(roots.b!, original);
    }
  }, 60_000);
});
