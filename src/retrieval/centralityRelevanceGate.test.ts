// M142 Workstream B — centrality may strengthen relevance, never create it.
//
// M140-A6 fixed one centrality defect (structural module sources counting as
// dependents). This covers the deeper contract: a globally-central class must not
// become a candidate, a pivot, or the lead on dependency count alone, while a
// genuinely relevant central symbol must keep bounded support.
//
// Generic fixtures throughout. The ARC observations that motivated the rule are
// acceptance evidence, not implementation input.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";
import type { Database } from "bun:sqlite";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { buildCapsuleV2 } from "../capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../capsuleV2/types";
import { gateCentralityOnRelevance } from "./hybridScoring";

// --- unit contract -------------------------------------------------------------

test("M142-B: centrality support is proportional to task relevance", () => {
  const full = gateCentralityOnRelevance({
    centralityContribution: 0.5,
    localEvidence: 2,
    maxLocalEvidence: 2,
  });
  assert.equal(full.relevanceShare, 1);
  assert.equal(full.support, 0.5);

  const weak = gateCentralityOnRelevance({
    centralityContribution: 0.5,
    localEvidence: 0.4,
    maxLocalEvidence: 2,
  });
  assert.equal(weak.relevanceShare, 0.2);
  assert.equal(weak.support, 0.1);
});

test("M142-B: centrality supports nothing when the pool has no local evidence", () => {
  const gate = gateCentralityOnRelevance({
    centralityContribution: 0.5,
    localEvidence: 0,
    maxLocalEvidence: 0,
  });
  assert.equal(gate.relevanceShare, 0);
  assert.equal(gate.support, 0);
});

test("M142-B: the gate can only ever reduce, never amplify", () => {
  for (const localEvidence of [0, 0.1, 0.9, 1, 4]) {
    const gate = gateCentralityOnRelevance({
      centralityContribution: 0.5,
      localEvidence,
      maxLocalEvidence: 1,
    });
    assert.ok(gate.support <= 0.5, `support ${gate.support} exceeded the ungated contribution`);
    assert.ok(gate.relevanceShare <= 1);
  }
});

// --- §26 generic centrality fixture --------------------------------------------

async function indexRepo(files: Record<string, string>): Promise<{ db: Database; repoRoot: string }> {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "m142-centrality-"));
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(repoRoot, relPath);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, content);
  }
  const db = openIndexerDatabase();
  await indexProject({ repoRoot, db });
  return { db, repoRoot };
}

/**
 * A class 200 symbols depend on, plus a low-fan-in behavioural target.
 *
 * The dependents share `CoreObject`'s file deliberately. A cross-file
 * `from pkg.core import CoreObject` produces an import edge owned by the MODULE
 * scope, and M140-A6 excludes structural sources from centrality — so the
 * obvious multi-module spelling of this fixture yields an in-degree of zero and
 * tests nothing.
 */
function centralityFixture(): Record<string, string> {
  let core =
    "class CoreObject(object):\n"
    + "    \"\"\"The central domain object.\"\"\"\n"
    + "    def __init__(self, name):\n"
    + "        self.name = name\n\n"
    + "    def describe(self):\n"
    + "        return self.name\n\n";
  for (let index = 0; index < 200; index += 1) {
    core += `def consumer_${index}(name):\n    return CoreObject(name).describe()\n\n`;
  }
  return {
    "pkg/core.py": core,
    "pkg/routing.py":
      "def build_gaussian_route(profile):\n"
      + "    \"\"\"Assemble the gaussian route keywords emitted for a job profile.\"\"\"\n"
      + "    keywords = [profile.method]\n"
      + "    keywords.append(profile.basis)\n"
      + "    return keywords\n",
  };
}

test("M142-B: a behavioural target outranks a central class it does not touch", async () => {
  const repo = await indexRepo(centralityFixture());
  try {
    const capsule = buildCapsuleV2({
      db: repo.db,
      repoRoot: repo.repoRoot,
      task: "How are gaussian route keywords assembled?",
      intent: CapsuleIntent.Explain,
      maxTokens: 4_000,
    });
    const candidates = capsule.diagnostics.candidate_scores ?? [];
    const target = candidates.find((row) => row.fq_name.endsWith("::build_gaussian_route"));
    const central = candidates.find((row) => row.fq_name.endsWith("::CoreObject"));

    assert.ok(target !== undefined, "the behavioural target must be retrieved");
    assert.ok(central !== undefined, "the fixture must actually produce a central class");
    assert.ok(central.scores.inDegree >= 100, `fixture in-degree too low: ${central.scores.inDegree}`);
    assert.ok(
      target.rank < central.rank,
      `build_gaussian_route (rank ${target.rank}) must outrank CoreObject (rank ${central.rank}, `
      + `${central.scores.inDegree} dependents)`,
    );
    assert.equal(
      central.scores.centralitySupport ?? 0,
      0,
      "a central class with no local evidence must receive no centrality support",
    );
    assert.equal(
      capsule.pivots.some((pivot) => pivot.symbol === "CoreObject"),
      false,
      "a central class unrelated to the question must not be a pivot",
    );
  } finally {
    repo.db.close();
  }
});

test("M142-B: centrality still supports the central object when the task is about it", async () => {
  const repo = await indexRepo(centralityFixture());
  try {
    const capsule = buildCapsuleV2({
      db: repo.db,
      repoRoot: repo.repoRoot,
      task: "What does the CoreObject class describe, and how is it constructed?",
      intent: CapsuleIntent.Explain,
      maxTokens: 4_000,
    });
    const candidates = capsule.diagnostics.candidate_scores ?? [];
    const central = candidates.find((row) => row.fq_name.endsWith("::CoreObject"));
    assert.ok(central !== undefined, "the central class must still be retrievable when asked for");
    assert.ok(
      (central.scores.centralitySupport ?? 0) > 0,
      `a genuinely relevant central candidate must keep bounded centrality support; `
      + `share=${central.scores.centralityRelevanceShare} support=${central.scores.centralitySupport}`,
    );
    assert.ok(
      [...capsule.pivots, ...capsule.support].some((item) => item.symbol === "CoreObject"),
      "the central class must still be delivered for a question about it",
    );
  } finally {
    repo.db.close();
  }
});

test("M142-B: centrality never admits a candidate that local evidence would not", async () => {
  const repo = await indexRepo(centralityFixture());
  try {
    const capsule = buildCapsuleV2({
      db: repo.db,
      repoRoot: repo.repoRoot,
      task: "How are gaussian route keywords assembled?",
      intent: CapsuleIntent.Explain,
      maxTokens: 4_000,
    });
    for (const row of capsule.diagnostics.candidate_scores ?? []) {
      const support = row.scores.centralitySupport ?? 0;
      if (support <= 0) continue;
      assert.ok(
        row.scores.localEvidence > 0,
        `${row.fq_name} received centrality support with no local evidence`,
      );
    }
  } finally {
    repo.db.close();
  }
});
