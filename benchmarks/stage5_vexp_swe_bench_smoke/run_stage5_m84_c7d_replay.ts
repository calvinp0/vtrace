#!/usr/bin/env bun
// M84 OFFLINE C7_V0 vs C7_D calibration replay.
//
// NO live agents, NO Docker, NO API spend, NO benchmark. It replays the PURE runCostGuard
// detector — built through the NEW first-class calibration constructor
// (costGuardConfigForCalibration) — over the CAPTURED M82 (C7 runtime-active) and M80 (C7
// absent) tool-call streams plus the broad captured-stream corpus, and reports, per
// calibration (v0 | c7d), the M84-brief replay fields: total/early/control/protected-early
// fires, treatment-only-win / baseline-only-loss / low-cost-pass / targeted fires, the five
// named first-fire turns, the fire delta vs v0, and a risk label.
//
// c7d differs from v0 in ONLY editVerifyChurnThreshold (3 -> 2); the 25-tool protective gate
// and every other threshold are unchanged. This script changes NO guard behavior — both
// calibrations are CONFIG objects passed to the existing detector. Streams are read ONLY for
// replay (never staged). Committed outputs are two COMPACT JSON summaries (no raw streams):
//   results/stage5_m84_c7d_replay.json        (full per-calibration / per-cohort replay)
//   results/stage5_m84_c7d_calibration.json   (compact headline summary)
//
// Usage:  bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m84_c7d_replay.ts

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runCostGuard,
  toCostGuardEvent,
  costGuardConfigForCalibration,
  COST_GUARD_CALIBRATION_CHURN_THRESHOLD,
  type CostGuardCalibration,
  type CostGuardConfig,
  type CostGuardEvent,
  type CostGuardRunContext,
} from "./costGuard";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, "results");
const RUNS = path.join(RESULTS, "runs");

const EARLY_TOOL_CUTOFF = 20; // a fire whose snapshot toolCount < this is "early" (pre-progress)
const CALIBRATIONS: readonly CostGuardCalibration[] = ["v0", "c7d"];

// ---------------------------------------------------------------------------
// Case taxonomy (carried forward from the M83 sweep; same labels/streams).
// ---------------------------------------------------------------------------
type GroupKind = "protected" | "control" | "targeted_only" | "neutral";

interface CaseMeta {
  readonly instanceId: string;
  readonly m82Label: string;
  readonly m80Label: string;
  readonly groupKind: GroupKind;
  readonly targeted: boolean;
}

const CASES: readonly CaseMeta[] = [
  { instanceId: "astropy__astropy-14598", m82Label: "m82_v4_c7_guard_astropy__astropy_14598_", m80Label: "m80_tool_loop_guard_v4_astropy__astropy_14598", groupKind: "neutral", targeted: false },
  { instanceId: "django__django-15503", m82Label: "m82_v4_c7_guard_django__django_15503_", m80Label: "m80_tool_loop_guard_v4_django__django_15503", groupKind: "targeted_only", targeted: true },
  { instanceId: "django__django-16263", m82Label: "m82_v4_c7_guard_django__django_16263_", m80Label: "m80_tool_loop_guard_v4_django__django_16263", groupKind: "targeted_only", targeted: true },
  { instanceId: "pytest-dev__pytest-6197", m82Label: "m82_v4_c7_guard_pytest_dev__pytest_6197_", m80Label: "m80_tool_loop_guard_v4_pytest_dev__pytest_6197", groupKind: "control", targeted: false },
  { instanceId: "pylint-dev__pylint-4551", m82Label: "m82_v4_c7_guard_pylint_dev__pylint_4551_", m80Label: "m80_tool_loop_guard_v4_pylint_dev__pylint_4551", groupKind: "neutral", targeted: false },
  { instanceId: "sympy__sympy-12419", m82Label: "m82_v4_c7_guard_sympy__sympy_12419_", m80Label: "m80_tool_loop_guard_v4_sympy__sympy_12419", groupKind: "protected", targeted: true },
  { instanceId: "django__django-11815", m82Label: "m82_v4_c7_guard_django__django_11815_", m80Label: "m80_tool_loop_guard_v4_django__django_11815", groupKind: "protected", targeted: false },
  { instanceId: "django__django-12273", m82Label: "m82_v4_c7_guard_django__django_12273_", m80Label: "m80_tool_loop_guard_v4_django__django_12273", groupKind: "protected", targeted: true },
  { instanceId: "astropy__astropy-7166", m82Label: "m82_v4_c7_guard_astropy__astropy_7166_", m80Label: "m80_tool_loop_guard_v4_astropy__astropy_7166", groupKind: "control", targeted: false },
  { instanceId: "django__django-10880", m82Label: "m82_v4_c7_guard_django__django_10880_", m80Label: "m80_tool_loop_guard_v4_django__django_10880", groupKind: "control", targeted: false },
];

const NAMED_FIRST_FIRE: Record<string, string> = {
  "django-16263": "django__django-16263",
  "django-12273": "django__django-12273",
  "sympy-12419": "sympy__sympy-12419",
  "django-15503": "django__django-15503",
  "pytest-6197": "pytest-dev__pytest-6197",
};

async function readJson(file: string): Promise<unknown | null> {
  return readFile(file, "utf8")
    .then((c) => JSON.parse(c) as unknown)
    .catch(() => null);
}

async function loadStream(runLabel: string): Promise<CostGuardEvent[]> {
  const dir = path.join(RUNS, runLabel, "raw", "vtrace");
  for (const name of ["_tool_calls_with_outputs.json", "_tool_calls.json"]) {
    const parsed = await readJson(path.join(dir, name));
    if (Array.isArray(parsed) && parsed.length > 0) {
      return (parsed as Array<Record<string, unknown>>).map((r, i) => toCostGuardEvent(r, i));
    }
  }
  return [];
}

interface DetailRow {
  cost: number | null;
  turns: number | null;
  resolved: boolean | null;
  m80Resolved: boolean | null;
  m80Cost: number | null;
}

async function loadM82Detail(): Promise<Map<string, DetailRow>> {
  const detail = (await readJson(path.join(RESULTS, "stage5_m82_v4_c7_live_validation.detail.json"))) as
    | { cases?: Array<Record<string, unknown>> }
    | null;
  const map = new Map<string, DetailRow>();
  for (const c of detail?.cases ?? []) {
    map.set(String(c.instance_id), {
      cost: typeof c.cost === "number" ? c.cost : null,
      turns: typeof c.turn_count === "number" ? c.turn_count : null,
      resolved: typeof c.resolved === "boolean" ? c.resolved : null,
      m80Resolved: typeof c.prior_m80_resolved === "boolean" ? c.prior_m80_resolved : null,
      m80Cost: typeof c.prior_m80_cost === "number" ? c.prior_m80_cost : null,
    });
  }
  return map;
}

interface FireProbe {
  fired: boolean;
  firstFire: number | null;
  triggers: string[];
  toolAtFire: number | null;
  early: boolean;
}

function probe(events: CostGuardEvent[], cfg: CostGuardConfig, ctx: CostGuardRunContext): FireProbe {
  const r = runCostGuard(events, cfg, ctx);
  const first = r.events[0] ?? null;
  return {
    fired: r.wouldFire,
    firstFire: r.firstEventTurn,
    triggers: r.events.map((e) => e.triggerType),
    toolAtFire: first ? first.snapshot.toolCount : null,
    early: first ? first.snapshot.toolCount < EARLY_TOOL_CUTOFF : false,
  };
}

// Cohort flags derived from the M82 vs M80 outcomes (decision-relevant replay cohorts).
function cohortFlags(d: DetailRow | undefined): {
  treatmentOnlyWin: boolean;
  baselineOnlyLoss: boolean;
  lowCostPass: boolean;
  highCostFailure: boolean;
} {
  const resolved = d?.resolved ?? null;
  const m80 = d?.m80Resolved ?? null;
  const cost = d?.cost ?? null;
  return {
    treatmentOnlyWin: resolved === true && m80 === false,
    baselineOnlyLoss: resolved === false && m80 === true,
    lowCostPass: resolved === true && cost !== null && cost < 1.0,
    highCostFailure: resolved === false && cost !== null && cost >= 2.0,
  };
}

async function main(): Promise<void> {
  const detail = await loadM82Detail();

  // Pre-load the 10 M82 + 10 M80 streams.
  const m82Streams = new Map<string, CostGuardEvent[]>();
  const m80Streams = new Map<string, CostGuardEvent[]>();
  for (const cm of CASES) {
    m82Streams.set(cm.instanceId, await loadStream(cm.m82Label));
    m80Streams.set(cm.instanceId, await loadStream(cm.m80Label));
  }

  // --- per-calibration replay over the M82 cohort (canonical observe view, with context) ---
  const v0Cfg = costGuardConfigForCalibration("v0", { enabled: true });
  const v0FirstFire = new Map<string, number | null>();
  for (const cm of CASES) {
    const d = detail.get(cm.instanceId);
    v0FirstFire.set(cm.instanceId, probe(m82Streams.get(cm.instanceId)!, v0Cfg, { estimatedCostUsd: d?.cost ?? null, turnCount: d?.turns ?? null }).firstFire);
  }

  const perCalibration: Record<string, Record<string, unknown>> = {};
  const perCaseRows: Array<Record<string, unknown>> = [];

  for (const calibration of CALIBRATIONS) {
    const cfg = costGuardConfigForCalibration(calibration, { enabled: true });
    const probes = new Map<string, { m82: FireProbe; m80: FireProbe }>();
    for (const cm of CASES) {
      const d = detail.get(cm.instanceId);
      probes.set(cm.instanceId, {
        m82: probe(m82Streams.get(cm.instanceId)!, cfg, { estimatedCostUsd: d?.cost ?? null, turnCount: d?.turns ?? null }),
        m80: probe(m80Streams.get(cm.instanceId)!, cfg, { estimatedCostUsd: d?.m80Cost ?? null, turnCount: null }),
      });
    }

    const fired = CASES.filter((c) => probes.get(c.instanceId)!.m82.fired);
    const earlyFires = CASES.filter((c) => probes.get(c.instanceId)!.m82.early);
    const controlFires = CASES.filter((c) => c.groupKind === "control" && probes.get(c.instanceId)!.m82.fired);
    const protectedEarlyFires = CASES.filter((c) => c.groupKind === "protected" && probes.get(c.instanceId)!.m82.early);
    const protectedFires = CASES.filter((c) => c.groupKind === "protected" && probes.get(c.instanceId)!.m82.fired);
    const targetedFires = CASES.filter((c) => c.targeted && probes.get(c.instanceId)!.m82.fired);
    const treatmentOnlyWinFires = CASES.filter((c) => cohortFlags(detail.get(c.instanceId)).treatmentOnlyWin && probes.get(c.instanceId)!.m82.fired);
    const baselineOnlyLossFires = CASES.filter((c) => cohortFlags(detail.get(c.instanceId)).baselineOnlyLoss && probes.get(c.instanceId)!.m82.fired);
    const lowCostPassFires = CASES.filter((c) => cohortFlags(detail.get(c.instanceId)).lowCostPass && probes.get(c.instanceId)!.m82.fired);

    const firstFire: Record<string, number | null> = {};
    for (const [k, id] of Object.entries(NAMED_FIRST_FIRE)) firstFire[k] = probes.get(id)!.m82.firstFire;

    const pytest = probes.get("pytest-dev__pytest-6197")!.m82;
    const sympy = probes.get("sympy__sympy-12419")!.m82;
    const sympyRisk = sympy.early ? "high" : sympy.fired ? "low_late" : "none";

    // Risk: high if any early control/protected fire OR pytest fires; else low (medium is
    // reserved for a protected non-early fire-count increase, which c7d does not introduce).
    let riskLabel: "low" | "medium" | "high" = "low";
    if (protectedEarlyFires.length > 0 || earlyFires.some((c) => c.groupKind === "control") || pytest.early || sympy.early) riskLabel = "high";
    else if (controlFires.length > 0 || pytest.fired) riskLabel = "high";

    perCalibration[calibration] = {
      calibration,
      edit_verify_churn_threshold: COST_GUARD_CALIBRATION_CHURN_THRESHOLD[calibration],
      total_streams: CASES.length,
      total_fires: fired.length,
      early_fires: earlyFires.length,
      control_fires: controlFires.length,
      protected_early_fires: protectedEarlyFires.length,
      protected_fires: protectedFires.length,
      treatment_only_win_fires: treatmentOnlyWinFires.length,
      baseline_only_loss_fires: baselineOnlyLossFires.length,
      low_cost_pass_fires: lowCostPassFires.length,
      targeted_cost_case_fires: targetedFires.length,
      first_fire: firstFire,
      fire_delta_vs_v0: calibration === "v0" ? 0 : fired.length - CASES.filter((c) => v0FirstFire.get(c.instanceId) !== null).length,
      m80_cross_check_fires: CASES.filter((c) => probes.get(c.instanceId)!.m80.fired).length,
      pytest_fired: pytest.fired,
      sympy_risk: sympyRisk,
      risk_label: riskLabel,
    };

    // Per-case detail (both calibrations) for the report table.
    for (const cm of CASES) {
      const d = detail.get(cm.instanceId);
      const p = probes.get(cm.instanceId)!;
      const flags = cohortFlags(d);
      perCaseRows.push({
        calibration,
        instance_id: cm.instanceId,
        group_kind: cm.groupKind,
        targeted: cm.targeted,
        m82_resolved: d?.resolved ?? null,
        m82_cost: d?.cost ?? null,
        m80_resolved: d?.m80Resolved ?? null,
        ...flags,
        m82_stream_len: m82Streams.get(cm.instanceId)!.length,
        m82_first_fire: p.m82.firstFire,
        m82_triggers: p.m82.triggers,
        m82_tool_at_fire: p.m82.toolAtFire,
        m82_early: p.m82.early,
        first_fire_delta_vs_v0: p.m82.firstFire !== null && v0FirstFire.get(cm.instanceId) !== null ? v0FirstFire.get(cm.instanceId)! - p.m82.firstFire : null,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Broad-corpus sweep (stream-only, live-faithful — NO run-context, as the live
  // PostToolUse hook sees). Same corpus the M83 sweep scanned.
  // -------------------------------------------------------------------------
  const broad: Record<string, { fired: number; early: number; churnFires: number; highFires: number }> = {};
  for (const c of CALIBRATIONS) broad[c] = { fired: 0, early: 0, churnFires: 0, highFires: 0 };
  let broadScanned = 0;
  for await (const f of new Bun.Glob(path.join(RUNS, "*", "raw", "vtrace", "_tool_calls.json")).scan()) {
    const parsed = await readJson(f);
    if (!Array.isArray(parsed) || parsed.length === 0) continue;
    broadScanned += 1;
    const ev = (parsed as Array<Record<string, unknown>>).map((r, i) => toCostGuardEvent(r, i));
    for (const calibration of CALIBRATIONS) {
      const r = runCostGuard(ev, costGuardConfigForCalibration(calibration, { enabled: true }), {});
      if (r.wouldFire) {
        broad[calibration]!.fired += 1;
        if (r.events[0]!.snapshot.toolCount < EARLY_TOOL_CUTOFF) broad[calibration]!.early += 1;
        const t = r.events.map((e) => e.triggerType);
        if (t.includes("edit_verify_churn")) broad[calibration]!.churnFires += 1;
        if (t.includes("high_tool_count")) broad[calibration]!.highFires += 1;
      }
    }
  }
  const broadCorpus = {
    streams_scanned: broadScanned,
    matches_m83_count: broadScanned === 563,
    note: "Positional triggers only (no run-context). Same _tool_calls.json corpus M83 scanned (563).",
    by_calibration: Object.fromEntries(
      CALIBRATIONS.map((c) => [
        c,
        { ...broad[c]!, fire_rate_pct: broadScanned ? Number(((broad[c]!.fired / broadScanned) * 100).toFixed(2)) : 0 },
      ]),
    ),
    fire_delta_c7d_vs_v0: broad.c7d!.fired - broad.v0!.fired,
  };

  // -------------------------------------------------------------------------
  // M74 cohort coverage (cap-hit / thrashing). The M74 self-harness cases were captured
  // only as eval logs (NO full tool-call streams), exactly as M73 in the M83 sweep, so they
  // contribute outcome-cohort COUNTS here, not replayable streams.
  // -------------------------------------------------------------------------
  const m74 = (await readJson(path.join(RESULTS, "stage5_m74_self_harness_lite_audit.json"))) as Record<string, unknown> | null;
  const m74CapHit = (m74?.cost_cap_exhaustion as { count?: number } | undefined)?.count ?? null;
  const m74Counts = (m74?.primary_category_counts as Record<string, number> | undefined) ?? null;
  const m74Coverage = {
    streams_available: false,
    note: "M74 self-harness cases have eval logs only (no captured tool-call streams); contributes outcome-cohort counts, not replay streams.",
    cap_hit_count: m74CapHit,
    primary_category_counts: m74Counts,
  };

  const out = {
    milestone: "M84",
    kind: "C7_V0 vs C7_D calibration replay (offline; no agents, no Docker, no spend, no benchmark)",
    live_agents: false,
    docker: false,
    benchmark: false,
    retrieval_changed: false,
    guard_default_off: true,
    note: "Both calibrations built via costGuardConfigForCalibration and passed to the existing pure runCostGuard. c7d changes ONLY editVerifyChurnThreshold (3->2); the 25-tool gate is unchanged. Streams read for replay only; never staged.",
    early_tool_cutoff: EARLY_TOOL_CUTOFF,
    churn_threshold_by_calibration: COST_GUARD_CALIBRATION_CHURN_THRESHOLD,
    m82_cohort: perCalibration,
    m82_per_case: perCaseRows,
    broad_corpus_sweep: broadCorpus,
    m74_cohort_coverage: m74Coverage,
  };

  const replayPath = path.join(RESULTS, "stage5_m84_c7d_replay.json");
  await writeFile(replayPath, `${JSON.stringify(out, null, 2)}\n`);

  // Compact headline summary (the second committed JSON).
  const summary = {
    milestone: "M84",
    kind: "C7_D cost-guard calibration — implementation + offline validation",
    implemented: true,
    default_off: true,
    default_enabled_calibration: "c7d",
    cli_flag: "--cost-guard-calibration v0|c7d",
    metadata_field: "cost_guard_calibration",
    threshold_changed: { field: "editVerifyChurnThreshold", v0: 3, c7d: 2 },
    protective_gate_intact: { minToolCallsBeforeFire: 25 },
    headline: {
      first_fire_by_calibration: { v0: perCalibration.v0!.first_fire, c7d: perCalibration.c7d!.first_fire },
      django16263_earlier_under_c7d: ((perCalibration.v0!.first_fire as Record<string, number | null>)["django-16263"] ?? 0)! - ((perCalibration.c7d!.first_fire as Record<string, number | null>)["django-16263"] ?? 0)!,
      pytest_silent_both: perCalibration.v0!.pytest_fired === false && perCalibration.c7d!.pytest_fired === false,
      early_fires_both_zero: perCalibration.v0!.early_fires === 0 && perCalibration.c7d!.early_fires === 0,
      control_fires_both_zero: perCalibration.v0!.control_fires === 0 && perCalibration.c7d!.control_fires === 0,
      protected_early_fires_both_zero: perCalibration.v0!.protected_early_fires === 0 && perCalibration.c7d!.protected_early_fires === 0,
      sympy_risk: { v0: perCalibration.v0!.sympy_risk, c7d: perCalibration.c7d!.sympy_risk },
      broad_corpus_fire_delta: broadCorpus.fire_delta_c7d_vs_v0,
      broad_corpus_streams: broadCorpus.streams_scanned,
      risk_label: { v0: perCalibration.v0!.risk_label, c7d: perCalibration.c7d!.risk_label },
    },
    recommendation: "proceed to small live validation with V4 + C7_D (default-off; calibration recorded in metadata)",
  };
  const summaryPath = path.join(RESULTS, "stage5_m84_c7d_calibration.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  // eslint-disable-next-line no-console
  console.log(`wrote ${path.relative(HERE, replayPath)} and ${path.relative(HERE, summaryPath)}`);
  for (const c of CALIBRATIONS) {
    const p = perCalibration[c]!;
    // eslint-disable-next-line no-console
    console.log(
      `${c.padEnd(4)} churn>=${COST_GUARD_CALIBRATION_CHURN_THRESHOLD[c]} fires=${p.total_fires} early=${p.early_fires} ctrl=${p.control_fires} protEarly=${p.protected_early_fires} tgt=${p.targeted_cost_case_fires} 16263@${JSON.stringify((p.first_fire as Record<string, number | null>)["django-16263"])} pytest=${p.pytest_fired} sympy=${p.sympy_risk} risk=${p.risk_label}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`broad: scanned=${broadCorpus.streams_scanned} v0=${broad.v0!.fired} c7d=${broad.c7d!.fired} delta=${broadCorpus.fire_delta_c7d_vs_v0}`);
}

void main();
