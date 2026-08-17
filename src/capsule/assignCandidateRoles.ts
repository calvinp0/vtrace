// Pivot / support / discard role assignment.
//
// Ranking answers "how relevant is this candidate, numerically?". It does NOT
// answer the categorical question a capsule actually needs: is this candidate an
// EDIT TARGET (a pivot — show full/focused source), supporting CONTEXT (a
// support — show signature/skeleton only), or noise (discard)? This module turns
// a ranked, fully-scored candidate list into that decision, transparently and
// from the scorecard alone — no per-instance lookup, no hardcoded files.
//
// The policy encodes Requirement 2/3 directly:
//   * a pivot needs STRONG, DIRECT local evidence (the failing test reaches it, a
//     symbol-name match, a likely-file match, or a strong lexical hit) AND an
//     actionable symbol kind (function/method/class — not a module variable);
//   * centrality is weak: a candidate that wins on graph reach / in-degree ALONE
//     is support at most, never a pivot;
//   * a generic high-degree framework root (django's `Model`) is support at most;
//   * a candidate with no local evidence cannot be a micro pivot;
//   * tests, and candidates with no relevance signal at all, are discarded.

import { isLikelyTestCandidate } from "../retrieval/searchSymbolsShared";
import type { HybridCandidate } from "../retrieval/hybridRetrieval";
import {
  HUB_IN_DEGREE_THRESHOLD,
  STRONG_DIRECT_LEXICAL,
} from "../retrieval/hybridScoring";
import { DIRECT_MECHANISM_EVIDENCE } from "../retrieval/mechanismEvidence";

export enum CandidateRole {
  /** A likely implementation/edit target. Rendered as full/focused source. */
  Pivot = "pivot",
  /** Related context useful for understanding. Rendered as signature/skeleton. */
  Support = "support",
  /** Not relevant enough to spend capsule budget on. */
  Discard = "discard",
}

export interface RoledCandidate {
  candidate: HybridCandidate;
  role: CandidateRole;
  /** Human-readable justification for the role — the report's "why a pivot". */
  why: string;
  /**
   * This candidate CLEARED the pivot bar and is support only because the pivot
   * budget was already full. Recorded structurally because it is not a judgement
   * about the candidate: if a slot is later vacated, this candidate is still a
   * legitimate occupant of it.
   */
  budgetDemotedPivot?: boolean;
}

export interface AssignRolesOptions {
  /**
   * Marks micro-mode selection. The classification BAR is identical across modes
   * (a pivot always needs actionable kind + strong direct evidence + no hub);
   * micro's extra strictness is expressed by the caller as `maxPivots: 1` plus a
   * skip-on-empty policy, not by a different threshold. Kept for call-site intent.
   */
  micro?: boolean;
  /** Cap on pivots; extras (lower-ranked) demote to support. Default: no cap. */
  maxPivots?: number;
}

// Minimum combined local evidence for a pivot. Local evidence is the sum of the
// normalised signals that tie a candidate to THIS task (lexical floor + symbol +
// path + domain + test-to-impl); a real edit target clears this comfortably.
const PIVOT_LOCAL_EVIDENCE_MIN = 0.3;

// Assign a role to every candidate, preserving the input (final-score) order.
export function assignCandidateRoles(
  candidates: readonly HybridCandidate[],
  options: AssignRolesOptions = {},
): RoledCandidate[] {
  const maxPivots = options.maxPivots ?? Number.POSITIVE_INFINITY;

  let pivotsSoFar = 0;
  // Answer-role authority is granted to ONE candidate: the highest-ranked direct
  // implementer of the requested operation. The point of this phase is that the
  // answer retrieval already chose survives into delivery — not that every
  // definition performing the operation becomes an edit target. Measured on the
  // mechanism corpus, the unbounded form let `mixed.py::first_backend` take the
  // lead on a question about a different module's indirect choice, because it too
  // ends in `backends[0]`: operand alignment is enough to SCORE a candidate and
  // not enough to make it the answer when something else outranks it (§12, §57).
  //
  // Candidates arrive in final-score order, so "first seen" is "best ranked", and
  // the relational ordering that placed the implementer above its consumer has
  // already been applied. At most one pivot is ever added this way.
  let answerRoleGranted = false;
  return candidates.map((candidate) => {
    const isAnswerRole = hasAnswerRoleEvidence(candidate) && !answerRoleGranted;
    if (isAnswerRole) answerRoleGranted = true;
    let { role, why } = classify(candidate, isAnswerRole);
    // Enforce the pivot cap (micro emits a single pivot): a would-be pivot beyond
    // the cap is still strong context, so it demotes to support rather than away.
    let budgetDemotedPivot = false;
    if (role === CandidateRole.Pivot) {
      if (pivotsSoFar >= maxPivots) {
        role = CandidateRole.Support;
        why = `support: strong target but beyond the pivot budget — ${why}`;
        budgetDemotedPivot = true;
      } else {
        pivotsSoFar += 1;
      }
    }
    return { candidate, role, why, ...(budgetDemotedPivot ? { budgetDemotedPivot } : {}) };
  });
}

// Two pivots are "close" when the runner-up's final score is at least this
// fraction of the leader's: close enough that a single-pivot (micro) capsule
// cannot decisively pick one over the other.
export const PIVOT_AMBIGUITY_RATIO = 0.85;

// True when two or more candidates independently clear the pivot bar with
// comparable final scores (Requirement 2): the capsule cannot point at ONE
// decisive edit target, so the caller should widen the mode or skip rather than
// render two equally-likely micro targets. Run this on the UNCAPPED roles (no
// `maxPivots`), so a runner-up demoted purely by the single-pivot cap still
// counts toward ambiguity.
export function detectPivotAmbiguity(uncappedRoled: readonly RoledCandidate[]): boolean {
  const pivotScores = uncappedRoled
    .filter((entry) => entry.role === CandidateRole.Pivot)
    .map((entry) => entry.candidate.scores.final)
    .sort((a, b) => b - a);
  if (pivotScores.length < 2) {
    return false;
  }
  const [top, second] = pivotScores;
  if (top === undefined || second === undefined || top <= 0) {
    return false;
  }
  return second / top >= PIVOT_AMBIGUITY_RATIO;
}

// Convenience: the pivots, in rank order.
export function pivotsOf(roled: readonly RoledCandidate[]): HybridCandidate[] {
  return roled.filter((r) => r.role === CandidateRole.Pivot).map((r) => r.candidate);
}

// Convenience: the support candidates, in rank order.
export function supportOf(roled: readonly RoledCandidate[]): HybridCandidate[] {
  return roled.filter((r) => r.role === CandidateRole.Support).map((r) => r.candidate);
}

/**
 * Does this candidate perform the requested operation, proven against its own
 * operand? The direct tier is the outcome of every proof `mechanismEvidence`
 * applies, so a partial fact — a consumer, a prerequisite — never reaches it.
 */
export function hasAnswerRoleEvidence(candidate: HybridCandidate): boolean {
  return (candidate.scores.mechanismEvidence ?? 0) >= DIRECT_MECHANISM_EVIDENCE;
}

function classify(
  candidate: HybridCandidate,
  answerRole: boolean,
): { role: CandidateRole; why: string } {
  const s = candidate.scores;

  // A test is never an edit target — the implementation it exercises is.
  if (isLikelyTestCandidate(candidate)) {
    return { role: CandidateRole.Discard, why: "discard: a test symbol, not an edit target" };
  }

  // DIRECT edit-target evidence: a concrete pointer at this exact symbol, as
  // opposed to soft graph reach, centrality, or issue-domain flavour.
  const concretePointer = s.symbol > 0 || s.path > 0 || s.testToImpl > 0;
  // M150: this definition PERFORMS the operation the request asked about, on the
  // value the request named. Every signal above answers "is the request about
  // this code?" by looking at its NAME and its PATH, and a behavioural question
  // is frequently answered by a definition that matches neither — `get_all_families`
  // establishes ARC's family ordering with lexical 0.05, and `alpha` sorts the
  // plugins with lexical 0. Ranking already places both first; without this the
  // role layer discards one and demotes the other to a signature, so the product
  // forgets an answer retrieval had already found.
  //
  // It is direct evidence in the same sense the others are — a claim about THIS
  // symbol, not its neighbourhood — and it is not cheap to obtain: the direct
  // tier requires a compatible fact that produces the definition's result and
  // whose operand names the subject, which is the same proof that refused all 64
  // Gaussian owners. A partial fact never reaches it, so a consumer or a
  // prerequisite of the requested operation cannot qualify here (§13).
  const directEvidence = concretePointer || s.lexical >= STRONG_DIRECT_LEXICAL || answerRole;
  const anyProximity = s.graph > 0 || s.domain > 0;
  const isGenericHub = s.inDegree >= HUB_IN_DEGREE_THRESHOLD && !directEvidence;

  // M153-C5: proven direct implementation is a tie to the task, whether or not
  // this candidate is the one that got the grant.
  //
  // `answerRole` above is the GRANT — deliberately awarded to one candidate so a
  // mechanism cannot mint edit targets (§12, §57). `provenImplementer` is the
  // EVIDENCE, which every direct-tier candidate carries. The discard gate below
  // was reading the grant, so the second and third proven implementers of the
  // requested operation were discarded under the reason "no relevance to the
  // task" — a reason that is simply false about them.
  //
  // Measured on the frozen corpus: sphinx holds three subject-aligned direct
  // implementers of the requested selection over `source_suffix`
  // (`Project.path2doc`, `get_rst_suffix`, `get_filetype`). The grant went to
  // whichever of them ordinary lexical ranking happened to place first, and the
  // other two — including the one the request was about — were erased. The M150
  // fixture never exposed this because it contains exactly ONE eligible
  // candidate, so its grant is unopposed and correct by default.
  //
  // This changes the DISCARD boundary only. It does not touch the grant, the
  // pivot bar or `directEvidence`, so the number of candidates that can become
  // an edit target this way is still exactly one; the rest become support, which
  // is what proven-but-not-selected evidence is (§21, §30).
  const provenImplementer = hasAnswerRoleEvidence(candidate);

  // Nothing ties it to the task except (at most) centrality / graph reach.
  if (s.localEvidence <= 0 && !anyProximity && !answerRole && !provenImplementer) {
    return {
      role: CandidateRole.Discard,
      why: isGenericHub
        ? `discard: generic framework hub (${s.inDegree} dependents) with no task relevance — centrality cannot win alone`
        : "discard: no lexical/symbol/path/test/graph relevance to the task",
    };
  }

  // A penalised generic hub with nothing else useful is noise, not context.
  if (s.hubPenalty > 0 && !anyProximity) {
    return {
      role: CandidateRole.Discard,
      why: `discard: down-ranked framework hub (${s.inDegree} dependents) lacking local evidence`,
    };
  }

  const reasons = describeSignals(candidate);

  // A pivot needs an ACTIONABLE kind, STRONG DIRECT evidence (a concrete
  // failing-test/symbol/path pointer OR a strong lexical hit — never graph,
  // domain, or centrality alone), enough total local evidence, and it must not
  // be a (penalised) generic framework hub. Micro applies the same bar; its
  // extra strictness is the single-pivot cap and the skip-on-empty policy, so a
  // strong lexical edit target the shaping never promoted to a likely-symbol can
  // still anchor a micro capsule rather than forcing a needless skip.
  // `localEvidence` and the hub penalty are both computed from name/path/domain
  // signals, so they restate the same blind spot in two more currencies: ARC's
  // orderer carries a 0.0116 hub penalty for having seven callers and a dull
  // name. Answer-role evidence satisfies what they are actually asking — that
  // the candidate be tied to the task by something about ITSELF rather than by
  // its centrality — so it is admitted in each, and nowhere else.
  const meetsPivotBar =
    s.actionability === 1
    && directEvidence
    && (s.localEvidence >= PIVOT_LOCAL_EVIDENCE_MIN || answerRole)
    && (s.hubPenalty === 0 || answerRole)
    && !isGenericHub;

  if (meetsPivotBar) {
    return {
      role: CandidateRole.Pivot,
      why: `pivot: actionable ${candidate.kind} — ${reasons.join("; ")}`,
    };
  }

  // Why it is support and NOT a pivot — the most useful single reason.
  const blocker = pivotBlocker(candidate, { directEvidence, isGenericHub });
  return {
    role: CandidateRole.Support,
    why: `support: ${reasons.join("; ") || "related context"}${blocker ? ` (not a pivot: ${blocker})` : ""}`,
  };
}

// The single most informative reason a near-miss is support rather than a pivot.
function pivotBlocker(
  candidate: HybridCandidate,
  flags: { directEvidence: boolean; isGenericHub: boolean },
): string | undefined {
  const s = candidate.scores;
  if (s.actionability !== 1) {
    return `${candidate.kind} is a low-actionability edit target`;
  }
  if (flags.isGenericHub || s.hubPenalty > 0) {
    return `high-degree framework root — support at most`;
  }
  if (!flags.directEvidence) {
    return "no direct evidence (graph/domain reach only)";
  }
  if (s.localEvidence < PIVOT_LOCAL_EVIDENCE_MIN) {
    return "local evidence below the pivot bar";
  }
  return undefined;
}

// Render the positive signals behind a candidate as short, ordered phrases — the
// raw material for the capsule's "why" lines.
function describeSignals(candidate: HybridCandidate): string[] {
  const s = candidate.scores;
  const reasons: string[] = [];
  if (s.testToImpl > 0) {
    reasons.push("exercised by a failing test");
  }
  if (s.symbol > 0) {
    reasons.push("symbol-name match");
  }
  if (s.path > 0) {
    reasons.push("in a likely edit file");
  }
  if (s.lexical >= STRONG_DIRECT_LEXICAL) {
    reasons.push("strong lexical match");
  } else if (s.lexical > 0) {
    reasons.push("lexical match");
  }
  if (s.domain > 0) {
    reasons.push("issue-domain relevance");
  }
  if (s.graph > 0) {
    reasons.push("graph/import neighbour");
  }
  if (s.hubPenalty === 0 && s.inDegree >= HUB_IN_DEGREE_THRESHOLD) {
    reasons.push(`${s.inDegree} dependents`);
  }
  return reasons;
}
