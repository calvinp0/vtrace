/**
 * M171-A — what the model is actually handed, decomposed by SEMANTIC FACT.
 *
 * M166 answered "how many characters, in what category". That is a necessary
 * decomposition and this module reuses it. It is not a sufficient one for M171,
 * because the question M171 asks is not "which bytes are cheap to remove" but
 * "which FACTS does the agent need, and how many times is it currently told
 * each of them".
 *
 * The permanent M166/M167 rule governs the method here:
 *
 *     duplicate accounting  !=  semantic duplicate
 *
 * so nothing in this file dedupes by string equality. A fact is registered by a
 * NAMED EXTRACTOR that knows what the value means; a surface is a JSON path at
 * which that extractor found the fact asserted. Two spans are the same fact only
 * when the same extractor claims both. That makes the repetition count arguable
 * — an extractor can be wrong — rather than an artefact of two fields happening
 * to hold the same string.
 *
 * PURE. No I/O, no product imports.
 */

// ---- model-token authority (§64) ----------------------------------

/**
 * M166's measured calibration, regressed on provider-reported cache-creation
 * across 363 samples (r^2 = 0.926). The product's own `chars/4` estimate
 * understates a dense JSON payload by 1.27x, so it is never used for a claim.
 *
 * The per-request fixed term is deliberately NOT applied to a payload: it is the
 * cost of issuing a request at all, not of carrying this response. M169's
 * `attributePayload` made the same choice; matching it is what allows an M171
 * figure to be compared with an M169 figure.
 */
export const M166_CALIBRATION = Object.freeze({
  resultTokensPerCharacter: 0.3174032272551657,
  resultCharactersPerToken: 3.1505665794509503,
  samples: 363,
  rSquared: 0.9263011489720135,
  authority: "DERIVED_FROM_PROVIDER_REPORTED" as const,
  source: "stage5_m166_token_authority.json",
});

/** M169's own pricing basis, so an M171 dollar can be compared with an M169 dollar. */
export const M169_PRICING = Object.freeze({
  cacheWrite1hPerMTok: 10,
  cacheReadPerMTok: 0.5,
  source: "OPUS_4_5_PRICING in m169Economics.ts",
});

export function modelVisibleTokens(characters: number): number {
  return Math.max(0, Math.round(characters * M166_CALIBRATION.resultTokensPerCharacter));
}

/**
 * What one payload costs over its whole life in a conversation: written into the
 * cache once, then re-read by every request that follows it.
 *
 * `amplificationRequests` is a property of the RUN, not of the payload, so it is
 * supplied by the caller from the M169 ledger rather than invented here.
 */
export function projectedAttributableCostUsd(tokens: number, amplificationRequests: number): number {
  return (
    (tokens * M169_PRICING.cacheWrite1hPerMTok) / 1_000_000
    + (tokens * Math.max(0, amplificationRequests) * M169_PRICING.cacheReadPerMTok) / 1_000_000
  );
}

// ---- the semantic fact graph (§28) --------------------------------

/**
 * What KIND of thing a fact is. The classification exists because the disclosure
 * decision differs by kind, not by field: an epistemic qualifier cannot be
 * evicted for being large, and a provenance hash cannot be retained for being
 * small.
 */
export const FactKind = Object.freeze({
  /** The task string, the intent, the request parameters echoed back. */
  Restatement: "RESTATEMENT",
  /** A repository location: path, symbol, fq name, line span. */
  Identity: "IDENTITY",
  /** Source text, signature or skeleton for a location. */
  Source: "SOURCE",
  /** Why a location was selected, or what role it plays. */
  Role: "ROLE",
  /** A typed relationship between two locations. */
  Relationship: "RELATIONSHIP",
  /** Whether a component ran, and why it did not. */
  ComponentStatus: "COMPONENT_STATUS",
  /** A claim boundary, absence semantics, coverage or readiness statement. */
  Epistemic: "EPISTEMIC",
  /** Index/workspace/runtime identity, hashes, versions. */
  Provenance: "PROVENANCE",
  /** Counts, timings, budget bookkeeping, token estimates. */
  Accounting: "ACCOUNTING",
  /** A pointer to a further tool call. */
  Deferral: "DEFERRAL",
});
export type FactKind = (typeof FactKind)[keyof typeof FactKind];

export interface SemanticFact {
  readonly kind: FactKind;
  /** Stable within one response; the thing the fact is ABOUT. */
  readonly identity: string;
  /** The asserted value, normalized for comparison. */
  readonly value: string;
  /** Every JSON path at which this response asserts it. */
  readonly surfaces: readonly string[];
  /** Characters the response spends asserting it, summed over surfaces. */
  readonly characters: number;
}

interface Sighting {
  readonly kind: FactKind;
  readonly identity: string;
  readonly value: string;
  readonly surface: string;
  readonly characters: number;
}

const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value));
const chars = (value: unknown): number => (value === undefined ? 0 : JSON.stringify(value ?? null).length);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asArray = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

/**
 * Locate every `## [id] fqName` heading and `why:` line inside the rendered
 * context, so that the canonical rendering is counted as a SURFACE of the same
 * facts the structured fields carry — not as a separate opaque blob.
 */
function renderedSurfaces(rendered: string): { readonly headings: readonly string[]; readonly whys: readonly string[] } {
  const headings: string[] = [];
  const whys: string[] = [];
  for (const line of rendered.split("\n")) {
    const heading = /^##\s+\[[^\]]+\]\s+(.+)$/.exec(line);
    if (heading !== null) headings.push(heading[1]!.trim());
    if (line.startsWith("why: ")) whys.push(line.slice(5).trim());
  }
  return { headings, whys };
}

/**
 * Every named extractor. Order is irrelevant; each declares the paths it owns.
 *
 * An extractor that finds nothing contributes nothing — absence of a fact here
 * is absence of an ASSERTION in this response, never a claim about the repository.
 */
export function extractFacts(output: Record<string, unknown>): readonly SemanticFact[] {
  const sightings: Sighting[] = [];
  const see = (kind: FactKind, identity: string, value: string, surface: string, characters: number): void => {
    if (value === "") return;
    sightings.push({ kind, identity, value, surface, characters });
  };

  const productContext = isRecord(output.productContext) ? output.productContext : {};
  const capsuleResult = isRecord(output.capsuleResult) ? output.capsuleResult : {};
  const request = isRecord(output.request) ? output.request : {};
  const taskSummary = isRecord(output.taskSummary) ? output.taskSummary : {};
  const intent = isRecord(output.intent) ? output.intent : {};
  const context = isRecord(output.context) ? output.context : {};
  const rendered = text(productContext.modelVisibleContext);
  const renderedParts = renderedSurfaces(rendered);

  // ---- restatement: the task, and the intent ------------------------------
  const task = text(productContext.task) || text(request.task);
  for (const [surface, value] of [
    ["request.query", request.query], ["request.task", request.task],
    ["taskSummary.query", taskSummary.query], ["taskSummary.normalizedQuery", taskSummary.normalizedQuery],
    ["capsuleResult.query", capsuleResult.query], ["productContext.task", productContext.task],
    ["context.query", context.query],
  ] as const) {
    if (text(value).trim().toLowerCase() === task.trim().toLowerCase()) {
      see(FactKind.Restatement, "task", task, surface, chars(value));
    }
  }
  for (const item of asArray((isRecord(output.deferred) ? output.deferred : {}).items)) {
    const suggested = isRecord(item.suggestedInput) ? item.suggestedInput : {};
    if (text(suggested.query).trim().toLowerCase() === task.trim().toLowerCase()) {
      see(FactKind.Restatement, "task", task, "deferred.items[].suggestedInput.query", chars(suggested.query));
    }
  }
  if (task !== "" && rendered.includes(task)) {
    see(FactKind.Restatement, "task", task, "productContext.modelVisibleContext", task.length);
  }

  const selectedIntent = text(intent.selectedIntent) || text(productContext.intent);
  for (const [surface, value] of [
    ["intent.selectedPreset", intent.selectedPreset], ["intent.selectedIntent", intent.selectedIntent],
    ["intent.selected", intent.selected], ["intent.mappedQueryIntent", intent.mappedQueryIntent],
    ["intent.resolvedIntent", intent.resolvedIntent], ["capsuleResult.intent", capsuleResult.intent],
    ["productContext.intent", productContext.intent],
  ] as const) {
    if (text(value) === selectedIntent) see(FactKind.Restatement, "intent", selectedIntent, surface, chars(value));
  }
  if (selectedIntent !== "" && new RegExp(`^intent: ${selectedIntent}$`, "m").test(rendered)) {
    see(FactKind.Restatement, "intent", selectedIntent, "productContext.modelVisibleContext", `intent: ${selectedIntent}`.length);
  }

  // ---- identity, source, role --------------------------------------------
  for (const item of asArray(productContext.items)) {
    const fqName = text(item.fqName);
    if (fqName === "") continue;
    see(FactKind.Identity, fqName, fqName, "productContext.items[].fqName", chars(item.fqName));
    see(FactKind.Identity, fqName, fqName, "productContext.items[].path+symbol", chars(item.path) + chars(item.symbol));
    const metadata = isRecord(item.metadata) ? item.metadata : {};
    if (text(metadata.fqName) === fqName) {
      see(FactKind.Identity, fqName, fqName, "productContext.items[].metadata.fqName", chars(metadata.fqName));
    }
    if (renderedParts.headings.includes(fqName)) {
      see(FactKind.Identity, fqName, fqName, "productContext.modelVisibleContext", fqName.length);
    }
    const span = isRecord(item.lineSpan) ? item.lineSpan : null;
    if (span !== null) {
      const value = `${text(span.start)}-${text(span.end)}`;
      see(FactKind.Identity, `${fqName}#lines`, value, "productContext.items[].lineSpan", chars(item.lineSpan));
      if (rendered.includes(`lines: ${value}`)) {
        see(FactKind.Identity, `${fqName}#lines`, value, "productContext.modelVisibleContext", `lines: ${value}`.length);
      }
    }
    const roles = Array.isArray(item.roles) ? item.roles.map(text).join(", ") : "";
    if (roles !== "") {
      see(FactKind.Role, `${fqName}#roles`, roles, "productContext.items[].roles", chars(item.roles));
      if (rendered.includes(`roles: ${roles}`)) {
        see(FactKind.Role, `${fqName}#roles`, roles, "productContext.modelVisibleContext", `roles: ${roles}`.length);
      }
    }
    for (const reason of Array.isArray(item.selectionReasons) ? item.selectionReasons.map(text) : []) {
      see(FactKind.Role, `${fqName}#why:${reason.slice(0, 40)}`, reason, "productContext.items[].selectionReasons[]", reason.length + 3);
      if (renderedParts.whys.includes(reason)) {
        see(FactKind.Role, `${fqName}#why:${reason.slice(0, 40)}`, reason, "productContext.modelVisibleContext", reason.length + 5);
      }
    }
    if (text(item.contentMode) !== "") {
      see(FactKind.Role, `${fqName}#contentMode`, text(item.contentMode), "productContext.items[].contentMode", chars(item.contentMode));
    }
  }

  // The capsuleResult / context aliases assert the same identities again.
  for (const [bucket, surfaceRoot] of [["pivots", "capsuleResult.pivots[]"], ["support", "capsuleResult.support[]"]] as const) {
    for (const entry of asArray(capsuleResult[bucket])) {
      const fqName = text(entry.fqName);
      if (fqName === "") continue;
      see(FactKind.Identity, fqName, fqName, `${surfaceRoot}.fqName`, chars(entry.fqName) + chars(entry.path) + chars(entry.symbol));
      const role = text(entry.role);
      if (role !== "") see(FactKind.Role, `${fqName}#roles`, role, `${surfaceRoot}.role`, chars(entry.role));
      if (text(entry.kind) !== "") see(FactKind.Role, `${fqName}#kind`, text(entry.kind), `${surfaceRoot}.kind`, chars(entry.kind));
    }
  }
  for (const [bucket, surfaceRoot] of [["pivots", "context.pivots[]"], ["supports", "context.supports[]"]] as const) {
    for (const entry of asArray(context[bucket])) {
      const fqName = text(entry.fqName);
      if (fqName === "") continue;
      see(FactKind.Identity, fqName, fqName, `${surfaceRoot}.fqName`, chars(entry.fqName) + chars(entry.filePath));
      if (text(entry.role) !== "") see(FactKind.Role, `${fqName}#roles`, text(entry.role), `${surfaceRoot}.role`, chars(entry.role));
    }
  }
  const leadPivot = text(productContext.leadPivot);
  if (leadPivot !== "") {
    see(FactKind.Identity, leadPivot, leadPivot, "productContext.leadPivot", chars(productContext.leadPivot));
  }
  const digest = text(capsuleResult.digest);
  if (digest !== "") {
    for (const item of asArray(productContext.items)) {
      const fqName = text(item.fqName);
      if (fqName !== "" && digest.includes(fqName)) {
        see(FactKind.Identity, fqName, fqName, "capsuleResult.digest", fqName.length);
      }
      for (const reason of Array.isArray(item.selectionReasons) ? item.selectionReasons.map(text) : []) {
        if (digest.includes(reason)) {
          see(FactKind.Role, `${fqName}#why:${reason.slice(0, 40)}`, reason, "capsuleResult.digest", reason.length + 10);
        }
      }
    }
  }

  // ---- source ------------------------------------------------------------
  for (const neighborhood of asArray(output.pivotNeighborhood)) {
    const pivot = isRecord(neighborhood.pivot) ? neighborhood.pivot : {};
    const pivotFq = text(pivot.fqName);
    if (pivotFq !== "") {
      see(FactKind.Identity, pivotFq, pivotFq, "pivotNeighborhood[].pivot", chars(neighborhood.pivot));
    }
    for (const excerpt of asArray(neighborhood.excerpts)) {
      const fqName = text(excerpt.fqName);
      if (fqName === "") continue;
      see(FactKind.Identity, fqName, fqName, "pivotNeighborhood[].excerpts[].fqName", chars(excerpt.fqName) + chars(excerpt.filePath) + chars(excerpt.symbol));
      see(FactKind.Source, `${fqName}#excerpt`, `${text(excerpt.startLine)}-${text(excerpt.endLine)}`, "pivotNeighborhood[].excerpts[]", chars(excerpt.text) || Number(excerpt.textCharacters ?? 0));
      see(FactKind.Relationship, `${pivotFq}->${fqName}`, text(excerpt.reason), "pivotNeighborhood[].excerpts[].reason", chars(excerpt.reason));
    }
    for (const skipped of asArray(neighborhood.skipped)) {
      see(FactKind.Epistemic, `neighborhood_skipped:${text(skipped.target)}`, text(skipped.reason), "pivotNeighborhood[].skipped[]", chars(skipped));
    }
  }
  // The rendered context carries the only actual source BODIES in the default response.
  for (const item of asArray(productContext.items)) {
    const fqName = text(item.fqName);
    const bodyCharacters = Number(item.contentCharacters ?? 0);
    if (fqName !== "" && bodyCharacters > 0) {
      see(FactKind.Source, `${fqName}#body`, text(item.contentHash) || "body", "productContext.modelVisibleContext", bodyCharacters);
    }
  }

  // ---- relationships and component status ---------------------------------
  const impact = isRecord(output.impact) ? output.impact : {};
  const flow = isRecord(output.flow) ? output.flow : {};
  const memory = isRecord(output.memory) ? output.memory : {};
  for (const [component, record] of [["impact", impact], ["flow", flow], ["context", context]] as const) {
    see(FactKind.ComponentStatus, component, `${text(record.included)}:${text(record.skipReason)}`, `${component}.included+skipReason`, chars(record.included) + chars(record.skipReason));
  }
  for (const key of ["session", "durable", "capsuleSurfaced"]) {
    const record = isRecord(memory[key]) ? (memory[key] as Record<string, unknown>) : {};
    see(FactKind.ComponentStatus, `memory.${key}`, `${text(record.included)}:${text(record.skipReason)}`, `memory.${key}.included+skipReason`, chars(record.included) + chars(record.skipReason));
  }
  see(FactKind.ComponentStatus, "impact#intent", text(intent.impactSkipReason), "intent.impactSkipReason", chars(intent.impactSkipReason));
  see(FactKind.ComponentStatus, "flow#intent", text(intent.flowSkipReason), "intent.flowSkipReason", chars(intent.flowSkipReason));
  for (const dependent of asArray(impact.topDependents)) {
    const fqName = text(dependent.fqName ?? dependent.symbol);
    see(FactKind.Relationship, `${text(impact.focalSymbol)}<-${fqName}`, text(dependent.relation ?? "dependent"), "impact.topDependents[]", chars(dependent));
  }

  // ---- epistemic ----------------------------------------------------------
  const coverage = isRecord(productContext.coverage) ? productContext.coverage : {};
  see(FactKind.Epistemic, "coverage.mode", text(coverage.mode), "productContext.coverage.mode", chars(coverage.mode));
  see(FactKind.Epistemic, "coverage.absenceClaim", text(coverage.absenceClaim), "productContext.coverage.absenceClaim", chars(coverage.absenceClaim));
  see(FactKind.Epistemic, "coverage.enumerationComplete", text(coverage.enumerationComplete), "productContext.coverage.enumerationComplete", chars(coverage.enumerationComplete));
  see(FactKind.Epistemic, "resultState", text(productContext.resultState), "productContext.resultState", chars(productContext.resultState));
  see(FactKind.Epistemic, "resolved", text(productContext.resolved), "productContext.resolved", chars(productContext.resolved));
  see(FactKind.Epistemic, "retrievalFound", text(productContext.retrievalFound), "productContext.retrievalFound", chars(productContext.retrievalFound));
  see(FactKind.Epistemic, "deliveryFailed", text(productContext.deliveryFailed), "productContext.deliveryFailed", chars(productContext.deliveryFailed));
  const productDiagnostics = isRecord(productContext.diagnostics) ? productContext.diagnostics : {};
  for (const limitation of Array.isArray(productDiagnostics.limitations) ? productDiagnostics.limitations.map(text) : []) {
    see(FactKind.Epistemic, `limitation:${limitation.slice(0, 30)}`, limitation, "productContext.diagnostics.limitations[]", limitation.length + 3);
    if (rendered.includes(limitation)) {
      see(FactKind.Epistemic, `limitation:${limitation.slice(0, 30)}`, limitation, "productContext.modelVisibleContext", limitation.length);
    }
  }
  const accountingRecord = isRecord(productContext.accounting) ? productContext.accounting : {};
  see(FactKind.Epistemic, "accounting.claimBoundary", text(accountingRecord.claimBoundary), "productContext.accounting.claimBoundary", chars(accountingRecord.claimBoundary));
  const freshness = isRecord(productContext.freshness) ? productContext.freshness : {};
  see(FactKind.Epistemic, "freshness", `${text(freshness.status)}:${text(freshness.reason)}`, "productContext.freshness", chars(freshness.status) + chars(freshness.reason));
  const diagnostics = isRecord(output.diagnostics) ? output.diagnostics : {};
  const diagFreshness = isRecord(diagnostics.freshness) ? diagnostics.freshness : {};
  const readiness = isRecord(diagFreshness.readiness) ? diagFreshness.readiness : {};
  see(FactKind.Epistemic, "readiness", `${text(readiness.ready)}:${text(readiness.state)}:${text(readiness.reason)}`, "diagnostics.freshness.readiness", chars(readiness));
  const indexFreshness = isRecord(diagnostics.indexFreshness) ? diagnostics.indexFreshness : {};
  see(FactKind.Epistemic, "freshness", `${text(indexFreshness.status)}:${text(indexFreshness.reason)}`, "diagnostics.indexFreshness", chars(indexFreshness));
  see(FactKind.Epistemic, "freshness#diagnostics", text(diagFreshness.state), "diagnostics.freshness.state+summary", chars(diagFreshness.state) + chars(diagFreshness.summary) + chars(diagFreshness.whyItMatters) + chars(diagFreshness.recommendedAction));
  const routing = isRecord(output.workspaceRouting) ? output.workspaceRouting : {};
  see(FactKind.Epistemic, "workspaceRouting", `${text(routing.outcome)}:${text(routing.reason)}`, "workspaceRouting", chars(routing.outcome) + chars(routing.reason) + chars(routing.routeSource));
  see(FactKind.Epistemic, "workspaceRouting#uniqueness", text(routing.uniquenessProven), "workspaceRouting.uniquenessProven", chars(routing.uniquenessProven));
  for (const warning of Array.isArray(capsuleResult.warnings) ? capsuleResult.warnings.map(text) : []) {
    see(FactKind.Epistemic, `warning:${warning}`, warning, "capsuleResult.warnings[]", warning.length + 3);
  }
  const delivery = isRecord(productContext.delivery) ? productContext.delivery : {};
  see(FactKind.Epistemic, "delivery.status", text(delivery.status), "productContext.delivery.status", chars(delivery.status));
  see(FactKind.Epistemic, "delivery.droppedForBudget", text(delivery.droppedForBudget), "productContext.delivery.droppedForBudget", chars(delivery.droppedForBudget));
  see(FactKind.Epistemic, "context.truncated", text(context.truncated), "context.truncated", chars(context.truncated));

  // ---- provenance, accounting, deferral -----------------------------------
  const runtime = isRecord(output.runtime) ? output.runtime : {};
  see(FactKind.Provenance, "runtime", JSON.stringify(runtime), "runtime", chars(runtime));
  see(FactKind.Provenance, "schemaVersion", text(output.schemaVersion), "schemaVersion", chars(output.schemaVersion));
  see(FactKind.Provenance, "capsuleManifestId", text(output.authoritativeCapsuleManifestId), "authoritativeCapsuleManifestId", chars(output.authoritativeCapsuleManifestId));
  if (text(context.capsuleManifestId) !== "") {
    see(FactKind.Provenance, "capsuleManifestId", text(context.capsuleManifestId), "context.capsuleManifestId", chars(context.capsuleManifestId));
  }
  see(FactKind.Provenance, "repository", JSON.stringify(productContext.repository ?? null), "productContext.repository", chars(productContext.repository));
  see(FactKind.Provenance, "taskHash", text(productContext.taskHash), "productContext.taskHash", chars(productContext.taskHash));
  see(FactKind.Provenance, "selectedFileHash", text(productContext.selectedFileHash), "productContext.selectedFileHash", chars(productContext.selectedFileHash));
  see(FactKind.Provenance, "capsule", JSON.stringify(output.capsule ?? null), "capsule", chars(output.capsule));
  for (const item of asArray(productContext.items)) {
    const fqName = text(item.fqName);
    if (fqName === "") continue;
    see(FactKind.Provenance, `${fqName}#ids`, `${text(item.stableId)}:${text(item.contentHash)}:${text(item.id)}`, "productContext.items[].stableId+contentHash+id", chars(item.stableId) + chars(item.contentHash) + chars(item.id));
  }
  see(FactKind.Accounting, "accounting", JSON.stringify(output.accounting ?? null), "accounting", chars(output.accounting));
  see(FactKind.Accounting, "productContext.accounting", "budget bookkeeping", "productContext.accounting", chars(productContext.accounting) - chars(accountingRecord.claimBoundary));
  see(FactKind.Accounting, "productContext.timing", "timings", "productContext.timing", chars(productContext.timing));
  see(FactKind.Accounting, "responseBudget", "envelope bookkeeping", "responseBudget", chars(output.responseBudget));
  see(FactKind.Accounting, "capsuleResult.diagnostics", "retrieval counters", "capsuleResult.diagnostics", chars(capsuleResult.diagnostics));
  see(FactKind.Accounting, "capsuleResult.budget", "capsule budget", "capsuleResult.budget+summary", chars(capsuleResult.budget) + chars(capsuleResult.summary));
  see(FactKind.Accounting, "productContext.roleCounts", "role counts", "productContext.roleCounts", chars(productContext.roleCounts));
  see(FactKind.Accounting, "productContext.delivery", "delivery counters", "productContext.delivery", chars(productContext.delivery) - chars(delivery.status));
  for (const item of asArray((isRecord(output.deferred) ? output.deferred : {}).items)) {
    see(FactKind.Deferral, text(item.kind), text(item.summary), "deferred.items[]", chars(item));
  }

  // ---- fold sightings into facts ------------------------------------------
  const byKey = new Map<string, { kind: FactKind; identity: string; value: string; surfaces: string[]; characters: number }>();
  for (const sighting of sightings) {
    const key = `${sighting.kind} ${sighting.identity}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { kind: sighting.kind, identity: sighting.identity, value: sighting.value, surfaces: [sighting.surface], characters: sighting.characters });
      continue;
    }
    if (!existing.surfaces.includes(sighting.surface)) existing.surfaces.push(sighting.surface);
    existing.characters += sighting.characters;
  }
  return Object.freeze(
    [...byKey.values()]
      .map((entry) => Object.freeze({
        kind: entry.kind,
        identity: entry.identity,
        value: entry.value,
        surfaces: Object.freeze([...entry.surfaces]),
        characters: entry.characters,
      }))
      .sort((a, b) => (a.kind === b.kind ? a.identity.localeCompare(b.identity) : a.kind.localeCompare(b.kind))),
  );
}

export interface FactGraphSummary {
  readonly facts: number;
  readonly factsAssertedMoreThanOnce: number;
  readonly repetitionRate: number;
  readonly totalSurfaces: number;
  readonly charactersByKind: Readonly<Record<string, number>>;
  readonly factsByKind: Readonly<Record<string, number>>;
  readonly repeatedByKind: Readonly<Record<string, number>>;
  readonly maxSurfacesForOneFact: number;
  readonly mostRepeatedFacts: readonly { identity: string; kind: string; surfaces: number }[];
}

export function summarizeFactGraph(facts: readonly SemanticFact[]): FactGraphSummary {
  const charactersByKind: Record<string, number> = {};
  const factsByKind: Record<string, number> = {};
  const repeatedByKind: Record<string, number> = {};
  let repeated = 0;
  let surfaces = 0;
  for (const fact of facts) {
    charactersByKind[fact.kind] = (charactersByKind[fact.kind] ?? 0) + fact.characters;
    factsByKind[fact.kind] = (factsByKind[fact.kind] ?? 0) + 1;
    surfaces += fact.surfaces.length;
    if (fact.surfaces.length > 1) {
      repeated += 1;
      repeatedByKind[fact.kind] = (repeatedByKind[fact.kind] ?? 0) + 1;
    }
  }
  const ranked = [...facts].sort((a, b) => b.surfaces.length - a.surfaces.length).slice(0, 12);
  return Object.freeze({
    facts: facts.length,
    factsAssertedMoreThanOnce: repeated,
    repetitionRate: facts.length === 0 ? 0 : repeated / facts.length,
    totalSurfaces: surfaces,
    charactersByKind: Object.freeze(charactersByKind),
    factsByKind: Object.freeze(factsByKind),
    repeatedByKind: Object.freeze(repeatedByKind),
    maxSurfacesForOneFact: facts.reduce((max, fact) => Math.max(max, fact.surfaces.length), 0),
    mostRepeatedFacts: Object.freeze(ranked.map((fact) => Object.freeze({ identity: fact.identity, kind: fact.kind, surfaces: fact.surfaces.length }))),
  });
}


// ---- what a response actually surfaced -----------------------------

/**
 * Every repo-relative FILE path the response names as evidence.
 *
 * File-level on purpose: the metric it feeds compares against transcript
 * actions, and a Read names a file. Deferral suggestions and provenance are
 * excluded — a pointer to another tool call is not a delivered location.
 */
export function surfacedFilePaths(output: Record<string, unknown>): ReadonlySet<string> {
  const paths = new Set<string>();
  const add = (value: unknown): void => {
    const path = text(value).trim();
    if (path !== "" && path !== "null") paths.add(path);
  };
  const productContext = isRecord(output.productContext) ? output.productContext : {};
  for (const item of asArray(productContext.items)) add(item.path);
  const capsuleResult = isRecord(output.capsuleResult) ? output.capsuleResult : {};
  for (const bucket of ["pivots", "support"] as const) {
    for (const entry of asArray(capsuleResult[bucket])) add(entry.path);
  }
  for (const neighborhood of asArray(output.pivotNeighborhood)) {
    const pivot = isRecord(neighborhood.pivot) ? neighborhood.pivot : {};
    add(pivot.path);
    for (const excerpt of asArray(neighborhood.excerpts)) add(excerpt.filePath);
  }
  const context = isRecord(output.context) ? output.context : {};
  for (const bucket of ["pivots", "supports"] as const) {
    for (const entry of asArray(context[bucket])) add(entry.filePath);
  }
  const inspectFirst = isRecord(output.inspectFirst) ? output.inspectFirst : {};
  for (const key of ["likelyFirst", "avoidFirst"] as const) {
    const entry = isRecord(inspectFirst[key]) ? (inspectFirst[key] as Record<string, unknown>) : {};
    add(entry.path);
  }
  for (const entry of asArray(inspectFirst.related)) add(entry.path);
  const impact = isRecord(output.impact) ? output.impact : {};
  for (const dependent of asArray(impact.topDependents)) add(dependent.path ?? dependent.filePath);
  return paths;
}

/** Every fully qualified symbol the response names as evidence. */
export function surfacedSymbols(output: Record<string, unknown>): ReadonlySet<string> {
  const symbols = new Set<string>();
  const add = (value: unknown): void => {
    const fqName = text(value).trim();
    if (fqName !== "" && fqName !== "null") symbols.add(fqName);
  };
  const productContext = isRecord(output.productContext) ? output.productContext : {};
  for (const item of asArray(productContext.items)) add(item.fqName);
  add(productContext.leadPivot);
  const capsuleResult = isRecord(output.capsuleResult) ? output.capsuleResult : {};
  for (const bucket of ["pivots", "support"] as const) {
    for (const entry of asArray(capsuleResult[bucket])) add(entry.fqName);
  }
  for (const neighborhood of asArray(output.pivotNeighborhood)) {
    const pivot = isRecord(neighborhood.pivot) ? neighborhood.pivot : {};
    add(pivot.fqName);
    for (const excerpt of asArray(neighborhood.excerpts)) add(excerpt.fqName);
  }
  const context = isRecord(output.context) ? output.context : {};
  for (const bucket of ["pivots", "supports"] as const) {
    for (const entry of asArray(context[bucket])) add(entry.fqName);
  }
  return symbols;
}

// ---- small shared statistics --------------------------------------

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

export const median = (values: readonly number[]): number => percentile(values, 0.5);
