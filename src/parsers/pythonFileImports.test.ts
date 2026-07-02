import { describe, expect, test } from "bun:test";

import {
  buildPythonModuleIndex,
  createFileImportScanner,
  scanTopLevelPythonImports,
  type FileImportScanner,
} from "./pythonFileImports";

// --- statement scanning ------------------------------------------------------------

describe("scanTopLevelPythonImports", () => {
  test("parses plain module imports with aliases and compounds", () => {
    const statements = scanTopLevelPythonImports(
      "import os\nimport a.b.c as abc, d.e\nimport json; import sys\n",
    );
    expect(statements).toEqual([
      { kind: "module", module: "", level: 0, names: [{ name: "os" }] },
      {
        kind: "module", module: "", level: 0,
        names: [{ name: "a.b.c", asName: "abc" }, { name: "d.e" }],
      },
      { kind: "module", module: "", level: 0, names: [{ name: "json" }] },
      { kind: "module", module: "", level: 0, names: [{ name: "sys" }] },
    ]);
  });

  test("parses from-imports: absolute, relative, aliased, parenthesized, wildcard", () => {
    const statements = scanTopLevelPythonImports(
      [
        "from a.b import c, d as dd",
        "from . import sibling",
        "from ..pkg import thing",
        "from a.b import (",
        "    one,  # trailing comment",
        "    two as II,",
        ")",
        "from a.b import *",
      ].join("\n"),
    );
    expect(statements).toEqual([
      { kind: "from", module: "a.b", level: 0, names: [{ name: "c" }, { name: "d", asName: "dd" }] },
      { kind: "from", module: "", level: 1, names: [{ name: "sibling" }] },
      { kind: "from", module: "pkg", level: 2, names: [{ name: "thing" }] },
      { kind: "from", module: "a.b", level: 0, names: [{ name: "one" }, { name: "two", asName: "II" }] },
      { kind: "from", module: "a.b", level: 0, names: [{ name: "*" }] },
    ]);
  });

  test("handles backslash continuations", () => {
    const statements = scanTopLevelPythonImports("from a.b import c, \\\n    d\n");
    expect(statements).toEqual([
      { kind: "from", module: "a.b", level: 0, names: [{ name: "c" }, { name: "d" }] },
    ]);
  });

  test("ignores indented (non-top-level) imports", () => {
    const statements = scanTopLevelPythonImports(
      "def f():\n    import os\n    from a import b\n\nif True:\n    import sys\n",
    );
    expect(statements).toEqual([]);
  });

  test("ignores import-looking lines inside docstrings and strings", () => {
    const statements = scanTopLevelPythonImports(
      [
        '"""Module docstring.',
        "import fake_module",
        "from fake import thing",
        '"""',
        "import real_module",
        "x = '''",
        "import also_fake",
        "'''",
        'y = "import not_real"  # import commented',
        "s = 'quote \\' inside'",
        "import second_real",
      ].join("\n"),
    );
    expect(statements.flatMap((s) => s.names.map((n) => n.name)))
      .toEqual(["real_module", "second_real"]);
  });

  test("skips malformed statements instead of guessing", () => {
    const statements = scanTopLevelPythonImports("import \nfrom import x\nfrom a-b import c\n");
    expect(statements).toEqual([]);
  });
});

// --- module index ------------------------------------------------------------------

describe("buildPythonModuleIndex", () => {
  test("module names start at the outermost __init__ chain", () => {
    const index = buildPythonModuleIndex([
      "pkg/__init__.py",
      "pkg/mod.py",
      "pkg/sub/__init__.py",
      "pkg/sub/impl.py",
      "scripts/tool.py",
    ]);
    expect(index.moduleNameByFilePath.get("pkg/mod.py")).toBe("pkg.mod");
    expect(index.moduleNameByFilePath.get("pkg/sub/impl.py")).toBe("pkg.sub.impl");
    expect(index.moduleNameByFilePath.get("pkg/sub/__init__.py")).toBe("pkg.sub");
    expect(index.moduleNameByFilePath.get("scripts/tool.py")).toBe("tool");
    expect(index.rootIsPackage).toBe(false);
  });

  test("detects a package-rooted checkout", () => {
    const index = buildPythonModuleIndex(["__init__.py", "http/__init__.py", "http/response.py"]);
    expect(index.rootIsPackage).toBe(true);
    expect(index.moduleNameByFilePath.get("http/response.py")).toBe("http.response");
  });
});

// --- resolution --------------------------------------------------------------------

function scannerOf(files: Record<string, string>): FileImportScanner {
  return createFileImportScanner(Object.keys(files), (path) => files[path] ?? null);
}

describe("createFileImportScanner", () => {
  test("resolves absolute and relative imports to files", () => {
    const scanner = scannerOf({
      "pkg/__init__.py": "",
      "pkg/a.py": "from pkg.b import helper\nfrom .c import CClass\nimport pkg.d\n",
      "pkg/b.py": "def helper(): pass\n",
      "pkg/c.py": "class CClass: pass\n",
      "pkg/d.py": "",
    });
    const relations = scanner.relationsOf("pkg/a.py");
    expect(relations.map((r) => [r.importedPath, [...r.kinds].join("+"), r.relative])).toEqual([
      ["pkg/b.py", "from_name_import", false],
      ["pkg/c.py", "from_name_import", true],
      ["pkg/d.py", "module_import", false],
    ]);
    expect(relations[0]!.importedNames).toEqual(["helper"]);
  });

  test("resolves `from pkg import submodule` to the submodule file", () => {
    const scanner = scannerOf({
      "pkg/__init__.py": "",
      "pkg/sub.py": "",
      "user.py": "from pkg import sub\n",
    });
    expect(scanner.relationsOf("user.py").map((r) => [r.importedPath, [...r.kinds].join("+")]))
      .toEqual([["pkg/sub.py", "from_module_import"]]);
  });

  test("follows exact package __init__ re-exports to the defining file", () => {
    const scanner = scannerOf({
      "pkg/__init__.py": "from pkg.impl import Thing\n",
      "pkg/impl.py": "class Thing: pass\n",
      "user.py": "from pkg import Thing\n",
    });
    const relations = scanner.relationsOf("user.py");
    expect(relations.map((r) => [r.importedPath, [...r.kinds].join("+")])).toEqual([
      ["pkg/__init__.py", "from_name_import"],
      ["pkg/impl.py", "init_reexport"],
    ]);
  });

  test("follows alias-aware re-export chains with a depth limit", () => {
    const scanner = scannerOf({
      "pkg/__init__.py": "from pkg.mid import PublicName\n",
      "pkg/mid.py": "from pkg.deep import Inner as PublicName\n",
      "pkg/deep.py": "class Inner: pass\n",
      "user.py": "from pkg import PublicName\n",
    });
    const paths = scanner.relationsOf("user.py").map((r) => r.importedPath);
    expect(paths).toContain("pkg/deep.py");
  });

  test("wildcard imports resolve to the module file only", () => {
    const scanner = scannerOf({
      "pkg/__init__.py": "from pkg.impl import Thing\n",
      "pkg/impl.py": "class Thing: pass\n",
      "user.py": "from pkg import *\n",
    });
    const relations = scanner.relationsOf("user.py");
    expect(relations.map((r) => [r.importedPath, [...r.kinds].join("+")])).toEqual([
      ["pkg/__init__.py", "wildcard_module"],
    ]);
    expect(relations[0]!.importedNames).toEqual([]);
  });

  test("root-package inference resolves a checkout's own absolute imports", () => {
    // A package-rooted checkout (django/ contents at the root): absolute
    // `django.http.response` must resolve to `http/response.py`.
    const scanner = scannerOf({
      "__init__.py": "",
      "http/__init__.py": "",
      "http/response.py": "class HttpResponse: pass\n",
      "middleware.py": "from django.http.response import HttpResponse\n",
    });
    const relations = scanner.relationsOf("middleware.py");
    expect(relations.map((r) => [r.importedPath, r.viaRootPackageInference])).toEqual([
      ["http/response.py", true],
    ]);
  });

  test("root-package inference never fires when the full name resolves or root is not a package", () => {
    const vendored = scannerOf({
      "__init__.py": "",
      "django/__init__.py": "",
      "django/thing.py": "",
      "thing.py": "",
      "user.py": "from django import thing\n",
    });
    // Full name resolves — the vendored django wins; no inference.
    expect(vendored.relationsOf("user.py").map((r) => [r.importedPath, r.viaRootPackageInference]))
      .toEqual([["django/thing.py", false]]);

    const plain = scannerOf({
      "http/__init__.py": "",
      "http/response.py": "",
      "middleware.py": "from django.http import response\n",
    });
    // Root is not a package: unknown absolute imports stay unresolved.
    expect(plain.relationsOf("middleware.py")).toEqual([]);
  });

  test("ambiguous module names yield no relation", () => {
    const scanner = scannerOf({
      "a/mod.py": "",
      "b/mod.py": "",
      "user.py": "import mod\n",
    });
    expect(scanner.relationsOf("user.py")).toEqual([]);
  });

  test("relationBetween and importFanOut are consistent and deterministic", () => {
    const files = {
      "pkg/__init__.py": "",
      "pkg/a.py": "from pkg.b import x\nfrom pkg.c import y\n",
      "pkg/b.py": "from pkg.c import z\nx = 1\n",
      "pkg/c.py": "y = 1\nz = 1\n",
    };
    const scanner = scannerOf(files);
    const between = scanner.relationBetween("pkg/a.py", "pkg/b.py");
    expect(between.aImportsB?.importedNames).toEqual(["x"]);
    expect(between.bImportsA).toBeNull();
    expect(scanner.importFanOut("pkg/a.py")).toBe(2);
    expect(scanner.importFanOut("pkg/c.py")).toBe(0);
    // Determinism: a second scanner over the same tree returns identical output.
    const again = scannerOf(files);
    expect(again.relationsOf("pkg/a.py")).toEqual(scanner.relationsOf("pkg/a.py"));
  });

  test("self-imports and unknown targets yield no relations", () => {
    const scanner = scannerOf({
      "pkg/__init__.py": "",
      "pkg/a.py": "import numpy\nfrom pkg.a import thing\nfrom pkg.missing import gone\n",
    });
    expect(scanner.relationsOf("pkg/a.py")).toEqual([]);
  });
});
