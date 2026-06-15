// Multi-file co-edit actionability hints.
//
// SCOPE: advisory annotation only, exactly like `actionabilityHints.ts`. This is a
// CHEAP, DETERMINISTIC heuristic that runs over the capsule's ALREADY-selected
// pivots/support (their roles, paths, symbols) plus the task text. It runs NO
// agents, NO Docker, calls NO model, and — critically — it NEVER touches retrieval:
// it does not generate candidates, re-rank, re-score, or change role assignment. It
// reads the final selection and emits a small, bounded list of "this fix likely
// spans several of these files — inspect each before finalizing" reminders.
//
// Motivation (M9 value-gap audit): VTRACE often surfaces the RIGHT coupled files but
// keeps the relationship PASSIVE — a second pivot the agent ignores, or a caller in
// support the agent never opens. The agent edits the lead pivot and stops, leaving a
// multi-file fix half-done. A compact, explicit co-edit OBLIGATION closes that gap.
//
// NOTHING HERE IS PROJECT-SPECIFIC. Detection keys off generic structure:
//   Path A (cross-module pivots): >=2 edit-capable pivot FILES selected in DIFFERENT
//     directories — the fix crosses module boundaries (the agent tends to edit the
//     traceback-named module and skip the other).
//   Path B (sibling pivots + coupled callers): a single file selected with >=2 pivot
//     SYMBOLS (a multi-symbol edit) PLUS edit-capable support files that share a
//     domain NOUN with the pivot symbols/file (the callers/handlers the change must
//     propagate to).
// No instance ids, no hardcoded file names, no repo names.

import type { ActionabilityHint } from "./actionabilityHints";

/**
 * The minimal view of a selected capsule item the detector needs. Structurally
 * compatible with `CapsuleV2Item` (mapped at the call site) AND with the persisted
 * Stage-5 manifest item, so the same detector runs at build time and in the offline
 * audit over captured manifests.
 */
export interface CoeditCandidateItem {
  role: "pivot" | "support";
  path: string;
  symbol: string;
  kind: string;
  /** True for docs/examples/fixture files (never an edit target). */
  isNonSourceExample?: boolean;
}

export interface DetectMultiFileCoeditInput {
  pivots: readonly CoeditCandidateItem[];
  support: readonly CoeditCandidateItem[];
  /** Task prose — used ONLY to enrich evidence, never to gate emission. */
  task?: string;
  /**
   * Files already covered by a more-specific generated-artifact hint. Such files are
   * excluded here so the generated-artifact obligation is not duplicated/overridden.
   */
  generatedArtifactFiles?: readonly string[];
}

// Bounds so the section stays compact regardless of how noisy a selection is.
const MAX_COEDIT_HINTS = 2;
const MAX_RELATED_FILES = 3;
const MAX_EVIDENCE = 2;
// A coupling noun must be at least this long (drops "to"/"of"/"is" style fragments).
const MIN_NOUN_LEN = 3;

// Generic CRUD/dispatch verbs — excluded so coupling keys off DOMAIN nouns (cookie,
// response, url, token) rather than ubiquitous verbs (set/get/update) that would
// couple unrelated files. Deliberately conservative.
const COMMON_VERBS = new Set([
  "set", "get", "add", "put", "remove", "delete", "update", "process", "make", "build",
  "create", "render", "print", "parse", "format", "handle", "init", "load", "dump",
  "read", "write", "fetch", "send", "run", "call", "apply", "check", "validate",
  "ensure", "prepare", "compute", "resolve", "convert", "to", "from", "of", "is", "has",
  "the", "and", "for", "with",
]);

// Generated parser/lexer table basenames — never an edit target (mirrors the
// generated-artifact detector so the two stay consistent).
const GENERATED_TABLE_BASENAME = /(?:_parsetab|_lextab)\.py$|^(?:parsetab|lextab)\.py$|^parser\.out$/;

// Test / docs / examples path segments — support at most, never a co-edit target.
const TEST_PATH = /(?:^|\/)tests?(?:$|\/)|(?:^|\/)test_[^/]*$|_test\.[a-z]+$|\.test\.[a-z]+$/i;
const DOCS_EXAMPLE_PATH = /(?:^|\/)(?:docs?|examples?|samples?|fixtures?)(?:$|\/)/i;

// Generic prose pairings that hint at a coordinated multi-file change. Used only to
// ENRICH evidence when present; never required for emission.
const PROSE_PAIRINGS = [
  "both", "also", "same behavior", "consistent", "roundtrip", "round-trip",
  "serialize", "deserialize", "encode", "decode", "parse", "unparse",
  "request", "response", "middleware", "cookie", "read", "write", "load", "dump",
  "set/get", "encode/decode",
];

function dirOf(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash >= 0 ? filePath.slice(0, slash) : "";
}

function baseOf(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash >= 0 ? filePath.slice(slash + 1) : filePath;
}

function stemOf(filePath: string): string {
  const base = baseOf(filePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

// Split an identifier (snake_case + camelCase) and a file stem into lowercased word
// tokens. `setSameSite` -> [set, same, site]; `_update_cookie` -> [update, cookie].
function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
}

// Domain nouns from a symbol + its file stem: tokens that are not common verbs and
// are long enough to be meaningful. These drive the Path B coupling test.
function nounTokens(symbol: string, filePath: string): Set<string> {
  const nouns = new Set<string>();
  for (const token of [...tokenize(symbol), ...tokenize(stemOf(filePath))]) {
    if (token.length >= MIN_NOUN_LEN && !COMMON_VERBS.has(token)) {
      nouns.add(token);
    }
  }
  return nouns;
}

function isGeneratedBasename(filePath: string): boolean {
  return GENERATED_TABLE_BASENAME.test(baseOf(filePath));
}

// A capsule item is an edit-capable SOURCE file: not a docs/example fixture, not a
// generated table, not a test file.
function isEditCapable(item: CoeditCandidateItem): boolean {
  if (item.isNonSourceExample === true) return false;
  if (isGeneratedBasename(item.path)) return false;
  if (TEST_PATH.test(item.path)) return false;
  if (DOCS_EXAMPLE_PATH.test(item.path)) return false;
  return true;
}

function prosePairingTerm(task: string | undefined): string | undefined {
  if (!task) return undefined;
  const lower = task.toLowerCase();
  for (const term of PROSE_PAIRINGS) {
    if (lower.includes(term)) return term;
  }
  return undefined;
}

const COEDIT_HINT_TEXT =
  "This fix likely requires coordinated edits across multiple surfaced files; "
  + "editing only the lead pivot may leave the change incomplete.";

const COEDIT_OBLIGATION_TEXT =
  "Before finalizing, inspect each co-edit candidate and either edit it or rule it "
  + "out with a source-grounded reason. If the changed behavior spans multiple files, "
  + "include all required edits in the final diff — do not finalize after editing only "
  + "the lead pivot.";

function makeCoeditHint(
  sourceFile: string,
  relatedFiles: string[],
  confidence: "medium" | "high",
  evidence: string[],
): ActionabilityHint {
  return {
    kind: "multi_file_coedit",
    sourceFile,
    relatedFile: relatedFiles[0]!,
    relatedFiles,
    confidence,
    evidence: evidence.slice(0, MAX_EVIDENCE),
    hint: COEDIT_HINT_TEXT,
    patchObligation: {
      kind: "consider_coedit_files_in_final_diff",
      text: COEDIT_OBLIGATION_TEXT,
    },
  };
}

/**
 * Detect likely multi-file co-edit obligations from the capsule's selected
 * pivots/support. Pure heuristic over the selection + task prose; never mutates
 * state, never consults gold-patch data. Returns at most `MAX_COEDIT_HINTS` hints,
 * deterministically ordered (capsule order). Conservative by design: it would
 * rather emit no hint than tell the agent to edit everything.
 */
export function detectMultiFileCoeditHints(
  input: DetectMultiFileCoeditInput,
): ActionabilityHint[] {
  const suppressed = new Set(input.generatedArtifactFiles ?? []);
  const proseTerm = prosePairingTerm(input.task);

  const editPivots = input.pivots.filter(
    (item) => isEditCapable(item) && !suppressed.has(item.path),
  );
  const editSupport = input.support.filter(
    (item) => isEditCapable(item) && !suppressed.has(item.path),
  );

  const hints: ActionabilityHint[] = [];
  const usedLeadFiles = new Set<string>();

  // --- Path A: cross-module pivots --------------------------------------------
  // >=2 distinct pivot FILES spanning >=2 distinct directories. The lead pivot file
  // is the highest-ranked (capsule order); the related candidates are the other
  // pivot files that live in a DIFFERENT directory (a fix that crosses module
  // boundaries — exactly the second file an agent following a single traceback skips).
  const distinctPivotFiles: string[] = [];
  for (const item of editPivots) {
    if (!distinctPivotFiles.includes(item.path)) distinctPivotFiles.push(item.path);
  }
  if (distinctPivotFiles.length >= 2) {
    const leadFile = distinctPivotFiles[0]!;
    const leadDir = dirOf(leadFile);
    const crossModule = distinctPivotFiles.slice(1).filter((file) => dirOf(file) !== leadDir);
    if (crossModule.length > 0) {
      const relatedFiles = crossModule.slice(0, MAX_RELATED_FILES);
      const evidence = [
        `${relatedFiles.length + 1} pivots were selected across separate modules `
        + `(${[leadDir || ".", ...relatedFiles.map((f) => dirOf(f) || ".")].join(", ")}) — `
        + "a fix that crosses file boundaries",
      ];
      if (proseTerm) {
        evidence.push(`task describes paired/cross-cutting behavior ("${proseTerm}")`);
      }
      hints.push(makeCoeditHint(leadFile, relatedFiles, "high", evidence));
      usedLeadFiles.add(leadFile);
    }
  }

  // --- Path B: sibling pivots + coupled callers -------------------------------
  // A single file selected with >=2 pivot SYMBOLS is a multi-symbol edit; the change
  // commonly propagates to callers/handlers. Surface edit-capable support files that
  // share a DOMAIN NOUN with the pivot symbols/file as co-edit candidates. The
  // sibling-pivot gate keeps this conservative: a lone pivot plus lexically-adjacent
  // support (e.g. a same-noun helper) is NOT enough — there must be a multi-symbol
  // edit shape before we point the agent at coupled callers.
  const pivotSymbolsByFile = new Map<string, Set<string>>();
  for (const item of editPivots) {
    if (!pivotSymbolsByFile.has(item.path)) pivotSymbolsByFile.set(item.path, new Set());
    pivotSymbolsByFile.get(item.path)!.add(item.symbol);
  }
  for (const [leadFile, symbols] of pivotSymbolsByFile) {
    if (hints.length >= MAX_COEDIT_HINTS) break;
    if (symbols.size < 2) continue;
    if (usedLeadFiles.has(leadFile)) continue;

    // Domain nouns from every sibling pivot symbol + the lead file stem.
    const pivotNouns = new Set<string>();
    for (const symbol of symbols) {
      for (const noun of nounTokens(symbol, leadFile)) pivotNouns.add(noun);
    }

    const coupled: string[] = [];
    const sharedNouns = new Set<string>();
    for (const item of editSupport) {
      if (item.path === leadFile) continue;
      if (coupled.includes(item.path)) continue;
      const supportNouns = nounTokens(item.symbol, item.path);
      const overlap = [...supportNouns].filter((noun) => pivotNouns.has(noun));
      if (overlap.length > 0) {
        coupled.push(item.path);
        overlap.forEach((noun) => sharedNouns.add(noun));
        if (coupled.length >= MAX_RELATED_FILES) break;
      }
    }

    if (coupled.length > 0) {
      const symbolList = [...symbols].slice(0, 3).join(", ");
      const evidence = [
        `lead file exposes ${symbols.size} sibling edit targets (${symbolList}) — a multi-symbol fix`,
        `coupled support shares domain terms (${[...sharedNouns].sort().join(", ")}) with the lead pivot`,
      ];
      hints.push(makeCoeditHint(leadFile, coupled, "medium", evidence));
      usedLeadFiles.add(leadFile);
    }
  }

  return hints.slice(0, MAX_COEDIT_HINTS);
}
