import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { Language } from "../domain/types";
import { hashFile } from "./hashFile";
import { detectLanguage, isAdvertisedIndexableLanguage, isIndexableSourceFile, isRecognizedSourceFile } from "./languageDetection";
import { scanRepo } from "./scanRepo";

test("scanner finds recognized source files including unsupported languages", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixture(repoRoot);

    const files = await scanRepo(repoRoot);
    const paths = files.map((file) => file.path);

    assert.deepEqual(paths, [
      "src/app.js",
      "src/component.tsx",
      "src/index.ts",
      "src/inline.pxi",
      "src/interface.pxd",
      "src/module.pyx",
      "src/script.py",
      "src/view.jsx",
    ]);
  });
});

test("scanner does not scan ignored directories", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixture(repoRoot);

    const files = await scanRepo(repoRoot);
    const paths = files.map((file) => file.path);

    assert.equal(paths.some((filePath) => filePath.includes("node_modules/")), false);
    assert.equal(paths.some((filePath) => filePath.includes(".git/")), false);
    assert.equal(paths.some((filePath) => filePath.includes(".codex/")), false);
    assert.equal(paths.some((filePath) => filePath.includes("dist/")), false);
    assert.equal(paths.some((filePath) => filePath.includes("build/")), false);
  });
});

test("hashFile is deterministic and depends only on file contents", async () => {
  await withFixture(async (repoRoot) => {
    const firstPath = path.join(repoRoot, "first.ts");
    const secondPath = path.join(repoRoot, "nested", "second.ts");
    await mkdir(path.dirname(secondPath), { recursive: true });

    await writeFile(firstPath, "export const value = 1;\n");
    await writeFile(secondPath, "export const value = 1;\n");

    const firstHash = await hashFile(firstPath);
    const secondHash = await hashFile(secondPath);
    const repeatedHash = await hashFile(firstPath);

    assert.equal(firstHash, repeatedHash);
    assert.equal(firstHash, secondHash);
  });
});

test("scanner output is stable across multiple runs", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixture(repoRoot);

    const firstRun = await scanRepo(repoRoot);
    const secondRun = await scanRepo(repoRoot);

    assert.deepEqual(firstRun, secondRun);
  });
});

test("scanner paths always use forward slashes", async () => {
  await withFixture(async (repoRoot) => {
    await mkdir(path.join(repoRoot, "src", "nested"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "nested", "index.ts"), "export const nested = 1;\n");

    const files = await scanRepo(repoRoot);

    assert.deepEqual(files.map((file) => file.path), ["src/nested/index.ts"]);
    assert.equal(files.every((file) => !file.path.includes("\\")), true);
  });
});

test("language detection maps supported extensions to domain languages", () => {
  assert.equal(detectLanguage("src/index.ts"), Language.TypeScript);
  assert.equal(detectLanguage("src/component.tsx"), Language.TypeScript);
  assert.equal(detectLanguage("src/app.js"), Language.JavaScript);
  assert.equal(detectLanguage("src/view.jsx"), Language.JavaScript);
  assert.equal(detectLanguage("src/script.py"), Language.Python);
  assert.equal(detectLanguage("src/module.pyx"), Language.Cython);
  assert.equal(detectLanguage("src/interface.pxd"), Language.Cython);
  assert.equal(detectLanguage("src/inline.pxi"), Language.Cython);
  assert.equal(detectLanguage("src/styles.css"), Language.Css);
  assert.equal(detectLanguage("src/notes.fortran"), undefined);
});

test("JavaScript and JSX are indexable through the structural family; TOML is recognized only (M202)", () => {
  assert.equal(isRecognizedSourceFile("frontend/eslint.config.js"), true);
  assert.equal(isRecognizedSourceFile("frontend/component.jsx"), true);
  assert.equal(isIndexableSourceFile("frontend/eslint.config.js"), true);
  assert.equal(isIndexableSourceFile("frontend/component.jsx"), true);
  assert.equal(isRecognizedSourceFile("pyproject.toml"), true);
  assert.equal(isIndexableSourceFile("pyproject.toml"), false);
  assert.equal(isAdvertisedIndexableLanguage(Language.Toml), false);
  assert.equal(isAdvertisedIndexableLanguage(Language.JavaScript), true);
  assert.equal(isAdvertisedIndexableLanguage(Language.TypeScript), true);
  assert.equal(isAdvertisedIndexableLanguage(Language.Python), true);
  assert.equal(isAdvertisedIndexableLanguage(Language.Cython), true);
});

async function withFixture(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-scan-"));

  try {
    await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

async function writeFixture(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await mkdir(path.join(repoRoot, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(repoRoot, ".git", "hooks"), { recursive: true });
  await mkdir(path.join(repoRoot, ".codex"), { recursive: true });
  await mkdir(path.join(repoRoot, "dist"), { recursive: true });
  await mkdir(path.join(repoRoot, "build"), { recursive: true });

  await writeFile(path.join(repoRoot, "src", "index.ts"), "export const index = 1;\n");
  await writeFile(path.join(repoRoot, "src", "component.tsx"), "export const Component = () => null;\n");
  await writeFile(path.join(repoRoot, "src", "app.js"), "export const app = 1;\n");
  await writeFile(path.join(repoRoot, "src", "view.jsx"), "export const View = () => null;\n");
  await writeFile(path.join(repoRoot, "src", "script.py"), "value = 1\n");
  await writeFile(path.join(repoRoot, "src", "module.pyx"), "def cython_module():\n    return 1\n");
  await writeFile(path.join(repoRoot, "src", "interface.pxd"), "cdef int declared(int value)\n");
  await writeFile(path.join(repoRoot, "src", "inline.pxi"), "cpdef int included(int value):\n    return value\n");
  await writeFile(path.join(repoRoot, "src", "README.md"), "# ignored\n");
  await writeFile(path.join(repoRoot, "node_modules", "pkg", "index.ts"), "export const pkg = 1;\n");
  await writeFile(path.join(repoRoot, ".git", "hooks", "pre-commit.js"), "console.log('ignored');\n");
  await writeFile(path.join(repoRoot, ".codex", "config.toml"), "model = 'ignored'\n");
  await writeFile(path.join(repoRoot, "dist", "bundle.js"), "console.log('ignored');\n");
  await writeFile(path.join(repoRoot, "build", "generated.ts"), "export const ignored = 1;\n");
}
