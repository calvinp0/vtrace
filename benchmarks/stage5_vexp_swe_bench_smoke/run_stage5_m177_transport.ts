/**
 * M177-B/E — the known positive through the REAL MCP transport.
 *
 * M176 proved the analogous `run_pipeline` defect by speaking JSON-RPC to a real
 * `vtrace mcp-serve` process, and recorded this sibling the same way. §14 requires
 * M177 to reproduce and to re-qualify on the same path rather than trusting a
 * direct call into `compactImpactProductResponse`, because the transport is where
 * the throw becomes `handler_failed` and where `structuredContent` and the
 * `content[0].text` fallback are actually serialized.
 *
 * Run once per arm:
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m177_transport.ts \
 *     --arm before --out benchmarks/stage5_vexp_swe_bench_smoke/results
 *
 * Deterministic, offline, no paid API.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI_ENTRY = path.resolve(import.meta.dir, "../../src/cli/index.ts");
const KNOWN_POSITIVE_REPO = path.resolve(
  import.meta.dir,
  "results/workspaces/m160_broad_b/pytest-dev__pytest-10081",
);
const KNOWN_POSITIVE_SYMBOL = "src/_pytest/debugging.py::_enter_pdb";
/** Resolves, but has no relations, no edges and no potential callers (§17). */
const EMPTY_IMPACT_SYMBOL = "src/_pytest/__init__.py::__all__";
const LADDER_BUDGETS = [1, 50, 100, 200, 400, 476, 477, 600, 800, 1_000, 1_200] as const;

interface RpcResponse {
  readonly id: number;
  readonly result?: {
    readonly content?: ReadonlyArray<{ readonly text?: string }>;
    readonly structuredContent?: Record<string, unknown>;
    readonly isError?: boolean;
  };
  readonly error?: Record<string, unknown>;
}

/**
 * One stdio MCP session, torn down with the process. Requests are written up
 * front and stdin closed on a timer, matching the M162 control harness.
 */
async function rpcSession(
  repoRoot: string,
  requests: readonly Record<string, unknown>[],
): Promise<{ responses: RpcResponse[]; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, "mcp-serve", "--repo", repoRoot, "--tools", "get_code_context,get_impact_graph"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", () => {
      const responses: RpcResponse[] = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try { responses.push(JSON.parse(trimmed) as RpcResponse); } catch { /* partial */ }
      }
      resolve({ responses, stderr });
    });
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    setTimeout(() => child.stdin.end(), 20_000);
  });
}

const initialize = (id: number): Record<string, unknown> => ({
  jsonrpc: "2.0", id, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m177-transport", version: "1" } },
});

const callImpact = (id: number, args: Record<string, unknown>): Record<string, unknown> => ({
  jsonrpc: "2.0", id, method: "tools/call",
  params: { name: "get_impact_graph", arguments: args },
});

interface Observation {
  readonly label: string;
  readonly arguments: Record<string, unknown>;
  readonly transportOk: boolean;
  readonly isError: boolean;
  /** The tool-level error code when the server reported one. */
  readonly errorCode: string | null;
  readonly errorDetail: string | null;
  readonly hasStructuredContent: boolean;
  readonly textIsValidJson: boolean;
  readonly textCharacters: number;
  /** Delivered impact facts, read from the parsed payload. */
  readonly resolvedSymbol: string | null;
  readonly retainedEdges: number | null;
  readonly omittedEdges: number | null;
  readonly resultState: string | null;
  readonly deliveredRelations: number | null;
  readonly deliveredNodes: number | null;
  readonly envelopeDecline: boolean;
  readonly callerCoverageStatus: string | null;
  readonly exactCallerCount: number | null;
  readonly deliveredExactCallerCount: number | null;
}

function readObservation(label: string, args: Record<string, unknown>, response: RpcResponse | undefined): Observation {
  const result = response?.result;
  const text = result?.content?.[0]?.text ?? "";
  let parsed: Record<string, unknown> | undefined;
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = undefined; }
  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

  // Two shapes travel on `content[0].text`. A SUCCESS is the impact output
  // itself; a FAILURE is `{code, message, details}`. `structuredContent` wraps
  // both under `result`. Both are read, because M167 established that
  // `content[0].text` is a total duplicate of the structured channel and a
  // milestone that checked only one would not notice the two disagreeing.
  const structured = asRecord(asRecord(result?.structuredContent)?.result);
  const payload = asRecord(structured?.output) ?? (parsed !== undefined && parsed.code === undefined ? parsed : {});
  const error = asRecord(structured?.error) ?? (parsed !== undefined && typeof parsed.code === "string" ? parsed : undefined);

  const budget = asRecord(payload.responseBudget);
  const diagnostics = asRecord(payload.diagnostics);
  const callerCoverage = asRecord(payload.callerCoverage);
  const resolvedSymbol = asRecord(payload.resolvedSymbol);
  const arrayLength = (value: unknown): number | null => Array.isArray(value) ? value.length : null;
  const errorDetails = asRecord(error?.details);

  return {
    label,
    arguments: args,
    transportOk: response !== undefined && response.error === undefined,
    isError: result?.isError === true,
    errorCode: typeof error?.code === "string" ? error.code : null,
    errorDetail: typeof errorDetails?.error === "string"
      ? errorDetails.error
      : typeof error?.message === "string" ? error.message : null,
    hasStructuredContent: result?.structuredContent !== undefined,
    textIsValidJson: parsed !== undefined,
    textCharacters: text.length,
    resolvedSymbol: typeof resolvedSymbol?.fqName === "string" ? resolvedSymbol.fqName : null,
    retainedEdges: typeof budget?.retainedEdges === "number" ? budget.retainedEdges : null,
    omittedEdges: typeof budget?.omittedEdges === "number" ? budget.omittedEdges : null,
    resultState: typeof budget?.resultState === "string" ? budget.resultState : null,
    deliveredRelations: arrayLength(payload.directRelations),
    deliveredNodes: arrayLength(payload.nodes),
    envelopeDecline: diagnostics?.envelopeDecline === true,
    callerCoverageStatus: typeof callerCoverage?.status === "string" ? callerCoverage.status : null,
    exactCallerCount: typeof callerCoverage?.exactCallerCount === "number" ? callerCoverage.exactCallerCount : null,
    deliveredExactCallerCount: typeof callerCoverage?.deliveredExactCallerCount === "number"
      ? callerCoverage.deliveredExactCallerCount
      : null,
  };
}

function argOf(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  const arm = argOf("--arm", "before");
  const out = argOf("--out", path.resolve(import.meta.dir, "results"));
  mkdirSync(out, { recursive: true });

  const requests: Record<string, unknown>[] = [initialize(0)];
  const labels: Array<{ id: number; label: string; args: Record<string, unknown> }> = [];
  let id = 1;

  for (const maxTokens of LADDER_BUDGETS) {
    const args = { symbol_fqn: KNOWN_POSITIVE_SYMBOL, max_tokens: maxTokens };
    labels.push({ id, label: `ladder:max_tokens=${maxTokens}`, args });
    requests.push(callImpact(id, args));
    id += 1;
  }
  // Known negative: the tool's own default budget, no pressure at all.
  const defaultArgs = { symbol_fqn: KNOWN_POSITIVE_SYMBOL };
  labels.push({ id, label: "known_negative:default_budget", args: defaultArgs });
  requests.push(callImpact(id, defaultArgs));
  id += 1;
  // Invalid request: must stay an invalid request, never a bounded decline.
  const invalidArgs = { symbol_fqn: "src/_pytest/debugging.py::does_not_exist_anywhere", max_tokens: 1 };
  labels.push({ id, label: "control:unresolvable_symbol_at_tiny_budget", args: invalidArgs });
  requests.push(callImpact(id, invalidArgs));
  id += 1;
  // Bound violation: max_tokens=0 is outside the declared positive-integer bound.
  const zeroArgs = { symbol_fqn: KNOWN_POSITIVE_SYMBOL, max_tokens: 0 };
  labels.push({ id, label: "control:max_tokens_zero_invalid_request", args: zeroArgs });
  requests.push(callImpact(id, zeroArgs));
  id += 1;
  // §17 empty-impact control. `__all__` resolves and has genuinely no relations,
  // no edges and no potential callers. It must stay a truthful EMPTY impact at
  // both budgets: proving EMPTY_IMPACT is not collapsed into BOUNDED_NONDELIVERY
  // is the whole point, and the tiny-budget row is where a careless repair would
  // dress an honest zero up as a delivery loss.
  for (const [suffix, maxTokens] of [["default_budget", undefined], ["tiny_budget", 1]] as const) {
    const emptyArgs = maxTokens === undefined
      ? { symbol_fqn: EMPTY_IMPACT_SYMBOL }
      : { symbol_fqn: EMPTY_IMPACT_SYMBOL, max_tokens: maxTokens };
    labels.push({ id, label: `control:empty_impact_${suffix}`, args: emptyArgs });
    requests.push(callImpact(id, emptyArgs));
    id += 1;
  }

  const { responses, stderr } = await rpcSession(KNOWN_POSITIVE_REPO, requests);
  const observations = labels.map((entry) =>
    readObservation(entry.label, entry.args, responses.find((response) => response.id === entry.id)));

  // §18 readiness control, in its own session because readiness is a property of
  // the repo binding. An unindexed worktree must keep answering "not ready" —
  // flattening a repository-state failure into a bounded decline would be the
  // repair telling a caller to raise max_tokens when the real remedy is to index.
  const readinessRepo = mkdtempSync(path.join(tmpdir(), "m177-unindexed-"));
  writeFileSync(path.join(readinessRepo, "sample.py"), "def alpha():\n    return 1\n");
  const readinessRequests = [
    initialize(0),
    callImpact(1, { symbol_fqn: "sample.py::alpha", max_tokens: 1 }),
    callImpact(2, { symbol_fqn: "sample.py::alpha" }),
  ];
  const readiness = await rpcSession(readinessRepo, readinessRequests);
  const readinessObservations = [
    readObservation("control:repo_not_ready_tiny_budget", { max_tokens: 1 }, readiness.responses.find((response) => response.id === 1)),
    readObservation("control:repo_not_ready_default_budget", {}, readiness.responses.find((response) => response.id === 2)),
  ];
  rmSync(readinessRepo, { recursive: true, force: true });
  observations.push(...readinessObservations);

  const ladder = observations.filter((observation) => observation.label.startsWith("ladder:"));
  const record = {
    schemaVersion: "stage5.m177.transport.v1",
    milestone: "M177",
    workstream: arm === "before" ? "B" : "E",
    arm,
    transport: "real MCP stdio (vtrace mcp-serve), protocol 2024-11-05",
    repoRoot: KNOWN_POSITIVE_REPO,
    symbolFqn: KNOWN_POSITIVE_SYMBOL,
    reproductionAuthority: {
      note: "everything a future agent needs to reproduce this row for row",
      cliEntry: CLI_ENTRY,
      tools: "get_code_context,get_impact_graph",
      indexPath: `${KNOWN_POSITIVE_REPO}/.vtrace/index.sqlite`,
      requestDefaults: "depth 5, format tree, max_edges 64, max_paths 3 — only max_tokens varies",
    },
    observations,
    tally: {
      valid: observations.length,
      handlerFailures: observations.filter((observation) => observation.isError
        && observation.errorCode === "handler_failed").length,
      envelopeUnreachable: observations.filter((observation) =>
        observation.errorDetail?.includes("impact_response_envelope_unreachable") === true).length,
      envelopeDeclines: observations.filter((observation) => observation.envelopeDecline).length,
      normalResponses: observations.filter((observation) => !observation.isError && !observation.envelopeDecline).length,
      ladderFailing: ladder.filter((observation) => observation.isError).map((observation) => observation.arguments.max_tokens),
      ladderPassing: ladder.filter((observation) => !observation.isError).map((observation) => observation.arguments.max_tokens),
    },
    stderrExcerpt: stderr.slice(0, 2_000),
  };

  const file = path.join(out, `stage5_m177_known_positive_${arm === "before" ? "before" : "after"}_transport.json`);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);

  console.log(`arm=${arm} -> ${file}`);
  for (const observation of observations) {
    const state = observation.isError
      ? `ERROR ${observation.errorCode} ${observation.errorDetail?.slice(0, 60) ?? ""}`
      : `ok chars=${observation.textCharacters} edges=${observation.retainedEdges}/${observation.omittedEdges} state=${observation.resultState}${observation.envelopeDecline ? " DECLINE" : ""}`;
    console.log(`  ${observation.label.padEnd(44)} ${state}`);
  }
  console.log(`handlerFailures=${record.tally.handlerFailures} envelopeUnreachable=${record.tally.envelopeUnreachable} declines=${record.tally.envelopeDeclines}`);
}

await main();
