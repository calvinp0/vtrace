/**
 * M160-A §11, §13-§18, §27 — select and FREEZE Broad100-B.
 *
 * This runs after the integrity gate and before any retrieval, and that order is
 * the whole point: membership is a function of benchmark metadata and source-tree
 * validity only, so nothing about VTRACE's behaviour can have influenced who is
 * in the corpus (§13). Once the manifest is written its membership is fixed —
 * §99 makes changing it after seeing results a protocol FAIL, not a correction.
 *
 * The sample is BALANCED across repositories rather than proportional. Broad100-A
 * is 44% django; a proportional draw from the remaining Verified population would
 * be 47% django, and a corpus that spends half its cases on one repository cannot
 * answer the question M160 exists for — whether a causal mechanism is
 * repository-general (§19, §55) or one repository's habit (§56).
 *
 * NO Claude, NO Docker, NO agent run, NO API calls, NO network, NO index build.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { hashStable } from "./benchmarkProvenance";
import {
  assertDisjoint,
  selectCorpus,
  SELECTION_SALT,
  type PoolCandidate,
} from "./m160Corpus";
import type { IntegrityRow } from "./run_stage5_m160_corpus_integrity";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const RESULTS = path.join(import.meta.dir, "results");
const TARGET = 100;

function distribution(values: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1)));
}

function crossTab(rows: readonly PoolCandidate[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const row of [...rows].sort((a, b) => (a.repo < b.repo ? -1 : 1))) {
    const bucket = (out[row.repo] ??= {});
    bucket[row.difficulty] = (bucket[row.difficulty] ?? 0) + 1;
  }
  return out;
}

interface Config {
  readonly pool: string;
  readonly integrity: string;
  readonly broadA: string;
  readonly out: string;
  readonly target: number;
}

export function parseArgs(argv: readonly string[]): Config {
  let pool = path.join(RESULTS, "stage5_m160_broad100b_candidate_pool.json");
  let integrity = path.join(RESULTS, "stage5_m160_broad100b_integrity_audit.json");
  let broadA = path.join(RESULTS, "stage5_m160_broad100a_manifest.json");
  let out = RESULTS;
  let target = TARGET;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string => {
      const next = argv[(i += 1)];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--pool") pool = value();
    else if (arg === "--integrity") integrity = value();
    else if (arg === "--broad-a") broadA = value();
    else if (arg === "--out") out = value();
    else if (arg === "--target") target = Number(value());
    else throw new Error(`Unknown argument ${arg}`);
  }
  return { pool, integrity, broadA, out, target };
}

async function main(config: Config): Promise<void> {
  const poolDoc = JSON.parse(await readFile(config.pool, "utf8")) as {
    candidates: PoolCandidate[];
    counts: Record<string, number>;
  };
  const integrityDoc = JSON.parse(await readFile(config.integrity, "utf8")) as {
    rows: IntegrityRow[];
    counts: Record<string, number>;
  };
  const aDoc = JSON.parse(await readFile(config.broadA, "utf8")) as {
    instanceIds: string[];
    manifestHash: string;
    caseCount: number;
  };

  const validIds = new Set(
    integrityDoc.rows.filter((row) => row.verdict === "VALID").map((row) => row.instanceId),
  );
  if (integrityDoc.rows.length !== poolDoc.candidates.length) {
    throw new Error(
      `integrity audit covers ${integrityDoc.rows.length} of ${poolDoc.candidates.length} candidates — ` +
        `the gate must cover the whole pool before selection (§22)`,
    );
  }
  const eligible = poolDoc.candidates.filter((candidate) => validIds.has(candidate.instanceId));

  const { selected, quotaByRepo, quotaByStratum } = selectCorpus(eligible, config.target);

  // §11 — mechanical, never visual.
  const disjointness = assertDisjoint(aDoc.instanceIds, selected.map((c) => c.instanceId));
  if (!disjointness.disjoint) {
    throw new Error(`Broad100-B overlaps Broad100-A on ${disjointness.overlap.length}: ${disjointness.overlap.join(", ")}`);
  }

  const manifest = {
    schemaVersion: "stage5.m160.broad100b-manifest.v1",
    milestone: "M160",
    kind: "FROZEN independent broad retrieval corpus (§27)",
    frozenBeforeAnyRetrieval: true,
    family: "princeton-nlp/SWE-bench_Verified",
    vexpEquivalenceClaimed: false,
    vexpNote:
      "§15 — this reproduces neither VEXP's task list, sampling, model, budget nor agent protocol. " +
      "It is VTRACE-internal generalization evidence and is never described as a VEXP comparison.",
    caseCount: selected.length,
    target: config.target,
    selection: {
      algorithm:
        "balanced repository water-fill bounded by pool availability, then difficulty-proportional " +
        "strata within each repository by largest remainder, then a fixed hash permutation within " +
        "each stratum",
      salt: SELECTION_SALT,
      seedForm: "sha256(salt + ':' + instance_id) ascending — a fixed permutation, not a PRNG state",
      strata: ["repo", "difficulty"],
      strataSource: "SWE-bench Verified published metadata; nothing VTRACE produces (§13)",
      independentOfVtraceOutcomes: true,
    },
    population: {
      verifiedRows: poolDoc.counts.verifiedRows,
      excludedInBroad100A: poolDoc.counts.excludedInBroad100A,
      metadataIneligible: poolDoc.counts.excludedIneligible,
      candidatePool: poolDoc.candidates.length,
      integrityFailures: integrityDoc.counts.corpusInvalid,
      eligibleAfterIntegrityGate: eligible.length,
      selected: selected.length,
    },
    disjointness: {
      broad100aCases: disjointness.aCount,
      broad100bCases: disjointness.bCount,
      overlap: disjointness.overlap.length,
      disjoint: disjointness.disjoint,
      broad100aManifestHash: aDoc.manifestHash,
      assertedMechanically: true,
    },
    repositories: distribution(selected.map((c) => c.repo)),
    difficulties: distribution(selected.map((c) => c.difficulty)),
    repositoryByDifficulty: crossTab(selected),
    quotaByRepo: Object.fromEntries([...quotaByRepo].sort()),
    quotaByStratum: Object.fromEntries([...quotaByStratum].sort()),
    manifestHash: hashStable(selected.map((c) => c.instanceId)),
    goldLabelHash: hashStable(
      selected.map((c) => ({
        instanceId: c.instanceId,
        expectedFiles: c.expectedFiles,
        expectedSymbols: c.expectedSymbols,
      })),
    ),
    cases: selected,
  };

  const manifestPath = path.join(config.out, "stage5_m160_broad100b_manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(`Broad100-B frozen: ${selected.length} cases across ${Object.keys(manifest.repositories).length} repositories`);
  console.log(`  overlap with Broad100-A: ${disjointness.overlap.length}`);
  console.log(`  manifest hash: ${manifest.manifestHash}`);
  console.log(`  ${path.relative(REPO_ROOT, manifestPath)}`);
  for (const [repo, count] of Object.entries(manifest.repositories)) console.log(`    ${repo}: ${count}`);
}

if (import.meta.main) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
