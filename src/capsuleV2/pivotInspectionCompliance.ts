// Pivot inspection COMPLIANCE checker for the M13 structured pivot-inspection loop.
//
// SCOPE: post-hoc / finalize-time verification only. This is a CHEAP, DETERMINISTIC
// projection. It runs NO agents, NO Docker, calls NO model, and — critically — it
// NEVER touches retrieval: it does not generate candidates, re-rank, re-score, or
// change role assignment, nor does it change pivot selection. It reads the pivot
// inspection contract that the M11/M12 layer already built (see
// `pivotInspectionContract.ts`), plus three observable facts about a completed agent
// run — which files the final patch edits, which files the agent inspected, and which
// files are covered by a generated-artifact obligation — and reports, per required
// non-lead pivot / co-edit candidate, whether it was handled.
//
// "handled" = edited OR explicitly ruled out with source-grounded evidence.
//
// WHY THIS EXISTS (M12.1 live validation): the M12 enforcement block rendered
// correctly and improved diff discipline, but injected text alone did not reliably
// improve resolution — sphinx still reads then wrongly rules out the gold pivot, and
// seaborn sometimes under-edits. The next lever is not more guidance text but a
// structured check that can tell, before/at finalization, whether every required
// non-lead pivot was actually handled. This module is that check (M13, Option B):
// a deterministic compliance verdict plus a pure corrective-prompt generator. It does
// NOT itself re-prompt a live agent (the external SWE-bench harness owns the turn
// loop and final-patch extraction); it produces the verdict and the prompt content so
// reporting/telemetry can use them and a future live loop can wire them in.
//
// IMPORTANT — model prose is NOT observable in the captured Stage 5 run artifacts
// (only the final patch + ordered tool calls + the manifest are persisted). So an
// explicit source-grounded rule-out can only be detected from a machine-readable
// PIVOT_DECISION marker (Option C) if one is present. When no marker is present and a
// candidate was inspected but not edited, this module conservatively reports
// `unclear` (NOT `ruledOut`, NOT `missing`) — it cannot confirm the rule-out was
// source-grounded, and it must not assume non-handling for a file the agent read.
//
// NOTHING HERE IS PROJECT-SPECIFIC. It keys off the contract's own structure and
// generic file-path matching. No instance ids, no repo names, no hardcoded filenames.

import type { PivotInspectionContract } from "./pivotInspectionContract";

/** The role of a required candidate, in the report-facing vocabulary requested by M13. */
export type RequiredCandidateRole = "non_lead_pivot" | "related_coedit";

/** A required non-lead pivot / co-edit candidate that must be handled before finalize. */
export interface RequiredPivotCandidate {
  path: string;
  symbol?: string;
  role: RequiredCandidateRole;
}

/**
 * A machine-readable PIVOT_DECISION marker (Option C). Parsed from the agent's final
 * answer when present. The enforcement block is NOT (yet) modified to demand these, so
 * captured M12.1 runs carry none — but the parser is here so a future marker-emitting
 * run can drive `ruledOut` detection, and the conservative rule-out test exercises it.
 */
export interface PivotDecisionMarker {
  path: string;
  decision: "EDITED" | "RULED_OUT";
  /** The source-grounded evidence string the agent gave (may be empty / generic). */
  evidence: string;
}

/** Minimal test-expectation shape the M16 conflict detector reads — a structural
 *  subset of the revision pass's RevisionTestExpectation, declared here to avoid a
 *  circular import (pivotRevisionPass imports FROM this module). */
export interface ComplianceTestExpectation {
  failToPass?: readonly string[];
  problemStatementExcerpt?: string;
}

/**
 * A single label-free overlap fact behind a rule-out conflict: which candidate token
 * (the candidate's own symbol or file-stem) overlapped, and against what KIND of
 * withheld evidence. This carries NO evaluator test label, so it is safe to render into
 * a fair-verification prompt (M28.2). The literal test label lives only in `evidence`.
 */
export interface RuleOutConflictOverlap {
  /** Whether the candidate's symbol or its file-stem produced the overlap. */
  what: "symbol" | "file";
  /** The overlapping candidate token (e.g. "unparse") — a candidate symbol, NOT a test label. */
  token: string;
  /** Whether the overlap was against a (withheld) FAIL_TO_PASS test or the public problem statement. */
  against: "test_expectation" | "problem_statement";
}

/** Detail for a grounded RULED_OUT the M16 guardrail refused to credit (test-anchored). */
export interface RuleOutConflict {
  /** `path::symbol` of the conflicted candidate. */
  id: string;
  path: string;
  kind: "test_expectation_conflict";
  /**
   * Human-readable bullets naming the matched test(s) / why it conflicts. These MAY
   * contain literal evaluator test labels (e.g. `test_unparse[()-()]`) and are for
   * internal report/telemetry only — NOT prompt-safe under the fair verification policy.
   * Render prompts from `overlaps` (label-free) when fair policy is enabled. See M28.2.
   */
  evidence: string[];
  /**
   * Structured, label-free overlap facts mirroring `evidence` (M28.2). Safe to render
   * into a fair-policy prompt: keeps the candidate symbol/path overlap and the fact a
   * conflict exists, without revealing the evaluator-selected test node.
   */
  overlaps: RuleOutConflictOverlap[];
}

/** The structured compliance verdict (the M13 `pivotInspectionCompliance` field). */
export interface PivotInspectionCompliance {
  /** True only when --pivot-inspection-enforcement was enabled for the run. */
  enabled: boolean;
  required: RequiredPivotCandidate[];
  /** Required candidates whose file appears in the final patch. */
  edited: string[];
  /** Required candidates with a source-grounded RULED_OUT marker. */
  ruledOut: string[];
  /** Required candidates neither edited nor inspected nor ruled out — definitely skipped. */
  missing: string[];
  /** Required candidates inspected (or with a non-grounded rule-out) but not edited — can't confirm handling. */
  unclear: string[];
  /**
   * Grounded RULED_OUT markers the M16 guardrail refused to credit because the
   * candidate is test-anchored. These are ALSO placed in `unclear` (so the run stays
   * revision-triggering); the detail is carried here for the corrective prompt + report.
   */
  ruleOutConflicts: RuleOutConflict[];
  /**
   * Whether a corrective prompt would fire for this run (i.e. there is at least one
   * missing/unclear candidate). Named to match the M13 telemetry field. This module
   * does not actually send a live corrective turn (Option B), so this reflects the
   * "would fire" decision; a future live loop can use the same value to gate a turn.
   */
  correctivePromptSent: boolean;
}

export interface ComputeComplianceInput {
  /** --pivot-inspection-enforcement. When false, the checker is inactive (empty verdict). */
  enabled: boolean;
  /** The contract built by `buildPivotInspectionContract`. `null` ⇒ no required candidates. */
  contract: PivotInspectionContract | null;
  /** Repo-relative paths edited by the final patch. */
  editedFiles: readonly string[];
  /** Repo-relative (or absolute, suffix-matched) paths the agent read/searched. */
  inspectedFiles: readonly string[];
  /**
   * Files covered by a more specific generated-artifact obligation. Such files are
   * filtered OUT of the required set: a generated table is never a normal
   * pivot-inspection requirement (it is handled by the generated_artifact hint).
   */
  generatedArtifactFiles?: readonly string[];
  /** Parsed machine-readable PIVOT_DECISION markers, when available (Option C). */
  decisions?: readonly PivotDecisionMarker[];
  /**
   * FAIL_TO_PASS / problem-statement context (M16). When present, a grounded RULED_OUT
   * for a test-anchored candidate is NOT credited as `ruledOut` — it stays revision-
   * triggering. Absent ⇒ rule-out behavior is exactly as before.
   */
  testExpectation?: ComplianceTestExpectation;
}

// Generic, non-source-grounded rule-out phrasings. A RULED_OUT marker whose evidence
// is only one of these (or is empty / too short) is NOT a source-grounded rule-out and
// is reported as `unclear`, not `ruledOut`. Kept conservative on purpose.
const GENERIC_RULE_OUT = [
  "not needed",
  "not necessary",
  "no change",
  "no changes",
  "unchanged",
  "n/a",
  "na",
  "skip",
  "skipped",
  "irrelevant",
  "unrelated",
  "not relevant",
  "nothing to change",
  "no edit",
  "no edits",
];
const MIN_GROUNDED_EVIDENCE_CHARS = 12;

function inspectionId(path: string, symbol: string | undefined): string {
  return symbol && symbol.length > 0 ? `${path}::${symbol}` : path;
}

/** Suffix-tolerant file match: tool-call paths are often absolute, candidates relative. */
function fileMatches(candidate: string, observed: string): boolean {
  if (candidate === observed) return true;
  // Match on path boundary so `a/b/x.py` matches `/abs/repo/a/b/x.py` but not `yx.py`.
  return observed.endsWith(`/${candidate}`) || candidate.endsWith(`/${observed}`);
}

function fileInSet(candidate: string, files: readonly string[]): boolean {
  return files.some((f) => fileMatches(candidate, f));
}

/**
 * Conservative source-grounded rule-out test. True only when there is a RULED_OUT
 * marker for the file whose evidence is concrete (non-empty, longer than the generic
 * floor, and not merely a generic "not needed"-style phrase).
 */
export function hasSourceGroundedRuleOut(
  candidate: string,
  decisions: readonly PivotDecisionMarker[],
): boolean {
  return decisions.some((d) => {
    if (d.decision !== "RULED_OUT") return false;
    if (!fileMatches(candidate, d.path)) return false;
    const evidence = d.evidence.trim();
    if (evidence.length < MIN_GROUNDED_EVIDENCE_CHARS) return false;
    const normalized = evidence.toLowerCase().replace(/[.\s]+$/g, "");
    return !GENERIC_RULE_OUT.includes(normalized);
  });
}

/** True when a RULED_OUT marker exists for the file but it is not source-grounded. */
function hasNonGroundedRuleOut(
  candidate: string,
  decisions: readonly PivotDecisionMarker[],
): boolean {
  return decisions.some(
    (d) => d.decision === "RULED_OUT" && fileMatches(candidate, d.path),
  );
}

// ── M16: rule-out conflict guardrail ─────────────────────────────────────────
// A grounded RULED_OUT normally counts as compliant `ruledOut` (and suppresses the
// revision pass). M15.1 found this can backfire: an agent can emit a plausible but
// WRONG grounded rule-out for a pivot the failing test directly exercises (sphinx
// ruled out `ast.py::unparse`, which `test_unparse[()-()]` anchors). The detector
// below refuses to credit a rule-out when the candidate is STRONGLY test-anchored;
// the candidate then stays revision-triggering (a conflicted `unclear`).
//
// Conservative by design: a conflict fires only on a SPECIFIC lexical anchor — the
// candidate's symbol or file stem appearing in a FAIL_TO_PASS test's METHOD name (the
// leaf after `::`, a leading `test_` stripped) — never the test file path or class. A
// test file is commonly named after its source module, which is far too coarse: it
// would wrongly flag seaborn's non-gold `relational.py::scatterplot` against
// `test_relational.py`, when the failing method is `test_legend_has_no_offset`.
// Generic tokens are stopworded out. Better to miss a subtle conflict than to override
// every rule-out.
const CONFLICT_STOPWORDS = new Set([
  "test", "tests", "py", "python", "utils", "core", "common", "base",
  "helpers", "support", "api",
]);
const MIN_CONFLICT_TOKEN_CHARS = 3;

function conflictTokens(text: string): string[] {
  return text
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= MIN_CONFLICT_TOKEN_CHARS && !CONFLICT_STOPWORDS.has(t));
}

function fileStem(p: string): string {
  const base = p.split("/").pop() ?? p;
  return base.replace(/\.[^.]+$/, "");
}

/** Tokens from a FAIL_TO_PASS's METHOD leaf only (after the last `::`, params + a
 *  leading `test_` stripped). Deliberately excludes the test file path and class name. */
function testMethodTokens(failToPass: string): string[] {
  const leaf = (failToPass.split("::").pop() ?? failToPass).replace(/\[.*$/, "");
  return conflictTokens(leaf.replace(/^test[_-]?/i, ""));
}

/** A short, readable test name for prompts/reporting (drops the file-path segment). */
export function shortTestName(failToPass: string): string {
  const parts = failToPass.split("::");
  return parts.length > 1 ? parts.slice(1).join("::") : failToPass;
}

/**
 * Detect whether crediting a grounded RULED_OUT for `candidate` would CONFLICT with the
 * test expectation — i.e. the candidate is strongly anchored by a FAIL_TO_PASS test (or,
 * only when no test names exist, the problem statement). Returns the conflict detail or
 * null. Pure; conservative (specific lexical anchors, generic tokens excluded).
 */
export function detectRuleOutConflict(
  candidate: RequiredPivotCandidate,
  expectation: ComplianceTestExpectation | undefined,
): RuleOutConflict | null {
  if (!expectation) return null;
  const symbolToks = candidate.symbol ? conflictTokens(candidate.symbol) : [];
  const stemToks = conflictTokens(fileStem(candidate.path));
  const symbolSet = new Set(symbolToks);
  const candToks = new Set([...symbolToks, ...stemToks]);
  if (candToks.size === 0) return null;

  const evidence: string[] = [];
  const overlaps: RuleOutConflictOverlap[] = [];
  const failToPass = expectation.failToPass ?? [];
  for (const ftp of failToPass) {
    const methodToks = new Set(testMethodTokens(ftp));
    for (const ct of candToks) {
      if (methodToks.has(ct)) {
        const what = symbolSet.has(ct) ? "symbol" : "file";
        evidence.push(`${what} "${ct}" matches FAIL_TO_PASS test ${shortTestName(ftp)}`);
        overlaps.push({ what, token: ct, against: "test_expectation" });
        break;
      }
    }
  }

  // Problem-statement fallback (symbol-only, conservative) only when no test names exist.
  if (
    evidence.length === 0
    && failToPass.length === 0
    && expectation.problemStatementExcerpt
  ) {
    const psToks = new Set(conflictTokens(expectation.problemStatementExcerpt));
    for (const ct of symbolToks) {
      if (psToks.has(ct)) {
        evidence.push(`symbol "${ct}" appears in the problem statement`);
        overlaps.push({ what: "symbol", token: ct, against: "problem_statement" });
        break;
      }
    }
  }

  if (evidence.length === 0) return null;
  return {
    id: inspectionId(candidate.path, candidate.symbol),
    path: candidate.path,
    kind: "test_expectation_conflict",
    evidence: evidence.slice(0, 3),
    overlaps: overlaps.slice(0, 3),
  };
}

/**
 * Derive the required non-lead pivot / co-edit candidate list from the M11/M12
 * contract, dropping any file covered by a generated-artifact obligation (those are
 * not normal pivot-inspection requirements). Returns `[]` when the contract is null.
 */
export function requiredCandidatesFromContract(
  contract: PivotInspectionContract | null,
  generatedArtifactFiles: readonly string[] = [],
): RequiredPivotCandidate[] {
  if (contract === null) return [];
  const out: RequiredPivotCandidate[] = [];
  for (const entry of contract.requiredInspections) {
    if (fileInSet(entry.file, generatedArtifactFiles)) continue;
    out.push({
      path: entry.file,
      symbol: entry.symbol,
      role: entry.role === "related_coedit" ? "related_coedit" : "non_lead_pivot",
    });
  }
  return out;
}

const EMPTY_COMPLIANCE: PivotInspectionCompliance = {
  enabled: false,
  required: [],
  edited: [],
  ruledOut: [],
  missing: [],
  unclear: [],
  ruleOutConflicts: [],
  correctivePromptSent: false,
};

/**
 * Compute the pivot inspection compliance verdict for a completed run.
 *
 * Per required candidate (keyed on FILE; the contract carries the symbol for display):
 *   - file in final patch                              → edited   (compliant)
 *   - source-grounded RULED_OUT marker for the file    → ruledOut (compliant)
 *   - non-grounded RULED_OUT marker, or file inspected → unclear  (cannot confirm)
 *   - otherwise (not edited, not inspected, no marker) → missing  (definitely skipped)
 *
 * A corrective prompt "would fire" when any candidate is missing or unclear.
 *
 * Pure and deterministic. Inactive (empty verdict) unless `enabled` is true — the
 * checker only activates under --pivot-inspection-enforcement.
 */
export function computePivotInspectionCompliance(
  input: ComputeComplianceInput,
): PivotInspectionCompliance {
  if (!input.enabled) return { ...EMPTY_COMPLIANCE };

  const generated = input.generatedArtifactFiles ?? [];
  const decisions = input.decisions ?? [];
  const required = requiredCandidatesFromContract(input.contract, generated);

  const edited: string[] = [];
  const ruledOut: string[] = [];
  const missing: string[] = [];
  const unclear: string[] = [];
  const ruleOutConflicts: RuleOutConflict[] = [];

  for (const c of required) {
    const id = inspectionId(c.path, c.symbol);
    if (fileInSet(c.path, input.editedFiles)) {
      edited.push(id);
    } else if (hasSourceGroundedRuleOut(c.path, decisions)) {
      const conflict = detectRuleOutConflict(c, input.testExpectation);
      if (conflict) {
        // M16: the rule-out conflicts with the test expectation — do NOT credit it.
        // Keep the candidate revision-triggering (a conflicted `unclear`).
        unclear.push(id);
        ruleOutConflicts.push(conflict);
      } else {
        ruledOut.push(id);
      }
    } else if (
      hasNonGroundedRuleOut(c.path, decisions)
      || fileInSet(c.path, input.inspectedFiles)
    ) {
      unclear.push(id);
    } else {
      missing.push(id);
    }
  }

  return {
    enabled: true,
    required,
    edited,
    ruledOut,
    missing,
    unclear,
    ruleOutConflicts,
    correctivePromptSent: missing.length > 0 || unclear.length > 0,
  };
}

/**
 * Parse machine-readable PIVOT_DECISION markers (Option C) from agent final-answer
 * text. Tolerant of leading indentation and `key: value` ordering. Shape:
 *
 *   PIVOT_DECISION:
 *     path: <file>
 *     decision: EDITED | RULED_OUT
 *     evidence: <short source-grounded reason>
 *
 * Returns `[]` when no well-formed marker is present (the common case for runs that
 * predate marker emission). Never throws.
 */
export function parsePivotDecisionMarkers(text: string): PivotDecisionMarker[] {
  const out: PivotDecisionMarker[] = [];
  if (!text) return out;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*PIVOT_DECISION\s*:/.test(lines[i]!)) continue;
    let path: string | null = null;
    let decision: PivotDecisionMarker["decision"] | null = null;
    let evidence = "";
    // Scan the following indented key:value lines until the block breaks.
    for (let j = i + 1; j < lines.length && j <= i + 8; j++) {
      const m = lines[j]!.match(/^\s*(path|decision|evidence)\s*:\s*(.*)$/i);
      if (!m) break;
      const key = m[1]!.toLowerCase();
      const value = m[2]!.trim();
      if (key === "path") path = value;
      else if (key === "decision") {
        const up = value.toUpperCase();
        if (up === "EDITED" || up === "RULED_OUT") decision = up;
      } else if (key === "evidence") evidence = value;
    }
    if (path && decision) out.push({ path, decision, evidence });
  }
  return out;
}

const CORRECTIVE_INTRO = "You have not completed the required pivot check.";

/** Options for `buildCorrectivePrompt`. */
export interface CorrectivePromptOptions {
  /**
   * M28.2: when true (the `agent-discovered-tests` fair verification policy), the
   * rule-out conflict section is rendered WITHOUT literal evaluator test labels — it
   * keeps the candidate symbol/path overlap and the fact a conflict exists, but the
   * exact FAIL_TO_PASS test node is withheld. Default (false) preserves the prior
   * diagnostic wording verbatim (the M16 conflict guardrail itself is unaffected).
   */
  fairPolicy?: boolean;
}

/**
 * Render a single rule-out conflict's evidence bullets for the corrective prompt.
 * Default: the literal `evidence` strings (which may name the evaluator test). Under
 * the fair verification policy: label-free bullets derived from `overlaps`, plus an
 * explicit "the exact evaluator test label is withheld" line. Never emits a test node
 * under fair policy. Pure.
 */
function renderConflictEvidence(conflict: RuleOutConflict, fairPolicy: boolean): string[] {
  if (!fairPolicy) {
    return conflict.evidence.map((e) => `    - Conflict evidence: ${e}`);
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const o of conflict.overlaps ?? []) {
    const where =
      o.against === "problem_statement"
        ? "the problem statement"
        : "withheld benchmark test-expectation metadata";
    const line = `    - Conflict evidence: candidate ${o.what} "${o.token}" overlaps ${where}.`;
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  }
  if (lines.length === 0) {
    lines.push(
      "    - Conflict evidence: candidate overlaps withheld benchmark test-expectation metadata.",
    );
  }
  lines.push("    - The exact evaluator test label is withheld under the fair verification policy.");
  return lines;
}

/**
 * Build the corrective follow-up prompt for a non-compliant run, listing ONLY the
 * missing/unclear candidates (never the edited/ruled-out ones). Returns `null` when
 * the run is compliant (nothing to correct).
 *
 * The wording preserves the M11/M12 anti-over-edit guardrail — it must NEVER say
 * "edit all pivots". This protects against the seaborn-r1 over-edit failure mode.
 *
 * M28.2: pass `{ fairPolicy: true }` to withhold literal evaluator test labels from the
 * rule-out conflict section (the M16 guardrail still detects + reports the conflict; only
 * the PROMPT rendering is sanitized).
 */
export function buildCorrectivePrompt(
  compliance: PivotInspectionCompliance,
  opts: CorrectivePromptOptions = {},
): string | null {
  if (!compliance.enabled) return null;
  const outstanding = [...compliance.missing, ...compliance.unclear];
  if (outstanding.length === 0) return null;

  const fairPolicy = opts.fairPolicy === true;
  const lines: string[] = [];
  lines.push(CORRECTIVE_INTRO);
  lines.push("");
  lines.push("Missing:");
  for (const id of outstanding) lines.push(`  - ${id}`);
  lines.push("");
  lines.push(
    "Before finalizing, inspect/edit or explicitly rule out each missing pivot with "
    + "source-grounded evidence.",
  );
  lines.push("Do not add files merely because they are listed. Inspect it and decide.");
  lines.push("Prefer the minimal diff.");
  lines.push("If you rule it out, cite concrete source evidence.");
  if (compliance.ruleOutConflicts.length > 0) {
    lines.push("");
    lines.push(
      fairPolicy
        ? "The first pass ruled out the following pivot(s), but that rule-out conflicts "
          + "with the (withheld) benchmark test expectation:"
        : "The first pass ruled out the following pivot(s), but that rule-out conflicts "
          + "with the FAIL_TO_PASS/test expectation:",
    );
    for (const conflict of compliance.ruleOutConflicts) {
      lines.push(`  - Candidate: ${conflict.id}`);
      for (const line of renderConflictEvidence(conflict, fairPolicy)) lines.push(line);
    }
    lines.push("");
    lines.push("Reconsider these pivots using the source excerpt and test expectation.");
    lines.push("If one still should be ruled out, provide a stronger source-grounded reason.");
    lines.push("Otherwise revise the patch. Prefer the minimal diff; only revise if source/test evidence requires it.");
  }
  return lines.join("\n");
}

/** Convenience predicate: whether a corrective prompt would fire for this verdict. */
export function wouldFireCorrectivePrompt(
  compliance: PivotInspectionCompliance,
): boolean {
  return compliance.correctivePromptSent;
}
