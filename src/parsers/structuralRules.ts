/**
 * Declaration rules for the generic tree-sitter families (M202).
 *
 * One entry per family: which syntax node kinds are declarations VTRACE models,
 * how each is named, and what symbol kind it maps to. The engine that applies
 * them is `structuralParser.ts`; nothing here walks a tree.
 *
 * RULES OF THE RULES (§17, §49)
 * -----------------------------
 *   - Only NAMED DECLARATIONS become symbols: functions, methods, classes and
 *     their kin, interfaces/traits/protocols, type aliases, and module-level
 *     constants/variables. Never identifiers, assignments, blocks, keys, or
 *     statements. A language with no such abstraction has no rules and yields
 *     zero symbols, which is the truthful answer.
 *   - Namespaces, modules, packages, `impl` blocks and extensions are SCOPES:
 *     they contribute a path segment to nested names and are not symbols,
 *     because VTRACE has no symbol kind for them and inventing one would be a
 *     representation change (A12), not breadth.
 *   - A function-kind declaration nested in a class-kind symbol (or in a
 *     method container such as a Rust `impl`) is a Method. This is the Python
 *     parser's rule applied uniformly.
 *   - No rule produces an import, call or reference edge.
 *
 * Node kind names were verified against each pinned grammar by parsing the
 * committed fixtures under benchmarks/.../fixtures/m202_language_families.
 */
import type Parser from "tree-sitter";

import { Language, SymbolKind } from "../domain/types";

type SyntaxNode = Parser.SyntaxNode;

export type NameStrategy =
  | { readonly kind: "field"; readonly field: string; readonly types?: readonly string[] }
  | { readonly kind: "childType"; readonly types: readonly string[] }
  | { readonly kind: "declarator" }
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "custom"; readonly extract: (node: SyntaxNode) => string | undefined };

export interface DeclarationRule {
  readonly nodeType: string;
  /** "scope" contributes a path segment and emits no symbol. */
  readonly symbolKind: SymbolKind | "scope";
  readonly name: NameStrategy;
  /** Only nodes for which this returns true match the rule. */
  readonly when?: (node: SyntaxNode) => boolean;
  /** Resolve the kind from the node when one node type covers several. */
  readonly kindOf?: (node: SyntaxNode) => SymbolKind | "scope";
  /** Field whose start ends the signature slice. Falls back to BODY_NODE_TYPES. */
  readonly bodyField?: string;
  /** Emit only when no symbol encloses the node (module-level constants). */
  readonly topLevelOnly?: boolean;
  /**
   * Span and signature come from the parent when the node is its only named
   * child: `let f x = …` is the declaration, not the binding inside it.
   */
  readonly spanFromParent?: boolean;
  readonly exported?: (node: SyntaxNode) => boolean;
}

export interface FamilyRules {
  readonly declarations: readonly DeclarationRule[];
  /** Node types whose enclosed function declarations are methods (Rust `impl`). */
  readonly methodContainers?: readonly string[];
}

/** Node kinds that start a declaration body in the pinned grammars. */
export const BODY_NODE_TYPES: ReadonlySet<string> = new Set([
  "statement_block", "class_body", "block", "compound_statement", "field_declaration_list",
  "declaration_list", "enum_body", "enum_variant_list", "interface_body", "body_statement",
  "template_body", "function_body", "protocol_body", "enum_class_body", "do_block",
  "class_declarations", "structure", "object_expression", "enum_declaration_list",
  "enumerator_list", "struct_declaration", "enum_declaration", "union_declaration",
  "column_definitions", "record_declaration", "variant_declaration", "class_body",
  "braced_expression", "implementation_definition", "data_constructors", "enum_member_declaration_list",
]);

/** Comment node kinds, for leading-documentation capture. */
export const COMMENT_NODE_TYPES: ReadonlySet<string> = new Set([
  "comment", "line_comment", "block_comment", "multiline_comment", "doc_comment",
  "documentation_comment", "haddock",
]);

const field = (name: string, types?: readonly string[]): NameStrategy => ({ kind: "field", field: name, ...(types === undefined ? {} : { types }) });
const childType = (...types: string[]): NameStrategy => ({ kind: "childType", types });
const declarator: NameStrategy = { kind: "declarator" };

const hasAnonymousChild = (node: SyntaxNode, text: string): boolean => {
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i);
    if (child !== null && !child.isNamed && child.text === text) return true;
  }
  return false;
};
const hasNamedChildOfType = (node: SyntaxNode, types: readonly string[]): boolean =>
  node.namedChildren.some((child) => types.includes(child.type));
const firstNamedChildOfType = (node: SyntaxNode, types: readonly string[]): SyntaxNode | undefined =>
  node.namedChildren.find((child) => types.includes(child.type));
const modifierIncludes = (node: SyntaxNode, modifierTypes: readonly string[], word: string): boolean =>
  node.namedChildren.some((child) => modifierTypes.includes(child.type) && child.text.split(/\s+/u).includes(word));
const startsUpperCase = (name: string): boolean => /^[A-Z]/u.test(name);

// -------------------------------------------------------------- JavaScript
const javascript: FamilyRules = {
  declarations: [
    { nodeType: "function_declaration", symbolKind: SymbolKind.Function, name: field("name"), bodyField: "body",
      exported: (n) => n.parent?.type === "export_statement" },
    { nodeType: "generator_function_declaration", symbolKind: SymbolKind.Function, name: field("name"), bodyField: "body",
      exported: (n) => n.parent?.type === "export_statement" },
    { nodeType: "class_declaration", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body",
      exported: (n) => n.parent?.type === "export_statement" },
    { nodeType: "method_definition", symbolKind: SymbolKind.Method, name: field("name", ["property_identifier"]), bodyField: "body" },
    { nodeType: "variable_declarator", symbolKind: SymbolKind.ModuleVariable, name: field("name", ["identifier"]), topLevelOnly: true,
      when: (n) => n.parent?.type === "lexical_declaration" || n.parent?.type === "variable_declaration",
      kindOf: (n) => {
        const value = n.childForFieldName("value");
        if (value !== null && (value.type === "arrow_function" || value.type === "function_expression")) return SymbolKind.Function;
        return n.parent?.text.startsWith("const ") ? SymbolKind.ModuleConstant : SymbolKind.ModuleVariable;
      },
      exported: (n) => n.parent?.parent?.type === "export_statement" },
  ],
};

// ---------------------------------------------------------------------- Go
const go: FamilyRules = {
  declarations: [
    { nodeType: "function_declaration", symbolKind: SymbolKind.Function, name: field("name"), bodyField: "body",
      exported: (n) => startsUpperCase(n.childForFieldName("name")?.text ?? "") },
    { nodeType: "method_declaration", symbolKind: SymbolKind.Method, name: field("name"), bodyField: "body",
      exported: (n) => startsUpperCase(n.childForFieldName("name")?.text ?? "") },
    { nodeType: "type_spec", symbolKind: SymbolKind.TypeAlias, name: field("name"), spanFromParent: true,
      kindOf: (n) => {
        const type = n.childForFieldName("type")?.type;
        return type === "struct_type" ? SymbolKind.Class : type === "interface_type" ? SymbolKind.Interface : SymbolKind.TypeAlias;
      },
      exported: (n) => startsUpperCase(n.childForFieldName("name")?.text ?? "") },
    { nodeType: "type_alias", symbolKind: SymbolKind.TypeAlias, name: field("name"), spanFromParent: true,
      exported: (n) => startsUpperCase(n.childForFieldName("name")?.text ?? "") },
    { nodeType: "const_spec", symbolKind: SymbolKind.ModuleConstant, name: field("name"), topLevelOnly: true, spanFromParent: true,
      exported: (n) => startsUpperCase(n.childForFieldName("name")?.text ?? "") },
    { nodeType: "var_spec", symbolKind: SymbolKind.ModuleVariable, name: field("name"), topLevelOnly: true, spanFromParent: true,
      exported: (n) => startsUpperCase(n.childForFieldName("name")?.text ?? "") },
  ],
};

// -------------------------------------------------------------------- Rust
const rustVisible = (n: SyntaxNode) => hasNamedChildOfType(n, ["visibility_modifier"]);
const rust: FamilyRules = {
  methodContainers: ["impl_item", "trait_item"],
  declarations: [
    { nodeType: "function_item", symbolKind: SymbolKind.Function, name: field("name"), bodyField: "body", exported: rustVisible },
    { nodeType: "function_signature_item", symbolKind: SymbolKind.Function, name: field("name"), exported: rustVisible },
    { nodeType: "struct_item", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body", exported: rustVisible },
    { nodeType: "enum_item", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body", exported: rustVisible },
    { nodeType: "union_item", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body", exported: rustVisible },
    { nodeType: "trait_item", symbolKind: SymbolKind.Interface, name: field("name"), bodyField: "body", exported: rustVisible },
    { nodeType: "type_item", symbolKind: SymbolKind.TypeAlias, name: field("name"), exported: rustVisible },
    { nodeType: "const_item", symbolKind: SymbolKind.ModuleConstant, name: field("name"), topLevelOnly: true, exported: rustVisible },
    { nodeType: "static_item", symbolKind: SymbolKind.ModuleVariable, name: field("name"), topLevelOnly: true, exported: rustVisible },
    { nodeType: "mod_item", symbolKind: "scope", name: field("name") },
    // `impl Point { … }` / `impl Trait for Point { … }`: the methods belong to
    // the type, so the block is a scope named by its type and never a symbol.
    { nodeType: "impl_item", symbolKind: "scope", name: field("type") },
  ],
};

// -------------------------------------------------------------------- Java
const javaPublic = (n: SyntaxNode) => modifierIncludes(n, ["modifiers"], "public");
const java: FamilyRules = {
  declarations: [
    { nodeType: "class_declaration", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body", exported: javaPublic },
    { nodeType: "enum_declaration", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body", exported: javaPublic },
    { nodeType: "record_declaration", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body", exported: javaPublic },
    { nodeType: "interface_declaration", symbolKind: SymbolKind.Interface, name: field("name"), bodyField: "body", exported: javaPublic },
    { nodeType: "annotation_type_declaration", symbolKind: SymbolKind.Interface, name: field("name"), bodyField: "body", exported: javaPublic },
    { nodeType: "method_declaration", symbolKind: SymbolKind.Method, name: field("name"), bodyField: "body", exported: javaPublic },
    { nodeType: "constructor_declaration", symbolKind: SymbolKind.Method, name: field("name"), bodyField: "body", exported: javaPublic },
  ],
};

// ---------------------------------------------------------------------- C#
const csharpPublic = (n: SyntaxNode) => modifierIncludes(n, ["modifier"], "public");
const csharp: FamilyRules = {
  declarations: [
    { nodeType: "class_declaration", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body", exported: csharpPublic },
    { nodeType: "struct_declaration", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body", exported: csharpPublic },
    { nodeType: "enum_declaration", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body", exported: csharpPublic },
    { nodeType: "record_declaration", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body", exported: csharpPublic },
    { nodeType: "record_struct_declaration", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body", exported: csharpPublic },
    { nodeType: "interface_declaration", symbolKind: SymbolKind.Interface, name: field("name"), bodyField: "body", exported: csharpPublic },
    { nodeType: "delegate_declaration", symbolKind: SymbolKind.TypeAlias, name: field("name"), exported: csharpPublic },
    { nodeType: "method_declaration", symbolKind: SymbolKind.Method, name: field("name"), bodyField: "body", exported: csharpPublic },
    { nodeType: "constructor_declaration", symbolKind: SymbolKind.Method, name: field("name"), bodyField: "body", exported: csharpPublic },
    { nodeType: "namespace_declaration", symbolKind: "scope", name: field("name") },
    { nodeType: "file_scoped_namespace_declaration", symbolKind: "scope", name: field("name") },
  ],
};

// ------------------------------------------------------------------- C/C++
const cLike: readonly DeclarationRule[] = [
  { nodeType: "function_definition", symbolKind: SymbolKind.Function, name: declarator, bodyField: "body" },
  { nodeType: "struct_specifier", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body",
    when: (n) => n.childForFieldName("body") !== null },
  { nodeType: "union_specifier", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body",
    when: (n) => n.childForFieldName("body") !== null },
  { nodeType: "enum_specifier", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body",
    when: (n) => n.childForFieldName("body") !== null },
  { nodeType: "type_definition", symbolKind: SymbolKind.TypeAlias, name: declarator },
];
const c: FamilyRules = { declarations: cLike };
const cpp: FamilyRules = {
  declarations: [
    ...cLike,
    { nodeType: "class_specifier", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body",
      when: (n) => n.childForFieldName("body") !== null },
    { nodeType: "namespace_definition", symbolKind: "scope", name: field("name") },
  ],
};

// -------------------------------------------------------------------- Ruby
const ruby: FamilyRules = {
  declarations: [
    { nodeType: "module", symbolKind: "scope", name: field("name", ["constant", "scope_resolution"]) },
    { nodeType: "class", symbolKind: SymbolKind.Class, name: field("name", ["constant", "scope_resolution"]), bodyField: "body" },
    { nodeType: "method", symbolKind: SymbolKind.Function, name: field("name"), bodyField: "body" },
    { nodeType: "singleton_method", symbolKind: SymbolKind.Method, name: field("name"), bodyField: "body" },
  ],
};

// ------------------------------------------------------------------ Kotlin
const kotlin: FamilyRules = {
  declarations: [
    { nodeType: "class_declaration", symbolKind: SymbolKind.Class, name: field("name"),
      kindOf: (n) => (hasAnonymousChild(n, "interface") ? SymbolKind.Interface : SymbolKind.Class) },
    { nodeType: "object_declaration", symbolKind: SymbolKind.Class, name: field("name") },
    { nodeType: "function_declaration", symbolKind: SymbolKind.Function, name: field("name") },
  ],
};

// ------------------------------------------------------------------- Scala
const scala: FamilyRules = {
  declarations: [
    { nodeType: "class_definition", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body" },
    { nodeType: "object_definition", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body" },
    { nodeType: "trait_definition", symbolKind: SymbolKind.Interface, name: field("name"), bodyField: "body" },
    { nodeType: "function_definition", symbolKind: SymbolKind.Function, name: field("name"), bodyField: "body" },
    { nodeType: "function_declaration", symbolKind: SymbolKind.Function, name: field("name") },
  ],
};

// ------------------------------------------------------------------- Swift
const swiftKeyword = (n: SyntaxNode): string => {
  for (let i = 0; i < n.childCount; i += 1) {
    const child = n.child(i);
    if (child !== null && !child.isNamed) return child.text;
  }
  return "";
};
const swift: FamilyRules = {
  declarations: [
    { nodeType: "class_declaration", symbolKind: "scope", name: field("name"), when: (n) => swiftKeyword(n) === "extension" },
    { nodeType: "class_declaration", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body" },
    { nodeType: "protocol_declaration", symbolKind: SymbolKind.Interface, name: field("name"), bodyField: "body" },
    { nodeType: "function_declaration", symbolKind: SymbolKind.Function, name: field("name"), bodyField: "body" },
    { nodeType: "protocol_function_declaration", symbolKind: SymbolKind.Function, name: field("name") },
    { nodeType: "init_declaration", symbolKind: SymbolKind.Method, name: { kind: "literal", value: "init" }, bodyField: "body" },
    { nodeType: "typealias_declaration", symbolKind: SymbolKind.TypeAlias, name: field("name") },
  ],
};

// -------------------------------------------------------------------- Dart
const dart: FamilyRules = {
  declarations: [
    { nodeType: "class_definition", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body" },
    { nodeType: "mixin_declaration", symbolKind: SymbolKind.Class, name: childType("identifier") },
    { nodeType: "enum_declaration", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body" },
    { nodeType: "extension_declaration", symbolKind: "scope", name: field("name") },
    { nodeType: "type_alias", symbolKind: SymbolKind.TypeAlias, name: childType("type_identifier") },
    { nodeType: "function_signature", symbolKind: SymbolKind.Function, name: field("name") },
    { nodeType: "constructor_signature", symbolKind: SymbolKind.Method, name: field("name") },
  ],
};

// ------------------------------------------------------------------ Elixir
const ELIXIR_DEFINERS = new Set(["def", "defp", "defmacro", "defmacrop", "defguard", "defguardp"]);
const elixirTarget = (n: SyntaxNode): string => n.childForFieldName("target")?.text ?? "";
const elixirDefinedName = (n: SyntaxNode): string | undefined => {
  const first = firstNamedChildOfType(n, ["arguments"])?.namedChildren[0];
  if (first === undefined) return undefined;
  if (first.type === "call") return first.childForFieldName("target")?.text;
  if (first.type === "identifier" || first.type === "alias") return first.text;
  if (first.type === "binary_operator") {
    // `def name(args) when guard` parses the guard as a binary operator.
    const left = first.childForFieldName("left");
    return left?.type === "call" ? left.childForFieldName("target")?.text : left?.text;
  }
  return undefined;
};
const elixir: FamilyRules = {
  declarations: [
    { nodeType: "call", symbolKind: "scope", name: { kind: "custom", extract: elixirDefinedName },
      when: (n) => elixirTarget(n) === "defmodule" },
    { nodeType: "call", symbolKind: SymbolKind.Function, name: { kind: "custom", extract: elixirDefinedName },
      when: (n) => ELIXIR_DEFINERS.has(elixirTarget(n)) },
  ],
};

// ----------------------------------------------------------------- Haskell
const haskell: FamilyRules = {
  declarations: [
    { nodeType: "function", symbolKind: SymbolKind.Function, name: field("name"), bodyField: "match" },
    { nodeType: "data_type", symbolKind: SymbolKind.Class, name: field("name") },
    { nodeType: "newtype", symbolKind: SymbolKind.Class, name: field("name") },
    { nodeType: "type_synomym", symbolKind: SymbolKind.TypeAlias, name: field("name") },
    { nodeType: "class", symbolKind: SymbolKind.Interface, name: field("name"), bodyField: "declarations" },
  ],
};

// ------------------------------------------------------------------- OCaml
const ocaml: FamilyRules = {
  declarations: [
    { nodeType: "let_binding", symbolKind: SymbolKind.Function, name: field("pattern", ["value_name"]), bodyField: "body",
      topLevelOnly: true, spanFromParent: true, when: (n) => n.parent?.type === "value_definition",
      kindOf: (n) => (hasNamedChildOfType(n, ["parameter"]) ? SymbolKind.Function : SymbolKind.ModuleVariable) },
    { nodeType: "type_binding", symbolKind: SymbolKind.TypeAlias, name: field("name"), bodyField: "body", spanFromParent: true,
      kindOf: (n) => {
        const body = n.childForFieldName("body")?.type;
        return body === "record_declaration" || body === "variant_declaration" ? SymbolKind.Class : SymbolKind.TypeAlias;
      } },
    { nodeType: "module_binding", symbolKind: "scope", name: field("name") },
    { nodeType: "class_binding", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body", spanFromParent: true },
    { nodeType: "method_definition", symbolKind: SymbolKind.Method, name: field("name"), bodyField: "body" },
    { nodeType: "value_specification", symbolKind: SymbolKind.Function, name: childType("value_name") },
  ],
};

// --------------------------------------------------------------------- Lua
const lua: FamilyRules = {
  declarations: [
    { nodeType: "function_declaration", symbolKind: SymbolKind.Function, name: field("name"), bodyField: "body",
      kindOf: (n) => (n.childForFieldName("name")?.type === "method_index_expression" ? SymbolKind.Method : SymbolKind.Function) },
  ],
};

// ----------------------------------------------------------------------- R
const R_ASSIGNMENT = new Set(["<-", "=", "<<-"]);
const r: FamilyRules = {
  declarations: [
    { nodeType: "binary_operator", symbolKind: SymbolKind.Function, name: field("lhs", ["identifier"]), topLevelOnly: true,
      when: (n) => n.childForFieldName("rhs")?.type === "function_definition"
        && n.childForFieldName("lhs")?.type === "identifier"
        && R_ASSIGNMENT.has(n.childForFieldName("operator")?.text ?? "") },
  ],
};

// --------------------------------------------------------------------- PHP
const phpPublic = (n: SyntaxNode) => modifierIncludes(n, ["visibility_modifier"], "public");
const php: FamilyRules = {
  declarations: [
    { nodeType: "function_definition", symbolKind: SymbolKind.Function, name: field("name"), bodyField: "body" },
    { nodeType: "class_declaration", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body" },
    { nodeType: "trait_declaration", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body" },
    { nodeType: "enum_declaration", symbolKind: SymbolKind.Class, name: field("name"), bodyField: "body" },
    { nodeType: "interface_declaration", symbolKind: SymbolKind.Interface, name: field("name"), bodyField: "body" },
    { nodeType: "method_declaration", symbolKind: SymbolKind.Method, name: field("name"), bodyField: "body", exported: phpPublic },
    { nodeType: "namespace_definition", symbolKind: "scope", name: field("name") },
  ],
};

// --------------------------------------------------------------------- Zig
const ZIG_CONTAINERS = ["struct_declaration", "enum_declaration", "union_declaration", "opaque_declaration"];
const zigPublic = (n: SyntaxNode) => hasAnonymousChild(n, "pub");
const zig: FamilyRules = {
  declarations: [
    { nodeType: "function_declaration", symbolKind: SymbolKind.Function, name: field("name"), bodyField: "body", exported: zigPublic },
    { nodeType: "variable_declaration", symbolKind: SymbolKind.Class, name: childType("identifier"), exported: zigPublic,
      when: (n) => hasNamedChildOfType(n, ZIG_CONTAINERS) },
    { nodeType: "variable_declaration", symbolKind: SymbolKind.ModuleConstant, name: childType("identifier"), topLevelOnly: true,
      exported: zigPublic, when: (n) => n.parent?.type === "source_file" && !hasNamedChildOfType(n, ZIG_CONTAINERS) },
  ],
};

// ------------------------------------------------------------- Objective-C
const objectiveC: FamilyRules = {
  declarations: [
    { nodeType: "class_interface", symbolKind: SymbolKind.Class, name: childType("identifier") },
    { nodeType: "class_implementation", symbolKind: SymbolKind.Class, name: childType("identifier") },
    { nodeType: "category_interface", symbolKind: "scope", name: childType("identifier") },
    { nodeType: "category_implementation", symbolKind: "scope", name: childType("identifier") },
    { nodeType: "protocol_declaration", symbolKind: SymbolKind.Interface, name: childType("identifier") },
    { nodeType: "method_declaration", symbolKind: SymbolKind.Method, name: childType("identifier") },
    { nodeType: "method_definition", symbolKind: SymbolKind.Method, name: childType("identifier") },
    { nodeType: "function_definition", symbolKind: SymbolKind.Function, name: declarator, bodyField: "body" },
  ],
};

// -------------------------------------------------------------------- Bash
const bash: FamilyRules = {
  declarations: [
    { nodeType: "function_definition", symbolKind: SymbolKind.Function, name: field("name"), bodyField: "body" },
  ],
};

// --------------------------------------------------------------------- SQL
const sqlObjectName = (n: SyntaxNode): string | undefined =>
  firstNamedChildOfType(n, ["object_reference"])?.childForFieldName("name")?.text;
const sql: FamilyRules = {
  declarations: [
    { nodeType: "create_table", symbolKind: SymbolKind.Class, name: { kind: "custom", extract: sqlObjectName } },
    { nodeType: "create_view", symbolKind: SymbolKind.Class, name: { kind: "custom", extract: sqlObjectName } },
    { nodeType: "create_function", symbolKind: SymbolKind.Function, name: { kind: "custom", extract: sqlObjectName } },
    { nodeType: "create_procedure", symbolKind: SymbolKind.Function, name: { kind: "custom", extract: sqlObjectName } },
  ],
};

// ----------------------------------------------------------------- Clojure
const CLOJURE_FORMS: Readonly<Record<string, SymbolKind | "scope">> = {
  ns: "scope",
  defn: SymbolKind.Function, "defn-": SymbolKind.Function, defmacro: SymbolKind.Function, defmulti: SymbolKind.Function,
  def: SymbolKind.ModuleVariable, defonce: SymbolKind.ModuleVariable,
  defprotocol: SymbolKind.Interface, definterface: SymbolKind.Interface,
  defrecord: SymbolKind.Class, deftype: SymbolKind.Class,
};
const clojureHead = (n: SyntaxNode): string => {
  const first = n.namedChildren[0];
  return first?.type === "sym_lit" ? first.text : "";
};
const clojure: FamilyRules = {
  declarations: [
    { nodeType: "list_lit", symbolKind: SymbolKind.Function, when: (n) => CLOJURE_FORMS[clojureHead(n)] !== undefined,
      kindOf: (n) => CLOJURE_FORMS[clojureHead(n)]!,
      name: { kind: "custom", extract: (n) => {
        const second = n.namedChildren[1];
        return second?.type === "sym_lit" ? second.text : undefined;
      } } },
  ],
};

/** Families with no rules parse for parse truth and yield zero symbols (§16). */
const NO_DECLARATION_MODEL: FamilyRules = { declarations: [] };

export const STRUCTURAL_RULES: Readonly<Partial<Record<Language, FamilyRules>>> = {
  [Language.JavaScript]: javascript,
  [Language.Go]: go,
  [Language.Rust]: rust,
  [Language.Java]: java,
  [Language.CSharp]: csharp,
  [Language.C]: c,
  [Language.Cpp]: cpp,
  [Language.Ruby]: ruby,
  [Language.Kotlin]: kotlin,
  [Language.Scala]: scala,
  [Language.Swift]: swift,
  [Language.Dart]: dart,
  [Language.Elixir]: elixir,
  [Language.Haskell]: haskell,
  [Language.OCaml]: ocaml,
  [Language.Lua]: lua,
  [Language.R]: r,
  [Language.Php]: php,
  [Language.Zig]: zig,
  [Language.ObjectiveC]: objectiveC,
  [Language.Bash]: bash,
  [Language.Sql]: sql,
  [Language.Clojure]: clojure,
  [Language.Html]: NO_DECLARATION_MODEL,
  [Language.Css]: NO_DECLARATION_MODEL,
  [Language.Json]: NO_DECLARATION_MODEL,
  [Language.Yaml]: NO_DECLARATION_MODEL,
};
