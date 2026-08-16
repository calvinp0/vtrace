// M153-C2-A: where, exactly, does the behavioural chain break?
//
// The M153-A baseline established THAT off-ARC behavioural retrieval fails (1 of
// 30 correct implementations at oracle). "Retrieval is weak" is not a finding
// anybody can act on, so this walks each frozen case through the chain stage by
// stage and records the FIRST stage that failed:
//
//   ACTIVATION      no behavioural operation derived from the query
//   REPRESENTATION  the ground-truth implementation carries no usable fact
//   CANDIDATE       facts exist but the generator admitted nothing
//   SUBJECT         admitted, but the expected owner was rejected for subject
//   ROLE_DELIVERY   admitted as a candidate and still not delivered
//   GROUND_TRUTH    the expected symbol is not in the index at all
//
// The stages are ordered because they gate each other: a representation failure
// behind an activation failure is invisible until activation is fixed, so only
// the FIRST failing stage is attributed as primary and the rest are recorded as
// observations rather than causes.
//
// Reads only. Changes nothing. Runs against whatever implementation is checked
// out, so it can be re-run after each C2 change to show the taxonomy moving.
//
//   bun run_stage5_m153_failure_taxonomy.ts [--label <name>] [--out <dir>]
//
// No agent, Docker, VEXP, network or paid API.

import { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveIndexDbPath } from "../../src/indexer/indexMeta";
import { deriveQueryIntent } from "../../src/retrieval/querySemantics";
import {
  deriveBehavioralObjective,
  hasBehavioralOperation,
} from "../../src/retrieval/behavioralObjective";
import { generateOperationFactCandidates } from "../../src/retrieval/operationFactCandidates";
import { COMPATIBILITY } from "../../src/retrieval/mechanismEvidence";

import {
  BEHAVIORAL_CASES,
  CORPUS_REPOSITORIES,
  splitOf,
  type BehavioralCase,
} from "./behavioralCrossRepoCorpus";
import { repoRootFor } from "./m153BehavioralHarness";

/**
 * Measured oracle outcomes, when a matching run exists. Without them the last
 * stage in the chain is unfalsifiable: a case whose candidate was admitted looks
 * like a delivery failure whether or not it actually succeeded. `rq_adapter_selection`
 * is exactly that case — it is the one oracle success in the corpus.
 */
function loadOracleOutcomes(dir: string, runLabel: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  try {
    const file = Bun.file(path.join(dir, `stage5_m153_${runLabel}_oracle_baseline.json`));
    const parsed = JSON.parse(require("node:fs").readFileSync(file.name!, "utf8"));
    for (const row of parsed.cases ?? []) {
      out.set(row.caseId, row.primaryTop1 === true || row.delivered?.some((d: any) => d.class === "RELEVANT") === true);
    }
  } catch {
    // No matching run: every case keeps its structural attribution.
  }
  return out;
}

function argument(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

export const FailureStage = Object.freeze({
  None: "NONE",
  Activation: "ACTIVATION_FAILURE",
  Representation: "REPRESENTATION_FAILURE",
  Candidate: "CANDIDATE_GENERATION_FAILURE",
  Subject: "SUBJECT_ALIGNMENT_FAILURE",
  RoleDelivery: "ROLE_DELIVERY_FAILURE",
  GroundTruth: "GROUND_TRUTH_ERROR",
});

const label = argument("--label", "pre_c2");
const oracleLabel = argument("--oracle-run", "");
const outDir = argument("--out", path.join(import.meta.dir, "results"));
await mkdir(outDir, { recursive: true });

interface SymbolRow {
  readonly id: string;
  readonly local_name: string;
  readonly fq_name: string;
}

/**
 * Resolve a corpus FQN to the indexed symbol row. The corpus writes FQNs in the
 * exact form the indexer stores (`requests/sessions.py::Session.get_adapter`),
 * so this is a direct lookup rather than a reconstruction.
 */
function resolveSymbol(db: Database, fqName: string): SymbolRow | null {
  const rows = db
    .query("SELECT id, local_name, fq_name FROM symbols WHERE fq_name = ?")
    .all(fqName) as SymbolRow[];
  return rows[0] ?? null;
}

function factsFor(db: Database, symbolId: string) {
  return db
    .query(
      "SELECT kind, subject, provenance, result_bearing FROM symbol_mechanism_facts WHERE symbol_id = ? ORDER BY ordinal",
    )
    .all(symbolId) as Array<{
      kind: string;
      subject: string;
      provenance: string;
      result_bearing: number;
    }>;
}

/** Does any of this symbol's facts implement the operation, directly or partially? */
function usableFacts(facts: readonly { kind: string }[], operation: string | null) {
  if (operation === null) return { direct: [] as string[], partial: [] as string[] };
  const table = (COMPATIBILITY as Record<string, Record<string, string>>)[operation] ?? {};
  return {
    direct: facts.filter((f) => table[f.kind] === "direct").map((f) => f.kind),
    partial: facts.filter((f) => table[f.kind] === "partial").map((f) => f.kind),
  };
}

const dbs = new Map<string, Database>();
function dbFor(repoKey: string): Database {
  let db = dbs.get(repoKey);
  if (db === undefined) {
    db = new Database(resolveIndexDbPath(repoRootFor(repoKey)), { readonly: true });
    dbs.set(repoKey, db);
  }
  return db;
}

interface CaseDiagnosis {
  caseId: string;
  repository: string | null;
  split: string;
  category: string;
  query: string;
  falsePremise: boolean;
  expectAbsence: boolean;
  // Activation
  operationDerived: string | null;
  suppressedBy: string | null;
  subjectTerms: readonly string[];
  // Representation, per expected PRIMARY_IMPLEMENTER
  expected: Array<{
    fqName: string;
    role: string;
    indexed: boolean;
    factKinds: readonly string[];
    directFactKinds: readonly string[];
    partialFactKinds: readonly string[];
  }>;
  // Candidate generation
  candidatesAdmitted: number;
  admittedFqNames: readonly string[];
  expectedAdmitted: boolean;
  rejectedForSubject: readonly { fqName: string; operand: string }[];
  expectedRejectedForSubject: boolean;
  generatorReason: string;
  primaryFailure: string;
  observations: string[];
}

const oracleOutcomes = oracleLabel === "" ? new Map<string, boolean>() : loadOracleOutcomes(outDir, oracleLabel);

const diagnoses: CaseDiagnosis[] = [];

for (const entry of BEHAVIORAL_CASES as readonly BehavioralCase[]) {
  if (entry.expectedRepository === null) continue; // ambiguous: no oracle repo
  const db = dbFor(entry.expectedRepository);
  const intent = deriveQueryIntent(entry.query);
  const objectiveResult = deriveBehavioralObjective(intent);
  const objective = hasBehavioralOperation(objectiveResult) ? objectiveResult : null;

  const expected = entry.expected.map((item) => {
    const row = resolveSymbol(db, item.fqName);
    const facts = row === null ? [] : factsFor(db, row.id);
    const usable = usableFacts(facts, objective?.operation ?? null);
    return {
      fqName: item.fqName,
      role: item.role,
      indexed: row !== null,
      factKinds: facts.map((f) => f.kind),
      directFactKinds: usable.direct,
      partialFactKinds: usable.partial,
    };
  });

  let candidatesAdmitted = 0;
  let admittedFqNames: string[] = [];
  let rejectedForSubject: { fqName: string; operand: string }[] = [];
  let generatorReason = "not run (no objective)";
  if (objective !== null) {
    const result = generateOperationFactCandidates(db, objective);
    candidatesAdmitted = result.candidates.length;
    admittedFqNames = result.candidates.map((c) => c.symbol.fqName);
    rejectedForSubject = result.diagnostics.rejectedForSubject.map((r) => ({
      fqName: r.fqName,
      operand: r.operand,
    }));
    generatorReason = result.diagnostics.reason;
  }

  const primaries = expected.filter((e) => e.role === "PRIMARY_IMPLEMENTER");
  const primaryNames = new Set(primaries.map((e) => e.fqName.split("::")[1]?.split(".").pop() ?? ""));
  // The path half of an FQN contains dots (`sphinx/util/__init__.py`), so the
  // symbol half has to be taken FIRST. Splitting the whole string on "." turned
  // `sphinx/util/__init__.py::get_filetype` into `py::get_filetype` and made an
  // admitted candidate look unadmitted.
  const nameOf = (fq: string) => (fq.split("::")[1] ?? fq).split(".").pop() ?? fq;
  const expectedAdmitted = admittedFqNames.some((fq) => primaryNames.has(nameOf(fq)));
  const expectedRejectedForSubject = rejectedForSubject.some((r) => primaryNames.has(nameOf(r.fqName)));

  // Attribute the FIRST failing stage. Absence controls are excluded: for those
  // the correct behaviour is to find nothing, so "nothing found" is a pass.
  const observations: string[] = [];
  let primaryFailure: string = FailureStage.None;
  if (entry.expectAbsence === true) {
    primaryFailure = FailureStage.None;
    observations.push("absence control: no mechanism expected");
  } else if (primaries.some((e) => !e.indexed)) {
    primaryFailure = FailureStage.GroundTruth;
  } else if (objective === null) {
    primaryFailure = FailureStage.Activation;
    // Record what WOULD have been available, so the next stage is visible
    // through this one rather than only after it is fixed.
    const anyFacts = expected.some((e) => e.factKinds.length > 0);
    observations.push(anyFacts
      ? "expected implementation does carry mechanism facts"
      : "expected implementation carries no mechanism facts at all");
  } else if (primaries.every((e) => e.directFactKinds.length === 0 && e.partialFactKinds.length === 0)) {
    primaryFailure = FailureStage.Representation;
    observations.push(`facts present: ${primaries.flatMap((e) => e.factKinds).join(",") || "none"}`);
  } else if (expectedRejectedForSubject) {
    primaryFailure = FailureStage.Subject;
  } else if (!expectedAdmitted) {
    primaryFailure = FailureStage.Candidate;
  } else if (oracleOutcomes.get(entry.id) === true) {
    // Admitted AND delivered. The chain worked end to end.
    primaryFailure = FailureStage.None;
    observations.push("expected implementation admitted and delivered");
  } else {
    primaryFailure = FailureStage.RoleDelivery;
    observations.push(oracleOutcomes.size === 0
      ? "expected implementation was admitted as a candidate (delivery not measured)"
      : "expected implementation was admitted as a candidate but not delivered");
  }

  if (objective !== null && candidatesAdmitted > 0 && !expectedAdmitted) {
    observations.push(`generator admitted other owners: ${admittedFqNames.join(", ")}`);
  }

  diagnoses.push({
    caseId: entry.id,
    repository: entry.expectedRepository,
    split: splitOf(entry),
    category: entry.category,
    query: entry.query,
    falsePremise: entry.falsePremise,
    expectAbsence: entry.expectAbsence === true,
    operationDerived: objective?.operation ?? null,
    suppressedBy: objective === null ? ((objectiveResult as any).suppressedBy ?? null) : null,
    subjectTerms: objective?.subjectTerms ?? [],
    expected,
    candidatesAdmitted,
    admittedFqNames,
    expectedAdmitted,
    rejectedForSubject,
    expectedRejectedForSubject,
    generatorReason,
    primaryFailure,
    observations,
  });
}

for (const db of dbs.values()) db.close();

function tally(rows: readonly CaseDiagnosis[], key: (r: CaseDiagnosis) => string) {
  const out: Record<string, number> = {};
  for (const row of rows) out[key(row)] = (out[key(row)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

const calibration = diagnoses.filter((d) => d.split === "calibration");
const holdout = diagnoses.filter((d) => d.split === "holdout");

const report = {
  label,
  generatedFrom: "frozen behavioral_cross_repo corpus",
  totals: {
    cases: diagnoses.length,
    calibration: calibration.length,
    holdout: holdout.length,
    activationRate: `${diagnoses.filter((d) => d.operationDerived !== null).length}/${diagnoses.length}`,
  },
  primaryFailureAll: tally(diagnoses, (d) => d.primaryFailure),
  primaryFailureCalibration: tally(calibration, (d) => d.primaryFailure),
  // Holdout counts are STAGE tallies only — no per-case holdout inspection is
  // used to choose any rule (§5, §42).
  primaryFailureHoldoutStagesOnly: tally(holdout, (d) => d.primaryFailure),
  suppressionReasons: tally(
    diagnoses.filter((d) => d.operationDerived === null),
    (d) => d.suppressedBy ?? "(none)",
  ),
  cases: diagnoses,
};

await writeFile(
  path.join(outDir, `stage5_m153_behavioral_failure_taxonomy${label === "pre_c2" ? "" : `_${label}`}.json`),
  `${JSON.stringify(report, null, 2)}\n`,
);

console.log(`cases=${report.totals.cases} activation=${report.totals.activationRate}`);
console.log("primary failure (all):", JSON.stringify(report.primaryFailureAll));
console.log("primary failure (calibration):", JSON.stringify(report.primaryFailureCalibration));
console.log(`wrote taxonomy → ${outDir}`);
