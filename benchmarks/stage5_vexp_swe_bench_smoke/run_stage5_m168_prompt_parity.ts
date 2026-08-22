/**
 * M168-E prompt parity — prove the shared anti-loop discipline text is absent
 * from every arm, and that each arm carries exactly its own policy.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m168_prompt_parity.ts
 *
 * The runner records its own assembly-time flag. That is not enough: a flag
 * saying "not injected" and a prompt that carries the text anyway is exactly
 * the failure this must catch, so the flag is treated as ONE signal among
 * several, and the independent ones come from the patched adapter's own stderr
 * and from the captured transcript rather than from the runner's bookkeeping.
 *
 * Exits non-zero if any arm fails parity, so the driver loop can be stopped
 * before more money is spent.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  M168_PIPELINE_TOOL_NAME,
  M168_PROHIBITION_TEXT,
  claudeMdForArm,
  type M168Arm,
} from "./m168Treatment";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const RUNS = path.join(RESULTS, "runs");
const WIRING_DIR = path.join(RESULTS, "_m168_wiring");

/** The marker the runner stamps on the block, and the adapter's injection log. */
const DISCIPLINE_MARKER = "## STAGE5_TOOL_USE_DISCIPLINE";
const DISCIPLINE_INJECTION_LOG = "Stage5 tool-use-discipline injected from";
const TOKEN_DISCIPLINE_MARKER = "## STAGE5_TOKEN_DISCIPLINE";
const TRIGGER_INJECTION_LOG = "Stage5 M163 task trigger injected from";

function armOf(label: string): M168Arm | null {
  if (label.startsWith("m168_baseline_")) return "baseline";
  if (label.startsWith("m168_vtrace_strict_")) return "vtrace_strict";
  if (label.startsWith("m168_vtrace_clean_")) return "vtrace_clean";
  return null;
}

const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf-8") : "");

interface ParityRow {
  label: string;
  arm: M168Arm;
  /** Runner's own assembly-time bookkeeping. */
  runnerFlagDisabled: boolean | null;
  runnerFlagInjected: boolean | null;
  /** Independent: the patched adapter logs unconditionally when the env is set. */
  adapterLoggedDisciplineInjection: boolean;
  /**
   * The prompt is passed to the agent via argv and is NOT echoed into the
   * stream, so the transcript cannot answer "was this text in the prompt".
   * Recorded as an explicit unobservable rather than scored as an absence —
   * a check that can only ever return false is not a control.
   */
  promptTextObservableInTranscript: false;
  /** The arm's own policy must be present exactly when it should be. */
  adapterLoggedPolicyInjection: boolean;
  policyExpected: boolean;
  /** Sourced from the injected policy FILE, which is the byte-exact artifact. */
  policyFileExists: boolean;
  policyFileMatchesArm: boolean;
  prohibitionInPolicyFile: boolean;
  prohibitionExpected: boolean;
  /** Tool NAMES do appear in the transcript, as tool_use events. */
  vtraceToolCallsInTranscript: number;
  vtraceToolCallsExpected: boolean;
  verdict: "PASS" | "FAIL";
  failures: string[];
}

const rows: ParityRow[] = [];

for (const label of existsSync(RUNS) ? readdirSync(RUNS).sort() : []) {
  const arm = armOf(label);
  if (arm === null) continue;

  // raw/vtrace for the treatment arms, raw/baseline for --protocol baseline.
  const rawParent = path.join(RUNS, label, "raw");
  const raw = (existsSync(rawParent) ? readdirSync(rawParent) : [])
    .map((d) => path.join(rawParent, d))
    .find((d) => existsSync(path.join(d, "_run.meta.json")));
  if (raw === undefined) continue;

  const meta = JSON.parse(read(path.join(raw, "_run.meta.json"))) as Record<string, unknown>;
  const stderr = read(path.join(raw, "_run.stderr.txt"));
  const streamPath = [
    path.join(raw, "_agent_stream.first_pass.jsonl"),
    path.join(raw, "_agent_stream.jsonl"),
  ].find(existsSync);
  const transcript = streamPath === undefined ? "" : read(streamPath);

  const policyText = claudeMdForArm(arm);
  const policyExpected = policyText !== null;
  // The bytes actually handed to the agent for this run.
  const policyFile = read(path.join(WIRING_DIR, `${label}.policy.md`));
  const prohibitionExpected = arm === "vtrace_strict";

  const row: ParityRow = {
    label,
    arm,
    runnerFlagDisabled: typeof meta.stage5ToolUseDisciplineDisabledByFlag === "boolean"
      ? meta.stage5ToolUseDisciplineDisabledByFlag : null,
    runnerFlagInjected: typeof meta.stage5ToolUseDisciplineInjected === "boolean"
      ? meta.stage5ToolUseDisciplineInjected : null,
    adapterLoggedDisciplineInjection: stderr.includes(DISCIPLINE_INJECTION_LOG),
    promptTextObservableInTranscript: false,
    adapterLoggedPolicyInjection: stderr.includes(TRIGGER_INJECTION_LOG),
    policyExpected,
    policyFileExists: policyFile !== "",
    policyFileMatchesArm: policyText !== null && policyFile === policyText,
    prohibitionInPolicyFile: policyFile.includes(M168_PROHIBITION_TEXT),
    prohibitionExpected,
    vtraceToolCallsInTranscript: (transcript.match(/mcp__vtrace__/g) ?? []).length,
    vtraceToolCallsExpected: arm !== "baseline",
    verdict: "PASS",
    failures: [],
  };

  // ── the parity assertion the user asked for ──
  if (row.runnerFlagDisabled !== true) {
    row.failures.push("runner did not record the discipline block as disabled by flag");
  }
  if (row.runnerFlagInjected !== false) {
    row.failures.push("runner recorded the discipline block as injected");
  }
  if (row.adapterLoggedDisciplineInjection) {
    row.failures.push("the adapter logged a discipline injection — the env var was set");
  }
  // No transcript-sourced discipline assertion: see promptTextObservableInTranscript.

  // ── each arm carries exactly its own policy, no more and no less ──
  if (row.adapterLoggedPolicyInjection !== policyExpected) {
    row.failures.push(
      policyExpected
        ? "the arm's policy was not injected"
        : "the baseline received a policy injection",
    );
  }
  if (policyExpected && !row.policyFileMatchesArm) {
    row.failures.push("the injected policy file does not match this arm's frozen bytes");
  }
  if (row.prohibitionInPolicyFile !== prohibitionExpected) {
    row.failures.push(
      prohibitionExpected
        ? "the strict arm's policy file is missing the prohibition"
        : "a non-strict arm's policy file carries the prohibition",
    );
  }
  if (arm === "baseline" && row.vtraceToolCallsInTranscript > 0) {
    row.failures.push("the baseline transcript contains VTRACE tool calls");
  }
  if (arm !== "baseline" && row.vtraceToolCallsInTranscript === 0) {
    row.failures.push("a treatment arm made no VTRACE tool call at all");
  }

  row.verdict = row.failures.length === 0 ? "PASS" : "FAIL";
  rows.push(row);
}

const failed = rows.filter((r) => r.verdict === "FAIL");

const report = {
  milestone: "M168-E",
  control: "prompt parity — the shared anti-loop discipline text is absent from A, B and C",
  signals: {
    runnerBookkeeping: ["stage5ToolUseDisciplineDisabledByFlag", "stage5ToolUseDisciplineInjected"],
    independent: [
      `patched adapter stderr: "${DISCIPLINE_INJECTION_LOG}" must be absent`,
      "injected policy file bytes must equal the arm's frozen policy",
      "baseline transcript must contain zero mcp__vtrace__ tool calls",
    ],
    unobservable: {
      what: "whether a given string was in the agent's prompt",
      why: "the prompt is passed via argv and is never echoed into the stream; "
        + `neither "${DISCIPLINE_MARKER}" nor "${TOKEN_DISCIPLINE_MARKER}" nor the `
        + "policy text can appear there, so scanning for them would be a check that "
        + "cannot fail. Recorded as unobservable rather than scored as absence.",
      substitutedBy:
        "the patched adapter's own injection log, which DID fire on the discarded "
        + "pre-fix run and does not fire now — a signal with a known positive",
    },
  },
  runsChecked: rows.length,
  pass: rows.length - failed.length,
  fail: failed.length,
  byArm: Object.fromEntries(
    (["baseline", "vtrace_strict", "vtrace_clean"] as const).map((arm) => [
      arm,
      {
        runs: rows.filter((r) => r.arm === arm).length,
        pass: rows.filter((r) => r.arm === arm && r.verdict === "PASS").length,
      },
    ]),
  ),
  rows,
  verdict: rows.length === 0 ? "NOT_RUN" : failed.length === 0 ? "PARITY_HOLDS" : "PARITY_VIOLATED",
};

writeFileSync(
  path.join(RESULTS, "stage5_m168_prompt_parity.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

console.log(`prompt parity: ${report.verdict} — ${report.pass}/${report.runsChecked} runs`);
for (const r of failed) console.log(`  [FAIL] ${r.label}: ${r.failures.join("; ")}`);
if (failed.length > 0) process.exit(1);
