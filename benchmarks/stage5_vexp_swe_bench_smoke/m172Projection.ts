/**
 * M172 — the orientation projector with its bounds separated.
 *
 * M171 bundled three parameters into a "rung" and selected R2000 on development
 * file-delivery. M172-A took the bundle apart on the same twelve captures and
 * found two things that change the design:
 *
 *   THE CEILING WAS NEVER A BOUND.  `Rung.ceilingTokens` is declared, set on all
 *   four rungs, and read by nothing. `projectOrientation` consults only
 *   `focusCodeCharacters` and `relatedCap`. M171's "the ceiling never binds" was
 *   true for a stronger reason than it recorded: the ceiling was not wired. Had
 *   it been, it still would not have bound — the smallest rung, R1000, leaves a
 *   minimum of 459 tokens of headroom on every development case.
 *
 *   THE COUNT CAP BUYS NOTHING.  Delivering the FULL authoritative related
 *   supply costs at most 987 model-visible tokens on development, against a
 *   2,000-token product target. The cap withholds authoritative evidence on a
 *   third of cases while the constraint it stands proxy for has more than a
 *   thousand tokens spare.
 *
 * So M172 keeps exactly one bound and makes it real. Related entries are
 * admitted in authoritative order until the ceiling would be exceeded. There is
 * no count cap unless a policy asks for one.
 *
 * "ENOUGH, THEN STOP" IS UNCHANGED, AND THIS IS THE SUBTLE PART. The projector
 * still has no notion of remaining space and never seeks to fill it. What stops
 * a packet is the authoritative supply running out, not a budget being reached —
 * on development the supply runs out at a median of 5 entries and never exceeds
 * 7. Removing the cap does not let the projector add anything; it stops the
 * projector censoring what the pipeline already chose. M166's refill was the
 * packer reaching for MORE evidence when space appeared. Nothing here reaches.
 *
 * WHAT THE CEILING MAY NOT EVICT. The focus and the interpretation-critical
 * notes are never subject to it (§48): a claim that cannot be rendered truthfully
 * is omitted rather than weakened, and a packet whose qualifier was evicted for
 * budget is exactly the overstrong rendering §48 forbids. The ceiling governs the
 * related list alone.
 *
 * OFFLINE. Benchmark candidate, not product code. Nothing in `src/` imports it.
 * PURE. No I/O, no product imports, no clock, no randomness.
 */

import { modelVisibleTokens } from "./m171Contract";
import {
  NEIGHBOR_RELATION_PHRASES,
  ORIENTATION_BOUNDARY,
  ORIENTATION_SCHEMA_VERSION,
  OrientationState,
  headBound,
  readAuthoritative,
  type OrientationFocus,
  type OrientationPacket,
  type OrientationRelated,
} from "./m171Projection";

/**
 * The neighbour phrase that asserts a NON-relationship. A symbol reached by no
 * edge at all, in a file the packet already names as the focus. Kept as a named
 * constant because a policy that excludes it must exclude exactly it.
 */
export const NO_RELATION_PHRASE = NEIGHBOR_RELATION_PHRASES.fallback_symbol_window!;

export interface OrientationPolicy {
  readonly name: string;
  /**
   * The model-visible token bound on the whole packet. REAL, unlike M171's.
   * Governs the related list only; never evicts focus or notes.
   */
  readonly ceilingTokens: number;
  readonly focusCodeCharacters: number;
  /** A count cap on related entries, or null for "the ceiling is the only bound". */
  readonly relatedCap: number | null;
  /** Drop neighbours whose only claim is that they are near the focus. */
  readonly excludeUnrelatedNeighbors: boolean;
}

/**
 * Reproduces M171's R2000 exactly: same focus bound, same count cap, no
 * exclusion, and a ceiling that cannot bind because it never bound there either.
 * Exists as the §51 identity control — a comparative analyzer must classify an
 * unchanged input correctly before its verdicts on changed ones count.
 */
export const P_M171_R2000: OrientationPolicy = Object.freeze({
  name: "P_M171_R2000",
  ceilingTokens: 2000,
  focusCodeCharacters: 1800,
  relatedCap: 5,
  excludeUnrelatedNeighbors: false,
});

/** One bound, made real. The authoritative supply decides; the ceiling backstops. */
export const P_SUPPLY: OrientationPolicy = Object.freeze({
  name: "P_SUPPLY",
  ceilingTokens: 2000,
  focusCodeCharacters: 1800,
  relatedCap: null,
  excludeUnrelatedNeighbors: false,
});

/** P_SUPPLY, minus the entries that assert no relationship at all. */
export const P_RELATION: OrientationPolicy = Object.freeze({
  name: "P_RELATION",
  ceilingTokens: 2000,
  focusCodeCharacters: 1800,
  relatedCap: null,
  excludeUnrelatedNeighbors: true,
});

export const POLICIES: readonly OrientationPolicy[] = Object.freeze([P_M171_R2000, P_SUPPLY, P_RELATION]);

/** Assemble a resolved packet from its parts, so cost can be measured on the real object. */
function assemble(
  focus: OrientationFocus,
  related: readonly OrientationRelated[],
  notes: readonly string[],
): OrientationPacket {
  return Object.freeze({
    schemaVersion: ORIENTATION_SCHEMA_VERSION,
    state: OrientationState.Resolved,
    focus,
    related: Object.freeze([...related]),
    boundary: ORIENTATION_BOUNDARY,
    ...(notes.length === 0 ? {} : { notes: Object.freeze([...notes]) }),
  });
}

export const packetTokens = (packet: OrientationPacket): number =>
  modelVisibleTokens(JSON.stringify(packet).length);

/**
 * Project one authoritative response under one policy.
 *
 * Selection order is the AUTHORITATIVE order — `productContext.items` as the
 * pipeline delivered them, then pivot-neighborhood excerpts — and admission takes
 * a PREFIX of it. Taking a prefix is what makes policies nested (§45): anything
 * a tighter policy names, a looser one names too. The projector never re-ranks,
 * never scores, and never computes a relationship (§37, §38).
 */
export function projectOrientationM172(
  output: Record<string, unknown>,
  policy: OrientationPolicy,
): OrientationPacket {
  const view = readAuthoritative(output);

  if (view.state !== OrientationState.Resolved) {
    // §11/§79 — a compact success output does not license a vague failure output.
    return Object.freeze({
      schemaVersion: ORIENTATION_SCHEMA_VERSION,
      state: view.state,
      focus: null,
      related: Object.freeze([]),
      boundary: ORIENTATION_BOUNDARY,
      ...(view.notes.length === 0 ? {} : { notes: Object.freeze([...view.notes]) }),
      problem: Object.freeze({
        reason: view.problemReason,
        recommendedAction: view.recommendedAction,
        readiness: view.readiness === null ? null : Object.freeze({ ...view.readiness }),
      }),
    });
  }

  const focusItem = view.items.find((item) => item.fqName === view.leadPivot)
    ?? view.items.find((item) => item.roles.includes("pivot"))
    ?? view.items[0]!;

  const bounded = headBound(focusItem.body, policy.focusCodeCharacters);
  const focus: OrientationFocus = Object.freeze({
    at: focusItem.fqName,
    file: focusItem.path,
    lines: focusItem.lines,
    form: focusItem.contentMode === "" ? null : focusItem.contentMode,
    why: focusItem.reasons[0] ?? null,
    code: bounded.text === "" ? null : bounded.text,
    codeTruncated: bounded.truncated,
  });

  const notes = [...view.notes];
  if (focus.codeTruncated) notes.push("The excerpt above is the head of a longer span.");

  // The full admissible list in authoritative order, before any bound applies.
  const seen = new Set<string>([focusItem.fqName]);
  const candidates: OrientationRelated[] = [];
  const consider = (fqName: string, path: string, lines: string | null, how: string): void => {
    if (seen.has(fqName) || how === "") return;
    if (policy.excludeUnrelatedNeighbors && how === NO_RELATION_PHRASE) return;
    seen.add(fqName);
    candidates.push(Object.freeze({ at: fqName, file: path, lines, how }));
  };
  for (const item of view.items) {
    // The item's own first selection reason IS the relationship claim the
    // authoritative state makes about it. Reused verbatim; never generalized.
    consider(item.fqName, item.path, item.lines, item.reasons[0] ?? item.roles.join(", "));
  }
  for (const neighbor of view.neighbors) {
    // Fails closed: an unmapped internal token carries no claim, so the neighbour
    // is dropped rather than shipped as an opaque or over-strong label.
    consider(neighbor.fqName, neighbor.path, neighbor.lines, NEIGHBOR_RELATION_PHRASES[neighbor.reason] ?? "");
  }

  // Admit the prefix that fits. The count cap applies only if the policy sets
  // one; the ceiling always does, and is checked against the assembled packet
  // rather than an estimate of one.
  const related: OrientationRelated[] = [];
  for (const candidate of candidates) {
    if (policy.relatedCap !== null && related.length >= policy.relatedCap) break;
    const next = [...related, candidate];
    if (packetTokens(assemble(focus, next, notes)) > policy.ceilingTokens) break;
    related.push(candidate);
  }

  return assemble(focus, related, notes);
}
