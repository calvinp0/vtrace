/**
 * M166-D/E — reconcile the paired acceptance capture into the product-change record.
 *
 * Every acceptance criterion is a 12/12 comparison between the two sides, and every
 * difference is reported. A criterion that cannot be evaluated is reported as such
 * rather than counted as a pass.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.join(path.resolve("."), "benchmarks/stage5_vexp_swe_bench_smoke/results");
const CAPTURE = path.join(RESULTS, "_m166_acceptance");
const read = (name: string): any => JSON.parse(readFileSync(path.join(CAPTURE, name), "utf8"));

const before = read("before.json");
const after = read("after.json");

const MACHINE_FACING = ["retrieval", "budget", "nudge", "intent", "memory", "rules", "impact", "flow", "deferredCount", "omittedSectionCount"];

function stat(values: readonly number[]) {
  const sorted = [...values].filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (sorted.length === 0) return { median: null, p90: null, mean: null, min: null, max: null };
  const mid = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2),
    p90: sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)]!,
    mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    min: sorted[0]!, max: sorted[sorted.length - 1]!,
  };
}

const paired = before.cases.map((b: any) => ({ instanceId: b.instanceId, before: b, after: after.cases.find((a: any) => a.instanceId === b.instanceId) })).filter((p: any) => p.after !== undefined);

/**
 * Two of the requested criteria conflate things that must be judged apart.
 *
 * SELECTION is what retrieval decided and must not move. DELIVERY is how much of it
 * fits the envelope, which this change is expected to improve. Reporting them as one
 * number would let an evidence GAIN read as a selection regression.
 *
 * Likewise, control SEMANTICS must be identical, while the omission DISCLOSURE must
 * change: it names what was compacted, and this change compacts different things. A
 * disclosure that stayed identical would be the failure.
 */
const criteria: Record<string, { passed: number; total: number; differences: string[] }> = {
  repositoryEvidenceNeverLost: { passed: 0, total: 0, differences: [] },
  renderedEvidenceIdentical: { passed: 0, total: 0, differences: [] },
  agentUsefulControlIdentity: { passed: 0, total: 0, differences: [] },
  omissionDisclosureTracksTheCompaction: { passed: 0, total: 0, differences: [] },
  readinessAndAbsenceSemantics: { passed: 0, total: 0, differences: [] },
  defaultDiagnosticsRemoved: { passed: 0, total: 0, differences: [] },
  debugDiagnosticsRetained: { passed: 0, total: 0, differences: [] },
  selectionUnchanged: { passed: 0, total: 0, differences: [] },
};

const rows: Record<string, unknown>[] = [];
for (const pair of paired) {
  const b = pair.before.standard, a = pair.after.standard;
  const bd = pair.before.debug, ad = pair.after.debug;
  if (b === null || a === null) continue;
  const id = pair.instanceId;

  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

  criteria.renderedEvidenceIdentical.total += 1;
  if (b.modelVisibleContext === a.modelVisibleContext && same(b.evidence, a.evidence)) criteria.renderedEvidenceIdentical.passed += 1;
  else criteria.renderedEvidenceIdentical.differences.push(`${id}: rendering CHANGED (${b.modelVisibleContext.length} -> ${a.modelVisibleContext.length} chars), impactFacts ${b.evidence.impactFacts.length}->${a.evidence.impactFacts.length}`);

  criteria.repositoryEvidenceNeverLost.total += 1;
  const excerptsKept = b.selection.neighborhoodExcerpts.every((e: string) => a.selection.neighborhoodExcerpts.includes(e));
  const skeletonsKept = b.selection.skeletonFacts.every((f: string) => a.selection.skeletonFacts.includes(f));
  const impactKept = b.evidence.impactFacts.every((f: string) => a.evidence.impactFacts.includes(f));
  if (excerptsKept && skeletonsKept && impactKept && b.modelVisibleContext === a.modelVisibleContext) criteria.repositoryEvidenceNeverLost.passed += 1;
  else criteria.repositoryEvidenceNeverLost.differences.push(`${id}: excerpts ${excerptsKept ? "kept" : "LOST"}, skeletons ${skeletonsKept ? "kept" : "LOST"}, impact ${impactKept ? "kept" : "LOST"}`);

  criteria.agentUsefulControlIdentity.total += 1;
  const controlWithoutDisclosure = (control: any) => ({ ...control, omissionDisclosures: undefined });
  if (same(controlWithoutDisclosure(b.control), controlWithoutDisclosure(a.control))) criteria.agentUsefulControlIdentity.passed += 1;
  else {
    const changed = Object.keys(b.control).filter((k) => k !== "omissionDisclosures" && !same((b.control as any)[k], (a.control as any)[k]));
    criteria.agentUsefulControlIdentity.differences.push(`${id}: ${changed.map((k) => `${k}: ${JSON.stringify((b.control as any)[k])} -> ${JSON.stringify((a.control as any)[k])}`).join(" ; ")}`);
  }

  criteria.omissionDisclosureTracksTheCompaction.total += 1;
  const disclosesDiagnostics = (a.control.omissionDisclosures as string[]).some((d) => d === "diagnostics" || d === "machineFacingDiagnosticCharacters");
  if (disclosesDiagnostics) criteria.omissionDisclosureTracksTheCompaction.passed += 1;
  else criteria.omissionDisclosureTracksTheCompaction.differences.push(`${id}: the response does not disclose that diagnostics were held back`);

  criteria.readinessAndAbsenceSemantics.total += 1;
  const readinessSame = same(b.control.componentStatuses, a.control.componentStatuses)
    && b.control.freshnessStatus === a.control.freshnessStatus
    && b.control.readinessReady === a.control.readinessReady
    && b.control.degradedState === a.control.degradedState
    && same(b.control.absenceClaims, a.control.absenceClaims);
  if (readinessSame) criteria.readinessAndAbsenceSemantics.passed += 1;
  else criteria.readinessAndAbsenceSemantics.differences.push(`${id}: statuses ${JSON.stringify(b.control.componentStatuses)} -> ${JSON.stringify(a.control.componentStatuses)}; ready ${b.control.readinessReady}->${a.control.readinessReady}`);

  criteria.defaultDiagnosticsRemoved.total += 1;
  const stillPresent = MACHINE_FACING.filter((member) => a.diagnosticsMembers.includes(member));
  if (stillPresent.length === 0) criteria.defaultDiagnosticsRemoved.passed += 1;
  else criteria.defaultDiagnosticsRemoved.differences.push(`${id}: still present ${stillPresent.join(", ")}`);

  criteria.debugDiagnosticsRetained.total += 1;
  if (bd === null || ad === null) criteria.debugDiagnosticsRetained.differences.push(`${id}: debug side missing`);
  else {
    const lost = (bd.diagnosticsMembers as string[]).filter((member) => !ad.diagnosticsMembers.includes(member));
    if (lost.length === 0) criteria.debugDiagnosticsRetained.passed += 1;
    else criteria.debugDiagnosticsRetained.differences.push(`${id}: lost at debug ${lost.join(", ")}`);
  }

  // §54. Selection authority: what retrieval chose. Delivery — how much of the
  // chosen evidence fits — is reported separately, because this change is expected
  // to improve it and an improvement must not read as a regression.
  criteria.selectionUnchanged.total += 1;
  const selectionKeys = ["leadPivot", "itemPaths", "symbols", "roles", "skeletonFacts", "resultState", "roleCounts"];
  const changedSelection = selectionKeys.filter((k) => !same((b.selection as any)[k], (a.selection as any)[k]));
  if (changedSelection.length === 0) criteria.selectionUnchanged.passed += 1;
  else criteria.selectionUnchanged.differences.push(`${id}: ${changedSelection.join(", ")}`);

  rows.push({
    instanceId: id,
    standardTokens: { before: b.structuredTokens, after: a.structuredTokens, delta: a.structuredTokens - b.structuredTokens, reductionPercent: Number((100 * (1 - a.structuredTokens / b.structuredTokens)).toFixed(1)) },
    debugTokens: { before: bd?.structuredTokens ?? null, after: ad?.structuredTokens ?? null },
    evidenceTokens: { before: b.categoryTokens.REPOSITORY_EVIDENCE, after: a.categoryTokens.REPOSITORY_EVIDENCE },
    diagnosticTokens: { before: b.categoryTokens.MACHINE_DIAGNOSTIC, after: a.categoryTokens.MACHINE_DIAGNOSTIC },
    diagnosticsSectionCharacters: { before: b.diagnosticsCharacters, after: a.diagnosticsCharacters },
    refreshDiagnostics: { before: b.refreshDiagnostics.slice(0, 60), after: a.refreshDiagnostics.slice(0, 60) },
    diagnosticsMembers: { before: b.diagnosticsMembers, after: a.diagnosticsMembers },
    neighborhoodExcerpts: { before: b.selection.neighborhoodExcerpts.length, after: a.selection.neighborhoodExcerpts.length },
    envelope: { before: b.responseBudget ?? null, after: a.responseBudget ?? null },
  });
}

const payload = {
  schemaVersion: 1,
  milestone: "M166",
  workstream: "D",
  title: "Product change — machine-facing diagnostics held for detail=debug",
  implementationVerdict: "MODEL_RENDERER_COMPACTED",
  scope: {
    changed: [
      "src/mcp/responseEnvelope.ts — reduceDiagnosticsToAgentFacing + agentFacingIndexFreshness; the default response keeps readiness truth and holds machine-facing diagnostics for detail=debug",
      "src/mcp/tools.ts — get_code_context's post-pipeline freshness overwrite now lands in the shape the envelope settled on instead of restoring the detail it had just held back; diagnostics output schema marks the machine-facing members detail-conditional and declares the disclosure field",
    ],
    deliberatelyNotChanged: [
      "retrieval, ranking, candidate generation, evidence selection, pipeline composition",
      "MCP transport: both content[0].text and structuredContent are still returned, unchanged in kind",
      "provenance shape and generic duplicate removal — deferred, they need an independent authority-preservation audit",
      "detail=debug output",
    ],
    noParallelApi: "no responseV2/compactV2/agentRendererV2; one authoritative renderer, one detail knob that already shipped",
  },
  acceptance: Object.fromEntries(Object.entries(criteria).map(([name, value]) => [name, {
    result: `${value.passed}/${value.total}`,
    passed: value.passed === value.total && value.total > 0,
    differences: value.differences,
  }])),
  economics: {
    standardTokens: {
      before: stat(rows.map((r) => (r.standardTokens as any).before)),
      after: stat(rows.map((r) => (r.standardTokens as any).after)),
    },
    medianReductionPercent: Number((100 * (1 - (stat(rows.map((r) => (r.standardTokens as any).after)).median ?? 0) / Math.max(1, stat(rows.map((r) => (r.standardTokens as any).before)).median ?? 1))).toFixed(1)),
    evidenceTokens: {
      before: stat(rows.map((r) => (r.evidenceTokens as any).before)),
      after: stat(rows.map((r) => (r.evidenceTokens as any).after)),
    },
    diagnosticTokens: {
      before: stat(rows.map((r) => (r.diagnosticTokens as any).before)),
      after: stat(rows.map((r) => (r.diagnosticTokens as any).after)),
    },
    debugTokens: {
      before: stat(rows.map((r) => (r.debugTokens as any).before)),
      after: stat(rows.map((r) => (r.debugTokens as any).after)),
    },
  },
  /**
   * Why the projected reduction did not arrive, investigated rather than argued away.
   *
   * The envelope has a hard total ceiling and the progressive packer fills it. When a
   * response is already at that ceiling, removing metadata does not make the response
   * smaller — it frees budget the packer immediately spends on evidence it had been
   * compacting away. The saving is real; it is denominated in evidence, not tokens.
   */
  whyTheProjectionDidNotArrive: {
    projectedReductionPercent: 53.6,
    projectionSource: "stage5_m166_compression_simulation.json NO_MACHINE_DIAGNOSTICS, computed by deleting spans from a captured payload",
    whatTheProjectionAssumed: "that a response is a fixed set of fields, so removing some makes it smaller",
    whatActuallyHappens: "the response is envelope-bound; responseTokenCeiling(requested_context_tokens) caps it and the packer fills the cap",
    evidence: {
      casesAtOrNearCeilingBefore: rows.filter((r) => {
        const envelope = (r.envelope as any).before;
        return envelope !== null && typeof envelope.headroomTokens === "number" && envelope.headroomTokens <= 500;
      }).length,
      casesWhereNeighborhoodEvidenceWasRestored: rows.filter((r) => (r.neighborhoodExcerpts as any).after > (r.neighborhoodExcerpts as any).before).length,
      neighborhoodExcerptsBefore: rows.reduce((sum, r) => sum + (r.neighborhoodExcerpts as any).before, 0),
      neighborhoodExcerptsAfter: rows.reduce((sum, r) => sum + (r.neighborhoodExcerpts as any).after, 0),
    },
    reading: "M166-B/C measured the composition correctly; the projection mis-modelled the mechanism. Holding the diagnostics back converts a metadata cost into evidence at near-constant token cost, which is a better outcome than the projection described but not the one it predicted.",
    scopeNotWidened: "no further removal was attempted; the user's instruction was to investigate rather than widen, and the investigation is the finding",
  },
  indexWrites: { before: before.indexWrites, after: after.indexWrites },
  cases: rows,
};

writeFileSync(path.join(RESULTS, "stage5_m166_product_change.json"), JSON.stringify(payload, null, 1));
for (const [name, value] of Object.entries(payload.acceptance)) console.error(`[m166-D] ${name.padEnd(30)} ${(value as any).result}${(value as any).passed ? "" : "  <-- differences"}`);
console.error(`[m166-D] standard median ${payload.economics.standardTokens.before.median} -> ${payload.economics.standardTokens.after.median} (${payload.economics.medianReductionPercent}%), p90 ${payload.economics.standardTokens.before.p90} -> ${payload.economics.standardTokens.after.p90}`);
console.error(`[m166-D] evidence ${payload.economics.evidenceTokens.before.median} -> ${payload.economics.evidenceTokens.after.median}; diagnostics ${payload.economics.diagnosticTokens.before.median} -> ${payload.economics.diagnosticTokens.after.median}`);
