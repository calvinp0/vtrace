import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";

import { listFilePathsWithEdgeToSymbol } from "../db/repositories/edgesRepository";
import { getFileByPath } from "../db/repositories/filesRepository";
import { listSymbolsByLocalName, listSymbolsForFile } from "../db/repositories/symbolsRepository";
import { Language, SymbolKind, type SymbolRecord } from "../domain/types";
import { detectLanguage } from "../fs/languageDetection";

/**
 * M139 caller-coverage analysis.
 *
 * `get_impact_graph` answers "who consumes this?" from resolved edges only. When
 * a method is reached through an instance whose type the parser cannot prove
 * (`spc.copy()`), no edge exists, no call site is persisted, and the symbol
 * looks unused. Reporting a small dependent count in that situation is not a
 * conservative answer — it is a wrong one, because the reader cannot tell
 * "proven to have no callers" from "callers exist but were not resolved".
 *
 * This module supplies the missing half: a bounded, deterministic search for
 * call sites that *might* reach the target, kept strictly separate from the
 * resolved graph. Nothing here ever becomes a `calls` edge, and nothing here is
 * persisted; potential callers are evidence attached to one response.
 */

export const CALLER_COVERAGE_REASONS = [
  /** A call site names the method but the receiver's type could not be proven. */
  "receiver_type_unresolved",
  /** More than one indexed definition shares this unqualified method name. */
  "method_name_ambiguous",
  /** Potential call sites were found but trimmed to stay inside the response budget. */
  "callsite_candidates_omitted",
  /** The index cannot express unresolved call sites, so discovery re-read source. */
  "index_capability_insufficient",
  /** Candidate files existed beyond the bounded scan limit. */
  "candidate_scan_limit_reached",
  /** A candidate file changed since indexing, so its evidence was not trusted. */
  "source_unavailable_or_stale",
  /** The reverse-reachability traversal stopped at its own edge/depth budget. */
  "traversal_limit_reached",
] as const;

export type CallerCoverageReason = (typeof CALLER_COVERAGE_REASONS)[number];

/**
 * `complete` — every consumer is proven and no unexplained candidate remains.
 * `incomplete` — resolution demonstrably fell short; more callers may exist.
 * `unknown` — coverage could not be assessed (no fresh source, unsupported
 * language). Never collapse `unknown` or `incomplete` into "no callers".
 */
export type CallerCoverageStatus = "complete" | "incomplete" | "unknown";

/** Deliberately coarse. No level here ever means "proven". */
export type PotentialCallerConfidence = "high" | "medium" | "unresolved";

export type PotentialCallerEvidenceKind =
  | "annotated_parameter"
  | "annotated_variable"
  | "constructor_assignment"
  | "self_attribute_in_owning_class"
  | "container_element_in_typed_scope"
  | "enclosing_scope_names_owner"
  | "name_match_only";

export interface PotentialCaller {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  /** The literal receiver expression, e.g. `spc_1` or `rxn.r_species[0]`. */
  readonly receiverExpression: string;
  readonly enclosingSymbol: string | null;
  readonly confidence: PotentialCallerConfidence;
  readonly evidenceKind: PotentialCallerEvidenceKind;
  /**
   * Detail fields. Shed first when the response envelope is tight, because
   * losing the explanation of a call site is far cheaper than losing the site.
   */
  readonly enclosingSymbolId?: string | null;
  /** Human-readable justification; never phrased as a proven call. */
  readonly reason?: string;
  readonly sourceText?: string;
}

export interface CallerCoverage {
  readonly status: CallerCoverageStatus;
  /** Proven incoming call/reference relations, across the whole discovered set. */
  readonly exactCallerCount: number;
  /** How many of those survived response budgeting. */
  readonly deliveredExactCallerCount: number;
  /** Potential sites discovered before budgeting. */
  readonly potentialCallerCount: number;
  /** Potential sites actually delivered in this response. */
  readonly deliveredPotentialCallerCount: number;
  readonly potentialCallersOmitted: number;
  /** Other indexed definitions sharing this unqualified name. */
  readonly competingDefinitionCount: number;
  readonly candidateFilesScanned: number;
  readonly candidateFilesAvailable: number;
  readonly reasonCodes: readonly CallerCoverageReason[];
  readonly notes: readonly string[];
}

export interface CallerCoverageResult {
  readonly coverage: CallerCoverage;
  readonly potentialCallers: readonly PotentialCaller[];
}

export interface CallerCoverageOptions {
  readonly repoRoot: string;
  /** Owning-class-related files inspected at most. */
  readonly maxCandidateFiles?: number;
  /** Potential sites retained at most. */
  readonly maxPotentialCallers?: number;
  /** Files larger than this are skipped rather than read. */
  readonly maxFileBytes?: number;
}

export const CALLER_COVERAGE_DEFAULTS = Object.freeze({
  maxCandidateFiles: 200,
  // Sized so a full potential-caller list still fits a default impact envelope
  // alongside the proven graph. Anything beyond this is reported as a count,
  // never silently dropped.
  maxPotentialCallers: 10,
  maxFileBytes: 1_048_576,
});

/** Languages whose method-call syntax this scanner models. No JS/JSX (M139 scope). */
const SUPPORTED_LANGUAGES: ReadonlySet<Language> = new Set([
  Language.Python,
  Language.Cython,
  Language.TypeScript,
]);

const CONFIDENCE_ORDER: Readonly<Record<PotentialCallerConfidence, number>> = {
  high: 0,
  medium: 1,
  unresolved: 2,
};

const EVIDENCE_CONFIDENCE: Readonly<Record<PotentialCallerEvidenceKind, PotentialCallerConfidence>> = {
  annotated_parameter: "high",
  annotated_variable: "high",
  constructor_assignment: "high",
  self_attribute_in_owning_class: "high",
  container_element_in_typed_scope: "medium",
  // Deliberately NOT medium. "Some name in this function mentions the owning
  // class" says almost nothing about one particular local, and promoting it
  // buys noise (`backbone_map.copy()` in a species-aware function is a dict).
  enclosing_scope_names_owner: "unresolved",
  name_match_only: "unresolved",
};

const EVIDENCE_REASON: Readonly<Record<PotentialCallerEvidenceKind, string>> = {
  annotated_parameter:
    "method name matches target; receiver is a parameter annotated with the owning class",
  annotated_variable:
    "method name matches target; receiver carries a local annotation naming the owning class",
  constructor_assignment:
    "method name matches target; receiver is assigned from an owning-class constructor in the same scope",
  self_attribute_in_owning_class:
    "method name matches target; receiver is self within the owning class",
  container_element_in_typed_scope:
    "method name matches target; receiver is iterated in a scope whose signature or docstring names the owning class",
  enclosing_scope_names_owner:
    "method name matches target; receiver type unresolved, but the enclosing scope names the owning class",
  name_match_only:
    "method name matches target; receiver type unresolved and no local type evidence was found",
};

/**
 * Assess how completely the resolved graph answers "who calls this?", and, when
 * it demonstrably does not, gather bounded potential call sites.
 *
 * `exactCallerCount` is supplied by the caller because only the impact engine
 * knows which incoming relations survived its own filters.
 */
export function analyzeCallerCoverage(
  db: Database,
  target: SymbolRecord,
  exactCallerCount: number,
  options: CallerCoverageOptions,
): CallerCoverageResult {
  const maxCandidateFiles = options.maxCandidateFiles ?? CALLER_COVERAGE_DEFAULTS.maxCandidateFiles;
  const maxPotentialCallers = options.maxPotentialCallers ?? CALLER_COVERAGE_DEFAULTS.maxPotentialCallers;
  const maxFileBytes = options.maxFileBytes ?? CALLER_COVERAGE_DEFAULTS.maxFileBytes;
  const reasons = new Set<CallerCoverageReason>();
  const notes: string[] = [];

  const owner = resolveOwningClass(db, target);
  if (owner === null) {
    // A module-level function is reached by name, which the resolver already
    // handles exactly. There is no unproven-receiver failure mode to report.
    return {
      coverage: {
        status: exactCallerCount > 0 ? "complete" : "unknown",
        exactCallerCount,
        deliveredExactCallerCount: exactCallerCount,
        potentialCallerCount: 0,
        deliveredPotentialCallerCount: 0,
        potentialCallersOmitted: 0,
        competingDefinitionCount: countCompetingDefinitions(db, target),
        candidateFilesScanned: 0,
        candidateFilesAvailable: 0,
        reasonCodes: [],
        notes: [
          "Target is not an instance method; caller coverage reflects exact name resolution only.",
        ],
      },
      potentialCallers: [],
    };
  }

  const competingDefinitionCount = countCompetingDefinitions(db, target);
  if (competingDefinitionCount > 0) reasons.add("method_name_ambiguous");

  const candidatePaths = collectCandidateFiles(db, owner, target);
  const scannable = candidatePaths.filter((filePath) => {
    const language = detectLanguage(filePath);
    return language !== undefined && SUPPORTED_LANGUAGES.has(language);
  });
  const scanned = scannable.slice(0, maxCandidateFiles);
  if (scanned.length < scannable.length) reasons.add("candidate_scan_limit_reached");

  const discovered: PotentialCaller[] = [];
  let staleOrUnreadable = 0;

  for (const filePath of scanned) {
    const sites = scanFileForPotentialCallers(db, options.repoRoot, filePath, target, owner, maxFileBytes);
    if (sites === null) {
      staleOrUnreadable += 1;
      continue;
    }
    discovered.push(...sites);
  }

  if (staleOrUnreadable > 0) {
    reasons.add("source_unavailable_or_stale");
    notes.push(
      `${staleOrUnreadable} candidate file(s) were skipped because their contents no longer match the index.`,
    );
  }

  discovered.sort(comparePotentialCallers);
  const delivered = discovered.slice(0, maxPotentialCallers);
  const omitted = discovered.length - delivered.length;
  if (omitted > 0) reasons.add("callsite_candidates_omitted");
  if (discovered.length > 0) {
    reasons.add("receiver_type_unresolved");
    reasons.add("index_capability_insufficient");
  }

  const status = determineStatus({
    exactCallerCount,
    discoveredCount: discovered.length,
    staleOrUnreadable,
    scannedCount: scanned.length,
    scannableCount: scannable.length,
  });

  if (status === "incomplete") {
    notes.push(
      "Caller coverage is incomplete: unresolved instance-method call sites exist, so absence of exact callers is not proof of absence of callers.",
    );
  }
  notes.push(
    "Potential callers are name-and-context matches, not proven call relations; they are never persisted as graph edges.",
  );
  notes.push(
    "Candidates were narrowed to files the index relates to the owning class; a file reaching the class only through a TYPE_CHECKING-guarded import has no indexed edge and is not visible to this scan.",
  );

  return {
    coverage: {
      status,
      exactCallerCount,
      deliveredExactCallerCount: exactCallerCount,
      potentialCallerCount: discovered.length,
      deliveredPotentialCallerCount: delivered.length,
      potentialCallersOmitted: omitted,
      competingDefinitionCount,
      candidateFilesScanned: scanned.length,
      candidateFilesAvailable: scannable.length,
      reasonCodes: [...reasons].sort(),
      notes,
    },
    potentialCallers: delivered,
  };
}

function determineStatus(input: {
  readonly exactCallerCount: number;
  readonly discoveredCount: number;
  readonly staleOrUnreadable: number;
  readonly scannedCount: number;
  readonly scannableCount: number;
}): CallerCoverageStatus {
  if (input.discoveredCount > 0) return "incomplete";
  if (input.staleOrUnreadable > 0 || input.scannedCount < input.scannableCount) return "unknown";
  // Nothing unresolved was found anywhere the index could point us. That is as
  // close to proven as static evidence gets, but only if we actually looked.
  if (input.scannedCount === 0) return "unknown";
  return "complete";
}

function resolveOwningClass(db: Database, target: SymbolRecord): SymbolRecord | null {
  if (target.kind !== SymbolKind.Method || target.parentSymbolId === undefined) return null;
  const owners = listSymbolsForFile(db, target.filePath).filter((symbol) => symbol.id === target.parentSymbolId);
  const owner = owners[0];
  if (owner === undefined || owner.kind !== SymbolKind.Class) return null;
  return owner;
}

function countCompetingDefinitions(db: Database, target: SymbolRecord): number {
  return listSymbolsByLocalName(db, target.localName)
    .filter((symbol) => symbol.id !== target.id
      && (symbol.kind === SymbolKind.Method || symbol.kind === SymbolKind.Function))
    .length;
}

/**
 * Files worth reading: those the index already relates to the owning class, plus
 * the class's own file. Relation-agnostic on purpose — a constructor call or a
 * type annotation localises a file as well as an import does.
 */
function collectCandidateFiles(
  db: Database,
  owner: SymbolRecord,
  target: SymbolRecord,
): string[] {
  const paths = new Set<string>(listFilePathsWithEdgeToSymbol(db, owner.id));
  paths.add(owner.filePath);
  paths.add(target.filePath);
  return [...paths].sort((left, right) => left.localeCompare(right));
}

/** Returns null when the file could not be read or no longer matches the index. */
function scanFileForPotentialCallers(
  db: Database,
  repoRoot: string,
  filePath: string,
  target: SymbolRecord,
  owner: SymbolRecord,
  maxFileBytes: number,
): PotentialCaller[] | null {
  let text: string;
  try {
    text = readFileSync(path.join(path.resolve(repoRoot), filePath), "utf8");
  } catch {
    return null;
  }
  if (Buffer.byteLength(text) > maxFileBytes) return null;

  const indexedFile = getFileByPath(db, filePath);
  if (
    indexedFile === undefined
    || indexedFile.sizeBytes !== Buffer.byteLength(text)
    || indexedFile.contentHash !== createHash("sha256").update(text).digest("hex")
  ) {
    return null;
  }

  const lines = text.split("\n");
  const symbols = listSymbolsForFile(db, filePath);
  const moduleNames = collectImportedModuleNames(lines);
  const results: PotentialCaller[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    for (const occurrence of findMethodCallOccurrences(line, target.localName)) {
      const lineNumber = index + 1;
      // The definition itself is not a call site.
      if (filePath === target.filePath && lineNumber >= target.startLine && lineNumber <= target.endLine
        && occurrence.receiver === "self") {
        // A self-call inside the target is still a real consumer elsewhere, but a
        // recursive self-reference inside the body is not interesting evidence.
        continue;
      }
      // `shutil.copy(src, dst)` is a module-level function that happens to share
      // the method's name. It is not an instance-method call at all, so it is
      // not a candidate consumer of any class's method.
      if (moduleNames.has(occurrence.receiver)) continue;
      const enclosing = innermostSymbolAt(symbols, lineNumber);
      const evidenceKind = classifyReceiver({
        receiver: occurrence.receiver,
        ownerName: owner.localName,
        enclosing,
        lines,
        callLine: lineNumber,
      });
      results.push({
        filePath,
        line: lineNumber,
        column: occurrence.column,
        receiverExpression: occurrence.receiver,
        enclosingSymbolId: enclosing?.id ?? null,
        enclosingSymbol: enclosing?.fqName ?? null,
        confidence: EVIDENCE_CONFIDENCE[evidenceKind],
        evidenceKind,
        reason: EVIDENCE_REASON[evidenceKind],
        sourceText: line.trim().slice(0, 160),
      });
    }
  }

  return results;
}

/**
 * Names bound to a MODULE by an import in this file (`import shutil`,
 * `import numpy as np`). A dotted call on one of these is a module function,
 * never an instance method, so it can be excluded without guessing at types.
 * `from x import y` is deliberately NOT collected: `y` may well be a class.
 */
export function collectImportedModuleNames(lines: readonly string[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const line of lines) {
    const match = /^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/.exec(line);
    if (match === null) continue;
    if (match[2] !== undefined) {
      names.add(match[2]);
      continue;
    }
    // `import a.b.c` binds only the root name `a`.
    names.add(match[1]!.split(".")[0]!);
  }
  return names;
}

interface MethodCallOccurrence {
  readonly receiver: string;
  readonly column: number;
}

/**
 * Locate `<receiver>.<method>(` on one line and recover the receiver expression.
 * Bounded and syntactic: no attempt is made to understand what the receiver is,
 * only what it is written as.
 */
export function findMethodCallOccurrences(
  line: string,
  methodName: string,
): MethodCallOccurrence[] {
  const commentIndex = indexOfLineComment(line);
  const scanLimit = commentIndex === -1 ? line.length : commentIndex;
  const results: MethodCallOccurrence[] = [];
  const pattern = new RegExp(`\\.\\s*${escapeRegExp(methodName)}\\s*\\(`, "g");

  for (const match of line.matchAll(pattern)) {
    const dotIndex = match.index;
    if (dotIndex >= scanLimit) continue;
    if (isInsideStringLiteral(line, dotIndex)) continue;
    const receiver = captureReceiverExpression(line.slice(0, dotIndex));
    if (receiver === null) continue;
    results.push({ receiver, column: dotIndex - receiver.length });
  }

  return results;
}

/**
 * Trailing identifier chain immediately before the dot, allowing attribute
 * access and subscripts (`rxn.r_species[0]`). A call-returning receiver
 * (`f().copy()`) is deliberately not captured: there is no name to reason about.
 */
function captureReceiverExpression(prefix: string): string | null {
  const match = /([A-Za-z_][A-Za-z0-9_]*(?:\s*\[[^[\]]*\]|\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*$/.exec(prefix);
  if (match === null) return null;
  const receiver = match[1]!.trim();
  return receiver.length === 0 ? null : receiver;
}

function indexOfLineComment(line: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\") { index += 1; continue; }
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === "#" && !inSingle && !inDouble) return index;
    else if (char === "/" && line[index + 1] === "/" && !inSingle && !inDouble) return index;
  }
  return -1;
}

function isInsideStringLiteral(line: string, position: number): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < position; index += 1) {
    const char = line[index];
    if (char === "\\") { index += 1; continue; }
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
  }
  return inSingle || inDouble;
}

function innermostSymbolAt(
  symbols: readonly SymbolRecord[],
  line: number,
): SymbolRecord | undefined {
  let best: SymbolRecord | undefined;
  for (const symbol of symbols) {
    if (symbol.startLine > line || symbol.endLine < line) continue;
    if (best === undefined || symbol.startLine > best.startLine) best = symbol;
  }
  return best;
}

/**
 * Local, bounded receiver-type evidence. This is intentionally not type
 * inference: every rule reads text already attached to the enclosing symbol.
 */
function classifyReceiver(input: {
  readonly receiver: string;
  readonly ownerName: string;
  readonly enclosing: SymbolRecord | undefined;
  readonly lines: readonly string[];
  readonly callLine: number;
}): PotentialCallerEvidenceKind {
  const { receiver, ownerName, enclosing, lines, callLine } = input;
  const root = receiver.split(/[.[]/)[0]!.trim();
  const owner = escapeRegExp(ownerName);

  // Type evidence binds to a NAME, not to an expression rooted at that name.
  // Knowing `spc` is an ARCSpecies says nothing about `spc.mol`, and `self`
  // being the owning class says nothing about `self.r_1.mol`. Attribute or
  // subscript suffixes therefore discard every local-type signal below —
  // without this the scanner confidently mislabels Molecule.copy and
  // ARCReaction.copy call sites as high-confidence ARCSpecies.copy callers.
  const receiverIsBareName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(receiver);

  if (!receiverIsBareName) {
    return "name_match_only";
  }

  if (root === "self") {
    // `self.copy()` inside the owning class is a genuine self-consumer; inside
    // any other class it is some other type's method of the same name.
    return enclosing !== undefined && enclosingClassIs(enclosing, ownerName)
      ? "self_attribute_in_owning_class"
      : "name_match_only";
  }

  if (enclosing === undefined) return "name_match_only";

  const scopeText = `${enclosing.signature}\n${enclosing.docstring ?? ""}`;
  const scopeNamesOwner = new RegExp(`\\b${owner}\\b`).test(scopeText);
  // A loop variable is only worth promoting when the scope declares a CONTAINER
  // of the owning class (`list[ARCSpecies]`). A bare mention of the class name
  // elsewhere is not evidence about what this particular loop iterates over.
  const declaresOwnerContainer = new RegExp(`\\[[^\\]]*\\b${owner}\\b[^\\]]*\\]`).test(scopeText);
  const weakFallback: PotentialCallerEvidenceKind = scopeNamesOwner
    ? "enclosing_scope_names_owner"
    : "name_match_only";

  // Last write wins. A parameter annotation only describes the name until
  // something rebinds it — `other: ARCSpecies` followed by `other = other.mol`
  // means the receiver at the call site is a Molecule, and trusting the
  // signature there produces a confident wrong answer.
  // A comprehension binds its loop variable to the RIGHT of the call
  // (`[item.copy() for item in items]`), so the preceding-lines scan cannot see
  // it. Check the call's own line for that shape first.
  const comprehensionBinds = new RegExp(`\\bfor\\s+[^:]*\\b${escapeRegExp(root)}\\b[^:]*\\sin\\s`)
    .test(lines[callLine - 1] ?? "");
  if (comprehensionBinds) {
    return declaresOwnerContainer ? "container_element_in_typed_scope" : weakFallback;
  }

  const binding = findLastBindingBefore(lines, root, enclosing.startLine, Math.min(enclosing.endLine, callLine));

  if (binding !== null) {
    if (binding.kind === "for") {
      return declaresOwnerContainer ? "container_element_in_typed_scope" : weakFallback;
    }
    if (binding.annotationNamesOwner) return "annotated_variable";
    if (isSoleOwnerConstructorExpression(binding.rhs, ownerName)) return "constructor_assignment";
    return weakFallback;
  }

  // Never rebound in this scope, so the signature still describes the receiver.
  if (new RegExp(`\\b${escapeRegExp(root)}\\s*:\\s*[^,)=]*\\b${owner}\\b`).test(enclosing.signature)) {
    return "annotated_parameter";
  }

  return weakFallback;
}

interface LocalBinding {
  readonly kind: "assign" | "for";
  readonly rhs: string;
  readonly annotationNamesOwner: boolean;
}

/**
 * The last statement in `[startLine, beforeLine)` that binds `name`, whether by
 * assignment or by a `for` target. Comparison operators (`==`, `!=`, `<=`) and
 * keyword arguments are excluded so they are not mistaken for bindings.
 */
function findLastBindingBefore(
  lines: readonly string[],
  name: string,
  startLine: number,
  beforeLine: number,
): LocalBinding | null {
  const escaped = escapeRegExp(name);
  const assignPattern = new RegExp(`^\\s*${escaped}\\s*(:[^=]*)?=(?!=)\\s*(.*)$`);
  const forPattern = new RegExp(`^\\s*for\\s+[^:]*\\b${escaped}\\b[^:]*\\sin\\s`);
  let found: LocalBinding | null = null;

  for (let index = startLine - 1; index < Math.min(beforeLine - 1, lines.length); index += 1) {
    const line = lines[index]!;
    if (forPattern.test(line)) {
      found = { kind: "for", rhs: "", annotationNamesOwner: false };
      continue;
    }
    const match = assignPattern.exec(line);
    if (match === null) continue;
    found = {
      kind: "assign",
      rhs: readBalancedExpression(lines, index, line.length - match[2]!.length),
      annotationNamesOwner: match[1] !== undefined,
    };
  }

  return found;
}

/**
 * Whether `rhs` is exactly a constructor call on the owning class and nothing
 * else. `ARCSpecies(...)` qualifies; `ARCSpecies(...).mol` does not, because the
 * value that lands in the variable is the attribute, not the instance.
 */
function isSoleOwnerConstructorExpression(rhs: string, ownerName: string): boolean {
  const trimmed = rhs.trim();
  const prefix = new RegExp(`^${escapeRegExp(ownerName)}\\s*\\(`);
  if (!prefix.test(trimmed)) return false;

  let depth = 0;
  for (let index = trimmed.indexOf("("); index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        // Anything trailing the constructor (`.mol`, `[0]`) changes the type.
        return trimmed.slice(index + 1).trim().length === 0;
      }
    }
  }
  return false;
}

/** Join continuation lines until brackets balance, so a multi-line RHS is whole. */
function readBalancedExpression(
  lines: readonly string[],
  startIndex: number,
  fromColumn: number,
): string {
  const MAX_CONTINUATION_LINES = 20;
  let text = lines[startIndex]!.slice(fromColumn);
  let depth = bracketDelta(text);

  for (
    let index = startIndex + 1;
    depth > 0 && index < lines.length && index - startIndex <= MAX_CONTINUATION_LINES;
    index += 1
  ) {
    text += `\n${lines[index]}`;
    depth += bracketDelta(lines[index]!);
  }

  return text;
}

function bracketDelta(line: string): number {
  let delta = 0;
  for (const char of line) {
    if (char === "(" || char === "[" || char === "{") delta += 1;
    else if (char === ")" || char === "]" || char === "}") delta -= 1;
  }
  return delta;
}

/** Whether the enclosing symbol's own qualified name sits inside the owning class. */
function enclosingClassIs(enclosing: SymbolRecord, ownerName: string): boolean {
  return new RegExp(`(^|::|\\.)${escapeRegExp(ownerName)}(\\.|$)`).test(enclosing.fqName);
}

/**
 * Ranking-only test-path predicate. Deliberately local rather than a change to
 * `isTestSymbol`, whose result feeds entrypoint classification and benchmark
 * scoring; widening that would move unrelated results. Covers both the
 * `test_x.py` and `x_test.py` conventions.
 */
function isTestPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return /(^|\/)(tests?|__tests__)(\/|$)/u.test(lower)
    || /(^|\/)test_[^/]+$/u.test(lower)
    || /_test\.[^/.]+$/u.test(lower)
    || /\.(test|spec)\.[cm]?[jt]sx?$/u.test(lower);
}

function comparePotentialCallers(left: PotentialCaller, right: PotentialCaller): number {
  return CONFIDENCE_ORDER[left.confidence] - CONFIDENCE_ORDER[right.confidence]
    // Within a confidence tier a production consumer is more informative than a
    // test that merely exercises the method.
    || Number(isTestPath(left.filePath)) - Number(isTestPath(right.filePath))
    || left.filePath.localeCompare(right.filePath)
    || left.line - right.line
    || left.column - right.column
    || left.receiverExpression.localeCompare(right.receiverExpression);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
