// Stage 5 M102 — benchmark-only task-text variants.
//
// Deterministic alternative derivations of the capsule `task` from a SWE-bench
// problem statement, used ONLY by the M102 variant scoreboard to measure how
// much evidence the production 360-char derivation loses. Nothing here is
// wired into the product: buildCapsuleV2 keeps its own caller-supplied task,
// and every variant reads the PROBLEM STATEMENT alone — the function signatures
// cannot see the gold patch.
//
// All extraction is regex-based, deduped on exact token, ordered by first
// occurrence, and hard-capped, so a variant can never balloon into an
// unbounded prompt.

import { deriveTaskFromProblemStatement } from "./build_stage5_retrieval_fixture";

export const M102_VARIANT_NAMES = [
  "V0_current",
  "V1_720",
  "V2_1200",
  "V3_structured_lite",
  "V4_full_problem",
  "V5_title_plus_errors",
  "V6_first_last",
  "V7_compressed_literals",
] as const;

export type M102VariantName = (typeof M102_VARIANT_NAMES)[number];

export interface TaskVariantMeta {
  readonly variant_name: M102VariantName;
  readonly task_text_chars: number;
  /** chars/4 — the convention the capsule budget accounting uses. */
  readonly task_text_est_tokens: number;
  readonly quoted_identifier_count: number;
  readonly file_path_like_count: number;
  readonly dotted_module_like_count: number;
  readonly exception_like_count: number;
  readonly traceback_line_count: number;
  readonly failing_test_count: number;
  /** Chars added on top of the V0 text (structured variants only). */
  readonly added_chars: number;
}

export interface TaskVariant {
  readonly name: M102VariantName;
  readonly text: string;
  readonly meta: TaskVariantMeta;
}

// --- caps (per the M102 spec) ---------------------------------------------------

export const MAX_ADDED_IDENTIFIERS = 20;
export const MAX_FILE_PATH_LIKES = 8;
export const MAX_TRACEBACK_LINES = 8;
export const MAX_STRUCTURED_CHARS = 1200;
const MAX_DOTTED_MODULES = 8;
const MAX_EXCEPTIONS = 6;
const MAX_FAILING_TESTS = 6;
// Benchmark-side safety bound for the "full problem" upper-bound variant.
const MAX_FULL_PROBLEM_CHARS = 20_000;

// --- text utilities ---------------------------------------------------------------

export function cleanProblemStatement(problemStatement: string): string {
  return problemStatement.replace(/[​‌‍﻿]/g, "").replace(/\r/g, "").trim();
}

/** Word-safe prefix: never cuts through a token; appends an ellipsis when cut. */
export function wordSafePrefix(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const hard = text.slice(0, maxLen - 1);
  const lastBreak = Math.max(hard.lastIndexOf(" "), hard.lastIndexOf("\n"));
  const safe = lastBreak > Math.floor(maxLen * 0.6) ? hard.slice(0, lastBreak) : hard;
  return `${safe.trimEnd()}…`;
}

/** Word-safe suffix (for V6): starts at a token boundary. */
export function wordSafeSuffix(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const hard = text.slice(text.length - (maxLen - 1));
  const firstBreak = Math.min(
    ...[hard.indexOf(" "), hard.indexOf("\n")].filter((i) => i !== -1),
  );
  const safe = Number.isFinite(firstBreak) && firstBreak < Math.floor(maxLen * 0.4)
    ? hard.slice(firstBreak + 1)
    : hard;
  return `…${safe.trimStart()}`;
}

// Dedupe on exact token, preserving first-occurrence order, then cap.
function dedupeCap(values: readonly string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (t.length === 0 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

// A token is code-like when it has identifier structure beyond a plain word:
// snake_case, CamelCase, dotted, dunder, UPPER_SNAKE, or call syntax.
function isCodeLikeToken(token: string): boolean {
  if (token.length < 3 || token.length > 80) return false;
  if (/\s/.test(token) && !/\(.*\)/.test(token)) return false;
  return (
    /_/.test(token)
    || /^[A-Z][a-z0-9]+[A-Z]/.test(token)
    || /[a-z][A-Z]/.test(token)
    || /\./.test(token)
    || /\(\)?$/.test(token)
    || /^[A-Z_]{3,}$/.test(token)
  );
}

// --- extraction (all exported for tests) --------------------------------------------

/** Inline `code` spans that look like identifiers/expressions. */
export function extractBacktickedIdentifiers(text: string, cap = MAX_ADDED_IDENTIFIERS): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) {
    if (isCodeLikeToken(m[1]!)) found.push(m[1]!);
  }
  return dedupeCap(found, cap);
}

/** Single-quoted / double-quoted short code-like strings ('has_key', "in_bulk"). */
export function extractQuotedIdentifiers(text: string, cap = MAX_ADDED_IDENTIFIERS): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/['"]([A-Za-z_][\w.()-]{2,60})['"]/g)) {
    if (isCodeLikeToken(m[1]!)) found.push(m[1]!);
  }
  return dedupeCap(found, cap);
}

/** File-looking paths/names (a slash-path or a known source/config extension). */
export function extractFilePathLikes(text: string, cap = MAX_FILE_PATH_LIKES): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\b[\w][\w./\\-]*\.(?:py|pyx|pyi|c|h|rst|txt|cfg|ini|toml|json|ya?ml)\b/g)) {
    found.push(m[0]!.replace(/\\/g, "/"));
  }
  return dedupeCap(found, cap);
}

/** Dotted module/attribute chains with >=3 segments (`django.db.models`). */
export function extractDottedModuleLikes(text: string, cap = MAX_DOTTED_MODULES): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\b[a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*){2,}\b/g)) {
    const tok = m[0]!;
    if (/\.(?:py|txt|rst|cfg|ini|toml|json|ya?ml)$/.test(tok)) continue; // file, not module
    if (/^\d|\.\d/.test(tok)) continue; // version-ish
    found.push(tok);
  }
  return dedupeCap(found, cap);
}

/** Exception/warning class names (`KeyError`, `MiddlewareNotUsed` is NOT one). */
export function extractExceptionLikes(text: string, cap = MAX_EXCEPTIONS): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\b[A-Z][A-Za-z0-9]*(?:Error|Exception|Warning)\b/g)) {
    found.push(m[0]!);
  }
  return dedupeCap(found, cap);
}

/** Failing-test identifiers: pytest node ids and bare `test_*` names. */
export function extractFailingTestNames(text: string, cap = MAX_FAILING_TESTS): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\b[\w./-]+\.py::[\w:.[\]-]+/g)) found.push(m[0]!);
  for (const m of text.matchAll(/\btest_[a-zA-Z0-9_]{2,}\b/g)) found.push(m[0]!);
  return dedupeCap(found, cap);
}

/**
 * Traceback lines: `File "..."` frames plus the final `SomethingError: ...`
 * line. Keeps the FIRST half and LAST half of the frames (the entry point and
 * the crash site carry the signal; the middle is noise), in original order.
 */
export function extractTracebackLines(text: string, cap = MAX_TRACEBACK_LINES): string[] {
  const lines = text.split("\n");
  const hits: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^File "[^"]+", line \d+/.test(t) || /^[A-Z][A-Za-z0-9]*(?:Error|Exception|Warning)\b\s*:/.test(t)) {
      hits.push(t.length > 160 ? `${t.slice(0, 159)}…` : t);
    }
  }
  const deduped = dedupeCap(hits, Number.MAX_SAFE_INTEGER);
  if (deduped.length <= cap) return deduped;
  const head = deduped.slice(0, Math.ceil(cap / 2));
  const tail = deduped.slice(deduped.length - Math.floor(cap / 2));
  return [...head, ...tail];
}

/** Unique code-like tokens anywhere in the text (for V7), first-occurrence order. */
export function extractCodeLikeTokens(text: string, cap = MAX_ADDED_IDENTIFIERS): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\b(?:[a-z0-9]+_[a-z0-9_]+|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[A-Z_]{4,}|[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*){2,})\b/g)) {
    found.push(m[0]!);
  }
  return dedupeCap(found, cap);
}

// --- variant assembly ---------------------------------------------------------------

interface Extracted {
  readonly backticked: string[];
  readonly quoted: string[];
  readonly paths: string[];
  readonly dotted: string[];
  readonly exceptions: string[];
  readonly tests: string[];
  readonly traceback: string[];
}

function extractAll(statement: string): Extracted {
  return {
    backticked: extractBacktickedIdentifiers(statement),
    quoted: extractQuotedIdentifiers(statement),
    paths: extractFilePathLikes(statement),
    dotted: extractDottedModuleLikes(statement),
    exceptions: extractExceptionLikes(statement),
    tests: extractFailingTestNames(statement),
    traceback: extractTracebackLines(statement),
  };
}

// Compose "base + labelled snippet sections", trimming whole sections from the
// END until the structured cap is met. The base task is never trimmed.
function composeCapped(base: string, sections: Array<{ label: string; items: string[] }>, maxChars: number): string {
  const parts: string[] = [];
  for (const s of sections) {
    if (s.items.length === 0) continue;
    parts.push(`${s.label}: ${s.items.join(" | ")}`);
  }
  let text = [base, ...parts].join("\n");
  while (text.length > maxChars && parts.length > 0) {
    parts.pop();
    text = [base, ...parts].join("\n");
  }
  return text.length > maxChars ? wordSafePrefix(text, maxChars) : text;
}

function metaFor(name: M102VariantName, text: string, baseChars: number, ex: Extracted): TaskVariantMeta {
  return {
    variant_name: name,
    task_text_chars: text.length,
    task_text_est_tokens: Math.ceil(text.length / 4),
    quoted_identifier_count: dedupeCap([...ex.backticked, ...ex.quoted], Number.MAX_SAFE_INTEGER).length,
    file_path_like_count: ex.paths.length,
    dotted_module_like_count: ex.dotted.length,
    exception_like_count: ex.exceptions.length,
    traceback_line_count: ex.traceback.length,
    failing_test_count: ex.tests.length,
    added_chars: Math.max(0, text.length - baseChars),
  };
}

/** Build one variant. Deterministic; reads the problem statement ONLY. */
export function buildTaskVariant(name: M102VariantName, problemStatement: string): TaskVariant {
  const statement = cleanProblemStatement(problemStatement);
  const v0 = deriveTaskFromProblemStatement(problemStatement);
  const ex = extractAll(statement);

  let text: string;
  switch (name) {
    case "V0_current":
      text = v0;
      break;
    case "V1_720":
      text = wordSafePrefix(statement, 720);
      break;
    case "V2_1200":
      text = wordSafePrefix(statement, 1200);
      break;
    case "V3_structured_lite": {
      const identifiers = dedupeCap([...ex.backticked, ...ex.quoted], MAX_ADDED_IDENTIFIERS);
      text = composeCapped(
        v0,
        [
          { label: "Key code references", items: identifiers },
          { label: "Files mentioned", items: ex.paths },
          { label: "Modules mentioned", items: ex.dotted },
          { label: "Errors", items: ex.exceptions },
          { label: "Failing tests", items: ex.tests },
          { label: "Traceback", items: ex.traceback },
        ],
        MAX_STRUCTURED_CHARS,
      );
      break;
    }
    case "V4_full_problem":
      text = wordSafePrefix(statement, MAX_FULL_PROBLEM_CHARS);
      break;
    case "V5_title_plus_errors":
      text = composeCapped(
        v0,
        [
          { label: "Errors", items: ex.exceptions },
          { label: "Failing tests", items: ex.tests },
          { label: "Traceback", items: ex.traceback },
        ],
        MAX_STRUCTURED_CHARS,
      );
      break;
    case "V6_first_last": {
      if (statement.length <= 720) {
        text = statement;
      } else {
        text = `${wordSafePrefix(statement, 360)} ${wordSafeSuffix(statement, 360)}`;
      }
      break;
    }
    case "V7_compressed_literals": {
      const tokens = extractCodeLikeTokens(statement, MAX_ADDED_IDENTIFIERS);
      text = composeCapped(v0, [{ label: "Code tokens", items: tokens }], MAX_STRUCTURED_CHARS);
      break;
    }
  }
  return { name, text, meta: metaFor(name, text, v0.length, ex) };
}

export function buildAllTaskVariants(problemStatement: string): TaskVariant[] {
  return M102_VARIANT_NAMES.map((name) => buildTaskVariant(name, problemStatement));
}
