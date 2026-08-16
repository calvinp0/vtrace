// Stage 5 M155 — broad deterministic qualification analysis.
//
// Consumes what the paired benchmark already produced — each side's scored rows
// and the provenance-validated comparison — and emits the M155-B/C evidence
// artifacts. It computes NOTHING from the product directly; every metric is a
// projection of committed scorer output, so re-running it cannot move a result.
//
// Metric definitions are taken from the scorer's own vocabulary rather than
// invented here:
//   gold file Top-1/Top-3/anywhere  <- contains_expected_file_top{1,3}/anywhere
//   gold symbol Top-1/Top-3         <- expected_symbol_best_rank
//   gold symbol anywhere            <- contains_expected_symbol_anywhere
//   missing gold                    <- expected_file_role === "missing"
//   useful support                  <- expected_file_role === "support"
//   misleading lead                 <- a lead was delivered and it is not gold
//   empty result                    <- nothing delivered as pivot or support
//
// NO Claude, NO Docker, NO agent run, NO API calls, NO network.

import { readFile, writeFile } from "node:fs/promises";

import type { RetrievalEvalRow } from "./run_stage5_retrieval_eval";
import { samePath } from "./run_stage5_m143b_ownership_evidence_audit";
import { mean, median, percentile } from "./run_stage5_m155_latency_probe";

/** A row the scorer could not evaluate is excluded from every rate's denominator
 *  and reported separately — M155 §20 requires consistent denominators, and an
 *  unevaluable case is not a retrieval failure. */
export function isEvaluated(row: RetrievalEvalRow): boolean {
  return row.result !== "workspace_error" && row.result !== "fixture_error";
}

/** §20 separates "gold symbol could not be identified" from "gold symbol missed".
 *  Only cases carrying a symbol label can be scored for symbol rank. */
export function symbolIdentifiable(row: RetrievalEvalRow): boolean {
  return row.expected_symbols.length > 0;
}

/**
 * A lead was delivered and it is not a gold file.
 *
 * Gold paths in the fixtures are REPOSITORY-relative (`django/http/response.py`)
 * while the lead a capsule reports is WORKSPACE-relative (`http/response.py`), so
 * the comparison must go through `samePath`, which anchors on a path-segment
 * boundary in either direction. A literal `includes` scored 26 of these 100 cases
 * as misleading when the lead was in fact exactly gold — the same defect M143-A
 * hit, which is why `samePath` and its permanent guard exist at all.
 */
export function misleadingLead(row: RetrievalEvalRow): boolean {
  if (row.top_1_pivot_file === null) return false;
  return !row.expected_files.some((gold) => samePath(gold, row.top_1_pivot_file!));
}

export function emptyResult(row: RetrievalEvalRow): boolean {
  return row.pivot_count + row.support_count === 0;
}

/** Ordinal quality of one case, used ONLY to give a changed case a direction.
 *  Deliberately coarse: it ranks where gold landed, nothing else. */
export function caseScore(row: RetrievalEvalRow): number {
  if (row.contains_expected_file_top1) return 3;
  if (row.contains_expected_file_top3) return 2;
  if (row.contains_expected_file_anywhere) return 1;
  return 0;
}

export type Direction = "IMPROVEMENT" | "NEUTRAL" | "REGRESSION";

export function direction(before: RetrievalEvalRow, after: RetrievalEvalRow): Direction {
  const delta = caseScore(after) - caseScore(before);
  if (delta > 0) return "IMPROVEMENT";
  if (delta < 0) return "REGRESSION";
  return "NEUTRAL";
}

export const CHANGE_CLASSES = [
  "path authority",
  "symbol authority",
  "delivery",
  "candidate cap",
  "contract-only change",
  "unknown",
] as const;
export type ChangeClass = (typeof CHANGE_CLASSES)[number];

/**
 * Conservative change attribution. M155 §52 is explicit that attribution must not
 * be forced, so this only names a cause when the scored evidence shows it, and
 * defaults to `unknown` otherwise. It never guesses an era-specific mechanism —
 * that is what the per-case ledger's raw evidence is for.
 */
export function classifyChange(before: RetrievalEvalRow, after: RetrievalEvalRow): ChangeClass {
  const leadMoved = before.top_1_pivot_file !== after.top_1_pivot_file;
  const symbolMoved = before.top_1_pivot_symbol !== after.top_1_pivot_symbol;
  const goldMoved = caseScore(before) !== caseScore(after);
  const roleMoved = before.expected_file_role !== after.expected_file_role;
  const deliveredMoved =
    before.pivot_count !== after.pivot_count || before.support_count !== after.support_count;
  const discardMoved = before.discarded_count !== after.discarded_count;

  if (leadMoved && goldMoved) return "path authority";
  if (!leadMoved && symbolMoved && goldMoved) return "symbol authority";
  // Gold changed role without the lead moving: it crossed the delivery boundary
  // (support <-> discarded <-> missing) rather than being ranked differently.
  if (roleMoved && !leadMoved) {
    return after.expected_file_role === "discarded" || before.expected_file_role === "discarded"
      ? "candidate cap"
      : "delivery";
  }
  if (deliveredMoved || discardMoved) return "delivery";
  if (!goldMoved && !leadMoved) return "contract-only change";
  return "unknown";
}

export interface CheckpointMetrics {
  readonly label: string;
  readonly cases: number;
  readonly evaluated: number;
  readonly unevaluated: number;
  readonly goldFileTop1: number;
  readonly goldFileTop3: number;
  readonly goldFileAnywhere: number;
  readonly goldSymbolScorable: number;
  readonly goldSymbolTop1: number;
  readonly goldSymbolTop3: number;
  readonly goldSymbolAnywhere: number;
  readonly missingGold: number;
  /** Gold actually DELIVERED to the model (pivot or support). `goldFileAnywhere`
   *  also counts `discarded`, which the capsule surfaces as a candidate and then
   *  withholds — so the two can move in opposite directions, and only this one
   *  describes what an agent could act on. */
  readonly goldDelivered: number;
  readonly goldDiscarded: number;
  readonly usefulSupport: number;
  readonly misleadingLead: number;
  readonly emptyResult: number;
  readonly tokensMean: number | null;
  readonly tokensMedian: number | null;
  readonly tokensP90: number | null;
}

const rate = (hits: number, total: number): number =>
  total === 0 ? 0 : Math.round((hits / total) * 10000) / 10000;

export function summarizeCheckpoint(label: string, rows: readonly RetrievalEvalRow[]): CheckpointMetrics {
  const evaluated = rows.filter(isEvaluated);
  const symbolScorable = evaluated.filter(symbolIdentifiable);
  const tokens = evaluated
    .map((row) => row.estimated_tokens)
    .filter((value): value is number => value !== null);
  const n = evaluated.length;
  return {
    label,
    cases: rows.length,
    evaluated: n,
    unevaluated: rows.length - n,
    goldFileTop1: rate(evaluated.filter((r) => r.contains_expected_file_top1).length, n),
    goldFileTop3: rate(evaluated.filter((r) => r.contains_expected_file_top3).length, n),
    goldFileAnywhere: rate(evaluated.filter((r) => r.contains_expected_file_anywhere).length, n),
    goldSymbolScorable: symbolScorable.length,
    goldSymbolTop1: rate(
      symbolScorable.filter((r) => r.expected_symbol_best_rank !== null && r.expected_symbol_best_rank <= 1).length,
      symbolScorable.length,
    ),
    goldSymbolTop3: rate(
      symbolScorable.filter((r) => r.expected_symbol_best_rank !== null && r.expected_symbol_best_rank <= 3).length,
      symbolScorable.length,
    ),
    goldSymbolAnywhere: rate(
      symbolScorable.filter((r) => r.contains_expected_symbol_anywhere).length,
      symbolScorable.length,
    ),
    missingGold: rate(evaluated.filter((r) => r.expected_file_role === "missing").length, n),
    goldDelivered: rate(
      evaluated.filter((r) => r.expected_file_role === "pivot" || r.expected_file_role === "support").length,
      n,
    ),
    goldDiscarded: rate(evaluated.filter((r) => r.expected_file_role === "discarded").length, n),
    usefulSupport: rate(evaluated.filter((r) => r.expected_file_role === "support").length, n),
    misleadingLead: rate(evaluated.filter(misleadingLead).length, n),
    emptyResult: rate(evaluated.filter(emptyResult).length, n),
    tokensMean: tokens.length > 0 ? Math.round(mean(tokens)!) : null,
    tokensMedian: tokens.length > 0 ? Math.round(median(tokens)!) : null,
    tokensP90: tokens.length > 0 ? Math.round(percentile(tokens, 0.9)!) : null,
  };
}

export interface ChangedCase {
  readonly instance_id: string;
  readonly repo: string;
  readonly before: string;
  readonly after: string;
  readonly historicalResult: string;
  readonly candidateResult: string;
  readonly historicalLead: string | null;
  readonly candidateLead: string | null;
  readonly goldFiles: readonly string[];
  readonly historicalRole: string;
  readonly candidateRole: string;
  readonly classification: ChangeClass;
  readonly directionLabel: Direction;
}

export function changedCases(
  beforeLabel: string,
  afterLabel: string,
  before: readonly RetrievalEvalRow[],
  after: readonly RetrievalEvalRow[],
): ChangedCase[] {
  const byId = new Map(before.map((row) => [row.instance_id, row]));
  const out: ChangedCase[] = [];
  for (const post of after) {
    const pre = byId.get(post.instance_id);
    if (pre === undefined) continue;
    // Outcome-relevant change OR delivery-level change. The second disjunct is what
    // makes `contract-only change` reachable: a case whose gold placement and lead
    // are identical but whose delivered set or token accounting moved is a real
    // change, and classifying it as such is the only way the class can ever be
    // observed rather than asserted.
    const changed =
      caseScore(pre) !== caseScore(post) ||
      pre.top_1_pivot_file !== post.top_1_pivot_file ||
      pre.top_1_pivot_symbol !== post.top_1_pivot_symbol ||
      pre.expected_file_role !== post.expected_file_role ||
      pre.pivot_count !== post.pivot_count ||
      pre.support_count !== post.support_count ||
      pre.discarded_count !== post.discarded_count ||
      pre.estimated_tokens !== post.estimated_tokens ||
      pre.top_3_files.join(" ") !== post.top_3_files.join(" ") ||
      pre.result !== post.result;
    if (!changed) continue;
    out.push({
      instance_id: post.instance_id,
      repo: post.repo,
      before: beforeLabel,
      after: afterLabel,
      historicalResult: pre.result,
      candidateResult: post.result,
      historicalLead: pre.top_1_pivot_file,
      candidateLead: post.top_1_pivot_file,
      goldFiles: post.expected_files,
      historicalRole: pre.expected_file_role,
      candidateRole: post.expected_file_role,
      classification: classifyChange(pre, post),
      directionLabel: direction(pre, post),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface SideRows {
  readonly label: string;
  readonly commit: string;
  readonly rows: readonly RetrievalEvalRow[];
}

/** Shape written by `run_stage5_m140_paired_benchmark.ts`: `<prefix>_<suite>_rows.json`. */
async function loadRows(file: string): Promise<{ predecessor: SideRows; candidate: SideRows }> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as {
    suite: string;
    predecessor: SideRows;
    candidate: SideRows;
  };
  return { predecessor: parsed.predecessor, candidate: parsed.candidate };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string): string => {
    const i = argv.indexOf(flag);
    if (i < 0 || argv[i + 1] === undefined) throw new Error(`${flag} is required.`);
    return argv[i + 1]!;
  };
  // --transitions "M129:M140:/path/rows.json;M140:M150:/path/rows.json;..."
  const transitions = get("--transitions").split(";").filter(Boolean).map((spec) => {
    const [before, after, rowsFile] = spec.split(":");
    if (!before || !after || !rowsFile) throw new Error(`Invalid transition spec: ${spec}`);
    return { before, after, rowsFile };
  });
  const outDir = get("--out-dir");

  const checkpoints = new Map<string, readonly RetrievalEvalRow[]>();
  const allChanged: ChangedCase[] = [];
  const transitionSummaries = [];

  for (const t of transitions) {
    const { predecessor, candidate } = await loadRows(t.rowsFile);
    checkpoints.set(t.before, predecessor.rows);
    checkpoints.set(t.after, candidate.rows);
    const changed = changedCases(t.before, t.after, predecessor.rows, candidate.rows);
    allChanged.push(...changed);
    transitionSummaries.push({
      transition: `${t.before}->${t.after}`,
      changedCases: changed.length,
      improvements: changed.filter((c) => c.directionLabel === "IMPROVEMENT").length,
      regressions: changed.filter((c) => c.directionLabel === "REGRESSION").length,
      neutral: changed.filter((c) => c.directionLabel === "NEUTRAL").length,
      byClassification: Object.fromEntries(
        CHANGE_CLASSES.map((c) => [c, changed.filter((x) => x.classification === c).length]),
      ),
    });
  }

  const metrics = [...checkpoints.entries()].map(([label, rows]) => summarizeCheckpoint(label, rows));

  // --- candidate-specific broad qualification artifacts (§83) ---------------
  const candidateLabel = get("--candidate-label");
  const candidateRows = checkpoints.get(candidateLabel);
  if (candidateRows === undefined) {
    throw new Error(`--candidate-label ${candidateLabel} is not present in any transition.`);
  }
  const candidateMetrics = summarizeCheckpoint(candidateLabel, candidateRows);
  await writeFile(
    `${outDir}/stage5_m155_retrieval_m154.json`,
    `${JSON.stringify({
      schemaVersion: "stage5.m155.candidate-retrieval.v1",
      candidate: candidateLabel,
      metrics: candidateMetrics,
    }, null, 2)}\n`,
  );

  // Per-case ledger for the candidate: what happened on every one of the broad
  // cases, not only the ones that moved between eras.
  await writeFile(
    `${outDir}/stage5_m155_retrieval_case_ledger.json`,
    `${JSON.stringify({
      schemaVersion: "stage5.m155.case-ledger.v1",
      candidate: candidateLabel,
      cases: candidateRows.map((r) => ({
        instance_id: r.instance_id,
        repo: r.repo,
        result: r.result,
        miss_category: r.miss_category,
        gold_files: r.expected_files,
        gold_file_role: r.expected_file_role,
        gold_file_best_rank: r.expected_file_best_rank,
        gold_symbol_best_rank: r.expected_symbol_best_rank,
        gold_symbol_scorable: symbolIdentifiable(r),
        lead: r.top_1_pivot_file,
        misleading_lead: misleadingLead(r),
        empty_result: emptyResult(r),
        pivot_count: r.pivot_count,
        support_count: r.support_count,
        discarded_count: r.discarded_count,
        estimated_tokens: r.estimated_tokens,
      })),
    }, null, 2)}\n`,
  );

  // --- latency trend (§69), if probe outputs were supplied ------------------
  const latencyDir = argv.includes("--latency-dir") ? get("--latency-dir") : null;
  if (latencyDir !== null) {
    const trend = [];
    for (const label of checkpoints.keys()) {
      try {
        const probe = JSON.parse(await readFile(`${latencyDir}/${label.toLowerCase()}_latency.json`, "utf8")) as {
          label: string; commit: string; cases: number; measured: number; failed: number;
          mean_ms: number | null; median_ms: number | null; p90_ms: number | null;
        };
        trend.push({
          label: probe.label, commit: probe.commit, cases: probe.cases,
          measured: probe.measured, failed: probe.failed,
          mean_ms: probe.mean_ms, median_ms: probe.median_ms, p90_ms: probe.p90_ms,
        });
      } catch {
        trend.push({ label, commit: null, cases: null, measured: 0, failed: null,
          mean_ms: null, median_ms: null, p90_ms: null, note: "latency probe output unavailable" });
      }
    }
    await writeFile(
      `${outDir}/stage5_m155_latency_trend.json`,
      `${JSON.stringify({ schemaVersion: "stage5.m155.latency-trend.v1", checkpoints: trend }, null, 2)}\n`,
    );
  }

  // --- legacy suite projections (§101) -------------------------------------
  // Frozen50 / Django / cross_repo_30 are strict SUBSETS of the broad corpus, so
  // they are reported by restricting the same rows rather than by running them
  // again. That keeps them on exactly the M155 protocol — same fixture identity,
  // same prepared indexes, same scorer — instead of a second, differently
  // provenanced measurement of the same thing.
  const subsetSpecs = argv.includes("--subsets")
    ? get("--subsets").split(";").filter(Boolean).map((spec) => {
        const [name, fixturePath] = spec.split("=");
        if (!name || !fixturePath) throw new Error(`Invalid subset spec: ${spec}`);
        return { name, fixturePath };
      })
    : [];
  const subsetReports = [];
  for (const spec of subsetSpecs) {
    const ids = new Set(
      (JSON.parse(await readFile(spec.fixturePath, "utf8")) as Array<{ instance_id: string }>)
        .map((e) => e.instance_id),
    );
    const perCheckpoint = [...checkpoints.entries()].map(([label, rows]) =>
      summarizeCheckpoint(label, rows.filter((r) => ids.has(r.instance_id))),
    );
    const covered = candidateRows.filter((r) => ids.has(r.instance_id)).length;
    subsetReports.push({
      name: spec.name,
      declaredCases: ids.size,
      coveredByBroadCorpus: covered,
      complete: covered === ids.size,
      checkpoints: perCheckpoint,
    });
  }
  if (subsetReports.length > 0) {
    await writeFile(
      `${outDir}/stage5_m155_legacy_suite_projection.json`,
      `${JSON.stringify({
        schemaVersion: "stage5.m155.legacy-suite-projection.v1",
        note: "Legacy deterministic suites reported as subsets of the M155 broad corpus, under the identical M155 protocol.",
        suites: subsetReports,
      }, null, 2)}\n`,
    );
  }

  // --- human-readable summary ----------------------------------------------
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const md: string[] = [
    "# Stage 5 M155-B/C — broad deterministic retrieval qualification",
    "",
    `Candidate: **${candidateLabel}**. Corpus: ${candidateMetrics.cases} frozen SWE-bench cases.`,
    "",
    "## Checkpoint trend (§68)",
    "",
    "| Checkpoint | Evaluated | File Top-1 | File Top-3 | Gold **delivered** | Gold anywhere | Gold discarded | Symbol anywhere | Missing gold | Misleading lead | Empty | Tokens (median) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...metrics.map((m) =>
      `| ${m.label} | ${m.evaluated}/${m.cases} | ${pct(m.goldFileTop1)} | ${pct(m.goldFileTop3)} | ${pct(m.goldDelivered)} | ${pct(m.goldFileAnywhere)} | ${pct(m.goldDiscarded)} | ${pct(m.goldSymbolAnywhere)} | ${pct(m.missingGold)} | ${pct(m.misleadingLead)} | ${pct(m.emptyResult)} | ${m.tokensMedian ?? "n/a"} |`,
    ),
    "",
    "`Gold delivered` = gold reached the model as pivot or support. `Gold anywhere`",
    "additionally counts `discarded` — surfaced as a candidate and then withheld — so",
    "the two columns can move in opposite directions. Only `Gold delivered` describes",
    "evidence an agent could act on.",
    "",
    "## Adjacent transitions (§67)",
    "",
    "| Transition | Changed | Improvement | Regression | Neutral |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...transitionSummaries.map((t) =>
      `| ${t.transition} | ${t.changedCases} | ${t.improvements} | ${t.regressions} | ${t.neutral} |`,
    ),
    "",
    "## Change attribution (§26)",
    "",
    "| Transition | " + CHANGE_CLASSES.join(" | ") + " |",
    "| --- |" + CHANGE_CLASSES.map(() => " ---: |").join(""),
    ...transitionSummaries.map((t) =>
      `| ${t.transition} | ` + CHANGE_CLASSES.map((c) => String(t.byClassification[c] ?? 0)).join(" | ") + " |",
    ),
    "",
  ];
  await writeFile(`${outDir}/stage5_m155_retrieval_summary.md`, `${md.join("\n")}\n`);

  await writeFile(
    `${outDir}/stage5_m155_historical_checkpoints.json`,
    `${JSON.stringify({ schemaVersion: "stage5.m155.checkpoints.v1", checkpoints: metrics }, null, 2)}\n`,
  );
  await writeFile(
    `${outDir}/stage5_m155_historical_comparison.json`,
    `${JSON.stringify({ schemaVersion: "stage5.m155.historical-comparison.v1", transitions: transitionSummaries }, null, 2)}\n`,
  );
  await writeFile(
    `${outDir}/stage5_m155_historical_changed_cases.json`,
    `${JSON.stringify({ schemaVersion: "stage5.m155.changed-cases.v1", cases: allChanged }, null, 2)}\n`,
  );

  for (const summary of transitionSummaries) {
    process.stdout.write(
      `${summary.transition}: changed=${summary.changedCases} +${summary.improvements}/-${summary.regressions} (neutral ${summary.neutral})\n`,
    );
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
