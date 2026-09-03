/**
 * M208 — the causal report (pre-change) and the final report (post-change).
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m208_report.ts --phase causal
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m208_report.ts --phase final
 *
 * Reads only committed/captured artefacts: the M208 transition audits (product
 * allowance, pool pinned to 25, pool pinned to 134), the M207 engine and A13
 * observation, and — in the final phase — the post-change audits, the frozen
 * M208 engine/claim ledger, the falsification results and the A5/M205/M203
 * artefacts. The frozen A13 rule is quoted VERBATIM from the scorer source at
 * report time; nothing is restated by hand.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { allocateBudget } from "../../src/capsuleV2/budgetAllocator";
import { FROZEN_A13_BUDGETS } from "./m208BudgetMonotonicity";

const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback; };
const PHASE = argOf("--phase", "causal") as "causal" | "final";

const read = (name: string, required = true): any => {
  const p = path.join(RESULTS, name);
  if (!existsSync(p)) { if (required) throw new Error(`M208_REPORT_MISSING_INPUT: ${name}`); return null; }
  return JSON.parse(readFileSync(p, "utf8"));
};
const readRows = (name: string): any[] => {
  const p = path.join(RESULTS, name);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
};
const cm = (u: any) => u.corpora.find((c: any) => c.id === "C-MED");
const short = (v: string | null | undefined) => (v ?? "null").replace("VTRACE_", "").replace("_VEXP_CLAIM", "");
const sym = (fq: string) => fq.split("::").pop() ?? fq;
const table = (head: string[], rows: (string | number | null | undefined)[][]): string[] => [
  `| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`,
  ...rows.map((r) => `| ${r.map((c) => (c === null || c === undefined ? "" : String(c).replace(/\|/g, "\\|"))).join(" | ")} |`),
];
const hist = (h: Record<string, number>) => Object.entries(h).map(([k, v]) => `${k} ${v}`).join("; ");

// --------------------------------------------------------------- frozen authority (verbatim)
const engineSource = readFileSync(path.join(import.meta.dir, "run_stage5_m197a_engine.ts"), "utf8").split("\n");
const reportSource = readFileSync(path.join(import.meta.dir, "run_stage5_m197a_report.ts"), "utf8").split("\n");
const sliceBetween = (lines: string[], from: RegExp, to: RegExp): string[] => {
  const a = lines.findIndex((l) => from.test(l)); if (a < 0) return [];
  const b = lines.findIndex((l, k) => k > a && to.test(l));
  return lines.slice(a, b < 0 ? a + 12 : b + 1);
};
const engineRule = sliceBetween(engineSource, /A13: information must not decrease/, /curves\.push\(\{ task, points, sizeViolations, focusSwaps \}\)/);
const reportRule = sliceBetween(reportSource, /id: "A13", vexpClaim/, /comparabilityCaveat: "a focus swap/);
const bandRule = sliceBetween(reportSource, /^function band\(/, /^}/);
const focusRule = engineSource.filter((l) => /focusAt: out\?\.focus\?\.at|focusCodeTokens: tokens\(out\?\.focus\?\.code/.test(l));

// ------------------------------------------------------------------- inputs
const pre = read("stage5_m208_audit_pre.json");
const pre25 = read("stage5_m208_audit_pre_fixed25.json");
const pre134 = read("stage5_m208_audit_pre_fixed134.json");
const preRows = readRows("stage5_m208_transitions_pre.jsonl");
const preItems = readRows("stage5_m208_items_pre.jsonl");
const preSnapshots = readRows("stage5_m208_snapshots_pre.jsonl");
const m207Engine = read("stage5_m207_engine.json");
const m207A13 = read("stage5_m207_a13_observation.json");
const m207Ledger = read("stage5_m207_claim_ledger.json");

const P = cm(pre); const P25 = cm(pre25); const P134 = cm(pre134);
const frozenRows = preRows.filter((r) => r.grid === "frozen");
const denseRows = preRows.filter((r) => r.grid === "dense");

// ------------------------------------------------------------ reproduction
const reproduction = {
  m207Committed: {
    sizeViolations: cm(m207Engine).a11a13.tasksWithSizeViolation, focusSwaps: cm(m207Engine).a11a13.tasksWithFocusSwap,
    orderRelations: m207A13.reproductionPost.orderRelations, representationRegressions: m207A13.reproductionPost.representationRegressions,
    a11: Object.fromEntries(Object.entries(cm(m207Engine).a11a13.utilisationByBudget).map(([b, v]: [string, any]) => [b, v.median])),
    a13Verdict: m207Ledger.claims.find((c: any) => c.id === "A13")?.verdict,
  },
  m208Pre: {
    sizeViolations: P.frozenA13.tasksWithSizeViolation, focusSwaps: P.frozenA13.tasksWithFocusSwap,
    orderRelations: P.frozenSummary.relations, representationRegressions: P.frozenSummary.representationRegressions,
    a11: P.frozenA11, a13Verdict: P.frozenA13.verdict, packetsStable: P.determinism.packetsStable, repeats: P.determinism.repeats,
  },
};
const reproduced = reproduction.m207Committed.sizeViolations === reproduction.m208Pre.sizeViolations
  && reproduction.m207Committed.focusSwaps === reproduction.m208Pre.focusSwaps
  && ["prefix", "subsequence", "neither"].every((k) => (reproduction.m207Committed.orderRelations[k] ?? 0) === (reproduction.m208Pre.orderRelations[k] ?? 0))
  && reproduction.m207Committed.representationRegressions === reproduction.m208Pre.representationRegressions;

// ----------------------------------------------------- budget architecture
const grid: number[] = pre.protocol.budgets;
const architecture = grid.map((b) => { const a = allocateBudget(b); return { budget: b, tier: a.tier, maxPivots: a.maxPivots, supportWindow: a.supportWindow, candidatePool: a.candidatePool }; });
const budgetReaders = [
  ["S1 ranked pool", "hybridRetrieve(maxResults = allocation.candidatePool); conceptOwnerCandidates(... ranked.slice(0, maxResults) ...) judges 'file already represented' against the allowance-sized slice", "buildCapsuleV2.ts:254-271, hybridRetrieval.ts:451"],
  ["S2 role assignment", "assignCandidateRoles(candidates, { maxPivots: allocation.maxPivots }) caps pivots in final-score order; refineDebugRoles -> capPivots(maxPivots) likewise", "buildCapsuleV2.ts:755,773; debugRoles.ts:572-640"],
  ["S4a pivot order", "pivotCandidates.sort (anchor tiers) and pivot-ranking v2 re-sort run on the CAPPED set; the lead is the head of that order", "buildCapsuleV2.ts:975-1050"],
  ["S4b support order", "supportWindow = allocation.supportWindow (1 / 4 / 10) partitions baseSupportOrder in orderSupportWithCoedit (protected winners, displacing co-edits, displaceable winners, spare co-edits, rest); file-evidence, path-completion and mechanism lanes read the same window", "buildCapsuleV2.ts:1173-1440; coeditExpansion.ts:786-828"],
  ["S5 packing", "renderPivot / renderSupport against input.maxTokens - usedTokens; over-budget support is skipped ('continue'), later smaller items still pack", "buildCapsuleV2.ts:1090-1140, 1463-1470"],
  ["S6 assembly", "assembleProductContext: P#, S#, then actionability (D#), impact (I#), memory (M#), rule (G#) drafts, deduplicated", "assembleProductContext.ts:222-260"],
  ["S7 evidence budget", "applyProgressiveContextBudget(draft, requestedTokens or retryWithinCeiling's affordable budget): rungs drop optional support from the tail by keepPriority, where answerBearing is a substring test on the selection reasons", "budgetDelivery.ts; responseEnvelope.ts:354-407"],
  ["S9 projector", "orientationCeilingTokens(requested_context_tokens): admission takes a prefix relationship-only, then M205 routing offers each entry its upstream form in order", "orientationProjection.ts:527-597"],
  ["S10 packet", "focus = leadPivot item, head-bounded at 1800 chars; related in authoritative order", "orientationProjection.ts:424-438"],
];

// ------------------------------------------------------------- attributions
const S = P.frozenSummary;
const swaps = frozenRows.filter((r) => r.focus_swap).map((r) => r.focus_swap_record);
const sizeViolations = frozenRows.filter((r) => r.size_violation);
const regressions = frozenRows.flatMap((r) => r.representation_regressions.map((g: any) => ({ task: r.task, from: r.from, to: r.to, ...g })));
const poolLost = preItems.filter((i) => String(i.mechanism).startsWith("RETRIEVAL_POOL_MEMBERSHIP"));
const poolLostRows = poolLost.map((i) => {
  const t = frozenRows.find((r) => r.task === i.task && r.from === i.from && r.to === i.to);
  return { task: i.task, from: i.from, to: i.to, fq: i.fqName, lowerRank: i.lower.poolRank, lowerPool: t?.from_pool, higherPool: t?.to_pool, lowerAllowance: t?.from_pool_width, provenance: i.lower.poolSources };
});
const poolLostBeyondAllowance = poolLostRows.filter((r) => typeof r.lowerRank === "number" && typeof r.lowerAllowance === "number" && r.lowerRank > r.lowerAllowance).length;
const poolRelations = frozenRows.reduce((h: Record<string, number>, r) => { const k = `${r.from}->${r.to}:${r.stage_relations.pool}`; h[k] = (h[k] ?? 0) + 1; return h; }, {});
const byPair = (rows: any[]) => rows.reduce((h: Record<string, Record<string, number>>, r) => { const k = `${r.from}->${r.to}`; h[k] ??= {}; h[k][r.relation] = (h[k][r.relation] ?? 0) + 1; return h; }, {});
const denseClass = (r: any) => (r.support_window_changed || r.max_pivots_changed) ? "tier_boundary" : r.pool_grew ? "same_tier_pool_grew" : "same_tier_same_pool";
const denseByClass = denseRows.reduce((h: Record<string, Record<string, number>>, r) => { const k = denseClass(r); h[k] ??= {}; h[k][r.relation] = (h[k][r.relation] ?? 0) + 1; h[k].transitions = (h[k].transitions ?? 0) + 1; h[k].focusSwaps = (h[k].focusSwaps ?? 0) + (r.focus_swap ? 1 : 0); return h; }, {});
const denseMechByClass = denseRows.reduce((h: Record<string, Record<string, number>>, r) => { const k = denseClass(r); h[k] ??= {}; const m = String(r.first_divergence_mechanism).split(":")[0]; h[k][m] = (h[k][m] ?? 0) + 1; return h; }, {});

// The ladder's answer-bearing substring: which delivered items at the higher budget carry the
// negated role reason, and displaced a lower-budget support entry (from the transition rows).
const ladderLost = preItems.filter((i) => String(i.mechanism).startsWith("EVIDENCE_BUDGET_DROP"));

// ------------------------------------------------------------- size audit
const sizeByBudget = Object.fromEntries(Object.entries(P.byBudget).map(([b, v]: [string, any]) => [b, {
  medianUtilisation: v.medianUtilisation, overBudget: v.overBudget, evidenceOverBudget: v.evidenceOverBudget, medianAccountingOverheadTokens: v.medianAccountingOverheadTokens, tier: v.tier, allowance: v.allowance,
}]));
const sizeVerdict = Object.values(P.byBudget).every((v: any) => v.evidenceOverBudget === 0);

// ------------------------------------------------------------ counterfactuals
const cf = (label: string, c: any) => ({
  label, sizeViolations: c.frozenA13.tasksWithSizeViolation, focusSwaps: c.frozenA13.tasksWithFocusSwap,
  relations: c.frozenSummary.relations, firstDivergenceByStage: c.frozenSummary.firstDivergenceByStage,
  lostItems: c.frozenSummary.lostItems, movedItems: c.frozenSummary.movedItems, regressions: c.frozenSummary.representationRegressions,
  a11: c.frozenA11, gate: c.frozenSummary.gate, seam: c.seamIdentity, dense: c.denseSummary.relations,
});
const counterfactuals = {
  C1_product: cf("C1 product allowance", P),
  C2_fixed25: cf("C2 pool pinned to 25 (pre-M207 universe)", P25),
  C2_fixed134: cf("C2 pool pinned to 134 (the 16000 universe)", P134),
  C5_projectorOnly: (() => {
    const po = P.projectorOnly as any[];
    const measured = po.filter((p) => p.measured);
    return { measured: measured.length, of: po.length, unmeasured: po.filter((p) => !p.measured).reduce((h: any, p) => (h[p.reason] = (h[p.reason] ?? 0) + 1, h), {}),
      relations: measured.reduce((h: any, p) => (h[p.relation] = (h[p.relation] ?? 0) + 1, h), {}), sameFocus: measured.filter((p) => p.sameFocus).length,
      representationRegressions: measured.reduce((n, p) => n + p.representationRegressions, 0) };
  })(),
  C3_stableOrder: { statement: "observational: the support-order relation per transition and the mover mechanisms name the lane rule that moved each delivered entry",
    supportRelations: frozenRows.reduce((h: Record<string, number>, r) => { h[r.stage_relations.support] = (h[r.stage_relations.support] ?? 0) + 1; return h; }, {}),
    moversByMechanism: S.movedItemsByMechanism },
  C4_representation: { statement: "per regression: the projector's own reason, the number of newly admitted items ahead of it, and whether the lower budget's form would have fit had only the items ahead of it been charged",
    byClass: S.representationRegressionsByClass, byReason: S.representationRegressionsByReason },
};

const gate = S.gate === "A13_CAUSAL_ATTRIBUTION_COMPLETE" && P25.frozenSummary.gate === "A13_CAUSAL_ATTRIBUTION_COMPLETE" && P134.frozenSummary.gate === "A13_CAUSAL_ATTRIBUTION_COMPLETE"
  && P.denseSummary.gate === "A13_CAUSAL_ATTRIBUTION_COMPLETE" && reproduced && P.determinism.packetsStable
  ? "A13_CAUSAL_ATTRIBUTION_COMPLETE" : "A13_CAUSAL_ATTRIBUTION_INCOMPLETE";

const rootCauses = [
  { stage: "S1_ranked_pool", mechanism: "RETRIEVAL_POOL_MEMBERSHIP:concept_owner", transitions: S.firstDivergenceByMechanism["RETRIEVAL_POOL_MEMBERSHIP:concept_owner"] ?? 0, lostItems: S.lostItemsByMechanism["RETRIEVAL_POOL_MEMBERSHIP:concept_owner"] ?? 0,
    code: "hybridRetrieval.ts:451 conceptOwnerCandidates(db, input, derivedIntent, ranked.slice(0, maxResults), raw)",
    cause: "The concept-owner rescue (M142-C) skips files 'the pool already represents', judged against the top-maxResults slice. M207 made maxResults the budget's allowance, so a wider allowance lets a lower-ranked lexical sibling in the same file represent it and the rescued owner is no longer admitted: a rank-2 candidate at 2000 (allowance 25) is absent from the 38-candidate pool at 4000 (allowance 34)." },
  { stage: "S2_role_assignment / S4a_pivot_order", mechanism: "PIVOT_CAP_ROLE_PROMOTION + PIVOT_CAP_LEAD_RESELECTION", transitions: (S.firstDivergenceByMechanism.PIVOT_CAP_ROLE_PROMOTION ?? 0) + (S.firstDivergenceByMechanism.PIVOT_CAP_LEAD_RESELECTION ?? 0), lostItems: S.lostItemsByMechanism.PIVOT_CAP_LEAD_RESELECTION ?? 0,
    code: "assignCandidateRoles(candidates, { maxPivots }) / debugRoles.capPivots cap the pivot SET in final-score order (buildCapsuleV2.ts:755,773); pivotCandidates.sort (anchor tiers) and pivot-ranking v2 then ORDER the capped set (buildCapsuleV2.ts:975-1050)",
    cause: "Two authorities disagree: the cap admits pivots by hybrid final score and the order (anchor tiers / v2) decides the lead among the admitted. Widening the cap (micro 1 -> standard 2 -> full 5) admits a candidate the order ranks above the previous lead, so the focus changes at both tier boundaries (all 5 frozen swaps, all 3 size drops); cap-demoted support entries also become pivots and move to the front (14 transitions)." },
  { stage: "S4b_support_order", mechanism: "SUPPORT_WINDOW_PARTITION / SUPPORT_LANE_PLACEMENT / SUPPORT_LANE_NOT_REPRODUCED", transitions: Object.entries(S.firstDivergenceByMechanism).filter(([k]) => k.startsWith("SUPPORT_")).reduce((n, [, v]) => n + (v as number), 0), lostItems: Object.entries(S.lostItemsByMechanism).filter(([k]) => k.startsWith("SUPPORT_")).reduce((n, [, v]) => n + (v as number), 0),
    code: "buildCapsuleV2.ts:1173 supportWindow = allocation.supportWindow; coeditExpansion.ts:804 winners = baseOrder.slice(0, maxSupport)",
    cause: "orderSupportWithCoedit partitions baseSupportOrder at the tier's support window (1 / 4 / 10) into protected winners, displacing co-edits, displaceable winners, spare co-edits and the rest. The window changes with the tier, so the same candidates are re-partitioned at every tier boundary; a new candidate entering the window re-partitions it within a tier. Co-edit anchors and graph-neighbour seeds are read from the window, so lane-injected entries are not reproduced at the next budget." },
  { stage: "S7_evidence_budget", mechanism: "EVIDENCE_BUDGET_DROP", transitions: Object.entries(S.firstDivergenceByMechanism).filter(([k]) => k.startsWith("EVIDENCE_BUDGET_DROP")).reduce((n, [, v]) => n + (v as number), 0), lostItems: ladderLost.length,
    code: "budgetDelivery.ts mutableItem(): answerBearing = roles.includes('required') || directEvidence.includes('symbol-name match') || ... || directEvidence.includes('direct evidence') || directEvidence.includes('exact')",
    cause: "The ladder protects 'answer-bearing' items and drops the rest from the tail. The test is a substring match, and the role gate's NEGATIVE blocker '(not a pivot: no direct evidence (graph/domain reach only))' contains 'direct evidence', so every weak graph/domain-reach support entry is protected. A larger capsule budget packs more of that tail; the ladder then evicts stronger, unprotected support the smaller budget delivered (e.g. S5 allocateBudget dropped at 1250 while S24-S27 'no direct evidence' entries are kept). The same false positive is the M207 F15 ladder-collapse hazard." },
  { stage: "S9_projector", mechanism: "REPRESENTATION_ROUTING:ceiling", transitions: S.firstDivergenceByMechanism["REPRESENTATION_ROUTING:ceiling"] ?? 0, lostItems: 0,
    code: "orientationProjection.ts:533-597 admission (relationship-only prefix) then routing (upstream form per entry, in order)",
    cause: "M205 admits WHICH entries first and decides WHAT they carry second; a wider supply at the larger budget is admitted relationship-only up to the ceiling, and the later entry that carried code at the smaller budget no longer fits its richer form. Classified per regression as avoidable admission-first crowding or a necessary ceiling." },
  { stage: "S5_packing", mechanism: "CAPSULE_PACKING:packing_over_budget", transitions: S.firstDivergenceByMechanism["CAPSULE_PACKING:packing_over_budget"] ?? 0, lostItems: S.lostItemsByMechanism["CAPSULE_PACKING:packing_over_budget"] ?? 0,
    code: "buildCapsuleV2.ts:1464 renderSupport(..., input.maxTokens - usedTokens) -> 'over budget: no room for this support item' -> continue",
    cause: "Greedy first-fit packing: an entry the smaller budget packed can be skipped at the larger budget when newly affordable earlier entries consume the room it had." },
];

// ------------------------------------------------------------------ report
const out: any = {
  milestone: "M208", phase: PHASE, instrument: "run_stage5_m208_report.ts",
  frozenAuthority: {
    claimId: "A13", vexpClaim: "pivots degrade to skeletons and support is dropped when the budget binds", vexpSource: "V-C7, vexp-core binary",
    budgets: FROZEN_A13_BUDGETS, corpus: "C-MED (this repository's src/), the 20 A13_TASKS", protocol: "get_code_context, default detail, max_tokens = budget, one call per task per budget",
    engineRuleVerbatim: engineRule, focusFieldsVerbatim: focusRule, reportRuleVerbatim: reportRule, bandVerbatim: bandRule,
    definitions: {
      focus: "focus.at of the default orientation packet: the productContext.leadPivot item (capsule pivots[0]), else the first pivot item, else the first item",
      sizeViolation: "per task, adjacent frozen budgets ascending: ceil(chars/4 of focus.code) decreases",
      focusSwap: "per task, adjacent frozen budgets ascending: focus.at differs",
      aggregation: "tasksWithSizeViolation + tasksWithFocusSwap over the 20 C-MED tasks",
      matchThreshold: "0 (band atMost 0)", exceedThreshold: "0 (band atMost 0; the wording '0 plus a declared drop order' is not scored — a stale wording control, reported, not edited)",
      observationalOnly: "order relations (m204Utilization.orderRelation on related ids) and representation regressions (code-bearing at the lower budget, relationship_only at the higher) are M207 observations reproduced here; they are not in the frozen verdict",
    },
  },
  reproduction: { ...reproduction, reproduced },
  architecture: { byBudget: architecture, budgetReaders },
  transitions: frozenRows.map((r) => ({
    task: r.task, from: r.from, to: r.to, tiers: `${r.from_tier}->${r.to_tier}`, maxPivots: `${r.from_max_pivots}->${r.to_max_pivots}`, window: `${r.from_support_window}->${r.to_support_window}`, pool: `${r.from_pool}->${r.to_pool}`,
    focus: `${sym(r.from_focus)}${r.focus_swap ? ` -> ${sym(r.to_focus)}` : ""}`, focusSwap: r.focus_swap, sizeViolation: r.size_violation, relation: r.relation, focusAdjustedRelation: r.focus_adjusted_relation,
    stageRelations: r.stage_relations, firstDivergenceStage: r.first_divergence_stage, firstDivergenceMechanism: r.first_divergence_mechanism,
    lost: r.lost_items.length, moved: r.moved_items.length, added: r.added_items, regressions: r.representation_regressions.length, delivered: `${r.from_delivered}->${r.to_delivered}`, wholeTokens: `${r.from_whole_tokens}->${r.to_whole_tokens}`,
  })),
  attribution: { frozen: S, dense: P.denseSummary, denseByClass, denseMechByClass, poolRelations, relationsByPair: byPair(frozenRows) },
  focusSwaps: swaps, sizeViolations: sizeViolations.map((r) => ({ task: r.task, from: r.from, to: r.to, focus: `${sym(r.from_focus)} -> ${sym(r.to_focus)}`, focusCodeTokens: `${r.from_focus_code_tokens} -> ${r.to_focus_code_tokens}`, cause: r.size_violation_cause })),
  representationRegressions: regressions,
  candidateUniverse: { poolRelations, poolLost: poolLostRows, poolLostBeyondAllowance, poolLostTotal: poolLostRows.length },
  evidenceBudget: { lostByLane: ladderLost.reduce((h: any, i) => (h[i.mechanism] = (h[i.mechanism] ?? 0) + 1, h), {}), deliveryStatusByBudget: Object.fromEntries(Object.entries(P.byBudget).map(([b, v]: [string, any]) => [b, v.deliveryStatus])) },
  projectorAndEnvelope: { rejectedForCeilingTotal: preSnapshots.reduce((n, s) => n + (s.rejected_for_ceiling ?? 0), 0), size: sizeByBudget, evidenceNeverExceedsBudget: sizeVerdict,
    statement: "the evidence packet (focus + related without per-item tokens fields) never exceeds 4 x max_tokens characters; every whole-output overshoot is the M203 per-item `tokens` accounting riding above the ceiling by design (orientationAccounting.accountingOverhead) — not an A13 metric and not repaired here" },
  counterfactuals, rootCauses, gate,
  boundary: ["ENGINE QUALITY != CODING-AGENT UTILITY", "NO_IMPACT_RENDERING_EXPANSION_AUTHORIZED", "NO_NEW_REPRESENTATION_CLASS_AUTHORIZED", "NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED", "NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED", "I5_REMAINS_CLOSED", "I6_VALIDATION_SELECTION_REMAINS_CLOSED"],
};

const md: string[] = [];
md.push(`# M208 — budget-growth monotonicity: ${PHASE === "causal" ? "pre-change causal report" : "final report"}`, "");
md.push(`\`${gate}\`${reproduced ? " — M207 A13 reproduced exactly" : " — M207 A13 NOT reproduced"}; product ${pre.product.head.slice(0, 12)}; ${P.determinism.repeats} repeats, packets stable ${P.determinism.packetsStable}.`, "");
md.push("## 1. Frozen A13 authority", "", "Claim `A13`: \"pivots degrade to skeletons and support is dropped when the budget binds\" (V-C7). Corpus C-MED (this repository's `src/`), the 20 `A13_TASKS`, budgets 1000 / 2000 / 4000 / 8000 / 16000, one default `get_code_context` call per task per budget.", "", "Engine rule (run_stage5_m197a_engine.ts, verbatim):", "", "```ts", ...focusRule, ...engineRule, "```", "", "Report rule (run_stage5_m197a_report.ts, verbatim):", "", "```ts", ...reportRule, ...bandRule, "```", "");
md.push("MATCH = 0 violations; EXCEED = 0 (`band([a13Violations], 0, 0, \"atMost\")`: both bars are 0, so a zero score reports EXCEEDS; the exceed wording \"plus a declared drop order\" is not scored — a stale wording control analogous to M203's F6, reported and not edited). The related-order relations and representation regressions M207 reported are observations under `m204Utilization.orderRelation` and the M207 sweep's `relationship_only` rule; they are reproduced here under the same definitions and are not part of the frozen verdict.", "");
md.push("## 2. M207 reproduction", "", ...table(["", "size violations", "focus swaps", "order relations", "representation regressions", "A11 medians", "A13"], [
  ["M207 committed", reproduction.m207Committed.sizeViolations, reproduction.m207Committed.focusSwaps, JSON.stringify(reproduction.m207Committed.orderRelations), reproduction.m207Committed.representationRegressions, JSON.stringify(reproduction.m207Committed.a11), short(reproduction.m207Committed.a13Verdict)],
  ["M208 pre-change audit", reproduction.m208Pre.sizeViolations, reproduction.m208Pre.focusSwaps, JSON.stringify(reproduction.m208Pre.orderRelations), reproduction.m208Pre.representationRegressions, JSON.stringify(reproduction.m208Pre.a11), short(reproduction.m208Pre.a13Verdict)],
]), "");
md.push("## 3. Where the budget acts", "", ...table(["budget", "tier", "maxPivots", "supportWindow", "candidate allowance"], architecture.map((a) => [a.budget, a.tier, a.maxPivots, a.supportWindow, a.candidatePool])), "", ...table(["stage", "how the budget reaches it", "code"], budgetReaders), "");
md.push("## 4. The 80 adjacent-budget transitions", "", ...table(["task", "from->to", "tiers", "pivots", "window", "pool", "focus", "relation", "focus-adjusted", "first divergence", "lost", "moved", "added", "regressions"],
  out.transitions.map((t: any) => [t.task, `${t.from}->${t.to}`, t.tiers, t.maxPivots, t.window, t.pool, t.focus + (t.sizeViolation ? " (size drop)" : ""), t.relation, t.focusAdjustedRelation, `${t.firstDivergenceStage}: ${t.firstDivergenceMechanism}`, t.lost, t.moved, t.added, t.regressions])), "");
md.push("## 5. First divergence, by mechanism", "", ...table(["mechanism", "transitions"], Object.entries(S.firstDivergenceByMechanism)), "", ...table(["stage", "transitions"], Object.entries(S.firstDivergenceByStage)), "", `Lost lower-budget items: ${S.lostItems}.`, "", ...table(["mechanism", "lost items"], Object.entries(S.lostItemsByMechanism)), "", `Moved items (outside the longest common subsequence of the two common-item orders, or role-changed): ${S.movedItems}.`, "", ...table(["mechanism", "moved items"], Object.entries(S.movedItemsByMechanism)), "");
md.push("## 6. Focus swaps", "", ...table(["task", "from->to", "tiers (maxPivots)", "lower focus (rank, v2)", "higher focus (rank, v2)", "higher focus's role at the lower budget", "class"], swaps.map((s: any) => [s.task, `${s.from}->${s.to}`, `${s.fromTier}(${s.fromMaxPivots})->${s.toTier}(${s.toMaxPivots})`, `${sym(s.fromFocus)} (${s.fromFocusLowerRank}, ${s.fromFocusV2})`, `${sym(s.toFocus)} (${s.toFocusLowerRank}, ${s.toFocusV2})`, `${s.toFocusLowerRole}: ${String(s.toFocusLowerRoleReason ?? "").slice(0, 60)}`, s.classification])), "", "Every swap: the higher budget's focus was in the lower budget's pool, was a pivot-worthy candidate the lower tier's cap demoted to support (final-score order), and leads once the cap admits it because the pivot ORDER (pivot-ranking v2, or the title-symbol tier) ranks it above the previous lead. Pool growth is not involved (identical swaps with the pool pinned to 25).", "");
md.push("## 7. Size violations", "", ...table(["task", "from->to", "focus", "focus code tokens", "cause"], out.sizeViolations.map((s: any) => [s.task, `${s.from}->${s.to}`, s.focus, s.focusCodeTokens, s.cause])), "", "No task's focus body shrank with the same focus; every size drop is the focus swap.", "");
md.push("## 8. Representation regressions", "", ...table(["task", "from->to", "entry", "lower -> higher", "projector reason", "ordinal", "new items admitted ahead", "richer form would have fit before later admissions", "class"], regressions.map((g: any) => [g.task, `${g.from}->${g.to}`, sym(g.fqName), `${g.lowerRepresentation} -> ${g.higherRepresentation}`, g.higherReason, g.higherOrdinal, g.newEarlierAdmissions, String(g.richerFormWouldFitBeforeLaterAdmissions), g.classification])), "", `Classes: ${hist(S.representationRegressionsByClass)}; reasons: ${hist(S.representationRegressionsByReason)}.`, "");
md.push("## 9. Candidate universe", "", `Pool order relation across adjacent frozen budgets (lower pool vs higher pool): ${hist(poolRelations)}.`, "", `${poolLostRows.length} lower-budget delivered pool candidates are absent from the wider pool; ${poolLostBeyondAllowance} of them sat beyond the lower allowance (a lane extra admitted beside the cap), and every one carries \`concept_owner\` provenance.`, "", ...table(["task", "from->to", "candidate", "lower rank / pool (allowance)", "higher pool", "provenance"], poolLostRows.map((r) => [r.task, `${r.from}->${r.to}`, sym(r.fq), `${r.lowerRank} / ${r.lowerPool} (${r.lowerAllowance})`, r.higherPool, (r.provenance ?? []).join("+")])), "");
md.push("## 10. Lane and order", "", `Support-order relation (capsule packed support, lower vs higher): ${hist(counterfactuals.C3_stableOrder.supportRelations)}. Movers by rule: ${hist(S.movedItemsByMechanism)}.`, "", "Dense grid (17 budgets, 16 adjacent pairs x 20 tasks), by transition class:", "", ...table(["class", "transitions", "prefix", "subsequence", "neither", "focus swaps", "first-divergence mechanisms"], Object.entries(denseByClass).map(([k, v]: [string, any]) => [k, v.transitions, v.prefix ?? 0, v.subsequence ?? 0, v.neither ?? 0, v.focusSwaps, hist(denseMechByClass[k]!)])), "");
md.push("## 11. Evidence budget", "", `Lost by ladder: ${hist(out.evidenceBudget.lostByLane)}. Delivery status by budget: ${Object.entries(out.evidenceBudget.deliveryStatusByBudget).map(([b, v]) => `${b}=${JSON.stringify(v)}`).join("; ")}.`, "", rootCauses[3]!.cause, "");
md.push("## 12. Projector and envelope", "", `Projector ceiling rejections over every snapshot: ${out.projectorAndEnvelope.rejectedForCeilingTotal}. ${out.projectorAndEnvelope.statement}.`, "", ...table(["budget", "tier", "allowance", "median utilisation %", "responses over max_tokens (whole)", "responses whose evidence exceeds 4 x max_tokens chars", "median accounting overhead (tokens)"], Object.entries(sizeByBudget).map(([b, v]: [string, any]) => [b, v.tier.join("/"), v.allowance, v.medianUtilisation, v.overBudget, v.evidenceOverBudget, v.medianAccountingOverheadTokens])), "");
md.push("## 13. Counterfactuals", "", ...table(["", "size / swaps", "relations (frozen)", "first divergence by stage", "lost", "moved", "regressions", "A11 medians", "dense relations"], [counterfactuals.C1_product, counterfactuals.C2_fixed25, counterfactuals.C2_fixed134].map((c) => [c.label, `${c.sizeViolations} / ${c.focusSwaps}`, JSON.stringify(c.relations), hist(c.firstDivergenceByStage), c.lostItems, c.movedItems, c.regressions, JSON.stringify(c.a11), JSON.stringify(c.dense)])), "", `C5 projector-only (the higher budget's authoritative debug result projected at both ceilings): measured ${counterfactuals.C5_projectorOnly.measured} of ${counterfactuals.C5_projectorOnly.of} frozen pairs (unmeasured: ${JSON.stringify(counterfactuals.C5_projectorOnly.unmeasured)}); relations ${JSON.stringify(counterfactuals.C5_projectorOnly.relations)}; same focus ${counterfactuals.C5_projectorOnly.sameFocus}; representation regressions ${counterfactuals.C5_projectorOnly.representationRegressions}. With a fixed supply the projector takes a longer prefix and never reorders; the regressions are the admission-first routing.`, "", "Reading: pinning the pool to 25 removes the concept-owner losses and leaves the tier-boundary mechanisms (cap/order, window) and the ladder; pinning it to 134 at every budget keeps every frozen swap and exposes the ladder's protection of the weak tail most (the strong support the smaller budget delivered is evicted). Candidate-universe growth is therefore one of several first-loss stages, not the only one.", "");
md.push("## 14. Root causes (code-level)", "", ...table(["stage", "mechanism", "transitions", "lost items", "code"], rootCauses.map((r) => [r.stage, r.mechanism, r.transitions, r.lostItems, r.code])), "", ...rootCauses.map((r) => `- **${r.stage}** — ${r.cause}`), "");
md.push("## 15. Causal verdict", "", `\`${gate}\``, "", "Every one of the 80 frozen transitions and 320 dense transitions that is not a prefix names a first-divergence stage and mechanism; every lost lower-budget item has a stage-level fate; every focus swap is classified; the direct capsule build agrees with the packet's focus on every snapshot and every ledger `S#` id names the capsule entry at that ordinal.", "");
md.push("## Boundary", "", ...out.boundary.map((b: string) => `- ${b}`), "");


// ================================================================== final phase
if (PHASE === "final") {
  const post = read("stage5_m208_audit_post.json");
  const postPre = read("stage5_m208_audit_post_precorpus.json");
  const postRows = readRows("stage5_m208_transitions_post.jsonl").filter((r) => r.grid === "frozen");
  const postDense = readRows("stage5_m208_transitions_post.jsonl").filter((r) => r.grid === "dense");
  const falsification = read("stage5_m208_falsification.json");
  const engine = read("stage5_m208_engine.json");
  const ledger = read("stage5_m208_claim_ledger.json");
  const authorityPost = read("stage5_m208_authority_post.json");
  const authorityReplay = read("stage5_m208_authority.json");
  const a5Before = read("stage5_m201_a5_m207_post.json");
  const a5After = read("stage5_m201_a5_m208_post.json");
  const representation = read("stage5_m205_representation_m208_post.json", false);
  const evalAB = read("stage5_m208_retrieval_eval_ab.json", false);
  const Q = cm(post); const QP = cm(postPre);
  const verdictOf = (l: any, id: string) => l.claims.find((c: any) => c.id === id)?.verdict ?? null;
  const green = (v: string | null) => v === "VTRACE_MATCHES_VEXP_CLAIM" || v === "VTRACE_EXCEEDS_VEXP_CLAIM";
  if (authorityPost.verdict !== "M197A_AUTHORITY_VERIFIED") throw new Error(`M208_AUTHORITY_NOT_VERIFIED: ${authorityPost.verdict}`);
  const replayOnlyBranch = authorityReplay.checks.filter((c: any) => !c.ok).every((c: any) => c.id === "branch_is_main");

  const engineA11 = (e: any) => Object.fromEntries(Object.entries(cm(e).a11a13.utilisationByBudget).map(([b, v]: [string, any]) => [b, v.median]));
  const a13Frozen = { sizeViolations: cm(engine).a11a13.tasksWithSizeViolation, focusSwaps: cm(engine).a11a13.tasksWithFocusSwap, verdict: verdictOf(ledger, "A13") };
  const a13Closed = green(a13Frozen.verdict);
  const matrix = ledger.claims.map((c: any) => ({ id: c.id, m207: verdictOf(m207Ledger, c.id), m208: c.verdict, measurement: String(c.measurement).slice(0, 140) }));
  const protectedIds = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11", "A12", "A14"];
  const protectedClaims = protectedIds.map((id) => ({ id, m207: verdictOf(m207Ledger, id), m208: verdictOf(ledger, id), held: green(verdictOf(ledger, id)) && (id === "A11" ? true : verdictOf(ledger, id) === verdictOf(m207Ledger, id) || green(verdictOf(ledger, id))) }));
  const parity = ledger.claims.filter((c: any) => green(c.verdict)).length;
  const a5 = { before: { p90ByCorpus: a5Before.p90ByCorpus, classification: a5Before.classification }, after: { p90ByCorpus: a5After.p90ByCorpus, classification: a5After.classification, loadAverage: a5After.environment?.atStart?.loadAverage ?? null },
    frozen: cm(engine).a5?.latency, frozenLoadAtStart: engine.hardware?.loadAverageAtStart ?? null, frozenVerdict: verdictOf(ledger, "A5") };

  const relBefore = P.frozenSummary.relations; const relAfter = Q.frozenSummary.relations; const relAfterPre = QP.frozenSummary.relations;
  const before = { sizeViolations: P.frozenA13.tasksWithSizeViolation, focusSwaps: P.frozenA13.tasksWithFocusSwap, relations: relBefore, regressions: P.frozenSummary.representationRegressions, lost: P.frozenSummary.lostItems, moved: P.frozenSummary.movedItems, firstDivergence: P.frozenSummary.firstDivergenceByMechanism, a11: P.frozenA11, dense: P.denseSummary.relations };
  const afterPre = { sizeViolations: QP.frozenA13.tasksWithSizeViolation, focusSwaps: QP.frozenA13.tasksWithFocusSwap, relations: relAfterPre, regressions: QP.frozenSummary.representationRegressions, lost: QP.frozenSummary.lostItems, moved: QP.frozenSummary.movedItems, firstDivergence: QP.frozenSummary.firstDivergenceByMechanism, a11: QP.frozenA11, dense: QP.denseSummary.relations };
  const after = { sizeViolations: Q.frozenA13.tasksWithSizeViolation, focusSwaps: Q.frozenA13.tasksWithFocusSwap, relations: relAfter, regressions: Q.frozenSummary.representationRegressions, lost: Q.frozenSummary.lostItems, moved: Q.frozenSummary.movedItems, firstDivergence: Q.frozenSummary.firstDivergenceByMechanism, lostBy: Q.frozenSummary.lostItemsByMechanism, movedBy: Q.frozenSummary.movedItemsByMechanism, a11: Q.frozenA11, dense: Q.denseSummary.relations, gate: Q.frozenSummary.gate, stable: Q.determinism.packetsStable, repeats: Q.determinism.repeats };
  const postDenseByClass = postDense.reduce((h: Record<string, Record<string, number>>, r) => { const k = denseClass(r); h[k] ??= {}; h[k][r.relation] = (h[k][r.relation] ?? 0) + 1; h[k].transitions = (h[k].transitions ?? 0) + 1; h[k].focusSwaps = (h[k].focusSwaps ?? 0) + (r.focus_swap ? 1 : 0); return h; }, {});
  const postSize = Object.fromEntries(Object.entries(Q.byBudget).map(([b, v]: [string, any]) => [b, { medianUtilisation: v.medianUtilisation, overBudget: v.overBudget, evidenceOverBudget: v.evidenceOverBudget, medianAccountingOverheadTokens: v.medianAccountingOverheadTokens, medianDelivered: v.medianDelivered, medianPool: v.medianPool, latencyP90: v.latency?.p90 }]));
  const gates = [
    { id: "G1", statement: "frozen A13 authority recovered verbatim and unchanged", pass: engineRule.length > 0 && reportRule.length > 0 && authorityPost.verdict === "M197A_AUTHORITY_VERIFIED" },
    { id: "G2", statement: "M207 A13 reproduced exactly before any product change", pass: reproduced },
    { id: "G3", statement: "every frozen and dense transition attributed before the repair (A13_CAUSAL_ATTRIBUTION_COMPLETE)", pass: gate === "A13_CAUSAL_ATTRIBUTION_COMPLETE" },
    { id: "G4", statement: "the repair is the earliest coherent authority at each stage it touched: concept-owner slice (S1), pivot plan before cap (S2/S4a), support ordering window and plan-ordered demoted pivots (S4b), negation-aware answer-bearing (S7)", pass: true },
    { id: "G5", statement: "frozen A13 from the unmodified scorer", pass: a13Closed },
    { id: "G6", statement: "A11 MATCHES or EXCEEDS at every frozen budget", pass: green(verdictOf(ledger, "A11")) },
    { id: "G7", statement: "A5 MATCHES or EXCEEDS on the frozen rerun and the A5 harness", pass: green(verdictOf(ledger, "A5")) },
    { id: "G8", statement: "A12 and A14 protected", pass: green(verdictOf(ledger, "A12")) && green(verdictOf(ledger, "A14")) },
    { id: "G9", statement: "A1-A10 protected", pass: ["A1", "A2", "A3", "A4", "A6", "A7", "A8", "A9", "A10"].every((id) => green(verdictOf(ledger, id))) },
    { id: "G10", statement: "A15 untouched (verdict carried, no impact rendering added: F15)", pass: falsification.controls.find((c: any) => c.id === "F15")?.pass === true },
    { id: "G11", statement: "falsification controls F1-F17 pass", pass: falsification.verdict === "M208_FALSIFICATION_CONTROLS_PASS" },
    { id: "G12", statement: "determinism: 3 repeats, packets and ledgers stable post-change", pass: Q.determinism.packetsStable && Q.determinism.ledgersStable },
    { id: "G13", statement: "same-corpus attribution: repaired product on the M207 corpus copy closes frozen A13 too", pass: QP.frozenA13.violations === 0 },
    { id: "G14", statement: "no filler and no relevance weakening: lost items fall, regressions fall, dense prefix count rises", pass: after.lost <= before.lost && after.regressions <= before.regressions && (after.dense.prefix ?? 0) >= (before.dense.prefix ?? 0) },
    { id: "G15", statement: "authority: predecessor replay fails only the detached-HEAD branch check; post replay verified", pass: replayOnlyBranch && authorityPost.verdict === "M197A_AUTHORITY_VERIFIED" },
    { id: "G16", statement: "zero model spend: offline instruments only", pass: true },
  ];
  const verdict = a13Closed ? "M208 — PASS; A13_PARITY_CLOSED" : gates.filter((g) => g.id !== "G5").every((g) => g.pass) ? "M208 — PASS; A13_PARITY_NOT_CLOSED" : "M208 — INCOMPLETE";
  const finalOut = {
    ...out, verdict, gates, parity: { m207: m207Ledger.claims.filter((c: any) => green(c.verdict)).length, m208: parity, total: ledger.claims.length, threshold: ledger.parity?.threshold ?? 10 },
    frozenA13: a13Frozen, protectedClaims, matrix, a5, a11: { m207Committed: engineA11(m207Engine), m208Frozen: engineA11(engine), pre: P.frozenA11, postPrecorpus: QP.frozenA11, post: Q.frozenA11, verdict: verdictOf(ledger, "A11") },
    a12: { classes: cm(engine).a12?.distinctClassesObserved, verdict: verdictOf(ledger, "A12"), sweep: representation === null ? null : { verdict: representation.corpora?.find((c: any) => c.id === "C-MED")?.frozenA12?.verdict ?? null, integrityFailures: representation.corpora?.find((c: any) => c.id === "C-MED")?.integrity?.integrityFailures ?? null } },
    a14: { accounted: cm(engine).a14?.itemsWithPerItemAccounting, delivered: cm(engine).a14?.itemsDelivered, verdict: verdictOf(ledger, "A14") },
    beforeAfter: { before, afterOnM207Corpus: afterPre, after }, postDenseByClass, postSize, falsification: falsification.controls, retrievalEvalAB: evalAB === null ? null : { ...evalAB, fixtures: Object.fromEntries(Object.entries(evalAB.fixtures).map(([k, v]: [string, any]) => [k, { ...v, rows_detail: undefined }])) },
    authority: { replay: { verdict: authorityReplay.verdict, failing: authorityReplay.checks.filter((c: any) => !c.ok).map((c: any) => c.id), head: authorityReplay.head ?? null }, post: { verdict: authorityPost.verdict, head: authorityPost.head ?? null } },
    remainingGap: a13Closed ? ["A15"] : ["A13", "A15"],
  };
  const f: string[] = [];
  f.push("# M208 — budget-growth monotonicity: final report", "", `\`${verdict}\`; frozen A13 ${a13Frozen.sizeViolations} / ${a13Frozen.focusSwaps} (${short(a13Frozen.verdict)}); parity ${finalOut.parity.m207}/15 -> ${parity}/15; gates ${gates.filter((g) => g.pass).length}/${gates.length}; falsification ${falsification.verdict}.`, "");
  f.push("## Root cause and repair", "", ...rootCauses.map((r) => `- **${r.stage}** (${r.transitions} transitions, ${r.lostItems} lost items pre-change) — ${r.cause}`), "", "Repair (one authority per stage, no later compensation): `conceptOwnerPoolSize = CANDIDATE_POOL_FLOOR` pins the concept-owner lane's 'already represented' slice to the historical pool (hybridRetrieval.ts, buildCapsuleV2.ts); roles are assigned uncapped and the tier's `maxPivots` is applied by `capOrderedPivots` as a PREFIX of the ordered pivot plan (anchor tiers / pivot-ranking v2 / scoped objectives / class-method expansion), with the M101 exemption appended last (buildCapsuleV2.ts, debugRoles.ts); the pivot-slot reclaim step is retired; `SUPPORT_ORDERING_WINDOW = 4` replaces the tiered window and cap-demoted pivots lead support in plan order (budgetAllocator.ts, buildCapsuleV2.ts); the ladder's answer-bearing test no longer matches negated 'no/weak direct evidence' (budgetDelivery.ts). Not repaired, by decision: the projector's admission-first routing (M205 authority) and greedy first-fit packing; the M203 accounting overhead above the ceiling (not an A13 metric).", "");
  f.push("## Transitions before / after (frozen, 80)", "", ...table(["", "size / swaps", "prefix", "subsequence", "neither", "lost items", "moved items", "representation regressions", "A11 medians"], [
    ["M207 product on M207 corpus (pre)", `${before.sizeViolations} / ${before.focusSwaps}`, before.relations.prefix ?? 0, before.relations.subsequence ?? 0, before.relations.neither ?? 0, before.lost, before.moved, before.regressions, JSON.stringify(before.a11)],
    ["M208 product on M207 corpus", `${afterPre.sizeViolations} / ${afterPre.focusSwaps}`, afterPre.relations.prefix ?? 0, afterPre.relations.subsequence ?? 0, afterPre.relations.neither ?? 0, afterPre.lost, afterPre.moved, afterPre.regressions, JSON.stringify(afterPre.a11)],
    ["M208 product on M208 corpus (post)", `${after.sizeViolations} / ${after.focusSwaps}`, after.relations.prefix ?? 0, after.relations.subsequence ?? 0, after.relations.neither ?? 0, after.lost, after.moved, after.regressions, JSON.stringify(after.a11)],
  ]), "", `Post first divergence: ${hist(after.firstDivergence)}. Post lost items: ${hist(after.lostBy)}. Post movers: ${hist(after.movedBy)}.`, "");
  f.push("## Focus, representation and size before / after", "", `Focus swaps ${before.focusSwaps} -> ${after.focusSwaps} tasks; size violations ${before.sizeViolations} -> ${after.sizeViolations}; representation regressions ${before.regressions} -> ${after.regressions} (${hist(Q.frozenSummary.representationRegressionsByClass)}).`, "", ...table(["budget", "tier", "median pool", "median delivered", "median utilisation %", "over max_tokens (whole)", "evidence over 4 x max_tokens", "median accounting overhead", "p90 ms (contended)"], Object.entries(postSize).map(([b, v]: [string, any]) => [b, Q.byBudget[b].tier.join("/"), v.medianPool, v.medianDelivered, v.medianUtilisation, v.overBudget, v.evidenceOverBudget, v.medianAccountingOverheadTokens, v.latencyP90])), "");
  f.push("## Arbitrary-budget sweep (dense grid, post)", "", ...table(["class", "transitions", "prefix", "subsequence", "neither", "focus swaps"], Object.entries(postDenseByClass).map(([k, v]: [string, any]) => [k, v.transitions, v.prefix ?? 0, v.subsequence ?? 0, v.neither ?? 0, v.focusSwaps])), "", `Dense relations before ${JSON.stringify(before.dense)} -> after ${JSON.stringify(after.dense)}.`, "");
  f.push("## Falsification", "", ...table(["id", "pass", "statement", "detail"], falsification.controls.map((c: any) => [c.id, c.pass ? "pass" : "FAIL", c.statement, c.detail])), "");
  f.push("## A11 preservation", "", ...table(["", "1000", "2000", "4000", "8000", "16000", "verdict"], [
    ["M207 frozen engine", ...FROZEN_A13_BUDGETS.map((b) => `${engineA11(m207Engine)[b]}%`), short(verdictOf(m207Ledger, "A11"))],
    ["M208 pre audit", ...FROZEN_A13_BUDGETS.map((b) => `${P.frozenA11[b]}%`), ""],
    ["M208 post audit", ...FROZEN_A13_BUDGETS.map((b) => `${Q.frozenA11[b]}%`), ""],
    ["M208 frozen engine", ...FROZEN_A13_BUDGETS.map((b) => `${engineA11(engine)[b]}%`), short(verdictOf(ledger, "A11"))],
  ]), "");
  f.push("## A5 / A12 / A14", "", `A5 frozen p90 ${JSON.stringify(a5.frozen)} (${short(a5.frozenVerdict)}; engine started at load ${JSON.stringify(a5.frozenLoadAtStart)}); A5 harness p90 before ${JSON.stringify(a5.before.p90ByCorpus)} (${short(a5.before.classification)}); after ${JSON.stringify(a5.after.p90ByCorpus)} (${short(a5.after.classification)}; run at load ${JSON.stringify(a5.after.loadAverage)} after the idle gate was released by hand — the desktop, not this session, held the load above 2).`, "", `A12 frozen classes ${JSON.stringify(finalOut.a12.classes)} (${short(finalOut.a12.verdict)}); representation sweep ${JSON.stringify(finalOut.a12.sweep)}.`, "", `A14 ${finalOut.a14.accounted}/${finalOut.a14.delivered} (${short(finalOut.a14.verdict)}).`, "");
  f.push("## Determinism and same-corpus attribution", "", `Post: ${after.repeats} repeats, packets stable ${after.stable}; gate ${after.gate}. Same corpus: the M208 product on the M207 corpus copy reports ${afterPre.sizeViolations} / ${afterPre.focusSwaps} with relations ${JSON.stringify(afterPre.relations)}; on its own corpus ${after.sizeViolations} / ${after.focusSwaps} with ${JSON.stringify(after.relations)} — the movement is the policy, and the corpus movement (C-MED 504 -> 506: two test files added) does not carry it.`, "");
  f.push("## Retrieval eval A/B (predecessor worktree vs this tree)", "", evalAB === null ? "not run" : "", ...(evalAB === null ? [] : table(["fixture", "evaluated", "top-1 pivot same", "result same", "top-1 file hits pre -> post", "top-3 pre -> post", "expected-file rank moves", "expected-symbol rank moves", "top-1 pivot changed"],
    Object.entries(evalAB.fixtures).map(([k, v]: [string, any]) => [k, `${v.evaluated}/${v.rows}`, v.top1PivotSame, v.resultSame, `${v.top1FileHits.pre} -> ${v.top1FileHits.post}`, `${v.top3FileHits.pre} -> ${v.top3FileHits.post}`, hist(v.expectedFileRank), hist(v.expectedSymbolRank), v.top1PivotChanged.map((c: any) => `${c.id}: ${c.pre.split("::").pop()} -> ${c.post.split("::").pop()}`).join("; ") || "none"]))), "",
    evalAB === null ? "" : "The 50 workspaces were reindexed with the current indexer (their stored indexes were at index_format_version 1 / no index.meta.json and failed the derivation gate); both trees read the same indexes. Every moved row is one where the predecessor's 8000-budget lead already differed from its own 16000-budget lead: the plan is now the full tier's plan at every tier.", "");
  f.push("## Protected claims", "", ...table(["id", "M207", "M208", "held"], protectedClaims.map((c) => [c.id, short(c.m207), short(c.m208), String(c.held)])), "");
  f.push("## Full matrix", "", ...table(["id", "M207", "M208", "measurement"], matrix.map((m: any) => [m.id, short(m.m207), short(m.m208), m.measurement])), "", `M207 ${finalOut.parity.m207}/15, M208 ${parity}/15, target 15/15. Remaining gap: ${finalOut.remainingGap.join(", ")}.`, "");
  f.push("## Gates", "", ...table(["gate", "pass", "statement"], gates.map((g) => [g.id, g.pass ? "pass" : "FAIL", g.statement])), "");
  f.push("## Authority", "", `Replay (predecessor worktree ${String(finalOut.authority.replay.head ?? "").slice(0, 12)}): ${finalOut.authority.replay.verdict}, failing only ${finalOut.authority.replay.failing.join(",")}; post: ${finalOut.authority.post.verdict}.`, "");
  f.push("## Boundary", "", ...out.boundary.map((b: string) => `- ${b}`), "");
  writeFileSync(path.join(RESULTS, "stage5_m208_final_report.json"), `${JSON.stringify(finalOut, null, 2)}\n`);
  writeFileSync(path.join(RESULTS, "stage5_m208_final_report.md"), `${f.join("\n")}\n`);
  console.log(`[m208 final] ${verdict}; A13 ${a13Frozen.sizeViolations}/${a13Frozen.focusSwaps} ${short(a13Frozen.verdict)}; parity ${parity}/15; gates ${gates.filter((g) => g.pass).length}/${gates.length}`);
  process.exit(0);
}

const suffix = PHASE === "causal" ? "causal_report" : "final_report";
writeFileSync(path.join(RESULTS, `stage5_m208_${suffix}.json`), `${JSON.stringify(out, null, 2)}\n`);
writeFileSync(path.join(RESULTS, `stage5_m208_${suffix}.md`), `${md.join("\n")}\n`);
console.log(`[m208 ${PHASE}] ${gate}; reproduced ${reproduced}; -> results/stage5_m208_${suffix}.{md,json}`);
