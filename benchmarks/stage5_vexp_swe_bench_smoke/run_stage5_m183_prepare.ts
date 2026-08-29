/**
 * M183-B — prepare the ORIENTATION workspaces and bind their index authority.
 *
 *   bun run_stage5_m183_prepare.ts [--only <instanceId>] [--limit N]
 *
 * Costs nothing: no agent, no provider call. Everything here is clone, index and
 * verification, and it must all happen before the first paid pair exists.
 *
 * WHY A SEPARATE WORKSPACE AT ALL.
 *
 * Both live arms run `--protocol baseline`, so neither creates a Stage 5
 * workspace and neither carries a `.vtrace` directory: the external harness
 * prepares each arm's repository itself, identically. That is what makes §11's
 * isolation claim true by construction rather than by inspection — the arms
 * cannot differ in worktree state because nothing in this experiment writes to
 * one. The orientation is therefore generated somewhere else entirely, against a
 * clone of the SAME base commit, and only its BYTES travel to the treatment arm.
 *
 * An earlier design indexed the treatment arm's own worktree and deleted
 * `.vtrace` before spawning. It was abandoned: `git status` inside a treatment
 * run would have listed `.vtrace/` as untracked for as long as it existed, and
 * "we removed the evidence in time" is not an isolation argument.
 *
 * WHY THE INDEX IS ALWAYS REBUILT (§12).
 *
 * The hundred M169 Broad100-A workspaces are already on disk, already indexed,
 * and unusable: their `.git` has no HEAD, every file reads as untracked, and
 * their indexes were built at 413093e0. An index whose revision cannot be
 * established is not this task's index. So each workspace is re-cloned to the
 * manifest's base commit, its HEAD is CHECKED against that commit, and its index
 * is rebuilt at the current product HEAD. A stale index is not repaired here; it
 * is deleted and rebuilt, because §12's failure mode is a silent one.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  prepareWorkspaceForInstance,
  type ProcessResult,
  type ProcessRunner,
  type SweBenchInstance,
} from "./run_stage5_vexp_swe_bench_smoke";
import { sha256 } from "./m183Treatment";

const ROOT = path.resolve(".");
const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const CORPUS = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");
const WORKSPACES = path.join(RESULTS, "workspaces", "m183_orientation");
const MANIFEST = path.join(RESULTS, "stage5_m183_sample_manifest.json");

const run: ProcessRunner = async (command, args, options) => {
  const proc = Bun.spawn([command, ...args], {
    cwd: options?.cwd ?? ROOT,
    env: { ...process.env, ...(options?.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr } satisfies ProcessResult;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface CorpusRow {
  readonly instance_id: string; readonly repo: string; readonly base_commit: string;
  readonly problem_statement: string; readonly hints_text: string | null;
  readonly FAIL_TO_PASS: string | readonly string[];
}

const asList = (value: string | readonly string[]): readonly string[] =>
  typeof value === "string" ? (JSON.parse(value) as string[]) : value;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
  const limit = argv.includes("--limit") ? Number(argv[argv.indexOf("--limit") + 1]) : Infinity;

  const corpus = new Map<string, CorpusRow>();
  for (const line of readFileSync(CORPUS, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line) as CorpusRow;
    corpus.set(row.instance_id, row);
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    executionOrder: { instanceId: string; baseCommit: string; repo: string }[];
  };
  const targets = manifest.executionOrder
    .filter((row) => only === null || row.instanceId === only)
    .slice(0, limit);

  mkdirSync(WORKSPACES, { recursive: true });
  const rows: Record<string, unknown>[] = [];
  let failures = 0;

  for (const [index, target] of targets.entries()) {
    const row = corpus.get(target.instanceId);
    if (row === undefined) throw new Error(`instance absent from the corpus: ${target.instanceId}`);
    const instance: SweBenchInstance = {
      repo: row.repo,
      instanceId: row.instance_id,
      baseCommit: row.base_commit,
      problemStatement: row.problem_statement,
      hintsText: row.hints_text,
      failToPass: asList(row.FAIL_TO_PASS),
    };
    const workspace = path.join(WORKSPACES, target.instanceId);
    const started = Date.now();
    process.stdout.write(`[${index + 1}/${targets.length}] ${target.instanceId} `);

    let record: Record<string, unknown>;
    try {
      const prep = await prepareWorkspaceForInstance({ instance, workspace, runProc: run, sleep });

      // §12: the revision is CHECKED, never assumed from the directory name.
      const head = (await run("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();
      if (head !== instance.baseCommit) {
        throw new Error(`workspace HEAD ${head} != manifest base commit ${instance.baseCommit}`);
      }
      const dirty = (await run("git", ["status", "--porcelain"], { cwd: workspace })).stdout
        .split("\n").filter((l) => l.trim() !== "" && !l.includes(".vtrace"));

      // Always rebuilt. A "fresh" verdict over an index whose provenance cannot
      // be established is exactly the silent failure §12 names.
      rmSync(path.join(workspace, ".vtrace"), { recursive: true, force: true });
      const indexResult = await run("bun", [path.join(ROOT, "src/cli/index.ts"), "index", workspace]);
      if (indexResult.exitCode !== 0) {
        throw new Error(`index failed (${indexResult.exitCode}): ${indexResult.stderr.slice(-400)}`);
      }
      const metaPath = path.join(workspace, ".vtrace", "index.meta.json");
      if (!existsSync(metaPath)) throw new Error("index produced no index.meta.json");
      const metaRaw = readFileSync(metaPath, "utf8");
      const meta = JSON.parse(metaRaw) as Record<string, unknown>;

      record = {
        instanceId: target.instanceId,
        repo: instance.repo,
        workspace: path.relative(ROOT, workspace),
        baseCommit: instance.baseCommit,
        headVerified: true,
        workspaceDirtyPaths: dirty.length,
        prep: { reused: prep.reused, resetToBaseCommit: prep.resetToBaseCommit, cleaned: prep.cleaned, gitRetryCount: prep.gitRetryCount, fallbackUsed: prep.fallbackUsed, recreatedAfterFailure: prep.recreatedAfterFailure },
        index: {
          rebuilt: true,
          metaHash: sha256(metaRaw),
          indexFormatVersion: meta.index_format_version,
          schemaVersion: meta.schema_version,
          vtraceCommit: meta.vtrace_commit,
          indexerFingerprint: meta.indexer_fingerprint,
          parserFingerprint: meta.parser_fingerprint,
          configHash: meta.config_hash,
          createdAt: meta.created_at,
        },
        status: "PREPARED",
        elapsedSeconds: Math.round((Date.now() - started) / 1000),
      };
      process.stdout.write(`PREPARED (${record.elapsedSeconds}s, index ${String(meta.vtrace_commit).slice(0, 8)})\n`);
    } catch (error) {
      failures += 1;
      record = {
        instanceId: target.instanceId,
        repo: instance.repo,
        workspace: path.relative(ROOT, workspace),
        baseCommit: instance.baseCommit,
        status: "PREPARATION_FAILED",
        error: error instanceof Error ? error.message : String(error),
        elapsedSeconds: Math.round((Date.now() - started) / 1000),
      };
      process.stdout.write(`FAILED — ${record.error}\n`);
    }
    rows.push(record);
  }

  // The fingerprints must AGREE across every prepared workspace. One index built
  // by a different derivation would make its arm a different treatment, and the
  // agreement is what turns "we rebuilt them" into evidence.
  const prepared = rows.filter((r) => r.status === "PREPARED");
  const fingerprintSets = {
    vtraceCommit: [...new Set(prepared.map((r) => (r.index as Record<string, unknown>).vtraceCommit as string))],
    indexerFingerprint: [...new Set(prepared.map((r) => (r.index as Record<string, unknown>).indexerFingerprint as string))],
    parserFingerprint: [...new Set(prepared.map((r) => (r.index as Record<string, unknown>).parserFingerprint as string))],
    configHash: [...new Set(prepared.map((r) => (r.index as Record<string, unknown>).configHash as string))],
    schemaVersion: [...new Set(prepared.map((r) => (r.index as Record<string, unknown>).schemaVersion as string))],
  };
  const productHead = (await run("git", ["rev-parse", "HEAD"], { cwd: ROOT })).stdout.trim();

  const doc = {
    schemaVersion: "stage5.m183.index-authority.v1",
    milestone: "M183",
    workstream: "M183-B",
    productHead,
    workspaceRoot: path.relative(ROOT, WORKSPACES),
    prepared: prepared.length,
    failed: failures,
    fingerprintSets,
    fingerprintsUniform:
      Object.values(fingerprintSets).every((set) => set.length <= 1),
    indexBuiltAtProductHead:
      fingerprintSets.vtraceCommit.length === 1 && fingerprintSets.vtraceCommit[0] === productHead,
    rows,
  };
  writeFileSync(path.join(RESULTS, "stage5_m183_index_authority.json"), `${JSON.stringify(doc, null, 2)}\n`);

  console.log(`\nprepared ${prepared.length}/${targets.length}  failed ${failures}`);
  console.log(`  fingerprints uniform: ${doc.fingerprintsUniform}`);
  console.log(`  index built at product HEAD (${productHead.slice(0, 8)}): ${doc.indexBuiltAtProductHead}`);
  console.log("  wrote results/stage5_m183_index_authority.json");
  if (failures > 0) process.exit(1);
}

await main();
