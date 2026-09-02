import type { Database } from "bun:sqlite";

import {
  normalizeFilePath,
  type FilePath,
  type ImportDescriptor,
  type ModuleBindingSurface,
  type ParseResult,
} from "../domain/types";
import { bindingSurfaceDigest } from "../indexer/incrementalIndex";
import {
  replaceBodyLiteralsForFile,
  type SymbolBodyLiterals,
} from "./repositories/bodyLiteralsRepository";
import {
  replaceMechanismFactsForFile,
} from "./repositories/mechanismFactsRepository";
import type { SymbolMechanismFacts } from "../indexer/extractMechanismFacts";
import { insertEdges } from "./repositories/edgesRepository";
import { replaceFile } from "./repositories/filesRepository";
import { replaceSymbolSearchIndexForFile } from "./repositories/symbolSearchFtsRepository";
import { insertSymbolsForFile } from "./repositories/symbolsRepository";

export interface PersistParseResultOptions {
  /**
   * Pre-extracted distinctive body literals (diagnostic codes / messages) for the
   * file's symbols, built at index time from the raw file content (which a
   * `ParseResult` does not carry). When provided, the file's body-literal index is
   * replaced; when omitted, it is left untouched — legacy/test callers that do not
   * index bodies are unaffected.
   */
  readonly bodyLiterals?: readonly SymbolBodyLiterals[];
  /**
   * Pre-extracted decision-bearing mechanism facts (M150), built from the same
   * raw content and the same byte ranges as `bodyLiterals`. Same contract: when
   * provided the file's facts are replaced, when omitted they are left untouched,
   * so a caller that does not index bodies is unaffected.
   */
  readonly mechanismFacts?: readonly SymbolMechanismFacts[];
}

export function persistParseResult(
  db: Database,
  parseResult: ParseResult,
  options: PersistParseResultOptions = {},
): void {
  const normalizedPath = normalizeFilePath(parseResult.file.path);
  const file = {
    ...parseResult.file,
    path: normalizedPath,
  };
  const transaction = db.transaction(() => {
    replaceFile(db, file);
    insertSymbolsForFile(db, file, parseResult.symbols);
    replaceSymbolSearchIndexForFile(db, file, parseResult.symbols);
    if (options.bodyLiterals !== undefined) {
      replaceBodyLiteralsForFile(db, file, options.bodyLiterals);
    }
    if (options.mechanismFacts !== undefined) {
      replaceMechanismFactsForFile(db, file, options.mechanismFacts);
    }
    // M200. Written unconditionally, including the absent case: a file whose
    // parser models no bindings must end with NO binding rows, not with the rows
    // it had before some earlier parser produced them.
    replaceModuleBindingsForFile(db, normalizedPath, parseResult.bindingSurface, parseResult.importDescriptors);
    insertEdges(db, parseResult.edges);
  });

  transaction();
}

// ---------------------------------------------------------------------------
//
// Replace-per-file, like every other repository here: a refresh that rewrites a
// file's rows must not leave a row from its previous shape behind, and deleting
// by path is the only operation that is correct whether the file gained
// bindings, lost them, or was never indexed before.
// ---------------------------------------------------------------------------


export function replaceModuleBindingsForFile(
  db: Database,
  filePath: FilePath,
  surface: ModuleBindingSurface | undefined,
  descriptors: readonly ImportDescriptor[] | undefined,
): void {
  const path = normalizeFilePath(filePath);
  db.run("DELETE FROM module_bindings WHERE file_path = ?", [path]);
  db.run("DELETE FROM module_binding_surfaces WHERE file_path = ?", [path]);
  db.run("DELETE FROM import_descriptors WHERE file_path = ?", [path]);

  // Absent is not empty. A parser that does not model bindings must leave no
  // row at all, so `isAvailable`/`surfaceOf` can answer "cannot say" rather than
  // "publishes nothing" — the difference between a rebuild and a wrong closure.
  if (surface === undefined) return;

  db.run(
    `INSERT INTO module_binding_surfaces (file_path, is_package_surface, unbounded_names, surface_digest)
     VALUES (?, ?, ?, ?)`,
    [path, surface.isPackageSurface ? 1 : 0, surface.unboundedNames ? 1 : 0, bindingSurfaceDigest(surface)],
  );

  const insertBinding = db.prepare(
    `INSERT OR REPLACE INTO module_bindings (file_path, local_name, binding_kind, imported_name, target_path)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const binding of surface.bindings) {
    insertBinding.run(
      path, binding.localName, binding.kind,
      binding.importedName, binding.targetPath === null ? null : normalizeFilePath(binding.targetPath),
    );
  }

  const insertDescriptor = db.prepare(
    `INSERT INTO import_descriptors
       (file_path, ordinal, form, requested_module, relative_level, imported_name,
        local_name, resolved_target_path, resolution_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  (descriptors ?? []).forEach((descriptor, ordinal) => {
    insertDescriptor.run(
      path, ordinal, descriptor.form, descriptor.requestedModule, descriptor.relativeLevel,
      descriptor.importedName, descriptor.localName,
      descriptor.resolvedTargetPath === null ? null : normalizeFilePath(descriptor.resolvedTargetPath),
      descriptor.resolutionStatus,
    );
  });
}

export function deleteModuleBindingsForFile(db: Database, filePath: FilePath): void {
  const path = normalizeFilePath(filePath);
  db.run("DELETE FROM module_bindings WHERE file_path = ?", [path]);
  db.run("DELETE FROM module_binding_surfaces WHERE file_path = ?", [path]);
  db.run("DELETE FROM import_descriptors WHERE file_path = ?", [path]);
}

export interface PersistedSurface {
  readonly isPackageSurface: boolean;
  readonly unboundedNames: boolean;
  readonly surfaceDigest: string;
}

export function readPersistedSurfaces(db: Database): Map<FilePath, PersistedSurface> {
  const rows = db.query(
    `SELECT file_path, is_package_surface, unbounded_names, surface_digest FROM module_binding_surfaces`,
  ).all() as { file_path: string; is_package_surface: number; unbounded_names: number; surface_digest: string }[];
  return new Map(rows.map((row) => [row.file_path, {
    isPackageSurface: row.is_package_surface === 1,
    unboundedNames: row.unbounded_names === 1,
    surfaceDigest: row.surface_digest,
  }]));
}

export function countPersistedSurfaces(db: Database): number {
  return (db.query("SELECT COUNT(*) AS c FROM module_binding_surfaces").get() as { c: number }).c;
}

/**
 * Files with a descriptor resolving to `target`, excluding wildcard reaches.
 *
 * Deliberately NOT `SELECT DISTINCT`: the closure adds these to a set, so the
 * only thing DISTINCT bought was a `USE TEMP B-TREE FOR DISTINCT` on top of an
 * already-covering index lookup. One file importing the same module twice is a
 * duplicate row here and one entry there.
 */
export function importersOfTarget(db: Database, target: FilePath): string[] {
  const rows = db.query(
    `SELECT file_path FROM import_descriptors
      WHERE resolved_target_path = ? AND resolution_status <> 'wildcard'`,
  ).all(normalizeFilePath(target)) as { file_path: string }[];
  return rows.map((row) => row.file_path);
}

/** Files reaching `target` through `from target import *`. */
export function wildcardImportersOfTarget(db: Database, target: FilePath): string[] {
  const rows = db.query(
    `SELECT file_path FROM import_descriptors
      WHERE resolved_target_path = ? AND resolution_status = 'wildcard'`,
  ).all(normalizeFilePath(target)) as { file_path: string }[];
  return rows.map((row) => row.file_path);
}

/**
 * True when `file` republishes a name resolving into `target`.
 *
 * `module_alias` counts: `import pkg.sub` inside a package `__init__.py` makes
 * `pkg.sub` reachable through the package, so the package's surface moves when
 * `pkg/sub.py`'s identity does.
 */
export function reExportsThrough(db: Database, file: FilePath, target: FilePath): boolean {
  const row = db.query(
    `SELECT 1 AS hit FROM module_bindings
      WHERE file_path = ? AND target_path = ? AND binding_kind IN ('re_export', 'module_alias')
      LIMIT 1`,
  ).get(normalizeFilePath(file), normalizeFilePath(target)) as { hit: number } | null;
  return row !== null;
}
