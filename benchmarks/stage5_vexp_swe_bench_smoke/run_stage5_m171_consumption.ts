/**
 * M171 — agent-consumption analysis over valid historical live transcripts (§39).
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m171_consumption.ts
 *
 * The twelve M168 `vtrace_clean` runs each carry the EXACT envelope the agent was
 * handed, inside the transcript's own tool_result block, followed by everything
 * the agent then did. That makes this the authoritative pairing: the orientation
 * under test and the behaviour it produced, from one artifact.
 *
 * This runner reports the CURRENT default's consumption profile. It writes no
 * projection and takes no design decision; §39's rule is that projection choices
 * are derived from behaviour, never from per-task gold.
 *
 * Offline. Reads transcripts only.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

import { median, surfacedFilePaths, surfacedSymbols } from "./m171Contract";
import { judgeConsumption } from "./m171Consumption";
import { readLiveRun } from "./m171LiveRuns";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

const DEVELOPMENT_RUNS: readonly string[] = Object.freeze([
  "m168_vtrace_clean_astropy__astropy_14369", "m168_vtrace_clean_django__django_13658",
  "m168_vtrace_clean_matplotlib__matplotlib_22719", "m168_vtrace_clean_mwaskom__seaborn_3187",
  "m168_vtrace_clean_pallets__flask_5014", "m168_vtrace_clean_psf__requests_1724",
  "m168_vtrace_clean_pydata__xarray_6599", "m168_vtrace_clean_pylint_dev__pylint_4551",
  "m168_vtrace_clean_pytest_dev__pytest_7432", "m168_vtrace_clean_scikit_learn__scikit_learn_10844",
  "m168_vtrace_clean_sphinx_doc__sphinx_7462", "m168_vtrace_clean_sympy__sympy_13480",
]);

function main(): void {
  const rows = DEVELOPMENT_RUNS.map((label) => {
    const run = readLiveRun(label);
    if (run === null || run.pipelineOutput === null) {
      return { label, readable: false as const };
    }
    const files = surfacedFilePaths(run.pipelineOutput);
    const verdict = judgeConsumption(run.actions, files);
    return {
      label,
      readable: true as const,
      envelopeCharacters: run.pipelineEnvelopeCharacters,
      surfacedFiles: files.size,
      surfacedSymbols: surfacedSymbols(run.pipelineOutput).size,
      totalToolCalls: run.actions.length,
      repositoryActions: run.actions.filter((action) => action.countsAsRepositoryAction).length,
      shellActions: run.actions.filter((action) => action.kind === "SHELL").length,
      firstAction: verdict.firstMeaningfulAction === null ? null : {
        tool: verdict.firstMeaningfulAction.tool,
        path: verdict.firstMeaningfulAction.path,
        supported: verdict.firstActionSupported,
      },
      earlyPhaseTotal: verdict.earlyPhaseTotal,
      earlyPhaseSupported: verdict.earlyPhaseSupported,
      earlyPhaseSupportRate: verdict.earlyPhaseSupportRate,
      firstEditPath: verdict.firstEditPath,
      firstEditSupported: verdict.firstEditSupported,
      surfacedNeverTouched: verdict.surfacedNeverTouched.length,
      surfacedNeverTouchedShare: files.size === 0 ? null : verdict.surfacedNeverTouched.length / files.size,
      touchedNeverSurfaced: verdict.touchedNeverSurfaced,
    };
  });

  const readable = rows.filter((row): row is Extract<typeof row, { readable: true }> => row.readable);
  const withFirst = readable.filter((row) => row.firstAction !== null);
  const withEdit = readable.filter((row) => row.firstEditSupported !== null);

  const body = {
    schemaVersion: "stage5.m171.agent-consumption.v1",
    milestone: "M171",
    workstream: "M171-B",
    title: "What agents did with the orientation they were handed, on twelve valid live runs",
    frozenDefinitions: {
      repositoryAction: "Read/Edit/Write/NotebookEdit, or a Grep/Glob carrying an explicit path or glob. Bash is recorded and never counted.",
      firstMeaningfulAction: "the first repository action strictly after the orientation result",
      earlyPhase: "every repository action strictly before the first Edit/Write/NotebookEdit; the whole run when it never edits",
      support: "the action's repo-relative FILE path is among the file paths the response surfaced",
      frozenBefore: "these definitions were written into m171Consumption.ts before any rate was computed (§41)",
    },
    source: "M168 vtrace_clean first-pass transcripts; the envelope measured is the one inside the agent's own tool_result block",
    aggregate: {
      runs: rows.length,
      readable: readable.length,
      firstActionSupported: withFirst.filter((row) => row.firstAction?.supported === true).length,
      firstActionMeasurable: withFirst.length,
      firstActionSupportRate: withFirst.length === 0 ? null : withFirst.filter((row) => row.firstAction?.supported === true).length / withFirst.length,
      firstEditSupported: withEdit.filter((row) => row.firstEditSupported === true).length,
      firstEditMeasurable: withEdit.length,
      medianEarlyPhaseSupportRate: median(readable.map((row) => row.earlyPhaseSupportRate ?? 0)),
      medianSurfacedFiles: median(readable.map((row) => row.surfacedFiles)),
      medianSurfacedNeverTouchedShare: median(readable.map((row) => row.surfacedNeverTouchedShare ?? 0)),
      medianRepositoryActions: median(readable.map((row) => row.repositoryActions)),
    },
    rows,
  };

  writeFileSync(path.join(RESULTS, "stage5_m171_action_support.json"), `${JSON.stringify(body, null, 1)}\n`);
  process.stdout.write(`wrote stage5_m171_action_support.json\n${JSON.stringify(body.aggregate, null, 1)}\n`);
}

main();
