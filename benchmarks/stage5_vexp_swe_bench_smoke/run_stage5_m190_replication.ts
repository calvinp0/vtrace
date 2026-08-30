/**
 * M190 — out-of-sample replication of the frozen M189 I5 derivation.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m190_replication.ts
 *   M190_BLIND=1 bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m190_replication.ts
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m190_replication.ts --analyze-only
 *
 * THIS SCRIPT DOES NOT CONTAIN A DERIVATION. That is the point.
 *
 * M190 asks whether a hypothesis discovered on one stratum survives contact with a stratum it
 * was never fitted to. The threat to that question is not that the analyst lies; it is that
 * re-implementing "the same" derivation in a new file quietly produces a slightly different
 * one, and the replication then measures the reimplementation. So M190 runs M189's own
 * scripts as EXECUTABLES, byte-identical at the blob ids recorded in the held-out manifest,
 * and confines itself to three jobs: driving them, partitioning their output by a manifest
 * frozen before any of this ran, and computing the generalisation gates M189 did not need.
 *
 *   M189-B (run_stage5_m189_mechanism.ts)  derives candidates      — UNMODIFIED, spawned
 *   M189-C (run_stage5_m189_specimens.ts)  classifies specimens    — UNMODIFIED, spawned
 *   M189-D (run_stage5_m189_controls.ts)   compares fingerprints   — UNMODIFIED, spawned
 *
 * THE FILE SWAP, AND WHY IT IS SAFE. M189-C reads one hard-coded path. To apply M189's exact
 * aggregation to a sub-stratum, this script writes that stratum's records to that path, runs
 * M189-C, moves its output aside, and restores the committed M189 artifacts from git. The
 * alternative — copying M189-C's hundred lines of aggregation into this file and editing the
 * input — is the transcription risk the whole design exists to avoid. Restoration is verified
 * against `git status` before the script exits non-zero on any mismatch.
 *
 * WHY M189-B IS RE-RUN OVER EVERYTHING. Once the held-out base trees are indexed, M189-B's own
 * stratum predicate — I5-usable AND indexed — selects all 1,180 arms rather than 866. Running
 * it unchanged is therefore both the replication and a determinism control: the 866 discovery
 * rows it re-derives must come back byte-identical to M189's committed fingerprints, which is
 * checked below as DISCOVERY_STRATUM_REPRODUCED. A held-out result computed by a pipeline that
 * cannot reproduce its own discovery stratum would not be worth reading.
 *
 * PRE-REGISTERED TASK VERDICTS (§17, §24), fixed here before held-out outcomes were opened and
 * expressed entirely in terms of M189-C's frozen `witnessVerdict`, so there is no room to move
 * them after seeing data:
 *
 *   WITNESSED                       EVERY_SUCCESS_EDITED_IT | MIXED
 *   REFUTED                         SUCCESSES_ALSO_SKIPPED_IT
 *   FAILURE_ONLY_NO_SUCCESS_WITNESS NO_SUCCESSFUL_ARM_EXISTS
 *   NO_MECHANISM                    the task produced no I5_EDIT_SET_MISS specimen at all
 *
 * §22 and §33 forbid this milestone from improving anything it measures. No threshold, filter,
 * depth, relevance rule or cap is introduced here, and the false-positive figures are the ones
 * M189-C computes, applied to a different population.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const BENCH = path.join(REPO_ROOT, "benchmarks/stage5_vexp_swe_bench_smoke");
const RESULTS = path.join(BENCH, "results");
const ANALYZE_ONLY = process.argv.includes("--analyze-only");
const BLIND = process.env.M190_BLIND === "1";

// ── M189 artifact paths this script temporarily borrows and then restores ────
const M189_DECISIONS = path.join(RESULTS, "stage5_m189_decision_points.jsonl");
const M189_SKIPPED = path.join(RESULTS, "stage5_m189_skipped.json");
const M189_FP_SIGHTED = path.join(RESULTS, "stage5_m189_candidate_fingerprints.sighted.txt");
const M189_FP_BLIND = path.join(RESULTS, "stage5_m189_candidate_fingerprints.blind.txt");
const M189_SPECIMENS = path.join(RESULTS, "stage5_m189_specimen_ledger.json");
const M189_CONTROLS = path.join(RESULTS, "stage5_m189_controls.json");
const BORROWED = [M189_DECISIONS, M189_SKIPPED, M189_FP_SIGHTED, M189_FP_BLIND, M189_SPECIMENS, M189_CONTROLS];

const rel = (p: string): string => path.relative(REPO_ROOT, p);
const git = (...a: string[]): string => execFileSync("git", a, { cwd: REPO_ROOT, encoding: "utf8" });
const restoreM189 = (): void => { git("checkout", "--", ...BORROWED.map(rel)); };
const run = (script: string, env: Record<string, string> = {}): string =>
  execFileSync("bun", [path.join(BENCH, script)], {
    cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...env },
  });

// ── manifest ────────────────────────────────────────────────────────────────
interface ManifestArm {
  readonly rawDir: string; readonly runLabel: string; readonly instanceId: string;
  readonly repo: string; readonly baseCommit: string; readonly resolved: boolean;
}
const manifest = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m190_heldout_manifest.json"), "utf8")) as {
  manifestHash: string; frozenDerivation: { blobSetHash: string; blobIds: Record<string, string>; m189EvidenceSha: string };
  arms: ManifestArm[];
};
const heldOutRawDirs = new Set(manifest.arms.map((a) => a.rawDir));
const heldOutInstances = new Set(manifest.arms.map((a) => a.instanceId));

/**
 * The freeze is re-verified on every run, not merely recorded once. If any load-bearing M189
 * file has moved since the manifest was written, the thing this script executes is no longer
 * the thing M190 claims to be replicating, and the run must not silently continue (§4).
 */
const freezeIntact = Object.entries(manifest.frozenDerivation.blobIds).every(
  ([f, id]) => git("rev-parse", `HEAD:${f}`).trim() === id,
);
if (!freezeIntact) {
  process.stderr.write("FROZEN DERIVATION HAS MOVED SINCE THE MANIFEST WAS WRITTEN — refusing to run\n");
  process.exit(2);
}

// ── phase 1: run the frozen M189-B over the enlarged indexed set ────────────
const ALL_DECISIONS = path.join(RESULTS, "stage5_m190_all_decision_points.jsonl");
const ALL_SKIPPED = path.join(RESULTS, "stage5_m190_all_skipped.json");
const ALL_FP_SIGHTED = path.join(RESULTS, "stage5_m190_fingerprints.sighted.txt");
const ALL_FP_BLIND = path.join(RESULTS, "stage5_m190_fingerprints.blind.txt");

const phase1Log: string[] = [];
if (!ANALYZE_ONLY) {
  try {
    if (BLIND) {
      phase1Log.push(run("run_stage5_m189_mechanism.ts", { M189_BLIND: "1" }));
      copyFileSync(M189_FP_BLIND, ALL_FP_BLIND);
    } else {
      phase1Log.push(run("run_stage5_m189_mechanism.ts"));
      copyFileSync(M189_DECISIONS, ALL_DECISIONS);
      copyFileSync(M189_SKIPPED, ALL_SKIPPED);
      copyFileSync(M189_FP_SIGHTED, ALL_FP_SIGHTED);
    }
  } finally {
    restoreM189();
  }
}
if (BLIND) {
  // The blind pass produces fingerprints only; §12's comparison is made by the sighted run.
  process.stdout.write(`${phase1Log.join("")}\nM190 blind pass written to ${rel(ALL_FP_BLIND)}\n`);
  process.exit(0);
}

// ── partition ───────────────────────────────────────────────────────────────
interface Score { readonly candidateCount: number; readonly goldHits: readonly string[]; readonly unaddressedGoldHits: readonly string[] }
interface Decision {
  readonly candidateFingerprint: string; readonly kind: string; readonly atIndex: number;
  readonly replaySkipped: number;
  readonly i5Dependents: number; readonly i5DependentsTaskRelevant: number; readonly i5Dependencies: number;
  readonly i5DependentsScore: Score; readonly i5DependenciesScore: Score;
  readonly broadCandidatesLaterInspected: number; readonly broadCandidatesLaterEdited: number;
}
interface Arm {
  readonly runLabel: string; readonly rawDir: string; readonly instanceId: string; readonly repo: string;
  readonly resolved: boolean; readonly usableForI5: boolean; readonly usableForI6: boolean;
  readonly finalPatchFiles: readonly string[]; readonly goldFiles: readonly string[];
  readonly goldFilesMissedByFinalPatch: readonly string[];
  readonly missedGoldReachability: readonly { file: string; reachable: boolean; depth: number | null; alreadyInspected: boolean }[];
  readonly novelFilesAfterFirstEdit: readonly string[];
  readonly decisions: readonly Decision[];
}
const allArms: Arm[] = readFileSync(ALL_DECISIONS, "utf8").split("\n").filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Arm);

const heldOut = allArms.filter((a) => heldOutRawDirs.has(a.rawDir));
const discovery = allArms.filter((a) => !heldOutRawDirs.has(a.rawDir));

/**
 * Instance-disjointness is a precondition of the whole design, not a happy accident, and it is
 * asserted rather than assumed. M189-B indexes per INSTANCE, so an instance is either wholly
 * inside the discovery stratum or wholly outside it — which is what lets §17's success-witness
 * search run inside the held-out stratum without reaching back into arms M189 already saw.
 */
const leakedInstances = discovery.filter((a) => heldOutInstances.has(a.instanceId)).map((a) => a.instanceId);

// ── run the frozen M189-C over each stratum ─────────────────────────────────
function specimensFor(rows: readonly Arm[], tag: string): Record<string, unknown> {
  const out = path.join(RESULTS, `stage5_m190_specimens.${tag}.json`);
  try {
    writeFileSync(M189_DECISIONS, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
    run("run_stage5_m189_specimens.ts");
    copyFileSync(M189_SPECIMENS, out);
  } finally {
    restoreM189();
  }
  return JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
}
const heldOutSpec = specimensFor(heldOut, "heldout");
const pooledSpec = specimensFor(allArms, "pooled");

// ── run the frozen M189-D over the held-out fingerprints ────────────────────
const fpLines = (p: string): readonly string[] => readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
const heldOutFp = (p: string): readonly string[] => fpLines(p).filter((l) => heldOutRawDirs.has(l.split("\t")[0]!));

let blindControl: Record<string, unknown> = { ran: false, note: "run M190_BLIND=1 first" };
let discoveryReproduced: Record<string, unknown> = {};
if (existsSync(ALL_FP_BLIND)) {
  try {
    writeFileSync(M189_FP_SIGHTED, `${heldOutFp(ALL_FP_SIGHTED).join("\n")}\n`);
    writeFileSync(M189_FP_BLIND, `${heldOutFp(ALL_FP_BLIND).join("\n")}\n`);
    copyFileSync(path.join(RESULTS, "stage5_m190_specimens.heldout.json"), M189_SPECIMENS);
    run("run_stage5_m189_controls.ts");
    copyFileSync(M189_CONTROLS, path.join(RESULTS, "stage5_m190_controls.heldout.json"));
  } finally {
    restoreM189();
  }
  blindControl = (JSON.parse(readFileSync(path.join(RESULTS, "stage5_m190_controls.heldout.json"), "utf8")) as
    { blindnessControl: Record<string, unknown> }).blindnessControl;
}

// Determinism control: the 866 discovery rows this pipeline re-derived must be byte-identical
// to M189's committed fingerprints. Nothing held-out is readable as evidence otherwise.
{
  const committed = fpLines(M189_FP_SIGHTED);
  const rederived = fpLines(ALL_FP_SIGHTED).filter((l) => !heldOutRawDirs.has(l.split("\t")[0]!));
  const h = (xs: readonly string[]): string => createHash("sha256").update(`${xs.join("\n")}\n`).digest("hex");
  discoveryReproduced = {
    committedDecisionPoints: committed.length,
    rederivedDecisionPoints: rederived.length,
    committedHash: h(committed),
    rederivedHash: h(rederived),
    verdict: h(committed) === h(rederived) ? "DISCOVERY_STRATUM_REPRODUCED" : "DISCOVERY_STRATUM_DIVERGED",
  };
}

// ── M190-specific endpoints ─────────────────────────────────────────────────
const dps = (rows: readonly Arm[]): readonly Decision[] => rows.flatMap((a) => a.decisions);
const uniq = <T,>(xs: readonly T[]): T[] => [...new Set(xs)];
const quant = (xs: readonly number[]): Record<string, number> => {
  if (xs.length === 0) return { n: 0, median: 0, p90: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
  return { n: s.length, median: at(0.5), p90: at(0.9), max: s[s.length - 1]! };
};
const buckets = (xs: readonly number[]): Record<string, number> => ({
  zero: xs.filter((v) => v === 0).length,
  one: xs.filter((v) => v === 1).length,
  twoToThree: xs.filter((v) => v >= 2 && v <= 3).length,
  moreThanThree: xs.filter((v) => v > 3).length,
});

const hoFailures = heldOut.filter((a) => !a.resolved);
const hoSuccesses = heldOut.filter((a) => a.resolved);
const hoDps = dps(heldOut);

/** §16A — candidate generation, per decision point, before any analyst filtering. */
const candidateGeneration = {
  heldOutDecisionPoints: hoDps.length,
  DEPENDENCIES: { ...buckets(hoDps.map((d) => d.i5Dependencies)), ...quant(hoDps.map((d) => d.i5Dependencies)) },
  DEPENDENTS: { ...buckets(hoDps.map((d) => d.i5Dependents)), ...quant(hoDps.map((d) => d.i5Dependents)) },
  DEPENDENTS_TASK_RELEVANT: { ...buckets(hoDps.map((d) => d.i5DependentsTaskRelevant)), ...quant(hoDps.map((d) => d.i5DependentsTaskRelevant)) },
};

/** §16B — decision points where the frozen derivation named a reference file the arm never fixed. */
const namedUnaddressed = (d: Decision): boolean =>
  d.i5DependentsScore.unaddressedGoldHits.length > 0 || d.i5DependenciesScore.unaddressedGoldHits.length > 0;
const missRateArms = heldOut.filter((a) => a.decisions.some(namedUnaddressed));
const referenceRelevantMiss = {
  decisionPoints: hoDps.filter(namedUnaddressed).length,
  ofDecisionPoints: hoDps.length,
  arms: missRateArms.length,
  failingArms: missRateArms.filter((a) => !a.resolved).length,
  tasks: uniq(missRateArms.map((a) => a.instanceId)).sort(),
  repositories: uniq(missRateArms.map((a) => a.repo)).sort(),
};

/** §17/§24 — the pre-registered task-level verdict, read off M189-C's frozen witnessVerdict. */
interface Witness {
  instanceId: string; repo: string; failingArms: number; fileTheFailuresMissed: string[];
  successfulArmsOfSameTask: number; successfulArmsThatEditedIt: number;
  successfulArmsThatResolvedWITHOUTEditingIt: number; witnessVerdict: string;
}
const VERDICT_MAP: Record<string, string> = {
  EVERY_SUCCESS_EDITED_IT: "WITNESSED",
  MIXED: "WITNESSED",
  SUCCESSES_ALSO_SKIPPED_IT: "REFUTED",
  NO_SUCCESSFUL_ARM_EXISTS: "FAILURE_ONLY_NO_SUCCESS_WITNESS",
};
const hoWitness = (heldOutSpec.mechanismSuccessWitness ?? []) as Witness[];
const taskVerdicts = hoWitness.map((w) => {
  const armsOfTask = heldOut.filter((a) => a.instanceId === w.instanceId);
  return {
    instanceId: w.instanceId, repo: w.repo,
    heldOutArms: armsOfTask.length,
    failingArms: armsOfTask.filter((a) => !a.resolved).length,
    successfulArms: armsOfTask.filter((a) => a.resolved).length,
    specimenFailingArms: w.failingArms,
    fileTheFailuresMissed: w.fileTheFailuresMissed,
    successfulArmsThatEditedIt: w.successfulArmsThatEditedIt,
    successfulArmsThatResolvedWithoutIt: w.successfulArmsThatResolvedWITHOUTEditingIt,
    frozenWitnessVerdict: w.witnessVerdict,
    taskVerdict: VERDICT_MAP[w.witnessVerdict] ?? "AMBIGUOUS",
  };
});
const witnessedTasks = taskVerdicts.filter((t) => t.taskVerdict === "WITNESSED");
const refutedTasks = taskVerdicts.filter((t) => t.taskVerdict === "REFUTED");
const failureOnlyTasks = taskVerdicts.filter((t) => t.taskVerdict === "FAILURE_ONLY_NO_SUCCESS_WITNESS");

/** §19/§20 — the generalisation gates. "Unwitnessed" is about M189's WITNESSES, not its corpus. */
const M189_WITNESSED_TASKS = ["sphinx-doc__sphinx-7462", "pydata__xarray-6938"];
const M189_WITNESSED_REPOS = ["sphinx-doc/sphinx", "pydata/xarray"];
const generalisation = {
  m189WitnessedTasks: M189_WITNESSED_TASKS,
  m189WitnessedRepositories: M189_WITNESSED_REPOS,
  heldOutWitnessedTasks: witnessedTasks.map((t) => t.instanceId).sort(),
  heldOutWitnessedRepositories: uniq(witnessedTasks.map((t) => t.repo)).sort(),
  newWitnessedTasks: witnessedTasks.filter((t) => !M189_WITNESSED_TASKS.includes(t.instanceId)).map((t) => t.instanceId).sort(),
  repeatedWitnessedTasks: witnessedTasks.filter((t) => M189_WITNESSED_TASKS.includes(t.instanceId)).map((t) => t.instanceId).sort(),
  newWitnessedRepositories: uniq(witnessedTasks.map((t) => t.repo)).filter((r) => !M189_WITNESSED_REPOS.includes(r)).sort(),
  repeatedWitnessedRepositories: uniq(witnessedTasks.map((t) => t.repo)).filter((r) => M189_WITNESSED_REPOS.includes(r)).sort(),
  repositoryGateRule: "§19 — at least one independent witnessed task in a repository M189 never witnessed",
  repositoryGate: "",
  taskGateRule: "§20 — at least one NEW witnessed task, not merely more arms of an existing one",
  taskGate: "",
};
generalisation.repositoryGate =
  generalisation.newWitnessedRepositories.length > 0 ? "CROSS_REPOSITORY_REPLICATION_GAINED" : "CROSS_REPOSITORY_REPLICATION_FAILS";
generalisation.taskGate =
  generalisation.newWitnessedTasks.length > 0 ? "NEW_WITNESSED_TASKS" : "NO_NEW_WITNESSED_TASKS";

/**
 * §23 — enrichment at TASK level. §13 and §24 forbid treating 18 stochastic arms of one task
 * as 18 independent observations, and this corpus would reward that error handsomely: the
 * held-out stratum's arms-per-task ranges from 1 to 18. A task is the unit.
 */
const cleanSuccessArm = (a: Arm): boolean => a.resolved && a.goldFilesMissedByFinalPatch.length === 0;
const firesOn = (a: Arm): boolean => a.decisions.some((d) => d.i5Dependencies > 0);
const failingTasks = uniq(hoFailures.map((a) => a.instanceId));
const cleanSuccessTasks = uniq(heldOut.filter(cleanSuccessArm).map((a) => a.instanceId));
const failingTasksWithSignal = failingTasks.filter((t) => witnessedTasks.some((w) => w.instanceId === t));
const cleanSuccessTasksWithSignal = cleanSuccessTasks.filter((t) =>
  heldOut.some((a) => a.instanceId === t && cleanSuccessArm(a) && firesOn(a)));
const pFail = failingTasks.length === 0 ? 0 : failingTasksWithSignal.length / failingTasks.length;
const pClean = cleanSuccessTasks.length === 0 ? 0 : cleanSuccessTasksWithSignal.length / cleanSuccessTasks.length;
const enrichment = {
  unit: "TASK — repeated stochastic arms of one task are one observation (§13, §24)",
  failingTasks: failingTasks.length,
  failingTasksWithWitnessedI5Signal: failingTasksWithSignal.length,
  fractionFailingTasksWitnessed: Number(pFail.toFixed(4)),
  cleanSuccessTasks: cleanSuccessTasks.length,
  cleanSuccessTasksWithUnnecessarySignal: cleanSuccessTasksWithSignal.length,
  fractionCleanSuccessTasksFiring: Number(pClean.toFixed(4)),
  difference: Number((pFail - pClean).toFixed(4)),
  riskRatio: pClean === 0 ? null : Number((pFail / pClean).toFixed(3)),
  assumptions:
    "raw counts only; no inferential test is reported because the two task sets overlap (a task can " +
    "contribute both failing and clean-success arms) and the arms within a task are not independent",
};

/** §25 — the counterexample audit, stated as counts a reviewer can chase to specific arms. */
const specimenRows = (heldOutSpec.specimens ?? []) as { runLabel: string; instanceId: string; repo: string; i5Mechanism: string }[];
const counterexamples = {
  successfulArmsWhereDerivationFiredAndTheyResolvedAnyway: hoSuccesses.filter(firesOn).length,
  ofSuccessfulArms: hoSuccesses.length,
  successfulArmsThatLaterOpenedANamedFile: hoSuccesses.filter((a) => a.decisions.some((d) => d.broadCandidatesLaterInspected > 0)).length,
  successfulArmsThatLaterEditedANamedFile: hoSuccesses.filter((a) => a.decisions.some((d) => d.broadCandidatesLaterEdited > 0)).length,
  refutedTasks: refutedTasks.map((t) => ({ instanceId: t.instanceId, repo: t.repo, successesWithoutIt: t.successfulArmsThatResolvedWithoutIt })),
  failingArmsThatEditedEveryReferenceFileAndStillFailed:
    specimenRows.filter((s) => s.i5Mechanism === "MODEL_REASONING_FAILURE_WITH_EVIDENCE_VISIBLE").length,
  failingArmsWhereEveryMissedReferenceFileWasAlreadyOpen:
    hoFailures.filter((a) => a.missedGoldReachability.length > 0 && a.missedGoldReachability.every((m) => m.alreadyInspected)).length,
  failingArmsWithNoRepositoryDerivableObligation:
    specimenRows.filter((s) => s.i5Mechanism === "I5_NO_REPOSITORY_DERIVABLE_OBLIGATION").length,
  failingArmsWhereTheMissedFileWasReachableButNeverNamed:
    specimenRows.filter((s) => s.i5Mechanism === "I5_REACHABLE_BUT_NOT_NAMED_BY_DERIVATION").length,
};

/**
 * Did the derivation FIRE and miss, or did it fall silent? A replication that reports "zero
 * specimens" without separating those two is unreadable: an arm that emits nothing has not
 * been tested, while an arm that emits a bounded candidate set which simply never names the
 * file the agent needed has been tested and has failed. This is computed on both strata with
 * the same expressions so the comparison is like for like.
 */
const armDiagnostics = (rows: readonly Arm[]): Record<string, number> => {
  const f = rows.filter((a) => !a.resolved);
  return {
    failingArms: f.length,
    failingTasks: uniq(f.map((a) => a.instanceId)).length,
    failingArmsWhereDEPENDENCIESEmittedAnything: f.filter((a) => a.decisions.some((d) => d.i5Dependencies > 0)).length,
    failingArmsWhereDEPENDENTSEmittedAnything: f.filter((a) => a.decisions.some((d) => d.i5Dependents > 0)).length,
    failingArmsWhereDEPENDENCIESNamedAnUnaddressedReferenceFile:
      f.filter((a) => a.decisions.some((d) => d.i5DependenciesScore.unaddressedGoldHits.length > 0)).length,
    failingArmsWhereDEPENDENTSNamedAnUnaddressedReferenceFile:
      f.filter((a) => a.decisions.some((d) => d.i5DependentsScore.unaddressedGoldHits.length > 0)).length,
    decisionPoints: dps(f).length,
    decisionPointsWhereDEPENDENCIESNamedAnUnaddressedReferenceFile:
      dps(f).filter((d) => d.i5DependenciesScore.unaddressedGoldHits.length > 0).length,
  };
};
const derivationArmDiagnostics = {
  note:
    "DEPENDENCIES is the arm that produced every M189 specimen; DEPENDENTS is the preregistered " +
    "arm that produced none. Both are reported so that silence on gold can be told apart from silence.",
  discovery: armDiagnostics(discovery),
  heldOut: armDiagnostics(heldOut),
};

/**
 * §16C asks for a success witness on every held-out task producing a serious I5 specimen. The
 * primary class produced none, so the question is asked of the OTHER frozen I5 specimen class
 * present in the held-out data — `I5_AFFECTED_CONSUMER_MISS`, the PREREGISTERED consumer arm.
 * This is a reporting extension, not a derivation change: the witness rule, the specimen class
 * and the candidate sets are all M189's, and the result can only weaken the I5 case or leave it
 * unchanged. It is reported as supplementary and never as the replication of M189's mechanism,
 * which was `I5_EDIT_SET_MISS`.
 *
 * Success availability is checked against the WHOLE 1,293-arm corpus, not the analysed set: a
 * task whose successful arms were merely I5-unusable would be a corpus limitation, whereas a
 * task with no successful arm anywhere is a fact about the task.
 */
interface CorpusRow { instanceId: string; resolved: boolean; usableForI5: boolean }
const corpusRows: CorpusRow[] = readFileSync(path.join(RESULTS, "stage5_m189_corpus_ledger.jsonl"), "utf8")
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as CorpusRow);

const consumerSpecimenTasks = uniq(specimenRows.filter((s) => s.i5Mechanism === "I5_AFFECTED_CONSUMER_MISS").map((s) => s.instanceId)).sort();
const supplementaryWitness = {
  class: "I5_AFFECTED_CONSUMER_MISS — the PREREGISTERED consumer arm, not the class M189 witnessed",
  status: "SUPPLEMENTARY — does not contribute to the M190 replication verdict",
  tasks: consumerSpecimenTasks.map((instanceId) => {
    const failing = heldOut.filter((a) => a.instanceId === instanceId && !a.resolved);
    const missed = uniq(failing.flatMap((a) => a.goldFilesMissedByFinalPatch)).sort();
    const named = uniq(failing.flatMap((a) => a.decisions.flatMap((d) => d.i5DependentsScore.unaddressedGoldHits))).sort();
    const corpusArms = corpusRows.filter((r) => r.instanceId === instanceId);
    const succ = heldOut.filter((a) => a.instanceId === instanceId && a.resolved);
    const edited = succ.filter((a) => named.some((f) => a.finalPatchFiles.includes(f)));
    return {
      instanceId,
      repo: heldOut.find((a) => a.instanceId === instanceId)!.repo,
      failingArms: failing.length,
      referenceFilesMissed: missed.length,
      referenceFilesNamedByTheDerivation: named,
      successfulArmsInTheHeldOutSet: succ.length,
      successfulArmsAnywhereInTheCorpus: corpusArms.filter((r) => r.resolved).length,
      corpusArmsForThisTask: corpusArms.length,
      successfulArmsThatEditedANamedFile: edited.length,
      witnessVerdict: succ.length === 0 ? "NO_SUCCESSFUL_ARM_EXISTS" : edited.length === 0 ? "SUCCESSES_ALSO_SKIPPED_IT" : "MIXED",
      taskVerdict: succ.length === 0 ? "FAILURE_ONLY_NO_SUCCESS_WITNESS" : edited.length === 0 ? "REFUTED" : "WITNESSED",
    };
  }),
};

/**
 * §23's transparent quantity for an ABSENCE. The held-out set produced no specimen of the
 * replicated class; the question a reader will ask is whether it was simply too small to. The
 * answer is given as raw counts plus the crudest possible model — if held-out tasks were draws
 * from the discovery specimen rate, how often would zero come back — with its unit and its
 * assumption stated, because the assumption (independence across tasks) is generous to the
 * hypothesis M190 is testing rather than to M190's conclusion.
 */
const m189SpecimenTasks = 4;
const m189AnalysedTasks = uniq(discovery.map((a) => a.instanceId)).length;
const m189SpecimenArms = 62;
const m189FailingArms = discovery.filter((a) => !a.resolved).length;
const absenceCheck = {
  unit: "TASK (primary) and failing ARM (secondary, not independent — reported for completeness only)",
  m189SpecimenTasksOverAnalysedTasks: `${m189SpecimenTasks}/${m189AnalysedTasks}`,
  m189TaskRate: Number((m189SpecimenTasks / m189AnalysedTasks).toFixed(4)),
  heldOutTasks: uniq(heldOut.map((a) => a.instanceId)).length,
  heldOutSpecimenTasks: 0,
  probabilityOfZeroHeldOutSpecimenTasksAtTheDiscoveryRate:
    Number(((1 - m189SpecimenTasks / m189AnalysedTasks) ** uniq(heldOut.map((a) => a.instanceId)).length).toFixed(4)),
  m189SpecimenArmsOverFailingArms: `${m189SpecimenArms}/${m189FailingArms}`,
  heldOutFailingArms: hoFailures.length,
  probabilityOfZeroHeldOutSpecimenArmsAtTheDiscoveryRate:
    Number(((1 - m189SpecimenArms / m189FailingArms) ** hoFailures.length).toExponential(3)),
  assumption:
    "tasks treated as independent Bernoulli draws at the discovery rate. Arms are NOT independent " +
    "(59 of M189's 62 specimen arms are one task), so the arm-level figure is reported as an upper " +
    "bound on surprise and the task-level figure is the one to read.",
};

/** §21 — false-positive pressure, computed by M189-C's frozen rule on the two strata. */
const m189Committed = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m189_specimen_ledger.json"), "utf8")) as
  { falsePositive: Record<string, unknown>; mechanismTable: unknown[] };
const falsePositive = {
  definition: "M189-C frozen rule — a CLEAN SUCCESS is a resolved arm whose final patch already covered every reference file",
  m189Discovery: m189Committed.falsePositive,
  m190HeldOut: heldOutSpec.falsePositive,
};

const report = {
  schemaVersion: "stage5.m190.replication.v1",
  milestone: "M190",
  frozenDerivation: manifest.frozenDerivation,
  manifestHash: manifest.manifestHash,
  strata: {
    allAnalysedArms: allArms.length,
    heldOutArms: heldOut.length,
    heldOutTasks: uniq(heldOut.map((a) => a.instanceId)).length,
    heldOutRepositories: uniq(heldOut.map((a) => a.repo)).sort(),
    heldOutFailures: hoFailures.length,
    heldOutSuccesses: hoSuccesses.length,
    discoveryArms: discovery.length,
    manifestArmsNotAnalysed: manifest.arms.filter((m) => !heldOut.some((a) => a.rawDir === m.rawDir)).map((m) => m.rawDir),
    instanceLeakBetweenStrata: leakedInstances,
  },
  replayIntegrity: {
    heldOutDecisionPoints: hoDps.length,
    decisionPointsWithAnUnfaithfulPartialReplay: hoDps.filter((d) => d.replaySkipped > 0).length,
    faithfulReplays: hoDps.filter((d) => d.replaySkipped === 0).length,
  },
  discoveryReproduced,
  blindControl,
  candidateGeneration,
  referenceRelevantMiss,
  heldOutMechanismTable: heldOutSpec.mechanismTable,
  taskVerdicts,
  witnessSummary: {
    witnessedTasks: witnessedTasks.map((t) => t.instanceId),
    witnessedRepositories: uniq(witnessedTasks.map((t) => t.repo)).sort(),
    refutedTasks: refutedTasks.map((t) => t.instanceId),
    failureOnlyTasks: failureOnlyTasks.map((t) => t.instanceId),
  },
  generalisation,
  enrichment,
  counterexamples,
  derivationArmDiagnostics,
  supplementaryWitness,
  absenceCheck,
  falsePositive,
  pooled: {
    label: "SECONDARY — M189 discovery stratum + M190 held-out stratum, reported only after the held-out result was frozen (§18)",
    mechanismTable: pooledSpec.mechanismTable,
    fullThreshold: pooledSpec.fullThreshold,
    mechanismSuccessWitness: pooledSpec.mechanismSuccessWitness,
    falsePositive: pooledSpec.falsePositive,
  },
};

writeFileSync(path.join(RESULTS, "stage5_m190_replication.json"), `${JSON.stringify(report, null, 2)}\n`);

// ── restoration check ───────────────────────────────────────────────────────
const dirty = git("status", "--short", "--", ...BORROWED.map(rel)).trim();
if (dirty !== "") {
  process.stderr.write(`M189 ARTIFACTS NOT RESTORED:\n${dirty}\n`);
  process.exit(3);
}

process.stdout.write([
  phase1Log.join(""),
  "M190 replication",
  `  frozen blobset            ${manifest.frozenDerivation.blobSetHash}`,
  `  manifest hash             ${manifest.manifestHash}`,
  `  arms analysed (all)       ${allArms.length}`,
  `  HELD OUT arms/tasks/repos ${heldOut.length} / ${uniq(heldOut.map((a) => a.instanceId)).length} / ${uniq(heldOut.map((a) => a.repo)).length}`,
  `    manifest arms unanalysed ${report.strata.manifestArmsNotAnalysed.length}`,
  `    instance leak            ${leakedInstances.length}`,
  `  discovery reproduction    ${(discoveryReproduced as { verdict: string }).verdict}`,
  `  blind control             ${(blindControl as { verdict?: string }).verdict ?? "NOT_RUN"} (${(blindControl as { comparedDecisionPoints?: number }).comparedDecisionPoints ?? 0} compared, ${(blindControl as { differingFingerprints?: number }).differingFingerprints ?? "-"} differ)`,
  `  held-out decision points  ${hoDps.length}  faithful ${report.replayIntegrity.faithfulReplays}  unfaithful ${report.replayIntegrity.decisionPointsWithAnUnfaithfulPartialReplay}`,
  `  DEPENDENCIES per DP       median ${candidateGeneration.DEPENDENCIES.median}  p90 ${candidateGeneration.DEPENDENCIES.p90}  max ${candidateGeneration.DEPENDENCIES.max}`,
  `  reference-relevant miss   ${referenceRelevantMiss.decisionPoints}/${hoDps.length} DPs, ${referenceRelevantMiss.arms} arms, ${referenceRelevantMiss.tasks.length} tasks, ${referenceRelevantMiss.repositories.length} repos`,
  ...taskVerdicts.map((t) => `  task ${t.instanceId.padEnd(30)} ${t.taskVerdict.padEnd(32)} missed=${t.fileTheFailuresMissed.join(",")} succ=${t.successfulArms} editedIt=${t.successfulArmsThatEditedIt} withoutIt=${t.successfulArmsThatResolvedWithoutIt}`),
  `  §19 repository gate       ${generalisation.repositoryGate}  new repos: ${generalisation.newWitnessedRepositories.join(", ") || "none"}`,
  `  §20 task gate             ${generalisation.taskGate}  new tasks: ${generalisation.newWitnessedTasks.join(", ") || "none"}`,
  `  DEPENDENCIES fires on      ${derivationArmDiagnostics.heldOut.failingArmsWhereDEPENDENCIESEmittedAnything}/${derivationArmDiagnostics.heldOut.failingArms} held-out failing arms; names an unaddressed reference file on ${derivationArmDiagnostics.heldOut.failingArmsWhereDEPENDENCIESNamedAnUnaddressedReferenceFile}`,
  `  absence check (task)      P(0 specimen tasks in ${absenceCheck.heldOutTasks} at the discovery rate ${absenceCheck.m189TaskRate}) = ${absenceCheck.probabilityOfZeroHeldOutSpecimenTasksAtTheDiscoveryRate}`,
  ...supplementaryWitness.tasks.map((t) => `  supp ${t.instanceId.padEnd(30)} ${t.taskVerdict.padEnd(32)} named=${t.referenceFilesNamedByTheDerivation.length}/${t.referenceFilesMissed} missed, successes anywhere in corpus=${t.successfulArmsAnywhereInTheCorpus}`),
  `  enrichment (task level)   failing ${enrichment.failingTasksWithWitnessedI5Signal}/${enrichment.failingTasks} = ${enrichment.fractionFailingTasksWitnessed}   clean-success ${enrichment.cleanSuccessTasksWithUnnecessarySignal}/${enrichment.cleanSuccessTasks} = ${enrichment.fractionCleanSuccessTasksFiring}   RR ${enrichment.riskRatio ?? "n/a"}`,
  "",
].join("\n"));
