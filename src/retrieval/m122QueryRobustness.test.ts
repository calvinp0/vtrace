import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { routeQuery } from "../intent/routeQuery";
import { resolveBroadQueryContext, resolvePathSignalQueryContext } from "./searchSymbolsShared";

const FIXTURE = fileURLToPath(new URL("../../fixtures/m121_compound_retrieval_repo", import.meta.url));

test("M122 distinguishes prose slashes, standalone paths, URLs, stack paths, and Windows paths", () => {
  const natural = "trace immutability/supersession across assessment projections";
  const naturalBroad = resolveBroadQueryContext(natural, true, true);
  assert.ok(naturalBroad);
  assert.equal(resolvePathSignalQueryContext(natural, naturalBroad, true, true), undefined);

  for (const query of [
    "services/public_assessments.py",
    "Find services/public_assessments.py and update its projection",
    "https://example.test/api/v1/assessments should expose public_ref",
    'File "/repo/app/services/public_assessments.py", line 42: projection failed',
    "C:\\repo\\app\\services\\public_assessments.py",
  ]) {
    const broad = resolveBroadQueryContext(query, true, true);
    const pathContext = resolvePathSignalQueryContext(query, broad, true, true);
    assert.ok(pathContext, query);
    assert.ok(pathContext.pathTerms.includes("public") || pathContext.pathTerms.includes("assessments"), query);
  }

  assert.equal(resolveBroadQueryContext("services/public_assessments.py", true, true), undefined);
  assert.ok(resolveBroadQueryContext("Find services/public_assessments.py and update its projection", true, true));
});

test("M122 compound admission is deterministic, bounded, and not pairwise", () => {
  const task = Array.from({ length: 96 }, (_, index) => index < 4
    ? ["public_ref", "PublicRefMixin", "RecordReproducibilityAssessment", "public_assessments.py"][index]!
    : `rareterm${index}`).join(" ");
  const first = resolveBroadQueryContext(task, true, true)!;
  const second = resolveBroadQueryContext(task, true, true)!;
  assert.deepEqual(first, second);
  assert.ok(first.admissionDisjuncts.length <= 96);
  assert.ok(first.admissionDisjuncts.length < (96 * 95) / 2);
  assert.ok(first.orderedTerms.includes("public"));
  assert.ok(first.orderedTerms.includes("ref"));
  assert.ok(first.orderedTerms.includes("record"));
  assert.ok(first.orderedTerms.includes("reproducibility"));
  assert.ok(first.orderedTerms.includes("assessment"));
});

test("M122 exact and path lanes retain strong evidence without arbitrary fallback", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "vtrace-m122-routing-"));
  const repoRoot = path.join(temp, "repo");
  const db = openIndexerDatabase();
  try {
    await cp(FIXTURE, repoRoot, { recursive: true });
    await indexProject({ db, repoRoot, refreshMode: "full" });
    for (const query of [
      "public_ref",
      "RecordReproducibilityAssessment",
      "public_assessments.py",
      "services/public_assessments.py",
      "Update services/public_assessments.py and its public projection",
    ]) {
      const routed = routeQuery(db, query, { maxResults: 12 });
      assert.ok(routed.rerankedResults.length > 0, query);
      assert.equal(routed.pathSignalDiagnostics.finalReason, undefined, query);
      assert.ok(routed.pathSignalDiagnostics.queryVariants.length <= 32, query);
    }
  } finally {
    db.close();
    await rm(temp, { recursive: true, force: true });
  }
});
