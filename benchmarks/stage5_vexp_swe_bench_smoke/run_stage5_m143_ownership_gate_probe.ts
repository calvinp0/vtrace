// M143 Workstream A — evaluation of the behaviour-ownership promotion gate.
//
// THE PROPOSED MECHANISM
// ----------------------
// A title mention buys ADMISSION. It should buy PROMOTION only when nothing
// else demonstrably owns the requested behaviour:
//
//   title candidate has NO ownership evidence
//   AND another candidate has POSITIVE, materially stronger ownership evidence
//     -> withhold the title candidate's promotion
//   ownership evidence absent or ambiguous
//     -> ABSTAIN (title keeps promotion; never demote on ignorance)
//
// Ownership evidence is objective coverage: how much of what the request ASKS
// FOR is named by a candidate's own identity. Objectives come from M142-C's
// `behavioralObjectives`, which is already role-typed and hygiene-filtered.
//
// THE MEASUREMENT PROBLEM THIS RUNNER EXISTS TO EXPOSE
// ---------------------------------------------------
// Measured naively the gate is CIRCULAR: the title term is itself a request
// token, so it becomes an objective, and the title symbol's own name covers it.
// The title candidate then scores highest by construction and the gate abstains
// everywhere — it looks safe because it never fires.
//
// De-circularising it (excluding the title term's tokens from the objectives the
// title symbol must own) makes the gate fire — on the WRONG cases. Both variants
// are computed here so the failure is visible rather than argued.
//
// No agent, Docker, VEXP, network, or paid API is used.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m143_ownership_gate_probe.ts \
//     --fixture <fixture.json> [--fixture ...] --out <dir>

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";

import { anchorTitleSymbols } from "../../src/capsuleV2/titleSymbolAnchoring";
import { shapeSweQuery } from "../../src/capsule/sweQueryShaping";
import { behavioralObjectives } from "../../src/retrieval/conceptOwnerRetrieval";
import { deriveQueryIntent } from "../../src/retrieval/querySemantics";
import { listAllSymbols } from "../../src/db/repositories/symbolsRepository";
import { HYBRID_SCORE_WEIGHTS } from "../../src/retrieval/hybridScoring";
import {
  createHybridRetrievalRequestCache,
  hybridRetrieve,
} from "../../src/retrieval/hybridRetrieval";
import { prepareRunnerOutput, SHARED_RUNNER_OPTIONS_HELP } from "./lib/runnerPaths";

const RUNNER_NAME = "m143_ownership_gate_probe";

/**
 * Retrieval width for the probe.
 *
 * The production pool is small, which is exactly why these title symbols are
 * injected rather than retrieved. To ask what a title symbol WOULD have earned
 * it has to actually be scored, so the probe retrieves wide. This is a
 * measurement instrument, not the shipped path.
 */
const PROBE_POOL = 400;
/** Competitors considered as ownership rivals. Bounded — no full-pool scan. */
const RIVALS = 10;

interface FixtureCase {
  readonly instance_id: string;
  readonly workspace: string;
  readonly task: string;
  readonly expected_files?: readonly string[];
}

const tokens = (text: string): string[] =>
  text
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/))
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 2);

/** Crude suffix stem — matches the objective extractor's own normalisation. */
const stem = (token: string): string => token.replace(/(ies|ing|ed|es|s)$/, "");

export interface OwnershipScore {
  readonly score: number;
  readonly covered: string[];
}

/**
 * Objective coverage by a candidate's OWN identity: its local name, plus the
 * member names it contains (a class owns the behaviour its methods implement).
 * Candidate-local — no reference to the rest of the pool.
 */
export function ownership(
  objectives: readonly string[],
  name: string,
  members: readonly string[],
): OwnershipScore {
  const identity = new Set([...tokens(name), ...members.flatMap(tokens)].map(stem));
  const covered = objectives.filter((objective) => identity.has(stem(objective.toLowerCase())));
  return { score: objectives.length === 0 ? 0 : covered.length / objectives.length, covered };
}

export type GateDecision = "suppress" | "abstain";

export function decide(titleOwn: number, bestRivalOwn: number): GateDecision {
  // Withhold ONLY on positive rival evidence against an empty title candidate.
  // Ambiguity abstains: never demote because we failed to find something.
  return titleOwn === 0 && bestRivalOwn > 0 ? "suppress" : "abstain";
}

interface Variant {
  readonly titleOwn: number;
  readonly titleCovered: string[];
  readonly bestRivalOwn: number;
  readonly bestRival: string | null;
  readonly bestRivalCovered: string[];
  readonly decision: GateDecision;
}

export interface GateCaseResult {
  readonly instanceId: string;
  readonly titleSymbol: string | null;
  readonly titlePath: string | null;
  readonly expectedFiles: readonly string[];
  /** Does the titled symbol live in the gold file (i.e. is promotion CORRECT)? */
  readonly titleIsGold: boolean;
  readonly objectives: readonly string[];
  readonly circular: Variant | null;
  readonly deCircularised: Variant | null;
  /** What the gate SHOULD do for this case, from the gold labels. */
  readonly desired: GateDecision;
}

function variant(
  objectives: readonly string[],
  titleName: string,
  titleMembers: readonly string[],
  rivals: ReadonlyArray<{ label: string; name: string }>,
): Variant {
  const own = ownership(objectives, titleName, titleMembers);
  let bestRivalOwn = 0;
  let bestRival: string | null = null;
  let bestRivalCovered: string[] = [];
  for (const rival of rivals) {
    const rivalOwn = ownership(objectives, rival.name, []);
    if (rivalOwn.score > bestRivalOwn) {
      bestRivalOwn = rivalOwn.score;
      bestRival = rival.label;
      bestRivalCovered = rivalOwn.covered;
    }
  }
  return {
    titleOwn: own.score,
    titleCovered: own.covered,
    bestRivalOwn,
    bestRival,
    bestRivalCovered,
    decision: decide(own.score, bestRivalOwn),
  };
}

const samePath = (left: string, right: string): boolean =>
  left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);

export function probeCase(db: Database, testCase: FixtureCase): GateCaseResult {
  const shaped = shapeSweQuery({ problemStatement: testCase.task });
  const intent = shaped.derivedIntent ?? deriveQueryIntent(testCase.task);
  const objectives = behavioralObjectives(intent);
  const title = anchorTitleSymbols({ db, task: testCase.task });
  const match = title.matches[0];
  const expectedFiles = testCase.expected_files ?? [];
  if (match === undefined) {
    return {
      instanceId: testCase.instance_id, titleSymbol: null, titlePath: null,
      expectedFiles, titleIsGold: false, objectives, circular: null,
      deCircularised: null, desired: "abstain",
    };
  }
  const titleIsGold = expectedFiles.some((file) => samePath(match.path, file));

  const retrieval = hybridRetrieve(db, {
    query: shaped.query, shaped, taskText: testCase.task,
    weights: HYBRID_SCORE_WEIGHTS, symbolSeeds: [], maxResults: PROBE_POOL,
    requestCache: createHybridRetrievalRequestCache(),
  });
  const rivals = retrieval.candidates
    .filter((candidate) => candidate.symbolId !== match.symbolId)
    .slice(0, RIVALS)
    .map((candidate) => ({ label: `${candidate.filePath}::${candidate.localName}`, name: candidate.localName }));

  const allSymbols = listAllSymbols(db);
  const titleFq = allSymbols.find((symbol) => symbol.id === match.symbolId)?.fqName ?? "";
  const members = allSymbols
    .filter((symbol) => symbol.filePath === match.path && symbol.fqName.startsWith(`${titleFq}.`))
    .map((symbol) => symbol.localName);

  // De-circularised: the title term's own tokens cannot be part of what the
  // title symbol is required to independently own.
  const titleTokens = new Set(tokens(match.term).map(stem));
  const residual = objectives.filter((objective) => !titleTokens.has(stem(objective.toLowerCase())));

  return {
    instanceId: testCase.instance_id,
    titleSymbol: match.symbol,
    titlePath: match.path,
    expectedFiles,
    titleIsGold,
    objectives,
    circular: variant(objectives, match.symbol, members, rivals),
    deCircularised: variant(residual, match.symbol, members, rivals),
    // Promotion is correct exactly when the titled symbol IS in the gold file.
    desired: titleIsGold ? "abstain" : "suppress",
  };
}

async function main(): Promise<void> {
  const fixtures: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--fixture") {
      const value = process.argv[index + 1];
      if (value !== undefined) fixtures.push(path.resolve(value));
    }
  }
  if (fixtures.length === 0) throw new Error(`Missing --fixture. ${SHARED_RUNNER_OPTIONS_HELP}`);
  const out = await prepareRunnerOutput({ argv: process.argv, runner: RUNNER_NAME });

  const results: GateCaseResult[] = [];
  for (const fixturePath of fixtures) {
    const parsed = JSON.parse(await readFile(fixturePath, "utf8")) as FixtureCase[];
    for (const testCase of parsed) {
      const indexPath = path.join(testCase.workspace, ".vtrace", "index.sqlite");
      if (!existsSync(indexPath)) continue;
      const db = new Database(indexPath, { readonly: true });
      try {
        const result = probeCase(db, testCase);
        if (result.titleSymbol !== null) results.push(result);
      } finally {
        db.close();
      }
      process.stderr.write(".");
    }
  }
  process.stderr.write("\n");

  const score = (pick: (r: GateCaseResult) => Variant | null) => {
    const rows = results.filter((r) => pick(r) !== null);
    const correct = rows.filter((r) => pick(r)!.decision === r.desired).length;
    return {
      cases: rows.length,
      agreesWithDesired: correct,
      // The two error classes are NOT symmetric: a wrong suppress destroys a
      // correct lead, a wrong abstain merely leaves the known defect in place.
      wrongSuppress: rows.filter((r) => pick(r)!.decision === "suppress" && r.desired === "abstain").length,
      wrongAbstain: rows.filter((r) => pick(r)!.decision === "abstain" && r.desired === "suppress").length,
    };
  };

  const artifact = {
    schemaVersion: "stage5.m143.ownership-gate-probe.v1",
    purpose: "M143 §A: measure the behaviour-ownership promotion gate before shipping it.",
    fixtures,
    mechanism: {
      rule: "suppress iff titleOwnership == 0 AND bestRivalOwnership > 0; otherwise abstain",
      objectiveSource: "conceptOwnerRetrieval.behavioralObjectives (M142-C role-typed, hygiene-filtered)",
      rivalCap: RIVALS,
      probePoolSize: PROBE_POOL,
    },
    verdict: {
      circular: score((r) => r.circular),
      deCircularised: score((r) => r.deCircularised),
    },
    cases: results,
  };
  const outPath = path.join(out.dir, "stage5_m143_title_ownership_gate.json");
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(artifact.verdict, null, 2)}\nwrote ${outPath}\n`);
}

if (import.meta.main) {
  await main();
}
