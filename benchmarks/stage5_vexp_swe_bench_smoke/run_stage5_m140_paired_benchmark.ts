// M140 multi-suite paired benchmark driver.
//
// `run_stage5_m134_paired_comparison.ts` compares exactly one suite and keeps only
// the comparison, discarding both sides' rows. M140 needs the frozen-50 aggregate
// (Django expanded + cross_repo_30) plus the per-side quality metrics behind it, so
// this driver runs the same provenance-safe protocol over several suites, retains
// each side's rows, and emits the aggregate.
//
// The scorer/protocol/fixture identity are shared and fixed; only the declared
// implementation root and its own independently prepared index differ per side.
// Semantic differences are the measurement here, so a non-zero `changedCases` is a
// result, not a harness failure — `provenanceValid` is what must hold.
//
// No agent, Docker, VEXP, network, or paid API is used.

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { comparePairedArtifacts } from "./benchmarkProvenance";
import { runRetrievalEval, type RetrievalEvalArtifact, type RetrievalEvalRow } from "./run_stage5_retrieval_eval";
import { createHistoricalEvaluator } from "./run_stage5_m134_historical_replay";

export interface SuiteSpec {
  readonly name: string;
  readonly predecessorFixture: string;
  readonly candidateFixture: string;
  readonly fixtureIdentity: string;
}

export interface QualitySummary {
  readonly cases: number;
  readonly evaluated: number;
  readonly top1GoldFile: number;
  readonly top3GoldFile: number;
  readonly goldFileAnywhere: number;
  readonly goldSymbolAnywhere: number;
  readonly missingGold: number;
  readonly meanPivotCount: number;
  readonly meanSupportCount: number;
  readonly meanEstimatedTokens: number | null;
}

/** Quality metrics the M140 three-state table reports for each implementation. */
export function summarizeQuality(rows: readonly RetrievalEvalRow[]): QualitySummary {
  const evaluated = rows.filter((row) => row.result !== "workspace_error" && row.result !== "fixture_error");
  const count = (predicate: (row: RetrievalEvalRow) => boolean): number => evaluated.filter(predicate).length;
  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000;
  const tokens = evaluated
    .map((row) => row.estimated_tokens)
    .filter((value): value is number => value !== null);
  return {
    cases: rows.length,
    evaluated: evaluated.length,
    top1GoldFile: count((row) => row.contains_expected_file_top1),
    top3GoldFile: count((row) => row.contains_expected_file_top3),
    goldFileAnywhere: count((row) => row.contains_expected_file_anywhere),
    goldSymbolAnywhere: count((row) => row.contains_expected_symbol_anywhere),
    missingGold: count((row) => !row.contains_expected_file_anywhere),
    meanPivotCount: mean(evaluated.map((row) => row.pivot_count)),
    meanSupportCount: mean(evaluated.map((row) => row.support_count)),
    meanEstimatedTokens: tokens.length === 0 ? null : mean(tokens),
  };
}

interface Config {
  readonly predecessorRoot: string;
  readonly candidateRoot: string;
  readonly predecessorLabel: string;
  readonly candidateLabel: string;
  readonly suites: readonly SuiteSpec[];
  readonly outDir: string;
  readonly reportPrefix: string;
}

async function evaluateSide(
  root: string,
  fixture: string,
  fixtureIdentity: string,
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
    fixtureIdentityPath: fixtureIdentity,
  }, { evaluateEntry: evaluator });
}

async function main(config: Config): Promise<void> {
  const predecessorCommit = git(config.predecessorRoot, ["rev-parse", "HEAD"]);
  const candidateCommit = git(config.candidateRoot, ["rev-parse", "HEAD"]);
  const suiteResults = [];
  const allPredecessorRows: RetrievalEvalRow[] = [];
  const allCandidateRows: RetrievalEvalRow[] = [];

  for (const suite of config.suites) {
    const [predecessor, candidate] = await Promise.all([
      evaluateSide(config.predecessorRoot, suite.predecessorFixture, suite.fixtureIdentity, config.outDir, `${config.reportPrefix}-${suite.name}-predecessor`),
      evaluateSide(config.candidateRoot, suite.candidateFixture, suite.fixtureIdentity, config.outDir, `${config.reportPrefix}-${suite.name}-candidate`),
    ]);
    const comparison = comparePairedArtifacts(predecessor, candidate, predecessorCommit);
    allPredecessorRows.push(...predecessor.rows);
    allCandidateRows.push(...candidate.rows);

    await writeFile(
      path.join(config.outDir, `${config.reportPrefix}_${suite.name}_rows.json`),
      `${JSON.stringify({
        suite: suite.name,
        predecessor: { label: config.predecessorLabel, commit: predecessorCommit, rows: predecessor.rows, aggregate: predecessor.aggregate },
        candidate: { label: config.candidateLabel, commit: candidateCommit, rows: candidate.rows, aggregate: candidate.aggregate },
      }, null, 2)}\n`,
      "utf8",
    );

    suiteResults.push({
      name: suite.name,
      caseCount: candidate.rows.length,
      fixtureHash: candidate.benchmarkProvenance.fixture.hash,
      sameFixtureHash: predecessor.benchmarkProvenance.fixture.hash === candidate.benchmarkProvenance.fixture.hash,
      sameTargetCorpusHash: predecessor.benchmarkProvenance.targetCorpus.hash === candidate.benchmarkProvenance.targetCorpus.hash,
      isolatedIndexes: path.resolve(suite.predecessorFixture) !== path.resolve(suite.candidateFixture),
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
    process.stdout.write(`suite ${suite.name}: valid=${comparison.validity.valid} changed=${comparison.changedCases.length}/${candidate.rows.length}\n`);
  }

  const provenanceValid = suiteResults.every((suite) => suite.provenanceValid && suite.sameFixtureHash && suite.isolatedIndexes);
  const output = {
    schemaVersion: "stage5.m140.multi-suite-paired-comparison.v1",
    predecessor: { label: config.predecessorLabel, commit: predecessorCommit, tree: git(config.predecessorRoot, ["rev-parse", "HEAD^{tree}"]) },
    candidate: { label: config.candidateLabel, commit: candidateCommit, tree: git(config.candidateRoot, ["rev-parse", "HEAD^{tree}"]) },
    provenanceValid,
    suites: suiteResults,
    frozen50: {
      caseCount: allCandidateRows.length,
      changedCaseCount: suiteResults.reduce((sum, suite) => sum + suite.changedCases.length, 0),
      quality: {
        predecessor: summarizeQuality(allPredecessorRows),
        candidate: summarizeQuality(allCandidateRows),
      },
    },
  };
  const outPath = path.join(config.outDir, `${config.reportPrefix}_paired_comparison.json`);
  await writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`wrote ${outPath}\nprovenanceValid=${provenanceValid} frozen50Changed=${output.frozen50.changedCaseCount}/${output.frozen50.caseCount}\n`);
  if (!provenanceValid) process.exitCode = 1;
}

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString().trim();
}

function parseArgs(argv: readonly string[]): Config {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined) throw new Error("Invalid paired-benchmark arguments.");
    values.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) throw new Error(`Missing ${flag}.`);
    return value;
  };
  // --suite name:predecessorFixture:candidateFixture:fixtureIdentity (repeatable via ;)
  const suites = required("--suites").split(";").map((spec) => {
    const [name, predecessorFixture, candidateFixture, fixtureIdentity] = spec.split(",");
    if (name === undefined || predecessorFixture === undefined || candidateFixture === undefined || fixtureIdentity === undefined) {
      throw new Error(`Invalid suite spec: ${spec}`);
    }
    return {
      name,
      predecessorFixture: path.resolve(predecessorFixture),
      candidateFixture: path.resolve(candidateFixture),
      fixtureIdentity: path.resolve(fixtureIdentity),
    };
  });
  return {
    predecessorRoot: path.resolve(required("--predecessor-root")),
    candidateRoot: path.resolve(required("--candidate-root")),
    predecessorLabel: values.get("--predecessor-label") ?? "predecessor",
    candidateLabel: values.get("--candidate-label") ?? "candidate",
    suites,
    outDir: path.resolve(required("--out-dir")),
    reportPrefix: values.get("--report-prefix") ?? "stage5_m140",
  };
}

if (import.meta.main) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
