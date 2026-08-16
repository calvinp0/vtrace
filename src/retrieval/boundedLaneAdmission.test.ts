// M153-C4 — a bounded lane's findings survive the ordinary ranking cap.
//
// The defect these cover is not a scoring one. A lane like the operation-fact
// lane exists BECAUSE ordinary lexical/path/domain ranking cannot reach the
// definition it admits; routing its findings through the cap that same ranking
// fills therefore discards them by construction. M142-C already established the
// contract for the concept-owner lane — "the cap bounds what ORDINARY RANKING
// returns" — and C4 found it had been applied to that lane alone.
//
// Deliberately neutral vocabulary. Nothing here borrows a word, a symbol name or
// a shape from the frozen corpus repositories: the invariant is a property of
// bounded lanes, so a fixture that needed corpus vocabulary to demonstrate it
// would be evidence of the wrong thing (§19, §20).

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { initializeSchema } from "../db/schema";
import { indexProject } from "../indexer/indexProject";
import { shapeSweQuery } from "../capsule/sweQueryShaping";
import { hybridRetrieve, HybridCandidateSource } from "./hybridRetrieval";

async function indexed(files: Record<string, string>): Promise<Database> {
  const root = mkdtempSync(path.join(tmpdir(), "m153-c4-"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(root, name), body, "utf8");
  }
  const db = new Database(":memory:");
  initializeSchema(db);
  await indexProject({ repoRoot: root, db });
  return db;
}

/**
 * One definition that IMPLEMENTS the requested selection but is named after
 * nothing in the request, and a crowd of definitions named after everything in
 * it that implement nothing.
 *
 * `classify_stream` loops over `payload_formats` and returns the first match, so
 * its indexed operand names the request's subject. Its NAME does not, which is
 * the whole point: it can only ever rank below the decoys, so if the cap applies
 * to it the lane cannot deliver it at any pool size.
 *
 * `sweep_retry_handlers` is the negative control. Structurally it is the same
 * mechanism — a first-success loop — over an operand the request never mentions.
 */
const PIPELINE = {
  "core.py": `
def classify_stream(record, payload_formats):
    for candidate in payload_formats:
        matched = candidate.accepts(record)
        if matched is not None:
            return matched
    return None


def sweep_retry_handlers(job, retry_handlers):
    for handler in retry_handlers:
        outcome = handler.attempt(job)
        if outcome is not None:
            return outcome
    return None
`,
  "names.py": `
class PipelineEncoder:
    pass


class PayloadRecordEncoder:
    pass


def pipeline_encoder_writes_payload(record):
    return record


def encoder_for_payload_record(record):
    return record


def pipeline_record_encoder(record):
    return record
`,
};

const QUERY = "How does the pipeline decide which encoder writes a given payload record?";

async function pool(db: Database, maxResults: number): Promise<{
  fqNames: string[];
  laneAdmitted: string[];
  operationFactCarriers: string[];
}> {
  const shaped = shapeSweQuery({ problemStatement: QUERY, failToPass: [] });
  const result = hybridRetrieve(db, {
    query: shaped.query,
    shaped,
    taskText: QUERY,
    maxResults,
  });
  return {
    fqNames: result.candidates.map((entry) => entry.localName),
    laneAdmitted: result.operationFactCandidates.candidates.map((entry) => entry.symbol.localName),
    operationFactCarriers: result.candidates
      .filter((entry) => entry.sources.includes(HybridCandidateSource.OperationFact))
      .map((entry) => entry.localName),
  };
}

// --- positive control ---------------------------------------------------------

test("§20 a lane-admitted implementer below the cap still reaches the pool", async () => {
  const db = await indexed(PIPELINE);
  // A cap far smaller than the pool, so the lexically-named decoys fill it and
  // the implementer is outside it on organic rank alone.
  const small = await pool(db, 3);

  expect(small.laneAdmitted).toContain("classify_stream");
  expect(small.fqNames).toContain("classify_stream");
  expect(small.operationFactCarriers).toContain("classify_stream");
});

test("§20 the implementer is admitted BESIDE the cap, evicting nothing", async () => {
  const db = await indexed(PIPELINE);
  const capped = await pool(db, 3);

  // The ordinary ranking still returns its full quota; the lane's finding is an
  // addition to it, never a substitution for its weakest member (M142-C).
  const ordinary = capped.fqNames.filter((name) => name !== "classify_stream");
  expect(ordinary.length).toBe(3);
  expect(capped.fqNames.length).toBe(4);
});

test("§18 admission beside the cap does not change what the candidate scored", async () => {
  const db = await indexed(PIPELINE);
  const shaped = shapeSweQuery({ problemStatement: QUERY, failToPass: [] });
  const wide = hybridRetrieve(db, { query: shaped.query, shaped, taskText: QUERY, maxResults: 50 });
  const narrow = hybridRetrieve(db, { query: shaped.query, shaped, taskText: QUERY, maxResults: 3 });

  const scoreIn = (result: typeof wide): number | undefined =>
    result.candidates.find((entry) => entry.localName === "classify_stream")?.scores.final;

  // Identical, because nothing was boosted to get it through: the cap stopped
  // truncating it, and that is the entire change.
  expect(scoreIn(narrow)).toBe(scoreIn(wide)!);
});

// --- negative control ---------------------------------------------------------

test("§20 an equivalent mechanism on an unrequested subject is not carried past the cap", async () => {
  const db = await indexed(PIPELINE);
  const small = await pool(db, 3);

  // Same fact kind, same shape, same file — refused by subject alignment before
  // admission, so beside-cap admission never sees it. Without this the fix would
  // read as "structural facts bypass the cap", which is not the contract.
  expect(small.laneAdmitted).not.toContain("sweep_retry_handlers");
  expect(small.fqNames).not.toContain("sweep_retry_handlers");
});

test("§20 a request declaring no operation admits nothing beside the cap", async () => {
  const db = await indexed(PIPELINE);
  const task = "Update the changelog for the next release.";
  const shaped = shapeSweQuery({ problemStatement: task, failToPass: [] });
  const result = hybridRetrieve(db, { query: shaped.query, shaped, taskText: task, maxResults: 3 });

  expect(result.operationFactCandidates.candidates).toHaveLength(0);
  expect(result.candidates.length).toBeLessThanOrEqual(3);
});
