/**
 * M157 §70/§71/§103 — the broad100 checkpoint, M156 final -> M157 final.
 *
 * Metric definitions are inherited verbatim from `run_stage5_m156_broad_comparison.ts`
 * (which in turn takes them from the scorer's vocabulary) so the numbers stay
 * comparable to every earlier checkpoint. What this runner adds is the per-case
 * CLASSIFICATION M157 requires: unlike M156, M157 expects changed cases, so
 * "changedCases: 2" is only meaningful if each one is attributed to a mechanism
 * and scored as an improvement, a regression, or neutral.
 *
 * NO Claude, NO Docker, NO agent run, NO API calls, NO network.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RetrievalEvalRow } from "./run_stage5_retrieval_eval";

interface EvalArtifact {
  readonly rows: readonly RetrievalEvalRow[];
}

const RESULTS = path.join(import.meta.dir, "results");

/** A row the scorer could not evaluate is excluded from every rate (M155 §20). */
function isEvaluated(row: RetrievalEvalRow): boolean {
  return row.result !== "workspace_error" && row.result !== "fixture_error";
}

function rate(rows: readonly RetrievalEvalRow[], predicate: (row: RetrievalEvalRow) => boolean): number {
  const evaluated = rows.filter(isEvaluated);
  if (evaluated.length === 0) return 0;
  return Number((evaluated.filter(predicate).length / evaluated.length).toFixed(4));
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return Number((sorted[index] ?? 0).toFixed(2));
}

function summarize(rows: readonly RetrievalEvalRow[]): Record<string, number> {
  const evaluated = rows.filter(isEvaluated);
  const tokens = evaluated.map((row) => row.estimated_tokens ?? 0);
  return {
    cases: rows.length,
    evaluated: evaluated.length,
    goldFileTop1: rate(rows, (row) => row.contains_expected_file_top1),
    goldFileTop3: rate(rows, (row) => row.contains_expected_file_top3),
    goldFileAnywhere: rate(rows, (row) => row.contains_expected_file_anywhere),
    goldSymbolAnywhere: rate(rows, (row) => row.contains_expected_symbol_anywhere),
    goldDelivered: rate(rows, (row) => row.expected_file_role === "pivot" || row.expected_file_role === "support"),
    goldDiscarded: rate(rows, (row) => row.expected_file_role === "discarded"),
    goldMissing: rate(rows, (row) => row.expected_file_role === "missing"),
    // §71: the empty/support-only/pivot delivery split.
    emptyContexts: rate(rows, (row) => row.pivot_count === 0 && row.support_count === 0),
    supportOnlyContexts: rate(rows, (row) => row.pivot_count === 0 && row.support_count > 0),
    pivotContexts: rate(rows, (row) => row.pivot_count > 0),
    tokensMean: mean(tokens),
    tokensMedian: quantile(tokens, 0.5),
    tokensP90: quantile(tokens, 0.9),
  };
}

/** The per-case fields a difference must be attributable to (§58). */
function caseShape(row: RetrievalEvalRow): string {
  return JSON.stringify({
    top1: row.top_1_pivot_file,
    top3: row.top_3_files,
    role: row.expected_file_role,
    symbolRole: row.expected_symbol_role,
    pivots: row.pivot_count,
    support: row.support_count,
    discarded: row.discarded_count,
    result: row.result,
  });
}

const DELIVERED = new Set(["pivot", "support"]);

/**
 * §103 — classify a changed case by mechanism, and score it.
 *
 * M157's only functional change releases pivot slots that a later demotion
 * vacated, so the expected mechanism is `PIVOT_ROLE_CORRECTION`. Anything else
 * is `UNEXPECTED` by construction and must be explained before the milestone can
 * close — the classification is deliberately not permissive.
 */
function classifyChange(before: RetrievalEvalRow, after: RetrievalEvalRow): {
  classification: string;
  outcome: string;
} {
  const goldBefore = DELIVERED.has(before.expected_file_role);
  const goldAfter = DELIVERED.has(after.expected_file_role);
  const pivotsGained = after.pivot_count > before.pivot_count;

  if (!goldBefore && goldAfter) {
    // Recovered — but as WHAT? `SUPPORT_RECOVERY` is reserved for evidence that
    // becomes visible without edit-target authority (§104). Gold that comes back
    // as a pivot is an authority correction, and calling it support recovery
    // would credit M157 with a lane it deliberately did not build.
    return {
      classification: after.expected_file_role === "pivot" ? "PIVOT_ROLE_CORRECTION" : "SUPPORT_RECOVERY",
      outcome: "IMPROVEMENT",
    };
  }
  if (goldBefore && !goldAfter) {
    return { classification: "PIVOT_ROLE_CORRECTION", outcome: "REGRESSION" };
  }
  if (pivotsGained || after.pivot_count !== before.pivot_count) {
    // Gold delivery unchanged; the capsule gained or lost a pivot slot.
    return { classification: "PIVOT_ROLE_CORRECTION", outcome: "NEUTRAL" };
  }
  if (after.support_count !== before.support_count || after.discarded_count !== before.discarded_count) {
    return { classification: "TOKEN_ONLY_CHANGE", outcome: "NEUTRAL" };
  }
  return { classification: "UNEXPECTED", outcome: "NEUTRAL" };
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const get = (flag: string): string => {
    const index = argv.indexOf(flag);
    if (index < 0 || argv[index + 1] === undefined) throw new Error(`${flag} is required.`);
    return argv[index + 1]!;
  };
  const beforePath = get("--before");
  const afterPath = get("--after");

  const before = JSON.parse(await readFile(beforePath, "utf8")) as EvalArtifact;
  const after = JSON.parse(await readFile(afterPath, "utf8")) as EvalArtifact;

  const beforeById = new Map(before.rows.map((row) => [row.instance_id, row]));
  const changed: Array<Record<string, unknown>> = [];
  for (const candidate of after.rows) {
    const predecessor = beforeById.get(candidate.instance_id);
    if (predecessor === undefined) {
      changed.push({ instanceId: candidate.instance_id, classification: "UNEXPECTED", outcome: "REGRESSION",
        note: "absent from predecessor" });
      continue;
    }
    if (caseShape(predecessor) === caseShape(candidate)) continue;
    changed.push({
      instanceId: candidate.instance_id,
      repo: candidate.repo,
      ...classifyChange(predecessor, candidate),
      before: JSON.parse(caseShape(predecessor)),
      after: JSON.parse(caseShape(candidate)),
      tokensBefore: predecessor.estimated_tokens ?? 0,
      tokensAfter: candidate.estimated_tokens ?? 0,
    });
  }

  const beforeSummary = summarize(before.rows);
  const afterSummary = summarize(after.rows);
  const delta = Object.fromEntries(
    Object.keys(afterSummary).map((key) => [
      key,
      Number((afterSummary[key]! - beforeSummary[key]!).toFixed(4)),
    ]),
  );

  const tally = (field: "classification" | "outcome") =>
    changed.reduce<Record<string, number>>((acc, row) => {
      const key = String(row[field]);
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});

  const report = {
    schemaVersion: "stage5.m157.broad100-comparison.v1",
    milestone: "M157",
    checkpoint: "M156 final -> M157 final",
    note: "Same fresh, derivation-valid M156 corpus on both sides; only the executing "
      + "implementation differs. M157 EXPECTS changed cases, so every one is classified (§103).",
    predecessor: { label: "M156", eval: beforePath, summary: beforeSummary },
    candidate: { label: "M157", eval: afterPath, summary: afterSummary },
    delta,
    changedCases: changed.length,
    byClassification: tally("classification"),
    byOutcome: tally("outcome"),
    changed,
    unexplainedCases: changed.filter((row) => row.classification === "UNEXPECTED").length,
  };

  const out = path.join(RESULTS, "stage5_m157_broad100_comparison.json");
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  // eslint-disable-next-line no-console
  console.error(
    `broad100 M156->M157: top1 ${beforeSummary.goldFileTop1} -> ${afterSummary.goldFileTop1}, `
    + `top3 ${beforeSummary.goldFileTop3} -> ${afterSummary.goldFileTop3}, `
    + `delivered ${beforeSummary.goldDelivered} -> ${afterSummary.goldDelivered}, `
    + `empty ${beforeSummary.emptyContexts} -> ${afterSummary.emptyContexts}, `
    + `tokensMean ${beforeSummary.tokensMean} -> ${afterSummary.tokensMean}, `
    + `changedCases=${changed.length} -> ${out}`,
  );
}

await main();
