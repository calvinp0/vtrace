/**
 * M167-B capture — the whole MCP result, at every boundary, for the 12 reference tasks.
 *
 * M166's acceptance harness profiled the semantic output and measured only the
 * `structuredContent` width. M167 asks a different question, so it must keep more:
 * the RAW JSON-RPC line as it crosses the wire, both representations separately,
 * and the `tools/list` descriptor that is billed once per session rather than once
 * per call (§47). Nothing here interprets; interpretation is the attribution step.
 *
 * Read-only by construction: the index digest is taken before and after every
 * workspace and any change is counted, not tolerated.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const WORKSPACES = path.join(RESULTS, "workspaces");
const MANIFEST = path.join(RESULTS, "stage5_m163_manifest.json");
const CORPUS = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");

const side = process.argv.find((a) => a.startsWith("--side="))?.split("=")[1] ?? "current";
const CAPTURE = path.join(RESULTS, `_m167_capture_${side}`);

function digestIndex(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const hash = createHash("sha256");
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.startsWith("index.")) continue;
    hash.update(entry).update(String(statSync(path.join(dir, entry)).size)).update(readFileSync(path.join(dir, entry)));
  }
  return hash.digest("hex");
}

/** Raw stdout lines, kept as strings so wire width is measured and not reconstructed. */
async function speak(repoRoot: string, messages: readonly unknown[]): Promise<string[]> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "bun",
      ["src/cli/index.ts", "mcp-serve", "--repo", repoRoot, "--tools", "get_code_context,run_pipeline"],
      { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("mcp-serve timeout")); }, 300_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(stdout.split("\n").filter((line) => line.trim().startsWith("{")));
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

interface CapturedCall {
  readonly call: string;
  /** The JSON-RPC line exactly as the server wrote it, including both representations. */
  readonly wireCharacters: number;
  readonly contentText: string | null;
  readonly structuredContent: unknown;
  readonly isError: boolean | null;
  readonly contentBlockCount: number | null;
  readonly contentBlockTypes: readonly string[];
}

function capture(lines: readonly string[], id: number, call: string): CapturedCall | null {
  for (const line of lines) {
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed?.id !== id) continue;
    const content = parsed?.result?.content;
    return {
      call,
      wireCharacters: line.length,
      contentText: Array.isArray(content) && typeof content[0]?.text === "string" ? content[0].text : null,
      structuredContent: parsed?.result?.structuredContent ?? null,
      isError: typeof parsed?.result?.isError === "boolean" ? parsed.result.isError : null,
      contentBlockCount: Array.isArray(content) ? content.length : null,
      contentBlockTypes: Array.isArray(content) ? content.map((b: any) => String(b?.type)) : [],
    };
  }
  return null;
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

  let indexWrites = 0;
  const index: Record<string, unknown>[] = [];

  for (const testCase of cases) {
    const outer = path.join(WORKSPACES, `m163_tools_task_trigger_${testCase.instanceId.replace(/[^A-Za-z0-9]/g, "_")}`);
    if (!existsSync(outer)) { console.error(`[m167-capture] SKIP ${testCase.instanceId}: no workspace`); continue; }
    const inner = readdirSync(outer).filter((e) => statSync(path.join(outer, e)).isDirectory());
    const repoRoot = path.join(outer, inner[0]!);
    const task = statements.get(testCase.instanceId) ?? "";

    const before = digestIndex(path.join(repoRoot, ".vtrace"));
    const lines = await speak(repoRoot, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m167", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_code_context", arguments: { task, repo_root: repoRoot } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_code_context", arguments: { task, repo_root: repoRoot, detail: "debug" } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "run_pipeline", arguments: { task, repo_root: repoRoot } } },
    ]);
    const after = digestIndex(path.join(repoRoot, ".vtrace"));
    if (before !== after) indexWrites += 1;

    const initializeLine = lines.find((l) => { try { return JSON.parse(l)?.id === 1; } catch { return false; } }) ?? null;
    const listLine = lines.find((l) => { try { return JSON.parse(l)?.id === 2; } catch { return false; } }) ?? null;

    const record = {
      instanceId: testCase.instanceId,
      repoRoot,
      indexUnchanged: before === after,
      session: {
        initializeCharacters: initializeLine?.length ?? null,
        toolsListCharacters: listLine?.length ?? null,
        toolDescriptors: listLine === null ? null : (JSON.parse(listLine)?.result?.tools ?? []).map((t: any) => ({
          name: t?.name,
          descriptionCharacters: typeof t?.description === "string" ? t.description.length : null,
          inputSchemaCharacters: JSON.stringify(t?.inputSchema ?? null).length,
          declaresOutputSchema: Object.prototype.hasOwnProperty.call(t ?? {}, "outputSchema"),
        })),
      },
      calls: [
        capture(lines, 3, "get_code_context.standard"),
        capture(lines, 4, "get_code_context.debug"),
        capture(lines, 5, "run_pipeline.standard"),
      ].filter((c): c is CapturedCall => c !== null),
    };

    writeFileSync(path.join(CAPTURE, `${testCase.instanceId}.json`), JSON.stringify(record));
    index.push({
      instanceId: testCase.instanceId,
      indexUnchanged: record.indexUnchanged,
      calls: record.calls.map((c) => ({ call: c.call, wireCharacters: c.wireCharacters })),
    });
    console.error(`[m167-capture] ${testCase.instanceId}: ${record.calls.map((c) => `${c.call}=${c.wireCharacters}`).join(" ")}`);
  }

  writeFileSync(path.join(CAPTURE, "_index.json"), JSON.stringify({ side, indexWrites, cases: index }, null, 1));
  console.error(`[m167-capture] wrote ${CAPTURE}; cases=${index.length} indexWrites=${indexWrites}`);
}

await main();
