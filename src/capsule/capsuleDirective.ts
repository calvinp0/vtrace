// Capsule directive composition.
//
// A capsule's job is not to list "relevant things" — it is to tell the agent
// EDIT HERE FIRST, with just enough justification to be trusted, and a clear
// signal for how hard to search before falling back to broad exploration. This
// module turns the recovered pivot + its evidence + the task's confidence into:
//
//   * an action header  — open/edit <pivot> first, why, and an edit-intent hint;
//   * a search budget    — low / moderate / high (Requirement 5);
//   * a recommended-mode override when a single-pivot (micro) capsule would be
//     a coin-flip between two equally-likely targets (Requirement 2).
//
// All of it is derived from the scorecard + shaped query — never from a hardcoded
// instance id or file path (Requirement 4).

import type { CapsuleActionHeader, SearchBudget } from "./capsuleDiagnostics";
import { RecommendedCapsuleMode, TargetConfidence } from "./recommendMode";
import type { ShapedSweQuery } from "./sweQueryShaping";

interface EditIntentRule {
  readonly test: RegExp;
  readonly hint: string;
}

// Ordered, first-match-wins. Each rule keys off a GENERIC subsystem vocabulary
// term that recurs across many issues (an "inline hook", "aggregate distinct",
// "named regex group", a "migration dependency", "composed queries") — never an
// instance-specific identifier. The hint names the KIND of code to inspect, not
// a specific symbol, so it generalises beyond the five Stage 5 fixtures.
//
// This table is the main piece of human judgement in the directive: extend it
// with the subsystem vocabulary of whatever codebase vtrace is pointed at.
const EDIT_INTENT_RULES: readonly EditIntentRule[] = [
  {
    test: /\bget_inlines?\b|\binline[_ ]?(?:instances?|formsets?|admin)?\b/i,
    hint: "inspect inline selection methods before formset rendering.",
  },
  {
    test: /\bdistinct\b|\baggregat|\bannotat/i,
    hint: "inspect aggregate SQL rendering before query-compiler plumbing.",
  },
  {
    test: /\bnamed[_ ]?group|\bunnamed[_ ]?group|\bregexp?\b|\bpattern\b/i,
    hint: "inspect regex group replacement helpers.",
  },
  {
    test: /\bautodetector\b|\bmigrat|\bdependenc/i,
    hint: "inspect dependency generation before model definitions.",
  },
  {
    test: /\bcombinator|\bcomposed quer|\bunion\b|\bvalues\(\)|\bqueryset/i,
    hint: "inspect combined-query column propagation before the base query builder.",
  },
];

// Derive a one-line "what change to look for" cue from the issue/test terms.
// Falls back to pointing at the pivot's own neighbourhood when no subsystem rule
// matches, so the hint is present whenever a target is.
export function deriveEditIntentHint(
  shaped: ShapedSweQuery,
  pivotSymbol?: string,
): string | undefined {
  const haystack = [shaped.query, ...shaped.identifiers, ...shaped.likelySymbols].join(" ");
  for (const rule of EDIT_INTENT_RULES) {
    if (rule.test.test(haystack)) {
      return rule.hint;
    }
  }
  return pivotSymbol
    ? `inspect \`${pivotSymbol}\` and the methods it calls before searching elsewhere.`
    : undefined;
}

export interface SearchBudgetInput {
  /** A concrete edit target was recovered. */
  hasPivot: boolean;
  /** Two close pivot candidates — the choice is not decisive. */
  ambiguous: boolean;
  /** The task's target confidence. */
  confidence: TargetConfidence;
  /** The pivot has a concrete pointer (failing-test / symbol-name / path) hit. */
  directEvidence: boolean;
}

// Classify how hard the agent should search before trusting the capsule (Req 5):
//   high-confidence pivot + direct test/issue evidence -> low
//   medium confidence, or indirect evidence            -> moderate
//   no pivot / ambiguous                               -> high (or skip)
export function classifySearchBudget(
  input: SearchBudgetInput,
): { budget: SearchBudget; reason: string } {
  if (!input.hasPivot) {
    return { budget: "high", reason: "No high-confidence pivot recovered; broad search or skip." };
  }
  if (input.ambiguous) {
    return {
      budget: "high",
      reason: "Two close candidates; verify against the failing test before committing to one target.",
    };
  }
  if (input.confidence === TargetConfidence.High && input.directEvidence) {
    return {
      budget: "low",
      reason: "High-confidence pivot with direct test/issue evidence; try this target first.",
    };
  }
  return {
    budget: "moderate",
    reason: input.directEvidence
      ? "Pivot has direct evidence but only medium confidence; check the pivot and one support symbol."
      : "Pivot recovered via graph/domain reach only; check the pivot and one support symbol.",
  };
}

export interface ComposeDirectiveInput {
  shaped: ShapedSweQuery;
  /**
   * The lead pivot. Undefined when no high-confidence target was recovered, in
   * which case the action header is a "do not inject context" directive.
   */
  pivot?: {
    filePath: string;
    localName: string;
    evidence: readonly string[];
    /** Has a concrete failing-test / symbol-name / likely-file pointer. */
    directEvidence: boolean;
  };
  confidence: TargetConfidence;
  /** Two close pivot candidates (micro) — render a recommended-mode override. */
  ambiguous: boolean;
}

export interface CapsuleDirective {
  actionHeader: CapsuleActionHeader;
  searchBudget: SearchBudget;
  searchBudgetReason: string;
  /** When set, overrides the recommended mode (ambiguous micro -> standard). */
  recommendedModeOverride?: RecommendedCapsuleMode;
}

const MAX_WHY_LINES = 3;

// Compose the action header + search budget + mode override for a capsule.
export function composeCapsuleDirective(input: ComposeDirectiveInput): CapsuleDirective {
  const pivot = input.pivot;
  const hasTarget = pivot !== undefined;

  const editIntentHint = hasTarget
    ? (deriveEditIntentHint(input.shaped, pivot.localName) ?? null)
    : null;

  const { budget, reason } = classifySearchBudget({
    hasPivot: hasTarget,
    ambiguous: input.ambiguous,
    confidence: input.confidence,
    directEvidence: pivot?.directEvidence ?? false,
  });

  const actionHeader: CapsuleActionHeader = {
    has_target: hasTarget,
    pivot_file: pivot?.filePath ?? null,
    pivot_symbol: pivot?.localName ?? null,
    why: pivot ? dedupeNonEmpty(pivot.evidence).slice(0, MAX_WHY_LINES) : [],
    edit_intent_hint: editIntentHint,
  };

  // A single-pivot micro capsule cannot decisively choose between two close
  // candidates; recommend standard (more room to carry both) unless confidence
  // is already high enough to trust the lead. Never emitted when there is one
  // clear pivot, so an unambiguous micro stays micro.
  const recommendedModeOverride =
    input.ambiguous && input.confidence !== TargetConfidence.High
      ? RecommendedCapsuleMode.Standard
      : undefined;

  return {
    actionHeader,
    searchBudget: budget,
    searchBudgetReason: reason,
    ...(recommendedModeOverride ? { recommendedModeOverride } : {}),
  };
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
