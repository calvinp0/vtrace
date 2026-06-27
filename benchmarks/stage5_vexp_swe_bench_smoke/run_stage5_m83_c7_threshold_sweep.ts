#!/usr/bin/env bun
// M83 OFFLINE C7 threshold-timing calibration sweep.
//
// NO live agents, NO Docker, NO API spend, NO benchmark. It replays the PURE
// `runCostGuard` detector over the CAPTURED M82 (primary; C7 was runtime-active) and
// M80 (cross-check; C7 absent) tool-call streams under a panel of candidate threshold
// VARIANTS, and reports, per variant, where C7 would FIRST fire on each case plus the
// early/protected/control safety metrics. It changes NO C7 behavior — every variant is a
// CONFIG object passed to the existing detector; costGuard.ts is untouched.
//
// Streams are read ONLY for replay (never staged). The committed output is one COMPACT
// JSON summary (no raw stream content):
//   results/stage5_m83_c7_threshold_sweep.json
//
// Usage:  bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m83_c7_threshold_sweep.ts

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runCostGuard,
  toCostGuardEvent,
  DEFAULT_COST_GUARD_CONFIG,
  type CostGuardConfig,
  type CostGuardEvent,
  type CostGuardRunContext,
} from "./costGuard";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, "results");
const RUNS = path.join(RESULTS, "runs");

// ---------------------------------------------------------------------------
// Cohort taxonomy (decision-relevant label per case, from the M82 split metadata).
//   protected  = a treatment win we must not harm (django-11815, django-12273, sympy-12419)
//   control    = normal resolved low-cost control that should stay silent
//   targeted   = high-cost / no-convergence vector C7 is meant to catch
// A case can be both targeted and protected (django-12273); `groupKind` is the decision-
// relevant guard-safety class, `targeted` is an independent flag.
// ---------------------------------------------------------------------------
type GroupKind = "protected" | "control" | "targeted_only" | "neutral";

interface CaseMeta {
  readonly instanceId: string;
  readonly m82Label: string;
  readonly m80Label: string;
  readonly groupKind: GroupKind;
  readonly targeted: boolean; // a designated cost / no-convergence target
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

// ---------------------------------------------------------------------------
// Variant panel (M83 brief). Each entry is an OVERRIDE over DEFAULT_COST_GUARD_CONFIG.
// ---------------------------------------------------------------------------
interface Variant {
  readonly id: string;
  readonly label: string;
  readonly override: Partial<CostGuardConfig>;
}

const VARIANTS: readonly Variant[] = [
  { id: "C7_V0", label: "current default", override: {} },
  { id: "C7_A", label: "highToolCount 30", override: { highToolCountThreshold: 30 } },
  { id: "C7_B", label: "highToolCount 28", override: { highToolCountThreshold: 28 } },
  { id: "C7_C", label: "minTool 20 + highToolCount 30", override: { minToolCallsBeforeFire: 20, highToolCountThreshold: 30 } },
  { id: "C7_D", label: "editVerifyChurn 2", override: { editVerifyChurnThreshold: 2 } },
  { id: "C7_E", label: "minTool 20 + highToolCount 30 + churn 2", override: { minToolCallsBeforeFire: 20, highToolCountThreshold: 30, editVerifyChurnThreshold: 2 } },
  { id: "C7_F", label: "costCap 0.70", override: { costCapFraction: 0.7 } },
  { id: "C7_G", label: "density proxy churn 2 + highToolCount 28", override: { highToolCountThreshold: 28, editVerifyChurnThreshold: 2 } },
  { id: "C7_H", label: "protected conservative highToolCount 30", override: { highToolCountThreshold: 30, editVerifyChurnThreshold: 3, minToolCallsBeforeFire: 25 } },
];

const EARLY_TOOL_CUTOFF = 20; // a fire whose snapshot toolCount < this is "early" (pre-progress)

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
  m73Resolved: boolean | null;
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
      m73Resolved: typeof c.prior_m73_treatment_resolved === "boolean" ? c.prior_m73_treatment_resolved : null,
    });
  }
  return map;
}

interface FireProbe {
  fired: boolean;
  firstFire: number | null;
  fireCount: number;
  triggers: string[];
  toolAtFire: number | null;
  editAtFire: number | null;
  verifyAtFire: number | null;
  patchSeenAtFire: boolean | null;
  early: boolean; // snapshot toolCount < EARLY_TOOL_CUTOFF
}

function probe(events: CostGuardEvent[], cfg: CostGuardConfig, ctx: CostGuardRunContext): FireProbe {
  const r = runCostGuard(events, cfg, ctx);
  const first = r.events[0] ?? null;
  return {
    fired: r.wouldFire,
    firstFire: r.firstEventTurn,
    fireCount: r.events.length,
    triggers: r.events.map((e) => e.triggerType),
    toolAtFire: first ? first.snapshot.toolCount : null,
    editAtFire: first ? first.snapshot.editCount : null,
    verifyAtFire: first ? first.snapshot.verifyCount : null,
    patchSeenAtFire: first ? first.snapshot.patchSeen : null,
    early: first ? first.snapshot.toolCount < EARLY_TOOL_CUTOFF : false,
  };
}

async function main(): Promise<void> {
  const detail = await loadM82Detail();

  // Per-stream-source results: M82 (primary; with run-context) and M80 (cross-check).
  // The live runtime hook has NO run-context, so we ALSO compute a stream-only probe on
  // M82 to isolate the live-faithful positional fires (high_tool / churn / no_patch).
  const perCase: Array<Record<string, unknown>> = [];
  const variantAgg: Array<Record<string, unknown>> = [];

  // Pre-load streams + contexts.
  const m82Streams = new Map<string, CostGuardEvent[]>();
  const m80Streams = new Map<string, CostGuardEvent[]>();
  for (const cm of CASES) {
    m82Streams.set(cm.instanceId, await loadStream(cm.m82Label));
    m80Streams.set(cm.instanceId, await loadStream(cm.m80Label));
  }

  const v0 = { ...DEFAULT_COST_GUARD_CONFIG, enabled: true };

  // First-fire turn under V0 on the M82 stream (with context), for delta computation.
  const v0FirstFire = new Map<string, number | null>();
  for (const cm of CASES) {
    const ctx: CostGuardRunContext = { estimatedCostUsd: detail.get(cm.instanceId)?.cost ?? null, turnCount: detail.get(cm.instanceId)?.turns ?? null };
    v0FirstFire.set(cm.instanceId, probe(m82Streams.get(cm.instanceId)!, v0, ctx).firstFire);
  }

  for (const v of VARIANTS) {
    const cfg: CostGuardConfig = { ...DEFAULT_COST_GUARD_CONFIG, ...v.override, enabled: true };
    const caseProbes: Record<string, { m82ctx: FireProbe; m82stream: FireProbe; m80ctx: FireProbe }> = {};

    for (const cm of CASES) {
      const d = detail.get(cm.instanceId);
      const ctx: CostGuardRunContext = { estimatedCostUsd: d?.cost ?? null, turnCount: d?.turns ?? null };
      const m80ctxObj: CostGuardRunContext = { estimatedCostUsd: d?.m80Cost ?? null, turnCount: null };
      caseProbes[cm.instanceId] = {
        m82ctx: probe(m82Streams.get(cm.instanceId)!, cfg, ctx),
        m82stream: probe(m82Streams.get(cm.instanceId)!, cfg, {}), // live-faithful (no run-context)
        m80ctx: probe(m80Streams.get(cm.instanceId)!, cfg, m80ctxObj),
      };
    }

    // Aggregate over the M82 stream WITH run-context (the canonical offline observe view).
    const fired = CASES.filter((c) => caseProbes[c.instanceId]!.m82ctx.fired);
    const earlyFires = CASES.filter((c) => caseProbes[c.instanceId]!.m82ctx.early);
    const protectedFires = CASES.filter((c) => c.groupKind === "protected" && caseProbes[c.instanceId]!.m82ctx.fired);
    const protectedEarlyFires = CASES.filter((c) => c.groupKind === "protected" && caseProbes[c.instanceId]!.m82ctx.early);
    const controlFires = CASES.filter((c) => c.groupKind === "control" && caseProbes[c.instanceId]!.m82ctx.fired);
    const controlEarlyFires = CASES.filter((c) => c.groupKind === "control" && caseProbes[c.instanceId]!.m82ctx.early);
    const targetedFires = CASES.filter((c) => c.targeted && caseProbes[c.instanceId]!.m82ctx.fired);

    // Targeted earlier-fire: a targeted case whose first fire moved >= 5 tools earlier vs V0.
    const targetedEarlierByCase: Record<string, number | null> = {};
    let targetedEarlierCount = 0;
    for (const c of CASES.filter((x) => x.targeted)) {
      const cur = caseProbes[c.instanceId]!.m82ctx.firstFire;
      const base = v0FirstFire.get(c.instanceId) ?? null;
      const delta = cur !== null && base !== null ? base - cur : null;
      targetedEarlierByCase[c.instanceId] = delta;
      if (delta !== null && delta >= 5) targetedEarlierCount += 1;
    }

    const ff = (id: string): number | null => caseProbes[id]!.m82ctx.firstFire;
    // pytest risk: any fire on pytest-6197 (control, short path) → false positive risk.
    const pytestFired = caseProbes["pytest-dev__pytest-6197"]!.m82ctx.fired;
    const pytestEarly = caseProbes["pytest-dev__pytest-6197"]!.m82ctx.early;
    // sympy risk: an EARLY fire (toolCount<20) on the resolving sympy path = disruption risk.
    const sympyProbe = caseProbes["sympy__sympy-12419"]!.m82ctx;
    const sympyRisk = sympyProbe.early ? "high" : sympyProbe.fired ? "low_late" : "none";

    // Risk label: high if any control/protected EARLY fire OR pytest fires; medium if
    // protected (non-early) fire count increases vs V0 design; else low.
    let riskLabel: "low" | "medium" | "high" = "low";
    if (controlEarlyFires.length > 0 || protectedEarlyFires.length > 0 || pytestEarly || sympyProbe.early) riskLabel = "high";
    else if (controlFires.length > 0 || pytestFired) riskLabel = "high";
    else if (protectedFires.length > CASES.filter((c) => c.groupKind === "protected" && caseProbes[c.instanceId]!.m82ctx.fired && caseProbes[c.instanceId]!.m82ctx.firstFire !== null).length - protectedFires.length + protectedFires.length) riskLabel = "medium";

    variantAgg.push({
      variant_id: v.id,
      label: v.label,
      config: { ...v.override },
      fire_count_total: fired.length,
      fire_count_stream_only: CASES.filter((c) => caseProbes[c.instanceId]!.m82stream.fired).length,
      early_fire_count: earlyFires.length,
      targeted_cost_case_fire_count: targetedFires.length,
      targeted_earlier_fire_count: targetedEarlierCount,
      targeted_first_fire_delta_vs_current: targetedEarlierByCase,
      protected_win_fire_count: protectedFires.length,
      protected_win_early_fire_count: protectedEarlyFires.length,
      normal_control_fire_count: controlFires.length,
      normal_control_early_fire_count: controlEarlyFires.length,
      first_fire: {
        "django-16263": ff("django__django-16263"),
        "django-12273": ff("django__django-12273"),
        "sympy-12419": ff("sympy__sympy-12419"),
        "django-15503": ff("django__django-15503"),
        "pytest-6197": ff("pytest-dev__pytest-6197"),
      },
      pytest_fired: pytestFired,
      pytest_early: pytestEarly,
      sympy_risk: sympyRisk,
      risk_label: riskLabel,
    });

    // Detailed per-case rows only for V0 (the timing reconstruction baseline).
    if (v.id === "C7_V0") {
      for (const cm of CASES) {
        const d = detail.get(cm.instanceId);
        const p = caseProbes[cm.instanceId]!;
        perCase.push({
          instance_id: cm.instanceId,
          group_kind: cm.groupKind,
          targeted: cm.targeted,
          m73_resolved: d?.m73Resolved ?? null,
          m80_resolved: d?.m80Resolved ?? null,
          m80_cost: d?.m80Cost ?? null,
          m82_resolved: d?.resolved ?? null,
          m82_cost: d?.cost ?? null,
          m82_turns: d?.turns ?? null,
          m82_stream_len: m82Streams.get(cm.instanceId)!.length,
          m80_stream_len: m80Streams.get(cm.instanceId)!.length,
          v0_m82_first_fire: p.m82ctx.firstFire,
          v0_m82_triggers: p.m82ctx.triggers,
          v0_m82_tool_at_fire: p.m82ctx.toolAtFire,
          v0_m82_edit_at_fire: p.m82ctx.editAtFire,
          v0_m82_verify_at_fire: p.m82ctx.verifyAtFire,
          v0_m82_patch_seen_at_fire: p.m82ctx.patchSeenAtFire,
          v0_m80_first_fire: p.m80ctx.firstFire,
          v0_m80_triggers: p.m80ctx.triggers,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Broad-corpus false-positive sweep: replay the positional (live-faithful,
  // NO run-context) triggers over EVERY captured non-empty stream in runs/. Tests
  // whether lowering thresholds inflates fires / introduces early fires AT SCALE.
  // -------------------------------------------------------------------------
  const broadVariants: Record<string, Partial<CostGuardConfig>> = {
    V0: {},
    high_tool_30: { highToolCountThreshold: 30 },
    high_tool_28: { highToolCountThreshold: 28 },
    churn_2: { editVerifyChurnThreshold: 2 },
    min20_high30_churn2: { minToolCallsBeforeFire: 20, highToolCountThreshold: 30, editVerifyChurnThreshold: 2 },
  };
  const broadAgg: Record<string, { fired: number; early: number; churnFires: number; highFires: number }> = {};
  for (const k of Object.keys(broadVariants)) broadAgg[k] = { fired: 0, early: 0, churnFires: 0, highFires: 0 };
  let broadScanned = 0;
  for await (const f of new Bun.Glob(path.join(RUNS, "*", "raw", "vtrace", "_tool_calls.json")).scan()) {
    const parsed = await readJson(f);
    if (!Array.isArray(parsed) || parsed.length === 0) continue;
    broadScanned += 1;
    const ev = (parsed as Array<Record<string, unknown>>).map((r, i) => toCostGuardEvent(r, i));
    for (const [k, ov] of Object.entries(broadVariants)) {
      const r = runCostGuard(ev, { ...DEFAULT_COST_GUARD_CONFIG, ...ov, enabled: true }, {});
      if (r.wouldFire) {
        broadAgg[k]!.fired += 1;
        if ((r.events[0]!.snapshot.toolCount) < EARLY_TOOL_CUTOFF) broadAgg[k]!.early += 1;
        const t = r.events.map((e) => e.triggerType);
        if (t.includes("edit_verify_churn")) broadAgg[k]!.churnFires += 1;
        if (t.includes("high_tool_count")) broadAgg[k]!.highFires += 1;
      }
    }
  }
  const broadCorpus = {
    streams_scanned: broadScanned,
    stream_only_live_faithful: true,
    note: "Positional triggers only (no run-context, as the live PostToolUse hook sees). Streams span all milestones; clean baselines for would-C7-fire.",
    by_variant: Object.fromEntries(
      Object.entries(broadAgg).map(([k, a]) => [
        k,
        { ...a, fire_rate_pct: broadScanned ? Number(((a.fired / broadScanned) * 100).toFixed(2)) : 0 },
      ]),
    ),
  };

  const out = {
    milestone: "M83",
    kind: "C7 threshold-timing calibration sweep (offline; no agents, no Docker, no spend, no benchmark)",
    live_agents: false,
    docker: false,
    benchmark: false,
    retrieval_changed: false,
    c7_behavior_changed: false,
    note: "Every variant is a CONFIG passed to the existing pure runCostGuard; costGuard.ts is untouched. Streams read for replay only; never staged.",
    early_tool_cutoff: EARLY_TOOL_CUTOFF,
    stream_sources: {
      m82: "runtime C7-active streams (prefix up to the live @34 injection is unperturbed; earlier fires are valid)",
      m80: "C7-absent cross-check streams",
      m73: "NOT AVAILABLE as full tool-call streams (only eval logs captured); outcomes used from split metadata",
    },
    default_config: { ...DEFAULT_COST_GUARD_CONFIG, enabled: true },
    variants: variantAgg,
    broad_corpus_sweep: broadCorpus,
    v0_timing_reconstruction: perCase,
  };
  const outPath = path.join(RESULTS, "stage5_m83_c7_threshold_sweep.json");
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);

  // eslint-disable-next-line no-console
  console.log(`wrote ${path.relative(HERE, outPath)}`);
  for (const v of variantAgg) {
    // eslint-disable-next-line no-console
    console.log(
      `${String(v.variant_id).padEnd(7)} fires=${v.fire_count_total} early=${v.early_fire_count} tgtFire=${v.targeted_cost_case_fire_count} tgtEarlier=${v.targeted_earlier_fire_count} prot=${v.protected_win_fire_count}(early${v.protected_win_early_fire_count}) ctrl=${v.normal_control_fire_count}(early${v.normal_control_early_fire_count}) 16263@${JSON.stringify((v.first_fire as any)["django-16263"])} pytest=${v.pytest_fired} sympy=${v.sympy_risk} risk=${v.risk_label}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log("\nV0 timing reconstruction:");
  for (const c of perCase) {
    // eslint-disable-next-line no-console
    console.log(`  ${String(c.instance_id).padEnd(26)} ${String(c.group_kind).padEnd(13)} m82=${c.m82_resolved?"T":"F"}/$${(c.m82_cost as number)?.toFixed(2)} C7@${c.v0_m82_first_fire ?? "-"} [${(c.v0_m82_triggers as string[]).join(",")}] tool@fire=${c.v0_m82_tool_at_fire ?? "-"} | M80 C7@${c.v0_m80_first_fire ?? "-"} [${(c.v0_m80_triggers as string[]).join(",")}]`);
  }
}

void main();
