// Run the behavioural cross-repository corpus through the product path and
// record the oracle-repo and workspace baselines.
//
// Against M152 (`72ce221c`) this establishes the two numbers M153 is judged
// against (§26, §27):
//
//   oracle    does behavioural retrieval generalise off ARC at all?
//   workspace can the product find the right repository without a hint?
//
// The same runner produces the post-implementation measurement, so the two sides
// are computed by identical code rather than by two scripts that agree by
// inspection.
//
//   bun run_stage5_m153_baseline.ts --label m152_baseline [--out <dir>] [--skip-prepare]
//
// No agent, Docker, VEXP, network or paid API.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  aggregate,
  BEHAVIORAL_CASES,
  buildWorkspaceHost,
  prepareRepository,
  repoRootFor,
  resetSessionState,
  runCase,
  sessionFingerprint,
  sessionScopeFor,
  type CaseOutcome,
} from "./m153BehavioralHarness";
import { CORPUS_REPOSITORIES, splitOf } from "./behavioralCrossRepoCorpus";

function argument(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const label = argument("--label", "m152_baseline");
const outDir = argument("--out", path.join(import.meta.dir, "results"));
const skipPrepare = process.argv.includes("--skip-prepare");

await mkdir(outDir, { recursive: true });

if (!skipPrepare) {
  for (const repo of CORPUS_REPOSITORIES) {
    const started = Date.now();
    await prepareRepository(repoRootFor(repo.key));
    console.log(`prepared ${repo.key} (${Date.now() - started}ms)`);
  }
}

// A host that is NOT a corpus member, so no repository gets an advantage from
// also being the thing the workspace config lives in.
const hostRoot = await mkdtemp(path.join(os.tmpdir(), "m153-host-"));
let oracle: CaseOutcome[] = [];
let workspace: CaseOutcome[] = [];
const isolation: Array<{
  caseId: string;
  oracleArmStartBytes: number;
  workspaceArmStartBytes: number;
  armsStartedEquivalent: boolean;
}> = [];
try {
  await buildWorkspaceHost({ hostRoot, primaryRepoAlias: "requests" });
  console.log(`workspace host ${hostRoot} (default=requests, ${CORPUS_REPOSITORIES.length} members)`);

  // §48-§51. Every case in every arm starts from the SAME mutable product state:
  // none. Without this the arms are not independent — a workspace request that
  // routes somewhere writes observations there, and the next oracle call reads
  // them, so the arm under test perturbs its own control.
  const scope = sessionScopeFor(hostRoot);
  for (const entry of BEHAVIORAL_CASES) {
    resetSessionState(scope);
    const beforeOracle = scope.map((root) => sessionFingerprint(root).bytes);
    oracle.push(await runCase(entry, "oracle", hostRoot));

    resetSessionState(scope);
    const beforeWorkspace = scope.map((root) => sessionFingerprint(root).bytes);
    workspace.push(await runCase(entry, "workspace", hostRoot));

    isolation.push({
      caseId: entry.id,
      // The invariant, recorded per case rather than asserted once: both arms
      // began with every session store absent.
      oracleArmStartBytes: beforeOracle.reduce((a, b) => a + b, 0),
      workspaceArmStartBytes: beforeWorkspace.reduce((a, b) => a + b, 0),
      armsStartedEquivalent: beforeOracle.every((b) => b === 0) && beforeWorkspace.every((b) => b === 0),
    });
  }
  resetSessionState(scope);
} finally {
  await rm(hostRoot, { recursive: true, force: true });
}

function report(mode: "oracle" | "workspace", outcomes: readonly CaseOutcome[]) {
  const forSplit = (split: string) => {
    const ids = new Set(
      BEHAVIORAL_CASES.filter((entry) => splitOf(entry) === split).map((entry) => entry.id),
    );
    const subset = outcomes.filter((outcome) => ids.has(outcome.caseId));
    return aggregate(subset, BEHAVIORAL_CASES.filter((entry) => ids.has(entry.id)));
  };
  const byRepository = Object.fromEntries(
    CORPUS_REPOSITORIES.map((repo) => {
      const ids = new Set(
        BEHAVIORAL_CASES.filter((entry) => entry.expectedRepository === repo.key).map((e) => e.id),
      );
      return [
        repo.key,
        aggregate(
          outcomes.filter((o) => ids.has(o.caseId)),
          BEHAVIORAL_CASES.filter((e) => ids.has(e.id)),
        ),
      ];
    }),
  );
  const categories = [...new Set(BEHAVIORAL_CASES.map((entry) => entry.category))].sort();
  const byCategory = Object.fromEntries(
    categories.map((category) => {
      const ids = new Set(
        BEHAVIORAL_CASES.filter((entry) => entry.category === category).map((e) => e.id),
      );
      return [
        category,
        aggregate(
          outcomes.filter((o) => ids.has(o.caseId)),
          BEHAVIORAL_CASES.filter((e) => ids.has(e.id)),
        ),
      ];
    }),
  );
  return {
    label,
    mode,
    implementation: "M152 72ce221c7006dc9e477dcbfa2d7e7372c136fa8c",
    overall: aggregate(outcomes, BEHAVIORAL_CASES),
    calibration: forSplit("calibration"),
    holdout: forSplit("holdout"),
    byRepository,
    byCategory,
    cases: outcomes,
  };
}

const oracleReport = report("oracle", oracle);
const workspaceReport = report("workspace", workspace);

await writeFile(
  path.join(outDir, `stage5_m153_${label}_oracle_baseline.json`),
  `${JSON.stringify(oracleReport, null, 2)}\n`,
);
await writeFile(
  path.join(outDir, `stage5_m153_${label}_workspace_baseline.json`),
  `${JSON.stringify(workspaceReport, null, 2)}\n`,
);

const line = (name: string, agg: any) =>
  `${name.padEnd(12)} repo@1=${String(agg.repositoryTop1).padStart(5)}  impl@1=${String(agg.primaryTop1).padStart(5)}`
  + `  impl@3=${String(agg.primaryTop3).padStart(5)}  support=${String(agg.requiredSupportPresent).padStart(5)}`
  + `  clean=${String(agg.cleanAnswerRate).padStart(5)}  misleading=${String(agg.casesWithMisleading).padStart(5)}`
  + `  empty=${String(agg.emptyContext).padStart(5)}`;

for (const [mode, rep] of [["ORACLE", oracleReport], ["WORKSPACE", workspaceReport]] as const) {
  console.log(`\n=== ${mode} ===`);
  console.log(line("overall", rep.overall));
  console.log(line("calibration", rep.calibration));
  console.log(line("holdout", rep.holdout));
  console.log(
    `absence held=${rep.overall.absenceHeld}  falsePremise=${rep.overall.falsePremiseReconstructed}`
    + `  abstentions=${rep.overall.abstentions}  errors=${rep.overall.errors}`,
  );
}
await writeFile(
  path.join(outDir, `stage5_m153_session_isolation_validation${label === "m152" ? "" : `_${label}`}.json`),
  `${JSON.stringify({
    label,
    policy: "session.sqlite discarded for every corpus repository and the host before EACH arm of EACH case",
    scopeSize: sessionScopeFor(hostRoot).length,
    casesChecked: isolation.length,
    allArmsStartedEquivalent: isolation.every((row) => row.armsStartedEquivalent),
    violations: isolation.filter((row) => !row.armsStartedEquivalent),
    cases: isolation,
  }, null, 2)}\n`,
);

console.log(
  `session isolation: ${isolation.length} cases, arms equivalent = ${isolation.every((r) => r.armsStartedEquivalent)}`,
);
console.log(`\nwrote stage5_m153_${label}_{oracle,workspace}_baseline.json → ${outDir}`);
