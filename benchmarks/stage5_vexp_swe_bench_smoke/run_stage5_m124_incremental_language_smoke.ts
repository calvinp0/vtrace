import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { indexProject } from "../../src/indexer/indexProject";
import { normalizeGraph, normalizedGraphHash } from "../../src/indexer/normalizedGraph";
import { searchSymbols } from "../../src/retrieval/searchSymbols";
import { SymbolSearchBackend } from "../../src/retrieval/types";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");

async function main(): Promise<void> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-m124-smoke-"));
  const incrementalDb = openIndexerDatabase();
  const fullDb = openIndexerDatabase();
  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await mkdir(path.join(repoRoot, "frontend"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "app.py"), "def application():\n    return 'ready'\n");
    await writeFile(path.join(repoRoot, "src", "helper.ts"), "export function helper(): number { return 1; }\n");
    await writeFile(path.join(repoRoot, "frontend", "eslint.config.js"), "export default [{ rules: {} }];\n");

    const initialFull = await indexProject({ repoRoot, db: incrementalDb, refreshMode: "full", parserVersion: "m124-smoke", parserConfigFingerprint: "m124-smoke-config" });
    const noop = await indexProject({ repoRoot, db: incrementalDb, refreshMode: "incremental", previousSnapshot: initialFull.snapshot, parserVersion: "m124-smoke", parserConfigFingerprint: "m124-smoke-config" });
    await writeFile(path.join(repoRoot, "src", "helper.ts"), "export function helper(): number { return 2; }\n");
    const incremental = await indexProject({ repoRoot, db: incrementalDb, refreshMode: "incremental", previousSnapshot: noop.snapshot, parserVersion: "m124-smoke", parserConfigFingerprint: "m124-smoke-config" });
    const cleanFull = await indexProject({ repoRoot, db: fullDb, refreshMode: "full", parserVersion: "m124-smoke", parserConfigFingerprint: "m124-smoke-config" });
    const explicitFull = await indexProject({ repoRoot, db: incrementalDb, refreshMode: "full", previousSnapshot: incremental.snapshot, parserVersion: "m124-smoke", parserConfigFingerprint: "m124-smoke-config" });

    const incrementalGraph = normalizeGraph(incrementalDb);
    const fullGraph = normalizeGraph(fullDb);
    const incrementalRetrieval = searchSymbols(incrementalDb, { query: "helper", maxResults: 5, backend: SymbolSearchBackend.Fts });
    const fullRetrieval = searchSymbols(fullDb, { query: "helper", maxResults: 5, backend: SymbolSearchBackend.Fts });
    const detail = {
      schemaVersion: "stage5.m124.incremental-language-smoke.v1",
      fixture: {
        files: ["src/app.py", "src/helper.ts", "frontend/eslint.config.js"],
        javascriptPolicy: "recognized_unsupported",
      },
      runs: {
        cleanFull: summarize(cleanFull),
        initialFull: summarize(initialFull),
        incrementalOneSupportedEdit: summarize(incremental),
        incrementalNoop: summarize(noop),
        explicitFullWithPreviousSnapshot: summarize(explicitFull),
      },
      equivalence: {
        snapshot: JSON.stringify(incremental.snapshot?.files) === JSON.stringify(cleanFull.snapshot?.files),
        graph: normalizedGraphHash(incrementalDb) === normalizedGraphHash(fullDb),
        files: JSON.stringify(incrementalGraph.files) === JSON.stringify(fullGraph.files),
        symbols: JSON.stringify(incrementalGraph.symbols) === JSON.stringify(fullGraph.symbols),
        edges: JSON.stringify(incrementalGraph.edges) === JSON.stringify(fullGraph.edges),
        ftsRows: JSON.stringify(incrementalGraph.symbolSearch) === JSON.stringify(fullGraph.symbolSearch),
        retrievalIndexHash: hash({ symbolSearch: incrementalGraph.symbolSearch, bodyLiterals: incrementalGraph.bodyLiterals }) === hash({ symbolSearch: fullGraph.symbolSearch, bodyLiterals: fullGraph.bodyLiterals }),
        representativeRetrieval: JSON.stringify(incrementalRetrieval) === JSON.stringify(fullRetrieval),
      },
      hashes: {
        normalizedGraph: normalizedGraphHash(incrementalDb),
        retrievalIndex: hash({ symbolSearch: incrementalGraph.symbolSearch, bodyLiterals: incrementalGraph.bodyLiterals }),
      },
      representativeRetrieval: incrementalRetrieval,
      pass: false,
    };
    detail.pass = Object.values(detail.equivalence).every(Boolean)
      && incremental.totalSkippedUnregisteredLanguage === 1
      && explicitFull.performance?.previousGraphSnapshotUsedForMutation === false;
    await writeFile(path.join(RESULTS, "stage5_m124_incremental_language_smoke.detail.json"), `${JSON.stringify(detail, null, 2)}\n`);
  } finally {
    incrementalDb.close();
    fullDb.close();
    await rm(repoRoot, { recursive: true, force: true });
  }
}

function summarize(result: Awaited<ReturnType<typeof indexProject>>) {
  return {
    mode: result.performance?.mode ?? null,
    filesDiscovered: result.totalFilesScanned,
    filesIndexed: result.totalFilesSuccessfullyIndexed,
    filesSkippedUnregistered: result.totalSkippedUnregisteredLanguage,
    filesParsed: result.performance?.parsedFiles ?? null,
    unsupportedFilesCarriedForward: result.performance?.unsupportedFilesCarriedForward ?? null,
    cacheHits: result.performance?.parseCacheHits ?? null,
    cacheMisses: result.performance?.parseCacheMisses ?? null,
    totalLatencyMs: result.performance?.timingsMs.total ?? null,
    previousGraphSnapshotUsedForMutation: result.performance?.previousGraphSnapshotUsedForMutation ?? null,
    fileOutcomes: result.files,
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

await main();
