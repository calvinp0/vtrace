import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import {
  cleanupDeferredVexpRefs,
  expirePersistentDeferredVexpRef,
  persistDeferredVexpRef,
  resolvePersistentDeferredVexpRef,
} from "../db/repositories/deferredVexpRefsRepository";
import { runExpandVexpRefCommand } from "../cli/commands/expandVexpRefCommand";
import { runRunPipelineCommand } from "../cli/commands/runPipelineCommand";
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
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-expand-vexp-"));
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
  assert.notEqual(entry.hash, computeDeferredVexpHash("vexp:capsule:test"));
});

test("deferredVexpStore hash changes when payload changes under the same stable id", () => {
  const store = createDeferredVexpStore();
  const first = store.publish({
    stableId: "vexp:capsule:same",
    category: DeferredVexpCategory.ContextCapsule,
    content: { kind: "json", value: { version: 1 } },
    metadata: {},
  });
  const second = store.publish({
    stableId: "vexp:capsule:same",
    category: DeferredVexpCategory.ContextCapsule,
    content: { kind: "json", value: { version: 2 } },
    metadata: {},
  });

  assert.notEqual(first.hash, second.hash);
  assert.deepEqual(store.resolve(first.hash)?.content, { kind: "json", value: { version: 1 } });
  assert.deepEqual(store.resolve(second.hash)?.content, { kind: "json", value: { version: 2 } });
});

test("persistent deferred V-REF repository survives new store instances", () => {
  const db = openIndexerDatabase();
  const firstStore = createDeferredVexpStore();
  const entry = firstStore.publish({
    stableId: "vexp:capsule:persistent",
    category: DeferredVexpCategory.ContextCapsule,
    content: { kind: "json", value: { payload: "stored" } },
    metadata: { origin: "test" },
  });

  persistDeferredVexpRef(db, {
    entry,
    repoRoot: "/repo/example",
    sourceRunId: null,
    sessionId: "session-1",
    notes: ["test note"],
  });

  const secondStore = createDeferredVexpStore();
  assert.equal(secondStore.resolve(entry.hash), null);
  const persisted = resolvePersistentDeferredVexpRef(db, entry.hash);
  assert.notEqual(persisted, null);
  assert.deepEqual(persisted!.content, entry.content);
  assert.equal(persisted!.sessionId, "session-1");
  db.close();
});

test("persistent deferred V-REF cleanup evicts oldest records with tombstones", () => {
  const db = openIndexerDatabase();
  const store = createDeferredVexpStore({ now: () => 1_000 });
  const first = store.publish({
    stableId: "vexp:capsule:first-persistent",
    category: DeferredVexpCategory.ContextCapsule,
    content: { kind: "json", value: "first" },
    metadata: {},
  });
  const second = store.publish({
    stableId: "vexp:capsule:second-persistent",
    category: DeferredVexpCategory.ContextCapsule,
    content: { kind: "json", value: "second" },
    metadata: {},
  });
  const third = store.publish({
    stableId: "vexp:capsule:third-persistent",
    category: DeferredVexpCategory.ContextCapsule,
    content: { kind: "json", value: "third" },
    metadata: {},
  });

  persistDeferredVexpRef(db, { entry: first, repoRoot: "/repo/example", now: () => 1_000 }, { maxRecords: 3 });
  persistDeferredVexpRef(db, { entry: second, repoRoot: "/repo/example", now: () => 1_001 }, { maxRecords: 3 });
  persistDeferredVexpRef(db, { entry: third, repoRoot: "/repo/example", now: () => 1_002 }, { maxRecords: 3 });

  cleanupDeferredVexpRefs(db, { maxRecords: 2, now: () => 1_003 });

  assert.equal(resolvePersistentDeferredVexpRef(db, first.hash), null);
  assert.notEqual(resolvePersistentDeferredVexpRef(db, second.hash), null);
  assert.notEqual(resolvePersistentDeferredVexpRef(db, third.hash), null);
  const tombstone = db.query(`SELECT reason FROM deferred_vexp_ref_tombstones WHERE hash = ?`).get(first.hash) as
    | { reason: string }
    | null;
  assert.equal(tombstone?.reason, "capacity_evicted");
  db.close();
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

test("expand_vexp_ref returns unsupported_category for stored unsupported categories", async () => {
  await withRepoFixture(async (repoRoot) => {
    resetSharedDeferredVexpStoreForTests();
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });
    const entry = getSharedDeferredVexpStore().publish({
      stableId: "vexp:future:unsupported",
      category: "future_category" as DeferredVexpCategory,
      content: { kind: "json", value: { future: true } },
      metadata: { origin: "test" },
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-unsupported",
      toolId: McpToolId.ExpandVexpRef,
      input: { hash: entry.hash },
    });

    assert.equal(response.result.ok, true);
    if (!response.result.ok) throw new Error("unreachable");
    assert.equal(response.result.output.resolved, false);
    assert.equal(response.result.output.reason, "unsupported_category");
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

    const placeholders = pipeline.result.output.deferred.items;
    assert.equal(placeholders.length > 0, true, "run_pipeline must emit at least one deferred V-REF");

    // Every emitted placeholder exposes a 12-hex public hash.
    for (const placeholder of placeholders) {
      assert.match(placeholder.hash, DEFERRED_VEXP_HASH_PATTERN);
      assert.equal(placeholder.expandable, true);
      assert.equal(placeholder.expansionTool, "expand_vexp_ref");
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
    assert.equal(typeof (first.result.output.metadata as Record<string, unknown>)["createdAtMs"], "number");
    // Full content is present — not a compact summary.
    const content = first.result.output.content as Record<string, unknown>;
    assert.equal(content.kind, "json");
    assert.equal(typeof content.value, "object");
  });
});

test("expand_vexp_ref resolves a persisted V-REF after process store reset", async () => {
  await withRepoFixture(async (repoRoot) => {
    resetSharedDeferredVexpStoreForTests();
    const initialized = await initRepo({ repoPath: repoRoot });
    const firstServer = createMcpServer({ context: { repoRoot: initialized.repoRoot } });

    const pipeline = await firstServer.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-pipeline-persisted",
      toolId: McpToolId.RunPipeline,
      input: { query: "rename createSession", maxBudgetCharacters: 4_000 },
    });
    assert.equal(pipeline.result.ok, true);
    if (!pipeline.result.ok) throw new Error("pipeline failed");
    const capsulePlaceholder = pipeline.result.output.deferred.items.find((p) => p.kind === "context_capsule");
    assert.notEqual(capsulePlaceholder, undefined);

    resetSharedDeferredVexpStoreForTests();
    const restartedServer = createMcpServer({ context: { repoRoot: initialized.repoRoot } });
    const expanded = await restartedServer.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-expand-persisted",
      toolId: McpToolId.ExpandVexpRef,
      input: { hash: capsulePlaceholder!.hash },
    });

    assert.equal(expanded.result.ok, true);
    if (!expanded.result.ok) throw new Error("unreachable");
    assert.equal(expanded.result.output.resolved, true);
    assert.equal(expanded.result.output.stableId, capsulePlaceholder!.id);
    assert.equal(expanded.result.output.notes.includes("Resolved from repo-local persistent V-REF storage."), true);
  });
});

test("expand_vexp_ref returns stored truth after source files change", async () => {
  await withRepoFixture(async (repoRoot) => {
    resetSharedDeferredVexpStoreForTests();
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });

    const pipeline = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-pipeline-stored-truth",
      toolId: McpToolId.RunPipeline,
      input: { query: "rename createSession", maxBudgetCharacters: 4_000 },
    });
    assert.equal(pipeline.result.ok, true);
    if (!pipeline.result.ok) throw new Error("pipeline failed");
    const capsulePlaceholder = pipeline.result.output.deferred.items.find((p) => p.kind === "context_capsule");
    assert.notEqual(capsulePlaceholder, undefined);
    const hash = capsulePlaceholder!.hash;

    const before = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-expand-before-mutation",
      toolId: McpToolId.ExpandVexpRef,
      input: { hash },
    });
    await writeFile(
      path.join(repoRoot, "src", "session.ts"),
      [
        "export type Session = string;",
        "",
        "export class SessionManager {",
        "  createSession(accountId: string): Session {",
        "    return `changed-${accountId}`;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const after = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-expand-after-mutation",
      toolId: McpToolId.ExpandVexpRef,
      input: { hash },
    });

    assert.equal(before.result.ok, true);
    assert.equal(after.result.ok, true);
    if (!before.result.ok || !after.result.ok) throw new Error("unreachable");
    assert.deepEqual(after.result.output, before.result.output);
    assert.equal(JSON.stringify(after.result.output).includes("changed-"), false);
  });
});

test("persisted expand_vexp_ref returns stored truth after source files change and restart", async () => {
  await withRepoFixture(async (repoRoot) => {
    resetSharedDeferredVexpStoreForTests();
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });

    const pipeline = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-pipeline-persisted-stored-truth",
      toolId: McpToolId.RunPipeline,
      input: { query: "rename createSession", maxBudgetCharacters: 4_000 },
    });
    assert.equal(pipeline.result.ok, true);
    if (!pipeline.result.ok) throw new Error("pipeline failed");
    const capsulePlaceholder = pipeline.result.output.deferred.items.find((p) => p.kind === "context_capsule");
    assert.notEqual(capsulePlaceholder, undefined);

    const before = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-expand-persisted-before-mutation",
      toolId: McpToolId.ExpandVexpRef,
      input: { hash: capsulePlaceholder!.hash },
    });
    assert.equal(before.result.ok, true);
    if (!before.result.ok) throw new Error("unreachable");

    await writeFile(
      path.join(repoRoot, "src", "session.ts"),
      [
        "export type Session = string;",
        "",
        "export class SessionManager {",
        "  createSession(accountId: string): Session {",
        "    return `persisted-changed-${accountId}`;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    resetSharedDeferredVexpStoreForTests();
    const restartedServer = createMcpServer({ context: { repoRoot: initialized.repoRoot } });
    const after = await restartedServer.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-expand-persisted-after-mutation",
      toolId: McpToolId.ExpandVexpRef,
      input: { hash: capsulePlaceholder!.hash },
    });

    assert.equal(after.result.ok, true);
    if (!after.result.ok) throw new Error("unreachable");
    assert.deepEqual(after.result.output.content, before.result.output.content);
    assert.equal(JSON.stringify(after.result.output).includes("persisted-changed-"), false);
  });
});

test("CLI expand-vexp-ref resolves retained persisted refs without --query", async () => {
  await withRepoFixture(async (repoRoot) => {
    resetSharedDeferredVexpStoreForTests();
    await initRepo({ repoPath: repoRoot });

    const pipeline = await runRunPipelineCommand([
      repoRoot,
      "rename createSession",
      "--max-budget-characters",
      "4000",
    ]);
    assert.equal(pipeline.exitCode, 0, pipeline.stderr);
    const formatted = JSON.parse(pipeline.stdout) as {
      deferred: { items: Array<{ kind: string; hash: string }> };
    };
    const hash = formatted.deferred.items.find((item) => item.kind === "context_capsule")?.hash;
    assert.notEqual(hash, undefined);

    resetSharedDeferredVexpStoreForTests();
    const expanded = await runExpandVexpRefCommand([repoRoot, hash!]);
    assert.equal(expanded.exitCode, 0, expanded.stderr);
    const output = JSON.parse(expanded.stdout) as Record<string, unknown>;
    assert.equal(output.resolved, true);
    assert.equal(output.requestedHash, hash);
    assert.equal(output.source, "persistent");
  });
});

test("CLI expand-vexp-ref --query fallback republishes when persistent lookup misses", async () => {
  await withRepoFixture(async (repoRoot) => {
    resetSharedDeferredVexpStoreForTests();
    const initialized = await initRepo({ repoPath: repoRoot });
    const pipeline = await runRunPipelineCommand([
      repoRoot,
      "rename createSession",
      "--max-budget-characters",
      "4000",
    ]);
    assert.equal(pipeline.exitCode, 0, pipeline.stderr);
    const formatted = JSON.parse(pipeline.stdout) as {
      deferred: { items: Array<{ kind: string; hash: string }> };
    };
    const hash = formatted.deferred.items.find((item) => item.kind === "context_capsule")?.hash;
    assert.notEqual(hash, undefined);

    const db = openIndexerDatabase(initialized.paths.dbPath);
    try {
      expirePersistentDeferredVexpRef(db, hash!, {
        reason: "test_removed",
        repoRoot: initialized.repoRoot,
      });
    } finally {
      db.close();
    }
    resetSharedDeferredVexpStoreForTests();

    const expanded = await runExpandVexpRefCommand([
      repoRoot,
      hash!,
      "--query",
      "rename createSession",
      "--max-budget-characters",
      "4000",
    ]);
    assert.equal(expanded.exitCode, 0, expanded.stderr);
    const output = JSON.parse(expanded.stdout) as Record<string, unknown>;
    assert.equal(output.resolved, true);
    assert.equal(output.requestedHash, hash);
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
    const placeholder = pipeline.result.output.deferred.items[0];
    assert.notEqual(placeholder, undefined);
    const hash = placeholder!.hash;

    // Explicitly expire the emitted V-REF in the process-shared store.
    getSharedDeferredVexpStore().expire(hash);
    const db = openIndexerDatabase(initialized.paths.dbPath);
    try {
      expirePersistentDeferredVexpRef(db, hash, {
        reason: "test_expired",
        repoRoot: initialized.repoRoot,
      });
    } finally {
      db.close();
    }

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

test("expand_vexp_ref returns expired after deterministic capacity eviction", async () => {
  await withRepoFixture(async (repoRoot) => {
    resetSharedDeferredVexpStoreForTests({ capacity: 1 });
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });
    const first = getSharedDeferredVexpStore().publish({
      stableId: "vexp:capsule:first",
      category: DeferredVexpCategory.ContextCapsule,
      content: { kind: "json", value: { item: "first" } },
      metadata: {},
    });
    getSharedDeferredVexpStore().publish({
      stableId: "vexp:capsule:second",
      category: DeferredVexpCategory.ContextCapsule,
      content: { kind: "json", value: { item: "second" } },
      metadata: {},
    });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "req-expand-capacity-expired",
      toolId: McpToolId.ExpandVexpRef,
      input: { hash: first.hash },
    });

    assert.equal(response.result.ok, true);
    if (!response.result.ok) throw new Error("unreachable");
    assert.equal(response.result.output.resolved, false);
    assert.equal(response.result.output.reason, "expired");
  });
});
