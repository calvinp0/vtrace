import { deriveQueryIntent, type DerivedQueryIntent } from "../retrieval/querySemantics";

// SWE-bench query shaping.
//
// A raw SWE-bench issue is mostly prose: a long problem statement plus optional
// hints. Feeding that whole blob to retrieval (and re-injecting it as context)
// both dilutes the signal and duplicates text the agent already receives. This
// helper distils a record down to the things that actually steer retrieval:
//
//   - failing test node ids (and the file/class/method names inside them)
//   - explicit file paths and repo-relative path strings
//   - def/class/function names and backtick-quoted identifiers
//   - snake_case / CamelCase / dotted identifiers from the prose
//
// The shaped `query` is a compact, signal-first string — NOT a copy of the full
// issue — suitable for `vtrace capsule`.

export interface SweIssueRecord {
  repo?: string;
  instanceId?: string;
  problemStatement?: string;
  hintsText?: string | null;
  failToPass?: readonly string[];
}

export interface ShapedSweQuery {
  /** Compact, signal-first query string for retrieval. */
  query: string;
  /** Normalised failing-test node ids. */
  failingTests: string[];
  /** Likely edit-target files / path-like strings, first-seen order. */
  likelyFiles: string[];
  /** Likely symbols (functions, classes, methods, backtick identifiers). */
  likelySymbols: string[];
  /** Broader identifier set surfaced from the prose. */
  identifiers: string[];
  /**
   * Generic bug-report tokens (e.g. `error`, `multiple`) that matched a symbol
   * regex but were dropped from `likelySymbols` because they carry no edit-target
   * signal on their own. Surfaced for diagnostics, not used by retrieval.
   */
  filteredGenericSymbols: string[];
  /**
   * Runner / entry scripts (e.g. `manage.py`) mentioned only as a command
   * invocation, dropped from `likelyFiles` so they do not masquerade as edit
   * targets. Surfaced for diagnostics, not used by retrieval.
   */
  filteredRunnerFiles: string[];
  /** Component-aware repository path clues embedded in otherwise broad prose. */
  pathClues?: EmbeddedPathClue[];
  /** Request-local deterministic polarity and identifier-confidence derivation. */
  derivedIntent?: DerivedQueryIntent;
}

export interface EmbeddedPathClue {
  raw: string;
  normalized: string;
  kind: "path" | "filename";
}

export interface ShapeSweQueryOptions {
  /** Hard cap on the shaped query length. */
  maxQueryChars?: number;
  maxFiles?: number;
  maxSymbols?: number;
  maxIdentifiers?: number;
  /** Known repository-name aliases, used only to reject project-as-symbol noise. */
  projectNameAliases?: ReadonlySet<string>;
  /**
   * Does a path named by the task belong to the ACTIVE repository? (M144)
   * Passed straight to `deriveQueryIntent`, which uses it to ignore traceback
   * frames from the standard library or the reporter's own machine. Omitted
   * means "unknown", and unknown changes nothing.
   */
  isRepositoryPath?: (pathHint: string) => boolean;
  performanceProfile?: {
    timingsMs: Record<string, number>;
    counters: Record<string, number>;
  };
}

const DEFAULT_OPTIONS = Object.freeze({
  maxQueryChars: 1_200,
  maxFiles: 12,
  maxSymbols: 16,
  maxIdentifiers: 24,
});

// Source-file extensions we treat as path signals. Kept deliberately small so
// prose like "e.g." or "v1.2" is not mistaken for a file.
const CODE_EXTENSIONS = [
  "py", "pyx", "pyi", "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "go", "rb", "rs", "java", "kt", "c", "cc", "cpp", "h", "hpp", "php", "scala",
];

const FILE_LIKE = new RegExp(
  String.raw`\b[\w./-]+\.(?:${CODE_EXTENSIONS.join("|")})\b`,
  "g",
);
const REPO_PATH_LIKE = /\b[a-z][\w-]*(?:\/[\w.-]+){2,}\b/g;
const EMBEDDED_PATH_LIKE = /(?:^|[\s("'`])((?:\.\/)?(?:\.[A-Za-z0-9_-]+|[A-Za-z0-9_-]+)(?:\/[A-Za-z0-9_.-]+)+(?:\/)?)/gmu;
const CONFIG_FILE_LIKE = /(?:^|[\s("'`])([A-Za-z0-9_.-]+\.(?:ya?ml|toml))\b/gimu;
const SNAKE_CASE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const CAMEL_CASE = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g;
const DOTTED_PATH = /\b[a-z_][\w]*(?:\.[a-z_][\w]*){2,}\b/gi;

// Generic bug-report vocabulary. These words routinely appear in issue prose and
// the symbol regexes above happily capture them (`error(`, "multiple", backticks),
// but on their own they steer retrieval toward whatever code happens to share the
// word (`error` -> error handlers, `multiple` -> `multiple_chunks`) rather than the
// real edit target. We drop them as HIGH-CONFIDENCE signals only: they stay in the
// raw prose lead (so BM25/full-text scoring still sees them), but they never become
// likely symbols, seed symbol search, drive subsystem selection, or produce a
// path/symbol boost on their own. Matching is exact (whole token), so compound
// names like `multiple_chunks` or `create_model` are untouched.
export const GENERIC_TOKEN_STOPLIST: ReadonlySet<string> = new Set([
  "error", "errors", "exception", "exceptions", "failed", "failure", "failures",
  "multiple", "single", "same", "different", "issue", "issues", "bug", "bugs",
  "problem", "problems", "change", "changes", "support", "create", "created",
  "update", "updated", "delete", "deleted", "run", "runs", "running",
  "command", "commands",
]);

// Runner / entry scripts. A bug report that merely shows `python manage.py check`
// is naming a command invocation, not a production edit target. We drop such bare
// script mentions from `likelyFiles`. An EXPLICIT repo-relative path (one carrying
// a directory, e.g. `tests/runtests.py`) is a deliberate pointer and is kept.
export const RUNNER_SCRIPTS: ReadonlySet<string> = new Set([
  "manage.py", "setup.py", "runtests.py", "pytest.ini", "tox.ini", "setup.cfg",
]);

function isGenericSymbol(symbol: string): boolean {
  return GENERIC_TOKEN_STOPLIST.has(symbol.toLowerCase());
}

function isRunnerScriptNoise(file: string): boolean {
  // Only a bare basename mention (no directory) is command-invocation noise; an
  // explicit path with a directory component strongly points at the file.
  if (file.includes("/")) {
    return false;
  }
  return RUNNER_SCRIPTS.has(file.toLowerCase());
}

interface Partitioned {
  kept: string[];
  filtered: string[];
}

function partition(values: readonly string[], isNoise: (value: string) => boolean): Partitioned {
  const kept: string[] = [];
  const filtered: string[] = [];
  for (const value of values) {
    (isNoise(value) ? filtered : kept).push(value);
  }
  return { kept, filtered };
}

export function shapeSweQuery(
  record: SweIssueRecord,
  options: ShapeSweQueryOptions = {},
): ShapedSweQuery {
  const { performanceProfile, projectNameAliases, isRepositoryPath, ...shapeOptions } = options;
  const config = { ...DEFAULT_OPTIONS, ...stripUndefined(shapeOptions) };
  const problem = (record.problemStatement ?? "").trim();
  const hints = (record.hintsText ?? "").trim();
  const prose = `${problem}\n${hints}`;
  const derivedIntent = deriveQueryIntent(prose, { projectNameAliases, isRepositoryPath });
  const positiveProse = derivedIntent.positiveSearchText;

  const failingTests = dedupeNonEmpty((record.failToPass ?? []).map((id) => id.trim()));
  const testParts = failingTests.flatMap(parseTestNodeId);

  // URLs are pure noise for the file/path signal: their path tails (e.g.
  // `.../django/django/pull/7920`, google-groups `.../searchin/django-users/...`)
  // otherwise match REPO_PATH_LIKE and masquerade as edit targets. Strip them
  // before path extraction. Symbol extraction keeps the full prose.
  const prosePaths = stripUrls(positiveProse);
  const pathClueStarted = performanceProfile === undefined ? 0 : performance.now();
  const pathClues = extractEmbeddedPathClues(prosePaths);
  if (performanceProfile !== undefined) {
    performanceProfile.timingsMs.path_clue_extraction =
      (performanceProfile.timingsMs.path_clue_extraction ?? 0)
      + performance.now() - pathClueStarted;
    performanceProfile.counters.path_clues = pathClues.length;
  }

  const rawFiles = dedupeNonEmpty(
    [
      ...testParts.flatMap((part) => (part.file ? [part.file] : [])),
      ...matchAll(prosePaths, FILE_LIKE),
      ...matchAll(prosePaths, REPO_PATH_LIKE).filter(looksLikeRepoPath),
    ]
      // Diff headers surface the same file twice as `a/<path>` and `b/<path>`;
      // normalise the prefix away so both collapse to the real path (and so the
      // file count is not inflated, which would wrongly flip crossModule).
      .map(stripDiffPrefix),
  );
  // Drop bare runner/entry-script mentions (a command invocation, not an edit
  // target) before capping; record them for diagnostics.
  const fileParts = partition(rawFiles, isRunnerScriptNoise);
  const likelyFiles = capped(fileParts.kept, config.maxFiles);
  const filteredRunnerFiles = fileParts.filtered;
  const additivePathClues = pathClues.filter((clue) =>
    !likelyFiles.some((file) => normalizePathClue(file) === clue.normalized));

  const rawSymbols = dedupeNonEmpty([
    ...testParts.flatMap((part) => part.symbols),
    ...derivedIntent.symbolHypotheses
      .map((signal) => signal.source === "backtick" ? signal.term : explicitIdentifierSeed(signal.term))
      .filter((value): value is string => value !== null),
  ]);
  // Drop generic bug-report words before capping so a real symbol is never
  // crowded out of the cap by noise; record the dropped tokens for diagnostics.
  const symbolParts = partition(rawSymbols, isGenericSymbol);
  const likelySymbols = capped(symbolParts.kept, config.maxSymbols);
  const filteredGenericSymbols = symbolParts.filtered;

  const identifiers = capped(
    dedupeNonEmpty([
      ...likelySymbols,
      ...matchAll(positiveProse, CAMEL_CASE),
      ...matchAll(positiveProse, SNAKE_CASE),
      ...matchAll(positiveProse, DOTTED_PATH),
    ]),
    config.maxIdentifiers,
  );

  return {
    query: assembleQuery({ record, failingTests, likelyFiles, likelySymbols, problem: derivedIntent.positiveSearchText }, config.maxQueryChars),
    failingTests,
    likelyFiles,
    likelySymbols,
    identifiers,
    filteredGenericSymbols,
    filteredRunnerFiles,
    derivedIntent,
    ...(additivePathClues.length === 0 ? {} : { pathClues: additivePathClues }),
  };
}

export function extractEmbeddedPathClues(text: string): EmbeddedPathClue[] {
  const withoutUrls = stripUrls(text);
  const clues: EmbeddedPathClue[] = [];
  for (const match of withoutUrls.matchAll(new RegExp(EMBEDDED_PATH_LIKE.source, EMBEDDED_PATH_LIKE.flags))) {
    const raw = match[1] ?? "";
    const normalized = normalizePathClue(raw);
    if (normalized.includes("/")) clues.push({ raw, normalized, kind: "path" });
  }
  for (const match of withoutUrls.matchAll(new RegExp(CONFIG_FILE_LIKE.source, CONFIG_FILE_LIKE.flags))) {
    const raw = match[1] ?? "";
    clues.push({ raw, normalized: normalizePathClue(raw), kind: "filename" });
  }
  return dedupeClues(clues);
}

function normalizePathClue(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//u, "").replace(/\/+$/u, "").toLowerCase();
}

function dedupeClues(clues: readonly EmbeddedPathClue[]): EmbeddedPathClue[] {
  const seen = new Set<string>();
  return clues.filter((clue) => {
    const key = `${clue.kind}:${clue.normalized}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface TestNodeParts {
  file?: string;
  symbols: string[];
}

// Handle both pytest ("a/b/test_x.py::TestY::test_z") and Django dotted
// ("a.b.test_x.TestY.test_z") node ids.
export function parseTestNodeId(nodeId: string): TestNodeParts {
  const trimmed = nodeId.trim();

  if (trimmed.includes("::")) {
    const [file, ...rest] = trimmed.split("::");
    return {
      ...(file && file.length > 0 ? { file } : {}),
      symbols: dedupeNonEmpty(rest),
    };
  }

  const segments = trimmed.split(".").filter((segment) => segment.length > 0);
  // The class is the first CamelCase segment; everything from there on (class +
  // method) is a meaningful symbol. The leading dotted path is the module
  // (file is ambiguous, so we leave it out). With no class, the trailing
  // test_* segment is the symbol.
  const classIndex = segments.findIndex((segment) => /^[A-Z]/.test(segment));
  const symbols = classIndex === -1
    ? segments.slice(-1).filter((segment) => segment.startsWith("test_"))
    : segments.slice(classIndex);

  return { symbols: dedupeNonEmpty(symbols) };
}

interface AssembleQueryInput {
  record: SweIssueRecord;
  failingTests: string[];
  likelyFiles: string[];
  likelySymbols: string[];
  problem: string;
}

function assembleQuery(input: AssembleQueryInput, maxChars: number): string {
  const lines: string[] = [];

  if (input.record.repo) {
    lines.push(`repo: ${input.record.repo}`);
  }
  if (input.failingTests.length > 0) {
    lines.push(`failing tests: ${input.failingTests.join(" ")}`);
  }
  if (input.likelyFiles.length > 0) {
    lines.push(`files: ${input.likelyFiles.join(" ")}`);
  }
  if (input.likelySymbols.length > 0) {
    lines.push(`symbols: ${input.likelySymbols.join(" ")}`);
  }

  // A short lead of the problem statement keeps natural-language recall without
  // re-dumping the whole issue. We take the first sentence/line, bounded.
  const lead = firstSentence(input.problem);
  if (lead.length > 0) {
    lines.push(`issue: ${lead}`);
  }

  const query = lines.join("\n").trim();
  return query.length > maxChars ? query.slice(0, maxChars).trimEnd() : query;
}

function firstSentence(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return "";
  }

  const boundary = collapsed.search(/[.!?]\s/);
  const sentence = boundary === -1 ? collapsed : collapsed.slice(0, boundary + 1);
  return sentence.length > 280 ? `${sentence.slice(0, 280).trimEnd()}…` : sentence;
}

function matchAll(text: string, pattern: RegExp): string[] {
  return Array.from(text.matchAll(new RegExp(pattern.source, pattern.flags)), (m) => m[0]);
}

function matchAllCaptured(text: string, pattern: RegExp): string[] {
  return Array.from(text.matchAll(new RegExp(pattern.source, pattern.flags)), (m) => m[1] ?? "");
}

function looksLikeRepoPath(value: string): boolean {
  // Require at least one segment that looks like a directory name, and avoid
  // URLs / version strings.
  return !value.includes("://") && value.split("/").every((segment) => segment.length > 0);
}

// Remove http/https URLs so their path tails do not leak into the file signal.
// We blank them (not delete) so adjacent words keep their boundaries.
function stripUrls(text: string): string {
  return text.replace(/\bhttps?:\/\/\S+/gi, " ");
}

// Diff hunks reference files as `a/<path>` (old) and `b/<path>` (new); both name
// the same file. Strip a single leading `a/` or `b/` so they normalise together.
export function stripDiffPrefix(value: string): string {
  return value.replace(/^[ab]\//, "");
}

function identifierLeaf(value: string): string {
  return value.split(/::|\./u).at(-1) ?? value;
}

/**
 * Promote only identifiers whose syntax makes the leaf an unambiguous lookup
 * request. Repository FQNs (`path::symbol`) and short contextual symbols need
 * this bridge. A prose-qualified value such as `app.Model.origin` stays in the
 * broader identifier/FTS lanes: promoting its generic leaf would search every
 * unrelated `origin` symbol in the repository.
 */
function explicitIdentifierSeed(value: string): string | null {
  const leaf = identifierLeaf(value);
  if (value.includes("::") || !value.includes(".") || leaf.length <= 3) return leaf;
  return null;
}

function dedupeNonEmpty(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }

  return out;
}

function capped<T>(values: T[], max: number): T[] {
  return max >= 0 && values.length > max ? values.slice(0, max) : values;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
