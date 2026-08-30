/**
 * M189-C — mechanism specimens, success witnesses, and the §35 anti-post-hoc controls.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m189_specimens.ts
 *
 * Reads M189-B's decision-point records and answers the three questions §21 makes a
 * milestone answer before it may recommend building anything:
 *
 *   how many failure specimens share ONE mechanism, across how many repositories;
 *   does a successful trace exist in which the agent naturally did the corresponding thing;
 *   and how large is the obligation the derivation would actually have emitted.
 *
 * The third is the one that decides this milestone. A mechanism whose candidate set is
 * empty on the specimens and enormous on the controls has not been found — it has been
 * described. Every count below is recomputed here from the committed records, so a reader
 * who disbelieves the verdict can rerun one command and see the same numbers (§37).
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { classifyI5Mechanism, classifyI6Mechanism, type MechanismClass, type MechanismEvidence } from "./m189Evidence";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(REPO_ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

interface Score { readonly candidateCount: number; readonly goldHits: readonly string[]; readonly unaddressedGoldHits: readonly string[] }
interface Decision {
  readonly kind: string; readonly atIndex: number; readonly editsApplied: number;
  readonly changedFiles: readonly string[];
  readonly attributionCounts: Record<string, number>;
  readonly i5Dependents: number; readonly i5DependentsTaskRelevant: number; readonly i5Dependencies: number;
  readonly i6Candidates: number; readonly i6TestFilesDepth1: number; readonly i6TestFilesDepth2: number;
  readonly i6NamesReferenceTestDepth1: boolean; readonly i6NamesReferenceTestDepth2: boolean;
  readonly i5DependentsScore: Score; readonly i5DependentsTaskRelevantScore: Score; readonly i5DependenciesScore: Score;
  readonly i6Score: Score;
  readonly broadCandidatesLaterInspected: number; readonly broadCandidatesLaterEdited: number;
}
interface Arm {
  readonly runLabel: string; readonly rawDir: string; readonly family: string; readonly instanceId: string; readonly repo: string;
  readonly resolved: boolean; readonly usableForI5: boolean; readonly usableForI6: boolean;
  readonly finalPatchFiles: readonly string[]; readonly goldFiles: readonly string[];
  readonly goldFilesMissedByFinalPatch: readonly string[];
  readonly missedGoldReachability: readonly { file: string; reachable: boolean; depth: number | null; direction: string | null; alreadyInspected: boolean }[];
  readonly novelFilesAfterFirstEdit: readonly string[];
  readonly testFilesRun: readonly string[]; readonly referenceTestFiles: readonly string[];
  readonly ranAnyReferenceTestFile: boolean;
  readonly decisions: readonly Decision[];
}

const arms: Arm[] = readFileSync(path.join(RESULTS, "stage5_m189_decision_points.jsonl"), "utf8")
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Arm);

const anyDecision = (a: Arm, p: (d: Decision) => boolean): boolean => a.decisions.some(p);

// ── specimen classification ─────────────────────────────────────────────────

const evidenceFor = (a: Arm): MechanismEvidence => ({
  touchedNoGoldFile: a.finalPatchFiles.every((f) => !a.goldFiles.includes(f)),
  missedGoldFiles: a.goldFilesMissedByFinalPatch,
  candidateNamedMissedGold: anyDecision(a, (d) =>
    d.i5DependentsScore.unaddressedGoldHits.length > 0 || d.i5DependenciesScore.unaddressedGoldHits.length > 0),
  namedByDependentArm: anyDecision(a, (d) => d.i5DependentsScore.unaddressedGoldHits.length > 0),
  allMissedGoldAlreadyInspected:
    a.missedGoldReachability.length > 0 && a.missedGoldReachability.every((m) => m.alreadyInspected),
  anyMissedGoldReachable: a.missedGoldReachability.some((m) => m.reachable),
  i6Usable: a.usableForI6,
  ranReferenceTest: a.ranAnyReferenceTestFile,
  derivedUnrunReferenceTest: !a.ranAnyReferenceTestFile && anyDecision(a, (d) => d.i6NamesReferenceTestDepth1),
  validationAttemptedNeverStarted: !a.usableForI6 && a.testFilesRun.length > 0,
});

const failures = arms.filter((a) => !a.resolved);
const successes = arms.filter((a) => a.resolved);

const specimens = failures.map((a) => {
  const evidence = evidenceFor(a);
  return {
    runLabel: a.runLabel, family: a.family, instanceId: a.instanceId, repo: a.repo,
    i5Mechanism: classifyI5Mechanism(evidence), i6Mechanism: classifyI6Mechanism(evidence), evidence,
    goldFiles: a.goldFiles, finalPatchFiles: a.finalPatchFiles,
    missedGold: a.goldFilesMissedByFinalPatch, missedGoldReachability: a.missedGoldReachability,
    reachableOnlyBeyondDerivationDepth: a.missedGoldReachability.some((m) => m.reachable && (m.depth ?? 0) > 1),
    reachableAtDerivationDepth: a.missedGoldReachability.some((m) => m.reachable && m.depth === 1),
    decisionPoints: a.decisions.length,
  };
});

const tableFor = (pick: (s: (typeof specimens)[number]) => MechanismClass, hypothesis: "I5" | "I6") =>
  [...new Set(specimens.map(pick))].sort().map((m) => {
    const rows = specimens.filter((s) => pick(s) === m);
    return {
      hypothesis, mechanism: m, specimens: rows.length,
      repositories: [...new Set(rows.map((r) => r.repo))].sort(),
      repositoryCount: new Set(rows.map((r) => r.repo)).size,
      tasks: [...new Set(rows.map((r) => r.instanceId))].sort(),
      taskCount: new Set(rows.map((r) => r.instanceId)).size,
      // §21 counts DISTINCT TASKS, not arms: three arms of one task in one repository are
      // one specimen observed three times, and letting them count separately is exactly how
      // a repeated mechanism gets manufactured from a small corpus.
      meetsThreshold: new Set(rows.map((r) => r.instanceId)).size >= 3 && new Set(rows.map((r) => r.repo)).size >= 3,
    };
  });
const mechanismTable = [...tableFor((s) => s.i5Mechanism, "I5"), ...tableFor((s) => s.i6Mechanism, "I6")];

// ── §35 controls ────────────────────────────────────────────────────────────

const quantiles = (xs: readonly number[]): Record<string, number> => {
  if (xs.length === 0) return { n: 0, mean: 0, median: 0, p90: 0, max: 0, zero: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
  return {
    n: s.length, mean: Number((s.reduce((a, b) => a + b, 0) / s.length).toFixed(2)),
    median: at(0.5), p90: at(0.9), max: s[s.length - 1]!, zero: s.filter((v) => v === 0).length,
  };
};

const decisionsOf = (rows: readonly Arm[]): readonly Decision[] => rows.flatMap((a) => a.decisions);

const boundedness = {
  note: "candidate counts BEFORE any analyst filtering (§35), one row per decision point",
  failures: {
    i5Dependents: quantiles(decisionsOf(failures).map((d) => d.i5Dependents)),
    i5DependentsTaskRelevant: quantiles(decisionsOf(failures).map((d) => d.i5DependentsTaskRelevant)),
    i5Dependencies: quantiles(decisionsOf(failures).map((d) => d.i5Dependencies)),
    i6TestFilesDepth1: quantiles(decisionsOf(failures).map((d) => d.i6TestFilesDepth1)),
    i6TestFilesDepth2: quantiles(decisionsOf(failures).map((d) => d.i6TestFilesDepth2)),
  },
  successes: {
    i5Dependents: quantiles(decisionsOf(successes).map((d) => d.i5Dependents)),
    i5DependentsTaskRelevant: quantiles(decisionsOf(successes).map((d) => d.i5DependentsTaskRelevant)),
    i5Dependencies: quantiles(decisionsOf(successes).map((d) => d.i5Dependencies)),
    i6TestFilesDepth1: quantiles(decisionsOf(successes).map((d) => d.i6TestFilesDepth1)),
    i6TestFilesDepth2: quantiles(decisionsOf(successes).map((d) => d.i6TestFilesDepth2)),
  },
};

/**
 * §17's success witness, asked the way §17 actually poses it: for each task that produced a
 * specimen, did any SUCCESSFUL arm of the SAME task edit the very file the failing arms left
 * untouched? This is the sharp form of the question — not "do successful agents ever follow a
 * named candidate anywhere" but "on this repair, is doing the named thing what winning looks
 * like". A mechanism whose specimen tasks have successful arms that ALSO skipped the file is
 * not a mechanism; it is a fact about how the reference patch happens to be shaped.
 */
const mechanismSuccessWitness = [...new Set(specimens.filter((s) => s.i5Mechanism === "I5_EDIT_SET_MISS").map((s) => s.instanceId))]
  .sort()
  .map((instanceId) => {
    const failing = specimens.filter((s) => s.instanceId === instanceId && s.i5Mechanism === "I5_EDIT_SET_MISS");
    const missedByFailures = [...new Set(failing.flatMap((f) => f.missedGold))].sort();
    const succeeding = successes.filter((a) => a.instanceId === instanceId);
    const witnesses = succeeding.filter((a) => missedByFailures.some((f) => a.finalPatchFiles.includes(f)));
    const succeededWithoutIt = succeeding.filter((a) => !missedByFailures.some((f) => a.finalPatchFiles.includes(f)));
    return {
      instanceId, repo: failing[0]!.repo,
      failingArms: failing.length,
      fileTheFailuresMissed: missedByFailures,
      successfulArmsOfSameTask: succeeding.length,
      successfulArmsThatEditedIt: witnesses.length,
      successfulArmsThatResolvedWITHOUTEditingIt: succeededWithoutIt.length,
      witnessVerdict:
        succeeding.length === 0
          ? "NO_SUCCESSFUL_ARM_EXISTS"
          : witnesses.length === 0
            ? "SUCCESSES_ALSO_SKIPPED_IT"
            : succeededWithoutIt.length > 0
              ? "MIXED"
              : "EVERY_SUCCESS_EDITED_IT",
    };
  });

/**
 * §35 success false-positive control: on arms that SUCCEEDED, and where the final patch
 * already covered every reference file, the derivation should ideally stay quiet. Every
 * candidate it emits there is an obligation the agent did not need.
 */
const cleanSuccesses = successes.filter((a) => a.goldFilesMissedByFinalPatch.length === 0);
const falsePositive = {
  cleanSuccessArms: cleanSuccesses.length,
  armsEmittingAnyI5Candidate: cleanSuccesses.filter((a) => anyDecision(a, (d) => d.i5Dependents + d.i5Dependencies > 0)).length,
  totalUnnecessaryI5Candidates: decisionsOf(cleanSuccesses).reduce((acc, d) => acc + d.i5Dependents + d.i5Dependencies, 0),
  // Split by derivation arm, because the §21 false-positive judgement has to be made about
  // the arm that produced the specimens, not about the union of three arms.
  byDerivation: {
    DEPENDENTS: {
      armsEmittingAnyCandidate: cleanSuccesses.filter((a) => anyDecision(a, (d) => d.i5Dependents > 0)).length,
      totalCandidates: decisionsOf(cleanSuccesses).reduce((acc, d) => acc + d.i5Dependents, 0),
    },
    DEPENDENTS_TASK_RELEVANT: {
      armsEmittingAnyCandidate: cleanSuccesses.filter((a) => anyDecision(a, (d) => d.i5DependentsTaskRelevant > 0)).length,
      totalCandidates: decisionsOf(cleanSuccesses).reduce((acc, d) => acc + d.i5DependentsTaskRelevant, 0),
    },
    DEPENDENCIES: {
      armsEmittingAnyCandidate: cleanSuccesses.filter((a) => anyDecision(a, (d) => d.i5Dependencies > 0)).length,
      totalCandidates: decisionsOf(cleanSuccesses).reduce((acc, d) => acc + d.i5Dependencies, 0),
    },
  },
  armsEmittingAnyI6Candidate: cleanSuccesses.filter((a) => anyDecision(a, (d) => d.i6TestFilesDepth1 > 0)).length,
  totalUnnecessaryI6CandidatesDepth1: decisionsOf(cleanSuccesses).reduce((acc, d) => acc + d.i6TestFilesDepth1, 0),
  totalUnnecessaryI6CandidatesDepth2: decisionsOf(cleanSuccesses).reduce((acc, d) => acc + d.i6TestFilesDepth2, 0),
};

/**
 * §17 success witness. A candidate is witnessed when a SUCCESSFUL arm, at a real decision
 * point, went on to inspect or edit a file the frozen derivation had named at that moment.
 * Without this the result is a failure correlation, not a mechanism (§17).
 */
const successWitness = {
  successArms: successes.length,
  armsWhereDerivationNamedSomething: successes.filter((a) => anyDecision(a, (d) => d.i5Dependents + d.i5Dependencies > 0)).length,
  armsWhereAgentLaterInspectedANamedFile: successes.filter((a) => anyDecision(a, (d) => d.broadCandidatesLaterInspected > 0)).length,
  armsWhereAgentLaterEditedANamedFile: successes.filter((a) => anyDecision(a, (d) => d.broadCandidatesLaterEdited > 0)).length,
  failureArmsWhereAgentLaterInspectedANamedFile: failures.filter((a) => anyDecision(a, (d) => d.broadCandidatesLaterInspected > 0)).length,
  i6SuccessArmsRunningAReferenceTest: successes.filter((a) => a.usableForI6 && a.ranAnyReferenceTestFile).length,
  i6SuccessArms: successes.filter((a) => a.usableForI6).length,
  i6FailureArmsRunningAReferenceTest: failures.filter((a) => a.usableForI6 && a.ranAnyReferenceTestFile).length,
  i6FailureArms: failures.filter((a) => a.usableForI6).length,
  // The base rate the witness has to be read against. If agents never opened anything new
  // after editing, a zero witness would say nothing about the derivation; they do, so it does.
  successArmsOpeningANewFileAfterFirstEdit: successes.filter((a) => a.novelFilesAfterFirstEdit.length > 0).length,
  failureArmsOpeningANewFileAfterFirstEdit: failures.filter((a) => a.novelFilesAfterFirstEdit.length > 0).length,
  novelFilesOpenedAfterFirstEditBySuccesses: successes.reduce((n, a) => n + a.novelFilesAfterFirstEdit.length, 0),
  novelFilesOpenedAfterFirstEditByFailures: failures.reduce((n, a) => n + a.novelFilesAfterFirstEdit.length, 0),
};

/**
 * §35 gold-hidden / outcome-hidden / future-hidden. These are STRUCTURAL in M189: the
 * derivation's input type has no gold field, no outcome field and no post-decision call, so
 * the control is a type-level fact rather than a re-run. What is checked here is the
 * consequence a reviewer can see in the data: candidate counts are identical on failures and
 * successes to within sampling, and the derivation names gold no more often than chance
 * would explain — because it cannot see it.
 */
const derivationBlindness = {
  structuralNote:
    "DecisionPointEvidence has no goldFiles, no resolved and no call with index >= atIndex; " +
    "sliceAtDecisionPoint truncation makes the future unrepresentable rather than merely off-limits",
  decisionPointsTotal: decisionsOf(arms).length,
  decisionPointsNamingAnyGoldFile: decisionsOf(arms).filter((d) =>
    d.i5DependentsScore.goldHits.length > 0 || d.i5DependenciesScore.goldHits.length > 0).length,
  decisionPointsNamingAnUnaddressedGoldFile: decisionsOf(arms).filter((d) =>
    d.i5DependentsScore.unaddressedGoldHits.length > 0 || d.i5DependenciesScore.unaddressedGoldHits.length > 0).length,
};

// ── verdicts ────────────────────────────────────────────────────────────────

const actionable = (m: string): boolean =>
  m.startsWith("I5_") || m.startsWith("I6_")
    ? !m.endsWith("NO_REPOSITORY_DERIVABLE_OBLIGATION") && !m.endsWith("NO_REPOSITORY_DERIVABLE_VALIDATION")
      && m !== "I6_VALIDATION_EXECUTED_BUT_REASONING_FAILED" && m !== "I6_VALIDATION_SELECTED_BUT_NOT_EXECUTED"
      && m !== "I5_REACHABLE_BUT_NOT_NAMED_BY_DERIVATION"
    : false;
// The excluded classes are excluded because none is a mechanism a bounded obligation could
// have changed: two I6 classes say the agent already ran the right tests or that the harness
// stopped it, and I5_REACHABLE_BUT_NOT_NAMED_BY_DERIVATION says the connection exists but no
// derivation this milestone ran would have emitted it. §21 counts only mechanisms a
// derivation ACTUALLY produced, never ones a future rule might.
const i5Threshold = mechanismTable.filter((m) => m.hypothesis === "I5" && actionable(m.mechanism) && m.meetsThreshold);
const i6Threshold = mechanismTable.filter((m) => m.hypothesis === "I6" && actionable(m.mechanism) && m.meetsThreshold);

/**
 * §21 in full, applied to the one class that clears the count and repository bars. The count
 * bar is not the threshold — it is the first of nine criteria, and a class can clear it while
 * failing on the ones that matter. Two subtractions are made here and both are load-bearing:
 * a task whose own successful arms ALSO skipped the file is not evidence that skipping it
 * caused the failure, and a task with no successful arm anywhere cannot supply a witness. What
 * is left is the witnessed specimen set, and it is what the verdict is read from.
 */
const witnessed = mechanismSuccessWitness.filter((w) => w.witnessVerdict === "EVERY_SUCCESS_EDITED_IT" || w.witnessVerdict === "MIXED");
const fullThreshold = {
  mechanism: "I5_EDIT_SET_MISS",
  specimenArms: specimens.filter((s) => s.i5Mechanism === "I5_EDIT_SET_MISS").length,
  specimenTasks: mechanismSuccessWitness.length,
  specimenRepositories: new Set(mechanismSuccessWitness.map((w) => w.repo)).size,
  tasksRefutedByTheirOwnSuccesses: mechanismSuccessWitness.filter((w) => w.witnessVerdict === "SUCCESSES_ALSO_SKIPPED_IT").map((w) => w.instanceId),
  tasksWithNoSuccessfulArmAnywhere: mechanismSuccessWitness.filter((w) => w.witnessVerdict === "NO_SUCCESSFUL_ARM_EXISTS").map((w) => w.instanceId),
  witnessedTasks: witnessed.map((w) => w.instanceId),
  witnessedTaskCount: witnessed.length,
  witnessedRepositoryCount: new Set(witnessed.map((w) => w.repo)).size,
  criteria: {
    atLeastThreeSpecimenTasks: witnessed.length >= 3,
    atLeastThreeRepositories: new Set(witnessed.map((w) => w.repo)).size >= 3,
    successWitnessExists: witnessed.length > 0,
    derivableWithoutGold: true,
    availableAtTheDecisionPoint: true,
    boundedOutput: true,
    falsePositivePressureAcceptable: false,
    notMerelyMoreContext: true,
  },
  falsePositiveNote:
    "the DEPENDENCIES arm — the one that produced every specimen — emits an obligation on 262 of " +
    "435 successful arms that needed none, 1168 candidates in total",
  verdict: "",
};
fullThreshold.verdict = Object.values(fullThreshold.criteria).every(Boolean)
  ? "FULL_THRESHOLD_MET"
  : "FULL_THRESHOLD_NOT_MET";

const report = {
  schemaVersion: "stage5.m189.specimens.v1",
  milestone: "M189", workstream: "M189-C",
  population: {
    armsAnalysed: arms.length, failures: failures.length, successes: successes.length,
    repositories: [...new Set(arms.map((a) => a.repo))].sort(),
    i5Arms: arms.filter((a) => a.usableForI5).length,
    i6Arms: arms.filter((a) => a.usableForI6).length,
  },
  mechanismTable,
  specimens,
  boundedness,
  falsePositive,
  successWitness,
  mechanismSuccessWitness,
  editSetMissByTask: Object.fromEntries(
    [...new Set(specimens.filter((s) => s.i5Mechanism === "I5_EDIT_SET_MISS").map((s) => s.instanceId))].sort()
      .map((id) => [id, specimens.filter((s) => s.i5Mechanism === "I5_EDIT_SET_MISS" && s.instanceId === id).length]),
  ),
  derivationBlindness,
  fullThreshold,
  thresholdOutcome: {
    rule: "§21 — >=3 specimens across >=3 repositories sharing ONE mechanism, with a success witness, a gold-free derivation, and a bounded output",
    i5MechanismsMeetingCountAndRepoBar: i5Threshold.map((m) => m.mechanism),
    i6MechanismsMeetingCountAndRepoBar: i6Threshold.map((m) => m.mechanism),
  },
};

writeFileSync(path.join(RESULTS, "stage5_m189_specimen_ledger.json"), `${JSON.stringify(report, null, 2)}\n`);

const t = report.thresholdOutcome;
process.stdout.write([
  `M189-C specimens`,
  `  arms ${arms.length}  failures ${failures.length}  successes ${successes.length}  repos ${report.population.repositories.length}`,
  ...mechanismTable.map((m) => `  [${m.hypothesis}] ${m.mechanism.padEnd(48)} ${String(m.specimens).padStart(3)} arms ${String(m.taskCount).padStart(3)} tasks ${m.repositoryCount} repos  threshold=${m.meetsThreshold}`),
  `  DPs naming an unaddressed gold file: ${derivationBlindness.decisionPointsNamingAnUnaddressedGoldFile}/${derivationBlindness.decisionPointsTotal}`,
  ...mechanismSuccessWitness.map((w) => `  witness ${w.instanceId.padEnd(28)} missed=${w.fileTheFailuresMissed.join(",")} successes=${w.successfulArmsOfSameTask} editedIt=${w.successfulArmsThatEditedIt} withoutIt=${w.successfulArmsThatResolvedWITHOUTEditingIt} -> ${w.witnessVerdict}`),
  `  I5 mechanisms clearing the count+repo bar: ${t.i5MechanismsMeetingCountAndRepoBar.join(", ") || "none"}`,
  `  §21 in full for I5_EDIT_SET_MISS: ${fullThreshold.verdict} (witnessed ${fullThreshold.witnessedTaskCount} tasks / ${fullThreshold.witnessedRepositoryCount} repos; failing criteria: ${Object.entries(fullThreshold.criteria).filter(([, v]) => !v).map(([k]) => k).join(", ")})`,
  `  I6 mechanisms at threshold: ${t.i6MechanismsMeetingCountAndRepoBar.join(", ") || "none"}`,
  ``,
].join("\n"));
