// M141 Workstream D — one output/workspace contract for every Stage 5 runner.
//
// During M140 the preservation runners wrote straight into the tracked
// `results/` directory, so running a smoke to CHECK the evidence overwrote the
// evidence. The remedy in use was archive-then-restore, which silently reverted
// the M140-C acceptance artifact once. The fix belongs in the output contract:
// ordinary runs go somewhere untracked, and writing committed evidence has to
// be asked for.
//
// It also centralizes the scratch root. `os.tmpdir()` is a 32 GB tmpfs on this
// machine and the M137 runner copies a 505 MB index into it; that EDQUOT killed
// two separate M140 attempts.

import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Repo root, resolved from this file rather than from the caller's cwd. */
export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

/** The tracked evidence directory. Only ever written to on explicit request. */
export const TRACKED_RESULTS_DIR = path.join(
  REPO_ROOT,
  "benchmarks",
  "stage5_vexp_swe_bench_smoke",
  "results",
);

export const OUTPUT_ROOT_ENV = "VTRACE_BENCH_OUT" as const;
export const WORKSPACE_ROOT_ENV = "VTRACE_BENCH_WORKSPACE" as const;

export interface RunnerOutputTarget {
  readonly dir: string;
  /** True when this run is deliberately regenerating committed evidence. */
  readonly writesTrackedEvidence: boolean;
  /** Which input decided the location, for the run's provenance record. */
  readonly source: "explicit_out" | "evidence_flag" | "environment" | "default_untracked";
}

/**
 * Where a runner should write its report.
 *
 * Precedence, highest first:
 *   1. `--out <dir>`            explicit caller choice
 *   2. `--evidence`             the tracked results directory, opted into
 *   3. `$VTRACE_BENCH_OUT`      environment default for a whole session
 *   4. `<workspace>/vtrace-bench-out/<runner>`   untracked, safe default
 *
 * The default is deliberately NOT `results/`: a smoke that merely validates
 * behavior must not be able to masquerade as evidence generation.
 */
export function resolveRunnerOutput(input: {
  readonly argv: readonly string[];
  readonly runner: string;
}): RunnerOutputTarget {
  const explicit = argumentValue(input.argv, "--out");
  if (explicit !== undefined) {
    const dir = path.resolve(explicit);
    return { dir, writesTrackedEvidence: isInsideTrackedResults(dir), source: "explicit_out" };
  }
  if (input.argv.includes("--evidence")) {
    return { dir: TRACKED_RESULTS_DIR, writesTrackedEvidence: true, source: "evidence_flag" };
  }
  const fromEnvironment = process.env[OUTPUT_ROOT_ENV];
  if (fromEnvironment !== undefined && fromEnvironment.trim().length > 0) {
    const dir = path.resolve(fromEnvironment, input.runner);
    return { dir, writesTrackedEvidence: isInsideTrackedResults(dir), source: "environment" };
  }
  return {
    dir: path.join(resolveWorkspaceRoot({ argv: input.argv }), "vtrace-bench-out", input.runner),
    writesTrackedEvidence: false,
    source: "default_untracked",
  };
}

/** Resolve and create the output directory in one step. */
export async function prepareRunnerOutput(input: {
  readonly argv: readonly string[];
  readonly runner: string;
}): Promise<RunnerOutputTarget> {
  const target = resolveRunnerOutput(input);
  await mkdir(target.dir, { recursive: true });
  return target;
}

/**
 * Where large scratch state (index copies, target checkouts, worktrees) belongs.
 *
 * Precedence, highest first:
 *   1. `--workspace-root <dir>`
 *   2. `$VTRACE_BENCH_WORKSPACE`
 *   3. `$TMPDIR`            respected as the caller set it; never overridden
 *   4. `os.tmpdir()`
 *
 * No machine-specific path is baked in. On a host where `/tmp` is a small
 * tmpfs, set `VTRACE_BENCH_WORKSPACE` to somewhere on the root filesystem.
 */
export function resolveWorkspaceRoot(input: { readonly argv: readonly string[] }): string {
  const explicit = argumentValue(input.argv, "--workspace-root");
  if (explicit !== undefined) {
    return path.resolve(explicit);
  }
  const configured = process.env[WORKSPACE_ROOT_ENV];
  if (configured !== undefined && configured.trim().length > 0) {
    return path.resolve(configured);
  }
  const tmpdir = process.env.TMPDIR;
  if (tmpdir !== undefined && tmpdir.trim().length > 0) {
    return path.resolve(tmpdir);
  }
  return os.tmpdir();
}

/** A scratch directory under the resolved workspace root, created on demand. */
export async function prepareScratchRoot(input: {
  readonly argv: readonly string[];
  readonly runner: string;
}): Promise<string> {
  const scratch = path.join(resolveWorkspaceRoot({ argv: input.argv }), "vtrace-bench-scratch", input.runner);
  await mkdir(scratch, { recursive: true });
  return scratch;
}

/** The `--help` text every runner can print for these shared options. */
export const SHARED_RUNNER_OPTIONS_HELP = [
  "  --out <dir>              Write reports here. Default: an untracked run directory.",
  "  --evidence               Write into the tracked results/ directory (regenerates committed evidence).",
  "  --workspace-root <dir>   Root for large scratch state. Default: $VTRACE_BENCH_WORKSPACE, then $TMPDIR.",
  "",
  `  $${OUTPUT_ROOT_ENV}      Session-wide output root (a per-runner subdirectory is created under it).`,
  `  $${WORKSPACE_ROOT_ENV}   Session-wide scratch root; use this when /tmp is a small tmpfs.`,
  "",
  "  Ordinary runs never write tracked evidence. Pass --evidence (or --out into results/)",
  "  only when the intent is to regenerate a committed milestone artifact.",
].join("\n");

/** Provenance stamp so a report always records where it was allowed to write. */
export function describeRunnerPaths(input: {
  readonly argv: readonly string[];
  readonly runner: string;
  readonly output: RunnerOutputTarget;
}): {
  readonly outputDir: string;
  readonly outputSource: RunnerOutputTarget["source"];
  readonly writesTrackedEvidence: boolean;
  readonly workspaceRoot: string;
  readonly tmpdirRespected: boolean;
} {
  return {
    outputDir: input.output.dir,
    outputSource: input.output.source,
    writesTrackedEvidence: input.output.writesTrackedEvidence,
    workspaceRoot: resolveWorkspaceRoot({ argv: input.argv }),
    tmpdirRespected: process.env.TMPDIR !== undefined && process.env.TMPDIR.trim().length > 0,
  };
}

function isInsideTrackedResults(dir: string): boolean {
  const relative = path.relative(TRACKED_RESULTS_DIR, dir);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function argumentValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}
