import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { getImpactGraph, type GetImpactGraphInput, type ImpactGraphOutput } from "./getImpactGraph";

test("exact symbol FQN resolves correctly from indexed structural state", async () => {
  await withImpactFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/base.ts::base",
        depth: 2,
        format: "list",
      });

      assert.equal(result.requested.symbolFqn, "src/base.ts::base");
      assert.equal(result.resolvedSymbol.localName, "base");
      assert.equal(result.resolvedSymbol.kind, "function");
      assert.equal(result.nodes[0]?.distance, 0);
    } finally {
      db.close();
    }
  });
});

test("unknown exact symbol FQN fails clearly", async () => {
  await withImpactFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = getImpactGraph(db, {
        symbolFqn: "src/base.ts::missing",
        depth: 2,
        format: "list",
      });

      assert.equal(result.ok, false);

      if (result.ok) {
        throw new Error("Expected unknown symbol failure.");
      }

      assert.equal(result.error.code, "unknown_symbol");
      assert.equal(result.error.message, "Unknown indexed symbol FQN: src/base.ts::missing");
      assert.deepEqual(result.error.details, {
        symbolFqn: "src/base.ts::missing",
        resolutionMode: "exact_fqn",
      });
    } finally {
      db.close();
    }
  });
});

test("bounded depth traversal remains explicit and deterministic", async () => {
  await withImpactFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const depthOne = requireImpactGraph(db, {
        symbolFqn: "src/base.ts::base",
        depth: 1,
        format: "list",
      });
      const depthTwo = requireImpactGraph(db, {
        symbolFqn: "src/base.ts::base",
        depth: 2,
        format: "list",
      });

      assert.equal(depthOne.summary.maxDepth, 1);
      assert.equal(depthOne.summary.dependentSymbolCount, 2);
      assert.deepEqual(
        depthOne.nodes.map((node) => [node.distance, node.fqName]),
        [
          [0, "src/base.ts::base"],
          [1, "src/alpha.ts::alpha"],
          [1, "src/zeta.ts::zeta"],
        ],
      );

      assert.equal(depthTwo.summary.maxDepth, 2);
      assert.equal(depthTwo.summary.dependentSymbolCount, 3);
      assert.deepEqual(
        depthTwo.nodes.map((node) => [node.distance, node.fqName]),
        [
          [0, "src/base.ts::base"],
          [1, "src/alpha.ts::alpha"],
          [1, "src/zeta.ts::zeta"],
          [2, "src/beta.ts::beta"],
        ],
      );
    } finally {
      db.close();
    }
  });
});

test("list output ordering is stable across repeated calls", async () => {
  await withImpactFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const first = requireImpactGraph(db, {
        symbolFqn: "src/base.ts::base",
        depth: 2,
        format: "list",
      });
      const second = requireImpactGraph(db, {
        symbolFqn: "src/base.ts::base",
        depth: 2,
        format: "list",
      });

      assert.deepEqual(second, first);
      assert.deepEqual(first.view.lines, [
        "d0 src/base.ts::base (function)",
        "d1 src/alpha.ts::alpha (function) calls src/base.ts::base",
        "d1 src/zeta.ts::zeta (function) calls src/base.ts::base",
        "d2 src/beta.ts::beta (function) calls src/alpha.ts::alpha",
      ]);
    } finally {
      db.close();
    }
  });
});

test("tree and mermaid formats are rendered from the same bounded structural graph", async () => {
  await withImpactFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const tree = requireImpactGraph(db, {
        symbolFqn: "src/base.ts::base",
        depth: 2,
        format: "tree",
      });
      const mermaid = requireImpactGraph(db, {
        symbolFqn: "src/base.ts::base",
        depth: 2,
        format: "mermaid",
      });

      assert.deepEqual(tree.view.lines, [
        "d0 src/base.ts::base (function)",
        "  d1 src/alpha.ts::alpha (function) calls src/base.ts::base",
        "    d2 src/beta.ts::beta (function) calls src/alpha.ts::alpha",
        "  d1 src/zeta.ts::zeta (function) calls src/base.ts::base",
      ]);
      assert.equal(mermaid.view.lines[0], "flowchart TD");
      assert.equal(
        mermaid.view.lines.some((line) => line.includes("-->|calls|")),
        true,
      );
    } finally {
      db.close();
    }
  });
});

test("limited coverage stays honest when no indexed reverse dependents exist", async () => {
  await withImpactFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/beta.ts::beta",
        depth: 3,
        format: "list",
      });

      assert.equal(result.summary.dependentSymbolCount, 0);
      assert.deepEqual(result.dependentFiles, []);
      assert.deepEqual(result.view.lines, [
        "d0 src/beta.ts::beta (function)",
      ]);
      assert.equal(
        result.coverage.notes.includes(
          "Structural-only reverse impact view built from indexed contains, imports, calls, and references edges.",
        ),
        true,
      );
      assert.equal(
        result.coverage.notes.includes(
          "This does not represent runtime execution flow, semantic reachability, dataflow, or dynamic dispatch truth.",
        ),
        true,
      );
      assert.equal(
        result.coverage.notes.includes("No indexed reverse dependents were found within depth 3."),
        true,
      );
      assert.equal(
        result.coverage.notes.includes(
          "No caller/reference evidence was observed for this symbol; result relies on contains/imports edges only.",
        ),
        true,
      );
      assert.deepEqual(
        [...result.coverage.supportedEdgeTypes].sort(),
        ["calls", "contains", "imports", "references"],
      );
    } finally {
      db.close();
    }
  });
});

test("Python caller edges surface callers through get_impact_graph for a called function", async () => {
  await withPythonCallerFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/pkg/target.py::do_work",
        depth: 2,
        format: "list",
      });

      const dependentFqNames = result.nodes
        .filter((node) => node.distance > 0)
        .map((node) => node.fqName)
        .sort();

      assert.ok(
        dependentFqNames.includes("src/pkg/user.py::entry"),
        `expected user.py::entry in dependents, got ${JSON.stringify(dependentFqNames)}`,
      );
      assert.ok(
        result.coverage.observedEdgeTypes.includes("calls"),
        `expected calls in observedEdgeTypes, got ${JSON.stringify(result.coverage.observedEdgeTypes)}`,
      );
    } finally {
      db.close();
    }
  });
});

test("TypeScript caller edges surface callers through get_impact_graph for a called function", async () => {
  await withImpactFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/base.ts::base",
        depth: 1,
        format: "list",
      });

      const directCallers = result.nodes
        .filter((node) => node.distance === 1)
        .map((node) => node.fqName)
        .sort();

      assert.deepEqual(directCallers, ["src/alpha.ts::alpha", "src/zeta.ts::zeta"]);
      assert.ok(
        result.coverage.observedEdgeTypes.includes("calls"),
        `expected calls in observedEdgeTypes, got ${JSON.stringify(result.coverage.observedEdgeTypes)}`,
      );
    } finally {
      db.close();
    }
  });
});

test("Cython caller edges surface callers through get_impact_graph for a called function", async () => {
  await withCythonCallerFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/kernel.pyx::compute",
        depth: 1,
        format: "list",
      });

      const directCallers = result.nodes
        .filter((node) => node.distance === 1)
        .map((node) => node.fqName)
        .sort();

      assert.deepEqual(directCallers, [
        "src/kernel.pyx::Engine.run",
        "src/kernel.pyx::entry",
      ]);
      assert.ok(
        result.coverage.observedEdgeTypes.includes("calls"),
        `expected calls in observedEdgeTypes, got ${JSON.stringify(result.coverage.observedEdgeTypes)}`,
      );
    } finally {
      db.close();
    }
  });
});

test("Impact Graph coverage reports supported edge types and honest conservatism notes", async () => {
  await withPythonCallerFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/pkg/target.py::do_work",
        depth: 2,
        format: "list",
      });

      assert.deepEqual(
        [...result.coverage.supportedEdgeTypes].sort(),
        ["calls", "contains", "imports", "references"],
      );
      assert.ok(
        result.coverage.notes.includes(
          "Structural-only reverse impact view built from indexed contains, imports, calls, and references edges.",
        ),
      );
      assert.ok(
        result.coverage.notes.includes(
          "Caller/reference edges are statically extracted for Python, TypeScript, and Cython in this milestone; other languages contribute contains/imports evidence only.",
        ),
      );
      assert.ok(
        result.coverage.notes.includes(
          "Non-call references cover conservative Python cases: inheritance bases, decorators, type annotations, exception classes in raise/except, alias assignments, and other exact imported-name or module-qualified uses. Ambiguous or dynamic references are skipped.",
        ),
      );
      assert.ok(
        result.coverage.notes.includes(
          "This does not represent runtime execution flow, semantic reachability, dataflow, or dynamic dispatch truth.",
        ),
      );
    } finally {
      db.close();
    }
  });
});

test("contains/imports-only fixtures surface the explicit no-caller-evidence note", async () => {
  await withImpactFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/session.ts::SessionManager.createSession",
        depth: 2,
        format: "list",
      });

      assert.equal(result.coverage.observedEdgeTypes.includes("calls"), false);
      assert.equal(result.coverage.observedEdgeTypes.includes("references"), false);
      assert.ok(
        result.coverage.notes.includes(
          "No caller/reference evidence was observed for this symbol; result relies on contains/imports edges only.",
        ),
      );
      // A method whose only reverse dependent is its containing class still
      // surfaces contains-only evidence after TypeScript call/reference edges
      // were added.
      assert.deepEqual(
        result.nodes.map((node) => [node.distance, node.fqName]),
        [
          [0, "src/session.ts::SessionManager.createSession"],
          [1, "src/session.ts::SessionManager"],
        ],
      );
    } finally {
      db.close();
    }
  });
});

test("module-level constants surface dependents through get_impact_graph", async () => {
  await withPythonModuleConstantFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/pkg/settings.py::DEFAULT_BACKEND",
        depth: 2,
        format: "list",
      });

      assert.equal(result.resolvedSymbol.kind, "module_constant");

      const dependentFqNames = result.nodes
        .filter((node) => node.distance > 0)
        .map((node) => node.fqName)
        .sort();

      assert.ok(
        dependentFqNames.includes("src/pkg/user.py::current_backend"),
        `expected user.py::current_backend in dependents, got ${JSON.stringify(dependentFqNames)}`,
      );
      assert.ok(
        result.coverage.observedEdgeTypes.includes("references"),
        `expected references in observedEdgeTypes, got ${JSON.stringify(result.coverage.observedEdgeTypes)}`,
      );
    } finally {
      db.close();
    }
  });
});

async function withPythonModuleConstantFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-impact-pyconst-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(path.join(repoRoot, "src", "pkg"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "pkg", "__init__.py"), "");
    await writeFile(
      path.join(repoRoot, "src", "pkg", "settings.py"),
      "DEFAULT_BACKEND = 'orca'\n",
    );
    await writeFile(
      path.join(repoRoot, "src", "pkg", "user.py"),
      [
        "from .settings import DEFAULT_BACKEND",
        "",
        "def current_backend():",
        "    return DEFAULT_BACKEND",
        "",
      ].join("\n"),
    );
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Python reference edges surface non-call dependents through get_impact_graph", async () => {
  await withPythonReferenceFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/pkg/base.py::Base",
        depth: 2,
        format: "list",
      });

      const dependentFqNames = result.nodes
        .filter((node) => node.distance > 0)
        .map((node) => node.fqName)
        .sort();

      assert.ok(
        dependentFqNames.includes("src/pkg/sub.py::Sub"),
        `expected sub.py::Sub in dependents, got ${JSON.stringify(dependentFqNames)}`,
      );
      assert.ok(
        result.coverage.observedEdgeTypes.includes("references"),
        `expected references in observedEdgeTypes, got ${JSON.stringify(result.coverage.observedEdgeTypes)}`,
      );
    } finally {
      db.close();
    }
  });
});

test("member-level dependents surface through get_impact_graph for same-class self calls", async () => {
  await withPythonSelfCallFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/pkg/service.py::Service.format_message",
        depth: 2,
        format: "list",
      });

      const dependentFqNames = result.nodes
        .filter((node) => node.distance > 0)
        .map((node) => node.fqName);

      assert.ok(
        dependentFqNames.includes("src/pkg/service.py::Service.greet"),
        `expected Service.greet in dependents via self.method(), got ${JSON.stringify(dependentFqNames)}`,
      );
      assert.ok(
        result.coverage.observedEdgeTypes.includes("calls"),
        "expected calls edge from Service.greet via self.format_message()",
      );
      assert.ok(
        result.coverage.notes.some((note) => note.includes("Member/attribute resolution contributed evidence")),
        `expected member/attribute evidence note, got ${JSON.stringify(result.coverage.notes)}`,
      );
    } finally {
      db.close();
    }
  });
});

test("class-level attributes surface dependents through get_impact_graph via ClassName.x", async () => {
  await withPythonClassAttrFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/pkg/config.py::Config.TIMEOUT",
        depth: 2,
        format: "list",
      });

      assert.equal(result.resolvedSymbol.localName, "TIMEOUT");
      assert.equal(result.resolvedSymbol.kind, "module_constant");

      const dependentFqNames = result.nodes
        .filter((node) => node.distance > 0)
        .map((node) => node.fqName);

      assert.ok(
        dependentFqNames.includes("src/pkg/consumer.py::read_timeout"),
        `expected read_timeout in dependents via Config.TIMEOUT reference, got ${JSON.stringify(dependentFqNames)}`,
      );
      assert.ok(
        result.coverage.observedEdgeTypes.includes("references"),
        "expected references edge from consumer to Config.TIMEOUT",
      );
      assert.ok(
        result.coverage.notes.some((note) => note.includes("Member/attribute resolution contributed evidence")),
        "expected member/attribute evidence note",
      );
    } finally {
      db.close();
    }
  });
});

test("coverage notes describe supported inherited-member and super() resolution forms", async () => {
  await withImpactFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/base.ts::base",
        depth: 1,
        format: "list",
      });

      assert.ok(
        result.coverage.notes.some((note) =>
          note.includes("Inherited-member and super() resolution")
          && note.includes("super().x")
          && note.includes("direct base-class member")
        ),
        `expected inherited/super coverage note, got ${JSON.stringify(result.coverage.notes)}`,
      );
    } finally {
      db.close();
    }
  });
});

test("inherited base-class method surfaces subclass dependents through get_impact_graph", async () => {
  await withPythonInheritedMethodFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/pkg/base.py::Base.handle",
        depth: 2,
        format: "list",
      });

      const dependentFqNames = result.nodes
        .filter((node) => node.distance > 0)
        .map((node) => node.fqName);

      assert.ok(
        dependentFqNames.includes("src/pkg/sub.py::Sub.handle"),
        `expected Sub.handle in dependents via super().handle(), got ${JSON.stringify(dependentFqNames)}`,
      );
      assert.ok(
        result.coverage.observedEdgeTypes.includes("calls"),
        "expected calls edge from Sub.handle via super().handle()",
      );
      assert.ok(
        result.coverage.notes.some((note) =>
          note.includes("Inherited-member or cross-class-qualified evidence contributed")
        ),
        `expected inherited-evidence conditional note, got ${JSON.stringify(result.coverage.notes)}`,
      );
    } finally {
      db.close();
    }
  });
});

test("inherited class constant surfaces subclass dependents via ClassName.CONST fallback", async () => {
  await withPythonInheritedConstFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/pkg/base.py::Base.DEFAULT",
        depth: 2,
        format: "list",
      });

      const dependentFqNames = result.nodes
        .filter((node) => node.distance > 0)
        .map((node) => node.fqName);

      assert.ok(
        dependentFqNames.includes("src/pkg/consumer.py::read_default"),
        `expected read_default in dependents via Sub.DEFAULT fallback, got ${JSON.stringify(dependentFqNames)}`,
      );
      assert.ok(
        result.coverage.observedEdgeTypes.includes("references"),
        "expected references edge from read_default via Sub.DEFAULT fallback",
      );
    } finally {
      db.close();
    }
  });
});

async function withPythonInheritedMethodFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-impact-pyinh-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(path.join(repoRoot, "src", "pkg"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "pkg", "__init__.py"), "");
    await writeFile(
      path.join(repoRoot, "src", "pkg", "base.py"),
      [
        "class Base:",
        "    def handle(self):",
        "        return 'base'",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(repoRoot, "src", "pkg", "sub.py"),
      [
        "from .base import Base",
        "",
        "class Sub(Base):",
        "    def handle(self):",
        "        return super().handle()",
        "",
      ].join("\n"),
    );
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withPythonInheritedConstFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-impact-pyinhconst-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(path.join(repoRoot, "src", "pkg"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "pkg", "__init__.py"), "");
    await writeFile(
      path.join(repoRoot, "src", "pkg", "base.py"),
      [
        "class Base:",
        "    DEFAULT = 'orca'",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(repoRoot, "src", "pkg", "sub.py"),
      [
        "from .base import Base",
        "",
        "class Sub(Base):",
        "    pass",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(repoRoot, "src", "pkg", "consumer.py"),
      [
        "from .sub import Sub",
        "",
        "def read_default():",
        "    return Sub.DEFAULT",
        "",
      ].join("\n"),
    );
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("coverage notes always describe supported member/attribute receiver forms", async () => {
  await withImpactFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/base.ts::base",
        depth: 1,
        format: "list",
      });

      assert.ok(
        result.coverage.notes.some((note) =>
          note.includes("self.x") && note.includes("cls.x") && note.includes("ClassName.x")
        ),
        `expected coverage notes to describe supported receiver forms, got ${JSON.stringify(result.coverage.notes)}`,
      );
    } finally {
      db.close();
    }
  });
});

async function withPythonSelfCallFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-impact-pyself-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(path.join(repoRoot, "src", "pkg"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "pkg", "__init__.py"), "");
    await writeFile(
      path.join(repoRoot, "src", "pkg", "service.py"),
      [
        "class Service:",
        "    def greet(self):",
        "        return self.format_message()",
        "",
        "    def format_message(self):",
        "        return 'hello'",
        "",
      ].join("\n"),
    );
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withPythonClassAttrFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-impact-pyclassattr-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(path.join(repoRoot, "src", "pkg"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "pkg", "__init__.py"), "");
    await writeFile(
      path.join(repoRoot, "src", "pkg", "config.py"),
      [
        "class Config:",
        "    TIMEOUT = 30",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(repoRoot, "src", "pkg", "consumer.py"),
      [
        "from .config import Config",
        "",
        "def read_timeout():",
        "    return Config.TIMEOUT",
        "",
      ].join("\n"),
    );
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withPythonReferenceFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-impact-pyref-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(path.join(repoRoot, "src", "pkg"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "pkg", "__init__.py"), "");
    await writeFile(
      path.join(repoRoot, "src", "pkg", "base.py"),
      "class Base:\n    pass\n",
    );
    await writeFile(
      path.join(repoRoot, "src", "pkg", "sub.py"),
      [
        "from .base import Base",
        "",
        "class Sub(Base):",
        "    pass",
        "",
      ].join("\n"),
    );
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withPythonCallerFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-impact-py-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(path.join(repoRoot, "src", "pkg"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "pkg", "__init__.py"), "");
    await writeFile(
      path.join(repoRoot, "src", "pkg", "target.py"),
      "def do_work(x):\n    return x\n",
    );
    await writeFile(
      path.join(repoRoot, "src", "pkg", "user.py"),
      [
        "from .target import do_work",
        "",
        "def entry():",
        "    return do_work(1)",
        "",
      ].join("\n"),
    );
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withCythonCallerFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-impact-cy-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "src", "kernel.pyx"),
      [
        "cpdef int compute(int v):",
        "    return v + 1",
        "",
        "cdef class Engine:",
        "    cpdef int run(self, int v):",
        "        return compute(v)",
        "",
        "def entry(int n):",
        "    return compute(n)",
        "",
      ].join("\n"),
    );
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withImpactFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-impact-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeImpactFixtureRepo(repoRoot);
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeImpactFixtureRepo(repoRoot: string): Promise<void> {
  await writeFile(
    path.join(repoRoot, "src", "base.ts"),
    [
      "export function base(): string {",
      "  return \"base\";",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src", "alpha.ts"),
    [
      "import { base } from \"./base\";",
      "",
      "export function alpha(): string {",
      "  return base();",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src", "zeta.ts"),
    [
      "import { base } from \"./base\";",
      "",
      "export function zeta(): string {",
      "  return base();",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src", "beta.ts"),
    [
      "import { alpha } from \"./alpha\";",
      "",
      "export function beta(): string {",
      "  return alpha();",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src", "session.ts"),
    [
      "export type Session = string;",
      "",
      "export class SessionManager {",
      "  createSession(accountId: string): Session {",
      "    return accountId;",
      "  }",
      "}",
      "",
      "export class SessionStore {",
      "  loadSession(id: string): Session {",
      "    return id;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
}

function requireImpactGraph(
  db: Parameters<typeof getImpactGraph>[0],
  input: GetImpactGraphInput,
): ImpactGraphOutput {
  const result = getImpactGraph(db, input);

  if (!result.ok) {
    throw new Error(`Expected success, received ${result.error.code}: ${result.error.message}`);
  }

  return result.output;
}

test("raw calls edge is exported as caller -> callee", async () => {
  await withPythonCallerFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/pkg/target.py::do_work",
        depth: 2,
        format: "list",
      });

      const callsEdges = result.edges.filter((edge) => edge.edgeType === "calls");

      assert.ok(callsEdges.length > 0, "expected at least one calls edge in exported edges");
      for (const edge of callsEdges) {
        assert.equal(
          edge.fromFqName,
          "src/pkg/user.py::entry",
          `calls edge from field should be the caller, got ${edge.fromFqName}`,
        );
        assert.equal(
          edge.toFqName,
          "src/pkg/target.py::do_work",
          `calls edge to field should be the callee, got ${edge.toFqName}`,
        );
      }
    } finally {
      db.close();
    }
  });
});

test("get_impact_graph on a callee surfaces the caller as a reverse dependent", async () => {
  await withPythonCallerFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/pkg/target.py::do_work",
        depth: 2,
        format: "list",
      });

      assert.equal(result.resolvedSymbol.fqName, "src/pkg/target.py::do_work");
      assert.ok(
        result.nodes.some(
          (node) => node.fqName === "src/pkg/user.py::entry" && node.distance === 1,
        ),
        "expected caller entry at distance 1 as a reverse dependent",
      );
    } finally {
      db.close();
    }
  });
});

test("list/tree wording describes reverse dependents without flipping edge semantics", async () => {
  await withPythonCallerFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const list = requireImpactGraph(db, {
        symbolFqn: "src/pkg/target.py::do_work",
        depth: 2,
        format: "list",
      });
      const tree = requireImpactGraph(db, {
        symbolFqn: "src/pkg/target.py::do_work",
        depth: 2,
        format: "tree",
      });

      const expectedDependentLine =
        "src/pkg/user.py::entry (function) calls src/pkg/target.py::do_work";

      assert.ok(
        list.view.lines.some((line) => line.includes(expectedDependentLine)),
        `list wording should read caller calls callee; got lines ${JSON.stringify(list.view.lines)}`,
      );
      assert.ok(
        tree.view.lines.some((line) => line.includes(expectedDependentLine)),
        `tree wording should read caller calls callee; got lines ${JSON.stringify(tree.view.lines)}`,
      );

      const reversedWording =
        "src/pkg/target.py::do_work (function) calls src/pkg/user.py::entry";
      assert.ok(
        !list.view.lines.some((line) => line.includes(reversedWording)),
        "list wording must not imply the callee calls the caller",
      );
      assert.ok(
        !tree.view.lines.some((line) => line.includes(reversedWording)),
        "tree wording must not imply the callee calls the caller",
      );
    } finally {
      db.close();
    }
  });
});

test("member-resolution self.x calls edge is stored caller -> callee", async () => {
  await withPythonSelfCallFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/pkg/service.py::Service.format_message",
        depth: 2,
        format: "list",
      });

      const selfCallEdges = result.edges.filter(
        (edge) =>
          edge.edgeType === "calls"
          && edge.fromFqName === "src/pkg/service.py::Service.greet",
      );

      assert.equal(
        selfCallEdges.length,
        1,
        `expected exactly one self.method call edge from Service.greet, got ${JSON.stringify(result.edges)}`,
      );
      assert.equal(
        selfCallEdges[0]?.toFqName,
        "src/pkg/service.py::Service.format_message",
        "self.method call edge must point to the callee method",
      );
    } finally {
      db.close();
    }
  });
});

test("inherited super() call edge is stored caller -> callee", async () => {
  await withPythonInheritedMethodFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/pkg/base.py::Base.handle",
        depth: 2,
        format: "list",
      });

      const superCallEdges = result.edges.filter(
        (edge) =>
          edge.edgeType === "calls"
          && edge.fromFqName === "src/pkg/sub.py::Sub.handle",
      );

      assert.equal(
        superCallEdges.length,
        1,
        `expected exactly one super() call edge from Sub.handle, got ${JSON.stringify(result.edges)}`,
      );
      assert.equal(
        superCallEdges[0]?.toFqName,
        "src/pkg/base.py::Base.handle",
        "super() call edge must point to the resolved base-class method",
      );
    } finally {
      db.close();
    }
  });
});

test("contains/imports/references edges export canonical stored direction", async () => {
  await withPythonReferenceFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/pkg/base.py::Base",
        depth: 2,
        format: "list",
      });

      const referenceEdges = result.edges.filter((edge) => edge.edgeType === "references");
      assert.ok(referenceEdges.length > 0, "expected at least one references edge");
      for (const edge of referenceEdges) {
        assert.equal(
          edge.toFqName,
          "src/pkg/base.py::Base",
          `references edge to field should be the referenced symbol, got ${edge.toFqName}`,
        );
        assert.equal(
          edge.fromFqName,
          "src/pkg/sub.py::Sub",
          `references edge from field should be the referring symbol, got ${edge.fromFqName}`,
        );
      }
    } finally {
      db.close();
    }
  });
});

test("dependents omit source excerpts unless the product layer requests them", async () => {
  await withImpactFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = requireImpactGraph(db, {
        symbolFqn: "src/base.ts::base",
        depth: 2,
        format: "list",
      });

      for (const node of result.nodes) {
        assert.equal(node.sourceExcerpt, undefined);
      }
    } finally {
      db.close();
    }
  });
});

test("dependents include bounded source excerpts when repoRoot is provided", async () => {
  await withImpactFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = getImpactGraph(db, {
        symbolFqn: "src/base.ts::base",
        depth: 2,
        format: "list",
      }, { repoRoot });

      assert.equal(result.ok, true);
      if (!result.ok) {
        throw new Error("expected success");
      }

      const root = result.output.nodes.find((node) => node.distance === 0);
      assert.ok(root, "expected a focal root node");
      assert.equal(root.sourceExcerpt, undefined);

      const dependents = result.output.nodes.filter((node) => node.distance > 0);
      assert.ok(dependents.length > 0, "expected at least one dependent");

      const alpha = dependents.find((node) => node.fqName === "src/alpha.ts::alpha");
      assert.ok(alpha, "expected the alpha dependent");
      assert.ok(alpha.sourceExcerpt, "expected an excerpt for alpha");
      assert.equal(alpha.sourceExcerpt.filePath, "src/alpha.ts");
      assert.ok(alpha.sourceExcerpt.text.includes("alpha"));
      assert.ok(
        alpha.sourceExcerpt.text.split("\n").length <= 12,
        "excerpt must respect the line ceiling",
      );
      assert.ok(
        ["symbol_span", "signature", "fallback_symbol_window"].includes(alpha.sourceExcerpt.reason),
      );
    } finally {
      db.close();
    }
  });
});

test("impact excerpts are capped at the response-wide budget", async () => {
  await withImpactFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const result = getImpactGraph(db, {
        symbolFqn: "src/base.ts::base",
        depth: 5,
        format: "list",
      }, { repoRoot, maxExcerpts: 1 });

      assert.equal(result.ok, true);
      if (!result.ok) {
        throw new Error("expected success");
      }

      const dependents = result.output.nodes.filter((node) => node.distance > 0);
      const withExcerpt = dependents.filter((node) => node.sourceExcerpt != null);
      const nulled = dependents.filter((node) => node.sourceExcerpt === null);

      assert.equal(withExcerpt.length, 1, "only the budgeted dependent should carry an excerpt");
      assert.ok(nulled.length > 0, "dependents beyond the budget should be explicitly nulled");
    } finally {
      db.close();
    }
  });
});

test("a dependent with stale source yields a null excerpt without failing the impact graph", async () => {
  await withImpactFixture(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });

      // Mutate one dependent's file after indexing so its content hash and size no
      // longer match the indexed file state. The freshness-gated source loader must
      // refuse the stale bytes, degrading that dependent's excerpt to null while the
      // impact graph itself still succeeds and other dependents keep their excerpts.
      await writeFile(
        path.join(repoRoot, "src", "alpha.ts"),
        [
          "import { base } from \"./base\";",
          "",
          "// edited after indexing so the indexed file state is now stale",
          "export function alpha(): string {",
          "  return base() + \"-edited\";",
          "}",
          "",
        ].join("\n"),
      );

      const result = getImpactGraph(db, {
        symbolFqn: "src/base.ts::base",
        depth: 5,
        format: "list",
      }, { repoRoot });

      assert.equal(result.ok, true, "stale source must not fail the impact graph");
      if (!result.ok) {
        throw new Error("expected success");
      }

      const alpha = result.output.nodes.find((node) => node.fqName === "src/alpha.ts::alpha");
      assert.ok(alpha, "expected the alpha dependent");
      assert.equal(alpha.sourceExcerpt, null, "stale dependent source must degrade to null");

      // A dependent whose file was untouched still loads freshly and carries an excerpt,
      // proving the null is scoped to the stale file rather than a blanket failure.
      const zeta = result.output.nodes.find((node) => node.fqName === "src/zeta.ts::zeta");
      assert.ok(zeta, "expected the zeta dependent");
      assert.ok(zeta.sourceExcerpt, "untouched dependent source should still load freshly");
    } finally {
      db.close();
    }
  });
});
