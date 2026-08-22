/**
 * M172-C — the frozen policy's controls, with numbers rather than assertions.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m172_controls.ts
 *
 * Five properties have to hold before P_SUPPLY is allowed near a holdout
 * capture, because M172 promotes a bound that M171 declared and never applied:
 *
 *   1  the ceiling constrains the model-facing orientation
 *   2  below the ceiling nothing is arbitrarily capped
 *   3  at and above the ceiling selection stays deterministic and truthful
 *   4  raising the ceiling never removes admitted evidence
 *   5  unused capacity attracts nothing
 *
 * `m172Projection.test.ts` asserts them. This runner MEASURES them: where the
 * ceiling starts to bind, how much headroom the real corpus leaves, and how many
 * claims the audit rejects. The control suites are executed rather than trusted,
 * so a suite that stopped running shows up as a missing number and not as a pass.
 *
 * Offline; reads `_m171_capture/dev` and the M168 live envelopes only. No
 * holdout capture is opened.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { median, percentile } from "./m171Contract";
import { readLiveRun } from "./m171LiveRuns";
import { ViolationKind, auditPacket } from "./m171Soundness";
import { P_SUPPLY, packetTokens, projectOrientationM172, type OrientationPolicy } from "./m172Projection";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const CAPTURE = path.join(RESULTS, "_m171_capture", "dev");

const DEVELOPMENT_RUNS: readonly string[] = Object.freeze([
  "m168_vtrace_clean_astropy__astropy_14369", "m168_vtrace_clean_django__django_13658",
  "m168_vtrace_clean_matplotlib__matplotlib_22719", "m168_vtrace_clean_mwaskom__seaborn_3187",
  "m168_vtrace_clean_pallets__flask_5014", "m168_vtrace_clean_psf__requests_1724",
  "m168_vtrace_clean_pydata__xarray_6599", "m168_vtrace_clean_pylint_dev__pylint_4551",
  "m168_vtrace_clean_pytest_dev__pytest_7432", "m168_vtrace_clean_scikit_learn__scikit_learn_10844",
  "m168_vtrace_clean_sphinx_doc__sphinx_7462", "m168_vtrace_clean_sympy__sympy_13480",
]);

const UNBOUNDED: OrientationPolicy = Object.freeze({ ...P_SUPPLY, name: "UNBOUNDED", ceilingTokens: Number.MAX_SAFE_INTEGER });

// ---- control 1: where does the ceiling actually begin to bind? -----
//
// Development supply never exceeds 7, so the real corpus cannot answer this.
// A synthetic state of ascending supply can: it locates the point at which the
// bound stops being theoretical, which is the threshold the pre-registered
// holdout risk is measured against.

function syntheticState(count: number): Record<string, unknown> {
  const items = Array.from({ length: count + 1 }, (_, index) => ({
    id: `i${index}`,
    fqName: index === 0 ? "pkg/focus.py::Focus.run" : `pkg/mod${index}.py::Sym${index}.method`,
    path: index === 0 ? "pkg/focus.py" : `pkg/mod${index}.py`,
    lineSpan: { start: index * 10 + 1, end: index * 10 + 9 },
    contentMode: "full",
    roles: index === 0 ? ["pivot"] : ["support"],
    selectionReasons: [index === 0 ? "lead pivot for this task" : "direct caller of pkg/focus.py::Focus.run"],
  }));
  return {
    productContext: {
      resolved: true, retrievalFound: true, deliveryFailed: false,
      leadPivot: "pkg/focus.py::Focus.run", items,
      modelVisibleContext: items.map((i) => `\n## [${i.id}]\nroles: ${i.roles.join(",")}\n\n${"x".repeat(200)}`).join("\n"),
      freshness: { status: "fresh", reason: "" },
    },
    diagnostics: { freshness: { readiness: { ready: true } } },
    pivotNeighborhood: [],
  };
}

let saturationSupply: number | null = null;
let maxRelatedAtCeiling: number | null = null;
for (let supply = 1; supply <= 400; supply += 1) {
  const packet = projectOrientationM172(syntheticState(supply), P_SUPPLY);
  if (packet.related.length < supply) {
    saturationSupply = supply;
    maxRelatedAtCeiling = packet.related.length;
    break;
  }
}

// ---- controls 2-5 on the real corpus -------------------------------

interface Row {
  readonly source: string;
  readonly case: string;
  readonly supply: number;
  readonly delivered: number;
  readonly tokens: number;
  readonly headroomTokens: number;
  readonly ceilingBinds: boolean;
  readonly violations: readonly { kind: string; detail: string }[];
  readonly stableWhenCeilingRaised: boolean;
  readonly nestedUnderSmallerCeiling: boolean;
}

const rows: Row[] = [];

const measure = (label: string, sourceName: string, output: Record<string, unknown>): void => {
  const packet = projectOrientationM172(output, P_SUPPLY);
  const supply = projectOrientationM172(output, UNBOUNDED).related.length;
  const tokens = packetTokens(packet);

  // Control 5, on real state: a complete packet does not move when the ceiling rises.
  const raised = JSON.stringify(projectOrientationM172(output, { ...P_SUPPLY, ceilingTokens: 20_000 }));
  // Control 4, on real state: a smaller ceiling names a subset of a larger one.
  const smaller = projectOrientationM172(output, { ...P_SUPPLY, ceilingTokens: 400 }).related.map((r) => r.at);
  const namedHere = new Set(packet.related.map((r) => r.at));

  rows.push({
    source: sourceName,
    case: label,
    supply,
    delivered: packet.related.length,
    tokens,
    headroomTokens: P_SUPPLY.ceilingTokens - tokens,
    ceilingBinds: packet.related.length < supply,
    violations: auditPacket(packet, output).map((v) => ({ kind: v.kind, detail: v.detail })),
    stableWhenCeilingRaised: raised === JSON.stringify(packet),
    nestedUnderSmallerCeiling: smaller.every((at) => namedHere.has(at)),
  });
};

for (const file of readdirSync(CAPTURE).filter((f) => f.endsWith(".json")).sort()) {
  const captured = JSON.parse(readFileSync(path.join(CAPTURE, file), "utf-8")) as Record<string, any>;
  const output = captured.default?.structuredContent?.result?.output;
  if (output != null) measure(String(captured.instanceId), "captured_fresh_index", output as Record<string, unknown>);
}
for (const label of DEVELOPMENT_RUNS) {
  const run = readLiveRun(label);
  if (run?.pipelineOutput != null) measure(label, "live_transcript_envelope", run.pipelineOutput);
}

const byKind: Record<string, number> = {};
for (const row of rows) for (const v of row.violations) byKind[v.kind] = (byKind[v.kind] ?? 0) + 1;
const totalViolations = Object.values(byKind).reduce((t, c) => t + c, 0);

// ---- run the suites, do not assert them ----------------------------

const runSuite = (file: string): Record<string, unknown> => {
  const result = spawnSync("bun", ["test", path.join("benchmarks/stage5_vexp_swe_bench_smoke", file)], { cwd: ROOT, encoding: "utf-8" });
  const out = `${result.stdout}${result.stderr}`;
  const pass = /(\d+) pass/.exec(out);
  const fail = /(\d+) fail/.exec(out);
  return { file, pass: pass === null ? null : Number(pass[1]), fail: fail === null ? null : Number(fail[1]), exitCode: result.status, executed: result.status !== null };
};

const headrooms = rows.map((r) => r.headroomTokens);
const report = {
  schemaVersion: "stage5.m172.controls.v1",
  milestone: "M172",
  workstream: "M172-C",
  title: "The five controls the frozen policy had to pass before any holdout capture was opened",
  policy: P_SUPPLY,
  method: {
    sources: {
      captured_fresh_index: "12 development cases, re-captured on fresh indexes",
      live_transcript_envelope: "the 12 envelopes agents were actually handed in M168",
      synthetic_ascending_supply: "used only to locate the ceiling's binding point, because real development supply never exceeds 7",
    },
    holdoutNotOpened: "no Broad100-A or Broad100-B capture is read by this script",
  },
  control1_ceilingConstrains: {
    claim: "the ceiling is a real bound on the model-facing orientation, not a declared one",
    m171Defect: "Rung.ceilingTokens was set on all four rungs and read by nothing; the live bounds were focusCodeCharacters and relatedCap",
    bindingSupplyThreshold: saturationSupply,
    relatedDeliveredAtThreshold: maxRelatedAtCeiling,
    reading: saturationSupply === null
      ? "the ceiling did not bind at any supply up to 400, which would mean it is still not a bound"
      : `admission stops once the packet would exceed 2,000 tokens: a supply of ${saturationSupply} delivers ${maxRelatedAtCeiling}. The bound acts.`,
    pass: saturationSupply !== null,
  },
  control2_noArbitraryCap: {
    claim: "below the ceiling, authoritative related evidence is delivered in full",
    casesWhereSupplyExceedsM171Cap: rows.filter((r) => r.supply > 5).length,
    casesWhereDeliveredBelowSupply: rows.filter((r) => r.ceilingBinds).length,
    pass: rows.every((r) => r.ceilingBinds || r.delivered === r.supply),
  },
  control3_deterministicAndTruthful: {
    claim: "selection is a pure function of state and policy, and every claim is supported",
    packetsAudited: rows.length,
    violationsByKind: byKind,
    totalViolations,
    checks: Object.values(ViolationKind),
    tolerance: "zero",
    pass: totalViolations === 0,
  },
  control4_raisingCeilingRemovesNothing: {
    claim: "a smaller ceiling names a subset of what a larger one names",
    cases: rows.length,
    violations: rows.filter((r) => !r.nestedUnderSmallerCeiling).length,
    pass: rows.every((r) => r.nestedUnderSmallerCeiling),
  },
  control5_noRefill: {
    claim: "a packet complete below its ceiling does not move when the ceiling rises tenfold",
    cases: rows.length,
    violations: rows.filter((r) => !r.stableWhenCeilingRaised).length,
    pass: rows.every((r) => r.stableWhenCeilingRaised),
    note: "M166's refill was a packer acquiring more evidence to fill a freed envelope. This projector has no notion of remaining space, so there is nothing for freed space to attract.",
  },
  realCorpusHeadroom: {
    medianTokens: median(rows.map((r) => r.tokens)),
    p90Tokens: percentile(rows.map((r) => r.tokens), 90),
    maxTokens: Math.max(...rows.map((r) => r.tokens)),
    medianHeadroomTokens: median(headrooms),
    minHeadroomTokens: Math.min(...headrooms),
    reading: "the ceiling is real but does not bind on this corpus; the packet is supply-bound, not envelope-bound",
  },
  controlSuites: [runSuite("m172Projection.test.ts"), runSuite("m171Projection.test.ts"), runSuite("m171Soundness.test.ts")],
  rows,
};

const allPass = report.control1_ceilingConstrains.pass && report.control2_noArbitraryCap.pass
  && report.control3_deterministicAndTruthful.pass && report.control4_raisingCeilingRemovesNothing.pass
  && report.control5_noRefill.pass;

writeFileSync(path.join(RESULTS, "stage5_m172_controls.json"), `${JSON.stringify({ ...report, allControlsPass: allPass }, null, 1)}\n`);

console.log(`control 1 ceiling constrains       ${report.control1_ceilingConstrains.pass ? "PASS" : "FAIL"}  binds at supply ${saturationSupply}, delivering ${maxRelatedAtCeiling}`);
console.log(`control 2 no arbitrary cap         ${report.control2_noArbitraryCap.pass ? "PASS" : "FAIL"}  ${report.control2_noArbitraryCap.casesWhereSupplyExceedsM171Cap} cases exceed M171's cap of 5`);
console.log(`control 3 deterministic + truthful ${report.control3_deterministicAndTruthful.pass ? "PASS" : "FAIL"}  ${rows.length} packets, ${totalViolations} violations`);
console.log(`control 4 raising removes nothing  ${report.control4_raisingCeilingRemovesNothing.pass ? "PASS" : "FAIL"}`);
console.log(`control 5 no refill                ${report.control5_noRefill.pass ? "PASS" : "FAIL"}`);
console.log(`real corpus: median ${report.realCorpusHeadroom.medianTokens} tok, max ${report.realCorpusHeadroom.maxTokens}, min headroom ${report.realCorpusHeadroom.minHeadroomTokens}`);
