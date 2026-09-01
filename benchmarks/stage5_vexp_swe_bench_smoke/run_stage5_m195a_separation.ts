/**
 * M195A - the separation driver.
 *
 * Verifies that the frozen M195 audit still reproduces byte-for-byte, then
 * reclassifies its committed rows under the M195A taxonomy. Nothing here
 * derives, ranks or re-scores a candidate: every candidate fact is read back
 * from M195's own artefacts, and the only new evidence is an additive probe
 * over the raw M194 events for the two clauses §5 needs and M195 did not
 * publish per-row - whether a credit-window attempt is trustworthy, and whether
 * its runner outcome is observable at all.
 *
 * That probe is not trusted on its own. It must reproduce M195's published
 * `attemptsInCreditWindow` for all 59 decision points and its published
 * unpaired-`bash_pre` totals exactly, or the driver fails closed.
 *
 *   bun run_stage5_m195a_separation.ts --m194 <root> --facts <dir> \
 *     --dataset <jsonl> --results <results dir> --out <results dir>
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ChangedFileFreshness,
  type StreamCapture,
  classifySourceVersion,
  classifyValidationProvenance,
  provenanceIsUsable,
  runnerStarted,
  sourceVersionIsUsable,
} from "./m193Acquisition";
import { isValidationAttempt, streamCapture } from "./m194Lifecycle";
import type { DecisionClass, Relation } from "./m195Evaluation";
import {
  type MissPartition,
  type SelectivityStats,
  type SeparationClass,
  M195A_SCHEMA_VERSION,
  SEPARATION_IDS,
  classifySeparation,
  classifyWitness,
  creditWindowEdgeCase,
  deadGateControl,
  evaluateSelectionGate,
  g2CanFail,
  isGenuineSelectionMiss,
  isM195Miss,
  partitionMiss,
  scaffoldVerdict,
  selectionVerdict,
  selectivityStats,
  selectivityVerdict,
} from "./m195aSeparation";

const argv = process.argv.slice(2);
const arg = (k: string, d = ""): string => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : d;
};
const m194Root = resolve(arg("--m194"));
const factsDir = resolve(arg("--facts"));
const datasetPath = resolve(arg("--dataset"));
const resultsDir = resolve(arg("--results"));
const outDir = resolve(arg("--out", resultsDir));
const CHECKOUT_ROOT = "/testbed";

const fail = (msg: string): never => {
  console.error(`M195A HALT: ${msg}`);
  process.exit(1);
};

// ── §1 authority: the frozen driver must still reproduce byte-for-byte ──

const M195_ARTEFACTS = [
  "stage5_m195_audit.json",
  "stage5_m195_candidates.jsonl",
  "stage5_m195_decision_points.jsonl",
] as const;

const replayDir = mkdtempSync(join(tmpdir(), "m195a-replay-"));
const replay = spawnSync(
  "bun",
  [join(import.meta.dir, "run_stage5_m195_audit.ts"), "--m194", m194Root, "--facts", factsDir,
    "--dataset", datasetPath, "--out", replayDir],
  { encoding: "utf8" },
);
if (replay.status !== 0) fail(`frozen M195 driver did not run: ${replay.stderr?.slice(0, 400)}`);

const authority = M195_ARTEFACTS.map((f) => {
  const committed = readFileSync(join(resultsDir, f));
  const reproduced = readFileSync(join(replayDir, f));
  return { artefact: f, bytes: committed.length, identical: committed.equals(reproduced) };
});
rmSync(replayDir, { recursive: true, force: true });
if (!authority.every((a) => a.identical)) fail("M195 artefacts did not reproduce byte-for-byte");

// ── the committed M195 rows ─────────────────────────────────────────

interface CandidateRow {
  decisionPointId: string;
  family: string;
  preCapCount: number;
  relation: Relation;
  decisionClass: DecisionClass;
  anyRelevant: boolean;
  relevantCandidates: string[];
  candidates: Array<{ path: string; node: string | null; rank: number; rule: string }>;
}
interface DecisionPointRow {
  decisionPointId: string;
  armId: string;
  instanceId: string;
  repo: string;
  sequence: number;
  kind: string;
  diffHash: string;
  attemptsInCreditWindow: number;
  candidateSetHash: string;
  blindCandidateSetHash: string;
}

const jsonl = <T>(p: string): T[] =>
  readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);

const candidateRows = jsonl<CandidateRow>(join(resultsDir, "stage5_m195_candidates.jsonl"));
const dpRows = jsonl<DecisionPointRow>(join(resultsDir, "stage5_m195_decision_points.jsonl"));
const audit = JSON.parse(readFileSync(join(resultsDir, "stage5_m195_audit.json"), "utf8"));

const dpById = new Map(dpRows.map((d) => [d.decisionPointId, d]));
const resolvedByArm = new Map<string, boolean | null>(
  audit.armLedger.map((a: { armId: string; resolved: boolean | null }) => [a.armId, a.resolved]),
);
const FAMILY_KEYS = ["I6-A", "I6-B", "I6-C", "I6-D", "I6-UNION"] as const;
type FamilyKey = (typeof FAMILY_KEYS)[number];

// ── the additive raw probe (§5 clauses 3 and 6) ─────────────────────

interface ProbeAttempt {
  sequence: number;
  command: string;
  completed: boolean;
  started: boolean;
  trustworthy: boolean;
}
interface ProbeArm {
  armId: string;
  edits: Array<{ sequence: number; diffHash: string }>;
  attempts: ProbeAttempt[];
  unpaired: number;
}

interface RawEvent {
  kind: string;
  sequence?: number;
  boundary?: string;
  diffHash?: string | null;
  patchPath?: string;
  toolUseId?: string;
  originalCommand?: string;
  stdout?: string;
  stderr?: string;
  moduleFile?: string | null;
  stateHashBefore?: string | null;
  stateHashAfter?: string | null;
  probe?: Record<string, unknown>;
}

/**
 * Restates only the parts of M195's `loadArm` that the two evidence clauses
 * need, using the same frozen M193/M194 helpers. Every quantity it produces is
 * cross-checked against a published M195 number below before it is used.
 */
function probeArm(dir: string): ProbeArm | null {
  const armPath = join(dir, "arm.json");
  if (!existsSync(armPath)) return null;
  const arm = JSON.parse(readFileSync(armPath, "utf8"));
  if (!arm.modelLaunched) return null;
  const events: RawEvent[] = readFileSync(join(dir, "raw/adapter_events.jsonl"), "utf8")
    .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const robustness = (arm.phases?.provenanceRobustness?.robustness ?? "UNKNOWN") as
    "EDITABLE_INSTALL" | "CWD_DEPENDENT" | "UNKNOWN";

  const edits = events
    .filter((e) => e.kind === "patch_snapshot" && e.boundary === "AFTER_EDIT" && e.patchPath)
    .map((e) => ({ sequence: e.sequence ?? 0, diffHash: e.diffHash ?? "" }));

  const byTool = new Map<string, RawEvent[]>();
  for (const e of events) {
    if (!e.toolUseId) continue;
    byTool.set(e.toolUseId, [...(byTool.get(e.toolUseId) ?? []), e]);
  }

  const attempts: ProbeAttempt[] = [];
  let unpaired = 0;
  for (const group of byTool.values()) {
    const pre = group.find((e) => e.kind === "bash_pre");
    const post = group.find((e) => e.kind === "bash_post");
    const prov = group.find((e) => e.kind === "validation_provenance");
    if (!pre) continue;
    if (!post) unpaired += 1;
    const streams: StreamCapture = streamCapture(post?.stdout, post?.stderr);
    const command = pre.originalCommand ?? "";
    if (!isValidationAttempt(command, streams)) continue;
    const started = post ? runnerStarted(streams) : false;
    const probe = (prov?.probe ?? {}) as Record<string, unknown>;
    const p = classifyValidationProvenance({
      isValidationAttempt: true,
      runnerStarted: started,
      workdir: CHECKOUT_ROOT,
      checkoutRoot: CHECKOUT_ROOT,
      moduleFile: (prov?.moduleFile as string | null) ?? null,
      robustness,
    });
    const sv = classifySourceVersion({
      isValidationAttempt: true,
      runnerStarted: started,
      probeRan: Boolean(probe.probeRan),
      stateStableAcrossValidation:
        prov?.stateHashBefore != null && prov.stateHashBefore === prov.stateHashAfter,
      changedSourceFileCount: (probe.requestedPaths as unknown[] | undefined)?.length ?? 0,
      fileVerdicts: ((probe.files as Record<string, unknown>[] | undefined) ?? []).map(
        (f) => (f.verdict as ChangedFileFreshness) ?? "INDETERMINATE",
      ),
    });
    attempts.push({
      sequence: post?.sequence ?? pre.sequence ?? 0,
      command,
      completed: Boolean(post),
      started,
      trustworthy: provenanceIsUsable(p) && sourceVersionIsUsable(sv),
    });
  }
  return { armId: String(arm.armId ?? ""), edits, attempts, unpaired };
}

const runsDir = join(m194Root, "runs");
const probes = new Map<string, ProbeArm>();
let unpairedTotal = 0;
let unpairedArms = 0;
for (const d of readdirSync(runsDir).sort()) {
  const pr = probeArm(join(runsDir, d));
  if (!pr) continue;
  probes.set(d, pr);
  unpairedTotal += pr.unpaired;
  if (pr.unpaired > 0) unpairedArms += 1;
}

// ── probe validation: it must agree with M195 before it is used ─────

interface WindowFacts {
  attempts: number;
  trustworthy: boolean;
  anyUnpaired: boolean;
  anyStarted: boolean;
}
const windowByDp = new Map<string, WindowFacts>();
const attemptMismatches: Array<{ decisionPointId: string; published: number; probed: number }> = [];
for (const dp of dpRows) {
  const pr = probes.get(dp.armId);
  if (!pr) fail(`no probe for arm ${dp.armId}`);
  const arm = pr as ProbeArm;
  const end = arm.edits.find((e) => e.sequence > dp.sequence && e.diffHash !== dp.diffHash)?.sequence
    ?? Number.POSITIVE_INFINITY;
  const inWindow = arm.attempts.filter((a) => a.sequence > dp.sequence && a.sequence < end);
  windowByDp.set(dp.decisionPointId, {
    attempts: inWindow.length,
    trustworthy: inWindow.some((a) => a.trustworthy),
    anyUnpaired: inWindow.some((a) => !a.completed),
    anyStarted: inWindow.some((a) => a.started),
  });
  if (inWindow.length !== dp.attemptsInCreditWindow) {
    attemptMismatches.push({ decisionPointId: dp.decisionPointId,
      published: dp.attemptsInCreditWindow, probed: inWindow.length });
  }
}
const probeControl = {
  attemptsInCreditWindowReproduced: dpRows.length - attemptMismatches.length,
  attemptsInCreditWindowTotal: dpRows.length,
  attemptMismatches,
  unpairedBashPreTotalProbed: unpairedTotal,
  unpairedBashPreTotalPublished: audit.diagnostics.unpairedBashPre.total,
  unpairedBashPreArmsProbed: unpairedArms,
  unpairedBashPreArmsPublished: audit.diagnostics.unpairedBashPre.arms,
  pass:
    attemptMismatches.length === 0 &&
    unpairedTotal === audit.diagnostics.unpairedBashPre.total &&
    unpairedArms === audit.diagnostics.unpairedBashPre.arms,
};
if (!probeControl.pass) fail(`additive probe disagrees with M195: ${JSON.stringify(probeControl)}`);

// ── reclassification ────────────────────────────────────────────────

interface Row {
  decisionPointId: string;
  armId: string;
  instanceId: string;
  repo: string;
  kind: string;
  resolved: boolean | null;
  familyKey: FamilyKey;
  candidateCount: number;
  preCapCount: number;
  relation: Relation;
  anyRelevant: boolean;
  relevantCandidates: string[];
  rules: string[];
  m195Class: DecisionClass;
  separation: SeparationClass;
  separationId: string;
  genuineSelectionMiss: boolean;
  creditWindowEdge: boolean;
  trustworthyInWindow: boolean;
  runnerEvidenceObservable: boolean;
  attemptsInWindow: number;
  selectedAnywhereInTrajectory: boolean;
  runnerEverStartedInArm: boolean;
  missPartition: MissPartition | null;
}

/** §53 diagnostics M195 published only for its union misses. */
const unionMissDiag = new Map<string, { selectedAnywhereInTrajectory: boolean; runnerEverStartedInArm: boolean }>(
  audit.diagnostics.missSpecimens.map((m: { decisionPointId: string; selectedAnywhereInTrajectory: boolean;
    runnerEverStartedInArm: boolean }) =>
    [m.decisionPointId, { selectedAnywhereInTrajectory: m.selectedAnywhereInTrajectory,
      runnerEverStartedInArm: m.runnerEverStartedInArm }]),
);

const byDpFamily = new Map<string, CandidateRow>();
for (const c of candidateRows) byDpFamily.set(`${c.decisionPointId}::${c.family}`, c);

const rows: Row[] = [];
for (const dp of dpRows) {
  const w = windowByDp.get(dp.decisionPointId) as WindowFacts;
  for (const familyKey of FAMILY_KEYS) {
    const c = byDpFamily.get(`${dp.decisionPointId}::${familyKey}`);
    const candidateCount = c ? c.candidates.length : 0;
    const relation: Relation = c ? c.relation : "NO_VALIDATION";
    const anyRelevant = c ? c.anyRelevant : false;
    const m195Class: DecisionClass = c
      ? c.decisionClass
      : "I6_NO_REPOSITORY_DERIVABLE_VALIDATION_OBLIGATION";
    const inputs = { candidateCount, bestRelation: relation, anyRelevant, m195Class };
    const separation = classifySeparation(inputs);
    const diag = unionMissDiag.get(dp.decisionPointId);
    const selectedAnywhere = familyKey === "I6-UNION" ? Boolean(diag?.selectedAnywhereInTrajectory) : false;
    const full = {
      ...inputs,
      trustworthyInWindow: w.trustworthy,
      runnerEvidenceObservable: !w.anyUnpaired,
      selectedAnywhereInTrajectory: selectedAnywhere,
    };
    rows.push({
      decisionPointId: dp.decisionPointId,
      armId: dp.armId,
      instanceId: dp.instanceId,
      repo: dp.repo,
      kind: dp.kind,
      resolved: resolvedByArm.get(dp.armId) ?? null,
      familyKey,
      candidateCount,
      preCapCount: c ? c.preCapCount : 0,
      relation,
      anyRelevant,
      relevantCandidates: c ? c.relevantCandidates : [],
      rules: c ? [...new Set(c.candidates.map((x) => x.rule))] : [],
      m195Class,
      separation,
      separationId: SEPARATION_IDS[separation],
      genuineSelectionMiss: isGenuineSelectionMiss(full),
      creditWindowEdge: creditWindowEdgeCase({ separation, selectedAnywhereInTrajectory: selectedAnywhere }),
      trustworthyInWindow: w.trustworthy,
      runnerEvidenceObservable: !w.anyUnpaired,
      attemptsInWindow: w.attempts,
      selectedAnywhereInTrajectory: selectedAnywhere,
      runnerEverStartedInArm: Boolean(diag?.runnerEverStartedInArm),
      missPartition: isM195Miss(separation) ? partitionMiss(full) : null,
    });
  }
}

// ── §12 the 14 union misses must partition exhaustively ─────────────

const unionMisses = rows.filter((r) => r.familyKey === "I6-UNION" && isM195Miss(r.separation));
const partitionCounts: Record<string, number> = {};
for (const r of unionMisses) {
  const k = r.missPartition as string;
  partitionCounts[k] = (partitionCounts[k] ?? 0) + 1;
}
const partitionSum = Object.values(partitionCounts).reduce((a, b) => a + b, 0);
const m195UnionMissCount = audit.diagnostics.missSpecimens.length;
if (unionMisses.length !== m195UnionMissCount || partitionSum !== m195UnionMissCount) {
  fail(`union miss partition does not account for all ${m195UnionMissCount} specimens`);
}

// ── §6 witness typing ───────────────────────────────────────────────

const genuineByFamily = new Map<FamilyKey, Row[]>();
const scaffoldByFamily = new Map<FamilyKey, Row[]>();
for (const k of FAMILY_KEYS) {
  genuineByFamily.set(k, rows.filter((r) => r.familyKey === k && r.genuineSelectionMiss));
  scaffoldByFamily.set(k, rows.filter((r) => r.familyKey === k &&
    r.separation === "VALIDATION_SCAFFOLD_OPPORTUNITY"));
}

interface WitnessRow {
  familyKey: FamilyKey;
  decisionPointId: string;
  instanceId: string;
  repo: string;
  relation: Relation;
  strong: boolean;
  type: string;
  failedAnalogueChoseDifferentTarget: boolean;
  failedAnaloguePerformedNoValidation: boolean;
}
const witnessRows: WitnessRow[] = audit.witnesses.map((w: {
  familyKey: FamilyKey; decisionPointId: string; instanceId: string; repo: string;
  relation: Relation; strong: boolean;
}) => {
  const choseDifferent = (genuineByFamily.get(w.familyKey) ?? []).length > 0;
  const noValidation = (scaffoldByFamily.get(w.familyKey) ?? []).length > 0;
  return {
    familyKey: w.familyKey,
    decisionPointId: w.decisionPointId,
    instanceId: w.instanceId,
    repo: w.repo,
    relation: w.relation,
    strong: w.strong,
    failedAnalogueChoseDifferentTarget: choseDifferent,
    failedAnaloguePerformedNoValidation: noValidation,
    type: classifyWitness({
      successSideSelectedCandidate: w.relation === "EXACT_MATCH" || w.relation === "EQUIVALENT",
      failedAnalogueChoseDifferentTarget: choseDifferent,
      failedAnaloguePerformedNoValidation: noValidation,
    }),
  };
});

// ── §7/§8 the two axes, at the union level ──────────────────────────

const unionGenuine = genuineByFamily.get("I6-UNION") as Row[];
const unionScaffold = scaffoldByFamily.get("I6-UNION") as Row[];
const selectionWitnesses = witnessRows.filter((w) => w.familyKey === "I6-UNION" &&
  w.type === "SELECTION_WITNESS");
const selectionGate = evaluateSelectionGate({
  missTasks: new Set(unionGenuine.map((r) => r.instanceId)).size,
  missRepos: new Set(unionGenuine.map((r) => r.repo)).size,
  selectionWitnesses: new Set(selectionWitnesses.map((w) => w.instanceId)).size,
  selectionWitnessRepos: new Set(selectionWitnesses.map((w) => w.repo)).size,
});
const axisA = selectionVerdict(selectionGate);
const axisB = scaffoldVerdict({
  tasks: new Set(unionScaffold.map((r) => r.instanceId)).size,
  repos: new Set(unionScaffold.map((r) => r.repo)).size,
});

// ── §9 selectivity, §10 the dead gate ───────────────────────────────

const selectivity: Array<{ family: FamilyKey; stats: SelectivityStats; verdict: string }> =
  FAMILY_KEYS.map((k) => {
    const firing = rows.filter((r) => r.familyKey === k && r.candidateCount > 0);
    const stats = selectivityStats(firing.map((r) => r.preCapCount), firing.map((r) => r.candidateCount));
    return { family: k, stats, verdict: selectivityVerdict(stats) };
  });

const widestRow = [...rows].sort((a, b) => b.preCapCount - a.preCapCount)[0] as Row;
const deadGate = {
  ...deadGateControl(widestRow.preCapCount, [widestRow.candidateCount, widestRow.candidateCount,
    widestRow.candidateCount]),
  specimen: widestRow.decisionPointId,
  specimenFamily: widestRow.familyKey,
  syntheticRaw10: deadGateControl(10, [3, 3, 3]),
  g2HasAnyFailingInputInItsDomain: g2CanFail([0, 1, 2, 3]),
  g2WouldFailOnRawCounts: deadGateControl(widestRow.preCapCount,
    rows.filter((r) => r.familyKey === widestRow.familyKey && r.candidateCount > 0)
      .map((r) => r.preCapCount)),
  deliveredCountDomain: [...new Set(rows.map((r) => r.candidateCount))].sort(),
};

// ── §22 raw candidate concentration ─────────────────────────────────

const byTaskRaw = new Map<string, number>();
const byRepoRaw = new Map<string, number>();
for (const r of rows) {
  if (r.familyKey === "I6-UNION") continue;
  byTaskRaw.set(r.instanceId, Math.max(byTaskRaw.get(r.instanceId) ?? 0, r.preCapCount));
  byRepoRaw.set(r.repo, (byRepoRaw.get(r.repo) ?? 0) + Math.max(0, r.preCapCount - r.candidateCount));
}
const concentration = {
  largestTaskRawCandidateCount: [...byTaskRaw.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([instanceId, raw]) => ({ instanceId, raw })),
  largestRepoDiscardedContribution: [...byRepoRaw.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([repo, discarded]) => ({ repo, discarded })),
  familiesCausingExpansion: FAMILY_KEYS.filter((k) => k !== "I6-UNION").map((k) => {
    const firing = rows.filter((r) => r.familyKey === k && r.candidateCount > 0);
    return { family: k, pointsOverBound: firing.filter((r) => r.preCapCount > 3).length,
      totalDiscarded: firing.reduce((a, r) => a + Math.max(0, r.preCapCount - r.candidateCount), 0) };
  }),
};

// ── §21 delivered-rank support ──────────────────────────────────────

const rankSupport = {
  note:
    "The frozen mechanism attaches no score to a candidate. `rank` is the index " +
    "after a coarse tier sort with an alphabetical or insertion-order tie-break " +
    "(I6-A tier then path, I6-B tier then path, I6-C explicit before derived, " +
    "I6-D regex match order). There is therefore no scalar in which a gap " +
    "between rank 1, 2, 3 and the first discarded candidate could be expressed.",
  scoresAreComparable: false,
  discardedCandidatesObservable: false,
  discardedObservabilityNote:
    "cap() is applied inside each derive*() before it returns, so only the " +
    "cardinality of the discarded tail survives as preCapCount. Recovering its " +
    "contents would mean raising top-k, which §26 forbids.",
  pointsWhereTruncationBinds: rows.filter((r) => r.familyKey !== "I6-UNION" && r.preCapCount > 3).length,
  pointsWhereAllDeliveredShareOneRule: rows.filter(
    (r) => r.familyKey !== "I6-UNION" && r.preCapCount > 3 && r.rules.length === 1,
  ).length,
};

// ── §18 counterexamples ─────────────────────────────────────────────

const missTaskIds = new Set(unionMisses.map((r) => r.instanceId));
const counterexamples = {
  candidateSkippedButTaskResolved: {
    tasks: [...missTaskIds].filter((t) => unionMisses.some((r) => r.instanceId === t && r.resolved === true))
      .length,
    ofMissTasks: missTaskIds.size,
  },
  candidateRunUsefulFailureSeenTaskStillFailed:
    audit.diagnostics.validationExecutedButReasoningFailedArms.length,
  resolvedArmsThatNeverStartedAnyRunner: audit.diagnostics.resolvedArmsThatNeverStartedAnyRunner,
  alreadySelectedButTaskFailed: new Set(
    rows.filter((r) => r.familyKey === "I6-UNION" &&
      r.separation === "VALIDATION_TARGET_ALREADY_SELECTED" && r.resolved === false)
      .map((r) => r.instanceId),
  ).size,
};

// ── §28 the per-family semantic matrix ──────────────────────────────

const matrix = FAMILY_KEYS.map((k) => {
  const fam = rows.filter((r) => r.familyKey === k);
  const cnt = (c: SeparationClass): number => fam.filter((r) => r.separation === c).length;
  const sel = selectivity.find((s) => s.family === k) as { stats: SelectivityStats; verdict: string };
  return {
    family: k,
    decisionPoints: fam.length,
    genuineSelectionMisses: fam.filter((r) => r.genuineSelectionMiss).length,
    /** S1 rows, including any that the §5 evidence clauses withhold from the
     *  genuine set. Reported so the class columns sum to the row count. */
    selectionOpportunityRowsS1: cnt("VALIDATION_TARGET_SELECTION_OPPORTUNITY"),
    scaffoldOpportunities: cnt("VALIDATION_SCAFFOLD_OPPORTUNITY"),
    alreadySelected: cnt("VALIDATION_TARGET_ALREADY_SELECTED"),
    broader: cnt("VALIDATION_BROADER_SELECTION"),
    unusable: cnt("VALIDATION_EVIDENCE_UNUSABLE"),
    firedNotConfirmed: cnt("CANDIDATE_FIRED_NOT_CONFIRMED"),
    noDerivableTarget: cnt("NO_DERIVABLE_VALIDATION_TARGET"),
    m195Misses: fam.filter((r) => isM195Miss(r.separation)).length,
    rawMedian: sel.stats.rawMedian,
    rawP90: sel.stats.rawP90,
    rawMax: sel.stats.rawMax,
    deliveredMax: sel.stats.deliveredMax,
    selectivityVerdict: sel.verdict,
  };
});

// ── blindness replay, re-reported from the reproduced artefacts ─────

const blindness = {
  decisionPoints: dpRows.length,
  differingFingerprints: dpRows.filter((d) => d.candidateSetHash !== d.blindCandidateSetHash).length,
  verdict: audit.blindness.verdict,
  reproducedFromByteIdenticalArtefacts: true,
};

// ── output ──────────────────────────────────────────────────────────

const summarise = (rs: Row[]) => ({
  rows: rs.length,
  arms: new Set(rs.map((r) => r.armId)).size,
  tasks: new Set(rs.map((r) => r.instanceId)).size,
  repositories: new Set(rs.map((r) => r.repo)).size,
  resolved: rs.filter((r) => r.resolved === true).length,
  unresolved: rs.filter((r) => r.resolved === false).length,
  families: [...new Set(rs.map((r) => r.familyKey))].sort(),
});

const report = {
  schemaVersion: M195A_SCHEMA_VERSION,
  milestone: "M195A",
  preregistration: "results/stage5_m195a_preregistration.md",
  parent: "results/stage5_m195_preregistration.md",
  liveAgentRuns: 0,
  liveModelSpendUsd: 0,
  authority: {
    artefacts: authority,
    allByteIdentical: authority.every((a) => a.identical),
    population: audit.population,
    m195MechanismVerdict: audit.mechanismVerdict,
    m195UnionSelectionMisses: m195UnionMissCount,
    heldOutInspected: false,
    candidateFamiliesChanged: false,
    probeControl,
  },
  blindness,
  separation: {
    unionMissPartition: partitionCounts,
    unionMissPartitionSum: partitionSum,
    genuineSelectionMiss: summarise(unionGenuine),
    scaffoldOpportunity: summarise(unionScaffold),
    genuineSelectionMissAllFamilies: summarise(rows.filter((r) => r.genuineSelectionMiss)),
    scaffoldOpportunityAllFamilies: summarise(
      rows.filter((r) => r.separation === "VALIDATION_SCAFFOLD_OPPORTUNITY"),
    ),
    creditWindowEdgeCases: rows.filter((r) => r.familyKey === "I6-UNION" && r.creditWindowEdge)
      .map((r) => r.decisionPointId),
    unionMissesWithAnyAttemptInWindow: unionMisses.filter((r) => r.attemptsInWindow > 0).length,
    unionMissesRestingOnUnobservableRunner: unionMisses.filter((r) => !r.runnerEvidenceObservable).length,
    selectionOpportunitySpecimens: rows
      .filter((r) => r.separation === "VALIDATION_TARGET_SELECTION_OPPORTUNITY")
      .map((r) => ({
        decisionPointId: r.decisionPointId,
        familyKey: r.familyKey,
        repo: r.repo,
        resolved: r.resolved,
        preCapCount: r.preCapCount,
        candidateCount: r.candidateCount,
        trustworthyInWindow: r.trustworthyInWindow,
        runnerEvidenceObservable: r.runnerEvidenceObservable,
        genuineSelectionMiss: r.genuineSelectionMiss,
        withheldBy: r.genuineSelectionMiss
          ? null
          : !r.trustworthyInWindow
            ? "prereg §5.3 no trustworthy validation in the credit window"
            : "prereg §5.6 runner outcome not observable",
      })),
  },
  witnesses: {
    total: witnessRows.length,
    byType: witnessRows.reduce((a: Record<string, number>, w) => {
      a[w.type] = (a[w.type] ?? 0) + 1;
      return a;
    }, {}),
    strong: witnessRows.filter((w) => w.strong).length,
    unionSelectionWitnesses: selectionWitnesses.length,
    rows: witnessRows,
  },
  counterexamples,
  selectivity,
  concentration,
  rankSupport,
  deadGate,
  matrix,
  selectionGate,
  verdicts: {
    axisA,
    axisB,
    replication: axisA === "VALIDATION_SELECTION_MECHANISM_REMAINS_WITNESSED"
      ? "HELD_OUT_I6_SELECTION_REPLICATION_LICENSED"
      : "NO_HELD_OUT_I6_SELECTION_REPLICATION_LICENSED",
    closure: axisA === "VALIDATION_SELECTION_MECHANISM_NOT_WITNESSED"
      ? "I6_VALIDATION_SELECTION_CLOSE_RECOMMENDED"
      : "I6_VALIDATION_SELECTION_REMAINS_OPEN",
    standing: [
      "NO_VTRACE_I6_PRODUCT_IMPLEMENTATION_AUTHORIZED",
      "NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED",
      "NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED",
      "I5_REMAINS_CLOSED",
    ],
    runtimeGroundedRepair: "NOT ANALYSED",
  },
};

writeFileSync(join(outDir, "stage5_m195a_separation.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(
  join(outDir, "stage5_m195a_rows.jsonl"),
  `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
);
writeFileSync(
  join(outDir, "stage5_m195a_miss_ledger.jsonl"),
  `${unionMisses.map((r) => JSON.stringify({
    decisionPointId: r.decisionPointId,
    instanceId: r.instanceId,
    repo: r.repo,
    m195Class: r.m195Class,
    relation: r.relation,
    validationAttemptedInWindow: r.attemptsInWindow > 0,
    runnerStartedInWindow: r.relation === "DIFFERENT_VALIDATION" ||
      r.relation === "BROADER_THAN_CANDIDATE",
    runnerEverStartedInArm: r.runnerEverStartedInArm,
    newClass: r.separation,
    newClassId: r.separationId,
    missPartition: r.missPartition,
    resolved: r.resolved,
    creditWindowEdge: r.creditWindowEdge,
    relevantCandidates: r.relevantCandidates,
  })).join("\n")}\n`,
);

console.log(JSON.stringify({
  authority: report.authority.allByteIdentical,
  probeControl: probeControl.pass,
  unionMissPartition: partitionCounts,
  genuineSelectionMisses: unionGenuine.length,
  scaffoldOpportunities: unionScaffold.length,
  axisA,
  axisB,
  deadGate: deadGate.verdict,
}, null, 2));
