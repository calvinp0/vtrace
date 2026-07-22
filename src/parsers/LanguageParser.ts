import path from "node:path";

import {
  Language,
  normalizeFilePath,
  type ParseResult,
} from "../domain/types";
import { isLanguage } from "../domain/guards";
import { ParserError } from "./errors";
import type { ParseFileInput, ParserResult } from "./types";

export interface LanguageParser {
  readonly language: Language;
  parse(input: ParseFileInput): Promise<ParseResult>;
}

export interface ParserRegistry {
  registerParser(language: Language, parser: LanguageParser): void;
  getParser(language: Language): LanguageParser | undefined;
  registeredLanguages(): readonly Language[];
  parse(input: ParseFileInput): Promise<ParserResult>;
}

export function createParserRegistry(
  parsers: readonly LanguageParser[] = [],
): ParserRegistry {
  const parsersByLanguage = new Map<Language, LanguageParser>();

  const registry: ParserRegistry = {
    registerParser(language: Language, parser: LanguageParser): void {
      parsersByLanguage.set(language, parser);
    },

    getParser(language: Language): LanguageParser | undefined {
      return parsersByLanguage.get(language);
    },

    registeredLanguages(): readonly Language[] {
      return [...parsersByLanguage.keys()].sort();
    },

    async parse(input: ParseFileInput): Promise<ParserResult> {
      const inputError = validateParseFileInput(input);

      if (inputError !== undefined) {
        return { ok: false, error: inputError };
      }

      const parser = parsersByLanguage.get(input.language);

      if (parser === undefined) {
        return {
          ok: false,
          error: ParserError.unregisteredLanguage(input.path, input.language),
        };
      }

      try {
        return {
          ok: true,
          result: await parser.parse(input),
        };
      } catch (error) {
        return {
          ok: false,
          error: ParserError.parserFailed(input.path, input.language, error),
        };
      }
    },
  };

  for (const parser of parsers) {
    registry.registerParser(parser.language, parser);
  }

  return registry;
}

export function validateParseFileInput(input: ParseFileInput): ParserError | undefined {
  if (typeof input !== "object" || input === null) {
    return ParserError.invalidInput("Parser input must be an object");
  }

  const inputPath = (input as Partial<ParseFileInput>).path;
  const language = (input as Partial<ParseFileInput>).language;
  const content = (input as Partial<ParseFileInput>).content;

  if (typeof inputPath !== "string" || inputPath.length === 0) {
    return ParserError.invalidInput("path must be a non-empty string", inputPath, language);
  }

  if (!isNormalizedRepoRelativePath(inputPath)) {
    return ParserError.invalidInput(
      "path must be a normalized repo-relative path using forward slashes",
      inputPath,
      language,
    );
  }

  if (typeof content !== "string") {
    return ParserError.invalidInput("content must be a string", inputPath, language);
  }

  if (!isLanguage(language)) {
    return ParserError.unsupportedLanguage(inputPath, language);
  }

  return undefined;
}

function isNormalizedRepoRelativePath(filePath: string): boolean {
  if (filePath.includes("\\")) {
    return false;
  }

  if (path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) {
    return false;
  }

  if (normalizeFilePath(filePath) !== filePath) {
    return false;
  }

  const segments = filePath.split("/");

  return segments.every((segment) => {
    return segment.length > 0 && segment !== "." && segment !== "..";
  });
}
