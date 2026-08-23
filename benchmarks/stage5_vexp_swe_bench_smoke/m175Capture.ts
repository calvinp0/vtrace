/**
 * M175 — capture authoritative `run_pipeline` snapshots for offline replay.
 *
 * Calls the real MCP server over stdio against an already-indexed workspace and
 * keeps the `detail=debug` result, which is the least-reduced form of the
 * authoritative response the product will hand out. Everything downstream in M175
 * is a pure replay of these bytes.
 *
 * WHY THE RAW PROBLEM STATEMENT. The M171 corpus captures were taken with M103's
 * derived task text, a median of 156-176 characters. The live M173/M174 runs — and
 * any agent that pastes a bug report into `task` — send the raw problem statement,
 * a median of 1,145-1,589 characters with a tail past 24,000. The defect lives in
 * that tail, so measuring it with the short derived text would measure a regime in
 * which it cannot occur.
 *
 * No agent, no Docker, no paid API. Local index reads only.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");

export interface CaptureResult {
  readonly instanceId: string;
  readonly repoRoot: string;
  readonly taskCharacters: number;
  readonly snapshot: unknown;
  readonly error: string | null;
}

/** One `run_pipeline` call at the requested detail, over a fresh stdio server. */
export async function callRunPipeline(
  repoRoot: string,
  task: string,
  detail: "debug" | "standard" | null,
  maxTokens?: number,
  timeoutMs = 900_000,
  /**
   * Which checkout serves the request. `repoRoot` is absolute, so a second
   * checkout answers against the SAME indexed workspace — which is how the
   * before/after arms are held to one corpus and one index.
   */
  cliRoot: string = ROOT,
): Promise<unknown> {
  const args: Record<string, unknown> = { task, repo_root: repoRoot };
  if (detail !== null) args.detail = detail;
  if (maxTokens !== undefined) args.max_tokens = maxTokens;
  const messages: unknown[] = [
    {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2024-11-05", capabilities: {},
        clientInfo: { name: "m175-capture", version: "1" },
      },
    },
    { jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "run_pipeline", arguments: args } },
  ];
  return await new Promise((resolve) => {
    const child = spawn(
      "bun",
      ["src/cli/index.ts", "mcp-serve", "--repo", repoRoot, "--tools", "run_pipeline"],
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
          if (row.id !== 100) continue;
          const structured = (row.result as { structuredContent?: unknown } | undefined)?.structuredContent;
          resolve(structured ?? null);
          return;
        } catch { /* not a frame */ }
      }
      resolve(null);
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

/**
 * Unwrap whichever envelope a capture is wrapped in. The server returns the MCP
 * result envelope; some older captures stored the tool output directly.
 */
export function unwrapOutput(value: unknown): unknown {
  if (value === null || typeof value !== "object") return null;
  const record = value as { result?: { output?: unknown } };
  // The server returns the MCP result envelope; unwrap it when present, and
  // otherwise treat the value as already being the tool output.
  const nested = record.result?.output;
  return nested === undefined ? value : nested;
}

/** Raw SWE-bench problem statements, keyed by instance id. */
export function loadProblemStatements(datasetPath: string): ReadonlyMap<string, string> {
  const statements = new Map<string, string>();
  if (!existsSync(datasetPath)) return statements;
  for (const line of readFileSync(datasetPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line) as { instance_id?: string; problem_statement?: string };
    if (typeof row.instance_id === "string" && typeof row.problem_statement === "string") {
      statements.set(row.instance_id, row.problem_statement);
    }
  }
  return statements;
}

/**
 * The capture budget.
 *
 * WHY IT IS NOT THE DEFAULT 8,000. Compaction runs before any response leaves the
 * server, so a capture taken at the product's own budget is already the wreck we
 * are trying to explain: on the M174 subject `productContext.items` arrives empty
 * and `deliveryFailed` is already true, and no replay can restore evidence that
 * was destroyed before it was written to disk. Capturing above the ceiling keeps
 * the authoritative selection intact so the 8,000-token compaction can be replayed
 * over it under each policy.
 *
 * THE COST OF DOING THIS, AND THE CHECK THAT BOUNDS IT. `max_tokens` also feeds
 * `capsuleBudgetTokens`, so a wider capture is only sound if the wider budget did
 * not change what was SELECTED. That is not assumed — `selectionIdentity()` below
 * compares the two captures field by field, and M175-B fails closed if they differ.
 */
export const CAPTURE_MAX_TOKENS = 120_000;

/** Capture once and cache on disk; re-runs are free and byte-stable. */
export async function captureCached(
  cacheDir: string,
  instanceId: string,
  repoRoot: string,
  task: string,
  maxTokens: number = CAPTURE_MAX_TOKENS,
  suffix = "",
): Promise<CaptureResult> {
  mkdirSync(cacheDir, { recursive: true });
  const safe = instanceId.replace(/[^A-Za-z0-9_.-]/g, "_");
  const file = path.join(cacheDir, `${safe}${suffix}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as CaptureResult;

  let snapshot: unknown = null;
  let error: string | null = null;
  try {
    snapshot = unwrapOutput(await callRunPipeline(repoRoot, task, "debug", maxTokens));
    if (snapshot === null) error = "no_structured_content";
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const result: CaptureResult = {
    instanceId, repoRoot, taskCharacters: task.length, snapshot, error,
  };
  writeFileSync(file, `${JSON.stringify(result)}\n`);
  return result;
}

/**
 * The authoritative selection, as it can be observed from a response at ANY
 * budget. Every field here is decided before the envelope is considered, so two
 * captures that agree on all of them selected the same evidence — §25's canonical
 * pre-delivery identity, checked rather than asserted.
 */
export interface SelectionIdentity {
  readonly leadPivot: string;
  readonly selectedItemsBeforeBudget: number;
  readonly retrievalFound: boolean;
  readonly taskHash: string;
  readonly selectedFileHash: string;
  readonly capsulePivots: readonly string[];
}

export function selectionIdentity(snapshot: unknown): SelectionIdentity {
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const record = isRecord(snapshot) ? snapshot : {};
  const productContext = isRecord(record.productContext) ? record.productContext : {};
  const delivery = isRecord(productContext.delivery) ? productContext.delivery : {};
  const capsule = isRecord(record.capsuleResult) ? record.capsuleResult : {};
  const pivots = Array.isArray(capsule.pivots) ? capsule.pivots : [];
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    leadPivot: str(productContext.leadPivot),
    selectedItemsBeforeBudget: typeof delivery.selectedItemsBeforeBudget === "number"
      ? delivery.selectedItemsBeforeBudget
      : 0,
    retrievalFound: productContext.retrievalFound === true,
    taskHash: str(productContext.taskHash),
    selectedFileHash: str(productContext.selectedFileHash),
    capsulePivots: pivots
      .map((pivot) => (isRecord(pivot) ? str(pivot.fqName) || str(pivot.id) : ""))
      .filter((name) => name !== ""),
  };
}

export const selectionIdentical = (a: SelectionIdentity, b: SelectionIdentity): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * What the DEFAULT path actually hands an agent.
 *
 * Since M172 the default is a projection, so the authoritative envelope is not
 * observable here at all — which is the point of the design and also the reason
 * envelope internals have to be measured at `detail=debug` instead. What IS
 * observable is the only thing the agent cares about: whether a focus and its
 * related evidence arrived, or whether the call declined.
 */
export interface DefaultPathOutcome {
  readonly kind: "orientation" | "decline" | "authoritative" | "not_ready" | "empty";
  readonly schemaVersion: string;
  /** Set when the tool refused. Identical in both arms; excluded from scoring. */
  readonly errorCode: string | null;
  readonly declineState: string | null;
  readonly focusAt: string | null;
  readonly focusFile: string | null;
  readonly relatedCount: number;
  readonly relatedFiles: readonly string[];
  readonly relatedSymbols: readonly string[];
  readonly characters: number;
  readonly billedTokens: number;
}

const PROVIDER_TOKENS_PER_CHARACTER = 0.3174032272551657;

export function readDefaultPath(value: unknown): DefaultPathOutcome {
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const record = isRecord(value) ? value : {};

  // A refused call still arrives wrapped in the MCP envelope, so it reaches here
  // as an object with no schemaVersion. `repo_not_ready` in particular is a
  // property of the workspace and not of the response, and it is identical in
  // both arms — reported, and kept out of every scored denominator.
  const failed = isRecord(record.result) ? record.result : null;
  if (failed !== null && failed.ok === false) {
    const error = isRecord(failed.error) ? failed.error : {};
    const code = typeof error.code === "string" ? error.code : "unknown_error";
    const characters = JSON.stringify(record).length;
    return {
      kind: code === "repo_not_ready" ? "not_ready" : "empty",
      schemaVersion: "", errorCode: code, declineState: null,
      focusAt: null, focusFile: null, relatedCount: 0, relatedFiles: [], relatedSymbols: [],
      characters, billedTokens: Math.max(0, Math.round(characters * PROVIDER_TOKENS_PER_CHARACTER)),
    };
  }
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const schemaVersion = str(record.schemaVersion);
  const characters = JSON.stringify(record).length;
  const billed = Math.max(0, Math.round(characters * PROVIDER_TOKENS_PER_CHARACTER));

  const focus = isRecord(record.focus) ? record.focus : null;
  const related = Array.isArray(record.related) ? record.related.filter(isRecord) : [];

  const kind: DefaultPathOutcome["kind"] = schemaVersion.startsWith("run_pipeline.orientation.none")
    ? "decline"
    : schemaVersion.startsWith("run_pipeline.orientation")
      ? "orientation"
      : record.productContext !== undefined
        ? "authoritative"
        : "empty";

  return {
    kind,
    schemaVersion,
    errorCode: null,
    declineState: kind === "decline" ? str(record.state) : null,
    focusAt: focus === null ? null : str(focus.at),
    focusFile: focus === null ? null : str(focus.file),
    relatedCount: related.length,
    relatedFiles: [...new Set([
      ...(focus === null ? [] : [str(focus.file)]),
      ...related.map((entry) => str(entry.file)),
    ])].filter((file) => file !== ""),
    relatedSymbols: [...new Set([
      ...(focus === null ? [] : [str(focus.at)]),
      ...related.map((entry) => str(entry.at)),
    ])].filter((name) => name !== ""),
    characters,
    billedTokens: billed,
  };
}

/** Capture the default path (no `detail`, no `max_tokens`) — what an agent receives. */
export async function captureDefaultCached(
  cacheDir: string,
  instanceId: string,
  repoRoot: string,
  task: string,
  suffix = ".default",
  cliRoot: string = ROOT,
): Promise<CaptureResult> {
  mkdirSync(cacheDir, { recursive: true });
  const safe = instanceId.replace(/[^A-Za-z0-9_.-]/g, "_");
  const file = path.join(cacheDir, `${safe}${suffix}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as CaptureResult;

  let snapshot: unknown = null;
  let error: string | null = null;
  try {
    snapshot = unwrapOutput(await callRunPipeline(repoRoot, task, null, undefined, 900_000, cliRoot));
    if (snapshot === null) error = "no_structured_content";
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const result: CaptureResult = { instanceId, repoRoot, taskCharacters: task.length, snapshot, error };
  writeFileSync(file, `${JSON.stringify(result)}\n`);
  return result;
}
