import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  buildPivotRankingV2Report,
  compareAstropyRanking,
  PIVOT_RANKING_V2_JSON_FILENAME,
  PIVOT_RANKING_V2_MD_FILENAME,
  renderPivotRankingV2Markdown,
  runPivotRankingV2Report,
  scanControlledSet,
  scanSnapshotPivots,
} from "./run_stage5_pivot_ranking_v2_report";

const STRICT_SNAPSHOT = `# vtrace indexed context

budget: 2,772 / 8,000 tokens used

● pivot astropy/units/format/vounit.py::VOUnit
  reason:
  - actionable class

  source:
  class VOUnit(generic.Generic):
      ${"x".repeat(1600)}

● pivot astropy/units/format/cds.py::to_string
  source:
  def to_string(cls, unit):
      return s

## Instruction
`;

// (Astropy fixture) v2 flips the broad class below the specific implementation.
test("compareAstropyRanking flips legacy ordering under v2", () => {
  const cmp = compareAstropyRanking();
  assert.equal(cmp.legacyTop, "astropy/units/format/vounit.py");
  assert.equal(cmp.v2Top, "astropy/units/format/cds.py");
  assert.equal(cmp.flipped, true);
});

test("scanSnapshotPivots extracts pivots, kind, and snippet size", () => {
  const pivots = scanSnapshotPivots(STRICT_SNAPSHOT);
  assert.equal(pivots.length, 2);
  assert.equal(pivots[0]!.path, "astropy/units/format/vounit.py");
  assert.equal(pivots[0]!.kind, "class");
  assert.ok(pivots[0]!.snippetTokenEstimate > 350);
  assert.equal(pivots[1]!.kind, "function-or-method");
});

test("scanControlledSet handles missing artifacts without crashing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pivot-v2-empty-"));
  const results = path.join(dir, "results");
  await mkdir(results, { recursive: true });
  const scan = await scanControlledSet(results);
  assert.equal(scan.taskCount, 0);
  assert.equal(scan.faithfulRerankPossible, false);
});

test("scanControlledSet flags a broad top pivot from a seeded snapshot", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pivot-v2-seed-"));
  const results = path.join(dir, "results");
  const runDir = path.join(results, "runs", "eval-strictgated-vtrace-astropy-14369");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "_vtrace_instructions.snapshot.md"), STRICT_SNAPSHOT);
  const scan = await scanControlledSet(results);
  assert.equal(scan.taskCount, 1);
  assert.equal(scan.tasks[0]!.topPivotKind, "class");
  assert.equal(scan.tasks[0]!.topPivotLooksBroad, true);
  assert.equal(scan.tasksWithBroadTopPivot, 1);
});

// (10) Report emits required Markdown sections.
test("renderPivotRankingV2Markdown emits all required sections", async () => {
  const report = await buildPivotRankingV2Report("/tmp/x");
  const md = renderPivotRankingV2Markdown(report);
  for (const section of [
    "# Stage 5 pivot ranking v2 report",
    "## Summary",
    "## Ranking rule changes",
    "## Astropy comparison",
    "## Controlled-set sanity checks",
    "## Metadata added",
    "## Risks",
    "## Recommended next step",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(section), `missing section: ${section}`);
  }
});

// (11) Report emits required JSON fields.
test("report JSON exposes required fields and required non-claims", async () => {
  const report = await buildPivotRankingV2Report("/tmp/x");
  for (const key of [
    "resultsDir",
    "defaultPivotRankingVersion",
    "rankingRuleChanges",
    "astropyComparison",
    "controlledSet",
    "metadataAdded",
    "risks",
    "recommendedNextStep",
    "nonClaims",
  ]) {
    assert.ok(key in report, `missing field: ${key}`);
  }
  assert.equal(report.defaultPivotRankingVersion, "v2");
  for (const claim of [
    "This report does not re-run agents or Docker.",
    "This report does not use edited files or resolved status as ranking inputs.",
    "This report does not prove aggregate improvement until fresh agent runs are executed.",
    "Ranking v2 is not a Capsule budget change.",
  ]) {
    assert.ok(report.nonClaims.includes(claim), `missing non-claim: ${claim}`);
  }
});

test("metadata-added list matches the five pivot rank fields", async () => {
  const report = await buildPivotRankingV2Report("/tmp/x");
  assert.deepEqual(
    [...report.metadataAdded].sort(),
    ["pivot_rank_penalties", "pivot_rank_reason", "pivot_rank_score", "pivot_rank_signals", "pivot_ranking_version"],
  );
});

// (12) End-to-end write — no Docker/model/agent invoked.
test("runPivotRankingV2Report writes JSON+MD", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pivot-v2-e2e-"));
  const results = path.join(dir, "results");
  await mkdir(results, { recursive: true });
  const report = await runPivotRankingV2Report(results);
  assert.equal(report.astropyComparison.flipped, true);
  const json = await readFile(path.join(results, PIVOT_RANKING_V2_JSON_FILENAME), "utf8");
  const md = await readFile(path.join(results, PIVOT_RANKING_V2_MD_FILENAME), "utf8");
  assert.ok(json.includes("astropyComparison"));
  assert.ok(md.includes("# Stage 5 pivot ranking v2 report"));
});
