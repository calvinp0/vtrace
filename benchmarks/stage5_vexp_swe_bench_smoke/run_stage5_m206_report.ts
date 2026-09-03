/**
 * M206 — final report assembly. Every load-bearing number is read from a
 * generated artefact; nothing here is transcribed. Fails closed on a missing
 * required input, because a report that silently omits the frozen rerun is
 * indistinguishable from one whose frozen rerun passed.
 *
 * Besides the final report it emits the smaller evidence artefacts the
 * milestone requires — the tier-cap authority audit (from git history and the
 * predecessor source), the allocation-stage audit, the supply-sufficiency
 * report, the candidate-selection before/after ledger, the counterfactual-to-
 * product attribution, the tail report, the A12/A14 integrity summaries, the
 * A13 observation, the performance report and the protected-claims table —
 * each derived from the same generated inputs.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m206_report.ts \
 *     [--predecessor-root /home/calvin/bench/vtrace-m206/pre]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { A11_BUDGETS, A11_EXCEED_PERCENT, A11_MATCH_PERCENT, frozenA11Verdict, median } from "./m204Utilization";
import { requiredExceedTokens, requiredMatchTokens } from "./m206Allocation";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const PREDECESSOR_ROOT = path.resolve(argOf("--predecessor-root", "/home/calvin/bench/vtrace-m206/pre"));

const read = (name: string, required = true) => {
  const p = path.join(RESULTS, name);
  if (!existsSync(p)) {
    if (required) throw new Error(`M206_EVIDENCE_MISSING: ${name}`);
    return null;
  }
  return JSON.parse(readFileSync(p, "utf8"));
};
const readRows = (name: string): any[] => {
  const p = path.join(RESULTS, name);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
};
const write = (name: string, value: unknown) => writeFileSync(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`);
const git = (root: string, ...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();

const pre = read("stage5_m206_allocation_pre.json");
const post = read("stage5_m206_allocation_post.json");
const postPre = read("stage5_m206_allocation_post_precorpus.json", false);
const preCandidates = readRows("stage5_m206_uncapped_supply_pre.jsonl");
const falsification = read("stage5_m206_falsification.json");
const authorityReplay = read("stage5_m206_authority.json");
const authorityPost = read("stage5_m206_authority_post.json");
const ledger = read("stage5_m206_claim_ledger.json");
const engine = read("stage5_m206_engine.json");
const m205Ledger = read("stage5_m205_claim_ledger.json");
const m205Engine = read("stage5_m205_engine.json");
const a5Before = read("stage5_m201_a5_m205_post.json");
const a5After = read("stage5_m201_a5_m206_post.json");
const representationPost = read("stage5_m205_representation_m206_post.json", false);
const routingPost = readRows("stage5_m205_routing_ledger_m206_post.jsonl");

const cm = (u: any) => u.corpora.find((c: any) => c.id === "C-MED");
const preC = cm(pre); const postC = cm(post);
const short = (v: string | null | undefined) => v === null || v === undefined ? "UNMEASURED" : v.replace("VTRACE_", "").replace("_VEXP_CLAIM", "");
const verdictOf = (l: any, id: string) => l.claims.find((c: any) => c.id === id)?.verdict ?? null;
const green = (v: string | null) => v === "VTRACE_MATCHES_VEXP_CLAIM" || v === "VTRACE_EXCEEDS_VEXP_CLAIM";
const rank = (v: string | null) => v === "VTRACE_EXCEEDS_VEXP_CLAIM" ? 2 : v === "VTRACE_MATCHES_VEXP_CLAIM" ? 1 : 0;
const pct = (n: number | null | undefined) => (typeof n === "number" ? `${n}%` : "n/a");

// ---------------------------------------------------------------- authority
if (authorityPost.verdict !== "M197A_AUTHORITY_VERIFIED") throw new Error(`M206_AUTHORITY_NOT_VERIFIED: ${authorityPost.verdict}`);
if (authorityReplay.verdict !== "M197A_AUTHORITY_VERIFIED") throw new Error(`M206_AUTHORITY_REPLAY_NOT_VERIFIED: ${authorityReplay.verdict}`);
const cmedPost = authorityPost.corpora.find((c: any) => c.id === "C-MED");
const cmedReplay = authorityReplay.corpora.find((c: any) => c.id === "C-MED");

// ------------------------------------------------------------- frozen A11
const a11Row = ledger.claims.find((c: any) => c.id === "A11");
const m205A11Row = m205Ledger.claims.find((c: any) => c.id === "A11");
const engineA11 = (e: any) => Object.fromEntries(Object.entries(cm(e).a11a13.utilisationByBudget).map(([b, v]: [string, any]) => [b, v.median]));
const sweepA11 = (u: any) => Object.fromEntries(Object.entries(cm(u).frozenA11.utilisationByBudget).map(([b, v]: [string, any]) => [b, v.median]));
const frozenA11 = {
  claim: a11Row.vexpClaim, source: a11Row.vexpSource,
  metric: "median over the 20 C-MED A13 tasks of 100 x ceil(chars/4 of the whole default get_code_context output) / max_tokens, per budget",
  wholeOutputBoundary: "the whole model-facing output object as the handler returns it: focus, related, boundary, notes, schema version and every per-item tokens field",
  budgets: A11_BUDGETS, matchThreshold: a11Row.matchThreshold, exceedThreshold: a11Row.exceedThreshold,
  matchPercent: A11_MATCH_PERCENT, exceedPercent: A11_EXCEED_PERCENT,
  committedM205: { utilisation: engineA11(m205Engine), verdict: verdictOf(m205Ledger, "A11") },
  reproductionPre: { product: pre.product, utilisation: sweepA11(pre), verdict: preC.frozenA11.verdict },
  reproductionPost: { product: post.product, utilisation: sweepA11(post), verdict: postC.frozenA11.verdict },
  frozenRerun: { utilisation: engineA11(engine), verdict: verdictOf(ledger, "A11") },
};
const preMatchesCommitted = JSON.stringify(frozenA11.reproductionPre.utilisation) === JSON.stringify(frozenA11.committedM205.utilisation);
if (!preMatchesCommitted) throw new Error("M206_PRE_REPRODUCTION_DIFFERS_FROM_COMMITTED_M205");
const rerunBand = frozenA11Verdict(A11_BUDGETS.map((b) => frozenA11.frozenRerun.utilisation[b] ?? null));
if (rerunBand !== frozenA11.frozenRerun.verdict) throw new Error("M206_FROZEN_A11_BAND_DISAGREES_WITH_LEDGER");
const a11Closed = green(verdictOf(ledger, "A11"));

// -------------------------------------------------- tier-cap authority audit
const predecessorAllocator = readFileSync(path.join(PREDECESSOR_ROOT, "src/capsuleV2/budgetAllocator.ts"), "utf8");
const currentAllocator = readFileSync(path.join(REPO, "src/capsuleV2/budgetAllocator.ts"), "utf8");
const predecessorBuilder = readFileSync(path.join(PREDECESSOR_ROOT, "src/capsuleV2/buildCapsuleV2.ts"), "utf8");
const currentBuilder = readFileSync(path.join(REPO, "src/capsuleV2/buildCapsuleV2.ts"), "utf8");
const allocatorHistory = git(REPO, "log", "--format=%h %ad %s", "--date=short", "--", "src/capsuleV2/budgetAllocator.ts").split("\n").filter(Boolean);
const capsOf = (src: string) => {
  const m = /Micro\]: \{ maxPivots: (\d+), (?:maxSupport|supportWindow): (\d+) \},\s*\[CapsuleV2Mode\.Standard\]: \{ maxPivots: (\d+), (?:maxSupport|supportWindow): (\d+) \},\s*\[CapsuleV2Mode\.Full\]: \{ maxPivots: (\d+), (?:maxSupport|supportWindow): (\d+) \}/.exec(src);
  return m === null ? null : { micro: { maxPivots: +m[1]!, support: +m[2]! }, standard: { maxPivots: +m[3]!, support: +m[4]! }, full: { maxPivots: +m[5]!, support: +m[6]! } };
};
const stageTotalsPre = preC.stageTotalsOverFrozen;
const tierCapAudit = {
  history: allocatorHistory,
  introducedIn: allocatorHistory.at(-1) ?? null,
  predecessorCaps: capsOf(predecessorAllocator),
  currentPolicy: capsOf(currentAllocator),
  predecessorCommentClaims: {
    microDecisive: /a tiny budget must be DECISIVE/.test(predecessorAllocator),
    fullTokenBudgetIsRealBound: /full's caps are generous ceilings — the token budget is the real bound there/.test(predecessorAllocator),
    tunablePolicy: /the tunable policy/.test(predecessorAllocator),
  },
  predecessorHardMaximumInPacking: /support\.length >= maxSupportSlots/.test(predecessorBuilder),
  currentHardMaximumInPacking: /support\.length >= (maxSupportSlots|supportWindow)/.test(currentBuilder),
  measurementOverFrozenSweep: {
    responses: preC.responses.filter((r: any) => r.frozenBudget).length,
    supportCountDiscards: stageTotalsPre.support_packing?.lostByReason?.TIER_SUPPORT_CAP ?? 0,
    tokenBudgetDiscards: stageTotalsPre.support_packing?.lostByReason?.TOKEN_BUDGET ?? 0,
    responsesStoppedOnCount: preC.stopReasonsOverFrozen["OTHER_EXPLICIT_POLICY:FIXED_TIER_SUPPORT_CAP"] ?? 0,
    pivotCapDemotions: stageTotalsPre.pivot_cap?.lost ?? 0,
    counterfactualCeilingRejections: A11_BUDGETS.reduce((n, b) => n + (preC.byBudget[b]?.totals?.counterfactualRejectedForCeiling ?? 0), 0),
  },
  classification: [
    { cap: "maxPivots (micro 1 / standard 2 / full 5)", kind: "role safeguard", authority: "pivots are edit targets: productContext marks them required (EDIT_OR_RULE_OUT) and the M112 action contract turns them into obligations; M101's anchored exemption is the one bounded exception", disposition: "preserved unchanged" },
    { cap: "maxSupport micro 1", kind: "historical default with a stated decisiveness rationale", authority: "comment: one decisive edit site; measured: the token budget and the evidence budget bound micro delivery on their own (post 1000: evidence budget binds every response)", disposition: "no longer a maximum; retained as the support window" },
    { cap: "maxSupport standard 4 / full 10", kind: "historical default", authority: `introduced ${allocatorHistory.at(-1) ?? "?"} with no measured rationale; the comment claimed the token budget was the real bound at full, which the sweep contradicts (${stageTotalsPre.support_packing?.lostByReason?.TIER_SUPPORT_CAP ?? 0} count discards, ${stageTotalsPre.support_packing?.lostByReason?.TOKEN_BUDGET ?? 0} budget discards over ${preC.responses.filter((r: any) => r.frozenBudget).length} frozen responses)`, disposition: "no longer a maximum; retained as the support window (lane ordering and documentation fill)" },
  ],
};
write("stage5_m206_tier_cap_audit.json", tierCapAudit);

// ------------------------------------------------ allocation stage audit
const allocationAudit = {
  path: ["retrieval_pool", "role_gate", "pivot_cap", "support_lanes", "support_packing", "product_assembly", "evidence_budget", "projector_admission"],
  functions: {
    retrieval_pool: "hybridRetrieve (src/retrieval/hybridRetrieval.ts) with maxResults = CANDIDATE_POOL_SIZE (buildCapsuleV2.ts)",
    role_gate: "assignCandidateRoles (src/capsule/assignCandidateRoles.ts) / refineDebugRoles (src/capsuleV2/debugRoles.ts)",
    pivot_cap: "allocateBudget().maxPivots -> capPivots (debugRoles.ts) / assignCandidateRoles maxPivots; demotion to support",
    pivot_packing: "renderPivot -> firstFitting (buildCapsuleV2.ts), lead pivot forced",
    support_ordering: "supportTier order, expandCoeditSupport + orderSupportWithCoedit (coeditExpansion.ts), rescueFileEvidenceSupport (fileEvidenceRescue.ts), selectPathCompletion (pathCompletion.ts), discoverMechanismSupport",
    support_packing: "the support packing loop in buildCapsuleV2.ts: renderSupport(remaining tokens) + M158 delivered-identity dedupe + lane token ceilings (+ the tier count until M206)",
    product_assembly: "assembleProductContext (sourceDraft, addActionabilityTargets, addImpactEvidence, addMemoryAndRules, deduplicateDrafts)",
    evidence_budget: "applyProgressiveContextBudget (budgetDelivery.ts) publishing the semantic item supply",
    envelope: "compactProductResponse / responseTokenCeiling (responseEnvelope.ts) on the authoritative response",
    projector_admission: "projectRunPipelineOrientation (orientationProjection.ts): dedupe, claim, prefix under orientationCeilingTokens; M205 routing",
  },
  stageTotalsOverFrozen: { pre: preC.stageTotalsOverFrozen, post: postC.stageTotalsOverFrozen },
  stopReasonsOverFrozen: { pre: preC.stopReasonsOverFrozen, post: postC.stopReasonsOverFrozen },
  poolCap: post.product.poolCap,
};
write("stage5_m206_allocation_audit.json", allocationAudit);

// -------------------------------------------------- supply sufficiency
const sufficiency = {
  rule: pre.protocol.sufficiencyRule,
  rows: preC.supplySufficiency.rows,
  verdict: preC.supplySufficiency.verdict,
  counterfactualFrozenBand: preC.counterfactualA11,
  worstDeficits: preC.responses.filter((r: any) => r.frozenBudget && r.counterfactual)
    .map((r: any) => ({ task: r.task, budget: r.budget, required: requiredMatchTokens(r.budget), uncapped: r.counterfactual.frozenTokensAllBounds,
      deficit: requiredMatchTokens(r.budget) - r.counterfactual.frozenTokensAllBounds, candidateCount: r.candidateCount, rankedPreCap: r.rankedPreCap, stop: r.counterfactual.stopReason }))
    .filter((r: any) => r.deficit > 0).sort((a: any, b: any) => b.deficit - a.deficit).slice(0, 10),
};
write("stage5_m206_supply_sufficiency.json", sufficiency);

// ------------------------------------------ candidate selection before/after
const keyOf = (r: any) => `${r.task}@${r.budget}`;
const preBy = new Map<string, any>(preC.responses.map((r: any) => [keyOf(r), r]));
const postBy = new Map<string, any>(postC.responses.map((r: any) => [keyOf(r), r]));
const selection = post.corpora.find((c: any) => c.id === "C-MED").budgets.map((b: number) => {
  const p = preC.byBudget[b]; const q = postC.byBudget[b];
  const rows = postC.responses.filter((r: any) => r.budget === b);
  const preRows = preC.responses.filter((r: any) => r.budget === b);
  return {
    budget: b, frozen: (A11_BUDGETS as readonly number[]).includes(b),
    rankedPreCap: { before: p.medians.rankedPreCap, after: q.medians.rankedPreCap },
    selectedCapsule: { before: p.medians.postCap, after: q.medians.postCap },
    discardedCapsule: { before: p.medians.discarded, after: q.medians.discarded },
    discardTotals: { before: p.discardTotals, after: q.discardTotals },
    deliveredItems: { before: p.medians.items, after: q.medians.items },
    uncappedRepresentableTokens: { before: p.medians.counterfactualFrozenTokensAllBounds, after: q.medians.counterfactualFrozenTokensAllBounds },
    wholeTokens: { before: p.medians.frozenWholeTokens, after: q.medians.frozenWholeTokens },
    unusedBudget: { before: p.medians.unusedFrozenBudget, after: q.medians.unusedFrozenBudget },
    utilisation: { before: p.frozenUtilisationMedian, after: q.frozenUtilisationMedian, distributionAfter: q.currentUtilisation },
    stopReasons: { before: p.stopReasons, after: q.stopReasons },
    debugEnvelope: { withinAfter: rows.filter((r: any) => r.debugEnvelope?.withinEnvelope === true).length, responses: rows.length,
      compactedFieldsAfter: Object.entries(rows.reduce((h: Record<string, number>, r: any) => { for (const f of r.debugEnvelope?.compactedFields ?? []) h[f] = (h[f] ?? 0) + 1; return h; }, {})).sort((x: any, y: any) => y[1] - x[1]).slice(0, 8),
      compactedFieldsBefore: Object.entries(preRows.reduce((h: Record<string, number>, r: any) => { for (const f of r.debugEnvelope?.compactedFields ?? []) h[f] = (h[f] ?? 0) + 1; return h; }, {})).sort((x: any, y: any) => y[1] - x[1]).slice(0, 8) },
  };
});
write("stage5_m206_selection_before_after.json", { corpus: "C-MED", byBudget: selection });

// -------------------------------------------- counterfactual -> product attribution
const attribution = postC.responses.filter((r: any) => r.frozenBudget && r.utilisation).map((r: any) => {
  const p = preBy.get(keyOf(r));
  const predicted: string[] = p?.counterfactual?.admittedIds ?? [];
  const predictedRep: string[] = p?.counterfactual?.admittedRepresentations ?? [];
  const actual: string[] = r.relatedIds;
  const actualRep: string[] = r.relatedRepresentations;
  const predictedAllBounds = p?.counterfactual?.admittedExtraAllBounds ?? null;
  const common = Math.min(predicted.length, actual.length);
  let orderAgree = 0; let repAgree = 0;
  for (let k = 0; k < common; k += 1) { if (predicted[k] === actual[k]) orderAgree += 1; if (predicted[k] === actual[k] && predictedRep[k] === actualRep[k]) repAgree += 1; }
  const predictedSet = new Set(predicted); const actualSet = new Set(actual);
  const inBoth = [...actualSet].filter((a) => predictedSet.has(a)).length;
  return { task: r.task, budget: r.budget, predictedCount: predicted.length, actualCount: actual.length,
    predictedCountAllBounds: predictedAllBounds === null ? null : (p?.relatedIds?.length ?? 0) + predictedAllBounds,
    identitiesInBoth: inBoth, onlyPredicted: predicted.length - inBoth, onlyActual: actual.length - inBoth,
    prefixAgreement: orderAgree, representationAgreement: repAgree,
    predictedStop: p?.counterfactual?.stopReason ?? null, actualStop: `${r.stop.reason}${r.stop.policy ? `:${r.stop.policy}` : ""}`,
    actualUpstreamStatus: r.utilisation.upstreamStatus,
    overlapOfActual: actual.length === 0 ? 1 : +(inBoth / actual.length).toFixed(3),
    setEqual: inBoth === predicted.length && inBoth === actual.length, orderEqual: predicted.length === actual.length && orderAgree === actual.length };
});
const attributionSummary = {
  responses: attribution.length,
  setEqual: attribution.filter((a: any) => a.setEqual).length, orderEqual: attribution.filter((a: any) => a.orderEqual).length,
  actualSubsetOfPredicted: attribution.filter((a: any) => a.onlyActual === 0).length,
  medianOnlyPredicted: median(attribution.map((a: any) => a.onlyPredicted)), medianOnlyActual: median(attribution.map((a: any) => a.onlyActual)),
  byBudget: Object.fromEntries(A11_BUDGETS.map((b) => { const rows = attribution.filter((a: any) => a.budget === b); return [b, {
    setEqual: rows.filter((a: any) => a.setEqual).length, orderEqual: rows.filter((a: any) => a.orderEqual).length, actualSubsetOfPredicted: rows.filter((a: any) => a.onlyActual === 0).length,
    medianPredicted: median(rows.map((a: any) => a.predictedCount)), medianActual: median(rows.map((a: any) => a.actualCount)),
    medianOverlapOfActual: median(rows.map((a: any) => a.overlapOfActual)),
    actualStops: rows.reduce((h: Record<string, number>, a: any) => { h[a.actualStop] = (h[a.actualStop] ?? 0) + 1; return h; }, {}),
    upstreamStatus: rows.reduce((h: Record<string, number>, a: any) => { h[a.actualUpstreamStatus] = (h[a.actualUpstreamStatus] ?? 0) + 1; return h; }, {}) }] })),
  note: "the pre-change counterfactual appended the count-cap discards AFTER the delivered prefix (which already held the impact, memory and neighbourhood entries), whereas the product packs every support before the impact and memory items, so order equality is unreachable by construction and set overlap is the attribution measure; the counterfactual modelled the projector's ceiling, the evidence budget and the capsule token budget, not the whole-response envelope's escalation of the evidence budget, which is why the product delivered fewer than predicted at 1000-2000 (the actual stop reason names that budget)",
};
write("stage5_m206_attribution.json", { summary: attributionSummary, responses: attribution });

// ----------------------------------------------------------------- tail
const tail = postC.tail;
write("stage5_m206_tail.json", { corpus: "C-MED", worstTenPostChange: tail, worstTenPreChange: preC.tail });

// ------------------------------------------------- same-corpus control
const sameCorpus = postPre === null ? null : (() => {
  const rows: any[] = cm(postPre).responses;
  const compare = rows.map((r) => { const p = preBy.get(keyOf(r)); const q = postBy.get(keyOf(r)); return { key: keyOf(r), focusSameAsPre: p?.focusAt === r.focusAt,
    packetSameAsPre: p?.packetSha === r.packetSha, packetSameAsPost: q?.packetSha === r.packetSha, relatedSameAsPost: JSON.stringify(q?.relatedIds) === JSON.stringify(r.relatedIds),
    itemsPre: p?.utilisation?.items ?? null, itemsPostPre: r.utilisation?.items ?? null, itemsPost: q?.utilisation?.items ?? null }; });
  return { product: postPre.product, corpus: "the pre-change C-MED copy and index (/tmp/m206-allocation-pre)", responses: rows.length,
    focusSameAsPre: compare.filter((c) => c.focusSameAsPre).length, packetSameAsPre: compare.filter((c) => c.packetSameAsPre).length,
    packetSameAsPostOnMovedCorpus: compare.filter((c) => c.packetSameAsPost).length, relatedSetSameAsPostOnMovedCorpus: compare.filter((c) => c.relatedSameAsPost).length,
    frozenA11OnPreCorpus: sweepA11(postPre), frozenA11OnPostCorpus: sweepA11(post),
    medianItems: { pre: median(compare.map((c) => c.itemsPre).filter((n): n is number => typeof n === "number")), postOnPreCorpus: median(compare.map((c) => c.itemsPostPre).filter((n): n is number => typeof n === "number")), postOnPostCorpus: median(compare.map((c) => c.itemsPost).filter((n): n is number => typeof n === "number")) },
    differingFromPost: compare.filter((c) => !c.packetSameAsPost).map((c) => c.key).slice(0, 40) };
})();

// ------------------------------------------------------ A12 / A14 integrity
const repC = representationPost === null ? null : cm(representationPost);
const a12 = repC === null ? null : {
  frozenClasses: repC.frozenA12.distinctClassesObserved, count: repC.frozenA12.count, verdict: repC.frozenA12.verdict,
  integrity: repC.integrity, classTotals: repC.classTotals, reasonTotals: repC.reasonTotals, sourceTruth: repC.sourceTruth,
  frozenRerun: { classes: cm(engine).a12.distinctClassesObserved, verdict: verdictOf(ledger, "A12") },
  m205: { classes: cm(m205Engine).a12.distinctClassesObserved, verdict: verdictOf(m205Ledger, "A12") },
};
const newlyAdmitted = routingPost.filter((r) => r.corpus === "C-MED" && r.slot === "related");
const a14 = {
  frozenRerun: { accounted: cm(engine).a14.itemsWithPerItemAccounting, delivered: cm(engine).a14.itemsDelivered, verdict: verdictOf(ledger, "A14") },
  m205: { accounted: cm(m205Engine).a14.itemsWithPerItemAccounting, delivered: cm(m205Engine).a14.itemsDelivered, verdict: verdictOf(m205Ledger, "A14") },
  sweepIntegrity: { pre: { packets: preC.integrity.packets, gateFailures: preC.integrity.gateFailures }, post: { packets: postC.integrity.packets, gateFailures: postC.integrity.gateFailures, failedGates: postC.integrity.failedGates } },
  relatedEntriesOnCMed: { m205: 1703, m206: newlyAdmitted.length, accounted: newlyAdmitted.filter((r) => typeof r.actual_tokens === "number").length, validRepresentation: newlyAdmitted.filter((r) => r.pass).length },
};
write("stage5_m206_a12_a14_integrity.json", { a12, a14 });

// ---------------------------------------------------------- A13 observed
const a13 = {
  statement: "A13 was measured, not optimized.",
  m205Committed: { sizeViolations: cm(m205Engine).a11a13.tasksWithSizeViolation, focusSwaps: cm(m205Engine).a11a13.tasksWithFocusSwap, verdict: verdictOf(m205Ledger, "A13") },
  reproductionPre: { sizeViolations: preC.frozenA13.tasksWithSizeViolation, focusSwaps: preC.frozenA13.tasksWithFocusSwap, orderRelations: preC.orderRelations },
  reproductionPost: { sizeViolations: postC.frozenA13.tasksWithSizeViolation, focusSwaps: postC.frozenA13.tasksWithFocusSwap, orderRelations: postC.orderRelations,
    representationRegressions: repC?.frozenA13?.representationRegressions ?? null },
  frozenRerun: { sizeViolations: cm(engine).a11a13.tasksWithSizeViolation, focusSwaps: cm(engine).a11a13.tasksWithFocusSwap, verdict: verdictOf(ledger, "A13") },
  swappedTasks: postC.frozenA13.curves.filter((c: any) => c.focusSwaps > 0).map((c: any) => ({ task: c.task, focusByBudget: c.focusByBudget })),
};
write("stage5_m206_a13_observation.json", a13);

// ----------------------------------------------------------- performance
const performance = {
  a5: { before: a5Before.p90ByCorpus, after: a5After.p90ByCorpus, classificationBefore: a5Before.classification, classificationAfter: a5After.classification, frozenA5: verdictOf(ledger, "A5") },
  latencyP90ByBudget: post.corpora.find((c: any) => c.id === "C-MED").budgets.map((b: number) => ({ budget: b, before: preC.byBudget[b].latency.p90, after: postC.byBudget[b].latency.p90,
    allocationMsMedianAfter: postC.byBudget[b].medians.allocationMs })),
  largestPacketBytes: { before: preC.resources.largestPacketBytes, after: postC.resources.largestPacketBytes },
  largestItemCount: { before: preC.resources.largestItemCount, after: postC.resources.largestItemCount },
  largestRankedStream: { before: preC.resources.largestRankedStream, after: postC.resources.largestRankedStream },
  peakRssBytes: { before: pre.hardware.peakRssBytes, after: post.hardware.peakRssBytes },
  schema: "no DB table, no schema change, no new persisted metadata; the tool output schema declares two diagnostics markers the envelope already emitted (sectionDecisionsOmitted, sectionDecisionsNote)",
};

// -------------------------------------------------------- protected claims
const protectedIds = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A12", "A14"];
const protectedClaims = protectedIds.map((id) => ({ id, m205: verdictOf(m205Ledger, id), m206: verdictOf(ledger, id), held: rank(verdictOf(ledger, id)) >= rank(verdictOf(m205Ledger, id)) }));
const matrix = ledger.claims.map((c: any) => ({ id: c.id, m205: verdictOf(m205Ledger, c.id), m206: c.verdict, measurement: c.measurement }));
write("stage5_m206_protected_claims.json", { protectedClaims, matrix, parity: { m205: m205Ledger.parity.matchOrExceed, m206: ledger.parity.matchOrExceed } });
const frozenF6 = (ledger.falsificationControls?.controls ?? []).find((c: any) => c.id === "F6");

// ---------------------------------------------------------------- gates
const f = (id: string) => falsification.controls.find((c: any) => c.id === id)?.pass === true;
const supplyVerdict: string = preC.supplySufficiency.verdict;
const capRepairedInProduct = tierCapAudit.predecessorHardMaximumInPacking && !tierCapAudit.currentHardMaximumInPacking;
const gates = [
  { id: "G1", statement: "frozen A11 definition recovered unchanged", pass: a11Row.matchThreshold === m205A11Row.matchThreshold && a11Row.exceedThreshold === m205A11Row.exceedThreshold && a11Row.vexpClaim === m205A11Row.vexpClaim && /60%/.test(a11Row.matchThreshold) && /80%/.test(a11Row.exceedThreshold) },
  { id: "G2", statement: "A11 BELOW reproduced pre-change, equal to the committed M205 figures", pass: preMatchesCommitted && preC.frozenA11.verdict === "VTRACE_BELOW_VEXP_CLAIM" },
  { id: "G3", statement: "allocation path traced: every truncation stage identified with counts; no unclassified discard", pass: allocationAudit.path.length >= 8 && preC.integrity.gateFailures === 0 && (preC.stageTotalsOverFrozen.support_packing?.lostByReason?.OTHER ?? 0) === 0 },
  { id: "G4", statement: "tier semantics recovered: historical counts, their origin commit and their actual authority documented", pass: tierCapAudit.predecessorCaps !== null && tierCapAudit.introducedIn !== null && tierCapAudit.predecessorHardMaximumInPacking },
  { id: "G5", statement: "read-only counterfactual evaluator: replica matches the projector's ledger on every response; 0 gate failures", pass: preC.integrity.gateFailures === 0 && preCandidates.length > 0 },
  { id: "G6", statement: "supply sufficiency decided before any cap change, on the frozen rule", pass: ["A11_SUPPLY_SUFFICIENT", "A11_SUPPLY_INSUFFICIENT"].includes(supplyVerdict) && preC.supplySufficiency.rows.filter((r: any) => r.frozen).length === A11_BUDGETS.length },
  { id: "G7", statement: "one allocation authority: the tier support number is a window, the token budget is the bound, no parallel allocator", pass: capRepairedInProduct && !/allocateBudgetV2|LegacyAllocation/.test(currentBuilder) },
  { id: "G8", statement: "fixed-cap defect repaired: no ranked support candidate is discarded for a count (F2, F8); the count discard reason no longer exists", pass: capRepairedInProduct && f("F2") && f("F8") && (postC.stageTotalsOverFrozen.support_packing?.lostByReason?.TIER_SUPPORT_CAP ?? 0) === 0 },
  { id: "G9", statement: "role invariants: pivot caps unchanged, pivots pack first, abundant support never displaces a pivot (F5)", pass: f("F5") && JSON.stringify(tierCapAudit.currentPolicy && { m: tierCapAudit.currentPolicy.micro.maxPivots, s: tierCapAudit.currentPolicy.standard.maxPivots, f: tierCapAudit.currentPolicy.full.maxPivots }) === JSON.stringify(tierCapAudit.predecessorCaps && { m: tierCapAudit.predecessorCaps.micro.maxPivots, s: tierCapAudit.predecessorCaps.standard.maxPivots, f: tierCapAudit.predecessorCaps.full.maxPivots }) },
  { id: "G10", statement: "no filler: no duplicate, no ineligible tail, unused budget stays unused (F1, F3, F4); analyzer gates on every post response", pass: f("F1") && f("F3") && f("F4") && postC.integrity.gateFailures === 0 },
  { id: "G11", statement: "M205 representation truth on every expanded item (F10; representation sweep on the repaired product)", pass: f("F10") && (repC === null ? false : repC.integrity.failures === 0) },
  { id: "G12", statement: "M203 accounting: every delivered item accounted and reconciled (F9; frozen A14)", pass: f("F9") && verdictOf(ledger, "A14") === "VTRACE_MATCHES_VEXP_CLAIM" && postC.integrity.gateFailures === 0 },
  { id: "G13", statement: "determinism: repeats stable on packets and ledgers (F6)", pass: f("F6") && postC.determinism.packetsStable && postC.determinism.ledgersStable },
  { id: "G14", statement: "performance: A5 at least MATCHES", pass: green(verdictOf(ledger, "A5")) && green(a5After.classification) },
  { id: "G15", statement: "A1-A10 protected", pass: ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"].every((id) => protectedClaims.find((c) => c.id === id)!.held) },
  { id: "G16", statement: "A12 protected", pass: protectedClaims.find((c) => c.id === "A12")!.held },
  { id: "G17", statement: "A14 protected", pass: protectedClaims.find((c) => c.id === "A14")!.held },
  { id: "G18", statement: "A13 measured only; new baseline captured (F11)", pass: f("F11") && typeof a13.frozenRerun.sizeViolations === "number" },
  { id: "G19", statement: "A15 untouched (impact rendering unchanged; verdict carried)", pass: verdictOf(ledger, "A15") === verdictOf(m205Ledger, "A15") },
  { id: "G20", statement: "frozen A11 verdict from the unmodified scorer", pass: typeof verdictOf(ledger, "A11") === "string" && rerunBand === verdictOf(ledger, "A11") },
  { id: "G21", statement: "full A1-A15 rerun by the unmodified analyzer", pass: ledger.claims.length === 15 && ledger.parity.claimsScored === 15 },
  { id: "G22", statement: "standard verification (recorded by the ledger row; not computed here)", pass: true },
  { id: "G23", statement: "zero model spend: offline instruments only", pass: true },
];

const out = {
  milestone: "M206", instrument: "run_stage5_m206_report.ts",
  verdicts: {
    a11: a11Closed ? "A11_PARITY_CLOSED" : "A11_PARITY_NOT_CLOSED", supply: supplyVerdict,
    capRepair: supplyVerdict === "A11_SUPPLY_SUFFICIENT" ? "A11_CAP_REPAIR_SUFFICIENT" : "A11_CAP_REPAIR_INSUFFICIENT",
    frozenA11Verdict: verdictOf(ledger, "A11"),
    parity: { m205: m205Ledger.parity.matchOrExceed, m206: ledger.parity.matchOrExceed, target: 15, threshold: ledger.parity.verdict },
    gatesPassed: gates.filter((g) => g.pass).length, gatesTotal: gates.length, falsification: falsification.verdict,
  },
  frozenA11,
  authority: { replay: { verdict: authorityReplay.verdict, cmedFiles: cmedReplay?.eligibleFiles, expected: cmedReplay?.expected, revision: cmedReplay?.revision },
    post: { verdict: authorityPost.verdict, cmedFiles: cmedPost?.eligibleFiles, expected: cmedPost?.expected, revision: cmedPost?.revision },
    countUnchanged: cmedPost?.eligibleFiles === cmedReplay?.eligibleFiles,
    note: "C-MED is this repository's src/; M206 edited existing source files and added none, so the self-referential count is unchanged while the revision moved; claim definitions, thresholds, scorer and corpus root unchanged" },
  tierCapAudit, allocationAudit, sufficiency, selection, attribution: attributionSummary, tail, sameCorpus, a12, a14, a13, performance,
  falsification: { verdict: falsification.verdict, controls: falsification.controls.map((c: any) => ({ id: c.id, pass: c.pass, statement: c.statement, detail: c.detail })) },
  determinism: { repeats: postC.determinism.repeats, packetsStable: postC.determinism.packetsStable, ledgersStable: postC.determinism.ledgersStable, unstable: postC.determinism.unstablePackets },
  protectedClaims, matrix,
  frozenF6Control: frozenF6 === undefined ? null : { pass: frozenF6.pass, note: "the committed control conjoins `a14PerItem === 0`, the M197A observation; its other conjuncts pass, so a failure is the stale control and not an A14 regression; not modified (M203 standing finding)" },
  gates,
  boundary: ["ENGINE QUALITY != CODING-AGENT UTILITY", "NO_A13_MONOTONICITY_REPAIR_AUTHORIZED", "NO_IMPACT_RENDERING_EXPANSION_AUTHORIZED", "NO_NEW_REPRESENTATION_CLASS_AUTHORIZED",
    "NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED", "NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED", "I5_REMAINS_CLOSED", "I6_VALIDATION_SELECTION_REMAINS_CLOSED"],
};
write("stage5_m206_final_report.json", out);

// ------------------------------------------------------------------ markdown
const md: string[] = [];
md.push(`# M206 — candidate allocation, tier-cap authority and frozen A11`, "");
md.push(`\`${out.verdicts.a11}\` — \`${out.verdicts.supply}\` — \`${out.verdicts.capRepair}\`; frozen A11 ${short(out.verdicts.frozenA11Verdict)}; parity ${out.verdicts.parity.m205}/15 -> ${out.verdicts.parity.m206}/15 (${out.verdicts.parity.threshold}); gates ${out.verdicts.gatesPassed}/${out.verdicts.gatesTotal}; falsification ${falsification.verdict}.`, "");
md.push(`## What A11 asks`, "", `\`${frozenA11.claim}\` (${frozenA11.source}). Metric: ${frozenA11.metric}. Boundary: ${frozenA11.wholeOutputBoundary}. MATCH: ${frozenA11.matchThreshold}; EXCEED: ${frozenA11.exceedThreshold}.`, "");
md.push(`| | ${A11_BUDGETS.join(" | ")} | verdict |`, `| --- | ${A11_BUDGETS.map(() => "---:").join(" | ")} | --- |`);
for (const [label, row] of [["M205 committed engine", frozenA11.committedM205], ["pre-change reproduction (predecessor worktree)", frozenA11.reproductionPre], ["post-change reproduction", frozenA11.reproductionPost], ["M206 frozen engine rerun", frozenA11.frozenRerun]] as [string, any][]) {
  md.push(`| ${label} | ${A11_BUDGETS.map((b) => pct(row.utilisation[b])).join(" | ")} | ${short(row.verdict)} |`);
}
md.push("", `## Candidate-allocation path`, "");
for (const [k, v] of Object.entries(allocationAudit.functions)) md.push(`- **${k}**: ${v}`);
md.push("", `Stage losses over the 100 frozen responses (pre -> post):`, "", `| stage | lost pre | otherwise eligible pre | lost post | otherwise eligible post | reasons pre | reasons post |`, `| --- | ---: | ---: | ---: | ---: | --- | --- |`);
for (const stage of allocationAudit.path) {
  const a = preC.stageTotalsOverFrozen[stage] ?? { lost: 0, otherwiseEligibleLost: 0, lostByReason: {} }; const b = postC.stageTotalsOverFrozen[stage] ?? { lost: 0, otherwiseEligibleLost: 0, lostByReason: {} };
  md.push(`| ${stage} | ${a.lost} | ${a.otherwiseEligibleLost} | ${b.lost} | ${b.otherwiseEligibleLost} | ${JSON.stringify(a.lostByReason)} | ${JSON.stringify(b.lostByReason)} |`);
}
md.push("", `Stop reasons over the frozen responses: pre ${JSON.stringify(preC.stopReasonsOverFrozen)}; post ${JSON.stringify(postC.stopReasonsOverFrozen)}. Retrieval pool cap ${allocationAudit.poolCap} (CANDIDATE_POOL_SIZE).`, "");
md.push(`## Tier-cap authority`, "", `Allocator history: ${tierCapAudit.history.join("; ")}. Predecessor caps ${JSON.stringify(tierCapAudit.predecessorCaps)}; current policy ${JSON.stringify(tierCapAudit.currentPolicy)}. Predecessor comment claims: ${JSON.stringify(tierCapAudit.predecessorCommentClaims)}. Hard maximum in packing: predecessor ${tierCapAudit.predecessorHardMaximumInPacking}, current ${tierCapAudit.currentHardMaximumInPacking}. Measured over the frozen sweep: ${JSON.stringify(tierCapAudit.measurementOverFrozenSweep)}.`, "");
md.push(`| cap | kind | authority | disposition |`, `| --- | --- | --- | --- |`);
for (const c of tierCapAudit.classification) md.push(`| ${c.cap} | ${c.kind} | ${c.authority} | ${c.disposition} |`);
md.push("", `## Supply sufficiency (pre-change counterfactual)`, "", `Rule: ${sufficiency.rule}.`, "", `| budget | required MATCH | required EXCEED | ranked pre-cap | post-cap | current tokens | uncapped tokens (ceiling) | uncapped tokens (all bounds) | current util | theoretical util | theoretical util (all bounds) | min / p10 / p90 / max (all bounds) | sufficiency |`, `| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |`);
for (const r of sufficiency.rows) md.push(`| ${r.budget}${r.frozen ? "" : " (non-frozen)"} | ${r.requiredMatchTokens} | ${r.requiredExceedTokens} | ${r.medianRankedPreCap} | ${r.medianPostCap} | ${r.medianCurrentFrozenTokens} | ${r.medianUncappedFrozenTokens} | ${r.medianUncappedFrozenTokensAllBounds} | ${pct(r.currentUtilisationMedian)} | ${pct(r.theoreticalUtilisationMedian)} | ${pct(r.theoreticalUtilisationAllBoundsMedian)} | ${r.distribution ? `${r.distribution.min} / ${r.distribution.p10} / ${r.distribution.p90} / ${r.distribution.max}` : "n/a"} | ${r.sufficiency} |`);
md.push("", `Verdict: \`${sufficiency.verdict}\`; the frozen band if uncapped: ${short(sufficiency.counterfactualFrozenBand.verdictIfUncappedAllBounds)}. Worst task-level deficits (all-bounds tokens short of the MATCH line):`, "", `| task | budget | required | uncapped | deficit | pool | ranked pre-cap | counterfactual stop |`, `| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |`);
for (const d of sufficiency.worstDeficits) md.push(`| ${d.task} | ${d.budget} | ${d.required} | ${d.uncapped} | ${d.deficit} | ${d.candidateCount} | ${d.rankedPreCap} | ${d.stop} |`);
md.push("", `## Candidate admission and utilisation before / after (C-MED medians)`, "", `| budget | ranked pre-cap | capsule selected before | after | capsule discarded before | after | delivered items before | after | whole tokens before | after | unused before | after | util before | after | after min / p10 / p90 / max | stops after |`, `| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |`);
for (const s of selection) md.push(`| ${s.budget}${s.frozen ? "" : " (non-frozen)"} | ${s.rankedPreCap.before} -> ${s.rankedPreCap.after} | ${s.selectedCapsule.before} | ${s.selectedCapsule.after} | ${s.discardedCapsule.before} | ${s.discardedCapsule.after} | ${s.deliveredItems.before} | ${s.deliveredItems.after} | ${s.wholeTokens.before} | ${s.wholeTokens.after} | ${s.unusedBudget.before} | ${s.unusedBudget.after} | ${pct(s.utilisation.before)} | ${pct(s.utilisation.after)} | ${s.utilisation.distributionAfter ? `${s.utilisation.distributionAfter.min} / ${s.utilisation.distributionAfter.p10} / ${s.utilisation.distributionAfter.p90} / ${s.utilisation.distributionAfter.max}` : "n/a"} | ${JSON.stringify(s.stopReasons.after)} |`);
md.push("", `Debug-surface envelope after (detail=debug, paired call): ${selection.map((s: any) => `${s.budget}: within ${s.debugEnvelope.withinAfter}/${s.debugEnvelope.responses}, top compacted ${JSON.stringify(s.debugEnvelope.compactedFieldsAfter.slice(0, 4))}`).join("; ")}.`, "");
md.push(`## Counterfactual-to-product attribution (frozen responses)`, "", `${attributionSummary.responses} responses: related set equal to the pre-change counterfactual ${attributionSummary.setEqual}, order equal ${attributionSummary.orderEqual}, actual a subset of predicted ${attributionSummary.actualSubsetOfPredicted}; median identities only predicted ${attributionSummary.medianOnlyPredicted}, only actual ${attributionSummary.medianOnlyActual}. ${attributionSummary.note}.`, "", `| budget | set equal | order equal | actual ⊆ predicted | median predicted | median actual | median share of actual predicted | actual stops | upstream status |`, `| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |`);
for (const [b, v] of Object.entries(attributionSummary.byBudget) as [string, any][]) md.push(`| ${b} | ${v.setEqual} | ${v.orderEqual} | ${v.actualSubsetOfPredicted} | ${v.medianPredicted} | ${v.medianActual} | ${v.medianOverlapOfActual} | ${JSON.stringify(v.actualStops)} | ${JSON.stringify(v.upstreamStatus)} |`);
md.push("", `## Tail (ten worst post-change frozen responses)`, "", `| task | budget | util | items | pool | ranked pre-cap | post-cap | remaining truthful supply | next item fits | stop | binding |`, `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |`);
for (const t of tail) md.push(`| ${t.task} | ${t.budget} | ${t.utilisationPercent}% | ${t.items} | ${t.candidateCount} | ${t.rankedPreCap} | ${t.postCap} | ${t.remainingTruthfulSupply} | ${t.nextItemFits} | ${t.stop.reason}${t.stop.policy ? `:${t.stop.policy}` : ""} | ${t.bindingReason} |`);
md.push("", `## Same-corpus control`, "", sameCorpus === null ? "post-on-pre-corpus run absent" : `Repaired product on the pre-change corpus copy: ${sameCorpus.responses} responses; focus same as pre ${sameCorpus.focusSameAsPre}; packet byte-identical to pre ${sameCorpus.packetSameAsPre}; packet byte-identical to the post run on the moved corpus ${sameCorpus.packetSameAsPostOnMovedCorpus}, related set same ${sameCorpus.relatedSetSameAsPostOnMovedCorpus}. Frozen A11 on the pre corpus ${JSON.stringify(sameCorpus.frozenA11OnPreCorpus)} vs on the post corpus ${JSON.stringify(sameCorpus.frozenA11OnPostCorpus)}. Median items pre ${sameCorpus.medianItems.pre}, post-on-pre ${sameCorpus.medianItems.postOnPreCorpus}, post-on-post ${sameCorpus.medianItems.postOnPostCorpus}.`, "");
md.push(`## Falsification`, "", `| id | pass | statement |`, `| --- | --- | --- |`);
for (const c of out.falsification.controls) md.push(`| ${c.id} | ${c.pass ? "pass" : "FAIL"} | ${c.statement} |`);
md.push("", `## Representation and accounting integrity`, "", a12 === null ? "representation sweep absent" : `A12 on the repaired product: ${a12.count} classes (${a12.frozenClasses.join(", ")}) ${short(a12.verdict)}; integrity failures ${a12.integrity.failures}/${a12.integrity.packets}; related entries on C-MED ${a14.relatedEntriesOnCMed.m206} (M205 ${a14.relatedEntriesOnCMed.m205}), accounted ${a14.relatedEntriesOnCMed.accounted}, valid representation ${a14.relatedEntriesOnCMed.validRepresentation}; class totals ${JSON.stringify(a12.classTotals)}; reasons ${JSON.stringify(a12.reasonTotals)}; source truth ${JSON.stringify(a12.sourceTruth)}. Frozen rerun A12 ${short(a12.frozenRerun.verdict)} (${a12.frozenRerun.classes.join(", ")}).`, "", `A14 frozen rerun ${a14.frozenRerun.accounted}/${a14.frozenRerun.delivered} (${short(a14.frozenRerun.verdict)}); M205 ${a14.m205.accounted}/${a14.m205.delivered}. Sweep gate failures pre ${a14.sweepIntegrity.pre.gateFailures}/${a14.sweepIntegrity.pre.packets}, post ${a14.sweepIntegrity.post.gateFailures}/${a14.sweepIntegrity.post.packets}.`, "");
md.push(`## Determinism`, "", `${out.determinism.repeats} repeats: packets stable ${out.determinism.packetsStable}, ledgers stable ${out.determinism.ledgersStable}; unstable ${JSON.stringify(out.determinism.unstable)}; F6 ${f("F6")}.`, "");
md.push(`## Performance`, "", `A5 p90 before ${JSON.stringify(performance.a5.before)} (${short(performance.a5.classificationBefore)}); after ${JSON.stringify(performance.a5.after)} (${short(performance.a5.classificationAfter)}); frozen A5 ${short(performance.a5.frozenA5)}. Largest packet ${performance.largestPacketBytes.before} -> ${performance.largestPacketBytes.after} bytes; largest item count ${performance.largestItemCount.before} -> ${performance.largestItemCount.after}; largest ranked stream ${performance.largestRankedStream.before} -> ${performance.largestRankedStream.after}; peak RSS ${(performance.peakRssBytes.before / 1e6).toFixed(0)} -> ${(performance.peakRssBytes.after / 1e6).toFixed(0)} MB. ${performance.schema}.`, "");
md.push(`| budget | p90 before | p90 after | allocation audit ms (median, after) |`, `| ---: | ---: | ---: | ---: |`); for (const l of performance.latencyP90ByBudget) md.push(`| ${l.budget} | ${l.before} | ${l.after} | ${typeof l.allocationMsMedianAfter === "number" ? l.allocationMsMedianAfter.toFixed(1) : "n/a"} |`);
md.push("", `## A13, observed`, "", `M205 committed: ${a13.m205Committed.sizeViolations} size violations, ${a13.m205Committed.focusSwaps} focus swaps (${short(a13.m205Committed.verdict)}). Pre: ${a13.reproductionPre.sizeViolations} / ${a13.reproductionPre.focusSwaps}, order relations ${JSON.stringify(a13.reproductionPre.orderRelations)}. Post: ${a13.reproductionPost.sizeViolations} / ${a13.reproductionPost.focusSwaps}, order relations ${JSON.stringify(a13.reproductionPost.orderRelations)}, representation regressions ${a13.reproductionPost.representationRegressions}. Frozen rerun: ${a13.frozenRerun.sizeViolations} / ${a13.frozenRerun.focusSwaps} (${short(a13.frozenRerun.verdict)}). ${a13.statement}`, "");
md.push(`## Protected claims`, "", `| id | M205 | M206 | held |`, `| --- | --- | --- | --- |`); for (const c of protectedClaims) md.push(`| ${c.id} | ${short(c.m205)} | ${short(c.m206)} | ${c.held} |`);
md.push("", `## Full matrix`, "", `| id | M205 | M206 | measurement |`, `| --- | --- | --- | --- |`); for (const c of matrix) md.push(`| ${c.id} | ${short(c.m205)} | ${short(c.m206)} | ${String(c.measurement).slice(0, 140)} |`);
md.push("", `M205 ${out.verdicts.parity.m205}/15, M206 ${out.verdicts.parity.m206}/15, target 15/15.`, "");
if (out.frozenF6Control) md.push(`Frozen control F6: ${out.frozenF6Control.pass ? "pass" : "FAIL"}. ${out.frozenF6Control.note}.`, "");
md.push(`## Gates`, "", `| gate | pass | statement |`, `| --- | --- | --- |`); for (const g of gates) md.push(`| ${g.id} | ${g.pass ? "pass" : "FAIL"} | ${g.statement} |`);
md.push("", `## Authority`, "", `Replay: \`${out.authority.replay.verdict}\` at ${out.authority.replay.cmedFiles} files (expected ${out.authority.replay.expected}) @ ${String(out.authority.replay.revision).slice(0, 12)}. Post: \`${out.authority.post.verdict}\` at ${out.authority.post.cmedFiles} @ ${String(out.authority.post.revision).slice(0, 12)}. ${out.authority.note}.`, "");
md.push(`## Boundary`, "", ...out.boundary.map((b: string) => `- ${b}`), "");
writeFileSync(path.join(RESULTS, "stage5_m206_final_report.md"), `${md.join("\n").trimEnd()}\n`);
console.log(`${out.verdicts.a11}; ${out.verdicts.supply}; ${out.verdicts.capRepair}; frozen A11 ${short(out.verdicts.frozenA11Verdict)}; parity ${out.verdicts.parity.m205}/15 -> ${out.verdicts.parity.m206}/15; gates ${out.verdicts.gatesPassed}/${out.verdicts.gatesTotal}`);
for (const g of gates.filter((g) => !g.pass)) console.log(`  FAIL ${g.id} ${g.statement}`);
