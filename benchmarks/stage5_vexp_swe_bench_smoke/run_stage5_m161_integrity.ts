/**
 * M161-A §18-§22 — source-tree integrity gate, before any paid execution.
 *
 * NETWORK ONLY. No agent, no Docker, no VTRACE, no money. It fetches base commits
 * into the shared bench clones and verifies each instance's source tree against
 * `git ls-tree`, so a half-extracted or unavailable revision is classified
 * CORPUS_INVALID *before* an agent is ever spawned on it.
 *
 * WHY THIS EXISTS
 * ---------------
 * M160 reproduced the failure this gate prevents: a `git fetch` repacking a shared
 * bench clone while a `git archive` streamed out of it produced django-12741 at
 * 1902 of 3381 paths with `tar` exiting 0. An index over a half-tree builds
 * perfectly well, so nothing downstream can notice, and the result presents as a
 * retrieval failure. Two rules follow and neither may be relaxed for throughput
 * (§126):
 *
 *   1. SERIAL against any one clone. Concurrency across repositories is fine;
 *      concurrency within one is what corrupts.
 *   2. Verify per PATH against `git ls-tree`, never a spot check. Milliseconds.
 *
 * And M160's other lesson (§“one attempt is not a measurement”): its first gate run
 * declared 16 instances CORPUS_INVALID across 8 unrelated repositories and every
 * one fetched on a manual retry seconds later. A probe whose failure mode is
 * indistinguishable from a finding must retry before it is allowed to conclude.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m161_integrity.ts \
 *     [--scope paired30|live|extension|all]
 *
 * `live` (the default) gates the frozen 30 plus the predeclared reserve — exactly
 * what the first live phase can consume.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { hashStable } from "./benchmarkProvenance";
import { benchCloneName } from "./m161Corpus";

const RESULTS = path.join(import.meta.dir, "results");
const PAIRED30 = path.join(RESULTS, "stage5_m161_paired30_manifest.json");
const EXTENSION = path.join(RESULTS, "stage5_m161_extension_manifest.json");
const BENCH_REPOS = "/home/calvin/code/vexp-swe-bench/.bench-repos";

const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [0, 3_000, 10_000, 30_000];

export type IntegrityStatus = "VALID" | "CORPUS_INVALID";

export type IntegrityFailure =
  | "SOURCE_REVISION_UNAVAILABLE"
  | "GOLD_FIXTURE_ABSENT_FROM_CHECKOUT"
  | "TREE_UNREADABLE";

export interface IntegrityRecord {
  readonly instanceId: string;
  readonly repo: string;
  readonly baseCommit: string;
  readonly status: IntegrityStatus;
  readonly failure: IntegrityFailure | null;
  readonly detail: string;
  readonly attempts: number;
  readonly commitResolved: boolean;
  readonly treePaths: number;
  readonly treeHash: string | null;
  /** Gold files the reference patch does NOT create; these MUST exist at base. */
  readonly requiredGoldFiles: readonly string[];
  readonly missingGoldFiles: readonly string[];
}

interface Case {
  readonly instanceId: string;
  readonly repo: string;
  readonly baseCommit: string;
  readonly expectedFiles: readonly string[];
  readonly goldFilesCreatedByPatch: readonly string[];
  readonly order: number;
}

async function git(cwd: string, args: readonly string[], timeoutMs = 180_000): Promise<{ code: number; out: string; err: string }> {
  // `-c gc.auto=0` per invocation rather than a persisted config change: the bench
  // clones are shared with the live harness and this gate must not leave settings
  // behind that a later run would inherit without knowing why.
  const proc = Bun.spawn(["git", "-c", "gc.auto=0", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, out, err };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One instance, verified serially against its clone. Returns the record; never
 * throws, because a thrown probe is indistinguishable from a corpus finding.
 */
export async function verifyInstance(kase: Case, benchReposRoot: string): Promise<IntegrityRecord> {
  const clone = path.join(benchReposRoot, benchCloneName(kase.repo));
  const required = kase.expectedFiles.filter((f) => !kase.goldFilesCreatedByPatch.includes(f));
  const base = {
    instanceId: kase.instanceId,
    repo: kase.repo,
    baseCommit: kase.baseCommit,
    requiredGoldFiles: required,
  };

  let attempts = 0;
  let lastDetail = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    attempts = attempt + 1;
    if (attempt > 0) await sleep(BACKOFF_MS[attempt] ?? 30_000);

    const present = await git(clone, ["cat-file", "-t", kase.baseCommit]);
    if (present.code !== 0 || present.out.trim() !== "commit") {
      const fetched = await git(clone, ["fetch", "--depth", "1", "origin", kase.baseCommit]);
      if (fetched.code !== 0) {
        lastDetail = `fetch failed: ${fetched.err.trim().split("\n").slice(-1)[0] ?? "unknown"}`;
        continue;
      }
    }

    const tree = await git(clone, ["ls-tree", "-r", "--name-only", kase.baseCommit]);
    if (tree.code !== 0) {
      lastDetail = `ls-tree failed: ${tree.err.trim().split("\n").slice(-1)[0] ?? "unknown"}`;
      continue;
    }
    const paths = tree.out.split("\n").map((p) => p.trim()).filter((p) => p.length > 0);
    if (paths.length === 0) {
      lastDetail = "ls-tree returned an empty tree";
      continue;
    }

    // The per-PATH check M160 paid to learn. A tree that resolves but does not
    // contain the file the reference patch edits is not a valid benchmark source.
    const pathSet = new Set(paths);
    const missing = required.filter((f) => !pathSet.has(f));
    const treeHash = hashStable([...paths].sort());
    if (missing.length > 0) {
      return {
        ...base,
        status: "CORPUS_INVALID",
        failure: "GOLD_FIXTURE_ABSENT_FROM_CHECKOUT",
        detail: `gold file(s) absent from the tree at ${kase.baseCommit.slice(0, 12)}: ${missing.join(", ")}`,
        attempts,
        commitResolved: true,
        treePaths: paths.length,
        treeHash,
        missingGoldFiles: missing,
      };
    }
    return {
      ...base,
      status: "VALID",
      failure: null,
      detail: `${paths.length} paths, ${required.length} required gold file(s) present`,
      attempts,
      commitResolved: true,
      treePaths: paths.length,
      treeHash,
      missingGoldFiles: [],
    };
  }

  return {
    ...base,
    status: "CORPUS_INVALID",
    failure: lastDetail.startsWith("fetch") ? "SOURCE_REVISION_UNAVAILABLE" : "TREE_UNREADABLE",
    detail: `${MAX_ATTEMPTS} attempts exhausted — ${lastDetail}`,
    attempts,
    commitResolved: false,
    treePaths: 0,
    treeHash: null,
    missingGoldFiles: [],
  };
}

function parseScope(argv: readonly string[]): "paired30" | "live" | "extension" | "all" {
  const index = argv.indexOf("--scope");
  const value = index >= 0 ? argv[index + 1] : "live";
  if (value === "paired30" || value === "live" || value === "extension" || value === "all") return value;
  throw new Error(`unknown --scope ${value}`);
}

async function main(): Promise<void> {
  const scope = parseScope(Bun.argv.slice(2));
  await mkdir(RESULTS, { recursive: true });

  const paired30 = (await Bun.file(PAIRED30).json()).cases as Case[];
  const extensionDoc = await Bun.file(EXTENSION).json();
  const extension = extensionDoc.extension.cases as Case[];
  const reserve = extensionDoc.reserve.cases as Case[];

  const selected: Case[] =
    scope === "paired30" ? paired30
    : scope === "live" ? [...paired30, ...reserve]
    : scope === "extension" ? extension
    : [...extension, ...reserve];

  // SERIAL within a repository (§19, §126); repositories run one after another too,
  // because the gate is network-bound and M155/M156 already showed what saturating
  // this machine does to measurements (§47).
  const byRepo = new Map<string, Case[]>();
  for (const kase of selected) {
    const bucket = byRepo.get(kase.repo) ?? [];
    bucket.push(kase);
    byRepo.set(kase.repo, bucket);
  }

  const records: IntegrityRecord[] = [];
  for (const repo of [...byRepo.keys()].sort()) {
    const cases = byRepo.get(repo) ?? [];
    process.stdout.write(`${repo} (${cases.length}) `);
    for (const kase of cases) {
      const record = await verifyInstance(kase, BENCH_REPOS);
      records.push(record);
      process.stdout.write(record.status === "VALID" ? "." : "X");
    }
    process.stdout.write("\n");
  }

  records.sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1));
  const invalid = records.filter((r) => r.status === "CORPUS_INVALID");
  const retried = records.filter((r) => r.attempts > 1);

  await writeFile(
    path.join(RESULTS, "stage5_m161_integrity_audit.json"),
    `${JSON.stringify({
      schemaVersion: "stage5.m161.integrity-audit.v1",
      milestone: "M161",
      workstream: "A",
      scope,
      contract: {
        serialization: "serial within a repository — a fetch repacking a shared clone while another read streams from it is what M160 caught truncating trees (§126)",
        gcAuto: "disabled per-invocation via -c gc.auto=0, never persisted into the shared clone",
        verification: "per-PATH against `git ls-tree -r`, never a spot check (§19)",
        retries: `${MAX_ATTEMPTS} bounded attempts with backoff ${BACKOFF_MS.join("/")} ms — M160's first gate run called 16 transient fetch failures CORPUS_INVALID`,
        goldPathUse: "benchmark integrity ONLY; the gold path is never injected into VTRACE (§20)",
      },
      counts: {
        checked: records.length,
        valid: records.length - invalid.length,
        corpusInvalid: invalid.length,
        neededRetry: retried.length,
      },
      failuresByReason: invalid.reduce<Record<string, number>>((acc, r) => {
        acc[r.failure ?? "UNKNOWN"] = (acc[r.failure ?? "UNKNOWN"] ?? 0) + 1;
        return acc;
      }, {}),
      corpusInvalid: invalid,
      records,
    }, null, 2)}\n`,
  );

  console.log(`checked ${records.length}  valid ${records.length - invalid.length}  CORPUS_INVALID ${invalid.length}  needed retry ${retried.length}`);
  for (const record of invalid) console.log(`  INVALID ${record.instanceId}  ${record.failure}  ${record.detail}`);
}

if (import.meta.main) {
  await main();
}
