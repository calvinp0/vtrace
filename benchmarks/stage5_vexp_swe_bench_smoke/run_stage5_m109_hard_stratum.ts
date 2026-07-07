// Stage 5 M109 — hard-stratum flip analysis vs the M73 treatment arm.
// Classifies EVERY M106 and M107 live case (the deliberately failure-
// enriched extensions) plus the M109-brief's named M105/M108 cases, using
// ONLY committed artifacts: the milestone live-run detail JSONs, the frozen
// M103 scoreboard detail (gold/capsule fields), and the M73 paired detail
// (strict treatment_valid comparability). NO agents, NO Docker, NO API
// spend, NO network.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m109_hard_stratum.ts \
//     [--out benchmarks/stage5_vexp_swe_bench_smoke/results]

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { classifyFlip, classifyLikelyReason, type HardStratumInput } from "./run_stage5_m109_lib";

const RESULTS_ROOT = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "results");

// M105/M108 cases the M109 brief names for discussion beside the full
// M106/M107 sets.
const NAMED_EXTRA_CASES: ReadonlyArray<{ id: string; milestone: "m105" | "m108" }> = [
  { id: "astropy__astropy-14539", milestone: "m108" },
  { id: "django__django-10973", milestone: "m108" },
  { id: "django__django-11490", milestone: "m108" },
  { id: "django__django-13551", milestone: "m108" },
  { id: "sympy__sympy-16766", milestone: "m108" },
  { id: "sympy__sympy-23413", milestone: "m108" },
];

interface LiveCase {
  readonly instance_id: string;
  readonly selection_stratum?: string;
  readonly live_status: "valid" | "invalid" | "not_attempted";
  readonly resolved: boolean | null;
  readonly historical: {
    readonly m73_treatment_resolved: boolean | null;
    readonly m92_resolved: boolean | null;
    readonly m103_outcome: string | null;
  };
  readonly metrics: {
    readonly cost_usd: number;
    readonly total_tokens: number;
    readonly tool_calls: number | null;
    readonly changed_files: string[];
  } | null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const outDir = outIdx >= 0 && argv[outIdx + 1] !== undefined ? argv[outIdx + 1]! : RESULTS_ROOT;

  const readCases = (file: string): LiveCase[] =>
    (JSON.parse(readFileSync(path.join(RESULTS_ROOT, file), "utf8")) as { cases: LiveCase[] }).cases;
  const m106 = readCases("stage5_m106_live_runs.detail.json");
  const m107 = readCases("stage5_m107_live_runs.detail.json");
  const m108 = readCases("stage5_m108_live_runs.detail.json");

  const m103Rows = new Map(
    (
      JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m103_deterministic_scoreboard.detail.json"), "utf8")) as {
        rows: Array<{
          instance_id: string;
          outcome: string | null;
          capsule: { mode?: string } | null;
          gold: { multi_file?: boolean } | null;
          file_metrics: {
            any_gold_in_capsule?: boolean;
            all_gold_in_capsule?: boolean;
            lead_pivot_is_source_gold?: boolean;
          } | null;
        }>;
      }
    ).rows.map((r) => [r.instance_id, r] as const),
  );
  const m73Rows = new Map(
    (
      JSON.parse(readFileSync(path.join(RESULTS_ROOT, "stage5_m73_final_100_paired.detail.json"), "utf8")) as Array<{
        instance_id: string;
        treatment_valid?: boolean;
        treatment_resolved?: boolean;
      }>
    ).map((r) => [r.instance_id, r] as const),
  );

  const classify = (c: LiveCase, milestone: string) => {
    const m103 = m103Rows.get(c.instance_id);
    const m73 = m73Rows.get(c.instance_id);
    const input: HardStratumInput = {
      live_status: c.live_status,
      live_resolved: c.resolved,
      m73_treatment_valid: m73?.treatment_valid === true,
      m73_treatment_resolved: typeof m73?.treatment_resolved === "boolean" ? m73.treatment_resolved : null,
      m103_outcome: m103?.outcome ?? null,
      m103_capsule_mode: m103?.capsule?.mode ?? null,
      gold_multi_file: m103?.gold?.multi_file === true,
      m103_all_gold: m103?.file_metrics?.all_gold_in_capsule ?? null,
      changed_files_count: c.metrics === null ? null : c.metrics.changed_files.length,
      cost_usd: c.metrics?.cost_usd ?? null,
      tool_calls: c.metrics?.tool_calls ?? null,
    };
    const flip = classifyFlip(input);
    return {
      instance_id: c.instance_id,
      milestone,
      selection_stratum: c.selection_stratum ?? null,
      M103_deterministic_outcome: input.m103_outcome,
      M103_lead_source_gold: m103?.file_metrics?.lead_pivot_is_source_gold ?? null,
      M103_any_gold: m103?.file_metrics?.any_gold_in_capsule ?? null,
      M103_all_gold: m103?.file_metrics?.all_gold_in_capsule ?? null,
      M73_treatment_resolved: input.m73_treatment_valid ? input.m73_treatment_resolved : null,
      current_live_resolved: c.resolved,
      M92_resolved_if_available: c.historical.m92_resolved,
      agreement_with_M73: flip === "agreement",
      flip_type: flip,
      likely_reason: classifyLikelyReason(input),
      cost: c.metrics?.cost_usd ?? null,
      tokens: c.metrics?.total_tokens ?? null,
      tool_calls: c.metrics?.tool_calls ?? null,
      changed_files_count: input.changed_files_count,
      gold_multi_file: input.gold_multi_file,
      notes: "",
    };
  };

  const rows = [
    ...m106.map((c) => classify(c, "m106")),
    ...m107.map((c) => classify(c, "m107")),
    ...NAMED_EXTRA_CASES.map(({ id, milestone }) => {
      const c = m108.find((x) => x.instance_id === id);
      if (c === undefined) throw new Error(`named case missing from ${milestone} detail: ${id}`);
      return classify(c, milestone);
    }),
  ];

  const m106m107 = rows.filter((r) => r.milestone === "m106" || r.milestone === "m107");
  const byFlip = (rs: typeof rows, t: string) => rs.filter((r) => r.flip_type === t).map((r) => r.instance_id);
  const byReason = (rs: typeof rows) => {
    const acc: Record<string, string[]> = {};
    for (const r of rs) {
      if (r.likely_reason === null) continue;
      (acc[r.likely_reason] ??= []).push(r.instance_id);
    }
    return acc;
  };

  const out = {
    milestone: "M109",
    kind: "hard-stratum flip analysis vs M73 treatment (strict treatment_valid comparability) over every M106/M107 case + named M105/M108 cases; captured artifacts only",
    date: new Date().toISOString().slice(0, 10),
    method: {
      comparability: "flip types computed ONLY where the M73 treatment row is valid; treatment_valid=false rows (astropy-14598, django-10973, django-13513, django-15503) classify no_M73_row",
      likely_reason_heuristic:
        "order: no_context (never spawned, frozen M103 no-context) > infrastructure_invalid > single_file_patch_on_multifile_gold (multi-file gold, 1-file live patch) > high_cost_tool_loop (cost>=$1.50 or tool_calls>=25) > deterministic_context_gap (M103 miss/wrong_pivot/partial) > agent_variance (M103 excellent/good/overpacked with gold present) > unknown; resolved cases carry null",
    },
    summary: {
      m106_m107_cases: m106m107.length,
      m106_m107_agreement: m106m107.filter((r) => r.agreement_with_M73).length,
      m106_m107_losses: byFlip(m106m107, "live_loss_vs_M73"),
      m106_m107_wins: byFlip(m106m107, "live_win_vs_M73"),
      m106_m107_no_row: byFlip(m106m107, "no_M73_row"),
      m106_m107_unresolved_reasons: byReason(m106m107.filter((r) => r.current_live_resolved === false)),
      named_extra_cases: NAMED_EXTRA_CASES.map((n) => n.id),
    },
    cases: rows,
  };

  const file = path.join(outDir, "stage5_m109_hard_stratum_analysis.json");
  await writeFile(file, `${JSON.stringify(out, null, 2)}\n`);
  process.stderr.write(`[m109-hard-stratum] wrote ${file}\n`);
  console.log(JSON.stringify(out.summary, null, 2));
}

if (import.meta.main) {
  await main();
}
