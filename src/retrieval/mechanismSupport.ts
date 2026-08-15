// Bounded causal discovery of the evidence that EXPLAINS a decision.
//
// Ranking found the decider. `determine_family` leads the ARC family query and
// `product_dicts[0]` is visible, so VTRACE can say "the first element is
// selected". It cannot yet say why the first element is the winner, because the
// code that establishes the order lives in a different definition that ordinary
// retrieval never generates at all — measured, not assumed: `get_all_families`
// is `not_generated`, not ranked-and-dropped.
//
// So this is a DISCOVERY problem, and the fix must not be a scoring one. The
// helper's ordinary score and rank stay exactly as retrieval computed them; it
// enters through a bounded role instead, the same discipline M140-C used for
// `orchestration_support`.
//
// The traversal is the measured causal chain and nothing wider:
//
//     selected decision candidate
//         -> its mechanism fact's operand provenance      (hop 1)
//         -> that producer's exact `calls` edges          (hop 2)
//         -> a helper whose RETURNED value is ordered
//
// Two hops because two is what ARC needs and one is what the generic corpus
// needs; neither number is a guess. Only exact relations participate: the
// operand provenance recorded at index time, and exact `calls` edges. Path
// similarity, shared files, shared classes, centrality and potential callers are
// all excluded — they are not causal evidence, and admitting them would rebuild
// the relevance-creation loophole M142 closed (§13).

import type { Database } from "bun:sqlite";

import { listSymbolsByLocalName, listSymbolsByFqName } from "../db/repositories/symbolsRepository";
import { loadMechanismFactsFor } from "../db/repositories/mechanismFactsRepository";
import type { MechanismFact, MechanismFactKind } from "../indexer/extractMechanismFacts";
import type { SymbolId, SymbolRecord } from "../domain/types";
import type { BehavioralOperation } from "./behavioralObjective";

/**
 * Facts that establish the preference relation a selection consumes.
 *
 * `first_success_return` is here because iteration order IS the preference when
 * the first acceptable candidate wins. `cache_lookup` and `attribute_return`
 * never are — a cache says a value was reused, not which value was preferred.
 */
const ORDERING_FACT_KINDS: ReadonlySet<MechanismFactKind> = new Set<MechanismFactKind>([
  "ordering_established",
  "priority_lookup",
  "sort_then_first",
  "first_success_return",
]);

/** Operations whose answer can require an upstream ordering explanation. */
const OPERATIONS_NEEDING_ORDER: ReadonlySet<BehavioralOperation> = new Set<BehavioralOperation>([
  "selection",
  "ordering",
]);

/** Hard bounds. Every one is reported, so "bounded" is checkable (§16, §58). */
export const MECHANISM_SUPPORT_LIMITS = Object.freeze({
  /** Selected decision candidates used as seeds. */
  maxSeeds: 3,
  /** Causal hops from the seed. Two is the measured ARC chain. */
  maxDepth: 2,
  /** Helper definitions whose facts may be inspected. */
  maxHelpersExamined: 24,
  /** Helpers admitted into the capsule. */
  maxSelected: 1,
});

export interface MechanismSupportSeed {
  readonly symbolId: SymbolId;
  readonly fqName: string;
  /** The operand provenance recorded on the seed's compatible mechanism fact. */
  readonly provenance: string;
}

export interface MechanismSupportCandidate {
  readonly symbol: SymbolRecord;
  /** `seed -> producer -> helper`, by fq name. */
  readonly path: readonly string[];
  readonly depth: number;
  /** The relation at each hop, so "exact evidence only" is auditable. */
  readonly relations: readonly ("operand_provenance" | "exact_call")[];
  readonly fact: MechanismFact;
  readonly reason: string;
}

export interface MechanismSupportDiagnostics {
  readonly active: boolean;
  readonly reason: string;
  readonly seeds: readonly string[];
  readonly causalEdgesExamined: number;
  readonly maxCausalDepthReached: number;
  readonly helpersExamined: number;
  readonly candidatesEligible: number;
  readonly candidatesSelected: number;
  readonly sourceReads: number;
  readonly elapsedMs: number;
}

export interface MechanismSupportResult {
  readonly candidates: readonly MechanismSupportCandidate[];
  readonly diagnostics: MechanismSupportDiagnostics;
}

export function inactiveMechanismSupport(reason: string): MechanismSupportResult {
  return {
    candidates: [],
    diagnostics: {
      active: false,
      reason,
      seeds: [],
      causalEdgesExamined: 0,
      maxCausalDepthReached: 0,
      helpersExamined: 0,
      candidatesEligible: 0,
      candidatesSelected: 0,
      sourceReads: 0,
      elapsedMs: 0,
    },
  };
}

export interface MechanismSupportInput {
  readonly db: Database;
  readonly operation: BehavioralOperation;
  /** Already-selected, answer-bearing candidates carrying mechanism evidence. */
  readonly seeds: readonly MechanismSupportSeed[];
  /** Symbols already delivered, so support never duplicates one. */
  readonly deliveredSymbolIds: ReadonlySet<string>;
}

/**
 * Find at most one helper that establishes the ordering a decision consumes.
 *
 * Zero source reads: every step reads indexed evidence — the provenance recorded
 * on the fact, the `calls` edges already in the graph, and the facts of the
 * symbols reached (§57).
 */
export function discoverMechanismSupport(input: MechanismSupportInput): MechanismSupportResult {
  const started = performance.now();
  if (!OPERATIONS_NEEDING_ORDER.has(input.operation)) {
    return inactiveMechanismSupport(`operation ${input.operation} needs no ordering explanation`);
  }
  const seeds = input.seeds.slice(0, MECHANISM_SUPPORT_LIMITS.maxSeeds);
  if (seeds.length === 0) {
    return inactiveMechanismSupport("no selected candidate carries mechanism evidence");
  }

  let causalEdgesExamined = 0;
  let helpersExamined = 0;
  let maxDepthReached = 0;
  const eligible: MechanismSupportCandidate[] = [];
  const visited = new Set<string>();

  for (const seed of seeds) {
    if (seed.provenance.length === 0) continue;
    // Hop 1: the call that produced the operand the decision acted on. This is
    // recorded on the fact itself, so resolving it is a name lookup rather than
    // a traversal.
    const producers = resolveByName(input.db, seed.provenance);
    causalEdgesExamined += producers.length;
    for (const producer of producers) {
      if (helpersExamined >= MECHANISM_SUPPORT_LIMITS.maxHelpersExamined) break;
      if (visited.has(producer.id)) continue;
      visited.add(producer.id);
      helpersExamined += 1;
      maxDepthReached = Math.max(maxDepthReached, 1);

      const producerFact = orderingFactOf(input.db, producer.id);
      if (producerFact !== undefined) {
        eligible.push({
          symbol: producer,
          path: [seed.fqName, producer.fqName],
          depth: 1,
          relations: ["operand_provenance"],
          fact: producerFact,
          reason: `produces the value the decision selects from, and ${orderingPhrase(producerFact)}`,
        });
        continue;
      }
      // Hop 2: the producer did not establish the order itself. Follow its EXACT
      // outgoing calls — ARC's ordering lives exactly here, one call beyond the
      // producer, and stopping at hop 1 would miss every real case.
      if (MECHANISM_SUPPORT_LIMITS.maxDepth < 2) continue;
      const callees = exactCallees(input.db, producer.id);
      causalEdgesExamined += callees.length;
      for (const callee of callees) {
        if (helpersExamined >= MECHANISM_SUPPORT_LIMITS.maxHelpersExamined) break;
        if (visited.has(callee.id)) continue;
        visited.add(callee.id);
        helpersExamined += 1;
        maxDepthReached = Math.max(maxDepthReached, 2);
        const fact = orderingFactOf(input.db, callee.id);
        if (fact === undefined) continue;
        eligible.push({
          symbol: callee,
          path: [seed.fqName, producer.fqName, callee.fqName],
          depth: 2,
          relations: ["operand_provenance", "exact_call"],
          fact,
          reason: `reached through ${producer.localName}, and ${orderingPhrase(fact)}`,
        });
      }
    }
  }

  // Nearest coherent explanation first, then deterministically by name.
  const ordered = eligible
    .filter((candidate) => !input.deliveredSymbolIds.has(candidate.symbol.id))
    .sort((left, right) => left.depth - right.depth
      || left.symbol.fqName.localeCompare(right.symbol.fqName));
  const selected = ordered.slice(0, MECHANISM_SUPPORT_LIMITS.maxSelected);

  return {
    candidates: selected,
    diagnostics: {
      active: true,
      reason: selected.length > 0
        ? `selected ${selected.length} ordering helper at depth ${selected[0]!.depth}`
        : "no helper on the causal chain establishes an ordering the decision consumes",
      seeds: seeds.map((seed) => seed.fqName),
      causalEdgesExamined,
      maxCausalDepthReached: maxDepthReached,
      helpersExamined,
      candidatesEligible: ordered.length,
      candidatesSelected: selected.length,
      sourceReads: 0,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    },
  };
}

/**
 * The ordering fact a helper carries, if it carries one that the decision can
 * actually consume.
 *
 * `resultBearing` is required and is the whole negative control: a helper that
 * sorts something and RETURNS it establishes the order its caller sees, while a
 * helper that sorts a list to log it and returns something else does not. Both
 * contain `sorted(...)`; only the first explains a winner (§18).
 */
function orderingFactOf(db: Database, symbolId: SymbolId): MechanismFact | undefined {
  const facts = loadMechanismFactsFor(db, [symbolId]).get(symbolId) ?? [];
  return facts.find((fact) => ORDERING_FACT_KINDS.has(fact.kind) && fact.resultBearing);
}

/** Resolve a recorded provenance name to indexed definitions. */
function resolveByName(db: Database, name: string): SymbolRecord[] {
  const leaf = name.split(".").at(-1) ?? name;
  const byFq = listSymbolsByFqName(db, name);
  if (byFq.length > 0) return byFq.slice(0, 4);
  return listSymbolsByLocalName(db, leaf).slice(0, 4);
}

/** Exact `calls` edges out of a definition. Never `references`, never potential. */
function exactCallees(db: Database, symbolId: SymbolId): SymbolRecord[] {
  return db.query(
    `
      SELECT d.id, d.file_id, d.fq_name, d.local_name, d.kind, d.signature,
             d.start_line, d.end_line, d.start_byte, d.end_byte,
             d.parent_symbol_id, d.exported, d.docstring, d.decorators,
             f.path AS file_path
      FROM edges e
      INNER JOIN symbols d ON d.id = e.dst_symbol_id
      INNER JOIN files f ON f.id = d.file_id
      WHERE e.src_symbol_id = ? AND e.edge_type = 'calls'
      ORDER BY d.fq_name ASC, d.id ASC
      LIMIT 12
    `,
  ).all(symbolId).map(toSymbolRecord);
}

interface RawSymbolRow {
  id: string; file_id: string; fq_name: string; local_name: string; kind: string;
  signature: string; start_line: number; end_line: number; start_byte: number;
  end_byte: number; parent_symbol_id: string | null; exported: number;
  docstring: string | null; decorators: string | null; file_path: string;
}

function toSymbolRecord(row: unknown): SymbolRecord {
  const raw = row as RawSymbolRow;
  return {
    id: raw.id,
    fileId: raw.file_id,
    filePath: raw.file_path,
    fqName: raw.fq_name,
    localName: raw.local_name,
    kind: raw.kind,
    signature: raw.signature,
    startLine: raw.start_line,
    endLine: raw.end_line,
    startByte: raw.start_byte,
    endByte: raw.end_byte,
    parentSymbolId: raw.parent_symbol_id,
    exported: raw.exported === 1,
    docstring: raw.docstring,
    decorators: raw.decorators === null ? [] : JSON.parse(raw.decorators),
  } as SymbolRecord;
}

/**
 * How the helper's ordering reads in prose.
 *
 * Each phrase states only what the fact shows, so a delivered explanation can be
 * exactly as strong as the evidence and no stronger (§52).
 */
function orderingPhrase(fact: MechanismFact): string {
  switch (fact.kind) {
    case "ordering_established":
      return `establishes the order of \`${fact.subject}\``;
    case "priority_lookup":
      return `ranks by the \`${fact.subject}\` precedence table`;
    case "sort_then_first":
      return `orders \`${fact.subject}\` before taking its first element`;
    case "first_success_return":
      return `returns the first \`${fact.subject}\` entry that qualifies, so iteration order decides`;
    default:
      return "establishes an order";
  }
}
