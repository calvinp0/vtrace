// M140-B §8-§10 probe: fresh ARC index, orchestration-path confirmation, and the
// A6 retrieval reproduction.
//
// Every number M140-B's design depends on is MEASURED here rather than inherited
// from an earlier milestone's notes: the committed ARC index has gone stale more
// than once (M139, M132), so the remembered 62/3/1 fan-in profile is re-derived
// against a freshly built, isolated index over the requested ARC worktree.
//
// ARC is read-only. The index lives in a temp/bench directory and ARC's own
// `.vtrace` state is never touched. No agents, Docker, VEXP, network, or paid API.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m140b_arc_probe.ts \
//     [--index <path>] [--reuse-index] [--out <dir>] [--label before|after]

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";

import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { listAllEdges } from "../../src/db/repositories/edgesRepository";
import { listAllFilePaths } from "../../src/db/repositories/filesRepository";
import { listAllSymbols } from "../../src/db/repositories/symbolsRepository";
import { initializeSchema } from "../../src/db/schema";
import { EdgeType, isStructuralSymbolKind, type SymbolRecord } from "../../src/domain/types";
import { indexProject } from "../../src/indexer/indexProject";
import { deriveQueryIntent } from "../../src/retrieval/querySemantics";
import { CapsuleIntent, type CapsuleV2Result } from "../../src/capsuleV2/types";

const ARC_ROOT = path.resolve(process.env.M140B_ARC_ROOT ?? "/home/calvin/code/ARC");
const DEFAULT_INDEX = "/home/calvin/bench/vtrace-m140/m140b/arc-fresh.sqlite";
const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");

/** The exact §35 behavioural query. Never paraphrase it. */
export const ARC_SERIALIZATION_QUERY =
  "How does a species object get its 2D molecular graph when rebuilt from a "
  + "serialized dictionary, and under what conditions is connectivity re-derived "
  + "from Cartesian coordinates rather than taken from the stored adjacency list?";

const ARC_BUDGET_TOKENS = 6_000;

/** The chain §9 requires proving, plus the symbols §35 wants inspected. */
const CHAIN = [
  "arc/species/species.py::ARCSpecies.from_dict",
  "arc/species/species.py::ARCSpecies.mol_from_xyz",
  "arc/species/perceive.py::perceive_molecule_from_xyz",
] as const;

const ALSO_INSPECT = [
  "arc/species/species.py::are_coords_compliant_with_graph",
  "arc/species/species.py::ARCSpecies.as_dict",
  "arc/species/species.py::ARCSpecies.copy",
] as const;

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

export async function buildFreshArcIndex(indexPath: string): Promise<void> {
  await mkdir(path.dirname(indexPath), { recursive: true });
  const db = new Database(indexPath);
  try {
    initializeSchema(db);
    await indexProject({ repoRoot: ARC_ROOT, db });
  } finally {
    db.close();
  }
}

/** §8: index identity, bound to the ARC worktree it was actually built from. */
export function arcIndexIdentity(db: Database, indexPath: string) {
  const symbols = listAllSymbols(db);
  const edges = listAllEdges(db);
  const byKind = new Map<string, number>();
  for (const edge of edges) {
    byKind.set(edge.edgeType, (byKind.get(edge.edgeType) ?? 0) + 1);
  }
  return {
    schemaVersion: "stage5.m140b.arc-index-identity.v1",
    arc: {
      root: ARC_ROOT,
      branch: git(ARC_ROOT, ["rev-parse", "--abbrev-ref", "HEAD"]),
      head: git(ARC_ROOT, ["rev-parse", "HEAD"]),
      // A dirty ARC tree would mean the index does not describe any commit.
      clean: git(ARC_ROOT, ["status", "--porcelain"]).length === 0,
      worktree: git(ARC_ROOT, ["rev-parse", "--show-toplevel"]),
    },
    vtrace: {
      head: git(process.cwd(), ["rev-parse", "HEAD"]),
      branch: git(process.cwd(), ["rev-parse", "--abbrev-ref", "HEAD"]),
    },
    index: {
      path: indexPath,
      files: listAllFilePaths(db).length,
      symbols: symbols.length,
      structuralSymbols: symbols.filter((symbol) => isStructuralSymbolKind(symbol.kind)).length,
      edges: edges.length,
      edgesByKind: Object.fromEntries([...byKind].sort(([a], [b]) => a.localeCompare(b))),
    },
    readOnlySource: true,
  };
}

/**
 * Exact fully-qualified resolution. Deliberately NOT a localName fallback:
 * `arc/species/species.py` defines BOTH `TSGuess.from_dict` and
 * `ARCSpecies.from_dict`, so a local-name match silently resolves to whichever
 * comes first and would report an absent symbol as present.
 */
function resolve(symbols: readonly SymbolRecord[], fqName: string): SymbolRecord | undefined {
  return symbols.find((candidate) => candidate.fqName === fqName);
}

/** §9/§91: the chain, its edge kinds, and the incoming fan-in at each node. */
export function confirmOrchestrationPath(db: Database) {
  const symbols = listAllSymbols(db);
  const edges = listAllEdges(db);
  const wanted = [...CHAIN, ...ALSO_INSPECT];
  const resolved = new Map<string, SymbolRecord | undefined>(
    wanted.map((fqName) => [fqName, resolve(symbols, fqName)]),
  );
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));

  const incomingCallsFanIn = (symbolId: string): { total: number; nonStructural: number } => {
    const incoming = edges.filter((edge) => edge.dstSymbolId === symbolId && edge.edgeType === EdgeType.Calls);
    const nonStructural = incoming.filter((edge) => {
      const source = byId.get(edge.srcSymbolId);
      return source !== undefined && !isStructuralSymbolKind(source.kind);
    });
    return { total: incoming.length, nonStructural: nonStructural.length };
  };
  const incomingAnyKind = (symbolId: string): number =>
    edges.filter((edge) => edge.dstSymbolId === symbolId).length;

  const nodes = wanted.map((fqName) => {
    const symbol = resolved.get(fqName);
    if (symbol === undefined) {
      return { fqName, resolved: false as const };
    }
    const calls = incomingCallsFanIn(symbol.id);
    return {
      fqName,
      resolved: true as const,
      symbolId: symbol.id,
      kind: symbol.kind,
      filePath: symbol.filePath,
      incomingCallsFanIn: calls.total,
      incomingCallsFanInNonStructural: calls.nonStructural,
      incomingAnyKind: incomingAnyKind(symbol.id),
    };
  });

  const link = (fromFq: string, toFq: string) => {
    const from = resolved.get(fromFq);
    const to = resolved.get(toFq);
    if (from === undefined || to === undefined) {
      return { from: fromFq, to: toFq, present: false, kinds: [] as string[] };
    }
    const kinds = [...new Set(edges
      .filter((edge) => edge.srcSymbolId === from.id && edge.dstSymbolId === to.id)
      .map((edge) => edge.edgeType))].sort();
    return { from: fromFq, to: toFq, present: kinds.includes(EdgeType.Calls), kinds };
  };

  const chainLinks = [link(CHAIN[0], CHAIN[1]), link(CHAIN[1], CHAIN[2])];
  return {
    schemaVersion: "stage5.m140b.arc-path-confirmation.v1",
    question: "does the fresh index contain the exact incoming-call orchestration chain?",
    chainVerified: chainLinks.every((entry) => entry.present),
    chain: chainLinks,
    nodes,
    // §35 lists this symbol but M140's groundwork found no direct calls edge from
    // either orchestration hop; re-checked here rather than assumed.
    auxiliaryLinks: [
      link(CHAIN[1], ALSO_INSPECT[0]),
      link(CHAIN[0], ALSO_INSPECT[0]),
    ],
  };
}

export interface CapsuleProjection {
  readonly mode: string;
  readonly reason?: string;
  readonly lead: string | null;
  readonly pivots: readonly string[];
  readonly support: readonly string[];
  readonly selected: readonly string[];
  readonly selectedFiles: readonly string[];
  /** Pre-role candidate ranking, so an omission can be told from a demotion. */
  readonly candidates: ReadonlyArray<{
    rank: number;
    fqName: string;
    path: string;
    final: number;
    sources: readonly string[];
  }>;
}

export function projectCapsule(result: CapsuleV2Result): CapsuleProjection {
  // `fq_name` already carries the path (`arc/species/species.py::ARCSpecies.copy`)
  // and is the only unambiguous identity here; `symbol` alone repeats across classes.
  const ref = (item: { fq_name: string }): string => item.fq_name;
  const items = [...result.pivots, ...result.support];
  return {
    mode: result.actual_mode,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    lead: result.pivots[0] === undefined ? null : ref(result.pivots[0]),
    pivots: result.pivots.map(ref),
    support: result.support.map(ref),
    selected: items.map(ref),
    selectedFiles: [...new Set(items.map((item) => item.path))],
    candidates: (result.diagnostics.candidate_scores ?? []).map((entry) => ({
      rank: entry.rank,
      fqName: entry.fq_name,
      path: entry.path,
      final: entry.scores.final,
      sources: entry.sources,
    })),
  };
}

/**
 * §10: run the exact query and record what retrieval actually produced.
 *
 * Visibility is resolved against the INDEX, never by matching a name suffix.
 * `from_dict`, `as_dict` and `copy` are ambiguous local names across ARC — a
 * suffix match reports `TSGuess.from_dict` as if it were `ARCSpecies.from_dict`
 * and turns an absent symbol into a false positive (the M139 lesson).
 */
export function reproduceArcQuery(db: Database, label: string) {
  const symbols = listAllSymbols(db);
  const intent = deriveQueryIntent(ARC_SERIALIZATION_QUERY);
  const capsule = buildCapsuleV2({
    db,
    repoRoot: ARC_ROOT,
    task: ARC_SERIALIZATION_QUERY,
    intent: CapsuleIntent.Explain,
    maxTokens: ARC_BUDGET_TOKENS,
  });
  const projection = projectCapsule(capsule);
  // Distinguish "never retrieved" from "retrieved but not delivered": only the
  // first is the candidate-generation gap M140-B exists to close.
  const visible = (target: string) => {
    const symbol = resolve(symbols, target);
    if (symbol === undefined) {
      return { resolved: false as const, selected: false, pivot: false, candidateRank: null };
    }
    return {
      resolved: true as const,
      fqName: symbol.fqName,
      selected: projection.selected.includes(symbol.fqName),
      pivot: projection.pivots.includes(symbol.fqName),
      candidateRank: projection.candidates.find((entry) => entry.fqName === symbol.fqName)?.rank ?? null,
    };
  };

  return {
    schemaVersion: "stage5.m140b.arc-retrieval-reproduction.v1",
    label,
    query: ARC_SERIALIZATION_QUERY,
    derivedIntent: {
      kind: intent.kind,
      contrastKind: intent.contrastKind,
      contrastTerms: intent.contrastTerms,
      branchTerms: intent.branchTerms,
      branchClauses: intent.branchClauses.map((clause) => ({
        cue: clause.cue,
        branchCue: clause.branchCue,
        positiveTerms: clause.positiveTerms,
        contrastTerms: clause.contrastTerms,
      })),
      explicitIdentifiers: intent.explicitIdentifiers,
      positiveTerms: intent.positiveTerms.slice(0, 24),
    },
    retrieval: projection,
    visibility: Object.fromEntries(
      [...CHAIN, ...ALSO_INSPECT].map((target) => [target, visible(target)]),
    ),
  };
}

async function main(): Promise<void> {
  const indexPath = argument("--index") ?? DEFAULT_INDEX;
  const outDir = argument("--out") ?? RESULTS;
  const label = argument("--label") ?? "a6_before";
  const reuse = process.argv.includes("--reuse-index") && existsSync(indexPath);

  if (!reuse) {
    process.stdout.write(`indexing ARC -> ${indexPath}\n`);
    await buildFreshArcIndex(indexPath);
  }

  const db = new Database(indexPath, { readonly: true });
  try {
    const identity = arcIndexIdentity(db, indexPath);
    const chain = confirmOrchestrationPath(db);
    const reproduction = reproduceArcQuery(db, label);

    await mkdir(outDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(outDir, "stage5_m140b_arc_fresh_index_identity.json"), `${JSON.stringify(identity, null, 2)}\n`),
      writeFile(path.join(outDir, "stage5_m140b_arc_path_confirmation.json"), `${JSON.stringify(chain, null, 2)}\n`),
      writeFile(path.join(outDir, `stage5_m140b_arc_${label}.json`), `${JSON.stringify(reproduction, null, 2)}\n`),
    ]);

    process.stdout.write(`ARC ${identity.arc.branch}@${identity.arc.head.slice(0, 7)} clean=${identity.arc.clean}\n`);
    process.stdout.write(`index: ${identity.index.files} files, ${identity.index.symbols} symbols, ${identity.index.edges} edges\n`);
    process.stdout.write(`edgesByKind: ${JSON.stringify(identity.index.edgesByKind)}\n`);
    process.stdout.write(`chainVerified=${chain.chainVerified}\n`);
    for (const node of chain.nodes) {
      process.stdout.write(node.resolved
        ? `  ${node.fqName}: callsFanIn=${node.incomingCallsFanIn} (nonStructural=${node.incomingCallsFanInNonStructural}) anyKind=${node.incomingAnyKind}\n`
        : `  ${node.fqName}: UNRESOLVED\n`);
    }
    for (const entry of [...chain.chain, ...chain.auxiliaryLinks]) {
      process.stdout.write(`  edge ${entry.from} -> ${entry.to}: calls=${entry.present} kinds=[${entry.kinds.join(",")}]\n`);
    }
    process.stdout.write(`contrastKind=${reproduction.derivedIntent.contrastKind} contrastTerms=${JSON.stringify(reproduction.derivedIntent.contrastTerms)}\n`);
    process.stdout.write(`mode=${reproduction.retrieval.mode} lead=${reproduction.retrieval.lead}\n`);
    process.stdout.write(`pivots:\n${reproduction.retrieval.pivots.map((entry) => `  * ${entry}`).join("\n")}\n`);
    process.stdout.write(`support:\n${reproduction.retrieval.support.map((entry) => `  - ${entry}`).join("\n")}\n`);
    process.stdout.write(`top candidates:\n${reproduction.retrieval.candidates.slice(0, 12)
      .map((entry) => `  ${entry.rank}. ${entry.path}::${entry.fqName} final=${entry.final.toFixed(3)} [${entry.sources.join(",")}]`).join("\n")}\n`);
    process.stdout.write(`visibility=${JSON.stringify(reproduction.visibility, null, 1)}\n`);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  await main();
}
