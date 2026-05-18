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
  type EdgeRecord,
  type ParseDiagnostic,
  type ParseResult,
  type SymbolRecord,
} from "../domain/types";
import { ParserError } from "./errors";
import type { LanguageParser } from "./LanguageParser";
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

  const tree = parser.parse(input.content);
  const extracted = extractTopLevelSymbols(input.path, input.content, tree.rootNode);
  const importEdges = extractImportEdges({
    filePath: input.path,
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
    edges: [...extracted.edges, ...importEdges],
    diagnostics: collectDiagnostics(tree.rootNode),
  };
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

  const tree = parser.parse(content);

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
  const id = computeSymbolId({
    filePath: input.filePath,
    fqName,
    kind: input.kind,
    startByte: input.node.startIndex,
    endByte: input.node.endIndex,
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
    startByte: input.node.startIndex,
    endByte: input.node.endIndex,
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

  return Buffer.from(content)
    .subarray(node.startIndex, endIndex)
    .toString("utf8")
    .trim();
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

function collectDiagnostics(rootNode: SyntaxNode): ParseDiagnostic[] {
  const diagnostics: ParseDiagnostic[] = [];

  collectDiagnosticsFromNode(rootNode, diagnostics);

  return diagnostics;
}

function collectDiagnosticsFromNode(
  node: SyntaxNode,
  diagnostics: ParseDiagnostic[],
): void {
  if (node.isError || node.isMissing) {
    diagnostics.push({
      message: node.isMissing ? `Missing ${node.type}` : "Syntax error",
      startLine: node.startPosition.row + 1,
      startByte: node.startIndex,
    });
  }

  if (!node.hasError && !node.isError && !node.isMissing) {
    return;
  }

  for (const child of node.children) {
    collectDiagnosticsFromNode(child, diagnostics);
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
