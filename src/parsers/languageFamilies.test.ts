import assert from "node:assert/strict";
import { test } from "bun:test";

import { Language } from "../domain/types";
import { detectLanguage, isAdvertisedIndexableLanguage, isIndexableSourceFile } from "../fs/languageDetection";
import { createDefaultParserRegistry } from "../indexer/indexProject";
import { createParserRegistry, type LanguageParser } from "./LanguageParser";
import { EXTENSION_TO_LANGUAGE, LANGUAGE_FAMILIES, familyOf, isParserBackedFamily, structuralFamilies } from "./languageFamilies";
import { describeParserFamilies } from "./parserFamilies";
import { grammarArtifactStatus } from "./treeSitterGrammars";

// ------------------------------------------------------------ identity (§12)

test("every Language enum member is exactly one family row, and every row is an enum member", () => {
  const enumMembers = Object.values(Language).sort();
  const rows = LANGUAGE_FAMILIES.map((f) => f.language).sort();
  assert.deepEqual(rows, enumMembers);
  assert.equal(new Set(rows).size, rows.length, "a family must not be declared twice");
});

test("extensions are canonical, case-insensitive and owned by exactly one family (F2 alias inflation)", () => {
  for (const [extension, language] of EXTENSION_TO_LANGUAGE) {
    assert.equal(extension, extension.toLowerCase());
    assert.equal(detectLanguage(`probe${extension}`), language);
    assert.equal(detectLanguage(`probe${extension.toUpperCase()}`), language);
  }
  // Three Cython extensions, four JavaScript extensions, six C++ extensions —
  // one family each. Registering an alias never adds a family.
  const registry = createDefaultParserRegistry([]);
  const families = registry.registeredLanguages().length;
  const extensions = [...EXTENSION_TO_LANGUAGE.keys()].length;
  assert.ok(extensions > families, `${extensions} extensions map onto ${families} registered families`);
  assert.equal(familyOf(Language.Cython)?.extensions.length, 3);
  assert.equal(familyOf(Language.Cpp)?.extensions.length, 6);
  assert.equal(detectLanguage("a.R"), Language.R);
  assert.equal(detectLanguage("a.r"), Language.R);
});

test("shared-grammar families keep the frozen identity: TypeScript owns .ts and .tsx, JavaScript owns .jsx", () => {
  assert.equal(detectLanguage("x.tsx"), Language.TypeScript);
  assert.equal(detectLanguage("x.jsx"), Language.JavaScript);
  assert.equal(detectLanguage("x.mli"), Language.OCaml);
  assert.equal(detectLanguage("x.h"), Language.C);
  assert.equal(detectLanguage("x.hpp"), Language.Cpp);
  assert.equal(detectLanguage("Dockerfile"), undefined, "special filenames are not families here");
  assert.equal(detectLanguage("Makefile"), undefined);
  assert.equal(detectLanguage("x.tf"), undefined, "HCL/Terraform is not a family (no ABI-14 grammar)");
  assert.equal(detectLanguage("x.fs"), undefined, "F# is not a family (no ABI-14 grammar)");
});

// ------------------------------------------- registration truth (F1, F3, F7)

test("a descriptor with a name and extensions but no functional parser is not parser-backed (F1)", () => {
  const toml = familyOf(Language.Toml)!;
  assert.equal(toml.parser, "none");
  assert.equal(toml.extensions.length, 1);
  assert.equal(detectLanguage("pyproject.toml"), Language.Toml, "still detected");
  assert.equal(isParserBackedFamily(Language.Toml), false);
  assert.equal(createDefaultParserRegistry([]).registeredLanguages().includes(Language.Toml), false);
  assert.equal(isIndexableSourceFile("pyproject.toml"), false);
  assert.equal(isAdvertisedIndexableLanguage(Language.Toml), false);
});

test("registration requires the grammar binary on disk, so registered means loadable (F3, F7)", () => {
  const registry = createDefaultParserRegistry([]);
  const registered = new Set(registry.registeredLanguages());
  for (const family of structuralFamilies()) {
    const status = grammarArtifactStatus(family.grammar!);
    assert.equal(registered.has(family.language), status.available,
      `${family.language}: registered=${registered.has(family.language)} but artefact available=${status.available} (${status.reason})`);
  }
  // A grammar that is not installed is reported, not registered.
  const absent = grammarArtifactStatus({ module: "tree-sitter-does-not-exist", artifact: "prebuilt", license: "MIT" });
  assert.equal(absent.available, false);
  assert.match(absent.reason ?? "", /not installed/u);
});

test("the frozen count is enum ∩ registry, and a parser registered for a non-enum name never counts (F12)", () => {
  const registry = createParserRegistry();
  const fake: LanguageParser = { language: "fortran" as Language, async parse() { throw new Error("never"); } };
  registry.registerParser("fortran" as Language, fake);
  registry.registerParser(Language.Go, createDefaultParserRegistry([]).getParser(Language.Go)!);
  const enumMembers = new Set(Object.values(Language) as string[]);
  const counted = registry.registeredLanguages().filter((l) => enumMembers.has(l));
  assert.deepEqual(counted, [Language.Go]);
});

// ---------------------------------------------------------- introspection (§25)

test("describeParserFamilies derives registration from the registry and availability from disk", () => {
  const registry = createDefaultParserRegistry([]);
  const described = describeParserFamilies(registry);
  assert.equal(described.length, LANGUAGE_FAMILIES.length);
  const registered = described.filter((d) => d.registered).map((d) => d.language).sort();
  assert.deepEqual(registered, [...registry.registeredLanguages()].sort());
  for (const d of described) {
    if (d.parser === "structural") {
      assert.equal(d.artifactAvailable, d.registered, `${d.language}: ${d.artifactReason}`);
      assert.ok(d.grammarModule !== null);
    }
    if (d.parser === "none") assert.equal(d.registered, false);
    if (d.tier === "PARSED_NO_STRUCTURE" || d.tier === "DOCUMENT") {
      assert.ok(["html", "css", "json", "yaml", "toml"].includes(d.language), `${d.language} claims tier ${d.tier}`);
    }
  }
  // Every VEXP row a family answers to is spelled as the README spells it.
  const rows = new Set(described.map((d) => d.vexpRow).filter((r) => r !== null));
  for (const row of ["HTML/CSS", "YAML/JSON", "Bash/Shell", "Objective-C", "C#", "C++"]) assert.ok(rows.has(row), row);
  assert.equal(described.find((d) => d.language === Language.Cython)?.vexpRow, null);
});

test("a registry that omits a family is described as not registered even though the artefact exists", () => {
  const withoutGo = createParserRegistry();
  const described = describeParserFamilies(withoutGo);
  const go = described.find((d) => d.language === Language.Go)!;
  assert.equal(go.registered, false);
  assert.equal(go.artifactAvailable, true);
});
