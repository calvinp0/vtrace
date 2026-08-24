/**
 * M179 — capturing an authoritative object the delivery packer can actually be
 * run against.
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID. `compactProductResponse` removes
 * `productContext.items[].content` unconditionally, because those bodies are a
 * duplicate of `modelVisibleContext`. A capture taken through the ordinary tool
 * path is therefore a RESPONSE, not the packer's input: its items have no bodies,
 * and re-packing it renders body-free sections and measures rungs made of
 * headers. M178 hit the same class of error through the `.snapshot` wrapper; this
 * is the same mistake one layer down, where the schema looks right.
 *
 * `include_item_content` is a published `run_pipeline` parameter that suppresses
 * exactly that removal. Captured with it, at a budget so large the packer is a
 * no-op, the recorded object carries the engine's own items AND their bodies —
 * which is what the packer sees in production.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");

/** Large enough that the packer publishes at rung "complete" and never compacts. */
export const M179_CAPTURE_MAX_TOKENS = 120_000;

export interface M179Capture {
  readonly instanceId: string;
  readonly repoRoot: string;
  readonly taskCharacters: number;
  readonly includeItemContent: boolean;
  readonly snapshot: unknown;
  readonly error: string | null;
}

function callRunPipeline(repoRoot: string, task: string, timeoutMs = 900_000): Promise<unknown> {
  const args: Record<string, unknown> = {
    task,
    repo_root: repoRoot,
    detail: "debug",
    max_tokens: M179_CAPTURE_MAX_TOKENS,
    include_item_content: true,
  };
  const messages: unknown[] = [
    {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m179-capture", version: "1" } },
    },
    { jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "run_pipeline", arguments: args } },
  ];
  return new Promise((resolve) => {
    const child = spawn(
      "bun",
      ["src/cli/index.ts", "mcp-serve", "--repo", repoRoot, "--tools", "run_pipeline"],
      { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
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
          const structured = (row.result as { structuredContent?: { result?: { output?: unknown } } } | undefined)?.structuredContent;
          resolve(structured?.result?.output ?? null);
          return;
        } catch { /* not a frame */ }
      }
      resolve(null);
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

/** Cached by instance id: a corpus is frozen the first time it is taken. */
export async function captureAuthoritative(
  cacheDir: string,
  instanceId: string,
  repoRoot: string,
  task: string,
): Promise<M179Capture> {
  mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `${instanceId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as M179Capture;

  let snapshot: unknown = null;
  let error: string | null = null;
  try {
    snapshot = await callRunPipeline(repoRoot, task);
    if (snapshot === null) error = "no_structured_content";
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const result: M179Capture = {
    instanceId, repoRoot, taskCharacters: task.length, includeItemContent: true, snapshot, error,
  };
  writeFileSync(file, `${JSON.stringify(result)}\n`);
  return result;
}

/**
 * §11's standing control: does this frozen object still carry the bodies the
 * packer is supposed to be shedding? A corpus that fails this measures headers.
 */
export function carriesItemBodies(snapshot: unknown): { items: number; withContent: number; valid: boolean } {
  const output = snapshot as { productContext?: { items?: unknown } } | null;
  const items = Array.isArray(output?.productContext?.items) ? output.productContext.items as Record<string, unknown>[] : [];
  const withContent = items.filter((item) => typeof item.content === "string" && item.content.length > 0).length;
  return { items: items.length, withContent, valid: items.length === 0 || withContent > 0 };
}
