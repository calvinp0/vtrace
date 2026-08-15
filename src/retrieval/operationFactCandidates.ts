// Making the operation-bearing implementation eligible to be ranked at all.
//
// Every other M150 lane assumes the right definition is already in the candidate
// pool: mechanism scoring strengthens it, subject alignment keeps the wrong ones
// out, support explains it. None of that fires for ARC's precedence question,
// because `get_all_families` is `not_generated` — measured, not inferred. The
// query asks what establishes the order; the definition that establishes it is
// named after families rather than after ordering, so no lexical, symbol, path
// or domain signal reaches it, and the pool never contains it.
//
// So this lane runs the pipeline backwards for exactly one step:
//
//     query declares a behavioral operation
//         -> indexed facts of the kinds that DIRECTLY implement it
//         -> the SAME subject-alignment policy that fixed the Gaussian regression
//         -> a bounded handful of ordinary candidates
//
// "Ordinary" is the important word. Admission is not selection, not a role and
// not a score: an admitted definition competes on the same evidence as everything
// else and can still lose (§23). All this lane changes is whether it was allowed
// to compete.
//
// The generation-time danger is the checkpoint regression in a new place — every
// Gaussian parser carrying a first-item selection flooding the pool on a request
// about route keywords. Subject alignment is therefore mandatory BEFORE
// admission, not after (§14, §15).

import type { Database } from "bun:sqlite";

import { getSymbolsByIds } from "../db/repositories/symbolsRepository";
import type { MechanismFactKind } from "../indexer/extractMechanismFacts";
import { isStructuralSymbolKind, type SymbolRecord } from "../domain/types";
import type { BehavioralObjective } from "./behavioralObjective";
import { alignmentOf, directFactKindsFor, type SubjectAlignment } from "./mechanismEvidence";

/** Explicit, tested bounds (§17, §18, §61). */
export const OPERATION_FACT_LIMITS = Object.freeze({
  /** Rows read from the fact index. Indexed by kind, so this is a LIMIT not a scan. */
  maxFactsQueried: 400,
  /** Distinct owning definitions whose alignment is evaluated. */
  maxOwnersExamined: 64,
  /** Definitions admitted into the ordinary candidate pool. */
  maxAdmitted: 3,
});

export interface OperationFactCandidate {
  readonly symbol: SymbolRecord;
  readonly factKind: MechanismFactKind;
  readonly operand: string;
  readonly provenance: string;
  readonly alignment: SubjectAlignment;
  readonly statement: string;
  readonly reason: string;
}

export interface OperationFactDiagnostics {
  readonly active: boolean;
  readonly reason: string;
  readonly operation: string | null;
  readonly factKindsQueried: readonly string[];
  readonly factsQueried: number;
  readonly ownersExamined: number;
  readonly ownersRejected: number;
  readonly candidatesAdmitted: number;
  /** Owners refused because the mechanism was about something else (§71). */
  readonly rejectedForSubject: readonly { readonly fqName: string; readonly operand: string; readonly provenance: string }[];
  readonly sourceReads: number;
  readonly lookupMs: number;
  readonly alignmentMs: number;
}

export interface OperationFactResult {
  readonly candidates: readonly OperationFactCandidate[];
  readonly diagnostics: OperationFactDiagnostics;
}

export function inactiveOperationFacts(reason: string): OperationFactResult {
  return {
    candidates: [],
    diagnostics: {
      active: false,
      reason,
      operation: null,
      factKindsQueried: [],
      factsQueried: 0,
      ownersExamined: 0,
      ownersRejected: 0,
      candidatesAdmitted: 0,
      rejectedForSubject: [],
      sourceReads: 0,
      lookupMs: 0,
      alignmentMs: 0,
    },
  };
}

interface FactRow {
  readonly symbol_id: string;
  readonly kind: MechanismFactKind;
  readonly subject: string;
  readonly provenance: string;
  readonly evidence: string;
  readonly result_bearing: number;
}

/**
 * Admit a bounded set of definitions whose indexed mechanism facts implement the
 * requested operation on the requested subject.
 *
 * Zero source reads. The fact table is searched by `kind` through the existing
 * `(kind, symbol_id)` index — profiled on ARC as an index SEARCH returning 46 of
 * 2566 rows in 0.73 ms — so no access migration was required (§19, §20, §56).
 */
export function generateOperationFactCandidates(
  db: Database,
  objective: BehavioralObjective,
): OperationFactResult {
  const kinds = directFactKindsFor(objective.operation);
  if (kinds.length === 0) {
    return inactiveOperationFacts(`no fact kind directly implements ${objective.operation}`);
  }
  // A request that names no subject cannot discriminate, and admitting on an
  // undecidable alignment would pull in every ordering in the repository. The
  // lane simply does not run — ordinary retrieval is unaffected.
  if (objective.subjectTerms.length === 0) {
    return inactiveOperationFacts("request names no subject to align a mechanism against");
  }

  const lookupStarted = performance.now();
  const placeholders = kinds.map(() => "?").join(", ");
  const rows = db.query(
    `
      SELECT symbol_id, kind, subject, provenance, evidence, result_bearing
      FROM symbol_mechanism_facts
      WHERE kind IN (${placeholders}) AND result_bearing = 1
      ORDER BY kind ASC, symbol_id ASC
      LIMIT ?
    `,
  ).all(...kinds, OPERATION_FACT_LIMITS.maxFactsQueried) as FactRow[];
  const lookupMs = Math.round((performance.now() - lookupStarted) * 100) / 100;

  const alignmentStarted = performance.now();
  const subjectTerms = new Set(objective.subjectTerms);
  // Alignment is decided on the FACT, before anything is loaded. Only the owners
  // that survive are resolved to symbols, so a rejected fact costs one string
  // comparison rather than a row fetch.
  const aligned: Array<{ row: FactRow; alignment: SubjectAlignment }> = [];
  const rejected: Array<{ symbolId: string; operand: string; provenance: string }> = [];
  const seenOwners = new Set<string>();
  for (const row of rows) {
    if (seenOwners.size >= OPERATION_FACT_LIMITS.maxOwnersExamined) break;
    if (seenOwners.has(row.symbol_id)) continue;
    seenOwners.add(row.symbol_id);
    const alignment = alignmentOf(row.subject, row.provenance, subjectTerms);
    if (alignment === "direct_operand" || alignment === "local_producer") {
      aligned.push({ row, alignment });
    } else {
      rejected.push({ symbolId: row.symbol_id, operand: row.subject, provenance: row.provenance });
    }
  }

  // Nearest evidence first: an operand that names the subject outranks one that
  // only its producer names.
  aligned.sort((left, right) => {
    const rank = (value: SubjectAlignment): number => (value === "direct_operand" ? 0 : 1);
    return rank(left.alignment) - rank(right.alignment)
      || left.row.symbol_id.localeCompare(right.row.symbol_id);
  });

  const admittedRows = aligned.slice(0, OPERATION_FACT_LIMITS.maxAdmitted);
  const symbols = getSymbolsByIds(db, admittedRows.map((entry) => entry.row.symbol_id));
  const candidates: OperationFactCandidate[] = [];
  for (const entry of admittedRows) {
    const symbol = symbols.get(entry.row.symbol_id);
    // §52: a structural module node is never answer-bearing, so it can never be
    // admitted however strong its facts look.
    if (symbol === undefined || isStructuralSymbolKind(symbol.kind)) continue;
    candidates.push({
      symbol,
      factKind: entry.row.kind,
      operand: entry.row.subject,
      provenance: entry.row.provenance,
      alignment: entry.alignment,
      statement: entry.row.evidence,
      reason: entry.alignment === "direct_operand"
        ? `implements the requested ${objective.operation} on \`${entry.row.subject}\``
        : `implements the requested ${objective.operation} on the value \`${entry.row.provenance}\` produces`,
    });
  }
  const alignmentMs = Math.round((performance.now() - alignmentStarted) * 100) / 100;

  // Rejections are resolved to names only for the diagnostic, and only a few:
  // the artifact needs proof that wrong-subject facts were REFUSED, not a dump.
  const rejectedById = getSymbolsByIds(db, rejected.slice(0, 8).map((entry) => entry.symbolId));

  return {
    candidates,
    diagnostics: {
      active: true,
      reason: candidates.length > 0
        ? `admitted ${candidates.length} definition(s) carrying subject-aligned ${objective.operation} facts`
        : `no indexed ${objective.operation} fact is about ${[...subjectTerms].join(", ")}`,
      operation: objective.operation,
      factKindsQueried: kinds,
      factsQueried: rows.length,
      ownersExamined: seenOwners.size,
      ownersRejected: rejected.length,
      candidatesAdmitted: candidates.length,
      rejectedForSubject: rejected.slice(0, 8).map((entry) => ({
        fqName: rejectedById.get(entry.symbolId)?.fqName ?? entry.symbolId,
        operand: entry.operand,
        provenance: entry.provenance,
      })),
      sourceReads: 0,
      lookupMs,
      alignmentMs,
    },
  };
}
