// Stage 5 M86 — environment isolation guard (PURE / deterministic).
//
// Motivation: a SWE-bench dependency install contaminated the operator's CONDA BASE
// prefix (/home/calvin/miniforge3). Concretely an editable `pip install -e .` of the
// pytest-dev__pytest checkout landed in BASE (leaving a broken `_pytest._version`), and
// `pluggy` ended up double-installed (conda metadata 0.13.1 + pip 1.6.0). The root cause
// class: a dependency-install command targeted the WRONG Python prefix because the
// interpreter resolved to bare `python`/`pip` (→ the active conda env) instead of a
// disposable testbed interpreter. Both the external vexp-swe-bench harness (`findPython`)
// and the VTRACE verifier seam (`resolveVerifierPythonCommand`) fall back to bare
// `python` when no `.venv` is present — that fallback IS the contamination vector.
//
// This module is the VTRACE-side, fail-closed defense. It is PURE: no subprocess, no
// filesystem, no clock, no randomness. It consumes already-collected probe data (gathered
// read-only by `envIsolationProbe.ts`) and synthetic command strings, and decides whether
// a dependency install is provably targeting the EXPECTED testbed prefix. Everything that
// touches the real environment lives in the (read-only) probe helper; tests exercise the
// pure functions with synthetic inputs and never mutate any real conda/pip state.
//
// It changes NO retrieval, NO Capsule v2 ranking, NO digest decision contract, NO
// pivot-confidence gate, NO tool-loop guard, and NO cost-guard behavior.

export const ENV_GUARD_MARKER = "<VTRACE_ENV_ISOLATION_GUARD>";

// High-risk packages the contamination touched (and that historical SWE-bench specs pin
// to ancient versions). These are the only packages the drift checker tracks.
export const TRACKED_PACKAGES = ["pluggy", "pytest", "pip", "setuptools", "wheel"] as const;
export type TrackedPackage = (typeof TRACKED_PACKAGES)[number];

// -------------------------------------------------------------------------------------------
// Path normalization — string-only (the pure core never touches the filesystem).
// -------------------------------------------------------------------------------------------

/** Strip trailing slashes and collapse `//`, so `/x/` and `/x` compare equal. */
export function normalizePrefix(p: string | null | undefined): string {
  if (!p) return "";
  return p.replace(/[/\\]+/g, "/").replace(/\/+$/g, "");
}

/** True when `child` is `parent` itself or nested under it (path-segment aware). */
export function isUnderPrefix(child: string, parent: string): boolean {
  const c = normalizePrefix(child);
  const p = normalizePrefix(parent);
  if (p.length === 0 || c.length === 0) return false;
  return c === p || c.startsWith(p + "/");
}

// Heuristic: does this prefix look like a Conda/Miniforge/Anaconda BASE install (i.e. an
// environment that must NEVER receive ad-hoc dependency installs)? Matches a prefix whose
// final path segment is a known base-distribution directory.
const BASE_DIR_PATTERN = /\/(miniforge3?|miniconda3?|anaconda3?|mambaforge)$/i;
export function looksLikeBasePrefix(prefix: string): boolean {
  return BASE_DIR_PATTERN.test(normalizePrefix(prefix));
}

// -------------------------------------------------------------------------------------------
// pip -V parsing — extract the prefix a given pip writes to.
// -------------------------------------------------------------------------------------------

// `python -m pip -V` prints:  pip 25.3 from /home/calvin/miniforge3/lib/python3.12/site-packages/pip (python 3.12)
// The prefix is everything before `/lib/.../site-packages` (or `/Lib/site-packages` on Win).
export function parsePipPrefixFromVersionLine(pipVersionLine: string | null | undefined): string | null {
  if (!pipVersionLine) return null;
  const m = pipVersionLine.match(/from\s+(.+?)[/\\](?:lib|Lib)[/\\].*?site-packages/i);
  if (!m) return null;
  return normalizePrefix(m[1]);
}

// -------------------------------------------------------------------------------------------
// Unsafe-pip command detection.
// -------------------------------------------------------------------------------------------

export type InstallCommandForm =
  | "not_install" // not a dependency install/uninstall at all
  | "bare_pip" // `pip install …` — interpreter is whatever PATH resolves (UNSAFE)
  | "bare_python_pip" // `python -m pip install …` with a non-absolute python (UNSAFE)
  | "conda_activate_pip" // `conda activate … && pip install …` — relies on activation (UNSAFE)
  | "abs_python_pip" // `<abs>/bin/python -m pip install …` (safe FORM; still prefix-verified)
  | "conda_run_pip"; // `conda run -p <prefix> python -m pip install …` (safe FORM)

export interface InstallCommandClassification {
  readonly form: InstallCommandForm;
  readonly isDependencyInstall: boolean;
  readonly safeForm: boolean; // the COMMAND shape is acceptable (prefix still checked separately)
  readonly reason: string;
  /** The absolute interpreter path, when the form encodes one. */
  readonly interpreter: string | null;
  /** The `-p <prefix>` target for a `conda run` form. */
  readonly condaRunPrefix: string | null;
}

const PIP_VERB = /\bpip3?\s+(install|uninstall|download)\b/;
const CONDA_PKG_VERB = /\bconda\s+(install|remove|uninstall|update|upgrade)\b/;

function notInstall(reason: string): InstallCommandClassification {
  return { form: "not_install", isDependencyInstall: false, safeForm: true, reason, interpreter: null, condaRunPrefix: null };
}

/**
 * Classify a (single) shell command string for dependency-install safety. This is a
 * conservative, string-only classifier — it never executes anything. Anything that looks
 * like a package install but does not provably name an absolute interpreter / `conda run -p`
 * target is flagged UNSAFE (safeForm=false) so the caller can fail closed.
 */
export function classifyInstallCommand(command: string): InstallCommandClassification {
  const cmd = (command ?? "").trim();
  if (cmd.length === 0) return notInstall("empty command");

  const hasPip = PIP_VERB.test(cmd);
  const hasCondaPkg = CONDA_PKG_VERB.test(cmd);
  if (!hasPip && !hasCondaPkg) return notInstall("no pip/conda package verb");

  // `conda activate … (&&|;) pip/conda …` — activation-then-install is never provable.
  if (/\bconda\s+activate\b/.test(cmd) && (hasPip || hasCondaPkg)) {
    return {
      form: "conda_activate_pip",
      isDependencyInstall: true,
      safeForm: false,
      reason: "relies on `conda activate` then install — target interpreter is not provable",
      interpreter: null,
      condaRunPrefix: null,
    };
  }

  // `conda run -p <prefix> …` — explicit prefix target is the safe conda form.
  const condaRun = cmd.match(/\bconda\s+run\b[^\n]*?\s-p\s+(\S+)/);
  if (condaRun && (hasPip || hasCondaPkg)) {
    return {
      form: "conda_run_pip",
      isDependencyInstall: true,
      safeForm: true,
      reason: "explicit `conda run -p <prefix>` target",
      interpreter: null,
      condaRunPrefix: normalizePrefix(condaRun[1]),
    };
  }
  // `conda install/remove` without `-p`/`-n` targets the active env — unsafe.
  if (hasCondaPkg && !/\s-(p|n)\s+\S/.test(cmd)) {
    return {
      form: "bare_pip",
      isDependencyInstall: true,
      safeForm: false,
      reason: "`conda install/remove` without -p/-n targets the active env",
      interpreter: null,
      condaRunPrefix: null,
    };
  }

  if (hasPip) {
    // Absolute interpreter explicitly running pip as a module: `<abs>/python -m pip …`.
    const absPyM = cmd.match(/(^|\s)((?:\/|[A-Za-z]:\\)\S*?python[\w.]*)\s+-m\s+pip\b/);
    if (absPyM) {
      return {
        form: "abs_python_pip",
        isDependencyInstall: true,
        safeForm: true,
        reason: "absolute interpreter `-m pip` — prefix still verified separately",
        interpreter: absPyM[2],
        condaRunPrefix: null,
      };
    }
    // Non-absolute `python -m pip …` — interpreter resolves via PATH (UNSAFE).
    if (/(^|\s)python[\w.]*\s+-m\s+pip\b/.test(cmd)) {
      return {
        form: "bare_python_pip",
        isDependencyInstall: true,
        safeForm: false,
        reason: "`python -m pip` with a non-absolute interpreter resolves via PATH",
        interpreter: null,
        condaRunPrefix: null,
      };
    }
    // Bare `pip install …`.
    return {
      form: "bare_pip",
      isDependencyInstall: true,
      safeForm: false,
      reason: "bare `pip` resolves via PATH — interpreter/prefix not provable",
      interpreter: null,
      condaRunPrefix: null,
    };
  }

  return notInstall("no actionable install verb");
}

// -------------------------------------------------------------------------------------------
// Prefix guard — the fail-closed core.
// -------------------------------------------------------------------------------------------

export interface PythonProbe {
  /** sys.executable */
  readonly executable: string;
  /** sys.prefix */
  readonly prefix: string;
  /** sys.base_prefix */
  readonly basePrefix: string;
  /** raw `python -m pip -V` output line (used to derive the pip target prefix) */
  readonly pipVersionLine: string | null;
  /** CONDA_PREFIX env var as seen by the interpreter, or null when unset */
  readonly condaPrefix: string | null;
}

export interface PrefixGuardConfig {
  /** The prefix dependency installs MUST target. Empty/missing ⇒ fail closed. */
  readonly expectedTestbedPrefix: string;
  /** Protected conda BASE prefix(es) — never an install target. */
  readonly protectedBasePrefixes: readonly string[];
  /** Protected active VTRACE/dev prefix(es) — never an install target. */
  readonly protectedDevPrefixes: readonly string[];
  /**
   * When false (default), a CONDA_PREFIX that differs from the expected prefix is tolerated
   * ONLY if the interpreter is an absolute path verified under the expected prefix (it is
   * then merely reported, not fatal). When true, CONDA_PREFIX must equal the expected prefix.
   */
  readonly requireCondaPrefixMatch?: boolean;
}

export type EnvGuardStatus = "pass" | "fail" | "not_applicable" | "unknown";

export interface PrefixGuardCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface PrefixGuardResult {
  readonly ok: boolean;
  readonly status: EnvGuardStatus;
  readonly expectedTestbedPrefix: string;
  readonly actualExecutable: string;
  readonly actualPrefix: string;
  readonly actualPipPrefix: string | null;
  readonly condaPrefix: string | null;
  readonly checks: readonly PrefixGuardCheck[];
  readonly failures: readonly string[]; // human-readable failed-check details
  readonly warnings: readonly string[];
  /** Set when the guard was asked to vet a specific command and rejected it. */
  readonly blockedCommand: string | null;
  readonly blockedCommandForm: InstallCommandForm | null;
}

/**
 * Evaluate the fail-closed prefix guard. All seven checks must pass. If `command` is
 * supplied, its FORM is vetted too (a bare/activation install fails closed before any
 * prefix reasoning even matters).
 *
 * Returns `status: "fail"` (and ok=false) on any violation — the caller must refuse to run
 * the dependency install. `status` is "pass" only when every applicable check holds.
 */
export function evaluatePrefixGuard(
  probe: PythonProbe,
  config: PrefixGuardConfig,
  command?: string | null,
): PrefixGuardResult {
  const checks: PrefixGuardCheck[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];

  const expected = normalizePrefix(config.expectedTestbedPrefix);
  const actualExe = probe.executable ?? "";
  const actualPrefix = normalizePrefix(probe.prefix);
  const pipPrefix = parsePipPrefixFromVersionLine(probe.pipVersionLine);
  const condaPrefix = probe.condaPrefix ? normalizePrefix(probe.condaPrefix) : null;
  const protectedBase = (config.protectedBasePrefixes ?? []).map(normalizePrefix).filter(Boolean);
  const protectedDev = (config.protectedDevPrefixes ?? []).map(normalizePrefix).filter(Boolean);

  const record = (id: string, ok: boolean, detail: string) => {
    checks.push({ id, ok, detail });
    if (!ok) failures.push(`${id}: ${detail}`);
  };

  // Check 0 — an expected prefix must be configured at all (missing ⇒ fail closed).
  const haveExpected = expected.length > 0;
  record(
    "expected_prefix_configured",
    haveExpected,
    haveExpected ? `expected=${expected}` : "no expected testbed prefix configured",
  );

  // Optional command-form vetting up front.
  let blockedCommand: string | null = null;
  let blockedCommandForm: InstallCommandForm | null = null;
  if (command != null && command.trim().length > 0) {
    const klass = classifyInstallCommand(command);
    if (klass.isDependencyInstall) {
      record(
        "command_form_safe",
        klass.safeForm,
        klass.safeForm ? `safe form: ${klass.form}` : `unsafe form (${klass.form}): ${klass.reason}`,
      );
      if (!klass.safeForm) {
        blockedCommand = command;
        blockedCommandForm = klass.form;
      }
      // A conda-run / absolute-interpreter form that names a prefix must name the EXPECTED one.
      const named = klass.condaRunPrefix ?? (klass.interpreter ? deriveInterpreterPrefix(klass.interpreter) : null);
      if (haveExpected && named) {
        const matches = named === expected || isUnderPrefix(named, expected);
        record(
          "command_target_matches_expected",
          matches,
          matches ? `command targets ${named}` : `command targets ${named}, expected ${expected}`,
        );
        if (!matches && !blockedCommand) {
          blockedCommand = command;
          blockedCommandForm = klass.form;
        }
      }
    }
  }

  // Check 1 — the interpreter is the intended testbed python (executable under expected).
  if (haveExpected) {
    const exeUnder = isUnderPrefix(actualExe, expected);
    record(
      "executable_is_testbed",
      exeUnder,
      exeUnder ? `executable under ${expected}` : `executable ${actualExe} not under ${expected}`,
    );
  }

  // Check 2 — sys.prefix equals the expected testbed prefix.
  if (haveExpected) {
    const prefixMatch = actualPrefix === expected;
    record(
      "sys_prefix_matches",
      prefixMatch,
      prefixMatch ? `sys.prefix=${actualPrefix}` : `sys.prefix=${actualPrefix} != expected ${expected}`,
    );
  }

  // Check 3 — `python -m pip -V` reports the same expected prefix.
  if (haveExpected) {
    if (pipPrefix == null) {
      record("pip_prefix_matches", false, "could not parse pip prefix from `python -m pip -V`");
    } else {
      const pipMatch = pipPrefix === expected;
      record(
        "pip_prefix_matches",
        pipMatch,
        pipMatch ? `pip prefix=${pipPrefix}` : `pip prefix=${pipPrefix} != expected ${expected}`,
      );
    }
  }

  // Check 4 — CONDA_PREFIX is expected, or tolerated because the abs executable is verified.
  if (haveExpected && condaPrefix != null) {
    if (condaPrefix === expected) {
      record("conda_prefix_consistent", true, `CONDA_PREFIX=${condaPrefix}`);
    } else {
      const exeAbsVerified = isAbsolute(actualExe) && isUnderPrefix(actualExe, expected) && actualPrefix === expected;
      if (config.requireCondaPrefixMatch) {
        record("conda_prefix_consistent", false, `CONDA_PREFIX=${condaPrefix} != expected ${expected}`);
      } else if (exeAbsVerified) {
        record("conda_prefix_consistent", true, `CONDA_PREFIX=${condaPrefix} ignored (abs interpreter verified under expected)`);
        warnings.push(`CONDA_PREFIX=${condaPrefix} differs from expected ${expected} but absolute interpreter is verified`);
      } else {
        record("conda_prefix_consistent", false, `CONDA_PREFIX=${condaPrefix} != expected and interpreter not verified-absolute`);
      }
    }
  }

  // Checks 5/6/7 — the EXPECTED prefix itself must not be a protected base/dev prefix.
  if (haveExpected) {
    const isBase = protectedBase.some((b) => b === expected);
    record("expected_not_protected_base", !isBase, isBase ? `expected ${expected} is a protected base prefix` : "expected is not a protected base prefix");

    const isDev = protectedDev.some((d) => d === expected);
    record("expected_not_dev", !isDev, isDev ? `expected ${expected} is the active dev prefix` : "expected is not the dev prefix");

    const looksBase = looksLikeBasePrefix(expected);
    record("expected_not_home_base", !looksBase, looksBase ? `expected ${expected} looks like a home/miniforge/miniconda base` : "expected does not look like a base distribution");
  }

  // Backstop — the ACTUAL prefix being installed into must not be a protected one even if
  // someone mis-set `expected`. This is the literal contamination case (sys.prefix == base).
  const actualIsBase = protectedBase.some((b) => b === actualPrefix) || (looksLikeBasePrefix(actualPrefix) && actualPrefix !== expected);
  record("actual_prefix_not_protected_base", !actualIsBase, actualIsBase ? `sys.prefix ${actualPrefix} is a protected base prefix` : "sys.prefix is not a protected base prefix");
  const actualIsDev = protectedDev.some((d) => d === actualPrefix) && actualPrefix !== expected;
  record("actual_prefix_not_dev", !actualIsDev, actualIsDev ? `sys.prefix ${actualPrefix} is the active dev prefix` : "sys.prefix is not the dev prefix");

  const ok = failures.length === 0;
  return {
    ok,
    status: ok ? "pass" : "fail",
    expectedTestbedPrefix: expected,
    actualExecutable: actualExe,
    actualPrefix,
    actualPipPrefix: pipPrefix,
    condaPrefix,
    checks,
    failures,
    warnings,
    blockedCommand,
    blockedCommandForm,
  };
}

function isAbsolute(p: string): boolean {
  return /^(\/|[A-Za-z]:\\)/.test(p ?? "");
}

// Derive the env prefix from an interpreter path: `<prefix>/bin/python` → `<prefix>`,
// `<prefix>/Scripts/python.exe` → `<prefix>`.
export function deriveInterpreterPrefix(interpreter: string): string | null {
  const norm = normalizePrefix(interpreter);
  const m = norm.match(/^(.*?)\/(?:bin|Scripts)\/[^/]+$/);
  return m ? m[1] : null;
}

// -------------------------------------------------------------------------------------------
// Post-run drift checker.
// -------------------------------------------------------------------------------------------

export type ProtectedPrefixRole = "base" | "dev" | "testbed";

export interface PackageRecord {
  readonly prefix: string;
  readonly pythonExecutable: string;
  readonly package: string;
  /** version from `conda list`, when known */
  readonly condaVersion: string | null;
  /** version from pip metadata or the imported module, when known */
  readonly pipVersion: string | null;
  readonly importedVersion: string | null;
  readonly importedFile: string | null;
  /** mtime of the imported package file, ms since epoch (passed in; the pure core has no clock) */
  readonly importedMtimeMs: number | null;
}

export type DriftStatus = "ok" | "pip_conda_mismatch" | "changed_during_run" | "missing" | "unknown";

export interface PackageDrift {
  readonly prefix: string;
  readonly package: string;
  readonly status: DriftStatus;
  readonly detail: string;
}

function hasAnyData(r: PackageRecord): boolean {
  return Boolean(r.condaVersion || r.pipVersion || r.importedVersion || r.importedFile);
}

/**
 * Classify a single package's state, optionally comparing a `before`/`after` snapshot pair.
 * Precedence: changed_during_run ➜ pip_conda_mismatch ➜ missing ➜ ok ➜ unknown.
 */
export function classifyPackageDrift(before: PackageRecord, after?: PackageRecord | null): PackageDrift {
  const mk = (status: DriftStatus, detail: string): PackageDrift => ({ prefix: before.prefix, package: before.package, status, detail });

  // changed_during_run — any tracked field moved between snapshots.
  if (after) {
    const changed: string[] = [];
    if ((before.importedVersion ?? null) !== (after.importedVersion ?? null)) changed.push(`imported ${before.importedVersion}→${after.importedVersion}`);
    if ((before.pipVersion ?? null) !== (after.pipVersion ?? null)) changed.push(`pip ${before.pipVersion}→${after.pipVersion}`);
    if ((before.condaVersion ?? null) !== (after.condaVersion ?? null)) changed.push(`conda ${before.condaVersion}→${after.condaVersion}`);
    if ((before.importedMtimeMs ?? null) !== (after.importedMtimeMs ?? null)) changed.push(`mtime ${before.importedMtimeMs}→${after.importedMtimeMs}`);
    if ((before.importedFile ?? null) !== (after.importedFile ?? null)) changed.push(`file ${before.importedFile}→${after.importedFile}`);
    if (changed.length > 0) return mk("changed_during_run", changed.join("; "));
  }

  // pip_conda_mismatch — conda metadata and the actually-installed (pip/imported) version disagree.
  const installed = before.pipVersion ?? before.importedVersion ?? null;
  if (before.condaVersion && installed && before.condaVersion !== installed) {
    return mk("pip_conda_mismatch", `conda=${before.condaVersion} but installed=${installed}`);
  }

  if (!hasAnyData(before)) {
    // Distinguish "definitely absent" from "no data collected".
    return mk("missing", "package not present in this prefix");
  }

  // ok — we have data and (conda,installed) agree or only one is known, and nothing changed.
  return mk("ok", `version ${installed ?? before.condaVersion ?? "?"} stable`);
}

export interface PrefixDriftInput {
  readonly prefix: string;
  readonly role: ProtectedPrefixRole;
  readonly records: ReadonlyArray<{ before: PackageRecord; after?: PackageRecord | null }>;
}

export interface PrefixDriftSummary {
  readonly prefix: string;
  readonly role: ProtectedPrefixRole;
  readonly drifts: readonly PackageDrift[];
  readonly worstStatus: DriftStatus;
}

export interface DriftSummary {
  readonly perPrefix: readonly PrefixDriftSummary[];
  /** True when a PROTECTED (base/dev) prefix changed during the run — a safety failure. */
  readonly safetyFailed: boolean;
  readonly mismatchCount: number;
  readonly changedCount: number;
  readonly overallStatus: DriftStatus;
}

const STATUS_SEVERITY: Record<DriftStatus, number> = {
  ok: 0,
  unknown: 1,
  missing: 2,
  pip_conda_mismatch: 3,
  changed_during_run: 4,
};

function worst(statuses: DriftStatus[]): DriftStatus {
  return statuses.reduce<DriftStatus>((acc, s) => (STATUS_SEVERITY[s] > STATUS_SEVERITY[acc] ? s : acc), "ok");
}

/** Summarize drift across protected prefixes; flags a safety failure when base/dev changed. */
export function summarizePrefixDrift(inputs: readonly PrefixDriftInput[]): DriftSummary {
  const perPrefix: PrefixDriftSummary[] = [];
  let safetyFailed = false;
  let mismatchCount = 0;
  let changedCount = 0;
  const allStatuses: DriftStatus[] = [];

  for (const input of inputs) {
    const drifts = input.records.map((r) => classifyPackageDrift(r.before, r.after));
    for (const d of drifts) {
      allStatuses.push(d.status);
      if (d.status === "pip_conda_mismatch") mismatchCount++;
      if (d.status === "changed_during_run") {
        changedCount++;
        if (input.role === "base" || input.role === "dev") safetyFailed = true;
      }
    }
    perPrefix.push({ prefix: input.prefix, role: input.role, drifts, worstStatus: worst(drifts.map((d) => d.status)) });
  }

  return { perPrefix, safetyFailed, mismatchCount, changedCount, overallStatus: worst(allStatuses) };
}

// -------------------------------------------------------------------------------------------
// Compact metadata builder (for _run.meta.json). No full env dumps.
// -------------------------------------------------------------------------------------------

export interface EnvGuardMetadataInput {
  readonly enabled: boolean;
  readonly expectedTestbedPrefix: string | null;
  readonly prefixGuard: PrefixGuardResult | null;
  readonly driftCheckEnabled: boolean;
  readonly drift: DriftSummary | null;
  readonly dependencyInstallCommandsChecked: number;
  readonly blockedUnsafePipCommandCount: number;
  /** Set when the guard was not run because no install-capable path was active. */
  readonly notApplicableReason?: string | null;
  // ---- M89 mandatory-guard fields (additive; default to the legacy opt-in shape) ----
  /** True when this run is a live agent run for which the guard is REQUIRED (M89). */
  readonly required?: boolean;
  /** Milestone the guard became mandatory ("M89"), recorded only when required. */
  readonly mandatorySince?: string | null;
  /** Where the expected prefix came from ("cli" | "env" | "inferred" | "none"). */
  readonly expectedPrefixSource?: string | null;
  /** Human-readable fail-closed reason, when the mandatory gate refused the run. */
  readonly failureReason?: string | null;
  /** True when the escape hatch (--allow-unguarded-live-env) bypassed the guard. */
  readonly unguardedLiveEnvAllowed?: boolean;
  /**
   * Whether this run counts toward a valid benchmark. A bypassed (unguarded) live run
   * is NEVER benchmark-valid; a clean guarded pass is. Undefined ⇒ derived from status.
   */
  readonly benchmarkValid?: boolean;
}

export interface EnvGuardMetadata {
  readonly stage5_env_guard_enabled: boolean;
  readonly stage5_expected_testbed_prefix: string | null;
  readonly stage5_python_prefix_verified: boolean;
  readonly stage5_pip_prefix_verified: boolean;
  readonly stage5_blocked_unsafe_pip_command_count: number;
  readonly stage5_dependency_install_commands_checked: number;
  readonly stage5_prefix_guard_failures: readonly string[];
  readonly stage5_drift_check_enabled: boolean;
  readonly stage5_prefix_drift_summary: string;
  readonly stage5_env_guard_status: EnvGuardStatus;
  // ---- M89 mandatory-guard fields ----
  readonly stage5_env_guard_required: boolean;
  readonly stage5_env_guard_mandatory_since: string | null;
  readonly stage5_expected_testbed_prefix_source: string | null;
  readonly stage5_env_guard_failure_reason: string | null;
  readonly stage5_unguarded_live_env_allowed: boolean;
  readonly stage5_env_guard_benchmark_valid: boolean;
}

function summarizeDriftLine(drift: DriftSummary | null): string {
  if (!drift) return "not_run";
  const parts = [`overall=${drift.overallStatus}`];
  if (drift.mismatchCount) parts.push(`mismatch=${drift.mismatchCount}`);
  if (drift.changedCount) parts.push(`changed=${drift.changedCount}`);
  if (drift.safetyFailed) parts.push("SAFETY_FAILED");
  return parts.join(" ");
}

export function buildEnvGuardMetadata(input: EnvGuardMetadataInput): EnvGuardMetadata {
  const pg = input.prefixGuard;
  // Derive the two boolean verifications from the named checks (false when guard absent).
  const checkOk = (id: string): boolean => Boolean(pg?.checks.find((c) => c.id === id)?.ok);

  const required = input.required ?? false;
  let status: EnvGuardStatus;
  if (!input.enabled) {
    // A live run that is REQUIRED to guard but arrives disabled is a fail-closed condition,
    // not "not_applicable" — record it as a failure so reports cannot mistake it for safe.
    status = required ? "fail" : "not_applicable";
  } else if (pg == null) {
    status = input.notApplicableReason ? "not_applicable" : "unknown";
  } else if (!pg.ok || (input.drift?.safetyFailed ?? false)) {
    status = "fail";
  } else {
    status = "pass";
  }

  // A bypassed (unguarded) live run is never benchmark-valid; otherwise validity follows
  // the explicit input, else a clean "pass".
  const benchmarkValid = input.benchmarkValid ?? (input.unguardedLiveEnvAllowed ? false : status === "pass");

  return {
    stage5_env_guard_enabled: input.enabled,
    stage5_expected_testbed_prefix: input.expectedTestbedPrefix,
    stage5_python_prefix_verified: checkOk("sys_prefix_matches"),
    stage5_pip_prefix_verified: checkOk("pip_prefix_matches"),
    stage5_blocked_unsafe_pip_command_count: input.blockedUnsafePipCommandCount,
    stage5_dependency_install_commands_checked: input.dependencyInstallCommandsChecked,
    stage5_prefix_guard_failures: pg?.failures ?? [],
    stage5_drift_check_enabled: input.driftCheckEnabled,
    stage5_prefix_drift_summary: summarizeDriftLine(input.drift),
    stage5_env_guard_status: status,
    stage5_env_guard_required: required,
    stage5_env_guard_mandatory_since: required ? input.mandatorySince ?? null : null,
    stage5_expected_testbed_prefix_source: input.expectedPrefixSource ?? null,
    stage5_env_guard_failure_reason: input.failureReason ?? null,
    stage5_unguarded_live_env_allowed: input.unguardedLiveEnvAllowed ?? false,
    stage5_env_guard_benchmark_valid: benchmarkValid,
  };
}
