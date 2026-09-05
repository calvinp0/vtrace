/**
 * M218 §11–§47 — temporary-space ownership, cleanup, capacity and recovery.
 *
 * Before this module the executor's scratch had three owners and no ledger:
 * M193 extracted the tree into an arm root, M216's adapter `rmSync`'d that root
 * on teardown, and the coding agent wrote to a bwrap tmpfs `/tmp` that was
 * RAM-backed, unbounded and invisible to the executor. The M212 quota
 * exhaustion and the M217 field witness (a container bound to a work directory
 * that no longer existed) are what that arrangement produces.
 *
 * This module makes scratch a first-class, owned, verified resource:
 *
 *   NAMESPACE   one recognisable root carrying a marker; nothing outside it is
 *               ever deleted by anything here, and the root itself never is.
 *   CLAIM       every attempt registers an ownership manifest OUTSIDE the
 *               ephemeral directory before the directory is used: experiment,
 *               run id, manifest row, arm, attempt, creator pid + start ticks,
 *               host. No claim, no destructive cleanup.
 *   CLEANUP     runs after the container and every process are gone, never
 *               through a symlink, never by string prefix, only on a strict
 *               descendant of the canonical namespace root, and is VERIFIED by
 *               measuring what is left.
 *   CAPACITY    a pre-run free-space and inode gate derived from measured
 *               inputs, with a host reserve the benchmark may not consume.
 *   SWEEP       stale owned scratch is recognised by ownership facts (registry
 *               state, dead creator, no live process/mount/container), never by
 *               age alone; unknown paths are reported and never deleted.
 *   EVIDENCE    the raw agent stream, the captured patch and the evaluator's
 *               raw result are copied out of RUN_OWNED scratch and digest-
 *               verified BEFORE cleanup can run.
 *
 * Nothing here decides whether a row may run. The executor consults the
 * capacity gate (P13), passes the cleanup report into the M217 continuation
 * authority, and the enumeration decides.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

import type { RunManifestRow } from "./m214Preregistration";
import { canonicalize } from "./m214Preregistration";

export const M218_SCRATCH_VERSION = "stage5.m218.scratch-lifecycle.v1" as const;
export const M218_NAMESPACE_MARKER = ".m218-scratch-namespace.json" as const;
export const M218_NAMESPACE_SCHEMA = "stage5.m218.scratch-namespace.v1" as const;
export const M218_CLAIM_SCHEMA = "stage5.m218.scratch-claim.v1" as const;
export const M218_EVIDENCE_SCHEMA = "stage5.m218.attempt-evidence.v1" as const;
export const M218_REGISTRY_DIRNAME = "_scratch_registry" as const;
export const M218_EVIDENCE_DIRNAME = "evidence" as const;
/** The one COHORT_OWNED directory the executor keeps under the namespace (evaluator preds files). */
export const M218_COHORT_OWNED_DIRS: readonly string[] = Object.freeze(["evaluation"]);

export type ScratchLifetime =
  | "RUN_OWNED"
  | "TASK_OWNED"
  | "COHORT_OWNED"
  | "EXTERNAL_SHARED_CACHE"
  | "UNKNOWN";

const GIB = 1024 ** 3;

export class ScratchSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScratchSafetyError";
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ── §47 — roots that can never be a namespace or a deletion target ──

/**
 * A structural refusal, evaluated before any filesystem call.
 *
 * The list is deliberately about SHAPE, not about what happens to be mounted:
 * an empty string, a relative path, the filesystem root, any single-segment
 * system directory, the shared temporary directory itself and the home
 * directory are refused whatever the caller believes it owns.
 */
export function forbiddenRootReason(path: string): string | null {
  if (typeof path !== "string" || path.trim().length === 0) return "empty path";
  if (!isAbsolute(path)) return `relative path ${JSON.stringify(path)}`;
  const resolved = resolve(path);
  if (resolved === "/") return "the filesystem root";
  const segments = resolved.split(sep).filter((segment) => segment.length > 0);
  if (segments.length < 2) return `top-level system directory ${resolved}`;
  const home = resolve(homedir());
  if (resolved === home) return "the home directory";
  const sharedTmp = resolve(tmpdir());
  if (resolved === sharedTmp || resolved === "/tmp" || resolved === "/var/tmp") {
    return "the shared temporary directory itself";
  }
  if (segments[0] === "proc" || segments[0] === "sys" || segments[0] === "dev") {
    return `a kernel filesystem (${resolved})`;
  }
  return null;
}

// ── Namespace ───────────────────────────────────────────────────────

export interface NamespaceMarker {
  readonly schemaVersion: typeof M218_NAMESPACE_SCHEMA;
  readonly experiment: string;
  readonly cohortDir: string;
  readonly establishedAt: string;
  readonly establishedBy: { readonly pid: number; readonly hostname: string };
}

export interface ScratchNamespace {
  readonly root: string;
  readonly canonicalRoot: string;
  readonly markerPath: string;
  readonly experiment: string;
  readonly cohortDir: string;
}

/**
 * §13 — establish (or re-open) the one benchmark-owned scratch root.
 *
 * The marker is what makes the root RECOGNISABLE: a sweep or a cleanup that
 * cannot find a marker naming this experiment refuses to treat the directory
 * as owned, however plausible its name.
 */
export function establishNamespace(
  root: string,
  options: { readonly experiment: string; readonly cohortDir: string; readonly now?: () => string },
): ScratchNamespace {
  const reason = forbiddenRootReason(root);
  if (reason !== null) throw new ScratchSafetyError(`refusing to establish a scratch namespace at ${reason}`);
  mkdirSync(root, { recursive: true });
  if (lstatSync(root).isSymbolicLink()) {
    throw new ScratchSafetyError(`refusing a scratch namespace whose root is a symlink: ${root}`);
  }
  const canonicalRoot = realpathSync(root);
  const markerPath = join(canonicalRoot, M218_NAMESPACE_MARKER);
  if (existsSync(markerPath)) {
    const existing = JSON.parse(readFileSync(markerPath, "utf8")) as NamespaceMarker;
    if (existing.schemaVersion !== M218_NAMESPACE_SCHEMA || existing.experiment !== options.experiment) {
      throw new ScratchSafetyError(
        `the scratch namespace at ${canonicalRoot} belongs to ${existing.experiment ?? "(unknown)"} `
        + `(${existing.schemaVersion ?? "no schema"}), not ${options.experiment}`,
      );
    }
    return { root, canonicalRoot, markerPath, experiment: existing.experiment, cohortDir: existing.cohortDir };
  }
  const marker: NamespaceMarker = {
    schemaVersion: M218_NAMESPACE_SCHEMA,
    experiment: options.experiment,
    cohortDir: options.cohortDir,
    establishedAt: (options.now ?? (() => new Date().toISOString()))(),
    establishedBy: { pid: process.pid, hostname: hostname() },
  };
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  return { root, canonicalRoot, markerPath, experiment: options.experiment, cohortDir: options.cohortDir };
}

/** Open an existing namespace; a root without a marker is not a namespace. */
export function openNamespace(root: string, experiment: string): ScratchNamespace {
  const reason = forbiddenRootReason(root);
  if (reason !== null) throw new ScratchSafetyError(`refusing to open a scratch namespace at ${reason}`);
  if (!existsSync(root)) throw new ScratchSafetyError(`no scratch namespace at ${root}`);
  const canonicalRoot = realpathSync(root);
  const markerPath = join(canonicalRoot, M218_NAMESPACE_MARKER);
  if (!existsSync(markerPath)) {
    throw new ScratchSafetyError(`${canonicalRoot} carries no ${M218_NAMESPACE_MARKER}; it is not an owned namespace`);
  }
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as NamespaceMarker;
  if (marker.experiment !== experiment) {
    throw new ScratchSafetyError(`namespace at ${canonicalRoot} belongs to ${marker.experiment}, not ${experiment}`);
  }
  return { root, canonicalRoot, markerPath, experiment: marker.experiment, cohortDir: marker.cohortDir };
}

// ── §46 — path safety ───────────────────────────────────────────────

export interface DeletablePath {
  readonly requested: string;
  readonly canonical: string;
}

/**
 * The only function that may authorise a recursive deletion.
 *
 * Canonicalise the namespace root and the target, require the target to be a
 * STRICT descendant of the root (never the root, never a prefix coincidence
 * like `/x/work2` under `/x/work`), require the marker to be present, and
 * refuse a target that is itself a symlink — a symlink root is how
 * `owned/link -> /home/...` becomes `rm -rf /home/...`.
 */
export function assertDeletableOwnedPath(namespace: ScratchNamespace, target: string): DeletablePath {
  const reason = forbiddenRootReason(target);
  if (reason !== null) throw new ScratchSafetyError(`refusing to delete ${reason}`);
  if (!existsSync(namespace.markerPath)) {
    throw new ScratchSafetyError(`namespace marker absent at ${namespace.markerPath}; ownership cannot be proven`);
  }
  let info;
  try {
    info = lstatSync(target);
  } catch {
    throw new ScratchSafetyError(`nothing at ${target}`);
  }
  if (info.isSymbolicLink()) {
    throw new ScratchSafetyError(`refusing to delete through a symlink: ${target} -> ${readlinkSync(target)}`);
  }
  const canonicalRoot = realpathSync(namespace.canonicalRoot);
  const canonical = realpathSync(target);
  if (canonical === canonicalRoot) throw new ScratchSafetyError("refusing to delete the namespace root itself");
  if (!canonical.startsWith(`${canonicalRoot}${sep}`)) {
    throw new ScratchSafetyError(`${target} (canonical ${canonical}) is not a strict descendant of ${canonicalRoot}`);
  }
  return { requested: target, canonical };
}

export interface TreeMeasurement {
  readonly bytes: number;
  readonly apparentBytes: number;
  readonly inodes: number;
  readonly exists: boolean;
}

/** Disk usage of a tree, lstat-based; symlinks are counted as entries and never followed. */
export function measureTree(target: string): TreeMeasurement {
  let info;
  try {
    info = lstatSync(target);
  } catch {
    return { bytes: 0, apparentBytes: 0, inodes: 0, exists: false };
  }
  let bytes = 0;
  let apparent = 0;
  let inodes = 0;
  const visit = (path: string, stat: ReturnType<typeof lstatSync>): void => {
    inodes += 1;
    bytes += Number(stat.blocks) * 512;
    apparent += Number(stat.size);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    let entries: string[];
    try {
      entries = readdirSync(path);
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry);
      try {
        visit(child, lstatSync(child));
      } catch {
        continue;
      }
    }
  };
  visit(target, info);
  return { bytes, apparentBytes: apparent, inodes, exists: true };
}

export interface TreeRemoval {
  readonly bytesRemoved: number;
  readonly entriesRemoved: number;
  readonly symlinksUnlinked: number;
  readonly errors: readonly string[];
}

/**
 * Recursive deletion that never follows a symlink and re-checks, before
 * descending into any subdirectory, that it still resolves under the
 * authorised target — so a directory swapped for a symlink or a mount during
 * the walk is refused rather than traversed.
 */
export function removeTreeNoFollow(namespace: ScratchNamespace, target: string): TreeRemoval {
  const authorised = assertDeletableOwnedPath(namespace, target);
  let bytes = 0;
  let entries = 0;
  let symlinks = 0;
  const errors: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      errors.push(`readdir ${dir}: ${(error as Error).message}`);
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch (error) {
        errors.push(`lstat ${path}: ${(error as Error).message}`);
        continue;
      }
      try {
        if (stat.isSymbolicLink()) {
          unlinkSync(path);
          symlinks += 1;
          entries += 1;
        } else if (stat.isDirectory()) {
          const canonical = realpathSync(path);
          if (!canonical.startsWith(`${authorised.canonical}${sep}`)) {
            errors.push(`refusing to descend into ${path}: resolves to ${canonical} outside ${authorised.canonical}`);
            continue;
          }
          walk(path);
          rmdirSync(path);
          entries += 1;
        } else {
          unlinkSync(path);
          bytes += Number(stat.blocks) * 512;
          entries += 1;
        }
      } catch (error) {
        errors.push(`remove ${path}: ${(error as Error).message}`);
      }
    }
  };
  walk(authorised.canonical);
  try {
    rmdirSync(authorised.canonical);
    entries += 1;
  } catch (error) {
    errors.push(`rmdir ${authorised.canonical}: ${(error as Error).message}`);
  }
  return { bytesRemoved: bytes, entriesRemoved: entries, symlinksUnlinked: symlinks, errors: Object.freeze(errors) };
}

// ── Liveness ────────────────────────────────────────────────────────

export interface LiveReference {
  readonly kind: "PROCESS" | "MOUNT" | "CONTAINER" | "PROBE_ERROR";
  readonly detail: string;
}

/**
 * What can still hold a scratch path: a process (cmdline or cwd under it), a
 * host mount under it, or a container whose bind source is under it. A probe
 * that cannot look returns a PROBE_ERROR reference, which counts as live: an
 * unverifiable owner is not an absent one.
 */
export interface LivenessProbe {
  referencesTo(path: string): readonly LiveReference[];
  pidAlive(pid: number, startTicks: string | null): boolean;
}

export function processStartTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 2 (comm) may contain spaces; everything after the last ')' is fixed-order.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // rest[0] is field 3 (state); starttime is field 22 → index 19.
    return rest[19] ?? null;
  } catch {
    return null;
  }
}

export class HostLivenessProbe implements LivenessProbe {
  constructor(private readonly options: { readonly docker?: boolean; readonly excludePids?: readonly number[] } = {}) {}

  pidAlive(pid: number, startTicks: string | null): boolean {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    if (startTicks === null) return true;
    const observed = processStartTicks(pid);
    return observed === null ? true : observed === startTicks;
  }

  referencesTo(path: string): readonly LiveReference[] {
    const found: LiveReference[] = [];
    const needle = path.endsWith(sep) ? path : `${path}`;
    const exclude = new Set([process.pid, process.ppid, ...(this.options.excludePids ?? [])]);
    let pids: number[] = [];
    try {
      pids = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).map(Number);
    } catch (error) {
      found.push({ kind: "PROBE_ERROR", detail: `process enumeration failed: ${(error as Error).message}` });
    }
    for (const pid of pids) {
      if (exclude.has(pid)) continue;
      let cmdline = "";
      try {
        cmdline = readFileSync(`/proc/${pid}/cmdline`, "latin1").replace(/\0/g, " ").trim();
      } catch {
        continue;
      }
      let cwd = "";
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        cwd = "";
      }
      if (cmdline.includes(needle) || cwd === needle || cwd.startsWith(`${needle}${sep}`)) {
        found.push({ kind: "PROCESS", detail: `pid ${pid} ${cmdline.slice(0, 200)}${cwd ? ` (cwd ${cwd})` : ""}` });
      }
    }
    try {
      for (const line of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
        const fields = line.split(" ");
        const mountPoint = fields[4] ?? "";
        if (mountPoint === needle || mountPoint.startsWith(`${needle}${sep}`)) {
          found.push({ kind: "MOUNT", detail: `mount at ${mountPoint}` });
        }
      }
    } catch (error) {
      found.push({ kind: "PROBE_ERROR", detail: `mount enumeration failed: ${(error as Error).message}` });
    }
    if (this.options.docker !== false) {
      try {
        const ids = execFileSync("docker", ["ps", "-aq"], { encoding: "utf8", timeout: 30_000 })
          .split("\n").map((entry) => entry.trim()).filter(Boolean);
        if (ids.length > 0) {
          const out = execFileSync("docker", [
            "inspect", "--format", "{{.Name}}\t{{.State.Status}}\t{{range .Mounts}}{{.Source}};{{end}}", ...ids,
          ], { encoding: "utf8", timeout: 60_000 });
          for (const line of out.split("\n")) {
            const [name, status, sources] = line.split("\t");
            if (sources === undefined) continue;
            for (const source of sources.split(";").filter(Boolean)) {
              if (source === needle || source.startsWith(`${needle}${sep}`)) {
                found.push({ kind: "CONTAINER", detail: `${(name ?? "").replace(/^\//, "")} (${status}) binds ${source}` });
              }
            }
          }
        }
      } catch (error) {
        found.push({ kind: "PROBE_ERROR", detail: `container enumeration failed: ${(error as Error).message.slice(0, 200)}` });
      }
    }
    return Object.freeze(found);
  }
}

/** A liveness probe whose facts are an explicit bag, for the pure controls. */
export class SyntheticLivenessProbe implements LivenessProbe {
  readonly references = new Map<string, LiveReference[]>();
  readonly alivePids = new Set<number>();
  probeError: string | null = null;

  referencesTo(path: string): readonly LiveReference[] {
    if (this.probeError !== null) return [{ kind: "PROBE_ERROR", detail: this.probeError }];
    const direct = this.references.get(path) ?? [];
    return Object.freeze([...direct]);
  }

  pidAlive(pid: number): boolean {
    return this.alivePids.has(pid);
  }
}

// ── Capacity (§25–§28) ──────────────────────────────────────────────

export interface FilesystemCapacity {
  readonly path: string;
  readonly totalBytes: number;
  readonly freeBytes: number;
  readonly freeFraction: number;
  readonly totalInodes: number;
  readonly freeInodes: number;
  readonly measuredAt: string;
}

export type CapacityReader = (path: string) => FilesystemCapacity;

export function filesystemCapacity(path: string): FilesystemCapacity {
  const stats = statfsSync(path);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  return {
    path,
    totalBytes,
    freeBytes,
    freeFraction: totalBytes === 0 ? 0 : freeBytes / totalBytes,
    totalInodes: Number(stats.files),
    freeInodes: Number(stats.ffree),
    measuredAt: new Date().toISOString(),
  };
}

/**
 * §26, §27, §30, §52 — the frozen scratch policy, and where each number came
 * from.
 *
 * Every observed input is a measurement recorded by `run_stage5_m218_tmp_census.ts`
 * and the M218 readiness gate cross-checks the census against these literals,
 * so the policy cannot silently drift from its evidence. The paid coding
 * agent's private /tmp usage is NOT known before the paid cohort and is
 * labelled so; the thresholds are conservative multiples of what could be
 * measured, not predictions.
 */
export const M218_SCRATCH_POLICY = Object.freeze({
  version: "stage5.m218.scratch-policy.v1",
  observedInputs: Object.freeze({
    label: "PRE-LAUNCH OBSERVED INFRASTRUCTURE HIGH-WATER (not a future guarantee)",
    largestFrozenRepositoryCheckoutBytes: 285_146_397,
    largestFrozenRepositoryCheckoutRepo: "django__django (working tree + .git incl. directory entries, vexp-swe-bench/.bench-repos, measured by run_stage5_m218_tmp_census.ts 2026-09-05)",
    largestFrozenRepositoryCheckoutInodes: 14_239,
    treatmentIndexBytesObserved: 40_646_988,
    treatmentIndexSource: "M216 real-substrate research row (pylint), indexSizeBytes",
    agentStreamBytesP90: 563_927,
    agentStreamBytesMax: 2_603_053,
    agentStreamSource: "1368 historical Stage 5 raw run directories (M60–M183)",
    largestFrozenImageBytes: 10_800_000_000,
    largestFrozenImageSource: "docker images: swebench/sweb.eval.x86_64.matplotlib_1776_matplotlib-24627 (10.8GB)",
    evaluatorLogBytesPerEvaluation: 67_302,
    evaluatorLogSource: "vexp-swe-bench/logs/run_evaluation, per-run-directory median over the first 400 directories (the vexp-swebench-* directories are ~2.5 MB each)",
    agentPrivateTmpBytes: "UNKNOWN_BEFORE_PAID_COHORT",
  }),
  safetyFactor: 4,
  /** max(4 x (checkout + index + stream max), 2 GiB): the floor binds. */
  projectedAttemptScratchBytes: 2 * GIB,
  /** max(4 x checkout inodes, 250k): the floor binds. */
  projectedAttemptInodes: 250_000,
  /** 2 x the largest frozen image (an unplanned pull or swebench rebuild) + 10 GiB fixed margin. */
  hostSafetyReserveBytes: 2 * 10_800_000_000 + 10 * GIB,
  /** ~1% of the root filesystem's inode table (122M), rounded up. */
  hostSafetyReserveInodes: 1_250_000,
  /** The shared tmpfs /tmp: the benchmark writes nothing there after M218; this is a host-operability floor. */
  sharedTmpMinFreeBytes: 1 * GIB,
  sharedTmpMinFreeInodes: 100_000,
  /** Per-attempt owned scratch: warning at the projection, emergency at 4x. */
  warningAttemptScratchBytes: 2 * GIB,
  hardAttemptScratchBytes: 8 * GIB,
  monitorIntervalMs: 30_000,
  emergencyAbortCategory: "ENVIRONMENT_IRREPRODUCIBLE",
  emergencyAbortRationale:
    "A forced abort to protect the host is mapped to the closest frozen infrastructure class: the run's "
    + "environment could not be sustained under the frozen resource policy. It is NOT rerunnable under "
    + "M214's retry policy; no new retry class is created.",
  arms: "IDENTICAL for baseline and vtrace; the policy has no arm field",
  frozenBefore: "any outcome-bearing run; a later change is an explicit operational amendment",
});

export type ScratchPolicy = typeof M218_SCRATCH_POLICY;

export interface CapacityGateReport {
  readonly at: string;
  readonly namespaceRoot: string;
  readonly namespaceFilesystem: FilesystemCapacity;
  readonly sharedTmp: FilesystemCapacity | null;
  readonly projectedAttemptScratchBytes: number;
  readonly hostSafetyReserveBytes: number;
  readonly requiredFreeBytes: number;
  readonly freeAfterProjectedAttemptBytes: number;
  readonly requiredFreeInodes: number;
  readonly issues: readonly string[];
  readonly pass: boolean;
}

export function capacityGate(
  namespace: ScratchNamespace,
  policy: ScratchPolicy = M218_SCRATCH_POLICY,
  capacityOf: CapacityReader = filesystemCapacity,
  now: () => string = () => new Date().toISOString(),
  sharedTmpPath: string | null = tmpdir(),
): CapacityGateReport {
  const issues: string[] = [];
  let fs: FilesystemCapacity;
  try {
    fs = capacityOf(namespace.canonicalRoot);
  } catch (error) {
    fs = { path: namespace.canonicalRoot, totalBytes: 0, freeBytes: 0, freeFraction: 0, totalInodes: 0, freeInodes: 0, measuredAt: now() };
    issues.push(`cannot measure the namespace filesystem: ${(error as Error).message}`);
  }
  const requiredFreeBytes = policy.hostSafetyReserveBytes + policy.projectedAttemptScratchBytes;
  const freeAfter = fs.freeBytes - policy.projectedAttemptScratchBytes;
  if (fs.freeBytes < requiredFreeBytes) {
    issues.push(
      `namespace filesystem has ${fs.freeBytes} bytes free; the policy requires ${requiredFreeBytes} `
      + `(${policy.hostSafetyReserveBytes} host reserve + ${policy.projectedAttemptScratchBytes} projected attempt scratch)`,
    );
  }
  const requiredFreeInodes = policy.hostSafetyReserveInodes + policy.projectedAttemptInodes;
  if (fs.freeInodes < requiredFreeInodes) {
    issues.push(`namespace filesystem has ${fs.freeInodes} inodes free; the policy requires ${requiredFreeInodes}`);
  }
  let shared: FilesystemCapacity | null = null;
  if (sharedTmpPath !== null) {
    try {
      shared = capacityOf(sharedTmpPath);
      if (shared.freeBytes < policy.sharedTmpMinFreeBytes) {
        issues.push(`shared ${sharedTmpPath} has ${shared.freeBytes} bytes free; the host-operability floor is ${policy.sharedTmpMinFreeBytes}`);
      }
      if (shared.freeInodes < policy.sharedTmpMinFreeInodes) {
        issues.push(`shared ${sharedTmpPath} has ${shared.freeInodes} inodes free; the host-operability floor is ${policy.sharedTmpMinFreeInodes}`);
      }
    } catch (error) {
      issues.push(`cannot measure ${sharedTmpPath}: ${(error as Error).message}`);
    }
  }
  return {
    at: now(),
    namespaceRoot: namespace.canonicalRoot,
    namespaceFilesystem: fs,
    sharedTmp: shared,
    projectedAttemptScratchBytes: policy.projectedAttemptScratchBytes,
    hostSafetyReserveBytes: policy.hostSafetyReserveBytes,
    requiredFreeBytes,
    freeAfterProjectedAttemptBytes: freeAfter,
    requiredFreeInodes,
    issues: Object.freeze(issues),
    pass: issues.length === 0,
  };
}

// ── Claims (§14) ────────────────────────────────────────────────────

export interface ScratchClaim {
  readonly schemaVersion: typeof M218_CLAIM_SCHEMA;
  readonly claimId: string;
  readonly experiment: string;
  readonly runId: string;
  readonly manifestRowId: string;
  readonly instanceId: string;
  readonly arm: string;
  readonly attempt: number;
  readonly attemptId: string;
  readonly path: string;
  readonly agentTmp: string;
  readonly rawDir: string;
  readonly hostMount: string;
  readonly lifetime: "RUN_OWNED";
  readonly createdAt: string;
  readonly creator: {
    readonly pid: number;
    readonly processStartTicks: string | null;
    readonly hostname: string;
    readonly executorVersion: string;
  };
  readonly freeBytesAtClaim: number;
  readonly state: "CLAIMED" | "RELEASED";
  readonly releasedAt: string | null;
  readonly releaseReason: string | null;
  readonly cleanup: ScratchCleanupReport | null;
}

export function claimIdFor(attemptId: string): string {
  return sha256Text(attemptId).slice(0, 24);
}

/** The registry lives OUTSIDE the namespace, so cleaning scratch can never delete its own ownership record. */
export class ScratchRegistry {
  constructor(readonly dir: string) {}

  assertOutside(namespace: ScratchNamespace): void {
    const canonical = existsSync(this.dir) ? realpathSync(this.dir) : resolve(this.dir);
    if (canonical === namespace.canonicalRoot || canonical.startsWith(`${namespace.canonicalRoot}${sep}`)) {
      throw new ScratchSafetyError(`the scratch registry ${canonical} must not live inside the namespace ${namespace.canonicalRoot}`);
    }
  }

  private pathFor(claimId: string): string {
    return join(this.dir, `${claimId}.json`);
  }

  write(claim: ScratchClaim): string {
    mkdirSync(this.dir, { recursive: true });
    const path = this.pathFor(claim.claimId);
    writeFileSync(path, `${JSON.stringify(claim, null, 2)}\n`);
    return path;
  }

  read(claimId: string): ScratchClaim | null {
    const path = this.pathFor(claimId);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as ScratchClaim;
  }

  list(): readonly ScratchClaim[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => JSON.parse(readFileSync(join(this.dir, name), "utf8")) as ScratchClaim);
  }

  claimsForPath(path: string): readonly ScratchClaim[] {
    return this.list().filter((claim) => claim.path === path);
  }

  update(claimId: string, patch: Partial<ScratchClaim>): ScratchClaim {
    const existing = this.read(claimId);
    if (existing === null) throw new ScratchSafetyError(`no claim ${claimId} in ${this.dir}`);
    const updated = { ...existing, ...patch } as ScratchClaim;
    this.write(updated);
    return updated;
  }
}

// ── Checkpoints, cleanup, evidence ──────────────────────────────────

export interface ScratchCheckpoint {
  readonly label: string;
  readonly at: string;
  readonly scratchBytes: number;
  readonly scratchApparentBytes: number;
  readonly scratchInodes: number;
  readonly freeBytes: number;
}

export type ScratchCleanupStatus =
  | "CLEANED"
  | "ALREADY_ABSENT"
  | "REFUSED_LIVE_OWNER"
  | "REFUSED_UNSAFE_PATH"
  | "REFUSED_NOT_OWNED"
  | "FAILED_RESIDUE";

export interface ScratchCleanupReport {
  readonly schemaVersion: typeof M218_SCRATCH_VERSION;
  readonly claimId: string;
  readonly scratchPath: string;
  readonly status: ScratchCleanupStatus;
  readonly at: string;
  readonly freeBytesBefore: number;
  readonly scratchHighWaterBytes: number;
  readonly scratchHighWaterInodes: number;
  readonly freeBytesBeforeCleanup: number;
  readonly scratchBytesAfterCleanup: number;
  readonly scratchInodesAfterCleanup: number;
  readonly freeBytesAfterCleanup: number;
  readonly bytesRemoved: number;
  readonly entriesRemoved: number;
  readonly symlinksUnlinked: number;
  readonly liveReferences: readonly LiveReference[];
  readonly containerRemoved: boolean | null;
  readonly checkpoints: readonly ScratchCheckpoint[];
  readonly errors: readonly string[];
  readonly verified: boolean;
}

export interface EvidenceFile {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface AttemptEvidenceManifest {
  readonly schemaVersion: typeof M218_EVIDENCE_SCHEMA;
  readonly attemptId: string;
  readonly claimId: string;
  readonly dir: string;
  readonly files: readonly EvidenceFile[];
  readonly persistedAt: string;
  readonly verifiedByDigest: boolean;
}

export interface EvidenceArtifacts {
  readonly patch: string | null;
  readonly evaluation: Readonly<Record<string, unknown>> | null;
  readonly extra?: Readonly<Record<string, string>>;
}

export interface ScratchAuthorityOptions {
  readonly namespace: ScratchNamespace;
  readonly registry: ScratchRegistry;
  readonly evidenceDir: string;
  readonly liveness: LivenessProbe;
  readonly experiment: string;
  readonly executorVersion: string;
  readonly now?: () => string;
  readonly policy?: ScratchPolicy;
  readonly capacityOf?: CapacityReader;
  readonly sharedTmpPath?: string | null;
}

export interface EmergencyMonitor {
  stop(): { readonly highWaterBytes: number; readonly warned: boolean; readonly aborted: boolean; readonly samples: number };
}

/** The scratch authority the executor binds; one per cohort process. */
export class ScratchAuthority {
  readonly namespace: ScratchNamespace;
  readonly registry: ScratchRegistry;
  readonly evidenceDir: string;
  readonly policy: ScratchPolicy;
  private readonly liveness: LivenessProbe;
  private readonly now: () => string;
  private readonly capacityOf: CapacityReader;
  private readonly sharedTmpPath: string | null;
  private readonly experiment: string;
  private readonly executorVersion: string;
  private readonly checkpoints = new Map<string, ScratchCheckpoint[]>();

  constructor(options: ScratchAuthorityOptions) {
    this.namespace = options.namespace;
    this.registry = options.registry;
    this.registry.assertOutside(this.namespace);
    this.evidenceDir = options.evidenceDir;
    const evidenceCanonical = existsSync(this.evidenceDir) ? realpathSync(this.evidenceDir) : resolve(this.evidenceDir);
    if (evidenceCanonical === this.namespace.canonicalRoot || evidenceCanonical.startsWith(`${this.namespace.canonicalRoot}${sep}`)) {
      throw new ScratchSafetyError(`the evidence directory ${evidenceCanonical} must not live inside the scratch namespace`);
    }
    this.policy = options.policy ?? M218_SCRATCH_POLICY;
    this.liveness = options.liveness;
    this.now = options.now ?? (() => new Date().toISOString());
    this.capacityOf = options.capacityOf ?? filesystemCapacity;
    this.sharedTmpPath = options.sharedTmpPath === undefined ? tmpdir() : options.sharedTmpPath;
    this.experiment = options.experiment;
    this.executorVersion = options.executorVersion;
  }

  /** §25 — the pre-run gate, for P13. */
  capacityGate(): CapacityGateReport {
    return capacityGate(this.namespace, this.policy, this.capacityOf, this.now, this.sharedTmpPath);
  }

  private freeBytes(): number {
    try {
      return this.capacityOf(this.namespace.canonicalRoot).freeBytes;
    } catch {
      return -1;
    }
  }

  /** Where a row's attempt lives; one authority for the path both adapters address. */
  pathFor(row: RunManifestRow): string {
    return join(this.namespace.canonicalRoot, `${row.instanceId}--${row.arm}`);
  }

  /**
   * §14 — register ownership BEFORE the directory exists.
   *
   * A path that already exists is refused: either a live executor owns it
   * (ACTIVE), or it is residue the startup sweep should have classified. Either
   * way this attempt does not inherit it.
   */
  claim(row: RunManifestRow, attemptId: string, attempt: number): ScratchClaim {
    const path = this.pathFor(row);
    if (existsSync(path)) {
      const owners = this.registry.claimsForPath(path).filter((claim) => claim.state === "CLAIMED");
      throw new ScratchSafetyError(
        `${path} already exists before attempt ${attemptId}; `
        + (owners.length > 0
          ? `it is claimed by ${owners.map((claim) => claim.attemptId).join(", ")}`
          : "it is unregistered residue")
        + ". Run the startup stale-scratch sweep; an attempt never inherits scratch.",
      );
    }
    const claim: ScratchClaim = {
      schemaVersion: M218_CLAIM_SCHEMA,
      claimId: claimIdFor(attemptId),
      experiment: this.experiment,
      runId: row.runId,
      manifestRowId: row.runId,
      instanceId: row.instanceId,
      arm: row.arm,
      attempt,
      attemptId,
      path,
      agentTmp: join(path, "tmp"),
      rawDir: join(path, "raw"),
      hostMount: join(path, "testbed"),
      lifetime: "RUN_OWNED",
      createdAt: this.now(),
      creator: {
        pid: process.pid,
        processStartTicks: processStartTicks(process.pid),
        hostname: hostname(),
        executorVersion: this.executorVersion,
      },
      freeBytesAtClaim: this.freeBytes(),
      state: "CLAIMED",
      releasedAt: null,
      releaseReason: null,
      cleanup: null,
    };
    this.registry.write(claim);
    mkdirSync(claim.agentTmp, { recursive: true });
    mkdirSync(claim.rawDir, { recursive: true });
    this.checkpoints.set(claim.claimId, []);
    return claim;
  }

  /** §29 — measure at a lifecycle point; cheap enough to run at every named phase. */
  checkpoint(claim: ScratchClaim, label: string): ScratchCheckpoint {
    const measured = measureTree(claim.path);
    const point: ScratchCheckpoint = {
      label, at: this.now(),
      scratchBytes: measured.bytes, scratchApparentBytes: measured.apparentBytes, scratchInodes: measured.inodes,
      freeBytes: this.freeBytes(),
    };
    const list = this.checkpoints.get(claim.claimId) ?? [];
    list.push(point);
    this.checkpoints.set(claim.claimId, list);
    return point;
  }

  checkpointsFor(claim: ScratchClaim): readonly ScratchCheckpoint[] {
    return Object.freeze([...(this.checkpoints.get(claim.claimId) ?? [])]);
  }

  /**
   * §30 — bounded-cadence monitoring during the agent run.
   *
   * WARNING is recorded; HARD aborts through the supplied controller so the
   * adapter can stop the process. The interval is the policy's, never faster.
   */
  startEmergencyMonitor(
    claim: ScratchClaim, controller: AbortController, intervalMs: number = this.policy.monitorIntervalMs,
  ): EmergencyMonitor {
    let highWater = 0;
    let warned = false;
    let aborted = false;
    let samples = 0;
    const sample = (): void => {
      samples += 1;
      const measured = measureTree(claim.path);
      highWater = Math.max(highWater, measured.bytes);
      if (measured.bytes >= this.policy.hardAttemptScratchBytes && !aborted) {
        aborted = true;
        controller.abort(new Error(
          `M218 scratch emergency: ${claim.path} reached ${measured.bytes} bytes, above the frozen hard `
          + `threshold ${this.policy.hardAttemptScratchBytes}; the attempt is aborted to protect the host`,
        ));
      } else if (measured.bytes >= this.policy.warningAttemptScratchBytes) {
        warned = true;
      }
    };
    const timer = setInterval(sample, Math.max(intervalMs, 250));
    return {
      stop: () => {
        clearInterval(timer);
        sample();
        return { highWaterBytes: highWater, warned, aborted, samples };
      },
    };
  }

  /**
   * §31 — copy the run's evidence OUT of RUN_OWNED scratch and verify by digest.
   *
   * Refuses to write inside the namespace, refuses to delete anything, and
   * returns a manifest whose digests a later reader can recompute.
   */
  persistEvidence(claim: ScratchClaim, artifacts: EvidenceArtifacts): AttemptEvidenceManifest {
    const dir = join(this.evidenceDir, claim.claimId);
    const rawOut = join(dir, "raw");
    mkdirSync(rawOut, { recursive: true });
    const files: EvidenceFile[] = [];
    const record = (name: string, path: string): void => {
      files.push({ name, bytes: lstatSync(path).size, sha256: sha256File(path) });
    };
    if (existsSync(claim.rawDir)) {
      for (const name of readdirSync(claim.rawDir).sort()) {
        const source = join(claim.rawDir, name);
        const stat = lstatSync(source);
        if (!stat.isFile()) continue;
        const target = join(rawOut, name);
        copyFileSync(source, target);
        if (sha256File(source) !== sha256File(target)) {
          throw new ScratchSafetyError(`evidence copy of ${source} does not match its source digest`);
        }
        record(`raw/${name}`, target);
      }
    }
    if (artifacts.patch !== null) {
      const path = join(dir, "captured.patch");
      writeFileSync(path, artifacts.patch);
      record("captured.patch", path);
    }
    if (artifacts.evaluation !== null) {
      const path = join(dir, "evaluation.json");
      writeFileSync(path, `${JSON.stringify(canonicalize(artifacts.evaluation as Record<string, unknown>), null, 2)}\n`);
      record("evaluation.json", path);
    }
    for (const [name, content] of Object.entries(artifacts.extra ?? {})) {
      const safeName = basename(name);
      const path = join(dir, safeName);
      writeFileSync(path, content);
      record(safeName, path);
    }
    const manifest: AttemptEvidenceManifest = {
      schemaVersion: M218_EVIDENCE_SCHEMA,
      attemptId: claim.attemptId,
      claimId: claim.claimId,
      dir,
      files: Object.freeze(files),
      persistedAt: this.now(),
      verifiedByDigest: files.every((file) => sha256File(join(dir, file.name)) === file.sha256),
    };
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }

  /** Recompute an evidence manifest's digests; the falsification suite's T15 reads this. */
  verifyEvidence(claim: ScratchClaim): { readonly present: boolean; readonly issues: readonly string[] } {
    const dir = join(this.evidenceDir, claim.claimId);
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) return { present: false, issues: ["no evidence manifest"] };
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as AttemptEvidenceManifest;
    const issues: string[] = [];
    for (const file of manifest.files) {
      const path = join(dir, file.name);
      if (!existsSync(path)) issues.push(`evidence file missing: ${file.name}`);
      else if (sha256File(path) !== file.sha256) issues.push(`evidence file altered: ${file.name}`);
    }
    return { present: true, issues: Object.freeze(issues) };
  }

  /**
   * §18–§20, §42 — cleanup, in the substrate's safe order.
   *
   * Refuses while the container that bind-mounts the tree is not known to be
   * gone, refuses while any process, mount or container still references the
   * path, refuses a path the registry does not own, refuses an unsafe path,
   * and VERIFIES by re-measuring. A refusal leaves the path in place, which the
   * M217 enumeration then reports as residue and blocks on.
   */
  cleanup(
    claim: ScratchClaim,
    context: { readonly containerRemoved: boolean | null },
  ): ScratchCleanupReport {
    const registered = this.registry.read(claim.claimId);
    const points = this.checkpointsFor(claim);
    const highWaterBytes = points.reduce((max, point) => Math.max(max, point.scratchBytes), 0);
    const highWaterInodes = points.reduce((max, point) => Math.max(max, point.scratchInodes), 0);
    const before = measureTree(claim.path);
    const freeBefore = this.freeBytes();
    const base = {
      schemaVersion: M218_SCRATCH_VERSION,
      claimId: claim.claimId,
      scratchPath: claim.path,
      at: this.now(),
      freeBytesBefore: claim.freeBytesAtClaim,
      scratchHighWaterBytes: Math.max(highWaterBytes, before.bytes),
      scratchHighWaterInodes: Math.max(highWaterInodes, before.inodes),
      freeBytesBeforeCleanup: freeBefore,
      containerRemoved: context.containerRemoved,
      checkpoints: points,
      bytesRemoved: 0, entriesRemoved: 0, symlinksUnlinked: 0,
    } as const;
    const finish = (
      status: ScratchCleanupStatus,
      liveReferences: readonly LiveReference[],
      removal: TreeRemoval | null,
      errors: readonly string[],
    ): ScratchCleanupReport => {
      const after = measureTree(claim.path);
      const verified = (status === "CLEANED" || status === "ALREADY_ABSENT") && !after.exists && after.bytes === 0;
      const report: ScratchCleanupReport = {
        ...base,
        status: verified ? status : (status === "CLEANED" ? "FAILED_RESIDUE" : status),
        scratchBytesAfterCleanup: after.bytes,
        scratchInodesAfterCleanup: after.inodes,
        freeBytesAfterCleanup: this.freeBytes(),
        bytesRemoved: removal?.bytesRemoved ?? 0,
        entriesRemoved: removal?.entriesRemoved ?? 0,
        symlinksUnlinked: removal?.symlinksUnlinked ?? 0,
        liveReferences,
        errors: Object.freeze([...errors, ...(removal?.errors ?? [])]),
        verified,
      };
      if (registered !== null) {
        this.registry.update(claim.claimId, verified
          ? { state: "RELEASED", releasedAt: report.at, releaseReason: "cleanup verified", cleanup: report }
          : { cleanup: report });
      }
      return report;
    };

    if (registered === null || registered.path !== claim.path) {
      return finish("REFUSED_NOT_OWNED", [], null, [`no registered claim ${claim.claimId} owns ${claim.path}`]);
    }
    if (!before.exists) return finish("ALREADY_ABSENT", [], null, []);
    if (context.containerRemoved === false) {
      return finish("REFUSED_LIVE_OWNER", [{ kind: "CONTAINER", detail: "the adapter reports the container was not removed; its bind mount may still reference the tree" }], null, []);
    }
    const references = this.liveness.referencesTo(claim.path);
    if (references.length > 0) return finish("REFUSED_LIVE_OWNER", references, null, []);
    let removal: TreeRemoval;
    try {
      removal = removeTreeNoFollow(this.namespace, claim.path);
    } catch (error) {
      return finish("REFUSED_UNSAFE_PATH", [], null, [(error as Error).message]);
    }
    return finish("CLEANED", [], removal, []);
  }

  /** What is left of a claim right now; the M217 probe wrapper reads this. */
  residue(claim: ScratchClaim): TreeMeasurement {
    return measureTree(claim.path);
  }

  // ── §22–§24, §38, §39 — the startup sweep ───────────────────────────

  sweep(): StaleSweepReport {
    return sweepNamespace(this.namespace, this.registry, this.liveness, this.now);
  }
}

// ── Stale sweep ─────────────────────────────────────────────────────

export type SweepClassification = "ACTIVE" | "STALE_CLEANABLE" | "STALE_UNSAFE" | "UNKNOWN" | "COHORT_OWNED" | "MARKER";

export interface SweepEntry {
  readonly path: string;
  readonly classification: SweepClassification;
  readonly bytes: number;
  readonly inodes: number;
  readonly ageSeconds: number | null;
  readonly claimId: string | null;
  readonly claimState: string | null;
  readonly ownershipEvidence: readonly string[];
  readonly liveChecks: readonly string[];
  readonly reason: string;
  readonly cleaned: boolean;
  readonly bytesRemoved: number;
  readonly errors: readonly string[];
}

export interface StaleSweepReport {
  readonly at: string;
  readonly namespaceRoot: string;
  readonly entries: readonly SweepEntry[];
  readonly cleaned: readonly string[];
  readonly blocking: readonly string[];
  readonly pass: boolean;
}

/**
 * §22–§23 — classify every entry under the namespace root by OWNERSHIP FACTS.
 *
 * Age is recorded as diagnostic context only. A path is stale because its
 * registered owner is released or dead and nothing live references it; it is
 * unsafe because something still does; it is unknown because no claim names
 * it, and an unknown path blocks launch rather than being guessed about.
 */
export function sweepNamespace(
  namespace: ScratchNamespace,
  registry: ScratchRegistry,
  liveness: LivenessProbe,
  now: () => string = () => new Date().toISOString(),
): StaleSweepReport {
  const at = now();
  const entries: SweepEntry[] = [];
  const cleaned: string[] = [];
  const blocking: string[] = [];
  const names = existsSync(namespace.canonicalRoot) ? readdirSync(namespace.canonicalRoot).sort() : [];
  for (const name of names) {
    const path = join(namespace.canonicalRoot, name);
    if (name === M218_NAMESPACE_MARKER) {
      entries.push(entry(path, "MARKER", null, [], [], "the namespace marker", false, 0, []));
      continue;
    }
    if (M218_COHORT_OWNED_DIRS.includes(name)) {
      entries.push(entry(path, "COHORT_OWNED", null, ["named COHORT_OWNED directory"], [], "kept for the cohort's lifetime", false, 0, []));
      continue;
    }
    const claims = registry.claimsForPath(path);
    if (claims.length === 0) {
      entries.push(entry(path, "UNKNOWN", null, ["no registered claim names this path"], [], "ownership unproven; never deleted; blocks launch", false, 0, []));
      blocking.push(path);
      continue;
    }
    const latest = claims[claims.length - 1]!;
    const evidence = [
      `claim ${latest.claimId} (${latest.attemptId}) state ${latest.state}`,
      `creator pid ${latest.creator.pid}@${latest.creator.hostname} start ${latest.creator.processStartTicks ?? "?"}`,
    ];
    const ownerAlive = latest.state === "CLAIMED"
      && latest.creator.hostname === hostname()
      && liveness.pidAlive(latest.creator.pid, latest.creator.processStartTicks);
    if (ownerAlive) {
      entries.push(entry(path, "ACTIVE", latest, evidence, [`creator pid ${latest.creator.pid} is alive`], "another live executor owns this path; blocks launch", false, 0, []));
      blocking.push(path);
      continue;
    }
    const references = liveness.referencesTo(path);
    const liveChecks = [
      latest.state === "CLAIMED" ? `creator pid ${latest.creator.pid} is not alive (or start ticks differ)` : "claim already RELEASED",
      ...references.map((reference) => `${reference.kind}: ${reference.detail}`),
    ];
    if (references.length > 0) {
      entries.push(entry(path, "STALE_UNSAFE", latest, evidence, liveChecks, "owner gone but a live process, mount or container still references the path; blocks launch", false, 0, []));
      blocking.push(path);
      continue;
    }
    let removal: TreeRemoval | null = null;
    let errors: string[] = [];
    try {
      removal = removeTreeNoFollow(namespace, path);
      errors = [...removal.errors];
    } catch (error) {
      errors = [(error as Error).message];
    }
    const gone = !existsSync(path);
    if (gone) {
      registry.update(latest.claimId, {
        state: "RELEASED", releasedAt: at,
        releaseReason: latest.state === "CLAIMED" ? "STALE_SWEEP: creator dead, no live references" : "STALE_SWEEP: residue after release",
      });
      cleaned.push(path);
    } else {
      blocking.push(path);
    }
    entries.push(entry(path, "STALE_CLEANABLE", latest, evidence, liveChecks,
      gone ? "ownership proven, no live references; removed" : "cleanup attempted but residue remains; blocks launch",
      gone, removal?.bytesRemoved ?? 0, errors));
  }
  return { at, namespaceRoot: namespace.canonicalRoot, entries: Object.freeze(entries), cleaned: Object.freeze(cleaned), blocking: Object.freeze(blocking), pass: blocking.length === 0 };

  function entry(
    path: string, classification: SweepClassification, claim: ScratchClaim | null,
    ownershipEvidence: readonly string[], liveChecks: readonly string[], reason: string,
    wasCleaned: boolean, bytesRemoved: number, errors: readonly string[],
  ): SweepEntry {
    const measured = wasCleaned ? { bytes: bytesRemoved, inodes: 0, exists: false, apparentBytes: 0 } : measureTree(path);
    let age: number | null = null;
    try {
      age = Math.max(0, (Date.parse(at) - lstatSync(path).mtimeMs) / 1000);
    } catch {
      age = null;
    }
    return {
      path, classification, bytes: measured.bytes, inodes: measured.inodes, ageSeconds: age,
      claimId: claim?.claimId ?? null, claimState: claim?.state ?? null,
      ownershipEvidence, liveChecks, reason, cleaned: wasCleaned, bytesRemoved, errors,
    };
  }
}

// ── §33 — image-store availability (reported separately, never pruned) ──

export interface ImageAvailability {
  readonly required: number;
  readonly present: number;
  readonly missing: readonly string[];
  readonly note: string;
}

/**
 * Whether every image the manifest names is already in the local Docker
 * store. M193's setup refuses to start a container whose image is absent (it
 * does not pull), so a missing image is a CONTAINER_CANNOT_START that would
 * consume a retry slot for nothing; the launcher reports it before the first
 * row. Images are EXTERNAL_SHARED_CACHE and are never removed by M218.
 */
export function imageAvailability(
  requiredImages: readonly string[],
  listLocalImages: () => readonly string[] = listDockerImages,
): ImageAvailability {
  const local = new Set(listLocalImages());
  const required = [...new Set(requiredImages)].sort();
  const missing = required.filter((image) => !local.has(image));
  return {
    required: required.length,
    present: required.length - missing.length,
    missing: Object.freeze(missing),
    note: missing.length === 0
      ? "every manifest image is present locally; no pull can occur mid-cohort"
      : `${missing.length} manifest image(s) are absent; M193 does not pull, so their rows would be `
        + "CONTAINER_CANNOT_START. Pre-pull them as an operator step before launch; the image store is "
        + "EXTERNAL_SHARED_CACHE and its growth is not RUN_OWNED scratch",
  };
}

export function listDockerImages(): readonly string[] {
  try {
    return execFileSync("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}"], { encoding: "utf8", timeout: 60_000 })
      .split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ── §36, §37 — arm equivalence ──────────────────────────────────────

/**
 * Two arms' temporary-space configuration must be identical apart from the
 * attempt's own path. Compare the sandbox argv with the per-attempt paths
 * normalised out, plus the policy object both were run under.
 */
export function normaliseSandboxArgv(argv: readonly string[], attemptPath: string): readonly string[] {
  return argv.map((token) => token.split(attemptPath).join("<ATTEMPT>"));
}

export function auditArmTmpEquivalence(
  baseline: { readonly sandboxArgv: readonly string[]; readonly attemptPath: string; readonly envNames: readonly string[] },
  vtrace: { readonly sandboxArgv: readonly string[]; readonly attemptPath: string; readonly envNames: readonly string[] },
): readonly string[] {
  const issues: string[] = [];
  const left = normaliseSandboxArgv(baseline.sandboxArgv, baseline.attemptPath);
  const right = normaliseSandboxArgv(vtrace.sandboxArgv, vtrace.attemptPath);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    issues.push(`sandbox argv differs between arms after path normalisation: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
  }
  const tmpVars = (names: readonly string[]) => names.filter((name) => /TMP|TEMP/i.test(name)).sort();
  if (JSON.stringify(tmpVars(baseline.envNames)) !== JSON.stringify(tmpVars(vtrace.envNames))) {
    issues.push("temporary-directory environment variables differ between arms");
  }
  return Object.freeze(issues);
}
