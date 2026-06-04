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
}

export interface ShapeSweQueryOptions {
  /** Hard cap on the shaped query length. */
  maxQueryChars?: number;
  maxFiles?: number;
  maxSymbols?: number;
  maxIdentifiers?: number;
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
const DEF_CLASS = /\b(?:def|class|function|func|fn)\s+([A-Za-z_]\w*)/g;
const BACKTICK_IDENT = /`([A-Za-z_][\w.]*(?:\(\))?)`/g;
// Bare call mentions in prose, e.g. "get_combinator_sql()" or "json_script(".
const FUNC_CALL = /\b([A-Za-z_]\w*)\s*\(/g;
const SNAKE_CASE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const CAMEL_CASE = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g;
const DOTTED_PATH = /\b[a-z_][\w]*(?:\.[a-z_][\w]*){2,}\b/gi;

export function shapeSweQuery(
  record: SweIssueRecord,
  options: ShapeSweQueryOptions = {},
): ShapedSweQuery {
  const config = { ...DEFAULT_OPTIONS, ...stripUndefined(options) };
  const problem = (record.problemStatement ?? "").trim();
  const hints = (record.hintsText ?? "").trim();
  const prose = `${problem}\n${hints}`;

  const failingTests = dedupeNonEmpty((record.failToPass ?? []).map((id) => id.trim()));
  const testParts = failingTests.flatMap(parseTestNodeId);

  // URLs are pure noise for the file/path signal: their path tails (e.g.
  // `.../django/django/pull/7920`, google-groups `.../searchin/django-users/...`)
  // otherwise match REPO_PATH_LIKE and masquerade as edit targets. Strip them
  // before path extraction. Symbol extraction keeps the full prose.
  const prosePaths = stripUrls(prose);

  const likelyFiles = capped(
    dedupeNonEmpty(
      [
        ...testParts.flatMap((part) => (part.file ? [part.file] : [])),
        ...matchAll(prosePaths, FILE_LIKE),
        ...matchAll(prosePaths, REPO_PATH_LIKE).filter(looksLikeRepoPath),
      ]
        // Diff headers surface the same file twice as `a/<path>` and `b/<path>`;
        // normalise the prefix away so both collapse to the real path (and so the
        // file count is not inflated, which would wrongly flip crossModule).
        .map(stripDiffPrefix),
    ),
    config.maxFiles,
  );

  const likelySymbols = capped(
    dedupeNonEmpty([
      ...testParts.flatMap((part) => part.symbols),
      ...matchAllCaptured(prose, DEF_CLASS),
      ...matchAllCaptured(prose, BACKTICK_IDENT).map(stripCallSuffix),
      ...matchAllCaptured(prose, FUNC_CALL),
    ]),
    config.maxSymbols,
  );

  const identifiers = capped(
    dedupeNonEmpty([
      ...likelySymbols,
      ...matchAll(prose, CAMEL_CASE),
      ...matchAll(prose, SNAKE_CASE),
      ...matchAll(prose, DOTTED_PATH),
    ]),
    config.maxIdentifiers,
  );

  return {
    query: assembleQuery({ record, failingTests, likelyFiles, likelySymbols, problem }, config.maxQueryChars),
    failingTests,
    likelyFiles,
    likelySymbols,
    identifiers,
  };
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

function stripCallSuffix(value: string): string {
  return value.endsWith("()") ? value.slice(0, -2) : value;
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
