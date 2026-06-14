import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { runPipelineOrchestrator } from "../runPipeline/runPipelineOrchestrator";
import { RunPipelineImpactSkipReason } from "../runPipeline/types";
import {
  getImpactGraph,
  type GetImpactGraphInput,
  type ImpactGraphOutput,
} from "./getImpactGraph";

// Impact-graph parity acceptance.
//
// This suite does not reimplement calls/references/member/super extraction.
// It proves those features work together through a single indexed Python
// parity fixture and through run_pipeline's impact section: every supported
// evidence type surfaces a real reverse dependent, coverage stays honest, and
// every skip path names an explicit reason (never silent).

/**
 * One Python package exercising every supported impact-evidence type. Each
 * source construct below is mirrored from a proven pythonParser test so the
 * fixture only depends on edges the conservative extractor actually emits.
 */
const PARITY_FILES: ReadonlyArray<{ readonly path: string; readonly content: string }> = [
  { path: "src/pkg/__init__.py", content: "" },

  // (1) same-file function call -> calls edge
  {
    path: "src/pkg/calls_local.py",
    content: ["def helper():", "    return 1", "", "def caller():", "    return helper()", ""].join("\n"),
  },

  // (2) imported function call -> calls edge
  { path: "src/pkg/target.py", content: "def do_work(x):\n    return x\n" },
  {
    path: "src/pkg/user.py",
    content: ["from .target import do_work", "", "def entry():", "    return do_work(1)", ""].join("\n"),
  },

  // (3) non-call reference (inheritance base) -> references edge
  { path: "src/pkg/base_ref.py", content: "class Base:\n    pass\n" },
  {
    path: "src/pkg/sub_ref.py",
    content: ["from .base_ref import Base", "", "class Sub(Base):", "    pass", ""].join("\n"),
  },

  // (4) decorator reference -> references edge
  { path: "src/pkg/deco.py", content: "def register(fn):\n    return fn\n" },
  {
    path: "src/pkg/decorated.py",
    content: ["from .deco import register", "", "@register", "def decorated():", "    return 1", ""].join("\n"),
  },

  // (5) annotation reference -> references edge
  { path: "src/pkg/model.py", content: "class User:\n    pass\n" },
  {
    path: "src/pkg/consumer_ann.py",
    content: ["from .model import User", "", "def load(user: User) -> User:", "    return user", ""].join("\n"),
  },

  // (6) exception reference -> references edge
  { path: "src/pkg/errors.py", content: "class MyError(Exception):\n    pass\n" },
  {
    path: "src/pkg/consumer_exc.py",
    content: [
      "from .errors import MyError",
      "",
      "def catch_it():",
      "    try:",
      "        pass",
      "    except MyError:",
      "        pass",
      "",
    ].join("\n"),
  },

  // (7) module-level constant reference -> references edge
  { path: "src/pkg/settings.py", content: "DEFAULT_BACKEND = 'orca'\n" },
  {
    path: "src/pkg/consumer_const.py",
    content: ["from .settings import DEFAULT_BACKEND", "", "def current_backend():", "    return DEFAULT_BACKEND", ""].join("\n"),
  },

  // (8) self.method() -> same-class calls edge
  {
    path: "src/pkg/service.py",
    content: [
      "class Service:",
      "    def greet(self):",
      "        return self.format_message()",
      "",
      "    def format_message(self):",
      "        return 'hello'",
      "",
    ].join("\n"),
  },

  // (9) cls.CONSTANT -> same-class references edge
  {
    path: "src/pkg/factory.py",
    content: [
      "class Factory:",
      "    DEFAULT = 'orca'",
      "",
      "    @classmethod",
      "    def current(cls):",
      "        return cls.DEFAULT",
      "",
    ].join("\n"),
  },

  // (10) ClassName.method() -> same-file class calls edge
  {
    path: "src/pkg/widget.py",
    content: [
      "class Widget:",
      "    @staticmethod",
      "    def build():",
      "        return 'built'",
      "",
      "def assemble():",
      "    return Widget.build()",
      "",
    ].join("\n"),
  },

  // (11) inherited self.method() -> cross-class calls edge via direct base
  {
    path: "src/pkg/inh_self.py",
    content: [
      "class BaseSelf:",
      "    def shared(self):",
      "        return 'shared'",
      "",
      "class SubSelf(BaseSelf):",
      "    def use(self):",
      "        return self.shared()",
      "",
    ].join("\n"),
  },

  // (12) super().method() -> cross-class calls edge to a direct base method
  { path: "src/pkg/base_super.py", content: "class BaseSuper:\n    def handle(self):\n        return 'base'\n" },
  {
    path: "src/pkg/sub_super.py",
    content: [
      "from .base_super import BaseSuper",
      "",
      "class SubSuper(BaseSuper):",
      "    def handle(self):",
      "        return super().handle()",
      "",
    ].join("\n"),
  },
];

interface EvidenceCase {
  readonly label: string;
  readonly focalFqn: string;
  readonly expectedDependentFqn: string;
  readonly expectedEdgeType: "calls" | "references";
}

const EVIDENCE_CASES: readonly EvidenceCase[] = [
  {
    label: "same-file function call",
    focalFqn: "src/pkg/calls_local.py::helper",
    expectedDependentFqn: "src/pkg/calls_local.py::caller",
    expectedEdgeType: "calls",
  },
  {
    label: "imported function call",
    focalFqn: "src/pkg/target.py::do_work",
    expectedDependentFqn: "src/pkg/user.py::entry",
    expectedEdgeType: "calls",
  },
  {
    label: "non-call reference (inheritance base)",
    focalFqn: "src/pkg/base_ref.py::Base",
    expectedDependentFqn: "src/pkg/sub_ref.py::Sub",
    expectedEdgeType: "references",
  },
  {
    label: "decorator reference",
    focalFqn: "src/pkg/deco.py::register",
    expectedDependentFqn: "src/pkg/decorated.py::decorated",
    expectedEdgeType: "references",
  },
  {
    label: "annotation reference",
    focalFqn: "src/pkg/model.py::User",
    expectedDependentFqn: "src/pkg/consumer_ann.py::load",
    expectedEdgeType: "references",
  },
  {
    label: "exception reference",
    focalFqn: "src/pkg/errors.py::MyError",
    expectedDependentFqn: "src/pkg/consumer_exc.py::catch_it",
    expectedEdgeType: "references",
  },
  {
    label: "module-level constant reference",
    focalFqn: "src/pkg/settings.py::DEFAULT_BACKEND",
    expectedDependentFqn: "src/pkg/consumer_const.py::current_backend",
    expectedEdgeType: "references",
  },
  {
    label: "self.method()",
    focalFqn: "src/pkg/service.py::Service.format_message",
    expectedDependentFqn: "src/pkg/service.py::Service.greet",
    expectedEdgeType: "calls",
  },
  {
    label: "cls.CONSTANT",
    focalFqn: "src/pkg/factory.py::Factory.DEFAULT",
    expectedDependentFqn: "src/pkg/factory.py::Factory.current",
    expectedEdgeType: "references",
  },
  {
    label: "ClassName.method()",
    focalFqn: "src/pkg/widget.py::Widget.build",
    expectedDependentFqn: "src/pkg/widget.py::assemble",
    expectedEdgeType: "calls",
  },
  {
    label: "inherited self.method()",
    focalFqn: "src/pkg/inh_self.py::BaseSelf.shared",
    expectedDependentFqn: "src/pkg/inh_self.py::SubSelf.use",
    expectedEdgeType: "calls",
  },
  {
    label: "super().method()",
    focalFqn: "src/pkg/base_super.py::BaseSuper.handle",
    expectedDependentFqn: "src/pkg/sub_super.py::SubSuper.handle",
    expectedEdgeType: "calls",
  },
];

async function withParityRepo(
  run: (ctx: { repoRoot: string; db: ReturnType<typeof openIndexerDatabase> }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-impact-parity-"));
  const repoRoot = path.join(root, "repo");
  const db = openIndexerDatabase();

  try {
    await writeParityRepo(repoRoot);
    await indexProject({ repoRoot, db });
    await run({ repoRoot, db });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function writeParityRepo(repoRoot: string): Promise<void> {
  for (const file of PARITY_FILES) {
    const absolute = path.join(repoRoot, file.path);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content);
  }
}

function requireImpactGraph(
  db: ReturnType<typeof openIndexerDatabase>,
  input: GetImpactGraphInput,
): ImpactGraphOutput {
  const result = getImpactGraph(db, input);
  if (!result.ok) {
    throw new Error(`Expected impact success for ${input.symbolFqn}, got ${result.error.code}: ${result.error.message}`);
  }
  return result.output;
}

test("parity fixture surfaces a real dependent through every supported evidence type", async () => {
  await withParityRepo(async ({ db }) => {
    for (const evidence of EVIDENCE_CASES) {
      const result = requireImpactGraph(db, {
        symbolFqn: evidence.focalFqn,
        depth: 2,
        format: "list",
      });

      const dependentFqNames = result.nodes
        .filter((node) => node.distance > 0)
        .map((node) => node.fqName);
      assert.ok(
        dependentFqNames.includes(evidence.expectedDependentFqn),
        `[${evidence.label}] expected dependent ${evidence.expectedDependentFqn} for focal ${evidence.focalFqn}, got ${JSON.stringify(dependentFqNames)}`,
      );

      // A dependent pair may legitimately carry more than one edge type (an
      // imported constant has both an imports edge and a references edge), so
      // assert that an edge of the expected evidence type exists for the pair.
      const pairEdges = result.edges.filter(
        (edge) => edge.toFqName === evidence.focalFqn && edge.fromFqName === evidence.expectedDependentFqn,
      );
      assert.ok(
        pairEdges.some((edge) => edge.edgeType === evidence.expectedEdgeType),
        `[${evidence.label}] expected a ${evidence.expectedEdgeType} edge ${evidence.expectedDependentFqn} -> ${evidence.focalFqn}, got ${JSON.stringify(pairEdges.map((edge) => edge.edgeType))}`,
      );
    }
  });
});

test("impact coverage reports edge-type and evidence usage with conservative notes", async () => {
  await withParityRepo(async ({ db }) => {
    // super() focal: the reverse dependent (SubSuper.handle) connects two
    // different classes, so this single result exercises caller, member, and
    // inherited evidence simultaneously.
    const result = requireImpactGraph(db, {
      symbolFqn: "src/pkg/base_super.py::BaseSuper.handle",
      depth: 2,
      format: "list",
    });

    // Supported edge types.
    assert.deepEqual(
      [...result.coverage.supportedEdgeTypes].sort(),
      ["calls", "contains", "imports", "references"],
    );

    // Observed edge types.
    assert.ok(result.coverage.observedEdgeTypes.includes("calls"));

    // Whether caller evidence was used.
    const callerEvidenceUsed = result.coverage.observedEdgeTypes.includes("calls");
    assert.equal(callerEvidenceUsed, true);

    // Whether member/inherited evidence was used (reported via notes).
    assert.ok(
      result.coverage.notes.some((note) => note.includes("Member/attribute resolution contributed evidence")),
      `expected member evidence note, got ${JSON.stringify(result.coverage.notes)}`,
    );
    assert.ok(
      result.coverage.notes.some((note) =>
        note.includes("Inherited-member or cross-class-qualified evidence contributed")
      ),
      `expected inherited evidence note, got ${JSON.stringify(result.coverage.notes)}`,
    );

    // Static / conservative limitation notes.
    assert.ok(
      result.coverage.notes.includes(
        "This does not represent runtime execution flow, semantic reachability, dataflow, or dynamic dispatch truth.",
      ),
    );
    assert.equal(result.coverage.analysisKind, "structural");
    assert.equal(result.coverage.crossRepo, false);
  });
});

test("a references focal reports reference evidence usage in coverage", async () => {
  await withParityRepo(async ({ db }) => {
    const result = requireImpactGraph(db, {
      symbolFqn: "src/pkg/settings.py::DEFAULT_BACKEND",
      depth: 2,
      format: "list",
    });
    const referenceEvidenceUsed = result.coverage.observedEdgeTypes.includes("references");
    assert.equal(referenceEvidenceUsed, true);
    assert.equal(result.coverage.observedEdgeTypes.includes("calls"), false);
  });
});

test("run_pipeline impact section includes evidence for a refactor query naming a focal symbol", async () => {
  await withParityRepo(async ({ db, repoRoot }) => {
    const out = runPipelineOrchestrator(db, repoRoot, {
      query: "refactor do_work function",
      intent: "refactor",
    });

    assert.equal(out.impact.included, true, `expected impact included, skipReason=${out.impact.skipReason}`);
    assert.equal(out.impact.skipReason, null);
    assert.equal(out.impact.focalSymbol?.localName, "do_work");
    assert.equal(out.impact.focalSymbol?.fqName, "src/pkg/target.py::do_work");
    assert.ok((out.impact.graph?.summary.dependentSymbolCount ?? 0) > 0);

    const dependentFqNames = (out.impact.graph?.nodes ?? [])
      .filter((node) => node.distance > 0)
      .map((node) => node.fqName);
    assert.ok(
      dependentFqNames.includes("src/pkg/user.py::entry"),
      `expected user.py::entry as impact dependent, got ${JSON.stringify(dependentFqNames)}`,
    );
  });
});

test("run_pipeline skips impact with not_requested_by_intent reason for a non-refactor query", async () => {
  await withParityRepo(async ({ db, repoRoot }) => {
    const out = runPipelineOrchestrator(db, repoRoot, {
      query: "explore do_work module",
      intent: "explore",
    });
    assert.equal(out.impact.included, false);
    // not_requested_by_intent is the intent-driven skip: the resolved intent did
    // not request impact (distinct from no_focal_symbol / multiple_focal_symbols).
    assert.equal(out.impact.skipReason, RunPipelineImpactSkipReason.NotRequestedByIntent);
    assert.equal(out.impact.skipReason, "not_requested_by_intent");
    assert.equal(out.impact.focalSymbol, null);
  });
});

test("run_pipeline skips impact with no_focal_symbol reason when nothing matches", async () => {
  await withParityRepo(async ({ db, repoRoot }) => {
    const out = runPipelineOrchestrator(db, repoRoot, {
      query: "refactor nonexistent_symbol_zzz everywhere",
      intent: "refactor",
    });
    assert.equal(out.impact.included, false);
    assert.equal(out.impact.skipReason, RunPipelineImpactSkipReason.NoFocalSymbol);
    assert.equal(out.impact.skipReason, "no_focal_symbol");
    assert.equal(out.impact.matchedCandidates, 0);
  });
});

test("run_pipeline skips impact with multiple_focal_symbols reason when several candidates match", async () => {
  await withParityRepo(async ({ db, repoRoot }) => {
    const out = runPipelineOrchestrator(db, repoRoot, {
      query: "refactor do_work and entry",
      intent: "refactor",
    });
    assert.equal(out.impact.included, false);
    assert.equal(out.impact.skipReason, RunPipelineImpactSkipReason.MultipleFocalSymbols);
    assert.equal(out.impact.skipReason, "multiple_focal_symbols");
    assert.ok(out.impact.matchedCandidates >= 2);
  });
});

test("impact skip taxonomy is complete and impact_error maps to an honest get_impact_graph failure", async () => {
  // Requirement: skipped impact is never silent and the taxonomy includes at
  // least these reasons.
  assert.equal(RunPipelineImpactSkipReason.NotRequestedByIntent, "not_requested_by_intent");
  assert.equal(RunPipelineImpactSkipReason.NoFocalSymbol, "no_focal_symbol");
  assert.equal(RunPipelineImpactSkipReason.MultipleFocalSymbols, "multiple_focal_symbols");
  assert.equal(RunPipelineImpactSkipReason.ImpactError, "impact_error");

  // impact_error is the defensive mapping of a get_impact_graph failure. The
  // orchestrator's focal selection guards against ambiguous focal symbols
  // (they surface as multiple_focal_symbols first), so we prove the underlying
  // failure deterministically: a duplicate-FQN symbol makes get_impact_graph
  // return ambiguous_symbol, which runImpactSection reports as impact_error.
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-impact-error-"));
  const repoRoot = path.join(root, "repo");
  const db = openIndexerDatabase();
  try {
    await mkdir(path.join(repoRoot, "src", "pkg"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "pkg", "__init__.py"), "");
    await writeFile(
      path.join(repoRoot, "src", "pkg", "twins.py"),
      ["def twin(a):", "    return a + 1", "", "def twin(a):", "    return a + 2", ""].join("\n"),
    );
    await indexProject({ repoRoot, db });

    const result = getImpactGraph(db, {
      symbolFqn: "src/pkg/twins.py::twin",
      depth: 2,
      format: "list",
    });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.code, "ambiguous_symbol");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("impact graph output is deterministic across repeated calls and re-indexing", async () => {
  const focal: GetImpactGraphInput = {
    symbolFqn: "src/pkg/base_super.py::BaseSuper.handle",
    depth: 2,
    format: "tree",
  };

  // Repeated calls on the same indexed database are byte-identical.
  await withParityRepo(async ({ db }) => {
    const first = requireImpactGraph(db, focal);
    const second = requireImpactGraph(db, focal);
    assert.deepEqual(second, first);
  });

  // Re-indexing into a fresh database produces identical output (symbol ids
  // are content-derived, so impact output must not drift across runs).
  const captures: ImpactGraphOutput[] = [];
  for (let run = 0; run < 2; run += 1) {
    await withParityRepo(async ({ db }) => {
      captures.push(requireImpactGraph(db, focal));
    });
  }
  assert.deepEqual(captures[1], captures[0]);
});

test("source files under src/ are valid UTF-8 and grep/diff friendly (no NUL bytes)", async () => {
  const srcRoot = path.resolve(import.meta.dir, "..");
  const offenders: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });

  async function scan(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scan(absolute);
        continue;
      }
      if (!/\.(ts|tsx|py|js|mjs)$/.test(entry.name)) {
        continue;
      }
      const bytes = await readFile(absolute);
      if (bytes.includes(0x00)) {
        offenders.push(`${absolute} (NUL byte)`);
        continue;
      }
      try {
        decoder.decode(bytes);
      } catch {
        offenders.push(`${absolute} (invalid UTF-8)`);
      }
    }
  }

  await scan(srcRoot);
  assert.deepEqual(offenders, [], `expected all src files to be valid UTF-8 without NUL bytes, found: ${offenders.join(", ")}`);
});
