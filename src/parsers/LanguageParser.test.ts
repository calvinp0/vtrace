import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  computeFileId,
  Language,
  type ParseResult,
} from "../domain/types";
import {
  createParserRegistry,
  ParserError,
  ParserErrorCode,
  type LanguageParser,
  type ParseFileInput,
} from "./index";

test("parser interface accepts the required file input contract", async () => {
  let receivedInput: ParseFileInput | undefined;
  const parser: LanguageParser = {
    language: Language.TypeScript,
    async parse(input) {
      receivedInput = input;
      return emptyParseResult(input);
    },
  };

  const input: ParseFileInput = {
    path: "src/example.ts",
    content: "export const value = 1;\n",
    language: Language.TypeScript,
  };

  const result = await createParserRegistry([parser]).parse(input);

  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(input).sort(), ["content", "language", "path"]);
  assert.deepEqual(receivedInput, input);
});

test("parser errors are structured and deterministic", () => {
  const first = ParserError.unregisteredLanguage("src/example.ts", Language.TypeScript);
  const second = ParserError.unregisteredLanguage("src/example.ts", Language.TypeScript);

  assert.equal(first.code, ParserErrorCode.UnregisteredLanguage);
  assert.deepEqual(first.toJSON(), {
    code: ParserErrorCode.UnregisteredLanguage,
    message: "No parser registered for language: typescript",
    filePath: "src/example.ts",
    language: Language.TypeScript,
  });
  assert.deepEqual(first.toJSON(), second.toJSON());
});

test("unsupported and unregistered languages are handled predictably", async () => {
  const registry = createParserRegistry();

  const unregistered = await registry.parse({
    path: "src/example.ts",
    content: "export const value = 1;\n",
    language: Language.TypeScript,
  });

  assert.equal(unregistered.ok, false);
  assert.equal(unregistered.error.code, ParserErrorCode.UnregisteredLanguage);

  const unregisteredPython = await registry.parse({
    path: "src/example.py",
    content: "value = 1\n",
    language: Language.Python,
  });

  assert.equal(unregisteredPython.ok, false);
  assert.equal(unregisteredPython.error.code, ParserErrorCode.UnregisteredLanguage);
  assert.deepEqual(unregisteredPython.error.toJSON(), {
    code: ParserErrorCode.UnregisteredLanguage,
    message: "No parser registered for language: python",
    filePath: "src/example.py",
    language: Language.Python,
  });

  const unsupported = await registry.parse({
    path: "src/example.rb",
    content: "value = 1\n",
    language: "ruby" as Language,
  });

  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.code, ParserErrorCode.UnsupportedLanguage);
  assert.deepEqual(unsupported.error.toJSON(), {
    code: ParserErrorCode.UnsupportedLanguage,
    message: "Unsupported parser language: ruby",
    filePath: "src/example.rb",
    language: "ruby",
  });
});

test("registry allows parsers to be registered by language without changing registry code", async () => {
  const registry = createParserRegistry();
  const parser: LanguageParser = {
    language: Language.TypeScript,
    async parse(input) {
      return emptyParseResult(input);
    },
  };

  registry.registerParser(Language.TypeScript, parser);

  assert.equal(registry.getParser(Language.TypeScript), parser);

  const result = await registry.parse({
    path: "src/example.ts",
    content: "export const value = 1;\n",
    language: Language.TypeScript,
  });

  assert.equal(result.ok, true);
});

test("registry converts thrown parser failures into structured errors", async () => {
  const parser: LanguageParser = {
    language: Language.JavaScript,
    async parse() {
      throw new Error("tree-sitter unavailable");
    },
  };

  const result = await createParserRegistry([parser]).parse({
    path: "src/example.js",
    content: "export const value = 1;\n",
    language: Language.JavaScript,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, ParserErrorCode.ParserFailed);
  assert.deepEqual(result.error.toJSON(), {
    code: ParserErrorCode.ParserFailed,
    message: "Parser failed: tree-sitter unavailable",
    filePath: "src/example.js",
    language: Language.JavaScript,
  });
});

test("ParserResult is only a success or failure transport envelope", async () => {
  const parser: LanguageParser = {
    language: Language.TypeScript,
    async parse(input) {
      return emptyParseResult(input);
    },
  };

  const success = await createParserRegistry([parser]).parse({
    path: "src/example.ts",
    content: "export const value = 1;\n",
    language: Language.TypeScript,
  });
  const failure = await createParserRegistry().parse({
    path: "src/example.ts",
    content: "export const value = 1;\n",
    language: Language.TypeScript,
  });

  assert.deepEqual(Object.keys(success).sort(), ["ok", "result"]);
  assert.deepEqual(Object.keys(failure).sort(), ["error", "ok"]);
});

test("contract is compatible with future ParseResult-producing implementations", async () => {
  const expected = emptyParseResult({
    path: "src/example.jsx",
    content: "export const View = () => null;\n",
    language: Language.JavaScript,
  });
  const parser: LanguageParser = {
    language: Language.JavaScript,
    async parse() {
      return expected;
    },
  };

  const result = await createParserRegistry([parser]).parse({
    path: "src/example.jsx",
    content: "export const View = () => null;\n",
    language: Language.JavaScript,
  });

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.deepEqual(result.result, expected);
  }
});

test("input contract rejects non-normalized paths", async () => {
  const registry = createParserRegistry();

  const result = await registry.parse({
    path: "src\\example.ts",
    content: "export const value = 1;\n",
    language: Language.TypeScript,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, ParserErrorCode.InvalidInput);
  assert.equal(
    result.error.message,
    "path must be a normalized repo-relative path using forward slashes",
  );
});

function emptyParseResult(input: ParseFileInput): ParseResult {
  return {
    file: {
      id: computeFileId(input.path),
      path: input.path,
      language: input.language,
      contentHash: "not-computed-by-parser-contract",
      sizeBytes: Buffer.byteLength(input.content),
    },
    symbols: [],
    edges: [],
    diagnostics: [],
  };
}
