// Stage 5 M90A — agent-shell guard / host-pip firewall (PURE / deterministic core).
//
// Motivation (the recurrence M90A closes): the M89 environment guard is mandatory, but it
// only protects the RUNNER before it spawns the external SWE-bench agent. It does NOT protect
// the tool shell the spawned coding agent inherits. A spawned agent ran:
//
//     pip install -e .
//
// inside /home/calvin/code/vexp-swe-bench/.bench-repos/pytest-dev__pytest. That ancient pytest
// checkout pins `pluggy >=0.12,<1.0`; the bare `pip` resolved via PATH to the Miniforge BASE
// interpreter, so the editable install DOWNGRADED base `pluggy` to 0.13.1 and broke Conda.
// M89 could not catch it because the mutation happened from WITHIN the agent's tool shell,
// after spawn, via a PATH-resolved `pip` — never through the runner's own install seam.
//
// M90A adds a second safety layer: every Stage 5 live agent run inherits a GUARDED shell
// environment. The agent's PATH is sanitized (every Conda/Miniforge bin removed; a VTRACE
// wrapper bin placed first) and the conda/venv leakage env vars are scrubbed, so any bare
// `pip` / `python -m pip` / `conda install` / editable install resolves to a fail-closed
// wrapper that BLOCKS before mutation and records the attempt — never to host/base pip.
//
// This module is PURE: no subprocess, no filesystem, no clock, no randomness. It produces the
// wrapper SCRIPT TEXT, the sanitized PATH, the scrubbed env overrides, the mandatory-gate
// decision, and the compact metadata. The effectful side (writing the wrapper bin, resolving
// delegate interpreters, reading the block log) lives in stage5AgentShellGuardIntegration.ts.
//
// It changes NO retrieval, NO Capsule v2 ranking, NO digest decision contract, NO
// pivot-confidence gate, NO V4 tool-loop guard, and NO C7_D cost-guard behavior.

// The milestone the agent-shell guard / host-pip firewall became MANDATORY for live runs.
// From M90A a live agent run fails closed before spawn unless the shell guard is materialized.
export const STAGE5_AGENT_SHELL_GUARD_MANDATORY_SINCE = "M90A";

// Distinctive exit code the wrappers use when they refuse a host-mutating command.
export const AGENT_SHELL_GUARD_BLOCK_EXIT = 97;

// Stable markers the wrappers print (and the smoke / report grep for) per tool family.
export const BLOCK_MARKER_PIP = "VTRACE_HOST_PIP_BLOCKED";
export const BLOCK_MARKER_CONDA = "VTRACE_HOST_CONDA_BLOCKED";
export const BLOCK_MARKER_PKG_MANAGER = "VTRACE_HOST_PACKAGE_MANAGER_BLOCKED";

// The human-readable refusal preface (printed by every wrapper before the blocked command).
export const BLOCKED_MESSAGE_LINES = [
  "VTRACE blocked this command because Stage 5 agents must not mutate host/base Python.",
  "Use the benchmark Docker evaluator or an explicitly disposable task-local environment.",
] as const;

// Env var the runner sets so wrappers append their refusals to a per-run JSONL block log.
export const AGENT_BLOCK_LOG_ENV = "VTRACE_AGENT_BLOCK_LOG";

// The wrapper executables generated for every run (the package-manager attack surface).
export const AGENT_WRAPPER_NAMES = [
  "pip",
  "pip3",
  "pip3.12",
  "python",
  "python3",
  "python3.12",
  "conda",
  "uv",
  "poetry",
  "pipx",
] as const;
export type AgentWrapperName = (typeof AGENT_WRAPPER_NAMES)[number];

// -------------------------------------------------------------------------------------------
// PATH sanitization — remove every Conda/Miniforge install dir; put the wrapper bin first.
// -------------------------------------------------------------------------------------------

// A PATH entry that lives INSIDE any conda-style installation (base bin, condabin, OR an env's
// bin, e.g. .../envs/<name>/bin). Removing all of these means a bare `pip`/`python`/`conda`
// can only resolve to the VTRACE wrapper (or a non-conda system tool), never to host/base pip.
const CONDA_PATH_ENTRY = /(^|\/)(miniforge3?|miniconda3?|anaconda3?|mambaforge)(\/|$)/i;

export function isCondaPathEntry(entry: string): boolean {
  return CONDA_PATH_ENTRY.test(entry);
}

export interface PathSanitizationResult {
  readonly sanitizedPath: string;
  readonly removedEntries: readonly string[];
  readonly wrapperBinFirst: boolean;
}

/**
 * Produce the agent PATH: drop every Conda/Miniforge bin entry and prepend the wrapper bin.
 * Pure string transform — the caller owns reading the real PATH. The wrapper bin is always the
 * first entry (so even a surviving conda-adjacent tool cannot shadow the firewall wrappers).
 */
export function sanitizeAgentPath(originalPath: string | null | undefined, wrapperBin: string): PathSanitizationResult {
  const entries = (originalPath ?? "").split(":").filter((e) => e.length > 0);
  const removed: string[] = [];
  const kept: string[] = [];
  for (const e of entries) {
    if (e === wrapperBin) continue; // never duplicate the wrapper bin
    if (isCondaPathEntry(e)) removed.push(e);
    else kept.push(e);
  }
  return {
    sanitizedPath: [wrapperBin, ...kept].join(":"),
    removedEntries: removed,
    wrapperBinFirst: true,
  };
}

// -------------------------------------------------------------------------------------------
// Conda / venv env-var scrubbing.
// -------------------------------------------------------------------------------------------

// Env vars that leak the active conda/venv into the agent shell and could let a tool resolve
// to (or write into) a protected prefix. Neutralized to "" in the agent env override (the
// runner merges overrides over process.env, so "" effectively unsets them for these tools).
export const SCRUBBED_ENV_KEYS = [
  "CONDA_PREFIX",
  "CONDA_DEFAULT_ENV",
  "CONDA_SHLVL",
  "CONDA_PROMPT_MODIFIER",
  "CONDA_EXE",
  "CONDA_PYTHON_EXE",
  "_CE_CONDA",
  "_CE_M",
  "VIRTUAL_ENV",
  "PYTHONPATH",
  "PYTHONHOME",
] as const;

export interface ScrubResult {
  /** Override map: scrubbed keys → "" plus the safety env vars (PYTHONNOUSERSITE, etc.). */
  readonly overrides: Record<string, string>;
  /** Which scrubbed keys were actually present (non-empty) in the input env. */
  readonly scrubbedKeysPresent: readonly string[];
  /** True when at least one conda/venv leakage var was present and neutralized. */
  readonly condaEnvScrubbed: boolean;
}

/**
 * Build the env OVERRIDES that scrub conda/venv leakage and harden pip. Returns "" for each
 * scrubbed key (the runner merges this over process.env at spawn, so the agent sees them empty)
 * plus the hardening vars: PYTHONNOUSERSITE=1 (no user site-packages) and
 * PIP_REQUIRE_VIRTUALENV=true (any pip that somehow runs refuses to touch a global prefix).
 */
export function scrubAgentCondaEnv(env: Readonly<Record<string, string | undefined>>): ScrubResult {
  const overrides: Record<string, string> = {};
  const present: string[] = [];
  for (const key of SCRUBBED_ENV_KEYS) {
    const v = env[key];
    if (v != null && v.length > 0) present.push(key);
    overrides[key] = ""; // neutralize regardless (idempotent; harmless when already unset)
  }
  overrides.PYTHONNOUSERSITE = "1";
  overrides.PIP_REQUIRE_VIRTUALENV = "true";
  return {
    overrides,
    scrubbedKeysPresent: present,
    condaEnvScrubbed: present.length > 0,
  };
}

// -------------------------------------------------------------------------------------------
// Composed agent-shell env builder.
// -------------------------------------------------------------------------------------------

export interface AgentShellEnvInput {
  /** The real PATH the agent would otherwise inherit (process.env.PATH). */
  readonly originalPath: string | null | undefined;
  /** Absolute wrapper bin directory for this run. */
  readonly wrapperBin: string;
  /** The active environment (process.env) used only to detect which leakage vars are present. */
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  /** Absolute path the wrappers append blocked-command JSONL to. */
  readonly blockLogPath: string;
}

export interface AgentShellEnv {
  /** Env OVERRIDES to merge over the agent's inherited env (PATH replaced, leakage scrubbed). */
  readonly overrides: Record<string, string>;
  readonly sanitizedPath: string;
  readonly removedPathEntries: readonly string[];
  readonly pathSanitized: boolean;
  readonly condaEnvScrubbed: boolean;
  readonly scrubbedKeysPresent: readonly string[];
}

/** Compose PATH sanitization + conda/venv scrub + block-log wiring into one override map. */
export function buildAgentShellEnv(input: AgentShellEnvInput): AgentShellEnv {
  const pathResult = sanitizeAgentPath(input.originalPath, input.wrapperBin);
  const scrub = scrubAgentCondaEnv(input.processEnv);
  const overrides: Record<string, string> = {
    ...scrub.overrides,
    PATH: pathResult.sanitizedPath,
    [AGENT_BLOCK_LOG_ENV]: input.blockLogPath,
  };
  // pathSanitized is true only when the wrapper bin leads AND no conda entry survived.
  const pathSanitized = pathResult.wrapperBinFirst && pathResult.sanitizedPath.split(":").slice(1).every((e) => !isCondaPathEntry(e));
  return {
    overrides,
    sanitizedPath: pathResult.sanitizedPath,
    removedPathEntries: pathResult.removedEntries,
    pathSanitized,
    condaEnvScrubbed: scrub.condaEnvScrubbed,
    scrubbedKeysPresent: scrub.scrubbedKeysPresent,
  };
}

// -------------------------------------------------------------------------------------------
// Wrapper script generation (pure string builders).
// -------------------------------------------------------------------------------------------

// Read-only verbs allowed for each tool family. Everything NOT listed is fail-closed (blocked):
// install / uninstall / editable / sync / add / remove / create / update / etc. all fall through.
const PIP_SAFE_VERBS = ["--version", "-V", "list", "show", "freeze", "check", "help", "--help", "inspect", "debug"];
const CONDA_SAFE_VERBS = ["info", "list", "--version", "-V", "help", "--help"];
const PKG_MANAGER_SAFE_VERBS = ["--version", "-V", "version", "help", "--help"];

// The shared bash prologue every wrapper embeds: a `__vt_blocked` function that prints the
// marker + refusal preface + the blocked command, appends a JSONL record to the block log
// (best-effort), and exits with the distinctive block code. Minimal JSON escaping of the
// command string keeps the log machine-parseable without a JSON library.
function blockPrologue(tool: string): string {
  const preface = BLOCKED_MESSAGE_LINES.map((l) => `  >&2 printf '%s\\n' ${shq(l)}`).join("\n");
  return [
    "#!/usr/bin/env bash",
    "# VTRACE Stage 5 M90A agent-shell firewall wrapper — blocks host/base Python mutation.",
    "# Generated per-run; DO NOT edit. See agentShellGuard.ts.",
    "set -uo pipefail",
    `VT_TOOL=${shq(tool)}`,
    "__vt_blocked() {",
    "  local marker=\"$1\"; shift",
    "  >&2 printf '%s\\n' \"$marker\"",
    preface,
    "  >&2 printf 'Blocked command: %s %s\\n' \"$VT_TOOL\" \"$*\"",
    "  if [ -n \"${VTRACE_AGENT_BLOCK_LOG:-}\" ]; then",
    "    local cmd=\"$*\"",
    "    cmd=\"${cmd//\\\\/\\\\\\\\}\"",
    "    cmd=\"${cmd//\\\"/\\\\\\\"}\"",
    "    printf '{\"marker\":\"%s\",\"tool\":\"%s\",\"command\":\"%s\"}\\n' \"$marker\" \"$VT_TOOL\" \"$cmd\" >> \"$VTRACE_AGENT_BLOCK_LOG\" 2>/dev/null || true",
    "  fi",
    `  exit ${AGENT_SHELL_GUARD_BLOCK_EXIT}`,
    "}",
  ].join("\n");
}

// Single-quote a string for safe embedding in bash.
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Build a `case "${1:-}"` allowlist arm that, for safe verbs, runs `delegate`; everything else
// is blocked with `marker`. `delegate` is a full command prefix (e.g. "/abs/python -m pip").
function allowlistCase(safeVerbs: readonly string[], delegate: string | null, marker: string, tool: string): string {
  const pattern = safeVerbs.map((v) => v.replace(/[|]/g, "")).join("|");
  const safeArm = delegate
    ? `exec ${delegate} "$@"`
    : `>&2 printf '%s introspection is not available in the guarded shell.\\n' ${shq(tool)}; exit 0`;
  return [
    'case "${1:-}" in',
    `  ${pattern})`,
    `    ${safeArm} ;;`,
    "  *)",
    `    __vt_blocked ${shq(marker)} "$@" ;;`,
    "esac",
  ].join("\n");
}

export interface WrapperDelegates {
  /** Absolute interpreter the python wrapper delegates harmless (non-pip) invocations to. */
  readonly delegatePython: string;
  /** Absolute conda binary for read-only conda introspection, or null if none found. */
  readonly realConda: string | null;
  /** Absolute uv binary for read-only introspection, or null. */
  readonly realUv: string | null;
  /** Absolute poetry binary for read-only introspection, or null. */
  readonly realPoetry: string | null;
  /** Absolute pipx binary for read-only introspection, or null. */
  readonly realPipx: string | null;
}

// pip / pip3 / pip3.12 — allowlist read-only verbs (delegated to `<python> -m pip`), block rest.
export function pipWrapperScript(name: string, delegates: WrapperDelegates): string {
  const delegate = `${shq(delegates.delegatePython)} -m pip`;
  return `${blockPrologue(name)}\n${allowlistCase(PIP_SAFE_VERBS, delegate, BLOCK_MARKER_PIP, name)}\n`;
}

// python / python3 / python3.12 — block `-m pip` / `-m ensurepip` / get-pip; delegate the rest.
export function pythonWrapperScript(name: string, delegates: WrapperDelegates): string {
  return [
    blockPrologue(name),
    "# Block module-level package installers; delegate all other python invocations.",
    "__vt_prev=\"\"",
    'for __vt_arg in "$@"; do',
    '  if [ "$__vt_prev" = "-m" ]; then',
    '    case "$__vt_arg" in',
    `      pip|pip3|pip3.12|ensurepip|virtualenv) __vt_blocked ${shq(BLOCK_MARKER_PIP)} "$@" ;;`,
    "    esac",
    "  fi",
    '  case "$__vt_arg" in',
    `    -mpip|-mpip3|-mpip3.12|-mensurepip|-mvirtualenv) __vt_blocked ${shq(BLOCK_MARKER_PIP)} "$@" ;;`,
    `    get-pip.py|*/get-pip.py) __vt_blocked ${shq(BLOCK_MARKER_PIP)} "$@" ;;`,
    "  esac",
    '  __vt_prev="$__vt_arg"',
    "done",
    `exec ${shq(delegates.delegatePython)} "$@"`,
    "",
  ].join("\n");
}

// conda — allowlist read-only verbs (delegated to the real conda when found), block mutation.
export function condaWrapperScript(delegates: WrapperDelegates): string {
  const delegate = delegates.realConda ? shq(delegates.realConda) : null;
  return `${blockPrologue("conda")}\n${allowlistCase(CONDA_SAFE_VERBS, delegate, BLOCK_MARKER_CONDA, "conda")}\n`;
}

// uv / poetry / pipx — allowlist read-only verbs (delegated when found), block dependency mutation.
export function packageManagerWrapperScript(name: "uv" | "poetry" | "pipx", real: string | null): string {
  const delegate = real ? shq(real) : null;
  return `${blockPrologue(name)}\n${allowlistCase(PKG_MANAGER_SAFE_VERBS, delegate, BLOCK_MARKER_PKG_MANAGER, name)}\n`;
}

/** Generate every wrapper's (name → script text) for the run. */
export function buildAllWrapperScripts(delegates: WrapperDelegates): Record<AgentWrapperName, string> {
  return {
    pip: pipWrapperScript("pip", delegates),
    pip3: pipWrapperScript("pip3", delegates),
    "pip3.12": pipWrapperScript("pip3.12", delegates),
    python: pythonWrapperScript("python", delegates),
    python3: pythonWrapperScript("python3", delegates),
    "python3.12": pythonWrapperScript("python3.12", delegates),
    conda: condaWrapperScript(delegates),
    uv: packageManagerWrapperScript("uv", delegates.realUv),
    poetry: packageManagerWrapperScript("poetry", delegates.realPoetry),
    pipx: packageManagerWrapperScript("pipx", delegates.realPipx),
  };
}

// -------------------------------------------------------------------------------------------
// PATH-only resolution helper (pure) — pick the first matching executable on a PATH string.
// -------------------------------------------------------------------------------------------

/**
 * Resolve `name` against a PATH string using an injected existence/executable check. Pure given
 * `isExecutable`. Used by the integration layer (with fs.access) to capture delegate binaries.
 */
export function resolveOnPath(name: string, pathString: string | null | undefined, isExecutable: (abs: string) => boolean): string | null {
  for (const dir of (pathString ?? "").split(":")) {
    if (dir.length === 0) continue;
    const abs = `${dir.replace(/\/+$/g, "")}/${name}`;
    if (isExecutable(abs)) return abs;
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// Mandatory live-run gate (PURE / deterministic) — mirrors the M89 env-guard gate.
// -------------------------------------------------------------------------------------------

export type AgentShellGuardStatus = "pass" | "fail" | "not_applicable";

export interface MandatoryAgentShellGuardInput {
  /** True for any path that spawns a live agent / external SWE-bench agent run. */
  readonly isLiveAgentRun: boolean;
  /** The shared escape hatch (--allow-unguarded-live-env). Test/emergency only; never benchmark-valid. */
  readonly allowUnguardedLiveEnv: boolean;
  readonly shellGuardEnabled: boolean;
  readonly hostPipFirewallEnabled: boolean;
  /** Did the wrapper bin materialize (all wrappers written + executable)? null = not attempted. */
  readonly wrapperBinReady: boolean | null;
  readonly pathSanitized: boolean;
  readonly condaEnvScrubbed: boolean;
}

export interface MandatoryAgentShellGuardDecision {
  readonly proceed: boolean;
  readonly failClosed: boolean;
  readonly bypassed: boolean;
  readonly benchmarkValid: boolean;
  readonly required: boolean;
  readonly status: AgentShellGuardStatus;
  readonly reason: string | null;
}

/**
 * Decide whether a live Stage 5 agent run may proceed under the M90A MANDATORY shell guard.
 * Non-live ⇒ not applicable (proceeds). Live ⇒ fails closed unless the guard + firewall are
 * enabled, the wrapper bin materialized, PATH is sanitized, and conda/venv vars are scrubbed.
 * The only unguarded path is the loud --allow-unguarded-live-env escape hatch, which proceeds
 * but is NEVER benchmark-valid. Pure: no I/O, fully unit-tested.
 */
export function evaluateMandatoryAgentShellGuard(input: MandatoryAgentShellGuardInput): MandatoryAgentShellGuardDecision {
  if (!input.isLiveAgentRun) {
    return { proceed: true, failClosed: false, bypassed: false, benchmarkValid: true, required: false, status: "not_applicable", reason: null };
  }
  if (input.allowUnguardedLiveEnv) {
    return {
      proceed: true,
      failClosed: false,
      bypassed: true,
      benchmarkValid: false,
      required: true,
      status: "fail",
      reason: "unguarded live env explicitly allowed via --allow-unguarded-live-env (NOT benchmark-valid)",
    };
  }
  const fail = (reason: string): MandatoryAgentShellGuardDecision => ({
    proceed: false,
    failClosed: true,
    bypassed: false,
    benchmarkValid: false,
    required: true,
    status: "fail",
    reason,
  });
  if (!input.shellGuardEnabled) return fail("live Stage 5 agent runs require the agent shell guard (mandatory since M90A)");
  if (!input.hostPipFirewallEnabled) return fail("live Stage 5 agent runs require the host-pip firewall (mandatory since M90A)");
  if (input.wrapperBinReady !== true) return fail("agent shell guard wrapper bin did not materialize");
  if (!input.pathSanitized) return fail("agent PATH was not sanitized (Conda base still resolvable)");
  if (!input.condaEnvScrubbed) {
    // Note: condaEnvScrubbed is false only when NO leakage var was present to scrub. That is a
    // SAFE state (nothing to leak), so it does not fail closed — but PATH sanitization (above)
    // must still hold. We reach here only with pathSanitized true, so proceed.
  }
  return { proceed: true, failClosed: false, bypassed: false, benchmarkValid: true, required: true, status: "pass", reason: null };
}

// -------------------------------------------------------------------------------------------
// Blocked-command log parsing (pure given the file text).
// -------------------------------------------------------------------------------------------

export interface BlockedCommand {
  readonly marker: string;
  readonly tool: string;
  readonly command: string;
}

/** Parse the wrappers' JSONL block log text into structured records (best-effort, skips junk). */
export function parseBlockedCommandLog(text: string | null | undefined): BlockedCommand[] {
  const out: BlockedCommand[] = [];
  for (const line of (text ?? "").split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      out.push({
        marker: typeof obj.marker === "string" ? obj.marker : "",
        tool: typeof obj.tool === "string" ? obj.tool : "",
        command: typeof obj.command === "string" ? obj.command : "",
      });
    } catch {
      // ignore malformed lines
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Compact metadata builder (for _run.meta.json). No full env dumps.
// -------------------------------------------------------------------------------------------

export interface AgentShellGuardMetadataInput {
  readonly required: boolean;
  readonly enabled: boolean;
  readonly hostPipFirewallEnabled: boolean;
  readonly status: AgentShellGuardStatus;
  readonly wrapperBin: string | null;
  readonly pathSanitized: boolean;
  readonly condaEnvScrubbed: boolean;
  readonly pythonResolution: string | null;
  readonly pipResolution: string | null;
  readonly blockedCommands: readonly BlockedCommand[];
  readonly failureReason: string | null;
}

export interface AgentShellGuardMetadata {
  readonly stage5_agent_shell_guard_required: boolean;
  readonly stage5_agent_shell_guard_enabled: boolean;
  readonly stage5_agent_shell_guard_status: AgentShellGuardStatus;
  readonly stage5_host_pip_firewall_enabled: boolean;
  readonly stage5_agent_wrapper_bin: string | null;
  readonly stage5_agent_path_sanitized: boolean;
  readonly stage5_agent_conda_env_scrubbed: boolean;
  readonly stage5_agent_python_resolution: string | null;
  readonly stage5_agent_pip_resolution: string | null;
  readonly stage5_blocked_host_package_commands: readonly string[];
  readonly stage5_blocked_host_package_command_count: number;
  readonly stage5_agent_shell_guard_failure_reason: string | null;
  readonly stage5_agent_shell_guard_mandatory_since: string;
}

export function buildAgentShellGuardMetadata(input: AgentShellGuardMetadataInput): AgentShellGuardMetadata {
  const blocked = input.blockedCommands.map((b) => `${b.tool} ${b.command}`.trim());
  return {
    stage5_agent_shell_guard_required: input.required,
    stage5_agent_shell_guard_enabled: input.enabled,
    stage5_agent_shell_guard_status: input.status,
    stage5_host_pip_firewall_enabled: input.hostPipFirewallEnabled,
    stage5_agent_wrapper_bin: input.wrapperBin,
    stage5_agent_path_sanitized: input.pathSanitized,
    stage5_agent_conda_env_scrubbed: input.condaEnvScrubbed,
    stage5_agent_python_resolution: input.pythonResolution,
    stage5_agent_pip_resolution: input.pipResolution,
    stage5_blocked_host_package_commands: blocked,
    stage5_blocked_host_package_command_count: blocked.length,
    stage5_agent_shell_guard_failure_reason: input.failureReason,
    stage5_agent_shell_guard_mandatory_since: STAGE5_AGENT_SHELL_GUARD_MANDATORY_SINCE,
  };
}
