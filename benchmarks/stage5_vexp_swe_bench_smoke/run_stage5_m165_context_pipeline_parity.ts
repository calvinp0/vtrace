/**
 * M165-A/D — Deterministic get_code_context vs run_pipeline composition parity.
 *
 * M165 was commissioned on the hypothesis that `run_pipeline` composes a richer
 * VEXP-shaped investigation than `get_code_context`, and that M164 measured only
 * the latter. This script tests that hypothesis mechanically, offline, at zero
 * live cost, over the SAME twelve workspaces M164's trigger arm ran against.
 *
 * It reuses the subject's own preparation path (§98): the preserved M163/M164
 * trigger-arm workspaces, indexed by the runner's own `vtrace index` step, spoken
 * to through a REAL `mcp-serve` child process. Nothing is hand-built.
 *
 * Structured truth comes from the JSON-RPC response, not from agent-visible text
 * (§39/§110): the live harness truncates large tool output, the server does not.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const OUT = path.join(RESULTS, "stage5_m165_context_pipeline_parity.json");
const MANIFEST = path.join(RESULTS, "stage5_m163_manifest.json");
const CORPUS = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");
const WORKSPACES = path.join(RESULTS, "workspaces");
const TRIGGER_ARM_PREFIX = "m163_tools_task_trigger_";

/** The tools made visible for this audit: M164's two, plus run_pipeline. */
const VISIBLE_TOOL_IDS = ["get_code_context", "run_pipeline", "get_impact_graph"] as const;

interface Case { readonly instanceId: string; readonly repo: string; readonly baseCommit: string }

function loadCases(): Case[] {
  return (JSON.parse(readFileSync(MANIFEST, "utf8")) as { cases: Case[] }).cases;
}

function loadProblemStatements(ids: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(CORPUS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { instance_id: string; problem_statement: string };
    if (ids.has(row.instance_id)) out.set(row.instance_id, row.problem_statement);
  }
  return out;
}

/** Digest ONLY repository index files; session state may legitimately move on a read. */
function digestIndex(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const hash = createHash("sha256");
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.startsWith("index.")) continue;
    const full = path.join(dir, entry);
    hash.update(entry).update(String(statSync(full).size)).update(readFileSync(full));
  }
  return hash.digest("hex");
}

async function speak(repoRoot: string, messages: readonly unknown[]): Promise<Record<string, any>[]> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "bun",
      ["src/mcp/server.ts", "mcp-serve", "--repo", repoRoot, "--tools", VISIBLE_TOOL_IDS.join(",")],
      { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
    );
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

/** Component status vocabulary (§37), derived from the product's own skip reasons. */
function componentStatus(included: boolean, skipReason: string | null | undefined): string {
  if (included) return "DELIVERED";
  if (skipReason === null || skipReason === undefined) return "NOT_OBSERVED";
  if (skipReason.includes("not_requested") || skipReason.includes("intent_deemphasized")
    || skipReason.includes("no_session_requested")) return "NOT_APPLICABLE";
  if (skipReason.includes("no_relevant") || skipReason.includes("no_dependents")) return "NO_RELEVANT_EVIDENCE";
  if (skipReason.includes("error")) return "FAILED";
  return "NOT_OBSERVED";
}

function summarize(payload: any) {
  const pc = payload?.productContext ?? {};
  const items = (pc.items ?? []) as any[];
  return {
    topLevelKeys: Object.keys(payload ?? {}).sort(),
    leadPivot: pc.leadPivot ?? null,
    resultState: pc.resultState ?? null,
    itemPaths: items.map((i) => i.path),
    itemFqNames: items.map((i) => i.fqName ?? null),
    roleCounts: pc.roleCounts ?? null,
    itemRoles: items.map((i) => (i.roles ?? []).join("+")),
    skeletonFallbacks: items.map((i) => i.metadata?.skeletonFallback ?? null).filter(Boolean),
    modelVisibleContextChars: (pc.modelVisibleContext ?? "").length,
    modelVisibleContextHash: createHash("sha256").update(pc.modelVisibleContext ?? "").digest("hex").slice(0, 16),
    intent: payload?.intent?.selectedIntent ?? null,
    preset: payload?.intent?.selectedPreset ?? null,
    intentConfidence: payload?.intent?.confidence ?? null,
    components: {
      impact: { status: componentStatus(payload?.impact?.included, payload?.impact?.skipReason), skipReason: payload?.impact?.skipReason ?? null, candidatesConsidered: payload?.impact?.candidatesConsidered ?? 0, matchedCandidates: payload?.impact?.matchedCandidates ?? 0 },
      flow: { status: componentStatus(payload?.flow?.included, payload?.flow?.skipReason), skipReason: payload?.flow?.skipReason ?? null },
      memorySession: { status: componentStatus(payload?.memory?.session?.included, payload?.memory?.session?.skipReason), skipReason: payload?.memory?.session?.skipReason ?? null },
      memoryDurable: { status: componentStatus(payload?.memory?.durable?.included, payload?.memory?.durable?.skipReason), skipReason: payload?.memory?.durable?.skipReason ?? null },
      memoryCapsuleSurfaced: { status: componentStatus(payload?.memory?.capsuleSurfaced?.included, payload?.memory?.capsuleSurfaced?.skipReason), skipReason: payload?.memory?.capsuleSurfaced?.skipReason ?? null },
      rules: { status: componentStatus(payload?.rules?.included, null), activeCount: payload?.rules?.activeCount ?? 0 },
      pivotNeighborhood: { status: (payload?.pivotNeighborhood ?? []).length > 0 ? "DELIVERED" : "NO_RELEVANT_EVIDENCE", count: (payload?.pivotNeighborhood ?? []).length },
      inspectFirst: { status: payload?.inspectFirst === null || payload?.inspectFirst === undefined ? "NO_RELEVANT_EVIDENCE" : "DELIVERED" },
      deferred: { count: (payload?.deferred?.items ?? []).length },
    },
    accounting: {
      estimatedOutputTokens: payload?.accounting?.estimatedOutputTokens ?? null,
      latencyMs: payload?.accounting?.latencyMs ?? null,
    },
    responseBudget: {
      modelVisibleTokens: payload?.responseBudget?.estimated_model_visible_tokens ?? null,
      metadataTokens: payload?.responseBudget?.estimated_metadata_tokens ?? null,
      totalTokens: payload?.responseBudget?.estimated_total_response_tokens ?? null,
      ceiling: payload?.responseBudget?.total_response_token_ceiling ?? null,
      withinEnvelope: payload?.responseBudget?.within_envelope ?? null,
      serializedChars: payload?.responseBudget?.serialized_response_characters ?? null,
    },
  };
}

async function main() {
  const cases = loadCases();
  const statements = loadProblemStatements(new Set(cases.map((c) => c.instanceId)));
  const rows: any[] = [];

  for (const testCase of cases) {
    const armDir = TRIGGER_ARM_PREFIX + testCase.instanceId.replace(/[^A-Za-z0-9]/g, "_");
    const outer = path.join(WORKSPACES, armDir);
    if (!existsSync(outer)) { rows.push({ instanceId: testCase.instanceId, error: "workspace_missing" }); continue; }
    const inner = readdirSync(outer).filter((e) => statSync(path.join(outer, e)).isDirectory());
    const repoRoot = path.join(outer, inner[0]!);
    const vtraceDir = path.join(repoRoot, ".vtrace");
    const task = statements.get(testCase.instanceId) ?? "";

    const before = digestIndex(vtraceDir);
    const responses = await speak(repoRoot, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m165", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_code_context", arguments: { task, repo_root: repoRoot } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "run_pipeline", arguments: { task, repo_root: repoRoot } } },
    ]);
    const after = digestIndex(vtraceDir);

    const byId = new Map(responses.map((r) => [r.id, r]));
    const visibleTools = (byId.get(2)?.result?.tools ?? []).map((t: any) => t.name).sort();
    const parse = (id: number) => {
      const text = byId.get(id)?.result?.content?.[0]?.text ?? "";
      try { return { payload: JSON.parse(text), chars: text.length, parsed: true }; }
      catch { return { payload: null, chars: text.length, parsed: false }; }
    };
    const gcc = parse(3);
    const rp = parse(4);

    rows.push({
      instanceId: testCase.instanceId,
      repoRoot,
      taskChars: task.length,
      visibleTools,
      indexWrites: before === after ? 0 : 1,
      getCodeContext: gcc.parsed ? { chars: gcc.chars, ...summarize(gcc.payload) } : { chars: gcc.chars, parseFailed: true },
      runPipeline: rp.parsed ? { chars: rp.chars, ...summarize(rp.payload) } : { chars: rp.chars, parseFailed: true },
    });
    console.error(`[m165] ${testCase.instanceId}: gcc=${gcc.chars} rp=${rp.chars} writes=${before === after ? 0 : 1}`);
  }

  const compared = rows.filter((r) => r.getCodeContext?.leadPivot !== undefined && r.runPipeline?.leadPivot !== undefined);
  const sameLead = compared.filter((r) => JSON.stringify(r.getCodeContext.leadPivot) === JSON.stringify(r.runPipeline.leadPivot));
  const sameItems = compared.filter((r) => JSON.stringify(r.getCodeContext.itemPaths) === JSON.stringify(r.runPipeline.itemPaths));
  const sameMvc = compared.filter((r) => r.getCodeContext.modelVisibleContextHash === r.runPipeline.modelVisibleContextHash);
  const sameComponents = compared.filter((r) => JSON.stringify(r.getCodeContext.components) === JSON.stringify(r.runPipeline.components));

  const payload = {
    schemaVersion: 1,
    milestone: "M165",
    workstream: "A/D",
    title: "Deterministic get_code_context vs run_pipeline composition parity",
    preparation: {
      workspaces: "preserved M163/M164 trigger-arm workspaces, indexed by the runner's own index step",
      handBuiltFixture: false,
      transport: "real mcp-serve child process over stdio JSON-RPC",
      structuredTruth: "JSON-RPC response payload, not agent-visible truncated text",
    },
    denominators: { cases: rows.length, compared: compared.length },
    parity: {
      sameLeadPivot: `${sameLead.length}/${compared.length}`,
      sameItemPaths: `${sameItems.length}/${compared.length}`,
      sameModelVisibleContext: `${sameMvc.length}/${compared.length}`,
      sameComponentStatuses: `${sameComponents.length}/${compared.length}`,
    },
    indexWrites: rows.reduce((sum, r) => sum + (r.indexWrites ?? 0), 0),
    cases: rows,
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 1));
  console.error(`\n[m165] wrote ${OUT}`);
  console.error(`[m165] sameLead=${sameLead.length}/${compared.length} sameItems=${sameItems.length}/${compared.length} sameMVC=${sameMvc.length}/${compared.length} sameComponents=${sameComponents.length}/${compared.length}`);
}

await main();
