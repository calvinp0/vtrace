import { describe, expect, test } from "bun:test";

import { expectedWorkspacePaths } from "./run_stage5_m160_prepare_workspaces";

describe("M160 workspace completeness expectations", () => {
  const tree = [
    "django/apps/registry.py",
    "django/db/models/sql/query.py",
    "docs/ref/models.txt",
    "tests/queries/test_qs_combinators.py",
    "setup.py",
  ].join("\n");

  test("a package-rooted repository expects only its subtree, prefix stripped", () => {
    expect(expectedWorkspacePaths(tree, "django/django")).toEqual([
      "apps/registry.py",
      "db/models/sql/query.py",
    ]);
  });

  test("a repo-rooted repository expects the whole tree unchanged", () => {
    expect(expectedWorkspacePaths(tree, "sympy/sympy")).toEqual([
      "django/apps/registry.py",
      "django/db/models/sql/query.py",
      "docs/ref/models.txt",
      "tests/queries/test_qs_combinators.py",
      "setup.py",
    ]);
  });

  test("KNOWN POSITIVE: the django-13590 truncation is visible as missing expectations", () => {
    // The real defect: `apps/` and `contrib/` landed, `db/` never did. The gate
    // compares against the base commit's own tree, so the gap is arithmetic
    // rather than a judgement call.
    const expected = expectedWorkspacePaths(tree, "django/django");
    const extracted = new Set(["apps/registry.py"]);
    const missing = expected.filter((p) => !extracted.has(p));
    expect(missing).toEqual(["db/models/sql/query.py"]);
  });

  test("blank lines in the tree listing are ignored", () => {
    expect(expectedWorkspacePaths("\n\nsetup.py\n\n", "psf/requests")).toEqual(["setup.py"]);
  });
});
