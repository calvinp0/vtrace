/**
 * M160-E §64-§67, §111, §113 — put Broad100-A and Broad100-B side by side.
 *
 * Three things make this harder than subtracting two numbers, and all three are
 * handled explicitly rather than hidden in a total:
 *
 * 1. DIFFERENT DENOMINATORS. Broad100-A is 100 historical cases of which 98 have
 *    a valid source tree; Broad100-B's denominator is whatever survived its own
 *    integrity gate. §66 forbids comparing raw counts across them, so every
 *    causal population is reported as cases, repositories AND a rate over its own
 *    valid denominator.
 *
 * 2. DIFFERENT REPOSITORY MIX. Broad100-A is 44% django by construction;
 *    Broad100-B is balanced on purpose, because a corpus that spends half its
 *    cases on one repository cannot answer whether a mechanism is
 *    repository-general. That difference moves aggregate rates on its own, so the
 *    quality comparison is reported twice: raw, and with Broad100-B's per-repo
 *    rates reweighted to Broad100-A's mix. Neither number is "the" answer; the
 *    pair is.
 *
 * 3. REPOSITORY CONCENTRATION IS THE POINT. §56 says a ceiling that is still
 *    mostly one repository must not be built on, so the share of each causal
 *    population held by its largest repository — and sympy's share specifically —
 *    is computed for both corpora rather than left to be eyeballed off a list.
 *
 * Reads committed artifacts only. NO agent, NO Docker, NO network, NO indexing.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const RESULTS = path.join(import.meta.dir, "results");

interface TaxonomyEntry {
  readonly firstDivergence: string;
  readonly cases: number;
  readonly repos: readonly string[];
  readonly repoCount: number;
  readonly instances: readonly string[];
}

interface TaxonomyDoc {
  readonly residualCases: number;
  readonly localized: number;
  readonly unexplained: number;
  readonly taxonomy: readonly TaxonomyEntry[];
}

/** §113 — how much of a population one repository owns. */
export function concentration(
  entry: TaxonomyEntry,
  instanceRepo: ReadonlyMap<string, string>,
): { largestRepo: string | null; largestShare: number; sympyShare: number } {
  const counts = new Map<string, number>();
  for (const instance of entry.instances) {
    const repo = instanceRepo.get(instance) ?? "unknown";
    counts.set(repo, (counts.get(repo) ?? 0) + 1);
  }
  const total = entry.instances.length;
  if (total === 0) return { largestRepo: null, largestShare: 0, sympyShare: 0 };
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const [largestRepo, largestCount] = ranked[0]!;
  return {
    largestRepo,
    largestShare: Number((largestCount / total).toFixed(3)),
    sympyShare: Number(((counts.get("sympy/sympy") ?? 0) / total).toFixed(3)),
  };
}

/**
 * §64 — Broad100-B's per-repository rates, reweighted to Broad100-A's repository
 * mix. Repositories absent from B contribute nothing and their weight is
 * reported, because a reweighting that quietly drops a fifth of the target mix is
 * worse than no reweighting at all.
 */
export function reweightToMix(
  byRepoB: Record<string, Record<string, number>>,
  mixA: Record<string, number>,
  metric: string,
): { value: number; coveredWeight: number; missingRepos: string[] } {
  const totalA = Object.values(mixA).reduce((sum, value) => sum + value, 0);
  let weighted = 0;
  let covered = 0;
  const missing: string[] = [];
  for (const [repo, weight] of Object.entries(mixA)) {
    const summary = byRepoB[repo];
    if (summary === undefined || (summary.evaluated ?? 0) === 0) {
      missing.push(repo);
      continue;
    }
    weighted += (weight / totalA) * (summary[metric] ?? 0);
    covered += weight / totalA;
  }
  return {
    value: covered === 0 ? 0 : Number((weighted / covered).toFixed(4)),
    coveredWeight: Number(covered.toFixed(4)),
    missingRepos: missing.sort(),
  };
}

interface Config {
  readonly aMetrics: string;
  readonly aGoldFate: string;
  readonly aTaxonomy: string;
  readonly aManifest: string;
  readonly bResults: string;
  readonly bGoldFate: string;
  readonly bTaxonomy: string;
  readonly bManifest: string;
  readonly out: string;
}

export function parseArgs(argv: readonly string[]): Config {
  const config: Record<string, string> = {
    aMetrics: path.join(RESULTS, "stage5_m158_broad100_comparison.json"),
    aGoldFate: path.join(RESULTS, "stage5_m159_gold_fate_reconstruction.json"),
    aTaxonomy: path.join(RESULTS, "stage5_m159_first_divergence_taxonomy.json"),
    aManifest: path.join(RESULTS, "stage5_m160_broad100a_manifest.json"),
    bResults: path.join(RESULTS, "stage5_m160_broad100b_results.json"),
    bGoldFate: path.join(RESULTS, "stage5_m160_broad100b_gold_fate.json"),
    bTaxonomy: path.join(RESULTS, "stage5_m160_broad100b_first_divergence.json"),
    bManifest: path.join(RESULTS, "stage5_m160_broad100b_manifest.json"),
    out: path.join(RESULTS, "stage5_m160_cross_corpus_comparison.json"),
  };
  const flags: Record<string, string> = {
    "--a-metrics": "aMetrics",
    "--a-gold-fate": "aGoldFate",
    "--a-taxonomy": "aTaxonomy",
    "--a-manifest": "aManifest",
    "--b-results": "bResults",
    "--b-gold-fate": "bGoldFate",
    "--b-taxonomy": "bTaxonomy",
    "--b-manifest": "bManifest",
    "--out": "out",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = flags[argv[i]!];
    if (key === undefined) throw new Error(`Unknown argument ${argv[i]}`);
    const value = argv[(i += 1)];
    if (value === undefined) throw new Error(`${argv[i - 1]} requires a value`);
    config[key] = value;
  }
  return config as unknown as Config;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function main(config: Config): Promise<void> {
  const aMetricsDoc = await readJson<{ candidate: { summary: Record<string, number> } }>(config.aMetrics);
  const aGoldFate = await readJson<{ counts: Record<string, number> }>(config.aGoldFate);
  const aTaxonomy = await readJson<TaxonomyDoc>(config.aTaxonomy);
  const aManifest = await readJson<{ instanceIds: string[]; repositories: Record<string, number>; caseCount: number }>(
    config.aManifest,
  );
  const bResults = await readJson<{
    overall: Record<string, number>;
    byRepo: Record<string, Record<string, number>>;
    denominators: Record<string, unknown>;
  }>(config.bResults);
  const bGoldFate = await readJson<{ counts: Record<string, number> }>(config.bGoldFate);
  const bTaxonomy = await readJson<TaxonomyDoc>(config.bTaxonomy);
  const bManifest = await readJson<{
    cases: Array<{ instanceId: string; repo: string }>;
    repositories: Record<string, number>;
    caseCount: number;
  }>(config.bManifest);

  // §67 — Broad100-A keeps its historical denominator AND carries its qualified one.
  const A_INVALID = ["django__django-13590", "django__django-15572"];
  const aValid = aManifest.caseCount - A_INVALID.length;
  const bValid = Number(bResults.denominators.evaluatedCases ?? 0);

  const repoA = new Map<string, string>();
  for (const id of aManifest.instanceIds) {
    // Instance ids are `<owner>__<repo>-<n>`; the manifest's repo distribution is
    // authoritative, so derive the repo from the id's owner__repo prefix.
    const slug = id.slice(0, id.lastIndexOf("-"));
    const repo = Object.keys(aManifest.repositories).find((r) => r.replace("/", "__") === slug.replace(/-\d+$/, ""));
    repoA.set(id, repo ?? slug.replace("__", "/"));
  }
  const repoB = new Map(bManifest.cases.map((c) => [c.instanceId, c.repo]));

  const aSummary = aMetricsDoc.candidate.summary;
  const bSummary = bResults.overall;
  const QUALITY_METRICS = [
    "goldFileTop1",
    "goldFileTop3",
    "goldFileAnywhere",
    "goldSymbolAnywhere",
    "goldDelivered",
    "goldDiscarded",
    "goldMissing",
    "emptyContexts",
    "pivotContexts",
    "tokensMean",
    "tokensMedian",
    "tokensP90",
  ];

  const quality = QUALITY_METRICS.map((metric) => {
    const reweighted = reweightToMix(bResults.byRepo, aManifest.repositories, metric);
    return {
      metric,
      broad100a: aSummary[metric] ?? null,
      broad100b: bSummary[metric] ?? null,
      broad100bReweightedToAMix: reweighted.value,
      reweightCoveredWeight: reweighted.coveredWeight,
      reweightMissingRepos: reweighted.missingRepos,
    };
  });

  const allClasses = [
    ...new Set([
      ...aTaxonomy.taxonomy.map((entry) => entry.firstDivergence),
      ...bTaxonomy.taxonomy.map((entry) => entry.firstDivergence),
    ]),
  ].sort();

  const failureTaxonomy = allClasses.map((cls) => {
    const a = aTaxonomy.taxonomy.find((entry) => entry.firstDivergence === cls);
    const b = bTaxonomy.taxonomy.find((entry) => entry.firstDivergence === cls);
    return {
      firstDivergence: cls,
      broad100a: {
        cases: a?.cases ?? 0,
        repoCount: a?.repoCount ?? 0,
        repos: a?.repos ?? [],
        rateOverValid: Number(((a?.cases ?? 0) / aValid).toFixed(4)),
        concentration: a ? concentration(a, repoA) : null,
      },
      broad100b: {
        cases: b?.cases ?? 0,
        repoCount: b?.repoCount ?? 0,
        repos: b?.repos ?? [],
        rateOverValid: bValid === 0 ? 0 : Number(((b?.cases ?? 0) / bValid).toFixed(4)),
        concentration: b ? concentration(b, repoB) : null,
      },
    };
  }).sort((x, y) => y.broad100b.cases - x.broad100b.cases || y.broad100a.cases - x.broad100a.cases);

  const doc = {
    schemaVersion: "stage5.m160.cross-corpus-comparison.v1",
    milestone: "M160",
    kind: "Broad100-A vs Broad100-B, with denominators and repository mix stated rather than assumed",
    denominators: {
      broad100aHistorical: aManifest.caseCount,
      broad100aIntegrityQualified: aValid,
      broad100aInvalidInstances: A_INVALID,
      broad100aNote:
        "§67 — the historical 79/100 is never rewritten. The qualified denominator is stated beside it " +
        "and used for claims about VTRACE causal retrieval failure.",
      broad100bValid: bValid,
      comparableRawCounts: false,
    },
    repositoryMix: {
      broad100a: aManifest.repositories,
      broad100b: bManifest.repositories,
      note:
        "Broad100-B is balanced by construction (§18). Aggregate rate differences therefore mix a " +
        "retrieval effect with a corpus-composition effect, which is why the reweighted column exists.",
    },
    quality,
    goldFate: {
      broad100a: aGoldFate.counts,
      broad100b: bGoldFate.counts,
    },
    failureTaxonomy,
    replicationInputs: {
      broad100aResiduals: aTaxonomy.residualCases,
      broad100aUnexplained: aTaxonomy.unexplained,
      broad100bResiduals: bTaxonomy.residualCases,
      broad100bUnexplained: bTaxonomy.unexplained,
    },
  };

  await writeFile(config.out, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  console.log(`cross-corpus comparison written: ${path.relative(REPO_ROOT, config.out)}`);
  for (const row of failureTaxonomy) {
    console.log(
      `  ${row.firstDivergence.padEnd(34)} A ${String(row.broad100a.cases).padStart(2)}/${row.broad100a.repoCount} repos` +
        `   B ${String(row.broad100b.cases).padStart(2)}/${row.broad100b.repoCount} repos`,
    );
  }
}

if (import.meta.main) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
