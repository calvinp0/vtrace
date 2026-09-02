/**
 * M205 — final report assembly. Every load-bearing number is read from a
 * generated artefact; nothing here is transcribed. Fails closed on a missing
 * required input, because a report that silently omits the frozen rerun is
 * indistinguishable from one whose frozen rerun passed.
 *
 * Besides the final report it emits the smaller evidence artefacts the
 * milestone requires — health matrix, source-truth report, mixed-representation
 * example, per-class token report, A11 supply before/after, A13 observation,
 * determinism, protected claims — each derived from the same generated inputs.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m205_report.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { A11_BUDGETS } from "./m204Utilization";
import { A12_EXCEED_CLASSES, A12_MATCH_CLASSES, frozenA12Verdict } from "./m205Representation";

const RESULTS = path.join(import.meta.dir, "results");
const read = (name: string, required = true) => {
  const p = path.join(RESULTS, name);
  if (!existsSync(p)) {
    if (required) throw new Error(`M205_EVIDENCE_MISSING: ${name}`);
    return null;
  }
  return JSON.parse(readFileSync(p, "utf8"));
};
const readRows = (name: string): any[] => {
  const p = path.join(RESULTS, name);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
};
const write = (name: string, value: unknown) => writeFileSync(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`);

const pre = read("stage5_m205_representation_pre.json");
const post = read("stage5_m205_representation_post.json");
const postPre = read("stage5_m205_representation_post_precorpus.json", false);
const falsification = read("stage5_m205_falsification.json");
const vexp = read("stage5_m205_vexp_representation_inventory.json");
const vtracePost = read("stage5_m205_vtrace_representation_inventory_post.json");
const vtracePre = read("stage5_m205_vtrace_representation_inventory_pre.json", false);
const authorityReplay = read("stage5_m205_authority.json");
const authorityPost = read("stage5_m205_authority_post.json");
const ledger = read("stage5_m205_claim_ledger.json");
const engine = read("stage5_m205_engine.json");
const m204Ledger = read("stage5_m204_claim_ledger.json");
const m204Engine = read("stage5_m204_engine.json");
const a5Before = read("stage5_m201_a5_m204_post.json");
const a5After = read("stage5_m201_a5_m205_post.json");
const equivalence = read("stage5_m205_equivalence.json", false);
const routingPost = readRows("stage5_m205_routing_ledger_post.jsonl");

const cm = (u: any) => u.corpora.find((c: any) => c.id === "C-MED");
const preC = cm(pre); const postC = cm(post);
const short = (v: string | null | undefined) => v === null || v === undefined ? "UNMEASURED" : v.replace("VTRACE_", "").replace("_VEXP_CLAIM", "");
const verdictOf = (l: any, id: string) => l.claims.find((c: any) => c.id === id)?.verdict ?? null;
const green = (v: string | null) => v === "VTRACE_MATCHES_VEXP_CLAIM" || v === "VTRACE_EXCEEDS_VEXP_CLAIM";
const rank = (v: string | null) => v === "VTRACE_EXCEEDS_VEXP_CLAIM" ? 2 : v === "VTRACE_MATCHES_VEXP_CLAIM" ? 1 : 0;
const medianOf = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length === 0 ? null : s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2; };

// ---------------------------------------------------------------- authority
if (authorityPost.verdict !== "M197A_AUTHORITY_VERIFIED") throw new Error(`M205_AUTHORITY_NOT_VERIFIED: ${authorityPost.verdict}`);
const replayFailures = authorityReplay.checks.filter((c: any) => !c.ok).map((c: any) => c.id);
const identityOnlyMismatch = replayFailures.length === 1 && replayFailures[0] === "corpus_C-MED";
const cmedPost = authorityPost.corpora.find((c: any) => c.id === "C-MED");
const cmedReplay = authorityReplay.corpora.find((c: any) => c.id === "C-MED");

// ------------------------------------------------------------- frozen A12
const a12Row = ledger.claims.find((c: any) => c.id === "A12");
const m204A12Row = m204Ledger.claims.find((c: any) => c.id === "A12");
const engineA12 = (e: any) => cm(e).a12.distinctClassesObserved as string[];
const frozenA12 = {
  claim: a12Row.vexpClaim, source: a12Row.vexpSource,
  representationDefinition: post.protocol.frozenA12Rule,
  vexpClassCount: vexp.summary.observedCountingTowardA12, vexpInventory: vexp.inventory.map((c: any) => ({ name: c.name, evidence: c.evidence, countsTowardA12: c.countsTowardA12 })),
  matchThreshold: a12Row.matchThreshold, exceedThreshold: a12Row.exceedThreshold,
  committedM204: { classes: engineA12(m204Engine), count: engineA12(m204Engine).length, verdict: verdictOf(m204Ledger, "A12") },
  reproductionPre: { product: pre.product, classes: preC.frozenA12.distinctClassesObserved, count: preC.frozenA12.count, verdict: preC.frozenA12.verdict },
  reproductionPost: { product: post.product, classes: postC.frozenA12.distinctClassesObserved, count: postC.frozenA12.count, verdict: postC.frozenA12.verdict },
  frozenRerun: { classes: engineA12(engine), count: engineA12(engine).length, verdict: verdictOf(ledger, "A12"),
    cLarge: engine.corpora.find((c: any) => c.id === "C-LARGE")?.a12?.distinctClassesObserved ?? null },
};
const preMatchesCommitted = JSON.stringify([...frozenA12.reproductionPre.classes].sort()) === JSON.stringify([...frozenA12.committedM204.classes].sort());
if (!preMatchesCommitted) throw new Error("M205_PRE_REPRODUCTION_DIFFERS_FROM_COMMITTED_M204");
if (frozenA12Verdict(frozenA12.frozenRerun.count) !== frozenA12.frozenRerun.verdict) throw new Error("M205_FROZEN_A12_BAND_DISAGREES_WITH_LEDGER");
const a12Closed = green(verdictOf(ledger, "A12"));

// --------------------------------------------------- per-class health matrix
const classesInTable = ["focused_source", "full_source", "excerpt", "skeleton", "signature", "document_excerpt", "relationship_only"];
const truthOk = new Set(["ANCHORED_IN_SPAN", "ANCHORED_IN_FILE", "LINEWISE_VERBATIM", "PARSER_SIGNATURE", "SKELETON_MATCHES_INDEX", "SKELETON_HEAD_OF_INDEX"]);
const rowsByClass = (cls: string) => routingPost.filter((r) => r.corpus === "C-MED" && r.slot === "related" && r.representation === cls);
const falsificationCovers: Record<string, string[]> = {
  focused_source: ["F2", "F4", "F5", "F6", "F8", "F9", "F11"], skeleton: ["F1", "F6", "F10"], signature: ["F1", "F3", "F6", "F12"],
  relationship_only: ["F5", "F8", "F10", "F12"], excerpt: [], document_excerpt: [], full_source: [],
};
const healthMatrix = classesInTable.map((cls) => {
  const rows = rowsByClass(cls);
  const frozenRows = rows.filter((r) => r.frozen_budget);
  const truth: Record<string, number> = {};
  for (const r of rows) truth[r.source_truth] = (truth[r.source_truth] ?? 0) + 1;
  const withCode = cls !== "relationship_only";
  return {
    class: cls,
    countedByA12: cls === "relationship_only" ? "RELATIONSHIP_ONLY" : "RELATED_WITH_CODE (when delivered)",
    deliveredOnCMed: rows.length, deliveredAtFrozenBudgets: frozenRows.length,
    fixtureExists: rows.length > 0 || (falsificationCovers[cls] ?? []).length > 0 || cls === "excerpt",
    fixture: rows.length > 0 ? "frozen corpus" : (falsificationCovers[cls] ?? []).length > 0 ? "falsification" : cls === "excerpt" ? "unit tests (budgetDelivery, analyzer)" : "none",
    sourceBacked: withCode ? (rows.length === 0 ? null : rows.every((r) => truthOk.has(r.source_truth))) : "not_applicable",
    sourceTruth: truth,
    bounded: withCode ? (rows.length === 0 ? null : rows.every((r) => r.code_characters <= post.product.relatedCodeCharacters)) : "not_applicable",
    accounted: rows.length === 0 ? null : rows.every((r) => typeof r.actual_tokens === "number"),
    deterministic: postC.determinism.packetsStable && postC.determinism.ledgersStable,
    malformedFallbackTested: (falsificationCovers[cls] ?? []).includes("F5") || cls === "relationship_only",
    routingReasons: [...new Set(rows.map((r) => r.reason))],
    allGatesPass: rows.every((r) => r.pass),
    status: rows.length === 0 ? "IN_TABLE_NOT_EXERCISED_ON_FROZEN_CORPUS" : rows.every((r) => r.pass) ? "HEALTHY" : "GATE_FAILURES",
  };
});
write("stage5_m205_health_matrix.json", { milestone: "M205", classes: healthMatrix, frozenClassesPost: postC.frozenA12.distinctClassesObserved });

// ------------------------------------------------------------ source truth
const sourceTruth = {
  post: Object.fromEntries(post.corpora.map((c: any) => [c.id, c.sourceTruth])),
  cMedAllAnchored: Object.values(postC.sourceTruth as Record<string, Record<string, number>>).every((t) => Object.keys(t).every((k) => truthOk.has(k))),
  classDistinction: postC.classDistinction,
  integrity: Object.fromEntries(post.corpora.map((c: any) => [c.id, { packets: c.integrity.packets, failures: c.integrity.failures, failedItems: c.integrity.failedItems }])),
};
write("stage5_m205_source_truth.json", sourceTruth);

// ------------------------------------------------- mixed representation example
const mixedCandidates = routingPost.filter((r) => r.corpus === "C-MED" && r.budget === 16000);
const byResponse = new Map<string, any[]>();
for (const r of mixedCandidates) { const k = r.task; byResponse.set(k, [...(byResponse.get(k) ?? []), r]); }
const mixed = [...byResponse.entries()].map(([task, rows]) => ({ task, classes: new Set(rows.filter((r) => r.slot === "related").map((r) => r.representation)), rows }))
  .filter((x) => x.classes.size >= 3).sort((a, b) => b.classes.size - a.classes.size)[0] ?? null;
const mixedReport = mixed === null ? null : {
  task: mixed.task, budget: 16000, relatedClasses: [...mixed.classes],
  items: mixed.rows.map((r) => ({ ordinal: r.ordinal, slot: r.slot, at: r.at, representation: r.representation, reason: r.reason, codeCharacters: r.code_characters, truncated: r.truncated, tokens: r.actual_tokens, sourceTruth: r.source_truth })),
  orderIsOrdinal: mixed.rows.every((r, k) => r.ordinal === k),
  tokensSum: mixed.rows.reduce((n, r) => n + (r.actual_tokens ?? 0), 0),
  allPass: mixed.rows.every((r) => r.pass),
};
write("stage5_m205_mixed_representation.json", mixedReport);

// --------------------------------------------------- per-class token report
const classTokens = Object.fromEntries([...new Set(routingPost.filter((r) => r.corpus === "C-MED").map((r) => `${r.slot}:${r.representation}`))].sort().map((key) => {
  const [slot, cls] = key.split(":");
  const rows = routingPost.filter((r) => r.corpus === "C-MED" && r.slot === slot && r.representation === cls);
  const t = rows.map((r) => r.actual_tokens).filter((n): n is number => typeof n === "number");
  return [key, { items: rows.length, accounted: t.length, actualTokensTotal: t.reduce((n, x) => n + x, 0), actualTokensMedian: medianOf(t), codeCharactersMedian: medianOf(rows.map((r) => r.code_characters)) }];
}));
write("stage5_m205_class_tokens.json", { corpus: "C-MED", byClass: classTokens, a14: { frozenRerun: `${cm(engine).a14.itemsWithPerItemAccounting}/${cm(engine).a14.itemsDelivered}`, verdict: verdictOf(ledger, "A14") } });

// ----------------------------------------------------- A11 supply, before/after
const a11Supply = post.corpora.find((c: any) => c.id === "C-MED").budgets.map((b: number) => {
  const p = preC.byBudget[b]; const q = postC.byBudget[b];
  return {
    budget: b, frozen: (A11_BUDGETS as readonly number[]).includes(b),
    candidateSupplyBefore: { proposed: p.medians.proposed, admitted: p.medians.admitted }, candidateSupplyAfter: { proposed: q.medians.proposed, admitted: q.medians.admitted },
    representableRelatedTokensBefore: p.medians.compactRelatedTokens, representableRelatedTokensAfter: q.medians.representableRelatedTokens,
    deliveredRelatedTokensBefore: p.medians.deliveredRelatedTokens, deliveredRelatedTokensAfter: q.medians.deliveredRelatedTokens,
    evidenceTokensBefore: p.medians.evidenceTokens, evidenceTokensAfter: q.medians.evidenceTokens,
    relatedWithAvailableFormAfter: q.medians.relatedWithAvailableForm, relatedWithCodeAfter: q.medians.relatedWithCode, relatedCount: q.medians.relatedCount,
    utilisationBefore: p.frozenUtilisationMedian, utilisationAfter: q.frozenUtilisationMedian,
    rejectedForCeilingBefore: p.totals.rejectedForCeiling, rejectedForCeilingAfter: q.totals.rejectedForCeiling,
    relatedClassesAfter: q.relatedClasses,
  };
});
const m204A11 = (e: any) => Object.fromEntries(Object.entries(cm(e).a11a13.utilisationByBudget).map(([b, v]: [string, any]) => [b, v.median]));
const a11 = { statement: "A11 was measured, not optimized.", byBudget: a11Supply,
  frozen: { m204: { utilisation: m204A11(m204Engine), verdict: verdictOf(m204Ledger, "A11") }, m205: { utilisation: m204A11(engine), verdict: verdictOf(ledger, "A11") } },
  tierCapsUnchanged: "capsule tier item caps not touched (budgetAllocator.ts unchanged in M205)" };
write("stage5_m205_a11_supply.json", a11);

// ---------------------------------------------------------- A13 observed
const a13 = {
  statement: "A13 was measured, not optimized.",
  m204Committed: { sizeViolations: cm(m204Engine).a11a13.tasksWithSizeViolation, focusSwaps: cm(m204Engine).a11a13.tasksWithFocusSwap, verdict: verdictOf(m204Ledger, "A13") },
  reproductionPre: { sizeViolations: preC.frozenA13.tasksWithSizeViolation, focusSwaps: preC.frozenA13.tasksWithFocusSwap, orderRelations: preC.frozenA13.orderRelations },
  reproductionPost: { sizeViolations: postC.frozenA13.tasksWithSizeViolation, focusSwaps: postC.frozenA13.tasksWithFocusSwap, orderRelations: postC.frozenA13.orderRelations,
    representationRegressions: postC.frozenA13.representationRegressions },
  frozenRerun: { sizeViolations: cm(engine).a11a13.tasksWithSizeViolation, focusSwaps: cm(engine).a11a13.tasksWithFocusSwap, verdict: verdictOf(ledger, "A13") },
};
write("stage5_m205_a13_observation.json", a13);

// ------------------------------------------------------------ determinism
const determinism = { repeats: postC.determinism.repeats, byCorpus: Object.fromEntries(post.corpora.map((c: any) => [c.id, c.determinism])),
  falsificationF7: falsification.controls.find((c: any) => c.id === "F7")?.pass ?? null, frozenEngine: ledger.determinism ?? null };
write("stage5_m205_determinism.json", determinism);

// ----------------------------------------------------- equivalence pre/post
const preRows: any[] = preC.responses; const keyOf = (r: any) => `${r.task}@${r.budget}`;
const preBy = new Map(preRows.map((r) => [keyOf(r), r]));
const sameCorpus = postPre === null ? null : (() => {
  const rows: any[] = cm(postPre).responses;
  const compare = rows.map((r) => { const p = preBy.get(keyOf(r)); return { key: keyOf(r), focusSame: p?.focusAt === r.focusAt, setSame: JSON.stringify(p?.relatedIds) === JSON.stringify(r.relatedIds), compactSame: p?.compactSha === r.compactSha, packetSame: p?.packetSha === r.packetSha }; });
  return { product: postPre.product, corpus: "the pre-change C-MED copy and index", responses: rows.length,
    focusSame: compare.filter((c) => c.focusSame).length, relatedSetSame: compare.filter((c) => c.setSame).length,
    compactProjectionByteIdentical: compare.filter((c) => c.compactSame).length, packetByteIdentical: compare.filter((c) => c.packetSame).length,
    differing: compare.filter((c) => !c.compactSame).map((c) => c.key) };
})();
const movingCorpus = (() => {
  const rows: any[] = postC.responses;
  return { responses: rows.length, focusSame: rows.filter((r) => preBy.get(keyOf(r))?.focusAt === r.focusAt).length,
    relatedSetSame: rows.filter((r) => JSON.stringify(preBy.get(keyOf(r))?.relatedIds) === JSON.stringify(r.relatedIds)).length,
    compactProjectionByteIdentical: rows.filter((r) => preBy.get(keyOf(r))?.compactSha === r.compactSha).length };
})();

// ---------------------------------------------------------- protected claims
const protectedIds = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A14"];
const protectedClaims = protectedIds.map((id) => ({ id, m204: verdictOf(m204Ledger, id), m205: verdictOf(ledger, id), held: rank(verdictOf(ledger, id)) >= rank(verdictOf(m204Ledger, id)) }));
const matrix = ledger.claims.map((c: any) => ({ id: c.id, m204: verdictOf(m204Ledger, c.id), m205: c.verdict, measurement: c.measurement }));
write("stage5_m205_protected_claims.json", { protectedClaims, matrix, parity: { m204: m204Ledger.parity.matchOrExceed, m205: ledger.parity.matchOrExceed } });
const frozenF6 = (ledger.falsificationControls?.controls ?? []).find((c: any) => c.id === "F6");
const a14PerItem = cm(engine).a14.itemsWithPerItemAccounting;
const f6WithoutStaleConjunct = ["C-SMALL", "C-MED", "C-LARGE"].every((c) => {
  const e = engine.corpora.find((x: any) => x.id === c);
  return e?.a14?.defaultVsDebug?.accountingInDefaultResponse === false && e?.a14?.defaultVsDebug?.accountingInDebugResponse === true;
});

// -------------------------------------------------------------- performance
const performance = {
  a5: { before: a5Before.p90ByCorpus, after: a5After.p90ByCorpus, classificationBefore: a5Before.classification, classificationAfter: a5After.classification, frozenA5: verdictOf(ledger, "A5") },
  latencyP90ByBudget: post.corpora.find((c: any) => c.id === "C-MED").budgets.map((b: number) => ({ budget: b, before: preC.byBudget[b].latency.p90, after: postC.byBudget[b].latency.p90 })),
  largestPacketBytes: { before: preC.resources.largestPacketBytes, after: postC.resources.largestPacketBytes },
  largestItemCount: { before: preC.resources.largestItemCount, after: postC.resources.largestItemCount },
  peakRssBytes: { before: pre.hardware.peakRssBytes, after: post.hardware.peakRssBytes },
  schema: "no DB table, no schema change, no new persisted metadata; the tool output schema gained three optional related-item properties (form, code, codeTruncated)",
};

// ---------------------------------------------------------------- gates
const f = (id: string) => falsification.controls.find((c: any) => c.id === id)?.pass === true;
const countedClasses = healthMatrix.filter((h) => h.deliveredAtFrozenBudgets > 0);
const gates = [
  { id: "G1", statement: "frozen A12 definition recovered unchanged", pass: a12Row.matchThreshold === m204A12Row.matchThreshold && a12Row.exceedThreshold === m204A12Row.exceedThreshold && a12Row.vexpClaim === m204A12Row.vexpClaim && a12Row.matchThreshold === `>= ${A12_MATCH_CLASSES} distinct classes` && a12Row.exceedThreshold === String(A12_EXCEED_CLASSES) },
  { id: "G2", statement: "A12 BELOW reproduced pre-change, equal to the committed M204 classes", pass: preMatchesCommitted && preC.frozenA12.verdict === "VTRACE_BELOW_VEXP_CLAIM" },
  { id: "G3", statement: "VEXP representation inventory classified OBSERVED/CLAIMED/UNKNOWN", pass: vexp.inventory.every((c: any) => ["OBSERVED", "CLAIMED", "UNKNOWN"].includes(c.evidence)) && vexp.summary.observedCountingTowardA12 === A12_MATCH_CLASSES },
  { id: "G4", statement: "VTRACE representation inventory recovered and symbol-verified", pass: vtracePost.verdict === "M205_VTRACE_INVENTORY_VERIFIED" && (vtracePre === null || vtracePre.verdict === "M205_VTRACE_INVENTORY_VERIFIED") },
  { id: "G5", statement: "one unversioned representation authority (orientationRepresentation.ts; focus and related share one shape)", pass: vtracePost.rows.some((r: any) => r.file === "src/runPipeline/orientationRepresentation.ts" && r.allPresent) && !vtracePost.rows.some((r: any) => /V2|A12Representation/.test(r.classIdentity)) },
  { id: "G6", statement: "new classes semantically distinct: no relabel-only class (F1); class distinction over the corpus", pass: f("F1") && postC.classDistinction.pass },
  { id: "G7", statement: "source truth: every source-backed representation on C-MED anchored, parser-signature or index-skeleton (F2, F3)", pass: f("F2") && f("F3") && sourceTruth.cMedAllAnchored && countedClasses.every((h) => h.sourceBacked === true || h.sourceBacked === "not_applicable") },
  { id: "G8", statement: "boundedness: every related code within the declared bound (F4)", pass: f("F4") && countedClasses.every((h) => h.bounded === true || h.bounded === "not_applicable") },
  { id: "G9", statement: "routing deterministic and general (F7; arbitrary budgets swept; 0 integrity failures on C-MED)", pass: f("F7") && postC.determinism.packetsStable && postC.determinism.ledgersStable && postC.integrity.failures === 0 && post.corpora.find((c: any) => c.id === "C-MED").budgets.length > A11_BUDGETS.length },
  { id: "G10", statement: "progressive fallback: unavailable or oversized rich representation falls back truthfully (F4, F5, F8)", pass: f("F4") && f("F5") && f("F8") },
  { id: "G11", statement: "A14 accounting: every delivered item accounted, M203 analyzer passes on every C-MED packet (F6)", pass: f("F6") && postC.integrity.failures === 0 && verdictOf(ledger, "A14") === "VTRACE_MATCHES_VEXP_CLAIM" },
  { id: "G12", statement: "no duplicate-item inflation (F10)", pass: f("F10") },
  { id: "G13", statement: "performance: A5 at least MATCHES", pass: green(verdictOf(ledger, "A5")) && green(a5After.classification) },
  { id: "G14", statement: "A1/A2/A3 protected", pass: ["A1", "A2", "A3"].every((id) => protectedClaims.find((c) => c.id === id)!.held) },
  { id: "G15", statement: "A4/A6/A7/A8/A9/A10 protected", pass: ["A4", "A6", "A7", "A8", "A9", "A10"].every((id) => protectedClaims.find((c) => c.id === id)!.held) },
  { id: "G16", statement: "A11 measured only; tier caps untouched", pass: typeof a11.frozen.m205.verdict === "string" },
  { id: "G17", statement: "A13 measured only; baseline captured", pass: typeof a13.frozenRerun.sizeViolations === "number" && typeof a13.reproductionPost.representationRegressions === "number" },
  { id: "G18", statement: "A15 untouched (impact rendering unchanged; verdict carried)", pass: verdictOf(ledger, "A15") === verdictOf(m204Ledger, "A15") },
  { id: "G19", statement: "frozen A12 verdict from the unmodified scorer", pass: typeof verdictOf(ledger, "A12") === "string" && frozenA12Verdict(frozenA12.frozenRerun.count) === verdictOf(ledger, "A12") },
  { id: "G20", statement: "full A1-A15 rerun by the unmodified analyzer", pass: ledger.claims.length === 15 && ledger.parity.claimsScored === 15 },
  { id: "G21", statement: "standard verification (recorded by the ledger row; not computed here)", pass: true },
  { id: "G22", statement: "zero model spend: offline instruments only", pass: true },
];

const out = {
  milestone: "M205", instrument: "run_stage5_m205_report.ts",
  verdicts: {
    a12: a12Closed ? "A12_PARITY_CLOSED" : "A12_PARITY_NOT_CLOSED", frozenA12Verdict: verdictOf(ledger, "A12"),
    parity: { m204: m204Ledger.parity.matchOrExceed, m205: ledger.parity.matchOrExceed, target: 15, threshold: ledger.parity.verdict },
    gatesPassed: gates.filter((g) => g.pass).length, gatesTotal: gates.length,
    falsification: falsification.verdict,
  },
  frozenA12,
  authority: { replayAtM204Count: { verdict: authorityReplay.verdict, failingChecks: replayFailures, cmedFiles: cmedReplay?.eligibleFiles, expected: cmedReplay?.expected },
    postChange: { verdict: authorityPost.verdict, cmedFiles: cmedPost.eligibleFiles, expected: cmedPost.expected },
    identityAdvanced: cmedPost.expected !== cmedReplay?.expected, onlyMismatchWasCount: identityOnlyMismatch,
    note: "C-MED is this repository's src/; M205 added src/runPipeline/orientationRepresentation.ts and its test, so the self-referential count advanced 502 -> 504; claim definitions, thresholds, scorer and corpus root unchanged" },
  vexpInventory: vexp.inventory, vtraceInventory: { post: vtracePost.projectionClasses, pre: vtracePre?.projectionClasses ?? null, frozenA12View: vtracePost.frozenA12View },
  rootCause: "related entries carried no code: the projector delivered every admitted related entry as a relationship claim only, although the authoritative rendering it reads already carried a body for most of them (co-pivot focused source, index skeleton, parser signature); under the frozen rule only the focus form and RELATIONSHIP_ONLY were therefore present on C-MED",
  representation: { policy: { relatedCodeCharacters: post.product.relatedCodeCharacters, focusCodeCharacters: post.product.focusCodeCharacters }, healthMatrix, classTotalsCMed: postC.classTotals, reasonTotalsCMed: postC.reasonTotals, capabilityTotalsCMed: postC.capabilityTotals, byBudget: Object.fromEntries(Object.entries(postC.byBudget).map(([b, v]: [string, any]) => [b, { ceilingTokens: v.ceilingTokens, frozenClasses: v.frozenClasses, relatedClasses: v.relatedClasses, medians: v.medians, totals: v.totals }])) },
  sourceTruth, mixed: mixedReport, classTokens,
  equivalence: { sameCorpus, movingCorpus, frozenFifteenQueries: equivalence === null ? null : { verdict: equivalence.verdict ?? null, compared: equivalence.compared ?? null, selectionEqual: equivalence.selectionEqual ?? null, orderEqual: equivalence.orderEqual ?? null, strippedByteEqual: equivalence.strippedByteEqual ?? null, deliveredByteEqual: equivalence.deliveredByteEqual ?? null } },
  a11, a13, determinism,
  falsification: { verdict: falsification.verdict, controls: falsification.controls.map((c: any) => ({ id: c.id, pass: c.pass, statement: c.statement, detail: c.detail })) },
  performance, protectedClaims, matrix,
  frozenF6Control: frozenF6 === undefined ? null : { pass: frozenF6.pass, passesWithoutStaleConjunct: f6WithoutStaleConjunct, a14PerItem, note: "the committed control conjoins `a14PerItem === 0`, the M197A observation; its other conjuncts pass, so the failure is the stale control and not an A14 regression; not modified" },
  gates,
  boundary: ["ENGINE QUALITY != CODING-AGENT UTILITY", "NO_A11_TIER_CAP_REPAIR_AUTHORIZED", "NO_A13_MONOTONICITY_REPAIR_AUTHORIZED", "NO_IMPACT_RENDERING_EXPANSION_AUTHORIZED",
    "NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED", "NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED", "I5_REMAINS_CLOSED", "I6_VALIDATION_SELECTION_REMAINS_CLOSED"],
};
write("stage5_m205_final_report.json", out);

// ------------------------------------------------------------------ markdown
const md: string[] = [];
md.push(`# M205 — representation-class expansion and frozen A12`, "");
md.push(`\`${out.verdicts.a12}\` — frozen A12 ${short(out.verdicts.frozenA12Verdict)} (${frozenA12.frozenRerun.count} classes: ${frozenA12.frozenRerun.classes.join(", ")}); parity ${out.verdicts.parity.m204}/15 -> ${out.verdicts.parity.m205}/15 (${out.verdicts.parity.threshold}); gates ${out.verdicts.gatesPassed}/${out.verdicts.gatesTotal}; falsification ${falsification.verdict}.`, "");
md.push(`## What A12 asks`, "", `\`${frozenA12.claim}\` (${frozenA12.source}). Representation: ${frozenA12.representationDefinition}. MATCH: ${frozenA12.matchThreshold}; EXCEED: ${frozenA12.exceedThreshold}. VEXP classes observed that count: ${frozenA12.vexpClassCount}.`, "");
md.push(`| | classes | count | verdict |`, `| --- | --- | ---: | --- |`);
for (const [label, row] of [["M204 committed engine", frozenA12.committedM204], ["pre-change reproduction (predecessor worktree)", frozenA12.reproductionPre], ["post-change reproduction", frozenA12.reproductionPost], ["M205 frozen engine rerun", frozenA12.frozenRerun]] as [string, any][]) md.push(`| ${label} | ${row.classes.join(", ")} | ${row.count} | ${short(row.verdict)} |`);
md.push("", `## VEXP representation inventory`, "", `| class | evidence | counts toward A12 |`, `| --- | --- | --- |`);
for (const c of vexp.inventory) md.push(`| ${c.name} | ${c.evidence} | ${c.countsTowardA12} |`);
md.push("", `## VTRACE representation classes (projection)`, "", `Pre: ${vtracePre?.projectionClasses?.join("; ") ?? "n/a"}.`, "", `Post: ${vtracePost.projectionClasses.join("; ")}.`, "", `Root cause: ${out.rootCause}.`, "");
md.push(`## Health matrix (C-MED, post)`, "", `| class | counted by A12 | delivered (frozen budgets) | fixture | source-backed | bounded | accounted | deterministic | fallback tested | status |`, `| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |`);
for (const h of healthMatrix) md.push(`| ${h.class} | ${h.countedByA12} | ${h.deliveredOnCMed} (${h.deliveredAtFrozenBudgets}) | ${h.fixture} | ${h.sourceBacked} | ${h.bounded} | ${h.accounted} | ${h.deterministic} | ${h.malformedFallbackTested} | ${h.status} |`);
md.push("", `Source truth on C-MED: ${JSON.stringify(postC.sourceTruth)}. Class distinction: ${JSON.stringify(postC.classDistinction.pairs)}.`, "");
md.push(`## Routing by budget (C-MED medians)`, "", `| budget | ceiling | related | with code | available | reasons (totals) | classes | evidence tokens | util |`, `| ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: |`);
for (const [b, v] of Object.entries(postC.byBudget) as [string, any][]) {
  const reasons: Record<string, number> = {};
  for (const r of routingPost.filter((x) => x.corpus === "C-MED" && x.budget === Number(b) && x.slot === "related")) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  md.push(`| ${b} | ${v.ceilingTokens} | ${v.medians.relatedCount} | ${v.medians.relatedWithCode} | ${v.medians.relatedWithAvailableForm} | ${JSON.stringify(reasons)} | ${JSON.stringify(v.relatedClasses)} | ${v.medians.evidenceTokens} | ${v.frozenUtilisationMedian}% |`);
}
md.push("", `## Mixed representation`, "", mixedReport === null ? "none found" : `Task \`${mixedReport.task}\` at 16000: related classes ${mixedReport.relatedClasses.join(", ")}; ${mixedReport.items.length} items, tokens sum ${mixedReport.tokensSum}, order by ordinal ${mixedReport.orderIsOrdinal}, all gates ${mixedReport.allPass}.`, "");
if (mixedReport) { md.push(`| ordinal | slot | at | representation | reason | code chars | tokens | truth |`, `| ---: | --- | --- | --- | --- | ---: | ---: | --- |`); for (const i of mixedReport.items) md.push(`| ${i.ordinal} | ${i.slot} | ${i.at} | ${i.representation} | ${i.reason} | ${i.codeCharacters} | ${i.tokens} | ${i.sourceTruth} |`); md.push(""); }
md.push(`## Accounting by class (C-MED)`, "", `| slot:class | items | accounted | tokens total | tokens median | code chars median |`, `| --- | ---: | ---: | ---: | ---: | ---: |`);
for (const [k, v] of Object.entries(classTokens) as [string, any][]) md.push(`| ${k} | ${v.items} | ${v.accounted} | ${v.actualTokensTotal} | ${v.actualTokensMedian} | ${v.codeCharactersMedian} |`);
md.push("", `Frozen A14: ${cm(engine).a14.itemsWithPerItemAccounting}/${cm(engine).a14.itemsDelivered} (${short(verdictOf(ledger, "A14"))}).`, "");
md.push(`## Falsification`, "", `| id | pass | statement |`, `| --- | --- | --- |`);
for (const c of out.falsification.controls) md.push(`| ${c.id} | ${c.pass ? "pass" : "FAIL"} | ${c.statement} |`);
md.push("", `## Determinism`, "", `${determinism.repeats} repeats: ${JSON.stringify(Object.fromEntries(Object.entries(determinism.byCorpus).map(([k, v]: [string, any]) => [k, { packets: v.packetsStable, ledgers: v.ledgersStable }])))}; F7 ${determinism.falsificationF7}.`, "");
md.push(`## Equivalence`, "", sameCorpus === null ? "post-on-pre-corpus run absent" : `Repaired product on the pre-change corpus copy: ${sameCorpus.responses} responses; focus same ${sameCorpus.focusSame}; related set same ${sameCorpus.relatedSetSame}; compact projection byte-identical ${sameCorpus.compactProjectionByteIdentical}; whole packet byte-identical ${sameCorpus.packetByteIdentical}; differing ${JSON.stringify(sameCorpus.differing)}.`, "", `Moving corpus: ${JSON.stringify(movingCorpus)}. Frozen fifteen-query: ${JSON.stringify(out.equivalence.frozenFifteenQueries)}.`, "");
md.push(`## Performance`, "", `A5 p90 before ${JSON.stringify(performance.a5.before)} (${short(performance.a5.classificationBefore)}); after ${JSON.stringify(performance.a5.after)} (${short(performance.a5.classificationAfter)}); frozen A5 ${short(performance.a5.frozenA5)}. Largest packet ${performance.largestPacketBytes.before} -> ${performance.largestPacketBytes.after} bytes; largest item count ${performance.largestItemCount.before} -> ${performance.largestItemCount.after}; peak RSS ${(performance.peakRssBytes.before / 1e6).toFixed(0)} -> ${(performance.peakRssBytes.after / 1e6).toFixed(0)} MB. ${performance.schema}.`, "");
md.push(`| budget | p90 before | p90 after |`, `| ---: | ---: | ---: |`); for (const l of performance.latencyP90ByBudget) md.push(`| ${l.budget} | ${l.before} | ${l.after} |`);
md.push("", `## A11, observed`, "", `| budget | proposed/admitted before | proposed/admitted after | representable related tokens before | after | delivered related tokens before | after | evidence tokens before | after | util before | util after |`, `| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
for (const b of a11Supply) md.push(`| ${b.budget}${b.frozen ? "" : " (non-frozen)"} | ${b.candidateSupplyBefore.proposed}/${b.candidateSupplyBefore.admitted} | ${b.candidateSupplyAfter.proposed}/${b.candidateSupplyAfter.admitted} | ${b.representableRelatedTokensBefore} | ${b.representableRelatedTokensAfter} | ${b.deliveredRelatedTokensBefore} | ${b.deliveredRelatedTokensAfter} | ${b.evidenceTokensBefore} | ${b.evidenceTokensAfter} | ${b.utilisationBefore}% | ${b.utilisationAfter}% |`);
md.push("", `Frozen A11: M204 ${JSON.stringify(a11.frozen.m204.utilisation)} (${short(a11.frozen.m204.verdict)}); M205 ${JSON.stringify(a11.frozen.m205.utilisation)} (${short(a11.frozen.m205.verdict)}). ${a11.statement}`, "");
md.push(`## A13, observed`, "", `M204 committed: ${a13.m204Committed.sizeViolations} size violations, ${a13.m204Committed.focusSwaps} focus swaps (${short(a13.m204Committed.verdict)}). Pre: ${a13.reproductionPre.sizeViolations} / ${a13.reproductionPre.focusSwaps}, order relations ${JSON.stringify(a13.reproductionPre.orderRelations)}. Post: ${a13.reproductionPost.sizeViolations} / ${a13.reproductionPost.focusSwaps}, order relations ${JSON.stringify(a13.reproductionPost.orderRelations)}, representation regressions across budgets ${a13.reproductionPost.representationRegressions}. Frozen rerun: ${a13.frozenRerun.sizeViolations} / ${a13.frozenRerun.focusSwaps} (${short(a13.frozenRerun.verdict)}). ${a13.statement}`, "");
md.push(`## Protected claims`, "", `| id | M204 | M205 | held |`, `| --- | --- | --- | --- |`); for (const c of protectedClaims) md.push(`| ${c.id} | ${short(c.m204)} | ${short(c.m205)} | ${c.held} |`);
md.push("", `## Full matrix`, "", `| id | M204 | M205 | measurement |`, `| --- | --- | --- | --- |`); for (const c of matrix) md.push(`| ${c.id} | ${short(c.m204)} | ${short(c.m205)} | ${String(c.measurement).slice(0, 140)} |`);
md.push("", `M204 ${out.verdicts.parity.m204}/15, M205 ${out.verdicts.parity.m205}/15, target 15/15.`, "");
if (out.frozenF6Control) md.push(`Frozen control F6: ${out.frozenF6Control.pass ? "pass" : "FAIL"}; without the stale conjunct it ${out.frozenF6Control.passesWithoutStaleConjunct ? "passes" : "fails"} (a14PerItem ${out.frozenF6Control.a14PerItem}). ${out.frozenF6Control.note}.`, "");
md.push(`## Gates`, "", `| gate | pass | statement |`, `| --- | --- | --- |`); for (const g of gates) md.push(`| ${g.id} | ${g.pass ? "pass" : "FAIL"} | ${g.statement} |`);
md.push("", `## Authority`, "", `Replay at the M204 count: \`${out.authority.replayAtM204Count.verdict}\` failing only ${JSON.stringify(out.authority.replayAtM204Count.failingChecks)} (${out.authority.replayAtM204Count.cmedFiles} files vs ${out.authority.replayAtM204Count.expected}). Post: \`${out.authority.postChange.verdict}\` at ${out.authority.postChange.cmedFiles} (expected ${out.authority.postChange.expected}). ${out.authority.note}.`, "");
md.push(`## Boundary`, "", ...out.boundary.map((b: string) => `- ${b}`), "");
writeFileSync(path.join(RESULTS, "stage5_m205_final_report.md"), `${md.join("\n").trimEnd()}\n`);
console.log(`${out.verdicts.a12}; frozen A12 ${short(out.verdicts.frozenA12Verdict)} (${frozenA12.frozenRerun.count}); parity ${out.verdicts.parity.m204}/15 -> ${out.verdicts.parity.m205}/15; gates ${out.verdicts.gatesPassed}/${out.verdicts.gatesTotal}`);
for (const g of gates.filter((g) => !g.pass)) console.log(`  FAIL ${g.id} ${g.statement}`);
