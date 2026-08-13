// M143 Workstream B — what the index can and cannot say about behaviour ownership.
//
// M143-A closed the title-local question: no property of a title-named candidate
// separates a titled BYSTANDER from a titled EDIT SITE. B asked whether the
// REPOSITORY can answer instead — whether some relation shows that a candidate
// implements the behaviour a request describes.
//
// This suite pins the four load-bearing facts that answer measured, so that a
// later change to the index either preserves them or fails here loudly. Every
// fixture is generic: invented module and class names, no instance ids, no
// repository rules.
//
//   1. inheritance IS persisted — as an undifferentiated `references` edge
//   2. the parser's `inheritance` reference KIND is NOT recoverable
//   3. a generic behaviour owner has NO edge to the entity it operates on
//   4. an override surface IS reconstructible from `references` + `contains`
//
// (3) is the ceiling. It is the generic form of `django-11740`: the migration
// autodetector owns the requested behaviour and never names `ForeignKey`,
// because it is written against field instances rather than field classes. The
// index is not missing that edge — the edge does not exist in the source.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";
import type { Database } from "bun:sqlite";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";

async function indexFixture(files: Readonly<Record<string, string>>): Promise<Database> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "vtrace-m143b-"));
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(repoRoot, relPath);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, content, "utf8");
  }
  const db = openIndexerDatabase();
  await indexProject({ repoRoot, db });
  return db;
}

const edgesBetween = (db: Database, fromFq: string, toFq: string): Array<{ t: string; n: number }> =>
  db
    .query(
      `SELECT e.edge_type AS t, COUNT(*) AS n FROM edges e
         JOIN symbols ss ON ss.id = e.src_symbol_id
         JOIN symbols ds ON ds.id = e.dst_symbol_id
        WHERE (ss.fq_name = ? OR ss.fq_name LIKE ?) AND (ds.fq_name = ? OR ds.fq_name LIKE ?)
        GROUP BY e.edge_type`,
    )
    .all(fromFq, `${fromFq}.%`, toFq, `${toFq}.%`) as Array<{ t: string; n: number }>;

const members = (db: Database, classFq: string): string[] =>
  (db.query(`SELECT local_name FROM symbols WHERE fq_name LIKE ?`).all(`${classFq}.%`) as Array<{
    local_name: string;
  }>).map((row) => row.local_name);

/** A subclass in one module, its base in another — the shape override evidence needs. */
const INHERITANCE_FIXTURE: Readonly<Record<string, string>> = {
  "backend/__init__.py": "",
  "backend/base.py":
    "class Backend:\n    def write_input(self, job):\n        raise NotImplementedError\n\n"
    + "    def parse_output(self, log):\n        raise NotImplementedError\n",
  "backend/adapter.py":
    "from backend.base import Backend\n\n\nclass ToolAdapter(Backend):\n"
    + "    def write_input(self, job):\n        return self.render_keywords(job)\n\n"
    + "    def render_keywords(self, job):\n        return ' '.join(job.keywords)\n",
};

test("M143-B: cross-module inheritance is persisted as a class-to-class references edge", async () => {
  const db = await indexFixture(INHERITANCE_FIXTURE);
  try {
    const direct = db
      .query(
        `SELECT COUNT(*) AS n FROM edges e
           JOIN symbols ss ON ss.id = e.src_symbol_id
           JOIN symbols ds ON ds.id = e.dst_symbol_id
          WHERE ss.fq_name = ? AND ds.fq_name = ? AND e.edge_type = 'references'`,
      )
      .get("backend/adapter.py::ToolAdapter", "backend/base.py::Backend") as { n: number };
    // This is the relation the override surface is reconstructed from. Without
    // it there is no deterministic interface evidence at all.
    assert.equal(direct.n, 1, "subclass -> base must survive as a `references` edge");
  } finally {
    db.close();
  }
});

test("M143-B: the parser's `inheritance` reference kind is NOT recoverable from the index", async () => {
  const db = await indexFixture(INHERITANCE_FIXTURE);
  try {
    // The Python parser distinguishes `inheritance`, `decorator` and `annotation`
    // reference kinds, then discards the distinction: `edges.edge_type` admits
    // only contains/imports/calls/references. So "X inherits Y" and "X mentions Y
    // in an annotation" are the same row, and any interface reasoning built on
    // this edge must tolerate that ambiguity.
    const kinds = (db.query(`SELECT DISTINCT edge_type FROM edges ORDER BY edge_type`).all() as Array<{
      edge_type: string;
    }>).map((row) => row.edge_type);
    for (const kind of kinds) {
      assert.ok(
        ["contains", "imports", "calls", "references"].includes(kind),
        `unexpected edge_type ${kind} — if an inheritance edge type was added, M143-B's ceiling changed`,
      );
    }
    assert.ok(!kinds.includes("inherits"), "no dedicated inheritance edge type exists");
  } finally {
    db.close();
  }
});

test("M143-B ceiling: a generic behaviour owner has no edge to the entity it operates on", async () => {
  // The task subject (`LinkField`) and the code that implements the requested
  // behaviour (`ChangePlanner.generate_altered_fields`) are structurally
  // disconnected, because the planner is written against field INSTANCES. This
  // is why no relation-based mechanism can promote the planner over the subject:
  // there is no relation to read. Measured identically on the real case —
  // `ForeignKey` has 193 incoming edges and not one of them is autodetector.py.
  const db = await indexFixture({
    "app/__init__.py": "",
    "app/fields/__init__.py": "",
    "app/fields/relations.py":
      "class BaseField:\n    def db_type(self, connection):\n        raise NotImplementedError\n\n\n"
      + "class LinkField(BaseField):\n"
      + "    def __init__(self, target, on_delete):\n        self.target = target\n        self.on_delete = on_delete\n\n"
      + "    def db_type(self, connection):\n        return connection.link_type()\n",
    "app/schema/__init__.py": "",
    "app/schema/planner.py":
      "class ChangePlanner:\n"
      + "    def generate_altered_fields(self, old_state, new_state):\n"
      + "        for name, field in self.changed_fields(old_state, new_state):\n"
      + "            dependency = self.dependencies_for(field)\n            self.record(dependency)\n\n"
      + "    def dependencies_for(self, field):\n"
      + "        if field.remote_target is not None:\n            return (field.remote_target, 'cross_module')\n"
      + "        return None\n",
  });
  try {
    const subject = "app/fields/relations.py::LinkField";
    const owner = "app/schema/planner.py::ChangePlanner";
    assert.deepEqual(edgesBetween(db, owner, subject), [], "owner -> subject: no relation exists");
    assert.deepEqual(edgesBetween(db, subject, owner), [], "subject -> owner: no relation exists");
  } finally {
    db.close();
  }
});

test("M143-B: an override surface is reconstructible, and separates same-domain roles", async () => {
  const db = await indexFixture({
    ...INHERITANCE_FIXTURE,
    "backend/parser.py":
      "from backend.base import Backend\n\n\nclass ToolParser(Backend):\n"
      + "    def parse_output(self, log):\n        return self.read_energies(log)\n\n"
      + "    def read_energies(self, log):\n        return [line for line in log if 'energy' in line]\n",
  });
  try {
    const base = new Set(members(db, "backend/base.py::Backend"));
    const overridesOf = (classFq: string): string[] =>
      members(db, classFq).filter((member) => base.has(member));

    // Two classes of the same domain, inheriting the same interface, are
    // separated by WHICH interface member each takes responsibility for. This is
    // the one ownership discriminator B found that is a repository fact rather
    // than a name coincidence.
    assert.deepEqual(overridesOf("backend/adapter.py::ToolAdapter"), ["write_input"]);
    assert.deepEqual(overridesOf("backend/parser.py::ToolParser"), ["parse_output"]);

    // ...and it is only usable when the request names the member. `write_input`
    // is not reachable from a request that says "emit route keywords", which is
    // exactly why the ARC Gaussian acceptance abstains rather than electing the
    // job adapter. Bridging that gap needs a synonym lexicon, which M143-B
    // rejected as a weak heuristic.
    const surface = overridesOf("backend/adapter.py::ToolAdapter").join(" ");
    assert.ok(surface.includes("input"), "an 'input' request reaches the adapter");
    assert.ok(!surface.includes("emit"), "an 'emit' request does not — the vocabulary gap is real");
  } finally {
    db.close();
  }
});
