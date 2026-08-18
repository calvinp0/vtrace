/**
 * M160-D §48-§57 — subtype the repeated causal populations, on BOTH corpora,
 * without assuming which subtype exists.
 *
 * §50 is the governing constraint: lane-generation failures are classified from
 * evidence, and `OTHER_LANE_GENERATION` is the DEFAULT, not the leftover bin. The
 * prior theory — M143-B's subject→owner ceiling meeting M153's result/effect
 * ceiling — has to earn each case against a stated mechanical bar, because the
 * failure mode this milestone exists to avoid is finding the pattern you went
 * looking for on a corpus you have already read.
 *
 * The load-bearing discriminator is a REACHABILITY question the index can answer
 * directly. §51 asks whether "existing retrieval evidence cannot bridge subject
 * to owner", which is not a matter of opinion: resolve the query's own
 * identifiers to indexed symbols, then walk the relation graph outward. If the
 * gold symbol is reachable from what the query named and generation still never
 * scored it, the bridge EXISTS and the subtype is something else. If it is not
 * reachable at any bounded depth, the bridge is genuinely absent.
 *
 * That asymmetry matters: "the right symbol was absent from the candidates" is
 * compatible with a dozen mechanisms, and §51 explicitly forbids inferring
 * subject→owner from it.
 *
 * Reads pinned, already-indexed workspaces. NO agent, NO Docker, NO network, NO
 * indexing, NO product code.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { classifyTaskLanguage, namedGoldSymbols, type TaskLanguage } from "./m160TaskLanguage";
import { fileMatches } from "./run_stage5_retrieval_eval";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const RESULTS = path.join(import.meta.dir, "results");

/** How far the subject→owner bridge is allowed to be, in relation hops. */
const BRIDGE_DEPTH = 2;

/**
 * How many indexed definitions a name may have and still be treated as NAMING
 * an owner.
 *
 * DETECTOR CORRECTION (§44). The first version short-circuited any case whose
 * task mentioned a gold symbol, on the reasoning that naming the symbol makes a
 * subject→owner bridge unnecessary. Two Broad100-B cases falsified that:
 *
 *   - scikit-learn-13142's gold is `BaseMixture.fit_predict`, and the task does
 *     say `fit_predict` — but `fit_predict` has NINE indexed definitions, and the
 *     class the task actually names (`GaussianMixture`) does not define it at
 *     all. It INHERITS it. Naming the method there conveys no owner information
 *     whatsoever, which is precisely the bridging problem.
 *   - matplotlib-20859's gold symbol is `__init__`, which appears in the task's
 *     traceback and identifies nothing.
 *
 * So a name only counts as naming an owner when the index says it is nearly
 * unique, and dunder names never count. This changes the AUDIT only; no product
 * behaviour is touched.
 */
const UNAMBIGUOUS_DEFINITION_LIMIT = 2;

export type LaneSubtype =
  | "SUBJECT_OWNER"
  | "RESULT_EFFECT"
  | "SUBJECT_OWNER + RESULT_EFFECT"
  | "SUBJECT_UNREPRESENTED"
  | "NAMED_BUT_UNSCORED"
  | "OTHER_LANE_GENERATION";

interface CaseTrace {
  readonly instanceId: string;
  readonly repo: string;
  readonly expectedFiles: readonly string[];
  readonly expectedSymbols: readonly string[];
  readonly representation: {
    readonly goldSymbolsIndexed: number;
    readonly indexedGoldSymbols: readonly { fqName: string; localName: string; path: string; edgesIn: number; edgesOut: number }[];
  };
  readonly query: {
    readonly shapedQuery: string;
    readonly identifiers: readonly string[];
    readonly asksByIdentifier: boolean;
    readonly asksByPath: boolean;
    readonly asksByError: boolean;
    readonly asksByTest: boolean;
  };
  readonly delivery: { readonly mode: string; readonly deliveredPivots: number; readonly deliveredSupport: number };
  readonly firstDivergence: string;
}

/** A dunder name identifies nothing; a name with many owners disambiguates nothing. */
export function namesOwnerUnambiguously(
  namedSymbols: readonly string[],
  definitionCounts: ReadonlyMap<string, number>,
): boolean {
  return namedSymbols.some((symbol) => {
    const local = symbol.split(".").pop() ?? symbol;
    if (/^__\w+__$/.test(local)) return false;
    const count = definitionCounts.get(local) ?? 0;
    return count > 0 && count <= UNAMBIGUOUS_DEFINITION_LIMIT;
  });
}

export interface SubtypeEvidence {
  readonly instanceId: string;
  readonly repo: string;
  readonly goldSymbols: readonly string[];
  readonly queryIdentifiers: readonly string[];
  /** Query identifiers that resolve to at least one indexed symbol. */
  readonly identifiersIndexed: readonly string[];
  /** Query identifiers that resolve to nothing at all — the subject itself is unrepresented. */
  readonly identifiersUnrepresented: readonly string[];
  readonly goldReachableFromQuery: boolean;
  readonly bridgeDepth: number | null;
  /** Distinct indexed owners carrying a query subject — the result/effect ambiguity signal. */
  readonly sameSubjectOwners: number;
  readonly sameSubjectOwnerPaths: readonly string[];
  readonly taskLanguage: TaskLanguage;
  /** Gold symbols the task text actually names. */
  readonly namedGoldSymbols: readonly string[];
  /** Definitions of each gold symbol's local name in this index — the ambiguity measure. */
  readonly goldNameDefinitionCounts: Record<string, number>;
  readonly namesOwnerUnambiguously: boolean;
  readonly subtype: LaneSubtype;
  readonly rationale: string;
}

function symbolsNamed(db: Database, name: string): Array<{ id: string; fqName: string; path: string }> {
  return db
    .query<{ id: string; fq_name: string; path: string }, [string, string]>(
      `SELECT s.id AS id, s.fq_name AS fq_name, f.path AS path
       FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE s.local_name = ? OR s.fq_name LIKE ?`,
    )
    .all(name, `%::${name}`)
    .map((row) => ({ id: row.id, fqName: row.fq_name, path: row.path }));
}

/** Bounded outward walk over the relation graph, in both directions. */
export function reachesWithin(
  db: Database,
  startIds: readonly string[],
  targetIds: ReadonlySet<string>,
  maxDepth: number,
): number | null {
  let frontier = new Set(startIds);
  const seen = new Set(startIds);
  for (const id of frontier) if (targetIds.has(id)) return 0;
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const next = new Set<string>();
    for (const id of frontier) {
      const neighbours = db
        .query<{ other: string }, [string, string]>(
          `SELECT dst_symbol_id AS other FROM edges WHERE src_symbol_id = ?
           UNION SELECT src_symbol_id AS other FROM edges WHERE dst_symbol_id = ?`,
        )
        .all(id, id);
      for (const row of neighbours) {
        if (row.other === null || seen.has(row.other)) continue;
        if (targetIds.has(row.other)) return depth;
        seen.add(row.other);
        next.add(row.other);
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }
  return null;
}

/**
 * §51/§52/§53 — assign a subtype only when the stated bar is met.
 *
 * SUBJECT_OWNER needs the owner represented, the subject named but NOT resolving
 * to the owner, and no bridge between them at any bounded depth.
 * RESULT_EFFECT needs several indexed owners to share the subject, so the query
 * cannot pick between them on subject alone.
 * Everything else stays OTHER_LANE_GENERATION.
 */
export function assignSubtype(evidence: {
  goldIndexed: boolean;
  namesOwnerUnambiguously: boolean;
  identifiersIndexed: number;
  goldReachableFromQuery: boolean;
  sameSubjectOwners: number;
}): { subtype: LaneSubtype; rationale: string } {
  if (!evidence.goldIndexed) {
    return { subtype: "OTHER_LANE_GENERATION", rationale: "gold symbol is not represented; this is not a bridging question" };
  }
  if (evidence.namesOwnerUnambiguously) {
    return {
      subtype: "NAMED_BUT_UNSCORED",
      rationale:
        "the task names an indexed gold symbol that is nearly unique in this repository, so the strongest " +
        "possible handle was present and generation still never scored it — not a bridging failure",
    };
  }
  if (evidence.identifiersIndexed === 0) {
    return {
      subtype: "SUBJECT_UNREPRESENTED",
      rationale: "the query named no identifier that the index represents at all — there is nothing to bridge FROM",
    };
  }
  const subjectOwner = evidence.identifiersIndexed > 0 && !evidence.goldReachableFromQuery;
  const resultEffect = evidence.sameSubjectOwners >= 2;
  if (subjectOwner && resultEffect) {
    return {
      subtype: "SUBJECT_OWNER + RESULT_EFFECT",
      rationale:
        `the query's subject is indexed but no relation reaches gold within ${BRIDGE_DEPTH} hops, ` +
        `and ${evidence.sameSubjectOwners} indexed owners share the subject so it cannot be disambiguated by subject alone`,
    };
  }
  if (subjectOwner) {
    return {
      subtype: "SUBJECT_OWNER",
      rationale: `the query's subject is indexed but no relation reaches gold within ${BRIDGE_DEPTH} hops`,
    };
  }
  if (resultEffect) {
    return {
      subtype: "RESULT_EFFECT",
      rationale: `${evidence.sameSubjectOwners} indexed owners share the query's subject; gold is reachable but indistinguishable by subject`,
    };
  }
  return {
    subtype: "OTHER_LANE_GENERATION",
    rationale: "gold is reachable from the query's subject and the subject is unambiguous; the loss is elsewhere in generation",
  };
}

function analyseCase(trace: CaseTrace, corpusRoot: string, taskText: string): SubtypeEvidence {
  const workspace = path.resolve(corpusRoot, trace.instanceId);
  const db = openIndexerDatabase(path.join(workspace, ".vtrace", "index.sqlite"));
  try {
    const goldRows = trace.expectedSymbols.flatMap((symbol) => symbolsNamed(db, symbol.split(".").pop() ?? symbol));
    const goldInGoldFile = goldRows.filter((row) => trace.expectedFiles.some((file) => fileMatches(file, row.path)));
    const goldIds = new Set((goldInGoldFile.length > 0 ? goldInGoldFile : goldRows).map((row) => row.id));

    const identifiersIndexed: string[] = [];
    const identifiersUnrepresented: string[] = [];
    const startIds: string[] = [];
    const ownerPaths = new Set<string>();
    for (const identifier of trace.query.identifiers) {
      const matches = symbolsNamed(db, identifier);
      if (matches.length === 0) {
        identifiersUnrepresented.push(identifier);
        continue;
      }
      identifiersIndexed.push(identifier);
      for (const match of matches) {
        startIds.push(match.id);
        ownerPaths.add(match.path);
      }
    }

    const depth = goldIds.size === 0 || startIds.length === 0 ? null : reachesWithin(db, startIds, goldIds, BRIDGE_DEPTH);
    const taskLanguage = classifyTaskLanguage(taskText, trace.expectedSymbols, trace.expectedFiles);
    const definitionCounts = new Map<string, number>();
    for (const symbol of trace.expectedSymbols) {
      const local = symbol.split(".").pop() ?? symbol;
      definitionCounts.set(local, symbolsNamed(db, local).length);
    }
    // Only the gold symbols the task ACTUALLY names, per symbol. Crediting a
    // query with a handle it never offered is how sklearn-13142 was first
    // misclassified.
    const namedSymbols = namedGoldSymbols(taskText, trace.expectedSymbols);
    const namesOwner = namesOwnerUnambiguously(namedSymbols, definitionCounts);
    const { subtype, rationale } = assignSubtype({
      goldIndexed: trace.representation.goldSymbolsIndexed > 0,
      namesOwnerUnambiguously: namesOwner,
      identifiersIndexed: identifiersIndexed.length,
      goldReachableFromQuery: depth !== null,
      sameSubjectOwners: ownerPaths.size,
    });

    return {
      instanceId: trace.instanceId,
      repo: trace.repo,
      goldSymbols: trace.expectedSymbols,
      queryIdentifiers: trace.query.identifiers,
      identifiersIndexed,
      identifiersUnrepresented,
      goldReachableFromQuery: depth !== null,
      bridgeDepth: depth,
      sameSubjectOwners: ownerPaths.size,
      sameSubjectOwnerPaths: [...ownerPaths].sort().slice(0, 8),
      taskLanguage,
      namedGoldSymbols: namedSymbols,
      goldNameDefinitionCounts: Object.fromEntries(definitionCounts),
      namesOwnerUnambiguously: namesOwner,
      subtype,
      rationale,
    };
  } finally {
    db.close();
  }
}

function aggregate(rows: readonly SubtypeEvidence[]): Record<string, unknown> {
  const bySubtype = new Map<string, SubtypeEvidence[]>();
  for (const row of rows) {
    const bucket = bySubtype.get(row.subtype) ?? [];
    bucket.push(row);
    bySubtype.set(row.subtype, bucket);
  }
  return Object.fromEntries(
    [...bySubtype].sort((a, b) => b[1].length - a[1].length).map(([subtype, bucket]) => {
      const repos = [...new Set(bucket.map((row) => row.repo))].sort();
      const repoCounts = new Map<string, number>();
      for (const row of bucket) repoCounts.set(row.repo, (repoCounts.get(row.repo) ?? 0) + 1);
      const largest = [...repoCounts].sort((a, b) => b[1] - a[1])[0] ?? null;
      return [
        subtype,
        {
          cases: bucket.length,
          repoCount: repos.length,
          repos,
          instances: bucket.map((row) => row.instanceId).sort(),
          largestRepo: largest?.[0] ?? null,
          largestRepoShare: largest === null ? 0 : Number((largest[1] / bucket.length).toFixed(3)),
          sympyShare: Number(((repoCounts.get("sympy/sympy") ?? 0) / bucket.length).toFixed(3)),
          taskLanguage: bucket.reduce<Record<string, number>>((acc, row) => {
            acc[row.taskLanguage.primary] = (acc[row.taskLanguage.primary] ?? 0) + 1;
            return acc;
          }, {}),
        },
      ];
    }),
  );
}

interface CorpusInput {
  readonly label: string;
  readonly traces: string;
  readonly corpusRoot: string;
  readonly fixture: string;
}

async function analyseCorpus(input: CorpusInput): Promise<{ rows: SubtypeEvidence[]; failures: unknown[] }> {
  const doc = JSON.parse(await readFile(input.traces, "utf8")) as { traces: CaseTrace[] };
  const fixture = JSON.parse(await readFile(input.fixture, "utf8")) as Array<{ instance_id: string; task: string }>;
  const taskById = new Map(fixture.map((row) => [row.instance_id, row.task]));
  const rows: SubtypeEvidence[] = [];
  const failures: unknown[] = [];
  for (const trace of doc.traces) {
    if (trace.firstDivergence !== "LANE_GENERATION_FAILURE") continue;
    try {
      rows.push(analyseCase(trace, input.corpusRoot, taskById.get(trace.instanceId) ?? ""));
    } catch (error) {
      failures.push({ instanceId: trace.instanceId, error: String(error) });
    }
  }
  return { rows, failures };
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    return index < 0 ? fallback : (argv[index + 1] ?? fallback);
  };

  const a: CorpusInput = {
    label: "Broad100-A",
    traces: get("--a-traces", path.join(RESULTS, "stage5_m159_case_traces.json")),
    corpusRoot: get("--a-corpus-root", "/home/calvin/bench/vtrace-m156/targets/m156"),
    fixture: get("--a-fixture", path.join(import.meta.dir, "retrieval_eval.m155_broad_100.json")),
  };
  const b: CorpusInput = {
    label: "Broad100-B",
    traces: get("--b-traces", path.join(RESULTS, "stage5_m160_broad100b_case_traces.json")),
    corpusRoot: get("--b-corpus-root", path.join(RESULTS, "workspaces", "m160_broad_b")),
    fixture: get("--b-fixture", path.join(import.meta.dir, "retrieval_eval.m160_broad_b.json")),
  };
  const outPath = get("--out", path.join(RESULTS, "stage5_m160_lane_generation_subtypes.json"));

  const aResult = await analyseCorpus(a);
  const bResult = await analyseCorpus(b);

  const doc = {
    schemaVersion: "stage5.m160.lane-generation-subtypes.v1",
    milestone: "M160",
    kind: "structural subtyping of LANE_GENERATION_FAILURE on both corpora (§48-§57)",
    method: {
      default: "a subtype must be earned, not inferred from gold's absence (§50, §51)",
      detectorCorrection:
        "§44 — the first classifier short-circuited any task that mentioned a gold symbol. scikit-learn-13142 " +
        "falsified it: the task says `fit_predict`, which has NINE indexed definitions, and the class the task " +
        "names does not define it at all. Naming an ambiguous method conveys no owner information. A name now " +
        "counts as naming an owner only when the index says it is nearly unique, and dunder names never count. " +
        "Audit detector only; no product behaviour changed.",
      unambiguousDefinitionLimit: UNAMBIGUOUS_DEFINITION_LIMIT,
      bridgeDepth: BRIDGE_DEPTH,
      bridgeTest:
        "resolve the query's own identifiers to indexed symbols and walk the relation graph outward; " +
        "if gold is reachable, the subject→owner bridge exists and the loss is elsewhere",
      resultEffectTest: "two or more distinct indexed owners carry the query's subject",
      taskLanguage: "evaluator analysis only; no query heuristic is added to the product (§57)",
    },
    broad100a: { cases: aResult.rows.length, bySubtype: aggregate(aResult.rows), failures: aResult.failures, evidence: aResult.rows },
    broad100b: { cases: bResult.rows.length, bySubtype: aggregate(bResult.rows), failures: bResult.failures, evidence: bResult.rows },
  };

  await writeFile(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  console.log(`lane-generation subtypes -> ${path.relative(REPO_ROOT, outPath)}`);
  for (const [label, result] of [["A", aResult], ["B", bResult]] as const) {
    console.log(`  Broad100-${label}: ${result.rows.length} lane-generation cases`);
    for (const [subtype, info] of Object.entries(aggregate(result.rows))) {
      const i = info as { cases: number; repoCount: number; largestRepo: string | null; largestRepoShare: number };
      console.log(`    ${subtype.padEnd(30)} ${i.cases} cases / ${i.repoCount} repos (largest ${i.largestRepo} ${(i.largestRepoShare * 100).toFixed(0)}%)`);
    }
  }
}

if (import.meta.main) {
  await main();
}
