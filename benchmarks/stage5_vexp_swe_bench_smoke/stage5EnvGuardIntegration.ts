// Stage 5 M86 — env-guard integration glue between the Stage 5 runner and the pure guard.
//
// The runner performs NO Python dependency installation itself (all install/pytest work is
// delegated to the external vexp-swe-bench harness or, for the docker-verify seam, to
// prebuilt SWE-bench images). What VTRACE CAN do is refuse to invoke any path that resolves
// to an interpreter living in a PROTECTED prefix (the conda base or the active dev env) —
// the precise vector that contaminated base (an editable pytest install + double pluggy).
//
// This module wraps "probe the interpreter the run would use ➜ evaluate the fail-closed
// prefix guard ➜ build compact metadata" into one call. It accepts injectable probe/exists
// functions so tests exercise it with synthetic data and never touch a real environment.

import {
  evaluatePrefixGuard,
  buildEnvGuardMetadata,
  normalizePrefix,
  classifyInstallCommand,
  type PythonProbe,
  type PrefixGuardResult,
  type PrefixGuardConfig,
  type EnvGuardMetadata,
  type EnvGuardStatus,
} from "./envIsolationGuard";

// M89 — the milestone the Stage 5 environment guard became MANDATORY for live agent runs.
// Before M89 the guard was opt-in (--stage5-env-guard); from M89 a live agent run fails
// closed unless the guard provably passes. This is safety infrastructure only — it changes
// NO retrieval, scoring, ranking, Capsule v2, V4 tool-loop guard, or C7_D cost-guard behavior.
export const STAGE5_ENV_GUARD_MANDATORY_SINCE = "M89";

// Environment variable that supplies the expected disposable testbed Python prefix when the
// `--expected-testbed-prefix` flag is absent (resolution order: CLI flag → this env var).
export const STAGE5_EXPECTED_TESTBED_PREFIX_ENV = "VTRACE_STAGE5_EXPECTED_TESTBED_PREFIX";

// The fix instructions printed (and recorded) whenever a live run cannot resolve an expected
// testbed prefix. Kept as one constant so the runner, tests, and report stay in lockstep.
export const EXPECTED_PREFIX_FIX_MESSAGE =
  "Pass:\n  --expected-testbed-prefix /path/to/env\n" +
  `or set:\n  ${STAGE5_EXPECTED_TESTBED_PREFIX_ENV}=/path/to/env`;

/** Derive the conda BASE prefix from any conda prefix (`<base>/envs/x` ➜ `<base>`). */
export function deriveCondaBasePrefix(condaPrefix: string | null | undefined): string | null {
  if (!condaPrefix) return null;
  const norm = normalizePrefix(condaPrefix);
  const idx = norm.indexOf("/envs/");
  return idx >= 0 ? norm.slice(0, idx) : norm;
}

export interface Stage5EnvGuardOptions {
  readonly enabled: boolean;
  readonly driftCheckEnabled: boolean;
  readonly expectedTestbedPrefix: string | null;
  readonly vexpSweBenchDir: string | null;
  /** Active shell CONDA_PREFIX (defaults to process.env.CONDA_PREFIX). */
  readonly shellCondaPrefix?: string | null;
  /** Optional explicit candidate install command to vet (e.g. from a driver). */
  readonly candidateCommand?: string | null;
  /** Injectable for tests; defaults to the real read-only probe. */
  readonly probeFn?: (pythonCommand: string) => PythonProbe | null;
  /** Injectable for tests; defaults to fs.existsSync. */
  readonly existsFn?: (absPath: string) => boolean;
  // ---- M89 metadata passthrough (no behavior change; recorded in EnvGuardMetadata) ----
  /** True when this preflight backs a live agent run for which the guard is REQUIRED. */
  readonly required?: boolean;
  /** Milestone string recorded when required (defaults to STAGE5_ENV_GUARD_MANDATORY_SINCE). */
  readonly mandatorySince?: string | null;
  /** Where the expected prefix was resolved from, for metadata only. */
  readonly expectedPrefixSource?: ExpectedPrefixSource | null;
  /** True when the escape hatch bypassed the guard (recorded; never benchmark-valid). */
  readonly unguardedLiveEnvAllowed?: boolean;
}

// -------------------------------------------------------------------------------------------
// M89 — expected-prefix resolution + the mandatory live-run gate (PURE / deterministic).
// -------------------------------------------------------------------------------------------

export type ExpectedPrefixSource = "cli" | "env" | "inferred" | "none";

export interface ExpectedPrefixResolution {
  readonly prefix: string | null;
  readonly source: ExpectedPrefixSource;
}

/**
 * Resolve the expected disposable testbed Python prefix in priority order:
 *   1. the explicit `--expected-testbed-prefix` CLI value,
 *   2. else the `VTRACE_STAGE5_EXPECTED_TESTBED_PREFIX` environment variable,
 *   3. else a reliably-inferred prefix (only when the caller proved one — none by default),
 *   4. else null/`none` ⇒ a live run MUST fail closed.
 * Pure: no env access here; the caller passes the env value in so this stays testable.
 */
export function resolveExpectedTestbedPrefix(input: {
  readonly cliPrefix?: string | null;
  readonly envValue?: string | null;
  readonly inferredPrefix?: string | null;
}): ExpectedPrefixResolution {
  const cli = (input.cliPrefix ?? "").trim();
  if (cli.length > 0) return { prefix: normalizePrefix(cli), source: "cli" };
  const env = (input.envValue ?? "").trim();
  if (env.length > 0) return { prefix: normalizePrefix(env), source: "env" };
  const inferred = (input.inferredPrefix ?? "").trim();
  if (inferred.length > 0) return { prefix: normalizePrefix(inferred), source: "inferred" };
  return { prefix: null, source: "none" };
}

export interface MandatoryLiveEnvGuardInput {
  /** True for any path that spawns a live agent / external SWE-bench agent run. */
  readonly isLiveAgentRun: boolean;
  /** The escape hatch (--allow-unguarded-live-env). Test/emergency only; never a driver default. */
  readonly allowUnguardedLiveEnv: boolean;
  readonly envGuardEnabled: boolean;
  readonly driftCheckEnabled: boolean;
  readonly resolvedExpectedPrefix: string | null;
  readonly expectedPrefixSource: ExpectedPrefixSource;
  /** The prefix preflight's `ok`, or null when it was not (yet) run. */
  readonly preflightOk: boolean | null;
  /** The prefix preflight's status, or null when it was not (yet) run. */
  readonly preflightStatus: EnvGuardStatus | null;
  /** The prefix preflight's fail-closed reason, when it failed. */
  readonly preflightFailureReason?: string | null;
}

export interface MandatoryLiveEnvGuardDecision {
  /** May the caller spawn the agent? */
  readonly proceed: boolean;
  /** Must the caller throw (fail closed) before any model call / Docker / harness mutation? */
  readonly failClosed: boolean;
  /** Was the escape hatch used to proceed unguarded? */
  readonly bypassed: boolean;
  /** Whether the run counts toward a valid benchmark (false for bypass and for failures). */
  readonly benchmarkValid: boolean;
  /** Whether the guard was required for this run (true for any live agent run). */
  readonly required: boolean;
  /** Failure / bypass explanation, null on a clean guarded pass. */
  readonly reason: string | null;
  /** Operator fix instructions, when failing closed on configuration. */
  readonly fixInstructions: string | null;
}

/**
 * Decide whether a live Stage 5 agent run may proceed under the M89 MANDATORY env guard.
 *
 * For a non-live run the guard is not applicable (always proceeds). For a live run the guard
 * is REQUIRED: the run fails closed unless `--stage5-env-guard` and `--stage5-env-drift-check`
 * are on, an expected testbed prefix resolved, and the prefix preflight passed. The only way
 * to proceed unguarded is the loud `--allow-unguarded-live-env` escape hatch, which proceeds
 * but is NEVER benchmark-valid. Pure: encodes the policy with no I/O so it is fully unit-tested.
 */
export function evaluateMandatoryLiveEnvGuard(input: MandatoryLiveEnvGuardInput): MandatoryLiveEnvGuardDecision {
  // Non-live (offline analysis / preflight / replay / report) ⇒ guard not applicable.
  if (!input.isLiveAgentRun) {
    return { proceed: true, failClosed: false, bypassed: false, benchmarkValid: true, required: false, reason: null, fixInstructions: null };
  }

  // Escape hatch: proceed unguarded, very loudly, and NEVER benchmark-valid.
  if (input.allowUnguardedLiveEnv) {
    return {
      proceed: true,
      failClosed: false,
      bypassed: true,
      benchmarkValid: false,
      required: true,
      reason: "unguarded live env explicitly allowed via --allow-unguarded-live-env (NOT benchmark-valid)",
      fixInstructions: null,
    };
  }

  const fail = (reason: string, fix: string | null): MandatoryLiveEnvGuardDecision => ({
    proceed: false,
    failClosed: true,
    bypassed: false,
    benchmarkValid: false,
    required: true,
    reason,
    fixInstructions: fix,
  });

  if (!input.envGuardEnabled) {
    return fail(
      "live Stage 5 agent runs require the environment guard (mandatory since M89)",
      "Enable it: pass --stage5-env-guard",
    );
  }
  if (!input.driftCheckEnabled) {
    return fail(
      "live Stage 5 agent runs require the drift check (mandatory since M89)",
      "Enable it: pass --stage5-env-drift-check",
    );
  }
  if (!input.resolvedExpectedPrefix) {
    return fail(
      "live Stage 5 agent runs require a proven expected testbed prefix (mandatory since M89)",
      EXPECTED_PREFIX_FIX_MESSAGE,
    );
  }
  if (input.preflightOk !== true || input.preflightStatus !== "pass") {
    return fail(
      `environment guard did not pass: ${input.preflightFailureReason ?? "prefix verification failed"}`,
      null,
    );
  }

  return { proceed: true, failClosed: false, bypassed: false, benchmarkValid: true, required: true, reason: null, fixInstructions: null };
}

export interface Stage5EnvGuardOutcome {
  /** false ⇒ the caller MUST fail closed before invoking the install-capable path. */
  readonly ok: boolean;
  readonly failClosedReason: string | null;
  readonly prefixGuard: PrefixGuardResult | null;
  readonly resolvedTestbedPython: string | null;
  readonly metadata: EnvGuardMetadata;
}

// Candidate testbed interpreters, in priority order: explicit expected prefix, then the
// external harness's own `.venv` (the interpreter the harness's findPython() prefers).
function candidateInterpreters(opts: Stage5EnvGuardOptions): string[] {
  const out: string[] = [];
  const expected = opts.expectedTestbedPrefix ? normalizePrefix(opts.expectedTestbedPrefix) : "";
  if (expected) {
    out.push(`${expected}/bin/python`, `${expected}/Scripts/python.exe`);
  }
  if (opts.vexpSweBenchDir) {
    const base = normalizePrefix(opts.vexpSweBenchDir);
    out.push(`${base}/.venv/bin/python`, `${base}/.venv/Scripts/python.exe`);
  }
  return out;
}

/**
 * Run the env-guard preflight. When disabled, returns ok=true with not_applicable metadata
 * (the default path — no behavior change). When enabled, it fails closed if an expected
 * testbed prefix is not configured, the interpreter cannot be probed, or the prefix guard
 * rejects the resolved interpreter (e.g. it points at base/dev).
 */
export function runStage5EnvGuardPreflight(opts: Stage5EnvGuardOptions): Stage5EnvGuardOutcome {
  const existsFn = opts.existsFn ?? defaultExists;
  const probeFn = opts.probeFn ?? defaultProbe;

  // Disabled ⇒ default path; nothing changes. Report whether unguarded installs are possible.
  if (!opts.enabled) {
    return {
      ok: true,
      failClosedReason: null,
      prefixGuard: null,
      resolvedTestbedPython: null,
      metadata: buildEnvGuardMetadata({
        enabled: false,
        expectedTestbedPrefix: opts.expectedTestbedPrefix,
        prefixGuard: null,
        driftCheckEnabled: opts.driftCheckEnabled,
        drift: null,
        dependencyInstallCommandsChecked: 0,
        blockedUnsafePipCommandCount: 0,
        notApplicableReason: "env guard disabled",
        ...m89MetaPassthrough(opts),
      }),
    };
  }

  const shellConda = opts.shellCondaPrefix !== undefined ? opts.shellCondaPrefix : process.env.CONDA_PREFIX ?? null;
  const base = deriveCondaBasePrefix(shellConda);
  const protectedBasePrefixes = base ? [base] : [];
  // The active env (CONDA_PREFIX) is the dev prefix to protect — unless it IS the expected one.
  const expected = opts.expectedTestbedPrefix ? normalizePrefix(opts.expectedTestbedPrefix) : "";
  const activeEnv = shellConda ? normalizePrefix(shellConda) : "";
  const protectedDevPrefixes = activeEnv && activeEnv !== expected ? [activeEnv] : [];

  // Count / pre-vet any explicit candidate command.
  let depCommandsChecked = 0;
  let blockedUnsafe = 0;
  if (opts.candidateCommand && opts.candidateCommand.trim().length > 0) {
    const k = classifyInstallCommand(opts.candidateCommand);
    if (k.isDependencyInstall) {
      depCommandsChecked = 1;
      if (!k.safeForm) blockedUnsafe = 1;
    }
  }

  const guardCfg: PrefixGuardConfig = { expectedTestbedPrefix: expected, protectedBasePrefixes, protectedDevPrefixes };

  // No expected prefix ⇒ cannot prove anything ⇒ fail closed.
  if (!expected) {
    const pg = evaluatePrefixGuard({ executable: "", prefix: "", basePrefix: "", pipVersionLine: null, condaPrefix: shellConda }, guardCfg, opts.candidateCommand ?? undefined);
    return fail(opts, pg, null, "no --expected-testbed-prefix configured; cannot prove install target", depCommandsChecked, blockedUnsafe);
  }

  // Resolve the testbed interpreter.
  const resolved = candidateInterpreters(opts).find((c) => existsFn(c)) ?? null;
  if (!resolved) {
    const pg = evaluatePrefixGuard({ executable: "", prefix: "", basePrefix: "", pipVersionLine: null, condaPrefix: shellConda }, guardCfg, opts.candidateCommand ?? undefined);
    return fail(opts, pg, null, `expected testbed interpreter not found under ${expected}`, depCommandsChecked, blockedUnsafe);
  }

  const probe = probeFn(resolved);
  if (!probe) {
    const pg = evaluatePrefixGuard({ executable: resolved, prefix: "", basePrefix: "", pipVersionLine: null, condaPrefix: shellConda }, guardCfg, opts.candidateCommand ?? undefined);
    return fail(opts, pg, resolved, `could not probe testbed interpreter ${resolved}`, depCommandsChecked, blockedUnsafe);
  }

  const pg = evaluatePrefixGuard(probe, guardCfg, opts.candidateCommand ?? undefined);
  if (pg.blockedCommand) blockedUnsafe = Math.max(blockedUnsafe, 1);
  const metadata = buildEnvGuardMetadata({
    enabled: true,
    expectedTestbedPrefix: expected,
    prefixGuard: pg,
    driftCheckEnabled: opts.driftCheckEnabled,
    drift: null,
    dependencyInstallCommandsChecked: depCommandsChecked,
    blockedUnsafePipCommandCount: blockedUnsafe,
    failureReason: pg.ok ? null : pg.failures.join("; "),
    ...m89MetaPassthrough(opts),
  });
  return {
    ok: pg.ok,
    failClosedReason: pg.ok ? null : pg.failures.join("; "),
    prefixGuard: pg,
    resolvedTestbedPython: resolved,
    metadata,
  };
}

function fail(
  opts: Stage5EnvGuardOptions,
  pg: PrefixGuardResult,
  resolved: string | null,
  reason: string,
  depChecked: number,
  blocked: number,
): Stage5EnvGuardOutcome {
  return {
    ok: false,
    failClosedReason: reason,
    prefixGuard: pg,
    resolvedTestbedPython: resolved,
    metadata: buildEnvGuardMetadata({
      enabled: true,
      expectedTestbedPrefix: opts.expectedTestbedPrefix,
      prefixGuard: pg,
      driftCheckEnabled: opts.driftCheckEnabled,
      drift: null,
      dependencyInstallCommandsChecked: depChecked,
      blockedUnsafePipCommandCount: blocked,
      failureReason: reason,
      ...m89MetaPassthrough(opts),
    }),
  };
}

// Carry the additive M89 metadata fields (required / mandatory-since / prefix source /
// escape-hatch) from the options into buildEnvGuardMetadata. No behavior change — pure shaping.
function m89MetaPassthrough(opts: Stage5EnvGuardOptions): {
  required?: boolean;
  mandatorySince?: string | null;
  expectedPrefixSource?: string | null;
  unguardedLiveEnvAllowed?: boolean;
} {
  return {
    required: opts.required ?? false,
    mandatorySince: opts.required ? opts.mandatorySince ?? STAGE5_ENV_GUARD_MANDATORY_SINCE : null,
    expectedPrefixSource: opts.expectedPrefixSource ?? null,
    unguardedLiveEnvAllowed: opts.unguardedLiveEnvAllowed ?? false,
  };
}

// Lazy real implementations (kept out of the pure module; only used when not injected).
function defaultExists(absPath: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { existsSync } = require("node:fs");
  return existsSync(absPath);
}
function defaultProbe(pythonCommand: string): PythonProbe | null {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { probePython } = require("./envIsolationProbe");
  return probePython(pythonCommand);
}
