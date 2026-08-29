/**
 * M183-B — freeze the task manifest before any paid call exists.
 *
 *   bun run_stage5_m183_sample.ts
 *
 * SOURCE POOL. Broad100-A, the mechanically reconstructed VEXP-compatible
 * hundred (§20/§21). Its provenance — twelve repositories, proportional
 * allocation, complexity quintiles, seed 42, complexity ceiling <=250 — belongs
 * to VEXP's published rules and is preserved rather than reinvented. M183 draws
 * FROM it and claims no head-to-head equivalence with VEXP.
 *
 * TWO STRATA (§17).
 *
 *   replication   the twelve M173 tasks, verbatim, so §129 has a direct
 *                 historical comparison at the same instance ids
 *   extension     eighteen drawn from the remaining eighty-eight, stratified by
 *                 repository and then by SWE-bench difficulty tier
 *
 * The extension seed is M183's own. Broad100-A's seed 42 already produced the
 * pool; reusing it here would be numerology, not reproducibility.
 *
 * WHAT MAKES THIS A FREEZE. The manifest is written with a hash over the
 * ordered instance ids, the arm order and the selection inputs. §14 forbids
 * changing it after live outcomes exist; the hash is what makes a change
 * detectable rather than deniable.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildSchedule, selectExtensionSample, sha256, type SampleCandidate } from "./m183Treatment";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const CORPUS = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");
const BROAD100A = path.join(RESULTS, "stage5_m160_broad100a_manifest.json");
const M173_SCHEDULE = path.join(RESULTS, "stage5_m173_schedule.json");

export const M183_EXTENSION_SEED = "M183-extension/v1";
export const M183_EXTENSION_SIZE = 18;
export const M183_PLANNED_PAIRS = 30;

interface CorpusRow {
  readonly instance_id: string;
  readonly repo: string;
  readonly difficulty: string;
  readonly problem_statement: string;
  readonly base_commit: string;
  readonly patch: string;
}

function main(): void {
  const corpus = new Map<string, CorpusRow>();
  for (const line of readFileSync(CORPUS, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line) as CorpusRow;
    corpus.set(row.instance_id, row);
  }

  const broad100a: readonly string[] =
    JSON.parse(readFileSync(BROAD100A, "utf8")).instanceIds;
  const replication: readonly string[] =
    (JSON.parse(readFileSync(M173_SCHEDULE, "utf8")).schedule as { instanceId: string }[])
      .map((r) => r.instanceId);

  // §17's disjointness is asserted, not assumed.
  const inPool = replication.filter((id) => broad100a.includes(id));
  if (inPool.length !== replication.length) {
    throw new Error(`replication stratum is not inside Broad100-A: ${replication.filter((id) => !broad100a.includes(id))}`);
  }

  const remaining = broad100a.filter((id) => !replication.includes(id)).sort();
  const candidates: SampleCandidate[] = remaining.map((id) => {
    const row = corpus.get(id);
    if (row === undefined) throw new Error(`instance absent from the corpus: ${id}`);
    return { instanceId: id, repo: row.repo, difficulty: row.difficulty };
  });

  const extension = selectExtensionSample(candidates, M183_EXTENSION_SIZE, M183_EXTENSION_SEED);
  if (extension.length !== M183_EXTENSION_SIZE) {
    throw new Error(`extension draw returned ${extension.length}, expected ${M183_EXTENSION_SIZE}`);
  }
  if (extension.some((id) => replication.includes(id))) {
    throw new Error("extension overlaps the replication stratum");
  }

  // Execution order interleaves the strata so a provider drift or a machine
  // change mid-sweep cannot land entirely on one stratum and be mistaken for a
  // replication effect. Deterministic: replication by M173's own order, the
  // extension by sorted id, zipped.
  const ordered: string[] = [];
  const maxLen = Math.max(replication.length, extension.length);
  for (let i = 0; i < maxLen; i += 1) {
    if (i < replication.length) ordered.push(replication[i]!);
    if (i < extension.length) ordered.push(extension[i]!);
  }
  if (ordered.length !== M183_PLANNED_PAIRS) {
    throw new Error(`planned pairs ${ordered.length} != ${M183_PLANNED_PAIRS}`);
  }

  const schedule = buildSchedule(ordered);
  const stratumOf = (id: string): string => (replication.includes(id) ? "replication" : "extension");

  const repoCounts: Record<string, number> = {};
  const difficultyCounts: Record<string, number> = {};
  for (const id of ordered) {
    const row = corpus.get(id)!;
    repoCounts[row.repo] = (repoCounts[row.repo] ?? 0) + 1;
    difficultyCounts[row.difficulty] = (difficultyCounts[row.difficulty] ?? 0) + 1;
  }

  const candidatesDoc = {
    schemaVersion: "stage5.m183.sample-candidates.v1",
    milestone: "M183",
    workstream: "M183-B",
    sourcePool: {
      name: "Broad100-A",
      manifest: path.relative(process.cwd(), BROAD100A),
      caseCount: broad100a.length,
      provenance: "VEXP-compatible selection rules preserved from M160's mechanical reconstruction (§21): 12 repositories, proportional allocation, complexity quintiles, seed 42, complexity ceiling <=250. M183 does not re-derive them.",
    },
    inclusion: "every Broad100-A instance not in the M173 replication stratum",
    exclusion: "the 12 M173 instances, which enter through the replication stratum instead",
    candidateCount: candidates.length,
    seed: M183_EXTENSION_SEED,
    stratification: "repository (largest-remainder proportional), then SWE-bench difficulty tier within repository (largest-remainder proportional), then SHA-256(seed:instanceId) order within tier",
    candidates,
  };

  const manifest = {
    schemaVersion: "stage5.m183.sample-manifest.v1",
    milestone: "M183",
    workstream: "M183-B",
    frozenBeforeAnyLiveRun: true,
    plannedPairs: M183_PLANNED_PAIRS,
    plannedArms: M183_PLANNED_PAIRS * 2,
    strata: {
      replication: { size: replication.length, source: "the M173 frozen twelve, verbatim", instanceIds: replication },
      extension: { size: extension.length, source: "Broad100-A minus M173", seed: M183_EXTENSION_SEED, instanceIds: [...extension] },
    },
    executionOrder: ordered.map((id, i) => ({
      order: i + 1,
      instanceId: id,
      repo: corpus.get(id)!.repo,
      difficulty: corpus.get(id)!.difficulty,
      stratum: stratumOf(id),
      m173Overlap: replication.includes(id),
      baseCommit: corpus.get(id)!.base_commit,
    })),
    repositoryCounts: repoCounts,
    difficultyCounts,
    replacementPolicy: "§14/§29 — an instance leaves the manifest ONLY for a protocol reason (workspace preparation failed, index invalid at treatment start, grader infrastructure unavailable). It is then recorded as EXCLUDED with the reason and NOT replaced: replacing it after outcomes exist would let the sample follow the results.",
  };

  const sampleHash = {
    schemaVersion: "stage5.m183.sample-hash.v1",
    milestone: "M183",
    instanceOrderHash: sha256(ordered.join("\n")),
    replicationHash: sha256([...replication].join("\n")),
    extensionHash: sha256([...extension].join("\n")),
    scheduleHash: sha256(JSON.stringify(schedule)),
    manifestHash: sha256(JSON.stringify(manifest)),
    seed: M183_EXTENSION_SEED,
    note: "Recomputed by run_stage5_m183_sample.ts. A manifest edited after launch changes manifestHash and is detectable.",
  };

  const pairOrder = {
    schemaVersion: "stage5.m183.pair-order.v1",
    milestone: "M183",
    workstream: "M183-B",
    scheduling: "arm order alternates by execution position, so neither arm systematically owns the first attempt at a freshly prepared workspace or the earlier half of the execution window",
    frozenBeforeExecution: true,
    balance: {
      baselineFirst: schedule.filter((r) => r.armOrder[0] === "baseline").length,
      treatmentFirst: schedule.filter((r) => r.armOrder[0] !== "baseline").length,
    },
    sequential: "REQUIRED — the first pass writes a shared results/_agent_stream.jsonl",
    schedule: schedule.map((r) => ({ ...r, armOrder: [...r.armOrder], stratum: stratumOf(r.instanceId) })),
  };

  const write = (name: string, doc: unknown): void => {
    writeFileSync(path.join(RESULTS, name), `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`  wrote results/${name}`);
  };
  write("stage5_m183_sample_candidates.json", candidatesDoc);
  write("stage5_m183_sample_manifest.json", manifest);
  write("stage5_m183_sample_hash.json", sampleHash);
  write("stage5_m183_pair_order.json", pairOrder);

  console.log(`\nM183 sample frozen: ${ordered.length} pairs (${replication.length} replication + ${extension.length} extension)`);
  console.log(`  repositories: ${Object.entries(repoCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.split("/")[1]}=${v}`).join(" ")}`);
  console.log(`  difficulty:   ${Object.entries(difficultyCounts).sort().map(([k, v]) => `${k}=${v}`).join("  ")}`);
  console.log(`  arm order:    baseline-first ${pairOrder.balance.baselineFirst} / treatment-first ${pairOrder.balance.treatmentFirst}`);
  console.log(`  manifestHash: ${sampleHash.manifestHash}`);
}

main();
