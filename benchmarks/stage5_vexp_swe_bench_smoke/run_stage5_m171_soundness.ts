/**
 * M171-D — the claim-soundness audit at corpus scale, and the control inventory.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m171_soundness.ts
 *
 * Audits every packet at every rung, on the captured development responses AND
 * on the twelve live envelopes agents were actually handed. §49's five counts
 * are zero-tolerance: one violation anywhere fails D.
 *
 * The control inventory is not asserted — the runner executes the control suite
 * and records what it reported, so a suite that stopped running would show up as
 * a missing number rather than as a passing claim.
 *
 * Offline.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { readLiveRun } from "./m171LiveRuns";
import { RUNGS, projectOrientation } from "./m171Projection";
import { ViolationKind, auditPacket } from "./m171Soundness";

const ROOT = path.resolve(".");
const BENCH = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke");
const RESULTS = path.join(BENCH, "results");
const CAPTURE = path.join(RESULTS, "_m171_capture", "dev");

const DEVELOPMENT_RUNS: readonly string[] = Object.freeze([
  "m168_vtrace_clean_astropy__astropy_14369", "m168_vtrace_clean_django__django_13658",
  "m168_vtrace_clean_matplotlib__matplotlib_22719", "m168_vtrace_clean_mwaskom__seaborn_3187",
  "m168_vtrace_clean_pallets__flask_5014", "m168_vtrace_clean_psf__requests_1724",
  "m168_vtrace_clean_pydata__xarray_6599", "m168_vtrace_clean_pylint_dev__pylint_4551",
  "m168_vtrace_clean_pytest_dev__pytest_7432", "m168_vtrace_clean_scikit_learn__scikit_learn_10844",
  "m168_vtrace_clean_sphinx_doc__sphinx_7462", "m168_vtrace_clean_sympy__sympy_13480",
]);

interface AuditRow {
  readonly source: string;
  readonly case: string;
  readonly rung: string;
  readonly violations: readonly { kind: string; detail: string }[];
}

const rows: AuditRow[] = [];

const auditAll = (label: string, sourceName: string, output: Record<string, unknown>): void => {
  for (const rung of RUNGS) {
    const violations = auditPacket(projectOrientation(output, rung), output);
    rows.push({ source: sourceName, case: label, rung: rung.name, violations: violations.map((violation) => ({ kind: violation.kind, detail: violation.detail })) });
  }
};

for (const file of readdirSync(CAPTURE).filter((name) => name.endsWith(".json")).sort()) {
  const captured = JSON.parse(readFileSync(path.join(CAPTURE, file), "utf-8")) as Record<string, any>;
  const output = captured.default?.structuredContent?.result?.output;
  if (output == null) continue;
  auditAll(String(captured.instanceId), "captured_fresh_index", output as Record<string, unknown>);
}

for (const label of DEVELOPMENT_RUNS) {
  const run = readLiveRun(label);
  if (run?.pipelineOutput == null) continue;
  auditAll(label, "live_transcript_envelope", run.pipelineOutput);
}

const byKind: Record<string, number> = {};
for (const row of rows) {
  for (const violation of row.violations) byKind[violation.kind] = (byKind[violation.kind] ?? 0) + 1;
}
const totalViolations = Object.values(byKind).reduce((total, count) => total + count, 0);

// ---- controls: run them, do not assert them ------------------------

const runSuite = (file: string): Record<string, unknown> => {
  const result = spawnSync("bun", ["test", path.join("benchmarks/stage5_vexp_swe_bench_smoke", file)], { cwd: ROOT, encoding: "utf-8" });
  const output = `${result.stdout}${result.stderr}`;
  const pass = /(\d+) pass/.exec(output);
  const fail = /(\d+) fail/.exec(output);
  return {
    file,
    pass: pass === null ? null : Number(pass[1]),
    fail: fail === null ? null : Number(fail[1]),
    exitCode: result.status,
    executed: result.status !== null,
  };
};

const controlSuites = [runSuite("m171Soundness.test.ts"), runSuite("m171Projection.test.ts")];

const write = (name: string, body: unknown): void => {
  writeFileSync(path.join(RESULTS, name), `${JSON.stringify(body, null, 1)}\n`);
  process.stdout.write(`wrote ${name}\n`);
};

write("stage5_m171_claim_soundness.json", {
  schemaVersion: "stage5.m171.claim-soundness.v1",
  milestone: "M171",
  workstream: "M171-D",
  title: "Every claim in every packet, checked against the state it was projected from",
  method: {
    rule: "§49 — derive the claims a reasonable consumer can make from the PACKET, then check each against the authoritative state. A reader's view is the only view a truthfulness audit may use.",
    checks: Object.values(ViolationKind),
    tolerance: "zero. One violation anywhere fails D.",
    sources: {
      captured_fresh_index: "12 development cases, re-captured on fresh indexes",
      live_transcript_envelope: "the 12 envelopes agents were actually handed in M168",
    },
  },
  packetsAudited: rows.length,
  violationsByKind: byKind,
  totalViolations,
  passes: totalViolations === 0,
  unsupportedClaims: (byKind[ViolationKind.UnsupportedLocation] ?? 0) + (byKind[ViolationKind.UnsupportedFile] ?? 0)
    + (byKind[ViolationKind.UnsupportedSpan] ?? 0) + (byKind[ViolationKind.UnsupportedRelation] ?? 0)
    + (byKind[ViolationKind.AuthoredProse] ?? 0) + (byKind[ViolationKind.FabricatedSource] ?? 0),
  falseAbsenceOrExhaustiveClaims: byKind[ViolationKind.NegativeOrExhaustiveClaim] ?? 0,
  rows: rows.filter((row) => row.violations.length > 0),
});

write("stage5_m171_truthfulness_controls.json", {
  schemaVersion: "stage5.m171.truthfulness-controls.v1",
  milestone: "M171",
  workstream: "M171-D",
  title: "Known-positive, known-negative and identity controls for the soundness auditor",
  rule: "§51 — a comparative classifier must correctly classify an unchanged input before its treatment verdicts count. This is the fourth consecutive milestone to require it; M169's repeat control certified two identical repo_not_ready errors as an identical delivery.",
  adversarialFixtures: [
    "exact callers", "potential callers", "bounded caller set", "authoritative absence",
    "not observed", "component unavailable", "component error", "omitted support",
    "same item in multiple semantic roles", "same skip reason at distinct scopes", "repo_not_ready",
  ],
  knownPositives: [
    "fabricated location", "fabricated file", "span disagreeing with the state",
    "a reference strengthened into a call edge", "undeclared prose", "an enumerating note",
    "source absent from the authoritative rendering", "a removed boundary",
  ],
  identityControls: [
    "the status quo audited against itself reports no violation",
    "a vacuous auditor would fail: at least one corruption must be caught",
  ],
  boundaryNote: "The boundary line is excluded from the enumerating-wording scanner and asserted directly instead. It is the one sentence whose job is to DENY exhaustiveness, so a scanner looking for the word fires on the disclaimer.",
  suites: controlSuites,
  passes: controlSuites.every((suite) => suite.fail === 0 && suite.exitCode === 0),
});

process.stdout.write(`\npackets audited ${rows.length}, violations ${totalViolations}\n`);
process.stdout.write(`${JSON.stringify(controlSuites)}\n`);
if (totalViolations > 0) process.exitCode = 1;
