// M149 §91/§92: the claim boundaries, exercised against the REAL indexes.
//
// Everything here is read-only. Members are opened with SQLite's `readonly`
// flag, no lane writes, and the runner records each real index's mtime and size
// before and after so "we did not touch the user's index" is measured rather
// than intended. M148 established that read paths never migrate; this checks
// that M149's consumer changes did not quietly introduce one.
//
// The workspace is whatever is actually indexed on this machine. M147's
// eleven-member control cannot be reconstructed here — only three real indexed
// repositories remain — so the member-scale question is answered separately and
// synthetically by `run_stage5_m149_evidence.ts` (§103 allows exactly that for
// response SIZE). What this runner adds is real readiness verdicts, real
// refusals and real path/symbol tables behind the claims.
//
// No agent, Docker, VEXP, network, or paid API is used.

import { Database } from "bun:sqlite";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveIndexDbPath } from "../../src/indexer/indexMeta";
import { evaluateWorkspaceReadiness } from "../../src/workspace/readiness";
import { resolveWorkspaceRegistry, type RegisteredRepository } from "../../src/workspace/registry";
import { classifyNegativeClaim, type EvidenceCoverage } from "../../src/workspace/evidenceClaims";
import {
  createDatabaseProbe,
  nominateRepositories,
  type RepositoryProbe,
} from "../../src/workspace/repositoryRelevance";
import { writeWorkspaceConfig, WORKSPACE_CONFIG_SCHEMA_VERSION } from "../../src/workspace/config";
import { captureRepoIdentityRecord } from "../../src/workspace/registry";

const REAL_REPOS = [
  "/home/calvin/code/ARC",
  "/home/calvin/code/TCKDB_v2",
  "/home/calvin/code/vtrace",
];

interface FileStamp {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
}

async function stampIndexes(): Promise<FileStamp[]> {
  const stamps: FileStamp[] = [];
  for (const root of REAL_REPOS) {
    for (const file of [resolveIndexDbPath(root), path.join(root, ".vtrace/index.meta.json")]) {
      try {
        const info = await stat(file);
        stamps.push({ path: file, mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        // A repository without that file simply contributes no stamp.
      }
    }
  }
  return stamps;
}

function sameStamps(before: readonly FileStamp[], after: readonly FileStamp[]): boolean {
  if (before.length !== after.length) return false;
  return before.every((entry, index) =>
    after[index]!.path === entry.path
    && after[index]!.mtimeMs === entry.mtimeMs
    && after[index]!.size === entry.size);
}

async function main(): Promise<void> {
  const outDir = path.resolve(
    process.argv[2] ?? "benchmarks/stage5_vexp_swe_bench_smoke/results",
  );
  const scratch = path.resolve(
    process.argv[3] ?? "/tmp/m149-real-acceptance",
  );

  const before = await stampIndexes();

  // A workspace config in scratch space. Registering a repository reads its
  // identity; it never writes into the repository.
  const configPath = path.join(scratch, "vtrace-workspace.json");
  await Bun.write(path.join(scratch, ".keep"), "");
  const repos = [];
  for (const root of REAL_REPOS) {
    repos.push({
      alias: path.basename(root),
      rootPath: root,
      enabled: true,
      ...(await captureRepoIdentityRecord(root)),
    });
  }
  const config = await writeWorkspaceConfig(configPath, {
    schemaVersion: WORKSPACE_CONFIG_SCHEMA_VERSION,
    primaryRepoAlias: repos[0]!.alias,
    repos,
  });

  const registry = await resolveWorkspaceRegistry({ config });
  const readiness = await evaluateWorkspaceReadiness(registry);

  const opened: string[] = [];
  const handles: Database[] = [];
  const probe = (repository: RegisteredRepository): RepositoryProbe | null => {
    opened.push(repository.alias);
    try {
      const db = new Database(resolveIndexDbPath(repository.rootPath), { readonly: true });
      handles.push(db);
      return createDatabaseProbe(db);
    } catch {
      return null;
    }
  };

  const cases = [
    {
      id: "absent_symbol_over_real_members",
      symbolHints: ["vtrace_m149_symbol_that_cannot_exist"],
      pathHints: undefined as readonly string[] | undefined,
    },
    {
      id: "absent_path_over_real_members",
      symbolHints: undefined as readonly string[] | undefined,
      pathHints: ["src/vtrace_m149_path_that_cannot_exist.py"],
    },
    {
      id: "no_hints_at_all",
      symbolHints: undefined as readonly string[] | undefined,
      pathHints: undefined as readonly string[] | undefined,
    },
  ];

  const results = cases.map((entry) => {
    opened.length = 0;
    const started = Bun.nanoseconds();
    const relevance = nominateRepositories({
      registry,
      readiness,
      pathHints: entry.pathHints,
      symbolHints: entry.symbolHints,
      probe,
    });
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
    const coverage: readonly EvidenceCoverage[] = relevance.diagnostics.coverage;
    const deciding = coverage.find((row) => row.purpose === "deciding") ?? null;
    return {
      id: entry.id,
      status: relevance.status,
      reason: relevance.reason,
      reasonChars: relevance.reason.length,
      selected: relevance.selected.map((repo) => repo.alias),
      decidingTier: relevance.diagnostics.decidingTier,
      reposReady: relevance.diagnostics.reposReady,
      reposEnabled: relevance.diagnostics.reposEnabled,
      excludedNotReady: relevance.diagnostics.reposExcludedNotReady,
      excludedNotReadyTotal: relevance.diagnostics.reposExcludedNotReadyTotal,
      coverage,
      negativeClaimStrength: deciding === null ? null : classifyNegativeClaim(deciding),
      indexesOpened: [...new Set(opened)].sort(),
      elapsedMs: Number(elapsedMs.toFixed(3)),
    };
  });

  for (const handle of handles) handle.close();
  const after = await stampIndexes();

  // A refused member must never have had its index opened for a lane.
  const refusedAliases = readiness.repos.filter((repo) => !repo.ready).map((repo) => repo.alias);
  const refusedNeverOpened = results.every((result) =>
    refusedAliases.every((alias) => !result.indexesOpened.includes(alias)));

  const output = {
    schemaVersion: "stage5.m149.real-acceptance.v1",
    milestone: "M149",
    note:
      "Read-only over the real ARC / TCKDB_v2 / vtrace indexes. M147's eleven-member "
      + "control is not reconstructible on this machine (three real indexed repositories "
      + "remain), so member-scale bounding is measured synthetically in "
      + "stage5_m149_coverage_scale.json instead.",
    members: registry.repositories.map((repo) => {
      const row = readiness.repos.find((entry) => entry.alias === repo.alias);
      return {
        alias: repo.alias,
        rootPath: repo.rootPath,
        ready: row?.ready ?? false,
        readinessReason: row?.reason ?? null,
      };
    }),
    reposReady: readiness.ready,
    reposTotal: readiness.total,
    refusedAliases,
    refusedNeverOpened,
    cases: results,
    realIndexesUntouched: sameStamps(before, after),
    indexStampsBefore: before,
    indexStampsAfter: after,
  };

  await writeFile(
    path.join(outDir, "stage5_m149_real_acceptance.json"),
    `${JSON.stringify(output, null, 2)}\n`,
    "utf8",
  );

  process.stdout.write(`members=${readiness.total} ready=${readiness.ready}\n`);
  for (const result of results) {
    process.stdout.write(
      `  ${result.id}: ${result.status} | ${result.negativeClaimStrength ?? "n/a"} | `
      + `${result.reasonChars} chars | opened=${result.indexesOpened.join(",") || "none"}\n`,
    );
    process.stdout.write(`    ${result.reason}\n`);
  }
  process.stdout.write(
    `refusedNeverOpened=${refusedNeverOpened} realIndexesUntouched=${output.realIndexesUntouched}\n`,
  );
  if (!output.realIndexesUntouched || !refusedNeverOpened) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
