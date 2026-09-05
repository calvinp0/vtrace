/**
 * M218 §61, §62 — the amended launch-risk artifact.
 *
 * Informational. It prepares the human decision on the $735 hard ceiling and
 * requests nothing: every number is read from the committed, verified
 * amendment and the frozen constants, and it carries no outcome field.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m218_launch_risk.ts
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { M217_RECOVERY_PATH } from "./m217ContinuationSafety";
import { outcomeShapedKeys } from "./m217RetryReserve";
import { M218_SCRATCH_POLICY } from "./m218ScratchLifecycle";
import { amendedLaunchRisk, loadActiveSpendAuthority } from "./m218SpendAuthority";

const RESULTS_DIR = join(import.meta.dir, "results");
const JSON_OUTPUT = join(RESULTS_DIR, "stage5_m218_launch_risk.json");
const MD_OUTPUT = join(RESULTS_DIR, "stage5_m218_launch_risk.md");

function main(): void {
  const authority = loadActiveSpendAuthority(RESULTS_DIR);
  const statement = amendedLaunchRisk(authority);
  const leaked = outcomeShapedKeys(statement as unknown as Record<string, unknown>);
  if (leaked.length > 0) throw new Error(`the launch-risk artifact exposes outcome-shaped keys: ${leaked.join(", ")}`);

  const document = {
    ...statement,
    milestone: "M218",
    generatedAt: new Date().toISOString(),
    executableAuthority: authority.executableAuthority,
    loadedFrom: authority.loadedFrom,
    recoveryPath: M217_RECOVERY_PATH,
    scratchPolicy: M218_SCRATCH_POLICY,
    doesNotRequest: "authorisation; this artifact is informational and the decision is human",
  };
  writeFileSync(JSON_OUTPUT, `${JSON.stringify(document, null, 2)}\n`);

  const lines = [
    "# M218 — launch-risk statement under M214 + A1 (informational; no authorisation requested)",
    "",
    "```text",
    `Hard ceiling awaiting authorisation:            $${statement.ceilingAwaitingAuthorizationUsd}`,
    `Ordinary exposure (${statement.intendedValidOutcomes} x $${statement.perAttemptCapUsd}):          $${statement.ordinaryExposureUsd}`,
    `Infrastructure-retry reserve (${statement.retryReserveAttempts} x $${statement.perAttemptCapUsd}):   $${statement.retryReserveUsd}`,
    `Intended valid outcomes:                        ${statement.intendedValidOutcomes} (manifest rows ${statement.manifestRows}; retries are attempts on existing rows)`,
    `Amendment:                                      ${statement.amendmentId} ${statement.amendmentHash}`,
    `Executable authority (M214 + A1):               ${statement.executableAuthorityIdentity}`,
    `Spend authorisation:                            ${statement.spendAuthorizationStatus}`,
    "```",
    "",
    "## Consequence",
    "",
    `> ${statement.consequence}`,
    "",
    "## What the executor does about it",
    "",
    "- P12 refuses any COHORT row unless the executable authority M214 + A1 is bound and its lineage matches the verified preregistration, manifest and external reference; M214's $700 authority alone is refused by name.",
    "- P7 requires the operator's authorisation to name the active $735 ceiling; P8 and the cohort loop enforce it.",
    "- P11 admits a retry only when its class is on M214's frozen rerunnable list, a reserve slot remains, the remaining reserve dollars fund it at cap, and the hard ceiling admits one more attempt at cap. Each decision records the retry ordinal, parent row, reason, class, prior spend, new maximum exposure, remaining reserve and remaining global reserve.",
    "- RETRY_RESERVE_EXHAUSTED halts the cohort as `COHORT_HALTED_RETRY_RESERVE_EXHAUSTED`; the operator is never asked at runtime to raise the budget.",
    "- Cleanup of owned scratch is part of continuation safety: a valid result whose scratch cannot be proven gone blocks the next row through the same interlock, and only the predeclared recovery path resumes it:",
    ...M217_RECOVERY_PATH.map((step, index) => `  ${index + 1}. ${step}`),
    "",
    "## Outcome-blind",
    "",
    "This artifact and every operational status view carry rows completed, rows remaining, spend "
    + "consumed, remaining reserve, scratch health, isolation state and halt reason. None carries a pass "
    + "rate, a per-arm count, a discordant table or a test statistic before fixed-N finalisation.",
    "",
  ];
  writeFileSync(MD_OUTPUT, `${lines.join("\n")}\n`);
  process.stdout.write(`hard ceiling $${statement.ceilingAwaitingAuthorizationUsd}; reserve ${statement.retryReserveAttempts} x $${statement.perAttemptCapUsd}; wrote ${JSON_OUTPUT} and ${MD_OUTPUT}\n`);
}

main();
