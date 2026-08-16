// M153-C5 — what a proven direct implementer is worth at the delivery boundary.
//
// M150 granted answer-role authority to ONE candidate so that a mechanism could
// not mint edit targets, and that bound is right. What C5 found is that the
// DISCARD gate was reading the grant rather than the evidence, so the second and
// third proven implementers of the requested operation were thrown away under the
// reason "no lexical/symbol/path/test/graph relevance to the task" — a statement
// that is false about a definition retrieval has just proven implements the
// requested operation on the requested subject.
//
// The M150 delivery fixture could never have caught it: it holds exactly one
// eligible candidate, so its grant is unopposed and the grant and the evidence
// can never disagree. Reproducing the defect needs TWO proven implementers where
// only one is named after the request — which is the sphinx shape, reached here
// without sphinx vocabulary.
//
// Neutral vocabulary throughout; nothing is borrowed from a corpus repository.

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { initializeSchema } from "../db/schema";
import { indexProject } from "../indexer/indexProject";
import { shapeSweQuery } from "./sweQueryShaping";
import { hybridRetrieve } from "../retrieval/hybridRetrieval";
import { assignCandidateRoles, hasAnswerRoleEvidence, CandidateRole } from "./assignCandidateRoles";

/**
 * `apply_stamp` and `formatter_for_ledger_entry` both loop `formatter_rules` and
 * return the first match, so both are subject-aligned direct implementers of the
 * requested selection. Only the second is named after the request, so only it can
 * win the grant — leaving the first with the measured profile that matters:
 *
 *     mechanismEvidence 0.55 · lexical 0.028 · localEvidence 0 · domain 0 · graph 0
 *
 * which is the sphinx `get_filetype` profile, and which the discard gate used to
 * treat as "no relevance to the task".
 *
 * `sweep_retry_handlers` is the same mechanism on a subject the request never
 * names. `render_ledger_entry` consumes the selection without performing it.
 */
const LEDGER = {
  "core.py": `
def apply_stamp(value, formatter_rules):
    for rule in formatter_rules:
        matched = rule.accepts(value)
        if matched is not None:
            return matched
    return None


def formatter_for_ledger_entry(entry, formatter_rules):
    for rule in formatter_rules:
        picked = rule.claim(entry)
        if picked is not None:
            return picked
    return None


def sweep_retry_handlers(job, retry_handlers):
    for handler in retry_handlers:
        outcome = handler.attempt(job)
        if outcome is not None:
            return outcome
    return None


def render_ledger_entry(entry, formatter_rules):
    chosen = formatter_for_ledger_entry(entry, formatter_rules)
    return chosen.render(entry)
`,
};

const QUERY = "How does the dispatcher decide which formatter renders a given ledger entry?";

interface Roles {
  roleOf: (localName: string) => CandidateRole | null;
  scoresOf: (localName: string) => { localEvidence: number; domain: number; graph: number } | null;
  eligible: string[];
  grantHolder: string | null;
  pivots: string[];
}

async function roles(): Promise<Roles> {
  const root = mkdtempSync(path.join(tmpdir(), "m153-c5-"));
  for (const [name, body] of Object.entries(LEDGER)) {
    writeFileSync(path.join(root, name), body, "utf8");
  }
  const db = new Database(":memory:");
  initializeSchema(db);
  await indexProject({ repoRoot: root, db });

  const shaped = shapeSweQuery({ problemStatement: QUERY, failToPass: [] });
  const retrieval = hybridRetrieve(db, { query: shaped.query, shaped, taskText: QUERY, maxResults: 60 });
  const roled = assignCandidateRoles(retrieval.candidates);
  const eligible = retrieval.candidates.filter((entry) => hasAnswerRoleEvidence(entry));
  return {
    roleOf: (localName) =>
      roled.find((entry) => entry.candidate.localName === localName)?.role ?? null,
    scoresOf: (localName) => {
      const found = roled.find((entry) => entry.candidate.localName === localName);
      return found === undefined ? null : {
        localEvidence: found.candidate.scores.localEvidence,
        domain: found.candidate.scores.domain,
        graph: found.candidate.scores.graph,
      };
    },
    eligible: eligible.map((entry) => entry.localName),
    grantHolder: eligible[0]?.localName ?? null,
    pivots: roled.filter((entry) => entry.role === CandidateRole.Pivot)
      .map((entry) => entry.candidate.localName),
  };
}

// --- the condition the M150 fixture cannot reach ------------------------------

test("§34 two proven implementers compete for one grant", async () => {
  const result = await roles();
  expect(result.eligible).toContain("formatter_for_ledger_entry");
  expect(result.eligible).toContain("apply_stamp");
  expect(result.grantHolder).toBe("formatter_for_ledger_entry");
});

test("§34 the loser has none of the evidence the discard gate looks for", async () => {
  const result = await roles();
  const scores = result.scoresOf("apply_stamp")!;
  // Without this the next test would prove nothing: it has to be the case that
  // every signal the gate reads is genuinely absent.
  expect(scores.localEvidence).toBe(0);
  expect(scores.domain).toBe(0);
  expect(scores.graph).toBe(0);
});

test("§34 a proven implementer that loses the grant is kept as support, not discarded", async () => {
  const result = await roles();
  // The defect in one assertion: this was Discard before C5.
  expect(result.roleOf("apply_stamp")).toBe(CandidateRole.Support);
});

test("§41 keeping the loser does not create a second proven-implementer pivot", async () => {
  const result = await roles();
  // The grant is still one. Evidence buys survival as support, never a pivot slot:
  // `apply_stamp` clears no pivot bar it did not already clear.
  expect(result.pivots).not.toContain("apply_stamp");
});

// --- negative controls ---------------------------------------------------------

test("§35 the same mechanism on a subject the request never names gains nothing", async () => {
  const result = await roles();
  // Subject alignment refuses it upstream, so it never reaches the direct tier and
  // the widened discard gate cannot catch it.
  expect(result.eligible).not.toContain("sweep_retry_handlers");
  expect(result.pivots).not.toContain("sweep_retry_handlers");
});

test("§36 a consumer of the selection gains no answer authority", async () => {
  const result = await roles();
  // `render_ledger_entry` calls the selector and performs no selection itself. It
  // is the most lexically obvious symbol in the fixture, and ordinary retrieval
  // may well rank it first — but it must never hold the grant, because the grant
  // is a claim about mechanism, not about naming.
  expect(result.eligible).not.toContain("render_ledger_entry");
  expect(result.grantHolder).not.toBe("render_ledger_entry");
});
