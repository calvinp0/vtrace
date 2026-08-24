/**
 * M181-B controls — synthetic, permutation, and the known-positive specimen.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m181_controls.ts
 *
 * §24 and §25 exist to stop the milestone concluding "position 0 is canonical"
 * from a corpus in which position 0 happens to be a nice sentence. The synthetic
 * objects have no retrieval, no ranking and no upstream state; the reason arrays
 * are written by hand. If the displayed reason tracks the ARRAY ORDER on one path
 * and a SUBSTRING on the other, that is a property of the two selectors and of
 * nothing else.
 *
 * THE PERMUTATION CONTROL IS THE LOAD-BEARING ONE. The same reason set {A, B, C}
 * is fed in six orders. A selector that respects the declared contract must move
 * with the order, because the contract IS the order — the assembly layer puts the
 * decisive reason first. A selector that returns the same reason for all six
 * orders is ignoring the contract, not implementing a better one.
 *
 * Offline, pure, deterministic. Live spend $0.00.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { deliver } from "./m179Packing";
import { COMPACT_PREFERRED_PATTERN, reasonFamily } from "./m181Reasons";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");

/** Wide enough that small budgets must compact, large budgets need not. */
const LADDER = [400, 600, 800, 1_000, 1_600, 3_200, 8_000, 16_000] as const;

interface SyntheticItem {
  readonly id: string;
  readonly symbol: string;
  readonly roles: string[];
  readonly reasons: string[];
}

/**
 * M180 §25's synthetic object, carrying M181's reason arrays. Sixteen items with
 * verbose metadata, so the metadata rungs are on the path and the evidence layer
 * genuinely has to compact rather than fitting by luck.
 */
function syntheticAuthoritative(items: readonly SyntheticItem[]): Record<string, unknown> {
  const body = (name: string): string => `def ${name}(self):\n${"    # body line\n".repeat(60)}    return None`;
  const materialized = items.map((entry) => ({
    id: entry.id,
    stableId: `stable-${entry.id}`,
    fqName: `pkg/mod.py::${entry.symbol}`,
    path: "pkg/mod.py",
    symbol: entry.symbol,
    lineSpan: { start: 1, end: 61 },
    roles: entry.roles,
    contentMode: "full",
    selectionReasons: entry.reasons,
    content: body(entry.symbol),
    estimatedTokens: 200,
    metadata: {
      fqName: `pkg/mod.py::${entry.symbol}`,
      kind: "function",
      exported: true,
      returnType: "None",
      signature: `def ${entry.symbol}(self, first_argument, second_argument, third_argument)`,
      docstring: `Synthetic reason control for ${entry.symbol}; deliberately verbose so per-item metadata alone can exceed the flat allowance.`,
    },
  }));
  const rendered = [
    "# VTRACE product context",
    "task: synthetic reason control",
    "intent: explain",
    "worktree: synthetic",
    "capsule_mode: full",
    ...materialized.flatMap((entry) => [
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
      task: "synthetic reason control",
      intent: "explain",
      resolved: true,
      retrievalFound: true,
      deliveryFailed: false,
      resultState: "resolved",
      leadPivot: `pkg/mod.py::${materialized[0]!.symbol}`,
      capsuleMode: "full",
      repository: { worktreeId: "synthetic" },
      items: materialized,
      modelVisibleContext: rendered,
      accounting: { budgetTokens: 16_000 },
      diagnostics: { staticEvidenceOnly: true },
      freshness: { status: "fresh", reason: "synthetic" },
      timing: { totalMs: 1 },
    },
  };
}

const atOf = (identity: string): string => identity.split("|")[0] ?? identity;
const howOf = (identity: string): string => identity.slice(atOf(identity).length + 1);

/**
 * Displayed reason for one symbol across the ladder.
 *
 * The observed symbol must NOT be the lead pivot: the projector renders the lead
 * as `focus`, whose `why` this harness's `Delivered` row does not carry. Every
 * control therefore declares a separate lead and observes a `related` entry.
 */
function displayedAcrossLadder(authoritative: unknown, fqName: string): Map<number, string> {
  const seen = new Map<number, string>();
  for (const budget of LADDER) {
    const row = deliver(authoritative, budget);
    if (row.state !== "orientation") continue;
    const entry = row.related.find((identity) => atOf(identity) === fqName);
    if (entry !== undefined) seen.set(budget, howOf(entry));
  }
  return seen;
}

/** The lead pivot every control declares, so the observed item is never the focus. */
const LEAD: SyntheticItem = {
  id: "A", symbol: "alpha", roles: ["pivot", "required"],
  reasons: ["declared lead pivot for the synthetic control"],
};

/** The observed item: required, so keep-priority holds it through the rungs. */
const observed = (reasons: string[]): SyntheticItem => ({
  id: "T", symbol: "target", roles: ["pivot", "required"], reasons,
});

/** Fifteen filler items so the object is heavy enough to reach the rungs. */
function filler(): SyntheticItem[] {
  return Array.from({ length: 15 }, (_unused, index) => ({
    id: `S${index + 1}`,
    symbol: `support_symbol_number_${index + 1}`,
    roles: ["support"],
    reasons: [`selected as support for the synthetic control ${index + 1}`],
  }));
}

const ROLE_A = "entry point/caller delegating to local helpers — the edit site is the helper it calls";
const SCORE_B = "preferred contrast side matched: alpha, beta, gamma (+0.24)";
const GRAPH_C = "3 indexed symbol(s) depend on this";

/** §24 — arity and duplicates. */
function synthetic(): Record<string, unknown>[] {
  const scenarios: Array<{ name: string; reasons: string[]; expectation: string }> = [
    { name: "one_reason_no_preferred_substring", reasons: [ROLE_A], expectation: "both paths must show ROLE_A" },
    { name: "one_reason_with_preferred_substring", reasons: [SCORE_B], expectation: "both paths must show SCORE_B" },
    { name: "two_reasons_role_first_score_second", reasons: [ROLE_A, SCORE_B], expectation: "compact prefers SCORE_B; normal keeps ROLE_A" },
    { name: "two_reasons_score_first_role_second", reasons: [SCORE_B, ROLE_A], expectation: "both show SCORE_B — position 0 already matches" },
    { name: "three_reasons_role_score_graph", reasons: [ROLE_A, SCORE_B, GRAPH_C], expectation: "compact prefers SCORE_B; normal keeps ROLE_A" },
    { name: "three_reasons_role_graph_only", reasons: [ROLE_A, GRAPH_C], expectation: "no preferred substring: both keep ROLE_A" },
    { name: "duplicate_reasons", reasons: [ROLE_A, ROLE_A, GRAPH_C], expectation: "both keep ROLE_A" },
  ];
  return scenarios.map((scenario) => {
    const authoritative = syntheticAuthoritative([LEAD, observed(scenario.reasons), ...filler()]);
    const displayed = displayedAcrossLadder(authoritative, "pkg/mod.py::target");
    const distinct = [...new Set(displayed.values())];
    return {
      scenario: scenario.name,
      reasons: scenario.reasons,
      expectation: scenario.expectation,
      positionZero: scenario.reasons[0],
      compactWouldPrefer: scenario.reasons.find((reason) => COMPACT_PREFERRED_PATTERN.test(reason)) ?? scenario.reasons[0],
      displayedByBudget: Object.fromEntries(displayed),
      distinctDisplayed: distinct,
      stableAcrossBudgets: distinct.length <= 1,
    };
  });
}

/**
 * §25 — the same SET in every order.
 *
 * `reasonFamily` is recorded per order so the table shows not only that the
 * displayed string moved but that the KIND of claim moved with it.
 */
function permutation(): Record<string, unknown> {
  const set = [ROLE_A, SCORE_B, GRAPH_C];
  const orders = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  const rows = orders.map((order) => {
    const reasons = order.map((index) => set[index]!);
    const authoritative = syntheticAuthoritative([LEAD, observed(reasons), ...filler()]);
    const displayed = displayedAcrossLadder(authoritative, "pkg/mod.py::target");
    const distinct = [...new Set(displayed.values())];
    const compactPreferred = reasons.find((reason) => COMPACT_PREFERRED_PATTERN.test(reason)) ?? reasons[0]!;
    return {
      order: order.join(""),
      reasons,
      positionZero: reasons[0]!,
      positionZeroFamily: reasonFamily(reasons[0]!, true),
      compactPreferred,
      compactPreferredFamily: reasonFamily(compactPreferred),
      displayedByBudget: Object.fromEntries(displayed),
      distinctDisplayed: distinct,
      followsPositionZeroAtEveryBudget: distinct.length === 1 && distinct[0] === reasons[0],
    };
  });
  const compactChoices = new Set(rows.map((row) => row.compactPreferred));
  const positionZeroChoices = new Set(rows.map((row) => row.positionZero));
  return {
    question: "Does the displayed reason move when only the ORDER of an identical reason set changes?",
    set,
    rows,
    distinctPositionZeroAcrossOrders: positionZeroChoices.size,
    distinctCompactPreferredAcrossOrders: compactChoices.size,
    finding: compactChoices.size < positionZeroChoices.size
      ? "The compact selector is LESS order-sensitive than the declared contract: it returns the same reason for orders whose declared decisive reason differs. That is not a competing contract, it is an override of the only contract there is."
      : "Both selectors track order equally; position 0 carries no distinguishable authority in this control.",
  };
}

/** §21 — the strongest real specimen, traced to the functions that produced both sides. */
function knownPositive(): Record<string, unknown> {
  const reproduction = JSON.parse(
    readFileSync(path.join(RESULTS, "stage5_m181_residual_reproduction.json"), "utf8"),
  ) as { residuals: Array<Record<string, unknown>> };
  const candidates = reproduction.residuals.filter((residual) =>
    residual.equivalent === false
    && residual.lowerFamily === "SCORING_DIAGNOSTIC"
    && residual.higherFamily === "ROLE_DECISIVE");
  const specimen = candidates[0];
  if (specimen === undefined) return { found: false };
  return {
    found: true,
    specimen,
    R1_compacted: {
      displayed: specimen.lowerReason,
      family: specimen.lowerFamily,
      producedBy: "src/retrieval/hybridRetrieval.ts:1230 (also src/capsuleV2/buildCapsuleV2.ts:582) — `preferred contrast side matched: <terms> (+<score>)`, emitted with the numeric contribution to the retrieval score",
      selectedBy: "src/productContext/budgetDelivery.ts:428 — compactReasons, on the substring `preferred contrast`",
      semanticContent: "SCORER INTERNALS: which query terms matched and by how much. Says nothing about what the symbol is or what to do with it.",
    },
    R2_uncompacted: {
      displayed: specimen.higherReason,
      family: specimen.higherFamily,
      producedBy: "src/capsuleV2/debugRoles.ts (roleReason), surfaced as productAdapter.ts:49 `roleReason` — declared `The decisive reason this item landed in its role`",
      selectedBy: "src/productContext/assembleProductContext.ts:408 places it at position 0; src/runPipeline/orientationProjection.ts:329 reuses position 0 verbatim",
      semanticContent: "ACTIONABLE ROLE: what part the symbol plays in the task and whether it is an edit target.",
    },
    whyThisIsTheCentralSpecimen: "Same symbol, same frozen authoritative reason set, same evidence. The only variable is whether the evidence layer compacted. One budget tells the agent what to do with the symbol; the other tells it what the scorer was thinking.",
  };
}

function main(): void {
  const syntheticRows = synthetic();
  const permutationRows = permutation();
  const positive = knownPositive();

  writeFileSync(path.join(RESULTS, "stage5_m181_synthetic_controls.json"), `${JSON.stringify({
    milestone: "M181-B", generatedFrom: "run_stage5_m181_controls.ts",
    method: "hand-written reason arrays on a synthetic object with no retrieval, ranking or upstream state",
    ladder: LADDER,
    scenarios: syntheticRows,
  }, null, 2)}\n`);

  writeFileSync(path.join(RESULTS, "stage5_m181_permutation_controls.json"), `${JSON.stringify({
    milestone: "M181-B", generatedFrom: "run_stage5_m181_controls.ts", ladder: LADDER, ...permutationRows,
  }, null, 2)}\n`);

  writeFileSync(path.join(RESULTS, "stage5_m181_known_positive.json"), `${JSON.stringify({
    milestone: "M181-B", generatedFrom: "run_stage5_m181_controls.ts", ...positive,
  }, null, 2)}\n`);

  const unstable = syntheticRows.filter((row) => row.stableAcrossBudgets === false);
  console.log(JSON.stringify({
    milestone: "M181-B controls",
    syntheticScenarios: syntheticRows.length,
    scenariosWhereDisplayedReasonMovedWithBudget: unstable.map((row) => ({
      scenario: row.scenario, distinct: row.distinctDisplayed,
    })),
    permutation: {
      distinctPositionZeroAcrossOrders: permutationRows.distinctPositionZeroAcrossOrders,
      distinctCompactPreferredAcrossOrders: permutationRows.distinctCompactPreferredAcrossOrders,
      finding: permutationRows.finding,
    },
    knownPositiveFound: positive.found,
  }, null, 2));
}

main();
