// Stage 5 shared task derivation (M103).
//
// WHY THIS EXISTS
// ----------------
// Until M102 the deterministic Stage 5 task was `deriveTaskFromProblemStatement`
// (title + first substantive prose sentence, word-safe 360-char cap), living in
// the fixture builder. The M102 audit showed that derivation structurally loses
// gold evidence sitting in code blocks / tracebacks, and that the ONLY
// net-positive fix among 8 measured variants is V5_title_plus_errors: keep the
// prose base and append EXTRACTED exception names, failing-test ids and capped
// traceback frames (longer prose windows and full problem text are net-harmful).
//
// M103 promotes exactly that shape to the default Stage 5 derivation. This
// module hosts BOTH:
//   - the unchanged V0 base (`deriveTaskFromProblemStatement`, moved verbatim
//     from build_stage5_retrieval_fixture.ts so frozen M94–M102 runners keep
//     reproducing their historical task text), and
//   - `deriveStructuredTaskFromProblemStatement`, the M103 default, whose
//     `taskText` is BYTE-IDENTICAL to M102's V5 variant (same extraction
//     regexes and caps: ≤6 exceptions, ≤6 failing tests, ≤8 traceback frames
//     with head+tail selection, whole-section trimming under a 1200-char total
//     cap). Reproducing the measured winner exactly is deliberate — the caps
//     are frozen here rather than re-tuned.
//
// PROVENANCE / LEAKAGE: every function here reads the PROBLEM STATEMENT alone —
// no parameter can carry the gold patch, FAIL_TO_PASS, or any benchmark
// metadata. The structured result records provenance = "issue_problem_statement"
// so downstream scoring can distinguish issue-authored evidence (legitimate,
// even when the issue names a gold file) from gold-patch leakage (blocked; see
// `assessGoldLeakage` in stage5_m94_lib.ts).
//
// NO Claude, NO Docker, NO agent run, NO API calls.

// ---------------------------------------------------------------------------
// V0 base derivation (moved verbatim from build_stage5_retrieval_fixture.ts)
// ---------------------------------------------------------------------------

// Common abbreviations whose internal/trailing period is NOT a sentence end. A
// naive `.`-then-space split truncates "Attempting to get e.g. http://…" right
// after "e.g." and throws away the rest of the problem statement (and any source
// anchor it carries). Matched case-insensitively against the dotted token.
const SENTENCE_ABBREVIATIONS: ReadonlySet<string> = new Set([
  "e.g.",
  "i.e.",
  "etc.",
  "vs.",
  "mr.",
  "mrs.",
  "dr.",
  "prof.",
]);

// An explicit source anchor: a file path carrying a line reference, e.g.
// `requests/models.py#L401`, `file.py#L10-L20`, `path/to/file.py:123`. These are
// high-signal retrieval clues, so task derivation must keep them intact rather
// than splitting/truncating through them.
const SOURCE_ANCHOR_RE = /[\w./-]+\.[A-Za-z]\w*(?:#L\d+(?:-L?\d+)?|:\d+(?:-\d+)?)/;

// Is the `.` at `dotIdx` the tail of a known abbreviation (so NOT a sentence end)?
// Walks back over the run of letters/dots ending at the period and matches the
// dotted token (e.g. "e.g.", "etc.") case-insensitively.
function endsWithAbbreviation(text: string, dotIdx: number): boolean {
  let start = dotIdx;
  while (start > 0 && /[A-Za-z.]/.test(text[start - 1]!)) start -= 1;
  return SENTENCE_ABBREVIATIONS.has(text.slice(start, dotIdx + 1).toLowerCase());
}

// Split prose into sentences on `.!?` followed by whitespace/end — but NOT after a
// known abbreviation, and NOT on a period that is not followed by whitespace (the
// dots inside `models.py#L401` or a URL are never boundaries). Deterministic.
export function splitSentencesSafe(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const boundary = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text)) !== null) {
    const idx = match.index;
    if (text[idx] === "." && endsWithAbbreviation(text, idx)) continue;
    const sentence = text.slice(start, idx + 1).trim();
    if (sentence.length > 0) out.push(sentence);
    start = idx + 1;
  }
  const tail = text.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

// Derive the `task` prose from a SWE-bench problem_statement: the title line plus
// the first substantive sentence of the description (extended through a later
// sentence when it carries an explicit source anchor). Deterministic and NOT tuned
// to the answer — it never reads the patch. Zero-width and control chars are
// stripped; the result is capped (word-safe, so anchors are never cut mid-token)
// so the capsule gets a focused signal.
export function deriveTaskFromProblemStatement(problemStatement: string, maxLen = 360): string {
  const cleaned = problemStatement.replace(/[​‌‍﻿]/g, "").replace(/\r/g, "");
  const lines = cleaned.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return "";
  const title = lines[0]!;
  // First body sentence: skip the literal "Description" marker and any line that
  // is not prose — code (def/class/decorator/traceback/assignment), a bare Python
  // keyword (`pass`, `return`), a shell/command invocation, or too short to be a
  // sentence. The title already carries the headline signal; the body sentence is
  // only useful when it ADDS prose context.
  const looksLikeCode = (l: string): boolean =>
    /^(class |def |@|>>>|Traceback|File "|\$ |\.\/|python[0-9. ]|\.\/manage|manage\.py)/.test(l) ||
    /^[A-Za-z_][\w.]*\s*=[^=]/.test(l) ||
    /^(pass|return|raise|continue|break|import |from )\b/.test(l) ||
    l.split(/\s+/).length < 3;
  let body = "";
  for (const line of lines.slice(1)) {
    if (/^description$/i.test(line)) continue;
    if (looksLikeCode(line)) continue;
    body = line;
    break;
  }
  // First substantive sentence (abbreviation-aware), extended through the first
  // later sentence that carries an explicit source anchor so that high-signal
  // anchor (e.g. `requests/models.py#L401`) survives instead of being dropped.
  const sentences = splitSentencesSafe(body);
  let excerpt = sentences[0] ?? body;
  const anchorIdx = sentences.findIndex((s) => SOURCE_ANCHOR_RE.test(s));
  if (anchorIdx > 0) excerpt = sentences.slice(0, anchorIdx + 1).join(" ");
  const combined = excerpt && !title.endsWith(excerpt) ? `${title} — ${excerpt}` : title;
  if (combined.length <= maxLen) return combined;
  // Word-safe truncation: cut at the last space in the tail region so an anchor /
  // URL token is kept whole or dropped, never sliced through.
  const hard = combined.slice(0, maxLen - 1);
  const lastSpace = hard.lastIndexOf(" ");
  const safe = lastSpace > Math.floor(maxLen * 0.6) ? hard.slice(0, lastSpace) : hard;
  return `${safe.trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Structured evidence extraction (frozen to the M102 V5 semantics)
// ---------------------------------------------------------------------------

/** Caps frozen to the measured M102 V5 variant (all within the M103 bounds). */
export const MAX_TASK_EXCEPTIONS = 6;
export const MAX_TASK_FAILING_TESTS = 6;
export const MAX_TASK_TRACEBACK_FRAMES = 8;
/** Cap on the WHOLE composed task text (base + evidence); the base is never trimmed. */
export const MAX_STRUCTURED_TASK_CHARS = 1200;

function cleanStatement(problemStatement: string): string {
  return problemStatement.replace(/[​‌‍﻿]/g, "").replace(/\r/g, "").trim();
}

/** Word-safe prefix: never cuts through a token; appends an ellipsis when cut. */
function wordSafePrefix(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const hard = text.slice(0, maxLen - 1);
  const lastBreak = Math.max(hard.lastIndexOf(" "), hard.lastIndexOf("\n"));
  const safe = lastBreak > Math.floor(maxLen * 0.6) ? hard.slice(0, lastBreak) : hard;
  return `${safe.trimEnd()}…`;
}

// Dedupe on exact token, preserving first-occurrence order, then cap. Also
// reports how many unique tokens existed before the cap so diagnostics can say
// what was omitted.
function dedupeCapCounted(values: readonly string[], cap: number): { kept: string[]; unique: number } {
  const seen = new Set<string>();
  const all: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (t.length === 0 || seen.has(t)) continue;
    seen.add(t);
    all.push(t);
  }
  return { kept: all.slice(0, cap), unique: all.length };
}

/**
 * Exception/warning class names (`ValueError`, `MiddlewareNotUsed` is NOT one):
 * CamelCase identifiers ending Error/Exception/Warning. Deduped exact,
 * first-occurrence order, capped. Never full prose sentences.
 */
export function extractExceptionNames(
  text: string,
  cap = MAX_TASK_EXCEPTIONS,
): { kept: string[]; unique: number } {
  const found: string[] = [];
  for (const m of text.matchAll(/\b[A-Z][A-Za-z0-9]*(?:Error|Exception|Warning)\b/g)) {
    found.push(m[0]!);
  }
  return dedupeCapCounted(found, cap);
}

/**
 * Failing-test identifiers: pytest node ids (`path/to/test_x.py::TestC::test_y`)
 * first, then bare `test_*` names. Full node ids are collected before bare
 * names, so they win the first-occurrence dedupe when both forms are present.
 * A bare generic `test` never matches (the name needs ≥2 chars after `test_`).
 */
export function extractFailingTestIds(
  text: string,
  cap = MAX_TASK_FAILING_TESTS,
): { kept: string[]; unique: number } {
  const found: string[] = [];
  for (const m of text.matchAll(/\b[\w./-]+\.py::[\w:.[\]-]+/g)) found.push(m[0]!);
  for (const m of text.matchAll(/\btest_[a-zA-Z0-9_]{2,}\b/g)) found.push(m[0]!);
  return dedupeCapCounted(found, cap);
}

/**
 * Traceback frames: `File "..., line N, in fn"` lines plus the final
 * `SomethingError: ...` message line. Keeps the FIRST half and LAST half when
 * over the cap (the entry point and the crash site carry the signal; the middle
 * is noise), in original order. Long lines are hard-truncated at 160 chars so a
 * huge code/paste line can never balloon the task.
 */
export function extractTracebackFrames(
  text: string,
  cap = MAX_TASK_TRACEBACK_FRAMES,
): { kept: string[]; unique: number } {
  const lines = text.split("\n");
  const hits: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^File "[^"]+", line \d+/.test(t) || /^[A-Z][A-Za-z0-9]*(?:Error|Exception|Warning)\b\s*:/.test(t)) {
      hits.push(t.length > 160 ? `${t.slice(0, 159)}…` : t);
    }
  }
  const { kept: deduped, unique } = dedupeCapCounted(hits, Number.MAX_SAFE_INTEGER);
  if (deduped.length <= cap) return { kept: deduped, unique };
  const head = deduped.slice(0, Math.ceil(cap / 2));
  const tail = deduped.slice(deduped.length - Math.floor(cap / 2));
  return { kept: [...head, ...tail], unique };
}

// ---------------------------------------------------------------------------
// Structured task assembly
// ---------------------------------------------------------------------------

export interface StructuredTaskDiagnostics {
  readonly baseChars: number;
  readonly taskChars: number;
  readonly exceptionCount: number;
  readonly failingTestCount: number;
  readonly tracebackFrameCount: number;
  /** True when the total cap trimmed evidence (section drop or prefix cut). */
  readonly capped: boolean;
  /** Unique-but-omitted counts per lane + sections dropped by the total cap. */
  readonly omittedCounts: Record<string, number>;
  /** The ONLY text source this derivation reads. */
  readonly provenance: "issue_problem_statement";
}

export interface StructuredDerivedTask {
  /** The unchanged V0 derivation (title + first prose sentence, ≤360 chars). */
  readonly baseTask: string;
  readonly exceptions: string[];
  readonly failingTests: string[];
  readonly tracebackFrames: string[];
  /** The rendered evidence lines actually present in `taskText`, in order. */
  readonly addedEvidence: string[];
  /** The default Stage 5 task text: base + labelled evidence lines. */
  readonly taskText: string;
  readonly diagnostics: StructuredTaskDiagnostics;
}

/**
 * The M103 default Stage 5 task derivation: V0 base + labelled structured
 * evidence ("Errors: …", "Failing tests: …", "Traceback: …"), whole sections
 * dropped from the END until the 1200-char total cap is met (base never
 * trimmed). `taskText` is byte-identical to M102's V5_title_plus_errors —
 * verified by test against `buildTaskVariant`.
 */
export function deriveStructuredTaskFromProblemStatement(problemStatement: string): StructuredDerivedTask {
  const statement = cleanStatement(problemStatement);
  const baseTask = deriveTaskFromProblemStatement(problemStatement);
  const exceptions = extractExceptionNames(statement);
  const failingTests = extractFailingTestIds(statement);
  const traceback = extractTracebackFrames(statement);

  const sections = [
    { key: "exceptions", label: "Errors", items: exceptions.kept },
    { key: "failing_tests", label: "Failing tests", items: failingTests.kept },
    { key: "traceback_frames", label: "Traceback", items: traceback.kept },
  ];
  const parts = sections
    .filter((s) => s.items.length > 0)
    .map((s) => ({ key: s.key, line: `${s.label}: ${s.items.join(" | ")}` }));

  // Compose "base + labelled evidence lines", trimming whole sections from the
  // END until the total cap is met (identical to M102's composeCapped).
  const included = [...parts];
  let text = [baseTask, ...included.map((p) => p.line)].join("\n");
  let droppedSections = 0;
  while (text.length > MAX_STRUCTURED_TASK_CHARS && included.length > 0) {
    included.pop();
    droppedSections += 1;
    text = [baseTask, ...included.map((p) => p.line)].join("\n");
  }
  let prefixCut = false;
  if (text.length > MAX_STRUCTURED_TASK_CHARS) {
    text = wordSafePrefix(text, MAX_STRUCTURED_TASK_CHARS);
    prefixCut = true;
  }

  const includedKeys = new Set(included.map((p) => p.key));
  const omittedCounts: Record<string, number> = {
    exceptions_over_cap: exceptions.unique - exceptions.kept.length,
    failing_tests_over_cap: failingTests.unique - failingTests.kept.length,
    traceback_frames_over_cap: traceback.unique - traceback.kept.length,
    evidence_sections_trimmed: droppedSections,
  };

  return {
    baseTask,
    exceptions: exceptions.kept,
    failingTests: failingTests.kept,
    tracebackFrames: traceback.kept,
    addedEvidence: included.map((p) => p.line),
    taskText: text,
    diagnostics: {
      baseChars: baseTask.length,
      taskChars: text.length,
      exceptionCount: includedKeys.has("exceptions") ? exceptions.kept.length : 0,
      failingTestCount: includedKeys.has("failing_tests") ? failingTests.kept.length : 0,
      tracebackFrameCount: includedKeys.has("traceback_frames") ? traceback.kept.length : 0,
      capped: droppedSections > 0 || prefixCut,
      omittedCounts,
      provenance: "issue_problem_statement",
    },
  };
}
