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
} from "./envIsolationGuard";

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
    }),
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
