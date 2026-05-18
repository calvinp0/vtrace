import { Language, type FilePath } from "../domain/types";

export enum ParserErrorCode {
  InvalidInput = "invalid_input",
  UnsupportedLanguage = "unsupported_language",
  UnregisteredLanguage = "unregistered_language",
  ParserFailed = "parser_failed",
}

export interface ParserErrorOptions {
  code: ParserErrorCode;
  message: string;
  filePath?: FilePath;
  language?: Language | string;
}

export interface SerializedParserError {
  code: ParserErrorCode;
  message: string;
  filePath?: FilePath;
  language?: Language | string;
}

export class ParserError extends Error {
  readonly code: ParserErrorCode;
  readonly filePath?: FilePath;
  readonly language?: Language | string;

  constructor(options: ParserErrorOptions) {
    super(options.message);
    this.name = "ParserError";
    this.code = options.code;
    this.filePath = options.filePath;
    this.language = options.language;
  }

  toJSON(): SerializedParserError {
    const serialized: SerializedParserError = {
      code: this.code,
      message: this.message,
    };

    if (this.filePath !== undefined) {
      serialized.filePath = this.filePath;
    }

    if (this.language !== undefined) {
      serialized.language = this.language;
    }

    return serialized;
  }

  static invalidInput(message: string, filePath?: FilePath, language?: unknown): ParserError {
    return new ParserError({
      code: ParserErrorCode.InvalidInput,
      message,
      filePath,
      language: stringifyLanguage(language),
    });
  }

  static unsupportedLanguage(filePath: FilePath, language: unknown): ParserError {
    return new ParserError({
      code: ParserErrorCode.UnsupportedLanguage,
      message: `Unsupported parser language: ${String(language)}`,
      filePath,
      language: String(language),
    });
  }

  static unregisteredLanguage(filePath: FilePath, language: Language): ParserError {
    return new ParserError({
      code: ParserErrorCode.UnregisteredLanguage,
      message: `No parser registered for language: ${language}`,
      filePath,
      language,
    });
  }

  static parserFailed(filePath: FilePath, language: Language, error: unknown): ParserError {
    return new ParserError({
      code: ParserErrorCode.ParserFailed,
      message: `Parser failed: ${stringifyError(error)}`,
      filePath,
      language,
    });
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function stringifyLanguage(language: unknown): string | undefined {
  if (language === undefined) {
    return undefined;
  }

  return String(language);
}
