import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "bun:test";

import { Language, SymbolKind, type ParseResult, type SymbolRecord } from "../domain/types";
import { detectLanguage } from "../fs/languageDetection";
import { createDefaultParserRegistry } from "../indexer/indexProject";
import { ParserErrorCode } from "./errors";
import { LANGUAGE_FAMILIES, familyOf, structuralFamilies } from "./languageFamilies";
import { createStructuralParser, parseStructural } from "./structuralParser";
import { STRUCTURAL_RULES } from "./structuralRules";
import { createOffsetTranslator } from "./treeSitterSource";

const FIXTURES = path.resolve(import.meta.dir, "../../benchmarks/stage5_vexp_swe_bench_smoke/fixtures/m202_language_families");

function fixture(language: Language, name: "valid" | "malformed"): { path: string; content: string } {
  const dir = path.join(FIXTURES, language);
  const file = readdirSync(dir).find((entry) => entry.startsWith(`${name}.`));
  assert.ok(file !== undefined, `no ${name} fixture for ${language}`);
  return { path: `${language}/${file}`, content: readFileSync(path.join(dir, file), "utf8") };
}

async function parseFixture(language: Language, name: "valid" | "malformed" = "valid"): Promise<ParseResult> {
  const registry = createDefaultParserRegistry([]);
  const file = fixture(language, name);
  assert.equal(detectLanguage(file.path), language, `${file.path} must detect as ${language}`);
  const parsed = await registry.parse({ path: file.path, content: file.content, language });
  assert.ok(parsed.ok, `${file.path} failed: ${parsed.ok ? "" : parsed.error.message}`);
  return parsed.result;
}

const names = (symbols: readonly SymbolRecord[]) => symbols.map((s) => s.localName);
const local = (symbols: readonly SymbolRecord[], name: string) => {
  const found = symbols.find((s) => s.localName === name);
  assert.ok(found !== undefined, `expected a symbol named ${name} in ${names(symbols).join(", ")}`);
  return found;
};

// ----------------------------------------------------------------- registry

test("every structural family is registered by the default registry and reachable through it", async () => {
  const registry = createDefaultParserRegistry([]);
  const registered = new Set(registry.registeredLanguages());
  for (const family of structuralFamilies()) {
    assert.ok(registered.has(family.language), `${family.language} is not registered`);
    assert.ok(STRUCTURAL_RULES[family.language] !== undefined, `${family.language} has no rule entry`);
  }
  // The deep adapters keep their own families; none is routed to the generic walk (F10).
  assert.equal(familyOf(Language.TypeScript)?.parser, "typescript");
  assert.equal(familyOf(Language.Python)?.parser, "python");
  assert.equal(familyOf(Language.Cython)?.parser, "cython");
  assert.throws(() => createStructuralParser(Language.TypeScript), /not a structural language family/u);
  assert.throws(() => createStructuralParser(Language.Toml), /not a structural language family/u);
});

test("a structural parser refuses input labelled with another family", async () => {
  const parser = createStructuralParser(Language.Go);
  await assert.rejects(
    parser.parse({ path: "x.rs", content: "fn main() {}", language: Language.Rust }),
    (error: any) => error.code === ParserErrorCode.UnsupportedLanguage,
  );
});

// --------------------------------------------------------- per-family truth

interface Expectation {
  readonly language: Language;
  /** Declarations the valid fixture must yield, with their kinds. */
  readonly expect: readonly [string, SymbolKind][];
  /** A member that must be contained by a parent. */
  readonly member?: readonly [parent: string, child: string];
  /** A name the fixture deliberately does NOT declare (prototype, statement, key). */
  readonly absent?: readonly string[];
}

const EXPECTATIONS: readonly Expectation[] = [
  { language: Language.JavaScript, expect: [["add", SymbolKind.Function], ["Counter", SymbolKind.Class], ["increment", SymbolKind.Method], ["answer", SymbolKind.ModuleConstant]],
    member: ["Counter", "increment"], absent: ["helper"] },
  { language: Language.Go, expect: [["Greeter", SymbolKind.Class], ["Hello", SymbolKind.Method], ["Shape", SymbolKind.Interface], ["ID", SymbolKind.TypeAlias], ["Limit", SymbolKind.ModuleConstant], ["counter", SymbolKind.ModuleVariable], ["helper", SymbolKind.Function]] },
  { language: Language.Rust, expect: [["Point", SymbolKind.Class], ["new", SymbolKind.Method], ["Shape", SymbolKind.Interface], ["Color", SymbolKind.Class], ["Id", SymbolKind.TypeAlias], ["LIMIT", SymbolKind.ModuleConstant], ["COUNTER", SymbolKind.ModuleVariable], ["nested", SymbolKind.Function], ["private_helper", SymbolKind.Function]] },
  { language: Language.Java, expect: [["Greeter", SymbolKind.Class], ["hello", SymbolKind.Method], ["Shape", SymbolKind.Interface], ["Color", SymbolKind.Class], ["Pair", SymbolKind.Class]], member: ["Greeter", "hello"] },
  { language: Language.CSharp, expect: [["Greeter", SymbolKind.Class], ["Hello", SymbolKind.Method], ["IShape", SymbolKind.Interface], ["Point", SymbolKind.Class], ["Color", SymbolKind.Class], ["Pair", SymbolKind.Class]], member: ["Greeter", "Hello"] },
  { language: Language.C, expect: [["point", SymbolKind.Class], ["point_t", SymbolKind.TypeAlias], ["color", SymbolKind.Class], ["value", SymbolKind.Class], ["add", SymbolKind.Function], ["make_ptr", SymbolKind.Function]], absent: ["prototype_only"] },
  { language: Language.Cpp, expect: [["Greeter", SymbolKind.Class], ["hello", SymbolKind.Method], ["Point", SymbolKind.Class], ["identity", SymbolKind.Function], ["Color", SymbolKind.Class], ["add", SymbolKind.Function]], member: ["Greeter", "hello"] },
  { language: Language.Ruby, expect: [["Greeter", SymbolKind.Class], ["hello", SymbolKind.Method], ["build", SymbolKind.Method], ["helper", SymbolKind.Function]], member: ["Greeter", "hello"], absent: ["Fixture"] },
  { language: Language.Kotlin, expect: [["Greeter", SymbolKind.Class], ["hello", SymbolKind.Method], ["Shape", SymbolKind.Interface], ["Registry", SymbolKind.Class], ["helper", SymbolKind.Function]], member: ["Greeter", "hello"] },
  { language: Language.Scala, expect: [["Greeter", SymbolKind.Class], ["hello", SymbolKind.Method], ["Shape", SymbolKind.Interface], ["Registry", SymbolKind.Class], ["Pair", SymbolKind.Class]], member: ["Greeter", "hello"] },
  { language: Language.Swift, expect: [["Greeter", SymbolKind.Class], ["hello", SymbolKind.Method], ["init", SymbolKind.Method], ["Point", SymbolKind.Class], ["Shape", SymbolKind.Interface], ["Identifier", SymbolKind.TypeAlias], ["helper", SymbolKind.Function]], member: ["Greeter", "hello"] },
  { language: Language.Dart, expect: [["Greeter", SymbolKind.Class], ["hello", SymbolKind.Method], ["Shape", SymbolKind.Class], ["Loggable", SymbolKind.Class], ["Color", SymbolKind.Class], ["Callback", SymbolKind.TypeAlias], ["helper", SymbolKind.Function]], member: ["Greeter", "hello"] },
  { language: Language.Elixir, expect: [["hello", SymbolKind.Function], ["secret", SymbolKind.Function], ["shout", SymbolKind.Function]], absent: ["Fixture.Greeter", "moduledoc", "import"] },
  { language: Language.Haskell, expect: [["Point", SymbolKind.Class], ["Wrapper", SymbolKind.Class], ["Identifier", SymbolKind.TypeAlias], ["Shape", SymbolKind.Interface], ["add", SymbolKind.Function], ["helper", SymbolKind.Function]] },
  { language: Language.OCaml, expect: [["point", SymbolKind.Class], ["add", SymbolKind.Function], ["limit", SymbolKind.ModuleVariable], ["nested", SymbolKind.Function], ["greeter", SymbolKind.Class], ["hello", SymbolKind.Method]], member: ["greeter", "hello"] },
  { language: Language.Lua, expect: [["M.add", SymbolKind.Function], ["helper", SymbolKind.Function], ["M.Greeter:hello", SymbolKind.Method]], absent: ["json", "M"] },
  { language: Language.R, expect: [["add", SymbolKind.Function], ["helper", SymbolKind.Function]], absent: ["limit", "library"] },
  { language: Language.Php, expect: [["Greeter", SymbolKind.Class], ["hello", SymbolKind.Method], ["Shape", SymbolKind.Interface], ["Loggable", SymbolKind.Class], ["Color", SymbolKind.Class], ["helper", SymbolKind.Function]], member: ["Greeter", "hello"] },
  { language: Language.Zig, expect: [["Point", SymbolKind.Class], ["init", SymbolKind.Method], ["Color", SymbolKind.Class], ["limit", SymbolKind.ModuleConstant], ["add", SymbolKind.Function], ["helper", SymbolKind.Function]], member: ["Point", "init"] },
  { language: Language.ObjectiveC, expect: [["Greeter", SymbolKind.Class], ["helloWithName", SymbolKind.Method], ["Shape", SymbolKind.Interface], ["area", SymbolKind.Method], ["add", SymbolKind.Function]], member: ["Greeter", "helloWithName"] },
  { language: Language.Bash, expect: [["hello", SymbolKind.Function], ["helper", SymbolKind.Function]], absent: ["LIMIT", "source", "world"] },
  { language: Language.Sql, expect: [["users", SymbolKind.Class], ["active_users", SymbolKind.Class], ["add_one", SymbolKind.Function]], absent: ["users_name_idx", "id", "name"] },
  { language: Language.Clojure, expect: [["add", SymbolKind.Function], ["limit", SymbolKind.ModuleVariable], ["shout", SymbolKind.Function], ["Shape", SymbolKind.Interface], ["Point", SymbolKind.Class], ["helper", SymbolKind.Function]], absent: ["fixture.core", "ns", "str"] },
  { language: Language.Html, expect: [] },
  { language: Language.Css, expect: [] },
  { language: Language.Json, expect: [] },
  { language: Language.Yaml, expect: [] },
];

test("the expectation table covers every structural family exactly once", () => {
  const covered = EXPECTATIONS.map((e) => e.language).sort();
  const families = structuralFamilies().map((f) => f.language).sort();
  assert.deepEqual(covered, families);
});

for (const expectation of EXPECTATIONS) {
  test(`${expectation.language}: valid fixture yields its named declarations and nothing invented`, async () => {
    const result = await parseFixture(expectation.language);
    const file = fixture(expectation.language, "valid");
    const bytes = Buffer.from(file.content, "utf8");

    assert.equal(result.diagnostics.length, 0, `valid fixture reported ${JSON.stringify(result.diagnostics)}`);
    for (const [name, kind] of expectation.expect) {
      const symbol = local(result.symbols, name);
      assert.equal(symbol.kind, kind, `${name} should be ${kind}`);
    }
    for (const name of expectation.absent ?? []) {
      assert.equal(result.symbols.some((s) => s.localName === name), false, `${name} must not be a symbol`);
    }
    if (expectation.member !== undefined) {
      const [parentName, childName] = expectation.member;
      const parent = local(result.symbols, parentName);
      const child = local(result.symbols, childName);
      assert.equal(child.parentSymbolId, parent.id);
      assert.ok(result.edges.some((e) => e.edgeType === "contains" && e.srcSymbolId === parent.id && e.dstSymbolId === child.id));
      assert.ok(child.fqName.startsWith(`${parent.fqName}.`), `${child.fqName} should extend ${parent.fqName}`);
    }
    if (expectation.expect.length === 0) {
      assert.equal(result.symbols.length, 0, `${expectation.language} has no declaration model and must yield no symbols`);
    }
    // No graph-edge invention (§49): a structural family emits `contains` only.
    assert.deepEqual([...new Set(result.edges.map((e) => e.edgeType))].filter((t) => t !== "contains"), []);

    // Span truth (§18, §30): every fixture carries non-ASCII text before its
    // first declaration, so a UTF-16 span would land early. Byte spans must
    // reproduce the declaration exactly, and the signature must be a verbatim
    // slice that starts where the span starts.
    for (const symbol of result.symbols) {
      const sliced = bytes.subarray(symbol.startByte, symbol.endByte).toString("utf8");
      assert.ok(sliced.length > 0, `${symbol.localName} has an empty span`);
      assert.ok(sliced.trimStart().startsWith(symbol.signature.slice(0, Math.min(12, symbol.signature.length))),
        `${symbol.localName}: span text ${JSON.stringify(sliced.slice(0, 40))} does not begin with signature ${JSON.stringify(symbol.signature.slice(0, 40))}`);
      assert.ok(file.content.includes(symbol.signature), `${symbol.localName}: signature is not a verbatim slice`);
      assert.ok(sliced.includes(symbol.localName.split(".").at(-1)!.split(":").at(-1)!), `${symbol.localName}: span does not contain the name`);
      const lines = file.content.split("\n");
      assert.ok(lines[symbol.startLine - 1]!.length > 0 || symbol.startLine <= lines.length);
      assert.ok(symbol.endLine >= symbol.startLine);
      assert.ok(symbol.endByte > symbol.startByte);
    }
  });

  test(`${expectation.language}: malformed fixture invents no declaration and reports truthfully`, async () => {
    const registry = createDefaultParserRegistry([]);
    const file = fixture(expectation.language, "malformed");
    const parsed = await registry.parse({ path: file.path, content: file.content, language: expectation.language });
    if (!parsed.ok) {
      // Whole-file rejection is a truthful outcome: the registry records parse_failed.
      assert.equal(parsed.error.code, ParserErrorCode.ParserFailed);
      assert.match(parsed.error.message, /root node is ERROR/u);
      return;
    }
    assert.ok(parsed.result.diagnostics.length > 0, "a malformed file must surface at least one diagnostic");
    // Every declaration that survived must be real: its name occurs in its own span.
    const bytes = Buffer.from(file.content, "utf8");
    for (const symbol of parsed.result.symbols) {
      const sliced = bytes.subarray(symbol.startByte, symbol.endByte).toString("utf8");
      assert.ok(sliced.includes(symbol.localName.split(".").at(-1)!), `${symbol.localName} is not in its own span`);
    }
    assert.equal(parsed.result.symbols.some((s) => s.localName === "Half" && s.kind !== SymbolKind.Class), false);
  });
}

// ------------------------------------------------------- generic behaviours

test("empty and comment-only sources parse to zero symbols without diagnostics", async () => {
  for (const family of structuralFamilies()) {
    const parser = createStructuralParser(family.language);
    const extension = family.extensions[0]!;
    const empty = await parser.parse({ path: `empty${extension}`, content: "", language: family.language });
    assert.deepEqual([empty.symbols.length, empty.diagnostics.length], [0, 0], `${family.language}: empty file`);
  }
  const commentOnly: Partial<Record<Language, string>> = {
    [Language.Go]: "// only a comment\n", [Language.Rust]: "// only a comment\n", [Language.Bash]: "# only a comment\n",
    [Language.Ruby]: "# only a comment\n", [Language.Lua]: "-- only a comment\n", [Language.Haskell]: "-- only a comment\n",
    [Language.Sql]: "-- only a comment\n", [Language.Clojure]: ";; only a comment\n", [Language.Css]: "/* only */\n",
  };
  for (const [language, content] of Object.entries(commentOnly) as [Language, string][]) {
    const result = await createStructuralParser(language).parse({ path: `c${familyOf(language)!.extensions[0]}`, content, language });
    assert.deepEqual([result.symbols.length, result.diagnostics.length], [0, 0], `${language}: comment-only file`);
  }
});

test("structural output is a function of the bytes: three parses hash identically", async () => {
  for (const family of structuralFamilies()) {
    const file = fixture(family.language, "valid");
    const hashes = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const result = parseStructural({ path: file.path, content: file.content, language: family.language }, family);
      hashes.add(JSON.stringify({ s: result.symbols, e: result.edges, d: result.diagnostics }));
    }
    assert.equal(hashes.size, 1, `${family.language} is not deterministic`);
  }
});

test("a declaration below a surrogate-pair character keeps a correct byte span", async () => {
  const content = "// 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 — naïve\nfunc Add(a int, b int) int { return a + b }\n";
  const result = await createStructuralParser(Language.Go).parse({ path: "u.go", content, language: Language.Go });
  const add = local(result.symbols, "Add");
  assert.equal(Buffer.from(content, "utf8").subarray(add.startByte, add.endByte).toString("utf8"),
    "func Add(a int, b int) int { return a + b }");
  assert.equal(add.signature, "func Add(a int, b int) int");
  assert.equal(add.startLine, 2);
});

test("the offset translator is exact at every character boundary (F4 control)", () => {
  const content = "é—𝔘x";
  const translator = createOffsetTranslator(content);
  const bytes = Buffer.from(content, "utf8");
  // UTF-16 indices: é=0, —=1, 𝔘=2..3 (pair), x=4. Bytes: 2 + 3 + 4 + 1.
  assert.deepEqual([0, 1, 2, 4, 5].map((i) => translator.byteOffsetAt(i)), [0, 2, 5, 9, 10]);
  assert.equal(bytes.subarray(translator.byteOffsetAt(4), translator.byteOffsetAt(5)).toString("utf8"), "x");
  // A deliberately wrong (identity) conversion lands inside the multi-byte
  // characters — the defect M198 fixed and the control this gate must catch.
  assert.notEqual(bytes.subarray(4, 5).toString("utf8"), "x");
});

test("a large file within normal bounds parses and its declarations stay in source order", async () => {
  const lines: string[] = ["// 日本語 header"];
  for (let i = 0; i < 3000; i += 1) lines.push(`func F${i}() int { return ${i} }`);
  const content = `${lines.join("\n")}\n`;
  assert.ok(content.length > 32768, "must exceed the default tree-sitter buffer");
  const result = await createStructuralParser(Language.Go).parse({ path: "big.go", content, language: Language.Go });
  assert.equal(result.symbols.length, 3000);
  assert.equal(result.diagnostics.length, 0);
  for (let i = 1; i < result.symbols.length; i += 1) {
    assert.ok(result.symbols[i]!.startByte > result.symbols[i - 1]!.startByte);
  }
});

test("a language family declares exactly one coordinate system and every structural family converts at the boundary", () => {
  for (const family of LANGUAGE_FAMILIES) {
    if (family.parser === "structural" || family.parser === "typescript") {
      assert.equal(family.nativeCoordinates, "UTF-16 code units + 0-based row/column");
    }
  }
});
