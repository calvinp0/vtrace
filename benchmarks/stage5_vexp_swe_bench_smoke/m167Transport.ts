/**
 * M167 primitives — how many times one semantic result is represented, and where.
 *
 * Two questions live here and they are not the same question:
 *
 *   ACROSS representations   `content[0].text` versus `structuredContent`, the two
 *                            channels the MCP result carries. This is the seam M166
 *                            noticed but did not price.
 *   WITHIN a representation  the same repository fact restated by the prose
 *                            rendering, the structured item list, the capsule digest
 *                            and the legacy context section INSIDE whichever channel
 *                            the client actually delivers.
 *
 * Only the second can cost model tokens if the client reads one channel and drops the
 * other, so the two are measured separately and never summed.
 *
 * Pure: nothing here reads the filesystem, spawns a process or mutates its input.
 */

/** §60 — an unreadable payload is unobservable, never absent. */
export const Observability = Object.freeze({
  Observed: "OBSERVED",
  ParseFailure: "PARSE_FAILURE",
  Missing: "NOT_PRESENT",
});
export type Observability = (typeof Observability)[keyof typeof Observability];

/** §14 — how `content[0].text` stands to `structuredContent`. */
export const RepresentationRelation = Object.freeze({
  ByteEquivalent: "BYTE_EQUIVALENT_SERIALIZATION",
  SemanticallyEquivalentRender: "SEMANTICALLY_EQUIVALENT_RENDER",
  PartialSummary: "PARTIAL_SUMMARY",
  Superset: "SUPERSET",
  Subset: "SUBSET",
  DifferentInformation: "DIFFERENT_INFORMATION",
  Unobservable: "UNOBSERVABLE",
});
export type RepresentationRelation = (typeof RepresentationRelation)[keyof typeof RepresentationRelation];

/** The rendering surfaces a repository fact can appear on inside one payload. */
export const Surface = Object.freeze({
  Rendering: "productContext.modelVisibleContext",
  Items: "productContext.items",
  Digest: "capsuleResult.digest",
  Neighborhood: "pivotNeighborhood",
  LegacyContext: "context",
  InspectFirst: "inspectFirst",
  Capsule: "capsule",
  Impact: "impact",
  Diagnostics: "diagnostics",
});
export type Surface = (typeof Surface)[keyof typeof Surface];

const SURFACE_PATHS: readonly (readonly [Surface, readonly string[]])[] = Object.freeze([
  [Surface.Rendering, ["productContext", "modelVisibleContext"]],
  [Surface.Items, ["productContext", "items"]],
  [Surface.Digest, ["capsuleResult", "digest"]],
  [Surface.Neighborhood, ["pivotNeighborhood"]],
  [Surface.LegacyContext, ["context"]],
  [Surface.InspectFirst, ["inspectFirst"]],
  [Surface.Capsule, ["capsule"]],
  [Surface.Impact, ["impact"]],
  [Surface.Diagnostics, ["diagnostics"]],
]);

function asRecord(value: unknown): Record<string, any> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, any> : null;
}

function at(root: unknown, path: readonly string[]): unknown {
  let cursor: any = root;
  for (const key of path) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/**
 * Compare the two channels a `tools/call` result carries.
 *
 * `content[0].text` is compared against `structuredContent.result.output` rather than
 * against the whole envelope, because that is what the server actually serializes into
 * it. Equal payloads under a differing wrapper are a SUBSET relation, not equality: the
 * wrapper is information the text channel does not carry.
 */
export function classifyRepresentations(
  contentText: string | null,
  structuredContent: unknown,
): { readonly relation: RepresentationRelation; readonly observability: Observability; readonly detail: string } {
  if (contentText === null) {
    return { relation: RepresentationRelation.Unobservable, observability: Observability.Missing, detail: "no text content block was emitted" };
  }
  if (structuredContent === null || structuredContent === undefined) {
    return { relation: RepresentationRelation.Unobservable, observability: Observability.Missing, detail: "no structuredContent was emitted" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contentText);
  } catch (error) {
    return {
      relation: RepresentationRelation.Unobservable,
      observability: Observability.ParseFailure,
      detail: `content[0].text did not parse as JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const envelope = asRecord(structuredContent);
  const output = at(envelope, ["result", "output"]);
  const wrapperKeys = envelope === null ? [] : Object.keys(envelope).filter((k) => k !== "result");

  const textJson = JSON.stringify(parsed);
  const outputJson = JSON.stringify(output ?? null);

  if (textJson === outputJson) {
    return wrapperKeys.length === 0
      ? { relation: RepresentationRelation.ByteEquivalent, observability: Observability.Observed, detail: "the two channels serialize to identical JSON" }
      : {
        relation: RepresentationRelation.Subset,
        observability: Observability.Observed,
        detail: `the text channel carries the tool output verbatim; structuredContent adds the envelope wrapper (${wrapperKeys.join(", ")}) around the same value`,
      };
  }

  const textKeys = new Set(Object.keys(asRecord(parsed) ?? {}));
  const outputKeys = new Set(Object.keys(asRecord(output) ?? {}));
  const missingFromText = [...outputKeys].filter((k) => !textKeys.has(k));
  const extraInText = [...textKeys].filter((k) => !outputKeys.has(k));

  if (missingFromText.length > 0 && extraInText.length === 0) {
    return {
      relation: textKeys.size * 4 < outputKeys.size ? RepresentationRelation.PartialSummary : RepresentationRelation.Subset,
      observability: Observability.Observed,
      detail: `text omits ${missingFromText.length} top-level members (${missingFromText.slice(0, 5).join(", ")})`,
    };
  }
  if (extraInText.length > 0 && missingFromText.length === 0) {
    return { relation: RepresentationRelation.Superset, observability: Observability.Observed, detail: `text adds ${extraInText.join(", ")}` };
  }
  if (missingFromText.length === 0 && extraInText.length === 0) {
    return {
      relation: RepresentationRelation.SemanticallyEquivalentRender,
      observability: Observability.Observed,
      detail: "same top-level members, differing values",
    };
  }
  return {
    relation: RepresentationRelation.DifferentInformation,
    observability: Observability.Observed,
    detail: `text omits ${missingFromText.join(", ")} and adds ${extraInText.join(", ")}`,
  };
}

/**
 * Serialize one surface of a payload so a fact can be searched for in it.
 * A surface that is absent yields the empty string; the caller must not read that as
 * a fact being absent from the payload, only from that surface.
 */
export function surfaceText(output: unknown, surface: Surface): string {
  const entry = SURFACE_PATHS.find(([name]) => name === surface);
  if (entry === undefined) return "";
  const value = at(output, entry[1]);
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export interface FactOccurrence {
  /** The identity-bearing value looked for. Short enum labels are never facts here. */
  readonly fact: string;
  readonly kind: "path" | "symbol" | "excerpt";
  readonly surfaces: readonly Surface[];
}

/**
 * The M166 rule carried forward: only identity-bearing values may be treated as the
 * same fact in two places. A role label, a status word or a mode name repeats
 * legitimately and is per-item semantics, so anything this short is not a fact.
 */
const MIN_FACT_CHARACTERS = 12;

/**
 * Locate every repository fact on every surface of one payload.
 *
 * Facts come from the structured item list because that is the one surface with
 * addressable identity; the question asked of the others is only whether they restate
 * it. A fact found on N surfaces was rendered N times in a single response.
 */
export function locateFacts(output: unknown): readonly FactOccurrence[] {
  const pc = asRecord(asRecord(output)?.productContext) ?? {};
  const items = Array.isArray(pc.items) ? pc.items as Record<string, any>[] : [];
  const neighborhood = Array.isArray(asRecord(output)?.pivotNeighborhood) ? (output as any).pivotNeighborhood as Record<string, any>[] : [];

  const candidates = new Map<string, FactOccurrence["kind"]>();
  for (const item of items) {
    if (typeof item.path === "string" && item.path.length >= MIN_FACT_CHARACTERS) candidates.set(item.path, "path");
    const symbol = typeof item.fqName === "string" ? item.fqName : typeof item.symbol === "string" ? item.symbol : null;
    if (symbol !== null && symbol.length >= MIN_FACT_CHARACTERS) candidates.set(symbol, "symbol");
  }
  for (const entry of neighborhood) {
    for (const excerpt of Array.isArray(entry.excerpts) ? entry.excerpts as Record<string, any>[] : []) {
      const key = `${excerpt.filePath}:${excerpt.startLine}-${excerpt.endLine}`;
      if (typeof excerpt.filePath === "string" && key.length >= MIN_FACT_CHARACTERS) candidates.set(key, "excerpt");
    }
  }

  const rendered = new Map<Surface, string>();
  for (const [surface] of SURFACE_PATHS) rendered.set(surface, surfaceText(output, surface));

  const occurrences: FactOccurrence[] = [];
  for (const [fact, kind] of candidates) {
    const needle = kind === "excerpt" ? fact.split(":")[0]! : fact;
    const surfaces = [...rendered.entries()].filter(([, text]) => text.includes(needle)).map(([surface]) => surface);
    occurrences.push({ fact, kind, surfaces });
  }
  return occurrences.sort((a, b) => a.fact.localeCompare(b.fact));
}

export interface SurfaceDuplication {
  readonly factCount: number;
  /** Facts rendered on more than one surface of the same payload. */
  readonly multiSurfaceFactCount: number;
  readonly bySurface: Readonly<Record<string, number>>;
  readonly surfaceCharacters: Readonly<Record<string, number>>;
  readonly pairs: readonly { readonly a: Surface; readonly b: Surface; readonly sharedFacts: number }[];
}

export function summarizeSurfaces(output: unknown): SurfaceDuplication {
  const facts = locateFacts(output);
  const bySurface: Record<string, number> = {};
  const surfaceCharacters: Record<string, number> = {};
  for (const [surface] of SURFACE_PATHS) {
    bySurface[surface] = 0;
    surfaceCharacters[surface] = surfaceText(output, surface).length;
  }
  for (const fact of facts) for (const surface of fact.surfaces) bySurface[surface] = (bySurface[surface] ?? 0) + 1;

  const pairs: { a: Surface; b: Surface; sharedFacts: number }[] = [];
  for (let i = 0; i < SURFACE_PATHS.length; i += 1) {
    for (let j = i + 1; j < SURFACE_PATHS.length; j += 1) {
      const a = SURFACE_PATHS[i]![0];
      const b = SURFACE_PATHS[j]![0];
      const shared = facts.filter((f) => f.surfaces.includes(a) && f.surfaces.includes(b)).length;
      if (shared > 0) pairs.push({ a, b, sharedFacts: shared });
    }
  }
  return {
    factCount: facts.length,
    multiSurfaceFactCount: facts.filter((f) => f.surfaces.length > 1).length,
    bySurface,
    surfaceCharacters,
    pairs: pairs.sort((x, y) => y.sharedFacts - x.sharedFacts),
  };
}

/** §15 — semantic categories and which channel carries each. */
export const CategoryChannel = Object.freeze({
  Both: "BOTH",
  StructuredOnly: "STRUCTURED_ONLY",
  TextOnly: "TEXT_ONLY",
  Neither: "NEITHER",
});
export type CategoryChannel = (typeof CategoryChannel)[keyof typeof CategoryChannel];

const CATEGORY_PROBES: readonly (readonly [string, readonly string[]])[] = Object.freeze([
  ["primary evidence", ["productContext", "modelVisibleContext"]],
  ["support evidence", ["productContext", "items"]],
  ["impact", ["impact"]],
  ["structural context", ["pivotNeighborhood"]],
  ["memory", ["memory"]],
  ["readiness", ["productContext", "freshness"]],
  ["absence/control state", ["deferred"]],
  ["provenance", ["runtime"]],
  ["diagnostics", ["diagnostics"]],
  ["component status", ["flow"]],
  ["token accounting", ["responseBudget"]],
]);

export function categoryChannels(
  contentText: string | null,
  structuredContent: unknown,
): readonly { readonly category: string; readonly channel: CategoryChannel }[] {
  let text: unknown = undefined;
  if (contentText !== null) {
    try { text = JSON.parse(contentText); } catch { text = undefined; }
  }
  const output = at(asRecord(structuredContent), ["result", "output"]);
  return CATEGORY_PROBES.map(([category, path]) => {
    const inText = at(text, path) !== undefined && at(text, path) !== null;
    const inStructured = at(output, path) !== undefined && at(output, path) !== null;
    const channel = inText && inStructured
      ? CategoryChannel.Both
      : inStructured
        ? CategoryChannel.StructuredOnly
        : inText
          ? CategoryChannel.TextOnly
          : CategoryChannel.Neither;
    return { category, channel };
  });
}
