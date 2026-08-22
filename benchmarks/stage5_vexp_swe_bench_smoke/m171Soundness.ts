/**
 * M171-D — is every claim in the packet supported by the authoritative state?
 *
 * §49 makes this the decisive test, above field identity: derive the claims a
 * reasonable consumer can make from the packet, and check each against the state
 * it was projected from.
 *
 * Seven checks, each with a named violation kind so a failure says WHAT went
 * wrong rather than that something did:
 *
 *   UNSUPPORTED_LOCATION      a location the authoritative state does not contain
 *   UNSUPPORTED_FILE          a file path the authoritative state does not contain
 *   UNSUPPORTED_SPAN          a line span that disagrees with the authoritative one
 *   UNSUPPORTED_RELATION      a relationship claim traceable to neither a verbatim
 *                             authoritative string nor a frozen phrase earned by
 *                             the location's own authoritative reason
 *   AUTHORED_PROSE            a sentence nobody declared
 *   NEGATIVE_OR_EXHAUSTIVE_CLAIM
 *                             wording that turns selection into enumeration, or
 *                             omission into absence
 *   FABRICATED_SOURCE         focus code that is not a prefix of the authoritative
 *                             rendering for that item
 *
 * The last two are the ones that matter most and are the easiest to fail
 * silently, which is why they are checked against a vocabulary rather than by
 * reading the output.
 *
 * PURE.
 */

import {
  FROZEN_PHRASES,
  NEIGHBOR_RELATION_PHRASES,
  ORIENTATION_BOUNDARY,
  OrientationState,
  parseRenderedBodies,
  readPacketClaims,
  type OrientationPacket,
} from "./m171Projection";

export const ViolationKind = Object.freeze({
  UnsupportedLocation: "UNSUPPORTED_LOCATION",
  UnsupportedFile: "UNSUPPORTED_FILE",
  UnsupportedSpan: "UNSUPPORTED_SPAN",
  UnsupportedRelation: "UNSUPPORTED_RELATION",
  AuthoredProse: "AUTHORED_PROSE",
  NegativeOrExhaustiveClaim: "NEGATIVE_OR_EXHAUSTIVE_CLAIM",
  FabricatedSource: "FABRICATED_SOURCE",
});
export type ViolationKind = (typeof ViolationKind)[keyof typeof ViolationKind];

export interface Violation {
  readonly kind: ViolationKind;
  readonly detail: string;
}

/**
 * Wording that would convert a selective packet into an enumerating one, or an
 * omission into an absence.
 *
 * The list is checked against strings the PACKET authors — never against
 * verbatim repository text or verbatim authoritative reasons, where "only" and
 * "no" are ordinary English about the code rather than claims about coverage.
 */
const ENUMERATING_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bno (callers?|dependents?|references?|matches|results|other)\b/i,
  /\b(does not|doesn't) (exist|appear|occur)\b/i,
  /\b(all|every|each) (callers?|dependents?|references?|files?|symbols?|matches)\b/i,
  /\bexhaustive\b/i,
  /\bcomplete (list|enumeration|set)\b/i,
  /\bnothing else\b/i,
  /\bonly (caller|dependent|reference|file|symbol|place)\b/i,
  /\bthere (is|are) no\b/i,
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asArray = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

/** Everything the authoritative state actually asserts, in comparable form. */
interface Support {
  readonly locations: ReadonlyMap<string, { readonly file: string; readonly lines: string | null }>;
  readonly files: ReadonlySet<string>;
  readonly reasonsByLocation: ReadonlyMap<string, readonly string[]>;
  readonly neighborReasonByLocation: ReadonlyMap<string, string>;
  readonly bodies: ReadonlyMap<string, string>;
  readonly bodyByLocation: ReadonlyMap<string, string>;
  readonly serialized: string;
}

export function readSupport(output: Record<string, unknown>): Support {
  const productContext = isRecord(output.productContext) ? output.productContext : {};
  const locations = new Map<string, { file: string; lines: string | null }>();
  const files = new Set<string>();
  const reasonsByLocation = new Map<string, readonly string[]>();
  const neighborReasonByLocation = new Map<string, string>();
  const bodies = parseRenderedBodies(text(productContext.modelVisibleContext));
  const bodyByLocation = new Map<string, string>();

  for (const item of asArray(productContext.items)) {
    const fqName = text(item.fqName);
    if (fqName === "") continue;
    const span = isRecord(item.lineSpan) ? item.lineSpan : null;
    locations.set(fqName, { file: text(item.path), lines: span === null ? null : `${text(span.start)}-${text(span.end)}` });
    if (text(item.path) !== "") files.add(text(item.path));
    reasonsByLocation.set(fqName, Object.freeze(Array.isArray(item.selectionReasons) ? item.selectionReasons.map(text) : []));
    const body = bodies.get(text(item.id));
    if (body !== undefined) bodyByLocation.set(fqName, body);
  }
  for (const neighborhood of asArray(output.pivotNeighborhood)) {
    for (const excerpt of asArray(neighborhood.excerpts)) {
      const fqName = text(excerpt.fqName);
      if (fqName === "") continue;
      if (!locations.has(fqName)) {
        locations.set(fqName, { file: text(excerpt.filePath), lines: `${text(excerpt.startLine)}-${text(excerpt.endLine)}` });
      }
      if (text(excerpt.filePath) !== "") files.add(text(excerpt.filePath));
      neighborReasonByLocation.set(fqName, text(excerpt.reason));
    }
  }
  return {
    locations, files, reasonsByLocation, neighborReasonByLocation, bodies, bodyByLocation,
    serialized: JSON.stringify(output),
  };
}

export function auditPacket(packet: OrientationPacket, output: Record<string, unknown>): readonly Violation[] {
  const violations: Violation[] = [];
  const support = readSupport(output);
  const claims = readPacketClaims(packet);
  const add = (kind: ViolationKind, detail: string): void => { violations.push({ kind, detail }); };

  for (const location of claims.locations) {
    if (!support.locations.has(location)) add(ViolationKind.UnsupportedLocation, location);
  }
  for (const file of claims.files) {
    if (!support.files.has(file)) add(ViolationKind.UnsupportedFile, file);
  }
  for (const span of claims.codeSpans) {
    const authoritative = support.locations.get(span.at);
    if (authoritative === undefined) continue;
    if (span.lines !== null && authoritative.lines !== null && span.lines !== authoritative.lines) {
      add(ViolationKind.UnsupportedSpan, `${span.at}: packet ${span.lines} vs state ${authoritative.lines}`);
    }
  }

  for (const relation of claims.relationClaims) {
    const frozenEntry = Object.entries(NEIGHBOR_RELATION_PHRASES).find(([, phrase]) => phrase === relation.how);
    if (frozenEntry !== undefined) {
      // A frozen phrase is only earned by the enum value it renders.
      if (support.neighborReasonByLocation.get(relation.at) !== frozenEntry[0]) {
        add(ViolationKind.UnsupportedRelation, `${relation.at}: claims "${frozenEntry[0]}" but state says "${support.neighborReasonByLocation.get(relation.at) ?? "nothing"}"`);
      }
      continue;
    }
    const reasons = support.reasonsByLocation.get(relation.at) ?? [];
    if (!reasons.includes(relation.how)) {
      add(ViolationKind.UnsupportedRelation, `${relation.at}: "${relation.how.slice(0, 60)}" is neither a frozen phrase nor one of this location's authoritative reasons`);
    }
  }

  for (const authored of claims.authoredStrings) {
    if (!FROZEN_PHRASES.includes(authored) && !support.serialized.includes(authored)) {
      add(ViolationKind.AuthoredProse, authored.slice(0, 80));
    }
  }

  // Only strings the packet AUTHORS are checked for enumerating wording. Verbatim
  // repository text and verbatim authoritative reasons are excluded on purpose:
  // "no other callers" inside a docstring is a fact about the code, and rewriting
  // it would be the falsification, not the fix.
  //
  // The boundary line is excluded too, and for the opposite reason: it is a
  // DISCLAIMER of exhaustiveness ("not an exhaustive repository listing"), so a
  // scanner looking for the word would fire on the one sentence whose job is to
  // deny the claim. It is checked instead by the exact-match assertion below and
  // by a dedicated test that asserts its disclaiming shape.
  for (const authored of packet.notes ?? []) {
    for (const pattern of ENUMERATING_PATTERNS) {
      if (pattern.test(authored)) add(ViolationKind.NegativeOrExhaustiveClaim, `${pattern.source} matched "${authored.slice(0, 60)}"`);
    }
  }
  for (const phrase of Object.values(NEIGHBOR_RELATION_PHRASES)) {
    if (!claims.relationClaims.some((relation) => relation.how === phrase)) continue;
    for (const pattern of ENUMERATING_PATTERNS) {
      if (pattern.test(phrase)) add(ViolationKind.NegativeOrExhaustiveClaim, `${pattern.source} matched relation phrase "${phrase}"`);
    }
  }

  if (packet.focus?.code != null) {
    const authoritativeBody = support.bodyByLocation.get(packet.focus.at);
    if (authoritativeBody === undefined || !authoritativeBody.startsWith(packet.focus.code)) {
      add(ViolationKind.FabricatedSource, `${packet.focus.at}: focus code is not a prefix of the authoritative rendering`);
    }
  }

  if (packet.state === OrientationState.Resolved && packet.boundary !== ORIENTATION_BOUNDARY) {
    add(ViolationKind.AuthoredProse, "the global boundary is missing or altered on a resolved packet");
  }

  return Object.freeze(violations);
}
