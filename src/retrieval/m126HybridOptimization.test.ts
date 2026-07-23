import { describe, expect, test } from "bun:test";

import { buildCapsuleV2 } from "../capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../capsuleV2/types";
import { openIndexerDatabase } from "../db/sqlite";
import {
  countCrossFileNeighborFiles,
  listCrossFileEdgeEndpointsForFile,
} from "../db/repositories/edgesRepository";
import { getSymbolById, getSymbolsByIds } from "../db/repositories/symbolsRepository";
import { EdgeType, SymbolKind } from "../domain/types";
import { searchSymbols } from "./searchSymbols";

describe("M126 hybrid optimization invariants", () => {
  test("broad-query rewrite preserves deterministic ranking and profiling is optional", () => {
    const db = openIndexerDatabase();
    try {
      seedFile(db, "f1", "src/public_assessment.py");
      seedFile(db, "f2", "src/model.py");
      seedFile(db, "f3", "src/noise.py");
      seedSymbol(db, "s1", "f1", "src/public_assessment.py", "PublicAssessment", "class PublicAssessment");
      seedSymbol(db, "s2", "f2", "src/model.py", "AssessmentModel", "class AssessmentModel");
      seedSymbol(db, "s3", "f3", "src/noise.py", "Unrelated", "class Unrelated");
      seedFts(db);

      const query = "find the public assessment model and assessment projection";
      const first = searchSymbols(db, { query, maxResults: 20 });
      const second = searchSymbols(db, { query, maxResults: 20 });
      expect(second).toEqual(first);
      expect(first.map((row) => row.symbolId)).toEqual(["s1", "s2"]);

      const withoutProfile = buildCapsuleV2({
        db, repoRoot: "/missing", task: query,
        intent: CapsuleIntent.Modify, maxTokens: 2_000,
      });
      expect(withoutProfile.diagnostics.hybrid_profile).toBeUndefined();
      expect(withoutProfile.diagnostics.capsule_profile).toBeUndefined();

      const withProfile = buildCapsuleV2({
        db, repoRoot: "/missing", task: query,
        intent: CapsuleIntent.Modify, maxTokens: 2_000,
        includeTimingDiagnostics: true,
      });
      const profile = withProfile.diagnostics.hybrid_profile;
      expect(profile).toBeDefined();
      expect(profile!.timingsMs.total).toBeGreaterThanOrEqual(
        profile!.timingsMs["lexical.symbol_search"] ?? 0,
      );
      expect(profile!.counters["symbols.before_scoring"]).toBeGreaterThanOrEqual(
        profile!.counters["candidates.after_cap"] ?? 0,
      );
      const serialized = JSON.stringify({
        hybrid: profile,
        capsule: withProfile.diagnostics.capsule_profile,
      });
      expect(serialized).not.toContain("class PublicAssessment");
      expect(serialized).not.toContain("class AssessmentModel");
    } finally {
      db.close();
    }
  });

  test("batched symbol materialization equals single-row lookup", () => {
    const db = openIndexerDatabase();
    try {
      seedFile(db, "f1", "src/a.py");
      seedSymbol(db, "s1", "f1", "src/a.py", "one", "def one()");
      seedSymbol(db, "s2", "f1", "src/a.py", "two", "def two()");
      const batch = getSymbolsByIds(db, ["s2", "s1", "s2", "missing"]);
      expect(batch.size).toBe(2);
      expect(batch.get("s1")).toEqual(getSymbolById(db, "s1"));
      expect(batch.get("s2")).toEqual(getSymbolById(db, "s2"));
      expect(batch.has("missing")).toBeFalse();
    } finally {
      db.close();
    }
  });

  test("directional UNION edge queries preserve both directions, edge order, and fan-out", () => {
    const db = openIndexerDatabase();
    try {
      for (const [id, file] of [["fa", "src/a.py"], ["fb", "src/b.py"], ["fc", "src/c.py"]] as const) {
        seedFile(db, id, file);
        seedSymbol(db, `s${id}`, id, file, id, `def ${id}()`);
      }
      seedEdge(db, "e2", "sfb", "sfa", EdgeType.References);
      seedEdge(db, "e1", "sfa", "sfc", EdgeType.Calls);
      seedEdge(db, "e3", "sfa", "sfa", EdgeType.Contains);

      const endpoints = listCrossFileEdgeEndpointsForFile(db, "src/a.py");
      expect(endpoints.map((row) => [row.otherPath, row.edgeType])).toEqual([
        ["src/c.py", EdgeType.Calls],
        ["src/b.py", EdgeType.References],
      ]);
      expect(countCrossFileNeighborFiles(db, "src/a.py")).toBe(2);
      expect(countCrossFileNeighborFiles(db, "src/b.py")).toBe(1);
    } finally {
      db.close();
    }
  });
});

function seedFile(db: ReturnType<typeof openIndexerDatabase>, id: string, filePath: string): void {
  db.run(
    "INSERT INTO files (id, path, language, content_hash, size_bytes) VALUES (?, ?, 'python', ?, 1)",
    [id, filePath, `${id}-hash`],
  );
}

function seedSymbol(
  db: ReturnType<typeof openIndexerDatabase>,
  id: string,
  fileId: string,
  filePath: string,
  localName: string,
  signature: string,
): void {
  db.run(
    `INSERT INTO symbols (
      id, file_id, fq_name, local_name, kind, signature,
      start_line, end_line, start_byte, end_byte, exported
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 0, 1, 1)`,
    [id, fileId, `${filePath}::${localName}`, localName, SymbolKind.Function, signature],
  );
}

function seedFts(db: ReturnType<typeof openIndexerDatabase>): void {
  db.run(`
    INSERT INTO symbol_search_fts (
      symbol_id, file_path_raw, local_name, fq_name, signature, docstring, file_path
    )
    SELECT symbols.id, files.path, symbols.local_name, symbols.fq_name,
           symbols.signature, COALESCE(symbols.docstring, ''), files.path
    FROM symbols INNER JOIN files ON files.id = symbols.file_id
  `);
}

function seedEdge(
  db: ReturnType<typeof openIndexerDatabase>,
  id: string,
  src: string,
  dst: string,
  type: EdgeType,
): void {
  db.run(
    "INSERT INTO edges (id, src_symbol_id, dst_symbol_id, edge_type, confidence) VALUES (?, ?, ?, ?, 1)",
    [id, src, dst, type],
  );
}
