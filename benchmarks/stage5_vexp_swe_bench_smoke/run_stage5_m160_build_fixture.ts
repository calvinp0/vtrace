/**
 * M160-B §34 — build the Broad100-B retrieval fixture.
 *
 * Deliberately thin. Every row is produced by `buildGoldRow`, the same function
 * that produced Broad100-A's rows, so the task derivation (M103 structured
 * shape), the intent, the budget, the label source and the gold-label extraction
 * are identical by construction rather than by resemblance. If the two corpora
 * are to be compared at all, the only thing allowed to differ between them is
 * which instances they contain.
 *
 * A case whose workspace was refused by the preparation completeness gate is not
 * written into the fixture: it has no valid source tree to retrieve from, so
 * scoring it would recreate exactly the M159 defect where a benchmark fixture
 * failure was read as a VTRACE retrieval failure (§80). It stays in the frozen
 * manifest and is reported as excluded (§17, §99) — never replaced.
 *
 * NO Claude, NO Docker, NO agent run, NO API calls, NO network.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildGoldRow } from "./build_stage5_retrieval_fixture";
import { loadVerified } from "./run_stage5_m160_corpus_pool";
import type { RetrievalEvalFixtureEntry } from "./run_stage5_retrieval_eval";
import type { PoolCandidate } from "./m160Corpus";
import type { PreparedWorkspace } from "./run_stage5_m160_prepare_workspaces";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const RESULTS = path.join(import.meta.dir, "results");

interface Config {
  readonly manifest: string;
  readonly workspaces: string;
  readonly verified: string;
  readonly out: string;
  readonly report: string;
}

export function parseArgs(argv: readonly string[]): Config {
  let manifest = path.join(RESULTS, "stage5_m160_broad100b_manifest.json");
  let workspaces = path.join(RESULTS, "stage5_m160_broad100b_workspaces.json");
  let verified = path.join(RESULTS, "_m160_corpus", "swe_bench_verified.jsonl");
  let out = path.join(import.meta.dir, "retrieval_eval.m160_broad_b.json");
  let report = path.join(RESULTS, "stage5_m160_broad100b_fixture_build.json");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string => {
      const next = argv[(i += 1)];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--manifest") manifest = value();
    else if (arg === "--workspaces") workspaces = value();
    else if (arg === "--verified") verified = value();
    else if (arg === "--out") out = value();
    else if (arg === "--report") report = value();
    else throw new Error(`Unknown argument ${arg}`);
  }
  return { manifest, workspaces, verified, out, report };
}

async function main(config: Config): Promise<void> {
  const manifest = JSON.parse(await readFile(config.manifest, "utf8")) as { cases: PoolCandidate[] };
  const prepared = JSON.parse(await readFile(config.workspaces, "utf8")) as { workspaces: PreparedWorkspace[] };
  const verified = await loadVerified(config.verified);
  const byId = new Map(verified.map((row) => [row.instance_id, row]));
  const workspaceById = new Map(prepared.workspaces.map((row) => [row.instanceId, row]));

  const rows: RetrievalEvalFixtureEntry[] = [];
  const excluded: Array<Record<string, string>> = [];
  for (const kase of manifest.cases) {
    const workspace = workspaceById.get(kase.instanceId);
    if (workspace === undefined) {
      excluded.push({ instanceId: kase.instanceId, reason: "WORKSPACE_NOT_PREPARED", detail: "no preparation record" });
      continue;
    }
    if (workspace.availability === "PREPARATION_INVALID" || workspace.availability === "UNAVAILABLE") {
      excluded.push({ instanceId: kase.instanceId, reason: workspace.availability, detail: workspace.detail });
      continue;
    }
    const instance = byId.get(kase.instanceId);
    if (instance === undefined) {
      excluded.push({ instanceId: kase.instanceId, reason: "NOT_IN_VERIFIED", detail: "instance absent from the corpus file" });
      continue;
    }
    const { row, skipped } = buildGoldRow(
      {
        instance_id: instance.instance_id,
        repo: instance.repo,
        patch: instance.patch,
        problem_statement: instance.problem_statement,
      },
      workspace.workspace,
    );
    if (row === null) {
      excluded.push({ instanceId: kase.instanceId, reason: "ROW_NOT_BUILDABLE", detail: skipped ?? "unknown" });
      continue;
    }
    rows.push(row);
  }

  await writeFile(config.out, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  await writeFile(
    config.report,
    `${JSON.stringify(
      {
        schemaVersion: "stage5.m160.broad100b-fixture-build.v1",
        milestone: "M160",
        kind: "fixture build over the frozen corpus, with every case not scored explained (§17)",
        builder: "buildGoldRow — the identical function that built Broad100-A's rows (§34)",
        frozenCases: manifest.cases.length,
        scoredCases: rows.length,
        excludedCases: excluded.length,
        excluded,
        fixture: path.relative(REPO_ROOT, path.resolve(config.out)),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(`fixture rows: ${rows.length} of ${manifest.cases.length} frozen cases`);
  for (const row of excluded) console.log(`  excluded ${row.instanceId}: ${row.reason} — ${row.detail}`);
  console.log(`  ${path.relative(REPO_ROOT, path.resolve(config.out))}`);
}

if (import.meta.main) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
