// M148 paired benchmark: M147 final functional -> M148 final functional.
//
// Both sides are executed in this session against the SAME immutable target
// corpora and the same fixtures; only the VTRACE implementation root differs.
// `createHistoricalEvaluator` opens each workspace's existing index read-only
// and builds a capsule with that root's own source, so neither side writes to a
// target — which is what makes a shared corpus the right control here rather
// than a shortcut. Preparing two isolated corpora would compare two DIFFERENT
// inputs and could only weaken the claim.
//
// M148 changes index lifecycle/access performance and workspace indexed-path
// truth. Neither is reachable from single-repository capsule retrieval, so the
// expectation is 0/50 semantic movement — measured, not assumed.
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
  const prefix = values.get("--report-prefix") ?? "stage5_m148";

  const predecessorCommit = git(predecessorRoot, ["rev-parse", "HEAD"]);
  const candidateCommit = git(candidateRoot, ["rev-parse", "HEAD"]);
  const candidateDirty = git(candidateRoot, ["status", "--porcelain", "--", "src"]).length > 0;

  const suites = [];
  const allPredecessorRows = [];
  const allCandidateRows = [];

  for (const suite of SUITES) {
    const [predecessor, candidate] = await Promise.all([
      evaluateSide(predecessorRoot, suite.fixture, outDir, `${prefix}-${suite.name}-predecessor`),
      evaluateSide(candidateRoot, suite.fixture, outDir, `${prefix}-${suite.name}-candidate`),
    ]);
    const comparison = comparePairedArtifacts(predecessor, candidate, predecessorCommit);
    allPredecessorRows.push(...predecessor.rows);
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
  const output = {
    schemaVersion: "stage5.m148.paired-comparison.v1",
    milestone: "M148",
    predecessor: {
      label: "m147-3e30509",
      commit: predecessorCommit,
      tree: git(predecessorRoot, ["rev-parse", "HEAD^{tree}"]),
      note: "M147 final functional. 3e30509..2c6b017 touches only benchmark results, so 2c6b017 is evidence-only.",
    },
    candidate: {
      label: "m148",
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
      changedCaseCount: suites.reduce((sum, suite) => sum + suite.changedCases.length, 0),
      quality: {
        predecessor: summarizeQuality(allPredecessorRows),
        candidate: summarizeQuality(allCandidateRows),
      },
    },
  };

  const outPath = path.join(outDir, `${prefix}_checkpoint_paired.json`);
  await writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(
    `wrote ${outPath}\nprovenanceValid=${provenanceValid} frozen50Changed=${output.frozen50.changedCaseCount}/${output.frozen50.caseCount}\n`,
  );
  if (!provenanceValid) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
