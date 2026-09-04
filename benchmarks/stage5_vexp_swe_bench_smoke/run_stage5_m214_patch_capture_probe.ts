/**
 * M214 §17, §28 — reproduce the patch-capture leak, then show it is gone.
 *
 * M213 found that `vexp-swe-bench`'s `capturePatch` excludes `.vexp` and does
 * not exclude `.vtrace`, and measured a 105,321-byte "patch" of index metadata
 * on a run that changed no source. That finding is inherited, not trusted: this
 * probe builds a real Git repository, runs a real VTRACE index over it, and
 * runs BOTH capture mechanisms against the same working tree.
 *
 * Two cases, because one alone proves the wrong thing:
 *
 *   NO_SOURCE_CHANGE   the agent changed nothing. The vendor mechanism must
 *                      produce a non-empty patch (the defect) and the derived
 *                      mechanism must produce an empty one (the repair).
 *   SOURCE_CHANGE      the agent changed one file. The derived mechanism must
 *                      produce exactly that file — a capture that excludes
 *                      everything would pass the first case and be useless.
 *
 * And two INITIALISATION ROUTES, because the first run of this probe found a
 * state nobody had written down: `vtrace init` appends `/.vtrace/` to
 * `.git/info/exclude`, which hides the directory from `git add -A` and makes
 * the vendor's defect invisible. `vtrace index` alone does not write that
 * entry. So whether the competitor's harness would have leaked VTRACE metadata
 * depended on which entry point happened to initialise the treatment — exactly
 * the kind of accident that must not decide a benchmark's fairness. Both routes
 * are measured, and the derived mechanism must hold under both.
 *
 * Deterministic. No model, no network, no container, no benchmark task. The
 * only thing spawned is `git` and the local `vtrace` CLI.
 *
 * Usage:
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m214_patch_capture_probe.ts [--out <dir>]
 */

import { execFile as execFileCallback } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  auditCapturedPatchPaths,
  auditDerivedExclusionCoversTreatmentState,
  auditHardcodedExclusionList,
  auditLifecycleOrder,
  classifyExclusionRoute,
  derivePatchCaptureExclusions,
  patchCapturePathspec,
} from "./m214TreatmentLifecycle";

const execFile = promisify(execFileCallback);
const VTRACE_ROOT = path.resolve(import.meta.dir, "..", "..");
const DEFAULT_OUT = path.join(import.meta.dir, "results");

/** The vendor harness's real pathspec, transcribed from its shipped JavaScript. */
const VENDOR_HARDCODED_EXCLUSIONS = [".vexp", ".claude", ".bench-mcp-config.json"];

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = 300_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFile(command, [...args], {
      cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

const git = (args: readonly string[], cwd: string) => run("git", args, cwd);

/** The tracked-source identity: every tracked path and its blob id. */
async function trackedSourceDigest(cwd: string): Promise<string> {
  const { stdout } = await git(["ls-files", "-s"], cwd);
  return new Bun.CryptoHasher("sha256").update(stdout).digest("hex");
}

/** What `git ls-files --others --exclude-standard` reports — the snapshot's own view. */
async function untrackedPaths(cwd: string): Promise<string[]> {
  const { stdout } = await git(
    ["ls-files", "--others", "--exclude-standard", "--directory"],
    cwd,
  );
  return stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/** What is untracked on disk, ignoring every exclude file. The wider view. */
async function untrackedPathsIgnoringExcludes(cwd: string): Promise<string[]> {
  const { stdout } = await git(["ls-files", "--others", "--directory"], cwd);
  return stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/** The `.git/info/exclude` entries the treatment wrote for itself, if any. */
async function repositoryLocalExcludes(cwd: string): Promise<string[]> {
  const { stdout } = await run(
    "sh",
    ["-c", "grep -v '^#' .git/info/exclude 2>/dev/null | grep -v '^$' || true"],
    cwd,
  );
  return stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

interface CaptureResult {
  readonly mechanism: string;
  readonly bytes: number;
  readonly lines: number;
  readonly paths: readonly string[];
}

function diffPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match !== null) paths.add(match[2]!);
  }
  return [...paths].sort();
}

function summarize(mechanism: string, patch: string): CaptureResult {
  return {
    mechanism,
    bytes: Buffer.byteLength(patch, "utf8"),
    lines: patch.length === 0 ? 0 : patch.split("\n").length,
    paths: diffPaths(patch),
  };
}

/**
 * The vendor mechanism, run for real.
 *
 * It stages, so it must un-stage afterwards; that mutation of the subject is
 * itself part of what M193C replaced, and is why the derived mechanism below
 * never touches the index.
 */
async function captureVendorStyle(cwd: string): Promise<CaptureResult> {
  await git([
    "add", "-A", "--", ".",
    ...VENDOR_HARDCODED_EXCLUSIONS.map((entry) => `:(exclude)${entry}`),
  ], cwd);
  const { stdout } = await git(["diff", "--cached"], cwd);
  await git(["reset"], cwd);
  return summarize("vendor_capturePatch_hardcoded_exclusions", stdout);
}

/**
 * The M214 mechanism: `git diff HEAD` plus an untracked lane, both restricted
 * by a pathspec DERIVED from the pre-agent untracked snapshot. Non-mutating —
 * it never stages and never resets.
 */
async function captureDerived(cwd: string, preAgentUntracked: readonly string[]): Promise<CaptureResult> {
  const exclusions = derivePatchCaptureExclusions(preAgentUntracked)
    .map((entry) => `:(exclude)${entry}`);

  const tracked = await git(
    ["-c", "core.fileMode=false", "diff", "--no-renames", "HEAD", "--", ".", ...exclusions],
    cwd,
  );
  const others = await git(
    ["ls-files", "--others", "--exclude-standard", "--", ".", ...exclusions],
    cwd,
  );

  let patch = tracked.stdout;
  for (const file of others.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
    const added = await git(
      ["-c", "core.fileMode=false", "diff", "--no-index", "--", "/dev/null", file],
      cwd,
    );
    patch += added.stdout;
  }
  return summarize("m214_derived_pre_agent_snapshot_exclusions", patch);
}


interface RouteResult {
  readonly route: string;
  readonly treatmentInitialised: boolean;
  readonly initExitCode: number | null;
  readonly indexExitCode: number;
  readonly indexBytesOnDisk: number;
  readonly repositoryLocalExcludes: readonly string[];
  readonly trackedSourceDigestBeforeTreatment: string;
  readonly trackedSourceDigestAfterTreatment: string;
  readonly sourceUnchangedByTreatment: boolean;
  readonly untrackedBeforeTreatment: readonly string[];
  readonly preAgentUntrackedSnapshot: readonly string[];
  readonly untrackedIgnoringExcludes: readonly string[];
  readonly treatmentStateOnDisk: readonly string[];
  readonly exclusionRoutePerTreatmentPath: Readonly<Record<string, string>>;
  readonly derivedExclusions: readonly string[];
  readonly derivedPathspec: string;
  readonly noSourceChange: { readonly vendor: CaptureResult; readonly derived: CaptureResult };
  readonly sourceChange: { readonly vendor: CaptureResult; readonly derived: CaptureResult };
  readonly vendorLeaksTreatmentState: boolean;
  readonly derivedProducesEmptyPatchOnNoSourceChange: boolean;
  readonly derivedCapturesExactlyTheAgentEdit: boolean;
  readonly derivedNeverCapturesTreatmentState: boolean;
  readonly executedLifecycle: readonly string[];
  readonly guards: Readonly<Record<string, readonly string[]>>;
}

/**
 * One repository, one initialisation route, both capture mechanisms.
 *
 * `useInit` is the whole difference between the two routes: `vtrace init`
 * writes the repository-local git exclude that hides `.vtrace`, and `vtrace
 * index` on its own does not.
 */
async function probeRoute(
  workspace: string,
  route: string,
  useInit: boolean,
): Promise<RouteResult> {
  const repo = path.join(workspace, route);
  mkdirSync(path.join(repo, "pkg"), { recursive: true });

  // The phases this probe actually executes, appended as they happen, so the
  // ordering claim is a trace rather than a restatement of the constant.
  const executedLifecycle: string[] = ["CONTAINER_START"];

  await git(["init", "-q", "-b", "main"], repo);
  await git(["config", "user.email", "m214@example.invalid"], repo);
  await git(["config", "user.name", "M214 Probe"], repo);

  writeFileSync(path.join(repo, "pkg", "__init__.py"), "from .core import solve\n");
  writeFileSync(
    path.join(repo, "pkg", "core.py"),
    "def solve(value):\n"
    + '    """Return the value, doubled."""\n'
    + "    return value * 2\n\n\n"
    + "class Engine:\n"
    + "    def __init__(self, factor):\n"
    + "        self.factor = factor\n\n"
    + "    def apply(self, value):\n"
    + "        return solve(value) * self.factor\n",
  );
  writeFileSync(
    path.join(repo, "pkg", "util.py"),
    "def normalise(items):\n    return sorted(set(items))\n",
  );
  writeFileSync(path.join(repo, "README.md"), "# probe\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-q", "-m", "base"], repo);
  executedLifecycle.push("SOURCE_CHECKOUT_AT_BASE_COMMIT");

  const digestBefore = await trackedSourceDigest(repo);
  executedLifecycle.push("SOURCE_STATE_DIGEST_BEFORE_TREATMENT");
  const untrackedBefore = await untrackedPaths(repo);

  // ── Treatment initialisation, exactly where the lifecycle puts it ──
  const vtraceBin = path.join(VTRACE_ROOT, "bin", "vtrace");
  const initResult = useInit ? await run(vtraceBin, ["init", repo], VTRACE_ROOT) : null;
  const indexResult = await run(vtraceBin, ["index", repo, "--quiet"], VTRACE_ROOT);
  const treatmentInitialised = (initResult === null || initResult.code === 0) && indexResult.code === 0;
  executedLifecycle.push("TREATMENT_INITIALISATION");

  const digestAfter = await trackedSourceDigest(repo);
  executedLifecycle.push("SOURCE_STATE_DIGEST_AFTER_TREATMENT");
  // The snapshot the whole repair rests on, taken AFTER initialisation.
  const preAgentUntracked = await untrackedPaths(repo);
  executedLifecycle.push("PRE_AGENT_UNTRACKED_SNAPSHOT");
  const untrackedIgnoringExcludes = await untrackedPathsIgnoringExcludes(repo);
  const localExcludes = await repositoryLocalExcludes(repo);

  const treatmentStateOnDisk = untrackedIgnoringExcludes
    .filter((entry) => entry.replace(/\/+$/, "") === ".vtrace");
  const exclusionRoutePerTreatmentPath: Record<string, string> = {};
  for (const entry of treatmentStateOnDisk) {
    exclusionRoutePerTreatmentPath[entry] =
      classifyExclusionRoute(entry, preAgentUntracked, preAgentUntracked);
  }

  const indexSize = await run(
    "sh", ["-c", "du -sb .vtrace 2>/dev/null | cut -f1 || echo 0"], repo,
  );

  // ── Case 1: the agent changed no source ──
  executedLifecycle.push("AGENT_RUN");
  const noChangeVendor = await captureVendorStyle(repo);
  const noChangeDerived = await captureDerived(repo, preAgentUntracked);

  // ── Case 2: the agent changed one source file ──
  writeFileSync(
    path.join(repo, "pkg", "core.py"),
    "def solve(value):\n"
    + '    """Return the value, tripled."""\n'
    + "    return value * 3\n\n\n"
    + "class Engine:\n"
    + "    def __init__(self, factor):\n"
    + "        self.factor = factor\n\n"
    + "    def apply(self, value):\n"
    + "        return solve(value) * self.factor\n",
  );
  const changeVendor = await captureVendorStyle(repo);
  const changeDerived = await captureDerived(repo, preAgentUntracked);
  executedLifecycle.push("PATCH_CAPTURE");
  // Evaluation is the SWE-bench evaluator's phase; this probe grades nothing,
  // so the phase is recorded as reached rather than performed.
  executedLifecycle.push("EVALUATION");

  return {
    route,
    treatmentInitialised,
    initExitCode: initResult?.code ?? null,
    indexExitCode: indexResult.code,
    indexBytesOnDisk: Number.parseInt(indexSize.stdout.trim() || "0", 10),
    repositoryLocalExcludes: localExcludes,
    trackedSourceDigestBeforeTreatment: digestBefore,
    trackedSourceDigestAfterTreatment: digestAfter,
    sourceUnchangedByTreatment: digestBefore === digestAfter,
    untrackedBeforeTreatment: untrackedBefore,
    preAgentUntrackedSnapshot: preAgentUntracked,
    untrackedIgnoringExcludes,
    treatmentStateOnDisk,
    exclusionRoutePerTreatmentPath,
    derivedExclusions: derivePatchCaptureExclusions(preAgentUntracked),
    derivedPathspec: patchCapturePathspec(preAgentUntracked),
    noSourceChange: { vendor: noChangeVendor, derived: noChangeDerived },
    sourceChange: { vendor: changeVendor, derived: changeDerived },
    vendorLeaksTreatmentState: noChangeVendor.paths.some((entry) => entry.startsWith(".vtrace")),
    derivedProducesEmptyPatchOnNoSourceChange: noChangeDerived.bytes === 0,
    derivedCapturesExactlyTheAgentEdit:
      changeDerived.paths.length === 1 && changeDerived.paths[0] === "pkg/core.py",
    derivedNeverCapturesTreatmentState:
      changeDerived.paths.every((entry) => !entry.startsWith(".vtrace"))
      && noChangeDerived.paths.every((entry) => !entry.startsWith(".vtrace")),
    executedLifecycle,
    guards: {
      executedLifecycleOrder: auditLifecycleOrder(executedLifecycle),
      capturedPatchAudit_noChange_derived:
        auditCapturedPatchPaths(noChangeDerived.paths, preAgentUntracked),
      capturedPatchAudit_change_derived:
        auditCapturedPatchPaths(changeDerived.paths, preAgentUntracked),
      derivedExclusionCoversTreatmentState: auditDerivedExclusionCoversTreatmentState(
        "vtrace", preAgentUntracked, treatmentStateOnDisk, preAgentUntracked,
      ),
      derivedExclusionWithEarlySnapshot: auditDerivedExclusionCoversTreatmentState(
        "vtrace", untrackedBefore, treatmentStateOnDisk, untrackedIgnoringExcludes,
      ),
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outDir = outIndex >= 0 && args[outIndex + 1] !== undefined
    ? path.resolve(args[outIndex + 1]!)
    : DEFAULT_OUT;
  mkdirSync(outDir, { recursive: true });

  // Outside the VTRACE checkout on purpose: an index built inside a nested
  // worktree would exercise M132's routing rather than patch capture.
  const workspace = mkdtempSync(path.join(tmpdir(), "m214-patch-capture-"));

  try {
    const withInit = await probeRoute(workspace, "init_then_index", true);
    const indexOnly = await probeRoute(workspace, "index_only", false);
    const routes = [withInit, indexOnly];

    const findings = {
      // Both routes must be observationally safe on tracked source.
      sourceUnchangedByTreatment: routes.every((entry) => entry.sourceUnchangedByTreatment),
      treatmentCreatedState: routes.every((entry) => entry.treatmentStateOnDisk.length > 0),
      // The defect: reproduced on at least one route, which is enough to make a
      // hardcoded exclusion list unusable.
      vendorLeaksTreatmentStateOnAtLeastOneRoute: routes.some((entry) => entry.vendorLeaksTreatmentState),
      vendorLeakIsRouteDependent:
        withInit.vendorLeaksTreatmentState !== indexOnly.vendorLeaksTreatmentState,
      // The repair: holds on every route.
      derivedProducesEmptyPatchOnNoSourceChange:
        routes.every((entry) => entry.derivedProducesEmptyPatchOnNoSourceChange),
      derivedCapturesExactlyTheAgentEdit:
        routes.every((entry) => entry.derivedCapturesExactlyTheAgentEdit),
      derivedNeverCapturesTreatmentState:
        routes.every((entry) => entry.derivedNeverCapturesTreatmentState),
      initWritesRepositoryLocalGitExclude:
        withInit.repositoryLocalExcludes.some((entry) => entry.includes(".vtrace")),
      indexAloneWritesNoGitExclude:
        !indexOnly.repositoryLocalExcludes.some((entry) => entry.includes(".vtrace")),
      // The ordering M213 could not close, executed rather than asserted.
      lifecycleOrderExecutedCorrectly:
        routes.every((entry) => entry.guards.executedLifecycleOrder.length === 0),
      snapshotTakenAfterTreatmentInitialisation: routes.every((entry) =>
        entry.executedLifecycle.indexOf("PRE_AGENT_UNTRACKED_SNAPSHOT")
        > entry.executedLifecycle.indexOf("TREATMENT_INITIALISATION")),
    };

    const verdict = Object.values(findings).every(Boolean)
      ? "PATCH_CAPTURE_REPAIR_VERIFIED"
      : "PATCH_CAPTURE_REPAIR_NOT_VERIFIED";

    const artifact = {
      schemaVersion: "stage5.m214.patch-capture-repair.v2",
      milestone: "M214",
      generatedAt: new Date().toISOString(),
      method:
        "Two real Git repositories differing only in whether `vtrace init` ran before `vtrace "
        + "index`, a real VTRACE index over each, and both capture mechanisms run against the same "
        + "working tree. No model, no container, no benchmark task.",
      vendorHardcodedExclusions: VENDOR_HARDCODED_EXCLUSIONS,
      hardcodedExclusionAudit:
        auditHardcodedExclusionList(VENDOR_HARDCODED_EXCLUSIONS, [".vtrace", ".vexp"]),
      routes,
      findings,
      interpretation:
        "The vendor harness's hardcoded exclusion list leaks VTRACE index metadata into the agent's "
        + "patch whenever `.vtrace` is git-enumerable, which is whenever the treatment was "
        + "initialised without `vtrace init`. Fairness that depends on which entry point ran is not "
        + "fairness. The derived mechanism produces an empty patch on a no-source-change run and "
        + "exactly the edited file on a source-change run, on BOTH routes, and names no vendor.",
      verdict,
    };

    const outPath = path.join(outDir, "stage5_m214_patch_capture_repair.json");
    writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
    process.stdout.write(`${outPath}\n`);
    for (const entry of routes) {
      process.stdout.write(
        `${entry.route}: vendor no-change ${entry.noSourceChange.vendor.bytes} bytes over `
        + `[${entry.noSourceChange.vendor.paths.join(", ") || "-"}]; `
        + `derived no-change ${entry.noSourceChange.derived.bytes} bytes; `
        + `derived change [${entry.sourceChange.derived.paths.join(", ")}]\n`,
      );
    }
    process.stdout.write(`${verdict}\n`);
    if (verdict !== "PATCH_CAPTURE_REPAIR_VERIFIED") process.exitCode = 1;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

await main();
