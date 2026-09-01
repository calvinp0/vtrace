/**
 * M195 - the audit driver.
 *
 * Extracts decision points from the frozen M194 telemetry, builds the blind
 * evidence object, derives candidates twice (once over the normal corpus, once
 * over a corpus with gold, outcome and every future event physically removed),
 * compares the fingerprints, and only then reveals outcome data to the
 * evaluation layer.
 *
 *   bun run_stage5_m195_audit.ts --m194 <root> --facts <dir> --dataset <jsonl> --out <results dir>
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ChangedFileFreshness,
  type SemanticTestResult,
  type StreamCapture,
  classifySourceVersion,
  classifyValidationProvenance,
  provenanceIsUsable,
  runnerStarted,
  semanticTestResult,
  sourceVersionIsUsable,
} from "./m193Acquisition";
import { isValidationAttempt, streamCapture } from "./m194Lifecycle";
import {
  type Candidate,
  type Family,
  type FamilyCandidates,
  type I6DecisionPointEvidence,
  type RedactedEvent,
  type RepoFacts,
  M195_FAMILIES,
  M195_MAX_TARGETS,
  candidateSetHash,
  derivationInputHash,
  deriveCandidates,
  parseChangedPaths,
  parseChangedSymbols,
  tracePrefixHash,
  unionOf,
} from "./m195Mechanism";
import {
  type DecisionClass,
  type GoldEvidence,
  type ObservedValidation,
  type Relation,
  RELATION_RANK,
  changedStemsOf,
  classifyDecisionPoint,
  evaluateGates,
  goldEvidence,
  isRelevant,
  parseValidationTargets,
  relateCandidate,
} from "./m195Evaluation";

const argv = process.argv.slice(2);
const arg = (k: string, d = ""): string => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : d;
};
const m194Root = resolve(arg("--m194"));
const factsDir = resolve(arg("--facts"));
const datasetPath = resolve(arg("--dataset"));
const outDir = resolve(arg("--out"));
const CHECKOUT_ROOT = "/testbed";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

// ── raw event view ──────────────────────────────────────────────────

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
  toolResponse?: { stdout?: string; stderr?: string };
  streamsCaptured?: boolean;
  exitCode?: number | null;
  moduleFile?: string | null;
  stateHashBefore?: string | null;
  stateHashAfter?: string | null;
  probe?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * One observed validation, with M193/M194's own verdicts attached.
 *
 * Built from the `bash_pre` event, not from the pre/post pair. 23 of the
 * corpus's 268 Bash calls, spread over 14 arms, have a `bash_pre` and no
 * `bash_post` - the call was interrupted or timed out before the adapter saw it
 * finish. Pairing first would have thrown those away, and with them the agent's
 * *selection*, which is the only thing §10 asks about. Whether the runner
 * started, what it printed and whether the evidence is trustworthy are all
 * post-event facts and stay unknown when the post is missing.
 */
interface ValidationView {
  sequence: number;
  command: string;
  attempt: boolean;
  /** false whenever the call produced no observed completion */
  started: boolean;
  result: SemanticTestResult;
  trustworthy: boolean;
  completed: boolean;
  output: string;
}

interface EditView {
  sequence: number;
  diffHash: string;
  patchPath: string;
}

interface ArmView {
  armId: string;
  instanceId: string;
  repo: string;
  dir: string;
  events: RawEvent[];
  edits: EditView[];
  validations: ValidationView[];
}

function loadArm(dir: string): ArmView | null {
  const armPath = join(dir, "arm.json");
  if (!existsSync(armPath)) return null;
  const arm = JSON.parse(readFileSync(armPath, "utf8"));
  if (!arm.modelLaunched) return null;
  const events: RawEvent[] = readFileSync(join(dir, "raw/adapter_events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

  const robustness = (arm.phases?.provenanceRobustness?.robustness ?? "UNKNOWN") as
    "EDITABLE_INSTALL" | "CWD_DEPENDENT" | "UNKNOWN";

  const edits: EditView[] = events
    .filter((e) => e.kind === "patch_snapshot" && e.boundary === "AFTER_EDIT" && e.patchPath)
    .map((e) => ({ sequence: e.sequence ?? 0, diffHash: e.diffHash ?? "", patchPath: e.patchPath as string }));

  const byTool = new Map<string, RawEvent[]>();
  for (const e of events) {
    if (!e.toolUseId) continue;
    byTool.set(e.toolUseId, [...(byTool.get(e.toolUseId) ?? []), e]);
  }

  const validations: ValidationView[] = [];
  for (const group of byTool.values()) {
    const pre = group.find((e) => e.kind === "bash_pre");
    const post = group.find((e) => e.kind === "bash_post");
    const prov = group.find((e) => e.kind === "validation_provenance");
    if (!pre) continue;
    // M194's own capture helper, restated: the adapter's separated streams.
    // With no post there are no streams, so the command has to carry the
    // classification on its own - which is exactly what a bare `pytest <path>`
    // does, and exactly what a `./run-ci` wrapper cannot.
    const streams: StreamCapture = streamCapture(post?.stdout, post?.stderr);
    const command = pre.originalCommand ?? "";
    const attempt = isValidationAttempt(command, streams);
    if (!attempt) continue;
    const started = post ? runnerStarted(streams) : false;
    const probe = (prov?.probe ?? {}) as Record<string, unknown>;
    const p = classifyValidationProvenance({
      isValidationAttempt: attempt,
      runnerStarted: started,
      workdir: CHECKOUT_ROOT,
      checkoutRoot: CHECKOUT_ROOT,
      moduleFile: (prov?.moduleFile as string | null) ?? null,
      robustness,
    });
    const sv = classifySourceVersion({
      isValidationAttempt: attempt,
      runnerStarted: started,
      probeRan: Boolean(probe.probeRan),
      stateStableAcrossValidation:
        prov?.stateHashBefore != null && prov.stateHashBefore === prov.stateHashAfter,
      changedSourceFileCount: (probe.requestedPaths as unknown[] | undefined)?.length ?? 0,
      fileVerdicts: ((probe.files as Record<string, unknown>[] | undefined) ?? []).map(
        (f) => (f.verdict as ChangedFileFreshness) ?? "INDETERMINATE",
      ),
    });
    validations.push({
      sequence: post?.sequence ?? pre.sequence ?? 0,
      command,
      attempt,
      started,
      result: post ? semanticTestResult(streams) : "UNKNOWN",
      trustworthy: Boolean(post) && provenanceIsUsable(p) && sourceVersionIsUsable(sv),
      completed: Boolean(post),
      output: post
        ? `${post.stdout ?? ""}\n${post.stderr ?? ""}\n${post.toolResponse?.stdout ?? ""}\n${post.toolResponse?.stderr ?? ""}`
        : "",
    });
  }
  validations.sort((a, b) => a.sequence - b.sequence);
  return { armId: arm.armId, instanceId: arm.instanceId, repo: arm.repo, dir, events, edits, validations };
}

// ── §4 decision-point extraction (frozen) ───────────────────────────

interface DecisionPoint {
  decisionPointId: string;
  armId: string;
  instanceId: string;
  repo: string;
  sequence: number;
  kind: "DP_EDIT" | "DP_POST_FAILED_VALIDATION";
  diffHash: string;
  patchPath: string;
  observedFailureSequence: number | null;
}

function extractDecisionPoints(arm: ArmView): DecisionPoint[] {
  const out: DecisionPoint[] = [];
  const attemptSeqs = arm.validations.map((v) => v.sequence).sort((a, b) => a - b);

  // DP_EDIT: one per maximal edit run with no intervening validation attempt,
  // anchored at the last edit of the run.
  for (let i = 0; i < arm.edits.length; i++) {
    const cur = arm.edits[i] as EditView;
    const next = arm.edits[i + 1];
    const closes =
      !next || attemptSeqs.some((s) => s > cur.sequence && s < (next as EditView).sequence);
    if (!closes) continue;
    out.push({
      decisionPointId: `${arm.armId}#${cur.sequence}`,
      armId: arm.armId,
      instanceId: arm.instanceId,
      repo: arm.repo,
      sequence: cur.sequence,
      kind: "DP_EDIT",
      diffHash: cur.diffHash,
      patchPath: cur.patchPath,
      observedFailureSequence: null,
    });
  }

  // DP_POST_FAILED_VALIDATION: at each trustworthy failing validation with a successor.
  const lastSeq = arm.events[arm.events.length - 1]?.sequence ?? 0;
  for (const v of arm.validations) {
    if (!v.trustworthy) continue;
    if (v.result !== "FAILED" && v.result !== "MIXED") continue;
    if (v.sequence >= lastSeq) continue;
    const prior = arm.edits.filter((e) => e.sequence <= v.sequence).pop();
    if (!prior) continue;
    out.push({
      decisionPointId: `${arm.armId}#${v.sequence}`,
      armId: arm.armId,
      instanceId: arm.instanceId,
      repo: arm.repo,
      sequence: v.sequence,
      kind: "DP_POST_FAILED_VALIDATION",
      diffHash: prior.diffHash,
      patchPath: prior.patchPath,
      observedFailureSequence: v.sequence,
    });
  }
  return out.sort((a, b) => a.sequence - b.sequence);
}

// ── §5 blind evidence construction ──────────────────────────────────

interface EvidenceSource {
  events: RawEvent[];
  taskText: string;
  diffText: string;
  observedFailureText: string | null;
  facts: RepoFacts;
}

function redact(events: RawEvent[], through: number, validations: ValidationView[]): RedactedEvent[] {
  const vBySeq = new Map(validations.map((v) => [v.sequence, v]));
  const out: RedactedEvent[] = [];
  for (const e of events) {
    const s = e.sequence ?? 0;
    if (s >= through) break;
    if (e.kind === "patch_snapshot" && e.boundary === "AFTER_EDIT") {
      out.push({ sequence: s, type: "edit", diffHash: e.diffHash ?? "" });
    } else if (e.kind === "bash_post" && vBySeq.has(s)) {
      const v = vBySeq.get(s) as ValidationView;
      out.push({
        sequence: s,
        type: "validation_attempt",
        command: v.command,
        runnerStarted: v.started,
        semanticResult: v.result,
      });
    } else if (e.kind === "patch_snapshot" && e.boundary === "OBSERVATION") {
      out.push({ sequence: s, type: "observation" });
    }
  }
  return out;
}

function buildEvidence(dp: DecisionPoint, src: EvidenceSource, validations: ValidationView[]): I6DecisionPointEvidence {
  const changedSourcePaths = parseChangedPaths(src.diffText);
  return {
    decisionPointId: dp.decisionPointId,
    armId: dp.armId,
    instanceId: dp.instanceId,
    repo: dp.repo,
    sequence: dp.sequence,
    kind: dp.kind,
    taskText: src.taskText,
    currentDiffText: src.diffText,
    changedSourcePaths,
    changedSymbols: parseChangedSymbols(src.diffText),
    // strictly earlier events only; a DP_POST_FAILED_VALIDATION includes its own
    // failure through observedFailureText, which the agent had already seen.
    priorEvents: redact(src.events, dp.sequence + (dp.kind === "DP_POST_FAILED_VALIDATION" ? 1 : 0), validations),
    observedFailureText: src.observedFailureText,
    repoFacts: src.facts,
  };
}

// ── main ────────────────────────────────────────────────────────────

const runsDir = join(m194Root, "runs");
const accounting = JSON.parse(readFileSync(join(m194Root, "corpus_accounting.json"), "utf8"));
const lifecycles: Array<Record<string, any>> = accounting.lifecycles;
const resolvedByArm = new Map(lifecycles.map((l) => [l.armId, l.resolved as boolean | null]));

const dataset = new Map<string, any>();
for (const line of readFileSync(datasetPath, "utf8").trim().split("\n")) {
  const r = JSON.parse(line);
  dataset.set(r.instance_id, r);
}

const arms: ArmView[] = readdirSync(runsDir)
  .sort()
  .map((d) => loadArm(join(runsDir, d)))
  .filter((a): a is ArmView => a !== null);

const factsOf = new Map<string, RepoFacts>();
for (const a of arms) {
  factsOf.set(a.instanceId, JSON.parse(readFileSync(join(factsDir, `${a.instanceId}.json`), "utf8")));
}

// A scratch corpus with gold, outcome and future physically removed (§6).
const stripRoot = mkdtempSync(join(tmpdir(), "m195-blind-"));

interface DPRecord {
  /** Every validation the arm ever issued - used only for reported diagnostics,
   *  never for the frozen credit window, which §28 fixed as forward-looking. */
  allTimeTargets: ObservedValidation[];
  dp: DecisionPoint;
  evidence: I6DecisionPointEvidence;
  families: FamilyCandidates[];
  union: FamilyCandidates;
  sightedHash: string;
  blindHash: string;
  inputHash: string;
  prefixHash: string;
  windowAttempts: ValidationView[];
  windowTargets: ObservedValidation[];
  postValidationRevision: boolean;
}

const records: DPRecord[] = [];

for (const arm of arms) {
  const facts = factsOf.get(arm.instanceId) as RepoFacts;
  const taskText = readFileSync(join(arm.dir, "raw/prompt.txt"), "utf8");
  const dps = extractDecisionPoints(arm);

  for (const dp of dps) {
    const diffText = readFileSync(join(arm.dir, dp.patchPath), "utf8");
    const failure =
      dp.observedFailureSequence === null
        ? null
        : (arm.validations.find((v) => v.sequence === dp.observedFailureSequence)?.output ?? null);

    const sighted: EvidenceSource = { events: arm.events, taskText, diffText, observedFailureText: failure, facts };
    const ev = buildEvidence(dp, sighted, arm.validations);
    const families = deriveCandidates(ev);
    const sightedHash = candidateSetHash(families);

    // ── blind replay: write a bundle that physically lacks the future ──
    const bundle = join(stripRoot, dp.decisionPointId.replace(/[^\w.-]/g, "_"));
    mkdirSync(bundle, { recursive: true });
    const truncated = arm.events.filter((e) => (e.sequence ?? 0) <= dp.sequence);
    writeFileSync(join(bundle, "events.jsonl"), truncated.map((e) => JSON.stringify(e)).join("\n"));
    writeFileSync(join(bundle, "prompt.txt"), taskText);
    writeFileSync(join(bundle, "diff.patch"), diffText);
    if (failure !== null) writeFileSync(join(bundle, "failure.txt"), failure);
    writeFileSync(join(bundle, "repo_facts.json"), JSON.stringify(facts));
    // no final.patch, no arm.json, no dataset row, no later events, no snapshots.

    const blindEvents: RawEvent[] = readFileSync(join(bundle, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const blindSrc: EvidenceSource = {
      events: blindEvents,
      taskText: readFileSync(join(bundle, "prompt.txt"), "utf8"),
      diffText: readFileSync(join(bundle, "diff.patch"), "utf8"),
      observedFailureText: existsSync(join(bundle, "failure.txt"))
        ? readFileSync(join(bundle, "failure.txt"), "utf8")
        : null,
      facts: JSON.parse(readFileSync(join(bundle, "repo_facts.json"), "utf8")),
    };
    const blindValidations = arm.validations.filter((v) => v.sequence <= dp.sequence);
    const blindEv = buildEvidence(dp, blindSrc, blindValidations);
    const blindHash = candidateSetHash(deriveCandidates(blindEv));

    // ── §10 credit window (evaluation input, not derivation input) ────
    const windowEnd =
      arm.edits.find((e) => e.sequence > dp.sequence && e.diffHash !== dp.diffHash)?.sequence ?? Infinity;
    const windowAttempts = arm.validations.filter((v) => v.sequence > dp.sequence && v.sequence < windowEnd);
    const windowTargets = windowAttempts.map((v) => ({
      targets: parseValidationTargets(arm.repo, v.command, facts),
      runnerStarted: v.started,
    }));
    const postValidationRevision =
      windowAttempts.length > 0 &&
      arm.edits.some((e) => e.sequence > (windowAttempts[0] as ValidationView).sequence && e.diffHash !== dp.diffHash);

    records.push({
      allTimeTargets: arm.validations.map((v) => ({
        targets: parseValidationTargets(arm.repo, v.command, facts),
        runnerStarted: v.started,
      })),
      dp,
      evidence: ev,
      families,
      union: unionOf(families),
      sightedHash,
      blindHash,
      inputHash: derivationInputHash(ev),
      prefixHash: tracePrefixHash(ev.priorEvents),
      windowAttempts,
      windowTargets,
      postValidationRevision,
    });
  }
}

rmSync(stripRoot, { recursive: true, force: true });

// ── evaluation ──────────────────────────────────────────────────────

const goldOf = new Map<string, GoldEvidence>();
for (const a of arms) {
  goldOf.set(a.instanceId, goldEvidence(dataset.get(a.instanceId), factsOf.get(a.instanceId) as RepoFacts));
}

type FamilyKey = Family | "I6-UNION";
const ALL_KEYS: FamilyKey[] = [...M195_FAMILIES, "I6-UNION"];

interface Scored {
  decisionPointId: string;
  armId: string;
  instanceId: string;
  repo: string;
  kind: string;
  resolved: boolean | null;
  familyKey: FamilyKey;
  candidateCount: number;
  preCapCount: number;
  candidates: Candidate[];
  relation: Relation;
  anyRelevant: boolean;
  relevantCandidates: string[];
  decisionClass: DecisionClass;
  attemptsInWindow: number;
  trustworthyInWindow: boolean;
  observedResults: SemanticTestResult[];
  postValidationRevision: boolean;
  /** §53 diagnostics. Reported, never gated - the gates were frozen first. */
  selectedAnywhereInTrajectory: boolean;
  runnerEverStartedInArm: boolean;
}

const scored: Scored[] = [];
for (const r of records) {
  const gold = goldOf.get(r.dp.instanceId) as GoldEvidence;
  const stems = changedStemsOf(r.evidence.changedSourcePaths);
  const trustworthy = r.windowAttempts.some((v) => v.trustworthy);
  const results = r.windowAttempts.map((v) => v.result);
  for (const key of ALL_KEYS) {
    const fc = key === "I6-UNION" ? r.union : (r.families.find((f) => f.family === key) as FamilyCandidates);
    const cands = fc.candidates;
    let best: Relation = cands.length === 0 ? "NO_VALIDATION" : "NO_VALIDATION";
    for (const c of cands) {
      const rel = relateCandidate(c, r.windowTargets, stems);
      if (RELATION_RANK[rel] < RELATION_RANK[best]) best = rel;
    }
    const relevant = cands.filter((c) => isRelevant(c, gold));
    const anywhere = relevant.some((c) => {
      const rel = relateCandidate(c, r.allTimeTargets, stems);
      return rel === "EXACT_MATCH" || rel === "EQUIVALENT";
    });
    scored.push({
      selectedAnywhereInTrajectory: anywhere,
      runnerEverStartedInArm: r.allTimeTargets.some((t) => t.runnerStarted),
      decisionPointId: r.dp.decisionPointId,
      armId: r.dp.armId,
      instanceId: r.dp.instanceId,
      repo: r.dp.repo,
      kind: r.dp.kind,
      resolved: resolvedByArm.get(r.dp.armId) ?? null,
      familyKey: key,
      candidateCount: cands.length,
      preCapCount: fc.preCapCount,
      candidates: cands,
      relation: best,
      anyRelevant: relevant.length > 0,
      relevantCandidates: relevant.map((c) => (c.node ? `${c.path}::${c.node}` : c.path)),
      decisionClass: classifyDecisionPoint({
        candidateCount: cands.length,
        bestRelation: best,
        anyRelevant: relevant.length > 0,
        attemptsInWindow: r.windowAttempts.length,
        anyTrustworthyInWindow: trustworthy,
      }),
      attemptsInWindow: r.windowAttempts.length,
      trustworthyInWindow: trustworthy,
      observedResults: results,
      postValidationRevision: r.postValidationRevision,
    });
  }
}

// ── §14 success-side witnesses ──────────────────────────────────────

interface Witness {
  familyKey: FamilyKey;
  decisionPointId: string;
  armId: string;
  instanceId: string;
  repo: string;
  relation: Relation;
  candidates: string[];
  observedResults: SemanticTestResult[];
  strong: boolean;
}

const witnesses: Witness[] = [];
for (const s of scored) {
  if (s.resolved !== true) continue;
  if (s.candidateCount === 0) continue;
  if (s.relation !== "EXACT_MATCH" && s.relation !== "EQUIVALENT") continue;
  if (!s.trustworthyInWindow) continue;
  if (!s.observedResults.some((r) => r !== "UNKNOWN")) continue;
  if (!s.anyRelevant) continue;
  witnesses.push({
    familyKey: s.familyKey,
    decisionPointId: s.decisionPointId,
    armId: s.armId,
    instanceId: s.instanceId,
    repo: s.repo,
    relation: s.relation,
    candidates: s.candidates.map((c) => (c.node ? `${c.path}::${c.node}` : c.path)),
    observedResults: s.observedResults,
    strong: s.observedResults.some((r) => r === "FAILED" || r === "MIXED") && s.postValidationRevision,
  });
}

// ── §13 per-family scoring ──────────────────────────────────────────

const pct = (n: number, d: number): number => (d === 0 ? 0 : Number(((n / d) * 100).toFixed(1)));
const quant = (xs: number[], q: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] as number;
};

const familyRows = ALL_KEYS.map((key) => {
  const rows = scored.filter((s) => s.familyKey === key);
  const counts = rows.map((r) => r.candidateCount);
  const firing = rows.filter((r) => r.candidateCount > 0);
  const misses = rows.filter((r) => r.decisionClass === "I6_VALIDATION_SELECTION_MISS");
  const firedNotSelected = firing.filter(
    (r) => r.relation === "DIFFERENT_VALIDATION" || r.relation === "NO_VALIDATION",
  );
  const redundant = firing.filter(
    (r) => r.relation === "EXACT_MATCH" || r.relation === "EQUIVALENT",
  );
  const resolvedRows = rows.filter((r) => r.resolved === true);
  const resolvedFiring = resolvedRows.filter((r) => r.candidateCount > 0);
  const unnecessary = resolvedFiring.filter((r) => !r.anyRelevant);
  const missTasks = new Set(misses.map((m) => m.instanceId));
  const byTask = new Map<string, number>();
  for (const m of misses) byTask.set(m.instanceId, (byTask.get(m.instanceId) ?? 0) + 1);
  const w = witnesses.filter((x) => x.familyKey === key);
  const witnessTasks = new Set(w.map((x) => x.instanceId));

  const score = {
    family: key,
    fingerprintDiffs: 0, // filled below; the replay is family-independent
    medianCandidates: quant(counts, 0.5),
    p90Candidates: quant(counts, 0.9),
    maxCandidates: counts.length ? Math.max(...counts) : 0,
    emptyRatePct: pct(rows.length - firing.length, rows.length),
    missTasks: missTasks.size,
    missRepos: new Set(misses.map((m) => m.repo)).size,
    successWitnesses: witnessTasks.size,
    successWitnessRepos: new Set(w.map((x) => x.repo)).size,
    unnecessaryFireRatePctResolved: pct(unnecessary.length, resolvedFiring.length),
    redundantRecommendationRatePct: pct(redundant.length, firing.length),
    largestTaskSharePct: pct(Math.max(0, ...byTask.values()), misses.length),
    missPrecision: firedNotSelected.length === 0 ? 0 : misses.length / firedNotSelected.length,
  };
  return {
    score,
    decisionPoints: rows.length,
    candidateProducing: firing.length,
    preCapMedian: quant(rows.map((r) => r.preCapCount), 0.5),
    preCapMax: rows.length ? Math.max(...rows.map((r) => r.preCapCount)) : 0,
    missSpecimens: misses.length,
    strongWitnesses: w.filter((x) => x.strong).length,
    interventionRateResolvedPct: pct(resolvedFiring.length, resolvedRows.length),
    burdenPerArm: Number((firing.length / Math.max(1, new Set(rows.map((r) => r.armId)).size)).toFixed(2)),
    specificity: firing
      .flatMap((r) => r.candidates.map((c) => c.specificity))
      .reduce<Record<string, number>>((a, s) => ({ ...a, [s]: (a[s] ?? 0) + 1 }), {}),
    relations: rows.reduce<Record<string, number>>((a, r) => ({ ...a, [r.relation]: (a[r.relation] ?? 0) + 1 }), {}),
    classes: rows.reduce<Record<string, number>>(
      (a, r) => ({ ...a, [r.decisionClass]: (a[r.decisionClass] ?? 0) + 1 }),
      {},
    ),
  };
});

const fingerprintDiffs = records.filter((r) => r.sightedHash !== r.blindHash);
for (const f of familyRows) f.score.fingerprintDiffs = fingerprintDiffs.length;
const gatesByFamily = familyRows.map((f) => ({
  family: f.score.family,
  gates: evaluateGates(f.score as never),
  passes: evaluateGates(f.score as never).every((g) => g.pass),
}));

const mechanismVerdict = gatesByFamily.some((g) => g.passes)
  ? "I6_INTERVENTION_MECHANISM_WITNESSED"
  : "I6_NO_INTERVENTION_MECHANISM_WITNESSED";

// ── arm-level ledger (§60): all 33 valid runs ───────────────────────

const armLedger = lifecycles.map((l) => {
  const rows = scored.filter((s) => s.armId === l.armId);
  const dps = new Set(rows.map((r) => r.decisionPointId));
  const firingFamilies = ALL_KEYS.filter(
    (k) => k !== "I6-UNION" && rows.some((r) => r.familyKey === k && r.candidateCount > 0),
  );
  const u = rows.filter((r) => r.familyKey === "I6-UNION");
  const armValidations = arms.find((a) => a.armId === l.armId)?.validations ?? [];
  const gold = goldOf.get(l.instanceId) as GoldEvidence;
  const relevantTrustworthyRun = armValidations.some(
    (v) =>
      v.trustworthy &&
      [...gold.testPatchPaths, ...gold.failToPassPaths].some((p) => v.command.includes(p)),
  );
  return {
    armId: l.armId,
    instanceId: l.instanceId,
    repo: l.repo,
    resolved: l.resolved,
    i6Usable: l.i6Usable,
    decisionPoints: dps.size,
    familiesFiring: firingFamilies,
    naturallyMatched: u.some((r) => r.relation === "EXACT_MATCH" || r.relation === "EQUIVALENT"),
    selectionMiss: u.some((r) => r.decisionClass === "I6_VALIDATION_SELECTION_MISS"),
    relevantValidationAlreadySelected: u.some(
      (r) => r.decisionClass === "I6_RELEVANT_VALIDATION_ALREADY_SELECTED",
    ),
    validationExecutedButReasoningFailed: relevantTrustworthyRun && l.resolved === false,
    noDerivableObligation:
      u.length > 0 && u.every((r) => r.decisionClass === "I6_NO_REPOSITORY_DERIVABLE_VALIDATION_OBLIGATION"),
    validationEvidenceUnusable: u.some((r) => r.decisionClass === "VALIDATION_EVIDENCE_UNUSABLE"),
  };
});

// ── artefacts ───────────────────────────────────────────────────────

mkdirSync(outDir, { recursive: true });

writeFileSync(
  join(outDir, "stage5_m195_decision_points.jsonl"),
  `${records
    .map((r) =>
      JSON.stringify({
        decisionPointId: r.dp.decisionPointId,
        armId: r.dp.armId,
        instanceId: r.dp.instanceId,
        repo: r.dp.repo,
        sequence: r.dp.sequence,
        kind: r.dp.kind,
        diffHash: r.dp.diffHash,
        changedSourcePaths: r.evidence.changedSourcePaths,
        changedSymbols: r.evidence.changedSymbols,
        tracePrefixHash: r.prefixHash,
        derivationInputHash: r.inputHash,
        candidateSetHash: r.sightedHash,
        blindCandidateSetHash: r.blindHash,
        priorEventCount: r.evidence.priorEvents.length,
        attemptsInCreditWindow: r.windowAttempts.length,
      }),
    )
    .join("\n")}\n`,
);

writeFileSync(
  join(outDir, "stage5_m195_candidates.jsonl"),
  `${scored
    .filter((s) => s.candidateCount > 0)
    .map((s) =>
      JSON.stringify({
        decisionPointId: s.decisionPointId,
        family: s.familyKey,
        preCapCount: s.preCapCount,
        relation: s.relation,
        decisionClass: s.decisionClass,
        anyRelevant: s.anyRelevant,
        relevantCandidates: s.relevantCandidates,
        candidates: s.candidates.map((c) => ({
          path: c.path,
          node: c.node,
          specificity: c.specificity,
          rank: c.rank,
          rule: c.rule,
          evidence: c.evidence,
          command: c.command,
        })),
      }),
    )
    .join("\n")}\n`,
);

const blindness = {
  schemaVersion: "stage5.m195.blindness-replay.v1",
  control: "gold patch, reference test patch, official outcome, future events and future validation actions removed",
  decisionPoints: records.length,
  differingFingerprints: fingerprintDiffs.length,
  differing: fingerprintDiffs.map((r) => r.dp.decisionPointId),
  verdict:
    fingerprintDiffs.length === 0
      ? "DERIVATION_IS_GOLD_OUTCOME_AND_FUTURE_ACTION_BLIND"
      : "DERIVATION_LEAKS_HINDSIGHT",
  fingerprintBundleSha256: sha(
    JSON.stringify(records.map((r) => [r.dp.decisionPointId, r.inputHash, r.prefixHash, r.sightedHash])),
  ),
};

const report = {
  schemaVersion: "stage5.m195.audit.v1",
  milestone: "M195",
  preregistration: "results/stage5_m195_preregistration.md",
  maxTargets: M195_MAX_TARGETS,
  liveAgentRuns: 0,
  liveModelSpendUsd: 0,
  population: {
    arms: arms.length,
    tasks: new Set(arms.map((a) => a.instanceId)).size,
    repositories: new Set(arms.map((a) => a.repo)).size,
    decisionPoints: records.length,
    byKind: records.reduce<Record<string, number>>(
      (a, r) => ({ ...a, [r.dp.kind]: (a[r.dp.kind] ?? 0) + 1 }),
      {},
    ),
    armsWithDecisionPoints: new Set(records.map((r) => r.dp.armId)).size,
    candidateProducingPoints: records.filter((r) => r.union.candidates.length > 0).length,
    emptyPoints: records.filter((r) => r.union.candidates.length === 0).length,
  },
  blindness,
  families: familyRows,
  gates: gatesByFamily,
  mechanismVerdict,
  /**
   * §53/§55/§71. The gates were frozen before any of this was visible and are
   * reported exactly as they compute. These decompositions are the reason the
   * gate result must not be read as more than it is.
   */
  diagnostics: {
    missRelationDecomposition: ALL_KEYS.map((key) => {
      const ms = scored.filter((s) => s.familyKey === key && s.decisionClass === "I6_VALIDATION_SELECTION_MISS");
      return {
        family: key,
        specimens: ms.length,
        NO_VALIDATION: ms.filter((m) => m.relation === "NO_VALIDATION").length,
        DIFFERENT_VALIDATION: ms.filter((m) => m.relation === "DIFFERENT_VALIDATION").length,
        missTasksThatResolvedAnyway: new Set(ms.filter((m) => m.resolved === true).map((m) => m.instanceId)).size,
        missTasksUnresolved: new Set(ms.filter((m) => m.resolved === false).map((m) => m.instanceId)).size,
        missesWhereCandidateWasSelectedElsewhereInTrajectory: ms.filter((m) => m.selectedAnywhereInTrajectory).length,
        missesInArmsThatNeverStartedAnyRunner: ms.filter((m) => !m.runnerEverStartedInArm).length,
      };
    }),
    missSpecimens: scored
      .filter((s) => s.familyKey === "I6-UNION" && s.decisionClass === "I6_VALIDATION_SELECTION_MISS")
      .map((m) => ({
        decisionPointId: m.decisionPointId,
        repo: m.repo,
        resolved: m.resolved,
        relation: m.relation,
        relevantCandidates: m.relevantCandidates,
        selectedAnywhereInTrajectory: m.selectedAnywhereInTrajectory,
        runnerEverStartedInArm: m.runnerEverStartedInArm,
      })),
    unpairedBashPre: {
      note: "bash_pre events with no bash_post - the agent's selection is observed, its result is not",
      total: 23,
      arms: 14,
      handling: "selection counted; runnerStarted, semantic result and trustworthiness all false/UNKNOWN",
    },
    preCapCandidateCounts: familyRows.map((f) => ({
      family: f.score.family,
      median: f.preCapMedian,
      max: f.preCapMax,
      note: "the §8 bound truncates to 3; a large pre-cap set means the family sampled rather than selected",
    })),
    validationExecutedButReasoningFailedArms: armLedger.filter((a) => a.validationExecutedButReasoningFailed),
    resolvedArmsThatNeverStartedAnyRunner: arms.filter(
      (a) =>
        resolvedByArm.get(a.armId) === true && !a.validations.some((v) => v.started),
    ).length,
  },
  witnesses,
  armLedger,
};

writeFileSync(join(outDir, "stage5_m195_audit.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      decisionPoints: records.length,
      byKind: report.population.byKind,
      blindness: blindness.verdict,
      differingFingerprints: blindness.differingFingerprints,
      mechanismVerdict,
      families: familyRows.map((f) => ({
        family: f.score.family,
        dps: f.decisionPoints,
        firing: f.candidateProducing,
        missSpecimens: f.missSpecimens,
        missTasks: f.score.missTasks,
        missRepos: f.score.missRepos,
        witnesses: f.score.successWitnesses,
        witnessRepos: f.score.successWitnessRepos,
      })),
    },
    null,
    2,
  ),
);
