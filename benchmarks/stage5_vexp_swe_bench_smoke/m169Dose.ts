/**
 * M169-D — evidence-retention semantics for a reduced evidence dose.
 *
 * What "smaller" costs is a token question and M166 already answered how to
 * measure it. What "smaller" LOSES is a semantic question, and this module owns
 * exactly that: given the response at the current default and the response at a
 * reduced budget, which of five outcomes occurred.
 *
 * Two rules are load-bearing and neither is negotiable:
 *
 *   §28  truthfulness fields are not expendable evidence. A rung that sheds
 *        readiness, absence, provenance or component status is TRUTHFULNESS_LOSS
 *        and is never scored as an improvement for being cheaper.
 *   §30  the current output is not automatically the gold standard. Material
 *        removed at a lower rung is separately judged USEFUL_DISTINCT,
 *        REDUNDANT, LOW_VALUE_SUPPORT or UNKNOWN, so that dropping a restatement
 *        is not counted as losing a fact.
 *
 * PURE.
 */

export const RetentionClass = Object.freeze({
  Equivalent: "SEMANTICALLY_EQUIVALENT",
  PrimaryPreserved: "PRIMARY_EVIDENCE_PRESERVED",
  SupportLoss: "MATERIAL_SUPPORT_LOSS",
  PrimaryLoss: "MATERIAL_PRIMARY_LOSS",
  TruthfulnessLoss: "TRUTHFULNESS_LOSS",
  NotComparable: "NOT_COMPARABLE",
});
export type RetentionClass = (typeof RetentionClass)[keyof typeof RetentionClass];

export const RemovedMaterialClass = Object.freeze({
  UsefulDistinct: "USEFUL_DISTINCT",
  Redundant: "REDUNDANT",
  LowValueSupport: "LOW_VALUE_SUPPORT",
  Unknown: "UNKNOWN",
});
export type RemovedMaterialClass = (typeof RemovedMaterialClass)[keyof typeof RemovedMaterialClass];

/**
 * The semantic surface of one delivered response.
 *
 * Deliberately NOT the whole payload: two responses that differ only in a
 * latency figure are the same delivery, and a comparison that called them
 * different would report churn as loss.
 */
export interface DeliverySurface {
  readonly parseStatus: "PARSED" | "PARSE_FAILURE" | "NO_OUTPUT_FIELD" | "TOOL_ERROR";
  readonly serializedCharacters: number;
  readonly resultState: string | null;
  readonly leadPivot: string | null;
  readonly pivotPaths: readonly string[];
  readonly supportPaths: readonly string[];
  readonly itemFqNames: readonly string[];
  readonly modelVisibleContextCharacters: number;
  readonly pivotNeighborhoodExcerpts: number;
  readonly impactIncluded: boolean;
  readonly flowIncluded: boolean;
  readonly memoryIncluded: boolean;
  /** §28 — the fields whose absence is a truthfulness loss, not a saving. */
  readonly truthfulness: Readonly<Record<string, boolean>>;
  readonly componentStatuses: Readonly<Record<string, string | null>>;
  readonly withinEnvelope: boolean | null;
  readonly compactionApplied: boolean | null;
  readonly compactedFields: readonly string[];
}

const TRUTHFULNESS_KEYS: readonly string[] = Object.freeze([
  "resultState", "retrievalFound", "resolved", "deliveryFailed",
  "coverage", "freshness", "deliveryStatus", "claimBoundary",
  "workspaceRoutingOutcome", "responseBudget", "schemaVersion",
]);

export function readSurface(toolResultText: string): DeliverySurface {
  const empty = (parseStatus: DeliverySurface["parseStatus"]): DeliverySurface => ({
    parseStatus,
    serializedCharacters: toolResultText.length,
    resultState: null, leadPivot: null, pivotPaths: [], supportPaths: [], itemFqNames: [],
    modelVisibleContextCharacters: 0, pivotNeighborhoodExcerpts: 0,
    impactIncluded: false, flowIncluded: false, memoryIncluded: false,
    truthfulness: Object.freeze(Object.fromEntries(TRUTHFULNESS_KEYS.map((k) => [k, false]))),
    componentStatuses: Object.freeze({}), withinEnvelope: null, compactionApplied: null, compactedFields: [],
  });

  let envelope: Record<string, any>;
  try { envelope = JSON.parse(toolResultText) as Record<string, any>; } catch { return empty("PARSE_FAILURE"); }
  if (envelope?.result?.ok === false) return empty("TOOL_ERROR");
  const output = envelope?.result?.output;
  if (output === null || output === undefined) return empty("NO_OUTPUT_FIELD");

  const productContext = (output.productContext ?? {}) as Record<string, any>;
  const items = (productContext.items ?? []) as Record<string, any>[];
  const roleOf = (item: Record<string, any>): string[] => (item.roles ?? []) as string[];
  const present = (value: unknown): boolean => value !== undefined && value !== null;

  return {
    parseStatus: "PARSED",
    serializedCharacters: toolResultText.length,
    resultState: productContext.resultState ?? null,
    leadPivot: productContext.leadPivot ?? null,
    pivotPaths: Object.freeze([...new Set(items.filter((i) => roleOf(i).includes("pivot")).map((i) => String(i.path)))]),
    supportPaths: Object.freeze([...new Set(items.filter((i) => !roleOf(i).includes("pivot")).map((i) => String(i.path)))]),
    itemFqNames: Object.freeze(items.map((i) => String(i.fqName ?? i.path ?? ""))),
    modelVisibleContextCharacters: String(productContext.modelVisibleContext ?? "").length,
    pivotNeighborhoodExcerpts: ((output.pivotNeighborhood ?? []) as Record<string, any>[])
      .reduce((sum, entry) => sum + ((entry.excerpts ?? []) as unknown[]).length, 0),
    impactIncluded: output.impact?.included === true,
    flowIncluded: output.flow?.included === true,
    memoryIncluded: output.memory?.session?.included === true || output.memory?.durable?.included === true,
    truthfulness: Object.freeze({
      resultState: present(productContext.resultState),
      retrievalFound: present(productContext.retrievalFound),
      resolved: present(productContext.resolved),
      deliveryFailed: present(productContext.deliveryFailed),
      coverage: present(productContext.coverage),
      freshness: present(productContext.freshness) || present(output.diagnostics?.freshness),
      deliveryStatus: present(productContext.delivery?.status),
      claimBoundary: present(productContext.accounting?.claimBoundary),
      workspaceRoutingOutcome: present(output.workspaceRouting?.outcome),
      responseBudget: present(output.responseBudget),
      schemaVersion: present(output.schemaVersion),
    }),
    componentStatuses: Object.freeze({
      impact: output.impact?.skipReason ?? (output.impact?.included === true ? "included" : null),
      flow: output.flow?.skipReason ?? (output.flow?.included === true ? "included" : null),
      memorySession: output.memory?.session?.skipReason ?? (output.memory?.session?.included === true ? "included" : null),
      rules: output.rules?.included === true ? "included" : null,
    }),
    withinEnvelope: output.responseBudget?.within_envelope ?? null,
    compactionApplied: output.responseBudget?.compaction_applied ?? null,
    compactedFields: Object.freeze([...((output.responseBudget?.compacted_fields ?? []) as string[])]),
  };
}

export interface RetentionVerdict {
  readonly retention: RetentionClass;
  readonly lostPivotPaths: readonly string[];
  readonly lostSupportPaths: readonly string[];
  readonly lostTruthfulnessFields: readonly string[];
  readonly leadPivotChanged: boolean;
  readonly modelVisibleContextDeltaCharacters: number;
  readonly notes: readonly string[];
}

/**
 * Compare a reduced rung against the reference rung.
 *
 * Order is a claim, not a convenience: truthfulness first (a rung that lies more
 * cheaply is not a cheaper rung), then primary evidence, then support, and only
 * a delivery identical on all three is called equivalent.
 */
export function classifyRetention(reference: DeliverySurface, reduced: DeliverySurface): RetentionVerdict {
  const notes: string[] = [];
  if (reference.parseStatus !== "PARSED" || reduced.parseStatus !== "PARSED") {
    // §72 — a parse failure is a parse failure, never an absence.
    return {
      retention: RetentionClass.NotComparable,
      lostPivotPaths: [], lostSupportPaths: [], lostTruthfulnessFields: [],
      leadPivotChanged: false, modelVisibleContextDeltaCharacters: 0,
      notes: [`reference=${reference.parseStatus} reduced=${reduced.parseStatus}`],
    };
  }

  const lostTruthfulness = Object.entries(reference.truthfulness)
    .filter(([key, wasPresent]) => wasPresent && reduced.truthfulness[key] !== true)
    .map(([key]) => key);
  const lostPivots = reference.pivotPaths.filter((p) => !reduced.pivotPaths.includes(p));
  const lostSupport = reference.supportPaths.filter((p) => !reduced.supportPaths.includes(p));
  const leadChanged = reference.leadPivot !== reduced.leadPivot;
  const contextDelta = reduced.modelVisibleContextCharacters - reference.modelVisibleContextCharacters;

  if (reduced.componentStatuses.impact !== reference.componentStatuses.impact) {
    notes.push(`impact status ${reference.componentStatuses.impact} -> ${reduced.componentStatuses.impact}`);
  }

  let retention: RetentionClass;
  if (lostTruthfulness.length > 0) retention = RetentionClass.TruthfulnessLoss;
  else if (lostPivots.length > 0 || leadChanged) retention = RetentionClass.PrimaryLoss;
  else if (lostSupport.length > 0) retention = RetentionClass.SupportLoss;
  else if (contextDelta === 0 && reference.itemFqNames.join("|") === reduced.itemFqNames.join("|")) {
    retention = RetentionClass.Equivalent;
  } else retention = RetentionClass.PrimaryPreserved;

  return {
    retention,
    lostPivotPaths: Object.freeze(lostPivots),
    lostSupportPaths: Object.freeze(lostSupport),
    lostTruthfulnessFields: Object.freeze(lostTruthfulness),
    leadPivotChanged: leadChanged,
    modelVisibleContextDeltaCharacters: contextDelta,
    notes: Object.freeze(notes),
  };
}

/**
 * Judge what a lower rung removed, so that shedding a restatement is not scored
 * as losing a fact (§30).
 *
 * `distinctFactPaths` are the file paths whose evidence appears nowhere else in
 * the reduced response. A removed path still named by the surviving rendering is
 * REDUNDANT; a removed support path that was never named anywhere is
 * LOW_VALUE_SUPPORT; a removed pivot is USEFUL_DISTINCT by construction.
 */
export function classifyRemovedMaterial(
  removedPath: string,
  wasPivot: boolean,
  survivingRenderedText: string,
): RemovedMaterialClass {
  if (wasPivot) return RemovedMaterialClass.UsefulDistinct;
  if (removedPath === "") return RemovedMaterialClass.Unknown;
  if (survivingRenderedText.includes(removedPath)) return RemovedMaterialClass.Redundant;
  return RemovedMaterialClass.LowValueSupport;
}

/**
 * The ladder frozen in the M169 plan before any dose result existed (§24).
 *
 * The plan named `capsule_budget_tokens` as the knob. An identity control found
 * that wrong on contact and the correction is recorded rather than quietly
 * applied: `capsule_budget_tokens: 8000` does NOT reproduce the default call,
 * because it also raises the v1 capsule's character budget from its own default
 * of 2000 to 32000 — the product ships two different default budgets for one
 * response and no argument sets both to their defaults. `max_tokens` is the
 * argument the schema documents as the caller's model-visible context budget,
 * and it moves both consistently.
 *
 * The reference rung is therefore the call the live agent actually made: NO
 * budget argument at all.
 */
export const BUDGET_LADDER: readonly number[] = Object.freeze([8_000, 6_000, 4_000, 2_640, 2_000]);
export const REFERENCE_BUDGET = 8_000;

/** The no-argument call. The rung every other rung is compared against. */
export const DEFAULT_RUNG = "DEFAULT" as const;
export type Rung = typeof DEFAULT_RUNG | number;
export const RUNG_LADDER: readonly Rung[] = Object.freeze([DEFAULT_RUNG, ...BUDGET_LADDER]);

/**
 * Fields that differ between two byte-identical requests: clocks, and the byte
 * counts that quote them. A comparison that read these as change would report
 * measurement noise as evidence loss.
 */
export const NONDETERMINISTIC_PATHS: readonly string[] = Object.freeze([
  "requestId",
  "result.output.productContext.timing",
  "result.output.accounting.latencyMs",
  "result.output.responseBudget.estimated_metadata_tokens",
  "result.output.responseBudget.estimated_total_response_tokens",
  "result.output.responseBudget.serialized_response_characters",
]);
