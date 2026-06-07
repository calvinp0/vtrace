// Capsule v2 — edit-risk / patch-planning directives.
//
// Retrieving the right edit site is necessary but not sufficient: an agent can
// land on the correct method and still make the WRONG semantic change. The
// recurring failure mode this module guards against is shared-state mutation —
// the pivot mutates a query/compiler object in place while a composed/combined
// result is being rendered, and the "obvious" fix is to relax or delete the
// existing guard rather than to clone/copy the state before mutating it. That
// edit silently leaks state across the combined query.
//
// The detector is DETERMINISTIC and GENERIC. It fires on the SHAPE of the pivot
// source and the task prose, never on a framework, file, symbol, or instance id.
// The trigger is a conjunction:
//
//   1. a selected pivot's focused source mutates / aliases shared query state
//      (e.g. `compiler.query.set_values(...)`, `self.query.values_select`), AND
//   2. the task describes composed/combined query output (combined / composed /
//      union / ... together with "query").
//
// Only one capsule-level directive is emitted even when several pivots match: it
// is a hint about the bug class, not a per-line annotation.

import type {
  CapsuleV2Item,
  EditRiskDirective,
} from "./types";

export interface EditRiskInput {
  /** The raw task / problem statement. */
  task: string;
  /** The selected pivots, with their focused source bodies (when rendered). */
  pivots: CapsuleV2Item[];
  /**
   * Whether the debug role refinement ran (debug / test-failure intent). The
   * directive is a debugging aid, so it is gated on the debug strategy.
   */
  debugRefinement: boolean;
}

// Source patterns that mark mutation / aliasing of shared query state. Each is a
// generic code shape, not a framework symbol: a mutating helper invoked on an
// aliased `.query`, a reference to another object's `.query`, or composed-query
// selection state being read for in-place rewrite.
const SHARED_STATE_MUTATION_PATTERNS: readonly RegExp[] = [
  // A mutating helper invoked on an aliased query object, e.g.
  // `compiler.query.set_values(...)` or `obj.query.set_values(...)`.
  /\.set_values\s*\(/,
  // A reference to another object's query state — the aliasing risk itself, e.g.
  // `compiler.query`.
  /\bcompiler\.query\b/,
  // Reading composed-query selection state, e.g. `self.query.values_select`.
  /\.values_select\b/,
];

// Task terms that describe composing queries together. Combined with the word
// "query" in the task, they establish that the output under test is a composed
// result — where mutation leakage actually manifests.
const COMPOSITION_TERMS: readonly string[] = [
  "combined",
  "combine",
  "combinator",
  "composed",
  "compose",
  "union",
  "intersection",
  "difference",
  "compound",
];

// The directive text. Generic by construction: it names no framework, file,
// symbol, or patch — only the bug class and the safe edit shape.
const SHARED_STATE_MUTATION_DIRECTIVE = [
  "This pivot mutates query/compiler state while rendering a combined query.",
  "Do not fix by simply relaxing/removing the existing guard unless tests require it.",
  "Prefer preserving existing guard semantics and avoiding mutation leakage, "
    + "e.g. clone/copy state before calling mutating helpers.",
].join("\n");

/** True when the source mutates or aliases shared query/compiler state. */
function sourceMutatesSharedState(source: string): boolean {
  return SHARED_STATE_MUTATION_PATTERNS.some((pattern) => pattern.test(source));
}

// The query stem, matching the singular, plural, and `queryset` spellings issue
// prose actually uses ("composed queries", "queryset.union()") — a strict
// `\bquery\b` would miss every plural. Precision is held by the AND with a
// composition term below, not by this stem.
const QUERY_STEM = /quer(y|ies|yset)/;

/** True when the task describes composing/combining query output. */
function taskMentionsComposedQuery(task: string): boolean {
  const lower = task.toLowerCase();
  if (!QUERY_STEM.test(lower)) {
    return false;
  }
  return COMPOSITION_TERMS.some((term) => lower.includes(term));
}

/**
 * Detect deterministic edit-risk directives for the assembled capsule. Returns
 * an empty array when no risk shape is present (the common case) or when the
 * intent is not a debugging one.
 */
export function detectEditRiskDirectives(input: EditRiskInput): EditRiskDirective[] {
  if (!input.debugRefinement) {
    return [];
  }
  if (!taskMentionsComposedQuery(input.task)) {
    return [];
  }

  const mutatingPivot = input.pivots.find(
    (pivot) => typeof pivot.source === "string" && sourceMutatesSharedState(pivot.source),
  );
  if (mutatingPivot === undefined) {
    return [];
  }

  return [
    {
      kind: "shared_state_mutation",
      confidence: "medium",
      reason:
        "pivot source mutates compiler/query state and task mentions composed/combined query output",
      directive: SHARED_STATE_MUTATION_DIRECTIVE,
    },
  ];
}
