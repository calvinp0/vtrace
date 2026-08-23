/**
 * M175-B — controls for the echo classifier.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m175_echo_controls.ts
 *
 * The classifier decides whether a delivery failure was caused by request echo.
 * A classifier that says yes whenever the echo is large would confirm M175's
 * hypothesis on every oversized response and would be worthless — §15 names four
 * other pathologies precisely so that one cannot be assumed.
 *
 * These are SYNTHETIC responses, and that is the point. The captures in M175-B
 * cannot be replayed under two policies, because compaction destroys the evidence
 * before the response is observable. A constructed response has no such problem:
 * the pre-compaction state is authored here, so both arms genuinely are the same
 * bytes and the classifier can be exercised against known ground truth.
 *
 * Every control declares its expected verdict BEFORE it runs, and the script exits
 * non-zero if any of them disagrees.
 *
 * Offline. No agent, no Docker, no paid API.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  attributeEcho, classify, compactUnder, DisclosurePolicy, DEFAULT_REQUESTED_CONTEXT_TOKENS,
  Pathology, readDelivery,
} from "./m175Echo";

const RESULTS = path.join(path.resolve("."), "benchmarks/stage5_vexp_swe_bench_smoke/results");

/** The policy M175-C freezes. Controls are run against the shipped repair. */
const REPAIR = DisclosurePolicy.IdentityOnly;

const filler = (chars: number, seed: string): string => {
  const unit = `${seed} `;
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
};

interface ItemSpec { readonly id: string; readonly path: string; readonly symbol: string; readonly bodyChars: number }

/**
 * A synthetic authoritative `run_pipeline` result, in the shape
 * `compactProductResponse` consumes: a `productContext` carrying items with
 * bodies and a rendered `modelVisibleContext`, and a `request` block beside it.
 */
function buildResponse(options: {
  readonly taskChars: number;
  readonly queryChars: number;
  readonly identicalEcho: boolean;
  readonly items: readonly ItemSpec[];
  readonly diagnosticsChars?: number;
  /**
   * Bulk placed in `workspaceRouting`, which no rung of the ladder reduces. The
   * `diagnostics` knob turned out to be useless as a control: at standard detail
   * `reduceDiagnosticsToAgentFacing` strips it entirely, so 60,000 characters of
   * it cost the envelope nothing.
   */
  readonly irreducibleMetadataChars?: number;
}): Record<string, unknown> {
  const task = filler(options.taskChars, "the reported failure occurs when the axis converts empty data");
  const query = options.identicalEcho
    ? task
    : filler(options.queryChars, "convert units axis category empty data deprecation");

  const items = options.items.map((spec, index) => ({
    id: spec.id,
    fqName: `${spec.path}::${spec.symbol}`,
    path: spec.path,
    symbol: spec.symbol,
    roles: index === 0 ? ["pivot"] : ["support"],
    contentMode: "full",
    selectionReasons: [index === 0 ? "lead pivot: symbol-name match" : "supporting evidence for this task"],
    lineSpan: { start: 1, end: 40 },
    content: filler(spec.bodyChars, `def ${spec.symbol}(self, value):  # body`),
    estimatedTokens: Math.ceil(spec.bodyChars / 4),
  }));

  const rendered = [
    "# VTRACE product context",
    "task: @request.task",
    "intent: auto",
    "worktree: synthetic",
    "capsule_mode: standard",
    ...items.flatMap((item) => [
      "", `## [${item.id}] ${item.fqName}`,
      `roles: ${item.roles.join(", ")}`, `mode: ${item.contentMode}`,
      `lines: ${item.lineSpan.start}-${item.lineSpan.end}`,
      ...item.selectionReasons.map((reason) => `why: ${reason}`),
      "", item.content,
    ]),
  ].join("\n");

  return {
    schemaVersion: "vtrace.run_pipeline/1",
    request: {
      query, task, maxResults: 6, maxBudgetCharacters: 2_000,
      intentRequested: "auto", sessionId: null, includeTests: true, includeFileContent: true,
      presetRequested: "auto",
    },
    intent: { selectedPreset: "auto", selectedIntent: "debug", reason: "derived from the task" },
    taskSummary: { query, normalizedQuery: query, editGoal: null },
    diagnostics: options.diagnosticsChars === undefined ? {} : {
      retrieval: { note: filler(options.diagnosticsChars, "candidate scoring trace entry") },
    },
    ...(options.irreducibleMetadataChars === undefined ? {} : {
      workspaceRouting: {
        isWorkspace: false, outcome: "single_repository",
        reason: filler(options.irreducibleMetadataChars, "routing considered member"),
      },
    }),
    productContext: {
      responseVersion: "vtrace.product_context/1",
      resolved: items.length > 0,
      task: "@request.task",
      taskHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      intent: "debug",
      capsuleMode: "standard",
      leadPivot: items[0]?.fqName ?? null,
      selectedFileHash: "0000000000000000",
      repository: { worktreeId: "synthetic" },
      freshness: { status: "fresh", reason: "index current" },
      roleCounts: { pivot: Math.min(1, items.length), support: Math.max(0, items.length - 1) },
      items,
      modelVisibleContext: rendered,
      diagnostics: {},
    },
  };
}

interface Control {
  readonly name: string;
  readonly why: string;
  readonly expected: Pathology;
  readonly expectRepairRestoresDelivery: boolean;
  readonly response: Record<string, unknown>;
}

/** Evidence sized to sit just under the ceiling on its own, so metadata decides. */
const MODEST_EVIDENCE: readonly ItemSpec[] = Object.freeze([
  { id: "i1", path: "lib/matplotlib/axis.py", symbol: "Axis.convert_units", bodyChars: 3_000 },
  { id: "i2", path: "lib/matplotlib/category.py", symbol: "StrCategoryConverter.convert", bodyChars: 3_000 },
  { id: "i3", path: "lib/matplotlib/units.py", symbol: "Registry.get_converter", bodyChars: 3_000 },
]);

const TINY_EVIDENCE: readonly ItemSpec[] = Object.freeze([
  { id: "i1", path: "lib/a.py", symbol: "A.f", bodyChars: 400 },
  { id: "i2", path: "lib/b.py", symbol: "B.g", bodyChars: 400 },
]);

const HUGE_EVIDENCE: readonly ItemSpec[] = Object.freeze(
  Array.from({ length: 12 }, (_, index) => ({
    id: `i${index + 1}`, path: `lib/mod${index}.py`, symbol: `Mod${index}.run`, bodyChars: 12_000,
  })),
);

const CONTROLS: readonly Control[] = Object.freeze([
  {
    name: "task_echo_dominates",
    why: "A long task with a short query. The single verbatim copy alone must be enough to evict.",
    expected: Pathology.RequestEchoEviction,
    expectRepairRestoresDelivery: true,
    response: buildResponse({ taskChars: 26_000, queryChars: 120, identicalEcho: false, items: MODEST_EVIDENCE }),
  },
  {
    name: "query_echo_dominates",
    why: "The mirror image. The classifier must not be sensitive to WHICH key carries the prose.",
    expected: Pathology.RequestEchoEviction,
    expectRepairRestoresDelivery: true,
    response: buildResponse({ taskChars: 120, queryChars: 26_000, identicalEcho: false, items: MODEST_EVIDENCE }),
  },
  {
    name: "both_copies_dominate",
    why: "The real product shape: one string under two keys. This is the M174 case, synthesised.",
    expected: Pathology.RequestEchoEviction,
    expectRepairRestoresDelivery: true,
    response: buildResponse({ taskChars: 13_000, queryChars: 13_000, identicalEcho: true, items: MODEST_EVIDENCE }),
  },
  {
    name: "large_evidence_tiny_request",
    why: "144,000 characters of evidence beside a 90-character request. Delivery SUCCEEDS: the "
      + "progressive packer shrinks evidence to fit, so a large supply never evicts itself. This "
      + "is the control that makes the milestone's claim narrow — evidence yields to the budget, "
      + "and the echo is the metadata that does not.",
    expected: Pathology.NotAffected,
    expectRepairRestoresDelivery: false,
    response: buildResponse({ taskChars: 90, queryChars: 90, identicalEcho: true, items: HUGE_EVIDENCE }),
  },
  {
    name: "metadata_small_enough",
    why: "Everything fits. A well-behaved response must not be reported as a pathology.",
    expected: Pathology.NotAffected,
    expectRepairRestoresDelivery: false,
    response: buildResponse({ taskChars: 200, queryChars: 200, identicalEcho: true, items: TINY_EVIDENCE }),
  },
  {
    name: "retrieval_empty",
    why: "No evidence was retrieved, so none was displaced — not an echo pathology however large "
      + "the echo. Worth recording separately: at this task size the envelope is UNREACHABLE even "
      + "with zero evidence, and compactProductResponse throws rather than returning a response.",
    expected: Pathology.NotAffected,
    expectRepairRestoresDelivery: false,
    response: buildResponse({ taskChars: 26_000, queryChars: 26_000, identicalEcho: true, items: [] }),
  },
  {
    name: "other_metadata_evicts",
    why: "A tiny request beside 30,000 characters of irreducible routing metadata. Delivery fails "
      + "and the request block is not why — the false positive the classifier exists to avoid.",
    expected: Pathology.OtherMetadataEviction,
    expectRepairRestoresDelivery: false,
    response: buildResponse({
      taskChars: 80, queryChars: 80, identicalEcho: true, items: MODEST_EVIDENCE,
      irreducibleMetadataChars: 30_000,
    }),
  },
]);

interface Row {
  readonly name: string;
  readonly why: string;
  readonly expected: string;
  readonly observed: string;
  readonly pathologyAgrees: boolean;
  readonly expectRepairRestoresDelivery: boolean;
  readonly repairRestoredDelivery: boolean;
  readonly deliveryAgrees: boolean;
  readonly beforeDelivered: number;
  readonly afterDelivered: number;
  readonly echoShareOfResponse: number;
  readonly beforeTotalTokens: number;
  readonly afterTotalTokens: number;
  readonly ceilingTokens: number;
}

/**
 * `compactProductResponse` THROWS when a response cannot be made to fit even after
 * the evidence has been deleted — `product_response_envelope_unreachable`. That is
 * a real product state and not an error in the harness, so it is recorded as an
 * outcome with zero delivery rather than swallowed or worked around.
 */
const safeDelivery = (response: unknown, policy: DisclosurePolicy) => {
  try {
    return { ...readDelivery(compactUnder(response, policy)), unreachable: false };
  } catch (cause) {
    if (cause instanceof Error && cause.message === "product_response_envelope_unreachable") {
      return { ...readDelivery(null), unreachable: true };
    }
    throw cause;
  }
};

const rows: Row[] = [];
for (const control of CONTROLS) {
  const before = safeDelivery(control.response, DisclosurePolicy.Current);
  const after = safeDelivery(control.response, REPAIR);
  const observed = before.unreachable && after.unreachable
    ? { pathology: Pathology.EvidenceSupplyTooLarge, why: "Envelope unreachable under both policies." }
    : classify(control.response, REPAIR);
  const restored = after.deliveredItems > before.deliveredItems;
  rows.push({
    name: control.name,
    why: control.why,
    expected: control.expected,
    observed: observed.pathology,
    pathologyAgrees: observed.pathology === control.expected,
    expectRepairRestoresDelivery: control.expectRepairRestoresDelivery,
    repairRestoredDelivery: restored,
    deliveryAgrees: restored === control.expectRepairRestoresDelivery,
    beforeDelivered: before.deliveredItems,
    afterDelivered: after.deliveredItems,
    echoShareOfResponse: attributeEcho(control.response).echoShareOfResponse,
    beforeTotalTokens: before.totalResponseTokens,
    afterTotalTokens: after.totalResponseTokens,
    ceilingTokens: before.ceilingTokens,
  });
}

/**
 * The identity control (§16).
 *
 * A response carrying no request prose must come out of the repair byte-identical.
 * This is what separates "removed the echo" from "changed the response": if the
 * repair can alter a packet with nothing to remove, it is doing something else as
 * well, and every other number in M175 would be suspect.
 */
const noEchoResponse = buildResponse({ taskChars: 0, queryChars: 0, identicalEcho: false, items: TINY_EVIDENCE });
delete (noEchoResponse as Record<string, unknown>).request;
const identityBefore = JSON.stringify(compactUnder(noEchoResponse, DisclosurePolicy.Current));
const identityAfter = JSON.stringify(compactUnder(noEchoResponse, REPAIR));
const identityHolds = identityBefore === identityAfter;

/**
 * The evidence-preservation control (§49).
 *
 * Freeing budget must not attract NEW evidence. The repair may restore what the
 * projector already selected; it may not cause anything else to be selected,
 * because the selection happened before the envelope was consulted.
 */
const preservationCase = buildResponse({
  taskChars: 13_000, queryChars: 13_000, identicalEcho: true, items: MODEST_EVIDENCE,
});
const preservedAfter = compactUnder(preservationCase, REPAIR);
const selectedIds = new Set(MODEST_EVIDENCE.map((item) => item.id));
const afterIds = (() => {
  const record = preservedAfter as { productContext?: { items?: readonly { id?: unknown }[] } };
  return (record.productContext?.items ?? []).map((item) => String(item.id));
})();
const newlySelected = afterIds.filter((id) => !selectedIds.has(id));

const failures = rows.filter((row) => !row.pathologyAgrees || !row.deliveryAgrees);
const allPass = failures.length === 0 && identityHolds && newlySelected.length === 0;

writeFileSync(path.join(RESULTS, "stage5_m175_echo_classifier_controls.json"), `${JSON.stringify({
  schemaVersion: "stage5.m175.echo-controls.v1",
  milestone: "M175",
  workstream: "M175-B",
  requestedContextTokens: DEFAULT_REQUESTED_CONTEXT_TOKENS,
  repairPolicy: REPAIR,
  method:
    "Synthetic authoritative responses, authored pre-compaction, so both policy arms consume the "
    + "same bytes. Each control declares its expected verdict before it runs.",
  controls: rows,
  identityControl: {
    description: "A response with no request block must survive the repair byte-identical.",
    holds: identityHolds,
    beforeCharacters: identityBefore.length,
    afterCharacters: identityAfter.length,
  },
  refillControl: {
    description: "§49 — freed budget must restore previously selected evidence and attract nothing new.",
    selectedItemIds: [...selectedIds],
    deliveredAfterRepair: afterIds,
    newlySelectedDueToFreeSpace: newlySelected,
    holds: newlySelected.length === 0,
  },
  verdict: allPass ? "CONTROLS_PASS" : "CONTROLS_FAIL",
  failures: failures.map((row) => ({
    name: row.name, expected: row.expected, observed: row.observed,
    expectRepairRestoresDelivery: row.expectRepairRestoresDelivery,
    repairRestoredDelivery: row.repairRestoredDelivery,
  })),
}, null, 2)}\n`);

for (const row of rows) {
  const mark = row.pathologyAgrees && row.deliveryAgrees ? "PASS" : "FAIL";
  console.log(
    `${mark}  ${row.name.padEnd(28)} expected=${row.expected.padEnd(24)} observed=${row.observed.padEnd(24)}`
    + ` delivered ${row.beforeDelivered}→${row.afterDelivered}`
    + ` tokens ${row.beforeTotalTokens}→${row.afterTotalTokens}/${row.ceilingTokens}`,
  );
}
console.log("");
console.log(`identity control (no request block, byte-identical)  ${identityHolds ? "PASS" : "FAIL"}`);
console.log(`refill control (no new evidence attracted)          ${newlySelected.length === 0 ? "PASS" : "FAIL"}`);
console.log("");
console.log("wrote results/stage5_m175_echo_classifier_controls.json");
console.log(`CONTROLS ${allPass ? "PASS" : "FAIL"}`);
if (!allPass) process.exitCode = 1;
