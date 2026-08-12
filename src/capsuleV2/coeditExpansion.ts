// Bounded hidden co-edit support expansion (M97) + confidence tiers (M98).
//
// WHY THIS EXISTS
// ----------------
// Multi-file gold patches collapse in the deterministic scoreboard: vtrace
// usually finds ONE strong edit site but the co-edited sibling never reaches the
// capsule (M96 multi-file all-gold 6.7%). The M97 gap audit shows the hidden
// sibling is almost always (a) already retrieved but squeezed out of the support
// budget by extra symbols of files ALREADY in the capsule, or (b) absent from the
// pool but connected to a found anchor by cross-file call/reference edges whose
// connecting symbol names carry task words (`_parse_annotation` ↔ "annotation"),
// or (c) the anchor's exact generated-artifact pair (`cds.py` ↔
// `cds_parsetab.py`). The existing graph-neighbour lane cannot recover these:
// important co-edit siblings are high-in-degree files it rejects as hubs, and its
// recovered neighbours order LAST among support so a full budget never admits
// them.
//
// This lane therefore has two conservative mechanisms, both support-only:
//   RESCUE  — mark ≤MAX_COEDIT_FILES already-retrieved support candidates whose
//             file is new to the capsule and relation-backed (≥1 cross-file edge
//             to an anchor file AND same/parent/sibling package) so the builder
//             can order them ahead of duplicate-file / generic-infra support.
//   INJECT  — synthesize support candidates for package-scoped, edge-connected
//             neighbour files of an anchor, gated by task-token affinity on the
//             connecting symbol names or anchor-stem sharing, plus the exact
//             generated-artifact pair. Never tests, docs, vendored trees, or
//             generic-infra-named files; per-anchor fan-out reject for hubs.
//
// Guarantees: candidates are SUPPORT-strength (no direct evidence → the role
// gate/lead ordering never makes one the lead pivot), the combined cap is
// MAX_COEDIT_FILES files with one symbol each, and the builder additionally
// enforces a token ceiling (COEDIT_BUDGET_FRACTION of the capsule budget) and a
// displacement rule that never evicts a new-file, non-generic support item.
// Repo-agnostic and deterministic: no instance ids, no per-repo file lists.
//
// CONFIDENCE TIERS (M98)
// ----------------------
// M97 shipped ~1 non-gold relation-backed support file per fired case (94% of
// its candidates were non-gold), which became the dominant capsule-precision
// cost. The M98 audit found the noise concentrates in three shapes that carry
// the weakest evidence, so every proposal now gets a confidence tier decided
// purely from its relation shape (never from outcome or gold):
//
//   HIGH   — an exact generated-artifact pair; an injection whose connecting
//            edges include a CALL and whose connecting symbol names match task
//            words; a rescue coupled to the anchor by ≥2 relation TYPES
//            (e.g. calls AND references) with dense coupling
//            (≥ MIN_HIGH_CONFIDENCE_RESCUE_EDGES edges). Keeps M97's full
//            displacement rights over duplicate/generic/docs support slots.
//   MEDIUM — a real relation with weaker corroboration: a call-edge injection
//            gated only by anchor-stem sharing (no task-word affinity), or a
//            multi-type rescue with sparse coupling. Selectable, but SPARE
//            support slots only — a medium candidate never displaces anything.
//   LOW    — no call edge behind an injection (imports/references-only), an
//            injected `__init__` package facade (a re-export surface reached by
//            import edges, not an edit sibling), or a rescue backed by a single
//            relation type. Excluded from selection entirely; recorded in the
//            pruned diagnostics so the decision stays auditable.
//
// Tiering is applied AFTER the per-anchor and global competitions, which stay
// byte-identical to M97 — so the M98 rendered set is always a SUBSET of the
// M97 rendered set (strictly subtractive; a pruned low-confidence winner never
// lets a new, unmeasured candidate surface in its place).
//
// IMPORT-RE-EXPORT RESCUE (M99)
// -----------------------------
// The index's symbol-level `imports` edges are structurally absent for real
// modules (only single-top-level-symbol files can carry them), so a pooled
// candidate that demonstrably IMPORTS a capsule anchor — the classic hidden
// co-edit `contrib/contenttypes/fields.py` → `db/models/fields/related.py` —
// is invisible to the edge-based rescue above, and the package-proximity gate
// rejects it anyway (co-edit siblings routinely live in different top-level
// packages). The M99 gap audit measured every wider import lane as noise
// (injection-shaped import candidates: 0 gold in every gated slice), so
// exactly ONE import-relation mechanism is admitted, on the audit's only
// surviving slice:
//
//   a pooled, credible-source support candidate that imports a capsule anchor
//   through an exact package-`__init__` re-export chain (alias-aware, never
//   wildcard-expanded), with task-token affinity, below the global edge fan-in
//   hub bound, not itself a facade/generic/docs/test file, only into capsules
//   with ≤ IMPORT_RESCUE_MAX_BASE_FILES distinct base files, capped at ONE per
//   capsule, and only in selection capacity the M97/M98 competition left
//   unused — so the M98 rendered set is never perturbed, only appended to.
//
// The relation comes from an exact build-time scan of top-level import
// statements over the indexed file list (src/parsers/pythonFileImports.ts) —
// never from grep, and never writing to the index (retrieval scoring, graph
// expansion, and hub counts are untouched).

import { readFileSync } from "node:fs";
import path from "node:path";

import type { Database } from "bun:sqlite";

import {
  countCrossFileNeighborFiles,
  listCrossFileEdgeEndpointsForFile,
  type CrossFileEdgeEndpoint,
} from "../db/repositories/edgesRepository";
import { listAllFilePaths } from "../db/repositories/filesRepository";
import { listSymbolsForFile } from "../db/repositories/symbolsRepository";
import {
  createFileImportScanner,
  type FileImportRelation,
} from "../parsers/pythonFileImports";
import { SymbolKind, isStructuralSymbolKind } from "../domain/types";
import {
  HybridCandidateSource,
  type HybridCandidate,
} from "../retrieval/hybridRetrieval";
import { STRONG_DIRECT_LEXICAL } from "../retrieval/hybridScoring";
import { isLikelyTestCandidate } from "../retrieval/searchSymbolsShared";
import { CandidateRole } from "../capsule/assignCandidateRoles";
import type { RefinedRoledCandidate } from "./debugRoles";
import { classifyNonSourceExample, taskMentionsNonSource } from "./nonSourceExample";
import { isGenericInfraFile, isVendoredOrGenerated } from "./graphNeighborAnchoring";
import { NO_DEBUG_ROLE_SIGNALS } from "./types";

// --- bounds (kept tight; see module header) -------------------------------------

/** Combined cap on co-edit files per capsule (rescued + injected). */
export const MAX_COEDIT_FILES = 2;
/** Anchors considered per capsule (ordered pivots first, then strong support). */
export const MAX_COEDIT_ANCHORS = 4;
/** An anchor whose scoped, gate-passing neighbour fan-out exceeds this is too
 * ambiguous to inject from (hub shape) and is skipped for injection. */
export const MAX_QUALIFYING_NEIGHBORS_PER_ANCHOR = 6;
/** Fraction of the capsule token budget co-edit items may consume, combined. */
export const COEDIT_BUDGET_FRACTION = 0.2;
/** Minimum injection score (edges + proximity + affinity + stem). */
const MIN_INJECT_SCORE = 6;
/** Minimum cross-file edges for a pool rescue — one stray edge is coincidence. */
const MIN_RESCUE_EDGES = 2;
/** A neighbour file edge-connected to more distinct files than this is a
 * repo-wide utility (`_api/__init__.py`), not a co-edit sibling. */
export const MAX_NEIGHBOR_GLOBAL_FANIN = 25;
/** Rescue edge density for HIGH confidence (4× MIN_RESCUE_EDGES). Both observed
 * gold rescues sit at 15/26 edges, so any threshold ≤15 preserves them; 8 is
 * chosen with margin rather than at the boundary. Below it a multi-type rescue
 * is still selectable, but only into spare support slots (MEDIUM). */
export const MIN_HIGH_CONFIDENCE_RESCUE_EDGES = 8;
/** Synthesized final for an injected co-edit candidate — support-strength, just
 * above a bare graph neighbour (0.3) and far below any real direct evidence. */
export const COEDIT_INJECT_FINAL = 0.35;
const COEDIT_INJECT_PROXIMITY = 0.5;
/** At most one import-re-export rescue per capsule (M99) — the weakest
 * admissible evidence tier gets the tightest volume cap. */
export const IMPORT_REEXPORT_RESCUE_MAX_PER_CAPSULE = 1;
/** An import-re-export rescue only enters a capsule whose pivots + winning
 * support span at most this many distinct files: the M99 audit's render
 * simulation showed larger capsules taking an import candidate cross straight
 * into overpacking territory, with zero gold among them. Gold-blind. */
export const IMPORT_RESCUE_MAX_BASE_FILES = 4;

// Word tokens too generic to count as task affinity or stem sharing. Small on
// purpose — a wrong exclusion only weakens one signal among several.
const GENERIC_AFFINITY_TOKENS: ReadonlySet<string> = new Set([
  "test", "tests", "self", "args", "kwargs", "data", "value", "values", "item",
  "items", "name", "names", "file", "files", "path", "paths", "type", "types",
  "object", "objects", "list", "dict", "true", "false", "none", "init", "main",
  "process", "handle", "update", "create", "delete", "check", "call", "calls",
  "error", "errors", "result", "results", "default", "defaults", "util", "utils",
  "base", "core", "common", "config", "option", "options", "index", "class",
  "method", "function", "module", "string", "number",
]);

const KIND_PREFERENCE: Readonly<Record<string, number>> = {
  [SymbolKind.Function]: 0,
  [SymbolKind.Method]: 1,
  [SymbolKind.Class]: 2,
};

// --- small path/word helpers -----------------------------------------------------

function dirOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(0, idx) : "";
}

function stemOf(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

// Split an identifier / stem / prose into lowercased word tokens (camelCase +
// snake_case aware), keeping only meaningful (≥4 chars, non-generic) words.
export function meaningfulTokens(value: string): Set<string> {
  const out = new Set<string>();
  for (const part of value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)) {
    const token = part.toLowerCase();
    if (token.length >= 4 && !GENERIC_AFFINITY_TOKENS.has(token)) out.add(token);
  }
  return out;
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const t of a) if (b.has(t)) return true;
  return false;
}

/** Package proximity: same dir (2), parent/child dir (1), sibling packages under
 * one parent (1), anything farther is out of co-edit scope (null). */
export function packageProximity(anchorPath: string, otherPath: string): number | null {
  const a = dirOf(anchorPath);
  const b = dirOf(otherPath);
  if (a === b) return 2;
  if (a !== "" && b !== "" && (a.startsWith(`${b}/`) || b.startsWith(`${a}/`))) return 1;
  if (dirOf(a) !== "" && dirOf(a) === dirOf(b)) return 1;
  return null;
}

// --- anchor selection -------------------------------------------------------------

export interface CoeditAnchorIds {
  readonly anchorSymbolIds: ReadonlySet<string>;
  readonly titleSymbolIds: ReadonlySet<string>;
  readonly literalAnchorIds: ReadonlySet<string>;
  readonly directEvidenceStrongIds: ReadonlySet<string>;
  readonly suppressedDecoyIds: ReadonlySet<string>;
}

// An anchor must be a credible SOURCE edit site: not a test, not docs/examples,
// not vendored/generated, not a generic-infra file, not a suppressed decoy.
function isCredibleSourceAnchor(
  entry: RefinedRoledCandidate,
  ids: CoeditAnchorIds,
  taskAllowsNonSource: boolean,
): boolean {
  const c = entry.candidate;
  if (ids.suppressedDecoyIds.has(c.symbolId)) return false;
  if (isLikelyTestCandidate(c)) return false;
  if (!taskAllowsNonSource && classifyNonSourceExample(c.filePath).isNonSourceExample) return false;
  if (isVendoredOrGenerated(c.filePath)) return false;
  if (isGenericInfraFile(c.filePath)) return false;
  if (entry.signals.is_generic_infrastructure) return false;
  return true;
}

// A support candidate additionally needs STRONG independent evidence to anchor
// expansion (a pivot already cleared the role gate; support has not).
function hasStrongAnchorEvidence(entry: RefinedRoledCandidate, ids: CoeditAnchorIds): boolean {
  const c = entry.candidate;
  if (
    ids.anchorSymbolIds.has(c.symbolId)
    || ids.titleSymbolIds.has(c.symbolId)
    || ids.literalAnchorIds.has(c.symbolId)
    || ids.directEvidenceStrongIds.has(c.symbolId)
  ) return true;
  if (c.scores.bodyLiteral > 0) return true;
  if (
    c.sources.includes(HybridCandidateSource.FailingTest)
    || c.sources.includes(HybridCandidateSource.TestToImpl)
  ) return true;
  return c.scores.lexical >= STRONG_DIRECT_LEXICAL;
}

// --- neighbour mining --------------------------------------------------------------

interface NeighborFileStats {
  readonly path: string;
  edgeCount: number;
  /** Meaningful connecting symbol names (both endpoints) that match a task token. */
  readonly affinityNames: Set<string>;
  /** Other-side endpoint symbols, keyed by id. */
  readonly otherSymbols: Map<string, { name: string; kind: string; edges: number; affinity: boolean }>;
  readonly edgeTypes: Set<string>;
}

function mineNeighborStats(
  db: Database,
  anchorPath: string,
  taskTokens: ReadonlySet<string>,
): Map<string, NeighborFileStats> {
  const byFile = new Map<string, NeighborFileStats>();
  for (const edge of listCrossFileEdgeEndpointsForFile(db, anchorPath)) {
    let stats = byFile.get(edge.otherPath);
    if (stats === undefined) {
      stats = {
        path: edge.otherPath, edgeCount: 0, affinityNames: new Set(),
        otherSymbols: new Map(), edgeTypes: new Set(),
      };
      byFile.set(edge.otherPath, stats);
    }
    stats.edgeCount += 1;
    stats.edgeTypes.add(edge.edgeType);
    const affinity = nameAffinity(edge, taskTokens, stats.affinityNames);
    const sym = stats.otherSymbols.get(edge.otherSymbolId);
    if (sym === undefined) {
      stats.otherSymbols.set(edge.otherSymbolId, {
        name: edge.otherSymbolName, kind: edge.otherSymbolKind, edges: 1, affinity,
      });
    } else {
      sym.edges += 1;
      if (affinity) sym.affinity = true;
    }
  }
  return byFile;
}

// Records affinity names into `sink` as a side effect; returns whether the
// OTHER-side endpoint name itself matched (used to pick the rendered symbol).
function nameAffinity(
  edge: CrossFileEdgeEndpoint,
  taskTokens: ReadonlySet<string>,
  sink: Set<string>,
): boolean {
  const otherMatch = intersects(meaningfulTokens(edge.otherSymbolName), taskTokens);
  if (otherMatch) sink.add(edge.otherSymbolName);
  if (intersects(meaningfulTokens(edge.anchorSymbolName), taskTokens)) {
    sink.add(edge.anchorSymbolName);
  }
  return otherMatch;
}

// --- results ----------------------------------------------------------------------

/** Relation-shape confidence tier (see the module header). */
export type CoeditConfidence = "high" | "medium" | "low";

export interface CoeditCandidateMeta {
  readonly path: string;
  readonly symbol: string;
  readonly action: "rescued" | "injected";
  readonly evidence_type: string;
  readonly anchor_path: string;
  readonly edge_count: number;
  readonly score: number;
  readonly confidence: CoeditConfidence;
  /** Exact import relation shapes behind an import-relation candidate (M99). */
  readonly import_kinds?: string[];
}

/** A selected-then-pruned low-confidence candidate (diagnostics only). */
export interface CoeditPrunedMeta extends CoeditCandidateMeta {
  readonly prune_reason: string;
}

export interface CoeditExpansionResult {
  readonly fired: boolean;
  readonly anchors: Array<{ path: string; symbol: string }>;
  /** Symbol ids of ALREADY-POOLED support entries promoted into the co-edit tier. */
  readonly rescuedSymbolIds: ReadonlySet<string>;
  /** Selected co-edit entries in selection order (rescued refs + injected). */
  readonly entries: RefinedRoledCandidate[];
  /** Symbol ids of MEDIUM-confidence entries — spare support slots only. */
  readonly spareOnlySymbolIds: ReadonlySet<string>;
  readonly candidates: CoeditCandidateMeta[];
  /** LOW-confidence candidates that won selection but were pruned (M98). */
  readonly pruned: CoeditPrunedMeta[];
  readonly highDegreeRejectedCount: number;
  readonly ambiguousRejectedCount: number;
  /** Pooled support entries with an exact import relation to an anchor (M99). */
  readonly importConsideredCount: number;
  /** Import-relation candidates rejected as edge-fan hubs (M99). */
  readonly importHubRejectedCount: number;
  /** Import-relation candidates rejected by the facade/affinity/capsule-size
   * gates or the per-capsule cap (M99). */
  readonly importAmbiguousRejectedCount: number;
}

const EMPTY_RESULT: CoeditExpansionResult = {
  fired: false, anchors: [], rescuedSymbolIds: new Set(), entries: [],
  spareOnlySymbolIds: new Set(), candidates: [], pruned: [],
  highDegreeRejectedCount: 0, ambiguousRejectedCount: 0,
  importConsideredCount: 0, importHubRejectedCount: 0, importAmbiguousRejectedCount: 0,
};

export interface CoeditExpansionInput {
  readonly db: Database;
  readonly task: string;
  /** Surviving pivots in final render order (lead first). */
  readonly pivotEntries: readonly RefinedRoledCandidate[];
  /** Real support entries in the builder's base support order. */
  readonly supportEntries: readonly RefinedRoledCandidate[];
  /** Support entries guaranteed a slot under the base order (first maxSupport). */
  readonly winnerSymbolIds: ReadonlySet<string>;
  /** Every file path currently in the candidate pool. */
  readonly poolFilePaths: ReadonlySet<string>;
  readonly ids: CoeditAnchorIds;
  /** Repo root for the exact file-level import scan (M99). When absent, the
   * import-re-export rescue is disabled and behaviour is byte-identical M98. */
  readonly repoRoot?: string;
  /** Test seam: reads a repo-relative file for the import scan (defaults to
   * reading from `repoRoot`). */
  readonly readFile?: (relPath: string) => string | null;
}

/**
 * Compute the bounded co-edit expansion for an assembled selection. Pure with
 * respect to the index; never consults gold data; deterministic. Returns rescues
 * (pool symbol ids to promote) + injections (fresh support entries), combined
 * capped at MAX_COEDIT_FILES files.
 */
export function expandCoeditSupport(input: CoeditExpansionInput): CoeditExpansionResult {
  const taskAllowsNonSource = taskMentionsNonSource(input.task);
  const lead = input.pivotEntries[0];
  // Activation: never expand from a test-led or docs/example-led selection (the
  // capsule has no credible edit site to co-edit AROUND). A generic-infra lead is
  // fine as long as ANOTHER pivot qualifies as an anchor below.
  if (lead === undefined) return EMPTY_RESULT;
  if (isLikelyTestCandidate(lead.candidate)) return EMPTY_RESULT;
  if (
    !taskAllowsNonSource
    && classifyNonSourceExample(lead.candidate.filePath).isNonSourceExample
  ) return EMPTY_RESULT;

  // Anchors: credible source pivots first, then support with strong evidence.
  const anchors: RefinedRoledCandidate[] = [];
  const anchorFiles = new Set<string>();
  for (const entry of input.pivotEntries) {
    if (anchors.length >= MAX_COEDIT_ANCHORS) break;
    if (!isCredibleSourceAnchor(entry, input.ids, taskAllowsNonSource)) continue;
    if (anchorFiles.has(entry.candidate.filePath)) continue;
    anchors.push(entry);
    anchorFiles.add(entry.candidate.filePath);
  }
  for (const entry of input.supportEntries) {
    if (anchors.length >= MAX_COEDIT_ANCHORS) break;
    if (!isCredibleSourceAnchor(entry, input.ids, taskAllowsNonSource)) continue;
    if (!hasStrongAnchorEvidence(entry, input.ids)) continue;
    if (anchorFiles.has(entry.candidate.filePath)) continue;
    anchors.push(entry);
    anchorFiles.add(entry.candidate.filePath);
  }
  if (anchors.length === 0) return EMPTY_RESULT;

  const taskTokens = meaningfulTokens(input.task);
  const pivotFiles = new Set(input.pivotEntries.map((e) => e.candidate.filePath));
  let highDegreeRejected = 0;
  let ambiguousRejected = 0;

  interface Proposal {
    readonly path: string;
    readonly action: "rescued" | "injected";
    readonly evidenceType: string;
    readonly anchor: RefinedRoledCandidate;
    readonly edgeCount: number;
    readonly score: number;
    readonly confidence: CoeditConfidence;
    /** Present iff confidence is "low": why it will be pruned at selection. */
    readonly pruneReason?: string;
    /** Exact import relation shapes behind an import-relation proposal (M99). */
    readonly importKinds?: string[];
    /** rescued: the pool entry to promote; injected: the synthesized entry. */
    readonly entry: RefinedRoledCandidate;
  }
  const proposals: Proposal[] = [];
  const proposedFiles = new Set<string>();

  // Files already guaranteed in the capsule (pivots + winner support) — a
  // co-edit toward one of those is redundant.
  const guaranteedFiles = new Set(pivotFiles);
  for (const entry of input.supportEntries) {
    if (input.winnerSymbolIds.has(entry.candidate.symbolId)) {
      guaranteedFiles.add(entry.candidate.filePath);
    }
  }

  for (const anchor of anchors) {
    const anchorPath = anchor.candidate.filePath;
    const stats = mineNeighborStats(input.db, anchorPath, taskTokens);
    const anchorStemTokens = meaningfulTokens(stemOf(anchorPath));
    // Non-generated proposals this anchor produced; only its single BEST one
    // survives (see the per-anchor cap at the bottom of the loop).
    const anchorProposals: Proposal[] = [];

    // ---- RESCUE: relation-backed pool support squeezed out of the budget ----
    // The candidate is organically retrieved (it already carries lexical
    // relevance), so proximity + ≥1 edge suffices — no affinity gate.
    for (const entry of input.supportEntries) {
      const c = entry.candidate;
      if (input.winnerSymbolIds.has(c.symbolId)) continue;
      if (guaranteedFiles.has(c.filePath) || proposedFiles.has(c.filePath)) continue;
      if (anchorProposals.some((p) => p.path === c.filePath)) continue;
      if (!isCredibleSourceAnchor(entry, input.ids, taskAllowsNonSource)) continue;
      const proximity = packageProximity(anchorPath, c.filePath);
      const fileStats = stats.get(c.filePath);
      if (proximity === null || fileStats === undefined || fileStats.edgeCount < MIN_RESCUE_EDGES) continue;
      anchorProposals.push({
        path: c.filePath, action: "rescued",
        evidenceType: `pool_rescue_${[...fileStats.edgeTypes].sort().join("_")}`,
        anchor, edgeCount: fileStats.edgeCount,
        score: Math.min(fileStats.edgeCount, 8) + proximity,
        ...rescueConfidence(fileStats),
        entry,
      });
    }

    // ---- INJECT: generated-artifact pair (exact stem pairing) ----
    for (const suffix of ["_parsetab", "_lextab"]) {
      const pairPath = `${dirOf(anchorPath)}${dirOf(anchorPath) === "" ? "" : "/"}${stemOf(anchorPath)}${suffix}.py`;
      if (guaranteedFiles.has(pairPath) || proposedFiles.has(pairPath)) continue;
      if (input.poolFilePaths.has(pairPath)) continue;
      // The injected entry stands in for the whole generated file, so it must be
      // a symbol the reader can actually be shown. A <module> scope now sorts
      // first here (its span is pinned to byte 0) and generated tables declare
      // little else, so taking symbols[0] blindly delivered `::<module>`.
      const symbols = listSymbolsForFile(input.db, pairPath)
        .filter((symbol) => !isStructuralSymbolKind(symbol.kind));
      if (symbols.length === 0) continue;
      const first = symbols[0]!;
      proposedFiles.add(pairPath);
      proposals.push({
        path: pairPath, action: "injected", evidenceType: "generated_artifact_pair",
        anchor, edgeCount: 0, score: MIN_INJECT_SCORE + 2, confidence: "high",
        entry: buildInjectedEntry({
          symbolId: first.id, filePath: pairPath, fqName: first.fqName,
          localName: first.localName, kind: first.kind,
          evidence: `generated artifact pair of \`${stemOf(anchorPath)}.py\` (${anchorPath}) — regenerate alongside the source edit (co-edit lane)`,
          roleReason: "generated artifact paired with a co-edit anchor",
        }),
      });
    }

    // ---- INJECT: edge-connected, affinity-gated package neighbours ----
    const qualifying: Array<{ stats: NeighborFileStats; proximity: number; score: number; stemShare: boolean }> = [];
    for (const fileStats of statsSorted(stats)) {
      const otherPath = fileStats.path;
      if (guaranteedFiles.has(otherPath) || proposedFiles.has(otherPath)) continue;
      if (input.poolFilePaths.has(otherPath)) continue; // pooled files go through RESCUE
      if (isLikelyTestCandidate({ filePath: otherPath, localName: "", fqName: "" })) continue;
      if (!taskAllowsNonSource && classifyNonSourceExample(otherPath).isNonSourceExample) continue;
      if (isVendoredOrGenerated(otherPath)) continue;
      if (isGenericInfraFile(otherPath)) continue;
      const proximity = packageProximity(anchorPath, otherPath);
      if (proximity === null) continue;
      const stemShare = intersects(meaningfulTokens(stemOf(otherPath)), anchorStemTokens);
      const affinity = Math.min(fileStats.affinityNames.size, 2);
      const score = Math.min(fileStats.edgeCount, 8) + proximity + affinity * 4 + (stemShare ? 3 : 0);
      if (score < MIN_INJECT_SCORE) continue;
      if (affinity === 0 && !stemShare) {
        // Plausible by volume alone (edges + proximity) — ambiguous, reject.
        ambiguousRejected += 1;
        continue;
      }
      if (countCrossFileNeighborFiles(input.db, otherPath) > MAX_NEIGHBOR_GLOBAL_FANIN) {
        // A repo-wide utility everything touches — never a co-edit sibling.
        highDegreeRejected += 1;
        continue;
      }
      qualifying.push({ stats: fileStats, proximity, score, stemShare });
    }
    if (qualifying.length > MAX_QUALIFYING_NEIGHBORS_PER_ANCHOR) {
      // Hub-shaped anchor: too many strongly-connected siblings to disambiguate.
      // Injection from this anchor is unsafe; its RESCUES (organically retrieved
      // pool candidates) are unaffected.
      highDegreeRejected += 1;
      qualifying.length = 0;
    }
    qualifying.sort((a, b) => b.score - a.score || a.stats.path.localeCompare(b.stats.path));
    for (const q of qualifying) {
      const pick = pickInjectedSymbol(q.stats);
      if (pick === undefined) continue;
      anchorProposals.push({
        path: q.stats.path, action: "injected",
        evidenceType: `edge_${[...q.stats.edgeTypes].sort().join("_")}`,
        anchor, edgeCount: q.stats.edgeCount, score: q.score,
        ...injectionConfidence(q.stats, q.stemShare),
        entry: buildInjectedEntry({
          symbolId: pick.id, filePath: q.stats.path, fqName: pick.fqName,
          localName: pick.name, kind: pick.kind,
          evidence: `co-edit neighbour of anchor \`${anchor.candidate.localName}\` (${anchorPath}) via ${q.stats.edgeCount} ${[...q.stats.edgeTypes].sort().join("/")} edge(s)${q.stats.affinityNames.size > 0 ? `; connecting symbols match task words (${[...q.stats.affinityNames].sort().slice(0, 2).join(", ")})` : ""} (co-edit lane)`,
          roleReason: "likely co-edit sibling of a high-confidence anchor",
        }),
      });
    }

    // Per-anchor cap: only the single BEST non-generated proposal survives — an
    // anchor's runner-up sibling is almost always coupling noise, and letting
    // every anchor add several plausible neighbours is exactly the overpacking
    // shape this lane must avoid. A rescue (organically retrieved, so doubly
    // evidenced) beats any injection — the same precedence the global selection
    // uses; within an action, highest score wins.
    anchorProposals.sort((a, b) =>
      (a.action !== b.action ? (a.action === "rescued" ? -1 : 1) : 0)
      || b.score - a.score
      || a.path.localeCompare(b.path));
    const best = anchorProposals[0];
    if (best !== undefined) {
      proposedFiles.add(best.path);
      proposals.push(best);
      ambiguousRejected += anchorProposals.length - 1;
    }
  }

  // Combined selection: rescues first (organically evidenced), then injections
  // by score; MAX_COEDIT_FILES files total. Confidence is deliberately NOT an
  // ordering key — the competition stays byte-identical to M97 and the tier is
  // applied to the WINNERS below, so pruning a low-confidence winner can only
  // shrink the rendered set, never surface a new unmeasured candidate.
  proposals.sort((a, b) => {
    if (a.action !== b.action) return a.action === "rescued" ? -1 : 1;
    return b.score - a.score || a.path.localeCompare(b.path);
  });
  const selected = proposals.slice(0, MAX_COEDIT_FILES);
  ambiguousRejected += proposals.length - selected.length;

  // ---- IMPORT-RE-EXPORT RESCUE (M99) ----
  // Runs strictly AFTER the M97/M98 competition and only into selection
  // capacity it left unused, so the existing rendered set is never perturbed.
  // See the module header for the audit-derived gates.
  let importConsidered = 0;
  let importHubRejected = 0;
  let importAmbiguousRejected = 0;
  if (input.repoRoot !== undefined && selected.length < MAX_COEDIT_FILES) {
    const repoRoot = input.repoRoot;
    const readFile = input.readFile
      ?? ((relPath: string): string | null => {
        try {
          return readFileSync(path.join(repoRoot, relPath), "utf8");
        } catch {
          return null;
        }
      });
    const scanner = createFileImportScanner(listAllFilePaths(input.db), readFile);
    // Gold-blind bloat guard: import evidence is the weakest admissible tier,
    // so it never grows a capsule that is already broad.
    const baseFilesOk = guaranteedFiles.size <= IMPORT_RESCUE_MAX_BASE_FILES;
    let importKept = 0;
    for (const entry of input.supportEntries) {
      if (importKept >= IMPORT_REEXPORT_RESCUE_MAX_PER_CAPSULE) break;
      if (selected.length >= MAX_COEDIT_FILES) break;
      const c = entry.candidate;
      if (input.winnerSymbolIds.has(c.symbolId)) continue;
      if (guaranteedFiles.has(c.filePath) || proposedFiles.has(c.filePath)) continue;
      if (!isCredibleSourceAnchor(entry, input.ids, taskAllowsNonSource)) continue;
      if (c.filePath.endsWith("__init__.py")) continue;
      const anchorRelations = scanner
        .relationsOf(c.filePath)
        .filter((r) => anchorFiles.has(r.importedPath));
      if (anchorRelations.length === 0) continue;
      importConsidered += 1;
      // Facade gate: the candidate must reach the anchor through an exact
      // package __init__ re-export chain — the only import shape the M99 audit
      // found precise enough (plain name/module imports were 65/67 non-gold).
      const relation = anchorRelations.find((r) => r.kinds.includes("init_reexport"));
      if (relation === undefined || !baseFilesOk) {
        importAmbiguousRejected += 1;
        continue;
      }
      const affinity = intersects(meaningfulTokens(relation.importedNames.join(" ")), taskTokens)
        || intersects(meaningfulTokens(stemOf(c.filePath)), taskTokens);
      if (!affinity) {
        importAmbiguousRejected += 1;
        continue;
      }
      if (countCrossFileNeighborFiles(input.db, c.filePath) > MAX_NEIGHBOR_GLOBAL_FANIN) {
        importHubRejected += 1;
        continue;
      }
      const anchor = anchors.find((a) => a.candidate.filePath === relation.importedPath);
      if (anchor === undefined) continue;
      proposedFiles.add(c.filePath);
      selected.push({
        path: c.filePath, action: "rescued",
        evidenceType: "import_reexport_rescue",
        anchor, edgeCount: 0, score: 0, confidence: "high",
        importKinds: [...relation.kinds],
        entry: markImportRescued(entry, relation),
      });
      importKept += 1;
    }
  }

  if (selected.length === 0) {
    return {
      ...EMPTY_RESULT,
      fired: false,
      highDegreeRejectedCount: highDegreeRejected,
      ambiguousRejectedCount: ambiguousRejected,
      importConsideredCount: importConsidered,
      importHubRejectedCount: importHubRejected,
      importAmbiguousRejectedCount: importAmbiguousRejected,
    };
  }

  const rescuedIds = new Set<string>();
  const spareOnlyIds = new Set<string>();
  const entries: RefinedRoledCandidate[] = [];
  const meta: CoeditCandidateMeta[] = [];
  const pruned: CoeditPrunedMeta[] = [];
  for (const p of selected) {
    const base: CoeditCandidateMeta = {
      path: p.path, symbol: p.entry.candidate.localName, action: p.action,
      evidence_type: p.evidenceType, anchor_path: p.anchor.candidate.filePath,
      edge_count: p.edgeCount, score: p.score, confidence: p.confidence,
      ...(p.importKinds === undefined ? {} : { import_kinds: p.importKinds }),
    };
    if (p.confidence === "low") {
      pruned.push({ ...base, prune_reason: p.pruneReason ?? "low confidence" });
      continue;
    }
    const entry = p.action === "rescued" && p.importKinds === undefined
      ? markRescued(p.entry, p.anchor.candidate.filePath, p.edgeCount)
      : p.entry;
    if (p.action === "rescued") rescuedIds.add(entry.candidate.symbolId);
    if (p.confidence === "medium") spareOnlyIds.add(entry.candidate.symbolId);
    entries.push(entry);
    meta.push(base);
  }
  return {
    // Fired = the lane WON selection slots (kept or pruned) — comparable to the
    // M97 fire-rate; a fully-pruned fire is visible via `pruned` + empty entries.
    fired: true,
    anchors: anchors.map((a) => ({ path: a.candidate.filePath, symbol: a.candidate.localName })),
    rescuedSymbolIds: rescuedIds,
    entries,
    spareOnlySymbolIds: spareOnlyIds,
    candidates: meta,
    pruned,
    highDegreeRejectedCount: highDegreeRejected,
    ambiguousRejectedCount: ambiguousRejected,
    importConsideredCount: importConsidered,
    importHubRejectedCount: importHubRejected,
    importAmbiguousRejectedCount: importAmbiguousRejected,
  };
}

// --- confidence tiers (M98) --------------------------------------------------------

// A rescue is organically retrieved, so its tier keys on the SHAPE of its
// coupling to the anchor: two independent relation types (e.g. the anchor both
// calls into and is referenced by the file) is the observed co-edit signature;
// a single relation type — however many edges — is ordinary one-way usage and
// contributed zero gold in the M98 audit (23/23 non-gold).
function rescueConfidence(
  stats: NeighborFileStats,
): { confidence: CoeditConfidence; pruneReason?: string } {
  if (stats.edgeTypes.size < 2) {
    return { confidence: "low", pruneReason: "single relation type rescue" };
  }
  return stats.edgeCount >= MIN_HIGH_CONFIDENCE_RESCUE_EDGES
    ? { confidence: "high" }
    : { confidence: "medium" };
}

// An injection is synthesized, so it needs the strongest relation available: a
// CALL edge (the anchor executes the sibling's code, or vice versa). Import- and
// reference-only injections (0/20 gold in the M98 audit) and `__init__` package
// facades (re-export surfaces import edges always reach; 0/13 gold) are LOW.
// With a call edge, task-word affinity on a connecting symbol is HIGH; an
// anchor-stem share alone is circumstantial → MEDIUM (spare slots only).
function injectionConfidence(
  stats: NeighborFileStats,
  stemShare: boolean,
): { confidence: CoeditConfidence; pruneReason?: string } {
  const base = stats.path.slice(stats.path.lastIndexOf("/") + 1);
  if (base === "__init__.py") {
    return { confidence: "low", pruneReason: "package facade (__init__) injection" };
  }
  if (!stats.edgeTypes.has("calls")) {
    return { confidence: "low", pruneReason: "no call edge behind injection" };
  }
  if (stats.affinityNames.size > 0) return { confidence: "high" };
  return stemShare
    ? { confidence: "medium" }
    : { confidence: "low", pruneReason: "no affinity or stem share" };
}

// --- displacement-safe support ordering --------------------------------------------

export interface CoeditSupportOrder {
  readonly ordered: RefinedRoledCandidate[];
  /** The winners a rendered co-edit is allowed to displace (for diagnostics). */
  readonly displaceableWinners: RefinedRoledCandidate[];
}

/**
 * Merge co-edit entries into the base support order without ever evicting a
 * support item that introduces a genuinely NEW, non-generic, non-example file:
 * co-edit entries rank behind every such "protected" winner and only ahead of
 * duplicate-file symbols, generic-infra files, and docs/example items — so a
 * co-edit can reclaim a slot spent on a second symbol of an already-present
 * file (or on junk) but never displace a distinct support file vtrace found on
 * its own evidence. `isProtectedTier` abstracts the builder's tier test.
 *
 * M98: only HIGH-confidence co-edit entries hold that displacement position.
 * MEDIUM-confidence entries (`spareOnlySymbolIds`) rank behind EVERY winner —
 * they render only into genuinely spare support slots and can never displace
 * anything, not even a duplicate-file symbol.
 */
export function orderSupportWithCoedit(input: {
  readonly baseOrder: readonly RefinedRoledCandidate[];
  readonly coeditEntries: readonly RefinedRoledCandidate[];
  readonly rescuedSymbolIds: ReadonlySet<string>;
  /** Medium-confidence co-edit symbol ids: spare slots only, never displace. */
  readonly spareOnlySymbolIds: ReadonlySet<string>;
  readonly pivotFilePaths: ReadonlySet<string>;
  readonly maxSupport: number;
  readonly isProtectedTier: (entry: RefinedRoledCandidate) => boolean;
}): CoeditSupportOrder {
  const seenFiles = new Set(input.pivotFilePaths);
  const newFileIds = new Set<string>();
  for (const entry of input.baseOrder) {
    if (!seenFiles.has(entry.candidate.filePath)) {
      newFileIds.add(entry.candidate.symbolId);
      seenFiles.add(entry.candidate.filePath);
    }
  }
  const winners = input.baseOrder.slice(0, input.maxSupport);
  const rest = input.baseOrder
    .slice(input.maxSupport)
    .filter((e) => !input.rescuedSymbolIds.has(e.candidate.symbolId));
  const displaceable = (entry: RefinedRoledCandidate): boolean =>
    !newFileIds.has(entry.candidate.symbolId)
    || isGenericInfraFile(entry.candidate.filePath)
    || entry.nonSourceExample?.isNonSourceExample === true
    || !input.isProtectedTier(entry);
  const displaceableWinners = winners.filter(displaceable);
  const displacing = input.coeditEntries
    .filter((e) => !input.spareOnlySymbolIds.has(e.candidate.symbolId));
  const spareOnly = input.coeditEntries
    .filter((e) => input.spareOnlySymbolIds.has(e.candidate.symbolId));
  return {
    ordered: [
      ...winners.filter((w) => !displaceable(w)),
      ...displacing,
      ...displaceableWinners,
      ...spareOnly,
      ...rest,
    ],
    displaceableWinners,
  };
}

// Deterministic iteration over mined stats (insertion order follows edge id order;
// re-sort by path for stability across SQLite versions).
function statsSorted(stats: ReadonlyMap<string, NeighborFileStats>): NeighborFileStats[] {
  return [...stats.values()].sort((a, b) => a.path.localeCompare(b.path));
}

// The rendered symbol for an injected file: prefer an endpoint whose own name
// matched a task token, then most connecting edges, then function > method >
// class, then name — so the capsule shows the symbol the anchor actually touches.
function pickInjectedSymbol(
  stats: NeighborFileStats,
): { id: string; name: string; kind: string; fqName: string } | undefined {
  const entries = [...stats.otherSymbols.entries()].map(([id, s]) => ({ id, ...s }));
  if (entries.length === 0) return undefined;
  entries.sort((a, b) =>
    Number(b.affinity) - Number(a.affinity)
    || b.edges - a.edges
    || (KIND_PREFERENCE[a.kind] ?? 9) - (KIND_PREFERENCE[b.kind] ?? 9)
    || a.name.localeCompare(b.name)
    || a.id.localeCompare(b.id));
  const best = entries[0]!;
  return { id: best.id, name: best.name, kind: best.kind, fqName: best.name };
}

// An import-rescued entry keeps its organic candidate/scores; it only gains an
// evidence line naming the exact re-export relation so the promotion is
// auditable in the capsule output.
function markImportRescued(
  entry: RefinedRoledCandidate,
  relation: FileImportRelation,
): RefinedRoledCandidate {
  const names = relation.importedNames.slice(0, 3).join(", ");
  const line = `imports co-edit anchor ${relation.importedPath} via package __init__ re-export${names.length > 0 ? ` (${names})` : ""} (import-relation lane)`;
  if (!entry.candidate.evidence.includes(line)) {
    entry.candidate.evidence = [...entry.candidate.evidence, line].sort();
  }
  return entry;
}

// A rescued entry keeps its organic candidate/scores; it only gains the co-edit
// evidence line so the promotion is auditable in the capsule output.
function markRescued(
  entry: RefinedRoledCandidate,
  anchorPath: string,
  edgeCount: number,
): RefinedRoledCandidate {
  const line = `co-edit sibling of anchor ${anchorPath} (${edgeCount} cross-file edge(s), co-edit lane)`;
  if (!entry.candidate.evidence.includes(line)) {
    entry.candidate.evidence = [...entry.candidate.evidence, line].sort();
  }
  return entry;
}

function buildInjectedEntry(input: {
  symbolId: string; filePath: string; fqName: string; localName: string;
  kind: string; evidence: string; roleReason: string;
}): RefinedRoledCandidate {
  const actionable = input.kind === SymbolKind.Function
    || input.kind === SymbolKind.Method
    || input.kind === SymbolKind.Class;
  const candidate: HybridCandidate = {
    symbolId: input.symbolId,
    filePath: input.filePath,
    fqName: input.fqName,
    localName: input.localName,
    kind: input.kind as HybridCandidate["kind"],
    scores: {
      lexical: 0, fts: 0, tfidf: 0, bm25: 0,
      // NO direct evidence — support-only by construction; can never lead.
      symbol: 0, path: 0, testToImpl: 0, bodyLiteral: 0, domain: 0,
      graph: COEDIT_INJECT_PROXIMITY, graphProximity: COEDIT_INJECT_PROXIMITY,
      centrality: 0, actionability: actionable ? 1 : 0, inDegree: 0,
      localEvidence: 0, hubPenalty: 0, actionabilityPenalty: 0,
      final: COEDIT_INJECT_FINAL,
    },
    sources: [HybridCandidateSource.Graph],
    evidence: [input.evidence],
    matches: [],
  };
  return {
    candidate,
    role: CandidateRole.Support,
    roleReason: input.roleReason,
    signals: NO_DEBUG_ROLE_SIGNALS,
  };
}
