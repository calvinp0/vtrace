import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { normalizedGraphHash } from "./normalizedGraph";
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
import { listFileIndexFailures } from "../db/repositories/fileIndexFailuresRepository";
import { FileFailureClass } from "./fileFailureClassification";
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
        [["<module>", SymbolKind.Module], ["integrate", SymbolKind.Function]],
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

      // M140: the import is owned by service.pyx's module scope, and
      // `import pkg.runtime_target` targets runtime_target.pyx's module scope.
      assert.deepEqual(
        serviceSymbols.map((symbol) => [symbol.localName, symbol.kind]),
        [["<module>", SymbolKind.Module], ["use_runtime", SymbolKind.Function]],
      );
      assert.equal(serviceEdges.length, 1);
      assert.equal(serviceEdges[0]?.edgeType, EdgeType.Imports);
      assert.equal(
        serviceEdges[0]?.srcSymbolId,
        serviceSymbols.find((symbol) => symbol.kind === SymbolKind.Module)?.id,
      );
      assert.equal(
        serviceEdges[0]?.dstSymbolId,
        runtimeSymbols.find((symbol) => symbol.kind === SymbolKind.Module)?.id,
      );
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
          ["<module>", SymbolKind.Module],
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
        [["<module>", SymbolKind.Module], ["diffuse_profile", SymbolKind.Function]],
      );
      assert.equal(listAllSymbols(db).length, MIXED_PY_CYTHON_FIXTURE_SYMBOL_COUNT);
      assert.equal(listAllEdges(db).length, MIXED_PY_CYTHON_FIXTURE_EDGE_COUNT);
      // The Cython kernel now carries both imports and statically resolved
      // calls to the same imported/cimported/included targets.
      const kernelImports = kernelEdges.filter((edge) => edge.edgeType === EdgeType.Imports);
      const kernelCalls = kernelEdges.filter((edge) => edge.edgeType === EdgeType.Calls);
      const kernelCallTargets = [
        backgroundSymbol.id,
        clampWindowSymbol.id,
        declaredStepSymbol.id,
        stencilSmoothSymbol.id,
      ].sort();
      // M140: the four imports are owned by the kernel's module scope, and the
      // `include` of stencil_ops.pxi resolves to that file's module scope
      // rather than to whichever single definition it happened to contain. The
      // four statically resolved CALLS still belong to `diffuse_profile`.
      const kernelModuleSymbol = requireSymbol(
        listSymbolsForFile(db, MIXED_PY_CYTHON_KERNEL_FILE_PATH),
        "<module>",
      );
      const stencilModuleSymbol = requireSymbol(
        listSymbolsForFile(db, "src/spectra_lab/kernels/stencil_ops.pxi"),
        "<module>",
      );
      const kernelImportTargets = [
        backgroundSymbol.id,
        clampWindowSymbol.id,
        declaredStepSymbol.id,
        stencilModuleSymbol.id,
      ].sort();

      assert.equal(kernelEdges.length, 8);
      assert.equal(kernelImports.every((edge) => edge.srcSymbolId === kernelModuleSymbol.id), true);
      assert.equal(kernelCalls.every((edge) => edge.srcSymbolId === kernelSymbol.id), true);
      assert.equal(kernelImports.length, 4);
      assert.equal(kernelCalls.length, 4);
      assert.deepEqual(kernelImports.map((edge) => edge.dstSymbolId).sort(), kernelImportTargets);
      assert.deepEqual(kernelCalls.map((edge) => edge.dstSymbolId).sort(), kernelCallTargets);
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

test("M156: one unparseable file does not make the repository unavailable", async () => {
  await withFixture(async (repoRoot) => {
    await writeBasicTypeScriptRepo(repoRoot);
    await writeFile(path.join(repoRoot, "src", "script.py"), "def broken(:\n    return 1\n");
    const db = openIndexerDatabase();

    try {
      const result = await indexProject({ repoRoot, db });

      // The other files are indexed normally.
      assert.notEqual(getFileByPath(db, "src/service.ts"), undefined);
      assert.notEqual(getFileByPath(db, "src/models.ts"), undefined);
      assert.equal(result.totalParseFailures, 1);

      // The failed file leaves NO authoritative evidence behind (§14), and is
      // absent from `files` so path membership never claims we indexed it.
      assert.equal(getFileByPath(db, "src/script.py"), undefined);
      assert.equal(listSymbolsForFile(db, "src/script.py").length, 0);
      // Every lane that could carry a trace of it, checked by name rather than
      // trusted to cascade.
      assert.deepEqual(countRowsMatchingPath(db, "src/script.py"), {
        symbols: 0,
        edges: 0,
        mechanismFacts: 0,
        bodyLiterals: 0,
        documentChunks: 0,
        symbolSearchFts: 0,
      });

      // But it is recorded, so the index knows the file exists and failed (§15).
      const failures = listFileIndexFailures(db);
      assert.equal(failures.length, 1);
      assert.equal(failures[0]?.path, "src/script.py");
      assert.equal(failures[0]?.status, "parse_failed");
      assert.equal(failures[0]?.failureClass, FileFailureClass.SyntaxError);

      // Coverage is degraded, not complete, and the arithmetic holds (§76, §77).
      assert.equal(result.coverage.complete, false);
      assert.equal(result.coverage.filesFailed, 1);
      assert.equal(
        result.coverage.filesIndexed + result.coverage.filesFailed + result.coverage.filesSkipped,
        result.coverage.filesEligible,
      );
    } finally {
      db.close();
    }
  });
});

test("M156: a failed Cython file is contained exactly like a failed Python file", async () => {
  await withFixture(async (repoRoot) => {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "service.ts"), "export function ok() { return 1; }\n");
    await writeFile(path.join(repoRoot, "src", "broken.pyx"), "cdef int broken(\n    return 1\n");
    const db = openIndexerDatabase();

    try {
      const result = await indexProject({ repoRoot, db });

      assert.notEqual(getFileByPath(db, "src/service.ts"), undefined);
      assert.equal(getFileByPath(db, "src/broken.pyx"), undefined);
      assert.equal(result.totalParseFailures, 1);
      assert.equal(listFileIndexFailures(db).map((failure) => failure.path).join(), "src/broken.pyx");
      assert.equal(result.coverage.failedLanguages.join(), "cython");
    } finally {
      db.close();
    }
  });
});

test("M156: the repository outcome does not depend on where the bad file sorts", async () => {
  // §12. Enumeration is alphabetical, so these three names place the failure
  // before, between, and after the files that must survive it.
  for (const badName of ["aaa_broken.py", "mmm_broken.py", "zzz_broken.py"]) {
    await withFixture(async (repoRoot) => {
      await mkdir(path.join(repoRoot, "src"), { recursive: true });
      await writeFile(path.join(repoRoot, "src", "ccc_first.py"), "def first():\n    return 1\n");
      await writeFile(path.join(repoRoot, "src", "ttt_last.py"), "def last():\n    return 2\n");
      await writeFile(path.join(repoRoot, "src", badName), "def broken(:\n    return 1\n");
      const db = openIndexerDatabase();

      try {
        const result = await indexProject({ repoRoot, db });

        assert.equal(result.coverage.filesIndexed, 2, `indexed count for ${badName}`);
        assert.equal(result.coverage.filesFailed, 1, `failed count for ${badName}`);
        assert.notEqual(getFileByPath(db, "src/ccc_first.py"), undefined);
        assert.notEqual(getFileByPath(db, "src/ttt_last.py"), undefined);
        assert.equal(listFileIndexFailures(db).map((failure) => failure.path).join(), `src/${badName}`);
      } finally {
        db.close();
      }
    });
  }
});

test("M156: a persistence failure still ends the run for the whole repository", async () => {
  // §30/§31: containment is for malformed SOURCE. A graph the indexer cannot
  // validate indicts the index itself and must never become a degraded success.
  await withFixture(async (repoRoot) => {
    await writeBasicTypeScriptRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      await assert.rejects(
        indexProject({
          repoRoot,
          db,
          validateGraph: () => {
            throw new Error("simulated index corruption");
          },
        }),
      );
      // Nothing was committed: the transaction rolled back in full.
      assert.equal(getFileByPath(db, "src/service.ts"), undefined);
      assert.equal(listFileIndexFailures(db).length, 0);
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
  registeredLanguages() {
    return [];
  },
  async parse(input) {
    return {
      ok: false,
      error: ParserError.unsupportedLanguage(input.path, "ruby"),
    };
  },
};

test("a .gitignore entry excludes a file from indexing", async () => {
  await withFixture(async (repoRoot) => {
    await writeMemoryFixtureRepo(repoRoot);
    await writeFile(path.join(repoRoot, ".gitignore"), "src/models.ts\n");
    const db = openIndexerDatabase();

    try {
      const result = await indexProject({ repoRoot, db });

      assert.equal(getFileByPath(db, "src/models.ts"), undefined);
      assert.deepEqual(listSymbolsForFile(db, "src/models.ts"), []);
      assert.equal(getFileByPath(db, "src/service.ts")?.path, "src/service.ts");
      assert.equal(result.files.some((file) => file.path === "src/models.ts"), false);
    } finally {
      db.close();
    }
  });
});

test("a .vtraceignore entry excludes a file from indexing", async () => {
  await withFixture(async (repoRoot) => {
    await writeMemoryFixtureRepo(repoRoot);
    await writeFile(path.join(repoRoot, ".vtraceignore"), "*.models.ts\nsrc/models.ts\n");
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });

      assert.equal(getFileByPath(db, "src/models.ts"), undefined);
      assert.equal(getFileByPath(db, "src/service.ts")?.path, "src/service.ts");
    } finally {
      db.close();
    }
  });
});

test("built-in ignored directories are still excluded by default", async () => {
  await withFixture(async (repoRoot) => {
    await writeMemoryFixtureRepo(repoRoot);
    await mkdir(path.join(repoRoot, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "node_modules", "pkg", "index.ts"),
      "export const fromDependency = 1;\n",
    );
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });

      assert.equal(getFileByPath(db, "node_modules/pkg/index.ts"), undefined);
      assert.equal(listSymbolsForFile(db, "node_modules/pkg/index.ts").length, 0);
    } finally {
      db.close();
    }
  });
});

test("an ignored file produces no parser outcome and no error", async () => {
  await withFixture(async (repoRoot) => {
    await writeMemoryFixtureRepo(repoRoot);
    // A syntactically broken file that would normally surface a parse failure.
    await writeFile(path.join(repoRoot, "src", "broken.ts"), "export function broken( {");
    await writeFile(path.join(repoRoot, ".gitignore"), "src/broken.ts\n");
    const db = openIndexerDatabase();

    try {
      const result = await indexProject({ repoRoot, db });

      assert.equal(result.files.some((file) => file.path === "src/broken.ts"), false);
      assert.equal(result.totalParseFailures, 0);
      assert.equal(result.totalReadFailures, 0);
      assert.equal(getFileByPath(db, "src/broken.ts"), undefined);
    } finally {
      db.close();
    }
  });
});

test("deleting a file and reindexing removes its file, symbols, and edges from the live graph", async () => {
  await withFixture(async (repoRoot) => {
    await writeMemoryFixtureRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });

      const removedSymbolIds = listSymbolsForFile(db, "src/models.ts").map((symbol) => symbol.id);
      assert.equal(removedSymbolIds.length > 0, true);
      // The cross-file import/reference edges into models.ts exist before deletion.
      assert.equal(listEdgesForFile(db, "src/service.ts").length > 0, true);

      await rm(path.join(repoRoot, "src", "models.ts"));
      await indexProject({ repoRoot, db });

      // file row removed
      assert.equal(getFileByPath(db, "src/models.ts"), undefined);
      // symbols removed
      assert.deepEqual(listSymbolsForFile(db, "src/models.ts"), []);
      // edges referencing the removed symbols removed (cascade)
      const danglingEdges = listAllEdges(db).filter(
        (edge) =>
          removedSymbolIds.includes(edge.srcSymbolId)
          || removedSymbolIds.includes(edge.dstSymbolId),
      );
      assert.deepEqual(danglingEdges, []);
      assert.deepEqual(listEdgesForFile(db, "src/service.ts"), []);
      // surviving file is intact
      assert.equal(getFileByPath(db, "src/service.ts")?.path, "src/service.ts");
      assertGraphIntegrity(db);
    } finally {
      db.close();
    }
  });
});

test("changing a previously indexed file to ignored prunes it from the live graph", async () => {
  await withFixture(async (repoRoot) => {
    await writeMemoryFixtureRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      assert.equal(getFileByPath(db, "src/models.ts")?.path, "src/models.ts");

      await writeFile(path.join(repoRoot, ".vtraceignore"), "src/models.ts\n");
      await indexProject({ repoRoot, db });

      assert.equal(getFileByPath(db, "src/models.ts"), undefined);
      assert.deepEqual(listSymbolsForFile(db, "src/models.ts"), []);
      assertGraphIntegrity(db);
    } finally {
      db.close();
    }
  });
});

test("run history still reports a removed file while the live graph is pruned", async () => {
  await withFixture(async (repoRoot) => {
    await writeMemoryFixtureRepo(repoRoot);
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      await rm(path.join(repoRoot, "src", "models.ts"));
      await indexProject({ repoRoot, db });

      // Active graph reflects current repo state only.
      assert.equal(getFileByPath(db, "src/models.ts"), undefined);

      // Run history still reports the removal from its per-run snapshots.
      const secondRun = listIndexRuns(db)[1];
      const fileDiffs = listFileDiffsForRun(db, secondRun!.id);
      const symbolDiffs = listSymbolDiffsForRun(db, secondRun!.id);

      assert.equal(
        fileDiffs?.some(
          (diff) => diff.filePath === "src/models.ts" && diff.changeType === FileChangeType.Removed,
        ),
        true,
      );
      assert.equal(
        symbolDiffs?.some(
          (diff) =>
            diff.filePath === "src/models.ts" && diff.changeType === FileChangeType.Removed,
        ),
        true,
      );
    } finally {
      db.close();
    }
  });
});

test("repeated reindex with ignore files produces a deterministic active graph", async () => {
  await withFixture(async (repoRoot) => {
    await writeMemoryFixtureRepo(repoRoot);
    await writeFile(path.join(repoRoot, ".gitignore"), "src/models.ts\n");
    const db = openIndexerDatabase();

    try {
      await indexProject({ repoRoot, db });
      const firstSnapshot = snapshotMixedDatabase(db);
      await indexProject({ repoRoot, db });
      const secondSnapshot = snapshotMixedDatabase(db);

      assert.deepEqual(secondSnapshot, firstSnapshot);
      assert.equal(getFileByPath(db, "src/models.ts"), undefined);
      assertGraphIntegrity(db);
    } finally {
      db.close();
    }
  });
});

test("validation failure rolls back the complete live graph mutation", async () => {
  await withFixture(async (repoRoot) => {
    await writeBasicTypeScriptRepo(repoRoot);
    const db = openIndexerDatabase();
    try {
      const first = await indexProject({ repoRoot, db, parserVersion: "test-parser", parserConfigFingerprint: "test-config" });
      const before = normalizedGraphHash(db);
      await writeFile(path.join(repoRoot, "src", "service.ts"), `
import { User } from "./models";
export function readUser(): User { throw new Error("changed content"); }
`);
      await assert.rejects(
        indexProject({
          repoRoot,
          db,
          parserVersion: "test-parser",
          parserConfigFingerprint: "test-config",
          previousSnapshot: first.snapshot,
          validateGraph: () => { throw new Error("injected validation failure"); },
        }),
        /injected validation failure/,
      );
      assert.equal(normalizedGraphHash(db), before);
    } finally {
      db.close();
    }
  });
});

test("M156: a file that regresses to unparseable loses its stale evidence", async () => {
  // §36, and a deliberate REVERSAL of the pre-M156 contract. This test used to
  // assert that the graph was byte-identical after the failure — which is only
  // true because the run aborted, leaving `service` indexed and authoritative
  // from source that no longer parses. Aborting is what made the stale answer
  // survive. Containing the failure is what removes it.
  await withFixture(async (repoRoot) => {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "service.py"), "def service():\n    return 1\n");
    await writeFile(path.join(repoRoot, "src", "other.py"), "def other():\n    return 2\n");
    const db = openIndexerDatabase();
    try {
      const first = await indexProject({
        repoRoot, db, parserVersion: "test-parser", parserConfigFingerprint: "test-config",
      });
      assert.equal(listSymbolsForFile(db, "src/service.py").length > 0, true);

      await writeFile(path.join(repoRoot, "src", "service.py"), "def broken(:\n    return 1\n");
      const second = await indexProject({
        repoRoot, db, parserVersion: "test-parser", parserConfigFingerprint: "test-config",
        previousSnapshot: first.snapshot,
      });

      // The stale symbol is gone, transactionally, and the file is recorded as
      // failed rather than silently omitted.
      assert.equal(getFileByPath(db, "src/service.py"), undefined);
      assert.equal(listSymbolsForFile(db, "src/service.py").length, 0);
      // §36: not merely absent from `files` — gone from every evidence lane, so
      // `service` cannot still be answered from source that no longer parses.
      assert.deepEqual(countRowsMatchingPath(db, "src/service.py"), {
        symbols: 0,
        edges: 0,
        mechanismFacts: 0,
        bodyLiterals: 0,
        documentChunks: 0,
        symbolSearchFts: 0,
      });
      assert.equal(listFileIndexFailures(db).map((failure) => failure.path).join(), "src/service.py");
      assert.equal(second.coverage.complete, false);

      // The unrelated file is untouched and still queryable.
      assert.notEqual(getFileByPath(db, "src/other.py"), undefined);
      assert.equal(listSymbolsForFile(db, "src/other.py").length > 0, true);
    } finally {
      db.close();
    }
  });
});

test("M156: repairing a failed file restores its evidence on the next run", async () => {
  // §37: no manual full rebuild required.
  await withFixture(async (repoRoot) => {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "service.py"), "def broken(:\n    return 1\n");
    await writeFile(path.join(repoRoot, "src", "other.py"), "def other():\n    return 2\n");
    const db = openIndexerDatabase();
    try {
      const first = await indexProject({
        repoRoot, db, parserVersion: "test-parser", parserConfigFingerprint: "test-config",
      });
      assert.equal(first.coverage.filesFailed, 1);

      await writeFile(path.join(repoRoot, "src", "service.py"), "def service():\n    return 1\n");
      const second = await indexProject({
        repoRoot, db, parserVersion: "test-parser", parserConfigFingerprint: "test-config",
        previousSnapshot: first.snapshot,
      });

      assert.equal(second.coverage.filesFailed, 0);
      assert.equal(second.coverage.complete, true);
      assert.equal(listFileIndexFailures(db).length, 0);
      assert.notEqual(getFileByPath(db, "src/service.py"), undefined);
      assert.equal(listSymbolsForFile(db, "src/service.py").length > 0, true);
    } finally {
      db.close();
    }
  });
});

test("M156: an unrelated edit still indexes while a failure persists", async () => {
  // §35: a standing failure must not freeze incremental maintenance.
  await withFixture(async (repoRoot) => {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "broken.py"), "def broken(:\n    return 1\n");
    await writeFile(path.join(repoRoot, "src", "other.py"), "def other():\n    return 2\n");
    const db = openIndexerDatabase();
    try {
      const first = await indexProject({
        repoRoot, db, parserVersion: "test-parser", parserConfigFingerprint: "test-config",
      });

      await writeFile(path.join(repoRoot, "src", "other.py"), "def other():\n    return 2\n\ndef added():\n    return 3\n");
      const second = await indexProject({
        repoRoot, db, parserVersion: "test-parser", parserConfigFingerprint: "test-config",
        previousSnapshot: first.snapshot,
      });

      assert.equal(second.coverage.filesFailed, 1);
      assert.equal(listFileIndexFailures(db).map((failure) => failure.path).join(), "src/broken.py");
      assert.equal(
        listSymbolsForFile(db, "src/other.py").some((symbol) => symbol.localName === "added"),
        true,
      );
    } finally {
      db.close();
    }
  });
});

test("M156: a full index and an equivalent incremental history agree", async () => {
  // §38: the failed-file set, the successful evidence and the coverage metadata
  // must not depend on how the index got there.
  const build = async (repoRoot: string, incremental: boolean): Promise<{
    graph: string; failures: string; coverage: string;
  }> => {
    const db = openIndexerDatabase();
    try {
      const first = await indexProject({
        repoRoot, db, parserVersion: "test-parser", parserConfigFingerprint: "test-config",
      });
      await writeFile(path.join(repoRoot, "src", "other.py"), "def other():\n    return 9\n");
      const second = await indexProject({
        repoRoot,
        db,
        parserVersion: "test-parser",
        parserConfigFingerprint: "test-config",
        ...(incremental ? { previousSnapshot: first.snapshot } : {}),
      });
      return {
        graph: normalizedGraphHash(db),
        failures: JSON.stringify(listFileIndexFailures(db)),
        coverage: JSON.stringify(second.coverage),
      };
    } finally {
      db.close();
    }
  };

  const seed = async (repoRoot: string): Promise<void> => {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "broken.py"), "def broken(:\n    return 1\n");
    await writeFile(path.join(repoRoot, "src", "other.py"), "def other():\n    return 2\n");
  };

  let incrementalResult: Awaited<ReturnType<typeof build>> | undefined;
  let fullResult: Awaited<ReturnType<typeof build>> | undefined;
  await withFixture(async (repoRoot) => {
    await seed(repoRoot);
    incrementalResult = await build(repoRoot, true);
  });
  await withFixture(async (repoRoot) => {
    await seed(repoRoot);
    fullResult = await build(repoRoot, false);
  });

  assert.deepEqual(incrementalResult, fullResult);
});

/**
 * M156 §14. Every table that could hold semantic evidence for a path, counted by
 * name. Relying on `ON DELETE CASCADE` would test SQLite rather than the
 * invariant, and the FTS tables have no foreign key at all.
 */
function countRowsMatchingPath(db: Database, filePath: string): Record<string, number> {
  const scalar = (sql: string, ...params: string[]): number =>
    (db.query(sql).get(...params) as { count: number }).count;
  return {
    symbols: scalar(
      "SELECT COUNT(*) AS count FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ?",
      filePath,
    ),
    edges: scalar(
      "SELECT COUNT(*) AS count FROM edges e JOIN symbols s ON s.id IN (e.src_symbol_id, e.dst_symbol_id) "
      + "JOIN files f ON f.id = s.file_id WHERE f.path = ?",
      filePath,
    ),
    mechanismFacts: scalar(
      "SELECT COUNT(*) AS count FROM symbol_mechanism_facts WHERE file_path_raw = ?",
      filePath,
    ),
    bodyLiterals: scalar(
      "SELECT COUNT(*) AS count FROM symbol_body_literals_fts WHERE file_path_raw = ?",
      filePath,
    ),
    documentChunks: scalar(
      "SELECT COUNT(*) AS count FROM document_chunks c JOIN files f ON f.id = c.file_id WHERE f.path = ?",
      filePath,
    ),
    symbolSearchFts: scalar(
      "SELECT COUNT(*) AS count FROM symbol_search_fts WHERE file_path_raw = ?",
      filePath,
    ),
  };
}

function assertGraphIntegrity(db: Database): void {
  const danglingEdges = db.query(`
    SELECT src_symbol_id, dst_symbol_id
    FROM edges
    WHERE src_symbol_id NOT IN (SELECT id FROM symbols)
       OR dst_symbol_id NOT IN (SELECT id FROM symbols)
  `).all();
  assert.deepEqual(danglingEdges, []);

  const orphanSymbols = db.query(`
    SELECT id
    FROM symbols
    WHERE file_id NOT IN (SELECT id FROM files)
  `).all();
  assert.deepEqual(orphanSymbols, []);

  const orphanFtsRows = db.query(`
    SELECT file_path_raw
    FROM symbol_search_fts
    WHERE file_path_raw NOT IN (SELECT path FROM files)
  `).all();
  assert.deepEqual(orphanFtsRows, []);
}

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
