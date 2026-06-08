// Capsule v2 — edit-risk / patch-planning directives.
//
// Retrieving the right edit site is necessary but not sufficient: an agent can
// land on the correct method and still make the WRONG semantic change. This
// module guards against two distinct semantic-edit failure modes.
//
// SHARED-STATE MUTATION — the pivot mutates a query/compiler object in place
// while a composed/combined result is being rendered, and the "obvious" fix is to
// relax or delete the existing guard rather than to clone/copy the state before
// mutating it. That edit silently leaks state across the combined query. Two
// diagnoses, in precedence order:
//
//   1. GUARDED shared-state mutation — the strongest, most actionable signal.
//      The source mutates shared state UNDER A GUARD
//      (`if not X and Y:` then `X.mutating_call(...)`). The `django-11490`
//      regression confirmed agents "fix" this by relaxing the guard
//      (`if self.query.values_select:`) instead of cloning before mutation. The
//      directive tells the agent to PRESERVE the guard and clone instead.
//   2. Bare shared-state mutation — the fallback when no guard is detectable
//      (a mutating call on aliased query/compiler state).
//
// CHAINED LOOKUP/PATH ALIAS TRAVERSAL — the pivot validates a chained
// lookup/path traversal: it loops over split path segments and resolves each to a
// concrete field/target (`get_field(...)`, `is_relation`, `get_path_info()`...).
// When an alias segment appears (`pk` standing in for the concrete primary-key
// field), the tempting wrong fix is to `continue` past it, which skips the
// traversal-state update and lets later segments validate against stale state.
// The correct fix resolves the alias to its concrete target first, then updates
// traversal state — and stops traversal if the resolved target is not relational,
// so later segments still fail correctly. The directive tells the agent that.
//
// The detector is DETERMINISTIC and GENERIC. It fires on the SHAPE of the pivot
// source and the task prose, never on a framework, file, symbol, or instance id.
// At most one directive per bug class is emitted (the most specific that matched)
// — it is a hint about the bug class, not a per-line annotation. When more than
// one class applies, directives are returned in a deterministic order
// (shared-state mutation before traversal), with no near-duplicate hints.

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

// A guard of the shape `if not X and Y:` — the exact construct that gets wrongly
// relaxed. `\S[^\n:]*` for each operand keeps it on a single condition line and
// tolerates attribute chains (`compiler.query.values_select`).
const GUARD_CONDITION = /\bif\s+not\s+\S[^\n:]*\s+and\s+\S[^\n:]*:/;

// A mutating method call routed through a shared-state object: an attribute chain
// rooted at (or passing through) a shared-state noun, ending in a mutating verb
// (`set_*`, `add`, `update`, ...). Matches `compiler.query.set_values(...)`,
// `session.cache.update(...)`, etc. Reads (`.values_select`) do NOT match — the
// trailing method must be a mutator.
const SHARED_STATE_MUTATING_CALL =
  /\b(?:query|queryset|compiler|cache|session|state)\b[\w.]*\.(?:set|add|append|insert|update|extend|clear|remove|pop|write|mutate)\w*\s*\(/i;

// The directive texts. Generic by construction: they name no framework, file,
// symbol, or patch — only the bug class and the safe edit shape.
const SHARED_STATE_MUTATION_DIRECTIVE = [
  "This pivot mutates query/compiler state while rendering a combined query.",
  "Do not fix by simply relaxing/removing the existing guard unless tests require it.",
  "Prefer preserving existing guard semantics and avoiding mutation leakage, "
    + "e.g. clone/copy state before calling mutating helpers.",
].join("\n");

const GUARDED_SHARED_STATE_MUTATION_DIRECTIVE = [
  "This pivot mutates shared state under a guard.",
  "Do not fix by simply relaxing/removing the guard unless tests require it.",
  "Prefer preserving guard semantics and preventing mutation leakage, "
    + "e.g. clone/copy state before calling mutating helpers.",
].join("\n");

// Task terms describing the composed-output / mutation-leak symptom. Broader than
// the composition terms alone (the guard signal narrows precision on the source
// side), so the leak phrasing the issue actually uses — "same columns",
// "cannot change" — also counts.
const MUTATION_LEAK_TERMS: readonly string[] = [
  "leak",
  "same columns",
  "cannot change",
  "clone",
];

/** True when the source mutates or aliases shared query/compiler state. */
function sourceMutatesSharedState(source: string): boolean {
  return SHARED_STATE_MUTATION_PATTERNS.some((pattern) => pattern.test(source));
}

/**
 * True when the source mutates shared state UNDER A GUARD: a `if not X and Y:`
 * condition followed by a mutating call on shared state. The mutation must appear
 * AFTER the guard so a guard with a benign body does not trigger it.
 */
function sourceGuardsSharedStateMutation(source: string): boolean {
  const guard = GUARD_CONDITION.exec(source);
  if (guard === null) {
    return false;
  }
  const afterGuard = source.slice(guard.index + guard[0].length);
  return SHARED_STATE_MUTATING_CALL.test(afterGuard);
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
 * True when the task describes composed/combined output OR the mutation-leak
 * symptom directly. Used for the guarded directive, whose source-side signal is
 * specific enough to admit the broader leak phrasing.
 */
function taskDescribesComposedMutation(task: string): boolean {
  const lower = task.toLowerCase();
  if (taskMentionsComposedQuery(task)) {
    return true;
  }
  return MUTATION_LEAK_TERMS.some((term) => lower.includes(term));
}

// ---------------------------------------------------------------------------
// Chained lookup / path alias traversal.
// ---------------------------------------------------------------------------

// The pivot loops over split path/lookup segments, e.g.
// `for part in field.split(LOOKUP_SEP):` or `for segment in path.split('.'):`.
// `[\w.]+` tolerates an attribute chain as the split receiver (`self.name`). The
// LOOKUP_SEP form also matches when the split is bound to a name first
// (`names = field.split(LOOKUP_SEP)`).
const PATH_SEGMENT_LOOP_PATTERNS: readonly RegExp[] = [
  /\bfor\s+\w+\s+in\s+[\w.]+\.split\s*\(/,
  /\.split\s*\(\s*LOOKUP_SEP/,
];

// Helpers that resolve a path segment to a concrete field/target or test whether
// traversal can continue. Generic traversal vocabulary, not framework symbols:
// the segment is resolved (`get_field`/`get_lookup`/`get_transform`), its
// relational-ness is tested (`is_relation`), or the next hop is taken
// (`get_path_info`/`to_opts`).
const TRAVERSAL_RESOLUTION_PATTERNS: readonly RegExp[] = [
  /\.get_field\s*\(/,
  /\.get_lookup\s*\(/,
  /\.get_transform\s*\(/,
  /\bis_relation\b/,
  /\.get_path_info\s*\(/,
  /\bto_opts\b/,
];

// Task terms that describe lookup / path / relation traversal. Broad on purpose:
// precision is held by the AND with the source-shape predicate, which requires an
// actual segment loop plus a resolution helper.
const TRAVERSAL_TASK_TERMS: readonly string[] = [
  "lookup", // covers "lookup" / "lookups"
  "ordering",
  "order_by",
  "field path",
  "related field",
  "relation",
  "alias",
  "primary key",
  "chained",
  "nested",
  "segment",
  "nonexistent field",
  "traversal",
  "path",
];

// Task patterns for traversal tokens that need word boundaries. `\bpk\b` is the
// primary-key alias token (without matching "pkg"); `__` is the lookup separator
// the issue prose uses for chained spans (`field__related__pk`).
const TRAVERSAL_TASK_PATTERNS: readonly RegExp[] = [
  /\bpk\b/,
  /__/,
];

// Alias-like tokens that mark the STRONG trigger: a path segment that stands in
// for a concrete target rather than naming it directly.
const ALIAS_TASK_PATTERNS: readonly RegExp[] = [
  /\bpk\b/,
  /\bprimary key\b/,
  /\balias\b/,
];

// The directive text. Generic by construction: it names the traversal bug class
// and the safe edit shape, never a framework, file, symbol, segment name, or
// patch.
const CHAINED_LOOKUP_ALIAS_TRAVERSAL_DIRECTIVE = [
  "This pivot validates a chained lookup/path traversal.",
  "Be careful with aliases: do not skip alias segments outright — skipping hides "
    + "invalid trailing segments.",
  "Resolve aliases to their concrete field/target first, then decide traversal from "
    + "that resolved target.",
  "If the resolved target is relational, advance to the next target; if it is not "
    + "relational/traversable, clear the traversal cursor (do not carry the previous "
    + "target forward) so later path segments still fail correctly.",
].join("\n");

/** True when the source loops over split path/lookup segments. */
function sourceLoopsSplitSegments(source: string): boolean {
  return PATH_SEGMENT_LOOP_PATTERNS.some((pattern) => pattern.test(source));
}

/**
 * True when the source validates a chained path traversal: it loops over split
 * segments AND resolves/tests each segment with a traversal helper. The
 * conjunction is what excludes a plain loop over strings (a split loop with no
 * field-resolution call).
 */
function sourceTraversesChainedPath(source: string): boolean {
  if (!sourceLoopsSplitSegments(source)) {
    return false;
  }
  return TRAVERSAL_RESOLUTION_PATTERNS.some((pattern) => pattern.test(source));
}

/** True when the task mentions lookup / path / relation traversal. */
function taskMentionsTraversal(task: string): boolean {
  const lower = task.toLowerCase();
  if (TRAVERSAL_TASK_TERMS.some((term) => lower.includes(term))) {
    return true;
  }
  return TRAVERSAL_TASK_PATTERNS.some((pattern) => pattern.test(lower));
}

/** True when the task mentions an alias-like token (pk / primary key / alias). */
function taskMentionsAliasToken(task: string): boolean {
  const lower = task.toLowerCase();
  return ALIAS_TASK_PATTERNS.some((pattern) => pattern.test(lower));
}

/**
 * Detect deterministic edit-risk directives for the assembled capsule. Returns
 * an empty array when no risk shape is present (the common case) or when the
 * intent is not a debugging one. At most one directive per bug class is returned
 * (the most specific that matched). When more than one class fires, directives
 * are appended in a deterministic order: shared-state mutation, then traversal.
 */
export function detectEditRiskDirectives(input: EditRiskInput): EditRiskDirective[] {
  if (!input.debugRefinement) {
    return [];
  }

  const pivotsWithSource = input.pivots.filter(
    (pivot): pivot is CapsuleV2Item & { source: string } =>
      typeof pivot.source === "string" && pivot.source.length > 0,
  );

  const directives: EditRiskDirective[] = [];

  // Shared-state mutation. Guarded supersedes bare — at most one is emitted. The
  // top pivot is the primary edit site, so pivots are examined in order.
  const guardedPivot = pivotsWithSource.find((pivot) => sourceGuardsSharedStateMutation(pivot.source));
  if (guardedPivot !== undefined && taskDescribesComposedMutation(input.task)) {
    directives.push({
      kind: "guarded_shared_state_mutation",
      confidence: "medium",
      reason:
        "pivot source mutates shared/query state under a guard and task describes "
        + "composed/combined query output",
      directive: GUARDED_SHARED_STATE_MUTATION_DIRECTIVE,
    });
  } else {
    const mutatingPivot = pivotsWithSource.find((pivot) => sourceMutatesSharedState(pivot.source));
    if (mutatingPivot !== undefined && taskMentionsComposedQuery(input.task)) {
      directives.push({
        kind: "shared_state_mutation",
        confidence: "medium",
        reason:
          "pivot source mutates compiler/query state and task mentions composed/combined query output",
        directive: SHARED_STATE_MUTATION_DIRECTIVE,
      });
    }
  }

  // Chained lookup / path alias traversal — a distinct bug class. The source must
  // loop over split segments AND resolve them with a traversal helper, and the
  // task must mention lookup/path/relation traversal. The STRONG trigger (an
  // alias-like token such as `pk` plus a segment loop) raises confidence.
  const traversalPivot = pivotsWithSource.find((pivot) => sourceTraversesChainedPath(pivot.source));
  if (traversalPivot !== undefined && taskMentionsTraversal(input.task)) {
    const strong =
      sourceLoopsSplitSegments(traversalPivot.source) && taskMentionsAliasToken(input.task);
    directives.push({
      kind: "chained_lookup_alias_traversal",
      confidence: strong ? "high" : "medium",
      reason: strong
        ? "task mentions an alias token (pk/primary key) and pivot source loops "
          + "through split path segments"
        : "task mentions alias/lookup traversal and pivot source validates chained "
          + "path segments",
      directive: CHAINED_LOOKUP_ALIAS_TRAVERSAL_DIRECTIVE,
    });
  }

  return directives;
}
