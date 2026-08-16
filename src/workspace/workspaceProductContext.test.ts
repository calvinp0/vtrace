/**
 * M146-B: workspace retrieval through the real product context.
 *
 * These drive `assembleProductContext` itself rather than a stand-in, because
 * the question is whether the safety properties survive orchestration — a
 * router that gates correctly in isolation proves nothing about the path a user
 * actually takes.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";

import { resolveIndexDbPath, resolveIndexMetaPath, type IndexMeta } from "../indexer/indexMeta";
import { assembleProductContext } from "../productContext/assembleProductContext";
import { ProductStoreLease } from "../session/sessionStore";
import { initRepo } from "../setup/initRepo";
import { resolveWorkspaceConfigPath, type ResolvedWorkspaceConfig } from "./config";
import { evaluateWorkspaceReadiness } from "./readiness";
import { resolveWorkspaceRegistry, type RegisteredRepository } from "./registry";
import { createDatabaseProbe, RepositoryRelevanceStatus } from "./repositoryRelevance";
import { assembleWorkspaceProductContext, type WorkspaceProductContextInput } from "./workspaceProductContext";
import {
  cleanupWorkspaceFixtures,
  makeFixtureRepo,
  makeWorkspaceRoot,
  writeFixtureWorkspace,
} from "./workspaceFixture";

afterAll(cleanupWorkspaceFixtures);

const VTRACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function indexedRepo(root: string, rel: string, files: Record<string, string>): Promise<string> {
  const repoRoot = await makeFixtureRepo(path.join(root, rel), { files });
  await initRepo({ repoPath: repoRoot });
  return repoRoot;
}

async function breakDerivation(repoRoot: string): Promise<void> {
  const metaPath = resolveIndexMetaPath(repoRoot);
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as IndexMeta;
  meta.indexer_fingerprint = "0".repeat(64);
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

/** Runs the workspace path with the REAL assembler. Records every index opened. */
async function runWorkspace(
  config: ResolvedWorkspaceConfig,
  request: Partial<WorkspaceProductContextInput> & { task: string },
) {
  const registry = await resolveWorkspaceRegistry({ config });
  const readiness = await evaluateWorkspaceReadiness(registry);
  const openedForProbe: string[] = [];
  const handles: Database[] = [];

  const open = (repository: RegisteredRepository): Database | null => {
    try {
      const db = new Database(resolveIndexDbPath(repository.rootPath), { readonly: true });
      handles.push(db);
      return db;
    } catch {
      return null;
    }
  };

  try {
    const result = await assembleWorkspaceProductContext({
      registry,
      readiness,
      openRepository: open,
      probe: (repository) => {
        openedForProbe.push(repository.alias);
        const db = open(repository);
        return db === null ? null : createDatabaseProbe(db);
      },
      assemble: ({ repository, db, task, budgetTokens }) => assembleProductContext({
        // Each member reads its OWN session store, and `read` creates none.
        stores: new ProductStoreLease(db, resolveIndexDbPath(repository.rootPath)).read,
        repoRoot: repository.rootPath,
        task,
        ...(budgetTokens === undefined ? {} : { budgetTokens }),
      }),
      ...request,
    } as WorkspaceProductContextInput);
    return { result, openedForProbe };
  } finally {
    for (const db of handles) db.close();
  }
}

/** The same repository queried directly, with no workspace involved at all. */
async function runDirect(repoRoot: string, task: string, budgetTokens?: number) {
  const db = new Database(resolveIndexDbPath(repoRoot), { readonly: true });
  try {
    return await assembleProductContext({
      stores: new ProductStoreLease(db, resolveIndexDbPath(repoRoot)).read,
      repoRoot,
      task,
      ...(budgetTokens === undefined ? {} : { budgetTokens }),
    });
  } finally {
    db.close();
  }
}

const semanticView = (response: NonNullable<Awaited<ReturnType<typeof runDirect>>>) => ({
  resolved: response.resolved,
  capsuleMode: response.capsuleMode,
  leadPivot: response.leadPivot,
  selectedFileHash: response.selectedFileHash,
  roleCounts: response.roleCounts,
  items: response.items.map((item) => ({
    path: item.path,
    symbol: item.symbol,
    roles: item.roles,
    contentMode: item.contentMode,
    content: item.content,
    estimatedTokens: item.estimatedTokens,
  })),
});

// ---------------------------------------------------------------------------
// §14 — structural no-op for ordinary requests
// ---------------------------------------------------------------------------

describe("M146-B single-repository structural no-op (§14)", () => {
  test("only the declared product seam reaches the router or aggregator", async () => {
    // M146-B asserted NOTHING outside src/workspace reached these modules, which
    // was true and was also the defect M151 existed to fix: four milestones of
    // routing were unreachable from the product.
    //
    // The invariant that survives is narrower and is the one that actually
    // protects single-repository behaviour: exactly ONE production module may
    // compose the workspace layer, so there is a single seam to audit rather
    // than a handler that grew its own repository loop (§43). That a request
    // without a workspace config still never runs the router is a BEHAVIOURAL
    // guarantee, measured through the real product surface by the M151 corpus,
    // not something an import graph can establish either way.
    const workspaceModules = ["workspaceProductContext", "repositoryRelevance", "crossRepoAggregation"];
    const authorizedSeam = new Set(["src/mcp/tools.ts -> workspaceProductContext"]);
    const offenders: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "workspace") continue;
          await walk(entryPath);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.includes(".test.")) continue;
        const source = await readFile(entryPath, "utf8");
        for (const module of workspaceModules) {
          if (new RegExp(`from\\s+["'][^"']*${module}["']`).test(source)) {
            const reference = `${path.relative(VTRACE_ROOT, entryPath)} -> ${module}`;
            if (!authorizedSeam.has(reference)) offenders.push(reference);
          }
        }
      }
    };
    await walk(path.join(VTRACE_ROOT, "src"));

    expect(offenders).toEqual([]);
  });

  test("assembleProductContext still takes one repository and no workspace input", async () => {
    // The structural reason single-repository behaviour cannot move: workspace
    // routing composes this function, it does not reach inside it.
    const source = await readFile(
      path.join(VTRACE_ROOT, "src/productContext/assembleProductContext.ts"),
      "utf8",
    );
    expect(source).not.toContain("repositoryRelevance");
    expect(source).not.toContain("crossRepoAggregation");
    expect(source).not.toContain("WorkspaceRegistry");
  });
});

// ---------------------------------------------------------------------------
// §15/§24 — one-repository workspace parity
// ---------------------------------------------------------------------------

describe("M146-B one-repository workspace parity (§15)", () => {
  test("a one-member workspace is byte-identical to querying that repository", async () => {
    const root = await makeWorkspaceRoot("m146b-solo-");
    const repo = await indexedRepo(root, "solo", {
      "src/dihedral.py": "def get_dihedral(a, b):\n    \"\"\"Compute the dihedral angle.\"\"\"\n    return 1\n",
      "src/other.py": "def helper():\n    return 2\n",
    });
    const config = await writeFixtureWorkspace({
      configPath: resolveWorkspaceConfigPath(repo),
      repos: [{ alias: "solo", rootPath: repo }],
      primaryRepoAlias: "solo",
    });

    const direct = await runDirect(repo, "how does get_dihedral work?");
    const { result } = await runWorkspace(config, {
      task: "how does get_dihedral work?",
      symbolHints: ["get_dihedral"],
    });

    expect(result.routing.status).toBe(RepositoryRelevanceStatus.Selected);
    expect(result.context).not.toBeNull();
    // Same response object semantics: routing chose the repository, retrieval
    // was the same call, so nothing about the answer may differ.
    expect(semanticView(result.context!)).toEqual(semanticView(direct));
  }, 60_000);
});

// ---------------------------------------------------------------------------
// §16 — mixed readiness through the product path
// ---------------------------------------------------------------------------

/**
 * Built once for the whole file. None of the cases below mutate it — they only
 * ask different questions of the same three-member workspace — and rebuilding
 * three real indexes per test made the suite time out under load, which is a
 * flaky guard rather than a stricter one.
 */
let mixedWorkspaceOnce: ReturnType<typeof buildMixedWorkspace> | undefined;
function mixedWorkspace(): ReturnType<typeof buildMixedWorkspace> {
  mixedWorkspaceOnce ??= buildMixedWorkspace();
  return mixedWorkspaceOnce;
}

async function buildMixedWorkspace() {
  const root = await makeWorkspaceRoot("m146b-prod-mixed-");
  const alpha = await indexedRepo(root, "alpha", {
    "src/dihedral.py": "def get_dihedral(a, b):\n    return 1\n",
  });
  const beta = await indexedRepo(root, "beta", {
    "tckdb/species.py": "class SpeciesRecord:\n    def store_species(self):\n        return 2\n",
  });
  const gamma = await indexedRepo(root, "gamma", {
    "src/gamma_only.py": "def gamma_only():\n    return 3\n",
  });
  await breakDerivation(beta);
  const config = await writeFixtureWorkspace({
    configPath: resolveWorkspaceConfigPath(alpha),
    repos: [{ alias: "alpha", rootPath: alpha }, { alias: "beta", rootPath: beta }, { alias: "gamma", rootPath: gamma }],
    primaryRepoAlias: "alpha",
  });
  return { root, alpha, beta, gamma, config };
}

describe("M146-B mixed readiness through the product path (§16)", () => {
  test("a symbol only the stale repository defines never opens its index", async () => {
    const { config } = await mixedWorkspace();

    const { result, openedForProbe } = await runWorkspace(config, {
      task: "where is SpeciesRecord defined?",
      symbolHints: ["SpeciesRecord"],
    });

    expect(result.routing.status).toBe(RepositoryRelevanceStatus.NoMatch);
    expect(result.context).toBeNull();
    expect(openedForProbe).not.toContain("beta");
    expect(result.indexesOpenedForRetrieval).toEqual([]);
    expect(result.routing.excludedNotReady.map((entry) => entry.alias)).toEqual(["beta"]);
    expect(result.routing.excludedNotReady[0]!.reason).toContain("derivation_changed");
  }, 60_000);

  test("an absolute path into the stale repository reports not_ready, not no_match", async () => {
    const { beta, config } = await mixedWorkspace();

    const { result, openedForProbe } = await runWorkspace(config, {
      task: "explain store_species",
      pathHints: [path.join(beta, "tckdb/species.py")],
    });

    expect(result.routing.status).toBe(RepositoryRelevanceStatus.NotReady);
    expect(result.routing.candidates).toEqual(["beta"]);
    expect(result.context).toBeNull();
    // Identified without being consulted: no retrieval, no probe.
    expect(openedForProbe).not.toContain("beta");
    expect(result.indexesOpenedForRetrieval).toEqual([]);
  }, 60_000);

  test("a symbol-only answer waits for the stale member to be repairable (M147)", async () => {
    // M146 returned gamma's context here. The claim underneath it — that gamma
    // is the only repository defining the name — was about beta, which was
    // never asked. M147 withholds the claim and says which index to repair,
    // rather than retrieving from a repository whose exclusivity was assumed.
    const { config } = await mixedWorkspace();

    const { result } = await runWorkspace(config, {
      task: "what does gamma_only do?",
      symbolHints: ["gamma_only"],
    });

    expect(result.routing.status).toBe(RepositoryRelevanceStatus.Ambiguous);
    expect(result.routing.reason).toContain("beta");
    expect(result.context).toBeNull();
    expect(result.indexesOpenedForRetrieval).toEqual([]);
  }, 60_000);

  test("a path-routed answer beside a stale member is unaffected (M147)", async () => {
    // The presence proof governs the exact-symbol lane only. Absolute-path
    // containment decides a LOCATION and makes no global-negative claim, so a
    // stale sibling has nothing to contribute and nothing to block.
    const { config, gamma } = await mixedWorkspace();

    const { result } = await runWorkspace(config, {
      task: "what does gamma_only do?",
      pathHints: [path.join(gamma, "src/gamma_only.py")],
    });

    expect(result.routing.status).toBe(RepositoryRelevanceStatus.Selected);
    expect(result.routing.leadRepository).toBe("gamma");
    expect(result.context).not.toBeNull();
    expect(result.indexesOpenedForRetrieval).toEqual(["gamma"]);
  }, 60_000);

  test("explicit selection of a ready repository ignores contrary evidence", async () => {
    const { config } = await mixedWorkspace();

    const { result, openedForProbe } = await runWorkspace(config, {
      task: "get_dihedral",
      selector: { alias: "alpha" },
      symbolHints: ["gamma_only"],
    });

    expect(result.routing.leadRepository).toBe("alpha");
    expect(result.routing.decidingTier).toBe("explicit_route");
    expect(openedForProbe).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// §44/§45 — two-repository composition through the product path
// ---------------------------------------------------------------------------

async function compositionWorkspace() {
  const root = await makeWorkspaceRoot("m146b-compose-");
  const backend = await indexedRepo(root, "backend", {
    "src/api/handler.py": "def handleCheckout(payload):\n    \"\"\"Validate and record a checkout.\"\"\"\n    return {'ok': True}\n",
  });
  const client = await indexedRepo(root, "client", {
    "src/checkout_client.py": "def callCheckout(session):\n    \"\"\"Invoke the checkout endpoint.\"\"\"\n    return session.post('/checkout')\n",
  });
  const config = await writeFixtureWorkspace({
    configPath: resolveWorkspaceConfigPath(backend),
    repos: [{ alias: "backend", rootPath: backend }, { alias: "client", rootPath: client }],
    primaryRepoAlias: "backend",
  });
  return { root, backend, client, config };
}

describe("M146-B two-repository composition (§44)", () => {
  test("a task spanning both repositories delivers context from both", async () => {
    const { backend, config } = await compositionWorkspace();

    const { result } = await runWorkspace(config, {
      task: "how does the client call the checkout handler?",
      // Path names the backend (index-free lead); the symbol lives in the
      // client, a strictly weaker tier, so it becomes support rather than a rival.
      pathHints: [path.join(backend, "src/api/handler.py")],
      symbolHints: ["callCheckout"],
      compose: true,
      budgetTokens: 4000,
    });

    expect(result.routing.status).toBe(RepositoryRelevanceStatus.Selected);
    expect(result.routing.leadRepository).toBe("backend");
    expect(result.routing.supportingRepositories).toEqual(["client"]);
    expect(result.indexesOpenedForRetrieval).toEqual(["backend", "client"]);

    const contributing = result.perRepository.filter((repo) => repo.itemsSelected > 0);
    expect(contributing.map((repo) => repo.alias).sort()).toEqual(["backend", "client"]);

    // Provenance survives the merge: every item knows its repository.
    for (const item of result.context!.items) {
      expect((item.metadata as { repository?: { alias?: string } }).repository?.alias).toBeDefined();
    }
    const aliases = new Set(result.context!.items.map(
      (item) => (item.metadata as { repository: { alias: string } }).repository.alias,
    ));
    expect(aliases.size).toBe(2);
  }, 60_000);

  test("a budget fitting only the direct answer omits the support", async () => {
    const { backend, config } = await compositionWorkspace();

    const generous = await runWorkspace(config, {
      task: "how does the client call the checkout handler?",
      pathHints: [path.join(backend, "src/api/handler.py")],
      symbolHints: ["callCheckout"],
      compose: true,
      budgetTokens: 4000,
    });
    const leadTokens = generous.result.context!.items[0]!.estimatedTokens;

    const constrained = await runWorkspace(config, {
      task: "how does the client call the checkout handler?",
      pathHints: [path.join(backend, "src/api/handler.py")],
      symbolHints: ["callCheckout"],
      compose: true,
      budgetTokens: leadTokens,
    });

    // The direct answer survives; support is dropped rather than displacing it.
    expect(constrained.result.context!.items.length).toBeGreaterThan(0);
    const first = constrained.result.context!.items[0]!;
    expect((first.metadata as { repository: { alias: string } }).repository.alias).toBe("backend");
    expect(constrained.result.context!.accounting.usedTokensEstimate).toBeLessThanOrEqual(leadTokens);
  }, 60_000);

  test("the shared budget is never multiplied by repository count (§20)", async () => {
    const { backend, config } = await compositionWorkspace();

    const { result } = await runWorkspace(config, {
      task: "how does the client call the checkout handler?",
      pathHints: [path.join(backend, "src/api/handler.py")],
      symbolHints: ["callCheckout"],
      compose: true,
      budgetTokens: 300,
    });

    const total = result.perRepository.reduce((sum, repo) => sum + repo.tokens, 0);
    expect(total).toBeLessThanOrEqual(300);
    expect(result.context!.accounting.usedTokensEstimate).toBeLessThanOrEqual(300);
  }, 60_000);

  test("composition is off by default, so an ordinary query stays single-repository", async () => {
    const { backend, config } = await compositionWorkspace();

    const { result } = await runWorkspace(config, {
      task: "how does the client call the checkout handler?",
      pathHints: [path.join(backend, "src/api/handler.py")],
      symbolHints: ["callCheckout"],
    });

    expect(result.routing.supportingRepositories).toEqual([]);
    expect(result.indexesOpenedForRetrieval).toEqual(["backend"]);
  }, 60_000);
});
