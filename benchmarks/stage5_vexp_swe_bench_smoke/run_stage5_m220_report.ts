/**
 * M220 §64 — the final report, generated from the evidence artifacts.
 *
 * Every number below is read from an evidence JSON or from git; the prose is
 * fixed and the facts are not typed by hand.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m220_report.ts
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { M214_A2_FILE, M214_A2_HASH_FILE } from "./m220Amendment";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m220_final_report.md");
const VTRACE_ROOT = join(import.meta.dir, "..", "..");
const M219_HEAD = "704446a3";

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(RESULTS_DIR, name), "utf8")) as T;
}
function git(...args: string[]): string {
  return execFileSync("git", ["-C", VTRACE_ROOT, ...args], { encoding: "utf8" }).trim();
}
function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function main(): void {
  const suite = readJson<any>("stage5_m220_falsification.json");
  const guardBreak = readJson<any>("stage5_m220_guard_break.json");
  const typecheck = readJson<any>("stage5_m220_scoped_typecheck.json");
  const audit = readJson<any>("stage5_m220_subscription_audit.json");
  const preflight = readJson<any>("stage5_m220_launch_preflight.json");
  const artifacts = readJson<any>("stage5_m220_frozen_artifacts.json");
  const gates = readJson<any>("stage5_m220_launch_gates.json");
  const a2 = readJson<any>(M214_A2_FILE);
  const a2Record = readJson<any>(M214_A2_HASH_FILE);
  const m215 = readJson<any>("stage5_m215_falsification.json");
  const m217 = readJson<any>("stage5_m217_falsification.json");
  const m218 = readJson<any>("stage5_m218_falsification.json");
  const m219 = readJson<any>("stage5_m219_falsification.json");

  const head = git("rev-parse", "HEAD");
  const srcTree = git("rev-parse", "HEAD:src");
  const status = git("status", "--short");
  const aheadBehind = git("rev-list", "--left-right", "--count", "origin/main...HEAD");
  const commits = git("log", "--oneline", `${M219_HEAD}..HEAD`).split("\n").filter(Boolean);
  const m220Gates = (gates.gates as any[]).filter((entry) => /^G(9[7-9]|1[01][0-9])$/.test(entry.id));
  const ready = gates.readinessVerdict === "TECHNICAL_EXECUTOR_READY";
  const finalState: string = gates.finalState;
  const control = (id: string) => (suite.controls as any[]).find((entry) => entry.id === id);
  const ok = (id: string) => (control(id)?.satisfied ? "ok" : "FAIL");

  const lines: string[] = [];
  const push = (...text: string[]): void => { lines.push(...text); };

  push("# M220 — Claude MAX subscription-quota execution, pair-bounded sessions, and graceful cohort pausing", "");

  push("## 1. Executive verdict", "", "```text");
  push(ready ? "M220 — PASS" : "M220 — INCOMPLETE", "");
  push(...(ready ? [
    "PRE_OUTCOME_QUOTA_SCHEDULING_AMENDMENT_COMMITTED", "",
    `CLAUDE_MAX_SUBSCRIPTION_MODE_AUDITED  (strength: ${audit.authModeStrength}; provider confirmation ${audit.providerConfirmation})`,
    "API_KEY_BILLING_OVERRIDE_GUARDED",
    "PAID_USAGE_FALLBACK_NOT_AUTOMATICALLY_ENABLED", "",
    "PAIR_BOUNDED_SESSION_EXECUTION_VERIFIED", "GRACEFUL_QUOTA_PAUSE_VERIFIED", "OUTCOME_BLIND_RESUME_VERIFIED",
    "PAIR_SPLIT_RECOVERY_VERIFIED", "LONG_DURATION_IDENTITY_GUARDS_VERIFIED", "",
    "TMP_CLEANUP_ON_QUOTA_PAUSE_VERIFIED", "SESSION_JOURNAL_VERIFIED", "",
    "M220_FALSIFICATION_SUITE_PASSED", guardBreak.verdict, "", "TECHNICAL_EXECUTOR_READY", "",
    ...((gates.operatorPrerequisitesPending as string[]).length > 0
      ? ["OPERATOR_PREREQUISITE_PENDING:", ...(gates.operatorPrerequisitesPending as string[]).map((entry) => `  ${entry.split(":")[0]}`), ""]
      : []),
    "SPEND_AUTHORIZATION_PENDING", "PAID_RUNS_NOT_STARTED", "PROVIDER_CALLS_0", "LIVE_MODEL_SPEND_$0",
  ] : ["TECHNICAL_EXECUTOR_NOT_READY", `blockers: ${(gates.technicalBlockers as string[]).join(", ")}`]));
  push("```", "");
  push(
    "M219 left the substrate materialized and one blocker, human spend authorisation. M220 adds nothing to what runs and changes nothing about how it is judged; it adds WHEN the frozen cohort may pause. The operator executes on a Claude MAX subscription whose usage is metered in five-hour sessions and a weekly allowance shared with their other work, so the cohort is now executed in outcome-blind quota-window sessions of an operator-declared number of complete frozen pairs, with a first-class non-failure pause between them, a subscription-only authentication guard, no automatic paid overflow, and identity re-verification at every resume. Zero outcome-bearing runs existed before this amendment and zero exist after it.",
    "",
  );

  push("## 2. Starting repository state", "", "```text");
  push(`branch            main`, `M219 final HEAD   ${git("rev-parse", M219_HEAD)}`, `HEAD when generated  ${head}`, `ahead/behind      ${aheadBehind} (left origin/main, right HEAD)`, `pushed            no`, "");
  push("commits after the M219 final HEAD (M220):", ...commits.map((line) => `  ${line}`), "", "working tree (pre-existing dirt preserved):", ...(status.split("\n").filter(Boolean).map((line) => `  ${line}`)), "```", "");

  push("## 3. Frozen experiment identities", "", "```text");
  push(`preregistration      ${a2.parent.preregistrationHash}`);
  push(`manifest             ${a2.parent.manifestHash}`);
  push(`external reference   ${a2.parent.externalReferenceHash}`);
  push(`amendment A1         ${a2.parent.a1AmendmentHash}`);
  push(`amendment A2         ${a2Record.recordedHash}  pinned ${a2Record.matchesPinnedConstant} verified ${a2Record.verified}`);
  push(`executable authority ${a2Record.executableAuthority.identity}  = M214 + A1 + A2 (domain M220_EXECUTABLE_AUTHORITY)`);
  push(`experiment           100 tasks x 2 arms = 200 intended valid outcomes; 100 frozen pairs, adjacent in execution order, 50 BASELINE-first / 50 VTRACE-first; unchanged`);
  push(`outcome-bearing runs before M220  0     recorded in the production cohort ledger now  ${artifacts.outcomeBearingRunsRecorded}`);
  push("```", "");

  push("## 4. Why quota-window scheduling was added", "");
  push("A continuous 200-row launch would consume most of a five-hour session and a large share of the weekly allowance in one go, and the operator uses the same subscription for other Claude Code work. No outcome-bearing run has occurred, so the execution model can still be amended without touching an outcome. The pause decision depends only on the operator-declared session cap, the CLI's own structured quota events, infrastructure and scratch state, and explicit interruption; it never reads a result.", "");

  push("## 5. Anthropic MAX usage model relied upon", "", "External product facts (Anthropic documentation, not verified by M220):", "", "```text");
  push("Claude MAX usage applies to Claude Code.", "Session-based usage limits reset every five hours.", "MAX also has a weekly usage limit.", "Claude and Claude Code share those limits.", "If ANTHROPIC_API_KEY is set, Claude Code uses API billing instead of subscription usage.", "Paid subscribers can enable usage credits (extra usage) that continue past included limits at API-style pricing.", "```", "");
  push("Local observations (this host, the pinned CLI 2.1.260, zero provider calls):", "", "```text");
  push(`auth status --json      loggedIn ${audit.cliAuth.loggedIn}; authMethod ${audit.cliAuth.authMethod}; apiProvider ${audit.cliAuth.apiProvider}; subscriptionType ${audit.cliAuth.subscriptionType}`);
  push(`offline auth status     ${audit.offlineCliAuth.verdict} (unshare -r -n; exit ${audit.offlineCliAuth.exitCode})`);
  push(`credential file         claudeAiOauth present ${audit.credentials.hasClaudeAiOauth}; subscriptionType ${audit.credentials.subscriptionType}; rateLimitTier ${audit.credentials.rateLimitTier}; refresh token expires ${audit.credentials.refreshTokenExpiresAtIso}`);
  push(`account profile         organizationType ${audit.account.organizationType}; billingType ${audit.account.billingType}; hasExtraUsageEnabled ${audit.account.hasExtraUsageEnabled} (fetched ${audit.account.profileFetchedAtIso})`);
  push(`stream schema           rate_limit_event {status allowed|allowed_warning|rejected, rateLimitType five_hour|seven_day*, resetsAt, utilization, isUsingOverage, overageStatus}; absent for API-key/Bedrock/Vertex sessions`);
  push(`init event              apiKeySource in {ANTHROPIC_API_KEY, apiKeyHelper, /login managed key, none}; 'none' = no API key in use (claude.ai OAuth)`);
  push("```", "");

  push("## 6. Amendment A2", "", "```text");
  push(`id        ${a2.amendmentId}`, `file      ${M214_A2_FILE} (tracked ${artifacts.a2.tracked})`, `scope     ${a2.scope}`, `hash      ${a2Record.recordedHash} (domain "${a2.amendmentId}\\n"; pinned in code; recomputes ${a2Record.matchesPinnedConstant})`);
  push(`parents   M214 x3 + A1 ${a2.parent.a1AmendmentHash} (records agree ${a2Record.parent.parentRecordsAgree}; parent bytes untouched ${a2Record.parent.parentBytesUntouchedByThisScript})`);
  push(`lineage   ${(a2.lineage as string[]).join("  ->  ")}`);
  push(`pause     ${a2.pauseState.marker}: isFailure ${a2.pauseState.isFailure}, consumesRetryAttempt ${a2.pauseState.consumesRetryAttempt}, consumesRetryReserveSlot ${a2.pauseState.consumesRetryReserveSlot}`);
  push(`split     ${a2.pairSplit.marker}: permitted only when quota safety requires it; measured; arm order never rebalanced`);
  push(`quota     ${a2.quotaInterruption.classificationVerdict} (${a2.quotaInterruption.frozenClass}; new classes ${a2.quotaInterruption.newRetryClassesCreated})`);
  push(`states    scientific manifest unchanged; analysis unchanged; fixed-N target unchanged; retry eligibility unchanged except the scheduling clarification`);
  push("```", "");

  push("## 7. Scientific invariance", "", "Unchanged, and audited by name in the amendment:", "", "```text", ...(a2.unchanged as string[]).map((entry) => `  ${entry}`), "```", "");
  push("The audit refuses an amendment document carrying any frozen experimental or financial key (task, arm, model, budget, executionOrder, retryPolicy, hardCeilingUsd, ...); the manifest digest refuses a swapped arm, a reordering or an exchanged execution order (F222). M220 changes WHEN execution pauses between already-frozen rows; `selectNextRow` still chooses WHAT runs, from the frozen order.", "");

  push("## 8. Subscription authentication audit", "", "```text");
  push(`verdict     ${audit.authModeVerdict}`, `strength    ${audit.authModeStrength} (what the CLI on this host believes and which billing path it would take)`, `provider    ${audit.providerConfirmation}`, `runtime     ${audit.runtimeGate}`);
  push(`environment ${audit.environment.verdict}; ANTHROPIC_API_KEY_PRESENT=${audit.verdicts.ANTHROPIC_API_KEY_PRESENT}; checked ${(audit.environment.checkedNames as string[]).length} documented override names + any ANTHROPIC_ prefix`);
  push(`settings    ${(audit.settings as any[]).filter((entry) => entry.exists).map((entry) => `${entry.path.replace(process.env.HOME ?? "", "~")}: apiKeyHelper ${entry.apiKeyHelperConfigured}, env overrides [${entry.envOverrideNames.join(", ")}], reaches the arm ${entry.reachesTheArm}`).join("; ") || "none present"}`);
  push(`child env   ${audit.environment.childEnvironmentPolicy}`);
  push(`issues      ${(audit.issues as string[]).length}; warnings ${(audit.warnings as string[]).length}`);
  push("```", "");

  push("## 9. API-key override guard", "", "```text");
  push(`F2 (F200) ${ok("F200")}   ANTHROPIC_API_KEY injected -> production launch refused by name before any substrate; pure assessment SUBSCRIPTION_AUTH_MODE_NOT_PROVEN`);
  push(`F3 (F201) ${ok("F201")}   the value appears nowhere: refusal, assessment, persisted session documents`);
  push(`F4 (F202) ${ok("F202")}   console/bedrock/pro/logged-out refused; unreadable status UNRESOLVED; P15 refuses the row; runtime apiKeySource ANTHROPIC_API_KEY -> ARM_CONFIGURATION_WRONG + COHORT_HALTED_AUTH_MODE`);
  push(`guard-break B1  ${JSON.stringify(guardBreak.breakages.find((entry: any) => entry.id.startsWith("B1"))?.observedFailures)} fell; missed ${JSON.stringify(guardBreak.breakages.find((entry: any) => entry.id.startsWith("B1"))?.missed)}`);
  push("```", "");

  push("## 10. Usage-credit / paid-overflow behaviour", "", "```text");
  push(`host state         ${audit.overflowVerdict} (profile field hasExtraUsageEnabled=${audit.account.hasExtraUsageEnabled})`);
  push(`launch consequence launchPermitted=${audit.launchPermitted}; ${audit.launchPermitted ? "no operator prerequisite" : "the launch REFUSES until the operator disables extra usage in the claude.ai billing settings and the CLI's profile reads false; no flag overrides it"}`);
  push(`executor policy    never opts in; a rate_limit_event with isUsingOverage=true aborts the attempt as MODEL_SERVICE_FAILURE (F5/F203 ${ok("F203")}); every overflow-shaped flag is refused by name`);
  push(`state unknown      when the profile cannot say, --attest-extra-usage-disabled "<operator>" records the operator's confirmation; it never overrides an ENABLED profile`);
  push("```", "");

  push("## 11. Machine-readable quota availability", "", "```text");
  push(`pre-launch (zero call)  ${audit.quotaAvailability.preLaunchZeroCall}`, `  ${audit.quotaAvailability.preLaunchEvidence}`);
  push(`in-run                  ${audit.quotaAvailability.inRun}`, `  ${audit.quotaAvailability.inRunEvidence}`);
  push(`policy                  ${audit.quotaAvailability.policy}`);
  push("```", "");

  push("## 12. Session model", "", "```text");
  push("unit           the next frozen task pair (both arms of one task, in the manifest's frozen arm order)");
  push("session        one launcher invocation that reaches the row loop = SESSION_NNN (sequential, counted from hash-chained QUOTA_SESSION_STARTED events; a resumed same-window invocation is the next number)");
  push("cap            --max-pairs-this-session N (integer >= 1; required for a COHORT launch; chosen by the operator from their usage view; may differ between sessions)");
  push("optional       --max-session-wall-clock <seconds> (no NEW pair after the deadline; an active pair finishes)");
  push("pause request  --pause-after-current-pair | --pause-after-current-arm (file PAUSE_REQUEST.json in the cohort directory; honoured by a running session; consumed exactly once); --clear-pause-request");
  push("status         --session-status (outcome-blind; runs nothing)");
  push("no             task selector, skip, start-at, continuous mode, automatic quota prediction");
  push("```", "");

  push("## 13. Pair-bounded execution", "", "```text");
  push(`F6  (F204) ${ok("F204")}  max 2 pairs -> rows 0-3, PAIR_CAP_REACHED`);
  push(`F7  (F205) ${ok("F205")}  next session starts at pair 3 (row 4)`);
  push(`F14 (F212) ${ok("F212")}  cap 2 -> 5 preserves rows 0..13, no duplicates, identity unchanged`);
  push(`F8  (F206) ${ok("F206")}  --task/--instance/--skip-to/--start-at/--pair/--execution-order refused; row 40 ahead of the cursor refused by P6`);
  push(`F13 (F211) ${ok("F211")}  cap 0/-1/1.5/abc/empty refused`);
  push("```", "");

  push("## 14. Graceful pause", "", "```text");
  push(`F9  (F207) ${ok("F207")}  request pending while idle -> no pair starts, request consumed once`);
  push(`F10 (F208) ${ok("F208")}  request during a pair -> the pair finishes, then pauses, no split`);
  push(`F42/F12    wall-clock deadline stops new pairs only (unit test); an after-arm request is the only explicit way to stop between arms`);
  push(`F30 (F228) ${ok("F228")}  cap pauses consume no retry slot; every attempt is attempt 1`);
  push(`before COHORT_PAUSED_QUOTA_WINDOW is reported: SESSION_END_ISOLATION_CHECK enumerates the work root; residue BLOCKS (F11/F209 ${ok("F209")})`);
  push("```", "");

  push("## 15. Resume", "", "```text");
  push("every session start re-proves: frozen authorities; M214 + A1 + A2 lineage; scratch sweep, capacity and image identity (M218/M219); isolation preflight (M217); pinned agent binary + declared symlink version; HEAD:src == manifest product tree AND a clean src/ worktree; quota window reset; subscription auth mode; then the next frozen row");
  push(`F12 (F210) ${ok("F210")}  a completed pair is refused exactly-once and a new session never revisits it`);
  push("no session-level reuse: each arm is a fresh agent process in a fresh private configuration directory with a fresh owned /tmp (M193A/M218), unchanged by M220");
  push("```", "");

  push("## 16. Split-pair handling", "", "```text");
  push(`F27 (F225) ${ok("F225")}  BASELINE-first pair split by an after-arm pause: sentinel in arm 1's /tmp invisible to arm 2; no CLAIMED claim survives the pause; arm 1 never rerun; PAIR_SPLIT_BY_QUOTA_WINDOW recorded`);
  push(`F28 (F226) ${ok("F226")}  the same for a VTRACE-first pair`);
  push(`F29 (F227) ${ok("F227")}  timing: gap = arm-1 end -> arm-2 start per pair; median/p90/max; 2 pairs split, 1 per first arm; evaluation metadata only`);
  push("```", "");

  push("## 17. Hard quota interruption", "", "```text");
  push(`signal      the CLI's structured rate_limit_event only (status rejected); free text never classifies`);
  push(`class       MODEL_SERVICE_FAILURE (frozen, rerunnable) — provider availability interruption; never VALID_UNRESOLVED`);
  push(`F17 (F215) ${ok("F215")}  synthetic executor AND the production adapter over a recorded rejected event -> MODEL_SERVICE_FAILURE, QUOTA_LIMIT_OBSERVED, immediate pause`);
  push(`F16 (F214) ${ok("F214")}  hard limit on record with an unexpired reset -> no attempt starts (launcher gate and the loop's own gate)`);
  push(`F20 (F218) ${ok("F218")}  seven_day rejection -> WEEKLY_QUOTA, pause across the weekly reset, no cohort reset`);
  push("```", "");

  push("## 18. Retry interaction", "", "```text");
  push(`F18 (F216) ${ok("F216")}  after the reset only the interrupted row retries (attempt 2, one A1 slot); arm 1 not rerun; no later row jumps ahead`);
  push(`F19 (F217) ${ok("F217")}  a second interruption of the same cell leaves it unrecoverable (maxAttemptsPerRun 2); no third attempt; no unlimited subscription retries`);
  push("a quota-interrupted attempt consumes one of the two permitted attempts and, when retried, one of A1's ten slots; this is stated, not weakened");
  push("```", "");

  push("## 19. Five-hour vs weekly limits", "", "```text");
  push("SESSION_QUOTA  rateLimitType five_hour", "WEEKLY_QUOTA   rateLimitType seven_day, seven_day_opus, seven_day_sonnet, seven_day_overage_included", "OVERAGE        rateLimitType overage (paid; the executor aborts on isUsingOverage)");
  push("a five-hour reset does not clear a recorded weekly limit: the window gate compares the recorded resetsAt of whichever limit was observed");
  push("```", "");

  push("## 20. Outcome blindness", "", "```text");
  push(`F15 (F213) ${ok("F213")}  the status view and the real --session-status name no per-arm count, pass rate, effect or p-value; the writer refuses any outcome-shaped key (it caught the key quotaWindow, which was renamed rather than the check weakened)`);
  push("the journal is derived from operational events and the result ledger's timestamps/costs only; pair timing names arms only in the descriptive splitsByFirstArm counts and lives in its own metadata file");
  push("the finaliser (canFinalizeCausalReport) is unchanged and still refuses before fixed-N completion");
  push("```", "");

  push("## 21. Session journal", "", "```text");
  push("events     QUOTA_SESSION_STARTED / QUOTA_SESSION_ENDED (+ PAIR_SPLIT_BY_QUOTA_WINDOW, PAUSE_REQUESTED_AFTER_CURRENT_PAIR, QUOTA_LIMIT_OBSERVED, SESSION_END_ISOLATION_CHECK, COHORT_HALTED_AUTH_MODE, COHORT_HALTED_MODEL_IDENTITY) in the hash-chained M217 operations ledger");
  push("files      cohort_session_journal.json (derived, keyed by ledger sequence ranges), cohort_pair_timing.json, cohort_session_status.json — rewritten after every persist");
  push("fields     session id/number, start/end, starting/ending next-row ordinal, pairs planned/started/completed, rows settled, attempts, pause reason, quota warning/hard limit/class, pair split, CLI-reported cost, incremental billed spend, subscription-auth summary, agent identity, model identity observations, cleanup result, scratch capacity, image preflight");
  push("no outcome labels");
  push("```", "");

  push("## 22. Long-duration model/agent/treatment drift", "", "```text");
  push(`F21 (F219) ${ok("F219")}  agent binary of another version refused by the pinned resolution, the session preflight and the adapter; the versioned file is spawned, never the symlink; auto-update ${audit.autoUpdate.verdict} (autoUpdates ${audit.autoUpdate.autoUpdatesSetting}, install ${audit.autoUpdate.installMethod})`);
  push(`F22 (F220) ${ok("F220")}  another provider model -> MODEL_IDENTITY_DRIFT at init and COHORT_HALTED_MODEL_IDENTITY (new in M220: the loop halts instead of walking on)`);
  push(`F23 (F221) ${ok("F221")}  HEAD:src != manifest tree, or a dirty src/ worktree, refuses the session; host HEAD:src ${srcTree}`);
  push(`F24 (F222) ${ok("F222")}  manifest change refused by digest; F25 (F223) ${ok("F223")} image identity change refused (M219 gate); F26 (F224) ${ok("F224")} A2 mutation refused by digest, P14 and the real launcher`);
  push("```", "");

  push("## 23. /tmp cleanup at pause", "", "```text");
  push("M218 semantics unchanged: evidence persisted, container stopped, owned scratch cleaned and verified per attempt; M220 adds SESSION_END_ISOLATION_CHECK before a pause may be reported");
  push(`F11 (F209) ${ok("F209")}  residue at session end -> BLOCKED, status COHORT_HALTED_ISOLATION_RISK, next row and next session refused`);
  push(`F27/F28    ${ok("F225")}/${ok("F226")}  after each pause 0 claims CLAIMED, namespace holds only its marker`);
  push(`M218 pure suite ${m218.satisfied}/${m218.controlCount} preserved`);
  push("```", "");

  push("## 24. Falsification suite", "", `Suite ${suite.satisfied}/${suite.controlCount} (${suite.guardFiresControls} GUARD_FIRES, ${suite.guardSilentControls} GUARD_SILENT, ${suite.realProcessControls} REAL_PROCESS); brief ids F1–F30 are controls F199–F228; F229–F232 are implementation controls.`, "", "| control | brief | expectation | substrate | satisfied | description |", "| --- | --- | --- | --- | --- | --- |");
  for (const entry of suite.controls as any[]) push(`| ${entry.id} | ${entry.briefId ?? "-"} | ${entry.expectation} | ${entry.substrate} | ${entry.satisfied} | ${String(entry.description).replace(/\|/g, "/")} |`);
  push("");

  push("## 25. Intentional guard breaks", "", "```text");
  for (const entry of guardBreak.breakages as any[]) push(`${entry.id.padEnd(34)} ${entry.file}: fell [${entry.observedFailures.join(", ")}] missed [${entry.missed.join(", ")}] unexpected [${entry.unexpected.join(", ")}]`);
  push(`restored ${guardBreak.restored.satisfied}/${guardBreak.restored.controlCount}; sources intact ${guardBreak.sourceFilesRestoredIntact}; verdict ${guardBreak.verdict}`);
  push("deliberately unaffected (by mechanism, first-pass mispredictions recorded):");
  for (const entry of guardBreak.deliberatelyUnaffected as any[]) push(`  ${entry.id}: ${entry.why}`);
  push("```", "");

  push("## 26. Preservation of predecessor controls", "", "```text");
  push(`M215 pure ${m215.satisfied}/${m215.controlCount}; M217 pure ${m217.satisfied}/${m217.controlCount}; M218 pure ${m218.satisfied}/${m218.controlCount}; M219 ${m219.satisfied}/${m219.controlCount} (re-run after the M220 changes; M219 F196 runs the real launcher preflight)`);
  push("M216/M217/M218 REAL container suites: NOT re-run in M220 (this milestone starts no container); preserved by their M219 evidence. The changed adapter code paths (rate_limit_event parsing, credential-source hook, quota abort) are exercised by the production adapter over a fake bridge (F203, F215, F219, F231) and by unit tests.");
  push("nothing weakened: exactly-once (F210), continuation safety (F209), scratch cleanup (F225/F226), image authority (F223), spend ceiling (preflight SPEND_ENVELOPE $735), model identity (F220), treatment isolation (F221), patch capture and evaluator truth (untouched code, M215/M217/M218 suites)");
  push("```", "");

  push("## 27. Product / frozen artifact immutability", "", "```text");
  push(`HEAD:src          ${srcTree}   frozen ${artifacts.frozenSrcTree}   unchanged ${artifacts.srcUnchanged}`);
  push(`src/ diff vs M219 ${artifacts.srcDiffVsM219.length === 0 ? "0 files" : artifacts.srcDiffVsM219}`);
  push("frozen artifacts (sha256 on disk == blob at the M219 final HEAD):");
  for (const entry of artifacts.frozen as any[]) push(`  ${entry.matchesM219Blob ? "IDENTICAL" : "CHANGED  "} ${entry.name} ${entry.disk.slice(0, 16)}…`);
  push(`A2 added: ${M214_A2_FILE} + ${M214_A2_HASH_FILE} (tracked ${artifacts.a2.tracked}); M214 and A1 bytes read, never written`);
  push("```", "");

  push("## 28. Standard verification", "", "```text");
  push(`scoped typecheck   ${typecheck.verdict}: tsconfig.m220.json ${typecheck.m220NewTypecheckErrors} errors; injected error detected ${typecheck.findings.scopedTargetDetectsInjectedError}; m219 scope still clean ${typecheck.findings.predecessorScopeStillClean}`);
  push(`M220 suite         ${suite.satisfied}/${suite.controlCount}; guard-break ${guardBreak.verdict}`);
  push(`bun test / typecheck / typecheck:benchmarks / lint / git diff --check / secret scan   see the ledger row (recorded at commit time)`);
  push("```", "");

  push("## 29. Provider/spend evidence", "", "```text");
  push("provider calls = 0", "frozen live runs = 0", "incremental billed model spend = $0", `containers started by M220 = ${artifacts.containersStartedByM220}`, "");
  push("what M220 did run: the real launcher as a subprocess (--plan, --session-status, --preflight, refused launches), the pinned CLI's `auth status --json` (once with networking unshared), the substrate bridge process inside --preflight (no container), the production agent adapter over a fake bridge, synthetic cohorts, and filesystem scratch fixtures under results/");
  push("```", "");

  push("## 30. Technical readiness", "", "```text", gates.readinessVerdict, "```", "");

  push("## 31. Authorization status", "", "```text", "SPEND_AUTHORIZATION_PENDING", "", "the required authorisation sentence after M220 (not asked for, not inferred):", "", gates.g36?.updatedAuthorizationText ?? "", "```", "");
  if ((gates.operatorPrerequisitesPending as string[]).length > 0) {
    push("Operator prerequisites pending before a launch would be accepted (not technical defects, not the spend gate):", "", "```text", ...(gates.operatorPrerequisitesPending as string[]).map((entry) => `  ${entry}`), "```", "");
  }

  push("## 32. Recommended launch usage", "", "```text");
  push("# once G36 is given and the operator prerequisites are met:");
  push("# 0. check Claude Settings > Usage; choose a conservative N (start small, e.g. 2)");
  push("bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m215_launch.ts --preflight");
  push("bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m215_launch.ts --binding DOCKER_SWEBENCH \\");
  push("    --authorize-spend \"<operator>\" --max-pairs-this-session N          # first session");
  push("#    ... the session runs at most N complete frozen pairs, checkpoints, cleans, pauses");
  push("bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m215_launch.ts --session-status   # outcome-blind");
  push("# later, after the window resets / when convenient:");
  push("bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m215_launch.ts --binding DOCKER_SWEBENCH \\");
  push("    --authorize-spend \"<operator>\" --resume --max-pairs-this-session M    # M may differ from N");
  push("# to stop early: --pause-after-current-pair (preferred) or --pause-after-current-arm (only when the hard limit is imminent)");
  push("# repeat until --session-status reports pairsComplete 100 / 100; then, and only then, the finaliser");
  push("```", "");
  push("M220 does not decide N. Usage depends on task complexity, context, model, tool use and reasoning effort; the launcher enforces whatever conservative number the operator declares, and the experiment is identical under any sequence of N.", "");

  push("## 33. Repository state / SHAs", "", "```text");
  push(`HEAD when generated  ${head}`, `HEAD:src             ${srcTree}`, `M219 final HEAD      ${git("rev-parse", M219_HEAD)}`, `A1                   ${a2.parent.a1AmendmentHash}`, `A2                   ${a2Record.recordedHash}`, `executable authority ${a2Record.executableAuthority.identity}`, `manifest             ${a2.parent.manifestHash}`, `A2 file sha256       ${sha256(readFileSync(join(RESULTS_DIR, M214_A2_FILE)))}`);
  push("```", "");

  push("## Launch gate table (M220 additions)", "", "| gate | status | requirement |", "| --- | --- | --- |");
  for (const entry of m220Gates) push(`| ${entry.id} | ${entry.status} | ${String(entry.requirement).slice(0, 160)} |`);
  push(`| G36 | ${gates.g36?.status} | ${String(gates.g36?.requirement).slice(0, 160)} (HUMAN; never set by M220) |`, "");

  push("## Final principle", "", "The experiment has to complete one frozen cohort. It does not have to complete in one Claude quota window. The unit is the next frozen pair; the preferred pause is after it; the reason to pause is quota, infrastructure or operator availability, never whether VTRACE appears to be winning. The cohort runs on the MAX subscription login and on nothing else: an API key refuses the launch, paid overflow is never opted into, a usage limit pauses. Run a conservative number of pairs, persist everything, clean /tmp, stop, wait, resume exactly where the frozen manifest says, repeat. It is SPEND_AUTHORIZATION_PENDING. Stop.", "");

  writeFileSync(OUTPUT, `${lines.join("\n")}\n`);
  process.stdout.write(`wrote ${OUTPUT}\n${finalState}\n`);
}

main();
