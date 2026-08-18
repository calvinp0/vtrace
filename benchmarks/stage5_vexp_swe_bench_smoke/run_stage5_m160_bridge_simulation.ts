/**
 * M160-D §58-§60 — simulate the subject→owner bridge itself, on both corpora.
 *
 * The theory M159 left standing is that a task naming a SUBJECT (a class, an API
 * surface, a behaviour) cannot reach the OWNER that implements it, because no
 * indexed relation bridges the two. That is a hypothesis about a missing lane,
 * and §58 forbids recommending product work for it without simulating the lane
 * first — M158's whole lesson is that a correctly diagnosed mechanism can still
 * recover nothing.
 *
 * The lane simulated here is the most favourable concrete form of the theory:
 *
 *     for every class the query names, admit its members as candidates,
 *     INCLUDING members inherited from its base classes.
 *
 * Inheritance is the load-bearing half. scikit-learn-13142 is the canonical
 * shape: the task names `GaussianMixture`, the gold is `BaseMixture.fit_predict`,
 * and `GaussianMixture` does not define `fit_predict` at all — it inherits it. A
 * bridge that only walked a class's own members would miss it.
 *
 * Recovery is counted generously: the lane is credited if it would produce the
 * gold symbol as a candidate AT ALL, ignoring where it would rank. Harm is
 * counted as the candidate volume the lane admits, because a lane that recovers
 * three cases by admitting three hundred candidates per case is not a fix.
 *
 * Simulation only. Changes NO product code, adds NO lane, writes NO index.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { fileMatches } from "./run_stage5_retrieval_eval";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const RESULTS = path.join(import.meta.dir, "results");

interface CaseTrace {
  readonly instanceId: string;
  readonly repo: string;
  readonly expectedFiles: readonly string[];
  readonly expectedSymbols: readonly string[];
  readonly query: { readonly identifiers: readonly string[] };
  readonly firstDivergence: string;
  readonly delivery: { readonly goldFileDelivered: boolean };
}

interface BridgeResult {
  readonly instanceId: string;
  readonly repo: string;
  readonly namedClasses: readonly string[];
  readonly ownMembers: number;
  readonly inheritedMembers: number;
  readonly candidatesAdmitted: number;
  readonly goldRecovered: boolean;
  readonly goldRecoveredVia: "own_member" | "inherited_member" | null;
  readonly detail: string;
}

/** Classes the query names that the index actually represents. */
function namedClasses(db: Database, identifiers: readonly string[]): Array<{ id: string; fqName: string }> {
  const out: Array<{ id: string; fqName: string }> = [];
  for (const identifier of identifiers) {
    const rows = db
      .query<{ id: string; fq_name: string }, [string]>(
        `SELECT id, fq_name FROM symbols WHERE local_name = ? AND kind = 'class'`,
      )
      .all(identifier);
    out.push(...rows.map((row) => ({ id: row.id, fqName: row.fq_name })));
  }
  return out;
}

/** Members defined directly on a class: symbols whose fq_name is `<class fq>.<name>`. */
function ownMembers(db: Database, classFqName: string): Array<{ id: string; fqName: string; path: string; local: string }> {
  return db
    .query<{ id: string; fq_name: string; path: string; local_name: string }, [string, string]>(
      `SELECT s.id AS id, s.fq_name AS fq_name, f.path AS path, s.local_name AS local_name
       FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE s.fq_name LIKE ? AND s.fq_name != ?`,
    )
    .all(`${classFqName}.%`, classFqName)
    .map((row) => ({ id: row.id, fqName: row.fq_name, path: row.path, local: row.local_name }));
}

/**
 * Base classes reachable from a class through the index's own relations.
 *
 * The index does not label inheritance distinctly at this layer, so the walk
 * follows any outbound edge from the class symbol and keeps the endpoints that
 * are themselves classes. That is deliberately GENEROUS — over-counting bases can
 * only help the intervention, so a zero recovery under this walk is a stronger
 * refutation than a zero under a stricter one.
 */
function baseClasses(db: Database, classId: string, depth: number): Array<{ id: string; fqName: string }> {
  const seen = new Set<string>([classId]);
  let frontier = [classId];
  const bases: Array<{ id: string; fqName: string }> = [];
  for (let level = 0; level < depth; level += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      const rows = db
        .query<{ id: string; fq_name: string }, [string]>(
          `SELECT s.id AS id, s.fq_name AS fq_name FROM edges e JOIN symbols s ON s.id = e.dst_symbol_id
           WHERE e.src_symbol_id = ? AND s.kind = 'class'`,
        )
        .all(id);
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        bases.push({ id: row.id, fqName: row.fq_name });
        next.push(row.id);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return bases;
}

function simulateCase(trace: CaseTrace, corpusRoot: string): BridgeResult {
  const workspace = path.resolve(corpusRoot, trace.instanceId);
  const db = openIndexerDatabase(path.join(workspace, ".vtrace", "index.sqlite"));
  try {
    const classes = namedClasses(db, trace.query.identifiers);
    const goldLocals = new Set(trace.expectedSymbols.map((symbol) => symbol.split(".").pop() ?? symbol));

    let own = 0;
    let inherited = 0;
    let recovered: BridgeResult["goldRecoveredVia"] = null;
    const matches = (member: { path: string; local: string }): boolean =>
      goldLocals.has(member.local) && trace.expectedFiles.some((file) => fileMatches(file, member.path));

    for (const klass of classes) {
      const members = ownMembers(db, klass.fqName);
      own += members.length;
      if (recovered === null && members.some(matches)) recovered = "own_member";
      for (const base of baseClasses(db, klass.id, 3)) {
        const baseMembers = ownMembers(db, base.fqName);
        inherited += baseMembers.length;
        if (recovered === null && baseMembers.some(matches)) recovered = "inherited_member";
      }
    }

    return {
      instanceId: trace.instanceId,
      repo: trace.repo,
      namedClasses: classes.map((c) => c.fqName).slice(0, 8),
      ownMembers: own,
      inheritedMembers: inherited,
      candidatesAdmitted: own + inherited,
      goldRecovered: recovered !== null,
      goldRecoveredVia: recovered,
      detail:
        classes.length === 0
          ? "the query names no class the index represents — the bridge has no starting point"
          : `${classes.length} named class(es); ${own} own + ${inherited} inherited members admitted`,
    };
  } finally {
    db.close();
  }
}

async function analyse(tracesPath: string, corpusRoot: string, targetSubtypes: ReadonlySet<string>, subtypeByInstance: Map<string, string>) {
  const doc = JSON.parse(await readFile(tracesPath, "utf8")) as { traces: CaseTrace[] };
  const targets: BridgeResult[] = [];
  const negatives: BridgeResult[] = [];
  for (const trace of doc.traces) {
    if (trace.firstDivergence !== "LANE_GENERATION_FAILURE") continue;
    const subtype = subtypeByInstance.get(trace.instanceId) ?? "";
    const result = simulateCase(trace, corpusRoot);
    if (targetSubtypes.has(subtype)) targets.push(result);
    else negatives.push(result);
  }
  return { targets, negatives };
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    return index < 0 ? fallback : (argv[index + 1] ?? fallback);
  };
  const subtypesPath = get("--subtypes", path.join(RESULTS, "stage5_m160_lane_generation_subtypes.json"));
  const aTraces = get("--a-traces", path.join(RESULTS, "stage5_m159_case_traces.json"));
  const aRoot = get("--a-corpus-root", "/home/calvin/bench/vtrace-m156/targets/m156");
  const bTraces = get("--b-traces", path.join(RESULTS, "stage5_m160_broad100b_case_traces.json"));
  const bRoot = get("--b-corpus-root", path.join(RESULTS, "workspaces", "m160_broad_b"));
  const outPath = get("--out", path.join(RESULTS, "stage5_m160_bridge_simulation.json"));

  const subtypes = JSON.parse(await readFile(subtypesPath, "utf8")) as {
    broad100a: { evidence: Array<{ instanceId: string; subtype: string }> };
    broad100b: { evidence: Array<{ instanceId: string; subtype: string }> };
  };
  const TARGET = new Set(["SUBJECT_OWNER", "RESULT_EFFECT", "SUBJECT_OWNER + RESULT_EFFECT"]);
  const aMap = new Map(subtypes.broad100a.evidence.map((e) => [e.instanceId, e.subtype]));
  const bMap = new Map(subtypes.broad100b.evidence.map((e) => [e.instanceId, e.subtype]));

  const a = await analyse(aTraces, aRoot, TARGET, aMap);
  const b = await analyse(bTraces, bRoot, TARGET, bMap);

  const summarize = (side: { targets: BridgeResult[]; negatives: BridgeResult[] }) => ({
    targets: side.targets.length,
    recovered: side.targets.filter((r) => r.goldRecovered).length,
    recoveredInstances: side.targets.filter((r) => r.goldRecovered).map((r) => r.instanceId),
    recoveredRepos: [...new Set(side.targets.filter((r) => r.goldRecovered).map((r) => r.repo))].sort(),
    viaInheritance: side.targets.filter((r) => r.goldRecoveredVia === "inherited_member").length,
    noStartingPoint: side.targets.filter((r) => r.namedClasses.length === 0).length,
    medianCandidatesAdmitted:
      side.targets.length === 0
        ? 0
        : [...side.targets.map((r) => r.candidatesAdmitted)].sort((x, y) => x - y)[Math.floor(side.targets.length / 2)],
    maxCandidatesAdmitted: side.targets.reduce((max, r) => Math.max(max, r.candidatesAdmitted), 0),
    nonTargetCandidatesAdmitted: side.negatives.reduce((sum, r) => sum + r.candidatesAdmitted, 0),
  });

  const aSummary = summarize(a);
  const bSummary = summarize(b);
  const recommend = aSummary.recovered > 0 && bSummary.recovered > 0 && bSummary.recoveredRepos.length >= 2;

  const doc = {
    schemaVersion: "stage5.m160.bridge-simulation.v1",
    milestone: "M160",
    kind: "simulation of the subject→owner bridge lane on both corpora (§58-§60)",
    intervention: {
      id: "SUBJECT_OWNER_BRIDGE",
      describe:
        "admit as candidates the members of every class the query names, including members inherited from base classes",
      generosity:
        "recovery is credited if the lane would produce the gold symbol at all, regardless of rank; base-class " +
        "resolution follows any outbound class-to-class edge, which over-counts bases. A zero under these terms " +
        "is a strong refutation.",
      productChanged: false,
    },
    broad100a: { ...aSummary, cases: a.targets },
    broad100b: { ...bSummary, cases: b.targets },
    harm: {
      note:
        "candidatesAdmitted is the volume this lane injects per case. The product's ordinary pool is 25, so a " +
        "lane admitting hundreds of members per case would dominate the capsule rather than supplement it.",
      broad100aNonTargetVolume: aSummary.nonTargetCandidatesAdmitted,
      broad100bNonTargetVolume: bSummary.nonTargetCandidatesAdmitted,
    },
    crossCorpusVerdict: recommend
      ? "RECOVERS_BOTH_CORPORA"
      : aSummary.recovered > 0 && bSummary.recovered === 0
        ? "REJECTED_CORPUS_SPECIFIC"
        : aSummary.recovered === 0 && bSummary.recovered === 0
          ? "REJECTED_BOTH_CORPORA"
          : "INSUFFICIENT_BREADTH",
    recommend,
  };

  await writeFile(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  console.log(`subject→owner bridge simulation -> ${path.relative(REPO_ROOT, outPath)}`);
  console.log(`  Broad100-A: recovered ${aSummary.recovered}/${aSummary.targets} across ${aSummary.recoveredRepos.length} repos (no starting point: ${aSummary.noStartingPoint})`);
  console.log(`  Broad100-B: recovered ${bSummary.recovered}/${bSummary.targets} across ${bSummary.recoveredRepos.length} repos (no starting point: ${bSummary.noStartingPoint})`);
  console.log(`  candidate volume: A median ${aSummary.medianCandidatesAdmitted} max ${aSummary.maxCandidatesAdmitted} · B median ${bSummary.medianCandidatesAdmitted} max ${bSummary.maxCandidatesAdmitted}`);
  console.log(`  verdict: ${doc.crossCorpusVerdict}`);
}

if (import.meta.main) {
  await main();
}
