/**
 * M218 §56 — break the three new guards on purpose, and check the suites notice.
 *
 *   B1 SCRATCH OWNERSHIP VALIDATION  `assertDeletableOwnedPath` stops requiring a
 *                                    strict descendant of the namespace root.
 *   B2 PRE-RUN FREE-SPACE GATE       `capacityGate` never records an issue.
 *   B3 RETRY-RESERVE CEILING         `retryReserveAccounting` never reports exhaustion.
 *
 * Textual substitutions in the real source files, applied with a backup and
 * restored in a `finally`; restoration is re-verified by byte comparison and by a
 * clean re-run of the pure suite AND the real-host suite (the container suite
 * is preserved by its own clean run and is not re-run here).
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m218_guard_break.ts
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const RESULTS_DIR = join(HERE, "results");
const VTRACE_ROOT = join(HERE, "..", "..");
const PURE_EVIDENCE = join(RESULTS_DIR, "stage5_m218_falsification.json");
const HOST_EVIDENCE = join(RESULTS_DIR, "stage5_m218_real_host.json");
const OUTPUT = join(RESULTS_DIR, "stage5_m218_guard_break.json");

interface Breakage {
  readonly id: string;
  readonly guardClass: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly expectedPureFailures: readonly string[];
  readonly expectedHostFailures: readonly string[];
}

const BREAKAGES: readonly Breakage[] = Object.freeze([
  Object.freeze({
    id: "B1_OWNERSHIP_VALIDATION_ACCEPTS_ANY_PATH",
    guardClass: "scratch ownership / path validation",
    file: "m218ScratchLifecycle.ts",
    find: "  if (!canonical.startsWith(`${canonicalRoot}${sep}`)) {\n    throw new ScratchSafetyError(`${target} (canonical ${canonical}) is not a strict descendant of ${canonicalRoot}`);\n  }",
    replace: "  if (false && !canonical.startsWith(`${canonicalRoot}${sep}`)) {\n    throw new ScratchSafetyError(`${target} (canonical ${canonical}) is not a strict descendant of ${canonicalRoot}`);\n  }",
    // With the descendant check gone, a request to clean a path OUTSIDE the
    // namespace is accepted: the unrelated-temp controls see their target
    // deleted (F130, F145, F145B) and the evidence directory — outside the
    // namespace and protected only by this check — is accepted by the cleanup
    // authority (F140). The real-host F169 loses the sentinel directory and
    // its fired list is zeroed.
    expectedPureFailures: ["F130", "F140", "F145", "F145B"],
    expectedHostFailures: ["F169"],
  }),
  Object.freeze({
    id: "B2_CAPACITY_GATE_ALWAYS_PASSES",
    guardClass: "pre-run free-space gate",
    file: "m218ScratchLifecycle.ts",
    find: "  return {\n    at: now(),\n    namespaceRoot: namespace.canonicalRoot,\n    namespaceFilesystem: fs,\n    sharedTmp: shared,",
    replace: "  issues.length = 0;\n  return {\n    at: now(),\n    namespaceRoot: namespace.canonicalRoot,\n    namespaceFilesystem: fs,\n    sharedTmp: shared,",
    expectedPureFailures: ["F137", "F139"],
    // The tmpfs-hosted research namespace is no longer refused.
    expectedHostFailures: ["F171"],
  }),
  Object.freeze({
    id: "B3_RETRY_RESERVE_NEVER_EXHAUSTED",
    guardClass: "retry-reserve ceiling",
    file: "m218SpendAuthority.ts",
    find: "    exhausted: reasons.length > 0,",
    replace: "    exhausted: false,",
    expectedPureFailures: ["F123"],
    expectedHostFailures: [],
  }),
]);

const DELIBERATELY_UNAFFECTED: readonly { readonly id: string; readonly why: string }[] = Object.freeze([
  { id: "F147", why: "every target it tries (/, /tmp, an empty path, $HOME, a relative path, a kernel filesystem, the namespace root itself) is refused by forbiddenRootReason or by the root-identity check, both of which B1 leaves intact; the first guard-break run predicted it would fall and was wrong for exactly this reason" },
  { id: "F146", why: "symlink refusal happens on lstat of the target before the descendant check, and symlinks inside a tree are unlinked by the walker; B1 does not reach either" },
  { id: "F129", why: "the unregistered path lies INSIDE the namespace; B1 removes the outside check, which that control does not exercise" },
  { id: "F138", why: "B2 makes the gate pass, and F138 expects a pass" },
  { id: "F124", why: "a non-preregistered class is refused before the reserve is consulted; B3 cannot reach it" },
  { id: "F125B", why: "P12 reads the binding, not the accounting" },
]);

interface SuiteResult { readonly satisfied: number; readonly controlCount: number; readonly failures: readonly string[] }

function runSuite(script: string, evidence: string): SuiteResult {
  try {
    execFileSync("bun", [join(HERE, script)], { cwd: VTRACE_ROOT, encoding: "utf8", timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    // a failing suite exits non-zero by design; the evidence file is what counts
  }
  const document = JSON.parse(readFileSync(evidence, "utf8")) as SuiteResult;
  return { satisfied: document.satisfied, controlCount: document.controlCount, failures: [...document.failures].sort() };
}

function readClean(evidence: string, label: string): SuiteResult {
  const clean = JSON.parse(readFileSync(evidence, "utf8")) as SuiteResult;
  if (clean.failures.length > 0) throw new Error(`the committed ${label} evidence is not clean (${clean.failures.join(", ")})`);
  return clean;
}

async function main(): Promise<void> {
  const cleanPure = readClean(PURE_EVIDENCE, "pure");
  const cleanHost = readClean(HOST_EVIDENCE, "real-host");
  copyFileSync(PURE_EVIDENCE, `${PURE_EVIDENCE}.clean`);
  copyFileSync(HOST_EVIDENCE, `${HOST_EVIDENCE}.clean`);

  const perBreakage: Record<string, unknown>[] = [];
  const backups = new Map<string, string>();
  const observedPureAll = new Set<string>();
  const observedHostAll = new Set<string>();
  let brokenError: string | null = null;
  try {
    // Each breakage is applied ALONE, so the failure set is attributable to one guard.
    for (const breakage of BREAKAGES) {
      const path = join(HERE, breakage.file);
      const original = readFileSync(path, "utf8");
      backups.set(path, original);
      if (!original.includes(breakage.find)) {
        throw new Error(`${breakage.id}: the guard it breaks is no longer at the text it names in ${breakage.file}`);
      }
      writeFileSync(path, original.replace(breakage.find, breakage.replace));
      let pure: SuiteResult | null = null;
      let host: SuiteResult | null = null;
      try {
        pure = runSuite("run_stage5_m218_falsification.ts", PURE_EVIDENCE);
        host = breakage.expectedHostFailures.length > 0 || breakage.id.startsWith("B1")
          ? runSuite("run_stage5_m218_real_host.ts", HOST_EVIDENCE)
          : null;
      } catch (error) {
        brokenError = (error as Error).message.slice(0, 600);
      } finally {
        writeFileSync(path, original);
      }
      const observedPure = pure?.failures ?? [];
      const observedHost = host?.failures ?? [];
      for (const id of observedPure) observedPureAll.add(id);
      for (const id of observedHost) observedHostAll.add(id);
      perBreakage.push({
        id: breakage.id, guardClass: breakage.guardClass, file: breakage.file,
        expectedPureFailures: breakage.expectedPureFailures, observedPureFailures: observedPure,
        expectedHostFailures: breakage.expectedHostFailures, observedHostFailures: observedHost,
        hostSuiteRun: host !== null,
        missed: [
          ...breakage.expectedPureFailures.filter((id) => !observedPure.includes(id)),
          ...breakage.expectedHostFailures.filter((id) => !observedHost.includes(id)),
        ],
        unexpected: [
          ...observedPure.filter((id) => !breakage.expectedPureFailures.includes(id)),
          ...observedHost.filter((id) => !breakage.expectedHostFailures.includes(id)),
        ],
      });
    }
  } finally {
    for (const [path, original] of backups) writeFileSync(path, original);
    renameSync(`${PURE_EVIDENCE}.clean`, PURE_EVIDENCE);
    renameSync(`${HOST_EVIDENCE}.clean`, HOST_EVIDENCE);
  }

  const restoredIntact = [...backups].every(([path, original]) => readFileSync(path, "utf8") === original);
  const restoredPure = runSuite("run_stage5_m218_falsification.ts", PURE_EVIDENCE);
  const restoredHost = runSuite("run_stage5_m218_real_host.ts", HOST_EVIDENCE);
  const missed = perBreakage.flatMap((entry) => entry.missed as string[]);
  const unexpected = perBreakage.flatMap((entry) => entry.unexpected as string[]);
  const verdict = brokenError === null && missed.length === 0 && unexpected.length === 0
    && restoredPure.failures.length === 0 && restoredHost.failures.length === 0 && restoredIntact
    ? "M218_SUITE_IS_FALSIFYING"
    : "M218_SUITE_FALSIFICATION_NOT_DEMONSTRATED";

  const document = {
    schemaVersion: "stage5.m218.guard-break.v1",
    milestone: "M218",
    generatedAt: new Date().toISOString(),
    breakages: perBreakage,
    pure: { clean: { satisfied: cleanPure.satisfied, controlCount: cleanPure.controlCount }, restored: restoredPure },
    real: { clean: { satisfied: cleanHost.satisfied, controlCount: cleanHost.controlCount }, restored: restoredHost, note: "the real-host suite; the real-container suite is preserved by its own clean run" },
    brokenRunError: brokenError,
    deliberatelyUnaffected: DELIBERATELY_UNAFFECTED,
    observedPureFailuresUnion: [...observedPureAll].sort(),
    observedHostFailuresUnion: [...observedHostAll].sort(),
    unexpectedFailures: unexpected,
    missedFailures: missed,
    sourceFilesRestoredIntact: restoredIntact,
    verdict,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  for (const entry of perBreakage) {
    process.stdout.write(`${entry.id}: pure failing [${(entry.observedPureFailures as string[]).join(", ")}] host failing [${(entry.observedHostFailures as string[]).join(", ")}] missed [${(entry.missed as string[]).join(", ")}] unexpected [${(entry.unexpected as string[]).join(", ")}]\n`);
  }
  process.stdout.write(`restored pure ${restoredPure.satisfied}/${restoredPure.controlCount}; restored host ${restoredHost.satisfied}/${restoredHost.controlCount}; intact ${restoredIntact}\n${verdict}\nwrote ${OUTPUT}\n`);
  if (verdict !== "M218_SUITE_IS_FALSIFYING") process.exitCode = 1;
}

await main();
