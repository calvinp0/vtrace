/**
 * M181-D — candidate simulation over the frozen corpus.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m181_candidates.ts --label <name>
 *
 * One arm per invocation, because every quantity here is a pure function of a
 * frozen JSON object and a budget. M180 needed both arms in one process to
 * compare two implementations against the same in-memory object; M181's
 * candidate is a change to a pure selector, the corpus is on disk and immutable,
 * and the identity control in M181-B reports 0 failures over 507 repeated
 * deliveries. Sequential runs are therefore directly comparable, and §94's
 * load-artifact warning does not apply: nothing measured here is a timing.
 *
 * WHAT MUST NOT MOVE, and is therefore measured rather than argued:
 *
 *   itemSupplyHash      which evidence the layer delivered, per budget. A reason
 *                       string changes the rendered length, which changes
 *                       `fits()`, which could change which rung is reached. If
 *                       this hash moves, the candidate changed SELECTION and §32
 *                       forbids it.
 *   relatedOrderHash    the order the projector admitted evidence in.
 *   defaultSerialized   the whole response at the default budget.
 *
 * Offline, pure, deterministic. Live spend $0.00.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { deliver, type Delivered } from "./m179Packing";
import { carriesItemBodies } from "./m179Capture";
import {
  comparePreservation, observeOwnership, renderedSectionIds, rolesFallbackMap,
  type PreservationInput,
} from "./m180Ownership";
import { budgetPairs, distribution, hashOf, reasonSupport, reasonWitnesses } from "./m181Reasons";
import { compactProductResponse, McpResponseDetail } from "../../src/mcp/responseEnvelope";
import { semanticItemSupplyOf } from "../../src/productContext/semanticItemSupply";
import { projectRunPipelineOrientation } from "../../src/runPipeline/orientationProjection";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const CORPUS_ROOT = path.join(RESULTS, "_m179_authoritative");
const BUDGETS = [100, 200, 400, 600, 800, 1_000, 1_200, 1_600, 2_000, 3_200, 6_400, 8_000] as const;
const DEFAULT_BUDGET = 8_000;
/** M166's calibration for serialized tool-result JSON. */
const TOKENS_PER_CHARACTER = 0.25;

const LABEL = (() => {
  const index = process.argv.indexOf("--label");
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : "current";
})();

const atOf = (identity: string): string => identity.split("|")[0] ?? identity;
const howOf = (identity: string): string => identity.slice(atOf(identity).length + 1);

const inputOf = (row: Delivered): PreservationInput => ({
  rank: row.rank, focus: row.focus, related: row.related, notes: row.notes,
  focusCode: row.focusCode, focusCodeCharacters: row.focusCodeCharacters,
});

function respond(authoritative: unknown, budget: number): Record<string, unknown> {
  const draft = structuredClone(authoritative) as Record<string, unknown>;
  delete draft.responseBudget;
  return compactProductResponse(draft, {
    requestedContextTokens: budget,
    detail: McpResponseDetail.Standard,
  }) as unknown as Record<string, unknown>;
}

function main(): void {
  const packetTokens: number[] = [];
  const packetByBudget: Record<string, number[]> = {};
  for (const budget of BUDGETS) packetByBudget[String(budget)] = [];

  const pairViolations: Record<string, number> = {};
  const pairBenign: Record<string, number> = {};
  const truthfulness = { claims: 0, verbatim: 0, ellipsized: 0, rolesFallback: 0, unsupported: 0, outsideSupply: 0 };
  const substitutions = { total: 0, nonEquivalent: 0, ellipsisOnly: 0 };
  // TWO OWNERSHIP NUMBERS, AND ONLY ONE OF THEM IS A GATE.
  //   serializedItemsCut  — the metadata layer still shrinking productContext.items.
  //                         M180 says this SHOULD stay non-zero: items is metadata
  //                         and shrinking it is what that module is for.
  //   projectorSupplyCut  — rendered evidence the ORIENTATION PROJECTOR cannot
  //                         reach. This is M180's repair, and §88 requires 0.
  const ownership = { budgets: 0, serializedItemsCut: 0, projectorSupplyCut: 0 };
  const totality = { deliveries: 0, throws: 0, outsideEnvelope: 0, orientations: 0, declines: 0 };
  const perCase: Record<string, Record<string, unknown>> = {};
  let cases = 0;

  for (const corpus of ["broad100a", "broad100b"]) {
    for (const file of readdirSync(path.join(CORPUS_ROOT, corpus)).sort()) {
      if (!file.endsWith(".json")) continue;
      const capture = JSON.parse(readFileSync(path.join(CORPUS_ROOT, corpus, file), "utf8")) as { instanceId: string; snapshot: unknown };
      if (capture.snapshot === null || !carriesItemBodies(capture.snapshot).valid) continue;
      cases += 1;
      const authoritative = capture.snapshot;
      const witnesses = reasonWitnesses(authoritative);
      const fallback = rolesFallbackMap(authoritative);
      const productContext = (authoritative as Record<string, unknown>).productContext as Record<string, unknown>;
      const leadPivot = String(productContext.leadPivot ?? "");

      const rows = new Map<number, Delivered>();
      const supplyHashes: string[] = [];
      const relatedOrderHashes: string[] = [];
      // Per-budget detail, so a differing aggregate hash can be localised to the
      // budget that moved instead of condemning the whole case. Item ids are
      // short ("D1", "S7"), so this stays compact per §64.
      const perBudget: Array<Record<string, unknown>> = [];
      let defaultSerialized = "";
      let defaultPacket = "";
      let defaultItemIds: readonly string[] = [];
      let defaultRelated: readonly string[] = [];
      let defaultFocus: Record<string, unknown> = {};

      for (const budget of BUDGETS) {
        const response = respond(authoritative, budget);
        const row = deliver(authoritative, budget);
        rows.set(budget, row);
        totality.deliveries += 1;
        if (row.state.startsWith("throw:")) totality.throws += 1;
        else if (!row.withinEnvelope) totality.outsideEnvelope += 1;
        if (row.state === "orientation") totality.orientations += 1; else totality.declines += 1;

        const own = observeOwnership(response, budget);
        ownership.budgets += 1;
        if (own.metadataMutatedSupply) ownership.serializedItemsCut += 1;

        // §32's gates: what was delivered, and in what order.
        const pc = response.productContext as Record<string, unknown> | undefined;
        const rendered = renderedSectionIds(pc?.modelVisibleContext);
        supplyHashes.push(hashOf(rendered));
        perBudget.push({
          budget,
          itemIds: rendered,
          relatedCount: row.related.length,
          // ORDERED per-symbol digests, not one digest of the list. A single
          // hash says "something moved"; this says WHAT moved and whether the
          // symbols they share kept their relative order, which is the §32
          // re-ranking question. Eight characters each keeps §64 happy.
          relatedAts: row.related.map((identity) => hashOf(atOf(identity)).slice(0, 8)),
          state: row.state,
        });

        // §88 — read the supply the projector actually consumes, exactly as
        // `orientationProjection.ts` resolves it, and ask whether any rendered
        // evidence is missing from it.
        if (pc !== undefined && !own.degraded) {
          const consumed = semanticItemSupplyOf(pc) ?? (Array.isArray(pc.items) ? pc.items as Record<string, unknown>[] : []);
          const reachable = new Set(consumed.map((item) => String((item as Record<string, unknown>).id)));
          if (rendered.some((id) => !reachable.has(id))) ownership.projectorSupplyCut += 1;
        }
        relatedOrderHashes.push(hashOf(row.related.map(atOf)));

        // PACKET TOKENS MEAN THE PACKET. M180's `observe` substituted the whole
        // serialized response when the projector returned null, which answers
        // "what did this budget cost" and not "how big is the orientation". A
        // budget that produces no packet is counted as a decline instead, so a
        // candidate cannot look cheaper by declining more often.
        const packet = projectRunPipelineOrientation(response as never);
        const packetJson = packet === null ? "" : JSON.stringify(packet) ?? "";
        if (packet !== null) {
          const tokens = Math.round(packetJson.length * TOKENS_PER_CHARACTER);
          packetTokens.push(tokens);
          packetByBudget[String(budget)]!.push(tokens);
        }

        if (budget === DEFAULT_BUDGET) {
          defaultSerialized = JSON.stringify(response) ?? "";
          defaultPacket = packetJson;
          defaultItemIds = rendered;
          defaultRelated = row.related;
          defaultFocus = packet === null ? {} : { at: packet.focus.at, why: packet.focus.why };
        }

        if (row.state !== "orientation") continue;
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
      }

      for (const [lower, higher] of budgetPairs([...BUDGETS])) {
        const low = rows.get(lower)!;
        const high = rows.get(higher)!;
        const verdict = comparePreservation(inputOf(low), inputOf(high), leadPivot, fallback);
        for (const cls of verdict.violations) pairViolations[cls] = (pairViolations[cls] ?? 0) + 1;
        for (const cls of verdict.benign) pairBenign[cls] = (pairBenign[cls] ?? 0) + 1;
        if (!verdict.violations.includes("SEMANTIC_ROLE_CHANGED")) continue;
        const highByAt = new Map(high.related.map((identity) => [atOf(identity), howOf(identity)]));
        for (const identity of low.related) {
          const at = atOf(identity);
          const highHow = highByAt.get(at);
          if (highHow === undefined) continue;
          const lowHow = howOf(identity);
          if (lowHow === highHow) continue;
          const witness = witnesses.get(at);
          if (witness !== undefined && (lowHow === witness.rolesFallback || highHow === witness.rolesFallback)) continue;
          substitutions.total += 1;
          const head = lowHow.endsWith("…") ? lowHow.slice(0, -1) : null;
          const otherHead = highHow.endsWith("…") ? highHow.slice(0, -1) : null;
          const equivalent = (head !== null && highHow.startsWith(head)) || (otherHead !== null && lowHow.startsWith(otherHead));
          if (equivalent) substitutions.ellipsisOnly += 1; else substitutions.nonEquivalent += 1;
        }
      }

      perCase[`${corpus}/${capture.instanceId}`] = {
        itemSupplyHash: hashOf(supplyHashes),
        relatedOrderHash: hashOf(relatedOrderHashes),
        defaultSerializedHash: hashOf(defaultSerialized),
        defaultPacketHash: hashOf(defaultPacket),
        defaultPacketTokens: Math.round(defaultPacket.length * TOKENS_PER_CHARACTER),
        defaultItemIds,
        defaultRelated,
        defaultFocus,
        perBudget,
      };
    }
  }

  const artifact = {
    milestone: "M181-D",
    candidate: LABEL,
    generatedFrom: "run_stage5_m181_candidates.ts",
    method: "one frozen authoritative object per case, budget varied alone, single arm; reasons validated against the frozen object",
    budgets: BUDGETS,
    defaultBudget: DEFAULT_BUDGET,
    cases,
    pairViolations,
    pairBenign,
    substitutions,
    truthfulness,
    ownership,
    totality,
    packetEconomics: {
      basis: "orientation packets only; budgets that produce no packet are excluded and counted in `totality.declines`",
      deliveringBudgets: packetTokens.length,
      allBudgets: distribution(packetTokens),
      atDefaultBudget: distribution(packetByBudget[String(DEFAULT_BUDGET)]!),
      byBudget: Object.fromEntries(BUDGETS.map((budget) => [budget, distribution(packetByBudget[String(budget)]!)])),
    },
    perCase: Object.fromEntries(Object.entries(perCase).map(([key, row]) => [key, {
      itemSupplyHash: row.itemSupplyHash,
      relatedOrderHash: row.relatedOrderHash,
      defaultSerializedHash: row.defaultSerializedHash,
      defaultPacketHash: row.defaultPacketHash,
      defaultPacketTokens: row.defaultPacketTokens,
    }])),
    detailArtifact: `stage5_m181_candidate_${LABEL}.detail.json`,
  };
  writeFileSync(path.join(RESULTS, `stage5_m181_candidate_${LABEL}.json`), `${JSON.stringify(artifact, null, 2)}\n`);

  // §64 — the per-budget evidence is what proves the §32 no-re-ranking gate, so it
  // is kept; it is just not kept in the summary. `.detail.json` is the existing
  // convention for this in `results/`.
  writeFileSync(path.join(RESULTS, `stage5_m181_candidate_${LABEL}.detail.json`), `${JSON.stringify({
    milestone: "M181-D", candidate: LABEL, generatedFrom: "run_stage5_m181_candidates.ts",
    summaryArtifact: `stage5_m181_candidate_${LABEL}.json`,
    perCase,
  }, null, 2)}\n`);

  console.log(JSON.stringify({
    milestone: "M181-D", candidate: LABEL, cases,
    pairViolations, pairBenign, substitutions, truthfulness, ownership, totality,
    packetMedianAllBudgets: artifact.packetEconomics.allBudgets.median,
    packetMedianDefault: artifact.packetEconomics.atDefaultBudget.median,
  }, null, 2));
}

main();
