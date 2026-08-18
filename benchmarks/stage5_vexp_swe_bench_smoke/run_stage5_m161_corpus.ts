/**
 * M161-A §10-§17, §45-§46 — freeze the fresh paired live-utility corpus.
 *
 * OFFLINE. No agent, no Docker, no network, no VTRACE. This script reads
 * benchmark metadata and writes manifests; it must run to completion before any
 * retrieval or agent execution touches an M161 instance (§17, §50).
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m161_corpus.ts
 *
 * Outputs, all under results/:
 *   stage5_m161_consumed_manifests.json  — Broad100-A ∪ B, reconstructed mechanically
 *   stage5_m161_eligible_pool.json       — the unconsumed population, every drop reasoned
 *   stage5_m161_paired30_manifest.json   — the frozen first live sample
 *   stage5_m161_extension_manifest.json  — paired100 + the predeclared reserve
 *   stage5_m161_arm_schedule.json        — which arm leads each case
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { hashStable } from "./benchmarkProvenance";
import {
  ALLOWED_REPLACEMENT_REASONS,
  M161_SELECTION_SALT,
  benchCloneName,
  buildArmSchedule,
  buildLivePool,
  manifestHash,
  scheduleHash,
  selectAndOrder,
  type LiveVerifiedInstance,
  type OrderedCase,
  type PoolCandidate,
} from "./m161Corpus";

const RESULTS = path.join(import.meta.dir, "results");
const VERIFIED = path.join(RESULTS, "_m160_corpus", "swe_bench_verified.jsonl");
const BROAD_A_MANIFEST = path.join(RESULTS, "stage5_m160_broad100a_manifest.json");
const BROAD_B_MANIFEST = path.join(RESULTS, "stage5_m160_broad100b_manifest.json");
const BENCH_REPOS = "/home/calvin/code/vexp-swe-bench/.bench-repos";

/** 100 live cases plus a 20-case predeclared reserve (§22). */
const EXTENSION_SIZE = 100;
const RESERVE_SIZE = 20;
const DRAW_SIZE = EXTENSION_SIZE + RESERVE_SIZE;
const PAIRED_SIZE = 30;

function parseFailToPass(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function loadVerified(filePath: string): Promise<{ rows: LiveVerifiedInstance[]; contentHash: string }> {
  const text = await Bun.file(filePath).text();
  const rows: LiveVerifiedInstance[] = [];
  for (const line of text.split("\n")) {
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
      failToPass: parseFailToPass(record.FAIL_TO_PASS),
    });
  }
  // The SAME binding M160 recorded for this file, so the two milestones are
  // provably reading identical bytes rather than both reading "SWE-bench Verified".
  return { rows, contentHash: hashStable([text]) };
}

function counts<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function repoShares(cases: readonly { repo: string }[]): { byRepo: Record<string, number>; shares: Record<string, number>; max: { repo: string; share: number } } {
  const byRepo = counts(cases, (c) => c.repo);
  const shares = Object.fromEntries(
    Object.entries(byRepo).map(([repo, n]) => [repo, Number((n / cases.length).toFixed(4))]),
  );
  const [topRepo, topShare] = Object.entries(shares).sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  return { byRepo, shares, max: { repo: topRepo, share: topShare } };
}

async function gitState(): Promise<Record<string, unknown>> {
  const run = async (args: string[]): Promise<string> => {
    const proc = Bun.spawn(["git", ...args], { cwd: path.join(import.meta.dir, "..", ".."), stdout: "pipe", stderr: "pipe" });
    return (await new Response(proc.stdout).text()).trim();
  };
  const srcDirty = await run(["status", "--porcelain", "src/"]);
  return {
    head: await run(["rev-parse", "HEAD"]),
    branch: await run(["rev-parse", "--abbrev-ref", "HEAD"]),
    treeHash: await run(["rev-parse", "HEAD^{tree}"]),
    srcClean: srcDirty.length === 0,
  };
}

async function main(): Promise<void> {
  await mkdir(RESULTS, { recursive: true });

  const { rows: verified, contentHash } = await loadVerified(VERIFIED);
  const broadA = new Set<string>((await Bun.file(BROAD_A_MANIFEST).json()).instanceIds as string[]);
  const broadBCases = (await Bun.file(BROAD_B_MANIFEST).json()).cases as { instanceId: string; repo: string }[];
  const broadB = new Set(broadBCases.map((c) => c.instanceId));

  // §10 — mechanical, never a summary. Both consumed sets must be real subsets of
  // the population M161 draws from, or "0 overlap" would be vacuous.
  const verifiedIds = new Set(verified.map((r) => r.instance_id));
  const aOutside = [...broadA].filter((id) => !verifiedIds.has(id)).sort();
  const bOutside = [...broadB].filter((id) => !verifiedIds.has(id)).sort();
  const abOverlap = [...broadA].filter((id) => broadB.has(id)).sort();
  if (aOutside.length > 0 || bOutside.length > 0) {
    throw new Error(`consumed sets are not subsets of the drawn population: A ${aOutside.length}, B ${bOutside.length}`);
  }

  const consumed = new Set([...broadA, ...broadB]);
  const pool = buildLivePool({
    verified,
    broadA,
    broadB,
    benchCloneExists: (repo) => existsSync(path.join(BENCH_REPOS, benchCloneName(repo))),
  });

  const { ordered, quotaByRepo, quotaByStratum } = selectAndOrder(pool.candidates, DRAW_SIZE);
  const paired30 = ordered.slice(0, PAIRED_SIZE);
  const paired100 = ordered.slice(0, EXTENSION_SIZE);
  const reserve = ordered.slice(EXTENSION_SIZE);

  // §11 — assert, do not assume.
  const overlapA = paired100.filter((c) => broadA.has(c.instance_id)).map((c) => c.instance_id);
  const overlapB = paired100.filter((c) => broadB.has(c.instance_id)).map((c) => c.instance_id);
  if (overlapA.length > 0 || overlapB.length > 0) {
    throw new Error(`fresh corpus overlaps consumed evidence: A ${overlapA.join(",")} B ${overlapB.join(",")}`);
  }
  if (!paired30.every((c) => paired100.some((p) => p.instance_id === c.instance_id))) {
    throw new Error("paired30 is not a prefix of the extension manifest");
  }

  const byId = new Map(pool.candidates.map((c) => [c.instanceId, c]));
  const decorate = (kase: OrderedCase): Record<string, unknown> => {
    const candidate = byId.get(kase.instance_id) as PoolCandidate;
    return {
      order: kase.order,
      instanceId: kase.instance_id,
      repo: kase.repo,
      difficulty: kase.difficulty,
      stratum: kase.stratum,
      baseCommit: candidate.baseCommit,
      expectedFiles: candidate.expectedFiles,
      goldFilesCreatedByPatch: candidate.goldFilesCreatedByPatch,
    };
  };

  const git = await gitState();
  const provenance = {
    milestone: "M161",
    workstream: "A",
    frozenAt: "2026-08-18",
    vtrace: git,
    population: {
      family: "princeton-nlp/SWE-bench_Verified",
      path: path.relative(path.join(import.meta.dir, "..", ".."), VERIFIED),
      rows: verified.length,
      contentHash,
      contentHashKind: "hashStable([fileContent]) — the SAME binding M160 recorded, reproduced here",
      committed: false,
    },
  };

  // -- consumed manifests ---------------------------------------------------
  await writeFile(
    path.join(RESULTS, "stage5_m161_consumed_manifests.json"),
    `${JSON.stringify({
      schemaVersion: "stage5.m161.consumed.v1",
      ...provenance,
      note: "Reconstructed mechanically from committed M160 manifests (§10), never from prose summaries.",
      broad100A: {
        source: "results/stage5_m160_broad100a_manifest.json",
        role: "development / audit corpus",
        count: broadA.size,
        subsetOfDrawnPopulation: aOutside.length === 0,
        instanceIds: [...broadA].sort(),
      },
      broad100B: {
        source: "results/stage5_m160_broad100b_manifest.json",
        role: "independent replication corpus",
        count: broadB.size,
        subsetOfDrawnPopulation: bOutside.length === 0,
        instanceIds: [...broadB].sort(),
      },
      union: { count: consumed.size, aBOverlap: abOverlap },
    }, null, 2)}\n`,
  );

  // -- eligible pool --------------------------------------------------------
  const poolRepo = repoShares(pool.candidates.map((c) => ({ repo: c.repo })));
  await writeFile(
    path.join(RESULTS, "stage5_m161_eligible_pool.json"),
    `${JSON.stringify({
      schemaVersion: "stage5.m161.eligible-pool.v1",
      ...provenance,
      kind: "unconsumed SWE-bench Verified population, before the source-tree integrity gate (§18)",
      exclusionPolicy: {
        note:
          "Benchmark-integrity exclusions ONLY. M160's GOLD_OUTSIDE_INDEXED_SUBTREE and " +
          "GOLD_ONLY_CREATED_BY_PATCH are deliberately NOT applied: the first describes M160's " +
          "archived-subtree workspace, which M161 does not build, and the second would drop exactly " +
          "the cases VTRACE cannot help with — conditioning the sample on treatment performance (§14).",
        reasons: [
          "IN_BROAD100A", "IN_BROAD100B", "NO_LOCAL_BENCH_CLONE", "MISSING_BASE_COMMIT",
          "EMPTY_PROBLEM_STATEMENT", "EMPTY_FAIL_TO_PASS", "NO_GOLD_FILES",
        ],
        knownPositiveControls: "benchmarks/stage5_vexp_swe_bench_smoke/m161Corpus.test.ts (§122/§123)",
      },
      counts: {
        verifiedRows: verified.length,
        consumedBroad100A: broadA.size,
        consumedBroad100B: broadB.size,
        consumedUnion: consumed.size,
        excludedByMetadata: pool.exclusions.filter((e) => e.reason !== "IN_BROAD100A" && e.reason !== "IN_BROAD100B").length,
        eligibleBeforeIntegrityGate: pool.candidates.length,
      },
      exclusionsByReason: counts(pool.exclusions, (e) => e.reason),
      metadataExclusions: pool.exclusions.filter((e) => e.reason !== "IN_BROAD100A" && e.reason !== "IN_BROAD100B"),
      repositories: poolRepo.byRepo,
      repositoryShares: poolRepo.shares,
      maxRepositoryShare: poolRepo.max,
      difficulties: counts(pool.candidates, (c) => c.difficulty),
      poolHash: hashStable(pool.candidates.map((c) => c.instanceId)),
      candidates: pool.candidates,
    }, null, 2)}\n`,
  );

  // -- paired30 -------------------------------------------------------------
  const paired30Repo = repoShares(paired30.map((c) => ({ repo: c.repo })));
  const selectionBlock = {
    method:
      "balanced repository water-fill over the eligible pool, difficulty split by largest remainder " +
      "within each repository, members drawn by sha256(salt:instance_id); then the M155 largest-deficit " +
      "ordering so any prefix is approximately proportional to the drawn sample",
    salt: M161_SELECTION_SALT,
    saltRationale:
      "a fixed permutation of the pool, so the sample does not depend on iteration order or draw count; " +
      "a NEW salt per milestone so M161 is not M160's sample offset",
    drawSize: DRAW_SIZE,
    difficultySource: "SWE-bench Verified human-annotated `difficulty` (pre-existing, treatment-independent)",
    conditionedOnTreatmentOutcome: false,
    independenceNote:
      "Selection consumes only instance id, repository and difficulty. Top-1, gold delivered/missing, " +
      "candidate count, latency, lead correctness and lane behaviour are excluded (§14); a test asserts " +
      "that adding them to every candidate changes nothing.",
  };
  await writeFile(
    path.join(RESULTS, "stage5_m161_paired30_manifest.json"),
    `${JSON.stringify({
      schemaVersion: "stage5.m161.paired30-manifest.v1",
      ...provenance,
      frozenBeforeAnyRetrievalOrAgent: true,
      caseCount: paired30.length,
      subsetOfExtensionManifest: true,
      selection: selectionBlock,
      disjointness: { overlapWithBroad100A: 0, overlapWithBroad100B: 0, assertedMechanically: true },
      repositories: paired30Repo.byRepo,
      repositoryShares: paired30Repo.shares,
      maxRepositoryShare: paired30Repo.max,
      difficulties: counts(paired30, (c) => c.difficulty),
      manifestHash: manifestHash(paired30.map((c) => ({ instanceId: c.instance_id, order: c.order }))),
      cases: paired30.map(decorate),
    }, null, 2)}\n`,
  );

  // -- extension + reserve --------------------------------------------------
  const paired100Repo = repoShares(paired100.map((c) => ({ repo: c.repo })));
  await writeFile(
    path.join(RESULTS, "stage5_m161_extension_manifest.json"),
    `${JSON.stringify({
      schemaVersion: "stage5.m161.extension-manifest.v1",
      ...provenance,
      frozenBeforeAnyRetrievalOrAgent: true,
      extensionRule:
        "The ordering over all drawn cases is frozen here (§13). Extending past 30 means running the " +
        "next cases in THIS order under the SAME frozen product (§106); it is never a fresh selection " +
        "and never a choice made after reading the first 30.",
      selection: selectionBlock,
      extension: {
        caseCount: paired100.length,
        repositories: paired100Repo.byRepo,
        maxRepositoryShare: paired100Repo.max,
        difficulties: counts(paired100, (c) => c.difficulty),
        manifestHash: manifestHash(paired100.map((c) => ({ instanceId: c.instance_id, order: c.order }))),
        cases: paired100.map(decorate),
      },
      reserve: {
        purpose: "predeclared replacements for CORPUS_INVALID cases (§21-§22)",
        caseCount: reserve.length,
        policy: {
          allowedReasons: ALLOWED_REPLACEMENT_REASONS,
          forbiddenReasons: [
            "VTRACE retrieval looks bad", "agent likely to fail", "repo is slow", "outcome is inconvenient",
          ],
          rule: "same repository first, then reserve rank; a consumed reserve case is never reused",
        },
        manifestHash: manifestHash(reserve.map((c) => ({ instanceId: c.instance_id, order: c.order }))),
        cases: reserve.map(decorate),
      },
      quotaByRepo: Object.fromEntries([...quotaByRepo].sort()),
      quotaByStratum: Object.fromEntries([...quotaByStratum].sort()),
    }, null, 2)}\n`,
  );

  // -- arm schedule ---------------------------------------------------------
  const schedule = buildArmSchedule(ordered.slice(0, EXTENSION_SIZE));
  const schedule30 = schedule.slice(0, PAIRED_SIZE);
  await writeFile(
    path.join(RESULTS, "stage5_m161_arm_schedule.json"),
    `${JSON.stringify({
      schemaVersion: "stage5.m161.arm-schedule.v1",
      ...provenance,
      frozenBeforeAnyExecution: true,
      rule:
        "Alternate the leading arm strictly by frozen rank: odd rank runs baseline first, even rank runs " +
        "VTRACE first (§45). Provider and environment drift over the run window then spreads across both " +
        "conditions. Because the rule is a function of rank alone it cannot be nudged after an outcome (§46).",
      paired30: {
        caseCount: schedule30.length,
        baselineLeads: schedule30.filter((c) => c.armOrder[0] === "baseline").length,
        vtraceLeads: schedule30.filter((c) => c.armOrder[0] === "vtrace").length,
        scheduleHash: scheduleHash(schedule30),
        schedule: schedule30,
      },
      extension100: { caseCount: schedule.length, scheduleHash: scheduleHash(schedule) },
    }, null, 2)}\n`,
  );

  console.log(`verified rows        ${verified.length}`);
  console.log(`consumed A ∪ B       ${consumed.size} (A ${broadA.size}, B ${broadB.size}, A∩B ${abOverlap.length})`);
  console.log(`eligible pool        ${pool.candidates.length}  (metadata drops ${pool.exclusions.filter((e) => !e.reason.startsWith("IN_BROAD")).length})`);
  console.log(`pool max repo share  ${poolRepo.max.repo} ${(poolRepo.max.share * 100).toFixed(1)}%`);
  console.log(`drawn                ${ordered.length} = ${paired100.length} extension + ${reserve.length} reserve`);
  console.log(`paired30 repos       ${Object.entries(paired30Repo.byRepo).map(([r, n]) => `${r.split("/")[1]}:${n}`).join(" ")}`);
  console.log(`paired30 max share   ${paired30Repo.max.repo} ${(paired30Repo.max.share * 100).toFixed(1)}%`);
  console.log(`paired30 hash        ${manifestHash(paired30.map((c) => ({ instanceId: c.instance_id, order: c.order })))}`);
  console.log(`schedule30 hash      ${scheduleHash(schedule30)}`);
}

if (import.meta.main) {
  await main();
}
