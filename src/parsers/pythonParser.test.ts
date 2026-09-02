import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

import {
  EdgeType,
  Language,
  SymbolKind,
  type SymbolRecord,
} from "../domain/types";
import {
  createPythonParser,
  createParserRegistry,
  pythonParser,
  type ParseFileInput,
} from "./index";

const CORE_FIXTURE_URL = new URL("../../fixtures/python/core_symbols.py", import.meta.url);
const BROKEN_FIXTURE_URL = new URL("../../fixtures/python/broken_syntax.py", import.meta.url);
const DECORATORS_DOCSTRINGS_FIXTURE_URL = new URL(
  "../../fixtures/python/decorators_docstrings/",
  import.meta.url,
);
const IMPORTS_SIMPLE_FIXTURE_URL = new URL("../../fixtures/python/imports_simple/", import.meta.url);
const IMPORTS_RELATIVE_FIXTURE_URL = new URL("../../fixtures/python/imports_relative/", import.meta.url);

test("module-level functions are extracted from the Python fixture", async () => {
  const result = await parseCoreFixture();

  const symbol = findTopLevelSymbol(result.symbols, "my_function", SymbolKind.Function);
  assert.equal(symbol.fqName, "src/pkg/mod.py::my_function");
  assert.equal(symbol.signature, "def my_function(name: str) -> str:");
  assert.equal(symbol.exported, false);
});

test("async module-level functions are extracted from the Python fixture", async () => {
  const result = await parseCoreFixture();

  const symbol = findTopLevelSymbol(result.symbols, "fetch_user", SymbolKind.Function);
  assert.equal(symbol.fqName, "src/pkg/mod.py::fetch_user");
  assert.equal(symbol.signature, "async def fetch_user(user_id: str) -> str:");
});

test("classes are extracted from the Python fixture", async () => {
  const result = await parseCoreFixture();

  const symbol = onlySymbolOfKind(result.symbols, SymbolKind.Class);
  assert.equal(symbol.localName, "SessionManager");
  assert.equal(symbol.fqName, "src/pkg/mod.py::SessionManager");
  assert.equal(symbol.signature, "class SessionManager:");
});

test("methods inside classes are extracted from the Python fixture", async () => {
  const result = await parseCoreFixture();
  const classSymbol = onlySymbolOfKind(result.symbols, SymbolKind.Class);
  const createSession = findMethod(result.symbols, "create_session");
  const refreshSession = findMethod(result.symbols, "refresh_session");

  assert.equal(createSession.fqName, "src/pkg/mod.py::SessionManager.create_session");
  assert.equal(createSession.signature, "def create_session(self, user_id: str) -> str:");
  assert.equal(createSession.parentSymbolId, classSymbol.id);

  assert.equal(refreshSession.fqName, "src/pkg/mod.py::SessionManager.refresh_session");
  assert.equal(refreshSession.signature, "async def refresh_session(self) -> None:");
  assert.equal(refreshSession.parentSymbolId, classSymbol.id);
});

test("class-to-method contains edges are created deterministically", async () => {
  const result = await parseCoreFixture();
  const classSymbol = onlySymbolOfKind(result.symbols, SymbolKind.Class);
  const methods = result.symbols.filter((symbol) => symbol.kind === SymbolKind.Method);

  assert.deepEqual(result.edges, methods.map((method) => ({
    id: result.edges.find((edge) => edge.dstSymbolId === method.id)?.id,
    srcSymbolId: classSymbol.id,
    dstSymbolId: method.id,
    edgeType: EdgeType.Contains,
    confidence: 1,
  })));
  assert.equal(result.edges.every((edge) => edge.id.length === 64), true);
});

test("Python fqNames keep the path-based shared model shape", async () => {
  const result = await parseCoreFixture();

  assert.deepEqual(
    result.symbols.map((symbol) => symbol.fqName),
    [
      "src/pkg/mod.py::<module>",
      "src/pkg/mod.py::my_function",
      "src/pkg/mod.py::fetch_user",
      "src/pkg/mod.py::SessionManager",
      "src/pkg/mod.py::SessionManager.create_session",
      "src/pkg/mod.py::SessionManager.refresh_session",
      "src/pkg/mod.py::outer",
    ],
  );
});

test("repeated parses produce identical Python symbol IDs and ordering", async () => {
  const first = await parseCoreFixture();
  const second = await parseCoreFixture();

  assert.deepEqual(
    first.symbols.map((symbol) => ({
      id: symbol.id,
      fqName: symbol.fqName,
      kind: symbol.kind,
    })),
    second.symbols.map((symbol) => ({
      id: symbol.id,
      fqName: symbol.fqName,
      kind: symbol.kind,
    })),
  );
  assert.deepEqual(first.edges, second.edges);
});

test("the Python parser is reachable through the existing registry", async () => {
  const registry = createParserRegistry([pythonParser]);
  const input = await coreFixtureInput();
  const result = await registry.parse(input);

  assert.equal(registry.getParser(Language.Python), pythonParser);
  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.result.file.language, Language.Python);
    assert.equal(result.result.diagnostics.length, 0);
  }
});

test("invalid Python syntax fails through the existing parser failure path", async () => {
  const registry = createParserRegistry([pythonParser]);
  const result = await registry.parse({
    path: "src/pkg/broken.py",
    language: Language.Python,
    content: await readFile(BROKEN_FIXTURE_URL, "utf8"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "parser_failed");
  assert.match(result.error.message, /^Parser failed: SyntaxError:/);
  assert.equal(result.error.filePath, "src/pkg/broken.py");
  assert.equal(result.error.language, Language.Python);
});

test("import module is detected conservatively when the repo-local target is clear", async () => {
  const fixture = await loadPythonFixture(IMPORTS_SIMPLE_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/import_module_source.py");
  const sourceSymbol = moduleSymbolOf(result.symbols);
  const targetResult = await parseFixtureFile(fixture, "src/pkg/target_module.py");
  const targetSymbol = moduleSymbolOf(targetResult.symbols);

  assert.deepEqual(importEdges(result), [
    {
      id: importEdges(result)[0]?.id,
      srcSymbolId: sourceSymbol.id,
      dstSymbolId: targetSymbol.id,
      edgeType: EdgeType.Imports,
      confidence: 1,
    },
  ]);
});

test("import module as alias is handled conservatively", async () => {
  const fixture = await loadPythonFixture(IMPORTS_SIMPLE_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/import_module_alias_source.py");
  const sourceSymbol = moduleSymbolOf(result.symbols);
  const targetResult = await parseFixtureFile(fixture, "src/pkg/target_module.py");
  const targetSymbol = moduleSymbolOf(targetResult.symbols);

  assert.deepEqual(importEdges(result), [
    {
      id: importEdges(result)[0]?.id,
      srcSymbolId: sourceSymbol.id,
      dstSymbolId: targetSymbol.id,
      edgeType: EdgeType.Imports,
      confidence: 1,
    },
  ]);
});

test("from module import name creates imports edges when target resolution is clear", async () => {
  const fixture = await loadPythonFixture(IMPORTS_SIMPLE_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/from_import_source.py");
  const sourceSymbol = moduleSymbolOf(result.symbols);
  const targetResult = await parseFixtureFile(fixture, "src/pkg/named_target.py");
  const targetSymbol = findTopLevelSymbol(targetResult.symbols, "named_target", SymbolKind.Function);

  assert.deepEqual(importEdges(result), [
    {
      id: importEdges(result)[0]?.id,
      srcSymbolId: sourceSymbol.id,
      dstSymbolId: targetSymbol.id,
      edgeType: EdgeType.Imports,
      confidence: 1,
    },
  ]);
});

test("package __init__.py is resolved conservatively when the imported name is clear", async () => {
  const fixture = await loadPythonFixture(IMPORTS_SIMPLE_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/from_package_source.py");
  const sourceSymbol = moduleSymbolOf(result.symbols);
  const targetResult = await parseFixtureFile(fixture, "src/pkg/__init__.py");
  const targetSymbol = findTopLevelSymbol(targetResult.symbols, "package_api", SymbolKind.Function);

  assert.deepEqual(importEdges(result), [
    {
      id: importEdges(result)[0]?.id,
      srcSymbolId: sourceSymbol.id,
      dstSymbolId: targetSymbol.id,
      edgeType: EdgeType.Imports,
      confidence: 1,
    },
  ]);
});

test("relative imports are resolved conservatively when they are repo-local", async () => {
  const fixture = await loadPythonFixture(IMPORTS_RELATIVE_FIXTURE_URL);

  const samePackageResult = await parseFixtureFile(fixture, "src/app/sub/from_same_package_source.py");
  const samePackageSource = moduleSymbolOf(samePackageResult.symbols);
  const featureResult = await parseFixtureFile(fixture, "src/app/sub/feature.py");
  const featureSymbol = findTopLevelSymbol(featureResult.symbols, "feature_flag", SymbolKind.Function);

  assert.deepEqual(importEdges(samePackageResult), [
    {
      id: importEdges(samePackageResult)[0]?.id,
      srcSymbolId: samePackageSource.id,
      dstSymbolId: featureSymbol.id,
      edgeType: EdgeType.Imports,
      confidence: 1,
    },
  ]);

  const parentPackageResult = await parseFixtureFile(fixture, "src/app/sub/from_parent_package_source.py");
  const parentPackageSource = moduleSymbolOf(parentPackageResult.symbols);
  const helperResult = await parseFixtureFile(fixture, "src/app/shared/helpers.py");
  const helperSymbol = findTopLevelSymbol(helperResult.symbols, "helper", SymbolKind.Function);

  assert.deepEqual(importEdges(parentPackageResult), [
    {
      id: importEdges(parentPackageResult)[0]?.id,
      srcSymbolId: parentPackageSource.id,
      dstSymbolId: helperSymbol.id,
      edgeType: EdgeType.Imports,
      confidence: 1,
    },
  ]);
});

test("third-party imports create no imports edges", async () => {
  const fixture = await loadPythonFixture(IMPORTS_SIMPLE_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/third_party_source.py");

  assert.deepEqual(importEdges(result), []);
});

test("unresolved Python imports do not crash and do not guess", async () => {
  const fixture = await loadPythonFixture(IMPORTS_SIMPLE_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/unresolved_source.py");
  const ambiguousResult = await parseFixtureFile(fixture, "src/pkg/ambiguous_module.py");

  // `from pkg.missing import missing_name` and `from pkg.named_target import
  // missing_name` stay unresolved and yield nothing. `import
  // pkg.ambiguous_module` DOES resolve — to exactly one file — and since M140
  // its edge no longer depends on how many definitions that file happens to
  // contain (it has two, which alone used to suppress the edge).
  assert.deepEqual(importEdges(result), [
    {
      id: importEdges(result)[0]?.id,
      srcSymbolId: moduleSymbolOf(result.symbols).id,
      dstSymbolId: moduleSymbolOf(ambiguousResult.symbols).id,
      edgeType: EdgeType.Imports,
      confidence: 1,
    },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test("repeated parses produce identical Python imports edges and ordering", async () => {
  const fixture = await loadPythonFixture(IMPORTS_SIMPLE_FIXTURE_URL);
  const first = await parseFixtureFile(fixture, "src/pkg/stable_source.py");
  const second = await parseFixtureFile(fixture, "src/pkg/stable_source.py");

  assert.deepEqual(importEdges(first), importEdges(second));
});

test("existing core Python symbol extraction remains unchanged after adding import support", async () => {
  const result = await parseCoreFixture();

  assert.deepEqual(
    result.symbols.map((symbol) => [symbol.localName, symbol.kind]),
    [
      ["<module>", SymbolKind.Module],
      ["my_function", SymbolKind.Function],
      ["fetch_user", SymbolKind.Function],
      ["SessionManager", SymbolKind.Class],
      ["create_session", SymbolKind.Method],
      ["refresh_session", SymbolKind.Method],
      ["outer", SymbolKind.Function],
    ],
  );
  assert.equal(importEdges(result).length, 0);
});

test("function docstrings and decorators are captured deterministically", async () => {
  const fixture = await loadPythonFixture(DECORATORS_DOCSTRINGS_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/decorated.py");
  const symbol = findTopLevelSymbol(result.symbols, "decorated_function", SymbolKind.Function);

  assert.equal(symbol.docstring, "Function docstring.");
  assert.deepEqual(symbol.decorators, ["first", "registry.second", "register(...)"]);
});

test("async function docstrings and decorators are captured deterministically", async () => {
  const fixture = await loadPythonFixture(DECORATORS_DOCSTRINGS_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/decorated.py");
  const symbol = findTopLevelSymbol(result.symbols, "decorated_async", SymbolKind.Function);

  assert.equal(symbol.docstring, "Async function docstring.");
  assert.deepEqual(symbol.decorators, ["async_task"]);
});

test("class docstrings and decorators are captured deterministically", async () => {
  const fixture = await loadPythonFixture(DECORATORS_DOCSTRINGS_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/decorated.py");
  const symbol = findTopLevelSymbol(result.symbols, "DecoratedClass", SymbolKind.Class);

  assert.equal(symbol.docstring, "Class docstring.");
  assert.deepEqual(symbol.decorators, ["entity"]);
});

test("method docstrings are captured for supported Python methods", async () => {
  const fixture = await loadPythonFixture(DECORATORS_DOCSTRINGS_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/decorated.py");

  assert.equal(findMethod(result.symbols, "build").docstring, "Build docstring.");
  assert.equal(findMethod(result.symbols, "version").docstring, "Version docstring.");
  assert.equal(findMethod(result.symbols, "name").docstring, "Name docstring.");
  assert.equal(findMethod(result.symbols, "complex_decorated").docstring, "Complex decorator docstring.");
});

test("classmethod staticmethod and property decorators are captured as metadata", async () => {
  const fixture = await loadPythonFixture(DECORATORS_DOCSTRINGS_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/decorated.py");

  assert.deepEqual(findMethod(result.symbols, "build").decorators, ["classmethod"]);
  assert.deepEqual(findMethod(result.symbols, "version").decorators, ["staticmethod"]);
  assert.deepEqual(findMethod(result.symbols, "name").decorators, ["property"]);
});

test("complex decorator expressions are skipped or reduced conservatively without crashing", async () => {
  const fixture = await loadPythonFixture(DECORATORS_DOCSTRINGS_FIXTURE_URL);
  const result = await parseFixtureFile(fixture, "src/pkg/decorated.py");
  const symbol = findMethod(result.symbols, "complex_decorated");

  assert.deepEqual(symbol.decorators, [
    "registry.decorators[\"selected\"]",
    "unknown(...)",
  ]);
});

test("repeated parses produce identical Python docstring and decorator metadata", async () => {
  const fixture = await loadPythonFixture(DECORATORS_DOCSTRINGS_FIXTURE_URL);
  const first = await parseFixtureFile(fixture, "src/pkg/decorated.py");
  const second = await parseFixtureFile(fixture, "src/pkg/decorated.py");

  assert.deepEqual(
    first.symbols.map((symbol) => ({
      fqName: symbol.fqName,
      docstring: symbol.docstring,
      decorators: symbol.decorators,
    })),
    second.symbols.map((symbol) => ({
      fqName: symbol.fqName,
      docstring: symbol.docstring,
      decorators: symbol.decorators,
    })),
  );
});

test("same-file top-level call is extracted as a conservative calls edge", async () => {
  const files = [
    {
      path: "src/pkg/caller.py",
      content: [
        "def helper(x):",
        "    return x + 1",
        "",
        "def main():",
        "    return helper(1)",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/caller.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  const helperSymbol = findTopLevelSymbol(result.symbols, "helper", SymbolKind.Function);
  const mainSymbol = findTopLevelSymbol(result.symbols, "main", SymbolKind.Function);
  const calls = callsEdges(result);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.srcSymbolId, mainSymbol.id);
  assert.equal(calls[0]?.dstSymbolId, helperSymbol.id);
});

test("from-import callable is resolved to a calls edge when unambiguous", async () => {
  const files = [
    { path: "src/pkg/__init__.py", content: "" },
    { path: "src/pkg/target.py", content: "def do_work(x):\n    return x\n" },
    {
      path: "src/pkg/user.py",
      content: [
        "from .target import do_work",
        "",
        "def entry():",
        "    return do_work(1)",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const userFile = files.find((file) => file.path === "src/pkg/user.py")!;
  const targetFile = files.find((file) => file.path === "src/pkg/target.py")!;
  const userResult = await parser.parse({
    path: userFile.path,
    language: Language.Python,
    content: userFile.content,
  });
  const targetResult = await parser.parse({
    path: targetFile.path,
    language: Language.Python,
    content: targetFile.content,
  });

  const entrySymbol = findTopLevelSymbol(userResult.symbols, "entry", SymbolKind.Function);
  const targetSymbol = findTopLevelSymbol(targetResult.symbols, "do_work", SymbolKind.Function);
  const calls = callsEdges(userResult);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.srcSymbolId, entrySymbol.id);
  assert.equal(calls[0]?.dstSymbolId, targetSymbol.id);
});

test("module-qualified call like mod.fn() resolves to a calls edge when unambiguous", async () => {
  const files = [
    {
      path: "src/pkg/__init__.py",
      content: "",
    },
    {
      path: "src/pkg/target.py",
      content: "def exported_function(x):\n    return x\n",
    },
    {
      path: "src/pkg/driver.py",
      content: [
        "from . import target",
        "",
        "def run():",
        "    return target.exported_function(1)",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const driverFile = files.find((file) => file.path === "src/pkg/driver.py")!;
  const targetFile = files.find((file) => file.path === "src/pkg/target.py")!;
  const driverResult = await parser.parse({
    path: driverFile.path,
    language: Language.Python,
    content: driverFile.content,
  });
  const targetResult = await parser.parse({
    path: targetFile.path,
    language: Language.Python,
    content: targetFile.content,
  });

  const runSymbol = findTopLevelSymbol(driverResult.symbols, "run", SymbolKind.Function);
  const targetSymbol = findTopLevelSymbol(
    targetResult.symbols,
    "exported_function",
    SymbolKind.Function,
  );
  const calls = callsEdges(driverResult);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.srcSymbolId, runSymbol.id);
  assert.equal(calls[0]?.dstSymbolId, targetSymbol.id);
});

test("self.method() resolves to a calls edge to the same class's method when unambiguous", async () => {
  const files = [
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
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/service.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  const classSymbol = findTopLevelSymbol(result.symbols, "Service", SymbolKind.Class);
  const greetMethod = result.symbols.find((symbol) =>
    symbol.parentSymbolId === classSymbol.id && symbol.localName === "greet"
  );
  const formatMethod = result.symbols.find((symbol) =>
    symbol.parentSymbolId === classSymbol.id && symbol.localName === "format_message"
  );
  const calls = callsEdges(result);

  assert.notEqual(greetMethod, undefined);
  assert.notEqual(formatMethod, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.srcSymbolId, greetMethod?.id);
  assert.equal(calls[0]?.dstSymbolId, formatMethod?.id);
});

test("ambiguous call targets are skipped conservatively and do not emit calls edges", async () => {
  const files = [
    {
      path: "src/pkg/ambiguous.py",
      content: [
        "from other import helper",
        "",
        "def helper(x):",
        "    return x",
        "",
        "def main():",
        "    helper(1)",              // local shadows import — skip
        "    unknown_symbol()",       // undefined name — skip
        "    a.b.c()",                // deep attribute chain — skip
        "    obj.method()",           // unknown receiver — skip
        "    return None",
        "",
      ].join("\n"),
    },
    {
      path: "src/pkg/other.py",
      content: "def helper(x):\n    return x\n",
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/ambiguous.py",
    language: Language.Python,
    content: files[0]!.content,
  });
  const calls = callsEdges(result);

  // Local `helper` shadows the imported one — we only resolve to the local definition.
  const localHelper = findTopLevelSymbol(result.symbols, "helper", SymbolKind.Function);
  const mainSymbol = findTopLevelSymbol(result.symbols, "main", SymbolKind.Function);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.srcSymbolId, mainSymbol.id);
  assert.equal(calls[0]?.dstSymbolId, localHelper.id);
});

test("imported-name reference without a call creates a references edge", async () => {
  const files = [
    { path: "src/pkg/__init__.py", content: "" },
    {
      path: "src/pkg/target.py",
      content: "CONSTANT = 1\n\ndef helper():\n    return 1\n",
    },
    {
      path: "src/pkg/user.py",
      content: [
        "from .target import helper",
        "",
        "def entry():",
        "    hook = helper",
        "    return hook",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const userFile = files.find((file) => file.path === "src/pkg/user.py")!;
  const targetFile = files.find((file) => file.path === "src/pkg/target.py")!;
  const userResult = await parser.parse({
    path: userFile.path,
    language: Language.Python,
    content: userFile.content,
  });
  const targetResult = await parser.parse({
    path: targetFile.path,
    language: Language.Python,
    content: targetFile.content,
  });

  const entrySymbol = findTopLevelSymbol(userResult.symbols, "entry", SymbolKind.Function);
  const helperSymbol = findTopLevelSymbol(targetResult.symbols, "helper", SymbolKind.Function);
  const refs = referencesEdges(userResult);

  assert.equal(callsEdges(userResult).length, 0);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.srcSymbolId, entrySymbol.id);
  assert.equal(refs[0]?.dstSymbolId, helperSymbol.id);
});

test("inheritance base class creates a references edge when exact", async () => {
  const files = [
    { path: "src/pkg/__init__.py", content: "" },
    {
      path: "src/pkg/base.py",
      content: "class Base:\n    pass\n",
    },
    {
      path: "src/pkg/sub.py",
      content: [
        "from .base import Base",
        "",
        "class Sub(Base):",
        "    pass",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const subFile = files.find((file) => file.path === "src/pkg/sub.py")!;
  const baseFile = files.find((file) => file.path === "src/pkg/base.py")!;
  const subResult = await parser.parse({
    path: subFile.path,
    language: Language.Python,
    content: subFile.content,
  });
  const baseResult = await parser.parse({
    path: baseFile.path,
    language: Language.Python,
    content: baseFile.content,
  });

  const subSymbol = findTopLevelSymbol(subResult.symbols, "Sub", SymbolKind.Class);
  const baseSymbol = findTopLevelSymbol(baseResult.symbols, "Base", SymbolKind.Class);
  const refs = referencesEdges(subResult);
  const inheritanceRef = refs.find((edge) =>
    edge.srcSymbolId === subSymbol.id && edge.dstSymbolId === baseSymbol.id
  );

  assert.notEqual(inheritanceRef, undefined);
});

test("decorator reference creates a references edge when exact", async () => {
  const files = [
    { path: "src/pkg/__init__.py", content: "" },
    {
      path: "src/pkg/decorators_mod.py",
      content: "def register(fn):\n    return fn\n",
    },
    {
      path: "src/pkg/user.py",
      content: [
        "from .decorators_mod import register",
        "",
        "@register",
        "def decorated():",
        "    return 1",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const userFile = files.find((file) => file.path === "src/pkg/user.py")!;
  const decoratorsFile = files.find((file) => file.path === "src/pkg/decorators_mod.py")!;
  const userResult = await parser.parse({
    path: userFile.path,
    language: Language.Python,
    content: userFile.content,
  });
  const decoratorsResult = await parser.parse({
    path: decoratorsFile.path,
    language: Language.Python,
    content: decoratorsFile.content,
  });

  const decoratedSymbol = findTopLevelSymbol(userResult.symbols, "decorated", SymbolKind.Function);
  const registerSymbol = findTopLevelSymbol(
    decoratorsResult.symbols,
    "register",
    SymbolKind.Function,
  );
  const refs = referencesEdges(userResult);
  const decoratorRef = refs.find((edge) =>
    edge.srcSymbolId === decoratedSymbol.id && edge.dstSymbolId === registerSymbol.id
  );

  assert.notEqual(decoratorRef, undefined);
});

test("annotation reference creates a references edge when exact", async () => {
  const files = [
    { path: "src/pkg/__init__.py", content: "" },
    {
      path: "src/pkg/model.py",
      content: "class User:\n    pass\n",
    },
    {
      path: "src/pkg/consumer.py",
      content: [
        "from .model import User",
        "",
        "def load(user: User) -> User:",
        "    return user",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const consumerFile = files.find((file) => file.path === "src/pkg/consumer.py")!;
  const modelFile = files.find((file) => file.path === "src/pkg/model.py")!;
  const consumerResult = await parser.parse({
    path: consumerFile.path,
    language: Language.Python,
    content: consumerFile.content,
  });
  const modelResult = await parser.parse({
    path: modelFile.path,
    language: Language.Python,
    content: modelFile.content,
  });

  const loadSymbol = findTopLevelSymbol(consumerResult.symbols, "load", SymbolKind.Function);
  const userSymbol = findTopLevelSymbol(modelResult.symbols, "User", SymbolKind.Class);
  const refs = referencesEdges(consumerResult);
  const annotationRef = refs.find((edge) =>
    edge.srcSymbolId === loadSymbol.id && edge.dstSymbolId === userSymbol.id
  );

  assert.notEqual(annotationRef, undefined);
});

test("exception class references in except and bare raise create references edges", async () => {
  const files = [
    { path: "src/pkg/__init__.py", content: "" },
    {
      path: "src/pkg/errors.py",
      content: "class MyError(Exception):\n    pass\n",
    },
    {
      path: "src/pkg/consumer.py",
      content: [
        "from .errors import MyError",
        "",
        "def reraise_it(cached):",
        "    raise cached or MyError",
        "",
        "def catch_it():",
        "    try:",
        "        pass",
        "    except MyError:",
        "        pass",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const consumerFile = files.find((file) => file.path === "src/pkg/consumer.py")!;
  const errorsFile = files.find((file) => file.path === "src/pkg/errors.py")!;
  const consumerResult = await parser.parse({
    path: consumerFile.path,
    language: Language.Python,
    content: consumerFile.content,
  });
  const errorsResult = await parser.parse({
    path: errorsFile.path,
    language: Language.Python,
    content: errorsFile.content,
  });

  const reraiseSymbol = findTopLevelSymbol(
    consumerResult.symbols,
    "reraise_it",
    SymbolKind.Function,
  );
  const catchSymbol = findTopLevelSymbol(consumerResult.symbols, "catch_it", SymbolKind.Function);
  const errorSymbol = findTopLevelSymbol(errorsResult.symbols, "MyError", SymbolKind.Class);
  const refs = referencesEdges(consumerResult);
  const reraiseEdge = refs.find((edge) =>
    edge.srcSymbolId === reraiseSymbol.id && edge.dstSymbolId === errorSymbol.id
  );
  const catchEdge = refs.find((edge) =>
    edge.srcSymbolId === catchSymbol.id && edge.dstSymbolId === errorSymbol.id
  );

  assert.notEqual(reraiseEdge, undefined);
  assert.notEqual(catchEdge, undefined);
});

test("alias assignment creates a references edge when exact", async () => {
  const files = [
    { path: "src/pkg/__init__.py", content: "" },
    {
      path: "src/pkg/target.py",
      content: "def helper():\n    return 1\n",
    },
    {
      path: "src/pkg/aliaser.py",
      content: [
        "from .target import helper",
        "",
        "def bind():",
        "    aliased = helper",
        "    return aliased",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const aliaserFile = files.find((file) => file.path === "src/pkg/aliaser.py")!;
  const targetFile = files.find((file) => file.path === "src/pkg/target.py")!;
  const aliaserResult = await parser.parse({
    path: aliaserFile.path,
    language: Language.Python,
    content: aliaserFile.content,
  });
  const targetResult = await parser.parse({
    path: targetFile.path,
    language: Language.Python,
    content: targetFile.content,
  });

  const bindSymbol = findTopLevelSymbol(aliaserResult.symbols, "bind", SymbolKind.Function);
  const helperSymbol = findTopLevelSymbol(targetResult.symbols, "helper", SymbolKind.Function);
  const refs = referencesEdges(aliaserResult);
  const aliasRef = refs.find((edge) =>
    edge.srcSymbolId === bindSymbol.id && edge.dstSymbolId === helperSymbol.id
  );

  assert.notEqual(aliasRef, undefined);
});

test("ambiguous reference targets are skipped conservatively", async () => {
  const files = [
    { path: "src/pkg/__init__.py", content: "" },
    {
      path: "src/pkg/a.py",
      content: "class Thing:\n    pass\n",
    },
    {
      path: "src/pkg/b.py",
      content: "class Thing:\n    pass\n",
    },
    {
      path: "src/pkg/user.py",
      content: [
        "from pkg.a import Thing as ThingA",
        "from pkg.b import Thing as ThingB",
        "",
        "def use():",
        "    local = ThingA",
        "    other = ThingB",
        "    raise LookupError('boom')",  // unresolvable builtin
        "    obj.some.deep.attr",         // deep chain — skip
        "    unknown_name",               // undefined — skip
        "    return local, other",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const userFile = files.find((file) => file.path === "src/pkg/user.py")!;
  const userResult = await parser.parse({
    path: userFile.path,
    language: Language.Python,
    content: userFile.content,
  });
  const refs = referencesEdges(userResult);

  // We cannot index builtins (LookupError), deep chains, or unknown names, so they must not produce edges.
  // ThingA and ThingB resolve unambiguously via aliased imports; they should produce references.
  const targets = new Set(refs.map((edge) => edge.dstSymbolId));
  assert.equal(targets.size, 2);
});

test("function-local shadowing prevents guessed references to top-level names", async () => {
  const files = [
    {
      path: "src/pkg/shadowed.py",
      content: [
        "VALUE = 1",
        "OTHER = 2",
        "",
        "def parameter_shadow(VALUE):",
        "    return VALUE",
        "",
        "def assignment_shadow():",
        "    OTHER = 3",
        "    return OTHER",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/shadowed.py",
    language: Language.Python,
    content: files[0]!.content,
  });
  const valueSymbol = result.symbols.find((symbol) => symbol.localName === "VALUE");
  const otherSymbol = result.symbols.find((symbol) => symbol.localName === "OTHER");
  const parameterShadow = findTopLevelSymbol(
    result.symbols,
    "parameter_shadow",
    SymbolKind.Function,
  );
  const assignmentShadow = findTopLevelSymbol(
    result.symbols,
    "assignment_shadow",
    SymbolKind.Function,
  );
  const refs = referencesEdges(result);

  assert.equal(
    refs.some((edge) =>
      edge.srcSymbolId === parameterShadow.id && edge.dstSymbolId === valueSymbol?.id
    ),
    false,
    "parameter-local VALUE must not reference the module-level VALUE",
  );
  assert.equal(
    refs.some((edge) =>
      edge.srcSymbolId === assignmentShadow.id && edge.dstSymbolId === otherSymbol?.id
    ),
    false,
    "assigned local OTHER must not reference the module-level OTHER",
  );
});

test("references do not duplicate an already-emitted calls edge", async () => {
  const files = [
    { path: "src/pkg/__init__.py", content: "" },
    {
      path: "src/pkg/target.py",
      content: "def do_work(x):\n    return x\n",
    },
    {
      path: "src/pkg/user.py",
      content: [
        "from .target import do_work",
        "",
        "def entry():",
        "    return do_work(1)",  // call — should produce a calls edge, not a references edge
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const userFile = files.find((file) => file.path === "src/pkg/user.py")!;
  const userResult = await parser.parse({
    path: userFile.path,
    language: Language.Python,
    content: userFile.content,
  });

  assert.equal(callsEdges(userResult).length, 1);
  assert.equal(referencesEdges(userResult).length, 0);
});

test("top-level simple assignments are indexed as module-level constants or variables", async () => {
  const files = [
    {
      path: "src/pkg/settings.py",
      content: [
        "DEFAULT_BACKEND = 'orca'",
        "max_retries = 3",
        "",
        "def compute():",
        "    local_only = 1",  // local variable must not be indexed
        "    return local_only",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/settings.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  const constSymbol = result.symbols.find((symbol) => symbol.localName === "DEFAULT_BACKEND");
  const varSymbol = result.symbols.find((symbol) => symbol.localName === "max_retries");
  const localSymbol = result.symbols.find((symbol) => symbol.localName === "local_only");

  assert.notEqual(constSymbol, undefined);
  assert.equal(constSymbol?.kind, SymbolKind.ModuleConstant);
  assert.equal(constSymbol?.fqName, "src/pkg/settings.py::DEFAULT_BACKEND");
  assert.equal(constSymbol?.parentSymbolId, undefined);

  assert.notEqual(varSymbol, undefined);
  assert.equal(varSymbol?.kind, SymbolKind.ModuleVariable);
  assert.equal(varSymbol?.fqName, "src/pkg/settings.py::max_retries");

  assert.equal(localSymbol, undefined, "local variables must not be indexed as module-level symbols");
});

test("top-level annotated assignments are indexed as module-level symbols", async () => {
  const files = [
    {
      path: "src/pkg/config.py",
      content: [
        "DEFAULT_LEVEL: int = 3",
        "LABEL: str",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/config.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  const leveled = result.symbols.find((symbol) => symbol.localName === "DEFAULT_LEVEL");
  const label = result.symbols.find((symbol) => symbol.localName === "LABEL");

  assert.notEqual(leveled, undefined);
  assert.equal(leveled?.kind, SymbolKind.ModuleConstant);
  assert.notEqual(label, undefined);
  assert.equal(label?.kind, SymbolKind.ModuleConstant);
});

test("top-level alias assignment is indexed as a module-level alias", async () => {
  const files = [
    { path: "src/pkg/__init__.py", content: "" },
    {
      path: "src/pkg/base.py",
      content: "class BaseClass:\n    pass\n",
    },
    {
      path: "src/pkg/aliaser.py",
      content: [
        "from .base import BaseClass",
        "",
        "MyAlias = BaseClass",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const aliaserFile = files.find((file) => file.path === "src/pkg/aliaser.py")!;
  const baseFile = files.find((file) => file.path === "src/pkg/base.py")!;
  const aliaserResult = await parser.parse({
    path: aliaserFile.path,
    language: Language.Python,
    content: aliaserFile.content,
  });
  const baseResult = await parser.parse({
    path: baseFile.path,
    language: Language.Python,
    content: baseFile.content,
  });

  const aliasSymbol = aliaserResult.symbols.find((symbol) => symbol.localName === "MyAlias");
  const baseSymbol = findTopLevelSymbol(baseResult.symbols, "BaseClass", SymbolKind.Class);

  assert.notEqual(aliasSymbol, undefined);
  assert.equal(aliasSymbol?.kind, SymbolKind.ModuleAlias);
  assert.equal(aliasSymbol?.fqName, "src/pkg/aliaser.py::MyAlias");

  const refs = referencesEdges(aliaserResult);
  const aliasRef = refs.find((edge) =>
    edge.srcSymbolId === aliasSymbol?.id && edge.dstSymbolId === baseSymbol.id
  );

  assert.notEqual(aliasRef, undefined, "module-level alias should emit a references edge to its target");
});

test("from-import of a module-level constant resolves to an imports edge", async () => {
  const files = [
    { path: "src/pkg/__init__.py", content: "" },
    {
      path: "src/pkg/settings.py",
      content: "DEFAULT_BACKEND = 'orca'\n",
    },
    {
      path: "src/pkg/user.py",
      content: [
        "from .settings import DEFAULT_BACKEND",
        "",
        "def current_backend():",
        "    return DEFAULT_BACKEND",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const userFile = files.find((file) => file.path === "src/pkg/user.py")!;
  const settingsFile = files.find((file) => file.path === "src/pkg/settings.py")!;
  const userResult = await parser.parse({
    path: userFile.path,
    language: Language.Python,
    content: userFile.content,
  });
  const settingsResult = await parser.parse({
    path: settingsFile.path,
    language: Language.Python,
    content: settingsFile.content,
  });

  const constSymbol = settingsResult.symbols.find(
    (symbol) => symbol.localName === "DEFAULT_BACKEND",
  );
  const currentSymbol = findTopLevelSymbol(
    userResult.symbols,
    "current_backend",
    SymbolKind.Function,
  );

  assert.notEqual(constSymbol, undefined);

  const imports = importEdges(userResult);
  const importToConst = imports.find((edge) => edge.dstSymbolId === constSymbol?.id);

  assert.notEqual(importToConst, undefined, "imports edge must target the module-level constant");

  const refs = referencesEdges(userResult);
  const refToConst = refs.find((edge) =>
    edge.srcSymbolId === currentSymbol.id && edge.dstSymbolId === constSymbol?.id
  );

  assert.notEqual(refToConst, undefined, "reference from function body must target the constant");
});

test("module-qualified reference resolves to a module-level constant", async () => {
  const files = [
    { path: "src/pkg/__init__.py", content: "" },
    {
      path: "src/pkg/settings.py",
      content: "TIMEOUT = 30\n",
    },
    {
      path: "src/pkg/driver.py",
      content: [
        "from . import settings",
        "",
        "def run():",
        "    return settings.TIMEOUT",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const driverFile = files.find((file) => file.path === "src/pkg/driver.py")!;
  const settingsFile = files.find((file) => file.path === "src/pkg/settings.py")!;
  const driverResult = await parser.parse({
    path: driverFile.path,
    language: Language.Python,
    content: driverFile.content,
  });
  const settingsResult = await parser.parse({
    path: settingsFile.path,
    language: Language.Python,
    content: settingsFile.content,
  });

  const runSymbol = findTopLevelSymbol(driverResult.symbols, "run", SymbolKind.Function);
  const timeoutSymbol = settingsResult.symbols.find((symbol) => symbol.localName === "TIMEOUT");

  assert.notEqual(timeoutSymbol, undefined);

  const refs = referencesEdges(driverResult);
  const moduleQualifiedRef = refs.find((edge) =>
    edge.srcSymbolId === runSymbol.id && edge.dstSymbolId === timeoutSymbol?.id
  );

  assert.notEqual(moduleQualifiedRef, undefined);
});

test("ambiguous top-level assignments (tuple unpacking, augmented) are not indexed", async () => {
  const files = [
    {
      path: "src/pkg/ambiguous.py",
      content: [
        "A, B = 1, 2",     // tuple unpacking — deferred
        "C = 5",
        "C += 1",          // augmented assignment is not an ast.Assign
        "items[0] = 9",    // subscript target — skipped
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/ambiguous.py",
    language: Language.Python,
    content: files[0]!.content,
  });
  const names = result.symbols.map((symbol) => symbol.localName).sort();

  assert.deepEqual(names, ["<module>", "C"]);
});

test("function/class indexing still works when module-level symbols are also present", async () => {
  const files = [
    {
      path: "src/pkg/module.py",
      content: [
        "VERSION = '1.0'",
        "",
        "def hello():",
        "    return VERSION",
        "",
        "class Greeter:",
        "    def greet(self):",
        "        return hello()",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/module.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  const version = result.symbols.find((symbol) => symbol.localName === "VERSION");
  const hello = findTopLevelSymbol(result.symbols, "hello", SymbolKind.Function);
  const greeter = findTopLevelSymbol(result.symbols, "Greeter", SymbolKind.Class);
  const greet = result.symbols.find((symbol) =>
    symbol.parentSymbolId === greeter.id && symbol.localName === "greet"
  );

  assert.equal(version?.kind, SymbolKind.ModuleConstant);
  assert.notEqual(hello, undefined);
  assert.notEqual(greet, undefined);
  // calls edge: Greeter.greet -> hello (preserves pre-existing calls behavior)
  const calls = callsEdges(result);
  assert.ok(
    calls.some((edge) => edge.srcSymbolId === greet?.id && edge.dstSymbolId === hello.id),
    "same-file call resolution must still work when module-level symbols coexist",
  );
  // references edge: hello -> VERSION (function body referencing a module-level constant)
  const refs = referencesEdges(result);
  assert.ok(
    refs.some((edge) => edge.srcSymbolId === hello.id && edge.dstSymbolId === version?.id),
    "function body reference must resolve to a same-file module-level constant",
  );
});

test("duplicate top-level names collapse into no calls edge (conservative)", async () => {
  // Duplicate def foo ... def foo — top-level name becomes ambiguous, so a call is skipped.
  const files = [
    {
      path: "src/pkg/dup.py",
      content: [
        "def foo():",
        "    return 1",
        "",
        "def foo():",
        "    return 2",
        "",
        "def main():",
        "    return foo()",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/dup.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  assert.equal(callsEdges(result).length, 0);
});

test("self.attr resolves to a references edge targeting a class-level attribute", async () => {
  const files = [
    {
      path: "src/pkg/service.py",
      content: [
        "class Service:",
        "    RETRIES = 3",
        "",
        "    def run(self):",
        "        return self.RETRIES",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/service.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  const classSymbol = findTopLevelSymbol(result.symbols, "Service", SymbolKind.Class);
  const retries = result.symbols.find((symbol) =>
    symbol.parentSymbolId === classSymbol.id && symbol.localName === "RETRIES"
  );
  const run = result.symbols.find((symbol) =>
    symbol.parentSymbolId === classSymbol.id && symbol.localName === "run"
  );

  assert.notEqual(retries, undefined);
  assert.equal(retries?.kind, SymbolKind.ModuleConstant);
  assert.equal(retries?.fqName, "src/pkg/service.py::Service.RETRIES");

  const refs = referencesEdges(result);
  const refToRetries = refs.find((edge) =>
    edge.srcSymbolId === run?.id && edge.dstSymbolId === retries?.id
  );
  assert.notEqual(refToRetries, undefined, "self.RETRIES should emit a references edge");
});

test("cls.method() resolves to a calls edge targeting the same class's method", async () => {
  const files = [
    {
      path: "src/pkg/factory.py",
      content: [
        "class Factory:",
        "    @classmethod",
        "    def create(cls):",
        "        return cls.build()",
        "",
        "    @classmethod",
        "    def build(cls):",
        "        return 'built'",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/factory.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  const classSymbol = findTopLevelSymbol(result.symbols, "Factory", SymbolKind.Class);
  const create = result.symbols.find((symbol) =>
    symbol.parentSymbolId === classSymbol.id && symbol.localName === "create"
  );
  const build = result.symbols.find((symbol) =>
    symbol.parentSymbolId === classSymbol.id && symbol.localName === "build"
  );
  const calls = callsEdges(result);
  const edge = calls.find((candidate) =>
    candidate.srcSymbolId === create?.id && candidate.dstSymbolId === build?.id
  );

  assert.notEqual(edge, undefined);
});

test("cls.CONSTANT resolves to a references edge targeting a class-level constant", async () => {
  const files = [
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
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/factory.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  const classSymbol = findTopLevelSymbol(result.symbols, "Factory", SymbolKind.Class);
  const defaultConst = result.symbols.find((symbol) =>
    symbol.parentSymbolId === classSymbol.id && symbol.localName === "DEFAULT"
  );
  const current = result.symbols.find((symbol) =>
    symbol.parentSymbolId === classSymbol.id && symbol.localName === "current"
  );

  assert.equal(defaultConst?.kind, SymbolKind.ModuleConstant);
  const refs = referencesEdges(result);
  const edge = refs.find((candidate) =>
    candidate.srcSymbolId === current?.id && candidate.dstSymbolId === defaultConst?.id
  );

  assert.notEqual(edge, undefined);
});

test("ClassName.method() resolves to a calls edge when ClassName is a same-file class", async () => {
  const files = [
    {
      path: "src/pkg/caller.py",
      content: [
        "class Service:",
        "    @staticmethod",
        "    def build():",
        "        return 'built'",
        "",
        "def entry():",
        "    return Service.build()",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/caller.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  const classSymbol = findTopLevelSymbol(result.symbols, "Service", SymbolKind.Class);
  const build = result.symbols.find((symbol) =>
    symbol.parentSymbolId === classSymbol.id && symbol.localName === "build"
  );
  const entry = findTopLevelSymbol(result.symbols, "entry", SymbolKind.Function);
  const calls = callsEdges(result);
  const edge = calls.find((candidate) =>
    candidate.srcSymbolId === entry.id && candidate.dstSymbolId === build?.id
  );

  assert.notEqual(edge, undefined);
});

test("ClassName.CONSTANT resolves to a references edge via an imported class", async () => {
  const files = [
    { path: "src/pkg/__init__.py", content: "" },
    {
      path: "src/pkg/config.py",
      content: [
        "class Config:",
        "    TIMEOUT = 30",
        "",
      ].join("\n"),
    },
    {
      path: "src/pkg/consumer.py",
      content: [
        "from .config import Config",
        "",
        "def read_timeout():",
        "    return Config.TIMEOUT",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const configFile = files.find((file) => file.path === "src/pkg/config.py")!;
  const consumerFile = files.find((file) => file.path === "src/pkg/consumer.py")!;
  const configResult = await parser.parse({
    path: configFile.path,
    language: Language.Python,
    content: configFile.content,
  });
  const consumerResult = await parser.parse({
    path: consumerFile.path,
    language: Language.Python,
    content: consumerFile.content,
  });

  const configClass = findTopLevelSymbol(configResult.symbols, "Config", SymbolKind.Class);
  const timeout = configResult.symbols.find((symbol) =>
    symbol.parentSymbolId === configClass.id && symbol.localName === "TIMEOUT"
  );
  const readTimeout = findTopLevelSymbol(consumerResult.symbols, "read_timeout", SymbolKind.Function);
  const refs = referencesEdges(consumerResult);
  const edge = refs.find((candidate) =>
    candidate.srcSymbolId === readTimeout.id && candidate.dstSymbolId === timeout?.id
  );

  assert.notEqual(edge, undefined, "Config.TIMEOUT should emit a references edge to the imported class's attribute");
});

test("ClassName.method() resolves to a calls edge via an imported class", async () => {
  const files = [
    { path: "src/pkg/__init__.py", content: "" },
    {
      path: "src/pkg/factory.py",
      content: [
        "class Factory:",
        "    @staticmethod",
        "    def make():",
        "        return 'made'",
        "",
      ].join("\n"),
    },
    {
      path: "src/pkg/consumer.py",
      content: [
        "from .factory import Factory",
        "",
        "def entry():",
        "    return Factory.make()",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const factoryFile = files.find((file) => file.path === "src/pkg/factory.py")!;
  const consumerFile = files.find((file) => file.path === "src/pkg/consumer.py")!;
  const factoryResult = await parser.parse({
    path: factoryFile.path,
    language: Language.Python,
    content: factoryFile.content,
  });
  const consumerResult = await parser.parse({
    path: consumerFile.path,
    language: Language.Python,
    content: consumerFile.content,
  });

  const factoryClass = findTopLevelSymbol(factoryResult.symbols, "Factory", SymbolKind.Class);
  const make = factoryResult.symbols.find((symbol) =>
    symbol.parentSymbolId === factoryClass.id && symbol.localName === "make"
  );
  const entry = findTopLevelSymbol(consumerResult.symbols, "entry", SymbolKind.Function);
  const calls = callsEdges(consumerResult);
  const edge = calls.find((candidate) =>
    candidate.srcSymbolId === entry.id && candidate.dstSymbolId === make?.id
  );

  assert.notEqual(edge, undefined);
});

test("local shadowing prevents guessed ClassName.method calls", async () => {
  const files = [
    {
      path: "src/pkg/shadow_class_call.py",
      content: [
        "class Job:",
        "    @staticmethod",
        "    def build():",
        "        return 'built'",
        "",
        "def make(Job):",
        "    return Job.build()",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/shadow_class_call.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  assert.equal(callsEdges(result).length, 0);
  assert.equal(referencesEdges(result).length, 0);
});

test("ambiguous attribute receivers are skipped conservatively", async () => {
  const files = [
    {
      path: "src/pkg/ambiguous.py",
      content: [
        "class Service:",
        "    def run(whatever):",
        // first param is not "self", so self.x should not be resolved
        "        return whatever.unknown_attr",
        "",
        "    @staticmethod",
        "    def static_method():",
        // static method: no self/cls receiver; self.foo shouldn't resolve
        "        self.foo",
        "        return None",
        "",
        "def floating():",
        // arbitrary obj.x outside a class — no resolution should be attempted
        "    return some_obj.anything",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/ambiguous.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  // No self./cls. resolution succeeds because: (a) "whatever" isn't "self"; (b) static
  // method has no self; (c) floating() uses an arbitrary receiver. Also, the referenced
  // attributes don't exist, so even if they were attempted they couldn't resolve.
  const refs = referencesEdges(result);
  const calls = callsEdges(result);

  assert.equal(calls.length, 0);
  assert.equal(
    refs.length,
    0,
    "ambiguous attribute receivers must not produce references edges",
  );
});

test("self.x does not resolve when the method's first parameter is not self", async () => {
  const files = [
    {
      path: "src/pkg/odd.py",
      content: [
        "class Service:",
        "    value = 1",
        "",
        "    def work(this):",       // first arg renamed — not "self"
        "        return this.value", // `this` is not a known receiver → skip
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/odd.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  assert.equal(referencesEdges(result).length, 0);
  assert.equal(callsEdges(result).length, 0);
});

test("cls.x does not resolve when the method's first parameter is self", async () => {
  const files = [
    {
      path: "src/pkg/mix.py",
      content: [
        "class Thing:",
        "    TAG = 't'",
        "",
        "    def describe(self):",
        "        return cls.TAG",  // `cls` is not the method's first parameter
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/mix.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  // cls.TAG should not resolve — conservative
  assert.equal(referencesEdges(result).length, 0);
});

test("calling a class-level attribute does not emit a calls edge", async () => {
  const files = [
    {
      path: "src/pkg/thing.py",
      content: [
        "class Thing:",
        "    handler = None",
        "",
        "    def fire(self):",
        "        return self.handler()",  // attribute, not method
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/thing.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  // self.handler is an attribute, not a method — call-target resolution gates on method kind.
  // The usage IS a call, so the attribute node is excluded from the reference sweep, and the
  // call is skipped because the target kind is not a method. No edge is truthful here.
  assert.equal(callsEdges(result).length, 0);
  assert.equal(referencesEdges(result).length, 0);
});

test("super().method() resolves to a calls edge targeting a direct base class method", async () => {
  const files = [
    {
      path: "src/pkg/base.py",
      content: [
        "class Base:",
        "    def handle(self):",
        "        return 'base'",
        "",
      ].join("\n"),
    },
    {
      path: "src/pkg/sub.py",
      content: [
        "from .base import Base",
        "",
        "class Sub(Base):",
        "    def handle(self):",
        "        return super().handle()",
        "",
      ].join("\n"),
    },
    { path: "src/pkg/__init__.py", content: "" },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const baseFile = files.find((file) => file.path === "src/pkg/base.py")!;
  const subFile = files.find((file) => file.path === "src/pkg/sub.py")!;
  const baseResult = await parser.parse({
    path: baseFile.path,
    language: Language.Python,
    content: baseFile.content,
  });
  const subResult = await parser.parse({
    path: subFile.path,
    language: Language.Python,
    content: subFile.content,
  });

  const baseClass = findTopLevelSymbol(baseResult.symbols, "Base", SymbolKind.Class);
  const baseHandle = baseResult.symbols.find((symbol) =>
    symbol.parentSymbolId === baseClass.id && symbol.localName === "handle"
  );
  const subClass = findTopLevelSymbol(subResult.symbols, "Sub", SymbolKind.Class);
  const subHandle = subResult.symbols.find((symbol) =>
    symbol.parentSymbolId === subClass.id && symbol.localName === "handle"
  );

  const calls = callsEdges(subResult);
  const edge = calls.find((candidate) =>
    candidate.srcSymbolId === subHandle?.id && candidate.dstSymbolId === baseHandle?.id
  );

  assert.notEqual(edge, undefined, "super().handle() in Sub must emit a calls edge to Base.handle");
});

test("super().CONST resolves to a references edge targeting a base-class class attribute", async () => {
  const files = [
    {
      path: "src/pkg/inh.py",
      content: [
        "class Base:",
        "    DEFAULT = 'orca'",
        "",
        "class Sub(Base):",
        "    def value(self):",
        "        return super().DEFAULT",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/inh.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  const baseClass = findTopLevelSymbol(result.symbols, "Base", SymbolKind.Class);
  const defaultConst = result.symbols.find((symbol) =>
    symbol.parentSymbolId === baseClass.id && symbol.localName === "DEFAULT"
  );
  const subClass = findTopLevelSymbol(result.symbols, "Sub", SymbolKind.Class);
  const value = result.symbols.find((symbol) =>
    symbol.parentSymbolId === subClass.id && symbol.localName === "value"
  );

  const refs = referencesEdges(result);
  const edge = refs.find((candidate) =>
    candidate.srcSymbolId === value?.id && candidate.dstSymbolId === defaultConst?.id
  );

  assert.notEqual(edge, undefined, "super().DEFAULT must emit a references edge to Base.DEFAULT");
});

test("super().attr resolves to a references edge targeting a base-class attribute", async () => {
  const files = [
    {
      path: "src/pkg/inh2.py",
      content: [
        "class Base:",
        "    handler = None",
        "",
        "class Sub(Base):",
        "    def read(self):",
        "        return super().handler",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/inh2.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  const baseClass = findTopLevelSymbol(result.symbols, "Base", SymbolKind.Class);
  const handler = result.symbols.find((symbol) =>
    symbol.parentSymbolId === baseClass.id && symbol.localName === "handler"
  );
  const subClass = findTopLevelSymbol(result.symbols, "Sub", SymbolKind.Class);
  const read = result.symbols.find((symbol) =>
    symbol.parentSymbolId === subClass.id && symbol.localName === "read"
  );

  const refs = referencesEdges(result);
  const edge = refs.find((candidate) =>
    candidate.srcSymbolId === read?.id && candidate.dstSymbolId === handler?.id
  );

  assert.notEqual(edge, undefined);
});

test("self.method() falls back to an inherited method on a direct base", async () => {
  const files = [
    {
      path: "src/pkg/inh_self.py",
      content: [
        "class Base:",
        "    def shared(self):",
        "        return 'shared'",
        "",
        "class Sub(Base):",
        "    def use(self):",
        "        return self.shared()",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/inh_self.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  const baseClass = findTopLevelSymbol(result.symbols, "Base", SymbolKind.Class);
  const shared = result.symbols.find((symbol) =>
    symbol.parentSymbolId === baseClass.id && symbol.localName === "shared"
  );
  const subClass = findTopLevelSymbol(result.symbols, "Sub", SymbolKind.Class);
  const use = result.symbols.find((symbol) =>
    symbol.parentSymbolId === subClass.id && symbol.localName === "use"
  );

  const calls = callsEdges(result);
  const edge = calls.find((candidate) =>
    candidate.srcSymbolId === use?.id && candidate.dstSymbolId === shared?.id
  );

  assert.notEqual(edge, undefined, "self.shared() must fall back to Base.shared via inheritance");
});

test("cls.CONST falls back to an inherited class constant on a direct base", async () => {
  const files = [
    {
      path: "src/pkg/inh_cls.py",
      content: [
        "class Base:",
        "    DEFAULT = 'orca'",
        "",
        "class Sub(Base):",
        "    @classmethod",
        "    def current(cls):",
        "        return cls.DEFAULT",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/inh_cls.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  const baseClass = findTopLevelSymbol(result.symbols, "Base", SymbolKind.Class);
  const defaultConst = result.symbols.find((symbol) =>
    symbol.parentSymbolId === baseClass.id && symbol.localName === "DEFAULT"
  );
  const subClass = findTopLevelSymbol(result.symbols, "Sub", SymbolKind.Class);
  const current = result.symbols.find((symbol) =>
    symbol.parentSymbolId === subClass.id && symbol.localName === "current"
  );

  const refs = referencesEdges(result);
  const edge = refs.find((candidate) =>
    candidate.srcSymbolId === current?.id && candidate.dstSymbolId === defaultConst?.id
  );

  assert.notEqual(edge, undefined);
});

test("ClassName.CONST falls back to an inherited class constant on a direct base", async () => {
  const files = [
    {
      path: "src/pkg/inh_qual.py",
      content: [
        "class Base:",
        "    DEFAULT = 'orca'",
        "",
        "class Sub(Base):",
        "    pass",
        "",
        "def read_default():",
        "    return Sub.DEFAULT",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/inh_qual.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  const baseClass = findTopLevelSymbol(result.symbols, "Base", SymbolKind.Class);
  const defaultConst = result.symbols.find((symbol) =>
    symbol.parentSymbolId === baseClass.id && symbol.localName === "DEFAULT"
  );
  const readDefault = findTopLevelSymbol(result.symbols, "read_default", SymbolKind.Function);

  const refs = referencesEdges(result);
  const edge = refs.find((candidate) =>
    candidate.srcSymbolId === readDefault.id && candidate.dstSymbolId === defaultConst?.id
  );

  assert.notEqual(edge, undefined, "Sub.DEFAULT must fall back to Base.DEFAULT via inheritance");
});

test("ClassName.method() falls back to an inherited method on a direct base", async () => {
  const files = [
    {
      path: "src/pkg/inh_qual_call.py",
      content: [
        "class Base:",
        "    @staticmethod",
        "    def build():",
        "        return 'built'",
        "",
        "class Sub(Base):",
        "    pass",
        "",
        "def make():",
        "    return Sub.build()",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/inh_qual_call.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  const baseClass = findTopLevelSymbol(result.symbols, "Base", SymbolKind.Class);
  const build = result.symbols.find((symbol) =>
    symbol.parentSymbolId === baseClass.id && symbol.localName === "build"
  );
  const make = findTopLevelSymbol(result.symbols, "make", SymbolKind.Function);

  const calls = callsEdges(result);
  const edge = calls.find((candidate) =>
    candidate.srcSymbolId === make.id && candidate.dstSymbolId === build?.id
  );

  assert.notEqual(edge, undefined, "Sub.build() must fall back to Base.build via inheritance");
});

test("ambiguous multi-base inherited members are skipped conservatively", async () => {
  const files = [
    {
      path: "src/pkg/inh_amb.py",
      content: [
        "class A:",
        "    def shared(self):",
        "        return 'a'",
        "",
        "class B:",
        "    def shared(self):",
        "        return 'b'",
        "",
        "class Sub(A, B):",
        "    def use(self):",
        "        return self.shared()",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/inh_amb.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  const a = findTopLevelSymbol(result.symbols, "A", SymbolKind.Class);
  const b = findTopLevelSymbol(result.symbols, "B", SymbolKind.Class);
  const sharedA = result.symbols.find((symbol) =>
    symbol.parentSymbolId === a.id && symbol.localName === "shared"
  );
  const sharedB = result.symbols.find((symbol) =>
    symbol.parentSymbolId === b.id && symbol.localName === "shared"
  );
  const subClass = findTopLevelSymbol(result.symbols, "Sub", SymbolKind.Class);
  const use = result.symbols.find((symbol) =>
    symbol.parentSymbolId === subClass.id && symbol.localName === "use"
  );

  const calls = callsEdges(result);
  const hitsA = calls.some((candidate) =>
    candidate.srcSymbolId === use?.id && candidate.dstSymbolId === sharedA?.id
  );
  const hitsB = calls.some((candidate) =>
    candidate.srcSymbolId === use?.id && candidate.dstSymbolId === sharedB?.id
  );

  assert.equal(hitsA, false, "ambiguous inherited member must NOT emit a calls edge to A.shared");
  assert.equal(hitsB, false, "ambiguous inherited member must NOT emit a calls edge to B.shared");
});

test("inherited resolution does not shadow a same-class member", async () => {
  const files = [
    {
      path: "src/pkg/inh_shadow.py",
      content: [
        "class Base:",
        "    def work(self):",
        "        return 'base'",
        "",
        "class Sub(Base):",
        "    def work(self):",
        "        return 'sub'",
        "",
        "    def use(self):",
        "        return self.work()",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/inh_shadow.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  const baseClass = findTopLevelSymbol(result.symbols, "Base", SymbolKind.Class);
  const baseWork = result.symbols.find((symbol) =>
    symbol.parentSymbolId === baseClass.id && symbol.localName === "work"
  );
  const subClass = findTopLevelSymbol(result.symbols, "Sub", SymbolKind.Class);
  const subWork = result.symbols.find((symbol) =>
    symbol.parentSymbolId === subClass.id && symbol.localName === "work"
  );
  const use = result.symbols.find((symbol) =>
    symbol.parentSymbolId === subClass.id && symbol.localName === "use"
  );

  const calls = callsEdges(result);
  const toSub = calls.find((candidate) =>
    candidate.srcSymbolId === use?.id && candidate.dstSymbolId === subWork?.id
  );
  const toBase = calls.find((candidate) =>
    candidate.srcSymbolId === use?.id && candidate.dstSymbolId === baseWork?.id
  );

  assert.notEqual(toSub, undefined, "self.work() must resolve to the same-class override, not the base");
  assert.equal(toBase, undefined, "inherited fallback must not fire when the same-class member exists");
});

test("inherited lookup skips when the direct base is not exactly resolvable", async () => {
  const files = [
    {
      path: "src/pkg/inh_external.py",
      content: [
        "class Sub(ExternalThing):",         // ExternalThing is unresolved
        "    def use(self):",
        "        return self.shared()",       // cannot resolve: no resolved bases
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/inh_external.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  assert.equal(callsEdges(result).length, 0);
  // `ExternalThing` still surfaces as an inheritance-kind reference from the class,
  // but only if it resolved to an indexed symbol — it does not, so no edges exist.
  assert.equal(referencesEdges(result).length, 0);
});

test("dynamic base expressions are skipped for inheritance relationships", async () => {
  const files = [
    {
      path: "src/pkg/inh_dynamic.py",
      content: [
        "class Base:",
        "    def shared(self):",
        "        return 'shared'",
        "",
        "def factory():",
        "    return Base",
        "",
        "class Sub(factory()):",
        "    def use(self):",
        "        return self.shared()",
        "",
      ].join("\n"),
    },
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/inh_dynamic.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  const baseClass = findTopLevelSymbol(result.symbols, "Base", SymbolKind.Class);
  const subClass = findTopLevelSymbol(result.symbols, "Sub", SymbolKind.Class);
  const refs = referencesEdges(result);

  assert.equal(
    refs.some((edge) => edge.srcSymbolId === subClass.id && edge.dstSymbolId === baseClass.id),
    false,
    "factory() must not create a guessed inheritance reference to Base",
  );
  assert.equal(callsEdges(result).length, 0);
});

test("reference to self.method is not duplicated when a calls edge already exists", async () => {
  const files = [
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
  ];

  const parser = createPythonParser({ knownFiles: files });
  const result = await parser.parse({
    path: "src/pkg/service.py",
    language: Language.Python,
    content: files[0]!.content,
  });

  assert.equal(callsEdges(result).length, 1);
  assert.equal(referencesEdges(result).length, 0);
});

async function parseCoreFixture() {
  return pythonParser.parse(await coreFixtureInput());
}

async function coreFixtureInput(): Promise<ParseFileInput> {
  return {
    path: "src/pkg/mod.py",
    language: Language.Python,
    content: await readFile(CORE_FIXTURE_URL, "utf8"),
  };
}

interface LoadedPythonFixture {
  parser: ReturnType<typeof createPythonParser>;
  filesByPath: ReadonlyMap<string, string>;
}

async function loadPythonFixture(rootUrl: URL): Promise<LoadedPythonFixture> {
  const rootPath = fileURLToPath(rootUrl);
  const filePaths = await listFixtureFiles(rootPath);
  const knownFiles = await Promise.all(filePaths.map(async (filePath) => {
    return {
      path: path.relative(rootPath, filePath).replace(/\\/g, "/"),
      content: await readFile(filePath, "utf8"),
    };
  }));
  knownFiles.sort((left, right) => left.path.localeCompare(right.path));

  return {
    parser: createPythonParser({ knownFiles }),
    filesByPath: new Map(knownFiles.map((file) => [file.path, file.content])),
  };
}

async function parseFixtureFile(
  fixture: LoadedPythonFixture,
  filePath: string,
) {
  const content = fixture.filesByPath.get(filePath);

  assert.notEqual(content, undefined);

  return fixture.parser.parse({
    path: filePath,
    language: Language.Python,
    content: content as string,
  });
}

async function listFixtureFiles(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const filePaths: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      filePaths.push(...await listFixtureFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".py")) {
      filePaths.push(entryPath);
    }
  }

  return filePaths;
}

function importEdges(result: Awaited<ReturnType<typeof parseCoreFixture>>) {
  return result.edges.filter((edge) => edge.edgeType === EdgeType.Imports);
}

function callsEdges(result: Awaited<ReturnType<typeof parseCoreFixture>>) {
  return result.edges.filter((edge) => edge.edgeType === EdgeType.Calls);
}

function referencesEdges(result: Awaited<ReturnType<typeof parseCoreFixture>>) {
  return result.edges.filter((edge) => edge.edgeType === EdgeType.References);
}

// M140: a file's module-level imports are owned by its module scope symbol.
function moduleSymbolOf(symbols: readonly SymbolRecord[]): SymbolRecord {
  return onlySymbolOfKind(symbols, SymbolKind.Module);
}

function onlySymbolOfKind(symbols: readonly SymbolRecord[], kind: SymbolKind): SymbolRecord {
  const matches = symbols.filter((symbol) => symbol.kind === kind);

  assert.equal(matches.length, 1);

  return matches[0] as SymbolRecord;
}

function findTopLevelSymbol(
  symbols: readonly SymbolRecord[],
  localName: string,
  kind: SymbolKind,
): SymbolRecord {
  const symbol = symbols.find((candidate) => {
    return candidate.localName === localName
      && candidate.kind === kind
      && candidate.parentSymbolId === undefined;
  });

  assert.notEqual(symbol, undefined);

  return symbol as SymbolRecord;
}

function findMethod(symbols: readonly SymbolRecord[], localName: string): SymbolRecord {
  const symbol = symbols.find((candidate) => {
    return candidate.localName === localName && candidate.kind === SymbolKind.Method;
  });

  assert.notEqual(symbol, undefined);

  return symbol as SymbolRecord;
}

// --- run-level export-index cache (re-parse regression) ----------------------

// Build an export index spawns a CPython subprocess; without a run-level cache an
// imported target is re-parsed once per importer (and once per import/call/
// reference pass), making a whole-repo index effectively O(n²) in spawns. This
// routes parsing through a wrapper interpreter that records the file path of every
// spawn, then asserts a single shared target is parsed once across many importers
// — while the cross-file edge it resolves is still produced (cache is behaviour-
// preserving).
test("a shared imported module is parsed once across many importers (run-level cache)", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "vtrace-pyparse-cache-"));
  const counter = path.join(dir, "spawns.log");
  // Wrapper interpreter: log argv after `-c <script>` (the file path the parser
  // passes through), then exec the real python so AST output is unchanged.
  const wrapper = path.join(dir, "py-wrapper.sh");
  writeFileSync(wrapper, `#!/usr/bin/env bash\nprintf '%s\\n' "$3" >> '${counter}'\nexec python3 "$@"\n`);
  chmodSync(wrapper, 0o755);

  const target = { path: "target.py", content: "def foo():\n    return 1\n" };
  const importers = ["a", "b", "c", "d"].map((name) => ({
    path: `${name}.py`,
    content: "from target import foo\n\n\ndef use():\n    return foo()\n",
  }));
  const knownFiles = [target, ...importers];
  const parser = createPythonParser({ knownFiles, interpreterCandidates: [wrapper] });

  for (const importer of importers) {
    const result = await parser.parse({ path: importer.path, content: importer.content, language: Language.Python });
    // Behaviour preserved: the importer has no local `foo`, so an `imports` edge
    // only exists if the cross-file target (target.py::foo) was resolved — which
    // means the export index was consulted (cache hit or build), not skipped.
    assert.ok(
      result.edges.some((edge) => edge.edgeType === EdgeType.Imports),
      `expected a resolved import edge from ${importer.path}`,
    );
  }

  assert.ok(existsSync(counter), "wrapper interpreter was not invoked");
  const spawns = readFileSync(counter, "utf8").split("\n").filter(Boolean);
  const targetSpawns = spawns.filter((line) => line.endsWith("target.py")).length;
  // With the cache: target.py is parsed exactly once for its export index, reused
  // by every importer and every resolution pass. Without it this would grow with
  // the importer count (×3 passes). Allow a tiny constant, but it must NOT scale.
  assert.ok(targetSpawns <= 1, `target.py was parsed ${targetSpawns} times; expected <= 1 (cache not effective)`);
});

// --- batched AST extraction (M198 P6/P7) -------------------------------------

/**
 * A CPython interpreter costs ~36 ms to start and ~23 ms to run this parser's AST
 * script over a typical file, so a cold whole-repository index spent more than
 * half its Python parse budget launching interpreters. Batching amortises that,
 * and the only thing that makes it legitimate is that it changes nothing else.
 *
 * The reference side is `parsePython`, which builds a fresh context per call and
 * therefore never reaches the batch threshold — it is the pre-M198 code path.
 */
test("batched AST extraction is byte-identical to per-file spawns, and spawns far less", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { parsePython } = await import("./pythonParser");
  const dir = mkdtempSync(path.join(tmpdir(), "vtrace-pybatch-"));
  const counter = path.join(dir, "spawns.log");
  const wrapper = path.join(dir, "py-wrapper.sh");
  writeFileSync(counter, "");
  writeFileSync(wrapper, `#!/usr/bin/env bash\nprintf 'spawn\\n' >> '${counter}'\nexec python3 "$@"\n`);
  chmodSync(wrapper, 0o755);

  // Comfortably past the warm threshold, with imports so the export-index path —
  // the random-access reader that shares this cache — is exercised too.
  const knownFiles = Array.from({ length: 20 }, (_unused, index) => ({
    path: `mod${index}.py`,
    content: [
      "from shared import helper",
      "",
      "",
      `class Widget${index}:`,
      "    def build(self, size: int) -> int:",
      "        return helper(size)",
      "",
      "",
      `def make${index}(size: int) -> int:`,
      `    return Widget${index}().build(size)`,
      "",
    ].join("\n"),
  }));
  knownFiles.push({ path: "shared.py", content: "def helper(size):\n    return size * 2\n" });

  const reference = [];
  for (const file of knownFiles) {
    reference.push(parsePython(
      { path: file.path, content: file.content, language: Language.Python },
      { knownFiles },
    ));
  }

  writeFileSync(counter, "");
  const batching = createPythonParser({ knownFiles, interpreterCandidates: [wrapper] });
  const batched = [];
  for (const file of knownFiles) {
    batched.push(await batching.parse({
      path: file.path, content: file.content, language: Language.Python,
    }));
  }

  assert.equal(JSON.stringify(batched), JSON.stringify(reference));

  const spawns = readFileSync(counter, "utf8").split("\n").filter(Boolean).length;
  assert.ok(spawns < knownFiles.length,
    `batching must spawn fewer interpreters than there are files; ${spawns} for ${knownFiles.length}`);
});

/**
 * P7. The batch is a cache, and a cache that answers differently on the second
 * read is worse than none: identical inputs must yield identical results whether
 * they arrive before or after the warm.
 */
test("repeated parses through one batched parser are identical", async () => {
  const knownFiles = Array.from({ length: 8 }, (_unused, index) => ({
    path: `repeat${index}.py`,
    content: `def value${index}(x: int) -> int:\n    return x + ${index}\n`,
  }));
  const parser = createPythonParser({ knownFiles });

  const first = [];
  for (const file of knownFiles) {
    first.push(await parser.parse({ path: file.path, content: file.content, language: Language.Python }));
  }
  const second = [];
  for (const file of knownFiles) {
    second.push(await parser.parse({ path: file.path, content: file.content, language: Language.Python }));
  }

  assert.equal(JSON.stringify(second), JSON.stringify(first));
});
