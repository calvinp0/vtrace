// Stage 5 M107 — pre-registered deterministic case selection for the 50-case
// live-confirmation extension. Selects the 26 additional cases (beyond the 14
// committed M105 and 10 committed M106 live cases) from the frozen 100-case
// pool using ONLY frozen committed inputs, BEFORE any live run:
//
//   pool      stage5_m103_deterministic_scoreboard.detail.json (100 scored rows)
//   history   stage5_m73_final_100_paired.detail.json (per-case treatment arm)
//             stage5_m92_core_reduction50_validation.md (run matrix, 50 cases)
//   cohorts   stage5_m95_dev_holdout_split.json (dev/holdout membership)
//   exclude   the 14 M105 live case ids (SMOKE_CASE_IDS) + the 10 M106
//             extension ids (stage5_m106_case_selection.json)
//
// Strata + substitution + repo cap live in run_stage5_m107_lib.ts (pure,
// tested). NO agents, NO Docker, NO API spend, NO network.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m107_case_selection.ts \
//     [--out benchmarks/stage5_vexp_swe_bench_smoke/results]

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { SMOKE_CASE_IDS } from "./run_stage5_m104_live_context_smoke";
import { parseM92RunMatrix } from "./run_stage5_m105_collect";
import { type M106SelectionCandidate } from "./run_stage5_m106_lib";
import { M107_REPO_CAP, M107_STRATA, m107Phase, selectM107Cases } from "./run_stage5_m107_lib";

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
    excluded_m105_cases: string[];
  };
  const m106Ids = m106Selection.selected.map((s) => s.instance_id);

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

  const exclude = new Set<string>([...SMOKE_CASE_IDS, ...m106Ids]);
  if (exclude.size !== SMOKE_CASE_IDS.length + m106Ids.length)
    throw new Error("M105/M106 committed case sets overlap — reuse contract violated upstream");
  const result = selectM107Cases(candidates, exclude);
  const byId = new Map(candidates.map((c) => [c.instance_id, c]));

  const selectionDetail = result.selected.map((s, i) => {
    const c = byId.get(s.instance_id)!;
    const m73 = m73Rows.get(s.instance_id);
    return {
      order: i + 1,
      phase: m107Phase(i),
      instance_id: s.instance_id,
      selection_stratum: s.stratum,
      repo: c.repo,
      m103_outcome: c.m103_outcome,
      multi_file: c.multi_file,
      in_holdout: c.in_holdout,
      m73_treatment_resolved: c.m73_treatment_resolved,
      m73_baseline_resolved: typeof m73?.baseline_resolved === "boolean" ? m73.baseline_resolved : null,
      m73_treatment_cost: m73?.treatment_cost ?? null,
      m92_resolved: m92Resolved.get(s.instance_id) ?? null,
    };
  });

  const m73Expectation = selectionDetail.filter((s) => s.m73_treatment_resolved === true).length;
  const m92Rows = selectionDetail.filter((s) => s.m92_resolved !== null);
  const m92Expectation = m92Rows.filter((s) => s.m92_resolved === true).length;
  const out = {
    milestone: "M107",
    kind: "pre-registered deterministic 26-case extension selection (before any live run)",
    date: new Date().toISOString().slice(0, 10),
    method: {
      pool: "stage5_m103_deterministic_scoreboard.detail.json rows with generation_status=scored",
      exclusions:
        "the 14 committed M105 live cases (SMOKE_CASE_IDS) + the 10 committed M106 extension cases (stage5_m106_case_selection.json); no other exclusions were needed (all 76 remaining rows are scored with valid M73 rows and clean indexed workspaces)",
      strata: M107_STRATA.map((s) => ({ name: s.name, want: s.want })),
      substitution:
        "the remaining pool holds only 1 outcome=partial case, so the partial deficit fills deterministically from outcome=overpacked (the only M103 failure class the strata do not otherwise cover), stratum-tagged partial_sub_overpacked",
      ordering: "within each stratum: cases with an M92 run-matrix row first, then instance_id ascending",
      repo_cap: `pass 1 skips a candidate whose repo already has >=${M107_REPO_CAP} M107 selections; pass 2 relaxes only if the stratum is short`,
      phases: "selection order: A = 1-5 (pilot), B = 6-15, C = 16-26",
      no_replacements: "no backup list; an infrastructure-blocked case is marked invalid and NOT replaced",
    },
    excluded_m105_cases: [...SMOKE_CASE_IDS].sort(),
    excluded_m106_cases: [...m106Ids].sort(),
    selected: selectionDetail,
    substitutions: result.substitutions,
    shortfalls: result.shortfalls,
    m73_treatment_expectation_on_selection: `${m73Expectation}/26`,
    m92_overlap_expectation_on_selection: `${m92Expectation}/${m92Rows.length}`,
    combined_m73_treatment_expectation: `${m73Expectation + 10}/50 (M105 committed 6/14 expectation + M106 selection 4/10 expectation + selection ${m73Expectation}/26)`,
  };

  const file = path.join(outDir, "stage5_m107_case_selection.json");
  await writeFile(file, `${JSON.stringify(out, null, 2)}\n`);
  process.stderr.write(`[m107-select] wrote ${file}\n`);
  console.log(
    JSON.stringify(
      {
        selected: selectionDetail.map((s) => ({ id: s.instance_id, stratum: s.selection_stratum, phase: s.phase })),
        substitutions: result.substitutions,
        shortfalls: result.shortfalls,
        m73_expectation: out.m73_treatment_expectation_on_selection,
        m92_overlap_expectation: out.m92_overlap_expectation_on_selection,
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  await main();
}
