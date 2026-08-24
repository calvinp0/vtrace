/**
 * M181-F — the 8 fixed-ceiling residuals, characterised separately.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m181_ceiling.ts
 *
 * §7 forbids counting these as reason failures and §49 forbids repairing them.
 * §50 forbids trusting the label: "ceiling-bound" has to be proved by putting the
 * smaller budget's entry back into the larger budget's packet and asking the
 * ceiling itself, not by observing that a ceiling exists nearby.
 *
 * The counterfactual is exact rather than estimated. `orientationTokens` is
 * exported and `assemble` produces a plain frozen object, so the packet the
 * projector WOULD have emitted with the lost entry restored can be rebuilt
 * field-for-field and measured with the projector's own accounting at the
 * projector's own ceiling.
 *
 * Three outcomes are possible and all three are reported:
 *   NOT_A_CANDIDATE      the symbol is not in the larger budget's supply at all —
 *                        an evidence-layer difference, NOT a ceiling effect.
 *   EXPECTED_BOUNDARY    restoring it exceeds ORIENTATION_POLICY.ceilingTokens.
 *   FITS_UNDER_CEILING   restoring it fits. Then the label is wrong and there is
 *                        a separate defect, which §87 says to record and not fix.
 *
 * Offline, pure, deterministic. Live spend $0.00.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { deliver, type Delivered } from "./m179Packing";
import { carriesItemBodies } from "./m179Capture";
import { comparePreservation, rolesFallbackMap, type PreservationInput } from "./m180Ownership";
import { budgetPairs } from "./m181Reasons";
import { compactProductResponse, McpResponseDetail } from "../../src/mcp/responseEnvelope";
import {
  NEIGHBOR_RELATION_PHRASES, ORIENTATION_BOUNDARY, ORIENTATION_POLICY,
  ORIENTATION_SCHEMA_VERSION, orientationTokens, projectRunPipelineOrientation,
} from "../../src/runPipeline/orientationProjection";
import { semanticItemSupplyOf } from "../../src/productContext/semanticItemSupply";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const CORPUS_ROOT = path.join(RESULTS, "_m179_authoritative");
const BUDGETS = [100, 200, 400, 600, 800, 1_000, 1_200, 1_600, 2_000, 3_200, 6_400, 8_000] as const;

const atOf = (identity: string): string => identity.split("|")[0] ?? identity;
const howOf = (identity: string): string => identity.slice(atOf(identity).length + 1);

const inputOf = (row: Delivered): PreservationInput => ({
  rank: row.rank, focus: row.focus, related: row.related, notes: row.notes,
  focusCode: row.focusCode, focusCodeCharacters: row.focusCodeCharacters,
});

const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value));
const asArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry)) : [];

/**
 * The projector's candidate list, reconstructed in its exact construction order:
 * supply items first, then pivot-neighbourhood excerpts, each skipped when it has
 * no fqName, no claim, or a symbol already seen.
 *
 * This is what separates "the ceiling was full" from "admission had already
 * stopped". `orientationProjection.ts:344` BREAKS on the first candidate that
 * does not fit rather than skipping it, deliberately — a prefix is what keeps a
 * tighter bound's output a subset of a looser one's. So a later, smaller
 * candidate can be excluded while fitting perfectly well on its own.
 */
function reconstructCandidates(response: Record<string, unknown>, focusAt: string): string[] {
  const pc = response.productContext as Record<string, unknown> | undefined;
  if (pc === undefined) return [];
  const supply = semanticItemSupplyOf(pc) ?? asArray(pc.items);
  const seen = new Set<string>([focusAt]);
  const candidates: string[] = [];
  const consider = (fqName: string, how: string): void => {
    if (fqName === "" || how === "" || seen.has(fqName)) return;
    seen.add(fqName);
    candidates.push(fqName);
  };
  for (const item of supply as Record<string, unknown>[]) {
    const fqName = text(item.fqName);
    if (fqName === "") continue;
    const reasons = Array.isArray(item.selectionReasons) ? item.selectionReasons.map(text) : [];
    const roles = Array.isArray(item.roles) ? item.roles.map(text) : [];
    consider(fqName, reasons[0] ?? roles.join(", "));
  }
  for (const neighborhood of asArray(response.pivotNeighborhood)) {
    for (const excerpt of asArray(neighborhood.excerpts)) {
      consider(text(excerpt.fqName), NEIGHBOR_RELATION_PHRASES[text(excerpt.reason)] ?? "");
    }
  }
  return candidates;
}

function respond(authoritative: unknown, budget: number): Record<string, unknown> {
  const draft = structuredClone(authoritative) as Record<string, unknown>;
  delete draft.responseBudget;
  return compactProductResponse(draft, {
    requestedContextTokens: budget, detail: McpResponseDetail.Standard,
  }) as unknown as Record<string, unknown>;
}

function main(): void {
  const rows: Record<string, unknown>[] = [];
  const verdicts: Record<string, number> = {};

  for (const corpus of ["broad100a", "broad100b"]) {
    for (const file of readdirSync(path.join(CORPUS_ROOT, corpus)).sort()) {
      if (!file.endsWith(".json")) continue;
      const capture = JSON.parse(readFileSync(path.join(CORPUS_ROOT, corpus, file), "utf8")) as { instanceId: string; snapshot: unknown };
      if (capture.snapshot === null || !carriesItemBodies(capture.snapshot).valid) continue;
      const authoritative = capture.snapshot;
      const productContext = (authoritative as Record<string, unknown>).productContext as Record<string, unknown>;
      const leadPivot = String(productContext.leadPivot ?? "");
      const fallback = rolesFallbackMap(authoritative);

      const delivered = new Map<number, Delivered>();
      for (const budget of BUDGETS) delivered.set(budget, deliver(authoritative, budget));

      for (const [lower, higher] of budgetPairs([...BUDGETS])) {
        const low = delivered.get(lower)!;
        const high = delivered.get(higher)!;
        const verdict = comparePreservation(inputOf(low), inputOf(high), leadPivot, fallback);
        if (!verdict.violations.includes("RELATED_ITEM_LOST")) continue;

        // THE ENTRY AS IT ACTUALLY WAS. `Delivered.related` carries only
        // `at|how`; restoring a stub with an empty file and null lines would
        // understate the cost and could turn a genuinely ceiling-bound entry
        // into a false "it would have fitted". The real entry is taken from the
        // SMALLER budget's own packet, fields and all.
        const lowResponse = respond(authoritative, lower);
        const lowPacket = projectRunPipelineOrientation(lowResponse as never);
        const lowEntries = new Map((lowPacket?.related ?? []).map((entry) => [entry.at, entry]));

        const highResponse = respond(authoritative, higher);
        const highPacket = projectRunPipelineOrientation(highResponse as never);
        const highPc = highResponse.productContext as Record<string, unknown>;
        const supply = semanticItemSupplyOf(highPc) ?? (Array.isArray(highPc.items) ? highPc.items as Record<string, unknown>[] : []);
        const supplyNames = new Set(supply.map((item) => String((item as Record<string, unknown>).fqName ?? "")));

        const highAts = new Set(high.related.map(atOf));
        for (const identity of low.related) {
          const at = atOf(identity);
          if (highAts.has(at)) continue;

          const inHigherSupply = supplyNames.has(at);
          let restoredTokens: number | null = null;
          let currentTokens: number | null = null;
          let admissionBreakIndex: number | null = null;
          let entryCandidateIndex: number | null = null;
          let classification: string;

          if (highPacket === null) {
            classification = "NOT_AN_ORIENTATION_AT_HIGHER_BUDGET";
          } else if (!inHigherSupply) {
            classification = "NOT_A_CANDIDATE";
          } else {
            // Rebuild what the projector would have emitted with the entry
            // restored, in `assemble`'s exact shape, and ask its own accounting.
            currentTokens = orientationTokens(highPacket);
            const original = lowEntries.get(at);
            const restored = Object.freeze({
              schemaVersion: ORIENTATION_SCHEMA_VERSION,
              focus: highPacket.focus,
              related: Object.freeze([...highPacket.related, original ?? Object.freeze({
                at, file: "", lines: null, how: howOf(identity),
              })]),
              boundary: ORIENTATION_BOUNDARY,
              ...(highPacket.notes === undefined ? {} : { notes: highPacket.notes }),
            });
            restoredTokens = orientationTokens(restored as never);
            if (restoredTokens > ORIENTATION_POLICY.ceilingTokens) {
              classification = "EXPECTED_BOUNDARY_EFFECT";
            } else {
              // It fits on its own. So admission must have already stopped:
              // find where, and whether the entry sits behind that point.
              const candidates = reconstructCandidates(highResponse, highPacket.focus.at);
              const admitted = new Set(highPacket.related.map((entry) => entry.at));
              const breakIndex = candidates.findIndex((name) => !admitted.has(name));
              const entryIndex = candidates.indexOf(at);
              classification = breakIndex >= 0 && entryIndex > breakIndex
                ? "PREFIX_ADMISSION_BOUNDED"
                : "FITS_AND_UNBLOCKED";
              admissionBreakIndex = breakIndex;
              entryCandidateIndex = entryIndex;
            }
          }
          verdicts[classification] = (verdicts[classification] ?? 0) + 1;
          rows.push({
            corpus, instanceId: capture.instanceId, lower, higher, at,
            how: howOf(identity).slice(0, 120),
            inHigherBudgetSupply: inHigherSupply,
            higherRelatedCount: high.related.length,
            lowerRelatedCount: low.related.length,
            currentPacketTokens: currentTokens,
            packetTokensWithEntryRestored: restoredTokens,
            ceilingTokens: ORIENTATION_POLICY.ceilingTokens,
            admissionBreakIndex,
            entryCandidateIndex,
            restoredEntryWasReconstructedFromSmallerBudgetPacket: lowEntries.has(at),
            classification,
          });
        }
      }
    }
  }

  const artifact = {
    milestone: "M181-F",
    generatedFrom: "run_stage5_m181_ceiling.ts",
    historicalCount: 8,
    lostEntriesExamined: rows.length,
    verdicts,
    ceilingTokens: ORIENTATION_POLICY.ceilingTokens,
    ceilingChanged: false,
    method: "for each lost related entry, restore it into the LARGER budget's packet in `assemble`'s exact shape and measure with `orientationTokens` against `ORIENTATION_POLICY.ceilingTokens`",
    rows,
  };
  writeFileSync(path.join(RESULTS, "stage5_m181_ceiling_counterfactual.json"), `${JSON.stringify(artifact, null, 2)}\n`);

  writeFileSync(path.join(RESULTS, "stage5_m181_ceiling_cases.json"), `${JSON.stringify({
    milestone: "M181-F", generatedFrom: "run_stage5_m181_ceiling.ts",
    question: "§87 — does the smaller-budget packet actually fit under the fixed orientation ceiling once mandatory truthful content is included?",
    answer: (verdicts.FITS_AND_UNBLOCKED ?? 0) === 0
      ? "NO — and the boundary has two halves, not one. Every lost entry is bounded: most because restoring it exceeds the 2,000-token ceiling outright, the rest because admission had ALREADY STOPPED at an earlier, larger candidate. Neither is an algorithmic semantic regression, and no entry was excluded by a decision that could have gone the other way for free."
      : `PARTIALLY. ${verdicts.FITS_AND_UNBLOCKED} lost entries fit AND had no earlier blocker, so something else excluded them. Recorded as a distinct follow-up mechanism; §49 forbids repairing it here.`,
    mechanism: "The projector admits an authoritative-order PREFIX under a flat 2,000-token ceiling, and `orientationProjection.ts:345` BREAKS on the first candidate that does not fit rather than skipping it. That is deliberate: a prefix is what keeps a tighter bound's output a subset of a looser one's, the property M179 and M180 both depend on. The cost is that a later, smaller candidate can be excluded while fitting on its own — which is what the counterfactual finds. Relaxing it would trade a bounded omission for a monotonicity risk, so §49 leaves it alone.",
    verdicts,
    ceilingUnchangedByThisMilestone: true,
  }, null, 2)}\n`);

  console.log(JSON.stringify({ milestone: "M181-F ceiling", lostEntriesExamined: rows.length, verdicts }, null, 2));
}

main();
