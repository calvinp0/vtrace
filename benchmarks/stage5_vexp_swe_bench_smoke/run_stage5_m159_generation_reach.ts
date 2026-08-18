/**
 * M159-B §26/§27/§31 — separate a candidate the generators COULD reach and a
 * bound discarded, from a candidate no generator lane can reach at all.
 *
 * The first trace pass found that for 14 residual cases the gold symbol is
 * indexed but never scored. That is a diagnosis, not yet a cause. `hybridRetrieve`
 * sizes its own internal lexical pool from the requested result count
 * (`lexicalPoolSize = max(20, maxResults * 4)`), so at the product's
 * `CANDIDATE_POOL_SIZE` of 25 the generators score roughly 130 candidates out of a
 * repository holding tens of thousands of symbols. "Not scored" at that setting is
 * therefore compatible with two completely different worlds:
 *
 *   - the lane HAS evidence for the gold symbol and the generation pool cut it
 *     off  -> a bound question, recoverable by widening a bound;
 *   - no lane has any evidence linking the query to the gold symbol at all
 *     -> a coverage question, and no bound, weight or ordering change reaches it.
 *
 * §33 makes that distinction decide the first-divergence label, and §53 makes it
 * decide what a functional milestone would even be allowed to touch. So this
 * runner escalates the requested pool well past anything the product uses and
 * records the first setting at which the gold symbol becomes SCORED, together
 * with the score and evidence it earns when it does.
 *
 * §27 compliance: this is an OFFLINE DIAGNOSTIC. It changes no product bound, is
 * not reachable from any product path, and its widened pools are never proposed
 * as a product setting — a gold symbol that only appears at pool 400 is evidence
 * about reach, not a licence to set the pool to 400 (§42).
 *
 * Reads pinned, already-indexed workspaces. NO agent, NO Docker, NO network, NO
 * indexing, NO writes to any target workspace or index.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { shapeSweQuery, type ShapedSweQuery } from "../../src/capsule/sweQueryShaping";
import { planIntent } from "../../src/capsuleV2/intent";
import { resolveProjectNameAliases } from "../../src/capsuleV2/projectNameSignals";
import { createLazyRepositoryPathPredicate } from "../../src/retrieval/repositoryPathMembership";
import { createHybridRetrievalRequestCache, hybridRetrieve } from "../../src/retrieval/hybridRetrieval";
import { STRONG_DIRECT_LEXICAL } from "../../src/retrieval/hybridScoring";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { fileMatches, symbolMatches } from "./run_stage5_retrieval_eval";

/** The product's ordinary candidate bound. The first rung is deliberately it. */
const PRODUCT_POOL = 25;
const RUNGS = [25, 50, 100, 200, 400, 800] as const;

interface ProbeCase {
  readonly instanceId: string;
  readonly repo: string;
  readonly workspace: string;
  readonly task: string;
  readonly intent: string;
  readonly expectedFiles: readonly string[];
  readonly expectedSymbols: readonly string[];
}

interface RungResult {
  readonly maxResults: number;
  readonly evaluatedTotal: number;
  readonly goldSymbolScored: boolean;
  readonly goldSymbolPreCapRank: number | null;
  readonly goldSymbolScore: number | null;
  readonly goldSymbolSources: readonly string[];
  readonly goldSymbolEvidence: readonly string[];
  readonly goldSymbolFqName: string | null;
}

/**
 * §102 — the control miss that had to be fixed rather than buried.
 *
 * `sympy-13480` DELIVERS its gold symbol `cosh.eval`, yet the escalation probe
 * reports it unscored at every rung. It is right: no hybrid generator scores it.
 * The product reaches it through `computeClassMethodExpansion`, a POST-hybrid
 * lane that synthesizes a method candidate from a class candidate the task names
 * — precisely the case `evaluatedById`'s own contract warns about ("downstream
 * anchor lanes inject a synthesized candidate for a symbol they cannot find in
 * `candidates`").
 *
 * So `UNREACHABLE_BY_GENERATION` must be read as "unreachable by HYBRID
 * generation", never as "unreachable by the product". These fields record the
 * footholds the downstream lanes actually need, so a case where one exists is
 * visibly a different proposition from one where none does.
 */
interface DownstreamFoothold {
  /** The gold symbol's parent (its class, for a method) was scored. */
  readonly parentScored: boolean;
  readonly parentFqName: string | null;
  /** SOME symbol of the gold file was scored — the co-edit/file-evidence hook. */
  readonly siblingScored: boolean;
  readonly bestSiblingRank: number | null;
  /** The raw task names the gold symbol verbatim — the class-method hook. */
  readonly taskNamesGoldSymbol: boolean;
  /** The raw task names `Parent.gold` verbatim, which is what the lane parses. */
  readonly taskNamesQualifiedPair: boolean;
}

export interface GenerationReachRecord {
  readonly instanceId: string;
  readonly repo: string;
  readonly rungs: readonly RungResult[];
  readonly downstreamFoothold: DownstreamFoothold;
  /** The smallest probed pool at which any generator scored the gold symbol. */
  readonly firstReachingPool: number | null;
  /** Its pre-cap rank there — the depth a bound change would have to reach. */
  readonly rankAtFirstReach: number | null;
  readonly scoreAtFirstReach: number | null;
  /** True when no probed pool, up to 32x the product's, ever scored it. */
  readonly unreachable: boolean;
  readonly verdict: "REACHABLE_AT_PRODUCT_POOL" | "REACHABLE_ONLY_DEEPER" | "UNREACHABLE_BY_GENERATION";
}

function deriveSymbolSeeds(shaped: ShapedSweQuery): string[] {
  const seeds: string[] = [];
  for (const identifier of shaped.identifiers) {
    if (/Test/.test(identifier) && /^[A-Z]/.test(identifier)) {
      const subject = identifier.replace(/^Test(?=[A-Z])/, "").replace(/(?:TestCase|Tests|Test)$/, "");
      if (subject.length >= 3) seeds.push(subject);
    } else if (!/^test[_A-Z]/.test(identifier)) {
      seeds.push(identifier);
    }
  }
  return [...new Set(seeds.map((s) => s.trim()).filter((s) => s !== ""))];
}

function extractFailingTests(task: string): string[] {
  const ids = new Set<string>();
  for (const match of task.matchAll(/\b[\w./-]+\.py::[\w:]+/g)) ids.add(match[0]);
  for (const match of task.matchAll(/\b[\w.]+\.[A-Z]\w*\.test_\w+\b/g)) ids.add(match[0]);
  return [...ids];
}

export function probeCase(kase: ProbeCase): GenerationReachRecord {
  const workspace = path.resolve(kase.workspace);
  const db = openIndexerDatabase(path.join(workspace, ".vtrace", "index.sqlite"));
  try {
    const repositoryPaths = createLazyRepositoryPathPredicate(db, { queries: 0 });
    const shaped = shapeSweQuery(
      { problemStatement: kase.task, failToPass: extractFailingTests(kase.task) },
      { projectNameAliases: resolveProjectNameAliases(workspace), isRepositoryPath: repositoryPaths.isRepositoryPath },
    );
    const plan = planIntent(kase.intent as CapsuleIntent, kase.task, shaped);
    const symbolSeeds = deriveSymbolSeeds(shaped);

    const rungs: RungResult[] = [];
    for (const maxResults of RUNGS) {
      const requestCache = createHybridRetrievalRequestCache();
      let retrieval = hybridRetrieve(db, {
        query: shaped.query, shaped, taskText: kase.task, weights: plan.weights,
        symbolSeeds, maxResults, requestCache,
      });
      const hasDirect = retrieval.candidates.some((c) =>
        c.scores.symbol > 0 || c.scores.path > 0 || c.scores.testToImpl > 0
        || c.scores.bodyLiteral > 0 || c.scores.lexical >= STRONG_DIRECT_LEXICAL);
      if (retrieval.candidates.length === 0 || !hasDirect) {
        const rescued = hybridRetrieve(db, {
          query: kase.task, shaped, taskText: kase.task, weights: plan.weights,
          symbolSeeds, maxResults, enableCompoundTaskRescue: true, requestCache,
        });
        if (rescued.candidates.length > 0) retrieval = rescued;
      }

      const evaluated = [...retrieval.evaluatedById.values()].sort((a, b) => b.scores.final - a.scores.final);
      const hit = evaluated
        .map((candidate, index) => ({ candidate, rank: index + 1 }))
        .find(({ candidate }) =>
          kase.expectedFiles.some((f) => fileMatches(f, candidate.filePath))
          && kase.expectedSymbols.some((s) => symbolMatches(s, { symbol: candidate.localName, fqName: candidate.fqName })));

      rungs.push({
        maxResults,
        evaluatedTotal: evaluated.length,
        goldSymbolScored: hit !== undefined,
        goldSymbolPreCapRank: hit?.rank ?? null,
        goldSymbolScore: hit?.candidate.scores.final ?? null,
        goldSymbolSources: hit === undefined ? [] : hit.candidate.sources.map(String),
        goldSymbolEvidence: hit === undefined ? [] : [...hit.candidate.evidence],
        goldSymbolFqName: hit?.candidate.fqName ?? null,
      });
    }

    // Foothold measurement runs against the WIDEST probed pool, so a "no
    // foothold" verdict is the strongest available, not an artefact of the cap.
    const widest = ((): { names: Set<string>; byFile: { fq: string; rank: number }[] } => {
      const requestCache = createHybridRetrievalRequestCache();
      const retrieval = hybridRetrieve(db, {
        query: shaped.query, shaped, taskText: kase.task, weights: plan.weights,
        symbolSeeds, maxResults: RUNGS[RUNGS.length - 1], requestCache,
      });
      const evaluated = [...retrieval.evaluatedById.values()].sort((a, b) => b.scores.final - a.scores.final);
      return {
        names: new Set(evaluated.map((c) => c.fqName)),
        byFile: evaluated
          .map((c, index) => ({ fq: c.fqName, rank: index + 1, filePath: c.filePath }))
          .filter((c) => kase.expectedFiles.some((f) => fileMatches(f, c.filePath)))
          .map(({ fq, rank }) => ({ fq, rank })),
      };
    })();

    const goldRows = db.query<{ id: string; fq_name: string; local_name: string; parent_symbol_id: string | null; path: string }, []>(
      "SELECT s.id, s.fq_name, s.local_name, s.parent_symbol_id, f.path FROM symbols s JOIN files f ON f.id = s.file_id",
    ).all().filter((row) =>
      kase.expectedFiles.some((f) => fileMatches(f, row.path))
      && kase.expectedSymbols.some((sym) => symbolMatches(sym, { symbol: row.local_name, fqName: row.fq_name })));
    const parents = goldRows
      .map((row) => row.parent_symbol_id)
      .filter((id): id is string => id !== null)
      .map((id) => db.query<{ fq_name: string }, [string]>("SELECT fq_name FROM symbols WHERE id = ?").get(id)?.fq_name)
      .filter((fq): fq is string => fq !== undefined);
    const scoredParent = parents.find((fq) => widest.names.has(fq)) ?? null;
    const taskText = kase.task;
    const downstreamFoothold: DownstreamFoothold = {
      parentScored: scoredParent !== null,
      parentFqName: scoredParent,
      siblingScored: widest.byFile.length > 0,
      bestSiblingRank: widest.byFile[0]?.rank ?? null,
      taskNamesGoldSymbol: goldRows.some((row) => new RegExp(`\\b${row.local_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(taskText)),
      taskNamesQualifiedPair: goldRows.some((row) => {
        const parentLocal = row.fq_name.split("::").pop()?.split(".").slice(-2, -1)[0];
        return parentLocal !== undefined && parentLocal !== "" && taskText.includes(`${parentLocal}.${row.local_name}`);
      }),
    };

    const reached = rungs.find((r) => r.goldSymbolScored);
    const atProduct = rungs.find((r) => r.maxResults === PRODUCT_POOL)?.goldSymbolScored === true;
    return {
      instanceId: kase.instanceId,
      repo: kase.repo,
      rungs,
      downstreamFoothold,
      firstReachingPool: reached?.maxResults ?? null,
      rankAtFirstReach: reached?.goldSymbolPreCapRank ?? null,
      scoreAtFirstReach: reached?.goldSymbolScore ?? null,
      unreachable: reached === undefined,
      verdict: atProduct
        ? "REACHABLE_AT_PRODUCT_POOL"
        : reached === undefined ? "UNREACHABLE_BY_GENERATION" : "REACHABLE_ONLY_DEEPER",
    };
  } finally {
    db.close();
  }
}

interface FixtureRow {
  readonly instance_id: string; readonly repo: string; readonly task: string;
  readonly intent: string; readonly expected_files: string[]; readonly expected_symbols: string[];
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const get = (flag: string): string => {
    const index = argv.indexOf(flag);
    const value = index < 0 ? undefined : argv[index + 1];
    if (value === undefined) throw new Error(`${flag} is required.`);
    return value;
  };
  const fixturePath = get("--fixture");
  const corpusRoot = get("--corpus-root");
  const manifestPath = get("--manifest");
  const outPath = get("--out");

  const fixture = (await Bun.file(fixturePath).json()) as readonly FixtureRow[];
  const manifest = (await Bun.file(manifestPath).json()) as { entries: readonly { instanceId: string }[] };
  const byId = new Map(fixture.map((row) => [row.instance_id, row]));

  const records: GenerationReachRecord[] = [];
  const failures: { instanceId: string; error: string }[] = [];
  for (const entry of manifest.entries) {
    const row = byId.get(entry.instanceId);
    if (row === undefined) { failures.push({ instanceId: entry.instanceId, error: "not in fixture" }); continue; }
    try {
      records.push(probeCase({
        instanceId: row.instance_id, repo: row.repo,
        workspace: path.join(corpusRoot, row.instance_id),
        task: row.task, intent: row.intent,
        expectedFiles: row.expected_files, expectedSymbols: row.expected_symbols,
      }));
    } catch (error) {
      failures.push({ instanceId: entry.instanceId, error: String(error) });
    }
  }

  const byVerdict = (v: GenerationReachRecord["verdict"]) => records.filter((r) => r.verdict === v);
  await writeFile(outPath, `${JSON.stringify({
    schemaVersion: "stage5.m159.generation-reach.v1",
    note: "OFFLINE DIAGNOSTIC. Widened pools are evidence about generator reach, never a proposed product bound (§27/§42).",
    corpusRoot,
    productPool: PRODUCT_POOL,
    rungs: RUNGS,
    cases: records.length,
    failures,
    summary: {
      reachableAtProductPool: byVerdict("REACHABLE_AT_PRODUCT_POOL").map((r) => r.instanceId).sort(),
      reachableOnlyDeeper: byVerdict("REACHABLE_ONLY_DEEPER").map((r) => r.instanceId).sort(),
      unreachableByGeneration: byVerdict("UNREACHABLE_BY_GENERATION").map((r) => r.instanceId).sort(),
    },
    records,
  }, null, 2)}\n`, "utf8");

  console.log(JSON.stringify(records.map((r) => ({
    instanceId: r.instanceId, verdict: r.verdict,
    firstReachingPool: r.firstReachingPool, rankAtFirstReach: r.rankAtFirstReach,
    scoreAtFirstReach: r.scoreAtFirstReach === null ? null : Number(r.scoreAtFirstReach.toFixed(3)),
  })), null, 2));
}

if (import.meta.main) {
  await main();
}
