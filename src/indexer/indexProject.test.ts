import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import type { Database } from "bun:sqlite";

import { EdgeType, Language, SymbolKind } from "../domain/types";
import { getFileByPath } from "../db/repositories/filesRepository";
import { listAllEdges, listEdgesForFile } from "../db/repositories/edgesRepository";
import {
  getIndexRunSummary,
  listFileDiffsForRun,
  listIndexRuns,
  listSymbolDiffsForRun,
} from "../db/repositories/indexRunsRepository";
import { listAllSymbols, listSymbolsForFile } from "../db/repositories/symbolsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { FileChangeType } from "../memory/types";
import {
  createParserRegistry,
  createTypeScriptParser,
  ParserError,
  type ParserRegistry,
} from "../parsers";
import {
  applyMixedPyCythonControlledChange,
  MIXED_PY_CYTHON_BACKGROUND_FILE_PATH,
  MIXED_PY_CYTHON_CONTROLLED_CHANGE_SYMBOL_FQ_NAME,
  MIXED_PY_CYTHON_FIXTURE_EDGE_COUNT,
  MIXED_PY_CYTHON_FIXTURE_FILE_COUNT,
  MIXED_PY_CYTHON_FIXTURE_SYMBOL_COUNT,
  MIXED_PY_CYTHON_KERNEL_FILE_PATH,
  withMixedPyCythonRepo,
} from "../testing/mixedPyCythonFixture";
import { indexProject } from "./indexProject";
import type { IndexProjectFileContent } from "./types";

test("a small TypeScript fixture repo indexes end-to-end into SQLite", async () => {
  await withFixture(async (repoRoot) => {
    await writeBasicTypeScriptRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      const result = await indexProject({ repoRoot, db });

      assert.equal(result.totalFilesScanned, 3);
      assert.equal(result.totalFilesAttemptedForParse, 3);
      assert.equal(result.totalFilesSuccessfullyIndexed, 3);
      assert.equal(result.totalSkippedUnregisteredLanguage, 0);
      assert.equal(result.totalParseFailures, 0);
      assert.notEqual(getFileByPath(db, "src/models.ts"), undefined);
      assert.notEqual(getFileByPath(db, "src/service.ts"), undefined);
      assert.notEqual(getFileByPath(db, "src/script.py"), undefined);
    } finally {
      db.close();
    }
  });
});

test("the default parser registry indexes detected Cython files end-to-end", async () => {
  await withFixture(async (repoRoot) => {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "src", "kernel.pyx"),
      `
cpdef int integrate(int value):
    return value
`,
    );
    const db = openIndexerDatabase();

    try {
      const result = await indexProject({ repoRoot, db });

      assert.equal(result.totalFilesScanned, 1);
      assert.equal(result.totalFilesSuccessfullyIndexed, 1);
      assert.equal(getFileByPath(db, "src/kernel.pyx")?.language, Language.Cython);
      assert.deepEqual(
        listSymbolsForFile(db, "src/kernel.pyx").map((symbol) => [symbol.localName, symbol.kind]),
        [["integrate", SymbolKind.Function]],
      );
    } finally {
      db.close();
    }
  });
});

test("the default parser registry persists resolvable Cython imports edges", async () => {
  await withFixture(async (repoRoot) => {
    await mkdir(path.join(repoRoot, "src", "pkg"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "pkg", "__init__.py"), "def package_api():\n    return 1\n");
    await writeFile(
      path.join(repoRoot, "src", "pkg", "runtime_target.pyx"),
      `
def runtime_target():
    return 1
`,
    );
    await writeFile(
      path.join(repoRoot, "src", "pkg", "service.pyx"),
      `
import pkg.runtime_target

def use_runtime():
    return pkg.runtime_target.runtime_target()
`,
    );
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });

      const serviceSymbols = listSymbolsForFile(db, "src/pkg/service.pyx");
      const serviceEdges = listEdgesForFile(db, "src/pkg/service.pyx");
      const runtimeSymbols = listSymbolsForFile(db, "src/pkg/runtime_target.pyx");

      assert.deepEqual(
        serviceSymbols.map((symbol) => [symbol.localName, symbol.kind]),
        [["use_runtime", SymbolKind.Function]],
      );
      assert.equal(serviceEdges.length, 1);
      assert.equal(serviceEdges[0]?.edgeType, EdgeType.Imports);
      assert.equal(serviceEdges[0]?.srcSymbolId, serviceSymbols[0]?.id);
      assert.equal(serviceEdges[0]?.dstSymbolId, runtimeSymbols[0]?.id);
    } finally {
      db.close();
    }
  });
});

test("a mixed Python/Cython fixture repo indexes end-to-end and persists expected structural state", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      const result = await indexProject({ repoRoot, db });
      const backgroundSymbol = requireSymbol(
        listSymbolsForFile(db, "src/spectra_lab/analysis/background.py"),
        "estimate_background",
      );
      const clampWindowSymbol = requireSymbol(
        listSymbolsForFile(db, "src/spectra_lab/utils/grid.py"),
        "clamp_window",
      );
      const declaredStepSymbol = requireSymbol(
        listSymbolsForFile(db, "src/spectra_lab/kernels/diffusion.pxd"),
        "declared_step",
      );
      const stencilSmoothSymbol = requireSymbol(
        listSymbolsForFile(db, "src/spectra_lab/kernels/stencil_ops.pxi"),
        "stencil_smooth",
      );
      const kernelSymbol = requireSymbol(
        listSymbolsForFile(db, MIXED_PY_CYTHON_KERNEL_FILE_PATH),
        "diffuse_profile",
      );
      const kernelEdges = listEdgesForFile(db, MIXED_PY_CYTHON_KERNEL_FILE_PATH);

      assert.equal(result.totalFilesScanned, MIXED_PY_CYTHON_FIXTURE_FILE_COUNT);
      assert.equal(result.totalFilesAttemptedForParse, MIXED_PY_CYTHON_FIXTURE_FILE_COUNT);
      assert.equal(result.totalFilesSuccessfullyIndexed, MIXED_PY_CYTHON_FIXTURE_FILE_COUNT);
      assert.equal(result.totalParseFailures, 0);
      assert.equal(result.totalSkippedUnregisteredLanguage, 0);
      assert.equal(result.totalSkippedUnsupportedLanguage, 0);
      assert.equal(getFileByPath(db, "src/spectra_lab/pipeline.py")?.language, Language.Python);
      assert.equal(getFileByPath(db, MIXED_PY_CYTHON_KERNEL_FILE_PATH)?.language, Language.Cython);
      assert.equal(getFileByPath(db, "src/spectra_lab/kernels/diffusion.pxd")?.language, Language.Cython);
      assert.equal(getFileByPath(db, "src/spectra_lab/kernels/stencil_ops.pxi")?.language, Language.Cython);
      assert.deepEqual(
        listSymbolsForFile(db, "src/spectra_lab/analysis/calibration.py").map((symbol) => [
          symbol.localName,
          symbol.kind,
        ]),
        [
          ["CalibrationRun", SymbolKind.Class],
          ["__init__", SymbolKind.Method],
          ["baseline", SymbolKind.Method],
        ],
      );
      assert.deepEqual(
        listSymbolsForFile(db, MIXED_PY_CYTHON_KERNEL_FILE_PATH).map((symbol) => [
          symbol.localName,
          symbol.kind,
        ]),
        [["diffuse_profile", SymbolKind.Function]],
      );
      assert.equal(listAllSymbols(db).length, MIXED_PY_CYTHON_FIXTURE_SYMBOL_COUNT);
      assert.equal(listAllEdges(db).length, MIXED_PY_CYTHON_FIXTURE_EDGE_COUNT);
      // The Cython kernel now carries both imports and statically resolved
      // calls to the same imported/cimported/included targets.
      const kernelImports = kernelEdges.filter((edge) => edge.edgeType === EdgeType.Imports);
      const kernelCalls = kernelEdges.filter((edge) => edge.edgeType === EdgeType.Calls);
      const kernelTargets = [
        backgroundSymbol.id,
        clampWindowSymbol.id,
        declaredStepSymbol.id,
        stencilSmoothSymbol.id,
      ].sort();

      assert.equal(kernelEdges.length, 8);
      assert.equal(kernelEdges.every((edge) => edge.srcSymbolId === kernelSymbol.id), true);
      assert.equal(kernelImports.length, 4);
      assert.equal(kernelCalls.length, 4);
      assert.deepEqual(kernelImports.map((edge) => edge.dstSymbolId).sort(), kernelTargets);
      assert.deepEqual(kernelCalls.map((edge) => edge.dstSymbolId).sort(), kernelTargets);
      assert.equal(getIndexRunSummary(db, listIndexRuns(db)[0]!.id)?.totalFiles, MIXED_PY_CYTHON_FIXTURE_FILE_COUNT);
      assert.equal(
        getIndexRunSummary(db, listIndexRuns(db)[0]!.id)?.totalSymbols,
        MIXED_PY_CYTHON_FIXTURE_SYMBOL_COUNT,
      );
    } finally {
      db.close();
    }
  });
});

test("symbols and edges are persisted through the full pipeline", async () => {
  await withFixture(async (repoRoot) => {
    await writeBasicTypeScriptRepo(repoRoot);
    await writeFile(
      path.join(repoRoot, "src", "session.ts"),
      `
export class SessionManager {
  createSession(): void {}
}
`,
    );
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });

      const sessionSymbols = listSymbolsForFile(db, "src/session.ts");
      const sessionEdges = listEdgesForFile(db, "src/session.ts");
      const serviceEdges = listEdgesForFile(db, "src/service.ts");

      assert.deepEqual(
        sessionSymbols.map((symbol) => [symbol.localName, symbol.kind]),
        [
          ["SessionManager", SymbolKind.Class],
          ["createSession", SymbolKind.Method],
        ],
      );
      assert.equal(sessionEdges.length, 1);
      assert.equal(sessionEdges[0]?.edgeType, EdgeType.Contains);
      assert.equal(serviceEdges.some((edge) => edge.edgeType === EdgeType.Imports), true);
    } finally {
      db.close();
    }
  });
});

test("unregistered language files are skipped and reported when no Python parser is registered", async () => {
  await withFixture(async (repoRoot) => {
    await writeBasicTypeScriptRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      const result = await indexProject({
        repoRoot,
        db,
        createParserRegistry: (files) => {
          return createParserRegistry([
            createTypeScriptParser({ knownFiles: knownFiles(files) }),
          ]);
        },
      });
      const pythonSummary = result.files.find((file) => file.path === "src/script.py");

      assert.equal(pythonSummary?.status, "unregistered_language");
      assert.equal(pythonSummary?.error?.code, "unregistered_language");
      assert.equal(result.totalSkippedUnregisteredLanguage, 1);
      assert.equal(getFileByPath(db, "src/script.py"), undefined);
    } finally {
      db.close();
    }
  });
});

test("parser failures do not abort the entire run", async () => {
  await withFixture(async (repoRoot) => {
    await writeBasicTypeScriptRepo(repoRoot);
    await writeFile(path.join(repoRoot, "src", "script.py"), "def broken(:\n    return 1\n");
    const db = openIndexerDatabase();

    try {
      const result = await indexProject({ repoRoot, db });
      const pythonSummary = result.files.find((file) => file.path === "src/script.py");

      assert.equal(result.totalParseFailures, 1);
      assert.equal(result.totalFilesSuccessfullyIndexed, 2);
      assert.equal(pythonSummary?.status, "parse_failed");
      assert.match(pythonSummary?.error?.message ?? "", /^Parser failed: SyntaxError:/);
      assert.equal(getFileByPath(db, "src/service.ts")?.path, "src/service.ts");
      assert.equal(getFileByPath(db, "src/script.py"), undefined);
    } finally {
      db.close();
    }
  });
});

test("Cython parser failures do not abort the entire indexing run", async () => {
  await withFixture(async (repoRoot) => {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "service.ts"), "export function ok() { return 1; }\n");
    await writeFile(path.join(repoRoot, "src", "broken.pyx"), "cdef int broken(\n    return 1\n");
    const db = openIndexerDatabase();

    try {
      const result = await indexProject({ repoRoot, db });
      const cythonSummary = result.files.find((file) => file.path === "src/broken.pyx");

      assert.equal(result.totalParseFailures, 1);
      assert.equal(result.totalFilesSuccessfullyIndexed, 1);
      assert.equal(cythonSummary?.status, "parse_failed");
      assert.match(cythonSummary?.error?.message ?? "", /^Parser failed: SyntaxError:/);
      assert.equal(getFileByPath(db, "src/service.ts")?.path, "src/service.ts");
      assert.equal(getFileByPath(db, "src/broken.pyx"), undefined);
    } finally {
      db.close();
    }
  });
});

test("unsupported language parser results are reported separately", async () => {
  await withFixture(async (repoRoot) => {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "script.py"), "value = 1\n");
    const db = openIndexerDatabase();

    try {
      const result = await indexProject({
        repoRoot,
        db,
        createParserRegistry: () => unsupportedLanguageRegistry,
      });

      assert.equal(result.totalFilesScanned, 1);
      assert.equal(result.totalFilesAttemptedForParse, 1);
      assert.equal(result.totalSkippedUnsupportedLanguage, 1);
      assert.equal(result.files[0]?.status, "unsupported_language");
      assert.equal(getFileByPath(db, "src/script.py"), undefined);
    } finally {
      db.close();
    }
  });
});

test("repeated indexing of an unchanged repo is idempotent", async () => {
  await withFixture(async (repoRoot) => {
    await writeBasicTypeScriptRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      const firstResult = await indexProject({ repoRoot, db });
      const firstSnapshot = snapshotDatabase(db);
      const secondResult = await indexProject({ repoRoot, db });
      const secondSnapshot = snapshotDatabase(db);

      assert.deepEqual(secondResult, firstResult);
      assert.deepEqual(secondSnapshot, firstSnapshot);
    } finally {
      db.close();
    }
  });
});

test("repeated indexing of the mixed Python/Cython fixture repo remains deterministic", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      const firstResult = await indexProject({ repoRoot, db });
      const firstSnapshot = snapshotMixedDatabase(db);
      const secondResult = await indexProject({ repoRoot, db });
      const secondSnapshot = snapshotMixedDatabase(db);

      assert.deepEqual(secondResult, firstResult);
      assert.deepEqual(secondSnapshot, firstSnapshot);
    } finally {
      db.close();
    }
  });
});

test("path normalization remains stable through scan, parse, and persist", async () => {
  await withFixture(async (repoRoot) => {
    await mkdir(path.join(repoRoot, "src", "nested"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "src", "nested", "index.ts"),
      "export function nested(): void {}\n",
    );
    const db = openIndexerDatabase();

    try {
      const result = await indexProject({ repoRoot, db });

      assert.deepEqual(result.files.map((file) => file.path), ["src/nested/index.ts"]);
      assert.equal(result.files.every((file) => !file.path.includes("\\")), true);
      assert.equal(getFileByPath(db, "./src/nested/index.ts")?.path, "src/nested/index.ts");
      assert.deepEqual(
        listSymbolsForFile(db, "src/nested/index.ts").map((symbol) => symbol.fqName),
        ["src/nested/index.ts::nested"],
      );
    } finally {
      db.close();
    }
  });
});

test("diagnostics from successful ParseResults are surfaced in the run result", async () => {
  await withFixture(async (repoRoot) => {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "broken.ts"), "export function broken( {");
    const db = openIndexerDatabase();

    try {
      const result = await indexProject({ repoRoot, db });
      const brokenSummary = result.files.find((file) => file.path === "src/broken.ts");

      assert.equal(result.totalFilesSuccessfullyIndexed, 1);
      assert.equal(brokenSummary?.status, "indexed");
      assert.equal(brokenSummary?.diagnostics.length, 1);
      assert.equal(brokenSummary?.diagnostics[0]?.message, "Syntax error");
      assert.equal(getFileByPath(db, "src/broken.ts")?.path, "src/broken.ts");
    } finally {
      db.close();
    }
  });
});

test("first run creates a baseline index run with no previous diff", async () => {
  await withFixture(async (repoRoot) => {
    await writeMemoryFixtureRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });

      const runs = listIndexRuns(db);
      const run = runs[0];

      assert.equal(runs.length, 1);
      assert.notEqual(run, undefined);
      assert.equal(run?.previousRunId, undefined);
      assert.equal(getIndexRunSummary(db, run!.id)?.totalFiles, 2);
      assert.equal(getIndexRunSummary(db, run!.id)?.totalSymbols, 2);
      assert.deepEqual(getIndexRunSummary(db, run!.id)?.fileChangeCounts, {
        added: 0,
        removed: 0,
        modified: 0,
        unchanged: 0,
      });
      assert.deepEqual(getIndexRunSummary(db, run!.id)?.symbolChangeCounts, {
        added: 0,
        removed: 0,
        modified: 0,
        unchanged: 0,
      });
      assert.deepEqual(listFileDiffsForRun(db, run!.id), []);
      assert.deepEqual(listSymbolDiffsForRun(db, run!.id), []);
    } finally {
      db.close();
    }
  });
});

test("second identical run reports unchanged files deterministically", async () => {
  await withFixture(async (repoRoot) => {
    await writeMemoryFixtureRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      await indexProject({ repoRoot, db });

      const secondRun = listIndexRuns(db)[1];
      const diffs = listFileDiffsForRun(db, secondRun!.id);
      const symbolDiffs = listSymbolDiffsForRun(db, secondRun!.id);

      assert.equal(secondRun?.previousRunId, 1);
      assert.deepEqual(
        diffs?.map((diff) => [diff.filePath, diff.changeType]),
        [
          ["src/models.ts", FileChangeType.Unchanged],
          ["src/service.ts", FileChangeType.Unchanged],
        ],
      );
      assert.deepEqual(getIndexRunSummary(db, secondRun!.id)?.fileChangeCounts, {
        added: 0,
        removed: 0,
        modified: 0,
        unchanged: 2,
      });
      assert.deepEqual(
        symbolDiffs?.map((diff) => [diff.filePath, diff.fqName, diff.symbolKind, diff.changeType]),
        [
          ["src/models.ts", "src/models.ts::User", SymbolKind.Interface, FileChangeType.Unchanged],
          ["src/service.ts", "src/service.ts::readUser", SymbolKind.Function, FileChangeType.Unchanged],
        ],
      );
      assert.deepEqual(getIndexRunSummary(db, secondRun!.id)?.symbolChangeCounts, {
        added: 0,
        removed: 0,
        modified: 0,
        unchanged: 2,
      });
    } finally {
      db.close();
    }
  });
});

test("added symbols are detected against the immediately previous run", async () => {
  await withFixture(async (repoRoot) => {
    await writeMemoryFixtureRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      await writeFile(
        path.join(repoRoot, "src", "extra.ts"),
        "export function extra(): void {}\n",
      );
      await indexProject({ repoRoot, db });

      const secondRun = listIndexRuns(db)[1];
      const diffs = listSymbolDiffsForRun(db, secondRun!.id);

      assert.deepEqual(
        diffs?.map((diff) => [diff.filePath, diff.fqName, diff.symbolKind, diff.changeType]),
        [
          ["src/extra.ts", "src/extra.ts::extra", SymbolKind.Function, FileChangeType.Added],
          ["src/models.ts", "src/models.ts::User", SymbolKind.Interface, FileChangeType.Unchanged],
          ["src/service.ts", "src/service.ts::readUser", SymbolKind.Function, FileChangeType.Unchanged],
        ],
      );
    } finally {
      db.close();
    }
  });
});

test("removed symbols are detected against the immediately previous run", async () => {
  await withFixture(async (repoRoot) => {
    await writeMemoryFixtureRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      await rm(path.join(repoRoot, "src", "models.ts"));
      await indexProject({ repoRoot, db });

      const secondRun = listIndexRuns(db)[1];
      const diffs = listSymbolDiffsForRun(db, secondRun!.id);

      assert.deepEqual(
        diffs?.map((diff) => [diff.filePath, diff.fqName, diff.symbolKind, diff.changeType]),
        [
          ["src/models.ts", "src/models.ts::User", SymbolKind.Interface, FileChangeType.Removed],
          ["src/service.ts", "src/service.ts::readUser", SymbolKind.Function, FileChangeType.Unchanged],
        ],
      );
    } finally {
      db.close();
    }
  });
});

test("modified symbols are detected from changed structural state", async () => {
  await withFixture(async (repoRoot) => {
    await writeMemoryFixtureRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      await writeFile(
        path.join(repoRoot, "src", "service.ts"),
        `
import { User } from "./models";
export function readUser(id: string): User { return { id }; }
`,
      );
      await indexProject({ repoRoot, db });

      const secondRun = listIndexRuns(db)[1];
      const diffs = listSymbolDiffsForRun(db, secondRun!.id);

      assert.deepEqual(
        diffs?.map((diff) => [diff.filePath, diff.fqName, diff.symbolKind, diff.changeType]),
        [
          ["src/models.ts", "src/models.ts::User", SymbolKind.Interface, FileChangeType.Unchanged],
          ["src/service.ts", "src/service.ts::readUser", SymbolKind.Function, FileChangeType.Modified],
        ],
      );
    } finally {
      db.close();
    }
  });
});

test("added files are detected against the immediately previous run", async () => {
  await withFixture(async (repoRoot) => {
    await writeMemoryFixtureRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      await writeFile(
        path.join(repoRoot, "src", "extra.ts"),
        "export function extra(): void {}\n",
      );
      await indexProject({ repoRoot, db });

      const secondRun = listIndexRuns(db)[1];
      const diffs = listFileDiffsForRun(db, secondRun!.id);

      assert.deepEqual(
        diffs?.map((diff) => [diff.filePath, diff.changeType]),
        [
          ["src/extra.ts", FileChangeType.Added],
          ["src/models.ts", FileChangeType.Unchanged],
          ["src/service.ts", FileChangeType.Unchanged],
        ],
      );
    } finally {
      db.close();
    }
  });
});

test("removed files are detected against the immediately previous run", async () => {
  await withFixture(async (repoRoot) => {
    await writeMemoryFixtureRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      await rm(path.join(repoRoot, "src", "models.ts"));
      await indexProject({ repoRoot, db });

      const secondRun = listIndexRuns(db)[1];
      const diffs = listFileDiffsForRun(db, secondRun!.id);

      assert.deepEqual(
        diffs?.map((diff) => [diff.filePath, diff.changeType]),
        [
          ["src/models.ts", FileChangeType.Removed],
          ["src/service.ts", FileChangeType.Unchanged],
        ],
      );
    } finally {
      db.close();
    }
  });
});

test("modified files are detected from changed file state", async () => {
  await withFixture(async (repoRoot) => {
    await writeMemoryFixtureRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      await writeFile(
        path.join(repoRoot, "src", "service.ts"),
        `
import { User } from "./models";
export function readUser(): User { return { id: "changed" }; }
`,
      );
      await indexProject({ repoRoot, db });

      const secondRun = listIndexRuns(db)[1];
      const diffs = listFileDiffsForRun(db, secondRun!.id);

      assert.deepEqual(
        diffs?.map((diff) => [diff.filePath, diff.changeType]),
        [
          ["src/models.ts", FileChangeType.Unchanged],
          ["src/service.ts", FileChangeType.Modified],
        ],
      );
    } finally {
      db.close();
    }
  });
});

test("repeated identical runs do not invent changes and file diff ordering is stable", async () => {
  await withFixture(async (repoRoot) => {
    await writeMemoryFixtureRepo(repoRoot);
    await writeFile(path.join(repoRoot, "src", "alpha.ts"), "export const alpha = 1;\n");
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      await indexProject({ repoRoot, db });
      await indexProject({ repoRoot, db });

      const runs = listIndexRuns(db);
      const secondDiffs = listFileDiffsForRun(db, runs[1]!.id);
      const thirdDiffs = listFileDiffsForRun(db, runs[2]!.id);
      const secondSymbolDiffs = listSymbolDiffsForRun(db, runs[1]!.id);
      const thirdSymbolDiffs = listSymbolDiffsForRun(db, runs[2]!.id);

      assert.deepEqual(
        secondDiffs?.map((diff) => ({
          filePath: diff.filePath,
          changeType: diff.changeType,
          previousState: diff.previousState,
          currentState: diff.currentState,
        })),
        thirdDiffs?.map((diff) => ({
          filePath: diff.filePath,
          changeType: diff.changeType,
          previousState: diff.previousState,
          currentState: diff.currentState,
        })),
      );
      assert.deepEqual(
        thirdDiffs?.map((diff) => diff.filePath),
        ["src/alpha.ts", "src/models.ts", "src/service.ts"],
      );
      assert.deepEqual(getIndexRunSummary(db, runs[2]!.id)?.fileChangeCounts, {
        added: 0,
        removed: 0,
        modified: 0,
        unchanged: 3,
      });
      assert.deepEqual(
        secondSymbolDiffs?.map((diff) => ({
          filePath: diff.filePath,
          fqName: diff.fqName,
          symbolKind: diff.symbolKind,
          changeType: diff.changeType,
          previousState: diff.previousState,
          currentState: diff.currentState,
        })),
        thirdSymbolDiffs?.map((diff) => ({
          filePath: diff.filePath,
          fqName: diff.fqName,
          symbolKind: diff.symbolKind,
          changeType: diff.changeType,
          previousState: diff.previousState,
          currentState: diff.currentState,
        })),
      );
      assert.deepEqual(
        thirdSymbolDiffs?.map((diff) => [diff.filePath, diff.fqName, diff.symbolKind]),
        [
          ["src/models.ts", "src/models.ts::User", SymbolKind.Interface],
          ["src/service.ts", "src/service.ts::readUser", SymbolKind.Function],
        ],
      );
      assert.deepEqual(getIndexRunSummary(db, runs[2]!.id)?.symbolChangeCounts, {
        added: 0,
        removed: 0,
        modified: 0,
        unchanged: 2,
      });
    } finally {
      db.close();
    }
  });
});

test("a controlled mixed Python/Cython fixture change updates run history and deterministic diffs", async () => {
  await withMixedPyCythonRepo(async (repoRoot) => {
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      await applyMixedPyCythonControlledChange(repoRoot);
      await indexProject({ repoRoot, db });

      const runs = listIndexRuns(db);
      const comparisonRun = runs[1];
      const fileDiffs = listFileDiffsForRun(db, comparisonRun!.id)!;
      const symbolDiffs = listSymbolDiffsForRun(db, comparisonRun!.id)!;
      const summary = getIndexRunSummary(db, comparisonRun!.id);

      assert.equal(runs.length, 2);
      assert.equal(comparisonRun?.previousRunId, runs[0]?.id);
      assert.deepEqual(summary?.fileChangeCounts, {
        added: 0,
        removed: 0,
        modified: 1,
        unchanged: MIXED_PY_CYTHON_FIXTURE_FILE_COUNT - 1,
      });
      assert.deepEqual(summary?.symbolChangeCounts, {
        added: 0,
        removed: 0,
        modified: 1,
        unchanged: MIXED_PY_CYTHON_FIXTURE_SYMBOL_COUNT - 1,
      });
      assert.deepEqual(
        fileDiffs.filter((diff) => diff.changeType === FileChangeType.Modified).map((diff) => diff.filePath),
        [MIXED_PY_CYTHON_BACKGROUND_FILE_PATH],
      );
      assert.deepEqual(
        symbolDiffs.filter((diff) => diff.changeType === FileChangeType.Modified).map((diff) => [
          diff.filePath,
          diff.fqName,
          diff.symbolKind,
        ]),
        [[
          MIXED_PY_CYTHON_BACKGROUND_FILE_PATH,
          MIXED_PY_CYTHON_CONTROLLED_CHANGE_SYMBOL_FQ_NAME,
          SymbolKind.Function,
        ]],
      );
      assert.deepEqual(listFileDiffsForRun(db, comparisonRun!.id), fileDiffs);
      assert.deepEqual(listSymbolDiffsForRun(db, comparisonRun!.id), symbolDiffs);
    } finally {
      db.close();
    }
  });
});

const unsupportedLanguageRegistry: ParserRegistry = {
  registerParser(): void {},
  getParser(): LanguageParser | undefined {
    return undefined;
  },
  async parse(input) {
    return {
      ok: false,
      error: ParserError.unsupportedLanguage(input.path, "ruby"),
    };
  },
};

async function withFixture(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-index-"));

  try {
    await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

async function writeBasicTypeScriptRepo(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "src", "models.ts"),
    "export interface User { id: string }\n",
  );
  await writeFile(
    path.join(repoRoot, "src", "service.ts"),
    `
import { User } from "./models";
export function readUser(): User { throw new Error("not implemented"); }
`,
  );
  await writeFile(path.join(repoRoot, "src", "script.py"), "value = 1\n");
  await writeFile(path.join(repoRoot, "src", "README.md"), "# ignored\n");
}

async function writeMemoryFixtureRepo(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "src", "models.ts"),
    "export interface User { id: string }\n",
  );
  await writeFile(
    path.join(repoRoot, "src", "service.ts"),
    `
import { User } from "./models";
export function readUser(): User { throw new Error("not implemented"); }
`,
  );
}

function knownFiles(files: readonly IndexProjectFileContent[]) {
  return files.map((file) => ({
    path: file.file.path,
    content: file.content,
  }));
}

function snapshotDatabase(db: Database) {
  return {
    files: db.query(`
      SELECT id, path, language, content_hash, size_bytes
      FROM files
      ORDER BY path
    `).all(),
    symbolsByFile: [
      listSymbolsForFile(db, "src/models.ts"),
      listSymbolsForFile(db, "src/service.ts"),
    ],
    edges: listAllEdges(db),
  };
}

function snapshotMixedDatabase(db: Database) {
  return {
    files: db.query(`
      SELECT id, path, language, content_hash, size_bytes
      FROM files
      ORDER BY path
    `).all(),
    symbols: listAllSymbols(db),
    edges: listAllEdges(db),
  };
}

function requireSymbol(
  symbols: readonly { localName: string; id: string }[],
  localName: string,
) {
  const symbol = symbols.find((candidate) => candidate.localName === localName);

  assert.notEqual(symbol, undefined);
  return symbol!;
}
