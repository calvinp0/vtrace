/**
 * The language-family table: the ONE place that says which `Language` members
 * exist as families, what files belong to them, what parses them and how deep
 * that parse goes (M202).
 *
 * WHY A TABLE
 * -----------
 * Breadth is counted in families, and a family is only real if four things agree:
 * the enum member, the extension mapping, the registered parser and the parser's
 * actual capability. Before M202 those lived in four files and disagreed — Yaml
 * and Toml were detected and document-indexed with no parser, JavaScript was
 * detected with no parser, Go and Rust were enum members with nothing behind
 * them. The table makes each family one row, and `languageDetection.ts` and
 * `createDefaultParserRegistry` are DERIVED from it rather than maintained beside it.
 *
 * WHAT A ROW DOES NOT DO
 * ----------------------
 * It does not add a member to the count. The count is the parser registry's
 * `registeredLanguages()` intersected with the enum (frozen M197A control F7);
 * a row whose grammar artefact is missing on this machine is reported by
 * `describeParserFamilies` as unavailable and is NOT registered, so it cannot be
 * counted. A row with `parser: "none"` (Toml) is a detection rule and never counts.
 *
 * CAPABILITY TIERS (§24)
 * ----------------------
 *   DEEP_GRAPH            symbols + imports + calls + references (Python, TypeScript, Cython)
 *   STRUCTURAL            declarations, members and contains edges from a syntax tree;
 *                         NO import/call/reference edges — none are derivable from
 *                         syntax alone and none are invented (§49)
 *   DOCUMENT              parsed for parse truth, indexed as searchable document chunks,
 *                         no symbols (YAML)
 *   PARSED_NO_STRUCTURE   parsed for parse truth only; the syntax has no declaration
 *                         abstraction VTRACE models, so zero symbols (HTML, CSS, JSON)
 *
 * A later consumer must read the tier before assuming a call graph exists.
 */
import { Language } from "../domain/types";

export type FamilyTier = "DEEP_GRAPH" | "STRUCTURAL" | "DOCUMENT" | "PARSED_NO_STRUCTURE";

export type FamilyParserKind = "typescript" | "python" | "cython" | "structural" | "none";

export interface GrammarSpec {
  /** npm package that ships the grammar. Pinned exactly in package.json (§43). */
  readonly module: string;
  /** Named export when the package ships several grammars (`ocaml`, `php`). */
  readonly exportName?: string;
  /** Per-extension export override, e.g. OCaml interface files. */
  readonly exportByExtension?: Readonly<Record<string, string>>;
  /**
   * How the native binary arrives: shipped in the package for this platform, or
   * compiled by `scripts/build_tree_sitter_grammars.ts` at install time because
   * the package ships sources only. Audit metadata; the loader checks the disk.
   */
  readonly artifact: "prebuilt" | "compiled";
  /** SPDX licence of the grammar package, recorded for the dependency audit (§14). */
  readonly license: string;
}

export interface LanguageFamilyDescriptor {
  readonly language: Language;
  readonly displayName: string;
  /** The VEXP README name this family answers to, or null when VEXP lists no such family. */
  readonly vexpRow: string | null;
  /** Lower-cased, dot-prefixed. The first family claiming an extension owns it. */
  readonly extensions: readonly string[];
  readonly tier: FamilyTier;
  readonly technology: string;
  readonly parser: FamilyParserKind;
  readonly grammar?: GrammarSpec;
  /** Coordinate system the parser reports spans in, before the boundary converts them. */
  readonly nativeCoordinates: "UTF-16 code units + 0-based row/column" | "UTF-8 bytes + 1-based lines" | "n/a";
}

const TS = "tree-sitter 0.21.1 native binding";

export const LANGUAGE_FAMILIES: readonly LanguageFamilyDescriptor[] = [
  // ---------------------------------------------------------------- deep
  { language: Language.TypeScript, displayName: "TypeScript", vexpRow: "TypeScript", extensions: [".ts", ".tsx"],
    tier: "DEEP_GRAPH", technology: TS, parser: "typescript",
    grammar: { module: "tree-sitter-typescript", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.Python, displayName: "Python", vexpRow: "Python", extensions: [".py"],
    tier: "DEEP_GRAPH", technology: "CPython ast subprocess (batched, M200)", parser: "python",
    nativeCoordinates: "UTF-8 bytes + 1-based lines" },
  { language: Language.Cython, displayName: "Cython", vexpRow: null, extensions: [".pyx", ".pxd", ".pxi"],
    tier: "DEEP_GRAPH", technology: "tokenizer subprocess", parser: "cython",
    nativeCoordinates: "UTF-8 bytes + 1-based lines" },
  // ---------------------------------------------------------- structural
  { language: Language.JavaScript, displayName: "JavaScript", vexpRow: "JavaScript", extensions: [".js", ".jsx", ".mjs", ".cjs"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-javascript", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.Go, displayName: "Go", vexpRow: "Go", extensions: [".go"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-go", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.Rust, displayName: "Rust", vexpRow: "Rust", extensions: [".rs"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-rust", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.Java, displayName: "Java", vexpRow: "Java", extensions: [".java"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-java", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.CSharp, displayName: "C#", vexpRow: "C#", extensions: [".cs"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-c-sharp", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.C, displayName: "C", vexpRow: "C", extensions: [".c", ".h"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-c", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.Cpp, displayName: "C++", vexpRow: "C++", extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-cpp", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.Ruby, displayName: "Ruby", vexpRow: "Ruby", extensions: [".rb"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-ruby", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.Kotlin, displayName: "Kotlin", vexpRow: "Kotlin", extensions: [".kt", ".kts"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "@tree-sitter-grammars/tree-sitter-kotlin", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.Scala, displayName: "Scala", vexpRow: "Scala", extensions: [".scala", ".sc"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-scala", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.Swift, displayName: "Swift", vexpRow: "Swift", extensions: [".swift"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-swift", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.Dart, displayName: "Dart", vexpRow: "Dart", extensions: [".dart"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-dart-orchard", artifact: "compiled", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.Elixir, displayName: "Elixir", vexpRow: "Elixir", extensions: [".ex", ".exs"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-elixir", artifact: "prebuilt", license: "Apache-2.0" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.Haskell, displayName: "Haskell", vexpRow: "Haskell", extensions: [".hs"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-haskell", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.OCaml, displayName: "OCaml", vexpRow: "OCaml", extensions: [".ml", ".mli"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-ocaml", exportName: "ocaml", exportByExtension: { ".mli": "interface" },
      artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.Lua, displayName: "Lua", vexpRow: "Lua", extensions: [".lua"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "@tree-sitter-grammars/tree-sitter-lua", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.R, displayName: "R", vexpRow: "R", extensions: [".r"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "@davisvaughan/tree-sitter-r", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.Php, displayName: "PHP", vexpRow: "PHP", extensions: [".php"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-php", exportName: "php", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.Zig, displayName: "Zig", vexpRow: "Zig", extensions: [".zig"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "@tree-sitter-grammars/tree-sitter-zig", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.ObjectiveC, displayName: "Objective-C", vexpRow: "Objective-C", extensions: [".m"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-objc", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.Bash, displayName: "Bash/Shell", vexpRow: "Bash/Shell", extensions: [".sh", ".bash"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-bash", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.Sql, displayName: "SQL", vexpRow: "SQL", extensions: [".sql"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "@derekstride/tree-sitter-sql", artifact: "compiled", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.Clojure, displayName: "Clojure", vexpRow: "Clojure", extensions: [".clj", ".cljs", ".cljc"],
    tier: "STRUCTURAL", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-clojure-orchard", artifact: "compiled", license: "CC0-1.0" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  // ---------------------------------------------- parsed, no declaration model
  { language: Language.Html, displayName: "HTML", vexpRow: "HTML/CSS", extensions: [".html", ".htm"],
    tier: "PARSED_NO_STRUCTURE", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-html", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.Css, displayName: "CSS", vexpRow: "HTML/CSS", extensions: [".css"],
    tier: "PARSED_NO_STRUCTURE", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-css", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  { language: Language.Json, displayName: "JSON", vexpRow: "YAML/JSON", extensions: [".json"],
    tier: "PARSED_NO_STRUCTURE", technology: TS, parser: "structural",
    grammar: { module: "tree-sitter-json", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  // ------------------------------------------------------------ documents
  { language: Language.Yaml, displayName: "YAML", vexpRow: "YAML/JSON", extensions: [".yml", ".yaml"],
    tier: "DOCUMENT", technology: TS, parser: "structural",
    grammar: { module: "@tree-sitter-grammars/tree-sitter-yaml", artifact: "prebuilt", license: "MIT" },
    nativeCoordinates: "UTF-16 code units + 0-based row/column" },
  // Detection rule + document indexer only. Not parser-backed, never counted.
  // Left as-is deliberately (§41): the frozen claim was closed without it.
  { language: Language.Toml, displayName: "TOML", vexpRow: null, extensions: [".toml"],
    tier: "DOCUMENT", technology: "line-oriented document chunker (no parser)", parser: "none",
    nativeCoordinates: "n/a" },
];

const BY_LANGUAGE: ReadonlyMap<Language, LanguageFamilyDescriptor> = new Map(
  LANGUAGE_FAMILIES.map((family) => [family.language, family]),
);

export function familyOf(language: Language): LanguageFamilyDescriptor | undefined {
  return BY_LANGUAGE.get(language);
}

/**
 * Canonical extension → family map. Built once, and refuses to build if two
 * families claim the same extension: an alias that lands on two families is how
 * a count gets inflated by accident (control F2).
 */
export const EXTENSION_TO_LANGUAGE: ReadonlyMap<string, Language> = (() => {
  const map = new Map<string, Language>();
  for (const family of LANGUAGE_FAMILIES) {
    for (const extension of family.extensions) {
      if (extension !== extension.toLowerCase() || !extension.startsWith(".")) {
        throw new Error(`language family ${family.language} declares a non-canonical extension ${extension}`);
      }
      const owner = map.get(extension);
      if (owner !== undefined && owner !== family.language) {
        throw new Error(`extension ${extension} is claimed by both ${owner} and ${family.language}`);
      }
      map.set(extension, family.language);
    }
  }
  return map;
})();

/** Families whose files the indexer parses through the registry (everything but `parser: "none"`). */
export function isParserBackedFamily(language: Language): boolean {
  const family = BY_LANGUAGE.get(language);
  return family !== undefined && family.parser !== "none";
}

/** The generic tree-sitter families, in table order. */
export function structuralFamilies(): readonly LanguageFamilyDescriptor[] {
  return LANGUAGE_FAMILIES.filter((family) => family.parser === "structural");
}
