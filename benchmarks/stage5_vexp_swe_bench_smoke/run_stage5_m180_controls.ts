/**
 * M180-A/B — the ownership controls.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m180_controls.ts
 *
 * Four controls, in increasing order of how hard they are to argue with.
 *
 *   SYNTHETIC (§25)  a hand-built productContext with three items and nothing
 *                    else, packed at a budget that forces the metadata rungs.
 *                    If the supply the projector sees is not [A,B,C], no corpus
 *                    argument is needed.
 *   TIMELINE (§15)   T0..T4 for one real case, hashed at every stage, so the
 *                    stage at which the semantic supply first changes is named
 *                    rather than inferred.
 *   KNOWN POSITIVE   same authoritative object, same ranking, two budgets, and
 *                    the larger one delivering less.
 *   KNOWN NEGATIVE   a case whose projector input equals the evidence layer's
 *                    supply at every budget, which must show no violation.
 *
 * Offline, pure, deterministic. Live spend $0.00.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { compactProductResponse, McpResponseDetail } from "../../src/mcp/responseEnvelope";
import { projectRunPipelineOrientation } from "../../src/runPipeline/orientationProjection";
import { deliver, comparePair } from "./m179Packing";
import { carriesItemBodies } from "./m179Capture";
import { hashOf, isRecord, observeOwnership, renderedSectionIds, semanticItemSupplyHash, asArray } from "./m180Ownership";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const CORPUS_ROOT = path.join(RESULTS, "_m179_authoritative");
const BUDGETS = [100, 200, 400, 600, 800, 1_000, 1_200, 1_600, 2_000, 3_200, 6_400, 8_000] as const;

const load = (corpus: string, instanceId: string): unknown =>
  (JSON.parse(readFileSync(path.join(CORPUS_ROOT, corpus, `${instanceId}.json`), "utf8")) as { snapshot: unknown }).snapshot;

const respond = (authoritative: unknown, budget: number): Record<string, unknown> => {
  const draft = structuredClone(authoritative) as Record<string, unknown>;
  delete draft.responseBudget;
  return compactProductResponse(draft, { requestedContextTokens: budget, detail: McpResponseDetail.Standard }) as Record<string, unknown>;
};

/**
 * §25 — a productContext with three items and no other content, so nothing but
 * the item rows can be responsible for what the projector ends up seeing.
 *
 * Bodies are long enough that the response cannot fit a small ceiling, which is
 * what puts the metadata rungs on the path. Deliberately NOT a corpus case: a
 * synthetic object has no retrieval, no ranking and no upstream state to blame.
 */
function syntheticContext(): Record<string, unknown> {
  const body = (name: string): string => `def ${name}(self):\n${"    # body line\n".repeat(60)}    return None`;
  const item = (id: string, symbol: string, roles: string[]) => ({
    id,
    stableId: `stable-${id}`,
    fqName: `pkg/mod.py::${symbol}`,
    path: "pkg/mod.py",
    symbol,
    lineSpan: { start: 1, end: 61 },
    roles,
    contentMode: "full",
    selectionReasons: [`selected as ${roles[0]} for the synthetic control`],
    content: body(symbol),
    estimatedTokens: 200,
    metadata: {
      fqName: `pkg/mod.py::${symbol}`,
      kind: "function",
      exported: true,
      returnType: "None",
      signature: `def ${symbol}(self, first_argument, second_argument, third_argument)`,
      docstring: `Synthetic control metadata for ${symbol}; deliberately verbose so that per-item metadata alone can exceed the flat allowance.`,
    },
  });
  // Sixteen items, with per-item metadata heavy enough to exceed the flat
  // metadata allowance on its own. Three would not reach the rungs: the ladder
  // will not cut below MIN_RETAINED_PRODUCT_ITEMS and the response fits anyway.
  const items = [
    item("A", "alpha", ["pivot", "required"]),
    ...Array.from({ length: 15 }, (_unused, index) => item(`S${index + 1}`, `support_symbol_number_${index + 1}`, ["support"])),
  ];
  const rendered = [
    "# VTRACE product context",
    "task: synthetic ownership control",
    "intent: explain",
    "worktree: synthetic",
    "capsule_mode: full",
    ...items.flatMap((entry) => [
      "",
      `## [${entry.id}] ${entry.fqName}`,
      `roles: ${entry.roles.join(", ")}`,
      `mode: ${entry.contentMode}`,
      `lines: ${entry.lineSpan.start}-${entry.lineSpan.end}`,
      ...entry.selectionReasons.map((reason) => `why: ${reason}`),
      "",
      entry.content,
    ]),
  ].join("\n");
  return {
    productContext: {
      task: "synthetic ownership control",
      intent: "explain",
      resolved: true,
      retrievalFound: true,
      deliveryFailed: false,
      resultState: "resolved",
      leadPivot: "pkg/mod.py::alpha",
      capsuleMode: "full",
      repository: { worktreeId: "synthetic" },
      items,
      modelVisibleContext: rendered,
      accounting: { budgetTokens: 8_000 },
      diagnostics: { staticEvidenceOnly: true },
      freshness: { status: "fresh", reason: "synthetic" },
      timing: { totalMs: 1 },
    },
  };
}

function syntheticControl(): Record<string, unknown> {
  const authoritative = syntheticContext();
  const before = asArray((authoritative.productContext as Record<string, unknown>).items).map((entry) => String(entry.id));
  const rows: Record<string, unknown>[] = [];
  for (const budget of [200, 400, 800, 1_600, 3_200, 8_000]) {
    const response = respond(authoritative, budget);
    const own = observeOwnership(response, budget);
    const packet = projectRunPipelineOrientation(response);
    rows.push({
      budget,
      authoritativeSupply: before,
      evidenceLayerSupply: own.evidenceSupply,
      projectorInput: own.projectorInput,
      withheld: own.withheld,
      withheldBy: own.withheldBy,
      focus: packet?.focus.at ?? null,
      related: packet?.related.length ?? null,
    });
  }
  const mutating = rows.filter((row) => (row.withheld as string[]).length > 0);
  return {
    control: "synthetic_aliasing",
    question: "does response metadata compaction change the item supply the projector reads, on an object with nothing but three items in it",
    authoritativeSupply: before,
    rows,
    verdict: mutating.length > 0
      ? "SEMANTIC_SUPPLY_MUTATED_BY_METADATA_LAYER"
      : "SEMANTIC_SUPPLY_PRESERVED",
    budgetsWhereSupplyWasCut: mutating.length,
  };
}

/** §15 — T0..T4, hashed, for one real case. */
function timeline(corpus: string, instanceId: string): Record<string, unknown> {
  const authoritative = load(corpus, instanceId) as Record<string, unknown>;
  const authoritativeItems = asArray((authoritative.productContext as Record<string, unknown>).items);
  const stages: Record<string, unknown>[] = [];
  for (const budget of BUDGETS) {
    const response = respond(authoritative, budget);
    const productContext = isRecord(response.productContext) ? response.productContext : {};
    const own = observeOwnership(response, budget);
    const packet = projectRunPipelineOrientation(response);
    stages.push({
      budget,
      T0_authoritative: { items: authoritativeItems.length, hash: semanticItemSupplyHash(authoritativeItems) },
      T1_evidenceLayerDelivered: { items: own.evidenceSupply.length, hash: own.supplyHash, ids: own.evidenceSupply },
      T3_projectorInput: { items: own.projectorInput.length, hash: own.projectorInputHash, ids: own.projectorInput },
      T4_delivered: {
        focus: packet?.focus.at ?? null,
        related: packet?.related.map((entry) => entry.at) ?? [],
      },
      firstSemanticDivergence: own.withheld.length === 0
        ? "none"
        : own.degraded ? "degradation" : `metadata_layer:${own.withheldBy}`,
      renderedCharacters: String(productContext.modelVisibleContext ?? "").length,
    });
  }
  return { case: `${corpus}/${instanceId}`, stages };
}

function main(): void {
  const synthetic = syntheticControl();

  const knownPositive = {
    control: "known_positive",
    case: "broad100a/django__django-11133",
    claim: "same authoritative object, same ranking, larger budget delivers strictly less related evidence, and the lost evidence is still rendered in the larger budget's own response",
    timeline: timeline("broad100a", "django__django-11133"),
  };

  // §23 known negative: a case whose projector input never diverges from the
  // evidence layer's supply. Chosen by measurement, not by hand.
  const negatives: Record<string, unknown>[] = [];
  for (const corpus of ["broad100a", "broad100b"]) {
    for (const file of readdirSync(path.join(CORPUS_ROOT, corpus)).sort()) {
      if (!file.endsWith(".json")) continue;
      const capture = JSON.parse(readFileSync(path.join(CORPUS_ROOT, corpus, file), "utf8")) as { instanceId: string; snapshot: unknown };
      if (capture.snapshot === null || !carriesItemBodies(capture.snapshot).valid) continue;
      const owns = BUDGETS.map((budget) => observeOwnership(respond(capture.snapshot, budget), budget));
      const cut = owns.filter((own) => own.withheld.length > 0).length;
      const rows = BUDGETS.map((budget) => ({ budget, ...deliver(capture.snapshot, budget) }));
      let violations = 0;
      for (let i = 0; i < rows.length; i += 1) {
        for (let j = i + 1; j < rows.length; j += 1) {
          if (comparePair(rows[i]!.budget, rows[i]!, rows[j]!.budget, rows[j]!) !== null) violations += 1;
        }
      }
      negatives.push({ case: `${corpus}/${capture.instanceId}`, budgetsWhereSupplyWasCut: cut, violations });
    }
  }
  const clean = negatives.filter((row) => row.budgetsWhereSupplyWasCut === 0);
  const negative = {
    control: "known_negative",
    claim: "a case whose projector input equals the evidence layer's supply at every budget must show no violation",
    casesChecked: negatives.length,
    casesNeverCut: clean.length,
    casesNeverCutWithViolations: clean.filter((row) => (row.violations as number) > 0).length,
    verdict: clean.length === 0
      ? "NO_CLEAN_CASE_EXISTS"
      : clean.every((row) => row.violations === 0) ? "NO_VIOLATION_AS_EXPECTED" : "UNEXPECTED_VIOLATION",
    examples: clean.slice(0, 5),
    distribution: negatives,
  };

  // §24 identity: same object, same budget, packed and projected twice.
  const identity: Record<string, unknown>[] = [];
  for (const corpus of ["broad100a", "broad100b"]) {
    for (const file of readdirSync(path.join(CORPUS_ROOT, corpus)).sort()) {
      if (!file.endsWith(".json")) continue;
      const capture = JSON.parse(readFileSync(path.join(CORPUS_ROOT, corpus, file), "utf8")) as { instanceId: string; snapshot: unknown };
      if (capture.snapshot === null || !carriesItemBodies(capture.snapshot).valid) continue;
      const a = hashOf(deliver(capture.snapshot, 8_000));
      const b = hashOf(deliver(capture.snapshot, 8_000));
      identity.push({ corpus, instanceId: capture.instanceId, identical: a === b });
    }
  }

  writeFileSync(
    path.join(RESULTS, "stage5_m180_aliasing_controls.json"),
    `${JSON.stringify({ milestone: "M180-A", synthetic }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(RESULTS, "stage5_m180_mutation_timeline.json"),
    `${JSON.stringify({ milestone: "M180-A", knownPositive }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(RESULTS, "stage5_m180_known_negative.json"),
    `${JSON.stringify({ milestone: "M180-B", negative }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(RESULTS, "stage5_m180_identity_controls.json"),
    `${JSON.stringify({
      milestone: "M180-B",
      control: "same object, same budget, packed and projected twice",
      checked: identity.length,
      failures: identity.filter((row) => row.identical !== true).length,
      rows: identity,
    }, null, 2)}\n`,
  );

  console.log(JSON.stringify({
    synthetic: { verdict: synthetic.verdict, budgetsWhereSupplyWasCut: synthetic.budgetsWhereSupplyWasCut, rows: synthetic.rows },
    knownNegative: negative,
    identity: { checked: identity.length, failures: identity.filter((row) => row.identical !== true).length },
  }, null, 2));
}

main();
