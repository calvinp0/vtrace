import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { initRepo } from "../setup/initRepo";
import {
  computeDeferredVexpHash,
  createDeferredVexpStore,
  DEFERRED_VEXP_HASH_PATTERN,
  DeferredVexpCategory,
  resetSharedDeferredVexpStoreForTests,
  getSharedDeferredVexpStore,
} from "../runPipeline/deferredVexpStore";
import { createMcpServer } from "./server";
import {
  MCP_SERVER_SCHEMA,
  McpToolId,
} from "./types";

async function withRepoFixture(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vexb-expand-vexp-"));
  const repoRoot = path.join(root, "repo");
  try {
    await mkdir(repoRoot, { recursive: true });
    await writeFixtureRepo(repoRoot);
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFixtureRepo(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "src", "session.ts"),
    [
      "export type Session = string;",
      "",
      "export class SessionManager {",
      "  createSession(accountId: string): Session {",
      "    return accountId;",
      "  }",
      "}",
      "",
      "export function readSession(manager: SessionManager): Session {",
      "  return manager.createSession(\"fixture\");",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src", "controller.ts"),
    [
      "import { SessionManager } from \"./session\";",
      "",
      "export class SessionController {",
      "  constructor(private readonly manager: SessionManager) {}",
      "}",
      "",
    ].join("\n"),
  );
}

test("deferred V-REF hashes use 12 lowercase hex characters", () => {
  const hash = computeDeferredVexpHash("vexp:capsule:abc");
  assert.match(hash, DEFERRED_VEXP_HASH_PATTERN);
  assert.equal(hash.length, 12);
  // deterministic
  assert.equal(hash, computeDeferredVexpHash("vexp:capsule:abc"));
  // stableId sensitivity
  assert.notEqual(hash, computeDeferredVexpHash("vexp:capsule:abd"));
});

test("deferredVexpStore publish/resolve round-trips stored truth", () => {
  const store = createDeferredVexpStore();
  const entry = store.publish({
    stableId: "vexp:capsule:test",
    category: DeferredVexpCategory.ContextCapsule,
    content: { kind: "text", mimeType: "text/plain", text: "hello" },
    metadata: { origin: "test" },
  });
  assert.match(entry.hash, DEFERRED_VEXP_HASH_PATTERN);
  const resolved = store.resolve(entry.hash);
  assert.notEqual(resolved, null);
  assert.equal(resolved!.stableId, "vexp:capsule:test");
  assert.equal(resolved!.category, DeferredVexpCategory.ContextCapsule);
});

test("deferredVexpStore distinguishes unknown vs expired hashes", () => {
  const store = createDeferredVexpStore();
  const neverPublished = "a".repeat(12);
  assert.equal(store.resolve(neverPublished), null);
  assert.equal(store.isExpired(neverPublished), false);

  const entry = store.publish({
    stableId: "vexp:capsule:expirable",
    category: DeferredVexpCategory.ContextCapsule,
    content: { kind: "json", value: { x: 1 } },
    metadata: {},
  });
  assert.notEqual(store.resolve(entry.hash), null);
  store.expire(entry.hash);
  assert.equal(store.resolve(entry.hash), null);
  assert.equal(store.isExpired(entry.hash), true);
});

test("deferredVexpStore evicts oldest entries under capacity pressure and marks them expired", () => {
  const store = createDeferredVexpStore({ capacity: 2 });
  const a = store.publish({
    stableId: "vexp:capsule:a",
    category: DeferredVexpCategory.ContextCapsule,
    content: { kind: "json", value: "a" },
    metadata: {},
  });
  const b = store.publish({
    stableId: "vexp:capsule:b",
    category: DeferredVexpCategory.ContextCapsule,
    content: { kind: "json", value: "b" },
    metadata: {},
  });
  const c = store.publish({
    stableId: "vexp:capsule:c",
    category: DeferredVexpCategory.ContextCapsule,
    content: { kind: "json", value: "c" },
    metadata: {},
  });
  assert.equal(store.resolve(a.hash), null);
  assert.equal(store.isExpired(a.hash), true);
  assert.notEqual(store.resolve(b.hash), null);
  assert.notEqual(store.resolve(c.hash), null);
});

test("expand_vexp_ref returns malformed_hash for non-12-hex input", async () => {
  await withRepoFixture(async (repoRoot) => {
    resetSharedDeferredVexpStoreForTests();
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });

    for (const hash of ["", "ABCDEFabcdef", "zzzzzzzzzzzz", "abc", "a1b2c3d4e5f", "a1b2c3d4e5f6x"]) {
      const response = await server.handleRequest({
        schema: MCP_SERVER_SCHEMA,
        requestId: `req-bad-${hash || "empty"}`,
        toolId: McpToolId.ExpandVexpRef,
        input: { hash },
      });
      assert.equal(response.result.ok, true);
      if (!response.result.ok) throw new Error("unreachable");
      assert.equal(response.result.output.resolved, false);
      assert.equal(response.result.output.reason, "malformed_hash");
    }
  });
});

test("expand_vexp_ref returns unknown_hash for well-formed but unseen hash", async () => {
  await withRepoFixture(async (repoRoot) => {
    resetSharedDeferredVexpStoreForTests();
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-unknown",
      toolId: McpToolId.ExpandVexpRef,
      input: { hash: "deadbeef0123" },
    });
    assert.equal(response.result.ok, true);
    if (!response.result.ok) throw new Error("unreachable");
    assert.equal(response.result.output.resolved, false);
    assert.equal(response.result.output.reason, "unknown_hash");
  });
});

test("expand_vexp_ref expands a V-REF emitted by run_pipeline and is deterministic on repeat", async () => {
  await withRepoFixture(async (repoRoot) => {
    resetSharedDeferredVexpStoreForTests();
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });

    const pipeline = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-pipeline",
      toolId: McpToolId.RunPipeline,
      input: { query: "rename createSession", maxBudgetCharacters: 4_000 },
    });
    assert.equal(pipeline.result.ok, true);
    if (!pipeline.result.ok) throw new Error("pipeline failed");

    const placeholders = pipeline.result.output.deferred;
    assert.equal(placeholders.length > 0, true, "run_pipeline must emit at least one deferred V-REF");

    // Every emitted placeholder exposes a 12-hex public hash.
    for (const placeholder of placeholders) {
      assert.match(placeholder.hash, DEFERRED_VEXP_HASH_PATTERN);
    }

    // Pick the capsule placeholder (always emitted for a query with results).
    const capsulePlaceholder = placeholders.find((p) => p.kind === "context_capsule");
    assert.notEqual(capsulePlaceholder, undefined);
    const hash = capsulePlaceholder!.hash;

    const first = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-expand-first",
      toolId: McpToolId.ExpandVexpRef,
      input: { hash },
    });
    const second = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-expand-second",
      toolId: McpToolId.ExpandVexpRef,
      input: { hash },
    });
    assert.equal(first.result.ok, true);
    assert.equal(second.result.ok, true);
    if (!first.result.ok || !second.result.ok) throw new Error("unreachable");

    assert.equal(first.result.output.resolved, true);
    assert.equal(first.result.output.stableId, capsulePlaceholder!.id);
    assert.equal(first.result.output.category, "context_capsule");
    assert.equal(first.result.output.requestedHash, hash);
    // Deterministic repeat: same output shape for same hash.
    assert.deepEqual(first.result.output, second.result.output);
    // Metadata origin tags the source pipeline emission.
    assert.equal(
      (first.result.output.metadata as Record<string, unknown>)["origin"],
      "run_pipeline",
    );
    // Full content is present — not a compact summary.
    const content = first.result.output.content as Record<string, unknown>;
    assert.equal(content.kind, "json");
    assert.equal(typeof content.value, "object");
  });
});

test("expand_vexp_ref returns expired when a previously published V-REF has been evicted", async () => {
  await withRepoFixture(async (repoRoot) => {
    resetSharedDeferredVexpStoreForTests();
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });

    const pipeline = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-pipeline-expire",
      toolId: McpToolId.RunPipeline,
      input: { query: "rename createSession", maxBudgetCharacters: 4_000 },
    });
    assert.equal(pipeline.result.ok, true);
    if (!pipeline.result.ok) throw new Error("pipeline failed");
    const placeholder = pipeline.result.output.deferred[0];
    assert.notEqual(placeholder, undefined);
    const hash = placeholder!.hash;

    // Explicitly expire the emitted V-REF in the process-shared store.
    getSharedDeferredVexpStore().expire(hash);

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-expand-expired",
      toolId: McpToolId.ExpandVexpRef,
      input: { hash },
    });
    assert.equal(response.result.ok, true);
    if (!response.result.ok) throw new Error("unreachable");
    assert.equal(response.result.output.resolved, false);
    assert.equal(response.result.output.reason, "expired");
  });
});
