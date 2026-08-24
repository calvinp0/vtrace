/**
 * M181-B — reproduce M180's 106 reason residuals, and control the instrument.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m181_reproduction.ts
 *
 * ONE FROZEN AUTHORITATIVE OBJECT, MANY BUDGETS — M179's and M180's method,
 * unchanged. The addition is the WITNESS. Every reason field on a delivered
 * response has already passed through `compactReasons`, so a delivered response
 * cannot testify about what the authoritative reason was. `deliver()` clones
 * before it compacts, so the frozen object's own `selectionReasons` is untouched
 * by every budget path and is the external witness this milestone needs.
 *
 * Four controls, because a detector that only fires is not a detector:
 *
 *   IDENTITY      same object, same budget, twice — must agree.
 *   KNOWN-NEGATIVE  items with several reasons where both paths pick the same
 *                   one — must NOT fire merely because a set has more than one
 *                   member.
 *   SYNTHETIC     reason arrays of size 1, 2, 3 and with duplicates, on an object
 *                 with no retrieval or ranking to blame.
 *   PERMUTATION   the SAME reason set in different orders. If the displayed
 *                 reason tracks construction order, position 0 is order and not
 *                 authority, and §25 says that changes the answer.
 *
 * Offline, pure, deterministic. Live spend $0.00.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { deliver, TERMINAL_RANK, type Delivered } from "./m179Packing";
import { carriesItemBodies } from "./m179Capture";
import { comparePreservation, rolesFallbackMap, type PreservationInput } from "./m180Ownership";
import {
  budgetPairs, classifyReasonResidual, hashOf, reasonSupport, reasonWitnesses,
} from "./m181Reasons";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const CORPUS_ROOT = path.join(RESULTS, "_m179_authoritative");

/** M179's ladder, unchanged, so counts stay comparable across three milestones. */
const BUDGETS = [100, 200, 400, 600, 800, 1_000, 1_200, 1_600, 2_000, 3_200, 6_400, 8_000] as const;

const atOf = (identity: string): string => identity.split("|")[0] ?? identity;
const howOf = (identity: string): string => identity.slice(atOf(identity).length + 1);

/** `Delivered` in the shape M180's comparator expects. Field-for-field, no reshaping. */
const inputOf = (row: Delivered): PreservationInput => ({
  rank: row.rank,
  focus: row.focus,
  related: row.related,
  notes: row.notes,
  focusCode: row.focusCode,
  focusCodeCharacters: row.focusCodeCharacters,
});

function leadPivotOf(authoritative: unknown): string {
  const output = authoritative as Record<string, unknown> | null;
  const productContext = output !== null && typeof output === "object"
    ? (output.productContext as Record<string, unknown> | undefined)
    : undefined;
  return String(productContext?.leadPivot ?? "");
}

interface Case {
  readonly corpus: string;
  readonly instanceId: string;
  readonly authoritative: unknown;
}

function loadCorpus(corpus: string): Case[] {
  const dir = path.join(CORPUS_ROOT, corpus);
  const cases: Case[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    const capture = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { instanceId: string; snapshot: unknown };
    if (capture.snapshot === null) continue;
    // M179 §11's standing fixture control, inherited unchanged.
    if (!carriesItemBodies(capture.snapshot).valid) continue;
    cases.push({ corpus, instanceId: capture.instanceId, authoritative: capture.snapshot });
  }
  return cases;
}

interface Residual {
  readonly corpus: string;
  readonly instanceId: string;
  readonly lower: number;
  readonly higher: number;
  readonly at: string;
  readonly surface: "related" | "focus";
  readonly lowerReason: string;
  readonly higherReason: string;
  readonly lowerFamily: string;
  readonly higherFamily: string;
  readonly classes: readonly string[];
  readonly equivalent: boolean;
  readonly lowerSupport: string;
  readonly higherSupport: string;
  /** Which side agrees with the declared decisive reason, `ordered[0]`. */
  readonly agreesWithPositionZero: "lower" | "higher" | "both" | "neither";
}

function main(): void {
  const residuals: Residual[] = [];
  const truthfulness = { claims: 0, verbatim: 0, ellipsized: 0, rolesFallback: 0, unsupported: 0, outsideSupply: 0 };
  const perCorpus: Record<string, Record<string, number>> = {};
  const identityFailures: Record<string, unknown>[] = [];
  const knownNegative = {
    itemsWithMultipleReasonsWhereBothPathsAgree: 0,
    falsePositives: 0,
    detail: [] as Record<string, unknown>[],
  };
  const pairViolations: Record<string, number> = {};
  const pairBenign: Record<string, number> = {};
  let deliveringBudgets = 0;
  let reasonSetMutations = 0;

  for (const corpus of ["broad100a", "broad100b"]) {
    const cases = loadCorpus(corpus);
    const stats = { cases: cases.length, budgets: 0, violatingPairs: 0, reasonPairs: 0, casesWithViolation: 0 };

    for (const entry of cases) {
      const witnesses = reasonWitnesses(entry.authoritative);
      const delivered = new Map<number, Delivered>();
      for (const budget of BUDGETS) delivered.set(budget, deliver(entry.authoritative, budget));

      // §23 — identity: the same object at the same budget, delivered twice.
      for (const budget of [BUDGETS[0], BUDGETS[7], BUDGETS[BUDGETS.length - 1]]) {
        const again = deliver(entry.authoritative, budget!);
        const first = delivered.get(budget!)!;
        if (hashOf([first.focus, first.related, first.notes]) !== hashOf([again.focus, again.related, again.notes])) {
          identityFailures.push({ corpus, instanceId: entry.instanceId, budget });
        }
      }

      // §43 — every model-facing claim, checked against the witness.
      for (const [budget, row] of delivered) {
        if (row.state !== "orientation") continue;
        deliveringBudgets += 1;
        stats.budgets += 1;
        for (const identity of row.related) {
          const witness = witnesses.get(atOf(identity));
          truthfulness.claims += 1;
          if (witness === undefined) { truthfulness.outsideSupply += 1; continue; }
          const support = reasonSupport(howOf(identity), witness);
          if (support === "verbatim") truthfulness.verbatim += 1;
          else if (support === "ellipsized") truthfulness.ellipsized += 1;
          else if (support === "roles_fallback") truthfulness.rolesFallback += 1;
          else truthfulness.unsupported += 1;
        }
        void budget;
      }

      // §19-20 — the residuals, under M180'S OWN preservation semantics, imported
      // rather than reimplemented. A number produced by a lookalike scorer is not
      // a reproduction of M180's number, and this milestone's whole claim is that
      // it is looking at the same 106 pairs.
      const fallback = rolesFallbackMap(entry.authoritative);
      const leadPivot = leadPivotOf(entry.authoritative);
      const caseResidualsBefore = residuals.length;
      let caseViolatingPairs = 0;

      for (const [lower, higher] of budgetPairs([...BUDGETS])) {
        const low = delivered.get(lower)!;
        const high = delivered.get(higher)!;
        const verdict = comparePreservation(inputOf(low), inputOf(high), leadPivot, fallback);
        for (const cls of verdict.violations) pairViolations[cls] = (pairViolations[cls] ?? 0) + 1;
        for (const cls of verdict.benign) pairBenign[cls] = (pairBenign[cls] ?? 0) + 1;
        if (verdict.violations.length > 0) { caseViolatingPairs += 1; stats.violatingPairs += 1; }
        if (!verdict.violations.includes("SEMANTIC_ROLE_CHANGED")) continue;
        stats.reasonPairs += 1;

        // The pair is a reason residual. Name the symbols responsible, and check
        // each displayed reason against the frozen witness.
        const highByAt = new Map(high.related.map((identity) => [atOf(identity), howOf(identity)]));
        for (const identity of low.related) {
          const at = atOf(identity);
          const highHow = highByAt.get(at);
          if (highHow === undefined) continue; // an item LOSS, which §7 tracks separately.
          const lowHow = howOf(identity);
          if (lowHow === highHow) continue;
          const witness = witnesses.get(at);
          // M180 excuses a fallback becoming a real claim; those pairs are not
          // reason residuals and must not be counted as one.
          if (witness !== undefined && (lowHow === witness.rolesFallback || highHow === witness.rolesFallback)) continue;
          const classified = classifyReasonResidual(at, lowHow, highHow, witness);
          if (!classified.authoritativeSetStable) reasonSetMutations += 1;
          const primary = witness?.primary ?? "";
          residuals.push({
            corpus, instanceId: entry.instanceId, lower, higher, at, surface: "related",
            lowerReason: lowHow, higherReason: highHow,
            lowerFamily: classified.lowerFamily, higherFamily: classified.higherFamily,
            classes: classified.classes, equivalent: classified.equivalent,
            lowerSupport: classified.lowerSupport, higherSupport: classified.higherSupport,
            agreesWithPositionZero: lowHow === primary && highHow === primary ? "both"
              : lowHow === primary ? "lower" : highHow === primary ? "higher" : "neither",
          });
        }
      }
      if (caseViolatingPairs > 0) stats.casesWithViolation += 1;

      // §22 — known negative: an item whose reason set has more than one member
      // but on which the two paths agree must never appear as a residual.
      // Only NON-equivalent firings count against the control. A reason cut by
      // the 160-character ellipsis is the same claim shortened, which is a
      // separate and already-identified mechanism, not a reselection.
      const firedAt = new Set(residuals.slice(caseResidualsBefore).filter((residual) => !residual.equivalent).map((residual) => residual.at));
      for (const witness of witnesses.values()) {
        if (witness.ordered.length > 1 && witness.compactPreferred === null) {
          knownNegative.itemsWithMultipleReasonsWhereBothPathsAgree += 1;
          if (firedAt.has(witness.fqName)) {
            knownNegative.falsePositives += 1;
            if (knownNegative.detail.length < 8) {
              knownNegative.detail.push({ instanceId: entry.instanceId, at: witness.fqName, reasons: witness.ordered });
            }
          }
        }
      }
    }
    perCorpus[corpus] = stats as unknown as Record<string, number>;
  }

  // §60 — the family cross-tab.
  const crosstab = new Map<string, { count: number; equivalent: number; example: Record<string, string> }>();
  for (const residual of residuals) {
    const key = `${residual.lowerFamily} -> ${residual.higherFamily}`;
    const bucket = crosstab.get(key) ?? { count: 0, equivalent: 0, example: {} };
    bucket.count += 1;
    if (residual.equivalent) bucket.equivalent += 1;
    if (Object.keys(bucket.example).length === 0) {
      bucket.example = {
        at: residual.at,
        instanceId: residual.instanceId,
        lower: residual.lowerReason.slice(0, 150),
        higher: residual.higherReason.slice(0, 150),
      };
    }
    crosstab.set(key, bucket);
  }

  const byClass: Record<string, number> = {};
  for (const residual of residuals) for (const cls of residual.classes) byClass[cls] = (byClass[cls] ?? 0) + 1;

  const distinctSymbolPairs = new Set(residuals.map((residual) => `${residual.instanceId}|${residual.at}|${residual.lowerReason}|${residual.higherReason}`));

  // §21 — direction. If reason selection has a canonical answer, one SIDE of the
  // substitution should consistently be the declared decisive reason.
  const direction: Record<string, number> = {};
  for (const residual of residuals) {
    if (residual.equivalent) continue;
    direction[residual.agreesWithPositionZero] = (direction[residual.agreesWithPositionZero] ?? 0) + 1;
  }
  const ellipsisOnly = residuals.filter((residual) => residual.equivalent).length;

  writeFileSync(path.join(RESULTS, "stage5_m181_residual_reproduction.json"), `${JSON.stringify({
    milestone: "M181-B",
    generatedFrom: "run_stage5_m181_reproduction.ts",
    method: "one frozen authoritative object per case, budget varied alone; reasons validated against the frozen object, never against a delivered response",
    budgets: BUDGETS,
    historicalM180: { reasonResidualPairs: 106, ceilingResidualPairs: 8, totalResidualPairs: 113 },
    reproducedPairViolationsByClass: pairViolations,
    reproducedPairBenignByClass: pairBenign,
    reproducedSymbolLevelSubstitutions: residuals.length,
    distinctSymbolReasonSubstitutions: distinctSymbolPairs.size,
    deliveringBudgets,
    perCorpus,
    byClass,
    reasonSetMutations,
    directionOfSubstitution: direction,
    ellipsisOnlySubstitutions: ellipsisOnly,
    identityControl: { failures: identityFailures.length, detail: identityFailures.slice(0, 10) },
    knownNegative,
    truthfulness,
    residuals: residuals.slice(0, 400),
    residualsTruncated: Math.max(0, residuals.length - 400),
  }, null, 2)}\n`);

  writeFileSync(path.join(RESULTS, "stage5_m181_reason_family_crosstab.json"), `${JSON.stringify({
    milestone: "M181-B",
    generatedFrom: "run_stage5_m181_reproduction.ts",
    question: "When the displayed reason changes, does it change FAMILY — that is, does it stop being the same kind of claim?",
    rows: [...crosstab].sort((a, b) => b[1].count - a[1].count).map(([transition, bucket]) => ({
      transition, count: bucket.count, equivalentUnderM181Relation: bucket.equivalent, example: bucket.example,
    })),
  }, null, 2)}\n`);

  console.log(JSON.stringify({
    milestone: "M181-B",
    reproducedPairViolationsByClass: pairViolations,
    reproducedPairBenignByClass: pairBenign,
    reproducedSymbolLevelSubstitutions: residuals.length,
    distinctSymbolReasonSubstitutions: distinctSymbolPairs.size,
    byClass,
    reasonSetMutations,
    directionOfSubstitution: direction,
    ellipsisOnlySubstitutions: ellipsisOnly,
    identityFailures: identityFailures.length,
    knownNegative: { ...knownNegative, detail: knownNegative.detail.length },
    truthfulness,
    topTransitions: [...crosstab].sort((a, b) => b[1].count - a[1].count).slice(0, 8).map(([key, bucket]) => `${key} = ${bucket.count}`),
  }, null, 2));
  void TERMINAL_RANK;
}

main();
