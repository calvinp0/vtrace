// Stage 5 deterministic patch probes (milestone 2 of the patch critic / repair loop design).
//
// SCOPE: analysis only. These are CHEAP, DETERMINISTIC warning signals over a patch that
// already exists on disk. They run NO agents, NO Docker, and call NO model. They do not
// implement the critic or repair loop — they only inspect a unified diff (plus, where
// available, the run's tool-call / stdout artifacts) and report pass/warn/fail/unknown.
//
// Every probe is HONEST about uncertainty: when the artifact is insufficient to decide
// (e.g. class scope not visible in the diff window), the probe returns `unknown` rather than
// a fabricated pass. Probes are NOT correctness oracles — Docker resolution remains the only
// ground truth. Pure functions throughout; the one impure dependency (a Python parser) is
// injected so the module stays testable without spawning a subprocess.

import { editedFilesFromPatch } from "../../src/capsule/finalEditDiagnostics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProbeStatus = "pass" | "warn" | "fail" | "unknown";
export type Confidence = "low" | "medium" | "high";
export type RiskLevel = "low" | "medium" | "high" | "unknown";

export interface PatchProbeResult {
  readonly probeId: string;
  readonly status: ProbeStatus;
  readonly confidence: Confidence;
  readonly evidence: string[];
}

// Observability for full-file reconstruction (milestone 4). Records whether scope-sensitive
// probes were able to inspect reconstructed patched-file content rather than only the diff
// window, and where that content came from. `source` is "unavailable" when no reconstruction
// was attempted or none succeeded.
export type ReconstructionSource = "workspace_plus_patch" | "patched_workspace" | "unavailable";

export interface ReconstructionInfo {
  readonly attempted: boolean;
  readonly source: ReconstructionSource;
  readonly filesReconstructed: string[];
  readonly filesFailed: string[];
  readonly errors: string[];
}

export const NO_RECONSTRUCTION: ReconstructionInfo = {
  attempted: false,
  source: "unavailable",
  filesReconstructed: [],
  filesFailed: [],
  errors: [],
};

export interface PatchProbeSummary {
  readonly instanceId: string;
  readonly runLabel: string;
  readonly editedFiles: string[];
  readonly patchChars: number;
  readonly probes: PatchProbeResult[];
  readonly overallRisk: RiskLevel;
  readonly knownDefectLikelyCaught: boolean | null;
  // Reconstruction observability (milestone 4). Absent on summaries built before reconstruction
  // was introduced; treated as NO_RECONSTRUCTION when missing.
  readonly reconstruction?: ReconstructionInfo;
}

// A minimal view of a recorded tool call (Bash commands carry their command string).
export interface RawToolCall {
  readonly category: string | null;
  readonly path: string | null;
  readonly command: string | null;
}

// Result of an injected Python parse attempt. null (from the parser) means "could not run
// the parser" (e.g. python3 unavailable) and maps to `unknown`, never to a pass.
export interface PythonParseResult {
  readonly ok: boolean;
  readonly error?: string;
}

export type PythonParser = (code: string) => PythonParseResult | null;

// Per-instance probe configuration. Kept small and explicit; this is the only place where
// instance-specific knowledge (expected file/class/behavior patterns) lives.
export interface InstanceProbeConfig {
  readonly instanceId: string;
  readonly expectedEditedFile?: string;
  readonly expectedClassHint?: string;
  readonly insertedMethodPattern?: string;
  readonly expectedBehaviorPatterns?: string[];
  // Which probe's signal corresponds to this instance's known target defect.
  readonly targetProbeId: string;
  // Human-readable description of the known defect (for the report).
  readonly knownDefect: string;
}

export const INSTANCE_CONFIGS: Readonly<Record<string, InstanceProbeConfig>> = {
  "sympy__sympy-16766": {
    instanceId: "sympy__sympy-16766",
    expectedEditedFile: "sympy/printing/pycode.py",
    expectedClassHint: "PythonCodePrinter",
    insertedMethodPattern: "_print_",
    targetProbeId: "inserted_method_scope",
    knownDefect: "wrong class/function/class-scope placement (methods in AbstractPythonCodePrinter instead of PythonCodePrinter)",
  },
  "matplotlib__matplotlib-22719": {
    instanceId: "matplotlib__matplotlib-22719",
    expectedEditedFile: "lib/matplotlib/category.py",
    expectedBehaviorPatterns: ["values.size == 0", "return", "empty"],
    targetProbeId: "failing_behavior_pattern",
    knownDefect: "patch did not fully handle the failing empty-array behavior (missing early return for empty input)",
  },
  "psf__requests-5414": {
    instanceId: "psf__requests-5414",
    expectedEditedFile: "requests/models.py",
    expectedBehaviorPatterns: ["empty", "label", "idna"],
    targetProbeId: "minimality_rewrite_risk",
    knownDefect: "broad control-flow rewrite instead of minimal additive validation",
  },
};

// ---------------------------------------------------------------------------
// Diff helpers (pure)
// ---------------------------------------------------------------------------

// Body lines of a unified diff carry a leading +/-/space. Hunk headers start with @@,
// file headers with diff/index/---/+++ . These helpers ignore the file headers.
export function addedLines(patch: string): string[] {
  return patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
}

export function removedLines(patch: string): string[] {
  return patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
}

// The text of an added line, with the leading "+" removed.
function addedText(patch: string): string[] {
  return addedLines(patch).map((l) => l.slice(1));
}

function countHunks(patch: string): number {
  return patch.split("\n").filter((l) => l.startsWith("@@")).length;
}

const CONTROL_FLOW_RE = /^\s*(if|elif|else|for|while|try|except|finally|with|def|class|return|raise|yield)\b/;

// ---------------------------------------------------------------------------
// Probe 1: edited files
// ---------------------------------------------------------------------------

export function editedFilesProbe(patch: string): PatchProbeResult {
  const files = editedFilesFromPatch(patch);
  if (files.length === 0) {
    return {
      probeId: "edited_files",
      status: "fail",
      confidence: "high",
      evidence: ["No edited files could be parsed from the patch (empty or malformed diff)."],
    };
  }
  return {
    probeId: "edited_files",
    status: "pass",
    confidence: "high",
    evidence: [`Edited files: ${files.join(", ")}.`],
  };
}

// ---------------------------------------------------------------------------
// Probe 2: minimality / broad-rewrite risk
// ---------------------------------------------------------------------------

export interface MinimalityOptions {
  // How many edited files we expect for a minimal fix (default 1).
  readonly expectedFileCount?: number;
}

export function minimalityProbe(patch: string, opts: MinimalityOptions = {}): PatchProbeResult {
  const expectedFiles = opts.expectedFileCount ?? 1;
  const adds = addedLines(patch).length;
  const dels = removedLines(patch).length;
  const files = editedFilesFromPatch(patch);
  const hunks = countHunks(patch);
  const deletedControlFlow = removedLines(patch).filter((l) => CONTROL_FLOW_RE.test(l.slice(1))).length;

  const evidence = [
    `+${adds}/-${dels} lines across ${files.length} file(s), ${hunks} hunk(s); deleted control-flow lines: ${deletedControlFlow}.`,
  ];

  // Strong broad-rewrite indicators → fail (high confidence).
  if (dels >= 8 || deletedControlFlow >= 2 || files.length > expectedFiles) {
    const why: string[] = [];
    if (dels >= 8) why.push(`${dels} deletions (>=8)`);
    if (deletedControlFlow >= 2) why.push(`${deletedControlFlow} deleted control-flow lines (>=2)`);
    if (files.length > expectedFiles) why.push(`${files.length} files touched (>${expectedFiles} expected)`);
    evidence.push(`Broad-rewrite indicators: ${why.join("; ")}.`);
    return { probeId: "minimality_rewrite_risk", status: "fail", confidence: "high", evidence };
  }

  // Moderate indicators → warn.
  if (deletedControlFlow >= 1 || (dels >= 3 && dels >= adds)) {
    const why: string[] = [];
    if (deletedControlFlow >= 1) why.push(`${deletedControlFlow} deleted control-flow line`);
    if (dels >= 3 && dels >= adds) why.push(`deletions (${dels}) >= insertions (${adds})`);
    evidence.push(`Non-minimal indicators: ${why.join("; ")}.`);
    return { probeId: "minimality_rewrite_risk", status: "warn", confidence: "medium", evidence };
  }

  evidence.push("Patch appears small/additive (few or no deletions, single file).");
  return { probeId: "minimality_rewrite_risk", status: "pass", confidence: "medium", evidence };
}

// ---------------------------------------------------------------------------
// Probe 3: Python parse
// ---------------------------------------------------------------------------

// Extract self-contained, parseable Python blocks from the ADDED lines of a diff. We only
// treat a contiguous run of added lines as parseable when it begins (after dedent) with a
// top-level `def`/`class`/`async def`, because arbitrary added fragments (a single changed
// expression, an `else:` branch whose `if` is unchanged) do NOT form a parseable unit and
// would yield false syntax errors. Returns dedented block sources.
export function extractParseableBlocks(patch: string): string[] {
  const lines = patch.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) {
      const dedented = dedent(current);
      if (/^(async\s+)?(def|class)\s/.test(dedented[0] ?? "")) blocks.push(dedented.join("\n"));
    }
    current = [];
  };
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.push(line.slice(1));
    } else {
      flush();
    }
  }
  flush();
  return blocks;
}

function dedent(block: string[]): string[] {
  const indents = block
    .filter((l) => l.trim().length > 0)
    .map((l) => l.length - l.trimStart().length);
  const min = indents.length > 0 ? Math.min(...indents) : 0;
  return block.map((l) => l.slice(min));
}

export function pythonParseProbe(patch: string, parse: PythonParser): PatchProbeResult {
  const blocks = extractParseableBlocks(patch);
  if (blocks.length === 0) {
    return {
      probeId: "python_parse",
      status: "unknown",
      confidence: "low",
      evidence: [
        "No self-contained Python block (top-level def/class) could be isolated from the added lines; " +
          "fragment-only additions cannot be parsed reliably without full file content.",
      ],
    };
  }
  const failures: string[] = [];
  let parserRan = false;
  for (const block of blocks) {
    const result = parse(block);
    if (result === null) continue; // parser unavailable for this block
    parserRan = true;
    if (!result.ok) failures.push(result.error ?? "syntax error");
  }
  if (!parserRan) {
    return {
      probeId: "python_parse",
      status: "unknown",
      confidence: "low",
      evidence: ["Python parser unavailable; could not AST-parse the extracted block(s)."],
    };
  }
  if (failures.length > 0) {
    return {
      probeId: "python_parse",
      status: "fail",
      confidence: "high",
      evidence: [`Syntax error in inserted Python block: ${failures.join("; ")}.`],
    };
  }
  return {
    probeId: "python_parse",
    status: "pass",
    confidence: "high",
    evidence: [`Parsed ${blocks.length} inserted Python block(s) with no syntax error.`],
  };
}

// ---------------------------------------------------------------------------
// Full-file reconstruction (milestone 4): apply a unified diff to original file
// content IN MEMORY so scope-sensitive probes can inspect the patched file.
// ---------------------------------------------------------------------------

export interface DiffHunk {
  readonly oldStart: number; // 1-based line in the original (a hint; matching is content-based)
  readonly oldBlock: string[]; // context + removed lines (the "before" image)
  readonly newBlock: string[]; // context + added lines (the "after" image)
}

export interface FilePatch {
  readonly path: string;
  readonly hunks: DiffHunk[];
}

// Parse a (possibly multi-file) unified diff into per-file hunks. The "before" image of each
// hunk is its context + removed lines; the "after" image is its context + added lines. The
// `--- /+++` and `index`/mode lines are ignored except to recover the file path.
export function parseUnifiedDiff(patch: string): FilePatch[] {
  const files: FilePatch[] = [];
  let cur: { path: string; hunks: DiffHunk[] } | null = null;
  let oldStart = 1;
  let oldBlock: string[] = [];
  let newBlock: string[] = [];
  let inHunk = false;

  const flushHunk = (): void => {
    if (cur && inHunk) cur.hunks.push({ oldStart, oldBlock, newBlock });
    oldBlock = [];
    newBlock = [];
    inHunk = false;
  };
  const flushFile = (): void => {
    flushHunk();
    if (cur) files.push(cur);
    cur = null;
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git")) {
      flushFile();
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("+++ ")) {
      flushHunk();
      const p = line.slice(4).trim().replace(/^[ab]\//, "");
      if (!cur) cur = { path: p, hunks: [] };
      else cur = { path: p, hunks: cur.hunks };
      continue;
    }
    if (line.startsWith("@@")) {
      flushHunk();
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      oldStart = m ? parseInt(m[1]!, 10) : 1;
      inHunk = true;
      continue;
    }
    if (!cur || !inHunk) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const tag = line[0];
    const text = line.slice(1);
    if (tag === " ") {
      oldBlock.push(text);
      newBlock.push(text);
    } else if (tag === "-") {
      oldBlock.push(text);
    } else if (tag === "+") {
      newBlock.push(text);
    }
  }
  flushFile();
  return files;
}

export interface ApplyResult {
  readonly ok: boolean;
  readonly content?: string;
  readonly error?: string;
}

// Locate the exact `block` of consecutive lines within `lines`, preferring the occurrence
// nearest to `expected`. Returns -1 if not found. Matching is exact-content (no whitespace
// fuzz); only the line OFFSET is tolerated, which is what real workspace bases need (the patch
// base and the captured workspace differ in line numbers, not in the surrounding text).
function locateBlock(lines: readonly string[], block: readonly string[], expected: number): number {
  if (block.length === 0) return Math.max(0, Math.min(expected, lines.length));
  const max = lines.length - block.length;
  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i <= max; i += 1) {
    let match = true;
    for (let j = 0; j < block.length; j += 1) {
      if (lines[i + j] !== block[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      const dist = Math.abs(i - expected);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
  }
  return best;
}

// Apply a single file's hunks to its original content in memory. Pure: never touches disk.
// Returns the reconstructed content, or an error describing the first hunk that did not match.
export function applyFilePatch(original: string, hunks: readonly DiffHunk[]): ApplyResult {
  const lines = original.split("\n");
  let offset = 0;
  for (const h of hunks) {
    const expected = h.oldStart - 1 + offset;
    const at = locateBlock(lines, h.oldBlock, expected);
    if (at < 0) {
      return { ok: false, error: `hunk near original line ${h.oldStart} did not match (context not found)` };
    }
    lines.splice(at, h.oldBlock.length, ...h.newBlock);
    offset += h.newBlock.length - h.oldBlock.length;
  }
  return { ok: true, content: lines.join("\n") };
}

// Convenience: reconstruct one file from its original content + the full (multi-file) patch.
export function reconstructFile(original: string, patch: string, filePath: string): ApplyResult {
  const file = parseUnifiedDiff(patch).find((f) => f.path === filePath);
  if (!file) return { ok: false, error: `no hunks for ${filePath} in patch` };
  return applyFilePatch(original, file.hunks);
}

// ---------------------------------------------------------------------------
// Indentation-based class/scope resolver (milestone 4). A deliberately simple parser: it does
// NOT do full Python semantic resolution, only structural indentation. Robust to decorators,
// blank lines, comments, nested functions, and multiple classes per file. Known limitation:
// it can be fooled by `class `/`def ` text inside a multi-line string literal.
// ---------------------------------------------------------------------------

interface ScopeFrame {
  readonly indent: number;
  readonly kind: "class" | "def";
  readonly name: string;
}

export interface EnclosingClassResult {
  readonly methodName: string;
  readonly lineNumber: number; // 1-based
  readonly enclosingClass: string | null; // null = module scope or nested only in functions
}

const SOURCE_CLASS_RE = /^(\s*)class\s+(\w+)/;
const SOURCE_DEF_RE = /^(\s*)(?:async\s+)?def\s+(\w+)/;

function indentOf(line: string): number {
  return line.length - line.replace(/^[ \t]*/, "").length;
}

// Find every `def <methodName>` in `source` and resolve its nearest enclosing class via an
// indentation scope stack. A method defined directly at module level (or nested only inside
// functions) resolves to `enclosingClass: null`.
export function findEnclosingClasses(source: string, methodName: string): EnclosingClassResult[] {
  const lines = source.split("\n");
  const stack: ScopeFrame[] = [];
  const results: EnclosingClassResult[] = [];
  const targetRe = new RegExp(`^(\\s*)(?:async\\s+)?def\\s+(${escapeRegExp(methodName)})\\b`);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const stripped = line.trim();
    if (stripped.length === 0 || stripped.startsWith("#") || stripped.startsWith("@")) continue;
    const indent = indentOf(line);
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();

    const isTarget = targetRe.test(line);
    if (isTarget) {
      let enclosing: string | null = null;
      for (let s = stack.length - 1; s >= 0; s -= 1) {
        if (stack[s]!.kind === "class") {
          enclosing = stack[s]!.name;
          break;
        }
      }
      results.push({ methodName, lineNumber: i + 1, enclosingClass: enclosing });
    }

    const cm = SOURCE_CLASS_RE.exec(line);
    if (cm) {
      stack.push({ indent, kind: "class", name: cm[2]! });
      continue;
    }
    const dm = SOURCE_DEF_RE.exec(line);
    if (dm) stack.push({ indent, kind: "def", name: dm[2]! });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Probe 4: inserted method / class scope
// ---------------------------------------------------------------------------

interface InsertedMethod {
  readonly name: string;
  readonly indent: number;
  readonly enclosingClass: string | null;
  readonly enclosingClassIndent: number;
}

// Walk the diff in NEW-file order (context + added lines, ignoring removed lines), tracking
// the most recent class header, and record each inserted `def <pattern>` with its enclosing
// class (if visible in the diff window). Removed lines do not affect the new-file scope.
export function findInsertedMethods(patch: string, methodPattern: string): InsertedMethod[] {
  const lines = patch.split("\n");
  const methods: InsertedMethod[] = [];
  let curClass: string | null = null;
  let curClassIndent = -1;
  const classRe = /^(\s*)class\s+(\w+)/;
  const defRe = new RegExp(`^(\\s*)(?:async\\s+)?def\\s+(${escapeRegExp(methodPattern)}\\w*)`);
  for (const line of lines) {
    if (line.startsWith("@@")) {
      // Hunk boundary: the visible class context resets (a new window may not show it).
      curClass = null;
      curClassIndent = -1;
      continue;
    }
    const isContext = line.startsWith(" ");
    const isAdded = line.startsWith("+") && !line.startsWith("+++");
    if (!isContext && !isAdded) continue; // skip removed / file-header lines
    const content = line.slice(1);
    const cm = classRe.exec(content);
    if (cm) {
      curClass = cm[2]!;
      curClassIndent = cm[1]!.length;
      continue;
    }
    if (isAdded) {
      const dm = defRe.exec(content);
      if (dm) {
        const indent = dm[1]!.length;
        const within = curClass !== null && indent > curClassIndent;
        methods.push({
          name: dm[2]!,
          indent,
          enclosingClass: within ? curClass : null,
          enclosingClassIndent: curClassIndent,
        });
      }
    }
  }
  return methods;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Scope probe. First tries diff-only scope (cheap, works when the class header is visible in
// the hunk). When the diff window is inconclusive AND reconstructed full-file content is
// available, it resolves each inserted method's enclosing class from the reconstructed file's
// indentation structure — which is what catches a wrong-scope insertion whose surrounding
// class is off-screen in the diff (the SymPy failure mode). `reconstructedSource` is the
// patched content of `config.expectedEditedFile`, or null when reconstruction was unavailable.
export function insertedMethodScopeProbe(
  patch: string,
  config: InstanceProbeConfig,
  reconstructedSource: string | null = null,
): PatchProbeResult {
  const pattern = config.insertedMethodPattern!;
  const hint = config.expectedClassHint;
  const methods = findInsertedMethods(patch, pattern);
  if (methods.length === 0) {
    return {
      probeId: "inserted_method_scope",
      status: "unknown",
      confidence: "low",
      evidence: [`No inserted "def ${pattern}*" method found; scope check not applicable.`],
    };
  }
  const named = methods.map((m) => m.name).join(", ");
  const wrong = methods.filter((m) => m.enclosingClass !== null && hint !== undefined && m.enclosingClass !== hint);
  if (wrong.length > 0) {
    return {
      probeId: "inserted_method_scope",
      status: "fail",
      confidence: "high",
      evidence: [
        `Inserted method(s) ${wrong.map((m) => `${m.name} in class ${m.enclosingClass}`).join(", ")} ` +
          `landed outside the expected class ${hint} (diff-window evidence).`,
      ],
    };
  }
  const undetermined = methods.filter((m) => m.enclosingClass === null);
  if (undetermined.length === 0) {
    return {
      probeId: "inserted_method_scope",
      status: "pass",
      confidence: "medium",
      evidence: [
        `Inserted method(s) ${named} appear within the expected class ${hint} per the diff context ` +
          "(diff-window evidence only; full-file scope not independently confirmed).",
      ],
    };
  }

  // Diff window is inconclusive for at least one inserted method. Escalate to full-file
  // reconstruction when available.
  if (reconstructedSource === null) {
    return {
      probeId: "inserted_method_scope",
      status: "unknown",
      confidence: "low",
      evidence: [
        `Inserted method(s) ${named} found, but no enclosing class header is visible in the diff window ` +
          "and no reconstructed file content was available, so the landing scope cannot be determined.",
      ],
    };
  }

  const names = Array.from(new Set(methods.map((m) => m.name)));
  const located: EnclosingClassResult[] = [];
  const unlocated: string[] = [];
  for (const name of names) {
    const hits = findEnclosingClasses(reconstructedSource, name);
    if (hits.length === 0) unlocated.push(name);
    else located.push(...hits);
  }

  if (located.length === 0) {
    return {
      probeId: "inserted_method_scope",
      status: "unknown",
      confidence: "low",
      evidence: [
        `Reconstructed full-file content was available but inserted method(s) ${named} could not be located in it; ` +
          "scope cannot be determined.",
      ],
    };
  }

  const wrongScope = located.filter((r) => hint !== undefined && r.enclosingClass !== hint);
  if (wrongScope.length > 0) {
    const detail = wrongScope
      .map((r) => `${r.methodName} in ${r.enclosingClass ?? "<module scope>"} (line ${r.lineNumber})`)
      .join(", ");
    return {
      probeId: "inserted_method_scope",
      status: "fail",
      confidence: "high",
      evidence: [
        `Full-file reconstruction: inserted method(s) ${detail} landed outside the expected class ${hint}. ` +
          "Resolved from the reconstructed file's indentation structure, not just the diff window.",
      ],
    };
  }

  const note = unlocated.length > 0 ? ` (could not locate: ${unlocated.join(", ")})` : "";
  return {
    probeId: "inserted_method_scope",
    status: "pass",
    confidence: "high",
    evidence: [
      `Full-file reconstruction: inserted method(s) ${located.map((r) => r.methodName).join(", ")} resolve inside the ` +
        `expected class ${hint} per the reconstructed file's indentation structure${note}.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Probe 5: failing-behavior pattern
// ---------------------------------------------------------------------------

export function failingBehaviorProbe(patch: string, config: InstanceProbeConfig): PatchProbeResult {
  const patterns = config.expectedBehaviorPatterns;
  if (!patterns || patterns.length === 0) {
    return {
      probeId: "failing_behavior_pattern",
      status: "unknown",
      confidence: "low",
      evidence: ["No expected-behavior patterns configured for this instance."],
    };
  }
  const text = addedText(patch).join("\n").toLowerCase();
  const matched = patterns.filter((p) => text.includes(p.toLowerCase()));
  const missing = patterns.filter((p) => !text.includes(p.toLowerCase()));
  const evidence = [
    `Expected behavior patterns matched in added code: [${matched.join(", ") || "none"}]; ` +
      `missing: [${missing.join(", ") || "none"}].`,
  ];
  if (matched.length === 0) {
    evidence.push("None of the expected failing-behavior patterns appear in the added code.");
    return { probeId: "failing_behavior_pattern", status: "fail", confidence: "medium", evidence };
  }
  if (matched.length < 2) {
    evidence.push("Only a weak partial match for the expected failing behavior.");
    return { probeId: "failing_behavior_pattern", status: "warn", confidence: "medium", evidence };
  }
  evidence.push("Added code appears to directly handle the expected failing behavior.");
  return { probeId: "failing_behavior_pattern", status: "pass", confidence: "medium", evidence };
}

// ---------------------------------------------------------------------------
// Probe 6: test evidence
// ---------------------------------------------------------------------------

const NAMED_TEST_RE = /\bpytest\b|\bunittest\b|\btox\b|\bnosetests?\b|-m\s+pytest|test_[\w/]+\.py|tests?\//i;
const ADHOC_CHECK_RE = /python3?\s+-[a-zA-Z]/;

export function testEvidenceProbe(
  toolCalls: readonly RawToolCall[] | null,
  stdout: string | null,
  stderr: string | null,
): PatchProbeResult {
  if (toolCalls === null && stdout === null && stderr === null) {
    return {
      probeId: "test_evidence",
      status: "unknown",
      confidence: "low",
      evidence: ["No tool-call or stdout/stderr artifacts available to inspect for test evidence."],
    };
  }
  const commands = (toolCalls ?? [])
    .filter((t) => t.category === "other" && t.command)
    .map((t) => t.command!);
  const haystack = [...commands, stdout ?? "", stderr ?? ""].join("\n");

  const named = commands.find((c) => NAMED_TEST_RE.test(c)) ?? (NAMED_TEST_RE.test(stdout ?? "") ? "(stdout)" : null);
  if (named) {
    return {
      probeId: "test_evidence",
      status: "pass",
      confidence: "high",
      evidence: [`A named test command/run is present: ${truncate(named, 120)}.`],
    };
  }
  if (ADHOC_CHECK_RE.test(haystack)) {
    const adhoc = commands.find((c) => ADHOC_CHECK_RE.test(c)) ?? "(stdout)";
    return {
      probeId: "test_evidence",
      status: "warn",
      confidence: "medium",
      evidence: [
        `Ad-hoc python check(s) ran (e.g. ${truncate(adhoc, 120)}) but no named test suite (pytest/unittest) was detected.`,
      ],
    };
  }
  return {
    probeId: "test_evidence",
    status: "fail",
    confidence: "medium",
    evidence: [`No test or check command detected among ${commands.length} bash command(s).`],
  };
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n)}…` : oneLine;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface PatchInput {
  readonly instanceId: string;
  readonly runLabel: string;
  readonly patch: string;
  readonly toolCalls: readonly RawToolCall[] | null;
  readonly stdout: string | null;
  readonly stderr: string | null;
  readonly parsePython: PythonParser;
  // Optional override; otherwise resolved from INSTANCE_CONFIGS by instanceId.
  readonly config?: InstanceProbeConfig;
  // Optional full-file reconstruction (milestone 4). `reconstructedSources` maps an edited
  // file path to its in-memory patched content; the scope probe consumes the entry for
  // `config.expectedEditedFile`. `reconstruction` is attached to the summary for observability.
  readonly reconstructedSources?: Record<string, string>;
  readonly reconstruction?: ReconstructionInfo;
}

// Overall risk is the worst signal across the probes that can carry risk. Any high-confidence
// fail → high; any fail/warn → medium; otherwise low. A patch with no edited files is unknown.
export function deriveOverallRisk(probes: readonly PatchProbeResult[]): RiskLevel {
  const editedFiles = probes.find((p) => p.probeId === "edited_files");
  if (editedFiles && editedFiles.status === "fail") return "unknown";
  const fails = probes.filter((p) => p.status === "fail");
  if (fails.some((p) => p.confidence === "high")) return "high";
  if (fails.length > 0 || probes.some((p) => p.status === "warn")) return "medium";
  if (probes.some((p) => p.status === "pass")) return "low";
  return "unknown";
}

export function summarizePatch(input: PatchInput): PatchProbeSummary {
  const config = input.config ?? INSTANCE_CONFIGS[input.instanceId];
  const editedFiles = editedFilesFromPatch(input.patch);
  const expectedFileCount = 1;

  const probes: PatchProbeResult[] = [
    editedFilesProbe(input.patch),
    minimalityProbe(input.patch, { expectedFileCount }),
    pythonParseProbe(input.patch, input.parsePython),
  ];
  if (config?.insertedMethodPattern) {
    const reconstructedSource =
      config.expectedEditedFile && input.reconstructedSources
        ? (input.reconstructedSources[config.expectedEditedFile] ?? null)
        : null;
    probes.push(insertedMethodScopeProbe(input.patch, config, reconstructedSource));
  }
  if (config?.expectedBehaviorPatterns) probes.push(failingBehaviorProbe(input.patch, config));
  probes.push(testEvidenceProbe(input.toolCalls, input.stdout, input.stderr));

  const overallRisk = deriveOverallRisk(probes);

  // knownDefectLikelyCaught: did the probe corresponding to this instance's target defect
  // flag a problem? fail/warn → caught (true); pass → not flagged (false); unknown/absent → null.
  let knownDefectLikelyCaught: boolean | null = null;
  if (config) {
    const target = probes.find((p) => p.probeId === config.targetProbeId);
    if (target) {
      if (target.status === "fail" || target.status === "warn") knownDefectLikelyCaught = true;
      else if (target.status === "pass") knownDefectLikelyCaught = false;
      else knownDefectLikelyCaught = null;
    }
  }

  return {
    instanceId: input.instanceId,
    runLabel: input.runLabel,
    editedFiles,
    patchChars: input.patch.length,
    probes,
    overallRisk,
    knownDefectLikelyCaught,
    reconstruction: input.reconstruction ?? NO_RECONSTRUCTION,
  };
}
