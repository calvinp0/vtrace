import type {
  FilePath,
  Language,
  ParseResult,
} from "../domain/types";
import type { ParserError } from "./errors";

export interface ParseFileInput {
  path: FilePath;
  content: string;
  language: Language;
}

export interface ParserSuccess {
  ok: true;
  result: ParseResult;
}

export interface ParserFailure {
  ok: false;
  error: ParserError;
}

export type ParserResult = ParserSuccess | ParserFailure;
