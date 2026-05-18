import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  EdgeType,
  Language,
  SymbolKind,
  buildFQName,
  computeFileId,
  computeSymbolId,
  normalizeFilePath,
  type EdgeRecord,
  type ParseResult,
  type SymbolRecord,
} from "../domain/types";
import { parsePython } from "./pythonParser";
import { ParserError } from "./errors";
import type { LanguageParser } from "./LanguageParser";
import type { ParseFileInput } from "./types";

interface CythonParserContext {
  interpreterCandidates: readonly string[];
  knownFilesByPath: ReadonlyMap<string, string>;
  moduleNameByFilePath: ReadonlyMap<string, string>;
  runtimeModulePathsByName: ReadonlyMap<string, readonly string[]>;
  cimportModulePathsByName: ReadonlyMap<string, readonly string[]>;
}

interface CythonParsePayload {
  items: CythonFunctionItem[];
  imports: CythonImport[];
}

interface CythonFunctionItem {
  name: string;
  signature: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
}

type CythonImport =
  | CythonModuleImport
  | CythonFromImport
  | CythonIncludeImport;

interface CythonModuleImport {
  kind: "import_module" | "cimport_module";
  module: string;
  asName?: string;
}

interface CythonFromImport {
  kind: "from_import" | "from_cimport";
  module?: string;
  level: number;
  importedName: string;
  asName?: string;
}

interface CythonIncludeImport {
  kind: "include_file";
  includePath: string;
}

interface ExtractImportEdgesInput {
  filePath: string;
  imports: readonly CythonImport[];
  sourceSymbols: readonly SymbolRecord[];
  context: CythonParserContext;
}

interface CythonExportIndex {
  moduleSymbol?: SymbolRecord;
  namedSymbols: ReadonlyMap<string, SymbolRecord>;
}

export interface CythonKnownFile {
  path: string;
  content: string;
}

export interface CythonParserOptions {
  interpreterCandidates?: readonly string[];
  knownFiles?: readonly CythonKnownFile[];
}

const DEFAULT_INTERPRETER_CANDIDATES = ["python3", "python"] as const;
const MODULE_FILE_EXTENSIONS = [".py", ".pyx", ".pxd"] as const;
const PACKAGE_MARKER_FILE_NAMES = new Set(["__init__.py", "__init__.pyx", "__init__.pxd"]);

const CYTHON_TOKENIZER_SCRIPT = `
import ast
import io
import json
import token
import tokenize
import sys

source = sys.stdin.read()
file_path = sys.argv[1]
lines = source.splitlines(keepends=True)

if not lines:
    lines = [""]

line_start_bytes = [0]

for line in lines:
    line_start_bytes.append(line_start_bytes[-1] + len(line.encode("utf-8")))

def absolute_byte(position):
    line, column = position
    line_text = lines[line - 1] if 1 <= line <= len(lines) else ""
    return line_start_bytes[line - 1] + len(line_text[:column].encode("utf-8"))

def is_trivia(tok):
    return tok.type in {
        tokenize.COMMENT,
        tokenize.NL,
        token.NEWLINE,
        token.INDENT,
        token.DEDENT,
    }

def is_significant(tok):
    return tok.type != token.ENDMARKER and not is_trivia(tok)

def previous_significant(tokens, start_index, end_index):
    for index in range(end_index, start_index - 1, -1):
        tok = tokens[index]
        if is_significant(tok):
            return tok
    return None

def next_significant(tokens, start_index):
    for index in range(start_index, len(tokens)):
        tok = tokens[index]
        if is_significant(tok):
            return tok
    return None

def statement_end(tokens, start_index):
    paren_depth = 0
    bracket_depth = 0
    brace_depth = 0
    last_significant = None

    for index in range(start_index + 1, len(tokens)):
        tok = tokens[index]

        if tok.type == token.OP:
            if tok.string == "(":
                paren_depth += 1
            elif tok.string == ")":
                paren_depth = max(paren_depth - 1, 0)
            elif tok.string == "[":
                bracket_depth += 1
            elif tok.string == "]":
                bracket_depth = max(bracket_depth - 1, 0)
            elif tok.string == "{":
                brace_depth += 1
            elif tok.string == "}":
                brace_depth = max(brace_depth - 1, 0)

        if paren_depth == 0 and bracket_depth == 0 and brace_depth == 0:
            if tok.type == token.NEWLINE:
                return index, last_significant

            if tok.type == token.ENDMARKER:
                return index, last_significant

            if tok.type == token.OP and tok.string == ":":
                for candidate_index in range(index + 1, len(tokens)):
                    candidate = tokens[candidate_index]

                    if candidate.type == token.NEWLINE or candidate.type == token.ENDMARKER:
                        return candidate_index, tok

                return len(tokens) - 1, tok

        if is_significant(tok):
            last_significant = tok

    return len(tokens) - 1, last_significant

def collect_statement_tokens(tokens, start_index):
    paren_depth = 0
    bracket_depth = 0
    brace_depth = 0
    statement = []

    for index in range(start_index, len(tokens)):
        tok = tokens[index]

        if tok.type == token.OP:
            if tok.string == "(":
                paren_depth += 1
            elif tok.string == ")":
                paren_depth = max(paren_depth - 1, 0)
            elif tok.string == "[":
                bracket_depth += 1
            elif tok.string == "]":
                bracket_depth = max(bracket_depth - 1, 0)
            elif tok.string == "{":
                brace_depth += 1
            elif tok.string == "}":
                brace_depth = max(brace_depth - 1, 0)

        if tok.type == token.NEWLINE and paren_depth == 0 and bracket_depth == 0 and brace_depth == 0:
            return statement, index + 1

        if tok.type == token.ENDMARKER:
            return statement, index + 1

        if is_significant(tok):
            statement.append(tok)

    return statement, len(tokens)

def block_end(tokens, header_end_index, header_end_token):
    if header_end_token is None or header_end_token.type != token.OP or header_end_token.string != ":":
        return header_end_token

    for index in range(header_end_index + 1, len(tokens)):
        tok = tokens[index]

        if tok.type == tokenize.NL or tok.type == tokenize.COMMENT:
            continue

        if tok.type != token.INDENT:
            return header_end_token

        depth = 1
        last_body_token = None

        for body_index in range(index + 1, len(tokens)):
            body_tok = tokens[body_index]

            if body_tok.type == token.INDENT:
                depth += 1
                continue

            if body_tok.type == token.DEDENT:
                depth -= 1

                if depth == 0:
                    return last_body_token if last_body_token is not None else header_end_token

                continue

            if is_significant(body_tok):
                last_body_token = body_tok

        return last_body_token if last_body_token is not None else header_end_token

    return header_end_token

def read_dotted_name(tokens, start_index):
    index = start_index

    if index >= len(tokens) or tokens[index].type != token.NAME:
        return None, start_index

    segments = [tokens[index].string]
    index += 1

    while index + 1 < len(tokens):
        if tokens[index].type != token.OP or tokens[index].string != ".":
            break

        if tokens[index + 1].type != token.NAME:
            return None, start_index

        segments.append(tokens[index + 1].string)
        index += 2

    return ".".join(segments), index

def parse_module_imports(statement_tokens, kind):
    imports = []
    index = 1

    while index < len(statement_tokens):
        module_name, index = read_dotted_name(statement_tokens, index)

        if module_name is None:
            return []

        imported = {"kind": kind, "module": module_name}

        if index + 1 < len(statement_tokens):
            if (
                statement_tokens[index].type == token.NAME
                and statement_tokens[index].string == "as"
                and statement_tokens[index + 1].type == token.NAME
            ):
                imported["asName"] = statement_tokens[index + 1].string
                index += 2

        imports.append(imported)

        if index >= len(statement_tokens):
            break

        if statement_tokens[index].type == token.OP and statement_tokens[index].string == ",":
            index += 1
            continue

        return []

    return imports

def parse_from_imports(statement_tokens):
    index = 1
    level = 0

    while index < len(statement_tokens):
        tok = statement_tokens[index]

        if tok.type == token.OP and tok.string == ".":
            level += 1
            index += 1
            continue

        break

    module_name = None

    if index < len(statement_tokens) and statement_tokens[index].type == token.NAME:
        module_name, index = read_dotted_name(statement_tokens, index)

        if module_name is None:
            return []

    if index >= len(statement_tokens):
        return []

    kind_token = statement_tokens[index]

    if kind_token.type != token.NAME or kind_token.string not in {"import", "cimport"}:
        return []

    kind = "from_import" if kind_token.string == "import" else "from_cimport"
    index += 1

    if index < len(statement_tokens) and statement_tokens[index].type == token.OP and statement_tokens[index].string == "(":
        index += 1

    imports = []

    while index < len(statement_tokens):
        tok = statement_tokens[index]

        if tok.type == token.OP and tok.string in {",", ")"}:
            index += 1
            continue

        if tok.type == token.OP and tok.string == "*":
            imported_name = "*"
            index += 1
        elif tok.type == token.NAME:
            imported_name = tok.string
            index += 1
        else:
            return []

        imported = {
            "kind": kind,
            "level": level,
            "importedName": imported_name,
        }

        if module_name is not None:
            imported["module"] = module_name

        if index + 1 < len(statement_tokens):
            if (
                statement_tokens[index].type == token.NAME
                and statement_tokens[index].string == "as"
                and statement_tokens[index + 1].type == token.NAME
            ):
                imported["asName"] = statement_tokens[index + 1].string
                index += 2

        imports.append(imported)

        if index >= len(statement_tokens):
            break

        if statement_tokens[index].type == token.OP and statement_tokens[index].string in {",", ")"}:
            index += 1
            continue

        return []

    return imports

def parse_include(statement_tokens):
    if len(statement_tokens) != 2 or statement_tokens[1].type != token.STRING:
        return None

    try:
        include_path = ast.literal_eval(statement_tokens[1].string)
    except Exception:
        return None

    if not isinstance(include_path, str) or len(include_path) == 0:
        return None

    return {"kind": "include_file", "includePath": include_path}

def parse_function(tokens, start_index):
    keyword = tokens[start_index]
    header_end_index, signature_end_token = statement_end(tokens, start_index)
    terminator_index = header_end_index
    terminator_token = signature_end_token
    open_paren_index = None
    paren_depth = 0
    bracket_depth = 0
    brace_depth = 0

    for index in range(start_index + 1, len(tokens)):
        tok = tokens[index]

        if index > header_end_index:
            break

        if tok.type != token.OP:
            continue

        if tok.string == "(":
            if (
                paren_depth == 0
                and bracket_depth == 0
                and brace_depth == 0
                and open_paren_index is None
            ):
                open_paren_index = index
                break

            paren_depth += 1
        elif tok.string == ")":
            paren_depth = max(paren_depth - 1, 0)
        elif tok.string == "[":
            bracket_depth += 1
        elif tok.string == "]":
            bracket_depth = max(bracket_depth - 1, 0)
        elif tok.string == "{":
            brace_depth += 1
        elif tok.string == "}":
            brace_depth = max(brace_depth - 1, 0)

    if open_paren_index is None:
        return None, terminator_index + 1

    name_token = previous_significant(tokens, start_index + 1, open_paren_index - 1)
    first_parameter_token = next_significant(tokens, open_paren_index + 1)

    if name_token is None or name_token.type != token.NAME:
        return None, terminator_index + 1

    if name_token.string in {"class", "enum", "extern", "from", "struct", "union"}:
        return None, terminator_index + 1

    if first_parameter_token is not None and first_parameter_token.string in {"*", "&"}:
        return None, terminator_index + 1

    block_end_token = block_end(tokens, header_end_index, terminator_token)

    if block_end_token is None:
        return None, terminator_index + 1

    start_byte = absolute_byte(keyword.start)
    signature_end_byte = absolute_byte(signature_end_token.end)
    end_byte = absolute_byte(block_end_token.end)
    signature = source.encode("utf-8")[start_byte:signature_end_byte].decode("utf-8").strip()

    if not signature:
        return None, terminator_index + 1

    return {
        "name": name_token.string,
        "signature": signature,
        "startLine": keyword.start[0],
        "endLine": block_end_token.end[0],
        "startByte": start_byte,
        "endByte": end_byte,
    }, terminator_index + 1

try:
    tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
except tokenize.TokenError as error:
    message, location = error.args
    line_suffix = f" (line {location[0]})" if location else ""
    print(f"SyntaxError: {message}{line_suffix}", file=sys.stderr)
    raise SystemExit(2)
except IndentationError as error:
    line_suffix = f" (line {error.lineno})" if error.lineno is not None else ""
    message = getattr(error, "msg", str(error))
    print(f"SyntaxError: {message}{line_suffix}", file=sys.stderr)
    raise SystemExit(2)

items = []
imports = []
indent_depth = 0
index = 0
at_statement_start = True

while index < len(tokens):
    tok = tokens[index]

    if tok.type == token.INDENT:
        indent_depth += 1
        at_statement_start = True
        index += 1
        continue

    if tok.type == token.DEDENT:
        indent_depth = max(indent_depth - 1, 0)
        at_statement_start = True
        index += 1
        continue

    if tok.type == tokenize.NL or tok.type == token.NEWLINE:
        at_statement_start = True
        index += 1
        continue

    if tok.type == tokenize.COMMENT:
        index += 1
        continue

    if indent_depth == 0 and at_statement_start and tok.type == token.NAME:
        if tok.string in {"def", "cdef", "cpdef"}:
            item, next_index = parse_function(tokens, index)

            if item is not None:
                items.append(item)

            index = next_index
            at_statement_start = True
            continue

        if tok.string == "import":
            statement_tokens, next_index = collect_statement_tokens(tokens, index)
            imports.extend(parse_module_imports(statement_tokens, "import_module"))
            index = next_index
            at_statement_start = True
            continue

        if tok.string == "cimport":
            statement_tokens, next_index = collect_statement_tokens(tokens, index)
            imports.extend(parse_module_imports(statement_tokens, "cimport_module"))
            index = next_index
            at_statement_start = True
            continue

        if tok.string == "from":
            statement_tokens, next_index = collect_statement_tokens(tokens, index)
            imports.extend(parse_from_imports(statement_tokens))
            index = next_index
            at_statement_start = True
            continue

        if tok.string == "include":
            statement_tokens, next_index = collect_statement_tokens(tokens, index)
            include = parse_include(statement_tokens)

            if include is not None:
                imports.append(include)

            index = next_index
            at_statement_start = True
            continue

    at_statement_start = False
    index += 1

json.dump({"imports": imports, "items": items}, sys.stdout, sort_keys=True, separators=(",", ":"))
`.trim();

export const cythonParser: LanguageParser = createCythonParser();

export function createCythonParser(
  options: CythonParserOptions = {},
): LanguageParser {
  const context = makeParserContext(options);

  return {
    language: Language.Cython,
    async parse(input: ParseFileInput): Promise<ParseResult> {
      return parseCythonWithContext(input, context);
    },
  };
}

export function parseCython(
  input: ParseFileInput,
  options: CythonParserOptions = {},
): ParseResult {
  return parseCythonWithContext(input, makeParserContext(options));
}

function parseCythonWithContext(
  input: ParseFileInput,
  context: CythonParserContext,
): ParseResult {
  if (input.language !== Language.Cython) {
    throw ParserError.unsupportedLanguage(input.path, input.language);
  }

  const resolutionContext = withKnownFile(context, input.path, input.content);
  const payload = parseCythonItems(input.path, input.content, resolutionContext);
  const symbols = extractTopLevelSymbols(input.path, payload.items);
  const importEdges = extractImportEdges({
    filePath: input.path,
    imports: payload.imports,
    sourceSymbols: symbols,
    context: resolutionContext,
  });

  return {
    file: {
      id: computeFileId(input.path),
      path: input.path,
      language: input.language,
      contentHash: hashContent(input.content),
      sizeBytes: Buffer.byteLength(input.content),
    },
    symbols,
    edges: importEdges,
    diagnostics: [],
  };
}

function parseCythonItems(
  filePath: string,
  content: string,
  context: CythonParserContext,
): CythonParsePayload {
  let missingInterpreterError: Error | undefined;

  for (const interpreter of context.interpreterCandidates) {
    const result = spawnSync(interpreter, ["-c", CYTHON_TOKENIZER_SCRIPT, filePath], {
      encoding: "utf8",
      input: content,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.error !== undefined) {
      if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
        missingInterpreterError = result.error;
        continue;
      }

      throw result.error;
    }

    if (result.status !== 0) {
      const message = result.stderr.trim() || result.stdout.trim();
      throw new Error(message.length > 0 ? message : `Cython parser exited with code ${result.status}`);
    }

    return JSON.parse(result.stdout) as CythonParsePayload;
  }

  const attempted = context.interpreterCandidates.join(", ");
  const cause = missingInterpreterError instanceof Error ? `: ${missingInterpreterError.message}` : "";
  throw new Error(`No Python interpreter available for Cython parser (${attempted})${cause}`);
}

function extractTopLevelSymbols(
  filePath: string,
  items: readonly CythonFunctionItem[],
): SymbolRecord[] {
  return items.map((item) => makeSymbolRecord(filePath, item));
}

function extractImportEdges(input: ExtractImportEdgesInput): EdgeRecord[] {
  const sourceSymbol = getUnambiguousImportSourceSymbol(input.sourceSymbols);

  if (sourceSymbol === undefined) {
    return [];
  }

  const exportIndexByPath = new Map<string, CythonExportIndex>();
  const edgesById = new Map<string, EdgeRecord>();

  for (const imported of input.imports) {
    const targetPath = resolveImportedTargetPath(
      input.filePath,
      imported,
      input.context,
    );

    if (targetPath === undefined) {
      continue;
    }

    const targetContent = input.context.knownFilesByPath.get(targetPath);

    if (targetContent === undefined) {
      continue;
    }

    const exportIndex = getCythonExportIndex(
      targetPath,
      targetContent,
      input.context,
      exportIndexByPath,
    );
    const targetSymbol = resolveImportedSymbol(imported, exportIndex);

    if (targetSymbol === undefined) {
      continue;
    }

    const edge = makeImportEdge(sourceSymbol.id, targetSymbol.id);
    edgesById.set(edge.id, edge);
  }

  return [...edgesById.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function getUnambiguousImportSourceSymbol(
  symbols: readonly SymbolRecord[],
): SymbolRecord | undefined {
  const topLevelSymbols = symbols.filter((symbol) => symbol.parentSymbolId === undefined);

  return topLevelSymbols.length === 1 ? topLevelSymbols[0] : undefined;
}

function resolveImportedTargetPath(
  importerFilePath: string,
  imported: CythonImport,
  context: CythonParserContext,
): string | undefined {
  if (imported.kind === "include_file") {
    return resolveIncludedFilePath(importerFilePath, imported.includePath, context);
  }

  if (imported.kind === "import_module") {
    return resolveRuntimeModulePath(imported.module, context);
  }

  if (imported.kind === "cimport_module") {
    return resolveCimportModulePath(imported.module, context);
  }

  const moduleName = resolveImportFromModuleName(importerFilePath, imported, context);

  if (moduleName === undefined) {
    return undefined;
  }

  return imported.kind === "from_import"
    ? resolveRuntimeModulePath(moduleName, context)
    : resolveCimportModulePath(moduleName, context);
}

function resolveImportedSymbol(
  imported: CythonImport,
  exportIndex: CythonExportIndex,
): SymbolRecord | undefined {
  if (
    imported.kind === "import_module"
    || imported.kind === "cimport_module"
    || imported.kind === "include_file"
  ) {
    return exportIndex.moduleSymbol;
  }

  if (imported.importedName === "*") {
    return undefined;
  }

  return exportIndex.namedSymbols.get(imported.importedName);
}

function resolveImportFromModuleName(
  importerFilePath: string,
  imported: CythonFromImport,
  context: CythonParserContext,
): string | undefined {
  if (imported.level === 0) {
    return normalizeModuleName(imported.module);
  }

  const importerModuleName = context.moduleNameByFilePath.get(normalizeKnownFilePath(importerFilePath));

  if (importerModuleName === undefined) {
    return undefined;
  }

  const importerPackageSegments = getImporterPackageSegments(importerFilePath, importerModuleName);
  const parentDepth = imported.level - 1;

  if (parentDepth > importerPackageSegments.length) {
    return undefined;
  }

  const baseSegments = importerPackageSegments.slice(0, importerPackageSegments.length - parentDepth);
  const moduleSegments = normalizeModuleName(imported.module)?.split(".") ?? [];
  const resolvedSegments = [...baseSegments, ...moduleSegments];

  return resolvedSegments.length === 0 ? undefined : resolvedSegments.join(".");
}

function getImporterPackageSegments(
  importerFilePath: string,
  importerModuleName: string,
): string[] {
  const moduleSegments = importerModuleName.split(".");

  return importerFilePath.endsWith("/__init__.py")
    || importerFilePath.endsWith("/__init__.pyx")
    || importerFilePath.endsWith("/__init__.pxd")
    || importerFilePath === "__init__.py"
    || importerFilePath === "__init__.pyx"
    || importerFilePath === "__init__.pxd"
    ? moduleSegments
    : moduleSegments.slice(0, -1);
}

function resolveRuntimeModulePath(
  moduleName: string,
  context: CythonParserContext,
): string | undefined {
  const normalizedModuleName = normalizeModuleName(moduleName);

  if (normalizedModuleName === undefined) {
    return undefined;
  }

  const paths = context.runtimeModulePathsByName.get(normalizedModuleName);

  return paths?.length === 1 ? paths[0] : undefined;
}

function resolveCimportModulePath(
  moduleName: string,
  context: CythonParserContext,
): string | undefined {
  const normalizedModuleName = normalizeModuleName(moduleName);

  if (normalizedModuleName === undefined) {
    return undefined;
  }

  const pxdPaths = context.cimportModulePathsByName.get(normalizedModuleName);

  if (pxdPaths?.length === 1) {
    return pxdPaths[0];
  }

  if ((pxdPaths?.length ?? 0) > 1) {
    return undefined;
  }

  const runtimeFallbackPaths = context.runtimeModulePathsByName.get(normalizedModuleName)
    ?.filter((filePath) => filePath.endsWith(".pyx"));

  return runtimeFallbackPaths?.length === 1 ? runtimeFallbackPaths[0] : undefined;
}

function resolveIncludedFilePath(
  importerFilePath: string,
  includePath: string,
  context: CythonParserContext,
): string | undefined {
  if (!includePath.endsWith(".pxi")) {
    return undefined;
  }

  const candidates = new Set<string>();
  const importerDirectory = getDirectoryName(importerFilePath);
  const relativePath = pathJoin(importerDirectory, includePath);

  if (relativePath !== undefined) {
    candidates.add(relativePath);
  }

  const normalizedLiteralPath = normalizeLiteralFilePath(includePath);

  if (normalizedLiteralPath !== undefined) {
    candidates.add(normalizedLiteralPath);
  }

  const matchingPaths = [...candidates]
    .filter((candidate) => context.knownFilesByPath.has(candidate))
    .sort((left, right) => left.localeCompare(right));

  return matchingPaths.length === 1 ? matchingPaths[0] : undefined;
}

function getCythonExportIndex(
  filePath: string,
  content: string,
  context: CythonParserContext,
  exportIndexByPath: Map<string, CythonExportIndex>,
): CythonExportIndex {
  const existing = exportIndexByPath.get(filePath);

  if (existing !== undefined) {
    return existing;
  }

  try {
    const topLevelSymbols = extractExportSymbols(filePath, content, context);
    const namedSymbolCandidates = new Map<string, SymbolRecord | undefined>();

    for (const symbol of topLevelSymbols) {
      if (!namedSymbolCandidates.has(symbol.localName)) {
        namedSymbolCandidates.set(symbol.localName, symbol);
        continue;
      }

      namedSymbolCandidates.set(symbol.localName, undefined);
    }

    const namedSymbols = new Map<string, SymbolRecord>();

    for (const [localName, symbol] of namedSymbolCandidates) {
      if (symbol !== undefined) {
        namedSymbols.set(localName, symbol);
      }
    }

    const exportIndex: CythonExportIndex = {
      moduleSymbol: topLevelSymbols.length === 1 ? topLevelSymbols[0] : undefined,
      namedSymbols,
    };

    exportIndexByPath.set(filePath, exportIndex);
    return exportIndex;
  } catch {
    const exportIndex: CythonExportIndex = { namedSymbols: new Map() };
    exportIndexByPath.set(filePath, exportIndex);
    return exportIndex;
  }
}

function extractExportSymbols(
  filePath: string,
  content: string,
  context: CythonParserContext,
): SymbolRecord[] {
  if (filePath.endsWith(".py")) {
    return parsePython({
      path: filePath,
      language: Language.Python,
      content,
    }).symbols.filter((symbol) => symbol.parentSymbolId === undefined);
  }

  if (isCythonFilePath(filePath)) {
    return extractTopLevelSymbols(
      filePath,
      parseCythonItems(filePath, content, context).items,
    );
  }

  return [];
}

function makeSymbolRecord(filePath: string, item: CythonFunctionItem): SymbolRecord {
  const fqName = buildFQName({
    filePath,
    symbolPath: [item.name],
  });

  return {
    id: computeSymbolId({
      filePath,
      fqName,
      kind: SymbolKind.Function,
      startByte: item.startByte,
      endByte: item.endByte,
    }),
    filePath,
    fqName,
    localName: item.name,
    kind: SymbolKind.Function,
    signature: item.signature,
    startLine: item.startLine,
    endLine: item.endLine,
    startByte: item.startByte,
    endByte: item.endByte,
    exported: false,
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

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function hashParts(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function makeParserContext(options: CythonParserOptions): CythonParserContext {
  const interpreterCandidates = options.interpreterCandidates ?? DEFAULT_INTERPRETER_CANDIDATES;
  const knownFilesByPath = new Map<string, string>();

  for (const file of options.knownFiles ?? []) {
    knownFilesByPath.set(normalizeKnownFilePath(file.path), file.content);
  }

  const { moduleNameByFilePath, runtimeModulePathsByName, cimportModulePathsByName } = buildModuleIndexes(knownFilesByPath);

  return {
    interpreterCandidates,
    knownFilesByPath,
    moduleNameByFilePath,
    runtimeModulePathsByName,
    cimportModulePathsByName,
  };
}

function withKnownFile(
  context: CythonParserContext,
  filePath: string,
  content: string,
): CythonParserContext {
  const normalizedPath = normalizeKnownFilePath(filePath);

  if (context.knownFilesByPath.get(normalizedPath) === content) {
    return context;
  }

  const knownFilesByPath = new Map(context.knownFilesByPath);
  knownFilesByPath.set(normalizedPath, content);

  const { moduleNameByFilePath, runtimeModulePathsByName, cimportModulePathsByName } = buildModuleIndexes(knownFilesByPath);

  return {
    interpreterCandidates: context.interpreterCandidates,
    knownFilesByPath,
    moduleNameByFilePath,
    runtimeModulePathsByName,
    cimportModulePathsByName,
  };
}

function buildModuleIndexes(
  knownFilesByPath: ReadonlyMap<string, string>,
): Pick<CythonParserContext, "moduleNameByFilePath" | "runtimeModulePathsByName" | "cimportModulePathsByName"> {
  const moduleNameByFilePath = new Map<string, string>();
  const runtimeModulePathsByName = new Map<string, string[]>();
  const cimportModulePathsByName = new Map<string, string[]>();
  const filePaths = [...knownFilesByPath.keys()]
    .filter((filePath) => isModuleFilePath(filePath))
    .sort((left, right) => left.localeCompare(right));

  for (const filePath of filePaths) {
    const moduleName = getCanonicalModuleName(filePath, knownFilesByPath);

    if (moduleName === undefined) {
      continue;
    }

    moduleNameByFilePath.set(filePath, moduleName);

    if (isRuntimeModuleFilePath(filePath)) {
      appendModulePath(runtimeModulePathsByName, moduleName, filePath);
    }

    if (filePath.endsWith(".pxd")) {
      appendModulePath(cimportModulePathsByName, moduleName, filePath);
    }
  }

  return {
    moduleNameByFilePath,
    runtimeModulePathsByName,
    cimportModulePathsByName,
  };
}

function getCanonicalModuleName(
  filePath: string,
  knownFilesByPath: ReadonlyMap<string, string>,
): string | undefined {
  if (!isModuleFilePath(filePath)) {
    return undefined;
  }

  const segments = normalizeKnownFilePath(filePath).split("/");
  const fileName = segments.at(-1);

  if (fileName === undefined) {
    return undefined;
  }

  const directorySegments = segments.slice(0, -1);
  let packageStartIndex = directorySegments.length;

  for (let index = directorySegments.length - 1; index >= 0; index -= 1) {
    const directoryPath = directorySegments.slice(0, index + 1).join("/");

    if (!hasPackageMarker(directoryPath, knownFilesByPath)) {
      break;
    }

    packageStartIndex = index;
  }

  const moduleSegments = directorySegments.slice(packageStartIndex);

  if (PACKAGE_MARKER_FILE_NAMES.has(fileName)) {
    return moduleSegments.length === 0 ? undefined : moduleSegments.join(".");
  }

  const stem = getModuleStem(fileName);

  if (stem === undefined) {
    return undefined;
  }

  return [...moduleSegments, stem].join(".");
}

function hasPackageMarker(
  directoryPath: string,
  knownFilesByPath: ReadonlyMap<string, string>,
): boolean {
  for (const marker of PACKAGE_MARKER_FILE_NAMES) {
    const markerPath = directoryPath.length === 0 ? marker : `${directoryPath}/${marker}`;

    if (knownFilesByPath.has(markerPath)) {
      return true;
    }
  }

  return false;
}

function appendModulePath(
  pathsByName: Map<string, string[]>,
  moduleName: string,
  filePath: string,
): void {
  const existing = pathsByName.get(moduleName);

  if (existing === undefined) {
    pathsByName.set(moduleName, [filePath]);
    return;
  }

  existing.push(filePath);
}

function isModuleFilePath(filePath: string): boolean {
  return MODULE_FILE_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

function isRuntimeModuleFilePath(filePath: string): boolean {
  return filePath.endsWith(".py") || filePath.endsWith(".pyx");
}

function isCythonFilePath(filePath: string): boolean {
  return filePath.endsWith(".pyx") || filePath.endsWith(".pxd") || filePath.endsWith(".pxi");
}

function getModuleStem(fileName: string): string | undefined {
  for (const extension of MODULE_FILE_EXTENSIONS) {
    if (fileName.endsWith(extension)) {
      const stem = fileName.slice(0, -extension.length);
      return stem.length > 0 ? stem : undefined;
    }
  }

  return undefined;
}

function normalizeModuleName(moduleName: string | undefined): string | undefined {
  if (moduleName === undefined) {
    return undefined;
  }

  const segments = moduleName
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  return segments.length === 0 ? undefined : segments.join(".");
}

function normalizeLiteralFilePath(filePath: string): string | undefined {
  try {
    return normalizeFilePath(filePath);
  } catch {
    return undefined;
  }
}

function normalizeKnownFilePath(filePath: string): string {
  return normalizeFilePath(filePath);
}

function getDirectoryName(filePath: string): string {
  const lastSlashIndex = filePath.lastIndexOf("/");

  return lastSlashIndex === -1 ? "." : filePath.slice(0, lastSlashIndex);
}

function pathJoin(left: string, right: string): string | undefined {
  const joined = left === "." ? right : `${left}/${right}`;
  const segments: string[] = [];

  for (const segment of joined.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (segments.length === 0) {
        return undefined;
      }

      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return segments.join("/");
}
