/**
 * M153-C5 — does the behavioural lane recover anything ordinary retrieval cannot?
 *
 * §31/§62. The lane's product claim is not "an operation fact was delivered" but
 * "an expected implementation reached the model that ordinary lexical/symbol/path
 * retrieval would not have surfaced". C4 showed the corpus's single operation-fact
 * success (`Session.get_adapter`) also scores fts = 1 and ranks first, so it
 * proves nothing about the lane.
 *
 * Measured WITHOUT a product flag. Adding an "operation facts off" switch purely
 * to run a benchmark arm would be a product change made for measurement, so the
 * attribution is taken from provenance the product already records:
 *
 *   ordinary_sufficient   delivered, and carries an ordinary source
 *                         (lexical / symbol / path / test / body-literal)
 *   behavioural_unique    delivered, and its ONLY provenance is operation_fact
 *   behavioural_support   delivered as support and owed to behavioural evidence
 *   not_delivered         expected implementation never reached the capsule
 *
 * Calibration repositories only. The holdout is not touched.
 */

import { Database } from "bun:sqlite";
import path from "node:path";
import { writeFileSync } from "node:fs";

import { resolveRepoLocalPaths } from "../../src/setup/repoState";
import { shapeSweQuery, type ShapedSweQuery } from "../../src/capsule/sweQueryShaping";
import { resolveProjectNameAliases } from "../../src/capsuleV2/projectNameSignals";
import { createLazyRepositoryPathPredicate } from "../../src/retrieval/repositoryPathMembership";
import { planIntent } from "../../src/capsuleV2/intent";
import { hybridRetrieve, HybridCandidateSource } from "../../src/retrieval/hybridRetrieval";
import { hasAnswerRoleEvidence } from "../../src/capsule/assignCandidateRoles";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { BEHAVIORAL_CASES, CORPUS_REPOSITORIES } from "./behavioralCrossRepoCorpus";
import { repoRootFor } from "./m153BehavioralHarness";

const CALIBRATION = new Set(
  CORPUS_REPOSITORIES.filter((repo) => repo.split === "calibration").map((repo) => repo.key),
);

const ORDINARY_SOURCES: readonly HybridCandidateSource[] = [
  HybridCandidateSource.Lexical,
  HybridCandidateSource.Symbol,
  HybridCandidateSource.Path,
  HybridCandidateSource.TestToImpl,
  HybridCandidateSource.FailingTest,
  HybridCandidateSource.BodyLiteral,
];

function deriveSymbolSeeds(shaped: ShapedSweQuery): string[] {
  const seeds: string[] = [];
  for (const identifier of shaped.identifiers) {
    if (/Test/.test(identifier) && /^[A-Z]/.test(identifier)) {
      const subject = identifier.replace(/^Test(?=[A-Z])/, "").replace(/(?:TestCase|Tests|Test)$/, "");
      if (subject.length >= 3) seeds.push(subject);
    } else if (!/^test[_A-Z]/.test(identifier)) {
      seeds.push(identifier);
    }
  }
  return [...new Set(seeds)];
}

type Attribution =
  | "ordinary_sufficient"
  | "behavioural_unique"
  | "behavioural_support"
  | "not_delivered";

const rows: Array<Record<string, unknown>> = [];

for (const testCase of BEHAVIORAL_CASES) {
  if (!CALIBRATION.has(testCase.expectedRepository)) continue;
  if (testCase.expectAbsence === true) continue;

  const repoRoot = repoRootFor(testCase.expectedRepository);
  const db = new Database(resolveRepoLocalPaths(repoRoot).dbPath, { readonly: true });
  try {
    const repositoryPaths = createLazyRepositoryPathPredicate(db, { queries: 0 });
    const shaped = shapeSweQuery(
      { problemStatement: testCase.query, failToPass: [] },
      {
        projectNameAliases: resolveProjectNameAliases(repoRoot),
        isRepositoryPath: repositoryPaths.isRepositoryPath,
      },
    );
    const plan = planIntent(undefined, testCase.query, shaped);
    const retrieval = hybridRetrieve(db, {
      query: shaped.query,
      shaped,
      taskText: testCase.query,
      weights: plan.weights,
      symbolSeeds: deriveSymbolSeeds(shaped),
      maxResults: 60,
    });
    const capsule = buildCapsuleV2({
      db,
      repoRoot,
      task: testCase.query,
      intent: CapsuleIntent.Explain,
      maxTokens: 6000,
    });
    const delivered = [...capsule.pivots, ...capsule.support];

    for (const expected of testCase.expected) {
      if (expected.role !== "PRIMARY_IMPLEMENTER") continue;
      const item = delivered.find((entry) => entry.fq_name === expected.fqName);
      const pooled = retrieval.candidates.find((entry) => entry.fqName === expected.fqName);
      const sources = pooled?.sources ?? [];
      const carriesOperationFact = sources.includes(HybridCandidateSource.OperationFact);
      const carriesOrdinary = ORDINARY_SOURCES.some((source) => sources.includes(source));

      let attribution: Attribution;
      if (item === undefined) {
        attribution = "not_delivered";
      } else if (carriesOperationFact && !carriesOrdinary) {
        attribution = item.role === "pivot" ? "behavioural_unique" : "behavioural_support";
      } else {
        attribution = "ordinary_sufficient";
      }

      rows.push({
        caseId: testCase.id,
        repository: testCase.expectedRepository,
        category: testCase.category,
        fqName: expected.fqName,
        pooled: pooled !== undefined,
        sources,
        answerRoleEvidence: pooled === undefined ? false : hasAnswerRoleEvidence(pooled),
        delivered: item !== undefined,
        deliveredRole: item?.role ?? null,
        attribution,
      });
    }
  } finally {
    db.close();
  }
}

const tally = (value: Attribution): number =>
  rows.filter((row) => row.attribution === value).length;

const summary = {
  expectedImplementationsScored: rows.length,
  ordinary_sufficient: tally("ordinary_sufficient"),
  behavioural_unique: tally("behavioural_unique"),
  behavioural_support: tally("behavioural_support"),
  not_delivered: tally("not_delivered"),
  behaviouralUniqueCases: rows.filter((row) => row.attribution === "behavioural_unique")
    .map((row) => row.caseId),
  behaviouralSupportCases: rows.filter((row) => row.attribution === "behavioural_support")
    .map((row) => row.caseId),
  repositories: [...new Set(rows.map((row) => row.repository))],
};

const out = path.join(import.meta.dir, "results/stage5_m153_c5_behavioral_unique_recoveries.json");
writeFileSync(out, `${JSON.stringify({ summary, rows }, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
console.log(`\nwrote ${out}`);
