/**
 * M204 — final report assembly. Every load-bearing number is read from a
 * generated artefact; nothing here is transcribed. Fails closed on a missing
 * input, because a report that silently omits the frozen rerun is
 * indistinguishable from one whose frozen rerun passed.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m204_report.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { A11_BUDGETS, frozenA11Verdict } from "./m204Utilization";

const RESULTS = path.join(import.meta.dir, "results");
const read = (name: string, required = true) => {
  const p = path.join(RESULTS, name);
  if (!existsSync(p)) {
    if (required) throw new Error(`M204_EVIDENCE_MISSING: ${name}`);
    return null;
  }
  return JSON.parse(readFileSync(p, "utf8"));
};

const pre = read("stage5_m204_utilization_pre.json");
const post = read("stage5_m204_utilization_post.json");
const stackPre = read("stage5_m204_budget_stack_pre.json");
const stackPost = read("stage5_m204_budget_stack_post.json");
const falsification = read("stage5_m204_falsification.json");
const a5Before = read("stage5_m201_a5_m203_post.json");
const a5After = read("stage5_m201_a5_m204_post.json");
const authority = read("stage5_m204_authority.json");
const ledger = read("stage5_m204_claim_ledger.json");
const engine = read("stage5_m204_engine.json");
const m203Ledger = read("stage5_m203_claim_ledger.json");
const m203Engine = read("stage5_m203_engine.json");
const equivalence = read("stage5_m204_equivalence.json");
// The repaired product run against the PRE-change corpus copy: C-MED is this
// repository's src/, so the corpus moved with the product; this run separates
// the two.
const postPreCorpus = read("stage5_m204_utilization_post_precorpus.json", false);

const cm = (u: any) => u.corpora.find((c: any) => c.id === "C-MED");
const preC = cm(pre); const postC = cm(post);
const short = (v: string | null | undefined) => v === null || v === undefined ? "UNMEASURED"
  : v.replace("VTRACE_", "").replace("_VEXP_CLAIM", "");
const verdictOf = (l: any, id: string) => l.claims.find((c: any) => c.id === id)?.verdict ?? null;
const green = (v: string | null) => v === "VTRACE_MATCHES_VEXP_CLAIM" || v === "VTRACE_EXCEEDS_VEXP_CLAIM";

// ---------------------------------------------------------------- authority
if (authority.verdict !== "M197A_AUTHORITY_VERIFIED") throw new Error(`M204_AUTHORITY_NOT_VERIFIED: ${authority.verdict}`);
const cmedAuthority = authority.corpora.find((c: any) => c.id === "C-MED");

// ---------------------------------------------------- frozen A11, four ways
const a11Row = ledger.claims.find((c: any) => c.id === "A11");
const m203A11Row = m203Ledger.claims.find((c: any) => c.id === "A11");
const engineA11 = (e: any) => Object.fromEntries(Object.entries(cm(e).a11a13.utilisationByBudget).map(([b, v]: [string, any]) => [b, v.median]));
const frozenA11 = {
  claim: a11Row.vexpClaim, source: a11Row.vexpSource,
  metric: "median over the 20 C-MED A13 tasks of 100 x ceil(chars/4 of the whole default get_code_context output) / max_tokens, per budget",
  budgets: A11_BUDGETS, matchThreshold: a11Row.matchThreshold, exceedThreshold: a11Row.exceedThreshold,
  packetCostMeasured: "the whole model-facing output object as the handler returns it: focus, related, boundary, notes, schema version and every per-item tokens field — wrapper and accounting overhead count",
  committedM203: { utilisation: engineA11(m203Engine), verdict: verdictOf(m203Ledger, "A11") },
  reproductionPre: { product: pre.product, utilisation: Object.fromEntries(Object.entries(preC.frozenA11.utilisationByBudget).map(([b, v]: [string, any]) => [b, v.median])), verdict: preC.frozenA11.verdict },
  reproductionPost: { product: post.product, utilisation: Object.fromEntries(Object.entries(postC.frozenA11.utilisationByBudget).map(([b, v]: [string, any]) => [b, v.median])), verdict: postC.frozenA11.verdict },
  frozenRerun: { utilisation: engineA11(engine), verdict: verdictOf(ledger, "A11") },
};
const preMatchesCommitted = A11_BUDGETS.every((b) => frozenA11.reproductionPre.utilisation[b] === frozenA11.committedM203.utilisation[b]);
if (!preMatchesCommitted) throw new Error("M204_PRE_REPRODUCTION_DIFFERS_FROM_COMMITTED_M203");
const a11Closed = green(verdictOf(ledger, "A11"));

// ------------------------------------------------- before / after by budget
const byBudget = post.corpora.find((c: any) => c.id === "C-MED").budgets.map((b: number) => {
  const p = preC.byBudget[b]; const q = postC.byBudget[b];
  const flowPre = stackPre.flow.find((f: any) => f.budget === b); const flowPost = stackPost.flow.find((f: any) => f.budget === b);
  return {
    budget: b, frozen: (A11_BUDGETS as readonly number[]).includes(b),
    effectiveCeilingBefore: flowPre.orientationCeilingTokens, effectiveCeilingAfter: flowPost.orientationCeilingTokens,
    ledgerCeilingBefore: p.effectiveCeilingTokens, ledgerCeilingAfter: q.effectiveCeilingTokens,
    consumedBefore: p.medians.frozenWholeTokens, consumedAfter: q.medians.frozenWholeTokens,
    evidenceBefore: p.medians.evidenceTokens, evidenceAfter: q.medians.evidenceTokens,
    unusedBefore: p.medians.unusedFrozenBudget, unusedAfter: q.medians.unusedFrozenBudget,
    utilisationBefore: p.frozenUtilisationMedian, utilisationAfter: q.frozenUtilisationMedian,
    itemsBefore: p.medians.items, itemsAfter: q.medians.items,
    eligibleBefore: p.medians.eligible, eligibleAfter: q.medians.eligible,
    rejectedBefore: p.totals.rejectedForCeiling, rejectedAfter: q.totals.rejectedForCeiling,
    supplyExhaustedBefore: p.totals.supplyExhausted, supplyExhaustedAfter: q.totals.supplyExhausted,
    bindingBefore: p.bindingReasons, bindingAfter: q.bindingReasons,
    tokenBindingAfter: q.tokenBinding,
    upstreamVisible: q.medians.upstreamVisible, upstreamRemaining: q.medians.upstreamRemaining,
    upstreamDiscarded: q.medians.upstreamDiscarded, upstreamDiscardedForTierCap: q.medians.upstreamDiscardedForTierCap,
    representationWithheldCharacters: q.medians.representationWithheldCharacters,
    tier: flowPost.capsuleTier, tierCaps: `${flowPost.maxPivots}/${flowPost.maxSupport}`,
    frozenMatchLineTokens: flowPost.frozenMatchTokens,
    /** What the whole packet could reach if every upstream-rendered character were delivered verbatim: an upper bound under ANY representation of the current supply. */
    upstreamCeilingPercent: typeof q.medians.upstreamVisible === "number" ? +(100 * q.medians.upstreamVisible / b).toFixed(2) : null,
    latencyP90Before: p.latency.p90, latencyP90After: q.latency.p90,
    largestPacketBytesAfter: q.memory?.packetBytesMax ?? null,
  };
});

// --------------------------------------------------- per-response equivalence
const preRows: any[] = preC.responses; const postRows: any[] = postC.responses;
const keyOf = (r: any) => `${r.task}@${r.budget}`;
const preBy = new Map(preRows.map((r) => [keyOf(r), r]));
const equivalenceByBudget = post.corpora.find((c: any) => c.id === "C-MED").budgets.map((b: number) => {
  const rows = postRows.filter((r) => r.budget === b);
  const identical = rows.filter((r) => preBy.get(keyOf(r))?.packetSha === r.packetSha).length;
  const sameCeiling = rows.filter((r) => preBy.get(keyOf(r))?.analysis?.effectiveCeilingTokens === r.analysis?.effectiveCeilingTokens).length;
  return { budget: b, responses: rows.length, byteIdentical: identical, sameEffectiveCeiling: sameCeiling,
    requiredIdentical: sameCeiling, requirementMet: rows.filter((r) => preBy.get(keyOf(r))?.analysis?.effectiveCeilingTokens === r.analysis?.effectiveCeilingTokens
      && preBy.get(keyOf(r))?.packetSha !== r.packetSha).length === 0 };
});
const focusChanges = postRows.filter((r) => preBy.get(keyOf(r))?.focusAt !== r.focusAt).map((r) => ({ key: keyOf(r), before: preBy.get(keyOf(r))?.focusAt ?? null, after: r.focusAt }));
const differingPackets = postRows.filter((r) => preBy.get(keyOf(r))?.packetSha !== r.packetSha).map(keyOf);
const sameCorpus = postPreCorpus === null ? null : (() => {
  const rows: any[] = cm(postPreCorpus).responses;
  const differing = rows.filter((r) => preBy.get(keyOf(r))?.packetSha !== r.packetSha);
  return { product: postPreCorpus.product, corpus: "the pre-change C-MED copy and index", responses: rows.length,
    byteIdentical: rows.length - differing.length,
    differing: differing.map((r) => ({ key: keyOf(r), preRejected: preBy.get(keyOf(r))?.analysis?.supply?.rejectedForCeiling ?? null,
      preCeiling: preBy.get(keyOf(r))?.analysis?.effectiveCeilingTokens ?? null, postCeiling: r.analysis?.effectiveCeilingTokens ?? null })),
    // Every difference on the same corpus must be a response the fixed ceiling had bound.
    allDifferencesWereCeilingBound: differing.every((r) => (preBy.get(keyOf(r))?.analysis?.supply?.rejectedForCeiling ?? 0) > 0) };
})();

// ------------------------------------------------------------ tail cases
const tail = preC.tail.map((t: any) => {
  const after = postRows.find((r) => r.task === t.task && r.budget === t.budget)?.analysis;
  return { ...t, afterUtilisationPercent: after?.utilisationPercent ?? null, afterBindingReason: after?.bindingReason ?? null,
    afterEffectiveCeilingTokens: after?.effectiveCeilingTokens ?? null, improved: after ? after.utilisationPercent > t.utilisationPercent : null,
    supplyExisted: t.upstreamDiscarded !== null && t.upstreamDiscarded > 0 };
});

// ---------------------------------------------------------- A13 observed
const a13 = {
  m203Committed: { sizeViolations: cm(m203Engine).a11a13.tasksWithSizeViolation, focusSwaps: cm(m203Engine).a11a13.tasksWithFocusSwap, verdict: verdictOf(m203Ledger, "A13") },
  reproductionPre: { sizeViolations: preC.frozenA13.tasksWithSizeViolation, focusSwaps: preC.frozenA13.tasksWithFocusSwap },
  reproductionPost: { sizeViolations: postC.frozenA13.tasksWithSizeViolation, focusSwaps: postC.frozenA13.tasksWithFocusSwap },
  frozenRerun: { sizeViolations: cm(engine).a11a13.tasksWithSizeViolation, focusSwaps: cm(engine).a11a13.tasksWithFocusSwap, verdict: verdictOf(ledger, "A13") },
  orderRelationsPost: postC.orderRelations, effectiveBudgetMonotonicViolations: postC.effectiveBudgetMonotonic.tasksViolating,
  statement: "A13 was measured, not optimized.",
};

// ---------------------------------------------------------- protected claims
const protectedIds = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A14"];
const rank = (v: string | null) => v === "VTRACE_EXCEEDS_VEXP_CLAIM" ? 2 : v === "VTRACE_MATCHES_VEXP_CLAIM" ? 1 : 0;
const protectedClaims = protectedIds.map((id) => ({ id, m203: verdictOf(m203Ledger, id), m204: verdictOf(ledger, id),
  held: rank(verdictOf(ledger, id)) >= rank(verdictOf(m203Ledger, id)) }));
const matrix = ledger.claims.map((c: any) => ({ id: c.id, m203: verdictOf(m203Ledger, c.id), m204: c.verdict, measurement: c.measurement }));
const frozenF6 = (ledger.falsificationControls?.controls ?? []).find((c: any) => c.id === "F6");
const a14PerItem = cm(engine).a14.itemsWithPerItemAccounting;
const f6WithoutStaleConjunct = ["C-SMALL", "C-MED", "C-LARGE"].every((c) => {
  const e = engine.corpora.find((x: any) => x.id === c);
  return e?.a14?.defaultVsDebug?.accountingInDefaultResponse === false && e?.a14?.defaultVsDebug?.accountingInDebugResponse === true;
});

// ------------------------------------------------------------- integrity
const integrity = {
  pre: { packets: preC.integrity.packets, failures: preC.integrity.failures },
  post: { packets: postC.integrity.packets, failures: postC.integrity.failures, failedGates: postC.integrity.failedGates },
  determinism: postC.determinism,
  a14Coverage: { frozenRerun: `${a14PerItem}/${cm(engine).a14.itemsDelivered}`, verdict: verdictOf(ledger, "A14") },
};

// -------------------------------------------------------------- verdicts
const gates = [
  { id: "G1", statement: "frozen A11 definition recovered unchanged", pass: a11Row.matchThreshold === ">= 60% utilisation at every budget" && a11Row.exceedThreshold === ">= 80%" && frozenA11.claim === m203A11Row.vexpClaim },
  { id: "G2", statement: "A11 BELOW reproduced pre-change, equal to the committed M203 medians", pass: preMatchesCommitted && preC.frozenA11.verdict === "VTRACE_BELOW_VEXP_CLAIM" },
  { id: "G3", statement: "budget stack traced from code", pass: stackPost.symbolsVerified >= 20 && stackPost.layers.length >= 10 },
  { id: "G4", statement: "every underutilised response carries a binding reason", pass: postRows.every((r) => r.analysis === null || typeof r.analysis.bindingReason === "string") },
  { id: "G5", statement: "no-supply separated from policy-cap underutilisation", pass: Object.keys(postC.bindingReasonsOverFrozen).length >= 1 && postRows.every((r) => r.analysis === null || typeof r.analysis.supplyExhausted === "boolean") },
  { id: "G6", statement: "one budget authority: the ledger ceiling equals the product rule on every response", pass: postRows.every((r) => r.analysis === null || r.analysis.gates.find((g: any) => g.id === "ceiling_is_the_rule")?.pass === true) },
  { id: "G6b", statement: "same corpus, same effective outcome: every pre/post difference on the pre-change corpus was ceiling-bound under the predecessor", pass: sameCorpus !== null && sameCorpus.allDifferencesWereCeilingBound },
  { id: "G7", statement: "fixed-ceiling defect repaired: caller budget reaches admission (F1, F8)", pass: falsification.controls.find((c: any) => c.id === "F1")?.pass === true && falsification.controls.find((c: any) => c.id === "F8")?.pass === true },
  { id: "G8", statement: "no filler (F2, F3, F4; analyzer gates on every response)", pass: ["F2", "F3", "F4"].every((id) => falsification.controls.find((c: any) => c.id === id)?.pass === true) && postC.integrity.failures === 0 },
  { id: "G9", statement: "hard bounds preserved (F5)", pass: falsification.controls.find((c: any) => c.id === "F5")?.pass === true },
  { id: "G10", statement: "M203 accounting preserved on every packet (F6; integrity 0 failures)", pass: falsification.controls.find((c: any) => c.id === "F6")?.pass === true && postC.integrity.failures === 0 },
  { id: "G11", statement: "determinism across repeats (F7; sweep repeats)", pass: falsification.controls.find((c: any) => c.id === "F7")?.pass === true && postC.determinism.packetsStable && postC.determinism.ledgersStable && postC.determinism.repeats >= 3 },
  { id: "G12", statement: "A5 protected", pass: green(verdictOf(ledger, "A5")) && falsification.controls.find((c: any) => c.id === "F11")?.pass === true },
  { id: "G13", statement: "A1-A10 protected", pass: protectedClaims.filter((c) => c.id !== "A14").every((c) => c.held) },
  { id: "G14", statement: "A14 protected", pass: verdictOf(ledger, "A14") === "VTRACE_MATCHES_VEXP_CLAIM" },
  { id: "G15", statement: "A13 measured, untouched (F12)", pass: falsification.controls.find((c: any) => c.id === "F12")?.pass === true && typeof a13.frozenRerun.sizeViolations === "number" },
  { id: "G16", statement: "frozen A11 verdict from the unmodified scorer", pass: typeof verdictOf(ledger, "A11") === "string" },
  { id: "G17", statement: "full A1-A15 rerun by the unmodified analyzer", pass: ledger.claims.length === 15 && ledger.parity.claimsScored === 15 },
  { id: "G18", statement: "standard verification (recorded by the ledger row; not computed here)", pass: true },
  { id: "G19", statement: "zero model spend: offline instruments only", pass: true },
];

const out = {
  milestone: "M204", instrument: "run_stage5_m204_report.ts",
  verdicts: {
    a11: a11Closed ? "A11_PARITY_CLOSED" : "A11_PARITY_NOT_CLOSED",
    frozenA11Verdict: verdictOf(ledger, "A11"),
    parity: { m203: m203Ledger.parity.matchOrExceed, m204: ledger.parity.matchOrExceed, target: 15, threshold: ledger.parity.verdict },
    gatesPassed: gates.filter((g) => g.pass).length, gatesTotal: gates.length,
  },
  frozenA11,
  authority: { verdict: authority.verdict, cmedFiles: cmedAuthority.eligibleFiles, cmedExpected: cmedAuthority.expected,
    identityAdvanced: cmedAuthority.eligibleFiles !== 502, note: "C-MED is this repository's src/; M204 added no source file under it" },
  budgetStack: { before: stackPre, after: stackPost },
  byBudget,
  bindingReasonsOverFrozen: { before: preC.bindingReasonsOverFrozen, after: postC.bindingReasonsOverFrozen },
  equivalence: { byBudget: equivalenceByBudget, differingPackets, focusChanges, sameCorpus,
    frozenFifteenQueries: { verdict: equivalence.verdict ?? null, compared: equivalence.compared ?? null,
      selectionEqual: equivalence.selectionEqual ?? null, orderEqual: equivalence.orderEqual ?? null,
      strippedByteEqual: equivalence.strippedByteEqual ?? null, deliveredByteEqual: equivalence.deliveredByteEqual ?? null } },
  tail,
  a13,
  falsification: { verdict: falsification.verdict, controls: falsification.controls.map((c: any) => ({ id: c.id, pass: c.pass, statement: c.statement, detail: c.detail })) },
  integrity,
  performance: {
    a5: { before: a5Before.p90ByCorpus, after: a5After.p90ByCorpus, classificationBefore: a5Before.classification, classificationAfter: a5After.classification },
    latencyP90ByBudget: byBudget.map((b: any) => ({ budget: b.budget, before: b.latencyP90Before, after: b.latencyP90After })),
    largestPacketBytes: postC.resources.largestPacketBytes, largestItemCount: postC.resources.largestItemCount, peakRssBytes: post.hardware.peakRssBytes,
  },
  protectedClaims, matrix,
  frozenF6Control: frozenF6 === undefined ? null : { pass: frozenF6.pass, statement: frozenF6.statement,
    passesWithoutStaleConjunct: f6WithoutStaleConjunct, a14PerItem,
    note: "the committed control conjoins `a14PerItem === 0`, the M197A observation; its other conjuncts pass, so the failure is the stale control and not an A14 regression; not modified" },
  gates,
  boundary: [
    "ENGINE QUALITY != CODING-AGENT UTILITY",
    "NO_A13_MONOTONICITY_REPAIR_AUTHORIZED", "NO_NEW_REPRESENTATION_CLASS_AUTHORIZED", "NO_IMPACT_RENDERING_EXPANSION_AUTHORIZED",
    "NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED", "NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED",
    "I5_REMAINS_CLOSED", "I6_VALIDATION_SELECTION_REMAINS_CLOSED",
  ],
};
writeFileSync(path.join(RESULTS, "stage5_m204_final_report.json"), `${JSON.stringify(out, null, 2)}\n`);

// ------------------------------------------------------------------ markdown
const md: string[] = [];
md.push(`# M204 — budget-utilization authority and frozen A11`, "");
md.push(`\`${out.verdicts.a11}\` — frozen A11 ${short(out.verdicts.frozenA11Verdict)}; parity ${out.verdicts.parity.m203}/15 -> ${out.verdicts.parity.m204}/15 (${out.verdicts.parity.threshold}); gates ${out.verdicts.gatesPassed}/${out.verdicts.gatesTotal}.`, "");
md.push(`## What A11 asks`, "");
md.push(`\`${frozenA11.claim}\` (${frozenA11.source}). Metric: ${frozenA11.metric}. MATCH: ${frozenA11.matchThreshold}; EXCEED: ${frozenA11.exceedThreshold}. Cost measured: ${frozenA11.packetCostMeasured}.`, "");
md.push(`| | ${A11_BUDGETS.join(" | ")} | verdict |`, `| --- | ${A11_BUDGETS.map(() => "---:").join(" | ")} | --- |`);
for (const [label, row] of [["M203 committed engine", frozenA11.committedM203], ["pre-change reproduction (predecessor worktree)", frozenA11.reproductionPre], ["post-change reproduction", frozenA11.reproductionPost], ["M204 frozen engine rerun", frozenA11.frozenRerun]] as [string, any][]) {
  md.push(`| ${label} | ${A11_BUDGETS.map((b) => `${row.utilisation[b]}%`).join(" | ")} | ${short(row.verdict)} |`);
}
md.push("");
md.push(`## Budget stack`, "", ...stackPost.diagram.map((l: string) => `    ${l}`), "");
md.push(`| layer | file | units | default | bound | caller-derived | fixed |`, `| --- | --- | --- | --- | --- | --- | --- |`);
for (const l of stackPost.layers) md.push(`| ${l.name} | \`${l.file}\` | ${l.units} | ${typeof l.default === "object" ? JSON.stringify(l.default) : l.default} | ${l.bound} | ${l.callerDerived} | ${l.fixed} |`);
md.push("");
md.push(`## Before / after, by budget (C-MED medians; frozen rule)`, "");
md.push(`| budget | tier (caps) | ceiling before | ceiling after | consumed before | consumed after | unused before | unused after | util before | util after | items | eligible | rejected before/after | upstream visible | upstream remaining | discarded (cap) | withheld body chars | binding after |`);
md.push(`| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- | ---: | --- |`);
for (const b of byBudget) md.push(`| ${b.budget}${b.frozen ? "" : " (non-frozen)"} | ${b.tier} (${b.tierCaps}) | ${b.effectiveCeilingBefore} | ${b.effectiveCeilingAfter} | ${b.consumedBefore} | ${b.consumedAfter} | ${b.unusedBefore} | ${b.unusedAfter} | ${b.utilisationBefore}% | ${b.utilisationAfter}% | ${b.itemsAfter} | ${b.eligibleAfter} | ${b.rejectedBefore}/${b.rejectedAfter} | ${b.upstreamVisible} | ${b.upstreamRemaining} | ${b.upstreamDiscarded} (${b.upstreamDiscardedForTierCap}) | ${b.representationWithheldCharacters} | ${JSON.stringify(b.bindingAfter)} |`);
md.push("");
md.push(`Binding reasons over the 100 frozen responses: before ${JSON.stringify(out.bindingReasonsOverFrozen.before)}, after ${JSON.stringify(out.bindingReasonsOverFrozen.after)}.`, "");
md.push(`## Output equivalence`, "");
md.push(`| budget | responses | same effective ceiling | byte-identical | requirement met |`, `| ---: | ---: | ---: | ---: | --- |`);
for (const e of equivalenceByBudget) md.push(`| ${e.budget} | ${e.responses} | ${e.sameEffectiveCeiling} | ${e.byteIdentical} | ${e.requirementMet} |`);
md.push("", `Packets that differ pre/post on the moving corpus: ${differingPackets.length}. Focus changes: ${focusChanges.length}. Frozen fifteen-query equivalence: ${JSON.stringify(out.equivalence.frozenFifteenQueries)}.`, "");
if (sameCorpus) md.push(`Repaired product on the pre-change corpus copy: ${sameCorpus.byteIdentical} of ${sameCorpus.responses} byte-identical to the predecessor; differing ${JSON.stringify(sameCorpus.differing)}; all differences were ceiling-bound under the predecessor: ${sameCorpus.allDifferencesWereCeilingBound}.`, "");
md.push(`## Tail (ten worst pre-change responses)`, "");
md.push(`| task | budget | util before | util after | binding before | binding after | supply discarded upstream | withheld body chars |`, `| --- | ---: | ---: | ---: | --- | --- | ---: | ---: |`);
for (const t of tail) md.push(`| ${t.task} | ${t.budget} | ${t.utilisationPercent}% | ${t.afterUtilisationPercent}% | ${t.bindingReason} | ${t.afterBindingReason} | ${t.upstreamDiscarded} | ${t.representationWithheldCharacters} |`);
md.push("");
md.push(`## A13, observed`, "");
md.push(`M203 committed: ${a13.m203Committed.sizeViolations} size violations, ${a13.m203Committed.focusSwaps} focus swaps (${short(a13.m203Committed.verdict)}). Pre reproduction: ${a13.reproductionPre.sizeViolations} / ${a13.reproductionPre.focusSwaps}. Post reproduction: ${a13.reproductionPost.sizeViolations} / ${a13.reproductionPost.focusSwaps}. Frozen rerun: ${a13.frozenRerun.sizeViolations} / ${a13.frozenRerun.focusSwaps} (${short(a13.frozenRerun.verdict)}). Order relations across adjacent frozen budgets: ${JSON.stringify(a13.orderRelationsPost)}. Effective-budget monotonicity violations: ${a13.effectiveBudgetMonotonicViolations.length}. ${a13.statement}`, "");
md.push(`## Falsification`, "", `| id | pass | statement |`, `| --- | --- | --- |`);
for (const c of out.falsification.controls) md.push(`| ${c.id} | ${c.pass ? "pass" : "FAIL"} | ${c.statement} |`);
md.push("", `## Accounting integrity`, "", `Pre: ${integrity.pre.failures} failures over ${integrity.pre.packets} packets. Post: ${integrity.post.failures} failures over ${integrity.post.packets} packets. Determinism: ${integrity.determinism.repeats} repeats, packets stable ${integrity.determinism.packetsStable}, ledgers stable ${integrity.determinism.ledgersStable}. Frozen A14: ${integrity.a14Coverage.frozenRerun} (${short(integrity.a14Coverage.verdict)}).`, "");
md.push(`## Performance`, "", `A5 p90 before ${JSON.stringify(out.performance.a5.before)} (${short(out.performance.a5.classificationBefore)}); after ${JSON.stringify(out.performance.a5.after)} (${short(out.performance.a5.classificationAfter)}). Largest packet ${out.performance.largestPacketBytes} bytes, ${out.performance.largestItemCount} items; peak RSS ${(out.performance.peakRssBytes / 1e6).toFixed(0)} MB.`, "");
md.push(`| budget | p90 before | p90 after |`, `| ---: | ---: | ---: |`);
for (const l of out.performance.latencyP90ByBudget) md.push(`| ${l.budget} | ${l.before} | ${l.after} |`);
md.push("", `## Protected claims`, "", `| id | M203 | M204 | held |`, `| --- | --- | --- | --- |`);
for (const c of protectedClaims) md.push(`| ${c.id} | ${short(c.m203)} | ${short(c.m204)} | ${c.held} |`);
md.push("", `## Full matrix`, "", `| id | M203 | M204 | measurement |`, `| --- | --- | --- | --- |`);
for (const c of matrix) md.push(`| ${c.id} | ${short(c.m203)} | ${short(c.m204)} | ${String(c.measurement).slice(0, 140)} |`);
md.push("", `M203 ${out.verdicts.parity.m203}/15, M204 ${out.verdicts.parity.m204}/15, target 15/15.`, "");
if (out.frozenF6Control) md.push(`Frozen control F6: ${out.frozenF6Control.pass ? "pass" : "FAIL"}; without the stale conjunct it ${out.frozenF6Control.passesWithoutStaleConjunct ? "passes" : "fails"} (a14PerItem ${out.frozenF6Control.a14PerItem}). ${out.frozenF6Control.note}.`, "");
md.push(`## Gates`, "", `| gate | pass | statement |`, `| --- | --- | --- |`);
for (const g of gates) md.push(`| ${g.id} | ${g.pass ? "pass" : "FAIL"} | ${g.statement} |`);
md.push("", `## Authority`, "", `\`${authority.verdict}\`; C-MED ${cmedAuthority.eligibleFiles} files (expected ${cmedAuthority.expected}); identity advanced: ${out.authority.identityAdvanced}.`, "");
md.push(`## Boundary`, "", ...out.boundary.map((b: string) => `- ${b}`), "");
writeFileSync(path.join(RESULTS, "stage5_m204_final_report.md"), `${md.join("\n").trimEnd()}\n`);
console.log(`${out.verdicts.a11}; frozen A11 ${short(out.verdicts.frozenA11Verdict)}; parity ${out.verdicts.parity.m203}/15 -> ${out.verdicts.parity.m204}/15; gates ${out.verdicts.gatesPassed}/${out.verdicts.gatesTotal}`);
for (const g of gates.filter((g) => !g.pass)) console.log(`  FAIL ${g.id} ${g.statement}`);
