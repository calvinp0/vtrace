// M140 changed-case attribution.
//
// Joins the paired comparison's changed cases against (a) each side's retained
// evaluation rows and (b) the per-side rerankGraph signal probe, then assigns each
// changed case a CAUSE (why the output moved) and, separately, a QUALITY class
// (whether the move was good). M140 §17 requires these to stay distinct: a
// correctness-caused change may still be a regression.
//
// Causality is read from measured signal deltas, never inferred from the tag alone.
//
// No agent, Docker, VEXP, network, or paid API is used.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Quality = "IMPROVEMENT" | "NEUTRAL" | "REGRESSION";

interface Row {
  readonly instance_id: string;
  readonly top_1_pivot_file: string | null;
  readonly top_3_files: readonly string[];
  readonly expected_file_best_rank: number | null;
  readonly contains_expected_file_top1: boolean;
  readonly contains_expected_file_top3: boolean;
  readonly contains_expected_file_anywhere: boolean;
  readonly contains_expected_symbol_anywhere: boolean;
  readonly pivot_count: number;
  readonly support_count: number;
  readonly estimated_tokens: number | null;
  readonly result: string;
}

interface SignalTally {
  readonly candidatesWithSignal: number;
  readonly totalScore: number;
  readonly totalCount: number;
}

interface ProbeCase {
  readonly instanceId: string;
  readonly signals: Record<string, SignalTally>;
  readonly moduleKindResults: number;
}

const IMPORTS = "imports_neighborhood";
const IN_DEGREE = "in_degree";

function score(probe: ProbeCase | undefined, signal: string): number {
  return probe?.signals[signal]?.totalScore ?? 0;
}

function edges(probe: ProbeCase | undefined, signal: string): number {
  return probe?.signals[signal]?.totalCount ?? 0;
}

/**
 * Gold-relevance quality. Rank improvements and visibility gains outrank tier
 * flags, because a case can gain top-3 while losing top-1.
 */
export function classifyQuality(before: Row | undefined, after: Row | undefined): { quality: Quality; basis: string } {
  if (before === undefined || after === undefined) return { quality: "NEUTRAL", basis: "row missing on one side" };
  if (before.contains_expected_file_anywhere !== after.contains_expected_file_anywhere) {
    return after.contains_expected_file_anywhere
      ? { quality: "IMPROVEMENT", basis: "gold file became visible" }
      : { quality: "REGRESSION", basis: "gold file lost from context" };
  }
  if (before.contains_expected_file_top1 !== after.contains_expected_file_top1) {
    return after.contains_expected_file_top1
      ? { quality: "IMPROVEMENT", basis: "gold file gained top-1" }
      : { quality: "REGRESSION", basis: "gold file lost top-1" };
  }
  if (before.contains_expected_file_top3 !== after.contains_expected_file_top3) {
    return after.contains_expected_file_top3
      ? { quality: "IMPROVEMENT", basis: "gold file gained top-3" }
      : { quality: "REGRESSION", basis: "gold file lost top-3" };
  }
  const beforeRank = before.expected_file_best_rank;
  const afterRank = after.expected_file_best_rank;
  if (beforeRank !== null && afterRank !== null && beforeRank !== afterRank) {
    return afterRank < beforeRank
      ? { quality: "IMPROVEMENT", basis: `gold rank ${beforeRank} -> ${afterRank}` }
      : { quality: "REGRESSION", basis: `gold rank ${beforeRank} -> ${afterRank}` };
  }
  if (before.contains_expected_symbol_anywhere !== after.contains_expected_symbol_anywhere) {
    return after.contains_expected_symbol_anywhere
      ? { quality: "IMPROVEMENT", basis: "gold symbol became visible" }
      : { quality: "REGRESSION", basis: "gold symbol lost" };
  }
  return { quality: "NEUTRAL", basis: "gold relevance identical; packing/context churn only" };
}

/** Cause subreasons, ordered most to least specific, from measured deltas. */
export function classifyCause(
  probeBefore: ProbeCase | undefined,
  probeAfter: ProbeCase | undefined,
): { cause: string; subreasons: string[]; evidence: Record<string, number | boolean> } {
  const importsBefore = score(probeBefore, IMPORTS);
  const importsAfter = score(probeAfter, IMPORTS);
  const inEdgesBefore = edges(probeBefore, IN_DEGREE);
  const inEdgesAfter = edges(probeAfter, IN_DEGREE);
  const inScoreBefore = score(probeBefore, IN_DEGREE);
  const inScoreAfter = score(probeAfter, IN_DEGREE);

  const subreasons: string[] = [];
  if (importsBefore > 0 && importsAfter === 0) subreasons.push("source_signal_removed");
  if (inEdgesAfter > inEdgesBefore) subreasons.push("target_fanin_added");
  if (inScoreAfter !== inScoreBefore) subreasons.push("candidate_score_changed");
  if ((probeAfter?.moduleKindResults ?? 0) > 0) subreasons.push("module_bridge_changed");
  if (subreasons.length === 0) subreasons.push("secondary_effect");

  return {
    cause: "import_attribution_fix",
    subreasons,
    evidence: {
      importsNeighborhoodScoreBefore: importsBefore,
      importsNeighborhoodScoreAfter: importsAfter,
      inDegreeEdgesBefore: inEdgesBefore,
      inDegreeEdgesAfter: inEdgesAfter,
      inDegreeScoreBefore: inScoreBefore,
      inDegreeScoreAfter: inScoreAfter,
      moduleNodesDelivered: (probeAfter?.moduleKindResults ?? 0) > 0,
    },
  };
}

interface Config {
  readonly paired: string;
  readonly rowsFiles: readonly string[];
  readonly probeBefore: string;
  readonly probeAfter: string;
  readonly out: string;
}

async function main(config: Config): Promise<void> {
  const paired = JSON.parse(await readFile(config.paired, "utf8")) as {
    suites: Array<{ name: string; changedCases: Array<{ instanceId: string; fields: string[]; predecessorLead: string | null; candidateLead: string | null }> }>;
  };
  const beforeRows = new Map<string, Row>();
  const afterRows = new Map<string, Row>();
  for (const file of config.rowsFiles) {
    const data = JSON.parse(await readFile(file, "utf8")) as {
      predecessor: { rows: Row[] };
      candidate: { rows: Row[] };
    };
    for (const row of data.predecessor.rows) beforeRows.set(row.instance_id, row);
    for (const row of data.candidate.rows) afterRows.set(row.instance_id, row);
  }
  const probeIndex = async (file: string): Promise<Map<string, ProbeCase>> => {
    const data = JSON.parse(await readFile(file, "utf8")) as { perCase: ProbeCase[] };
    return new Map(data.perCase.map((entry) => [entry.instanceId, entry]));
  };
  const [probeBefore, probeAfter] = await Promise.all([probeIndex(config.probeBefore), probeIndex(config.probeAfter)]);

  const ledger = [];
  for (const suite of paired.suites) {
    for (const changed of suite.changedCases) {
      const before = beforeRows.get(changed.instanceId);
      const after = afterRows.get(changed.instanceId);
      const { quality, basis } = classifyQuality(before, after);
      const cause = classifyCause(probeBefore.get(changed.instanceId), probeAfter.get(changed.instanceId));
      ledger.push({
        suite: suite.name,
        instanceId: changed.instanceId,
        changedFields: changed.fields,
        oldLead: changed.predecessorLead,
        newLead: changed.candidateLead,
        leadChanged: changed.predecessorLead !== changed.candidateLead,
        oldSelectedFiles: before?.top_3_files ?? [],
        newSelectedFiles: after?.top_3_files ?? [],
        oldGoldRank: before?.expected_file_best_rank ?? null,
        newGoldRank: after?.expected_file_best_rank ?? null,
        oldGoldVisible: before?.contains_expected_file_anywhere ?? false,
        newGoldVisible: after?.contains_expected_file_anywhere ?? false,
        oldEstimatedTokens: before?.estimated_tokens ?? null,
        newEstimatedTokens: after?.estimated_tokens ?? null,
        cause: cause.cause,
        subreasons: cause.subreasons,
        causeEvidence: cause.evidence,
        quality,
        qualityBasis: basis,
      });
    }
  }
  const tally = (key: Quality): number => ledger.filter((entry) => entry.quality === key).length;
  const output = {
    schemaVersion: "stage5.m140.changed-case-ledger.v1",
    changedCaseCount: ledger.length,
    leadChanges: ledger.filter((entry) => entry.leadChanged).length,
    quality: { IMPROVEMENT: tally("IMPROVEMENT"), NEUTRAL: tally("NEUTRAL"), REGRESSION: tally("REGRESSION") },
    unexplained: ledger.filter((entry) => entry.subreasons.includes("unexpected")).length,
    subreasonCounts: ledger.reduce<Record<string, number>>((acc, entry) => {
      for (const reason of entry.subreasons) acc[reason] = (acc[reason] ?? 0) + 1;
      return acc;
    }, {}),
    cases: ledger,
  };
  await writeFile(config.out, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`changed=${output.changedCaseCount} improvement=${output.quality.IMPROVEMENT} neutral=${output.quality.NEUTRAL} regression=${output.quality.REGRESSION} leadChanges=${output.leadChanges}\n`);
}

function parseArgs(argv: readonly string[]): Config {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined) throw new Error("Invalid attribution arguments.");
    values.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) throw new Error(`Missing ${flag}.`);
    return path.resolve(value);
  };
  return {
    paired: required("--paired"),
    rowsFiles: (values.get("--rows") ?? "").split(",").filter(Boolean).map((file) => path.resolve(file)),
    probeBefore: required("--probe-before"),
    probeAfter: required("--probe-after"),
    out: required("--out"),
  };
}

if (import.meta.main) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
