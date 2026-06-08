// Body-literal extraction.
//
// Retrieval indexes symbol NAMES, signatures, docstrings and paths — never the
// source body. That makes a whole class of strong signals invisible: when a bug
// report quotes a diagnostic code (`models.E015`, `TS2345`, `ERR_INVALID_ARG_TYPE`)
// or a distinctive error message ("Cannot resolve keyword"), the only place that
// literal exists is the BODY of the symbol that emits it. This module extracts the
// DISTINCTIVE literals from a chunk of source so they can be indexed and searched,
// recovering the emitting symbol.
//
// It is deliberately framework-agnostic: it keys on the SHAPE of a literal
// (code-like token, quoted human message), never on any language or library. The
// same extractor runs over symbol bodies at index time and over task prose at
// query time, so a literal in the bug report and the literal in the code are
// compared on identical terms.

import type { SymbolRecord } from "../domain/types";
import type { SymbolBodyLiterals } from "../db/repositories/bodyLiteralsRepository";

export type BodyLiteralKind = "code" | "message";

export interface BodyLiteral {
  readonly kind: BodyLiteralKind;
  /** The literal as it appeared (original case), e.g. "models.E015". */
  readonly text: string;
}

// A quoted string literal: '...' or "..." (with escapes). Capture the inner text.
const QUOTED_STRING = /(['"])((?:\\.|(?!\1).)*)\1/g;

// A dotted/qualified token whose LAST segment is an alphanumeric code, e.g.
// `models.E015` (but not `self.cleaned_data`). Anchored on the code segment.
const QUALIFIED_CODE = /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/g;

// A bare alphanumeric diagnostic code: contains an UPPERCASE letter AND a digit,
// length >= 4 (E015, E1234, TS2345). The upper+digit requirement keeps common
// lowercase tokens (utf8, sha1, md5) and plain words out.
const ALNUM_CODE = /\b[A-Za-z][A-Za-z0-9]{3,}\b/g;

// SCREAMING_SNAKE_CASE identifiers with at least one underscore (so a single
// common all-caps word like ERROR or FAILED is NOT a code): ERR_INVALID_ARG_TYPE.
const SCREAMING_SNAKE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

// A quoted string is a "message" if it reads like human prose rather than a token:
// long enough, multi-word, and mostly letters/spaces (so format strings like
// "%s/%d" or "{}-{}" are not treated as messages).
const MESSAGE_MIN_CHARS = 12;
const MESSAGE_MIN_WORDS = 2;
const MESSAGE_MIN_LETTER_RATIO = 0.6;

function isAlnumCode(token: string): boolean {
  return /[A-Z]/.test(token) && /[0-9]/.test(token) && !/^[0-9]+$/.test(token);
}

function lastSegmentIsCode(qualified: string): boolean {
  const last = qualified.slice(qualified.lastIndexOf(".") + 1);
  return isAlnumCode(last) || (/_/.test(last) && /^[A-Z][A-Z0-9_]*$/.test(last));
}

function isMessage(inner: string): boolean {
  const trimmed = inner.trim();
  if (trimmed.length < MESSAGE_MIN_CHARS) {
    return false;
  }
  const words = trimmed.split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z'-]*$/.test(w));
  if (words.length < MESSAGE_MIN_WORDS) {
    return false;
  }
  const letters = (trimmed.match(/[A-Za-z]/g) ?? []).length;
  return letters / trimmed.length >= MESSAGE_MIN_LETTER_RATIO;
}

// Extract the distinctive literals (codes + messages) from a chunk of source or
// prose. Deduplicated, original-case, first-seen order. Generic words and short
// tokens are never returned — only literals with a distinctive SHAPE.
export function extractBodyLiterals(text: string): BodyLiteral[] {
  if (text.length === 0) {
    return [];
  }

  const out: BodyLiteral[] = [];
  const seen = new Set<string>();
  const push = (kind: BodyLiteralKind, raw: string): void => {
    const value = raw.trim();
    const key = `${kind}:${value.toLowerCase()}`;
    if (value.length === 0 || seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push({ kind, text: value });
  };

  for (const match of text.matchAll(QUALIFIED_CODE)) {
    if (lastSegmentIsCode(match[0])) {
      push("code", match[0]);
    }
  }
  for (const match of text.matchAll(ALNUM_CODE)) {
    if (isAlnumCode(match[0])) {
      push("code", match[0]);
    }
  }
  for (const match of text.matchAll(SCREAMING_SNAKE)) {
    push("code", match[0]);
  }
  for (const match of text.matchAll(QUOTED_STRING)) {
    const inner = match[2] ?? "";
    if (isMessage(inner)) {
      push("message", inner.trim());
    }
  }

  return out;
}

// The searchable text stored in the body-literals index for a symbol: every
// extracted literal, lowercased and space-joined. The FTS tokenizer splits dotted
// codes (`models.E015` -> `models`, `e015`) and message words into terms.
export function bodyLiteralsSearchText(literals: readonly BodyLiteral[]): string {
  return literals.map((literal) => literal.text.toLowerCase()).join(" ");
}

// Build the per-symbol body-literal rows for a file from its parsed symbols and
// raw content. Each symbol's body is sliced by BYTE range (symbols carry byte
// offsets, not text) and run through the extractor. Symbols with no distinctive
// literal are omitted. Pure: no DB access.
export function buildSymbolBodyLiterals(
  symbols: readonly SymbolRecord[],
  content: string,
): SymbolBodyLiterals[] {
  if (symbols.length === 0 || content.length === 0) {
    return [];
  }
  const bytes = Buffer.from(content, "utf8");
  const out: SymbolBodyLiterals[] = [];
  for (const symbol of symbols) {
    const body = bytes.subarray(symbol.startByte, symbol.endByte).toString("utf8");
    const literals = extractBodyLiterals(body);
    if (literals.length === 0) {
      continue;
    }
    out.push({ symbolId: symbol.id, literalsText: bodyLiteralsSearchText(literals) });
  }
  return out;
}
