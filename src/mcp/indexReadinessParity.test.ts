// M141 Workstream A — cross-tool readiness parity.
//
// The hard acceptance gate: for the same index state, `index_status` and every
// readiness-sensitive product tool must agree on whether the index is
// runtime-ready. Before M141 they did not: `index_status` compared the target
// repo's source snapshot and reported `fresh / no rebuild needed`, while the
// next `get_code_context` compared VTRACE's own indexer fingerprints and
// refused the same index with `index_schema_changed`.

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, test } from "bun:test";

import { initRepo } from "../setup/initRepo";
import { resolveRepoLocalPaths } from "../setup/repoState";
import { resolveIndexMetaPath, type IndexMeta } from "../indexer/indexMeta";
import { defaultMcpToolRegistry } from "./tools";
import { McpToolId, type McpServerContext } from "./types";

const execFile = promisify(execFileCallback);
const registry = defaultMcpToolRegistry;

/**
 * Every tool whose answer depends on the stored index being usable. Each is
 * mapped to how its response reports the refusal, because the tools have
 * different envelopes (M140-B learned this the hard way: `get_impact_graph`
 * and `search_logic_flow` wrap everything in `{ ok, output }`).
 */
// get_code_context and run_pipeline are asked at detail=debug: they project a
// compact orientation by default, and readiness parity is a property of the
// authoritative envelope each tool returns.
const READINESS_SENSITIVE_TOOLS = [
  { toolId: McpToolId.GetCodeContext, input: { query: "alpha", detail: "debug" }, policy: "fail_closed" },
  { toolId: McpToolId.GetContextCapsule, input: { query: "alpha" }, policy: "fail_closed" },
  { toolId: McpToolId.RunPipeline, input: { query: "alpha", detail: "debug" }, policy: "fail_closed" },
  { toolId: McpToolId.GetImpactGraph, input: { symbol_fqn: "alpha.py::alpha" }, policy: "serve_with_warning" },
  { toolId: McpToolId.SearchLogicFlow, input: { start: "beta.py::beta", end: "alpha.py::alpha" }, policy: "serve_with_warning" },
] as const;

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "vtrace-m141-parity-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd, encoding: "utf8" });
}

async function createIndexedRepo(name: string): Promise<string> {
  const root = path.join(scratch, name);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "alpha.py"), "def alpha():\n    return 1\n");
  await writeFile(
    path.join(root, "beta.py"),
    "from alpha import alpha\n\n\ndef beta():\n    return alpha()\n",
  );
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.email", "m141@example.com");
  await git(root, "config", "user.name", "M141");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  await initRepo({ repoPath: root });
  return root;
}

function contextBoundTo(repoRoot: string): McpServerContext {
  const paths = resolveRepoLocalPaths(repoRoot);
  return {
    serverId: "vtrace",
    repoRoot,
    dbPath: paths.dbPath,
    configPath: paths.configPath,
    statePath: paths.statePath,
    initialized: true,
    config: null,
    state: null,
  } as McpServerContext;
}

async function callTool(
  context: McpServerContext,
  toolId: McpToolId,
  input: Record<string, unknown>,
): Promise<any> {
  const definition = registry.getByToolId(toolId);
  assert.notEqual(definition, undefined, `tool ${toolId} must be registered`);
  return await definition!.handler({
    context,
    request: { schema: registry.schema, requestId: "m141", toolId, input },
  }) as any;
}

/**
 * The authoritative product verdict a tool reached, normalized across the three
 * response shapes. `get_code_context` refuses with a top-level stale envelope;
 * `get_context_capsule` and `run_pipeline` keep their legacy wrapper but their
 * M119 product-context layer fails closed and carries the shared reason code.
 */
function authoritativeVerdict(result: any): { resolved: boolean; reason: string } {
  if (result?.ok !== true) {
    return { resolved: false, reason: String(result?.error?.details?.reason ?? result?.error?.code ?? "error") };
  }
  const output = result.output ?? {};
  if (output.resolved === false) {
    return { resolved: false, reason: String(output.reason ?? "unresolved") };
  }
  const productContext = output.productContext;
  if (productContext !== undefined) {
    return {
      resolved: productContext.resolved === true,
      reason: String(productContext.freshness?.reason ?? "fresh"),
    };
  }
  return { resolved: true, reason: "fresh" };
}

async function indexStatusVerdict(context: McpServerContext) {
  const result = await callTool(context, McpToolId.IndexStatus, {});
  assert.equal(result.ok, true, "index_status must answer");
  return {
    ready: result.output.indexReadiness.ready as boolean,
    state: result.output.indexReadiness.state as string,
    reason: result.output.indexReadiness.reason as string,
    action: result.output.indexReadiness.recommendedAction as string,
    legacyIsStale: result.output.freshness.isStale as boolean,
    legacyState: result.output.freshness.state as string,
  };
}

async function patchMeta(root: string, mutate: (meta: IndexMeta) => void): Promise<void> {
  const metaPath = resolveIndexMetaPath(root);
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as IndexMeta;
  mutate(meta);
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

describe("M141 cross-tool readiness parity", () => {
  test("a ready index is served by index_status and every product tool", async () => {
    const root = await createIndexedRepo("ready");
    const context = contextBoundTo(root);
    const status = await indexStatusVerdict(context);

    assert.equal(status.ready, true);
    assert.equal(status.state, "ready");
    assert.equal(status.legacyIsStale, false);

    for (const tool of READINESS_SENSITIVE_TOOLS) {
      const result = await callTool(context, tool.toolId, { ...tool.input });
      assert.equal(result.ok, true, `${tool.toolId} errored on a ready index: ${JSON.stringify(result).slice(0, 400)}`);
      if (tool.policy !== "fail_closed") continue;
      const verdict = authoritativeVerdict(result);
      assert.equal(
        verdict.reason,
        "fresh",
        `${tool.toolId} reported ${verdict.reason} for an index index_status calls ready`,
      );
    }
  });

  test("a schema-incompatible index is refused by index_status and every product tool", async () => {
    const root = await createIndexedRepo("schema");
    // Same source, different VTRACE indexer/parser build.
    await patchMeta(root, (meta) => {
      meta.parser_fingerprint = "0".repeat(64);
      meta.manifest.index.parserVersion = "0".repeat(64);
    });
    const context = contextBoundTo(root);
    const status = await indexStatusVerdict(context);

    // The exact defect M141 exists to remove.
    assert.equal(status.ready, false, "index_status must not report a schema-incompatible index as ready");
    assert.equal(status.state, "schema_incompatible");
    // M146-A: a different indexer/parser build is a DERIVATION change. The
    // parity requirement is unchanged — every tool must name the same cause —
    // and the cause is now the truthful one.
    assert.equal(status.reason, "derivation_changed");
    assert.equal(status.action, "full_rebuild");
    assert.equal(status.legacyIsStale, true);

    // Every fail-closed surface must refuse, and name the SAME cause.
    for (const tool of READINESS_SENSITIVE_TOOLS.filter((entry) => entry.policy === "fail_closed")) {
      const result = await callTool(context, tool.toolId, { ...tool.input });
      const verdict = authoritativeVerdict(result);
      assert.equal(
        verdict.resolved,
        false,
        `${tool.toolId} served a schema-incompatible index that index_status refused`,
      );
      assert.equal(
        verdict.reason,
        "index_schema_changed",
        `${tool.toolId} named ${verdict.reason} where index_status named schema_changed`,
      );
    }

    // The evidence tools keep M131's older-index contract: they answer with
    // bounded static evidence rather than failing closed. That difference is
    // declared policy, not a disagreement about the verdict.
    for (const tool of READINESS_SENSITIVE_TOOLS.filter((entry) => entry.policy === "serve_with_warning")) {
      const result = await callTool(context, tool.toolId, { ...tool.input });
      assert.equal(result.ok, true, `${tool.toolId} must still answer under its declared policy: ${JSON.stringify(result).slice(0, 300)}`);
    }
  });

  test("index_repo leaves the index ready and every surface agrees immediately after", async () => {
    const root = await createIndexedRepo("post-index");
    await patchMeta(root, (meta) => {
      meta.parser_fingerprint = "0".repeat(64);
      meta.manifest.index.parserVersion = "0".repeat(64);
    });
    const context = contextBoundTo(root);

    const before = await indexStatusVerdict(context);
    assert.equal(before.ready, false);

    const indexed = await callTool(context, McpToolId.IndexRepo, { mode: "full" });
    assert.equal(indexed.ok, true, JSON.stringify(indexed).slice(0, 400));
    // index_repo must not construct an independent optimistic success status.
    assert.equal(indexed.output.indexReadiness.ready, true);
    assert.equal(indexed.output.indexReadiness.state, "ready");

    const after = await indexStatusVerdict(context);
    assert.equal(after.ready, true);
    assert.equal(after.legacyIsStale, false);

    for (const tool of READINESS_SENSITIVE_TOOLS) {
      const result = await callTool(context, tool.toolId, { ...tool.input });
      assert.equal(result.ok, true, `${tool.toolId} errored after a rebuild: ${JSON.stringify(result).slice(0, 400)}`);
      if (tool.policy !== "fail_closed") continue;
      assert.equal(
        authoritativeVerdict(result).reason,
        "fresh",
        `${tool.toolId} refused a just-rebuilt index`,
      );
    }
  });

  test("capability differences between tools are explicit, not silent", async () => {
    const root = await createIndexedRepo("capability");
    const context = contextBoundTo(root);
    const status = await indexStatusVerdict(context);

    // No product tool currently declares a hard capability requirement — M131
    // deliberately kept older indexes without `edge_call_sites` usable — so a
    // base-readable index is ready for all of them. The capability model still
    // reports availability so a future requirement is expressible.
    assert.equal(status.ready, true);
    assert.deepEqual(
      (await callTool(context, McpToolId.IndexStatus, {})).output.indexReadiness.missingCapabilities,
      [],
    );
  });
});
