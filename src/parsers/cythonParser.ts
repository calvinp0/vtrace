// @ts-nocheck
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
import { withCallSite } from "./edgeCallSites";
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
  items: CythonItem[];
  imports: CythonImport[];
}

type CythonItem = CythonFunctionItem | CythonClassItem;

interface CythonCallSite {
  target: string;
  line: number;
}

interface CythonReferenceSite {
  target: string;
  line: number;
}

interface CythonScopeEvidence {
  calls: readonly CythonCallSite[];
  references: readonly CythonReferenceSite[];
  localBindings: readonly string[];
  firstArg: string | null;
}

interface CythonFunctionItem extends CythonScopeEvidence {
  kind: "function";
  name: string;
  signature: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
}

interface CythonMethodItem extends CythonScopeEvidence {
  kind: "method";
  name: string;
  signature: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
}

interface CythonClassItem {
  kind: "class";
  name: string;
  signature: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  bases: readonly CythonReferenceSite[];
  members: readonly CythonMethodItem[];
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
import keyword
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

def block_range(tokens, header_end_index, header_end_token):
    # (body_start_index, body_end_index) over the indented block, or None when
    # the header has no indented block (e.g. a bodyless .pxd declaration).
    if header_end_token is None or header_end_token.type != token.OP or header_end_token.string != ":":
        return None

    for index in range(header_end_index + 1, len(tokens)):
        tok = tokens[index]

        if tok.type == tokenize.NL or tok.type == tokenize.COMMENT:
            continue

        if tok.type != token.INDENT:
            return None

        depth = 1

        for body_index in range(index + 1, len(tokens)):
            body_tok = tokens[body_index]

            if body_tok.type == token.INDENT:
                depth += 1
            elif body_tok.type == token.DEDENT:
                depth -= 1

                if depth == 0:
                    return (index + 1, body_index)

        return (index + 1, len(tokens))

    return None

def find_open_paren(tokens, start_index, header_end_index):
    paren_depth = 0
    bracket_depth = 0
    brace_depth = 0

    for index in range(start_index + 1, len(tokens)):
        if index > header_end_index:
            break

        tok = tokens[index]

        if tok.type != token.OP:
            continue

        if tok.string == "(":
            if paren_depth == 0 and bracket_depth == 0 and brace_depth == 0:
                return index

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

    return None

def matching_close_paren(tokens, open_index):
    depth = 0

    for index in range(open_index, len(tokens)):
        tok = tokens[index]

        if tok.type == token.OP:
            if tok.string == "(":
                depth += 1
            elif tok.string == ")":
                depth -= 1

                if depth == 0:
                    return index

    return None

def extract_params(tokens, open_index):
    close_index = matching_close_paren(tokens, open_index)

    if close_index is None:
        return [], None

    segments = []
    segment = []
    depth = 0

    for index in range(open_index + 1, close_index):
        tok = tokens[index]

        if tok.type == token.OP and tok.string in "([{":
            depth += 1
        elif tok.type == token.OP and tok.string in ")]}":
            depth -= 1

        if depth == 0 and tok.type == token.OP and tok.string == ",":
            segments.append(segment)
            segment = []
            continue

        segment.append(tok)

    if segment:
        segments.append(segment)

    params = []
    first_arg = None

    for seg in segments:
        head = []
        seg_depth = 0

        for tok in seg:
            if tok.type == token.OP and tok.string in "([{":
                seg_depth += 1
            elif tok.type == token.OP and tok.string in ")]}":
                seg_depth -= 1

            if seg_depth == 0 and tok.type == token.OP and tok.string == "=":
                break

            head.append(tok)

        name_tok = None

        for tok in head:
            if tok.type == token.NAME and not keyword.iskeyword(tok.string):
                name_tok = tok

        if name_tok is not None:
            params.append(name_tok.string)

            if first_arg is None:
                first_arg = name_tok.string

    return params, first_arg

CYTHON_KEYWORDS = {
    "cdef", "cpdef", "cimport", "ctypedef", "cppclass", "nogil", "gil",
    "include", "DEF", "IF", "ELIF", "ELSE", "api", "public", "readonly",
    "inline", "extern", "namespace", "struct", "union", "enum", "packed",
    "fused", "by", "new",
}

def scan_scope(tokens, body_start, body_end):
    # Conservative token-level evidence: dotted name chains immediately followed
    # by "(" are calls; bare single names in use position are reference
    # candidates; assignment/loop/with targets are local bindings. Resolution
    # gating (exact same-file or imported symbol) happens on the host side, so
    # over-collecting candidates here is safe.
    calls = []
    name_uses = []
    bindings = set()
    index = body_start

    while index < body_end:
        tok = tokens[index]

        if tok.type != token.NAME:
            index += 1
            continue

        prev = previous_significant(tokens, body_start, index - 1)

        if prev is not None and prev.type == token.OP and prev.string == ".":
            index += 1
            continue

        if keyword.iskeyword(tok.string) or tok.string in CYTHON_KEYWORDS:
            index += 1
            continue

        chain = [tok.string]
        j = index + 1

        while j + 1 < body_end and tokens[j].type == token.OP and tokens[j].string == "." and tokens[j + 1].type == token.NAME:
            chain.append(tokens[j + 1].string)
            j += 2

        nxt = tokens[j] if j < body_end else None

        if nxt is not None and nxt.type == token.OP and nxt.string == "(":
            if prev is not None and prev.type == token.NAME and prev.string in {"def", "cdef", "cpdef", "class"}:
                index = j + 1
                continue

            calls.append({"target": ".".join(chain), "line": tok.start[0]})
            index = j + 1
            continue

        if len(chain) == 1:
            is_assignment = (
                nxt is not None
                and nxt.type == token.OP
                and nxt.string == "="
                and not (j + 1 < body_end and tokens[j + 1].type == token.OP and tokens[j + 1].string == "=")
            )

            if is_assignment:
                bindings.add(chain[0])
            elif prev is not None and prev.type == token.NAME and prev.string in {"as", "for"}:
                bindings.add(chain[0])
            else:
                name_uses.append({"target": chain[0], "line": tok.start[0]})

        index = j

    return calls, name_uses, sorted(bindings)

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

def parse_def_header(tokens, start_index):
    keyword_tok = tokens[start_index]
    header_end_index, signature_end_token = statement_end(tokens, start_index)
    open_paren_index = find_open_paren(tokens, start_index, header_end_index)

    if open_paren_index is None:
        return None

    # A top-level "=" before the first parenthesis means the parenthesis belongs
    # to an initializer expression (e.g. "cdef VF2 vf2 = VF2()"), so this is a
    # typed variable declaration rather than a function definition. find_open_paren
    # returns the first unnested "(", so any "=" before it is at depth zero.
    for scan_index in range(start_index + 1, open_paren_index):
        scan_tok = tokens[scan_index]

        if scan_tok.type == token.OP and scan_tok.string == "=":
            return None

    name_token = previous_significant(tokens, start_index + 1, open_paren_index - 1)
    first_parameter_token = next_significant(tokens, open_paren_index + 1)

    if name_token is None or name_token.type != token.NAME:
        return None

    if name_token.string in {"class", "enum", "extern", "from", "struct", "union"}:
        return None

    if first_parameter_token is not None and first_parameter_token.string in {"*", "&"}:
        return None

    block = block_range(tokens, header_end_index, signature_end_token)
    block_end_tok = None

    if block is not None:
        block_end_tok = previous_significant(tokens, block[0], block[1] - 1)

    if block_end_tok is None:
        block_end_tok = signature_end_token

    start_byte = absolute_byte(keyword_tok.start)
    signature_end_byte = absolute_byte(signature_end_token.end)
    end_byte = absolute_byte(block_end_tok.end)
    signature = source.encode("utf-8")[start_byte:signature_end_byte].decode("utf-8").strip()

    if not signature:
        return None

    params, first_arg = extract_params(tokens, open_paren_index)
    calls = []
    name_uses = []
    bindings = sorted(set(params))

    if block is not None:
        calls, name_uses, body_bindings = scan_scope(tokens, block[0], block[1])
        bindings = sorted(set(params) | set(body_bindings))

    return {
        "name": name_token.string,
        "signature": signature,
        "startLine": keyword_tok.start[0],
        "endLine": block_end_tok.end[0],
        "startByte": start_byte,
        "endByte": end_byte,
        "calls": calls,
        "references": name_uses,
        "localBindings": bindings,
        "firstArg": first_arg,
        "headerEndIndex": header_end_index,
        "block": block,
    }

MEMBER_KEYS = (
    "name", "signature", "startLine", "endLine", "startByte", "endByte",
    "calls", "references", "localBindings", "firstArg",
)

def parse_function(tokens, start_index):
    header = parse_def_header(tokens, start_index)

    if header is None:
        return None, statement_end(tokens, start_index)[0] + 1

    item = {key: header[key] for key in MEMBER_KEYS}
    item["kind"] = "function"
    return item, header["headerEndIndex"] + 1

def read_class_bases(tokens, open_index):
    close_index = matching_close_paren(tokens, open_index)

    if close_index is None:
        return []

    bases = []
    index = open_index + 1

    while index < close_index:
        tok = tokens[index]

        if tok.type != token.NAME or keyword.iskeyword(tok.string):
            index += 1
            continue

        nxt = tokens[index + 1] if index + 1 < close_index else None

        if nxt is not None and nxt.type == token.OP and nxt.string == "=":
            index += 2
            continue

        name, next_index = read_dotted_name(tokens, index)

        if name is not None:
            bases.append({"target": name, "line": tok.start[0]})
            index = next_index
        else:
            index += 1

    return bases

def parse_class(tokens, start_index, keyword_start_index):
    header_end_index, signature_end_token = statement_end(tokens, keyword_start_index)
    name_token = next_significant(tokens, keyword_start_index + 1)

    if name_token is None or name_token.type != token.NAME or keyword.iskeyword(name_token.string):
        return None, header_end_index + 1

    bases = []
    open_paren_index = find_open_paren(tokens, keyword_start_index, header_end_index)

    if open_paren_index is not None:
        bases = read_class_bases(tokens, open_paren_index)

    block = block_range(tokens, header_end_index, signature_end_token)
    block_end_tok = None

    if block is not None:
        block_end_tok = previous_significant(tokens, block[0], block[1] - 1)

    if block_end_tok is None:
        block_end_tok = signature_end_token

    start_byte = absolute_byte(tokens[start_index].start)
    signature_end_byte = absolute_byte(signature_end_token.end)
    end_byte = absolute_byte(block_end_tok.end)
    signature = source.encode("utf-8")[start_byte:signature_end_byte].decode("utf-8").strip()

    if not signature:
        return None, header_end_index + 1

    members = []

    if block is not None:
        body_start, body_end = block
        depth = 0
        idx = body_start
        at_stmt = True

        while idx < body_end:
            member_tok = tokens[idx]

            if member_tok.type == token.INDENT:
                depth += 1
                at_stmt = True
                idx += 1
                continue

            if member_tok.type == token.DEDENT:
                depth -= 1
                at_stmt = True
                idx += 1
                continue

            if member_tok.type == tokenize.NL or member_tok.type == token.NEWLINE:
                at_stmt = True
                idx += 1
                continue

            if member_tok.type == tokenize.COMMENT:
                idx += 1
                continue

            if depth == 0 and at_stmt and member_tok.type == token.NAME and member_tok.string in {"def", "cdef", "cpdef"}:
                header = parse_def_header(tokens, idx)

                if header is not None:
                    member = {key: header[key] for key in MEMBER_KEYS}
                    member["kind"] = "method"
                    members.append(member)

                    if header["block"] is not None:
                        idx = header["block"][1] + 1
                    else:
                        idx = statement_end(tokens, idx)[0] + 1

                    at_stmt = True
                    continue

                idx = statement_end(tokens, idx)[0] + 1
                at_stmt = True
                continue

            at_stmt = False
            idx += 1

    item = {
        "kind": "class",
        "name": name_token.string,
        "signature": signature,
        "startLine": tokens[start_index].start[0],
        "endLine": block_end_tok.end[0],
        "startByte": start_byte,
        "endByte": end_byte,
        "bases": bases,
        "members": members,
    }
    return item, header_end_index + 1

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
        if tok.string == "class":
            item, next_index = parse_class(tokens, index, index)

            if item is not None:
                items.append(item)

            index = next_index
            at_statement_start = True
            continue

        if tok.string in {"cdef", "cpdef"}:
            following = next_significant(tokens, index + 1)

            if following is not None and following.type == token.NAME and following.string == "class":
                class_keyword_index = None

                for lookahead in range(index + 1, len(tokens)):
                    if tokens[lookahead].type == token.NAME and tokens[lookahead].string == "class":
                        class_keyword_index = lookahead
                        break

                if class_keyword_index is not None:
                    item, next_index = parse_class(tokens, index, class_keyword_index)

                    if item is not None:
                        items.append(item)

                    index = next_index
                    at_statement_start = True
                    continue

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
  const { symbols, containsEdges } = buildCythonSymbols(input.path, payload.items);
  const importEdges = extractImportEdges({
    filePath: input.path,
    imports: payload.imports,
    sourceSymbols: symbols,
    context: resolutionContext,
  });
  const callReferenceEdges = extractCythonCallAndReferenceEdges({
    filePath: input.path,
    items: payload.items,
    imports: payload.imports,
    symbols,
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
    edges: [...containsEdges, ...importEdges, ...callReferenceEdges],
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

interface CythonSymbolBuild {
  symbols: SymbolRecord[];
  containsEdges: EdgeRecord[];
}

function buildCythonSymbols(
  filePath: string,
  items: readonly CythonItem[],
): CythonSymbolBuild {
  const symbols: SymbolRecord[] = [];
  const containsEdges: EdgeRecord[] = [];

  for (const item of items) {
    if (item.kind === "class") {
      const classSymbol = makeCythonSymbol({
        filePath,
        localName: item.name,
        kind: SymbolKind.Class,
        signature: item.signature,
        startLine: item.startLine,
        endLine: item.endLine,
        startByte: item.startByte,
        endByte: item.endByte,
        symbolPath: [item.name],
      });
      symbols.push(classSymbol);

      for (const member of item.members) {
        const methodSymbol = makeCythonSymbol({
          filePath,
          localName: member.name,
          kind: SymbolKind.Method,
          signature: member.signature,
          startLine: member.startLine,
          endLine: member.endLine,
          startByte: member.startByte,
          endByte: member.endByte,
          symbolPath: [item.name, member.name],
          parentSymbolId: classSymbol.id,
        });
        symbols.push(methodSymbol);
        containsEdges.push(makeContainsEdge(classSymbol.id, methodSymbol.id));
      }

      continue;
    }

    symbols.push(
      makeCythonSymbol({
        filePath,
        localName: item.name,
        kind: SymbolKind.Function,
        signature: item.signature,
        startLine: item.startLine,
        endLine: item.endLine,
        startByte: item.startByte,
        endByte: item.endByte,
        symbolPath: [item.name],
      }),
    );
  }

  return { symbols, containsEdges };
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
    return buildCythonSymbols(
      filePath,
      parseCythonItems(filePath, content, context).items,
    ).symbols.filter((symbol) => symbol.parentSymbolId === undefined);
  }

  return [];
}

interface MakeCythonSymbolInput {
  filePath: string;
  localName: string;
  kind: SymbolKind;
  signature: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  symbolPath: readonly string[];
  parentSymbolId?: string;
}

function makeCythonSymbol(input: MakeCythonSymbolInput): SymbolRecord {
  const fqName = buildFQName({
    filePath: input.filePath,
    symbolPath: input.symbolPath,
  });

  return {
    id: computeSymbolId({
      filePath: input.filePath,
      fqName,
      kind: input.kind,
      startByte: input.startByte,
      endByte: input.endByte,
    }),
    filePath: input.filePath,
    fqName,
    localName: input.localName,
    kind: input.kind,
    signature: input.signature,
    startLine: input.startLine,
    endLine: input.endLine,
    startByte: input.startByte,
    endByte: input.endByte,
    parentSymbolId: input.parentSymbolId,
    exported: false,
  };
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

interface ExtractCythonCallReferenceInput {
  filePath: string;
  items: readonly CythonItem[];
  imports: readonly CythonImport[];
  symbols: readonly SymbolRecord[];
  context: CythonParserContext;
}

// Conservative static resolution surface for Cython calls and references. All
// lookups are exact: same-file top-level symbols, same-class methods (via the
// enclosing method's first parameter, e.g. `self`), exactly resolved
// from-import/cimport/include names, and module-qualified members on an
// aliased/single-segment module import. Ambiguous receivers and dynamic
// dispatch are skipped rather than guessed.
interface CythonResolution {
  topLevelByName: ReadonlyMap<string, SymbolRecord>;
  ambiguousNames: ReadonlySet<string>;
  classMembersByClassName: ReadonlyMap<string, ReadonlyMap<string, SymbolRecord>>;
  fromImportsByName: ReadonlyMap<string, SymbolRecord>;
  moduleExportsByLocalName: ReadonlyMap<string, CythonExportIndex>;
}

interface CythonReferencePair {
  src: string;
  dst: string;
}

/**
 * Conservative static extraction of Cython `calls` and `references` edges.
 *
 * Calls are emitted only when the dotted target resolves exactly: a same-file
 * top-level function/class, a `self.method()`-style call whose receiver is the
 * enclosing method's first parameter, a `ClassName.method()` on a same-file
 * class, an exactly resolved imported/cimported/included callable, or a
 * `module.member()` on an aliased/single-segment module import. References cover
 * exact inheritance bases and bare-name uses (e.g. Cython type names) that
 * resolve to a known same-file or imported symbol. `calls` and `references` are
 * kept distinct, and ambiguous receivers are skipped rather than guessed.
 */
function extractCythonCallAndReferenceEdges(
  input: ExtractCythonCallReferenceInput,
): EdgeRecord[] {
  const resolution = buildCythonResolution(input);
  const symbolByStartByte = new Map<number, SymbolRecord>();

  for (const symbol of input.symbols) {
    symbolByStartByte.set(symbol.startByte, symbol);
  }

  const callEdges = new Map<string, EdgeRecord>();
  const referencePairs: CythonReferencePair[] = [];

  for (const item of input.items) {
    if (item.kind === "class") {
      const classSymbol = symbolByStartByte.get(item.startByte);

      if (classSymbol !== undefined) {
        for (const base of item.bases) {
          const target = resolveCythonReferenceTarget(base.target, EMPTY_BINDINGS, resolution);

          if (target !== undefined && target.id !== classSymbol.id) {
            referencePairs.push({ src: classSymbol.id, dst: target.id });
          }
        }
      }

      for (const member of item.members) {
        const methodSymbol = symbolByStartByte.get(member.startByte);

        if (methodSymbol === undefined) {
          continue;
        }

        emitCythonScopeEdges(
          member,
          methodSymbol,
          item.name,
          member.firstArg,
          resolution,
          callEdges,
          referencePairs,
        );
      }

      continue;
    }

    const source = symbolByStartByte.get(item.startByte);

    if (source === undefined) {
      continue;
    }

    emitCythonScopeEdges(item, source, null, null, resolution, callEdges, referencePairs);
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

const EMPTY_BINDINGS: ReadonlySet<string> = new Set();

function emitCythonScopeEdges(
  scope: CythonScopeEvidence,
  source: SymbolRecord,
  enclosingClassName: string | null,
  firstArg: string | null,
  resolution: CythonResolution,
  callEdges: Map<string, EdgeRecord>,
  referencePairs: CythonReferencePair[],
): void {
  const localBindings = new Set(scope.localBindings);

  for (const call of scope.calls) {
    const target = resolveCythonCallTarget(
      call.target,
      enclosingClassName,
      firstArg,
      localBindings,
      resolution,
    );

    if (target !== undefined && target.id !== source.id) {
      const edge = makeCallsEdge(source.id, target.id);
      // The Cython scanner establishes the line but not the column, so the
      // occurrence is recorded at `line` precision rather than claiming a span.
      callEdges.set(edge.id, withCallSite(callEdges.get(edge.id) ?? edge, {
        startLine: call.line,
        startColumn: 0,
        endLine: call.line,
        endColumn: 0,
        precision: "line",
      }));
    }
  }

  for (const reference of scope.references) {
    const target = resolveCythonReferenceTarget(reference.target, localBindings, resolution);

    if (target !== undefined && target.id !== source.id) {
      referencePairs.push({ src: source.id, dst: target.id });
    }
  }
}

function buildCythonResolution(input: ExtractCythonCallReferenceInput): CythonResolution {
  const topLevelByName = new Map<string, SymbolRecord>();
  const ambiguousNames = new Set<string>();

  for (const symbol of input.symbols) {
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

  for (const symbol of input.symbols) {
    if (
      symbol.parentSymbolId !== undefined
      || symbol.kind !== SymbolKind.Class
      || ambiguousNames.has(symbol.localName)
    ) {
      continue;
    }

    const members = new Map<string, SymbolRecord>();

    for (const member of input.symbols) {
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

  const { fromImportsByName, moduleExportsByLocalName } = buildCythonImportResolution(
    input.filePath,
    input.imports,
    input.context,
  );

  return {
    topLevelByName,
    ambiguousNames,
    classMembersByClassName,
    fromImportsByName,
    moduleExportsByLocalName,
  };
}

function buildCythonImportResolution(
  filePath: string,
  imports: readonly CythonImport[],
  context: CythonParserContext,
): {
  fromImportsByName: Map<string, SymbolRecord>;
  moduleExportsByLocalName: Map<string, CythonExportIndex>;
} {
  const fromImportsByName = new Map<string, SymbolRecord>();
  const moduleExportsByLocalName = new Map<string, CythonExportIndex>();
  const ambiguousNames = new Set<string>();
  const exportIndexByPath = new Map<string, CythonExportIndex>();

  const recordFromImport = (localName: string, symbol: SymbolRecord): void => {
    const existing = fromImportsByName.get(localName);

    if (existing !== undefined) {
      if (existing.id !== symbol.id) {
        ambiguousNames.add(localName);
      }

      return;
    }

    fromImportsByName.set(localName, symbol);
  };

  for (const imported of imports) {
    const targetPath = resolveImportedTargetPath(filePath, imported, context);

    if (targetPath === undefined) {
      continue;
    }

    const targetContent = context.knownFilesByPath.get(targetPath);

    if (targetContent === undefined) {
      continue;
    }

    const exportIndex = getCythonExportIndex(targetPath, targetContent, context, exportIndexByPath);

    if (imported.kind === "import_module" || imported.kind === "cimport_module") {
      const boundName = imported.asName ?? singleSegmentModuleName(imported.module);

      if (boundName !== undefined && !moduleExportsByLocalName.has(boundName)) {
        moduleExportsByLocalName.set(boundName, exportIndex);
      }

      continue;
    }

    if (imported.kind === "include_file") {
      // `include` textually splices the file, so its names are directly usable.
      for (const [name, symbol] of exportIndex.namedSymbols) {
        recordFromImport(name, symbol);
      }

      continue;
    }

    if (imported.importedName === "*") {
      continue;
    }

    const target = exportIndex.namedSymbols.get(imported.importedName);

    if (target === undefined) {
      continue;
    }

    recordFromImport(imported.asName ?? imported.importedName, target);
  }

  for (const name of ambiguousNames) {
    fromImportsByName.delete(name);
  }

  return { fromImportsByName, moduleExportsByLocalName };
}

function singleSegmentModuleName(module: string): string | undefined {
  return module.includes(".") ? undefined : module;
}

function resolveCythonCallTarget(
  target: string,
  enclosingClassName: string | null,
  firstArg: string | null,
  localBindings: ReadonlySet<string>,
  resolution: CythonResolution,
): SymbolRecord | undefined {
  const segments = target.split(".");

  if (segments.length === 1) {
    const name = segments[0] as string;

    if (localBindings.has(name)) {
      return undefined;
    }

    const local = resolveUnambiguousTopLevel(name, resolution);

    if (local !== undefined && isCythonCallableKind(local.kind)) {
      return local;
    }

    const imported = resolution.fromImportsByName.get(name);

    if (imported !== undefined && isCythonCallableKind(imported.kind)) {
      return imported;
    }

    return undefined;
  }

  if (segments.length === 2) {
    const [receiver, member] = segments as [string, string];

    if (enclosingClassName !== null && firstArg !== null && receiver === firstArg) {
      return resolution.classMembersByClassName.get(enclosingClassName)?.get(member);
    }

    if (localBindings.has(receiver)) {
      return undefined;
    }

    const receiverClass = resolveUnambiguousTopLevel(receiver, resolution);

    if (receiverClass !== undefined && receiverClass.kind === SymbolKind.Class) {
      return resolution.classMembersByClassName.get(receiver)?.get(member);
    }

    const moduleIndex = resolution.moduleExportsByLocalName.get(receiver);

    if (moduleIndex !== undefined) {
      const exported = moduleIndex.namedSymbols.get(member);

      if (exported !== undefined && isCythonCallableKind(exported.kind)) {
        return exported;
      }
    }

    return undefined;
  }

  return undefined;
}

function resolveCythonReferenceTarget(
  target: string,
  localBindings: ReadonlySet<string>,
  resolution: CythonResolution,
): SymbolRecord | undefined {
  const segments = target.split(".");

  if (segments.length === 1) {
    const name = segments[0] as string;

    if (localBindings.has(name)) {
      return undefined;
    }

    const local = resolveUnambiguousTopLevel(name, resolution);

    if (local !== undefined) {
      return local;
    }

    return resolution.fromImportsByName.get(name);
  }

  if (segments.length === 2) {
    const [receiver, member] = segments as [string, string];

    if (localBindings.has(receiver)) {
      return undefined;
    }

    const moduleIndex = resolution.moduleExportsByLocalName.get(receiver);

    if (moduleIndex !== undefined) {
      const exported = moduleIndex.namedSymbols.get(member);

      if (exported !== undefined) {
        return exported;
      }
    }

    const receiverClass = resolveUnambiguousTopLevel(receiver, resolution);

    if (receiverClass !== undefined && receiverClass.kind === SymbolKind.Class) {
      return resolution.classMembersByClassName.get(receiver)?.get(member);
    }

    return undefined;
  }

  return undefined;
}

function resolveUnambiguousTopLevel(
  name: string,
  resolution: CythonResolution,
): SymbolRecord | undefined {
  if (resolution.ambiguousNames.has(name)) {
    return undefined;
  }

  return resolution.topLevelByName.get(name);
}

function isCythonCallableKind(kind: SymbolKind): boolean {
  return (
    kind === SymbolKind.Function
    || kind === SymbolKind.Class
    || kind === SymbolKind.Method
  );
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
