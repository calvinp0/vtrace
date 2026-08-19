/**
 * M162-B — direct-MCP controls.
 *
 * Every assertion here is made by speaking real JSON-RPC to a real
 * `vtrace mcp-serve` process over stdio, against real indexed fixtures. Nothing
 * is asserted from code shape, and nothing needs a paid agent.
 *
 * The one thing this cannot prove is that a live Claude runtime discovers and
 * calls these tools; that is the single gated real-spawn control. Everything
 * BELOW that line is proved here first, so that if the spawn fails we know it
 * is the runtime and not the server, the routing, the identity contract, or the
 * result semantics.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m162_mcp_controls.ts \
 *     --out benchmarks/stage5_vexp_swe_bench_smoke/results
 */

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { FROZEN_CALLABLE_TOOL_IDS } from "./m162Callable";

const CLI_ENTRY = path.resolve(import.meta.dir, "../../src/cli/index.ts");
const SCHEMA_VERSION = 1;

// ── JSON-RPC client ─────────────────────────────────────────────────────────

interface RpcResult {
  readonly id: number;
  readonly result?: Record<string, unknown>;
  readonly error?: Record<string, unknown>;
}

interface ToolCallOutcome {
  readonly ok: boolean;
  readonly isError: boolean;
  readonly text: string;
  readonly parsed: Record<string, unknown> | undefined;
  readonly latencyMs: number;
  readonly chars: number;
  readonly estimatedTokens: number;
}

/**
 * Run one stdio MCP session and return the responses.
 *
 * The server is started per session and torn down with it, which is also the
 * per-task lifecycle the pilot uses: no server outlives the workspace it was
 * bound to, so no task can inherit another's binding.
 */
async function rpcSession(
  repoRoot: string,
  requests: readonly Record<string, unknown>[],
  toolIds: readonly string[] = FROZEN_CALLABLE_TOOL_IDS,
): Promise<{ responses: RpcResult[]; stderr: string; latencies: number[] }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, "mcp-serve", "--repo", repoRoot, "--tools", toolIds.join(",")],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    const latencies: number[] = [];
    const sentAt = new Map<number, number>();

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const parsed = JSON.parse(trimmed) as RpcResult;
          const started = sentAt.get(parsed.id);
          if (started !== undefined) {
            latencies[parsed.id] = performance.now() - started;
            sentAt.delete(parsed.id);
          }
        } catch { /* partial line */ }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", () => {
      const responses: RpcResult[] = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try { responses.push(JSON.parse(trimmed) as RpcResult); } catch { /* ignore */ }
      }
      resolve({ responses, stderr, latencies });
    });

    for (const request of requests) {
      sentAt.set(request.id as number, performance.now());
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }
    // Give the server time to answer, then close stdin to end the session.
    setTimeout(() => child.stdin.end(), 4_000);
  });
}

function initializeRequest(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0", id, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m162-controls", version: "1" } },
  };
}

function toolsListRequest(id: number): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/list", params: {} };
}

function toolCallRequest(id: number, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

function readToolOutcome(responses: readonly RpcResult[], id: number, latencies: readonly number[]): ToolCallOutcome {
  const response = responses.find((entry) => entry.id === id);
  const result = response?.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
  const text = result?.content?.[0]?.text ?? "";
  let parsed: Record<string, unknown> | undefined;
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = undefined; }
  return {
    ok: response !== undefined && response.error === undefined,
    isError: result?.isError === true,
    text,
    parsed,
    latencyMs: Math.round((latencies[id] ?? 0) * 100) / 100,
    chars: text.length,
    estimatedTokens: Math.ceil(text.length / 4),
  };
}

/**
 * The four states every callable invocation must land in. Collapsing any two of
 * these is exactly the confusion that made M155 file a product failure as an
 * empty delivery and made M161 initially file a correct refusal as a failure.
 */
type ResultState = "VALID_NONEMPTY" | "VALID_EMPTY" | "DEGRADED_VALID" | "TOOL_ERROR";

/**
 * True when any nested coverage block reports an incomplete index.
 *
 * `failedFiles > 0` and `coverageComplete === false` are emitted by index
 * coverage blocks that appear inside diagnostics/readiness structures, not at
 * the response root.
 */
function hasDegradationSignal(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasDegradationSignal);
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.coverageComplete === false) return true;
  if (typeof record.failedFiles === "number" && record.failedFiles > 0) return true;
  return Object.values(record).some(hasDegradationSignal);
}

function classifyResultState(outcome: ToolCallOutcome): ResultState {
  if (!outcome.ok || outcome.isError) return "TOOL_ERROR";
  const parsed = outcome.parsed;
  if (parsed === undefined) return "TOOL_ERROR";

  const productContext = parsed.productContext as Record<string, unknown> | undefined;
  // The degradation signal is carried by index-coverage blocks nested at several
  // depths rather than by one top-level field, so it is searched for rather than
  // read from a guessed path. Looking in a single expected place is how a
  // degraded repository would silently read as a clean one.
  const degraded = hasDegradationSignal(parsed);

  const items = (productContext?.items ?? []) as unknown[];
  const nodes = (parsed.nodes ?? []) as unknown[];
  const hasEvidence = items.length > 0 || nodes.length > 0
    || typeof (parsed as { resolvedSymbol?: unknown }).resolvedSymbol === "object";

  if (!hasEvidence) return degraded ? "DEGRADED_VALID" : "VALID_EMPTY";
  return degraded ? "DEGRADED_VALID" : "VALID_NONEMPTY";
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, stdio: "ignore" });
}

function writeFixture(root: string, files: ReadonlyArray<[string, string]>): void {
  for (const [relative, content] of files) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(root, ["init", "-q", "."]);
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.email=m162@local", "-c", "user.name=m162", "commit", "-qm", "fixture"]);
}

function indexFixture(root: string): void {
  execFileSync(process.execPath, [CLI_ENTRY, "init", root], { stdio: "ignore" });
  execFileSync(process.execPath, [CLI_ENTRY, "index", root, "--quiet"], { stdio: "ignore" });
}

/** Workspace A: the pricing fixture the M162-A composition contract uses. */
const WORKSPACE_A_FILES: ReadonlyArray<[string, string]> = [
  ["pkg/__init__.py", ""],
  ["pkg/core.py", [
    '"""Core order pricing."""', "", "",
    "class PriceEngine:",
    '    """Computes order totals."""', "",
    "    def __init__(self, rate):",
    "        self.rate = rate", "",
    "    def apply_discount(self, amount, tier):",
    '        """Apply a tier discount to amount."""',
    '        if tier == "gold":',
    "            return amount * 0.8",
    "        return amount", "",
    "    def total(self, amount, tier):",
    "        discounted = self.apply_discount(amount, tier)",
    "        return discounted * (1 + self.rate)", "",
  ].join("\n")],
  ["pkg/api.py", [
    "from pkg.core import PriceEngine", "", "",
    "def checkout(amount, tier, rate=0.2):",
    "    engine = PriceEngine(rate)",
    "    return engine.total(amount, tier)", "",
  ].join("\n")],
];

/**
 * Workspace B is deliberately DISJOINT from A: different package, different
 * symbols, different vocabulary. If a query that can only be satisfied by B
 * returns A's symbols, routing is wrong — and that is a failure a same-shaped
 * fixture pair could not detect.
 */
const WORKSPACE_B_FILES: ReadonlyArray<[string, string]> = [
  ["shipping/__init__.py", ""],
  ["shipping/router.py", [
    '"""Parcel routing."""', "", "",
    "class ParcelRouter:",
    '    """Chooses a carrier for a parcel."""', "",
    "    def __init__(self, carriers):",
    "        self.carriers = carriers", "",
    "    def select_carrier(self, weight_kg, express):",
    '        """Pick a carrier for the given parcel weight."""',
    "        if express:",
    '            return "air"',
    '        return "ground"', "",
  ].join("\n")],
];

/** A repo with one deliberately unparseable file beside valid code. */
const DEGRADED_FILES: ReadonlyArray<[string, string]> = [
  ["lib/__init__.py", ""],
  ["lib/good.py", [
    "class Validator:",
    "    def validate(self, payload):",
    '        """Validate an incoming payload."""',
    "        return bool(payload)", "",
  ].join("\n")],
  // Syntactically invalid Python: contained parse failure must not be fatal.
  ["lib/broken.py", "def broken(:\n    this is not python at all ][\n"],
];

/** A high-degree fixture used to push get_impact_graph toward its bounds. */
function fanOutFiles(callers: number): ReadonlyArray<[string, string]> {
  const files: Array<[string, string]> = [
    ["hub/__init__.py", ""],
    ["hub/core.py", [
      "class Hub:",
      "    def handle(self, event):",
      '        """Central handler every module calls."""',
      "        return event", "",
    ].join("\n")],
  ];
  for (let index = 0; index < callers; index += 1) {
    files.push([`hub/caller_${index}.py`, [
      "from hub.core import Hub", "", "",
      `def call_${index}(event):`,
      "    return Hub().handle(event)", "",
    ].join("\n")]);
  }
  return files;
}

/**
 * Record one contained file-index failure directly in the index.
 *
 * This is fault injection against a THROWAWAY fixture, never a product path:
 * the point is to exercise the degraded-coverage consumer, which is otherwise
 * unreachable from synthetic source.
 */
function injectIndexFailure(repoRoot: string, filePath: string): void {
  execFileSync(process.execPath, [
    "-e",
    `const { Database } = require("bun:sqlite");`
    + `const db = new Database(${JSON.stringify(path.join(repoRoot, ".vtrace", "index.sqlite"))});`
    + `db.run("INSERT INTO file_index_failures (path, language, status, failure_class, message, content_hash, size_bytes)`
    + ` VALUES (?, 'python', 'parse_failed', 'syntax_error', 'M162 synthetic contained failure', 'synthetic', 42)", [${JSON.stringify(filePath)}]);`
    + `db.close();`,
  ], { stdio: "ignore" });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Semantic hash: excludes wall-clock so latency variation cannot fail a control. */
function semanticHash(outcome: ToolCallOutcome): string {
  const parsed = outcome.parsed;
  if (parsed === undefined) return sha256(outcome.text);
  const stripTiming = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripTiming);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (/ms$|latency|duration|elapsed|timing/i.test(key)) continue;
        out[key] = stripTiming(entry);
      }
      return out;
    }
    return value;
  };
  return sha256(JSON.stringify(stripTiming(parsed)));
}

// ── Controls ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf("--out");
  const outDir = path.resolve(outIndex !== -1 && argv[outIndex + 1] !== undefined
    ? argv[outIndex + 1]!
    : "benchmarks/stage5_vexp_swe_bench_smoke/results");
  mkdirSync(outDir, { recursive: true });

  const scratch = mkdtempSync(path.join(os.tmpdir(), "m162-controls-"));
  const productSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  try {
    const workspaceA = path.join(scratch, "workspace-a");
    const workspaceB = path.join(scratch, "workspace-b");
    const degraded = path.join(scratch, "workspace-degraded");
    const fanOut = path.join(scratch, "workspace-fanout");
    for (const [root, files] of [
      [workspaceA, WORKSPACE_A_FILES], [workspaceB, WORKSPACE_B_FILES],
      [degraded, DEGRADED_FILES], [fanOut, fanOutFiles(40)],
    ] as const) {
      mkdirSync(root, { recursive: true });
      writeFixture(root, files);
      indexFixture(root);
    }

    const artifacts: Record<string, unknown> = {};

    // ── Visible tool surface ────────────────────────────────────────────────
    {
      const session = await rpcSession(workspaceA, [initializeRequest(1), toolsListRequest(2)]);
      const listed = ((session.responses.find((entry) => entry.id === 2)?.result
        ?? {}) as { tools?: Array<{ name: string; description: string; inputSchema: unknown }> }).tools ?? [];
      const names = listed.map((tool) => tool.name);
      const frozenChars = listed.reduce(
        (total, tool) => total + JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }).length,
        0,
      );

      const fullSession = await rpcSession(
        workspaceA, [initializeRequest(1), toolsListRequest(2)],
        // Serve the whole visible surface to measure the counterfactual.
        ["get_code_context", "run_pipeline", "index_repo", "check_capsule_staleness",
          "get_context_capsule", "get_impact_graph", "search_logic_flow", "get_skeleton",
          "index_status", "workspace_setup", "get_session_context", "search_memory",
          "save_observation", "expand_vexp_ref"],
      );
      const fullListed = ((fullSession.responses.find((entry) => entry.id === 2)?.result
        ?? {}) as { tools?: Array<{ name: string; description: string; inputSchema: unknown }> }).tools ?? [];
      const fullChars = fullListed.reduce(
        (total, tool) => total + JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }).length,
        0,
      );

      artifacts.visibleToolSurface = {
        servedToolNames: names,
        expectedToolNames: [...FROZEN_CALLABLE_TOOL_IDS],
        exactMatch: names.join(",") === FROZEN_CALLABLE_TOOL_IDS.join(","),
        modelVisibleMcpNames: FROZEN_CALLABLE_TOOL_IDS.map((id) => `mcp__vtrace__${id}`),
        instructionsServed: (session.responses.find((entry) => entry.id === 1)?.result as { instructions?: string } | undefined)?.instructions ?? null,
      };
      artifacts.schemaTokenAccounting = {
        frozenToolCount: listed.length,
        frozenSchemaChars: frozenChars,
        frozenSchemaTokens: Math.ceil(frozenChars / 4),
        fullSurfaceToolCount: fullListed.length,
        fullSurfaceSchemaChars: fullChars,
        fullSurfaceSchemaTokens: Math.ceil(fullChars / 4),
        declinedTokens: Math.ceil(fullChars / 4) - Math.ceil(frozenChars / 4),
        note: "Measured from the SERVED tools/list payload, not from the registry, so it is what the agent's prompt prefix actually carries.",
      };
    }

    // ── Worktree routing ────────────────────────────────────────────────────
    {
      const aSession = await rpcSession(workspaceA, [
        initializeRequest(1),
        toolCallRequest(2, "get_code_context", { task: "gold tier discount applied to an order total", max_tokens: 4000 }),
      ]);
      const bSession = await rpcSession(workspaceB, [
        initializeRequest(1),
        toolCallRequest(2, "get_code_context", { task: "choose a carrier for an express parcel", max_tokens: 4000 }),
      ]);
      const aOut = readToolOutcome(aSession.responses, 2, aSession.latencies);
      const bOut = readToolOutcome(bSession.responses, 2, bSession.latencies);
      const paths = (outcome: ToolCallOutcome): string[] => {
        const items = ((outcome.parsed?.productContext as Record<string, unknown> | undefined)?.items ?? []) as Array<{ path?: string }>;
        return items.map((item) => item.path ?? "").filter(Boolean);
      };
      const aPaths = paths(aOut);
      const bPaths = paths(bOut);
      const repository = (outcome: ToolCallOutcome): Record<string, unknown> =>
        ((outcome.parsed?.productContext as Record<string, unknown> | undefined)?.repository ?? {}) as Record<string, unknown>;

      artifacts.worktreeRouting = {
        workspaceA: { requested: workspaceA, deliveredPaths: aPaths, repository: repository(aOut), resultState: classifyResultState(aOut) },
        workspaceB: { requested: workspaceB, deliveredPaths: bPaths, repository: repository(bOut), resultState: classifyResultState(bOut) },
        aOnlyOwnSymbols: aPaths.length > 0 && aPaths.every((entry) => entry.startsWith("pkg/")),
        bOnlyOwnSymbols: bPaths.length > 0 && bPaths.every((entry) => entry.startsWith("shipping/")),
        noCrossContamination: aPaths.every((entry) => !entry.startsWith("shipping/"))
          && bPaths.every((entry) => !entry.startsWith("pkg/")),
        note: "Two simultaneously existing, deliberately disjoint workspaces. A shared or stale index would surface the other package's paths.",
      };
    }

    // ── Composition, uncompacted and compacted ──────────────────────────────
    for (const [key, maxTokens] of [["directMcpComposition", 8000], ["compactionComposition", 1200]] as const) {
      const session = await rpcSession(workspaceA, [
        initializeRequest(1),
        toolCallRequest(2, "get_code_context", { task: "gold tier discount is wrong when computing the order total", max_tokens: maxTokens }),
      ]);
      const context = readToolOutcome(session.responses, 2, session.latencies);
      const productContext = context.parsed?.productContext as Record<string, unknown> | undefined;
      const items = (productContext?.items ?? []) as Array<{ fqName?: string | null; symbol?: string; path?: string }>;
      // Copy the identifier EXACTLY as returned. Any normalization here would
      // hide the defect this control exists to guard.
      const methodItem = items.find((item) => typeof item.fqName === "string" && item.fqName.includes("."));
      const identifier = methodItem?.fqName ?? null;

      let impact: ToolCallOutcome | undefined;
      if (identifier !== null) {
        const impactSession = await rpcSession(workspaceA, [
          initializeRequest(1),
          toolCallRequest(2, "get_impact_graph", { symbol_fqn: identifier, max_tokens: 1200 }),
        ]);
        impact = readToolOutcome(impactSession.responses, 2, impactSession.latencies);
      }

      artifacts[key] = {
        maxTokens,
        contextResultState: classifyResultState(context),
        compactionTriggered: typeof productContext?.omittedItemCount === "number" && (productContext.omittedItemCount as number) > 0,
        omittedItemCount: productContext?.omittedItemCount ?? 0,
        deliveredItemCount: items.length,
        leadPivot: productContext?.leadPivot ?? null,
        identifierCopiedVerbatim: identifier,
        identifierIsMethod: identifier !== null && /::\w+\.\w+/.test(identifier),
        impactResultState: impact === undefined ? null : classifyResultState(impact),
        impactResolved: impact !== undefined && !impact.isError,
        impactTokens: impact?.estimatedTokens ?? null,
        contextSemanticHash: semanticHash(context),
        composed: identifier !== null && impact !== undefined && !impact.isError,
      };
    }

    // ── Result-state taxonomy ───────────────────────────────────────────────
    {
      const session = await rpcSession(workspaceA, [
        initializeRequest(1),
        // A task with no plausible match in this repository: retrieval misses,
        // which is a SUCCESSFUL call that found nothing.
        toolCallRequest(2, "get_code_context", { task: "kubernetes ingress TLS certificate rotation webhook", max_tokens: 4000 }),
        // Invalid INPUT, not absent evidence.
        toolCallRequest(3, "get_impact_graph", { symbol_fqn: "apply_discount" }),
        toolCallRequest(4, "get_impact_graph", { symbol_fqn: "pkg/core.py::pkg/core.py::PriceEngine.apply_discount" }),
        toolCallRequest(5, "get_impact_graph", { symbol_fqn: "pkg/core.py::PriceEngine.apply_discount" }),
      ]);
      const empty = readToolOutcome(session.responses, 2, session.latencies);
      const localOnly = readToolOutcome(session.responses, 3, session.latencies);
      const doubled = readToolOutcome(session.responses, 4, session.latencies);
      const resolved = readToolOutcome(session.responses, 5, session.latencies);

      // A contained parse failure is recorded in `file_index_failures`; the
      // failure row is injected directly because no ordinary malformed source
      // reliably produces one (tree-sitter yields an ERROR-node tree rather than
      // failing, and invalid UTF-8 is decoded lossily). Injecting the row tests
      // the CONSUMER path, which is the part that must stay truthful.
      injectIndexFailure(degraded, "lib/hidden.py");
      const degradedSession = await rpcSession(degraded, [
        initializeRequest(1),
        toolCallRequest(2, "get_code_context", { task: "Validator validate payload", max_tokens: 4000 }),
      ]);
      const degradedOut = readToolOutcome(degradedSession.responses, 2, degradedSession.latencies);

      artifacts.resultStates = {
        validEmpty: {
          state: classifyResultState(empty),
          transportOk: empty.ok,
          isError: empty.isError,
          note: "A miss is a successful invocation that returned no evidence. It must never be reported as a tool failure.",
        },
        localNameOnly: { state: classifyResultState(localOnly), isError: localOnly.isError, note: "Invalid INPUT, so TOOL_ERROR rather than VALID_EMPTY." },
        doublyPrefixed: { state: classifyResultState(doubled), isError: doubled.isError, note: "The malformed identifier the product used to emit as leadPivot." },
        resolved: { state: classifyResultState(resolved), isError: resolved.isError },
        degradedRepository: {
          state: classifyResultState(degradedOut),
          transportOk: degradedOut.ok,
          isError: degradedOut.isError,
          degradationSurfaced: degradedOut.text.includes("\"coverageComplete\":false")
            || /"failedFiles":\s*[1-9]/.test(degradedOut.text),
          absenceClaim: ((degradedOut.parsed?.productContext as Record<string, unknown> | undefined)
            ?.coverage as Record<string, unknown> | undefined)?.absenceClaim ?? null,
          note: "A contained failure must degrade the coverage claim without failing the call, and must never let a gap read as absence.",
        },
        taxonomyDistinct: classifyResultState(empty) === "VALID_EMPTY"
          && classifyResultState(localOnly) === "TOOL_ERROR"
          && classifyResultState(doubled) === "TOOL_ERROR"
          && classifyResultState(resolved) === "VALID_NONEMPTY",
      };
    }

    // ── Boundedness ─────────────────────────────────────────────────────────
    {
      const session = await rpcSession(fanOut, [
        initializeRequest(1),
        toolCallRequest(2, "get_impact_graph", { symbol_fqn: "hub/core.py::Hub.handle" }),
        // At the tool's own documented maxima — the largest response a caller
        // can legitimately request.
        toolCallRequest(3, "get_impact_graph", { symbol_fqn: "hub/core.py::Hub.handle", max_edges: 2000, depth: 8, max_paths: 16, max_tokens: 20000 }),
        toolCallRequest(4, "get_code_context", { task: "central handler called by every module" }),
        // Beyond them: must be refused, not served.
        toolCallRequest(5, "get_impact_graph", { symbol_fqn: "hub/core.py::Hub.handle", max_edges: 999999, depth: 99, max_paths: 500 }),
      ]);
      const defaults = readToolOutcome(session.responses, 2, session.latencies);
      const adversarial = readToolOutcome(session.responses, 3, session.latencies);
      const context = readToolOutcome(session.responses, 4, session.latencies);
      const overBound = readToolOutcome(session.responses, 5, session.latencies);

      artifacts.boundedness = {
        highDegreeCallers: 40,
        getImpactGraphDefaults: { chars: defaults.chars, estimatedTokens: defaults.estimatedTokens, latencyMs: defaults.latencyMs, state: classifyResultState(defaults) },
        getImpactGraphAtDocumentedMaxima: {
          chars: adversarial.chars, estimatedTokens: adversarial.estimatedTokens,
          latencyMs: adversarial.latencyMs, state: classifyResultState(adversarial),
          requested: { max_edges: 2000, depth: 8, max_paths: 16, max_tokens: 20000 },
          note: "The largest legitimately requestable response, on a 40-caller fan-out.",
        },
        getImpactGraphBeyondBounds: {
          state: classifyResultState(overBound),
          isError: overBound.isError,
          estimatedTokens: overBound.estimatedTokens,
          message: overBound.parsed?.message ?? null,
          refusedRatherThanServed: overBound.isError,
          note: "Hard bounds are the tool's own (depth<=8, max_paths<=16, max_edges<=2000, max_tokens<=20000); an over-limit request is refused cheaply instead of producing an M133-style giant response.",
        },
        getCodeContextDefaults: { chars: context.chars, estimatedTokens: context.estimatedTokens, latencyMs: context.latencyMs, state: classifyResultState(context) },
        note: "Ceilings are the tool's own documented bounds (max_tokens plus its declared metadata allowance); no benchmark-specific limit is invented.",
      };
    }

    // ── Index read-only + session isolation ─────────────────────────────────
    {
      const indexPath = path.join(workspaceA, ".vtrace", "index.sqlite");
      const sessionPath = path.join(workspaceA, ".vtrace", "session.sqlite");
      const fingerprint = (target: string): Record<string, unknown> => {
        if (!existsSync(target)) return { present: false };
        const stat = statSync(target);
        return { present: true, size: stat.size, mtimeMs: stat.mtimeMs, sha256: sha256(readFileSync(target).toString("latin1")) };
      };

      const indexBefore = fingerprint(indexPath);
      const sessionBefore = fingerprint(sessionPath);

      await rpcSession(workspaceA, [
        initializeRequest(1),
        toolCallRequest(2, "get_code_context", { task: "gold tier discount", max_tokens: 4000, sessionId: "m162-session-alpha" }),
        toolCallRequest(3, "get_impact_graph", { symbol_fqn: "pkg/core.py::PriceEngine.apply_discount" }),
      ]);

      const indexAfter = fingerprint(indexPath);
      const sessionAfter = fingerprint(sessionPath);

      // A second, independent session must not see the first one's identity.
      const isolated = await rpcSession(workspaceA, [
        initializeRequest(1),
        toolCallRequest(2, "get_code_context", { task: "gold tier discount", max_tokens: 4000, sessionId: "m162-session-beta" }),
      ]);
      const isolatedOut = readToolOutcome(isolated.responses, 2, isolated.latencies);
      const leakedAlpha = isolatedOut.text.includes("m162-session-alpha");

      artifacts.indexReadOnly = {
        indexBefore, indexAfter,
        indexUnchanged: JSON.stringify(indexBefore) === JSON.stringify(indexAfter),
        indexWritesObserved: JSON.stringify(indexBefore) === JSON.stringify(indexAfter) ? 0 : 1,
        sessionBefore, sessionAfter,
        note: "Repository evidence and product/session state are separate stores; retrieval reads the first and must not write it.",
      };
      artifacts.sessionIsolation = {
        alphaSession: "m162-session-alpha",
        betaSession: "m162-session-beta",
        betaSawAlphaIdentity: leakedAlpha,
        sessionIsolationValid: !leakedAlpha,
        serverLifetime: "one stdio process per session, bound to one workspace at startup and torn down with it",
        note: "No server outlives the workspace it was bound to, so no task or arm can inherit another's binding.",
      };
    }

    const report = {
      schemaVersion: SCHEMA_VERSION,
      milestone: "M162",
      workstream: "B",
      title: "Direct-MCP callable controls",
      productSha,
      method: "Real JSON-RPC over stdio against `vtrace mcp-serve`, on freshly built indexes. No paid agent, no code-shape inference.",
      ...artifacts,
    };

    for (const [name, value] of Object.entries({
      stage5_m162_visible_tool_surface: artifacts.visibleToolSurface,
      stage5_m162_schema_token_accounting: artifacts.schemaTokenAccounting,
      stage5_m162_worktree_routing_controls: artifacts.worktreeRouting,
      stage5_m162_direct_mcp_composition: artifacts.directMcpComposition,
      stage5_m162_compaction_composition: artifacts.compactionComposition,
      stage5_m162_result_state_controls: artifacts.resultStates,
      stage5_m162_tool_boundedness: artifacts.boundedness,
      stage5_m162_index_readonly_controls: artifacts.indexReadOnly,
      stage5_m162_session_isolation: artifacts.sessionIsolation,
    })) {
      writeFileSync(
        path.join(outDir, `${name}.json`),
        `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, milestone: "M162", workstream: "B", productSha, ...(value as object) }, null, 2)}\n`,
      );
    }

    console.log(JSON.stringify({
      visibleExactMatch: (artifacts.visibleToolSurface as Record<string, unknown>).exactMatch,
      frozenSchemaTokens: (artifacts.schemaTokenAccounting as Record<string, unknown>).frozenSchemaTokens,
      fullSurfaceSchemaTokens: (artifacts.schemaTokenAccounting as Record<string, unknown>).fullSurfaceSchemaTokens,
      routingClean: (artifacts.worktreeRouting as Record<string, unknown>).noCrossContamination,
      composed: (artifacts.directMcpComposition as Record<string, unknown>).composed,
      compactedComposed: (artifacts.compactionComposition as Record<string, unknown>).composed,
      compactionTriggered: (artifacts.compactionComposition as Record<string, unknown>).compactionTriggered,
      taxonomyDistinct: (artifacts.resultStates as Record<string, unknown>).taxonomyDistinct,
      indexWrites: (artifacts.indexReadOnly as Record<string, unknown>).indexWritesObserved,
      sessionIsolationValid: (artifacts.sessionIsolation as Record<string, unknown>).sessionIsolationValid,
    }, null, 2));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main();
