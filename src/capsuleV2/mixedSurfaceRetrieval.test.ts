import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { buildCapsuleV2 } from "./buildCapsuleV2";
import { CapsuleIntent } from "./types";

test("M128 selects exact code, test, workflow, configuration, and notebook evidence over generic distractors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-m128-mixed-"));
  const db = openIndexerDatabase();
  try {
    const files: Record<string, string> = {
      "clients/python/src/example_client/builders/reaction.py":
        "def build_computed_reaction_payload():\n    return {'degeneracy_convention': 'unknown'}\n",
      "clients/python/tests/test_computed_reaction_upload_builder.py":
        "def test_computed_reaction_payload_snapshot():\n    assert {'degeneracy_convention': 'unknown'}\n",
      "clients/python/tests/test_builder_demo_notebook.py":
        "def test_notebook_executes_with_jupyter():\n    assert 'nbconvert notebook requirements'\n",
      "clients/python/pyproject.toml":
        "[project.optional-dependencies]\ntest = [\"pytest\"]\nnotebook = [\"jupyter\", \"nbconvert\"]\n[tool.pytest.ini_options]\ntestpaths=[\"tests\"]\n",
      ".github/workflows/python-client-ci.yml":
        "name: Python client CI\non:\n  pull_request:\n    paths: [\"clients/python/**\"]\njobs:\n  test:\n    steps:\n      - run: python -m pytest\n        working-directory: clients/python\n",
      ".github/workflows/backend-ci.yml": "name: Backend workflow\njobs:\n  test:\n    steps:\n      - run: pytest backend\n",
      "backend/models/workflow.py": "class WorkflowTool:\n    pass\n",
      "backend/snapshot_store.py": "def snapshot_client_test():\n    return 'workflow snapshot client test'\n",
    };
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
    await indexProject({ repoRoot: root, db, refreshMode: "full", parserVersion: "m128", parserConfigFingerprint: "m128" });
    const result = buildCapsuleV2({
      db,
      repoRoot: root,
      task: "Fix the computed reaction payload snapshot for degeneracy_convention and add a GitHub Actions pytest workflow for clients/python changes. Inspect dependencies and notebook requirements.",
      intent: CapsuleIntent.Modify,
      maxTokens: 6_000,
    });
    const profiled = buildCapsuleV2({
      db,
      repoRoot: root,
      task: "Fix the computed reaction payload snapshot for degeneracy_convention and add a GitHub Actions pytest workflow for clients/python changes. Inspect dependencies and notebook requirements.",
      intent: CapsuleIntent.Modify,
      maxTokens: 6_000,
      includeTimingDiagnostics: true,
    });
    const paths = [...result.pivots, ...result.support].map((item) => item.path);
    expect(result.pivots[0]?.path).toBe("clients/python/tests/test_computed_reaction_upload_builder.py");
    expect(paths).toContain("clients/python/src/example_client/builders/reaction.py");
    expect(paths).toContain("clients/python/tests/test_builder_demo_notebook.py");
    expect(paths).toContain("clients/python/pyproject.toml");
    expect(paths).toContain(".github/workflows/python-client-ci.yml");
    expect(result.pivots.map((item) => item.path)).not.toContain("backend/models/workflow.py");
    expect(result.pivots.map((item) => item.path)).not.toContain("backend/snapshot_store.py");
    expect(paths).not.toContain(".github/workflows/backend-ci.yml");
    expect(result.diagnostics.document_integration_profile).toBeUndefined();
    expect(profiled.diagnostics.document_integration_profile?.documentLane?.attempted).toBe(true);
    expect(profiled.diagnostics.document_integration_profile?.counters.document_items_rendered).toBe(2);
    expect(selection(profiled)).toEqual(selection(result));
    expect(profiled.pivots.map((item) => item.source)).toEqual(result.pivots.map((item) => item.source));
    expect(profiled.support.map((item) => item.source)).toEqual(result.support.map((item) => item.source));
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

function selection(result: ReturnType<typeof buildCapsuleV2>) {
  return [...result.pivots, ...result.support].map((item) => ({
    path: item.path,
    role: item.role,
    contentMode: item.content_mode,
    estimatedTokens: item.estimated_tokens,
    evidence: item.evidence,
  }));
}
