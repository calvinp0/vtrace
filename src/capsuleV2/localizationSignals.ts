// Localization-signal detection.
//
// WHY THIS EXISTS
// ----------------
// Capsule v2 retrieval is valuable when an issue is HARD to localize — when the
// agent would otherwise burn turns searching for the edit site. It is net
// overhead when the issue ALREADY names the file/symbol to edit: a traceback
// frame, an explicit file path, or a class/function name that resolves cleanly in
// the repo. In that case a baseline agent localizes for free, and injecting
// context just adds tokens (the M6 bounded-validation "inject-without-benefit"
// finding).
//
// This detector answers ONE question from the issue text + the repo index:
//
//   How strongly does the task itself already localize the edit site?
//
// It is the evidence the cost-aware context policy uses to SKIP injection for
// already-localized tasks while still injecting when vtrace has a real advantage
// (a hidden pivot the issue never names, an actionability obligation, etc.).
//
// CRITICAL RULES
//   - Uses ONLY the issue text + repo/index resolution. NEVER gold patch data.
//   - Conservative: a path/symbol counts as a localization signal ONLY when it
//     RESOLVES against the indexed repo. Non-resolving file-like prose and common
//     English words that match no symbol are ignored, never inflating confidence.

import type { Database } from "bun:sqlite";

import { shapeSweQuery } from "../capsule/sweQueryShaping";
import { listAllFilePaths } from "../db/repositories/filesRepository";
import { getSymbolById } from "../db/repositories/symbolsRepository";
import { normalizeFilePath } from "../domain/types";
import { isLikelyTestCandidate } from "../retrieval/searchSymbolsShared";
import { searchSymbols } from "../retrieval/searchSymbols";
import { extractTitleSymbolTerms, extractTitleText } from "./titleSymbolAnchoring";
import { parseLineAnchors } from "./lineAnchorResolution";

/** How strongly the issue text alone localizes the edit site. */
export type LocalizationConfidence = "none" | "weak" | "medium" | "strong";

// The strongest RESOLVED channel — drives the skip reason a policy records, so a
// decision says plainly why the task was judged already-localized.
export type LocalizationKind = "traceback" | "file_named" | "symbol_named" | "none";

export interface LocalizationSignals {
  /** Raw file-path hints pulled from `File "...", line N, in symbol` frames. */
  readonly tracebackPaths: readonly string[];
  /** Raw symbol names pulled from traceback frames. */
  readonly tracebackSymbols: readonly string[];
  /** File-like / repo-relative mentions in the issue prose (pre-resolution). */
  readonly explicitFileMentions: readonly string[];
  /** Class/function/snake_case symbol mentions in the issue prose (pre-resolution). */
  readonly explicitSymbolMentions: readonly string[];
  /** Of all the above paths, those that RESOLVE to an indexed file (normalized). */
  readonly resolvedFiles: readonly string[];
  /** Of all the above symbols, those that RESOLVE to an indexed production symbol. */
  readonly resolvedSymbols: readonly string[];
  /** Strong only when RESOLVED file/symbol evidence is present (never on prose). */
  readonly confidence: LocalizationConfidence;
  readonly kind: LocalizationKind;
  /** Human-readable trace of what fired — a decision is auditable to the evidence. */
  readonly reasons: readonly string[];
}

// `File "...", line N, in symbol` — the Python traceback frame shape. The path may
// be absolute, repo-relative, or a bare basename; the symbol is the enclosing
// function/method name. No such parser existed in the codebase before this.
const TRACEBACK_FRAME = /File ["']([^"'\n]+)["'],\s*line\s+\d+,\s*in\s+([A-Za-z_]\w*)/g;

// Cap symbol-name searches so a noisy issue cannot fan out unboundedly. Resolution
// only checks for an exact local-name match, so a small candidate window suffices.
const MAX_SYMBOL_SEARCH_RESULTS = 25;

// A symbol/term shorter than this is too generic to resolve meaningfully (single
// letters, two-char tokens). Mirrors the title-anchor minimum-term intuition.
const MIN_SYMBOL_TERM_LENGTH = 3;

/**
 * Detect how strongly the issue text already localizes the edit site, resolved
 * against the indexed repo. Pure read-only over `db`; deterministic.
 */
export function detectLocalizationSignals(
  db: Database,
  task: string,
  options: { readonly indexedPaths?: readonly string[] } = {},
): LocalizationSignals {
  const reasons: string[] = [];

  // --- 1. Traceback frames (the strongest user-provided localization signal) ---
  const tracebackPaths: string[] = [];
  const tracebackSymbols: string[] = [];
  for (const match of task.matchAll(TRACEBACK_FRAME)) {
    const pathHint = (match[1] ?? "").trim();
    const symbol = (match[2] ?? "").trim();
    if (pathHint.length > 0 && !tracebackPaths.includes(pathHint)) tracebackPaths.push(pathHint);
    if (symbol.length > 0 && !tracebackSymbols.includes(symbol)) tracebackSymbols.push(symbol);
  }

  // --- 2. Explicit file/symbol mentions from the issue prose -------------------
  // Reuse the shared query shaper (the same signal the capsule itself sizes from)
  // so the detector and the capsule never disagree about what the issue names. The
  // shaper already drops generic bug-report words and runner scripts.
  const shaped = shapeSweQuery({ problemStatement: task });
  const titleTerms = extractTitleSymbolTerms(extractTitleText(task));
  // Editor / blob source anchors (`file.py#L42`, `file.py:42`) are explicit file
  // pointers too; their bare path hint joins the file-mention set.
  const anchorPaths = parseLineAnchors(task).map((anchor) => anchor.pathHint);

  const explicitFileMentions = uniqueStrings([...shaped.likelyFiles, ...anchorPaths]);
  const explicitSymbolMentions = uniqueStrings([...shaped.likelySymbols, ...titleTerms]);

  // --- 3. Resolve everything against the index (existence only) -----------------
  // The caller may already hold this list (M144 shares one read between the
  // failure-frame membership test and this detector). Reading it twice per task
  // is a full table scan for an answer we already have.
  const allPaths = options.indexedPaths ?? listAllFilePaths(db);

  const resolvedFiles = new Set<string>();
  let anyTracebackPathResolved = false;
  for (const hint of tracebackPaths) {
    const resolved = resolveFilePath(hint, allPaths);
    if (resolved !== undefined) {
      resolvedFiles.add(resolved);
      anyTracebackPathResolved = true;
    }
  }
  for (const hint of explicitFileMentions) {
    const resolved = resolveFilePath(hint, allPaths);
    if (resolved !== undefined) resolvedFiles.add(resolved);
  }

  const resolvedSymbols = new Set<string>();
  let anyTracebackSymbolResolved = false;
  for (const name of tracebackSymbols) {
    if (resolveSymbolName(db, name)) {
      resolvedSymbols.add(name);
      anyTracebackSymbolResolved = true;
    }
  }
  for (const name of explicitSymbolMentions) {
    if (resolveSymbolName(db, name)) resolvedSymbols.add(name);
  }

  // --- 4. Confidence — strong ONLY for resolved file/symbol evidence ------------
  // A traceback frame whose path AND symbol both resolve is the textbook
  // already-localized case; so is the issue naming both a resolving file and a
  // resolving symbol. One-or-the-other is medium; mentions that resolve to nothing
  // are weak (the prose looked localized but the repo does not back it).
  const tracebackFullyResolved = anyTracebackPathResolved && anyTracebackSymbolResolved;
  const hadAnyMention =
    tracebackPaths.length > 0
    || tracebackSymbols.length > 0
    || explicitFileMentions.length > 0
    || explicitSymbolMentions.length > 0;

  let confidence: LocalizationConfidence;
  if (tracebackFullyResolved || (resolvedFiles.size > 0 && resolvedSymbols.size > 0)) {
    confidence = "strong";
  } else if (resolvedFiles.size > 0 || resolvedSymbols.size > 0) {
    confidence = "medium";
  } else if (hadAnyMention) {
    confidence = "weak";
  } else {
    confidence = "none";
  }

  // --- 5. Kind — the strongest RESOLVED channel (for the skip reason) -----------
  let kind: LocalizationKind;
  if (anyTracebackPathResolved || anyTracebackSymbolResolved) {
    kind = "traceback";
  } else if (resolvedFiles.size > 0) {
    kind = "file_named";
  } else if (resolvedSymbols.size > 0) {
    kind = "symbol_named";
  } else {
    kind = "none";
  }

  if (tracebackFullyResolved) reasons.push("traceback frame resolves to indexed file + symbol");
  else if (anyTracebackPathResolved) reasons.push("traceback file path resolves to indexed file");
  else if (anyTracebackSymbolResolved) reasons.push("traceback symbol resolves to indexed symbol");
  if (resolvedFiles.size > 0) reasons.push(`${resolvedFiles.size} issue-named file(s) resolve in repo`);
  if (resolvedSymbols.size > 0) reasons.push(`${resolvedSymbols.size} issue-named symbol(s) resolve in repo`);
  if (confidence === "weak") reasons.push("issue names file/symbol-like text but none resolves in repo");
  if (confidence === "none") reasons.push("issue carries no file/symbol localization signal");

  return {
    tracebackPaths,
    tracebackSymbols,
    explicitFileMentions,
    explicitSymbolMentions,
    resolvedFiles: [...resolvedFiles].sort(),
    resolvedSymbols: [...resolvedSymbols].sort(),
    confidence,
    kind,
    reasons,
  };
}

// Is `candidatePath` one of the resolved localization files? Boundary-aware suffix
// match so a workspace-prefixed pivot path still matches a repo-relative resolved
// file (and vice versa). Used by the policy to tell whether the lead pivot is a
// file the issue already named (no advantage) or a hidden site (a real advantage).
export function pathIsUserLocalized(
  candidatePath: string | null | undefined,
  resolvedFiles: readonly string[],
): boolean {
  if (candidatePath === undefined || candidatePath === null || candidatePath.length === 0) return false;
  const cand = normalizeFilePath(candidatePath);
  return resolvedFiles.some((file) => {
    const f = normalizeFilePath(file);
    return f === cand || cand.endsWith(`/${f}`) || f.endsWith(`/${cand}`);
  });
}

// --- resolution helpers -------------------------------------------------------

// Resolve a (possibly partial / absolute) path hint to an indexed file: exact
// match, then files ending with `/hint`, then a basename fallback. Returns the
// shortest deterministic match, or undefined when nothing resolves. Existence only
// — the content is never read.
function resolveFilePath(pathHint: string, allPaths: readonly string[]): string | undefined {
  const hint = normalizeFilePath(pathHint);
  if (hint.length === 0) return undefined;

  if (allPaths.includes(hint)) return hint;

  let matches = allPaths.filter((path) => path.endsWith(`/${hint}`));
  if (matches.length === 0) {
    const base = hint.includes("/") ? hint.slice(hint.lastIndexOf("/") + 1) : hint;
    if (base.length > 0) {
      matches = allPaths.filter((path) => path === base || path.endsWith(`/${base}`));
    }
  }
  if (matches.length === 0) return undefined;
  // Deterministic: shortest path, then lexicographic. We only need to know the
  // mention resolves; the exact tie-break is immaterial to confidence.
  return [...matches].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

// Does `name` (bare or `Class.method`) resolve to an indexed PRODUCTION symbol?
// Mirrors the title-symbol anchorer's local-name match: an exact (then
// case-insensitive) local-name hit on a non-test symbol. A common English word
// that names no symbol resolves to nothing — so it never counts as localization.
function resolveSymbolName(db: Database, name: string): boolean {
  const term = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  if (term.length < MIN_SYMBOL_TERM_LENGTH) return false;
  const lower = term.toLowerCase();
  for (const result of searchSymbols(db, {
    query: term,
    maxResults: MAX_SYMBOL_SEARCH_RESULTS,
    enableTestAwareDownweighting: true,
  })) {
    if (result.localName !== term && result.localName.toLowerCase() !== lower) continue;
    const symbol = getSymbolById(db, result.symbolId);
    if (symbol === undefined || isLikelyTestCandidate(symbol)) continue;
    return true;
  }
  return false;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
