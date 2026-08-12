// M140 Workstream A — import-edge attribution stability.
//
// These are PRODUCT-level tests: they write a real fixture repo, run the real
// indexer, and read the persisted `edges` table. The defect this suite guards
// manifested at index level, not inside a parser helper, so asserting on parser
// output alone would not have caught it.
//
// THE INVARIANT
// -------------
//   source state A:  `import I` exists
//   source state B:  A + an unrelated definition U that neither shadows,
//                    rebinds, nor otherwise affects I
//   =>               import attribution for I is IDENTICAL
//
// and its necessary counterpart, so stability never degenerates into freezing
// wrong edges:
//
//   a RELEVANT edit (retargeting the import) MUST change attribution.
//
// Before M140 a file's import edges were attributed to its single top-level
// symbol and dropped entirely when a second one appeared, so `+ def unrelated()`
// deleted an unchanged import edge.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";

type Files = Readonly<Record<string, string>>;

/** One persisted import edge, in a form that is stable to compare across runs. */
interface ImportEdge {
  readonly from: string;
  readonly to: string;
}

async function writeRepo(root: string, files: Files): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const full = path.join(root, relativePath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

function readImportEdges(db: ReturnType<typeof openIndexerDatabase>): ImportEdge[] {
  return (db.query(`
    SELECT src.fq_name AS "from", dst.fq_name AS "to"
    FROM edges e
    INNER JOIN symbols src ON src.id = e.src_symbol_id
    INNER JOIN symbols dst ON dst.id = e.dst_symbol_id
    WHERE e.edge_type = 'imports'
    ORDER BY src.fq_name ASC, dst.fq_name ASC
  `).all() as ImportEdge[]);
}

/** Index `files` from scratch and return the persisted import edges. */
async function importEdgesOf(files: Files): Promise<ImportEdge[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), "m140-attr-"));
  const db = openIndexerDatabase();
  try {
    await writeRepo(root, files);
    await indexProject({ repoRoot: root, db, refreshMode: "full" });
    return readImportEdges(db);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Assert that mutating `importer.py` from `before` to `after` leaves import
 * attribution untouched, and that the edge set is non-empty (a rule that
 * emits nothing is trivially "stable").
 */
async function assertAttributionUnchanged(
  label: string,
  base: Files,
  before: string,
  after: string,
): Promise<void> {
  const edgesBefore = await importEdgesOf({ ...base, "importer.py": before });
  const edgesAfter = await importEdgesOf({ ...base, "importer.py": after });

  assert.equal(edgesBefore.length > 0, true, `${label}: fixture produced no import edge to test`);
  assert.deepEqual(edgesAfter, edgesBefore, `${label}: unrelated edit changed import attribution`);
}

const MODEL: Files = {
  "model.py": "class Thing:\n    def run(self):\n        return 1\n",
};

// --- the minimal M139 reproduction, as a regression test ---------------------

test("M139 repro: adding an unrelated function does not drop the import edge", async () => {
  const before = "from model import Thing\n\n\ndef use():\n    return Thing()\n";
  const after = `${before}\n\ndef unrelated():\n    return 1\n`;

  const edgesBefore = await importEdgesOf({ ...MODEL, "importer.py": before });
  const edgesAfter = await importEdgesOf({ ...MODEL, "importer.py": after });

  assert.deepEqual(edgesBefore, [{ from: "importer.py::<module>", to: "model.py::Thing" }]);
  assert.deepEqual(edgesAfter, edgesBefore);
});

// --- §8 import forms A-F x unrelated additions -------------------------------

const IMPORT_FORMS: readonly { readonly key: string; readonly base: Files; readonly statement: string }[] = [
  { key: "A from-import", base: MODEL, statement: "from model import Thing" },
  { key: "B module-import", base: MODEL, statement: "import model" },
  { key: "C module-import-as", base: MODEL, statement: "import model as m" },
  { key: "D from-import-as", base: MODEL, statement: "from model import Thing as T" },
  {
    key: "E relative-import",
    base: {
      "pkg/__init__.py": "",
      "pkg/model.py": "class Thing:\n    def run(self):\n        return 1\n",
    },
    statement: "from .model import Thing",
  },
  {
    key: "F init-reexport",
    base: {
      "pkg/__init__.py": "from .model import Thing\n",
      "pkg/model.py": "class Thing:\n    def run(self):\n        return 1\n",
    },
    statement: "from pkg import Thing",
  },
];

// Each addition is semantically inert with respect to the import: none of them
// shadow, rebind, or reference the imported name.
const UNRELATED_ADDITIONS: readonly { readonly key: string; readonly code: string }[] = [
  { key: "function", code: "def unrelated():\n    return 1\n" },
  { key: "class", code: "class Unrelated:\n    pass\n" },
  { key: "constant", code: "UNRELATED = 1\n" },
  { key: "comment", code: "# unrelated comment\n" },
  { key: "docstring-ish string", code: '"""Unrelated module note."""\n' },
  // §10: size / shape must not matter — this catches span-boundary dependence.
  { key: "large function", code: `def unrelated_large():\n${"    x = 1\n".repeat(200)}    return x\n` },
  { key: "nested function", code: "def outer():\n    def inner():\n        return 2\n    return inner\n" },
  { key: "async function", code: "async def unrelated_async():\n    return 3\n" },
  { key: "decorated function", code: "import functools\n\n\n@functools.cache\ndef unrelated_decorated():\n    return 4\n" },
];

for (const form of IMPORT_FORMS) {
  for (const addition of UNRELATED_ADDITIONS) {
    // The relative/re-export forms must be imported from inside the package.
    const importerKey = form.key.startsWith("E") || form.key.startsWith("F") ? "pkg/importer.py" : "importer.py";
    const base = importerKey === "pkg/importer.py"
      ? form.base
      : form.base;

    test(`${form.key}: import attribution survives adding an unrelated ${addition.key} after it`, async () => {
      const before = `${form.statement}\n\n\ndef use():\n    return 1\n`;
      const after = `${before}\n\n${addition.code}`;
      const withImporter = (content: string): Files => ({ ...base, [importerKey]: content });

      const edgesBefore = await importEdgesOf(withImporter(before));
      const edgesAfter = await importEdgesOf(withImporter(after));

      assert.equal(edgesBefore.length > 0, true, "fixture produced no import edge to test");
      assert.deepEqual(edgesAfter, edgesBefore);
    });

    test(`${form.key}: import attribution survives adding an unrelated ${addition.key} before it`, async () => {
      const before = `${form.statement}\n\n\ndef use():\n    return 1\n`;
      // Imports must stay at module level to remain top-level statements, so the
      // unrelated code goes between the import and the existing definition.
      const after = `${form.statement}\n\n${addition.code}\n\ndef use():\n    return 1\n`;
      const withImporter = (content: string): Files => ({ ...base, [importerKey]: content });

      const edgesBefore = await importEdgesOf(withImporter(before));
      const edgesAfter = await importEdgesOf(withImporter(after));

      assert.equal(edgesBefore.length > 0, true, "fixture produced no import edge to test");
      assert.deepEqual(edgesAfter, edgesBefore);
    });
  }
}

// --- §9 definition ordering ---------------------------------------------------

test("definition ordering does not retarget module-level import edges", async () => {
  await assertAttributionUnchanged(
    "definition order",
    MODEL,
    "from model import Thing\n\n\ndef a():\n    return Thing()\n\n\ndef b():\n    return 2\n",
    "from model import Thing\n\n\ndef b():\n    return 2\n\n\ndef a():\n    return Thing()\n",
  );
});

test("moving the import below a definition does not retarget it", async () => {
  await assertAttributionUnchanged(
    "import position",
    MODEL,
    "from model import Thing\n\n\ndef b():\n    return 2\n\n\ndef a():\n    return Thing()\n",
    "def b():\n    return 2\n\n\nfrom model import Thing\n\n\ndef a():\n    return Thing()\n",
  );
});

// --- §11 multiple imports, no cross-attribution -------------------------------

test("multiple imports keep distinct targets when unrelated code is added", async () => {
  const base: Files = {
    "a.py": "class A:\n    pass\n",
    "b.py": "class B:\n    pass\n",
  };
  const before = "from a import A\nfrom b import B\n\n\ndef use():\n    return (A, B)\n";
  const after = `${before}\n\ndef unrelated():\n    return 1\n`;

  const edgesBefore = await importEdgesOf({ ...base, "importer.py": before });
  const edgesAfter = await importEdgesOf({ ...base, "importer.py": after });

  assert.deepEqual(edgesBefore, [
    { from: "importer.py::<module>", to: "a.py::A" },
    { from: "importer.py::<module>", to: "b.py::B" },
  ]);
  assert.deepEqual(edgesAfter, edgesBefore);
});

// --- §12 colliding local names -------------------------------------------------

test("aliased imports of same-named symbols do not collapse through dedup", async () => {
  const base: Files = {
    "a.py": "class Thing:\n    pass\n",
    "b.py": "class Thing:\n    pass\n",
  };
  const before = "from a import Thing as AThing\nfrom b import Thing as BThing\n\n\ndef use():\n    return (AThing, BThing)\n";
  const after = `${before}\n\ndef unrelated():\n    return 1\n`;

  const edgesBefore = await importEdgesOf({ ...base, "importer.py": before });
  const edgesAfter = await importEdgesOf({ ...base, "importer.py": after });

  assert.deepEqual(edgesBefore, [
    { from: "importer.py::<module>", to: "a.py::Thing" },
    { from: "importer.py::<module>", to: "b.py::Thing" },
  ]);
  assert.deepEqual(edgesAfter, edgesBefore);
});

// --- §13 relevant edits MUST still change attribution ---------------------------

test("retargeting an import to another module changes the edge", async () => {
  const base: Files = {
    "a.py": "class Thing:\n    pass\n",
    "b.py": "class Thing:\n    pass\n",
  };
  const fromA = await importEdgesOf({ ...base, "importer.py": "from a import Thing\n\n\ndef use():\n    return Thing\n" });
  const fromB = await importEdgesOf({ ...base, "importer.py": "from b import Thing\n\n\ndef use():\n    return Thing\n" });

  assert.deepEqual(fromA, [{ from: "importer.py::<module>", to: "a.py::Thing" }]);
  assert.deepEqual(fromB, [{ from: "importer.py::<module>", to: "b.py::Thing" }]);
});

test("removing an import removes its edge", async () => {
  const withImport = await importEdgesOf({ ...MODEL, "importer.py": "from model import Thing\n\n\ndef use():\n    return 1\n" });
  const without = await importEdgesOf({ ...MODEL, "importer.py": "def use():\n    return 1\n" });

  assert.equal(withImport.length, 1);
  assert.deepEqual(without, []);
});

test("importing an additional name adds exactly that edge", async () => {
  const base: Files = { "model.py": "class Thing:\n    pass\n\n\nclass Other:\n    pass\n" };
  const one = await importEdgesOf({ ...base, "importer.py": "from model import Thing\n\n\ndef use():\n    return 1\n" });
  const two = await importEdgesOf({ ...base, "importer.py": "from model import Thing, Other\n\n\ndef use():\n    return 1\n" });

  assert.deepEqual(one, [{ from: "importer.py::<module>", to: "model.py::Thing" }]);
  assert.deepEqual(two, [
    { from: "importer.py::<module>", to: "model.py::Other" },
    { from: "importer.py::<module>", to: "model.py::Thing" },
  ]);
});

// --- §14/§15 shadowing and rebinding controls ------------------------------------
//
// Stability must not become "freeze the import edge no matter what the file
// does". These assert the import RELATION itself is unaffected by local
// shadowing (which is correct — the module still imports the name), while the
// call/reference graph is what distinguishes the shadowed use.

test("a local shadow does not fabricate or destroy the module's import edge", async () => {
  await assertAttributionUnchanged(
    "local shadow",
    MODEL,
    "from model import Thing\n\n\ndef use():\n    return Thing()\n",
    "from model import Thing\n\n\ndef use():\n    Thing = object()\n    return Thing\n",
  );
});

test("module-level rebinding does not change what the module imported", async () => {
  await assertAttributionUnchanged(
    "module rebind",
    MODEL,
    "from model import Thing\n\n\ndef use():\n    return Thing()\n",
    "from model import Thing\n\nThing = None\n\n\ndef use():\n    return Thing\n",
  );
});

test("a local shadow does not create a call edge to the imported symbol", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m140-shadow-"));
  const db = openIndexerDatabase();
  try {
    await writeRepo(root, {
      ...MODEL,
      "importer.py": "from model import Thing\n\n\ndef use():\n    Thing = object\n    return Thing()\n",
    });
    await indexProject({ repoRoot: root, db, refreshMode: "full" });
    const calls = db.query(`
      SELECT src.fq_name AS "from", dst.fq_name AS "to"
      FROM edges e
      INNER JOIN symbols src ON src.id = e.src_symbol_id
      INNER JOIN symbols dst ON dst.id = e.dst_symbol_id
      WHERE e.edge_type = 'calls'
    `).all() as ImportEdge[];

    assert.deepEqual(
      calls.filter((edge) => edge.from === "importer.py::use" && edge.to === "model.py::Thing"),
      [],
      "a locally shadowed name must not resolve to the imported symbol",
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

// --- §25 import and call edges stay distinct ---------------------------------------

test("adding an unrelated function preserves both import and call attribution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m140-mixed-"));
  const db = openIndexerDatabase();
  const readAll = () => db.query(`
    SELECT e.edge_type AS kind, src.fq_name AS "from", dst.fq_name AS "to"
    FROM edges e
    INNER JOIN symbols src ON src.id = e.src_symbol_id
    INNER JOIN symbols dst ON dst.id = e.dst_symbol_id
    WHERE e.edge_type IN ('imports', 'calls')
    ORDER BY e.edge_type ASC, src.fq_name ASC, dst.fq_name ASC
  `).all() as { kind: string; from: string; to: string }[];

  try {
    await writeRepo(root, {
      "model.py": "def build():\n    return 1\n",
      "importer.py": "from model import build\n\n\ndef use():\n    return build()\n",
    });
    await indexProject({ repoRoot: root, db, refreshMode: "full" });
    const before = readAll();

    await writeFile(
      path.join(root, "importer.py"),
      "from model import build\n\n\ndef use():\n    return build()\n\n\ndef unrelated():\n    return 2\n",
    );
    await indexProject({ repoRoot: root, db, refreshMode: "full" });
    const after = readAll();

    assert.deepEqual(before, [
      { kind: "calls", from: "importer.py::use", to: "model.py::build" },
      { kind: "imports", from: "importer.py::<module>", to: "model.py::build" },
    ]);
    assert.deepEqual(after, before, "the call edge must stay on the function, the import on the module");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

// --- §19/§20 full vs incremental equivalence, and no-op stability ------------------

test("incremental refresh after an unrelated edit matches a clean full build", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m140-incr-"));
  const incrementalDb = openIndexerDatabase();
  const fullDb = openIndexerDatabase();

  try {
    const initial = "from model import Thing\n\n\ndef use():\n    return Thing()\n";
    const final = `${initial}\n\ndef unrelated():\n    return 1\n`;

    await writeRepo(root, { ...MODEL, "importer.py": initial });
    const first = await indexProject({ repoRoot: root, db: incrementalDb, refreshMode: "full" });

    // Mutate, then refresh incrementally from the previous snapshot.
    await writeFile(path.join(root, "importer.py"), final);
    const incremental = await indexProject({
      repoRoot: root,
      db: incrementalDb,
      previousSnapshot: first.snapshot,
      refreshMode: "incremental",
    });
    const incrementalEdges = readImportEdges(incrementalDb);

    // A clean full build of the SAME final state.
    await indexProject({ repoRoot: root, db: fullDb, refreshMode: "full" });
    const fullEdges = readImportEdges(fullDb);

    assert.deepEqual(incrementalEdges, fullEdges, "incremental refresh diverged from a clean full build");
    assert.deepEqual(incrementalEdges, [{ from: "importer.py::<module>", to: "model.py::Thing" }]);

    // §20: a no-op incremental pass changes nothing.
    await indexProject({
      repoRoot: root,
      db: incrementalDb,
      previousSnapshot: incremental.snapshot,
      refreshMode: "incremental",
    });
    assert.deepEqual(readImportEdges(incrementalDb), incrementalEdges);
  } finally {
    incrementalDb.close();
    fullDb.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("incremental refresh after a RETARGETING edit matches a clean full build", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m140-incr-retarget-"));
  const incrementalDb = openIndexerDatabase();
  const fullDb = openIndexerDatabase();

  try {
    const base: Files = { "a.py": "class Thing:\n    pass\n", "b.py": "class Thing:\n    pass\n" };
    await writeRepo(root, { ...base, "importer.py": "from a import Thing\n\n\ndef use():\n    return Thing\n" });
    const first = await indexProject({ repoRoot: root, db: incrementalDb, refreshMode: "full" });

    await writeFile(path.join(root, "importer.py"), "from b import Thing\n\n\ndef use():\n    return Thing\n");
    await indexProject({
      repoRoot: root,
      db: incrementalDb,
      previousSnapshot: first.snapshot,
      refreshMode: "incremental",
    });
    await indexProject({ repoRoot: root, db: fullDb, refreshMode: "full" });

    const incrementalEdges = readImportEdges(incrementalDb);
    assert.deepEqual(incrementalEdges, readImportEdges(fullDb));
    assert.deepEqual(incrementalEdges, [{ from: "importer.py::<module>", to: "b.py::Thing" }]);
  } finally {
    incrementalDb.close();
    fullDb.close();
    await rm(root, { recursive: true, force: true });
  }
});

// --- §21 determinism ---------------------------------------------------------------

test("repeated full indexes of the same source produce identical import edges", async () => {
  const files: Files = {
    ...MODEL,
    "importer.py": "from model import Thing\n\n\ndef use():\n    return Thing()\n\n\ndef other():\n    return 2\n",
  };
  const first = await importEdgesOf(files);
  const second = await importEdgesOf(files);

  assert.deepEqual(second, first);
  assert.equal(first.length, 1);
});

// --- §89 product-level retrieval metamorphic check -----------------------------------

test("an unrelated edit does not change a retrieval result that depends on the import relation", async () => {
  const { searchSymbolsGraph } = await import("../retrieval/searchSymbolsGraph");
  const base: Files = {
    "calibration.py": "class CalibrationRun:\n    def baseline(self):\n        return 1\n",
  };
  const before = "from calibration import CalibrationRun\n\n\ndef run_calibration():\n    return CalibrationRun()\n";
  const after = `${before}\n\ndef unrelated_helper():\n    return 1\n`;

  const search = async (importer: string): Promise<readonly string[]> => {
    const root = await mkdtemp(path.join(os.tmpdir(), "m140-retr-"));
    const db = openIndexerDatabase();
    try {
      await writeRepo(root, { ...base, "pipeline.py": importer });
      await indexProject({ repoRoot: root, db, refreshMode: "full" });
      return searchSymbolsGraph(db, { query: "calibration", maxResults: 5 })
        .map((result) => result.fqName);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  };

  const resultsBefore = await search(before);
  const resultsAfter = await search(after);

  assert.equal(resultsBefore.includes("calibration.py::CalibrationRun"), true);
  // The unrelated helper is a new symbol and may legitimately appear; what must
  // NOT change is the relative standing of the import-connected symbols.
  assert.deepEqual(
    resultsAfter.filter((fqName) => fqName !== "pipeline.py::unrelated_helper"),
    resultsBefore,
    "an unrelated definition changed an import-dependent retrieval result",
  );
});

// --- module symbols stay out of retrieval --------------------------------------------

test("module scope symbols are never returned as retrieval candidates", async () => {
  const { searchSymbolsGraph } = await import("../retrieval/searchSymbolsGraph");
  const { searchSymbols } = await import("../retrieval/searchSymbols");
  const root = await mkdtemp(path.join(os.tmpdir(), "m140-nocand-"));
  const db = openIndexerDatabase();

  try {
    await writeRepo(root, { ...MODEL, "importer.py": "from model import Thing\n\n\ndef use():\n    return Thing()\n" });
    await indexProject({ repoRoot: root, db, refreshMode: "full" });

    // The module symbol exists in the graph...
    const persisted = db.query(`SELECT COUNT(*) AS n FROM symbols WHERE kind = 'module'`).get() as { n: number };
    assert.equal(persisted.n, 2);

    // ...but no query surfaces it, including path- and name-shaped ones that
    // match its fq_name and file path.
    for (const query of ["module", "importer", "importer.py", "<module>", "Thing", "model"]) {
      for (const fqNames of [
        searchSymbols(db, { query, maxResults: 20 }).map((result) => result.fqName),
        searchSymbolsGraph(db, { query, maxResults: 20 }).map((result) => result.fqName),
      ]) {
        assert.equal(
          fqNames.some((fqName) => fqName.endsWith("::<module>")),
          false,
          `query ${JSON.stringify(query)} surfaced a module scope symbol`,
        );
      }
    }
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

// Long natural-language tasks route through the broad-query candidate path, which
// builds its own SELECT rather than reusing QUERY_SQL. That path once omitted the
// structural-symbol predicate, so `<module>` entered the lexical candidate pool and
// could both be delivered as content and revive an imports_neighborhood
// contribution naming a module. Short queries never reach it, so this is asserted
// separately from the single-token cases above.
test("broad natural-language queries never surface or score module scope symbols", async () => {
  const { searchSymbolsGraph } = await import("../retrieval/searchSymbolsGraph");
  const { searchSymbols } = await import("../retrieval/searchSymbols");
  const { SymbolSearchBackend } = await import("../retrieval/types");
  const root = await mkdtemp(path.join(os.tmpdir(), "m140-broad-"));
  const db = openIndexerDatabase();

  try {
    await writeRepo(root, { ...MODEL, "importer.py": "from model import Thing\n\n\ndef use():\n    return Thing()\n" });
    await indexProject({ repoRoot: root, db, refreshMode: "full" });

    const task = "the importer module should use the model Thing when building a "
      + "thing from the stored importer model configuration and importer settings";

    const plain = searchSymbols(db, { query: task, maxResults: 25 });
    const fts = searchSymbols(db, { query: task, maxResults: 25, backend: SymbolSearchBackend.Fts });
    const graph = searchSymbolsGraph(db, { query: task, maxResults: 25 });

    for (const [label, results] of [["plain", plain], ["fts", fts], ["graph", graph]] as const) {
      assert.equal(
        results.some((result) => result.fqName.endsWith("::<module>")),
        false,
        `${label} backend surfaced a module scope symbol for a broad query`,
      );
    }

    // A module must not reach a candidate set, so no graph contribution may name one.
    const moduleIds = new Set(
      (db.query(`SELECT id FROM symbols WHERE kind = 'module'`).all() as Array<{ id: string }>)
        .map((row) => row.id),
    );
    for (const result of graph) {
      for (const contribution of result.graphContributions) {
        for (const relatedId of contribution.relatedSymbolIds ?? []) {
          assert.equal(
            moduleIds.has(relatedId),
            false,
            `${contribution.signal} on ${result.fqName} scored a module scope symbol`,
          );
        }
      }
    }
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

// --- structural scopes are not dependent symbols -------------------------------

// `computeInDegreeCentrality` feeds the pivot-ordering reason surfaced to the
// model as "N indexed symbol(s) depend on this". Once <module> owned every
// file's imports, an import-only dependency began inflating that count, so a
// widely-imported public symbol outranked the internal function a task actually
// needed. The edges are correct and stay in the graph; they must simply not be
// counted as dependent SYMBOLS.
test("import-only dependents from module scopes do not inflate in-degree centrality", async () => {
  const { computeInDegreeCentrality } = await import("../retrieval/graphExpansion");
  const root = await mkdtemp(path.join(os.tmpdir(), "m140-centrality-"));
  const db = openIndexerDatabase();

  try {
    await writeRepo(root, {
      ...MODEL,
      // Three files import Thing and never use it: a file-level dependency only.
      "a.py": "from model import Thing\n",
      "b.py": "from model import Thing\n",
      "c.py": "from model import Thing\n",
      // One real symbol genuinely depends on Thing by calling it.
      "caller.py": "from model import Thing\n\n\ndef build():\n    return Thing()\n",
    });
    await indexProject({ repoRoot: root, db, refreshMode: "full" });

    const thing = db.query(
      `SELECT id FROM symbols WHERE fq_name = 'model.py::Thing'`,
    ).get() as { id: string } | null;
    assert.ok(thing, "fixture symbol missing");

    // The import edges themselves remain in the graph for other consumers.
    const importEdges = readImportEdges(db)
      .filter((edge) => edge.to === "model.py::Thing");
    assert.equal(importEdges.length, 4, "import edges must be preserved");
    assert.equal(
      importEdges.every((edge) => edge.from.endsWith("::<module>")),
      true,
      "module scope should own the import edges",
    );

    // ...but four module scopes are not four dependent symbols. Only `build`,
    // which calls Thing, is a real dependent.
    const centrality = computeInDegreeCentrality(db, [thing.id]);
    assert.equal(
      centrality.get(thing.id) ?? 0,
      1,
      "structural module scopes were counted as dependent symbols",
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

// Graph expansion is a second, independent way a symbol becomes a candidate: it
// walks edges out of the lexical seeds and materialises the neighbours. Because
// <module> now sits on every import edge, that walk reaches module scopes — and
// without a filter they were delivered as selected content with real token cost.
// The walk must still pass THROUGH them (they are the bridge), so this asserts on
// what is returned, not on what is traversed.
test("graph expansion never materializes a module scope as a candidate", async () => {
  const { expandGraphCandidates } = await import("../retrieval/graphExpansion");
  const root = await mkdtemp(path.join(os.tmpdir(), "m140-expand-"));
  const db = openIndexerDatabase();

  try {
    await writeRepo(root, {
      ...MODEL,
      "importer.py": "from model import Thing\n\n\ndef use():\n    return Thing()\n",
      "sibling.py": "from model import Thing\n\n\ndef other():\n    return 2\n",
    });
    await indexProject({ repoRoot: root, db, refreshMode: "full" });

    const thing = db.query(
      `SELECT id FROM symbols WHERE fq_name = 'model.py::Thing'`,
    ).get() as { id: string } | null;
    assert.ok(thing, "fixture symbol missing");

    const expanded = expandGraphCandidates(db, [thing.id]);
    assert.equal(expanded.length > 0, true, "fixture produced no expansion candidates");
    assert.equal(
      expanded.some((candidate) => candidate.symbol.fqName.endsWith("::<module>")),
      false,
      "graph expansion materialized a module scope as a deliverable candidate",
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

// The hybrid path lane admits every symbol declared in a file the query names as
// a likely edit target. Generated files (PLY tables, migrations) often declare
// little else, so the module scope was admitted and delivered as support. All
// hybrid lanes funnel through one admission point, so the rule is asserted there.
test("the hybrid path lane never admits a module scope from a likely edit file", async () => {
  const { hybridRetrieve } = await import("../retrieval/hybridRetrieval");
  const root = await mkdtemp(path.join(os.tmpdir(), "m140-hybrid-"));
  const db = openIndexerDatabase();

  try {
    // A generated-table-shaped file: module-level data, no defs worth editing.
    await writeRepo(root, {
      ...MODEL,
      "generated_table.py": "from model import Thing\n\nTABLE = {'a': 1}\nOTHER = 2\n",
    });
    await indexProject({ repoRoot: root, db, refreshMode: "full" });

    const shaped = {
      query: "generated table",
      failingTests: [],
      likelyFiles: ["generated_table.py"],
      likelySymbols: [],
      identifiers: [],
      filteredGenericSymbols: [],
      filteredRunnerFiles: [],
    };

    const { candidates } = hybridRetrieve(db, { query: shaped.query, shaped });

    assert.equal(candidates.length > 0, true, "fixture produced no hybrid candidates");
    assert.equal(
      candidates.some((candidate) => candidate.fqName.endsWith("::<module>")),
      false,
      "hybrid path lane admitted a module scope as a candidate",
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

// A capsule-level backstop. The rule "a <module> is never delivered" was broken
// independently by four different producers — the broad lexical query, graph
// expansion, the hybrid path lane, and the co-edit generated-artifact pair — so
// asserting it at each producer cannot be trusted to stay complete. This asserts
// the property where it actually matters: on the built capsule.
test("a built capsule never delivers a module scope as content", async () => {
  const { buildCapsuleV2 } = await import("../capsuleV2/buildCapsuleV2");
  const { CapsuleIntent } = await import("../capsuleV2/types");
  const root = await mkdtemp(path.join(os.tmpdir(), "m140-capsule-"));
  const db = openIndexerDatabase();

  try {
    // Shaped after astropy-14369: a source file with its generated PLY pair,
    // which is what pulled `::<module>` into the delivered support set.
    await writeRepo(root, {
      "units/format/cds.py": "from model import Thing\n\n\nclass CdsFormat:\n    def parse(self, text):\n        return Thing()\n",
      "units/format/cds_lextab.py": "_lextokens = {'UNIT': 1}\n_lexstateinfo = {'INITIAL': 'inclusive'}\n",
      "units/format/cds_parsetab.py": "_tabversion = '3.10'\n_lr_signature = 'abc'\n",
      "model.py": "class Thing:\n    def run(self):\n        return 1\n",
    });
    await indexProject({ repoRoot: root, db, refreshMode: "full" });

    const capsule = buildCapsuleV2({
      db,
      repoRoot: root,
      task: "fix the CDS unit format parser in units/format/cds.py so it parses units correctly",
      intent: CapsuleIntent.Modify,
      maxTokens: 6_000,
    }) as { items?: Array<{ fqName?: string; symbol?: string; path?: string }> };

    const delivered = JSON.stringify(capsule);
    assert.equal(
      delivered.includes("::<module>"),
      false,
      "a module scope reached delivered capsule content",
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
