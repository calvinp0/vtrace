import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { initializeSchema } from "../db/schema";
import { indexProject } from "../indexer/indexProject";
import { deriveQueryIntent } from "./querySemantics";
import { deriveBehavioralObjective, hasBehavioralOperation, type BehavioralObjective } from "./behavioralObjective";
import { generateOperationFactCandidates, OPERATION_FACT_LIMITS } from "./operationFactCandidates";

async function indexed(files: Record<string, string>): Promise<Database> {
  const root = mkdtempSync(path.join(tmpdir(), "m150-opfact-"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(root, name), body, "utf8");
  }
  const db = new Database(":memory:");
  initializeSchema(db);
  await indexProject({ repoRoot: root, db });
  return db;
}

function objective(task: string): BehavioralObjective {
  const derived = deriveBehavioralObjective(deriveQueryIntent(task));
  if (!hasBehavioralOperation(derived)) throw new Error(`no operation for: ${task}`);
  return derived;
}

function admitted(db: Database, task: string): string[] {
  return generateOperationFactCandidates(db, objective(task)).candidates
    .map((entry) => entry.symbol.localName)
    .sort();
}

/** Two orderings over two subjects, in one module (§27, §28). */
const TWO_SUBJECTS = {
  "svc.py": `
def a(config):
    xs = sorted(matching_backends(config), key=backend_priority)
    return xs


def b(output):
    ys = sorted(parse_frequencies(output))
    return ys


def matching_backends(config):
    found = []
    for backend in config.backends:
        found.append(backend)
    return found


def parse_frequencies(output):
    values = []
    for line in output.splitlines():
        values.append(line)
    return values
`.trimStart(),
};

test("an ordering request admits the ordering-bearing definition", async () => {
  const db = await indexed(TWO_SUBJECTS);
  expect(admitted(db, "What determines precedence between backends?")).toContain("a");
  db.close();
});

test("the same-operation wrong-subject definition is refused at admission (§27, §71)", async () => {
  // `b` carries a real, result-bearing ordering fact. It is about frequencies,
  // so it never becomes a candidate for a question about backends — the
  // regression is refused at GENERATION time, not filtered out afterwards.
  const db = await indexed(TWO_SUBJECTS);
  const result = generateOperationFactCandidates(db, objective("What determines precedence between backends?"));
  expect(result.candidates.map((entry) => entry.symbol.localName)).not.toContain("b");
  expect(result.diagnostics.ownersRejected).toBeGreaterThan(0);
  db.close();
});

test("subject alignment reverses with the subject at generation time", async () => {
  const db = await indexed(TWO_SUBJECTS);
  const forFrequencies = admitted(db, "What determines the order of the frequencies?");
  expect(forFrequencies).toContain("b");
  expect(forFrequencies).not.toContain("a");
  db.close();
});

test("two orderings in one CLASS are still discriminated (§29)", async () => {
  const db = await indexed({
    "adapter.py": `
class Adapter:
    def ranked_backends(self, config):
        xs = sorted(self.collect_backends(config), key=rank)
        return xs

    def ranked_energies(self, output):
        ys = sorted(self.collect_energies(output))
        return ys

    def collect_backends(self, config):
        found = []
        for backend in config.backends:
            found.append(backend)
        return found

    def collect_energies(self, output):
        values = []
        for line in output:
            values.append(line)
        return values
`.trimStart(),
  });
  const names = admitted(db, "What determines precedence between backends?");
  expect(names).toContain("ranked_backends");
  expect(names).not.toContain("ranked_energies");
  db.close();
});

test("an uninformative operand is admitted through its producer (§30)", async () => {
  const db = await indexed({
    "u.py": `
def prepare(config):
    xs = matching_backends(config)
    return sorted(xs, key=priority)


def matching_backends(config):
    found = []
    for backend in config.backends:
        found.append(backend)
    return found
`.trimStart(),
  });
  expect(admitted(db, "What determines precedence between backends?")).toContain("prepare");
  db.close();
});

test("an ordering with no provenance connecting it to the subject is refused (§31)", async () => {
  const db = await indexed({
    "p.py": `
def prepare(xs):
    return sorted(xs)
`.trimStart(),
  });
  expect(admitted(db, "What determines precedence between backends?")).toHaveLength(0);
  db.close();
});

test("a request naming no subject does not run the lane at all (§15)", async () => {
  const db = await indexed(TWO_SUBJECTS);
  const bare = { ...objective("What determines precedence?"), subjectTerms: [] };
  const result = generateOperationFactCandidates(db, bare);
  expect(result.diagnostics.active).toBe(false);
  expect(result.candidates).toHaveLength(0);
  db.close();
});

test("admission is capped and bounded (§17, §18)", async () => {
  const many: Record<string, string> = {};
  for (let index = 0; index < 12; index += 1) {
    many[`m${index}.py`] = `
def ranked_backends_${index}(config):
    xs = sorted(config.backends, key=rank)
    return xs
`.trimStart();
  }
  const db = await indexed(many);
  const result = generateOperationFactCandidates(db, objective("What determines precedence between backends?"));
  expect(result.candidates.length).toBeLessThanOrEqual(OPERATION_FACT_LIMITS.maxAdmitted);
  expect(result.diagnostics.ownersExamined).toBeLessThanOrEqual(OPERATION_FACT_LIMITS.maxOwnersExamined);
  expect(result.diagnostics.factsQueried).toBeLessThanOrEqual(OPERATION_FACT_LIMITS.maxFactsQueried);
  db.close();
});

test("admission never reads source (§58)", async () => {
  const db = await indexed(TWO_SUBJECTS);
  const result = generateOperationFactCandidates(db, objective("What determines precedence between backends?"));
  expect(result.diagnostics.sourceReads).toBe(0);
  db.close();
});

test("only kinds that DIRECTLY implement the operation are queried (§16)", async () => {
  const db = await indexed(TWO_SUBJECTS);
  const result = generateOperationFactCandidates(db, objective("What determines precedence between backends?"));
  expect(result.diagnostics.factKindsQueried).toContain("ordering_established");
  // `sort_then_first` is only PARTIAL evidence for ordering, so it may
  // strengthen a candidate but may not create one.
  expect(result.diagnostics.factKindsQueried).not.toContain("sort_then_first");
  db.close();
});
