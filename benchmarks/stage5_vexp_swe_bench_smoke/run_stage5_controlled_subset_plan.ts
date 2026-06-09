// Stage 5 controlled 10-task benchmark plan.
//
// SCOPE: planning / reporting ONLY. This reads the EXISTING Stage 5 outcome ledger
// (and, opportunistically, candidate/precheck reports) and proposes a fixed, small,
// DEFENSIBLE controlled subset for the next benchmark step: 10 tasks each run in BOTH
// a baseline and a VTRACE condition, so the ledger can later report token/cost/
// resolution deltas and unique wins/losses. It runs NO agents, NO Docker, changes NO
// retrieval / PIVOT_CHECK / telemetry, and reads — never writes — raw artifacts. It
// only writes its own Markdown + JSON plan.
//
// It NEVER computes outcome metrics for runs that do not yet exist: the existing
// per-condition data is carried as SELECTION EVIDENCE only, clearly marked, and the
// "expected metrics after completion" are described, never fabricated.
//
// Design (see _Selection rationale_ in the report):
//   - The 5 existing same-run-label baseline-vs-vtrace pairs (all django) are
//     PRESERVED as-is — they are already controlled and need no new runs.
//   - 5 ADDITIONAL tasks are chosen for repository + outcome diversity, preferring
//     tasks that already have a reusable baseline and a known resolution. Baseline
//     behavior is protocol-independent, so an existing baseline run is reused; the
//     VTRACE condition is (re)run under the CURRENT NORMAL protocol (force-inject,
//     capsule v2, intent debug, budget 8000) so the pair is genuinely controlled.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Condition = "baseline" | "vtrace";
export type Resolution = boolean | null; // null === unknown (never evaluated)
export type SelectionSource = "existing_pair" | "existing_condition_data" | "candidate_report";

// One condition's reusable evidence for an instance (from the ledger).
export interface ConditionEvidence {
  readonly runLabel: string;
  readonly resolved: Resolution;
  readonly cost: number | null;
  readonly tokens: number | null;
  readonly treatmentValid: boolean | null;
}

export interface SelectedTask {
  readonly instanceId: string;
  readonly repo: string;
  readonly selectionSource: SelectionSource;
  readonly hasBaselineRun: boolean;
  readonly hasVtraceRun: boolean;
  readonly baselineRunLabel: string | null;
  readonly vtraceRunLabel: string | null;
  readonly baselineResolved: Resolution;
  readonly vtraceResolved: Resolution;
  readonly baselineCost: number | null;
  readonly vtraceCost: number | null;
  readonly baselineTokens: number | null;
  readonly vtraceTokens: number | null;
  readonly reasonSelected: string;
  readonly risk: string;
}

export interface MissingRun {
  readonly instanceId: string;
  readonly condition: Condition;
  readonly reasonMissing: string;
  readonly recommendedRunLabel: string;
  readonly command: string;
}

export interface PlannedCommand {
  readonly instanceId: string;
  readonly condition: Condition;
  readonly runLabel: string;
  readonly command: string;
}

export interface PlanSummary {
  readonly targetSize: number;
  readonly existingPairCount: number;
  readonly additionalTaskCount: number;
  readonly totalSelected: number;
  readonly reposRepresented: readonly string[];
  readonly missingRunCount: number;
  readonly missingBaselineCount: number;
  readonly missingVtraceCount: number;
  readonly currentlyComparablePairs: number; // = existing pairs (controlled now)
  readonly comparablePairsAfterCompletion: number;
  // True when the subset reaches target size only by opportunistic reuse of existing
  // (heterogeneously-produced) data rather than a fresh stratified sample.
  readonly opportunistic: boolean;
  // True when fewer candidates existed than the requested additional count.
  readonly shortfall: boolean;
}

export interface ControlledSubsetPlan {
  readonly generatedAt: string | null;
  readonly targetSize: number;
  readonly existingPairCount: number;
  readonly additionalTaskCount: number;
  readonly summary: PlanSummary;
  readonly selectedTasks: readonly SelectedTask[];
  readonly missingRuns: readonly MissingRun[];
  readonly commands: readonly PlannedCommand[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RESULTS_REL = "benchmarks/stage5_vexp_swe_bench_smoke/results";
export const DEFAULT_LEDGER_REL = `${RESULTS_REL}/stage5_outcome_ledger.json`;
export const DEFAULT_OUT_NAME = "stage5_controlled_10_task_plan";
export const VEXP_DIR = "/home/calvin/code/vexp-swe-bench";

export const NON_CLAIMS: readonly string[] = [
  "This 10-task plan is a pilot controlled subset, not a statistically powered SWE-bench claim.",
  "It does not claim VTRACE beats VEXP.",
  "It does not claim pass@1 until all selected runs are evaluated.",
  "It does not claim token savings without a same-instance baseline comparison.",
  "It does not run agents or Docker.",
];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function repoOf(instanceId: string): string {
  const idx = instanceId.indexOf("__");
  return idx >= 0 ? instanceId.slice(0, idx) : "unknown";
}

// Short id used in run labels: the part after `__` (e.g. astropy__astropy-14369 →
// "astropy-14369"), matching the existing Stage 5 controlled-label convention.
export function shortId(instanceId: string): string {
  const idx = instanceId.indexOf("__");
  return idx >= 0 ? instanceId.slice(idx + 2) : instanceId;
}

export function uniq(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

// ---------------------------------------------------------------------------
// Command templates
// ---------------------------------------------------------------------------

export function controlledLabel(condition: Condition, instanceId: string): string {
  return `eval-controlled-${condition}-${shortId(instanceId)}`;
}

// The baseline condition uses the same harness shape as existing Stage 5 baseline
// runs: `--mode run-protocol --protocol baseline` (no capsule/context flags — the
// baseline does not use retrieval).
export function buildBaselineCommand(instanceId: string): string {
  return [
    "bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \\",
    "  --mode run-protocol \\",
    "  --protocol baseline \\",
    `  --vexp-swe-bench-dir ${VEXP_DIR} \\`,
    `  --instances ${instanceId} \\`,
    `  --run-label ${controlledLabel("baseline", instanceId)} \\`,
    "  --out benchmarks/stage5_vexp_swe_bench_smoke/results",
  ].join("\n");
}

// The VTRACE condition uses CURRENT NORMAL behavior: force-inject, capsule v2, intent
// debug, budget 8000. NOTE: --disable-pivot-check is intentionally NOT included — a
// controlled benchmark evaluates normal current VTRACE (PIVOT_CHECK as it ships).
export function buildVtraceCommand(instanceId: string): string {
  return [
    "bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \\",
    "  --mode run-protocol \\",
    "  --protocol vtrace-indexed \\",
    `  --vexp-swe-bench-dir ${VEXP_DIR} \\`,
    `  --instances ${instanceId} \\`,
    `  --run-label ${controlledLabel("vtrace", instanceId)} \\`,
    "  --show-vtrace-index-log \\",
    "  --context-policy force-inject \\",
    "  --capsule-engine v2 \\",
    "  --capsule-intent debug \\",
    "  --capsule-budget 8000 \\",
    "  --out benchmarks/stage5_vexp_swe_bench_smoke/results",
  ].join("\n");
}

export function buildCommand(condition: Condition, instanceId: string): string {
  return condition === "baseline" ? buildBaselineCommand(instanceId) : buildVtraceCommand(instanceId);
}

// ---------------------------------------------------------------------------
// Ledger ingestion (pure over already-parsed JSON)
// ---------------------------------------------------------------------------

export interface LedgerRunLite {
  readonly runLabel: string;
  readonly condition: string;
  readonly instanceId: string | null;
  readonly resolved: Resolution;
  readonly cost: number | null;
  readonly tokens: number | null;
  readonly treatmentValid: boolean | null;
}

export interface LedgerPairLite {
  readonly instanceId: string | null;
  readonly pairType: string;
  readonly beforeRunLabel: string;
  readonly afterRunLabel: string;
  readonly beforeResolved: Resolution;
  readonly afterResolved: Resolution;
  readonly beforeCost: number | null;
  readonly afterCost: number | null;
  readonly beforeTokens: number | null;
  readonly afterTokens: number | null;
}

export interface ParsedLedger {
  readonly runs: readonly LedgerRunLite[];
  readonly pairs: readonly LedgerPairLite[];
}

export function parseLedger(raw: unknown): ParsedLedger {
  const runs: LedgerRunLite[] = [];
  const pairs: LedgerPairLite[] = [];
  if (!isRecord(raw)) return { runs, pairs };
  if (Array.isArray(raw.runs)) {
    for (const r of raw.runs) {
      if (!isRecord(r)) continue;
      const tokens = isRecord(r.tokens) ? asNumber(r.tokens.total) : asNumber(r.tokens);
      runs.push({
        runLabel: asString(r.runLabel) ?? "unknown",
        condition: asString(r.condition) ?? "unknown",
        instanceId: asString(r.instanceId),
        resolved: asBool(r.resolved),
        cost: asNumber(r.cost),
        tokens,
        treatmentValid: asBool(r.treatmentValid),
      });
    }
  }
  if (Array.isArray(raw.pairs)) {
    for (const p of raw.pairs) {
      if (!isRecord(p)) continue;
      pairs.push({
        instanceId: asString(p.instanceId),
        pairType: asString(p.pairType) ?? "unknown",
        beforeRunLabel: asString(p.beforeRunLabel) ?? "unknown",
        afterRunLabel: asString(p.afterRunLabel) ?? "unknown",
        beforeResolved: asBool(p.beforeResolved),
        afterResolved: asBool(p.afterResolved),
        beforeCost: asNumber(p.beforeCost),
        afterCost: asNumber(p.afterCost),
        beforeTokens: asNumber(p.beforeTokens),
        afterTokens: asNumber(p.afterTokens),
      });
    }
  }
  return { runs, pairs };
}

// Strip a " [baseline]" / " [vtrace]" suffix the ledger appends to a same-label pair.
function stripConditionSuffix(label: string): string {
  return label.replace(/\s*\[(baseline|vtrace)\]\s*$/, "");
}

// Per-instance, the best reusable run for each condition. "Best" prefers a valid run
// with a KNOWN resolution, then any valid run, then any run — so the selection has
// the strongest available evidence without inventing it.
export type ConditionIndex = Map<string, { baseline: ConditionEvidence | null; vtrace: ConditionEvidence | null }>;

export function buildConditionIndex(runs: readonly LedgerRunLite[]): ConditionIndex {
  const index: ConditionIndex = new Map();
  const score = (r: LedgerRunLite): number => (r.resolved !== null ? 2 : 0) + (r.treatmentValid === true ? 1 : 0);
  for (const r of runs) {
    if (r.instanceId === null) continue;
    if (r.condition !== "baseline" && r.condition !== "vtrace") continue;
    const entry = index.get(r.instanceId) ?? { baseline: null, vtrace: null };
    const cond = r.condition as Condition;
    const current = entry[cond];
    const candidate: ConditionEvidence = {
      runLabel: r.runLabel,
      resolved: r.resolved,
      cost: r.cost,
      tokens: r.tokens,
      treatmentValid: r.treatmentValid,
    };
    if (
      current === null ||
      score(r) > (current.resolved !== null ? 2 : 0) + (current.treatmentValid === true ? 1 : 0)
    ) {
      entry[cond] = candidate;
    }
    index.set(r.instanceId, entry);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Selection (pure, deterministic)
// ---------------------------------------------------------------------------

// The 5 existing controlled pairs come straight from the ledger's same-label
// baseline-vs-vtrace pairs. They are PRESERVED first (principle 1).
export function buildExistingPairTasks(pairs: readonly LedgerPairLite[]): SelectedTask[] {
  return pairs
    .filter((p) => p.pairType === "baseline_vs_vtrace" && p.instanceId !== null)
    .map((p) => {
      const instanceId = p.instanceId!;
      return {
        instanceId,
        repo: repoOf(instanceId),
        selectionSource: "existing_pair" as SelectionSource,
        hasBaselineRun: true,
        hasVtraceRun: true,
        baselineRunLabel: stripConditionSuffix(p.beforeRunLabel),
        vtraceRunLabel: stripConditionSuffix(p.afterRunLabel),
        baselineResolved: p.beforeResolved,
        vtraceResolved: p.afterResolved,
        baselineCost: p.beforeCost,
        vtraceCost: p.afterCost,
        baselineTokens: p.beforeTokens,
        vtraceTokens: p.afterTokens,
        reasonSelected: "already a controlled same-run-label baseline-vs-vtrace pair (preserved as-is)",
        risk: "none — both conditions already ran together under one label",
      };
    });
}

// Candidate scoring for the additional tasks. Higher is better. Diversity is applied
// separately (greedy, one repo at a time); within a repo this ranks candidates.
function candidateScore(ev: { baseline: ConditionEvidence | null; vtrace: ConditionEvidence | null }, promoted: boolean): number {
  let s = 0;
  if (ev.baseline !== null) s += 3; // reusable, protocol-stable baseline (minimizes new runs)
  if (ev.vtrace !== null) s += 1; // existing vtrace evidence (informational)
  const knownRes = ev.baseline?.resolved != null || ev.vtrace?.resolved != null;
  if (knownRes) s += 2; // principle 4: known Docker resolution in at least one condition
  if (promoted) s += 1; // principle 5: a promoted hidden-pivot/precheck candidate
  return s;
}

// Greedy, diversity-first additional selection. Picks at most one candidate per NEW
// repository first (principle 3), choosing each repo's highest-scoring instance, then
// fills any remaining slots by score. Deterministic: ties break by instanceId.
export function selectAdditionalTasks(
  index: ConditionIndex,
  excludeInstances: ReadonlySet<string>,
  excludeRepos: ReadonlySet<string>,
  promotedSet: ReadonlySet<string>,
  needed: number,
): SelectedTask[] {
  if (needed <= 0) return [];
  // Pool: instances with at least one reusable condition, not already selected.
  const pool = [...index.entries()]
    .filter(([instanceId, ev]) => !excludeInstances.has(instanceId) && (ev.baseline !== null || ev.vtrace !== null))
    .map(([instanceId, ev]) => ({
      instanceId,
      ev,
      repo: repoOf(instanceId),
      promoted: promotedSet.has(instanceId),
      score: candidateScore(ev, promotedSet.has(instanceId)),
    }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.instanceId.localeCompare(b.instanceId)));

  const chosen: typeof pool = [];
  const usedRepos = new Set(excludeRepos);
  const usedInstances = new Set<string>();

  // Pass 1: one per NEW repo, best score first (diversity).
  for (const c of pool) {
    if (chosen.length >= needed) break;
    if (usedInstances.has(c.instanceId) || usedRepos.has(c.repo)) continue;
    chosen.push(c);
    usedRepos.add(c.repo);
    usedInstances.add(c.instanceId);
  }
  // Pass 2: fill remaining slots by score regardless of repo (only if pool allows).
  if (chosen.length < needed) {
    for (const c of pool) {
      if (chosen.length >= needed) break;
      if (usedInstances.has(c.instanceId)) continue;
      chosen.push(c);
      usedInstances.add(c.instanceId);
    }
  }

  return chosen.map((c) => {
    const b = c.ev.baseline;
    const v = c.ev.vtrace;
    const outcome = describeOutcome(b?.resolved ?? null, v?.resolved ?? null);
    const parts: string[] = [`repository diversity (${c.repo})`];
    if (b !== null) parts.push("reusable existing baseline run");
    if (v !== null) parts.push("existing VTRACE evidence");
    if (outcome) parts.push(outcome);
    if (c.promoted) parts.push("promoted live-capsule precheck candidate");
    return {
      instanceId: c.instanceId,
      repo: c.repo,
      selectionSource: "existing_condition_data" as SelectionSource,
      hasBaselineRun: b !== null,
      hasVtraceRun: v !== null,
      baselineRunLabel: b?.runLabel ?? null,
      vtraceRunLabel: v?.runLabel ?? null,
      baselineResolved: b?.resolved ?? null,
      vtraceResolved: v?.resolved ?? null,
      baselineCost: b?.cost ?? null,
      vtraceCost: v?.cost ?? null,
      baselineTokens: b?.tokens ?? null,
      vtraceTokens: v?.tokens ?? null,
      reasonSelected: parts.join("; "),
      risk:
        "existing condition data was produced under heterogeneous run labels/configs; the VTRACE condition is re-run under the current normal protocol for a controlled pair (existing baseline is protocol-stable and reused)",
    };
  });
}

// A short human label for the existing per-condition resolution pattern (selection
// evidence only — NOT a controlled measurement).
function describeOutcome(baseline: Resolution, vtrace: Resolution): string | null {
  if (baseline === null && vtrace === null) return "resolution unknown in both existing conditions";
  if (baseline === null || vtrace === null) return "resolution known in one existing condition";
  if (baseline && vtrace) return "both existing conditions resolved (tie)";
  if (!baseline && !vtrace) return "both existing conditions unresolved";
  return vtrace ? "existing VTRACE resolved where baseline did not (apparent win)" : "existing baseline resolved where VTRACE did not (apparent loss)";
}

// Missing runs to execute for the controlled subset. Existing pairs need nothing.
// Additional tasks re-run VTRACE under the controlled protocol (config heterogeneity)
// and run baseline only when no reusable baseline exists.
export function buildMissingRuns(task: SelectedTask): MissingRun[] {
  if (task.selectionSource === "existing_pair") return [];
  const runs: MissingRun[] = [];
  if (!task.hasBaselineRun) {
    runs.push({
      instanceId: task.instanceId,
      condition: "baseline",
      reasonMissing: "no existing baseline run for this instance",
      recommendedRunLabel: controlledLabel("baseline", task.instanceId),
      command: buildBaselineCommand(task.instanceId),
    });
  }
  runs.push({
    instanceId: task.instanceId,
    condition: "vtrace",
    reasonMissing: task.hasVtraceRun
      ? "existing VTRACE data is from a non-controlled label/config; re-run under the current normal protocol"
      : "no existing VTRACE run for this instance",
    recommendedRunLabel: controlledLabel("vtrace", task.instanceId),
    command: buildVtraceCommand(task.instanceId),
  });
  return runs;
}

// ---------------------------------------------------------------------------
// Plan assembly (pure)
// ---------------------------------------------------------------------------

export function buildPlan(
  ledger: ParsedLedger,
  promotedSet: ReadonlySet<string>,
  targetSize: number,
  generatedAt: string | null,
): ControlledSubsetPlan {
  const existing = buildExistingPairTasks(ledger.pairs);
  const existingInstances = new Set(existing.map((t) => t.instanceId));
  const existingRepos = new Set(existing.map((t) => t.repo));
  const needed = Math.max(0, targetSize - existing.length);

  const index = buildConditionIndex(ledger.runs);
  const additional = selectAdditionalTasks(index, existingInstances, existingRepos, promotedSet, needed);

  const selectedTasks = [...existing, ...additional];
  const missingRuns = selectedTasks.flatMap(buildMissingRuns);
  const commands: PlannedCommand[] = missingRuns.map((m) => ({
    instanceId: m.instanceId,
    condition: m.condition,
    runLabel: m.recommendedRunLabel,
    command: m.command,
  }));

  const reposRepresented = uniq(selectedTasks.map((t) => t.repo)).sort();
  const missingBaselineCount = missingRuns.filter((m) => m.condition === "baseline").length;
  const missingVtraceCount = missingRuns.filter((m) => m.condition === "vtrace").length;

  const summary: PlanSummary = {
    targetSize,
    existingPairCount: existing.length,
    additionalTaskCount: additional.length,
    totalSelected: selectedTasks.length,
    reposRepresented,
    missingRunCount: missingRuns.length,
    missingBaselineCount,
    missingVtraceCount,
    currentlyComparablePairs: existing.length,
    comparablePairsAfterCompletion: selectedTasks.length,
    opportunistic: additional.length > 0,
    shortfall: additional.length < needed,
  };

  return {
    generatedAt,
    targetSize,
    existingPairCount: existing.length,
    additionalTaskCount: additional.length,
    summary,
    selectedTasks,
    missingRuns,
    commands,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderJson(plan: ControlledSubsetPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function fmtResolved(v: Resolution): string {
  return v === null ? "unknown" : v ? "resolved" : "unresolved";
}

function fmtNum(n: number | null, digits = 0): string {
  return n === null ? "unknown" : n.toFixed(digits);
}

function fmtList(values: readonly string[]): string {
  return values.length === 0 ? "—" : values.join(", ");
}

export function renderMarkdown(plan: ControlledSubsetPlan): string {
  const lines: string[] = [];
  const s = plan.summary;
  lines.push("# Stage 5 controlled 10-task benchmark plan");
  lines.push("");
  if (plan.generatedAt) lines.push(`_Generated: ${plan.generatedAt}_`, "");
  lines.push(
    "_Planning / reporting only. No agents, no Docker, no retrieval / PIVOT_CHECK / telemetry " +
      "changes. Proposes a fixed, defensible controlled subset; computes nothing for runs that do " +
      "not yet exist._",
  );
  lines.push("");

  // --- Summary -------------------------------------------------------------
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Target size: ${s.targetSize} tasks (each run in baseline AND VTRACE).`);
  lines.push(`- Existing controlled pairs preserved: ${s.existingPairCount}.`);
  lines.push(`- Additional tasks selected: ${s.additionalTaskCount}.`);
  lines.push(`- Total tasks in subset: ${s.totalSelected}.`);
  lines.push(`- Repositories represented: ${s.reposRepresented.length} (${fmtList(s.reposRepresented)}).`);
  lines.push(`- Currently comparable pairs (controlled now): ${s.currentlyComparablePairs}.`);
  lines.push(`- Comparable pairs after completion: ${s.comparablePairsAfterCompletion}.`);
  lines.push(`- Missing runs to execute: ${s.missingRunCount} (${s.missingBaselineCount} baseline, ${s.missingVtraceCount} VTRACE).`);
  if (s.shortfall) {
    lines.push(
      `- **Shortfall:** fewer reusable candidates existed than the ${s.targetSize - s.existingPairCount} additional tasks requested; the subset is smaller than the target.`,
    );
  }
  lines.push("");

  // --- Existing comparable pairs ------------------------------------------
  lines.push("## Existing comparable pairs");
  lines.push("");
  const existing = plan.selectedTasks.filter((t) => t.selectionSource === "existing_pair");
  if (existing.length === 0) {
    lines.push("_No existing same-run-label baseline-vs-vtrace pairs were found in the ledger._");
  } else {
    lines.push("These already ran baseline + VTRACE under one run label and are controlled as-is:");
    lines.push("");
    lines.push("| instance | repo | run label | baseline | VTRACE |");
    lines.push("| --- | --- | --- | :---: | :---: |");
    for (const t of existing) {
      lines.push(
        `| ${t.instanceId} | ${t.repo} | ${t.baselineRunLabel ?? "unknown"} | ${fmtResolved(t.baselineResolved)} | ${fmtResolved(t.vtraceResolved)} |`,
      );
    }
    lines.push("");
    lines.push("_(All five existing pairs are django — the additional tasks below add repository diversity.)_");
  }
  lines.push("");

  // --- Selected additional tasks ------------------------------------------
  lines.push("## Selected additional tasks");
  lines.push("");
  const additional = plan.selectedTasks.filter((t) => t.selectionSource !== "existing_pair");
  if (additional.length === 0) {
    lines.push("_No additional tasks were selected._");
  } else {
    lines.push("| instance | repo | baseline run (reuse) | existing VTRACE | base res | vtrace res | reason |");
    lines.push("| --- | --- | --- | --- | :---: | :---: | --- |");
    for (const t of additional) {
      lines.push(
        `| ${t.instanceId} | ${t.repo} | ${t.baselineRunLabel ?? "—"} | ${t.vtraceRunLabel ?? "—"} | ` +
          `${fmtResolved(t.baselineResolved)} | ${fmtResolved(t.vtraceResolved)} | ${t.reasonSelected} |`,
      );
    }
    lines.push("");
    lines.push(
      "Per-condition resolution above is SELECTION EVIDENCE from existing runs, not a controlled " +
        "measurement — the VTRACE condition is re-run under the current normal protocol before any delta is computed.",
    );
  }
  lines.push("");

  // --- Missing runs to execute --------------------------------------------
  lines.push("## Missing runs to execute");
  lines.push("");
  if (plan.missingRuns.length === 0) {
    lines.push("_No missing runs — every selected task is already controlled._");
  } else {
    lines.push("| instance | condition | run label | why |");
    lines.push("| --- | --- | --- | --- |");
    for (const m of plan.missingRuns) {
      lines.push(`| ${m.instanceId} | ${m.condition} | ${m.recommendedRunLabel} | ${m.reasonMissing} |`);
    }
    lines.push("");
    lines.push(
      `Total: ${plan.missingRuns.length} run(s) — ${s.missingBaselineCount} baseline, ${s.missingVtraceCount} VTRACE. ` +
        "Existing baselines are reused (baseline behavior is protocol-independent), so the VTRACE re-runs are the bulk of the work.",
    );
  }
  lines.push("");

  // --- Selection rationale -------------------------------------------------
  lines.push("## Selection rationale");
  lines.push("");
  lines.push("- **Preserve the 5 existing pairs** (principle 1): they are already controlled and need no new runs.");
  lines.push("- **Add reusable tasks** (principle 2): each additional task already has a baseline run (protocol-stable, reused) and existing VTRACE evidence, minimizing new runs to one controlled VTRACE run per task.");
  lines.push("- **Repository diversity** (principle 3): the 5 django pairs are widened with distinct repositories so the subset is not django-only.");
  lines.push("- **Known resolution preferred** (principle 4): candidates with a known Docker resolution in at least one condition are ranked first.");
  lines.push("- **Promoted precheck candidate included** (principle 5): at least one promoted live-capsule hidden-pivot candidate is included where it does not distort the subset.");
  lines.push("- **No cherry-picking** (principles 6–7): the additional set deliberately mixes outcomes (apparent win, apparent loss, ties, and unresolved) and is not limited to VTRACE wins or easy/resolved tasks.");
  lines.push("- **Opportunistic, not stratified** (principle 8): this reuses whatever existing condition data is available; it is a controlled PILOT, not a statistically representative sample.");
  lines.push("");

  // --- Expected metrics after completion ----------------------------------
  lines.push("## Expected metrics after completion");
  lines.push("");
  lines.push("Once the missing runs are executed and evaluated, the outcome ledger can report over the fixed subset:");
  lines.push("");
  lines.push("- 10 paired tasks (baseline + VTRACE per instance).");
  lines.push("- Baseline resolved count and VTRACE resolved count.");
  lines.push("- Wins / losses / ties (per-instance resolution comparison).");
  lines.push("- Cost per task by condition; token use by condition.");
  lines.push("- Token/cost deltas (VTRACE − baseline) per task and aggregated.");
  lines.push("- Unique VTRACE wins (VTRACE resolved where baseline did not) and unique VTRACE losses (the reverse).");
  lines.push("");
  lines.push(
    "**None of these are computed here.** They require the missing runs to be executed and evaluated first; this plan only enumerates the work.",
  );
  lines.push("");

  // --- Run commands --------------------------------------------------------
  lines.push("## Run commands");
  lines.push("");
  if (plan.commands.length === 0) {
    lines.push("_No commands — the subset is already controlled._");
  } else {
    lines.push("Run each missing condition, then re-run the outcome ledger to materialize the pairs:");
    for (const c of plan.commands) {
      lines.push("");
      lines.push(`**${c.instanceId} — ${c.condition}** (\`${c.runLabel}\`):`);
      lines.push("");
      lines.push("```bash");
      lines.push(c.command);
      lines.push("```");
    }
    lines.push("");
    lines.push("After all runs complete:");
    lines.push("");
    lines.push("```bash");
    lines.push(
      [
        "bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_outcome_ledger.ts \\",
        "  --results benchmarks/stage5_vexp_swe_bench_smoke/results \\",
        "  --out-name stage5_outcome_ledger",
      ].join("\n"),
    );
    lines.push("```");
  }
  lines.push("");

  // --- Limitations ---------------------------------------------------------
  lines.push("## Limitations");
  lines.push("");
  lines.push("- This is an OPPORTUNISTIC pilot: it reuses existing, heterogeneously-produced condition data rather than drawing a fresh stratified sample.");
  lines.push("- The 5 preserved pairs are all django; repository diversity comes only from the 5 additional tasks.");
  lines.push("- Reused baselines were produced at earlier commits; if baseline harness behavior has changed materially, a baseline re-run may be needed for strict control.");
  lines.push("- Existing per-condition resolution is selection evidence only and may not reproduce under the controlled re-run.");
  lines.push("- 10 tasks is too few for a statistically powered claim; it is a measurement-workflow pilot.");
  lines.push("");

  // --- Non-claims ----------------------------------------------------------
  lines.push("## Non-claims");
  lines.push("");
  for (const claim of NON_CLAIMS) lines.push(`- ${claim}`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Loading (impure)
// ---------------------------------------------------------------------------

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

// Promoted instance ids from the live-capsule precheck report (best-effort; empty
// when the report is absent). Used only to give promoted candidates a small ranking
// bonus — never to fabricate selection.
export async function loadPromotedInstances(resultsDir: string): Promise<Set<string>> {
  const raw = await readJsonFile(path.join(resultsDir, "stage5_live_capsule_precheck_tier2.json"));
  const out = new Set<string>();
  if (!isRecord(raw) || !Array.isArray(raw.checkedCandidates)) return out;
  for (const c of raw.checkedCandidates) {
    if (isRecord(c) && c.promotionDecision === "promote") {
      const id = asString(c.instanceId);
      if (id !== null) out.add(id);
    }
  }
  return out;
}

export async function buildPlanFromDisk(
  resultsDir: string,
  ledgerPath: string,
  targetSize: number,
  generatedAt: string | null,
): Promise<ControlledSubsetPlan> {
  const ledger = parseLedger(await readJsonFile(ledgerPath));
  const promoted = await loadPromotedInstances(resultsDir);
  return buildPlan(ledger, promoted, targetSize, generatedAt);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliConfig {
  readonly resultsDir: string;
  readonly ledgerPath: string;
  readonly targetSize: number;
  readonly outName: string;
}

export function parseArgs(argv: readonly string[]): CliConfig {
  let resultsDir = RESULTS_REL;
  let ledgerPath: string | null = null;
  let targetSize = 10;
  let outName = DEFAULT_OUT_NAME;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`Missing value for ${arg}.`);
      i += 1;
      return v;
    };
    switch (arg) {
      case "--results":
        resultsDir = next();
        break;
      case "--ledger":
        ledgerPath = next();
        break;
      case "--target-size": {
        const v = Number(next());
        if (!Number.isInteger(v) || v <= 0) throw new Error("--target-size must be a positive integer.");
        targetSize = v;
        break;
      }
      case "--out-name":
        outName = next();
        break;
      case "--help":
      case "-h":
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { resultsDir, ledgerPath: ledgerPath ?? path.join(resultsDir, "stage5_outcome_ledger.json"), targetSize, outName };
}

async function main(config: CliConfig): Promise<void> {
  const generatedAt = new Date().toISOString();
  const plan = await buildPlanFromDisk(config.resultsDir, config.ledgerPath, config.targetSize, generatedAt);

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(plan));
  await writeFile(jsonPath, renderJson(plan));

  const s = plan.summary;
  process.stdout.write(
    [
      "Stage 5 controlled subset plan written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Existing pairs: ${s.existingPairCount}   Additional: ${s.additionalTaskCount}   Total: ${s.totalSelected}`,
      `Repos: ${s.reposRepresented.join(", ")}`,
      `Missing runs: ${s.missingRunCount} (${s.missingBaselineCount} baseline, ${s.missingVtraceCount} VTRACE)`,
      "",
    ].join("\n"),
  );
}

if (import.meta.main) {
  try {
    await main(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
