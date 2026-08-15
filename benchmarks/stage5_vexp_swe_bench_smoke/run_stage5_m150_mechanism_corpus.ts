// Run the M150 mechanism corpus through the PRODUCT retrieval path (§63).
//
// The implementation root is a parameter, so the same corpus, the same fixture
// source and the same queries can be executed against the M149 predecessor, the
// `ab8e4f0` checkpoint and the final candidate — which is what makes the
// three-way attribution in §31 possible rather than asserted. Each side indexes
// the corpus with its OWN indexer into its own throwaway database, because the
// predecessor cannot produce mechanism facts and pretending otherwise would
// compare two different inputs.
//
//   bun run_stage5_m150_mechanism_corpus.ts --impl <root> --label <name> --out <dir>
//
// No agent, Docker, VEXP, network or paid API.

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";

import { MECHANISM_CASES, type MechanismCase } from "./m150MechanismCorpus";

const CORPUS = path.resolve(
  import.meta.dir,
  "fixtures/m150_mechanism_corpus",
);

function argument(flag: string, fallback?: string): string {
  const index = process.argv.indexOf(flag);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined && fallback === undefined) throw new Error(`missing ${flag}`);
  return value ?? fallback!;
}

interface Impl {
  buildCapsuleV2: (input: Record<string, unknown>) => CapsuleLike;
  indexProject: (options: Record<string, unknown>) => Promise<unknown>;
  initializeSchema: (db: Database) => void;
  CapsuleIntent: Record<string, string>;
}

interface CapsuleLike {
  readonly pivots: readonly DeliveredItem[];
  readonly support: readonly DeliveredItem[];
  readonly diagnostics: {
    readonly candidate_scores?: readonly {
      readonly rank: number;
      readonly fq_name: string;
      readonly path: string;
      readonly scores: Record<string, number>;
    }[];
  };
}

interface DeliveredItem {
  readonly fq_name: string;
  readonly path: string;
  readonly symbol: string;
  readonly role: string;
  readonly estimated_tokens: number;
  readonly source?: string;
  readonly signature?: string;
  readonly selection_role?: string;
  readonly ordinary_rank?: number;
}

/** Load an implementation root's own modules, so no code is shared across sides. */
async function loadImplementation(root: string): Promise<Impl> {
  const [capsule, indexer, schema, types] = await Promise.all([
    import(path.join(root, "src/capsuleV2/buildCapsuleV2.ts")),
    import(path.join(root, "src/indexer/indexProject.ts")),
    import(path.join(root, "src/db/schema.ts")),
    import(path.join(root, "src/capsuleV2/types.ts")),
  ]);
  return {
    buildCapsuleV2: capsule.buildCapsuleV2,
    indexProject: indexer.indexProject,
    initializeSchema: schema.initializeSchema,
    CapsuleIntent: types.CapsuleIntent,
  };
}

/** Which of a case's watched definitions the capsule delivered, and how. */
function delivery(capsule: CapsuleLike, fqName: string) {
  const item = [...capsule.pivots, ...capsule.support].find((entry) => entry.fq_name === fqName);
  const row = capsule.diagnostics.candidate_scores?.find((entry) => entry.fq_name === fqName);
  return {
    fqName,
    rank: row?.rank ?? null,
    final: row?.scores.final ?? null,
    mechanismEvidence: row?.scores.mechanismEvidence ?? 0,
    deliveredAs: item === undefined ? null : (item.selection_role ?? item.role),
    ordinaryRank: item?.ordinary_rank ?? null,
  };
}

function evaluateCase(impl: Impl, db: Database, testCase: MechanismCase) {
  const started = performance.now();
  const capsule = impl.buildCapsuleV2({
    db,
    repoRoot: CORPUS,
    task: testCase.query,
    intent: impl.CapsuleIntent.Explain,
    maxTokens: 6000,
  });
  const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
  const items = [...capsule.pivots, ...capsule.support];
  const lead = capsule.pivots[0]?.fq_name ?? null;
  const orderedFq = items.map((item) => item.fq_name);
  const delivered = items
    .map((item) => `${item.source ?? item.signature ?? ""}`)
    .join("\n");

  const expected = delivery(capsule, testCase.expected);
  const wrongSubject = testCase.wrongSubject.map((fq) => delivery(capsule, fq));
  const negatives = (testCase.negativeControls ?? []).map((fq) => delivery(capsule, fq));
  const ordering = testCase.orderingHelper === undefined
    ? null
    : delivery(capsule, testCase.orderingHelper);

  return {
    id: testCase.id,
    category: testCase.category,
    query: testCase.query,
    elapsedMs,
    lead,
    // The headline metrics (§32, §65).
    correctMechanismLead: lead === testCase.expected,
    correctTop1: orderedFq[0] === testCase.expected,
    correctTop3: orderedFq.slice(0, 3).includes(testCase.expected),
    correctAnywhere: orderedFq.includes(testCase.expected),
    // The metric this continuation exists to drive to zero.
    sameOperationWrongSubjectLead: wrongSubject.some((entry) => entry.fqName === lead),
    sameOperationWrongSubjectBonus: wrongSubject.reduce(
      (max, entry) => Math.max(max, entry.mechanismEvidence), 0),
    negativeControlBonus: negatives.reduce((max, entry) => Math.max(max, entry.mechanismEvidence), 0),
    negativeControlDelivered: negatives.some((entry) => entry.deliveredAs !== null),
    decisionStatementVisible: testCase.decisionStatement === undefined
      ? null
      : delivered.includes(testCase.decisionStatement),
    orderingHelperVisible: ordering === null ? null : ordering.deliveredAs !== null,
    mechanismSupportUsed: items.filter((item) => item.selection_role === "mechanism_support")
      .map((item) => item.fq_name),
    moduleNodesDelivered: items.filter((item) => item.symbol === "<module>").length,
    expected,
    wrongSubject,
    ordering,
    negatives,
    deliveredTokens: items.reduce((sum, item) => sum + item.estimated_tokens, 0),
  };
}

function summarize(cases: ReturnType<typeof evaluateCase>[]) {
  const withStatement = cases.filter((entry) => entry.decisionStatementVisible !== null);
  const withOrdering = cases.filter((entry) => entry.orderingHelperVisible !== null);
  return {
    cases: cases.length,
    correctMechanismLead: cases.filter((entry) => entry.correctMechanismLead).length,
    correctTop1: cases.filter((entry) => entry.correctTop1).length,
    correctTop3: cases.filter((entry) => entry.correctTop3).length,
    correctAnywhere: cases.filter((entry) => entry.correctAnywhere).length,
    missingMechanism: cases.filter((entry) => !entry.correctAnywhere).length,
    sameOperationWrongSubjectLead: cases.filter((entry) => entry.sameOperationWrongSubjectLead).length,
    sameOperationWrongSubjectBonusCases: cases.filter((entry) => entry.sameOperationWrongSubjectBonus > 0).length,
    negativeControlBonusCases: cases.filter((entry) => entry.negativeControlBonus > 0).length,
    negativeControlDeliveredCases: cases.filter((entry) => entry.negativeControlDelivered).length,
    decisionStatementVisible: `${withStatement.filter((entry) => entry.decisionStatementVisible).length}/${withStatement.length}`,
    orderingHelperVisible: `${withOrdering.filter((entry) => entry.orderingHelperVisible).length}/${withOrdering.length}`,
    mechanismSupportUsedCases: cases.filter((entry) => entry.mechanismSupportUsed.length > 0).length,
    maxMechanismSupportPerCase: cases.reduce((max, entry) => Math.max(max, entry.mechanismSupportUsed.length), 0),
    moduleNodesDelivered: cases.reduce((sum, entry) => sum + entry.moduleNodesDelivered, 0),
    meanDeliveredTokens: Math.round(
      cases.reduce((sum, entry) => sum + entry.deliveredTokens, 0) / Math.max(1, cases.length)),
  };
}

async function main(): Promise<void> {
  const implRoot = path.resolve(argument("--impl", process.cwd()));
  const label = argument("--label");
  const outDir = path.resolve(argument("--out", "/home/calvin/bench/vtrace-m150/corpus"));
  await mkdir(outDir, { recursive: true });

  const impl = await loadImplementation(implRoot);
  const dbPath = path.join(outDir, `corpus-${label}.sqlite`);
  await rm(dbPath, { force: true });

  const indexStarted = performance.now();
  const writable = new Database(dbPath);
  impl.initializeSchema(writable);
  await impl.indexProject({ repoRoot: CORPUS, db: writable });
  writable.close();
  const indexMs = Math.round(performance.now() - indexStarted);

  const db = new Database(dbPath, { readonly: true });
  let mechanismFacts = 0;
  try {
    mechanismFacts = (db.query("SELECT COUNT(*) c FROM symbol_mechanism_facts").get() as { c: number }).c;
  } catch {
    mechanismFacts = -1; // capability absent on this implementation
  }
  const cases = MECHANISM_CASES.map((testCase) => evaluateCase(impl, db, testCase));
  db.close();

  const artifact = {
    schemaVersion: "stage5.m150.mechanism-corpus.v1",
    label,
    implementationRoot: implRoot,
    corpus: CORPUS,
    indexMs,
    mechanismFactsIndexed: mechanismFacts,
    mechanismCapability: mechanismFacts >= 0,
    summary: summarize(cases),
    cases,
  };
  const outPath = path.join(outDir, `stage5_m150_mechanism_corpus_${label}.json`);
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`${outPath}\n`);
  process.stdout.write(`${JSON.stringify(artifact.summary, null, 2)}\n`);
}

if (import.meta.main) {
  await main();
}
