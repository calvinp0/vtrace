// Stage 5 M90A — no-agent agent-shell-guard smoke.
//
// Proves the host-pip firewall blocks host/base Python mutation BEFORE any mutation, while a
// dangerous cwd is active — WITHOUT spawning a real agent, running real pip, or mutating Conda.
// It materializes the per-run wrapper bin (the exact artifact a live run builds), then runs the
// dangerous + harmless commands through the guarded shell with cwd set to the pytest checkout
// that previously contaminated base. Every dangerous command is blocked by the wrapper before
// the underlying tool runs, so nothing is installed and no prefix changes.
//
// Usage:
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m90a_agent_shell_guard_smoke.ts \
//     [--danger-cwd <dir>] [--json <out.json>]
//
// Exit code 0 ⇒ PASS (all dangerous commands blocked, harmless commands work, wrapper resolves).

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeAgentShellGuard, readBlockedCommandLog } from "./stage5AgentShellGuardIntegration";
import { AGENT_SHELL_GUARD_BLOCK_EXIT } from "./agentShellGuard";

const DEFAULT_DANGER_CWD = "/home/calvin/code/vexp-swe-bench/.bench-repos/pytest-dev__pytest";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const dangerCwdRaw = arg("--danger-cwd") ?? DEFAULT_DANGER_CWD;
const jsonOut = arg("--json");
// If the canonical danger cwd is absent (clean checkout), fall back to a temp dir — the firewall
// blocks before exec regardless of cwd, so the proof does not depend on the checkout existing.
const dangerCwd = existsSync(dangerCwdRaw) ? dangerCwdRaw : mkdtempSync(path.join(os.tmpdir(), "m90a-cwd-"));

const runDir = mkdtempSync(path.join(os.tmpdir(), "m90a-smoke-"));
const guard = materializeAgentShellGuard({ runDir, expectedTestbedPrefix: process.env.VTRACE_STAGE5_EXPECTED_TESTBED_PREFIX ?? null });
const env = { ...process.env, ...guard.shellEnv.overrides } as Record<string, string>;

const run = (cmd: string) => {
  const p = spawnSync("bash", ["-lc", cmd], { cwd: dangerCwd, env, encoding: "utf8" });
  return { code: p.status, out: `${p.stdout ?? ""}${p.stderr ?? ""}` };
};

const DANGEROUS: Array<{ cmd: string; marker: RegExp }> = [
  { cmd: "pip install -e .", marker: /VTRACE_HOST_PIP_BLOCKED/ },
  { cmd: "python -m pip install -e .", marker: /VTRACE_HOST_PIP_BLOCKED/ },
  { cmd: "python3 -m pip install -e .", marker: /VTRACE_HOST_PIP_BLOCKED/ },
  { cmd: "conda install pluggy=0.13.1", marker: /VTRACE_HOST_CONDA_BLOCKED/ },
  { cmd: "uv pip install -e .", marker: /VTRACE_HOST_PACKAGE_MANAGER_BLOCKED/ },
  { cmd: "poetry add pluggy", marker: /VTRACE_HOST_PACKAGE_MANAGER_BLOCKED/ },
  { cmd: "pipx install pytest", marker: /VTRACE_HOST_PACKAGE_MANAGER_BLOCKED/ },
];

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

for (const d of DANGEROUS) {
  const r = run(d.cmd);
  const ok = r.code === AGENT_SHELL_GUARD_BLOCK_EXIT && d.marker.test(r.out);
  checks.push({ name: `blocked: ${d.cmd}`, ok, detail: `exit=${r.code}` });
}

// Harmless commands must still work, and the wrapper must shadow host/base pip.
const whichPip = run("which pip");
const expectedPip = path.join(guard.wrapperBin, "pip");
checks.push({
  name: "which pip → VTRACE wrapper (not /home/calvin/miniforge3/bin/pip)",
  ok: whichPip.out.trim() === expectedPip,
  detail: whichPip.out.trim(),
});
const whichPython = run("which python");
checks.push({
  name: "which python → VTRACE wrapper",
  ok: whichPython.out.trim() === path.join(guard.wrapperBin, "python"),
  detail: whichPython.out.trim(),
});
const hello = run("python - <<'PY'\nprint('hello')\nPY");
checks.push({ name: "harmless python heredoc runs", ok: hello.code === 0 && /hello/.test(hello.out), detail: `exit=${hello.code}` });

const blockedLog = readBlockedCommandLog(guard.blockLogPath);
const pass = checks.every((c) => c.ok);

const summary = {
  status: pass ? "pass" : "fail",
  dangerCwd,
  usedRealDangerCwd: existsSync(dangerCwdRaw),
  wrapperBin: guard.wrapperBin,
  pythonResolution: guard.pythonResolution,
  pipResolution: guard.pipResolution,
  pathSanitized: guard.shellEnv.pathSanitized,
  condaEnvScrubbed: guard.shellEnv.condaEnvScrubbed,
  removedPathEntries: guard.shellEnv.removedPathEntries,
  blockedCommandCount: blockedLog.length,
  blockedCommands: blockedLog.map((b) => `${b.marker} ${b.tool} ${b.command}`),
  checks,
};

process.stdout.write(`\n[M90A smoke] ${summary.status.toUpperCase()} (cwd=${dangerCwd})\n`);
for (const c of checks) process.stdout.write(`  ${c.ok ? "✓" : "✗"} ${c.name}  [${c.detail}]\n`);
process.stdout.write(`  wrapper bin: ${guard.wrapperBin}\n  blocked recorded: ${blockedLog.length}\n`);

if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`  wrote ${jsonOut}\n`);
}

process.exit(pass ? 0 : 1);
