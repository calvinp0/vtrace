// Stage 5 Django regression tests.
//
// Drives the five Stage 5 scenarios through the real evidence-ranked pipeline
// (shape -> hybrid retrieve -> assign pivot/support/discard) on a seeded in-memory
// index, and asserts the Requirement 8 expectations for each scenario's known
// final edited file. The instance-id -> file mapping is ASSERTION data only; the
// production path receives just the problem statement + failing tests.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { hybridRetrieve, HybridCandidateSource } from "../retrieval/hybridRetrieval";
import { shapeSweQuery } from "./sweQueryShaping";
import {
  assignCandidateRoles,
  CandidateRole,
  type RoledCandidate,
} from "./assignCandidateRoles";
import { buildFinalEditedFileContainment } from "./finalEditDiagnostics";
import {
  seedStage5DjangoFixture,
  STAGE5_SCENARIOS,
  type Stage5Scenario,
} from "./__fixtures__/stage5DjangoFixture";

// Role the expected file holds: the strongest role among that file's candidates.
function fileRole(roled: readonly RoledCandidate[], file: string): CandidateRole | "missing" {
  const entries = roled.filter((r) => r.candidate.filePath === file && r.role !== CandidateRole.Discard);
  if (entries.length === 0) {
    return "missing";
  }
  return entries.some((r) => r.role === CandidateRole.Pivot)
    ? CandidateRole.Pivot
    : CandidateRole.Support;
}

// Best (lowest) rank index at which `file` appears in a given role.
function bestRankOf(roled: readonly RoledCandidate[], file: string): number {
  return roled.findIndex((r) => r.candidate.filePath === file && r.role !== CandidateRole.Discard);
}

function runScenario(scenario: Stage5Scenario): RoledCandidate[] {
  const db = openIndexerDatabase();
  try {
    seedStage5DjangoFixture(db);
    const shaped = shapeSweQuery(scenario.record);
    const { candidates } = hybridRetrieve(db, { query: shaped.query, shaped, maxResults: 25 });
    return assignCandidateRoles(candidates);
  } finally {
    db.close();
  }
}

for (const scenario of STAGE5_SCENARIOS) {
  test(`${scenario.instanceId}: ${scenario.expectedFile} satisfies its expectation (${scenario.expectation})`, () => {
    const roled = runScenario(scenario);
    const role = fileRole(roled, scenario.expectedFile);

    switch (scenario.expectation) {
      case "pivot":
        assert.equal(role, CandidateRole.Pivot,
          `${scenario.expectedFile} must be a pivot, got ${role}`);
        break;
      case "pivot_or_skip": {
        // Pivot, OR genuinely skipped — but never buried as support behind the
        // off-target distractor file.
        assert.ok(role === CandidateRole.Pivot || role === "missing",
          `${scenario.expectedFile} must be a pivot or skipped, got ${role}`);
        if (scenario.notBehindFile !== undefined) {
          assert.notEqual(fileRole(roled, scenario.notBehindFile), CandidateRole.Pivot,
            `${scenario.notBehindFile} must not be a pivot`);
          const targetRank = bestRankOf(roled, scenario.expectedFile);
          const distractorRank = bestRankOf(roled, scenario.notBehindFile);
          assert.ok(
            targetRank !== -1 && (distractorRank === -1 || targetRank < distractorRank),
            `${scenario.expectedFile} (#${targetRank}) must rank ahead of ${scenario.notBehindFile} (#${distractorRank})`,
          );
        }
        break;
      }
      case "pivot_or_support":
        assert.ok(role === CandidateRole.Pivot || role === CandidateRole.Support,
          `${scenario.expectedFile} must be pivot or support with clear evidence, got ${role}`);
        break;
    }

    // Whatever the role, the expected file must be selected WITH clear evidence.
    if (role !== "missing") {
      const entry = roled.find(
        (r) => r.candidate.filePath === scenario.expectedFile && r.role !== CandidateRole.Discard,
      );
      assert.ok(entry, "expected a non-discard entry");
      assert.ok((entry?.why.length ?? 0) > 0, "role decision must carry a why");
      assert.ok((entry?.candidate.evidence.length ?? 0) > 0, "selection must carry evidence");
    }
  });
}

test("every scenario reaches its target via the failing-test routes with clear evidence", () => {
  for (const scenario of STAGE5_SCENARIOS) {
    const roled = runScenario(scenario);
    const target = roled.find((r) => r.candidate.filePath === scenario.expectedFile && r.role !== CandidateRole.Discard);
    assert.ok(target, `${scenario.instanceId}: target must be selected`);

    // The failing test routes pull the implementation in: the test FILE imports
    // it (test_to_impl) and/or the test METHOD exercises it (failing_test).
    const sources = new Set(roled
      .filter((r) => r.candidate.filePath === scenario.expectedFile)
      .flatMap((r) => r.candidate.sources));
    assert.ok(
      sources.has(HybridCandidateSource.TestToImpl) || sources.has(HybridCandidateSource.FailingTest),
      `${scenario.instanceId}: expected a failing-test route into ${scenario.expectedFile}, got ${[...sources].join(",")}`,
    );

    // The dedicated testToImpl signal fired for the target file (not folded into
    // graph) — on the symbol the failing test actually reaches.
    const maxTestToImpl = Math.max(
      0,
      ...roled
        .filter((r) => r.candidate.filePath === scenario.expectedFile)
        .map((r) => r.candidate.scores.testToImpl),
    );
    assert.ok(maxTestToImpl > 0,
      `${scenario.instanceId}: testToImpl signal must be positive for the target file`);
  }
});

test("final-edited-file containment reports the target's role, never missing", () => {
  for (const scenario of STAGE5_SCENARIOS) {
    const roled = runScenario(scenario);
    const selection = roled
      .filter((r) => r.role !== CandidateRole.Discard)
      .map((r) => ({
        role: r.role === CandidateRole.Pivot ? "pivot" as const : "support" as const,
        path: r.candidate.filePath,
      }));

    const containment = buildFinalEditedFileContainment(selection, scenario.expectedFile);
    assert.equal(containment.final_edited_file, scenario.expectedFile);

    if (scenario.expectation === "pivot_or_skip") {
      // Pivot-or-skip: either contained as the target, or honestly skipped.
      assert.ok(
        containment.final_edited_file_role === "pivot" || containment.final_edited_file_role === "missing",
        `${scenario.instanceId}: ${containment.final_edited_file_role} not allowed`,
      );
    } else {
      assert.notEqual(containment.final_edited_file_role, "missing",
        `${scenario.instanceId}: target must be contained`);
      assert.equal(containment.contains_final_edited_file, true);
    }
  }
});

test("11095: the impl method is reached with import + method-use + class-mention evidence", () => {
  const scenario = STAGE5_SCENARIOS.find((s) => s.instanceId === "django__django-11095")!;
  const roled = runScenario(scenario);
  const evidence = roled
    .filter((r) => r.candidate.filePath === scenario.expectedFile)
    .flatMap((r) => r.candidate.evidence);

  assert.ok(evidence.some((line) => /imported by failing test file/.test(line)),
    `expected import evidence, got ${JSON.stringify(evidence)}`);
  assert.ok(evidence.some((line) => /used by failing test method/.test(line)),
    `expected method-use evidence, got ${JSON.stringify(evidence)}`);
  assert.ok(evidence.some((line) => /contained in class ModelAdmin mentioned by issue/.test(line)),
    `expected class-mention evidence, got ${JSON.stringify(evidence)}`);
});
