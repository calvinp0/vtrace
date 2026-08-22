/**
 * M169-E — is selective invocation even plausible?
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m169_predictors.ts
 *
 * No router is built (§51). The question is narrower and comes first: do the
 * tasks where the pipeline paid for itself differ, in information available
 * BEFORE it was invoked, from the tasks where it did not?
 *
 * Discipline that makes the answer worth having:
 *   - the families were frozen before any economic class existed (§46);
 *   - every family tested is reported, nulls included (§45);
 *   - nothing is fitted (§43) — group medians and a rank statistic, no model;
 *   - promising features are shown against two untouched corpora (§47), so a
 *     rule that only describes twelve tasks is visible as such.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  FAMILY_TIERS,
  FeatureFamily,
  retrievalAmbiguity,
  separation,
  taskExplicitness,
  type Separation,
} from "./m169Features";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const RUNS = path.join(RESULTS, "runs");
const DATASET = path.join(RESULTS, "_m160_corpus", "swe_bench_verified.jsonl");

const economics = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m169_economic_classes.json"), "utf-8")) as {
  rows: Record<string, any>[];
};

// ── the pre-treatment inputs ────────────────────────────────────────

/**
 * The RAW problem statement, not the task string the agent composed.
 *
 * The composed string is post-treatment: the agent wrote it after reading the
 * problem and deciding what to ask for. Using it as a "pre-invocation" feature
 * would smuggle the agent's own judgement into a router input.
 */
const problemStatements = new Map<string, string>();
if (existsSync(DATASET)) {
  for (const line of readFileSync(DATASET, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line) as { instance_id: string; problem_statement?: string };
    problemStatements.set(row.instance_id, String(row.problem_statement ?? ""));
  }
}

function rankingFor(instanceId: string): Record<string, any>[] | null {
  const label = readdirSync(RUNS).find((l) => l.startsWith("m168_vtrace_clean_")
    && existsSync(path.join(RUNS, l, "raw", "vtrace", "_capsule_v2_ranking.json"))
    && (JSON.parse(readFileSync(path.join(RUNS, l, "raw", "vtrace", "_capsule_v2_ranking.json"), "utf-8")) as { instanceId: string }).instanceId === instanceId);
  if (label === undefined) return null;
  const doc = JSON.parse(readFileSync(path.join(RUNS, label, "raw", "vtrace", "_capsule_v2_ranking.json"), "utf-8")) as { topItems?: Record<string, any>[] };
  return doc.topItems ?? null;
}

/**
 * Repository scale, counted from the index the workspace carries.
 *
 * `index.meta.json` has a `manifest`, but it is a provenance object, not a file
 * list — counting its keys returns 7 for every repository in the corpus, which
 * is what a uniform-label smell looks like (§71). The counts come from the
 * index tables instead. The database is opened READ-ONLY: M169 changes no state.
 */
function repositoryScale(instanceId: string): { indexedFiles: number | null; indexedSymbols: number | null } {
  const label = `m168_vtrace_clean_${instanceId.replace(/[^A-Za-z0-9]/g, "_")}`;
  const database = path.join(RESULTS, "workspaces", label, instanceId, ".vtrace", "index.sqlite");
  if (!existsSync(database)) return { indexedFiles: null, indexedSymbols: null };
  try {
    const db = new Database(database, { readonly: true });
    const files = (db.query("select count(*) as n from files").get() as { n: number }).n;
    const symbols = (db.query("select count(*) as n from symbols").get() as { n: number }).n;
    db.close();
    return { indexedFiles: files, indexedSymbols: symbols };
  } catch {
    return { indexedFiles: null, indexedSymbols: null };
  }
}

/** Delivered breadth, read from the M169-D default rung rather than recomputed. */
function deliveredBreadth(instanceId: string): { deliveredPivots: number | null; deliveredDistinctFiles: number | null } {
  const file = path.join(RESULTS, "stage5_m169_dose_simulation_m168.json");
  if (!existsSync(file)) return { deliveredPivots: null, deliveredDistinctFiles: null };
  const doc = JSON.parse(readFileSync(file, "utf-8")) as { perCase: { instanceId: string; rungs: Record<string, any>[] }[] };
  const kase = doc.perCase.find((c) => c.instanceId === instanceId);
  const rung = kase?.rungs.find((r) => r.budget === "DEFAULT");
  if (rung === undefined || rung.status !== "PARSED") return { deliveredPivots: null, deliveredDistinctFiles: null };
  return { deliveredPivots: rung.pivots as number, deliveredDistinctFiles: (rung.pivots as number) + (rung.support as number) };
}

const features = economics.rows.map((row) => {
  const instanceId = row.instanceId as string;
  const statement = problemStatements.get(instanceId) ?? "";
  const ranking = rankingFor(instanceId);
  return {
    instanceId,
    measurable: row.measurable as boolean,
    economicClass: row.economicClass as string,
    economicClassGenerous: row.economicClassGenerous as string,
    displacedUsd: row.displacedUsd as number | null,
    displacedAnything: typeof row.displacedUsd === "number" && row.displacedUsd > 0.005,
    problemStatementAvailable: statement.length > 0,
    taskExplicitness: taskExplicitness(statement),
    repositoryScale: repositoryScale(instanceId),
    retrievalAmbiguity: ranking === null ? null : retrievalAmbiguity(ranking),
    expectedImpactBreadth: deliveredBreadth(instanceId),
  };
});

// ── separation against the economic label ───────────────────────────

/**
 * The grouping is DISPLACED_SOMETHING vs DISPLACED_NOTHING rather than the
 * four economic classes, for one reason: under the primary denominator ten of
 * eleven tasks are the same class, and a split with one member on a side cannot
 * separate anything. The binary asks the question a router would actually
 * face — was there any investigation here worth replacing?
 */
const measurable = features.filter((f) => f.measurable);
const displaced = measurable.filter((f) => f.displacedAnything);
const notDisplaced = measurable.filter((f) => !f.displacedAnything);

interface Candidate { readonly name: string; readonly family: FeatureFamily; readonly pick: (f: typeof features[number]) => number | null }

const CANDIDATES: readonly Candidate[] = [
  { name: "taskCharacters", family: FeatureFamily.TaskExplicitness, pick: (f) => f.taskExplicitness.characters },
  { name: "explicitFilePaths", family: FeatureFamily.TaskExplicitness, pick: (f) => f.taskExplicitness.explicitFilePaths },
  { name: "distinctExplicitFilePaths", family: FeatureFamily.TaskExplicitness, pick: (f) => f.taskExplicitness.distinctExplicitFilePaths },
  { name: "codeIdentifiers", family: FeatureFamily.TaskExplicitness, pick: (f) => f.taskExplicitness.codeIdentifiers },
  { name: "tracebackPresent", family: FeatureFamily.TaskExplicitness, pick: (f) => (f.taskExplicitness.tracebackPresent ? 1 : 0) },
  { name: "namedDefinitionPresent", family: FeatureFamily.TaskExplicitness, pick: (f) => (f.taskExplicitness.namedDefinitionPresent ? 1 : 0) },
  { name: "codeFencePresent", family: FeatureFamily.TaskExplicitness, pick: (f) => (f.taskExplicitness.codeFencePresent ? 1 : 0) },
  { name: "indexedFiles", family: FeatureFamily.RepositoryScale, pick: (f) => f.repositoryScale.indexedFiles },
  { name: "indexedSymbols", family: FeatureFamily.RepositoryScale, pick: (f) => f.repositoryScale.indexedSymbols },
  { name: "rankingCandidates", family: FeatureFamily.RetrievalAmbiguity, pick: (f) => f.retrievalAmbiguity?.candidates ?? null },
  { name: "scoreMargin", family: FeatureFamily.RetrievalAmbiguity, pick: (f) => f.retrievalAmbiguity?.scoreMargin ?? null },
  { name: "nearTopCandidates", family: FeatureFamily.RetrievalAmbiguity, pick: (f) => f.retrievalAmbiguity?.nearTopCandidates ?? null },
  { name: "distinctFilesInTopTen", family: FeatureFamily.RetrievalAmbiguity, pick: (f) => f.retrievalAmbiguity?.distinctFilesInTopTen ?? null },
  { name: "deliveredPivots", family: FeatureFamily.ExpectedImpactBreadth, pick: (f) => f.expectedImpactBreadth.deliveredPivots },
  { name: "deliveredDistinctFiles", family: FeatureFamily.ExpectedImpactBreadth, pick: (f) => f.expectedImpactBreadth.deliveredDistinctFiles },
];

const separations: Separation[] = CANDIDATES.map((candidate) => separation(
  candidate.name,
  candidate.family,
  "DISPLACED_SOMETHING",
  displaced.map(candidate.pick).filter((v): v is number => v !== null),
  "DISPLACED_NOTHING",
  notDisplaced.map(candidate.pick).filter((v): v is number => v !== null),
));

// ── cross-corpus distribution of the PRE_INVOCATION features (§47) ──

function corpusStatements(fixtureFile: string): { instanceId: string; text: string }[] {
  const file = path.join(RESULTS, "..", fixtureFile);
  if (!existsSync(file)) return [];
  const rows = JSON.parse(readFileSync(file, "utf-8")) as { instance_id: string }[];
  return rows.map((row) => ({ instanceId: row.instance_id, text: problemStatements.get(row.instance_id) ?? "" }))
    .filter((row) => row.text.length > 0);
}

const quantile = (values: readonly number[], q: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]!;
};

const CORPORA: Record<string, { instanceId: string; text: string }[]> = {
  "M168-12": features.map((f) => ({ instanceId: f.instanceId, text: problemStatements.get(f.instanceId) ?? "" })).filter((r) => r.text.length > 0),
  "Broad100-A": corpusStatements("retrieval_eval.m155_broad_100.json"),
  "Broad100-B": corpusStatements("retrieval_eval.m160_broad_b.json"),
};

const distribution = Object.entries(CORPORA).map(([corpus, rows]) => {
  const explicitness = rows.map((row) => taskExplicitness(row.text));
  const stat = (pick: (e: ReturnType<typeof taskExplicitness>) => number) => ({
    p10: quantile(explicitness.map(pick), 0.1),
    median: quantile(explicitness.map(pick), 0.5),
    p90: quantile(explicitness.map(pick), 0.9),
  });
  return {
    corpus,
    cases: rows.length,
    taskCharacters: stat((e) => e.characters),
    distinctExplicitFilePaths: stat((e) => e.distinctExplicitFilePaths),
    codeIdentifiers: stat((e) => e.codeIdentifiers),
    tracebackPresentPercent: rows.length === 0 ? null
      : Number(((100 * explicitness.filter((e) => e.tracebackPresent).length) / rows.length).toFixed(1)),
    namedDefinitionPresentPercent: rows.length === 0 ? null
      : Number(((100 * explicitness.filter((e) => e.namedDefinitionPresent).length) / rows.length).toFixed(1)),
    noExplicitFilePathPercent: rows.length === 0 ? null
      : Number(((100 * explicitness.filter((e) => e.distinctExplicitFilePaths === 0).length) / rows.length).toFixed(1)),
  };
});

const document = {
  schemaVersion: "stage5.m169.predictor-audit.v1",
  milestone: "M169",
  workstream: "M169-E",
  familyFreeze: {
    families: Object.keys(FAMILY_TIERS),
    tiers: FAMILY_TIERS,
    provenance: "frozen in stage5_m169_plan.md before any economic class existed (§46)",
    forbiddenInputs: [
      "grader outcome", "gold file or symbol", "historical CLEAN success",
      "observed BASELINE searches or cost", "any post-treatment agent behaviour",
      "the task string the agent itself composed",
    ],
  },
  grouping: {
    definition: "DISPLACED_SOMETHING = the paired pre-edit investigation reduction exceeded $0.005",
    reason: "Under the primary denominator ten of eleven tasks share one economic class; a split with one member on a side cannot separate anything. The binary is the question a router would face.",
    displaced: displaced.map((f) => f.instanceId),
    notDisplaced: notDisplaced.map((f) => f.instanceId),
  },
  candidatesTested: CANDIDATES.map((c) => c.name),
  separations,
  crossCorpusDistribution: distribution,
  perTask: features,
};

writeFileSync(path.join(RESULTS, "stage5_m169_predictor_audit.json"), `${JSON.stringify(document, null, 2)}\n`);
console.log("wrote stage5_m169_predictor_audit.json\n");
console.log(`groups: DISPLACED_SOMETHING ${displaced.length} (${displaced.map((f) => f.instanceId.split("__")[1]).join(", ")})`);
console.log(`        DISPLACED_NOTHING   ${notDisplaced.length} (${notDisplaced.map((f) => f.instanceId.split("__")[1]).join(", ")})\n`);
console.log(`${"feature".padEnd(28)} ${"tier".padEnd(15)} ${"medA".padStart(9)} ${"medB".padStart(9)} ${"stat".padStart(6)}  verdict`);
for (const row of separations) {
  console.log(`${row.feature.padEnd(28)} ${row.tier.padEnd(15)} ${String(row.medianA ?? "-").padStart(9)} ${String(row.medianB ?? "-").padStart(9)} `
    + `${String(row.rankOverlapStatistic ?? "-").padStart(6)}  ${row.verdict}`);
}
console.log("\ncross-corpus PRE_INVOCATION distribution:");
for (const row of distribution) {
  console.log(`  ${row.corpus.padEnd(12)} n=${String(row.cases).padStart(3)}  chars p50=${row.taskCharacters.median}  `
    + `files p50=${row.distinctExplicitFilePaths.median}  noPath=${row.noExplicitFilePathPercent}%  traceback=${row.tracebackPresentPercent}%`);
}
