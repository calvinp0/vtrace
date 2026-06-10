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

export interface PatchProbeSummary {
  readonly instanceId: string;
  readonly runLabel: string;
  readonly editedFiles: string[];
  readonly patchChars: number;
  readonly probes: PatchProbeResult[];
  readonly overallRisk: RiskLevel;
  readonly knownDefectLikelyCaught: boolean | null;
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

export function insertedMethodScopeProbe(patch: string, config: InstanceProbeConfig): PatchProbeResult {
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
          `landed outside the expected class ${hint}.`,
      ],
    };
  }
  const undetermined = methods.filter((m) => m.enclosingClass === null);
  if (undetermined.length > 0) {
    return {
      probeId: "inserted_method_scope",
      status: "unknown",
      confidence: "low",
      evidence: [
        `Inserted method(s) ${named} found, but no enclosing class header is visible in the diff window, ` +
          "so the landing scope cannot be determined from the unified diff alone.",
      ],
    };
  }
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
  if (config?.insertedMethodPattern) probes.push(insertedMethodScopeProbe(input.patch, config));
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
  };
}
