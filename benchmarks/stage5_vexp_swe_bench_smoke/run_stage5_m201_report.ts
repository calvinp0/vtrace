/**
 * M201 — final report assembly. Every load-bearing number is read from a
 * generated artefact; nothing here is transcribed (§44).
 *
 * Fails closed on a missing input, because a report that silently omits the
 * frozen rerun is indistinguishable from one whose frozen rerun passed.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m201_report.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.join(import.meta.dir, "results");
const read = (name: string, required = true) => {
  const p = path.join(RESULTS, name);
  if (!existsSync(p)) {
    if (required) throw new Error(`M201_EVIDENCE_MISSING: ${name}`);
    return null;
  }
  return JSON.parse(readFileSync(p, "utf8"));
};

const authority = read("stage5_m201_authority.json");
const reproduction = read("stage5_m201_reproduction.json");
const ledger = read("stage5_m201_claim_ledger.json");
const m200Ledger = read("stage5_m200_claim_ledger.json");
const opcounts = read("stage5_m201_opcounts_pre.json");
const stages = read("stage5_m201_cpu_stages_pre_C-LARGE.json");
const hotsql = read("stage5_m201_hotsql_pre_C-LARGE.json");
const tail = read("stage5_m201_tail_pre_a.json");
const layers = read("stage5_m201_layers_C-LARGE.json");
const equivalence = read("stage5_m201_equivalence_pre_a_vs_pre_b.json");
const storage = read("stage5_m201_storage.json");

if (authority.verdict !== "M197A_AUTHORITY_VERIFIED") {
  throw new Error(`M201_AUTHORITY_NOT_VERIFIED: ${authority.verdict}`);
}

const verdictOf = (l: any, id: string) => l.claims.find((c: any) => c.id === id)?.verdict ?? null;
const IDS = Array.from({ length: 15 }, (_, i) => `A${i + 1}`);
const matrix = IDS.map((id) => ({
  id, m200: verdictOf(m200Ledger, id), m201: verdictOf(ledger, id),
  moved: verdictOf(m200Ledger, id) !== verdictOf(ledger, id),
}));
const green = (v: string | null) => v === "VTRACE_MATCHES_VEXP_CLAIM" || v === "VTRACE_EXCEEDS_VEXP_CLAIM";
const a5 = ledger.claims.find((c: any) => c.id === "A5");

const regressions = matrix.filter((r) => green(r.m200) && !green(r.m201));
const a5Closed = green(a5?.verdict ?? null);

const out = {
  milestone: "M201",
  instrument: "run_stage5_m201_report.ts",
  scope: "frozen A5 query latency only",
  authorityVerdict: authority.verdict,
  a5: {
    definition: a5?.matchThreshold ?? null,
    measurement: a5?.measurement ?? null,
    verdict: a5?.verdict ?? null,
    parity: a5Closed ? "A5_PARITY_CLOSED" : "A5_PARITY_NOT_CLOSED",
  },
  reproduction: {
    verdict: reproduction.verdict,
    runs: reproduction.runs.length,
    loadRange: reproduction.loadRangeCovered,
    classifications: reproduction.runsClassified,
    sourceFilesChangedSinceM200: reproduction.m201.sourceFilesChangedSinceM200.length,
    bindingCorpusSpread: reproduction.bindingCorpusSpread,
  },
  attribution: {
    dominantStageMsPerQuery: (stages?.stages ?? []).slice(0, 6),
    wholeTableScansPerQuery: Object.fromEntries(
      (opcounts?.corpora ?? []).map((c: any) => [c.id, c.medians?.wholeTableScans ?? null])),
    sqlExecutionsPerQuery: Object.fromEntries(
      (opcounts?.corpora ?? []).map((c: any) => [c.id, c.medians?.executions ?? null])),
    hottestStatement: hotsql?.statements?.[0] === undefined ? null : {
      totalMs: hotsql.statements[0].totalMs,
      executionsAcrossFiveQueries: hotsql.statements[0].executions,
      rowsPerExecution: hotsql.statements[0].rowsPerExecution,
      plan: hotsql.statements[0].plan,
    },
    scansPerRequestByLayer: (layers?.rows ?? []).map((r: any) => ({
      task: r.task,
      buildAuthoritativeProductRetrieval: r.buildAuthoritativeProductRetrieval?.scans ?? null,
      runReliableContextRetrieval: r.runReliableContextRetrieval?.scans ?? null,
      getCodeContextRequest: r.getCodeContextRequest?.scans ?? null,
    })),
    bindingCorpus: tail?.bindingCorpus ?? null,
  },
  outputEquivalence: equivalence === null ? null : {
    before: equivalence.before, after: equivalence.after,
    compared: equivalence.compared, semanticEqual: equivalence.semanticEqual,
    byteEqual: equivalence.byteEqual, verdict: equivalence.verdict,
  },
  storage: storage,
  matrix,
  parity: {
    m200MatchOrExceed: matrix.filter((r) => green(r.m200)).length,
    m201MatchOrExceed: matrix.filter((r) => green(r.m201)).length,
    of: IDS.length,
    target: 15,
    regressions: regressions.map((r) => r.id),
    moved: matrix.filter((r) => r.moved).map((r) => ({ id: r.id, from: r.m200, to: r.m201 })),
  },
  stillBelow: matrix.filter((r) => !green(r.m201)).map((r) => r.id),
  productUtilityBoundary: [
    "ENGINE QUALITY != CODING-AGENT UTILITY",
    "NO_CONTEXT_COMPILER_PRODUCT_RESTRUCTURE_AUTHORIZED",
    "NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED",
    "NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED",
    "I5_REMAINS_CLOSED",
    "I6_VALIDATION_SELECTION_REMAINS_CLOSED",
  ],
  liveAgentRuns: 0,
  liveModelSpendUsd: 0,
};
writeFileSync(path.join(RESULTS, "stage5_m201_final_report.json"), `${JSON.stringify(out, null, 2)}\n`);

console.log(`A5: ${out.a5.verdict}  ->  ${out.a5.parity}`);
console.log(`reproduction: ${out.reproduction.verdict}`);
console.log(`\n${"ID".padEnd(5)} ${"M200".padEnd(28)} ${"M201".padEnd(28)} moved`);
for (const row of matrix) {
  const short = (v: string | null) => String(v).replace("VTRACE_", "").replace("_VEXP_CLAIM", "");
  console.log(`${row.id.padEnd(5)} ${short(row.m200).padEnd(28)} ${short(row.m201).padEnd(28)} ${row.moved ? "YES" : ""}`);
}
console.log(`\nM200 ${out.parity.m200MatchOrExceed}/15   M201 ${out.parity.m201MatchOrExceed}/15   target 15/15`);
console.log(`regressions: ${out.parity.regressions.length === 0 ? "none" : out.parity.regressions.join(", ")}`);
console.log(`still below: ${out.stillBelow.join(", ")}`);
console.log(`\nwrote results/stage5_m201_final_report.json`);
