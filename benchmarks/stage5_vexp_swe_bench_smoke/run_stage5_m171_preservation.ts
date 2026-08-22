/**
 * M171-D — does the compact packet still contain the location the agent went to?
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m171_preservation.ts
 *
 * The twelve M168 `vtrace_clean` transcripts carry the EXACT envelope the agent
 * was handed and everything it then did. This runner projects THAT envelope —
 * not a re-capture of it — so the comparison is between two disclosures of one
 * authoritative state, with the behaviour held fixed.
 *
 * Preservation is measured relative to the status quo, not in absolute terms.
 * The current default supports the agent's first repository action on 7 of 12
 * runs; the question §60 asks is whether the packet keeps those 7, not whether
 * it can manufacture the 5 the current contract already misses. Both numbers are
 * reported, because reporting only the ratio would hide a weak denominator.
 *
 * Offline. Reads transcripts only.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { median, surfacedFilePaths, surfacedSymbols } from "./m171Contract";
import { judgeConsumption } from "./m171Consumption";
import { RUNGS, projectOrientation, readPacketClaims } from "./m171Projection";
import { readLiveRun } from "./m171LiveRuns";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

/**
 * Gold comes from the frozen fixture, not from the transcript. The run's own
 * `_eval.meta.json` carries no gold patch, and an unavailable gold is reported
 * as unmeasurable rather than as a miss.
 */
const GOLD: ReadonlyMap<string, readonly string[]> = new Map(
  (JSON.parse(readFileSync(path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/retrieval_eval.m155_broad_100.json"), "utf-8")) as {
    instance_id: string; expected_files?: string[];
  }[]).map((row) => [row.instance_id, Object.freeze(row.expected_files ?? [])]),
);

/** `m168_vtrace_clean_astropy__astropy_14369` -> `astropy__astropy-14369`. */
const instanceOf = (label: string): string =>
  label.replace(/^m168_vtrace_clean_/, "").replace(/_(\d+)$/, "-$1");

const DEVELOPMENT_RUNS: readonly string[] = Object.freeze([
  "m168_vtrace_clean_astropy__astropy_14369", "m168_vtrace_clean_django__django_13658",
  "m168_vtrace_clean_matplotlib__matplotlib_22719", "m168_vtrace_clean_mwaskom__seaborn_3187",
  "m168_vtrace_clean_pallets__flask_5014", "m168_vtrace_clean_psf__requests_1724",
  "m168_vtrace_clean_pydata__xarray_6599", "m168_vtrace_clean_pylint_dev__pylint_4551",
  "m168_vtrace_clean_pytest_dev__pytest_7432", "m168_vtrace_clean_scikit_learn__scikit_learn_10844",
  "m168_vtrace_clean_sphinx_doc__sphinx_7462", "m168_vtrace_clean_sympy__sympy_13480",
]);

interface ArmVerdict {
  readonly arm: string;
  readonly files: number;
  readonly symbols: number;
  readonly firstActionSupported: boolean | null;
  readonly firstEditSupported: boolean | null;
  readonly earlyPhaseSupported: number;
  readonly earlyPhaseTotal: number;
  readonly goldFileDelivered: boolean | null;
  readonly pivot: string | null;
}

const rows: { label: string; readable: boolean; arms: ArmVerdict[] }[] = [];

for (const label of DEVELOPMENT_RUNS) {
  const run = readLiveRun(label);
  if (run === null || run.pipelineOutput === null) {
    rows.push({ label, readable: false, arms: [] });
    continue;
  }
  const output = run.pipelineOutput;
  const gold = new Set(GOLD.get(instanceOf(label)) ?? run.goldFiles);
  const authoritativePivot = String((output.productContext as Record<string, unknown> | undefined)?.leadPivot ?? "") || null;

  const judge = (arm: string, files: ReadonlySet<string>, symbols: ReadonlySet<string>, pivot: string | null): ArmVerdict => {
    const verdict = judgeConsumption(run.actions, files);
    return {
      arm,
      files: files.size,
      symbols: symbols.size,
      firstActionSupported: verdict.firstActionSupported,
      firstEditSupported: verdict.firstEditSupported,
      earlyPhaseSupported: verdict.earlyPhaseSupported,
      earlyPhaseTotal: verdict.earlyPhaseTotal,
      // Null, not false, when the transcript carries no gold patch: an unknown
      // is not a miss (M167 permanent — parse failure is not semantic absence).
      goldFileDelivered: gold.size === 0 ? null : [...gold].some((file) => files.has(file)),
      pivot,
    };
  };

  const arms: ArmVerdict[] = [
    judge("CURRENT", surfacedFilePaths(output), surfacedSymbols(output), authoritativePivot),
    ...RUNGS.map((rung) => {
      const packet = projectOrientation(output, rung);
      const claims = readPacketClaims(packet);
      return judge(rung.name, claims.files, claims.locations, packet.focus?.at ?? null);
    }),
  ];
  rows.push({ label, readable: true, arms });
}

// ---- aggregate per arm ---------------------------------------------

const readable = rows.filter((row) => row.readable);
const armNames = ["CURRENT", ...RUNGS.map((rung) => rung.name)];

const armOf = (row: typeof readable[number], arm: string): ArmVerdict =>
  row.arms.find((candidate) => candidate.arm === arm)!;

const currentSupported = readable.filter((row) => armOf(row, "CURRENT").firstActionSupported === true);
const currentEditSupported = readable.filter((row) => armOf(row, "CURRENT").firstEditSupported === true);
const currentGoldDelivered = readable.filter((row) => armOf(row, "CURRENT").goldFileDelivered === true);

const perArm = armNames.map((arm) => {
  const verdicts = readable.map((row) => armOf(row, arm));
  const goldMeasurable = verdicts.filter((verdict) => verdict.goldFileDelivered !== null);
  return {
    arm,
    medianFiles: median(verdicts.map((verdict) => verdict.files)),
    medianSymbols: median(verdicts.map((verdict) => verdict.symbols)),
    firstActionSupported: verdicts.filter((verdict) => verdict.firstActionSupported === true).length,
    firstEditSupported: verdicts.filter((verdict) => verdict.firstEditSupported === true).length,
    earlyPhaseSupported: verdicts.reduce((total, verdict) => total + verdict.earlyPhaseSupported, 0),
    earlyPhaseTotal: verdicts.reduce((total, verdict) => total + verdict.earlyPhaseTotal, 0),
    goldFileDelivered: goldMeasurable.filter((verdict) => verdict.goldFileDelivered === true).length,
    goldFileMeasurable: goldMeasurable.length,
    pivotIdentical: readable.filter((row) => armOf(row, arm).pivot === armOf(row, "CURRENT").pivot).length,
    // Preservation is measured on the cases the CURRENT contract already supports.
    firstActionPreserved: arm === "CURRENT" ? null
      : currentSupported.filter((row) => armOf(row, arm).firstActionSupported === true).length,
    firstActionPreservationBase: currentSupported.length,
    firstEditPreserved: arm === "CURRENT" ? null
      : currentEditSupported.filter((row) => armOf(row, arm).firstEditSupported === true).length,
    firstEditPreservationBase: currentEditSupported.length,
    goldFilePreserved: arm === "CURRENT" ? null
      : currentGoldDelivered.filter((row) => armOf(row, arm).goldFileDelivered === true).length,
    goldFilePreservationBase: currentGoldDelivered.length,
  };
});

const body = {
  schemaVersion: "stage5.m171.preservation.v1",
  milestone: "M171",
  workstream: "M171-D",
  title: "Does the compact packet keep the location the agent actually went to?",
  method: {
    source: "the twelve M168 vtrace_clean transcripts; the envelope projected is the one inside the agent's own tool_result block",
    behaviourHeldFixed: "the actions compared against are the SAME actions in every arm. This is a disclosure comparison, not a live experiment.",
    preservationDenominator: "the cases the CURRENT default already supports. A projection cannot be credited for a case the status quo also misses.",
    frozenDefinitions: "m171Consumption.ts, written before any rate existed (§41)",
    honesty: "the absolute rate is reported next to the preservation rate, because a high ratio over a weak denominator would read as strength",
  },
  statusQuo: {
    firstActionSupported: currentSupported.length,
    ofRuns: readable.length,
    reading: "the current contract supports the agent's first repository action on 7 of 12 runs and misses on 5. Early-phase support is 0% or 100% per run with nothing in between: the packet is right or wrong, not partly right.",
  },
  gates: {
    firstActionPreservationAtOrAbove: 0.9,
    pivotIdentity: 1.0,
  },
  perArm,
  rows,
};

writeFileSync(path.join(RESULTS, "stage5_m171_preservation.json"), `${JSON.stringify(body, null, 1)}\n`);
process.stdout.write("wrote stage5_m171_preservation.json\n");
for (const arm of perArm) {
  process.stdout.write(
    `${arm.arm.padEnd(9)} files=${String(arm.medianFiles).padStart(2)} firstAction=${arm.firstActionSupported}/12`
    + ` preserved=${arm.firstActionPreserved ?? "-"}/${arm.firstActionPreservationBase}`
    + ` firstEdit=${arm.firstEditSupported}/12 early=${arm.earlyPhaseSupported}/${arm.earlyPhaseTotal}`
    + ` gold=${arm.goldFileDelivered}/${arm.goldFileMeasurable} pivotSame=${arm.pivotIdentical}/12\n`,
  );
}
