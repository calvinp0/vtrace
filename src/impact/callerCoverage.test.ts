import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { listSymbolsByFqName } from "../db/repositories/symbolsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { analyzeCallerCoverage, collectImportedModuleNames, findMethodCallOccurrences } from "./callerCoverage";
import { getImpactGraph } from "./getImpactGraph";

/**
 * A deliberately awkward repository: two classes share a method name, one
 * receiver is typed, one is built by a constructor, one is rebound out from
 * under its annotation, one is a module of the same name, and one is genuinely
 * unknowable. Every M139 precision gate is expressed against this fixture so the
 * rules are checked independently of ARC.
 */
const FIXTURE: Readonly<Record<string, string>> = {
  "model.py": `
class Thing:
    def copy(self):
        """Return a duplicate."""
        return Thing()

    def rename(self, label):
        return label

    def untouched(self):
        return None


class Other:
    def copy(self):
        """A different class with the same method name."""
        return Other()
`,
  "typed.py": `
from model import Thing


def duplicate_typed(thing: Thing) -> Thing:
    """Receiver is a parameter annotated with the owning class."""
    return thing.copy()


def duplicate_constructed():
    """Receiver is assigned from the owning class constructor."""
    built = Thing()
    return built.copy()


def duplicate_annotated_local():
    """Receiver carries a local annotation."""
    local: Thing = make()
    return local.copy()


def make():
    return Thing()
`,
  "ambiguous.py": `
from model import Thing


def duplicate_unknown(payload):
    """Receiver type is genuinely unknown at this call site."""
    return payload.copy()


def duplicate_rebound(thing: Thing):
    """The annotation is stale: the name is rebound before the call."""
    thing = thing.rename("x")
    return thing.copy()


def duplicate_attribute(thing: Thing):
    """Type evidence about the name does not describe its attributes."""
    return thing.inner.copy()


def duplicate_constructor_attribute():
    """The constructor's ATTRIBUTE is copied, not the instance."""
    inner = Thing().inner
    return inner.copy()
`,
  "container.py": `
from model import Thing


def seed() -> Thing:
    """Present so the file carries an indexed relation to the owning class.

    Without it this file reaches Thing only through an import edge, and the
    indexer drops that edge once the file holds more than one function (see the
    M139 report: import-edge attribution defect, deferred). Real container code
    constructs what it holds, so this keeps the fixture honest rather than
    testing around an unrelated bug.
    """
    return Thing()


def duplicate_each(items: list[Thing]) -> list[Thing]:
    """Receiver is a loop variable over a declared container of the owner."""
    return [item.copy() for item in items]


def duplicate_each_untyped(items):
    """No container type is declared, so the loop variable proves nothing."""
    out = []
    for item in items:
        out.append(item.copy())
    return out
`,
  "modulecall.py": `
import shutil
import copy as copy_module


def move(src, dst):
    """shutil.copy is a module function, not an instance method."""
    return shutil.copy(src, dst)
`,
};

async function withCallerFixture(
  run: (repoRoot: string) => Promise<void>,
  files: Readonly<Record<string, string>> = FIXTURE,
): Promise<void> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-m139-callers-"));
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const absolute = path.join(repoRoot, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, contents.trimStart(), "utf8");
    }
    await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

async function coverageFor(
  repoRoot: string,
  fqName: string,
  exactCallerCount = 0,
): Promise<ReturnType<typeof analyzeCallerCoverage>> {
  const db = openIndexerDatabase();
  try {
    await indexProject({ repoRoot, db });
    const target = listSymbolsByFqName(db, fqName)[0];
    assert.ok(target !== undefined, `fixture symbol missing: ${fqName}`);
    return analyzeCallerCoverage(db, target, exactCallerCount, { repoRoot, maxPotentialCallers: 50 });
  } finally {
    db.close();
  }
}

function siteAt(
  result: ReturnType<typeof analyzeCallerCoverage>,
  filePath: string,
  receiver: string,
) {
  return result.potentialCallers.find(
    (caller) => caller.filePath === filePath && caller.receiverExpression === receiver,
  );
}

test("typed, constructed, and annotated receivers are high-confidence potential callers", async () => {
  await withCallerFixture(async (repoRoot) => {
    const result = await coverageFor(repoRoot, "model.py::Thing.copy");

    assert.equal(siteAt(result, "typed.py", "thing")?.confidence, "high");
    assert.equal(siteAt(result, "typed.py", "thing")?.evidenceKind, "annotated_parameter");
    assert.equal(siteAt(result, "typed.py", "built")?.evidenceKind, "constructor_assignment");
    assert.equal(siteAt(result, "typed.py", "local")?.evidenceKind, "annotated_variable");
  });
});

test("high confidence never means proven: every site stays outside the edge set", async () => {
  await withCallerFixture(async (repoRoot) => {
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db });
      const result = getImpactGraph(db, {
        symbolFqn: "model.py::Thing.copy",
        depth: 3,
        format: "list",
        maxEdges: 64,
      }, { repoRoot });
      assert.equal(result.ok, true);
      if (!result.ok) return;

      assert.ok(result.output.potentialCallers.length > 0, "expected potential callers");

      // The precise invariant: no unproven call site turned into a proven
      // incoming edge on the target. (Outgoing calls the target itself makes,
      // such as `Thing.copy` constructing a `Thing`, are proven and unrelated.)
      const target = result.output.resolvedSymbol.symbolId;
      const provenIncomingSources = new Set(
        result.output.edges
          .filter((edge) => edge.toSymbolId === target && edge.edgeType === "calls")
          .map((edge) => edge.fromSymbolId),
      );
      for (const caller of result.output.potentialCallers) {
        assert.equal(
          caller.enclosingSymbolId === null || !provenIncomingSources.has(caller.enclosingSymbolId),
          true,
          `${caller.filePath}:${caller.line} was promoted to a proven caller`,
        );
      }
      assert.equal(result.output.summary.consumers.exactCallerCount, 0);
      // ...and the coverage state must say so out loud.
      assert.equal(result.output.callerCoverage.status, "incomplete");
      assert.ok(result.output.callerCoverage.reasonCodes.includes("receiver_type_unresolved"));
    } finally {
      db.close();
    }
  });
});

test("a shared method name is never attributed to one of the definitions", async () => {
  await withCallerFixture(async (repoRoot) => {
    const result = await coverageFor(repoRoot, "model.py::Thing.copy");

    // `Other.copy` exists, so the name alone cannot identify the target.
    assert.equal(result.coverage.competingDefinitionCount, 1);
    assert.ok(result.coverage.reasonCodes.includes("method_name_ambiguous"));

    const unknown = siteAt(result, "ambiguous.py", "payload");
    assert.equal(unknown?.confidence, "unresolved");
    assert.equal(unknown?.evidenceKind, "name_match_only");
  });
});

test("a rebound name loses the confidence its annotation would have given it", async () => {
  await withCallerFixture(async (repoRoot) => {
    const result = await coverageFor(repoRoot, "model.py::Thing.copy");
    const rebound = siteAt(result, "ambiguous.py", "thing");

    // `thing: Thing` is in the signature, but thing = thing.rename(...) ran
    // first. Trusting the annotation here would be a confident wrong answer.
    assert.equal(rebound?.confidence, "unresolved");
  });
});

test("type evidence about a name does not transfer to its attributes", async () => {
  await withCallerFixture(async (repoRoot) => {
    const result = await coverageFor(repoRoot, "model.py::Thing.copy");

    assert.equal(siteAt(result, "ambiguous.py", "thing.inner")?.confidence, "unresolved");
    // `inner = Thing().inner` assigns the ATTRIBUTE, not the constructed value.
    assert.equal(siteAt(result, "ambiguous.py", "inner")?.confidence, "unresolved");
  });
});

test("loop variables are promoted only when the scope declares a container of the owner", async () => {
  await withCallerFixture(async (repoRoot) => {
    const result = await coverageFor(repoRoot, "model.py::Thing.copy");
    const typedLoop = result.potentialCallers.find((caller) => caller.filePath === "container.py"
      && caller.enclosingSymbol?.endsWith("duplicate_each"));
    const untypedLoop = result.potentialCallers.find((caller) => caller.filePath === "container.py"
      && caller.enclosingSymbol?.endsWith("duplicate_each_untyped"));

    assert.equal(typedLoop?.confidence, "medium");
    assert.equal(typedLoop?.evidenceKind, "container_element_in_typed_scope");
    assert.equal(untypedLoop?.confidence, "unresolved");
  });
});

test("module functions sharing the method name are not call sites at all", async () => {
  await withCallerFixture(async (repoRoot) => {
    const result = await coverageFor(repoRoot, "model.py::Thing.copy");

    assert.equal(
      result.potentialCallers.some((caller) => caller.receiverExpression === "shutil"),
      false,
      "shutil.copy is a module function, not an instance-method call",
    );
  });
});

test("proven callers make coverage complete without any source scan", async () => {
  await withCallerFixture(async (repoRoot) => {
    const result = await coverageFor(repoRoot, "model.py::Thing.copy", 2);
    // The gate is applied by the engine; the analyzer still reports the exact
    // count it was handed so the two can never disagree.
    assert.equal(result.coverage.exactCallerCount, 2);
  });
});

test("zero potential callers plus a full scan is the only way to reach complete", async () => {
  await withCallerFixture(async (repoRoot) => {
    const result = await coverageFor(repoRoot, "model.py::Thing.untouched");

    // `untouched` is called nowhere by that name, and every candidate file was
    // scanned freshly, so absence here is a real finding rather than a gap.
    assert.equal(result.coverage.potentialCallerCount, 0);
    assert.equal(result.coverage.status, "complete");
  });
});

test("an unqualified receiver never yields a proven caller for the other class", async () => {
  await withCallerFixture(async (repoRoot) => {
    const result = await coverageFor(repoRoot, "model.py::Other.copy");

    // Every `x.copy()` in the fixture is either typed to Thing or unknown.
    // None may be attributed to Other with confidence.
    for (const caller of result.potentialCallers) {
      assert.notEqual(caller.confidence, "high", `${caller.filePath}:${caller.line} over-attributed to Other`);
    }
  });
});

test("potential callers stay bounded and report what was withheld", async () => {
  const many: Record<string, string> = { "model.py": FIXTURE["model.py"]! };
  const calls = Array.from({ length: 40 }, (_, index) => `    item${index}.copy()`).join("\n");
  many["bulk.py"] = `
from model import Thing


def bulk(thing: Thing):
${calls}
    return thing
`;

  await withCallerFixture(async (repoRoot) => {
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db });
      const target = listSymbolsByFqName(db, "model.py::Thing.copy")[0]!;
      const result = analyzeCallerCoverage(db, target, 0, { repoRoot, maxPotentialCallers: 5 });

      assert.equal(result.potentialCallers.length, 5);
      assert.ok(result.coverage.potentialCallerCount > 5);
      assert.equal(
        result.coverage.potentialCallersOmitted,
        result.coverage.potentialCallerCount - 5,
      );
      assert.ok(result.coverage.reasonCodes.includes("callsite_candidates_omitted"));
      assert.equal(result.coverage.status, "incomplete");
    } finally {
      db.close();
    }
  }, many);
});

test("receiver expressions are recovered without guessing at their type", () => {
  assert.deepEqual(
    findMethodCallOccurrences("    r_copy, p_copy = reactant.copy(), product.copy()", "copy")
      .map((occurrence) => occurrence.receiver),
    ["reactant", "product"],
  );
  assert.deepEqual(
    findMethodCallOccurrences("        spc = rxn.r_species[0].copy()", "copy")
      .map((occurrence) => occurrence.receiver),
    ["rxn.r_species[0]"],
  );
  // Comments and strings are not code.
  assert.deepEqual(findMethodCallOccurrences("# thing.copy() is documented here", "copy"), []);
  assert.deepEqual(findMethodCallOccurrences('label = "call thing.copy() first"', "copy"), []);
  // A definition has no receiver to capture.
  assert.deepEqual(findMethodCallOccurrences("    def copy(self):", "copy"), []);
});

test("only module bindings are collected, never imported class names", () => {
  const names = collectImportedModuleNames([
    "import shutil",
    "import numpy as np",
    "import os.path",
    "from model import Thing",
  ]);

  assert.equal(names.has("shutil"), true);
  assert.equal(names.has("np"), true);
  assert.equal(names.has("os"), true);
  // `Thing` may well be the owning class; excluding it would hide real callers.
  assert.equal(names.has("Thing"), false);
});
