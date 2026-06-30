// Stage 5 M90A — effectful glue for the agent-shell guard / host-pip firewall.
//
// The pure core (agentShellGuard.ts) produces wrapper SCRIPT TEXT, the sanitized PATH, the
// scrubbed env overrides, the mandatory-gate decision, and the metadata. This module is the
// thin effectful layer the runner calls: it RESOLVES the delegate interpreters from the real
// PATH (read-only), WRITES the per-run wrapper bin (executable scripts), and READS back the
// wrappers' blocked-command log after the run. All filesystem access is injectable so tests
// exercise it against a temp dir and never touch a real conda/pip install.
//
// It changes NO retrieval / scoring / ranking / Capsule v2 / V4 / C7_D behavior — safety only.

import { existsSync, accessSync, constants as fsConstants, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  buildAgentShellEnv,
  buildAllWrapperScripts,
  resolveOnPath,
  parseBlockedCommandLog,
  AGENT_WRAPPER_NAMES,
  type AgentShellEnv,
  type WrapperDelegates,
  type BlockedCommand,
} from "./agentShellGuard";

// The wrapper-bin directory name created under each run's raw/<condition> dir.
export const AGENT_WRAPPER_BIN_DIRNAME = "_vtrace_agent_bin";
// The wrappers' JSONL block log, written next to the wrapper bin.
export const AGENT_BLOCK_LOG_FILENAME = "_blocked_host_package_commands.jsonl";

export interface MaterializeAgentShellGuardOptions {
  /** The run's raw/<condition> directory (the wrapper bin + block log live under it). */
  readonly runDir: string;
  /** The real PATH the agent would otherwise inherit (defaults to process.env.PATH). */
  readonly originalPath?: string | null;
  /** The active env, used only to detect which leakage vars are present (defaults to process.env). */
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
  /** Expected disposable testbed prefix; its bin/python is the preferred delegate interpreter. */
  readonly expectedTestbedPrefix?: string | null;
  // ---- injectables for tests (default to real fs) ----
  readonly mkdir?: (dir: string) => void;
  readonly writeWrapper?: (file: string, content: string) => void;
  readonly isExecutable?: (abs: string) => boolean;
  readonly exists?: (abs: string) => boolean;
}

export interface MaterializeAgentShellGuardResult {
  readonly wrapperBin: string;
  readonly blockLogPath: string;
  readonly wrapperBinReady: boolean;
  readonly shellEnv: AgentShellEnv;
  readonly delegates: WrapperDelegates;
  /** Human-readable python resolution (the delegate interpreter), for metadata. */
  readonly pythonResolution: string;
  /** Human-readable pip resolution (wrapper → delegated read-only), for metadata. */
  readonly pipResolution: string;
  readonly failureReason: string | null;
}

/**
 * Resolve the delegate interpreters the wrappers fall back to for HARMLESS invocations.
 * - delegatePython: the expected testbed `bin/python` when present (never base), else the first
 *   non-conda python3/python on PATH, else a bare "python3" literal (harmless exec only; the
 *   wrappers block every `-m pip`/`-m ensurepip` form regardless of which interpreter this is).
 * - realConda/uv/poetry/pipx: the on-PATH binary for READ-ONLY introspection delegation (null
 *   when absent ⇒ the wrapper reports "introspection unavailable" instead of delegating).
 */
export function resolveWrapperDelegates(opts: {
  readonly originalPath: string | null | undefined;
  readonly expectedTestbedPrefix?: string | null;
  readonly isExecutable: (abs: string) => boolean;
  readonly exists: (abs: string) => boolean;
}): WrapperDelegates {
  let delegatePython: string | null = null;
  const expected = (opts.expectedTestbedPrefix ?? "").trim();
  if (expected) {
    for (const candidate of [`${expected}/bin/python`, `${expected}/bin/python3`]) {
      if (opts.exists(candidate)) {
        delegatePython = candidate;
        break;
      }
    }
  }
  if (!delegatePython) {
    delegatePython =
      resolveOnPath("python3", opts.originalPath, opts.isExecutable) ??
      resolveOnPath("python", opts.originalPath, opts.isExecutable) ??
      "python3";
  }
  return {
    delegatePython,
    realConda: resolveOnPath("conda", opts.originalPath, opts.isExecutable),
    realUv: resolveOnPath("uv", opts.originalPath, opts.isExecutable),
    realPoetry: resolveOnPath("poetry", opts.originalPath, opts.isExecutable),
    realPipx: resolveOnPath("pipx", opts.originalPath, opts.isExecutable),
  };
}

/**
 * Materialize the per-run agent-shell guard: write the wrapper bin (executable firewall
 * scripts), wire the block log, and build the sanitized agent env overrides. Returns
 * everything the runner needs to gate (wrapperBinReady, pathSanitized, condaEnvScrubbed) and
 * to record metadata. Best-effort but fail-honest: if any wrapper cannot be written/made
 * executable, wrapperBinReady is false and the caller fails closed.
 */
export function materializeAgentShellGuard(opts: MaterializeAgentShellGuardOptions): MaterializeAgentShellGuardResult {
  const originalPath = opts.originalPath !== undefined ? opts.originalPath : process.env.PATH ?? "";
  const processEnv = opts.processEnv ?? process.env;
  const mkdir = opts.mkdir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
  const writeWrapper =
    opts.writeWrapper ??
    ((file: string, content: string) => {
      writeFileSync(file, content, "utf8");
      chmodSync(file, 0o755);
    });
  const isExecutable = opts.isExecutable ?? defaultIsExecutable;
  const exists = opts.exists ?? ((p: string) => existsSync(p));

  const wrapperBin = path.join(opts.runDir, AGENT_WRAPPER_BIN_DIRNAME);
  const blockLogPath = path.join(wrapperBin, AGENT_BLOCK_LOG_FILENAME);

  const delegates = resolveWrapperDelegates({
    originalPath,
    expectedTestbedPrefix: opts.expectedTestbedPrefix,
    isExecutable,
    exists,
  });
  const shellEnv = buildAgentShellEnv({ originalPath, wrapperBin, processEnv, blockLogPath });
  const scripts = buildAllWrapperScripts(delegates);

  let wrapperBinReady = true;
  let failureReason: string | null = null;
  try {
    mkdir(wrapperBin);
    for (const name of AGENT_WRAPPER_NAMES) {
      writeWrapper(path.join(wrapperBin, name), scripts[name]);
    }
    // Verify every wrapper landed and is executable.
    for (const name of AGENT_WRAPPER_NAMES) {
      if (!isExecutable(path.join(wrapperBin, name))) {
        wrapperBinReady = false;
        failureReason = `wrapper ${name} is not executable after write`;
        break;
      }
    }
  } catch (err) {
    wrapperBinReady = false;
    failureReason = `failed to materialize wrapper bin: ${(err as Error).message}`;
  }

  return {
    wrapperBin,
    blockLogPath,
    wrapperBinReady,
    shellEnv,
    delegates,
    pythonResolution: `wrapper:${wrapperBin}/python → delegate ${delegates.delegatePython}`,
    pipResolution: `wrapper:${wrapperBin}/pip → BLOCK (read-only delegated to ${delegates.delegatePython} -m pip)`,
    failureReason,
  };
}

/** Read + parse the wrappers' blocked-command log (best-effort; empty when absent). */
export function readBlockedCommandLog(blockLogPath: string, readFile?: (p: string) => string | null): BlockedCommand[] {
  const read =
    readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
  return parseBlockedCommandLog(read(blockLogPath));
}

function defaultIsExecutable(abs: string): boolean {
  try {
    accessSync(abs, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
