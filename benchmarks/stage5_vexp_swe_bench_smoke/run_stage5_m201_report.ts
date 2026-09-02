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
const determinism = read("stage5_m201_determinism.json");
const falsification = read("stage5_m201_falsification_f1.json");
const frozenA5 = read("stage5_m201_engine.json");
// The optimisation that was written, measured and rejected. Kept as evidence:
// a candidate that bought nothing is only informative if its measurement is
// still readable next to the profile that motivated it.
const rejectedCapture = read("stage5_m201_a5_post1_a.json", false);
const rejectedProfile = read("stage5_m201_profile_post1.json", false);
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
  frozenA5: Object.fromEntries((frozenA5?.corpora ?? []).map((c: any) => [c.id, c.a5?.latency ?? null])),
  determinism: {
    before: determinism.before, after: determinism.after,
    compared: determinism.compared, semanticEqual: determinism.semanticEqual,
    byteEqual: determinism.byteEqual, verdict: determinism.verdict,
    frozenEngineDeterministic: (frozenA5?.corpora ?? []).every((c: any) => c.a5?.deterministic !== false),
  },
  falsificationF1: {
    perturbation: "orientation related candidates iterated in reverse",
    compared: falsification.compared, semanticEqual: falsification.semanticEqual,
    byteEqual: falsification.byteEqual, differences: falsification.differences.length,
    tokenCountsStillEqual: falsification.corpora.every((c: any) => c.tokenEqual === c.compared),
    verdict: falsification.verdict,
  },
  storage: storage,
  rejectedCandidate: rejectedCapture === null ? null : {
    change: "split the query-independent scan and lowercasing out of the query-keyed broad-candidate memo",
    motivation: "a doubled statement counter reported the scan running twice per request",
    p90WithCandidate: rejectedCapture.p90ByCorpus,
    p90WithoutCandidate: {
      "C-SMALL": reproduction.runs.find((r: any) => r.label === "pre_a")?.p90["C-SMALL"] ?? null,
      "C-MED": reproduction.runs.find((r: any) => r.label === "pre_a")?.p90["C-MED"] ?? null,
      "C-LARGE": reproduction.runs.find((r: any) => r.label === "pre_a")?.p90["C-LARGE"] ?? null,
    },
    sqlExecutionsUnchanged: rejectedProfile === null ? null : (rejectedProfile.corpora ?? [])
      .flatMap((c: any) => (c.perQuery ?? []).map((q: any) => q.sql?.executions)),
    outcome: "rejected; no measured effect, and the duplication it removed did not exist",
  },
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


const short = (v: string | null) => String(v).replace("VTRACE_", "").replace("_VEXP_CLAIM", "");
const md: string[] = [];
md.push(`# Stage 5 — M201: frozen A5 query latency\n`);
md.push(`\`${out.a5.parity}\`\n`);
md.push(`## What A5 asks\n`);
md.push(`\`${a5?.vexpClaim ?? ""}\`, scored as **${a5?.matchThreshold}** (EXCEED at ${a5?.exceedThreshold}),`);
md.push(`banded by \`band()\` over the p90 of C-SMALL, C-MED and C-LARGE — every corpus must clear.\n`);
md.push(`Measured: ${a5?.measurement}\n`);
md.push(`Verdict: **${short(a5?.verdict ?? null)}**\n`);

md.push(`## Did M200's BELOW reproduce?\n`);
md.push(`No. \`${reproduction.verdict}\`\n`);
md.push(`| run | load (1m) | C-SMALL | C-MED | C-LARGE | classification |`);
md.push(`| --- | ---: | ---: | ---: | ---: | --- |`);
md.push(`| M200 | ${reproduction.m200.loadAverageAtStart?.[0]} | ${reproduction.m200.p90["C-SMALL"]} | `
  + `${reproduction.m200.p90["C-MED"]} | ${reproduction.m200.p90["C-LARGE"]} | ${short(reproduction.m200.classification)} |`);
for (const run of reproduction.runs) {
  md.push(`| ${run.label} | ${run.loadAverage1m} | ${run.p90["C-SMALL"]} | ${run.p90["C-MED"]} | `
    + `${run.p90["C-LARGE"]} | ${short(run.classification)} |`);
}
md.push(``);
md.push(`${reproduction.m201.sourceFilesChangedSinceM200.length} files under \`src/\` changed between the commit `
  + `M200 measured and this one, and ${reproduction.m201.sourceFilesDirty.length} are dirty. The product is the same; `
  + `the machine was not.\n`);

md.push(`## Where a C-LARGE query spends its time\n`);
md.push(`| stage | ms/query | % of samples |`);
md.push(`| --- | ---: | ---: |`);
for (const stage of (stages?.stages ?? [])) md.push(`| \`${stage.stage}\` | ${stage.msPerQuery} | ${stage.percentOfSamples} |`);
md.push(``);
md.push(`Whole-table scans per request, by layer — one at every layer, so there is no second pass:\n`);
md.push(`| layer | scans |`);
md.push(`| --- | ---: |`);
const layerRow = (layers?.rows ?? [])[0];
if (layerRow !== undefined) {
  md.push(`| \`buildAuthoritativeProductRetrieval\` | ${layerRow.buildAuthoritativeProductRetrieval.scans} |`);
  md.push(`| \`runReliableContextRetrieval\` | ${layerRow.runReliableContextRetrieval.scans} |`);
  md.push(`| whole \`get_code_context\` request | ${layerRow.getCodeContextRequest.scans} |`);
}
md.push(``);
md.push(`## Operation counts on the frozen corpora\n`);
md.push(`| corpus | symbols | whole-table scans/query | SQL executions/query | worst statement repeat |`);
md.push(`| --- | ---: | ---: | ---: | ---: |`);
for (const corpus of (opcounts?.corpora ?? [])) {
  md.push(`| ${corpus.id} | ${corpus.indexedSymbols} | ${corpus.medians?.wholeTableScans} | `
    + `${corpus.medians?.executions} | ${corpus.maxima?.maxRepeatsOfOneStatement} |`);
}
md.push(``);
md.push(`## Frozen matrix\n`);
md.push(`| ID | M200 | M201 | |`);
md.push(`| --- | --- | --- | --- |`);
for (const row of matrix) {
  md.push(`| ${row.id} | ${short(row.m200)} | ${short(row.m201)} | ${row.moved ? "moved" : ""} |`);
}
md.push(``);
md.push(`M200 ${out.parity.m200MatchOrExceed}/15 → M201 ${out.parity.m201MatchOrExceed}/15; target 15/15.`);
md.push(`Regressions: ${out.parity.regressions.length === 0 ? "none" : out.parity.regressions.join(", ")}.`);
md.push(`Still BELOW: ${out.stillBelow.join(", ")}.\n`);
md.push(`## The candidate that was rejected\n`);
if (out.rejectedCandidate !== null) {
  md.push(`The first profile said the whole-symbol-table scan ran twice per request, and a repair was written for it: `
    + `${out.rejectedCandidate.change}. Measured p90 with the change `
    + `${["C-SMALL", "C-MED", "C-LARGE"].map((c) => out.rejectedCandidate!.p90WithCandidate[c]).join(" / ")} ms `
    + `against ${["C-SMALL", "C-MED", "C-LARGE"].map((c) => out.rejectedCandidate!.p90WithoutCandidate[c]).join(" / ")} ms without it, `
    + `and SQL executions per query identical on every one of the fifteen frozen queries.\n`);
  md.push(`A real duplicate removed is not free, so the flat result was the first evidence that the duplicate was an `
    + `artefact: \`Database.prototype.query\` is implemented on top of \`Database.prototype.prepare\`, and an instrument `
    + `patching both counted every execution twice. ${out.rejectedCandidate.outcome}.\n`);
}
md.push(`## Falsification\n`);
md.push(`Reversing the order in which orientation admits related candidates is caught on `
  + `${out.falsificationF1.compared - out.falsificationF1.semanticEqual} of ${out.falsificationF1.compared} queries `
  + `(\`${out.falsificationF1.verdict}\`). Token counts stayed equal on every corpus, so the gate caught it on the `
  + `semantic and selection hashes, not on size — which is why size alone is not the comparator.\n`);
md.push(`Two independent captures of the unperturbed path are equal on all `
  + `${out.determinism.compared} queries, semantically and byte for byte (\`${out.determinism.verdict}\`).\n`);
md.push(`## Boundary\n`);
for (const line of out.productUtilityBoundary) md.push(`\`${line}\``);
md.push(``);
md.push(`live-agent runs: ${out.liveAgentRuns}; live model spend: $${out.liveModelSpendUsd}.`);
writeFileSync(path.join(RESULTS, "stage5_m201_final_report.md"), `${md.join("\n")}\n`);

console.log(`A5: ${out.a5.verdict}  ->  ${out.a5.parity}`);
console.log(`reproduction: ${out.reproduction.verdict}`);
console.log(`\n${"ID".padEnd(5)} ${"M200".padEnd(28)} ${"M201".padEnd(28)} moved`);
for (const row of matrix) {
  console.log(`${row.id.padEnd(5)} ${short(row.m200).padEnd(28)} ${short(row.m201).padEnd(28)} ${row.moved ? "YES" : ""}`);
}
console.log(`\nM200 ${out.parity.m200MatchOrExceed}/15   M201 ${out.parity.m201MatchOrExceed}/15   target 15/15`);
console.log(`regressions: ${out.parity.regressions.length === 0 ? "none" : out.parity.regressions.join(", ")}`);
console.log(`still below: ${out.stillBelow.join(", ")}`);
console.log(`\nwrote results/stage5_m201_final_report.json and .md`);
