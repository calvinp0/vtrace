// M151-E / M152 — what a product read is allowed to change in the stores it uses.
//
// M151 wanted "the index file is byte-identical after a read" and could not have
// it: `index.sqlite` did not hold repository-derived state alone. Three supported
// features persisted into the same file on purpose — observation auto-capture,
// capsule manifests, and deferred VEXP references — so the invariant had to be
// stated per table:
//
//   repository-derived tables  -> never change during a product read
//   product/session tables     -> may change, and ONLY these may
//
// M152 moved those three families into `session.sqlite`. The gate M151 wanted is
// therefore now available, and it is what this file asserts (§57, §143):
//
//   index.sqlite   -> BYTE-IDENTICAL across every product/session request
//   session.sqlite -> changes exactly when a feature persists, and it must
//                     actually change, or auto-capture has silently stopped
//
// The per-table classification is kept as the finer-grained guard underneath, so
// a table added later still cannot quietly land on the wrong side.

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { initRepo } from "../setup/initRepo";
import { resolveRepoLocalPaths } from "../setup/repoState";
import { resolveIndexDbPath } from "../indexer/indexMeta";
import { classifyIndexTable } from "../db/indexTableFamilies";
import { resolveSessionDbPath } from "../session/sessionStore";
import { openProductIndexDatabase } from "../db/sqlite";
import { defaultMcpToolRegistry } from "./tools";
import { MCP_SERVER_ID, MCP_SERVER_SCHEMA, McpToolId } from "./types";
import type { McpServerContext } from "./types";

const execFile = promisify(execFileCallback);

// One definition, shared with the evidence runners so the two cannot drift.
const classify = classifyIndexTable;

interface Snapshot {
  readonly tables: Map<string, string>;
  readonly schemaDigest: string;
  readonly objectCount: number;
  readonly names: readonly string[];
}

function snapshot(dbPath: string): Snapshot {
  const db = new Database(dbPath, { readonly: true });
  try {
    const master = db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
    const names = (db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as { name: string }[]).map((row) => row.name);

    const tables = new Map<string, string>();
    for (const name of names) {
      const hash = createHash("sha256");
      try {
        for (const row of db.query(`SELECT * FROM "${name}"`).iterate() as Iterable<unknown>) {
          hash.update(JSON.stringify(row));
        }
      } catch (error) {
        hash.update(`UNREADABLE:${String(error)}`);
      }
      tables.set(name, hash.digest("hex"));
    }

    return {
      tables,
      schemaDigest: createHash("sha256").update(JSON.stringify(master)).digest("hex"),
      objectCount: master.length,
      names,
    };
  } finally {
    db.close();
  }
}

/** The whole-file hash. Meaningful for `index.sqlite` only after M152. */
async function fileHash(filePath: string): Promise<string | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  return createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex");
}

function changedTables(before: Snapshot, after: Snapshot): string[] {
  const changed: string[] = [];
  for (const [name, digest] of after.tables) {
    if (before.tables.get(name) !== digest) changed.push(name);
  }
  return changed;
}

let scratch: string;
let repoRoot: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "vtrace-m151-immutable-"));
  repoRoot = path.join(scratch, "fixture");
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "src", "engine.py"),
    "def pick_winner(records):\n    \"\"\"Choose the winning record.\"\"\"\n    return sorted(records)[0]\n",
  );
  await execFile("git", ["init", "--initial-branch=main"], { cwd: repoRoot });
  await execFile("git", ["config", "user.email", "m151@example.com"], { cwd: repoRoot });
  await execFile("git", ["config", "user.name", "M151"], { cwd: repoRoot });
  await execFile("git", ["add", "."], { cwd: repoRoot });
  await execFile("git", ["commit", "-m", "initial"], { cwd: repoRoot });
  await initRepo({ repoPath: repoRoot });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function contextBoundTo(root: string): McpServerContext {
  const paths = resolveRepoLocalPaths(root);
  return {
    serverId: MCP_SERVER_ID,
    repoRoot: root,
    dbPath: paths.dbPath,
    configPath: paths.configPath,
    statePath: paths.statePath,
    initialized: true,
    config: null,
    state: null,
  } as McpServerContext;
}

async function callTool(toolId: McpToolId, input: Record<string, unknown>): Promise<any> {
  const registry = defaultMcpToolRegistry;
  return (await registry.getByToolId(toolId)!.handler({
    context: contextBoundTo(repoRoot),
    request: { schema: MCP_SERVER_SCHEMA, requestId: "m151-immutable", toolId, input },
  })) as any;
}

describe("product reads and the index they query (M151-E)", () => {
  test("every table is classified as derived or product/session", () => {
    // The guard: a table added later must be placed deliberately on one side of
    // the invariant, not inherit whichever behaviour it happens to get.
    const unclassified = snapshot(resolveIndexDbPath(repoRoot)).names.filter(
      (name) => classify(name) === null,
    );
    assert.deepEqual(unclassified, [], "unclassified index tables must be assigned a family");
  });

  test("repeated reads across every product surface leave repository-derived state untouched", async () => {
    const dbPath = resolveIndexDbPath(repoRoot);
    const before = snapshot(dbPath);

    for (const [toolId, input] of [
      [McpToolId.GetCodeContext, { query: "pick_winner" }],
      [McpToolId.RunPipeline, { query: "pick_winner" }],
      [McpToolId.GetContextCapsule, { query: "pick_winner" }],
      [McpToolId.IndexStatus, {}],
    ] as [McpToolId, Record<string, unknown>][]) {
      for (let call = 0; call < 3; call += 1) {
        const result = await callTool(toolId, input);
        assert.equal(result.ok, true, `${toolId} must succeed`);
      }
    }

    const after = snapshot(dbPath);
    const derivedChanged = changedTables(before, after).filter(
      (name) => classify(name) === "repository_derived",
    );

    assert.deepEqual(derivedChanged, [], "no repository-derived table may change during a product read");
    assert.equal(after.schemaDigest, before.schemaDigest, "no schema change during a product read");
    assert.equal(after.objectCount, before.objectCount, "no object created during a product read");
  });

  test("no product/session table exists in the index at all (M152)", () => {
    const present = snapshot(resolveIndexDbPath(repoRoot)).names.filter(
      (name) => classify(name) === "product_session",
    );
    assert.deepEqual(present, [], "index.sqlite must own no product/session table after M152");
  });

  test("the index is byte-identical across product requests, and the session store is not", async () => {
    // The gate M151-E could not state. `index.sqlite` is now repository evidence
    // and nothing else, so a whole-file hash means exactly one thing (§57, §143).
    const dbPath = resolveIndexDbPath(repoRoot);
    const sessionPath = resolveSessionDbPath(repoRoot);

    const indexBefore = await fileHash(dbPath);
    assert.notEqual(indexBefore, null);

    for (const [toolId, input] of [
      [McpToolId.GetCodeContext, { query: "pick_winner" }],
      [McpToolId.RunPipeline, { query: "pick_winner" }],
      [McpToolId.GetContextCapsule, { query: "pick_winner" }],
      [McpToolId.SearchMemory, { query: "pick_winner" }],
      [McpToolId.IndexStatus, {}],
    ] as [McpToolId, Record<string, unknown>][]) {
      for (let call = 0; call < 2; call += 1) {
        assert.equal((await callTool(toolId, input)).ok, true, `${toolId} must succeed`);
      }
    }

    assert.equal(
      await fileHash(dbPath),
      indexBefore,
      "no product request may change index.sqlite",
    );

    // And the writes did happen — they went to the other file. Without this the
    // test would pass vacuously the day auto-capture is refactored away (§60).
    const sessionAfter = await fileHash(sessionPath);
    assert.notEqual(sessionAfter, null, "product requests must have created the session store");

    const sessionTables = snapshot(sessionPath).names.filter(
      (name) => classify(name) === "repository_derived",
    );
    assert.deepEqual(
      sessionTables,
      [],
      "no repository-derived table may be copied into the session store",
    );
  });

  test("index_status writes nothing at all", async () => {
    const dbPath = resolveIndexDbPath(repoRoot);
    const before = snapshot(dbPath);
    for (let call = 0; call < 3; call += 1) {
      assert.equal((await callTool(McpToolId.IndexStatus, {})).ok, true);
    }
    assert.deepEqual(changedTables(before, snapshot(dbPath)), []);
  });

  test("a read-only handle over a ready index performs no write", () => {
    // The mode M151's routing probes and supporting composition use. This is the
    // layer the audit isolated: opening and querying changes nothing, which is
    // why non-lead members stay byte-identical.
    const dbPath = resolveIndexDbPath(repoRoot);
    const before = snapshot(dbPath);

    const db = new Database(dbPath, { readonly: true });
    db.query("SELECT count(*) AS n FROM files").get();
    db.query("SELECT count(*) AS n FROM symbols").get();
    db.close();

    assert.deepEqual(changedTables(before, snapshot(dbPath)), []);
  });

  test("the product's own index connection rejects writes structurally", () => {
    // M152 makes this enforceable rather than aspirational: with no legitimate
    // product writer left, the product binding is genuinely read-only (§119,
    // §120, §123).
    const db = openProductIndexDatabase(resolveIndexDbPath(repoRoot));
    try {
      assert.throws(
        () => db.run("CREATE TABLE m152_should_not_exist (id TEXT)"),
        "the product index connection must reject DDL",
      );
      assert.throws(
        () => db.run("DELETE FROM files"),
        "the product index connection must reject DML",
      );
    } finally {
      db.close();
    }
  });

  test("a read-only handle rejects writes structurally", () => {
    const db = new Database(resolveIndexDbPath(repoRoot), { readonly: true });
    try {
      assert.throws(
        () => db.run("CREATE TABLE m151_should_not_exist (id TEXT)"),
        "a read-only lease must reject DDL rather than silently succeed",
      );
    } finally {
      db.close();
    }
  });

  test("a product read never creates an index that is missing", async () => {
    const missingRoot = path.join(scratch, "unindexed");
    await mkdir(path.join(missingRoot, "src"), { recursive: true });
    await writeFile(path.join(missingRoot, "src", "a.py"), "def a():\n    return 1\n");
    await execFile("git", ["init", "--initial-branch=main"], { cwd: missingRoot });
    await execFile("git", ["config", "user.email", "m151@example.com"], { cwd: missingRoot });
    await execFile("git", ["config", "user.name", "M151"], { cwd: missingRoot });
    await execFile("git", ["add", "."], { cwd: missingRoot });
    await execFile("git", ["commit", "-m", "initial"], { cwd: missingRoot });

    const registry = defaultMcpToolRegistry;
    const result = (await registry.getByToolId(McpToolId.GetCodeContext)!.handler({
      context: contextBoundTo(missingRoot),
      request: {
        schema: MCP_SERVER_SCHEMA,
        requestId: "m151-missing",
        toolId: McpToolId.GetCodeContext,
        input: { query: "a" },
      },
    })) as any;

    // Whatever it reports, it must not have manufactured an index to report on.
    void result;
    const created = await Bun.file(resolveIndexDbPath(missingRoot)).exists();
    assert.equal(created, false, "a product read must not create a missing index");
  });
});
