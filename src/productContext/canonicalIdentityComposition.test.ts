import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { createTestProductStores } from "../testing/productStores";
import { indexProject } from "../indexer/indexProject";
import { assembleProductContext } from "./assembleProductContext";
import { getImpactGraph } from "../impact/getImpactGraph";

/**
 * M162 canonical-identity composition contract.
 *
 * The callable architecture rests on one composition: the agent orients with
 * `get_code_context`, then asks `get_impact_graph` about something it found.
 * That only works if the identity the first tool SHOWS is the identity the
 * second tool ACCEPTS.
 *
 * Before M162 it was not. `items[].fqName` was absent from the response,
 * `leadPivot` carried a doubly path-prefixed string that resolved nowhere, and
 * rendered headers used `path::localName` — which looks like a valid FQN and
 * silently is not for any nested symbol. Module-level functions and classes
 * masked the bug, because for them the local name equals the qualified name.
 *
 * These tests therefore cover all three symbol shapes, and the method case is
 * the load-bearing one: it is the only shape that proves a local name alone is
 * insufficient. The negative cases pin the two malformed strings the product
 * used to emit, so a regression reintroducing either one fails here.
 */

const FIXTURE_FILES: ReadonlyArray<{ readonly path: string; readonly content: string }> = [
  { path: "pkg/__init__.py", content: "" },
  {
    path: "pkg/core.py",
    content: [
      '"""Core order pricing."""',
      "",
      "",
      "class PriceEngine:",
      '    """Computes order totals."""',
      "",
      "    def __init__(self, rate):",
      "        self.rate = rate",
      "",
      "    def apply_discount(self, amount, tier):",
      '        """Apply a tier discount to amount."""',
      '        if tier == "gold":',
      "            return amount * 0.8",
      "        return amount",
      "",
      "    def total(self, amount, tier):",
      "        discounted = self.apply_discount(amount, tier)",
      "        return discounted * (1 + self.rate)",
      "",
    ].join("\n"),
  },
  {
    path: "pkg/api.py",
    content: [
      "from pkg.core import PriceEngine",
      "",
      "",
      "def checkout(amount, tier, rate=0.2):",
      "    engine = PriceEngine(rate)",
      "    return engine.total(amount, tier)",
      "",
    ].join("\n"),
  },
];

async function withFixture(
  run: (context: {
    db: ReturnType<typeof openIndexerDatabase>;
    stores: ReturnType<typeof createTestProductStores>;
    repoRoot: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-m162-identity-"));
  const repoRoot = path.join(root, "repo");
  const db = openIndexerDatabase();
  const stores = createTestProductStores(db);

  try {
    for (const file of FIXTURE_FILES) {
      const target = path.join(repoRoot, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
    await indexProject({ repoRoot, db });
    await run({ db, stores, repoRoot });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

const TASK = "gold tier discount is wrong when computing the order total";

/**
 * The fixture index is built in-process and is fresh by construction; the
 * freshness inspector reads repo-local state this harness never writes, so it
 * would otherwise fail closed and assemble nothing.
 */
const FRESH_FIXTURE = { status: "fresh", reason: "fixture_index", action: "none" } as const;

test("M162: every canonical fqName get_code_context returns resolves in get_impact_graph", async () => {
  await withFixture(async ({ db, stores, repoRoot }) => {
    const context = await assembleProductContext({
      stores,
      repoRoot,
      task: TASK,
      intent: "debug",
      budgetTokens: 8_000,
      freshnessOverride: FRESH_FIXTURE,
    });

    const identified = context.items.filter(
      (item) => typeof item.fqName === "string" && item.fqName.length > 0,
    );
    assert.ok(identified.length > 0, "expected at least one item to carry a canonical identity");

    for (const item of identified) {
      const result = getImpactGraph(db, { symbolFqn: item.fqName!, depth: 2, format: "list" });
      assert.ok(
        result.ok,
        `canonical identity ${item.fqName} did not resolve: `
        + `${result.ok ? "" : `${result.error.code}: ${result.error.message}`}`,
      );
    }
  });
});

test("M162: the method case proves a local name alone is insufficient", async () => {
  await withFixture(async ({ db, stores, repoRoot }) => {
    const context = await assembleProductContext({
      stores,
      repoRoot,
      task: TASK,
      intent: "debug",
      budgetTokens: 8_000,
      freshnessOverride: FRESH_FIXTURE,
    });

    const method = context.items.find(
      (item) => item.fqName === "pkg/core.py::PriceEngine.apply_discount",
    );
    assert.ok(method !== undefined, "expected the method pivot to be delivered with canonical identity");

    // The canonical identity resolves...
    assert.ok(getImpactGraph(db, { symbolFqn: method.fqName!, depth: 2, format: "list" }).ok);

    // ...while the bare local name the item also exposes does NOT. If this ever
    // starts passing, `symbol` has become resolvable and the distinction this
    // contract defends has quietly disappeared.
    assert.equal(method.symbol, "apply_discount");
    const localOnly = getImpactGraph(db, {
      symbolFqn: `pkg/core.py::${method.symbol}`,
      depth: 2,
      format: "list",
    });
    assert.equal(localOnly.ok, false, "local-name-only lookup must not resolve for a method");
  });
});

test("M162: module-level function, class, and method identities all resolve", async () => {
  await withFixture(async ({ db }) => {
    for (const fqName of [
      "pkg/api.py::checkout", // module-level function
      "pkg/core.py::PriceEngine", // class
      "pkg/core.py::PriceEngine.apply_discount", // method
    ]) {
      const result = getImpactGraph(db, { symbolFqn: fqName, depth: 2, format: "list" });
      assert.ok(result.ok, `expected ${fqName} to resolve`);
    }
  });
});

test("M162: the malformed doubly path-prefixed identity does not resolve", async () => {
  await withFixture(async ({ db }) => {
    // Exactly what `leadPivot` used to emit.
    const doubled = getImpactGraph(db, {
      symbolFqn: "pkg/core.py::pkg/core.py::PriceEngine.apply_discount",
      depth: 2,
      format: "list",
    });
    assert.equal(doubled.ok, false, "doubly path-prefixed identity must not resolve");
  });
});

test("M162: leadPivot is a canonical identity, not a path-prefixed one", async () => {
  await withFixture(async ({ db, stores, repoRoot }) => {
    const context = await assembleProductContext({
      stores,
      repoRoot,
      task: TASK,
      intent: "debug",
      budgetTokens: 8_000,
      freshnessOverride: FRESH_FIXTURE,
    });

    const leadPivot = context.leadPivot;
    assert.ok(typeof leadPivot === "string" && leadPivot.length > 0, "expected a lead pivot");
    assert.ok(
      !/^(.+?::).*\1/.test(leadPivot),
      `leadPivot repeated its path prefix: ${leadPivot}`,
    );
    assert.ok(
      getImpactGraph(db, { symbolFqn: leadPivot, depth: 2, format: "list" }).ok,
      `leadPivot ${leadPivot} is not a resolvable identity`,
    );
  });
});

test("M162: rendered headers show identities the agent can pass straight back", async () => {
  await withFixture(async ({ db, stores, repoRoot }) => {
    const context = await assembleProductContext({
      stores,
      repoRoot,
      task: TASK,
      intent: "debug",
      budgetTokens: 8_000,
      freshnessOverride: FRESH_FIXTURE,
    });

    const headers = context.modelVisibleContext
      .split("\n")
      .filter((line) => line.startsWith("## ["))
      .map((line) => line.replace(/^## \[[^\]]+\]\s*/, ""));
    assert.ok(headers.length > 0, "expected rendered item headers");

    // Every header that names a code symbol must be resolvable. Headers for
    // non-symbol items (documents, rules, memory) carry a bare path and are
    // skipped rather than forced to invent an identity.
    const symbolHeaders = headers.filter((header) => header.includes("::"));
    assert.ok(symbolHeaders.length > 0, "expected at least one symbol header");
    for (const header of symbolHeaders) {
      assert.ok(
        getImpactGraph(db, { symbolFqn: header, depth: 2, format: "list" }).ok,
        `rendered header ${header} is not a resolvable identity`,
      );
    }
  });
});

test("M162: <module> symbols stay delivery-invisible", async () => {
  await withFixture(async ({ stores, repoRoot }) => {
    const context = await assembleProductContext({
      stores,
      repoRoot,
      task: TASK,
      intent: "debug",
      budgetTokens: 8_000,
      freshnessOverride: FRESH_FIXTURE,
    });

    // Structural module symbols remain graph-visible but must never be
    // delivered as answer-bearing code evidence.
    const moduleDeliveries = context.items.filter(
      (item) => (item.fqName ?? "").endsWith("::<module>") || item.symbol === "<module>",
    );
    assert.equal(moduleDeliveries.length, 0, "expected zero <module> deliveries");
    assert.ok(!context.modelVisibleContext.includes("::<module>"));
  });
});
