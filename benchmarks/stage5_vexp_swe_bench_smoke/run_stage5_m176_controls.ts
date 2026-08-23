/**
 * M176-B / M176-D — controls for response-envelope totality.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m176_controls.ts
 *
 * Every control declares its expected outcome BEFORE it runs, and the script
 * exits non-zero if any of them disagrees.
 *
 * TWO CHECKOUTS, ONE WORKSPACE. The `before` arm is served by a worktree pinned to
 * the pre-repair commit and the `after` arm by this one, both answering against the
 * SAME absolute workspace and the SAME index over the real MCP stdio transport. So
 * the known-positive control is not a claim about what the code would do — it is
 * the product failing, and then not failing, on the same bytes.
 *
 * WHY REAL TRANSPORT FOR THE PATHOLOGY AND SYNTHETICS FOR THE SEMANTICS. The crash
 * has to be shown where it actually reaches a caller: as `handler_failed` on the
 * wire, not as a thrown Error in a unit test. But the semantic controls — empty
 * retrieval, unready index, a genuine internal fault — need states the corpus does
 * not happen to contain, so they are authored pre-compaction where ground truth is
 * known by construction.
 *
 * Offline. Local index reads only; no agent, no Docker, no paid API.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadProblemStatements } from "./m175Capture";
import { compactOutcome, envelopeFloorTokens, isRecord, PROVIDER_TOKENS_PER_CHARACTER } from "./m176Envelope";
import type { JsonRecord } from "./m176Envelope";
import { McpResponseDetail } from "../../src/mcp/responseEnvelope";
import { projectOrientationDecline } from "../../src/runPipeline/orientationDecline";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const DATASET = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");

/** The pre-repair checkout. Created by M176; nothing else owns it. */
const PRE_REPAIR_ROOT = "/home/calvin/bench/vtrace-m176/pre-repair";

/**
 * The known positive (§18): an ordinary corpus case, an ordinary problem
 * statement, and a valid `max_tokens` at which the pre-repair product throws.
 * Found by measurement, not construction — M176-A's floor search put this
 * response's floor at 193 estimator tokens against a minimum ceiling of 1,000.
 */
const KNOWN_POSITIVE = {
  instanceId: "pytest-dev__pytest-10081",
  repoRoot: path.join(RESULTS, "workspaces/m160_broad_b/pytest-dev__pytest-10081"),
  symbolFqn: "src/_pytest/debugging.py::_enter_pdb",
};

/** Budgets spanning the threshold: far below, below, at, above, far above (§19). */
const BOUNDARY_BUDGETS = [50, 100, 150, 193, 200, 400, 8_000, 32_000] as const;

// ── real MCP transport ──

interface ToolCallResult {
  readonly ok: boolean;
  readonly output: unknown;
  readonly errorCode: string | null;
  readonly errorDetail: string | null;
  readonly structuredCharacters: number;
  readonly textCharacters: number;
  readonly isError: boolean | null;
}

async function callTool(
  cliRoot: string,
  repoRoot: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = 900_000,
): Promise<ToolCallResult> {
  const raw = await new Promise<Record<string, unknown> | null>((resolve) => {
    const child = spawn(
      "bun",
      ["src/cli/index.ts", "mcp-serve", "--repo", repoRoot, "--tools", toolName],
      { cwd: cliRoot, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", () => { /* server logs are not the artifact */ });
    child.on("close", () => {
      clearTimeout(timer);
      for (const line of stdout.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          if (row.id === 100) { resolve(isRecord(row.result) ? row.result : null); return; }
        } catch { /* not a frame */ }
      }
      resolve(null);
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m176-controls", version: "1" } },
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: toolName, arguments: { ...args, repo_root: repoRoot } },
    })}\n`);
    child.stdin.end();
  });

  const content = Array.isArray(raw?.content) ? raw!.content : [];
  const firstText = isRecord(content[0]) && typeof content[0].text === "string" ? content[0].text : "";
  const structured = isRecord(raw?.structuredContent) ? raw!.structuredContent : null;
  const result = isRecord(structured?.result) ? structured!.result : null;
  const error = isRecord(result?.error) ? result!.error : null;
  return {
    ok: result?.ok === true,
    output: result?.output ?? null,
    errorCode: typeof error?.code === "string" ? error.code : null,
    errorDetail: isRecord(error?.details) && typeof error!.details.error === "string" ? error!.details.error : null,
    structuredCharacters: JSON.stringify(structured ?? null).length,
    textCharacters: firstText.length,
    isError: typeof raw?.isError === "boolean" ? raw.isError : null,
  };
}

// ── synthetic responses, for the semantic controls ──

const filler = (characters: number, seed: string): string => {
  const unit = `${seed} `;
  return unit.repeat(Math.ceil(characters / unit.length)).slice(0, characters);
};

/**
 * An authoritative response carrying bulk in a field NO rung of the ladder
 * reduces — M176-A measured `workspaceRouting` as one of ten such fields.
 */
function pressuredResponse(options: {
  readonly irreducibleCharacters: number;
  readonly retrievalFound: boolean;
  readonly ready?: boolean;
  readonly leadPivot?: string;
}): JsonRecord {
  const items = options.retrievalFound
    ? [{
      id: "P1", path: "pkg/pivot.py", symbol: "pivot_function",
      fqName: "pkg/pivot.py::pivot_function", roles: ["pivot"], contentMode: "focused_source",
      lineSpan: { start: 1, end: 40 }, selectionReasons: ["symbol-name match"],
      estimatedTokens: 250, content: filler(1_000, "def pivot_function(self):  # body"),
      metadata: { fqName: "pkg/pivot.py::pivot_function", kind: "function" },
    }]
    : [];
  return {
    schemaVersion: "vtrace.run_pipeline/1",
    request: { query: "investigate the failure", task: "investigate the failure" },
    workspaceRouting: { isWorkspace: false, outcome: "single_repository", reason: filler(options.irreducibleCharacters, "routing considered member") },
    ...(options.ready === undefined ? {} : {
      diagnostics: { freshness: { readiness: { ready: options.ready, reason: options.ready ? "fresh" : "missing_index" } } },
    }),
    productContext: {
      responseVersion: "vtrace.product_context/1",
      resolved: options.retrievalFound,
      task: "@request.task",
      leadPivot: options.leadPivot ?? (options.retrievalFound ? "pkg/pivot.py::pivot_function" : null),
      repository: { worktreeId: "synthetic" },
      freshness: { status: "fresh", reason: "index current" },
      roleCounts: { pivot: items.length, support: 0 },
      items,
      modelVisibleContext: items.length === 0 ? "" : `# VTRACE product context\n\n## [P1] pkg/pivot.py::pivot_function\n\n${items[0]!.content}`,
      diagnostics: {},
    },
  };
}

const declineMarker = (response: unknown): boolean =>
  isRecord(response)
  && isRecord(response.productContext)
  && isRecord(response.productContext.diagnostics)
  && response.productContext.diagnostics.envelopeDecline === true;

const readString = (record: unknown, ...keys: string[]): string => {
  let cursor: unknown = record;
  for (const key of keys) {
    if (!isRecord(cursor)) return "";
    cursor = cursor[key];
  }
  return typeof cursor === "string" ? cursor : "";
};

// ── the controls ──

interface ControlRow {
  readonly name: string;
  readonly why: string;
  readonly expected: string;
  readonly observed: string;
  readonly agrees: boolean;
  readonly detail?: Record<string, unknown>;
}

const rows: ControlRow[] = [];
const record = (row: ControlRow): void => {
  rows.push(row);
  console.log(`${row.agrees ? "PASS" : "FAIL"}  ${row.name.padEnd(38)} expected=${row.expected.padEnd(30)} observed=${row.observed}`);
};

async function main(): Promise<void> {
  if (!existsSync(PRE_REPAIR_ROOT)) {
    throw new Error(
      `M176 needs the pre-repair worktree at ${PRE_REPAIR_ROOT}.\n`
      + "  git worktree add --detach /home/calvin/bench/vtrace-m176/pre-repair eec70c3c\n"
      + `  ln -s ${ROOT}/node_modules ${PRE_REPAIR_ROOT}/node_modules`,
    );
  }
  const statements = loadProblemStatements(DATASET);
  const task = statements.get(KNOWN_POSITIVE.instanceId);
  if (task === undefined) throw new Error(`no problem statement for ${KNOWN_POSITIVE.instanceId}`);

  // ── §18/§19: the known positive and its boundary, through the real transport ──
  console.log("\n── known positive + boundary controls (real MCP transport, two checkouts) ──");
  const boundary: Array<Record<string, unknown>> = [];
  for (const budget of BOUNDARY_BUDGETS) {
    const before = await callTool(PRE_REPAIR_ROOT, KNOWN_POSITIVE.repoRoot, "run_pipeline", { task, max_tokens: budget });
    const after = await callTool(ROOT, KNOWN_POSITIVE.repoRoot, "run_pipeline", { task, max_tokens: budget });
    boundary.push({
      maxTokens: budget,
      before: { ok: before.ok, errorCode: before.errorCode, errorDetail: before.errorDetail, schemaVersion: readString(before.output, "schemaVersion"), characters: JSON.stringify(before.output).length },
      after: { ok: after.ok, errorCode: after.errorCode, errorDetail: after.errorDetail, schemaVersion: readString(after.output, "schemaVersion"), characters: JSON.stringify(after.output).length },
      identical: JSON.stringify(before.output) === JSON.stringify(after.output),
      afterBilledTokens: Math.round(JSON.stringify(after.output).length * PROVIDER_TOKENS_PER_CHARACTER),
    });
    console.log(`  max_tokens=${String(budget).padStart(6)}  before ok=${String(before.ok).padEnd(5)}${before.errorDetail ?? ""}`
      + `  →  after ok=${String(after.ok).padEnd(5)}${readString(after.output, "state") || readString(after.output, "schemaVersion")}`);
  }

  const crashedBefore = boundary.filter((row) => (row.before as Record<string, unknown>).errorDetail === "product_response_envelope_unreachable");
  const stillCrashes = boundary.filter((row) => (row.after as Record<string, unknown>).errorDetail !== null);
  record({
    name: "known_positive_crashes_before",
    why: "The control is only evidence if the unrepaired product genuinely fails on it (§18).",
    expected: "at least one crash",
    observed: `${crashedBefore.length} crashes`,
    agrees: crashedBefore.length > 0,
    detail: { crashingBudgets: crashedBefore.map((row) => row.maxTokens) },
  });
  record({
    name: "known_positive_recovers_after",
    why: "Every budget must terminate in a bounded product response (§44).",
    expected: "0 errors",
    observed: `${stillCrashes.length} errors`,
    agrees: stillCrashes.length === 0,
  });

  // §43/§20: the budgets that already worked must be untouched.
  const previouslyWorking = boundary.filter((row) => (row.before as Record<string, unknown>).ok === true);
  const preservedIdentity = previouslyWorking.filter((row) => row.identical === true);
  record({
    name: "normal_response_identity",
    why: "The safety net must be invisible when it is not needed (§20, §43).",
    expected: `${previouslyWorking.length} identical`,
    observed: `${preservedIdentity.length} identical`,
    agrees: preservedIdentity.length === previouslyWorking.length,
    detail: { changed: previouslyWorking.filter((row) => row.identical !== true).map((row) => row.maxTokens) },
  });

  // §25: the recovered response must not read as an absence claim.
  const recovered = boundary.find((row) => (row.before as Record<string, unknown>).errorDetail === "product_response_envelope_unreachable");
  const recoveredCall = recovered === undefined
    ? null
    : await callTool(ROOT, KNOWN_POSITIVE.repoRoot, "run_pipeline", { task, max_tokens: recovered.maxTokens as number });
  const recoveredState = readString(recoveredCall?.output, "state");
  record({
    name: "recovered_state_is_not_absence",
    why: "The model must not infer 'no relevant matches' where evidence exists (§25).",
    expected: "evidence_found_but_undelivered",
    observed: recoveredState || "(none)",
    agrees: recoveredState === "evidence_found_but_undelivered",
    detail: { payload: recoveredCall?.output ?? null },
  });

  // §39: both MCP representations must carry the same bounded record.
  const textMatchesStructured = recoveredCall !== null
    && recoveredCall.textCharacters > 0
    && recoveredCall.textCharacters === JSON.stringify(recoveredCall.output).length;
  record({
    name: "protocol_both_representations",
    why: "content[0].text and structuredContent must agree; neither full nor empty (§39).",
    expected: "text == serialized output",
    observed: `${recoveredCall?.textCharacters ?? 0} vs ${JSON.stringify(recoveredCall?.output ?? null).length}`,
    agrees: textMatchesStructured,
    detail: { isError: recoveredCall?.isError ?? null, structuredCharacters: recoveredCall?.structuredCharacters ?? 0 },
  });

  // §40: debug is a public tool mode and must terminate too.
  console.log("\n── §40 debug behaviour ──");
  const debugBefore = await callTool(PRE_REPAIR_ROOT, KNOWN_POSITIVE.repoRoot, "run_pipeline", { task, max_tokens: 100, detail: "debug" });
  const debugAfter = await callTool(ROOT, KNOWN_POSITIVE.repoRoot, "run_pipeline", { task, max_tokens: 100, detail: "debug" });
  record({
    name: "debug_terminates",
    why: "detail=debug is public. It may stay richer, but it must not crash (§40).",
    expected: "ok",
    observed: debugAfter.ok ? "ok" : `${debugAfter.errorCode}/${debugAfter.errorDetail}`,
    agrees: debugAfter.ok,
    detail: {
      beforeOk: debugBefore.ok, beforeError: debugBefore.errorDetail,
      afterCharacters: JSON.stringify(debugAfter.output).length,
      afterDeclined: declineMarker(debugAfter.output),
    },
  });

  // ── semantic controls, authored pre-compaction ──
  console.log("\n── semantic controls (synthetic, ground truth by construction) ──");
  const PRESSURE = 200_000;

  const empty = compactOutcome(pressuredResponse({ irreducibleCharacters: PRESSURE, retrievalFound: false }), 8_000);
  record({
    name: "retrieval_empty_stays_empty",
    why: "The new state applies only where evidence exists and cannot be disclosed (§21).",
    expected: "no_result",
    observed: readString(empty.response, "productContext", "resultState") || "(unreachable)",
    agrees: readString(empty.response, "productContext", "resultState") === "no_result"
      && isRecord(empty.response?.productContext) && empty.response!.productContext.retrievalFound === false,
  });

  const unready = compactOutcome(pressuredResponse({ irreducibleCharacters: PRESSURE, retrievalFound: true, ready: false }), 8_000);
  const unreadyPreserved = isRecord(unready.response)
    && isRecord(unready.response.diagnostics)
    && isRecord((unready.response.diagnostics as JsonRecord).freshness)
    && isRecord(((unready.response.diagnostics as JsonRecord).freshness as JsonRecord).readiness)
    && (((unready.response.diagnostics as JsonRecord).freshness as JsonRecord).readiness as JsonRecord).ready === false;
  record({
    name: "readiness_survives_pressure",
    why: "Readiness outranks every other decline state and must not be lost to the ladder (§22).",
    expected: "ready=false preserved",
    observed: unreadyPreserved ? "ready=false preserved" : "lost",
    agrees: unreadyPreserved,
  });

  const hostile = pressuredResponse({ irreducibleCharacters: PRESSURE, retrievalFound: true });
  Object.defineProperty((hostile.productContext as JsonRecord), "items", {
    get() { throw new Error("synthetic_internal_failure"); }, enumerable: true,
  });
  const faulted = compactOutcome(hostile, 8_000);
  record({
    name: "unexpected_error_still_errors",
    why: "The fallback classifies ONE predictable condition; it must not hide bugs (§23, §71).",
    expected: "synthetic_internal_failure",
    observed: faulted.unexpectedError ?? (faulted.reachable ? "swallowed into a response" : "reported as envelope decline"),
    agrees: faulted.unexpectedError !== null && faulted.unexpectedError.includes("synthetic_internal_failure"),
  });

  const longPivot = compactOutcome(pressuredResponse({
    irreducibleCharacters: PRESSURE, retrievalFound: true,
    leadPivot: `pkg/deep.py::${"Nested.".repeat(200)}symbol`,
  }), 8_000);
  const omittedTopMatch = isRecord(longPivot.response?.productContext)
    && longPivot.response!.productContext.topMatchReference === undefined;
  record({
    name: "over_long_top_match_omitted",
    why: "A truncated symbol name is an identity that does not resolve (§30).",
    expected: "omitted",
    observed: omittedTopMatch ? "omitted" : "present",
    agrees: omittedTopMatch,
  });

  // §27: the decline's own size, measured rather than asserted.
  //
  // TWO OBJECTS, AND ONLY ONE OF THEM IS THE ANSWER. `compactProductResponse`
  // returns the AUTHORITATIVE record; what the model receives by default is the
  // projection of it (M172), and §14 requires the boundedness claim to be about
  // what is actually model-facing. So the token target is scored on the projected
  // decline, and the internal record is reported beside it — bounded, larger, and
  // model-facing only at `detail=debug`.
  const declineSizes = [0, 8_000, 120_000].map((budget) => {
    const outcome = compactOutcome(pressuredResponse({ irreducibleCharacters: PRESSURE, retrievalFound: true }), budget);
    const internal = JSON.stringify(outcome.response ?? null).length;
    const projected = JSON.stringify(projectOrientationDecline(outcome.response) ?? null).length;
    return {
      requestedContextTokens: budget,
      internalCharacters: internal,
      internalBilledTokens: Math.round(internal * PROVIDER_TOKENS_PER_CHARACTER),
      characters: projected,
      billedTokens: Math.round(projected * PROVIDER_TOKENS_PER_CHARACTER),
      declined: declineMarker(outcome.response),
    };
  });
  // Measured over the budgets that ACTUALLY decline. At a large enough budget the
  // pressured response fits and is delivered whole, which is §46 working — and
  // scoring that row against a decline's size would be measuring the wrong object.
  const declining = declineSizes.filter((row) => row.declined);
  const largest = declining.length === 0 ? Infinity : Math.max(...declining.map((row) => row.billedTokens));
  record({
    name: "decline_is_bounded",
    why: "The terminal record must be small and deterministic whatever produced it (§27).",
    expected: "<= 200 model-facing billed tokens",
    observed: declining.length === 0 ? "no decline produced" : `${largest} model-facing billed tokens`,
    agrees: declining.length > 0 && largest <= 200,
    detail: {
      sizes: declineSizes,
      decliningBudgets: declining.map((row) => row.requestedContextTokens),
      internalRecordBilledTokens: declining.map((row) => row.internalBilledTokens),
      internalRecordNote: "The authoritative bounded record, model-facing only at detail=debug. "
        + "Bounded by construction but larger than the projection, most of it responseBudget's own "
        + "audit lists.",
    },
  });
  record({
    name: "no_premature_decline",
    why: "A budget large enough to carry the response must still carry it (§46).",
    expected: "delivered at the largest budget",
    observed: declineSizes[declineSizes.length - 1]!.declined ? "declined" : "delivered",
    agrees: declineSizes[declineSizes.length - 1]!.declined === false,
  });

  // §47/§48: monotonicity through the real transport, not only in the unit test.
  const monotone = [] as Array<{ maxTokens: number; rank: number; state: string }>;
  for (const budget of [100, 400, 2_000, 8_000, 32_000]) {
    const call = await callTool(ROOT, KNOWN_POSITIVE.repoRoot, "run_pipeline", { task, max_tokens: budget });
    const schema = readString(call.output, "schemaVersion");
    const state = schema === "run_pipeline.orientation.none/1" ? readString(call.output, "state") : schema;
    monotone.push({ maxTokens: budget, rank: !call.ok ? 0 : schema === "run_pipeline.orientation.none/1" ? 1 : 2, state });
  }
  const monotonic = monotone.every((row, index) => index === 0 || row.rank >= monotone[index - 1]!.rank);
  record({
    name: "envelope_monotonicity",
    why: "A larger envelope must never produce a strictly weaker terminal state (§48).",
    expected: "non-decreasing",
    observed: monotone.map((row) => row.rank).join("≤"),
    agrees: monotonic,
    detail: { ladder: monotone },
  });

  // ── the measured, unrepaired sibling ──
  console.log("\n── sibling defect: get_impact_graph (recorded, NOT repaired) ──");
  const impact: Array<Record<string, unknown>> = [];
  for (const budget of [1, 50, 200, 400, 1_200]) {
    const call = await callTool(ROOT, KNOWN_POSITIVE.repoRoot, "get_impact_graph", {
      symbol_fqn: KNOWN_POSITIVE.symbolFqn, max_tokens: budget, max_edges: 64,
    });
    impact.push({ maxTokens: budget, ok: call.ok, errorCode: call.errorCode, errorDetail: call.errorDetail });
    console.log(`  max_tokens=${String(budget).padStart(5)} ok=${String(call.ok).padEnd(5)} ${call.errorDetail ?? ""}`);
  }
  const impactCrashes = impact.filter((row) => row.errorDetail === "impact_response_envelope_unreachable");
  record({
    name: "sibling_defect_reproduced",
    why: "The same defect class in get_impact_graph, established by reproduction so the next "
      + "milestone can be scoped from a measured defect rather than an analogy.",
    expected: "reproduces",
    observed: `${impactCrashes.length}/${impact.length} budgets crash`,
    agrees: impactCrashes.length > 0,
    detail: { ladder: impact },
  });

  // ── artifacts ──
  const allPass = rows.every((row) => row.agrees);
  const write = (file: string, body: Record<string, unknown>): void => {
    writeFileSync(path.join(RESULTS, file), `${JSON.stringify(body, null, 2)}\n`);
  };

  write("stage5_m176_known_positive.json", {
    schemaVersion: "stage5.m176.known-positive.v1",
    milestone: "M176", workstream: "B",
    question: "Does an ordinary valid request reach handler_failed through envelope pressure, and does it stop?",
    method: "Real MCP stdio transport, two checkouts, one workspace, one index. The before arm is "
      + "the pre-repair commit; the after arm is this one.",
    instanceId: KNOWN_POSITIVE.instanceId,
    repoRoot: KNOWN_POSITIVE.repoRoot,
    preRepairRoot: PRE_REPAIR_ROOT,
    taskCharacters: task.length,
    envelopeFloorTokens: null,
    boundary,
    crashingBudgetsBefore: crashedBefore.map((row) => row.maxTokens),
    crashingBudgetsAfter: stillCrashes.map((row) => row.maxTokens),
    recoveredPayload: recoveredCall?.output ?? null,
  });

  write("stage5_m176_boundary_controls.json", {
    schemaVersion: "stage5.m176.boundary-controls.v1",
    milestone: "M176", workstream: "B",
    question: "Is behaviour deterministic and monotone across the threshold?",
    accountingMethod: "Envelope arithmetic is chars/4, the estimator the product itself applies. "
      + "Billed figures use M166's measured 0.3174 tokens/character and are reporting only.",
    budgets: BOUNDARY_BUDGETS,
    boundary,
    monotonicity: monotone,
    monotonic,
  });

  write("stage5_m176_truthfulness_controls.json", {
    schemaVersion: "stage5.m176.truthfulness-controls.v1",
    milestone: "M176", workstream: "B/C",
    question: "Does the bounded decline say only true things, and refuse to say false ones?",
    controls: rows.filter((row) => [
      "recovered_state_is_not_absence", "retrieval_empty_stays_empty", "readiness_survives_pressure",
      "over_long_top_match_omitted", "decline_is_bounded", "unexpected_error_still_errors",
    ].includes(row.name)),
    declineSizes,
  });

  write("stage5_m176_readiness_controls.json", {
    schemaVersion: "stage5.m176.readiness-controls.v1",
    milestone: "M176", workstream: "B",
    controls: rows.filter((row) => row.name === "readiness_survives_pressure"),
    finding:
      "The ladder's `diagnostics.indexFreshness` rung deletes every object-valued key under "
      + "`diagnostics.freshness`, and `readiness` is one — so under budget pressure the readiness "
      + "record was already gone before any decline could read it, and `readDeclineEvidence` "
      + "defaults a missing record to ready. The terminal record therefore captures the single "
      + "boolean it needs BEFORE the ladder runs. Responses that fit are unaffected.",
  });

  write("stage5_m176_unexpected_error_control.json", {
    schemaVersion: "stage5.m176.unexpected-error-control.v1",
    milestone: "M176", workstream: "B",
    question: "Does the degradation path preserve genuine implementation faults as faults?",
    controls: rows.filter((row) => row.name === "unexpected_error_still_errors"),
    method: "A getter on productContext.items that throws. The fallback is reached only from a "
      + "FAILED MEASUREMENT, never from a caught exception, so an unexpected fault propagates.",
  });

  write("stage5_m176_known_negative.json", {
    schemaVersion: "stage5.m176.known-negative.v1",
    milestone: "M176", workstream: "B",
    question: "Do responses that already fitted come through unchanged?",
    budgetsThatWorkedBefore: previouslyWorking.map((row) => row.maxTokens),
    identicalAfter: preservedIdentity.map((row) => row.maxTokens),
    changed: previouslyWorking.filter((row) => row.identical !== true).map((row) => row.maxTokens),
    holds: preservedIdentity.length === previouslyWorking.length,
  });

  write("stage5_m176_debug_behavior.json", {
    schemaVersion: "stage5.m176.debug-behavior.v1",
    milestone: "M176", workstream: "D",
    question: "Is detail=debug inside or outside the totality guarantee?",
    answer: "Inside. Debug is a public tool mode and routes through the same envelope, so it "
      + "reaches the same terminal record. It remains richer where it fits; it no longer crashes "
      + "where it does not. §16's warning still stands: debug is not an oracle for the default "
      + "path, and this is a claim about debug only.",
    before: { ok: debugBefore.ok, errorCode: debugBefore.errorCode, errorDetail: debugBefore.errorDetail, characters: JSON.stringify(debugBefore.output).length },
    after: { ok: debugAfter.ok, errorCode: debugAfter.errorCode, errorDetail: debugAfter.errorDetail, characters: JSON.stringify(debugAfter.output).length, declined: declineMarker(debugAfter.output) },
  });

  write("stage5_m176_protocol_preservation.json", {
    schemaVersion: "stage5.m176.protocol-preservation.v1",
    milestone: "M176", workstream: "D",
    question: "Do both MCP representations carry the bounded record, compatibly?",
    invariant: "M167: structuredContent is model-facing in the proven client, and content[0].text "
      + "is a total duplicate of the same value. Both are produced from ONE object at "
      + "startServer.ts:592-601, so they cannot disagree by construction; this control checks "
      + "that they in fact do not, and that isError follows the result rather than the payload.",
    controls: rows.filter((row) => row.name === "protocol_both_representations"),
    recovered: recoveredCall === null ? null : {
      isError: recoveredCall.isError,
      textCharacters: recoveredCall.textCharacters,
      structuredCharacters: recoveredCall.structuredCharacters,
      outputCharacters: JSON.stringify(recoveredCall.output).length,
    },
  });

  write("stage5_m176_sibling_defect.json", {
    schemaVersion: "stage5.m176.sibling-defect.v1",
    milestone: "M176", workstream: "A/F",
    status: "CONFIRMED_UNREPAIRED",
    tool: "get_impact_graph",
    source: { file: "src/impact/impactResponseEnvelope.ts", line: 340, message: "impact_response_envelope_unreachable" },
    sourceEvidence:
      "compactImpactProductResponse runs its own degradation ladder — proven-relation projections, "
      + "then unproven call sites worst-confidence-first, then a structured bounded_degradation, "
      + "then canonical edges one at a time — and ends by throwing when the rebuilt budget still "
      + "exceeds either the token ceiling or IMPACT_HARD_SERIALIZED_CHARACTER_CEILING. Structurally "
      + "the same defect as responseEnvelope.ts:420: a deliberate fail-closed ladder with no "
      + "bounded terminal representation for the state it closes on.",
    reproduction: {
      transport: "real MCP stdio, this checkout",
      repoRoot: KNOWN_POSITIVE.repoRoot,
      symbolFqn: KNOWN_POSITIVE.symbolFqn,
      ladder: impact,
      thresholdBetween: [400, 1_200],
    },
    scope:
      "Recorded, not repaired. §34 bounds the product diff to the already-measured run_pipeline "
      + "envelope. §4's invariant is architectural and general; after M176 it is SATISFIED for the "
      + "repaired run_pipeline path and has one known outstanding violation here.",
  });

  write("stage5_m176_pressure_corpus.json", {
    schemaVersion: "stage5.m176.pressure-corpus.v1",
    milestone: "M176", workstream: "B",
    categories: [
      { category: "historical pressure case", source: "M176-A floor search over real captures", cases: [KNOWN_POSITIVE.instanceId] },
      { category: "ordinary corpus cases", source: "Broad100-A/B", cases: "measured in M176-E" },
      { category: "adversarial large-field", source: "synthetic, authored pre-compaction", cases: ["pressuredResponse(200_000 irreducible chars)"] },
      { category: "pathological identity", source: "synthetic", cases: ["1,406-character leadPivot"] },
      { category: "empty retrieval", source: "synthetic", cases: ["retrievalFound=false under pressure"] },
      { category: "repository authority", source: "synthetic", cases: ["readiness.ready=false under pressure"] },
      { category: "unexpected implementation fault", source: "synthetic", cases: ["throwing getter on productContext.items"] },
    ],
    note: "Retrieval was not modified to manufacture any case. The adversarial fixtures exercise "
      + "the formatter and envelope paths directly, as §17 permits.",
  });

  write("stage5_m176_controls.json", {
    schemaVersion: "stage5.m176.controls.v1",
    milestone: "M176", workstream: "B/D",
    verdict: allPass ? "CONTROLS_PASS" : "CONTROLS_FAIL",
    controls: rows,
    failures: rows.filter((row) => !row.agrees).map((row) => row.name),
  });

  console.log(`\nCONTROLS ${allPass ? "PASS" : "FAIL"}  (${rows.filter((row) => row.agrees).length}/${rows.length})`);
  if (!allPass) process.exitCode = 1;
}

await main();
