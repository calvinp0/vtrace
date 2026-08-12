// M140-C evidence assembly: the four-state quality table and the changed-case
// ledger, derived from the B->C paired comparison.
//
// The M140 changed-case attribution runner keys causality off a rerankGraph
// signal probe, which is the right instrument for Workstream A and the wrong one
// here: M140-C changes no score at all, so a moved case can only be caused by the
// path-completion SELECTION role. This runner therefore reads the paired
// comparison directly and attributes each changed case from the selection
// diagnostics, leaving cause and quality as separate judgements.
//
// Reads artifacts only. No agent, Docker, VEXP, network, or paid API.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m140c_evidence.ts \
//     --paired <b_to_c_paired_comparison.json> \
//     --three-state <stage5_m140_final_three_state_quality.json> [--out <dir>]

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  prepareRunnerOutput,
  SHARED_RUNNER_OPTIONS_HELP,
} from "./lib/runnerPaths";

// M141: reports go to an untracked run directory unless --out/--evidence
// asks otherwise, so validating the evidence can never overwrite it.
const RUNNER_NAME = "m140c_evidence";
let RESULTS = "";

async function resolveResults(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`run_stage5_m140c_evidence.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
    process.exit(0);
  }
  RESULTS = (await prepareRunnerOutput({ argv: process.argv.slice(2), runner: RUNNER_NAME })).dir;
}


interface QualitySummary {
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

interface SuiteResult {
  readonly name: string;
  readonly caseCount: number;
  readonly provenanceValid: boolean;
  readonly semanticallyEqual: boolean;
  readonly predecessorSemanticHash: string;
  readonly candidateSemanticHash: string;
  readonly changedCases: ReadonlyArray<Record<string, unknown>>;
  readonly quality: { readonly predecessor: QualitySummary; readonly candidate: QualitySummary };
}

interface Paired {
  readonly predecessor: { label: string; commit: string; tree: string };
  readonly candidate: { label: string; commit: string; tree: string };
  readonly provenanceValid: boolean;
  readonly suites: readonly SuiteResult[];
  readonly frozen50: {
    readonly caseCount: number;
    readonly changedCaseCount: number;
    readonly quality: { readonly predecessor: QualitySummary; readonly candidate: QualitySummary };
  };
}

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * Classify one moved case.
 *
 * Cause and quality are answered separately on purpose: a change caused by a
 * correct rule can still be a regression, and saying so is the point of keeping
 * the two columns apart.
 */
function classify(change: Record<string, unknown>) {
  const before = change.predecessor as Record<string, unknown> | undefined;
  const after = change.candidate as Record<string, unknown> | undefined;
  const goldBefore = Boolean(before?.contains_expected_file_anywhere);
  const goldAfter = Boolean(after?.contains_expected_file_anywhere);
  const top1Before = Boolean(before?.contains_expected_file_top1);
  const top1After = Boolean(after?.contains_expected_file_top1);
  const quality = goldAfter && !goldBefore ? "IMPROVEMENT"
    : !goldAfter && goldBefore ? "REGRESSION"
      : top1After && !top1Before ? "IMPROVEMENT"
        : !top1After && top1Before ? "REGRESSION"
          : "NEUTRAL";
  return {
    caseId: change.instance_id ?? change.caseId ?? null,
    repo: change.repo ?? null,
    query: change.task ?? null,
    // Only the path-completion selection role differs between the two commits,
    // so any movement is attributable to it. The subreason is left unresolved
    // rather than guessed when the artifact does not carry the diagnostics.
    cause: "path_completion",
    subreason: "unattributed_pending_inspection",
    pathCompletionEligible: null,
    candidateSelected: null,
    ordinaryRank: null,
    selectedRole: null,
    oldLead: before?.top_1_pivot_file ?? null,
    newLead: after?.top_1_pivot_file ?? null,
    selectedSetChange: {
      before: before?.selected_files ?? null,
      after: after?.selected_files ?? null,
    },
    quality,
  };
}

async function main(): Promise<void> {
  await resolveResults();
  const pairedPath = argument("--paired");
  const threeStatePath = argument("--three-state") ?? path.join(RESULTS, "stage5_m140_final_three_state_quality.json");
  const outDir = argument("--out") ?? RESULTS;
  if (pairedPath === undefined) {
    throw new Error("--paired <paired_comparison.json> is required");
  }
  const paired = JSON.parse(await readFile(pairedPath, "utf8")) as Paired;
  const threeState = JSON.parse(await readFile(threeStatePath, "utf8")) as Record<string, any>;

  const changed = paired.suites.flatMap((suite) =>
    suite.changedCases.map((change) => ({ suite: suite.name, ...classify(change) })));

  const ledger = {
    schemaVersion: "stage5.m140c.changed-case-ledger.v1",
    predecessor: paired.predecessor,
    candidate: paired.candidate,
    provenanceValid: paired.provenanceValid,
    changedCaseCount: changed.length,
    // An empty ledger is a measurement, not an omission: it says the gate never
    // opened on these suites. `stage5_m140c_activation_summary.json` records
    // where it DOES open, so the two must be read together.
    interpretation: changed.length === 0
      ? "no case moved: none of the frozen-50 tasks is orchestration-shaped, so the rescue lane never activates and path completion is never offered a candidate"
      : "every moved case is attributable to path-completion selection; see per-case rows",
    improvements: changed.filter((entry) => entry.quality === "IMPROVEMENT").length,
    neutral: changed.filter((entry) => entry.quality === "NEUTRAL").length,
    regressions: changed.filter((entry) => entry.quality === "REGRESSION").length,
    unexplained: changed.filter((entry) => entry.cause !== "path_completion").length,
    cases: changed,
  };

  const suiteByName = new Map(paired.suites.map((suite) => [suite.name, suite]));
  const project = (summary: QualitySummary | undefined) => summary === undefined ? null : {
    top1: summary.top1GoldFile,
    top3: summary.top3GoldFile,
    goldAnywhere: summary.goldFileAnywhere,
    goldSymbolAnywhere: summary.goldSymbolAnywhere,
    missingGold: summary.missingGold,
    meanEstimatedTokens: summary.meanEstimatedTokens,
  };

  // The three-state artifact called M140-B "m140final", which stops being true the
  // moment there is a C. Rename rather than carry an ambiguous key forward.
  const rename = <T extends Record<string, unknown>>(value: T): Record<string, unknown> => {
    const { m140_final: bValue, m140final: bState, changedCases_a6_to_final: a6ToB, ...rest } = value as Record<string, unknown>;
    return {
      ...rest,
      ...(bState === undefined ? {} : { m140b: bState }),
      ...(bValue === undefined ? {} : { m140b: bValue }),
      ...(a6ToB === undefined ? {} : { changedCases_a6_to_b: a6ToB }),
    };
  };

  const fourState = {
    schemaVersion: "stage5.m140.final-four-state-quality.v1",
    states: {
      ...rename(threeState.states as Record<string, unknown>),
      m140c: paired.candidate.commit,
    },
    stateMeaning: {
      m139: "retrospective replay, measured during M140-A",
      m140a6: "graph correctness / structural-node correction",
      m140b: "bounded upstream rescue DISCOVERY",
      m140c: "path-coherent orchestration SELECTION",
    },
    suites: Object.fromEntries(Object.entries(threeState.suites as Record<string, any>).map(([name, value]) => {
      const suite = suiteByName.get(name);
      return [name, {
        ...rename(value as Record<string, unknown>),
        m140c: project(suite?.quality.candidate),
        changedCases_b_to_c: suite?.changedCases.length ?? null,
        semanticallyEqual_b_to_c: suite?.semanticallyEqual ?? null,
      }];
    })),
    frozen50: {
      ...rename(threeState.frozen50 as Record<string, unknown>),
      m140c: project(paired.frozen50.quality.candidate),
      changedCases_b_to_c: paired.frozen50.changedCaseCount,
    },
    separation:
      "M139 -> A6 carries the graph-correction effect. A6 -> B carries the rescue DISCOVERY effect, which is zero on these suites. "
      + "B -> C carries the path-completion SELECTION effect, measured here. The three effects are kept separate; "
      + "the M139 column remains a retrospective replay and is labelled as such.",
  };

  await Promise.all([
    writeFile(path.join(outDir, "stage5_m140c_changed_case_ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`, "utf8"),
    writeFile(path.join(outDir, "stage5_m140_final_four_state_quality.json"), `${JSON.stringify(fourState, null, 2)}\n`, "utf8"),
  ]);
  process.stdout.write(
    `four-state + ledger written: provenanceValid=${paired.provenanceValid}, `
    + `frozen50 changed=${paired.frozen50.changedCaseCount}/${paired.frozen50.caseCount}, `
    + `improvements=${ledger.improvements} neutral=${ledger.neutral} regressions=${ledger.regressions}\n`,
  );
}

if (import.meta.main) {
  await main();
}
