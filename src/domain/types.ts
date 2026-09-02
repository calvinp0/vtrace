import { createHash } from "node:crypto";

/**
 * One member per language FAMILY. A family is the unit `createDefaultParserRegistry`
 * registers a parser for, and the unit the M202 breadth claim counts; extensions,
 * dialects and alias filenames map onto a member in `src/parsers/languageFamilies.ts`
 * and never add one. Members that the registry does not back (`Toml`) are
 * detection rules, not language support.
 */
export enum Language {
  TypeScript = "typescript",
  JavaScript = "javascript",
  Python = "python",
  Cython = "cython",
  Yaml = "yaml",
  Toml = "toml",
  Go = "go",
  Rust = "rust",
  Java = "java",
  CSharp = "csharp",
  C = "c",
  Cpp = "cpp",
  Ruby = "ruby",
  Kotlin = "kotlin",
  Scala = "scala",
  Swift = "swift",
  Dart = "dart",
  Elixir = "elixir",
  Haskell = "haskell",
  OCaml = "ocaml",
  Lua = "lua",
  R = "r",
  Php = "php",
  Zig = "zig",
  ObjectiveC = "objective_c",
  Bash = "bash",
  Html = "html",
  Css = "css",
  Json = "json",
  Sql = "sql",
  Clojure = "clojure",
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
  /**
   * M140: the module/file scope itself. A STRUCTURAL symbol that exists so
   * module-level imports have a stable owner (see `isStructuralSymbolKind`).
   * It is never a retrieval candidate and carries no deliverable body.
   */
  Module = "module",
}

/**
 * Structural symbols exist to give graph relations a stable endpoint. They are
 * deliberately excluded from retrieval candidate generation, lexical ranking,
 * direct-answer scoring, content delivery, and token-budget accounting, while
 * remaining fully visible to graph consumers (expansion, rerank, impact,
 * upstream rescue).
 *
 * WHY (M140): before this, a file's module-level import edges were attributed
 * to its single top-level symbol and vanished entirely when a second top-level
 * symbol appeared, so adding an unrelated function silently deleted an
 * unchanged import edge. A per-module structural owner makes attribution
 * independent of what else the file happens to define.
 */
export function isStructuralSymbolKind(kind: SymbolKind): boolean {
  return kind === SymbolKind.Module;
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

/**
 * Where in the source an edge was actually observed by the parser.
 *
 * Edges are identified by (source, target, type), so one edge can stand for
 * several occurrences — a caller may call the same callee three times. Each
 * occurrence is recorded, so flow evidence can point at a real call site instead
 * of rescanning the caller's body for the first name that looks right (M131).
 *
 * `precision` says how much of the span the parser could establish: `span` means
 * exact start/end line and column; `line` means the line is exact and the
 * columns are not known.
 */
export interface EdgeCallSite {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  precision: "span" | "line";
}

export interface EdgeRecord {
  id: EdgeId;
  srcSymbolId: SymbolId;
  dstSymbolId: SymbolId;
  edgeType: EdgeType;
  confidence: number;
  /**
   * Parser-observed occurrences of this edge, ordered by position. Absent on
   * edges from parsers or indexes that predate occurrence capture — absence
   * means "not recorded", never "no occurrence exists".
   */
  callSites?: readonly EdgeCallSite[];
}

export interface ParseDiagnostic {
  message: string;
  startLine?: number;
  startByte?: number;
}

/**
 * How a parser resolved one import statement.
 *
 * `resolved` means the resolver named exactly one in-repository file.
 * `unresolved` means it named none — a third-party or standard-library module,
 * or a path this repository does not hold. Both of the remaining two are
 * REFUSALS rather than answers, and they are recorded because a refusal is what
 * makes a bounded closure impossible: `wildcard` for `from x import *`, whose
 * bound names are not knowable without executing the target, and `ambiguous`
 * for a name two imports could equally have bound, or a module name two files
 * claim at the same extension precedence.
 */
export type ImportResolutionStatus = "resolved" | "unresolved" | "wildcard" | "ambiguous";

/**
 * One import statement, as the parser's own resolver saw it (M200).
 *
 * This is the persisted half of the reverse-dependency authority: the forward
 * direction is already in the graph as `imports` edges, but an edge is written
 * only when BOTH ends resolve to a symbol, so the edges alone cannot answer
 * "which files depend on module M" for a module whose surface is about to
 * change. Every field is what the resolver actually produced; nothing here is
 * re-derived from the module name by a second implementation.
 */
export interface ImportDescriptor {
  /** `from x import y` versus `import x`. */
  readonly form: "from_import" | "import_module";
  /** The module as written, before relative resolution. `""` for `from . import x`. */
  readonly requestedModule: string;
  /** Leading-dot count. 0 for an absolute import. */
  readonly relativeLevel: number;
  /** The member requested, `"*"` for a wildcard, null for `import x`. */
  readonly importedName: string | null;
  /** The name this import binds locally, alias-aware. Null when nothing is bound. */
  readonly localName: string | null;
  /** The in-repository file the resolver chose, or null when it chose none. */
  readonly resolvedTargetPath: FilePath | null;
  readonly resolutionStatus: ImportResolutionStatus;
}

/**
 * How one name became available in a module's importable surface.
 *
 * `definition` — defined here. `re_export` — bound by an exact `from X import y`
 * and therefore resolving into another file. `module_alias` — bound by
 * `import x [as y]`, so the name stands for a module rather than a member.
 */
export type ModuleBindingKind = "definition" | "re_export" | "module_alias";

export interface ModuleBinding {
  readonly localName: string;
  readonly kind: ModuleBindingKind;
  /** The name in the TARGET module; equals `localName` for a definition. */
  readonly importedName: string | null;
  /** Where the name resolves. Null for a definition (it resolves here). */
  readonly targetPath: FilePath | null;
}

/**
 * What a module publishes to anything that imports it (M200).
 *
 * The point of this type is that it is derived from parsed structure, never
 * from bytes. Two files that differ only in comments or formatting have equal
 * surfaces; two files that bind the same NAME to a different target do not. That
 * distinction is the whole reason a package-surface edit no longer has to be
 * treated as global semantic invalidation — and `unboundedNames` is the reason
 * it can still be: a wildcard import publishes names this parser cannot
 * enumerate, so a surface carrying one can only be compared conservatively.
 */
export interface ModuleBindingSurface {
  readonly filePath: FilePath;
  /** True for a Python package `__init__.py`. */
  readonly isPackageSurface: boolean;
  /** Sorted by `localName` then `kind`, so the surface has one serialization. */
  readonly bindings: readonly ModuleBinding[];
  /** True when a `from x import *` makes this surface unenumerable. */
  readonly unboundedNames: boolean;
}

export interface ParseResult {
  file: FileRecord;
  symbols: SymbolRecord[];
  edges: EdgeRecord[];
  diagnostics: ParseDiagnostic[];
  /**
   * M200. Present only for parsers that model module bindings (Python today).
   * Absent means "this parser cannot say", which every consumer must treat as
   * the conservative case rather than as an empty surface.
   */
  bindingSurface?: ModuleBindingSurface;
  /** M200. Absent for the same reason, and never an empty array standing in for it. */
  importDescriptors?: readonly ImportDescriptor[];
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
