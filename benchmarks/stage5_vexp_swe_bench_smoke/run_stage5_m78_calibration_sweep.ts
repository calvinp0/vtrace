#!/usr/bin/env bun
// M78 offline calibration sweep for the runtime tool-loop guard.
//
// PURE OFFLINE: no live agents, no Docker, no API spend, no retrieval/scoring/
// ranking/Capsule-v2/decision-contract changes. It re-runs the SHIPPED pure
// detector (`runToolLoopGuard`, unchanged) over (a) the captured M71/M72/M73
// unguarded treatment streams — the population the guard would face — and
// (b) the four named M77 LIVE guarded streams whose trajectories actually
// diverged. Calibration variants are evaluated as POST-HOC transforms over the
// detector's firings / event stream so NO guard behavior is modified here.
//
// Variants (see protocol Required analysis 5):
//   V0  current guard
//   V1  minimum first-fire turn >= 4
//   V2  minimum first-fire turn >= 6
//   V3  repeated-read trigger requires >= 3 identical reads (== current threshold)
//   V4  repeated-read/search/window fires only AFTER >= 1 search-or-edit event
//   V5  V0 + multi-file (distinct-file) read-window add-on detector
//   V6  V1 + multi-file read-window
//   V7  V2 + multi-file read-window
//
// Gold labels are NOT used in any detector decision; they are used only for the
// offline interpretation columns (resolved/group provenance via the M74 audit).

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_TOOL_LOOP_GUARD_CONFIG,
  runToolLoopGuard,
  toGuardEvent,
  type ToolLoopGuardEvent,
  type ToolLoopGuardFiring,
} from "./toolLoopGuard";

const R = path.join(import.meta.dir, "results");
const RUNS = path.join(R, "runs");

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

interface TreatmentRow {
  instance_id: string;
  run_label: string;
}
interface AuditRow {
  instance_id: string;
  treatment_cost: number;
  tool_loop_or_thrashing_detected: boolean;
  paired_outcome: string;
  no_patch_exhaustion: boolean;
  treatment_resolved: boolean;
}

const m71 = readJson<TreatmentRow[]>(path.join(R, "stage5_m71_stage_a_50_treatment.detail.json")) ?? [];
const m72 = readJson<TreatmentRow[]>(path.join(R, "stage5_m72_stage_b_50_treatment.detail.json")) ?? [];
const treatment = [...m71, ...m72];
const audit = readJson<{ per_task_classification: AuditRow[] }>(
  path.join(R, "stage5_m74_self_harness_lite_audit.json"),
);
const auditById = new Map<string, AuditRow>((audit?.per_task_classification ?? []).map((r) => [r.instance_id, r]));

function findStream(runLabel: string): string | null {
  const base = path.join(RUNS, runLabel, "raw");
  if (!existsSync(base)) return null;
  const candidates: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name === "_tool_calls_with_outputs.json" || e.name === "_tool_calls.json") candidates.push(full);
    }
  };
  walk(base, 0);
  const rich = candidates.find((c) => c.endsWith("_tool_calls_with_outputs.json"));
  if (rich) return rich;
  return candidates.find((c) => c.endsWith("_tool_calls.json")) ?? null;
}

function groupOf(a: AuditRow | undefined): string {
  if (!a) return "unknown";
  if (a.treatment_cost >= 2.9) return "cap_hit";
  if (a.tool_loop_or_thrashing_detected) return "thrashing_signal";
  if (a.paired_outcome === "treatment_only_pass") return "treatment_only_win";
  if (a.paired_outcome === "baseline_only_pass") return "baseline_only_loss";
  if (a.no_patch_exhaustion) return "no_patch_exhaustion";
  if (a.treatment_resolved) return "normal_resolved_control";
  return "other_unresolved";
}

const READ_FAMILY = new Set(["repeated_read", "repeated_search", "repeated_read_window"]);

// First event index at which a search-or-edit has already happened (for V4 gating).
function firstSearchOrEditIndex(events: readonly ToolLoopGuardEvent[]): number {
  for (const e of events) {
    if (e.category === "search" || e.category === "edit") return e.index;
  }
  return Infinity;
}

// Distinct-file read-window add-on detector (V5). Fires when, within a sliding
// window of WSIZE events, at least DDISTINCT distinct files have each been read
// >= 2 times inside the window — i.e. genuine multi-file read-twice thrash.
// Single-file re-read (even heavy) does NOT trip it. PURE; evaluated here only.
const V5_WSIZE = 8;
const V5_DDISTINCT = 2;
const V5_MINREADS = 2;
function multiFileWindowFirstFire(events: readonly ToolLoopGuardEvent[]): number | null {
  const window: { idx: number; path: string }[] = [];
  for (const e of events) {
    if (e.category === "read" && e.path) {
      window.push({ idx: e.index, path: e.path });
      while (window.length && e.index - window[0]!.idx >= V5_WSIZE) window.shift();
      const counts = new Map<string, number>();
      for (const w of window) counts.set(w.path, (counts.get(w.path) ?? 0) + 1);
      let distinct = 0;
      for (const c of counts.values()) if (c >= V5_MINREADS) distinct += 1;
      if (distinct >= V5_DDISTINCT) return e.index;
    }
  }
  return null;
}

interface VariantFire {
  fires: boolean;
  firstFireTurn: number | null;
  injectionCount: number;
}

function applyVariant(
  variant: string,
  events: readonly ToolLoopGuardEvent[],
): VariantFire {
  const base = runToolLoopGuard(events, { ...DEFAULT_TOOL_LOOP_GUARD_CONFIG, enabled: true });
  let firings: ToolLoopGuardFiring[] = [...base.events];

  // V3 is the current threshold (repeatedReadThreshold = 3); identical to V0.
  // Min-turn gates (V1/V2/V6/V7) post-filter firings by event index.
  const minTurn = variant === "V1" || variant === "V6" ? 4 : variant === "V2" || variant === "V7" ? 6 : 0;
  if (minTurn > 0) firings = firings.filter((f) => f.turnIndex >= minTurn);

  // V4: read-family firings require a prior search-or-edit.
  if (variant === "V4") {
    const gate = firstSearchOrEditIndex(events);
    firings = firings.filter((f) => !READ_FAMILY.has(f.triggerType) || f.turnIndex > gate);
  }

  // V5/V6/V7: add the multi-file (distinct-file) read-window detector.
  if (variant === "V5" || variant === "V6" || variant === "V7") {
    const mf = multiFileWindowFirstFire(events);
    if (mf !== null && mf >= minTurn) {
      firings.push({
        turnIndex: mf,
        triggerType: "repeated_read_window",
        signature: `mfwindow:${mf}`,
        repeatCount: V5_DDISTINCT,
        message: "",
      });
    }
  }

  firings.sort((a, b) => a.turnIndex - b.turnIndex);
  return {
    fires: firings.length > 0,
    firstFireTurn: firings.length ? firings[0]!.turnIndex : null,
    injectionCount: firings.length,
  };
}

const VARIANTS = ["V0", "V1", "V2", "V3", "V4", "V5", "V6", "V7"] as const;

// ---- Cohort pass (M71/M72/M73 unguarded streams) ----
interface CohortCase {
  instance_id: string;
  group: string;
  resolved: boolean;
  events: ToolLoopGuardEvent[];
}
const cohort: CohortCase[] = [];
for (const t of treatment) {
  const a = auditById.get(t.instance_id);
  const stream = findStream(t.run_label);
  if (!stream) continue;
  const raw = readJson<Array<Record<string, unknown>>>(stream) ?? [];
  cohort.push({
    instance_id: t.instance_id,
    group: groupOf(a),
    resolved: a?.treatment_resolved ?? false,
    events: raw.map((r, i) => toGuardEvent(r, i)),
  });
}

const RECALL_GROUPS = new Set(["cap_hit", "thrashing_signal"]);
const FP_GROUPS = new Set(["normal_resolved_control", "treatment_only_win", "baseline_only_loss"]);

const cohortByVariant: Record<string, unknown> = {};
for (const v of VARIANTS) {
  let recallFires = 0;
  let recallTotal = 0;
  let fpFires = 0;
  let fpTotal = 0;
  let earlyFires = 0;
  let totalInjections = 0;
  let treatmentOnlyWinFires = 0;
  let baselineOnlyLossFires = 0;
  for (const c of cohort) {
    const r = applyVariant(v, c.events);
    if (RECALL_GROUPS.has(c.group)) {
      recallTotal += 1;
      if (r.fires) recallFires += 1;
    }
    if (FP_GROUPS.has(c.group)) {
      fpTotal += 1;
      if (r.fires) fpFires += 1;
    }
    if (c.group === "treatment_only_win" && r.fires) treatmentOnlyWinFires += 1;
    if (c.group === "baseline_only_loss" && r.fires) baselineOnlyLossFires += 1;
    if (r.fires && r.firstFireTurn !== null && r.firstFireTurn < 4) earlyFires += 1;
    totalInjections += r.injectionCount;
  }
  cohortByVariant[v] = {
    cap_thrash_recall_fires: recallFires,
    cap_thrash_recall_total: recallTotal,
    control_fp_fires: fpFires,
    control_fp_total: fpTotal,
    treatment_only_win_fires: treatmentOnlyWinFires,
    baseline_only_loss_fires: baselineOnlyLossFires,
    early_fires_lt_turn4: earlyFires,
    total_injections: totalInjections,
  };
}

// ---- Named live cases (M77 guarded streams) ----
const NAMED: { id: string; label: string }[] = [
  { id: "astropy__astropy-14598", label: "m77_tool_loop_guard_inject_astropy__astropy_14598_" },
  { id: "pytest-dev__pytest-6197", label: "m77_tool_loop_guard_inject_pytest_dev__pytest_6197_" },
  { id: "sympy__sympy-12419", label: "m77_tool_loop_guard_inject_sympy__sympy_12419_" },
  { id: "django__django-16263", label: "m77_tool_loop_guard_inject_django__django_16263_" },
];
const namedByVariant: Record<string, Record<string, VariantFire>> = {};
for (const v of VARIANTS) {
  namedByVariant[v] = {};
  for (const n of NAMED) {
    const stream = findStream(n.label);
    const raw = stream ? readJson<Array<Record<string, unknown>>>(stream) ?? [] : [];
    const events = raw.map((r, i) => toGuardEvent(r, i));
    namedByVariant[v]![n.id] = applyVariant(v, events);
  }
}

const out = {
  milestone: "M78-calibration-sweep",
  kind: "offline post-hoc calibration sweep of the runtime tool-loop guard; no live agents, no Docker, no API spend",
  live_agents: false,
  docker: false,
  retrieval_changed: false,
  uses_gold_for_detector: false,
  base_guard_config: DEFAULT_TOOL_LOOP_GUARD_CONFIG,
  v5_multifile_window: { window_size: V5_WSIZE, distinct_files: V5_DDISTINCT, min_reads_per_file: V5_MINREADS },
  cohort_size: cohort.length,
  cohort_group_counts: cohort.reduce<Record<string, number>>((acc, c) => {
    acc[c.group] = (acc[c.group] ?? 0) + 1;
    return acc;
  }, {}),
  variant_definitions: {
    V0: "current guard",
    V1: "minimum first-fire turn >= 4 (post-filter)",
    V2: "minimum first-fire turn >= 6 (post-filter)",
    V3: "repeated-read requires >=3 identical reads (== current threshold; equivalent to V0)",
    V4: "repeated-read/search/window fires only after >=1 search-or-edit event",
    V5: "V0 + multi-file (distinct-file) read-window add-on",
    V6: "V1 + multi-file read-window",
    V7: "V2 + multi-file read-window",
  },
  named_cases_basis: "M77 LIVE guarded streams (the trajectories that actually ran)",
  named_by_variant: namedByVariant,
  cohort_basis: "M71/M72/M73 captured UNGUARDED treatment streams",
  cohort_by_variant: cohortByVariant,
};

const outPath = path.join(R, "stage5_m78_tool_loop_guard_calibration_sweep.json");
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`wrote ${outPath}`);
console.log(`cohort=${cohort.length} groups=${JSON.stringify(out.cohort_group_counts)}`);
for (const v of VARIANTS) {
  const n = namedByVariant[v]!;
  const c = cohortByVariant[v] as Record<string, number>;
  console.log(
    `${v}: pytest=${n["pytest-dev__pytest-6197"]!.fires ? "FIRE@" + n["pytest-dev__pytest-6197"]!.firstFireTurn : "supp"} ` +
      `astropy=${n["astropy__astropy-14598"]!.fires ? "FIRE@" + n["astropy__astropy-14598"]!.firstFireTurn : "supp"} ` +
      `sympy=${n["sympy__sympy-12419"]!.fires ? "FIRE@" + n["sympy__sympy-12419"]!.firstFireTurn : "supp"} ` +
      `django16263=${n["django__django-16263"]!.fires ? "FIRE@" + n["django__django-16263"]!.firstFireTurn : "supp"} | ` +
      `recall=${c.cap_thrash_recall_fires}/${c.cap_thrash_recall_total} fp=${c.control_fp_fires}/${c.control_fp_total} early=${c.early_fires_lt_turn4}`,
  );
}
