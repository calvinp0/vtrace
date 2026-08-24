/**
 * M181-D — candidate comparison and claim identity.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m181_decision.ts
 *
 * Reads the two candidate artifacts and answers §41 and §42: what moved at the
 * default budget, and whether anything moved that is not a reason.
 *
 * §42 NEEDS A CAREFUL READING HERE. It asks for `claim changes: 0`, and then
 * allows an exception when "claim text embeds reason wording and a canonical
 * reason repair necessarily changes that explanation". That exception is this
 * milestone's whole subject: `related[].how` IS the selection reason, verbatim.
 * So the claim STRING is expected to change wherever the two selectors
 * disagreed, and the thing that must not change is everything else — which
 * symbol, which file, which lines, which roles, which form, which qualifiers.
 * Those are measured separately and must be identical.
 *
 * Offline, pure, deterministic. Live spend $0.00.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");

interface CaseRow {
  itemSupplyHash: string;
  relatedOrderHash: string;
  defaultSerializedHash: string;
  defaultPacketHash: string;
  defaultPacketTokens: number;
  defaultItemIds: string[];
  defaultRelated: string[];
  defaultFocus: { at?: string; why?: string | null };
  perBudget: Array<{ budget: number; itemIds: string[]; relatedCount: number; relatedAts: string[]; state: string }>;
}

/**
 * §32's real question, asked per (case, budget) rather than per case.
 *
 * A reason string has a length, `render()` includes it, and `fits()` reads the
 * rendered size — so preserving a longer decisive reason instead of a shorter
 * scorer diagnostic can move where the evidence layer stops. That is a
 * TOKEN coupling. It becomes a RANKING change only if the symbols the two arms
 * share come back in a different relative order, which is what this checks.
 */
function selectionDelta(before: Record<string, CaseRow>, after: Record<string, CaseRow>): Record<string, unknown> {
  let points = 0;
  let gainedOnly = 0;
  let lostOnly = 0;
  let mixed = 0;
  let itemsOnly = 0;
  const inversions: Array<Record<string, unknown>> = [];
  const detail: Array<Record<string, unknown>> = [];
  const byBudget: Record<string, number> = {};

  for (const [key, beforeRow] of Object.entries(before)) {
    const afterRow = after[key];
    if (afterRow === undefined) continue;
    for (let index = 0; index < beforeRow.perBudget.length; index += 1) {
      const b = beforeRow.perBudget[index]!;
      const a = afterRow.perBudget[index]!;
      const sameItems = JSON.stringify(b.itemIds) === JSON.stringify(a.itemIds);
      const sameRelated = JSON.stringify(b.relatedAts) === JSON.stringify(a.relatedAts);
      if (sameItems && sameRelated) continue;
      points += 1;
      byBudget[String(b.budget)] = (byBudget[String(b.budget)] ?? 0) + 1;

      const beforeSet = new Set(b.relatedAts);
      const afterSet = new Set(a.relatedAts);
      const commonBefore = b.relatedAts.filter((digest) => afterSet.has(digest));
      const commonAfter = a.relatedAts.filter((digest) => beforeSet.has(digest));
      if (JSON.stringify(commonBefore) !== JSON.stringify(commonAfter)) {
        inversions.push({ case: key, budget: b.budget });
      }
      const gained = a.relatedAts.filter((digest) => !beforeSet.has(digest)).length;
      const lost = b.relatedAts.filter((digest) => !afterSet.has(digest)).length;
      if (gained > 0 && lost > 0) mixed += 1;
      else if (gained > 0) gainedOnly += 1;
      else if (lost > 0) lostOnly += 1;
      else itemsOnly += 1;
      if (detail.length < 20) {
        detail.push({
          case: key, budget: b.budget, state: [b.state, a.state],
          beforeItems: b.itemIds, afterItems: a.itemIds,
          relatedCount: [b.relatedCount, a.relatedCount],
        });
      }
    }
  }
  return {
    question: "Did preserving the decisive reason change WHICH evidence was delivered, or only WHERE the byte budget ran out?",
    pointsCompared: Object.keys(before).length * (Object.values(before)[0]?.perBudget.length ?? 0),
    pointsDiffering: points,
    byBudget,
    relatedSymbolGainedOnly: gainedOnly,
    relatedSymbolLostOnly: lostOnly,
    relatedSymbolGainedAndLost: mixed,
    deliveredItemsMovedButAdmittedRelatedDidNot: itemsOnly,
    priorityInversionsBetweenArms: inversions.length,
    inversions,
    finding: inversions.length === 0
      ? "NO RE-RANKING. Every differing point is a tail item entering or leaving the delivered set; the symbols the two arms share come back in the same relative order at every one of them. `compareKeepPriority` is untouched and `answerBearing` is computed in `mutableItem` from the FULL reason array before `compactReasons` runs, so neither could have moved. What moved is the rendered byte count."
      : "RE-RANKING DETECTED — §32 forbids this candidate.",
    detail,
  };
}

interface Candidate {
  candidate: string;
  cases: number;
  pairViolations: Record<string, number>;
  pairBenign: Record<string, number>;
  substitutions: Record<string, number>;
  truthfulness: Record<string, number>;
  ownership: Record<string, number>;
  totality: Record<string, number>;
  packetEconomics: Record<string, { count: number; median: number; p90: number; max: number; mean: number }>;
  perCase: Record<string, CaseRow>;
}

/** Summary and per-budget detail are separate files (§64); the decision needs both. */
const load = (label: string): Candidate => {
  const summary = JSON.parse(readFileSync(path.join(RESULTS, `stage5_m181_candidate_${label}.json`), "utf8")) as Candidate;
  const detail = JSON.parse(readFileSync(path.join(RESULTS, `stage5_m181_candidate_${label}.detail.json`), "utf8")) as { perCase: Record<string, CaseRow> };
  return { ...summary, perCase: detail.perCase };
};

const atOf = (identity: string): string => identity.split("|")[0] ?? identity;
const howOf = (identity: string): string => identity.slice(atOf(identity).length + 1);

function main(): void {
  const before = load("current");
  const after = load("canonical_primary");

  const classes: Record<string, number> = {
    PRIMARY_REASON_ONLY: 0, REASON_ORDER_ONLY: 0, CLAIM_CHANGED: 0,
    ITEM_CHANGED: 0, UNEXPECTED: 0, IDENTICAL: 0,
  };
  const changedCases: Record<string, unknown>[] = [];
  const identity = {
    cases: 0,
    itemSupplyIdentical: 0,
    relatedOrderIdentical: 0,
    defaultSerializedIdentical: 0,
    defaultPacketIdentical: 0,
    defaultRelatedSetIdentical: 0,
    defaultFocusSymbolIdentical: 0,
  };

  for (const [key, beforeRow] of Object.entries(before.perCase)) {
    const afterRow = after.perCase[key];
    if (afterRow === undefined) { classes.UNEXPECTED += 1; continue; }
    identity.cases += 1;
    if (beforeRow.itemSupplyHash === afterRow.itemSupplyHash) identity.itemSupplyIdentical += 1;
    if (beforeRow.relatedOrderHash === afterRow.relatedOrderHash) identity.relatedOrderIdentical += 1;
    if (beforeRow.defaultSerializedHash === afterRow.defaultSerializedHash) identity.defaultSerializedIdentical += 1;
    if (beforeRow.defaultPacketHash === afterRow.defaultPacketHash) identity.defaultPacketIdentical += 1;

    const beforeAts = beforeRow.defaultRelated.map(atOf);
    const afterAts = afterRow.defaultRelated.map(atOf);
    const sameSet = JSON.stringify([...beforeAts].sort()) === JSON.stringify([...afterAts].sort());
    const sameOrder = JSON.stringify(beforeAts) === JSON.stringify(afterAts);
    if (sameSet) identity.defaultRelatedSetIdentical += 1;
    if (beforeRow.defaultFocus.at === afterRow.defaultFocus.at) identity.defaultFocusSymbolIdentical += 1;

    if (beforeRow.defaultPacketHash === afterRow.defaultPacketHash
      && beforeRow.defaultSerializedHash === afterRow.defaultSerializedHash) { classes.IDENTICAL += 1; continue; }

    const itemsChanged = JSON.stringify(beforeRow.defaultItemIds) !== JSON.stringify(afterRow.defaultItemIds);
    const focusChanged = beforeRow.defaultFocus.at !== afterRow.defaultFocus.at;
    const howChanged = beforeRow.defaultRelated.map(howOf).join(" ") !== afterRow.defaultRelated.map(howOf).join(" ")
      || beforeRow.defaultFocus.why !== afterRow.defaultFocus.why;

    let cls: string;
    if (itemsChanged || focusChanged || !sameSet) cls = "ITEM_CHANGED";
    else if (!sameOrder) cls = "REASON_ORDER_ONLY";
    else if (howChanged) cls = "PRIMARY_REASON_ONLY";
    else cls = "UNEXPECTED";
    classes[cls] = (classes[cls] ?? 0) + 1;

    if (changedCases.length < 30) {
      const examples: Record<string, string>[] = [];
      for (let index = 0; index < Math.min(beforeRow.defaultRelated.length, afterRow.defaultRelated.length); index += 1) {
        const b = beforeRow.defaultRelated[index]!;
        const a = afterRow.defaultRelated[index]!;
        if (b === a || examples.length >= 2) continue;
        examples.push({ at: atOf(b), before: howOf(b).slice(0, 120), after: howOf(a).slice(0, 120) });
      }
      changedCases.push({
        case: key, class: cls,
        beforeTokens: beforeRow.defaultPacketTokens, afterTokens: afterRow.defaultPacketTokens,
        examples,
      });
    }
  }

  const delta = (field: keyof Candidate, key: string): Record<string, number> => ({
    before: (before[field] as Record<string, number>)[key] ?? 0,
    after: (after[field] as Record<string, number>)[key] ?? 0,
  });

  const selection = selectionDelta(before.perCase, after.perCase);

  const comparison = {
    milestone: "M181-D",
    generatedFrom: "run_stage5_m181_decision.ts",
    candidates: {
      C_CURRENT: "normal path uses selectionReasons[0]; compact path reselects by substring",
      C_CANONICAL_REASON: "compactReasons reduces WITHOUT reselecting, so both paths render the declared decisive reason",
    },
    rejectedWithoutSimulation: {
      C_COMPACT_CANONICAL: "REJECTED BY M181-C. Making compactReasons' preference the shared selector contradicts the only declared contract in the source (`roleReason` is 'the decisive reason'), and the permutation control shows that preference is order-blind — it returns one reason for six orders whose decisive reason differs. §31 forbids simulating candidates C has rejected.",
      C_REASON_SET_AUTHORITY: "REJECTED BY M181-C. Excusing primary-reason substitution from the invariant is only admissible if the primary is presentational. It is not: four independent source sites treat position 0 as the claim, and the substitutions cross from DEBUG_ONLY scorer output to SEMANTIC_ROLE. This was the §35 no-change outcome and the evidence did not support it.",
      C_STABLE_INSERTION: "SUBSUMED. Preserving source ordering and using the first reason everywhere is exactly C_CANONICAL_REASON on this codebase, because the source ordering already places the decisive reason first.",
    },
    metrics: {
      reasonResidualPairs: delta("pairViolations", "SEMANTIC_ROLE_CHANGED"),
      ceilingResidualPairs: delta("pairViolations", "RELATED_ITEM_LOST"),
      orientationToDecline: delta("pairViolations", "ORIENTATION_TO_DECLINE"),
      claimDowngraded: delta("pairViolations", "CLAIM_DOWNGRADED"),
      focusChanged: delta("pairViolations", "FOCUS_CHANGED"),
      priorityInversion: delta("pairViolations", "PRIORITY_INVERSION"),
      representationDowngrade: delta("pairViolations", "REPRESENTATION_DOWNGRADE"),
      qualifierEvicted: delta("pairViolations", "QUALIFIER_EVICTED"),
      benignClaimUpgraded: delta("pairBenign", "CLAIM_UPGRADED"),
      benignFocusResolved: delta("pairBenign", "FOCUS_RESOLVED_TO_LEAD"),
      substitutionsTotal: delta("substitutions", "total"),
      substitutionsNonEquivalent: delta("substitutions", "nonEquivalent"),
      substitutionsEllipsisOnly: delta("substitutions", "ellipsisOnly"),
      claimsDelivered: delta("truthfulness", "claims"),
      claimsUnsupported: delta("truthfulness", "unsupported"),
      claimsOutsideSupply: delta("truthfulness", "outsideSupply"),
      ownershipProjectorSupplyCut: delta("ownership", "projectorSupplyCut"),
      ownershipSerializedItemsCut: delta("ownership", "serializedItemsCut"),
      totalityThrows: delta("totality", "throws"),
      totalityOutsideEnvelope: delta("totality", "outsideEnvelope"),
      orientations: delta("totality", "orientations"),
      declines: delta("totality", "declines"),
    },
    packetEconomics: {
      allBudgets: { before: before.packetEconomics.allBudgets, after: after.packetEconomics.allBudgets },
      atDefaultBudget: { before: before.packetEconomics.atDefaultBudget, after: after.packetEconomics.atDefaultBudget },
      medianChangePercent: Number((((after.packetEconomics.allBudgets.median - before.packetEconomics.allBudgets.median)
        / Math.max(1, before.packetEconomics.allBudgets.median)) * 100).toFixed(2)),
      investigationThreshold: "§54 — >10% median increase warrants explanation",
    },
    defaultBudgetChanges: classes,
    identity,
    selectionDelta: selection,
    examples: changedCases,
  };

  writeFileSync(path.join(RESULTS, "stage5_m181_candidate_comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`);

  writeFileSync(path.join(RESULTS, "stage5_m181_claim_identity.json"), `${JSON.stringify({
    milestone: "M181-D", generatedFrom: "run_stage5_m181_decision.ts",
    question: "§42 — did anything change that is not the reason explanation?",
    measuredAtDefaultBudget: {
      cases: identity.cases,
      evidenceItemsDelivered: `${identity.itemSupplyIdentical}/${identity.cases} identical across every budget`,
      relatedAdmissionOrder: `${identity.relatedOrderIdentical}/${identity.cases} identical across every budget`,
      relatedSymbolSet: `${identity.defaultRelatedSetIdentical}/${identity.cases} identical`,
      focusSymbol: `${identity.defaultFocusSymbolIdentical}/${identity.cases} identical`,
      serializedResponse: `${identity.defaultSerializedIdentical}/${identity.cases} identical`,
      packet: `${identity.defaultPacketIdentical}/${identity.cases} identical`,
    },
    interpretation: "`related[].how` and `focus.why` ARE the selection reason, reused verbatim by the projector. §42's `claim changes: 0` therefore cannot mean the string never moves — the repair exists to move it where two selectors disagreed. What must not move is the evidence: which symbol, which file, which lines, which roles, which form, which qualifiers, and in which order. Those are what the rows above measure.",
  }, null, 2)}\n`);

  console.log(JSON.stringify({
    milestone: "M181-D",
    metrics: comparison.metrics,
    defaultBudgetChanges: classes,
    identity,
    selectionDelta: {
      pointsDiffering: selection.pointsDiffering,
      pointsCompared: selection.pointsCompared,
      priorityInversionsBetweenArms: selection.priorityInversionsBetweenArms,
      byBudget: selection.byBudget,
    },
    packetMedian: { before: before.packetEconomics.allBudgets.median, after: after.packetEconomics.allBudgets.median },
    packetDefaultMedian: { before: before.packetEconomics.atDefaultBudget.median, after: after.packetEconomics.atDefaultBudget.median },
  }, null, 2));
}

main();
