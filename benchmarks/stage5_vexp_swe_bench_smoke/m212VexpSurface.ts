/**
 * M212 — pure helpers for the current-VEXP impact-delivery audit.
 *
 * Two jobs, both deterministic and both offline:
 *
 *   1. Read a shipped `vexp-cli` MCP bundle and report the tool surface it
 *      actually publishes — which tools an agent is shown by default, which
 *      exist only behind the all-tools env gate, and which node fields the
 *      impact renderer is capable of emitting. This is SHIPPED-ARTIFACT
 *      evidence: it is what the vendor's own JavaScript does, not what its
 *      documentation says about it, which is the distinction control F1 exists
 *      to enforce.
 *
 *   2. Score the frozen-A15 IDEA against a bounded-projection response, and
 *      separate the two recall questions M212 exists to tell apart: how many
 *      known callers a DEFAULT response carries inline, versus how many are
 *      reachable through default plus deterministic continuation.
 *
 * Nothing here restates the frozen A15 predicate. `callSiteIsRendered` from
 * `m197aScoring` is the one authority for whether a call site is rendered, and
 * the shadow evaluator calls it rather than re-implementing it, so a shadow
 * result can never silently disagree with the frozen scorer about the same
 * relation. M212 does not modify that predicate; it asks a different population
 * question with it.
 */
import { callSiteIsRendered } from "./m197aScoring";

// ------------------------------------------------------- shipped-bundle surface

export interface VexpToolSurface {
  readonly version: string | null;
  /** Tools listed to the model with no environment override — the default catalog. */
  readonly defaultListed: readonly string[];
  /** Every tool the bundle lists, reachable only under the all-tools env gate. */
  readonly allListed: readonly string[];
  /** Defined and callable, but absent from the default catalog. */
  readonly gatedOutOfDefault: readonly string[];
  /** The env var that widens the catalog, as named by the bundle itself. */
  readonly allToolsEnvVar: string | null;
  /** Node fields the impact renderer can emit. A field absent here cannot reach the model. */
  readonly impactNodeFields: readonly string[] | null;
  /** Tools whose own descriptions mention the V-REF compact-reference marker. */
  readonly vrefMentioningTools: readonly string[];
}

/** `<minifiedId>={name:"<tool>",description:` — the bundle's tool definitions, whatever it named them. */
function toolIdentifierMap(bundle: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of bundle.matchAll(/([\w$]+)\s*=\s*\{\s*name\s*:\s*"([a-z_][a-z0-9_]*)"/g)) {
    map.set(m[1]!, m[2]!);
  }
  return map;
}

/** `var X=[a,b,c]` for a known minified identifier. */
function arrayMembers(bundle: string, identifier: string): string[] | null {
  const m = new RegExp(`${identifier.replace(/\$/g, "\\$")}\\s*=\\s*\\[([^\\]]*)\\]`).exec(bundle);
  if (!m) return null;
  return m[1]!.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * The tool-list request handler decides what the model is shown. Both bundles
 * shape it as `tools: <gate>() ? <all> : <default>`, with the default side free
 * to carry a `.map(...)` that rewrites descriptions — itself worth recording,
 * because it means the default catalog is not merely a subset of the full one.
 */
function toolListArms(bundle: string): { gate: string; all: string; def: string } | null {
  const m = /\(\)\s*=>\s*\(\{\s*tools\s*:\s*([\w$]+)\(\)\s*\?\s*([\w$]+)\s*:\s*([\w$]+)/.exec(bundle);
  return m ? { gate: m[1]!, all: m[2]!, def: m[3]! } : null;
}

/**
 * Which node properties the impact renderer reads. The renderer is the last
 * thing between the engine and the model, so a property it never reads is a
 * property the model never sees, regardless of what the engine computed.
 *
 * The region is anchored by content rather than by name — minified names are
 * regenerated every release — running from the impact heading the renderer
 * emits to the start of the next tool's schema declaration, which is where the
 * node emitters end in both bundles. Brace matching is deliberately not used:
 * the emitters are built from template literals whose `${...}` holes nest
 * arbitrarily, and a matcher that quietly fails on them would report an empty
 * field set, which is indistinguishable from the finding this function exists
 * to make. An empty region is therefore returned as null, not as "no fields".
 */
const IMPACT_RENDER_ANCHOR = "# Impact Graph:";

function impactRendererFields(bundle: string): string[] | null {
  const start = bundle.indexOf(IMPACT_RENDER_ANCHOR);
  if (start < 0) return null;
  const next = bundle.indexOf("=S.object(", start);
  const region = bundle.slice(start, next > start ? next : start + 4000);
  const fields = new Set<string>();
  for (const f of region.matchAll(/\b[a-z]\.([a-z_][a-z0-9_]*)\b/g)) fields.add(f[1]!);
  return fields.size === 0 ? null : [...fields].sort();
}

/**
 * A tool's OWN description literal, read to its closing quote rather than to a
 * fixed character offset. A window wide enough to be safe on the real bundles,
 * whose descriptions run to hundreds of characters, spills into the next tool's
 * definition on a compact one — and a spill here would attribute the V-REF
 * marker to a tool that never mentions it, which is precisely the false positive
 * control F1 exists to prevent.
 */
function ownDescription(bundle: string, toolName: string): string | null {
  const key = `"${toolName}",description:"`;
  const at = bundle.indexOf(key);
  if (at < 0) return null;
  let i = at + key.length;
  for (; i < bundle.length; i += 1) {
    if (bundle[i] === "\\") { i += 1; continue; }
    if (bundle[i] === '"') break;
  }
  return bundle.slice(at + key.length, i);
}

export function extractVexpToolSurface(bundle: string, version: string | null): VexpToolSurface {
  const ids = toolIdentifierMap(bundle);
  const arms = toolListArms(bundle);
  const resolve = (identifier: string | undefined): string[] =>
    (identifier === undefined ? [] : (arrayMembers(bundle, identifier) ?? []))
      .map((id) => ids.get(id) ?? `unresolved:${id}`);

  const defaultListed = resolve(arms?.def).sort();
  const allListed = resolve(arms?.all).sort();
  const gateAt = arms === null ? -1 : bundle.indexOf(`function ${arms.gate}(`);
  const envVar = gateAt < 0 ? null : /process\.env\.(VEXP_[A-Z_]+)/.exec(bundle.slice(gateAt, gateAt + 400));

  const vref: string[] = [];
  for (const name of new Set(ids.values())) {
    const own = ownDescription(bundle, name);
    if (own !== null && own.includes("V-REF")) vref.push(name);
  }

  return {
    version,
    defaultListed,
    allListed,
    gatedOutOfDefault: allListed.filter((t) => !defaultListed.includes(t)),
    allToolsEnvVar: envVar?.[1] ?? null,
    impactNodeFields: impactRendererFields(bundle),
    vrefMentioningTools: vref.sort(),
  };
}

/**
 * Fields whose presence would let a renderer carry a call expression. The frozen
 * A15 predicate needs source text naming the callee; a renderer with no
 * source-bearing field cannot produce one at any budget, on any corpus, for any
 * symbol. That makes this a statement about capability, not about a sample —
 * which is why it can settle a question a single probe could not.
 */
export const SOURCE_BEARING_FIELDS =
  ["source", "source_text", "sourceText", "snippet", "code", "text", "excerpt", "line", "start_line"] as const;

export function rendererCanCarrySource(fields: readonly string[] | null): boolean {
  // A region that could not be located is unknown, not proven sourceless.
  return fields !== null && fields.some((f) => (SOURCE_BEARING_FIELDS as readonly string[]).includes(f));
}

// --------------------------------------------------------- shadow A15 scoring

/** How a known caller was represented in a default impact response. */
export type CallerRepresentation =
  | "INLINE_WITH_SOURCE"      // present, and the frozen predicate is satisfied
  | "INLINE_WITHOUT_SOURCE"   // present as a relation, but with no rendered call expression
  | "CENSUS_ONLY"             // counted by the census, not projected into this response
  | "ABSENT";                 // neither counted nor projected

export interface DeliveredRelation {
  readonly source?: { readonly symbol?: string };
  readonly evidence?: { readonly sourceText?: string; readonly referenceName?: string };
}

/**
 * Where a pre-registered caller ended up. Selection happens before the response
 * is read (control F9), and identity is the exact caller FQN rather than the
 * file it lives in (control F7), so a sibling caller in the same file cannot be
 * mistaken for a hit.
 */
export function representationOf(
  callerFqn: string,
  delivered: readonly DeliveredRelation[],
  censusCoversCaller: boolean,
): CallerRepresentation {
  const hit = delivered.find((r) => r.source?.symbol === callerFqn);
  if (hit) return callSiteIsRendered(hit.evidence ?? {}) ? "INLINE_WITH_SOURCE" : "INLINE_WITHOUT_SOURCE";
  return censusCoversCaller ? "CENSUS_ONLY" : "ABSENT";
}

export interface RecallPair {
  /** What frozen A15 evaluates: inline, with a rendered call expression. */
  readonly inlineRecall: number;
  /** Default plus deterministic continuation — a surface frozen A15 cannot see. */
  readonly reachableRecall: number;
}

export function recallOf(inlineWithSource: number, reachableWithSource: number, known: number): RecallPair {
  if (known <= 0) return { inlineRecall: Number.NaN, reachableRecall: Number.NaN };
  return {
    inlineRecall: +(100 * inlineWithSource / known).toFixed(2),
    reachableRecall: +(100 * reachableWithSource / known).toFixed(2),
  };
}

/** The section-10 classification, decided from an observed response rather than from prose. */
export type ProjectionClass =
  | "FULL_INLINE_ENUMERATION"
  | "BOUNDED_INLINE_WITH_COMPLETE_CENSUS"
  | "BOUNDED_INLINE_WITH_EXPANDABLE_REFERENCES"
  | "BOUNDED_INLINE_WITH_OTHER_EXPANSION"
  | "UNKNOWN";

export function classifyProjection(input: {
  readonly indexedCallers: number;
  readonly deliveredRelations: number;
  readonly censusTotal: number | null;
  readonly hasDeterministicContinuation: boolean;
  readonly hasExpandableReferences: boolean;
}): ProjectionClass {
  const { indexedCallers, deliveredRelations, censusTotal } = input;
  if (indexedCallers <= 0) return "UNKNOWN";
  if (deliveredRelations >= indexedCallers) return "FULL_INLINE_ENUMERATION";
  if (input.hasExpandableReferences) return "BOUNDED_INLINE_WITH_EXPANDABLE_REFERENCES";
  if (input.hasDeterministicContinuation) return "BOUNDED_INLINE_WITH_OTHER_EXPANSION";
  // A truthful count with no way to reach the rest is a census and nothing more.
  // Control F5: a correct total never implies the callers were delivered.
  if (censusTotal !== null && censusTotal >= indexedCallers) return "BOUNDED_INLINE_WITH_COMPLETE_CENSUS";
  return "UNKNOWN";
}
