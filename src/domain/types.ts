import { createHash } from "node:crypto";

export enum Language {
  TypeScript = "typescript",
  JavaScript = "javascript",
  Python = "python",
  Cython = "cython",
  Yaml = "yaml",
  Toml = "toml",
  Go = "go",
  Rust = "rust",
}

export enum SymbolKind {
  Function = "function",
  Class = "class",
  Method = "method",
  Interface = "interface",
  TypeAlias = "type_alias",
  ModuleConstant = "module_constant",
  ModuleVariable = "module_variable",
  ModuleAlias = "module_alias",
}

export enum EdgeType {
  Contains = "contains",
  Imports = "imports",
  Calls = "calls",
  References = "references",
}

export type FileId = string;
export type SymbolId = string;
export type EdgeId = string;
export type FilePath = string;
export type FullyQualifiedName = string;

export interface SymbolIdentityInput {
  filePath: FilePath;
  fqName: FullyQualifiedName;
  kind: SymbolKind;
  startByte: number;
  endByte: number;
}

export interface FullyQualifiedNameInput {
  filePath: FilePath;
  symbolPath: readonly string[];
}

export interface FileRecord {
  id: FileId;
  path: FilePath;
  language: Language;
  contentHash: string;
  sizeBytes: number;
}

export interface SymbolRecord {
  id: SymbolId;
  filePath: FilePath;
  fqName: FullyQualifiedName;
  localName: string;
  kind: SymbolKind;
  signature: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  parentSymbolId?: SymbolId;
  exported: boolean;
  docstring?: string;
  decorators?: string[];
}

export interface EdgeRecord {
  id: EdgeId;
  srcSymbolId: SymbolId;
  dstSymbolId: SymbolId;
  edgeType: EdgeType;
  confidence: number;
}

export interface ParseDiagnostic {
  message: string;
  startLine?: number;
  startByte?: number;
}

export interface ParseResult {
  file: FileRecord;
  symbols: SymbolRecord[];
  edges: EdgeRecord[];
  diagnostics: ParseDiagnostic[];
}

export function normalizeFilePath(filePath: FilePath): FilePath {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");

  if (normalized.length === 0) {
    throw new Error("filePath must not be empty");
  }

  return normalized;
}

export function buildFQName(input: FullyQualifiedNameInput): FullyQualifiedName {
  const filePath = normalizeFilePath(input.filePath);

  if (input.symbolPath.length === 0) {
    throw new Error("symbolPath must contain at least one segment");
  }

  for (const segment of input.symbolPath) {
    if (segment.length === 0) {
      throw new Error("symbolPath segments must not be empty");
    }
  }

  return `${filePath}::${input.symbolPath.join(".")}`;
}

export function computeFileId(filePath: FilePath): FileId {
  return stableHash([normalizeFilePath(filePath)]);
}

export function computeSymbolId(input: SymbolIdentityInput): SymbolId {
  assertNonNegativeInteger(input.startByte, "startByte");
  assertNonNegativeInteger(input.endByte, "endByte");

  if (input.endByte < input.startByte) {
    throw new Error("endByte must be greater than or equal to startByte");
  }

  return stableHash([
    normalizeFilePath(input.filePath),
    input.fqName,
    input.kind,
    input.startByte.toString(10),
    input.endByte.toString(10),
  ]);
}

function stableHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function assertNonNegativeInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
}
