/**
 * M220 §60 — break the three new guards on purpose, and check the suite notices.
 *
 *   B1 SUBSCRIPTION AUTH-MODE GUARD  `assessSubscriptionAuth` reports launchPermitted
 *                                    whatever it found.
 *   B2 SESSION PAIR-CAP GUARD        `sessionBoundaryDecision` never sees the cap.
 *   B3 RESUME CURSOR / ORDER GUARD   `auditRowPermitted` stops enforcing the frozen
 *                                    execution order, so a row ahead of the cursor
 *                                    (or a rerun's neighbour) is no longer refused.
 *
 * Textual substitutions in the real source files, applied ALONE, with a backup
 * and restored in a `finally`; restoration is re-verified by byte comparison and
 * by a clean re-run of the M220 suite. Each breakage's expected failure set is
 * predicted by mechanism before the run and compared afterwards; a missed or
 * unexpected failure is recorded and fails the verdict.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m220_guard_break.ts
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const RESULTS_DIR = join(HERE, "results");
const VTRACE_ROOT = join(HERE, "..", "..");
const EVIDENCE = join(RESULTS_DIR, "stage5_m220_falsification.json");
const OUTPUT = join(RESULTS_DIR, "stage5_m220_guard_break.json");

interface Breakage {
  readonly id: string;
  readonly guardClass: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly expectedFailures: readonly string[];
  readonly why: string;
}

const BREAKAGES: readonly Breakage[] = Object.freeze([
  Object.freeze({
    id: "B1_AUTH_MODE_GUARD_ALWAYS_PERMITS",
    guardClass: "subscription auth-mode guard",
    file: "m220SubscriptionAuth.ts",
    find: "    launchPermitted: issues.length === 0 && authMode === \"SUBSCRIPTION_AUTH_MODE_PROVEN\",",
    replace: "    launchPermitted: true,",
    // The pure assessments stop refusing: F200 loses its pure refusal and the
    // real launcher no longer refuses the injected key (the launcher reads
    // launchPermitted), F202 loses every preflight refusal and P15, F203 loses
    // the overflow refusal. F229's SUBSCRIPTION_AUTH gate reads the verdict,
    // not launchPermitted, and stays green by design.
    expectedFailures: ["F200", "F202", "F203"],
    why: "launchPermitted is what the launcher, P15 and the overflow refusal read; the verdict strings stay truthful, which is why only the controls asserting REFUSAL fall",
  }),
  Object.freeze({
    id: "B2_PAIR_CAP_NEVER_BINDS",
    guardClass: "session pair-cap guard",
    file: "m220QuotaSession.ts",
    find: "  if (input.counters.pairsCompleted >= input.bounds.maxPairs) {",
    replace: "  if (false && input.counters.pairsCompleted >= input.bounds.maxPairs) {",
    // Every control that relies on PAIR_CAP_REACHED to stop a synthetic
    // session runs the whole synthetic cohort instead: F204/F205/F212/F228
    // (the cap chain), F210 (a 1-pair session no longer leaves pair 2 for the
    // next one), F211's pure boundary decision, F213 (rows/pairs complete
    // differ), F214's clean-state assertion is unaffected (the window gate
    // pauses before the loop), F216/F217 (the retry sessions run past the
    // cell), F218 (a 10-pair weekly session runs to the limit anyway — the
    // limit sits at row 3, so it still pauses: unaffected), F225/F226/F227
    // (the "run every pair before the target" sessions overrun the target),
    // F209 (the 1-pair session completes the cohort, the end-state assertion
    // changes).
    expectedFailures: ["F204", "F205", "F210", "F212", "F213", "F225", "F226", "F227"],
    why: "the cap is the only thing that ends a HEALTHY synthetic session; without it every capped session runs the whole synthetic cohort. "
      + "First-pass misprediction, corrected by mechanism and recorded: F209, F216, F217 and F228 were predicted to fall and did not (see deliberatelyUnaffected)",
  }),
  Object.freeze({
    id: "B3_FROZEN_ORDER_NOT_ENFORCED",
    guardClass: "resume cursor / frozen-order guard",
    file: "m215LaunchExecutor.ts",
    find: "  if (earlierUnfinished.length > 0) {\n    const first = earlierUnfinished[0]!;",
    replace: "  if (false && earlierUnfinished.length > 0) {\n    const first = earlierUnfinished[0]!;",
    // F206's direct selection of row 40 is no longer refused by P6 (it runs).
    // F210's rerun assertion still holds (the valid-outcome refusal is a
    // different clause), so it stays green. Nothing else selects out of order.
    expectedFailures: ["F206"],
    why: "P6's order clause is the only guard against choosing WHICH row runs next; exactly-once is a separate clause and stays intact",
  }),
]);

const DELIBERATELY_UNAFFECTED: readonly { readonly id: string; readonly why: string }[] = Object.freeze([
  { id: "F229", why: "the launcher's SUBSCRIPTION_AUTH gate reads authModeVerdict and the technical issue list, not launchPermitted; B1 leaves those truthful" },
  { id: "F199", why: "asserts the verdict on the real host, which B1 does not touch" },
  { id: "F214", why: "the window gate pauses before the loop can reach the pair cap, so B2 changes nothing there" },
  { id: "F218", why: "the weekly rejection at row 3 pauses the session before the 10-pair cap would have; B2 is not on the path" },
  { id: "F210", why: "B3 removes the order clause, not the exactly-once clause that refuses a rerun" },
  { id: "F209", why: "first pass predicted a fall under B2; it is GUARD_FIRES and asserts the session-END isolation check (residue blocks, P10 refuses, a new session runs nothing), none of which the cap touches; the uncapped session's different end state adds a fired line rather than removing one" },
  { id: "F216", why: "first pass predicted a fall under B2; its sessions end on the observed hard limit, not the cap, so the retry session runs exactly the interrupted row either way" },
  { id: "F217", why: "first pass predicted a fall under B2; it asserts that no third attempt exists and that the order moves past the unrecoverable cell, both true whether the session stops at one pair or runs on" },
  { id: "F228", why: "first pass predicted a fall under B2; it asserts that no retry slot, split or quota event exists after cap pauses, which an uncapped run of first attempts also satisfies" },
]);

interface SuiteResult { readonly satisfied: number; readonly controlCount: number; readonly failures: readonly string[] }

function runSuite(): SuiteResult {
  try {
    execFileSync("bun", [join(HERE, "run_stage5_m220_falsification.ts")], { cwd: VTRACE_ROOT, encoding: "utf8", timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    // a failing suite exits non-zero by design; the evidence file is what counts
  }
  const document = JSON.parse(readFileSync(EVIDENCE, "utf8")) as SuiteResult;
  return { satisfied: document.satisfied, controlCount: document.controlCount, failures: [...document.failures].sort() };
}

async function main(): Promise<void> {
  const clean = JSON.parse(readFileSync(EVIDENCE, "utf8")) as SuiteResult;
  if (clean.failures.length > 0) throw new Error(`the committed M220 evidence is not clean (${clean.failures.join(", ")})`);
  copyFileSync(EVIDENCE, `${EVIDENCE}.clean`);

  const perBreakage: Record<string, unknown>[] = [];
  const backups = new Map<string, string>();
  let brokenError: string | null = null;
  try {
    for (const breakage of BREAKAGES) {
      const path = join(HERE, breakage.file);
      const original = readFileSync(path, "utf8");
      backups.set(path, original);
      if (!original.includes(breakage.find)) throw new Error(`${breakage.id}: the guard it breaks is no longer at the text it names in ${breakage.file}`);
      writeFileSync(path, original.replace(breakage.find, breakage.replace));
      let observed: readonly string[] = [];
      try {
        observed = runSuite().failures;
      } catch (error) {
        brokenError = (error as Error).message.slice(0, 600);
      } finally {
        writeFileSync(path, original);
      }
      perBreakage.push({
        id: breakage.id, guardClass: breakage.guardClass, file: breakage.file, why: breakage.why,
        expectedFailures: breakage.expectedFailures, observedFailures: observed,
        missed: breakage.expectedFailures.filter((id) => !observed.includes(id)),
        unexpected: observed.filter((id) => !breakage.expectedFailures.includes(id)),
      });
    }
  } finally {
    for (const [path, original] of backups) writeFileSync(path, original);
    renameSync(`${EVIDENCE}.clean`, EVIDENCE);
  }

  const restoredIntact = [...backups].every(([path, original]) => readFileSync(path, "utf8") === original);
  const restored = runSuite();
  const missed = perBreakage.flatMap((entry) => entry.missed as string[]);
  const unexpected = perBreakage.flatMap((entry) => entry.unexpected as string[]);
  const verdict = brokenError === null && missed.length === 0 && unexpected.length === 0 && restored.failures.length === 0 && restoredIntact
    ? "M220_SUITE_IS_FALSIFYING"
    : "M220_SUITE_FALSIFICATION_NOT_DEMONSTRATED";
  const document = {
    schemaVersion: "stage5.m220.guard-break.v1",
    milestone: "M220",
    generatedAt: new Date().toISOString(),
    breakages: perBreakage,
    clean: { satisfied: clean.satisfied, controlCount: clean.controlCount },
    restored,
    brokenRunError: brokenError,
    deliberatelyUnaffected: DELIBERATELY_UNAFFECTED,
    unexpectedFailures: unexpected,
    missedFailures: missed,
    sourceFilesRestoredIntact: restoredIntact,
    verdict,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  for (const entry of perBreakage) {
    process.stdout.write(`${entry.id}: failing [${(entry.observedFailures as string[]).join(", ")}] missed [${(entry.missed as string[]).join(", ")}] unexpected [${(entry.unexpected as string[]).join(", ")}]\n`);
  }
  process.stdout.write(`restored ${restored.satisfied}/${restored.controlCount}; intact ${restoredIntact}\n${verdict}\nwrote ${OUTPUT}\n`);
  if (verdict !== "M220_SUITE_IS_FALSIFYING") process.exitCode = 1;
}

await main();
