/**
 * M193 — baseline-only observational acquisition: frozen classification core.
 *
 * Everything in this file is PURE and is committed BEFORE the first live agent
 * call. M194 may ingest live artifacts through it; M194 may not rewrite it in
 * response to what the live artifacts turn out to say (§53).
 *
 * The taxonomy deliberately keeps four axes apart, because every historical
 * failure in this programme came from collapsing two of them:
 *
 *   shell termination        vs  semantic test result   (M192: eval.sh exits 0
 *                                                        after a failing test)
 *   runner reached           vs  tests passed           (M191: env never started)
 *   path provenance          vs  execution provenance   (M192: a shadowing copy
 *                                                        carried the edit forward)
 *   run validity             vs  task resolution        (§40)
 */

export const M193_SCHEMA_VERSION = "stage5.m193.acquisition.v1";
export const M193_EXPERIMENT_ID = "M193-BASELINE-OBS-1";

// ── §9 task fixture selection ───────────────────────────────────────

export interface DatasetRow {
  instance_id: string;
  repo: string;
  base_commit: string;
  environment_setup_commit?: string;
  version?: string;
}

export interface FixtureEntry {
  ordinal: number;
  instanceId: string;
  repo: string;
  baseCommit: string;
  environmentSetupCommit: string | null;
  version: string | null;
  /** 1-based rank of this instance within its repository, lexicographic. */
  stratumRank: number;
  instanceImageKey: string;
}

/** swebench 4.1.0 instance image naming (`sweb.eval.<arch>.<owner>_1776_<name>`). */
export function instanceImageKey(instanceId: string, arch = "x86_64"): string {
  const key = instanceId.replace("__", "_1776_").toLowerCase();
  return `swebench/sweb.eval.${arch}.${key}:latest`;
}

/**
 * Stratified round-robin over repositories.
 *
 * Repositories sorted lexicographically; instances sorted lexicographically
 * within a repository; emitted rank-1-of-every-repo, then rank-2-of-every-repo,
 * and so on. This maximises repository breadth at every prefix length, so a
 * truncated acquisition is still cross-repository, and it gives §32 a single
 * deterministic "next instance" with no analyst discretion.
 *
 * Blind to: gold patch topology, FAIL_TO_PASS size, historical outcomes, prior
 * milestone attention, Docker image presence.
 */
export function selectFixture(rows: DatasetRow[], maxArms: number): FixtureEntry[] {
  const byRepo = new Map<string, DatasetRow[]>();
  for (const r of rows) {
    const list = byRepo.get(r.repo) ?? [];
    list.push(r);
    byRepo.set(r.repo, list);
  }
  const repos = [...byRepo.keys()].sort();
  for (const repo of repos) {
    byRepo.get(repo)!.sort((a, b) => (a.instance_id < b.instance_id ? -1 : a.instance_id > b.instance_id ? 1 : 0));
  }

  const out: FixtureEntry[] = [];
  const deepest = Math.max(0, ...repos.map((r) => byRepo.get(r)!.length));
  for (let rank = 0; rank < deepest && out.length < maxArms; rank++) {
    for (const repo of repos) {
      if (out.length >= maxArms) break;
      const row = byRepo.get(repo)![rank];
      if (!row) continue;
      out.push({
        ordinal: out.length + 1,
        instanceId: row.instance_id,
        repo: row.repo,
        baseCommit: row.base_commit,
        environmentSetupCommit: row.environment_setup_commit ?? null,
        version: row.version ?? null,
        stratumRank: rank + 1,
        instanceImageKey: instanceImageKey(row.instance_id),
      });
    }
  }
  return out;
}

// ── §22 shell termination vs semantic test result ───────────────────

export interface ShellTermination {
  processStarted: boolean;
  /** Verbatim. Never invented: a timed-out command has `null`, not 124. */
  exitCode: number | null;
  timedOut: boolean;
  signal: string | null;
  durationMs: number;
}

export type SemanticTestResult =
  | "PASSED"
  | "FAILED"
  | "MIXED"
  | "NO_TESTS_RAN"
  | "UNKNOWN";

export interface StreamCapture {
  /** Raw, separated, verbatim (§23). */
  stdout: string;
  stderr: string;
  /** In-container ordered tee of both, when the tee completed (§23). */
  mergedStream: string | null;
  mergedStreamComplete: boolean;
}

/**
 * The text every classifier reads.
 *
 * M192 found the runner markers surfacing on stderr while results went to
 * stdout. A classifier that reads `stdout` alone makes a whole test execution
 * disappear, so classification is only ever performed over the union. The
 * merged stream is preferred when the container's tee completed, because it
 * preserves interleaving; otherwise the two raw streams are concatenated, which
 * loses ordering but never loses content.
 */
export function classificationText(c: StreamCapture): string {
  if (c.mergedStreamComplete && c.mergedStream !== null) return c.mergedStream;
  return `${c.stdout}\n${c.stderr}`;
}

const RUNNER_BANNERS = [
  /^=+ test session starts =+$/m,
  /^collected \d+ items?/m,
  /^collecting \.\.\./m,
  /^Ran \d+ tests? in /m,               // unittest
  /^=+ (FAILURES|ERRORS|short test summary info) =+$/m,
  />>>>> Start Test Output/,            // swebench's own eval.sh markers
];

/**
 * A pytest counts summary, decorated or not.
 *
 * `pytest -q --no-header` prints `1 passed, 1 warning in 0.02s` with no `=`
 * decoration and no session-start banner at all. An earlier version of this
 * classifier required the decoration and reported three of the five dry-run
 * repositories as UNKNOWN while their tests had plainly run — the same class of
 * defect §23 warns about, arriving through terseness instead of through stream
 * separation. Quiet mode is a completely ordinary thing for an agent to use, so
 * the summary is matched structurally: an optional `=` frame, a counts body, and
 * a duration.
 */
const UNITTEST_TAIL = /^(OK|FAILED)(?:\s*\(.*\))?\s*$/m;

const SUMMARY_LINE = /^=*\s*(.*?)\s+(?:in|at)\s+[\d.]+m?s(?:\s|=|$).*$/;

interface SummaryCounts {
  passed: number;
  failed: number;
  errored: number;
  noTests: boolean;
  sawSummary: boolean;
}

function scanSummaries(text: string): SummaryCounts {
  const out: SummaryCounts = { passed: 0, failed: 0, errored: 0, noTests: false, sawSummary: false };
  for (const raw of text.split("\n")) {
    const m = SUMMARY_LINE.exec(raw.replace(/=+\s*$/, "").trimEnd());
    if (!m) continue;
    const body = m[1] ?? "";
    if (/no tests ran/i.test(body)) {
      out.noTests = true;
      out.sawSummary = true;
      continue;
    }
    // Require at least one "<n> <word>" pair, so prose lines that happen to
    // contain "in 1.0s" cannot be read as a test result.
    if (!/\d+ [a-z]+/.test(body)) continue;
    out.sawSummary = true;
    const f = /(\d+) failed/.exec(body);
    const p = /(\d+) passed/.exec(body);
    const e = /(\d+) errors?/.exec(body);
    if (f) out.failed += Number(f[1]);
    if (p) out.passed += Number(p[1]);
    if (e) out.errored += Number(e[1]);
  }
  return out;
}

/** Did a *test runner* actually start, as distinct from the shell succeeding? */
export function runnerStarted(c: StreamCapture): boolean {
  const text = classificationText(c);
  if (RUNNER_BANNERS.some((re) => re.test(text))) return true;
  // A counts summary is itself proof the runner ran, and under `-q --no-header`
  // it is the only proof there is.
  return scanSummaries(text).sawSummary;
}

/**
 * Semantic result, read from the runner's own summary only.
 *
 * Never derived from the exit code (§22). When no recognisable summary is
 * present the answer is UNKNOWN, which downstream makes the episode unusable
 * rather than silently counting as a pass.
 */
export function semanticTestResult(c: StreamCapture): SemanticTestResult {
  const text = classificationText(c);
  if (!runnerStarted(c)) return "UNKNOWN";

  const s = scanSummaries(text);
  let { passed, failed, errored } = s;
  let noTests = s.noTests;
  let sawSummary = s.sawSummary;

  // unittest. `Ran 0 tests ... OK` is a vacuous pass and must not be credited
  // as one, so the ran-count is read BEFORE the OK/FAILED verdict.
  const ran = /^Ran (\d+) tests? in /m.exec(text);
  const ranZero = ran !== null && Number(ran[1]) === 0;
  if (ranZero) {
    noTests = true;
    sawSummary = true;
  }
  const ut = UNITTEST_TAIL.exec(text);
  if (ut && !ranZero) {
    sawSummary = true;
    if (ut[1] === "OK") passed += 1;
    else failed += 1;
  }

  if (!sawSummary) return "UNKNOWN";
  if (noTests && failed === 0 && errored === 0 && passed === 0) return "NO_TESTS_RAN";
  if (failed + errored > 0 && passed > 0) return "MIXED";
  if (failed + errored > 0) return "FAILED";
  if (passed > 0) return "PASSED";
  return "UNKNOWN";
}

// ── §20 per-validation source provenance ────────────────────────────

export type ProvenanceState =
  | "EDITED_CHECKOUT_CONFIRMED"
  | "INSTALLED_COPY_CONFIRMED"
  | "AMBIGUOUS_SOURCE"
  | "RUNNER_NOT_STARTED"
  | "NOT_APPLICABLE";

/**
 * From M192's preflight: how robustly the checkout wins the import.
 * `CWD_DEPENDENT` is psf/requests — correct only while something pins the cwd.
 */
export type ProvenanceRobustness = "EDITABLE_INSTALL" | "CWD_DEPENDENT" | "UNKNOWN";

export interface ValidationProvenanceEvidence {
  /** Was this command classified as a validation attempt at all? */
  isValidationAttempt: boolean;
  runnerStarted: boolean;
  /** Workdir the command actually ran in, as reported by the adapter. */
  workdir: string;
  checkoutRoot: string;
  /** `<pkg>.__file__` measured out-of-band in the same container + workdir,
   *  immediately after the command. Invisible to the agent (§45). */
  moduleFile: string | null;
  /** Established once per instance by the model-free preflight. */
  robustness: ProvenanceRobustness;
}

const INSTALLED_ROOTS = ["site-packages", "dist-packages", "/opt/miniconda3/lib", "/usr/lib/python"];

/**
 * Fails closed. The only route to EDITED_CHECKOUT_CONFIRMED is a module path
 * under the checkout root *plus* a reason to believe the checkout would have
 * won regardless of luck: either the install is genuinely editable, or the
 * command demonstrably ran with the workdir pinned to the checkout root.
 */
export function classifyValidationProvenance(ev: ValidationProvenanceEvidence): ProvenanceState {
  if (!ev.isValidationAttempt) return "NOT_APPLICABLE";
  if (!ev.runnerStarted) return "RUNNER_NOT_STARTED";
  if (ev.moduleFile === null) return "AMBIGUOUS_SOURCE";

  const underCheckout = ev.moduleFile.startsWith(`${ev.checkoutRoot}/`);
  const underInstalled = INSTALLED_ROOTS.some((r) => ev.moduleFile!.includes(r));
  if (underCheckout && underInstalled) return "AMBIGUOUS_SOURCE";
  if (underInstalled) return "INSTALLED_COPY_CONFIRMED";
  if (!underCheckout) return "AMBIGUOUS_SOURCE";

  if (ev.robustness === "EDITABLE_INSTALL") return "EDITED_CHECKOUT_CONFIRMED";
  if (ev.robustness === "CWD_DEPENDENT") {
    // M192's psf/requests: correct only because the runner happened to cd first.
    return ev.workdir === ev.checkoutRoot ? "EDITED_CHECKOUT_CONFIRMED" : "AMBIGUOUS_SOURCE";
  }
  return "AMBIGUOUS_SOURCE";
}

/** §20: these two can never be read as an ordinary test result. */
export function provenanceIsUsable(p: ProvenanceState): boolean {
  return p === "EDITED_CHECKOUT_CONFIRMED";
}

// ── §19 ordered trace + §18 diff snapshots ──────────────────────────

export type PatchBoundary =
  | "SETUP"
  | "AFTER_EDIT"
  | "BEFORE_VALIDATION"
  | "AFTER_VALIDATION"
  | "BEFORE_SUBMIT";

export interface PatchSnapshot {
  ordinal: number;
  boundary: PatchBoundary;
  /** sha256 of the normalised diff (see normalizePatch). */
  diffHash: string;
  diffBytes: number;
  /** Full patch where storage permits (§18). */
  patch?: string;
}

export type TraceEventType =
  | "agent_start"
  | "tool_call"
  | "patch_snapshot"
  | "assistant_text"
  | "agent_end";

export interface ValidationRecord {
  isValidationAttempt: boolean;
  workdir: string;
  routedTo: "container" | "host";
  shell: ShellTermination;
  streams: StreamCapture;
  runnerStarted: boolean;
  semanticTestResult: SemanticTestResult;
  provenance: ProvenanceState;
  moduleFile: string | null;
}

export interface TraceEvent {
  /** Dense, strictly increasing from 0. Analysts must never re-derive order
   *  from interleaved log strings (§19). */
  ordinal: number;
  ts: string;
  type: TraceEventType;
  toolName?: string;
  toolInput?: unknown;
  /** Diff hash of the working tree as of this event. */
  stateHash: string | null;
  validation?: ValidationRecord;
  snapshot?: PatchSnapshot;
}

/** §19: a DecisionPointEvidence is a trace prefix and nothing later. */
export function tracePrefix(events: TraceEvent[], throughOrdinal: number): TraceEvent[] {
  return events.filter((e) => e.ordinal <= throughOrdinal);
}

export function traceOrderingIsWellFormed(events: TraceEvent[]): boolean {
  return events.every((e, i) => e.ordinal === i) && events.every((e) => typeof e.ts === "string" && e.ts.length > 0);
}

// ── §28 patch normalisation (frozen before comparison) ──────────────

/**
 * The single normalisation under which the three patch hashes must agree.
 *
 * Only blob-id metadata is dropped, because git regenerates `index` lines and
 * the evaluator's git is not our git. Content, line endings after CRLF folding,
 * modes, and hunk geometry are all compared byte-exactly.
 */
export function normalizePatch(patch: string): string {
  const lf = patch.replace(/\r\n/g, "\n");
  const kept = lf
    .split("\n")
    .filter((line) => !/^index [0-9a-f]{4,}\.\.[0-9a-f]{4,}(?: \d{6})?$/.test(line));
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
}

export interface PatchIdentityInputs {
  interactiveFinalDiff: string;
  extractedPredictionPatch: string;
  evaluatorAppliedPatch: string | null;
}

export type PatchIdentityVerdict =
  | "IDENTICAL_STRICT"
  | "IDENTICAL_NORMALIZED"
  | "EVALUATOR_PATCH_UNAVAILABLE"
  | "MISMATCH";

export function comparePatchIdentity(i: PatchIdentityInputs): {
  verdict: PatchIdentityVerdict;
  interactiveVsExtractedStrict: boolean;
  interactiveVsExtractedNormalized: boolean;
  extractedVsEvaluatorStrict: boolean;
  extractedVsEvaluatorNormalized: boolean;
} {
  const nA = normalizePatch(i.interactiveFinalDiff);
  const nB = normalizePatch(i.extractedPredictionPatch);
  const nC = i.evaluatorAppliedPatch === null ? null : normalizePatch(i.evaluatorAppliedPatch);

  const abStrict = i.interactiveFinalDiff === i.extractedPredictionPatch;
  const abNorm = nA === nB;
  const bcStrict = nC === null ? false : i.extractedPredictionPatch === i.evaluatorAppliedPatch;
  const bcNorm = nC === null ? false : nB === nC;

  let verdict: PatchIdentityVerdict;
  if (!abNorm) verdict = "MISMATCH";
  else if (nC === null) verdict = "EVALUATOR_PATCH_UNAVAILABLE";
  else if (!bcNorm) verdict = "MISMATCH";
  else if (abStrict && bcStrict) verdict = "IDENTICAL_STRICT";
  else verdict = "IDENTICAL_NORMALIZED";

  return {
    verdict,
    interactiveVsExtractedStrict: abStrict,
    interactiveVsExtractedNormalized: abNorm,
    extractedVsEvaluatorStrict: bcStrict,
    extractedVsEvaluatorNormalized: bcNorm,
  };
}

// ── §38 resource / infrastructure failure semantics ─────────────────

export type ExclusionCategory =
  | "PREFLIGHT_FAILED"
  | "MODEL_SERVICE_FAILURE"
  | "CONTAINER_INFRA_FAILURE"
  | "TELEMETRY_CORRUPT"
  | "PATCH_EXTRACTION_FAILURE"
  | "EVALUATOR_INFRA_FAILURE"
  | "TREATMENT_CONTAMINATION";

/** §49: frozen now, and every excluded arm stays visible in the ledger. */
export const M193_EXCLUSION_CATEGORIES: readonly ExclusionCategory[] = Object.freeze([
  "PREFLIGHT_FAILED",
  "MODEL_SERVICE_FAILURE",
  "CONTAINER_INFRA_FAILURE",
  "TELEMETRY_CORRUPT",
  "PATCH_EXTRACTION_FAILURE",
  "EVALUATOR_INFRA_FAILURE",
  "TREATMENT_CONTAMINATION",
]);

/** §41: only these may be rerun, at most once, and both attempts stay in the ledger. */
export const M193_RERUNNABLE: readonly ExclusionCategory[] = Object.freeze([
  "MODEL_SERVICE_FAILURE",
  "CONTAINER_INFRA_FAILURE",
  "EVALUATOR_INFRA_FAILURE",
  "TELEMETRY_CORRUPT",
]);

export function isRerunnable(c: ExclusionCategory): boolean {
  return M193_RERUNNABLE.includes(c);
}

/**
 * §38: infrastructure outcomes are experiment outcomes, never coding failure.
 * Agent-side exhaustion (turns, cost cap, timeout) is NOT infrastructure — it
 * is the preregistered limit doing its job, and it is not rerunnable.
 */
export type AgentTermination =
  | "COMPLETED"
  | "TURN_LIMIT_REACHED"
  | "COST_CAP_REACHED"
  | "AGENT_TIMEOUT"
  | "MODEL_SERVICE_FAILURE"
  | "HARNESS_CRASH";

export function terminationIsInfrastructure(t: AgentTermination): boolean {
  return t === "MODEL_SERVICE_FAILURE" || t === "HARNESS_CRASH";
}

// ── §39 run validity ────────────────────────────────────────────────

export interface ArmOutcome {
  armId: string;
  instanceId: string;
  repo: string;
  /** Preflight verdict for the exact instance this arm ran. */
  preflightPassed: boolean;
  agentStarted: boolean;
  termination: AgentTermination;
  /** Was there exactly one authoritative mutable checkout for the whole run? */
  authoritativeCheckoutMaintained: boolean;
  /** §33/§34 startup audit said the condition was untreated. */
  treatmentAbsenceVerified: boolean;
  telemetryComplete: boolean;
  traceWellFormed: boolean;
  /** A truthful empty patch is valid; a failure to extract is not (§39). */
  finalPatchExtracted: boolean;
  finalPatchIsEmpty: boolean;
  evaluatorRan: boolean;
  /** Separate from validity (§40). */
  resolved: boolean | null;
  events: TraceEvent[];
  snapshots: PatchSnapshot[];
}

export type RunValidity = "RUN_VALID" | "RUN_INVALID";

export function classifyRunValidity(a: ArmOutcome): { validity: RunValidity; reasons: string[] } {
  const reasons: string[] = [];
  if (!a.preflightPassed) reasons.push("PREFLIGHT_FAILED");
  if (!a.agentStarted) reasons.push("AGENT_NOT_STARTED");
  if (!a.authoritativeCheckoutMaintained) reasons.push("CHECKOUT_AUTHORITY_LOST");
  if (!a.treatmentAbsenceVerified) reasons.push("TREATMENT_CONTAMINATION");
  if (!a.telemetryComplete) reasons.push("TELEMETRY_INCOMPLETE");
  if (!a.traceWellFormed) reasons.push("TRACE_ORDERING_CORRUPT");
  if (!a.finalPatchExtracted) reasons.push("PATCH_EXTRACTION_FAILURE");
  if (!a.evaluatorRan) reasons.push("EVALUATOR_DID_NOT_RUN");
  if (terminationIsInfrastructure(a.termination)) reasons.push(a.termination);
  // NOT reasons: no validation attempt, empty patch, unresolved task, turn or
  // cost exhaustion. The agent is allowed to choose not to test (§39).
  return { validity: reasons.length === 0 ? "RUN_VALID" : "RUN_INVALID", reasons };
}

// ── §42–§44 lifecycle usability labels ──────────────────────────────

export interface ArmLifecycle {
  armId: string;
  instanceId: string;
  repo: string;
  validity: RunValidity;
  invalidReasons: string[];
  hasSourceEdit: boolean;
  postEditValidationAttempts: number;
  runnerStarts: number;
  usableValidationEvents: number;
  validationPasses: number;
  validationFailures: number;
  postValidationRevisions: number;
  validationCycles: number;
  wrongSourceEvents: number;
  ambiguousSourceEvents: number;
  i6Usable: boolean;
  i6UnusableReason: string | null;
  runtimeDiagnosisUsable: boolean;
  resolved: boolean | null;
}

/** Ordinal of the first snapshot recorded after an edit. */
function firstEditOrdinal(a: ArmOutcome): number | null {
  const s = a.snapshots.find((x) => x.boundary === "AFTER_EDIT");
  return s ? s.ordinal : null;
}

export function classifyArmLifecycle(a: ArmOutcome): ArmLifecycle {
  const { validity, reasons } = classifyRunValidity(a);

  const editOrd = firstEditOrdinal(a);
  const hasSourceEdit = editOrd !== null;

  const validationEvents = a.events.filter((e) => e.validation?.isValidationAttempt === true);
  const postEdit = validationEvents.filter((e) => editOrd !== null && e.ordinal > editOrd);

  const runnerStarts = postEdit.filter((e) => e.validation!.runnerStarted).length;
  const usable = postEdit.filter(
    (e) =>
      provenanceIsUsable(e.validation!.provenance) &&
      e.validation!.semanticTestResult !== "UNKNOWN",
  );
  const passes = usable.filter((e) => e.validation!.semanticTestResult === "PASSED").length;
  const failures = usable.filter(
    (e) => e.validation!.semanticTestResult === "FAILED" || e.validation!.semanticTestResult === "MIXED",
  ).length;

  const wrongSource = postEdit.filter((e) => e.validation!.provenance === "INSTALLED_COPY_CONFIRMED").length;
  const ambiguous = postEdit.filter((e) => e.validation!.provenance === "AMBIGUOUS_SOURCE").length;

  // A revision is an AFTER_EDIT snapshot whose diff hash differs from the
  // snapshot standing at the last validation, and which occurs after it.
  let postValidationRevisions = 0;
  for (const v of usable) {
    const before = [...a.snapshots].filter((s) => s.ordinal < v.ordinal).pop();
    const after = a.snapshots.find((s) => s.ordinal > v.ordinal && s.boundary === "AFTER_EDIT");
    if (before && after && after.diffHash !== before.diffHash) postValidationRevisions++;
  }

  let i6UnusableReason: string | null = null;
  if (validity !== "RUN_VALID") i6UnusableReason = "RUN_INVALID";
  else if (!hasSourceEdit) i6UnusableReason = "NO_SOURCE_EDIT";
  else if (postEdit.length === 0) i6UnusableReason = "NO_POST_EDIT_VALIDATION_ATTEMPT";
  else if (usable.length === 0) i6UnusableReason = "NO_TRUSTWORTHY_VALIDATION_RESULT";
  else if (!traceOrderingIsWellFormed(a.events)) i6UnusableReason = "TRACE_ORDERING_CORRUPT";

  const i6Usable = i6UnusableReason === null;

  // §44 — a corpus capability label only; no hypothesis is being tested here.
  const failingUsable = usable.filter(
    (e) => e.validation!.semanticTestResult === "FAILED" || e.validation!.semanticTestResult === "MIXED",
  );
  const runtimeDiagnosisUsable =
    validity === "RUN_VALID" &&
    hasSourceEdit &&
    failingUsable.length > 0 &&
    failingUsable.some((e) => {
      const cap = e.validation!.streams;
      const text = classificationText(cap);
      const stateKnown = a.snapshots.some((s) => s.ordinal < e.ordinal);
      const laterDecisionObservable = a.events.some((x) => x.ordinal > e.ordinal);
      return text.length > 0 && stateKnown && laterDecisionObservable;
    });

  return {
    armId: a.armId,
    instanceId: a.instanceId,
    repo: a.repo,
    validity,
    invalidReasons: reasons,
    hasSourceEdit,
    postEditValidationAttempts: postEdit.length,
    runnerStarts,
    usableValidationEvents: usable.length,
    validationPasses: passes,
    validationFailures: failures,
    postValidationRevisions,
    validationCycles: usable.length,
    wrongSourceEvents: wrongSource,
    ambiguousSourceEvents: ambiguous,
    i6Usable,
    i6UnusableReason,
    runtimeDiagnosisUsable,
    resolved: a.resolved,
  };
}

// ── §50 corpus accounting + §14 adequacy ────────────────────────────

export interface CorpusAccounting {
  armsAttempted: number;
  validRuns: number;
  invalidRuns: number;
  invalidByCategory: Record<string, number>;
  runsWithEdit: number;
  postEditValidationAttempts: number;
  runnerStarts: number;
  validationPasses: number;
  validationFailures: number;
  postValidationRevisions: number;
  multipleValidationCycleArms: number;
  i6UsableArms: number;
  runtimeDiagnosisUsableArms: number;
  validButI6UnusableArms: number;
  repositoriesRepresented: number;
  repositoriesAmongI6Usable: number;
  wrongSourceEvents: number;
  ambiguousSourceEvents: number;
  spendUsd: number;
  resolvedCount: number;
}

export function accountCorpus(lifecycles: ArmLifecycle[], spendUsd: number): CorpusAccounting {
  const invalidByCategory: Record<string, number> = {};
  for (const l of lifecycles) {
    if (l.validity === "RUN_INVALID") {
      for (const r of l.invalidReasons) invalidByCategory[r] = (invalidByCategory[r] ?? 0) + 1;
    }
  }
  const valid = lifecycles.filter((l) => l.validity === "RUN_VALID");
  return {
    armsAttempted: lifecycles.length,
    validRuns: valid.length,
    invalidRuns: lifecycles.length - valid.length,
    invalidByCategory,
    runsWithEdit: valid.filter((l) => l.hasSourceEdit).length,
    postEditValidationAttempts: valid.reduce((n, l) => n + l.postEditValidationAttempts, 0),
    runnerStarts: valid.reduce((n, l) => n + l.runnerStarts, 0),
    validationPasses: valid.reduce((n, l) => n + l.validationPasses, 0),
    validationFailures: valid.reduce((n, l) => n + l.validationFailures, 0),
    postValidationRevisions: valid.reduce((n, l) => n + l.postValidationRevisions, 0),
    multipleValidationCycleArms: valid.filter((l) => l.validationCycles >= 2).length,
    i6UsableArms: lifecycles.filter((l) => l.i6Usable).length,
    runtimeDiagnosisUsableArms: lifecycles.filter((l) => l.runtimeDiagnosisUsable).length,
    validButI6UnusableArms: valid.filter((l) => !l.i6Usable).length,
    repositoriesRepresented: new Set(lifecycles.map((l) => l.repo)).size,
    repositoriesAmongI6Usable: new Set(lifecycles.filter((l) => l.i6Usable).map((l) => l.repo)).size,
    wrongSourceEvents: lifecycles.reduce((n, l) => n + l.wrongSourceEvents, 0),
    ambiguousSourceEvents: lifecycles.reduce((n, l) => n + l.ambiguousSourceEvents, 0),
    spendUsd,
    resolvedCount: lifecycles.filter((l) => l.resolved === true).length,
  };
}

/** §14 — frozen thresholds. Deliberately expressed in lifecycle events, never
 *  in pass rate. */
export const M193_ADEQUACY = Object.freeze({
  adequate: { i6UsableArms: 12, repositoriesAmongI6Usable: 6, validRuns: 30 },
  partial: { i6UsableArms: 6, repositoriesAmongI6Usable: 4, validRuns: 15 },
});

export type CorpusAdequacy = "ADEQUATE" | "PARTIAL" | "INADEQUATE";

export function assessAdequacy(c: CorpusAccounting): CorpusAdequacy {
  const a = M193_ADEQUACY.adequate;
  const p = M193_ADEQUACY.partial;
  if (c.i6UsableArms >= a.i6UsableArms && c.repositoriesAmongI6Usable >= a.repositoriesAmongI6Usable && c.validRuns >= a.validRuns) {
    return "ADEQUATE";
  }
  if (c.i6UsableArms >= p.i6UsableArms && c.repositoriesAmongI6Usable >= p.repositoriesAmongI6Usable && c.validRuns >= p.validRuns) {
    return "PARTIAL";
  }
  return "INADEQUATE";
}

// ── §13 sequential stopping rule ────────────────────────────────────

export const M193_LIMITS = Object.freeze({
  minArms: 20,
  maxArms: 40,
  perRunCostCapUsd: 3.5,
  totalSpendCapUsd: 90,
  maxConcurrentArms: 3,
  maxPreflightReplacements: 15,
  targetI6UsableArms: 12,
  targetRepositoriesAmongI6Usable: 6,
});

export type StopDecision = "CONTINUE" | "STOP_TARGET_MET" | "STOP_MAX_ARMS" | "STOP_SPEND_CAP";

export interface StopState {
  armsLaunched: number;
  spendUsd: number;
  i6UsableArms: number;
  repositoriesAmongI6Usable: number;
}

/**
 * Depends only on observability and budget (§48). It cannot see resolution,
 * whether I6 looks promising, or whether a preferred mechanism appeared.
 */
export function stopDecision(s: StopState): StopDecision {
  if (s.spendUsd >= M193_LIMITS.totalSpendCapUsd) return "STOP_SPEND_CAP";
  if (s.armsLaunched >= M193_LIMITS.maxArms) return "STOP_MAX_ARMS";
  if (s.armsLaunched < M193_LIMITS.minArms) return "CONTINUE";
  if (
    s.i6UsableArms >= M193_LIMITS.targetI6UsableArms &&
    s.repositoriesAmongI6Usable >= M193_LIMITS.targetRepositoriesAmongI6Usable
  ) {
    return "STOP_TARGET_MET";
  }
  return "CONTINUE";
}

// ── §25 command-routing scope ───────────────────────────────────────

/**
 * Frozen: EVERY agent Bash command executes inside the instance container with
 * the workdir pinned to the checkout root.
 *
 * §25 warns against an ambiguous hybrid, and a hybrid is exactly what a
 * command classifier would produce: `pwd` would answer about the host while
 * `pytest` answered about the container, and the agent would be reasoning about
 * two different filesystems. Because the checkout is one bind-mounted tree
 * visible at the same path from both sides, routing everything is both simpler
 * and semantically total.
 */
export const M193_ROUTING = Object.freeze({
  policy: "ALL_BASH_IN_CONTAINER",
  hostExecuted: [] as string[],
  containerExecuted: ["*"],
  workdirPolicy: "PINNED_TO_CHECKOUT_ROOT",
  checkoutRoot: "/testbed",
});

/**
 * §21 — the workdir contract. `docker exec` inherits the image's WORKDIR if none
 * is supplied, which is how psf/requests would silently resolve an installed
 * copy. The adapter must always pass one explicitly.
 */
export function workdirIsPinned(workdir: string | null | undefined, checkoutRoot: string): boolean {
  return workdir === checkoutRoot;
}
