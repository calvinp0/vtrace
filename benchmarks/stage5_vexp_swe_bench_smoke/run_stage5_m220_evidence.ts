/**
 * M220 §8–§11, §19, §29 — the zero-spend evidence documents the readiness
 * derivation and the report read:
 *
 *   stage5_m220_subscription_audit.json  the real host's subscription-auth audit
 *                                        (verdicts and names, never a secret value),
 *                                        the offline `auth status` proof, the
 *                                        machine-readable quota classification and
 *                                        the auto-update posture
 *   stage5_m220_launch_preflight.json    the production launcher's --preflight on the
 *                                        production cohort directory, verbatim
 *   stage5_m220_frozen_artifacts.json    every frozen artifact's on-disk sha256 against
 *                                        the M219 final HEAD blobs, HEAD:src, and the
 *                                        count of outcome-bearing runs (0)
 *
 * No model, no provider, no frozen task, no container.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m220_evidence.ts
 */

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { M214_A2_FILE, M214_A2_HASH_FILE, M220_FROZEN_A2_HASH, verifyA2Amendment } from "./m220Amendment";
import {
  CLI_AUTH_STATUS_ARGS,
  M220_QUOTA_AVAILABILITY,
  M220_REQUIRED_AUTHORIZATION_TEXT,
  collectSubscriptionAuth,
  parseCliAuthStatus,
  redactedAuthSummary,
} from "./m220SubscriptionAuth";
import { resolveAgentBinary } from "./m216ProductionAdapters";

const RESULTS_DIR = join(import.meta.dir, "results");
const VTRACE_ROOT = join(import.meta.dir, "..", "..");
const RESULTS_REL = "benchmarks/stage5_vexp_swe_bench_smoke/results";
/** M219's final HEAD: the frozen artifacts are compared against its blobs. */
export const M219_FINAL_HEAD = "704446a36ff99a868ddcbbedc3f9c1ef600fbfa7";
export const FROZEN_SRC_TREE = "b3b3e439f10c6c526cafc6001d25dd0e7552ce6d";

const FROZEN_ARTIFACTS: readonly string[] = Object.freeze([
  "stage5_m213_preregistration.json", "stage5_m213_run_manifest.json", "stage5_m213_preregistration_hash.json",
  "stage5_m214_preregistration.json", "stage5_m214_run_manifest.json", "stage5_m214_external_reference.json",
  "stage5_m214_preregistration_hash.json", "stage5_m214_a1_retry_reserve_amendment.json", "stage5_m214_a1_amendment_hash.json",
  "stage5_m219_image_identity.json",
]);

function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}
function git(...args: string[]): string {
  return execFileSync("git", ["-C", VTRACE_ROOT, ...args], { encoding: "utf8" }).trim();
}

function main(): void {
  const now = new Date().toISOString();

  // ── subscription audit ──
  const report = collectSubscriptionAuth({ projectRoot: VTRACE_ROOT, now: () => now });
  const binary = resolveAgentBinary().binary;
  const offline = spawnSync("unshare", ["-r", "-n", binary, ...CLI_AUTH_STATUS_ARGS], { encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", TERM: "dumb" } });
  const offlineStatus = parseCliAuthStatus(`unshare -r -n ${binary} ${CLI_AUTH_STATUS_ARGS.join(" ")}`, offline.stdout);
  const audit = {
    schemaVersion: "stage5.m220.subscription-audit.v1",
    generatedAt: now,
    verdicts: redactedAuthSummary(report),
    authModeVerdict: report.authModeVerdict,
    authModeStrength: report.authModeStrength,
    providerConfirmation: report.providerConfirmation,
    overflowVerdict: report.overflowVerdict,
    launchPermitted: report.launchPermitted,
    issues: report.issues,
    warnings: report.warnings,
    environment: { verdict: report.environment.verdict, checkedNames: report.environment.checkedNames, present: report.environment.present, childEnvironmentPolicy: report.environment.childEnvironmentPolicy },
    settings: report.settings,
    cliAuth: report.cliAuth,
    offlineCliAuth: { exitCode: offline.status, ...offlineStatus, networkNamespaceUnshared: true, verdict: offline.status === 0 && offlineStatus.loggedIn === true ? "ZERO_NETWORK_AUTH_STATUS_VERIFIED" : "OFFLINE_AUTH_STATUS_FAILED" },
    credentials: report.credentials,
    account: report.account,
    autoUpdate: report.autoUpdate,
    runtimeGate: report.runtimeGate,
    quotaAvailability: M220_QUOTA_AVAILABILITY,
    requiredAuthorizationTextForG36: M220_REQUIRED_AUTHORIZATION_TEXT,
    secretsRecorded: false,
  };
  const auditText = JSON.stringify(audit, null, 2);
  if (/sk-ant-|"accessToken":|"refreshToken":|@gmail\.com|@[a-z0-9-]+\.[a-z]{2,}/i.test(auditText)) throw new Error("the subscription audit document carries a secret or an identity value; refusing to write it");
  writeFileSync(join(RESULTS_DIR, "stage5_m220_subscription_audit.json"), `${auditText}\n`);

  // ── launch preflight, verbatim ──
  const preflight = spawnSync("bun", [join(import.meta.dir, "run_stage5_m215_launch.ts"), "--preflight"], { cwd: VTRACE_ROOT, encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
  if (preflight.stdout.trim().length === 0) throw new Error(`the launch preflight printed nothing (exit ${preflight.status}): ${preflight.stderr.slice(-400)}`);
  const preflightDocument = JSON.parse(preflight.stdout) as Record<string, unknown>;
  writeFileSync(join(RESULTS_DIR, "stage5_m220_launch_preflight.json"), `${JSON.stringify({ ...preflightDocument, exitCode: preflight.status, stderrTail: preflight.stderr.slice(-600) }, null, 2)}\n`);

  // ── frozen artifacts and the outcome count ──
  const frozen = FROZEN_ARTIFACTS.map((name) => {
    const disk = sha256(readFileSync(join(RESULTS_DIR, name)));
    const blob = sha256(execFileSync("git", ["-C", VTRACE_ROOT, "show", `${M219_FINAL_HEAD}:${RESULTS_REL}/${name}`]));
    return { name, disk, matchesM219Blob: disk === blob };
  });
  const a2 = JSON.parse(readFileSync(join(RESULTS_DIR, M214_A2_FILE), "utf8")) as Record<string, unknown>;
  const a2Record = JSON.parse(readFileSync(join(RESULTS_DIR, M214_A2_HASH_FILE), "utf8")) as Record<string, unknown>;
  const a2Verification = verifyA2Amendment(a2);
  const cohortLedger = join(RESULTS_DIR, "_m215_cohort", "cohort_ledger.json");
  const outcomeBearingRuns = existsSync(cohortLedger)
    ? ((JSON.parse(readFileSync(cohortLedger, "utf8")) as { entries?: unknown[] }).entries ?? []).length
    : 0;
  const artifacts = {
    schemaVersion: "stage5.m220.frozen-artifacts.v1",
    generatedAt: now,
    m219FinalHead: M219_FINAL_HEAD,
    headWhenGenerated: git("rev-parse", "HEAD"),
    headSrc: git("rev-parse", "HEAD:src"),
    frozenSrcTree: FROZEN_SRC_TREE,
    srcUnchanged: git("rev-parse", "HEAD:src") === FROZEN_SRC_TREE,
    srcDiffVsM219: git("diff", "--stat", M219_FINAL_HEAD, "HEAD", "--", "src"),
    frozen,
    allFrozenIdentical: frozen.every((entry) => entry.matchesM219Blob),
    a2: {
      file: M214_A2_FILE,
      tracked: git("ls-files", "--", `${RESULTS_REL}/${M214_A2_FILE}`).length > 0 && git("ls-files", "--", `${RESULTS_REL}/${M214_A2_HASH_FILE}`).length > 0,
      recordedHash: a2Record.recordedHash,
      recomputed: a2Verification.recomputedHash,
      pinned: M220_FROZEN_A2_HASH,
      verified: a2Verification.verified,
      executableAuthority: a2Verification.executableAuthority.identity,
      scope: a2.scope,
      outcomeBearingRunsBeforeAmendment: a2.outcomeBearingRunsBeforeAmendment,
    },
    outcomeBearingRunsRecorded: outcomeBearingRuns,
    productionCohortLedgerExists: existsSync(cohortLedger),
    providerCalls: 0,
    liveModelSpendUsd: 0,
    frozenBenchmarkTaskLiveAgentRuns: 0,
    containersStartedByM220: 0,
  };
  writeFileSync(join(RESULTS_DIR, "stage5_m220_frozen_artifacts.json"), `${JSON.stringify(artifacts, null, 2)}\n`);

  process.stdout.write(
    `subscription audit: ${report.authModeVerdict} (${report.authModeStrength}); ${report.overflowVerdict}; launchPermitted=${report.launchPermitted}; offline auth status ${audit.offlineCliAuth.verdict}\n`
    + `launch preflight: ${String(preflightDocument.verdict)}; final blocker ${String(preflightDocument.finalBlocker)}; operator prerequisites ${JSON.stringify(preflightDocument.operatorPrerequisitesPending)}\n`
    + `frozen artifacts identical: ${artifacts.allFrozenIdentical}; src unchanged: ${artifacts.srcUnchanged}; A2 verified: ${artifacts.a2.verified} tracked: ${artifacts.a2.tracked}; outcome-bearing runs: ${outcomeBearingRuns}\n`,
  );
}

main();
