// Authoritative predecessor-vs-candidate deterministic retrieval comparison.
// The scorer/protocol is shared; each side loads product code from its declared
// implementation root and consumes the fixture's independently prepared index.

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { comparePairedArtifacts } from "./benchmarkProvenance";
import { runRetrievalEval } from "./run_stage5_retrieval_eval";
import { createHistoricalEvaluator } from "./run_stage5_m134_historical_replay";

interface Config {
  readonly predecessorRoot: string;
  readonly candidateRoot: string;
  readonly predecessorFixture: string;
  readonly candidateFixture: string;
  readonly out: string;
  readonly reportName: string;
  readonly fixtureIdentity: string;
}

async function main(config: Config): Promise<void> {
  const predecessorCommit = git(config.predecessorRoot, ["rev-parse", "HEAD"]);
  const [predecessorEvaluator, candidateEvaluator] = await Promise.all([
    createHistoricalEvaluator(config.predecessorRoot),
    createHistoricalEvaluator(config.candidateRoot),
  ]);
  const [predecessor, candidate] = await Promise.all([
    runRetrievalEval({
      fixture: config.predecessorFixture,
      out: path.dirname(config.out),
      reportName: `${config.reportName}-predecessor`,
      artifactState: "authoritative",
      implementationRoot: config.predecessorRoot,
      fixtureIdentityPath: config.fixtureIdentity,
    }, { evaluateEntry: predecessorEvaluator }),
    runRetrievalEval({
      fixture: config.candidateFixture,
      out: path.dirname(config.out),
      reportName: `${config.reportName}-candidate`,
      artifactState: "authoritative",
      implementationRoot: config.candidateRoot,
      fixtureIdentityPath: config.fixtureIdentity,
    }, { evaluateEntry: candidateEvaluator }),
  ]);
  const comparison = comparePairedArtifacts(predecessor, candidate, predecessorCommit);
  const output = {
    ...comparison,
    protocol: {
      sameFixtureHash: predecessor.benchmarkProvenance.fixture.hash === candidate.benchmarkProvenance.fixture.hash,
      sameTargetCorpus: predecessor.benchmarkProvenance.targetCorpus.hash === candidate.benchmarkProvenance.targetCorpus.hash,
      isolatedIndexes: path.resolve(config.predecessorFixture) !== path.resolve(config.candidateFixture),
      predecessor: predecessor.benchmarkProvenance,
      candidate: candidate.benchmarkProvenance,
    },
  };
  await writeFile(config.out, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`paired ${predecessorCommit.slice(0, 8)} -> ${candidate.benchmarkProvenance.vtrace.commit?.slice(0, 8) ?? "dirty"}: pass=${comparison.pass}, changed=${comparison.changedCases.length}\n`);
  if (!comparison.pass) process.exitCode = 1;
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
    if (flag === undefined || value === undefined) throw new Error("Invalid paired-comparison arguments.");
    values.set(flag, value);
  }
  const requiredPath = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) throw new Error(`Missing ${flag}.`);
    return path.resolve(value);
  };
  return {
    predecessorRoot: requiredPath("--predecessor-root"),
    candidateRoot: requiredPath("--candidate-root"),
    predecessorFixture: requiredPath("--predecessor-fixture"),
    candidateFixture: requiredPath("--candidate-fixture"),
    out: requiredPath("--out"),
    reportName: values.get("--report-name") ?? "stage5_m134_paired",
    fixtureIdentity: requiredPath("--fixture-identity"),
  };
}

if (import.meta.main) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
