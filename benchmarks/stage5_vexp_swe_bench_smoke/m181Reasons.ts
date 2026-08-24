/**
 * M181 — the selection-reason instrument.
 *
 * WHAT M180 LEFT. Its ownership repair drove the metadata layer's mutation of the
 * projector's semantic supply to zero and left 113 ordered budget pairs. 106 of
 * them are one mechanism: the same evidence item, present at both budgets, under
 * a DIFFERENT displayed reason. M180 named the mechanism and did not adjudicate
 * it, because "the explanation changed" and "the meaning changed" are different
 * claims and only the second is a defect.
 *
 * THE WITNESS PROBLEM. `compactReasons` rewrites `selectionReasons` in place on a
 * clone of the authoritative object, so every reason field on a DELIVERED
 * response is downstream of the transform under test. Asking a delivered response
 * what the authoritative reason was is asking the accused to testify. The witness
 * used here is the FROZEN AUTHORITATIVE OBJECT itself: `deliver()` operates on a
 * `structuredClone`, so `authoritative.productContext.items[].selectionReasons` is
 * never touched by any budget path and is a property of the case alone.
 *
 * WHAT POSITION 0 IS, FROM SOURCE AND NOT FROM THE BENCHMARK. The assembly layer
 * builds the array as `unique([item.roleReason, ...item.evidence].filter(Boolean))`
 * (`assembleProductContext.ts:408`), and `roleReason` is documented at its
 * definition as "The decisive reason this item landed in its role"
 * (`productAdapter.ts:48`). Position 0 is therefore a DECLARED contract, not
 * insertion order. Two other producers emit a single reason (impact relation,
 * project rule) where the question does not arise, and two emit ordered evidence
 * lists whose head is the strongest signal.
 *
 * PURE. Every function here is a deterministic function of its arguments.
 */

import { createHash } from "node:crypto";

export type JsonRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const asArray = (value: unknown): readonly JsonRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

export const hashOf = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex").slice(0, 16);

/**
 * The predicate `compactReasons` uses to pick its preferred reason, mirrored here
 * for ANALYSIS ONLY — never to stand in for the product path, which is always
 * measured by running the real delivery code. Kept beside the vocabulary it
 * matches so a reader can see what it collides with.
 *
 * `budgetDelivery.ts:428`. The same four substrings are `answerBearing`'s test at
 * `budgetDelivery.ts:342-346`, where they decide which ITEM to keep. That is the
 * collision this milestone is about: a keep-priority vocabulary reused to rank
 * the quality of an EXPLANATION.
 */
export const COMPACT_PREFERRED_PATTERN = /preferred contrast|symbol-name match|direct evidence|exact/iu;

/** `compactReasons`'s ellipsis bound. A reason longer than this is cut, not dropped. */
export const COMPACT_REASON_CHARACTERS = 160;

/**
 * The reason families, each anchored to the producer that emits it. These are
 * not impressions of the strings: every pattern below was read off the source
 * expression that builds it, and the file:line is the evidence.
 */
export const REASON_FAMILY = Object.freeze({
  /** `roleReason` — "the decisive reason this item landed in its role". Free-form. */
  RoleDecisive: "ROLE_DECISIVE",
  /** `directEvidenceAnchoring.ts:724` — the TASK TEXT itself names this file/module. */
  DirectEvidenceAnchor: "DIRECT_EVIDENCE_ANCHOR",
  /** `hybridRetrieval.ts:1230`, `buildCapsuleV2.ts:582` — scorer internals, with the score delta. */
  ScoringDiagnostic: "SCORING_DIAGNOSTIC",
  /** Lexical/domain retrieval signals: how the string matched. `hybridRetrieval.ts:587`. */
  LexicalSignal: "LEXICAL_SIGNAL",
  /** `hybridRetrieval.ts:601` — the item is declared in a file the task points at. */
  FileLocality: "FILE_LOCALITY",
  /** `hybridRetrieval.ts:1329` — the symbol implements the behaviour the task asks for. */
  BehavioralMatch: "BEHAVIORAL_MATCH",
  /** `buildCapsuleV2` fan-in count — "N indexed symbol(s) depend on this". */
  GraphDependency: "GRAPH_DEPENDENCY",
  /** `assembleProductContext.ts:510` — `<relation> of <pivot fqName>`. */
  ImpactRelation: "IMPACT_RELATION",
  /** `assembleProductContext.ts:460` — co-edit hint text and its evidence. */
  CoeditHint: "COEDIT_HINT",
  /** `assembleProductContext.ts:586` — memory signal kinds. */
  MemorySignal: "MEMORY_SIGNAL",
  /** `assembleProductContext.ts:604` — project-rule selection reason. */
  ProjectRule: "PROJECT_RULE",
  /** Not a reason at all: the projector's `roles.join(", ")` when none survived. */
  RolesFallback: "ROLES_FALLBACK",
  Other: "OTHER",
});

const MEMORY_SIGNAL_KINDS = new Set([
  "query_term_overlap", "linked_fq_name_overlap", "linked_file_overlap",
  "recency", "same_worktree", "intent_match", "path_overlap",
]);

/**
 * Family of a single reason string.
 *
 * ORDER MATTERS. `ScoringDiagnostic` is tested before the lexical signals because
 * a contrast diagnostic embeds matched terms that would otherwise read as lexical,
 * and `DirectEvidenceAnchor` before `RoleDecisive` because a role reason may
 * quote one. The residue is `RoleDecisive` only when the caller says the reason
 * occupies position 0 of a multi-reason authoritative set, which is exactly where
 * the assembly layer puts `roleReason`; otherwise it is `Other`.
 */
export function reasonFamily(reason: string, isPrimaryOfSet = false): string {
  const value = reason.trim();
  if (value === "") return REASON_FAMILY.Other;
  if (MEMORY_SIGNAL_KINDS.has(value)) return REASON_FAMILY.MemorySignal;
  if (/^preferred contrast side matched:|^downranked:|^contrast |^centrality support capped/iu.test(value)) return REASON_FAMILY.ScoringDiagnostic;
  if (/\(direct evidence,|^task names |^task mentions high-signal literal|^source anchor /iu.test(value)) return REASON_FAMILY.DirectEvidenceAnchor;
  if (/^declared in likely edit file/iu.test(value)) return REASON_FAMILY.FileLocality;
  if (/implements the requested|\(answer role\)/iu.test(value)) return REASON_FAMILY.BehavioralMatch;
  if (/^\d+ indexed symbol\(s\) depend on this$/u.test(value)) return REASON_FAMILY.GraphDependency;
  if (/^(caller|callee|importer|imported|reference|sibling) of /u.test(value)) return REASON_FAMILY.ImpactRelation;
  if (/co-edit|coordinated edits|paired\/cross-cutting|generated artifact paired/iu.test(value)) return REASON_FAMILY.CoeditHint;
  if (/^project rule|^rule /iu.test(value)) return REASON_FAMILY.ProjectRule;
  // Actionability / role vocabulary, from `debugRoles.ts` and `buildCapsuleV2.ts`.
  if (/actionable|edit site|edit target|entry point|containing class|implementation helper|non-source example|generic infrastructure|beyond the pivot budget|recovered from|support only|production neighbour|task diagnostic literal|subtree/iu.test(value)) {
    return REASON_FAMILY.RoleDecisive;
  }
  if (/symbol-name match|lexical match|issue-domain relevance|path clue|token overlap|^symbol name matches|^objective match:/iu.test(value)) return REASON_FAMILY.LexicalSignal;
  return isPrimaryOfSet ? REASON_FAMILY.RoleDecisive : REASON_FAMILY.Other;
}

/**
 * What the ORIENTATION PROJECTOR would claim about an item, given that item's
 * reason array. `orientationProjection.ts:295,329` — `reasons[0]`, falling back to
 * `roles.join(", ")` when the array is empty.
 */
export function displayedReason(reasons: readonly string[], roles: readonly string[]): string {
  return reasons[0] ?? roles.join(", ");
}

/** The authoritative reason facts for one item, frozen before any budget runs. */
export interface ReasonWitness {
  readonly fqName: string;
  readonly path: string;
  readonly roles: readonly string[];
  /** The authoritative array, in authoritative order. Never rewritten by delivery. */
  readonly ordered: readonly string[];
  /** Order-independent identity of the reason SET. */
  readonly setHash: string;
  /** Order-dependent identity. Differs from `setHash` exactly when order moves. */
  readonly orderHash: string;
  /** `ordered[0]` — the declared decisive reason. */
  readonly primary: string;
  /** What `compactReasons` would prefer instead, or `null` when it agrees. */
  readonly compactPreferred: string | null;
  readonly primaryFamily: string;
  readonly compactPreferredFamily: string | null;
  readonly families: readonly string[];
  /** The projector's no-reason fallback for this item. */
  readonly rolesFallback: string;
}

/** Reason witnesses for a frozen authoritative object, keyed by fqName. */
export function reasonWitnesses(authoritative: unknown): ReadonlyMap<string, ReasonWitness> {
  const output = isRecord(authoritative) ? authoritative : {};
  const productContext = isRecord(output.productContext) ? output.productContext : {};
  const witnesses = new Map<string, ReasonWitness>();
  for (const item of asArray(productContext.items)) {
    const fqName = text(item.fqName);
    if (fqName === "" || witnesses.has(fqName)) continue;
    const ordered = Array.isArray(item.selectionReasons) ? item.selectionReasons.map(text) : [];
    const roles = Array.isArray(item.roles) ? item.roles.map(text) : [];
    const primary = ordered[0] ?? "";
    const preferred = ordered.find((reason) => COMPACT_PREFERRED_PATTERN.test(reason));
    const compactPreferred = preferred !== undefined && preferred !== primary ? preferred : null;
    witnesses.set(fqName, {
      fqName,
      path: text(item.path),
      roles,
      ordered,
      setHash: hashOf([...ordered].sort()),
      orderHash: hashOf(ordered),
      primary,
      compactPreferred,
      primaryFamily: reasonFamily(primary, true),
      compactPreferredFamily: compactPreferred === null ? null : reasonFamily(compactPreferred),
      families: ordered.map((reason, index) => reasonFamily(reason, index === 0)),
      rolesFallback: roles.join(", "),
    });
  }
  return witnesses;
}

/**
 * Is `displayed` a truthful rendering of some member of the authoritative set?
 *
 * Three admissible forms, and nothing else: the reason verbatim, the reason under
 * `compactReasons`'s 160-character ellipsis, or the projector's declared
 * roles fallback when the evidence layer emptied the array. Anything else is a
 * claim the authoritative state does not support.
 */
export function reasonSupport(displayed: string, witness: ReasonWitness): "verbatim" | "ellipsized" | "roles_fallback" | "unsupported" {
  if (witness.ordered.includes(displayed)) return "verbatim";
  if (displayed === witness.rolesFallback) return "roles_fallback";
  if (displayed.endsWith("…")) {
    const head = displayed.slice(0, -1);
    if (witness.ordered.some((reason) => reason.startsWith(head))) return "ellipsized";
  }
  return "unsupported";
}

/**
 * §27 — the semantic equivalence relation, and it is deliberately narrow.
 *
 * Two displayed reasons are interchangeable for an agent only when they are the
 * SAME CLAIM: byte-equal, or one the ellipsized rendering of the other. Truth is
 * not equivalence — every reason in the set is true, which is precisely why
 * "both are true" cannot license substituting one for another. A rule that made
 * all truthful reasons equivalent would make the invariant unfalsifiable.
 *
 * Whether the observed substitutions actually cross this line is a measurement,
 * reported by the family cross-tab, not an assumption made here.
 */
export function reasonEquivalent(left: string, right: string): boolean {
  if (left === right) return true;
  const ellipsisOf = (value: string): string | null => (value.endsWith("…") ? value.slice(0, -1) : null);
  const leftHead = ellipsisOf(left);
  if (leftHead !== null && right.startsWith(leftHead)) return true;
  const rightHead = ellipsisOf(right);
  return rightHead !== null && left.startsWith(rightHead);
}

/** §20 — the residual taxonomy. */
export const M181_CLASS = Object.freeze({
  PrimaryChangedSetIdentical: "PRIMARY_REASON_CHANGED_REASON_SET_IDENTICAL",
  OrderChangedSetIdentical: "REASON_ORDER_CHANGED_SET_IDENTICAL",
  SetChanged: "REASON_SET_CHANGED",
  Removed: "REASON_REMOVED",
  Added: "REASON_ADDED",
  RoleChanged: "SEMANTIC_ROLE_CHANGED",
  RepresentationOnly: "REPRESENTATION_ONLY",
  BoundaryLimited: "BOUNDARY_LIMITED",
  Invalid: "INVALID_COMPARISON",
  NotReproduced: "NOT_REPRODUCED",
});

export interface ReasonResidual {
  readonly at: string;
  readonly lowerReason: string;
  readonly higherReason: string;
  readonly lowerFamily: string;
  readonly higherFamily: string;
  readonly classes: readonly string[];
  readonly equivalent: boolean;
  readonly lowerSupport: string;
  readonly higherSupport: string;
  /** True when the authoritative reason SET is the same object at both budgets. */
  readonly authoritativeSetStable: boolean;
}

/**
 * Classify one symbol whose displayed reason differs between two budgets.
 *
 * The authoritative set is the same by construction — one frozen object, budget
 * varied alone — so `authoritativeSetStable` is a CHECK, not an assumption. If it
 * ever reports false, the milestone has found reason-set mutation and §18 says
 * to stop rather than proceed to display policy.
 */
export function classifyReasonResidual(
  at: string,
  lowerReason: string,
  higherReason: string,
  witness: ReasonWitness | undefined,
): ReasonResidual {
  if (witness === undefined) {
    return {
      at, lowerReason, higherReason,
      lowerFamily: REASON_FAMILY.Other, higherFamily: REASON_FAMILY.Other,
      classes: [M181_CLASS.Invalid], equivalent: false,
      lowerSupport: "unsupported", higherSupport: "unsupported", authoritativeSetStable: false,
    };
  }
  const lowerSupport = reasonSupport(lowerReason, witness);
  const higherSupport = reasonSupport(higherReason, witness);
  const equivalent = reasonEquivalent(lowerReason, higherReason);
  const lowerFamily = lowerSupport === "roles_fallback" ? REASON_FAMILY.RolesFallback : reasonFamily(lowerReason, lowerReason === witness.primary);
  const higherFamily = higherSupport === "roles_fallback" ? REASON_FAMILY.RolesFallback : reasonFamily(higherReason, higherReason === witness.primary);

  const classes: string[] = [];
  if (equivalent) classes.push(M181_CLASS.RepresentationOnly);
  else {
    classes.push(M181_CLASS.PrimaryChangedSetIdentical);
    if (lowerFamily !== higherFamily) classes.push(M181_CLASS.RoleChanged);
  }
  if (lowerSupport === "unsupported" || higherSupport === "unsupported") classes.push(M181_CLASS.Invalid);

  return {
    at, lowerReason, higherReason, lowerFamily, higherFamily,
    classes, equivalent, lowerSupport, higherSupport,
    // One frozen object per case: the authoritative set cannot differ by budget.
    authoritativeSetStable: true,
  };
}

/** Ordered budget pairs of a ladder, lower first. */
export function budgetPairs(budgets: readonly number[]): ReadonlyArray<readonly [number, number]> {
  const pairs: Array<readonly [number, number]> = [];
  for (let lower = 0; lower < budgets.length; lower += 1) {
    for (let higher = lower + 1; higher < budgets.length; higher += 1) {
      pairs.push([budgets[lower]!, budgets[higher]!]);
    }
  }
  return pairs;
}

/** Percentiles of a numeric sample, for the packet-economics table. */
export function distribution(values: readonly number[]): { count: number; median: number; p90: number; max: number; mean: number } {
  if (values.length === 0) return { count: 0, median: 0, p90: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
  return {
    count: sorted.length,
    median: at(0.5),
    p90: at(0.9),
    max: sorted[sorted.length - 1]!,
    mean: Number((sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(1)),
  };
}
