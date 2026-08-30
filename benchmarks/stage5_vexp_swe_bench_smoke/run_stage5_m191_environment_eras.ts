// M191 §6 — separating the telemetry repair from the execution-environment repair, and
// attributing the validation collapse M189 reported as an "environment era".
//
// M189 reported runner starts by calendar month — 206/857 in June, 0/97 in July, 10/339 in
// August — and called it environment-era dependence. A month is not a mechanism. This script
// replaces the calendar with the exposure variable the arms recorded about THEMSELVES:
//
//     _run.meta.json  ->  stage5_agent_shell_guard_enabled
//
// The M90A agent shell guard stripped conda from PATH and pointed PATH's head at a wrapper
// directory that the external harness then deleted on start-up (M187 §4). Every arm that ran
// under it inherited a bare system interpreter with no pip. If that is what ended validation,
// the collapse should track the per-arm flag, not the date — and the direct wipe signature,
// `Cleaned N file(s) from .../raw/<condition>/`, should be present in exactly those arms'
// preserved stdout.
//
// Reads preserved artifacts only. No agent, no Docker, no live spend, nothing mutated.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { summarizeArmValidation, type ValidationEvidence } from "./validationExecution";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(REPO_ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const RUNS = path.join(RESULTS, "runs");

/** The wipe signature, verbatim from the external harness's start-up banner. */
const WIPE_RE = /Cleaned (\d+) file\(s\) from (\S+)/u;

interface RawCall {
  readonly index: number;
  readonly tool: string;
  readonly command?: string | null;
  readonly output?: string | null;
  readonly success?: boolean | null;
  readonly exitCode?: number | null;
  readonly exitCodeSource?: "stream_field" | "output_prefix" | null;
  readonly truncated?: boolean;
  readonly args?: Record<string, unknown>;
}

type Epoch = "PRE_GUARD" | "GUARD_UNREPAIRED" | "GUARD_REPAIRED" | "UNRECORDED";

interface ArmRow {
  readonly runLabel: string;
  readonly condition: string;
  readonly month: string;
  readonly instanceId: string;
  readonly shellGuardEnabled: boolean | null;
  readonly epoch: Epoch;
  readonly wipedHarnessOutputDir: boolean;
  readonly wipedPath: string | null;
  readonly attempts: number;
  readonly runnerStarts: number;
  readonly resultsObserved: number;
  readonly interpreterSymptom: boolean;
}

/**
 * The mechanical consequence M187 traced: with the wrappers deleted and conda stripped, `pip`
 * is not on PATH at all and `python` is the bare system interpreter. Either shows up verbatim.
 */
function interpreterSymptom(calls: readonly RawCall[]): boolean {
  return calls.some((c) => {
    const out = c.output ?? "";
    return /\bpip3?: command not found\b/u.test(out) || /No module named 'pip'/u.test(out);
  });
}

const arms: ArmRow[] = [];

for (const runLabel of existsSync(RUNS) ? readdirSync(RUNS).sort() : []) {
  const rawRoot = path.join(RUNS, runLabel, "raw");
  if (!existsSync(rawRoot)) continue;
  for (const condition of readdirSync(rawRoot).sort()) {
    const rawDir = path.join(rawRoot, condition);
    if (!existsSync(path.join(rawDir, "_tool_calls.json"))) continue;
    const resultFile = readdirSync(rawDir).find((f) => /^swebench-.*\.jsonl$/u.test(f));
    if (resultFile === undefined) continue;

    let row: Record<string, unknown>;
    try {
      const first = readFileSync(path.join(rawDir, resultFile), "utf8").split("\n").find((l) => l.trim());
      if (first === undefined) continue;
      row = JSON.parse(first) as Record<string, unknown>;
    } catch { continue; }
    const instanceId = typeof row.instanceId === "string" ? row.instanceId : null;
    if (instanceId === null) continue;

    let meta: Record<string, unknown> = {};
    const metaPath = path.join(rawDir, "_run.meta.json");
    if (existsSync(metaPath)) {
      try { meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>; } catch { meta = {}; }
    }
    const guardEnabled = typeof meta.stage5_agent_shell_guard_enabled === "boolean"
      ? meta.stage5_agent_shell_guard_enabled
      : null;
    // Post-M187 runs record whether the firewall was still alive when the run ended. Its
    // presence is what distinguishes a repaired arm from an unrepaired one.
    const survivalRecorded = Object.prototype.hasOwnProperty.call(meta, "stage5_agent_shell_guard_wrapper_bin_survived_run");

    let wiped = false;
    let wipedPath: string | null = null;
    const stdoutPath = path.join(rawDir, "_run.stdout.txt");
    if (existsSync(stdoutPath)) {
      try {
        const m = WIPE_RE.exec(readFileSync(stdoutPath, "utf8"));
        if (m !== null) { wipedPath = m[2]; wiped = m[2].includes(`/raw/${condition}`); }
      } catch { /* unreadable stdout is recorded as no signature, not as a wipe */ }
    }

    let calls: RawCall[] = [];
    const woPath = path.join(rawDir, "_tool_calls_with_outputs.json");
    if (existsSync(woPath)) {
      try { calls = JSON.parse(readFileSync(woPath, "utf8")) as RawCall[]; } catch { calls = []; }
    }
    const evidence: ValidationEvidence[] = calls.map((c) => ({
      tool: c.tool,
      command: c.command ?? (typeof c.args?.command === "string" ? c.args.command : null),
      output: c.output ?? null,
      success: c.success ?? null,
      exitCode: c.exitCode ?? null,
      exitCodeSource: c.exitCodeSource ?? null,
      truncated: c.truncated,
    }));
    const v = summarizeArmValidation(evidence);

    const epoch: Epoch =
      guardEnabled === null ? "UNRECORDED"
        : guardEnabled === false ? "PRE_GUARD"
          : survivalRecorded ? "GUARD_REPAIRED" : "GUARD_UNREPAIRED";

    arms.push({
      runLabel, condition,
      month: typeof row.timestamp === "string" ? row.timestamp.slice(0, 7) : "unknown",
      instanceId,
      shellGuardEnabled: guardEnabled,
      epoch,
      wipedHarnessOutputDir: wiped,
      wipedPath,
      attempts: v.attemptCount,
      runnerStarts: v.runnerStartedCount,
      resultsObserved: v.attempts.filter((a) => a.state === "STARTED_PASSED" || a.state === "STARTED_FAILED").length,
      interpreterSymptom: interpreterSymptom(calls),
    });
  }
}

function tally(rows: readonly ArmRow[]) {
  const withAttempt = rows.filter((r) => r.attempts > 0);
  const withStart = rows.filter((r) => r.runnerStarts > 0);
  const withResult = rows.filter((r) => r.resultsObserved > 0);
  return {
    arms: rows.length,
    armsAttemptingValidation: withAttempt.length,
    armsWithRunnerStart: withStart.length,
    armsWithObservedResult: withResult.length,
    attemptRate: rows.length === 0 ? null : +(withAttempt.length / rows.length).toFixed(4),
    startGivenAttempt: withAttempt.length === 0 ? null : +(withStart.length / withAttempt.length).toFixed(4),
    armsWithHarnessWipe: rows.filter((r) => r.wipedHarnessOutputDir).length,
    armsWithInterpreterSymptom: rows.filter((r) => r.interpreterSymptom).length,
    months: [...new Set(rows.map((r) => r.month))].sort(),
  };
}

const epochs: Epoch[] = ["PRE_GUARD", "GUARD_UNREPAIRED", "GUARD_REPAIRED", "UNRECORDED"];
const byEpoch = Object.fromEntries(epochs.map((e) => [e, tally(arms.filter((a) => a.epoch === e))]));
const byMonth = Object.fromEntries(
  [...new Set(arms.map((a) => a.month))].sort().map((m) => [m, tally(arms.filter((a) => a.month === m))]),
);

const artifact = {
  schemaVersion: "stage5.m191.environment-eras.v1",
  milestone: "M191",
  question: "Is M189's calendar 'environment era' actually the M90A agent shell guard, per arm?",
  exposureVariable: "_run.meta.json stage5_agent_shell_guard_enabled — recorded by each arm about itself, not inferred from its date",
  repairMarker: "_run.meta.json stage5_agent_shell_guard_wrapper_bin_survived_run — the field M187 added; its presence marks a post-repair arm",
  wipeSignature: "Cleaned N file(s) from .../raw/<condition>/ in the arm's preserved _run.stdout.txt",
  totalArms: arms.length,
  byEpoch,
  byMonth,
  arms,
};

writeFileSync(path.join(RESULTS, "stage5_m191_environment_eras.json"), `${JSON.stringify(artifact, null, 2)}\n`);

const pad = (s: string, n: number) => s.padEnd(n);
console.log(pad("epoch", 20) + pad("arms", 7) + pad("attempt", 9) + pad("start", 7) + pad("result", 8) + pad("wipe", 7) + pad("noPip", 7) + "months");
for (const e of epochs) {
  const t = byEpoch[e];
  console.log(
    pad(e, 20) + pad(String(t.arms), 7) + pad(String(t.armsAttemptingValidation), 9) +
    pad(String(t.armsWithRunnerStart), 7) + pad(String(t.armsWithObservedResult), 8) +
    pad(String(t.armsWithHarnessWipe), 7) + pad(String(t.armsWithInterpreterSymptom), 7) + t.months.join(","),
  );
}
console.log("");
console.log(pad("month", 20) + pad("arms", 7) + pad("attempt", 9) + pad("start", 7) + pad("result", 8) + pad("wipe", 7) + pad("noPip", 7));
for (const [m, t] of Object.entries(byMonth)) {
  console.log(
    pad(m, 20) + pad(String(t.arms), 7) + pad(String(t.armsAttemptingValidation), 9) +
    pad(String(t.armsWithRunnerStart), 7) + pad(String(t.armsWithObservedResult), 8) +
    pad(String(t.armsWithHarnessWipe), 7) + pad(String(t.armsWithInterpreterSymptom), 7),
  );
}
