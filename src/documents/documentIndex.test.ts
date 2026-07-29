import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openIndexerDatabase } from "../db/sqlite";
import { listDocumentChunks } from "../db/repositories/documentsRepository";
import { listAllEdges } from "../db/repositories/edgesRepository";
import { listAllSymbols } from "../db/repositories/symbolsRepository";
import { indexProject } from "../indexer/indexProject";
import { normalizeGraph } from "../indexer/normalizedGraph";
import {
  retrieveIndexedDocuments,
  type DocumentIntegrationProfile,
} from "./documentRetrieval";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("M128 YAML/TOML document indexing", () => {
  test("persists deterministic line spans and retrieves workflow and dependency excerpts without code semantics", async () => {
    const root = await fixture();
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot: root, db, refreshMode: "full", parserVersion: "m128", parserConfigFingerprint: "m128" });
      const chunks = listDocumentChunks(db);
      expect(chunks.some((chunk) => chunk.path === ".github/workflows/python-client-ci.yml" && chunk.startLine === 1)).toBe(true);
      expect(chunks.some((chunk) => chunk.path === "clients/python/pyproject.toml" && chunk.keyPath === "project.optional-dependencies")).toBe(true);
      expect(listAllSymbols(db).some((symbol) => /\.(?:ya?ml|toml)$/u.test(symbol.filePath))).toBe(false);
      expect(listAllEdges(db).some((edge) => chunks.some((chunk) => chunk.fileId === edge.srcSymbolId || chunk.fileId === edge.dstSymbolId))).toBe(false);

      const result = retrieveIndexedDocuments(
        db,
        "Add a GitHub Actions pytest workflow for clients/python and inspect notebook test dependencies in pyproject.toml.",
        extractClues(),
      );
      expect(result.candidates.slice(0, 2).map((candidate) => candidate.path)).toEqual([
        "clients/python/pyproject.toml",
        ".github/workflows/python-client-ci.yml",
      ]);
      expect(result.candidates.flatMap((candidate) => candidate.excerpts).every((excerpt) => excerpt.startLine >= 1 && excerpt.endLine >= excerpt.startLine)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("incremental updates, rename, and delete equal a clean full document index", async () => {
    const root = await fixture();
    const incrementalDb = openIndexerDatabase();
    const fullDb = openIndexerDatabase();
    try {
      let run = await indexProject({ repoRoot: root, db: incrementalDb, refreshMode: "full", parserVersion: "m128", parserConfigFingerprint: "m128" });
      await writeFile(path.join(root, ".github/workflows/python-client-ci.yml"), workflow("python -m pytest -q"));
      run = await indexProject({ repoRoot: root, db: incrementalDb, refreshMode: "incremental", previousSnapshot: run.snapshot, parserVersion: "m128", parserConfigFingerprint: "m128" });
      await writeFile(path.join(root, "clients/python/pyproject.toml"), pyproject("pytest>=9"));
      run = await indexProject({ repoRoot: root, db: incrementalDb, refreshMode: "incremental", previousSnapshot: run.snapshot, parserVersion: "m128", parserConfigFingerprint: "m128" });
      await rename(
        path.join(root, ".github/workflows/python-client-ci.yml"),
        path.join(root, ".github/workflows/python-sdk-ci.yml"),
      );
      run = await indexProject({ repoRoot: root, db: incrementalDb, refreshMode: "incremental", previousSnapshot: run.snapshot, parserVersion: "m128", parserConfigFingerprint: "m128" });
      await unlink(path.join(root, "clients/python/pyproject.toml"));
      run = await indexProject({ repoRoot: root, db: incrementalDb, refreshMode: "incremental", previousSnapshot: run.snapshot, parserVersion: "m128", parserConfigFingerprint: "m128" });
      const clean = await indexProject({ repoRoot: root, db: fullDb, refreshMode: "full", parserVersion: "m128", parserConfigFingerprint: "m128" });
      expect(run.snapshot.files).toEqual(clean.snapshot.files);
      expect(listDocumentChunks(incrementalDb)).toEqual(listDocumentChunks(fullDb));
      expect(normalizeGraph(incrementalDb)).toEqual(normalizeGraph(fullDb));
    } finally {
      incrementalDb.close();
      fullDb.close();
    }
  });

  test("excludes secret/lock paths and bounds binary and large documents", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "secrets.yml"), "token: should-not-index\n");
    await writeFile(path.join(root, ".env.toml"), "token = 'should-not-index'\n");
    await writeFile(path.join(root, "credentials.toml"), "token = 'should-not-index'\n");
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    await writeFile(path.join(root, "large.yml"), `payload: ${"x".repeat(300_000)}\n`);
    await writeFile(path.join(root, "binary.toml"), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(root, "invalid.yml"), "workflow: [still searchable\n");
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot: root, db, refreshMode: "full", parserVersion: "m128", parserConfigFingerprint: "m128" });
      const paths = new Set(listDocumentChunks(db).map((chunk) => chunk.path));
      expect(paths.has("secrets.yml")).toBe(false);
      expect(paths.has(".env.toml")).toBe(false);
      expect(paths.has("credentials.toml")).toBe(false);
      expect(paths.has("pnpm-lock.yaml")).toBe(false);
      expect(paths.has("large.yml")).toBe(false);
      expect(paths.has("binary.toml")).toBe(false);
      expect(paths.has("invalid.yml")).toBe(true);
    } finally {
      db.close();
    }
  });

  test("gates Python-only work and batch-loads document chunks once", async () => {
    const root = await fixture();
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot: root, db, refreshMode: "full", parserVersion: "m129", parserConfigFingerprint: "m129" });
      const skipped = profile();
      const pythonOnly = retrieveIndexedDocuments(
        db,
        "Fix payload serialization in the Python builder.",
        [],
        undefined,
        { profile: skipped },
      );
      expect(pythonOnly.invoked).toBe(false);
      expect(skipped.documentLane).toEqual({
        attempted: false,
        reason: "no_supported_document_clue",
      });
      expect(skipped.counters.document_fts_queries ?? 0).toBe(0);

      const invoked = profile();
      const documents = retrieveIndexedDocuments(
        db,
        "Find python-client-ci.yml and the pyproject pytest dependencies for clients/python.",
        extractClues(),
        undefined,
        { profile: invoked },
      );
      expect(documents.invoked).toBe(true);
      expect(invoked.documentLane?.attempted).toBe(true);
      expect(invoked.counters.document_fts_queries).toBe(1);
      expect(invoked.counters.document_chunk_batch_queries).toBe(1);
      expect(invoked.counters.document_excerpts_loaded).toBe(invoked.counters.document_chunk_rows_returned);
      expect(invoked.counters.document_candidates_materialized).toBeGreaterThanOrEqual(2);
      expect(documents.candidates.map((candidate) => candidate.path)).toContain(
        ".github/workflows/python-client-ci.yml",
      );
      expect(JSON.stringify(invoked)).not.toContain("python -m pytest");
    } finally {
      db.close();
    }
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-m128-doc-"));
  roots.push(root);
  await mkdir(path.join(root, ".github/workflows"), { recursive: true });
  await mkdir(path.join(root, "clients/python/src/example"), { recursive: true });
  await mkdir(path.join(root, "clients/python/tests"), { recursive: true });
  await writeFile(path.join(root, ".github/workflows/python-client-ci.yml"), workflow("python -m pytest"));
  await writeFile(path.join(root, "clients/python/pyproject.toml"), pyproject("pytest>=8"));
  await writeFile(path.join(root, "clients/python/src/example/client.py"), "def build_payload():\n    return {'degeneracy_convention': 'unknown'}\n");
  return root;
}

function workflow(command: string): string {
  return `name: Python client CI\non:\n  pull_request:\n    paths:\n      - "clients/python/**"\njobs:\n  test:\n    steps:\n      - run: ${command}\n        working-directory: clients/python\n`;
}

function pyproject(pytest: string): string {
  return `[project]\nname = "example-client"\ndependencies = ["httpx"]\n\n[project.optional-dependencies]\ntest = ["${pytest}"]\nnotebook = ["jupyter", "nbconvert"]\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`;
}

function extractClues() {
  return [
    { raw: "clients/python", normalized: "clients/python", kind: "path" as const },
    { raw: "pyproject.toml", normalized: "pyproject.toml", kind: "filename" as const },
  ];
}

function profile(): DocumentIntegrationProfile {
  return { timingsMs: {}, counters: {} };
}
