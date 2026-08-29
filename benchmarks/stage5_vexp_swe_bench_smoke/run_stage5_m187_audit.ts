// M187 — historical reclassification of M183's validation evidence.
//
// Reads the PRESERVED M183 artifacts and writes new derived artifacts. It mutates nothing
// under `runs/`: the raw logs are the evidence and M187 is only allowed to reinterpret them.
//
// Three things happen here, in this order, and the order is the point:
//
//   1. M185's own detector is RECONSTRUCTED and re-run, to establish that the corpus still
//      produces 60 / 14 / 5 / 9 (§7). Nothing downstream is trustworthy if that drifts.
//   2. The M187 model is applied to the same corpus, and every disagreement with (1) is
//      itemised. A reclassification that cannot name its movers is a rewrite of history.
//   3. Each historically prevented attempt is written out with its raw evidence, the stage it
//      stopped at, and whether the mechanism is benchmark-owned (§13, §14).
//
// A raw-output agreement control (§22) runs over every verdict: a STARTED_* classification
// must have a literal runner marker in the preserved text and an ATTEMPTED_NOT_STARTED must
// have none. Disagreement fails the script rather than being reported.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  classifyValidationExecution,
  summarizeArmValidation,
  type NotStartedCause,
  type ValidationAttemptRecord,
  type ValidationEvidence,
  type ValidationExecutionState,
} from "./validationExecution";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(REPO_ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

interface ToolCall {
  readonly index: number;
  readonly tool: string;
  readonly category: string;
  readonly command: string | null;
  readonly output: string | null;
  readonly success?: boolean | null;
  readonly exitCode?: number | null;
  readonly truncated?: boolean;
}
interface Arm {
  readonly label: string;
  readonly rawDir: string;
  readonly resolved: boolean;
}
interface Pair {
  readonly instanceId: string;
  readonly repo: string;
  readonly baseline: Arm;
  readonly treatment: Arm;
}

const pairs: Pair[] = readFileSync(path.join(RESULTS, "stage5_m183_pair_records.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Pair);

const callsOf = (rawDir: string): ToolCall[] => {
  const p = path.join(REPO_ROOT, rawDir, "_tool_calls_with_outputs.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as ToolCall[]) : [];
};

// -----------------------------------------------------------------------------------------
// 1 — M185's detector, reconstructed verbatim from run_stage5_m185_behavior.ts
// -----------------------------------------------------------------------------------------

const M185_SUITE = /\b(pytest|runtests\.py|tox|unittest|nosetests|bin\/test)\b/;
const M185_EXECUTED = /(\d+ passed|\d+ failed|PASSED|FAILED|Ran \d+ test|test session starts|^OK$)/m;
const M185_ENV_REFUSAL =
  /No module named|command not found|can't open file|No test runner found|Failed to spawn|ModuleNotFoundError/;

interface M185Row {
  readonly instanceId: string;
  readonly arm: "baseline" | "treatment";
  readonly attempts: number;
  readonly executions: number;
  readonly envRefusals: number;
}

const m185Rows: M185Row[] = [];
for (const pair of pairs) {
  for (const arm of ["baseline", "treatment"] as const) {
    const tc = callsOf(pair[arm].rawDir);
    const attempts = tc.filter((t) => t.tool === "Bash" && M185_SUITE.test(t.command ?? ""));
    m185Rows.push({
      instanceId: pair.instanceId,
      arm,
      attempts: attempts.length,
      executions: attempts.filter((t) => M185_EXECUTED.test(t.output ?? "")).length,
      envRefusals: attempts.filter(
        (t) => !M185_EXECUTED.test(t.output ?? "") && M185_ENV_REFUSAL.test(t.output ?? ""),
      ).length,
    });
  }
}

const m185 = {
  armsTotal: m185Rows.length,
  armsAttemptingSuite: m185Rows.filter((r) => r.attempts > 0).length,
  armsExecutingSuite: m185Rows.filter((r) => r.executions > 0).length,
  armsAttemptedButNeverExecuted: m185Rows.filter((r) => r.attempts > 0 && r.executions === 0).length,
  armsNeverAttempting: m185Rows.filter((r) => r.attempts === 0).length,
  attemptsTotal: m185Rows.reduce((a, r) => a + r.attempts, 0),
  attemptsExecuted: m185Rows.reduce((a, r) => a + r.executions, 0),
  attemptsRefusedByEnvironment: m185Rows.reduce((a, r) => a + r.envRefusals, 0),
};
// The attempts M185 counted but never named: neither executed nor matched by its refusal set.
const m185UnaccountedAttempts = m185.attemptsTotal - m185.attemptsExecuted - m185.attemptsRefusedByEnvironment;

const EXPECTED_M185 = {
  armsTotal: 60,
  armsAttemptingSuite: 14,
  armsExecutingSuite: 5,
  armsAttemptedButNeverExecuted: 9,
  attemptsTotal: 51,
  attemptsRefusedByEnvironment: 36,
};
const reproductionMismatches = Object.entries(EXPECTED_M185)
  .filter(([k, v]) => (m185 as Record<string, number>)[k] !== v)
  .map(([k, v]) => `${k}: expected ${v}, recomputed ${(m185 as Record<string, number>)[k]}`);
const reproductionVerdict =
  reproductionMismatches.length === 0 ? "M185_CLASSIFICATION_REPRODUCED" : "M185_CLASSIFICATION_DRIFT";

// -----------------------------------------------------------------------------------------
// 2 — the M187 model over the same corpus
// -----------------------------------------------------------------------------------------

const toEvidence = (t: ToolCall): ValidationEvidence => ({
  tool: t.tool,
  command: t.command,
  output: t.output,
  success: t.success ?? null,
  // M183's captures predate the M187 exit-code capture, so the structured field is null for
  // every one of them. Recovering it here from the preserved text is the same read the
  // capture layer now performs at write time — it is not a new inference.
  exitCode: t.exitCode ?? exitCodeFromPreservedText(t.output),
  exitCodeSource: t.exitCode !== null && t.exitCode !== undefined ? "stream_field" : "output_prefix",
  truncated: t.truncated === true,
});

function exitCodeFromPreservedText(output: string | null): number | null {
  if (output === null) return null;
  const m = /^Exit code (\d{1,3})(?:\n|$)/.exec(output);
  return m === null ? null : Number(m[1]);
}

interface ArmRow {
  readonly instanceId: string;
  readonly repo: string;
  readonly arm: "baseline" | "treatment";
  readonly state: ValidationExecutionState;
  readonly attemptCount: number;
  readonly runnerStartedCount: number;
  readonly notStartedCount: number;
  readonly unknownCount: number;
  readonly notStartedCauses: Readonly<Record<string, number>>;
  readonly attempts: readonly ValidationAttemptRecord[];
}

const rows: ArmRow[] = [];
for (const pair of pairs) {
  for (const arm of ["baseline", "treatment"] as const) {
    const summary = summarizeArmValidation(callsOf(pair[arm].rawDir).map(toEvidence));
    rows.push({ instanceId: pair.instanceId, repo: pair.repo, arm, ...summary });
  }
}

const stateCounts = (sel: (r: ArmRow) => boolean): Record<ValidationExecutionState, number> => {
  const out: Record<string, number> = {
    NOT_ATTEMPTED: 0,
    ATTEMPTED_NOT_STARTED: 0,
    STARTED_PASSED: 0,
    STARTED_FAILED: 0,
    STARTED_TIMED_OUT: 0,
    STARTED_INFRA_FAILURE: 0,
    UNKNOWN: 0,
  };
  for (const r of rows.filter(sel)) out[r.state] = (out[r.state] ?? 0) + 1;
  return out as Record<ValidationExecutionState, number>;
};

const allAttempts = rows.flatMap((r) => r.attempts);
const attemptStateCounts: Record<string, number> = {};
for (const a of allAttempts) attemptStateCounts[a.state] = (attemptStateCounts[a.state] ?? 0) + 1;

const causeCounts: Record<string, number> = {};
for (const a of allAttempts) {
  if (a.notStartedCause !== null) causeCounts[a.notStartedCause] = (causeCounts[a.notStartedCause] ?? 0) + 1;
}

// -----------------------------------------------------------------------------------------
// 2b — movers: every arm where M185 and M187 disagree
// -----------------------------------------------------------------------------------------

const m185ByArm = new Map(m185Rows.map((r) => [`${r.instanceId}|${r.arm}`, r]));
const movers = rows
  .map((r) => {
    const old = m185ByArm.get(`${r.instanceId}|${r.arm}`)!;
    const m185State =
      old.attempts === 0 ? "NOT_ATTEMPTED" : old.executions > 0 ? "EXECUTED_SUITE" : "ATTEMPTED_NOT_EXECUTED";
    const m187Family =
      r.state === "NOT_ATTEMPTED"
        ? "NOT_ATTEMPTED"
        : r.state.startsWith("STARTED_")
          ? "EXECUTED_SUITE"
          : "ATTEMPTED_NOT_EXECUTED";
    if (m185State === m187Family && old.attempts === r.attemptCount) return null;
    return {
      instanceId: r.instanceId,
      arm: r.arm,
      m185: { state: m185State, attempts: old.attempts, executions: old.executions },
      m187: { state: r.state, attempts: r.attemptCount, runnerStarted: r.runnerStartedCount },
      why:
        old.attempts !== r.attemptCount
          ? "attempt detection differs — M185 matched a bare `unittest`/`bin/test` word anywhere in a command; M187 asks the shared classifyTestFramework authority plus the repo runner scripts"
          : "execution verdict differs — M185's marker set and M187's runner-evidence rule disagree on whether a runner produced output",
    };
  })
  .filter((m): m is NonNullable<typeof m> => m !== null);

// -----------------------------------------------------------------------------------------
// 3 — the historically prevented arms, audited one by one
// -----------------------------------------------------------------------------------------

/**
 * Whether the benchmark can repair the mechanism. The judgement is about OWNERSHIP, not about
 * whether the outcome was desirable: a tool-policy refusal is correct behaviour the benchmark
 * does not own, and a missing task dependency is the repository's business, while a testbed
 * interpreter the benchmark itself removed from PATH is squarely ours.
 */
const OWNERSHIP: Record<NotStartedCause, { owner: "benchmark" | "external_tool" | "repository" | "uncertain"; note: string }> = {
  TOOL_POLICY_REFUSAL: {
    owner: "external_tool",
    note: "the agent CLI's own permission layer declined; the benchmark neither can nor should override it",
  },
  TEST_RUNNER_UNAVAILABLE: {
    owner: "benchmark",
    note: "the M90A guard stripped every conda entry from PATH and its compensating wrappers were deleted by the harness's clean-on-start, so the only interpreter left was a bare system python with no pytest",
  },
  DEPENDENCY_ENVIRONMENT_UNAVAILABLE: {
    owner: "uncertain",
    note: "same PATH collapse leaves the repo's own deps unimportable, but SWE-bench task dependency environments are not something the benchmark provisions per task; the harness-owned share is the interpreter, not the package set",
  },
  COMMAND_OR_TARGET_MISSING: {
    owner: "benchmark",
    note: "`pip`/`pip3` existed only inside the stripped conda prefix, so the wrapper's absence turned a firewalled command into a missing one",
  },
  PERMISSION_FAILURE: { owner: "uncertain", note: "no instance of this mechanism in the corpus" },
  TIMEOUT_BEFORE_RUNNER: { owner: "uncertain", note: "no instance of this mechanism in the corpus" },
  UNKNOWN_INFRASTRUCTURE_FAILURE: { owner: "uncertain", note: "unclassified" },
};

const preventedArms = rows.filter((r) => r.attemptCount > 0 && r.runnerStartedCount === 0);
const refusalAudit = preventedArms.flatMap((r) =>
  r.attempts.map((a) => ({
    instanceId: r.instanceId,
    repo: r.repo,
    arm: r.arm,
    command: a.command.replace(/\s+/g, " ").slice(0, 200),
    stoppedAtStage:
      a.notStartedCause === "TOOL_POLICY_REFUSAL"
        ? "tool policy, before the shell"
        : a.notStartedCause === "COMMAND_OR_TARGET_MISSING"
          ? "shell command resolution, before any process"
          : a.notStartedCause === "TEST_RUNNER_UNAVAILABLE"
            ? "interpreter started, test runner could not be imported"
            : a.notStartedCause === "DEPENDENCY_ENVIRONMENT_UNAVAILABLE"
              ? "interpreter started, dependency import failed before the runner"
              : "not determined",
    state: a.state,
    rootCause: a.notStartedCause ?? "UNDETERMINED",
    benchmarkOwned: a.notStartedCause === null ? "uncertain" : OWNERSHIP[a.notStartedCause].owner,
    ownershipNote: a.notStartedCause === null ? "no mechanism identified" : OWNERSHIP[a.notStartedCause].note,
    exitStatus: a.exitStatus,
    evidence: a.evidence,
  })),
);

// -----------------------------------------------------------------------------------------
// §22 — raw-output agreement control
// -----------------------------------------------------------------------------------------

const RUNNER_LITERAL = /(test session starts|collected \d+ items?|\b\d+ (passed|failed)\b|^Ran \d+ tests?|^OK$|^FAILED \()/m;
const agreementFailures: string[] = [];
for (const r of rows) {
  for (const a of r.attempts) {
    const raw = a.evidence.join("\n"); // not the source of truth; re-read the preserved text below
    void raw;
  }
}
for (const pair of pairs) {
  for (const arm of ["baseline", "treatment"] as const) {
    for (const t of callsOf(pair[arm].rawDir)) {
      const verdict = classifyValidationExecution(toEvidence(t));
      if (verdict === null) continue;
      const onScreen = RUNNER_LITERAL.test(t.output ?? "");
      if (verdict.runnerStarted === true && !onScreen) {
        agreementFailures.push(
          `${pair.instanceId}/${arm} #${t.index}: classified ${verdict.state} but the preserved output carries no runner literal`,
        );
      }
      if (verdict.state === "ATTEMPTED_NOT_STARTED" && onScreen) {
        agreementFailures.push(
          `${pair.instanceId}/${arm} #${t.index}: classified ATTEMPTED_NOT_STARTED but the preserved output carries a runner literal`,
        );
      }
    }
  }
}

// -----------------------------------------------------------------------------------------
// artifacts
// -----------------------------------------------------------------------------------------

const artifact = {
  schemaVersion: "stage5.m187.validation-reclassification.v1",
  milestone: "M187",
  note: "Derived from the preserved M183 artifacts. No file under results/runs/ was read for anything but its recorded content, and none was written.",
  m185Reproduction: {
    verdict: reproductionVerdict,
    expected: EXPECTED_M185,
    recomputed: m185,
    mismatches: reproductionMismatches,
    attemptsNeitherExecutedNorMatchedByM185RefusalSet: m185UnaccountedAttempts,
    note: "M185 published 51 attempts and 36 environment refusals against 9 executions. The remaining attempts were counted but never named by any of its three categories; the M187 model classifies all of them.",
  },
  m187ArmStates: {
    all: stateCounts(() => true),
    baseline: stateCounts((r) => r.arm === "baseline"),
    treatment: stateCounts((r) => r.arm === "treatment"),
  },
  m187AttemptStates: attemptStateCounts,
  m187NotStartedCauses: causeCounts,
  movers,
  refusalAudit,
  rawOutputAgreementControl: {
    checked: allAttempts.length,
    failures: agreementFailures,
    pass: agreementFailures.length === 0,
  },
  rows: rows.map((r) => ({
    instanceId: r.instanceId,
    repo: r.repo,
    arm: r.arm,
    state: r.state,
    attemptCount: r.attemptCount,
    runnerStartedCount: r.runnerStartedCount,
    notStartedCount: r.notStartedCount,
    unknownCount: r.unknownCount,
    notStartedCauses: r.notStartedCauses,
  })),
};

writeFileSync(
  path.join(RESULTS, "stage5_m187_validation_reclassification.json"),
  `${JSON.stringify(artifact, null, 2)}\n`,
);

console.log(`M185 reproduction: ${reproductionVerdict}`);
for (const m of reproductionMismatches) console.log(`  MISMATCH ${m}`);
console.log(`  recomputed: ${JSON.stringify(m185)}`);
console.log(`  attempts M185 counted but never named: ${m185UnaccountedAttempts}`);
console.log(`M187 arm states: ${JSON.stringify(artifact.m187ArmStates.all)}`);
console.log(`M187 attempt states: ${JSON.stringify(attemptStateCounts)}`);
console.log(`M187 not-started causes: ${JSON.stringify(causeCounts)}`);
console.log(`movers: ${movers.length}`);
console.log(
  `raw-output agreement control: ${agreementFailures.length === 0 ? "PASS" : `FAIL (${agreementFailures.length})`}`,
);
for (const f of agreementFailures.slice(0, 10)) console.log(`  ${f}`);
if (agreementFailures.length > 0 || reproductionMismatches.length > 0) process.exitCode = 1;
