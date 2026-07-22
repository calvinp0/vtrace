import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { routeQuery } from "../intent/routeQuery";

const FIXTURE_ROOT = fileURLToPath(
  new URL("../../fixtures/m121_compound_retrieval_repo", import.meta.url),
);

const COMPOUND_TASK = "Add a stable public reference for the exact immutable reproducibility assessment "
  + "surfaced in compact assessment summaries across thermo, kinetics, statmech, and transport. "
  + "Determine whether assessment models already have an appropriate public_ref; trace "
  + "immutability/supersession, schemas, migrations, projection builders, OpenAPI, tests, docs, "
  + "and Python client types.";

test("compound prose slash keeps bounded retrieval and relevant independent lanes", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-m121-compound-"));
  const repoRoot = path.join(tempRoot, "repo");
  const db = openIndexerDatabase();

  try {
    await cp(FIXTURE_ROOT, repoRoot, { recursive: true });
    await indexProject({ db, repoRoot, refreshMode: "full" });

    const routed = routeQuery(db, COMPOUND_TASK, { maxResults: 12 });
    const paths = new Set(routed.rerankedResults.map((result) => result.filePath));
    const diagnostics = routed.pathSignalDiagnostics;

    assert.ok(paths.has("models/reproducibility_assessment.py"));
    assert.ok(paths.has("schemas/reproducibility_assessment.py"));
    assert.ok(paths.has("services/public_assessments.py"));
    assert.ok(paths.has("migrations/versions/add_assessment_ref.py"));
    assert.ok(paths.has("tests/test_public_assessments.py"));
    assert.ok(!paths.has("misc/generic_terms.py"), "generic-term negative control displaced stronger evidence");
    assert.ok(diagnostics.candidateFilesConsidered > 0);
    assert.ok(diagnostics.preFilterCandidates > 0);
    assert.ok(diagnostics.preFilterCandidates < 100, "compound decomposition must stay bounded");
    assert.ok(diagnostics.identifierTerms.includes("public_ref"));
    assert.equal(diagnostics.fallbackAttempted, false);
    assert.equal(diagnostics.finalReason, undefined);
  } finally {
    db.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("exact identifiers and filenames seed strong deterministic candidates", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-m121-identifiers-"));
  const repoRoot = path.join(tempRoot, "repo");
  const db = openIndexerDatabase();

  try {
    await cp(FIXTURE_ROOT, repoRoot, { recursive: true });
    await indexProject({ db, repoRoot, refreshMode: "full" });

    const queries = [
      ["RecordReproducibilityAssessment", "models/reproducibility_assessment.py"],
      ["reproducibility_assessment", "models/reproducibility_assessment.py"],
      ["public_assessments.py", "services/public_assessments.py"],
    ] as const;

    for (const [query, expectedPath] of queries) {
      const first = routeQuery(db, query, { maxResults: 6 });
      const second = routeQuery(db, query, { maxResults: 6 });
      if (query === "reproducibility_assessment") {
        assert.ok(first.rerankedResults.some((result) => result.filePath === expectedPath), query);
      } else {
        assert.equal(first.rerankedResults[0]?.filePath, expectedPath, query);
      }
      assert.deepEqual(second.rerankedResults, first.rerankedResults);
    }

    const appended = routeQuery(
      db,
      `${COMPOUND_TASK} RecordReproducibilityAssessment public_assessments.py reproducibility_assessment.py`,
      { maxResults: 12 },
    );
    const appendedPaths = new Set(appended.rerankedResults.map((result) => result.filePath));
    assert.ok(appendedPaths.has("models/reproducibility_assessment.py"));
    assert.ok(appendedPaths.has("services/public_assessments.py"));
  } finally {
    db.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
