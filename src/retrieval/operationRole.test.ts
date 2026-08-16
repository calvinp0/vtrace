import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { initializeSchema } from "../db/schema";
import { indexProject } from "../indexer/indexProject";
import { hybridRetrieve } from "./hybridRetrieval";
import { shapeSweQuery } from "../capsule/sweQueryShaping";
import { OPERATION_ROLE_LIMITS } from "./operationRole";

/** A throwaway indexed repository. The role lane reads only indexed evidence. */
async function indexed(files: Record<string, string>): Promise<Database> {
  const root = mkdtempSync(path.join(tmpdir(), "m150-role-"));
  mkdirSync(root, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(root, name), body, "utf8");
  }
  const db = new Database(":memory:");
  initializeSchema(db);
  await indexProject({ repoRoot: root, db });
  return db;
}

function retrieve(db: Database, task: string) {
  const shaped = shapeSweQuery({ problemStatement: task }, {});
  return hybridRetrieve(db, { query: shaped.query, shaped, taskText: task, maxResults: 20 });
}

function rankOf(result: ReturnType<typeof retrieve>, fqName: string): number {
  const index = result.candidates.findIndex((entry) => entry.fqName === fqName);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

// `alpha` establishes the order; `beta` consumes it and picks. Neither name says
// so, so nothing here can pass by matching a word in the question.
const PAIRED = {
  "pipeline.py": `
def collect(registry):
    found = []
    for plugin in registry.plugins:
        if plugin.enabled:
            found.append(plugin)
    return found


def alpha(registry):
    plugins = collect(registry)
    return sorted(plugins)


def beta(registry):
    plugins = alpha(registry)
    return plugins[0]
`,
};

test("an ordering query ranks the orderer above the selection that consumes it", async () => {
  const db = await indexed(PAIRED);
  const result = retrieve(db, "What determines plugin precedence?");

  expect(rankOf(result, "pipeline.py::alpha")).toBeLessThan(rankOf(result, "pipeline.py::beta"));
  expect(result.operationRoles.operation).toBe("ordering");
  expect(result.operationRoles.directImplementers).toContain("pipeline.py::alpha");
  expect(result.operationRoles.promotions.length).toBeGreaterThan(0);
});

test("the same code reverses for a selection query", async () => {
  const db = await indexed(PAIRED);
  const result = retrieve(db, "How does the system decide which plugin wins?");

  expect(rankOf(result, "pipeline.py::beta")).toBeLessThan(rankOf(result, "pipeline.py::alpha"));
  expect(result.operationRoles.operation).toBe("selection");
  expect(result.operationRoles.directImplementers).toContain("pipeline.py::beta");
});

test("a lexically stronger consumer does not outrank the direct implementer", async () => {
  // The consumer holds every subject word the question uses; the implementer
  // holds none. This is the ARC shape reduced to two definitions.
  const db = await indexed({
    "rules.py": `
def collect_rules(data):
    found = []
    for entry in data.entries:
        if entry.active:
            found.append(entry)
    return found


def prepare(data):
    rules = collect_rules(data)
    return sorted(rules)


def rule_candidate_selector(data):
    rules = prepare(data)
    return rules[0]
`,
  });
  const result = retrieve(db, "What determines rule candidate precedence?");

  expect(rankOf(result, "rules.py::prepare"))
    .toBeLessThan(rankOf(result, "rules.py::rule_candidate_selector"));
});

test("the promotion is the minimum step above the consumer, never higher", async () => {
  const db = await indexed(PAIRED);
  const result = retrieve(db, "What determines plugin precedence?");
  const promotion = result.operationRoles.promotions[0]!;

  expect(promotion.promotedFinal).toBeGreaterThan(promotion.organicFinal);
  const consumer = result.candidates.find((entry) => entry.fqName === promotion.aboveFqName)!;
  expect(promotion.promotedFinal - consumer.scores.final).toBeLessThanOrEqual(1e-3);
  // The score it earned on its own evidence is still on the scorecard.
  const promoted = result.candidates.find((entry) => entry.symbolId === promotion.symbolId)!;
  expect(promoted.scores.organicFinal).toBe(promotion.organicFinal);
});

test("the consumer keeps every point it earned", async () => {
  const db = await indexed(PAIRED);
  const ordering = retrieve(db, "What determines plugin precedence?");
  const selection = retrieve(db, "How does the system decide which plugin wins?");

  const beta = (result: ReturnType<typeof retrieve>) =>
    result.candidates.find((entry) => entry.fqName === "pipeline.py::beta")!;
  // Demoted relative to `alpha` on the ordering query, never penalised: the
  // subject evidence it earned is identical on both questions.
  expect(beta(ordering).scores.lexical).toBe(beta(selection).scores.lexical);
  expect(beta(ordering).scores.operationFulfillment).toBeUndefined();
});

test("an ordering on a different subject earns no answer role", async () => {
  const db = await indexed({
    ...PAIRED,
    "readings.py": `
def gamma(readings):
    samples = [entry for entry in readings if entry.valid]
    return sorted(samples)
`,
  });
  const result = retrieve(db, "What determines plugin precedence?");

  expect(result.operationRoles.directImplementers).not.toContain("readings.py::gamma");
  expect(result.operationRoles.promotions.map((entry) => entry.fqName))
    .not.toContain("readings.py::gamma");
});

test("selecting from an order nobody establishes promotes nothing", async () => {
  const db = await indexed({
    "take.py": `
def take_first(entries):
    return entries[0]
`,
  });
  const result = retrieve(db, "What establishes precedence between entries?");

  expect(result.operationRoles.promotions).toEqual([]);
});

test("a request with no behavioural operation never activates the lane", async () => {
  const db = await indexed(PAIRED);
  const result = retrieve(db, "TypeError raised while importing pipeline");

  expect(result.operationRoles.active).toBe(false);
  expect(result.operationRoles.promotions).toEqual([]);
});

test("the walk is bounded and reads no source", async () => {
  const db = await indexed(PAIRED);
  const result = retrieve(db, "What determines plugin precedence?");

  expect(result.operationRoles.sourceReads).toBe(0);
  expect(result.operationRoles.relationsInspected)
    .toBeLessThanOrEqual(
      OPERATION_ROLE_LIMITS.maxConsumersExamined
      * OPERATION_ROLE_LIMITS.maxPerHop
      * (OPERATION_ROLE_LIMITS.maxDepth + 1),
    );
});
