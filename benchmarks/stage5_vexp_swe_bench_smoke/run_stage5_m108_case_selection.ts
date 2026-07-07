// Stage 5 M108 — pre-registered deterministic case selection for the 100-case
// live-confirmation extension. Selects the REMAINING 50 cases (the complement
// of the 14 committed M105 + 10 committed M106 + 26 committed M107 live cases
// over the frozen 100-case pool) using ONLY frozen committed inputs, BEFORE
// any live run:
//
//   pool      stage5_m103_deterministic_scoreboard.detail.json (100 scored rows)
//   history   stage5_m73_final_100_paired.detail.json (per-case treatment arm)
//             stage5_m92_core_reduction50_validation.md (run matrix, 50 cases)
//   cohorts   stage5_m95_dev_holdout_split.json (dev/holdout membership)
//   exclude   the 14 M105 live case ids (SMOKE_CASE_IDS) + the 10 M106
//             extension ids (stage5_m106_case_selection.json) + the 26 M107
//             extension ids (stage5_m107_case_selection.json)
//
// There is NO sampling: every remaining scored case is selected. If the
// complement is not exactly 50, this script exits non-zero and NO live run
// may start. NO agents, NO Docker, NO API spend, NO network.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m108_case_selection.ts \
//     [--out benchmarks/stage5_vexp_swe_bench_smoke/results]

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { SMOKE_CASE_IDS } from "./run_stage5_m104_live_context_smoke";
import { parseM92RunMatrix } from "./run_stage5_m105_collect";
import { type M106SelectionCandidate } from "./run_stage5_m106_lib";
import { M108_EXPECTED_REMAINING, m108Phase, selectM108RemainingCases } from "./run_stage5_m108_lib";

const RESULTS_ROOT = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "results");

interface M103Row {
  readonly instance_id: string;
  readonly repo: string;
  readonly outcome: string | null;
  readonly generation_status: string | null;
  readonly gold: { readonly multi_file?: boolean } | null;
  readonly derivation: unknown;
}

interface M73Row {
  readonly instance_id: string;
  readonly treatment_valid?: boolean;
  readonly treatment_resolved?: boolean;
  readonly treatment_cost?: number;
  readonly baseline_resolved?: boolean;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const outDir = outIdx >= 0 && argv[outIdx + 1] !== undefined ? argv[outIdx + 1]! : RESULTS_ROOT;

  const m103Rows = (
    JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m103_deterministic_scoreboard.detail.json"), "utf8")) as {
      rows: M103Row[];
    }
  ).rows;
  const m73Rows = new Map<string, M73Row>(
    (JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m73_final_100_paired.detail.json"), "utf8")) as M73Row[]).map(
      (r) => [r.instance_id, r],
    ),
  );
  const m92Resolved = parseM92RunMatrix(
    readFileSync(path.join(RESULTS_ROOT, "stage5_m92_core_reduction50_validation.md"), "utf8"),
  );
  const split = JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m95_dev_holdout_split.json"), "utf8")) as {
    dev: string[];
    holdout: string[];
  };
  const holdout = new Set(split.holdout);
  const m106Selection = JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m106_case_selection.json"), "utf8")) as {
    selected: Array<{ instance_id: string }>;
  };
  const m106Ids = m106Selection.selected.map((s) => s.instance_id);
  const m107Selection = JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m107_case_selection.json"), "utf8")) as {
    selected: Array<{ instance_id: string }>;
  };
  const m107Ids = m107Selection.selected.map((s) => s.instance_id);

  const candidates: M106SelectionCandidate[] = m103Rows.map((r) => {
    const m73 = m73Rows.get(r.instance_id);
    return {
      instance_id: r.instance_id,
      repo: r.repo,
      m103_outcome: r.outcome,
      multi_file: r.gold?.multi_file === true,
      scored: r.generation_status === "scored" && r.derivation !== null && r.derivation !== undefined,
      m73_treatment_valid: m73?.treatment_valid === true,
      m73_treatment_resolved: typeof m73?.treatment_resolved === "boolean" ? m73.treatment_resolved : null,
      in_m92: m92Resolved.has(r.instance_id),
      in_holdout: holdout.has(r.instance_id),
    };
  });

  const exclude = new Set<string>([...SMOKE_CASE_IDS, ...m106Ids, ...m107Ids]);
  if (exclude.size !== SMOKE_CASE_IDS.length + m106Ids.length + m107Ids.length)
    throw new Error("M105/M106/M107 committed case sets overlap — reuse contract violated upstream");
  const result = selectM108RemainingCases(candidates, exclude);
  if (result.selected.length !== M108_EXPECTED_REMAINING) {
    process.stderr.write(
      `[m108-select] FATAL: complement is ${result.selected.length} cases, expected ${M108_EXPECTED_REMAINING} — ` +
        `no live run may start until this is explained (rejected: ${JSON.stringify(result.rejected)})\n`,
    );
    process.exitCode = 1;
    return;
  }
  const byId = new Map(candidates.map((c) => [c.instance_id, c]));

  const selectionDetail = result.selected.map((s, i) => {
    const c = byId.get(s.instance_id)!;
    const m73 = m73Rows.get(s.instance_id);
    return {
      order: i + 1,
      phase: m108Phase(i),
      instance_id: s.instance_id,
      selection_stratum: s.stratum,
      repo: c.repo,
      m103_outcome: c.m103_outcome,
      multi_file: c.multi_file,
      in_holdout: c.in_holdout,
      m73_treatment_valid: c.m73_treatment_valid,
      m73_treatment_resolved: c.m73_treatment_resolved,
      m73_baseline_resolved: typeof m73?.baseline_resolved === "boolean" ? m73.baseline_resolved : null,
      m73_treatment_cost: m73?.treatment_cost ?? null,
      m92_resolved: m92Resolved.get(s.instance_id) ?? null,
    };
  });

  const m73Expectation = selectionDetail.filter((s) => s.m73_treatment_resolved === true && s.m73_treatment_valid).length;
  const m73NoRow = selectionDetail.filter((s) => !s.m73_treatment_valid).map((s) => s.instance_id);
  const m73BaselineExpectation = selectionDetail.filter((s) => s.m73_baseline_resolved === true).length;
  const m92Rows = selectionDetail.filter((s) => s.m92_resolved !== null);
  const m92Expectation = m92Rows.filter((s) => s.m92_resolved === true).length;
  const m73HistoricalCost = selectionDetail.reduce((sum, s) => sum + (s.m73_treatment_cost ?? 0), 0);
  const out = {
    milestone: "M108",
    kind: "pre-registered deterministic remaining-50 complement selection (before any live run)",
    date: new Date().toISOString().slice(0, 10),
    method: {
      pool: "stage5_m103_deterministic_scoreboard.detail.json rows with generation_status=scored",
      exclusions:
        "the 14 committed M105 live cases (SMOKE_CASE_IDS) + the 10 committed M106 extension cases (stage5_m106_case_selection.json) + the 26 committed M107 extension cases (stage5_m107_case_selection.json); no other exclusions were needed (all 50 remaining rows are scored with clean indexed workspaces; django__django-10973 has NO valid M73 treatment row — treatment was skipped in M73 stage B — so it carries no historical treatment expectation but is a fully valid live case)",
      selection: "COMPLEMENT — every remaining scored case is selected; no strata, no sampling, no backup list",
      stratum_label: "reporting-only: remaining_<m103_outcome>",
      ordering: "cases with an M92 run-matrix row first, then instance_id ascending (the M106/M107 deterministic tie-break)",
      phases: "selection order: A = 1-8 (pilot), B = 9-22, C = 23-36, D = 37-50",
      no_replacements: "an infrastructure-blocked case is marked invalid and NOT replaced",
    },
    excluded_m105_cases: [...SMOKE_CASE_IDS].sort(),
    excluded_m106_cases: [...m106Ids].sort(),
    excluded_m107_cases: [...m107Ids].sort(),
    selected: selectionDetail,
    rejected: result.rejected,
    m73_treatment_expectation_on_selection: `${m73Expectation}/50 (${m73NoRow.length} case(s) without a valid M73 treatment row: ${m73NoRow.join(", ") || "none"})`,
    m73_baseline_expectation_on_selection: `${m73BaselineExpectation}/50`,
    m92_overlap_expectation_on_selection: `${m92Expectation}/${m92Rows.length}`,
    m73_historical_treatment_cost_on_selection_usd: Number(m73HistoricalCost.toFixed(2)),
    combined_m73_treatment_expectation: `${m73Expectation + 23}/100 (M105 committed 6/14 expectation + M106 selection 4/10 expectation + M107 selection 13/26 expectation + selection ${m73Expectation}/50)`,
    extension_pause_cap_usd: 45,
  };

  const file = path.join(outDir, "stage5_m108_case_selection.json");
  await writeFile(file, `${JSON.stringify(out, null, 2)}\n`);
  process.stderr.write(`[m108-select] wrote ${file}\n`);
  console.log(
    JSON.stringify(
      {
        selected_count: selectionDetail.length,
        phases: { A: 8, B: 14, C: 14, D: 14 },
        m73_expectation: out.m73_treatment_expectation_on_selection,
        m73_baseline_expectation: out.m73_baseline_expectation_on_selection,
        m92_overlap_expectation: out.m92_overlap_expectation_on_selection,
        combined_m73_treatment_expectation: out.combined_m73_treatment_expectation,
        m73_historical_treatment_cost_usd: out.m73_historical_treatment_cost_on_selection_usd,
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  await main();
}
