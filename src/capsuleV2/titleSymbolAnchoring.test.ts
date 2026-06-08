// Tests for title-symbol candidate anchoring.
//
// Unit layer: term extraction (shapes in, generic prose out). Integration layer:
// the symbol named in the title enters the candidate pool, Class.method resolves
// to its neighbourhood, non-source title matches are still demoted, and explicit
// line-anchor / body-literal candidates keep priority over a title-symbol match.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { buildCapsuleV2 } from "./buildCapsuleV2";
import {
  anchorTitleSymbols,
  extractTitleSymbolTerms,
  extractTitleText,
} from "./titleSymbolAnchoring";
import { CapsuleIntent } from "./types";
import { seedCustomFixture } from "./__fixtures__/capsuleV2Fixture";
import { SymbolKind } from "../domain/types";

function paths(items: ReadonlyArray<{ path: string; symbol: string }>): string[] {
  return items.map((i) => `${i.path}::${i.symbol}`);
}

// --- term extraction ---------------------------------------------------------

test("extractTitleText takes the title region before the em-dash join", () => {
  assert.equal(
    extractTitleText("PythonCodePrinter doesn't support Indexed — I use lambdify() to generate code"),
    "PythonCodePrinter doesn't support Indexed",
  );
  assert.equal(extractTitleText("A plain first line\nsecond line"), "A plain first line");
});

test("extractTitleSymbolTerms pulls symbol-shaped terms and drops generic prose", () => {
  // CamelCase, snake_case, SCREAMING, Class.method, and a backticked single word.
  assert.deepEqual(extractTitleSymbolTerms("PythonCodePrinter does not support Indexed"), ["PythonCodePrinter"]);
  assert.ok(extractTitleSymbolTerms("get_inline_instances ignores get_inlines").includes("get_inline_instances"));
  assert.ok(extractTitleSymbolTerms("DEFAULT_TIMEOUT is too small").includes("DEFAULT_TIMEOUT"));
  assert.ok(extractTitleSymbolTerms("ModelAdmin.get_inlines hook missing").includes("ModelAdmin.get_inlines"));
  assert.ok(extractTitleSymbolTerms("`Permutation` constructor fails").includes("Permutation"));
  // Ordinary prose / generic words / exception names → no terms.
  assert.deepEqual(extractTitleSymbolTerms("Decorated init does not show up in docs"), []);
  assert.deepEqual(extractTitleSymbolTerms("Getting the url raises UnicodeError"), []);
  assert.deepEqual(extractTitleSymbolTerms("the parser drops a rule"), []);
});

// --- integration: candidate entry --------------------------------------------

test("a CamelCase title symbol enters the candidate pool (over a body-prose decoy)", () => {
  const { db, repoRoot } = seedCustomFixture([
    {
      relPath: "pkg/pycode.py",
      specs: [{
        localName: "PythonCodePrinter",
        kind: SymbolKind.Class,
        signature: "class PythonCodePrinter",
        body: "class PythonCodePrinter(AbstractPrinter):\n    def _print_Symbol(self, expr):\n        return str(expr)",
      }],
    },
    {
      relPath: "pkg/lambdify.py",
      specs: [{
        localName: "lambdify",
        kind: SymbolKind.Function,
        signature: "lambdify(args, expr)",
        body: "def lambdify(args, expr):\n    # generate functions and save the code for further use\n    return compile_code(expr)",
      }],
    },
  ]);
  try {
    const r = buildCapsuleV2({
      db,
      repoRoot,
      task: "PythonCodePrinter does not support Indexed — I use lambdify() to generate functions and save the code",
      intent: CapsuleIntent.Auto,
      maxTokens: 8_000,
    });
    const all = paths([...r.pivots, ...r.support, ...r.discarded]);
    assert.ok(all.includes("pkg/pycode.py::PythonCodePrinter"), `title symbol must enter the pool: ${all}`);
    assert.ok(
      (r.diagnostics.title_symbol_matches ?? []).some((m) => m.symbol === "PythonCodePrinter"),
      "title-symbol diagnostics must record the match",
    );
    assert.equal(r.diagnostics.title_symbol_search_used, true);
  } finally {
    db.close();
  }
});

test("a snake_case title symbol enters the candidate pool", () => {
  const { db, repoRoot } = seedCustomFixture([
    {
      relPath: "pkg/options.py",
      specs: [{
        localName: "get_inline_instances",
        kind: SymbolKind.Function,
        signature: "get_inline_instances(self, request)",
        body: "def get_inline_instances(self, request):\n    return list(self.inlines)",
      }],
    },
  ]);
  try {
    const r = buildCapsuleV2({
      db,
      repoRoot,
      task: "get_inline_instances ignores the request argument",
      intent: CapsuleIntent.Auto,
      maxTokens: 8_000,
    });
    const all = paths([...r.pivots, ...r.support, ...r.discarded]);
    assert.ok(all.includes("pkg/options.py::get_inline_instances"), `snake_case title symbol must enter the pool: ${all}`);
    assert.ok((r.diagnostics.title_symbol_terms ?? []).includes("get_inline_instances"));
  } finally {
    db.close();
  }
});

test("a Class.method title symbol resolves to the class/method neighbourhood", () => {
  const { db, repoRoot } = seedCustomFixture([
    {
      relPath: "pkg/admin.py",
      specs: [
        { localName: "ModelAdmin", kind: SymbolKind.Class, body: "class ModelAdmin:\n    pass" },
        {
          localName: "get_inlines",
          kind: SymbolKind.Method,
          parentLocalName: "ModelAdmin",
          signature: "get_inlines(self, request)",
          body: "    def get_inlines(self, request):\n        return self.inlines",
        },
      ],
    },
  ]);
  try {
    const result = anchorTitleSymbols({ db, task: "ModelAdmin.get_inlines hook does not fire" });
    assert.equal(result.used, true);
    // Resolves to the method (preferred) under the named class.
    assert.ok(
      result.matches.some((m) => m.symbol === "get_inlines" && m.path === "pkg/admin.py"),
      `Class.method must resolve to the method neighbourhood: ${JSON.stringify(result.matches)}`,
    );
  } finally {
    db.close();
  }
});

// --- guardrails ---------------------------------------------------------------

test("non-source doc-data title matches are still demoted out of pivot", () => {
  const { db, repoRoot } = seedCustomFixture([
    {
      relPath: "doc/data/messages/x/BadNamesChecker.py",
      specs: [{
        localName: "BadNamesChecker",
        kind: SymbolKind.Class,
        body: "class BadNamesChecker:\n    def check(self):\n        return True",
      }],
    },
    {
      relPath: "pkg/checker.py",
      specs: [{
        localName: "validate_names",
        kind: SymbolKind.Function,
        signature: "validate_names(names)",
        body: "def validate_names(names):\n    # BadNamesChecker production validation\n    return [n for n in names if ok(n)]",
      }],
    },
  ]);
  try {
    const r = buildCapsuleV2({
      db,
      repoRoot,
      task: "BadNamesChecker rejects valid names — validation is wrong",
      intent: CapsuleIntent.Auto,
      maxTokens: 8_000,
    });
    // The doc-data title match must NOT be a pivot even though the title named it.
    for (const p of r.pivots) {
      assert.ok(!p.path.includes("doc/data/"), `doc-data title match must not be a pivot: ${p.path}`);
    }
    assert.ok(
      (r.diagnostics.non_source_candidates_downranked ?? []).some((e) => e.path.includes("doc/data/"))
        || [...r.support, ...r.discarded].some((i) => i.path.includes("doc/data/")),
      "the doc-data title match must be demoted/present, not a pivot",
    );
  } finally {
    db.close();
  }
});

test("a line anchor outranks a title-symbol candidate", () => {
  const { db, repoRoot } = seedCustomFixture([
    {
      relPath: "pkg/printer.py",
      specs: [{
        localName: "CodePrinter",
        kind: SymbolKind.Class,
        body: "class CodePrinter:\n    def emit(self):\n        return ''",
      }],
    },
    {
      relPath: "pkg/engine.py",
      specs: [{
        localName: "run_engine",
        kind: SymbolKind.Function,
        signature: "run_engine(x)",
        body: "def run_engine(x):\n    return x + 1\n# padding line\n# padding line\n# padding line",
      }],
    },
  ]);
  try {
    // The task names CodePrinter (title symbol) but cites an explicit anchor into engine.py.
    const r = buildCapsuleV2({
      db,
      repoRoot,
      task: "CodePrinter misbehaves — see pkg/engine.py#L1-L2 for the failing path",
      intent: CapsuleIntent.Auto,
      maxTokens: 8_000,
    });
    assert.equal(r.pivots[0]!.path, "pkg/engine.py", `line anchor must lead, got ${r.pivots[0]!.path}`);
  } finally {
    db.close();
  }
});

test("a body-literal diagnostic match outranks a title-symbol candidate", () => {
  const { db, repoRoot } = seedCustomFixture([
    {
      relPath: "pkg/printer.py",
      specs: [{
        localName: "CodePrinter",
        kind: SymbolKind.Class,
        body: "class CodePrinter:\n    def render(self):\n        return ''",
      }],
    },
    {
      relPath: "pkg/diagnostics.py",
      specs: [{
        localName: "emit_diagnostic",
        kind: SymbolKind.Function,
        signature: "emit_diagnostic(node)",
        body: "def emit_diagnostic(node):\n    # render the diagnostic code\n    return 'ERR9931: invalid value'",
      }],
    },
  ]);
  try {
    // Title names CodePrinter; the body emits the distinctive literal ERR9931 the task quotes.
    const r = buildCapsuleV2({
      db,
      repoRoot,
      task: 'CodePrinter renders the wrong diagnostic — output is "ERR9931" instead of the right code',
      intent: CapsuleIntent.Auto,
      maxTokens: 8_000,
    });
    assert.equal(r.pivots[0]!.symbol, "emit_diagnostic", `body-literal match must lead, got ${r.pivots[0]!.symbol}`);
  } finally {
    db.close();
  }
});
