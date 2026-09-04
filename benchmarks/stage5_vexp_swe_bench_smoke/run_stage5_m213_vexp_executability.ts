/**
 * M213 §33 — VEXP_TREATMENT_EXECUTABLE gate.
 *
 * Establishes, before any paid model run, whether the VEXP arm can actually be
 * executed across the frozen 100-task population — twelve repositories, some of
 * them very large.
 *
 * METHOD. Static reads of shipped vexp-cli bundles plus one local CLI
 * invocation. NO VEXP process indexes anything, no licence is used, no account
 * is created, no purchase is made and no network call is issued beyond whatever
 * the CLI's own update check performs on invocation. M212 established the same
 * boundary and this script does not widen it.
 *
 * The gate is answered by CAPACITY, not by a sample: a plan's repository and
 * node ceilings either cover the population or they do not.
 *
 * Usage:
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m213_vexp_executability.ts [--out <dir>]
 */

import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { extractVexpToolSurface } from "./m212VexpSurface";
import { loadFrozenTaskPopulation } from "./m213Preregistration";

const execFile = promisify(execFileCallback);
const DEFAULT_OUT = path.join(import.meta.dir, "results");

const BUNDLE_CANDIDATES = [
  "/home/calvin/.npm-global/lib/node_modules/vexp-cli",
  "/tmp/m212/vexp311/package",
];

interface BundleFacts {
  readonly dir: string;
  readonly present: boolean;
  readonly version: string | null;
  readonly defaultToolCatalog: readonly string[];
  readonly gatedToolCatalog: readonly string[];
  readonly allToolsEnvVar: string | null;
  readonly freeLimits: { maxNodes: number; maxRepos: number; allTools: boolean } | null;
  readonly paidTiers: Readonly<Record<string, { maxNodes: number; maxRepos: number }>>;
  readonly coreBinaryInstalled: boolean;
  readonly enforcementLocation: string;
}

async function run(
  command: string,
  args: readonly string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFile(command, [...args], { timeout: 120_000 });
    return { ok: true, stdout, stderr };
  } catch (cause) {
    const error = cause as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message ?? "" };
  }
}

/**
 * Read a bundle's default tool catalogue from its MCP server source.
 *
 * Delegated to M212's extractor rather than re-implemented. M212 resolved the
 * minified tool-list arms properly and its own unit test caught a window-based
 * reader that spilled into neighbouring definitions — exactly the defect a
 * second, looser implementation here would reintroduce.
 */
function readDefaultCatalog(bundleDir: string): {
  defaults: string[];
  all: string[];
  allToolsVar: string | null;
} {
  const candidates = [
    path.join(bundleDir, "mcp", "mcp-server.cjs"),
    path.join(bundleDir, "dist", "mcp-server.js"),
  ].filter((file) => existsSync(file));
  if (candidates.length === 0) return { defaults: [], all: [], allToolsVar: null };
  const surface = extractVexpToolSurface(readFileSync(candidates[0]!, "utf8"), null);
  return {
    defaults: [...surface.defaultListed],
    all: [...surface.allListed],
    allToolsVar: surface.allToolsEnvVar,
  };
}

function readLimits(bundleDir: string): {
  free: { maxNodes: number; maxRepos: number; allTools: boolean } | null;
  tiers: Record<string, { maxNodes: number; maxRepos: number }>;
  enforcement: string;
} {
  const file = path.join(bundleDir, "dist", "license.js");
  if (!existsSync(file)) return { free: null, tiers: {}, enforcement: "unknown" };
  const source = readFileSync(file, "utf8");

  const freeBlock = /FREE_LIMITS\s*=\s*\{([\s\S]{0,400}?)\}/.exec(source)?.[1] ?? "";
  const number = (block: string, key: string): number | null => {
    const raw = new RegExp(`${key}\\s*:\\s*([0-9_]+)`).exec(block)?.[1];
    return raw === undefined ? null : Number(raw.replaceAll("_", ""));
  };
  const freeNodes = number(freeBlock, "maxNodes");
  const freeRepos = number(freeBlock, "maxRepos");
  const free = freeNodes === null || freeRepos === null
    ? null
    : { maxNodes: freeNodes, maxRepos: freeRepos, allTools: /allTools\s*:\s*true/.test(freeBlock) };

  const tiers: Record<string, { maxNodes: number; maxRepos: number }> = {};
  for (const match of source.matchAll(
    /maxNodes:\s*([0-9_]+),\s*maxRepos:\s*([0-9_]+),\s*allTools:\s*\w+,\s*plan:\s*["']([a-z0-9]+)["']/g,
  )) {
    tiers[match[3]!] = {
      maxNodes: Number(match[1]!.replaceAll("_", "")),
      maxRepos: Number(match[2]!.replaceAll("_", "")),
    };
  }

  const cliPath = path.join(bundleDir, "dist", "cli.js");
  const cliSource = existsSync(cliPath) ? readFileSync(cliPath, "utf8") : "";
  const enforcement = /enforced directly by the Rust daemon/.test(`${source}${cliSource}`)
    ? "native core daemon, via license.jwt verification; the JS bundle's limits are display-only, "
      + "so the ceilings below are what the vendor's own client reports, not what this audit measured"
    : "unknown";

  return { free, tiers, enforcement };
}

function readBundle(dir: string): BundleFacts {
  if (!existsSync(dir)) {
    return {
      dir, present: false, version: null, defaultToolCatalog: [], gatedToolCatalog: [], allToolsEnvVar: null,
      freeLimits: null, paidTiers: {}, coreBinaryInstalled: false, enforcementLocation: "unknown",
    };
  }
  let version: string | null = null;
  try {
    version = String((JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: string }).version ?? "");
  } catch { version = null; }

  const catalog = readDefaultCatalog(dir);
  const limits = readLimits(dir);
  const vendorDir = path.join(dir, "node_modules", "@vexp");
  const coreBinaryInstalled = existsSync(vendorDir)
    && readdirSync(vendorDir).some((entry) => entry.startsWith("core-"));

  return {
    dir,
    present: true,
    version,
    defaultToolCatalog: catalog.defaults,
    gatedToolCatalog: catalog.all.filter((tool) => !catalog.defaults.includes(tool)),
    allToolsEnvVar: catalog.allToolsVar,
    freeLimits: limits.free,
    paidTiers: limits.tiers,
    coreBinaryInstalled,
    enforcementLocation: limits.enforcement,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--out");
  const outDir = at >= 0 && argv[at + 1] !== undefined ? String(argv[at + 1]) : DEFAULT_OUT;
  mkdirSync(outDir, { recursive: true });

  const population = loadFrozenTaskPopulation();
  const bundles = BUNDLE_CANDIDATES.map(readBundle);

  // Repository scale, from M213's own VTRACE indexing dry run. This is a VTRACE
  // symbol count, NOT a VEXP node count, and the two are not the same metric —
  // it is used only to say how large these repositories are, which is what the
  // node ceilings are ceilings on. The repository-COUNT argument below needs no
  // such caveat and is decisive on its own.
  const vtraceExecPath = path.join(outDir, "stage5_m213_vtrace_executability.json");
  const scale = existsSync(vtraceExecPath)
    ? (JSON.parse(readFileSync(vtraceExecPath, "utf8")) as {
      probes?: { repo: string; totalSymbols: number | null }[];
    }).probes ?? []
    : [];
  const largest = scale
    .filter((probe) => probe.totalSymbols !== null)
    .sort((left, right) => (right.totalSymbols ?? 0) - (left.totalSymbols ?? 0))[0] ?? null;

  const installed = bundles.find((bundle) => bundle.dir.includes("node_modules/vexp-cli"));
  const newest = bundles.filter((bundle) => bundle.present)
    .sort((left, right) => (left.version ?? "").localeCompare(right.version ?? ""))
    .at(-1) ?? null;

  const versionProbe = await run("vexp", ["--version"]);
  const installedRunnable = versionProbe.ok
    && !/update required/i.test(`${versionProbe.stdout}${versionProbe.stderr}`);

  const licenceDir = path.join(process.env.HOME ?? "", ".vexp");
  const licenceFiles = existsSync(licenceDir) ? readdirSync(licenceDir).sort() : [];
  const licencePresent = licenceFiles.includes("license.jwt");

  const effectivePlan = licencePresent ? "unknown (a licence file exists; not read)" : "free";
  const free = newest?.freeLimits ?? null;

  // A plan covers the population only if its repository ceiling admits all
  // twelve repositories (0 means unlimited in this vendor's encoding).
  const repositoriesRequired = population.repositories.length;
  const planCoverage = Object.entries(newest?.paidTiers ?? {}).map(([plan, limits]) => ({
    plan,
    maxRepos: limits.maxRepos,
    maxNodes: limits.maxNodes,
    coversRepositoryCount: limits.maxRepos === 0 || limits.maxRepos >= repositoriesRequired,
  }));

  const blockers: string[] = [];
  if (!installedRunnable) {
    blockers.push(
      `the installed CLI (${installed?.version ?? "unknown"}) refuses every invocation with an `
      + "update-required notice, so no VEXP command can run on this host as it stands",
    );
  }
  if (!licencePresent) {
    blockers.push("no licence is present in ~/.vexp, so the effective plan is FREE");
  }
  if (free !== null && (free.maxRepos !== 0 && free.maxRepos < repositoriesRequired)) {
    blockers.push(
      `the free plan admits ${free.maxRepos} repository, and the frozen population spans `
      + `${repositoriesRequired}`,
    );
  }
  if (free !== null && free.maxNodes > 0) {
    blockers.push(
      `the free plan caps the graph at ${free.maxNodes.toLocaleString()} nodes`
      + (largest === null
        ? ""
        : `, and the largest repository in the population (${largest.repo}) carries `
          + `${(largest.totalSymbols ?? 0).toLocaleString()} indexed symbols`),
    );
  }
  if (newest !== null && !newest.coreBinaryInstalled) {
    blockers.push("the platform core binary (@vexp/core-<platform>) is not installed, and it is the component that both indexes and enforces the plan");
  }

  const executable = blockers.length === 0;

  const artifact = {
    schemaVersion: "stage5.m213.vexp-executability.v1",
    milestone: "M213",
    generatedAt: new Date().toISOString(),
    method:
      "Static read of shipped vexp-cli bundles plus one local `vexp --version` invocation. No VEXP "
      + "indexing, no licence used, no account created, no purchase made.",
    verdict: executable ? "VEXP_TREATMENT_EXECUTABLE" : "VEXP_TREATMENT_NOT_EXECUTABLE",
    blockers,
    installedVersion: installed?.version ?? null,
    installedRunnable,
    installedInvocationOutput: `${versionProbe.stdout}${versionProbe.stderr}`.trim().slice(0, 400),
    newestBundleRead: newest?.version ?? null,
    licenceDirectoryContents: licenceFiles,
    licencePresent,
    effectivePlan,
    freeLimits: free,
    paidTiers: newest?.paidTiers ?? {},
    enforcementLocation: newest?.enforcementLocation ?? "unknown",
    coreBinaryInstalled: newest?.coreBinaryInstalled ?? false,
    defaultToolCatalog: newest?.defaultToolCatalog ?? [],
    gatedOutOfDefaultToolCatalog: newest?.gatedToolCatalog ?? [],
    allToolsEnvVar: newest?.allToolsEnvVar ?? null,
    repositoriesRequired,
    repositoriesInPopulation: population.repositories,
    planCoverage: planCoverage.map((entry) => ({
      ...entry,
      coversLargestRepositoryScale: entry.maxNodes === 0
        || largest === null
        || entry.maxNodes >= (largest.totalSymbols ?? 0),
    })),
    repositoryScale: {
      source: "stage5_m213_vtrace_executability.json",
      metric: "VTRACE indexed symbols per repository",
      metricCaveat:
        "A VTRACE symbol count is not a VEXP node count. It is reported to indicate the SCALE of "
        + "these repositories, not to predict what VEXP's indexer would emit. The repository-count "
        + "argument is independent of this metric.",
      largestRepository: largest?.repo ?? null,
      largestRepositorySymbols: largest?.totalSymbols ?? null,
      perRepository: scale.map((probe) => ({ repo: probe.repo, symbols: probe.totalSymbols })),
    },
    plansThatCouldCoverTheRepositoryCount: planCoverage
      .filter((entry) => entry.coversRepositoryCount).map((entry) => entry.plan),
    procurementNote:
      "Executability here is a purchasing question, not an engineering one. The arm needs a plan "
      + "whose repository ceiling admits all twelve repositories and whose node ceiling admits the "
      + "largest of them. That cannot be established, and must not be assumed, without a licence.",
    substitutionProhibited:
      "If VEXP cannot be executed, the arm is reported as not executable. A static reconstruction of "
      + "VEXP's behaviour is NOT a substitute for the treatment (§33, and M212's finding that a "
      + "hand-authored competitor proxy is not a measurement of the competitor).",
  };

  const outPath = path.join(outDir, "stage5_m213_vexp_executability.json");
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(`${outPath}\n${artifact.verdict}\n`);
  for (const blocker of blockers) process.stdout.write(`  blocker: ${blocker}\n`);
}

await main();
