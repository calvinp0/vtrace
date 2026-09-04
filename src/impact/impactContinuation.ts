import { createHash } from "node:crypto";

/**
 * Deterministic impact continuation references (M211 §23–§27).
 *
 * WHY THIS IS NOT `expand_vexp_ref`. VTRACE already has a deterministic
 * reference authority, and it already declares an `impact_graph` category — but
 * its contract is "the exact payload snapshotted at run_pipeline time so
 * expansion returns stored truth, never a recomputation". Snapshotting is the
 * right model for a capsule the caller may want back verbatim. It is the wrong
 * model here: the relation universe behind one high-fanout symbol runs to a
 * thousand hydrated records, and §48/§49 exist precisely to stop the product
 * materialising them to serve page two.
 *
 * SO THIS REF STORES NOTHING. It is a self-validating cursor over a stream that
 * is cheap to re-derive and totally ordered. That is what makes the §26 property
 * hold for free: there is no server-side state, no in-memory call history, and
 * no eviction, so a fresh process and a reused process cannot disagree, and the
 * same ref against the same index always expands to the same relations.
 *
 * WHAT IT BINDS, and why each one:
 *
 *   indexRunId       the index revision, verbatim. Any re-index bumps it, so a
 *                    ref minted against one graph can never silently paginate
 *                    another — and the failure can name both revisions.
 *   orderingVersion  the ordering authority, verbatim, so a future change to
 *                    `compareStaticRelations` invalidates outstanding refs
 *                    instead of returning a scrambled page.
 *   scope            a digest over the resolved symbol AND the request shape
 *                    (depth, direction, relation filter, include_lexical,
 *                    include_unresolved) — everything that decides WHICH
 *                    relations exist and in what order. A ref minted for
 *                    upstream calls must not expand into a downstream one: that
 *                    would be a different stream and the cursor would index into
 *                    nothing meaningful.
 *   after            how many relations of the canonical stream have already
 *                    been delivered.
 *   afterRelationId  the id of the LAST delivered relation. The cursor alone is
 *                    an offset, and an offset into a stream that shifted is the
 *                    definition of a silently wrong page — this makes the shift
 *                    detectable even when every other claim still matches.
 */
export const IMPACT_CONTINUATION_VERSION = "vtrace.impact_continuation/1" as const;

/**
 * The identity of the ordering the cursor indexes into. Bumping this string is
 * how a change to `compareStaticRelations` invalidates outstanding refs.
 */
export const IMPACT_ORDERING_AUTHORITY =
  "compareStaticRelations/direction,strength,kind,sourcePath,sourceSymbol,id" as const;

/**
 * The ordering authority's wire identity. Bumped whenever
 * `IMPACT_ORDERING_AUTHORITY` changes, so an outstanding ref minted under the
 * old order is refused rather than used to index into the new one.
 */
export const IMPACT_ORDERING_VERSION = 1 as const;

/** What a minter knows. The scope fields are bound by digest, not verbatim. */
export interface ImpactContinuationClaims {
  readonly version: typeof IMPACT_CONTINUATION_VERSION;
  readonly indexRunId: number | null;
  readonly symbolId: string;
  readonly symbolFqn: string;
  readonly depth: number;
  readonly direction: "upstream" | "downstream" | "both";
  readonly relations: readonly string[] | null;
  readonly includeLexical: boolean;
  readonly includeUnresolved: boolean;
  readonly ordering: typeof IMPACT_ORDERING_AUTHORITY;
  readonly after: number;
  readonly afterRelationId: string | null;
}

/**
 * What actually travels.
 *
 * THE SCOPE IS A DIGEST, NOT THE CLAIMS. An earlier revision of this file put
 * every claim on the wire verbatim, which read well but cost 573 characters —
 * the size of a delivered relation with its source line. In a response whose
 * whole point is that evidence should not lose to bookkeeping, a ref that
 * displaces the evidence it points away from is the wrong trade, so the request
 * shape is bound by a digest that is checked, never read.
 *
 * `indexRunId` and `orderingVersion` stay verbatim because they are the two
 * failures whose CAUSES differ — the repository was re-indexed, or the product
 * changed its ordering — and a maintainer reading the error needs to tell them
 * apart. Target and request-shape mismatches collapse into one scope failure:
 * the caller's remedy is identical either way, which is to re-issue without the
 * ref, and §51's test is whether the reader can act on what they are told.
 */
export interface ImpactContinuationCursor {
  readonly v: typeof IMPACT_CONTINUATION_VERSION;
  readonly o: number;
  readonly i: number | null;
  readonly a: number;
  readonly r: string | null;
  readonly s: string;
}

export const IMPACT_CONTINUATION_ERROR = Object.freeze({
  Malformed: "continuation_malformed",
  UnsupportedVersion: "continuation_unsupported_version",
  Tampered: "continuation_tampered",
  StaleIndex: "continuation_stale_index",
  ScopeMismatch: "continuation_scope_mismatch",
  OrderingMismatch: "continuation_ordering_mismatch",
  StreamShifted: "continuation_stream_shifted",
});

export type ImpactContinuationErrorCode =
  (typeof IMPACT_CONTINUATION_ERROR)[keyof typeof IMPACT_CONTINUATION_ERROR];

export type ImpactContinuationDecode =
  | { readonly ok: true; readonly cursor: ImpactContinuationCursor }
  | { readonly ok: false; readonly code: ImpactContinuationErrorCode; readonly message: string };

/**
 * The digest that binds a ref to the universe it was minted over. Everything
 * that CHANGES WHICH RELATIONS EXIST, or in what order, goes in here.
 */
function scopeDigest(claims: {
  readonly symbolId: string;
  readonly symbolFqn: string;
  readonly depth: number;
  readonly direction: "upstream" | "downstream" | "both";
  readonly relations: readonly string[] | null;
  readonly includeLexical: boolean;
  readonly includeUnresolved: boolean;
}): string {
  return checksum(JSON.stringify([
    IMPACT_CONTINUATION_VERSION,
    IMPACT_ORDERING_AUTHORITY,
    claims.symbolId,
    claims.symbolFqn,
    claims.depth,
    claims.direction,
    claims.relations === null ? null : [...claims.relations].sort(),
    claims.includeLexical,
    claims.includeUnresolved,
  ]));
}

/**
 * The reference a caller sends back. Two dot-separated base64url segments: the
 * canonical claim JSON, and a checksum over it.
 *
 * The checksum is INTEGRITY, not authentication. There is no secret here and
 * none is wanted: the ref describes public repository structure the caller could
 * ask for directly. What it buys is that a hand-edited cursor — the §24 tampering
 * case — fails as a malformed ref instead of being honoured as a different
 * position in the stream.
 */
export function encodeImpactContinuation(claims: ImpactContinuationClaims): string {
  return encodeCursor({
    v: IMPACT_CONTINUATION_VERSION,
    o: IMPACT_ORDERING_VERSION,
    i: claims.indexRunId,
    a: claims.after,
    r: claims.afterRelationId,
    s: scopeDigest(claims),
  });
}

function encodeCursor(cursor: ImpactContinuationCursor): string {
  const payload = canonicalJson(cursor);
  const body = Buffer.from(payload, "utf8").toString("base64url");
  return `${body}.${checksum(payload)}`;
}

export function decodeImpactContinuation(token: unknown): ImpactContinuationDecode {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
    return fail(IMPACT_CONTINUATION_ERROR.Malformed, "continuation ref must be a bounded non-empty string");
  }
  const parts = token.split(".");
  if (parts.length !== 2 || parts[0]!.length === 0 || parts[1]!.length === 0) {
    return fail(IMPACT_CONTINUATION_ERROR.Malformed, "continuation ref must be <claims>.<checksum>");
  }
  let payload: string;
  try {
    payload = Buffer.from(parts[0]!, "base64url").toString("utf8");
  } catch {
    return fail(IMPACT_CONTINUATION_ERROR.Malformed, "continuation ref claims are not base64url");
  }
  if (checksum(payload) !== parts[1]) {
    return fail(IMPACT_CONTINUATION_ERROR.Tampered, "continuation ref checksum does not match its claims");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return fail(IMPACT_CONTINUATION_ERROR.Malformed, "continuation ref claims are not JSON");
  }
  if (parsed === null || typeof parsed !== "object") {
    return fail(IMPACT_CONTINUATION_ERROR.Malformed, "continuation ref claims are not an object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.v !== IMPACT_CONTINUATION_VERSION) {
    return fail(IMPACT_CONTINUATION_ERROR.UnsupportedVersion, `continuation ref version is not ${IMPACT_CONTINUATION_VERSION}`);
  }
  if (typeof record.o !== "number"
    || typeof record.s !== "string"
    || typeof record.a !== "number"
    || !Number.isInteger(record.a)
    || record.a < 0
    || (record.i !== null && typeof record.i !== "number")
    || (record.r !== null && typeof record.r !== "string")) {
    return fail(IMPACT_CONTINUATION_ERROR.Malformed, "continuation ref cursor is not well formed");
  }
  return { ok: true, cursor: record as unknown as ImpactContinuationCursor };
}

export interface ImpactContinuationExpectation {
  readonly indexRunId: number | null;
  readonly symbolId: string;
  readonly symbolFqn: string;
  readonly depth: number;
  readonly direction: "upstream" | "downstream" | "both";
  readonly relations: readonly string[] | null;
  readonly includeLexical: boolean;
  readonly includeUnresolved: boolean;
}

/**
 * §25: a ref whose authority no longer holds must fail closed. Every branch here
 * is a refusal to paginate a different graph as though it were the same result.
 */
export function validateImpactContinuation(
  cursor: ImpactContinuationCursor,
  expected: ImpactContinuationExpectation,
): { readonly ok: true } | { readonly ok: false; readonly code: ImpactContinuationErrorCode; readonly message: string } {
  if (cursor.o !== IMPACT_ORDERING_VERSION) {
    return fail(IMPACT_CONTINUATION_ERROR.OrderingMismatch, "continuation ref was minted under a different relation ordering");
  }
  if (cursor.i !== expected.indexRunId) {
    return fail(
      IMPACT_CONTINUATION_ERROR.StaleIndex,
      `continuation ref was minted against index run ${String(cursor.i)}; this repository is now at ${String(expected.indexRunId)}`,
    );
  }
  if (cursor.s !== scopeDigest({
    symbolId: expected.symbolId,
    symbolFqn: expected.symbolFqn,
    depth: expected.depth,
    direction: expected.direction,
    relations: expected.relations,
    includeLexical: expected.includeLexical,
    includeUnresolved: expected.includeUnresolved,
  })) {
    return fail(
      IMPACT_CONTINUATION_ERROR.ScopeMismatch,
      "continuation ref was minted for a different symbol or request shape (depth, direction, relation filter, include_lexical or include_unresolved)",
    );
  }
  return { ok: true };
}

/**
 * §27/§10: the cursor names an ordinal AND the relation that occupied it. A
 * universe that shrank below the cursor, or shifted under it, is caught here
 * rather than silently skipping or repeating relations.
 */
export function locateContinuationCursor(
  cursor: ImpactContinuationCursor,
  streamIds: readonly string[],
): { readonly ok: true; readonly offset: number } | { readonly ok: false; readonly code: ImpactContinuationErrorCode; readonly message: string } {
  if (cursor.a > streamIds.length) {
    return fail(
      IMPACT_CONTINUATION_ERROR.StreamShifted,
      `continuation ref resumes at ${cursor.a} but the relation stream now holds ${streamIds.length}`,
    );
  }
  if (cursor.a > 0 && cursor.r !== null && streamIds[cursor.a - 1] !== cursor.r) {
    return fail(
      IMPACT_CONTINUATION_ERROR.StreamShifted,
      "continuation ref resumes after a relation that no longer occupies that position",
    );
  }
  return { ok: true, offset: cursor.a };
}

/**
 * Re-mint a handle against what was ACTUALLY delivered (§22).
 *
 * The core mints a handle for the page it sliced; the response envelope's ladder
 * then decides how much of that page survives its budget, and it always keeps a
 * PREFIX of the page — every rung trims from the tail. So the cursor stays a
 * valid contiguous offset and only its position moves. Doing this here rather
 * than in the core is what keeps `delivered + remaining == total` true of the
 * response the caller holds instead of true of an intermediate one.
 *
 * Returns null when nothing remains: §17 forbids handing back a continuation
 * that would expand to nothing.
 */
export function finalizeImpactContinuation(
  ref: string,
  offset: number,
  total: number,
  deliveredRelationIds: readonly string[],
): { readonly after: number; readonly remaining: number; readonly ref: string } | null {
  const decoded = decodeImpactContinuation(ref);
  if (decoded.ok === false) return null;
  const after = offset + deliveredRelationIds.length;
  const remaining = Math.max(0, total - after);
  if (remaining === 0) return null;
  // The scope digest is carried straight through: this moves the cursor along a
  // stream it has already bound, and re-deriving the digest here would be a
  // chance to bind a different one.
  return {
    after,
    remaining,
    ref: encodeCursor({
      ...decoded.cursor,
      a: after,
      r: deliveredRelationIds.at(-1) ?? null,
    }),
  };
}

/** Key-ordered JSON so an identical cursor always encodes to an identical ref. */
function canonicalJson(cursor: ImpactContinuationCursor): string {
  const record = cursor as unknown as Record<string, unknown>;
  return JSON.stringify(
    Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]])),
  );
}

function checksum(payload: string): string {
  return createHash("sha256").update(payload).digest("base64url").slice(0, 16);
}

function fail(code: ImpactContinuationErrorCode, message: string): { ok: false; code: ImpactContinuationErrorCode; message: string } {
  return { ok: false, code, message };
}
