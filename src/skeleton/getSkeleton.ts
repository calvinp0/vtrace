import type { Database } from "bun:sqlite";
import { access } from "node:fs/promises";
import path from "node:path";

import { listEdgesForFile } from "../db/repositories/edgesRepository";
import { getFileByPath } from "../db/repositories/filesRepository";
import { getSymbolById, listSymbolsForFile } from "../db/repositories/symbolsRepository";
import {
  EdgeType,
  SymbolKind,
  normalizeFilePath,
  type Language,
  type SymbolRecord,
} from "../domain/types";

export const SKELETON_DETAIL_LEVELS = ["minimal", "standard", "detailed"] as const;

export type SkeletonDetailLevel = (typeof SKELETON_DETAIL_LEVELS)[number];

export interface SkeletonImportSummary {
  readonly fromFilePath: string;
  readonly name: string;
  readonly kind: SymbolKind;
}

export interface SkeletonExportSummary {
  readonly name: string;
  readonly kind: Exclude<SymbolKind, SymbolKind.Method>;
}

export interface SkeletonMember {
  readonly kind: SymbolKind.Method;
  readonly name: string;
  readonly signature: string | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly docstring: string | null;
  readonly decorators: readonly string[];
}

export interface SkeletonDeclaration {
  readonly kind: Exclude<SymbolKind, SymbolKind.Method>;
  readonly name: string;
  readonly exported: boolean;
  readonly signature: string | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly docstring: string | null;
  readonly decorators: readonly string[];
  readonly members: readonly SkeletonMember[];
}

export interface SkeletonFileResult {
  readonly status: "ok" | "file_not_found" | "not_indexed";
  readonly filePath: string;
  readonly language: Language | null;
  readonly message: string | null;
  readonly imports: readonly SkeletonImportSummary[];
  readonly exports: readonly SkeletonExportSummary[];
  readonly declarations: readonly SkeletonDeclaration[];
}

export interface GetSkeletonInput {
  readonly repoRoot: string;
  readonly files: readonly string[];
  readonly detail: SkeletonDetailLevel;
}

export interface GetSkeletonOutput {
  readonly detail: SkeletonDetailLevel;
  readonly files: readonly SkeletonFileResult[];
}

export function getIndexedSkeletonFileResult(
  db: Database,
  requestedFile: string,
  detail: SkeletonDetailLevel,
): SkeletonFileResult | undefined {
  const filePath = normalizeFilePath(requestedFile);
  const fileRecord = getFileByPath(db, filePath);

  if (fileRecord === undefined) {
    return undefined;
  }

  const symbols = listSymbolsForFile(db, filePath);
  const topLevelSymbols = symbols.filter((symbol) => symbol.parentSymbolId === undefined);
  const methodsByParentId = groupMethodsByParentId(symbols);

  return {
    status: "ok",
    filePath: fileRecord.path,
    language: fileRecord.language,
    message: null,
    imports: buildImportsSummary(db, filePath),
    exports: buildExportsSummary(topLevelSymbols),
    declarations: buildDeclarations(topLevelSymbols, methodsByParentId, detail),
  };
}

export async function getSkeleton(
  db: Database,
  input: GetSkeletonInput,
): Promise<GetSkeletonOutput> {
  const results: SkeletonFileResult[] = [];

  for (const requestedFile of input.files) {
    results.push(await buildSkeletonFileResult(db, input.repoRoot, requestedFile, input.detail));
  }

  return {
    detail: input.detail,
    files: results,
  };
}

async function buildSkeletonFileResult(
  db: Database,
  repoRoot: string,
  requestedFile: string,
  detail: SkeletonDetailLevel,
): Promise<SkeletonFileResult> {
  const filePath = normalizeFilePath(requestedFile);
  const indexedResult = getIndexedSkeletonFileResult(db, filePath, detail);

  if (indexedResult === undefined) {
    return await fileExistsOnDisk(repoRoot, filePath)
      ? {
        status: "not_indexed",
        filePath,
        language: null,
        message: "File exists on disk but has no indexed structural data.",
        imports: [],
        exports: [],
        declarations: [],
      }
      : {
        status: "file_not_found",
        filePath,
        language: null,
        message: "File was not found in the repo.",
        imports: [],
        exports: [],
        declarations: [],
      };
  }

  return indexedResult;
}

function buildImportsSummary(
  db: Database,
  filePath: string,
): SkeletonImportSummary[] {
  const importEntries = new Map<string, SkeletonImportSummary>();

  for (const edge of listEdgesForFile(db, filePath)) {
    if (edge.edgeType !== EdgeType.Imports) {
      continue;
    }

    const importedSymbol = getSymbolById(db, edge.dstSymbolId);

    if (importedSymbol === undefined) {
      continue;
    }

    const key = `${importedSymbol.filePath}\0${importedSymbol.localName}\0${importedSymbol.kind}`;

    if (!importEntries.has(key)) {
      importEntries.set(key, {
        fromFilePath: importedSymbol.filePath,
        name: importedSymbol.localName,
        kind: importedSymbol.kind,
      });
    }
  }

  return [...importEntries.values()].sort((left, right) => {
    return left.fromFilePath.localeCompare(right.fromFilePath)
      || left.name.localeCompare(right.name)
      || left.kind.localeCompare(right.kind);
  });
}

function buildExportsSummary(
  topLevelSymbols: readonly SymbolRecord[],
): SkeletonExportSummary[] {
  return topLevelSymbols
    .filter((symbol) => symbol.exported && symbol.kind !== SymbolKind.Method)
    .map((symbol) => ({
      name: symbol.localName,
      kind: symbol.kind,
    }));
}

function buildDeclarations(
  topLevelSymbols: readonly SymbolRecord[],
  methodsByParentId: ReadonlyMap<string, readonly SymbolRecord[]>,
  detail: SkeletonDetailLevel,
): SkeletonDeclaration[] {
  return topLevelSymbols
    .filter((symbol): symbol is SymbolRecord & { kind: Exclude<SymbolKind, SymbolKind.Method> } => {
      return symbol.kind !== SymbolKind.Method;
    })
    .map((symbol) => ({
      kind: symbol.kind,
      name: symbol.localName,
      exported: symbol.exported,
      signature: detail === "minimal" ? null : normalizeOptionalText(symbol.signature),
      startLine: detail === "detailed" ? symbol.startLine : null,
      endLine: detail === "detailed" ? symbol.endLine : null,
      docstring: detail === "detailed" ? normalizeOptionalText(symbol.docstring) : null,
      decorators: detail === "detailed" ? [...(symbol.decorators ?? [])] : [],
      members: symbol.kind === SymbolKind.Class && detail !== "minimal"
        ? (methodsByParentId.get(symbol.id) ?? []).map((method) => ({
          kind: SymbolKind.Method,
          name: method.localName,
          signature: normalizeOptionalText(method.signature),
          startLine: detail === "detailed" ? method.startLine : null,
          endLine: detail === "detailed" ? method.endLine : null,
          docstring: detail === "detailed" ? normalizeOptionalText(method.docstring) : null,
          decorators: detail === "detailed" ? [...(method.decorators ?? [])] : [],
        }))
        : [],
    }));
}

function groupMethodsByParentId(
  symbols: readonly SymbolRecord[],
): Map<string, readonly SymbolRecord[]> {
  const methodsByParentId = new Map<string, SymbolRecord[]>();

  for (const symbol of symbols) {
    if (symbol.kind !== SymbolKind.Method || symbol.parentSymbolId === undefined) {
      continue;
    }

    const existing = methodsByParentId.get(symbol.parentSymbolId);

    if (existing === undefined) {
      methodsByParentId.set(symbol.parentSymbolId, [symbol]);
      continue;
    }

    existing.push(symbol);
  }

  return methodsByParentId;
}

async function fileExistsOnDisk(repoRoot: string, filePath: string): Promise<boolean> {
  const resolved = resolveRepoFilePath(repoRoot, filePath);

  if (resolved === null) {
    return false;
  }

  try {
    await access(resolved);
    return true;
  } catch {
    return false;
  }
}

function resolveRepoFilePath(repoRoot: string, filePath: string): string | null {
  const resolved = path.resolve(repoRoot, filePath);
  const relative = path.relative(repoRoot, resolved);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }

  return null;
}

function normalizeOptionalText(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
