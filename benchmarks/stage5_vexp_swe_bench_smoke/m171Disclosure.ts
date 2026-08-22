/**
 * M171-B — the model-facing truthfulness matrix (§10).
 *
 * Every field the current default response carries is classified here, with a
 * reason. The rule §10 states is "no field disappears by intuition", and the way
 * this file enforces it is `unclassifiedPaths`: a machine check that walks a real
 * response and reports any path no rule covers. A field that nobody thought
 * about shows up as a failure, not as a silent omission.
 *
 * The five classes are disclosure decisions, not importance rankings:
 *
 *   ALWAYS_MODEL_VISIBLE            in every default packet
 *   VISIBLE_WHEN_NONDEFAULT         only when its value is not the quiet case
 *   VISIBLE_WHEN_INTERPRETATION_CRITICAL
 *                                   only when omitting it would let a reader
 *                                   misread a claim that IS in the packet
 *   DEBUG_ONLY                      retained, reachable at detail=debug
 *   INTERNAL_ONLY                   never serialized in any mode
 *
 * PURE.
 */

export const Disclosure = Object.freeze({
  Always: "ALWAYS_MODEL_VISIBLE",
  WhenNonDefault: "VISIBLE_WHEN_NONDEFAULT",
  WhenInterpretationCritical: "VISIBLE_WHEN_INTERPRETATION_CRITICAL",
  DebugOnly: "DEBUG_ONLY",
  InternalOnly: "INTERNAL_ONLY",
});
export type Disclosure = (typeof Disclosure)[keyof typeof Disclosure];

export interface DisclosureRule {
  /** Normalized JSON path, `[]` for array elements. Anchored regex source. */
  readonly pattern: string;
  readonly disclosure: Disclosure;
  /** Why. §10: every category needs a reason. */
  readonly reason: string;
  /** Where the fact survives, when it is not in the default packet. */
  readonly retainedAt: string;
}

const rule = (pattern: string, disclosure: Disclosure, reason: string, retainedAt: string): DisclosureRule =>
  Object.freeze({ pattern, disclosure, reason, retainedAt });

/**
 * Ordered; first match wins.
 *
 * The shape of the answer is worth stating up front, because it is the M171
 * finding in one table: almost nothing is ALWAYS, a handful is
 * INTERPRETATION_CRITICAL, and the great majority is DEBUG_ONLY — not because it
 * is worthless, but because the agent does not need it before its first
 * repository decision.
 */
export const DISCLOSURE_MATRIX: readonly DisclosureRule[] = Object.freeze([
  // ---- always ------------------------------------------------------------
  rule("^productContext\\.leadPivot$", Disclosure.Always,
    "the primary target identity IS the orientation; 7 of 12 live runs went straight to it and 5 of 12 went elsewhere precisely when it was wrong",
    "orientation.focus.at"),
  rule("^productContext\\.items\\[\\]\\.(path|symbol|fqName)$", Disclosure.Always,
    "a location the agent can open; the packet is a list of places, and this is the place",
    "orientation.focus / orientation.related[].at"),
  rule("^productContext\\.items\\[\\]\\.lineSpan\\.", Disclosure.Always,
    "a location without a span forces a whole-file read, which is the cost M170 tried and failed to mediate away",
    "orientation.focus.lines / related[].lines"),
  rule("^productContext\\.modelVisibleContext$", Disclosure.Always,
    "the only place a serialized response carries source text at all; the focus excerpt is cut from it",
    "orientation.focus.code"),
  rule("^productContext\\.items\\[\\]\\.selectionReasons\\[\\]$", Disclosure.Always,
    "the authoritative reason a location was chosen, reused verbatim as the relationship claim; re-wording it is how a claim gets strengthened",
    "orientation.focus.why / related[].how"),
  rule("^productContext\\.(resultState|resolved|retrievalFound|deliveryFailed)$", Disclosure.Always,
    "whether there is an answer at all; collapsing this into a compact success shape is what §11 forbids",
    "orientation.state"),
  rule("^schemaVersion$", Disclosure.Always,
    "contract identity; a consumer that cannot name the contract cannot parse it safely",
    "orientation.schemaVersion"),

  // ---- when non-default --------------------------------------------------
  rule("^(productContext\\.freshness|diagnostics\\.indexFreshness)\\.(status|reason|action)$", Disclosure.WhenNonDefault,
    "a FRESH index adds nothing to a decision; a stale or unknown one changes how every other claim in the packet should be read",
    "orientation.notes when not fresh; full record at detail=debug"),
  rule("^diagnostics\\.freshness\\.readiness\\.", Disclosure.WhenNonDefault,
    "readiness is the gate, not the content: when it fails the packet becomes a problem report, when it passes it is silent",
    "orientation.problem.readiness when not ready"),
  rule("^workspaceRouting\\.(isWorkspace|outcome|reason|routeSource|leadRepository)$", Disclosure.WhenNonDefault,
    "which repository answered matters only when more than one could have",
    "orientation.notes when a workspace routed"),
  rule("^pivotNeighborhood\\[\\]\\.excerpts\\[\\]\\.(fqName|filePath|symbol|startLine|endLine)$", Disclosure.WhenNonDefault,
    "graph neighbours are named when the rung has room for them, in authoritative order",
    "orientation.related[]"),
  rule("^pivotNeighborhood\\[\\]\\.excerpts\\[\\]\\.reason$", Disclosure.WhenNonDefault,
    "the typed relationship, rendered through a frozen exhaustive phrase table that fails closed on an unknown token",
    "orientation.related[].how"),

  // ---- interpretation critical -------------------------------------------
  rule("^productContext\\.items\\[\\]\\.contentMode$", Disclosure.WhenInterpretationCritical,
    "a skeleton shown without its label reads as the implementation; this is the qualifier that protects the code field",
    "orientation.focus.form"),
  rule("^capsuleResult\\.warnings\\[\\]$", Disclosure.WhenInterpretationCritical,
    "pivot_source_bounded_to_signatures says the body was never delivered; carried structurally by focus.form rather than as prose",
    "orientation.focus.form; full list at detail=debug"),
  rule("^productContext\\.coverage\\.", Disclosure.WhenInterpretationCritical,
    "selective_task_retrieval / not_observed / enumerationComplete=false is exactly what the single global boundary line says, once, unconditionally",
    "orientation.boundary"),
  rule("^productContext\\.accounting\\.claimBoundary$", Disclosure.WhenInterpretationCritical,
    "bounds a compression claim the orientation packet does not make; without the claim the boundary has nothing to protect",
    "detail=debug, alongside the accounting it bounds"),
  rule("^productContext\\.diagnostics\\.limitations\\[\\]$", Disclosure.WhenInterpretationCritical,
    "three of the four bound fields the packet no longer carries (impact, token estimates, return types); the fourth is an internal timing note",
    "detail=debug, alongside the fields they bound"),
  rule("^pivotNeighborhood\\[\\]\\.skipped", Disclosure.WhenInterpretationCritical,
    "source_unavailable is a bounded absence; omitting the neighbour AND the skip keeps the packet silent rather than negative",
    "detail=debug"),

  // ---- debug only ---------------------------------------------------------
  rule("^productContext\\.items\\[\\]\\.(roles|metadata|estimatedTokens|contentCharacters|selectionReasonsOmitted|id|stableId|contentHash)", Disclosure.DebugOnly,
    "per-item bookkeeping and role vocabulary; the role is already implicit in whether the item is the focus or a related entry",
    "detail=debug"),
  rule("^productContext\\.(task|intent|taskHash|selectedFileHash|responseVersion|capsuleMode)$", Disclosure.DebugOnly,
    "restatement of the request the agent just made, or an identifier for it; the task string alone is asserted on 7 surfaces",
    "detail=debug"),
  rule("^productContext\\.(repository|timing|accounting|delivery|roleCounts|diagnostics)\\.", Disclosure.DebugOnly,
    "workspace identity, timings, budget arithmetic, counters; none of it changes where the agent looks first",
    "detail=debug"),
  rule("^productContext\\.diagnostics$", Disclosure.DebugOnly, "container", "detail=debug"),
  rule("^capsuleResult\\.", Disclosure.DebugOnly,
    "a second rendering of the same selection: digest, pivots, support, budget, retrieval counters, discarded candidates",
    "detail=debug"),
  rule("^context\\.", Disclosure.DebugOnly,
    "the compatibility alias the response itself marks supersededBy=productContext",
    "detail=debug"),
  rule("^(impact|flow)\\.", Disclosure.DebugOnly,
    "on the development corpus impact is skipped by intent and flow resolves no endpoints; when either produces evidence it reaches the packet as a related entry, and when it does not, omission is not a negative claim",
    "detail=debug, and get_impact_graph on demand"),
  rule("^memory\\.", Disclosure.DebugOnly,
    "durable memory on this corpus is VTRACE's own prior tool calls (\"Built context capsule for query with 2 pivots\"); M164 measured zero voluntary reuse",
    "detail=debug, and search_memory on demand"),
  rule("^rules\\.", Disclosure.DebugOnly,
    "no active rule fired on any development case; the notes explain a mechanism rather than the repository",
    "detail=debug"),
  rule("^deferred\\.", Disclosure.DebugOnly,
    "expansion ids and suggested inputs for tools the agent can call by name anyway; the ids restate the task a further time",
    "detail=debug, expansion still served by expand_vexp_ref"),
  rule("^(request|taskSummary)\\.", Disclosure.DebugOnly,
    "the request echoed back, twice",
    "detail=debug"),
  rule("^intent\\.(impactSkipReason|flowSkipReason|impactEligible|flowEligible)$", Disclosure.DebugOnly,
    "why a component did not run. The packet never claims to enumerate impact or flow, so their absence asserts nothing and needs no excuse (§35)",
    "detail=debug"),
  rule("^intent\\.", Disclosure.DebugOnly,
    "the routing classifier's own decision, restated across 18 keys of which 5 hold the same value; it explains VTRACE's behaviour, not the repository",
    "detail=debug"),
  rule("^accounting\\.", Disclosure.DebugOnly,
    "a savings claim about the response, priced against a naive full-file baseline; the orientation packet makes no savings claim for it to bound",
    "detail=debug"),
  rule("^(runtime|capsule)\\.", Disclosure.DebugOnly,
    "build and implementation provenance; an audit input, not an orientation input",
    "detail=debug"),
  rule("^responseBudget\\.", Disclosure.DebugOnly,
    "the envelope's account of its own size, priced in a chars/4 estimate M166 showed understates by 1.27x",
    "detail=debug"),
  rule("^diagnostics\\.", Disclosure.DebugOnly,
    "machine-facing freshness prose and the omittedForDetail pointer",
    "detail=debug"),
  rule("^inspectFirst\\.", Disclosure.DebugOnly,
    "a second opinion about where to look, derived from the same selection the focus comes from",
    "detail=debug"),
  rule("^(authoritativeCapsuleManifestId|savedObservation)$", Disclosure.DebugOnly,
    "manifest identity and the observation-write receipt",
    "detail=debug"),
  rule("^workspaceRouting\\.", Disclosure.DebugOnly,
    "routing evidence, candidate repositories and coverage counters beyond the outcome itself",
    "detail=debug"),
  rule("^productContext\\.", Disclosure.DebugOnly, "remaining productContext bookkeeping", "detail=debug"),
  rule("^pivotNeighborhood\\[\\]\\.", Disclosure.DebugOnly, "remaining neighborhood bookkeeping", "detail=debug"),
]);

/**
 * Paths a real response carries that NO rule covers.
 *
 * This is the enforcement half of §10. It is deliberately a function over a real
 * response rather than a static list, because a static list of fields is exactly
 * the artefact that goes stale without anyone noticing.
 */
export function unclassifiedPaths(output: Record<string, unknown>): readonly string[] {
  const compiled = DISCLOSURE_MATRIX.map((entry) => ({ regex: new RegExp(entry.pattern), entry }));
  const unmatched = new Set<string>();

  const walk = (value: unknown, path: string): void => {
    if (path !== "" && compiled.some((candidate) => candidate.regex.test(path))) return;
    if (Array.isArray(value)) {
      for (const element of value) walk(element, `${path}[]`);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) walk(child, path === "" ? key : `${path}.${key}`);
      return;
    }
    if (path !== "") unmatched.add(path);
  };

  walk(output, "");
  return Object.freeze([...unmatched].sort());
}

export function classify(path: string): DisclosureRule | null {
  for (const entry of DISCLOSURE_MATRIX) {
    if (new RegExp(entry.pattern).test(path)) return entry;
  }
  return null;
}
