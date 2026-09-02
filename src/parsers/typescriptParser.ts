// @ts-nocheck
import { createHash } from "node:crypto";
import Parser = require("tree-sitter");
import * as TypeScriptLanguages from "tree-sitter-typescript";

import {
  EdgeType,
  Language,
  SymbolKind,
  buildFQName,
  computeFileId,
  computeSymbolId,
  type EdgeCallSite,
  type EdgeRecord,
  type ParseDiagnostic,
  type ParseResult,
  type SymbolRecord,
} from "../domain/types";
import { withCallSite } from "./edgeCallSites";
import { ParserError } from "./errors";
import type { LanguageParser } from "./LanguageParser";
import { TREE_SITTER_DEFAULT_BUFFER_UNITS, offsetsFor } from "./treeSitterSource";
import type { ParseFileInput } from "./types";

type SyntaxNode = Parser.SyntaxNode;

interface ExtractedSymbols {
  symbols: SymbolRecord[];
  edges: EdgeRecord[];
}

export interface TypeScriptKnownFile {
  path: string;
  content: string;
}

export interface TypeScriptParserOptions {
  knownFiles?: readonly TypeScriptKnownFile[];
}

interface TypeScriptParserContext {
  knownFilesByPath: ReadonlyMap<string, string>;
}

export const typescriptParser: LanguageParser = createTypeScriptParser();

export function createTypeScriptParser(
  options: TypeScriptParserOptions = {},
): LanguageParser {
  const context = makeParserContext(options);

  return {
    language: Language.TypeScript,
    async parse(input: ParseFileInput): Promise<ParseResult> {
      return parseTypeScriptWithContext(input, context);
    },
  };
}

const symbolsOnlyContext: TypeScriptParserContext = {
  knownFilesByPath: new Map(),
};

export function parseTypeScript(
  input: ParseFileInput,
  options: TypeScriptParserOptions = {},
): ParseResult {
  return parseTypeScriptWithContext(input, makeParserContext(options));
}

function parseTypeScriptWithContext(
  input: ParseFileInput,
  context: TypeScriptParserContext = symbolsOnlyContext,
): ParseResult {
  if (input.language !== Language.TypeScript) {
    throw ParserError.unsupportedLanguage(input.path, input.language);
  }

  const parser = new Parser();
  parser.setLanguage(getTreeSitterLanguage(input.path));

  const tree = parseSource(parser, input.content);
  const extracted = extractTopLevelSymbols(input.path, input.content, tree.rootNode);
  const importEdges = extractImportEdges({
    filePath: input.path,
    rootNode: tree.rootNode,
    sourceSymbols: extracted.symbols,
    context,
  });
  const callReferenceEdges = extractCallAndReferenceEdges({
    filePath: input.path,
    content: input.content,
    rootNode: tree.rootNode,
    sourceSymbols: extracted.symbols,
    context,
  });

  return {
    file: {
      id: computeFileId(input.path),
      path: input.path,
      language: input.language,
      contentHash: hashContent(input.content),
      sizeBytes: Buffer.byteLength(input.content),
    },
    symbols: extracted.symbols,
    edges: [...extracted.edges, ...importEdges, ...callReferenceEdges],
    diagnostics: collectDiagnostics(input.content, tree.rootNode),
  };
}

/**
 * `node-tree-sitter` 0.21.1 converts a string input into a chunk callback and
 * writes the returned chunk into a fixed buffer whose default size is 32768
 * UTF-16 code units. A source longer than 32767 units overflows that buffer and
 * the native binding throws `Invalid argument` instead of reading in chunks, so
 * the file is lost from the index entirely — and, via `getExportIndex`, so is
 * every file that imports it. Sizing the buffer to the source removes the limit
 * without truncating, chunking or otherwise altering what the parser sees.
 * The constant lives in `treeSitterSource.ts` so every tree-sitter family
 * sizes its buffer the same way.
 */
function parseSource(parser: Parser, content: string) {
  return parser.parse(content, undefined, {
    bufferSize: Math.max(TREE_SITTER_DEFAULT_BUFFER_UNITS, content.length + 1),
  });
}

function getTreeSitterLanguage(filePath: string): unknown {
  return filePath.endsWith(".tsx")
    ? TypeScriptLanguages.tsx
    : TypeScriptLanguages.typescript;
}

function extractTopLevelSymbols(
  filePath: string,
  content: string,
  rootNode: SyntaxNode,
): ExtractedSymbols {
  const symbols: SymbolRecord[] = [];
  const edges: EdgeRecord[] = [];

  for (const child of rootNode.namedChildren) {
    const exported = isExportStatement(child);
    const declaration = unwrapExportStatement(child);

    if (declaration === undefined) {
      continue;
    }

    const symbol = symbolFromTopLevelDeclaration(
      filePath,
      content,
      declaration,
      exported,
      child,
    );

    if (symbol === undefined) {
      continue;
    }

    symbols.push(symbol);

    if (declaration.type === "class_declaration") {
      const methods = extractClassMembers(filePath, content, declaration, symbol);
      symbols.push(...methods.symbols);
      edges.push(...methods.edges);
    }
  }

  return { symbols, edges };
}

function unwrapExportStatement(node: SyntaxNode): SyntaxNode | undefined {
  if (!isExportStatement(node)) {
    return node;
  }

  return node.childForFieldName("declaration") ?? undefined;
}

function isExportStatement(node: SyntaxNode): boolean {
  return node.type === "export_statement";
}

function symbolFromTopLevelDeclaration(
  filePath: string,
  content: string,
  declaration: SyntaxNode,
  exported: boolean,
  docContext: SyntaxNode,
): SymbolRecord | undefined {
  switch (declaration.type) {
    case "function_declaration":
      return makeSymbolRecord({
        filePath,
        content,
        node: declaration,
        localName: getNamedDeclarationName(declaration),
        kind: SymbolKind.Function,
        symbolPath: undefined,
        exported,
        docContext,
      });
    case "class_declaration":
      return makeSymbolRecord({
        filePath,
        content,
        node: declaration,
        localName: getNamedDeclarationName(declaration),
        kind: SymbolKind.Class,
        symbolPath: undefined,
        exported,
        docContext,
      });
    case "interface_declaration":
      return makeSymbolRecord({
        filePath,
        content,
        node: declaration,
        localName: getNamedDeclarationName(declaration),
        kind: SymbolKind.Interface,
        symbolPath: undefined,
        exported,
        docContext,
      });
    case "type_alias_declaration":
      return makeSymbolRecord({
        filePath,
        content,
        node: declaration,
        localName: getNamedDeclarationName(declaration),
        kind: SymbolKind.TypeAlias,
        symbolPath: undefined,
        exported,
        docContext,
      });
    default:
      return undefined;
  }
}

function extractClassMembers(
  filePath: string,
  content: string,
  classNode: SyntaxNode,
  classSymbol: SymbolRecord,
): ExtractedSymbols {
  const classBody = classNode.childForFieldName("body");
  const symbols: SymbolRecord[] = [];
  const edges: EdgeRecord[] = [];

  if (classBody === null) {
    return { symbols, edges };
  }

  for (const child of classBody.namedChildren) {
    if (child.type !== "method_definition") {
      continue;
    }

    const methodName = getMethodName(child);

    if (methodName === undefined) {
      continue;
    }

    const methodSymbol = makeSymbolRecord({
      filePath,
      content,
      node: child,
      localName: methodName,
      kind: SymbolKind.Method,
      symbolPath: [classSymbol.localName, methodName],
      parentSymbolId: classSymbol.id,
      exported: false,
      docContext: child,
    });

    if (methodSymbol === undefined) {
      continue;
    }

    symbols.push(methodSymbol);
    edges.push(makeContainsEdge(classSymbol.id, methodSymbol.id));
  }

  return { symbols, edges };
}

interface ExtractImportEdgesInput {
  filePath: string;
  rootNode: SyntaxNode;
  sourceSymbols: readonly SymbolRecord[];
  context: TypeScriptParserContext;
}

function extractImportEdges(input: ExtractImportEdgesInput): EdgeRecord[] {
  if (input.rootNode.hasError) {
    return [];
  }

  const sourceSymbol = getUnambiguousImportSourceSymbol(input.sourceSymbols);

  if (sourceSymbol === undefined) {
    return [];
  }

  const edgesById = new Map<string, EdgeRecord>();

  for (const child of input.rootNode.namedChildren) {
    if (child.type !== "import_statement") {
      continue;
    }

    const moduleSpecifier = getImportModuleSpecifier(child);

    if (moduleSpecifier === undefined) {
      continue;
    }

    const targetPath = resolveRelativeImportPath(
      input.filePath,
      moduleSpecifier,
      input.context.knownFilesByPath,
    );

    if (targetPath === undefined) {
      continue;
    }

    const targetContent = input.context.knownFilesByPath.get(targetPath);

    if (targetContent === undefined) {
      continue;
    }

    const targetExports = getExportIndex(targetPath, targetContent);
    const imports = getImportSpecifiers(child);

    for (const imported of imports) {
      const targetSymbol = resolveImportedSymbol(imported, targetExports);

      if (targetSymbol === undefined) {
        continue;
      }

      const edge = makeImportEdge(sourceSymbol.id, targetSymbol.id);
      edgesById.set(edge.id, edge);
    }
  }

  return [...edgesById.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function getUnambiguousImportSourceSymbol(
  symbols: readonly SymbolRecord[],
): SymbolRecord | undefined {
  const topLevelSymbols = symbols.filter((symbol) => symbol.parentSymbolId === undefined);

  return topLevelSymbols.length === 1 ? topLevelSymbols[0] : undefined;
}

interface ImportSpecifier {
  kind: "named" | "default" | "namespace";
  importedName?: string;
}

function getImportSpecifiers(importStatement: SyntaxNode): ImportSpecifier[] {
  const importClause = importStatement.namedChildren.find((child) => {
    return child.type === "import_clause";
  });

  if (importClause === undefined) {
    return [];
  }

  const imports: ImportSpecifier[] = [];

  for (const child of importClause.namedChildren) {
    if (child.type === "identifier") {
      imports.push({ kind: "default" });
      continue;
    }

    if (child.type === "namespace_import") {
      imports.push({ kind: "namespace" });
      continue;
    }

    if (child.type !== "named_imports") {
      continue;
    }

    for (const namedImport of child.namedChildren) {
      if (namedImport.type !== "import_specifier") {
        continue;
      }

      const importedName = namedImport.childForFieldName("name")?.text;

      if (importedName !== undefined) {
        imports.push({ kind: "named", importedName });
      }
    }
  }

  return imports;
}

function getImportModuleSpecifier(importStatement: SyntaxNode): string | undefined {
  const source = importStatement.childForFieldName("source");

  if (source === null || source.type !== "string") {
    return undefined;
  }

  const fragments = source.namedChildren.filter((child) => child.type === "string_fragment");

  return fragments.length === 1 ? fragments[0]?.text : undefined;
}

function resolveRelativeImportPath(
  importerPath: string,
  moduleSpecifier: string,
  knownFilesByPath: ReadonlyMap<string, string>,
): string | undefined {
  if (!isRelativeModuleSpecifier(moduleSpecifier)) {
    return undefined;
  }

  const importerDirectory = getDirectoryName(importerPath);
  const basePath = normalizeModulePath(pathJoin(importerDirectory, moduleSpecifier));

  if (basePath === undefined) {
    return undefined;
  }

  const candidates = getImportPathCandidates(basePath);

  return candidates.find((candidate) => knownFilesByPath.has(candidate));
}

function isRelativeModuleSpecifier(moduleSpecifier: string): boolean {
  return moduleSpecifier.startsWith("./") || moduleSpecifier.startsWith("../");
}

function normalizeModulePath(modulePath: string): string | undefined {
  const normalized = modulePath.replace(/\\/g, "/");

  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return undefined;
  }

  return normalized.replace(/^\.\//, "");
}

function getImportPathCandidates(basePath: string): string[] {
  if (basePath.endsWith(".ts") || basePath.endsWith(".tsx")) {
    return [basePath];
  }

  return [
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}/index.ts`,
    `${basePath}/index.tsx`,
  ];
}

interface ExportIndex {
  namedExports: ReadonlyMap<string, SymbolRecord>;
  defaultExport?: SymbolRecord;
}

function getExportIndex(filePath: string, content: string): ExportIndex {
  const parser = new Parser();
  parser.setLanguage(getTreeSitterLanguage(filePath));

  const tree = parseSource(parser, content);

  if (tree.rootNode.hasError) {
    return { namedExports: new Map() };
  }

  const exportedSymbols = extractTopLevelSymbols(filePath, content, tree.rootNode)
    .symbols
    .filter((symbol) => symbol.exported && symbol.parentSymbolId === undefined);
  const namedExports = new Map<string, SymbolRecord>();
  let defaultExport: SymbolRecord | undefined;

  for (const symbol of exportedSymbols) {
    if (!namedExports.has(symbol.localName)) {
      namedExports.set(symbol.localName, symbol);
    }
  }

  for (const child of tree.rootNode.namedChildren) {
    if (!isDefaultExportStatement(child)) {
      continue;
    }

    const declaration = unwrapExportStatement(child);

    if (declaration === undefined) {
      continue;
    }

    const localName = getNamedDeclarationName(declaration);

    if (localName !== undefined) {
      defaultExport = namedExports.get(localName);
    }
  }

  return { namedExports, defaultExport };
}

function isDefaultExportStatement(node: SyntaxNode): boolean {
  return node.type === "export_statement"
    && node.children.some((child) => child.type === "default");
}

function resolveImportedSymbol(
  imported: ImportSpecifier,
  targetExports: ExportIndex,
): SymbolRecord | undefined {
  if (imported.kind === "namespace") {
    return undefined;
  }

  if (imported.kind === "default") {
    return targetExports.defaultExport;
  }

  if (imported.importedName === undefined) {
    return undefined;
  }

  return targetExports.namedExports.get(imported.importedName);
}

interface CreateSymbolInput {
  filePath: string;
  content: string;
  node: SyntaxNode;
  localName: string | undefined;
  kind: SymbolKind;
  symbolPath: readonly string[] | undefined;
  parentSymbolId?: string;
  exported: boolean;
  docContext: SyntaxNode;
}

function makeSymbolRecord(input: CreateSymbolInput): SymbolRecord | undefined {
  if (input.localName === undefined || input.localName.length === 0) {
    return undefined;
  }

  const symbolPath = input.symbolPath ?? [input.localName];
  const fqName = buildFQName({
    filePath: input.filePath,
    symbolPath,
  });
  const offsets = offsetsFor(input.content);
  const startByte = offsets.byteOffsetAt(input.node.startIndex);
  const endByte = offsets.byteOffsetAt(input.node.endIndex);
  const id = computeSymbolId({
    filePath: input.filePath,
    fqName,
    kind: input.kind,
    startByte,
    endByte,
  });
  const docstring = getLeadingDocstring(input.docContext);

  return {
    id,
    filePath: input.filePath,
    fqName,
    localName: input.localName,
    kind: input.kind,
    signature: getSignature(input.content, input.node),
    startLine: input.node.startPosition.row + 1,
    endLine: input.node.endPosition.row + 1,
    startByte,
    endByte,
    parentSymbolId: input.parentSymbolId,
    exported: input.exported,
    ...(docstring === undefined ? {} : { docstring }),
  };
}

function getNamedDeclarationName(node: SyntaxNode): string | undefined {
  return node.childForFieldName("name")?.text;
}

function getMethodName(node: SyntaxNode): string | undefined {
  const name = node.childForFieldName("name");

  if (name === null) {
    return undefined;
  }

  if (name.type !== "property_identifier" && name.type !== "private_property_identifier") {
    return undefined;
  }

  return name.text;
}

function getSignature(content: string, node: SyntaxNode): string {
  const body = node.childForFieldName("body");
  const endIndex = body === null ? node.endIndex : body.startIndex;

  // Node offsets are UTF-16 indices into `content` (see OffsetTranslator), so
  // the signature is a STRING slice. Slicing a UTF-8 Buffer at these offsets is
  // what produced `t function editedFilesFromPatch(patch: string): string[`.
  return content.slice(node.startIndex, endIndex).trim();
}

function getLeadingDocstring(node: SyntaxNode): string | undefined {
  const previous = node.previousNamedSibling;

  if (previous === null || previous.type !== "comment") {
    return undefined;
  }

  if (previous.endPosition.row + 1 < node.startPosition.row) {
    return undefined;
  }

  const text = previous.text.trim();
  return text.startsWith("/**") ? text : undefined;
}

function makeContainsEdge(srcSymbolId: string, dstSymbolId: string): EdgeRecord {
  return {
    id: hashParts([srcSymbolId, dstSymbolId, EdgeType.Contains]),
    srcSymbolId,
    dstSymbolId,
    edgeType: EdgeType.Contains,
    confidence: 1,
  };
}

function makeImportEdge(srcSymbolId: string, dstSymbolId: string): EdgeRecord {
  return {
    id: hashParts([srcSymbolId, dstSymbolId, EdgeType.Imports]),
    srcSymbolId,
    dstSymbolId,
    edgeType: EdgeType.Imports,
    confidence: 1,
  };
}

/** Tree-sitter positions are 0-based rows/columns; lines are reported 1-based. */
function treeSitterCallSite(node: Parser.SyntaxNode): EdgeCallSite {
  return {
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
    precision: "span",
  };
}

function makeCallsEdge(srcSymbolId: string, dstSymbolId: string): EdgeRecord {
  return {
    id: hashParts([srcSymbolId, dstSymbolId, EdgeType.Calls]),
    srcSymbolId,
    dstSymbolId,
    edgeType: EdgeType.Calls,
    confidence: 1,
  };
}

function makeReferencesEdge(srcSymbolId: string, dstSymbolId: string): EdgeRecord {
  return {
    id: hashParts([srcSymbolId, dstSymbolId, EdgeType.References]),
    srcSymbolId,
    dstSymbolId,
    edgeType: EdgeType.References,
    confidence: 1,
  };
}

function edgePairKey(srcSymbolId: string, dstSymbolId: string): string {
  return `${srcSymbolId}\x00${dstSymbolId}`;
}

interface ExtractCallReferenceInput {
  filePath: string;
  content: string;
  rootNode: SyntaxNode;
  sourceSymbols: readonly SymbolRecord[];
  context: TypeScriptParserContext;
}

// Resolution context for conservative TypeScript call/reference extraction. All
// lookups are exact and static: same-file top-level symbols, same-class methods,
// and exactly-resolved imported symbols. Ambiguous (duplicated) top-level names
// are recorded so they can be skipped rather than guessed.
interface CallReferenceResolution {
  topLevelByName: ReadonlyMap<string, SymbolRecord>;
  ambiguousNames: ReadonlySet<string>;
  classMembersByClassName: ReadonlyMap<string, ReadonlyMap<string, SymbolRecord>>;
  importedByLocalName: ReadonlyMap<string, SymbolRecord>;
}

interface ReferencePair {
  src: string;
  dst: string;
}

/**
 * Conservative static extraction of TypeScript `calls` and `references` edges.
 *
 * Calls are emitted only when the target resolves exactly: a same-file top-level
 * function, an imported function whose import target resolves exactly, a
 * `this.method()` whose method exists on the enclosing class, or a
 * `ClassName.method()` static call on a same-file class. Arbitrary object
 * receivers and dynamic dispatch are skipped rather than guessed.
 *
 * References cover exact type usage: type annotations, `extends`/`implements`
 * clauses, type-alias bodies, `new ClassName()` instantiation, and class/method
 * decorators. `calls` and `references` are kept distinct — when a pair already
 * has a calls edge the reference is dropped.
 */
function extractCallAndReferenceEdges(input: ExtractCallReferenceInput): EdgeRecord[] {
  if (input.rootNode.hasError) {
    return [];
  }

  const resolution = buildCallReferenceResolution(input);
  // Keyed by tree-sitter node offset, which is what every lookup below holds.
  // `SymbolRecord.startByte` is a UTF-8 byte offset, so it is translated back
  // into the parser's UTF-16 index domain exactly once, here.
  const offsets = offsetsFor(input.content);
  const symbolByNodeStartIndex = new Map<number, SymbolRecord>();

  for (const symbol of input.sourceSymbols) {
    symbolByNodeStartIndex.set(offsets.utf16IndexAt(symbol.startByte), symbol);
  }

  const callEdges = new Map<string, EdgeRecord>();
  const referencePairs: ReferencePair[] = [];

  for (const child of input.rootNode.namedChildren) {
    const declaration = unwrapExportStatement(child);

    if (declaration === undefined) {
      continue;
    }

    collectDeclarationEdges(
      declaration,
      symbolByNodeStartIndex,
      resolution,
      callEdges,
      referencePairs,
    );
  }

  const callPairs = new Set<string>();

  for (const edge of callEdges.values()) {
    callPairs.add(edgePairKey(edge.srcSymbolId, edge.dstSymbolId));
  }

  const referenceEdges = new Map<string, EdgeRecord>();

  for (const pair of referencePairs) {
    if (pair.src === pair.dst) {
      continue;
    }

    // Keep calls and references distinct: a pair that is already a call is not
    // also recorded as a reference.
    if (callPairs.has(edgePairKey(pair.src, pair.dst))) {
      continue;
    }

    const edge = makeReferencesEdge(pair.src, pair.dst);
    referenceEdges.set(edge.id, edge);
  }

  const calls = [...callEdges.values()].sort((left, right) => left.id.localeCompare(right.id));
  const references = [...referenceEdges.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );

  return [...calls, ...references];
}

function buildCallReferenceResolution(
  input: ExtractCallReferenceInput,
): CallReferenceResolution {
  const topLevelByName = new Map<string, SymbolRecord>();
  const ambiguousNames = new Set<string>();

  for (const symbol of input.sourceSymbols) {
    if (symbol.parentSymbolId !== undefined) {
      continue;
    }

    if (topLevelByName.has(symbol.localName)) {
      ambiguousNames.add(symbol.localName);
      continue;
    }

    topLevelByName.set(symbol.localName, symbol);
  }

  const classMembersByClassName = new Map<string, Map<string, SymbolRecord>>();

  for (const symbol of input.sourceSymbols) {
    if (
      symbol.parentSymbolId !== undefined
      || symbol.kind !== SymbolKind.Class
      || ambiguousNames.has(symbol.localName)
    ) {
      continue;
    }

    const members = new Map<string, SymbolRecord>();

    for (const member of input.sourceSymbols) {
      if (
        member.parentSymbolId === symbol.id
        && member.kind === SymbolKind.Method
        && !members.has(member.localName)
      ) {
        members.set(member.localName, member);
      }
    }

    classMembersByClassName.set(symbol.localName, members);
  }

  const importedByLocalName = buildImportedSymbolIndex(
    input.filePath,
    input.rootNode,
    input.context,
  );

  return { topLevelByName, ambiguousNames, classMembersByClassName, importedByLocalName };
}

// Maps each imported local binding name to the exact target symbol it resolves
// to (same as the imports-edge resolver, but keyed by local name and including
// aliased named imports). Namespace imports and unresolved targets are omitted.
function buildImportedSymbolIndex(
  filePath: string,
  rootNode: SyntaxNode,
  context: TypeScriptParserContext,
): Map<string, SymbolRecord> {
  const resolved = new Map<string, SymbolRecord>();
  const ambiguous = new Set<string>();

  const record = (localName: string | undefined, target: SymbolRecord | undefined): void => {
    if (localName === undefined || localName.length === 0 || target === undefined) {
      return;
    }

    if (resolved.has(localName)) {
      ambiguous.add(localName);
      return;
    }

    resolved.set(localName, target);
  };

  for (const child of rootNode.namedChildren) {
    if (child.type !== "import_statement") {
      continue;
    }

    const moduleSpecifier = getImportModuleSpecifier(child);

    if (moduleSpecifier === undefined) {
      continue;
    }

    const targetPath = resolveRelativeImportPath(
      filePath,
      moduleSpecifier,
      context.knownFilesByPath,
    );

    if (targetPath === undefined) {
      continue;
    }

    const targetContent = context.knownFilesByPath.get(targetPath);

    if (targetContent === undefined) {
      continue;
    }

    const targetExports = getExportIndex(targetPath, targetContent);
    const importClause = child.namedChildren.find((node) => node.type === "import_clause");

    if (importClause === undefined) {
      continue;
    }

    for (const node of importClause.namedChildren) {
      if (node.type === "identifier") {
        record(node.text, targetExports.defaultExport);
        continue;
      }

      if (node.type !== "named_imports") {
        continue;
      }

      for (const specifier of node.namedChildren) {
        if (specifier.type !== "import_specifier") {
          continue;
        }

        const importedName = specifier.childForFieldName("name")?.text;

        if (importedName === undefined) {
          continue;
        }

        const localName = specifier.childForFieldName("alias")?.text ?? importedName;
        record(localName, targetExports.namedExports.get(importedName));
      }
    }
  }

  for (const name of ambiguous) {
    resolved.delete(name);
  }

  return resolved;
}

function collectDeclarationEdges(
  declaration: SyntaxNode,
  symbolByNodeStartIndex: ReadonlyMap<number, SymbolRecord>,
  resolution: CallReferenceResolution,
  callEdges: Map<string, EdgeRecord>,
  referencePairs: ReferencePair[],
): void {
  switch (declaration.type) {
    case "function_declaration":
    case "generator_function_declaration": {
      const source = symbolByNodeStartIndex.get(declaration.startIndex);

      if (source === undefined) {
        return;
      }

      const boundNames = collectBoundNames(declaration);
      collectScopeEdges(declaration, source, null, boundNames, resolution, callEdges, referencePairs);
      return;
    }
    case "class_declaration": {
      collectClassDeclarationEdges(
        declaration,
        symbolByNodeStartIndex,
        resolution,
        callEdges,
        referencePairs,
      );
      return;
    }
    case "interface_declaration": {
      const source = symbolByNodeStartIndex.get(declaration.startIndex);

      if (source === undefined) {
        return;
      }

      // Walking the whole interface picks up `extends` types and member type
      // annotations; the interface's own name resolves to itself and is dropped
      // as a self-edge.
      collectScopeEdges(declaration, source, null, new Set(), resolution, callEdges, referencePairs);
      return;
    }
    case "type_alias_declaration": {
      const source = symbolByNodeStartIndex.get(declaration.startIndex);
      const value = declaration.childForFieldName("value");

      if (source === undefined || value === null) {
        return;
      }

      collectScopeEdges(value, source, null, new Set(), resolution, callEdges, referencePairs);
      return;
    }
    default:
      return;
  }
}

function collectClassDeclarationEdges(
  declaration: SyntaxNode,
  symbolByNodeStartIndex: ReadonlyMap<number, SymbolRecord>,
  resolution: CallReferenceResolution,
  callEdges: Map<string, EdgeRecord>,
  referencePairs: ReferencePair[],
): void {
  const classSymbol = symbolByNodeStartIndex.get(declaration.startIndex);

  if (classSymbol !== undefined) {
    collectClassHeritageReferences(declaration, classSymbol, resolution, callEdges, referencePairs);
    collectDecoratorReferences(declaration, classSymbol, resolution, referencePairs);
  }

  const className = getNamedDeclarationName(declaration);
  const body = declaration.childForFieldName("body");

  if (body === null) {
    return;
  }

  let pendingDecorators: SyntaxNode[] = [];

  for (const member of body.namedChildren) {
    if (member.type === "decorator") {
      pendingDecorators.push(member);
      continue;
    }

    if (member.type === "method_definition") {
      const methodSymbol = symbolByNodeStartIndex.get(member.startIndex);

      if (methodSymbol !== undefined) {
        const boundNames = collectBoundNames(member);
        collectScopeEdges(
          member,
          methodSymbol,
          className ?? null,
          boundNames,
          resolution,
          callEdges,
          referencePairs,
        );

        for (const decorator of pendingDecorators) {
          collectDecoratorNodeReference(decorator, methodSymbol, resolution, referencePairs);
        }
      }

      pendingDecorators = [];
      continue;
    }

    if (member.type === "public_field_definition") {
      if (classSymbol !== undefined) {
        const boundNames = collectBoundNames(member);
        collectScopeEdges(
          member,
          classSymbol,
          className ?? null,
          boundNames,
          resolution,
          callEdges,
          referencePairs,
        );
        collectDecoratorReferences(member, classSymbol, resolution, referencePairs);

        for (const decorator of pendingDecorators) {
          collectDecoratorNodeReference(decorator, classSymbol, resolution, referencePairs);
        }
      }

      pendingDecorators = [];
      continue;
    }

    pendingDecorators = [];
  }
}

// Class `extends`/`implements` references. `extends` exposes its base as a value
// `identifier`; `implements` (and any generic type arguments) expose types that
// the generic type-identifier walk resolves.
function collectClassHeritageReferences(
  declaration: SyntaxNode,
  classSymbol: SymbolRecord,
  resolution: CallReferenceResolution,
  callEdges: Map<string, EdgeRecord>,
  referencePairs: ReferencePair[],
): void {
  const heritage = declaration.namedChildren.find((node) => node.type === "class_heritage");

  if (heritage === undefined) {
    return;
  }

  for (const clause of heritage.namedChildren) {
    if (clause.type !== "extends_clause") {
      continue;
    }

    const value = clause.childForFieldName("value");

    if (value !== null && value.type === "identifier") {
      const target = resolveTypeName(value.text, resolution);

      if (target !== undefined && target.id !== classSymbol.id) {
        referencePairs.push({ src: classSymbol.id, dst: target.id });
      }
    }
  }

  collectScopeEdges(heritage, classSymbol, null, new Set(), resolution, callEdges, referencePairs);
}

function collectDecoratorReferences(
  node: SyntaxNode,
  source: SymbolRecord,
  resolution: CallReferenceResolution,
  referencePairs: ReferencePair[],
): void {
  for (const child of node.namedChildren) {
    if (child.type !== "decorator") {
      continue;
    }

    collectDecoratorNodeReference(child, source, resolution, referencePairs);
  }
}

function collectDecoratorNodeReference(
  decorator: SyntaxNode,
  source: SymbolRecord,
  resolution: CallReferenceResolution,
  referencePairs: ReferencePair[],
): void {
  const expression = decorator.namedChildren[0];

  if (expression === undefined) {
    return;
  }

  let nameNode: SyntaxNode | undefined;

  if (expression.type === "identifier") {
    nameNode = expression;
  } else if (expression.type === "call_expression") {
    const callee = expression.childForFieldName("function");

    if (callee !== null && callee.type === "identifier") {
      nameNode = callee;
    }
  }

  if (nameNode === undefined) {
    return;
  }

  const target = resolveDecoratorTarget(nameNode.text, resolution);

  if (target !== undefined && target.id !== source.id) {
    referencePairs.push({ src: source.id, dst: target.id });
  }
}

// Walks a single source scope (a function body, method, class field, or type
// node), emitting call edges and collecting reference pairs. Nested scopes that
// rebind `this` (nested functions/classes) are not descended into, so resolved
// `this.method` targets always belong to the enclosing class; arrow functions
// share lexical `this` and are traversed. Decorators are handled separately.
function collectScopeEdges(
  scope: SyntaxNode,
  source: SymbolRecord,
  enclosingClassName: string | null,
  boundNames: ReadonlySet<string>,
  resolution: CallReferenceResolution,
  callEdges: Map<string, EdgeRecord>,
  referencePairs: ReferencePair[],
): void {
  const walk = (node: SyntaxNode): void => {
    if (node !== scope && isThisRebindingScope(node)) {
      return;
    }

    switch (node.type) {
      case "decorator":
        return;
      case "call_expression": {
        const callee = node.childForFieldName("function");
        const target = resolveCallTarget(callee, enclosingClassName, boundNames, resolution);

        if (target !== undefined && target.id !== source.id) {
          const edge = makeCallsEdge(source.id, target.id);
          callEdges.set(edge.id, withCallSite(callEdges.get(edge.id) ?? edge, treeSitterCallSite(node)));
        }

        break;
      }
      case "new_expression": {
        const constructor = node.childForFieldName("constructor");

        if (
          constructor !== null
          && constructor.type === "identifier"
          && !boundNames.has(constructor.text)
        ) {
          const target = resolveTypeName(constructor.text, resolution);

          if (
            target !== undefined
            && target.kind === SymbolKind.Class
            && target.id !== source.id
          ) {
            referencePairs.push({ src: source.id, dst: target.id });
          }
        }

        break;
      }
      case "type_identifier": {
        // The tail of a qualified type (`Module.Type`) is skipped conservatively.
        if (node.parent?.type !== "nested_type_identifier") {
          const target = resolveTypeName(node.text, resolution);

          if (target !== undefined && target.id !== source.id) {
            referencePairs.push({ src: source.id, dst: target.id });
          }
        }

        break;
      }
      default:
        break;
    }

    for (const child of node.namedChildren) {
      walk(child);
    }
  };

  walk(scope);
}

function isThisRebindingScope(node: SyntaxNode): boolean {
  return (
    node.type === "function_declaration"
    || node.type === "function_expression"
    || node.type === "generator_function_declaration"
    || node.type === "generator_function"
    || node.type === "method_definition"
    || node.type === "class_declaration"
    || node.type === "class_expression"
  );
}

function resolveCallTarget(
  callee: SyntaxNode | null,
  enclosingClassName: string | null,
  boundNames: ReadonlySet<string>,
  resolution: CallReferenceResolution,
): SymbolRecord | undefined {
  if (callee === null) {
    return undefined;
  }

  if (callee.type === "identifier") {
    const name = callee.text;

    if (boundNames.has(name)) {
      return undefined;
    }

    const local = resolveUnambiguousTopLevel(name, resolution);

    if (local !== undefined && local.kind === SymbolKind.Function) {
      return local;
    }

    const imported = resolution.importedByLocalName.get(name);

    if (imported !== undefined && imported.kind === SymbolKind.Function) {
      return imported;
    }

    return undefined;
  }

  if (callee.type === "member_expression") {
    const object = callee.childForFieldName("object");
    const property = callee.childForFieldName("property");

    if (object === null || property === null || property.type !== "property_identifier") {
      return undefined;
    }

    const methodName = property.text;

    if (object.type === "this") {
      if (enclosingClassName === null) {
        return undefined;
      }

      return resolution.classMembersByClassName.get(enclosingClassName)?.get(methodName);
    }

    if (object.type === "identifier") {
      const objectName = object.text;

      if (boundNames.has(objectName)) {
        return undefined;
      }

      const classSymbol = resolveUnambiguousTopLevel(objectName, resolution);

      if (classSymbol !== undefined && classSymbol.kind === SymbolKind.Class) {
        return resolution.classMembersByClassName.get(objectName)?.get(methodName);
      }
    }

    return undefined;
  }

  return undefined;
}

function resolveTypeName(
  name: string,
  resolution: CallReferenceResolution,
): SymbolRecord | undefined {
  const local = resolveUnambiguousTopLevel(name, resolution);

  if (local !== undefined && isTypeSymbolKind(local.kind)) {
    return local;
  }

  const imported = resolution.importedByLocalName.get(name);

  if (imported !== undefined && isTypeSymbolKind(imported.kind)) {
    return imported;
  }

  return undefined;
}

function resolveDecoratorTarget(
  name: string,
  resolution: CallReferenceResolution,
): SymbolRecord | undefined {
  const local = resolveUnambiguousTopLevel(name, resolution);

  if (local !== undefined && isDecoratorSymbolKind(local.kind)) {
    return local;
  }

  const imported = resolution.importedByLocalName.get(name);

  if (imported !== undefined && isDecoratorSymbolKind(imported.kind)) {
    return imported;
  }

  return undefined;
}

function resolveUnambiguousTopLevel(
  name: string,
  resolution: CallReferenceResolution,
): SymbolRecord | undefined {
  if (resolution.ambiguousNames.has(name)) {
    return undefined;
  }

  return resolution.topLevelByName.get(name);
}

function isTypeSymbolKind(kind: SymbolKind): boolean {
  return (
    kind === SymbolKind.Class
    || kind === SymbolKind.Interface
    || kind === SymbolKind.TypeAlias
  );
}

function isDecoratorSymbolKind(kind: SymbolKind): boolean {
  return kind === SymbolKind.Class || kind === SymbolKind.Function;
}

// Collects value binding names introduced inside a scope (parameters, local
// variable declarators, and nested function/class names) so that calls and
// instantiations targeting a shadowed name are skipped rather than resolved to
// an unrelated top-level symbol. Type positions are not bindings and are
// ignored.
function collectBoundNames(scope: SyntaxNode): Set<string> {
  const names = new Set<string>();

  const walk = (node: SyntaxNode): void => {
    if (node.type === "type_annotation") {
      return;
    }

    if (node.type === "required_parameter" || node.type === "optional_parameter") {
      const pattern = node.childForFieldName("pattern");

      if (pattern !== null) {
        collectPatternNames(pattern, names);
      }
    } else if (node.type === "variable_declarator") {
      const name = node.childForFieldName("name");

      if (name !== null) {
        collectPatternNames(name, names);
      }
    } else if (
      node.type === "function_declaration"
      || node.type === "generator_function_declaration"
      || node.type === "class_declaration"
    ) {
      const name = node.childForFieldName("name");

      if (name !== null) {
        names.add(name.text);
      }
    }

    for (const child of node.namedChildren) {
      walk(child);
    }
  };

  for (const child of scope.namedChildren) {
    walk(child);
  }

  return names;
}

function collectPatternNames(pattern: SyntaxNode, names: Set<string>): void {
  if (
    pattern.type === "identifier"
    || pattern.type === "shorthand_property_identifier_pattern"
  ) {
    names.add(pattern.text);
    return;
  }

  for (const child of pattern.namedChildren) {
    if (child.type === "type_annotation") {
      continue;
    }

    collectPatternNames(child, names);
  }
}

function collectDiagnostics(content: string, rootNode: SyntaxNode): ParseDiagnostic[] {
  const diagnostics: ParseDiagnostic[] = [];

  collectDiagnosticsFromNode(content, rootNode, diagnostics);

  return diagnostics;
}

function collectDiagnosticsFromNode(
  content: string,
  node: SyntaxNode,
  diagnostics: ParseDiagnostic[],
): void {
  if (node.isError || node.isMissing) {
    diagnostics.push({
      message: node.isMissing ? `Missing ${node.type}` : "Syntax error",
      startLine: node.startPosition.row + 1,
      startByte: offsetsFor(content).byteOffsetAt(node.startIndex),
    });
  }

  if (!node.hasError && !node.isError && !node.isMissing) {
    return;
  }

  for (const child of node.children) {
    collectDiagnosticsFromNode(content, child, diagnostics);
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function hashParts(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function makeParserContext(options: TypeScriptParserOptions): TypeScriptParserContext {
  const knownFilesByPath = new Map<string, string>();

  for (const file of options.knownFiles ?? []) {
    knownFilesByPath.set(normalizeKnownFilePath(file.path), file.content);
  }

  return { knownFilesByPath };
}

function normalizeKnownFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function getDirectoryName(filePath: string): string {
  const lastSlashIndex = filePath.lastIndexOf("/");

  return lastSlashIndex === -1 ? "." : filePath.slice(0, lastSlashIndex);
}

function pathJoin(left: string, right: string): string {
  const joined = left === "." ? right : `${left}/${right}`;
  const segments: string[] = [];

  for (const segment of joined.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (segments.length === 0) {
        return "../";
      }

      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return segments.join("/");
}
