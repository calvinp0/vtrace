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
import { detectLanguage } from "../fs/languageDetection";
import { getCythonExportIndex, type CrossLanguageExportIndex } from "./cythonExports";
import { withCallSite } from "./edgeCallSites";
import { ParserError } from "./errors";
import { makeModuleSymbolRecord } from "./moduleSymbol";
import type { LanguageParser } from "./LanguageParser";
import type { ParseFileInput } from "./types";

interface ExtractedSymbols {
  symbols: SymbolRecord[];
  edges: EdgeRecord[];
}

interface PythonParserContext {
  interpreterCandidates: readonly string[];
  knownFilesByPath: ReadonlyMap<string, string>;
  moduleNameByFilePath: ReadonlyMap<string, string>;
  modulePathsByName: ReadonlyMap<string, readonly string[]>;
  /**
   * Parser-instance-wide cache of Cython module export indexes, keyed by file
   * path. Cython export extraction spawns a subprocess, so this avoids
   * re-extracting the same Cython module for every Python file that imports it.
   * Shared by reference across `withKnownFile` copies.
   */
  cythonExportIndexCache: Map<string, CrossLanguageExportIndex>;
  /**
   * Parser-instance-wide cache of Python module export indexes, keyed by
   * `path\0content`. Building an export index spawns a CPython `ast` subprocess
   * and walks the module, so without this every source file re-parses each of
   * its imported targets — three times over (import/call/reference passes) — with
   * no cross-file reuse, making a whole-repo index effectively O(n²) in spawns.
   * Keying by content (not just path) keeps it behaviour-identical to the
   * un-cached path when `withKnownFile` overrides a file's content. Shared by
   * reference across `withKnownFile` copies.
   */
  pythonExportIndexCache: Map<string, PythonExportIndex>;
  /**
   * Raw AST JSON by `normalizedPath\0content`, and the state that decides when
   * to fill it in bulk.
   *
   * The STDOUT TEXT is retained rather than the parsed object: ARC's 276 files
   * carry ~17 MB of JSON, whose parsed form is several times that, and each
   * entry is deserialised once on the way out and then collected.
   *
   * A CPython interpreter costs ~36 ms to START and ~23 ms to run this parser's
   * AST script over a typical source file, so a cold whole-repository index
   * spends MORE THAN HALF its Python parse budget launching interpreters:
   * measured on ARC, 276 files at 64.5 ms each against 23.3 ms each when one
   * interpreter is handed all of them. Shared by reference across
   * `withKnownFile` copies.
   */
  pythonAstCache: Map<string, string>;
  pythonAstBatch: PythonAstBatchState;
}

interface PythonAstBatchState {
  /** Single-file spawns so far. A run proves itself bulk by exceeding the threshold. */
  spawns: number;
  /** Known Python paths not yet handed to a batch; null until first use, empty once warmed. */
  pending: string[] | null;
  /** Set once a warm has been attempted and found not worth repeating. */
  exhausted: boolean;
}

interface PythonAstRoot {
  items: PythonAstItem[];
  imports: PythonAstImport[];
}

type PythonAstItem = PythonAstFunction | PythonAstClass | PythonAstModuleAssignment;
type PythonAstImport = PythonModuleImport | PythonFromImport;

type PythonModuleAssignmentKind = "module_constant" | "module_variable" | "module_alias";

interface PythonAstModuleAssignment extends PythonAstSpan {
  kind: "module_assignment";
  name: string;
  assignmentKind: PythonModuleAssignmentKind;
  hasAnnotation: boolean;
  references: PythonAstReference[];
}

interface PythonAstSpan {
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  bodyStartByte: number;
}

interface PythonAstMetadata {
  docstring?: string;
  decorators?: string[];
}

interface PythonAstCall {
  target: string;
  line: number;
  /** 0-based column offsets straight from the CPython AST. */
  col?: number;
  endLine?: number;
  endCol?: number;
}

type PythonReferenceKind =
  | "decorator"
  | "inheritance"
  | "annotation"
  | "exception"
  | "alias"
  | "name_use";

interface PythonAstReference {
  target: string;
  line: number;
  kind: PythonReferenceKind;
}

interface PythonAstFunction extends PythonAstSpan, PythonAstMetadata {
  kind: "function" | "async_function";
  name: string;
  calls: PythonAstCall[];
  references: PythonAstReference[];
  localBindings: string[];
}

interface PythonAstMethod extends PythonAstSpan, PythonAstMetadata {
  kind: "method" | "async_method";
  name: string;
  calls: PythonAstCall[];
  references: PythonAstReference[];
  localBindings: string[];
  firstArg?: string;
}

interface PythonAstClassAttribute extends PythonAstSpan {
  kind: "class_attribute";
  name: string;
  assignmentKind: PythonModuleAssignmentKind;
  hasAnnotation: boolean;
  references: PythonAstReference[];
}

type PythonAstClassMember = PythonAstMethod | PythonAstClassAttribute;

interface PythonAstClass extends PythonAstSpan, PythonAstMetadata {
  kind: "class";
  name: string;
  members: PythonAstClassMember[];
  references: PythonAstReference[];
  bases: string[];
}

interface PythonModuleImport {
  kind: "import_module";
  module: string;
  asName?: string;
}

interface PythonFromImport {
  kind: "from_import";
  module?: string;
  level: number;
  importedName: string;
  asName?: string;
}

interface CreateSymbolInput extends PythonAstSpan {
  filePath: string;
  content: string;
  localName: string;
  kind: SymbolKind;
  symbolPath?: readonly string[];
  parentSymbolId?: string;
  docstring?: string;
  decorators?: readonly string[];
}

export interface PythonKnownFile {
  path: string;
  content: string;
}

export interface PythonParserOptions {
  interpreterCandidates?: readonly string[];
  knownFiles?: readonly PythonKnownFile[];
}

const DEFAULT_INTERPRETER_CANDIDATES = ["python3", "python"] as const;

/**
 * How many single-file spawns to allow before switching a run to batch mode, and
 * how many files one batch carries.
 *
 * The threshold exists because the two callers want opposite things: an
 * incremental refresh parses one or two files and must not pay to warm a whole
 * repository, while a cold index parses hundreds and must not pay per-file
 * interpreter startup. Spawning singly until a run has proved itself bulk serves
 * both without the parser having to be told which it is.
 *
 * The chunk bounds peak memory: ARC's 276 files carry ~17 MB of AST JSON in
 * total, so a chunk holds a fraction of that and is replaced, not accumulated.
 */
const PYTHON_AST_BATCH_WARM_THRESHOLD = 4;
const PYTHON_AST_BATCH_SIZE = 48;

/**
 * Source bytes above which a run keeps spawning per file. The warm holds one
 * JSON string per module for the rest of the run, so it trades memory for
 * interpreter startups; past this size that trade stops being obviously right
 * and the un-batched path — which is what shipped before — is used instead.
 */
const PYTHON_AST_BATCH_MAX_SOURCE_BYTES = 64 * 1024 * 1024;

/**
 * Runs the SAME `PYTHON_AST_SCRIPT` once per file inside one interpreter, with
 * the script supplied through stdin rather than embedded, so nothing has to be
 * escaped into a Python literal.
 *
 * Each file gets the script's expected environment exactly — its source on
 * stdin, its path as `argv[1]`, `__name__` of `"__main__"` — and a fresh globals
 * mapping, so no module-level state leaks between files. Output was verified
 * byte-identical to per-file spawns across 60 ARC files before this path shipped.
 * A file that raises is reported as a failure and is NOT cached, so it falls back
 * to its own spawn and reproduces the original error verbatim.
 */
const PYTHON_AST_BATCH_DRIVER = `
import io
import json
import sys

request = json.loads(sys.stdin.read())
code = compile(request["script"], "<vtrace-python-ast>", "exec")
emit = sys.stdout
results = []

for item in request["files"]:
    saved = (sys.stdin, sys.stdout, sys.argv)
    sys.stdin = io.StringIO(item["source"])
    sys.stdout = io.StringIO()
    sys.argv = ["-c", item["path"]]
    try:
        exec(code, {"__name__": "__main__"})
        results.append({"path": item["path"], "ok": True, "stdout": sys.stdout.getvalue()})
    except BaseException as error:
        results.append({"path": item["path"], "ok": False, "error": str(error)})
    finally:
        sys.stdin, sys.stdout, sys.argv = saved

emit.write(json.dumps(results))
`.trim();

const PYTHON_AST_SCRIPT = `
import ast
import json
import sys

source = sys.stdin.read()
file_path = sys.argv[1]

line_start_bytes = [0]
offset = 0

for line in source.splitlines(keepends=True):
    offset += len(line.encode("utf-8"))
    line_start_bytes.append(offset)

def absolute_byte(lineno, col_offset):
    return line_start_bytes[lineno - 1] + col_offset

def span_for(node):
    first_body = node.body[0] if getattr(node, "body", None) else node
    return {
        "startLine": node.lineno,
        "endLine": getattr(node, "end_lineno", node.lineno),
        "startByte": absolute_byte(node.lineno, node.col_offset),
        "endByte": absolute_byte(
            getattr(node, "end_lineno", node.lineno),
            getattr(node, "end_col_offset", node.col_offset),
        ),
        "bodyStartByte": absolute_byte(first_body.lineno, first_body.col_offset),
    }

def call_target_text(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = call_target_text(node.value)
        if parent is not None:
            return f"{parent}.{node.attr}"
        # Conservative super() receiver recognition: super().attr becomes the
        # sentinel "super().attr". The "()" can never appear in a real Python
        # identifier, so the prefix cannot collide downstream.
        if (
            isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name)
            and node.value.func.id == "super"
        ):
            return f"super().{node.attr}"
        return None
    return None

def collect_calls(node):
    calls = []
    seen = set()
    body = getattr(node, "body", None) or []

    for child in body:
        for descendant in ast.walk(child):
            if isinstance(descendant, ast.Call):
                text = call_target_text(descendant.func)
                if text is None:
                    continue
                line = getattr(descendant, "lineno", 0) or 0
                col = getattr(descendant, "col_offset", 0) or 0
                end_line = getattr(descendant, "end_lineno", None) or line
                end_col = getattr(descendant, "end_col_offset", None)
                if end_col is None:
                    end_col = col
                key = (text, line, col)
                if key in seen:
                    continue
                seen.add(key)
                calls.append({
                    "target": text,
                    "line": line,
                    "col": col,
                    "endLine": end_line,
                    "endCol": end_col,
                })

    return calls

def collect_references(node, is_class):
    refs = []
    seen = set()

    def add(target_node, line, kind):
        if target_node is None:
            return
        text = call_target_text(target_node)
        if text is None:
            return
        key = (text, line, kind)
        if key in seen:
            return
        seen.add(key)
        refs.append({"target": text, "line": line, "kind": kind})

    for deco in getattr(node, "decorator_list", []):
        callee = deco.func if isinstance(deco, ast.Call) else deco
        add(callee, getattr(deco, "lineno", 0) or 0, "decorator")

    if is_class:
        for base in getattr(node, "bases", []):
            add(base, getattr(base, "lineno", 0) or 0, "inheritance")
    else:
        args = getattr(node, "args", None)
        if args is not None:
            arg_groups = list(getattr(args, "posonlyargs", []) or [])
            arg_groups += list(getattr(args, "args", []) or [])
            arg_groups += list(getattr(args, "kwonlyargs", []) or [])
            for arg in arg_groups:
                if getattr(arg, "annotation", None) is not None:
                    add(arg.annotation, getattr(arg.annotation, "lineno", 0) or 0, "annotation")
            for opt in (getattr(args, "vararg", None), getattr(args, "kwarg", None)):
                if opt is not None and getattr(opt, "annotation", None) is not None:
                    add(opt.annotation, getattr(opt.annotation, "lineno", 0) or 0, "annotation")
        returns = getattr(node, "returns", None)
        if returns is not None:
            add(returns, getattr(returns, "lineno", 0) or 0, "annotation")

    body = getattr(node, "body", None) or []

    # For class bodies, skip nested function/method bodies — those emit their own references.
    def descend(child):
        stack = [child]
        while stack:
            current = stack.pop()
            yield current
            if is_class and isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            for grandchild in ast.iter_child_nodes(current):
                stack.append(grandchild)

    excluded_ids = set()

    for child in body:
        for descendant in descend(child):
            if isinstance(descendant, ast.Call):
                excluded_ids.add(id(descendant.func))

    for child in body:
        for descendant in descend(child):
            if isinstance(descendant, ast.Raise):
                if descendant.exc is None:
                    continue
                exc_node = descendant.exc
                if isinstance(exc_node, ast.Call):
                    exc_node = exc_node.func
                add(exc_node, getattr(descendant, "lineno", 0) or 0, "exception")
            elif isinstance(descendant, ast.ExceptHandler):
                if descendant.type is None:
                    continue
                exc_types = (
                    list(descendant.type.elts)
                    if isinstance(descendant.type, ast.Tuple)
                    else [descendant.type]
                )
                for exc_type in exc_types:
                    add(exc_type, getattr(exc_type, "lineno", 0) or 0, "exception")
                    excluded_ids.add(id(exc_type))
            elif isinstance(descendant, ast.AnnAssign):
                if descendant.annotation is not None:
                    add(descendant.annotation, getattr(descendant.annotation, "lineno", 0) or 0, "annotation")
                    excluded_ids.add(id(descendant.annotation))
            elif isinstance(descendant, ast.Assign):
                if isinstance(descendant.value, (ast.Name, ast.Attribute)):
                    add(descendant.value, getattr(descendant.value, "lineno", 0) or 0, "alias")
                    excluded_ids.add(id(descendant.value))

    # Generic name-use sweep: outermost Name/Attribute in Load that is not already covered
    # and is not the callee of a Call. Conservative resolution downstream filters noise.
    def walk_roots(current):
        if id(current) in excluded_ids:
            if is_class and isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                return
            for grandchild in ast.iter_child_nodes(current):
                walk_roots(grandchild)
            return
        if isinstance(current, (ast.Name, ast.Attribute)):
            ctx = getattr(current, "ctx", None)
            if isinstance(ctx, ast.Load):
                add(current, getattr(current, "lineno", 0) or 0, "name_use")
                return
        if is_class and isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            return
        for grandchild in ast.iter_child_nodes(current):
            walk_roots(grandchild)

    for child in body:
        walk_roots(child)

    return refs

def first_arg_name(node):
    args = getattr(node, "args", None)
    if args is None:
        return None
    positional = list(getattr(args, "posonlyargs", []) or []) + list(getattr(args, "args", []) or [])
    if not positional:
        return None
    return positional[0].arg

def collect_local_bindings(node):
    # Function-local names make plain name-use references ambiguous for our
    # static graph. Capture arguments and simple assignment targets so the
    # TypeScript resolver can skip those references conservatively.
    bindings = set()
    args = getattr(node, "args", None)

    if args is not None:
        arg_groups = list(getattr(args, "posonlyargs", []) or [])
        arg_groups += list(getattr(args, "args", []) or [])
        arg_groups += list(getattr(args, "kwonlyargs", []) or [])
        for arg in arg_groups:
            bindings.add(arg.arg)
        for opt in (getattr(args, "vararg", None), getattr(args, "kwarg", None)):
            if opt is not None:
                bindings.add(opt.arg)

    def add_target(target):
        if isinstance(target, ast.Name):
            bindings.add(target.id)
            return
        if isinstance(target, (ast.Tuple, ast.List)):
            for elt in target.elts:
                add_target(elt)

    def descend_binding_nodes(child):
        stack = [child]
        while stack:
            current = stack.pop()
            yield current
            if current is not child and isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                continue
            for grandchild in ast.iter_child_nodes(current):
                stack.append(grandchild)

    for child in getattr(node, "body", []) or []:
        for descendant in descend_binding_nodes(child):
            if isinstance(descendant, ast.Assign):
                for target in descendant.targets:
                    add_target(target)
            elif isinstance(descendant, ast.AnnAssign):
                add_target(descendant.target)
            elif isinstance(descendant, (ast.For, ast.AsyncFor)):
                add_target(descendant.target)
            elif isinstance(descendant, (ast.With, ast.AsyncWith)):
                for item in descendant.items:
                    if item.optional_vars is not None:
                        add_target(item.optional_vars)
            elif isinstance(descendant, ast.ExceptHandler) and descendant.name is not None:
                bindings.add(descendant.name)

    return sorted(bindings)

def function_item(node, kind):
    item = span_for(node)
    item["kind"] = kind
    item["name"] = node.name
    item["calls"] = collect_calls(node)
    item["references"] = collect_references(node, False)
    item["localBindings"] = collect_local_bindings(node)
    item.update(metadata_for(node))
    if kind in ("method", "async_method"):
        arg = first_arg_name(node)
        if arg is not None:
            item["firstArg"] = arg
    return item

def class_attribute_items(node):
    # Emit conservative class-level attribute items. Mirrors module_assignment_items
    # but scoped to the class body. Tuple/list destructuring, subscripted targets,
    # augmented assignments, and multi-target chained assigns are skipped.
    items = []

    if isinstance(node, ast.AnnAssign):
        if not isinstance(node.target, ast.Name):
            return items
        value_node = node.value
        kind = module_assignment_kind(node.target.id, value_node)
        items.append({
            "kind": "class_attribute",
            "assignmentKind": kind,
            "name": node.target.id,
            "hasAnnotation": True,
            "references": module_assignment_references(value_node, node.annotation),
            **span_for_assignment(node),
        })
        return items

    if isinstance(node, ast.Assign):
        if len(node.targets) != 1:
            return items
        target = node.targets[0]
        if not isinstance(target, ast.Name):
            return items
        kind = module_assignment_kind(target.id, node.value)
        items.append({
            "kind": "class_attribute",
            "assignmentKind": kind,
            "name": target.id,
            "hasAnnotation": False,
            "references": module_assignment_references(node.value, None),
            **span_for_assignment(node),
        })
        return items

    return items

def collect_class_bases(node):
    # Emit conservative textual base targets for each ast.ClassDef base
    # expression. Complex bases (ast.Call, ast.Subscript, etc.) are skipped;
    # downstream resolution requires exact, resolvable base-class identity.
    bases = []
    seen = set()

    for base in getattr(node, "bases", []):
        text = call_target_text(base)
        if text is None or text in seen:
            continue
        seen.add(text)
        bases.append(text)

    return bases

def class_item(node):
    item = span_for(node)
    item["kind"] = "class"
    item["name"] = node.name
    item["members"] = []
    item["references"] = collect_references(node, True)
    item["bases"] = collect_class_bases(node)
    item.update(metadata_for(node))

    for child in node.body:
        if isinstance(child, ast.FunctionDef):
            item["members"].append(function_item(child, "method"))
        elif isinstance(child, ast.AsyncFunctionDef):
            item["members"].append(function_item(child, "async_method"))
        elif isinstance(child, (ast.Assign, ast.AnnAssign)):
            item["members"].extend(class_attribute_items(child))

    return item

def decorator_text(node):
    if isinstance(node, ast.Name):
        return node.id

    if isinstance(node, ast.Attribute):
        parent = decorator_text(node.value)
        return None if parent is None else f"{parent}.{node.attr}"

    if isinstance(node, ast.Call):
        callee = decorator_text(node.func)
        return None if callee is None else f"{callee}(...)"

    if isinstance(node, ast.Subscript):
        segment = ast.get_source_segment(source, node)

        if segment is None:
            return None

        segment = segment.strip()
        return None if len(segment) == 0 or "\\n" in segment else segment

    return None

def metadata_for(node):
    metadata = {}
    docstring = ast.get_docstring(node, clean=False)

    if docstring is not None:
        metadata["docstring"] = docstring

    decorators = []

    for decorator in getattr(node, "decorator_list", []):
        text = decorator_text(decorator)

        if text is not None:
            decorators.append(text)

    if decorators:
        metadata["decorators"] = decorators

    return metadata

CONSTANT_NAME_RE = __import__("re").compile(r"^[A-Z][A-Z0-9_]*$")

def module_assignment_kind(name, value_node):
    if CONSTANT_NAME_RE.match(name):
        return "module_constant"
    if isinstance(value_node, (ast.Name, ast.Attribute)) and call_target_text(value_node) is not None:
        return "module_alias"
    return "module_variable"

def module_assignment_references(value_node, annotation_node):
    refs = []
    seen = set()

    def add(target_node, line, kind):
        if target_node is None:
            return
        text = call_target_text(target_node)
        if text is None:
            return
        key = (text, line, kind)
        if key in seen:
            return
        seen.add(key)
        refs.append({"target": text, "line": line, "kind": kind})

    if annotation_node is not None:
        add(annotation_node, getattr(annotation_node, "lineno", 0) or 0, "annotation")

    if isinstance(value_node, (ast.Name, ast.Attribute)):
        add(value_node, getattr(value_node, "lineno", 0) or 0, "alias")

    return refs

def module_assignment_items(node):
    # Emit conservative top-level assignment items.
    # Handles single-target NAME = value and NAME: T[ = value]. Tuple/list
    # destructuring, subscripted targets, augmented assignments, and multi-target
    # chained assigns are skipped conservatively.
    items = []

    if isinstance(node, ast.AnnAssign):
        if not isinstance(node.target, ast.Name):
            return items
        value_node = node.value  # may be None for "NAME: Type" without value
        kind = module_assignment_kind(node.target.id, value_node)
        items.append({
            "kind": "module_assignment",
            "assignmentKind": kind,
            "name": node.target.id,
            "hasAnnotation": True,
            "references": module_assignment_references(value_node, node.annotation),
            **span_for_assignment(node),
        })
        return items

    if isinstance(node, ast.Assign):
        if len(node.targets) != 1:
            return items
        target = node.targets[0]
        if not isinstance(target, ast.Name):
            return items
        kind = module_assignment_kind(target.id, node.value)
        items.append({
            "kind": "module_assignment",
            "assignmentKind": kind,
            "name": target.id,
            "hasAnnotation": False,
            "references": module_assignment_references(node.value, None),
            **span_for_assignment(node),
        })
        return items

    return items

def span_for_assignment(node):
    return {
        "startLine": node.lineno,
        "endLine": getattr(node, "end_lineno", node.lineno),
        "startByte": absolute_byte(node.lineno, node.col_offset),
        "endByte": absolute_byte(
            getattr(node, "end_lineno", node.lineno),
            getattr(node, "end_col_offset", node.col_offset),
        ),
        "bodyStartByte": absolute_byte(
            getattr(node, "end_lineno", node.lineno),
            getattr(node, "end_col_offset", node.col_offset),
        ),
    }

try:
    module = ast.parse(source, filename=file_path)
except SyntaxError as error:
    line_suffix = f" (line {error.lineno})" if error.lineno is not None else ""
    print(f"SyntaxError: {error.msg}{line_suffix}", file=sys.stderr)
    raise SystemExit(2)

items = []
imports = []

for child in module.body:
    if isinstance(child, ast.FunctionDef):
        items.append(function_item(child, "function"))
    elif isinstance(child, ast.AsyncFunctionDef):
        items.append(function_item(child, "async_function"))
    elif isinstance(child, ast.ClassDef):
        items.append(class_item(child))
    elif isinstance(child, (ast.Assign, ast.AnnAssign)):
        items.extend(module_assignment_items(child))
    elif isinstance(child, ast.Import):
        for alias in child.names:
            imported = {"kind": "import_module", "module": alias.name}
            if alias.asname is not None:
                imported["asName"] = alias.asname
            imports.append(imported)
    elif isinstance(child, ast.ImportFrom):
        for alias in child.names:
            imported = {
                "kind": "from_import",
                "level": child.level,
                "importedName": alias.name,
            }
            if child.module is not None:
                imported["module"] = child.module
            if alias.asname is not None:
                imported["asName"] = alias.asname
            imports.append(imported)

json.dump({"imports": imports, "items": items}, sys.stdout, sort_keys=True, separators=(",", ":"))
`.trim();

export const pythonParser: LanguageParser = createPythonParser();

export function createPythonParser(
  options: PythonParserOptions = {},
): LanguageParser {
  const context = makeParserContext(options);

  return {
    language: Language.Python,
    async parse(input: ParseFileInput): Promise<ParseResult> {
      return parsePythonWithContext(input, context);
    },
  };
}

export function parsePython(
  input: ParseFileInput,
  options: PythonParserOptions = {},
): ParseResult {
  return parsePythonWithContext(input, makeParserContext(options));
}

function parsePythonWithContext(
  input: ParseFileInput,
  context: PythonParserContext,
): ParseResult {
  if (input.language !== Language.Python) {
    throw ParserError.unsupportedLanguage(input.path, input.language);
  }

  const resolutionContext = withKnownFile(context, input.path, input.content);
  const root = parsePythonAst(input.path, input.content, resolutionContext);
  const extracted = extractTopLevelSymbols(input.path, input.content, root.items);
  const moduleSymbol = makeModuleSymbolRecord(input.path);
  const importEdges = extractImportEdges({
    filePath: input.path,
    imports: root.imports,
    moduleSymbol,
    context: resolutionContext,
  });
  const callEdges = extractCallEdges({
    filePath: input.path,
    items: root.items,
    imports: root.imports,
    symbols: extracted.symbols,
    context: resolutionContext,
  });
  const callPairs = new Set(
    callEdges.map((edge) => edgePairKey(edge.srcSymbolId, edge.dstSymbolId)),
  );
  const referenceEdges = extractReferenceEdges({
    filePath: input.path,
    items: root.items,
    imports: root.imports,
    symbols: extracted.symbols,
    context: resolutionContext,
    callPairs,
  });

  return {
    file: {
      id: computeFileId(input.path),
      path: input.path,
      language: input.language,
      contentHash: hashContent(input.content),
      sizeBytes: Buffer.byteLength(input.content),
    },
    symbols: [moduleSymbol, ...extracted.symbols],
    edges: [...extracted.edges, ...importEdges, ...callEdges, ...referenceEdges],
    diagnostics: [],
  };
}

function parsePythonAst(
  filePath: string,
  content: string,
  context: PythonParserContext,
): PythonAstRoot {
  const key = `${normalizeKnownFilePath(filePath)}\0${content}`;
  const cached = context.pythonAstCache.get(key);

  if (cached !== undefined) {
    return JSON.parse(cached) as PythonAstRoot;
  }

  if (!context.pythonAstBatch.exhausted
    && context.pythonAstBatch.spawns >= PYTHON_AST_BATCH_WARM_THRESHOLD) {
    warmPythonAstCache(context);
    const warmed = context.pythonAstCache.get(key);

    if (warmed !== undefined) {
      return JSON.parse(warmed) as PythonAstRoot;
    }
  }

  context.pythonAstBatch.spawns += 1;

  return parsePythonAstInOwnProcess(filePath, content, context);
}

/**
 * Fill the AST cache for every known Python module, in chunked interpreter
 * invocations.
 *
 * It warms ALL of them rather than a window around the request because two
 * callers share this cache and want opposite orders: the indexer walks files
 * sequentially, while import resolution reaches for whichever module a file
 * happens to import. A windowed cache serves the first and is evicted by the
 * second — measured on ARC at 440 spawns for 276 files, worse than the per-file
 * path it replaced.
 *
 * Best effort throughout: any failure — a missing interpreter, a driver error, a
 * file the batch could not parse — leaves that file absent from the cache and the
 * caller falls back to the per-file spawn it would have used anyway. The batch is
 * an optimisation, so it may never be the reason a file fails to parse.
 */
function warmPythonAstCache(context: PythonParserContext): void {
  const state = context.pythonAstBatch;
  state.exhausted = true;

  const modules = [...context.knownFilesByPath.entries()]
    .filter(([candidate]) => candidate.endsWith(".py") || candidate.endsWith(".pyi"))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, source]) => ({ path, source }));
  state.pending = [];

  if (modules.length < 2) {
    return;
  }

  const sourceBytes = modules.reduce((total, module) => total + module.source.length, 0);

  if (sourceBytes > PYTHON_AST_BATCH_MAX_SOURCE_BYTES) {
    return;
  }

  for (let start = 0; start < modules.length; start += PYTHON_AST_BATCH_SIZE) {
    const parsed = runPythonAstBatch(modules.slice(start, start + PYTHON_AST_BATCH_SIZE), context);

    if (parsed === null) {
      return;
    }

    for (const entry of parsed) {
      if (!entry.ok) {
        continue;
      }

      const source = context.knownFilesByPath.get(entry.path);

      if (source !== undefined) {
        context.pythonAstCache.set(`${entry.path}\0${source}`, entry.stdout);
      }
    }
  }
}

interface PythonAstBatchEntry {
  path: string;
  ok: boolean;
  stdout: string;
}

function runPythonAstBatch(
  files: readonly { path: string; source: string }[],
  context: PythonParserContext,
): PythonAstBatchEntry[] | null {
  if (files.length === 0) {
    return null;
  }

  const request = JSON.stringify({ script: PYTHON_AST_SCRIPT, files });

  for (const interpreter of context.interpreterCandidates) {
    const result = spawnSync(interpreter, ["-c", PYTHON_AST_BATCH_DRIVER], {
      encoding: "utf8",
      input: request,
      maxBuffer: 512 * 1024 * 1024,
    });

    if (result.error !== undefined) {
      if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }

      return null;
    }

    if (result.status !== 0) {
      return null;
    }

    try {
      return JSON.parse(result.stdout) as PythonAstBatchEntry[];
    } catch {
      return null;
    }
  }

  return null;
}

function parsePythonAstInOwnProcess(
  filePath: string,
  content: string,
  context: PythonParserContext,
): PythonAstRoot {
  let missingInterpreterError: Error | undefined;

  for (const interpreter of context.interpreterCandidates) {
    const result = spawnSync(interpreter, ["-c", PYTHON_AST_SCRIPT, filePath], {
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
      throw new Error(message.length > 0 ? message : `Python parser exited with code ${result.status}`);
    }

    return JSON.parse(result.stdout) as PythonAstRoot;
  }

  const attempted = context.interpreterCandidates.join(", ");
  const cause = missingInterpreterError instanceof Error ? `: ${missingInterpreterError.message}` : "";
  throw new Error(`No Python interpreter available for parser (${attempted})${cause}`);
}

function extractTopLevelSymbols(
  filePath: string,
  content: string,
  items: readonly PythonAstItem[],
): ExtractedSymbols {
  const symbols: SymbolRecord[] = [];
  const edges: EdgeRecord[] = [];

  for (const item of items) {
    if (item.kind === "function" || item.kind === "async_function") {
      symbols.push(makeSymbolRecord({
        ...item,
        filePath,
        content,
        localName: item.name,
        kind: SymbolKind.Function,
      }));
      continue;
    }

    if (item.kind === "module_assignment") {
      symbols.push(makeSymbolRecord({
        ...item,
        filePath,
        content,
        localName: item.name,
        kind: moduleAssignmentSymbolKind(item.assignmentKind),
      }));
      continue;
    }

    const classSymbol = makeSymbolRecord({
      ...item,
      filePath,
      content,
      localName: item.name,
      kind: SymbolKind.Class,
    });
    symbols.push(classSymbol);

    for (const member of item.members) {
      if (member.kind === "class_attribute") {
        const attributeSymbol = makeSymbolRecord({
          ...member,
          filePath,
          content,
          localName: member.name,
          kind: moduleAssignmentSymbolKind(member.assignmentKind),
          symbolPath: [classSymbol.localName, member.name],
          parentSymbolId: classSymbol.id,
        });

        symbols.push(attributeSymbol);
        edges.push(makeContainsEdge(classSymbol.id, attributeSymbol.id));
        continue;
      }

      const methodSymbol = makeSymbolRecord({
        ...member,
        filePath,
        content,
        localName: member.name,
        kind: SymbolKind.Method,
        symbolPath: [classSymbol.localName, member.name],
        parentSymbolId: classSymbol.id,
      });

      symbols.push(methodSymbol);
      edges.push(makeContainsEdge(classSymbol.id, methodSymbol.id));
    }
  }

  return { symbols, edges };
}

function moduleAssignmentSymbolKind(kind: PythonModuleAssignmentKind): SymbolKind {
  switch (kind) {
    case "module_constant":
      return SymbolKind.ModuleConstant;
    case "module_alias":
      return SymbolKind.ModuleAlias;
    case "module_variable":
      return SymbolKind.ModuleVariable;
  }
}

interface ExtractImportEdgesInput {
  filePath: string;
  imports: readonly PythonAstImport[];
  /** M140: stable module-scope owner of this file's import edges. */
  moduleSymbol: SymbolRecord;
  context: PythonParserContext;
}

interface PythonExportIndex {
  moduleSymbol?: SymbolRecord;
  namedSymbols: ReadonlyMap<string, SymbolRecord>;
  classMembersByClassName?: ReadonlyMap<string, ReadonlyMap<string, SymbolRecord>>;
  basesByClassName?: ReadonlyMap<string, readonly BaseClassRef[]>;
  /**
   * Names this module re-exports via an exact, unambiguous `from X import name`
   * (alias-aware). Used to resolve package `__init__.py` re-exports to the
   * defining module. Wildcard and ambiguous re-exports are excluded upstream by
   * `buildImportMaps`.
   */
  fromReExportsByName?: ReadonlyMap<string, { importedName: string; targetPath: string }>;
}

function extractImportEdges(input: ExtractImportEdgesInput): EdgeRecord[] {
  // M140: module-level imports are owned by the file's module scope, never by
  // whichever definition happens to be the only one. See
  // `makeModuleSymbolRecord`.
  const sourceSymbol = input.moduleSymbol;
  const exportIndexByPath = new Map<string, PythonExportIndex>();
  const edgesById = new Map<string, EdgeRecord>();

  for (const imported of input.imports) {
    const targetPath = resolveImportedModulePath(
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

    const exportIndex = getPythonExportIndex(
      targetPath,
      targetContent,
      input.context,
      exportIndexByPath,
    );
    const targetSymbol = imported.kind === "from_import" && imported.importedName !== "*"
      // Follow exact re-exports so a `from pkg import name` import edge points at
      // the defining module rather than missing when `pkg/__init__.py` re-exports.
      ? resolveExportedSymbol(targetPath, imported.importedName, input.context, exportIndexByPath)
      : resolveImportedSymbol(imported, exportIndex);

    if (targetSymbol === undefined) {
      continue;
    }

    const edge = makeImportEdge(sourceSymbol.id, targetSymbol.id);
    edgesById.set(edge.id, edge);
  }

  return [...edgesById.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function makeSymbolRecord(input: CreateSymbolInput): SymbolRecord {
  const symbolPath = input.symbolPath ?? [input.localName];
  const fqName = buildFQName({
    filePath: input.filePath,
    symbolPath,
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
    signature: getSignature(
      input.content,
      input.startByte,
      input.bodyStartByte,
      input.endByte,
    ),
    startLine: input.startLine,
    endLine: input.endLine,
    startByte: input.startByte,
    endByte: input.endByte,
    parentSymbolId: input.parentSymbolId,
    exported: false,
    ...(input.docstring === undefined ? {} : { docstring: input.docstring }),
    ...(input.decorators === undefined ? {} : { decorators: [...input.decorators] }),
  };
}

function getSignature(
  content: string,
  startByte: number,
  bodyStartByte: number,
  endByte: number,
): string {
  const buffer = Buffer.from(content);
  const cutoff = bodyStartByte >= startByte && bodyStartByte <= endByte
    ? bodyStartByte
    : endByte;
  const signature = buffer.subarray(startByte, cutoff).toString("utf8").trim();

  if (signature.length > 0) {
    return signature;
  }

  return buffer.subarray(startByte, endByte).toString("utf8").trim();
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

interface ExtractCallEdgesInput {
  filePath: string;
  items: readonly PythonAstItem[];
  imports: readonly PythonAstImport[];
  symbols: readonly SymbolRecord[];
  context: PythonParserContext;
}

interface CallResolutionContext {
  topLevelByName: ReadonlyMap<string, SymbolRecord>;
  fromImportsByName: ReadonlyMap<string, { importedName: string; targetPath: string }>;
  moduleImportsByName: ReadonlyMap<string, { targetPath: string }>;
  classMembersByClassName: ReadonlyMap<string, ReadonlyMap<string, SymbolRecord>>;
  basesByClassName: ReadonlyMap<string, readonly BaseClassRef[]>;
}

// A direct base class that resolved exactly, expressed either as a same-file
// class (looked up via classMembersByClassName) or as an imported class (looked
// up via the target file's export index). Unresolved or ambiguous bases are
// omitted at build time so inherited lookup only considers exact bases.
type BaseClassRef =
  | { kind: "local"; className: string }
  | { kind: "exported"; targetPath: string; className: string };

function extractCallEdges(input: ExtractCallEdgesInput): EdgeRecord[] {
  const resolution = buildCallResolutionContext(input);
  const exportIndexByPath = new Map<string, PythonExportIndex>();
  const edgesById = new Map<string, EdgeRecord>();

  const topLevelSymbolsByName = new Map<string, SymbolRecord>();
  const ambiguousTopLevelNames = new Set<string>();

  for (const symbol of input.symbols) {
    if (symbol.parentSymbolId !== undefined) {
      continue;
    }
    if (topLevelSymbolsByName.has(symbol.localName)) {
      ambiguousTopLevelNames.add(symbol.localName);
      continue;
    }
    topLevelSymbolsByName.set(symbol.localName, symbol);
  }

  for (const item of input.items) {
    if (item.kind === "function" || item.kind === "async_function") {
      const source = ambiguousTopLevelNames.has(item.name)
        ? undefined
        : topLevelSymbolsByName.get(item.name);

      if (source === undefined) {
        continue;
      }

      emitCallEdges(
        source,
        null,
        undefined,
        item.calls ?? [],
        item.localBindings,
        resolution,
        input.context,
        exportIndexByPath,
        edgesById,
      );
      continue;
    }

    if (item.kind !== "class") {
      continue;
    }

    const classSymbol = ambiguousTopLevelNames.has(item.name)
      ? undefined
      : topLevelSymbolsByName.get(item.name);

    if (classSymbol === undefined) {
      continue;
    }

    const classMembers = resolution.classMembersByClassName.get(item.name);

    for (const member of item.members) {
      if (member.kind === "class_attribute") {
        continue;
      }

      if (classMembers === undefined) {
        continue;
      }

      const methodSymbol = classMembers.get(member.name);

      if (methodSymbol === undefined) {
        continue;
      }

      emitCallEdges(
        methodSymbol,
        item.name,
        member.firstArg,
        member.calls ?? [],
        member.localBindings,
        resolution,
        input.context,
        exportIndexByPath,
        edgesById,
      );
    }
  }

  return [...edgesById.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function emitCallEdges(
  source: SymbolRecord,
  enclosingClassName: string | null,
  enclosingFirstArg: string | undefined,
  calls: readonly PythonAstCall[],
  localBindings: readonly string[],
  resolution: CallResolutionContext,
  context: PythonParserContext,
  exportIndexByPath: Map<string, PythonExportIndex>,
  edgesById: Map<string, EdgeRecord>,
): void {
  const localBindingSet = new Set(localBindings);

  for (const call of calls) {
    if (isShadowedLocalTarget(call.target, localBindingSet)) {
      continue;
    }

    const target = resolveCallTarget(
      call.target,
      enclosingClassName,
      enclosingFirstArg,
      resolution,
      context,
      exportIndexByPath,
    );

    if (target === undefined || target.id === source.id) {
      continue;
    }

    const edge = makeCallsEdge(source.id, target.id);
    // One (caller, callee) pair is one edge, but it can have many call sites.
    // Each occurrence is recorded so flow evidence can name a real site instead
    // of guessing at the first textual match in the caller's body.
    edgesById.set(edge.id, withCallSite(edgesById.get(edge.id) ?? edge, {
      startLine: call.line,
      startColumn: call.col ?? 0,
      endLine: Math.max(call.line, call.endLine ?? call.line),
      endColumn: call.endCol ?? call.col ?? 0,
      precision: call.col === undefined ? "line" : "span",
    }));
  }
}

function isShadowedLocalTarget(
  target: string,
  localBindings: ReadonlySet<string>,
): boolean {
  const firstSegment = target.split(".")[0];

  if (
    firstSegment === undefined
    || firstSegment === "self"
    || firstSegment === "cls"
    || firstSegment === "super()"
  ) {
    return false;
  }

  return localBindings.has(firstSegment);
}

function resolveCallTarget(
  target: string,
  enclosingClassName: string | null,
  enclosingFirstArg: string | undefined,
  resolution: CallResolutionContext,
  context: PythonParserContext,
  exportIndexByPath: Map<string, PythonExportIndex>,
): SymbolRecord | undefined {
  const member = resolveAttributeMemberTarget(
    target,
    enclosingClassName,
    enclosingFirstArg,
    resolution,
    context,
    exportIndexByPath,
  );

  if (member !== undefined) {
    // For calls, only resolve to method symbols; attribute-as-callable is skipped conservatively.
    return member.kind === SymbolKind.Method ? member : undefined;
  }

  if (target.length === 0) {
    return undefined;
  }

  const segments = target.split(".");

  if (segments.length === 1) {
    const name = segments[0] as string;
    const localMatch = resolution.topLevelByName.get(name);

    if (localMatch !== undefined) {
      return localMatch;
    }

    const fromImport = resolution.fromImportsByName.get(name);

    if (fromImport !== undefined) {
      return resolveExportedSymbol(fromImport.targetPath, fromImport.importedName, context, exportIndexByPath);
    }

    return undefined;
  }

  if (segments.length === 2) {
    const [prefix, attribute] = segments as [string, string];
    const moduleImport = resolution.moduleImportsByName.get(prefix);

    if (moduleImport === undefined) {
      return undefined;
    }

    return resolveExportedSymbol(moduleImport.targetPath, attribute, context, exportIndexByPath);
  }

  // Conservatively skip deeper attribute chains (e.g. pkg.mod.fn or obj.x.y).
  return undefined;
}

/**
 * Conservative resolver for self.x / cls.x / ClassName.x / super().x. Returns
 * the indexed member symbol (method or class-level attribute) when the
 * receiver and member resolve exactly; otherwise undefined. Kind gating
 * (method-only vs any) is applied by the caller. When the member is not found
 * on the immediate class, the resolver conservatively falls back to an exact
 * direct-base inherited member lookup; ambiguous multi-base cases are skipped.
 */
function resolveAttributeMemberTarget(
  target: string,
  enclosingClassName: string | null,
  enclosingFirstArg: string | undefined,
  resolution: CallResolutionContext,
  context: PythonParserContext,
  exportIndexByPath: Map<string, PythonExportIndex>,
): SymbolRecord | undefined {
  if (target.length === 0) {
    return undefined;
  }

  const segments = target.split(".");

  if (segments.length !== 2) {
    return undefined;
  }

  const [prefix, attribute] = segments as [string, string];

  // super().attr / super().method() — only resolves inside a class method
  // context and only looks at that class's resolved direct bases.
  if (prefix === "super()") {
    if (enclosingClassName === null) {
      return undefined;
    }
    return resolveInheritedDirectMember(
      enclosingClassName,
      attribute,
      resolution,
      context,
      exportIndexByPath,
    );
  }

  if (prefix === "self") {
    if (enclosingClassName === null || enclosingFirstArg !== "self") {
      return undefined;
    }
    const direct = resolution.classMembersByClassName.get(enclosingClassName)?.get(attribute);

    if (direct !== undefined) {
      return direct;
    }

    return resolveInheritedDirectMember(
      enclosingClassName,
      attribute,
      resolution,
      context,
      exportIndexByPath,
    );
  }

  if (prefix === "cls") {
    if (enclosingClassName === null || enclosingFirstArg !== "cls") {
      return undefined;
    }
    const direct = resolution.classMembersByClassName.get(enclosingClassName)?.get(attribute);

    if (direct !== undefined) {
      return direct;
    }

    return resolveInheritedDirectMember(
      enclosingClassName,
      attribute,
      resolution,
      context,
      exportIndexByPath,
    );
  }

  // Same-file class-qualified access: ClassName.member.
  const localSymbol = resolution.topLevelByName.get(prefix);

  if (localSymbol !== undefined && localSymbol.kind === SymbolKind.Class) {
    const direct = resolution.classMembersByClassName.get(prefix)?.get(attribute);

    if (direct !== undefined) {
      return direct;
    }

    return resolveInheritedDirectMember(
      prefix,
      attribute,
      resolution,
      context,
      exportIndexByPath,
    );
  }

  // Imported class-qualified access: ClassName.member where ClassName was imported
  // via `from pkg import ClassName` and resolves exactly to an indexed class.
  // Falls back to inherited base-class members through the target file's export
  // index when the direct lookup misses.
  const fromImport = resolution.fromImportsByName.get(prefix);

  if (fromImport !== undefined) {
    return resolveExportedClassMemberWithInheritance(
      fromImport.targetPath,
      fromImport.importedName,
      attribute,
      context,
      exportIndexByPath,
    );
  }

  return undefined;
}

function resolveExportedClassMember(
  targetPath: string,
  className: string,
  memberName: string,
  context: PythonParserContext,
  exportIndexByPath: Map<string, PythonExportIndex>,
): SymbolRecord | undefined {
  const targetContent = context.knownFilesByPath.get(targetPath);

  if (targetContent === undefined) {
    return undefined;
  }

  const exportIndex = getPythonExportIndex(targetPath, targetContent, context, exportIndexByPath);
  const classSymbol = exportIndex.namedSymbols.get(className);

  if (classSymbol === undefined || classSymbol.kind !== SymbolKind.Class) {
    return undefined;
  }

  return exportIndex.classMembersByClassName?.get(className)?.get(memberName);
}

/**
 * Resolve a member on an exported class, falling back to direct bases (and,
 * for same-file bases in the target file, to their direct bases — bounded to
 * keep the walk finite and deterministic). Ambiguous multi-base hits are
 * skipped. Cross-file transitive walks are supported via exportIndex lookups,
 * but the recursion is guarded against cycles by a visited set.
 */
function resolveExportedClassMemberWithInheritance(
  targetPath: string,
  className: string,
  memberName: string,
  context: PythonParserContext,
  exportIndexByPath: Map<string, PythonExportIndex>,
  visited: Set<string> = new Set(),
): SymbolRecord | undefined {
  const visitKey = `${targetPath}\0${className}`;

  if (visited.has(visitKey)) {
    return undefined;
  }

  visited.add(visitKey);

  const direct = resolveExportedClassMember(
    targetPath,
    className,
    memberName,
    context,
    exportIndexByPath,
  );

  if (direct !== undefined) {
    return direct;
  }

  const targetContent = context.knownFilesByPath.get(targetPath);

  if (targetContent === undefined) {
    return undefined;
  }

  const exportIndex = getPythonExportIndex(targetPath, targetContent, context, exportIndexByPath);

  // A class re-exported by this module (not defined here) resolves its members
  // through the defining module via the exact re-export chain.
  if (exportIndex.namedSymbols.get(className) === undefined) {
    const reExport = exportIndex.fromReExportsByName?.get(className);

    if (reExport !== undefined) {
      return resolveExportedClassMemberWithInheritance(
        reExport.targetPath,
        reExport.importedName,
        memberName,
        context,
        exportIndexByPath,
        visited,
      );
    }
  }

  const bases = exportIndex.basesByClassName?.get(className);

  if (bases === undefined || bases.length === 0) {
    return undefined;
  }

  const hitsById = new Map<string, SymbolRecord>();

  for (const base of bases) {
    const member = base.kind === "local"
      ? resolveExportedClassMemberWithInheritance(
        targetPath,
        base.className,
        memberName,
        context,
        exportIndexByPath,
        visited,
      )
      : resolveExportedClassMemberWithInheritance(
        base.targetPath,
        base.className,
        memberName,
        context,
        exportIndexByPath,
        visited,
      );

    if (member === undefined) {
      continue;
    }

    hitsById.set(member.id, member);
  }

  if (hitsById.size !== 1) {
    return undefined;
  }

  return [...hitsById.values()][0];
}

function resolveFromImportSubmodulePath(
  importerFilePath: string,
  imported: PythonFromImport,
  context: PythonParserContext,
): string | undefined {
  const baseModuleName = resolveImportFromModuleName(importerFilePath, imported, context);

  if (baseModuleName === undefined) {
    return undefined;
  }

  const submoduleName = `${baseModuleName}.${imported.importedName}`;
  return resolveAbsoluteModulePath(submoduleName, context);
}

function resolveExportedSymbol(
  targetPath: string,
  name: string,
  context: PythonParserContext,
  exportIndexByPath: Map<string, PythonExportIndex>,
  visited: Set<string> = new Set(),
): SymbolRecord | undefined {
  const visitKey = `${targetPath}\0${name}`;

  if (visited.has(visitKey)) {
    return undefined;
  }

  visited.add(visitKey);

  const targetContent = context.knownFilesByPath.get(targetPath);

  if (targetContent === undefined) {
    return undefined;
  }

  const exportIndex = getPythonExportIndex(targetPath, targetContent, context, exportIndexByPath);
  const direct = exportIndex.namedSymbols.get(name);

  if (direct !== undefined) {
    return direct;
  }

  // Follow an exact, unambiguous re-export (e.g. a package `__init__.py` doing
  // `from .submodule import name`) to the defining module. The visited guard
  // keeps re-export chains finite and cycle-safe.
  const reExport = exportIndex.fromReExportsByName?.get(name);

  if (reExport !== undefined) {
    return resolveExportedSymbol(
      reExport.targetPath,
      reExport.importedName,
      context,
      exportIndexByPath,
      visited,
    );
  }

  return undefined;
}

interface ExtractReferenceEdgesInput {
  filePath: string;
  items: readonly PythonAstItem[];
  imports: readonly PythonAstImport[];
  symbols: readonly SymbolRecord[];
  context: PythonParserContext;
  callPairs: ReadonlySet<string>;
}

function extractReferenceEdges(input: ExtractReferenceEdgesInput): EdgeRecord[] {
  const resolution = buildCallResolutionContext({
    filePath: input.filePath,
    items: input.items,
    imports: input.imports,
    symbols: input.symbols,
    context: input.context,
  });
  const exportIndexByPath = new Map<string, PythonExportIndex>();
  const edgesById = new Map<string, EdgeRecord>();

  const topLevelByName = new Map<string, SymbolRecord>();
  const topLevelAmbiguous = new Set<string>();

  for (const symbol of input.symbols) {
    if (symbol.parentSymbolId !== undefined) {
      continue;
    }
    if (topLevelByName.has(symbol.localName)) {
      topLevelAmbiguous.add(symbol.localName);
      continue;
    }
    topLevelByName.set(symbol.localName, symbol);
  }

  const lookupTopLevel = (name: string): SymbolRecord | undefined => {
    return topLevelAmbiguous.has(name) ? undefined : topLevelByName.get(name);
  };

  for (const item of input.items) {
    if (item.kind === "function" || item.kind === "async_function") {
      const source = lookupTopLevel(item.name);

      if (source === undefined) {
        continue;
      }

      emitReferenceEdges(
        source,
        null,
        undefined,
        item.references ?? [],
        item.localBindings,
        resolution,
        input.context,
        exportIndexByPath,
        input.callPairs,
        edgesById,
      );
      continue;
    }

    if (item.kind === "module_assignment") {
      const source = lookupTopLevel(item.name);

      if (source === undefined) {
        continue;
      }

      emitReferenceEdges(
        source,
        null,
        undefined,
        item.references ?? [],
        [],
        resolution,
        input.context,
        exportIndexByPath,
        input.callPairs,
        edgesById,
      );
      continue;
    }

    if (item.kind !== "class") {
      continue;
    }

    const classSymbol = lookupTopLevel(item.name);

    if (classSymbol === undefined) {
      continue;
    }

    emitReferenceEdges(
      classSymbol,
      null,
      undefined,
      item.references ?? [],
      [],
      resolution,
      input.context,
      exportIndexByPath,
      input.callPairs,
      edgesById,
    );

    const classMembers = resolution.classMembersByClassName.get(item.name);

    for (const member of item.members) {
      if (classMembers === undefined) {
        continue;
      }

      const memberSymbol = classMembers.get(member.name);

      if (memberSymbol === undefined) {
        continue;
      }

      if (member.kind === "class_attribute") {
        emitReferenceEdges(
          memberSymbol,
          item.name,
          undefined,
          member.references ?? [],
          [],
          resolution,
          input.context,
          exportIndexByPath,
          input.callPairs,
          edgesById,
        );
        continue;
      }

      emitReferenceEdges(
        memberSymbol,
        item.name,
        member.firstArg,
        member.references ?? [],
        member.localBindings,
        resolution,
        input.context,
        exportIndexByPath,
        input.callPairs,
        edgesById,
      );
    }
  }

  return [...edgesById.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function emitReferenceEdges(
  source: SymbolRecord,
  enclosingClassName: string | null,
  enclosingFirstArg: string | undefined,
  references: readonly PythonAstReference[],
  localBindings: readonly string[],
  resolution: CallResolutionContext,
  context: PythonParserContext,
  exportIndexByPath: Map<string, PythonExportIndex>,
  callPairs: ReadonlySet<string>,
  edgesById: Map<string, EdgeRecord>,
): void {
  const localBindingSet = new Set(localBindings);

  for (const reference of references) {
    if (isShadowedLocalReference(reference, localBindingSet)) {
      continue;
    }

    const target = resolveReferenceTarget(
      reference.target,
      enclosingClassName,
      enclosingFirstArg,
      resolution,
      context,
      exportIndexByPath,
    );

    if (target === undefined || target.id === source.id) {
      continue;
    }

    if (callPairs.has(edgePairKey(source.id, target.id))) {
      continue;
    }

    const edge = makeReferencesEdge(source.id, target.id);
    edgesById.set(edge.id, edge);
  }
}

function isShadowedLocalReference(
  reference: PythonAstReference,
  localBindings: ReadonlySet<string>,
): boolean {
  if (reference.kind !== "name_use" && reference.kind !== "alias") {
    return false;
  }

  const firstSegment = reference.target.split(".")[0];

  if (
    firstSegment === undefined
    || firstSegment === "self"
    || firstSegment === "cls"
    || firstSegment === "super()"
  ) {
    return false;
  }

  return localBindings.has(firstSegment);
}

function resolveReferenceTarget(
  target: string,
  enclosingClassName: string | null,
  enclosingFirstArg: string | undefined,
  resolution: CallResolutionContext,
  context: PythonParserContext,
  exportIndexByPath: Map<string, PythonExportIndex>,
): SymbolRecord | undefined {
  const member = resolveAttributeMemberTarget(
    target,
    enclosingClassName,
    enclosingFirstArg,
    resolution,
    context,
    exportIndexByPath,
  );

  if (member !== undefined) {
    // For references, any indexed class member (method or class-level attribute) is valid.
    return member;
  }

  if (target.length === 0) {
    return undefined;
  }

  const segments = target.split(".");

  if (segments.length === 1) {
    const name = segments[0] as string;
    const localMatch = resolution.topLevelByName.get(name);

    if (localMatch !== undefined) {
      return localMatch;
    }

    const fromImport = resolution.fromImportsByName.get(name);

    if (fromImport !== undefined) {
      return resolveExportedSymbol(
        fromImport.targetPath,
        fromImport.importedName,
        context,
        exportIndexByPath,
      );
    }

    return undefined;
  }

  if (segments.length === 2) {
    const [prefix, attribute] = segments as [string, string];

    if (prefix === "self" || prefix === "cls" || prefix === "super()") {
      // Unresolved self./cls./super() — receiver context did not allow exact
      // member or inherited-base resolution; skip conservatively.
      return undefined;
    }

    const moduleImport = resolution.moduleImportsByName.get(prefix);

    if (moduleImport === undefined) {
      return undefined;
    }

    return resolveExportedSymbol(moduleImport.targetPath, attribute, context, exportIndexByPath);
  }

  // Conservatively skip deeper attribute chains.
  return undefined;
}

interface ImportMaps {
  fromImportsByName: Map<string, { importedName: string; targetPath: string }>;
  moduleImportsByName: Map<string, { targetPath: string }>;
}

function buildImportMaps(
  filePath: string,
  imports: readonly PythonAstImport[],
  topLevelByName: ReadonlyMap<string, SymbolRecord>,
  context: PythonParserContext,
): ImportMaps {
  const fromImportsByName = new Map<string, { importedName: string; targetPath: string }>();
  const fromImportsAmbiguous = new Set<string>();
  const moduleImportsByName = new Map<string, { targetPath: string }>();
  const moduleImportsAmbiguous = new Set<string>();

  for (const imported of imports) {
    if (imported.kind === "from_import") {
      if (imported.importedName === "*") {
        continue;
      }

      const boundName = imported.asName ?? imported.importedName;

      if (topLevelByName.has(boundName)) {
        fromImportsAmbiguous.add(boundName);
        continue;
      }

      const targetPath = resolveImportedModulePath(filePath, imported, context);

      if (targetPath === undefined) {
        continue;
      }

      if (fromImportsByName.has(boundName) || moduleImportsByName.has(boundName)) {
        fromImportsAmbiguous.add(boundName);
        moduleImportsAmbiguous.add(boundName);
        continue;
      }

      fromImportsByName.set(boundName, { importedName: imported.importedName, targetPath });

      const submodulePath = resolveFromImportSubmodulePath(filePath, imported, context);

      if (submodulePath !== undefined) {
        moduleImportsByName.set(boundName, { targetPath: submodulePath });
      }
      continue;
    }

    if (imported.kind === "import_module") {
      const boundName = imported.asName ?? imported.module.split(".")[0];

      if (boundName === undefined || boundName.length === 0) {
        continue;
      }

      if (topLevelByName.has(boundName)) {
        moduleImportsAmbiguous.add(boundName);
        continue;
      }

      if (fromImportsByName.has(boundName) || moduleImportsByName.has(boundName)) {
        fromImportsAmbiguous.add(boundName);
        moduleImportsAmbiguous.add(boundName);
        continue;
      }

      const targetPath = resolveAbsoluteModulePath(imported.module, context);

      if (targetPath === undefined) {
        continue;
      }

      moduleImportsByName.set(boundName, { targetPath });
    }
  }

  for (const name of fromImportsAmbiguous) {
    fromImportsByName.delete(name);
  }

  for (const name of moduleImportsAmbiguous) {
    moduleImportsByName.delete(name);
  }

  return { fromImportsByName, moduleImportsByName };
}

function buildTopLevelIndex(
  symbols: readonly SymbolRecord[],
): Map<string, SymbolRecord> {
  const topLevelByName = new Map<string, SymbolRecord>();
  const topLevelAmbiguous = new Set<string>();

  for (const symbol of symbols) {
    if (symbol.parentSymbolId !== undefined) {
      continue;
    }

    if (topLevelByName.has(symbol.localName)) {
      topLevelAmbiguous.add(symbol.localName);
      continue;
    }

    topLevelByName.set(symbol.localName, symbol);
  }

  for (const name of topLevelAmbiguous) {
    topLevelByName.delete(name);
  }

  return topLevelByName;
}

function buildCallResolutionContext(input: ExtractCallEdgesInput): CallResolutionContext {
  const topLevelByName = buildTopLevelIndex(input.symbols);
  const { fromImportsByName, moduleImportsByName } = buildImportMaps(
    input.filePath,
    input.imports,
    topLevelByName,
    input.context,
  );

  const classMembersByClassName = new Map<string, ReadonlyMap<string, SymbolRecord>>();

  for (const item of input.items) {
    if (item.kind !== "class") {
      continue;
    }

    const classSymbol = topLevelByName.get(item.name);

    if (classSymbol === undefined) {
      continue;
    }

    const membersByName = new Map<string, SymbolRecord>();
    const membersAmbiguous = new Set<string>();

    for (const member of item.members) {
      const memberSymbol = input.symbols.find((symbol) =>
        symbol.parentSymbolId === classSymbol.id
          && symbol.localName === member.name
          && symbol.startByte === member.startByte
      );

      if (memberSymbol === undefined) {
        continue;
      }

      if (membersByName.has(member.name)) {
        membersAmbiguous.add(member.name);
        continue;
      }

      membersByName.set(member.name, memberSymbol);
    }

    for (const name of membersAmbiguous) {
      membersByName.delete(name);
    }

    classMembersByClassName.set(item.name, membersByName);
  }

  const basesByClassName = buildBasesByClassName({
    items: input.items,
    topLevelByName,
    fromImportsByName,
    moduleImportsByName,
    context: input.context,
  });

  return {
    topLevelByName,
    fromImportsByName,
    moduleImportsByName,
    classMembersByClassName,
    basesByClassName,
  };
}

interface BuildBasesInput {
  items: readonly PythonAstItem[];
  topLevelByName: ReadonlyMap<string, SymbolRecord>;
  fromImportsByName: ReadonlyMap<string, { importedName: string; targetPath: string }>;
  moduleImportsByName: ReadonlyMap<string, { targetPath: string }>;
  context: PythonParserContext;
}

/**
 * Build a map of resolved direct bases per class name. A base is kept only if
 * it resolves exactly to an indexed class — either a same-file class or an
 * exported class in a known module. Unresolved bases are dropped (they cannot
 * contribute inherited members we can verify), which keeps the graph honest.
 */
function buildBasesByClassName(
  input: BuildBasesInput,
): ReadonlyMap<string, readonly BaseClassRef[]> {
  const basesByClassName = new Map<string, BaseClassRef[]>();
  const exportIndexByPath = new Map<string, PythonExportIndex>();

  for (const item of input.items) {
    if (item.kind !== "class") {
      continue;
    }

    const resolvedBases: BaseClassRef[] = [];
    const seenKeys = new Set<string>();

    for (const baseText of item.bases) {
      const resolved = resolveBaseClassRef(baseText, input, exportIndexByPath);

      if (resolved === undefined) {
        continue;
      }

      const key = baseRefKey(resolved);

      if (seenKeys.has(key)) {
        continue;
      }

      seenKeys.add(key);
      resolvedBases.push(resolved);
    }

    basesByClassName.set(item.name, resolvedBases);
  }

  return basesByClassName;
}

function resolveBaseClassRef(
  baseText: string,
  input: BuildBasesInput,
  exportIndexByPath: Map<string, PythonExportIndex>,
): BaseClassRef | undefined {
  if (baseText.length === 0) {
    return undefined;
  }

  const segments = baseText.split(".");

  if (segments.length === 1) {
    const name = segments[0] as string;
    const localSymbol = input.topLevelByName.get(name);

    if (localSymbol !== undefined && localSymbol.kind === SymbolKind.Class) {
      return { kind: "local", className: name };
    }

    const fromImport = input.fromImportsByName.get(name);

    if (fromImport !== undefined) {
      const exported = resolveExportedSymbol(
        fromImport.targetPath,
        fromImport.importedName,
        input.context,
        exportIndexByPath,
      );

      if (exported !== undefined && exported.kind === SymbolKind.Class) {
        return {
          kind: "exported",
          targetPath: fromImport.targetPath,
          className: fromImport.importedName,
        };
      }
    }

    return undefined;
  }

  if (segments.length === 2) {
    const [prefix, className] = segments as [string, string];
    const moduleImport = input.moduleImportsByName.get(prefix);

    if (moduleImport === undefined) {
      return undefined;
    }

    const exported = resolveExportedSymbol(
      moduleImport.targetPath,
      className,
      input.context,
      exportIndexByPath,
    );

    if (exported !== undefined && exported.kind === SymbolKind.Class) {
      return {
        kind: "exported",
        targetPath: moduleImport.targetPath,
        className,
      };
    }

    return undefined;
  }

  // Deeper chains (pkg.sub.Cls) are conservatively skipped.
  return undefined;
}

function baseRefKey(ref: BaseClassRef): string {
  return ref.kind === "local"
    ? `local\0${ref.className}`
    : `exported\0${ref.targetPath}\0${ref.className}`;
}

/**
 * Resolve a member on a single base-class reference. Same-file bases use the
 * in-file class members map; imported bases use the target module's export
 * index. Returns undefined when the base does not directly expose the member.
 */
function memberOnBaseClass(
  base: BaseClassRef,
  memberName: string,
  resolution: CallResolutionContext,
  context: PythonParserContext,
  exportIndexByPath: Map<string, PythonExportIndex>,
): SymbolRecord | undefined {
  if (base.kind === "local") {
    return resolution.classMembersByClassName.get(base.className)?.get(memberName);
  }

  // Exported base: walk via the target file's export index so a cross-file
  // grandparent chain (resolved exactly at each hop) can still contribute.
  return resolveExportedClassMemberWithInheritance(
    base.targetPath,
    base.className,
    memberName,
    context,
    exportIndexByPath,
  );
}

/**
 * Conservative inherited-member lookup for a given enclosing class. Walks the
 * exact resolved base set (direct bases only) and returns the single matching
 * member if present on exactly one base. When multiple bases expose the same
 * name (ambiguity) or none do, returns undefined — "prefer missing an edge
 * over inventing a wrong inherited target".
 */
function resolveInheritedDirectMember(
  className: string,
  memberName: string,
  resolution: CallResolutionContext,
  context: PythonParserContext,
  exportIndexByPath: Map<string, PythonExportIndex>,
): SymbolRecord | undefined {
  const bases = resolution.basesByClassName.get(className);

  if (bases === undefined || bases.length === 0) {
    return undefined;
  }

  const hitsById = new Map<string, SymbolRecord>();

  for (const base of bases) {
    const member = memberOnBaseClass(base, memberName, resolution, context, exportIndexByPath);

    if (member === undefined) {
      continue;
    }

    hitsById.set(member.id, member);
  }

  if (hitsById.size !== 1) {
    return undefined;
  }

  return [...hitsById.values()][0];
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function hashParts(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function makeParserContext(options: PythonParserOptions): PythonParserContext {
  const interpreterCandidates = options.interpreterCandidates ?? DEFAULT_INTERPRETER_CANDIDATES;
  const knownFilesByPath = new Map<string, string>();

  for (const file of options.knownFiles ?? []) {
    knownFilesByPath.set(normalizeKnownFilePath(file.path), file.content);
  }

  const { moduleNameByFilePath, modulePathsByName } = buildModuleIndexes(knownFilesByPath);

  return {
    interpreterCandidates,
    knownFilesByPath,
    moduleNameByFilePath,
    modulePathsByName,
    cythonExportIndexCache: new Map(),
    pythonExportIndexCache: new Map(),
    pythonAstCache: new Map(),
    pythonAstBatch: { spawns: 0, pending: null, exhausted: false },
  };
}

function withKnownFile(
  context: PythonParserContext,
  filePath: string,
  content: string,
): PythonParserContext {
  const normalizedPath = normalizeKnownFilePath(filePath);

  if (context.knownFilesByPath.get(normalizedPath) === content) {
    return context;
  }

  const knownFilesByPath = new Map(context.knownFilesByPath);
  knownFilesByPath.set(normalizedPath, content);

  const { moduleNameByFilePath, modulePathsByName } = buildModuleIndexes(knownFilesByPath);

  return {
    interpreterCandidates: context.interpreterCandidates,
    knownFilesByPath,
    moduleNameByFilePath,
    modulePathsByName,
    cythonExportIndexCache: context.cythonExportIndexCache,
    pythonExportIndexCache: context.pythonExportIndexCache,
    pythonAstCache: context.pythonAstCache,
    pythonAstBatch: context.pythonAstBatch,
  };
}

function buildModuleIndexes(
  knownFilesByPath: ReadonlyMap<string, string>,
): Pick<PythonParserContext, "moduleNameByFilePath" | "modulePathsByName"> {
  const moduleFiles = [...knownFilesByPath.keys()]
    .filter((filePath) => moduleFileExtension(filePath) !== undefined)
    .sort((left, right) => left.localeCompare(right));
  const moduleNameByFilePath = new Map<string, string>();
  const modulePathsByName = new Map<string, string[]>();

  for (const filePath of moduleFiles) {
    const moduleName = getCanonicalModuleName(filePath, knownFilesByPath);

    if (moduleName === undefined) {
      continue;
    }

    moduleNameByFilePath.set(filePath, moduleName);

    const existing = modulePathsByName.get(moduleName);

    if (existing === undefined) {
      modulePathsByName.set(moduleName, [filePath]);
      continue;
    }

    existing.push(filePath);
  }

  return { moduleNameByFilePath, modulePathsByName };
}

/**
 * Importable module file extensions in resolution-precedence order. Python
 * source wins over a Cython implementation, which wins over Cython declaration
 * (`.pxd`) and include (`.pxi`) files. `.pxd`/`.pxi` are not Python-importable
 * on their own, but indexing them lets exact wrapper -> declaration references
 * resolve when no implementation file is present.
 */
const MODULE_FILE_EXTENSIONS: readonly string[] = [".py", ".pyx", ".pxd", ".pxi"];

function moduleFileExtension(filePath: string): string | undefined {
  return MODULE_FILE_EXTENSIONS.find((extension) => filePath.endsWith(extension));
}

function moduleFileExtensionPriority(filePath: string): number {
  const index = MODULE_FILE_EXTENSIONS.findIndex((extension) => filePath.endsWith(extension));

  return index === -1 ? MODULE_FILE_EXTENSIONS.length : index;
}

function getCanonicalModuleName(
  filePath: string,
  knownFilesByPath: ReadonlyMap<string, string>,
): string | undefined {
  const extension = moduleFileExtension(filePath);

  if (extension === undefined) {
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
    const initPath = [...directorySegments.slice(0, index + 1), "__init__.py"].join("/");

    if (!knownFilesByPath.has(initPath)) {
      break;
    }

    packageStartIndex = index;
  }

  const moduleSegments = directorySegments.slice(packageStartIndex);

  if (fileName === "__init__.py") {
    return moduleSegments.length === 0 ? undefined : moduleSegments.join(".");
  }

  const stem = fileName.slice(0, -extension.length);

  if (stem.length === 0) {
    return undefined;
  }

  return [...moduleSegments, stem].join(".");
}

function resolveImportedModulePath(
  importerFilePath: string,
  imported: PythonAstImport,
  context: PythonParserContext,
): string | undefined {
  if (imported.kind === "import_module") {
    return resolveAbsoluteModulePath(imported.module, context);
  }

  const moduleName = resolveImportFromModuleName(importerFilePath, imported, context);

  if (moduleName === undefined) {
    return undefined;
  }

  return resolveAbsoluteModulePath(moduleName, context);
}

function resolveImportFromModuleName(
  importerFilePath: string,
  imported: PythonFromImport,
  context: PythonParserContext,
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

  return importerFilePath.endsWith("/__init__.py") || importerFilePath === "__init__.py"
    ? moduleSegments
    : moduleSegments.slice(0, -1);
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

function resolveAbsoluteModulePath(
  moduleName: string,
  context: PythonParserContext,
): string | undefined {
  const normalizedModuleName = normalizeModuleName(moduleName);

  if (normalizedModuleName === undefined) {
    return undefined;
  }

  const paths = context.modulePathsByName.get(normalizedModuleName);

  if (paths === undefined || paths.length === 0) {
    return undefined;
  }

  if (paths.length === 1) {
    return paths[0];
  }

  // Multiple files map to one module name (commonly a Cython `.pyx` paired with
  // its `.pxd`). Resolve to the single highest-precedence file. If two files
  // share the top precedence (e.g. two `.py` files) the target is genuinely
  // ambiguous and is skipped.
  return selectByExtensionPrecedence(paths);
}

function selectByExtensionPrecedence(
  paths: readonly string[],
): string | undefined {
  let bestPath: string | undefined;
  let bestPriority = Number.POSITIVE_INFINITY;
  let bestIsTied = false;

  for (const candidate of paths) {
    const priority = moduleFileExtensionPriority(candidate);

    if (priority < bestPriority) {
      bestPriority = priority;
      bestPath = candidate;
      bestIsTied = false;
    } else if (priority === bestPriority) {
      bestIsTied = true;
    }
  }

  return bestIsTied ? undefined : bestPath;
}

function getCythonBackedExportIndex(
  filePath: string,
  content: string,
  context: PythonParserContext,
): PythonExportIndex {
  const cached = context.cythonExportIndexCache.get(filePath);
  const cythonExports: CrossLanguageExportIndex = cached
    ?? getCythonExportIndex(filePath, content);

  if (cached === undefined) {
    context.cythonExportIndexCache.set(filePath, cythonExports);
  }

  // Cython inheritance is intentionally not resolved (no basesByClassName): we
  // prefer missing an inherited-member edge over guessing across `cdef class`
  // hierarchies we have not fully modelled.
  return {
    ...(cythonExports.moduleSymbol === undefined
      ? {}
      : { moduleSymbol: cythonExports.moduleSymbol }),
    namedSymbols: cythonExports.namedSymbols,
    classMembersByClassName: cythonExports.classMembersByClassName,
  };
}

function getPythonExportIndex(
  filePath: string,
  content: string,
  context: PythonParserContext,
  exportIndexByPath: Map<string, PythonExportIndex>,
): PythonExportIndex {
  const existing = exportIndexByPath.get(filePath);

  if (existing !== undefined) {
    return existing;
  }

  // Cython-backed modules cannot be inspected with the CPython `ast`; reuse the
  // Cython parser's extracted symbols as the source of truth instead.
  if (detectLanguage(filePath) === Language.Cython) {
    const exportIndex = getCythonBackedExportIndex(filePath, content, context);
    exportIndexByPath.set(filePath, exportIndex);
    return exportIndex;
  }

  // Run-level memo: the same target module is imported by many source files, so
  // without this it would be re-parsed (a subprocess spawn) once per importer.
  // Keyed by path+content so it is behaviour-identical to the un-cached path even
  // when `withKnownFile` overrides a file's content for the current parse.
  const cacheKey = `${filePath}\0${hashContent(content)}`;
  const cached = context.pythonExportIndexCache.get(cacheKey);
  if (cached !== undefined) {
    exportIndexByPath.set(filePath, cached);
    return cached;
  }

  try {
    const root = parsePythonAst(filePath, content, context);
    const extracted = extractTopLevelSymbols(filePath, content, root.items);
    const topLevelSymbols = extracted.symbols.filter((symbol) => symbol.parentSymbolId === undefined);
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

    const classMembersByClassName = buildClassMembersIndex(extracted.symbols, root.items);
    const topLevelByName = buildTopLevelIndex(extracted.symbols);
    const { fromImportsByName, moduleImportsByName } = buildImportMaps(
      filePath,
      root.imports,
      topLevelByName,
      context,
    );
    const basesByClassName = buildBasesByClassName({
      items: root.items,
      topLevelByName,
      fromImportsByName,
      moduleImportsByName,
      context,
    });

    const exportIndex: PythonExportIndex = {
      // M140: `import model` targets the module scope itself, which always
      // exists. Previously this was the file's single top-level symbol, so the
      // TARGET side of an import edge disappeared just as unstably as the
      // source side when the imported file gained a second definition.
      moduleSymbol: makeModuleSymbolRecord(filePath),
      namedSymbols,
      classMembersByClassName,
      basesByClassName,
      fromReExportsByName: fromImportsByName,
    };

    exportIndexByPath.set(filePath, exportIndex);
    context.pythonExportIndexCache.set(cacheKey, exportIndex);
    return exportIndex;
  } catch {
    const exportIndex: PythonExportIndex = { namedSymbols: new Map() };
    exportIndexByPath.set(filePath, exportIndex);
    context.pythonExportIndexCache.set(cacheKey, exportIndex);
    return exportIndex;
  }
}

function buildClassMembersIndex(
  symbols: readonly SymbolRecord[],
  items: readonly PythonAstItem[],
): ReadonlyMap<string, ReadonlyMap<string, SymbolRecord>> {
  const classMembersByClassName = new Map<string, ReadonlyMap<string, SymbolRecord>>();
  const topLevelClassesByName = new Map<string, SymbolRecord>();
  const ambiguousClassNames = new Set<string>();

  for (const symbol of symbols) {
    if (symbol.parentSymbolId !== undefined || symbol.kind !== SymbolKind.Class) {
      continue;
    }

    if (topLevelClassesByName.has(symbol.localName)) {
      ambiguousClassNames.add(symbol.localName);
      continue;
    }

    topLevelClassesByName.set(symbol.localName, symbol);
  }

  for (const name of ambiguousClassNames) {
    topLevelClassesByName.delete(name);
  }

  for (const item of items) {
    if (item.kind !== "class") {
      continue;
    }

    const classSymbol = topLevelClassesByName.get(item.name);

    if (classSymbol === undefined) {
      continue;
    }

    const membersByName = new Map<string, SymbolRecord>();
    const membersAmbiguous = new Set<string>();

    for (const member of item.members) {
      const memberSymbol = symbols.find((symbol) =>
        symbol.parentSymbolId === classSymbol.id
          && symbol.localName === member.name
          && symbol.startByte === member.startByte
      );

      if (memberSymbol === undefined) {
        continue;
      }

      if (membersByName.has(member.name)) {
        membersAmbiguous.add(member.name);
        continue;
      }

      membersByName.set(member.name, memberSymbol);
    }

    for (const name of membersAmbiguous) {
      membersByName.delete(name);
    }

    classMembersByClassName.set(item.name, membersByName);
  }

  return classMembersByClassName;
}

function resolveImportedSymbol(
  imported: PythonAstImport,
  exportIndex: PythonExportIndex,
): SymbolRecord | undefined {
  if (imported.kind === "import_module") {
    return exportIndex.moduleSymbol;
  }

  if (imported.importedName === "*") {
    return undefined;
  }

  return exportIndex.namedSymbols.get(imported.importedName);
}

function normalizeKnownFilePath(filePath: string): string {
  return normalizeFilePath(filePath);
}
