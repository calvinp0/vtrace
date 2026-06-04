import assert from "node:assert/strict";
import { test } from "bun:test";

import { isPathIgnored, parseIgnoreFile, IGNORE_FILE_NAMES } from "./ignoreRules";

function ignored(content: string, baseDir: string, repoPath: string, isDir: boolean): boolean {
  return isPathIgnored(parseIgnoreFile(content, baseDir), repoPath, isDir);
}

test("supported ignore-file names keep .vtraceignore at highest precedence", () => {
  assert.deepEqual([...IGNORE_FILE_NAMES], [".gitignore", ".ignore", ".vtraceignore"]);
});

test("unanchored patterns match a basename at any depth", () => {
  assert.equal(ignored("*.log\n", "", "app.log", false), true);
  assert.equal(ignored("*.log\n", "", "src/deep/app.log", false), true);
  assert.equal(ignored("*.log\n", "", "app.logger.ts", false), false);
});

test("directory-only patterns match directories but not files", () => {
  assert.equal(ignored("build/\n", "", "build", true), true);
  assert.equal(ignored("build/\n", "", "build", false), false);
});

test("anchored patterns are relative to the ignore file directory", () => {
  assert.equal(ignored("/root_only.txt\n", "", "root_only.txt", false), true);
  assert.equal(ignored("/root_only.txt\n", "", "src/root_only.txt", false), false);
  assert.equal(ignored("foo/bar.py\n", "", "foo/bar.py", false), true);
  assert.equal(ignored("foo/bar.py\n", "", "x/foo/bar.py", false), false);
});

test("negation re-includes a previously ignored path", () => {
  const content = "*.log\n!keep.log\n";
  assert.equal(ignored(content, "", "drop.log", false), true);
  assert.equal(ignored(content, "", "keep.log", false), false);
});

test("double-star matches across path segments", () => {
  assert.equal(ignored("a/**/b\n", "", "a/b", false), true);
  assert.equal(ignored("a/**/b\n", "", "a/x/y/b", false), true);
  assert.equal(ignored("a/**/b\n", "", "a/b/c", false), false);
  assert.equal(ignored("logs/**\n", "", "logs/today/x.txt", false), true);
  assert.equal(ignored("logs/**\n", "", "logs", true), false);
});

test("character classes are honored", () => {
  assert.equal(ignored("*.py[cod]\n", "", "mod.pyc", false), true);
  assert.equal(ignored("*.py[cod]\n", "", "mod.pyx", false), false);
  assert.equal(ignored("file[0-9].txt\n", "", "file7.txt", false), true);
  assert.equal(ignored("file[0-9].txt\n", "", "fileA.txt", false), false);
});

test("rules from a nested ignore file only apply beneath that directory", () => {
  const content = "secret.key\nsub/*.tmp\n";
  assert.equal(ignored(content, "pkg", "pkg/secret.key", false), true);
  assert.equal(ignored(content, "pkg", "pkg/deep/secret.key", false), true);
  assert.equal(ignored(content, "pkg", "pkg/sub/a.tmp", false), true);
  assert.equal(ignored(content, "pkg", "other/secret.key", false), false);
});

test("comments and blank lines are skipped", () => {
  const content = "# a comment\n\n   \n*.bak\n";
  assert.equal(ignored(content, "", "x.bak", false), true);
  assert.equal(ignored(content, "", "comment", false), false);
});
