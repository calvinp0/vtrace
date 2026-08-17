/**
 * M156: which indexing failures belong to ONE FILE, and which belong to the
 * repository.
 *
 * Before M156 there was no such distinction. `indexProject` collected per-file
 * outcomes correctly and then threw `IndexingFileFailuresError` the moment any
 * of them was a read or parse failure, so a single malformed source file made an
 * otherwise complete repository unavailable. M155 measured the cost: 3 of 30
 * frozen paired SWE tasks could receive no VTRACE treatment at all, and two of
 * those were baseline PASSES.
 *
 * The invariant this module encodes:
 *
 *   A malformed source file is a fact about the REPOSITORY. We may serve it
 *   truthfully. A broken database is a fact about OUR OWN STATE. We may not
 *   serve it at all.
 *
 * So the taxonomy below is deliberately small. It is not an attempt to describe
 * every way a parser can be unhappy — a bigger vocabulary would invite exactly
 * the "catch everything and continue" behaviour §30 forbids. It exists to answer
 * one question per failure, and to preserve enough signal that a PARSER BUG does
 * not get filed away as invalid source (§32).
 */

import { ParserErrorCode, type SerializedParserError } from "../parsers";
import type { IndexedFileStatus, IndexerFileError } from "./types";

/**
 * Why one file produced no semantic evidence.
 *
 * Every member is FILE-LOCAL by construction: a class that could describe a
 * broken index does not belong here, because such a failure must abort the run
 * rather than be recorded against a path.
 */
export const FileFailureClass = Object.freeze({
  /** The source is not valid in its language. The file is at fault. */
  SyntaxError: "SYNTAX_ERROR",
  /**
   * The parser threw where it should have returned a diagnostic. VTRACE is at
   * fault, and saying `SYNTAX_ERROR` here would erase the only signal that
   * distinguishes our bug from the repository's (§32).
   */
  ParserException: "PARSER_EXCEPTION",
  /** Bytes could not be decoded as text in the declared encoding. */
  EncodingError: "ENCODING_ERROR",
  /** The file's bytes could not be read at all: removed mid-scan, permissions. */
  ReadError: "READ_ERROR",
  /** Recoverable, but none of the above matched. Kept so the set is total. */
  Unknown: "UNKNOWN",
});

export type FileFailureClass = (typeof FileFailureClass)[keyof typeof FileFailureClass];

export const FILE_FAILURE_CLASSES: readonly FileFailureClass[] = Object.freeze([
  FileFailureClass.SyntaxError,
  FileFailureClass.ParserException,
  FileFailureClass.EncodingError,
  FileFailureClass.ReadError,
  FileFailureClass.Unknown,
]);

/**
 * File outcomes that may be contained.
 *
 * `persistence_failed` is deliberately ABSENT. A write that failed did so
 * against the index itself, and the whole persist step runs in one transaction —
 * so there is no honest way to attribute it to a single path, and §30/§31
 * require it to stay repository-fatal.
 */
const RECOVERABLE_STATUSES: ReadonlySet<IndexedFileStatus> = new Set<IndexedFileStatus>([
  "read_failed",
  "parse_failed",
]);

/** True when this outcome may be recorded against a path and indexing continued. */
export function isRecoverableFileFailure(status: IndexedFileStatus): boolean {
  return RECOVERABLE_STATUSES.has(status);
}

/**
 * True when this outcome must end the run.
 *
 * Note this is not the negation of `isRecoverableFileFailure` over all statuses:
 * `indexed`, `unregistered_language` and `unsupported_language` are not failures
 * at all, and §16 requires that an intentionally skipped file never be confused
 * with one the parser refused.
 */
export function isRepositoryFatalFileFailure(status: IndexedFileStatus): boolean {
  return status === "persistence_failed";
}

/**
 * Anything that reads as a decoding refusal rather than a grammar refusal.
 * Python reports these as `SyntaxError` subclasses, so the message is the only
 * thing that separates them — which is why the match is on wording and the
 * fallback is `SYNTAX_ERROR` rather than `UNKNOWN`.
 */
const ENCODING_MARKERS: readonly RegExp[] = [
  /unicode error/iu,
  /codec can't decode/iu,
  /invalid non-printable character/iu,
  /invalid character/iu,
  /encoding/iu,
];

/** Marks a parser that crashed rather than reporting a diagnostic. */
const PARSER_EXCEPTION_MARKERS: readonly RegExp[] = [
  /internal error/iu,
  /RangeError/u,
  /TypeError/u,
  /Maximum call stack/iu,
];

export function classifyFileFailure(
  status: IndexedFileStatus,
  error: SerializedParserError | IndexerFileError | undefined,
): FileFailureClass {
  if (status === "read_failed") return FileFailureClass.ReadError;
  if (status !== "parse_failed") return FileFailureClass.Unknown;

  const message = error?.message ?? "";
  // A parser that threw something other than a SyntaxError is our defect, and it
  // is checked BEFORE the encoding markers so a crash mentioning "encoding" is
  // still reported as a crash.
  if (PARSER_EXCEPTION_MARKERS.some((marker) => marker.test(message))) {
    return FileFailureClass.ParserException;
  }
  if (ENCODING_MARKERS.some((marker) => marker.test(message))) {
    return FileFailureClass.EncodingError;
  }
  if (/SyntaxError|IndentationError|TabError|unexpected|expected|invalid/iu.test(message)) {
    return FileFailureClass.SyntaxError;
  }
  const code = (error as SerializedParserError | undefined)?.code;
  if (code === ParserErrorCode.ParserFailed) return FileFailureClass.SyntaxError;
  return FileFailureClass.Unknown;
}

/**
 * The bounded reason string persisted and reported for one failed file.
 *
 * §79: never the file's contents, never a stack. A path, a class and a short
 * reason are enough to act on; anything longer is a debugging artifact that does
 * not belong in ordinary product metadata.
 */
export const MAX_FAILURE_MESSAGE_LENGTH = 300;

export function boundFailureMessage(message: string): string {
  const collapsed = message.replace(/\s+/gu, " ").trim();
  return collapsed.length <= MAX_FAILURE_MESSAGE_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_FAILURE_MESSAGE_LENGTH - 1)}…`;
}
