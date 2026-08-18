/**
 * M156 §58 — the major-checkpoint broad comparison, M154 final → M156 final.
 *
 * M156 changes the index lifecycle, so a broad retrieval comparison is not
 * optional bookkeeping: it is the check that containment bought availability
 * without moving anything else. Both sides are freshly prepared corpora, each
 * indexed by its OWN binary — no era-copied SQLite, which is the M155-B2 lesson.
 *
 * Metric definitions are taken from the scorer's vocabulary rather than invented
 * here, matching `run_stage5_m155_analysis.ts` so the numbers are comparable to
 * every earlier checkpoint:
 *
 *   gold file Top-1/Top-3/anywhere  <- contains_expected_file_top{1,3}/anywhere
 *   gold symbol anywhere            <- contains_expected_symbol_anywhere
 *   gold delivered                  <- expected_file_role is pivot or support
 *   gold discarded                  <- expected_file_role === "discarded"
 *   gold missing                    <- expected_file_role === "missing"
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

function summarize(rows: readonly RetrievalEvalRow[]): Record<string, number> {
  return {
    cases: rows.length,
    evaluated: rows.filter(isEvaluated).length,
    goldFileTop1: rate(rows, (row) => row.contains_expected_file_top1),
    goldFileTop3: rate(rows, (row) => row.contains_expected_file_top3),
    goldFileAnywhere: rate(rows, (row) => row.contains_expected_file_anywhere),
    goldSymbolAnywhere: rate(rows, (row) => row.contains_expected_symbol_anywhere),
    goldDelivered: rate(rows, (row) => row.expected_file_role === "pivot" || row.expected_file_role === "support"),
    goldDiscarded: rate(rows, (row) => row.expected_file_role === "discarded"),
    goldMissing: rate(rows, (row) => row.expected_file_role === "missing"),
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
  // M158 §80-§82: this runner used to write one hardcoded destination, so
  // reusing it for a later checkpoint silently overwrote M156's COMMITTED
  // evidence with a different comparison. The destination is now explicit, and
  // overwriting another milestone's artifact fails closed rather than
  // succeeding quietly.
  const milestone = optional("--milestone", "M156");
  const checkpoint = optional("--checkpoint", "M154 final -> M156 final");
  const predecessorLabel = optional("--predecessor-label", "M154");
  const candidateLabel = optional("--candidate-label", "M156");
  const out = optional(
    "--out",
    path.join(RESULTS, `stage5_${milestone.toLowerCase()}_broad100_comparison.json`),
  );
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
      changed.push({ instanceId: candidate.instance_id, kind: "absent_from_predecessor" });
      continue;
    }
    if (caseShape(predecessor) !== caseShape(candidate)) {
      changed.push({
        instanceId: candidate.instance_id,
        repo: candidate.repo,
        before: JSON.parse(caseShape(predecessor)),
        after: JSON.parse(caseShape(candidate)),
      });
    }
  }

  const beforeSummary = summarize(before.rows);
  const afterSummary = summarize(after.rows);
  const delta = Object.fromEntries(
    Object.keys(afterSummary).map((key) => [
      key,
      Number((afterSummary[key]! - beforeSummary[key]!).toFixed(4)),
    ]),
  );

  const report = {
    schemaVersion: "stage5.m156.broad100-comparison.v1",
    milestone,
    checkpoint,
    note: "Both sides freshly prepared and indexed by their own binary. No era-copied "
      + "SQLite fixtures (M155-B2).",
    predecessor: { label: predecessorLabel, eval: beforePath, summary: beforeSummary },
    candidate: { label: candidateLabel, eval: afterPath, summary: afterSummary },
    delta,
    changedCases: changed.length,
    changed,
    // The headline claim this artifact exists to support.
    unchangedOnCleanRepositories: changed.length === 0,
  };

  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  // eslint-disable-next-line no-console
  console.error(
    `broad100 ${predecessorLabel}->${candidateLabel}: top1 ${beforeSummary.goldFileTop1} -> ${afterSummary.goldFileTop1}, `
    + `delivered ${beforeSummary.goldDelivered} -> ${afterSummary.goldDelivered}, `
    + `symbolAnywhere ${beforeSummary.goldSymbolAnywhere} -> ${afterSummary.goldSymbolAnywhere}, `
    + `changedCases=${changed.length} -> ${out}`,
  );
}

await main();
