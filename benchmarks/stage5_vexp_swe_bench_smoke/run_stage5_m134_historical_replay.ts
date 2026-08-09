// M134 historical retrieval replay adapter.
//
// The protocol/scorer stays current and fixed while product modules are loaded
// from an isolated historical VTRACE worktree. Target workspaces are supplied by
// the fixture and must be independently indexed by that historical worktree.
// This script runs no agent, Docker, VEXP, or network operation.

import { pathToFileURL } from "node:url";
import path from "node:path";
import { writeFile } from "node:fs/promises";

import {
  evaluateInstance,
  loadRetrievalFixture,
  summarizeCapsule,
  aggregate,
  type CapsuleSummary,
  type RetrievalEvalRow,
} from "./run_stage5_retrieval_eval";
import { hashStable, semanticProjection } from "./benchmarkProvenance";

interface ReplayConfig {
  readonly vtraceRoot: string;
  readonly fixture: string;
  readonly out: string;
  readonly milestone: string;
}

interface HistoricalModules {
  readonly openIndexerDatabase: (dbPath: string) => { close(): void };
  readonly buildCapsuleV2: (input: Record<string, unknown>) => unknown;
  readonly parseCapsuleIntent: (intent: string) => unknown;
  readonly CapsuleIntent: { readonly Auto: unknown };
}

export async function loadHistoricalModules(root: string): Promise<HistoricalModules> {
  const sqlite = await import(pathToFileURL(path.join(root, "src/db/sqlite.ts")).href);
  const builder = await import(pathToFileURL(path.join(root, "src/capsuleV2/buildCapsuleV2.ts")).href);
  const types = await import(pathToFileURL(path.join(root, "src/capsuleV2/types.ts")).href);
  return {
    openIndexerDatabase: sqlite.openIndexerDatabase,
    buildCapsuleV2: builder.buildCapsuleV2,
    parseCapsuleIntent: types.parseCapsuleIntent,
    CapsuleIntent: types.CapsuleIntent,
  } as HistoricalModules;
}

export async function createHistoricalEvaluator(root: string): Promise<(entry: import("./run_stage5_retrieval_eval").RetrievalEvalFixtureEntry) => Promise<CapsuleSummary>> {
  const historical = await loadHistoricalModules(root);
  return async (entry) => {
    const workspace = path.resolve(entry.workspace);
    const db = historical.openIndexerDatabase(path.join(workspace, ".vtrace", "index.sqlite"));
    try {
      return summarizeCapsule(historical.buildCapsuleV2({
        db,
        repoRoot: workspace,
        task: entry.task,
        intent: historical.parseCapsuleIntent(entry.intent) ?? historical.CapsuleIntent.Auto,
        maxTokens: entry.budget,
      }) as never);
    } finally {
      db.close();
    }
  };
}

async function main(config: ReplayConfig): Promise<void> {
  const historical = await loadHistoricalModules(config.vtraceRoot);
  const entries = await loadRetrievalFixture(config.fixture);
  const rows: RetrievalEvalRow[] = [];
  const failures: Array<{ instanceId: string; classification: string; detail: string }> = [];
  for (const entry of entries) {
    const workspace = path.resolve(entry.workspace);
    const dbPath = path.join(workspace, ".vtrace", "index.sqlite");
    try {
      const db = historical.openIndexerDatabase(dbPath);
      let summary: CapsuleSummary;
      try {
        const result = historical.buildCapsuleV2({
          db,
          repoRoot: workspace,
          task: entry.task,
          intent: historical.parseCapsuleIntent(entry.intent) ?? historical.CapsuleIntent.Auto,
          maxTokens: entry.budget,
        });
        summary = summarizeCapsule(result as never);
      } finally {
        db.close();
      }
      rows.push(evaluateInstance(entry, summary));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const classification = classifyHistoricalFailure(detail);
      failures.push({ instanceId: entry.instance_id, classification, detail });
      rows.push(evaluateInstance(entry, null, { kind: "workspace_error", detail }));
    }
  }
  const commit = Bun.spawnSync(["git", "-C", config.vtraceRoot, "rev-parse", "HEAD"]).stdout.toString().trim();
  const tree = Bun.spawnSync(["git", "-C", config.vtraceRoot, "rev-parse", "HEAD^{tree}"]).stdout.toString().trim();
  const output = {
    schemaVersion: "stage5.m134.historical-replay.v1",
    milestone: config.milestone,
    implementationCommit: commit,
    implementationTree: tree,
    executionStatus: failures.length === 0 ? "historical_run_success" : "partial_failure",
    failures,
    aggregate: aggregate(rows),
    semanticHash: hashStable(semanticProjection(rows)),
    rows,
  };
  await writeFile(config.out, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`${config.milestone} ${commit.slice(0, 8)}: ${rows.length - failures.length}/${rows.length}, top1=${output.aggregate.top_1_file_accuracy}, semantic=${output.semanticHash}\n`);
}

function classifyHistoricalFailure(detail: string): string {
  if (/no such table|schema|column/iu.test(detail)) return "schema_incompatible";
  if (/Cannot find|module|resolve/iu.test(detail)) return "dependency_unavailable";
  if (/fixture/iu.test(detail)) return "fixture_unsupported";
  return "environment_unrecoverable";
}

function parseArgs(argv: readonly string[]): ReplayConfig {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) throw new Error("Invalid M134 replay arguments.");
    values.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) throw new Error(`Missing ${flag}.`);
    return value;
  };
  return {
    vtraceRoot: path.resolve(required("--vtrace-root")),
    fixture: path.resolve(required("--fixture")),
    out: path.resolve(required("--out")),
    milestone: required("--milestone"),
  };
}

if (import.meta.main) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
