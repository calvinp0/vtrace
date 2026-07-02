// File-level Python import relations (M99).
//
// WHY THIS EXISTS
// ----------------
// The symbol-level `imports` edges in the index are emitted only when the
// importing file has exactly ONE unambiguous top-level symbol (there is no
// module symbol to hang the edge on otherwise), so in practice ~97% of real
// modules contribute zero import edges — the only files that do are one-symbol
// facades (`__init__.py` with a single `__all__`). On top of that, workspaces
// that are rooted INSIDE a package (a checkout of `django/` rather than the
// repo root — common for package subtree materializations and src-layout inner
// dirs) cannot resolve the repo's own absolute imports (`django.http` has no
// known top-level `django` module), so even the machinery that DOES run misses
// every absolute self-import.
//
// This module provides an exact, deterministic FILE-level import relation:
// a statement-level scan of top-level `import` / `from … import` statements
// plus a resolver that maps dotted module names onto the indexed file list
// (relative imports, `from pkg import submodule`, package `__init__`
// re-export following, alias-aware, wildcard-safe). It never guesses: an
// import that does not resolve to exactly one known file yields no relation.
//
// It is consumed at capsule build time by the co-edit lane (import-relation
// evidence for co-edit candidates) and by offline audits. It deliberately does
// NOT write to the index or the `edges` table, so retrieval scoring, graph
// expansion, and hub counts are untouched.
//
// SCOPE / SAFETY RULES
// --------------------
// - Top-level statements only (module body), matching the AST-based parser's
//   import extraction; imports inside functions/try/TYPE_CHECKING blocks are
//   ignored by both.
// - Wildcard imports (`from x import *`) resolve to the module FILE only —
//   exported names are never expanded.
// - Root-package inference: when the scan root itself is a package (a root
//   `__init__.py` exists), an absolute import whose first segment is not a
//   known top-level module is retried without that segment. This is the only
//   way a package-rooted checkout can see its own absolute imports; it is
//   conflict-safe because the full name is always preferred when it resolves.
// - Re-export following is exact `from X import name` (alias-aware) with a
//   small depth limit and cycle guard; wildcard/ambiguous re-exports stop the
//   chain.

// --- statement scanning ------------------------------------------------------------

export interface PythonImportedName {
  readonly name: string;
  readonly asName?: string;
}

export interface PythonImportStatement {
  /** `module` = `import a.b`, `from` = `from a.b import c`. */
  readonly kind: "module" | "from";
  /** Dotted module text ("" for `from . import x`). */
  readonly module: string;
  /** Leading-dot count for relative from-imports (0 = absolute). */
  readonly level: number;
  /** For `from`: imported names ("*" preserved). For `module`: one entry whose name is the dotted module. */
  readonly names: readonly PythonImportedName[];
}

const TRIPLE_QUOTES = ['"""', "'''"] as const;

/**
 * Scan the TOP-LEVEL import statements of a Python source file. Deterministic,
 * conservative: statements that do not parse cleanly are skipped, never guessed.
 * Handles parenthesized/backslash continuations, `a; b` compounds, comments,
 * and module docstrings/triple-quoted strings that could contain import-looking
 * lines at column 0.
 */
export function scanTopLevelPythonImports(content: string): PythonImportStatement[] {
  const lines = content.split("\n");
  const statements: PythonImportStatement[] = [];
  let openTriple: (typeof TRIPLE_QUOTES)[number] | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (openTriple !== null) {
      openTriple = advanceTripleState(line, openTriple);
      continue;
    }
    if (/^(import|from)[ \t]/.test(line)) {
      // Gather the full logical statement (parens / trailing backslash).
      let statement = stripComment(line);
      let depth = parenDepth(statement);
      while ((depth > 0 || statement.trimEnd().endsWith("\\")) && i + 1 < lines.length) {
        if (statement.trimEnd().endsWith("\\")) statement = statement.trimEnd().slice(0, -1);
        i += 1;
        const next = stripComment(lines[i]!);
        statement = `${statement} ${next}`;
        depth = parenDepth(statement);
      }
      for (const piece of statement.split(";")) {
        const parsed = parseImportStatement(piece.trim());
        if (parsed !== null) statements.push(parsed);
      }
      continue;
    }
    openTriple = advanceTripleState(line, null);
  }
  return statements;
}

// Comments cannot appear inside an import statement's tokens (imports contain
// no string literals), so cutting at the first `#` is exact.
function stripComment(line: string): string {
  const idx = line.indexOf("#");
  return idx >= 0 ? line.slice(0, idx) : line;
}

function parenDepth(text: string): number {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
  }
  return depth;
}

// Track triple-quoted string state across a line that is NOT an import
// statement. Single-quoted strings and comments are consumed so quotes inside
// them never toggle the triple state.
function advanceTripleState(
  line: string,
  state: (typeof TRIPLE_QUOTES)[number] | null,
): (typeof TRIPLE_QUOTES)[number] | null {
  let i = 0;
  let open = state;
  while (i < line.length) {
    if (open !== null) {
      const close = line.indexOf(open, i);
      if (close === -1) return open;
      i = close + 3;
      open = null;
      continue;
    }
    const ch = line[i]!;
    if (ch === "#") return null;
    if (ch === '"' || ch === "'") {
      const triple = line.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        open = triple;
        i += 3;
        continue;
      }
      // Single-quoted string: consume to its close (escape-aware); if it does
      // not close on this line (backslash continuation), stop conservatively.
      i += 1;
      while (i < line.length) {
        if (line[i] === "\\") { i += 2; continue; }
        if (line[i] === ch) break;
        i += 1;
      }
      if (i >= line.length) return null;
      i += 1;
      continue;
    }
    i += 1;
  }
  return open;
}

const MODULE_IMPORT_RE = /^import[ \t]+(.+)$/;
const FROM_IMPORT_RE = /^from[ \t]+([.\w \t]+?)[ \t]*import[ \t]+(.+)$/;
const NAME_RE = /^([\w.]+)(?:[ \t]+as[ \t]+(\w+))?$/;

function parseImportStatement(text: string): PythonImportStatement | null {
  const moduleMatch = MODULE_IMPORT_RE.exec(text);
  if (moduleMatch !== null) {
    const names = parseNameList(moduleMatch[1]!);
    if (names === null || names.length === 0) return null;
    // `import a.b, c` is N statements semantically; callers iterate names.
    return { kind: "module", module: "", level: 0, names };
  }
  const fromMatch = FROM_IMPORT_RE.exec(text);
  if (fromMatch !== null) {
    const moduleText = fromMatch[1]!.replace(/[ \t]/g, "");
    let level = 0;
    while (level < moduleText.length && moduleText[level] === ".") level += 1;
    const module = moduleText.slice(level);
    if (level === 0 && module.length === 0) return null;
    if (module.length > 0 && !/^\w+(\.\w+)*$/.test(module)) return null;
    const inner = fromMatch[2]!.replace(/[()]/g, "").trim();
    if (inner === "*") {
      return { kind: "from", module, level, names: [{ name: "*" }] };
    }
    const names = parseNameList(inner);
    if (names === null || names.length === 0) return null;
    return { kind: "from", module, level, names };
  }
  return null;
}

function parseNameList(text: string): PythonImportedName[] | null {
  const names: PythonImportedName[] = [];
  for (const piece of text.split(",")) {
    const trimmed = piece.trim();
    if (trimmed.length === 0) continue;
    const match = NAME_RE.exec(trimmed);
    if (match === null) return null;
    names.push(match[2] === undefined ? { name: match[1]! } : { name: match[1]!, asName: match[2] });
  }
  return names;
}

// --- module index ------------------------------------------------------------------

export interface PythonModuleIndex {
  /** Dotted module name → indexed `.py` paths (normally exactly one). */
  readonly modulePathsByName: ReadonlyMap<string, readonly string[]>;
  readonly moduleNameByFilePath: ReadonlyMap<string, string>;
  /** The scan root is itself a package (`__init__.py` at the root). */
  readonly rootIsPackage: boolean;
}

/**
 * Build the module-name index from a flat list of repo-relative file paths
 * (e.g. the index's `files` table). Mirrors the parser's canonical-module-name
 * rule: the module path starts at the outermost directory that still carries an
 * `__init__.py` chain down to the file.
 */
export function buildPythonModuleIndex(filePaths: Iterable<string>): PythonModuleIndex {
  const pyFiles = [...filePaths].filter((p) => p.endsWith(".py")).sort();
  const fileSet = new Set(pyFiles);
  const modulePathsByName = new Map<string, string[]>();
  const moduleNameByFilePath = new Map<string, string>();

  for (const filePath of pyFiles) {
    const moduleName = canonicalModuleName(filePath, fileSet);
    if (moduleName === undefined) continue;
    moduleNameByFilePath.set(filePath, moduleName);
    const existing = modulePathsByName.get(moduleName);
    if (existing === undefined) modulePathsByName.set(moduleName, [filePath]);
    else existing.push(filePath);
  }
  return {
    modulePathsByName,
    moduleNameByFilePath,
    rootIsPackage: fileSet.has("__init__.py"),
  };
}

function canonicalModuleName(filePath: string, fileSet: ReadonlySet<string>): string | undefined {
  const segments = filePath.split("/");
  const fileName = segments.at(-1);
  if (fileName === undefined) return undefined;
  const directorySegments = segments.slice(0, -1);
  let packageStartIndex = directorySegments.length;
  for (let index = directorySegments.length - 1; index >= 0; index -= 1) {
    const initPath = [...directorySegments.slice(0, index + 1), "__init__.py"].join("/");
    if (!fileSet.has(initPath)) break;
    packageStartIndex = index;
  }
  const moduleSegments = directorySegments.slice(packageStartIndex);
  if (fileName === "__init__.py") {
    return moduleSegments.length === 0 ? undefined : moduleSegments.join(".");
  }
  const stem = fileName.slice(0, -".py".length);
  if (stem.length === 0) return undefined;
  return [...moduleSegments, stem].join(".");
}

// --- resolution --------------------------------------------------------------------

/** How the importer reaches the imported file. */
export type FileImportKind =
  | "module_import" // import a.b.c
  | "from_module_import" // from a.b import c   (c is a module file)
  | "from_name_import" // from a.b import name (name defined in a/b's file)
  | "init_reexport" // from pkg import name; pkg/__init__ re-exports name from the target
  | "wildcard_module"; // from a.b import *   (module file only, names never expanded)

export interface FileImportRelation {
  readonly importerPath: string;
  readonly importedPath: string;
  readonly kinds: readonly FileImportKind[];
  /** Names pulled from the imported file (empty for pure module imports). */
  readonly importedNames: readonly string[];
  /** Reached via a relative import (leading dots). */
  readonly relative: boolean;
  /** Absolute import resolved only after dropping the unknown root-package segment. */
  readonly viaRootPackageInference: boolean;
}

export interface FileImportScanner {
  /** Repo-internal files `importerPath` imports (exact, deduped, sorted). */
  relationsOf(importerPath: string): readonly FileImportRelation[];
  /** Direct relations between two files, both directions (null if none). */
  relationBetween(a: string, b: string): {
    readonly aImportsB: FileImportRelation | null;
    readonly bImportsA: FileImportRelation | null;
  };
  /** Distinct repo-internal files `path` imports. */
  importFanOut(path: string): number;
  readonly moduleIndex: PythonModuleIndex;
}

const REEXPORT_MAX_DEPTH = 3;

/**
 * Create a scanner over a fixed file list. `readFile` returns a file's content
 * or null (missing/unreadable files simply yield no relations). All scans are
 * cached; the scanner is deterministic for a fixed tree.
 */
export function createFileImportScanner(
  filePaths: Iterable<string>,
  readFile: (path: string) => string | null,
): FileImportScanner {
  const moduleIndex = buildPythonModuleIndex(filePaths);
  const statementCache = new Map<string, readonly PythonImportStatement[]>();
  const relationCache = new Map<string, readonly FileImportRelation[]>();

  const statementsOf = (path: string): readonly PythonImportStatement[] => {
    const cached = statementCache.get(path);
    if (cached !== undefined) return cached;
    const content = path.endsWith(".py") ? readFile(path) : null;
    const statements = content === null ? [] : scanTopLevelPythonImports(content);
    statementCache.set(path, statements);
    return statements;
  };

  const resolveModule = (dotted: string): string | null => {
    if (dotted.length === 0) return null;
    const direct = moduleIndex.modulePathsByName.get(dotted);
    if (direct !== undefined) return direct.length === 1 ? direct[0]! : null;
    if (moduleIndex.rootIsPackage) {
      const segments = dotted.split(".");
      // The root package's own name is unknowable from inside the checkout;
      // retry without the first segment iff that segment is not a known
      // top-level module (the full name always wins when it resolves).
      if (segments.length >= 2 && !moduleIndex.modulePathsByName.has(segments[0]!)) {
        const stripped = moduleIndex.modulePathsByName.get(segments.slice(1).join("."));
        if (stripped !== undefined && stripped.length === 1) return stripped[0]!;
      }
    }
    return null;
  };

  // Resolve where `name`, exported by module file `modulePath`, is DEFINED,
  // following exact `from X import name [as alias]` re-exports through package
  // `__init__` files. Returns null when the chain is ambiguous or leaves the
  // known tree.
  const followReExport = (
    modulePath: string,
    name: string,
    depth: number,
    seen: Set<string>,
  ): string | null => {
    if (depth >= REEXPORT_MAX_DEPTH || seen.has(`${modulePath}\0${name}`)) return null;
    seen.add(`${modulePath}\0${name}`);
    for (const statement of statementsOf(modulePath)) {
      if (statement.kind !== "from") continue;
      for (const imported of statement.names) {
        const bound = imported.asName ?? imported.name;
        if (bound !== name || imported.name === "*") continue;
        const targetModule = resolveStatementModule(modulePath, statement);
        if (targetModule === null) return null;
        // `from a.b import c as name` where c is itself a module file.
        const submodule = resolveModule(`${targetModule.dotted}.${imported.name}`);
        if (submodule !== null) return submodule;
        if (targetModule.path === null) return null;
        // The exporting module may itself re-import the name (alias-aware);
        // if it does not, the chain ends there and that file is the definer.
        const deeper = followReExport(targetModule.path, imported.name, depth + 1, seen);
        return deeper ?? targetModule.path;
      }
    }
    return null;
  };

  const resolveStatementModule = (
    importerPath: string,
    statement: PythonImportStatement,
  ): { dotted: string; path: string | null } | null => {
    if (statement.level === 0) {
      const path = resolveModule(statement.module);
      // Keep the dotted name resolvable for submodule probes even when the
      // module itself maps to a package we could not disambiguate.
      return statement.module.length === 0 ? null : { dotted: statement.module, path };
    }
    const importerModule = moduleIndex.moduleNameByFilePath.get(importerPath);
    if (importerModule === undefined) return null;
    const moduleSegments = importerModule.split(".");
    const packageSegments = importerPath.endsWith("/__init__.py") || importerPath === "__init__.py"
      ? moduleSegments
      : moduleSegments.slice(0, -1);
    const parentDepth = statement.level - 1;
    if (parentDepth > packageSegments.length) return null;
    const baseSegments = packageSegments.slice(0, packageSegments.length - parentDepth);
    const dotted = [...baseSegments, ...(statement.module.length > 0 ? statement.module.split(".") : [])]
      .join(".");
    if (dotted.length === 0) return null;
    return { dotted, path: resolveModule(dotted) };
  };

  const relationsOf = (importerPath: string): readonly FileImportRelation[] => {
    const cached = relationCache.get(importerPath);
    if (cached !== undefined) return cached;

    interface Accumulated {
      kinds: Set<FileImportKind>;
      importedNames: Set<string>;
      relative: boolean;
      viaRootPackageInference: boolean;
    }
    const byTarget = new Map<string, Accumulated>();
    const add = (
      importedPath: string | null,
      kind: FileImportKind,
      name: string | null,
      relative: boolean,
      dotted: string,
    ): void => {
      if (importedPath === null || importedPath === importerPath) return;
      let acc = byTarget.get(importedPath);
      if (acc === undefined) {
        acc = { kinds: new Set(), importedNames: new Set(), relative: false, viaRootPackageInference: false };
        byTarget.set(importedPath, acc);
      }
      acc.kinds.add(kind);
      if (name !== null && name !== "*") acc.importedNames.add(name);
      acc.relative = acc.relative || relative;
      const inferred = dotted.length > 0
        && !moduleIndex.modulePathsByName.has(dotted)
        && moduleIndex.rootIsPackage;
      acc.viaRootPackageInference = acc.viaRootPackageInference || (inferred && !relative);
    };

    for (const statement of statementsOf(importerPath)) {
      if (statement.kind === "module") {
        for (const imported of statement.names) {
          add(resolveModule(imported.name), "module_import", null, false, imported.name);
        }
        continue;
      }
      const target = resolveStatementModule(importerPath, statement);
      if (target === null) continue;
      const relative = statement.level > 0;
      for (const imported of statement.names) {
        if (imported.name === "*") {
          add(target.path, "wildcard_module", "*", relative, target.dotted);
          continue;
        }
        const submodule = resolveModule(`${target.dotted}.${imported.name}`);
        if (submodule !== null) {
          add(submodule, "from_module_import", null, relative, `${target.dotted}.${imported.name}`);
          continue;
        }
        if (target.path === null) continue;
        add(target.path, "from_name_import", imported.name, relative, target.dotted);
        if (target.path.endsWith("/__init__.py") || target.path === "__init__.py") {
          const defining = followReExport(target.path, imported.name, 0, new Set());
          if (defining !== null && defining !== target.path) {
            add(defining, "init_reexport", imported.name, relative, target.dotted);
          }
        }
      }
    }

    const relations = [...byTarget.entries()]
      .map(([importedPath, acc]): FileImportRelation => ({
        importerPath,
        importedPath,
        kinds: [...acc.kinds].sort(),
        importedNames: [...acc.importedNames].sort(),
        relative: acc.relative,
        viaRootPackageInference: acc.viaRootPackageInference,
      }))
      .sort((a, b) => a.importedPath.localeCompare(b.importedPath));
    relationCache.set(importerPath, relations);
    return relations;
  };

  return {
    relationsOf,
    relationBetween(a: string, b: string) {
      return {
        aImportsB: relationsOf(a).find((r) => r.importedPath === b) ?? null,
        bImportsA: relationsOf(b).find((r) => r.importedPath === a) ?? null,
      };
    },
    importFanOut(path: string): number {
      return relationsOf(path).length;
    },
    moduleIndex,
  };
}
