// Stage 5 EDIT_GUARD 3-loss before/after experiment plan.
//
// SCOPE: planning / reporting ONLY. This emits a fixed before/after experiment plan
// for the three controlled-pilot VTRACE losses, each classified
// `patch_mistake_despite_good_context` — exactly the failure mode EDIT_GUARD targets.
// It isolates the INCREMENTAL effect of EDIT_GUARD: both conditions keep PIVOT_CHECK
// on; only the `--disable-edit-guard` flag differs.
//   A. before = PIVOT_CHECK only          (--disable-edit-guard)
//   B. after  = PIVOT_CHECK + EDIT_GUARD   (default)
//
// It runs NO agents, NO Docker, changes NO retrieval / PIVOT_CHECK / telemetry, and
// reads — never writes — raw artifacts. It only writes its own Markdown + JSON plan,
// and it NEVER fabricates a result: the before/after comparison is described, not
// computed, until the six runs and evaluations actually exist.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Treatment = "PIVOT_CHECK only" | "PIVOT_CHECK + EDIT_GUARD";
export type Condition = "before" | "after";

export interface ExperimentCase {
  readonly instanceId: string;
  readonly repo: string;
  // The controlled-pilot loss classification this case carries (all three are
  // `patch_mistake_despite_good_context`).
  readonly knownLossClassification: string;
  readonly beforeLabel: string;
  readonly afterLabel: string;
  readonly beforeTreatment: Treatment;
  readonly afterTreatment: Treatment;
  // Which specific defect pattern + EDIT_GUARD step motivates including this case.
  readonly reasonIncluded: string;
}

export interface RunCommand {
  readonly instanceId: string;
  readonly condition: Condition;
  readonly runLabel: string;
  readonly treatment: Treatment;
  // True only for the `before` (PIVOT_CHECK only) condition.
  readonly editGuardDisabled: boolean;
  readonly command: string;
}

export interface EvaluationCommand {
  readonly instanceId: string;
  readonly runLabel: string;
  readonly command: string;
}

export interface EditGuardExperimentPlan {
  readonly generatedAt: string | null;
  readonly cases: readonly ExperimentCase[];
  readonly commands: readonly RunCommand[];
  readonly evaluationCommands: readonly EvaluationCommand[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RESULTS_REL = "benchmarks/stage5_vexp_swe_bench_smoke/results";
export const DEFAULT_OUT_NAME = "stage5_edit_guard_3_loss_experiment_plan";
export const VEXP_DIR = "/home/calvin/code/vexp-swe-bench";
export const HARNESS = "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts";
export const EVAL_DATASET = "swebench-verified-full.jsonl";

export const BEFORE_TREATMENT: Treatment = "PIVOT_CHECK only";
export const AFTER_TREATMENT: Treatment = "PIVOT_CHECK + EDIT_GUARD";

// The three controlled-pilot VTRACE losses, with the defect pattern each exhibited and
// the EDIT_GUARD step meant to address it. These are FIXED inputs from the committed
// loss analysis (stage5_controlled_pilot_loss_analysis.md) — not re-derived here.
interface LossSeed {
  readonly instanceId: string;
  readonly repo: string;
  readonly defect: string;
  readonly editGuardStep: string;
}

export const LOSS_SEEDS: readonly LossSeed[] = [
  {
    instanceId: "sympy__sympy-16766",
    repo: "sympy",
    defect: "wrong class scope — new printer methods landed in AbstractPythonCodePrinter instead of PythonCodePrinter",
    editGuardStep: "SCOPE (confirm the exact enclosing class/function before inserting methods)",
  },
  {
    instanceId: "matplotlib__matplotlib-22719",
    repo: "matplotlib",
    defect: "incomplete fix — narrowed a warning guard but missed the baseline's early return for empty arrays",
    editGuardStep: "FAILING BEHAVIOR (name the concrete failing input — the empty array — and verify the patch handles it)",
  },
  {
    instanceId: "psf__requests-5414",
    repo: "psf",
    defect: "broad control-flow rewrite — always-IDNA-encode restructure instead of minimal additive empty-label validation",
    editGuardStep: "MINIMAL FIX (prefer the smallest additive guard/validation over a control-flow rewrite)",
  },
];

export const KNOWN_LOSS_CLASSIFICATION = "patch_mistake_despite_good_context";

export const NON_CLAIMS: readonly string[] = [
  "This is a 3-case before/after experiment plan, not a statistically powered benchmark.",
  "It isolates the INCREMENTAL effect of EDIT_GUARD only: PIVOT_CHECK stays on in BOTH conditions (--disable-pivot-check is never used).",
  "It does not claim EDIT_GUARD fixes these losses — that is the hypothesis the runs will test.",
  "It does not compare against VEXP or baseline; both conditions are VTRACE-indexed.",
  "It computes NO resolved/token/cost deltas here — those require the six runs and Docker evaluations to exist first.",
  "It runs no agents and no Docker.",
];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// Short id used in run labels: the part after `__` (e.g. psf__requests-5414 →
// "requests-5414"), matching the existing Stage 5 controlled-label convention.
export function shortId(instanceId: string): string {
  const idx = instanceId.indexOf("__");
  return idx >= 0 ? instanceId.slice(idx + 2) : instanceId;
}

export function beforeLabelFor(instanceId: string): string {
  return `eval-editguard-before-${shortId(instanceId)}`;
}

export function afterLabelFor(instanceId: string): string {
  return `eval-editguard-after-${shortId(instanceId)}`;
}

// ---------------------------------------------------------------------------
// Command templates
// ---------------------------------------------------------------------------

// Both conditions share the current normal VTRACE protocol: force-inject, Capsule v2,
// intent debug, budget 8000, PIVOT_CHECK on. The ONLY difference is the trailing
// `--disable-edit-guard` line on the `before` (PIVOT_CHECK-only) condition.
export function buildRunCommand(instanceId: string, runLabel: string, disableEditGuard: boolean): string {
  const lines = [
    `bun ${HARNESS} \\`,
    "  --mode run-protocol \\",
    "  --protocol vtrace-indexed \\",
    `  --vexp-swe-bench-dir ${VEXP_DIR} \\`,
    `  --instances ${instanceId} \\`,
    `  --run-label ${runLabel} \\`,
    "  --show-vtrace-index-log \\",
    "  --context-policy force-inject \\",
    "  --capsule-engine v2 \\",
    "  --capsule-intent debug \\",
    "  --capsule-budget 8000 \\",
  ];
  if (disableEditGuard) lines.push("  --disable-edit-guard \\");
  lines.push("  --out benchmarks/stage5_vexp_swe_bench_smoke/results");
  return lines.join("\n");
}

// Docker evaluation for one produced run label.
export function buildEvaluationCommand(instanceId: string, runLabel: string): string {
  return [
    `bun ${HARNESS} \\`,
    "  --mode evaluate \\",
    `  --vexp-swe-bench-dir ${VEXP_DIR} \\`,
    `  --instances ${instanceId} \\`,
    `  --run-label ${runLabel} \\`,
    "  --eval-mode docker \\",
    `  --eval-dataset ${EVAL_DATASET} \\`,
    "  --out benchmarks/stage5_vexp_swe_bench_smoke/results",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Plan assembly (pure)
// ---------------------------------------------------------------------------

export function buildCase(seed: LossSeed): ExperimentCase {
  return {
    instanceId: seed.instanceId,
    repo: seed.repo,
    knownLossClassification: KNOWN_LOSS_CLASSIFICATION,
    beforeLabel: beforeLabelFor(seed.instanceId),
    afterLabel: afterLabelFor(seed.instanceId),
    beforeTreatment: BEFORE_TREATMENT,
    afterTreatment: AFTER_TREATMENT,
    reasonIncluded: `${seed.defect}; targeted by EDIT_GUARD's ${seed.editGuardStep}`,
  };
}

export function buildPlan(generatedAt: string | null): EditGuardExperimentPlan {
  const cases = LOSS_SEEDS.map(buildCase);

  // before + after run command per case (6 total), before first for a stable order.
  const commands: RunCommand[] = cases.flatMap((c) => [
    {
      instanceId: c.instanceId,
      condition: "before" as Condition,
      runLabel: c.beforeLabel,
      treatment: c.beforeTreatment,
      editGuardDisabled: true,
      command: buildRunCommand(c.instanceId, c.beforeLabel, true),
    },
    {
      instanceId: c.instanceId,
      condition: "after" as Condition,
      runLabel: c.afterLabel,
      treatment: c.afterTreatment,
      editGuardDisabled: false,
      command: buildRunCommand(c.instanceId, c.afterLabel, false),
    },
  ]);

  // One Docker evaluation per produced run label (all six).
  const evaluationCommands: EvaluationCommand[] = commands.map((c) => ({
    instanceId: c.instanceId,
    runLabel: c.runLabel,
    command: buildEvaluationCommand(c.instanceId, c.runLabel),
  }));

  return { generatedAt, cases, commands, evaluationCommands };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderJson(plan: EditGuardExperimentPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function renderMarkdown(plan: EditGuardExperimentPlan): string {
  const lines: string[] = [];
  lines.push("# Stage 5 EDIT_GUARD 3-loss experiment plan");
  lines.push("");
  if (plan.generatedAt) lines.push(`_Generated: ${plan.generatedAt}_`, "");
  lines.push(
    "_Planning / reporting only. No agents, no Docker, no retrieval / PIVOT_CHECK / telemetry " +
      "changes. Emits a fixed before/after experiment for the three controlled-pilot VTRACE losses; " +
      "computes nothing until the runs exist._",
  );
  lines.push("");

  // --- Summary -------------------------------------------------------------
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Cases: ${plan.cases.length} controlled-pilot VTRACE losses (all \`${KNOWN_LOSS_CLASSIFICATION}\`).`);
  lines.push("- Two conditions per case (6 runs total):");
  lines.push(`  - **before** = ${BEFORE_TREATMENT} (\`--disable-edit-guard\`).`);
  lines.push(`  - **after** = ${AFTER_TREATMENT} (default).`);
  lines.push(`- Run commands: ${plan.commands.length}. Evaluation commands: ${plan.evaluationCommands.length}.`);
  lines.push(
    "- Isolates the **incremental** effect of EDIT_GUARD: PIVOT_CHECK is ON in both conditions; " +
      "`--disable-pivot-check` is never used.",
  );
  lines.push("");

  // --- Why these cases -----------------------------------------------------
  lines.push("## Why these cases");
  lines.push("");
  lines.push(
    "All three were VTRACE losses in the controlled 10-task pilot, and the loss analysis classified " +
      `each as \`${KNOWN_LOSS_CLASSIFICATION}\`: correct file/context, wrong edit. EDIT_GUARD was ` +
      "designed for exactly this failure mode, so these are the natural cases to test its incremental effect.",
  );
  lines.push("");
  lines.push("| instance | repo | known loss | before label | after label | reason included |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const c of plan.cases) {
    lines.push(
      `| ${c.instanceId} | ${c.repo} | ${c.knownLossClassification} | ${c.beforeLabel} | ${c.afterLabel} | ${c.reasonIncluded} |`,
    );
  }
  lines.push("");

  // --- Experimental design -------------------------------------------------
  lines.push("## Experimental design");
  lines.push("");
  lines.push("For each case, run two VTRACE conditions that differ ONLY in the edit guard:");
  lines.push("");
  lines.push(`- **A. ${BEFORE_TREATMENT}** — add \`--disable-edit-guard\` (PIVOT_CHECK still injects).`);
  lines.push(`- **B. ${AFTER_TREATMENT}** — default (EDIT_GUARD rides after PIVOT_CHECK).`);
  lines.push("");
  lines.push("Both conditions share the current normal protocol:");
  lines.push("");
  lines.push("```text");
  lines.push("--protocol vtrace-indexed");
  lines.push("--context-policy force-inject");
  lines.push("--capsule-engine v2");
  lines.push("--capsule-intent debug");
  lines.push("--capsule-budget 8000");
  lines.push("```");
  lines.push("");
  lines.push(
    "`--disable-pivot-check` is NOT used: this experiment measures the effect of EDIT_GUARD on top of " +
      "PIVOT_CHECK, not the effect of PIVOT_CHECK.",
  );
  lines.push("");

  // --- Run commands --------------------------------------------------------
  lines.push("## Run commands");
  lines.push("");
  for (const c of plan.commands) {
    lines.push(`**${c.instanceId} — ${c.condition}** (\`${c.runLabel}\`, ${c.treatment}):`);
    lines.push("");
    lines.push("```bash");
    lines.push(c.command);
    lines.push("```");
    lines.push("");
  }

  // --- Evaluation commands -------------------------------------------------
  lines.push("## Evaluation commands");
  lines.push("");
  lines.push("After the six runs complete, Docker-evaluate every produced label:");
  lines.push("");
  for (const e of plan.evaluationCommands) {
    lines.push(`**${e.instanceId}** (\`${e.runLabel}\`):`);
    lines.push("");
    lines.push("```bash");
    lines.push(e.command);
    lines.push("```");
    lines.push("");
  }

  // --- Expected comparison after completion --------------------------------
  lines.push("## Expected comparison after completion");
  lines.push("");
  lines.push(
    "Once all six runs and evaluations exist, generate an EDIT_GUARD comparison report that measures, " +
      "per case (before vs after):",
  );
  lines.push("");
  lines.push("- resolved before vs after (Docker `resolved`).");
  lines.push("- patch file differences (edited-file set and the diff itself).");
  lines.push("- token/cost deltas (after − before).");
  lines.push("- edit guard metadata: `vtraceEditGuardInjected` / `vtraceEditGuardTextPresent` (after only).");
  lines.push("- whether the known patch defect was fixed (per-case: class scope / empty-array handling / minimal additive validation).");
  lines.push("- whether context inspection stayed stable (pivots inspected, hidden-pivot engagement unchanged).");
  lines.push("");
  lines.push(
    "**None of these are computed here.** They require the six runs and Docker evaluations to exist first; " +
      "this plan only enumerates the work.",
  );
  lines.push("");

  // --- Non-claims ----------------------------------------------------------
  lines.push("## Non-claims");
  lines.push("");
  for (const claim of NON_CLAIMS) lines.push(`- ${claim}`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliConfig {
  readonly resultsDir: string;
  readonly outName: string;
}

export function parseArgs(argv: readonly string[]): CliConfig {
  let resultsDir = RESULTS_REL;
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
  return { resultsDir, outName };
}

async function main(config: CliConfig): Promise<void> {
  const generatedAt = new Date().toISOString();
  const plan = buildPlan(generatedAt);

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(plan));
  await writeFile(jsonPath, renderJson(plan));

  process.stdout.write(
    [
      "Stage 5 EDIT_GUARD 3-loss experiment plan written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Cases: ${plan.cases.length}   Run commands: ${plan.commands.length}   Evaluation commands: ${plan.evaluationCommands.length}`,
      `Labels: ${plan.commands.map((c) => c.runLabel).join(", ")}`,
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
