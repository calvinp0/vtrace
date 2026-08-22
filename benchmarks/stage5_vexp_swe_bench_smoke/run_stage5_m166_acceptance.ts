/**
 * M166-D/E — paired acceptance for the diagnostics detail change.
 *
 * Run once per side of the change (`--side before|after`) against the SAME preserved
 * workspaces and the same task text, then compare with the reconcile step. Retrieval
 * is untouched by this milestone, so selection must be identical; presentation is
 * expected to differ and every difference is reported rather than asserted away.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { extractFacts } from "./m166Compression";
import { ResponseCategory, decompose } from "./m166Taxonomy";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const WORKSPACES = path.join(RESULTS, "workspaces");
const MANIFEST = path.join(RESULTS, "stage5_m163_manifest.json");
const CORPUS = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");
const CAPTURE = path.join(RESULTS, "_m166_acceptance");

const side = (process.argv.find((a) => a.startsWith("--side="))?.split("=")[1] ?? "after") as "before" | "after";
const tokenAuthority = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m166_token_authority.json"), "utf8"));
const CHARS_PER_TOKEN: number = tokenAuthority.calibration.resultCharactersPerToken;
const toTokens = (characters: number): number => Math.round(characters / CHARS_PER_TOKEN);

function digestIndex(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const hash = createHash("sha256");
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.startsWith("index.")) continue;
    hash.update(entry).update(String(statSync(path.join(dir, entry)).size)).update(readFileSync(path.join(dir, entry)));
  }
  return hash.digest("hex");
}

async function speak(repoRoot: string, messages: readonly unknown[]): Promise<Record<string, any>[]> {
  return await new Promise((resolve, reject) => {
    const child = spawn("bun", ["src/cli/index.ts", "mcp-serve", "--repo", repoRoot, "--tools", "get_code_context,run_pipeline"], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("mcp-serve timeout")); }, 300_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(stdout.split("\n").filter((l) => l.trim().startsWith("{")).flatMap((l) => {
        try { return [JSON.parse(l) as Record<string, any>]; } catch { return []; }
      }));
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

/** Everything the acceptance criteria compare, per response. */
function profile(output: any, structuredCharacters: number) {
  const facts = extractFacts(output);
  const decomposition = decompose(output);
  const diagnostics = output?.diagnostics ?? {};
  const budget = output?.responseBudget ?? {};
  return {
    structuredCharacters,
    structuredTokens: toTokens(structuredCharacters),
    /** The envelope's own accounting: whether the response was budget-bound. */
    responseBudget: {
      estimatedTotalResponseTokens: budget.estimated_total_response_tokens ?? null,
      totalResponseTokenCeiling: budget.total_response_token_ceiling ?? null,
      withinEnvelope: budget.within_envelope ?? null,
      compactionApplied: budget.compaction_applied ?? null,
      headroomTokens: typeof budget.total_response_token_ceiling === "number" && typeof budget.estimated_total_response_tokens === "number"
        ? budget.total_response_token_ceiling - budget.estimated_total_response_tokens
        : null,
      compactedFields: budget.compacted_fields ?? [],
      omittedDetailCounts: budget.omitted_detail_counts ?? {},
    },
    categoryTokens: Object.fromEntries(Object.entries(decomposition.byCategory).map(([k, v]) => [k, toTokens(v)])),
    diagnosticsCharacters: JSON.stringify(diagnostics).length,
    diagnosticsMembers: Object.keys(diagnostics).sort(),
    refreshDiagnostics: JSON.stringify(output?.productContext?.freshness?.refreshDiagnostics ?? null),
    /** §54 — selection authority, which must not move. */
    selection: {
      leadPivot: facts.leadPivot,
      itemPaths: facts.itemPaths,
      symbols: facts.symbols,
      roles: facts.roles,
      neighborhoodExcerpts: facts.neighborhoodExcerpts,
      skeletonFacts: facts.skeletonFacts,
      resultState: output?.productContext?.resultState ?? null,
      roleCounts: output?.productContext?.roleCounts ?? null,
    },
    modelVisibleContext: output?.productContext?.modelVisibleContext ?? "",
    evidence: { impactFacts: facts.impactFacts, sourceLines: facts.sourceLines },
    control: {
      componentStatuses: facts.componentStatuses,
      freshnessStatus: facts.freshnessStatus,
      readinessReady: facts.readinessReady,
      degradedState: facts.degradedState,
      absenceClaims: [...new Set(facts.absenceClaims)].sort(),
      authorityLimitations: [...new Set(facts.authorityLimitations)].sort(),
      omissionDisclosures: [...new Set(facts.omissionDisclosures)].sort(),
    },
    provenance: [...new Set(facts.provenanceIdentifiers)].sort(),
  };
}

async function main(): Promise<void> {
  mkdirSync(CAPTURE, { recursive: true });
  const cases = (JSON.parse(readFileSync(MANIFEST, "utf8")) as { cases: { instanceId: string }[] }).cases;
  const ids = new Set(cases.map((c) => c.instanceId));
  const statements = new Map<string, string>();
  for (const line of readFileSync(CORPUS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { instance_id: string; problem_statement: string };
    if (ids.has(row.instance_id)) statements.set(row.instance_id, row.problem_statement);
  }

  const rows: Record<string, unknown>[] = [];
  let indexWrites = 0;
  for (const testCase of cases) {
    const outer = path.join(WORKSPACES, `m163_tools_task_trigger_${testCase.instanceId.replace(/[^A-Za-z0-9]/g, "_")}`);
    if (!existsSync(outer)) continue;
    const inner = readdirSync(outer).filter((e) => statSync(path.join(outer, e)).isDirectory());
    const repoRoot = path.join(outer, inner[0]!);
    const task = statements.get(testCase.instanceId) ?? "";

    const before = digestIndex(path.join(repoRoot, ".vtrace"));
    const responses = await speak(repoRoot, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m166", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_code_context", arguments: { task, repo_root: repoRoot } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_code_context", arguments: { task, repo_root: repoRoot, detail: "debug" } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "run_pipeline", arguments: { task, repo_root: repoRoot } } },
    ]);
    if (before !== digestIndex(path.join(repoRoot, ".vtrace"))) indexWrites += 1;

    const read = (id: number) => {
      const response = responses.find((r) => r.id === id);
      const structured = JSON.stringify(response?.result?.structuredContent ?? null);
      try { return profile(JSON.parse(response?.result?.content?.[0]?.text ?? "null"), structured.length); }
      catch { return null; }
    };
    rows.push({ instanceId: testCase.instanceId, standard: read(2), debug: read(3), runPipeline: read(4) });
    console.error(`[m166-${side}] ${testCase.instanceId}: standard=${(rows[rows.length - 1]!.standard as any)?.structuredTokens} debug=${(rows[rows.length - 1]!.debug as any)?.structuredTokens}`);
  }

  writeFileSync(path.join(CAPTURE, `${side}.json`), JSON.stringify({ side, indexWrites, cases: rows }, null, 1));
  console.error(`[m166-${side}] wrote ${path.join(CAPTURE, `${side}.json`)}; indexWrites=${indexWrites}`);
}

await main();
