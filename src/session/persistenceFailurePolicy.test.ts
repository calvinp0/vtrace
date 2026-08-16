// M152-C — what each session-backed feature does when its write fails.
//
// The rule is not "handle errors". It is: fail closed for any externally
// returned identifier whose truth depends on persistence, fail open for
// auxiliary features when the core retrieval stays truthful without them — and
// in every case leave `index.sqlite` alone.
//
// Failure is INJECTED rather than simulated by argument, so what is tested is
// the real call path with a real store that really cannot be written.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { persistObservation } from "./repositories/observationsRepository";
import {
  getCapsuleManifestById,
  persistCapsuleV2ManifestBestEffort,
} from "./repositories/capsuleManifestsRepository";
import {
  persistDeferredVexpRef,
  resolvePersistentDeferredVexpRef,
} from "./repositories/deferredVexpRefsRepository";
import {
  PersistenceFailureMode,
  SESSION_PERSISTENCE_FAILURE_POLICY,
  SessionBackedFeature,
  persistBestEffort,
  persistOrOmitIdentifier,
  persistOrRefuse,
  resolvePersistenceFailureMode,
} from "./persistenceFailurePolicy";
import { createEphemeralSessionDatabase, type WritableSessionDatabase } from "./sessionStore";

/**
 * A session store that accepts reads and refuses every write, standing in for a
 * full disk, a read-only filesystem, or a corrupt store.
 */
function createUnwritableSessionDatabase(): WritableSessionDatabase {
  const db = createEphemeralSessionDatabase();
  db.run("PRAGMA query_only = ON");
  return db;
}

function indexWithOneRun(): Database {
  const db = openIndexerDatabase();
  db.run("INSERT INTO index_runs (id, previous_run_id, created_at_ms) VALUES (1, NULL, 100)");
  return db;
}

function indexDigest(db: Database): string {
  const hash = createHash("sha256");
  const names = (db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[]).map((row) => row.name);
  for (const name of names) {
    hash.update(name);
    for (const row of db.query(`SELECT * FROM "${name}"`).iterate() as Iterable<unknown>) {
      hash.update(JSON.stringify(row));
    }
  }
  return hash.digest("hex");
}

describe("M152 session persistence failure policy", () => {
  test("every session-backed feature declares a failure mode", () => {
    // Adding a feature without deciding its semantics is what the declaration
    // exists to prevent, so the completeness is asserted rather than assumed.
    for (const feature of Object.values(SessionBackedFeature)) {
      assert.notEqual(
        resolvePersistenceFailureMode(feature),
        undefined,
        `${feature} must declare a persistence failure mode`,
      );
    }
    assert.equal(
      Object.keys(SESSION_PERSISTENCE_FAILURE_POLICY).length,
      Object.values(SessionBackedFeature).length,
    );
  });

  test("the declared modes match the governing rule", () => {
    assert.equal(
      resolvePersistenceFailureMode(SessionBackedFeature.DeferredRef),
      PersistenceFailureMode.RequirePersistence,
    );
    assert.equal(
      resolvePersistenceFailureMode(SessionBackedFeature.CapsuleManifest),
      PersistenceFailureMode.OmitIdentifierOnFailure,
    );
    assert.equal(
      resolvePersistenceFailureMode(SessionBackedFeature.Observation),
      PersistenceFailureMode.BestEffort,
    );
    assert.equal(
      resolvePersistenceFailureMode(SessionBackedFeature.ProjectRules),
      PersistenceFailureMode.BestEffort,
    );
  });

  test("a failed deferred-ref write emits no reference at all", () => {
    // §39, §73. The sharp case: a hash returned without its backing row is a
    // reference `expand_vexp_ref` can never answer.
    const indexDb = indexWithOneRun();
    const sessionDb = createUnwritableSessionDatabase();
    try {
      const before = indexDigest(indexDb);
      let emitted: string | null = null;

      assert.throws(() => {
        persistOrRefuse(() => persistDeferredVexpRef(sessionDb, {
          entry: {
            hash: "abcdef012345",
            stableId: "vexp:capsule:x",
            category: "context_capsule",
            content: { kind: "json", value: 1 },
            metadata: {},
            createdAtMs: 1,
            lastAccessedAtMs: 1,
            expiresAtMs: null,
          } as never,
          repoRoot: "/fixture/repo",
          sourceRunId: 1,
          sessionId: null,
          notes: [],
        }));
        emitted = "abcdef012345";
      });

      assert.equal(emitted, null, "no ref may be emitted when persistence failed");
      assert.equal(
        resolvePersistentDeferredVexpRef(sessionDb, "abcdef012345"),
        null,
        "and nothing may resolve",
      );
      assert.equal(indexDigest(indexDb), before, "index.sqlite must be untouched");
    } finally {
      sessionDb.close();
      indexDb.close();
    }
  });

  test("a failed manifest write yields no capsuleManifestId, and the request survives", () => {
    // §40, §169. The context is exactly as true without an id; what would be
    // false is an id naming a manifest `check_capsule_staleness` cannot load.
    const indexDb = indexWithOneRun();
    const sessionDb = createUnwritableSessionDatabase();
    try {
      const before = indexDigest(indexDb);

      const manifestId = persistCapsuleV2ManifestBestEffort(
        { index: indexDb, session: sessionDb },
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
        1,
      );

      assert.equal(manifestId, null, "no id may be returned when the manifest did not persist");
      assert.equal(indexDigest(indexDb), before, "index.sqlite must be untouched");
    } finally {
      sessionDb.close();
      indexDb.close();
    }
  });

  test("an id is only ever returned once the manifest is actually loadable", () => {
    const indexDb = indexWithOneRun();
    const sessionDb = createEphemeralSessionDatabase();
    try {
      const manifestId = persistCapsuleV2ManifestBestEffort(
        { index: indexDb, session: sessionDb },
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
        1,
      );

      assert.notEqual(manifestId, null);
      const manifest = getCapsuleManifestById(sessionDb, manifestId!);
      assert.notEqual(manifest, undefined, "a returned id must resolve to a stored manifest");
      assert.equal(manifest!.items.length, 1);
    } finally {
      sessionDb.close();
      indexDb.close();
    }
  });

  test("a failed observation write is swallowed and changes no store", () => {
    // §41. Memory auto-capture is auxiliary: converting its failure into a
    // retrieval failure would be a regression dressed as strictness.
    const indexDb = indexWithOneRun();
    const sessionDb = createUnwritableSessionDatabase();
    try {
      const before = indexDigest(indexDb);

      const observation = persistBestEffort(() => persistObservation(
        { index: indexDb, session: sessionDb },
        {
          repoRoot: "/fixture/repo",
          kind: "insight" as never,
          source: "manual" as never,
          summary: "Auxiliary note",
          body: "",
        },
      ));

      assert.equal(observation, undefined, "the failure is reported as absence, not thrown");
      assert.equal(indexDigest(indexDb), before, "index.sqlite must be untouched");
    } finally {
      sessionDb.close();
      indexDb.close();
    }
  });

  test("search_memory does not report an observation that failed to persist", () => {
    const indexDb = indexWithOneRun();
    const sessionDb = createUnwritableSessionDatabase();
    try {
      persistBestEffort(() => persistObservation(
        { index: indexDb, session: sessionDb },
        {
          repoRoot: "/fixture/repo",
          kind: "insight" as never,
          source: "manual" as never,
          summary: "Never stored",
          body: "",
        },
      ));

      const rows = sessionDb.query("SELECT COUNT(*) AS n FROM observations").get() as { n: number };
      expect(rows.n).toBe(0);
    } finally {
      sessionDb.close();
      indexDb.close();
    }
  });

  test("persistOrOmitIdentifier reports failure as null rather than an invented value", () => {
    assert.equal(persistOrOmitIdentifier(() => { throw new Error("disk full"); }), null);
    assert.equal(persistOrOmitIdentifier(() => "manifest-id"), "manifest-id");
  });

  test("persistOrRefuse propagates, so a caller cannot emit past a failure by accident", () => {
    assert.throws(() => persistOrRefuse(() => { throw new Error("disk full"); }));
  });
});
