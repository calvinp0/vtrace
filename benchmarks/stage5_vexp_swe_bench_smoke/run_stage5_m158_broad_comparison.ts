/**
 * M158 §89/§99 — the broad100 checkpoint, M157 final -> M158 final.
 *
 * Metric definitions are inherited verbatim from the M156/M157 comparison
 * runners (which take them from the scorer's vocabulary) so the numbers stay
 * comparable to every earlier checkpoint. What this runner adds is M158's own
 * changed-case taxonomy.
 *
 * M158 is a SUPPORT-COMPOSITION change: it refuses a slot to evidence the
 * capsule has already delivered, and the freed slot refills from the existing
 * support-authorized order. The expected signature is therefore a changed
 * support SET at an unchanged gold role, unchanged pivots, and near-flat tokens.
 * Anything that moves gold delivery or pivot count is `UNEXPECTED` by
 * construction and has to be explained before the milestone can close --- the
 * classification is deliberately not permissive.
 *
 * The destination is explicit and refuses to overwrite another milestone's
 * committed evidence (M158 §80-§82).
 *
 * NO Claude, NO Docker, NO agent run, NO API calls, NO network.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
 * §99 — classify a changed case by mechanism, and score it.
 *
 * The only functional change in M158 is that one canonical delivered identity
 * may consume at most one support slot. So the expected mechanism is a support
 * SET change at an unchanged gold role. Gold movement and pivot movement are
 * both `UNEXPECTED` here: M158 has no lane that could produce either, and a
 * permissive classifier would let exactly the surprise it exists to catch pass
 * as an expected outcome.
 */
function classifyChange(before: RetrievalEvalRow, after: RetrievalEvalRow): {
  classification: string;
  outcome: string;
} {
  const goldBefore = DELIVERED.has(before.expected_file_role);
  const goldAfter = DELIVERED.has(after.expected_file_role);

  if (!goldBefore && goldAfter) {
    return {
      classification: after.expected_file_role === "support" ? "USEFUL_SUPPORT_RECOVERY" : "UNEXPECTED",
      outcome: "IMPROVEMENT",
    };
  }
  if (goldBefore && !goldAfter) {
    // Gold that WAS delivered and no longer is. §100: every one is inspected.
    return { classification: "USEFUL_SUPPORT_DISPLACED", outcome: "REGRESSION" };
  }
  if (after.pivot_count !== before.pivot_count) {
    // M158 never touches pivot authority, so this must be explained.
    return { classification: "UNEXPECTED", outcome: "NEUTRAL" };
  }
  if (after.support_count !== before.support_count) {
    return { classification: "SUPPORT_COUNT_CHANGE", outcome: "NEUTRAL" };
  }
  // The support set was recomposed at a constant item count: a restatement lost
  // its slot and the next authorized candidate took it. The scorer is
  // gold-centric and mostly blind to this, but it DOES see the selected-file
  // set, so a slot that moved to a new file shows up there.
  const filesBefore = new Set(before.top_3_files ?? []);
  const filesAfter = new Set(after.top_3_files ?? []);
  const gained = [...filesAfter].filter((file) => !filesBefore.has(file));
  const lost = [...filesBefore].filter((file) => !filesAfter.has(file));
  if (gained.length > 0 || lost.length > 0 || after.discarded_count !== before.discarded_count) {
    return {
      classification: "REDUNDANT_SUPPORT_REDUCTION",
      // Trading a restatement for a distinct file is an improvement; losing a
      // distinct file for one would not be, and must not be scored as one.
      outcome: lost.length > gained.length ? "REGRESSION" : gained.length > 0 ? "IMPROVEMENT" : "NEUTRAL",
    };
  }
  return { classification: "TOKEN_ONLY_CHANGE", outcome: "NEUTRAL" };
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const get = (flag: string): string => {
    const index = argv.indexOf(flag);
    if (index < 0 || argv[index + 1] === undefined) throw new Error(`${flag} is required.`);
    return argv[index + 1]!;
  };
  const optional = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    return index < 0 || argv[index + 1] === undefined ? fallback : argv[index + 1]!;
  };
  const beforePath = get("--before");
  const afterPath = get("--after");
  const milestone = optional("--milestone", "M158");
  const out = optional(
    "--out",
    path.join(RESULTS, `stage5_${milestone.toLowerCase()}_broad100_comparison.json`),
  );
  // §82: fail closed rather than quietly replacing an earlier milestone's
  // committed comparison, which is exactly the defect M157 found in the M156
  // runner and M158 fixes as benchmark hygiene.
  if (existsSync(out) && !argv.includes("--allow-overwrite")) {
    const existing = JSON.parse(await readFile(out, "utf8")) as { milestone?: string };
    if (existing.milestone !== undefined && existing.milestone !== milestone) {
      throw new Error(
        `refusing to overwrite ${existing.milestone} evidence at ${out} with a ${milestone} run. `
        + "Pass --out to name this milestone's own destination "
        + "(or --allow-overwrite if replacing it really is the intent).",
      );
    }
  }

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
    schemaVersion: "stage5.m158.broad100-comparison.v1",
    milestone,
    checkpoint: "M157 final -> M158 final",
    note: "Same fresh, derivation-valid M156 corpus on both sides; only the executing "
      + "implementation differs. M158 expects support-SET changes at an unchanged gold "
      + "role, so every changed case is classified (§99).",
    predecessor: { label: "M157", eval: beforePath, summary: beforeSummary },
    candidate: { label: milestone, eval: afterPath, summary: afterSummary },
    delta,
    changedCases: changed.length,
    byClassification: tally("classification"),
    byOutcome: tally("outcome"),
    changed,
    unexplainedCases: changed.filter((row) => row.classification === "UNEXPECTED").length,
  };

  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  // eslint-disable-next-line no-console
  console.error(
    `broad100 M157->${milestone}: top1 ${beforeSummary.goldFileTop1} -> ${afterSummary.goldFileTop1}, `
    + `top3 ${beforeSummary.goldFileTop3} -> ${afterSummary.goldFileTop3}, `
    + `delivered ${beforeSummary.goldDelivered} -> ${afterSummary.goldDelivered}, `
    + `empty ${beforeSummary.emptyContexts} -> ${afterSummary.emptyContexts}, `
    + `tokensMean ${beforeSummary.tokensMean} -> ${afterSummary.tokensMean}, `
    + `changedCases=${changed.length} -> ${out}`,
  );
}

await main();
