/**
 * M151 — workspace-layer reachability from the real product surfaces.
 *
 * §8 asks for the M149 structural finding to be reproduced from the current state
 * rather than quoted, and §139 asks for a before/after artifact showing whether
 * the workspace router is reached.
 *
 * WHAT IS MEASURED
 * ----------------
 * Whether the module DEFINING each capability lies in the transitive import
 * closure of the real product entry points, and by what chain.
 *
 * Two cheaper measures were tried first and both lie:
 *
 *   - "does the symbol appear in a product file" understates it, because M151
 *     routes through one seam on purpose (§9). `tools.ts` imports the seam and
 *     the seam imports the router; one hop of grep calls that unreachable.
 *
 *   - "does the symbol appear in any transitively reached file" overstates it to
 *     the point of uselessness: once the defining module is scanned at all, its
 *     own definition counts as a reference, so everything reads as reachable in
 *     both the before and after states.
 *
 * The import chain is the evidence. A capability is reachable exactly when a
 * request can get to it, and the chain shows how.
 *
 * Deterministic, no network, no agents.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const OUT = path.join(import.meta.dir, "results", "stage5_m151_workspace_reachability_before_after.json");

/** The product source roots M149 named, plus the CLI command tree. */
const PRODUCT_ROOTS = ["src/mcp", "src/cli", "src/runPipeline", "src/productContext"] as const;

/** The workspace capabilities whose reachability is the milestone's subject. */
const CAPABILITIES = [
  { symbol: "resolveWorkspaceRegistry", module: "src/workspace/registry.ts", role: "identity" },
  { symbol: "evaluateWorkspaceReadiness", module: "src/workspace/readiness.ts", role: "readiness" },
  { symbol: "nominateRepositories", module: "src/workspace/repositoryRelevance.ts", role: "routing" },
  { symbol: "assembleWorkspaceProductContext", module: "src/workspace/workspaceProductContext.ts", role: "composition" },
  { symbol: "createPathMembershipResolver", module: "src/workspace/pathMembership.ts", role: "path_membership" },
  { symbol: "proveExactUniqueness", module: "src/workspace/repositoryPresence.ts", role: "symbol_uniqueness" },
  { symbol: "aggregateCrossRepoContext", module: "src/workspace/crossRepoAggregation.ts", role: "budget_allocation" },
  { symbol: "composeCoverage", module: "src/workspace/evidenceClaims.ts", role: "evidence_coverage" },
  { symbol: "classifyNegativeClaim", module: "src/workspace/evidenceClaims.ts", role: "absence_claims" },
] as const;

async function collectSourceFiles(root: string): Promise<string[]> {
  const absolute = path.join(REPO_ROOT, root);
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      // Tests are not a product surface. A capability reachable only from its own
      // test suite is exactly the state M151 exists to change.
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      found.push(full);
    }
  }

  await walk(absolute);
  return found.sort();
}

async function importsOf(file: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }

  const targets: string[] = [];
  for (const match of text.matchAll(/from\s+["'](\.[^"']+)["']/gu)) {
    const resolvedBase = path.resolve(path.dirname(file), match[1]!);
    for (const candidate of [`${resolvedBase}.ts`, path.join(resolvedBase, "index.ts")]) {
      if (candidate.endsWith(".test.ts")) continue;
      // A specifier resolves to exactly one spelling; only the real one counts.
      if (existsSync(candidate)) targets.push(candidate);
    }
  }
  return targets;
}

/**
 * Breadth-first from the product roots, so the recorded chain is the SHORTEST
 * route a request takes to a capability rather than whichever one a depth-first
 * walk happened to find.
 */
async function buildReachability(seeds: readonly string[]): Promise<Map<string, string[]>> {
  const chains = new Map<string, string[]>();
  for (const seed of seeds) chains.set(seed, [seed]);

  let frontier = [...seeds];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const file of frontier) {
      const chain = chains.get(file)!;
      for (const target of await importsOf(file)) {
        if (chains.has(target)) continue;
        chains.set(target, [...chain, target]);
        next.push(target);
      }
    }
    frontier = next;
  }

  return chains;
}

const seeds = (await Promise.all(PRODUCT_ROOTS.map(collectSourceFiles))).flat();
const chains = await buildReachability(seeds);

const capabilities = CAPABILITIES.map((capability) => {
  const absolute = path.join(REPO_ROOT, capability.module);
  const chain = chains.get(absolute);
  return {
    symbol: capability.symbol,
    module: capability.module,
    role: capability.role,
    reachableFromProduct: chain !== undefined,
    // The chain from a product entry point to the defining module. This is the
    // §139 "workspace router reached? yes/no" evidence, with the route shown.
    importChain: chain === undefined
      ? null
      : chain.map((file) => path.relative(REPO_ROOT, file)),
    hops: chain === undefined ? null : chain.length - 1,
  };
});

const snapshot = {
  milestone: "M151",
  generatedBy: "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m151_reachability.ts",
  measure:
    "The module defining each capability lies in the transitive import closure of "
    + "the product entry points. `importChain` is the shortest route from a product "
    + "file to that module; null means no route exists.",
  productRoots: [...PRODUCT_ROOTS],
  productSeedFiles: seeds.length,
  modulesInClosure: chains.size,
  capabilities,
  summary: {
    total: capabilities.length,
    reachable: capabilities.filter((capability) => capability.reachableFromProduct).length,
    unreachable: capabilities.filter((capability) => !capability.reachableFromProduct).length,
  },
};

const label = process.argv[2] ?? "before";
let document: Record<string, unknown> = {};
try {
  document = JSON.parse(await readFile(OUT, "utf8")) as Record<string, unknown>;
} catch {
  document = {};
}
document[label] = snapshot;

await writeFile(OUT, `${JSON.stringify(document, null, 2)}\n`);

console.log(
  `[m151-reachability:${label}] ${snapshot.summary.reachable}/${snapshot.summary.total} capabilities reachable; `
  + `${snapshot.modulesInClosure} modules in the product closure`,
);
for (const capability of capabilities) {
  console.log(
    `  ${capability.reachableFromProduct ? `REACHABLE (${capability.hops} hops)` : "unreachable       "} `
    + `${capability.symbol}`,
  );
}
