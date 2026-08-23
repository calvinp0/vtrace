/**
 * M175-B — reproduce the M174 eviction, and prove what caused it.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m175_pathology.ts
 *
 * M174 recorded, from the live product: retrieval succeeded with ten items and a
 * correct lead pivot, and the response delivered none of them. This re-derives
 * that outcome from the product as it stands today and establishes, from the
 * envelope's own accounting, that the request echo is what the evidence lost to.
 *
 * THE INSTRUMENT THAT WAS TRIED AND REJECTED. The obvious method is to capture
 * one authoritative snapshot and replay compaction over it under each policy —
 * perfect isolation, since both arms would be the same bytes. It does not work
 * here, for a reason worth recording so it is not attempted again:
 *
 *   Compaction runs before any response leaves the server, so a capture taken at
 *   the product's budget is already the wreck. On this subject `productContext.
 *   items` arrives EMPTY and `deliveryFailed` is already true. No replay can
 *   restore evidence that was destroyed before it reached the disk.
 *
 *   Capturing above the ceiling keeps the evidence — but `max_tokens` feeds
 *   `budgetTokens` at tools.ts:9189 as well as `requestedContextTokens` at
 *   tools.ts:9255, one expression serving both, so a wider capture SELECTS
 *   DIFFERENTLY. Measured: 24 items selected at 120,000 against 10 at 8,000.
 *   That is a different pipeline state, and comparing policies across it would
 *   violate the isolation the method was chosen for.
 *
 * WHAT IS DONE INSTEAD. Two things, neither of which needs the evidence to have
 * survived:
 *
 *   MECHANISM   every rung of the compaction ladder, and what it is permitted to
 *               reduce. `request` appears at none of them. This is read from the
 *               source, not inferred from a measurement.
 *
 *   ARITHMETIC  the envelope records what it wanted to fit and what it was given.
 *               If the echo that cannot be reduced exceeds the deficit that
 *               destroyed the evidence, the evidence lost to the echo. Both
 *               numbers come from the product's own `responseBudget` and
 *               `productContext.delivery` blocks.
 *
 * The confirming before/after over the real product is M175-E's job, after the
 * repair exists. B establishes cause; E establishes effect.
 *
 * Offline. No agent, no Docker, no paid API.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  attributeEcho, DEFAULT_REQUESTED_CONTEXT_TOKENS, envelopeTokens, isRecord, readDelivery,
} from "./m175Echo";
import {
  captureCached, captureDefaultCached, loadProblemStatements, readDefaultPath,
} from "./m175Capture";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const WORKSPACES = path.join(RESULTS, "workspaces");
const DATASET = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");
const CACHE = path.join(RESULTS, "_m175_snapshots");
const M174_CAPTURE = path.join(RESULTS, "_m174_fallback_capture");

/** The case M174 measured falling back, and one it measured staying compact. */
const SUBJECT = "matplotlib__matplotlib-22719";
const CONTROL = "mwaskom__seaborn-3187";

const workspaceFor = (id: string): string =>
  path.join(WORKSPACES, `m173_vtrace_compact_${id.replace(/-/g, "_")}`, id);

const statements = loadProblemStatements(DATASET);

/**
 * Can removing the request echo pay the deficit that destroyed the evidence?
 *
 * The envelope publishes both sides of the trade it made. `initialModelTokens` is
 * the evidence the packer had ready; `estimated_metadata_tokens` is what the rest
 * of the response cost after every legal reduction had already run. Their sum
 * against the ceiling is the deficit the ladder could not close, and it closed it
 * by deleting the evidence instead.
 *
 * The echo is measured two ways, because they license different claims:
 *
 *   duplicateOnly    the second verbatim copy. Removing it is pure deduplication
 *                    and costs the response no information whatsoever.
 *   bothCopies       all verbatim request prose, which M175-A found has no
 *                    product consumer.
 *
 * Deliberately conservative: metadata is measured AFTER degradation, so it omits
 * the per-item metadata rows a delivered response would also have carried. That
 * understates the deficit, so a sufficiency verdict here is a floor, not a boast.
 */
interface Sufficiency {
  readonly evidenceTokens: number;
  readonly metadataTokensAfterDegradation: number;
  readonly ceilingTokens: number;
  readonly deficitTokens: number;
  readonly duplicateOnlyTokens: number;
  readonly bothCopiesTokens: number;
  readonly duplicateOnlySuffices: boolean;
  readonly bothCopiesSuffices: boolean;
  readonly headroomAfterBothCopies: number;
  readonly conservative: string;
}

function sufficiency(snapshot: unknown): Sufficiency | null {
  const delivery = readDelivery(snapshot);
  const echo = attributeEcho(snapshot);
  const record = isRecord(snapshot) ? snapshot : {};
  const productContext = isRecord(record.productContext) ? record.productContext : {};
  const deliveryBlock = isRecord(productContext.delivery) ? productContext.delivery : {};
  const evidenceTokens = typeof deliveryBlock.initialModelTokens === "number"
    ? deliveryBlock.initialModelTokens
    : 0;
  if (delivery.ceilingTokens === 0) return null;

  const wouldHaveBeen = delivery.metadataTokens + evidenceTokens;
  const deficit = wouldHaveBeen - delivery.ceilingTokens;
  const duplicateOnly = Math.ceil(echo.duplicatedEchoCharacters / 4);
  const both = Math.ceil(echo.verbatimEchoCharacters / 4);
  return {
    evidenceTokens,
    metadataTokensAfterDegradation: delivery.metadataTokens,
    ceilingTokens: delivery.ceilingTokens,
    deficitTokens: deficit,
    duplicateOnlyTokens: duplicateOnly,
    bothCopiesTokens: both,
    duplicateOnlySuffices: deficit > 0 && duplicateOnly >= deficit,
    bothCopiesSuffices: deficit > 0 && both >= deficit,
    headroomAfterBothCopies: both - deficit,
    conservative:
      "Metadata is measured after degradation, so the per-item metadata a delivered response "
      + "would also carry is excluded. The real deficit is larger and so is the real echo saving; "
      + "this understates both.",
  };
}

async function main(): Promise<void> {
  mkdirSync(CACHE, { recursive: true });
  const rows: Record<string, unknown>[] = [];

  for (const instanceId of [SUBJECT, CONTROL]) {
    const repoRoot = workspaceFor(instanceId);
    const task = statements.get(instanceId);
    if (task === undefined) throw new Error(`no problem_statement for ${instanceId} in ${DATASET}`);
    if (!existsSync(repoRoot)) throw new Error(`missing workspace ${repoRoot}`);

    process.stdout.write(`capturing ${instanceId} (task ${task.length} chars) … `);
    // The default path: what an agent actually receives today. Since M172 this is
    // a projection, so it shows the OUTCOME (packet or decline) and no internals.
    const defaultCapture = await captureDefaultCached(CACHE, instanceId, repoRoot, task);
    // detail=debug: the only path on which envelope internals are observable at
    // all. Its metadata is larger than the default path's by construction, so its
    // absolute figures are used for the ECHO's share and never for prevalence.
    const debugCapture = await captureCached(
      CACHE, instanceId, repoRoot, task, DEFAULT_REQUESTED_CONTEXT_TOKENS, ".debug",
    );
    if (debugCapture.error !== null || debugCapture.snapshot === null) {
      console.log(`FAILED (${debugCapture.error})`);
      rows.push({ instanceId, error: debugCapture.error });
      continue;
    }
    console.log("ok");

    const today = readDefaultPath(defaultCapture.snapshot);
    const echo = attributeEcho(debugCapture.snapshot);
    const debugDelivery = readDelivery(debugCapture.snapshot);

    // THE PRIMARY EVIDENCE. M174 captured this case on the DEFAULT path, before
    // the decline projector existed to hide the authoritative envelope behind a
    // 143-token non-answer. It is the only artifact that records the default
    // path's own budget arithmetic, so the sufficiency verdict is computed from
    // it rather than from the inflated debug response.
    const m174File = path.join(M174_CAPTURE, `${instanceId.replace(/-/g, "_")}.json`);
    const m174 = existsSync(m174File)
      ? JSON.parse(readFileSync(m174File, "utf8")) as Record<string, unknown>
      : null;
    const authoritative = m174 !== null && isRecord(m174.productContext) ? m174 : null;
    const suff = authoritative === null ? null : sufficiency(authoritative);
    const defaultPathEcho = authoritative === null ? null : attributeEcho(authoritative);
    const defaultPathDelivery = authoritative === null ? null : readDelivery(authoritative);

    rows.push({
      instanceId,
      role: instanceId === SUBJECT ? "known_positive" : "known_negative",
      taskCharacters: debugCapture.taskCharacters,
      requestedContextTokens: DEFAULT_REQUESTED_CONTEXT_TOKENS,
      defaultPathToday: today,
      defaultPathM174: defaultPathDelivery === null ? null : {
        source: "results/_m174_fallback_capture",
        delivery: defaultPathDelivery,
        attribution: defaultPathEcho,
      },
      sufficiency: suff,
      debugDetail: {
        note: "detail=debug retains machine-facing diagnostics, so its envelope is larger than the "
          + "default path's. Reported for the echo's composition only.",
        attribution: echo,
        delivery: debugDelivery,
        requestBlockTokens: envelopeTokens(isRecord(debugCapture.snapshot) ? debugCapture.snapshot.request : null),
      },
    });

    console.log(
      `  ${instanceId}\n`
      + `    default path TODAY: ${today.kind}`
      + `${today.declineState === null ? "" : ` (${today.declineState})`}`
      + ` focus=${today.focusAt ?? "none"} related=${today.relatedCount} `
      + `${today.billedTokens} billed tokens\n`
      + (defaultPathEcho === null || defaultPathDelivery === null ? "" :
        `    default path M174:  state=${defaultPathDelivery.resultState} selected=`
        + `${defaultPathDelivery.selectedItemsBeforeBudget} delivered=${defaultPathDelivery.deliveredItems} `
        + `pivot=${defaultPathDelivery.leadPivot ?? "none"}\n`
        + `      echo ${defaultPathEcho.verbatimEchoCharacters} chars = `
        + `${(defaultPathEcho.echoShareOfResponse * 100).toFixed(1)}% of a `
        + `${defaultPathEcho.totalCharacters}-char response\n`)
      + (suff === null ? "" :
        `      evidence ${suff.evidenceTokens} + metadata ${suff.metadataTokensAfterDegradation} = `
        + `${suff.evidenceTokens + suff.metadataTokensAfterDegradation} vs ceiling ${suff.ceilingTokens} `
        + `→ deficit ${suff.deficitTokens}\n`
        + `      removable: duplicate-only ${suff.duplicateOnlyTokens} (suffices `
        + `${suff.duplicateOnlySuffices}), both copies ${suff.bothCopiesTokens} (suffices `
        + `${suff.bothCopiesSuffices})\n`)
      + `    debug detail: echo ${echo.verbatimEchoCharacters} chars = `
      + `${(echo.echoShareOfResponse * 100).toFixed(1)}% of ${echo.totalCharacters} chars`,
    );
  }

  const subject = rows.find((row) => row.instanceId === SUBJECT) as {
    sufficiency?: Sufficiency | null;
  } | undefined;

  const verdict = subject?.sufficiency == null
    ? "REQUEST_ECHO_NOT_MEASURABLE"
    : subject.sufficiency.deficitTokens <= 0
      ? "REQUEST_ECHO_NOT_CAUSAL"
      : subject.sufficiency.bothCopiesSuffices
        ? "REQUEST_ECHO_EVICTION_CONFIRMED"
        : "REQUEST_ECHO_EVICTION_PARTIAL";

  writeFileSync(path.join(RESULTS, "stage5_m175_pathology_reproduction.json"), `${JSON.stringify({
    schemaVersion: "stage5.m175.pathology-reproduction.v1",
    milestone: "M175",
    workstream: "M175-B",
    subject: SUBJECT,
    control: CONTROL,
    method: {
      defaultPath: "run_pipeline with no detail and no max_tokens — what an agent receives",
      envelopeInternals:
        "M174's own default-path capture, taken before the decline projector hid the authoritative "
        + "envelope. It is the only artifact recording the DEFAULT path's budget arithmetic.",
      supplementary: "a detail=debug capture, for the echo's composition only",
      taskText: "the raw SWE-bench problem_statement, which is what the live M173/M174 runs sent",
      claim: "cause, from the envelope's own accounting — not effect, which is M175-E",
      whyNotDebugForPrevalence:
        "detail=debug retains machine-facing diagnostics the default path drops, so it degrades on "
        + "cases the default path delivers. Measured here: the seaborn control fails delivery at "
        + "debug and succeeds on the default path. Prevalence is measured on the default path only.",
    },
    rejectedInstrument: {
      method: "capture one snapshot above the ceiling, replay compaction under each policy",
      why: "max_tokens feeds budgetTokens (tools.ts:9189) as well as requestedContextTokens "
        + "(tools.ts:9255). A capture at 120,000 selected 24 items where the product's 8,000 "
        + "selected 10, so the replay would have compared policies across different pipeline "
        + "states and violated the isolation it was chosen for.",
      measured: { wideBudgetSelected: 24, productBudgetSelected: 10 },
    },
    defectVerdict: verdict,
    cases: rows,
  }, null, 2)}\n`);

  writeFileSync(path.join(RESULTS, "stage5_m175_pathology_attribution.json"), `${JSON.stringify({
    schemaVersion: "stage5.m175.pathology-attribution.v1",
    workstream: "M175-B",
    ladder: {
      note:
        "Every rung of compactProductResponse, in the order it runs, and what it is permitted to "
        + "reduce. `request` appears at none of them — the only large field with no reduction at "
        + "any tier and, per M175-A, no product consumer.",
      rungs: [
        { rung: "applyProgressiveContextBudget", reduces: "productContext.modelVisibleContext", touchesRequest: false },
        { rung: "compactProductContextItems", reduces: "duplicated source bodies", touchesRequest: false },
        { rung: "compactCapsuleResult / compactLegacyContextSection", reduces: "compatibility representations", touchesRequest: false },
        { rung: "compactProductContextDiagnostics / compactDiagnostics", reduces: "verbose diagnostics", touchesRequest: false },
        { rung: "reduceDiagnosticsToAgentFacing", reduces: "machine-facing diagnostics (held for debug)", touchesRequest: false },
        { rung: "compactPivotNeighborhood / compactImpactSection", reduces: "neighbourhood and impact evidence", touchesRequest: false },
        { rung: "enforceTotalEnvelope", reduces: "tiered drops incl. duplicated_query_text and LAST_RESORT sections", touchesRequest: false },
        { rung: "compactMandatoryProductMetadata", reduces: "per-item metadata to a floor", touchesRequest: false },
        { rung: "compactNonessentialEnvelopeMetadata", reduces: "envelope metadata", touchesRequest: false },
        { rung: "degradeOversizedProductResponse", reduces: "THE EVIDENCE — items = [], deliveryFailed = true", touchesRequest: false },
      ],
      existingDeduplication: {
        at: "src/mcp/responseEnvelope.ts:1286-1309",
        field: "duplicated_query_text",
        rewrites: ["taskSummary.normalizedQuery", "taskSummary.query", "capsuleResult.query"],
        doesNotRewrite: ["request.query", "request.task"],
        note:
          "The envelope ALREADY deduplicates repeated task text, and already writes '@request.task' "
          + "as the reference. It exempts exactly the two largest copies.",
      },
      exemption: {
        at: "src/mcp/responseEnvelope.ts:1288-1292",
        text: "`request` echoes the caller's own input verbatim and is a correctness surface, so it is never rewritten.",
        assessment:
          "Sound for a field with a consumer. M175-A found zero product consumers of the shipped "
          + "block, and request.task identical to request.query in 199 of 199 captures.",
      },
    },
    cases: rows.map((row) => ({
      instanceId: row.instanceId,
      attribution: row.attribution,
      sufficiency: row.sufficiency,
    })),
  }, null, 2)}\n`);

  console.log("");
  console.log("wrote results/stage5_m175_pathology_reproduction.json");
  console.log("wrote results/stage5_m175_pathology_attribution.json");
  console.log("");
  console.log(`DEFECT VERDICT  ${verdict}`);
}

await main();
