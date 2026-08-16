// M151: the path and symbol hints a product request carries, for workspace routing.
//
// WHY THIS EXISTS AT ALL
// ----------------
// `nominateRepositories` consumes `pathHints` and `symbolHints`. Every M146-M149
// caller was a benchmark that supplied them literally, so nothing in the product
// ever derived them from a request. Wiring routing into `get_code_context` needs
// that step, and it is the only new reasoning M151 adds (§6).
//
// WHAT IT MUST NOT DO
// ----------------
// The router's own contract says "prose tokens do not belong here", and §73-§75
// sharpen that into a product requirement: a repository must never be chosen
// because a query mentions its name. The extractor is therefore deliberately
// STRICT rather than generous. A hint has to be shaped like something a person
// typed to name a file or a definition — a slash and an extension, an underscore,
// a qualifier, a call, or an explicit quotation. Bare words never qualify, and a
// bare all-caps acronym never qualifies, because `ARC` is exactly the token whose
// promotion to symbol evidence §74 exists to prevent.
//
// Missing a real hint costs a routing lane and falls through to the configured
// authority. Inventing one routes a request to the wrong repository. The
// asymmetry is why every rule here errs toward emitting nothing.

/** Bounded so a pathological query cannot turn into an unbounded probe list. */
export const MAX_PATH_HINTS = 8;
export const MAX_SYMBOL_HINTS = 8;

export interface QueryRouteHints {
  readonly pathHints: readonly string[];
  readonly symbolHints: readonly string[];
}

/** Characters that routinely bracket a path or name in prose. */
const TRIM_PATTERN = /^[\s'"`(\[{<,;:]+|[\s'"`)\]}>,;:.!?]+$/gu;

/** `foo.py`, `foo.tsx` — an extension, not a qualified name. */
const FILE_EXTENSION_PATTERN = /\.[A-Za-z][A-Za-z0-9]{0,7}$/u;

/** A single identifier segment. */
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** `pkg.mod.foo` or `Class::method` — a qualifier, not a filename. */
const QUALIFIED_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:(?:::|\.)[A-Za-z_][A-Za-z0-9_]*)+$/u;

/**
 * A lowercase-to-uppercase transition. `determineFamily` and `MyClass` qualify;
 * `ARC`, `TCKDB` and `HTTP` do not, which is the point.
 */
const CAMEL_TRANSITION_PATTERN = /[a-z][A-Z]/u;

function strip(token: string): string {
  return token.replace(TRIM_PATTERN, "");
}

/**
 * A path hint is a token holding a separator, plus either an extension or an
 * absolute root. `src/foo.py`, `/home/x/repo/src/foo.py` and `a/b/c` with an
 * extension qualify; `and/or` does not.
 */
function isPathHint(token: string): boolean {
  if (!token.includes("/")) return false;
  if (token.startsWith("//")) return false;
  if (token.includes("://")) return false;
  if (token.startsWith("/")) return true;
  return FILE_EXTENSION_PATTERN.test(token);
}

/**
 * A symbol hint is a token a person could only have typed to name a definition:
 * an underscore-bearing identifier, a qualified name, or a call. Everything else
 * — including any single bare word — is prose.
 */
function isSymbolHint(token: string): boolean {
  if (token.length < 3) return false;
  if (QUALIFIED_PATTERN.test(token) && !FILE_EXTENSION_PATTERN.test(token)) return true;
  if (!IDENTIFIER_PATTERN.test(token)) return false;
  // `_leading` and `snake_case` are named, never spoken.
  if (token.includes("_")) return true;
  return CAMEL_TRANSITION_PATTERN.test(token);
}

function pushUnique(target: string[], value: string, limit: number): void {
  if (target.length >= limit || target.includes(value)) return;
  target.push(value);
}

/**
 * Derive routing hints from a request.
 *
 * `explicitPaths` carries paths the caller stated structurally (a `paths`
 * argument, a failure frame) rather than inside prose. Those are trusted as
 * given: they were not guessed out of a sentence, so they skip the shape test.
 */
export function extractQueryRouteHints(
  query: string,
  explicitPaths: readonly string[] = [],
): QueryRouteHints {
  const pathHints: string[] = [];
  const symbolHints: string[] = [];

  for (const explicit of explicitPaths) {
    const trimmed = explicit.trim();
    if (trimmed.length > 0) pushUnique(pathHints, trimmed, MAX_PATH_HINTS);
  }

  // Backticked spans are an explicit quotation of code, so a single bare word
  // inside them IS a name the caller chose to mark as one.
  for (const match of query.matchAll(/`([^`]+)`/gu)) {
    const quoted = strip(match[1] ?? "");
    if (quoted.length === 0 || /\s/u.test(quoted)) continue;
    if (isPathHint(quoted)) {
      pushUnique(pathHints, quoted, MAX_PATH_HINTS);
    } else if (IDENTIFIER_PATTERN.test(quoted) || QUALIFIED_PATTERN.test(quoted)) {
      pushUnique(symbolHints, quoted, MAX_SYMBOL_HINTS);
    }
  }

  for (const raw of query.split(/\s+/u)) {
    // Read the call marker from the RAW token: the trailing-punctuation strip
    // removes `)` and would erase the very evidence that this is a call.
    const called = /\(\s*\)/u.test(raw);
    const token = strip(raw).replace(/\($/u, "");
    if (token.length === 0) continue;

    if (isPathHint(token)) {
      pushUnique(pathHints, token, MAX_PATH_HINTS);
      continue;
    }
    if (called && (IDENTIFIER_PATTERN.test(token) || QUALIFIED_PATTERN.test(token))) {
      pushUnique(symbolHints, token, MAX_SYMBOL_HINTS);
      continue;
    }
    if (isSymbolHint(token)) {
      pushUnique(symbolHints, token, MAX_SYMBOL_HINTS);
    }
  }

  return { pathHints, symbolHints };
}
