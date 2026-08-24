/**
 * M180-B — reproduce M179's residual 83 preservation violations, and attribute
 * each one to the layer that caused it.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m180_reproduction.ts
 *
 * ONE FROZEN AUTHORITATIVE OBJECT, MANY BUDGETS — M179's method, unchanged, on
 * M179's corpora. Nothing varies but the delivery budget, so a difference is a
 * property of delivery and of nothing upstream.
 *
 * WHAT THIS ADDS. For every violating pair it asks the causal question M179 did
 * not: at the LARGER budget, was the lost evidence still in the response, with
 * only its index entry removed? An answer of yes is not a retrieval fact, a
 * ranking fact or a budget fact. It is a bookkeeping operation deleting evidence
 * the same response is still paying to ship.
 *
 * Offline, pure, deterministic. Live spend $0.00.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { comparePair, deliver, hashOf, authoritativeIdentity, type Delivered } from "./m179Packing";
import { carriesItemBodies } from "./m179Capture";
import {
  isRecord, observeOwnership, semanticItemSupplyHash, asArray, type OwnershipRow,
} from "./m180Ownership";
/**
 * The arm under measurement. `--arm <root>` points at another checkout so the
 * same instrument can be run against the pre-M180 code; the default is this one.
 */
const ARM_ROOT = (() => {
  const index = process.argv.indexOf("--arm");
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : path.resolve(".");
})();
const { compactProductResponse, McpResponseDetail } = await import(`${ARM_ROOT}/src/mcp/responseEnvelope`) as {
  compactProductResponse: (output: unknown, options: Record<string, unknown>) => unknown;
  McpResponseDetail: Record<string, string>;
};
const { deliver: deliverVia } = await import(`${ARM_ROOT}/benchmarks/stage5_vexp_swe_bench_smoke/m179Packing`) as {
  deliver: typeof deliver;
};

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const CORPUS_ROOT = path.join(RESULTS, "_m179_authoritative");

/** M179's ladder, unchanged, so the counts are comparable to its report. */
const BUDGETS = [100, 200, 400, 600, 800, 1_000, 1_200, 1_600, 2_000, 3_200, 6_400, 8_000] as const;

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
    // §11's standing fixture control: an object whose items lost their bodies is
    // a RESPONSE, not the packer's input, and measures rungs made of headers.
    if (!carriesItemBodies(capture.snapshot).valid) continue;
    cases.push({ corpus, instanceId: capture.instanceId, authoritative: capture.snapshot });
  }
  return cases;
}

/** The response the projector is actually handed, for ownership observation. */
function respond(authoritative: unknown, budget: number): Record<string, unknown> {
  const draft = structuredClone(authoritative) as Record<string, unknown>;
  delete draft.responseBudget;
  return compactProductResponse(draft, {
    requestedContextTokens: budget,
    detail: McpResponseDetail.Standard!,
  }) as Record<string, unknown>;
}

const atOf = (identity: string): string => identity.split("|")[0] ?? identity;

interface Classified {
  readonly corpus: string;
  readonly instanceId: string;
  readonly lower: number;
  readonly higher: number;
  readonly m179Classes: readonly string[];
  readonly m180Classes: readonly string[];
  readonly lostEvidence: readonly string[];
  /** Ids of the lost evidence still rendered in the higher budget's response. */
  readonly stillRenderedAtHigher: readonly string[];
  readonly withheldByAtHigher: string;
  readonly attribution: string;
}

function classify(
  corpus: string,
  instanceId: string,
  lower: number,
  higher: number,
  lowerRow: Delivered,
  higherRow: Delivered,
  higherOwnership: OwnershipRow,
  higherResponse: Record<string, unknown>,
): Classified {
  const m179 = comparePair(lower, lowerRow, higher, higherRow)!;
  const classes: string[] = [];
  const higherAts = new Set(higherRow.related.map(atOf));
  const lowerSet = new Set(lowerRow.related);

  if (m179.classes.includes("FOCUS_SUBSTITUTED")) classes.push("FOCUS_CHANGED");
  const missing = lowerRow.related.filter((id) => !higherRow.related.includes(id));
  const gone = missing.filter((id) => !higherAts.has(atOf(id)));
  const reclaimed = missing.filter((id) => higherAts.has(atOf(id)));
  if (gone.length > 0) classes.push("RELATED_ITEM_LOST");
  if (reclaimed.length > 0) classes.push("SEMANTIC_ROLE_CHANGED");
  if (missing.length > 0 && higherRow.related.some((id) => !lowerSet.has(id))) classes.push("RELATED_ITEM_REPLACED");
  for (const extra of m179.classes) {
    if (["PRIORITY_INVERSION", "REPRESENTATION_DOWNGRADE", "QUALIFIER_EVICTED", "ORIENTATION_TO_DECLINE", "DECLINE_TO_REFUSED"].includes(extra)) {
      classes.push(extra);
    }
  }

  // The causal question. `withheld` is evidence rendered into the higher
  // budget's response whose index entry the metadata layer deleted; if what the
  // lower budget delivered is sitting in there, the larger budget is paying to
  // ship evidence it has made unreachable.
  const withheldAtHigher = new Set(higherOwnership.withheld);
  const productContext = isRecord(higherResponse.productContext) ? higherResponse.productContext : {};
  const renderedIds = new Set(higherOwnership.evidenceSupply);
  void productContext;
  const lostAts = new Set([...missing.map(atOf), ...(m179.classes.includes("FOCUS_SUBSTITUTED") && lowerRow.focus !== null ? [lowerRow.focus] : [])]);

  // Map the lost symbols back to the rendered sections that carry them, by
  // reading the higher response's own rendering rather than trusting ids.
  const rendered = String(productContext.modelVisibleContext ?? "");
  const stillRendered: string[] = [];
  for (const at of lostAts) {
    const symbol = at.includes("::") ? at.slice(at.lastIndexOf("::") + 2) : at;
    if (symbol !== "" && rendered.includes(symbol)) stillRendered.push(at);
  }

  const attribution = higherOwnership.degraded
    ? "degradation"
    : stillRendered.length > 0 && withheldAtHigher.size > 0
      ? `metadata_layer:${higherOwnership.withheldBy}`
      : withheldAtHigher.size > 0
        ? `metadata_layer_unmatched:${higherOwnership.withheldBy}`
        : "evidence_layer_or_other";

  void renderedIds;
  return {
    corpus, instanceId, lower, higher,
    m179Classes: m179.classes,
    m180Classes: [...new Set(classes)],
    lostEvidence: m179.lostEvidence,
    stillRenderedAtHigher: stillRendered,
    withheldByAtHigher: higherOwnership.withheldBy,
    attribution,
  };
}

async function main(): Promise<void> {
  const violations: Classified[] = [];
  const ownership: Record<string, unknown>[] = [];
  const supplyHashes: Record<string, unknown>[] = [];
  const perCorpus: Record<string, Record<string, number>> = {};
  let identityChecked = 0;
  let identityFailures = 0;

  for (const corpus of ["broad100a", "broad100b"]) {
    const cases = loadCorpus(corpus);
    let violatingPairs = 0;
    let casesWithViolation = 0;
    let mutatedBudgets = 0;
    let totalBudgets = 0;

    for (const entry of cases) {
      const identity = authoritativeIdentity(entry.authoritative);
      const rows: (Delivered & { budget: number })[] = [];
      const owns: OwnershipRow[] = [];
      const responses: Record<string, unknown>[] = [];

      for (const budget of BUDGETS) {
        const delivered = deliverVia(entry.authoritative, budget);
        const response = respond(entry.authoritative, budget);
        rows.push({ budget, ...delivered });
        owns.push(observeOwnership(response, budget));
        responses.push(response);
        totalBudgets += 1;
      }
      for (const own of owns) if (own.metadataMutatedSupply) mutatedBudgets += 1;

      // §24 identity control: the same object at the same budget, packed twice.
      const repeat = deliverVia(entry.authoritative, 8_000);
      identityChecked += 1;
      if (hashOf(repeat) !== hashOf(rows[rows.length - 1]!, )) {
        const last = { ...rows[rows.length - 1]! } as Record<string, unknown>;
        delete last.budget;
        if (hashOf(repeat) !== hashOf(last)) identityFailures += 1;
      }

      let any = false;
      for (let i = 0; i < rows.length; i += 1) {
        for (let j = i + 1; j < rows.length; j += 1) {
          const violation = comparePair(rows[i]!.budget, rows[i]!, rows[j]!.budget, rows[j]!);
          if (violation === null) continue;
          any = true;
          violatingPairs += 1;
          violations.push(classify(
            corpus, entry.instanceId, rows[i]!.budget, rows[j]!.budget,
            rows[i]!, rows[j]!, owns[j]!, responses[j]!,
          ));
        }
      }
      if (any) casesWithViolation += 1;

      // §17/§59: the AUTHORITATIVE supply is budget-independent by construction;
      // what the projector is handed should differ from the evidence layer's
      // delivery only where the metadata layer intervened.
      supplyHashes.push({
        corpus,
        instanceId: entry.instanceId,
        authoritativeSupplyHash: semanticItemSupplyHash(
          asArray(isRecord(entry.authoritative) && isRecord((entry.authoritative as Record<string, unknown>).productContext)
            ? ((entry.authoritative as Record<string, unknown>).productContext as Record<string, unknown>).items
            : []),
        ),
        authoritativeItems: identity.itemCount,
        distinctEvidenceSupplyHashes: new Set(owns.map((own) => own.supplyHash)).size,
        distinctProjectorInputHashes: new Set(owns.map((own) => own.projectorInputHash)).size,
        budgetsWhereMetadataMutatedSupply: owns.filter((own) => own.metadataMutatedSupply).length,
      });

      for (const own of owns) {
        ownership.push({
          corpus, instanceId: entry.instanceId, budget: own.budget,
          evidenceSupply: own.evidenceSupply.length,
          projectorInput: own.projectorInput.length,
          withheld: own.withheld.length,
          withheldBy: own.withheldBy,
          degraded: own.degraded,
        });
      }
    }

    perCorpus[corpus] = {
      cases: cases.length,
      violatingPairs,
      casesWithViolation,
      budgets: totalBudgets,
      budgetsWhereMetadataMutatedSupply: mutatedBudgets,
    };
  }

  const byClass: Record<string, number> = {};
  for (const violation of violations) {
    for (const cls of violation.m180Classes) byClass[cls] = (byClass[cls] ?? 0) + 1;
  }
  const byAttribution: Record<string, number> = {};
  for (const violation of violations) {
    byAttribution[violation.attribution] = (byAttribution[violation.attribution] ?? 0) + 1;
  }

  const report = {
    milestone: "M180-B",
    generatedFrom: "run_stage5_m180_reproduction.ts",
    arm: ARM_ROOT,
    method: "one frozen authoritative object per case, budget varied alone, current implementation only",
    budgets: BUDGETS,
    historicalM179Violations: 83,
    reproducedViolations: violations.length,
    perCorpus,
    byClass,
    byAttribution,
    identityControl: { checked: identityChecked, failures: identityFailures },
    violations,
  };
  const suffix = ARM_ROOT === path.resolve(".") ? "" : "_prerepair";
  writeFileSync(path.join(RESULTS, `stage5_m180_violation_reproduction${suffix}.json`), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(RESULTS, `stage5_m180_semantic_item_hashes${suffix}.json`), `${JSON.stringify({ milestone: "M180-B", cases: supplyHashes }, null, 2)}\n`);
  writeFileSync(path.join(RESULTS, `stage5_m180_ownership_rows${suffix}.json`), `${JSON.stringify({ milestone: "M180-B", rows: ownership }, null, 2)}\n`);

  console.log(JSON.stringify({
    reproduced: violations.length, perCorpus, byClass, byAttribution,
    identityControl: report.identityControl,
  }, null, 2));
}

await main();
