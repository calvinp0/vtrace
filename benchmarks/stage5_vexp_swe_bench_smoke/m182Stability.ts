/**
 * M182 semantic packet identities.
 *
 * Equality here is deliberately narrower than JSON equality. Timing, accounting,
 * transport ids and temporary paths are not repository evidence. Focus identity,
 * ordered related evidence, primary reasons, roles, qualifiers and decline state
 * are. The explicit records below prevent a timing-width change from being called
 * a semantic packet change while still detecting order and membership changes.
 */

import { createHash } from "node:crypto";

import { compactProductResponse, McpResponseDetail } from "../../src/mcp/responseEnvelope";
import { projectRunPipelineOrientation } from "../../src/runPipeline/orientationProjection";

type JsonRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const records = (value: unknown): JsonRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const text = (value: unknown): string => typeof value === "string" ? value : "";

export function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export interface SemanticPacketIdentity {
  readonly state: "orientation" | "decline" | "other";
  readonly focus: null | {
    readonly at: string;
    readonly file: string;
    readonly lines: string | null;
    readonly form: string | null;
    readonly why: string | null;
    readonly code: string | null;
    readonly codeTruncated: boolean;
  };
  readonly related: readonly {
    readonly at: string;
    readonly file: string;
    readonly lines: string | null;
    readonly how: string;
  }[];
  readonly notes: readonly string[];
  readonly decline: null | { readonly resultState: string; readonly reason: string; readonly boundary: string };
}

/** Accept either an already-projected packet or a full authoritative response. */
export function semanticPacketIdentity(value: unknown): SemanticPacketIdentity {
  const record = isRecord(value) ? value : {};
  if ((record.state === "orientation" || record.state === "decline" || record.state === "other") && Array.isArray(record.related)) {
    return structuredClone(record) as unknown as SemanticPacketIdentity;
  }
  const projected = text(record.schemaVersion).startsWith("run_pipeline.orientation/")
    ? record
    : projectRunPipelineOrientation(record);
  if (projected !== null) {
    const packet = projected as unknown as JsonRecord;
    const focus = isRecord(packet.focus) ? packet.focus : {};
    return {
      state: "orientation",
      focus: {
        at: text(focus.at), file: text(focus.file),
        lines: typeof focus.lines === "string" ? focus.lines : null,
        form: typeof focus.form === "string" ? focus.form : null,
        why: typeof focus.why === "string" ? focus.why : null,
        code: typeof focus.code === "string" ? focus.code : null,
        codeTruncated: focus.codeTruncated === true,
      },
      related: records(packet.related).map((entry) => ({
        at: text(entry.at), file: text(entry.file),
        lines: typeof entry.lines === "string" ? entry.lines : null,
        how: text(entry.how),
      })),
      notes: Array.isArray(packet.notes) ? packet.notes.map(text) : [],
      decline: null,
    };
  }

  const product = isRecord(record.productContext) ? record.productContext : {};
  if (text(record.schemaVersion).startsWith("run_pipeline.orientation.none/") || product.resultState !== undefined) {
    return {
      state: "decline", focus: null, related: [], notes: [],
      decline: {
        resultState: text(record.resultState) || text(product.resultState),
        reason: text(record.reason) || text(product.reason),
        boundary: text(record.boundary),
      },
    };
  }
  return { state: "other", focus: null, related: [], notes: [], decline: null };
}

export const semanticPacketHash = (value: unknown): string => hashOf(semanticPacketIdentity(value));

export function frozenDelivery(authoritative: unknown, budget = 8_000): {
  readonly response: unknown;
  readonly semantic: SemanticPacketIdentity;
  readonly semanticPacketHash: string;
  readonly byteHash: string;
  readonly normalizedByteHash: string;
} {
  const draft = structuredClone(authoritative) as JsonRecord;
  delete draft.responseBudget;
  const response = compactProductResponse(draft, {
    requestedContextTokens: budget,
    detail: McpResponseDetail.Standard,
  });
  const semantic = semanticPacketIdentity(response);
  return {
    response,
    semantic,
    semanticPacketHash: hashOf(semantic),
    byteHash: hashOf(response),
    normalizedByteHash: hashOf(stripNonSemanticTelemetry(response)),
  };
}

/** The upstream supply, its order, scores, and the assembly-layer semantic items. */
export function authoritativeHashes(value: unknown): {
  readonly authoritativeSupplyHash: string;
  readonly candidateOrderHash: string;
  readonly rankVectorHash: string;
  readonly semanticItemSupplyHash: string;
} {
  const root = isRecord(value) ? value : {};
  const capsule = isRecord(root.capsuleResult) ? root.capsuleResult : {};
  const orderedCandidates = [
    ...records(capsule.pivots).map((item) => candidateIdentity("pivot", item)),
    ...records(capsule.support).map((item) => candidateIdentity("support", item)),
    ...records(capsule.discarded).map((item) => candidateIdentity("discarded", item)),
  ];
  const supply = [...orderedCandidates].sort((a, b) => a.identity.localeCompare(b.identity));
  const rankVector = orderedCandidates.map((entry) => ({
    identity: entry.identity,
    role: entry.role,
    scorecard: entry.scorecard,
  }));
  const product = isRecord(root.productContext) ? root.productContext : {};
  const items = records(product.items).map((item) => ({
    stableId: text(item.stableId), fqName: text(item.fqName), path: text(item.path),
    symbol: text(item.symbol), roles: Array.isArray(item.roles) ? item.roles.map(text) : [],
    reasons: Array.isArray(item.selectionReasons) ? item.selectionReasons.map(text) : [],
    contentMode: text(item.contentMode),
  }));
  return {
    authoritativeSupplyHash: hashOf(supply),
    candidateOrderHash: hashOf(orderedCandidates),
    rankVectorHash: hashOf(rankVector),
    semanticItemSupplyHash: hashOf(items),
  };
}

function candidateIdentity(role: string, item: JsonRecord): {
  role: string; identity: string; scorecard: unknown;
} {
  return {
    role,
    identity: text(item.fqName) || text(item.fq_name) || `${text(item.path)}::${text(item.symbol)}` || text(item.id),
    scorecard: isRecord(item.scorecard) ? item.scorecard : null,
  };
}

const NON_SEMANTIC_KEYS = /^(?:timing|accounting|responseBudget|timingsMs|timing_ms|elapsedMs|latencyMs|durationMs|totalMs|createdAt|createdAtMs|requestId|processId)$/u;

/** Normalize diagnostics only; array order is intentionally retained. */
export function stripNonSemanticTelemetry(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNonSemanticTelemetry);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !NON_SEMANTIC_KEYS.test(key))
    .map(([key, child]) => [key, stripNonSemanticTelemetry(child)]));
}

export function semanticDifference(a: unknown, b: unknown): string[] {
  const left = semanticPacketIdentity(a);
  const right = semanticPacketIdentity(b);
  const differences: string[] = [];
  if (left.state !== right.state) differences.push("state");
  if (left.focus?.at !== right.focus?.at) differences.push("focus");
  const leftOrdered = left.related.map((item) => `${item.at}|${item.how}`);
  const rightOrdered = right.related.map((item) => `${item.at}|${item.how}`);
  if (JSON.stringify(leftOrdered) !== JSON.stringify(rightOrdered)) differences.push("related_order_or_membership");
  if (JSON.stringify([...leftOrdered].sort()) !== JSON.stringify([...rightOrdered].sort())) differences.push("related_membership");
  if (left.focus?.why !== right.focus?.why || JSON.stringify(left.related.map((x) => x.how)) !== JSON.stringify(right.related.map((x) => x.how))) differences.push("primary_reason");
  if (JSON.stringify(left.notes) !== JSON.stringify(right.notes)) differences.push("qualifiers");
  return differences;
}
