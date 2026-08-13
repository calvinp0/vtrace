// M143 Workstream B — behaviour-ownership EVIDENCE AUDIT.
//
// M143-A proved the title lane cannot tell a titled BYSTANDER from a titled
// EDIT SITE using any title-local signal (eight mechanisms measured, all
// rejected). B asks a different question, and this runner answers only that
// question — it ships no mechanism:
//
//   What deterministic REPOSITORY RELATIONSHIP shows that a candidate
//   participates in, controls, or implements the requested behaviour?
//
// The distinguishing property this looks for is DIRECTION. M143 §37 predicts
// that in `django-11740`
//
//     _get_dependencies_for_foreign_key  --references-->  ForeignKey
//
// i.e. the behaviour owner CONSUMES the title symbol, which would make
// `ForeignKey` the task SUBJECT rather than the implementation. The reverse
// relation is not equivalent, so edge direction and type are preserved
// throughout and never collapsed into undirected proximity (§30, §37).
//
// Relations are read with the existing batched adjacency primitives on a
// bounded family (the title symbol plus the members it contains, and the same
// for each rival). No transitive walk, no source reads, no full-pool scan.
//
// No agent, Docker, VEXP, network, or paid API is used.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m143b_ownership_evidence_audit.ts \
//     --fixture <fixture.json> [--fixture ...] --out <dir>

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";

import { anchorTitleSymbols } from "../../src/capsuleV2/titleSymbolAnchoring";
import { shapeSweQuery } from "../../src/capsule/sweQueryShaping";
import { behavioralObjectives } from "../../src/retrieval/conceptOwnerRetrieval";
import { deriveQueryIntent } from "../../src/retrieval/querySemantics";
import { listAllSymbols } from "../../src/db/repositories/symbolsRepository";
import {
  listIncomingEdgesForSymbols,
  listOutgoingEdgesForSymbols,
} from "../../src/db/repositories/edgesRepository";
import { HYBRID_SCORE_WEIGHTS } from "../../src/retrieval/hybridScoring";
import {
  createHybridRetrievalRequestCache,
  hybridRetrieve,
} from "../../src/retrieval/hybridRetrieval";
import type { SymbolRecord } from "../../src/domain/types";
import { prepareRunnerOutput, SHARED_RUNNER_OPTIONS_HELP } from "./lib/runnerPaths";

const RUNNER_NAME = "m143b_ownership_evidence_audit";

/** Same instrument width as the A probe, so the two audits are comparable. */
const PROBE_POOL = 400;
/**
 * A second, wider width. `django-11740`'s pool floor is 0.660 — HIGHER than the
 * best in-family score in two other cases — so "the title class has no retrieved
 * member" is only meaningful once the pool is deep enough to be sure. M143-A's
 * standing finding is explicit: before calling a symbol unretrievable, widen the
 * pool and look.
 */
const DEEP_POOL = 1500;
/** Rivals whose relation to the title symbol is inspected. Bounded (§60). */
const RIVALS = 10;

interface FixtureCase {
  readonly instance_id: string;
  readonly workspace: string;
  readonly task: string;
  readonly expected_files?: readonly string[];
  readonly expected_symbols?: readonly string[];
}

/**
 * Gold paths in the fixtures are repository-relative; workspace paths are not
 * necessarily. Comparing them literally scored three correct leads as wrong on
 * M143-A's first pass (§77), so every path comparison in B goes through here.
 */
export const samePath = (left: string, right: string): boolean =>
  left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);

export interface DirectedRelations {
  readonly calls: number;
  readonly references: number;
  readonly contains: number;
  readonly imports: number;
}

const EMPTY: DirectedRelations = { calls: 0, references: 0, contains: 0, imports: 0 };

const tally = (
  edges: ReadonlyArray<{ srcSymbolId: string; dstSymbolId: string; edgeType: string }>,
  from: ReadonlySet<string>,
  to: ReadonlySet<string>,
): DirectedRelations => {
  const counts = { ...EMPTY } as { calls: number; references: number; contains: number; imports: number };
  for (const edge of edges) {
    if (!from.has(edge.srcSymbolId) || !to.has(edge.dstSymbolId)) continue;
    if (edge.edgeType === "calls") counts.calls += 1;
    else if (edge.edgeType === "references") counts.references += 1;
    else if (edge.edgeType === "contains") counts.contains += 1;
    else if (edge.edgeType === "imports") counts.imports += 1;
  }
  return counts;
};

const total = (relations: DirectedRelations): number =>
  relations.calls + relations.references + relations.contains + relations.imports;

/**
 * A symbol plus what it contains: a class owns the behaviour its methods
 * implement, so a relation to `ForeignKey.deconstruct` is a relation to
 * `ForeignKey`. Bounded by fq-name prefix within the same file.
 */
function family(symbols: readonly SymbolRecord[], seed: SymbolRecord): Set<string> {
  const ids = new Set<string>([seed.id]);
  for (const symbol of symbols) {
    if (symbol.filePath === seed.filePath && symbol.fqName.startsWith(`${seed.fqName}.`)) {
      ids.add(symbol.id);
    }
  }
  return ids;
}

export interface RelationRow {
  readonly label: string;
  readonly kind: string;
  readonly isGold: boolean;
  readonly rank: number | null;
  readonly final: number | null;
  /** title family -> other family. */
  readonly titleToOther: DirectedRelations;
  /** other family -> title family. */
  readonly otherToTitle: DirectedRelations;
}

/**
 * Retrieval support earned by the title candidate's OWN family — the
 * "does the requested behaviour live INSIDE this class" question, asked without
 * any reference to the gold labels.
 */
export interface FamilySupport {
  readonly familySize: number;
  readonly bestRankAtProbePool: number | null;
  readonly bestRankAtDeepPool: number | null;
  readonly bestScoreAtDeepPool: number | null;
  readonly bestMemberAtDeepPool: string | null;
  readonly probePoolFloor: number | null;
  /** The title symbol's OWN organic rank, for reference against M143-A. */
  readonly titleOwnRank: number | null;
}

export interface CaseEvidence {
  readonly instanceId: string;
  readonly titleSymbol: string | null;
  readonly titlePath: string | null;
  readonly titleKind: string | null;
  readonly titleIsGold: boolean;
  readonly expectedFiles: readonly string[];
  readonly expectedSymbols: readonly string[];
  readonly objectives: readonly string[];
  readonly organicLead: string | null;
  readonly organicLeadIsGold: boolean;
  /** Relations between EVERY symbol in the lead's file and the title family. */
  readonly leadFileToTitle: DirectedRelations;
  readonly titleToLeadFile: DirectedRelations;
  readonly familySupport: FamilySupport;
  readonly goldRows: readonly RelationRow[];
  readonly rivalRows: readonly RelationRow[];
  readonly counters: {
    readonly familiesInspected: number;
    readonly graphQueries: number;
    readonly relationsInspected: number;
    readonly sourceReads: number;
  };
}

export function auditCase(db: Database, testCase: FixtureCase): CaseEvidence | null {
  const shaped = shapeSweQuery({ problemStatement: testCase.task });
  const intent = shaped.derivedIntent ?? deriveQueryIntent(testCase.task);
  const objectives = behavioralObjectives(intent);
  const title = anchorTitleSymbols({ db, task: testCase.task });
  const match = title.matches[0];
  if (match === undefined) return null;

  const expectedFiles = testCase.expected_files ?? [];
  const expectedSymbols = testCase.expected_symbols ?? [];
  const symbols = listAllSymbols(db);
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const titleSymbol = byId.get(match.symbolId);
  if (titleSymbol === undefined) return null;

  const retrieval = hybridRetrieve(db, {
    query: shaped.query,
    shaped,
    taskText: testCase.task,
    weights: HYBRID_SCORE_WEIGHTS,
    symbolSeeds: [],
    maxResults: PROBE_POOL,
    requestCache: createHybridRetrievalRequestCache(),
  });
  const ranked = retrieval.candidates.filter((candidate) => candidate.symbolId !== match.symbolId);
  const lead = ranked[0];

  const titleIds = family(symbols, titleSymbol);

  // Two batched adjacency reads for the whole case — not one per rival (§61).
  const outgoing = listOutgoingEdgesForSymbols(db, [...titleIds]);
  const incoming = listIncomingEdgesForSymbols(db, [...titleIds]);
  let graphQueries = 2;

  const rowFor = (symbol: SymbolRecord, rank: number | null, final: number | null): RelationRow => {
    const otherIds = family(symbols, symbol);
    return {
      label: `${symbol.filePath}::${symbol.localName}`,
      kind: String(symbol.kind),
      isGold:
        expectedFiles.some((file) => samePath(symbol.filePath, file))
        && (expectedSymbols.length === 0
          || expectedSymbols.some(
            (name) => symbol.fqName === name || symbol.fqName.endsWith(`.${name}`) || symbol.localName === name,
          )),
      rank,
      final,
      titleToOther: tally(outgoing, titleIds, otherIds),
      otherToTitle: tally(incoming, otherIds, titleIds),
    };
  };

  // The declared gold owners, whether or not retrieval ranked them.
  const goldSymbols = symbols.filter(
    (symbol) =>
      expectedFiles.some((file) => samePath(symbol.filePath, file))
      && expectedSymbols.some(
        (name) => symbol.fqName === name || symbol.fqName.endsWith(`.${name}`) || symbol.localName === name,
      ),
  );
  const rankOf = new Map(ranked.map((candidate, index) => [candidate.symbolId, index + 1]));
  const finalOf = new Map(ranked.map((candidate) => [candidate.symbolId, candidate.scores.final]));

  const goldRows = goldSymbols.map((symbol) =>
    rowFor(symbol, rankOf.get(symbol.id) ?? null, finalOf.get(symbol.id) ?? null),
  );
  const rivalRows = ranked.slice(0, RIVALS).flatMap((candidate) => {
    const symbol = byId.get(candidate.symbolId);
    return symbol === undefined ? [] : [rowFor(symbol, rankOf.get(candidate.symbolId) ?? null, candidate.scores.final)];
  });

  const leadSymbol = lead === undefined ? undefined : byId.get(lead.symbolId);

  // Whole-file relation to the title family: the "does the behaviour owner's
  // module consume the titled subject" question (§37). File-level because M140
  // made the <module> symbol the owner of imports.
  const leadFileIds = new Set(
    leadSymbol === undefined
      ? []
      : symbols.filter((symbol) => symbol.filePath === leadSymbol.filePath).map((symbol) => symbol.id),
  );
  const leadFileEdgesOut = leadFileIds.size === 0 ? [] : listOutgoingEdgesForSymbols(db, [...leadFileIds]);
  const leadFileEdgesIn = leadFileIds.size === 0 ? [] : listIncomingEdgesForSymbols(db, [...leadFileIds]);
  if (leadFileIds.size > 0) graphQueries += 2;

  // Family retrieval support, measured at BOTH widths so a "no support" reading
  // can be told apart from a pool that simply stopped above the member's score.
  const familyMembers = new Map(
    symbols
      .filter((symbol) => titleIds.has(symbol.id) && symbol.id !== titleSymbol.id)
      .map((symbol) => [symbol.id, symbol.localName]),
  );
  const deep = hybridRetrieve(db, {
    query: shaped.query,
    shaped,
    taskText: testCase.task,
    weights: HYBRID_SCORE_WEIGHTS,
    symbolSeeds: [],
    maxResults: DEEP_POOL,
    requestCache: createHybridRetrievalRequestCache(),
  });
  const deepRanked = deep.candidates.filter((candidate) => candidate.symbolId !== match.symbolId);
  const deepHit = deepRanked.findIndex((candidate) => familyMembers.has(candidate.symbolId));
  const probeHit = ranked.findIndex((candidate) => familyMembers.has(candidate.symbolId));
  const ownRank = retrieval.candidates.findIndex((candidate) => candidate.symbolId === match.symbolId);

  return {
    instanceId: testCase.instance_id,
    titleSymbol: match.symbol,
    titlePath: match.path,
    titleKind: String(titleSymbol.kind),
    titleIsGold: expectedFiles.some((file) => samePath(match.path, file)),
    expectedFiles,
    expectedSymbols,
    objectives,
    organicLead: leadSymbol === undefined ? null : `${leadSymbol.filePath}::${leadSymbol.localName}`,
    organicLeadIsGold:
      leadSymbol !== undefined && expectedFiles.some((file) => samePath(leadSymbol.filePath, file)),
    leadFileToTitle: tally(leadFileEdgesOut, leadFileIds, titleIds),
    titleToLeadFile: tally(leadFileEdgesIn, titleIds, leadFileIds),
    familySupport: {
      familySize: titleIds.size,
      bestRankAtProbePool: probeHit === -1 ? null : probeHit + 1,
      bestRankAtDeepPool: deepHit === -1 ? null : deepHit + 1,
      bestScoreAtDeepPool: deepHit === -1 ? null : deepRanked[deepHit]!.scores.final,
      bestMemberAtDeepPool: deepHit === -1 ? null : familyMembers.get(deepRanked[deepHit]!.symbolId) ?? null,
      probePoolFloor: ranked.length === 0 ? null : ranked[ranked.length - 1]!.scores.final,
      titleOwnRank: ownRank === -1 ? null : ownRank + 1,
    },
    goldRows,
    rivalRows,
    counters: {
      familiesInspected: goldRows.length + rivalRows.length + 1,
      graphQueries,
      relationsInspected: outgoing.length + incoming.length,
      sourceReads: 0,
    },
  };
}

async function main(): Promise<void> {
  const fixtures: string[] = [];
  const only = new Set<string>();
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--fixture") {
      const value = process.argv[index + 1];
      if (value !== undefined) fixtures.push(path.resolve(value));
    }
    if (process.argv[index] === "--instance") {
      const value = process.argv[index + 1];
      if (value !== undefined) only.add(value);
    }
  }
  if (fixtures.length === 0) throw new Error(`Missing --fixture. ${SHARED_RUNNER_OPTIONS_HELP}`);
  const out = await prepareRunnerOutput({ argv: process.argv, runner: RUNNER_NAME });

  const cases: CaseEvidence[] = [];
  const startedAt = performance.now();
  for (const fixturePath of fixtures) {
    const parsed = JSON.parse(await readFile(fixturePath, "utf8")) as FixtureCase[] | { cases: FixtureCase[] };
    const list = Array.isArray(parsed) ? parsed : parsed.cases;
    for (const testCase of list) {
      if (only.size > 0 && !only.has(testCase.instance_id)) continue;
      const indexPath = path.join(testCase.workspace, ".vtrace", "index.sqlite");
      if (!existsSync(indexPath)) continue;
      const db = new Database(indexPath, { readonly: true });
      try {
        const result = auditCase(db, testCase);
        if (result !== null) cases.push(result);
      } finally {
        db.close();
      }
      process.stderr.write(".");
    }
  }
  process.stderr.write("\n");

  const artifact = {
    schemaVersion: "stage5.m143b.ownership-evidence-audit.v1",
    purpose:
      "M143-B §12/§46: measure DIRECTED repository relations between a title candidate and its rivals, "
      + "before proposing any ownership mechanism.",
    fixtures,
    instrument: { probePoolSize: PROBE_POOL, rivalCap: RIVALS, transitiveWalks: 0, sourceReads: 0 },
    elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
    cases,
  };
  const outPath = path.join(out.dir, "stage5_m143_title_ownership_matrix.json");
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  for (const row of cases) {
    process.stdout.write(
      `\n${row.instanceId}  title=${row.titleSymbol} (${row.titleKind}) titleIsGold=${row.titleIsGold}\n`
        + `  organicLead=${row.organicLead} gold=${row.organicLeadIsGold}\n`,
    );
    for (const gold of row.goldRows) {
      process.stdout.write(
        `  GOLD  ${gold.label} rank=${gold.rank} final=${gold.final?.toFixed(3)}\n`
          + `        title->gold ${JSON.stringify(gold.titleToOther)}\n`
          + `        gold->title ${JSON.stringify(gold.otherToTitle)}\n`,
      );
    }
    for (const rival of row.rivalRows.slice(0, 3)) {
      process.stdout.write(
        `  rival ${rival.label} rank=${rival.rank} gold=${rival.isGold} `
          + `t->o=${total(rival.titleToOther)} o->t=${total(rival.otherToTitle)}\n`,
      );
    }
  }
  process.stdout.write(`\nwrote ${outPath}\n`);
}

if (import.meta.main) {
  await main();
}
