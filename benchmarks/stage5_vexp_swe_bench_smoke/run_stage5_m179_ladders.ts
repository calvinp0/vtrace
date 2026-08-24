/**
 * M179-B and M179-C — budget ladders over frozen authority, and what they prove.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m179_ladders.ts --corpus broad100a
 *
 * Every ladder below re-packs ONE frozen authoritative object at many budgets, so
 * the engine cannot move between rungs and a difference is a packing difference.
 * §7's distinction is therefore structural rather than argued: nothing upstream of
 * `compactProductResponse` runs here at all.
 *
 * Offline, pure, deterministic. No agent, no Docker, no paid API, no clock.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { responseTokenCeiling } from "../../src/mcp/responseEnvelope";
import { applyProgressiveContextBudget } from "../../src/productContext/budgetDelivery";
import { carriesItemBodies } from "./m179Capture";
import {
  authoritativeIdentity, comparePair, deliver, hashOf, RENDER_TRAILING_NOTE, sweepLadder, TERMINAL_RANK,
  type Delivered,
} from "./m179Packing";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const CORPUS_ROOT = path.join(RESULTS, "_m179_authoritative");
/** §11's control corpus: the same cases captured WITHOUT item bodies. */
const STRIPPED_ROOT = path.join(RESULTS, "_m179_corpus");

/** §30: below the floor, around the first deliverable rung, the compact range, and the default. */
const BUDGETS = [100, 200, 400, 600, 800, 1_000, 1_200, 1_600, 2_000, 3_200, 6_400, 8_000] as const;
const DEFAULT_BUDGET = 8_000;

/** §6's known positive, at the budgets it was reported at. */
const KNOWN_POSITIVE = "django__django-10880";
const KNOWN_POSITIVE_BUDGETS = [400, 600, 800, 1_000, 1_600] as const;
/** The same specimen, carried past the reported window so the recovery is visible. */
const KNOWN_POSITIVE_EXTENDED = [400, 600, 800, 1_000, 1_600, 2_000, 3_200, 6_400, 8_000] as const;

interface Case { readonly instanceId: string; readonly authoritative: unknown }

function loadCorpus(dir: string): Case[] {
  if (!existsSync(dir)) return [];
  const cases: Case[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
    const captured = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as {
      instanceId: string; snapshot: unknown; error: string | null;
    };
    // §11: the capture wraps the authoritative object under `.snapshot`. Packing
    // the wrapper is the M178 instrument error that produced a flat ladder, so
    // the unwrap is explicit and a missing `.snapshot` is skipped, never packed.
    if (captured.snapshot === null || captured.error !== null) continue;
    cases.push({ instanceId: captured.instanceId, authoritative: captured.snapshot });
  }
  return cases;
}

/**
 * §34/§35 — the detector's own controls, exercised on hand-built delivery records.
 *
 * A monotonicity detector that has never been shown a violation it must catch and
 * a non-violation it must ignore is an assertion, not an instrument.
 */
function detectorControls(): { rows: Array<Record<string, unknown>>; passed: number; failed: number } {
  const base: Delivered = {
    state: "orientation", rank: TERMINAL_RANK.orientation,
    focus: "a.py::F", focusCode: true, focusTruncated: false, focusCodeCharacters: 500, focusCodeContaminated: false,
    related: ["b.py::G|calls the focus symbol (indexed call edge)"], notes: ["note"],
    modelVisibleTokens: 100, metadataTokens: 100, totalTokens: 200, ceilingTokens: 1_400,
    withinEnvelope: true, envelopeDecline: false, boundedDegradation: false,
    deliveredItems: 2, serializedCharacters: 800,
  };
  const decline: Delivered = { ...base, state: "delivery_failure", rank: TERMINAL_RANK.decline, focus: null, focusCode: false, focusCodeCharacters: 0, focusCodeContaminated: false, related: [], notes: [], boundedDegradation: true };
  const controls: Array<{ name: string; lower: Delivered; higher: Delivered; expect: string[] }> = [
    { name: "identity", lower: base, higher: base, expect: [] },
    { name: "stable_packet_enough_then_stop", lower: base, higher: base, expect: [] },
    { name: "nested_preservation", lower: base, higher: { ...base, related: [...base.related, "c.py::H|selected as supporting evidence for this task"] }, expect: [] },
    { name: "decline_to_orientation", lower: decline, higher: base, expect: [] },
    { name: "stronger_representation", lower: { ...base, focusCode: false, focusCodeCharacters: 0 }, higher: base, expect: [] },
    { name: "same_semantics_new_serialization", lower: base, higher: { ...base, serializedCharacters: 999, totalTokens: 260 }, expect: [] },
    { name: "orientation_to_decline", lower: base, higher: decline, expect: ["ORIENTATION_TO_DECLINE"] },
    { name: "item_disappearance", lower: base, higher: { ...base, related: [] }, expect: ["ITEM_LOSS_WITH_NORMAL_RESPONSE"] },
    { name: "relationship_weakened", lower: base, higher: { ...base, related: ["b.py::G|selected as supporting evidence for this task"] }, expect: ["ITEM_LOSS_WITH_NORMAL_RESPONSE"] },
    { name: "focus_substituted", lower: base, higher: { ...base, focus: "z.py::Q" }, expect: ["FOCUS_SUBSTITUTED"] },
    { name: "representation_downgrade", lower: base, higher: { ...base, focusCode: false, focusCodeCharacters: 0 }, expect: ["REPRESENTATION_DOWNGRADE"] },
    { name: "richer_body_with_truncation_note", lower: base, higher: { ...base, focusTruncated: true, focusCodeCharacters: 1_799 }, expect: [] },
    { name: "shorter_body_however_labelled", lower: base, higher: { ...base, focusCodeCharacters: 100 }, expect: ["REPRESENTATION_DOWNGRADE"] },
    { name: "qualifier_evicted", lower: base, higher: { ...base, notes: [] }, expect: ["QUALIFIER_EVICTED"] },
    {
      name: "priority_inversion",
      lower: { ...base, related: ["x|r", "y|r"] },
      higher: { ...base, related: ["y|r", "x|r"] },
      expect: ["PRIORITY_INVERSION"],
    },
  ];
  const rows: Array<Record<string, unknown>> = [];
  let passed = 0;
  let failed = 0;
  for (const control of controls) {
    const violation = comparePair(100, control.lower, 200, control.higher);
    const got = violation === null ? [] : [...violation.classes];
    const ok = control.expect.every((klass) => got.includes(klass))
      && (control.expect.length > 0) === (got.length > 0);
    if (ok) passed += 1; else failed += 1;
    rows.push({ control: control.name, expected: control.expect, detected: got, pass: ok });
  }
  return { rows, passed, failed };
}

/** §35 — the same object at the same budget must pack to the same thing, twice. */
function identityControl(cases: readonly Case[]): { rows: Array<Record<string, unknown>>; stable: number; unstable: number } {
  const rows: Array<Record<string, unknown>> = [];
  let stable = 0;
  let unstable = 0;
  for (const item of cases.slice(0, 12)) {
    for (const budget of [800, DEFAULT_BUDGET]) {
      const first = hashOf(deliver(item.authoritative, budget));
      const second = hashOf(deliver(item.authoritative, budget));
      const ok = first === second;
      if (ok) stable += 1; else unstable += 1;
      rows.push({ instanceId: item.instanceId, budget, first, second, pass: ok });
    }
  }
  return { rows, stable, unstable };
}

/**
 * §38/§39 — was the larger budget's decline necessary?
 *
 * A decline is DOMINATED when a packet already proven deliverable at a smaller
 * budget satisfies both M178 contracts at the larger one. Both are checked
 * explicitly rather than inferred from the ceiling being monotone.
 */
function dominance(lower: Delivered & { budget: number }, higher: Delivered & { budget: number }): Record<string, unknown> {
  const meetsEvidenceBudget = lower.modelVisibleTokens <= higher.budget;
  const meetsDeliveryConstraint = lower.totalTokens <= responseTokenCeiling(higher.budget);
  return {
    lowerBudget: lower.budget,
    higherBudget: higher.budget,
    lowerPacketModelVisibleTokens: lower.modelVisibleTokens,
    lowerPacketTotalTokens: lower.totalTokens,
    higherBudgetCeiling: responseTokenCeiling(higher.budget),
    meetsEvidenceBudgetAtHigherBudget: meetsEvidenceBudget,
    meetsDeliveryConstraintAtHigherBudget: meetsDeliveryConstraint,
    dominated: meetsEvidenceBudget && meetsDeliveryConstraint,
  };
}

/** §31 — where exactly does the transition sit? */
function boundarySearch(authoritative: unknown, low: number, high: number): Record<string, unknown> {
  const rankAt = (budget: number): number => deliver(authoritative, budget).rank;
  const good = rankAt(low);
  let lastGood = low;
  let firstBad = high;
  let lo = low;
  let hi = high;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (rankAt(mid) >= good) { lo = mid; lastGood = mid; } else { hi = mid; firstBad = mid; }
  }
  return { searchedFrom: low, searchedTo: high, largestLowerBudgetGoodState: lastGood, firstBadState: firstBad };
}

/** The mirror of `boundarySearch`: the first budget at which the good state returns. */
function recoverySearch(authoritative: unknown, bad: number, good: number): Record<string, unknown> {
  const rankAt = (budget: number): number => deliver(authoritative, budget).rank;
  const target = rankAt(good);
  let lastBad = bad;
  let firstGood = good;
  let lo = bad;
  let hi = good;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (rankAt(mid) >= target) { hi = mid; firstGood = mid; } else { lo = mid; lastBad = mid; }
  }
  return { searchedFrom: bad, searchedTo: good, lastBadState: lastBad, firstRecoveredState: firstGood };
}

/**
 * §37 — the first divergence, stated as arithmetic rather than as a story.
 *
 * The packer publishes the first rung whose rendered evidence fits `max_tokens`.
 * Delivery, however, affords only `ceiling(B) - metadata`. When metadata exceeds
 * the flat allowance those two differ, and the rung the packer chose is one the
 * envelope cannot ship.
 */
function firstDivergence(authoritative: unknown, budget: number): Record<string, unknown> {
  const solo = structuredClone(authoritative) as Record<string, unknown>;
  delete solo.responseBudget;
  const packed = applyProgressiveContextBudget(solo, budget);
  const delivered = deliver(authoritative, budget);
  const ceiling = responseTokenCeiling(budget);
  const affordable = ceiling - delivered.metadataTokens;
  return {
    budget,
    packerResultState: packed?.resultState ?? null,
    packerChosenRungTokens: packed?.accounting.finalModelTokens ?? null,
    packerDeliveredItems: packed?.accounting.deliveredItems ?? null,
    packerStages: packed?.accounting.compactionStages ?? [],
    packerFitsItsOwnBudget: (packed?.accounting.finalModelTokens ?? 0) <= budget,
    envelopeCeiling: ceiling,
    envelopeMetadataTokens: delivered.metadataTokens,
    affordableEvidenceTokens: affordable,
    packerChoiceIsDeliverable: (packed?.accounting.finalModelTokens ?? 0) <= affordable,
    terminalState: delivered.state,
    boundedDegradationFired: delivered.boundedDegradation,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const corpus = argv[argv.indexOf("--corpus") + 1] ?? "broad100a";
  const cases = loadCorpus(path.join(CORPUS_ROOT, corpus));
  if (cases.length === 0) throw new Error(`no frozen authoritative objects in ${path.join(CORPUS_ROOT, corpus)}`);

  const controls = detectorControls();
  const identity = identityControl(cases);

  // §11 — the fixture control. A corpus whose items lost their bodies measures
  // headers, and its ladder is a statement about a response rather than about the
  // packer. Both corpora are checked so the trap is recorded, not merely avoided.
  const fixtureControl = {
    authoritative: (() => {
      const bodies = cases.map((item) => carriesItemBodies(item.authoritative));
      return {
        corpusDir: path.relative(ROOT, path.join(CORPUS_ROOT, corpus)),
        cases: bodies.length,
        casesCarryingItemBodies: bodies.filter((entry) => entry.withContent > 0).length,
        valid: bodies.every((entry) => entry.valid),
      };
    })(),
    strippedControl: (() => {
      const stripped = loadCorpus(path.join(STRIPPED_ROOT, corpus));
      const bodies = stripped.map((item) => carriesItemBodies(item.authoritative));
      return {
        corpusDir: path.relative(ROOT, path.join(STRIPPED_ROOT, corpus)),
        cases: bodies.length,
        casesCarryingItemBodies: bodies.filter((entry) => entry.withContent > 0).length,
        note:
          "Captured WITHOUT include_item_content, so every item body was already removed "
          + "as a duplicate of modelVisibleContext. Re-packing it renders body-free sections. "
          + "Kept as a standing control: a corpus that looks like this is measuring headers.",
      };
    })(),
  };

  // ---- the ladders -------------------------------------------------------
  const ladderRows: Array<Record<string, unknown>> = [];
  const violationClasses: Record<string, number> = {};
  let casesWithViolations = 0;
  for (const item of cases) {
    const swept = sweepLadder(item.authoritative, BUDGETS);
    if (swept.violations.length > 0) casesWithViolations += 1;
    for (const violation of swept.violations) {
      for (const klass of violation.classes) violationClasses[klass] = (violationClasses[klass] ?? 0) + 1;
    }
    ladderRows.push({
      instanceId: item.instanceId,
      identity: authoritativeIdentity(item.authoritative),
      ladder: swept.ladder.map((entry) => ({
        budget: entry.budget, state: entry.state, rank: entry.rank,
        modelVisibleTokens: entry.modelVisibleTokens, metadataTokens: entry.metadataTokens,
        totalTokens: entry.totalTokens, ceilingTokens: entry.ceilingTokens,
        boundedDegradation: entry.boundedDegradation,
        relatedCount: entry.related.length, focus: entry.focus,
      })),
      violations: swept.violations,
    });
  }

  // The pre-existing defect the focus normalization exists to neutralize, counted
  // so it is reported rather than merely subtracted (§103).
  let contaminatedFocusPackets = 0;
  let orientationPackets = 0;
  for (const item of cases) {
    for (const budget of BUDGETS) {
      const entry = deliver(item.authoritative, budget);
      if (entry.rank !== TERMINAL_RANK.orientation) continue;
      orientationPackets += 1;
      if (entry.focusCodeContaminated) contaminatedFocusPackets += 1;
    }
  }

  const orientationToDecline = ladderRows.flatMap((row) =>
    (row.violations as Array<{ lower: number; higher: number; classes: string[] }>)
      .filter((violation) => violation.classes.includes("ORIENTATION_TO_DECLINE"))
      .map((violation) => ({ instanceId: row.instanceId, ...violation })));

  // ---- dominance over every orientation->decline pair ---------------------
  const dominanceRows: Array<Record<string, unknown>> = [];
  for (const violation of orientationToDecline) {
    const item = cases.find((entry) => entry.instanceId === violation.instanceId)!;
    const lower = { budget: violation.lower, ...deliver(item.authoritative, violation.lower) };
    const higher = { budget: violation.higher, ...deliver(item.authoritative, violation.higher) };
    dominanceRows.push({ instanceId: violation.instanceId, ...dominance(lower, higher) });
  }

  // ---- the known positive -------------------------------------------------
  const knownPositive = cases.find((entry) => entry.instanceId === KNOWN_POSITIVE);
  const knownPositiveReport = knownPositive === undefined ? null : {
    instanceId: KNOWN_POSITIVE,
    identity: authoritativeIdentity(knownPositive.authoritative),
    ladder: KNOWN_POSITIVE_BUDGETS.map((budget) => {
      const entry = deliver(knownPositive.authoritative, budget);
      return {
        budget, state: entry.state,
        modelVisibleTokens: entry.modelVisibleTokens, metadataTokens: entry.metadataTokens,
        totalTokens: entry.totalTokens, ceilingTokens: entry.ceilingTokens,
        boundedDegradation: entry.boundedDegradation, relatedCount: entry.related.length,
      };
    }),
    firstDivergence: KNOWN_POSITIVE_BUDGETS.map((budget) => firstDivergence(knownPositive.authoritative, budget)),
    extendedLadder: KNOWN_POSITIVE_EXTENDED.map((budget) => {
      const entry = deliver(knownPositive.authoritative, budget);
      const divergence = firstDivergence(knownPositive.authoritative, budget);
      return {
        budget, state: entry.state,
        packerChosenRungTokens: divergence.packerChosenRungTokens,
        affordableEvidenceTokens: divergence.affordableEvidenceTokens,
        packerChoiceIsDeliverable: divergence.packerChoiceIsDeliverable,
        modelVisibleTokens: entry.modelVisibleTokens, metadataTokens: entry.metadataTokens,
        totalTokens: entry.totalTokens, ceilingTokens: entry.ceilingTokens,
        relatedCount: entry.related.length, focusCodeCharacters: entry.focusCodeCharacters,
      };
    }),
    itemBodies: carriesItemBodies(knownPositive.authoritative),
    // §31 — the exact budget at which more budget starts costing evidence, and
    // the exact budget at which enough of it arrives to pay for the loss.
    boundary: boundarySearch(knownPositive.authoritative, 800, 1_000),
    recovery: recoverySearch(knownPositive.authoritative, 2_000, 3_200),
    counterfactual: (() => {
      // §38/§66: the packet proven deliverable at the largest good budget, replayed
      // against every budget that declined.
      const lastGood = { budget: 800, ...deliver(knownPositive.authoritative, 800) };
      return [1_000, 1_600, 2_000].map((budget) => dominance(lastGood, { budget, ...deliver(knownPositive.authoritative, budget) }));
    })(),
  };

  const report = {
    schemaVersion: "stage5.m179.budget-ladders.v1",
    milestone: "M179",
    workstream: "B+C",
    corpus,
    budgets: BUDGETS,
    defaultBudget: DEFAULT_BUDGET,
    method:
      "One frozen authoritative object per case, captured once at max_tokens 120,000 and "
      + "detail=debug, re-packed at each budget by compactProductResponse. Nothing upstream "
      + "of the envelope runs, so no rung can differ by engine state (M178's trap).",
    controls: {
      detector: { rows: controls.rows, passed: controls.passed, failed: controls.failed },
      identity: { rows: identity.rows, stable: identity.stable, unstable: identity.unstable },
      fixture: fixtureControl,
      focusBodyContamination: {
        orientationPackets,
        contaminatedFocusPackets,
        renderTrailingNote: RENDER_TRAILING_NOTE,
        defect:
          "parseRenderedBodies assigns everything after an item's metadata lines to that "
          + "item's body, and the renderer appends one closing sentence after the LAST "
          + "section. The final item's `code` therefore ends with a sentence that is not "
          + "source. Which item is last depends on how many survived the budget, so the "
          + "contamination moves with the budget and reads as a representation change. "
          + "Normalized out of every measurement here and reported as an outstanding defect; "
          + "repairing it is a rendering change, not a packing one.",
      },
    },
    summary: {
      cases: cases.length,
      casesWithViolations,
      orientationToDeclinePairs: orientationToDecline.length,
      violationClasses,
      dominatedDeclines: dominanceRows.filter((row) => row.dominated === true).length,
      undominatedDeclines: dominanceRows.filter((row) => row.dominated !== true).length,
    },
    knownPositive: knownPositiveReport,
    dominance: dominanceRows,
    rows: ladderRows,
  };

  const outPath = path.join(RESULTS, `stage5_m179_budget_ladders.${corpus}.json`);
  writeFileSync(outPath, `${JSON.stringify(report, null, 1)}\n`);

  console.log(`corpus=${corpus} cases=${cases.length}`);
  console.log(`detector controls: ${controls.passed} passed, ${controls.failed} failed`);
  console.log(`identity control:  ${identity.stable} stable, ${identity.unstable} unstable`);
  console.log(`focus contamination: ${contaminatedFocusPackets}/${orientationPackets} orientation packets`);
  console.log(`fixture control:   ${fixtureControl.authoritative.casesCarryingItemBodies}/${fixtureControl.authoritative.cases} carry item bodies (control corpus: ${fixtureControl.strippedControl.casesCarryingItemBodies}/${fixtureControl.strippedControl.cases})`);
  console.log(`cases with violations: ${casesWithViolations}/${cases.length}`);
  console.log(`violation classes: ${JSON.stringify(violationClasses)}`);
  console.log(`orientation->decline pairs: ${orientationToDecline.length}, dominated: ${report.summary.dominatedDeclines}`);
  if (knownPositiveReport !== null) {
    console.log(`\n${KNOWN_POSITIVE}:`);
    for (const entry of knownPositiveReport.ladder) {
      console.log(`  B=${String(entry.budget).padStart(5)} ${entry.state.padEnd(17)} mv=${String(entry.modelVisibleTokens).padStart(5)} meta=${String(entry.metadataTokens).padStart(5)} total=${String(entry.totalTokens).padStart(5)} ceiling=${String(entry.ceilingTokens).padStart(5)}${entry.boundedDegradation ? "  DEGRADED" : ""}`);
    }
    for (const entry of knownPositiveReport.firstDivergence) {
      console.log(`  B=${String(entry.budget).padStart(5)} packer rung=${String(entry.packerChosenRungTokens).padStart(5)} fitsBudget=${entry.packerFitsItsOwnBudget} affordable=${String(entry.affordableEvidenceTokens).padStart(5)} deliverable=${entry.packerChoiceIsDeliverable}`);
    }
    console.log("  extended:");
    for (const entry of knownPositiveReport.extendedLadder) {
      console.log(`    B=${String(entry.budget).padStart(5)} ${entry.state.padEnd(17)} rung=${String(entry.packerChosenRungTokens).padStart(5)} affordable=${String(entry.affordableEvidenceTokens).padStart(5)} deliverable=${entry.packerChoiceIsDeliverable}`);
    }
    console.log(`  boundary: ${JSON.stringify(knownPositiveReport.boundary)}`);
    console.log(`  recovery: ${JSON.stringify(knownPositiveReport.recovery)}`);
    console.log(`  counterfactual (last-good packet replayed at declining budgets): ${JSON.stringify(knownPositiveReport.counterfactual.map((row) => row.dominated))}`);
  }
  console.log(`\n-> ${path.relative(ROOT, outPath)}`);
}

await main();
