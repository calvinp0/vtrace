// M151-E — what a product read is allowed to change in the index it queries.
//
// The closure gate started as "the index file is byte-identical after a read" and
// that gate was wrong, because `index.sqlite` does not hold repository-derived
// state alone. Three supported features persist into the same file on purpose:
// observation auto-capture, capsule manifests, and deferred VEXP references.
//
// So the invariant worth locking in is narrower and stronger than a file hash:
//
//   repository-derived tables  -> never change during a product read
//   product/session tables     -> may change, and ONLY these may
//   schema / object set        -> never change (no migration, no schema install)
//
// Every table is classified and an unclassified table FAILS, so a table added
// later cannot quietly land on the wrong side of the boundary.

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

  test("only the three documented product/session families may move", async () => {
    const dbPath = resolveIndexDbPath(repoRoot);
    const before = snapshot(dbPath);
    await callTool(McpToolId.GetCodeContext, { query: "pick_winner" });
    const after = snapshot(dbPath);

    const changed = changedTables(before, after);
    // Something must have moved, or this test would pass vacuously and stop
    // guarding anything the day auto-capture is refactored away.
    expect(changed.length).toBeGreaterThan(0);
    for (const name of changed) {
      assert.equal(
        classify(name),
        "product_session",
        `${name} changed during a product read but is not documented product/session state`,
      );
    }
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
