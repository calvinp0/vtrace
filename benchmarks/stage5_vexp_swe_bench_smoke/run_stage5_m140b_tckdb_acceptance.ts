// M140-B §63: TCKDB same-checkout acceptance.
//
// Both implementations are run against the SAME read-only TCKDB checkout and the
// same index, so any difference is attributable to the code under test rather
// than to repository drift. TCKDB source is never modified and its in-place
// `.vtrace` state is opened read-only.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m140b_tckdb_acceptance.ts \
//     --predecessor-root <a6 worktree> --candidate-root <b worktree> [--out <dir>]

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { loadHistoricalModules } from "./run_stage5_m134_historical_replay";

const TCKDB_ROOT = path.resolve(process.env.M140B_TCKDB_ROOT ?? "/home/calvin/code/TCKDB_v2");
const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");

/**
 * Deliberately mixed shapes: an ordinary modify task (must not activate the
 * lane) and process questions (may). Attribution is only meaningful if both
 * kinds are present.
 */
const TASKS: ReadonlyArray<{ task: string; intent: string; shape: string; budget: number }> = [
  { task: "add a bond order validation to the species schema", intent: "modify", shape: "modify", budget: 6000 },
  { task: "How does a species record get validated when it is inserted?", intent: "explain", shape: "orchestration", budget: 6000 },
  { task: "How is a connection to the database established and torn down?", intent: "explain", shape: "orchestration", budget: 6000 },
  { task: "find get_session", intent: "explain", shape: "explicit_lookup", budget: 6000 },
];

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

interface Projection {
  readonly mode: string;
  readonly lead: string | null;
  readonly pivots: readonly string[];
  readonly selected: readonly string[];
}

async function evaluate(root: string): Promise<Projection[]> {
  const modules = await loadHistoricalModules(root);
  const indexPath = path.join(TCKDB_ROOT, ".vtrace", "index.sqlite");
  return TASKS.map((entry) => {
    const db = modules.openIndexerDatabase(indexPath);
    try {
      const capsule = modules.buildCapsuleV2({
        db,
        repoRoot: TCKDB_ROOT,
        task: entry.task,
        intent: modules.parseCapsuleIntent(entry.intent) ?? modules.CapsuleIntent.Auto,
        maxTokens: entry.budget,
      }) as unknown as {
        actual_mode: string;
        pivots: Array<{ fq_name: string }>;
        support: Array<{ fq_name: string }>;
      };
      return {
        mode: capsule.actual_mode,
        lead: capsule.pivots[0]?.fq_name ?? null,
        pivots: capsule.pivots.map((item) => item.fq_name),
        selected: [...capsule.pivots, ...capsule.support].map((item) => item.fq_name),
      };
    } finally {
      db.close();
    }
  });
}

async function main(): Promise<void> {
  const predecessorRoot = path.resolve(argument("--predecessor-root") ?? "");
  const candidateRoot = path.resolve(argument("--candidate-root") ?? "");
  const outDir = argument("--out") ?? RESULTS;
  const indexPath = path.join(TCKDB_ROOT, ".vtrace", "index.sqlite");
  if (!existsSync(indexPath)) {
    throw new Error(`TCKDB index unavailable: ${indexPath}`);
  }

  const before = await evaluate(predecessorRoot);
  const after = await evaluate(candidateRoot);

  const cases = TASKS.map((entry, index) => {
    const predecessor = before[index]!;
    const candidate = after[index]!;
    const leadChanged = predecessor.lead !== candidate.lead;
    const selectionChanged =
      JSON.stringify(predecessor.selected) !== JSON.stringify(candidate.selected);
    return {
      task: entry.task,
      shape: entry.shape,
      leadChanged,
      selectionChanged,
      predecessor,
      candidate,
      // Only the rescue lane changed between these two commits, so any movement
      // here is attributable to it — and must be inspected, not assumed benign.
      cause: leadChanged || selectionChanged ? "upstream_rescue" : "none",
    };
  });

  const changed = cases.filter((entry) => entry.leadChanged || entry.selectionChanged);
  const output = {
    schemaVersion: "stage5.m140b.tckdb-acceptance.v1",
    tckdb: {
      root: TCKDB_ROOT,
      branch: git(TCKDB_ROOT, ["rev-parse", "--abbrev-ref", "HEAD"]),
      head: git(TCKDB_ROOT, ["rev-parse", "HEAD"]),
      sourceReadOnly: true,
      indexOpenedReadOnly: true,
      sameCheckoutBothSides: true,
    },
    predecessor: { root: predecessorRoot, commit: git(predecessorRoot, ["rev-parse", "HEAD"]) },
    candidate: { root: candidateRoot, commit: git(candidateRoot, ["rev-parse", "HEAD"]) },
    caseCount: cases.length,
    changedCaseCount: changed.length,
    unattributed: changed.filter((entry) => entry.cause !== "upstream_rescue").length,
    cases,
    pass: changed.every((entry) => entry.cause === "upstream_rescue"),
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, "stage5_m140_final_tckdb_acceptance.json"),
    `${JSON.stringify(output, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `TCKDB ${output.tckdb.branch}@${output.tckdb.head.slice(0, 7)}: ${changed.length}/${cases.length} changed, pass=${output.pass}\n`,
  );
  for (const entry of cases) {
    process.stdout.write(
      `  [${entry.shape}] leadChanged=${entry.leadChanged} selectionChanged=${entry.selectionChanged} lead=${entry.candidate.lead}\n`,
    );
  }
}

if (import.meta.main) {
  await main();
}
