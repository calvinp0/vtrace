import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { Database } from "bun:sqlite";

import { PROBES, evaluateControl } from "./run_stage5_m155_capability_controls";

// M155 §22/§23. These controls exist so the benchmark can never again report
// "unchanged" because the index it read lacked the evidence the lane consumes.
// Each probe therefore needs a fixture where the capability is provably absent and
// one where it is provably present — including the case where the TABLE is absent,
// which is an era difference and not a zero.

async function indexWith(build: (db: Database) => void): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "m155-cap-"));
  await mkdir(path.join(root, ".vtrace"), { recursive: true });
  const file = path.join(root, ".vtrace", "index.sqlite");
  const db = new Database(file);
  try {
    build(db);
  } finally {
    db.close();
  }
  return file;
}

const withDocuments = (rows: number) => (db: Database): void => {
  db.run("create table document_chunks (id integer primary key)");
  for (let i = 0; i < rows; i += 1) db.run("insert into document_chunks values (?)", [i + 1]);
};

const withoutDocumentTable = (db: Database): void => {
  db.run("create table files (id integer primary key)");
};

const withModuleSymbols = (moduleCount: number, otherCount: number) => (db: Database): void => {
  db.run("create table symbols (id integer primary key, kind text)");
  for (let i = 0; i < moduleCount; i += 1) db.run("insert into symbols (kind) values ('module')");
  for (let i = 0; i < otherCount; i += 1) db.run("insert into symbols (kind) values ('function')");
};

// --- probe truthfulness -----------------------------------------------------

test("a missing capability table probes as null, not as zero", async () => {
  const file = await indexWith(withoutDocumentTable);
  const db = new Database(file, { readonly: true });
  try {
    // "the table does not exist" and "the table exists and is empty" are different
    // facts about an index, and M155 needs to tell them apart: the first is an era
    // difference, the second is a populated-lane failure.
    assert.equal(PROBES.document_chunks!(db), null);
  } finally {
    db.close();
  }
});

test("an empty capability table probes as zero, not as null", async () => {
  const file = await indexWith(withDocuments(0));
  const db = new Database(file, { readonly: true });
  try {
    assert.equal(PROBES.document_chunks!(db), 0);
  } finally {
    db.close();
  }
});

test("the module probe counts only module-kind symbols", async () => {
  const file = await indexWith(withModuleSymbols(69, 765));
  const db = new Database(file, { readonly: true });
  try {
    assert.equal(PROBES.module_symbols!(db), 69);
  } finally {
    db.close();
  }
});

// --- control separation -----------------------------------------------------

test("KNOWN-POSITIVE: a populated lane separates from an empty one", async () => {
  const control = evaluateControl({
    capability: "document lane", probe: "document_chunks", rationale: "r",
    negativeCheckpoint: "before", positiveCheckpoint: "after",
    negativeIndex: await indexWith(withDocuments(0)),
    positiveIndex: await indexWith(withDocuments(6)),
  });
  assert.equal(control.observable, true);
  assert.equal(control.negativeValue, 0);
  assert.equal(control.positiveValue, 6);
});

test("KNOWN-POSITIVE: an absent table separates from a populated one", async () => {
  const control = evaluateControl({
    capability: "mechanism lane", probe: "symbol_mechanism_facts", rationale: "r",
    negativeCheckpoint: "before", positiveCheckpoint: "after",
    negativeIndex: await indexWith(withoutDocumentTable),
    positiveIndex: await indexWith((db) => {
      db.run("create table symbol_mechanism_facts (id integer primary key)");
      db.run("insert into symbol_mechanism_facts values (1)");
    }),
  });
  assert.equal(control.observable, true);
  assert.equal(control.negativeValue, null);
  assert.equal(control.positiveValue, 1);
});

test("KNOWN-NEGATIVE: identical evidence is reported as a BLIND SPOT, not a pass", async () => {
  // The control for the control. If this returned `observable: true` the whole
  // observability argument would be unfalsifiable.
  const same = withDocuments(6);
  const control = evaluateControl({
    capability: "document lane", probe: "document_chunks", rationale: "r",
    negativeCheckpoint: "before", positiveCheckpoint: "after",
    negativeIndex: await indexWith(same),
    positiveIndex: await indexWith(same),
  });
  assert.equal(control.observable, false);
  assert.match(control.note, /BLIND SPOT/);
});

test("a missing index file probes as null on that side", async () => {
  const control = evaluateControl({
    capability: "document lane", probe: "document_chunks", rationale: "r",
    negativeCheckpoint: "before", positiveCheckpoint: "after",
    negativeIndex: "/nonexistent/index.sqlite",
    positiveIndex: await indexWith(withDocuments(6)),
  });
  assert.equal(control.negativeValue, null);
  assert.equal(control.observable, true);
});

test("an unknown probe name is rejected rather than silently skipped", () => {
  assert.throws(() => evaluateControl({
    capability: "x", probe: "not_a_probe", rationale: "r",
    negativeCheckpoint: "a", positiveCheckpoint: "b",
    negativeIndex: "/x", positiveIndex: "/y",
  }), /unknown probe/);
});
