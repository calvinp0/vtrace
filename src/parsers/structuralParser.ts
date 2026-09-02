/**
 * The generic structural adapter: one tree-sitter walk that serves every
 * STRUCTURAL / DOCUMENT / PARSED_NO_STRUCTURE family through a rule table (M202).
 *
 * It implements the same `LanguageParser` contract as the deep Python,
 * TypeScript and Cython adapters and is registered beside them in the ONE
 * registry `createDefaultParserRegistry` builds; the deep adapters keep their
 * own families and are never routed here (control F10).
 *
 * WHAT IT EMITS, AND WHAT IT REFUSES TO
 * -------------------------------------
 *   symbols     named declarations matched by `structuralRules.ts`, with UTF-8
 *               byte spans converted at the `treeSitterSource` boundary, a
 *               verbatim signature slice, a leading comment block as docstring,
 *               and `contains` edges from an enclosing declaration
 *   diagnostics one per ERROR / MISSING node, exactly as the TypeScript adapter
 *   nothing     from inside an ERROR subtree — a malformed region yields no
 *               declarations rather than guessed ones (§31); no imports, calls
 *               or references — none are derivable from syntax alone (§49)
 *
 * PARSE TRUTH (§19)
 *   root node ERROR            → throws; the registry records `parse_failed`
 *   errors inside a valid root → partial result with diagnostics
 *   no declarations            → ok result with zero symbols
 *
 * BOUNDS
 *   MAX_SYMBOLS_PER_FILE declarations, then a diagnostic and stop; an explicit
 *   stack instead of recursion so a deeply nested expression cannot overflow.
 */
import { createHash } from "node:crypto";
import Parser from "tree-sitter";

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
import { familyOf, type LanguageFamilyDescriptor } from "./languageFamilies";
import { BODY_NODE_TYPES, COMMENT_NODE_TYPES, STRUCTURAL_RULES, type DeclarationRule, type FamilyRules, type NameStrategy } from "./structuralRules";
import { loadGrammar } from "./treeSitterGrammars";
import { offsetsFor, parseWithSizedBuffer } from "./treeSitterSource";
import type { ParseFileInput } from "./types";

type SyntaxNode = Parser.SyntaxNode;

export const MAX_SYMBOLS_PER_FILE = 5000;
const MAX_NAME_LENGTH = 200;
const MAX_DOCSTRING_LENGTH = 2000;
const MAX_TRAVERSAL_DEPTH = 512;

const DECLARATOR_NAME_TYPES = new Set([
  "identifier", "field_identifier", "type_identifier", "qualified_identifier", "destructor_name",
  "operator_name", "scoped_identifier", "template_function",
]);

/** One parser per family, built on first use and kept for the process lifetime. */
const parsers = new Map<string, Parser>();

function parserFor(family: LanguageFamilyDescriptor, filePath: string): Parser {
  const grammar = family.grammar;
  if (grammar === undefined) {
    throw new Error(`language family ${family.language} declares no grammar`);
  }
  const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const exportName = grammar.exportByExtension?.[extension] ?? grammar.exportName ?? "";
  const key = `${family.language}\0${exportName}`;
  const cached = parsers.get(key);
  if (cached !== undefined) return cached;
  const parser = new Parser();
  parser.setLanguage(loadGrammar(grammar, filePath));
  parsers.set(key, parser);
  return parser;
}

/** Test seam: parser instances alive in this process. */
export function structuralParserInstanceCount(): number {
  return parsers.size;
}

interface Frame {
  readonly node: SyntaxNode;
  readonly parentSymbol: SymbolRecord | undefined;
  /** Scope segments and enclosing symbol names, in order: the FQN prefix. */
  readonly symbolPath: readonly string[];
  readonly inMethodContainer: boolean;
  readonly depth: number;
}

interface Extraction {
  readonly symbols: SymbolRecord[];
  readonly edges: EdgeRecord[];
  readonly diagnostics: ParseDiagnostic[];
}

export function parseStructural(input: ParseFileInput, family: LanguageFamilyDescriptor): ParseResult {
  if (input.language !== family.language) {
    throw ParserError.unsupportedLanguage(input.path, input.language);
  }
  const rules = STRUCTURAL_RULES[family.language];
  if (rules === undefined) {
    throw new Error(`language family ${family.language} has no structural rules`);
  }

  const tree = parseWithSizedBuffer(parserFor(family, input.path), input.content);
  const root = tree.rootNode;
  if (root.type === "ERROR") {
    throw new Error(`${family.displayName} grammar could not recognise the file: root node is ERROR`);
  }

  const extracted = extract(input.path, input.content, root, rules);
  const diagnostics = [...collectDiagnostics(input.content, root), ...extracted.diagnostics];

  return {
    file: {
      id: computeFileId(input.path),
      path: input.path,
      language: input.language,
      contentHash: createHash("sha256").update(input.content).digest("hex"),
      sizeBytes: Buffer.byteLength(input.content),
    },
    symbols: extracted.symbols,
    edges: extracted.edges,
    diagnostics,
  };
}

function extract(filePath: string, content: string, root: SyntaxNode, rules: FamilyRules): Extraction {
  const rulesByType = new Map<string, DeclarationRule[]>();
  for (const rule of rules.declarations) {
    rulesByType.set(rule.nodeType, [...(rulesByType.get(rule.nodeType) ?? []), rule]);
  }
  const methodContainers = new Set(rules.methodContainers ?? []);
  const symbols: SymbolRecord[] = [];
  const edges: EdgeRecord[] = [];
  const diagnostics: ParseDiagnostic[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const stack: Frame[] = [{ node: root, parentSymbol: undefined, symbolPath: [], inMethodContainer: false, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { node } = frame;
    if (node.isError || node.isMissing || frame.depth > MAX_TRAVERSAL_DEPTH) continue;
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) {
      if (!truncated) {
        truncated = true;
        diagnostics.push({ message: `structural extraction stopped at ${MAX_SYMBOLS_PER_FILE} declarations`, startLine: node.startPosition.row + 1 });
      }
      break;
    }

    const rule = (rulesByType.get(node.type) ?? []).find((candidate) => candidate.when === undefined || candidate.when(node));
    const name = rule === undefined ? undefined : extractName(rule.name, node);

    if (rule !== undefined && name !== undefined) {
      const kind = resolveKind(rule, node, frame);

      if (kind === "scope") {
        pushChildren(stack, node, { parentSymbol: frame.parentSymbol, symbolPath: [...frame.symbolPath, name],
          inMethodContainer: frame.inMethodContainer || methodContainers.has(node.type), depth: frame.depth + 1 });
        continue;
      }
      if (rule.topLevelOnly && frame.parentSymbol !== undefined) {
        continue;
      }
      const symbolPath = [...frame.symbolPath, name];
      const dedupeKey = `${symbolPath.join("\0")}\0${kind}`;
      if (seen.has(dedupeKey)) {
        // A second clause of the same declaration (Haskell equations, C
        // definitions repeated under #if) is the same symbol, not a new one.
        continue;
      }
      seen.add(dedupeKey);

      const symbol = makeSymbol({ filePath, content, node, rule, name, kind, symbolPath, parentSymbol: frame.parentSymbol });
      symbols.push(symbol);
      if (frame.parentSymbol !== undefined) {
        edges.push(makeContainsEdge(frame.parentSymbol.id, symbol.id));
      }
      pushChildren(stack, node, { parentSymbol: symbol, symbolPath, inMethodContainer: false, depth: frame.depth + 1 });
      continue;
    }

    pushChildren(stack, node, {
      parentSymbol: frame.parentSymbol,
      symbolPath: frame.symbolPath,
      inMethodContainer: frame.inMethodContainer || methodContainers.has(node.type),
      depth: frame.depth + 1,
    });
  }

  return { symbols, edges, diagnostics };
}

function pushChildren(stack: Frame[], node: SyntaxNode, template: Omit<Frame, "node">): void {
  // Reverse push so the walk visits children in source order — the ONLY order
  // that makes the output a function of the bytes.
  for (let i = node.namedChildCount - 1; i >= 0; i -= 1) {
    const child = node.namedChild(i);
    if (child !== null) stack.push({ ...template, node: child });
  }
}

function resolveKind(rule: DeclarationRule, node: SyntaxNode, frame: Frame): SymbolKind | "scope" {
  const declared = rule.kindOf === undefined ? rule.symbolKind : rule.kindOf(node);
  if (declared !== SymbolKind.Function) return declared;
  const enclosing = frame.parentSymbol?.kind;
  const insideType = enclosing === SymbolKind.Class || enclosing === SymbolKind.Interface;
  return insideType || (frame.inMethodContainer) ? SymbolKind.Method : SymbolKind.Function;
}

function extractName(strategy: NameStrategy, node: SyntaxNode): string | undefined {
  let raw: string | undefined;
  switch (strategy.kind) {
    case "field": {
      const child = node.childForFieldName(strategy.field);
      if (child === null) return undefined;
      if (strategy.types !== undefined && !strategy.types.includes(child.type)) return undefined;
      raw = child.text;
      break;
    }
    case "childType": {
      raw = node.namedChildren.find((child) => strategy.types.includes(child.type))?.text;
      break;
    }
    case "declarator": {
      let current: SyntaxNode | null = node.childForFieldName("declarator");
      while (current !== null) {
        const next: SyntaxNode | null = current.childForFieldName("declarator");
        if (next === null) break;
        current = next;
      }
      raw = current !== null && DECLARATOR_NAME_TYPES.has(current.type) ? current.text : undefined;
      break;
    }
    case "literal":
      raw = strategy.value;
      break;
    case "custom":
      raw = strategy.extract(node);
      break;
  }
  if (raw === undefined) return undefined;
  // A C++ qualified name (`Greeter::Greeter`) keeps its qualification as path
  // segments; `::` is the FQN's own separator and cannot appear inside a name.
  const name = raw.trim().replace(/::/gu, ".");
  if (name.length === 0 || name.length > MAX_NAME_LENGTH || /\s/u.test(name)) return undefined;
  return name;
}

interface MakeSymbolInput {
  readonly filePath: string;
  readonly content: string;
  readonly node: SyntaxNode;
  readonly rule: DeclarationRule;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly symbolPath: readonly string[];
  readonly parentSymbol: SymbolRecord | undefined;
}

function makeSymbol(input: MakeSymbolInput): SymbolRecord {
  const { content } = input;
  const node = spanNodeFor(input.node, input.rule);
  const offsets = offsetsFor(content);
  const startByte = offsets.byteOffsetAt(node.startIndex);
  const endByte = offsets.byteOffsetAt(node.endIndex);
  const fqName = buildFQName({ filePath: input.filePath, symbolPath: input.symbolPath });
  const docstring = leadingComment(node);
  // Visibility is a fact about the declaration node; the span may be its parent.
  const exported = input.rule.exported === undefined ? false : input.rule.exported(input.node);

  return {
    id: computeSymbolId({ filePath: input.filePath, fqName, kind: input.kind, startByte, endByte }),
    filePath: input.filePath,
    fqName,
    localName: input.name,
    kind: input.kind,
    signature: signatureOf(content, node, input.rule),
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startByte,
    endByte,
    ...(input.parentSymbol === undefined ? {} : { parentSymbolId: input.parentSymbol.id }),
    exported,
    ...(docstring === undefined ? {} : { docstring }),
  };
}

/** The node whose span the symbol records (see `DeclarationRule.spanFromParent`). */
function spanNodeFor(node: SyntaxNode, rule: DeclarationRule): SyntaxNode {
  if (rule.spanFromParent !== true) return node;
  const parent = node.parent;
  return parent !== null && parent.namedChildCount === 1 ? parent : node;
}

/**
 * A verbatim slice of the source: the declaration head up to its body (or up
 * to a comment that precedes the body), or the whole declaration when it is
 * one line, or its first line otherwise. Node offsets are UTF-16 indices into
 * `content`, so the slice is a STRING slice; the byte span above is what
 * slices the file's bytes.
 */
function signatureOf(content: string, node: SyntaxNode, rule: DeclarationRule): string {
  const declared = rule.spanFromParent === true && node.namedChildCount === 1 ? node.namedChild(0)! : node;
  const body = rule.bodyField === undefined ? undefined : declared.childForFieldName(rule.bodyField) ?? undefined;
  const bodyLike = body ?? declared.namedChildren.find((child) => BODY_NODE_TYPES.has(child.type));
  const nameEnd = firstNameEnd(declared);
  const leadingComment = declared.namedChildren.find((child) => COMMENT_NODE_TYPES.has(child.type)
    && child.startIndex >= nameEnd && (bodyLike === undefined || child.startIndex < bodyLike.startIndex));
  const end = leadingComment ?? bodyLike;
  if (end !== undefined && end.startIndex > node.startIndex) {
    return content.slice(node.startIndex, end.startIndex).trim();
  }
  const text = node.text;
  if (!text.includes("\n")) return text.trim();
  return text.slice(0, text.indexOf("\n")).trim();
}

/** Where the declaration's name ends, so a comment before it is not the cut point. */
function firstNameEnd(node: SyntaxNode): number {
  const name = node.childForFieldName("name");
  return name === null ? node.startIndex : name.endIndex;
}

/** The contiguous comment block ending on the line above the declaration. */
function leadingComment(node: SyntaxNode): string | undefined {
  const parts: string[] = [];
  let previous = node.previousNamedSibling;
  let expectedEndRow = node.startPosition.row - 1;
  while (previous !== null && COMMENT_NODE_TYPES.has(previous.type) && previous.endPosition.row >= expectedEndRow) {
    parts.unshift(previous.text.trim());
    expectedEndRow = previous.startPosition.row - 1;
    previous = previous.previousNamedSibling;
  }
  if (parts.length === 0) return undefined;
  const text = parts.join("\n");
  return text.length > MAX_DOCSTRING_LENGTH ? text.slice(0, MAX_DOCSTRING_LENGTH) : text;
}

function makeContainsEdge(srcSymbolId: string, dstSymbolId: string): EdgeRecord {
  return {
    id: createHash("sha256").update([srcSymbolId, dstSymbolId, EdgeType.Contains].join("\0")).digest("hex"),
    srcSymbolId,
    dstSymbolId,
    edgeType: EdgeType.Contains,
    confidence: 1,
  };
}

function collectDiagnostics(content: string, root: SyntaxNode): ParseDiagnostic[] {
  const diagnostics: ParseDiagnostic[] = [];
  if (!root.hasError) return diagnostics;
  const offsets = offsetsFor(content);
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.isError || node.isMissing) {
      diagnostics.push({
        message: node.isMissing ? `Missing ${node.type}` : "Syntax error",
        startLine: node.startPosition.row + 1,
        startByte: offsets.byteOffsetAt(node.startIndex),
      });
    }
    if (!node.hasError && !node.isError && !node.isMissing) continue;
    for (let i = node.childCount - 1; i >= 0; i -= 1) {
      const child = node.child(i);
      if (child !== null) stack.push(child);
    }
  }
  return diagnostics.sort((a, b) => (a.startByte ?? 0) - (b.startByte ?? 0));
}

/** A `LanguageParser` for one generic family. Loads nothing until first parse. */
export function createStructuralParser(language: Language): LanguageParser {
  const family = familyOf(language);
  if (family === undefined || family.parser !== "structural") {
    throw new Error(`${language} is not a structural language family`);
  }
  return {
    language,
    async parse(input) {
      return parseStructural(input, family);
    },
  };
}
