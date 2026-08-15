import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { initializeSchema } from "../db/schema";
import { indexProject } from "../indexer/indexProject";
import { listSymbolsByFqName } from "../db/repositories/symbolsRepository";
import {
  discoverMechanismSupport,
  MECHANISM_SUPPORT_LIMITS,
} from "./mechanismSupport";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A throwaway indexed repository. Support discovery reads only indexed evidence. */
async function indexed(files: Record<string, string>): Promise<Database> {
  const root = mkdtempSync(path.join(tmpdir(), "m150-support-"));
  mkdirSync(root, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(root, name), body, "utf8");
  }
  const db = new Database(":memory:");
  initializeSchema(db);
  await indexProject({ repoRoot: root, db });
  return db;
}

function seed(db: Database, fqName: string, provenance: string) {
  const symbol = listSymbolsByFqName(db, fqName)[0]!;
  return { symbolId: symbol.id, fqName, provenance };
}

const ORDERING_REPO = {
  "pipeline.py": `
def ordered_candidates(data):
    """Every candidate, most preferred first."""
    return sorted(build_candidates(data), key=priority)


def build_candidates(data):
    found = []
    for entry in data.entries:
        if entry.eligible:
            found.append(entry)
    return found


def process(data):
    """Which candidate wins."""
    xs = ordered_candidates(data)
    return xs[0]
`.trimStart(),
};

test("the helper that establishes the consumed order is found at depth 1", async () => {
  const db = await indexed(ORDERING_REPO);
  const result = discoverMechanismSupport({
    db,
    operation: "selection",
    seeds: [seed(db, "pipeline.py::process", "ordered_candidates")],
    deliveredSymbolIds: new Set(),
  });
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]!.symbol.fqName).toBe("pipeline.py::ordered_candidates");
  expect(result.candidates[0]!.depth).toBe(1);
  expect(result.diagnostics.sourceReads).toBe(0);
  db.close();
});

test("an unrelated sort is not evidence for the winner (§18)", async () => {
  // `log_only` sorts a list to LOG it and returns something else entirely. Both
  // helpers contain `sorted(...)`; only one establishes the order its caller
  // consumes, and `resultBearing` is what tells them apart.
  const db = await indexed({
    "pipeline.py": `
def log_only(names):
    report(", ".join(sorted(names)))
    return build_candidates(names)


def build_candidates(data):
    found = []
    for entry in data.entries:
        found.append(entry)
    return found


def process_unordered(data):
    xs = log_only(data)
    return xs[0]
`.trimStart(),
  });
  const result = discoverMechanismSupport({
    db,
    operation: "selection",
    seeds: [seed(db, "pipeline.py::process_unordered", "log_only")],
    deliveredSymbolIds: new Set(),
  });
  expect(result.candidates).toHaveLength(0);
  expect(result.diagnostics.reason).toContain("no helper");
  db.close();
});

test("the ordering helper is reached across two exact hops (the ARC shape)", async () => {
  // The producer does not order anything itself; the call it makes does. This is
  // exactly ARC's determine_family -> get_reaction_family_products ->
  // get_all_families chain, and stopping at one hop would miss it.
  const db = await indexed({
    "chain.py": `
def all_families(config):
    families = list(dict.fromkeys(config.families))
    return families


def family_products(config):
    products = all_families(config)
    if products is None:
        products = rebuild(config)
    return products


def determine_family(config):
    product_dicts = family_products(config)
    return product_dicts[0]
`.trimStart(),
  });
  const result = discoverMechanismSupport({
    db,
    operation: "selection",
    seeds: [seed(db, "chain.py::determine_family", "family_products")],
    deliveredSymbolIds: new Set(),
  });
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]!.symbol.fqName).toBe("chain.py::all_families");
  expect(result.candidates[0]!.depth).toBe(2);
  expect(result.candidates[0]!.relations).toEqual(["operand_provenance", "exact_call"]);
  expect(result.diagnostics.maxCausalDepthReached).toBe(2);
  db.close();
});

test("only the causally relevant helper is admitted from a crowd (§19)", async () => {
  const db = await indexed({
    "many.py": `
def validate(data):
    return data.checked


def annotate(entry):
    return entry.tagged


def normalise(entry):
    return entry.lower()


def audit(entry):
    record(entry)
    return entry


def ranked_entries(data):
    return sorted(data.entries, key=lambda entry: entry.rank)


def decide(data):
    validate(data)
    annotate(data)
    normalise(data)
    audit(data)
    xs = ranked_entries(data)
    return xs[0]
`.trimStart(),
  });
  const result = discoverMechanismSupport({
    db,
    operation: "selection",
    seeds: [seed(db, "many.py::decide", "ranked_entries")],
    deliveredSymbolIds: new Set(),
  });
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]!.symbol.localName).toBe("ranked_entries");
  db.close();
});

test("unknown ordering yields no support rather than an invented one (§20)", async () => {
  const db = await indexed({
    "pre.py": `
def take_winner(candidates):
    """Which candidate wins."""
    return candidates[0]
`.trimStart(),
  });
  // The operand is a parameter, so no producer was recorded and there is nothing
  // to follow. The decision stands on its own and says only what it shows.
  const result = discoverMechanismSupport({
    db,
    operation: "selection",
    seeds: [seed(db, "pre.py::take_winner", "")],
    deliveredSymbolIds: new Set(),
  });
  expect(result.candidates).toHaveLength(0);
  db.close();
});

test("support never exceeds its cap", async () => {
  const db = await indexed(ORDERING_REPO);
  const result = discoverMechanismSupport({
    db,
    operation: "selection",
    seeds: [seed(db, "pipeline.py::process", "ordered_candidates")],
    deliveredSymbolIds: new Set(),
  });
  expect(result.candidates.length).toBeLessThanOrEqual(MECHANISM_SUPPORT_LIMITS.maxSelected);
  expect(result.diagnostics.helpersExamined).toBeLessThanOrEqual(MECHANISM_SUPPORT_LIMITS.maxHelpersExamined);
  expect(result.diagnostics.maxCausalDepthReached).toBeLessThanOrEqual(MECHANISM_SUPPORT_LIMITS.maxDepth);
  db.close();
});

test("an already-delivered helper is not re-admitted as support", async () => {
  const db = await indexed(ORDERING_REPO);
  const helper = listSymbolsByFqName(db, "pipeline.py::ordered_candidates")[0]!;
  const result = discoverMechanismSupport({
    db,
    operation: "selection",
    seeds: [seed(db, "pipeline.py::process", "ordered_candidates")],
    deliveredSymbolIds: new Set([helper.id]),
  });
  expect(result.candidates).toHaveLength(0);
  db.close();
});

test("operations needing no ordering explanation do not run the lane", async () => {
  const db = await indexed(ORDERING_REPO);
  for (const operation of ["caching", "storage", "fallback"] as const) {
    const result = discoverMechanismSupport({
      db,
      operation,
      seeds: [seed(db, "pipeline.py::process", "ordered_candidates")],
      deliveredSymbolIds: new Set(),
    });
    expect(result.diagnostics.active).toBe(false);
    expect(result.candidates).toHaveLength(0);
  }
  db.close();
});

test("no seed carrying mechanism evidence means no traversal at all", async () => {
  const db = await indexed(ORDERING_REPO);
  const result = discoverMechanismSupport({
    db, operation: "selection", seeds: [], deliveredSymbolIds: new Set(),
  });
  expect(result.diagnostics.active).toBe(false);
  expect(result.diagnostics.causalEdgesExamined).toBe(0);
  db.close();
});
