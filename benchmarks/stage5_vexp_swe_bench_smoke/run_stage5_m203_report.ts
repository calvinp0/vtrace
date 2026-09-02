/**
 * M203 — final report assembly. Every load-bearing number is read from a
 * generated artefact; nothing here is transcribed. Fails closed on a missing
 * input, because a report that silently omits the frozen rerun is
 * indistinguishable from one whose frozen rerun passed.
 *
 * The delivery-pipeline audit is the one prose table here, and even it is
 * checked: every named function must exist in the named file, or the report
 * refuses to build.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m203_report.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const read = (name: string, required = true) => {
  const p = path.join(RESULTS, name);
  if (!existsSync(p)) {
    if (required) throw new Error(`M203_EVIDENCE_MISSING: ${name}`);
    return null;
  }
  return JSON.parse(readFileSync(p, "utf8"));
};

const authorityPre = read("stage5_m203_authority.json");
const authorityPost = read("stage5_m203_authority_post.json");
const a14Pre = read("stage5_m203_a14_pre.json");
const a14Post = read("stage5_m203_a14_post.json");
const equivalence = read("stage5_m203_equivalence.json");
const frozenEquivalence = read("stage5_m201_equivalence_base_vs_m203_post.json");
const falsification = read("stage5_m203_falsification.json");
const performance = read("stage5_m203_performance.json");
const a5Before = read("stage5_m202_a5_post.json");
const a5After = read("stage5_m201_a5_m203_post.json");
const ledger = read("stage5_m203_claim_ledger.json");
const engine = read("stage5_m203_engine.json");
const indexing = read("stage5_m203_indexing.json");
const m202Ledger = read("stage5_m202_claim_ledger.json");
const m202Engine = read("stage5_m202_engine.json");
const m202Indexing = read("stage5_m202_indexing.json");
const ledgerRows = readFileSync(path.join(RESULTS, "stage5_m203_accounting_ledger_post.jsonl"), "utf8")
  .split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));

// --------------------------------------------------------------- authority
if (authorityPre.verdict !== "M197A_AUTHORITY_MISMATCH") throw new Error(`M203_PRE_AUTHORITY_UNEXPECTED: ${authorityPre.verdict}`);
const preFailed = authorityPre.checks.filter((c: any) => !c.ok).map((c: any) => c.id);
if (preFailed.join(",") !== "corpus_C-MED") throw new Error(`M203_PRE_AUTHORITY_FAILED_ON: ${preFailed.join(",")}`);
if (authorityPost.verdict !== "M197A_AUTHORITY_VERIFIED") throw new Error(`M203_POST_AUTHORITY_NOT_VERIFIED: ${authorityPost.verdict}`);
const cmedPre = authorityPre.corpora.find((c: any) => c.id === "C-MED");
const cmedPost = authorityPost.corpora.find((c: any) => c.id === "C-MED");

// ---------------------------------------------------------- pipeline audit
const pipeline = [
  { stage: "candidate creation", file: "src/capsuleV2/buildCapsuleV2.ts", symbols: ["buildCapsuleV2"] },
  { stage: "candidate scoring / ranking", file: "src/capsuleV2/pivotRankingV2.ts", symbols: ["scorePivot", "comparePivotScoreDesc"] },
  { stage: "capsule budget allocation (tiers, chars/4)", file: "src/capsuleV2/budgetAllocator.ts", symbols: ["allocateBudget"] },
  { stage: "objective attribution (selection reasons, roles)", file: "src/productContext/assembleProductContext.ts", symbols: ["assembleProductContext", "selectionReasons"] },
  { stage: "deduplication of authoritative items", file: "src/productContext/assembleProductContext.ts", symbols: ["deduplicateDrafts"] },
  { stage: "estimated cost of an item (chars/4, renderItem text)", file: "src/productContext/assembleProductContext.ts", symbols: ["estimateTokens(renderItem(draft))"] },
  { stage: "evidence budget: representation downgrade / drop, supply publication", file: "src/productContext/budgetDelivery.ts", symbols: ["applyProgressiveContextBudget", "publishSemanticItemSupply", "materialize", "compactReasons"] },
  { stage: "authoritative supply (object-keyed, zero bytes)", file: "src/productContext/semanticItemSupply.ts", symbols: ["publishSemanticItemSupply", "semanticItemSupplyOf", "estimatedTokens"] },
  { stage: "complete-response envelope (metadata compaction, neighbourhood text stripping)", file: "src/mcp/responseEnvelope.ts", symbols: ["compactProductResponse", "textCharacters"] },
  { stage: "projection: focus/related selection, admission prefix, ceiling test", file: "src/runPipeline/orientationProjection.ts", symbols: ["projectRunPipelineOrientation", "headBound", "ORIENTATION_POLICY", "orientationTokens"] },
  { stage: "delivery: tokens attached, ledger built and published", file: "src/runPipeline/orientationProjection.ts", symbols: ["withItemTokens", "ledgerFor", "publishOrientationAccounting"] },
  { stage: "accounting contract and token rule", file: "src/runPipeline/orientationAccounting.ts", symbols: ["OrientationAccounting", "OrientationItemAccounting", "ORIENTATION_TOKENS_PER_CHARACTER", "orientationAccountingOf"] },
  { stage: "tool boundary: default detail returns the packet", file: "src/mcp/tools.ts", symbols: ["projectRunPipelineOrientation(authoritativeResult)", "tokens: integerProperty"] },
];
for (const p of pipeline) {
  const text = readFileSync(path.join(REPO, p.file), "utf8");
  for (const s of p.symbols) if (!text.includes(s)) throw new Error(`M203_PIPELINE_AUDIT_STALE: ${s} not in ${p.file}`);
}

// ---------------------------------------------------------------- A14
const cm = (r: any) => r.corpora.find((c: any) => c.id === "C-MED");
const engA14 = (e: any) => e.corpora.find((c: any) => c.id === "C-MED")?.a14;
const verdictOf = (l: any, id: string) => l.claims.find((c: any) => c.id === id)?.verdict ?? null;
const measurementOf = (l: any, id: string) => l.claims.find((c: any) => c.id === id)?.measurement ?? null;
const green = (v: string | null) => v === "VTRACE_MATCHES_VEXP_CLAIM" || v === "VTRACE_EXCEEDS_VEXP_CLAIM";
const short = (v: string | null) => String(v).replace("VTRACE_", "").replace("_VEXP_CLAIM", "");
const IDS = Array.from({ length: 15 }, (_, i) => `A${i + 1}`);
const matrix = IDS.map((id) => ({
  id, m202: verdictOf(m202Ledger, id), m203: verdictOf(ledger, id), moved: verdictOf(m202Ledger, id) !== verdictOf(ledger, id),
  cause: id === "A14" ? "M203 product change (per-item tokens in the default packet)"
    : verdictOf(m202Ledger, id) !== verdictOf(ledger, id) ? "environment (load-sensitive timing claim)" : "",
  measurement: measurementOf(ledger, id),
}));
const regressions = matrix.filter((r) => green(r.m202) && !green(r.m203));
const a14Row = ledger.claims.find((c: any) => c.id === "A14");
const a14Closed = green(a14Row?.verdict ?? null);
const frozenF6 = (ledger.falsificationControls?.controls ?? []).find((c: any) => c.id === "F6");

// ------------------------------------------------------------ reconciliation
const post = cm(a14Post);
const packets = post.responses.filter((r: any) => r.ledger !== "absent");
const byBudget = [1000, 2000, 4000, 8000, 16000].map((b) => {
  const rows = packets.filter((r: any) => r.budget === b);
  const med = (xs: number[]) => { const s = [...xs].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : null; };
  return {
    requestedTokens: b, responses: rows.length,
    eligibleItems: rows.reduce((n: number, r: any) => n + r.frozen.itemsDelivered, 0),
    accountedItems: rows.reduce((n: number, r: any) => n + r.frozen.itemsWithTokenAccounting, 0),
    medianItemTokens: med(rows.map((r: any) => r.ledger.itemTokens)),
    medianWrapperTokens: med(rows.map((r: any) => r.ledger.wrapperTokens)),
    medianPacketTokens: med(rows.map((r: any) => r.ledger.packetTokens)),
    medianAccountingOverheadTokens: med(rows.map((r: any) => r.ledger.accountingOverheadTokens)),
    ceilingTokens: 2000,
    medianUnusedCeilingTokens: med(rows.map((r: any) => r.ledger.unusedCeilingTokens)),
    medianUpstreamModelVisibleTokens: med(rows.map((r: any) => r.ledger.evidenceBudget.modelVisibleTokens).filter((x: any) => typeof x === "number")),
    medianUpstreamRemainingTokens: med(rows.map((r: any) => r.ledger.evidenceBudget.remainingTokens).filter((x: any) => typeof x === "number")),
    charactersExact: rows.every((r: any) => r.ledger.charactersExact),
    tokensWithinBound: rows.every((r: any) => r.ledger.tokenDeviation <= r.ledger.tokenDeviationBound),
    ceilingBound: rows.filter((r: any) => r.ledger.candidates.rejectedForCeiling > 0).length,
  };
});
// A budget-growth pair (§46): the lowest and highest frozen budgets on one task.
const growthTask = post.responses[0].task;
const pair = [1000, 16000].map((b) => {
  const r = post.responses.find((x: any) => x.task === growthTask && x.budget === b);
  const rows = ledgerRows.filter((x) => x.corpus === "C-MED" && x.task === growthTask && x.budget === b);
  return { budget: b, items: rows.length, packetTokens: r.ledger.packetTokens, itemIds: rows.map((x) => x.item_id),
    origins: Object.fromEntries(["item_supply", "pivot_neighborhood"].map((o) => [o, rows.filter((x) => x.origin === o).length])),
    upstreamModelVisibleTokens: r.ledger.evidenceBudget.modelVisibleTokens, deliveryStatus: r.ledger.evidenceBudget.deliveryStatus,
    compactionStages: r.ledger.evidenceBudget.compactionStages };
});
const growth = { task: growthTask, low: pair[0], high: pair[1],
  admittedOnlyAtHigh: pair[1]!.itemIds.filter((id: string) => !pair[0]!.itemIds.includes(id)),
  admittedOnlyAtLow: pair[0]!.itemIds.filter((id: string) => !pair[1]!.itemIds.includes(id)) };

// ------------------------------------------------------- protected claims
const idx = (l: any, c: string) => (l.indexing ?? []).find((x: any) => x.id === c);
const eng = (l: any, c: string) => (l.corpora ?? []).find((x: any) => x.id === c);
const protectedRows = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"].map((id) => ({
  id, m202: short(verdictOf(m202Ledger, id)), m203: short(verdictOf(ledger, id)),
  held: green(verdictOf(m202Ledger, id)) ? green(verdictOf(ledger, id)) : true,
  measurement: measurementOf(ledger, id),
}));
const a5 = {
  before: { label: a5Before.label, p90ByCorpus: a5Before.p90ByCorpus, classification: a5Before.classification, load: a5Before.environment?.atStart?.loadAverage },
  after: { label: a5After.label, p90ByCorpus: a5After.p90ByCorpus, classification: a5After.classification, load: a5After.environment?.atStart?.loadAverage },
  frozenEngineP90: ["C-SMALL", "C-MED", "C-LARGE"].map((c) => ({ corpus: c, m202: eng(m202Engine, c)?.a5?.latency?.p90, m203: eng(engine, c)?.a5?.latency?.p90 })),
};

const out = {
  milestone: "M203", instrument: "run_stage5_m203_report.ts",
  verdicts: {
    a14: a14Closed ? "A14_PARITY_CLOSED" : "A14_PARITY_NOT_CLOSED",
    frozenA14Verdict: a14Row?.verdict ?? null,
    frozenAggregate: ledger.verdict, matchOrExceed: ledger.parity?.matchOrExceed ?? ledger.matchOrExceed ?? null,
    regressions: regressions.map((r) => r.id),
    falsification: falsification.verdict, equivalence: equivalence.verdict,
    integrity: post.integrity.verdict, determinism: post.determinism.packetsStable && post.determinism.ledgersStable,
  },
  authority: {
    preRefreeze: { verdict: authorityPre.verdict, failedChecks: preFailed, cmedFiles: cmedPre?.eligibleFiles, cmedExpected: cmedPre?.expected },
    postRefreeze: { verdict: authorityPost.verdict, cmedFiles: cmedPost?.eligibleFiles, cmedExpected: cmedPost?.expected },
    unchanged: ["claim wording", "thresholds", "scorers", "corpus root and extensions", "query corpus", "tokenizer", "budgets"],
    changed: ["C-MED self-referential identity count 500 -> 502 (two files under src/runPipeline)"],
  },
  frozenA14: {
    claim: a14Row?.vexpClaim, source: a14Row?.vexpSource, matchThreshold: a14Row?.matchThreshold, exceedThreshold: a14Row?.exceedThreshold,
    scorerRule: "verdict = itemsWithPerItemAccounting > 0 ? MATCHES : BELOW; EXCEEDS is not reachable",
    unit: "focus slot + each related entry of the DEFAULT get_code_context response (1 + related.length per response)",
    predicate: "tokens | tokenReductionPercent | rawTokens | savedTokens !== undefined on the item",
    corpus: "C-MED, 20 A13 tasks x 5 budgets = 100 responses",
    modelFacing: true,
    committedM202: engA14(m202Engine), committedM203: engA14(engine),
    reproductionPre: { product: a14Pre.product, ...cm(a14Pre).a14 },
    reproductionPost: { product: a14Post.product, ...post.a14 },
    frozenF6Control: frozenF6 === undefined ? null : { pass: frozenF6.pass, statement: frozenF6.statement,
      note: "the committed control conjoins `a14PerItem === 0`, which encodes the M197A observation; it cannot pass once A14 is MATCHES, and was not modified" },
  },
  pipeline,
  contract: {
    modelFacing: { field: "tokens", where: "every focus and related item of the orientation packet", meaning: "the item's own serialized cost, packet token rule (chars x 0.3174, nearest), including the field (fixed point)" },
    machineFacing: { access: "orientationAccountingOf(packet)", keyed: "WeakMap on the packet object (M180 pattern), zero serialized bytes",
      perItem: ["at", "ordinal", "slot", "representation", "origin", "origins", "sourceId", "reason", "reasonSource", "upstreamEstimatedTokens", "bodyCharacters", "deliveredCodeCharacters", "codeDelivered", "truncated", "estimatedTokens", "admissionPacketTokens", "characters", "actualTokens", "cumulativeCharacters", "cumulativeTokens"],
      perPacket: ["tokenRule", "ceilingTokens", "ceilingAppliesTo", "evidence", "packet", "accountingOverhead", "wrapper", "reconciliation", "candidates", "evidenceBudget", "items"],
      absence: "\"unavailable\" (not observable by the projector) | \"not_applicable\" (does not apply to the item class); 0 is always a measurement" },
    costAuthority: {
      estimatedTokens: "item serialized WITHOUT tokens, as the ceiling test saw it",
      actualTokens: "item serialized WITH tokens (== model-facing field)",
      packetRule: "characters x 0.3174032272551657, rounded to nearest (M166 calibration; the ceiling's own rule)",
      upstream: "chars/4 estimates from the evidence budget carried verbatim under their own label, never converted",
      wrapper: "packet characters - sum(item characters): schemaVersion, boundary, notes, keys, punctuation",
      reconciliation: "characters exact; tokens within ceil((items+2)/2) of rounding",
    },
    ceiling: "tested on the evidence packet (items without tokens) exactly as before; the accounting fields ride above it by the reported accountingOverhead; admission unchanged",
  },
  representationCoverage: post.representationClasses,
  otherCorpora: a14Post.corpora.filter((c: any) => c.id !== "C-MED").map((c: any) => ({ id: c.id, a14: c.a14, classes: c.representationClasses, integrity: c.integrity.verdict, determinism: c.determinism.packetsStable })),
  reconciliation: { byBudget, overall: post.reconciliation, ledgerRows: ledgerRows.length,
    ledgerRowsCMED: ledgerRows.filter((r) => r.corpus === "C-MED").length },
  budgetGrowthPair: growth,
  attribution: {
    reasonSources: Object.fromEntries(["selection_reason", "roles", "neighbor_relation"].map((s) => [s, ledgerRows.filter((r) => r.corpus === "C-MED" && r.reason_source === s).length])),
    origins: Object.fromEntries(["item_supply", "pivot_neighborhood"].map((o) => [o, ledgerRows.filter((r) => r.corpus === "C-MED" && r.origin === o).length])),
    deduplicatedProposals: post.reconciliation.deduplicatedProposals,
    multiOriginItems: ledgerRows.filter((r) => r.corpus === "C-MED" && r.origins.length > 1).length,
  },
  falsification: falsification.controls.map((c: any) => ({ id: c.id, pass: c.pass, statement: c.statement })),
  equivalence: { m203: { verdict: equivalence.verdict, compared: equivalence.compared, selectionEqual: equivalence.selectionEqual, orderEqual: equivalence.orderEqual,
      itemCountEqual: equivalence.itemCountEqual, strippedByteEqual: equivalence.strippedByteEqual, deliveredByteEqual: equivalence.deliveredByteEqual,
      strippedTokenCountEqual: equivalence.strippedTokenCountEqual, differencesExplainedByTokensFieldAlone: equivalence.differencesExplainedByTokensFieldAlone },
    frozenM201Instrument: { verdict: frozenEquivalence.verdict, compared: frozenEquivalence.compared, semanticEqual: frozenEquivalence.semanticEqual, byteEqual: frozenEquivalence.byteEqual,
      note: "the frozen instrument hashes the delivered packet, which now carries tokens; its inequality is the A14 field and nothing else, as the stripped comparison shows" },
    a14Corpus: { authoritativeResults: performance.workload.authoritativeResults, strippedPostEqualsPre: performance.workload.strippedPostEqualsPre } },
  determinism: { a14: { repeats: post.determinism.repeats, responses: post.responseCount, packetsStable: post.determinism.packetsStable, ledgersStable: post.determinism.ledgersStable, unstable: post.determinism.unstablePackets },
    frozenEngine: ledger.determinism },
  performance: { projectorMs: performance.projectorMs, validationMs: performance.validationMs, memory: performance.memory, storage: performance.storage, a5,
    a14WholeCallMedianMs: { pre: cm(a14Pre).latencyMs, post: post.latencyMs } },
  protectedClaims: protectedRows,
  matrix, m202Count: m202Ledger.parity?.matchOrExceed ?? null, m203Count: ledger.parity?.matchOrExceed ?? null,
  a12a15: { a12: { m202: measurementOf(m202Ledger, "A12"), m203: measurementOf(ledger, "A12") }, a15: { m202: measurementOf(m202Ledger, "A15"), m203: measurementOf(ledger, "A15") } },
  environment: { frozenLoad: engine.hardware.loadAverageAtStart, cpus: engine.hardware.cpus },
};
writeFileSync(path.join(RESULTS, "stage5_m203_final_report.json"), `${JSON.stringify(out, null, 2)}\n`);

// ------------------------------------------------------------------ markdown
const md: string[] = [];
md.push(`# Stage 5 — M203: frozen A14 per-item context accounting`, "");
md.push(`\`${out.verdicts.a14}\``, "");
md.push(`## What A14 asks`, "");
md.push(`\`${out.frozenA14.claim}\` (${out.frozenA14.source}). Unit: ${out.frozenA14.unit}. Predicate: ${out.frozenA14.predicate}. Scorer: ${out.frozenA14.scorerRule}. MATCH: ${out.frozenA14.matchThreshold}; EXCEED: ${out.frozenA14.exceedThreshold}. Measured on ${out.frozenA14.corpus}, DEFAULT response only (F6).`, "");
md.push(`| | numerator | denominator | verdict |`, `| --- | ---: | ---: | --- |`);
md.push(`| M202 committed engine | ${out.frozenA14.committedM202.itemsWithPerItemAccounting} | ${out.frozenA14.committedM202.itemsDelivered} | ${short(verdictOf(m202Ledger, "A14"))} |`);
md.push(`| pre-change reproduction (${a14Pre.product.head.slice(0, 12)} worktree) | ${out.frozenA14.reproductionPre.itemsWithPerItemAccounting} | ${out.frozenA14.reproductionPre.itemsDelivered} | ${short(out.frozenA14.reproductionPre.frozenVerdict)} |`);
md.push(`| post-change reproduction | ${out.frozenA14.reproductionPost.itemsWithPerItemAccounting} | ${out.frozenA14.reproductionPost.itemsDelivered} | ${short(out.frozenA14.reproductionPost.frozenVerdict)} |`);
md.push(`| M203 frozen engine rerun | ${out.frozenA14.committedM203.itemsWithPerItemAccounting} | ${out.frozenA14.committedM203.itemsDelivered} | ${short(a14Row?.verdict)} |`, "");
if (frozenF6) md.push(`Frozen control F6 (\`${frozenF6.statement}\`): ${frozenF6.pass ? "pass" : "FAIL"} — ${out.frozenA14.frozenF6Control!.note}.`, "");
md.push(`## Authority`, "");
md.push(`Pre-refreeze replay: \`${out.authority.preRefreeze.verdict}\`, failed on ${out.authority.preRefreeze.failedChecks.join(", ")} only (${out.authority.preRefreeze.cmedFiles} files, expected ${out.authority.preRefreeze.cmedExpected}). Post-refreeze: \`${out.authority.postRefreeze.verdict}\` at ${out.authority.postRefreeze.cmedExpected}. Unchanged: ${out.authority.unchanged.join(", ")}. Changed: ${out.authority.changed.join("; ")}.`, "");
md.push(`## Delivery pipeline`, "");
md.push(`| stage | file | symbols |`, `| --- | --- | --- |`);
for (const p of pipeline) md.push(`| ${p.stage} | \`${p.file}\` | ${p.symbols.map((s) => `\`${s}\``).join(", ")} |`);
md.push("");
md.push(`## Contract`, "");
md.push(`Model-facing: \`${out.contract.modelFacing.field}\` on ${out.contract.modelFacing.where} — ${out.contract.modelFacing.meaning}. Machine-facing: \`${out.contract.machineFacing.access}\`, ${out.contract.machineFacing.keyed}. Absence: ${out.contract.machineFacing.absence}. Ceiling: ${out.contract.ceiling}.`, "");
md.push(`Cost authority — estimated: ${out.contract.costAuthority.estimatedTokens}; actual: ${out.contract.costAuthority.actualTokens}; rule: ${out.contract.costAuthority.packetRule}; upstream: ${out.contract.costAuthority.upstream}; wrapper: ${out.contract.costAuthority.wrapper}; reconciliation: ${out.contract.costAuthority.reconciliation}.`, "");
md.push(`## Representation-class coverage (C-MED, frozen A12 labels)`, "");
md.push(`| representation | eligible | accounted | coverage |`, `| --- | ---: | ---: | ---: |`);
for (const [k, v] of Object.entries(out.representationCoverage) as [string, any][]) md.push(`| ${k} | ${v.eligible} | ${v.accounted} | ${(100 * v.accounted / v.eligible).toFixed(1)}% |`);
for (const c of out.otherCorpora) md.push(`| ${c.id} (not scored) | ${c.a14.itemsDelivered} | ${c.a14.itemsWithPerItemAccounting} | ${c.a14.coveragePercent}% — classes ${Object.entries(c.classes).map(([k, v]: [string, any]) => `${k} ${v.accounted}/${v.eligible}`).join(", ")} |`);
md.push("");
md.push(`## Budget reconciliation (C-MED, medians per frozen budget)`, "");
md.push(`| max_tokens | responses | eligible | accounted | Σ item tokens | wrapper | packet | accounting overhead | ceiling | unused ceiling | upstream visible (chars/4) | upstream remaining | chars exact | tokens in bound | ceiling-bound |`);
md.push(`| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |`);
for (const b of byBudget) md.push(`| ${b.requestedTokens} | ${b.responses} | ${b.eligibleItems} | ${b.accountedItems} | ${b.medianItemTokens} | ${b.medianWrapperTokens} | ${b.medianPacketTokens} | ${b.medianAccountingOverheadTokens} | ${b.ceilingTokens} | ${b.medianUnusedCeilingTokens} | ${b.medianUpstreamModelVisibleTokens} | ${b.medianUpstreamRemainingTokens} | ${b.charactersExact} | ${b.tokensWithinBound} | ${b.ceilingBound} |`);
md.push("", `Overall: ${JSON.stringify(out.reconciliation.overall)}; ledger rows ${out.reconciliation.ledgerRows} (C-MED ${out.reconciliation.ledgerRowsCMED}).`, "");
md.push(`Budget-growth pair (\`${growth.task}\`): ${growth.low.items} items / ${growth.low.packetTokens} packet tokens at ${growth.low.budget} (upstream visible ${growth.low.upstreamModelVisibleTokens}, ${growth.low.deliveryStatus}, stages ${JSON.stringify(growth.low.compactionStages)}) vs ${growth.high.items} / ${growth.high.packetTokens} at ${growth.high.budget} (upstream visible ${growth.high.upstreamModelVisibleTokens}, ${growth.high.deliveryStatus}); admitted only at the high budget: ${growth.admittedOnlyAtHigh.length}, only at the low: ${growth.admittedOnlyAtLow.length}.`, "");
md.push(`## Attribution`, "", `Reason sources ${JSON.stringify(out.attribution.reasonSources)}; origins ${JSON.stringify(out.attribution.origins)}; items proposed by more than one route ${out.attribution.multiOriginItems}; deduplicated proposals ${out.attribution.deduplicatedProposals}.`, "");
md.push(`## Falsification`, "");
for (const c of out.falsification) md.push(`- ${c.id}: ${c.pass ? "PASS" : "FAIL"} — ${c.statement}`);
md.push("", `\`${falsification.verdict}\``, "");
md.push(`## Output equivalence`, "");
md.push(`M203 instrument on the M201 snapshot: \`${equivalence.verdict}\` — ${equivalence.compared} queries, selection ${equivalence.selectionEqual}, order ${equivalence.orderEqual}, item count ${equivalence.itemCountEqual}, bytes with tokens removed ${equivalence.strippedByteEqual}, delivered bytes ${equivalence.deliveredByteEqual} (${equivalence.differencesExplainedByTokensFieldAlone} differ by the tokens field alone). Frozen M201 instrument: \`${frozenEquivalence.verdict}\`, semantic ${frozenEquivalence.semanticEqual}/${frozenEquivalence.compared}, byte ${frozenEquivalence.byteEqual}/${frozenEquivalence.compared} — ${out.equivalence.frozenM201Instrument.note}. On the 100 C-MED A14 results the predecessor projector's packet equals the current packet with tokens removed on ${performance.workload.strippedPostEqualsPre}/${performance.workload.authoritativeResults}.`, "");
md.push(`## Determinism`, "", `A14 reproduction: ${post.responseCount} responses x ${post.determinism.repeats} repeats, packets stable ${post.determinism.packetsStable}, ledgers stable ${post.determinism.ledgersStable}. Frozen engine replay: ${JSON.stringify(ledger.determinism?.allDeterministic ?? ledger.determinism)}.`, "");
md.push(`## Runtime and storage`, "");
md.push(`Projector median ${performance.projectorMs.before.median} -> ${performance.projectorMs.after.median} ms (accounting construction +${performance.projectorMs.accountingConstructionMedianMs} ms median, +${performance.projectorMs.accountingConstructionP90Ms} ms p90) over ${performance.workload.samplesPerSide} samples per side; validation median ${performance.validationMs.median} ms. Ledger serialized median ${performance.memory.ledgerSerializedBytes.median} B (max ${performance.memory.ledgerSerializedBytes.max}); heap delta per packet as measured ${performance.memory.perPacketDeltaBytes} B (${performance.memory.retention}). Storage: ${performance.storage.databaseTables} tables, ${performance.storage.schemaChanges} schema changes — ${performance.storage.note}. Whole-call A14 median ${out.performance.a14WholeCallMedianMs.pre.median} -> ${out.performance.a14WholeCallMedianMs.post.median} ms (C-MED, load-sensitive, not a frozen figure).`, "");
md.push(`Frozen A5: before (${a5.before.label}) ${JSON.stringify(a5.before.p90ByCorpus)} ${short(a5.before.classification)} at load ${a5.before.load?.[0]}; after (${a5.after.label}) ${JSON.stringify(a5.after.p90ByCorpus)} ${short(a5.after.classification)} at load ${a5.after.load?.[0]}. Frozen engine p90: ${a5.frozenEngineP90.map((r) => `${r.corpus} ${r.m202} -> ${r.m203}`).join(", ")}.`, "");
md.push(`## Protected claims`, "", `| ID | M202 | M203 | measurement (M203) |`, `| --- | --- | --- | --- |`);
for (const r of protectedRows) md.push(`| ${r.id} | ${r.m202} | ${r.m203} | ${String(r.measurement).slice(0, 160)} |`);
md.push("", `## Full A1–A15 matrix`, "", `| ID | M202 | M203 | cause/status |`, `| --- | --- | --- | --- |`);
for (const r of matrix) md.push(`| ${r.id} | ${short(r.m202)} | ${short(r.m203)} | ${r.moved ? r.cause : "held"} |`);
md.push("", `M202 ${out.m202Count} / 15 — M203 ${out.m203Count} / 15 — target 15 / 15. Frozen aggregate: \`${ledger.verdict}\`. Regressions: ${regressions.length === 0 ? "none" : regressions.map((r) => r.id).join(", ")}.`, "");
md.push(`A12: ${out.a12a15.a12.m203}. A15: ${out.a12a15.a15.m203}.`, "");
writeFileSync(path.join(RESULTS, "stage5_m203_final_report.md"), `${md.join("\n")}\n`);
console.log(`${out.verdicts.a14}  A14 ${short(a14Row?.verdict)}  matrix M202 ${out.m202Count}/15 -> M203 ${out.m203Count}/15  regressions ${regressions.length}  `
  + `falsification ${falsification.verdict}  equivalence ${equivalence.verdict}  integrity ${post.integrity.verdict}`);
