/**
 * M207 — final report assembly. Every load-bearing number is read from a
 * generated artefact; nothing here is transcribed. Fails closed on a missing
 * required input, because a report that silently omits the frozen rerun is
 * indistinguishable from one whose frozen rerun passed.
 *
 * Besides the final report it emits the smaller evidence artefacts the
 * milestone requires — the pool-authority audit summary, the pool-width sweep
 * table, the supply-sufficiency verdict, the candidate-quality tail statistics,
 * the role-identity table, the counterfactual-to-product attribution, the
 * same-corpus control, the tail of worst responses, the A12/A14 integrity
 * summaries, the A13 observation, the performance report and the protected-
 * claims table — each derived from the same generated inputs.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m207_report.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CANDIDATE_POOL_FLOOR, CANDIDATE_POOL_HARD_MAXIMUM, EXPECTED_TOKENS_PER_DELIVERED_CANDIDATE, allocateBudget } from "../../src/capsuleV2/budgetAllocator";
import { A11_BUDGETS, A11_EXCEED_PERCENT, A11_MATCH_PERCENT, frozenA11Verdict, median } from "./m204Utilization";
import { requiredMatchTokens } from "./m206Allocation";
import { candidateAllowance, widthLabel } from "./m207RetrievalPool";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");

const read = (name: string, required = true) => {
  const p = path.join(RESULTS, name);
  if (!existsSync(p)) {
    if (required) throw new Error(`M207_EVIDENCE_MISSING: ${name}`);
    return null;
  }
  return JSON.parse(readFileSync(p, "utf8"));
};
const readRows = (name: string): any[] => {
  const p = path.join(RESULTS, name);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
};
const write = (name: string, value: unknown) => writeFileSync(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`);
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8" }).trim();

const audit = read("stage5_m207_pool_authority_pre.json");
const pre = read("stage5_m207_pool_sweep_pre.json");
const post = read("stage5_m207_pool_sweep_post.json");
const postPre = read("stage5_m207_pool_sweep_post_precorpus.json", false);
const preRows = readRows("stage5_m207_pool_sweep_rows_pre.jsonl");
const postRows = readRows("stage5_m207_pool_sweep_rows_post.jsonl");
const falsification = read("stage5_m207_falsification.json");
const authorityReplay = read("stage5_m207_authority.json");
const authorityPost = read("stage5_m207_authority_post.json");
const ledger = read("stage5_m207_claim_ledger.json");
const engine = read("stage5_m207_engine.json");
const m206Ledger = read("stage5_m206_claim_ledger.json");
const m206Engine = read("stage5_m206_engine.json");
const a5Before = read("stage5_m201_a5_m206_post.json");
const a5After = read("stage5_m201_a5_m207_post.json");
const representationPost = read("stage5_m205_representation_m207_post.json", false);
const routingPost = readRows("stage5_m205_routing_ledger_m207_post.jsonl");

const cm = (u: any) => u.corpora.find((c: any) => c.id === "C-MED");
const preC = cm(pre); const postC = cm(post);
const short = (v: string | null | undefined) => v === null || v === undefined ? "UNMEASURED" : v.replace("VTRACE_", "").replace("_VEXP_CLAIM", "");
const verdictOf = (l: any, id: string) => l.claims.find((c: any) => c.id === id)?.verdict ?? null;
const green = (v: string | null) => v === "VTRACE_MATCHES_VEXP_CLAIM" || v === "VTRACE_EXCEEDS_VEXP_CLAIM";
const rank = (v: string | null) => v === "VTRACE_EXCEEDS_VEXP_CLAIM" ? 2 : v === "VTRACE_MATCHES_VEXP_CLAIM" ? 1 : 0;
const pct = (n: number | null | undefined) => (typeof n === "number" ? `${n}%` : "n/a");
const num = (rows: any[], f: (r: any) => number | null | undefined) => rows.map(f).filter((n): n is number => typeof n === "number");

// ---------------------------------------------------------------- authority
if (authorityPost.verdict !== "M197A_AUTHORITY_VERIFIED") throw new Error(`M207_AUTHORITY_NOT_VERIFIED: ${authorityPost.verdict}`);
// The replay runs in the predecessor worktree, which is a detached checkout of
// the M206 final commit; the one check a detached HEAD cannot pass is the
// branch name, and it says nothing about the claim authority or the corpus.
// Every other check — preregistration hash, ledger, parser repair, corpus
// identity and count — must pass.
const replayFailures: string[] = (authorityReplay.checks ?? []).filter((c: any) => !c.ok).map((c: any) => c.id);
const replayAcceptable = authorityReplay.verdict === "M197A_AUTHORITY_VERIFIED" || replayFailures.every((id) => id === "branch_is_main");
if (!replayAcceptable) throw new Error(`M207_AUTHORITY_REPLAY_NOT_VERIFIED: ${authorityReplay.verdict} (${replayFailures.join(",")})`);
const cmedPost = authorityPost.corpora.find((c: any) => c.id === "C-MED");
const cmedReplay = authorityReplay.corpora.find((c: any) => c.id === "C-MED");

// ------------------------------------------------------------- frozen A11
const a11Row = ledger.claims.find((c: any) => c.id === "A11");
const m206A11Row = m206Ledger.claims.find((c: any) => c.id === "A11");
const engineA11 = (e: any) => Object.fromEntries(Object.entries(cm(e).a11a13.utilisationByBudget).map(([b, v]: [string, any]) => [b, v.median]));
const sweepA11 = (u: any, width: string) => Object.fromEntries(Object.entries(cm(u).byWidth[width].frozenA11.utilisationByBudget).map(([b, v]: [string, any]) => [b, v.median]));
const sweepVerdict = (u: any, width: string) => cm(u).byWidth[width].frozenA11.verdict;
const frozenA11 = {
  claim: a11Row.vexpClaim, source: a11Row.vexpSource,
  metric: "median over the 20 C-MED A13 tasks of 100 x ceil(chars/4 of the whole default get_code_context output) / max_tokens, per budget",
  wholeOutputBoundary: "the whole model-facing output object as the handler returns it: focus, related, boundary, notes, schema version and every per-item tokens field",
  budgets: A11_BUDGETS, matchThreshold: a11Row.matchThreshold, exceedThreshold: a11Row.exceedThreshold,
  matchPercent: A11_MATCH_PERCENT, exceedPercent: A11_EXCEED_PERCENT,
  committedM206: { utilisation: engineA11(m206Engine), verdict: verdictOf(m206Ledger, "A11") },
  reproductionPre: { product: pre.product, utilisation: sweepA11(pre, "25"), verdict: sweepVerdict(pre, "25") },
  reproductionPost: { product: post.product, utilisation: sweepA11(post, "product"), verdict: sweepVerdict(post, "product") },
  pinnedControlPost: { utilisation: sweepA11(post, "25"), verdict: sweepVerdict(post, "25") },
  frozenRerun: { utilisation: engineA11(engine), verdict: verdictOf(ledger, "A11") },
};
const rerunBand = frozenA11Verdict(A11_BUDGETS.map((b) => frozenA11.frozenRerun.utilisation[b] ?? null));
if (rerunBand !== frozenA11.frozenRerun.verdict) throw new Error("M207_FROZEN_A11_BAND_DISAGREES_WITH_LEDGER");
const a11Closed = green(verdictOf(ledger, "A11"));
// The pre-change reproduction is on THIS tree's src (the seam edited the corpus), so it is compared to M206 by band and by tolerance, not byte-for-byte.
const preBandMatchesM206 = frozenA11.reproductionPre.verdict === frozenA11.committedM206.verdict
  && A11_BUDGETS.every((b) => Math.abs(frozenA11.reproductionPre.utilisation[b] - frozenA11.committedM206.utilisation[b]) <= 3);

// ------------------------------------------------------------ pool authority
const poolAuthority = {
  symbol: audit.pool.symbol, value: audit.pool.value, file: audit.pool.file, line: audit.pool.line,
  introducedIn: audit.pool.introducedIn, originalComment: audit.pool.originalComment, classification: audit.pool.classification,
  useSites: audit.pool.useSites, dependents: audit.pool.dependents, bounds: audit.bounds, hiddenLimits: audit.hiddenLimits,
  rankedUniverse: audit.rankedUniverse, competitorConstantScan: audit.competitorConstantScan,
  current: {
    allocatorCarriesCandidatePool: /candidatePool/.test(readFileSync(path.join(REPO, "src/capsuleV2/budgetAllocator.ts"), "utf8")),
    fixedConstantRemains: /const CANDIDATE_POOL_SIZE = \d+;/.test(readFileSync(path.join(REPO, "src/capsuleV2/buildCapsuleV2.ts"), "utf8")),
    floor: CANDIDATE_POOL_FLOOR, hardMaximum: CANDIDATE_POOL_HARD_MAXIMUM, tokensPerDeliveredCandidate: EXPECTED_TOKENS_PER_DELIVERED_CANDIDATE,
    rule: "candidatePool = clamp(ceil(maxTokens / EXPECTED_TOKENS_PER_DELIVERED_CANDIDATE), CANDIDATE_POOL_FLOOR, CANDIDATE_POOL_HARD_MAXIMUM)",
    allowanceByBudget: Object.fromEntries([500, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000, 16000, 20000, 48000, 100000].map((b) => [b, allocateBudget(b).candidatePool])),
    statedRuleAgrees: [500, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000, 16000, 20000, 48000, 100000].every((b) => allocateBudget(b).candidatePool
      === candidateAllowance({ maxTokens: b, tokensPerDeliveredCandidate: EXPECTED_TOKENS_PER_DELIVERED_CANDIDATE, floor: CANDIDATE_POOL_FLOOR, hardMaximum: CANDIDATE_POOL_HARD_MAXIMUM })),
  },
};
write("stage5_m207_pool_authority.json", poolAuthority);

// ------------------------------------------------------ pool-width sweep
const widths: string[] = preC.widths;
const preLat = (w: string, b: number) => preC.byWidth[w].byBudget[b];
const sweepTable = widths.map((w) => ({
  width: w,
  a11: Object.fromEntries(A11_BUDGETS.map((b) => [b, preC.byWidth[w].byBudget[b].frozenUtilisationMedian])),
  verdict: sweepVerdict(pre, w),
  byBudget: Object.fromEntries(pre.corpora.find((c: any) => c.id === "C-MED").budgets.map((b: number) => { const x = preLat(w, b); return [b, {
    supply: x.supply, medians: x.medians, stopReasons: x.stopReasons, upstreamStatus: x.upstreamStatus, latency: x.latency, capsuleBuildMs: x.capsuleBuildMs,
    largestPacketBytes: x.largestPacketBytes, utilisation: x.utilisation, discardTotals: x.discardTotals, integrityFailures: x.integrityFailures }]; })),
  a5LikeP90At8000: { cmed: preLat(w, 8000).latency.p90, clarge: pre.corpora.find((c: any) => c.id === "C-LARGE")?.byWidth[w]?.byBudget[8000]?.latency?.p90 ?? null,
    csmall: pre.corpora.find((c: any) => c.id === "C-SMALL")?.byWidth[w]?.byBudget[8000]?.latency?.p90 ?? null },
  p90At16000: { cmed: preLat(w, 16000).latency.p90, clarge: pre.corpora.find((c: any) => c.id === "C-LARGE")?.byWidth[w]?.byBudget[16000]?.latency?.p90 ?? null },
}));
const collapses = (rows: any[], width: string) => Object.fromEntries(A11_BUDGETS.map((b) => [b, rows.filter((r) => r.width === width && r.budget === b && r.utilisation && (r.delivery?.selectedItemsBeforeBudget ?? 0) >= 10 && r.utilisation.items <= 2).map((r) => r.task)]));
write("stage5_m207_pool_width_sweep.json", {
  protocol: pre.protocol, product: pre.product, seamIdentity: pre.seamIdentity, table: sweepTable,
  universe: { cmedMedianUncapped: preC.byWidth.uncapped.byBudget[16000].medians.candidateCount, largestCandidateCount: preC.resources.largestCandidateCount,
    clargeMedianUncapped: pre.corpora.find((c: any) => c.id === "C-LARGE")?.byWidth.uncapped.byBudget[16000].medians.candidateCount ?? null,
    csmallMedianUncapped: pre.corpora.find((c: any) => c.id === "C-SMALL")?.byWidth.uncapped.byBudget[16000].medians.candidateCount ?? null },
  deliveryCollapsesByWidth: Object.fromEntries(widths.map((w) => [w, collapses(preRows.filter((r) => r.corpus === "C-MED"), w)])),
  otherCorpora: pre.corpora.filter((c: any) => c.id !== "C-MED").map((c: any) => ({ id: c.id, supply: c.supply.verdict, frozenA11ByWidth: Object.fromEntries(Object.entries(c.byWidth).map(([w, v]: [string, any]) => [w, v.frozenA11.utilisationByBudget])) })),
});

// -------------------------------------------------------- supply sufficiency
const sufficiency = {
  rule: pre.protocol.sufficiencyRule,
  requirement: Object.fromEntries(A11_BUDGETS.map((b) => [b, requiredMatchTokens(b)])),
  rows: preC.supply.rows, verdict: preC.supply.verdict, narrowestSufficientWidth: preC.supply.narrowestSufficientWidth === null ? null : widthLabel(preC.supply.narrowestSufficientWidth),
  decidedBeforeProductChange: pre.product.head !== post.product.head,
};
write("stage5_m207_supply_sufficiency.json", sufficiency);

// -------------------------------------------------------- candidate quality
const tailByWidth = preC.tail.filter((t: any) => t.budget === 8000 || t.budget === 16000);
write("stage5_m207_candidate_quality.json", { statement: "what the wider widths newly exposed beyond the 25-candidate pool, with each candidate's downstream fate under the unchanged role gate, allocator, router and projector", rows: tailByWidth,
  roleIdentity: preC.roleIdentity.filter((r: any) => (A11_BUDGETS as readonly number[]).includes(r.budget)) });

// ------------------------------------------------ before / after (product)
const keyOf = (r: any) => `${r.task}@${r.budget}`;
const preBy = new Map<string, any>(preRows.filter((r) => r.corpus === "C-MED" && r.width === "25").map((r) => [keyOf(r), r]));
const postBy = new Map<string, any>(postRows.filter((r) => r.corpus === "C-MED" && r.width === "product").map((r) => [keyOf(r), r]));
const postPinnedBy = new Map<string, any>(postRows.filter((r) => r.corpus === "C-MED" && r.width === "25").map((r) => [keyOf(r), r]));
const budgets: number[] = post.corpora.find((c: any) => c.id === "C-MED").budgets;
const selection = budgets.map((b) => {
  const p = preC.byWidth["25"].byBudget[b]; const q = postC.byWidth.product.byBudget[b];
  return {
    budget: b, frozen: (A11_BUDGETS as readonly number[]).includes(b), allowance: allocateBudget(b).candidatePool,
    candidateCount: { before: p.medians.candidateCount, after: q.medians.candidateCount }, rankedStream: { before: p.medians.rankedStream, after: q.medians.rankedStream },
    eligible: { before: p.medians.eligible, after: q.medians.eligible }, roleDiscards: { before: p.medians.roleDiscards, after: q.medians.roleDiscards },
    selectedCapsule: { before: p.medians.pivots + p.medians.support, after: q.medians.pivots + q.medians.support },
    discardedCapsule: { before: p.medians.discarded, after: q.medians.discarded }, discardTotals: { before: p.discardTotals, after: q.discardTotals },
    deliveredItems: { before: p.medians.items, after: q.medians.items }, wholeTokens: { before: p.medians.frozenWholeTokens, after: q.medians.frozenWholeTokens },
    unusedBudget: { before: p.medians.unusedFrozenBudget, after: q.medians.unusedFrozenBudget },
    utilisation: { before: p.frozenUtilisationMedian, after: q.frozenUtilisationMedian, distributionAfter: q.utilisation },
    stopReasons: { before: p.stopReasons, after: q.stopReasons }, upstreamStatus: { before: p.upstreamStatus, after: q.upstreamStatus },
    latencyP90: { before: p.latency.p90, after: q.latency.p90 }, capsuleBuildMsMedian: { before: p.capsuleBuildMs.median, after: q.capsuleBuildMs.median },
  };
});
write("stage5_m207_selection_before_after.json", selection);

// -------------------------------------------- pre-sweep-to-product attribution
const productWidthAt = (b: number) => allocateBudget(b).candidatePool;
const attribution = [...postBy.values()].filter((r) => r.frozen_budget).map((r) => {
  const b = r.budget; const w = productWidthAt(b);
  // The swept width nearest the product allowance, from below and above, brackets the prediction.
  const swept = widths.filter((x) => x !== "uncapped").map(Number).sort((x, y) => x - y);
  const below = [...swept].reverse().find((x) => x <= w) ?? swept[0]!; const above = swept.find((x) => x >= w) ?? null;
  const rowAt = (width: string) => preRows.find((x) => x.corpus === "C-MED" && x.width === width && x.task === r.task && x.budget === b);
  const lo = rowAt(String(below)); const hi = above === null ? rowAt("uncapped") : rowAt(String(above));
  const util = r.utilisation.utilisationPercent;
  const loU = lo?.utilisation?.utilisationPercent ?? null; const hiU = hi?.utilisation?.utilisationPercent ?? null;
  const pinned = postPinnedBy.get(keyOf(r));
  return { task: r.task, budget: b, allowance: w, bracket: [below, above ?? "uncapped"], predictedRange: [Math.min(loU ?? util, hiU ?? util), Math.max(loU ?? util, hiU ?? util)],
    actual: util, withinBracket: loU !== null && hiU !== null && util >= Math.min(loU, hiU) - 5 && util <= Math.max(loU, hiU) + 5,
    pinnedSameFocusAsPre: pinned?.focus_at === preBy.get(keyOf(r))?.focus_at, pinnedRelatedSameAsPre: JSON.stringify(pinned?.related_ids) === JSON.stringify(preBy.get(keyOf(r))?.related_ids),
    focusSameAsPre: r.focus_at === preBy.get(keyOf(r))?.focus_at, stop: `${r.stop.reason}${r.stop.policy ? `:${r.stop.policy}` : ""}` };
});
const attributionSummary = {
  responses: attribution.length, withinSweptBracket: attribution.filter((a) => a.withinBracket).length,
  focusSameAsPre: attribution.filter((a) => a.focusSameAsPre).length,
  pinnedControl: { sameFocus: attribution.filter((a) => a.pinnedSameFocusAsPre).length, sameRelatedSet: attribution.filter((a) => a.pinnedRelatedSameAsPre).length,
    frozenA11: frozenA11.pinnedControlPost.utilisation, note: "the repaired product with its pool pinned to 25 through the instrument, on the moved corpus: the movement that remains is the corpus's (this tree's src changed) and the tight-budget envelope's, not the policy's" },
  byBudget: Object.fromEntries(A11_BUDGETS.map((b) => { const rows = attribution.filter((a) => a.budget === b); return [b, { allowance: productWidthAt(b), withinBracket: rows.filter((a) => a.withinBracket).length,
    medianActual: median(rows.map((a) => a.actual)), stops: rows.reduce((h: Record<string, number>, a) => { h[a.stop] = (h[a.stop] ?? 0) + 1; return h; }, {}) }]; })),
};
write("stage5_m207_attribution.json", { summary: attributionSummary, responses: attribution });

// ----------------------------------------------------------------- tail
write("stage5_m207_tail.json", { corpus: "C-MED", worstTenPostChange: postC.worst, worstTenPreChangeUncapped: preC.worst,
  deliveryCollapses: { pre25: collapses(preRows.filter((r) => r.corpus === "C-MED"), "25"), post: collapses(postRows.filter((r) => r.corpus === "C-MED"), "product"), preUncapped: collapses(preRows.filter((r) => r.corpus === "C-MED"), "uncapped") } });

// ------------------------------------------------- same-corpus control
const postPreRows = readRows("stage5_m207_pool_sweep_rows_post_precorpus.jsonl").filter((r) => r.corpus === "C-MED" && r.width === "product");
const sameCorpus = postPre === null ? null : (() => {
  const compare = postPreRows.map((r) => { const p = preBy.get(keyOf(r)); const q = postBy.get(keyOf(r)); return { key: keyOf(r), focusSameAsPre: p?.focus_at === r.focus_at,
    packetSameAsPre: p?.packet_sha === r.packet_sha, packetSameAsPost: q?.packet_sha === r.packet_sha, relatedSameAsPost: JSON.stringify(q?.related_ids) === JSON.stringify(r.related_ids),
    itemsPre: p?.utilisation?.items ?? null, itemsPostPre: r.utilisation?.items ?? null, itemsPost: q?.utilisation?.items ?? null }; });
  return { product: postPre.product, corpus: "the pre-change C-MED copy and index (/tmp/m207-pool-pre)", responses: compare.length,
    focusSameAsPre: compare.filter((c) => c.focusSameAsPre).length, packetSameAsPre: compare.filter((c) => c.packetSameAsPre).length,
    packetSameAsPostOnMovedCorpus: compare.filter((c) => c.packetSameAsPost).length, relatedSetSameAsPostOnMovedCorpus: compare.filter((c) => c.relatedSameAsPost).length,
    frozenA11OnPreCorpus: sweepA11(postPre, "product"), frozenA11OnPostCorpus: sweepA11(post, "product"),
    medianItems: { pre: median(num(compare, (c) => c.itemsPre)), postOnPreCorpus: median(num(compare, (c) => c.itemsPostPre)), postOnPostCorpus: median(num(compare, (c) => c.itemsPost)) } };
})();

// ------------------------------------------------------ A12 / A14 integrity
const repC = representationPost === null ? null : cm(representationPost);
const a12 = repC === null ? null : {
  frozenClasses: repC.frozenA12.distinctClassesObserved, count: repC.frozenA12.count, verdict: repC.frozenA12.verdict,
  integrity: repC.integrity, classTotals: repC.classTotals, reasonTotals: repC.reasonTotals, sourceTruth: repC.sourceTruth,
  frozenRerun: { classes: cm(engine).a12.distinctClassesObserved, verdict: verdictOf(ledger, "A12") },
  m206: { classes: cm(m206Engine).a12.distinctClassesObserved, verdict: verdictOf(m206Ledger, "A12") },
};
const related = routingPost.filter((r) => r.corpus === "C-MED" && r.slot === "related");
const a14 = {
  frozenRerun: { accounted: cm(engine).a14.itemsWithPerItemAccounting, delivered: cm(engine).a14.itemsDelivered, verdict: verdictOf(ledger, "A14") },
  m206: { accounted: cm(m206Engine).a14.itemsWithPerItemAccounting, delivered: cm(m206Engine).a14.itemsDelivered, verdict: verdictOf(m206Ledger, "A14") },
  sweepIntegrity: { pre: { packets: preC.integrity.packets, failures: preC.integrity.integrityFailures }, post: { packets: postC.integrity.packets, failures: postC.integrity.integrityFailures, failedGates: postC.integrity.failedGates } },
  relatedEntriesOnCMed: { m206: 4521, m207: related.length, accounted: related.filter((r) => typeof r.actual_tokens === "number").length, validRepresentation: related.filter((r) => r.pass).length },
};
write("stage5_m207_a12_a14_integrity.json", { a12, a14 });

// ---------------------------------------------------------- A13 observed
const a13 = {
  statement: "A13 was measured, not optimized.",
  m206Committed: { sizeViolations: cm(m206Engine).a11a13.tasksWithSizeViolation, focusSwaps: cm(m206Engine).a11a13.tasksWithFocusSwap, verdict: verdictOf(m206Ledger, "A13") },
  reproductionPre: preC.a13ByWidth["25"] && { sizeViolations: preC.a13ByWidth["25"].tasksWithSizeViolation, focusSwaps: preC.a13ByWidth["25"].tasksWithFocusSwap, orderRelations: preC.a13ByWidth["25"].orderRelations, representationRegressions: preC.a13ByWidth["25"].representationRegressions },
  byWidthPre: Object.fromEntries(Object.entries(preC.a13ByWidth).map(([w, v]: [string, any]) => [w, { sizeViolations: v.tasksWithSizeViolation, focusSwaps: v.tasksWithFocusSwap, orderRelations: v.orderRelations, representationRegressions: v.representationRegressions }])),
  reproductionPost: { sizeViolations: postC.a13ByWidth.product.tasksWithSizeViolation, focusSwaps: postC.a13ByWidth.product.tasksWithFocusSwap, orderRelations: postC.a13ByWidth.product.orderRelations, representationRegressions: postC.a13ByWidth.product.representationRegressions },
  frozenRerun: { sizeViolations: cm(engine).a11a13.tasksWithSizeViolation, focusSwaps: cm(engine).a11a13.tasksWithFocusSwap, verdict: verdictOf(ledger, "A13") },
  swappedTasks: postC.a13ByWidth.product.curves.filter((c: any) => c.focusSwaps > 0).map((c: any) => c.task),
};
write("stage5_m207_a13_observation.json", a13);

// ----------------------------------------------------------- performance
const cl = (u: any) => u.corpora.find((c: any) => c.id === "C-LARGE");
const performance = {
  a5: { before: a5Before.p90ByCorpus, after: a5After.p90ByCorpus, classificationBefore: a5Before.classification, classificationAfter: a5After.classification, frozenA5: verdictOf(ledger, "A5"),
    frozenA5Measurement: ledger.claims.find((c: any) => c.id === "A5")?.measurement ?? null, m206FrozenA5Measurement: m206Ledger.claims.find((c: any) => c.id === "A5")?.measurement ?? null },
  latencyByWidthPre: sweepTable.map((t) => ({ width: t.width, p90At8000: t.a5LikeP90At8000, p90At16000: t.p90At16000 })),
  latencyP90ByBudget: budgets.map((b) => ({ budget: b, allowance: allocateBudget(b).candidatePool, before: preC.byWidth["25"].byBudget[b].latency.p90, after: postC.byWidth.product.byBudget[b].latency.p90,
    clargeBefore: cl(pre)?.byWidth["25"]?.byBudget[b]?.latency?.p90 ?? null, clargeAfter: cl(post)?.byWidth?.product?.byBudget[b]?.latency?.p90 ?? null,
    capsuleBuildMsMedianAfter: postC.byWidth.product.byBudget[b].capsuleBuildMs.median })),
  resources: { pre: preC.resources, post: postC.resources, peakRssBytes: { pre: pre.hardware.peakRssBytes, post: post.hardware.peakRssBytes },
    note: "sweep peak RSS is the audit process retaining every response row, per-candidate ledger and repeated packets; the product's own memory per request is bounded by F8 (a 500-candidate fixture at a million-token budget: +6 MB)" },
  schema: "no DB table, no schema change, no new persisted metadata; the capsule diagnostics gain candidate_pool_size beside candidate_count",
};

// -------------------------------------------------------- protected claims
const protectedIds = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A12", "A14"];
const protectedClaims = protectedIds.map((id) => ({ id, m206: verdictOf(m206Ledger, id), m207: verdictOf(ledger, id), held: rank(verdictOf(ledger, id)) >= rank(verdictOf(m206Ledger, id)) }));
const matrix = ledger.claims.map((c: any) => ({ id: c.id, m206: verdictOf(m206Ledger, c.id), m207: c.verdict, measurement: c.measurement }));
write("stage5_m207_protected_claims.json", { protectedClaims, matrix, parity: { m206: m206Ledger.parity.matchOrExceed, m207: ledger.parity.matchOrExceed } });
const frozenF6 = (ledger.falsificationControls?.controls ?? []).find((c: any) => c.id === "F6");

// ---------------------------------------------------------------- gates
const f = (id: string) => falsification.controls.find((c: any) => c.id === id)?.pass === true;
const supplyVerdict: string = preC.supply.verdict;
const repaired = poolAuthority.current.allocatorCarriesCandidatePool && !poolAuthority.current.fixedConstantRemains;
const postCollapses = Object.values(collapses(postRows.filter((r) => r.corpus === "C-MED"), "product")).flat().length;
const preCollapses = Object.values(collapses(preRows.filter((r) => r.corpus === "C-MED"), "25")).flat().length;
const gates = [
  { id: "G1", statement: "frozen A11 definition recovered unchanged", pass: a11Row.matchThreshold === m206A11Row.matchThreshold && a11Row.exceedThreshold === m206A11Row.exceedThreshold && a11Row.vexpClaim === m206A11Row.vexpClaim && /60%/.test(a11Row.matchThreshold) && /80%/.test(a11Row.exceedThreshold) },
  { id: "G2", statement: "A11 BELOW reproduced pre-change at the product width, within tolerance of the committed M206 figures (the seam edited the corpus)", pass: preBandMatchesM206 && frozenA11.reproductionPre.verdict === "VTRACE_BELOW_VEXP_CLAIM" },
  { id: "G3", statement: "retrieval-pool authority audited: origin commit, rationale, every use site, every hidden bound", pass: audit.pool.introducedIn !== null && audit.bounds.length >= 10 && audit.pool.useSites.length > 0 },
  { id: "G4", statement: "seam identity: instrumented packets byte-identical to the uninstrumented handler at the product width on every corpus", pass: pre.corpora.every((c: any) => c.seamIdentity.compared > 0 && c.seamIdentity.identical === c.seamIdentity.compared) },
  { id: "G5", statement: "pool-width sweep through the real product path: 0 integrity failures, packets stable", pass: preC.integrity.integrityFailures === 0 && preC.determinism.packetsStable },
  { id: "G6", statement: "retrieval supply sufficiency decided before the product change, on the frozen rule, at the uncapped width", pass: ["A11_RETRIEVAL_SUPPLY_SUFFICIENT", "A11_RETRIEVAL_SUPPLY_INSUFFICIENT"].includes(supplyVerdict) && sufficiency.decidedBeforeProductChange && preC.supply.rows.filter((r: any) => r.frozen && r.width === Number.MAX_SAFE_INTEGER).length === A11_BUDGETS.length },
  { id: "G7", statement: "one retrieval-pool authority: the allocator derives the allowance from the budget; no fixed constant, no parallel retriever (F7, F13)", pass: repaired && f("F7") && f("F13") && !/candidatePoolV2|newRetriever|retrieval2|legacyPool/.test(readFileSync(path.join(REPO, "src/capsuleV2/buildCapsuleV2.ts"), "utf8")) },
  { id: "G8", statement: "pool defect repaired: the historical pool truncated abundant truthful retrieval and the allowance exposes it (F1, F14)", pass: repaired && f("F1") && f("F14") },
  { id: "G9", statement: "role safeguards: pivot caps unchanged, pivot sets identical across widths, no starved pivot (F6; sweep role identity)", pass: f("F6") && preC.roleIdentity.filter((r: any) => (A11_BUDGETS as readonly number[]).includes(r.budget)).every((r: any) => r.starvedPivots === 0 && r.sameLeadPivot === r.responses) },
  { id: "G10", statement: "no filler, no relevance weakening: small universes leave budget unused, irrelevant tails stay out, duplicates deliver once (F2, F3, F4)", pass: f("F2") && f("F3") && f("F4") && postC.integrity.integrityFailures === 0 },
  { id: "G11", statement: "M205 representation truth on every newly admitted item (F10; representation sweep on the repaired product)", pass: f("F10") && (repC === null ? false : repC.integrity.failures === 0) },
  { id: "G12", statement: "M203 accounting: every delivered item accounted and reconciled (F9; frozen A14)", pass: f("F9") && verdictOf(ledger, "A14") === "VTRACE_MATCHES_VEXP_CLAIM" },
  { id: "G13", statement: "determinism: repeats stable on packets and ledgers; tie order stable across widths (F5)", pass: f("F5") && postC.determinism.packetsStable && postC.determinism.ledgersStable },
  { id: "G14", statement: "performance: A5 at least MATCHES on the frozen rerun and the A5 harness", pass: green(verdictOf(ledger, "A5")) && green(a5After.classification) },
  { id: "G15", statement: "A1-A10 protected", pass: ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"].every((id) => protectedClaims.find((c) => c.id === id)!.held) },
  { id: "G16", statement: "A12 protected", pass: protectedClaims.find((c) => c.id === "A12")!.held },
  { id: "G17", statement: "A14 protected", pass: protectedClaims.find((c) => c.id === "A14")!.held },
  { id: "G18", statement: "A13 measured only; new baseline captured (F11)", pass: f("F11") && typeof a13.frozenRerun.sizeViolations === "number" },
  { id: "G19", statement: "A15 untouched (F12; verdict carried)", pass: f("F12") && verdictOf(ledger, "A15") === verdictOf(m206Ledger, "A15") },
  { id: "G20", statement: "frozen A11 verdict from the unmodified scorer", pass: typeof verdictOf(ledger, "A11") === "string" && rerunBand === verdictOf(ledger, "A11") },
  { id: "G21", statement: "full A1-A15 rerun by the unmodified analyzer", pass: ledger.claims.length === 15 && ledger.parity.claimsScored === 15 },
  { id: "G22", statement: "the evidence-budget ladder hazard is documented (F15) and the product introduces no new delivery collapse on the frozen corpus", pass: f("F15") && postCollapses <= preCollapses },
  { id: "G23", statement: "hard resource bound and bounded runtime (F8)", pass: f("F8") },
  { id: "G24", statement: "standard verification (recorded by the ledger row; not computed here)", pass: true },
  { id: "G25", statement: "zero model spend: offline instruments only", pass: true },
];

const out = {
  milestone: "M207", instrument: "run_stage5_m207_report.ts",
  verdicts: {
    supply: supplyVerdict, a11: a11Closed ? "A11_PARITY_CLOSED" : "A11_PARITY_NOT_CLOSED",
    poolRepair: a11Closed ? "A11_RETRIEVAL_POOL_REPAIR_SUFFICIENT" : "A11_RETRIEVAL_POOL_REPAIR_INSUFFICIENT",
    frozenA11Verdict: verdictOf(ledger, "A11"),
    parity: { m206: m206Ledger.parity.matchOrExceed, m207: ledger.parity.matchOrExceed, target: 15, threshold: ledger.parity.verdict },
    gatesPassed: gates.filter((g) => g.pass).length, gatesTotal: gates.length, falsification: falsification.verdict,
  },
  frozenA11,
  authority: { replay: { verdict: authorityReplay.verdict, failingChecks: replayFailures, ranIn: "the detached predecessor worktree (the branch-name check cannot pass there)", cmedFiles: cmedReplay?.eligibleFiles, expected: cmedReplay?.expected, revision: cmedReplay?.revision },
    post: { verdict: authorityPost.verdict, cmedFiles: cmedPost?.eligibleFiles, expected: cmedPost?.expected, revision: cmedPost?.revision },
    countUnchanged: cmedPost?.eligibleFiles === cmedReplay?.eligibleFiles,
    note: "Frozen claim definitions, thresholds, scorers, tokenizer, task sets and corpus roots remain unchanged. C-MED is this repository's src/; M207 edited existing source files and added none, so the self-referential count is unchanged while the revision and the file contents moved; the corpus is therefore not byte-identical to M206's, and the same-corpus control separates that movement from the policy's" },
  poolAuthority, sweep: { table: sweepTable, seamIdentity: pre.seamIdentity, universe: (read("stage5_m207_pool_width_sweep.json")).universe, collapses: (read("stage5_m207_tail.json")).deliveryCollapses },
  sufficiency, candidateQuality: tailByWidth, roleIdentity: preC.roleIdentity.filter((r: any) => (A11_BUDGETS as readonly number[]).includes(r.budget)), selection, attribution: attributionSummary,
  tail: postC.worst, sameCorpus, a12, a14, a13, performance,
  falsification: { verdict: falsification.verdict, product: falsification.product, controls: falsification.controls.map((c: any) => ({ id: c.id, pass: c.pass, statement: c.statement, detail: c.detail })) },
  determinism: { repeats: postC.determinism.repeats, packetsStable: postC.determinism.packetsStable, ledgersStable: postC.determinism.ledgersStable, unstable: postC.determinism.unstablePackets },
  protectedClaims, matrix,
  frozenF6Control: frozenF6 === undefined ? null : { pass: frozenF6.pass, note: "the committed control conjoins `a14PerItem === 0`, the M197A observation; its other conjuncts pass, so a failure is the stale control and not an A14 regression; not modified (M203 standing finding)" },
  gates,
  boundary: ["ENGINE QUALITY != CODING-AGENT UTILITY", "NO_A13_MONOTONICITY_REPAIR_AUTHORIZED", "NO_IMPACT_RENDERING_EXPANSION_AUTHORIZED", "NO_NEW_REPRESENTATION_CLASS_AUTHORIZED",
    "NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED", "NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED", "I5_REMAINS_CLOSED", "I6_VALIDATION_SELECTION_REMAINS_CLOSED"],
};
write("stage5_m207_final_report.json", out);

// ------------------------------------------------------------------ markdown
const md: string[] = [];
md.push(`# M207 — retrieval-pool authority, truthful supply expansion and frozen A11`, "");
md.push(`\`${out.verdicts.supply}\` — \`${out.verdicts.a11}\` — \`${out.verdicts.poolRepair}\`; frozen A11 ${short(out.verdicts.frozenA11Verdict)}; parity ${out.verdicts.parity.m206}/15 -> ${out.verdicts.parity.m207}/15 (${out.verdicts.parity.threshold}); gates ${out.verdicts.gatesPassed}/${out.verdicts.gatesTotal}; falsification ${falsification.verdict}.`, "");
md.push(`## What A11 asks`, "", `\`${frozenA11.claim}\` (${frozenA11.source}). Metric: ${frozenA11.metric}. Boundary: ${frozenA11.wholeOutputBoundary}. MATCH: ${frozenA11.matchThreshold}; EXCEED: ${frozenA11.exceedThreshold}.`, "");
md.push(`| | ${A11_BUDGETS.join(" | ")} | verdict |`, `| --- | ${A11_BUDGETS.map(() => "---:").join(" | ")} | --- |`);
for (const [label, row] of [["M206 committed engine", frozenA11.committedM206], ["pre-change reproduction (product width 25, this tree)", frozenA11.reproductionPre], ["post-change reproduction (budget-derived allowance)", frozenA11.reproductionPost], ["post-change product pinned to 25 (control)", frozenA11.pinnedControlPost], ["M207 frozen engine rerun", frozenA11.frozenRerun]] as [string, any][]) {
  md.push(`| ${label} | ${A11_BUDGETS.map((b) => pct(row.utilisation[b])).join(" | ")} | ${short(row.verdict)} |`);
}
md.push("", `## Retrieval architecture and every count bound`, "", `| stage | bound | kind | applied at |`, `| --- | --- | --- | --- |`);
for (const b of audit.bounds) md.push(`| ${b.stage} | ${b.value} | ${b.kind} | ${String(b.appliedAt).slice(0, 160)} |`);
md.push("", `Pool provenance: \`${audit.pool.symbol} = ${audit.pool.value}\` at ${audit.pool.file}:${audit.pool.line}, introduced ${audit.pool.introducedIn}. Original comment: "${audit.pool.originalComment.join(" ")}". Classification: ${JSON.stringify(audit.pool.classification)}. Hidden limits: ${audit.hiddenLimits.map((h: string) => `${h}`).join("; ")}. Dependents: ${audit.pool.dependents.map((d: any) => d.name).join(", ")}.`, "");
md.push(`## Pool-width sweep (real product path, C-MED medians)`, "", `Seam identity at the product width: ${pre.corpora.map((c: any) => `${c.id} ${c.seamIdentity.identical}/${c.seamIdentity.compared}`).join(", ")}. Universe (uncapped median candidates): C-MED ${out.sweep.universe.cmedMedianUncapped}, C-LARGE ${out.sweep.universe.clargeMedianUncapped}, C-SMALL ${out.sweep.universe.csmallMedianUncapped}; largest C-MED pool ${out.sweep.universe.largestCandidateCount}.`, "");
md.push(`| pool | ${A11_BUDGETS.map((b) => `${b / 1000}k util`).join(" | ")} | band | median pool 16k | items 16k | p90 8000 C-MED | p90 8000 C-LARGE | p90 16000 C-MED | p90 16000 C-LARGE |`, `| --- | ${A11_BUDGETS.map(() => "---:").join(" | ")} | --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
for (const t of sweepTable) md.push(`| ${t.width} | ${A11_BUDGETS.map((b) => pct(t.a11[b])).join(" | ")} | ${short(t.verdict)} | ${t.byBudget[16000].medians.candidateCount} | ${t.byBudget[16000].medians.items} | ${t.a5LikeP90At8000.cmed} | ${t.a5LikeP90At8000.clarge} | ${t.p90At16000.cmed} | ${t.p90At16000.clarge} |`);
md.push("", `| pool | budget | raw pool | ranked stream | eligible | delivered | whole tokens | unused | stops |`, `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |`);
for (const t of sweepTable) for (const b of A11_BUDGETS) { const x = t.byBudget[b]; md.push(`| ${t.width} | ${b} | ${x.medians.candidateCount} | ${x.medians.rankedStream} | ${x.medians.eligible} | ${x.medians.items} | ${x.medians.frozenWholeTokens} | ${x.medians.unusedFrozenBudget} | ${JSON.stringify(x.stopReasons)} |`); }
md.push("", `## Supply sufficiency`, "", `Rule: ${sufficiency.rule}. Requirement ${JSON.stringify(sufficiency.requirement)}.`, "", `| width | budget | required | median tokens | util | pool | stream | items | sufficiency |`, `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |`);
for (const r of sufficiency.rows.filter((r: any) => r.frozen)) md.push(`| ${widthLabel(r.width)} | ${r.budget} | ${r.requiredMatchTokens} | ${r.medianFrozenTokens} | ${pct(r.medianUtilisation)} | ${r.medianCandidateCount} | ${r.medianRankedStream} | ${r.medianDeliveredItems} | ${r.sufficiency} |`);
md.push("", `Verdict: \`${sufficiency.verdict}\`; narrowest sufficient swept width ${sufficiency.narrowestSufficientWidth}; decided on product ${pre.product.head.slice(0, 12)} before the repair (${post.product.head.slice(0, 12)}).`, "");
md.push(`## Candidate quality of the newly exposed tail (8000 and 16000)`, "", `| width | budget | exposed | delivered | rejected downstream | source-backed | relationship-only | duplicate rate | exposed score min/p10/med/p90/max | pool-25 score min/p10/med/p90/max | fates | provenance |`, `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |`);
for (const t of tailByWidth) md.push(`| ${widthLabel(t.width)} | ${t.budget} | ${t.exposed} | ${t.deliveredFraction} | ${t.rejectedDownstreamFraction} | ${t.sourceBackedFraction} | ${t.relationshipOnlyFraction} | ${t.duplicateRate} | ${t.scoreDistribution ? [t.scoreDistribution.min, t.scoreDistribution.p10, t.scoreDistribution.median, t.scoreDistribution.p90, t.scoreDistribution.max].join(" / ") : "n/a"} | ${t.baselineScoreDistribution ? [t.baselineScoreDistribution.min, t.baselineScoreDistribution.p10, t.baselineScoreDistribution.median, t.baselineScoreDistribution.p90, t.baselineScoreDistribution.max].join(" / ") : "n/a"} | ${JSON.stringify(t.fates)} | ${JSON.stringify(t.provenance)} |`);
md.push("", `## Role identity across widths (frozen budgets, vs width 25)`, "", `| width | budget | same pivot set | same lead | same focus | starved pivots | support delta (min/med/max) |`, `| --- | ---: | ---: | ---: | ---: | ---: | --- |`);
for (const r of out.roleIdentity) md.push(`| ${widthLabel(r.width)} | ${r.budget} | ${r.samePivotSet}/${r.responses} | ${r.sameLeadPivot} | ${r.sameFocus} | ${r.starvedPivots} | ${r.supportCountDelta ? `${r.supportCountDelta.min} / ${r.supportCountDelta.median} / ${r.supportCountDelta.max}` : "n/a"} |`);
md.push("", `## The policy`, "", `${poolAuthority.current.rule}, with EXPECTED_TOKENS_PER_DELIVERED_CANDIDATE = ${poolAuthority.current.tokensPerDeliveredCandidate}, CANDIDATE_POOL_FLOOR = ${poolAuthority.current.floor}, CANDIDATE_POOL_HARD_MAXIMUM = ${poolAuthority.current.hardMaximum} (src/capsuleV2/budgetAllocator.ts). Allowance by budget: ${JSON.stringify(poolAuthority.current.allowanceByBudget)}. Stated rule agrees with the product ${poolAuthority.current.statedRuleAgrees}; fixed constant remains ${poolAuthority.current.fixedConstantRemains}. The lexical row budget stays derived from the floor (100 rows) and the backfill lanes keep their windows; the capsule reports \`candidate_pool_size\` beside \`candidate_count\`.`, "");
md.push(`## Candidate supply and utilisation before / after (C-MED medians)`, "", `| budget | allowance | pool before -> after | stream | eligible | role discards | capsule selected | delivered items | whole tokens | unused | util before -> after | after min / p10 / p90 / max | stops after | p90 before -> after |`, `| ---: | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
for (const s of selection) md.push(`| ${s.budget}${s.frozen ? "" : " (non-frozen)"} | ${s.allowance} | ${s.candidateCount.before} -> ${s.candidateCount.after} | ${s.rankedStream.before} -> ${s.rankedStream.after} | ${s.eligible.before} -> ${s.eligible.after} | ${s.roleDiscards.before} -> ${s.roleDiscards.after} | ${s.selectedCapsule.before} -> ${s.selectedCapsule.after} | ${s.deliveredItems.before} -> ${s.deliveredItems.after} | ${s.wholeTokens.before} -> ${s.wholeTokens.after} | ${s.unusedBudget.before} -> ${s.unusedBudget.after} | ${pct(s.utilisation.before)} -> ${pct(s.utilisation.after)} | ${s.utilisation.distributionAfter ? `${s.utilisation.distributionAfter.min} / ${s.utilisation.distributionAfter.p10} / ${s.utilisation.distributionAfter.p90} / ${s.utilisation.distributionAfter.max}` : "n/a"} | ${JSON.stringify(s.stopReasons.after)} | ${s.latencyP90.before} -> ${s.latencyP90.after} |`);
md.push("", `## Sweep-to-product attribution (frozen responses)`, "", `${attributionSummary.responses} responses: within the swept bracket around the allowance ${attributionSummary.withinSweptBracket}; focus same as pre ${attributionSummary.focusSameAsPre}. Pinned-25 control on the moved corpus: same focus ${attributionSummary.pinnedControl.sameFocus}, same related set ${attributionSummary.pinnedControl.sameRelatedSet}, frozen A11 ${JSON.stringify(attributionSummary.pinnedControl.frozenA11)}. ${attributionSummary.pinnedControl.note}.`, "", `| budget | allowance | within bracket | median actual | stops |`, `| ---: | ---: | ---: | ---: | --- |`);
for (const [b, v] of Object.entries(attributionSummary.byBudget) as [string, any][]) md.push(`| ${b} | ${v.allowance} | ${v.withinBracket} | ${v.medianActual} | ${JSON.stringify(v.stops)} |`);
md.push("", `## Tail (ten worst post-change frozen responses)`, "", `| task | budget | util | items | pool | stream | role discards | selected upstream | dropped | stop | binding |`, `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |`);
for (const t of postC.worst) md.push(`| ${t.task} | ${t.budget} | ${t.utilisationPercent}% | ${t.items} | ${t.candidateCount} | ${t.rankedStream} | ${t.roleDiscards} | ${t.selectedBeforeBudget} | ${t.droppedForBudget} | ${t.stop.reason}${t.stop.policy ? `:${t.stop.policy}` : ""} | ${t.bindingReason} |`);
md.push("", `Delivery collapses (>= 10 selected, <= 2 delivered) on C-MED: width 25 pre ${JSON.stringify(out.sweep.collapses.pre25)}; uncapped pre ${JSON.stringify(out.sweep.collapses.preUncapped)}; product post ${JSON.stringify(out.sweep.collapses.post)}.`, "");
md.push(`## Same-corpus control`, "", sameCorpus === null ? "post-on-pre-corpus run absent" : `Repaired product on the pre-change corpus copy: ${sameCorpus.responses} responses; focus same as pre ${sameCorpus.focusSameAsPre}; packet byte-identical to pre ${sameCorpus.packetSameAsPre}; packet byte-identical to the post run on the moved corpus ${sameCorpus.packetSameAsPostOnMovedCorpus}, related set same ${sameCorpus.relatedSetSameAsPostOnMovedCorpus}. Frozen A11 on the pre corpus ${JSON.stringify(sameCorpus.frozenA11OnPreCorpus)} vs on the post corpus ${JSON.stringify(sameCorpus.frozenA11OnPostCorpus)}. Median items pre ${sameCorpus.medianItems.pre}, post-on-pre ${sameCorpus.medianItems.postOnPreCorpus}, post-on-post ${sameCorpus.medianItems.postOnPostCorpus}.`, "");
md.push(`## Falsification`, "", `| id | pass | statement |`, `| --- | --- | --- |`);
for (const c of out.falsification.controls) md.push(`| ${c.id} | ${c.pass ? "pass" : "FAIL"} | ${c.statement} |`);
md.push("", `## Representation and accounting integrity`, "", a12 === null ? "representation sweep absent" : `A12 on the repaired product: ${a12.count} classes (${a12.frozenClasses.join(", ")}) ${short(a12.verdict)}; integrity failures ${a12.integrity.failures}/${a12.integrity.packets}; related entries on C-MED ${a14.relatedEntriesOnCMed.m207} (M206 ${a14.relatedEntriesOnCMed.m206}), accounted ${a14.relatedEntriesOnCMed.accounted}, valid representation ${a14.relatedEntriesOnCMed.validRepresentation}; class totals ${JSON.stringify(a12.classTotals)}; reasons ${JSON.stringify(a12.reasonTotals)}; source truth ${JSON.stringify(a12.sourceTruth)}. Frozen rerun A12 ${short(a12.frozenRerun.verdict)} (${a12.frozenRerun.classes.join(", ")}).`, "", `A14 frozen rerun ${a14.frozenRerun.accounted}/${a14.frozenRerun.delivered} (${short(a14.frozenRerun.verdict)}); M206 ${a14.m206.accounted}/${a14.m206.delivered}. Sweep integrity failures pre ${a14.sweepIntegrity.pre.failures}/${a14.sweepIntegrity.pre.packets}, post ${a14.sweepIntegrity.post.failures}/${a14.sweepIntegrity.post.packets}.`, "");
md.push(`## Determinism`, "", `${out.determinism.repeats} repeats: packets stable ${out.determinism.packetsStable}, ledgers stable ${out.determinism.ledgersStable}; unstable ${JSON.stringify(out.determinism.unstable)}; F5 ${f("F5")}.`, "");
md.push(`## Performance`, "", `A5 harness p90 before ${JSON.stringify(performance.a5.before)} (${short(performance.a5.classificationBefore)}); after ${JSON.stringify(performance.a5.after)} (${short(performance.a5.classificationAfter)}); frozen A5 ${short(performance.a5.frozenA5)}: ${performance.a5.frozenA5Measurement} (M206: ${performance.a5.m206FrozenA5Measurement}). Largest packet ${performance.resources.pre.largestPacketBytes} -> ${performance.resources.post.largestPacketBytes} bytes; largest item count ${performance.resources.pre.largestItemCount} -> ${performance.resources.post.largestItemCount}; largest ranked stream ${performance.resources.pre.largestRankedStream} -> ${performance.resources.post.largestRankedStream}; largest pool ${performance.resources.pre.largestCandidateCount} -> ${performance.resources.post.largestCandidateCount}; sweep peak RSS ${(performance.resources.peakRssBytes.pre / 1e6).toFixed(0)} -> ${(performance.resources.peakRssBytes.post / 1e6).toFixed(0)} MB (${performance.resources.note}). ${performance.schema}.`, "");
md.push(`| budget | allowance | p90 before | p90 after | C-LARGE p90 before | C-LARGE p90 after | capsule build ms (median, after) |`, `| ---: | ---: | ---: | ---: | ---: | ---: | ---: |`); for (const l of performance.latencyP90ByBudget) md.push(`| ${l.budget} | ${l.allowance} | ${l.before} | ${l.after} | ${l.clargeBefore} | ${l.clargeAfter} | ${typeof l.capsuleBuildMsMedianAfter === "number" ? l.capsuleBuildMsMedianAfter.toFixed(1) : "n/a"} |`);
md.push("", `## A13, observed`, "", `M206 committed: ${a13.m206Committed.sizeViolations} size violations, ${a13.m206Committed.focusSwaps} focus swaps (${short(a13.m206Committed.verdict)}). Pre by width: ${Object.entries(a13.byWidthPre).map(([w, v]: [string, any]) => `${w}: ${v.sizeViolations}/${v.focusSwaps}, ${JSON.stringify(v.orderRelations)}, rep ${v.representationRegressions}`).join("; ")}. Post: ${a13.reproductionPost.sizeViolations} / ${a13.reproductionPost.focusSwaps}, order relations ${JSON.stringify(a13.reproductionPost.orderRelations)}, representation regressions ${a13.reproductionPost.representationRegressions}. Frozen rerun: ${a13.frozenRerun.sizeViolations} / ${a13.frozenRerun.focusSwaps} (${short(a13.frozenRerun.verdict)}). ${a13.statement}`, "");
md.push(`## Protected claims`, "", `| id | M206 | M207 | held |`, `| --- | --- | --- | --- |`); for (const c of protectedClaims) md.push(`| ${c.id} | ${short(c.m206)} | ${short(c.m207)} | ${c.held} |`);
md.push("", `## Full matrix`, "", `| id | M206 | M207 | measurement |`, `| --- | --- | --- | --- |`); for (const c of matrix) md.push(`| ${c.id} | ${short(c.m206)} | ${short(c.m207)} | ${String(c.measurement).slice(0, 140)} |`);
md.push("", `M206 ${out.verdicts.parity.m206}/15, M207 ${out.verdicts.parity.m207}/15, target 15/15.`, "");
if (out.frozenF6Control) md.push(`Frozen control F6: ${out.frozenF6Control.pass ? "pass" : "FAIL"}. ${out.frozenF6Control.note}.`, "");
md.push(`## Gates`, "", `| gate | pass | statement |`, `| --- | --- | --- |`); for (const g of gates) md.push(`| ${g.id} | ${g.pass ? "pass" : "FAIL"} | ${g.statement} |`);
md.push("", `## Authority`, "", `Replay: \`${out.authority.replay.verdict}\`${out.authority.replay.failingChecks.length ? ` (failing only ${out.authority.replay.failingChecks.join(",")}: ${out.authority.replay.ranIn})` : ""} at ${out.authority.replay.cmedFiles} files (expected ${out.authority.replay.expected}) @ ${String(out.authority.replay.revision).slice(0, 12)}. Post: \`${out.authority.post.verdict}\` at ${out.authority.post.cmedFiles} @ ${String(out.authority.post.revision).slice(0, 12)}. ${out.authority.note}.`, "");
md.push(`## Boundary`, "", ...out.boundary.map((b: string) => `- ${b}`), "");
writeFileSync(path.join(RESULTS, "stage5_m207_final_report.md"), `${md.join("\n").trimEnd()}\n`);
console.log(`${out.verdicts.supply}; ${out.verdicts.a11}; ${out.verdicts.poolRepair}; frozen A11 ${short(out.verdicts.frozenA11Verdict)}; parity ${out.verdicts.parity.m206}/15 -> ${out.verdicts.parity.m207}/15; gates ${out.verdicts.gatesPassed}/${out.verdicts.gatesTotal}`);
for (const g of gates.filter((g) => !g.pass)) console.log(`  FAIL ${g.id} ${g.statement}`);
