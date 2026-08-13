// M143 Workstream A — generic title-lane semantics suite.
//
// WHY A SECOND TITLE SUITE
// ------------------------
// `titleSymbolAnchoring.test.ts` covers term EXTRACTION and candidate ENTRY —
// the lane's original contract. This suite covers what M143 is actually about:
// the difference between the two things a title mention can buy.
//
//   ADMISSION  the symbol the title names must reach the candidate pool
//   PROMOTION  that symbol becoming the LEAD edit target
//
// M143 §104 states the invariant the lane must satisfy:
//
//   TITLE MENTION MAY ESTABLISH RELEVANCE
//   TITLE MENTION DOES NOT JUSTIFY A FIXED SYNTHETIC SCORE
//
// Every fixture here is generic — invented package/class names, no repository
// rules and no instance ids. The real cases that motivated the milestone are
// measured separately by the offline audit runner, because a synthetic
// repository cannot reproduce the pool pressure that produces the defect (the
// same limitation M140-B recorded for the rescue lane).

import assert from "node:assert/strict";
import { test } from "bun:test";

import { buildCapsuleV2 } from "./buildCapsuleV2";
import { CapsuleIntent } from "./types";
import { seedCustomFixture } from "./__fixtures__/capsuleV2Fixture";
import { SymbolKind } from "../domain/types";

function everything(result: { pivots: readonly { path: string; symbol: string }[]; support: readonly { path: string; symbol: string }[]; discarded: readonly { path: string; symbol: string }[] }): string[] {
  return [...result.pivots, ...result.support, ...result.discarded].map((i) => `${i.path}::${i.symbol}`);
}

function lead(result: { pivots: readonly { path: string; symbol: string }[] }): string | undefined {
  const first = result.pivots[0];
  return first === undefined ? undefined : `${first.path}::${first.symbol}`;
}

// A repository where one class is named by the title and a second module owns a
// behaviour described in prose. Deliberately symmetrical: both files carry real
// bodies, so neither wins by being the only thing indexed.
function seedTitleVsBehaviour() {
  return seedCustomFixture([
    {
      relPath: "app/models/relations.py",
      specs: [{
        localName: "RelationField",
        kind: SymbolKind.Class,
        signature: "class RelationField",
        body: "class RelationField(BaseField):\n    \"\"\"A relation between two records.\"\"\"\n    def __init__(self, target, on_delete):\n        self.target = target\n        self.on_delete = on_delete\n    def db_type(self, connection):\n        return connection.relation_type()",
      }],
    },
    {
      relPath: "app/schema/planner.py",
      specs: [{
        localName: "build_cross_module_dependency",
        kind: SymbolKind.Function,
        signature: "build_cross_module_dependency(state, field)",
        body: "def build_cross_module_dependency(state, field):\n    # Assemble the cross-module dependency entry for a changed field.\n    dependency = state.dependency_for(field)\n    return state.record_dependency(dependency)",
      }],
    },
  ]);
}

// --- §16 strong explicit-title positive control -------------------------------

test("§16 a title that names the symbol owning the behaviour keeps it admitted and leading", () => {
  const { db, repoRoot } = seedCustomFixture([
    {
      relPath: "api/serializers.py",
      specs: [{
        localName: "UserSerializer",
        kind: SymbolKind.Class,
        signature: "class UserSerializer",
        body: "class UserSerializer(BaseSerializer):\n    def validate(self, payload):\n        # validation of the incoming user payload\n        if not payload.get('email'):\n            raise ValidationFailure('email required')\n        return payload",
      }],
    },
    {
      relPath: "api/routing.py",
      specs: [{
        localName: "dispatch_request",
        kind: SymbolKind.Function,
        signature: "dispatch_request(request)",
        body: "def dispatch_request(request):\n    return router.resolve(request)",
      }],
    },
  ]);
  try {
    const result = buildCapsuleV2({
      db, repoRoot,
      task: "Fix UserSerializer validation — the validate hook accepts an empty email",
      intent: CapsuleIntent.Auto,
      maxTokens: 8_000,
    });
    assert.ok(
      everything(result).includes("api/serializers.py::UserSerializer"),
      `explicitly titled owner must be admitted: ${everything(result).join(", ")}`,
    );
    assert.equal(lead(result), "api/serializers.py::UserSerializer");
  } finally {
    db.close();
  }
});

// --- §18 title-only lookup control --------------------------------------------

test("§18 a title symbol with little other evidence is still admitted (recall floor)", () => {
  const { db, repoRoot } = seedCustomFixture([
    {
      relPath: "engine/printers.py",
      specs: [{
        localName: "TabularPrinter",
        kind: SymbolKind.Class,
        signature: "class TabularPrinter",
        body: "class TabularPrinter(BasePrinter):\n    def emit(self, rows):\n        return '\\n'.join(str(r) for r in rows)",
      }],
    },
    {
      relPath: "engine/compile.py",
      specs: [{
        localName: "compile_expression",
        kind: SymbolKind.Function,
        signature: "compile_expression(expr)",
        body: "def compile_expression(expr):\n    # I use compile_expression to generate helpers and save the generated code\n    return generate(expr)",
      }],
    },
  ]);
  try {
    const result = buildCapsuleV2({
      db, repoRoot,
      // The body word (`compile_expression`) dominates the prose; without the
      // title lane the titled class never reaches the pool at all. This is the
      // recall the lane exists for, and M143 must not trade it away.
      task: "TabularPrinter does not support nested rows — I use compile_expression to generate helpers and save the generated code for further use",
      intent: CapsuleIntent.Auto,
      maxTokens: 8_000,
    });
    assert.ok(
      everything(result).includes("engine/printers.py::TabularPrinter"),
      `title-only symbol must survive: ${everything(result).join(", ")}`,
    );
  } finally {
    db.close();
  }
});

// --- §20 project-name title control -------------------------------------------

test("§20 a repository/project name in the title is not reinterpreted as a class", () => {
  const { db, repoRoot } = seedCustomFixture([
    {
      relPath: "acme/core.py",
      specs: [{
        localName: "Acme",
        kind: SymbolKind.Class,
        signature: "class Acme",
        body: "class Acme:\n    \"\"\"Top-level application object.\"\"\"\n    def run(self):\n        return self.loop.run()",
      }],
    },
    {
      relPath: "acme/cache/store.py",
      specs: [{
        localName: "evict_stale_entries",
        kind: SymbolKind.Function,
        signature: "evict_stale_entries(cache)",
        body: "def evict_stale_entries(cache):\n    # drop entries whose deadline has passed\n    for key, deadline in cache.deadlines.items():\n        if deadline.expired():\n            cache.drop(key)",
      }],
    },
  ]);
  try {
    const result = buildCapsuleV2({
      db, repoRoot,
      task: "how does Acme evict stale cache entries?",
      intent: CapsuleIntent.Auto,
      maxTokens: 8_000,
    });
    // A bare Capitalized project reference is not symbol-shaped, so the title
    // lane must not resolve it and hand the application object the lead.
    assert.notEqual(lead(result), "acme/core.py::Acme");
  } finally {
    db.close();
  }
});

// --- §21 common-English title collision ---------------------------------------

test("§21 an ordinary English word in the title stays prose even when a symbol shares its name", () => {
  const { db, repoRoot } = seedCustomFixture([
    {
      relPath: "shell/lookup.py",
      specs: [{
        localName: "which",
        kind: SymbolKind.Function,
        signature: "which(name)",
        body: "def which(name):\n    # resolve an executable on PATH\n    return shutil.which(name)",
      }],
    },
    {
      relPath: "shell/selector.py",
      specs: [{
        localName: "select_backend_command",
        kind: SymbolKind.Function,
        signature: "select_backend_command(config)",
        body: "def select_backend_command(config):\n    # decide which backend command is selected for this run\n    return config.backends[config.preferred]",
      }],
    },
  ]);
  try {
    const result = buildCapsuleV2({
      db, repoRoot,
      task: "Fix which backend command is selected",
      intent: CapsuleIntent.Auto,
      maxTokens: 8_000,
    });
    assert.notEqual(lead(result), "shell/lookup.py::which");
  } finally {
    db.close();
  }
});

// --- §11 title evidence is typed by SHAPE, not by capitalisation ---------------

test("§11 ordinary Capitalized prose in a title produces no title candidate", () => {
  const { db, repoRoot } = seedCustomFixture([
    {
      relPath: "docs/render.py",
      specs: [{
        localName: "Decorated",
        kind: SymbolKind.Class,
        signature: "class Decorated",
        body: "class Decorated:\n    def apply(self, fn):\n        return fn",
      }],
    },
    {
      relPath: "docs/builder.py",
      specs: [{
        localName: "build_documentation",
        kind: SymbolKind.Function,
        signature: "build_documentation(tree)",
        body: "def build_documentation(tree):\n    # render the documentation for every module in the tree\n    return [render(node) for node in tree]",
      }],
    },
  ]);
  try {
    const result = buildCapsuleV2({
      db, repoRoot,
      task: "Decorated init does not show up in documentation",
      intent: CapsuleIntent.Auto,
      maxTokens: 8_000,
    });
    assert.notEqual(lead(result), "docs/render.py::Decorated");
  } finally {
    db.close();
  }
});

// --- §19 ambiguous same-name title control ------------------------------------

test("§19 a title name shared by two modules does not silently elect one of them", () => {
  const { db, repoRoot } = seedCustomFixture([
    {
      relPath: "backends/postgres/adapter.py",
      specs: [{
        localName: "ConnectionAdapter",
        kind: SymbolKind.Class,
        signature: "class ConnectionAdapter",
        body: "class ConnectionAdapter(BaseAdapter):\n    def open(self, dsn):\n        return connect(dsn)",
      }],
    },
    {
      relPath: "backends/mysql/adapter.py",
      specs: [{
        localName: "ConnectionAdapter",
        kind: SymbolKind.Class,
        signature: "class ConnectionAdapter",
        body: "class ConnectionAdapter(BaseAdapter):\n    def open(self, dsn):\n        return connect(dsn)",
      }],
    },
  ]);
  try {
    const result = buildCapsuleV2({
      db, repoRoot,
      task: "ConnectionAdapter leaks a socket when open fails",
      intent: CapsuleIntent.Auto,
      maxTokens: 8_000,
    });
    const all = everything(result);
    // Neither module is distinguishable from the title alone, so BOTH must stay
    // visible. Electing one would be inventing a certainty the evidence lacks.
    assert.ok(all.includes("backends/postgres/adapter.py::ConnectionAdapter"), all.join(", "));
    assert.ok(all.includes("backends/mysql/adapter.py::ConnectionAdapter"), all.join(", "));
  } finally {
    db.close();
  }
});

// --- §17 / §22 the measured ceiling -------------------------------------------
//
// This is the django-11740 shape, generically: the title names a type that is
// merely INVOLVED in the scenario, while a differently-named function in another
// module owns the behaviour the request actually describes.
//
// M143 measured seven candidate discriminators for this shape (five new, two
// re-measured from M142) and none separates it from the cases where the titled
// type IS the edit site — see `stage5_m143_title_lane_audit.md`. The lane
// therefore still promotes the titled type, and this test RECORDS that rather
// than asserting the behaviour is correct.
//
// It is written as a characterization test on purpose: when a future milestone
// finds a discriminator, this test fails and must be rewritten to the corrected
// expectation. A test asserting the desired-but-unreached behaviour would have
// to be skipped, and a skipped test records nothing.
test("§17 CEILING: a title-named type still leads over the module owning the behaviour", () => {
  const { db, repoRoot } = seedTitleVsBehaviour();
  try {
    const result = buildCapsuleV2({
      db, repoRoot,
      task: "changing a value field to a RelationField does not create a cross-module dependency in the planner",
      intent: CapsuleIntent.Auto,
      maxTokens: 8_000,
    });
    const all = everything(result);
    // Admission is the part M143 does guarantee, for BOTH sides.
    assert.ok(all.includes("app/models/relations.py::RelationField"), all.join(", "));
    assert.ok(all.includes("app/schema/planner.py::build_cross_module_dependency"), all.join(", "));
    // Promotion is the part that remains a measured ceiling.
    assert.equal(
      lead(result),
      "app/models/relations.py::RelationField",
      "if this now leads with the behaviour owner, the M143-A ceiling has been broken — update this test and the audit",
    );
  } finally {
    db.close();
  }
});
