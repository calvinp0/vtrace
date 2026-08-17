/**
 * M156 §52/§53 — what the three recovered repositories actually retrieve.
 *
 * Availability is the milestone's claim; it is not the same as answerability.
 * Once a repository indexes, the honest next question is what a deterministic
 * retrieval over it returns, and the honest possible answers include "nothing" —
 * §53 explicitly allows the repository to become available while the task stays
 * unanswerable, for instance because the gold evidence is inside the file that
 * failed to parse.
 *
 * So this runner classifies rather than grades. What it must show is that these
 * three are no longer `TREATMENT_UNAVAILABLE_INDEX_FAILURE`; what it must NOT do
 * is turn a delivery-empty result into a failure, which is precisely the
 * misclassification M155-D had to undo.
 *
 * NO Claude, NO Docker, NO agent run, NO API calls, NO network.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import {
  runRetrievalEval,
  type RetrievalEvalFixtureEntry,
  type RetrievalEvalRow,
} from "./run_stage5_retrieval_eval";
import { listFileIndexFailures } from "../../src/db/repositories/fileIndexFailuresRepository";
import { resolveIndexDbPath } from "../../src/indexer/indexMeta";

/** The instances M155 could not give a treatment to. Frozen, not rediscovered. */
const RECOVERED = [
  "psf__requests-1142",
  "pytest-dev__pytest-5262",
  "pylint-dev__pylint-4551",
] as const;

/**
 * The product state a row represents. Deliberately parallel to the paired
 * harness's vocabulary so the two can be read together.
 */
function classifyRow(row: RetrievalEvalRow): string {
  if (row.result === "workspace_error" || row.result === "fixture_error") {
    return "TREATMENT_UNAVAILABLE_INDEX_FAILURE";
  }
  // "Delivered" means the model would have received something: a pivot or a
  // support slot. `discarded` candidates were found and withheld, which is the
  // django-11740 shape and still an EMPTY treatment.
  const delivered = row.pivot_count + row.support_count > 0;
  return delivered ? "VALID_NONEMPTY" : "VALID_DELIVERY_EMPTY";
}

function readCoverage(workspace: string): {
  readonly failedFiles: number;
  readonly failedPaths: readonly string[];
} {
  let db: Database | undefined;
  try {
    db = new Database(resolveIndexDbPath(workspace), { readonly: true });
    const failures = listFileIndexFailures(db);
    return {
      failedFiles: failures.length,
      // Bounded (§79): a repository with thirteen failures reports four paths
      // and a count, not thirteen paths.
      failedPaths: failures.slice(0, 4).map((failure) => failure.path),
    };
  } catch {
    return { failedFiles: 0, failedPaths: [] };
  } finally {
    db?.close();
  }
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const get = (flag: string, fallback?: string): string => {
    const index = argv.indexOf(flag);
    if (index < 0 || argv[index + 1] === undefined) {
      if (fallback !== undefined) return fallback;
      throw new Error(`${flag} is required.`);
    }
    return argv[index + 1]!;
  };
  const preparedFixture = get("--prepared-fixture");
  const outDir = get("--out-dir", path.join(import.meta.dir, "results"));

  const prepared = JSON.parse(
    await Bun.file(preparedFixture).text(),
  ) as RetrievalEvalFixtureEntry[];
  const entries = prepared.filter((entry) => RECOVERED.includes(entry.instance_id as typeof RECOVERED[number]));
  if (entries.length !== RECOVERED.length) {
    throw new Error(
      `Prepared fixture covers ${entries.length} of the ${RECOVERED.length} recovered instances.`,
    );
  }

  const scratch = await mkdtemp(path.join(tmpdir(), "m156-recovered-"));
  const fixturePath = path.join(scratch, "recovered_three.json");
  await writeFile(fixturePath, `${JSON.stringify(entries, null, 1)}\n`);

  const artifact = await runRetrievalEval({
    fixture: fixturePath,
    out: scratch,
    reportName: "stage5_m156_recovered_three_raw",
  });

  const cases = artifact.rows.map((row) => {
    const entry = entries.find((candidate) => candidate.instance_id === row.instance_id)!;
    const coverage = readCoverage(entry.workspace);
    return {
      instanceId: row.instance_id,
      repo: entry.repo ?? null,
      productState: classifyRow(row),
      wasUnavailableUnderM154: true,
      coverageState: coverage.failedFiles > 0 ? "DEGRADED" : "COMPLETE",
      failedFiles: coverage.failedFiles,
      failedPathsSample: coverage.failedPaths,
      pivotCount: row.pivot_count,
      supportCount: row.support_count,
      discardedCount: row.discarded_count,
      goldFiles: row.expected_files,
      goldRole: row.expected_file_role,
      goldDelivered: row.expected_file_role === "pivot" || row.expected_file_role === "support",
      // §53: gold living inside a file that failed to parse means the repository
      // is available and the task is still not answerable. That is truthful, and
      // it is NOT a containment failure.
      goldInsideFailedFile: (row.expected_files ?? []).some(
        (gold) => coverage.failedPaths.includes(gold),
      ),
      leadFile: row.top_1_pivot_file,
    };
  });

  const report = {
    schemaVersion: "stage5.m156.recovered-three-retrieval.v1",
    milestone: "M156",
    note: "Deterministic retrieval over the three repositories M155 could not index. "
      + "Classification, not grading: a delivery-empty result is a VALID product state "
      + "(M155-D), not a treatment failure.",
    preparedFixture,
    cases: cases.length,
    stillUnavailable: cases.filter((entry) => entry.productState === "TREATMENT_UNAVAILABLE_INDEX_FAILURE").length,
    validNonEmpty: cases.filter((entry) => entry.productState === "VALID_NONEMPTY").length,
    validDeliveryEmpty: cases.filter((entry) => entry.productState === "VALID_DELIVERY_EMPTY").length,
    degraded: cases.filter((entry) => entry.coverageState === "DEGRADED").length,
    results: cases,
  };

  const out = path.join(outDir, "stage5_m156_recovered_three_retrieval.json");
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  // eslint-disable-next-line no-console
  console.error(
    `recovered three: nonEmpty=${report.validNonEmpty} deliveryEmpty=${report.validDeliveryEmpty} `
    + `stillUnavailable=${report.stillUnavailable} degraded=${report.degraded} -> ${out}`,
  );
}

await main();
