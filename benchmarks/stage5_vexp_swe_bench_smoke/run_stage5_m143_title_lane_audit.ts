// M143 §10 title-lane audit.
//
// The M142 close carried `django-11740` as an unresolved Top-1 defect: the
// title-symbol lane re-injected `ForeignKey` with a synthesized score and it
// outranked the gold lead. §10 forbids fixing that before the lane is traced
// end to end, and §7 forbids repeating the two candidate-presence experiments
// M142 already measured and rejected.
//
// So this runner MEASURES the lane rather than reasoning about it. For every
// case in a fixture it records, per resolved title symbol:
//
//   - the title text the lane parsed and the terms it extracted
//   - whether the symbol reached the candidate pool ORGANICALLY (incumbent) or
//     was injected fresh by the lane
//   - the incumbent's real scorecard, or the fabricated one the lane synthesized
//   - whether the candidate carries CORROBORATING identifying evidence
//     (symbol / path / bodyLiteral — the M142 `evaluateHub` subset, which
//     deliberately excludes domain affinity and bare lexical)
//   - what led, and whether the gold file was the lead
//
// Everything is read back from the capsule's own `candidate_scores` and
// `title_symbol_matches` diagnostics, so the audit observes the shipped lane
// rather than a re-implementation of it.
//
// No agent, Docker, VEXP, network, or paid API is used.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m143_title_lane_audit.ts \
//     --fixture <fixture.json> [--fixture <fixture.json>] --out <dir>

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";

import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { extractTitleText, extractTitleSymbolTerms } from "../../src/capsuleV2/titleSymbolAnchoring";
import { CapsuleIntent, type CapsuleV2Result } from "../../src/capsuleV2/types";
import { prepareRunnerOutput, SHARED_RUNNER_OPTIONS_HELP } from "./lib/runnerPaths";

const RUNNER_NAME = "m143_title_lane_audit";

interface FixtureCase {
  readonly instance_id: string;
  readonly workspace: string;
  readonly task: string;
  readonly intent?: string;
  readonly budget?: number;
  readonly expected_files?: readonly string[];
}

/** One resolved title symbol, and how the lane treated it. */
export interface TitleMatchAudit {
  readonly term: string;
  readonly path: string;
  readonly symbol: string;
  /** `incumbent` = retrieval already had it; `injected` = the lane synthesized it. */
  readonly admission: "incumbent" | "injected" | "absent_from_pool";
  readonly finalScore: number | null;
  readonly rank: number | null;
  /**
   * Identifying evidence in the M142 sense: symbol-name / path / body-literal.
   * Domain affinity and bare lexical are excluded — every symbol in a relevant
   * package earns those, so they say nothing about WHICH symbol is meant.
   */
  readonly identifyingEvidence: number | null;
  readonly corroborated: boolean;
  /** True when the scorecard is the lane's synthesized one, not a measured one. */
  readonly fabricatedScorecard: boolean;
  readonly evidence: readonly string[];
}

export interface TitleCaseAudit {
  readonly instanceId: string;
  readonly titleText: string;
  readonly terms: readonly string[];
  readonly laneActive: boolean;
  readonly matches: readonly TitleMatchAudit[];
  readonly lead: string | null;
  readonly leadSymbol: string | null;
  readonly expectedFiles: readonly string[];
  readonly goldIsLead: boolean;
  /** A title match IS the lead — the shape django-11740 fails on. */
  readonly titleMatchLeads: boolean;
  /** The lead is a title match that was injected AND uncorroborated. */
  readonly uncorroboratedTitleLeads: boolean;
}

const IDENTIFYING_KEYS = ["symbol", "path", "bodyLiteral"] as const;

export function auditCase(capsule: CapsuleV2Result, testCase: FixtureCase): TitleCaseAudit {
  const diagnostics = capsule.diagnostics as unknown as Record<string, unknown>;
  const titleMatches = (diagnostics.title_symbol_matches ?? []) as Array<{ term: string; path: string; symbol: string }>;
  const scores = (diagnostics.candidate_scores ?? []) as Array<{
    rank: number;
    path: string;
    symbol: string;
    sources: string[];
    evidence: string[];
    scores: Record<string, number>;
  }>;
  const byPathSymbol = new Map(scores.map((entry) => [`${entry.path}::${entry.symbol}`, entry] as const));

  const matches: TitleMatchAudit[] = titleMatches.map((match) => {
    const entry = byPathSymbol.get(`${match.path}::${match.symbol}`);
    if (entry === undefined) {
      return {
        term: match.term, path: match.path, symbol: match.symbol,
        admission: "absent_from_pool", finalScore: null, rank: null,
        identifyingEvidence: null, corroborated: false, fabricatedScorecard: false, evidence: [],
      };
    }
    // The lane's synthesized candidate is recognisable without guessing: it
    // carries the title evidence line and NOTHING retrieval could have produced.
    const onlyTitleEvidence = entry.evidence.every((line) => line.startsWith("title mentions symbol-like term"));
    const identifyingEvidence = IDENTIFYING_KEYS.reduce((sum, key) => sum + (entry.scores[key] ?? 0), 0);
    return {
      term: match.term, path: match.path, symbol: match.symbol,
      admission: onlyTitleEvidence ? "injected" : "incumbent",
      finalScore: entry.scores.final ?? null,
      rank: entry.rank,
      // A fabricated scorecard cannot report identifying evidence honestly, so
      // record it as unmeasured rather than as the synthesized `1`s.
      identifyingEvidence: onlyTitleEvidence ? null : identifyingEvidence,
      corroborated: !onlyTitleEvidence && identifyingEvidence > 0,
      fabricatedScorecard: onlyTitleEvidence,
      evidence: entry.evidence,
    };
  });

  const leadPivot = capsule.pivots[0];
  const lead = leadPivot?.path ?? null;
  const expectedFiles = testCase.expected_files ?? [];
  // Fixture gold paths are repository-relative (`django/http/response.py`) while
  // a workspace whose root IS the package reports `http/response.py`. Comparing
  // them literally scored three correct leads as wrong on the first pass, which
  // would have made a net-harmful change look net-positive. Match on a path
  // SUFFIX boundary in either direction.
  const samePath = (left: string, right: string): boolean =>
    left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
  const titleMatchLeads = matches.some((m) => m.path === lead && m.symbol === (leadPivot?.symbol ?? ""));
  return {
    instanceId: testCase.instance_id,
    titleText: extractTitleText(testCase.task),
    terms: extractTitleSymbolTerms(extractTitleText(testCase.task)),
    laneActive: titleMatches.length > 0,
    matches,
    lead,
    leadSymbol: leadPivot?.symbol ?? null,
    expectedFiles,
    goldIsLead: lead !== null && expectedFiles.some((file) => samePath(lead, file)),
    titleMatchLeads,
    uncorroboratedTitleLeads: titleMatchLeads
      && matches.some((m) => m.path === lead && !m.corroborated),
  };
}

function intentOf(value: string | undefined): CapsuleIntent {
  switch (value) {
    case "debug": return CapsuleIntent.Debug;
    case "explain": return CapsuleIntent.Explain;
    case "modify": return CapsuleIntent.Modify;
    default: return CapsuleIntent.Auto;
  }
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

  const cases: TitleCaseAudit[] = [];
  for (const fixturePath of fixtures) {
    const parsed = JSON.parse(await readFile(fixturePath, "utf8")) as FixtureCase[] | { cases: FixtureCase[] };
    const entries = Array.isArray(parsed) ? parsed : parsed.cases;
    for (const testCase of entries) {
      const indexPath = path.join(testCase.workspace, ".vtrace", "index.sqlite");
      if (!existsSync(indexPath)) {
        process.stderr.write(`skip ${testCase.instance_id}: no index at ${indexPath}\n`);
        continue;
      }
      const db = new Database(indexPath, { readonly: true });
      try {
        const capsule = buildCapsuleV2({
          db,
          repoRoot: testCase.workspace,
          task: testCase.task,
          intent: intentOf(testCase.intent),
          maxTokens: testCase.budget ?? 8000,
        });
        cases.push(auditCase(capsule, testCase));
      } finally {
        db.close();
      }
      process.stderr.write(`.`);
    }
  }
  process.stderr.write("\n");

  const active = cases.filter((c) => c.laneActive);
  const allMatches = active.flatMap((c) => c.matches);
  const summary = {
    cases: cases.length,
    laneActiveCases: active.length,
    totalMatches: allMatches.length,
    incumbent: allMatches.filter((m) => m.admission === "incumbent").length,
    injected: allMatches.filter((m) => m.admission === "injected").length,
    absentFromPool: allMatches.filter((m) => m.admission === "absent_from_pool").length,
    fabricatedScorecards: allMatches.filter((m) => m.fabricatedScorecard).length,
    corroborated: allMatches.filter((m) => m.corroborated).length,
    casesWhereTitleMatchLeads: active.filter((c) => c.titleMatchLeads).length,
    // The decisive number: how often does an INJECTED title candidate lead, and
    // is it then right or wrong? Demoting injected matches can only help the
    // wrong ones and can only cost the right ones.
    injectedLeadsCorrect: active.filter((c) =>
      c.titleMatchLeads && c.goldIsLead
      && c.matches.some((m) => m.path === c.lead && m.admission === "injected")).length,
    injectedLeadsWrong: active.filter((c) =>
      c.titleMatchLeads && !c.goldIsLead
      && c.matches.some((m) => m.path === c.lead && m.admission === "injected")).length,
  };

  const artifact = {
    schemaVersion: "stage5.m143.title-lane-audit.v1",
    purpose: "M143 §10: trace every title-lane stage on real cases before changing it.",
    fixtures,
    summary,
    cases,
  };
  const outPath = path.join(out.dir, "stage5_m143_title_candidate_trace.json");
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\nwrote ${outPath}\n`);
}

if (import.meta.main) {
  await main();
}
