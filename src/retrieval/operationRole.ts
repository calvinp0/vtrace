// What RELATION does a candidate have to the operation the request asked about?
//
// Mechanism evidence answers "does this definition perform the requested
// operation?" and stops there. That is enough when the definition that performs
// it also names the subject, and it is not enough when it does not:
//
//   "What determines the precedence/order when multiple reaction families match?"
//
//   determine_family    lexical 0.86  domain 1.00  mechanism 0     final 1.7639
//   get_all_families    lexical 0.20  domain 0.33  mechanism 0.55  final 1.0549
//
// `get_all_families` establishes the order. `determine_family` consumes that
// order to pick a winner — it carries no ordering fact at all, and leads purely
// because it names the subject better. Four independent signals measure the
// SUBJECT and one measures the OPERATION, so on a question that is entirely
// about the operation, the subject still decides.
//
// The fix cannot be a bigger mechanism weight, and that is measured rather than
// assumed. Closing ARC's gap needs +0.71; closing the same gap on the generic
// `rule_candidate_selector` fixture needs +1.83. A constant that large stops
// being evidence and becomes an override — it would outrank every other signal
// in the scorecard on every behavioural query (§6, §36).
//
// So this lane adds no magnitude. It adds the one thing the scorecard cannot
// express: a RELATION between two candidates. When a definition's own mechanism
// operand was produced by another definition that directly implements what was
// asked, the producer is the answer and the consumer is the context — whichever
// of them happens to be better named. That relation is read from indexed
// evidence only (recorded operand provenance, exact `calls` edges), the same
// bounded causal walk `mechanismSupport` uses, so it inherits that module's
// "exact relations only" discipline rather than restating it.
//
// The rule is symmetric by construction, which is the whole acceptance test: ask
// which plugin WINS and `beta` is the direct implementer while `alpha` is merely
// its prerequisite, so nothing is promoted. The emphasis follows the requested
// operation, never a fact kind (§8).

import type { Database } from "bun:sqlite";

import type { SymbolId } from "../domain/types";
import type { MechanismFact } from "../indexer/extractMechanismFacts";
import type { BehavioralOperation } from "./behavioralObjective";
import { isDirectImplementer, type MechanismEvidence } from "./mechanismEvidence";
import { exactCallees, resolveByName } from "./mechanismSupport";

/**
 * How a candidate stands to the operation the request asked about.
 *
 * `prerequisite` is deliberately distinct from `consumer` (§15): on a selection
 * query the orderer is a prerequisite and must NOT be promoted, while on an
 * ordering query the same definition is the direct implementer. Collapsing the
 * two would make the emphasis depend on the fact kind instead of the question.
 */
export type OperationRole =
  /** Performs the requested operation: carries a direct, proven, aligned fact. */
  | "direct_implementer"
  /** Consumes the result of a pooled direct implementer of that operation. */
  | "consumer"
  /** Neither; the candidate's relation to the operation is not established. */
  | "unrelated";

export interface OperationRoleAssignment {
  readonly symbolId: SymbolId;
  readonly role: OperationRole;
  /** For a consumer: the pooled direct implementer whose result it consumes. */
  readonly producerSymbolId?: SymbolId;
  readonly producerFqName?: string;
  /** Hops from the consumer to that producer: 1 provenance, 2 provenance+call. */
  readonly depth?: number;
  readonly reason: string;
}

/** A candidate whose rank the answer-role relation corrected. */
export interface OperationPromotion {
  readonly symbolId: SymbolId;
  readonly fqName: string;
  /** The score retrieval computed on its own evidence. Never overwritten. */
  readonly organicFinal: number;
  readonly promotedFinal: number;
  readonly aboveFqName: string;
  readonly depth: number;
  readonly reason: string;
}

export interface OperationRoleDiagnostics {
  readonly active: boolean;
  readonly reason: string;
  readonly operation: BehavioralOperation | null;
  readonly directImplementers: readonly string[];
  readonly consumers: readonly string[];
  readonly candidatesClassified: number;
  readonly relationsInspected: number;
  readonly promotions: readonly OperationPromotion[];
  readonly sourceReads: number;
  readonly elapsedMs: number;
}

export interface OperationRoleResult {
  readonly roles: ReadonlyMap<SymbolId, OperationRoleAssignment>;
  /** symbolId -> the final score the answer-role relation requires. */
  readonly promotedFinals: ReadonlyMap<SymbolId, number>;
  readonly diagnostics: OperationRoleDiagnostics;
}

/** Hard bounds, matching `mechanismSupport`. Every one is reported (§55). */
export const OPERATION_ROLE_LIMITS = Object.freeze({
  /** Consumers whose provenance chain is walked. */
  maxConsumersExamined: 24,
  /** Causal hops from a consumer to its producer. */
  maxDepth: 2,
  /** Definitions inspected per hop. */
  maxPerHop: 4,
});

/**
 * The smallest representable score step.
 *
 * This is a TIE-BREAK, not a calibrated weight, and the distinction matters:
 * nothing about how much better the answer is got decided here. The promoted
 * candidate is placed immediately above the consumer that established the
 * relation and nowhere higher, so the correction is the minimum that can express
 * "this one first" (§56).
 */
const RANK_EPSILON = 1e-4;

export function inactiveOperationRoles(reason: string): OperationRoleResult {
  return {
    roles: new Map(),
    promotedFinals: new Map(),
    diagnostics: {
      active: false,
      reason,
      operation: null,
      directImplementers: [],
      consumers: [],
      candidatesClassified: 0,
      relationsInspected: 0,
      promotions: [],
      sourceReads: 0,
      elapsedMs: 0,
    },
  };
}

/** The pooled candidate shape this lane needs. Deliberately minimal. */
export interface RoleCandidate {
  readonly symbolId: SymbolId;
  readonly fqName: string;
  readonly final: number;
}

export interface OperationRoleInput {
  readonly db: Database;
  readonly operation: BehavioralOperation;
  /** Every scored candidate, in any order. */
  readonly candidates: readonly RoleCandidate[];
  /** Mechanism evidence already computed for the pool, by symbol. */
  readonly evidenceById: ReadonlyMap<SymbolId, MechanismEvidence>;
  /** Indexed facts for the pool, by symbol — the consumer's own provenance. */
  readonly factsById: ReadonlyMap<SymbolId, readonly MechanismFact[]>;
}

/**
 * Classify the pool against the requested operation and correct the order.
 *
 * Zero source reads: provenance is recorded on the fact and `calls` edges are
 * already in the graph, so the walk is index lookups only.
 */
export function resolveOperationRoles(input: OperationRoleInput): OperationRoleResult {
  const started = performance.now();
  const roles = new Map<SymbolId, OperationRoleAssignment>();
  const promotedFinals = new Map<SymbolId, number>();

  // Only a pooled direct implementer can be promoted. A producer that retrieval
  // never generated is a discovery problem, and `mechanismSupport` is the lane
  // that owns it — inventing a candidate here would duplicate it badly.
  const implementers = new Map<SymbolId, RoleCandidate>();
  for (const candidate of input.candidates) {
    const evidence = input.evidenceById.get(candidate.symbolId);
    if (evidence !== undefined && isDirectImplementer(evidence)) {
      implementers.set(candidate.symbolId, candidate);
      roles.set(candidate.symbolId, {
        symbolId: candidate.symbolId,
        role: "direct_implementer",
        reason: `directly implements the requested ${input.operation}`,
      });
    }
  }
  if (implementers.size === 0) {
    return {
      ...inactiveOperationRoles("no pooled candidate directly implements the requested operation"),
      roles,
    };
  }

  const byId = new Map(input.candidates.map((entry) => [entry.symbolId, entry]));
  let relationsInspected = 0;
  let consumersExamined = 0;
  const promotions: OperationPromotion[] = [];
  const consumers: string[] = [];

  // Every causal link is discovered from the CONSUMING side, because that is the
  // side the operand provenance is recorded on. Which side gets promoted then
  // depends only on which of the two implements what was asked — never on the
  // direction of the call, and never on the fact kind. That is what makes the
  // paired queries reverse: `beta` consumes `alpha` on both of them, and the
  // promotion swaps because the requested operation did (§15, §25).
  for (const candidate of input.candidates) {
    if (consumersExamined >= OPERATION_ROLE_LIMITS.maxConsumersExamined) break;
    // A consumer is identified by what its OWN mechanism acted on. Without a
    // fact there is no operand, and without an operand there is no evidence
    // that this definition consumes anything in particular — a plain caller is
    // not a consumer (§14).
    const facts = input.factsById.get(candidate.symbolId) ?? [];
    const provenances = facts
      .filter((fact) => fact.resultBearing)
      .flatMap(producerNamesOf);
    if (provenances.length === 0) continue;
    consumersExamined += 1;

    const found = findLinked(input.db, provenances, byId);
    relationsInspected += found.inspected;
    if (found.linked.length === 0) continue;

    const consumerIsImplementer = implementers.has(candidate.symbolId);
    // Which linked definition matters depends on which side implements the
    // request. A consumer looks for the implementer it consumes from; an
    // implementer looks for the prerequisite it consumes. Taking merely the
    // NEAREST linked definition would have stopped at `get_reaction_family` on
    // the ARC ordering query and never reached the orderer one call beyond it.
    const partner = consumerIsImplementer
      ? found.linked.find((entry) => !implementers.has(entry.candidate.symbolId))
      : found.linked.find((entry) => implementers.has(entry.candidate.symbolId));
    if (partner === undefined) continue;

    const [winner, loser, loserRole] = consumerIsImplementer
      ? [candidate, partner.candidate, "prerequisite" as const]
      : [partner.candidate, candidate, "consumer" as const];
    const depth = partner.depth;

    consumers.push(loser.fqName);
    roles.set(loser.symbolId, {
      symbolId: loser.symbolId,
      role: "consumer",
      producerSymbolId: winner.symbolId,
      producerFqName: winner.fqName,
      depth,
      reason: loserRole === "consumer"
        ? `consumes the ${input.operation} established by ${leafName(winner.fqName)}`
        : `produces the value ${leafName(winner.fqName)} performs the ${input.operation} on`,
    });

    // The correction. The implementer is placed immediately above the definition
    // it is causally linked to and no higher; its own score is left exactly as
    // retrieval computed it, and the other side loses nothing (§9, §38).
    const required = round(loser.final + RANK_EPSILON);
    const current = promotedFinals.get(winner.symbolId) ?? winner.final;
    if (required <= current) continue;
    promotedFinals.set(winner.symbolId, required);
    promotions.push({
      symbolId: winner.symbolId,
      fqName: winner.fqName,
      organicFinal: winner.final,
      promotedFinal: required,
      aboveFqName: loser.fqName,
      depth,
      reason: loserRole === "consumer"
        ? `directly implements the requested ${input.operation}, which `
          + `${leafName(loser.fqName)} consumes`
        : `directly implements the requested ${input.operation} on the value `
          + `${leafName(loser.fqName)} produces`,
    });
  }

  return {
    roles,
    promotedFinals,
    diagnostics: {
      active: true,
      reason: promotions.length > 0
        ? `${promotions.length} answer-role correction(s) applied`
        : "no consumer of a pooled direct implementer outranked it",
      operation: input.operation,
      directImplementers: [...implementers.values()].map((entry) => entry.fqName).sort(),
      consumers: consumers.sort(),
      candidatesClassified: input.candidates.length,
      relationsInspected,
      promotions,
      sourceReads: 0,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    },
  };
}

/**
 * Walk from a consumer's recorded operand provenance to a pooled implementer.
 *
 * Hop 1 is the call that produced the operand. Hop 2 follows that producer's
 * exact `calls` edges, because ARC's ordering sits exactly one call beyond the
 * producer: `determine_family` acts on what `get_reaction_family` returned, and
 * `get_all_families` is what THAT called.
 */
function findLinked(
  db: Database,
  provenances: readonly string[],
  byId: ReadonlyMap<SymbolId, RoleCandidate>,
): { linked: { candidate: RoleCandidate; depth: number }[]; inspected: number } {
  let inspected = 0;
  const seen = new Set<SymbolId>();
  const hopOne: SymbolId[] = [];
  const linked: { candidate: RoleCandidate; depth: number }[] = [];

  for (const provenance of provenances) {
    for (const symbol of resolveByName(db, provenance).slice(0, OPERATION_ROLE_LIMITS.maxPerHop)) {
      if (seen.has(symbol.id)) continue;
      seen.add(symbol.id);
      inspected += 1;
      const pooled = byId.get(symbol.id);
      if (pooled !== undefined) linked.push({ candidate: pooled, depth: 1 });
      hopOne.push(symbol.id);
    }
  }
  if (OPERATION_ROLE_LIMITS.maxDepth < 2) return { linked, inspected };

  // Hop 2: the immediate producer is not always the definition in contention —
  // ARC's orderer sits exactly one exact call beyond `get_reaction_family`.
  for (const producerId of hopOne) {
    for (const callee of exactCallees(db, producerId).slice(0, OPERATION_ROLE_LIMITS.maxPerHop)) {
      if (seen.has(callee.id)) continue;
      seen.add(callee.id);
      inspected += 1;
      const pooled = byId.get(callee.id);
      if (pooled !== undefined) linked.push({ candidate: pooled, depth: 2 });
    }
  }
  return { linked, inspected };
}

/**
 * The names that could have produced what this fact acted on.
 *
 * `provenance` is the recorded producing call and is used first. It is empty for
 * the loop kinds, which record the iterated expression as the SUBJECT instead —
 * `for backend in ordered_backends(config)` stores `ordered_backends(config)`.
 * Reading the callee out of a recorded call expression is still exact indexed
 * evidence; it is the same call, written down in the other column (§14).
 */
function producerNamesOf(fact: MechanismFact): string[] {
  const names: string[] = [];
  if (fact.provenance.length > 0) names.push(fact.provenance);
  const call = /^([A-Za-z_][\w.]*)\s*\(/u.exec(fact.subject);
  if (call !== null) names.push(call[1]!);
  return names;
}

function leafName(fqName: string): string {
  return fqName.split("::").at(-1) ?? fqName;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
