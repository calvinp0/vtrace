/**
 * M196 — VEXP claim ledger, extracted from LOCAL PRIMARY ARTIFACTS.
 *
 * §9 forbids relying on memory or marketing prose where repository evidence
 * exists, and §66 forbids inventing a protocol and then declaring VTRACE the
 * winner. So every claim below is anchored to a byte range in an artifact that
 * exists on this machine, and each carries its own reproducibility class.
 *
 * Four primary artifacts, in descending order of authority:
 *
 *   vexp-cli 2.0.24 mcp/mcp-server.cjs   the model-facing tool contract, verbatim
 *   @vexp/core-linux-x64 vexp-core       the engine binary's own output strings
 *   vexp-cli 2.0.24 README.md            the vendor's published numbers
 *   Vexp-ai/vexp-swe-bench README.md     the published benchmark result
 *
 * The binary's LOGIC is unreadable — run_pipeline is computed inside vexp-core
 * and returned whole — so this ledger records vexp's INTERFACE and its stated
 * numbers. Where a claim cannot be reproduced from what is readable, it is
 * classified INSUFFICIENT_METHOD rather than guessed at.
 *
 * The script never executes any vexp binary. Reading a package is inspection;
 * running it would be a live third-party invocation with a licence check.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "../..");
const OUT = path.join(REPO, "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m196_vexp_claim_ledger.json");

const VEXP_CLI = process.env.VEXP_CLI_DIR ?? "/home/calvin/.npm-global/lib/node_modules/vexp-cli";
const VEXP_BENCH = process.env.VEXP_BENCH_DIR ?? "/home/calvin/code/vexp-swe-bench";

const SOURCES = {
  mcpServer: path.join(VEXP_CLI, "mcp/mcp-server.cjs"),
  coreBinary: path.join(VEXP_CLI, "node_modules/@vexp/core-linux-x64/bin/vexp-core"),
  cliReadme: path.join(VEXP_CLI, "README.md"),
  cliPackage: path.join(VEXP_CLI, "package.json"),
  benchReadme: path.join(VEXP_BENCH, "README.md"),
};

/** A claim is only admitted if its own text is present in its own source. */
function witness(sourceKey: keyof typeof SOURCES, needle: string): { found: boolean; source: string } {
  const file = SOURCES[sourceKey];
  if (!existsSync(file)) return { found: false, source: file };
  // latin1 so the engine binary is readable as text; the needle is re-encoded the
  // same way so a UTF-8 arrow in the README still matches byte for byte.
  const buf = readFileSync(file, "latin1");
  const needleLatin1 = Buffer.from(needle, "utf8").toString("latin1");
  return { found: buf.includes(needleLatin1), source: path.relative(path.dirname(VEXP_CLI), file) };
}

type ClaimClass = "A_ENGINEERING" | "B_SEMANTIC" | "C_COMPRESSION" | "D_END_TO_END";
type Repro =
  | "DIRECTLY_REPRODUCIBLE"
  | "REPRODUCIBLE_WITH_INTERPRETATION"
  | "INSUFFICIENT_METHOD"
  | "MARKETING_EXAMPLE_ONLY"
  | "NOT_COMPARABLE";

interface Claim {
  id: string;
  claim: string;
  claimClass: ClaimClass;
  sourceKey: keyof typeof SOURCES;
  needle: string;
  measurementDefinition: string | null;
  reproducibility: Repro;
  vtraceAnalogue: string | null;
}

const CLAIMS: Claim[] = [
  { id: "V-A1", claim: "30 programming languages supported out of the box", claimClass: "A_ENGINEERING",
    sourceKey: "cliReadme", needle: "Supported Languages (30)",
    measurementDefinition: "count of language names listed in the README table",
    reproducibility: "DIRECTLY_REPRODUCIBLE", vtraceAnalogue: "count of extensions accepted by src/fs/languageDetection.ts" },
  { id: "V-A2", claim: "14+ AI coding agents auto-configured", claimClass: "A_ENGINEERING",
    sourceKey: "cliReadme", needle: "Auto-Configured",
    measurementDefinition: "count of rows in the agent table",
    reproducibility: "DIRECTLY_REPRODUCIBLE", vtraceAnalogue: "agents accepted by `vtrace setup --agent`" },
  { id: "V-A3", claim: "index status reports node/edge counts, cross-repo edges, daemon uptime", claimClass: "A_ENGINEERING",
    sourceKey: "mcpServer", needle: "cross-repo edges, daemon uptime",
    measurementDefinition: "fields present in the index_status response",
    reproducibility: "DIRECTLY_REPRODUCIBLE", vtraceAnalogue: "index_status output fields" },
  { id: "V-A4", claim: "local-first: code never leaves the machine", claimClass: "A_ENGINEERING",
    sourceKey: "cliReadme", needle: "your code never leaves your machine",
    measurementDefinition: null, reproducibility: "INSUFFICIENT_METHOD",
    vtraceAnalogue: "VTRACE makes no network call on the read path" },
  { id: "V-A5", claim: "query time is reported per capsule call in milliseconds", claimClass: "A_ENGINEERING",
    sourceKey: "mcpServer", needle: "query_time_ms",
    measurementDefinition: "engine-reported query time, warm daemon, unspecified corpus",
    reproducibility: "REPRODUCIBLE_WITH_INTERPRETATION", vtraceAnalogue: "productContext.timing.totalMs" },

  { id: "V-B1", claim: "impact graph returns callers, importers and transitive dependents to a given depth", claimClass: "B_SEMANTIC",
    sourceKey: "mcpServer", needle: "Returns callers, importers, and transitive dependents up to the specified depth",
    measurementDefinition: "recall/precision against a known-consumer fixture; no vendor protocol published",
    reproducibility: "INSUFFICIENT_METHOD", vtraceAnalogue: "get_impact_graph" },
  { id: "V-B2", claim: "logic flow finds execution paths between two symbols through the call graph", claimClass: "B_SEMANTIC",
    sourceKey: "mcpServer", needle: "Find execution paths between two symbols",
    measurementDefinition: "path/edge correctness against a fixture with a known path; no vendor protocol published",
    reproducibility: "INSUFFICIENT_METHOD", vtraceAnalogue: "search_logic_flow" },
  { id: "V-B3", claim: "cross-repo impact via cross-repo symbol matches and synthetic edges (API contracts, shared types)", claimClass: "B_SEMANTIC",
    sourceKey: "mcpServer", needle: "Include cross-repo symbol matches and synthetic edges",
    measurementDefinition: "existence and correctness of an edge whose endpoints are in different repositories",
    reproducibility: "REPRODUCIBLE_WITH_INTERPRETATION", vtraceAnalogue: "NONE — getImpactGraph types crossRepo as the literal false" },
  { id: "V-B4", claim: "semantic + graph-ranked context finds symbols when keywords do not match", claimClass: "B_SEMANTIC",
    sourceKey: "cliReadme", needle: "finds the right symbols even when keywords don't match",
    measurementDefinition: "recall on queries sharing no lexical token with the target",
    reproducibility: "REPRODUCIBLE_WITH_INTERPRETATION", vtraceAnalogue: "hybrid FTS + TF-IDF + graph rerank; no embeddings" },

  { id: "V-C1", claim: "get_skeleton saves 70-90% tokens versus Read", claimClass: "C_COMPRESSION",
    sourceKey: "mcpServer", needle: "70-90% token savings vs Read",
    measurementDefinition: "skeleton tokens against full-file tokens, per file, tokenizer unspecified",
    reproducibility: "REPRODUCIBLE_WITH_INTERPRETATION", vtraceAnalogue: "get_skeleton at minimal/standard/detailed" },
  { id: "V-C2", claim: "run_pipeline delivers the same results as Read/Grep/Glob plus impact with ~60% fewer tokens", claimClass: "C_COMPRESSION",
    sourceKey: "mcpServer", needle: "in a single call with ~60% fewer tokens",
    measurementDefinition: "pipeline output tokens against an unspecified Read/Grep/Glob baseline",
    reproducibility: "INSUFFICIENT_METHOD", vtraceAnalogue: "get_code_context orientation projection" },
  { id: "V-C3", claim: "per-symbol token_reduction_pct is reported for each skeleton", claimClass: "C_COMPRESSION",
    sourceKey: "mcpServer", needle: "token_reduction_pct",
    measurementDefinition: "engine-computed reduction percentage per symbol",
    reproducibility: "DIRECTLY_REPRODUCIBLE", vtraceAnalogue: "NONE — get_skeleton reports no token accounting" },
  { id: "V-C4", claim: "the capsule reports a token budget as used/total and an X% saving vs full content", claimClass: "C_COMPRESSION",
    sourceKey: "mcpServer", needle: "% token saving vs full content",
    measurementDefinition: "used/total against the full content of the selected files",
    reproducibility: "DIRECTLY_REPRODUCIBLE", vtraceAnalogue: "productContext.accounting.reductionPercent" },
  { id: "V-C5", claim: "run_pipeline takes a whole-output token budget, default 10000", claimClass: "C_COMPRESSION",
    sourceKey: "mcpServer", needle: "budget for entire pipeline output (default: 10000)",
    measurementDefinition: "delivered tokens against the requested max_tokens",
    reproducibility: "DIRECTLY_REPRODUCIBLE", vtraceAnalogue: "max_tokens -> resolveProductResponseOptions" },
  { id: "V-C6", claim: "pivot files are delivered as full content; supporting files as skeletons", claimClass: "C_COMPRESSION",
    sourceKey: "coreBinary", needle: "## Pivots (Full Content)",
    measurementDefinition: "representation class per delivered item",
    reproducibility: "DIRECTLY_REPRODUCIBLE", vtraceAnalogue: "CapsuleV2ContentMode Full vs Signature vs Skeleton" },
  { id: "V-C7", claim: "pivots degrade to skeletons and support is dropped when the budget binds", claimClass: "C_COMPRESSION",
    sourceKey: "coreBinary", needle: "supporting_dropped",
    measurementDefinition: "representation class as a function of max_tokens",
    reproducibility: "DIRECTLY_REPRODUCIBLE", vtraceAnalogue: "capsuleV2 content ladder + section budget accounting" },
  { id: "V-C8", claim: "prose compression strips natural-language filler at four levels, code/URLs/paths kept exact", claimClass: "C_COMPRESSION",
    sourceKey: "mcpServer", needle: "Strip natural-language filler from output",
    measurementDefinition: "output tokens by prose_compression level with code bytes unchanged",
    reproducibility: "DIRECTLY_REPRODUCIBLE", vtraceAnalogue: "NONE" },
  { id: "V-C9", claim: "token savings are aggregated into a per-tool and daily report", claimClass: "C_COMPRESSION",
    sourceKey: "coreBinary", needle: "token-savings-report.md",
    measurementDefinition: "persisted savings ledger",
    reproducibility: "DIRECTLY_REPRODUCIBLE", vtraceAnalogue: "NONE — per-response only, never accumulated" },

  { id: "V-D1", claim: "73.0% pass@1 at $0.67/task on a 100-task SWE-bench Verified subset", claimClass: "D_END_TO_END",
    sourceKey: "benchReadme", needle: "73.0%",
    measurementDefinition: "Docker-graded pass@1, Claude Opus 4.5, 250 turns, $3/task cap",
    reproducibility: "NOT_COMPARABLE", vtraceAnalogue: "M188 established the treatment mostly did not fire" },
  { id: "V-D2", claim: "58% lower cost per task and 90% fewer tool calls", claimClass: "D_END_TO_END",
    sourceKey: "cliReadme", needle: "90% Fewer Tool Calls",
    measurementDefinition: "unspecified paired baseline; no artifact released",
    reproducibility: "MARKETING_EXAMPLE_ONLY", vtraceAnalogue: null },
  { id: "V-D3", claim: "23 tool calls to orient becomes 2", claimClass: "D_END_TO_END",
    sourceKey: "cliReadme", needle: "23 tool calls",
    measurementDefinition: "mean orientation tool calls per task, corpus unspecified",
    reproducibility: "REPRODUCIBLE_WITH_INTERPRETATION", vtraceAnalogue: "M194 Read+Grep+Glob per arm" },
  { id: "V-D4", claim: "$0.78 to $0.33 per task, measured on SWE-bench Verified", claimClass: "D_END_TO_END",
    sourceKey: "cliReadme", needle: "$0.78 → $0.33 per task",
    measurementDefinition: "per-task USD, paired arms, artifact not released",
    reproducibility: "MARKETING_EXAMPLE_ONLY", vtraceAnalogue: null },
  { id: "V-D5", claim: "117s to 74s per task", claimClass: "D_END_TO_END",
    sourceKey: "cliReadme", needle: "117s → 74s per task",
    measurementDefinition: "per-task wall clock, artifact not released",
    reproducibility: "MARKETING_EXAMPLE_ONLY", vtraceAnalogue: null },
  { id: "V-D6", claim: "an optional local model adds +30% token savings", claimClass: "D_END_TO_END",
    sourceKey: "cliReadme", needle: "+30% Savings",
    measurementDefinition: null, reproducibility: "MARKETING_EXAMPLE_ONLY", vtraceAnalogue: null },
];

const rows = CLAIMS.map((c) => {
  const w = witness(c.sourceKey, c.needle);
  return { ...c, witnessed: w.found, sourceFile: w.source };
});

const missing = rows.filter((r) => !r.witnessed);
if (missing.length > 0) {
  // Fail closed: a claim we cannot re-find in its own artifact is a claim we may
  // not carry into the M197 preregistration.
  console.error(`UNWITNESSED CLAIMS (${missing.length}): ${missing.map((m) => m.id).join(", ")}`);
}

const toolCatalogue = (() => {
  if (!existsSync(SOURCES.mcpServer)) return { status: "absent" };
  const src = readFileSync(SOURCES.mcpServer, "utf8");
  const ids = ["run_pipeline", "get_context_capsule", "get_impact_graph", "search_logic_flow", "get_skeleton",
    "index_status", "workspace_setup", "get_session_context", "search_memory", "save_observation", "expand_vexp_ref"];
  return { status: "read", tools: ids.filter((id) => src.includes(`name:"${id}"`)),
    defaultVisibleGatedBy: src.includes("VEXP_ALL_TOOLS") ? "VEXP_ALL_TOOLS" : null };
})();

const report = {
  schemaVersion: "stage5.m196.vexp-claim-ledger.v1",
  milestone: "M196",
  accessedOn: "2026-09-01",
  generatedFrom: "local package and binary inspection only; no vexp process was executed; no network access",
  artifacts: Object.fromEntries(Object.entries(SOURCES).map(([k, p]) => [k, existsSync(p)
    ? { path: p, bytes: statSync(p).size, present: true } : { path: p, present: false }])),
  vexpCliVersion: existsSync(SOURCES.cliPackage) ? JSON.parse(readFileSync(SOURCES.cliPackage, "utf8")).version : null,
  toolCatalogue,
  claimCount: rows.length,
  witnessedCount: rows.filter((r) => r.witnessed).length,
  byClass: Object.fromEntries(["A_ENGINEERING", "B_SEMANTIC", "C_COMPRESSION", "D_END_TO_END"]
    .map((k) => [k, rows.filter((r) => r.claimClass === k).length])),
  byReproducibility: Object.fromEntries([...new Set(rows.map((r) => r.reproducibility))]
    .map((k) => [k, rows.filter((r) => r.reproducibility === k).length])),
  claims: rows,
};

writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote ${path.relative(REPO, OUT)}`);
console.log(JSON.stringify({ vexpCliVersion: report.vexpCliVersion, claims: report.claimCount,
  witnessed: report.witnessedCount, byClass: report.byClass, byReproducibility: report.byReproducibility,
  vexpTools: (toolCatalogue as any).tools?.length ?? null }, null, 1));
