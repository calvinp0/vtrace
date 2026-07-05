// Stage 5 M106 — pre-registered deterministic case selection for the 24-case
// live-confirmation extension. Selects the 10 additional cases (beyond the 14
// committed M105 live cases) from the frozen 100-case pool using ONLY frozen
// committed inputs, BEFORE any live run:
//
//   pool      stage5_m103_deterministic_scoreboard.detail.json (100 scored rows)
//   history   stage5_m73_final_100_paired.detail.json (per-case treatment arm)
//             stage5_m92_core_reduction50_validation.md (run matrix, 50 cases)
//   cohorts   stage5_m95_dev_holdout_split.json (dev/holdout membership)
//   exclude   the 14 M105 live case ids (SMOKE_CASE_IDS)
//
// Strata + ordering + repo cap live in run_stage5_m106_lib.ts (pure, tested).
// NO agents, NO Docker, NO API spend, NO network.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m106_case_selection.ts \
//     [--out benchmarks/stage5_vexp_swe_bench_smoke/results]

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { SMOKE_CASE_IDS } from "./run_stage5_m104_live_context_smoke";
import { parseM92RunMatrix } from "./run_stage5_m105_collect";
import { M106_STRATA, selectM106Cases, type M106SelectionCandidate } from "./run_stage5_m106_lib";

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

  const exclude = new Set<string>(SMOKE_CASE_IDS);
  const result = selectM106Cases(candidates, exclude);
  const byId = new Map(candidates.map((c) => [c.instance_id, c]));

  const selectionDetail = result.selected.map((s, i) => {
    const c = byId.get(s.instance_id)!;
    const m73 = m73Rows.get(s.instance_id);
    return {
      order: i + 1,
      phase: i < 3 ? "A" : "B",
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
  const out = {
    milestone: "M106",
    kind: "pre-registered deterministic 10-case extension selection (before any live run)",
    date: new Date().toISOString().slice(0, 10),
    method: {
      pool: "stage5_m103_deterministic_scoreboard.detail.json rows with generation_status=scored",
      exclusions: "the 14 M105 live cases (SMOKE_CASE_IDS); no other exclusions were needed (all 86 remaining rows are scored with valid M73 rows and clean indexed workspaces)",
      strata: M106_STRATA.map((s) => ({ name: s.name, want: s.want })),
      ordering: "within each stratum: cases with an M92 run-matrix row first, then instance_id ascending",
      repo_cap: "pass 1 skips a candidate whose repo already has >=2 M106 selections; pass 2 relaxes only if the stratum is short",
      lexical_mismatch_note:
        "the M103 scoreboard has no lexical_mismatch outcome class; the prompt's miss/lexical_mismatch stratum maps to outcome=miss",
      no_replacements: "no backup list; an infrastructure-blocked case is marked invalid and NOT replaced",
    },
    excluded_m105_cases: [...exclude].sort(),
    selected: selectionDetail,
    shortfalls: result.shortfalls,
    m73_treatment_expectation_on_selection: `${m73Expectation}/10`,
    combined_m73_treatment_expectation: `${m73Expectation + 6}/24 (M105 committed 6/14 + selection ${m73Expectation}/10)`,
  };

  const file = path.join(outDir, "stage5_m106_case_selection.json");
  await writeFile(file, `${JSON.stringify(out, null, 2)}\n`);
  process.stderr.write(`[m106-select] wrote ${file}\n`);
  console.log(JSON.stringify({ selected: selectionDetail.map((s) => s.instance_id), shortfalls: result.shortfalls }, null, 2));
}

if (import.meta.main) {
  await main();
}
