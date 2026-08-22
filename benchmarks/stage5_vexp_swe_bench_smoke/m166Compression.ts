/**
 * M166-C — counterfactual model-facing representations.
 *
 * These are ANALYSIS variants, not product APIs (§33). None of them is implemented
 * as a responseV2 or a second renderer; each is a transformation applied offline to
 * a real captured payload so its token cost and its semantic losses can be measured
 * before anything is changed.
 *
 * Every variant is built from the frozen M166-B classification, so the saving a
 * variant reports is the saving its category removals actually produce — not a
 * prose rewrite whose gains would be unfalsifiable.
 */
import { ResponseCategory, decompose } from "./m166Taxonomy";

export const CompressionVariant = Object.freeze({
  /** The payload as the M164 agents received it. */
  FullCurrent: "FULL_CURRENT",
  /** Same JSON shape, with spans re-conveying a fact already present removed. */
  NoDuplicates: "NO_DUPLICATES",
  /** Also without scorer internals, counts, timings and budget arithmetic. */
  NoMachineDiagnostics: "NO_MACHINE_DIAGNOSTICS",
  /** Also with per-item and per-section provenance collapsed to one header. */
  CompactProvenance: "COMPACT_PROVENANCE",
  /** Evidence and control rendered as text: no JSON scaffolding at all. */
  AgentMinimalSafe: "AGENT_MINIMAL_SAFE",
  /** The canonical rendering alone — deliberately unsafe, as a floor. */
  EvidenceOnly: "EVIDENCE_ONLY",
});
export type CompressionVariant = (typeof CompressionVariant)[keyof typeof CompressionVariant];

/**
 * The facts a variant must not silently lose. Extracted mechanically from a payload
 * so that "preserved" is a comparison rather than an assertion.
 */
export interface RetainedFacts {
  readonly itemPaths: readonly string[];
  readonly symbols: readonly string[];
  readonly roles: readonly string[];
  readonly leadPivot: string | null;
  readonly sourceLines: number;
  readonly skeletonFacts: readonly string[];
  readonly impactFacts: readonly string[];
  readonly neighborhoodExcerpts: readonly string[];
  /** section -> DELIVERED | NOT_APPLICABLE | NO_RELEVANT_EVIDENCE | NOT_OBSERVED. */
  readonly componentStatuses: Readonly<Record<string, string>>;
  readonly freshnessStatus: string | null;
  readonly readinessReady: boolean | null;
  readonly degradedState: string | null;
  readonly absenceClaims: readonly string[];
  readonly authorityLimitations: readonly string[];
  readonly omissionDisclosures: readonly string[];
  readonly provenanceIdentifiers: readonly string[];
}

/**
 * Duplicate ACCOUNTING starts at 12 characters; duplicate REMOVAL starts here.
 *
 * A role label such as "documentation" appears both in the rendering and in an
 * item's `roles` array. The accounting is right to call the second occurrence a
 * restatement, but removing it deletes one of that item's role labels — support
 * stops being distinguishable from pivot. Only identity-bearing values (paths,
 * fully-qualified names, commits, the task text) are long enough to be removable.
 */
const MIN_REMOVABLE_DUPLICATE_CHARACTERS = 24;

const asRecord = (value: unknown): Record<string, any> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;

function componentStatus(included: unknown, skipReason: unknown): string {
  if (included === true) return "DELIVERED";
  if (typeof skipReason !== "string") return "NOT_OBSERVED";
  if (/not_requested|intent_deemphasized|no_session_requested/.test(skipReason)) return "NOT_APPLICABLE";
  if (/no_relevant|no_dependents/.test(skipReason)) return "NO_RELEVANT_EVIDENCE";
  if (/error/.test(skipReason)) return "FAILED";
  return "NOT_OBSERVED";
}

/** What a payload asserts, independent of how it is serialized. */
export function extractFacts(output: unknown): RetainedFacts {
  const root = asRecord(output) ?? {};
  const pc = asRecord(root.productContext) ?? {};
  const items = Array.isArray(pc.items) ? pc.items as Record<string, any>[] : [];
  const rendered = typeof pc.modelVisibleContext === "string" ? pc.modelVisibleContext : "";
  const neighborhood = Array.isArray(root.pivotNeighborhood) ? root.pivotNeighborhood as Record<string, any>[] : [];

  const provenance: string[] = [];
  const repository = asRecord(pc.repository) ?? {};
  for (const key of ["headCommit", "repositoryId", "worktreeId", "indexRunId", "branch", "indexMode"]) {
    if (typeof repository[key] === "string" || typeof repository[key] === "number") provenance.push(`repository.${key}=${repository[key]}`);
  }
  if (typeof pc.taskHash === "string") provenance.push(`taskHash=${pc.taskHash}`);
  if (typeof pc.selectedFileHash === "string") provenance.push(`selectedFileHash=${pc.selectedFileHash}`);
  const runtime = asRecord(root.runtime) ?? {};
  for (const key of ["commit", "retrievalRankingVersion", "retrievalImplementation", "indexSchemaVersion"]) {
    if (runtime[key] !== undefined && runtime[key] !== null) provenance.push(`runtime.${key}=${runtime[key]}`);
  }

  const freshness = asRecord(pc.freshness) ?? {};
  const indexFreshness = asRecord(asRecord(root.diagnostics)?.indexFreshness) ?? {};
  const readiness = asRecord(indexFreshness.readiness) ?? asRecord(asRecord(asRecord(root.diagnostics)?.freshness)?.readiness) ?? {};
  const coverage = asRecord(pc.coverage) ?? {};
  const budget = asRecord(root.responseBudget) ?? {};

  return {
    itemPaths: items.map((i) => String(i.path ?? "")).filter((v) => v.length > 0),
    symbols: items.map((i) => String(i.fqName ?? i.symbol ?? "")).filter((v) => v.length > 0),
    roles: items.flatMap((i) => (Array.isArray(i.roles) ? i.roles as string[] : [])),
    leadPivot: typeof pc.leadPivot === "string" ? pc.leadPivot : null,
    // The rendered evidence lines: what the agent can read as source.
    sourceLines: rendered.split("\n").filter((line) => line.trim().length > 0).length,
    skeletonFacts: items.filter((i) => i.contentMode === "skeleton" || i.contentMode === "signature")
      .map((i) => `${i.path}::${i.symbol}#${asRecord(i.lineSpan)?.start ?? "?"}-${asRecord(i.lineSpan)?.end ?? "?"}`),
    impactFacts: rendered.split("\n").filter((line) => /^(CONTAINS|CALLS|IMPORTS|EXTENDS|DEPENDS)/.test(line.trim())),
    neighborhoodExcerpts: neighborhood.flatMap((n) => (Array.isArray(n.excerpts) ? n.excerpts as Record<string, any>[] : []).map((e) => `${e.filePath}:${e.startLine}-${e.endLine}`)),
    componentStatuses: {
      impact: componentStatus(asRecord(root.impact)?.included, asRecord(root.impact)?.skipReason),
      flow: componentStatus(asRecord(root.flow)?.included, asRecord(root.flow)?.skipReason),
      memorySession: componentStatus(asRecord(asRecord(root.memory)?.session)?.included, asRecord(asRecord(root.memory)?.session)?.skipReason),
      memoryDurable: componentStatus(asRecord(asRecord(root.memory)?.durable)?.included, asRecord(asRecord(root.memory)?.durable)?.skipReason),
      memoryCapsuleSurfaced: componentStatus(asRecord(asRecord(root.memory)?.capsuleSurfaced)?.included, asRecord(asRecord(root.memory)?.capsuleSurfaced)?.skipReason),
      rules: componentStatus(asRecord(root.rules)?.included, null),
      context: componentStatus(asRecord(root.context)?.included, asRecord(root.context)?.skipReason),
    },
    freshnessStatus: typeof freshness.status === "string" ? freshness.status : (typeof indexFreshness.status === "string" ? indexFreshness.status : null),
    readinessReady: typeof readiness.ready === "boolean" ? readiness.ready : null,
    degradedState: typeof pc.resultState === "string" ? pc.resultState : null,
    absenceClaims: [
      typeof coverage.absenceClaim === "string" ? `coverage.absenceClaim=${coverage.absenceClaim}` : null,
      typeof coverage.enumerationComplete === "boolean" ? `coverage.enumerationComplete=${coverage.enumerationComplete}` : null,
      typeof coverage.mode === "string" ? `coverage.mode=${coverage.mode}` : null,
    ].filter((v): v is string => v !== null),
    authorityLimitations: [
      ...(Array.isArray(asRecord(pc.diagnostics)?.limitations) ? asRecord(pc.diagnostics)!.limitations as string[] : []),
      ...(asRecord(pc.diagnostics)?.staticEvidenceOnly === true ? ["staticEvidenceOnly"] : []),
      ...(typeof asRecord(pc.accounting)?.claimBoundary === "string" ? [asRecord(pc.accounting)!.claimBoundary as string] : []),
      ...(Array.isArray(asRecord(root.capsuleResult)?.warnings) ? asRecord(root.capsuleResult)!.warnings as string[] : []),
    ],
    omissionDisclosures: [
      ...(Array.isArray(budget.compacted_fields) ? budget.compacted_fields as string[] : []),
      ...Object.keys(asRecord(budget.omitted_detail_counts) ?? {}),
      ...(Array.isArray(asRecord(root.deferred)?.items) ? (asRecord(root.deferred)!.items as Record<string, any>[]).map((i) => String(i.kind)) : []),
    ],
    provenanceIdentifiers: provenance,
  };
}

export interface VariantResult {
  readonly variant: CompressionVariant;
  readonly modelFacingCharacters: number;
  /** Exactly what the model would read. Evidence preservation is checked against this. */
  readonly modelFacingText: string;
  readonly retained: RetainedFacts;
  /** How the variant was built, so a reader can reproduce it. */
  readonly construction: string;
}

/**
 * Deep-prune a payload to the leaves whose classification is in `keep`.
 *
 * Duplicate ACCOUNTING and duplicate REMOVAL are not the same operation, and this
 * function is where the difference bites. `memory.durable.skipReason` and
 * `memory.capsuleSurfaced.skipReason` can carry the identical string
 * "no_relevant_observations": that is the same reason holding independently for two
 * components, not one fact restated. Dropping the second collapses
 * NO_RELEVANT_EVIDENCE into NOT_OBSERVED and turns a bounded absence into an
 * unobserved one — the §38 failure exactly. Control leaves are therefore never
 * removed as duplicates, however many tokens the accounting charges them.
 */
function prune(output: unknown, keep: ReadonlySet<ResponseCategory>, dropDuplicates: boolean): unknown {
  const decomposition = decompose(output);
  const decisionByPath = new Map<string, boolean>();
  for (const leaf of decomposition.leaves) {
    const isDuplicate = removableAsDuplicate(leaf);
    decisionByPath.set(leaf.path, (!dropDuplicates || !isDuplicate) && keep.has(leaf.baseCategory));
  }
  const walk = (node: unknown, nodePath: string): unknown => {
    if (Array.isArray(node)) {
      const kept = node.map((child, i) => walk(child, `${nodePath}[${i}]`)).filter((v) => v !== undefined);
      return kept.length === 0 ? undefined : kept;
    }
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        const childPath = nodePath === "" ? key : `${nodePath}.${key}`;
        const value = walk(child, childPath);
        if (value !== undefined) out[key] = value;
      }
      return Object.keys(out).length === 0 ? undefined : out;
    }
    return decisionByPath.get(nodePath) === true ? node : undefined;
  };
  return walk(output, "") ?? {};
}

/** Render retained leaves as `path: value` lines — no JSON scaffolding. */
function renderAsLines(output: unknown, keep: ReadonlySet<ResponseCategory>): string {
  const decomposition = decompose(output);
  const lines: string[] = [];
  for (const leaf of decomposition.leaves) {
    if (removableAsDuplicate(leaf)) continue;
    if (!keep.has(leaf.baseCategory)) continue;
    if (leaf.normalizedPath === "productContext.modelVisibleContext") continue;
    const value = leafValue(output, leaf.path);
    if (value === undefined) continue;
    lines.push(`${leaf.path}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  return lines.join("\n");
}

/** Wholly a restatement, long enough to be an identity, and not per-component semantics. */
function removableAsDuplicate(leaf: { duplicateCharacters: number; characters: number; baseCategory: ResponseCategory }): boolean {
  return leaf.duplicateCharacters >= leaf.characters
    && leaf.characters >= MIN_REMOVABLE_DUPLICATE_CHARACTERS
    && leaf.baseCategory !== ResponseCategory.AgentUsefulControl;
}

function leafValue(output: unknown, leafPath: string): unknown {
  let node: any = output;
  for (const segment of leafPath.split(".")) {
    const match = /^([^\[]*)((\[\d+\])*)$/.exec(segment);
    if (match === null) return undefined;
    if (match[1] !== "") node = node?.[match[1]!];
    for (const index of (match[2] ?? "").matchAll(/\[(\d+)\]/g)) node = node?.[Number(index[1])];
    if (node === undefined) return undefined;
  }
  return node;
}

const EVIDENCE_AND_CONTROL: ReadonlySet<ResponseCategory> = new Set([ResponseCategory.RepositoryEvidence, ResponseCategory.AgentUsefulControl]);

/** One compact provenance line rather than the same identity repeated per item. */
function provenanceHeader(facts: RetainedFacts): string {
  return facts.provenanceIdentifiers.length === 0 ? "" : `provenance: ${facts.provenanceIdentifiers.join(" ")}`;
}

export function buildVariant(output: unknown, variant: CompressionVariant): VariantResult {
  const canonical = (asRecord(asRecord(output)?.productContext)?.modelVisibleContext ?? "") as string;
  const measure = (text: string, retainedFrom: unknown, construction: string): VariantResult => ({
    variant,
    modelFacingCharacters: text.length,
    modelFacingText: text,
    retained: extractFacts(retainedFrom),
    construction,
  });

  switch (variant) {
    case CompressionVariant.FullCurrent:
      return measure(JSON.stringify(output), output, "the payload as delivered");

    case CompressionVariant.NoDuplicates: {
      const pruned = prune(output, new Set(Object.values(ResponseCategory)), true);
      return measure(JSON.stringify(pruned), pruned, "same JSON shape, spans classified DUPLICATE removed");
    }
    case CompressionVariant.NoMachineDiagnostics: {
      const keep = new Set([ResponseCategory.RepositoryEvidence, ResponseCategory.AgentUsefulControl, ResponseCategory.Provenance, ResponseCategory.Other]);
      const pruned = prune(output, keep, true);
      return measure(JSON.stringify(pruned), pruned, "NO_DUPLICATES, then leaves classified MACHINE_DIAGNOSTIC removed");
    }
    case CompressionVariant.CompactProvenance: {
      const pruned = prune(output, EVIDENCE_AND_CONTROL, true) as Record<string, any>;
      const facts = extractFacts(output);
      const withHeader = { ...pruned, provenance: facts.provenanceIdentifiers };
      return measure(JSON.stringify(withHeader), withHeader, "NO_MACHINE_DIAGNOSTICS, then per-item and per-section provenance collapsed into one response-level list");
    }
    case CompressionVariant.AgentMinimalSafe: {
      const facts = extractFacts(output);
      const control = renderAsLines(output, EVIDENCE_AND_CONTROL);
      const text = [canonical, provenanceHeader(facts), control].filter((part) => part.length > 0).join("\n");
      // Facts are read from the ORIGINAL, but only those the text still carries.
      const pruned = prune(output, EVIDENCE_AND_CONTROL, true);
      return measure(text, pruned, "canonical rendering, one provenance line, and every retained evidence/control leaf as a `path: value` line — no JSON scaffolding");
    }
    case CompressionVariant.EvidenceOnly:
      return measure(canonical, { productContext: { modelVisibleContext: canonical, items: [], coverage: {}, diagnostics: {} } }, "the canonical rendering alone; deliberately unsafe, included as a floor");
  }
}

export interface SafetyFinding { readonly check: string; readonly passed: boolean; readonly detail: string }

/**
 * §36/§37/§38. A variant fails if removing something could let a bounded result read
 * as an authoritative one. Each check compares the variant's facts to the full ones.
 */
export function epistemicSafety(full: RetainedFacts, variant: RetainedFacts): readonly SafetyFinding[] {
  const missingStatuses = Object.entries(full.componentStatuses)
    .filter(([section, status]) => variant.componentStatuses[section] !== status);
  // Compare as sets: these lists legitimately repeat a value, and a count-based
  // check would report "17/17 retained" on a variant that dropped a distinct one.
  const missing = (required: readonly string[], present: readonly string[]): string[] => {
    const have = new Set(present);
    return [...new Set(required)].filter((value) => !have.has(value));
  };
  const missingAbsence = missing(full.absenceClaims, variant.absenceClaims);
  const missingLimitations = missing(full.authorityLimitations, variant.authorityLimitations);
  const missingOmissions = missing(full.omissionDisclosures, variant.omissionDisclosures);
  return [
    {
      check: "component statuses distinguishable (not_applicable vs no_relevant_evidence vs not_observed)",
      passed: missingStatuses.length === 0,
      detail: missingStatuses.length === 0 ? "all component statuses preserved" : `changed: ${missingStatuses.map(([s, v]) => `${s} ${v}->${variant.componentStatuses[s]}`).join(", ")}`,
    },
    {
      check: "readiness truth retained (ready vs degraded vs stale)",
      passed: variant.freshnessStatus === full.freshnessStatus && variant.readinessReady === full.readinessReady,
      detail: `freshness ${full.freshnessStatus}->${variant.freshnessStatus}, ready ${full.readinessReady}->${variant.readinessReady}`,
    },
    {
      check: "degraded/result state retained",
      passed: variant.degradedState === full.degradedState,
      detail: `${full.degradedState}->${variant.degradedState}`,
    },
    {
      check: "absence semantics retained (bounded absence must not read as authoritative absence)",
      passed: missingAbsence.length === 0,
      detail: missingAbsence.length === 0 ? "all absence claims retained" : `missing: ${missingAbsence.join(", ")}`,
    },
    {
      check: "authority limitations retained (support must not read as ownership, static must not read as dynamic)",
      passed: missingLimitations.length === 0,
      detail: missingLimitations.length === 0 ? "all limitations retained" : `missing: ${missingLimitations.join(" | ")}`,
    },
    {
      check: "material omission disclosed (partial coverage must not read as complete)",
      passed: missingOmissions.length === 0,
      detail: missingOmissions.length === 0 ? "all omission disclosures retained" : `missing: ${missingOmissions.join(", ")}`,
    },
    {
      check: "roles retained (support must remain distinguishable from pivot)",
      passed: new Set(full.roles).size === new Set(variant.roles).size,
      detail: `${new Set(variant.roles).size}/${new Set(full.roles).size} distinct roles`,
    },
  ];
}

export interface PreservationFinding { readonly dimension: string; readonly preserved: boolean; readonly detail: string }

/** §34. Content preservation, separate from epistemic safety. */
export function semanticPreservation(full: RetainedFacts, variant: RetainedFacts, modelFacingText: string): readonly PreservationFinding[] {
  const contains = (values: readonly string[]): number => values.filter((value) => value.length > 0 && modelFacingText.includes(value)).length;
  return [
    // The lead pivot may legitimately live only in the rendering: a variant that
    // drops the structured restatement has not lost the fact, and the model reads
    // text, so the check is containment rather than field survival.
    {
      dimension: "primary context",
      preserved: variant.leadPivot === full.leadPivot || (full.leadPivot !== null && modelFacingText.includes(full.leadPivot)),
      detail: `${full.leadPivot} -> ${variant.leadPivot ?? "(in rendering only)"}`,
    },
    { dimension: "item paths", preserved: contains(full.itemPaths) === full.itemPaths.length, detail: `${contains(full.itemPaths)}/${full.itemPaths.length} present in the model-facing text` },
    { dimension: "symbols", preserved: contains(full.symbols) === full.symbols.length, detail: `${contains(full.symbols)}/${full.symbols.length}` },
    { dimension: "roles", preserved: new Set(variant.roles).size === new Set(full.roles).size, detail: `${new Set(variant.roles).size}/${new Set(full.roles).size} distinct` },
    { dimension: "source text", preserved: variant.sourceLines >= full.sourceLines, detail: `${variant.sourceLines}/${full.sourceLines} rendered lines` },
    { dimension: "impact evidence", preserved: contains(full.impactFacts) === full.impactFacts.length, detail: `${contains(full.impactFacts)}/${full.impactFacts.length} relation lines` },
    { dimension: "skeletons", preserved: variant.skeletonFacts.length >= full.skeletonFacts.length, detail: `${variant.skeletonFacts.length}/${full.skeletonFacts.length}` },
    { dimension: "neighborhood excerpts", preserved: variant.neighborhoodExcerpts.length >= full.neighborhoodExcerpts.length, detail: `${variant.neighborhoodExcerpts.length}/${full.neighborhoodExcerpts.length}` },
    { dimension: "memory and flow statuses", preserved: variant.componentStatuses.memoryDurable === full.componentStatuses.memoryDurable && variant.componentStatuses.flow === full.componentStatuses.flow, detail: `memory ${variant.componentStatuses.memoryDurable}, flow ${variant.componentStatuses.flow}` },
    { dimension: "provenance for external consumers", preserved: full.provenanceIdentifiers.every((id) => modelFacingText.includes(id.split("=")[1] ?? id)), detail: `${full.provenanceIdentifiers.filter((id) => modelFacingText.includes(id.split("=")[1] ?? id)).length}/${full.provenanceIdentifiers.length} identifiers still resolvable from the model-facing text` },
  ];
}
