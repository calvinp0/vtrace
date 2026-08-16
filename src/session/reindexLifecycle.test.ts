// M152-D — the two lifecycles, and what they are allowed to do to each other.
//
// Before the split these were one lifecycle wearing two hats: rebuilding an
// index could CASCADE-delete the capsule manifests derived from it, so "the
// manifest is gone" and "the manifest is stale" were the same event. After the
// split they are independent stores that meet only through provenance, and the
// properties worth pinning are the ones that would silently regress:
//
//   index_repo changes index.sqlite and PRESERVES session history (§144)
//   a manifest survives a reindex and is reported STALE, not missing  (§145)
//   observations survive and keep M138 freshness semantics            (§146)
//   a session-schema change never touches the index                   (§32, §117)

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Database } from "bun:sqlite";

import { openProductIndexDatabase } from "../db/sqlite";
import { searchMemory } from "../observations/searchMemory";
import { resolveCurrentObservationContext } from "../observations/provenance";
import { StaleStateStatus } from "../memory/types";
import { getLatestIndexRun } from "../db/repositories/indexRunsRepository";
import { resolveIndexDbPath } from "../indexer/indexMeta";
import { initRepo } from "../setup/initRepo";
import { resolveRepoLocalPaths } from "../setup/repoState";
import { reindexRepoAndRefreshState } from "../runtime/reindexRepo";
import {
  getCapsuleManifestById,
  getCapsuleStaleness,
  persistCapsuleV2ManifestBestEffort,
} from "./repositories/capsuleManifestsRepository";
import { listObservations, persistObservation } from "./repositories/observationsRepository";
import { initializeSessionSchema } from "./sessionSchema";
import { ProductStoreLease, resolveSessionDbPath } from "./sessionStore";

const execFile = promisify(execFileCallback);

let scratch: string;
let repoRoot: string;

async function fileHash(filePath: string): Promise<string | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  return createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex");
}

async function reindex(): Promise<void> {
  const paths = resolveRepoLocalPaths(repoRoot);
  await reindexRepoAndRefreshState({
    repoRoot,
    dbPath: paths.dbPath,
    statePath: paths.statePath,
    configPresent: true,
    statePresent: true,
    usesDbPathOverride: false,
  });
}

/** Seed one manifest and one observation through the real repositories. */
function seedProductState(): { manifestId: string; observationId: string } {
  const db = openProductIndexDatabase(resolveIndexDbPath(repoRoot));
  const lease = new ProductStoreLease(db, resolveIndexDbPath(repoRoot));
  try {
    const stores = lease.write;
    const sourceRunId = getLatestIndexRun(db)!.id;

    const manifestId = persistCapsuleV2ManifestBestEffort(
      stores,
      "pick_winner",
      [{
        symbolId: "engine.pick_winner",
        filePath: "src/engine.py",
        fqName: "engine.pick_winner",
        symbolKind: "function",
        role: "pivot",
        contentMode: "full",
        sourceBacked: true,
      }],
      sourceRunId,
    );
    assert.notEqual(manifestId, null);

    const observation = persistObservation(stores, {
      repoRoot,
      kind: "insight" as never,
      source: "manual" as never,
      summary: "pick_winner returns the first sorted record",
      body: "",
      sourceRunId,
      linkedFilePaths: ["src/engine.py"],
    });

    return { manifestId: manifestId!, observationId: observation.id };
  } finally {
    lease.close();
    db.close();
  }
}

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "vtrace-m152-lifecycle-"));
  repoRoot = path.join(scratch, "fixture");
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "src", "engine.py"),
    "def pick_winner(records):\n    return sorted(records)[0]\n",
  );
  await execFile("git", ["init", "--initial-branch=main"], { cwd: repoRoot });
  await execFile("git", ["config", "user.email", "m152@example.com"], { cwd: repoRoot });
  await execFile("git", ["config", "user.name", "M152"], { cwd: repoRoot });
  await execFile("git", ["add", "."], { cwd: repoRoot });
  await execFile("git", ["commit", "-m", "initial"], { cwd: repoRoot });
  await initRepo({ repoPath: repoRoot });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("M152 index and session lifecycles are independent", () => {
  test("index_repo changes the index and preserves session state", async () => {
    // §144. The indexer must not wipe product history as a side effect of doing
    // its own job — the old CASCADE meant it silently did.
    const { manifestId, observationId } = seedProductState();
    const sessionBefore = await fileHash(resolveSessionDbPath(repoRoot));
    assert.notEqual(sessionBefore, null);

    await writeFile(
      path.join(repoRoot, "src", "engine.py"),
      "def pick_winner(records):\n    ordered = sorted(records)\n    return ordered[0]\n",
    );
    await reindex();

    const db = openProductIndexDatabase(resolveIndexDbPath(repoRoot));
    const lease = new ProductStoreLease(db, resolveIndexDbPath(repoRoot));
    try {
      const manifest = getCapsuleManifestById(lease.read.session, manifestId);
      assert.notEqual(manifest, undefined, "the manifest must survive a reindex");
      assert.equal(manifest!.items.length, 1, "and so must its items");

      const observations = listObservations(lease.read.session);
      assert.equal(
        observations.some((observation) => observation.id === observationId),
        true,
        "observations must survive a reindex (§146)",
      );
    } finally {
      lease.close();
      db.close();
    }
  });

  test("a manifest built before a reindex is reported stale, not missing", async () => {
    // §145, and the central reason the CASCADE had to go: "exists" and
    // "current" must be two different answers.
    const { manifestId } = seedProductState();

    await writeFile(
      path.join(repoRoot, "src", "engine.py"),
      "def pick_winner(records):\n    ordered = sorted(records)\n    return ordered[-1]\n",
    );
    await reindex();

    const db = openProductIndexDatabase(resolveIndexDbPath(repoRoot));
    const lease = new ProductStoreLease(db, resolveIndexDbPath(repoRoot));
    try {
      const comparisonRunId = getLatestIndexRun(db)!.id;
      const staleness = getCapsuleStaleness(lease.read, manifestId, comparisonRunId);

      assert.notEqual(staleness, undefined, "staleness must be computable across the two stores");
      expect(staleness!.status).toBe(StaleStateStatus.Stale);
      assert.equal(
        getCapsuleManifestById(lease.read.session, manifestId) === undefined,
        false,
        "and the manifest is still stored",
      );
    } finally {
      lease.close();
      db.close();
    }
  });

  test("an unchanged reindex leaves the manifest current", async () => {
    // The control. Without it, "stale" above could be an artifact of reindexing
    // at all rather than of the source actually moving.
    const { manifestId } = seedProductState();
    await reindex();

    const db = openProductIndexDatabase(resolveIndexDbPath(repoRoot));
    const lease = new ProductStoreLease(db, resolveIndexDbPath(repoRoot));
    try {
      const staleness = getCapsuleStaleness(
        lease.read,
        manifestId,
        getLatestIndexRun(db)!.id,
      );
      assert.notEqual(staleness, undefined);
      expect(staleness!.status).toBe(StaleStateStatus.Fresh);
    } finally {
      lease.close();
      db.close();
    }
  });

  test("session state outliving its index run is reported stale, not thrown", async () => {
    // The failure mode the split CREATES, and the one M152 has to answer for.
    // Independent lifecycles mean `index.sqlite` can be deleted and rebuilt from
    // scratch — run ids restart at 1 — while `session.sqlite` survives holding
    // rows that name run 11. Before the split this was impossible: the
    // observations lived in the file that was deleted.
    //
    // `search_memory` and `check_capsule_staleness` used to throw on
    // `comparisonRunId < sourceRunId`. Throwing here would take out memory for
    // the whole repository over a condition whose honest answer is "stale".
    const { manifestId } = seedProductState();

    const sessionDb = new Database(resolveSessionDbPath(repoRoot));
    try {
      // Push both records beyond any run the index will ever hold.
      sessionDb.run("UPDATE observations SET source_run_id = 9999");
      sessionDb.run("UPDATE capsule_manifests SET source_run_id = 9999");
    } finally {
      sessionDb.close();
    }

    const db = openProductIndexDatabase(resolveIndexDbPath(repoRoot));
    const lease = new ProductStoreLease(db, resolveIndexDbPath(repoRoot));
    try {
      const stores = lease.read;
      const context = await resolveCurrentObservationContext(repoRoot);

      const results = searchMemory(stores, {
        query: "pick_winner returns the first sorted record",
        maxResults: 5,
        includeStale: true,
        currentContext: context,
      });
      // The point is that it ANSWERED rather than threw.
      assert.equal(Array.isArray(results), true);

      const staleness = getCapsuleStaleness(stores, manifestId, getLatestIndexRun(db)!.id);
      assert.notEqual(staleness, undefined, "staleness must be answerable, not fatal");
      expect(staleness!.status).toBe(StaleStateStatus.Stale);
      assert.equal(
        getCapsuleManifestById(lease.read.session, manifestId) === undefined,
        false,
        "and the manifest is still stored",
      );
    } finally {
      lease.close();
      db.close();
    }
  });

  test("initialising the session schema never touches the index", async () => {
    // §32, §117. Even the session store's own migration code is handed no
    // write-capable index handle — it is not in scope.
    const indexPath = resolveIndexDbPath(repoRoot);
    const before = await fileHash(indexPath);

    const db = openProductIndexDatabase(indexPath);
    const lease = new ProductStoreLease(db, indexPath);
    try {
      const session = lease.write.session;
      initializeSessionSchema(session);
      initializeSessionSchema(session);
    } finally {
      lease.close();
      db.close();
    }

    assert.equal(await fileHash(indexPath), before, "no session operation may change the index");
  });

  test("a repository with no product state creates no session store", async () => {
    // §35, §76. Reading memory that was never written must not leave a file
    // behind, or every frozen benchmark index grows one.
    const sessionPath = resolveSessionDbPath(repoRoot);
    assert.equal(await fileHash(sessionPath), null, "precondition: no store yet");

    const db = openProductIndexDatabase(resolveIndexDbPath(repoRoot));
    const lease = new ProductStoreLease(db, resolveIndexDbPath(repoRoot));
    try {
      const observations = listObservations(lease.read.session);
      assert.deepEqual(observations, [], "an absent store reads as empty");
    } finally {
      lease.close();
      db.close();
    }

    assert.equal(await fileHash(sessionPath), null, "and creates nothing");
  });

  test("two worktrees of one repository keep separate product state", async () => {
    // §86, §87. `.vtrace` is per-worktree, so the session store beside it is
    // too. Worktree computation may be reused; worktree authority may not.
    const linked = path.join(scratch, "linked");
    await execFile("git", ["worktree", "add", linked, "-b", "feature"], { cwd: repoRoot });
    await initRepo({ repoPath: linked });

    seedProductState();

    const linkedDb = openProductIndexDatabase(resolveIndexDbPath(linked));
    const linkedLease = new ProductStoreLease(linkedDb, resolveIndexDbPath(linked));
    try {
      assert.deepEqual(
        listObservations(linkedLease.read.session),
        [],
        "the linked worktree must not see the main worktree's memory",
      );
    } finally {
      linkedLease.close();
      linkedDb.close();
    }

    assert.notEqual(resolveSessionDbPath(repoRoot), resolveSessionDbPath(linked));
  });
});
