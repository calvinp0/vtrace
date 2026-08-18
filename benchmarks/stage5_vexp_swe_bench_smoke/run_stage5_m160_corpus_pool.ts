/**
 * M160-A §21-§22 — reconstruct Broad100-A's identity and build the unconsumed
 * Broad100-B candidate pool.
 *
 * ORDER MATTERS. Broad100-A's exact membership is recovered mechanically from
 * the committed fixture first (§21), because that set is the authority every
 * later disjointness claim rests on; a summary from a conversation is not
 * evidence. The candidate pool is then `Verified − Broad100-A − ineligible`,
 * with the counts at every stage recorded so the exclusion rate can never be
 * hidden behind a round hundred (§17).
 *
 * Broad100-A turns out to be exactly the 100 rows of the vexp harness's
 * `swe-bench-100.jsonl`, so the "remaining eligible population" is empty in that
 * file. It exists only because Broad100-A is a strict subset of SWE-bench
 * Verified — which keeps Broad100-B inside the same benchmark family (§12).
 *
 * Eligibility here is METADATA-ONLY: it never looks at a checkout, an index or a
 * retrieval result. The source-tree integrity gate is a separate, later stage
 * (§8, §23) so the two kinds of exclusion stay distinguishable.
 *
 * NO Claude, NO Docker, NO agent run, NO API calls, NO network.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { collectFixtureProvenance, hashStable } from "./benchmarkProvenance";
import { extractLabelsFromPatch } from "./build_stage5_retrieval_fixture";
import { loadRetrievalFixture } from "./run_stage5_retrieval_eval";
import {
  createdFilesInPatch,
  withinArchiveSubtree,
  type PoolCandidate,
  type PoolExclusion,
  type VerifiedInstance,
} from "./m160Corpus";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const RESULTS = path.join(import.meta.dir, "results");
const DEFAULT_VERIFIED = path.join(RESULTS, "_m160_corpus", "swe_bench_verified.jsonl");
const DEFAULT_BROAD_A = path.join(import.meta.dir, "retrieval_eval.m155_broad_100.json");
const DEFAULT_BENCH_REPOS_ROOT = "/home/calvin/code/vexp-swe-bench/.bench-repos";

/** `django/django` -> `django__django`, the on-disk bench clone name. */
export function benchCloneName(repo: string): string {
  return repo.replace("/", "__");
}

export async function loadVerified(filePath: string): Promise<VerifiedInstance[]> {
  const content = await readFile(filePath, "utf8").catch(() => null);
  if (content === null) {
    throw new Error(
      `SWE-bench Verified corpus not found at ${filePath}. Materialize it first:\n` +
        `  uv run --with pyarrow python benchmarks/stage5_vexp_swe_bench_smoke/m160_extract_swe_bench_verified.py --out ${filePath}`,
    );
  }
  const rows: VerifiedInstance[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const record = JSON.parse(trimmed) as Record<string, unknown>;
    rows.push({
      instance_id: String(record.instance_id ?? ""),
      repo: String(record.repo ?? ""),
      base_commit: String(record.base_commit ?? ""),
      patch: String(record.patch ?? ""),
      problem_statement: String(record.problem_statement ?? ""),
      difficulty: String(record.difficulty ?? "unknown"),
    });
  }
  return rows;
}

export interface PoolBuild {
  readonly candidates: readonly PoolCandidate[];
  readonly exclusions: readonly PoolExclusion[];
}

/**
 * §22 — the pool, with every drop reasoned. A row is ineligible when it is in
 * Broad100-A, has no local bench clone to check out from, carries no gold source
 * file, has no problem statement to derive a task from, or names no base commit.
 */
export function buildCandidatePool(
  verified: readonly VerifiedInstance[],
  broadA: ReadonlySet<string>,
  benchReposRoot: string,
): PoolBuild {
  const candidates: PoolCandidate[] = [];
  const exclusions: PoolExclusion[] = [];
  for (const row of [...verified].sort((a, b) => (a.instance_id < b.instance_id ? -1 : 1))) {
    const drop = (reason: PoolExclusion["reason"], detail: string): void => {
      exclusions.push({ instanceId: row.instance_id, repo: row.repo, reason, detail });
    };
    if (broadA.has(row.instance_id)) {
      drop("IN_BROAD100A", "already consumed as Broad100-A development evidence");
      continue;
    }
    if (!existsSync(path.join(benchReposRoot, benchCloneName(row.repo)))) {
      drop("NO_LOCAL_BENCH_CLONE", `no clone at ${benchCloneName(row.repo)}`);
      continue;
    }
    if (row.base_commit.trim().length === 0) {
      drop("MISSING_BASE_COMMIT", "empty base_commit");
      continue;
    }
    if (row.problem_statement.trim().length === 0) {
      drop("EMPTY_PROBLEM_STATEMENT", "no problem statement to derive a task from");
      continue;
    }
    const labels = extractLabelsFromPatch(row.patch);
    if (labels.expected_files.length === 0) {
      drop("NO_GOLD_FILES", "reference patch yields no expected file");
      continue;
    }
    // A gold file outside the archived subtree can never reach the index, so an
    // instance with no gold inside it is unretrievable by construction and must
    // never become an INDEX_FILE_MISSING statistic (§80).
    const inScope = labels.expected_files.filter((file) => withinArchiveSubtree(row.repo, file));
    if (inScope.length === 0) {
      drop(
        "GOLD_OUTSIDE_INDEXED_SUBTREE",
        `no gold file inside the archived subtree for ${row.repo}: ${labels.expected_files.join(", ")}`,
      );
      continue;
    }
    const created = new Set(createdFilesInPatch(row.patch));
    const goldCreated = labels.expected_files.filter((file) => created.has(file));
    if (goldCreated.length === labels.expected_files.length) {
      drop(
        "GOLD_ONLY_CREATED_BY_PATCH",
        `every gold file is created by the patch and cannot exist at the base commit: ${goldCreated.join(", ")}`,
      );
      continue;
    }
    candidates.push({
      instanceId: row.instance_id,
      repo: row.repo,
      baseCommit: row.base_commit,
      difficulty: row.difficulty,
      expectedFiles: labels.expected_files,
      expectedSymbols: labels.expected_symbols,
      goldFilesCreatedByPatch: goldCreated,
    });
  }
  return { candidates, exclusions };
}

function distribution(values: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1)));
}

interface Config {
  readonly verified: string;
  readonly broadA: string;
  readonly benchReposRoot: string;
  readonly out: string;
}

export function parseArgs(argv: readonly string[]): Config {
  let verified = DEFAULT_VERIFIED;
  let broadA = DEFAULT_BROAD_A;
  let benchReposRoot = DEFAULT_BENCH_REPOS_ROOT;
  let out = RESULTS;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string => {
      const next = argv[(i += 1)];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--verified") verified = value();
    else if (arg === "--broad-a") broadA = value();
    else if (arg === "--bench-repos-root") benchReposRoot = value();
    else if (arg === "--out") out = value();
    else throw new Error(`Unknown argument ${arg}`);
  }
  return { verified, broadA, benchReposRoot, out };
}

async function main(config: Config): Promise<void> {
  const entries = await loadRetrievalFixture(config.broadA);
  const provenance = await collectFixtureProvenance(REPO_ROOT, config.broadA, entries);
  const broadAIds = entries.map((entry) => entry.instance_id).sort();

  const broadAManifest = {
    schemaVersion: "stage5.m160.broad100a-manifest.v1",
    milestone: "M160",
    kind: "mechanically reconstructed Broad100-A identity (§21)",
    reconstructedFrom: path.relative(REPO_ROOT, path.resolve(config.broadA)),
    note:
      "Recovered from the committed fixture, not from any narrative summary. This set is the " +
      "authority for the §11 disjointness assertion.",
    caseCount: broadAIds.length,
    fixtureSha256: provenance.hash,
    taskOrderHash: provenance.taskOrderHash,
    goldLabelHash: provenance.goldLabelHash,
    manifestHash: hashStable(broadAIds),
    repositories: distribution(entries.map((entry) => entry.repo)),
    instanceIds: broadAIds,
  };

  const verified = await loadVerified(config.verified);
  const verifiedBytes = await readFile(config.verified);
  const { candidates, exclusions } = buildCandidatePool(verified, new Set(broadAIds), config.benchReposRoot);

  const inVerified = verified.filter((row) => broadAIds.includes(row.instance_id)).length;
  const pool = {
    schemaVersion: "stage5.m160.broad100b-candidate-pool.v1",
    milestone: "M160",
    kind: "unconsumed SWE-bench Verified population, before the source-tree integrity gate (§22)",
    source: {
      family: "princeton-nlp/SWE-bench_Verified",
      materializedBy: "benchmarks/stage5_vexp_swe_bench_smoke/m160_extract_swe_bench_verified.py",
      path: path.relative(REPO_ROOT, path.resolve(config.verified)),
      sha256: hashStable([verifiedBytes.toString("utf8")]),
      rows: verified.length,
      committed: false,
      note: "raw corpus artifact — hashed here, never staged",
    },
    broad100aWithinVerified: {
      overlap: inVerified,
      strictSubset: inVerified === broadAIds.length,
      note:
        "Broad100-A is exactly the vexp harness swe-bench-100.jsonl and is a strict subset of " +
        "Verified, so Broad100-B stays in the same benchmark family (§12) and no VEXP " +
        "equivalence is claimed (§15).",
    },
    counts: {
      verifiedRows: verified.length,
      excludedInBroad100A: exclusions.filter((e) => e.reason === "IN_BROAD100A").length,
      excludedIneligible: exclusions.filter((e) => e.reason !== "IN_BROAD100A").length,
      eligibleBeforeIntegrityGate: candidates.length,
    },
    metadataExclusions: exclusions.filter((e) => e.reason !== "IN_BROAD100A"),
    repositories: distribution(candidates.map((c) => c.repo)),
    difficulties: distribution(candidates.map((c) => c.difficulty)),
    poolHash: hashStable(candidates.map((c) => c.instanceId)),
    candidates,
  };

  const aPath = path.join(config.out, "stage5_m160_broad100a_manifest.json");
  const poolPath = path.join(config.out, "stage5_m160_broad100b_candidate_pool.json");
  await writeFile(aPath, `${JSON.stringify(broadAManifest, null, 2)}\n`, "utf8");
  await writeFile(poolPath, `${JSON.stringify(pool, null, 2)}\n`, "utf8");

  console.log(`Broad100-A: ${broadAIds.length} cases, manifest hash ${broadAManifest.manifestHash.slice(0, 12)}`);
  console.log(`Verified rows: ${verified.length}; strict superset of Broad100-A: ${pool.broad100aWithinVerified.strictSubset}`);
  console.log(`Eligible pool before integrity gate: ${candidates.length}`);
  console.log(`Metadata exclusions: ${pool.counts.excludedIneligible}`);
  console.log(`  ${aPath}`);
  console.log(`  ${poolPath}`);
}

if (import.meta.main) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
