// Run the M150 primary-operation emphasis corpus through the PRODUCT path.
//
// Same harness contract as `run_stage5_m150_mechanism_corpus.ts`: the
// implementation root is a parameter and each side indexes the fixture corpus
// with its OWN indexer into its own throwaway database, so the M149 predecessor
// (which cannot produce mechanism facts at all), the `fe5c220` checkpoint and
// the final candidate are each measured on what they can actually do.
//
//   bun run_stage5_m150_operation_emphasis.ts --impl <root> --label <name> --out <dir>
//
// The headline metric is `directImplementerBeatsConsumer` (§26): of the paired
// cases where both definitions exist, in how many does the definition that
// PERFORMS the requested operation outrank the one that merely consumes it.
//
// No agent, Docker, VEXP, network or paid API.

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";

import {
  OPERATION_EMPHASIS_CASES,
  type OperationEmphasisCase,
} from "./m150OperationEmphasisCorpus";

const CORPUS = path.resolve(import.meta.dir, "fixtures/m150_operation_emphasis");

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
      readonly scores: Record<string, number>;
      readonly sources?: readonly string[];
      readonly evidence?: readonly string[];
    }[];
  };
}

interface DeliveredItem {
  readonly fq_name: string;
  readonly symbol: string;
  readonly role: string;
  readonly estimated_tokens: number;
  readonly source?: string;
  readonly signature?: string;
  readonly selection_role?: string;
  readonly why?: string;
}

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

/** The full per-candidate record §28 asks for: generation, evidence, rank, role. */
function trace(capsule: CapsuleLike, fqName: string) {
  const item = [...capsule.pivots, ...capsule.support].find((entry) => entry.fq_name === fqName);
  const row = capsule.diagnostics.candidate_scores?.find((entry) => entry.fq_name === fqName);
  return {
    fqName,
    generated: row !== undefined,
    rank: row?.rank ?? null,
    final: row?.scores.final ?? null,
    lexical: row?.scores.lexical ?? null,
    domain: row?.scores.domain ?? null,
    mechanismEvidence: row?.scores.mechanismEvidence ?? 0,
    operationFulfillment: row?.scores.operationFulfillment ?? 0,
    sources: row?.sources ?? [],
    deliveredAs: item === undefined ? null : (item.selection_role ?? item.role),
    why: item?.why ?? null,
  };
}

function evaluateCase(impl: Impl, db: Database, testCase: OperationEmphasisCase) {
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

  const implementer = testCase.directImplementer === null
    ? null
    : trace(capsule, testCase.directImplementer);
  const consumer = testCase.consumer === undefined ? null : trace(capsule, testCase.consumer);
  const wrongSubject = (testCase.wrongSubject ?? []).map((fq) => trace(capsule, fq));

  // The headline relation. Only decidable where BOTH definitions were generated;
  // a null says the corpus could not pose the question, never that it passed.
  const beatsConsumer = implementer === null || consumer === null
    ? null
    : implementer.rank !== null && consumer.rank !== null && implementer.rank < consumer.rank;

  // §41: the pool decided an answer; did delivery honour it? A disagreement is
  // recorded with its reason rather than left as a silent divergence (§42).
  const poolPrimary = implementer !== null && consumer !== null
    && implementer.rank !== null && consumer.rank !== null
    && implementer.rank < consumer.rank
    ? implementer.fqName
    : null;
  const capsuleLeadsImplementer = implementer === null ? null : lead === implementer.fqName;
  const poolVsCapsuleAgreement = poolPrimary === null ? null : lead === poolPrimary;
  const disagreementReason = poolVsCapsuleAgreement === false
    ? (implementer!.deliveredAs === null
      ? "direct implementer not delivered"
      : `delivered as ${implementer!.deliveredAs}, lead is ${lead ?? "none"}`)
    : null;
  const emptyCapsuleDespiteImplementer = implementer !== null
    && implementer.generated && items.length === 0;

  // §23/§42: with no indexed ordering source, nothing may be delivered claiming
  // to establish one. Selecting an element is a truthful weaker statement.
  const overclaim = testCase.directImplementer !== null
    ? null
    : items.some((item) => /establish|determin|precedence|orders the/iu.test(item.why ?? ""));

  return {
    id: testCase.id,
    category: testCase.category,
    query: testCase.query,
    operation: testCase.operation,
    elapsedMs,
    lead,
    directImplementerTop1: implementer === null ? null : orderedFq[0] === implementer.fqName,
    directImplementerTop3: implementer === null
      ? null
      : orderedFq.slice(0, 3).includes(implementer.fqName),
    directImplementerDelivered: implementer === null ? null : implementer.deliveredAs !== null,
    consumerLeads: consumer === null ? null : lead === consumer.fqName,
    consumerDelivered: consumer === null ? null : consumer.deliveredAs !== null,
    directImplementerBeatsConsumer: beatsConsumer,
    capsuleLeadsImplementer,
    poolVsCapsuleAgreement,
    disagreementReason,
    emptyCapsuleDespiteImplementer,
    wrongSubjectOperationBonus: wrongSubject.reduce(
      (max, entry) => Math.max(max, entry.mechanismEvidence + entry.operationFulfillment), 0),
    unknownOrderingOverclaim: overclaim,
    moduleNodesDelivered: items.filter((item) => item.symbol === "<module>").length,
    implementer,
    consumer,
    wrongSubject,
    deliveredTokens: items.reduce((sum, item) => sum + item.estimated_tokens, 0),
  };
}

type CaseResult = ReturnType<typeof evaluateCase>;

/** A pair passes only when BOTH directions put the right definition first (§25). */
function pairedReversal(cases: readonly CaseResult[]): { passed: number; capsulePassed: number; total: number; pairs: unknown[] } {
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const pairs: unknown[] = [];
  for (const testCase of OPERATION_EMPHASIS_CASES) {
    if (testCase.pairedWith === undefined || seen.has(testCase.id)) continue;
    seen.add(testCase.id);
    seen.add(testCase.pairedWith);
    const left = byId.get(testCase.id);
    const right = byId.get(testCase.pairedWith);
    if (left === undefined || right === undefined) continue;
    pairs.push({
      pair: `${left.id} / ${right.id}`,
      leftTop1: left.directImplementerTop1,
      rightTop1: right.directImplementerTop1,
      leftBeatsConsumer: left.directImplementerBeatsConsumer,
      rightBeatsConsumer: right.directImplementerBeatsConsumer,
      reversed: left.directImplementerBeatsConsumer === true
        && right.directImplementerBeatsConsumer === true,
      leftCapsuleLead: left.capsuleLeadsImplementer,
      rightCapsuleLead: right.capsuleLeadsImplementer,
      capsuleReversed: left.capsuleLeadsImplementer === true
        && right.capsuleLeadsImplementer === true,
    });
  }
  return {
    passed: pairs.filter((entry) => (entry as { reversed: boolean }).reversed).length,
    capsulePassed: pairs.filter((entry) => (entry as { capsuleReversed: boolean }).capsuleReversed).length,
    total: pairs.length,
    pairs,
  };
}

function summarize(cases: readonly CaseResult[]) {
  const decidable = cases.filter((entry) => entry.directImplementerBeatsConsumer !== null);
  const withImplementer = cases.filter((entry) => entry.implementer !== null);
  const agreeable = cases.filter((entry) => entry.poolVsCapsuleAgreement !== null);
  const reversal = pairedReversal(cases);
  return {
    cases: cases.length,
    directImplementerTop1: `${withImplementer.filter((entry) => entry.directImplementerTop1).length}/${withImplementer.length}`,
    directImplementerTop3: `${withImplementer.filter((entry) => entry.directImplementerTop3).length}/${withImplementer.length}`,
    directImplementerGenerated: `${withImplementer.filter((entry) => entry.implementer?.generated).length}/${withImplementer.length}`,
    directImplementerBeatsConsumer: `${decidable.filter((entry) => entry.directImplementerBeatsConsumer).length}/${decidable.length}`,
    capsuleLeadsImplementer: `${withImplementer.filter((entry) => entry.capsuleLeadsImplementer).length}/${withImplementer.length}`,
    poolVsCapsuleAgreement: `${agreeable.filter((entry) => entry.poolVsCapsuleAgreement).length}/${agreeable.length}`,
    disagreementReasons: cases.filter((entry) => entry.disagreementReason !== null)
      .map((entry) => `${entry.id}: ${entry.disagreementReason}`),
    emptyCapsuleDespiteImplementer: cases.filter((entry) => entry.emptyCapsuleDespiteImplementer).length,
    consumerLeads: cases.filter((entry) => entry.consumerLeads === true).length,
    pairedPoolRoleReversal: `${reversal.passed}/${reversal.total}`,
    pairedCapsuleRoleReversal: `${reversal.capsulePassed}/${reversal.total}`,
    wrongSubjectOperationBonusCases: cases.filter((entry) => entry.wrongSubjectOperationBonus > 0).length,
    unknownOrderingOverclaim: cases.filter((entry) => entry.unknownOrderingOverclaim === true).length,
    moduleNodesDelivered: cases.reduce((sum, entry) => sum + entry.moduleNodesDelivered, 0),
    meanDeliveredTokens: Math.round(
      cases.reduce((sum, entry) => sum + entry.deliveredTokens, 0) / Math.max(1, cases.length)),
    pairs: reversal.pairs,
  };
}

async function main(): Promise<void> {
  const implRoot = path.resolve(argument("--impl", process.cwd()));
  const label = argument("--label");
  const outDir = path.resolve(argument("--out", "/home/calvin/bench/vtrace-m150/emphasis"));
  await mkdir(outDir, { recursive: true });

  const impl = await loadImplementation(implRoot);
  const dbPath = path.join(outDir, `emphasis-${label}.sqlite`);
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
  const cases = OPERATION_EMPHASIS_CASES.map((testCase) => evaluateCase(impl, db, testCase));
  db.close();

  const artifact = {
    schemaVersion: "stage5.m150.operation-emphasis.v1",
    label,
    implementationRoot: implRoot,
    corpus: CORPUS,
    indexMs,
    mechanismFactsIndexed: mechanismFacts,
    mechanismCapability: mechanismFacts >= 0,
    summary: summarize(cases),
    cases,
  };
  const outPath = path.join(outDir, `stage5_m150_operation_emphasis_${label}.json`);
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`${outPath}\n`);
  process.stdout.write(`${JSON.stringify(artifact.summary, null, 2)}\n`);
}

if (import.meta.main) {
  await main();
}
