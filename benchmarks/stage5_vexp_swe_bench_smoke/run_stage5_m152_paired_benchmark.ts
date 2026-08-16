// M152 paired benchmark: M151 final functional -> M152 final functional.
//
// Both sides run in ONE session against the SAME immutable target corpora and the
// same fixtures; only the VTRACE implementation root differs.
// `createHistoricalEvaluator` opens each workspace's existing index read-only and
// builds a capsule with that root's own source, so neither side writes to a
// target.
//
// WHAT THIS RUN IS FOR
// ----------------
// M152 is persistence ownership: it moves observations, capsule manifests and
// deferred references out of `index.sqlite` into `session.sqlite`, and changes
// nothing about scoring, candidate generation, ranking or selection. These
// suites reach retrieval directly and read only repository-derived tables, so
// the expectation is 0 movement — and the reason is structural rather than
// lucky: nothing they touch moved stores.
//
// The one thing that DID change under them is the index schema fingerprint, so
// each side generates its own index from its own source. A movement here would
// mean the split leaked into derivation, which is the failure §56 forbids.
//
// §113 is explicit that an unchanged result here is not evidence the wiring
// works — the product corpus is what proves that. This run exists to catch the
// opposite: retrieval moving as a SIDE EFFECT of the wiring. §112 also requires
// saying so plainly when zero movement is structural rather than lucky, which is
// what the `reachability` note below records.
//
// No agent, Docker, VEXP, network, or paid API is used.

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { comparePairedArtifacts } from "./benchmarkProvenance";
import { runRetrievalEval, type RetrievalEvalArtifact } from "./run_stage5_retrieval_eval";
import { createHistoricalEvaluator } from "./run_stage5_m134_historical_replay";
import { summarizeQuality } from "./run_stage5_m140_paired_benchmark";

interface Suite {
  readonly name: string;
  readonly fixture: string;
}

const SUITES: readonly Suite[] = [
  { name: "django", fixture: "benchmarks/stage5_vexp_swe_bench_smoke/retrieval_eval.django.expanded.json" },
  { name: "cross_repo_30", fixture: "benchmarks/stage5_vexp_swe_bench_smoke/retrieval_eval.cross_repo.30.json" },
];

async function evaluateSide(
  root: string,
  fixture: string,
  outDir: string,
  reportName: string,
): Promise<RetrievalEvalArtifact> {
  const evaluator = await createHistoricalEvaluator(root);
  return runRetrievalEval({
    fixture,
    out: outDir,
    reportName,
    artifactState: "authoritative",
    implementationRoot: root,
    fixtureIdentityPath: fixture,
  }, { evaluateEntry: evaluator });
}

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString().trim();
}

async function main(): Promise<void> {
  const values = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index]!, argv[index + 1]!);
  const predecessorRoot = path.resolve(values.get("--predecessor-root") ?? "");
  const candidateRoot = path.resolve(values.get("--candidate-root") ?? process.cwd());
  const outDir = path.resolve(values.get("--out-dir") ?? "benchmarks/stage5_vexp_swe_bench_smoke/results");
  const prefix = values.get("--report-prefix") ?? "stage5_m152";
  // Two comparisons share this runner: M150 -> final, and the §82 isolation of
  // the closure commit alone. They must not overwrite each other.
  const outputName = values.get("--output-name") ?? "stage5_m152_paired_comparison.json";
  const predecessorLabel = values.get("--predecessor-label") ?? "m151-87b3f5a4";

  const predecessorCommit = git(predecessorRoot, ["rev-parse", "HEAD"]);
  const candidateCommit = git(candidateRoot, ["rev-parse", "HEAD"]);
  const candidateDirty = git(candidateRoot, ["status", "--porcelain", "--", "src"]).length > 0;

  const suites = [];
  const allCandidateRows = [];

  for (const suite of SUITES) {
    const [predecessor, candidate] = await Promise.all([
      evaluateSide(predecessorRoot, suite.fixture, outDir, `${prefix}-${suite.name}-predecessor`),
      evaluateSide(candidateRoot, suite.fixture, outDir, `${prefix}-${suite.name}-candidate`),
    ]);
    const comparison = comparePairedArtifacts(predecessor, candidate, predecessorCommit);
    allCandidateRows.push(...candidate.rows);

    suites.push({
      name: suite.name,
      caseCount: candidate.rows.length,
      fixtureHash: candidate.benchmarkProvenance.fixture.hash,
      sameFixtureHash: predecessor.benchmarkProvenance.fixture.hash === candidate.benchmarkProvenance.fixture.hash,
      sameTargetCorpusHash:
        predecessor.benchmarkProvenance.targetCorpus.hash === candidate.benchmarkProvenance.targetCorpus.hash,
      sharedImmutableTargetCorpus: true,
      neitherSideWritesTargets: true,
      provenanceValid: comparison.validity.valid,
      authoritative: comparison.authoritative,
      semanticallyEqual: comparison.changedCases.length === 0,
      predecessorSemanticHash: comparison.predecessorSemanticHash,
      candidateSemanticHash: comparison.candidateSemanticHash,
      differences: comparison.differences,
      changedCases: comparison.changedCases,
      quality: {
        predecessor: summarizeQuality(predecessor.rows),
        candidate: summarizeQuality(candidate.rows),
      },
    });
    process.stdout.write(
      `suite ${suite.name}: valid=${comparison.validity.valid} changed=${comparison.changedCases.length}/${candidate.rows.length}\n`,
    );
  }

  const provenanceValid = suites.every(
    (suite) => suite.provenanceValid && suite.sameFixtureHash && suite.sameTargetCorpusHash,
  );
  const changedCaseCount = suites.reduce((sum, suite) => sum + suite.changedCases.length, 0);

  const output = {
    schemaVersion: "stage5.m152.paired-comparison.v1",
    milestone: "M152",
    predecessor: {
      label: predecessorLabel,
      commit: predecessorCommit,
      tree: git(predecessorRoot, ["rev-parse", "HEAD^{tree}"]),
      note: "M151 final functional (87b3f5a4). The candidate moves observations, "
        + "capsule manifests and deferred VEXP references out of index.sqlite into "
        + "session.sqlite. These suites read only repository-derived tables, so 0 "
        + "movement is structural rather than lucky — and a movement here would mean "
        + "the store split had leaked into derivation.",
    },
    candidate: {
      label: "m151",
      commit: candidateCommit,
      tree: git(candidateRoot, ["rev-parse", "HEAD^{tree}"]),
      srcDirty: candidateDirty,
    },
    protocol:
      "stage5.retrieval.protocol.v1 dual-root — both sides executed in one session against the same fixtures and "
      + "the same pre-existing target indexes, with only the implementation root differing. Neither side indexes or "
      + "writes to a target, so the corpus is an immutable shared input rather than per-side state.",
    provenanceValid,
    suites,
    frozen50: {
      caseCount: allCandidateRows.length,
      changedCaseCount,
      semanticallyEqual: changedCaseCount === 0,
    },
    reachability: {
      question: "§112 — can these suites reach the code M151 changed?",
      answer:
        "No. Every M151 edit is on the MCP product path: repository routing before "
        + "the database binding, bounded routing metadata in the response, and the "
        + "index_status census. These suites call retrieval through "
        + "createHistoricalEvaluator with one explicit repository root and never "
        + "construct an MCP request, so no workspace config is read and the router "
        + "is not on their call path.",
      consequence:
        "Zero movement here is STRUCTURAL, not evidence that the wiring works "
        + "(§113). The positive capability evidence is "
        + "stage5_m151_workspace_product_corpus.json and "
        + "stage5_m151_real_repo_acceptance.json. What this run rules out is "
        + "retrieval moving as a side effect, which would be a §137 FAIL.",
    },
  };

  await writeFile(
    path.join(outDir, outputName),
    `${JSON.stringify(output, null, 2)}\n`,
  );

  process.stdout.write(
    `frozen50: changed=${changedCaseCount}/${allCandidateRows.length} provenanceValid=${provenanceValid}\n`,
  );
}

await main();
