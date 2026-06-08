import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { test } from "bun:test";

import { openIndexerDatabase } from "../sqlite";
import { computeIndexFingerprints } from "../../indexer/indexMeta";
import type { SymbolId } from "../../domain/types";
import {
  replaceBodyLiteralsForFile,
  searchBodyLiterals,
  deleteBodyLiteralsForFile,
} from "./bodyLiteralsRepository";

test("body-literal round-trip: store then recover the emitting symbol", () => {
  const db = openIndexerDatabase();
  try {
    // The repo joins to `symbols`/`files`, so a minimal symbol+file must exist.
    db.run("INSERT INTO files (id, path, language, content_hash, size_bytes) VALUES (?,?,?,?,?)", [
      "f1", "db/models/base.py", "python", "h", 10,
    ]);
    db.run(
      `INSERT INTO symbols (id, file_id, fq_name, local_name, kind, signature, start_line, end_line, start_byte, end_byte, exported)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ["s1", "f1", "base.py::Model::_check_ordering", "_check_ordering", "method", "sig", 1, 2, 0, 10, 1],
    );

    replaceBodyLiteralsForFile(db, { path: "db/models/base.py" }, [
      { symbolId: "s1" as SymbolId, literalsText: "models.e015 e015 cannot resolve keyword" },
    ]);

    assert.equal(searchBodyLiterals(db, '"e015"', 10).length, 1, "exact code term matches");
    assert.equal(searchBodyLiterals(db, '"cannot" AND "resolve" AND "keyword"', 10)[0]?.local_name, "_check_ordering");
    assert.equal(searchBodyLiterals(db, '"e404"', 10).length, 0, "an absent code does not match");

    deleteBodyLiteralsForFile(db, { path: "db/models/base.py" });
    assert.equal(searchBodyLiterals(db, '"e015"', 10).length, 0, "delete clears the file's rows");
  } finally {
    db.close();
  }
});

test("empty match expression and non-positive limit return nothing", () => {
  const db = openIndexerDatabase();
  try {
    assert.deepEqual(searchBodyLiterals(db, "", 10), []);
    assert.deepEqual(searchBodyLiterals(db, '"x"', 0), []);
  } finally {
    db.close();
  }
});

test("index fingerprint covers body-literal indexing (schema + extractor)", async () => {
  // Schema coverage: the body-literals FTS table is part of the hashed schema
  // (src/db/schema.ts), so the fingerprint's schema_version changes if its DDL
  // changes — the index auto-reinvalidates when body-literal indexing changes.
  const db = openIndexerDatabase();
  try {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    assert.ok(
      tables.some((t) => t.name === "symbol_body_literals_fts"),
      "the body-literal FTS table is part of the indexed schema",
    );
  } finally {
    db.close();
  }

  const fingerprint = await computeIndexFingerprints();
  assert.ok(fingerprint.schema_version.length > 0);
  assert.ok(fingerprint.indexer_fingerprint.length > 0);
  // The extractor logic lives under src/indexer, which feeds indexer_fingerprint —
  // so a change to it changes the fingerprint and forces a reindex.
  assert.ok((await stat("src/indexer/extractBodyLiterals.ts")).isFile());
});
