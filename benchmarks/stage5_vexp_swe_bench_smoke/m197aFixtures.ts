/**
 * M197A — frozen measurement fixtures and corpus preparation.
 *
 * Two rules govern everything here.
 *
 * 1. Fixtures that must be AUTHORED (the task queries) are written down once and
 *    never edited after a measurement, because a query set tuned against a
 *    result is a way of choosing the answer.
 * 2. Fixtures that can be DERIVED (impact symbols, flow pairs, sampled call
 *    edges) are derived deterministically from the index by a stated ordering,
 *    never hand-picked. Hand-picking a symbol that happens to have callers is
 *    how a latency benchmark quietly becomes a benchmark of the author's taste.
 */
import type { Database } from "bun:sqlite";
import { cpSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

/** Directories the corpus copy never carries; mirrors the M196A audit. */
export const SKIP_DIRS = new Set([
  ".git", ".vtrace", "node_modules", "__pycache__", ".venv", "venv",
]);

export interface CorpusSpec {
  readonly id: string;
  readonly source: string;
  readonly language: string;
  /** Extensions the corpus is DECLARED to be made of (A8's raw denominator). */
  readonly exts: readonly string[];
  /** The eligible count frozen by the preregistration, §1. */
  readonly frozenEligible: number;
}

export function corpusSpecs(repoRoot: string): readonly CorpusSpec[] {
  return [
    { id: "C-SMALL", source: "/home/calvin/code/vexp-swe-bench/src", language: "TypeScript",
      exts: [".ts", ".tsx"], frozenEligible: 21 },
    { id: "C-MED", source: path.join(repoRoot, "src"), language: "TypeScript",
      exts: [".ts", ".tsx"], frozenEligible: 492 },
    { id: "C-LARGE", source: "/home/calvin/code/ARC", language: "Python",
      exts: [".py"], frozenEligible: 276 },
  ];
}

/**
 * Copy a corpus read-only into scratch. Indexing writes a `.vtrace/` directory
 * into the repository root, so measuring ARC or the competitor checkout in place
 * would mutate an unrelated repository as a side effect of a benchmark.
 */
export function prepareCorpus(spec: CorpusSpec, scratch: string): string | null {
  if (!existsSync(spec.source)) return null;
  const work = path.join(scratch, spec.id);
  if (!existsSync(work)) {
    cpSync(spec.source, work, {
      recursive: true, dereference: false,
      filter: (src) => !SKIP_DIRS.has(path.basename(src)),
    });
  }
  return work;
}

/**
 * Every file on disk carrying an extension the corpus is declared to be made of.
 * Deliberately independent of the product's own enumeration: agreeing with the
 * thing under test is not evidence.
 */
export function sourceFilesOnDisk(root: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (exts.some((e) => entry.name.endsWith(e))) out.push(path.relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

// --------------------------------------------------------------- authored sets

/**
 * The 20 C-MED tasks for A11/A13, authored once. They span retrieval, indexing,
 * parsing, budget, MCP and capsule subsystems so a degradation curve is not
 * measured on twenty rephrasings of one query.
 */
export const A13_TASKS: readonly string[] = [
  "where are import edges extracted from typescript",
  "how does the indexer decide a file is eligible for parsing",
  "budget allocation for capsule items is dropping sections",
  "how is the impact graph bounded when a symbol has many callers",
  "where does logic flow decide a path is unreachable",
  "how are skeleton declarations built from indexed symbols",
  "what determines whether the repository index is considered fresh",
  "how does hybrid scoring combine lexical and graph signals",
  "where is the MCP tool registry assembled",
  "how does the python parser resolve module imports",
  "what writes the index manifest after a run",
  "how are worktrees excluded from the parent repository index",
  "where does the product context decide which files are pivots",
  "how does the response envelope shed content under budget pressure",
  "what deduplicates supporting files in the capsule",
  "how does cython parsing differ from python parsing",
  "where are call sites persisted for an edge",
  "how does search rank candidate symbols for a task",
  "what happens when the index schema version is incompatible",
  "how is a symbol's fully qualified name constructed",
];

/** A5 warm-latency queries, per corpus language. */
export const A5_QUERIES: Readonly<Record<string, readonly string[]>> = {
  "C-SMALL": [
    "how is the agent turn loop driven",
    "where is the final patch extracted from the run",
    "how are swe-bench instances loaded",
    "what builds the prompt sent to the model",
    "how is a run result written to disk",
  ],
  "C-MED": A13_TASKS.slice(0, 5),
  "C-LARGE": [
    "how is a reaction scheduled onto the job queue",
    "where is the level of theory validated",
    "how are species parsed from the input file",
    "what determines that a job has converged",
    "how is the output of a quantum chemistry job parsed",
  ],
};

// ------------------------------------------------------------- derived sets

/**
 * Impact targets: the symbols with the most incoming `calls` edges, ordered by
 * count then FQN. Deterministic, and biased toward symbols that actually have an
 * impact graph to compute — the opposite of a leaf symbol whose latency measures
 * nothing but the lookup.
 */
export function deriveImpactTargets(db: Database, limit: number): string[] {
  return (db.query(`
    select s.fq_name as fqn, count(*) as c
    from edges e join symbols s on s.id = e.dst_symbol_id
    where e.edge_type = 'calls'
    group by s.fq_name
    order by c desc, s.fq_name asc
    limit ?1`).all(limit) as { fqn: string }[]).map((r) => r.fqn);
}

export interface FlowPair { readonly start: string; readonly end: string }

/**
 * Flow fixtures: `calls` edges ordered by edge id, so the sample is stable and
 * independent of how the graph happens to be shaped. Path length is reported per
 * pair by the caller — §18 requires that a set of one-edge paths cannot pass for
 * a representative flow measurement.
 */
export function deriveFlowPairs(db: Database, limit: number): FlowPair[] {
  return (db.query(`
    select ss.fq_name as start, ds.fq_name as end
    from edges e
    join symbols ss on ss.id = e.src_symbol_id
    join symbols ds on ds.id = e.dst_symbol_id
    where e.edge_type = 'calls' and ss.fq_name <> ds.fq_name
    order by e.id
    limit ?1`).all(limit) as FlowPair[]);
}

/**
 * A15's eligible population: `calls` edges carrying at least one persisted call
 * site. An edge with no recorded occurrence is not a call site VTRACE declined to
 * render; it is a call site VTRACE never had, and counting it would understate
 * the rendering rate on a technicality.
 */
export function deriveCallSiteEdges(db: Database, limit: number): FlowPair[] {
  return (db.query(`
    select ss.fq_name as start, ds.fq_name as end
    from edges e
    join edge_call_sites cs on cs.edge_id = e.id and cs.ordinal = 0
    join symbols ss on ss.id = e.src_symbol_id
    join symbols ds on ds.id = e.dst_symbol_id
    where e.edge_type = 'calls' and ss.fq_name <> ds.fq_name
    order by e.id
    limit ?1`).all(limit) as FlowPair[]);
}

// -------------------------------------------------------------- conventions

/**
 * The frozen tokenizer (§2): `ceil(characters / 4)`. No real tokenizer is
 * available offline. It is applied identically to both sides of every ratio, and
 * every reduction it produces is an approximation, labelled as one.
 */
export function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx]!;
}

export function latencyStats(values: readonly number[]) {
  return {
    n: values.length,
    median: +median(values).toFixed(2),
    p90: +percentile(values, 0.9).toFixed(2),
    p95: +percentile(values, 0.95).toFixed(2),
    max: values.length === 0 ? null : +Math.max(...values).toFixed(2),
    min: values.length === 0 ? null : +Math.min(...values).toFixed(2),
  };
}
