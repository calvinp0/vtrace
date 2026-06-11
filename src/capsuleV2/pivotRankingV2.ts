// Stage 5 pivot-ranking v2 — conservative, additive, explainable re-ranking of
// already-selected pivot candidates for noisy retrieval.
//
// Motivation (Stage 5 Astropy diagnostic, commit 03dc5522): in ambiguous
// "multiple edit targets" cases with no strong anchor, the legacy ordering (the
// weighted `final` score) sometimes ranks a broad, weakly-supported class (e.g. a
// large `VOUnit` class in the wrong file) above a more specific implementation
// target in the file that actually needs the edit. v2 nudges ordering toward
// pivots that (a) are backed by MULTIPLE independent evidence types, (b) are more
// SPECIFIC implementation targets (function/method > class > module), and (c) are
// real source paths — while penalising large, weakly-supported, broad candidates.
//
// CRITICAL — no outcome leakage. The ranker takes ONLY pre-outcome signals
// (scorecard strengths, kind, path, evidence sources, snippet size). It never sees
// edited files, resolved/unresolved status, benchmark outcome, repaired-patch
// evidence, or Docker results. `PivotRankInput` deliberately has no such field;
// the production mapper and tests only feed it ranking signals. This is a ranking
// change only — it does not change the Capsule snippet budget, deferred-ref
// expansion, PIVOT_CHECK, the critic, repair, or the evaluator.

import { SymbolKind } from "../domain/types";
import type { CapsuleV2Scorecard } from "./types";

export type PivotRankingVersion = "legacy" | "v2";

export const DEFAULT_PIVOT_RANKING_VERSION: PivotRankingVersion = "v2";

export function parsePivotRankingVersion(value: string | undefined): PivotRankingVersion {
  return value === "legacy" ? "legacy" : value === "v2" ? "v2" : DEFAULT_PIVOT_RANKING_VERSION;
}

// The whitelisted, pre-outcome signals the ranker is allowed to use. NOTHING about
// the eventual edit, the run result, or the evaluation appears here — by
// construction the ranker cannot leak outcome into its ordering.
export interface PivotRankInput {
  /** Repo-relative (or absolute) source path of the candidate. */
  path: string;
  /** Symbol kind: function/method/class/module-level/etc. (SymbolKind value). */
  kind: string;
  /** The per-candidate scorecard (normalised signal strengths + weighted `final`). */
  scorecard: CapsuleV2Scorecard;
  /** Independent generator sources that surfaced this candidate (HybridCandidateSource values). */
  evidenceSources: readonly string[];
  /** Estimated token length of the focused source snippet (0 when unknown). */
  snippetTokens: number;
  /** Pre-classified docs/examples/fixture flag (a non-source example is never an impl target). */
  isNonSourceExample?: boolean;
}

export interface PivotRankResult {
  version: PivotRankingVersion;
  /** The ordering key (higher ranks earlier). */
  score: number;
  /** Compact, additive boost explanations. */
  signals: string[];
  /** Compact, additive penalty explanations. */
  penalties: string[];
  /** One-line human summary for the manifest / report. */
  reason: string;
}

// --- Tunables (small, conservative magnitudes relative to the [0,1+] `final`). ---

// A scorecard signal counts as a distinct evidence type at/above this strength.
const EVIDENCE_PRESENT_MIN = 0.15;
// Per-extra-evidence-type boost, and its cap.
const MULTI_EVIDENCE_STEP = 0.1;
const MULTI_EVIDENCE_CAP = 0.3;
// A symbol/body-literal match this strong is a near-exact hit: it earns a small
// boost AND shields a broad/large candidate from the broad-snippet penalty.
const STRONG_EXACT_MIN = 0.8;
const STRONG_EXACT_BOOST = 0.1;
// Specificity boosts/penalties by kind.
const SPECIFIC_IMPL_BOOST = 0.08; // function / method
const MODULE_LEVEL_PENALTY = 0.04; // module constant/variable/alias
const NON_CODE_PENALTY = 0.1; // markdown section / non-symbol
// Broad-snippet / noise penalty (applied only to weakly-supported candidates).
const LARGE_SNIPPET_TOKENS = 350;
const BROAD_SNIPPET_PENALTY = 0.15;
// Implementation-path preference: down-rank docs/tests/config/generated paths.
const NON_IMPL_PATH_PENALTY = 0.12;

const MODULE_LEVEL_KINDS = new Set<string>([
  SymbolKind.ModuleConstant,
  SymbolKind.ModuleVariable,
  SymbolKind.ModuleAlias,
]);

const SPECIFIC_IMPL_KINDS = new Set<string>([SymbolKind.Function, SymbolKind.Method]);

// Paths that are not implementation/source targets when evidence is otherwise
// similar (tests, docs, config, generated/vendored). Conservative — these only
// shift ordering, never remove a candidate.
const NON_IMPL_PATH_RE =
  /(^|\/)(tests?|testing|docs?|examples?|samples?|fixtures?|conf|config|setup|migrations?|generated|vendor|node_modules|build|dist)(\/|\.|_|$)/i;

function isNonImplPath(path: string): boolean {
  return NON_IMPL_PATH_RE.test(path);
}

// Count distinct evidence TYPES present, from the normalised scorecard strengths.
// Using the scorecard (not raw generator sources) keeps the count anchored to
// measured signal strength, so a barely-present source does not inflate diversity.
export function countEvidenceTypes(scorecard: CapsuleV2Scorecard): number {
  let count = 0;
  if (scorecard.lexical >= EVIDENCE_PRESENT_MIN) count += 1;
  if (scorecard.symbol >= EVIDENCE_PRESENT_MIN) count += 1;
  if (scorecard.path >= EVIDENCE_PRESENT_MIN) count += 1;
  if (scorecard.test_to_impl >= EVIDENCE_PRESENT_MIN) count += 1;
  if (scorecard.body_literal >= EVIDENCE_PRESENT_MIN) count += 1;
  if (scorecard.graph_proximity >= EVIDENCE_PRESENT_MIN) count += 1;
  return count;
}

function isStrongExact(scorecard: CapsuleV2Scorecard): boolean {
  return scorecard.symbol >= STRONG_EXACT_MIN || scorecard.body_literal >= STRONG_EXACT_MIN;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// Score one pivot candidate. Additive: starts from the legacy `final` (so v2 is a
// conservative refinement, never a wholesale re-scoring) and adds/subtracts small,
// individually-explained deltas.
export function scorePivotV2(input: PivotRankInput): PivotRankResult {
  const { scorecard, kind, snippetTokens } = input;
  const base = scorecard.final;
  const evidenceTypes = countEvidenceTypes(scorecard);
  const strongExact = isStrongExact(scorecard);
  const weakSupport = evidenceTypes <= 1 && !strongExact;

  const signals: string[] = [];
  const penalties: string[] = [];
  let delta = 0;

  // 1. Multi-evidence boost.
  if (evidenceTypes >= 2) {
    const boost = Math.min(MULTI_EVIDENCE_STEP * (evidenceTypes - 1), MULTI_EVIDENCE_CAP);
    delta += boost;
    signals.push(`multi-evidence(${evidenceTypes}) +${round(boost)}`);
  }

  // 2. Strong/exact match boost (also shields from the broad penalty below).
  if (strongExact) {
    delta += STRONG_EXACT_BOOST;
    signals.push(`strong-exact +${STRONG_EXACT_BOOST}`);
  }

  // 3. Specificity boost / penalty by kind.
  if (SPECIFIC_IMPL_KINDS.has(kind)) {
    delta += SPECIFIC_IMPL_BOOST;
    signals.push(`specific-impl(${kind}) +${SPECIFIC_IMPL_BOOST}`);
  } else if (MODULE_LEVEL_KINDS.has(kind)) {
    delta -= MODULE_LEVEL_PENALTY;
    penalties.push(`module-level(${kind}) -${MODULE_LEVEL_PENALTY}`);
  } else if (kind !== SymbolKind.Class && kind !== SymbolKind.Interface && kind !== SymbolKind.TypeAlias) {
    // Non-code kinds (e.g. markdown_section). Classes are intentionally neutral —
    // a class can still be the right edit target.
    delta -= NON_CODE_PENALTY;
    penalties.push(`non-code(${kind}) -${NON_CODE_PENALTY}`);
  }

  // 4. Broad-snippet / noise penalty — only for weakly-supported candidates, so a
  // large but strongly/multiply-supported snippet is NOT penalised.
  const isBroadKind = kind === SymbolKind.Class || MODULE_LEVEL_KINDS.has(kind);
  const isLargeSnippet = snippetTokens >= LARGE_SNIPPET_TOKENS;
  if (weakSupport && (isLargeSnippet || isBroadKind)) {
    delta -= BROAD_SNIPPET_PENALTY;
    const why = isLargeSnippet ? `large-snippet(${snippetTokens}t)` : `broad-${kind}`;
    penalties.push(`broad+weak ${why} -${BROAD_SNIPPET_PENALTY}`);
  }

  // 5. Implementation-path preference.
  if (input.isNonSourceExample === true || isNonImplPath(input.path)) {
    delta -= NON_IMPL_PATH_PENALTY;
    penalties.push(`non-impl-path -${NON_IMPL_PATH_PENALTY}`);
  }

  const score = round(base + delta);
  const reason =
    `base ${round(base)}` +
    (signals.length > 0 ? `; +[${signals.join(", ")}]` : "") +
    (penalties.length > 0 ? `; -[${penalties.join(", ")}]` : "") +
    ` => ${score}`;

  return { version: "v2", score, signals, penalties, reason };
}

// Legacy ranking: ordering is the raw weighted `final`, with no boosts/penalties.
// Kept for benchmark/test comparison against v2.
export function scorePivotLegacy(input: PivotRankInput): PivotRankResult {
  const score = round(input.scorecard.final);
  return { version: "legacy", score, signals: [], penalties: [], reason: `legacy final ${score}` };
}

export function scorePivot(input: PivotRankInput, version: PivotRankingVersion): PivotRankResult {
  return version === "v2" ? scorePivotV2(input) : scorePivotLegacy(input);
}

// Stable comparator (descending score). Caller supplies deterministic tiebreaks.
export function comparePivotScoreDesc(a: PivotRankResult, b: PivotRankResult): number {
  return b.score - a.score;
}
