// Decision-bearing mechanism extraction.
//
// Retrieval indexes symbol NAMES, signatures, docstrings, paths and — since the
// body-literal lane — the distinctive literals a body emits. All of those are
// things the code SAYS. None of them is a thing the code DOES.
//
// That is the gap M150 §15 names: behaviour encoded in control flow, ordering,
// first-item selection, fallback or priority may have no useful symbol name of
// its own. `determine_family` decides which reaction family wins on this line:
//
//     family, family_own_reverse = product_dicts[0]['family'], …
//
// and there is no name anywhere in the index that says so. This module derives
// small, bounded, deterministic FACTS about such statements at index time, so a
// query that asks how a choice is made has something to retrieve besides nouns.
//
// Three commitments keep the facts honest:
//
//   - a fact states only what the statement shows. Taking element zero is
//     `first_item_selection`, never `winner_by_priority`: the ordering that made
//     element zero the winner lives somewhere else, and claiming to know it from
//     a subscript is exactly the overclaim §62 forbids.
//   - ORDERING and SELECTION are different kinds. Sorting for display is not a
//     choice (§38), and a request about precedence is not answered by whatever
//     happens to call `[0]` (§45).
//   - a fact is never relevant on its own. `name[0]` in `first_character` and
//     `candidates[0]` in a scheduler are the same syntax; what separates them is
//     the request. Facts are query-CONDITIONED at scoring time (§37), and the
//     extractor additionally refuses the clearly-incidental shapes here.
//
// Derived from body TEXT with string and comment content blanked first — the
// same input `extractBodyLiterals` takes, sliced by the same byte range. A
// docstring that mentions `product_dicts[0]` (ARC has one) must never produce a
// mechanism fact, so blanking is a correctness requirement, not tidiness.

import { SymbolKind, type SymbolRecord } from "../domain/types";

/**
 * Only a CALLABLE can carry a mechanism fact.
 *
 * A class's byte range covers every method it contains, so extracting from it
 * re-attributes each method's mechanism to the class — measured on ARC,
 * `ARCReaction` accumulated eight facts belonging to six different properties
 * and two unrelated methods, and rode all of them at once. A class does not
 * execute anything; the callable inside it does. Module-scope symbols are
 * excluded for the M140 §28 reason as well: they are delivery-invisible and must
 * never become answer-bearing.
 */
const MECHANISM_BEARING_KINDS: ReadonlySet<string> = new Set([
  SymbolKind.Function,
  SymbolKind.Method,
]);

/**
 * The mechanism vocabulary. Small on purpose (§18): every kind here is one a
 * behavioural request can ask for and one the extractor can evidence without
 * guessing. Classifying every possible control-flow pattern is explicitly not an
 * M150 goal.
 */
export type MechanismFactKind =
  /** `xs[0]` on a collection-shaped operand: the first element is taken. */
  | "first_item_selection"
  /** An ordering is established and then its first element is taken. */
  | "sort_then_first"
  /** `min(...)` picks an extreme. */
  | "min_selection"
  /** `max(...)` picks an extreme. */
  | "max_selection"
  /** A loop returns on the first acceptable candidate. */
  | "first_success_return"
  /** A precedence/priority table is consulted to rank or pick. */
  | "priority_lookup"
  /** A branch chain yields different results per condition. */
  | "conditional_choice"
  /** An order is imposed on a collection (sorting, dedup-preserving, concatenation). */
  | "ordering_established"
  /** A secondary route runs when the primary produced nothing. */
  | "fallback_branch"
  /** A value is assigned a default and conditionally replaced. */
  | "default_then_override"
  /** A result is looked up in, or written to, a keyed cache. */
  | "cache_lookup"
  /** A stored attribute is returned unchanged. */
  | "attribute_return";

export interface MechanismFact {
  readonly kind: MechanismFactKind;
  /**
   * The operand the mechanism acts on, lowercased — `product_dicts`, `options`,
   * `backends`. Empty when the shape has no single operand. Carried so a fact
   * can be tied back to the request's subject rather than counting as evidence
   * for any question at all.
   */
  readonly subject: string;
  /** 0-based line offset within the owning definition. Stable under edits above it. */
  readonly lineOffset: number;
  /** The statement, trimmed and bounded. What §25 requires be showable. */
  readonly evidence: string;
  /**
   * Does this mechanism produce what the definition RETURNS?
   *
   * The single most important property a fact carries, and the one that
   * separates a definition that DECIDES from a definition that merely contains a
   * subscript. Measured on ARC: `determine_family` assigns `family` from
   * `product_dicts[0]` and returns it on the next line; `get_reactant_num` takes
   * `self.reactants[0][0]` to index a template and returns a COUNT; and
   * `get_reactive_bonds_from_family` builds a `bond` it appends to a list. All
   * three take element zero of a collection. Only the first one is answering
   * "which one wins", and this is what says so.
   */
  readonly resultBearing: boolean;
}

/** One persisted row. Mirrors `SymbolBodyLiterals`. */
export interface SymbolMechanismFacts {
  readonly symbolId: string;
  readonly facts: readonly MechanismFact[];
}

/** Hard per-definition cap. A body cannot flood the index (§57). */
export const MAX_FACTS_PER_SYMBOL = 8;
/** Longest statement text retained per fact. */
const MAX_EVIDENCE_CHARS = 200;

// --- source normalisation -----------------------------------------------------

const TRIPLE_QUOTED = /("""|''')(?:[\s\S]*?)\1/g;
const SINGLE_QUOTED = /(['"])(?:\\.|(?!\1)[^\n])*\1/g;

/**
 * Blank every string and comment while preserving line structure.
 *
 * Content is replaced, newlines are not, so a fact's line offset still points at
 * the real line. A multi-line docstring collapses to blank lines rather than
 * disappearing.
 */
export function blankLiteralsAndComments(body: string): string {
  const blankKeepingNewlines = (text: string): string => text.replace(/[^\n]/gu, " ");
  let out = body.replace(TRIPLE_QUOTED, blankKeepingNewlines);
  out = out.replace(SINGLE_QUOTED, (match) => `${match[0]}${" ".repeat(Math.max(0, match.length - 2))}${match[0]}`);
  // `#` and `//` comments, now that no string can contain one.
  out = out.replace(/#[^\n]*/gu, blankKeepingNewlines);
  out = out.replace(/\/\/[^\n]*/gu, blankKeepingNewlines);
  return out;
}

// --- operand shape ------------------------------------------------------------

/**
 * Names that denote a collection regardless of plural morphology. Kept short and
 * language-level: these are how programmers spell "many of something" in any
 * codebase, not a domain vocabulary.
 */
const COLLECTION_NOUNS: ReadonlySet<string> = new Set([
  "list", "items", "entries", "queue", "stack", "pool", "set", "seq", "sequence",
  "array", "buffer", "batch", "group", "rows", "cols", "data", "results",
  "matches", "hits", "all", "each", "every",
]);

/** Calls whose result is a collection. `sorted(xs)[0]` needs no plural name. */
const COLLECTION_CALLS: ReadonlySet<string> = new Set([
  "sorted", "list", "tuple", "filter", "map", "reversed", "split", "splitlines",
  "values", "keys", "items", "findall", "readlines", "range", "enumerate",
  "concat", "flat", "flatmap", "slice",
]);

/**
 * Is this operand plausibly a collection?
 *
 * The §37 negative control turns on exactly this question: `name[0]` takes the
 * first CHARACTER of a singular string and is not a selection; `candidates[0]`
 * takes the first of many and may be. Deciding it from the operand's own SHAPE
 * is generic — it needs no type inference and no repository knowledge — and it
 * is the cheapest place to refuse an incidental subscript outright rather than
 * relying on query conditioning alone to suppress it later.
 */
export function looksLikeCollection(operand: string, body: string): boolean {
  const leaf = (operand.split(".").at(-1) ?? operand).toLowerCase();
  if (leaf.length === 0) return false;
  if (COLLECTION_NOUNS.has(leaf)) return true;
  for (const noun of COLLECTION_NOUNS) {
    if (leaf.endsWith(`_${noun}`) || leaf.startsWith(`${noun}_`)) return true;
  }
  // Plural morphology: `dicts`, `options`, `backends`, `families`. Excludes the
  // common singular endings that merely happen to finish in `s`.
  const plural = /s$/u.test(leaf)
    && leaf.length >= 4
    && !/(?:ss|us|is|as|ies|ous|ness|sis|status|class|address|process|access)$/u.test(leaf);
  if (plural) return true;
  if (/ies$/u.test(leaf) && leaf.length >= 5) return true;
  // Assigned from a collection-producing call anywhere in the same body.
  const assignment = new RegExp(
    String.raw`\b${escape(leaf)}\s*(?::[^=\n]*)?=\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\(`,
    "u",
  );
  const assigned = assignment.exec(body);
  if (assigned !== null) {
    const callee = (assigned[1] ?? "").split(".").at(-1)?.toLowerCase() ?? "";
    if (COLLECTION_CALLS.has(callee)) return true;
  }
  // Assigned a list/tuple literal or a comprehension.
  if (new RegExp(String.raw`\b${escape(leaf)}\s*(?::[^=\n]*)?=\s*[\[(]`, "u").test(body)) return true;
  // Iterated over: `for x in leaf`.
  if (new RegExp(String.raw`\bfor\s+[A-Za-z_][A-Za-z0-9_,\s]*\s+in\s+(?:self\.)?${escape(leaf)}\b`, "u").test(body)) return true;
  // Measured by length — you do not call len() on a scalar.
  if (new RegExp(String.raw`\blen\s*\(\s*(?:self\.)?${escape(leaf)}\s*\)`, "u").test(body)) return true;
  return false;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// --- statement patterns -------------------------------------------------------

/** `xs[0]` / `self.xs[0]` / `f(...)[0]`. The operand is captured for shape testing. */
const CONSTANT_INDEX = /(?:^|[^A-Za-z0-9_.])((?:self\.)?[A-Za-z_][A-Za-z0-9_.]*)\s*\[\s*0\s*\]/u;
const ORDERING_CALL = /\b(sorted|sort|reversed|heapify|nsmallest|nlargest)\s*\(/u;
const DEDUP_PRESERVING = /\bdict\.fromkeys\s*\(/u;
const MIN_CALL = /\bmin\s*\(/u;
const MAX_CALL = /\bmax\s*\(/u;
/** A key= / cmp= argument names the ordering criterion. */
const PRIORITY_WORD = /priorit|precedenc|order|rank|weight/iu;
const CACHE_WORD = /cache|memo/iu;
/** `sorted(xs)[0]` — the ordering and the pick are one expression. */
const ORDERED_THEN_INDEXED = /\b(?:sorted|reversed|nsmallest|nlargest)\s*\([^\n]*\)\s*\[\s*0\s*\]/u;
const CACHE_DECORATOR = /@(?:functools\.)?(?:lru_cache|cache|cached_property|memoize|memoise)\b/u;
const RETURN_ATTRIBUTE = /^\s*return\s+self\.([A-Za-z_][A-Za-z0-9_]*)\s*$/u;

/**
 * Derive the mechanism facts of ONE definition body.
 *
 * Line-oriented and single-pass with a small amount of look-around, so cost is
 * linear in the body and independent of repository size. The body arrives
 * already sliced to the definition, so nothing outside it is ever read.
 */
export function extractMechanismFacts(body: string, options: {
  readonly decorators?: readonly string[] | null;
  readonly kind?: string;
} = {}): MechanismFact[] {
  if (body.length === 0) return [];
  const source = blankLiteralsAndComments(body);
  const lines = source.split("\n");
  const out: MechanismFact[] = [];
  const seen = new Set<string>();
  const push = (kind: MechanismFactKind, subject: string, lineOffset: number, evidence: string): void => {
    if (out.length >= MAX_FACTS_PER_SYMBOL) return;
    const key = `${kind}\0${subject}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      kind,
      subject: subject.toLowerCase(),
      lineOffset,
      evidence: evidence.trim().slice(0, MAX_EVIDENCE_CHARS),
      resultBearing: producesResult(lines, lineOffset),
    });
  };
  // Evidence text comes from the ORIGINAL body so a delivered slice shows real
  // code, not the blanked form used for matching.
  const originalLines = body.split("\n");
  const rawLine = (index: number): string => originalLines[index] ?? "";

  // A cache decorator is a whole-definition fact with no single statement.
  const decorators = (options.decorators ?? []).join(" ");
  if (CACHE_DECORATOR.test(decorators)) {
    push("cache_lookup", "", 0, decorators.slice(0, MAX_EVIDENCE_CHARS));
  }

  let sawOrdering = false;
  let orderingLine = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;

    // --- ordering ------------------------------------------------------------
    const orderingCall = ORDERING_CALL.exec(line);
    const dedup = DEDUP_PRESERVING.exec(line);
    if (orderingCall !== null || dedup !== null) {
      sawOrdering = true;
      orderingLine = index;
      const call = (orderingCall ?? dedup)!;
      push("ordering_established", orderedOperand(line, call.index + call[0].length), index, rawLine(index));
    }
    // `return a + b` over two collection-shaped locals establishes their
    // relative precedence — the RMG-before-ARC ordering in ARC's family list is
    // exactly this shape and has no sort call anywhere.
    const concat = /^\s*return\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\+\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(?:if\b|$)/u.exec(line);
    if (concat !== null
      && looksLikeCollection(concat[1]!, source)
      && looksLikeCollection(concat[2]!, source)) {
      sawOrdering = true;
      push("ordering_established", concat[1]!.toLowerCase(), index, rawLine(index));
    }

    // --- extremes ------------------------------------------------------------
    const minCall = MIN_CALL.exec(line);
    if (minCall !== null) {
      push("min_selection", orderedOperand(line, minCall.index + minCall[0].length), index, rawLine(index));
    }
    const maxCall = MAX_CALL.exec(line);
    if (maxCall !== null) {
      push("max_selection", orderedOperand(line, maxCall.index + maxCall[0].length), index, rawLine(index));
    }

    // --- priority table ------------------------------------------------------
    // A precedence-named operand that is INDEXED or used as an ordering key. The
    // name alone is not enough: a variable called `order` that nobody consults
    // ranks nothing.
    const priority = priorityLookupOperand(line);
    if (priority !== undefined) push("priority_lookup", priority, index, rawLine(index));

    // --- first item ----------------------------------------------------------
    const indexed = CONSTANT_INDEX.exec(line);
    if (indexed !== null) {
      const operand = indexed[1]!;
      if (looksLikeCollection(operand, source)) {
        // The ordering has to be established BEFORE the pick for the compound
        // reading to be true. Same-line counts only when the subscript is applied
        // to the ordering's own result (`sorted(xs)[0]`) — `sorted((a[0], a[1]))`
        // sorts a pair built FROM two indices and orders nothing that `[0]` then
        // consumes, so reporting it as sort-then-first would be a false claim.
        const compound = (sawOrdering && orderingLine >= 0 && orderingLine < index)
          || ORDERED_THEN_INDEXED.test(line);
        push(
          compound ? "sort_then_first" : "first_item_selection",
          normalizeOperand(operand),
          index,
          rawLine(index),
        );
      }
    }

    // --- cache ---------------------------------------------------------------
    // Membership-tested, indexed or `.get`-ed: the store is being CONSULTED.
    if (/\[/u.test(line) || /\bin\b/u.test(line) || /\.get\s*\(/u.test(line)) {
      const cache = identifiersMatching(line, CACHE_WORD);
      if (cache !== undefined) push("cache_lookup", cache.toLowerCase(), index, rawLine(index));
    }

    // --- accessor ------------------------------------------------------------
    const attribute = RETURN_ATTRIBUTE.exec(line);
    if (attribute !== null) push("attribute_return", attribute[1]!.toLowerCase(), index, rawLine(index));
  }

  const firstSuccess = detectFirstSuccessReturn(lines);
  if (firstSuccess !== undefined) {
    push("first_success_return", firstSuccess.subject, firstSuccess.lineOffset, rawLine(firstSuccess.lineOffset));
  }
  const fallback = detectFallbackBranch(lines, source);
  if (fallback !== undefined) {
    push(fallback.kind, fallback.subject, fallback.lineOffset, rawLine(fallback.lineOffset));
  }
  const conditional = detectConditionalChoice(lines);
  if (conditional !== undefined) {
    push("conditional_choice", "", conditional.lineOffset, rawLine(conditional.lineOffset));
  }

  return out;
}

/**
 * Container calls that WRAP the thing being ordered without being it. Labelling
 * `sorted(dict.fromkeys(families))` as ordering `fromkeys` says nothing; the
 * subject a request can match against is `families`.
 */
const WRAPPER_CALLS: ReadonlySet<string> = new Set([
  "tuple", "list", "set", "dict", "frozenset", "fromkeys", "sorted", "reversed",
  "iter", "enumerate", "len", "str", "int", "array", "object", "lambda", "self",
]);

/**
 * The first non-wrapper identifier after `from`: what is actually being ordered.
 * A keyword-argument NAME (`key=`, `reverse=`) is skipped — it labels an
 * argument rather than naming the collection the call operates on.
 */
function orderedOperand(line: string, from: number): string {
  const tail = line.slice(from);
  for (const match of tail.matchAll(/\b([A-Za-z_][A-Za-z0-9_.]*)\b\s*(=?)/gu)) {
    if (match[2] === "=") continue;
    const name = normalizeOperand(match[1]!);
    if (name.length > 0 && !WRAPPER_CALLS.has(name)) return name;
  }
  return "";
}

/** The first identifier on the line whose name matches `word`. */
function identifiersMatching(line: string, word: RegExp): string | undefined {
  for (const match of line.matchAll(/\b([A-Za-z_][A-Za-z0-9_.]*)\b/gu)) {
    const name = match[1]!;
    if (word.test(name.split(".").at(-1) ?? name)) return normalizeOperand(name);
  }
  return undefined;
}

/**
 * The precedence table this line CONSULTS, if any.
 *
 * A precedence-sounding name is not enough on its own: `order: list[int] =
 * list()` declares a variable and ranks nothing. The name must be subscripted —
 * the table is being read — or be the ordering criterion passed as `key=`.
 */
function priorityLookupOperand(line: string): string | undefined {
  for (const match of line.matchAll(/\b([A-Za-z_][A-Za-z0-9_.]*)\s*\[/gu)) {
    const name = match[1]!;
    if (PRIORITY_WORD.test(name.split(".").at(-1) ?? name)) return normalizeOperand(name);
  }
  const key = /\bkey\s*=/u.exec(line);
  if (key !== null) {
    const operand = orderedOperand(line, key.index + key[0].length);
    if (operand.length > 0 && PRIORITY_WORD.test(operand)) return operand;
  }
  return undefined;
}

function normalizeOperand(operand: string): string {
  return (operand.replace(/^self\./u, "").split(".").at(-1) ?? operand).toLowerCase();
}

/**
 * A loop whose body returns/breaks under a condition: the FIRST candidate that
 * satisfies the predicate wins, and the iteration order decides which that is.
 *
 * Both halves are required. A loop that returns unconditionally is not a search,
 * and a conditional return outside a loop is not a first-success.
 */
function detectFirstSuccessReturn(
  lines: readonly string[],
): { subject: string; lineOffset: number } | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const loop = /\bfor\s+(?:const\s+|let\s+|var\s+)?[A-Za-z_][A-Za-z0-9_,\s]*\s+(?:in|of)\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_.()]*)/u
      .exec(lines[index] ?? "");
    if (loop === null) continue;
    const indent = indentOf(lines[index] ?? "");
    let sawCondition = false;
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const line = lines[scan] ?? "";
      if (line.trim().length === 0) continue;
      // Left the loop body.
      if (indentOf(line) <= indent) break;
      if (/^\s*(?:if|elif|else\s+if)\b/u.test(line)) sawCondition = true;
      // `return None` inside a loop is a guard bailing out, not a candidate
      // being accepted. A first-success return must hand back a VALUE — that is
      // the difference between "this one wins" and "give up".
      const accepts = /^\s*break\b/u.test(line)
        || (/^\s*return\s+\S/u.test(line) && !/^\s*return\s+(?:None|null|undefined|False|false)\s*$/u.test(line));
      if (sawCondition && accepts) {
        return { subject: normalizeOperand(loop[1]!), lineOffset: scan };
      }
    }
  }
  return undefined;
}

/**
 * A secondary route taken because the primary produced nothing.
 *
 * `default_then_override` and `fallback_branch` are deliberately different
 * kinds: one has a value from the start and may replace it, the other has
 * nothing and must go and get one. A request about defaults and a request about
 * fallbacks are answered by different lines.
 */
function detectFallbackBranch(
  lines: readonly string[],
  source: string,
): { kind: MechanismFactKind; subject: string; lineOffset: number } | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    // The absence forms are captured; the bare `:`/`)` terminator that ends an
    // ordinary condition deliberately is NOT, because it must not be mistaken for
    // evidence that the guard tested emptiness.
    const guard = /\bif\s+(not\s+|!)?\(?\s*(?:self\.)?([A-Za-z_][A-Za-z0-9_.]*)\s*(?:(is\s+None|===?\s*(?:null|undefined|None))|\)?\s*[:)])/u
      .exec(line);
    if (guard === null) continue;
    const subject = normalizeOperand(guard[2]!);
    if (subject.length === 0) continue;
    // Did the guard test for ABSENCE, or for some other condition? That is what
    // separates the two kinds: code that has nothing and must go and get one is
    // falling back; code that already has a usable value and swaps it for a more
    // specific one is overriding a default. The same `x = f(...)` line means
    // different things under the two guards, and §35 and §18 ask about each
    // separately.
    const testsAbsence = guard[1] !== undefined || guard[3] !== undefined;
    const indent = indentOf(line);
    for (let scan = index + 1; scan < Math.min(lines.length, index + 6); scan += 1) {
      const body = lines[scan] ?? "";
      if (body.trim().length === 0) continue;
      if (indentOf(body) <= indent) break;
      // An assignment inside the conditional block. The name assigned here need
      // NOT be the name the guard tested: a fallback repairs the value it just
      // found empty (`if result is None: result = fallback(...)`), while an
      // override replaces a default under some other condition (`value =
      // DEFAULT; if config.timeout: value = read_timeout(...)`). Requiring the
      // two names to match would see only the first shape.
      const assignment = /^\s*(?:self\.)?([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]*)?=\s*[A-Za-z_][A-Za-z0-9_.]*\s*\(/u.exec(body);
      if (assignment !== null) {
        const assigned = normalizeOperand(assignment[1]!);
        if (testsAbsence && assigned === subject) {
          return { kind: "fallback_branch", subject, lineOffset: scan };
        }
        const assignedEarlier = new RegExp(
          String.raw`^\s*(?:self\.)?${escape(assigned)}\s*(?::[^=\n]*)?=`,
          "mu",
        ).test(lines.slice(0, index).join("\n"));
        if (!testsAbsence && assignedEarlier) {
          return { kind: "default_then_override", subject: assigned, lineOffset: scan };
        }
        if (testsAbsence && assignedEarlier) {
          return { kind: "fallback_branch", subject: assigned, lineOffset: scan };
        }
        continue;
      }
      // Same rule as the loop case: `if x is None: return None` is a guard
      // clause, not a fallback. A fallback produces an answer by another route.
      if (testsAbsence
        && /^\s*return\s+\S/u.test(body)
        && !/^\s*return\s+(?:None|null|undefined)\s*$/u.test(body)) {
        return { kind: "fallback_branch", subject, lineOffset: scan };
      }
    }
  }
  // `try: … except: <alternative>` is the other spelling of the same idea.
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*except\b|^\s*\}?\s*catch\b/u.test(lines[index] ?? "")) continue;
    for (let scan = index + 1; scan < Math.min(lines.length, index + 5); scan += 1) {
      if (/\breturn\b|=\s*[A-Za-z_][A-Za-z0-9_.]*\s*\(/u.test(lines[scan] ?? "")) {
        return { kind: "fallback_branch", subject: "", lineOffset: scan };
      }
    }
  }
  void source;
  return undefined;
}

/**
 * An if/elif chain in which each arm produces a different result. Requires a
 * genuine `elif`/`else if` (or an `else` with its own return) so that a single
 * guard clause — overwhelmingly the most common branch in any codebase — is not
 * reported as a choice between alternatives.
 */
function detectConditionalChoice(lines: readonly string[]): { lineOffset: number } | undefined {
  let firstBranch = -1;
  let arms = 0;
  let armsReturningValues = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!/^\s*(?:if|elif|else\s+if|else\b)/u.test(line)) continue;
    if (firstBranch < 0) firstBranch = index;
    if (/^\s*(?:elif|else\s+if)\b/u.test(line)) arms += 1;
    // Does THIS arm return a value? Counting every return in the body instead
    // lets a function with two unrelated early exits look like a choice between
    // alternatives, which is most functions.
    const indent = indentOf(line);
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const body = lines[scan] ?? "";
      if (body.trim().length === 0) continue;
      if (indentOf(body) <= indent) break;
      if (/^\s*return\s+\S/u.test(body) && !/^\s*return\s+(?:None|null|undefined)\s*$/u.test(body)) {
        armsReturningValues += 1;
        break;
      }
    }
  }
  if (arms >= 1 && firstBranch >= 0 && armsReturningValues >= 2) {
    return { lineOffset: firstBranch };
  }
  return undefined;
}

/**
 * Does the statement at `lineOffset` produce the definition's result?
 *
 * Two shapes count, and the second is deliberately ONE hop rather than a full
 * data-flow analysis. Chasing assignments transitively would relink almost every
 * statement in a body to its return — `group` -> `groups` -> `return len(groups)`
 * makes an incidental index look decisive — and the whole value of this property
 * is that it is narrow. A mechanism whose own output is returned is answering
 * the question; one whose output is transformed twice more is plumbing.
 */
function producesResult(lines: readonly string[], lineOffset: number): boolean {
  const line = lines[lineOffset] ?? "";
  // The statement IS the result.
  if (/^\s*(?:return|yield)\s+\S/u.test(line) && !/^\s*return\s+(?:None|null|undefined)\s*$/u.test(line)) {
    return true;
  }
  // The statement assigns names that a later return/yield names directly.
  const assignment = /^\s*(?:const\s+|let\s+|var\s+)?([A-Za-z_][A-Za-z0-9_.,\s]*?)\s*(?::[^=\n]*)?=(?!=)/u.exec(line);
  if (assignment === null) return false;
  const assigned = (assignment[1] ?? "")
    .split(",")
    .map((name) => (name.trim().replace(/^self\./u, "").split(".").at(-1) ?? "").trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name));
  if (assigned.length === 0) return false;
  for (let scan = lineOffset + 1; scan < lines.length; scan += 1) {
    const later = lines[scan] ?? "";
    if (!/^\s*(?:return|yield)\b/u.test(later)) continue;
    for (const name of assigned) {
      // The name must appear as a VALUE, not as an attribute or method of
      // something else. `group` and `match.group(1)` are unrelated, and counting
      // the second made `get_reactant_num` look as if its first-reactant index
      // produced the number it returns — it returns a length computed from a
      // different variable entirely.
      if (new RegExp(String.raw`(?<![.\w])${escape(name)}\b`, "u").test(later)) return true;
    }
  }
  return false;
}

function indentOf(line: string): number {
  const match = /^[ \t]*/u.exec(line);
  return match === null ? 0 : match[0].length;
}

/**
 * Build the per-symbol mechanism-fact rows for a file. Each body is sliced by
 * BYTE range exactly as the body-literal lane does, so both derive from the same
 * bytes and can never disagree about what a definition contains. Pure: no DB.
 */
export function buildSymbolMechanismFacts(
  symbols: readonly SymbolRecord[],
  content: string,
): SymbolMechanismFacts[] {
  if (symbols.length === 0 || content.length === 0) return [];
  const bytes = Buffer.from(content, "utf8");
  const out: SymbolMechanismFacts[] = [];
  for (const symbol of symbols) {
    if (!MECHANISM_BEARING_KINDS.has(symbol.kind)) continue;
    const body = bytes.subarray(symbol.startByte, symbol.endByte).toString("utf8");
    const facts = extractMechanismFacts(body, {
      decorators: symbol.decorators,
      kind: symbol.kind,
    });
    if (facts.length === 0) continue;
    out.push({ symbolId: symbol.id, facts });
  }
  return out;
}
