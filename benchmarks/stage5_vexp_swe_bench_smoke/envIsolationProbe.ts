// Stage 5 M86 — read-only environment probe (the I/O half of the isolation guard).
//
// Everything here is STRICTLY READ-ONLY: it runs `python -c …`, `python -m pip -V`,
// `python -m pip show …` and (when available) `conda list …`. It NEVER runs `pip install`,
// `pip uninstall`, `conda install`, or `conda remove`. The contamination this milestone
// defends against came from a dependency install hitting the wrong prefix; this helper only
// observes state and hands compact, already-parsed data to the PURE guard in
// `envIsolationGuard.ts`. Output is deliberately small — no full `conda list`, no env dump.

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import {
  TRACKED_PACKAGES,
  parsePipPrefixFromVersionLine,
  normalizePrefix,
  type PythonProbe,
  type PackageRecord,
  type ProtectedPrefixRole,
} from "./envIsolationGuard";

function tryExec(file: string, args: string[], timeoutMs = 10_000): string | null {
  try {
    return execFileSync(file, args, { timeout: timeoutMs, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

// A tiny Python program that prints the prefix probe as a single JSON line. Read-only.
const PROBE_SCRIPT = [
  "import sys, json, os",
  "print(json.dumps({",
  "  'executable': sys.executable,",
  "  'prefix': sys.prefix,",
  "  'basePrefix': getattr(sys, 'base_prefix', sys.prefix),",
  "  'condaPrefix': os.environ.get('CONDA_PREFIX'),",
  "}))",
].join("\n");

/** Probe a Python interpreter's prefix identity (sys.prefix/executable/pip -V/CONDA_PREFIX). */
export function probePython(pythonCommand: string): PythonProbe | null {
  const out = tryExec(pythonCommand, ["-c", PROBE_SCRIPT]);
  if (!out) return null;
  let parsed: { executable: string; prefix: string; basePrefix: string; condaPrefix: string | null };
  try {
    parsed = JSON.parse(out.trim().split("\n").pop() ?? "{}");
  } catch {
    return null;
  }
  const pipV = tryExec(pythonCommand, ["-m", "pip", "-V"]);
  return {
    executable: parsed.executable ?? "",
    prefix: parsed.prefix ?? "",
    basePrefix: parsed.basePrefix ?? "",
    pipVersionLine: pipV ? pipV.trim().split("\n")[0] : null,
    condaPrefix: parsed.condaPrefix ?? null,
  };
}

// Per-package import probe — version, file, and mtime (ms). Read-only, one JSON line.
const PKG_PROBE_SCRIPT = (pkg: string) =>
  [
    "import json",
    "d = {'package': %PKG%, 'importedVersion': None, 'importedFile': None, 'importedMtimeMs': None}",
    "try:",
    "    import importlib, os",
    "    m = importlib.import_module(%PKG%)",
    "    d['importedVersion'] = getattr(m, '__version__', None)",
    "    f = getattr(m, '__file__', None)",
    "    d['importedFile'] = f",
    "    if f and os.path.exists(f):",
    "        d['importedMtimeMs'] = int(os.path.getmtime(f) * 1000)",
    "except Exception as e:",
    "    d['importedVersion'] = None",
    "print(json.dumps(d))",
  ]
    .join("\n")
    .replace(/%PKG%/g, JSON.stringify(pkg));

function pipShowVersion(pythonCommand: string, pkg: string): string | null {
  const out = tryExec(pythonCommand, ["-m", "pip", "show", pkg]);
  if (!out) return null;
  const m = out.match(/^Version:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

// `conda list <pkg>` parse (best-effort; conda may be absent). Read-only.
function condaListVersion(prefix: string, pkg: string): string | null {
  const out = tryExec("conda", ["list", "-p", prefix, pkg]);
  if (!out) return null;
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const cols = trimmed.split(/\s+/);
    if (cols[0] === pkg && cols[1]) return cols[1];
  }
  return null;
}

/** Snapshot the tracked-package state of a prefix using a given interpreter. Read-only. */
export function probePackageRecords(
  pythonCommand: string,
  prefix: string,
  packages: readonly string[] = TRACKED_PACKAGES,
): PackageRecord[] {
  const records: PackageRecord[] = [];
  for (const pkg of packages) {
    let importedVersion: string | null = null;
    let importedFile: string | null = null;
    let importedMtimeMs: number | null = null;
    const out = tryExec(pythonCommand, ["-c", PKG_PROBE_SCRIPT(pkg)]);
    if (out) {
      try {
        const d = JSON.parse(out.trim().split("\n").pop() ?? "{}");
        importedVersion = d.importedVersion ?? null;
        importedFile = d.importedFile ?? null;
        importedMtimeMs = d.importedMtimeMs ?? null;
      } catch {
        /* ignore */
      }
    }
    records.push({
      prefix: normalizePrefix(prefix),
      pythonExecutable: pythonCommand,
      package: pkg,
      condaVersion: condaListVersion(prefix, pkg),
      pipVersion: pipShowVersion(pythonCommand, pkg),
      importedVersion,
      importedFile,
      importedMtimeMs,
    });
  }
  return records;
}

export interface CandidatePrefix {
  readonly role: ProtectedPrefixRole;
  readonly prefix: string;
  /** Path to the interpreter to use for this prefix (defaults to `<prefix>/bin/python`). */
  readonly pythonCommand?: string;
}

function interpreterFor(c: CandidatePrefix): string {
  if (c.pythonCommand) return c.pythonCommand;
  const win = `${c.prefix}/Scripts/python.exe`;
  const nix = `${c.prefix}/bin/python`;
  if (existsSync(nix)) return nix;
  if (existsSync(win)) return win;
  return nix;
}

export interface EnvAuditPrefixEntry {
  readonly role: ProtectedPrefixRole;
  readonly prefix: string;
  readonly exists: boolean;
  readonly probe: PythonProbe | null;
  readonly pipPrefix: string | null;
  readonly packages: PackageRecord[];
}

export interface EnvAuditResult {
  readonly shellCondaPrefix: string | null;
  readonly shellVirtualEnv: string | null;
  readonly prefixes: EnvAuditPrefixEntry[];
}

/**
 * Compact read-only audit of the candidate prefixes. Returns small, structured data
 * suitable for `stage5_m86_env_audit.json`. Never installs or mutates anything.
 */
export function runEnvAudit(candidates: readonly CandidatePrefix[]): EnvAuditResult {
  const prefixes: EnvAuditPrefixEntry[] = [];
  for (const c of candidates) {
    const py = interpreterFor(c);
    const exists = existsSync(py);
    const probe = exists ? probePython(py) : null;
    prefixes.push({
      role: c.role,
      prefix: normalizePrefix(c.prefix),
      exists,
      probe,
      pipPrefix: probe ? parsePipPrefixFromVersionLine(probe.pipVersionLine) : null,
      packages: exists ? probePackageRecords(py, c.prefix) : [],
    });
  }
  return {
    shellCondaPrefix: process.env.CONDA_PREFIX ? normalizePrefix(process.env.CONDA_PREFIX) : null,
    shellVirtualEnv: process.env.VIRTUAL_ENV ? normalizePrefix(process.env.VIRTUAL_ENV) : null,
    prefixes,
  };
}

/** mtime helper (ms) for an arbitrary file — read-only, used by ad-hoc snapshots. */
export function fileMtimeMs(path: string): number | null {
  try {
    return existsSync(path) ? Math.round(statSync(path).mtimeMs) : null;
  } catch {
    return null;
  }
}
