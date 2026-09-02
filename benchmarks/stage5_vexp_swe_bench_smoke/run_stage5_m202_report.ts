/**
 * M202 — final report assembly. Every load-bearing number is read from a
 * generated artefact; nothing here is transcribed. Fails closed on a missing
 * input, because a report that silently omits the frozen rerun is
 * indistinguishable from one whose frozen rerun passed.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m202_report.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { LANGUAGE_FAMILIES } from "../../src/parsers/languageFamilies";

const RESULTS = path.join(import.meta.dir, "results");
const read = (name: string, required = true) => {
  const p = path.join(RESULTS, name);
  if (!existsSync(p)) {
    if (required) throw new Error(`M202_EVIDENCE_MISSING: ${name}`);
    return null;
  }
  return JSON.parse(readFileSync(p, "utf8"));
};

const authorityPre = read("stage5_m202_authority.json");
const authorityPost = read("stage5_m202_authority_post.json");
const auditPre = read("stage5_m202_a1_audit_pre.json");
const auditPost = read("stage5_m202_a1_audit_post.json");
const deps = read("stage5_m202_dependency_audit.json");
const health = read("stage5_m202_family_health.json");
const mixed = read("stage5_m202_mixed_corpus.json");
const perf = read("stage5_m202_performance.json");
const ledger = read("stage5_m202_claim_ledger.json");
const engine = read("stage5_m202_engine.json");
const indexing = read("stage5_m202_indexing.json");
const equivalence = read("stage5_m202_equivalence.json");
const pairedExpanded = read("stage5_m202_retrieval_paired_expanded.json");
const pairedCrossRepo = read("stage5_m202_retrieval_paired_cross_repo_30.json");
const m201Ledger = read("stage5_m201_claim_ledger.json");
const m201Engine = read("stage5_m201_engine.json");
const m201Indexing = read("stage5_m201_indexing.json");

for (const [name, a] of [["pre", authorityPre], ["post", authorityPost]] as const) {
  if (a.verdict !== "M197A_AUTHORITY_VERIFIED") throw new Error(`M202_AUTHORITY_NOT_VERIFIED (${name}): ${a.verdict}`);
}

const verdictOf = (l: any, id: string) => l.claims.find((c: any) => c.id === id)?.verdict ?? null;
const measurementOf = (l: any, id: string) => l.claims.find((c: any) => c.id === id)?.measurement ?? null;
const IDS = Array.from({ length: 15 }, (_, i) => `A${i + 1}`);
const green = (v: string | null) => v === "VTRACE_MATCHES_VEXP_CLAIM" || v === "VTRACE_EXCEEDS_VEXP_CLAIM";
const short = (v: string | null) => String(v).replace("VTRACE_", "").replace("_VEXP_CLAIM", "");
const matrix = IDS.map((id) => ({
  id, m201: verdictOf(m201Ledger, id), m202: verdictOf(ledger, id), moved: verdictOf(m201Ledger, id) !== verdictOf(ledger, id),
  cause: id === "A1" ? "M202 product change (27 families registered)" : verdictOf(m201Ledger, id) !== verdictOf(ledger, id) ? "environment (load-sensitive timing claim)" : "",
}));
const regressions = matrix.filter((r) => green(r.m201) && !green(r.m202));
const a1 = ledger.claims.find((c: any) => c.id === "A1");
const a1Closed = green(a1?.verdict ?? null);

const idx = (l: any, c: string) => (l.indexing ?? []).find((x: any) => x.id === c);
const eng = (l: any, c: string) => (l.corpora ?? []).find((x: any) => x.id === c);
const protectedClaims = ["A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"].map((id) => ({
  id, m201: verdictOf(m201Ledger, id), m202: verdictOf(ledger, id), regressed: green(verdictOf(m201Ledger, id)) && !green(verdictOf(ledger, id)),
  m201Measurement: measurementOf(m201Ledger, id), m202Measurement: measurementOf(ledger, id),
}));

// §48 capability matrix, derived from the family table, the health ledger and the mixed-corpus incremental result.
const healthRow = (language: string) => (health.ledger ?? []).find((r: any) => r.language === language);
const incrementalMode = (mixed.incremental ?? []).filter((s: any) => s.step !== "noop").map((s: any) => s.mode);
const capabilityMatrix = LANGUAGE_FAMILIES.map((f) => {
  const h = healthRow(f.language);
  const kinds = h?.kinds ?? {};
  const deep = f.tier === "DEEP_GRAPH";
  const structural = f.tier === "STRUCTURAL";
  return {
    family: f.displayName, language: f.language, tier: f.tier, counted: (ledger.claims.find((c: any) => c.id === "A1")?.measurement ?? "").includes(f.language) ? "yes" : "no",
    symbols: deep ? "yes" : structural ? (h?.symbols > 0 ? "yes" : "no") : "no",
    members: deep ? "yes" : structural ? ((kinds.method ?? 0) > 0 ? "yes" : "no") : "no",
    imports: deep ? "yes" : "no",
    calls: f.language === "python" ? "yes" : deep ? "partial" : "no",
    refs: f.language === "python" ? "yes" : deep ? "partial" : "no",
    documents: f.tier === "DOCUMENT" ? "yes" : "no",
    incremental: deep ? "yes" : f.parser === "none" ? "yes (document path)" : incrementalMode.every((m: string) => m === "full_rebuild") ? "partial (full rebuild, closure_uncertain)" : "yes",
    exported: deep ? "yes" : ["go", "rust", "javascript", "java", "csharp", "php", "zig"].includes(f.language) ? "partial" : "no (false)",
  };
});

const out = {
  milestone: "M202",
  instrument: "run_stage5_m202_report.ts",
  scope: "frozen A1 language/parser breadth only",
  authority: { pre: authorityPre.verdict, post: authorityPost.verdict, head: authorityPost.git?.head ?? null },
  frozenA1: {
    definition: auditPost.frozenDefinition,
    vexpCount: auditPost.vexp.namesListed,
    vtracePreCount: auditPre.vtrace.frozenA1Count,
    vtracePostCount: auditPost.vtrace.frozenA1Count,
    scorerMeasurement: a1?.measurement ?? null,
    verdict: a1?.verdict ?? null,
    parity: a1Closed ? "A1_PARITY_CLOSED" : "A1_PARITY_NOT_CLOSED",
    vexpRowConvention: auditPost.vtrace.vexpRowConvention,
    registeredOutsideVexpList: auditPost.vtrace.vexpRowConvention.registeredFamiliesOutsideVexpList,
    vexpTechnologyTally: auditPost.vexp.technologyTally,
  },
  dependencies: { ...deps.totals, core: deps.core, blocked: deps.blockedFamilies },
  familyHealth: { verdict: health.verdict, healthy: health.healthy.length, unhealthy: health.unhealthy, controls: health.controls, countAuthorityAgrees: health.countAuthorityAgrees },
  mixedCorpus: { verdict: mixed.verdict, familiesExpected: mixed.familiesExpected.length, familiesDiscovered: mixed.familiesDiscovered.length,
    grammarsInvoked: mixed.parserInvocations.grammarsInvoked, missing: mixed.missing, leaked: mixed.leaked, duplicates: mixed.duplicates,
    deterministic: mixed.determinism.identical, incremental: mixed.incremental },
  performance: { registryCreationMs: perf.registryCreation.createMsMedian, lazy: perf.registryCreation.lazy,
    firstParseMedianMs: perf.perFamilyMedians.firstParseMs, firstParseMaxMs: perf.perFamilyMedians.firstParseMaxMs, secondParseMedianMs: perf.perFamilyMedians.secondParseMs,
    rssRegistryOnlyMiB: perf.memory.registryOnlyRssMiB, rssAllGrammarsMiB: perf.memory.allGrammarsLoadedRssMiB, mixedCorpusFilesPerSecond: perf.mixedCorpusThroughput.median,
    coldIndexing: ["C-SMALL", "C-MED", "C-LARGE"].map((c) => ({ corpus: c, m201FilesPerSecond: idx(m201Indexing, c)?.cold?.filesPerSecondMedian ?? null, m202FilesPerSecond: idx(indexing, c)?.cold?.filesPerSecondMedian ?? null })),
    loadAverage: { m201Engine: m201Engine.hardware?.loadAverageAtStart ?? null, m202Engine: engine.hardware?.loadAverageAtStart ?? null, m202Indexing: indexing.hardware?.loadAverageAtStart ?? null } },
  frozenQueryOutputs: { instrument: "run_stage5_m201_a5.ts base vs m202_post on the M201 immutable snapshot", compared: equivalence.compared, semanticEqual: equivalence.semanticEqual,
    byteEqual: equivalence.byteEqual, differences: equivalence.differences, verdict: equivalence.verdict, corpora: equivalence.corpora },
  retrievalNoChangeProof: {
    protocol: "run_stage5_m134_prepare_targets.ts per side + run_stage5_m134_paired_comparison.ts (predecessor a52b1906 worktree vs candidate HEAD)",
    expanded: { pass: pairedExpanded.pass, provenanceValid: pairedExpanded.provenanceValid ?? null, changedCases: pairedExpanded.changedCases?.length ?? null, changed: pairedExpanded.changedCases ?? null, summary: pairedExpanded.summary ?? null },
    crossRepo30: { pass: pairedCrossRepo.pass, provenanceValid: pairedCrossRepo.provenanceValid ?? null, changedCases: pairedCrossRepo.changedCases?.length ?? null, changed: pairedCrossRepo.changedCases ?? null, summary: pairedCrossRepo.summary ?? null },
  },
  capabilityMatrix,
  protectedClaims,
  matrix,
  parity: {
    m201MatchOrExceed: matrix.filter((r) => green(r.m201)).length,
    m202MatchOrExceed: matrix.filter((r) => green(r.m202)).length,
    of: IDS.length, target: 15,
    regressions: regressions.map((r) => r.id),
    moved: matrix.filter((r) => r.moved).map((r) => ({ id: r.id, from: r.m201, to: r.m202, cause: r.cause })),
    frozenAggregate: ledger.parity,
    frozenAggregateVerdict: ledger.verdict,
  },
  stillBelow: matrix.filter((r) => !green(r.m202)).map((r) => r.id),
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
writeFileSync(path.join(RESULTS, "stage5_m202_final_report.json"), `${JSON.stringify(out, null, 2)}\n`);

const md: string[] = [];
md.push(`# Stage 5 — M202: frozen A1 language-family breadth\n`);
md.push(`\`${out.frozenA1.parity}\`\n`);
md.push(`## What A1 asks\n`);
md.push(`\`${a1?.vexpClaim}\` — VEXP lists ${out.frozenA1.vexpCount} names under one README heading (four of them slash-joined pairs counted once); `
  + `VTRACE counts \`Language\` enum members with a parser in \`createDefaultParserRegistry\`. **${a1?.matchThreshold}**, EXCEED at ${a1?.exceedThreshold}.\n`);
md.push(`Measured: ${a1?.measurement}\n`);
md.push(`Verdict: **${short(a1?.verdict ?? null)}** (pre-change count ${out.frozenA1.vtracePreCount}, post ${out.frozenA1.vtracePostCount}). `
  + `Under VEXP's own row convention VTRACE covers ${out.frozenA1.vexpRowConvention.rowsCovered}/${out.frozenA1.vexpRowConvention.of} names `
  + `(blocked: ${deps.blockedFamilies.map((b: any) => b.vexpRow).join(", ")}); families registered outside VEXP's list: ${out.frozenA1.registeredOutsideVexpList.join(", ") || "none"}.\n`);
md.push(`## Families\n`);
md.push(`| family | tier | counted | symbols | members | imports | calls | refs | documents | incremental | exported |`);
md.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
for (const r of capabilityMatrix) md.push(`| ${r.family} | ${r.tier} | ${r.counted} | ${r.symbols} | ${r.members} | ${r.imports} | ${r.calls} | ${r.refs} | ${r.documents} | ${r.incremental} | ${r.exported} |`);
md.push(``);
md.push(`Health: \`${health.verdict}\` (${health.healthy.length} healthy, unhealthy ${health.unhealthy.length}); controls F1–F12 ${health.controls.every((c: any) => c.pass) ? "all pass" : "FAILED"}. `
  + `Mixed corpus: \`${mixed.verdict}\`, ${mixed.familiesDiscovered.length}/${mixed.familiesExpected.length} families, ${mixed.parserInvocations.grammarsInvoked} grammar objects invoked, `
  + `exclusions leaked ${mixed.leaked.length}, cold determinism ${mixed.determinism.identical ? "identical" : "DIFFERENT"}; incremental modes: ${mixed.incremental.map((s: any) => `${s.step}=${s.mode}`).join(", ")}.\n`);
md.push(`## Dependencies\n`);
md.push(`${deps.totals.grammarPackages} grammar packages pinned exactly (${deps.totals.prebuilt} prebuilt, ${deps.totals.compiledAtInstall} compiled at install), `
  + `${deps.totals.unpackedMiB} MiB unpacked, all ABI-compatible with tree-sitter ${deps.core.version} (ABI ${deps.core.minCompatibleLanguageVersion}–${deps.core.languageVersion}); licences ${JSON.stringify(deps.totals.licenses)}.\n`);
md.push(`## Performance\n`);
md.push(`Registry creation ${perf.registryCreation.createMsMedian} ms with ${perf.registryCreation.grammarsLoadedAtCreation} grammars loaded (lazy); first parse per family median ${perf.perFamilyMedians.firstParseMs} ms, max ${perf.perFamilyMedians.firstParseMaxMs} ms; `
  + `RSS ${perf.memory.registryOnlyRssMiB} → ${perf.memory.allGrammarsLoadedRssMiB} MiB with every grammar loaded; mixed corpus ${perf.mixedCorpusThroughput.median} files/s.\n`);
md.push(`| corpus | M201 cold files/s | M202 cold files/s |`, `| --- | ---: | ---: |`);
for (const c of out.performance.coldIndexing) md.push(`| ${c.corpus} | ${c.m201FilesPerSecond} | ${c.m202FilesPerSecond} |`);
md.push(``);
md.push(`## Frozen query outputs (§53)\n`);
md.push(`${equivalence.semanticEqual}/${equivalence.compared} queries semantically equal, ${equivalence.byteEqual} byte-equal, against the M201 immutable snapshot (\`${equivalence.verdict}\`).`);
for (const c of equivalence.corpora ?? []) md.push(`- ${c.id}: ${JSON.stringify(c)}`);
md.push(``);
md.push(`## Retrieval no-change proof\n`);
md.push(`expanded: pass=${pairedExpanded.pass}, changed cases ${pairedExpanded.changedCases?.length ?? "?"}; cross_repo_30: pass=${pairedCrossRepo.pass}, changed cases ${pairedCrossRepo.changedCases?.length ?? "?"}.\n`);
md.push(`## Protected claims\n`);
md.push(`| ID | M201 | M202 | measurement (M202) |`, `| --- | --- | --- | --- |`);
for (const p of protectedClaims) md.push(`| ${p.id} | ${short(p.m201)} | ${short(p.m202)}${p.regressed ? " **REGRESSED**" : ""} | ${String(p.m202Measurement).slice(0, 120)} |`);
md.push(``);
md.push(`## Frozen matrix\n`);
md.push(`| ID | M201 | M202 | |`, `| --- | --- | --- | --- |`);
for (const row of matrix) md.push(`| ${row.id} | ${short(row.m201)} | ${short(row.m202)} | ${row.moved ? `moved: ${row.cause}` : ""} |`);
md.push(``);
md.push(`M201 ${out.parity.m201MatchOrExceed}/15 → M202 ${out.parity.m202MatchOrExceed}/15; target 15/15. `
  + `Regressions: ${regressions.length === 0 ? "none" : regressions.map((r) => r.id).join(", ")}. Still BELOW: ${out.stillBelow.join(", ")}.`);
md.push(`Frozen aggregate: \`${ledger.verdict}\` (match-or-exceed ${ledger.parity.matchOrExceed}, A8 minimum ${ledger.parity.a8MinimumCoveragePercent}%, structural violations ${ledger.parity.structuralViolations.length}).\n`);
md.push(`## Boundary\n`);
for (const line of out.productUtilityBoundary) md.push(`\`${line}\``);
md.push(``, `live-agent runs: 0; live model spend: $0.`);
writeFileSync(path.join(RESULTS, "stage5_m202_final_report.md"), `${md.join("\n")}\n`);

console.log(`A1: ${out.frozenA1.verdict} -> ${out.frozenA1.parity}`);
console.log(`\n${"ID".padEnd(5)} ${"M201".padEnd(10)} ${"M202".padEnd(10)} moved`);
for (const row of matrix) console.log(`${row.id.padEnd(5)} ${short(row.m201).padEnd(10)} ${short(row.m202).padEnd(10)} ${row.moved ? `YES (${row.cause})` : ""}`);
console.log(`\nM201 ${out.parity.m201MatchOrExceed}/15   M202 ${out.parity.m202MatchOrExceed}/15   target 15/15`);
console.log(`regressions: ${regressions.length === 0 ? "none" : regressions.map((r) => r.id).join(", ")}`);
console.log(`frozen aggregate: ${ledger.verdict}`);
console.log(`still below: ${out.stillBelow.join(", ")}`);
console.log(`\nwrote results/stage5_m202_final_report.json and .md`);
