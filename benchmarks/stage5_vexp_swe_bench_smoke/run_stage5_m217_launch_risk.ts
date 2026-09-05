/**
 * M217 §18 — the launch-risk artifact.
 *
 * Informational. It prepares the human decision and requests nothing: every
 * number is read from the frozen preregistration constants and recomputed, and
 * it carries no outcome field of any kind.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m217_launch_risk.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RunManifestRow } from "./m214Preregistration";
import { M215_MANIFEST_FILE } from "./m215LaunchExecutor";
import {
  M217_RECOVERY_PATH,
} from "./m217ContinuationSafety";
import { frozenSpendArithmetic, launchRiskStatement, outcomeShapedKeys } from "./m217RetryReserve";

const RESULTS_DIR = join(import.meta.dir, "results");
const JSON_OUTPUT = join(RESULTS_DIR, "stage5_m217_launch_risk.json");
const MD_OUTPUT = join(RESULTS_DIR, "stage5_m217_launch_risk.md");

function main(): void {
  const manifest = JSON.parse(readFileSync(join(RESULTS_DIR, M215_MANIFEST_FILE), "utf8")) as { rows: RunManifestRow[] };
  const arithmetic = frozenSpendArithmetic(manifest.rows.length);
  const statement = launchRiskStatement(manifest.rows.length);
  const leaked = outcomeShapedKeys(statement as unknown as Record<string, unknown>);
  if (leaked.length > 0) throw new Error(`the launch-risk artifact exposes outcome-shaped keys: ${leaked.join(", ")}`);

  const document = {
    ...statement,
    milestone: "M217",
    generatedAt: new Date().toISOString(),
    arithmetic,
    recoveryPath: M217_RECOVERY_PATH,
    doesNotRequest: "authorisation; this artifact is informational and the decision is human",
  };
  writeFileSync(JSON_OUTPUT, `${JSON.stringify(document, null, 2)}\n`);

  const lines = [
    "# M217 — launch-risk statement (informational; no authorisation requested)",
    "",
    "```text",
    `Ceiling awaiting authorisation:               $${arithmetic.frozenCeilingUsd}`,
    `Maximum planned exposure for ${arithmetic.plannedOrdinaryRows} ordinary rows: $${arithmetic.maximumOrdinaryExposureUsd}  (${arithmetic.plannedOrdinaryRows} x $${arithmetic.perRowCapUsd})`,
    `Paid retry reserve:                            $${arithmetic.retryReserveUsd}`,
    `Mathematical maximum (every row retried once): $${arithmetic.mathematicalMaximumUsd}  (refused by the ceiling, never funded)`,
    `Spend authorisation:                           ${statement.spendAuthorizationStatus}`,
    "```",
    "",
    "## Consequence",
    "",
    `> ${statement.consequence}`,
    "",
    "## What the executor does about it",
    "",
    "- Before any attempt, P8 refuses a run whose own cap would breach the ceiling (unchanged from M215).",
    "- Before any attempt, P11 computes current spend + this attempt's cap + every remaining required "
    + "attempt at cap, and records whether fixed-N completion is still guaranteed.",
    `- Frozen retry binding: \`${statement.retryPolicyBinding.policy}\`. ${statement.retryPolicyBinding.reading}`,
    `- ${statement.retryPolicyBinding.notInvented}`,
    "- When the ceiling binds, the cohort halts with `COHORT_HALTED_SPEND_CEILING`; the rows that never "
    + "ran stay PLANNED and the cohort is reported as incomplete. No outcome is fabricated.",
    "- When isolation between rows cannot be proven, the cohort halts with `COHORT_HALTED_ISOLATION_RISK` "
    + "and only the predeclared recovery path can resume it:",
    ...M217_RECOVERY_PATH.map((step, index) => `  ${index + 1}. ${step}`),
    "",
    "## Outcome-blind",
    "",
    "This artifact and every operational status view carry rows completed, rows remaining, spend "
    + "consumed, maximum remaining exposure, isolation state and halt reason. None carries a pass rate, "
    + "a per-arm count, a discordant table or a test statistic before fixed-N finalisation.",
    "",
  ];
  writeFileSync(MD_OUTPUT, `${lines.join("\n")}\n`);
  process.stdout.write(`retry reserve $${arithmetic.retryReserveUsd}; wrote ${JSON_OUTPUT} and ${MD_OUTPUT}\n`);
}

main();
