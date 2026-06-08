// Bounded test / import graph-neighbour expansion.
//
// WHY THIS EXISTS
// ----------------
// After title-symbol and high-signal-literal anchoring, the residual cross-repo
// misses share one shape: the bug report does NOT lexically name the production
// edit target, but vtrace already found something NEXT TO it — a failing test, a
// warning/config helper, a parser adapter, a sibling module, a doc/config entry
// point. If that high-confidence candidate imports / calls / references (or is
// referenced by) a production file, that neighbour may be the real edit site.
//
// This is a general candidate GENERATOR (not a ranking change) modelled on
// `titleSymbolAnchoring` / `literalAnchoring`. It seeds ONLY from high-confidence
// pool candidates, walks the existing code graph ONE hop via `expandGraphCandidates`
// (imports/calls/references/contains, both directions), keeps only production
// neighbours, and emits them as SUPPORT-strength candidates carrying explicit
// "near high-confidence seed via <edge>" evidence.
//
// Deliberately conservative and bounded:
//   - depth 1 only; no same-module flooding;
//   - small per-seed and total caps;
//   - seeds exclude generic lexical decoys, non-source/doc-data, low-actionability
//     symbols, and undirect-evidence hubs;
//   - neighbours exclude tests, non-source/doc-data (unless the task allows it),
//     vendored/generated files, generic-infra giants (`utils.py`, `base.py`, …),
//     and high-degree hubs;
//   - candidates carry NO direct evidence, so the role gate keeps them SUPPORT —
//     they can improve top-3 recall but never displace a real pivot.
//
// Repo-agnostic and deterministic: no instance ids, no per-repo file lists.

import type { Database } from "bun:sqlite";

import {
  computeInDegreeCentrality,
  expandGraphCandidates,
  ExpansionRelation,
  type ExpandedCandidate,
} from "../retrieval/graphExpansion";
import { SymbolKind, type SymbolRecord } from "../domain/types";
import {
  HybridCandidateSource,
  type HybridCandidate,
} from "../retrieval/hybridRetrieval";
import { HUB_IN_DEGREE_THRESHOLD, STRONG_DIRECT_LEXICAL, tokenize } from "../retrieval/hybridScoring";
import { isLikelyTestCandidate } from "../retrieval/searchSymbolsShared";
import { classifyNonSourceExample, taskMentionsNonSource } from "./nonSourceExample";
import { GENERIC_INFRA_TOKENS } from "./genericLexicalDecoy";

// Synthesized final score for a graph-neighbour candidate. Deliberately LOW: a
// neighbour is the weakest evidence in the system (reached only by an edge from a
// seed, never named). It carries no direct evidence, so the role gate keeps it
// SUPPORT, and buildCapsuleV2 additionally orders graph neighbours LAST among
// support — so a recovered neighbour fills a leftover slot but never displaces a
// real support file (additive-only; no eviction → no regression risk).
export const GRAPH_NEIGHBOR_FINAL = 0.3;

// Graph-proximity score the candidate carries — its honest signal (reached by a
// graph edge from a seed). Non-zero so the role gate sees `anyProximity` and keeps
// it as support rather than discarding it; well below a real direct-evidence score.
export const GRAPH_NEIGHBOR_PROXIMITY = 0.5;

const ACTIONABLE_KINDS: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Class,
]);

// Bounds — kept tight so a hub seed cannot detonate the pool.
const MAX_SEEDS = 12;
const MAX_NEIGHBORS_PER_SEED = 4;
const MAX_TOTAL_NEIGHBORS = 8;
// Pre-filter cap handed to the BFS (before our production/non-source/hub filters).
const EXPAND_PREFILTER_CAP = 40;

// Path markers for vendored / third-party / generated trees — never edit targets.
const VENDOR_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "vendor", "vendored", "_vendor", "extern", "external", "third_party", "thirdparty",
  "node_modules", "site-packages",
]);

export interface GraphNeighborMatch {
  readonly seedPath: string;
  readonly seedSymbol: string;
  /** The edge relation that linked the seed to this neighbour. */
  readonly edge: string;
  readonly neighborPath: string;
  readonly neighborSymbol: string;
  readonly symbolId: string;
  readonly reason: string;
}

export interface GraphNeighborResult {
  readonly used: boolean;
  /** Every production neighbour the bounded expansion identified (reported). */
  readonly matches: GraphNeighborMatch[];
  /** Only the neighbours MISSING from the pool — these are injected as candidates. */
  readonly candidates: HybridCandidate[];
}

const EMPTY: GraphNeighborResult = { used: false, matches: [], candidates: [] };

export interface GraphNeighborInput {
  readonly db: Database;
  readonly task: string;
  /** The current candidate pool (post anchoring + decoy suppression). */
  readonly candidates: readonly HybridCandidate[];
  /** Symbol ids of resolved line/file anchors (high-confidence seeds). */
  readonly anchorSymbolIds: ReadonlySet<string>;
  /** Symbol ids of title-symbol matches. */
  readonly titleSymbolIds: ReadonlySet<string>;
  /** Symbol ids of high-signal literal-anchor matches. */
  readonly literalAnchorIds: ReadonlySet<string>;
  /** Symbol ids that were down-weighted as generic lexical decoys — never seeds. */
  readonly suppressedDecoyIds: ReadonlySet<string>;
}

// Expand one hop from the high-confidence seeds in the pool and return production
// neighbours not already present, as support-strength candidates. Pure w.r.t. the
// index.
export function anchorGraphNeighbors(input: GraphNeighborInput): GraphNeighborResult {
  const taskAllowsNonSource = taskMentionsNonSource(input.task);
  const poolById = new Map(input.candidates.map((c) => [c.symbolId, c] as const));

  // Seed map: only high-confidence, non-decoy, source, actionable, non-hub candidates.
  // A symbol that is itself seed-eligible stands on its own evidence and is never
  // reported as a mere neighbour (it is not a recovery).
  const seedById = new Map<string, HybridCandidate>();
  const seedEligibleIds = new Set<string>();
  for (const candidate of input.candidates) {
    if (isSeedEligible(candidate, input, taskAllowsNonSource)) {
      seedEligibleIds.add(candidate.symbolId);
      if (seedById.size < MAX_SEEDS) seedById.set(candidate.symbolId, candidate);
    }
  }
  if (seedById.size === 0) return EMPTY;

  const expanded = expandGraphCandidates(input.db, [...seedById.keys()], {
    maxDepth: 1,
    includeSameModule: false,
    maxExpandedCandidates: EXPAND_PREFILTER_CAP,
  });

  const matches: GraphNeighborMatch[] = [];
  const candidates: HybridCandidate[] = [];
  const perSeedCount = new Map<string, number>();

  for (const neighbour of expanded) {
    if (matches.length >= MAX_TOTAL_NEIGHBORS) break;
    // A neighbour that is itself a high-confidence candidate is not a recovery.
    if (seedEligibleIds.has(neighbour.symbol.id)) continue;
    if (!isExpandableNeighbor(neighbour.symbol, input.db, taskAllowsNonSource)) continue;

    // Attribute to the first seed (sorted) that is still under its per-seed cap.
    const attribution = pickSeedAttribution(neighbour, seedById, perSeedCount);
    if (attribution === undefined) continue;
    perSeedCount.set(attribution.seed.symbolId, (perSeedCount.get(attribution.seed.symbolId) ?? 0) + 1);

    matches.push({
      seedPath: attribution.seed.filePath,
      seedSymbol: attribution.seed.localName,
      edge: attribution.relation,
      neighborPath: neighbour.symbol.filePath,
      neighborSymbol: neighbour.symbol.localName,
      symbolId: neighbour.symbol.id,
      reason: "production neighbour of high-confidence seed",
    });
    // Inject only neighbours MISSING from the pool. A neighbour already present
    // (e.g. surfaced by the retrieval-layer expansion) keeps its own candidate; the
    // genuinely-new recovery — typically a neighbour of a title/literal anchor added
    // after retrieval, or one the pool cap evicted — is injected at support strength.
    if (!poolById.has(neighbour.symbol.id)) {
      candidates.push(buildGraphNeighborCandidate(neighbour.symbol, attribution));
    }
  }

  if (matches.length === 0) return EMPTY;
  return { used: true, matches, candidates };
}

// --- seed eligibility ----------------------------------------------------------

// A pool candidate is a valid expansion seed only when it is HIGH-CONFIDENCE and
// safe to trust: a line/title/literal anchor, a body-literal hit, a test-routed
// candidate, or a strong lexical hit — and NOT a suppressed decoy, a non-source /
// doc-data file, a low-actionability symbol, or an undirect-evidence hub.
export function isSeedEligible(
  candidate: HybridCandidate,
  ids: {
    readonly anchorSymbolIds: ReadonlySet<string>;
    readonly titleSymbolIds: ReadonlySet<string>;
    readonly literalAnchorIds: ReadonlySet<string>;
    readonly suppressedDecoyIds: ReadonlySet<string>;
  },
  taskAllowsNonSource: boolean,
): boolean {
  if (ids.suppressedDecoyIds.has(candidate.symbolId)) return false;
  if (isLikelyTestCandidate(candidate)) return false; // a test is a seed source, but never expanded FROM as itself a target
  if (candidate.scores.actionability === 0) return false; // module var/constant — not a meaningful expansion seed
  if (!taskAllowsNonSource && classifyNonSourceExample(candidate.filePath).isNonSourceExample) return false;

  const s = candidate.scores;
  const directEvidence = s.symbol > 0 || s.path > 0 || s.testToImpl > 0 || s.bodyLiteral > 0;
  // A high-degree hub is only a trustworthy seed with direct task evidence.
  if (s.inDegree >= HUB_IN_DEGREE_THRESHOLD && !directEvidence) return false;

  const isAnchor =
    ids.anchorSymbolIds.has(candidate.symbolId)
    || ids.titleSymbolIds.has(candidate.symbolId)
    || ids.literalAnchorIds.has(candidate.symbolId);
  const testRouted =
    candidate.sources.includes(HybridCandidateSource.FailingTest)
    || candidate.sources.includes(HybridCandidateSource.TestToImpl);
  const strongLexical = s.lexical >= STRONG_DIRECT_LEXICAL;

  return isAnchor || s.bodyLiteral > 0 || testRouted || strongLexical;
}

// Note: tests ARE legitimate expansion sources (a failing test → its
// implementation), but they reach the pool as test-routed/strong-lexical seeds
// whose NEIGHBOURS we keep; the test symbol itself is filtered above so we never
// emit a test as a neighbour candidate. The test-to-impl edge is preserved because
// the implementation it points at is a non-test neighbour.

// --- neighbour eligibility -----------------------------------------------------

// A neighbour is a usable production candidate when it is real source: not a test,
// not non-source/doc-data (unless the task allows it), not vendored/generated, not
// a generic-infra giant (`utils.py`/`base.py`/…), and not a high-degree hub.
export function isExpandableNeighbor(
  symbol: SymbolRecord,
  db: Database,
  taskAllowsNonSource: boolean,
): boolean {
  if (isLikelyTestCandidate(symbol)) return false;
  if (!taskAllowsNonSource && classifyNonSourceExample(symbol.filePath).isNonSourceExample) return false;
  if (isVendoredOrGenerated(symbol.filePath)) return false;
  if (isGenericInfraFile(symbol.filePath)) return false;
  // Skip a high-degree hub neighbour: a fresh neighbour carries no direct task
  // evidence, so a hub would be a generic dependency, not the edit target.
  const inDegree = computeInDegreeCentrality(db, [symbol.id]).get(symbol.id) ?? 0;
  if (inDegree >= HUB_IN_DEGREE_THRESHOLD) return false;
  return true;
}

// A path under a vendored / third-party / generated tree, or a generated-file name.
export function isVendoredOrGenerated(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/");
  if (segments.some((seg) => VENDOR_PATH_SEGMENTS.has(seg))) return true;
  const base = segments[segments.length - 1] ?? "";
  return /(?:_pb2|_pb2_grpc|parsetab|lextab)\.[a-z]+$/.test(base) || /\.generated\./.test(base);
}

// A file whose basename is built ENTIRELY from generic infra tokens (`utils.py`,
// `base.py`, `compat.py`, `exceptions.py`, `deprecation.py`) — a giant generic
// neighbour the task warns against pulling in without direct evidence.
export function isGenericInfraFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const tokens = tokenize(stem);
  if (tokens.length === 0) return false;
  return tokens.every((t) => GENERIC_INFRA_TOKENS.has(t));
}

// --- attribution + candidate construction --------------------------------------

interface SeedAttribution {
  readonly seed: HybridCandidate;
  /** The edge relation linking seed → neighbour (e.g. "imports"). */
  readonly relation: string;
}

// Choose which seed a neighbour is reported/counted against: the first seed (by
// sorted symbol id) that reached it AND is still under its per-seed cap. Returns
// undefined when every reaching seed is already at the cap (so the neighbour is
// skipped — enforcing the per-seed bound).
function pickSeedAttribution(
  neighbour: ExpandedCandidate,
  seedById: ReadonlyMap<string, HybridCandidate>,
  perSeedCount: ReadonlyMap<string, number>,
): SeedAttribution | undefined {
  // Evidence is already sorted (relation, viaSymbolId, direction) by the expander.
  for (const ev of neighbour.evidence) {
    const seed = seedById.get(ev.viaSymbolId);
    if (seed === undefined) continue;
    if ((perSeedCount.get(seed.symbolId) ?? 0) >= MAX_NEIGHBORS_PER_SEED) continue;
    return { seed, relation: relationLabel(ev.relation) };
  }
  return undefined;
}

function relationLabel(relation: ExpansionRelation): string {
  return relation; // ExpansionRelation values are the edge labels ("imports", …)
}

function buildGraphNeighborCandidate(
  symbol: SymbolRecord,
  attribution: SeedAttribution,
): HybridCandidate {
  const actionable = ACTIONABLE_KINDS.has(symbol.kind);
  return {
    symbolId: symbol.id,
    filePath: symbol.filePath,
    fqName: symbol.fqName,
    localName: symbol.localName,
    kind: symbol.kind,
    scores: {
      lexical: 0,
      fts: 0,
      tfidf: 0,
      bm25: 0,
      // NO direct evidence — the role gate keeps this SUPPORT (never a pivot), so a
      // neighbour can lift top-3 recall but cannot displace a real edit target.
      symbol: 0,
      path: 0,
      testToImpl: 0,
      bodyLiteral: 0,
      domain: 0,
      // Honest signal: reached by a graph edge from a high-confidence seed.
      graph: GRAPH_NEIGHBOR_PROXIMITY,
      graphProximity: GRAPH_NEIGHBOR_PROXIMITY,
      centrality: 0,
      actionability: actionable ? 1 : 0,
      inDegree: 0,
      localEvidence: 0,
      hubPenalty: 0,
      actionabilityPenalty: 0,
      final: GRAPH_NEIGHBOR_FINAL,
    },
    sources: [HybridCandidateSource.Graph],
    evidence: [
      `near high-confidence seed \`${attribution.seed.localName}\` (${attribution.seed.filePath}) via ${attribution.relation} edge`,
    ],
    matches: [],
  };
}
