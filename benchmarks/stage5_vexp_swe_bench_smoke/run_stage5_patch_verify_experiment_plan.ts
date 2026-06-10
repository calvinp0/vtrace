// Stage 5 PATCH_VERIFY 3-loss before/after experiment plan.
//
// SCOPE: planning / reporting ONLY. This emits a fixed before/after experiment
// plan for the three known VTRACE losses where EDIT_GUARD did not improve
// resolution. It isolates PATCH_VERIFY directly: both conditions keep
// PIVOT_CHECK on, both disable EDIT_GUARD, and only PATCH_VERIFY differs.
//   A. before = PIVOT_CHECK only                 (--disable-edit-guard, --disable-patch-verify)
//   B. after  = PIVOT_CHECK + PATCH_VERIFY       (--disable-edit-guard)
//
// It runs NO agents, NO Docker, changes NO retrieval / PIVOT_CHECK /
// EDIT_GUARD / PATCH_VERIFY / telemetry behavior, and reads no raw artifacts.
// It only writes its own Markdown + JSON plan.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type Treatment = "PIVOT_CHECK only" | "PIVOT_CHECK + PATCH_VERIFY";
export type Condition = "before" | "after";

export interface ExperimentCase {
  readonly instanceId: string;
  readonly repo: string;
  readonly knownLossClassification: string;
  readonly beforeLabel: string;
  readonly afterLabel: string;
  readonly beforeTreatment: Treatment;
  readonly afterTreatment: Treatment;
  readonly reasonIncluded: string;
}

export interface RunCommand {
  readonly instanceId: string;
  readonly condition: Condition;
  readonly runLabel: string;
  readonly treatment: Treatment;
  readonly editGuardDisabled: boolean;
  readonly patchVerifyDisabled: boolean;
  readonly command: string;
}

export interface EvaluationCommand {
  readonly instanceId: string;
  readonly runLabel: string;
  readonly command: string;
}

export interface PatchVerifyExperimentPlan {
  readonly generatedAt: string | null;
  readonly cases: readonly ExperimentCase[];
  readonly commands: readonly RunCommand[];
  readonly evaluationCommands: readonly EvaluationCommand[];
}

export const RESULTS_REL = "benchmarks/stage5_vexp_swe_bench_smoke/results";
export const DEFAULT_OUT_NAME = "stage5_patch_verify_3_loss_experiment_plan";
export const VEXP_DIR = "/home/calvin/code/vexp-swe-bench";
export const HARNESS = "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts";
export const EVAL_DATASET = "swebench-verified-full.jsonl";

export const BEFORE_TREATMENT: Treatment = "PIVOT_CHECK only";
export const AFTER_TREATMENT: Treatment = "PIVOT_CHECK + PATCH_VERIFY";
export const KNOWN_LOSS_CLASSIFICATION = "patch_mistake_despite_good_context";

interface LossSeed {
  readonly instanceId: string;
  readonly repo: string;
  readonly knownDefect: string;
  readonly reasonIncluded: string;
}

export const LOSS_SEEDS: readonly LossSeed[] = [
  {
    instanceId: "sympy__sympy-16766",
    repo: "sympy",
    knownDefect: "wrong class scope",
    reasonIncluded:
      "Known unresolved VTRACE loss after EDIT_GUARD; patch defect was new printer methods landing in AbstractPythonCodePrinter instead of PythonCodePrinter.",
  },
  {
    instanceId: "matplotlib__matplotlib-22719",
    repo: "matplotlib",
    knownDefect: "missed empty-array behavior",
    reasonIncluded:
      "Known unresolved VTRACE loss after EDIT_GUARD; patch defect was narrowing a warning guard without adding the needed empty-array early return.",
  },
  {
    instanceId: "psf__requests-5414",
    repo: "psf",
    knownDefect: "broad control-flow rewrite",
    reasonIncluded:
      "Known unresolved VTRACE loss after EDIT_GUARD; patch defect was an always-IDNA-encode restructure instead of minimal additive empty-label validation.",
  },
];

export const NON_CLAIMS: readonly string[] = [
  "This is a 3-case before/after experiment plan, not a statistically powered benchmark.",
  "It isolates PATCH_VERIFY directly: PIVOT_CHECK stays on and EDIT_GUARD stays off in both conditions.",
  "It does not claim PATCH_VERIFY fixes these losses; that is the hypothesis the runs will test.",
  "It does not compare against VEXP or baseline; both conditions are VTRACE-indexed.",
  "It computes no resolved, patch, token, cost, metadata, or behavior deltas here.",
  "It runs no agents and no Docker.",
];

export function shortId(instanceId: string): string {
  const idx = instanceId.indexOf("__");
  return idx >= 0 ? instanceId.slice(idx + 2) : instanceId;
}

export function beforeLabelFor(instanceId: string): string {
  return `eval-patchverify-before-${shortId(instanceId)}`;
}

export function afterLabelFor(instanceId: string): string {
  return `eval-patchverify-after-${shortId(instanceId)}`;
}

export function buildRunCommand(instanceId: string, runLabel: string, disablePatchVerify: boolean): string {
  const lines = [
    `bun ${HARNESS} \\`,
    "  --mode run-protocol \\",
    "  --protocol vtrace-indexed \\",
    `  --vexp-swe-bench-dir ${VEXP_DIR} \\`,
    `  --instances ${instanceId} \\`,
    `  --run-label ${runLabel} \\`,
    "  --show-vtrace-index-log \\",
    "  --reuse-workspace \\",
    "  --context-policy force-inject \\",
    "  --capsule-engine v2 \\",
    "  --capsule-intent debug \\",
    "  --capsule-budget 8000 \\",
    "  --disable-edit-guard \\",
  ];
  if (disablePatchVerify) lines.push("  --disable-patch-verify \\");
  lines.push("  --out benchmarks/stage5_vexp_swe_bench_smoke/results");
  return lines.join("\n");
}

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

export function buildCase(seed: LossSeed): ExperimentCase {
  return {
    instanceId: seed.instanceId,
    repo: seed.repo,
    knownLossClassification: KNOWN_LOSS_CLASSIFICATION,
    beforeLabel: beforeLabelFor(seed.instanceId),
    afterLabel: afterLabelFor(seed.instanceId),
    beforeTreatment: BEFORE_TREATMENT,
    afterTreatment: AFTER_TREATMENT,
    reasonIncluded: `${seed.reasonIncluded} Known defect: ${seed.knownDefect}.`,
  };
}

export function buildPlan(generatedAt: string | null): PatchVerifyExperimentPlan {
  const cases = LOSS_SEEDS.map(buildCase);
  const commands: RunCommand[] = cases.flatMap((c) => [
    {
      instanceId: c.instanceId,
      condition: "before",
      runLabel: c.beforeLabel,
      treatment: c.beforeTreatment,
      editGuardDisabled: true,
      patchVerifyDisabled: true,
      command: buildRunCommand(c.instanceId, c.beforeLabel, true),
    },
    {
      instanceId: c.instanceId,
      condition: "after",
      runLabel: c.afterLabel,
      treatment: c.afterTreatment,
      editGuardDisabled: true,
      patchVerifyDisabled: false,
      command: buildRunCommand(c.instanceId, c.afterLabel, false),
    },
  ]);
  const evaluationCommands: EvaluationCommand[] = commands.map((c) => ({
    instanceId: c.instanceId,
    runLabel: c.runLabel,
    command: buildEvaluationCommand(c.instanceId, c.runLabel),
  }));
  return { generatedAt, cases, commands, evaluationCommands };
}

export function renderJson(plan: PatchVerifyExperimentPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function renderMarkdown(plan: PatchVerifyExperimentPlan): string {
  const lines: string[] = [];
  lines.push("# Stage 5 PATCH_VERIFY 3-loss experiment plan");
  lines.push("");
  if (plan.generatedAt) lines.push(`_Generated: ${plan.generatedAt}_`, "");
  lines.push(
    "_Planning / reporting only. No agents, no Docker, no retrieval / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / telemetry changes. " +
      "Emits exact commands for a fixed before/after experiment; computes nothing until the runs exist._",
  );
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push(`- Cases: ${plan.cases.length} known VTRACE losses (all \`${KNOWN_LOSS_CLASSIFICATION}\`).`);
  lines.push("- Two conditions per case (6 runs total):");
  lines.push(`  - **before** = ${BEFORE_TREATMENT} (\`--disable-edit-guard --disable-patch-verify\`).`);
  lines.push(`  - **after** = ${AFTER_TREATMENT} (\`--disable-edit-guard\`).`);
  lines.push(`- Run commands: ${plan.commands.length}. Evaluation commands: ${plan.evaluationCommands.length}.`);
  lines.push("- PIVOT_CHECK remains enabled in both conditions; `--disable-pivot-check` is never used.");
  lines.push("- EDIT_GUARD remains disabled in both conditions, isolating PATCH_VERIFY directly.");
  lines.push("");

  lines.push("## Why these cases");
  lines.push("");
  lines.push(
    "These are the same three known loss cases used in the EDIT_GUARD experiment. EDIT_GUARD increased cost/tokens and converted none of them, so the clean next test isolates PATCH_VERIFY against PIVOT_CHECK only.",
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

  lines.push("## Experimental design");
  lines.push("");
  lines.push("For each case, run two VTRACE conditions:");
  lines.push("");
  lines.push(`- **A. ${BEFORE_TREATMENT}**: add \`--disable-edit-guard\` and \`--disable-patch-verify\`.`);
  lines.push(`- **B. ${AFTER_TREATMENT}**: add \`--disable-edit-guard\` only.`);
  lines.push("");
  lines.push("Both conditions share:");
  lines.push("");
  lines.push("```text");
  lines.push("--protocol vtrace-indexed");
  lines.push("--context-policy force-inject");
  lines.push("--capsule-engine v2");
  lines.push("--capsule-intent debug");
  lines.push("--capsule-budget 8000");
  lines.push("```");
  lines.push("");
  lines.push("Never use `--disable-pivot-check`: this experiment isolates PATCH_VERIFY, not PIVOT_CHECK.");
  lines.push("");

  lines.push("## Run commands");
  lines.push("");
  for (const c of plan.commands) {
    lines.push(`**${c.instanceId} - ${c.condition}** (\`${c.runLabel}\`, ${c.treatment}):`);
    lines.push("");
    lines.push("```bash");
    lines.push(c.command);
    lines.push("```");
    lines.push("");
  }

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

  lines.push("## Expected comparison after completion");
  lines.push("");
  lines.push("After all six runs and evaluations complete, generate a PATCH_VERIFY comparison report that measures:");
  lines.push("");
  lines.push("- resolved before vs after.");
  lines.push("- patch file differences.");
  lines.push("- token/cost deltas.");
  lines.push("- patch-verify injected/text-present metadata.");
  lines.push("- whether the known patch defect was fixed.");
  lines.push("- whether context inspection stayed stable.");
  lines.push("- whether the final patch mentions or follows the verification checkpoint.");
  lines.push("");
  lines.push("Do not compute these until the runs exist.");
  lines.push("");

  lines.push("## Non-claims");
  lines.push("");
  for (const claim of NON_CLAIMS) lines.push(`- ${claim}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

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
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}.`);
      i += 1;
      return value;
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
  const plan = buildPlan(new Date().toISOString());
  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(plan));
  await writeFile(jsonPath, renderJson(plan));
  process.stdout.write(
    [
      "Stage 5 PATCH_VERIFY 3-loss experiment plan written:",
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
