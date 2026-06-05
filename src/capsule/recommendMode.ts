// Recommended-mode heuristic.
//
// Given the signals distilled from a SWE-bench record, recommend how much
// oriented context vtrace should inject. This is DIAGNOSTIC first: it reports
// a recommendation and a confidence, and the CLI decides whether to act on it.
//
//   recommend micro / skip when the task is small and local — one failing test,
//   a short problem statement, explicit target symbols/files, few likely files.
//
//   recommend full when the task is navigation-heavy — migrations / compiler /
//   parser / autodetector / query internals, cross-module dependency behaviour,
//   a long issue/hints body, or many likely files/symbols.

import { CapsuleMode } from "./capsuleModes";
import type { ShapedSweQuery, SweIssueRecord } from "./sweQueryShaping";

export const RecommendedCapsuleMode = Object.freeze({
  Skip: "skip",
  Micro: CapsuleMode.Micro,
  Standard: CapsuleMode.Standard,
  Full: CapsuleMode.Full,
});

export type RecommendedCapsuleMode =
  (typeof RecommendedCapsuleMode)[keyof typeof RecommendedCapsuleMode];

export const TargetConfidence = Object.freeze({
  Low: "low",
  Medium: "medium",
  High: "high",
});

export type TargetConfidence = (typeof TargetConfidence)[keyof typeof TargetConfidence];

export interface ModeRecommendationSignals {
  failingTestCount: number;
  /** Combined problem statement + hints length, in characters. */
  problemLength: number;
  /**
   * Problem statement length ONLY (hints excluded), in characters. The micro
   * gate keys off this: a long hints body describing background/repro should not
   * make a small, local edit look medium-sized.
   */
  problemStatementLength: number;
  likelyFileCount: number;
  likelySymbolCount: number;
  /** Touches migrations/compiler/parser/autodetector/query internals. */
  touchesComplexInternals: boolean;
  /** Touches more than one module / cross-module dependency behaviour. */
  crossModule: boolean;
  /** At least one concrete file or symbol was surfaced. */
  hasExplicitTargets: boolean;
}

export interface ModeRecommendation {
  recommendedMode: RecommendedCapsuleMode;
  targetConfidence: TargetConfidence;
  retrievalReason: string;
}

// Keep thresholds named so the heuristic reads as policy, not magic numbers.
const LONG_ISSUE_CHARS = 1_200;
const SHORT_ISSUE_CHARS = 600;
const TINY_ISSUE_CHARS = 200;
const MANY_FILES = 3;
const MANY_SYMBOLS = 6;

// Matched against the combined prose + likely file paths. Curated to the
// internals the Stage 5 brief calls out.
//
// These must be PRECISE: a bare "SQL" or a "query" substring inside a test name
// (e.g. test_aggregation_subquery_annotation_multiline) is NOT evidence of a
// navigation-heavy task — it leaks in from prose and method names of plenty of
// small, local edits. We therefore key off two precise signals only:
//   1. real subsystem path/module names (django/db/models/sql/, compiler.py,
//      query.py, autodetector.py, the migrations package);
//   2. named multi-word subsystem phrases (SQL compiler, composed queries) or
//      the QuerySet/combinator/regex/parser machinery.
// A standalone "SQL", "query", or "subquery" deliberately does NOT match.
const COMPLEX_INTERNALS_PATTERNS: readonly RegExp[] = [
  // Migrations / autodetector internals.
  /\bmigrat/i,
  /\bautodetector\b/i,
  // SQL compiler / query-construction subsystem — by module/path or named
  // phrase, never a bare "SQL"/"query" mention.
  /\bcompil/i,
  /\bquery\.py\b/i,
  /\bdb\/models\/sql\b/i,
  /\bsql\/[a-z]/i,
  /\bsql compiler\b/i,
  /\bcomposed quer/i,
  /\bquerysets?\b/i,
  /\bcombinator/i,
  // Regex / pattern parsing subsystem.
  /\bregex/i,
  /\bpars(?:e|er|ed|ing)\b/i,
];

const CROSS_MODULE_PHRASES = /cross[- ]module|across modules|dependency behaviour|dependencies for|dependency on/i;

export function recommendCapsuleMode(
  signals: ModeRecommendationSignals,
): ModeRecommendation {
  // Length-based escalation keys off the PROBLEM STATEMENT, not the combined
  // body: a long hints section (repro logs, tracebacks, mailing-list quotes) is
  // not itself a sign of a navigation-heavy task, and must not push a small local
  // edit toward `full` any more than it should push it out of `micro`.
  const longIssue = signals.problemStatementLength >= LONG_ISSUE_CHARS;
  const manyTargets =
    signals.likelyFileCount >= MANY_FILES || signals.likelySymbolCount >= MANY_SYMBOLS;

  if (signals.touchesComplexInternals || signals.crossModule || longIssue || manyTargets) {
    return {
      recommendedMode: RecommendedCapsuleMode.Full,
      targetConfidence: confidenceFor(signals),
      retrievalReason: fullReason(signals, { longIssue, manyTargets }),
    };
  }

  const explicitSingleTarget =
    signals.hasExplicitTargets
    && signals.failingTestCount <= 1
    && signals.likelyFileCount <= 1
    && signals.problemStatementLength < SHORT_ISSUE_CHARS;

  if (explicitSingleTarget) {
    return {
      recommendedMode: RecommendedCapsuleMode.Micro,
      targetConfidence: confidenceFor(signals),
      retrievalReason:
        "Small/local task: one failing test, short problem statement, and an explicit target — "
        + "a micro capsule avoids navigation overhead.",
    };
  }

  if (!signals.hasExplicitTargets && signals.problemLength < TINY_ISSUE_CHARS) {
    return {
      recommendedMode: RecommendedCapsuleMode.Skip,
      targetConfidence: TargetConfidence.Low,
      retrievalReason:
        "No concrete files/symbols surfaced and the issue is tiny; oriented context is unlikely to help.",
    };
  }

  return {
    recommendedMode: RecommendedCapsuleMode.Standard,
    targetConfidence: confidenceFor(signals),
    retrievalReason:
      "Moderate task with no strong signal toward either extreme; a standard capsule is the safe default.",
  };
}

function confidenceFor(signals: ModeRecommendationSignals): TargetConfidence {
  if (!signals.hasExplicitTargets) {
    return TargetConfidence.Low;
  }

  const concreteTargets = signals.likelyFileCount + signals.likelySymbolCount;
  return concreteTargets >= 3 && signals.failingTestCount >= 1
    ? TargetConfidence.High
    : TargetConfidence.Medium;
}

function fullReason(
  signals: ModeRecommendationSignals,
  flags: { longIssue: boolean; manyTargets: boolean },
): string {
  const reasons: string[] = [];
  if (signals.touchesComplexInternals) {
    reasons.push("touches complex internals (migrations/compiler/parser/autodetector/query)");
  }
  if (signals.crossModule) {
    reasons.push("cross-module dependency behaviour");
  }
  if (flags.longIssue) {
    reasons.push("long issue/hints body");
  }
  if (flags.manyTargets) {
    reasons.push("multiple likely files/symbols");
  }
  return `Navigation-heavy task: ${reasons.join("; ")} — a full capsule is warranted.`;
}

// Derive the recommendation signals from a SWE record and its shaped query. The
// complex-internals and cross-module checks look at both the prose and the
// surfaced file paths so a deep-internals task is caught even when the prose is
// terse.
export function deriveModeSignals(
  record: SweIssueRecord,
  shaped: ShapedSweQuery,
): ModeRecommendationSignals {
  const prose = `${record.problemStatement ?? ""}\n${record.hintsText ?? ""}`;
  const haystack = `${prose}\n${shaped.likelyFiles.join("\n")}`;

  return {
    failingTestCount: shaped.failingTests.length,
    problemLength: prose.trim().length,
    problemStatementLength: (record.problemStatement ?? "").trim().length,
    likelyFileCount: shaped.likelyFiles.length,
    likelySymbolCount: shaped.likelySymbols.length,
    touchesComplexInternals: COMPLEX_INTERNALS_PATTERNS.some((pattern) => pattern.test(haystack)),
    crossModule: shaped.likelyFiles.length >= 2 || CROSS_MODULE_PHRASES.test(prose),
    hasExplicitTargets: shaped.likelyFiles.length > 0 || shaped.likelySymbols.length > 0,
  };
}
