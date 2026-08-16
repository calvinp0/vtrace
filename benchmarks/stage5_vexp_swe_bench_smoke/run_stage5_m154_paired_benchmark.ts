// M154 paired benchmark: M153 final functional -> M154 final functional.
//
// Both sides run in ONE session against the SAME immutable target corpora and the
// same fixtures; only the VTRACE implementation root differs.
// `createHistoricalEvaluator` opens each workspace's existing index read-only and
// builds a capsule with that root's own source, so neither side writes to a
// target and no session state is shared between arms (§57).
//
// WHAT THIS RUN IS FOR
// ----------------
// M154 is safety and contract work. Two of its three functional changes cannot
// move retrieval at all — the Git exclusion runs in the indexing lifecycle, and
// the coverage/guidance semantics are response wording and an additive response
// field. The third CAN: dropping a project-name reference from the searchable
// text changes what lexical scoring sees.
//
// That is exactly why this run matters, and why zero movement here is a
// SUBSTANTIVE result rather than a structural one. These fixtures are rooted at
// SWE-bench instance directories (`psf__requests-1142`, `django__django-11095`),
// so the repository basename is the instance id and never the project name. The
// alias resolver therefore produces a token no task text contains, the
// suppression cannot fire, and any movement here would mean the change reached
// further than its own precondition — which would be a §110 FAIL.
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
  const prefix = values.get("--report-prefix") ?? "stage5_m154";
  // Two comparisons share this runner: M150 -> final, and the §82 isolation of
  // the closure commit alone. They must not overwrite each other.
  const outputName = values.get("--output-name") ?? "stage5_m154_paired_comparison.json";
  const predecessorLabel = values.get("--predecessor-label") ?? "m153-e3761ab9";

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
    schemaVersion: "stage5.m154.paired-comparison.v1",
    milestone: "M154",
    predecessor: {
      label: predecessorLabel,
      commit: predecessorCommit,
      tree: git(predecessorRoot, ["rev-parse", "HEAD^{tree}"]),
      note:
        "M153 final functional is e3761ab9 (the C5 fix). 318f2c7b is its evidence "
        + "commit and touches no src/ path, so the two are functionally identical.",
    },
    candidate: {
      label: "m154",
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
      question: "\u00a7112 \u2014 can these suites reach the code M154 changed?",
      answer:
        "Only one change is on their path. The Git exclusion runs in the indexing "
        + "lifecycle, which these suites bypass by opening pre-existing indexes "
        + "read-only; the coverage field and the guidance/description wording are "
        + "response-shaping downstream of scoring. Project-name suppression IS on "
        + "the retrieval path \u2014 but it is gated on the repository basename "
        + "matching a token in the task, and every fixture here is rooted at a "
        + "SWE-bench instance directory whose basename is an instance id.",
      consequence:
        "Zero movement is the expected and required result, and it is meaningful "
        + "rather than structural: it shows the project-name change stayed inside "
        + "its own precondition. Movement here would mean the suppression fired "
        + "where no project was named, a \u00a7110 FAIL. The positive evidence for "
        + "M154 lives in stage5_m154_project_name_poisoning_final.json and "
        + "stage5_m154_reuse_before_write_final.json.",
    },
  };

  await writeFile(
    path.join(outDir, outputName),
    `${JSON.stringify(output, null, 2)}\n`,
  );

  process.stdout.write(
    `frozen: changed=${changedCaseCount}/${allCandidateRows.length} provenanceValid=${provenanceValid}\n`,
  );
}

await main();
